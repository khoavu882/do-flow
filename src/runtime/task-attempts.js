'use strict';

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
const { updateTaskState, readTaskState } = require('./task-state');
const { parsePlan } = require('./scaffold/artifacts.ts');
const { EvidenceLedger } = require('./evidence-ledger');
const { projectRoot: lifecycleProjectRoot } = require('./lifecycle/root.ts');
const { isSafeSlug } = require('./task-scope');

const SCHEMA_VERSION = 1;
const MODES = Object.freeze(['manual', 'sequential', 'subagent']);
const RESULTS = Object.freeze(['COMPLETED', 'BLOCKED', 'ABANDONED', 'INCONCLUSIVE']);
const ACTIONS = Object.freeze(['claim', 'finish', 'release', 'status']);
const TASK_ID = /^[A-Za-z]+\.\d+$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/** A failure that is the caller's or the environment's, not a finding: exit 2. */
class TaskAttemptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaskAttemptError';
    this.code = code;
  }
}

/** Thrown inside the locked build to abandon a write without touching the store. */
class NoWrite extends Error {}

function storeFile(root, slug) {
  return path.join(root, '.doflow', 'state', 'task-attempts', `${slug}.json`);
}

function uniq(values) { return [...new Set(values)]; }

function assertSlug(slug) {
  if (!isSafeSlug(slug)) throw new TaskAttemptError('usage', `'${slug}' is not a valid feature slug`);
  return slug;
}

// ── plan.md ────────────────────────────────────────────────────────────────────────────────────

/** The hash a claim records and `finish` compares: everything about the task's plan line except
 * its checkbox, so ticking the box after a finish is not an edit of the task. */
function taskLineHash(task) {
  const material = JSON.stringify([
    task.id, task.description, task.stories, task.owner, task.files, task.dependsOn, task.externalContract,
  ]);
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

/**
 * The plan's tasks, in plan order, with phase order taken from first appearance.
 * @returns {{planPath: string, tasks: Array<{id: string, phase: string, phaseIndex: number, checked: boolean, hash: string}>}}
 */
function loadPlan({ roots, slug, fsImpl = fs }) {
  const relative = path.join('agent-docs', 'doflow', slug, 'plan.md');
  const found = roots.map((root) => path.join(root, relative)).find((file) => fsImpl.existsSync(file));
  if (!found) throw new TaskAttemptError('plan-unreadable', `no plan.md for feature '${slug}' (looked for ${relative} under ${roots.join(', ')})`);
  let text;
  try { text = fsImpl.readFileSync(found, 'utf8'); } catch (error) {
    throw new TaskAttemptError('plan-unreadable', `cannot read ${found}: ${error.message}`);
  }
  const parsed = parsePlan(text);
  if (parsed.tasks.length === 0) {
    throw new TaskAttemptError('plan-malformed', `${found} holds no \`- [ ] <phase>.<n>\` tasks: ${parsed.gaps.map((g) => g.why).join('; ') || 'nothing to track'}`);
  }
  const seen = new Set();
  for (const task of parsed.tasks) {
    if (seen.has(task.id)) throw new TaskAttemptError('plan-malformed', `plan task id '${task.id}' appears more than once in ${found}`);
    seen.add(task.id);
  }
  const phases = uniq(parsed.tasks.map((t) => t.phase));
  return {
    planPath: relative.split(path.sep).join('/'),
    tasks: parsed.tasks.map((t) => ({
      id: t.id, phase: t.phase, phaseIndex: phases.indexOf(t.phase), checked: t.done, hash: taskLineHash(t),
    })),
  };
}

// ── store ──────────────────────────────────────────────────────────────────────────────────────

function unreadable(file, why) {
  return new TaskAttemptError('store-unreadable', `${why} Refusing to read or write '${file}'; it was left unchanged.`);
}

/** The store as an object, or a fresh empty one when the file does not exist. Shape-checked: a file
 * that parses but is not a ledger is as unusable as one that does not parse. */
function normalizeStore(data, file) {
  if (data === null || data === undefined) return { version: SCHEMA_VERSION, revision: 0, planPath: null, tasks: {} };
  if (typeof data !== 'object' || Array.isArray(data) || data.version !== SCHEMA_VERSION
    || typeof data.tasks !== 'object' || data.tasks === null || Array.isArray(data.tasks)) {
    throw unreadable(file, 'It is not a version-1 task-attempt ledger.');
  }
  for (const [id, entry] of Object.entries(data.tasks)) {
    if (!entry || !Number.isInteger(entry.nextToken) || !Array.isArray(entry.attempts)) {
      throw unreadable(file, `Task '${id}' has no readable attempt list.`);
    }
  }
  return data;
}

function readStore(file, fsImpl) {
  try {
    return normalizeStore(readTaskState(fsImpl, file), file);
  } catch (error) {
    if (error instanceof TaskAttemptError) throw error;
    throw unreadable(file, error.message);
  }
}

/** One locked read-decide-write. `apply(store)` returns `{result, write}`; with `write` false the
 * store is not touched, which is how a refusal or a stale token changes nothing. */
function mutate({ file, fsImpl, apply }) {
  let outcome = null;
  try {
    updateTaskState({
      fsImpl, file,
      build: (disk) => {
        const store = normalizeStore(disk, file);
        store.revision = (Number.isInteger(store.revision) ? store.revision : 0) + 1;
        outcome = apply(store);
        if (!outcome.write) throw new NoWrite();
        return store;
      },
    });
  } catch (error) {
    if (error instanceof NoWrite) return outcome.result;
    if (error instanceof TaskAttemptError) throw error;
    throw unreadable(file, error.message);
  }
  return outcome.result;
}

function entryFor(store, taskId) {
  if (!store.tasks[taskId]) store.tasks[taskId] = { nextToken: 1, attempts: [] };
  return store.tasks[taskId];
}

const activeAttempt = (entry) => (entry ? entry.attempts.find((a) => a.state === 'active') || null : null);
const doneAttempt = (entry) => (entry ? entry.attempts.find((a) => a.state === 'finished' && a.result === 'COMPLETED') || null : null);

function latestFinished(entry) {
  const finished = entry ? entry.attempts.filter((a) => a.state === 'finished') : [];
  return finished.length ? finished.reduce((a, b) => (b.token > a.token ? b : a)) : null;
}

// ── evidence ───────────────────────────────────────────────────────────────────────────────────

/** Evidence ids recorded in any task file under the evidence store, to tell "belongs to another task"
 * from "does not exist". Reads only; a file that cannot be read simply does not match. */
function evidenceBelongsElsewhere({ roots, slug, evidenceId, fsImpl }) {
  for (const root of roots) {
    const base = path.join(root, '.doflow', 'state', 'evidence');
    for (const dir of [base, path.join(base, slug)]) {
      let names = [];
      try { names = fsImpl.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8'));
          if (Array.isArray(data.evidence) && data.evidence.some((item) => item && item.id === evidenceId)) return true;
        } catch { /* unreadable files do not match */ }
      }
    }
  }
  return false;
}

/** The refusal reason for `evidenceId` as proof of a COMPLETED attempt, or null when it qualifies (FR-004). */
function evidenceRefusal({ evidenceId, slug, taskId, startedAt, roots, fsImpl }) {
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

function rootsFor({ cwd, lifecycleRoot }) {
  return uniq([path.resolve(cwd), lifecycleRoot]);
}

function claim({ file, fsImpl, roots, slug, task, owner, mode, now = new Date() }) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!owner || !SAFE_NAME.test(owner)) throw new TaskAttemptError('usage', '--owner is required: the name of the agent or person taking the task');
  if (!MODES.includes(mode)) throw new TaskAttemptError('usage', `--mode is required: one of ${MODES.join(', ')}`);
  const plan = loadPlan({ roots, slug, fsImpl });
  return mutate({
    file, fsImpl,
    apply: (store) => {
      const refuse = (reason, extra = {}) => ({ write: false, result: { disposition: 'refused', taskId: task, reason, ...extra } });
      const target = plan.tasks.find((t) => t.id === task);
      if (!target) return refuse('unknown-task');
      if (doneAttempt(store.tasks[task])) return refuse('already-done');
      const active = activeAttempt(store.tasks[task]);
      if (active) return refuse('active-attempt', { activeToken: active.token, owner: active.owner, startedAt: active.startedAt });
      const unmet = plan.tasks.filter((t) => t.phaseIndex < target.phaseIndex && !doneAttempt(store.tasks[t.id])).map((t) => t.id);
      if (unmet.length) return refuse('unmet-phase', { unmet });
      const entry = entryFor(store, task);
      const token = entry.nextToken;
      entry.nextToken += 1;
      entry.attempts.push({
        token, owner, mode, startedAt: now.toISOString(), taskLineHash: target.hash,
        state: 'active', result: null, evidenceId: null, reason: null,
      });
      store.planPath = plan.planPath;
      return { write: true, result: { disposition: 'claimed', taskId: task, token, revision: store.revision } };
    },
  });
}

function stale(taskId, token, reason) {
  return { write: false, result: { disposition: 'stale', taskId, token, reason } };
}

function finish({ file, fsImpl, roots, slug, task, token, result, evidenceId }) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!Number.isInteger(token) || token < 1) throw new TaskAttemptError('usage', '--token is required: the token claim returned');
  if (!RESULTS.includes(result)) throw new TaskAttemptError('usage', `--result is required: one of ${RESULTS.join(', ')}`);
  return mutate({
    file, fsImpl,
    apply: (store) => {
      const active = activeAttempt(store.tasks[task]);
      if (!active) return stale(task, token, 'no-active-attempt');
      if (active.token !== token) return stale(task, token, 'token-mismatch');
      const refuse = (reason) => ({ write: false, result: { disposition: 'refused', taskId: task, token, reason } });
      const plan = loadPlan({ roots, slug, fsImpl });
      const line = plan.tasks.find((t) => t.id === task);
      if (!line) return refuse('unknown-task');
      if (line.hash !== active.taskLineHash) return refuse('plan-changed');
      if (result === 'COMPLETED') {
        const why = evidenceRefusal({ evidenceId, slug, taskId: task, startedAt: active.startedAt, roots, fsImpl });
        if (why) return refuse(why);
      }
      active.state = 'finished';
      active.result = result;
      active.evidenceId = evidenceId || null;
      return { write: true, result: { disposition: 'applied', taskId: task, token, result, revision: store.revision } };
    },
  });
}

function release({ file, fsImpl, task, token, reason }) {
  if (!TASK_ID.test(task || '')) throw new TaskAttemptError('usage', '--task is required: a plan task id such as A.1');
  if (!Number.isInteger(token) || token < 1) throw new TaskAttemptError('usage', '--token is required: the token claim returned');
  if (!reason || !String(reason).trim()) throw new TaskAttemptError('usage', '--reason is required: why the attempt is being released');
  return mutate({
    file, fsImpl,
    apply: (store) => {
      const active = activeAttempt(store.tasks[task]);
      if (!active) return stale(task, token, 'no-active-attempt');
      if (active.token !== token) return stale(task, token, 'token-mismatch');
      active.state = 'released';
      active.reason = String(reason).trim();
      return { write: true, result: { disposition: 'released', taskId: task, token, revision: store.revision } };
    },
  });
}

/** Completion read from the ledger and the plan, never from checkboxes (FR-005). */
function status({ file, fsImpl, roots, slug }) {
  const plan = loadPlan({ roots, slug, fsImpl });
  const store = readStore(file, fsImpl);
  const tasks = plan.tasks.map((t) => {
    const entry = store.tasks[t.id];
    const active = activeAttempt(entry);
    const done = doneAttempt(entry);
    const last = latestFinished(entry);
    let derived;
    if (done) derived = 'done';
    else if (active) derived = 'running';
    else if (last && last.result === 'BLOCKED') derived = 'blocked';
    else if (plan.tasks.every((o) => o.phaseIndex >= t.phaseIndex || doneAttempt(store.tasks[o.id]))) derived = 'ready';
    else derived = 'pending';
    return {
      id: t.id, phase: t.phase, derived,
      activeToken: active ? active.token : null,
      doneToken: done ? done.token : null,
      active: active ? { owner: active.owner, mode: active.mode, startedAt: active.startedAt } : null,
    };
  });
  return {
    complete: tasks.length > 0 && tasks.every((t) => t.derived === 'done'),
    revision: store.revision,
    tasks,
    unclaimedChecked: plan.tasks.filter((t) => t.checked && !doneAttempt(store.tasks[t.id])).map((t) => t.id),
  };
}

/**
 * The orchestrator's question (FR-006): does this feature have a ledger, and is it complete?
 * `none` when no store exists (a feature that predates the ledger); `complete` or `incomplete`
 * otherwise. A store or plan that cannot be read throws, so the gate refuses rather than guessing.
 * @returns {{state: 'none'|'complete'|'incomplete', slug: string|null, incomplete: Array<string>}}
 */
function checkCompletion({ slug, cwd, fsImpl = fs }) {
  if (!isSafeSlug(slug)) return { state: 'none', slug: null, incomplete: [] };
  const lifecycleRoot = lifecycleProjectRoot(cwd);
  const file = storeFile(lifecycleRoot, slug);
  if (!fsImpl.existsSync(file)) return { state: 'none', slug, incomplete: [] };
  const answer = status({ file, fsImpl, roots: rootsFor({ cwd, lifecycleRoot }), slug });
  const incomplete = answer.tasks.filter((t) => t.derived !== 'done').map((t) => t.id);
  return { state: answer.complete ? 'complete' : 'incomplete', slug, incomplete };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function failure(code, message, json) {
  const { finishRuntime } = require('./cli-result.ts');
  if (json) console.log(JSON.stringify({ ok: false, error: code, message }, null, 2));
  else console.error(`doflow task-attempt: ${message}`);
  return finishRuntime(2);
}

function describe(result) {
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
} = {}) {
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
      case 'finish': answer = finish({ ...common, task, token: tokenNumber, result, evidenceId }); break;
      case 'release': answer = release({ ...common, task, token: tokenNumber, reason }); break;
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
  } catch (error) {
    if (error instanceof TaskAttemptError) return failure(error.code, error.message, json);
    throw error;
  }
}

module.exports = {
  handleTaskAttemptCommand, checkCompletion, claim, finish, release, status, loadPlan, taskLineHash,
  storeFile, TaskAttemptError, MODES, RESULTS, ACTIONS,
};
