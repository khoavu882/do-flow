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

  // Add reproduction observation: an executed command with its exit status, bound to the
  // requirement it was gathered to prove (review R1 — kind alone no longer satisfies).
  const ev1 = ledger.addEvidence({
    taskId: 'task_bug_ready',
    kind: 'runtime-observation',
    content: 'Observed HTTP 504 on payment gateway',
    establishes: ['reproduction'],
    observation: { command: 'curl -sf http://localhost:8080/pay', exitCode: 22 },
  });

  // Add affected code
  const ev2 = ledger.addEvidence({
    taskId: 'task_bug_ready',
    kind: 'exact-search',
    locator: { file: 'src/runtime/readiness.js', lineRange: [45, 60] },
    content: 'function processPayment()',
    establishes: ['affected_code'],
  });

  // Add blast radius
  const ev3 = ledger.addEvidence({
    taskId: 'task_bug_ready',
    kind: 'structural',
    locator: { file: 'src/runtime/claims.js' },
    content: 'CheckoutController -> PaymentService',
    establishes: ['blast_radius'],
  });

  // Add supported root cause claim, declared in the root-cause role the template requires
  const claimId = claims.addClaim({
    taskId: 'task_bug_ready',
    statement: 'Missing keepalive in socket timeout handler',
    role: 'root-cause',
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
    establishes: ['target_identified'],
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
    locator: { file: 'src/runtime/cli.js' },
  });
  const ev2 = ledger.addEvidence({
    taskId: 'task_cpack',
    kind: 'exact-search',
    locator: { file: 'src/runtime/evidence-ledger.js' },
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
  let mockStatusOutput = ' M src/runtime/locator-resolve.js';
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
    locator: { file: 'src/runtime/leak-scan.js' },
  });

  const evStale = ledger.addEvidence({
    taskId: 't_fresh',
    kind: 'exact-search',
    locator: { file: 'src/runtime/locator-resolve.js' },
  });

  assert.equal(ledger.getEvidence(evFresh).freshness.status, 'FRESH');
  assert.equal(ledger.getEvidence(evStale).freshness.status, 'FRESH');

  const staleCount = validator.validateLedgerFreshness(ledger);
  assert.equal(staleCount, 1);
  assert.equal(ledger.getEvidence(evFresh).freshness.status, 'FRESH');
  assert.equal(ledger.getEvidence(evStale).freshness.status, 'STALE');
});

// ── Supersede: a stale item, once explicitly retired, stops forcing NEEDS_EVIDENCE ───────────
// Regression for the deadlock found while this very repo's own 027-design-artifact-restructure
// feature ran /do-execute-plan: design-stage evidence pointed at files the feature's own
// implementation later edited, went STALE, and staleEvidence.length > 0 forced NEEDS_EVIDENCE
// forever — even though every template requirement was independently satisfied by fresh evidence
// and evidence had no way to retire the stale item (unlike claims' retract/supersede).

test('a stale item alone forces NEEDS_EVIDENCE even when every requirement is otherwise satisfied, until superseded', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  // Everything the 'feature' template needs is satisfied by fresh evidence...
  const freshId = ledger.addEvidence({
    taskId: 'task_supersede',
    kind: 'structural',
    provenance: 'extracted',
    locator: { file: 'src/runtime/readiness.js', line: 1 },
    content: 'use strict',
    establishes: ['affected_components'],
  });

  // ...but an older, unrelated item recorded for the same task has since gone stale.
  const staleId = ledger.addEvidence({
    taskId: 'task_supersede',
    kind: 'structural',
    provenance: 'extracted',
    locator: { file: 'src/runtime/evidence-ledger.js', line: 1 },
    content: 'a fact recorded before evidence-ledger.js changed',
  });
  ledger.getEvidence(staleId).freshness.status = 'STALE';

  const before = engine.evaluateReadiness(
    { taskId: 'task_supersede', taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' },
    ledger,
    claims,
  );

  assert.ok(before.requirements.every((r) => !r.required || r.satisfied),
    'every requirement should read satisfied on its own merits');
  assert.equal(before.state, 'NEEDS_EVIDENCE',
    'the stale item alone still forces NEEDS_EVIDENCE — this is the deadlock this test guards');
  assert.equal(before.staleEvidence.length, 1);
  assert.equal(before.staleEvidence[0].evidenceId, staleId);

  // Superseding the stale item with the fresh one is the only way out — re-recording a fresh
  // item for the same fact does not, on its own, remove the old one from staleEvidence.
  const status = ledger.supersedeEvidence(staleId, freshId);
  assert.equal(status, 'superseded');

  const after = engine.evaluateReadiness(
    { taskId: 'task_supersede', taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' },
    ledger,
    claims,
  );

  assert.equal(after.staleEvidence.length, 0);
  assert.equal(after.state, 'READY');
});

test('supersedeEvidence refuses a missing replacement, self-supersession, and re-superseding', () => {
  const ledger = new EvidenceLedger();
  const a = ledger.addEvidence({ taskId: 't', kind: 'structural', provenance: 'extracted', locator: { file: 'src/runtime/readiness.js' } });
  const b = ledger.addEvidence({ taskId: 't', kind: 'structural', provenance: 'extracted', locator: { file: 'src/runtime/claims.js' } });

  assert.throws(() => ledger.supersedeEvidence(a, 'no-such-id'), /No evidence 'no-such-id' is recorded/);
  assert.throws(() => ledger.supersedeEvidence(a, a), /cannot supersede itself/);

  ledger.supersedeEvidence(a, b);
  assert.equal(ledger.getEvidence(a).status, 'superseded');
  assert.equal(ledger.getEvidence(a).supersededBy, b);

  assert.throws(() => ledger.supersedeEvidence(a, b), /already superseded/);
});

// ── FR-005: a gate does not report READY on evidence whose locator no longer resolves ────────

test('FR-005: an unresolvable supporting locator keeps the gate off READY and names the item', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  // Recorded before FR-004 existed, or valid then and the file has since shrunk. Either way it is
  // FRESH and points at nothing.
  ledger.addEvidence({
    taskId: 'task_unresolvable',
    kind: 'exact-search',
    provenance: 'extracted',
    locator: { file: 'src/runtime/readiness.js', line: 99999 },
    content: 'a line that is not there',
  });

  const report = engine.evaluateReadiness(
    {
      taskId: 'task_unresolvable',
      taskClass: 'feature',
      scopeClear: 'stated',
      verificationPlan: 'npm test',
    },
    ledger,
    claims
  );

  assert.notEqual(report.state, 'READY');
  assert.equal(report.unresolvableEvidence.length, 1);
  assert.equal(report.unresolvableEvidence[0].reason, 'line-beyond-eof');
  assert.match(report.summary, /no longer\s+resolves/);
});

test('FR-005: unresolvable is distinct from BLOCKED — nothing contradicts anything', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  ledger.addEvidence({
    taskId: 'task_unresolvable_2',
    kind: 'exact-search',
    provenance: 'extracted',
    locator: { file: 'src/runtime/gone-forever.js' },
    content: 'x',
  });

  const report = engine.evaluateReadiness(
    { taskId: 'task_unresolvable_2', taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' },
    ledger,
    claims
  );

  assert.equal(report.state, 'NEEDS_EVIDENCE');
  assert.equal(report.claimsSummary.conflicts, 0);
  assert.equal(report.unresolvableEvidence[0].reason, 'file-missing');
});

test('FR-005: resolvable evidence leaves the verdict untouched', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  ledger.addEvidence({
    taskId: 'task_resolvable',
    kind: 'structural',
    provenance: 'extracted',
    locator: { file: 'src/runtime/readiness.js', line: 1 },
    content: 'use strict',
    establishes: ['affected_components'],
  });

  const report = engine.evaluateReadiness(
    { taskId: 'task_resolvable', taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' },
    ledger,
    claims
  );

  assert.deepEqual(report.unresolvableEvidence, []);
  assert.equal(report.state, 'READY');
});

test('FR-005: an inferred item with an unreadable locator is not held to resolvability', () => {
  const engine = new ReadinessEngine({ repoRoot: REPO });
  const ledger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger: ledger });

  ledger.addEvidence({
    taskId: 'task_inferred',
    kind: 'generated-analysis',
    provenance: 'inferred',
    locator: { file: 'src/runtime/gone-forever.js' },
    content: 'analysis, not a read of the repository',
  });

  const report = engine.evaluateReadiness(
    { taskId: 'task_inferred', taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' },
    ledger,
    claims
  );

  assert.deepEqual(report.unresolvableEvidence, []);
});

// ── FR-003: the per-commit diff is computed once, not once per evidence item ─────────────────

test('FR-003: items sharing a recorded commit cost one diff, not one each', () => {
  const calls = [];
  const mockGit = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return ' M src/runtime/cli.js';
    if (args[0] === 'rev-parse') return 'commit_shared';
    if (args[0] === 'diff') return 'src/runtime/cli.js';
    return '';
  };
  const validator = new FreshnessValidator({ gitRunner: mockGit });
  const ledger = new EvidenceLedger();

  // Five items, one recorded commit — the shape a stage batch actually produces.
  for (let i = 0; i < 5; i += 1) {
    ledger.addEvidence({
      taskId: 't_memo',
      kind: 'exact-search',
      provenance: 'extracted',
      locator: { file: 'src/runtime/cli.js' },
      content: `item ${i}`,
    });
  }
  for (const item of ledger.getAllEvidence()) item.freshness.gitCommit = 'commit_shared';

  validator.validateLedgerFreshness(ledger);

  const diffCalls = calls.filter((c) => c.startsWith('diff'));
  assert.equal(diffCalls.length, 1,
    `five items on one commit should cost one diff, not ${diffCalls.length}`);
});

test('FR-003: distinct recorded commits each get their own diff', () => {
  const calls = [];
  const mockGit = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return '';
    if (args[0] === 'diff') return 'src/runtime/cli.js';
    return '';
  };
  const validator = new FreshnessValidator({ gitRunner: mockGit });
  const ledger = new EvidenceLedger();
  for (const sha of ['sha_a', 'sha_b', 'sha_a']) {
    const id = ledger.addEvidence({
      taskId: 't_memo2',
      kind: 'exact-search',
      provenance: 'extracted',
      locator: { file: 'src/runtime/cli.js' },
      content: 'x',
    });
    ledger.getEvidence(id).freshness.gitCommit = sha;
  }

  validator.validateLedgerFreshness(ledger);

  const diffCalls = calls.filter((c) => c.startsWith('diff'));
  assert.equal(diffCalls.length, 2, 'two distinct commits, two diffs — the repeat is memoised');
});
