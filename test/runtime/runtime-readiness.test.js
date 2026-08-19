'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger');
const { ClaimsManager } = require('../../src/runtime/claims');
const { FreshnessValidator } = require('../../src/runtime/freshness');
const { ContextPackCompiler } = require('../../src/runtime/context-pack');
const { ReadinessEngine } = require('../../src/runtime/readiness');

const REPO = path.resolve(__dirname, "../..");

test('ReadinessEngine loads templates for all 5 task classes', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  assert.ok(engine.templates);
  assert.ok(engine.templates.bug);
  assert.ok(engine.templates.feature);
  assert.ok(engine.templates.refactor);
  assert.ok(engine.templates['trivial-edit']);
  assert.ok(engine.templates['dependency-change']);
});

test('ReadinessEngine evaluates Bug Fix readiness with missing evidence (NEEDS_EVIDENCE)', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  const report = engine.evaluateReadiness(
    { taskId: 'task_bug_1', taskClass: 'bug', verificationPlan: 'npm test' },
    ledger,
    claims
  );

  assert.equal(report.state, 'NEEDS_EVIDENCE');
  const unsatisfied = report.requirements.filter((r) => r.required && !r.satisfied);
  assert.ok(unsatisfied.length > 0);
  assert.ok(unsatisfied.some((r) => r.id === 'reproduction'));
  assert.ok(unsatisfied.some((r) => r.id === 'root_cause'));
});

test('ReadinessEngine evaluates Bug Fix readiness as READY when prerequisites satisfied', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  // Add reproduction observation
  const ev1 = ledger.addEvidence({
    taskId: 'task_bug_ready',
    kind: 'runtime-observation',
    content: 'Observed HTTP 504 on payment gateway',
  });

  // Add affected code
  const ev2 = ledger.addEvidence({
    taskId: 'task_bug_ready',
    kind: 'exact-search',
    locator: { file: 'src/payment.js', lineRange: [45, 60] },
    content: 'function processPayment()',
  });

  // Add blast radius
  const ev3 = ledger.addEvidence({
    taskId: 'task_bug_ready',
    kind: 'structural',
    locator: { file: 'src/checkout.js' },
    content: 'CheckoutController -> PaymentService',
  });

  // Add supported root cause claim
  const claimId = claims.addClaim({
    taskId: 'task_bug_ready',
    statement: 'Missing keepalive in socket timeout handler',
  });
  claims.linkEvidence(claimId, ev2, 'supports');

  const report = engine.evaluateReadiness(
    {
      taskId: 'task_bug_ready',
      taskClass: 'bug',
      verificationPlan: 'node --test test/payment.test.js',
    },
    ledger,
    claims
  );

  assert.equal(report.state, 'READY');
  assert.equal(report.requirements.every((r) => !r.required || r.satisfied), true);
});

test('ReadinessEngine evaluates Trivial Edit with localized target', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  ledger.addEvidence({
    taskId: 'task_trivial',
    kind: 'exact-search',
    locator: { file: 'README.md', lineRange: [1, 5] },
    content: '# DoFlow',
  });

  const report = engine.evaluateReadiness(
    {
      taskId: 'task_trivial',
      taskClass: 'trivial-edit',
      scopeClear: true,
    },
    ledger,
    claims
  );

  assert.equal(report.state, 'READY');
});

test('ReadinessEngine detects BLOCKED state when conflicted claims exist', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  const ev1 = ledger.addEvidence({ taskId: 't_blocked', kind: 'exact-search', content: 'v1' });
  const ev2 = ledger.addEvidence({ taskId: 't_blocked', kind: 'runtime-observation', content: 'v2' });

  const claimId = claims.addClaim({ taskId: 't_blocked', statement: 'Version is always v1' });
  claims.linkEvidence(claimId, ev1, 'supports');
  claims.linkEvidence(claimId, ev2, 'contradicts');

  const report = engine.evaluateReadiness(
    { taskId: 't_blocked', taskClass: 'feature', verificationPlan: 'npm test' },
    ledger,
    claims
  );

  assert.equal(report.state, 'BLOCKED');
  assert.equal(report.claimsSummary.conflicts, 1);
});

test('ContextPackCompiler compiles compact structured context within budget', () => {
  const compiler = new ContextPackCompiler({ maxFiles: 2, maxClaims: 2 });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  const ev1 = ledger.addEvidence({
    taskId: 'task_cpack',
    kind: 'exact-search',
    locator: { file: 'src/a.js' },
  });
  const ev2 = ledger.addEvidence({
    taskId: 'task_cpack',
    kind: 'exact-search',
    locator: { file: 'src/b.js' },
  });

  const claim1 = claims.addClaim({ taskId: 'task_cpack', statement: 'Claim 1' });
  const claim2 = claims.addClaim({ taskId: 'task_cpack', statement: 'Claim 2' });
  claims.linkEvidence(claim1, ev1, 'supports');
  claims.linkEvidence(claim2, ev2, 'supports');

  const pack = compiler.compileContextPack({
    taskId: 'task_cpack',
    taskClass: 'feature',
    objective: 'Implement payments',
    constraints: ['Zero extra dependencies'],
    evidenceLedger: ledger,
    claimsManager: claims,
  });

  assert.equal(pack.taskId, 'task_cpack');
  assert.equal(pack.claims.supported.length, 2);
  assert.equal(pack.relevantFiles.length, 2);
  assert.ok(pack.objective);

  const md = compiler.formatMarkdown(pack);
  assert.ok(md.includes('ContextPack: [FEATURE] task_cpack'));
  assert.ok(md.includes('Implement payments'));
});

test('FreshnessValidator detects modified files and marks evidence STALE', () => {
  let mockStatusOutput = ' M src/modified.js';
  const mockGitRunner = (args) => {
    if (args[0] === 'status') return mockStatusOutput;
    if (args[0] === 'rev-parse') return 'commit_abc123';
    return '';
  };

  const validator = new FreshnessValidator({ gitRunner: mockGitRunner });
  const ledger = new EvidenceLedger();

  const evFresh = ledger.addEvidence({
    taskId: 't_fresh',
    kind: 'exact-search',
    locator: { file: 'src/unmodified.js' },
  });

  const evStale = ledger.addEvidence({
    taskId: 't_fresh',
    kind: 'exact-search',
    locator: { file: 'src/modified.js' },
  });

  assert.equal(ledger.getEvidence(evFresh).freshness.status, 'FRESH');
  assert.equal(ledger.getEvidence(evStale).freshness.status, 'FRESH');

  const staleCount = validator.validateLedgerFreshness(ledger);
  assert.equal(staleCount, 1);
  assert.equal(ledger.getEvidence(evFresh).freshness.status, 'FRESH');
  assert.equal(ledger.getEvidence(evStale).freshness.status, 'STALE');
});
