'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator');
const { WorkflowEngine } = require('../../src/runtime/workflow-engine');

const REPO = path.resolve(__dirname, '..', '..');
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-orch-')); }
const READY = () => 'READY';
const NEVER_READY = () => 'NEEDS_EVIDENCE';

function fresh({ readinessEvaluate = READY } = {}) {
  return new WorkflowOrchestrator({
    repoRoot: REPO,
    stateDir: path.join(scratch(), 'state', 'orchestration'),
    readinessEvaluate,
  });
}

test('feature compiles to a stage/gate program in registry order with correct anchors', () => {
  const orch = fresh();
  const snap = orch.start({ taskId: 't.compile', taskClass: 'feature' });
  assert.equal(snap.state, 'RUNNING');
  assert.equal(snap.current.id, 'discovery');
  const run = orch.readRun('t.compile');
  assert.deepEqual(run.program.map((n) => `${n.type}:${n.id}`), [
    'stage:discovery', 'gate:gate-0',
    'stage:design', 'stage:planning', 'gate:gate-a',
    'stage:implementation', 'stage:verification', 'stage:review', 'gate:gate-b',
  ]);
  const impl = run.program.find((n) => n.id === 'implementation');
  assert.equal(impl.mutatesSource, true);
  assert.equal(impl.readinessTemplate, 'feature');
});

test('full feature walk: gates pause, approvals resume, terminal stage completes the run', () => {
  const orch = fresh();
  const seen = [];
  orch.readinessEvaluate = (node) => { seen.push(node.id); return 'READY'; };
  orch.start({ taskId: 't.walk', taskClass: 'feature' });
  let s = orch.completeStage({ taskId: 't.walk', stageId: 'discovery' });
  assert.equal(s.state, 'AWAITING_GATE');
  assert.equal(s.awaitingGate.gateId, 'gate-0');
  s = orch.decideGate({ taskId: 't.walk', gateId: 'gate-0', decision: 'approve' });
  assert.equal(s.state, 'RUNNING');
  assert.equal(s.current.id, 'design');
  for (const id of ['design', 'planning']) s = orch.completeStage({ taskId: 't.walk', stageId: id });
  // gate-a pauses after planning
  assert.equal(s.state, 'AWAITING_GATE');
  orch.decideGate({ taskId: 't.walk', gateId: 'gate-a', decision: 'approve' });
  s = orch.completeStage({ taskId: 't.walk', stageId: 'implementation' });
  assert.deepEqual(seen, ['implementation'], 'readiness cascade fires only for gated mutation stages');
  for (const id of ['verification', 'review']) s = orch.completeStage({ taskId: 't.walk', stageId: id });
  s = orch.decideGate({ taskId: 't.walk', gateId: 'gate-b', decision: 'approve' });
  assert.equal(s.state, 'COMPLETED');
  assert.equal(s.progress.done, 9);
  assert.ok(s.terminalStage);
});

test('rejecting a gate terminates the run and freezes further transitions', () => {
  const orch = fresh();
  orch.start({ taskId: 't.reject', taskClass: 'feature' });
  orch.completeStage({ taskId: 't.reject', stageId: 'discovery' });
  const s = orch.decideGate({ taskId: 't.reject', gateId: 'gate-0', decision: 'reject', note: 'wrong problem' });
  assert.equal(s.state, 'REJECTED');
  assert.throws(() => orch.completeStage({ taskId: 't.reject', stageId: 'design' }), /REJECTED/);
  assert.throws(() => orch.decideGate({ taskId: 't.reject', gateId: 'gate-0', decision: 'approve' }), /REJECTED|not awaiting/);
});

test('out-of-order completion names the expected stage; unknown runs are refused', () => {
  const orch = fresh();
  orch.start({ taskId: 't.order', taskClass: 'feature' });
  assert.throws(() => orch.completeStage({ taskId: 't.order', stageId: 'planning' }), /Expected stage 'discovery'/);
  assert.throws(() => orch.completeStage({ taskId: 'does-not-exist', stageId: 'x' }), /No workflow run/);
  assert.throws(() => orch.status('missing-task'), /No workflow run/);
});

test('unready mutation stage is refused with its verdict and stays current', () => {
  const orch = fresh({ readinessEvaluate: NEVER_READY });
  orch.start({ taskId: 't.unready', taskClass: 'feature' });
  orch.completeStage({ taskId: 't.unready', stageId: 'discovery' });
  orch.decideGate({ taskId: 't.unready', gateId: 'gate-0', decision: 'approve' });
  orch.completeStage({ taskId: 't.unready', stageId: 'design' });
  orch.completeStage({ taskId: 't.unready', stageId: 'planning' });
  orch.decideGate({ taskId: 't.unready', gateId: 'gate-a', decision: 'approve' });
  assert.throws(() => orch.completeStage({ taskId: 't.unready', stageId: 'implementation' }), /NEEDS_EVIDENCE/);
  assert.equal(orch.status('t.unready').current.id, 'implementation');
});

test('optional stages skip (with anchored gates); required stages refuse', () => {
  const orch = fresh();
  orch.start({ taskId: 't.opt', taskClass: 'research' });
  assert.throws(() => orch.skipStage({ taskId: 't.opt', stageId: 'synthesis' }) === undefined && false, /cannot be skipped|Expected stage/);
  // research: scoping (optional) -> synthesis
  const s = orch.skipStage({ taskId: 't.opt', stageId: 'scoping', reason: 'topic already scoped' });
  assert.equal(s.current.id, 'synthesis');
  const done = orch.completeStage({ taskId: 't.opt', stageId: 'synthesis' });
  assert.equal(done.state, 'COMPLETED');
});

test('runs survive a process restart: a new instance resumes from persisted state', () => {
  const stateDir = path.join(scratch(), 'state', 'orchestration');
  const first = new WorkflowOrchestrator({ repoRoot: REPO, stateDir, readinessEvaluate: READY });
  first.start({ taskId: 't.resume', taskClass: 'feature' });
  first.completeStage({ taskId: 't.resume', stageId: 'discovery' });

  const second = new WorkflowOrchestrator({ repoRoot: REPO, stateDir, readinessEvaluate: READY });
  const s = second.status('t.resume');
  assert.equal(s.state, 'AWAITING_GATE');
  assert.equal(s.awaitingGate.gateId, 'gate-0');
  const after = second.decideGate({ taskId: 't.resume', gateId: 'gate-0', decision: 'approve' });
  assert.equal(after.current.id, 'design');

  assert.throws(() => second.start({ taskId: 't.resume', taskClass: 'bug' }), /already exists/);
});

test('unsafe identifiers are rejected before touching disk', () => {
  const orch = fresh();
  assert.throws(() => orch.start({ taskId: '../escape', taskClass: 'feature' }), /Invalid taskId/);
  assert.throws(() => orch.decideGate({ taskId: 'ok..id', gateId: 'gate-#', decision: 'approve' }), /Invalid gateId/);
});
