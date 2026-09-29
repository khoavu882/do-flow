'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger');
const { ClaimsManager } = require('../../src/runtime/claims');
const { ContextPackCompiler } = require('../../src/runtime/context-pack');
const repo = path.resolve(__dirname, '../..');
const cli = path.join(repo, 'bin/doflow.js');
const ready = () => ({ state: 'READY', missing: [] });
function cmd(root, verb, ...args) {
  const r = spawnSync(process.execPath, [cli, verb, ...args, '--json'], { cwd: root, encoding: 'utf8' });
  return { code: r.status, data: r.status === 0 ? JSON.parse(r.stdout) : null, message: r.stderr + r.stdout };
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-feature-research-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const orch = new WorkflowOrchestrator({ repoRoot: repo, projectRoot: root,
    stateDir: path.join(root, '.doflow/state/orchestration'), readinessEvaluate: ready });
  orch.start({ taskId: 'demo', taskClass: 'feature' });
  return { root, orch };
}
function open(root, reason, question, blocking = false) {
  const args = ['--action', 'open', '--task-id', 'demo', '--stage-id', 'discovery', '--question', question, '--reason', reason];
  if (blocking) args.push('--blocking', 'true');
  const result = cmd(root, 'research-request', ...args);
  assert.equal(result.code, 0, result.message);
  return result.data;
}

test('no gap starts no retrieval and keeps six stages and three approval gates', t => {
  const { root, orch } = setup(t);
  assert.equal(cmd(root, 'research-request', '--action', 'list', '--task-id', 'demo').data.requests.length, 0);
  assert.equal(orch.readRun('demo').program.filter(n => n.type === 'stage').length, 6);
  assert.equal(orch.readRun('demo').program.filter(n => n.type === 'gate').length, 3);
  orch.completeStage({ taskId: 'demo', stageId: 'discovery' });
  assert.equal(orch.status('demo').current.id, 'gate-0');
});

test('same-task sourced answer unblocks stage after restart; missing source blocks', t => {
  const { root, orch } = setup(t);
  const request = open(root, 'detected-gap', 'What is the documented API?');
  assert.equal(request.blocking, true);
  assert.throws(() => orch.completeStage({ taskId: 'demo', stageId: 'discovery' }), /blocks stage/);
  const ledger = new EvidenceLedger({ repoRoot: root });
  const evidenceId = ledger.addEvidence({ taskId: 'demo', kind: 'documentation', provenance: 'extracted',
    source: { provider: 'web', capability: 'fetch' }, locator: { uri: 'https://example.org/docs/api' },
    content: 'The API is stable.' });
  ledger.save('demo');
  const claims = new ClaimsManager({ repoRoot: root, evidenceLedger: ledger });
  const claimId = claims.addClaim({ taskId: 'demo', statement: 'The documented API is stable.' });
  claims.linkEvidence(claimId, evidenceId, 'supports');
  claims.save('demo');
  const bad = cmd(root, 'research-request', '--action', 'list', '--task-id', 'demo', '--action', 'resolve', '--request-id', request.id,
    '--outcome', 'answered', '--claim-id', claimId, '--evidence-id', 'ev_missing');
  assert.notEqual(bad.code, 0);
  assert.equal(orch.status('demo').current.id, 'discovery');
  const good = cmd(root, 'research-request', '--action', 'list', '--task-id', 'demo', '--action', 'resolve', '--request-id', request.id,
    '--outcome', 'answered', '--claim-id', claimId, '--evidence-id', evidenceId);
  assert.equal(good.code, 0, good.message);
  const resumed = new WorkflowOrchestrator({ repoRoot: repo, projectRoot: root,
    stateDir: path.join(root, '.doflow/state/orchestration'), readinessEvaluate: ready });
  const pack = new ContextPackCompiler().compileContextPack({ taskId: 'demo', researchRequests: cmd(root,
    'research-request', '--action', 'list', '--task-id', 'demo').data.requests });
  assert.equal(pack.researchRequests[0].claimId, claimId);
  assert.equal(pack.researchRequests[0].evidenceIds[0], evidenceId);
  resumed.completeStage({ taskId: 'demo', stageId: 'discovery' });
  assert.equal(resumed.status('demo').current.id, 'gate-0');
});


test('conflicted sourced answer cannot complete dependent stage', t => {
  const { root, orch } = setup(t);
  const req = open(root, 'detected-gap', 'Does the upstream support v2?');
  const ledger = new EvidenceLedger({ repoRoot: root });
  const support = ledger.addEvidence({ taskId: 'demo', kind: 'documentation', provenance: 'extracted',
    locator: { uri: 'https://example.org/v2' }, content: 'v2 supported' });
  ledger.save('demo');
  const claims = new ClaimsManager({ repoRoot: root, evidenceLedger: ledger });
  const claim = claims.addClaim({ taskId: 'demo', statement: 'v2 supported' });
  claims.linkEvidence(claim, support, 'supports'); claims.save('demo');
  assert.equal(cmd(root, 'research-request', '--task-id', 'demo', '--action', 'resolve', '--request-id', req.id,
    '--outcome', 'answered', '--claim-id', claim, '--evidence-id', support).code, 0);
  const contrary = ledger.addEvidence({ taskId: 'demo', kind: 'documentation', provenance: 'extracted',
    locator: { uri: 'https://example.org/v2-change' }, content: 'v2 removed' });
  ledger.save('demo'); claims.linkEvidence(claim, contrary, 'contradicts'); claims.save('demo');
  assert.throws(() => orch.completeStage({ taskId: 'demo', stageId: 'discovery' }), /blocks stage/);
  assert.equal(orch.status('demo').current.id, 'discovery');
});

test('explicit nonblocking question and unavailable provider gap remain visible without approving a gate', t => {
  const { root, orch } = setup(t);
  const optional = open(root, 'user-request', 'Optional ecosystem status?');
  const required = open(root, 'detected-gap', 'Required vendor fact?');
  assert.equal(optional.blocking, false);
  assert.equal(required.blocking, true);
  const result = cmd(root, 'research-request', '--action', 'list', '--task-id', 'demo', '--action', 'resolve',
    '--request-id', required.id, '--outcome', 'unresolved', '--gap', 'Web provider unavailable; no query sent');
  assert.equal(result.code, 0, result.message);
  assert.throws(() => orch.handoff({ taskId: 'demo', taskClass: 'feature', callingSkill: 'do-brainstorm', note: 'skip gap' }), /blocks stage/);
  const status = orch.status('demo');
  assert.equal(status.current.id, 'discovery');
  assert.equal(orch.readRun('demo').program.find(n => n.id === 'gate-0').status, 'pending');
  const list = cmd(root, 'research-request', '--action', 'list', '--task-id', 'demo').data.requests;
  assert.equal(list.find(r => r.id === required.id).gap, 'Web provider unavailable; no query sent');
  assert.equal(list.find(r => r.id === optional.id).status, 'OPEN');
});

test('private-query denial leaves a gap without triggering a network request', t => {
  const { root, orch } = setup(t);
  const req = open(root, 'detected-gap', 'Can the private integration work with upstream?');
  const denied = cmd(root, 'research-request', '--action', 'list', '--task-id', 'demo', '--action', 'resolve', '--request-id', req.id,
    '--outcome', 'unresolved', '--gap', 'Private code required for query; developer denied disclosure; no outbound call');
  assert.equal(denied.code, 0, denied.message);
  assert.throws(() => orch.completeStage({ taskId: 'demo', stageId: 'discovery' }), /blocks stage/);
});

test('concurrent open and completion cannot strand a blocking request behind the cursor', async t => {
  const { root, orch } = setup(t);
  const { spawn } = require('node:child_process');
  function concurrent(verb, args) {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [cli, verb, ...args, '--json'], { cwd: root });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('close', code => resolve({ code, output }));
    });
  }
  const [opened, completed] = await Promise.all([
    concurrent('research-request', ['--action', 'open', '--task-id', 'demo', '--stage-id', 'discovery',
      '--question', 'Required upstream fact?', '--reason', 'detected-gap']),
    concurrent('orchestrate', ['--action', 'complete-stage', '--task-id', 'demo', '--stage', 'discovery']),
  ]);
  const requests = cmd(root, 'research-request', '--action', 'list', '--task-id', 'demo').data.requests;
  assert.notEqual(opened.code === 0 && completed.code === 0, true, `${opened.output}\n${completed.output}`);
  if (opened.code === 0) {
    assert.equal(completed.code, 1, completed.output);
    assert.equal(requests.length, 1);
    assert.equal(orch.status('demo').current.id, 'discovery');
  } else {
    assert.equal(completed.code, 0, completed.output);
    assert.equal(requests.length, 0);
    assert.equal(orch.status('demo').current.id, 'gate-0');
  }
});

test('retracted answer reports why it blocks without changing the stored request or cursor', t => {
  const { root, orch } = setup(t);
  const request = open(root, 'detected-gap', 'What does upstream support?');
  const ledger = new EvidenceLedger({ repoRoot: root });
  const evidenceId = ledger.addEvidence({ taskId: 'demo', kind: 'documentation', provenance: 'extracted',
    source: { provider: 'web', capability: 'fetch' }, locator: { uri: 'https://example.org/docs' }, content: 'Supported.' });
  ledger.save('demo');
  const claims = new ClaimsManager({ repoRoot: root, evidenceLedger: ledger });
  const claimId = claims.addClaim({ taskId: 'demo', statement: 'The API is supported.' });
  claims.linkEvidence(claimId, evidenceId, 'supports');
  claims.save('demo');
  assert.equal(cmd(root, 'research-request', '--action', 'resolve', '--task-id', 'demo',
    '--request-id', request.id, '--outcome', 'answered', '--claim-id', claimId,
    '--evidence-id', evidenceId).code, 0);
  claims.retractClaim(claimId);
  claims.save('demo');
  assert.throws(() => orch.completeStage({ taskId: 'demo', stageId: 'discovery' }),
    error => error.message.includes(request.id) && error.message.includes('retracted, not supported'));
  assert.equal(orch.status('demo').current.id, 'discovery');
  const stored = cmd(root, 'research-request', '--action', 'list', '--task-id', 'demo').data.requests[0];
  assert.equal(stored.status, 'ANSWERED');
  assert.equal(stored.gap, null);
  assert.equal(stored.failureReason, undefined);
});
