'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger');
const { ClaimsManager } = require('../../src/runtime/claims');

test('ClaimsManager initializes claims in hypothesis status', () => {
  const claims = new ClaimsManager();
  const claimId = claims.addClaim({
    statement: 'The cache TTL is 300 seconds',
    taskId: 'task_001',
  });

  assert.ok(claimId.startsWith('claim_'));
  const claim = claims.getClaim(claimId);
  assert.equal(claim.status, 'hypothesis');
  assert.equal(claim.statement, 'The cache TTL is 300 seconds');
});

test('ClaimsManager graduates hypothesis to supported when fresh evidence linked', () => {
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  const evId = ledger.addEvidence({
    taskId: 'task_001',
    kind: 'exact-search',
    locator: { file: 'src/config.js', lineRange: [15, 15] },
    content: 'const TTL = 300;',
  });

  const claimId = claims.addClaim({
    statement: 'The cache TTL is 300 seconds',
    taskId: 'task_001',
  });

  assert.equal(claims.getClaim(claimId).status, 'hypothesis');

  claims.linkEvidence(claimId, evId, 'supports');
  assert.equal(claims.getClaim(claimId).status, 'supported');

  // Verify bidirectional link
  assert.ok(ledger.getEvidence(evId).supports.includes(claimId));
});

test('ClaimsManager detects conflicted claims when contradicting evidence linked', () => {
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  const evSupId = ledger.addEvidence({
    taskId: 'task_001',
    kind: 'exact-search',
    content: 'const TTL = 300;',
  });

  const evContraId = ledger.addEvidence({
    taskId: 'task_001',
    kind: 'runtime-observation',
    content: 'Observed runtime cache TTL is 60 seconds.',
  });

  const claimId = claims.addClaim({
    statement: 'Cache TTL is 300 seconds everywhere',
    taskId: 'task_001',
  });

  claims.linkEvidence(claimId, evSupId, 'supports');
  assert.equal(claims.getClaim(claimId).status, 'supported');

  claims.linkEvidence(claimId, evContraId, 'contradicts');
  assert.equal(claims.getClaim(claimId).status, 'conflicted');
});

test('ClaimsManager invalidates supported claim when supporting evidence becomes stale', () => {
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  const evId = ledger.addEvidence({
    taskId: 'task_001',
    kind: 'exact-search',
    locator: { file: 'src/config.js' },
    content: 'const TTL = 300;',
  });

  const claimId = claims.addClaim({
    statement: 'Cache TTL is 300s',
    taskId: 'task_001',
  });

  claims.linkEvidence(claimId, evId, 'supports');
  assert.equal(claims.getClaim(claimId).status, 'supported');

  // File modified -> invalidates evidence
  ledger.invalidateFiles(['src/config.js']);
  claims.evaluateClaim(claimId);

  assert.equal(claims.getClaim(claimId).status, 'invalidated');
});

test('ClaimsManager saves and loads task claims', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-test-claims-'));
  const claims1 = new ClaimsManager({ stateDir: tmpDir });

  claims1.addClaim({
    id: 'claim_persist_1',
    statement: 'Retry limit is 3',
    taskId: 'task_persist',
  });

  const filePath = claims1.save('task_persist');
  assert.ok(fs.existsSync(filePath));

  const claims2 = new ClaimsManager({ stateDir: tmpDir });
  const count = claims2.load('task_persist');
  assert.equal(count, 1);

  const loaded = claims2.getClaim('claim_persist_1');
  assert.ok(loaded);
  assert.equal(loaded.statement, 'Retry limit is 3');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Claim lifecycle: retract and supersede (FR-001, FR-002, FR-003) ──────────

test('retract moves a claim to a terminal state and deletes nothing', () => {
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });
  const evId = ledger.addEvidence({ taskId: 't', kind: 'exact-search', locator: { file: 'a.js' }, content: 'x' });
  const id = claims.addClaim({ statement: 'obsolete conclusion', taskId: 't' });
  claims.linkEvidence(id, evId, 'supports');

  assert.equal(claims.retractClaim(id), 'retracted');
  const claim = claims.getClaim(id);
  assert.equal(claim.status, 'retracted');
  assert.equal(claim.statement, 'obsolete conclusion');
  assert.deepEqual(claim.supportingEvidence, [evId]);
  assert.ok(claim.terminalAt);
  assert.equal(claims.getClaims('t').length, 1, 'the record survives retraction');
});

test('a retracted claim survives evaluateAll — the guard against silent resurrection', () => {
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });
  const evId = ledger.addEvidence({ taskId: 't', kind: 'exact-search', locator: { file: 'a.js' }, content: 'x' });
  const id = claims.addClaim({ statement: 's', taskId: 't' });
  claims.linkEvidence(id, evId, 'supports');
  assert.equal(claims.getClaim(id).status, 'supported');

  claims.retractClaim(id);
  claims.evaluateAll();
  claims.evaluateAll();
  assert.equal(claims.getClaim(id).status, 'retracted');
});

test('a conflicted claim stops being conflicted once retracted', () => {
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });
  const sup = ledger.addEvidence({ taskId: 't', kind: 'exact-search', locator: { file: 'a.js' }, content: 'x' });
  const con = ledger.addEvidence({ taskId: 't', kind: 'exact-search', locator: { file: 'b.js' }, content: 'y' });
  const id = claims.addClaim({ statement: 's', taskId: 't' });
  claims.linkEvidence(id, sup, 'supports');
  claims.linkEvidence(id, con, 'contradicts');
  assert.equal(claims.getClaim(id).status, 'conflicted');

  claims.retractClaim(id);
  claims.evaluateAll();
  assert.equal(claims.getClaim(id).status, 'retracted');
});

test('supersede records a forward pointer to the replacing claim', () => {
  const claims = new ClaimsManager();
  const oldId = claims.addClaim({ statement: 'nine of fifteen', taskId: 't' });
  const newId = claims.addClaim({ statement: 'ten of fifteen', taskId: 't' });

  assert.equal(claims.supersedeClaim(oldId, newId), 'superseded');
  assert.equal(claims.getClaim(oldId).supersededBy, newId);
  assert.equal(claims.getClaim(newId).status, 'hypothesis', 'the replacement is untouched');
});

test('superseding by an unrecorded claim id is refused', () => {
  const claims = new ClaimsManager();
  const id = claims.addClaim({ statement: 's', taskId: 't' });
  assert.throws(() => claims.supersedeClaim(id, 'claim_nope'), /No claim 'claim_nope' is recorded/);
  assert.equal(claims.getClaim(id).status, 'hypothesis', 'a refused supersede changes nothing');
});

test('a claim cannot supersede itself, and a terminal claim cannot be finalized twice', () => {
  const claims = new ClaimsManager();
  const a = claims.addClaim({ statement: 'a', taskId: 't' });
  const b = claims.addClaim({ statement: 'b', taskId: 't' });
  assert.throws(() => claims.supersedeClaim(a, a), /cannot supersede itself/);
  claims.retractClaim(a);
  assert.throws(() => claims.retractClaim(a), /already 'retracted'/);
  assert.throws(() => claims.supersedeClaim(a, b), /already 'retracted'/);
});

test('retracting or superseding an unknown claim is refused', () => {
  const claims = new ClaimsManager();
  assert.throws(() => claims.retractClaim('claim_nope'), /Unknown claim/);
  assert.throws(() => claims.supersedeClaim('claim_nope', 'x'), /Unknown claim/);
});

test('a claims file written before terminal states loads and evaluates unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-claims-compat-'));
  const stateDir = path.join(root, '.doflow', 'state', 'evidence');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'legacy_claims.json'), JSON.stringify({
    version: 1,
    taskId: 'legacy',
    claims: [{
      id: 'claim_old_1',
      taskId: 'legacy',
      statement: 'recorded before this feature',
      status: 'hypothesis',
      supportingEvidence: [],
      contradictingEvidence: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }), 'utf8');

  const claims = new ClaimsManager({ repoRoot: root });
  assert.equal(claims.load('legacy'), 1);
  claims.evaluateAll();
  const claim = claims.getClaim('claim_old_1');
  assert.equal(claim.status, 'hypothesis');
  assert.equal(claim.supersededBy, undefined);
});

test('terminal state and forward pointer survive a save/load round trip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-claims-rt-'));
  const claims = new ClaimsManager({ repoRoot: root });
  const oldId = claims.addClaim({ statement: 'old', taskId: 't' });
  const newId = claims.addClaim({ statement: 'new', taskId: 't' });
  claims.supersedeClaim(oldId, newId);
  claims.save('t');

  const reloaded = new ClaimsManager({ repoRoot: root });
  reloaded.load('t');
  reloaded.evaluateAll();
  assert.equal(reloaded.getClaim(oldId).status, 'superseded');
  assert.equal(reloaded.getClaim(oldId).supersededBy, newId);
});
