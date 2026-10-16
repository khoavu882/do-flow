'use strict';

// Feature 082 C.1 (IC-007, IC-008 reservation, IC-009 drivers; DEC-002, DEC-003, DEC-018, DEC-019,
// DEC-033, DEC-038, DEC-040, DEC-047, DEC-059): two-section admission, reservations and drivers.
//
// Drivers (IC-009). Each invocation registers `{ pid, start, registeredAt }` in one locked write.
// Before it, outside the lock because `ps` is a process, every other driver with no `endedAt` and
// not yet marked lost is read with `alive`; the write applies those readings to the drivers it read
// only. `false` is lost `driver-lost`, `unknown` is lost `driver-liveness-unknown` (DEC-040), and a
// lost driver sets the run `resume-required` with that reason. Drivers are read, never signalled
// (DEC-047): nothing here sends a signal.
//
// Admission (IC-007). Outside every lock: 080 `inspect`, the 081 status of each prior dispatch's
// worker run, and the caller's `modeFor` per candidate (IC-022 lives with the loop, so admission
// never requires `loop.ts`). First section, one `mutateDispatch`: IC-007 steps 1 to 8, overlap from
// task-graph's exported `overlaps` (DEC-059) checked against every non-ended dispatch, not only the
// candidates of this pass (DEC-003, DEC-033). Then each admitted worktree is created outside the
// lock, and the second section, one `mutateDispatch` per dispatch, re-checks the slot and makes the
// in-process 080 `claim` with `reserveTokens` (IC-008), `execWorktree`, `epoch` and `owner`. A
// refusal or a throw drops the slot in the same write; `removeVerified` runs outside the lock. A
// budget refusal is a gap with cause `budget` (IC-027).
//
// Every write goes through `store.ts` (`updateTaskState`); this module makes no fs write call.
// Every function is synchronous, so a barrier race worker can call it directly.

const fs = require('node:fs');
const { inspect, claim } = require('../task-attempts.ts');
const { overlaps } = require('../task-graph.ts');
const { normalizeFile } = require('./envelope.ts');
const { readTaskState } = require('../task-state.ts');
const { procStart, alive } = require('../worker/process-tree.ts');
const { storeFileFor: runStoreFileFor, readRuns } = require('../worker/run-store.ts');
const { statusView } = require('../worker/command.ts');
const { storeFileFor, readDispatch, mutateDispatch, newDispatchId, setRunState, DispatchStoreError } = require('./store.ts');
const { managerFor, createAttemptWorktree } = require('./integrate.ts');
const { copyGrant } = require('./grants.ts');

/** DEC-002: concurrency bounds and default. */
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 4;
const CONCURRENCY_DEFAULT = 2;
/** IC-022's main-session modes: at most one such dispatch is non-ended (IC-007 step 7). */
const MAIN_SESSION_MODES = Object.freeze(['sequential', 'manual']);
const MODES = Object.freeze(['subagent', 'sequential', 'manual']);
/** 080 claim refusals that are a gap with cause `budget` (IC-007, IC-027). */
const BUDGET_REFUSALS = Object.freeze(['aggregate-exhausted', 'budget-exhausted', 'reservation-required']);
/** IC-009 lost reasons, by `alive` reading. */
const LOST_REASONS = Object.freeze({ false: 'driver-lost', unknown: 'driver-liveness-unknown' });
/** 081 statuses that mean a worker run is not gone (IC-007 step 8). */
const LIVE_WORKER_STATES = Object.freeze(['starting', 'running']);
const REASON_CHARS = 200;

type Env = Record<string, string | undefined>;

function usage(message: string) {
  return new DispatchStoreError('usage', message);
}

const sameDriver = (a: any, b: any) => !!a && !!b && a.pid === b.pid && (a.start ?? null) === (b.start ?? null)
  && (a.registeredAt ?? null) === (b.registeredAt ?? null);

const clip = (text: any) => String(text ?? '').slice(0, REASON_CHARS);

/** One StepAction (IC-003). */
function action(name: string, d: { dispatchId?: string | null; task?: string | null; token?: number | null }, reason: string, ms = 0) {
  return { action: name, dispatchId: d.dispatchId ?? null, task: d.task ?? null, token: d.token ?? null, reason: clip(reason), ms };
}

// ── drivers (IC-009) ─────────────────────────────────────────────────────────────────────────────

/**
 * IC-009: registers this invocation's driver. Every other driver with no `endedAt` and no `lost`
 * is read with `alive` outside the lock; the locked write marks each one read `false` or
 * `unknown` lost (`lost` its reason) and sets the run `resume-required` with `resumeReason`.
 * A driver registered after the read is left for the next reading. `aliveImpl` and `startImpl` are
 * seams for an injected reading. Returns `{ driver, lost: [{ pid, start, reason }], state }`.
 */
function registerDriver({
  file, pid = process.pid, now = new Date(), aliveImpl = alive, startImpl = procStart, fsImpl = fs,
}: any) {
  if (typeof file !== 'string') throw usage('registerDriver needs the dispatch store file');
  if (!Number.isInteger(pid) || pid <= 0) throw usage(`driver pid '${pid}' is not a positive whole number`);
  const driver = { pid, start: startImpl(pid) ?? null, registeredAt: now.toISOString(), endedAt: null };

  // Outside the lock: the readings, `ps` being a process.
  const before = readDispatch(file, fsImpl);
  const readings = (before.drivers as any[])
    .filter((d) => d && !d.endedAt && !d.lost)
    .map((d) => ({ driver: { pid: d.pid, start: d.start ?? null, registeredAt: d.registeredAt ?? null }, live: aliveImpl({ pid: d.pid, pgid: d.pid, start: d.start ?? null }) }));

  return mutateDispatch(file, (store: any) => {
    const lost: any[] = [];
    for (const { driver: read, live } of readings) {
      if (live === true) continue;
      const reason = live === false ? LOST_REASONS.false : LOST_REASONS.unknown;
      const stored = (store.drivers as any[]).find((d) => sameDriver(d, read));
      if (!stored || stored.endedAt || stored.lost) continue;
      stored.lost = reason;
      lost.push({ pid: stored.pid, start: stored.start ?? null, reason });
    }
    store.drivers.push(driver);
    if (lost.length && store.run && setRunState(store, 'resume-required')) store.run.resumeReason = lost[0].reason;
    return { write: true, result: { driver: structuredClone(driver), lost, state: store.run ? store.run.state : null } };
  }, fsImpl);
}

/** IC-009: writes `endedAt` on this invocation's driver, add-only. `{ ended }`. */
function endDriver({ file, driver, now = new Date(), fsImpl = fs }: any) {
  if (!driver || !Number.isInteger(driver.pid)) throw usage('endDriver needs the driver registerDriver returned');
  return mutateDispatch(file, (store: any) => {
    const stored = (store.drivers as any[]).find((d) => sameDriver(d, driver));
    if (!stored || stored.endedAt) return { write: false, result: { ended: false } };
    stored.endedAt = now.toISOString();
    return { write: true, result: { ended: true } };
  }, fsImpl);
}

// ── admission (IC-007) ───────────────────────────────────────────────────────────────────────────

/** `modeFor`'s answer as `{ mode, harness, selection }`. */
function modeOf(answer: any, task: string) {
  const out = typeof answer === 'string' ? { mode: answer } : (answer && typeof answer === 'object' ? answer : {});
  if (!MODES.includes(out.mode)) throw usage(`modeFor('${task}') returned mode '${out.mode}', not one of ${MODES.join(', ')}`);
  return { mode: out.mode, harness: out.mode === 'subagent' ? out.harness ?? null : null, selection: out.selection ?? null };
}

/** The 081 status of every worker run a dispatch of `store` names, read outside the lock. */
function workerStatuses(root: string, slug: string, store: any, ledgerFile: string, fsImpl: any, nowMs: number) {
  const named = (Object.values(store.dispatches) as any[]).filter((d) => d.workerRunId);
  const out = new Map<string, any>();
  if (!named.length) return out;
  const runs = readRuns(runStoreFileFor(root, slug), fsImpl);
  const ledger = readTaskState(fsImpl, ledgerFile) || { tasks: {}, runs: {} };
  for (const d of named) {
    const run = runs[d.workerRunId];
    out.set(d.workerRunId, run ? statusView(run, ledger, { platform: process.platform, nowMs }) : null);
  }
  return out;
}

/** IC-007 step 8: a prior ended dispatch of `task` whose worker run is not gone, or null. */
function workerNotGone(store: any, task: string, statuses: Map<string, any>) {
  for (const d of Object.values(store.dispatches) as any[]) {
    if (d.task !== task || d.phase !== 'ended' || !d.workerRunId) continue;
    const status = statuses.get(d.workerRunId);
    const cleanup = d.cleanup ? d.cleanup.cleanup ?? d.cleanup : status ? status.cleanup : null;
    if ((status && LIVE_WORKER_STATES.includes(status.state)) || (cleanup && cleanup.status === 'survivors')) return d;
  }
  return null;
}

const isCandidate = (record: any) => record.state === 'READY' || (record.state === 'FAILED' && record.claimable === true);

/**
 * IC-007, phase 6 of IC-003. `ctx` is B.3's 080 context (`ledgerFile`, `roots`, `slug`, `env`,
 * `cwd`, `fsImpl`); `root` the lifecycle root holding the dispatch store and worktrees; `driver` the
 * `{ pid, start }` this pass registered; `by` the owner when a plan task names none; `modeFor(task,
 * { record, store })` IC-022's choice, called outside the lock once per candidate, returning a mode
 * or `{ mode, harness, selection }`.
 *
 * Returns `{ outcome, admitted, skipped, refused, gaps, actions }`: `outcome` is `admitted` when a
 * dispatch was claimed, else `none` or the reason nothing was admitted (`paused`, the run's state,
 * `no-run`, `verification-undeclared`, `concurrency-full`). `actions` are IC-003 StepActions for the
 * caller's step record.
 */
function admit({
  root, slug, ctx, driver, by, modeFor, env = process.env, now = () => new Date(), storeFile = null,
}: any) {
  if (typeof modeFor !== 'function') throw usage('admit needs modeFor, IC-022\'s mode choice');
  if (!ctx || typeof ctx.ledgerFile !== 'string' || !Array.isArray(ctx.roots)) throw usage('admit needs ctx with ledgerFile and roots');
  const fsImpl = ctx.fsImpl || fs;
  const file = storeFile ?? storeFileFor(root, slug);
  const who = driver ? { pid: driver.pid, start: driver.start ?? null } : { pid: process.pid, start: null };
  const empty = (outcome: string, extra: any = {}) => ({ outcome, admitted: [], skipped: [], refused: [], gaps: [], actions: [], ...extra });

  // Outside every lock: 080 inspect, 081 statuses and the mode per candidate.
  const view = inspect({ file: ctx.ledgerFile, fsImpl, roots: ctx.roots, slug, env: ctx.env ?? env, cwd: ctx.cwd });
  const pre = readDispatch(file, fsImpl);
  const statuses = workerStatuses(root, slug, pre, ctx.ledgerFile, fsImpl, now().getTime());
  const graph = { tasks: view.graph.tasks };
  const filesOf = new Map<string, string[]>(view.graph.tasks.map((t: any) => [t.id, (t.files || []).map(normalizeFile).filter(Boolean)]));
  const ownerOf = new Map<string, string | null>(view.graph.tasks.map((t: any) => [t.id, t.owner ?? null]));
  const pairs = new Set<string>(overlaps(graph).flatMap((p: any) => [`${p.a}\u0000${p.b}`, `${p.b}\u0000${p.a}`]));
  const modes = new Map<string, any>();
  for (const record of view.tasks) if (isCandidate(record)) modes.set(record.id, modeOf(modeFor(record.id, { record, store: pre }), record.id));
  const manager = managerFor(root, slug, 'attempt', env);

  // First section: IC-007 steps 1 to 8 and the admitted slots.
  const first = mutateDispatch(file, (store: any) => {
    const run = store.run;
    if (!run) return { write: false, result: empty('no-run') };
    if (run.state !== 'running' || view.run.control !== 'running') {
      return { write: false, result: empty(view.run.control === 'paused' ? 'paused' : run.state !== 'running' ? run.state : view.run.control) };
    }
    if (!run.verify || !Array.isArray(run.verify.argv)) return { write: false, result: empty('verification-undeclared') };
    const concurrency = Number.isInteger(run.concurrency) ? run.concurrency : CONCURRENCY_DEFAULT;
    const nonEnded = (Object.values(store.dispatches) as any[]).filter((d) => d.phase !== 'ended');
    if (nonEnded.length >= concurrency) return { write: false, result: empty('concurrency-full') };

    // Every non-ended dispatch's task, the ones admitted below included.
    const busy: Array<{ task: string; dispatchId: string; mode: string }> = nonEnded.map((d) => ({ task: d.task, dispatchId: d.dispatchId, mode: d.mode }));
    // The write sets a candidate is checked against: every non-ended dispatch, not only this pass's (DEC-003).
    const holders: Array<{ task: string; dispatchId: string }> = busy.map((b) => ({ task: b.task, dispatchId: b.dispatchId }));
    const admitted: any[] = [];
    const skipped: any[] = [];
    for (const record of view.tasks) {
      const task = record.id;
      const active = busy.find((b) => b.task === task);
      if (active) { skipped.push({ task, reason: 'active-dispatch', dispatchId: active.dispatchId }); continue; }
      if (!isCandidate(record)) continue;
      if (nonEnded.length + admitted.length >= concurrency) { skipped.push({ task, reason: 'concurrency' }); continue; }
      const mine = filesOf.get(task) || [];
      const clash = holders.find((b) => !mine.length || !(filesOf.get(b.task) || []).length || pairs.has(`${task}\u0000${b.task}`));
      if (clash) { skipped.push({ task, reason: 'overlap', dispatchId: clash.dispatchId, with: clash.task }); continue; }
      const choice = modes.get(task);
      if (!choice) { skipped.push({ task, reason: 'no-mode' }); continue; }
      const mainBusy = MAIN_SESSION_MODES.includes(choice.mode) && busy.find((b) => MAIN_SESSION_MODES.includes(b.mode));
      if (mainBusy) { skipped.push({ task, reason: 'main-session-busy', dispatchId: mainBusy.dispatchId }); continue; }
      const gone = workerNotGone(store, task, statuses);
      if (gone) { skipped.push({ task, reason: 'worker-not-gone', dispatchId: gone.dispatchId }); continue; }

      const dispatchId = newDispatchId();
      store.dispatches[dispatchId] = {
        dispatchId, dispatchRunId: run.dispatchRunId ?? null, parentRunKey: run.runKey ?? view.run.runKey ?? null,
        task, token: null, epoch: null, phase: 'admitted', mode: choice.mode, harness: choice.harness,
        selection: choice.selection, grant: copyGrant(run.spawnGrant ?? null, choice.mode),
        workerRunId: null, disposition: null, failureClass: null,
        attempt: { worktree: manager.pathFor(dispatchId), branch: manager.branchFor(dispatchId), base: run.integration ? run.integration.head : null },
        admittedAt: now().toISOString(), admittedBy: who,
      };
      if (MAIN_SESSION_MODES.includes(choice.mode) && run.held && Object.hasOwn(run.held, task)) delete run.held[task];
      busy.push({ task, dispatchId, mode: choice.mode });
      holders.push({ task, dispatchId });
      admitted.push({ dispatchId, task, base: store.dispatches[dispatchId].attempt.base });
    }
    return { write: admitted.length > 0, result: { outcome: admitted.length ? 'admitted' : 'none', slots: admitted, skipped } };
  }, fsImpl);
  if (!first.slots) return first;

  const result: any = { outcome: 'none', admitted: [], skipped: first.skipped, refused: [], gaps: [], actions: [] };
  for (const s of first.skipped) result.actions.push(action('admit', { dispatchId: s.dispatchId, task: s.task }, `skipped:${s.reason}`));

  for (const slot of first.slots) {
    const started = Date.now();
    const { dispatchId, task } = slot;
    // Outside the lock: the attempt worktree (IC-016).
    let made: any = null;
    let madeError: string | null = null;
    try {
      if (slot.base) made = createAttemptWorktree({ root, slug, dispatchId, base: slot.base, env });
      else madeError = 'integration-head-unknown';
    } catch (error: any) {
      madeError = `worktree-failed:${error && (error.status ?? error.code) ? String(error.status ?? error.code) : 'error'}`;
    }

    // Second section: re-check the slot, then the in-process 080 claim.
    const second = mutateDispatch(file, (store: any) => {
      const d = store.dispatches[dispatchId];
      if (!d || d.phase !== 'admitted') return { write: false, result: { kind: 'gone', phase: d ? d.phase : null } };
      const drop = (reason: string, refusal: any = null) => {
        delete store.dispatches[dispatchId];
        return { write: true, result: { kind: 'refused', reason, refusal } };
      };
      if (madeError) return drop(madeError);
      if (!store.run || store.run.state !== 'running') return drop(`run-${store.run ? store.run.state : 'missing'}`);
      const reserve = Number.isInteger(store.run.reserveTokens) ? store.run.reserveTokens : null;
      let claimed: any;
      try {
        claimed = claim({
          file: ctx.ledgerFile, fsImpl, roots: ctx.roots, slug, task, owner: ownerOf.get(task) || by, mode: d.mode,
          epoch: view.run.epoch, reserveTokens: reserve, execWorktree: made.worktree,
          env: ctx.env ?? env, cwd: ctx.cwd, now: now(),
        });
      } catch (error: any) {
        return drop(`error:${error && error.code ? error.code : 'throw'}`, { message: clip(error && error.message) });
      }
      if (!claimed || claimed.disposition !== 'claimed') return drop(claimed ? claimed.reason : 'no-result', claimed);
      Object.assign(d, {
        phase: 'claimed', token: claimed.token, epoch: claimed.epoch ?? view.run.epoch,
        parentRunKey: claimed.runKey ?? d.parentRunKey, attempt: made, reservation: { tokens: reserve },
        claimedAt: now().toISOString(), claimedBy: who,
      });
      return { write: true, result: { kind: 'claimed', dispatch: structuredClone(d) } };
    }, fsImpl);

    const ms = Date.now() - started;
    if (second.kind === 'claimed') {
      const d = second.dispatch;
      result.admitted.push({ dispatchId, task, token: d.token, epoch: d.epoch, mode: d.mode, harness: d.harness, worktree: d.attempt.worktree });
      result.actions.push(action('admit', d, `claimed:${d.mode}`, ms));
      continue;
    }
    if (second.kind === 'gone') {
      result.actions.push(action('admit', { dispatchId, task }, `slot-moved:${second.phase ?? 'dropped'}`, ms));
      continue;
    }
    // A dropped slot: its worktree is removed outside the lock.
    const removal = made || madeError ? manager.removeVerified(dispatchId) : null;
    const refused: any = { dispatchId, task, reason: second.reason, refusal: second.refusal, removal };
    if (BUDGET_REFUSALS.includes(second.reason)) {
      refused.gap = { task, kind: 'claim-refused', cause: 'budget', reason: second.reason };
      result.gaps.push(refused.gap);
    }
    result.refused.push(refused);
    result.actions.push(action('claim-refused', { dispatchId, task }, second.reason, ms));
  }
  result.outcome = result.admitted.length ? 'admitted' : 'none';
  return result;
}

/** DEC-002: `value` as a concurrency, default 2; anything outside 1 to 4 is `usage`. */
function concurrencyOf(value: any): number {
  if (value === undefined || value === null) return CONCURRENCY_DEFAULT;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < CONCURRENCY_MIN || n > CONCURRENCY_MAX) throw usage(`--concurrency expects ${CONCURRENCY_MIN} to ${CONCURRENCY_MAX}, got '${value}'`);
  return n;
}

module.exports = {
  registerDriver,
  endDriver,
  admit,
  concurrencyOf,
  CONCURRENCY_MIN,
  CONCURRENCY_MAX,
  CONCURRENCY_DEFAULT,
  MAIN_SESSION_MODES,
  BUDGET_REFUSALS,
  LOST_REASONS,
};
