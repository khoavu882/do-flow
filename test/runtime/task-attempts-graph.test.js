'use strict';

// Feature 080 B.3 (IC-005 `status` fields, IC-006 steps 3, 4, 5, 9, 10, 11 and the readiness half of
// 12, IC-024 `checkCompletion`; DEC-008, DEC-009): status, claim and completion read the derived
// task state. Ledgers are seeded by hand, because no action in this task writes a `runKey`, a
// `cancelled` attempt or a stale done attempt. The LEGACY golden values were produced by running the
// 8ce5ad7 `status` and `claim` (from `git archive 8ce5ad7 src bin` in a temp dir) over LEGACY_PLAN
// with the stores below; they are pinned here, never recomputed by the code under test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { claim, status, checkCompletion, loadPlan, TaskAttemptError } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, createRun } = require('../../src/runtime/task-run.ts');

const SLUG = 'feat-g';
const STARTED = '2026-01-01T00:00:00.000Z';
const NOW = new Date('2026-01-02T00:00:00.000Z');
const HEADER = '**Task graph:** v1';

const LEGACY_PLAN = [
  '# Plan', '', '## Tasks', '',
  '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js',
  '- [ ] A.2 second task; owner: core-implementer; files: b.js', '',
  '### Phase B', '',
  '- [ ] B.1 third task; owner: quality-guardian; files: c.js', '',
].join('\n');

/** Two phases; B.2 declares A.1 and is owned by quality-guardian; A.1 has a budget of 2. */
function graphPlan(header = [HEADER]) {
  return [
    '# Plan', '', ...header, '', '## Tasks', '',
    '### Phase A', '',
    '- [ ] A.1 first task; owner: core-implementer; files: a.js; budget: attempts=2',
    '- [ ] A.2 second task; owner: core-implementer; files: b.js', '',
    '### Phase B', '',
    '- [ ] B.1 third task; owner: core-implementer; files: c.js',
    '- [ ] B.2 fourth task; owner: quality-guardian; files: d.js; depends-on: A.1', '',
  ].join('\n');
}

/** An explicit identity, so the developer's shell never decides a run key (C.2, IC-025). */
function identityEnv(worktree) {
  return {
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: worktree, HOME: worktree,
  };
}

function project(t, plan) {
  const dir = tempDir(t, 'doflow-task-graph-claim-');
  // A graph-plan claim needs a started run at epoch 1 for the caller's key (DEC-007, IC-025).
  const graph = plan.includes(HEADER);
  let runSetup = {};
  let runs = null;
  if (graph) {
    fs.mkdirSync(path.join(dir, '.git'));
    const env = identityEnv(dir);
    const key = runKeyFor(env, dir);
    runSetup = { env, cwd: dir };
    runs = { [key.runKey]: createRun(key, null, NOW, { epoch: 1 }) };
  }
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, plan);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const roots = [dir];
  const hash = Object.fromEntries(loadPlan({ roots, slug: SLUG }).tasks.map((x) => [x.id, x.hash]));
  const attempt = (id, token, state, result = null, extra = {}) => ({
    token, owner: 'core-implementer', mode: 'subagent', startedAt: STARTED, taskLineHash: hash[id],
    state, result, evidenceId: null, reason: null, ...extra,
  });
  /** `spec` is `{ id: [attempt, ...] }`. */
  const seed = (spec) => {
    const tasks = Object.fromEntries(Object.entries(spec).map(([id, a]) => [id, { nextToken: a.length + 1, attempts: a }]));
    fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 1, planPath: null, tasks, ...(runs ? { runs } : {}) }, null, 2));
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const common = { file, fsImpl: fs, roots, slug: SLUG, now: NOW, ...runSetup };
  const take = (task, owner = 'core-implementer', extra = {}) =>
    claim({ ...common, task, owner, mode: 'subagent', ...(graph ? { epoch: 1 } : {}), ...extra });
  const byId = () => Object.fromEntries(status(common).tasks.map((r) => [r.id, r]));
  return { dir, file, attempt, seed, read, common, take, byId };
}

const unchanged = (p, run) => {
  const before = fs.readFileSync(p.file);
  const answer = run();
  assert.deepEqual(fs.readFileSync(p.file), before, 'a refusal writes nothing');
  return answer;
};

// ── legacy compatibility (FR-015) ───────────────────────────────────────────────────────────────

const LEGACY = {
  empty: {
    derived: [['A.1', 'ready', null, null], ['A.2', 'ready', null, null], ['B.1', 'pending', null, null]],
    claims: {
      'A.1': { disposition: 'claimed', taskId: 'A.1', token: 1, revision: 2 },
      'A.2': { disposition: 'claimed', taskId: 'A.2', token: 1, revision: 2 },
      'B.1': { disposition: 'refused', taskId: 'B.1', reason: 'unmet-phase', unmet: ['A.1', 'A.2'] },
      'C.1': { disposition: 'refused', taskId: 'C.1', reason: 'unknown-task' },
    },
  },
  a1doneA2blocked: {
    derived: [['A.1', 'done', null, 1], ['A.2', 'blocked', null, null], ['B.1', 'pending', null, null]],
    claims: {
      'A.1': { disposition: 'refused', taskId: 'A.1', reason: 'already-done' },
      'A.2': { disposition: 'claimed', taskId: 'A.2', token: 2, revision: 2 },
      'B.1': { disposition: 'refused', taskId: 'B.1', reason: 'unmet-phase', unmet: ['A.2'] },
      'C.1': { disposition: 'refused', taskId: 'C.1', reason: 'unknown-task' },
    },
  },
  a2released: {
    derived: [['A.1', 'done', null, 1], ['A.2', 'blocked', null, null], ['B.1', 'pending', null, null]],
    claims: {
      'A.1': { disposition: 'refused', taskId: 'A.1', reason: 'already-done' },
      'A.2': { disposition: 'claimed', taskId: 'A.2', token: 3, revision: 2 },
      'B.1': { disposition: 'refused', taskId: 'B.1', reason: 'unmet-phase', unmet: ['A.2'] },
      'C.1': { disposition: 'refused', taskId: 'C.1', reason: 'unknown-task' },
    },
  },
  a2abandoned: {
    derived: [['A.1', 'done', null, 1], ['A.2', 'ready', null, null], ['B.1', 'pending', null, null]],
    claims: {
      'A.1': { disposition: 'refused', taskId: 'A.1', reason: 'already-done' },
      'A.2': { disposition: 'claimed', taskId: 'A.2', token: 2, revision: 2 },
      'B.1': { disposition: 'refused', taskId: 'B.1', reason: 'unmet-phase', unmet: ['A.2'] },
      'C.1': { disposition: 'refused', taskId: 'C.1', reason: 'unknown-task' },
    },
  },
  b1active: {
    derived: [['A.1', 'done', null, 1], ['A.2', 'done', null, 1], ['B.1', 'running', 1, null]],
    claims: {
      'A.1': { disposition: 'refused', taskId: 'A.1', reason: 'already-done' },
      'A.2': { disposition: 'refused', taskId: 'A.2', reason: 'already-done' },
      'B.1': { disposition: 'refused', taskId: 'B.1', reason: 'active-attempt', activeToken: 1, owner: 'core-implementer', startedAt: STARTED },
      'C.1': { disposition: 'refused', taskId: 'C.1', reason: 'unknown-task' },
    },
  },
};

test('a legacy plan: derived and claim results equal 8ce5ad7, and status adds the IC-005 fields', (t) => {
  const p = project(t, LEGACY_PLAN);
  const a = p.attempt;
  const stores = {
    empty: {},
    a1doneA2blocked: { 'A.1': [a('A.1', 1, 'finished', 'COMPLETED')], 'A.2': [a('A.2', 1, 'finished', 'BLOCKED')] },
    a2released: { 'A.1': [a('A.1', 1, 'finished', 'COMPLETED')], 'A.2': [a('A.2', 1, 'finished', 'BLOCKED'), a('A.2', 2, 'released')] },
    a2abandoned: { 'A.1': [a('A.1', 1, 'finished', 'COMPLETED')], 'A.2': [a('A.2', 1, 'finished', 'ABANDONED')] },
    b1active: { 'A.1': [a('A.1', 1, 'finished', 'COMPLETED')], 'A.2': [a('A.2', 1, 'finished', 'COMPLETED')], 'B.1': [a('B.1', 1, 'active')] },
  };
  for (const [name, spec] of Object.entries(stores)) {
    p.seed(spec);
    const answer = status(p.common);
    assert.deepEqual(answer.tasks.map((r) => [r.id, r.derived, r.activeToken, r.doneToken]), LEGACY[name].derived, name);
    for (const r of answer.tasks) {
      for (const key of ['id', 'phase', 'derived', 'activeToken', 'doneToken', 'active', 'state', 'reason', 'claimable', 'budget']) {
        assert.ok(key in r, `${name}: ${r.id} has ${key}`);
      }
      assert.deepEqual(r.budget, { limit: 20, used: 0, source: 'default' }, `${name}: legacy attempts are not counted`);
    }
    for (const [id, expected] of Object.entries(LEGACY[name].claims)) {
      p.seed(spec);
      assert.deepEqual(p.take(id), expected, `${name}: claim ${id}`);
    }
  }
});

test('a header-less plan with owner: admits any owner and records no override (DEC-008)', (t) => {
  const p = project(t, graphPlan([]));
  p.seed({ 'A.1': [p.attempt('A.1', 1, 'finished', 'COMPLETED')] });
  const answer = p.take('B.2', 'core-implementer');
  assert.equal(answer.disposition, 'claimed', JSON.stringify(answer));
  assert.equal('ownerOverride' in p.read().tasks['B.2'].attempts[0], false);
  // An empty override is not checked where the owner is not enforced.
  p.seed({ 'A.1': [p.attempt('A.1', 1, 'finished', 'COMPLETED')] });
  assert.equal(p.take('B.2', 'core-implementer', { ownerOverride: '' }).disposition, 'claimed');
});

// ── readiness (IC-006 step 12) ──────────────────────────────────────────────────────────────────

test('a declared dependency makes B.2 ready before phase A finishes; B.1 still waits on the phase', (t) => {
  const p = project(t, graphPlan());
  p.seed({ 'A.1': [p.attempt('A.1', 1, 'finished', 'COMPLETED')] });
  const rows = p.byId();
  assert.deepEqual([rows['B.2'].state, rows['B.2'].reason, rows['B.2'].claimable], ['READY', 'ready', true]);
  assert.deepEqual([rows['B.1'].state, rows['B.1'].reason, rows['B.1'].unmet], ['PLANNED', 'unmet-phase', ['A.2']]);

  const early = unchanged(p, () => p.take('B.1'));
  assert.deepEqual(early, { disposition: 'refused', taskId: 'B.1', reason: 'unmet-phase', unmet: ['A.2'], held: [] });
  const ready = p.take('B.2', 'quality-guardian');
  assert.equal(ready.disposition, 'claimed', JSON.stringify(ready));
});

test('dependency-held names A.1 BLOCKED; unmet-dependency names a dependency not yet done', (t) => {
  const p = project(t, graphPlan());
  p.seed({ 'A.1': [p.attempt('A.1', 1, 'finished', 'BLOCKED')] });
  assert.deepEqual(p.byId()['B.2'].held, [{ id: 'A.1', state: 'BLOCKED' }]);
  const held = unchanged(p, () => p.take('B.2', 'quality-guardian'));
  assert.deepEqual(held, { disposition: 'refused', taskId: 'B.2', reason: 'dependency-held', held: [{ id: 'A.1', state: 'BLOCKED' }] });

  p.seed({});
  const unmet = unchanged(p, () => p.take('B.2', 'quality-guardian'));
  assert.deepEqual(unmet, { disposition: 'refused', taskId: 'B.2', reason: 'unmet-dependency', unmet: ['A.1'] });
});

test('a FAILED task whose dependencies are met is claimable; unmet ones refuse it', (t) => {
  const p = project(t, graphPlan());
  p.seed({ 'A.1': [p.attempt('A.1', 1, 'finished', 'COMPLETED')], 'B.2': [p.attempt('B.2', 1, 'finished', 'FAILED')] });
  assert.deepEqual([p.byId()['B.2'].state, p.byId()['B.2'].claimable], ['FAILED', true]);
  assert.equal(p.take('B.2', 'quality-guardian').disposition, 'claimed');

  p.seed({ 'B.2': [p.attempt('B.2', 1, 'finished', 'FAILED')] });
  assert.deepEqual([p.byId()['B.2'].state, p.byId()['B.2'].claimable], ['FAILED', false]);
  const refused = unchanged(p, () => p.take('B.2', 'quality-guardian'));
  assert.deepEqual([refused.reason, refused.unmet], ['unmet-dependency', ['A.1']]);
});

// ── owner (IC-006 step 9) ───────────────────────────────────────────────────────────────────────

test('a graph plan refuses a different owner, then admits it with a recorded override', (t) => {
  const p = project(t, graphPlan());
  p.seed({ 'A.1': [p.attempt('A.1', 1, 'finished', 'COMPLETED')] });
  const refused = unchanged(p, () => p.take('B.2', 'core-implementer'));
  assert.deepEqual(refused, { disposition: 'refused', taskId: 'B.2', reason: 'owner-mismatch', declared: 'quality-guardian' });
  assert.throws(() => p.take('B.2', 'core-implementer', { ownerOverride: '  ' }), (e) => e instanceof TaskAttemptError && e.code === 'usage');

  const admitted = p.take('B.2', 'core-implementer', { ownerOverride: ' reviewer away ' });
  assert.equal(admitted.disposition, 'claimed', JSON.stringify(admitted));
  assert.deepEqual(p.read().tasks['B.2'].attempts[0].ownerOverride, { declared: 'quality-guardian', reason: 'reviewer away' });

  // The declared owner needs no override, and none is recorded.
  p.seed({ 'A.1': [p.attempt('A.1', 1, 'finished', 'COMPLETED')] });
  assert.equal(p.take('B.2', 'quality-guardian', { ownerOverride: 'unused' }).disposition, 'claimed');
  assert.equal('ownerOverride' in p.read().tasks['B.2'].attempts[0], false);
});

// ── task budget and cancel (IC-006 steps 10 and 11) ─────────────────────────────────────────────

test('budget 2 of 2 is refused budget-exhausted and reported BLOCKED budget', (t) => {
  const p = project(t, graphPlan());
  const run = { runKey: 'k/r1/main' };
  p.seed({ 'A.1': [p.attempt('A.1', 1, 'released', null, run), p.attempt('A.1', 2, 'finished', 'ABANDONED', run)] });
  const row = p.byId()['A.1'];
  assert.deepEqual([row.state, row.derived, row.reason, row.claimable], ['BLOCKED', 'blocked', 'budget', false]);
  assert.deepEqual(row.budget, { limit: 2, used: 2, source: 'plan' });
  const refused = unchanged(p, () => p.take('A.1'));
  assert.deepEqual(refused, { disposition: 'refused', taskId: 'A.1', reason: 'budget-exhausted', scope: 'task', limit: 2, used: 2 });

  p.seed({ 'A.1': [p.attempt('A.1', 1, 'released', null, run)] });
  assert.deepEqual(p.byId()['A.1'].budget, { limit: 2, used: 1, source: 'plan' });
  assert.equal(p.take('A.1').disposition, 'claimed');
});

test('an uncleared cancel refuses the claim with the cancelled token and clear: resume', (t) => {
  const p = project(t, graphPlan());
  p.seed({ 'A.2': [p.attempt('A.2', 1, 'finished', 'ABANDONED'), p.attempt('A.2', 2, 'cancelled', null, { cancel: { at: STARTED, by: 'main', reason: 'stop' } })] });
  assert.equal(p.byId()['A.2'].state, 'CANCELLED');
  const refused = unchanged(p, () => p.take('A.2'));
  assert.deepEqual(refused, { disposition: 'refused', taskId: 'A.2', reason: 'cancelled', cancelledToken: 2, clear: 'resume' });
});

// ── done-stale (IC-024, DEC-009) ────────────────────────────────────────────────────────────────

test('a done task whose line changed is incomplete in a graph plan only', (t) => {
  for (const [label, header] of [['graph', [HEADER]], ['legacy', []]]) {
    const p = project(t, graphPlan(header));
    const done = (id) => [p.attempt(id, 1, 'finished', 'COMPLETED')];
    p.seed({ 'A.1': done('A.1'), 'A.2': done('A.2'), 'B.1': done('B.1'), 'B.2': [p.attempt('B.2', 1, 'finished', 'COMPLETED', { taskLineHash: 'sha256:old' })] });
    const answer = checkCompletion({ slug: SLUG, cwd: p.dir });
    if (label === 'legacy') {
      assert.deepEqual(answer, { state: 'complete', slug: SLUG, incomplete: [] }, 'a legacy plan keeps today\'s rule');
      continue;
    }
    assert.deepEqual(answer, { state: 'incomplete', slug: SLUG, incomplete: ['B.2'], reasons: { 'B.2': 'plan-changed-after-done' } });
    const row = p.byId()['B.2'];
    assert.deepEqual([row.state, row.derived, row.reason, row.doneToken, row.doneStale], ['READY', 'ready', 'plan-changed-after-done', null, { token: 1 }]);
    assert.equal(p.take('B.2', 'quality-guardian').disposition, 'claimed', 'a stale done task may be claimed again');
  }
});
