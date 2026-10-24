'use strict';

// Feature 080 E.fix (IC-009): finish and release store run totals recomputed from the attempt list,
// so the stored copy equals `computeTotals` after every locked write.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { claim, finish, release, start, reopen, inspect } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, computeTotals } = require('../../src/runtime/task-run.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');

const SLUG = 'feat-t';
const NOW: any = new Date('2026-01-02T00:00:00.000Z');
const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js',
  '- [ ] A.2 second task; owner: core-implementer; files: b.js', '',
].join('\n');

function project(t: any) {
  const dir = tempDir(t, 'doflow-task-totals-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const env: any = {
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: dir, HOME: dir,
  };
  const key = runKeyFor(env, dir);
  const common: any = { file, fsImpl: fs, roots: [dir], slug: SLUG, now: NOW, env, cwd: dir };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { common, key, read };
}

function assertStoredTotals(p: any, label: any) {
  const store = p.read();
  assert.deepEqual(store.runs[p.key.runKey].totals, computeTotals(store, p.key.runKey), label);
}

/** A passing test-result for `taskId` where finish looks, recorded after the claim (wall clock). */
function evidence(dir: any, taskId: any) {
  const ledger: any = new EvidenceLedger({ repoRoot: dir, slug: SLUG });
  const id = ledger.addEvidence({
    taskId, kind: 'test-result', provenance: 'extracted', source: { provider: 'shell', capability: 'test' },
    locator: { file: 'a.test.js' }, content: 'ran', observation: { command: 'node --test', exitCode: 0 },
  });
  ledger.save(taskId);
  return id;
}

/** Same project, another run id: a different run key over the same ledger. */
function asRun(p: any, run: any) {
  const env: any = { ...p.common.env, DOFLOW_RUN_ID: run };
  return { ...p, common: { ...p.common, env }, key: runKeyFor(env, p.common.cwd) };
}

test('DEC-017 superseded-unreported: reopening an unreported attempt keeps it unreported (aggregate-unaccounted)', (t) => {
  const p = project(t);
  const live: any = { ...p.common, now: new Date() };
  assert.equal(start({ ...live, by: 'main', budgetTokens: 1000 }).disposition, 'started');
  const one = claim({ ...live, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, reserveTokens: 100 });
  assert.equal(one.disposition, 'claimed');
  const done = finish({ ...live, now: new Date(), task: 'A.1', token: one.token, result: 'COMPLETED', evidenceId: evidence(p.common.cwd, 'A.1') });
  assert.equal(done.disposition, 'applied', JSON.stringify(done));
  assert.equal(reopen({ ...live, task: 'A.1', token: one.token, by: 'main', reason: 'redo' }).disposition, 'reopened');
  const refused = claim({ ...live, task: 'A.2', owner: 'core-implementer', mode: 'subagent', epoch: 1, reserveTokens: 100 });
  assert.deepEqual([refused.disposition, refused.reason, refused.unreported], ['refused', 'aggregate-unaccounted', 1]);
  assertStoredTotals(p, 'after reopen');
});

test('DEC-017 superseded-unreported (S-5): another run reopening r1\'s attempt leaves r1\'s totals matching', (t) => {
  const p = project(t);
  const live: any = { ...p.common, now: new Date() };
  start({ ...live, by: 'main' });
  const one = claim({ ...live, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1 });
  assert.equal(one.disposition, 'claimed');
  assert.equal(finish({ ...live, now: new Date(), task: 'A.1', token: one.token, result: 'COMPLETED', evidenceId: evidence(p.common.cwd, 'A.1') }).disposition, 'applied');
  const r2 = asRun(p, 'r2');
  assert.equal(reopen({ ...r2.common, now: new Date(), task: 'A.1', token: one.token, by: 'main', reason: 'redo' }).disposition, 'reopened');
  const view = inspect(p.common);
  assert.equal(view.run.totalsMismatch, false, JSON.stringify(view.run));
  assert.equal(view.run.totals.unreported, 1);
});

test('finish and release store totals equal to computeTotals', (t) => {
  const p = project(t);
  start({ ...p.common, by: 'main' });
  const take = (task: any) => claim({ ...p.common, task, owner: 'core-implementer', mode: 'subagent', epoch: 1, reserveTokens: 100 });

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
