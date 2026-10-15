'use strict';

// Feature 080 B.2 (IC-007, IC-010, DEC-003): the FAILED result, the cancelled-token refusal, caller-
// reported usage, and the optional `runs` map on a store that stays version 1. Ledgers are seeded by
// hand, because no action in this task writes a `cancelled` attempt or a run record.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { claim, finish, release, status, loadPlan, TaskAttemptError, RESULTS } = require('../../src/runtime/task-attempts.ts');

const SLUG = 'feat-r';
const PLAN = [
  '# Plan', '', '## Tasks', '',
  '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js',
  '- [ ] A.2 second task; owner: core-implementer; files: b.js', '',
].join('\n');
const STARTED = '2026-01-01T00:00:00.000Z';
const NOW = new Date('2026-01-02T00:00:00.000Z');

function project(t) {
  const dir = tempDir(t, 'doflow-task-results-');
  fs.mkdirSync(path.join(dir, 'agent-docs', 'doflow', SLUG), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md'), PLAN);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const roots = [dir];
  const hash = Object.fromEntries(loadPlan({ roots, slug: SLUG }).tasks.map((x) => [x.id, x.hash]));
  const env = { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_SESSION_ROLE: 'worker', DOFLOW_ROLE: 'worker', DOFLOW_WORKTREE: dir };
  const attempt = (token, state, extra = {}) => ({
    token, owner: 'core-implementer', mode: 'subagent', startedAt: STARTED, taskLineHash: hash['A.1'],
    state, result: null, evidenceId: null, reason: null, ...extra,
  });
  const seed = (store) => fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 1, planPath: null, ...store }, null, 2));
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const common = { file, fsImpl: fs, roots, slug: SLUG, env, cwd: dir, now: NOW };
  return { dir, file, attempt, seed, read, common };
}

const usageError = (fn) => assert.throws(fn, (e) => e instanceof TaskAttemptError && e.code === 'usage');

test('RESULTS gains FAILED; FAILED needs a reason and no evidence', (t) => {
  const p = project(t);
  assert.deepEqual(RESULTS, ['COMPLETED', 'BLOCKED', 'ABANDONED', 'INCONCLUSIVE', 'FAILED']);
  p.seed({ tasks: { 'A.1': { nextToken: 2, attempts: [p.attempt(1, 'active')] } } });
  const before = fs.readFileSync(p.file);
  usageError(() => finish({ ...p.common, task: 'A.1', token: 1, result: 'FAILED' }));
  usageError(() => finish({ ...p.common, task: 'A.1', token: 1, result: 'FAILED', reason: '   ' }));
  assert.deepEqual(fs.readFileSync(p.file), before, 'a usage error writes nothing');

  const answer = finish({ ...p.common, task: 'A.1', token: 1, result: 'FAILED', reason: ' build broke ' });
  assert.equal(answer.disposition, 'applied');
  assert.equal(answer.result, 'FAILED');
  const stored = p.read().tasks['A.1'].attempts[0];
  assert.equal(stored.state, 'finished');
  assert.equal(stored.result, 'FAILED');
  assert.equal(stored.reason, 'build broke');
  assert.equal(stored.evidenceId, null);
  assert.equal(stored.finishedAt, NOW.toISOString());
  assert.deepEqual(stored.finishedBy, { role: 'worker', lineage: 'w1', worktree: p.dir });
  assert.equal(stored.usage, null);
  assert.equal(p.read().version, 1);
});

test('a cancelled token is stale attempt-cancelled before any other check, nothing written', (t) => {
  const p = project(t);
  // Token 1 cancelled, token 2 active: the order of checks decides the reason.
  p.seed({ tasks: { 'A.1': { nextToken: 3, attempts: [p.attempt(1, 'cancelled', { cancel: { at: STARTED, by: 'main', reason: 'stop' } }), p.attempt(2, 'active')] } } });
  const before = fs.readFileSync(p.file);
  const done = finish({ ...p.common, task: 'A.1', token: 1, result: 'COMPLETED', evidenceId: 'ev_cancelled' });
  assert.deepEqual([done.disposition, done.reason], ['stale', 'attempt-cancelled']);
  const freed = release({ ...p.common, task: 'A.1', token: 1, reason: 'drop' });
  assert.deepEqual([freed.disposition, freed.reason], ['stale', 'attempt-cancelled']);
  assert.deepEqual(fs.readFileSync(p.file), before, 'a cancelled token changes nothing');
  assert.equal(p.read().tasks['A.1'].attempts[0].evidenceId, null, 'the evidence id is not stored');

  // Only a cancelled attempt: still attempt-cancelled, not no-active-attempt.
  p.seed({ tasks: { 'A.1': { nextToken: 2, attempts: [p.attempt(1, 'cancelled')] } } });
  const lone = finish({ ...p.common, task: 'A.1', token: 1, result: 'BLOCKED' });
  assert.deepEqual([lone.disposition, lone.reason], ['stale', 'attempt-cancelled']);
  // Today's checks follow unchanged.
  const mismatch = finish({ ...p.common, task: 'A.1', token: 9, result: 'BLOCKED' });
  assert.deepEqual([mismatch.disposition, mismatch.reason], ['stale', 'no-active-attempt']);
});

test('usage is recorded with its basis and reporter on finish and release', (t) => {
  const p = project(t);
  p.seed({ tasks: { 'A.1': { nextToken: 2, attempts: [p.attempt(1, 'active')] }, 'A.2': { nextToken: 2, attempts: [p.attempt(1, 'active', { taskLineHash: 'x' })] } } });
  finish({ ...p.common, task: 'A.1', token: 1, result: 'BLOCKED', tokens: 1200, basis: 'measured' });
  assert.deepEqual(p.read().tasks['A.1'].attempts[0].usage, { tokens: 1200, basis: 'measured', reporter: 'worker:w1' });

  const freed = release({ ...p.common, task: 'A.2', token: 1, reason: 'handing back', tokens: 0, basis: 'estimated' });
  assert.equal(freed.disposition, 'released');
  const released = p.read().tasks['A.2'].attempts[0];
  assert.equal(released.endedAt, NOW.toISOString());
  assert.deepEqual(released.usage, { tokens: 0, basis: 'estimated', reporter: 'worker:w1' });
});

test('release without usage records endedAt and a null usage', (t) => {
  const p = project(t);
  p.seed({ tasks: { 'A.1': { nextToken: 2, attempts: [p.attempt(1, 'active')] } } });
  release({ ...p.common, task: 'A.1', token: 1, reason: 'later' });
  const stored = p.read().tasks['A.1'].attempts[0];
  assert.equal(stored.endedAt, NOW.toISOString());
  assert.equal(stored.usage, null);
});

test('tokens and basis are given together or not at all, and are well-formed', (t) => {
  const p = project(t);
  p.seed({ tasks: { 'A.1': { nextToken: 2, attempts: [p.attempt(1, 'active')] } } });
  const before = fs.readFileSync(p.file);
  const base = { ...p.common, task: 'A.1', token: 1, result: 'BLOCKED' };
  usageError(() => finish({ ...base, tokens: 5 }));
  usageError(() => finish({ ...base, basis: 'measured' }));
  usageError(() => finish({ ...base, tokens: -1, basis: 'measured' }));
  usageError(() => finish({ ...base, tokens: 1.5, basis: 'measured' }));
  usageError(() => finish({ ...base, tokens: 5, basis: 'guessed' }));
  usageError(() => release({ ...p.common, task: 'A.1', token: 1, reason: 'x', tokens: 5 }));
  assert.deepEqual(fs.readFileSync(p.file), before);
});

test('a store with a well-formed runs map loads, keeps version 1 and keeps runs across a write', (t) => {
  const p = project(t);
  const runs = { 'h/r1/main': { runKey: 'h/r1/main', control: 'paused', epoch: 0, history: [] } };
  p.seed({ tasks: {}, runs });
  assert.equal(status(p.common).revision, 1);
  const claimed = claim({ ...p.common, task: 'A.1', owner: 'core-implementer', mode: 'subagent' });
  assert.equal(claimed.disposition, 'claimed');
  const after = p.read();
  assert.equal(after.version, 1);
  assert.deepEqual(after.runs['h/r1/main'], runs['h/r1/main']);
  assert.deepEqual(Object.keys(after.runs).sort(), ['h/r1/main', after.tasks['A.1'].attempts[0].runKey].sort());
});

test('a legacy store without runs and with pre-080 attempts loads as it is', (t) => {
  const p = project(t);
  p.seed({ tasks: { 'A.1': { nextToken: 2, attempts: [p.attempt(1, 'finished', { result: 'BLOCKED' })] } } });
  const answer = status(p.common);
  assert.equal(answer.tasks[0].derived, 'blocked');
  assert.equal('runs' in p.read(), false);
});

test('a malformed runs map is store-unreadable and the file bytes are unchanged', (t) => {
  const p = project(t);
  const run = (over) => ({ 'h/r1/main': { runKey: 'h/r1/main', control: 'running', epoch: 1, ...over } });
  const cases = [
    ['runs null', null],
    ['runs array', []],
    ['runs string', 'x'],
    ['run not an object', { k: 3 }],
    ['control outside the three values', run({ control: 'stopped' })],
    ['control missing', run({ control: undefined })],
    ['negative epoch', run({ epoch: -1 })],
    ['fractional epoch', run({ epoch: 1.5 })],
    ['string epoch', run({ epoch: '1' })],
  ];
  for (const [label, runs] of cases) {
    p.seed({ tasks: { 'A.1': { nextToken: 2, attempts: [p.attempt(1, 'active')] } }, runs });
    const before = fs.readFileSync(p.file);
    const calls = [
      () => claim({ ...p.common, task: 'A.2', owner: 'core-implementer', mode: 'subagent' }),
      () => finish({ ...p.common, task: 'A.1', token: 1, result: 'BLOCKED' }),
      () => release({ ...p.common, task: 'A.1', token: 1, reason: 'x' }),
      () => status(p.common),
    ];
    for (const call of calls) {
      assert.throws(call, (e) => e instanceof TaskAttemptError && e.code === 'store-unreadable', label);
    }
    assert.deepEqual(fs.readFileSync(p.file), before, `${label}: the file must be left unchanged`);
  }
});
