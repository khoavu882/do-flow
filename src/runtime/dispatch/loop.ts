'use strict';

// Feature 082 C.3 (IC-003, IC-004, IC-005, IC-022, IC-023, IC-025, IC-026, IC-027, IC-028, IC-033
// launch; DEC-001, DEC-006, DEC-010, DEC-011, DEC-013, DEC-017, DEC-029, DEC-035, DEC-039, DEC-048,
// DEC-052): the dispatch loop.
//
// `step` is one bounded pass in IC-003's fixed order: reconcile, collect, integrate one, time out,
// launch children, admit, decide. No lock is held from one phase to the next, nor across a git
// call, a spawn, a signal or a wait (IC-006): every locked write is one `mutateDispatch` whose
// decide callback makes only the in-process 080 calls of `attempt-end.ts` and `admission.ts`. The
// pass's last locked write appends its step record. `run` repeats `step` (IC-004) under one driver,
// waits 500 ms after a pass that did nothing, and stops on a terminal outcome, a perform yield, a
// pause or `--max-seconds`; on SIGINT or SIGTERM it finishes the phase in progress, writes its
// driver end and reports exit 130 or 143.
//
// Workers are launched only through 081's `executeWorkerCommand` (`run` with `edit: true`, the
// handoff envelope as `--prompt-file`), outside every lock; a worker run is ended only through 081's
// `cancelRun`. This module signals nothing and calls no escalation (DEC-047): verification groups
// are `verify-run.ts`'s. Mode selection (IC-022) applies the static gate (DEC-052) from the declared
// worker block before any discover or binary lookup, so a harness whose `isolatedEdit` is not
// `supported` never has its binary looked up.
//
// Every write goes through `store.ts` (`updateTaskState`); this module makes no fs write call.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const attempts = require('../task-attempts.ts');
const { runKeyFor, identityRefusal } = require('../task-run.ts');
const { readTaskState } = require('../task-state.ts');
const { maskLine, maskBody } = require('../mask.ts');
const { projectRoot } = require('../lifecycle/root.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const readiness = require('../worker/readiness.ts');
const { executeWorkerCommand, settledStatus } = require('../worker/command.ts');
const { cancelRun } = require('../worker/cancel.ts');
const { resultOfRun } = require('../worker/supervisor.ts');
const { readRuns, storeFileFor: runStoreFileFor } = require('../worker/run-store.ts');
const { storeFileFor, readDispatch, mutateDispatch, setRunState, HELD_RUN_STATES, DispatchStoreError, DISPATCH_ID } = require('./store.ts');
const { registerDriver, endDriver, admit, MAIN_SESSION_MODES, BUDGET_REFUSALS } = require('./admission.ts');
const integrate = require('./integrate.ts');
const { classFor, endAttempt, releaseAttempt, usageFor, SIGNALS } = require('./attempt-end.ts');
const { buildHandoff, buildResult, writeEnvelope, cutUtf8, normalizeFile } = require('./envelope.ts');
const { runVerification } = require('./verify-run.ts');
const { REQUEST_ID } = require('./grants.ts');

/** IC-003's outcomes. */
const OUTCOMES = Object.freeze(['continue', 'perform', 'paused', 'completed', 'blocked', 'cancelled', 'resume-required']);
/** IC-004: the outcomes after which `run` returns. */
const RUN_STOPS = Object.freeze(['completed', 'blocked', 'cancelled', 'resume-required', 'perform', 'paused']);
const IDLE_WAIT_MS = 500;
const RUN_MAX_SECONDS_DEFAULT = 600;
const RUN_MAX_SECONDS_LIMIT = 14400;
/** IC-025: 081's own timeout fires this long after the loop's deadline. */
const BACKSTOP_SECONDS = 120;
const ATTEMPT_SECONDS_DEFAULT = 1680;
const LOOP_BY = 'doflow-dispatch';
const SIGNAL_EXITS: Readonly<Record<string, number>> = Object.freeze({ SIGINT: 130, SIGTERM: 143 });
/** IC-022 / DEC-052: the declared-capability requirements checked before any discover. */
const STATIC_GATE = Object.freeze([
  ['one-shot', 'oneShot'], ['structured-output', 'structuredOutput'], ['isolated-edit', 'isolatedEdit'], ['spawn-denial', 'spawnDenial'],
]);
/** IC-027: the gap causes in report order. */
const CAUSE_ORDER = Object.freeze(['input', 'authorization', 'budget', 'no-progress']);
const LIVE_WORKER_STATES = Object.freeze(['starting', 'running']);
/** IC-010: the three chain artifacts every handoff points at, after the declared files. */
const CHAIN_ARTIFACTS = Object.freeze(['intention/requirement.md', 'design/design.md', 'plan.md']);
const SUMMARY_BYTES = 8192;
const SUMMARY_KEPT_BYTES = 2000;
const BLOCKERS_MAX = 20;
const BLOCKER_CHARS = 200;
const REASON_CHARS = 200;
const BASES = Object.freeze(['measured', 'estimated']);
/** IC-030 step 3: the run states a cancel has marked. From then on no pass moves the run's state. */
const CANCEL_MARKED = Object.freeze(['cancelling', 'cancelled']);

type Env = Record<string, string | undefined>;

function usage(message: string) {
  return new DispatchStoreError('usage', message);
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (at: Date) => at.toISOString();
const sha256 = (bytes: any) => crypto.createHash('sha256').update(bytes).digest('hex');

function refused(reason: string, extra: any = {}) {
  return { disposition: 'refused', reason, ...extra };
}

/** `reason` as a StepAction reason: masked, at most 200 characters after its token. */
function clipReason(reason: any): string {
  const text = maskLine(String(reason ?? '')).text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= REASON_CHARS ? text : chars.slice(0, REASON_CHARS).join('');
}

// ── the caller (IC-001 identity checks, shared with C.5) ─────────────────────────────────────────

/**
 * IC-001's identity checks for every action but `start` and `spawn`: the caller is not solo or a
 * worker session, a dispatch run exists and its stored `runKey` is the caller's. Returns
 * `{ key, store }`, or `{ refusal }` with nothing written.
 */
function checkCaller({ env, cwd, file }: { env: Env; cwd: string; file: string }) {
  const key = runKeyFor(env, cwd);
  const who = identityRefusal(key.identity);
  if (who) return { refusal: refused(who.reason, { runKey: key.runKey }) };
  const current = readDispatch(file);
  if (!current.run) return { refusal: refused('no-dispatch-run') };
  if (current.run.runKey !== key.runKey) return { refusal: refused('foreign-run', { runKey: current.run.runKey, callerRunKey: key.runKey }) };
  return { key, store: current };
}

// ── mode selection (IC-022) ──────────────────────────────────────────────────────────────────────

/** DEC-052: the static gate's gaps from the declared worker block alone; nothing runs. */
function staticGate(worker: any): any[] {
  const gaps: any[] = [];
  const cli = worker ? worker.cli : null;
  if (!cli || cli.status !== 'supported') {
    gaps.push({ requirement: 'cli', result: cli && cli.status === 'unsupported' ? 'failed' : 'unknown', reason: (cli && cli.reason) || (cli ? cli.status : 'not-declared') });
  }
  for (const [requirement, key] of STATIC_GATE) {
    const r = readiness.capabilityRequirement(requirement, worker ? worker[key] : null);
    if (r.result !== 'met') gaps.push({ requirement: r.requirement, result: r.result, reason: r.reason });
  }
  return gaps;
}

/** 081 run step 11 for one harness that passed the static gate: discover, then effective probe
 * facts, with the edit baseline and the run's needs. Writes nothing. */
function evaluateEdit({ harness, worker, needs, registry, coverage, env, cwd, root, now, platform }: any) {
  const body = readiness.select({ descriptors: { [harness]: worker }, registry, coverage, harness, needs, edit: true, env, cwd, root, now, platform });
  const c = body.candidates[0];
  return { eligible: Boolean(c && c.eligible), gaps: c ? c.gaps : [] };
}

/** Every candidate harness in registry order (or only `harness`), each `{ harness, eligible, gaps }`. */
function evaluateHarnesses({ harness = null, needs = [], descriptors, registry, coverage, env, cwd, root, now = Date.now, platform = process.platform, evaluateImpl = evaluateEdit }: any) {
  const reg = registry || loadRegistry({ repoRoot: REPO_ROOT });
  const cov = coverage === undefined ? reg.coverage : coverage;
  const entries = readiness.workerDescriptors({ descriptors, registry: reg }).filter((e: any) => !harness || e.harness === harness);
  return entries.map((entry: any) => {
    const gaps = staticGate(entry.worker);
    if (gaps.length) return { harness: entry.harness, eligible: false, gaps };
    const judged = evaluateImpl({ harness: entry.harness, worker: entry.worker, needs, registry: reg, coverage: cov, env, cwd, root, now, platform });
    return { harness: entry.harness, eligible: Boolean(judged.eligible), gaps: judged.gaps || [] };
  });
}

/**
 * IC-022: the mode one attempt of `task` runs in. `held` (a take over) is `manual` under policy
 * `manual`, else `sequential`; policies `manual` and `sequential` are themselves; under `auto` a
 * task whose last failure class is `launch` runs `sequential`, else the first eligible harness runs
 * it as `subagent`, else `sequential`. Returns `{ mode, harness, selection: { policy, chosen,
 * candidates } }`. `cache` (an object) holds the harness evaluation for one pass.
 */
function selectMode({ policy = 'auto', held = false, lastFailureClass = null, cache = null, ...rest }: any) {
  const fixed = (mode: string) => ({ mode, harness: null, selection: { policy, chosen: mode, candidates: [] } });
  if (held) return fixed(policy === 'manual' ? 'manual' : 'sequential');
  if (policy === 'manual' || policy === 'sequential') return fixed(policy);
  if (policy !== 'auto') throw usage(`mode policy '${policy}' is not auto, sequential or manual`);
  if (lastFailureClass === 'launch') return fixed('sequential');
  let candidates = cache && cache.candidates;
  if (!candidates) {
    candidates = evaluateHarnesses(rest);
    if (cache) cache.candidates = candidates;
  }
  const chosen = candidates.find((c: any) => c.eligible);
  const selection = { policy, chosen: chosen ? chosen.harness : 'sequential', candidates: structuredClone(candidates) };
  return chosen ? { mode: 'subagent', harness: chosen.harness, selection } : { mode: 'sequential', harness: null, selection };
}

/** The failure class of `task`'s most recent failed dispatch (highest token), or null. */
function lastFailure(current: any, task: string): string | null {
  let last: any = null;
  for (const d of Object.values(current.dispatches) as any[]) {
    if (d.task !== task || d.phase !== 'ended' || !Number.isInteger(d.token)) continue;
    if (!last || d.token > last.token) last = d;
  }
  return last && last.disposition === 'failed' ? last.failureClass ?? null : null;
}

// ── measurement (IC-028) ─────────────────────────────────────────────────────────────────────────

const emptyTokens = () => ({ measured: 0, estimated: 0 });
const emptyDuration = () => ({ count: 0, totalMs: 0, maxMs: 0 });

function addDuration(d: any, ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  d.count += 1;
  d.totalMs += ms;
  d.maxMs = Math.max(d.maxMs, ms);
}

/** Current worker and worktree counts (IC-028 peaks). */
function liveCounts(s: any) {
  const ds = Object.values(s.dispatches) as any[];
  const rs = Object.values(s.spawnRequests) as any[];
  const workers = ds.filter((d) => d.phase === 'launched' && d.mode === 'subagent' && d.workerRunId).length
    + rs.filter((r) => r.state === 'launched' && r.endState == null).length;
  const worktrees = ds.filter((d) => d.phase !== 'admitted' && d.attempt && d.attempt.worktree && !(d.removal && d.removal.verified)).length
    + rs.filter((r) => r.worktree && !(r.removal && r.removal.verified)).length;
  return { workers, worktrees };
}

/** Raises the stored peaks to the current counts; called inside the loop's locked writes. */
function bumpPeak(s: any) {
  if (!s.run) return;
  const now = liveCounts(s);
  const peak = s.run.peak || { workers: 0, worktrees: 0 };
  s.run.peak = { workers: Math.max(peak.workers || 0, now.workers), worktrees: Math.max(peak.worktrees || 0, now.worktrees) };
}

/** IC-028 from the store: tokens by source and basis, durations and peaks. Pure. */
function measurement(s: any) {
  const tokens: any = { main: emptyTokens(), worker: emptyTokens(), child: emptyTokens(), total: emptyTokens() };
  const add = (bucket: string, u: any) => {
    if (!u || !Number.isInteger(u.tokens) || !BASES.includes(u.basis)) return;
    tokens[bucket][u.basis] += u.tokens;
    tokens.total[u.basis] += u.tokens;
  };
  const durationsMs: any = { attempt: emptyDuration(), integration: emptyDuration(), verification: emptyDuration(), run: null };
  for (const d of Object.values(s.dispatches) as any[]) {
    const parts = d.usageParts || (d.usage ? { [d.mode === 'subagent' ? 'worker' : 'main']: d.usage } : null);
    if (parts) for (const [bucket, u] of Object.entries(parts)) add(bucket, u);
    if (d.phase === 'ended' && d.claimedAt && d.endedAt) addDuration(durationsMs.attempt, Date.parse(d.endedAt) - Date.parse(d.claimedAt));
  }
  const run = s.run || {};
  const integration = run.integrationDurations;
  if (integration && Number.isInteger(integration.count)) durationsMs.integration = { count: integration.count, totalMs: integration.totalMs, maxMs: integration.maxMs };
  for (const v of Array.isArray(run.verifications) ? run.verifications : []) addDuration(durationsMs.verification, v && v.durationMs);
  const endAt = run.completedAt || run.endedAt;
  if (run.createdAt && endAt) durationsMs.run = Date.parse(endAt) - Date.parse(run.createdAt);
  const peak = run.peak ? { workers: run.peak.workers || 0, worktrees: run.peak.worktrees || 0 } : liveCounts(s);
  return { tokens, durationsMs, peak };
}

/** IC-008 usage of a subagent dispatch with its parts: the worker's own tokens and its children's. */
function usageParts(d: any, workerRun: any, children: any[]) {
  const total = usageFor(d, workerRun, children);
  if (d.mode !== 'subagent') return { usage: total, parts: { main: total } };
  const own = usageFor(d, workerRun, []);
  const ownMeasured = Boolean(workerRun) && own.basis === 'measured';
  if (!ownMeasured || !children.length) return { usage: total, parts: { worker: total, child: { tokens: 0, basis: 'measured' } } };
  return { usage: total, parts: { worker: own, child: { tokens: total.tokens - own.tokens, basis: total.basis } } };
}

// ── the pass context ─────────────────────────────────────────────────────────────────────────────

/** One invocation's settings and per-pass scratch. */
function passFor(options: any) {
  const env: Env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const slug = options.slug;
  if (typeof slug !== 'string') throw usage('the dispatch loop needs --slug');
  const root = options.root ? path.resolve(options.root) : projectRoot(cwd);
  const file = storeFileFor(root, slug);
  const clock: () => Date = typeof options.now === 'function'
    ? () => { const at = options.now(); return at instanceof Date ? at : new Date(at); }
    : () => new Date();
  const ledgerFile = attempts.storeFile(root, slug);
  const roots = [...new Set([cwd, root])];
  const p: any = {
    env, cwd, slug, root, file, clock, ledgerFile, roots,
    stateRoot: path.join(root, '.doflow', 'state'),
    runStore: runStoreFileFor(root, slug),
    platform: options.platform || process.platform,
    by: options.by || LOOP_BY,
    descriptors: options.descriptors,
    registry: options.registry || null,
    coverage: options.coverage,
    evaluateImpl: options.evaluateImpl || evaluateEdit,
    verify: options.verify || runVerification,
    shouldStop: typeof options.shouldStop === 'function' ? options.shouldStop : () => false,
    actions: [] as any[],
    integrationMs: [] as number[],
    gaps: [] as any[],
    perform: null as any,
    startedAt: clock(),
    cache: {},
    errors: new Set<string>(),
  };
  p.ctx = () => ({ ledgerFile, roots, slug, env, cwd, fsImpl: fs, now: clock() });
  p.reg = () => {
    if (!p.registry) p.registry = loadRegistry({ repoRoot: REPO_ROOT });
    return p.registry;
  };
  p.act = (name: string, d: any, token: string, detail: any = null, ms = 0) => {
    p.actions.push({
      action: name, dispatchId: d && d.dispatchId ? d.dispatchId : null, task: d && d.task ? d.task : null,
      token: d && Number.isInteger(d.token) ? d.token : null,
      reason: detail === null || detail === undefined || detail === '' ? token : `${token}:${clipReason(detail)}`, ms,
    });
  };
  return p;
}

function readLedger(p: any) {
  return readTaskState(fs, p.ledgerFile) || { tasks: {}, runs: {} };
}

function control(ledger: any, runKey: string | null) {
  const run = ledger && ledger.runs && runKey && Object.hasOwn(ledger.runs, runKey) ? ledger.runs[runKey] : null;
  return run ? run.control : 'none';
}

/** One locked move of dispatch `id` from one of `phases`, `apply(dispatch, store)` changing it in
 * place; the peaks are raised in the same write. With `open`, the move is also refused while the run
 * holds a state no launch may start under (cancel-marked, `resume-required` or `completed`, IC-009,
 * IC-030), read inside the lock. `{ applied, dispatch, phase }`. */
function moveDispatch(p: any, id: string, phases: string[], apply: (d: any, s: any) => void, { open = false }: { open?: boolean } = {}) {
  return mutateDispatch(p.file, (s: any) => {
    const d = s.dispatches[id];
    if (!d || !phases.includes(d.phase)) return { write: false, result: { applied: false, phase: d ? d.phase : null } };
    if (open && (!s.run || HELD_RUN_STATES.includes(s.run.state))) return { write: false, result: { applied: false, phase: `run-${s.run ? s.run.state : 'missing'}` } };
    apply(d, s);
    bumpPeak(s);
    return { write: true, result: { applied: true, dispatch: structuredClone(d) } };
  });
}

/** Sets `cleanup` on a dispatch while absent (IC-006 add-only on an ended dispatch). */
function recordCleanup(p: any, id: string, cleanup: any) {
  return mutateDispatch(p.file, (s: any) => {
    const d = s.dispatches[id];
    if (!d || d.cleanup != null) return { write: false, result: false };
    d.cleanup = cleanup;
    return { write: true, result: true };
  });
}

/** The parts of a `cancelRun` result a dispatch keeps. */
function cancelSummary(result: any) {
  if (!result) return null;
  if (result.disposition !== 'cancelled') return { disposition: result.disposition, reason: result.reason ?? null, endState: result.endState ?? null, cleanup: result.cleanup ?? null };
  return { disposition: 'cancelled', endState: result.endState, cleanup: result.cleanup, attemptCancel: result.attemptCancel, attemptCancelled: result.attemptCancelled };
}

/** 081 `cancelRun` for a run of this slug, with the loop's own env and cwd; never throws for a
 * refusal. */
async function cancelWorker(p: any, runId: string, reason: string, source: 'user' | 'timeout' = 'user') {
  try {
    return await cancelRun({ file: p.runStore, runId, by: LOOP_BY, reason, source, env: p.env, cwd: p.cwd, platform: p.platform, now: p.clock });
  } catch (error: any) {
    return { disposition: 'error', reason: error && error.code ? error.code : 'cancel-threw' };
  }
}

/** The child runs a granter's spawn requests launched, read now. */
function childRunsOf(p: any, s: any, dispatchId: string) {
  const runs = readRuns(p.runStore);
  return (Object.values(s.spawnRequests) as any[])
    .filter((r) => r.granterDispatchId === dispatchId && r.childRunId && runs[r.childRunId])
    .map((r) => runs[r.childRunId]);
}

/** Cancels every child of `dispatchId` whose run has not ended (IC-023, IC-033) and records each. */
async function cancelChildren(p: any, dispatchId: string, reason: string) {
  const s = readDispatch(p.file);
  const runs = readRuns(p.runStore);
  for (const r of Object.values(s.spawnRequests) as any[]) {
    if (r.granterDispatchId !== dispatchId || r.state !== 'launched' || r.endState != null || !r.childRunId) continue;
    const run = runs[r.childRunId];
    if (run && run.phase !== 'ended') {
      const res = await cancelWorker(p, r.childRunId, reason);
      p.act('cleanup', { dispatchId, task: s.dispatches[dispatchId]?.task }, 'child-cancelled', `${r.requestId} ${res.disposition}`);
    }
  }
  settleChildren(p);
}

/** Records the end of every launched child run that has ended (endState, report, cleanup). */
function settleChildren(p: any) {
  const s = readDispatch(p.file);
  const runs = readRuns(p.runStore);
  const ended: Record<string, any> = {};
  for (const r of Object.values(s.spawnRequests) as any[]) {
    if (r.state !== 'launched' || r.endState != null || !r.childRunId) continue;
    const run = runs[r.childRunId];
    if (run && run.phase === 'ended') ended[r.requestId] = run;
  }
  if (!Object.keys(ended).length) return;
  mutateDispatch(p.file, (store: any) => {
    for (const [id, run] of Object.entries(ended) as [string, any][]) {
      const r = store.spawnRequests[id];
      if (!r || r.endState != null) continue;
      r.endState = run.end ? run.end.state : 'unknown';
      r.endedAt = run.end ? run.end.at : iso(p.clock());
      r.report = run.report ? { status: run.report.status ?? null, usage: run.report.usage ?? null } : null;
      r.cleanup = run.cleanup ?? null;
    }
    bumpPeak(store);
    return { write: true, result: null };
  });
}

// ── phase 1: reconcile (IC-009, IC-023 staleness, IC-021 deferred removals) ─────────────────────

/**
 * IC-023: ends a stale dispatch in one locked write (released when its attempt is still active,
 * the `epoch` case; else ended with no 080 call), then, outside the lock, ends a worker run that has
 * not ended through `cancelRun`, except in the `epoch` case, whose live worker runs on (FR-018).
 */
async function endStale(p: any, d: any, reason: string, workerRun: any) {
  const started = Date.now();
  const ended = mutateDispatch(p.file, (s: any) => {
    const cur = s.dispatches[d.dispatchId];
    if (!cur || cur.phase === 'ended' || cur.phase === 'integrating' || cur.phase === 'admitted') return { write: false, result: { ended: false } };
    const spent = usageFor(cur, workerRun, []);
    if (reason === 'epoch') {
      const end = releaseAttempt({ store: s, dispatchId: cur.dispatchId, reason: `stale:${reason}`, disposition: 'stale', usage: spent, ctx: p.ctx() });
      if (end.result.ended) cur.staleReason = reason;
      bumpPeak(s);
      return end;
    }
    Object.assign(cur, { phase: 'ended', disposition: 'stale', staleReason: reason, endedAt: iso(p.clock()), usage: spent });
    bumpPeak(s);
    return { write: true, result: { ended: true } };
  });
  p.act('stale', d, reason, ended.ended ? null : ended.reason || 'not-ended', Date.now() - started);
  if (!ended.ended) {
    if (ended.reason) p.errors.add(d.dispatchId);
    return ended;
  }
  if (reason !== 'epoch' && d.workerRunId) {
    const run = readRuns(p.runStore)[d.workerRunId];
    if (run && run.phase !== 'ended') {
      const res = await cancelWorker(p, d.workerRunId, `stale:${reason}`);
      recordCleanup(p, d.dispatchId, cancelSummary(res));
    }
  }
  if (d.workerRunId) await cancelChildren(p, d.dispatchId, `stale:${reason}`);
  return ended;
}

/**
 * DEC-047 / IC-021: the worker cleanup an `exited` 081 run shows, never assumed. `verified` only
 * from an observed group reading: the supervisor read the group gone (`process.groupAlive: false`)
 * or its escalation verified the leftover. On win32, with no reading, or with an `unknown` one, it is
 * `unknown`; leftover survivors are `survivors`.
 */
function exitedCleanup(run: any, platform: string) {
  const proc = (run && run.process) || {};
  const leftover = proc.leftover || null;
  if (leftover && leftover.status === 'survivors') return { status: 'survivors', reason: leftover.reason ?? 'group-survived' };
  if (platform === 'win32') return { status: 'unknown', reason: 'win32' };
  if (proc.groupAlive === false || (leftover && leftover.status === 'verified')) return { status: 'verified', reason: 'exited' };
  return { status: 'unknown', reason: proc.groupAlive === undefined ? 'group-unobserved' : 'group-liveness-unknown' };
}

/** IC-021: records the worker cleanup of each ended dispatch whose run's end now shows it, read per
 * dispatch and settled against the probe, as collect does (RT-7). */
function recordWorkerCleanups(p: any) {
  const s = readDispatch(p.file);
  const ledger = readLedger(p);
  for (const d of Object.values(s.dispatches) as any[]) {
    if (d.phase !== 'ended' || !d.attempt || !d.attempt.worktree || (d.removal && d.removal.verified)) continue;
    if (d.workerRunId && d.cleanup == null) {
      // A pass-wide snapshot read before a supervisor wrote its end and exited reads as lost.
      const { run, view } = settledStatus(p.runStore, d.workerRunId, ledger, { platform: p.platform, nowMs: p.clock().getTime() });
      const exited = view && run.phase === 'ended' && run.end && run.end.state === 'exited' ? exitedCleanup(run, p.platform) : null;
      if (view && run.phase === 'ended' && view.cleanup && view.cleanup.status === 'verified') {
        recordCleanup(p, d.dispatchId, { source: 'status', endState: view.state, cleanup: view.cleanup });
      } else if (exited && exited.status !== 'survivors') {
        recordCleanup(p, d.dispatchId, { source: 'status', endState: 'exited', cleanup: exited });
      } else if (view && view.state === 'unknown' && view.reason === 'process-lost') {
        recordCleanup(p, d.dispatchId, { source: 'status', endState: 'unknown', cleanup: { status: 'verified', reason: 'process-lost' } });
      }
    }
  }
}

/** IC-021: deferred removals of ended attempt and child worktrees. */
async function deferredRemovals(p: any) {
  recordWorkerCleanups(p);
  let s = readDispatch(p.file);
  for (const d of Object.values(s.dispatches) as any[]) {
    if (d.phase !== 'ended' || !d.attempt || !d.attempt.worktree) continue;
    if (!integrate.removalDue(d, s.run).due) continue;
    const started = Date.now();
    const removed = await integrate.removeDispatchWorktree({ root: p.root, slug: p.slug, dispatchId: d.dispatchId, env: p.env, storeFile: p.file });
    p.act('cleanup', d, removed.removed ? 'removed' : 'kept', removed.reason, Date.now() - started);
  }
  // Child worktrees follow their child run's end (IC-021).
  const manager = integrate.managerFor(p.root, p.slug, 'attempt', p.env);
  for (const r of Object.values(s.spawnRequests) as any[]) {
    if (!r.worktree || r.endState == null || (r.removal && r.removal.verified)) continue;
    const verified = r.endState === 'exited' || (r.cleanup && r.cleanup.status === 'verified');
    if (!verified) continue;
    const removal = manager.removeVerified(r.requestId);
    mutateDispatch(p.file, (store: any) => {
      const cur = store.spawnRequests[r.requestId];
      if (!cur) return { write: false, result: null };
      if (!cur.removal || (cur.removal.verified === false && removal.verified)) cur.removal = removal;
      return { write: true, result: null };
    });
    p.act('cleanup', { dispatchId: r.granterDispatchId }, removal.verified ? 'child-removed' : 'child-kept', r.requestId);
  }
}

async function reconcile(p: any) {
  const started = Date.now();
  const current = readDispatch(p.file);
  const ledger = readLedger(p);
  const runs = readRuns(p.runStore);
  for (const d of Object.values(current.dispatches) as any[]) {
    if (!['claimed', 'launched', 'collected'].includes(d.phase) || !Number.isInteger(d.token)) continue;
    const reason = integrate.staleReason(d, ledger, d.parentRunKey ?? current.run.runKey ?? null);
    if (reason) await endStale(p, d, reason, d.workerRunId ? runs[d.workerRunId] ?? null : null);
  }
  settleChildren(p);
  await deferredRemovals(p);
  p.act('reconcile', null, 'reconciled', null, Date.now() - started);
}

// ── phase 2: collect (IC-023, IC-024) ────────────────────────────────────────────────────────────

/** IC-024's signal for a withheld reason. */
function signalFor(reason: string, run: any): string {
  if (reason === 'not-exited') return run && run.process && run.process.kind === 'not-started' ? 'not-started' : 'not-exited';
  if (reason === 'read-only-violation' || reason === 'read-only-unverifiable') return 'isolation-unverifiable';
  return Object.hasOwn(SIGNALS, reason) ? reason : 'report-unparsed';
}

function outputPointers(run: any) {
  const o = run && run.output;
  if (!o) return null;
  const at = (x: any) => (x && typeof x === 'object' ? x.path ?? x.pointer ?? null : x ?? null);
  return { stdout: at(o.stdout), stderr: at(o.stderr) };
}

function blockersOf(run: any, withheld: string[]) {
  const denials = run && run.report && Array.isArray(run.report.denials) ? run.report.denials.map((x: any) => (x && x.action) || String(x)) : [];
  return [...denials, ...withheld].map((b) => Array.from(String(b)).slice(0, BLOCKER_CHARS).join('')).slice(0, BLOCKERS_MAX);
}

/** IC-011's result envelope for a subagent dispatch, written before its phase changes. */
function writeResult(p: any, d: any, run: any, { outcome, staleReason = null, failureClass = null, commit = null, usage: spent, withheld = [] }: any) {
  const value = buildResult({
    dispatchId: d.dispatchId, task: d.task, token: d.token, epoch: d.epoch, mode: d.mode, outcome, staleReason, failureClass,
    summary: run && run.report && run.report.summary ? String(run.report.summary) : '',
    status: run && run.report && run.report.status ? run.report.status : 'none',
    base: d.attempt ? d.attempt.base : null, commit: commit ? commit.commit : null, changes: commit ? commit.changes : [],
    files: p.filesOf ? p.filesOf(d.task) : [], evidence: [], blockers: blockersOf(run, withheld),
    usage: { tokens: spent.tokens, basis: spent.basis, source: run && run.report && run.report.usage ? 'worker' : 'reservation' },
    workerRun: run ? { id: run.runId, output: outputPointers(run) } : null,
    isolation: run && run.isolation ? { status: run.isolation.status, reasons: run.isolation.reason ? [run.isolation.reason] : (run.isolation.reasons || []) } : null,
  });
  const written = writeEnvelope({ stateRoot: p.stateRoot, dispatchId: d.dispatchId, kind: 'result', value });
  return { value, written };
}

/** Ends dispatch `d` by IC-024's class for `signal`, only while its phase is one of `phases` (read
 * inside the lock: a pass-wide snapshot can be older than another driver's lease); then, outside the
 * lock, `cancelRun` when the class asks for it, and the granter's children. */
async function failDispatch(p: any, d: any, phases: string[], signal: string, detail: any, run: any, parts: any, envelope: any = null) {
  const started = Date.now();
  const { failureClass, cancelRun: needCancel } = classFor(signal);
  const ended = mutateDispatch(p.file, (s: any) => {
    const cur = s.dispatches[d.dispatchId];
    if (!cur || !phases.includes(cur.phase)) return { write: false, result: { ended: false, reason: 'phase-not-allowed', phase: cur ? cur.phase : null } };
    if (parts) cur.usageParts = parts.parts;
    if (envelope) cur.envelopes = { ...(cur.envelopes || {}), result: envelope.pointer };
    const end = endAttempt({ store: s, dispatchId: cur.dispatchId, failureClass, detail, usage: parts ? parts.usage : undefined, ctx: p.ctx() });
    bumpPeak(s);
    return end;
  });
  p.act('finish', d, ended.ended ? `failed:${failureClass}` : `finish-refused:${failureClass}`, ended.ended ? detail : ended.reason, Date.now() - started);
  if (!ended.ended) {
    // A phase refusal wrote nothing and is no 080 error (no `lastError`).
    if (ended.reason !== 'phase-not-allowed') p.errors.add(d.dispatchId);
    return ended;
  }
  if (needCancel && d.workerRunId) {
    const live = readRuns(p.runStore)[d.workerRunId];
    if (live && live.phase !== 'ended') {
      const res = await cancelWorker(p, d.workerRunId, failureClass === 'timeout' ? `timeout after ${detail}` : `${failureClass}: ${detail ?? ''}`.trim(), failureClass === 'timeout' ? 'timeout' : 'user');
      recordCleanup(p, d.dispatchId, cancelSummary(res));
      p.act('cleanup', d, 'worker-cancelled', res.disposition);
    }
  }
  if (d.workerRunId) await cancelChildren(p, d.dispatchId, `granter-ended:${failureClass}`);
  return ended;
}

/** Releases an attempt whose attempt commit failed and blocks the run `integration-error` (IC-017). */
function releaseIntegrationError(p: any, d: any, error: any, parts: any) {
  mutateDispatch(p.file, (s: any) => {
    const cur = s.dispatches[d.dispatchId];
    if (!cur || cur.phase === 'ended') return { write: false, result: null };
    const end = releaseAttempt({ store: s, dispatchId: cur.dispatchId, reason: 'integration-error', usage: parts.usage, ctx: p.ctx() });
    setRunState(s, 'blocked');
    s.run.integrationGap = { task: cur.task, kind: 'integration-error', cause: 'no-progress', reason: error.reason || 'attempt-commit-failed', exitCode: error.exitCode ?? null, blocks: [] };
    return end;
  });
  p.act('release', d, 'integration-error', error.reason || error.message);
}

async function collect(p: any) {
  const current = readDispatch(p.file);
  const ledger = readLedger(p);
  for (const d of Object.values(current.dispatches) as any[]) {
    // A main-session submit of `failure` fails at its next collection (IC-005).
    if (d.phase === 'collected' && d.outcome === 'failed' && d.report && d.report.performer === 'main') {
      await failDispatch(p, d, ['collected'], 'submit-failure', 'submit --status failure', null, { usage: usageFor(d, null, []), parts: d.usageParts || { main: usageFor(d, null, []) } });
      continue;
    }
    if (d.phase !== 'launched' || d.mode !== 'subagent' || !d.workerRunId) continue;
    const started = Date.now();
    // Read per dispatch, after the earlier ones' git and cancels, and settled against the probe:
    // a pass-wide snapshot read before a supervisor wrote its end and exited reads as lost.
    const { run, view } = settledStatus(p.runStore, d.workerRunId, ledger, { platform: p.platform, nowMs: p.clock().getTime() });
    if (view && LIVE_WORKER_STATES.includes(view.state)) continue;
    if (!view || view.state === 'unknown') {
      const children = childRunsOf(p, current, d.dispatchId);
      await failDispatch(p, d, ['launched'], 'status-unknown', view ? view.reason : 'run-missing', run, usageParts(d, run, children));
      continue;
    }
    const stale = integrate.staleReason(d, ledger, d.parentRunKey ?? current.run.runKey ?? null);
    if (stale) {
      writeResult(p, d, run, { outcome: 'stale', staleReason: stale, usage: usageFor(d, run, []) });
      await endStale(p, d, stale, run);
      continue;
    }
    await cancelChildren(p, d.dispatchId, 'granter-collected');
    const children = childRunsOf(p, readDispatch(p.file), d.dispatchId);
    const parts = usageParts(d, run, children);
    const { resultOffered, withheld } = resultOfRun(run);
    if (!resultOffered) {
      const signal = signalFor(withheld[0], run);
      const { failureClass } = classFor(signal);
      const { written } = writeResult(p, d, run, { outcome: 'failed', failureClass, usage: parts.usage, withheld });
      await failDispatch(p, d, ['launched'], signal, withheld.join(', '), run, parts, written);
      continue;
    }
    let commit: any;
    try {
      commit = integrate.attemptCommit({ worktree: d.attempt.worktree, base: d.attempt.base, dispatchId: d.dispatchId, task: d.task, token: d.token, env: p.env });
    } catch (error: any) {
      if (!(error instanceof integrate.IntegrationError)) throw error;
      releaseIntegrationError(p, d, error, parts);
      continue;
    }
    const { value, written } = writeResult(p, d, run, { outcome: 'offered', commit, usage: parts.usage });
    const moved = moveDispatch(p, d.dispatchId, ['launched'], (x: any) => {
      Object.assign(x, {
        phase: 'collected', outcome: 'offered', collectedAt: iso(p.clock()), commit: commit.commit, changes: commit.changes,
        undeclared: value.undeclared, usage: parts.usage, usageParts: parts.parts,
        report: { status: run.report ? run.report.status : 'none', performer: 'worker' },
        envelopes: { ...(x.envelopes || {}), result: written.pointer },
      });
    });
    p.act('collect', d, moved.applied ? 'offered' : `moved:${moved.phase}`, commit.commit ? `${commit.changes.length} change(s)` : 'empty', Date.now() - started);
  }
}

// ── phase 3: integrate one (IC-017 to IC-020) ────────────────────────────────────────────────────

async function integrateOne(p: any) {
  const started = Date.now();
  const r = await integrate.integrateNext({
    root: p.root, slug: p.slug, ctx: p.ctx(), env: p.env, holder: { pid: p.driver.pid, start: p.driver.start ?? null },
    now: p.clock, storeFile: p.file, verify: p.verify,
  });
  const ms = Date.now() - started;
  if (!r || ['none', 'not-running'].includes(r.outcome)) return r;
  if (r.outcome === 'lease-held') {
    p.act('integrate', { dispatchId: r.dispatchId }, 'lease-held', null, ms);
    return r;
  }
  const d = { dispatchId: r.dispatchId, task: r.task, token: r.token };
  if (r.outcome !== 'stale') p.integrationMs.push(ms);
  p.act('integrate', d, r.outcome, r.reason ?? r.why ?? null, ms);
  if (r.verification) p.act('verify', d, r.verification.exitCode === 0 && !r.verification.timedOut ? 'passed' : 'failed', `evidence ${r.verification.evidenceId}`, r.verification.durationMs);
  if (r.undo && r.undo.ran) p.act('undo', d, r.undo.ok ? 'undone' : 'undo-failed', r.undo.reason);
  if (r.end) p.act(r.end.ended ? (r.end.disposition === 'completed' || r.end.disposition === 'failed' ? 'finish' : 'release') : 'error', d, r.end.disposition || r.end.outcome || 'ended', r.end.reason ?? null);
  if (r.outcome === 'lastError' || (r.end && r.end.ended === false)) p.errors.add(r.dispatchId);
  if (r.removal) p.act('cleanup', d, r.removal.removed ? 'removed' : 'kept', r.removal.reason);
  return r;
}

// ── phase 4: time out (IC-025) ───────────────────────────────────────────────────────────────────

async function timeouts(p: any) {
  const current = readDispatch(p.file);
  const nowMs = p.clock().getTime();
  const seconds = Number.isInteger(current.run.attemptSeconds) ? current.run.attemptSeconds : ATTEMPT_SECONDS_DEFAULT;
  const runs = readRuns(p.runStore);
  for (const d of Object.values(current.dispatches) as any[]) {
    if (d.phase !== 'launched' || d.mode !== 'subagent' || !d.deadline || Date.parse(d.deadline) > nowMs) continue;
    const run = runs[d.workerRunId] ?? null;
    const parts = usageParts(d, run, childRunsOf(p, current, d.dispatchId));
    p.act('timeout', d, 'deadline', `${seconds}s`);
    await failDispatch(p, d, ['launched'], 'deadline', `${seconds}s`, run, parts);
  }
}

// ── phase 5: launch children (IC-033 launch) ─────────────────────────────────────────────────────

async function launchChildren(p: any) {
  const current = readDispatch(p.file);
  const requested = (Object.values(current.spawnRequests) as any[]).filter((r) => r.state === 'requested');
  if (!requested.length) return;
  if (control(readLedger(p), current.run.runKey) !== 'running' || !['running', 'blocked'].includes(current.run.state)) return;
  const refuse = (requestId: string, reason: string) => mutateDispatch(p.file, (s: any) => {
    const r = s.spawnRequests[requestId];
    if (!r || r.state !== 'requested') return { write: false, result: false };
    r.state = 'refused';
    r.reason = reason;
    return { write: true, result: true };
  });
  for (const req of requested) {
    const started = Date.now();
    const granter = current.dispatches[req.granterDispatchId];
    const who = { dispatchId: req.granterDispatchId, task: granter ? granter.task : null, token: granter ? granter.token : null };
    if (!granter || granter.phase !== 'launched' || !granter.workerRunId) {
      refuse(req.requestId, 'granter-not-running');
      p.act('launch-child', who, 'refused', `${req.requestId} granter-not-running`, Date.now() - started);
      continue;
    }
    const n = Number(REQUEST_ID.exec(req.requestId)?.[2]);
    let wt: any;
    try {
      wt = integrate.createChildWorktree({ root: p.root, slug: p.slug, dispatchId: granter.dispatchId, n, base: granter.attempt.base, env: p.env });
    } catch (error: any) {
      refuse(req.requestId, `worktree-failed:${error && (error.status ?? error.code) ? String(error.status ?? error.code) : 'error'}`);
      p.act('launch-child', who, 'refused', `${req.requestId} worktree-failed`, Date.now() - started);
      continue;
    }
    const remaining = granter.deadline ? Math.max(1, Math.floor((Date.parse(granter.deadline) - p.clock().getTime()) / 1000)) : 1;
    let outcome: any;
    try {
      outcome = await executeWorkerCommand({
        action: 'run', slug: p.slug, harness: granter.harness, task: granter.task, token: granter.token,
        promptFile: path.join(p.stateRoot, req.prompt), timeoutSeconds: remaining,
        childOf: granter.workerRunId, request: req.requestId, execWorktree: wt.worktree,
        env: p.env, cwd: p.cwd, platform: p.platform, now: p.clock, descriptors: p.descriptors, registry: p.reg(), coverage: p.coverage,
      });
    } catch (error: any) {
      outcome = { exit: 2, body: { error: error && error.code ? error.code : 'launch-threw' } };
    }
    const body = outcome.body || {};
    if (outcome.exit === 0 && body.disposition === 'started') {
      const record = readRuns(p.runStore)[body.runId];
      const recorded = mutateDispatch(p.file, (s: any) => {
        const r = s.spawnRequests[req.requestId];
        if (!r || r.state !== 'requested') return { write: false, result: false };
        // Read inside the lock: a cancel or a lost driver since the pass's snapshot, or a granter that
        // ended, leaves the request and the run just started is cancelled below (IC-030, IC-033).
        const g = s.dispatches[req.granterDispatchId];
        if (!s.run || HELD_RUN_STATES.includes(s.run.state) || !g || g.phase !== 'launched') return { write: false, result: false };
        Object.assign(r, { state: 'launched', childRunId: body.runId, identity: record ? record.identity ?? null : null, launchedAt: iso(p.clock()), worktree: wt.worktree });
        bumpPeak(s);
        return { write: true, result: true };
      });
      if (!recorded) await cancelWorker(p, body.runId, 'request-moved');
      p.act('launch-child', who, recorded ? 'launched' : 'request-moved', `${req.requestId} ${body.runId}`, Date.now() - started);
    } else {
      const reason = body.reason || body.error || 'refused';
      refuse(req.requestId, reason);
      integrate.managerFor(p.root, p.slug, 'attempt', p.env).removeVerified(req.requestId);
      p.act('launch-child', who, 'refused', `${req.requestId} ${reason}`, Date.now() - started);
    }
  }
}

// ── phase 6: admit and launch (IC-007 launch, IC-010, IC-014, IC-022) ───────────────────────────

function hashFile(file: string): string | null {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

/** IC-010's deltas: what earlier integrations changed between the run base and the attempt base,
 * each change attributed to the dispatch whose integration introduced it. */
function deltasFor(p: any, s: any, d: any) {
  const runBase = s.run.integration.base;
  const attemptBase = d.attempt.base;
  let changes: any[] = [];
  if (runBase && attemptBase && runBase !== attemptBase && s.run.integration.worktree) {
    try { changes = integrate.diffNameStatus(runBase, attemptBase, { cwd: s.run.integration.worktree, env: p.env }); } catch { changes = []; }
  }
  const by = new Map<string, string>();
  const done = (Object.values(s.dispatches) as any[]).filter((x) => x.disposition === 'completed' && Array.isArray(x.changes))
    .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
  for (const x of done) for (const c of x.changes) by.set(c.path, x.dispatchId);
  return { runBase, attemptBase, changes: changes.map((c) => ({ path: c.path, change: c.change, dispatchId: by.get(c.path) ?? null })) };
}

function workerOf(p: any, harness: string | null) {
  if (!harness) return null;
  if (p.descriptors && Object.hasOwn(p.descriptors, harness)) return p.descriptors[harness];
  const h = p.reg().harnesses.find((x: any) => x.id === harness);
  return h ? h.worker : null;
}

/** IC-010 handoff for a claimed dispatch. */
function handoffFor(p: any, s: any, d: any, planTask: any, record: any) {
  const files: string[] = (planTask.files || []).map(String);
  const sources = [
    ...files.map((f) => ({ path: normalizeFile(f), sha256: hashFile(path.join(d.attempt.worktree, normalizeFile(f))) })),
    ...CHAIN_ARTIFACTS.map((rel) => {
      const repoRel = `agent-docs/doflow/${p.slug}/${rel}`;
      const found = p.roots.map((r: string) => hashFile(path.join(r, repoRel))).find((h: any) => h !== null) ?? null;
      return { path: repoRel, sha256: found };
    }),
  ];
  const subagent = d.mode === 'subagent';
  const worker = subagent ? workerOf(p, d.harness) : null;
  const grant = d.grant && d.grant.depth === 1 && d.grant.children > 0 ? d.grant : null;
  return buildHandoff({
    dispatchId: d.dispatchId, dispatchRunId: s.run.dispatchRunId, slug: p.slug, mode: d.mode,
    task: { id: planTask.id, phase: planTask.phase, owner: planTask.owner ?? null, text: planTask.description ?? '', files, dependsOn: planTask.taskDeps || [] },
    acceptance: planTask.acceptance || [],
    sources,
    deltas: deltasFor(p, s, d),
    budget: {
      reserveTokens: Number.isInteger(s.run.reserveTokens) ? s.run.reserveTokens : null,
      attemptSeconds: subagent ? (Number.isInteger(s.run.attemptSeconds) ? s.run.attemptSeconds : ATTEMPT_SECONDS_DEFAULT) : null,
      attempts: { used: record ? record.budget.used : 0, limit: record ? record.budget.limit : 0 },
    },
    grant: d.grant,
    worktree: { path: d.attempt.worktree, branch: d.attempt.branch, base: d.attempt.base },
    report: {
      parser: worker && worker.structuredOutput && worker.structuredOutput.parser ? worker.structuredOutput.parser : null,
      spawn: grant ? ['dispatch', '--action', 'spawn', '--slug', p.slug, '--prompt-file', '<path>', '--reserve-tokens', '<n>'] : null,
    },
  });
}

/** IC-005's perform yield for a launched main-session dispatch. */
function performYield(p: any, d: any) {
  const handoff = path.join(p.stateRoot, d.envelopes.handoff);
  let bytes: Buffer = Buffer.alloc(0);
  try { bytes = fs.readFileSync(handoff); } catch { /* reported by size 0 and a null digest */ }
  return {
    dispatchId: d.dispatchId, task: d.task, token: d.token, mode: d.mode,
    worktree: d.attempt.worktree, branch: d.attempt.branch, base: d.attempt.base,
    handoff: { path: handoff, bytes: bytes.length, sha256: bytes.length ? sha256(bytes) : null },
    submit: ['dispatch', '--action', 'submit', '--slug', p.slug, '--dispatch', d.dispatchId, '--status', '<success|failure>', '--summary', '<text>'],
  };
}

/** Launches one claimed dispatch outside every lock: the handoff, then a worker run or a perform. */
async function launch(p: any, admitted: any, plan: any, view: any) {
  const started = Date.now();
  const s = readDispatch(p.file);
  const d = s.dispatches[admitted.dispatchId];
  if (!d || d.phase !== 'claimed') return;
  const planTask = plan.graph.tasks.find((t: any) => t.id === d.task);
  const record = view.tasks.find((r: any) => r.id === d.task);
  const value = handoffFor(p, s, d, planTask, record);
  const handoff = writeEnvelope({ stateRoot: p.stateRoot, dispatchId: d.dispatchId, kind: 'handoff', value });
  const seconds = Number.isInteger(s.run.attemptSeconds) ? s.run.attemptSeconds : ATTEMPT_SECONDS_DEFAULT;

  if (MAIN_SESSION_MODES.includes(d.mode)) {
    const moved = moveDispatch(p, d.dispatchId, ['claimed'], (x: any) => {
      Object.assign(x, { phase: 'launched', launchedAt: iso(p.clock()), deadline: null, workerIdentity: null, envelopes: { handoff: handoff.pointer, result: null } });
    }, { open: true });
    p.act('launch', d, moved.applied ? `perform:${d.mode}` : `moved:${moved.phase}`, null, Date.now() - started);
    if (moved.applied && !p.perform) p.perform = performYield(p, moved.dispatch);
    return;
  }

  let outcome: any;
  try {
    outcome = await executeWorkerCommand({
      action: 'run', edit: true, slug: p.slug, harness: d.harness, task: d.task, token: d.token,
      promptFile: handoff.path, timeoutSeconds: seconds + BACKSTOP_SECONDS,
      env: p.env, cwd: p.cwd, platform: p.platform, now: p.clock, descriptors: p.descriptors, registry: p.reg(), coverage: p.coverage,
    });
  } catch (error: any) {
    outcome = { exit: 2, body: { error: error && error.code ? error.code : 'launch-threw' } };
  }
  const body = outcome.body || {};
  if (outcome.exit === 0 && body.disposition === 'started') {
    const run = readRuns(p.runStore)[body.runId];
    const launchedAt = p.clock();
    const moved = moveDispatch(p, d.dispatchId, ['claimed'], (x: any) => {
      Object.assign(x, {
        phase: 'launched', workerRunId: body.runId, launchedAt: iso(launchedAt),
        deadline: iso(new Date(launchedAt.getTime() + seconds * 1000)),
        workerIdentity: run && run.identity ? { ...run.identity } : null,
        envelopes: { handoff: handoff.pointer, result: null },
      });
    }, { open: true });
    if (!moved.applied) {
      // A cancel, take over or resume moved the dispatch or marked the run first: end the run just
      // started (IC-007, IC-030).
      const res = await cancelWorker(p, body.runId, 'dispatch-moved');
      recordCleanup(p, d.dispatchId, cancelSummary(res));
    }
    p.act('launch', d, moved.applied ? 'subagent' : `moved:${moved.phase}`, `${d.harness} ${body.runId}`, Date.now() - started);
    return;
  }
  const reason = body.reason || body.error || 'refused';
  mutateDispatch(p.file, (st: any) => {
    const cur = st.dispatches[d.dispatchId];
    if (cur && cur.phase === 'claimed') cur.envelopes = { handoff: handoff.pointer, result: null };
    return { write: true, result: null };
  });
  p.act('launch', d, 'refused', reason, Date.now() - started);
  await failDispatch(p, d, ['claimed'], 'run-refused', reason, null, null);
}

async function admitAndLaunch(p: any) {
  const current = readDispatch(p.file);
  const run = current.run;
  const modeFor = (task: string, { store: s }: any) => selectMode({
    policy: run.mode || 'auto', held: Boolean(run.held && Object.hasOwn(run.held, task)), lastFailureClass: lastFailure(s, task),
    harness: run.harness || null, needs: Array.isArray(run.needs) ? run.needs : [], descriptors: p.descriptors, registry: p.reg(),
    coverage: p.coverage, env: p.env, cwd: p.cwd, root: p.root, now: () => p.clock().getTime(), platform: p.platform,
    evaluateImpl: p.evaluateImpl, cache: p.cache,
  });
  const result = admit({
    root: p.root, slug: p.slug, ctx: p.ctx(), driver: p.driver, by: p.by, modeFor, env: p.env, now: p.clock, storeFile: p.file,
  });
  p.actions.push(...result.actions);
  for (const gap of result.gaps || []) p.gaps.push({ task: gap.task, kind: gap.reason, cause: 'budget', reason: gap.reason });
  for (const r of result.refused || []) {
    if (!BUDGET_REFUSALS.includes(r.reason)) p.gaps.push({ task: r.task, kind: 'claim-refused', cause: 'no-progress', reason: r.reason });
  }
  if (!result.admitted.length) return result;
  const plan = attempts.loadPlan({ roots: p.roots, slug: p.slug, fsImpl: fs });
  const view = attempts.inspect({ file: p.ledgerFile, fsImpl: fs, roots: p.roots, slug: p.slug, env: p.env, cwd: p.cwd });
  for (const a of result.admitted) {
    if (p.shouldStop()) break;
    await launch(p, a, plan, view);
  }
  return result;
}

// ── phase 7: decide (IC-026, IC-027) ─────────────────────────────────────────────────────────────

function heldIds(record: any): string[] {
  return [...(record.held || []).map((h: any) => (h && typeof h === 'object' ? h.id : h)), ...(record.unmet || [])].filter(Boolean);
}

/** IC-027's gaps from 080's task records, the store and this pass's admission. */
function gapsFor(p: any, s: any, view: any) {
  const gaps: any[] = [];
  const blocksOf = (id: string) => view.tasks.filter((r: any) => heldIds(r).includes(id)).map((r: any) => r.id);
  const have = new Set<string>();
  const push = (g: any) => {
    const key = `${g.task}\u0000${g.kind}`;
    if (have.has(key)) return;
    have.add(key);
    gaps.push({ task: g.task ?? null, kind: g.kind, cause: g.cause, reason: g.reason ?? g.kind, blocks: g.blocks ?? (g.task ? blocksOf(g.task) : []) });
  };
  if (!s.run.verify || !Array.isArray(s.run.verify.argv)) push({ task: null, kind: 'verification-undeclared', cause: 'input', blocks: view.tasks.map((r: any) => r.id) });
  if (s.run.integrationGap) push({ ...s.run.integrationGap, cause: s.run.integrationGap.cause || 'no-progress' });
  for (const id of p.errors) {
    const d = s.dispatches[id];
    if (d && d.phase !== 'ended' && d.lastError) push({ task: d.task, kind: 'ledger-error', cause: 'input', reason: d.lastError.reason });
  }
  for (const g of p.gaps) push(g);
  for (const r of view.tasks) {
    if (r.doneStale) { push({ task: r.id, kind: 'plan-changed', cause: 'input', reason: r.reason }); continue; }
    if (r.state === 'BLOCKED') {
      if (r.reason === 'budget') push({ task: r.id, kind: 'budget', cause: 'budget', reason: 'budget' });
      else {
        const cls = lastFailure(s, r.id);
        push({ task: r.id, kind: cls || r.reason, cause: cls === 'worker-denied' ? 'authorization' : 'no-progress', reason: cls ? `${cls}: repeated` : r.reason });
      }
    } else if (r.state === 'CANCELLED') push({ task: r.id, kind: 'cancelled', cause: 'no-progress', reason: 'cancelled until resume' });
    else if (r.state === 'PLANNED' && r.reason === 'dependency-held') push({ task: r.id, kind: 'dependency-held', cause: 'no-progress', reason: heldIds(r).join(', '), blocks: [] });
  }
  return gaps;
}

function completedTasks(s: any, view: any) {
  return view.tasks.filter((r: any) => r.state === 'SUCCEEDED').map((r: any) => {
    const d = (Object.values(s.dispatches) as any[]).filter((x) => x.task === r.id && x.disposition === 'completed').sort((a, b) => b.token - a.token)[0];
    return { task: r.id, token: d ? d.token : null, integratedCommit: d ? d.integratedCommit ?? null : null };
  });
}

function keptWorktrees(s: any): string[] {
  const kept = (Object.values(s.dispatches) as any[]).filter((d) => d.phase === 'ended' && d.attempt && d.attempt.worktree && !(d.removal && d.removal.verified) && fs.existsSync(d.attempt.worktree)).map((d) => d.attempt.worktree);
  const children = (Object.values(s.spawnRequests) as any[]).filter((r) => r.worktree && !(r.removal && r.removal.verified) && fs.existsSync(r.worktree)).map((r) => r.worktree);
  return [...kept, ...children];
}

function blockedReport(s: any, view: any, gaps: any[]) {
  const cause = CAUSE_ORDER.find((c) => gaps.some((g) => g.cause === c)) || 'no-progress';
  return {
    cause,
    completed: completedTasks(s, view),
    integrated: (Object.values(s.dispatches) as any[]).filter((d) => d.disposition === 'completed' && d.integratedCommit)
      .map((d) => ({ dispatchId: d.dispatchId, task: d.task, commit: d.integratedCommit, changes: Array.isArray(d.changes) ? d.changes.length : 0 })),
    gaps,
    keptWorktrees: keptWorktrees(s),
  };
}

/**
 * Inside a locked write: runs `settle(st)`, which moves the run's state, unless the run holds a
 * state another writer owns (`cancelling` or `cancelled` from a cancel, IC-030 step 3;
 * `resume-required` from a lost driver, IC-009; `completed`), in which case nothing is moved and the
 * held state is returned. `decide` read the store outside the lock, so a cancel or a lost driver can
 * land between that read and this write; without this check the pass would overwrite it with
 * `completed` or `blocked`.
 */
function unlessCancelled(st: any, settle: (st: any) => void): string | null {
  if (HELD_RUN_STATES.includes(st.run.state)) return st.run.state;
  settle(st);
  return null;
}

/** The pass outcome for a run in a held state, as `decide` reports one (IC-003). */
const cancelledOutcome = (state: string) => (state === 'cancelling' ? 'continue' : state);
/** The decide action's reason token for a held state: `cancelled` for a cancel's, else the state. */
const heldAction = (state: string) => (CANCEL_MARKED.includes(state) ? 'cancelled' : state);

/**
 * The pass's last locked write: run state and records, durations, peaks and the step record. An
 * `apply` that returns a cancel-marked state (from `unlessCancelled`) changed no run state; the pass
 * then records and returns the cancelled outcome instead of `outcome`, without `extra`.
 */
function finishPass(p: any, outcome: string, apply: ((s: any) => string | null | void) | null = null, extra: any = {}) {
  const at = p.clock();
  let landed = outcome;
  const written = mutateDispatch(p.file, (s: any) => {
    if (!s.run) return { write: false, result: null };
    const marked = apply ? apply(s) : null;
    if (typeof marked === 'string') {
      landed = cancelledOutcome(marked);
      p.act('decide', null, heldAction(marked), marked);
    }
    if (p.integrationMs.length) {
      const d = s.run.integrationDurations && Number.isInteger(s.run.integrationDurations.count) ? s.run.integrationDurations : emptyDuration();
      for (const ms of p.integrationMs) addDuration(d, ms);
      s.run.integrationDurations = d;
    }
    bumpPeak(s);
    s.run.measurement = measurement(s);
    const last = s.steps.length ? s.steps[s.steps.length - 1].step : 0;
    const step = (Number.isInteger(last) ? last : 0) + 1;
    s.steps.push({ step, at: iso(at), driver: { pid: p.driver.pid, start: p.driver.start ?? null }, outcome: landed, actions: p.actions });
    return { write: true, result: { step, dispatchRunId: s.run.dispatchRunId, measurement: structuredClone(s.run.measurement) } };
  });
  return {
    disposition: 'stepped', dispatchRunId: written ? written.dispatchRunId : null, step: written ? written.step : null, outcome: landed,
    actions: p.actions, ...(landed === outcome ? extra : {}), measurement: written ? written.measurement : null,
  };
}

/** IC-026 step 5 and the completion write; IC-021 then removes kept failed-attempt worktrees. */
async function complete(p: any, s: any, view: any, decideStarted: number) {
  const run = s.run;
  const started = Date.now();
  const verification = await p.verify({
    root: p.root, slug: p.slug, taskId: p.slug, worktree: run.integration.worktree, argv: run.verify.argv,
    argvSha256: run.verify.argvSha256 ?? null, seconds: run.verify.timeoutSeconds, env: p.env,
    onSpawn: (proc: any) => mutateDispatch(p.file, (st: any) => { st.run.verifying = proc; return { write: true, result: null }; }),
  });
  const passed = verification.exitCode === 0 && verification.timedOut === false;
  p.act('verify', null, passed ? 'final-passed' : 'final-failed', `evidence ${verification.evidenceId}`, Date.now() - started);
  const record = (st: any) => {
    st.run.verifying = null;
    st.run.verifications = [...(Array.isArray(st.run.verifications) ? st.run.verifications : []), verification];
  };
  if (!passed) {
    const gaps = [{ task: null, kind: 'final-verification-failed', cause: 'no-progress', reason: `evidence ${verification.evidenceId}`, blocks: [], evidenceId: verification.evidenceId }];
    const report = blockedReport(s, view, gaps);
    p.act('decide', null, 'blocked', 'final-verification-failed', Date.now() - decideStarted);
    return finishPass(p, 'blocked', (st: any) => {
      record(st);
      return unlessCancelled(st, (x: any) => { setRunState(x, 'blocked'); x.run.blockedReport = report; });
    }, { blocked: report });
  }
  const completedAt = iso(p.clock());
  const completion: any = {
    completedAt,
    integration: { worktree: run.integration.worktree, branch: run.integration.branch, base: run.integration.base, head: run.integration.head },
    finalVerification: verification,
    tasks: completedTasks(s, view).map((t: any) => ({ id: t.task, token: t.token, integratedCommit: t.integratedCommit })),
    removals: { verified: 0, kept: [] },
  };
  // A cancel that marked the run during the final verification wins: the run is not completed.
  const marked = mutateDispatch(p.file, (st: any) => {
    record(st);
    const halted = unlessCancelled(st, (x: any) => { setRunState(x, 'completed'); Object.assign(x.run, { completedAt, completion, blockedReport: null }); });
    return { write: true, result: halted };
  });
  if (marked) {
    p.act('decide', null, heldAction(marked), marked, Date.now() - decideStarted);
    return finishPass(p, cancelledOutcome(marked));
  }
  // The worker cleanup of a dispatch integrated this pass is read before its removal is due (IC-021).
  recordWorkerCleanups(p);
  const after = readDispatch(p.file);
  let verified = 0;
  for (const d of Object.values(after.dispatches) as any[]) {
    if (d.phase !== 'ended' || !d.attempt || !d.attempt.worktree) continue;
    if (d.removal && d.removal.verified) { verified += 1; continue; }
    if (!integrate.removalDue(d, after.run).due) continue;
    const removed = await integrate.removeDispatchWorktree({ root: p.root, slug: p.slug, dispatchId: d.dispatchId, env: p.env, storeFile: p.file });
    if (removed.removed) verified += 1;
    p.act('cleanup', d, removed.removed ? 'removed' : 'kept', removed.reason);
  }
  const kept = keptWorktrees(readDispatch(p.file));
  completion.removals = { verified, kept };
  p.act('decide', null, 'completed', 'every task SUCCEEDED', Date.now() - decideStarted);
  return finishPass(p, 'completed', (st: any) => { st.run.completion.removals = completion.removals; }, { completion });
}

async function decide(p: any) {
  const started = Date.now();
  const s = readDispatch(p.file);
  const run = s.run;
  const view = attempts.inspect({ file: p.ledgerFile, fsImpl: fs, roots: p.roots, slug: p.slug, env: p.env, cwd: p.cwd });
  const nonEnded = (Object.values(s.dispatches) as any[]).filter((d) => d.phase !== 'ended');
  const pending = (Object.values(s.spawnRequests) as any[]).filter((r) => r.state === 'requested' || (r.state === 'launched' && r.endState == null));
  const extra = (outcome: string, reason: string) => p.act('decide', null, outcome, reason, Date.now() - started);

  if (run.state === 'resume-required') { extra('resume-required', run.resumeReason); return finishPass(p, 'resume-required'); }
  if (CANCEL_MARKED.includes(run.state)) { extra('cancelled', run.state); return finishPass(p, cancelledOutcome(run.state)); }

  // An integration gap blocks the run until a pass integrates again (IC-018).
  if (run.state === 'blocked' && run.integrationGap) {
    const report = blockedReport(s, view, gapsFor(p, s, view));
    extra('blocked', run.integrationGap.kind);
    return finishPass(p, 'blocked', (st: any) => unlessCancelled(st, (x: any) => { x.run.blockedReport = report; }), { blocked: report });
  }
  const verificationDeclared = Boolean(run.verify && Array.isArray(run.verify.argv));
  const ledgerErrors = [...p.errors].some((id) => s.dispatches[id] && s.dispatches[id].phase !== 'ended' && s.dispatches[id].lastError);

  if (verificationDeclared && !ledgerErrors) {
    // A main-session dispatch awaiting its submit is yielded again (IC-005).
    if (!p.perform) {
      const waiting = nonEnded.find((d) => MAIN_SESSION_MODES.includes(d.mode) && d.phase === 'launched');
      if (waiting) p.perform = performYield(p, waiting);
    }
    if (p.perform) { extra('perform', p.perform.dispatchId); return finishPass(p, 'perform', null, { perform: p.perform }); }
    if (nonEnded.length || s.lease || pending.length) { extra('continue', `${nonEnded.length} active`); return finishPass(p, 'continue'); }
    if (view.run.control === 'paused') { extra('paused', '080 run paused'); return finishPass(p, 'paused'); }
  }

  const gaps = gapsFor(p, s, view);
  const allDone = view.tasks.every((r: any) => r.state === 'SUCCEEDED' && !r.doneStale);
  if (verificationDeclared && !ledgerErrors && allDone && gaps.length === 0) {
    return complete(p, s, view, started);
  }
  // A task that can still be admitted keeps the run going (IC-027).
  const gapTasks = new Set(gaps.map((g) => g.task).filter(Boolean));
  const admissible = verificationDeclared && !ledgerErrors && view.tasks.some((r: any) => (r.state === 'READY' || (r.state === 'FAILED' && r.claimable === true)) && !gapTasks.has(r.id));
  if (admissible && !nonEnded.length) { extra('continue', 'admissible'); return finishPass(p, 'continue'); }
  if (!gaps.length) gaps.push({ task: null, kind: 'no-progress', cause: 'no-progress', reason: 'no task can progress', blocks: [] });
  const report = blockedReport(s, view, gaps);
  extra('blocked', report.cause);
  return finishPass(p, 'blocked', (st: any) => unlessCancelled(st, (x: any) => { setRunState(x, 'blocked'); x.run.blockedReport = report; }), { blocked: report });
}

// ── step and run (IC-003, IC-004) ────────────────────────────────────────────────────────────────

/** A `blocked` run is not terminal: it runs again unless an integration gap holds it (IC-027). */
function reopen(p: any) {
  mutateDispatch(p.file, (s: any) => {
    if (!s.run || s.run.state !== 'blocked' || s.run.integrationGap) return { write: false, result: null };
    setRunState(s, 'running');
    return { write: true, result: null };
  });
}

async function runPass(p: any) {
  const stopped = () => {
    if (!p.shouldStop()) return null;
    p.act('decide', null, 'interrupted', null);
    return finishPass(p, 'continue', null, { interrupted: true });
  };
  await reconcile(p);
  let current = readDispatch(p.file);
  if (current.run.state === 'resume-required') {
    p.act('decide', null, 'resume-required', current.run.resumeReason);
    return finishPass(p, 'resume-required');
  }
  if (['completed', 'cancelled'].includes(current.run.state)) return finishPass(p, current.run.state);
  p.filesOf = (() => {
    const view = attempts.inspect({ file: p.ledgerFile, fsImpl: fs, roots: p.roots, slug: p.slug, env: p.env, cwd: p.cwd });
    const map = new Map<string, string[]>(view.graph.tasks.map((t: any) => [t.id, t.files || []]));
    return (task: string) => map.get(task) || [];
  })();
  const phases: Array<(p: any) => Promise<any>> = [
    collect,
    integrateOne,
    timeouts,
    launchChildren,
    async (q: any) => { reopen(q); return admitAndLaunch(q); },
  ];
  for (const phase of phases) {
    const halt = stopped();
    if (halt) return halt;
    current = readDispatch(p.file);
    if (current.run.state === 'resume-required') break;
    await phase(p);
  }
  const halt = stopped();
  if (halt) return halt;
  return decide(p);
}

/**
 * IC-003: one bounded pass. Options: `slug`, `env`, `cwd` (the run's own worktree), `by`, `now`,
 * `platform`; `driver` when `run` registered one; `descriptors`, `registry`, `coverage` and
 * `evaluateImpl` for tests (081's in-process seams; the real registry otherwise); `shouldStop`, a
 * callback read between phases. Returns IC-003's StepResult, or IC-001's identity refusal.
 */
async function step(options: any = {}) {
  const p = passFor(options);
  const caller = checkCaller({ env: p.env, cwd: p.cwd, file: p.file });
  if (caller.refusal) return caller.refusal;
  const run = caller.store.run;
  if (['completed', 'cancelled'].includes(run.state)) {
    return { disposition: 'stepped', dispatchRunId: run.dispatchRunId, step: null, outcome: run.state, actions: [], measurement: measurement(caller.store) };
  }
  let own: any = null;
  if (options.driver) p.driver = options.driver;
  else {
    own = registerDriver({ file: p.file, now: p.clock() });
    p.driver = own.driver;
  }
  let threw = false;
  try {
    return await runPass(p);
  } catch (error) {
    // A pass that threw left claimed or leased state no later pass settles (RT-5): its driver end
    // records `threw` and makes the run `resume-required` in one write (IC-009, IC-032).
    threw = true;
    throw error;
  } finally {
    if (own) endDriver({ file: p.file, driver: own.driver, now: p.clock(), endReason: threw ? 'threw' : null });
  }
}

/** A pass that did nothing but reconcile (and admission skips), so `run` waits before the next. */
function idle(result: any): boolean {
  const waiting = (a: any) => ['reconcile', 'decide'].includes(a.action)
    || (a.action === 'admit' && String(a.reason).startsWith('skipped:'))
    || (a.action === 'integrate' && a.reason === 'lease-held')
    || (a.action === 'cleanup' && /^(kept|child-kept)/.test(String(a.reason)));
  return result.actions.every(waiting);
}

/**
 * IC-004: registers one driver and repeats `step` until its outcome is `completed`, `blocked`,
 * `cancelled`, `resume-required`, `perform` or `paused`, or `maxSeconds` (default 600) passes, which
 * returns `continue` with `timeUp: true`. On SIGINT or SIGTERM the phase in progress finishes, the
 * driver end is written and the result carries `signal` and `exit` (130 or 143) for the command to
 * exit with; no further phase starts. `sleep` is a seam for the 500 ms idle wait.
 */
async function run(options: any = {}) {
  const maxSeconds = options.maxSeconds === undefined || options.maxSeconds === null ? RUN_MAX_SECONDS_DEFAULT : Number(options.maxSeconds);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > RUN_MAX_SECONDS_LIMIT) throw usage(`--max-seconds expects 1 to ${RUN_MAX_SECONDS_LIMIT}, got '${options.maxSeconds}'`);
  const sleep = options.sleep || defaultSleep;
  const p = passFor(options);
  const caller = checkCaller({ env: p.env, cwd: p.cwd, file: p.file });
  if (caller.refusal) return caller.refusal;
  const startedMs = Date.now();
  let signal: string | null = null;
  const handlers: Record<string, () => void> = {};
  for (const name of Object.keys(SIGNAL_EXITS)) {
    handlers[name] = () => { if (!signal) signal = name; };
    process.on(name as any, handlers[name]);
  }
  const reg = registerDriver({ file: p.file, now: p.clock() });
  let steps = 0;
  let last: any = null;
  let timeUp = false;
  let threw = false;
  try {
    for (;;) {
      last = await step({ ...options, driver: reg.driver, shouldStop: () => signal !== null });
      steps += 1;
      if (last.disposition !== 'stepped' || signal || RUN_STOPS.includes(last.outcome)) break;
      if (Date.now() - startedMs >= maxSeconds * 1000) { timeUp = true; break; }
      if (idle(last)) await sleep(IDLE_WAIT_MS);
      if (signal) break;
      if (Date.now() - startedMs >= maxSeconds * 1000) { timeUp = true; break; }
    }
  } catch (error) {
    threw = true;
    throw error;
  } finally {
    for (const [name, handler] of Object.entries(handlers)) process.removeListener(name as any, handler);
    endDriver({ file: p.file, driver: reg.driver, now: p.clock(), endReason: threw ? 'threw' : null });
  }
  if (last && last.disposition !== 'stepped') return last;
  const result: any = { disposition: 'ran', dispatchRunId: last.dispatchRunId, steps, outcome: last.outcome, timeUp, elapsedMs: Date.now() - startedMs, last };
  if (signal) Object.assign(result, { signal, exit: SIGNAL_EXITS[signal] });
  return result;
}

// ── submit (IC-005) ──────────────────────────────────────────────────────────────────────────────

const WHOLE = /^[0-9]+$/;

/**
 * IC-005: a main-session attempt's result. Options: `slug`, `dispatchId`, `status` (`success` or
 * `failure`), `summary`, `blockers`, `tokens` with `tokensBasis`, `env`, `cwd`, `now`. Flag errors
 * throw `usage`; refusals return `{ disposition: 'refused' | 'stale', reason, ... }`.
 */
async function submit(options: any = {}) {
  const { dispatchId, status, summary } = options;
  if (typeof dispatchId !== 'string' || !DISPATCH_ID.test(dispatchId)) throw usage(`--dispatch expects 'd-' plus 12 hex characters, got '${dispatchId}'`);
  if (status !== 'success' && status !== 'failure') throw usage('--status expects success or failure');
  if (typeof summary !== 'string' || !summary.length || Buffer.byteLength(summary, 'utf8') > SUMMARY_BYTES) throw usage(`--summary expects 1 to ${SUMMARY_BYTES} bytes`);
  const blockers = options.blockers === undefined || options.blockers === null ? [] : [].concat(options.blockers).map(String);
  if (blockers.length > BLOCKERS_MAX || blockers.some((b) => !b.length || Array.from(b).length > BLOCKER_CHARS)) throw usage(`--blocker is repeatable up to ${BLOCKERS_MAX}, each 1 to ${BLOCKER_CHARS} characters`);
  const hasTokens = options.tokens !== undefined && options.tokens !== null;
  const hasBasis = options.tokensBasis !== undefined && options.tokensBasis !== null;
  if (hasTokens !== hasBasis) throw usage('--tokens and --tokens-basis go together or not at all');
  if (hasTokens && (!WHOLE.test(String(options.tokens)) || !BASES.includes(options.tokensBasis))) throw usage('--tokens expects a whole number and --tokens-basis measured or estimated');

  const p = passFor(options);
  const caller = checkCaller({ env: p.env, cwd: p.cwd, file: p.file });
  if (caller.refusal) return caller.refusal;
  const d = caller.store.dispatches[dispatchId];
  if (!d) return refused('unknown-dispatch', { dispatchId });
  if (!MAIN_SESSION_MODES.includes(d.mode)) return refused('not-main-session', { dispatchId, mode: d.mode });
  if (d.phase !== 'launched') return refused('dispatch-not-awaiting', { dispatchId, phase: d.phase });

  const reg = registerDriver({ file: p.file, now: p.clock() });
  p.driver = reg.driver;
  try {
    const ledger = readLedger(p);
    const stale = integrate.staleReason(d, ledger, d.parentRunKey ?? caller.store.run.runKey ?? null);
    if (stale) {
      await endStale(p, d, stale, null);
      return { disposition: 'stale', reason: stale, dispatchId, task: d.task, token: d.token };
    }
    let commit: any;
    try {
      commit = integrate.attemptCommit({ worktree: d.attempt.worktree, base: d.attempt.base, dispatchId, task: d.task, token: d.token, env: p.env });
    } catch (error: any) {
      if (!(error instanceof integrate.IntegrationError)) throw error;
      return refused('attempt-commit-failed', { dispatchId, error: error.reason, exitCode: error.exitCode });
    }
    const spent = hasTokens ? { tokens: Number(options.tokens), basis: options.tokensBasis } : usageFor({ ...d, usage: null }, null, []);
    const masked = cutUtf8(maskBody(summary).text, SUMMARY_KEPT_BYTES);
    const maskedBlockers = blockers.map((b: string) => maskLine(b).text);
    const files = (() => {
      const view = attempts.inspect({ file: p.ledgerFile, fsImpl: fs, roots: p.roots, slug: p.slug, env: p.env, cwd: p.cwd });
      const task = view.graph.tasks.find((t: any) => t.id === d.task);
      return task ? task.files || [] : [];
    })();
    const value = buildResult({
      dispatchId, task: d.task, token: d.token, epoch: d.epoch, mode: d.mode,
      outcome: status === 'success' ? 'offered' : 'failed', failureClass: status === 'success' ? null : 'worker-failure',
      summary: masked, status, base: d.attempt.base, commit: commit.commit, changes: commit.changes, files, evidence: [],
      blockers: maskedBlockers, usage: { ...spent, source: hasTokens ? 'main' : 'reservation' }, workerRun: null, isolation: null,
    });
    const written = writeEnvelope({ stateRoot: p.stateRoot, dispatchId, kind: 'result', value });
    const moved = moveDispatch(p, dispatchId, ['launched'], (x: any) => {
      Object.assign(x, {
        phase: 'collected', outcome: status === 'success' ? 'offered' : 'failed', collectedAt: iso(p.clock()),
        report: { status, performer: 'main' }, usage: spent, usageParts: { main: spent },
        commit: commit.commit, changes: commit.changes, undeclared: value.undeclared,
        envelopes: { ...(x.envelopes || {}), result: written.pointer },
      });
    });
    if (!moved.applied) return refused('dispatch-not-awaiting', { dispatchId, phase: moved.phase });
    return {
      disposition: 'submitted', dispatchId, task: d.task, token: d.token, phase: 'collected',
      changes: commit.changes, undeclared: value.undeclared, result: { path: written.path },
    };
  } finally {
    endDriver({ file: p.file, driver: reg.driver, now: p.clock() });
  }
}

module.exports = {
  step,
  run,
  submit,
  selectMode,
  staticGate,
  evaluateHarnesses,
  checkCaller,
  measurement,
  exitedCleanup,
  OUTCOMES,
  RUN_STOPS,
  IDLE_WAIT_MS,
  BACKSTOP_SECONDS,
  ATTEMPT_SECONDS_DEFAULT,
  RUN_MAX_SECONDS_DEFAULT,
  SIGNAL_EXITS,
  LOOP_BY,
};
