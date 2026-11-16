'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The `harness-login` store (design 172 section 4.5): one user-level file, `<config home>/state/harness-login.json`,
 * holding per harness the last recipe answer and the last run outcome. Its one writer path is `updateTaskState`
 * (lock, re-read, temp file, rename), and each write replaces only its own harness's slot, so two projects writing at
 * once keep both. No config home: nothing is written and every read is empty. Bounded at 64 harness entries and
 * 128 KiB; on write, entries for ids no worker catalogue knows are dropped.
 */

const fs = require('node:fs');
const path = require('node:path');
const { updateTaskState, readTaskState } = require('../task-state.ts');
const { configHome } = require('../config-home.ts');
const { knownWorkerIds } = require('../../registry/worker-ids.ts');

import type { RecipeAnswer } from './login.ts';

type RunOutcome = { outcome: 'expired' | 'succeeded'; at: string; runId: string | null; provider: string | null; sign: string | null };
type Slot = { recipe: (RecipeAnswer & { digest: string }) | null; run: RunOutcome | null };
type Store = { version: 1; harnesses: Record<string, Slot> };

const FILE = 'harness-login.json';
const MAX_ENTRIES = 64;
const MAX_BYTES = 128 * 1024;
const MAX_PROVIDERS = 8;
/** A `succeeded` run is not written again while the harness reads logged-in from a run this recent. */
const SUCCEEDED_QUIET_MS = 60 * 60 * 1000;

const plain = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ms = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);

/** The store file, or null when no config home resolves. */
function storeFile(env: any): string | null {
  const dir = configHome(env).dir;
  return dir === null ? null : path.join(dir, 'state', FILE);
}

/** The harnesses of a parsed file, keeping only slots of the stored shape. */
function harnessesOf(disk: any): Record<string, Slot> {
  const out: Record<string, Slot> = {};
  if (!plain(disk?.harnesses)) return out;
  for (const [id, slot] of Object.entries(disk.harnesses) as [string, any][]) {
    if (!plain(slot)) continue;
    out[id] = { recipe: plain(slot.recipe) ? slot.recipe : null, run: plain(slot.run) ? slot.run : null };
  }
  return out;
}

/** The store, or an empty one when there is no config home, no file, or a file that does not parse. Writes nothing. */
function readLoginStore(env: any = process.env): Store {
  const file = storeFile(env);
  if (file === null) return { version: 1, harnesses: {} };
  try {
    return { version: 1, harnesses: harnessesOf(readTaskState(fs, file)) };
  } catch {
    return { version: 1, harnesses: {} };
  }
}

const newest = (slot: Slot) => Math.max(ms(slot.recipe?.at) || 0, ms(slot.run?.at) || 0);

/** Drops unknown ids, then the oldest entries past 64 or 128 KiB; `keep` (the slot just written) always stays. */
function prune(harnesses: Record<string, Slot>, keep: string, known: readonly string[]): Record<string, Slot> {
  const ids = Object.keys(harnesses).filter((id) => id === keep || known.includes(id));
  const order = ids.filter((id) => id !== keep).sort((a, b) => newest(harnesses[b]) - newest(harnesses[a]));
  let kept = [keep, ...order].slice(0, MAX_ENTRIES);
  const build = () => Object.fromEntries(kept.map((id) => [id, harnesses[id]]));
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify({ version: 1, revision: 0, harnesses: build() }, null, 2)) > MAX_BYTES) kept = kept.slice(0, -1);
  return build();
}

/** Writes one harness's slot through the lock; `change` returns the new slot, or null to write nothing. */
function writeSlot(env: any, harness: string, change: (slot: Slot) => Slot | null, known?: readonly string[]): string | null {
  const file = storeFile(env);
  if (file === null) return null;
  const ids = known ?? knownWorkerIds({}).ids;
  return updateTaskState({
    fsImpl: fs,
    file,
    // A file that does not parse is a cache lost, not a record: it is set aside so the store can be written again.
    prepare: () => {
      try { readTaskState(fs, file); } catch (error: any) { if (error?.code === 'store-unreadable') fs.rmSync(file, { force: true }); else throw error; }
    },
    build: (disk: any) => {
      const harnesses = harnessesOf(disk);
      const next = change(harnesses[harness] ?? { recipe: null, run: null });
      if (next === null) return null;
      harnesses[harness] = next;
      return { harnesses: prune(harnesses, harness, ids) };
    },
  });
}

/** Records a recipe answer (`checkLogin`'s) with the digest of the recipe that made it. Returns the file or null. */
function recordRecipeAnswer(env: any, harness: string, answer: RecipeAnswer, digest: string, { known }: { known?: readonly string[] } = {}): string | null {
  const recipe = {
    state: answer.state,
    reason: answer.reason,
    at: answer.at,
    digest,
    billing: answer.billing,
    providers: (answer.providers ?? []).slice(0, MAX_PROVIDERS).map((entry) => ({ id: entry.id, state: entry.state, mode: entry.mode, reason: entry.reason })),
    checked: answer.checked,
    listed: answer.listed,
  };
  return writeSlot(env, harness, (slot) => ({ ...slot, recipe }), known);
}

/**
 * Records a run's outcome: `expired` (a failure whose summary held an expiry sign) or `succeeded`. A `succeeded` is
 * skipped while the harness already reads logged-in from a `succeeded` run under 1 h old that is newer than its
 * recipe answer, so a busy pool does not rewrite the file on every run. Returns the file, or null when nothing was
 * written.
 */
function recordRunOutcome(env: any, harness: string, outcome: Partial<RunOutcome> & { outcome: RunOutcome['outcome'] }, { now = Date.now, known }: { now?: any; known?: readonly string[] } = {}): string | null {
  const nowMs = typeof now === 'function' ? now() : now;
  const run: RunOutcome = {
    outcome: outcome.outcome,
    at: outcome.at ?? new Date(nowMs).toISOString(),
    runId: outcome.runId ?? null,
    provider: outcome.provider ?? null,
    sign: outcome.sign ?? null,
  };
  return writeSlot(env, harness, (slot) => {
    const prior = slot.run;
    const quiet = run.outcome === 'succeeded' && prior?.outcome === 'succeeded' && nowMs - ms(prior.at) < SUCCEEDED_QUIET_MS
      && (!slot.recipe || ms(prior.at) >= ms(slot.recipe.at));
    return quiet ? null : { ...slot, run };
  }, known);
}

module.exports = { readLoginStore, recordRecipeAnswer, recordRunOutcome, storeFile, MAX_ENTRIES, MAX_BYTES };

export type { RunOutcome, Slot, Store };
