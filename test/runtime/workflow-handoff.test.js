'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator');
const root = path.resolve(__dirname, '../..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new WorkflowOrchestrator({ repoRoot: root, stateDir: path.join(dir, '.doflow/state/orchestration'), readinessEvaluate: () => 'READY' });
}
const args = { taskId: 'test', note: 'Observed result', outcome: 'passed' };

test('overlapping workflow updates cannot erase a recorded transition', t => {
  const orch = fixture(t);
  orch.start({ taskId: 'test', taskClass: 'feature' });
  const stale = orch.readRun('test');
  orch.completeStage({ taskId: 'test', stageId: 'discovery' });
  stale.history.push({ action: 'stale-write' });
  assert.throws(() => orch.writeRun(stale), /Concurrent workflow update/);
  assert.equal(orch.status('test').awaitingGate.gateId, 'gate-0');
  assert.equal(orch.readRun('test').history.some(e => e.action === 'stale-write'), false);
});

test('handoff is standalone without an existing run or explicit class', t => {
  const orch = fixture(t);
  assert.equal(orch.handoff({ ...args, callingSkill: 'do-test' }).disposition, 'standalone');
  assert.equal(orch.readRun('test'), null);
  assert.throws(() => orch.handoff({ ...args, callingSkill: 'missing', taskClass: 'feature' }), /owns no stage/);
  assert.equal(orch.readRun('test'), null, 'unknown owner cannot create a run');
});

test('handoff stops at prior gates and never grants approval', t => {
  const orch = fixture(t);
  const deferred = orch.handoff({ ...args, callingSkill: 'do-design', taskClass: 'feature' });
  assert.equal(deferred.disposition, 'deferred');
  assert.equal(deferred.reason, 'awaiting-gate:gate-0');
  assert.equal(orch.readRun('test').program[0].outcome, 'unverified');
  orch.decideGate({ taskId: 'test', gateId: 'gate-0', decision: 'approve' });
  const completed = orch.handoff({ ...args, callingSkill: 'do-design' });
  assert.equal(completed.recordedStage, 'design');
  assert.equal(completed.disposition, 'completed');
  assert.equal(orch.handoff({ ...args, callingSkill: 'do-design' }).disposition, 'annotated');
  assert.equal(orch.status('test').current.id, 'planning', 'rerun must not advance later stages');
  assert.throws(() => orch.handoff({ ...args, callingSkill: 'do-design', taskClass: 'bug' }), /does not match/);
});

test('repeated skill occurrences resolve in order and stop before an unfinished implementation', t => {
  const orch = fixture(t);
  let result = orch.handoff({ ...args, callingSkill: 'do-test', taskClass: 'bug' });
  assert.equal(result.recordedStage, 'reproduction');
  result = orch.handoff({ ...args, callingSkill: 'do-test' });
  assert.equal(result.reason, 'blocked-on-mutating-stage:implementation');
  orch.completeStage({ taskId: 'test', stageId: 'implementation' });
  result = orch.handoff({ ...args, callingSkill: 'do-test' });
  assert.equal(result.recordedStage, 'regression-verification');
  result = orch.handoff({ ...args, callingSkill: 'do-test' });
  assert.equal(result.recordedStage, 'regression-verification');
  assert.equal(result.disposition, 'annotated');
});

test('public CLI forwards skill identity and result without creating standalone state', t => {
  const orch = fixture(t);
  const cwd = path.resolve(orch.stateDir, '../../..');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/doflow.js'), 'orchestrate',
    '--action', 'handoff', '--task-id', 'standalone', '--calling-skill', 'do-test', '--note', 'verified', '--result', 'passed', '--json'],
  { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).disposition, 'standalone');
});
