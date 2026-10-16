'use strict';

// Feature 082 C.4 (IC-029, IC-030, IC-031, IC-032; DEC-009, DEC-013, DEC-019, DEC-030, DEC-035,
// DEC-040, DEC-044, DEC-045, DEC-047, DEC-050): the user controls on a dispatch run.
//
// `pause`, `inspect`, `cancel`, `takeOver` and `resume` compose 080 and 081 (DEC-030): the 080 run's
// control is changed only by the in-process 080 `pause`, `cancel`, `release` and `resume`, each
// inside the dispatch lock (lock order dispatch then ledger, IC-006), and a worker run is ended only
// through 081's `cancelRun` with the canceller's own `env` and `cwd`, so 081 re-checks the caller's
// run key before its own signal (DEC-047). Nothing here signals a process: the one group dispatch
// code ends itself, a recorded verification, is ended through `verify-run.ts`'s `endVerification`.
// Drivers are read, never signalled (IC-009).
//
// Every control but `inspect` registers a driver (IC-009) after IC-001's identity checks, and writes
// its end on exit. `inspect` takes no lock and writes nothing.
//
// Resume (IC-032) settles before it resumes (DEC-013, DEC-045): each dispatch whose owner is gone
// is settled by its phase, a lost lease by the lease rule, every 081 run left behind by an ended
// dispatch is cancelled, unnamed worktrees are listed and never deleted, and only then does the
// in-process 080 resume run, so its report and digest already reflect the settlement.
//
// Every write goes through `store.ts` (`updateTaskState`); this module makes no fs write call.
// Git runs only through `WorktreeManager`'s bounded helper and `integrate.ts`.

const fs = require('node:fs');
const path = require('node:path');
const attempts = require('../task-attempts.ts');
const { readTaskState } = require('../task-state.ts');
const { maskLine } = require('../mask.ts');
const { projectRoot } = require('../lifecycle/root.ts');
const { BASE_FILE } = require('../worktree.ts');
const { alive } = require('../worker/process-tree.ts');
const { cancelRun, CANCEL_TAKEOVER_MS } = require('../worker/cancel.ts');
const { statusView, findRun } = require('../worker/command.ts');
const { readRuns, storeFileFor: runStoreFileFor } = require('../worker/run-store.ts');
const { storeFileFor, readDispatch, mutateDispatch, transitionDispatch, DispatchStoreError } = require('./store.ts');
const { registerDriver, endDriver, MAIN_SESSION_MODES } = require('./admission.ts');
const { endAttempt, releaseAttempt, usageFor } = require('./attempt-end.ts');
const integrate = require('./integrate.ts');
const { endVerification } = require('./verify-run.ts');
const { checkCaller, measurement, LOOP_BY, ATTEMPT_SECONDS_DEFAULT } = require('./loop.ts');

/** 080's `SAFE_NAME`, which `--by` must match. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const ACK = /^sha256:[0-9a-f]{64}$/;
const RUN_ENDED = Object.freeze(['completed', 'cancelled']);
const LIVE_WORKER_STATES = Object.freeze(['starting', 'running']);
const LOST_WORKER_REASON = 'resume: worker run lost';

type Env = Record<string, string | undefined>;

function usage(message: string) {
  return new DispatchStoreError('usage', message);
}

function refused(reason: string, extra: any = {}) {
  return { disposition: 'refused', reason, ...extra };
}

const iso = (at: Date) => at.toISOString();

function requireBy(by: any): string {
  if (typeof by !== 'string' || !SAFE_NAME.test(by)) throw usage('--by is required: the name of the agent or person using the control');
  return by;
}

function requireReason(reason: any, what: string): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) throw usage(`--reason is required: ${what}`);
  return text;
}

/** One invocation's paths, identity inputs and clock. */
function contextFor(options: any) {
  const env: Env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const slug = options.slug;
  if (typeof slug !== 'string') throw usage('a dispatch control needs --slug');
  const root = options.root ? path.resolve(options.root) : projectRoot(cwd);
  const clock: () => Date = typeof options.now === 'function'
    ? () => { const at = options.now(); return at instanceof Date ? at : new Date(at); }
    : () => new Date();
  const ledgerFile = attempts.storeFile(root, slug);
  const roots = [...new Set([cwd, root])];
  const c: any = {
    env, cwd, slug, root, clock, ledgerFile, roots,
    file: storeFileFor(root, slug),
    runStore: runStoreFileFor(root, slug),
    platform: options.platform || process.platform,
  };
  c.ctx = () => ({ ledgerFile, roots, slug, env, cwd, fsImpl: fs, now: clock() });
  c.common = () => ({ file: ledgerFile, fsImpl: fs, roots, slug, env, cwd, now: clock() });
  c.ledger = () => readTaskState(fs, ledgerFile) || { tasks: {}, runs: {} };
  c.git = (args: string[], cwdOf: string) => integrate.managerFor(root, slug, 'integration', env).git(args, cwdOf, { allowFailure: true });
  return c;
}

/** Runs `body(driver)` under one registered driver whose end is always written (IC-009). */
async function withDriver(c: any, body: (driver: any) => Promise<any>) {
  const reg = registerDriver({ file: c.file, now: c.clock() });
  try {
    return await body(reg.driver);
  } finally {
    endDriver({ file: c.file, driver: reg.driver, now: c.clock() });
  }
}

const sameDriver = (a: any, b: any) => !!a && !!b && a.pid === b.pid && (a.start ?? null) === (b.start ?? null)
  && (a.registeredAt ?? null) === (b.registeredAt ?? null);

/** The driver `who` (`{ pid, start }`) still has a registered, unended, not-lost record other than
 * this invocation's own `mine`. */
function ownerLive(store: any, who: any, mine: any): boolean {
  if (!who || !Number.isInteger(who.pid)) return false;
  return (store.drivers as any[]).some((d) => d && !d.endedAt && !d.lost && d.pid === who.pid
    && (d.start ?? null) === (who.start ?? null) && !sameDriver(d, mine));
}

/** The parts of a `cancelRun` result a dispatch or spawn request keeps. */
function cancelSummary(result: any) {
  if (!result) return null;
  if (result.disposition !== 'cancelled') return { disposition: result.disposition, reason: result.reason ?? null, endState: result.endState ?? null, cleanup: result.cleanup ?? null };
  return { disposition: 'cancelled', endState: result.endState, cleanup: result.cleanup, attemptCancel: result.attemptCancel, attemptCancelled: result.attemptCancelled };
}

/** 081 `cancelRun` with the canceller's own env and cwd; a throw is returned as `error`. */
async function endWorker(c: any, runId: string, by: string, reason: string) {
  try {
    return await cancelRun({ file: c.runStore, runId, by, reason, source: 'user', env: c.env, cwd: c.cwd, platform: c.platform, now: c.clock });
  } catch (error: any) {
    return { disposition: 'error', reason: error && error.code ? error.code : 'cancel-threw' };
  }
}

/**
 * Ends every listed 081 run that has not ended, then records each result add-only: a dispatch's own
 * run as its `cleanup` while absent, a child run on its spawn request. `targets` maps a run id to
 * `{ dispatchId, requestId }`. Returns IC-030's worker rows.
 */
async function endWorkers(c: any, targets: Map<string, any>, by: string, reason: string) {
  const runs = readRuns(c.runStore);
  const rows: any[] = [];
  const results = new Map<string, any>();
  for (const [runId, target] of targets) {
    const run = runs[runId];
    if (!run || run.phase === 'ended') continue;
    const res = await endWorker(c, runId, by, reason);
    results.set(runId, { target, res });
    rows.push({
      dispatchId: target.dispatchId, workerRunId: runId, endState: res.endState ?? null, cleanup: res.cleanup ?? null,
      attemptCancelled: res.disposition === 'cancelled' ? Boolean(res.attemptCancelled) : null,
      refused: res.disposition === 'cancelled' ? null : res.reason ?? res.disposition,
    });
  }
  if (results.size) {
    mutateDispatch(c.file, (s: any) => {
      for (const [runId, { target, res }] of results) {
        const summary = cancelSummary(res);
        const r = target.requestId ? s.spawnRequests[target.requestId] : null;
        if (r) {
          r.cancel = summary;
          if (res.disposition === 'cancelled') {
            if (r.endState == null) Object.assign(r, { endState: res.endState, endedAt: iso(c.clock()) });
            r.cleanup = res.cleanup ?? null;
          }
          continue;
        }
        const d = s.dispatches[target.dispatchId];
        if (d && d.workerRunId === runId && d.cleanup == null) d.cleanup = summary;
      }
      return { write: true, result: null };
    });
  }
  return rows;
}

/** The launched child runs of `dispatchId` with no recorded end, as cancel targets. */
function childTargets(s: any, dispatchId: string | null, into: Map<string, any>) {
  for (const r of Object.values(s.spawnRequests) as any[]) {
    if (!r.childRunId || (dispatchId && r.granterDispatchId !== dispatchId)) continue;
    into.set(r.childRunId, { dispatchId: r.granterDispatchId, requestId: r.requestId });
  }
  return into;
}

/** Every 081 run of this slug with no end whose `(task, token)` is a dispatch's of this run and
 * that `keep(dispatch)` selects, as cancel targets. */
function strayTargets(s: any, runs: any, keep: (d: any) => boolean, into: Map<string, any>) {
  const byKey = new Map<string, any>();
  for (const d of Object.values(s.dispatches) as any[]) if (Number.isInteger(d.token)) byKey.set(`${d.task}\u0000${d.token}`, d);
  for (const run of Object.values(runs) as any[]) {
    if (run.phase === 'ended' || into.has(run.runId)) continue;
    if (s.run && run.caller && run.caller.runKey !== s.run.runKey) continue;
    const d = byKey.get(`${run.task}\u0000${run.token}`);
    if (!d || !keep(d)) continue;
    into.set(run.runId, { dispatchId: d.dispatchId, requestId: run.childOf ? run.request ?? null : null });
  }
  return into;
}

/** A dispatch's worker cleanup: its recorded one, else what 081 recorded for its ended run. */
function workerCleanupOf(d: any, runs: any) {
  if (d.cleanup) return d.cleanup.cleanup ?? d.cleanup;
  const run = d.workerRunId ? runs[d.workerRunId] : null;
  if (!run || run.phase !== 'ended') return null;
  if (run.cleanup) return run.cleanup;
  const leftover = run.process && run.process.leftover;
  if (run.end && run.end.state === 'exited' && !(leftover && leftover.status === 'survivors')) return { status: 'verified', reason: 'exited' };
  return null;
}

/** Stores a `Removal` add-only on an ended dispatch (`verified` may only move from false to true). */
function storeRemoval(c: any, dispatchId: string, removal: any) {
  transitionDispatch(c.file, dispatchId, ['ended'], (d: any) => {
    if (!d.removal || (d.removal.verified === false && removal.verified)) d.removal = removal;
  });
}

// ── the lease rule (IC-032 step 4, R4) ───────────────────────────────────────────────────────────

/** The integration worktree's uncommitted paths (renames give both names), the base pointer
 * excluded; null when git could not list them. */
function uncommitted(c: any, worktree: string): string[] | null {
  const res = c.git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree);
  if (!res.ok) return null;
  const fields = res.stdout.split('\0').filter((f: string) => f !== '');
  const out: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') { out.push(fields[i + 1]); i += 1; }
  }
  return out.filter((p) => p !== BASE_FILE);
}

/**
 * IC-032's lease rule for a lease whose holder is lost; null when there is no lease or its holder
 * reads alive. First a live recorded verification group is ended through `endVerification`. Then
 * `adopted` (080 COMPLETED, `pickedHead` set and the integration HEAD at it), `undone` (HEAD at
 * `preHead` or `pickedHead` and every uncommitted path a change path: IC-020's undo, the active
 * attempt released `interrupted`), else `blocked` with gap `integration-dirty`, touching nothing.
 */
async function leaseRule(c: any) {
  let s = readDispatch(c.file);
  const lease = s.lease;
  if (!lease) return null;
  const holder = lease.holder || {};
  if (alive({ pid: holder.pid, pgid: holder.pid, start: holder.start ?? null }, { platform: c.platform }) === true) return null;
  const dispatchId = lease.dispatchId;

  const verifying = s.run.verifying;
  let verification: any = null;
  if (verifying) {
    const live = alive({ pid: verifying.pid, pgid: verifying.pgid ?? verifying.pid, start: verifying.start ?? null }, { platform: c.platform });
    if (live === true) verification = await endVerification(verifying, { platform: c.platform });
    mutateDispatch(c.file, (st: any) => {
      if (!st.run || !st.run.verifying || st.run.verifying.pid !== verifying.pid) return { write: false, result: null };
      st.run.verifying = null;
      return { write: true, result: null };
    });
  }

  s = readDispatch(c.file);
  const d = s.dispatches[dispatchId];
  const integration = s.run.integration;
  const ledger = c.ledger();
  const entry = d && ledger.tasks ? ledger.tasks[d.task] : null;
  const attempt = entry && Array.isArray(entry.attempts) ? entry.attempts.find((a: any) => a.token === d.token) : null;
  const headRead = c.git(['rev-parse', '--verify', '-q', 'HEAD'], integration.worktree);
  const head = headRead.ok ? headRead.stdout.trim() : null;
  const { preHead } = lease;
  const pickedHead = lease.pickedHead ?? null;
  const base = { dispatchId, verification };
  const block = (reason: string) => {
    mutateDispatch(c.file, (st: any) => {
      st.run.state = 'blocked';
      st.run.integrationGap = { task: d ? d.task : null, kind: 'integration-dirty', cause: 'no-progress', reason, blocks: [] };
      return { write: true, result: null };
    });
    return { ...base, action: 'blocked', reason };
  };
  if (!d) return block('lease-dispatch-missing');

  if (attempt && attempt.state === 'finished' && attempt.result === 'COMPLETED' && pickedHead && head === pickedHead) {
    mutateDispatch(c.file, (st: any) => {
      const x = st.dispatches[dispatchId];
      st.run.integration.head = pickedHead;
      st.run.integrationGap = null;
      st.lease = null;
      if (x && x.phase !== 'ended') {
        Object.assign(x, {
          phase: 'ended', disposition: 'completed', failureClass: null, evidenceId: attempt.evidenceId ?? null,
          integratedCommit: pickedHead, endedAt: iso(c.clock()), usage: usageFor(x, null, []),
        });
      }
      return { write: true, result: null };
    });
    await integrate.removeDispatchWorktree({ root: c.root, slug: c.slug, dispatchId, env: c.env, storeFile: c.file });
    return { ...base, action: 'adopted', reason: 'finished-completed' };
  }

  const paths = uncommitted(c, integration.worktree);
  const changePaths = new Set<string>((Array.isArray(d.changes) ? d.changes : []).flatMap((x: any) => [x.path, x.from].filter(Boolean)));
  const atOwnHead = head !== null && (head === preHead || (pickedHead !== null && head === pickedHead));
  if (!atOwnHead) return block('head-moved');
  if (paths === null) return block('status-failed');
  if (!paths.every((p) => changePaths.has(p))) return block('dirty');

  const undone = integrate.undo({ worktree: integration.worktree, branch: integration.branch, preHead, pickedHead, env: c.env });
  if (!undone.ok) return block(undone.reason);
  mutateDispatch(c.file, (st: any) => {
    const x = st.dispatches[dispatchId];
    st.lease = null;
    if (!x || x.phase === 'ended') return { write: true, result: null };
    const active = attempt && attempt.state === 'active';
    const end = active ? endAttempt({ store: st, dispatchId, failureClass: 'interrupted', detail: 'lease holder lost', ctx: c.ctx() }) : null;
    if (x.phase !== 'ended') {
      Object.assign(x, { phase: 'ended', disposition: 'interrupted', failureClass: 'interrupted', endedAt: iso(c.clock()), usage: usageFor(x, null, []) });
    }
    return { write: true, result: end ? end.result : null };
  });
  return { ...base, action: 'undone', reason: 'lease holder lost' };
}

// ── IC-029: pause and inspect ────────────────────────────────────────────────────────────────────

const activeOf = (s: any) => (Object.values(s.dispatches) as any[]).filter((d) => d.phase !== 'ended')
  .map((d) => ({ dispatchId: d.dispatchId, task: d.task, token: d.token ?? null, phase: d.phase, mode: d.mode }));

/**
 * IC-029 pause: IC-001's identity checks, then the in-process 080 `pause` inside the dispatch lock.
 * `{ disposition: 'paused', dispatchRunId, runKey, active }`; 080's refusals (`control-unchanged`,
 * `run-cancelled`) pass through. Admission and child launch then start nothing; collection,
 * integration, verification and timeouts still run.
 */
async function pause(options: any = {}) {
  const c = contextFor(options);
  const by = requireBy(options.by);
  const reason = requireReason(options.reason, 'why the dispatch run is being paused');
  const caller = checkCaller({ env: c.env, cwd: c.cwd, file: c.file });
  if (caller.refusal) return caller.refusal;
  return withDriver(c, async () => mutateDispatch(c.file, (s: any) => {
    const res = attempts.pause({ ...c.common(), by, reason });
    if (res.disposition !== 'paused') return { write: false, result: res };
    return { write: false, result: { disposition: 'paused', dispatchRunId: s.run.dispatchRunId, runKey: res.runKey, active: activeOf(s) } };
  }));
}

/** IC-029's DispatchView for one dispatch. */
function viewOf(c: any, d: any, runs: any, ledger: any) {
  const run = d.workerRunId ? runs[d.workerRunId] : null;
  const status = run ? statusView(run, ledger, { platform: c.platform, nowMs: c.clock().getTime() }) : null;
  const ms = d.claimedAt && d.endedAt ? Date.parse(d.endedAt) - Date.parse(d.claimedAt) : null;
  return {
    dispatchId: d.dispatchId, parentRunKey: d.parentRunKey ?? null, task: d.task, token: d.token ?? null, epoch: d.epoch ?? null,
    phase: d.phase, mode: d.mode, harness: d.harness ?? null, disposition: d.disposition ?? null, failureClass: d.failureClass ?? null,
    workerRun: d.workerRunId ? { id: d.workerRunId, state: status ? status.state : 'missing', reason: status ? status.reason : 'run-missing', cleanup: status ? status.cleanup : null } : null,
    worktree: d.attempt && d.attempt.worktree
      ? { path: d.attempt.worktree, branch: d.attempt.branch, base: d.attempt.base, exists: fs.existsSync(d.attempt.worktree), removal: d.removal ?? null }
      : null,
    usage: d.usage ?? null, durationMs: Number.isFinite(ms) ? ms : null,
    undeclared: Array.isArray(d.undeclared) ? d.undeclared : [],
    envelopes: { handoff: d.envelopes ? d.envelopes.handoff ?? null : null, result: d.envelopes ? d.envelopes.result ?? null : null },
  };
}

/**
 * IC-029 inspect: IC-001's identity checks, then the store, 080 `inspect` and 081 `statusView` for
 * each dispatch's worker run (which runs `ps`). Takes no lock and writes nothing. Every verification
 * argv element is masked by `maskLine`.
 */
function inspect(options: any = {}) {
  const c = contextFor(options);
  const caller = checkCaller({ env: c.env, cwd: c.cwd, file: c.file });
  if (caller.refusal) return caller.refusal;
  const s = caller.store;
  const run = s.run;
  const view = attempts.inspect({ file: c.ledgerFile, fsImpl: fs, roots: c.roots, slug: c.slug, env: c.env, cwd: c.cwd });
  const ledger = c.ledger();
  const runs = readRuns(c.runStore);
  const verify = run.verify || {};
  const argv: string[] = Array.isArray(verify.argv) ? verify.argv.map((a: any) => maskLine(String(a)).text) : [];
  const verifications = Array.isArray(run.verifications) ? run.verifications : [];
  const gaps = run.blockedReport && Array.isArray(run.blockedReport.gaps) ? run.blockedReport.gaps : (run.integrationGap ? [run.integrationGap] : []);
  return {
    disposition: 'inspected', dispatchRunId: run.dispatchRunId, slug: c.slug, runKey: run.runKey,
    state: run.state, control: view.run.control, epoch: view.run.epoch ?? run.epoch ?? null,
    concurrency: run.concurrency, mode: run.mode,
    verification: {
      declared: Array.isArray(verify.argv), argv, argc: Array.isArray(verify.argv) ? verify.argv.length : 0,
      sha256: verify.argvSha256 ?? null, seconds: verify.timeoutSeconds ?? null, last: verifications.length ? verifications[verifications.length - 1] : null,
    },
    integration: run.integration
      ? { worktree: run.integration.worktree, branch: run.integration.branch, base: run.integration.base, head: run.integration.head, lease: s.lease ?? null }
      : null,
    dispatches: (Object.values(s.dispatches) as any[]).map((d) => viewOf(c, d, runs, ledger)),
    drivers: (s.drivers as any[]).map((d) => ({ pid: d.pid, start: d.start ?? null, registeredAt: d.registeredAt ?? null, endedAt: d.endedAt ?? null, lost: d.lost ?? null })),
    spawnRequests: Object.values(s.spawnRequests),
    gaps,
    measurement: measurement(s),
    tasks: view.tasks.map((t: any) => ({ id: t.id, state: t.state, reason: t.reason, budget: { used: t.budget.used, limit: t.budget.limit } })),
  };
}

/** IC-029's text form: one line per dispatch, then the run, verification and measurement lines. No
 * envelope or output content. */
function inspectLines(result: any): string[] {
  if (result.disposition !== 'inspected') return [`${result.disposition} ${result.reason ?? ''}`.trim()];
  const lines = result.dispatches.map((d: any) => {
    const worker = d.workerRun ? ` worker ${d.workerRun.id} ${d.workerRun.state}` : '';
    return `${d.dispatchId} ${d.task} token ${d.token ?? '-'} ${d.phase} ${d.mode}${worker}`;
  });
  const v = result.verification;
  const t = result.measurement.tokens.total;
  lines.push(`run ${result.dispatchRunId} ${result.state} control ${result.control} epoch ${result.epoch} concurrency ${result.concurrency} mode ${result.mode}`);
  lines.push(`verification ${v.declared ? `argc ${v.argc} sha256 ${v.sha256 ?? '-'} ${v.seconds}s` : 'undeclared'}${v.last ? ` last exit ${v.last.exitCode}` : ''}`);
  lines.push(`measurement tokens measured ${t.measured} estimated ${t.estimated} peak workers ${result.measurement.peak.workers} worktrees ${result.measurement.peak.worktrees}`);
  return lines;
}

// ── IC-030: cancel ───────────────────────────────────────────────────────────────────────────────

/** IC-030 step 2: `run-ended`, `cancel-in-progress`, or null. */
function cancelRefusal(run: any, at: Date) {
  if (RUN_ENDED.includes(run.state)) return refused('run-ended', { state: run.state });
  if (run.state === 'cancelling' && run.cancel) {
    const requested = Date.parse(run.cancel.at);
    if (Number.isFinite(requested) && at.getTime() - requested < CANCEL_TAKEOVER_MS) return refused('cancel-in-progress', { at: run.cancel.at });
  }
  return null;
}

/** IC-030 step 8: removes every ended attempt and child worktree whose worker cleanup is `verified`
 * or that had no worker, failed ones included; `dropped` are admitted slots step 7 dropped. */
function removeWorktrees(c: any, dropped: string[]) {
  const removed: string[] = [];
  const kept: { path: string; reason: string }[] = [];
  const manager = integrate.managerFor(c.root, c.slug, 'attempt', c.env);
  const s = readDispatch(c.file);
  const runs = readRuns(c.runStore);
  for (const d of Object.values(s.dispatches) as any[]) {
    if (d.phase !== 'ended' || !d.attempt || !d.attempt.worktree || (d.removal && d.removal.verified)) continue;
    const cleanup = workerCleanupOf(d, runs);
    if (d.workerRunId && !(cleanup && cleanup.status === 'verified')) { kept.push({ path: d.attempt.worktree, reason: 'worker-cleanup-unverified' }); continue; }
    const due = integrate.removalDue({ ...d, cleanup: d.cleanup ?? (cleanup ? { cleanup } : null) }, { state: 'cancelled' });
    if (!due.due) { kept.push({ path: d.attempt.worktree, reason: due.reason }); continue; }
    const removal = manager.removeVerified(d.dispatchId);
    storeRemoval(c, d.dispatchId, removal);
    if (removal.verified) removed.push(removal.path);
    else kept.push({ path: removal.path, reason: 'removal-unverified' });
  }
  for (const id of dropped) {
    const wt = manager.pathFor(id);
    if (!fs.existsSync(wt)) continue;
    const removal = manager.removeVerified(id);
    if (removal.verified) removed.push(removal.path);
    else kept.push({ path: removal.path, reason: 'removal-unverified' });
  }
  const done: Record<string, any> = {};
  for (const r of Object.values(s.spawnRequests) as any[]) {
    if (!r.worktree || (r.removal && r.removal.verified)) continue;
    const verified = r.endState === 'exited' || (r.cleanup && r.cleanup.status === 'verified');
    if (!verified) { kept.push({ path: r.worktree, reason: 'worker-cleanup-unverified' }); continue; }
    const removal = manager.removeVerified(r.requestId);
    done[r.requestId] = removal;
    if (removal.verified) removed.push(removal.path);
    else kept.push({ path: removal.path, reason: 'removal-unverified' });
  }
  if (Object.keys(done).length) {
    mutateDispatch(c.file, (st: any) => {
      for (const [id, removal] of Object.entries(done) as [string, any][]) {
        const r = st.spawnRequests[id];
        if (r && (!r.removal || (r.removal.verified === false && removal.verified))) r.removal = removal;
      }
      return { write: true, result: null };
    });
  }
  return { removed, kept };
}

/**
 * IC-030 cancel. In order: IC-001's identity checks; `run-ended` or `cancel-in-progress`; the run
 * `cancelling`; every worker, child and matching stray 081 run ended through `cancelRun` with the
 * canceller's own env and cwd; the in-process 080 run cancel; an `integrating` dispatch left to a
 * live lease holder, else IC-032's lease rule; every other non-ended dispatch `ended` `cancelled`
 * (admitted slots dropped); worktree removal; the run `cancelled`. `cleanupVerified` is true only
 * when every worker cleanup and every removal is `verified`.
 */
async function cancel(options: any = {}) {
  const c = contextFor(options);
  const by = requireBy(options.by);
  const reason = requireReason(options.reason, 'why the dispatch run is being cancelled');
  const caller = checkCaller({ env: c.env, cwd: c.cwd, file: c.file });
  if (caller.refusal) return caller.refusal;
  const early = cancelRefusal(caller.store.run, c.clock());
  if (early) return early;

  return withDriver(c, async () => {
    // Step 3.
    const at = c.clock();
    const marked = mutateDispatch(c.file, (s: any) => {
      const busy = cancelRefusal(s.run, at);
      if (busy) return { write: false, result: busy };
      s.run.state = 'cancelling';
      s.run.cancel = { at: iso(at), by, reason };
      return { write: true, result: null };
    });
    if (marked) return marked;

    // Step 4, outside every lock.
    let s = readDispatch(c.file);
    const targets = new Map<string, any>();
    for (const d of Object.values(s.dispatches) as any[]) if (d.phase !== 'ended' && d.workerRunId) targets.set(d.workerRunId, { dispatchId: d.dispatchId, requestId: null });
    childTargets(s, null, targets);
    strayTargets(s, readRuns(c.runStore), () => true, targets);
    const workers = await endWorkers(c, targets, by, reason);

    // Step 5.
    const runResult = mutateDispatch(c.file, (st: any) => {
      let res: any;
      try {
        res = attempts.cancel({ ...c.common(), by, reason });
      } catch (error: any) {
        res = { disposition: 'error', reason: error && error.code ? error.code : 'cancel-threw' };
      }
      const kept = { disposition: res.disposition, reason: res.reason ?? null, cancelled: Array.isArray(res.cancelled) ? res.cancelled : [] };
      st.run.cancelResult = kept;
      return { write: true, result: kept };
    });

    // Step 6.
    let integrationInProgress: string | null = null;
    let lease: any = null;
    s = readDispatch(c.file);
    if (s.lease) {
      const leased = s.lease.dispatchId;
      lease = await leaseRule(c);
      if (!lease || lease.action === 'blocked') integrationInProgress = leased;
    }

    // Step 7.
    const runsNow = readRuns(c.runStore);
    const dropped: string[] = mutateDispatch(c.file, (st: any) => {
      const out: string[] = [];
      for (const d of Object.values(st.dispatches) as any[]) {
        if (d.phase === 'ended' || d.dispatchId === integrationInProgress) continue;
        if (d.phase === 'admitted') { delete st.dispatches[d.dispatchId]; out.push(d.dispatchId); continue; }
        Object.assign(d, {
          phase: 'ended', disposition: 'cancelled', endedAt: iso(c.clock()),
          usage: usageFor(d, d.workerRunId ? runsNow[d.workerRunId] ?? null : null, []),
        });
      }
      return { write: true, result: out };
    });

    // Step 8, outside.
    const worktrees = removeWorktrees(c, dropped);

    // Step 9.
    mutateDispatch(c.file, (st: any) => {
      st.run.state = 'cancelled';
      st.run.endedAt = iso(c.clock());
      return { write: true, result: null };
    });

    const cleanupVerified = workers.every((w) => w.refused === null && w.cleanup && w.cleanup.status === 'verified')
      && worktrees.kept.length === 0 && integrationInProgress === null;
    return {
      disposition: 'cancelled', dispatchRunId: s.run.dispatchRunId, workers, run: runResult,
      integrationInProgress, lease: lease ? { dispatchId: lease.dispatchId, action: lease.action } : null, worktrees, cleanupVerified,
    };
  });
}

// ── IC-031: take over ────────────────────────────────────────────────────────────────────────────

/** IC-031 step 5's refusal for a dispatch phase, or null for `claimed` and `launched`. */
function phaseRefusal(d: any) {
  if (d.phase === 'claimed' || d.phase === 'launched') return null;
  if (d.phase === 'admitted') return refused('not-claimed', { dispatchId: d.dispatchId, phase: d.phase });
  return refused('integration-in-progress', { dispatchId: d.dispatchId, phase: d.phase });
}

/**
 * IC-031 take over: after IC-031's refusal table, one locked write releases the attempt (reason
 * `takeover: <reason>`, usage the worker's when it reported, else the reservation as estimated),
 * ends the dispatch `taken-over` and holds the task for a main-session attempt; then, outside the
 * lock, `cancelRun` ends its worker run and children, whose 080 cancel is refused
 * `no-active-attempt` because the release came first (DEC-035).
 */
async function takeOver(options: any = {}) {
  const c = contextFor(options);
  const by = requireBy(options.by);
  const reason = requireReason(options.reason, 'why the attempt is being taken over');
  const task = options.task;
  if (typeof task !== 'string' || !task) throw usage('--task is required: the plan task to take over');
  const caller = checkCaller({ env: c.env, cwd: c.cwd, file: c.file });
  if (caller.refusal) return caller.refusal;
  const plan = attempts.loadPlan({ roots: c.roots, slug: c.slug, fsImpl: fs });
  if (!plan.graph.tasks.some((t: any) => t.id === task)) return refused('unknown-task', { task });
  const d = (Object.values(caller.store.dispatches) as any[]).find((x) => x.task === task && x.phase !== 'ended');
  if (!d) return refused('no-active-dispatch', { task });
  if (d.mode !== 'subagent') return refused('already-main-session', { task, dispatchId: d.dispatchId, mode: d.mode });
  const early = phaseRefusal(d);
  if (early) return early;

  return withDriver(c, async () => {
    const runs = readRuns(c.runStore);
    const workerRun = d.workerRunId ? runs[d.workerRunId] ?? null : null;
    const children = (Object.values(caller.store.spawnRequests) as any[])
      .filter((r) => r.granterDispatchId === d.dispatchId && r.childRunId && runs[r.childRunId]).map((r) => runs[r.childRunId]);
    const spent = usageFor(d, workerRun, children);
    const at = c.clock();
    const out = mutateDispatch(c.file, (s: any) => {
      const x = s.dispatches[d.dispatchId];
      if (!x || x.phase === 'ended') return { write: false, result: refused('no-active-dispatch', { task }) };
      const late = phaseRefusal(x);
      if (late) return { write: false, result: late };
      const end = releaseAttempt({ store: s, dispatchId: x.dispatchId, reason: `takeover: ${reason}`, disposition: 'taken-over', usage: spent, ctx: c.ctx() });
      if (!end.result.ended) return { write: end.write, result: refused('release-refused', { task, dispatchId: x.dispatchId, cause: end.result.reason ?? end.result.outcome ?? null }) };
      x.takeover = { at: iso(at), by, reason };
      s.run.held = { ...(s.run.held || {}), [task]: { at: iso(at), by } };
      return { write: true, result: { ended: true, mode: s.run.mode === 'manual' ? 'manual' : 'sequential' } };
    });
    if (!out.ended) return out;

    // Outside the lock: the worker run and its children.
    const targets = new Map<string, any>();
    if (d.workerRunId) targets.set(d.workerRunId, { dispatchId: d.dispatchId, requestId: null });
    childTargets(readDispatch(c.file), d.dispatchId, targets);
    const rows = await endWorkers(c, targets, by, `takeover: ${reason}`);
    let workerRunOut: any = null;
    if (d.workerRunId) {
      const row = rows.find((r) => r.workerRunId === d.workerRunId);
      const after = readRuns(c.runStore)[d.workerRunId];
      workerRunOut = row
        ? { id: d.workerRunId, endState: row.endState, cleanup: row.cleanup }
        : { id: d.workerRunId, endState: after && after.end ? after.end.state : null, cleanup: after ? after.cleanup ?? null : null };
    }
    return {
      disposition: 'taken-over', dispatchId: d.dispatchId, task, token: d.token, released: true,
      workerRun: workerRunOut, held: { task, mode: out.mode },
    };
  });
}

// ── IC-032: resume ───────────────────────────────────────────────────────────────────────────────

/** IC-032 step 3 for one dispatch: its rows in table order, re-read after each. */
async function settleOne(c: any, dispatchId: string, mine: any, settled: any[]) {
  const record = (phase: string, action: string, reason: string) => settled.push({ dispatchId, phase, action, reason });
  let s = readDispatch(c.file);
  let d = s.dispatches[dispatchId];
  if (!d || d.phase === 'ended') return;

  if (d.phase === 'admitted') {
    if (ownerLive(s, d.admittedBy, mine)) { record('admitted', 'left', 'driver-live'); return; }
    const entry = c.ledger().tasks[d.task];
    const active = entry && Array.isArray(entry.attempts) ? entry.attempts.find((a: any) => a.state === 'active') : null;
    const wt = d.attempt ? d.attempt.worktree : null;
    if (active && active.runKey === s.run.runKey && wt && active.execWorktree && path.resolve(active.execWorktree) === path.resolve(wt)) {
      const adopted = mutateDispatch(c.file, (st: any) => {
        const x = st.dispatches[dispatchId];
        if (!x || x.phase !== 'admitted') return { write: false, result: false };
        Object.assign(x, {
          phase: 'claimed', token: active.token, epoch: active.epoch ?? null, claimedAt: active.startedAt ?? iso(c.clock()),
          claimedBy: x.admittedBy, reservation: { tokens: active.reserve ? active.reserve.tokens ?? null : null },
        });
        return { write: true, result: true };
      });
      if (!adopted) return;
      record('admitted', 'adopted', `claim token ${active.token}`);
    } else {
      const dropped = mutateDispatch(c.file, (st: any) => {
        const x = st.dispatches[dispatchId];
        if (!x || x.phase !== 'admitted') return { write: false, result: false };
        delete st.dispatches[dispatchId];
        return { write: true, result: true };
      });
      if (!dropped) return;
      const removal = wt && fs.existsSync(wt) ? integrate.managerFor(c.root, c.slug, 'attempt', c.env).removeVerified(dispatchId) : null;
      record('admitted', 'dropped', removal ? (removal.verified ? 'worktree-removed' : 'worktree-kept') : 'no-worktree');
      return;
    }
  }

  s = readDispatch(c.file);
  d = s.dispatches[dispatchId];
  if (d && d.phase === 'claimed') {
    if (ownerLive(s, d.claimedBy, mine)) { record('claimed', 'left', 'driver-live'); return; }
    const run = findRun(c.runStore, { task: d.task, token: d.token });
    if (run) {
      const at = Date.parse(run.createdAt ?? run.startedAt ?? '');
      const launchedAt = Number.isFinite(at) ? new Date(at) : c.clock();
      const seconds = Number.isInteger(s.run.attemptSeconds) ? s.run.attemptSeconds : ATTEMPT_SECONDS_DEFAULT;
      const moved = mutateDispatch(c.file, (st: any) => {
        const x = st.dispatches[dispatchId];
        if (!x || x.phase !== 'claimed') return { write: false, result: false };
        Object.assign(x, {
          phase: 'launched', workerRunId: run.runId, launchedAt: iso(launchedAt),
          deadline: x.mode === 'subagent' ? iso(new Date(launchedAt.getTime() + seconds * 1000)) : null,
          workerIdentity: run.identity ? { ...run.identity } : null,
        });
        return { write: true, result: true };
      });
      if (!moved) return;
      record('claimed', 'adopted', `worker run ${run.runId}`);
    } else {
      const ended = mutateDispatch(c.file, (st: any) => {
        const x = st.dispatches[dispatchId];
        if (!x || x.phase !== 'claimed') return { write: false, result: { ended: false } };
        return endAttempt({ store: st, dispatchId, failureClass: 'interrupted', detail: null, ctx: c.ctx() });
      });
      record('claimed', ended.ended ? 'released' : 'error', ended.ended ? 'interrupted' : ended.reason || 'release-refused');
      return;
    }
  }

  s = readDispatch(c.file);
  d = s.dispatches[dispatchId];
  if (!d || d.phase !== 'launched') {
    if (d && d.phase !== 'ended' && d.phase !== 'integrating') record(d.phase, 'left', 'owner-not-needed');
    return;
  }
  if (MAIN_SESSION_MODES.includes(d.mode) || !d.workerRunId) { record('launched', 'left', 'main-session'); return; }
  const run = readRuns(c.runStore)[d.workerRunId];
  const view = run ? statusView(run, c.ledger(), { platform: c.platform, nowMs: c.clock().getTime() }) : null;
  if (!view || view.state !== 'unknown') {
    record('launched', 'left', view ? (LIVE_WORKER_STATES.includes(view.state) ? view.state : `ended:${view.state}`) : 'run-missing');
    return;
  }
  const res = await endWorker(c, d.workerRunId, LOOP_BY, LOST_WORKER_REASON);
  if (res.disposition !== 'cancelled') { record('launched', 'left', `cancel-${res.reason || res.disposition}`); return; }
  const after = readRuns(c.runStore)[d.workerRunId] ?? null;
  mutateDispatch(c.file, (st: any) => {
    const x = st.dispatches[dispatchId];
    if (!x || x.phase !== 'launched') return { write: false, result: null };
    Object.assign(x, {
      phase: 'ended', disposition: 'cancelled', failureClass: 'lost', endedAt: iso(c.clock()),
      usage: usageFor(x, after, []), cleanup: cancelSummary(res),
    });
    return { write: true, result: null };
  });
  record('launched', 'cancelled', 'lost');
}

/** IC-021 for the dispatches settlement ended, so the acknowledged call's report sees the same
 * worktrees the first call's did, whatever a pass between the two would have removed. */
async function removeSettled(c: any, settled: any[]) {
  const ended = new Set(settled.filter((x) => ['released', 'cancelled', 'undone', 'adopted'].includes(x.action)).map((x) => x.dispatchId));
  for (const id of ended) {
    const d = readDispatch(c.file).dispatches[id];
    if (d && d.phase === 'ended') await integrate.removeDispatchWorktree({ root: c.root, slug: c.slug, dispatchId: id, env: c.env, storeFile: c.file });
  }
}

/** IC-032 step 6: unnamed dispatch worktree directories and registered worktrees on this slug's
 * DoFlow branches, by path. Nothing is deleted. */
function orphansOf(c: any): string[] {
  const named = new Set<string>();
  const nameOf = (p: any) => { if (typeof p === 'string' && p) named.add(path.basename(p)); };
  const storesDir = path.dirname(c.file);
  const storeNames = fs.existsSync(storesDir) ? fs.readdirSync(storesDir).filter((f: string) => f.endsWith('.json')) : [];
  for (const name of storeNames) {
    let st: any;
    try { st = readDispatch(path.join(storesDir, name)); } catch { continue; }
    if (st.run) {
      if (st.run.dispatchRunId) named.add(st.run.dispatchRunId);
      if (st.run.integration) nameOf(st.run.integration.worktree);
    }
    for (const d of Object.values(st.dispatches) as any[]) { named.add(d.dispatchId); if (d.attempt) nameOf(d.attempt.worktree); }
    for (const r of Object.values(st.spawnRequests) as any[]) { if (r.requestId) named.add(r.requestId); nameOf(r.worktree); }
  }
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const out = new Map<string, string>();
  const dir = path.join(c.root, integrate.WORKTREES_DIR);
  if (fs.existsSync(dir)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !named.has(e.name)) out.set(real(path.join(dir, e.name)), path.join(dir, e.name));
    }
  }
  const listed = c.git(['worktree', 'list', '--porcelain'], c.root);
  if (listed.ok) {
    const prefixes = [`refs/heads/doflow/${c.slug}/`, `refs/heads/doflow-attempt/${c.slug}/`];
    for (const block of listed.stdout.split('\n\n')) {
      const lines = block.split('\n');
      const wt = lines.find((l: string) => l.startsWith('worktree '));
      const branch = lines.find((l: string) => l.startsWith('branch '));
      if (!wt || !branch) continue;
      const ref = branch.slice('branch '.length);
      const prefix = prefixes.find((p) => ref.startsWith(p));
      if (!prefix) continue;
      const p = wt.slice('worktree '.length);
      if (named.has(ref.slice(prefix.length)) || named.has(path.basename(p))) continue;
      const key = real(p);
      if (!out.has(key)) out.set(key, p);
    }
  }
  return [...out.values()].sort();
}

/**
 * IC-032 resume. IC-001's identity checks and `run-ended`; then, under one driver: settlement of
 * every dispatch by its phase, the lease rule for a lost lease holder, `cancelRun` for each 081 run
 * an ended dispatch left behind, the orphan list, `endedAt` on each lost driver, and last the
 * in-process 080 `resume`. Without `ack`: `ack-required` with 080's report and digest. With it:
 * 080's `resumed` sets the run `running` in the same dispatch-locked write; `report-changed`
 * passes through.
 */
async function resume(options: any = {}) {
  const c = contextFor(options);
  const ack = options.ack === undefined || options.ack === null ? null : String(options.ack);
  if (ack !== null && !ACK.test(ack)) throw usage(`--ack expects the digest resume reported (sha256:<64 hex>), got '${ack}'`);
  const by = ack !== null ? requireBy(options.by) : (options.by === undefined || options.by === null ? null : requireBy(options.by));
  const reason = options.reason === undefined || options.reason === null ? null : requireReason(options.reason, 'why the run is being resumed');
  const caller = checkCaller({ env: c.env, cwd: c.cwd, file: c.file });
  if (caller.refusal) return caller.refusal;
  if (RUN_ENDED.includes(caller.store.run.state)) return refused('run-ended', { state: caller.store.run.state });

  return withDriver(c, async (mine: any) => {
    // Steps 2 and 3: settlement, phase by phase.
    const settled: any[] = [];
    for (const id of Object.keys(readDispatch(c.file).dispatches)) await settleOne(c, id, mine, settled);

    // Step 4: a lost lease.
    let lease: any = null;
    const leased = readDispatch(c.file).lease;
    if (leased) {
      const ruled = await leaseRule(c);
      lease = ruled ? { dispatchId: ruled.dispatchId, action: ruled.action } : null;
      if (ruled) settled.push({ dispatchId: ruled.dispatchId, phase: 'integrating', action: ruled.action, reason: ruled.reason });
    }

    // Step 5: 081 runs left behind by an ended dispatch.
    const s = readDispatch(c.file);
    const strays = strayTargets(s, readRuns(c.runStore), (d) => d.phase === 'ended', new Map());
    const rows = await endWorkers(c, strays, LOOP_BY, 'resume: dispatch ended');
    for (const r of rows) settled.push({ dispatchId: r.dispatchId, phase: 'ended', action: r.refused ? 'cancel-refused' : 'worker-cancelled', reason: r.refused ?? r.workerRunId });
    await removeSettled(c, settled);

    // Step 6.
    const orphans = orphansOf(c);

    // Step 7: lost drivers get their end, add-only.
    mutateDispatch(c.file, (st: any) => {
      let changed = false;
      for (const d of st.drivers as any[]) {
        if (!d || !d.lost || d.endedAt) continue;
        Object.assign(d, { endedAt: iso(c.clock()), endReason: 'lost' });
        changed = true;
      }
      return { write: changed, result: null };
    });

    // Step 8: 080's resume.
    const base = { settled, lease, orphans };
    if (ack === null) {
      const res = attempts.resume({ ...c.common(), by, reason });
      if (res.disposition !== 'ack-required') return { ...res, ...base };
      return { disposition: 'ack-required', ...base, report: res.report, digest: res.digest };
    }
    const res = mutateDispatch(c.file, (st: any) => {
      const answer = attempts.resume({ ...c.common(), ack, by, reason });
      if (answer.disposition !== 'resumed') return { write: false, result: answer };
      if (st.run.state === 'resume-required') {
        st.run.state = 'running';
        st.run.resumeReason = null;
      }
      st.run.resumedAt = iso(c.clock());
      return { write: true, result: answer };
    });
    if (res.disposition !== 'resumed') return { ...res, ...base };
    return { disposition: 'resumed', ...base, report: res.report, digest: res.digest, epoch: res.epoch };
  });
}

module.exports = {
  pause,
  inspect,
  inspectLines,
  cancel,
  takeOver,
  resume,
};
