'use strict';
// plan-parse.test.js — the plan header, the new task fields and the extended line hash
// (feature 080; IC-001, IC-002, DEC-001, DEC-008, FR-001, FR-015).
//
// In-process: the contract is the shape `parsePlan` returns and the string `taskLineHash` returns,
// so a library call is the whole of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePlan } = require('../../src/runtime/scaffold/artifacts.ts');
const { taskLineHash } = require('../../src/runtime/task-attempts.ts');

const plan = (lines, header = []) => ['# Plan', '', ...header, '', '## 8. Tasks', '', '### Phase A', '', ...lines, ''].join('\n');
const task = (line, header) => parsePlan(plan([line], header)).tasks[0];

// Legacy lines (no `acceptance:`, no `budget:`). The hashes were computed once by the 8ce5ad7 code:
// `git archive 8ce5ad7 src | tar -x -C "$G"`, then that tree's `parsePlan` + `taskLineHash` over
// exactly these lines. They are never recomputed by the code under test.
const LEGACY = [
  '- [ ] A.1 [P] [US1] Legacy parallel task — owner: core-implementer; files: src/a.ts, test/a.test.js',
  '- [x] A.2 [US2] [P] Legacy dependent task — owner: quality-guardian; files: src/b.ts; depends-on: A.1, A.1 (after review), services/payments',
  '- [ ] A.3 Legacy task with an external contract; depends-on: vendor-api; external-contract: docs/vendor.md',
];
const LEGACY_HASHES_8CE5AD7 = {
  'A.1': 'sha256:af7dd9cb18f0d7c3d79f5ba577b9416a9596dacffc87833ed140c95b622f98a9',
  'A.2': 'sha256:6da4629424f08a9d3bcec2da570c976c0ea46bc293da6487a8ae553486830fa7',
  'A.3': 'sha256:8059349ac144af53b04ffd63f0dd256a8fb66feb27a8ac37b18762e7d2e08c02',
};

test('graph header: v1 before the first ## section opts in', () => {
  assert.equal(parsePlan(plan(LEGACY, ['**Task graph:** v1'])).graphHeader, 'v1');
});

test('graph header: absent is null, and a header after the first ## section does not count', () => {
  assert.equal(parsePlan(plan(LEGACY)).graphHeader, null);
  const late = ['# Plan', '', '## 1. Approach', '', '**Task graph:** v1', '', '## 8. Tasks', '', LEGACY[0], ''].join('\n');
  assert.equal(parsePlan(late).graphHeader, null);
});

test('graph header: any other value is kept as { invalid }', () => {
  assert.deepEqual(parsePlan(plan(LEGACY, ['**Task graph:** v2'])).graphHeader, { invalid: 'v2' });
  assert.deepEqual(parsePlan(plan(LEGACY, ['**Task graph:**'])).graphHeader, { invalid: '' });
});

test('graph header: reported even when the plan has no Tasks section', () => {
  const parsed = parsePlan(['# Plan', '**Task graph:** v1', '', '## 1. Approach', ''].join('\n'));
  assert.equal(parsed.graphHeader, 'v1');
  assert.deepEqual(parsed.tasks, []);
});

test('[P] anywhere in the head sets parallel; it stays out of the description', () => {
  const tasks = parsePlan(plan([...LEGACY, '- [ ] A.4 [US3] Ends parallel [P] — owner: x'])).tasks;
  assert.deepEqual(tasks.map((t) => t.parallel), [true, true, false, true]);
  assert.equal(tasks[1].description, 'Legacy dependent task');
  assert.equal(tasks[3].description, 'Ends parallel');
});

test('depends-on: task ids, near-misses and service paths split; dependsOn is unchanged', () => {
  const t = parsePlan(plan(LEGACY)).tasks[1];
  assert.deepEqual(t.dependsOn, ['A.1', 'A.1 (after review)', 'services/payments']);
  assert.deepEqual(t.taskDeps, ['A.1']);
  assert.deepEqual(t.nearMissDeps, ['A.1 (after review)']);
  const mixed = task('- [ ] A.5 x; depends-on: B.2(review), AB.10 later, `C.3`, svc.v2, A.1x');
  assert.deepEqual(mixed.taskDeps, ['C.3']);
  assert.deepEqual(mixed.nearMissDeps, ['B.2(review)', 'AB.10 later']);
});

test('unchanged fields keep their 8ce5ad7 values', () => {
  const t = parsePlan(plan(LEGACY)).tasks[2];
  assert.equal(t.owner, null);
  assert.deepEqual(t.files, []);
  assert.deepEqual(t.dependsOn, ['vendor-api']);
  assert.deepEqual(t.taskDeps, []);
  assert.deepEqual(t.nearMissDeps, []);
  assert.equal(t.externalContract, 'docs/vendor.md');
  assert.deepEqual(t.acceptance, []);
  assert.equal(t.budget, null);
});

test('acceptance: tokens are kept raw, valid or not', () => {
  const t = task('- [ ] A.6 x — owner: y; acceptance: FR-001, `IC-002`, US3, S-happy-path, bogus, fr-1');
  assert.deepEqual(t.acceptance, ['FR-001', 'IC-002', 'US3', 'S-happy-path', 'bogus', 'fr-1']);
  assert.equal(t.owner, 'y');
});

test('budget: attempts=<n> in 1..999 parses; anything else is { invalid }', () => {
  assert.deepEqual(task('- [ ] A.7 x; budget: attempts=3').budget, { attempts: 3 });
  assert.deepEqual(task('- [ ] A.7 x; budget: attempts=999').budget, { attempts: 999 });
  assert.deepEqual(task('- [ ] A.7 x; budget: attempts=0').budget, { invalid: 'attempts=0' });
  assert.deepEqual(task('- [ ] A.7 x; budget: attempts=x').budget, { invalid: 'attempts=x' });
  assert.deepEqual(task('- [ ] A.7 x; budget: attempts=1000').budget, { invalid: 'attempts=1000' });
  assert.deepEqual(task('- [ ] A.7 x; budget: attempts=-1').budget, { invalid: 'attempts=-1' });
  assert.deepEqual(task('- [ ] A.7 x; budget: 3').budget, { invalid: '3' });
});

test('a line with neither new key hashes exactly as on 8ce5ad7', () => {
  for (const header of [[], ['**Task graph:** v1']]) {
    const tasks = parsePlan(plan(LEGACY, header)).tasks;
    assert.equal(tasks.length, 3);
    for (const t of tasks) assert.equal(taskLineHash(t), LEGACY_HASHES_8CE5AD7[t.id], `${t.id} with header ${JSON.stringify(header)}`);
  }
});

test('parallel is never hashed', () => {
  const base = task(LEGACY[2]);
  assert.equal(taskLineHash(base), taskLineHash({ ...base, parallel: !base.parallel }));
});

test('acceptance or budget extends the hash; each change of either changes it', () => {
  const legacy = task(LEGACY[2]);
  const withAcc = task(`${LEGACY[2]}; acceptance: FR-001`);
  const withBudget = task(`${LEGACY[2]}; budget: attempts=3`);
  const badBudget = task(`${LEGACY[2]}; budget: attempts=0`);
  const hashes = [legacy, withAcc, withBudget, badBudget, task(`${LEGACY[2]}; acceptance: FR-002`), task(`${LEGACY[2]}; budget: attempts=4`)].map(taskLineHash);
  assert.equal(new Set(hashes).size, hashes.length);
  // The extended lines keep every legacy field identical: only the two new keys moved the hash.
  for (const t of [withAcc, withBudget, badBudget]) {
    assert.equal(taskLineHash({ ...t, acceptance: [], budget: null }), LEGACY_HASHES_8CE5AD7['A.3']);
  }
});
