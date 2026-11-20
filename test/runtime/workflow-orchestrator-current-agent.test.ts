'use strict';

// 118 IC-001: the orchestrate snapshot's `current` names the agent that leads the stage it points at,
// on every action that prints it (start, status, handoff). Two mechanisms carry it: compileProgram
// binds `agent` into the stage node, snapshotRun prints it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');

const REPO = path.resolve(__dirname, '..', '..');
function orchestrator(t: any) {
  const root = tempDir(t, 'doflow-current-agent-');
  return new WorkflowOrchestrator({
    repoRoot: REPO, projectRoot: root,
    stateDir: path.join(root, '.doflow', 'state', 'orchestration'),
    readinessEvaluate: () => 'READY',
  });
}

test('start: current carries the bound agent of the first stage', (t) => {
  const orch = orchestrator(t);
  assert.equal(orch.start({ taskId: 't.start-bug', taskClass: 'bug' }).current.agent, 'quality-guardian');
  assert.equal(orch.start({ taskId: 't.start-feature', taskClass: 'feature' }).current.agent, 'spec-analyst');
});

test('status: current carries the agent of the stage the cursor reached', (t) => {
  const orch = orchestrator(t);
  orch.start({ taskId: 't.status', taskClass: 'bug' });
  orch.completeStage({ taskId: 't.status', stageId: 'reproduction' });
  orch.completeStage({ taskId: 't.status', stageId: 'root-cause' });
  const snap = orch.status('t.status');
  assert.equal(snap.current.id, 'implementation');
  assert.equal(snap.current.agent, 'core-implementer');
});

test('handoff: the snapshot current carries the agent of the next stage', (t) => {
  const orch = orchestrator(t);
  const snap = orch.handoff({ taskId: 't.handoff', taskClass: 'bug', callingSkill: 'do-diagnose', note: 'root cause found' });
  assert.equal(snap.disposition, 'completed');
  assert.equal(snap.current.id, 'implementation');
  assert.equal(snap.current.agent, 'core-implementer');
});

test('a gate node as current has no agent (null, not absent)', (t) => {
  const orch = orchestrator(t);
  orch.start({ taskId: 't.gate', taskClass: 'feature' });
  const snap = orch.completeStage({ taskId: 't.gate', stageId: 'discovery' });
  assert.equal(snap.current.type, 'gate');
  assert.equal(snap.current.agent, null);
});
