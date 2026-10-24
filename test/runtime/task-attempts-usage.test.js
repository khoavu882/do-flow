'use strict';

// Feature 080 review fix S-3 (DEC-018 unreported-usage-recovery, IC-007, IC-009, DEC-011): one
// finish without --tokens under a token limit makes every later claim `aggregate-unaccounted`;
// `report-usage` writes the missing usage onto the ended attempt and the run recovers. Fenced by
// the token alone, never overwriting, and refusing active and cancelled attempts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { claim, finish, start, cancel, reportUsage } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, computeTotals } = require('../../src/runtime/task-run.ts');

const SLUG = 'feat-u';
const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js',
  '- [ ] A.2 second task; owner: core-implementer; files: b.js',
  '- [ ] A.3 third task; owner: core-implementer; files: c.js', '',
].join('\n');

function project(t) {
  const dir = tempDir(t, 'doflow-task-usage-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const env = {
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: dir, HOME: dir,
  };
  const key = runKeyFor(env, dir);
  const common = { file, fsImpl: fs, roots: [dir], slug: SLUG, now: new Date('2026-01-02T00:00:00.000Z'), env, cwd: dir };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const bytes = () => fs.readFileSync(file);
  const take = (task) => claim({ ...common, task, owner: 'core-implementer', mode: 'subagent', epoch: 1, reserveTokens: 100 });
  return { common, key, read, bytes, take };
}

/** A run under a 1000-token limit whose A.1 finished BLOCKED without --tokens. */
function unreportedRun(t) {
  const p = project(t);
  assert.equal(start({ ...p.common, by: 'main', budgetTokens: 1000 }).disposition, 'started');
  const one = p.take('A.1');
  assert.equal(one.disposition, 'claimed');
  assert.equal(finish({ ...p.common, task: 'A.1', token: one.token, result: 'BLOCKED' }).disposition, 'applied');
  return { ...p, one };
}

test('DEC-018 unreported-usage-recovery: report-usage clears aggregate-unaccounted and the next claim succeeds', (t) => {
  const p = unreportedRun(t);
  const refused = p.take('A.2');
  assert.deepEqual([refused.disposition, refused.reason, refused.unreported], ['refused', 'aggregate-unaccounted', 1]);

  const recorded = reportUsage({ ...p.common, task: 'A.1', token: p.one.token, tokens: 40, basis: 'measured' });
  assert.deepEqual(Object.keys(recorded).sort(), ['disposition', 'revision', 'taskId', 'token']);
  assert.deepEqual([recorded.disposition, recorded.taskId, recorded.token], ['usage-recorded', 'A.1', p.one.token]);
  const store = p.read();
  const attempt = store.tasks['A.1'].attempts[0];
  assert.deepEqual(attempt.usage, { tokens: 40, basis: 'measured', reporter: 'main:main' });
  assert.deepEqual(store.runs[p.key.runKey].totals, computeTotals(store, p.key.runKey), 'stored totals refreshed');
  assert.equal(store.runs[p.key.runKey].totals.unreported, 0);
  assert.equal(store.runs[p.key.runKey].totals.tokens.measured, 40);

  assert.equal(p.take('A.2').disposition, 'claimed');
});

test('DEC-018: report-usage never overwrites (usage-present) and writes nothing on a refusal', (t) => {
  const p = unreportedRun(t);
  assert.equal(reportUsage({ ...p.common, task: 'A.1', token: p.one.token, tokens: 40, basis: 'measured' }).disposition, 'usage-recorded');
  const before = p.bytes();
  const again = reportUsage({ ...p.common, task: 'A.1', token: p.one.token, tokens: 5, basis: 'estimated' });
  assert.deepEqual([again.disposition, again.reason], ['refused', 'usage-present']);
  assert.deepEqual(p.bytes(), before);
});

test('DEC-018: an active attempt is refused active-attempt; finish it instead', (t) => {
  const p = unreportedRun(t);
  reportUsage({ ...p.common, task: 'A.1', token: p.one.token, tokens: 1, basis: 'estimated' });
  const two = p.take('A.2');
  assert.equal(two.disposition, 'claimed');
  const before = p.bytes();
  const r = reportUsage({ ...p.common, task: 'A.2', token: two.token, tokens: 3, basis: 'measured' });
  assert.deepEqual([r.disposition, r.reason], ['refused', 'active-attempt']);
  assert.deepEqual(p.bytes(), before);
});

test('DEC-018: a cancelled attempt is stale attempt-cancelled; no attempt is stale no-attempt; an unknown task is refused', (t) => {
  const p = unreportedRun(t);
  reportUsage({ ...p.common, task: 'A.1', token: p.one.token, tokens: 1, basis: 'estimated' });
  const two = p.take('A.2');
  assert.equal(cancel({ ...p.common, task: 'A.2', token: two.token, by: 'main', reason: 'stop' }).disposition, 'cancelled');
  const before = p.bytes();
  const cancelled = reportUsage({ ...p.common, task: 'A.2', token: two.token, tokens: 3, basis: 'measured' });
  assert.deepEqual([cancelled.disposition, cancelled.reason], ['stale', 'attempt-cancelled']);
  const none = reportUsage({ ...p.common, task: 'A.3', token: 1, tokens: 3, basis: 'measured' });
  assert.deepEqual([none.disposition, none.reason], ['stale', 'no-attempt']);
  const wrongToken = reportUsage({ ...p.common, task: 'A.1', token: 9, tokens: 3, basis: 'measured' });
  assert.deepEqual([wrongToken.disposition, wrongToken.reason], ['stale', 'no-attempt']);
  const unknown = reportUsage({ ...p.common, task: 'Z.9', token: 1, tokens: 3, basis: 'measured' });
  assert.deepEqual([unknown.disposition, unknown.reason], ['refused', 'unknown-task']);
  assert.deepEqual(p.bytes(), before);
});

test('DEC-018: --tokens and --tokens-basis are both required', (t) => {
  const p = unreportedRun(t);
  for (const usage of [{}, { tokens: 3 }, { basis: 'measured' }, { tokens: -1, basis: 'measured' }, { tokens: 3, basis: 'guessed' }]) {
    assert.throws(() => reportUsage({ ...p.common, task: 'A.1', token: p.one.token, ...usage }), (e) => e.code === 'usage', JSON.stringify(usage));
  }
});
