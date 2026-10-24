'use strict';

// Feature 082 A.4 (IC-006, IC-009 phase table, IC-036; DEC-018, DEC-037, DEC-045): the dispatch store.
//
// One file per feature, `.doflow/state/dispatch/<slug>.json` under the lifecycle project root,
// shaped `{ slug, run, dispatches: { <d-id>: Dispatch }, drivers, lease, spawnRequests, steps }`
// (fields: design/data-model.md §1). Every write is a locked read-decide-write through
// `updateTaskState`, which stamps `version` and `revision` and owns the only fs write calls (G26 (b),
// IC-037): this module makes none.
//
// Two writes exist. `mutateDispatch` runs `decide(store)` inside the lock; `write: false` leaves the
// file untouched. `transitionDispatch` is the per-dispatch compare-and-set: it refuses with no write
// when the dispatch's `phase` is not in `allowedPhases`, otherwise applies and increments `seq`.
// Both enforce, on the state they are about to write, the rules that make a phase name what exists
// (DEC-045): a new dispatch starts `admitted`, only an `admitted` slot may be dropped, a phase moves
// only along IC-009's table, `(task, token)` is unique, and an `ended` dispatch is add-only (only
// `cleanup`, `removal` and `usageLate` may be set while absent, and `removal.verified` may move from
// false to true, IC-021). The step log keeps the newest STEP_LIMIT records.
//
// A refusal is a returned value, never a throw; a torn or future-version file is a thrown
// `store-unreadable` (exit 2), as in 080 and 081. The callbacks run inside the lock, so they do no
// I/O but the in-process 080 calls IC-006 lists: no git call, spawn, signal or wait.
//
// Feature 106 A.2 (IC-004): `fallbackOf` and `appendFallbackEvent` keep a run's `fallback` state,
// pure helpers a locked write's callback calls on the store it holds.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { updateTaskState, readTaskState } = require('../task-state.ts');
const { isSafeSlug } = require('../task-scope.ts');

/** IC-009's six dispatch phases, in order. */
const PHASES = Object.freeze(['admitted', 'claimed', 'launched', 'collected', 'integrating', 'ended']);
/** The phases each phase may move to in one write, itself included (IC-009, data-model "Dispatch phases"). */
const NEXT_PHASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  admitted: Object.freeze(['admitted', 'claimed']),
  claimed: Object.freeze(['claimed', 'launched', 'ended']),
  launched: Object.freeze(['launched', 'collected', 'ended']),
  collected: Object.freeze(['collected', 'integrating', 'ended']),
  integrating: Object.freeze(['integrating', 'collected', 'ended']),
  ended: Object.freeze(['ended']),
});
/** Fields an ended dispatch accepts while absent (IC-006). */
const ADD_ONLY_FIELDS = Object.freeze(['cleanup', 'removal', 'usageLate']);
const STEP_LIMIT = 500;
const DISPATCH_RUN_ID = /^p-[0-9a-f]{12}$/;
const DISPATCH_ID = /^d-[0-9a-f]{12}$/;
/** 106 IC-004: the newest fallback events a run keeps. */
const FALLBACK_EVENTS_MAX = 200;

/** A failure that is the caller's or the environment's, not a refusal: exit 2. */
class DispatchStoreError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DispatchStoreError';
    this.code = code;
  }
}

function storeFileFor(root: string, slug: string): string {
  if (!isSafeSlug(slug)) throw new DispatchStoreError('usage', `'${slug}' is not a valid feature slug`);
  return path.join(root, '.doflow', 'state', 'dispatch', `${slug}.json`);
}

/** `p-` plus 12 lowercase hex characters from 6 random bytes (DEC-037). */
function newDispatchRunId(): string {
  return `p-${crypto.randomBytes(6).toString('hex')}`;
}

/** `d-` plus 12 lowercase hex characters from 6 random bytes (DEC-037). */
function newDispatchId(): string {
  return `d-${crypto.randomBytes(6).toString('hex')}`;
}

function unreadable(file: string, why: string): DispatchStoreError {
  return new DispatchStoreError('store-unreadable', `Dispatch store '${file}' cannot be read: ${why}`);
}

function usage(message: string): DispatchStoreError {
  return new DispatchStoreError('usage', message);
}

function isObject(value: any): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The parsed store without `version` and `revision`, or an empty one when the file does not exist. */
function normalizeStore(data: any, file: string): any {
  const empty = { slug: path.basename(file, '.json'), run: null, dispatches: {}, drivers: [], lease: null, spawnRequests: {}, steps: [] };
  if (data === null) return empty;
  if (!isObject(data)) throw unreadable(file, 'it is not a JSON object.');
  const { version, revision, ...rest } = data;
  const store = { ...empty, ...rest };
  if (store.run !== null && !isObject(store.run)) throw unreadable(file, "its 'run' is not an object or null.");
  if (store.lease !== null && !isObject(store.lease)) throw unreadable(file, "its 'lease' is not an object or null.");
  if (!isObject(store.dispatches)) throw unreadable(file, "its 'dispatches' is not an object.");
  if (!isObject(store.spawnRequests)) throw unreadable(file, "its 'spawnRequests' is not an object.");
  if (!Array.isArray(store.drivers)) throw unreadable(file, "its 'drivers' is not a list.");
  if (!Array.isArray(store.steps)) throw unreadable(file, "its 'steps' is not a list.");
  for (const [id, dispatch] of Object.entries(store.dispatches) as [string, any][]) {
    if (!isObject(dispatch)) throw unreadable(file, `dispatch '${id}' is not an object.`);
    if (!PHASES.includes(dispatch.phase)) throw unreadable(file, `dispatch '${id}' has phase '${dispatch.phase}', not one of ${PHASES.join(', ')}.`);
    if (!Number.isInteger(dispatch.seq) || dispatch.seq < 0) throw unreadable(file, `dispatch '${id}' has seq '${dispatch.seq}', not a non-negative integer.`);
  }
  return store;
}

function rethrow(error: any, file: string): never {
  if (error instanceof DispatchStoreError) throw error;
  if (error && error.code === 'store-unreadable') throw unreadable(file, error.message);
  throw error;
}

/** The first field an ended dispatch's write changes against IC-006's add-only rule, or null. */
function endedViolation(before: any, after: any): string | null {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'seq' || isDeepStrictEqual(before[key], after[key])) continue;
    if (ADD_ONLY_FIELDS.includes(key) && before[key] == null && after[key] != null) continue;
    if (key === 'removal' && isObject(before.removal) && before.removal.verified === false
      && isObject(after.removal) && after.removal.verified === true) continue;
    return key;
  }
  return null;
}

/**
 * Checks the store about to be written against the one read. Returns `{ field, dispatchId }` for an
 * ended dispatch's add-only violation; throws `usage` for every other broken rule, a caller defect.
 */
function checkWrite(before: any, after: any): { dispatchId: string; field: string } | null {
  if (!isObject(after) || !isObject(after.dispatches)) throw usage("a dispatch store write needs a 'dispatches' object");
  if (!Array.isArray(after.steps)) throw usage("a dispatch store write needs a 'steps' list");
  for (const [id, old] of Object.entries(before.dispatches) as [string, any][]) {
    if (!(id in after.dispatches) && old.phase !== 'admitted') throw usage(`dispatch '${id}' is '${old.phase}'; only an admitted slot may be dropped`);
  }
  const identities = new Map();
  for (const [id, next] of Object.entries(after.dispatches) as [string, any][]) {
    if (!DISPATCH_ID.test(id)) throw usage(`dispatch id '${id}' is not 'd-' plus 12 hex characters`);
    if (!isObject(next) || next.dispatchId !== id) throw usage(`dispatch '${id}' must be an object whose dispatchId is '${id}'`);
    if (!PHASES.includes(next.phase)) throw usage(`dispatch '${id}' has phase '${next.phase}', not one of ${PHASES.join(', ')}`);
    const old = before.dispatches[id];
    if (!old && next.phase !== 'admitted') throw usage(`new dispatch '${id}' must be admitted, not '${next.phase}'`);
    if (old && !NEXT_PHASES[old.phase].includes(next.phase)) throw usage(`dispatch '${id}' cannot move from '${old.phase}' to '${next.phase}'`);
    if (old && next.task !== old.task) throw usage(`dispatch '${id}' cannot change its task`);
    if (next.token !== undefined && next.token !== null) {
      const identity = `${next.task}\u0000${next.token}`;
      if (identities.has(identity)) throw usage(`dispatches '${identities.get(identity)}' and '${id}' share task '${next.task}' token ${next.token}`);
      identities.set(identity, id);
    }
    if (old && old.phase === 'ended') {
      const field = endedViolation(old, next);
      if (field) return { dispatchId: id, field };
    }
  }
  return null;
}

/** Every dispatch's `seq`: 0 when new, one higher when changed or forced, else as stored. */
function stampSeq(before: any, after: any, forced: string | null): void {
  for (const [id, next] of Object.entries(after.dispatches) as [string, any][]) {
    const old = before.dispatches[id];
    if (!old) { next.seq = 0; continue; }
    const changed = id === forced || !isDeepStrictEqual({ ...old, seq: 0 }, { ...next, seq: 0 });
    next.seq = changed ? old.seq + 1 : old.seq;
  }
}

/** Run states only their owner may move (IC-009, IC-026, IC-030, IC-032): a cancel marks and ends a
 * run, a resume clears `resume-required`, and `completed` is final. */
const HELD_RUN_STATES = Object.freeze(['cancelling', 'cancelled', 'completed', 'resume-required']);

/**
 * The one run-state setter, used inside a locked write by every writer of `run.state`. It moves
 * `store.run.state` to `next` and returns true, unless the run holds a state another writer owns:
 * `cancelling`, `cancelled`, `completed` or `resume-required`, which only `writer: 'cancel'` (IC-030
 * steps 3 and 9: to `cancelling` or `cancelled`, never over `completed` or `cancelled`) or
 * `writer: 'resume'` (IC-032 step 8: `resume-required` to `running` or `blocked`) may move. A held
 * state is returned as false with nothing changed, so a pass that read the run before a cancel, a
 * lost driver or a completion never overwrites it.
 */
function setRunState(store: any, next: string, writer: 'cancel' | 'resume' | null = null): boolean {
  const run = store && store.run;
  if (!run) return false;
  const current = run.state;
  if (current === next) return true;
  if (HELD_RUN_STATES.includes(current)) {
    const cancelling = writer === 'cancel' && ['cancelling', 'cancelled'].includes(next) && !['completed', 'cancelled'].includes(current);
    const resuming = writer === 'resume' && current === 'resume-required' && ['running', 'blocked'].includes(next);
    if (!cancelling && !resuming) return false;
  }
  run.state = next;
  return true;
}

/**
 * 106 IC-004: `run.fallback`, created in place with `mode` when absent (a run started before 106).
 * Shape: `{ mode, ladder: string[] | null, inSession?: boolean, exhausted: string[], holds: { [task]: Hold }, events, eventsDropped }`.
 * IC-010: older runs and unset starts omit `inSession`; creating fallback never adds it.
 */
function fallbackOf(run: any, mode: string): any {
  if (!isObject(run.fallback)) run.fallback = { mode, ladder: null, exhausted: [], holds: {}, events: [], eventsDropped: 0 };
  return run.fallback;
}

/** IC-010: only an explicitly stored false disables in-session work; older runs read true. */
function inSessionOf(run: any): boolean {
  return !(isObject(run.fallback) && run.fallback.inSession === false);
}

/** 106 IC-004: appends `event` to `run.fallback.events`, keeping the newest 200 and counting the dropped. */
function appendFallbackEvent(run: any, event: any, mode: string): any {
  const f = fallbackOf(run, mode);
  if (!Array.isArray(f.events)) f.events = [];
  f.events.push(event);
  const over = f.events.length - FALLBACK_EVENTS_MAX;
  if (over > 0) {
    f.events.splice(0, over);
    f.eventsDropped = (Number.isInteger(f.eventsDropped) ? f.eventsDropped : 0) + over;
  }
  return event;
}

/** The whole store, `dispatches` keyed by id; the empty store when the file does not exist. Takes no lock. */
function readDispatch(file: string, fsImpl: any = fs): any {
  try {
    return normalizeStore(readTaskState(fsImpl, file), file);
  } catch (error: any) {
    return rethrow(error, file);
  }
}

/**
 * The one locked write. `decide(store)` changes the store in place and returns `{ write, result }`.
 * Returns `{ outcome, violation, before, written }`, the last two the store as read and as written
 * inside the lock; a violation of the ended add-only rule writes nothing.
 */
function writeLocked(file: string, fsImpl: any, decide: (store: any) => { write: boolean; result: any }, forced: string | null): any {
  let outcome: any = null;
  let violation: any = null;
  let before: any = null;
  let written: any = null;
  try {
    updateTaskState({
      fsImpl,
      file,
      build: (disk: any) => {
        const store = normalizeStore(disk, file);
        before = structuredClone(store);
        outcome = decide(store);
        if (!outcome || typeof outcome !== 'object' || typeof outcome.write !== 'boolean') throw usage('decide must return { write, result }');
        if (!outcome.write) return null;
        violation = checkWrite(before, store);
        if (violation) return null;
        stampSeq(before, store, forced);
        if (store.steps.length > STEP_LIMIT) store.steps = store.steps.slice(-STEP_LIMIT);
        written = structuredClone(store);
        return store;
      },
    });
  } catch (error: any) {
    rethrow(error, file);
  }
  return { outcome, violation, before, written };
}

/**
 * One locked read-decide-write. `decide(store)` runs inside the lock over the parsed store, changes it
 * in place and returns `{ write, result }`; with `write` false the file's bytes stay as they were.
 * Returns `result`. A write that breaks an ended dispatch's add-only rule is a caller defect: thrown
 * `usage`, nothing written.
 */
function mutateDispatch(file: string, decide: (store: any) => { write: boolean; result: any }, fsImpl: any = fs): any {
  const { outcome, violation } = writeLocked(file, fsImpl, decide, null);
  if (violation) throw usage(`ended dispatch '${violation.dispatchId}' cannot change '${violation.field}' (IC-006 add-only)`);
  return outcome.result;
}

/**
 * The per-dispatch compare-and-set. Inside the lock: refuse with no write when the dispatch is absent
 * (`unknown-dispatch`) or its `phase` is not in `allowedPhases` (`phase-not-allowed`, carrying the
 * current record); otherwise `apply(copy)` changes the copy, in place or by returning a replacement,
 * and the dispatch is written with `seq` one higher. On an ended dispatch a change outside the
 * add-only rule is refused `ended-add-only`, naming the field. `apply` runs under the lock.
 * @returns {{ applied: true, dispatch: Object } | { applied: false, reason: string, dispatchId: string, phase?: string, field?: string, dispatch?: Object }}
 */
function transitionDispatch(file: string, dispatchId: string, allowedPhases: string[], apply: (dispatch: any) => any, fsImpl: any = fs): any {
  if (typeof dispatchId !== 'string' || !DISPATCH_ID.test(dispatchId)) throw usage(`dispatch id '${dispatchId}' is not 'd-' plus 12 hex characters`);
  if (!Array.isArray(allowedPhases) || allowedPhases.length === 0 || allowedPhases.some((p) => !PHASES.includes(p))) {
    throw usage(`allowed phases must be a non-empty list of ${PHASES.join(', ')}`);
  }
  const { outcome, violation, before, written } = writeLocked(file, fsImpl, (store) => {
    const current = store.dispatches[dispatchId];
    if (!current) return { write: false, result: { applied: false, reason: 'unknown-dispatch', dispatchId } };
    if (!allowedPhases.includes(current.phase)) {
      return { write: false, result: { applied: false, reason: 'phase-not-allowed', dispatchId, phase: current.phase, dispatch: structuredClone(current) } };
    }
    const draft = structuredClone(current);
    const returned = apply(draft);
    const next = returned && typeof returned === 'object' ? returned : draft;
    store.dispatches[dispatchId] = { ...next, dispatchId };
    return { write: true, result: null };
  }, dispatchId);
  if (violation) {
    return { applied: false, reason: 'ended-add-only', dispatchId, phase: 'ended', field: violation.field, dispatch: structuredClone(before.dispatches[dispatchId]) };
  }
  if (outcome.result) return outcome.result;
  return { applied: true, dispatch: structuredClone(written.dispatches[dispatchId]) };
}

module.exports = {
  storeFileFor,
  newDispatchRunId,
  newDispatchId,
  readDispatch,
  mutateDispatch,
  transitionDispatch,
  setRunState,
  fallbackOf,
  inSessionOf,
  appendFallbackEvent,
  FALLBACK_EVENTS_MAX,
  HELD_RUN_STATES,
  DispatchStoreError,
  PHASES,
  NEXT_PHASES,
  ADD_ONLY_FIELDS,
  STEP_LIMIT,
  DISPATCH_RUN_ID,
  DISPATCH_ID,
};
