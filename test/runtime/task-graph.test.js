'use strict';
// task-graph.test.js — graph validation, digest, tuples, overlaps and the attempt limit
// (feature 080, A.3; IC-003, IC-004, IC-008, IC-016, DEC-002, DEC-008, FR-001, FR-002, FR-009).
//
// In-process over `parsePlan` text: `buildGraph` is pure, so a library call is the whole contract.
// The `loadPlan` cases write a plan into a temp dir because `loadPlan` reads one from disk.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { parsePlan } = require('../../src/runtime/scaffold/artifacts.ts');
const {
  DEFAULT_TASK_ATTEMPTS, buildGraph, isGraphPlan, graphTuples, graphDigest, overlaps, taskAttemptLimit,
} = require('../../src/runtime/task-graph.ts');
const { loadPlan, TaskAttemptError } = require('../../src/runtime/task-attempts.ts');

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'plans');

const plan = (lines, header = []) => ['# Plan', '', ...header, '', '## 8. Tasks', '', ...lines, ''].join('\n');
const build = (lines, header) => buildGraph(parsePlan(plan(lines, header)));
const GRAPH = ['**Task graph:** v1'];

test('a well-formed plan builds, with phase order from first appearance and dependencies first', () => {
  const built = build([
    '- [ ] A.1 First — files: src/a.ts',
    '- [ ] A.2 Second; depends-on: A.1',
    '- [ ] B.1 Third',
  ]);
  assert.equal(built.ok, true);
  assert.deepEqual(built.warnings, []);
  assert.deepEqual(built.graph.phases, ['A', 'B']);
  assert.deepEqual(built.graph.tasks.map((t) => [t.id, t.phaseIndex]), [['A.1', 0], ['A.2', 0], ['B.1', 1]]);
  assert.deepEqual(built.graph.order, ['A.1', 'A.2', 'B.1']);
});

test('duplicate-id alone', () => {
  const built = build(['- [ ] A.1 one', '- [ ] A.1 again', '- [ ] A.1 thrice']);
  assert.deepEqual(built, { ok: false, problems: [{ kind: 'duplicate-id', ids: ['A.1'] }], warnings: [] });
});

test('unknown-dependency alone', () => {
  const built = build(['- [ ] A.1 one; depends-on: A.9']);
  assert.deepEqual(built, { ok: false, problems: [{ kind: 'unknown-dependency', ids: ['A.1', 'A.9'] }], warnings: [] });
});

test('a self-dependency is a cycle', () => {
  const built = build(['- [ ] A.1 one; depends-on: A.1']);
  assert.deepEqual(built, { ok: false, problems: [{ kind: 'cycle', ids: ['A.1'], via: ['A.1->A.1'] }], warnings: [] });
});

test('an explicit two-task cycle', () => {
  const built = build(['- [ ] A.1 one; depends-on: A.2', '- [ ] A.2 two; depends-on: A.1']);
  assert.deepEqual(built, { ok: false, problems: [{ kind: 'cycle', ids: ['A.1', 'A.2'], via: ['A.1->A.2', 'A.2->A.1'] }], warnings: [] });
});

test('a dependency on a later phase cycles through an implicit :phase edge (design debate A-M1)', () => {
  // A.1 waits on B.1 explicitly; B.1 declares nothing, so it waits on every phase-A task. Neither
  // can ever be ready, although every explicit edge on its own is acyclic.
  const built = build(['- [ ] A.1 one; depends-on: B.1', '- [ ] B.1 two']);
  assert.deepEqual(built, { ok: false, problems: [{ kind: 'cycle', ids: ['A.1', 'B.1'], via: ['A.1->B.1', 'B.1->A.1:phase'] }], warnings: [] });
});

test('a declared dependency replaces the implicit phase edges', () => {
  const built = build(['- [ ] A.1 one', '- [ ] A.2 two; depends-on: B.1', '- [ ] B.1 three; depends-on: A.1']);
  assert.equal(built.ok, true, JSON.stringify(built.problems));
  assert.deepEqual(built.graph.order, ['A.1', 'B.1', 'A.2']);
});

test('cycle order is deterministic: plan-order roots and successors', () => {
  const lines = [
    '- [ ] A.1 one; depends-on: A.3',
    '- [ ] A.2 two; depends-on: A.1',
    '- [ ] A.3 three; depends-on: A.2',
    '- [ ] A.4 four; depends-on: A.4',
  ];
  const first = build(lines);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(build(lines), first);
  assert.deepEqual(first.problems, [
    { kind: 'cycle', ids: ['A.1', 'A.3', 'A.2'], via: ['A.1->A.3', 'A.3->A.2', 'A.2->A.1'] },
    { kind: 'cycle', ids: ['A.4'], via: ['A.4->A.4'] },
  ]);
});

test('bad-dependency only with the header; otherwise a near-miss-dependency warning', () => {
  const line = ['- [ ] A.1 one', '- [ ] A.2 two; depends-on: A.1 (after review)'];
  assert.deepEqual(build(line, GRAPH), { ok: false, problems: [{ kind: 'bad-dependency', ids: ['A.2'], value: 'A.1 (after review)' }], warnings: [] });
  const legacy = build(line);
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.warnings, [{ kind: 'near-miss-dependency', ids: ['A.2'], value: 'A.1 (after review)' }]);
});

test('bad-acceptance alone, one problem per failing token', () => {
  const built = build(['- [ ] A.1 one — acceptance: FR-001, NFR-002, IC-003, US1, S-bad-graph, FR-1, s-Upper']);
  assert.deepEqual(built, { ok: false, problems: [
    { kind: 'bad-acceptance', ids: ['A.1'], value: 'FR-1' },
    { kind: 'bad-acceptance', ids: ['A.1'], value: 's-Upper' },
  ], warnings: [] });
});

test('bad-budget alone', () => {
  assert.deepEqual(build(['- [ ] A.1 one — budget: attempts=0']), { ok: false, problems: [{ kind: 'bad-budget', ids: ['A.1'], value: 'attempts=0' }], warnings: [] });
});

test('bad-header alone', () => {
  assert.deepEqual(build(['- [ ] A.1 one'], ['**Task graph:** v2']), { ok: false, problems: [{ kind: 'bad-header', ids: [], value: 'v2' }], warnings: [] });
});

test('every problem kind together is reported in one result', () => {
  const lines = [
    '- [ ] A.1 one; depends-on: B.1',
    '- [ ] A.1 again',
    '- [ ] A.2 two; depends-on: A.9, A.2 (later); acceptance: FR-9; budget: attempts=x',
    '- [ ] B.1 three',
  ];
  // bad-dependency needs a valid header and bad-header an invalid one, so they cannot share a plan.
  const graph = build(lines, GRAPH);
  assert.equal(graph.ok, false);
  assert.deepEqual(graph.problems.map((p) => p.kind), [
    'duplicate-id', 'unknown-dependency', 'bad-dependency', 'bad-acceptance', 'bad-budget', 'cycle',
  ]);
  assert.deepEqual(graph.problems.find((p) => p.kind === 'cycle'), { kind: 'cycle', ids: ['A.1', 'B.1'], via: ['A.1->B.1', 'B.1->A.1:phase'] });
  const header = build(lines, ['**Task graph:** v9']);
  assert.deepEqual(header.problems.map((p) => p.kind), [
    'bad-header', 'duplicate-id', 'unknown-dependency', 'bad-acceptance', 'bad-budget', 'cycle',
  ]);
});

test('isGraphPlan reads only the header (DEC-008)', () => {
  assert.equal(isGraphPlan(parsePlan(plan(['- [ ] A.1 one'], GRAPH))), true);
  assert.equal(isGraphPlan(build(['- [ ] A.1 one'], GRAPH).graph), true);
  assert.equal(isGraphPlan(build(['- [ ] A.1 one — owner: x; budget: attempts=3; acceptance: FR-001']).graph), false);
});

test('graphTuples are the IC-004 tuple list in plan order', () => {
  const { graph } = build(['- [ ] A.1 [P] one — owner: o; files: src/a.ts; acceptance: FR-001; budget: attempts=3', '- [ ] A.2 two; depends-on: A.1']);
  assert.deepEqual(graphTuples(graph), [
    ['A.1', 'A', 'o', [], true, ['FR-001'], { attempts: 3 }, ['src/a.ts']],
    ['A.2', 'A', null, ['A.1'], false, [], null, []],
  ]);
});

test('graphDigest ignores descriptions and checkboxes and follows files', () => {
  const base = ['- [ ] A.1 one — files: src/a.ts', '- [ ] A.2 two; depends-on: A.1'];
  const digest = graphDigest(build(base).graph);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(graphDigest(build(['- [x] A.1 reworded entirely — files: src/a.ts', base[1]]).graph), digest, 'description and checkbox');
  assert.notEqual(graphDigest(build(['- [ ] A.1 one — files: src/b.ts', base[1]]).graph), digest, 'files');
  assert.notEqual(graphDigest(build(['- [ ] A.1 one — files: src/a.ts', '- [ ] A.2 two']).graph), digest, 'dependencies');
});

test('overlaps: shared files after trimming and a leading ./, each pair once in plan order', () => {
  const { graph } = build([
    '- [ ] A.1 one — files: ./src/a.ts, src/b.ts',
    '- [ ] A.2 two — files: src/a.ts, src/c.ts',
    '- [ ] A.3 three — files: src/c.ts, src/b.ts, ./src/a.ts',
    '- [ ] A.4 four — files: src/d.ts',
  ]);
  assert.deepEqual(overlaps(graph), [
    { a: 'A.1', b: 'A.2', files: ['src/a.ts'] },
    { a: 'A.1', b: 'A.3', files: ['src/a.ts', 'src/b.ts'] },
    { a: 'A.2', b: 'A.3', files: ['src/a.ts', 'src/c.ts'] },
  ]);
});

test('taskAttemptLimit: default 20 unless the plan declares one (IC-008, DEC-002)', () => {
  assert.equal(DEFAULT_TASK_ATTEMPTS, 20);
  const { graph } = build(['- [ ] A.1 one', '- [ ] A.2 two — budget: attempts=3']);
  assert.deepEqual(taskAttemptLimit(graph.tasks[0]), { limit: 20, source: 'default' });
  assert.deepEqual(taskAttemptLimit(graph.tasks[1]), { limit: 3, source: 'plan' });
});

test('the committed 8ce5ad7 fixture plans build with no problem', () => {
  for (const name of ['070-task-attempt-ledger', '076-evidence-attempts', '078-scoped-context-arbitration']) {
    const built = buildGraph(parsePlan(fs.readFileSync(path.join(FIXTURES, name, 'plan.md'), 'utf8')));
    assert.equal(built.ok, true, `${name}: ${JSON.stringify(built.problems)}`);
  }
});

function planDir(t, text) {
  const root = tempDir(t, 'doflow-task-graph-');
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', '900-g'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', '900-g', 'plan.md'), text);
  return root;
}

test('loadPlan refuses plan-malformed with every problem attached', (t) => {
  const root = planDir(t, plan(['- [ ] A.1 one; depends-on: B.1', '- [ ] B.1 two — budget: attempts=0']));
  assert.throws(() => loadPlan({ roots: [root], slug: '900-g' }), (error) => {
    assert.ok(error instanceof TaskAttemptError);
    assert.equal(error.code, 'plan-malformed');
    assert.deepEqual(error.problems.map((p) => p.kind), ['bad-budget', 'cycle']);
    assert.match(error.message, /2 task-graph problems: bad-budget B\.1 'attempts=0'; cycle A\.1 B\.1 via A\.1->B\.1, B\.1->A\.1:phase/);
    return true;
  });
});

test('loadPlan keeps the pre-080 message for a lone duplicate id', (t) => {
  const root = planDir(t, plan(['- [ ] A.1 one', '- [ ] A.1 two']));
  assert.throws(() => loadPlan({ roots: [root], slug: '900-g' }), (error) => {
    assert.equal(error.code, 'plan-malformed');
    assert.match(error.message, /^plan task id 'A\.1' appears more than once in /);
    assert.deepEqual(error.problems, [{ kind: 'duplicate-id', ids: ['A.1'] }]);
    return true;
  });
});

test('loadPlan returns the graph and warnings beside the legacy task list', (t) => {
  const root = planDir(t, plan(['- [ ] A.1 one', '- [ ] A.2 two; depends-on: A.1 (after review)']));
  const loaded = loadPlan({ roots: [root], slug: '900-g' });
  assert.deepEqual(loaded.tasks.map((x) => x.id), ['A.1', 'A.2']);
  assert.deepEqual(loaded.graph.order, ['A.1', 'A.2']);
  assert.deepEqual(loaded.warnings, [{ kind: 'near-miss-dependency', ids: ['A.2'], value: 'A.1 (after review)' }]);
});
