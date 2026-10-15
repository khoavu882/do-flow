'use strict';

// Feature 080 E.fix (IC-009): finish and release store run totals recomputed from the attempt list,
// so the stored copy equals `computeTotals` after every locked write.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { claim, finish, release, start } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, computeTotals } = require('../../src/runtime/task-run.ts');

const SLUG = 'feat-t';
const NOW = new Date('2026-01-02T00:00:00.000Z');
const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js',
  '- [ ] A.2 second task; owner: core-implementer; files: b.js', '',
].join('\n');

function project(t) {
  const dir = tempDir(t, 'doflow-task-totals-');
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
  const common = { file, fsImpl: fs, roots: [dir], slug: SLUG, now: NOW, env, cwd: dir };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { common, key, read };
}

function assertStoredTotals(p, label) {
  const store = p.read();
  assert.deepEqual(store.runs[p.key.runKey].totals, computeTotals(store, p.key.runKey), label);
}

test('finish and release store totals equal to computeTotals', (t) => {
  const p = project(t);
  start({ ...p.common, by: 'main' });
  const take = (task) => claim({ ...p.common, task, owner: 'core-implementer', mode: 'subagent', epoch: 1, reserveTokens: 100 });

  const one = take('A.1');
  assert.equal(one.disposition, 'claimed');
  assertStoredTotals(p, 'after claim');
  const done = finish({ ...p.common, task: 'A.1', token: one.token, result: 'BLOCKED', tokens: 40, basis: 'measured' });
  assert.equal(done.disposition, 'applied');
  assertStoredTotals(p, 'after finish');
  assert.equal(p.read().runs[p.key.runKey].totals.tokens.measured, 40);

  const two = take('A.2');
  assert.equal(two.disposition, 'claimed');
  const freed = release({ ...p.common, task: 'A.2', token: two.token, reason: 'handing back', tokens: 7, basis: 'estimated' });
  assert.equal(freed.disposition, 'released');
  assertStoredTotals(p, 'after release');
  assert.equal(p.read().runs[p.key.runKey].totals.tokens.reserved, 0);
});
