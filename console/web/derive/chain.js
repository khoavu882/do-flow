// The chain model of the Session screen (feature 150, IC-016): one outline of a run's main session, stages and gates,
// tasks, attempts and worker runs. Pure functions over the run route's body and the worker-runs body: no DOM and no
// fetch, so console/test/derive-chain.test.ts runs it in Node. A node is placed under its parent only by a key a record
// holds (FR-003); a worker run no record ties to an attempt or to a listed granter goes to the unlinked group, with no
// guessed edge. An attempt whose worker runs were not all read is marked `not-checked`, never shown as having none (FR-004).

import { deriveRail, runToken, runWord, stateWord } from './rail.js';
import { stateFace } from './graph.js';

const isObject = (/** @type {any} */ value) => value !== null && typeof value === 'object';
const isCount = (/** @type {any} */ value) => Number.isInteger(value) && value >= 0;
/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The key of each node kind: the kind plus the record key, as the Session hash names it (IC-015). */
const keyOf = Object.freeze({
  main: () => 'main',
  stage: (/** @type {string} */ id) => `stage:${id}`,
  gate: (/** @type {string} */ id) => `gate:${id}`,
  tasks: () => 'tasks',
  task: (/** @type {string} */ id) => `task:${id}`,
  attempt: (/** @type {string} */ task, /** @type {number} */ token) => `attempt:${task}/${token}`,
  worker: (/** @type {string} */ runId) => `worker:${runId}`,
  unlinked: () => 'unlinked',
});

/** @type {Readonly<Record<string, string>>} */
const RUN_TOKEN = Object.freeze({ RUNNING: 'running', stale: 'stale', AWAITING_GATE: 'awaiting', COMPLETED: 'done', REJECTED: 'rejected' });

/** The look of a stage or gate: the Run rail's tone (`toneOf`, console/web/views/rail.js), here without the DOM module. @param {any} node */
function railTone(node) {
  if (node.type === 'stage' && node.state === 'done') return node.outcome === 'failed' ? 'failed' : node.outcome === 'unverified' ? 'unknown' : 'done';
  return node.state;
}

/** An attempt state (`CLOSED_SETS.attemptStates`) as a badge token and word. */
/** @type {Readonly<Record<string, { token: string, word: string }>>} */
const ATTEMPT_CHIP = Object.freeze({
  active: { token: 'running', word: 'Active' },
  finished: { token: 'done', word: 'Finished' },
  released: { token: 'pending', word: 'Released' },
  cancelled: { token: 'rejected', word: 'Cancelled' },
  superseded: { token: 'skipped', word: 'Superseded' },
});
const UNKNOWN_CHIP = Object.freeze({ token: 'unknown', word: 'Unknown' });

/** An attempt's chip. @param {any} attempt */
function attemptChip(attempt) {
  return (isObject(attempt) && Object.hasOwn(ATTEMPT_CHIP, attempt.state) ? ATTEMPT_CHIP[attempt.state] : null) ?? UNKNOWN_CHIP;
}

/** A worker run's phase (`CLOSED_SETS.phases`) before it ends. */
/** @type {Readonly<Record<string, { token: string, word: string }>>} */
const PHASE_CHIP = Object.freeze({
  starting: { token: 'running', word: 'Starting' },
  running: { token: 'running', word: 'Running' },
  cancelling: { token: 'running', word: 'Cancelling' },
});
/** A worker run's end state (`CLOSED_SETS.endStates`), as the Sessions view shows them. */
/** @type {Readonly<Record<string, { token: string, word: string }>>} */
const END_CHIP = Object.freeze({
  exited: { token: 'done', word: 'Exited' },
  'timed-out': { token: 'failed', word: 'Timed out' },
  cancelled: { token: 'failed', word: 'Cancelled' },
});
/** The `worker` member's state (`CLOSED_SETS.workerStates`), which carries liveness, for the selected run. */
/** @type {Readonly<Record<string, { token: string, word: string }>>} */
const WORKER_STATE_CHIP = Object.freeze({
  starting: PHASE_CHIP.starting,
  running: PHASE_CHIP.running,
  unknown: { token: 'unknown', word: 'Process state not known' },
  exited: END_CHIP.exited,
  'timed-out': END_CHIP['timed-out'],
  cancelled: END_CHIP.cancelled,
});

/**
 * A worker run's chip by its `phase` and `endState`; `state`, the `worker` member's state of the selected run, wins
 * when given. An older core's fallback list has `phase` null: its end state, if any, is all it says.
 * @param {any} run
 * @param {string | null} [state]
 */
function workerChip(run, state = null) {
  if (typeof state === 'string' && Object.hasOwn(WORKER_STATE_CHIP, state)) return WORKER_STATE_CHIP[state];
  const phase = isObject(run) ? run.phase : null;
  const end = isObject(run) ? run.endState : null;
  if (phase === 'ended' || phase === null || phase === undefined) {
    if (typeof end === 'string' && Object.hasOwn(END_CHIP, end)) return END_CHIP[end];
    return phase === 'ended' ? { token: 'unknown', word: 'Ended' } : UNKNOWN_CHIP;
  }
  return (typeof phase === 'string' && Object.hasOwn(PHASE_CHIP, phase) ? PHASE_CHIP[phase] : null) ?? UNKNOWN_CHIP;
}

/** Whether a worker run has not ended: its phase is not `ended` (a fallback run with no phase: it has no end state). @param {any} run */
function workerLive(run) {
  if (run.phase === null || run.phase === undefined) return run.endState === null || run.endState === undefined;
  return run.phase !== 'ended';
}

/**
 * Whether a node counts toward its parent's live count (IC-016): a stage on the run's current node, a gate that awaits,
 * a RUNNING task, an active attempt, a worker run that has not ended, and a group with a live child.
 * @param {any} node
 */
function isLive(node) {
  switch (node.kind) {
    case 'stage': return node.ref.state === 'running' || node.ref.state === 'stale';
    case 'gate': return node.ref.state === 'awaiting';
    case 'task': return node.ref.state === 'RUNNING';
    case 'attempt': return node.ref.state === 'active';
    case 'worker': return workerLive(node.ref);
    case 'tasks':
    case 'unlinked': return isCount(node.live) && node.live > 0;
    default: return false;
  }
}

/**
 * A node with its children's live count: null without children (data-model ChainNode `live`).
 * @param {string} key @param {string} kind @param {string} label @param {{ token: string, word: string }} chip @param {any[]} children
 * @param {string | null} marker @param {any} ref
 */
function makeNode(key, kind, label, chip, children, marker, ref) {
  return { key, kind, label, chip: { token: chip.token, word: chip.word }, children, live: children.length === 0 ? null : children.filter(isLive).length, marker, ref };
}

/** The Run view's sentence for a run without a task list. @param {any} reason */
function tasksReasonSentence(reason) {
  return reason === 'legacy-plan' ? 'This run’s plan is in an older format, so its tasks cannot be shown.' : 'This run has no task plan, so there are no tasks to show.';
}

/** A worker run summary, field by field (IC-011's `run`). @param {any} run */
const runRef = (run) => ({
  runId: run.runId, task: run.task, token: run.token, harness: run.harness ?? null, childOf: run.childOf ?? null, phase: run.phase ?? null,
  endState: run.endState ?? null, createdAt: run.createdAt ?? null, startedAt: run.startedAt ?? null, endedAt: run.endedAt ?? null, edit: run.edit ?? null,
});

/**
 * The chain of one run.
 * @param {{ run: any, workers: any, nowMs?: number }} input `run`: the body of `GET /api/runs/<slug>/<taskId>`; `workers`: the
 *   body of `GET /api/worker-runs/<slug>` (`source` `worker-runs` or `active-attempts`), or null when it could not be read
 * @returns {{ root: any, byKey: Map<string, any>, counts: any }}
 */
function deriveChain({ run, workers, nowMs = Date.now() }) {
  const row = isObject(run) && isObject(run.run) ? run.run : {};
  /** @type {Map<string, any>} */
  const byKey = new Map();
  /** @param {any} node */
  const index = (node) => { if (!byKey.has(node.key)) byKey.set(node.key, node); return node; };

  // ---- worker runs: the listed set, their granters, and whether every attempt's runs were read ----
  const readable = isObject(workers) && Array.isArray(workers.runs);
  const limits = readable && isObject(workers.limits) ? workers.limits : {};
  const notShown = isCount(limits.notShown) ? limits.notShown : 0;
  const ended = limits.ended === 'not-checked' ? 'not-checked' : readable ? 'listed' : null;
  const notChecked = !readable || notShown > 0 || ended === 'not-checked';
  /** @type {any[]} */
  const runs = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const entry of readable ? workers.runs : []) {
    if (!isObject(entry) || typeof entry.runId !== 'string' || seen.has(entry.runId)) continue;
    seen.add(entry.runId);
    runs.push(entry);
  }
  /** @type {Map<string, any[]>} children by granter run id */
  const grants = new Map();
  /** @type {Map<string, any[]>} top-level runs by `task/token` */
  const byAttempt = new Map();
  for (const entry of runs) {
    if (typeof entry.childOf === 'string') {
      if (seen.has(entry.childOf)) grants.set(entry.childOf, [...(grants.get(entry.childOf) ?? []), entry]);
    } else {
      const at = `${entry.task}/${entry.token}`;
      byAttempt.set(at, [...(byAttempt.get(at) ?? []), entry]);
    }
  }
  /** @type {Set<string>} */
  const placed = new Set();
  /**
   * A worker run node with the runs it granted under it; a run already placed (a `childOf` cycle) is not drawn twice.
   * @param {any} entry @param {string | null} marker
   * @returns {any}
   */
  const workerNode = (entry, marker) => {
    placed.add(entry.runId);
    /** @type {any[]} */
    const children = (grants.get(entry.runId) ?? []).filter((child) => !placed.has(child.runId)).map((child) => workerNode(child, null));
    return index(makeNode(keyOf.worker(entry.runId), 'worker', entry.runId, workerChip(entry), children, marker, runRef(entry)));
  };

  // ---- stages and gates: the Run rail's model ----
  const rail = deriveRail(run && run.workflow, row, run && run.timeline, nowMs);
  const railNodes = rail.nodes.map((node) => index(makeNode(
    node.type === 'gate' ? keyOf.gate(node.id) : keyOf.stage(node.id), node.type === 'gate' ? 'gate' : 'stage', node.id,
    { token: railTone(node), word: stateWord(node) }, [], null, node,
  )));

  // ---- tasks and attempts ----
  let attemptCount = 0;
  let notCheckedCount = 0;
  /** @type {any[]} */
  const mainChildren = [...railNodes];
  const taskBody = isObject(run) ? run.tasks : null;
  const taskRows = isObject(taskBody) && Array.isArray(taskBody.tasks) ? taskBody.tasks.filter((/** @type {any} */ task) => isObject(task) && typeof task.id === 'string') : null;
  if (taskRows !== null) {
    const taskNodes = taskRows.map((/** @type {any} */ task) => {
      const attempts = (Array.isArray(task.attempts) ? task.attempts : []).filter((/** @type {any} */ a) => isObject(a) && isCount(a.token));
      const attemptNodes = attempts.map((/** @type {any} */ attempt) => {
        attemptCount += 1;
        const own = (byAttempt.get(`${task.id}/${attempt.token}`) ?? []).filter((entry) => !placed.has(entry.runId)).map((entry) => workerNode(entry, null));
        const marker = own.length === 0 && notChecked ? 'not-checked' : null;
        if (marker !== null) notCheckedCount += 1;
        const ref = { task: task.id, token: attempt.token, owner: attempt.owner ?? null, mode: attempt.mode ?? null, state: attempt.state, result: attempt.result ?? null,
          startedAt: attempt.startedAt ?? null, endedAt: attempt.endedAt ?? null };
        return index(makeNode(keyOf.attempt(task.id, attempt.token), 'attempt', `Attempt ${attempt.token}`, attemptChip(attempt), own, marker, ref));
      });
      const face = stateFace(task.state);
      return index(makeNode(keyOf.task(task.id), 'task', task.id, { token: face.token, word: face.word }, attemptNodes, null, task));
    });
    const live = taskNodes.filter(isLive).length;
    mainChildren.push(index(makeNode(keyOf.tasks(), 'tasks', 'Tasks', { token: live > 0 ? 'running' : 'pending', word: plural(taskNodes.length, 'task', 'tasks') },
      taskNodes, null, { reason: null, sentence: null })));
  } else if (isObject(run) && typeof run.tasksReason === 'string') {
    mainChildren.push(index(makeNode(keyOf.tasks(), 'tasks', 'Tasks', { token: 'unknown', word: 'Not shown' }, [], null,
      { reason: run.tasksReason, sentence: tasksReasonSentence(run.tasksReason) })));
  }

  // ---- the unlinked group: runs no attempt or listed granter claims, and runs a granter cycle left out ----
  /** @type {any[]} */
  const loose = [];
  // In list order; a run placed meanwhile, as a child of an earlier unlinked run, keeps that recorded edge.
  for (const entry of runs) if (!placed.has(entry.runId)) loose.push(workerNode(entry, 'unlinked'));
  if (loose.length > 0) {
    mainChildren.push(index(makeNode(keyOf.unlinked(), 'unlinked', 'Not linked to an attempt', { token: 'unknown', word: plural(loose.length, 'worker run', 'worker runs') },
      loose, null, null)));
  }

  // ---- the main node: the run itself; no record names its coding-tool session (requirement A14) ----
  const token = runToken(row, nowMs);
  const mainRef = {
    taskId: row.taskId ?? null, featureSlug: row.featureSlug ?? null, taskClass: row.taskClass ?? null, workflowName: row.workflowName ?? null,
    state: row.state ?? null, startedAt: row.startedAt ?? null, updatedAt: row.updatedAt ?? null, degraded: rail.degraded,
  };
  const root = makeNode(keyOf.main(), 'main', typeof row.taskId === 'string' ? row.taskId : 'Run', { token: RUN_TOKEN[token] ?? 'unknown', word: runWord(row, nowMs) },
    mainChildren, 'unlinked', mainRef);
  byKey.set(root.key, root);

  const counts = {
    source: readable && workers.source === 'active-attempts' ? 'active-attempts' : readable ? 'worker-runs' : null,
    workers: readable ? 'read' : 'unavailable',
    runs: runs.length,
    notShown: readable ? notShown : null,
    ended,
    tasks: taskRows === null ? null : taskRows.length,
    attempts: attemptCount,
    notChecked: notCheckedCount,
    unlinked: loose.length,
  };
  return { root, byKey, counts };
}

/**
 * The outline head's sentence about what was not read (FR-004), or null when every worker run was listed.
 * @param {any} counts `deriveChain(...).counts`
 */
function headSentence(counts) {
  if (counts.workers === 'unavailable') return 'Worker runs could not be read, so they are not checked.';
  if (counts.ended === 'not-checked') {
    const lead = 'This version of DoFlow lists only the worker runs of active attempts, so ended attempts’ runs are not checked.';
    return counts.notShown > 0 ? `${lead} ${plural(counts.notShown, 'active attempt was', 'active attempts were')} not checked.` : lead;
  }
  if (counts.notShown > 0) return `${plural(counts.notShown, 'older worker run is', 'older worker runs are')} not shown, so some attempts’ runs are not checked.`;
  return null;
}

/** The words of a node marker. @param {string | null} marker */
function markerWords(marker) {
  if (marker === 'unlinked') return 'Not linked';
  if (marker === 'not-checked') return 'Worker runs not checked';
  return null;
}

export { deriveChain, headSentence, markerWords, workerChip, attemptChip, keyOf, isLive };
