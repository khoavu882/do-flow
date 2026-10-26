'use strict';

// The task graph's derivations (feature 093, IC-010; plan task E.3; design.md section 7 V4). Pure functions over the run
// route's `tasks` body: no DOM and no fetch. Control: ordering the lanes by name instead of by first appearance in plan
// order turns the order case red (the control rewrites a copy of derive/graph.js and re-runs the same case).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { project, CLOSED_SETS } = require('../src/project.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const GRAPH_SOURCE = fs.readFileSync(path.join(WEB_ROOT, 'derive', 'graph.js'), 'utf8');

let scratch: string[] = [];
let graph: any;

/** A copy of derive/graph.js (optionally rewritten) as an ES module a CommonJS package can import. */
async function load(source: string = GRAPH_SOURCE): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-graph-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, 'derive'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'derive', 'graph.js'), source);
  return import(pathToFileURL(path.join(dir, 'derive', 'graph.js')).href);
}

before(async () => { graph = await load(); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

// ---- bodies -----------------------------------------------------------------------------------------------

const t = (id: string, deps: string[] = [], owner: string | null = 'core-implementer', over: any = {}) => ({ id, phase: id.split('.')[0], owner, taskDeps: deps, parallel: false, ...over });
const att = (token: number, owner: string, state: string, over: any = {}) => ({ token, owner, mode: 'subagent', state, startedAt: '2026-10-26T01:00:00.000Z', endedAt: null, result: null, ...over });
const layerOf = (layout: any, id: string) => layout.cards.find((c: any) => c.id === id).layer;
const card = (layout: any, id: string) => layout.cards.find((c: any) => c.id === id);
const laneLabels = (layout: any) => layout.lanes.map((l: any) => l.label);

// ---- layers -----------------------------------------------------------------------------------------------

test('layers are the longest path from a root over taskDeps (a direct edge does not shorten a long path)', () => {
  const layout = graph.layoutGraph([t('A.1'), t('A.2'), t('B.1', ['A.1']), t('B.2', ['A.1', 'B.1']), t('C.1', ['A.2', 'B.2']), t('C.2', ['A.1', 'C.1'])]);
  assert.deepEqual(layout.cards.map((c: any) => [c.id, c.layer]), [['A.1', 0], ['A.2', 0], ['B.1', 1], ['B.2', 2], ['C.1', 3], ['C.2', 4]]);
  assert.equal(layout.layers, 5);
  assert.deepEqual(layout.unresolved, []);
});

test('no tasks, and a single task, lay out without error', () => {
  const none = graph.layoutGraph([], {});
  assert.deepEqual([none.lanes, none.cards, none.edges, none.layers], [[], [], [], 0]);
  const one = graph.layoutGraph([t('A.1')], {});
  assert.deepEqual([one.layers, one.cards.length, one.edges.length], [1, 1, 0]);
  assert.deepEqual(graph.layoutGraph(null, null).cards, []);
});

test('a cycle, a self-dependency and a dependency outside the plan land in the final unresolved column, with the reason', () => {
  const layout = graph.layoutGraph([
    t('A.1'),
    t('B.1', ['A.1']),
    t('X.1', ['X.2']), t('X.2', ['X.1']),
    t('X.3', ['X.2']),
    t('M.1', ['Z.9']),
    t('S.1', ['S.1']),
  ]);
  assert.deepEqual(layout.unresolved, [
    { id: 'X.1', why: 'cycle' }, { id: 'X.2', why: 'cycle' }, { id: 'X.3', why: 'depends-on-unresolved' }, { id: 'M.1', why: 'missing-dependency' }, { id: 'S.1', why: 'cycle' },
  ]);
  assert.equal(layout.layers, 3, 'two resolved layers and the unresolved one');
  for (const id of ['X.1', 'X.2', 'X.3', 'M.1', 'S.1']) {
    assert.equal(layerOf(layout, id), 2, id);
    assert.equal(card(layout, id).unresolved, true);
  }
  assert.deepEqual(['A.1', 'B.1'].map((id) => [layerOf(layout, id), card(layout, id).unresolved, card(layout, id).why]), [[0, false, null], [1, false, null]]);
  assert.deepEqual(card(layout, 'M.1').missing, ['Z.9'], 'the missing id is kept for the panel');
});

test('a resolved dependency of an unresolved task keeps its edge; no edge is drawn inside the unresolved column', () => {
  const layout = graph.layoutGraph([t('A.1'), t('X.1', ['A.1', 'X.2']), t('X.2', ['X.1'])]);
  assert.deepEqual(layout.edges.map((e: any) => `${e.from}>${e.to}`), ['A.1>X.1']);
});

// ---- lanes ------------------------------------------------------------------------------------------------

test('a task is in the lane of its active attempt, else its declared owner, else unassigned', () => {
  const tasks = [
    t('A.1', [], 'core-implementer'),
    t('A.2', [], 'core-implementer'),
    t('A.3', [], null),
    t('A.4', [], '   '),
    t('A.5', [], 'quality-guardian'),
  ];
  const attempts = {
    'A.1': [att(1, 'worker-a', 'active')],
    'A.2': [att(1, 'worker-b', 'released'), att(2, 'worker-c', 'finished', { result: 'COMPLETED' })],
    'A.3': [att(1, 'worker-d', 'active'), att(2, 'worker-e', 'active')],
    'A.5': [],
  };
  const layout = graph.layoutGraph(tasks, attempts);
  assert.deepEqual(layout.cards.map((c: any) => [c.id, c.owner, c.ownerSource]), [
    ['A.1', 'worker-a', 'attempt'],
    ['A.2', 'core-implementer', 'declared'],
    ['A.3', 'worker-e', 'attempt'],
    ['A.4', 'unassigned', 'none'],
    ['A.5', 'quality-guardian', 'declared'],
  ]);
});

test('lanes are ordered by first appearance in plan order, not by name', () => {
  const layout = graph.layoutGraph([t('A.1', [], 'zeta'), t('A.2', [], 'alpha'), t('A.3', [], 'zeta'), t('A.4', [], null), t('A.5', [], 'mid')]);
  assert.deepEqual(laneLabels(layout), ['zeta', 'alpha', 'unassigned', 'mid']);
  assert.deepEqual(layout.cards.map((c: any) => c.lane), [0, 1, 0, 2, 3]);
  assert.deepEqual(layout.lanes.map((l: any) => l.count), [2, 1, 1, 1]);
});

test('control: ordering the lanes by name instead of first appearance turns the order case red', async () => {
  // Rewrites the one place lane order is settled so that it sorts by label and remaps every card's lane to match.
  const byName = GRAPH_SOURCE.replace(
    'let rowStart = 0;\n  for (const lane of lanes) {',
    'const byLabel = [...lanes].sort((a, b) => a.label.localeCompare(b.label)); const slot = new Map(byLabel.map((l, k) => [l.label, k])); for (const c of cards) c.lane = /** @type {number} */ (slot.get(c.owner)); lanes.length = 0; byLabel.forEach((l, k) => { l.index = k; lanes.push(l); });\n  let rowStart = 0;\n  for (const lane of lanes) {',
  );
  assert.notEqual(byName, GRAPH_SOURCE, 'the control rewrote the source');
  const mutated = await load(byName);
  const tasks = [t('A.1', [], 'zeta'), t('A.2', [], 'alpha'), t('A.3', [], 'mid')];
  assert.deepEqual(laneLabels(graph.layoutGraph(tasks)), ['zeta', 'alpha', 'mid'], 'the shipped code keeps plan order');
  assert.deepEqual(laneLabels(mutated.layoutGraph(tasks)), ['alpha', 'mid', 'zeta'], 'the control sorts by name');
  assert.notDeepEqual(laneLabels(mutated.layoutGraph(tasks)), laneLabels(graph.layoutGraph(tasks)), 'so the order case would be red');
});

test('cards in one cell stack in plan order; a lane is as tall as its fullest cell; rows run on across lanes', () => {
  const layout = graph.layoutGraph([
    t('A.1', [], 'one'), t('A.2', [], 'one'), t('A.3', [], 'one'),
    t('B.1', ['A.1'], 'two'),
    t('B.2', ['A.1'], 'one'),
  ]);
  assert.deepEqual(layout.cards.map((c: any) => [c.id, c.lane, c.layer, c.order, c.row]), [
    ['A.1', 0, 0, 0, 0], ['A.2', 0, 0, 1, 1], ['A.3', 0, 0, 2, 2], ['B.1', 1, 1, 0, 3], ['B.2', 0, 1, 0, 0],
  ]);
  assert.deepEqual(layout.lanes.map((l: any) => [l.label, l.rows, l.rowStart]), [['one', 3, 0], ['two', 1, 3]]);
});

// ---- edges and geometry -----------------------------------------------------------------------------------

test('an edge runs from a dependency to its dependent; on one row it is straight, otherwise an elbow', () => {
  const layout = graph.layoutGraph([t('A.1', [], 'one'), t('A.2', ['A.1'], 'one'), t('A.3', ['A.1'], 'two'), t('A.4', ['A.2', 'A.3'], 'one')]);
  assert.deepEqual(layout.edges, [
    { from: 'A.1', to: 'A.2', straight: true },
    { from: 'A.1', to: 'A.3', straight: false },
    { from: 'A.2', to: 'A.4', straight: true },
    { from: 'A.3', to: 'A.4', straight: false },
  ]);
});

test('placeBoard and edgePath: boxes follow layer and row, a straight edge is one line, an elbow turns in the gap before the dependent', () => {
  const g = graph.GEOMETRY;
  const layout = graph.layoutGraph([t('A.1', [], 'one'), t('A.2', ['A.1'], 'one'), t('A.3', ['A.1'], 'two')]);
  const board = graph.placeBoard(layout);
  const [a1, a2, a3] = board.boxes;
  assert.equal(a1.x, g.labelW + g.padX);
  assert.equal(a2.x, a1.x + g.cardW + g.gapX);
  assert.equal(a2.y, a1.y, 'same row');
  assert.equal(board.lanes[1].y, board.lanes[0].y + board.lanes[0].h, 'bands abut');
  assert.equal(a3.y, board.lanes[1].y + g.lanePad);
  assert.equal(board.width, g.labelW + 2 * g.padX + 2 * g.cardW + g.gapX);
  assert.equal(board.height, g.headH + board.lanes[0].h + board.lanes[1].h);
  const mid = (box: any) => box.y + g.cardH / 2;
  assert.equal(graph.edgePath(a1, a2, true), `M${a1.x + g.cardW} ${mid(a1)}H${a2.x}`);
  assert.equal(graph.edgePath(a1, a3, false), `M${a1.x + g.cardW} ${mid(a1)}H${a3.x - g.gapX / 2}V${mid(a3)}H${a3.x}`);
  assert.equal(graph.placeBoard(graph.layoutGraph([])).width > 0, true, 'an empty board still has a size');
});

// ---- determinism, size, speed -----------------------------------------------------------------------------

function fixtureBody(): any {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'core', 'attempts.json'), 'utf8'));
  const projected = project('attempts', raw);
  assert.ok(projected.ok, 'the captured inspect body projects');
  return projected.body;
}

test('the captured inspect body lays out the same way every time, whatever the insertion order of the attempts', () => {
  const body = fixtureBody();
  const merged = graph.mergeTasks(body);
  assert.ok(merged.length >= 5);
  const first = graph.layoutGraph(merged, graph.attemptsByTask(merged));
  assert.deepEqual(graph.layoutGraph(merged, graph.attemptsByTask(merged)), first);
  const reversed = Object.fromEntries([...graph.attemptsByTask(merged)].reverse());
  assert.deepEqual(graph.layoutGraph(JSON.parse(JSON.stringify(merged)), reversed), first, 'a plain object in another key order, a deep copy of the tasks');
  assert.deepEqual(graph.placeBoard(first), graph.placeBoard(JSON.parse(JSON.stringify(first))));
  // B.1 waits for A.1 and A.2; its dependents come after it.
  assert.equal(layerOf(first, 'A.1'), 0);
  assert.equal(layerOf(first, 'B.1'), 1);
  assert.ok(layerOf(first, 'C.1') >= 2);
  assert.deepEqual(first.unresolved, []);
  // A.1 has an active attempt by "worker-a"; the lane label is the attempt's, not the plan's.
  assert.equal(card(first, 'A.1').owner, 'worker-a');
  assert.equal(card(first, 'A.1').ownerSource, 'attempt');
});

test('500 tasks lay out and place in under 50 ms', () => {
  const tasks = Array.from({ length: 500 }, (_, i) => t(`T.${i}`, [i > 0 ? `T.${i - 1}` : null, i > 7 ? `T.${i - 7}` : null, i > 30 ? `T.${i - 30}` : null].filter(Boolean) as string[], `owner-${i % 9}`));
  const run = () => {
    const start = performance.now();
    const layout = graph.layoutGraph(tasks, {});
    graph.placeBoard(layout);
    return [performance.now() - start, layout] as const;
  };
  run();
  const best = Math.min(...[run(), run(), run(), run(), run()].map(([ms]) => ms));
  assert.ok(best < 50, `best of five: ${best.toFixed(1)} ms`);
  const [, layout] = run();
  assert.equal(layout.cards.length, 500);
  assert.equal(layout.layers, 500, 'the chain through T.i-1 makes every task one layer deeper');
  assert.equal(layout.lanes.length, 9);
});

test('a fully cyclic plan of 500 tasks still lays out in under 50 ms', () => {
  const tasks = Array.from({ length: 500 }, (_, i) => t(`T.${i}`, [`T.${(i + 1) % 500}`]));
  // One warm-up, then the best of five: the bound measures the algorithm, not a loaded machine's scheduling.
  const run = () => {
    const start = performance.now();
    const layout = graph.layoutGraph(tasks, {});
    return [performance.now() - start, layout] as const;
  };
  run();
  const runs = [run(), run(), run(), run(), run()];
  const best = Math.min(...runs.map(([ms]) => ms));
  assert.equal(runs[0][1].unresolved.length, 500);
  assert.ok(best < 50, `best of five: ${best.toFixed(1)} ms`);
});

// ---- the join, the keyboard map and the words -------------------------------------------------------------

test('mergeTasks joins the graph tasks (plan order) to the status rows by id, and is null without a graph', () => {
  const body = {
    revision: 1,
    graph: { digest: 'sha256:x', graphPlan: true, tasks: [t('A.1'), t('A.2', ['A.1']), t('A.1', ['A.2']), { id: 7 }], overlaps: [] },
    tasks: [{ id: 'A.2', state: 'READY', reason: 'ready', budget: { used: 1, limit: 3 }, attempts: [att(1, 'w', 'active'), 'junk'] }, { id: 'Q.9', state: 'RUNNING', reason: 'active-attempt', budget: { used: 0, limit: 1 }, attempts: [] }],
  };
  const merged = graph.mergeTasks(body);
  assert.deepEqual(merged.map((m: any) => m.id), ['A.1', 'A.2'], 'plan order; the duplicate and the non-string id are dropped; a row of no plan task is ignored');
  assert.deepEqual([merged[0].state, merged[0].budget, merged[0].attempts], [null, null, []]);
  assert.deepEqual([merged[1].state, merged[1].reason, merged[1].budget, merged[1].attempts.length], ['READY', 'ready', { used: 1, limit: 3 }, 1]);
  for (const bad of [null, undefined, {}, { graph: {} }, { graph: { tasks: 'x' } }, 'text']) assert.equal(graph.mergeTasks(bad), null);
});

test('moveFocus: Left and Right walk the lane in layer order, Up and Down change lane to the nearest layer, Home and End jump', () => {
  const layout = graph.layoutGraph([
    t('A.1', [], 'one'), t('A.2', [], 'two'), t('B.1', ['A.1'], 'one'), t('B.2', ['A.1', 'A.2'], 'two'), t('C.1', ['B.1'], 'one'), t('C.2', ['C.1', 'B.2'], 'three'), t('A.3', [], 'one'),
  ]);
  // lane one, in layer order: A.1 A.3 (layer 0), B.1 (1), C.1 (2)
  const move = (from: string, key: string) => graph.moveFocus(layout, from, key);
  assert.equal(move('A.1', 'ArrowRight'), 'A.3', 'same cell: the next in plan order');
  assert.equal(move('A.3', 'ArrowRight'), 'B.1');
  assert.equal(move('B.1', 'ArrowRight'), 'C.1');
  assert.equal(move('C.1', 'ArrowRight'), null, 'the end of the lane');
  assert.equal(move('B.1', 'ArrowLeft'), 'A.3');
  assert.equal(move('A.1', 'ArrowLeft'), null);
  assert.equal(move('B.1', 'Home'), 'A.1');
  assert.equal(move('B.1', 'End'), 'C.1');
  assert.equal(move('B.1', 'ArrowDown'), 'B.2', 'layer 1 in lane two');
  assert.equal(move('C.1', 'ArrowDown'), 'B.2', 'lane two has no layer 2: the nearest is layer 1');
  assert.equal(move('B.2', 'ArrowDown'), 'C.2', 'lane three');
  assert.equal(move('C.2', 'ArrowDown'), null, 'the last lane');
  assert.equal(move('B.2', 'ArrowUp'), 'B.1');
  assert.equal(move('A.1', 'ArrowUp'), null, 'the first lane');
  assert.equal(move('A.1', 'Enter'), null);
  assert.equal(move('nope', 'ArrowRight'), null);
});

test('every task state and reason of the contract has its words; anything else reads unknown', () => {
  for (const state of CLOSED_SETS.taskStates) {
    const face = graph.stateFace(state);
    assert.notEqual(face.token, 'unknown', state);
    assert.match(face.word, /^[A-Z][a-z]+$/);
  }
  assert.deepEqual(graph.stateFace('RUNNING'), { token: 'running', face: 'running', word: 'Running' });
  assert.equal(graph.stateFace('SUCCEEDED').token, 'done');
  assert.equal(graph.stateFace('FAILED').token, 'failed');
  for (const odd of [null, undefined, 'IN_PROGRESS', '__proto__', 'toString']) assert.equal(graph.stateFace(odd).token, 'unknown', String(odd));
  for (const reason of CLOSED_SETS.taskReasons) assert.match(graph.reasonWords(reason), /\.$/, reason);
  assert.deepEqual(Object.keys(graph.REASON_WORDS).sort(), [...CLOSED_SETS.taskReasons].sort(), 'no word without a reason, no reason without a word');
  assert.equal(graph.reasonWords('toString'), null);
  assert.equal(graph.unresolvedWords('cycle'), 'It is part of a dependency cycle.');
  assert.equal(graph.unresolvedWords(null), null);
});

test('attemptList keeps ledger order and numbers the attempts; a missing end has no duration', () => {
  const list = graph.attemptList([
    att(1, 'w-a', 'finished', { endedAt: '2026-10-26T01:30:00.000Z', result: 'FAILED' }),
    att(2, 'w-b', 'active'),
    att(3, 'w-c', 'weird', { startedAt: 'not a time', mode: 7 }),
    'junk',
  ]);
  assert.deepEqual(list.map((a: any) => [a.no, a.owner, a.state, a.result, a.durationMs]), [[1, 'w-a', 'finished', 'failed', 30 * 60_000], [2, 'w-b', 'active', null, null], [3, 'w-c', 'unknown', null, null]]);
  assert.equal(list[2].startedAt, null);
  assert.equal(list[2].mode, null);
  assert.deepEqual(graph.attemptList(null), []);
});
