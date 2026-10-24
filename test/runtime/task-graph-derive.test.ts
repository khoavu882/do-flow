'use strict';
// task-graph-derive.test.js — `deriveTasks`: IC-005 rows 1 to 10, IC-008 `used`, IC-024 done-stale
// (feature 080, B.1; DEC-002, DEC-009, FR-003, FR-004, FR-007, FR-009, FR-015, FR-016).
//
// In-process: `deriveTasks` is pure over a graph and a store object, so a library call is the
// whole contract. The legacy golden values (LEGACY_*) were produced by running the 8ce5ad7
// `status` (from `git archive 8ce5ad7 src bin` in a temp dir) over the committed 078 fixture plan
// with the stores below; they are pinned here, never recomputed by the code under test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { parsePlan } = require('../../src/runtime/scaffold/artifacts.ts');
const { buildGraph, deriveTasks, DEFAULT_TASK_ATTEMPTS } = require('../../src/runtime/task-graph.ts');
const { loadPlan, taskLineHash } = require('../../src/runtime/task-attempts.ts');

const REPO = path.resolve(__dirname, '../..');
const PLAN_078 = path.join(REPO, 'test', 'fixtures', 'plans', '078-scoped-context-arbitration', 'plan.md');
const GRAPH: any = ['**Task graph:** v1'];

const planText = (lines: any, header: any = []) => ['# Plan', '', ...header, '', '## 8. Tasks', '', ...lines, ''].join('\n');

/** The graph plus the current line hash of each task, as a caller holding loadPlan output has. */
function setup(lines: any, header?: any) {
  const parsed = parsePlan(planText(lines, header));
  const built = buildGraph(parsed);
  assert.equal(built.ok, true, JSON.stringify(built.problems));
  const hashes = Object.fromEntries(parsed.tasks.map((t: any) => [t.id, taskLineHash(t)]));
  return { graph: built.graph, hashes };
}

let at = 0;
function attempt(token: any, state: any, result: any = null, extra: any = {}) {
  at += 1;
  return {
    token, owner: 'w', mode: 'manual', startedAt: `2026-01-01T00:00:${String(at % 60).padStart(2, '0')}.000Z`,
    taskLineHash: null, state, result, evidenceId: null, reason: null, ...extra,
  };
}

/** A store from `{ id: [attempt, ...] }`, each done attempt stamped with the task's current hash. */
function store(spec: any, hashes: any = {}) {
  const tasks: any = {};
  for (const [id, attempts] of Object.entries(spec)) {
    for (const a of attempts) if (a.taskLineHash === null) a.taskLineHash = hashes[id] || null;
    tasks[id] = { nextToken: attempts.length + 1, attempts };
  }
  return { version: 1, revision: 1, planPath: null, tasks };
}

const byId = (records: any) => Object.fromEntries(records.map((r: any) => [r.id, r]));
const pick = (r: any) => {
  const out: any = { state: r.state, derived: r.derived, reason: r.reason, claimable: r.claimable };
  for (const k of ['held', 'unmet', 'doneStale']) if (k in r) out[k] = r[k];
  return out;
};

// ── rows 1 to 10 ───────────────────────────────────────────────────────────────────────────────

test('row 1: a done attempt that is not stale is SUCCEEDED, done', () => {
  const { graph, hashes } = setup(['- [ ] A.1 one'], GRAPH);
  const [r]: any = deriveTasks(graph, store({ 'A.1': [attempt(1, 'finished', 'COMPLETED')] }, hashes), { hashes });
  assert.deepEqual(pick(r), { state: 'SUCCEEDED', derived: 'done', reason: 'completed', claimable: false });
  assert.equal(r.doneToken, 1);
  assert.equal(r.activeToken, null);
  assert.equal(r.active, null);
});

test('row 2: an active attempt is RUNNING, with the active owner and token', () => {
  const { graph, hashes } = setup(['- [ ] A.1 one']);
  const [r] = deriveTasks(graph, store({ 'A.1': [attempt(1, 'active')] }, hashes));
  assert.deepEqual(pick(r), { state: 'RUNNING', derived: 'running', reason: 'active-attempt', claimable: false });
  assert.equal(r.activeToken, 1);
  assert.deepEqual(r.active, { owner: 'w', mode: 'manual', startedAt: r.active.startedAt });
});

test('row 3: counted attempts reaching the task budget are BLOCKED budget', () => {
  const { graph } = setup(['- [ ] A.1 one — budget: attempts=2']);
  const [r]: any = deriveTasks(graph, store({
    'A.1': [attempt(1, 'finished', 'ABANDONED', { runKey: 'k' }), attempt(2, 'superseded')],
  }));
  assert.deepEqual(pick(r), { state: 'BLOCKED', derived: 'blocked', reason: 'budget', claimable: false });
  assert.deepEqual(r.budget, { limit: 2, used: 2, source: 'plan' });
});

test('row 4: a latest cancelled attempt not cleared is CANCELLED; a cleared one falls through', () => {
  const { graph } = setup(['- [ ] A.1 one']);
  const s: any = store({ 'A.1': [attempt(1, 'finished', 'BLOCKED', { runKey: 'k' }), attempt(2, 'cancelled', null, { runKey: 'k', cancel: { at: 'x', by: 'o', reason: 'r' } })] });
  const [r] = deriveTasks(graph, s);
  assert.deepEqual(pick(r), { state: 'CANCELLED', derived: 'cancelled', reason: 'cancelled', claimable: false });
  const [cleared] = deriveTasks(graph, s, { clearedCancels: [{ taskId: 'A.1', token: 2 }] });
  assert.deepEqual(pick(cleared), { state: 'READY', derived: 'ready', reason: 'ready', claimable: true });
  const [other] = deriveTasks(graph, s, { clearedCancels: [{ taskId: 'A.1', token: 1 }] });
  assert.equal(other.state, 'CANCELLED', 'clearing another token does not clear the latest cancel');
});

test('row 5: a latest FAILED finish is FAILED, claimable only when rows 7 to 9 do not match', () => {
  const { graph } = setup(['- [ ] A.1 one', '- [ ] B.1 two']);
  const failed: any = () => [attempt(1, 'finished', 'FAILED', { runKey: 'k', reason: 'broke' })];
  const ready = byId(deriveTasks(graph, store({ 'A.1': failed() })));
  assert.deepEqual(pick(ready['A.1']), { state: 'FAILED', derived: 'failed', reason: 'failed', claimable: true });
  assert.deepEqual(ready['A.1'].readiness, { reason: 'ready' });
  const unmet = byId(deriveTasks(graph, store({ 'B.1': failed() })));
  assert.deepEqual(pick(unmet['B.1']), { state: 'FAILED', derived: 'failed', reason: 'failed', claimable: false });
  assert.deepEqual(unmet['B.1'].readiness, { reason: 'unmet-phase', unmet: ['A.1'], held: [] });
});

test('row 6: a latest BLOCKED finish is BLOCKED result-blocked, claimable when ready', () => {
  const { graph } = setup(['- [ ] A.1 one', '- [ ] B.1 two']);
  const recs: any = byId(deriveTasks(graph, store({ 'A.1': [attempt(1, 'finished', 'BLOCKED')], 'B.1': [attempt(1, 'finished', 'BLOCKED')] })));
  assert.deepEqual(pick(recs['A.1']), { state: 'BLOCKED', derived: 'blocked', reason: 'result-blocked', claimable: true });
  assert.deepEqual(pick(recs['B.1']), { state: 'BLOCKED', derived: 'blocked', reason: 'result-blocked', claimable: false });
});

test('row 7: a held direct dependency is PLANNED dependency-held; row 8 names the dependency, not its cause', () => {
  const { graph } = setup([
    '- [ ] A.1 one',
    '- [ ] A.2 two — depends-on: A.1',
    '- [ ] A.3 three — depends-on: A.2',
  ]);
  const recs: any = byId(deriveTasks(graph, store({ 'A.1': [attempt(1, 'finished', 'FAILED', { runKey: 'k' })] })));
  assert.deepEqual(pick(recs['A.2']), {
    state: 'PLANNED', derived: 'pending', reason: 'dependency-held', claimable: false, held: [{ id: 'A.1', state: 'FAILED' }],
  });
  assert.deepEqual(pick(recs['A.3']), {
    state: 'PLANNED', derived: 'pending', reason: 'unmet-dependency', claimable: false, unmet: ['A.2'],
  });
});

test('row 8: a dependency that is not SUCCEEDED is PLANNED unmet-dependency, phase order ignored', () => {
  const { graph } = setup(['- [ ] A.1 one', '- [ ] A.2 two', '- [ ] B.1 three — depends-on: A.1']);
  const recs = byId(deriveTasks(graph, store({})));
  assert.deepEqual(pick(recs['B.1']), { state: 'PLANNED', derived: 'pending', reason: 'unmet-dependency', claimable: false, unmet: ['A.1'] });
  const after: any = byId(deriveTasks(graph, store({ 'A.1': [attempt(1, 'finished', 'COMPLETED')] })));
  assert.equal(after['B.1'].state, 'READY', 'B.1 is ready before A.2 finishes (FR-003)');
});

test('row 9: an earlier-phase task not SUCCEEDED is PLANNED unmet-phase, with held earlier tasks', () => {
  const { graph } = setup(['- [ ] A.1 one', '- [ ] A.2 two', '- [ ] A.3 three', '- [ ] B.1 four']);
  const recs: any = byId(deriveTasks(graph, store({ 'A.1': [attempt(1, 'finished', 'BLOCKED')], 'A.3': [attempt(1, 'finished', 'COMPLETED')] })));
  assert.deepEqual(pick(recs['B.1']), {
    state: 'PLANNED', derived: 'pending', reason: 'unmet-phase', claimable: false,
    unmet: ['A.1', 'A.2'], held: [{ id: 'A.1', state: 'BLOCKED' }],
  });
});

test('row 10: otherwise READY: ready, reopened after a superseded attempt, plan-changed-after-done when stale', () => {
  const { graph, hashes } = setup(['- [ ] A.1 one', '- [ ] A.2 two', '- [ ] A.3 three'], GRAPH);
  const recs: any = byId(deriveTasks(graph, store({
    'A.2': [attempt(1, 'superseded', null, { reopen: { at: 'x', by: 'o', reason: 'r', runKey: 'k' } })],
    'A.3': [attempt(1, 'finished', 'COMPLETED', { taskLineHash: 'sha256:old' })],
  }, hashes), { hashes }));
  assert.deepEqual(pick(recs['A.1']), { state: 'READY', derived: 'ready', reason: 'ready', claimable: true });
  assert.deepEqual(pick(recs['A.2']), { state: 'READY', derived: 'ready', reason: 'reopened', claimable: true });
  assert.deepEqual(pick(recs['A.3']), { state: 'READY', derived: 'ready', reason: 'plan-changed-after-done', claimable: true, doneStale: { token: 1 } });
  assert.equal(recs['A.3'].doneToken, null);
});

test('a superseded attempt is never done', () => {
  const { graph } = setup(['- [ ] A.1 one']);
  const [r]: any = deriveTasks(graph, store({ 'A.1': [attempt(1, 'superseded', 'COMPLETED')] }));
  assert.equal(r.state, 'READY');
  assert.equal(r.reason, 'reopened');
});

test('ABANDONED and INCONCLUSIVE latest attempts fall through to rows 7 to 10', () => {
  const { graph } = setup(['- [ ] A.1 one', '- [ ] A.2 two', '- [ ] B.1 three']);
  const recs: any = byId(deriveTasks(graph, store({
    'A.1': [attempt(1, 'finished', 'ABANDONED')],
    'A.2': [attempt(1, 'finished', 'INCONCLUSIVE')],
    'B.1': [attempt(1, 'finished', 'ABANDONED')],
  })));
  assert.equal(recs['A.1'].reason, 'ready');
  assert.equal(recs['A.2'].reason, 'ready');
  assert.equal(recs['B.1'].reason, 'unmet-phase');
});

test('a released latest attempt is skipped: BLOCKED then released stays blocked', () => {
  const { graph } = setup(['- [ ] A.1 one']);
  const [r]: any = deriveTasks(graph, store({ 'A.1': [attempt(1, 'finished', 'BLOCKED'), attempt(2, 'released', null, { reason: 'x' })] }));
  assert.equal(r.derived, 'blocked');
  assert.equal(r.reason, 'result-blocked');
});

// ── IC-008 used ────────────────────────────────────────────────────────────────────────────────

test('IC-008: used counts runKey attempts in any state plus superseded ones, never legacy ones', () => {
  const { graph } = setup(['- [ ] A.1 one']);
  const [r]: any = deriveTasks(graph, store({
    'A.1': [
      attempt(1, 'finished', 'ABANDONED'), // legacy: no runKey
      attempt(2, 'released', null, { runKey: 'k1' }),
      attempt(3, 'cancelled', null, { runKey: 'k2' }),
      attempt(4, 'superseded'), // no runKey, still counted
      attempt(5, 'superseded', null, { runKey: 'k1' }), // counted once
      attempt(6, 'active', null, { runKey: 'k1' }),
    ],
  }));
  assert.deepEqual(r.budget, { limit: DEFAULT_TASK_ATTEMPTS, used: 5, source: 'default' });
  assert.equal(r.state, 'RUNNING', 'row 2 precedes row 3');
});

// ── done-stale (IC-024, DEC-009) ───────────────────────────────────────────────────────────────

test('a reworded done task is plan-changed-after-done in a graph plan and still done in a legacy plan', () => {
  const before: any = ['- [ ] A.1 original wording', '- [ ] A.2 two — depends-on: A.1', '- [ ] B.1 three'];
  const after: any = ['- [ ] A.1 reworded', '- [ ] A.2 two — depends-on: A.1', '- [ ] B.1 three'];
  for (const header of [GRAPH, []]) {
    const old = setup(before, header);
    const s: any = store({ 'A.1': [attempt(1, 'finished', 'COMPLETED')] }, old.hashes);
    const now = setup(after, header);
    const recs = byId(deriveTasks(now.graph, s, { hashes: now.hashes }));
    if (header.length) {
      assert.deepEqual(pick(recs['A.1']), { state: 'READY', derived: 'ready', reason: 'plan-changed-after-done', claimable: true, doneStale: { token: 1 } });
      assert.equal(recs['A.2'].reason, 'unmet-dependency', 'dependents lose readiness');
      assert.deepEqual(recs['B.1'].unmet, ['A.1', 'A.2']);
    } else {
      assert.equal(recs['A.1'].derived, 'done', 'legacy plan: no stale rule');
      assert.equal(recs['A.2'].derived, 'ready');
      assert.deepEqual(recs['B.1'].unmet, ['A.2']);
    }
  }
});

test('DEC-016 done-attempt-selection: a redo after a stale done is SUCCEEDED by the highest-token COMPLETED attempt', () => {
  const old = setup(['- [ ] A.1 original wording'], GRAPH);
  const now = setup(['- [ ] A.1 reworded'], GRAPH);
  const stale: any = attempt(1, 'finished', 'COMPLETED', { taskLineHash: old.hashes['A.1'] });
  const current: any = attempt(2, 'finished', 'COMPLETED', { taskLineHash: now.hashes['A.1'] });
  const [r] = deriveTasks(now.graph, store({ 'A.1': [stale, current] }), { hashes: now.hashes });
  assert.deepEqual(pick(r), { state: 'SUCCEEDED', derived: 'done', reason: 'completed', claimable: false });
  assert.equal(r.doneToken, 2);
});

test('the current hash comes from loadPlan tasks; a graph-plan done task with no hash is a caller error', (t) => {
  const root = tempDir(t, 'doflow-derive-');
  const slug = '080-x';
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', slug), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', slug, 'plan.md'), planText(['- [ ] A.1 one', '- [ ] A.2 two'], GRAPH));
  const plan = loadPlan({ roots: [root], slug });
  const hashes: any = new Map(plan.tasks.map((x: any) => [x.id, x.hash]));
  const s: any = store({ 'A.1': [attempt(1, 'finished', 'COMPLETED')] }, Object.fromEntries(hashes));
  assert.equal(deriveTasks(plan.graph, s, { hashes })[0].derived, 'done');
  assert.throws(() => deriveTasks(plan.graph, s), /no current line hash for task 'A\.1'/);
});

// ── order, purity, legacy golden ───────────────────────────────────────────────────────────────

test('records come back in plan order, evaluated dependencies first', () => {
  const { graph } = setup(['- [ ] A.1 one — depends-on: A.2', '- [ ] A.2 two']);
  const recs: any = deriveTasks(graph, store({ 'A.2': [attempt(1, 'finished', 'BLOCKED')] }));
  assert.deepEqual(recs.map((r: any) => r.id), ['A.1', 'A.2']);
  assert.deepEqual(recs[0].held, [{ id: 'A.2', state: 'BLOCKED' }]);
});

test('deriveTasks does not change the store or the graph', () => {
  const { graph, hashes } = setup(['- [ ] A.1 one', '- [ ] B.1 two — depends-on: A.1'], GRAPH);
  const s: any = store({ 'A.1': [attempt(1, 'cancelled', null, { runKey: 'k' })], 'B.1': [attempt(1, 'finished', 'COMPLETED')] }, hashes);
  const before = JSON.stringify({ graph, s });
  deriveTasks(graph, s, { hashes, clearedCancels: [{ taskId: 'A.1', token: 1 }] });
  assert.equal(JSON.stringify({ graph, s }), before);
});

/** 8ce5ad7 `status` over the 078 fixture plan with these stores (see the header). */
const LEGACY_1: any = { 'H.1': 'done', 'H.2': 'blocked', 'A.1': 'done', 'A.2': 'running', 'A.3': 'pending', 'B.1': 'pending', 'B.2': 'pending', 'B.3': 'pending', 'C.1': 'blocked', 'C.2': 'pending', 'C.3': 'pending', 'D.1': 'pending', 'D.2': 'pending', 'D.3': 'pending', 'D.4': 'pending', 'E.1': 'pending', 'E.2': 'pending', 'E.3': 'pending', 'F.1': 'pending', 'F.2': 'pending', 'G.1': 'pending', 'G.2': 'pending', 'G.3': 'pending', 'V.1': 'pending', 'V.2': 'pending' };
const LEGACY_2: any = { 'H.1': 'done', 'H.2': 'done', 'A.1': 'blocked', 'A.2': 'ready', 'A.3': 'ready', 'B.1': 'running', 'B.2': 'pending', 'B.3': 'pending', 'C.1': 'pending', 'C.2': 'pending', 'C.3': 'pending', 'D.1': 'pending', 'D.2': 'pending', 'D.3': 'pending', 'D.4': 'pending', 'E.1': 'pending', 'E.2': 'pending', 'E.3': 'pending', 'F.1': 'pending', 'F.2': 'pending', 'G.1': 'pending', 'G.2': 'pending', 'G.3': 'pending', 'V.1': 'pending', 'V.2': 'pending' };

test('a legacy store from 8ce5ad7 gives today\'s derived for every task', () => {
  const parsed = parsePlan(fs.readFileSync(PLAN_078, 'utf8'));
  const built = buildGraph(parsed);
  assert.equal(built.ok, true);
  const hashes = Object.fromEntries(parsed.tasks.map((t: any) => [t.id, taskLineHash(t)]));
  const s1: any = store({
    'H.1': [attempt(1, 'finished', 'COMPLETED')],
    'H.2': [attempt(1, 'finished', 'BLOCKED'), attempt(2, 'released', null, { reason: 'x' })],
    'A.1': [attempt(1, 'finished', 'COMPLETED')],
    'A.2': [attempt(1, 'active')],
    'A.3': [attempt(1, 'finished', 'ABANDONED')],
    'B.1': [attempt(1, 'finished', 'INCONCLUSIVE')],
    'B.2': [attempt(1, 'released')],
    'C.1': [attempt(1, 'finished', 'BLOCKED')],
  }, hashes);
  const s2: any = store({
    'H.1': [attempt(1, 'finished', 'COMPLETED')],
    'H.2': [attempt(1, 'released'), attempt(2, 'finished', 'COMPLETED')],
    'A.1': [attempt(1, 'finished', 'BLOCKED'), attempt(2, 'released', null, { reason: 'x' })],
    'A.2': [attempt(1, 'finished', 'ABANDONED')],
    'A.3': [attempt(1, 'finished', 'INCONCLUSIVE')],
    'B.1': [attempt(1, 'active')],
  }, hashes);
  for (const [s, expected] of [[s1, LEGACY_1], [s2, LEGACY_2]]) {
    const recs = deriveTasks(built.graph, s);
    assert.deepEqual(Object.fromEntries(recs.map((r: any) => [r.id, r.derived])), expected);
    for (const r of recs) assert.deepEqual(r.budget, { limit: DEFAULT_TASK_ATTEMPTS, used: 0, source: 'default' });
  }
});
