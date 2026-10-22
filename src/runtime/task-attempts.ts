'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Task-attempt ledger (feature 070, roadmap P2A first slice).
//
// `do-execute-plan` used to decide a plan task was done from a `[x]` checkbox and a `complete` row
// in state.md, both written by the agent that did the work. This module is the record that does
// not rely on either: one active attempt per plan task, a monotonic fencing token per attempt, and
// a COMPLETED result only against a passing, fresh, task-bound `test-result` from the evidence
// ledger.
//
// What is stored is attempts only. Task structure (ids, phases, the line each task was claimed
// against) is read from plan.md by `parsePlan` on every call, so the ledger cannot drift from the
// plan it describes. Persistence goes through `updateTaskState` (lock, re-read, atomic rename), and
// every decision below is made INSIDE that lock against what is on disk, which is what makes two
// processes claiming one task yield exactly one `claimed`.
//
// The store lives under the clone's main worktree (the lifecycle project root), so every linked
// worktree of one clone reads and writes the same file (FR-007).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { updateTaskState, readTaskState } = require('./task-state.ts');
const { parsePlan } = require('./scaffold/artifacts.ts');
const { buildGraph, planVerdict, deriveTasks, isGraphPlan, doneOf } = require('./task-graph.ts');
const {
  runKeyFor, refuseWorker, computeTotals, aggregateRefusal, controlRefusal, epochRefusal,
  refreshRun, ensureRun, identityRefusal, startRun, pauseRun, cancelRun, cancelAttempt,
  clearedCancels, resumeRun, inspectRun,
} = require('./task-run.ts');
const { measureSources } = require('./task-sources.ts');
const { findWorkTreeTop } = require('./source-version.ts');
const { EvidenceLedger } = require('./evidence-ledger.ts');
const { projectRoot: lifecycleProjectRoot } = require('./lifecycle/root.ts');
const { isSafeSlug } = require('./task-scope.ts');

const SCHEMA_VERSION = 1;
const MODES = Object.freeze(['manual', 'sequential', 'subagent']);
const RESULTS = Object.freeze(['COMPLETED', 'BLOCKED', 'ABANDONED', 'INCONCLUSIVE', 'FAILED']);
const USAGE_BASES = Object.freeze(['measured', 'estimated']);
const RUN_CONTROLS = Object.freeze(['running', 'paused', 'cancelled']);
const ACTIONS = Object.freeze(['claim', 'finish', 'release', 'status', 'start', 'pause', 'cancel', 'resume', 'inspect', 'reopen', 'report-usage']);
const TASK_ID = /^[A-Za-z]+\.\d+$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/** A failure that is the caller's or the environment's, not a finding: exit 2. */
class TaskAttemptError extends Error {
  declare code: any;
  declare problems?: any[];
  constructor(code: any, message: any) {
    super(message);
    this.name = 'TaskAttemptError';
    this.code = code;
  }
}

/** Thrown inside the locked build to abandon a write without touching the store. */
class NoWrite extends Error {}

function storeFile(root: any, slug: any) {
  return path.join(root, '.doflow', 'state', 'task-attempts', `${slug}.json`);
}

function uniq(values: any) { return [...new Set(values)]; }

function assertSlug(slug: any) {
  if (!isSafeSlug(slug)) throw new TaskAttemptError('usage', `'${slug}' is not a valid feature slug`);
  return slug;
}

// ── plan.md ────────────────────────────────────────────────────────────────────────────────────

/** The hash a claim records and `finish` compares: everything about the task's plan line except
 * its checkbox, so ticking the box after a finish is not an edit of the task. A line with neither
 * `acceptance:` nor `budget:` hashes exactly as before IC-002; `parallel` is never hashed. */
function taskLineHash(task: any) {
  const legacy = [task.id, task.description, task.stories, task.owner, task.files, task.dependsOn, task.externalContract];
  const extended = (task.acceptance && task.acceptance.length) || task.budget ? [...legacy, task.acceptance, task.budget] : legacy;
  const material = JSON.stringify(extended);
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

/**
 * The plan's tasks, in plan order, with phase order taken from first appearance.
 * @returns {{planPath: string, tasks: Array<{id: string, phase: string, phaseIndex: number, checked: boolean, hash: string}>}}
 */
function loadPlan({ roots, slug, fsImpl = fs }: any) {
  const relative = path.join('agent-docs', 'doflow', slug, 'plan.md');
  const found = roots.map((root: any) => path.join(root, relative)).find((file: any) => fsImpl.existsSync(file));
  if (!found) throw new TaskAttemptError('plan-unreadable', `no plan.md for feature '${slug}' (looked for ${relative} under ${roots.join(', ')})`);
  let text;
  try { text = fsImpl.readFileSync(found, 'utf8'); } catch (error: any) {
    throw new TaskAttemptError('plan-unreadable', `cannot read ${found}: ${error.message}`);
  }
  const verdict = planVerdict(text);
  const parsed = parsePlan(text);
  if (verdict.tasks === 0) {
    const error = new TaskAttemptError('plan-malformed', `${found} holds no \`- [ ] <phase>.<n>\` tasks: ${parsed.gaps.map((g: any) => g.why).join('; ') || 'nothing to track'}`);
    error.problems = verdict.problems;
    throw error;
  }
  const built = buildGraph(parsed);
  if (!verdict.ok) throw malformedGraph(found, verdict.problems);
  const phases = uniq(parsed.tasks.map((t: any) => t.phase));
  return {
    planPath: relative.split(path.sep).join('/'),
    tasks: parsed.tasks.map((t: any) => ({
      id: t.id, phase: t.phase, phaseIndex: phases.indexOf(t.phase), checked: t.done, hash: taskLineHash(t),
    })),
    graph: built.graph,
    warnings: built.warnings,
  };
}

/** IC-003: `plan-malformed` carrying every problem. A lone `duplicate-id` keeps the pre-080 text. */
function malformedGraph(found: any, problems: any[]) {
  const only = problems.length === 1 ? problems[0] : null;
  const message = only && only.kind === 'duplicate-id'
    ? `plan task id '${only.ids[0]}' appears more than once in ${found}`
    : `${found} has ${problems.length} task-graph problem${problems.length === 1 ? '' : 's'}: ${problems.map(describeProblem).join('; ')}`;
  const error = new TaskAttemptError('plan-malformed', message);
  error.problems = problems;
  return error;
}

function describeProblem(problem: any) {
  const detail = problem.via ? ` via ${problem.via.join(', ')}` : problem.value !== undefined ? ` '${problem.value}'` : '';
  return `${problem.kind}${problem.ids.length ? ` ${problem.ids.join(' ')}` : ''}${detail}`;
}

// ── store ──────────────────────────────────────────────────────────────────────────────────────

function unreadable(file: any, why: any) {
  return new TaskAttemptError('store-unreadable', `${why} Refusing to read or write '${file}'; it was left unchanged.`);
}

/** The store as an object, or a fresh empty one when the file does not exist. Shape-checked: a file
 * that parses but is not a ledger is as unusable as one that does not parse. */
function normalizeStore(data: any, file: any) {
  if (data === null || data === undefined) return { version: SCHEMA_VERSION, revision: 0, planPath: null, tasks: {} };
  if (typeof data !== 'object' || Array.isArray(data) || data.version !== SCHEMA_VERSION
    || typeof data.tasks !== 'object' || data.tasks === null || Array.isArray(data.tasks)) {
    throw unreadable(file, 'It is not a version-1 task-attempt ledger.');
  }
  for (const [id, entry] of (Object.entries(data.tasks) as [string, any][])) {
    if (!entry || !Number.isInteger(entry.nextToken) || !Array.isArray(entry.attempts)) {
      throw unreadable(file, `Task '${id}' has no readable attempt list.`);
    }
  }
  // IC-010: `runs` is optional and additive; the store stays version 1.
  if (data.runs !== undefined) {
    if (typeof data.runs !== 'object' || data.runs === null || Array.isArray(data.runs)) {
      throw unreadable(file, "Its 'runs' is not an object.");
    }
    for (const [key, run] of (Object.entries(data.runs) as [string, any][])) {
      if (!run || typeof run !== 'object' || Array.isArray(run)) throw unreadable(file, `Run '${key}' is not an object.`);
      if (!RUN_CONTROLS.includes(run.control)) throw unreadable(file, `Run '${key}' has control '${run.control}', not one of ${RUN_CONTROLS.join(', ')}.`);
      if (!Number.isInteger(run.epoch) || run.epoch < 0) throw unreadable(file, `Run '${key}' has epoch '${run.epoch}', not a non-negative integer.`);
    }
  }
  return data;
}

function readStore(file: any, fsImpl: any) {
  try {
    return normalizeStore(readTaskState(fsImpl, file), file);
  } catch (error: any) {
    if (error instanceof TaskAttemptError) throw error;
    throw unreadable(file, error.message);
  }
}

/** One locked read-decide-write. `apply(store)` returns `{result, write}`; with `write` false the
 * store is not touched, which is how a refusal or a stale token changes nothing. */
function mutate({ file, fsImpl, apply }: any) {
  let outcome: any = null;
  try {
    updateTaskState({
      fsImpl, file,
      // `apply` decides from the store alone, so a reclaimed writer re-runs it on the fresh store.
      lostLockRetries: 2,
      build: (disk: any) => {
        const store = normalizeStore(disk, file);
        store.revision = (Number.isInteger(store.revision) ? store.revision : 0) + 1;
        outcome = apply(store);
        if (!outcome.write) throw new NoWrite();
        return store;
      },
    });
  } catch (error: any) {
    if (error instanceof NoWrite) return outcome.result;
    if (error instanceof TaskAttemptError) throw error;
    // Contention, not damage: the store is intact and a later run decides afresh.
    if (error?.code === 'lock-lost') throw new TaskAttemptError('lock-lost', error.message);
    throw unreadable(file, error.message);
  }
  return outcome.result;
}

function entryFor(store: any, taskId: any) {
  if (!store.tasks[taskId]) store.tasks[taskId] = { nextToken: 1, attempts: [] };
  return store.tasks[taskId];
}

const activeAttempt = (entry: any) => (entry ? entry.attempts.find((a: any) => a.state === 'active') || null : null);
// DEC-016 done-attempt-selection: the highest-token finished COMPLETED attempt, as deriveTasks reads it.
const doneAttempt = (entry: any) => (entry ? doneOf(entry.attempts) : null);

function planHashes(plan: any) {
  return Object.fromEntries(plan.tasks.map((t: any) => [t.id, t.hash]));
}

/** IC-005 over the store, with each task's current line hash from `loadPlan` (done-stale, IC-024)
 * and the cancels an acknowledged resume cleared (row 4, IC-015). Pure, so it may run inside the
 * lock. A store with no cancelled attempt (every `8ce5ad7` store) clears nothing. */
function derivePlan(plan: any, store: any) {
  return deriveTasks(plan.graph, store, { hashes: planHashes(plan), clearedCancels: clearedCancels(store) });
}

// ── evidence ───────────────────────────────────────────────────────────────────────────────────

/** Evidence ids recorded in any task file under the evidence store, to tell "belongs to another task"
 * from "does not exist". Reads only; a file that cannot be read simply does not match. */
function evidenceBelongsElsewhere({ roots, slug, evidenceId, fsImpl }: any) {
  for (const root of roots) {
    const base = path.join(root, '.doflow', 'state', 'evidence');
    for (const dir of [base, path.join(base, slug)]) {
      let names = [];
      try { names = fsImpl.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8'));
          if (Array.isArray(data.evidence) && data.evidence.some((item: any) => item && item.id === evidenceId)) return true;
        } catch { /* unreadable files do not match */ }
      }
    }
  }
  return false;
}

/** The refusal reason for `evidenceId` as proof of a COMPLETED attempt, or null when it qualifies (FR-004). */
function evidenceRefusal({ evidenceId, slug, taskId, startedAt, roots, fsImpl }: any) {
  if (!evidenceId) return 'evidence-required';
  const allowed = [slug, taskId];
  let item = null;
  for (const root of roots) {
    for (const owner of allowed) {
      const ledger = new EvidenceLedger({ repoRoot: root, slug, fsImpl });
      try { ledger.load(owner); } catch { return 'evidence-unreadable'; }
      item = ledger.getEvidence(evidenceId);
      if (item) break;
    }
    if (item) break;
  }
  if (!item) return evidenceBelongsElsewhere({ roots, slug, evidenceId, fsImpl }) ? 'evidence-wrong-task' : 'evidence-not-found';
  if (!allowed.includes(item.taskId)) return 'evidence-wrong-task';
  if (item.status !== 'active') return 'evidence-superseded';
  if (item.kind !== 'test-result') return 'evidence-wrong-kind';
  if (!item.observation || item.observation.exitCode !== 0) return 'evidence-not-passing';
  if (item.freshness?.status === 'STALE') return 'evidence-stale';
  const observed = Date.parse(item.freshness?.observedAt);
  if (!Number.isFinite(observed) || observed < Date.parse(startedAt)) return 'evidence-before-attempt';
  return null;
}

// ── actions ────────────────────────────────────────────────────────────────────────────────────

function rootsFor({ cwd, lifecycleRoot }: any) {
  return uniq([path.resolve(cwd), lifecycleRoot]);
}

/** The caller's run record, or null. Own keys only, so a run key never reaches the prototype. */
function runOf(store: any, runKey: string) {
  return store.runs && Object.prototype.hasOwnProperty.call(store.runs, runKey) ? store.runs[runKey] : null;
}

/** IC-026: `--exec-worktree` made absolute against `cwd`, then lifted to its worktree top. A path
 * that is not an existing directory is exit 2 `usage` (DEC-023 exec-worktree-directory). Runs
 * before the lock. */
function resolveExecWorktree(execWorktree: any, cwd: string, fsImpl: any) {
  if (!given(execWorktree)) return null;
  const absolute = path.resolve(cwd, String(execWorktree));
  if (String(execWorktree).trim() === '' || !fsImpl.existsSync(absolute)) {
    throw new TaskAttemptError('usage', `--exec-worktree '${execWorktree}' does not exist`);
  }
  if (!fsImpl.statSync(absolute).isDirectory()) {
    throw new TaskAttemptError('usage', `--exec-worktree '${execWorktree}' is not a directory`);
  }
  return findWorkTreeTop(absolute).top ?? absolute;
}

function wholeNumber(value: any, flag: string, min = 0) {
  if (!given(value)) return null;
  if (!Number.isInteger(value) || value < min) throw new TaskAttemptError('usage', `${flag} expects a whole number of at least ${min}, got '${value}'`);
  return value;
}

/** Synchronous wait for the IC-021 test-only seam; never reached from the CLI. */
function sleepSync(ms: number) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * IC-006 steps 3 to 12 against `store`, in the contract's order. Reads only: returns a refusal
 * result, or `{ ok }` carrying what the write needs. For a plan without the header (DEC-008) steps
 * 6, 8 and 9 do not apply and steps 3, 4, 5 and 12 answer exactly as before 080.
 */
function claimChecks(store: any, c: any) {
  const { plan, graphPlan, task, owner, override, key, epoch, reserveTokens } = c;
  const refuse = (reason: any, extra: any = {}) => ({ refused: { disposition: 'refused', taskId: task, reason, ...extra } });
  const target = plan.tasks.find((t: any) => t.id === task);
  if (!target) return refuse('unknown-task');
  const record = derivePlan(plan, store).find((r: any) => r.id === task);
  if (record.state === 'SUCCEEDED') return refuse('already-done');
  const active = activeAttempt(store.tasks[task]);
  if (active) return refuse('active-attempt', { activeToken: active.token, owner: active.owner, startedAt: active.startedAt });
  if (graphPlan) {
    const worker = refuseWorker(key.identity);
    if (worker) return refuse(worker.reason);
  }
  const run = runOf(store, key.runKey);
  const control = controlRefusal(run, key.runKey);
  if (control) { const { reason, ...extra } = control; return refuse(reason, extra); }
  if (graphPlan) {
    const stale = epochRefusal(run, key.runKey, epoch);
    if (stale) { const { reason, ...extra } = stale; return refuse(reason, extra); }
  }
  const declared = plan.graph.tasks.find((t: any) => t.id === task).owner;
  let ownerOverrideRecord = null;
  if (graphPlan && declared && owner !== declared) {
    if (!override) return refuse('owner-mismatch', { declared });
    ownerOverrideRecord = { declared, reason: override };
  }
  const { limit, used } = record.budget;
  if (used >= limit) return refuse('budget-exhausted', { scope: 'task', limit, used });
  if (record.state === 'CANCELLED') {
    const cancelled = store.tasks[task].attempts.filter((a: any) => a.state === 'cancelled')
      .reduce((a: any, b: any) => (b.token > a.token ? b : a));
    return refuse('cancelled', { cancelledToken: cancelled.token, clear: 'resume' });
  }
  const readiness = record.readiness;
  if (readiness.reason === 'dependency-held') return refuse('dependency-held', { held: readiness.held });
  if (readiness.reason === 'unmet-dependency') return refuse('unmet-dependency', { unmet: readiness.unmet });
  if (readiness.reason === 'unmet-phase') return refuse('unmet-phase', graphPlan ? { unmet: readiness.unmet, held: readiness.held } : { unmet: readiness.unmet });
  const aggregate = aggregateRefusal(run, computeTotals(store, key.runKey), plan.graph, reserveTokens);
  if (aggregate) { const { reason, ...extra } = aggregate; return refuse(reason, extra); }
  return { ok: { target, ownerOverrideRecord } };
}

/**
 * The claim's write (IC-006 "on success"): the attempt with IC-010's run fields, a legacy-plan run
 * record created if absent (a graph plan's run exists, step 8), and the run's recorded graph
 * (IC-004) and totals (IC-009) refreshed from the attempt list. A legacy-created run gets epoch 0:
 * only start and an acknowledged resume issue an epoch (DEC-007).
 */
function claimWrite(store: any, c: any, ok: any) {
  const { plan, graphPlan, task, owner, mode, key, execWorktree, reserveTokens, now } = c;
  const run = ensureRun(store, key, now);
  const entry = entryFor(store, task);
  const token = entry.nextToken;
  entry.nextToken += 1;
  const attempt: any = {
    token, owner, mode, startedAt: now.toISOString(), taskLineHash: ok.target.hash,
    state: 'active', result: null, evidenceId: null, reason: null,
    ...(ok.ownerOverrideRecord ? { ownerOverride: ok.ownerOverrideRecord } : {}),
    runKey: key.runKey, epoch: run.epoch, execWorktree: execWorktree ?? run.worktree,
  };
  if (reserveTokens !== null) attempt.reserve = { tokens: reserveTokens };
  attempt.sources = c.measured.sources;
  attempt.sourcesTruncated = c.measured.sourcesTruncated;
  entry.attempts.push(attempt);
  store.planPath = plan.planPath;
  refreshRun(store, run, plan.graph);
  const claimed: any = { disposition: 'claimed', taskId: task, token, revision: store.revision };
  // A legacy plan's result keeps the 8ce5ad7 shape (FR-015); the run fields are on the attempt.
  // IC-013: the unhashable or unverifiable entries are listed once, only when there are any, so a
  // claim whose files all hash keeps C.2's result shape.
  if (graphPlan) {
    Object.assign(claimed, { runKey: key.runKey, epoch: attempt.epoch, execWorktree: attempt.execWorktree });
    if (c.measured.sourcesUnverifiable.length) claimed.sourcesUnverifiable = c.measured.sourcesUnverifiable;
  }
  return claimed;
}

/**
 * IC-006. Steps 0 to 2 before the lock (flags, graph, run key, execution worktree); steps 3 to 12
 * and the write inside one `mutate()` against the store on disk, so every refusal writes nothing.
 *
 * `checkOutsideLock` and `delayAfterCheckMs` are the IC-021 test-only seam: the checks run against
 * a plain read before the lock, then the claim waits, then writes without re-checking. It exists
 * only so the race suite can prove it detects a missing lock; `handleTaskAttemptCommand` never
 * passes it.
 */
function claim({
  file, fsImpl, roots, slug, task, owner, mode, ownerOverride, epoch, reserveTokens, execWorktree,
  env = process.env, cwd = process.cwd(), now = new Date(), checkOutsideLock = false, delayAfterCheckMs = 0,
}: any) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!owner || !SAFE_NAME.test(owner)) throw new TaskAttemptError('usage', '--owner is required: the name of the agent or person taking the task');
  if (!MODES.includes(mode)) throw new TaskAttemptError('usage', `--mode is required: one of ${MODES.join(', ')}`);
  // DEC-019: --epoch is at least 1 in-process, as on the CLI; no run ever holds epoch 0 to match.
  const epochGiven = wholeNumber(epoch, '--epoch', 1);
  const reserve = wholeNumber(reserveTokens, '--reserve-tokens');
  const plan = loadPlan({ roots, slug, fsImpl });
  const graphPlan = isGraphPlan(plan.graph);
  const override = graphPlan && given(ownerOverride) ? String(ownerOverride).trim() : null;
  if (override === '') throw new TaskAttemptError('usage', '--owner-override needs a reason: why the declared owner is not taking the task');
  const key = runKeyFor(env, cwd);
  const exec = resolveExecWorktree(execWorktree, cwd, fsImpl);
  // IC-013 / IC-006 step 2: hash the declared files before the lock, under the execution worktree
  // the attempt will record (the flag, else the run's worktree, which is the key's top).
  const declared = plan.graph.tasks.find((t: any) => t.id === task);
  const measured = measureSources({ files: declared ? declared.files : [] }, exec ?? key.top, roots);
  const c = {
    plan, graphPlan, task, owner, mode, override, key, epoch: epochGiven, reserveTokens: reserve,
    execWorktree: exec, measured, now,
  };
  if (checkOutsideLock) {
    const checked: any = claimChecks(readStore(file, fsImpl), c);
    if (checked.refused) return checked.refused;
    sleepSync(delayAfterCheckMs);
    return mutate({ file, fsImpl, apply: (store: any) => ({ write: true, result: claimWrite(store, c, checked.ok) }) });
  }
  return mutate({
    file, fsImpl,
    apply: (store: any) => {
      const checked: any = claimChecks(store, c);
      if (checked.refused) return { write: false, result: checked.refused };
      return { write: true, result: claimWrite(store, c, checked.ok) };
    },
  });
}

function stale(taskId: any, token: any, reason: any) {
  return { write: false, result: { disposition: 'stale', taskId, token, reason } };
}

const given = (value: any) => value !== undefined && value !== null;

/** IC-007: `tokens` and `basis` together or not at all (DEC-003: caller-reported, never metered). */
function readUsage(tokens: any, basis: any) {
  if (!given(tokens) && !given(basis)) return null;
  if (given(tokens) !== given(basis)) throw new TaskAttemptError('usage', '--tokens and --tokens-basis are given together or not at all');
  if (!Number.isInteger(tokens) || tokens < 0) throw new TaskAttemptError('usage', `--tokens expects a whole number of at least 0, got '${tokens}'`);
  if (!USAGE_BASES.includes(basis)) throw new TaskAttemptError('usage', `--tokens-basis expects one of ${USAGE_BASES.join(', ')}, got '${basis}'`);
  return { tokens, basis };
}

/** The finisher's identity, read from the environment before the lock (IC-026). */
function callerIdentity(env: any, cwd: any) {
  const { resolveIdentity } = require('./context/identity.ts');
  return resolveIdentity(env, { cwd, sessionId: '' });
}

/** IC-007 step 1: the attempt holding `token` was cancelled. Runs before every other check. */
function cancelledAttempt(entry: any, token: any) {
  return entry ? entry.attempts.find((a: any) => a.token === token && a.state === 'cancelled') || null : null;
}

function finish({ file, fsImpl, roots, slug, task, token, result, evidenceId, reason, tokens, basis, env = process.env, cwd = process.cwd(), now = new Date() }: any) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!Number.isInteger(token) || token < 1) throw new TaskAttemptError('usage', '--token is required: the token claim returned');
  if (!RESULTS.includes(result)) throw new TaskAttemptError('usage', `--result is required: one of ${RESULTS.join(', ')}`);
  const why = given(reason) ? String(reason).trim() : '';
  if (result === 'FAILED' && !why) throw new TaskAttemptError('usage', '--reason is required with --result FAILED: what failed');
  const reported = readUsage(tokens, basis);
  const identity = callerIdentity(env, cwd);
  return mutate({
    file, fsImpl,
    apply: (store: any) => {
      if (cancelledAttempt(store.tasks[task], token)) return stale(task, token, 'attempt-cancelled');
      const active = activeAttempt(store.tasks[task]);
      if (!active) return stale(task, token, 'no-active-attempt');
      if (active.token !== token) return stale(task, token, 'token-mismatch');
      const refuse = (reason: any) => ({ write: false, result: { disposition: 'refused', taskId: task, token, reason } });
      const plan = loadPlan({ roots, slug, fsImpl });
      const line = plan.tasks.find((t: any) => t.id === task);
      if (!line) return refuse('unknown-task');
      if (line.hash !== active.taskLineHash) return refuse('plan-changed');
      if (result === 'COMPLETED') {
        const refusal = evidenceRefusal({ evidenceId, slug, taskId: task, startedAt: active.startedAt, roots, fsImpl });
        if (refusal) return refuse(refusal);
      }
      active.state = 'finished';
      active.result = result;
      active.evidenceId = evidenceId || null;
      if (why) active.reason = why;
      active.finishedAt = now.toISOString();
      active.finishedBy = { role: identity.role, lineage: identity.lineage, worktree: identity.worktree };
      active.usage = reported ? { ...reported, reporter: `${identity.role}:${identity.lineage}` } : null;
      // IC-009: every locked write stores totals recomputed from the attempt list.
      const run = active.runKey ? runOf(store, active.runKey) : null;
      if (run) refreshRun(store, run, plan.graph);
      return { write: true, result: { disposition: 'applied', taskId: task, token, result, revision: store.revision } };
    },
  });
}

function release({ file, fsImpl, roots, slug, task, token, reason, tokens, basis, env = process.env, cwd = process.cwd(), now = new Date() }: any) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!Number.isInteger(token) || token < 1) throw new TaskAttemptError('usage', '--token is required: the token claim returned');
  if (!reason || !String(reason).trim()) throw new TaskAttemptError('usage', '--reason is required: why the attempt is being released');
  const reported = readUsage(tokens, basis);
  const identity = reported ? callerIdentity(env, cwd) : null;
  // DEC-020 release-without-plan: never a precondition; read before the lock, null when unloadable.
  const plan = planOrNull({ roots, slug, fsImpl });
  return mutate({
    file, fsImpl,
    apply: (store: any) => {
      if (cancelledAttempt(store.tasks[task], token)) return stale(task, token, 'attempt-cancelled');
      const active = activeAttempt(store.tasks[task]);
      if (!active) return stale(task, token, 'no-active-attempt');
      if (active.token !== token) return stale(task, token, 'token-mismatch');
      active.state = 'released';
      active.reason = String(reason).trim();
      active.endedAt = now.toISOString();
      active.usage = reported ? { ...reported, reporter: `${identity.role}:${identity.lineage}` } : null;
      // IC-009: every locked write stores totals recomputed from the attempt list. DEC-020: with an
      // unloadable plan only the totals are refreshed; the recorded graph is kept.
      const run = active.runKey ? runOf(store, active.runKey) : null;
      if (run) refreshRunOrTotals(store, run, plan);
      return { write: true, result: { disposition: 'released', taskId: task, token, revision: store.revision } };
    },
  });
}

/** DEC-020 release-without-plan: the plan when it loads, else null for a malformed or unreadable
 * one. Other failures (a store problem, a bug) still throw. */
function planOrNull(args: any) {
  try { return loadPlan(args); } catch (error: any) {
    if (error instanceof TaskAttemptError && (error.code === 'plan-malformed' || error.code === 'plan-unreadable')) return null;
    throw error;
  }
}

/** IC-004 / IC-009 refresh with a loaded plan; with none (DEC-020), the totals only. */
function refreshRunOrTotals(store: any, run: any, plan: any) {
  if (plan) refreshRun(store, run, plan.graph);
  else run.totals = computeTotals(store, run.runKey);
}

/**
 * DEC-018 unreported-usage-recovery: `report-usage` writes caller-reported usage onto an ended
 * attempt that has none, so a run under a token limit that DEC-011 refuses as
 * `aggregate-unaccounted` can recover. Any plan; fenced by the token alone (like finish, IC-026),
 * so a worker may report. Never overwrites. The owning run's totals are refreshed in the same
 * locked write; like release (DEC-020) an unloadable plan refreshes totals only.
 */
function reportUsage({ file, fsImpl, roots, slug, task, token, tokens, basis, env = process.env, cwd = process.cwd() }: any) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!Number.isInteger(token) || token < 1) throw new TaskAttemptError('usage', '--token is required: the token of the ended attempt');
  if (!given(tokens) || !given(basis)) throw new TaskAttemptError('usage', '--tokens and --tokens-basis are required: the usage to record');
  const reported = readUsage(tokens, basis);
  const identity = callerIdentity(env, cwd);
  const plan = planOrNull({ roots, slug, fsImpl });
  return mutate({
    file, fsImpl,
    apply: (store: any) => {
      const refuse = (reasonCode: string) => ({ write: false, result: { disposition: 'refused', taskId: task, token, reason: reasonCode } });
      const entry = Object.prototype.hasOwnProperty.call(store.tasks, task) ? store.tasks[task] : null;
      // A task the plan no longer lists may still hold an unreported attempt, so the ledger counts too.
      const known = plan ? plan.tasks.some((t: any) => t.id === task) : false;
      if (!known && !entry) return refuse('unknown-task');
      const attempt = entry ? entry.attempts.find((a: any) => a.token === token) || null : null;
      if (!attempt) return stale(task, token, 'no-attempt');
      if (attempt.state === 'active') return refuse('active-attempt');
      if (attempt.state === 'cancelled') return stale(task, token, 'attempt-cancelled');
      if (attempt.usage) return refuse('usage-present');
      attempt.usage = { ...reported, reporter: `${identity.role}:${identity.lineage}` };
      const run = attempt.runKey ? runOf(store, attempt.runKey) : null;
      if (run) refreshRunOrTotals(store, run, plan);
      return { write: true, result: { disposition: 'usage-recorded', taskId: task, token, revision: store.revision } };
    },
  });
}

// ── run controls and reopen (IC-012, IC-024, IC-026; DEC-005, DEC-009) ──────────────────────────
//
// Flags, the plan and the run key are resolved before the lock; the decision and the write are one
// `mutate()`. Each identity, control and token refusal returns `write: false`.

function requireBy(by: any) {
  if (!by || !SAFE_NAME.test(String(by))) throw new TaskAttemptError('usage', '--by is required: the name of the agent or person acting on the run');
  return String(by);
}

function requireReason(reason: any, what: string) {
  const why = given(reason) ? String(reason).trim() : '';
  if (!why) throw new TaskAttemptError('usage', `--reason is required: ${what}`);
  return why;
}

function requireTaskToken(task: any, token: any) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!Number.isInteger(token) || token < 1) throw new TaskAttemptError('usage', '--token is required: the attempt token');
}

function budgetLimit(value: any, flag: string) {
  if (!given(value)) return null;
  if (!Number.isInteger(value) || value < 1) throw new TaskAttemptError('usage', `${flag} expects a whole number of at least 1, got '${value}'`);
  return value;
}

/** IC-012 `start`: the caller's run with `epoch: 1`, or `run-exists`. */
function start({ file, fsImpl, roots, slug, by, budgetAttempts, budgetTokens, env = process.env, cwd = process.cwd(), now = new Date() }: any) {
  const who = requireBy(by);
  const budget = { attempts: budgetLimit(budgetAttempts, '--budget-attempts'), tokens: budgetLimit(budgetTokens, '--budget-tokens') };
  const plan = loadPlan({ roots, slug, fsImpl });
  const key = runKeyFor(env, cwd);
  return mutate({ file, fsImpl, apply: (store: any) => startRun(store, { key, graph: plan.graph, by: who, budget, now }) });
}

/** IC-012 `pause`: claims refuse until an acknowledged resume; active attempts still finish. */
function pause({ file, fsImpl, roots, slug, by, reason, env = process.env, cwd = process.cwd(), now = new Date() }: any) {
  const who = requireBy(by);
  const why = requireReason(reason, 'why the run is being paused');
  const plan = loadPlan({ roots, slug, fsImpl });
  const key = runKeyFor(env, cwd);
  return mutate({ file, fsImpl, apply: (store: any) => pauseRun(store, { key, graph: plan.graph, by: who, reason: why, now }) });
}

/** IC-012 `cancel`: one attempt when `task` or `token` is given, else the whole run. Marks
 * attempts only; ending a worker process is 081's. */
function cancel({ file, fsImpl, roots, slug, task, token, by, reason, adoptUnowned = false, env = process.env, cwd = process.cwd(), now = new Date() }: any) {
  const who = requireBy(by);
  const why = requireReason(reason, 'why the run or attempt is being cancelled');
  const single = given(task) || given(token);
  if (single) {
    requireTaskToken(task, token);
    if (adoptUnowned) throw new TaskAttemptError('usage', '--adopt-unowned applies to a run cancel, not to one attempt');
  }
  const plan = loadPlan({ roots, slug, fsImpl });
  const key = runKeyFor(env, cwd);
  return mutate({
    file, fsImpl,
    apply: (store: any) => (single
      ? cancelAttempt(store, { key, graph: plan.graph, task, token, by: who, reason: why, now })
      : cancelRun(store, { key, graph: plan.graph, by: who, reason: why, adoptUnowned: Boolean(adoptUnowned), now })),
  });
}

/** Task ids that depend on `taskId`, directly or through another dependent: an explicit
 * `depends-on:` naming it, or no `depends-on:` and a later phase. */
function dependentsOf(graph: any, taskId: string) {
  const found = new Set<string>();
  const queue = [taskId];
  while (queue.length) {
    const id = queue.shift() as string;
    const of = graph.tasks.find((t: any) => t.id === id);
    for (const t of graph.tasks) {
      if (found.has(t.id) || t.id === taskId) continue;
      const waits = t.taskDeps.length ? t.taskDeps.includes(id) : t.phaseIndex > of.phaseIndex;
      if (waits) { found.add(t.id); queue.push(t.id); }
    }
  }
  return graph.tasks.filter((t: any) => found.has(t.id)).map((t: any) => t.id);
}

/**
 * IC-024 / DEC-009: the task's done attempt (stale or not) becomes `superseded`, so the task is no
 * longer done and the attempt counts toward the task budget (IC-008). Available in every plan.
 * `dependentsActive` names active attempts of dependent tasks; the caller decides about them.
 */
function reopen({ file, fsImpl, roots, slug, task, token, by, reason, env = process.env, cwd = process.cwd(), now = new Date() }: any) {
  requireTaskToken(task, token);
  const who = requireBy(by);
  const why = requireReason(reason, 'why the done task is being reopened');
  const plan = loadPlan({ roots, slug, fsImpl });
  const key = runKeyFor(env, cwd);
  return mutate({
    file, fsImpl,
    apply: (store: any) => {
      const refuse = (reasonCode: string, extra: any = {}) => ({ write: false, result: { disposition: 'refused', taskId: task, token, reason: reasonCode, ...extra } });
      const identity = identityRefusal(key.identity);
      if (identity) return refuse(identity.reason);
      if (!plan.tasks.some((t: any) => t.id === task)) return refuse('unknown-task');
      const done = doneAttempt(store.tasks[task]);
      if (!done) return refuse('not-done');
      if (done.token !== token) return refuse('token-mismatch', { doneToken: done.token });
      const existing = runOf(store, key.runKey);
      if (existing && existing.control === 'cancelled') return refuse('run-cancelled', { runKey: key.runKey });
      const run = ensureRun(store, key, now);
      const at = now.toISOString();
      done.state = 'superseded';
      done.reopen = { at, by: who, reason: why, runKey: key.runKey };
      run.history.push({ at, action: 'reopen', by: who, reason: why, taskId: task, token });
      refreshRun(store, run, plan.graph);
      const dependentsActive = dependentsOf(plan.graph, task)
        .map((id: string) => ({ id, active: activeAttempt(store.tasks[id]) }))
        .filter((d: any) => d.active)
        .map((d: any) => ({ taskId: d.id, token: d.active.token }));
      return { write: true, result: { disposition: 'reopened', taskId: task, token, dependentsActive } };
    },
  });
}

const ACK = /^sha256:[0-9a-f]{64}$/;

/**
 * IC-015 `resume`: the report and its digest, and with `ack` the acknowledged resume. Flags and
 * the plan are checked first; `resumeRun` refuses on identity, runs the probes before any lock,
 * and with `ack` makes one `mutate()`. Without `ack` the store is read with `readTaskState` and
 * nothing is written (DEC-004). `by` is required with `ack`; `reason` is optional, non-empty when
 * given. `gitRunner(args, cwd) => stdout | null` replaces the git process (tests).
 */
function resume({ file, fsImpl, roots, slug, ack, by, reason, env = process.env, cwd = process.cwd(), now = new Date(), gitRunner = null }: any) {
  const acknowledged = given(ack) ? String(ack) : null;
  if (acknowledged !== null && !ACK.test(acknowledged)) throw new TaskAttemptError('usage', `--ack expects the digest resume reported (sha256:<64 hex>), got '${ack}'`);
  const who = acknowledged !== null ? requireBy(by) : (given(by) ? requireBy(by) : null);
  const why = given(reason) ? requireReason(reason, 'why the run is being resumed') : null;
  const plan = loadPlan({ roots, slug, fsImpl });
  const key = runKeyFor(env, cwd);
  return resumeRun(
    { read: () => readStore(file, fsImpl), mutate: (apply: any) => mutate({ file, fsImpl, apply }) },
    { key, graph: plan.graph, hashes: planHashes(plan), roots, ack: acknowledged, by: who, reason: why, now, env, gitRunner },
  );
}

/**
 * IC-016 `inspect`: the plan's graph, every task's derived state, budgets with their source, and
 * the caller's run with recomputed totals and `totalsMismatch`. Read-only: the store is read with
 * `readStore` (`readTaskState`), no lock is taken, nothing is written and no git process runs.
 */
function inspect({ file, fsImpl, roots, slug, env = process.env, cwd = process.cwd() }: any) {
  const plan = loadPlan({ roots, slug, fsImpl });
  const key = runKeyFor(env, cwd);
  const store = readStore(file, fsImpl);
  return inspectRun(store, { slug, key, graph: plan.graph, hashes: planHashes(plan), warnings: plan.warnings });
}

/** Completion read from the ledger and the plan, never from checkboxes (FR-005). Each task keeps
 * the pre-080 fields and adds IC-005's `state`, `reason`, `claimable`, `budget` and, where
 * present, `held`, `unmet` and `doneStale`. */
function status({ file, fsImpl, roots, slug }: any) {
  const plan = loadPlan({ roots, slug, fsImpl });
  const store = readStore(file, fsImpl);
  const tasks = derivePlan(plan, store).map((r: any) => {
    const out: any = {
      id: r.id, phase: r.phase, derived: r.derived,
      activeToken: r.activeToken, doneToken: r.doneToken, active: r.active,
      state: r.state, reason: r.reason, claimable: r.claimable, budget: r.budget,
    };
    for (const key of ['held', 'unmet', 'doneStale']) if (r[key] !== undefined) out[key] = r[key];
    return out;
  });
  return {
    complete: tasks.length > 0 && tasks.every((t: any) => t.derived === 'done'),
    revision: store.revision,
    tasks,
    unclaimedChecked: plan.tasks.filter((t: any) => t.checked && !doneAttempt(store.tasks[t.id])).map((t: any) => t.id),
  };
}

/**
 * The orchestrator's question (FR-006): does this feature have a ledger, and is it complete?
 * `none` when no store exists (a feature that predates the ledger); `complete` or `incomplete`
 * otherwise. A store or plan that cannot be read throws, so the gate refuses rather than guessing.
 * @returns {{state: 'none'|'complete'|'incomplete', slug: string|null, incomplete: Array<string>}}
 */
function checkCompletion({ slug, cwd, fsImpl = fs }: any) {
  if (!isSafeSlug(slug)) return { state: 'none', slug: null, incomplete: [] };
  const lifecycleRoot = lifecycleProjectRoot(cwd);
  const file = storeFile(lifecycleRoot, slug);
  if (!fsImpl.existsSync(file)) return { state: 'none', slug, incomplete: [] };
  const answer = status({ file, fsImpl, roots: rootsFor({ cwd, lifecycleRoot }), slug });
  const incomplete = answer.tasks.filter((t: any) => t.derived !== 'done').map((t: any) => t.id);
  // IC-024: only a graph plan has done-stale tasks (DEC-009); a legacy answer keeps its shape.
  const stale = answer.tasks.filter((t: any) => t.doneStale);
  if (stale.length) {
    const reasons = Object.fromEntries(stale.map((t: any) => [t.id, 'plan-changed-after-done']));
    return { state: 'incomplete', slug, incomplete, reasons };
  }
  return { state: answer.complete ? 'complete' : 'incomplete', slug, incomplete };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function failure(code: any, message: any, json: any, problems?: any[]) {
  const { finishRuntime } = require('./cli-result.ts');
  if (json) console.log(JSON.stringify(problems ? { ok: false, error: code, message, problems } : { ok: false, error: code, message }, null, 2));
  else console.error(`doflow task-attempt: ${message}`);
  return finishRuntime(2);
}

function describe(result: any) {
  const parts = [`${result.disposition}`];
  if (result.taskId) parts.push(`task ${result.taskId}`);
  if (result.token !== undefined) parts.push(`token ${result.token}`);
  if (result.reason) parts.push(`(${result.reason})`);
  if (result.disposition === 'ack-required' || result.disposition === 'resumed' || result.reason === 'report-changed') {
    if (result.digest) parts.push(`digest ${result.digest}`);
  }
  if (['started', 'resumed'].includes(result.disposition) && given(result.epoch)) parts.push(`epoch ${result.epoch}`);
  return parts.join(' ');
}

/** IC-017: the dispositions that exit 0. `status` and `inspect` are reads and always exit 0. */
const APPLIED = Object.freeze(['claimed', 'applied', 'released', 'started', 'paused', 'cancelled', 'resumed', 'reopened', 'usage-recorded']);

/**
 * IC-017: the actions each flag may be given to. The 080 flags are refused on every other action;
 * the pre-080 flags are refused only on the 080 actions, so every existing invocation keeps its
 * exit code (NFR-001).
 */
const FLAG_ACTIONS: Record<string, { flag: string; actions: string[] }> = {
  ownerOverride: { flag: '--owner-override', actions: ['claim'] },
  epoch: { flag: '--epoch', actions: ['claim'] },
  execWorktree: { flag: '--exec-worktree', actions: ['claim'] },
  reserveTokens: { flag: '--reserve-tokens', actions: ['claim'] },
  tokens: { flag: '--tokens', actions: ['finish', 'release', 'report-usage'] },
  tokensBasis: { flag: '--tokens-basis', actions: ['finish', 'release', 'report-usage'] },
  by: { flag: '--by', actions: ['start', 'pause', 'cancel', 'reopen', 'resume'] },
  budgetAttempts: { flag: '--budget-attempts', actions: ['start'] },
  budgetTokens: { flag: '--budget-tokens', actions: ['start'] },
  ack: { flag: '--ack', actions: ['resume'] },
  adoptUnowned: { flag: '--adopt-unowned', actions: ['cancel'] },
};
const PRE_080_ACTIONS = Object.freeze(['claim', 'finish', 'release', 'status']);
const PRE_080_FLAG_ACTIONS: Record<string, { flag: string; actions: string[] }> = {
  task: { flag: '--task', actions: ['cancel', 'reopen', 'report-usage'] },
  token: { flag: '--token', actions: ['cancel', 'reopen', 'report-usage'] },
  reason: { flag: '--reason', actions: ['pause', 'cancel', 'reopen', 'resume'] },
  owner: { flag: '--owner', actions: [] },
  mode: { flag: '--mode', actions: [] },
  result: { flag: '--result', actions: [] },
  evidenceId: { flag: '--evidence-id', actions: [] },
};

function refuseMisplacedFlags(action: string, flags: any) {
  const check = (table: Record<string, { flag: string; actions: string[] }>) => {
    for (const [key, { flag, actions }] of Object.entries(table)) {
      if (given(flags[key]) && flags[key] !== false && !actions.includes(action)) {
        throw new TaskAttemptError('usage', `${flag} does not apply to --action ${action}`);
      }
    }
  };
  check(FLAG_ACTIONS);
  if (!PRE_080_ACTIONS.includes(action)) check(PRE_080_FLAG_ACTIONS);
}

/** IC-017: a CLI integer is digits only, so `5abc`, `1.5` and `-1` are usage rather than whatever
 * `parseInt` would make of them. A number passed in-process is checked as its decimal form. */
function digits(value: any, flag: string, min: number) {
  if (!given(value)) return undefined;
  const text = String(value);
  if (!/^[0-9]+$/.test(text) || Number(text) > Number.MAX_SAFE_INTEGER || Number(text) < min) {
    throw new TaskAttemptError('usage', `${flag} expects a whole number of at least ${min}, got '${value}'`);
  }
  return Number(text);
}

/**
 * `doflow task-attempt --action <action> --slug <slug>` (IC-017). Exit 0 for the applied
 * dispositions and every `status` or `inspect` read; 1 refused, stale or ack-required, with the
 * disposition in the JSON; 2 malformed input or an unreadable store or plan.
 * @param {Object} options
 * @param {string} options.cwd the invoking checkout
 * @param {(cwd: string) => string|null} [options.resolveSlug] fallback when `slug` is not given
 */
function handleTaskAttemptCommand({
  action = 'status', slug = null, task, owner, mode, token, result, evidenceId, reason, json = false,
  ownerOverride, epoch, reserveTokens, execWorktree, tokens, tokensBasis, budgetAttempts, budgetTokens, by, ack,
  adoptUnowned = false, env = process.env,
  cwd = process.cwd(), resolveSlug = null, fsImpl = fs, now = new Date(),
}: any = {}) {
  const { finishRuntime } = require('./cli-result.ts');
  try {
    if (!ACTIONS.includes(action)) throw new TaskAttemptError('usage', `unknown action '${action}'; valid: ${ACTIONS.join(' | ')}`);
    refuseMisplacedFlags(action, {
      ownerOverride, epoch, reserveTokens, execWorktree, tokens, tokensBasis, budgetAttempts, budgetTokens, by, ack, adoptUnowned,
      task, token, reason, owner, mode, result, evidenceId,
    });
    const feature = slug || (resolveSlug ? resolveSlug(cwd) : null);
    if (!feature) throw new TaskAttemptError('usage', '--slug is required: no feature could be resolved from the current branch');
    assertSlug(feature);
    let tokenNumber;
    if (token !== undefined && token !== null) {
      if (!/^[0-9]+$/.test(String(token))) throw new TaskAttemptError('usage', `--token expects the whole number claim returned, got '${token}'`);
      tokenNumber = Number(token);
    }
    const epochNumber = digits(epoch, '--epoch', 1);
    const reserveNumber = digits(reserveTokens, '--reserve-tokens', 0);
    const tokensNumber = digits(tokens, '--tokens', 0);
    const attemptsLimit = digits(budgetAttempts, '--budget-attempts', 1);
    const tokensLimit = digits(budgetTokens, '--budget-tokens', 1);
    if (given(ownerOverride) && !String(ownerOverride).trim()) throw new TaskAttemptError('usage', '--owner-override needs a reason: why the declared owner is not taking the task');
    const lifecycleRoot = lifecycleProjectRoot(cwd);
    const file = storeFile(lifecycleRoot, feature);
    const roots = rootsFor({ cwd, lifecycleRoot });
    const common = { file, fsImpl, roots, slug: feature, env, cwd, now };
    const usage = { tokens: tokensNumber, basis: tokensBasis };

    let answer;
    switch (action) {
      case 'claim': answer = claim({ ...common, task, owner, mode, ownerOverride, epoch: epochNumber, reserveTokens: reserveNumber, execWorktree }); break;
      case 'finish': answer = finish({ ...common, task, token: tokenNumber, result, evidenceId, reason, ...usage }); break;
      case 'release': answer = release({ ...common, task, token: tokenNumber, reason, ...usage }); break;
      case 'start': answer = start({ ...common, by, budgetAttempts: attemptsLimit, budgetTokens: tokensLimit }); break;
      case 'pause': answer = pause({ ...common, by, reason }); break;
      case 'cancel': answer = cancel({ ...common, task, token: tokenNumber, by, reason, adoptUnowned: Boolean(adoptUnowned) }); break;
      case 'reopen': answer = reopen({ ...common, task, token: tokenNumber, by, reason }); break;
      case 'report-usage': answer = reportUsage({ ...common, task, token: tokenNumber, ...usage }); break;
      case 'resume': answer = resume({ ...common, ack, by, reason }); break;
      case 'inspect': answer = inspect(common); break;
      default: answer = status(common);
    }

    const read = action === 'status' || action === 'inspect';
    const ok = read || APPLIED.includes(answer.disposition);
    if (json) console.log(JSON.stringify(answer, null, 2));
    else if (action === 'status') {
      console.log(`Task attempts for ${feature}: ${answer.complete ? 'complete' : 'incomplete'}`);
      for (const t of answer.tasks) console.log(`  ${t.id}  ${t.derived}${t.activeToken ? ` (token ${t.activeToken}, ${t.active.owner} since ${t.active.startedAt})` : ''}`);
      if (answer.unclaimedChecked.length) console.log(`Checked in plan.md with no COMPLETED attempt: ${answer.unclaimedChecked.join(', ')}`);
    } else if (action === 'inspect') {
      const { formatInspect } = require('./task-run.ts');
      for (const line of formatInspect(answer)) console.log(line);
    } else (ok ? console.log : console.error)(describe(answer));
    return finishRuntime(ok ? 0 : 1);
  } catch (error: any) {
    if (error instanceof TaskAttemptError) return failure(error.code, error.message, json, error.problems);
    throw error;
  }
}

module.exports = {
  handleTaskAttemptCommand, checkCompletion, claim, finish, release, status, start, pause, cancel, reopen, resume, inspect, reportUsage,
  loadPlan, taskLineHash,
  storeFile, TaskAttemptError, MODES, RESULTS, ACTIONS, USAGE_BASES, RUN_CONTROLS, activeAttempt,
};
