'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { planVerdict } = require('../../src/runtime/task-graph.ts');
const { loadPlan } = require('../../src/runtime/task-attempts.ts');
const { gatherGateFacts } = require('../../src/runtime/roadmap/facts.ts');

function plan(lines, { header = '**Task graph:** v1', tasksSection = true } = {}) {
  return [
    '# Plan', '',
    ...(header ? [header, ''] : []),
    ...(tasksSection ? ['## 8. Tasks', '', ...lines] : ['## Overview', 'No task list.']),
    '',
  ].join('\n');
}

const fixtures = [
  {
    name: 'bad acceptance range',
    text: plan(['- [ ] A.1 Build \u2014 acceptance: FR-001..FR-005']),
    problem: { kind: 'bad-acceptance', ids: ['A.1'], value: 'FR-001..FR-005' },
  },
  {
    name: 'bad acceptance requirement kind',
    text: plan(['- [ ] A.1 Build \u2014 acceptance: RK-001']),
    problem: { kind: 'bad-acceptance', ids: ['A.1'], value: 'RK-001' },
  },
  {
    name: 'bad acceptance decision id',
    text: plan(['- [ ] A.1 Build \u2014 acceptance: DEC-004']),
    problem: { kind: 'bad-acceptance', ids: ['A.1'], value: 'DEC-004' },
  },
  {
    name: 'bad dependency',
    text: plan(['- [ ] A.1 Build; depends-on: A.1 (after review)']),
    problem: { kind: 'bad-dependency', ids: ['A.1'], value: 'A.1 (after review)' },
  },
  {
    name: 'unknown dependency',
    text: plan(['- [ ] A.1 Build; depends-on: B.1']),
    problem: { kind: 'unknown-dependency', ids: ['A.1', 'B.1'] },
  },
  {
    name: 'duplicate id in completion criteria',
    text: plan([
      '- [ ] A.1 Build',
      '### Completion Criteria',
      '- [ ] A.1 Build completion criteria',
    ]),
    problem: { kind: 'duplicate-id', ids: ['A.1'] },
    tasks: 2,
  },
  {
    name: 'bad budget',
    text: plan(['- [ ] A.1 Build \u2014 budget: attempts=0']),
    problem: { kind: 'bad-budget', ids: ['A.1'], value: 'attempts=0' },
  },
  {
    name: 'bad header',
    text: plan(['- [ ] A.1 Build'], { header: '**Task graph:** v2' }),
    problem: { kind: 'bad-header', ids: [], value: 'v2' },
  },
  {
    name: 'cycle',
    text: plan([
      '- [ ] A.1 First; depends-on: A.2',
      '- [ ] A.2 Second; depends-on: A.1',
    ]),
    problem: { kind: 'cycle', ids: ['A.1', 'A.2'], via: ['A.1->A.2', 'A.2->A.1'] },
    tasks: 2,
  },
  {
    name: 'empty tasks section',
    text: plan([]),
    problem: { kind: 'no-tasks', ids: [] },
  },
  {
    name: 'missing tasks section',
    text: plan([], { tasksSection: false }),
    problem: { kind: 'no-tasks', ids: [] },
  },
];

const cleanPlan = plan([
  '- [ ] A.1 First',
  '- [ ] A.2 Second',
]);

function savePlan(t, text) {
  const root = tempDir(t, 'doflow-plan-verdict-');
  const slug = 'plan-verdict-fixture';
  const file = path.join(root, 'agent-docs', 'doflow', slug, 'plan.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { root, slug };
}

function roadmapPlanFact(t, text) {
  const { root, slug } = savePlan(t, text);
  const row = { id: 'test', slug, class: 'feature', writeSet: [], needs: [], requires: [] };
  const policy = { classes: { feature: { 'gate-a': { predicates: ['plan-parses'] } } } };
  const facts = gatherGateFacts({
    root,
    artifactRoot: path.join(root, 'agent-docs', 'doflow', slug),
    gateId: 'gate-a',
    policy,
    row,
  });
  return facts.find((fact) => fact.name === 'plan').value;
}

test('planVerdict returns the expected problem kind, ids, and detail for each fixture', () => {
  for (const fixture of fixtures) {
    const result = planVerdict(fixture.text);
    assert.equal(result.ok, false, fixture.name);
    assert.deepEqual(result.problems, [fixture.problem], fixture.name);
    assert.equal(result.tasks, fixture.tasks ?? (fixture.problem.kind === 'no-tasks' ? 0 : 1), fixture.name);
  }
});

test('planVerdict returns a clean task count and stable warning descriptions', () => {
  assert.deepEqual(planVerdict(cleanPlan), {
    ok: true,
    tasks: 2,
    problems: [],
    warnings: [],
  });

  const warningPlan = plan(['- [ ] A.1 Build; depends-on: A.1 (after review)'], { header: null });
  assert.deepEqual(planVerdict(warningPlan).warnings, [
    "near-miss-dependency A.1 'A.1 (after review)'",
  ]);
});

test('planVerdict is deterministic for the clean plan and every fixture', () => {
  for (const text of [cleanPlan, ...fixtures.map((fixture) => fixture.text)]) {
    assert.deepEqual(planVerdict(text), planVerdict(text));
  }
});

test('loadPlan refusal problems match planVerdict for every invalid fixture', (t) => {
  for (const fixture of fixtures) {
    const { root, slug } = savePlan(t, fixture.text);
    let refusal;
    assert.throws(() => loadPlan({ roots: [root], slug }), (error) => {
      refusal = error;
      return true;
    }, fixture.name);
    const verdict = planVerdict(fixture.text);
    assert.equal(refusal.code, 'plan-malformed', fixture.name);
    assert.deepEqual(refusal.problems, verdict.problems, fixture.name);
  }
});

test('roadmap plan facts agree with planVerdict for the same texts', (t) => {
  for (const text of [cleanPlan, ...fixtures.map((fixture) => fixture.text)]) {
    assert.equal(roadmapPlanFact(t, text).ok, planVerdict(text).ok);
  }
});
