'use strict';

// Feature 081 A.5 (IC-013, DEC-021): the worker run store.
//
// One file per feature, `.doflow/state/worker-runs/<slug>.json` under the lifecycle project root,
// shaped `{ slug, runs: { <runId>: RunRecord } }` (RunRecord fields: design/data-model.md §1).
// Every write is a locked read-decide-write through `updateTaskState`, which stamps `version` and
// `revision` and owns the only fs write calls (G26 (b), RK3): this module makes none.
//
// Two writes exist. `insertRun` adds a run unless one already holds the same `(task, token)`
// (FR-019), checked inside the lock so two racing inserts yield one run. `transition` is the
// compare-and-set every later write goes through: inside the lock it re-reads the run, refuses
// with no write when its `phase` is not in `allowedPhases`, applies the change and increments the
// run's `seq`. A refusal is a returned value, never a throw; a torn or future-version file is a
// thrown `store-unreadable` (exit 2), as in 080. The callbacks run inside the lock, so they must be
// pure over the parsed record: no probe, git call, spawn, signal or wait (IC-013).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { updateTaskState, readTaskState } = require('../task-state.ts');
const { isSafeSlug } = require('../task-scope.ts');

const PHASES = Object.freeze(['starting', 'running', 'cancelling', 'ended']);
const RUN_ID = /^w-[0-9a-f]{12}$/;

/** A failure that is the caller's or the environment's, not a refusal: exit 2. */
class RunStoreError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunStoreError';
    this.code = code;
  }
}

/** Thrown inside the locked build to abandon a write without touching the store. */
class NoWrite extends Error {}

function storeFileFor(root: string, slug: string): string {
  if (!isSafeSlug(slug)) throw new RunStoreError('usage', `'${slug}' is not a valid feature slug`);
  return path.join(root, '.doflow', 'state', 'worker-runs', `${slug}.json`);
}

/** `w-` plus 12 lowercase hex characters from 6 random bytes. */
function newRunId(): string {
  return `w-${crypto.randomBytes(6).toString('hex')}`;
}

function unreadable(file: string, why: string): RunStoreError {
  return new RunStoreError('store-unreadable', `Worker run store '${file}' cannot be read: ${why}`);
}

function slugOf(file: string): string {
  return path.basename(file, '.json');
}

/** The parsed store, or an empty one when the file does not exist yet. */
function normalizeStore(data: any, file: string): any {
  if (data === null) return { slug: slugOf(file), runs: {} };
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unreadable(file, 'it is not a JSON object.');
  if (!data.runs || typeof data.runs !== 'object' || Array.isArray(data.runs)) throw unreadable(file, "its 'runs' is not an object.");
  for (const [runId, run] of Object.entries(data.runs) as [string, any][]) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw unreadable(file, `run '${runId}' is not an object.`);
    if (!PHASES.includes(run.phase)) throw unreadable(file, `run '${runId}' has phase '${run.phase}', not one of ${PHASES.join(', ')}.`);
    if (!Number.isInteger(run.seq) || run.seq < 0) throw unreadable(file, `run '${runId}' has seq '${run.seq}', not a non-negative integer.`);
  }
  const { version, revision, ...rest } = data;
  return rest;
}

function rethrow(error: any, file: string): never {
  if (error instanceof RunStoreError) throw error;
  if (error && error.code === 'store-unreadable') throw unreadable(file, error.message);
  throw error;
}

/** Every run in the store, keyed by run id; `{}` when the file does not exist. Takes no lock. */
function readRuns(file: string, fsImpl: any = fs): Record<string, any> {
  try {
    return normalizeStore(readTaskState(fsImpl, file), file).runs;
  } catch (error: any) {
    return rethrow(error, file);
  }
}

/** One locked read-decide-write. `decide(store)` returns `{ result, write }`; with `write` false
 * nothing is written, so a refusal leaves the file's bytes as they were. */
function mutate(file: string, fsImpl: any, decide: (store: any) => { result: any; write: boolean }): any {
  let outcome: any = null;
  try {
    updateTaskState({
      fsImpl,
      file,
      build: (disk: any) => {
        const store = normalizeStore(disk, file);
        outcome = decide(store);
        if (!outcome.write) throw new NoWrite();
        return store;
      },
    });
  } catch (error: any) {
    if (error instanceof NoWrite) return outcome.result;
    rethrow(error, file);
  }
  return outcome.result;
}

/**
 * Inserts a run with `seq: 0`. Refused, with no write, when any run in the store, live or ended,
 * has the same `task` and `token`: `{ applied: false, reason: 'run-exists', runId, phase }`.
 * @returns {{ applied: true, run: Object } | { applied: false, reason: 'run-exists', runId: string, phase: string }}
 */
function insertRun(file: string, record: any, fsImpl: any = fs): any {
  if (!record || typeof record !== 'object') throw new RunStoreError('usage', 'a run record must be an object');
  if (typeof record.runId !== 'string' || !RUN_ID.test(record.runId)) throw new RunStoreError('usage', `run id '${record.runId}' is not 'w-' plus 12 hex characters`);
  if (typeof record.task !== 'string' || record.task === '') throw new RunStoreError('usage', 'a run record needs a task');
  if (!Number.isInteger(record.token) || record.token < 1) throw new RunStoreError('usage', `token '${record.token}' is not a positive integer`);
  if (!PHASES.includes(record.phase)) throw new RunStoreError('usage', `phase '${record.phase}' is not one of ${PHASES.join(', ')}`);
  return mutate(file, fsImpl, (store) => {
    const existing = Object.values(store.runs).find((run: any) => run.task === record.task && run.token === record.token) as any;
    if (existing) return { write: false, result: { applied: false, reason: 'run-exists', runId: existing.runId, phase: existing.phase } };
    if (store.runs[record.runId]) return { write: false, result: { applied: false, reason: 'run-exists', runId: record.runId, phase: store.runs[record.runId].phase } };
    const run = { ...structuredClone(record), seq: 0 };
    store.runs[run.runId] = run;
    return { write: true, result: { applied: true, run: structuredClone(run) } };
  });
}

/**
 * The compare-and-set every later write goes through. Inside the lock: re-read the run; refuse with
 * no write when it is absent (`unknown-run`) or its `phase` is not in `allowedPhases`
 * (`phase-not-allowed`, carrying the current record); otherwise `apply(copy)` changes the copy, in
 * place or by returning a replacement, and the run is written with `seq` one higher. `apply` must
 * be pure over the record: it runs under the lock.
 * @returns {{ applied: true, run: Object } | { applied: false, reason: string, runId: string, phase?: string, run?: Object }}
 */
function transition(file: string, runId: string, allowedPhases: string[], apply: (run: any) => any, fsImpl: any = fs): any {
  if (!Array.isArray(allowedPhases) || allowedPhases.length === 0 || allowedPhases.some((p) => !PHASES.includes(p))) {
    throw new RunStoreError('usage', `allowed phases must be a non-empty list of ${PHASES.join(', ')}`);
  }
  return mutate(file, fsImpl, (store) => {
    const current = store.runs[runId];
    if (!current) return { write: false, result: { applied: false, reason: 'unknown-run', runId } };
    if (!allowedPhases.includes(current.phase)) {
      return { write: false, result: { applied: false, reason: 'phase-not-allowed', runId, phase: current.phase, run: structuredClone(current) } };
    }
    const draft = structuredClone(current);
    const returned = apply(draft);
    const next = returned && typeof returned === 'object' ? returned : draft;
    if (!PHASES.includes(next.phase)) throw new RunStoreError('usage', `transition set phase '${next.phase}', not one of ${PHASES.join(', ')}`);
    const run = { ...next, runId: current.runId, task: current.task, token: current.token, seq: current.seq + 1 };
    store.runs[runId] = run;
    return { write: true, result: { applied: true, run: structuredClone(run) } };
  });
}

module.exports = { storeFileFor, newRunId, insertRun, transition, readRuns, RunStoreError, PHASES, RUN_ID };
