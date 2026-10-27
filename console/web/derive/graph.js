// Task graph derivation (IC-010; plan task E.3; design.md section 7 V4). Pure functions: no DOM, no fetch and no clock
// reads (the caller passes `nowMs`), so console/test/derive-graph.test.ts runs it in Node. The input is the run route's
// `tasks` body (`{ revision, graph{ digest, tasks[] }, tasks[] }`, IC-005); nothing here reads a file path or a note.

const isObject = (/** @type {any} */ value) => value !== null && typeof value === 'object';
const timeOf = (/** @type {any} */ iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);

/** The lane of a task with neither an active attempt nor a declared owner. */
const UNASSIGNED = 'unassigned';

/**
 * Board geometry in px. The view writes these as custom properties; `placeBoard` and `edgePath` use the same figures,
 * so the cards, the lanes and the edges cannot drift apart.
 */
const GEOMETRY = Object.freeze({ cardW: 176, cardH: 76, gapX: 56, gapY: 12, lanePad: 12, labelW: 148, padX: 16, headH: 36 });

/**
 * The plan's tasks with their state: the graph tasks (plan order) joined to the status rows by id. A task without a
 * status row has null state, reason and budget and no attempts. Null when the body has no graph.
 * @param {any} body the run route's `tasks` body
 * @returns {Array<{ id: string, phase: string | null, owner: string | null, taskDeps: string[], parallel: boolean, state: string | null, reason: string | null, budget: { used: number, limit: number } | null, attempts: any[] }> | null}
 */
function mergeTasks(body) {
  if (!isObject(body) || !isObject(body.graph) || !Array.isArray(body.graph.tasks)) return null;
  /** @type {Map<string, any>} */
  const rows = new Map();
  for (const row of Array.isArray(body.tasks) ? body.tasks : []) if (isObject(row) && typeof row.id === 'string' && !rows.has(row.id)) rows.set(row.id, row);
  /** @type {Set<string>} */
  const seen = new Set();
  const merged = [];
  for (const graphTask of body.graph.tasks) {
    if (!isObject(graphTask) || typeof graphTask.id !== 'string' || seen.has(graphTask.id)) continue;
    seen.add(graphTask.id);
    const row = rows.get(graphTask.id);
    const budget = row && isObject(row.budget) && Number.isFinite(row.budget.used) && Number.isFinite(row.budget.limit) ? { used: row.budget.used, limit: row.budget.limit } : null;
    merged.push({
      id: graphTask.id,
      phase: typeof graphTask.phase === 'string' ? graphTask.phase : null,
      owner: typeof graphTask.owner === 'string' ? graphTask.owner : null,
      taskDeps: Array.isArray(graphTask.taskDeps) ? graphTask.taskDeps.filter((/** @type {any} */ dep) => typeof dep === 'string') : [],
      parallel: graphTask.parallel === true,
      state: row && typeof row.state === 'string' ? row.state : null,
      reason: row && typeof row.reason === 'string' ? row.reason : null,
      budget,
      attempts: row && Array.isArray(row.attempts) ? row.attempts.filter(isObject) : [],
    });
  }
  return merged;
}

/** The attempts of every task by id, for `layoutGraph`. @param {Array<{ id: string, attempts: any[] }>} tasks */
function attemptsByTask(tasks) {
  return new Map(tasks.map((task) => [task.id, task.attempts]));
}

/**
 * The lane label of a task and where it came from: the owner of its active attempt (the latest one in ledger order),
 * else the plan's declared owner, else `unassigned`.
 * @param {any} task
 * @param {any[]} attempts
 * @returns {{ label: string, source: 'attempt' | 'declared' | 'none' }}
 */
function laneOf(task, attempts) {
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const attempt = attempts[i];
    if (isObject(attempt) && attempt.state === 'active' && typeof attempt.owner === 'string' && attempt.owner.trim() !== '') return { label: attempt.owner, source: 'attempt' };
  }
  if (typeof task.owner === 'string' && task.owner.trim() !== '') return { label: task.owner, source: 'declared' };
  return { label: UNASSIGNED, source: 'none' };
}

/**
 * IC-010. `tasks` are in plan order; `attempts` maps a task id to its attempts (a Map or a plain object).
 *
 * - Layer = the longest path from a root over `taskDeps`. A task on a cycle, with a dependency that is not in the plan,
 *   or behind such a task has no layer: it goes to the final column (`layers - 1`) and carries `unresolved: true` and
 *   `why` (`cycle`, `missing-dependency` or `depends-on-unresolved`).
 * - Lane = the active attempt's owner, else the declared owner, else `unassigned`; lanes in order of first appearance
 *   in plan order (never sorted by name).
 * - A card sits at (layer, lane, order), where order counts the cards of that cell in plan order. A lane is as many rows
 *   tall as its fullest cell; `row` is the card's row on the whole board.
 * - An edge runs from a dependency to its dependent when the dependency's layer is the smaller; it is `straight` when
 *   both cards are on the same row, else an elbow. Edges inside the final column are not drawn.
 *
 * The result depends only on the arguments, so it is the same for the same `graph.digest` and attempt set.
 * @param {any[]} tasks
 * @param {Map<string, any[]> | Record<string, any[]>} [attempts]
 */
function layoutGraph(tasks, attempts = {}) {
  /** @type {Map<string, number>} */
  const index = new Map();
  /** @type {any[]} */
  const items = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isObject(task) || typeof task.id !== 'string' || index.has(task.id)) continue;
    index.set(task.id, items.length);
    items.push(task);
  }
  const count = items.length;
  const attemptsOf = (/** @type {string} */ id) => {
    const found = attempts instanceof Map ? attempts.get(id) : Object.hasOwn(attempts, id) ? attempts[id] : undefined;
    return Array.isArray(found) ? found : [];
  };

  const deps = items.map((task) => [...new Set(Array.isArray(task.taskDeps) ? task.taskDeps.filter((/** @type {any} */ dep) => typeof dep === 'string') : [])]);
  const missing = deps.map((list) => list.filter((dep) => !index.has(dep)));
  /** @type {number[][]} */
  const dependents = items.map(() => []);
  deps.forEach((list, i) => { for (const dep of list) { const at = index.get(dep); if (at !== undefined) dependents[at].push(i); } });

  // Kahn's algorithm: a task is released once every dependency is; a dependency outside the plan never releases it.
  const waiting = deps.map((list) => list.length);
  const layer = new Array(count).fill(0);
  /** @type {number[]} */
  const queue = [];
  for (let i = 0; i < count; i += 1) if (waiting[i] === 0) queue.push(i);
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    for (const next of dependents[at]) {
      layer[next] = Math.max(layer[next], layer[at] + 1);
      waiting[next] -= 1;
      if (waiting[next] === 0) queue.push(next);
    }
  }
  const resolved = new Set(queue);

  let resolvedLayers = 0;
  for (const at of queue) resolvedLayers = Math.max(resolvedLayers, layer[at] + 1);
  const unresolvedCount = count - queue.length;
  const layers = resolvedLayers + (unresolvedCount > 0 ? 1 : 0);

  /** Whether `start` can reach itself through unresolved dependencies. @param {number} start */
  const onCycle = (start) => {
    const stack = [...deps[start]];
    const visited = new Set();
    while (stack.length > 0) {
      const dep = /** @type {string} */ (stack.pop());
      const at = index.get(dep);
      if (at === undefined || resolved.has(at)) continue;
      if (at === start) return true;
      if (visited.has(at)) continue;
      visited.add(at);
      stack.push(...deps[at]);
    }
    return false;
  };

  // Lanes in order of first appearance.
  /** @type {Map<string, number>} */
  const laneIndex = new Map();
  /** @type {Array<{ index: number, label: string, count: number, rows: number, rowStart: number }>} */
  const lanes = [];
  /** @type {Map<string, number>} */
  const cell = new Map();
  const cards = items.map((task, i) => {
    const { label, source } = laneOf(task, attemptsOf(task.id));
    let lane = laneIndex.get(label);
    if (lane === undefined) {
      lane = lanes.length;
      laneIndex.set(label, lane);
      lanes.push({ index: lane, label, count: 0, rows: 1, rowStart: 0 });
    }
    lanes[lane].count += 1;
    const isResolved = resolved.has(i);
    const column = isResolved ? layer[i] : resolvedLayers;
    const key = `${lane}:${column}`;
    const order = cell.get(key) ?? 0;
    cell.set(key, order + 1);
    lanes[lane].rows = Math.max(lanes[lane].rows, order + 1);
    /** @type {string | null} */
    let why = null;
    if (!isResolved) why = missing[i].length > 0 ? 'missing-dependency' : onCycle(i) ? 'cycle' : 'depends-on-unresolved';
    return { id: task.id, phase: typeof task.phase === 'string' ? task.phase : null, layer: column, lane, order, row: 0, owner: label, ownerSource: source, unresolved: !isResolved, why, deps: deps[i], missing: missing[i] };
  });
  let rowStart = 0;
  for (const lane of lanes) {
    lane.rowStart = rowStart;
    rowStart += lane.rows;
  }
  for (const card of cards) card.row = lanes[card.lane].rowStart + card.order;

  const edges = [];
  for (const card of cards) {
    for (const dep of card.deps) {
      const at = index.get(dep);
      if (at === undefined) continue;
      const from = cards[at];
      if (from.layer >= card.layer) continue;
      edges.push({ from: from.id, to: card.id, straight: from.row === card.row });
    }
  }
  return { lanes, layers, cards, edges, unresolved: cards.filter((card) => card.unresolved).map((card) => ({ id: card.id, why: card.why })) };
}

/**
 * Pixel boxes for the board: each card's top-left corner (same order as `layout.cards`), each lane's band, the size.
 * @param {ReturnType<typeof layoutGraph>} layout
 * @param {typeof GEOMETRY} [g]
 */
function placeBoard(layout, g = GEOMETRY) {
  const rowH = g.cardH + g.gapY;
  const bandOf = (/** @type {number} */ rows) => rows * rowH - g.gapY + 2 * g.lanePad;
  let y = g.headH;
  const lanes = layout.lanes.map((lane) => {
    const band = { y, h: bandOf(lane.rows) };
    y += band.h;
    return band;
  });
  const boxes = layout.cards.map((card) => ({
    x: g.labelW + g.padX + card.layer * (g.cardW + g.gapX),
    y: lanes[card.lane].y + g.lanePad + (card.row - layout.lanes[card.lane].rowStart) * rowH,
  }));
  const columns = Math.max(layout.layers, 1);
  return { width: g.labelW + 2 * g.padX + columns * g.cardW + (columns - 1) * g.gapX, height: y, lanes, boxes };
}

/**
 * The SVG path of an edge between two placed cards: from the right edge of the dependency to the left edge of the
 * dependent. Straight on one row; otherwise horizontal, vertical in the gap before the dependent, horizontal. An edge
 * that spans several layers passes behind the cards of the layers between (the cards are drawn over it).
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @param {boolean} straight
 * @param {typeof GEOMETRY} [g]
 */
function edgePath(from, to, straight, g = GEOMETRY) {
  const x1 = from.x + g.cardW;
  const y1 = from.y + g.cardH / 2;
  const x2 = to.x;
  const y2 = to.y + g.cardH / 2;
  if (straight || y1 === y2) return `M${x1} ${y1}H${x2}`;
  return `M${x1} ${y1}H${x2 - g.gapX / 2}V${y2}H${x2}`;
}

/**
 * The keyboard map of the board (design.md V4): Left and Right walk the lane in layer order, Up and Down go to the
 * neighbouring lane (to its card nearest in layer, the earlier layer then the earlier cell on a tie), Home and End jump
 * to the lane's first and last card. Returns the id to focus, or null when the key does not move.
 * @param {ReturnType<typeof layoutGraph>} layout
 * @param {string} id
 * @param {string} key
 * @returns {string | null}
 */
function moveFocus(layout, id, key) {
  const from = layout.cards.find((card) => card.id === id);
  if (!from) return null;
  const inLane = (/** @type {number} */ lane) => layout.cards.filter((card) => card.lane === lane).sort((a, b) => a.layer - b.layer || a.order - b.order);
  if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End') {
    const walk = inLane(from.lane);
    const at = walk.findIndex((card) => card.id === id);
    const to = key === 'Home' ? 0 : key === 'End' ? walk.length - 1 : at + (key === 'ArrowRight' ? 1 : -1);
    return to === at || to < 0 || to >= walk.length ? null : walk[to].id;
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const lane = from.lane + (key === 'ArrowDown' ? 1 : -1);
    if (lane < 0 || lane >= layout.lanes.length) return null;
    const near = inLane(lane).reduce((best, card) => {
      if (best === null) return card;
      const d = Math.abs(card.layer - from.layer);
      const bd = Math.abs(best.layer - from.layer);
      return d < bd || (d === bd && card.layer < best.layer) ? card : best;
    }, /** @type {any} */ (null));
    return near ? near.id : null;
  }
  return null;
}

/** A task state as a design-system state: the token (the `data-state` of a badge), the icon and the word. */
/** @type {Readonly<Record<string, { token: string, face: string, word: string }>>} */
const STATE_FACE = Object.freeze({
  RUNNING: { token: 'running', face: 'running', word: 'Running' },
  SUCCEEDED: { token: 'done', face: 'check', word: 'Done' },
  FAILED: { token: 'failed', face: 'failed', word: 'Failed' },
  BLOCKED: { token: 'awaiting', face: 'awaiting', word: 'Blocked' },
  CANCELLED: { token: 'rejected', face: 'rejected', word: 'Cancelled' },
  READY: { token: 'pending', face: 'pending', word: 'Ready' },
  PLANNED: { token: 'pending', face: 'pending', word: 'Planned' },
});
const UNKNOWN_FACE = Object.freeze({ token: 'unknown', face: 'unknown', word: 'Unknown' });

/** @param {string | null | undefined} state */
function stateFace(state) {
  return (typeof state === 'string' && Object.hasOwn(STATE_FACE, state) ? STATE_FACE[state] : null) ?? UNKNOWN_FACE;
}

/** The closed set of task reasons (src/runtime/task-graph.ts) as one short sentence each. */
/** @type {Readonly<Record<string, string>>} */
const REASON_WORDS = Object.freeze({
  completed: 'Completed.',
  'active-attempt': 'An attempt is running.',
  budget: 'Its attempt budget is used up.',
  cancelled: 'Its last attempt was cancelled.',
  failed: 'Its last attempt failed.',
  'result-blocked': 'Its last attempt reported it blocked.',
  'dependency-held': 'A task it depends on is held.',
  'unmet-dependency': 'It waits for a task it depends on.',
  'unmet-phase': 'It waits for an earlier phase.',
  ready: 'Ready to start.',
  'plan-changed-after-done': 'The plan changed after it was done.',
  reopened: 'Reopened: its last attempt was superseded.',
});

/** @param {string | null | undefined} reason */
function reasonWords(reason) {
  return typeof reason === 'string' && Object.hasOwn(REASON_WORDS, reason) ? REASON_WORDS[reason] : null;
}

/** Why a task has no layer, in words. @param {string | null} why */
function unresolvedWords(why) {
  if (why === 'cycle') return 'It is part of a dependency cycle.';
  if (why === 'missing-dependency') return 'It depends on a task that is not in the plan.';
  if (why === 'depends-on-unresolved') return 'It waits on a task that cannot be placed.';
  return null;
}

const ATTEMPT_STATE_WORD = Object.freeze({ active: 'active', finished: 'finished', released: 'released', cancelled: 'cancelled', superseded: 'superseded' });
const RESULT_WORD = Object.freeze({ COMPLETED: 'completed', BLOCKED: 'blocked', ABANDONED: 'abandoned', INCONCLUSIVE: 'inconclusive', FAILED: 'failed' });

/**
 * The attempts of one task in ledger order, as the side panel lists them. `durationMs` is the time between the start and
 * the end; an attempt that has no end has none (the page does not count a running clock).
 * @param {any[]} attempts
 * @returns {Array<{ no: number, owner: string | null, mode: string | null, state: string, result: string | null, startedAt: string | null, endedAt: string | null, durationMs: number | null }>}
 */
function attemptList(attempts) {
  return (Array.isArray(attempts) ? attempts : []).filter(isObject).map((attempt, i) => {
    const start = timeOf(attempt.startedAt);
    const end = timeOf(attempt.endedAt);
    return {
      no: i + 1,
      owner: typeof attempt.owner === 'string' ? attempt.owner : null,
      mode: typeof attempt.mode === 'string' ? attempt.mode : null,
      state: Object.hasOwn(ATTEMPT_STATE_WORD, attempt.state) ? /** @type {any} */ (ATTEMPT_STATE_WORD)[attempt.state] : 'unknown',
      result: typeof attempt.result === 'string' && Object.hasOwn(RESULT_WORD, attempt.result) ? /** @type {any} */ (RESULT_WORD)[attempt.result] : null,
      startedAt: Number.isFinite(start) ? attempt.startedAt : null,
      endedAt: Number.isFinite(end) ? attempt.endedAt : null,
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
    };
  });
}

export { UNASSIGNED, GEOMETRY, STATE_FACE, REASON_WORDS, mergeTasks, attemptsByTask, laneOf, layoutGraph, placeBoard, edgePath, moveFocus, stateFace, reasonWords, unresolvedWords, attemptList };
