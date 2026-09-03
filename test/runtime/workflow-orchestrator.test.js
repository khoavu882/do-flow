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

test('decideGate forced=true without a note is refused', () => {
  const orch = fresh();
  orch.start({ taskId: 't.forced-no-note', taskClass: 'feature' });
  orch.completeStage({ taskId: 't.forced-no-note', stageId: 'discovery' });
  assert.throws(
    () => orch.decideGate({ taskId: 't.forced-no-note', gateId: 'gate-0', decision: 'approve', forced: true }),
    /A forced gate decision requires a --note reason/,
  );
});

test('decideGate forced=true with a note succeeds and the history entry carries forced:true', () => {
  const orch = fresh();
  orch.start({ taskId: 't.forced-yes-note', taskClass: 'feature' });
  orch.completeStage({ taskId: 't.forced-yes-note', stageId: 'discovery' });
  const s = orch.decideGate({
    taskId: 't.forced-yes-note', gateId: 'gate-0', decision: 'approve',
    forced: true, note: 'approved despite unresolved clarification markers',
  });
  assert.equal(s.state, 'RUNNING');
  const run = orch.readRun('t.forced-yes-note');
  const entry = run.history.find((h) => h.action === 'decide-gate' && h.node === 'gate-0');
  assert.equal(entry.forced, true);
  assert.equal(entry.note, 'approved despite unresolved clarification markers');
});

test('a routine (non-forced) decideGate call records forced:false explicitly', () => {
  const orch = fresh();
  orch.start({ taskId: 't.routine-gate', taskClass: 'feature' });
  orch.completeStage({ taskId: 't.routine-gate', stageId: 'discovery' });
  orch.decideGate({ taskId: 't.routine-gate', gateId: 'gate-0', decision: 'approve' });
  const run = orch.readRun('t.routine-gate');
  const entry = run.history.find((h) => h.action === 'decide-gate' && h.node === 'gate-0');
  assert.equal(entry.forced, false);
});

test('annotate on a valid node appends history without touching state/cursor/node statuses', () => {
  const orch = fresh();
  orch.start({ taskId: 't.annotate', taskClass: 'feature' });
  orch.completeStage({ taskId: 't.annotate', stageId: 'discovery' });
  orch.decideGate({ taskId: 't.annotate', gateId: 'gate-0', decision: 'approve' });

  const before = orch.readRun('t.annotate');
  const beforeState = before.state;
  const beforeCursor = before.cursor;
  const beforeStatuses = before.program.map((n) => n.status);

  const snap = orch.annotate({ taskId: 't.annotate', node: 'design', note: 're-reviewed after handoff' });
  assert.equal(snap.taskId, 't.annotate');

  const after = orch.readRun('t.annotate');
  assert.equal(after.state, beforeState);
  assert.equal(after.cursor, beforeCursor);
  assert.deepEqual(after.program.map((n) => n.status), beforeStatuses);

  const entry = after.history.find((h) => h.action === 'annotate');
  assert.ok(entry);
  assert.equal(entry.node, 'design');
  assert.equal(entry.note, 're-reviewed after handoff');
  assert.equal(entry.forced, false);
});

test('annotate on an unknown node id throws', () => {
  const orch = fresh();
  orch.start({ taskId: 't.annotate-bad-node', taskClass: 'feature' });
  assert.throws(
    () => orch.annotate({ taskId: 't.annotate-bad-node', node: 'not-a-real-node', note: 'x' }),
    /Invalid node: 'not-a-real-node' is not part of the program for run 't\.annotate-bad-node'/,
  );
});

test('annotate forced=true without a note is refused', () => {
  const orch = fresh();
  orch.start({ taskId: 't.annotate-forced-no-note', taskClass: 'feature' });
  assert.throws(
    () => orch.annotate({ taskId: 't.annotate-forced-no-note', node: 'discovery', forced: true }),
    /A forced annotation requires a --note reason/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────────── catch-up

test('catch-up starts a fresh run and stops on the first candidate stage', () => {
  const orch = fresh();
  const s = orch.catchUp({ taskId: 't.cu-fresh', taskClass: 'bug', candidateStageIds: ['reproduction'] });
  assert.equal(s.caughtUpTo, 'reproduction');
  assert.equal(s.reason, 'reached-candidate');
  assert.equal(orch.readRun('t.cu-fresh').cursor, 0);
});

test('catch-up backfills a non-candidate stage on the way to the candidate, marked backfilled:true — distinct from a real handoff', () => {
  const orch = fresh();
  const s = orch.catchUp({ taskId: 't.cu-backfill', taskClass: 'bug', candidateStageIds: ['root-cause'] });
  assert.equal(s.caughtUpTo, 'root-cause');
  const run = orch.readRun('t.cu-backfill');
  const entry = run.history.find((h) => h.action === 'complete-stage' && h.node === 'reproduction');
  assert.ok(entry, 'reproduction must have been backfilled to reach root-cause');
  assert.equal(entry.backfilled, true);
  assert.equal(entry.note, 'catch-up: backfilled');

  // A stage the owning skill actually completes carries no such marker.
  orch.completeStage({ taskId: 't.cu-backfill', stageId: 'root-cause', note: 'real work' });
  const real = orch.readRun('t.cu-backfill').history.find((h) => h.action === 'complete-stage' && h.node === 'root-cause');
  assert.equal(real.backfilled, false);
});

test('catch-up never auto-approves a clarification gate; it stops and reports awaiting-gate like any other gate', () => {
  const orch = fresh();
  orch.start({ taskId: 't.cu-gate0', taskClass: 'feature' });
  orch.completeStage({ taskId: 't.cu-gate0', stageId: 'discovery' });
  // gate-0 (clarification-kind) is left open, mirroring the "markers survived an aborted session"
  // case do-brainstorm's own SKILL.md documents — a human, not catch-up, must decide it.
  const s = orch.catchUp({ taskId: 't.cu-gate0', taskClass: 'feature', candidateStageIds: ['design'] });
  assert.equal(s.caughtUpTo, null);
  assert.equal(s.reason, 'awaiting-gate:gate-0');
  const run = orch.readRun('t.cu-gate0');
  assert.equal(run.state, 'AWAITING_GATE', 'the gate must still be open, not silently approved');
  assert.equal(run.program.find((n) => n.id === 'gate-0').status, 'pending');
});

test('catch-up with two candidate occurrences (do-test\'s own shape in bug/refactor) walks to the second when only the first is done', () => {
  const orch = fresh();
  orch.start({ taskId: 't.cu-two', taskClass: 'bug' });
  orch.completeStage({ taskId: 't.cu-two', stageId: 'reproduction' });
  orch.completeStage({ taskId: 't.cu-two', stageId: 'root-cause' });
  orch.completeStage({ taskId: 't.cu-two', stageId: 'implementation' });
  // Now at regression-verification. do-test re-invokes naming BOTH of its occurrences, exactly as
  // its own SKILL.md instructs — this must resolve the still-pending one, not misfire on the
  // already-completed 'reproduction'.
  const s = orch.catchUp({
    taskId: 't.cu-two', taskClass: 'bug',
    candidateStageIds: ['reproduction', 'regression-verification'],
  });
  assert.equal(s.caughtUpTo, 'regression-verification', 'must not short-circuit on the first, already-done occurrence');
  assert.equal(s.reason, 'reached-candidate');
});

test('catch-up returns already-completed when every named candidate is already done, and touches nothing further', () => {
  const orch = fresh();
  orch.start({ taskId: 't.cu-done', taskClass: 'bug' });
  orch.completeStage({ taskId: 't.cu-done', stageId: 'reproduction' });
  orch.completeStage({ taskId: 't.cu-done', stageId: 'root-cause' });
  orch.completeStage({ taskId: 't.cu-done', stageId: 'implementation' });
  orch.completeStage({ taskId: 't.cu-done', stageId: 'regression-verification' });
  const before = orch.readRun('t.cu-done');
  const beforeCursor = before.cursor;
  const beforeHistoryLength = before.history.length;

  const s = orch.catchUp({
    taskId: 't.cu-done', taskClass: 'bug',
    candidateStageIds: ['reproduction', 'regression-verification'],
  });
  assert.equal(s.caughtUpTo, null);
  assert.equal(s.reason, 'already-completed:reproduction,regression-verification');

  const after = orch.readRun('t.cu-done');
  assert.equal(after.cursor, beforeCursor, 'catch-up must not advance the cursor on an already-completed check');
  assert.equal(after.history.length, beforeHistoryLength, 'catch-up must not write anything for an already-completed check');
});

test('catch-up on an existing run refuses a taskClass that contradicts how the run was started', () => {
  const orch = fresh();
  orch.start({ taskId: 't.cu-mismatch', taskClass: 'bug' });
  assert.throws(
    () => orch.catchUp({ taskId: 't.cu-mismatch', taskClass: 'feature', candidateStageIds: ['root-cause'] }),
    /started as task class 'bug', not 'feature'/,
  );
});

test('catch-up skips (not completes) an optional non-candidate stage it walks past', () => {
  const orch = fresh();
  // review workflow: verification(optional) -> review. Candidate is 'review' only.
  const s = orch.catchUp({ taskId: 't.cu-optional', taskClass: 'review', candidateStageIds: ['review'] });
  assert.equal(s.caughtUpTo, 'review');
  const run = orch.readRun('t.cu-optional');
  const verification = run.program.find((n) => n.id === 'verification');
  assert.equal(verification.status, 'skipped');
  const entry = run.history.find((h) => h.node === 'verification');
  assert.equal(entry.action, 'skip-stage');
  // A backfilled skip must carry the same marker a backfilled completion does — otherwise a stage
  // nobody ran renders in audit.md with an empty Flags column, indistinguishable from a deliberate
  // operator skip (exactly the condition H1's own fix was filed to close, reopened on this path).
  assert.equal(entry.backfilled, true);

  // A skip the operator actually asked for carries no such marker.
  orch.start({ taskId: 't.skip-real', taskClass: 'review' });
  orch.skipStage({ taskId: 't.skip-real', stageId: 'verification', reason: 'nothing to verify' });
  const real = orch.readRun('t.skip-real').history.find((h) => h.node === 'verification');
  assert.equal(real.backfilled, false);
});

test('catch-up reports run-rejected on a rejected run rather than throwing', () => {
  const orch = fresh();
  orch.start({ taskId: 't.cu-rejected', taskClass: 'feature' });
  orch.completeStage({ taskId: 't.cu-rejected', stageId: 'discovery' });
  orch.decideGate({ taskId: 't.cu-rejected', gateId: 'gate-0', decision: 'reject', note: 'wrong problem' });
  // 'design' is a real, valid stage id — never reached, still 'pending' — so the already-completed
  // pre-check does not fire and the walk correctly reports the run's own terminal state instead.
  const rejected = orch.catchUp({ taskId: 't.cu-rejected', taskClass: 'feature', candidateStageIds: ['design'] });
  assert.equal(rejected.reason, 'run-rejected');
  assert.equal(rejected.caughtUpTo, null);
});

test('catch-up refuses a candidate stage id that names no stage in the run\'s own program, on any run state', () => {
  const orch = fresh();
  orch.start({ taskId: 't.cu-unknown', taskClass: 'feature' });
  assert.throws(
    () => orch.catchUp({ taskId: 't.cu-unknown', taskClass: 'feature', candidateStageIds: ['not-in-this-program'] }),
    /candidate stage id\(s\) not in run 't\.cu-unknown''s program: not-in-this-program/,
  );

  // The same refusal holds even on a COMPLETED run, where every real stage id would otherwise be
  // caught by the already-completed pre-check — an unknown id must never fall through past both
  // checks into the walk loop and silently start completing stages as backfilled (the exact defect
  // this validation exists to close).
  orch.start({ taskId: 't.cu-unknown-done', taskClass: 'trivial-edit' });
  orch.completeStage({ taskId: 't.cu-unknown-done', stageId: 'implementation' });
  orch.skipStage({ taskId: 't.cu-unknown-done', stageId: 'verification', reason: 'nothing to verify' });
  assert.throws(
    () => orch.catchUp({ taskId: 't.cu-unknown-done', taskClass: 'trivial-edit', candidateStageIds: ['not-in-this-program'] }),
    /candidate stage id\(s\) not in run 't\.cu-unknown-done''s program/,
  );
});

test('catch-up refuses an unknown candidate before walking forward, leaving no stage backfilled', () => {
  const orch = fresh();
  orch.start({ taskId: 't.cu-unknown-safe', taskClass: 'bug' });
  assert.throws(() => orch.catchUp({
    taskId: 't.cu-unknown-safe', taskClass: 'bug', candidateStageIds: ['typo-of-root-cause'],
  }));
  const run = orch.readRun('t.cu-unknown-safe');
  assert.equal(run.cursor, 0, 'the cursor must not have moved');
  assert.equal(run.program.find((n) => n.id === 'reproduction').status, 'pending');
  assert.equal(run.history.length, 1, 'only the initial start entry — nothing backfilled');
});

test('catch-up blocks on a mutating stage carrying a readiness template that only its own skill may complete', () => {
  const orch = fresh({ readinessEvaluate: NEVER_READY });
  const s = orch.catchUp({ taskId: 't.cu-blocked', taskClass: 'bug', candidateStageIds: ['regression-verification'] });
  assert.equal(s.caughtUpTo, null);
  assert.equal(s.reason, 'blocked-on-mutating-stage:implementation');
});

