'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Task run records (feature 080, design C4): the run key, who may act on a run, the run record,
// its totals, the aggregate budget check and the resume epoch.
//
// `runKeyFor` is one probe here: it reads the environment and walks up to `.git`, so it runs
// before the ledger lock. `resumeRun` runs the resume probes (source re-measure, scopeContext, git
// branch) before its lock. Every other function is pure over the parsed ledger object and is called
// inside `mutate()`'s `apply`: none reads a file, starts a process or reads the clock (`now` is
// passed in). A refusal is returned as `{ reason, ...fields }` or `null`; the caller wraps it in
// its own `{ write: false, result: { disposition: 'refused', ... } }`.

const { cwdHash, resolveIdentity } = require('./context/identity.ts');
const { findWorkTreeTop } = require('./source-version.ts');
const crypto = require('node:crypto');
const { taskAttemptLimit, graphDigest, graphTuples, deriveTasks, isGraphPlan, overlaps } = require('./task-graph.ts');
const { measureSources, compareSources } = require('./task-sources.ts');

type Env = Record<string, string | undefined>;

/** IC-009: `null` attempts means the limit derived from the graph; `null` tokens means no limit. */
interface RunBudget { attempts: number | null; tokens: number | null }

interface RunTotals {
  attempts: number;
  tokens: { measured: number; estimated: number; reserved: number };
  unreported: number;
}

/** `traceIds` is whether this caller's environment lets a run mint trace ids (088, IC-010): the
 * switch is read where the environment is, because `startRun` is handed only the key. A key built
 * by hand leaves it out and `traceIdsOn` reads the process environment. */
interface RunKey { runKey: string; top: string; identity: any; traceIds?: boolean }

/**
 * IC-011: the caller's run key. `top` is the worktree top above the identity's worktree (or the
 * worktree itself outside git), so every subdirectory of one worktree reaches the same run. No
 * flag sets or overrides it. The raw `identity.worktree` stays on `identity` for `scopeContext`.
 */
function runKeyFor(env: Env, cwd: string): RunKey {
  const identity = resolveIdentity(env, { cwd, sessionId: '' });
  const top = findWorkTreeTop(identity.worktree).top ?? identity.worktree;
  return { runKey: `${cwdHash(top)}/${identity.run}/${identity.lineage}`, top, identity, traceIds: traceSwitchOn(env) };
}

/** 088 DD-5: the telemetry switch read through its one reader. `telemetry.ts` is required here, not
 * at load, so a module user that never reaches a run key does not load the trace modules. A fault
 * reading the switch means no ids. */
function traceSwitchOn(env: Env): boolean {
  try { return !require('./trace/telemetry.ts').telemetryOff(env); } catch { return false; }
}

/** Whether `key` may mint trace ids: its own flag, else the given environment. */
function traceIdsOn(key: RunKey, env: Env = process.env): boolean {
  return typeof key.traceIds === 'boolean' ? key.traceIds : traceSwitchOn(env);
}

/** 088 IC-010: a fresh 128-bit id as 32 lowercase hex, or null when telemetry is off or the id
 * source faults. Minting never fails the mutation that calls it. */
function mintTraceId(on: boolean): string | null {
  if (!on) return null;
  try {
    const id = crypto.randomBytes(16).toString('hex');
    return /^[0-9a-f]{32}$/.test(id) ? id : null;
  } catch { return null; }
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
 * `estimated`; a finished, released or superseded attempt with no usage is `unreported`
 * (DEC-017 superseded-unreported: a reopen does not launder an unreported attempt out of DEC-011).
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
      else if (a.state === 'finished' || a.state === 'released' || a.state === 'superseded') totals.unreported += 1;
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
 * its epoch. Absent, old or future epochs are all `resume-required`, naming the current one.
 * DEC-019 epoch-zero-never-matches: an epoch-0 run (created by a legacy claim or a control) has
 * never been started or resumed, so it matches no epoch. */
function epochRefusal(run: any, runKey: string, epoch?: number | null) {
  if (run && Number.isInteger(run.epoch) && run.epoch >= 1 && Number.isInteger(epoch) && epoch === run.epoch) return null;
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
  const run: any = createRun(key, budget, now, { epoch: 1 });
  store.runs[key.runKey] = run;
  const entry: any = { at: now.toISOString(), action: 'start', by, reason: null, epoch: 1 };
  const traceId = mintTraceId(traceIdsOn(key));
  if (traceId) { run.traceId = traceId; entry.traceId = traceId; }
  run.history.push(entry);
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

// ── resume (IC-015, IC-025; DEC-004, DEC-007, DEC-010) ────────────────────────────────────────
//
// The probes (IC-013 re-measure, IC-014 scopeContext and the git branch) run before any lock in
// `resumeRun`; everything else here is pure over the parsed store, so the locked `apply` can
// rebuild the ledger-derived half of the report and recompute the digest against what is on disk.

/**
 * IC-005 row 4: the cancelled attempts a resume has cleared. A cancel is cleared when the run its
 * attempt's `runKey` names has a `resume` history entry that lists it in `cleared`, or that is
 * later than `cancel.at`. Pure; an empty list for a store with no cancelled attempt (every
 * `8ce5ad7` store).
 */
function clearedCancels(store: any): Array<{ taskId: string; token: number }> {
  const out: Array<{ taskId: string; token: number }> = [];
  const runs = store && store.runs && typeof store.runs === 'object' ? store.runs : null;
  if (!runs) return out;
  for (const [taskId, entry] of Object.entries<any>(store.tasks || {})) {
    const attempts: any[] = entry && Array.isArray(entry.attempts) ? entry.attempts : [];
    for (const a of attempts) {
      if (!a || a.state !== 'cancelled' || !a.runKey) continue;
      const run = ownRun(store, a.runKey);
      const history: any[] = run && Array.isArray(run.history) ? run.history : [];
      const at = a.cancel && typeof a.cancel.at === 'string' ? a.cancel.at : null;
      const cleared = history.some((h: any) => h && h.action === 'resume' && (
        (Array.isArray(h.cleared) && h.cleared.some((c: any) => c && c.taskId === taskId && c.token === a.token))
        || (at !== null && typeof h.at === 'string' && h.at > at)));
      if (cleared) out.push({ taskId, token: a.token });
    }
  }
  return out;
}

/** Ids in plan order, then any ledger-only ids sorted, so a report's order never depends on the
 * order keys were written. */
function taskOrder(store: any, graph: any): string[] {
  const planned = graph.tasks.map((t: any) => t.id);
  const extra = Object.keys(store.tasks || {}).filter((id) => !planned.includes(id)).sort();
  return [...planned, ...extra];
}

/**
 * IC-013 at resume: the attempt each task's source comparison reads. A SUCCEEDED task compares
 * its done attempt (listed under `doneChanged`); any other task its highest-token attempt. A task
 * with no attempt, or whose attempt recorded no sources and whose plan line declares no files,
 * has nothing to compare. `measure` is false when the comparison is unverifiable without a disk
 * access (no `sources`, or `sourcesTruncated`).
 */
function resumeTargets(store: any, graph: any, derived: any[]) {
  const targets: Array<{ taskId: string; token: number; done: boolean; attempt: any; measure: boolean; declared: number }> = [];
  for (const record of derived) {
    const entry = store.tasks && store.tasks[record.id];
    const attempts: any[] = entry && Array.isArray(entry.attempts) ? entry.attempts : [];
    if (!attempts.length) continue;
    const done = record.state === 'SUCCEEDED';
    const attempt = done
      ? attempts.find((a: any) => a.token === record.doneToken)
      : attempts.reduce((a: any, b: any) => (b.token > a.token ? b : a));
    if (!attempt) continue;
    const task = graph.tasks.find((t: any) => t.id === record.id);
    const declared = task && Array.isArray(task.files) ? task.files.length : 0;
    const recorded = Array.isArray(attempt.sources);
    if (!recorded && declared === 0) continue;
    targets.push({ taskId: record.id, token: attempt.token, done, attempt, measure: recorded && !attempt.sourcesTruncated, declared });
  }
  return targets;
}

const targetKey = (taskId: string, token: number) => `${taskId}#${token}`;

/** The resume probes' source half (IC-013): one re-measure per target that can be compared, of
 * the entries its attempt recorded, under its own `execWorktree` and then the plan roots. Reads
 * the filesystem; runs before any lock. */
function probeSources(targets: any[], roots: string[]) {
  const probes = new Map<string, any>();
  for (const t of targets) {
    if (!t.measure) continue;
    const files = t.attempt.sources.map((s: any) => s.file);
    probes.set(targetKey(t.taskId, t.token), measureSources({ files }, t.attempt.execWorktree ?? null, roots));
  }
  return probes;
}

/** `{ taskId, token, count }` for an unverifiable task: `count` is the entries that could not be
 * compared, every recorded (or declared) entry when the cause is the whole task. */
function unverifiableCount(target: any, after: any) {
  const recorded: any[] = Array.isArray(target.attempt.sources) ? target.attempt.sources : [];
  const whole = recorded.length || target.declared;
  if (!target.measure || !after || after.execWorktreeMissing || after.sourcesTruncated) return whole;
  const now = new Map<string, any>(after.sources.map((s: any) => [s.file, s]));
  const opaque = (s: any) => !s || s.kind === 'unhashable' || s.kind === 'unverifiable';
  const missing = recorded.some((s: any) => !now.has(s.file));
  if (missing) return whole;
  return recorded.filter((s: any) => opaque(s) || opaque(now.get(s.file))).length;
}

/** IC-004 at resume: the recorded digest against the current one and, when the run stored its
 * tuple list, the ids added, removed and changed. */
function graphComparison(run: any, graph: any) {
  const current = graphDigest(graph);
  const recorded = run && typeof run.graphDigest === 'string' ? run.graphDigest : null;
  const truncated = Boolean(run && run.graphTruncated);
  const out = { recorded, current, changed: recorded !== null && recorded !== current, added: [] as string[], removed: [] as string[], changedIds: [] as string[], truncated };
  if (!run || !Array.isArray(run.graphTasks)) return out;
  const before = new Map<string, string>(run.graphTasks.map((tuple: any) => [String(tuple[0]), JSON.stringify(tuple)]));
  const after = new Map<string, string>(graphTuples(graph).map((tuple: any) => [String(tuple[0]), JSON.stringify(tuple)]));
  for (const [id, tuple] of after) {
    if (!before.has(id)) out.added.push(id);
    else if (before.get(id) !== tuple) out.changedIds.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) out.removed.push(id);
  return out;
}

/**
 * IC-015: the resume report from the store (the ledger-derived half) and the probe results
 * (`probes` from `probeSources`, `staleContext` from `compareScopeContext`). Pure: called once
 * outside the lock for the report, and again inside it to recompute the digest. A target with no
 * probe (an attempt claimed after the probes ran) is unverifiable, so the digest moves.
 */
function buildResumeReport(store: any, { key, graph, hashes = null, probes, staleContext, now }: any) {
  const run = ownRun(store, key.runKey);
  const derived = deriveTasks(graph, store, { hashes, clearedCancels: clearedCancels(store) });
  const activeAttempts: any[] = [];
  for (const taskId of taskOrder(store, graph)) {
    const entry = store.tasks[taskId];
    const attempts: any[] = entry && Array.isArray(entry.attempts) ? entry.attempts : [];
    for (const a of attempts.filter((x: any) => x.state === 'active').sort((x: any, y: any) => x.token - y.token)) {
      const started = Date.parse(a.startedAt);
      activeAttempts.push({
        taskId, token: a.token, owner: a.owner, mode: a.mode, startedAt: a.startedAt,
        ageSeconds: Number.isFinite(started) ? Math.max(0, Math.floor((now.getTime() - started) / 1000)) : 0,
        runKey: a.runKey || null, execWorktree: a.execWorktree || null,
      });
    }
  }
  const changedSources: any[] = [];
  const doneChanged: any[] = [];
  const unverifiable: any[] = [];
  for (const target of resumeTargets(store, graph, derived)) {
    const after = probes.get(targetKey(target.taskId, target.token)) || null;
    const compared = target.measure && after ? compareSources(target.attempt, after) : { unverifiable: true, files: [] };
    if (compared.unverifiable) {
      unverifiable.push({ taskId: target.taskId, token: target.token, count: unverifiableCount(target, after) });
      continue;
    }
    const into = target.done ? doneChanged : changedSources;
    for (const f of compared.files) {
      if (f.change !== 'unchanged') into.push({ taskId: target.taskId, token: target.token, file: f.file, change: f.change });
    }
  }
  return {
    runKey: key.runKey,
    control: run ? run.control : 'none',
    epoch: run ? run.epoch : null,
    activeAttempts,
    changedSources,
    doneChanged,
    unverifiable,
    staleContext: staleContext.map((s: any) => ({ kind: s.kind, path: s.path, reasons: [...s.reasons] })),
    graph: graphComparison(run, graph),
  };
}

/** JSON with object keys sorted at every level. */
function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** IC-015: `sha256:` over the report's canonical JSON with every `ageSeconds` removed, so an
 * acknowledgement a few seconds later still matches. */
function resumeDigest(report: any): string {
  const stable = { ...report, activeAttempts: report.activeAttempts.map(({ ageSeconds, ...rest }: any) => rest) };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(stable)).digest('hex')}`;
}

/** The current branch of `worktree` (`git symbolic-ref --short -q HEAD`), and, when HEAD is
 * detached or unreadable, its commit (`git rev-parse HEAD`). 2 s per call; a failure is null. */
function probeGit(worktree: string, gitRunner: any) {
  const run = gitRunner || ((args: string[], cwd: string) => {
    const { execFileSync } = require('node:child_process');
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  });
  const clean = (out: any) => (typeof out === 'string' && out.trim() ? out.trim() : null);
  const branch = clean(run(['symbolic-ref', '--short', '-q', 'HEAD'], worktree));
  const commit = branch ? null : clean(run(['rev-parse', 'HEAD'], worktree));
  return { branch, commit };
}

/**
 * IC-015 / IC-025: the resume. `io.read()` returns the store without a lock (`readTaskState`);
 * `io.mutate(apply)` runs `apply(store)` inside the ledger lock and returns its result. The
 * caller has loaded the plan (`graph`, `hashes`) and resolved `key` (`runKeyFor`) and checked the
 * flags.
 *
 * Order: identity refusals (`identity-solo`; `worker-session` in a graph plan); then every probe,
 * before any lock: the store is read, each target's sources re-measured, `scopeContext` called
 * with the raw identity worktree and compared with the branch and commit probed in the run's
 * worktree. Without `ack`: `ack-required` with the report and digest, nothing written. With
 * `ack`: one `mutate()` that rebuilds the ledger-derived half against the disk, recomputes the
 * digest and either refuses `report-changed` (nothing written) or sets `control: 'running'`,
 * issues `nextEpoch`, lists the run's cancelled attempts in the history entry's `cleared` and
 * appends history `resume`. `summary-store.ts` and the git process are loaded here only (IC-022).
 */
function resumeRun(
  io: { read: () => any; mutate: (apply: (store: any) => any) => any },
  { key, graph, hashes = null, roots = [], ack = null, by = null, reason = null, now, env = process.env, gitRunner = null }:
  { key: RunKey; graph: any; hashes?: any; roots?: string[]; ack?: string | null; by?: string | null; reason?: string | null; now: Date; env?: Env; gitRunner?: any },
) {
  const refusal = refuseSolo(key.identity) || (isGraphPlan(graph) ? refuseWorker(key.identity) : null);
  if (refusal) return { disposition: 'refused', reason: refusal.reason, runKey: key.runKey };

  // Probes, before any lock.
  const seen = io.read();
  const targets = resumeTargets(seen, graph, deriveTasks(graph, seen, { hashes, clearedCancels: clearedCancels(seen) }));
  const probes = probeSources(targets, roots);
  const { scopeContext, compareScopeContext } = require('./context/summary-store.ts');
  const context = scopeContext(key.identity.worktree, key.identity.run, key.identity.lineage, env);
  const seenRun = ownRun(seen, key.runKey);
  const { branch, commit } = probeGit(seenRun && seenRun.worktree ? seenRun.worktree : key.top, gitRunner);
  const staleContext = compareScopeContext(context, { worktree: key.identity.worktree, branch, commit });
  const inputs = { key, graph, hashes, probes, staleContext, now };

  if (!ack) {
    const report = buildResumeReport(seen, inputs);
    return { disposition: 'ack-required', report, digest: resumeDigest(report) };
  }

  return io.mutate((store: any) => {
    const report = buildResumeReport(store, inputs);
    const digest = resumeDigest(report);
    if (digest !== ack) return { write: false, result: { disposition: 'refused', reason: 'report-changed', report, digest } };
    if (!store.runs) store.runs = {};
    let run = ownRun(store, key.runKey);
    const epoch = nextEpoch(run);
    if (!run) {
      run = createRun(key, null, now, { epoch });
      store.runs[key.runKey] = run;
    }
    run.control = 'running';
    run.epoch = epoch;
    const cleared: Array<{ taskId: string; token: number }> = [];
    for (const [taskId, entry] of Object.entries<any>(store.tasks || {})) {
      for (const a of entry.attempts) if (a.state === 'cancelled' && a.runKey === key.runKey) cleared.push({ taskId, token: a.token });
    }
    const entry: any = { at: now.toISOString(), action: 'resume', by, reason: reason ?? null, digest, epoch, cleared };
    const traceId = mintTraceId(traceIdsOn(key, env));
    if (traceId) {
      entry.traceId = traceId;
      entry.traceLink = typeof run.traceId === 'string' ? run.traceId : null;
      run.traceId = traceId;
    }
    run.history.push(entry);
    refreshRun(store, run, graph);
    return { write: true, result: { disposition: 'resumed', report, digest, epoch, revision: store.revision } };
  });
}

// ── inspect (IC-016, IC-009 `totalsMismatch`; critic B m2, m4, m6) ────────────────────────────
//
// Pure over a store the caller read with `readTaskState` (no lock, no write, no git process).

/** IC-009: the stored totals equal the recomputed ones. Key order is not compared. */
function sameTotals(stored: any, computed: RunTotals) {
  return canonicalJson(stored === undefined ? null : stored) === canonicalJson(computed);
}

/**
 * Critic B m6: tasks per phase and `[P]` fan-out (the `[P]` tasks of a phase, which may run
 * together). Advisory only: no threshold, never a refusal.
 */
function decompositionAdvisory(graph: any) {
  const phases = graph.phases.map((phase: string) => {
    const tasks = graph.tasks.filter((t: any) => t.phase === phase);
    return { phase, tasks: tasks.length, parallel: tasks.filter((t: any) => t.parallel).length };
  });
  return {
    advisoryOnly: true as const,
    phases,
    maxTasksPerPhase: phases.reduce((m: number, p: any) => Math.max(m, p.tasks), 0),
    maxParallelFanOut: phases.reduce((m: number, p: any) => Math.max(m, p.parallel), 0),
  };
}

/** 088 OI-1: a history entry as it was before trace ids, so `inspect` output does not depend on the
 * telemetry switch (FR-002). */
function withoutTrace(entry: any) {
  if (!entry || typeof entry !== 'object' || (!('traceId' in entry) && !('traceLink' in entry))) return entry;
  const { traceId, traceLink, ...rest } = entry;
  return rest;
}

/**
 * IC-016: the inspect view of the caller's run. `store` is a plain read (`readTaskState`);
 * `graph`, `hashes` and `warnings` come from `loadPlan`; `key` from `runKeyFor`. Pure: nothing is
 * written, no lock is taken and no process runs. `totals` is recomputed from the attempt list and
 * `totalsMismatch` says whether the stored copy differs (IC-009); the stored copy is returned as
 * `storedTotals` only then. `defaults` lists every budget limit that is a default rather than
 * declared (critic B m2), so a caller sees nominal limits without reading each row.
 */
function inspectRun(store: any, { slug, key, graph, hashes = null, warnings = [] }: { slug: string; key: RunKey; graph: any; hashes?: any; warnings?: any[] }) {
  const run = ownRun(store, key.runKey);
  const tasks = deriveTasks(graph, store, { hashes, clearedCancels: clearedCancels(store) });
  const limits = effectiveLimits(run, graph);
  const totals = computeTotals(store, key.runKey);
  const totalsMismatch = Boolean(run) && !sameTotals(run.totals, totals);
  const runView: any = {
    runKey: key.runKey,
    exists: Boolean(run),
    control: run ? run.control : 'none',
    epoch: run ? run.epoch : null,
    budget: { attempts: limits.attempts, tokens: limits.tokens, source: normalizeBudget(run && run.budget).attempts === null ? 'default' : 'run' },
    totals,
    totalsMismatch,
    history: run && Array.isArray(run.history) ? run.history.map(withoutTrace) : [],
  };
  if (totalsMismatch) runView.storedTotals = run.totals === undefined ? null : run.totals;
  return {
    slug,
    revision: Number.isInteger(store.revision) ? store.revision : 0,
    graph: {
      digest: graphDigest(graph),
      graphPlan: isGraphPlan(graph),
      warnings,
      tasks: graph.tasks.map((t: any) => ({
        id: t.id, phase: t.phase, owner: t.owner ?? null, taskDeps: t.taskDeps, parallel: t.parallel,
        acceptance: t.acceptance, files: t.files || [],
      })),
      overlaps: overlaps(graph),
    },
    tasks,
    run: runView,
    defaults: {
      runAttempts: runView.budget.source === 'default',
      tasks: tasks.filter((r: any) => r.budget.source === 'default').map((r: any) => r.id),
    },
    advisory: { decomposition: decompositionAdvisory(graph) },
  };
}

/**
 * IC-016 text: one line per task (`id state reason budget used/limit`, `(default)` on a default
 * limit), then control, epoch, limits with their source and totals with each token figure
 * labelled by basis. Measured and estimated are never summed.
 */
function formatInspect(view: any): string[] {
  const lines: string[] = [];
  const r = view.run;
  if (view.defaults.runAttempts || view.defaults.tasks.length) {
    const what = [
      ...(view.defaults.runAttempts ? ['run attempt limit'] : []),
      ...(view.defaults.tasks.length ? [`task limits of ${view.defaults.tasks.join(', ')}`] : []),
    ];
    lines.push(`DEFAULT BUDGETS: ${what.join('; ')} are defaults, not declared limits`);
  }
  lines.push(`Task attempts for ${view.slug} (revision ${view.revision}, ${view.graph.graphPlan ? 'graph plan' : 'legacy plan'})`);
  for (const t of view.tasks) {
    lines.push(`  ${t.id} ${t.state} ${t.reason} budget ${t.budget.used}/${t.budget.limit}${t.budget.source === 'default' ? ' (default)' : ''}`);
  }
  lines.push(`Run ${r.runKey}: control ${r.control}, epoch ${r.epoch === null ? 'none' : r.epoch}`);
  lines.push(`  limits: attempts ${r.budget.attempts} (${r.budget.source}), tokens ${r.budget.tokens === null ? 'none' : `${r.budget.tokens} (run)`}`);
  const tk = r.totals.tokens;
  lines.push(`  totals: attempts ${r.totals.attempts}; tokens measured ${tk.measured}, estimated ${tk.estimated}, reserved ${tk.reserved}; unreported ${r.totals.unreported}`);
  if (r.totalsMismatch) lines.push('  totals mismatch: the stored totals differ from the attempt list; the figures above are recomputed');
  for (const w of view.graph.warnings) lines.push(`Warning: ${w.kind} ${w.ids.join(' ')}${w.value !== undefined ? ` '${w.value}'` : ''}`);
  for (const o of view.graph.overlaps) lines.push(`Overlap: ${o.a} and ${o.b} both declare ${o.files.join(', ')}`);
  const d = view.advisory.decomposition;
  lines.push(`Advisory (decomposition): ${d.phases.map((p: any) => `${p.phase} ${p.tasks} task${p.tasks === 1 ? '' : 's'}, ${p.parallel} [P]`).join('; ')}`);
  return lines;
}

module.exports = {
  runKeyFor, refuseSolo, refuseWorker, createRun, computeTotals, effectiveLimits,
  aggregateRefusal, controlRefusal, epochRefusal, nextEpoch,
  GRAPH_TASKS_LIMIT, refreshRun, ensureRun, identityRefusal, startRun, pauseRun, cancelRun, cancelAttempt,
  clearedCancels, buildResumeReport, resumeDigest, resumeRun, inspectRun, formatInspect,
};
