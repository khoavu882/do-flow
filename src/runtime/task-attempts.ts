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
const { buildGraph, deriveTasks, isGraphPlan } = require('./task-graph.ts');
const { EvidenceLedger } = require('./evidence-ledger.ts');
const { projectRoot: lifecycleProjectRoot } = require('./lifecycle/root.ts');
const { isSafeSlug } = require('./task-scope.ts');

const SCHEMA_VERSION = 1;
const MODES = Object.freeze(['manual', 'sequential', 'subagent']);
const RESULTS = Object.freeze(['COMPLETED', 'BLOCKED', 'ABANDONED', 'INCONCLUSIVE', 'FAILED']);
const USAGE_BASES = Object.freeze(['measured', 'estimated']);
const RUN_CONTROLS = Object.freeze(['running', 'paused', 'cancelled']);
const ACTIONS = Object.freeze(['claim', 'finish', 'release', 'status']);
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
  const parsed = parsePlan(text);
  if (parsed.tasks.length === 0) {
    throw new TaskAttemptError('plan-malformed', `${found} holds no \`- [ ] <phase>.<n>\` tasks: ${parsed.gaps.map((g: any) => g.why).join('; ') || 'nothing to track'}`);
  }
  const built = buildGraph(parsed);
  if (!built.ok) throw malformedGraph(found, built.problems);
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
    throw unreadable(file, error.message);
  }
  return outcome.result;
}

function entryFor(store: any, taskId: any) {
  if (!store.tasks[taskId]) store.tasks[taskId] = { nextToken: 1, attempts: [] };
  return store.tasks[taskId];
}

const activeAttempt = (entry: any) => (entry ? entry.attempts.find((a: any) => a.state === 'active') || null : null);
const doneAttempt = (entry: any) => (entry ? entry.attempts.find((a: any) => a.state === 'finished' && a.result === 'COMPLETED') || null : null);

/** IC-005 over the store, with each task's current line hash from `loadPlan` (done-stale, IC-024).
 * Pure, so it may run inside the lock. Cleared cancels are not computed yet (resume, IC-015). */
function derivePlan(plan: any, store: any) {
  const hashes = Object.fromEntries(plan.tasks.map((t: any) => [t.id, t.hash]));
  return deriveTasks(plan.graph, store, { hashes });
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

/**
 * IC-006 steps 3, 4, 5, 9, 10, 11 and the readiness half of 12, inside the lock against the store
 * on disk. Every refusal writes nothing. For a plan without the header (DEC-008) the owner is not
 * checked and steps 3, 4, 5 and 12 answer exactly as before 080.
 */
function claim({ file, fsImpl, roots, slug, task, owner, mode, ownerOverride, now = new Date() }: any) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!owner || !SAFE_NAME.test(owner)) throw new TaskAttemptError('usage', '--owner is required: the name of the agent or person taking the task');
  if (!MODES.includes(mode)) throw new TaskAttemptError('usage', `--mode is required: one of ${MODES.join(', ')}`);
  const plan = loadPlan({ roots, slug, fsImpl });
  const graphPlan = isGraphPlan(plan.graph);
  const override = graphPlan && given(ownerOverride) ? String(ownerOverride).trim() : null;
  if (override === '') throw new TaskAttemptError('usage', '--owner-override needs a reason: why the declared owner is not taking the task');
  return mutate({
    file, fsImpl,
    apply: (store: any) => {
      const refuse = (reason: any, extra: any = {}) => ({ write: false, result: { disposition: 'refused', taskId: task, reason, ...extra } });
      const target = plan.tasks.find((t: any) => t.id === task);
      if (!target) return refuse('unknown-task');
      const record = derivePlan(plan, store).find((r: any) => r.id === task);
      if (record.state === 'SUCCEEDED') return refuse('already-done');
      const active = activeAttempt(store.tasks[task]);
      if (active) return refuse('active-attempt', { activeToken: active.token, owner: active.owner, startedAt: active.startedAt });
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
      const entry = entryFor(store, task);
      const token = entry.nextToken;
      entry.nextToken += 1;
      entry.attempts.push({
        token, owner, mode, startedAt: now.toISOString(), taskLineHash: target.hash,
        state: 'active', result: null, evidenceId: null, reason: null,
        ...(ownerOverrideRecord ? { ownerOverride: ownerOverrideRecord } : {}),
      });
      store.planPath = plan.planPath;
      return { write: true, result: { disposition: 'claimed', taskId: task, token, revision: store.revision } };
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
      return { write: true, result: { disposition: 'applied', taskId: task, token, result, revision: store.revision } };
    },
  });
}

function release({ file, fsImpl, task, token, reason, tokens, basis, env = process.env, cwd = process.cwd(), now = new Date() }: any) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!Number.isInteger(token) || token < 1) throw new TaskAttemptError('usage', '--token is required: the token claim returned');
  if (!reason || !String(reason).trim()) throw new TaskAttemptError('usage', '--reason is required: why the attempt is being released');
  const reported = readUsage(tokens, basis);
  const identity = reported ? callerIdentity(env, cwd) : null;
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
      return { write: true, result: { disposition: 'released', taskId: task, token, revision: store.revision } };
    },
  });
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
  return parts.join(' ');
}

/**
 * `doflow task-attempt --action claim|finish|release|status --slug <slug>`. Exit 0 applied, 1 refused
 * or stale, 2 malformed input or an unreadable store.
 * @param {Object} options
 * @param {string} options.cwd the invoking checkout
 * @param {(cwd: string) => string|null} [options.resolveSlug] fallback when `slug` is not given
 */
function handleTaskAttemptCommand({
  action = 'status', slug = null, task, owner, mode, token, result, evidenceId, reason, json = false,
  cwd = process.cwd(), resolveSlug = null, fsImpl = fs, now = new Date(),
}: any = {}) {
  const { finishRuntime } = require('./cli-result.ts');
  try {
    if (!ACTIONS.includes(action)) throw new TaskAttemptError('usage', `unknown action '${action}'; valid: ${ACTIONS.join(' | ')}`);
    const feature = slug || (resolveSlug ? resolveSlug(cwd) : null);
    if (!feature) throw new TaskAttemptError('usage', '--slug is required: no feature could be resolved from the current branch');
    assertSlug(feature);
    let tokenNumber;
    if (token !== undefined && token !== null) {
      if (!/^[0-9]+$/.test(String(token))) throw new TaskAttemptError('usage', `--token expects the whole number claim returned, got '${token}'`);
      tokenNumber = Number(token);
    }
    const lifecycleRoot = lifecycleProjectRoot(cwd);
    const file = storeFile(lifecycleRoot, feature);
    const roots = rootsFor({ cwd, lifecycleRoot });
    const common = { file, fsImpl, roots, slug: feature };

    let answer;
    switch (action) {
      case 'claim': answer = claim({ ...common, task, owner, mode, now }); break;
      case 'finish': answer = finish({ ...common, task, token: tokenNumber, result, evidenceId, reason, cwd, now }); break;
      case 'release': answer = release({ ...common, task, token: tokenNumber, reason, cwd, now }); break;
      default: answer = status(common);
    }

    const ok = action === 'status' || ['claimed', 'applied', 'released'].includes(answer.disposition);
    if (json) console.log(JSON.stringify(answer, null, 2));
    else if (action === 'status') {
      console.log(`Task attempts for ${feature}: ${answer.complete ? 'complete' : 'incomplete'}`);
      for (const t of answer.tasks) console.log(`  ${t.id}  ${t.derived}${t.activeToken ? ` (token ${t.activeToken}, ${t.active.owner} since ${t.active.startedAt})` : ''}`);
      if (answer.unclaimedChecked.length) console.log(`Checked in plan.md with no COMPLETED attempt: ${answer.unclaimedChecked.join(', ')}`);
    } else (ok ? console.log : console.error)(describe(answer));
    return finishRuntime(ok ? 0 : 1);
  } catch (error: any) {
    if (error instanceof TaskAttemptError) return failure(error.code, error.message, json, error.problems);
    throw error;
  }
}

module.exports = {
  handleTaskAttemptCommand, checkCompletion, claim, finish, release, status, loadPlan, taskLineHash,
  storeFile, TaskAttemptError, MODES, RESULTS, ACTIONS, USAGE_BASES, RUN_CONTROLS, activeAttempt,
};
