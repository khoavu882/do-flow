'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Task run records (feature 080, design C4): the run key, who may act on a run, the run record,
// its totals, the aggregate budget check and the resume epoch.
//
// `runKeyFor` is the one probe here: it reads the environment and walks up to `.git`, so it runs
// before the ledger lock. Every other function is pure over the parsed ledger object and is called
// inside `mutate()`'s `apply`: none reads a file, starts a process or reads the clock (`now` is
// passed in). A refusal is returned as `{ reason, ...fields }` or `null`; the caller wraps it in
// its own `{ write: false, result: { disposition: 'refused', ... } }`.

const { cwdHash, resolveIdentity } = require('./context/identity.ts');
const { findWorkTreeTop } = require('./source-version.ts');
const { taskAttemptLimit, graphDigest, graphTuples } = require('./task-graph.ts');

type Env = Record<string, string | undefined>;

/** IC-009: `null` attempts means the limit derived from the graph; `null` tokens means no limit. */
interface RunBudget { attempts: number | null; tokens: number | null }

interface RunTotals {
  attempts: number;
  tokens: { measured: number; estimated: number; reserved: number };
  unreported: number;
}

interface RunKey { runKey: string; top: string; identity: any }

/**
 * IC-011: the caller's run key. `top` is the worktree top above the identity's worktree (or the
 * worktree itself outside git), so every subdirectory of one worktree reaches the same run. No
 * flag sets or overrides it. The raw `identity.worktree` stays on `identity` for `scopeContext`.
 */
function runKeyFor(env: Env, cwd: string): RunKey {
  const identity = resolveIdentity(env, { cwd, sessionId: '' });
  const top = findWorkTreeTop(identity.worktree).top ?? identity.worktree;
  return { runKey: `${cwdHash(top)}/${identity.run}/${identity.lineage}`, top, identity };
}

/** IC-011: a `solo` lineage may not start, pause, cancel, resume or reopen a run, because every
 * solo session would share one. */
function refuseSolo(identity: any) {
  return identity && identity.lineage === 'solo' ? { reason: 'identity-solo' } : null;
}

/** IC-026 / DEC-006: a worker session claims nothing in a graph plan and opens no run; it finishes
 * with the token it was handed. */
function refuseWorker(identity: any) {
  return identity && identity.role === 'worker' ? { reason: 'worker-session' } : null;
}

function normalizeBudget(budget: any): RunBudget {
  const pick = (v: any) => (Number.isInteger(v) && v >= 0 ? v : null);
  return { attempts: pick(budget && budget.attempts), tokens: pick(budget && budget.tokens) };
}

function emptyTotals(): RunTotals {
  return { attempts: 0, tokens: { measured: 0, estimated: 0, reserved: 0 }, unreported: 0 };
}

/**
 * IC-010: a new run record for `key` (the `runKeyFor` result), `control: 'running'`, with an empty
 * history. `epoch` is 1 for `start` and for a resume that creates the run (IC-025); a legacy-plan
 * claim passes the epoch it records. The caller refreshes `graphDigest`, `graphTasks` and `totals`
 * and appends history.
 */
function createRun(key: RunKey, budget: any, now: Date, { epoch = 1 }: { epoch?: number } = {}) {
  if (!Number.isInteger(epoch) || epoch < 0) throw new TypeError(`createRun: epoch must be a non-negative integer, got ${epoch}`);
  const { identity } = key;
  return {
    runKey: key.runKey,
    worktreeKey: key.runKey.split('/')[0],
    run: identity.run,
    lineage: identity.lineage,
    worktree: key.top,
    createdAt: now.toISOString(),
    control: 'running',
    epoch,
    budget: normalizeBudget(budget),
    totals: emptyTotals(),
    graphDigest: null as string | null,
    graphTasks: null as unknown[][] | null,
    history: [] as any[],
  };
}

function reported(a: any) {
  return Boolean(a.usage) && Number.isInteger(a.usage.tokens) && a.usage.tokens >= 0;
}

/**
 * IC-009: totals over every attempt carrying `runKey`, recomputed from the attempt list (never
 * from the stored copy). Reported usage adds to its basis, including a reported 0; an active
 * attempt's reservation is `reserved`; a cancelled attempt cannot report, so its reservation is
 * `estimated`; a finished or released attempt with no usage is `unreported`.
 */
function computeTotals(store: any, runKey: string): RunTotals {
  const totals = emptyTotals();
  const tasks = store && store.tasks && typeof store.tasks === 'object' ? store.tasks : {};
  for (const entry of Object.values<any>(tasks)) {
    const attempts: any[] = entry && Array.isArray(entry.attempts) ? entry.attempts : [];
    for (const a of attempts) {
      if (a.runKey !== runKey) continue;
      totals.attempts += 1;
      const reserve = a.reserve && Number.isInteger(a.reserve.tokens) ? a.reserve.tokens : 0;
      if (reported(a)) {
        if (a.usage.basis === 'measured') totals.tokens.measured += a.usage.tokens;
        else totals.tokens.estimated += a.usage.tokens;
      } else if (a.state === 'active') totals.tokens.reserved += reserve;
      else if (a.state === 'cancelled') totals.tokens.estimated += reserve;
      else if (a.state === 'finished' || a.state === 'released') totals.unreported += 1;
    }
  }
  return totals;
}

/** IC-009: the run's attempt limit (its own, else the sum of the graph's task limits) and token
 * limit (its own, else none). `run` may be absent: a legacy-plan claim before its record exists. */
function effectiveLimits(run: any, graph: any) {
  const budget = normalizeBudget(run && run.budget);
  const attempts = budget.attempts ?? (graph && Array.isArray(graph.tasks)
    ? graph.tasks.reduce((sum: number, t: any) => sum + taskAttemptLimit(t).limit, 0)
    : 0);
  return { attempts, tokens: budget.tokens };
}

/**
 * IC-006 step 12, the aggregate half, in IC-009's order. With a token limit: no reservation,
 * then unreported usage (DEC-011), then the token limit. With or without one: the attempt limit.
 */
function aggregateRefusal(run: any, totals: RunTotals, graph: any, reserveTokens?: number | null) {
  const limits = effectiveLimits(run, graph);
  const { measured, estimated, reserved } = totals.tokens;
  if (limits.tokens !== null) {
    const reserve = Number.isInteger(reserveTokens) ? (reserveTokens as number) : 0;
    if (reserve <= 0) return { reason: 'reservation-required', limit: limits.tokens };
    if (totals.unreported > 0) return { reason: 'aggregate-unaccounted', unreported: totals.unreported };
    if (measured + estimated + reserved + reserve > limits.tokens) {
      return {
        reason: 'aggregate-exhausted', scope: 'run', measure: 'tokens', limit: limits.tokens,
        used: measured + estimated, reserved, basis: { measured, estimated },
      };
    }
  }
  if (totals.attempts + 1 > limits.attempts) {
    return {
      reason: 'aggregate-exhausted', scope: 'run', measure: 'attempts', limit: limits.attempts,
      used: totals.attempts, reserved: 0, basis: null,
    };
  }
  return null;
}

/** IC-006 step 7: a paused or cancelled run refuses claims. An absent run is running. */
function controlRefusal(run: any, runKey: string) {
  if (run && run.control === 'paused') return { reason: 'run-paused', runKey };
  if (run && run.control === 'cancelled') return { reason: 'run-cancelled', runKey };
  return null;
}

/** IC-025 / DEC-007, IC-006 step 8 (graph plans only): the run must exist and `epoch` must equal
 * its epoch. Absent, old or future epochs are all `resume-required`, naming the current one. */
function epochRefusal(run: any, runKey: string, epoch?: number | null) {
  if (run && Number.isInteger(epoch) && epoch === run.epoch) return null;
  return { reason: 'resume-required', runKey, epoch: run ? run.epoch : null };
}

/** IC-025: the epoch an acknowledged resume issues: `epoch + 1`, or 1 when it creates the run. */
function nextEpoch(run: any) {
  return run && Number.isInteger(run.epoch) ? run.epoch + 1 : 1;
}

// ── run controls (IC-012, IC-026; DEC-005) ────────────────────────────────────────────────────
//
// Each is an `apply` for `mutate()`: it takes the parsed store and the inputs resolved before the
// lock, and returns `{ write, result }`. A refusal returns `write: false`, so it changes nothing.
// None kills a process: ending a worker is 081's.

/** IC-004: above this many tasks a run stores `graphTasks: null` and `graphTruncated: true`. */
const GRAPH_TASKS_LIMIT = 500;

/** IC-004 and IC-009: every run write stores the recorded graph and totals recomputed from the
 * attempt list. */
function refreshRun(store: any, run: any, graph: any) {
  run.graphDigest = graphDigest(graph);
  if (graph.tasks.length > GRAPH_TASKS_LIMIT) {
    run.graphTasks = null;
    run.graphTruncated = true;
  } else {
    run.graphTasks = graphTuples(graph);
    delete run.graphTruncated;
  }
  run.totals = computeTotals(store, run.runKey);
}

function ownRun(store: any, runKey: string) {
  return store.runs && Object.prototype.hasOwnProperty.call(store.runs, runKey) ? store.runs[runKey] : null;
}

/** The caller's run, created when absent. Only start and an acknowledged resume issue an epoch
 * (DEC-007), so a run another control creates has epoch 0, like a legacy claim's (C.2). */
function ensureRun(store: any, key: RunKey, now: Date) {
  if (!store.runs) store.runs = {};
  let run = ownRun(store, key.runKey);
  if (!run) {
    run = createRun(key, null, now, { epoch: 0 });
    store.runs[key.runKey] = run;
  }
  return run;
}

/** IC-011, IC-026: a solo lineage or a worker session may not act on a run. */
function identityRefusal(identity: any) {
  return refuseSolo(identity) || refuseWorker(identity);
}

function refusedControl(reason: string, runKey: string, extra: any = {}) {
  return { write: false, result: { disposition: 'refused', reason, runKey, ...extra } };
}

/** IC-012 `start`: creates the caller's run with `epoch: 1` and history `start`. `budget` is
 * `{ attempts, tokens }`, each a whole number or null. */
function startRun(store: any, { key, graph, by, budget, now }: { key: RunKey; graph: any; by: string; budget: any; now: Date }) {
  const who = identityRefusal(key.identity);
  if (who) return refusedControl(who.reason, key.runKey);
  if (ownRun(store, key.runKey)) return refusedControl('run-exists', key.runKey);
  if (!store.runs) store.runs = {};
  const run = createRun(key, budget, now, { epoch: 1 });
  store.runs[key.runKey] = run;
  run.history.push({ at: now.toISOString(), action: 'start', by, reason: null, epoch: 1 });
  refreshRun(store, run, graph);
  return { write: true, result: { disposition: 'started', runKey: key.runKey, epoch: 1, budget: run.budget, revision: store.revision } };
}

/** IC-012 `pause`: the run, created if absent, becomes `paused`; active attempts are untouched and
 * may still finish (IC-007). */
function pauseRun(store: any, { key, graph, by, reason, now }: { key: RunKey; graph: any; by: string; reason: string; now: Date }) {
  const who = identityRefusal(key.identity);
  if (who) return refusedControl(who.reason, key.runKey);
  const existing = ownRun(store, key.runKey);
  if (existing && existing.control === 'paused') return refusedControl('control-unchanged', key.runKey, { control: 'paused' });
  if (existing && existing.control === 'cancelled') return refusedControl('run-cancelled', key.runKey);
  const run = ensureRun(store, key, now);
  run.control = 'paused';
  run.history.push({ at: now.toISOString(), action: 'pause', by, reason });
  refreshRun(store, run, graph);
  return { write: true, result: { disposition: 'paused', runKey: key.runKey, revision: store.revision } };
}

function activeAttempts(store: any) {
  const out: Array<{ taskId: string; attempt: any }> = [];
  for (const [taskId, entry] of Object.entries<any>(store.tasks || {})) {
    for (const attempt of entry.attempts) if (attempt.state === 'active') out.push({ taskId, attempt });
  }
  return out;
}

/**
 * IC-012 run `cancel`: every active attempt carrying this run key becomes `cancelled`. With
 * `adoptUnowned`, an active attempt with no run key is first given this one and cancelled with
 * `adopted: true` (critic A m7). Active attempts of other runs, and runKey-less ones without
 * `adoptUnowned`, are listed in `notCancelled` and left alone. `cancelled` names every attempt
 * this call cancelled, adopted ones included; `adopted` is that subset.
 */
function cancelRun(store: any, { key, graph, by, reason, adoptUnowned = false, now }: { key: RunKey; graph: any; by: string; reason: string; adoptUnowned?: boolean; now: Date }) {
  const who = identityRefusal(key.identity);
  if (who) return refusedControl(who.reason, key.runKey);
  const existing = ownRun(store, key.runKey);
  if (existing && existing.control === 'cancelled') return refusedControl('control-unchanged', key.runKey, { control: 'cancelled' });
  const run = ensureRun(store, key, now);
  const at = now.toISOString();
  const cancelled: Array<{ taskId: string; token: number }> = [];
  const adopted: Array<{ taskId: string; token: number }> = [];
  const notCancelled: Array<{ taskId: string; token: number; runKey: string | null }> = [];
  for (const { taskId, attempt } of activeAttempts(store)) {
    const owned = attempt.runKey === key.runKey;
    const adopt = !attempt.runKey && adoptUnowned;
    if (!owned && !adopt) {
      notCancelled.push({ taskId, token: attempt.token, runKey: attempt.runKey || null });
      continue;
    }
    if (adopt) {
      attempt.runKey = key.runKey;
      adopted.push({ taskId, token: attempt.token });
    }
    attempt.state = 'cancelled';
    attempt.cancel = adopt ? { at, by, reason, adopted: true } : { at, by, reason };
    cancelled.push({ taskId, token: attempt.token });
  }
  run.control = 'cancelled';
  run.history.push({ at, action: 'cancel', by, reason, cancelled });
  refreshRun(store, run, graph);
  return {
    write: true,
    result: { disposition: 'cancelled', runKey: key.runKey, cancelled, adopted, notCancelled, revision: store.revision },
  };
}

/** IC-012 attempt `cancel`: the task's active attempt holding `token`, which must carry this run
 * key, becomes `cancelled`; the run's control is unchanged. */
function cancelAttempt(store: any, { key, graph, task, token, by, reason, now }: { key: RunKey; graph: any; task: string; token: number; by: string; reason: string; now: Date }) {
  const who = identityRefusal(key.identity);
  if (who) return refusedControl(who.reason, key.runKey, { taskId: task, token });
  const entry = store.tasks && store.tasks[task];
  const active = entry ? entry.attempts.find((a: any) => a.state === 'active') || null : null;
  if (!active) return refusedControl('no-active-attempt', key.runKey, { taskId: task, token });
  if (active.token !== token) return refusedControl('token-mismatch', key.runKey, { taskId: task, token, activeToken: active.token });
  if (active.runKey !== key.runKey) {
    return { write: false, result: { disposition: 'refused', reason: 'foreign-run', taskId: task, token, runKey: active.runKey || null } };
  }
  const run = ensureRun(store, key, now);
  const at = now.toISOString();
  active.state = 'cancelled';
  active.cancel = { at, by, reason };
  const cancelled = [{ taskId: task, token }];
  run.history.push({ at, action: 'cancel', by, reason, cancelled });
  refreshRun(store, run, graph);
  return {
    write: true,
    result: { disposition: 'cancelled', runKey: key.runKey, taskId: task, token, control: run.control, cancelled, revision: store.revision },
  };
}

module.exports = {
  runKeyFor, refuseSolo, refuseWorker, createRun, computeTotals, effectiveLimits,
  aggregateRefusal, controlRefusal, epochRefusal, nextEpoch,
  GRAPH_TASKS_LIMIT, refreshRun, ensureRun, identityRefusal, startRun, pauseRun, cancelRun, cancelAttempt,
};
