'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { ResearchRequestStore, REASONS } = require('../../src/runtime/research-request.ts');
const { updateTaskState } = require('../../src/runtime/task-state.ts');

function fixture(t, kind) {
  const root = tempDir(t, 'doflow-research-request-');
  const file = path.join(root, '.doflow/state/orchestration/feature.json');
  const stage = kind === undefined ? { type: 'stage', id: 'design' } : { type: 'stage', id: 'design', kind };
  updateTaskState({ fsImpl: fs, file, build: () => ({ taskId: 'feature', taskClass: 'feature',
    state: 'RUNNING', cursor: 0, program: [stage], history: [] }) });
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
  const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
  const { ClaimsManager } = require('../../src/runtime/claims.ts');
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
  const { updateTaskState } = require('../../src/runtime/task-state.ts');
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
  const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');
  const orch = new WorkflowOrchestrator({ repoRoot: path.resolve(__dirname, '../..'), projectRoot: root,
    stateDir: path.join(root, '.doflow/state/orchestration') });
  assert.throws(() => orch.completeStage({ taskId: 'feature', stageId: 'design' }), /blocks stage/);
});

test('answered refuses non-web and credential-bearing URI locators', t => {
  const { root, store } = fixture(t);
  const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
  const { ClaimsManager } = require('../../src/runtime/claims.ts');
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

// ───────────────────────────────────────────────────────────────── ideation reason (IC-001, IC-002)

test('REASONS is exported and holds exactly the three reasons', () => {
  assert.ok(REASONS instanceof Set);
  assert.deepEqual([...REASONS].sort(), ['detected-gap', 'ideation', 'user-request']);
});

test('ideation is accepted on a discovery stage and on a design stage', t => {
  for (const kind of ['discovery', 'design']) {
    const { store } = fixture(t, kind);
    const opened = store.open({ taskId: 'feature', stageId: 'design', question: `Prior art for ${kind}?`, reason: 'ideation' });
    assert.equal(opened.reason, 'ideation', kind);
    assert.equal(opened.status, 'OPEN', kind);
  }
});

test('ideation is refused on any other stage kind, naming the kind, without a write', t => {
  const { root, store } = fixture(t, 'implementation');
  assert.throws(() => store.open({ taskId: 'feature', stageId: 'design', question: 'Q', reason: 'ideation' }),
    /reason ideation is only valid on a feature discovery or design stage, not 'implementation'/);
  assert.deepEqual(store.list('feature'), []);
  assert.equal(fs.existsSync(path.join(root, '.doflow/state/research/feature.json')), false);
});

test('ideation is refused naming none when the stage carries no kind; other reasons ignore the kind', t => {
  const { store } = fixture(t);
  assert.throws(() => store.open({ taskId: 'feature', stageId: 'design', question: 'Q', reason: 'ideation' }),
    /not 'none'/);
  assert.equal(store.open({ taskId: 'feature', stageId: 'design', question: 'Q', reason: 'user-request' }).reason, 'user-request');
  assert.equal(store.open({ taskId: 'feature', stageId: 'design', question: 'Q2', reason: 'detected-gap' }).blocking, true);
});

test('ideation defaults to non-blocking and honours an explicit blocking true', t => {
  const { store } = fixture(t, 'design');
  assert.equal(store.open({ taskId: 'feature', stageId: 'design', question: 'Default?', reason: 'ideation' }).blocking, false);
  assert.equal(store.open({ taskId: 'feature', stageId: 'design', question: 'Explicit?', reason: 'ideation', blocking: true }).blocking, true);
});

test('re-opening an OPEN ideation request does not upgrade it unless blocking is explicit', t => {
  const { store } = fixture(t, 'design');
  const args = { taskId: 'feature', stageId: 'design', question: 'Same question?', reason: 'ideation' };
  const first = store.open(args);
  assert.equal(store.open(args).blocking, false);
  const upgraded = store.open({ ...args, blocking: true });
  assert.equal(upgraded.id, first.id);
  assert.equal(upgraded.blocking, true);
  assert.equal(store.list('feature').length, 1);
});

test('an OPEN ideation request is returned by blockingGap whatever its blocking flag; UNRESOLVED does not block', t => {
  const { store } = fixture(t, 'design');
  const opened = store.open({ taskId: 'feature', stageId: 'design', question: 'Ideas?', reason: 'ideation' });
  assert.equal(opened.blocking, false);
  assert.equal(store.blockingGap('feature', 'design').id, opened.id);
  assert.equal(store.blockingGap('feature', 'other-stage'), null);
  store.resolve({ taskId: 'feature', requestId: opened.id, outcome: 'unresolved', gap: 'No source reachable' });
  assert.equal(store.blockingGap('feature', 'design'), null);
});

test('a blocking ANSWERED ideation request is validated like any blocking one', t => {
  const { root, store } = fixture(t, 'design');
  const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
  const { ClaimsManager } = require('../../src/runtime/claims.ts');
  const request = store.open({ taskId: 'feature', stageId: 'design', question: 'Blocking ideas?', reason: 'ideation', blocking: true });
  const ledger = new EvidenceLedger({ repoRoot: root });
  const evId = ledger.addEvidence({ taskId: 'feature', kind: 'documentation', provenance: 'extracted',
    locator: { uri: 'https://example.com/prior-art' }, source: { provider: 'web', capability: 'fetch' }, content: 'prior art' });
  ledger.save('feature');
  const claims = new ClaimsManager({ repoRoot: root, evidenceLedger: ledger });
  const claimId = claims.addClaim({ taskId: 'feature', statement: 'Prior art exists' });
  claims.linkEvidence(claimId, evId, 'supports');
  claims.save('feature');
  store.resolve({ taskId: 'feature', requestId: request.id, outcome: 'answered', claimId, evidenceIds: [evId] });
  assert.equal(store.blockingGap('feature', 'design'), null);
  // Make the evidence unsupported after the answer: the blocking ANSWERED request now fails validation.
  const file = path.join(root, '.doflow/state/research/feature.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.requests[0].evidenceIds = [];
  fs.writeFileSync(file, JSON.stringify(state));
  assert.match(store.blockingGap('feature', 'design').failureReason, /no linked evidence/);
});

// ───────────────────────────────────────────────────────────────── re-open upgrades to ideation (IC-001, C-1)

test('re-opening an OPEN user-request or non-blocking detected-gap as ideation upgrades it, and it then holds the stage', t => {
  for (const first of [{ reason: 'user-request' }, { reason: 'detected-gap', blocking: false }]) {
    const { store } = fixture(t, 'discovery');
    const args = { taskId: 'feature', stageId: 'design', question: `Same question for ${first.reason}?` };
    const opened = store.open({ ...args, ...first });
    assert.equal(opened.blocking, false, first.reason);
    assert.equal(store.blockingGap('feature', 'design'), null, first.reason);
    const reopened = store.open({ ...args, reason: 'ideation' });
    assert.equal(reopened.id, opened.id, first.reason);
    assert.equal(reopened.reason, 'ideation', first.reason);
    assert.equal(reopened.blocking, false, `${first.reason}: no re-open sets blocking on its own`);
    assert.equal(store.list('feature').length, 1, first.reason);
    assert.equal(store.blockingGap('feature', 'design').id, opened.id, `${first.reason}: OPEN ideation holds the stage`);
    store.resolve({ taskId: 'feature', requestId: opened.id, outcome: 'unresolved', gap: 'No source reachable' });
    assert.equal(store.blockingGap('feature', 'design'), null, first.reason);
  }
});

test('re-opening a blocking request as ideation keeps blocking and still holds after UNRESOLVED; no re-open weakens it', t => {
  const { store } = fixture(t, 'design');
  const args = { taskId: 'feature', stageId: 'design', question: 'Blocking gap?' };
  const opened = store.open({ ...args, reason: 'detected-gap' });
  assert.equal(opened.blocking, true);
  const reopened = store.open({ ...args, reason: 'ideation' });
  assert.equal(reopened.reason, 'ideation');
  assert.equal(reopened.blocking, true);
  assert.equal(store.open({ ...args, reason: 'user-request' }).reason, 'ideation', 'a weaker reason does not downgrade');
  assert.equal(store.open({ ...args, reason: 'user-request', blocking: false }).blocking, true);
  assert.equal(store.open({ ...args, reason: 'detected-gap', blocking: true }).reason, 'ideation', 'a blocking re-open does not rename ideation');
  store.resolve({ taskId: 'feature', requestId: opened.id, outcome: 'unresolved', gap: 'No source reachable' });
  assert.equal(store.blockingGap('feature', 'design').id, opened.id, 'blocking UNRESOLVED still holds');
});

test('ideation re-open on a stage that is not discovery or design is still refused and leaves the request unchanged', t => {
  const { store } = fixture(t, 'implementation');
  const args = { taskId: 'feature', stageId: 'design', question: 'Plain?' };
  const opened = store.open({ ...args, reason: 'user-request' });
  assert.throws(() => store.open({ ...args, reason: 'ideation' }), /only valid on a feature discovery or design stage/);
  assert.equal(store.list('feature')[0].reason, 'user-request');
  assert.equal(store.blockingGap('feature', 'design'), null);
  assert.equal(opened.id, store.list('feature')[0].id);
});
