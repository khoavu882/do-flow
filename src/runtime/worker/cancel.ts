'use strict';

// Feature 081 C.1 (IC-021, IC-020 end state; DEC-005, DEC-038, DEC-040, DEC-046, DEC-047, DEC-050):
// the cancel sequence, shared by the `worker --action cancel` command and the supervisor's timeout.
//
// In order: (1) refusals before any write or signal, against the calling process's own identity;
// (2) the `cancelling` transition; (3) the tree escalation, outside every lock; (4) 080's attempt
// cancel, in process, with the caller's own `env` and `cwd` and no rebuilt identity, a refusal
// recorded and a throw stored as `disposition: 'error'`; (5) the end, always written once step 2
// applied. The escalation runs before the 080 cancel, so an 080 failure never leaves the tree alive.
// A child run (082 IC-015, DEC-028, DEC-041) shares its granter's 080 attempt, so step 4 is skipped
// for it on the user and timeout paths alike: `attemptCancel: { disposition: 'skipped', reason:
// 'child-run' }`, and ending a child never cancels its granter's attempt.
//
// 162 IC-005 (D7, DEC-007): `source: 'operator'` is a person at the machine, or a paired control
// device through the Console, stopping any worker of the project. It is refused (`operator-in-run`)
// unless the caller is outside every run and every worker session, records a relay label as `by`,
// and skips only the two `foreign-run` checks; every other refusal and step 4 are unchanged.
//
// This module makes no fs write call: every write goes through the run store's `transition`, and
// the 080 ledger is written only by 080's own `cancel` (G26 (b), IC-027).
//
// 170 (R-9, R-10): a started session's channel spool is removed by its supervisor when the run ends. When the
// supervisor is not seen alive after step 5 (it was killed and its harness ignored the closed stdin), this module
// removes the spool through channel-spool.ts, its only writer; a removal that fails is left to upkeep's 1-day bound.

const fs = require('node:fs');
const path = require('node:path');
const { readRuns, transition, RunStoreError } = require('./run-store.ts');
const processTree = require('./process-tree.ts');
const { runKeyFor, identityRefusal } = require('../task-run.ts');
const { inWorkerSession } = require('../context/identity.ts');
const attempts = require('../task-attempts.ts');
const { RELAY_LABEL } = require('../relay-label.ts');
const { removeSpool } = require('./channel-spool.ts');

/** A `cancelling` run whose request is younger than this belongs to the canceller that holds it. */
const CANCEL_TAKEOVER_MS = 30000;
/** How long a cancel of a launching run waits for its supervisor: its own escalation of a
 * SIGTERM-ignoring worker, both waits and both `ps` bounds (IC-021 step 3, DEC-040, DEC-064). */
const LAUNCH_WAIT_MS = processTree.KILL_GRACE_MS + processTree.KILL_FINAL_MS + 2 * processTree.PS_TIMEOUT_MS;
const SOURCES = Object.freeze(['user', 'timeout', 'operator']);

/** Thrown inside a locked transition to abandon it with a refusal and no write. */
class Refused extends Error {
  declare result: any;
  constructor(result: any) {
    super(result.reason);
    this.result = result;
  }
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function refused(reason: string, runId: string, extra: any = {}) {
  return { disposition: 'refused', reason, runId, ...extra };
}

/** `<root>/.doflow/state/worker-runs/<slug>.json` gives the lifecycle root and the slug: the 080
 * ledger lives under the same root (data-model.md §1). */
function ledgerFor(file: string) {
  const root = path.resolve(path.dirname(file), '..', '..', '..');
  const slug = path.basename(file, '.json');
  return { root, slug, ledger: attempts.storeFile(root, slug) };
}

/** A `cancelling` run whose request is under 30 s old, or null. Pure. */
function inProgress(run: any, at: Date) {
  if (run.phase !== 'cancelling') return null;
  const requested = Date.parse(run.cancel?.requestedAt);
  if (Number.isFinite(requested) && at.getTime() - requested < CANCEL_TAKEOVER_MS) {
    return refused('cancel-in-progress', run.runId, { requestedAt: run.cancel.requestedAt });
  }
  return null;
}

const pidOf = (entry: any) => (entry && typeof entry === 'object' ? entry.pid : entry);

function union(a: any[] = [], b: any[] = []) {
  const seen = new Map<any, any>();
  for (const entry of [...a, ...b]) if (!seen.has(pidOf(entry))) seen.set(pidOf(entry), entry);
  return [...seen.values()];
}

/**
 * IC-014's add-only rule (DEC-059): a recorded `supervisorCleanup` may only add to `cleanup`. An
 * `unknown` status becomes `verified` only when `supervisorCleanup.status` is `verified`, becomes
 * `survivors` when the supervisor found any, and otherwise stays `unknown` with its own reason; a
 * `verified` one becomes `survivors` when the supervisor found any; the lists are unions.
 */
function mergeCleanup(cleanup: any, supervisorCleanup: any) {
  if (!supervisorCleanup) return cleanup;
  const survivors = union(cleanup?.survivors, supervisorCleanup.survivors);
  const zombies = union(cleanup?.zombies, supervisorCleanup.zombies);
  let status: string;
  if (survivors.length || cleanup?.status === 'survivors') status = 'survivors';
  else if (cleanup?.status === 'verified' || supervisorCleanup.status === 'verified') status = 'verified';
  else status = 'unknown';
  const reason = status === 'unknown' ? cleanup?.reason ?? supervisorCleanup.reason ?? null : null;
  return { status, reason, survivors, zombies };
}

/** Polls the store until the supervisor has exited or recorded `supervisorCleanup`, up to `budgetMs`. */
async function waitForSupervisor({ file, runId, supervisor, platform, budgetMs, sleep, clock }: any) {
  const until = clock().getTime() + budgetMs;
  for (;;) {
    const run = readRuns(file)[runId];
    if (run?.supervisorCleanup) return { run, supervisorAlive: false };
    const live = supervisor ? processTree.alive(supervisor, { platform }) : false;
    if (live === false || clock().getTime() >= until) return { run, supervisorAlive: live };
    await sleep(processTree.POLL_MS);
  }
}

/** IC-021 step 3 for the record step 2 returned. */
async function endTree({ file, runId, run, platform, sleep, clock, escalate }: any) {
  if (platform === 'win32') {
    if (run.worker) await escalate({ proc: run.worker, platform });
    return { status: 'unknown', reason: 'win32', survivors: [], zombies: [] };
  }
  if (run.worker) return escalate({ proc: run.worker, platform });
  // A starting run. With no `launchingAt` the supervisor's launch transition is refused and it
  // spawns nothing (DEC-040).
  if (!run.launchingAt) return { status: 'verified', reason: 'not-launched', survivors: [], zombies: [] };
  // `launchingAt` and no `worker`: the supervisor may already have spawned. Its own `running`
  // transition is refused, so it kills its worker and records `supervisorCleanup`; wait for that,
  // then end the supervisor's tree when it still runs. The verdict stays `unknown` here: only a
  // recorded `supervisorCleanup` resolves it, at step 5.
  const waited = await waitForSupervisor({ file, runId, supervisor: run.supervisor, platform, budgetMs: LAUNCH_WAIT_MS, sleep, clock });
  let survivors: any[] = [];
  let zombies: any[] = [];
  if (waited.supervisorAlive === true) {
    const outcome = await escalate({ proc: run.supervisor, platform });
    survivors = outcome.survivors;
    zombies = outcome.zombies;
  }
  return { status: 'unknown', reason: 'worker-unrecorded', survivors, zombies };
}

/** 082 IC-015: what step 4 records for a child run, which has no 080 attempt of its own. */
const CHILD_SKIP = Object.freeze({ disposition: 'skipped', reason: 'child-run' });
/** 165 D1, RK4: a started main session has no 080 attempt, so step 4 is skipped and the attempt store is not read or written. */
const MAIN_SESSION_SKIP = Object.freeze({ disposition: 'skipped', reason: 'main-session' });

/** IC-021 step 1's identity refusal for `key`. An operator cancel (162 DEC-007) also needs a caller
 * outside every worker session and every run: role `main`, lineage kind `default-main`. */
function callerRefusal(key: any, env: any, source: string) {
  const { role, lineageKind } = key.identity;
  if (source === 'operator' && (inWorkerSession(env) || role !== 'main' || lineageKind !== 'default-main')) return { reason: 'operator-in-run' };
  return identityRefusal(key.identity);
}

/** IC-021 step 4: 080's cancel, its refusal recorded and its throw stored (DEC-046). */
function attemptCancelStep({ file, run, by, reason, env, cwd, clock, cancelImpl }: any) {
  const { root, slug, ledger } = ledgerFor(file);
  try {
    const answer = cancelImpl({
      file: ledger, fsImpl: fs, roots: [...new Set([path.resolve(cwd), root])], slug,
      task: run.task, token: run.token, by, reason, env, cwd, now: clock(),
    });
    return { disposition: answer?.disposition ?? 'error', reason: answer?.reason ?? null };
  } catch (error: any) {
    return { disposition: 'error', reason: typeof error?.code === 'string' && error.code ? error.code : 'cancel-threw' };
  }
}

/**
 * IC-021 steps 1 to 5. `now` is a clock function (default `() => new Date()`) or a fixed Date.
 * Refusals return `{ disposition: 'refused', reason, runId, ... }` with nothing written or
 * signalled; success returns `{ disposition: 'cancelled', runId, endState, cleanup, attemptCancel,
 * attemptCancelled }`, survivors included. `cancelImpl`, `escalate` and `sleep` default to the real
 * 080 cancel, A.3's escalation and a timer, and exist for in-process tests.
 */
async function cancelRun({
  file, runId, by, reason, source = 'user', env = process.env, cwd = process.cwd(), platform = process.platform,
  now = () => new Date(), cancelImpl = attempts.cancel, escalate = processTree.escalate, sleep = defaultSleep,
}: any) {
  if (!by || !attempts.SAFE_NAME.test(String(by))) throw new RunStoreError('usage', '--by is required: the name of the agent or person cancelling the run');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw new RunStoreError('usage', '--reason is required: why the run is being cancelled');
  if (!SOURCES.includes(source)) throw new RunStoreError('usage', `source '${source}' is not one of ${SOURCES.join(', ')}`);
  const operator = source === 'operator';
  if (operator && !RELAY_LABEL.test(String(by))) throw new RunStoreError('usage', `an operator cancel records a relay label, console or device.d-<12 hex>, got '${by}'`);
  const clock = typeof now === 'function' ? now : () => now;

  // Step 1: the calling process's own identity, before anything is read for writing.
  const key = runKeyFor(env, cwd);
  const who = callerRefusal(key, env, source);
  if (who) return refused(who.reason, runId, { runKey: key.runKey });
  const seen = readRuns(file)[runId];
  if (!seen) return refused('unknown-run', runId);
  if (!operator && seen.caller?.runKey !== key.runKey) return refused('foreign-run', runId, { runKey: seen.caller?.runKey ?? null });
  if (seen.phase === 'ended') return refused('run-ended', runId, { endState: seen.end?.state ?? null });
  const early = inProgress(seen, clock());
  if (early) return early;

  // Step 2: the same checks again under the lock, then `cancelling`.
  const requestedAt = clock();
  let marked: any;
  try {
    marked = transition(file, runId, ['starting', 'running', 'cancelling'], (run: any) => {
      if (!operator && run.caller?.runKey !== key.runKey) throw new Refused(refused('foreign-run', runId, { runKey: run.caller?.runKey ?? null }));
      const busy = inProgress(run, requestedAt);
      if (busy) throw new Refused(busy);
      run.phase = 'cancelling';
      run.cancel = { requestedAt: requestedAt.toISOString(), by: String(by), reason: why, source };
    });
  } catch (error: any) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
  if (!marked.applied) {
    if (marked.reason === 'unknown-run') return refused('unknown-run', runId);
    return refused('run-ended', runId, { endState: marked.run?.end?.state ?? null });
  }

  // Step 3, outside every lock.
  const cleanup = await endTree({ file, runId, run: marked.run, platform, sleep, clock, escalate });

  // Step 4, after the tree is ended.
  const attemptCancel = marked.run.childOf
    ? { ...CHILD_SKIP }
    : marked.run.kind === 'main-session'
    ? { ...MAIN_SESSION_SKIP }
    : attemptCancelStep({ file, run: marked.run, by: String(by), reason: why, env, cwd, clock, cancelImpl });

  // Step 5: always written.
  const endState = source === 'timeout' ? 'timed-out' : 'cancelled';
  const ended = transition(file, runId, ['cancelling'], (run: any) => {
    run.attemptCancel = attemptCancel;
    run.cleanup = mergeCleanup(cleanup, run.supervisorCleanup);
    run.end = { state: endState, at: clock().toISOString() };
    run.phase = 'ended';
  });
  if (!ended.applied) return refused('run-ended', runId, { endState: ended.run?.end?.state ?? null, cleanup, attemptCancel });
  if (marked.run.kind === 'main-session' && processTree.alive(marked.run.supervisor, { platform }) !== true) {
    try { removeSpool(ledgerFor(file).root, runId); } catch { /* upkeep's 1-day bound removes it */ }
  }
  return {
    disposition: 'cancelled',
    runId,
    endState,
    cleanup: ended.run.cleanup,
    attemptCancel,
    attemptCancelled: attemptCancel.disposition === 'cancelled',
  };
}

module.exports = { cancelRun, callerRefusal, mergeCleanup, RELAY_LABEL, CANCEL_TAKEOVER_MS, LAUNCH_WAIT_MS };
