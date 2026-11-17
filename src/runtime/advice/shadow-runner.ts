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
// SLOT_MARGIN_MS) is reclaimed in place. A call that finds no free slot records a `busy` miss and makes no call.
// Ceiling accepted: two children that reclaim the same stale slot at the same moment can both run, so the bound can be
// passed by one call for the length of that race.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SLOT_STORE = { root: 'user-state', path: 'advice/shadow-slots' };
const SLOT_MARGIN_MS = 5000;
const EXIT_GRACE_MS = 1000;
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

/** Whether the slot file is held by no live, in-budget call. A file being written (unreadable) is live while young. */
function staleSlot(file: string, now: number, fallbackBudget: number, alive: (pid: unknown) => boolean, fsImpl: any): boolean {
  let held: any = null;
  try { held = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { held = null; }
  if (!held || typeof held !== 'object') {
    try { return now - fsImpl.statSync(file).mtimeMs > SLOT_MARGIN_MS; } catch { return true; }
  }
  const budget = Number.isFinite(held.budgetMs) && held.budgetMs > 0 ? held.budgetMs : fallbackBudget;
  if (!Number.isFinite(held.startedAt) || now - held.startedAt > budget + SLOT_MARGIN_MS) return true;
  return !alive(held.pid);
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fsImpl.writeFileSync(file, body, { flag: 'wx' });
        return { file, token };
      } catch (error: any) {
        if (error?.code !== 'EEXIST' || !staleSlot(file, now(), budgetMs, alive, fsImpl)) break;
        try { fsImpl.unlinkSync(file); } catch { /* another child reclaimed it first */ }
      }
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
