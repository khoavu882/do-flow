// Replay derivation (IC-014; plan task E.4; design.md section 7 V5, D-12). Pure functions: no DOM, no fetch and no
// clock reads, so console/test/derive-replay.test.ts runs it in Node. The merged event list is the run's timeline
// events (IC-012) plus, per task attempt, a `claim` event at its start and an end event at its end (IC-013);
// `stateAt` folds the list up to one index into the run row, the rail nodes and the task rows the views already draw.

import { eventWords } from './activity.js';
import { deriveRail, programOf } from './rail.js';
import { mergeTasks } from './graph.js';

const isObject = (/** @type {any} */ value) => value !== null && typeof value === 'object';
const timeOf = (/** @type {any} */ iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);

/** Run events sort before task events that share a moment (IC-014). */
const SOURCE_RANK = Object.freeze({ run: 0, task: 1 });
/** The attempt states that end an attempt, and the replay event each one makes. */
const END_KIND = Object.freeze({ finished: 'finish', released: 'release', cancelled: 'cancel', superseded: 'supersede' });
/** The speeds of the replay bar (design.md V5). */
const SPEEDS = Object.freeze([1, 4, 16]);
/** One step at 1x, in ms; faster speeds divide it, down to the floor. */
const STEP_MS = 1000;
const MIN_STEP_MS = 60;

/**
 * The merged, ordered event list. Order: time, then source (run before task), then original order; an event without a
 * valid time comes after the last timed one (`untimed`), in the same source-then-original order. The original order is
 * the journal order for run events, then plan order and ledger order (claim before end) for task events.
 * @param {any} timeline the run route's `timeline` body, or null
 * @param {any} tasksBody the run route's `tasks` body, or null
 * @returns {Array<{ index: number, source: 'run' | 'task', original: number, at: string | null, ms: number | null, untimed: boolean, kind: string, node: string | null, taskId: string | null, no: number | null, owner: string | null, mode: string | null, result: string | null, raw: any }>}
 */
function mergeEvents(timeline, tasksBody) {
  /** @type {any[]} */
  const list = [];
  /** The original order is per source: the journal order, and plan order then ledger order (claim before end). */
  /** @type {Record<string, number>} */
  const counts = { run: 0, task: 0 };
  const push = (/** @type {any} */ event) => {
    const ms = timeOf(event.at);
    list.push({ node: null, taskId: null, no: null, owner: null, mode: null, result: null, raw: null, ...event, original: counts[event.source]++, at: Number.isFinite(ms) ? event.at : null, ms: Number.isFinite(ms) ? ms : null, untimed: !Number.isFinite(ms) });
  };
  // Task events are gathered first on purpose: the sort below owns the run-before-task rule, not the gathering order.
  for (const task of mergeTasks(tasksBody) ?? []) {
    task.attempts.forEach((attempt, i) => {
      const common = { source: 'task', taskId: task.id, no: i + 1, owner: typeof attempt.owner === 'string' ? attempt.owner : null, mode: typeof attempt.mode === 'string' ? attempt.mode : null };
      push({ ...common, at: attempt.startedAt, kind: 'claim' });
      const end = Object.hasOwn(END_KIND, attempt.state) ? /** @type {Record<string, string>} */ (END_KIND)[attempt.state] : null;
      if (end !== null) push({ ...common, at: attempt.endedAt, kind: end, result: typeof attempt.result === 'string' ? attempt.result : null });
    });
  }
  const runEvents = isObject(timeline) && Array.isArray(timeline.events) ? timeline.events.filter(isObject) : [];
  for (const raw of runEvents) push({ source: 'run', at: raw.at, kind: String(raw.action), node: typeof raw.node === 'string' ? raw.node : null, raw });
  list.sort((a, b) => {
    if (a.untimed !== b.untimed) return a.untimed ? 1 : -1;
    if (!a.untimed && a.ms !== b.ms) return a.ms - b.ms;
    return SOURCE_RANK[/** @type {'run' | 'task'} */ (a.source)] - SOURCE_RANK[/** @type {'run' | 'task'} */ (b.source)] || a.original - b.original;
  });
  list.forEach((event, index) => { event.index = index; });
  return list;
}

/** The words of one event, as the banner and the range input's value text read them. @param {any} event */
function eventLabel(event) {
  if (event.source === 'run') return event.raw ? eventWords(event.raw) : event.kind;
  const who = event.owner === null ? '' : ` by ${event.owner}`;
  const head = `${event.taskId} attempt ${event.no}`;
  switch (event.kind) {
    case 'claim': return `${head} started${who}`;
    case 'finish': return `${head} finished${event.result === null ? '' : `, ${event.result.toLowerCase()}`}`;
    case 'release': return `${head} released${who}`;
    case 'cancel': return `${head} cancelled`;
    case 'supersede': return `${head} superseded`;
    default: return `${head} ${event.kind}`;
  }
}

/**
 * The run cursor after the run events in `included` (sorted order): the cursor only moves forward, so an event that sorts
 * late for want of a time cannot move the run back. A rejected gate stops the run there.
 * @param {any[]} included
 * @param {any[]} program
 */
function foldRun(included, program) {
  let cursor = 0;
  let rejected = -1;
  let completed = false;
  const past = (/** @type {'stage' | 'gate'} */ type, /** @type {string | null} */ id) => {
    const at = id === null ? -1 : program.findIndex((node) => node.type === type && node.id === id);
    cursor = Math.max(cursor, at >= 0 ? at + 1 : cursor + 1);
  };
  for (const event of included) {
    const action = event.kind;
    if (action === 'complete-stage' || action === 'skip-stage') past('stage', event.node);
    else if (action === 'skip-gate') past('gate', event.node);
    else if (action === 'decide-gate') {
      if (event.raw && event.raw.decision === 'reject') rejected = program.findIndex((node) => node.type === 'gate' && node.id === event.node);
      else past('gate', event.node);
    } else if (action === 'complete-run') completed = true;
  }
  if (rejected >= 0) return { state: 'REJECTED', cursor: rejected };
  if (completed || cursor >= program.length) return { state: 'COMPLETED', cursor: program.length };
  return { state: program[cursor].type === 'gate' ? 'AWAITING_GATE' : 'RUNNING', cursor };
}

/**
 * The task rows after the task events in `included`: each attempt as far as it had got, and the task state IC-005 gives
 * for those attempts. Ceiling: the plan-line staleness of a done task is not in the events (a task whose plan line
 * changed after it was done reads Done here), and the budget used is estimated from the live figure.
 * @param {any} body the run route's `tasks` body
 * @param {any[]} included
 */
function foldTasks(body, included) {
  const tasks = mergeTasks(body);
  if (tasks === null) return null;
  const claimed = new Set(included.filter((event) => event.source === 'task' && event.kind === 'claim').map((event) => `${event.taskId}#${event.no}`));
  const ended = new Set(included.filter((event) => event.source === 'task' && event.kind !== 'claim').map((event) => `${event.taskId}#${event.no}`));
  const phases = new Map();
  for (const task of tasks) if (!phases.has(task.phase)) phases.set(task.phase, phases.size);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Set<string>} */
  const walking = new Set();

  /** @param {string} id */
  const stateOf = (id) => {
    if (rows.has(id)) return rows.get(id).state;
    const task = byId.get(id);
    if (!task || walking.has(id)) return undefined;
    walking.add(id);
    const attempts = task.attempts.map((attempt, i) => ({ attempt, key: `${id}#${i + 1}` })).filter(({ key }) => claimed.has(key) || ended.has(key)).map(({ attempt, key }) => {
      if (ended.has(key) || !Object.hasOwn(END_KIND, attempt.state)) return attempt;
      return { ...attempt, state: 'active', endedAt: null, result: null };
    });
    const live = task.budget;
    const used = live === null ? null : Math.max(0, Math.min(attempts.length, live.used - (task.attempts.length - attempts.length)));
    const active = attempts.some((attempt) => attempt.state === 'active');
    const done = attempts.some((attempt) => attempt.state === 'finished' && attempt.result === 'COMPLETED');
    let last = null;
    attempts.forEach((attempt, i) => { if (attempt.state === 'finished' || attempt.state === 'cancelled' || attempt.state === 'superseded') last = { attempt, i }; });
    let state, reason;
    if (done) { state = 'SUCCEEDED'; reason = 'completed'; }
    else if (active) { state = 'RUNNING'; reason = 'active-attempt'; }
    else if (live !== null && used !== null && used >= live.limit) { state = 'BLOCKED'; reason = 'budget'; }
    else if (last && /** @type {any} */ (last).attempt.state === 'cancelled') { state = 'CANCELLED'; reason = 'cancelled'; }
    else {
      const readiness = readinessOf(task);
      const lastAttempt = last ? /** @type {any} */ (last).attempt : null;
      if (lastAttempt && lastAttempt.state === 'finished' && lastAttempt.result === 'FAILED') { state = 'FAILED'; reason = 'failed'; }
      else if (lastAttempt && lastAttempt.state === 'finished' && lastAttempt.result === 'BLOCKED') { state = 'BLOCKED'; reason = 'result-blocked'; }
      else if (readiness !== 'ready') { state = 'PLANNED'; reason = readiness; }
      else { state = 'READY'; reason = lastAttempt && lastAttempt.state === 'superseded' ? 'reopened' : 'ready'; }
    }
    walking.delete(id);
    rows.set(id, { id, state, reason, budget: live === null ? null : { used, limit: live.limit }, attempts });
    return state;
  };

  /** Why a task is not ready: `dependency-held`, `unmet-dependency`, `unmet-phase`, or `ready`. @param {any} task */
  const readinessOf = (task) => {
    const HOLDING = ['BLOCKED', 'FAILED', 'CANCELLED'];
    if (task.taskDeps.length > 0) {
      const deps = [...new Set(task.taskDeps)];
      const states = deps.map((dep) => stateOf(/** @type {string} */ (dep)));
      if (states.some((state) => HOLDING.includes(/** @type {string} */ (state)))) return 'dependency-held';
      return states.every((state) => state === 'SUCCEEDED') ? 'ready' : 'unmet-dependency';
    }
    const earlier = tasks.filter((other) => phases.get(other.phase) < phases.get(task.phase));
    return earlier.every((other) => stateOf(other.id) === 'SUCCEEDED') ? 'ready' : 'unmet-phase';
  };

  for (const task of tasks) stateOf(task.id);
  const live = new Set((Array.isArray(body.tasks) ? body.tasks : []).filter(isObject).map((/** @type {any} */ row) => row.id));
  return tasks.filter((task) => live.has(task.id)).map((task) => rows.get(task.id));
}

/**
 * The state after event `index`, built from the run route's body: the run row, the timeline up to the event, the task
 * rows, and the rail nodes the row and timeline give. `stateAt(events, last, base)` equals the live derivation (test).
 * `base.run` supplies every field the events do not carry (ids, class, the progress total); a run without a readable
 * timeline or workflow keeps its live row, and the task rows still replay.
 * @param {ReturnType<typeof mergeEvents>} events
 * @param {number} index clamped to the list
 * @param {{ run: any, workflow: any, timeline: any, tasks: any }} base
 */
function stateAt(events, index, base) {
  const at = clampIndex(index, events.length);
  const included = at < 0 ? [] : events.slice(0, at + 1);
  const moment = included.reduce((best, event) => (event.ms !== null && (best === null || event.ms > best) ? event.ms : best), /** @type {number | null} */ (null));
  const runEvents = included.filter((event) => event.source === 'run');
  const timelineEvents = runEvents.slice().sort((a, b) => a.original - b.original).map((event) => event.raw);
  const hasTimeline = isObject(base.timeline);
  const timeline = hasTimeline ? { ...base.timeline, events: timelineEvents } : base.timeline ?? null;
  const program = programOf(base.workflow);
  let row = base.run;
  if (hasTimeline && program !== null && program.length > 0) {
    const fold = foldRun(runEvents, program);
    const node = fold.cursor < program.length ? program[fold.cursor] : null;
    const current = node ? { type: node.type, id: node.id, kind: node.kind } : null;
    row = {
      ...base.run,
      state: fold.state,
      current,
      awaitingGate: fold.state === 'AWAITING_GATE' && current ? { gateId: current.id } : null,
      journalGateDiffers: false,
      progress: { ...(isObject(base.run.progress) ? base.run.progress : { total: program.length }), done: fold.cursor },
      updatedAt: moment === null ? base.run.updatedAt ?? null : new Date(moment).toISOString(),
    };
  }
  const rail = deriveRail(base.workflow, row, timeline, moment ?? 0);
  return {
    index: at,
    count: events.length,
    event: at < 0 ? null : events[at],
    moment,
    row,
    timeline,
    tasks: isObject(base.tasks) ? { ...base.tasks, tasks: foldTasks(base.tasks, included) } : base.tasks ?? null,
    cursor: rail.cursor,
    nodes: rail.nodes,
    degraded: rail.degraded,
  };
}

/**
 * The run route's body at one event: what `renderRun` and `renderGraph` draw instead of the live body. `nowMs` is the
 * moment (null when no event so far has a time), so nothing reads as stale or as running for days.
 * @param {any} data the run route's body
 * @param {ReturnType<typeof mergeEvents>} events
 * @param {number} index
 */
function viewAt(data, events, index) {
  const state = stateAt(events, index, { run: data.run, workflow: data.workflow, timeline: data.timeline ?? null, tasks: data.tasks ?? null });
  return { data: { ...data, run: state.row, timeline: state.timeline, tasks: state.tasks }, state };
}

/** @param {number} index @param {number} count */
function clampIndex(index, count) {
  if (count <= 0) return -1;
  return Number.isFinite(index) ? Math.min(count - 1, Math.max(0, Math.trunc(index))) : count - 1;
}

/** The index one event on, or back, never past either end. @param {number} index @param {number} count @param {number} delta */
function stepIndex(index, count, delta) {
  return clampIndex(index + delta, count);
}

/** The pause between two steps while playing. @param {number} speed */
function stepDelay(speed) {
  return Math.max(MIN_STEP_MS, Math.round(STEP_MS / (SPEEDS.includes(speed) ? speed : 1)));
}

/**
 * The replay banner's sentence: the moment, the position and the event.
 * @param {{ event: any, index: number, count: number }} at
 * @param {string | null} stamp the moment as the page writes times, or null when no event so far has a time
 */
function bannerWords({ event, index, count }, stamp) {
  const place = `event ${index + 1} of ${count}`;
  return `Replaying ${stamp === null ? 'a moment with no recorded time' : stamp} · ${place}${event ? `: ${eventLabel(event)}` : ''}`;
}

export { SPEEDS, STEP_MS, MIN_STEP_MS, END_KIND, mergeEvents, eventLabel, foldRun, foldTasks, stateAt, viewAt, clampIndex, stepIndex, stepDelay, bannerWords };
