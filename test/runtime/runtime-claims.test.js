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
