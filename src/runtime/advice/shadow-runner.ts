'use strict';

// The detached shadow call (row 174 O-2, O-5). shadow-dispatcher.ts takes one of the user's shadow slots, writes one
// JSON payload to a handoff file beside it (row 174 R-02) and spawns this file detached, with no stdio at all and the
// handoff's path as its one argument: the call's context (the state text and question set never travel in argv or
// env), the effective model, the budget, the pick id, the store roots and the slot taken for this child. The child
// reads and removes the handoff before anything else, asks the advisor bounded by the budget, records its pick or miss
// through the dispatcher's recordCall (record.ts: digests and byte counts, never the state text; a batch's payload carries
// its `staticPicks`, and the one recordCall writes a line per question, row 176 IC-004), frees the slot and exits. It
// never outlives the budget by more than EXIT_GRACE_MS, nor its slot's staleness.
//
// Slots (store advice-shadow-slots-user): at most `shadowSlots` (core/registry/advice.json) shadow children run at once
// across every project of this user, one file each, created with O_EXCL by the parent BEFORE it spawns (row 174 R-04),
// so a burst of calls cannot start more children than slots. The parent creates a slot with no pid and names the child's
// pid in it once spawned (adoptSlot). A slot is removed by the child it was taken for, with its handoff if still there;
// a stale slot (its pid is gone, or it is older than its budget plus SLOT_MARGIN_MS) is reclaimed in place, by one call
// only (reclaimSlot), and the handoff its child never read goes with it. A call that finds no free slot records a
// `busy` miss and starts no child.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SLOT_STORE = { root: 'user-state', path: 'advice/shadow-slots' };
const SLOT_MARGIN_MS = 5000;
const EXIT_GRACE_MS = 1000;
/** Reclaim lock rounds of one stale holding: a round is passed only when its lock was left by a call that died. */
const RECLAIM_ROUNDS = 4;

type Slot = { file: string; token: string; startedAt: number };

/** The handoff file of the slot file `file` held under `token`: the child's payload until the child reads it. */
function handoffFile(file: string, token: string): string {
  return file.replace(/\.json$/, `.payload-${token}.json`);
}

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
  // No pid yet: the parent took it and its child is not named yet, so only its age can make it stale.
  if (held.pid === null) return false;
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
      // The stale holding's child never read its handoff, or died before removing it: it holds the state text.
      if (seen.held) {
        try { fsImpl.unlinkSync(handoffFile(file, seen.key)); } catch { /* read and removed by its child */ }
      }
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

/**
 * Takes one of `limit` slots under `dir` for a child not started yet (no pid), or returns null when every one is held by
 * a live, in-budget call.
 */
function takeSlot(dir: string, limit: number, budgetMs: number, {
  now = Date.now, alive = pidAlive, fsImpl = fs,
}: { now?: () => number; alive?: (pid: unknown) => boolean; fsImpl?: any } = {}): Slot | null {
  fsImpl.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(6).toString('hex');
  const startedAt = now();
  const body = JSON.stringify({ pid: null, token, startedAt, budgetMs });
  for (let index = 0; index < limit; index += 1) {
    const file = path.join(dir, `slot-${index}.json`);
    try {
      fsImpl.writeFileSync(file, body, { flag: 'wx' });
      return { file, token, startedAt };
    } catch (error: any) {
      if (error?.code === 'EEXIST' && reclaimSlot(file, body, token, budgetMs, now, alive, fsImpl)) return { file, token, startedAt };
    }
  }
  return null;
}

/** Names the started child's pid in its slot (one rename), so the slot is freed for reuse as soon as the child is gone. */
function adoptSlot(slot: Slot, pid: unknown, fsImpl: any = fs): void {
  if (!Number.isInteger(pid)) return;
  try {
    const held = JSON.parse(fsImpl.readFileSync(slot.file, 'utf8'));
    if (held?.token !== slot.token) return;
    const temp = `${slot.file}.tmp-${slot.token}`;
    fsImpl.writeFileSync(temp, JSON.stringify({ ...held, pid }));
    fsImpl.renameSync(temp, slot.file);
  } catch { /* the slot stays without a pid: its age frees it */ }
}

/**
 * Writes the child's payload to the slot's handoff file (O_EXCL, readable by this user only) and returns its path. A
 * local write of a payload whose state is within limits.maxStateBytes: nothing waits on a reader.
 */
function writeHandoff(slot: Slot, text: string, fsImpl: any = fs): string {
  const file = handoffFile(slot.file, slot.token);
  fsImpl.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  return file;
}

/** Reads and removes a handoff file; the parsed payload, or null. */
function readHandoff(file: unknown, fsImpl: any = fs): any {
  if (typeof file !== 'string' || !file) return null;
  let payload: any = null;
  try { payload = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { payload = null; }
  try { fsImpl.unlinkSync(file); } catch { /* gone already */ }
  return payload;
}

/**
 * Removes the slot when it is still this call's (a reclaimed slot belongs to another call now), and its handoff file
 * when no child read it.
 */
function releaseSlot(slot: Slot, fsImpl: any = fs): void {
  try { fsImpl.unlinkSync(handoffFile(slot.file, slot.token)); } catch { /* read and removed by the child */ }
  try {
    if (JSON.parse(fsImpl.readFileSync(slot.file, 'utf8'))?.token === slot.token) fsImpl.unlinkSync(slot.file);
  } catch { /* gone already */ }
}

function fullRegistry(registry: any): boolean {
  return Boolean(registry) && Array.isArray(registry.kinds) && Array.isArray(registry.providers) && Boolean(registry.limits);
}

/** The slot a payload names, or null. */
function payloadSlot(payload: any): Slot | null {
  const slot = payload?.slot;
  if (!slot || typeof slot.file !== 'string' || typeof slot.token !== 'string' || !Number.isFinite(slot.startedAt)) return null;
  return { file: slot.file, token: slot.token, startedAt: slot.startedAt };
}

/**
 * When the call must have ended: its budget from `arrivedAt` (when the payload arrived), not from when the ask starts,
 * so slow module loading eats the budget instead of pushing the call past the exit guard in main(); and never later
 * than its slot can be reclaimed for its age, less EXIT_GRACE_MS, so a late-starting child is gone before its slot is
 * reused and the slot bound holds.
 */
function deadlineOf(budget: number, arrivedAt: number, slot: Slot | null): number {
  const own = arrivedAt + budget;
  return slot ? Math.min(own, slot.startedAt + budget + SLOT_MARGIN_MS - EXIT_GRACE_MS) : own;
}

/**
 * Runs one shadow call from its payload: ask, record, release the payload's slot. Never throws. The call ends by
 * deadlineOf, so it records and frees its slot before the exit guard in main() fires.
 */
async function runShadow(payload: any, { fsImpl = fs, arrivedAt = Date.now() }: { fsImpl?: any; arrivedAt?: number } = {}): Promise<void> {
  const slot = payloadSlot(payload);
  try {
    await askAndRecord(payload, fsImpl, arrivedAt, slot);
  } finally {
    if (slot) releaseSlot(slot, fsImpl);
  }
}

async function askAndRecord(payload: any, fsImpl: any, arrivedAt: number, slot: Slot | null): Promise<void> {
  let askAdvisor: any, recordCall: any, missCall: any, createAdviceClient: any, loadAdviceRegistry: any, REPO_ROOT: any;
  try {
    ({ askAdvisor, recordCall, missCall } = require('./shadow-dispatcher.ts'));
    ({ createAdviceClient } = require('./client.ts'));
    ({ loadAdviceRegistry } = require('./registry.ts'));
    ({ REPO_ROOT } = require('../../helper/repo-root.ts'));
  } catch {
    // A child that cannot load what it asks with is not silent: it records a spawn-failed miss through record.ts alone.
    try {
      const { appendMiss } = require('./record.ts');
      const context = payload?.context;
      if (payload?.roots && typeof payload.roots === 'object' && typeof context?.kind === 'string') {
        // A batch records one miss per question, any other decision its one miss, as recordCall writes them (176 IC-004;
        // the dispatcher's isBatch, repeated here because the dispatcher may be what failed to load).
        const questions = Array.isArray(context.questionSet?.questions) ? context.questionSet.questions.length : 0;
        const batch = questions >= 1 && Array.isArray(context.staticPicks) && context.staticPicks.length === questions;
        for (let index = 0; index < (batch ? questions : 1); index += 1) {
          appendMiss({ roots: payload.roots, fsImpl, kind: context.kind, caller: context.caller, reason: 'spawn-failed', model: payload.model ?? null, durationMs: 0, mode: 'shadow' });
        }
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
    const adviceClient = createAdviceClient({ adviceRegistry, roots, fsImpl });
    const remaining = deadlineOf(budget, arrivedAt, slot) - Date.now();
    const asked = remaining > 0
      ? await askAdvisor(context, { ...services, adviceClient }, model, remaining)
      : { ...missCall('timeout', model), durationMs: Date.now() - arrivedAt };
    recordCall(context, services, 'shadow', asked, payload.pickId, false);
  } catch { /* advice is advisory: a failed shadow call leaves nothing behind but its slot release */ }
}

/** Reads and removes the handoff named by the one argument first, then loads the rest. */
function main(): void {
  const payload = readHandoff(process.argv[2]);
  const slot = payloadSlot(payload);
  if (!payload || payload.v !== 1 || !Number.isFinite(payload.budgetMs)) {
    if (slot) releaseSlot(slot);
    process.exit(0);
  }
  const arrivedAt = Date.now();
  const guard = setTimeout(() => {
    if (slot) releaseSlot(slot);
    process.exit(0);
  }, Math.max(0, deadlineOf(payload.budgetMs, arrivedAt, slot) + EXIT_GRACE_MS - Date.now()));
  guard.unref();
  try { require('node:module').enableCompileCache(); } catch { /* best-effort */ }
  runShadow(payload, { arrivedAt }).finally(() => process.exit(0));
}

if (require.main === module) main();

module.exports = { takeSlot, adoptSlot, writeHandoff, releaseSlot, fullRegistry, runShadow, SLOT_STORE, SLOT_MARGIN_MS };
