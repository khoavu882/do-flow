'use strict';

// The detached shadow call (row 174 O-2, O-5). shadow-dispatcher.ts spawns this file detached, with stdout and stderr
// ignored, and writes one JSON payload to its stdin: the call's context (the state text and question set travel only
// here, in memory, never in argv, env or a file), the effective model, the budget, the pick id and the store roots.
// The child takes one of the user's shadow slots, asks the advisor bounded by the budget, records its pick or miss
// through the dispatcher's recordCall (record.ts: digests and byte counts, never the state text), frees the slot and
// exits. It never outlives the budget by more than EXIT_GRACE_MS.
//
// Slots (store advice-shadow-slots-user): at most `shadowSlots` (core/registry/advice.json) shadow calls run at once
// across every project of this user, one file each, created with O_EXCL so two children never hold the same one. A
// slot is removed by the call that took it; a stale slot (its pid is gone, or it is older than its budget plus
// SLOT_MARGIN_MS) is reclaimed in place, by one call only (reclaimSlot). A call that finds no free slot records a `busy`
// miss and makes no call.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SLOT_STORE = { root: 'user-state', path: 'advice/shadow-slots' };
const SLOT_MARGIN_MS = 5000;
const EXIT_GRACE_MS = 1000;
/** Reclaim lock rounds of one stale holding: a round is passed only when its lock was left by a call that died. */
const RECLAIM_ROUNDS = 4;
/** Before the payload names a budget: the registry's ceiling for any call (advice.json timeoutMs is at most 30000). */
const FIRST_GUARD_MS = 30000;

type Slot = { file: string; token: string };

function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

/** What a slot file holds: its holder, or null while it is unreadable (being written), and the key of that holding. */
function readSlot(file: string, fsImpl: any): { held: any; key: string; mtimeMs: number } | null {
  let mtimeMs: number;
  try { mtimeMs = fsImpl.statSync(file).mtimeMs; } catch { return null; }
  let held: any = null;
  try { held = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { held = null; }
  if (!held || typeof held !== 'object') held = null;
  const key = held && typeof held.token === 'string' && /^[0-9a-z]{1,32}$/.test(held.token) ? held.token : `m${Math.floor(mtimeMs)}`;
  return { held, key, mtimeMs };
}

/** Whether the slot is held by no live, in-budget call. A file being written (unreadable) is live while young. */
function staleSlot(seen: { held: any; mtimeMs: number }, now: number, fallbackBudget: number, alive: (pid: unknown) => boolean): boolean {
  const { held } = seen;
  if (!held) return now - seen.mtimeMs > SLOT_MARGIN_MS;
  const budget = Number.isFinite(held.budgetMs) && held.budgetMs > 0 ? held.budgetMs : fallbackBudget;
  if (!Number.isFinite(held.startedAt) || now - held.startedAt > budget + SLOT_MARGIN_MS) return true;
  return !alive(held.pid);
}

/**
 * Replaces the stale slot `file` with `body`, atomically against every other call reclaiming it (row 174 R-03): only the
 * call that creates the holding's reclaim lock (O_EXCL, named after the stale holding's key) may replace it, and only
 * while the slot still holds that holding; the replacement is one rename, so the slot is never absent. A lock is held for
 * a few system calls, so one older than SLOT_MARGIN_MS was left by a call that died holding it: the next round's lock
 * is taken instead.
 */
function reclaimSlot(file: string, body: string, token: string, budgetMs: number, now: () => number, alive: (pid: unknown) => boolean, fsImpl: any): boolean {
  const seen = readSlot(file, fsImpl);
  if (!seen || !staleSlot(seen, now(), budgetMs, alive)) return false;
  const lockOf = (round: number) => `${file}.reclaim-${seen.key}-${round}`;
  for (let round = 0; round < RECLAIM_ROUNDS; round += 1) {
    const lock = lockOf(round);
    try {
      fsImpl.writeFileSync(lock, '', { flag: 'wx' });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') return false;
      let age = 0;
      try { age = now() - fsImpl.statSync(lock).mtimeMs; } catch { return false; }
      if (age > SLOT_MARGIN_MS) continue;
      return false;
    }
    try {
      if (readSlot(file, fsImpl)?.key !== seen.key) return false;
      const temp = `${file}.tmp-${token}`;
      fsImpl.writeFileSync(temp, body);
      fsImpl.renameSync(temp, file);
      for (let earlier = 0; earlier < round; earlier += 1) {
        try { fsImpl.unlinkSync(lockOf(earlier)); } catch { /* gone already */ }
      }
      return true;
    } finally {
      try { fsImpl.unlinkSync(lock); } catch { /* gone already */ }
    }
  }
  return false;
}

/** Takes one of `limit` slots under `dir`, or returns null when every one is held by a live, in-budget call. */
function takeSlot(dir: string, limit: number, budgetMs: number, {
  now = Date.now, pid = process.pid, alive = pidAlive, fsImpl = fs,
}: { now?: () => number; pid?: number; alive?: (pid: unknown) => boolean; fsImpl?: any } = {}): Slot | null {
  fsImpl.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(6).toString('hex');
  const body = JSON.stringify({ pid, token, startedAt: now(), budgetMs });
  for (let index = 0; index < limit; index += 1) {
    const file = path.join(dir, `slot-${index}.json`);
    try {
      fsImpl.writeFileSync(file, body, { flag: 'wx' });
      return { file, token };
    } catch (error: any) {
      if (error?.code === 'EEXIST' && reclaimSlot(file, body, token, budgetMs, now, alive, fsImpl)) return { file, token };
    }
  }
  return null;
}

/** Removes the slot when it is still this call's (a reclaimed slot belongs to another call now). */
function releaseSlot(slot: Slot, fsImpl: any = fs): void {
  try {
    if (JSON.parse(fsImpl.readFileSync(slot.file, 'utf8'))?.token === slot.token) fsImpl.unlinkSync(slot.file);
  } catch { /* gone already */ }
}

function fullRegistry(registry: any): boolean {
  return Boolean(registry) && Array.isArray(registry.kinds) && Array.isArray(registry.providers) && Boolean(registry.limits);
}

/**
 * Runs one shadow call from its payload: slot, ask, record, release. Never throws. The budget runs from `arrivedAt` (when
 * the payload arrived), not from when the ask starts, so slow module loading eats the budget instead of pushing the call
 * past the exit guard in main(): the call ends, records and frees its slot before that guard fires.
 */
async function runShadow(payload: any, { fsImpl = fs, arrivedAt = Date.now() }: { fsImpl?: any; arrivedAt?: number } = {}): Promise<void> {
  let askAdvisor: any, recordCall: any, missCall: any, createAdviceClient: any, loadAdviceRegistry: any, resolveStorePath: any, REPO_ROOT: any;
  try {
    ({ askAdvisor, recordCall, missCall } = require('./shadow-dispatcher.ts'));
    ({ createAdviceClient } = require('./client.ts'));
    ({ loadAdviceRegistry } = require('./registry.ts'));
    ({ resolveStorePath } = require('../storage/roots.ts'));
    ({ REPO_ROOT } = require('../../helper/repo-root.ts'));
  } catch {
    // A child that cannot load what it asks with is not silent: it records a spawn-failed miss through record.ts alone.
    try {
      const { appendMiss } = require('./record.ts');
      const context = payload?.context;
      if (payload?.roots && typeof payload.roots === 'object' && typeof context?.kind === 'string') {
        appendMiss({ roots: payload.roots, fsImpl, kind: context.kind, caller: context.caller, reason: 'spawn-failed', model: payload.model ?? null, durationMs: 0, mode: 'shadow' });
      }
    } catch { /* record.ts itself cannot load: nothing can be written (shadow-dispatcher.ts spawnShadow) */ }
    return;
  }
  try {
    const roots = payload?.roots;
    const budget = payload?.budgetMs;
    if (!roots || typeof roots !== 'object' || !Number.isFinite(budget) || budget <= 0 || typeof payload.pickId !== 'string') return;
    const shipped = () => {
      const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
      return loaded.ok ? loaded.registry : null;
    };
    const adviceRegistry = fullRegistry(payload.context?.adviceRegistry) ? payload.context.adviceRegistry : shipped();
    const context = { ...payload.context, adviceRegistry, record: true };
    // The dispatcher sends a question set's state once when it equals the call's state.
    if (context.questionSet && typeof context.questionSet === 'object' && context.questionSet.state === undefined) {
      context.questionSet = { ...context.questionSet, state: context.state };
    }
    const model = typeof payload.model === 'string' && payload.model ? payload.model : null;
    const services = { roots };
    const limit = adviceRegistry?.shadowSlots;
    const dir = resolveStorePath({ store: SLOT_STORE, roots, fsImpl });
    let slot: Slot | null = null;
    try {
      if (dir && Number.isInteger(limit) && limit > 0) slot = takeSlot(dir, limit, budget, { fsImpl });
    } catch { slot = null; }
    if (!slot) {
      recordCall(context, services, 'shadow', missCall('busy', model), payload.pickId, false);
      return;
    }
    try {
      const adviceClient = createAdviceClient({ adviceRegistry, roots, fsImpl });
      const elapsed = Date.now() - arrivedAt;
      const remaining = budget - elapsed;
      const asked = remaining > 0
        ? await askAdvisor(context, { ...services, adviceClient }, model, remaining)
        : { ...missCall('timeout', model), durationMs: elapsed };
      recordCall(context, services, 'shadow', asked, payload.pickId, false);
    } finally {
      releaseSlot(slot, fsImpl);
    }
  } catch { /* advice is advisory: a failed shadow call leaves nothing behind but its slot release */ }
}

/** Reads the payload from stdin first (the parent's pipe waits on that), then loads the rest. */
function main(): void {
  let guard = setTimeout(() => process.exit(0), FIRST_GUARD_MS);
  guard.unref();
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let payload: any = null;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { process.exit(0); }
    if (!payload || payload.v !== 1 || !Number.isFinite(payload.budgetMs)) process.exit(0);
    const arrivedAt = Date.now();
    clearTimeout(guard);
    guard = setTimeout(() => process.exit(0), payload.budgetMs + EXIT_GRACE_MS);
    guard.unref();
    try { require('node:module').enableCompileCache(); } catch { /* best-effort */ }
    runShadow(payload, { arrivedAt }).finally(() => process.exit(0));
  });
}

if (require.main === module) main();

module.exports = { takeSlot, releaseSlot, runShadow, SLOT_STORE, SLOT_MARGIN_MS };
