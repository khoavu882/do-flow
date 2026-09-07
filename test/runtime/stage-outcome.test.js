'use strict';
// stage-outcome.test.js — review A1: `catch-up` marked required non-mutating stages completed with
// only a history flag distinguishing them, so a jump to review backfilled regression verification
// without executing it and the completed state read as successful verification. Execution status
// and outcome are now separate facts on the stage node: completed vs imported says HOW the program
// moved past the stage, and passed / failed / unverified says what the run established. A
// backfilled stage is always imported+unverified regardless of the caller.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkflowOrchestrator, STAGE_OUTCOMES } = require('../../src/runtime/workflow-orchestrator');

const REPO = path.resolve(__dirname, "../..");

function fresh(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-outcome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orch = new WorkflowOrchestrator({ repoRoot: REPO, stateDir: path.join(dir, 'orchestration') });
  orch.readinessEvaluate = () => 'READY';
  return orch;
}

function readRun(orch, taskId) {
  return JSON.parse(fs.readFileSync(path.join(orch.stateDir, `${taskId}.json`), 'utf8'));
}

test('A1: a normally completed stage records completed + the stated outcome', (t) => {
  const orch = fresh(t);
  orch.start({ taskId: 't1', taskClass: 'trivial-edit' });
  const first = orch.snapshot(orch.requireRun('t1')).current.id;
  orch.completeStage({ taskId: 't1', stageId: first, outcome: 'passed' });

  const run = readRun(orch, 't1');
  const node = run.program.find((n) => n.id === first);
  assert.equal(node.status, 'completed');
  assert.equal(node.executionStatus, 'completed');
  assert.equal(node.outcome, 'passed');
  const entry = run.history.find((h) => h.action === 'complete-stage' && h.node === first);
  assert.equal(entry.outcome, 'passed');
  assert.equal(entry.executionStatus, 'completed');
});

test('A1: an unstated outcome records unverified, never an implied pass', (t) => {
  const orch = fresh(t);
  orch.start({ taskId: 't2', taskClass: 'trivial-edit' });
  const first = orch.snapshot(orch.requireRun('t2')).current.id;
  orch.completeStage({ taskId: 't2', stageId: first });
  assert.equal(readRun(orch, 't2').program.find((n) => n.id === first).outcome, 'unverified');
});

test('A1: a failed outcome is recordable and still advances — honesty over refusal', (t) => {
  const orch = fresh(t);
  orch.start({ taskId: 't3', taskClass: 'trivial-edit' });
  const runBefore = orch.requireRun('t3');
  const first = orch.snapshot(runBefore).current.id;
  const snap = orch.completeStage({ taskId: 't3', stageId: first, outcome: 'failed' });
  const node = readRun(orch, 't3').program.find((n) => n.id === first);
  assert.equal(node.status, 'completed');
  assert.equal(node.outcome, 'failed');
  assert.notEqual(snap.current && snap.current.id, first, 'the cursor moved on');
});

test('A1: catch-up backfilled stages are imported + unverified, whatever anyone says', (t) => {
  const orch = fresh(t);
  // bug: reproduction (do-test) precedes implementation; catching up to implementation backfills it.
  orch.catchUp({ taskId: 't4', taskClass: 'bug', candidateStageIds: ['implementation'] });
  const run = readRun(orch, 't4');
  const backfilled = run.program.filter((n) => n.executionStatus === 'imported');
  assert.ok(backfilled.length > 0, 'the walk to the candidate imported at least one stage');
  for (const node of backfilled) {
    assert.equal(node.outcome, 'unverified',
      `imported stage '${node.id}' must not imply a verification nobody executed`);
  }
  const candidate = run.program.find((n) => n.id === 'implementation');
  assert.notEqual(candidate.executionStatus, 'imported', 'the candidate itself is never backfilled');
});

test('A1: an unknown outcome is refused with the valid set', (t) => {
  const orch = fresh(t);
  orch.start({ taskId: 't5', taskClass: 'trivial-edit' });
  const first = orch.snapshot(orch.requireRun('t5')).current.id;
  assert.throws(
    () => orch.completeStage({ taskId: 't5', stageId: first, outcome: 'mostly-passed' }),
    /Unknown stage outcome 'mostly-passed'.*passed, failed, unverified/s,
  );
  assert.deepEqual([...STAGE_OUTCOMES].sort(), ['failed', 'passed', 'unverified']);
});
