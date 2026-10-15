'use strict';

// Feature 081 C.1 (IC-021, IC-020 end state; DEC-005, DEC-038, DEC-040, DEC-046, DEC-047, DEC-050):
// the cancel sequence, shared by the `worker --action cancel` command and the supervisor's timeout.
//
// In order: (1) refusals before any write or signal, against the calling process's own identity;
// (2) the `cancelling` transition; (3) the tree escalation, outside every lock; (4) 080's attempt
// cancel, in process, with the caller's own `env` and `cwd` and no rebuilt identity, a refusal
// recorded and a throw stored as `disposition: 'error'`; (5) the end, always written once step 2
// applied. The escalation runs before the 080 cancel, so an 080 failure never leaves the tree alive.
//
// This module makes no fs write call: every write goes through the run store's `transition`, and
// the 080 ledger is written only by 080's own `cancel` (G26 (b), IC-027).

const fs = require('node:fs');
const path = require('node:path');
const { readRuns, transition, RunStoreError } = require('./run-store.ts');
const processTree = require('./process-tree.ts');
const { runKeyFor, identityRefusal } = require('../task-run.ts');
const attempts = require('../task-attempts.ts');

/** 080's `SAFE_NAME`, which `--by` must match. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
/** A `cancelling` run whose request is younger than this belongs to the canceller that holds it. */
const CANCEL_TAKEOVER_MS = 30000;
/** How long a cancel of a launching run waits for its supervisor (IC-021 step 3, DEC-040). */
const LAUNCH_WAIT_MS = processTree.KILL_GRACE_MS + 1000;
const SOURCES = Object.freeze(['user', 'timeout']);

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
 * IC-014's add-only rule: a recorded `supervisorCleanup` may only add to `cleanup`. An `unknown`
 * status becomes `verified` with no survivors or `survivors` with them; a `verified` one becomes
 * `survivors` when the supervisor found any; the survivor and zombie lists are unions.
 */
function mergeCleanup(cleanup: any, supervisorCleanup: any) {
  if (!supervisorCleanup) return cleanup;
  const survivors = union(cleanup?.survivors, supervisorCleanup.survivors);
  const zombies = union(cleanup?.zombies, supervisorCleanup.zombies);
  const status = survivors.length ? 'survivors' : (cleanup?.status === 'survivors' ? 'survivors' : 'verified');
  return { status, reason: status === 'verified' || status === 'survivors' ? null : cleanup?.reason ?? null, survivors, zombies };
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
  if (!by || !SAFE_NAME.test(String(by))) throw new RunStoreError('usage', '--by is required: the name of the agent or person cancelling the run');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw new RunStoreError('usage', '--reason is required: why the run is being cancelled');
  if (!SOURCES.includes(source)) throw new RunStoreError('usage', `source '${source}' is not one of ${SOURCES.join(', ')}`);
  const clock = typeof now === 'function' ? now : () => now;

  // Step 1: the calling process's own identity, before anything is read for writing.
  const key = runKeyFor(env, cwd);
  const who = identityRefusal(key.identity);
  if (who) return refused(who.reason, runId, { runKey: key.runKey });
  const seen = readRuns(file)[runId];
  if (!seen) return refused('unknown-run', runId);
  if (seen.caller?.runKey !== key.runKey) return refused('foreign-run', runId, { runKey: seen.caller?.runKey ?? null });
  if (seen.phase === 'ended') return refused('run-ended', runId, { endState: seen.end?.state ?? null });
  const early = inProgress(seen, clock());
  if (early) return early;

  // Step 2: the same checks again under the lock, then `cancelling`.
  const requestedAt = clock();
  let marked: any;
  try {
    marked = transition(file, runId, ['starting', 'running', 'cancelling'], (run: any) => {
      if (run.caller?.runKey !== key.runKey) throw new Refused(refused('foreign-run', runId, { runKey: run.caller?.runKey ?? null }));
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
  const attemptCancel = attemptCancelStep({ file, run: marked.run, by: String(by), reason: why, env, cwd, clock, cancelImpl });

  // Step 5: always written.
  const endState = source === 'timeout' ? 'timed-out' : 'cancelled';
  const ended = transition(file, runId, ['cancelling'], (run: any) => {
    run.attemptCancel = attemptCancel;
    run.cleanup = mergeCleanup(cleanup, run.supervisorCleanup);
    run.end = { state: endState, at: clock().toISOString() };
    run.phase = 'ended';
  });
  if (!ended.applied) return refused('run-ended', runId, { endState: ended.run?.end?.state ?? null, cleanup, attemptCancel });
  return {
    disposition: 'cancelled',
    runId,
    endState,
    cleanup: ended.run.cleanup,
    attemptCancel,
    attemptCancelled: attemptCancel.disposition === 'cancelled',
  };
}

module.exports = { cancelRun, mergeCleanup, CANCEL_TAKEOVER_MS, LAUNCH_WAIT_MS };
