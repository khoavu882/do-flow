'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResearchRequestStore } = require('../../src/runtime/research-request');
const { updateTaskState } = require('../../src/runtime/task-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-research-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.doflow/state/orchestration/feature.json');
  updateTaskState({ fsImpl: fs, file, build: () => ({ taskId: 'feature', taskClass: 'feature',
    state: 'RUNNING', cursor: 0, program: [{ type: 'stage', id: 'design' }], history: [] }) });
  return { root, store: new ResearchRequestStore({ projectRoot: root }) };
}

test('open is idempotent while pending and defaults blocking from reason', t => {
  const { store } = fixture(t);
  const args = { taskId: 'feature', stageId: 'design', question: 'What does upstream say?', reason: 'detected-gap' };
  const first = store.open(args);
  assert.equal(first.status, 'OPEN');
  assert.equal(first.blocking, true);
  assert.equal(store.open(args).id, first.id);
  assert.equal(store.list('feature').length, 1);
  assert.equal(store.blockingGap('feature', 'design').id, first.id);
  assert.equal(store.open({ ...args, question: 'Another?', reason: 'user-request' }).blocking, false);
});

test('unresolved transition remains blocking and is immutable', t => {
  const { store } = fixture(t);
  const opened = store.open({ taskId: 'feature', stageId: 'design', question: 'Question', reason: 'detected-gap' });
  assert.throws(() => store.resolve({ taskId: 'feature', requestId: opened.id, outcome: 'unresolved' }), /requires a gap/);
  assert.equal(store.list('feature')[0].status, 'OPEN');
  const result = store.resolve({ taskId: 'feature', requestId: opened.id, outcome: 'unresolved', gap: 'Tool unavailable' });
  assert.equal(result.status, 'UNRESOLVED');
  assert.equal(store.blockingGap('feature', 'design').gap, 'Tool unavailable');
  assert.throws(() => store.resolve({ taskId: 'feature', requestId: opened.id, outcome: 'unresolved', gap: 'again' }), /not OPEN/);
});

test('refuses wrong stage, absent feature, and unsupported answer without a write', t => {
  const { root, store } = fixture(t);
  assert.throws(() => store.open({ taskId: 'feature', stageId: 'review', question: 'Q', reason: 'user-request' }), /Current feature stage/);
  assert.throws(() => store.open({ taskId: 'missing', stageId: 'design', question: 'Q', reason: 'user-request' }), /no active feature/);
  const opened = store.open({ taskId: 'feature', stageId: 'design', question: 'Q', reason: 'user-request' });
  const before = fs.readFileSync(path.join(root, '.doflow/state/research/feature.json'), 'utf8');
  assert.throws(() => store.resolve({ taskId: 'feature', requestId: opened.id, outcome: 'answered', claimId: 'foreign', evidenceIds: ['foreign'] }), /supported claim/);
  assert.equal(fs.readFileSync(path.join(root, '.doflow/state/research/feature.json'), 'utf8'), before);
});

test('answered requires same-task extracted source linked to supported claim', t => {
  const { root, store } = fixture(t);
  const { EvidenceLedger } = require('../../src/runtime/evidence-ledger');
  const { ClaimsManager } = require('../../src/runtime/claims');
  const request = store.open({ taskId: 'feature', stageId: 'design', question: 'Current API?', reason: 'detected-gap' });
  const ledger = new EvidenceLedger({ repoRoot: root });
  const evId = ledger.addEvidence({ taskId: 'feature', kind: 'documentation', provenance: 'extracted',
    locator: { uri: 'https://example.com/official-docs' }, source: { provider: 'web', capability: 'fetch' }, content: 'API v2' });
  ledger.save('feature');
  const claims = new ClaimsManager({ repoRoot: root, evidenceLedger: ledger });
  const claimId = claims.addClaim({ taskId: 'feature', statement: 'API v2 is supported' });
  assert.throws(() => store.resolve({ taskId: 'feature', requestId: request.id, outcome: 'answered', claimId, evidenceIds: [evId] }), /supported claim/);
  claims.linkEvidence(claimId, evId, 'supports');
  claims.save('feature');
  const result = store.resolve({ taskId: 'feature', requestId: request.id, outcome: 'answered', claimId, evidenceIds: [evId] });
  assert.equal(result.status, 'ANSWERED');
  assert.equal(store.blockingGap('feature', 'design'), null);
  assert.throws(() => store.resolve({ taskId: 'feature', requestId: request.id, outcome: 'answered', claimId, evidenceIds: [evId] }), /not OPEN/);
});

test('cannot attach a new request to a completed stage while awaiting its gate', t => {
  const { root, store } = fixture(t);
  const file = path.join(root, '.doflow/state/orchestration/feature.json');
  const { updateTaskState } = require('../../src/runtime/task-state');
  updateTaskState({ fsImpl: fs, file, build: disk => ({ ...disk, state: 'AWAITING_GATE', cursor: 1,
    program: [{ type: 'stage', id: 'design', status: 'completed' }, { type: 'gate', id: 'gate-a', status: 'pending' }] }) });
  assert.throws(() => store.open({ taskId: 'feature', stageId: 'design', question: 'Too late?', reason: 'detected-gap' }), /no active feature stage/);
  assert.deepEqual(store.list('feature'), []);
});

test('detected gap upgrades a duplicate optional question to blocking without creating another request', t => {
  const { root, store } = fixture(t);
  const args = { taskId: 'feature', stageId: 'design', question: 'Current library API?' };
  const optional = store.open({ ...args, reason: 'user-request' });
  assert.equal(optional.blocking, false);
  const detected = store.open({ ...args, reason: 'detected-gap' });
  assert.equal(detected.id, optional.id);
  assert.equal(detected.blocking, true);
  assert.equal(detected.reason, 'detected-gap');
  assert.equal(store.list('feature').length, 1);
  assert.equal(store.blockingGap('feature', 'design').id, optional.id);
  const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator');
  const orch = new WorkflowOrchestrator({ repoRoot: path.resolve(__dirname, '../..'), projectRoot: root,
    stateDir: path.join(root, '.doflow/state/orchestration') });
  assert.throws(() => orch.completeStage({ taskId: 'feature', stageId: 'design' }), /blocks stage/);
});

test('answered refuses non-web and credential-bearing URI locators', t => {
  const { root, store } = fixture(t);
  const { EvidenceLedger } = require('../../src/runtime/evidence-ledger');
  const { ClaimsManager } = require('../../src/runtime/claims');
  const request = store.open({ taskId: 'feature', stageId: 'design', question: 'External fact?', reason: 'detected-gap' });
  const ledger = new EvidenceLedger({ repoRoot: root });
  const ids = ['not-an-actual-locator', 'javascript:alert(1)', 'https://user:secret@example.com/path']
    .map(uri => ledger.addEvidence({ taskId: 'feature', kind: 'documentation', provenance: 'extracted',
      locator: { uri }, content: 'claim' }));
  ledger.save('feature');
  const claims = new ClaimsManager({ repoRoot: root, evidenceLedger: ledger });
  const claimId = claims.addClaim({ taskId: 'feature', statement: 'The source says so' });
  for (const id of ids) claims.linkEvidence(claimId, id, 'supports');
  claims.save('feature');
  for (const id of ids) {
    assert.throws(() => store.resolve({ taskId: 'feature', requestId: request.id,
      outcome: 'answered', claimId, evidenceIds: [id] }), /not fresh, located support/);
  }
  assert.equal(store.list('feature')[0].status, 'OPEN');
});
