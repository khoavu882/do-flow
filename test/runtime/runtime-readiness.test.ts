'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { ClaimsManager } = require('../../src/runtime/claims.ts');
const { FreshnessValidator } = require('../../src/runtime/freshness.ts');
const { ContextPackCompiler } = require('../../src/runtime/context-pack.ts');
const { ReadinessEngine } = require('../../src/runtime/readiness.ts');
const { updatePlan } = require('../../src/runtime/retrieval-record.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, "../..");

test('ReadinessEngine loads templates for all 5 task classes', () => {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  assert.ok(engine.templates);
  assert.ok(engine.templates.bug);
  assert.ok(engine.templates.feature);
  assert.ok(engine.templates.refactor);
  assert.ok(engine.templates['trivial-edit']);
  assert.ok(engine.templates['dependency-change']);
});

test('ReadinessEngine evaluates Bug Fix readiness with missing evidence (NEEDS_EVIDENCE)', () => {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

  const report = engine.evaluateReadiness(
    { taskId: 'task_bug_1', taskClass: 'bug', verificationPlan: 'npm test' },
    ledger,
    claims
  );

  assert.equal(report.state, 'NEEDS_EVIDENCE');
  const unsatisfied = report.requirements.filter((r: any) => r.required && !r.satisfied);
  assert.ok(unsatisfied.length > 0);
  assert.ok(unsatisfied.some((r: any) => r.id === 'reproduction'));
  assert.ok(unsatisfied.some((r: any) => r.id === 'root_cause'));
});

test('ReadinessEngine evaluates Bug Fix readiness as READY when prerequisites satisfied', () => {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

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
    locator: { file: 'src/runtime/readiness.ts', lineRange: [45, 60] },
    content: 'function processPayment()',
    establishes: ['affected_code'],
  });

  // Add blast radius
  const ev3 = ledger.addEvidence({
    taskId: 'task_bug_ready',
    kind: 'structural',
    locator: { file: 'src/runtime/claims.ts' },
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
  assert.equal(report.requirements.every((r: any) => !r.required || r.satisfied), true);
});

test('ReadinessEngine evaluates Trivial Edit with localized target', () => {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

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
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

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
  const compiler: any = new ContextPackCompiler({ maxFiles: 2, maxClaims: 2 });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

  const ev1 = ledger.addEvidence({
    taskId: 'task_cpack',
    kind: 'exact-search',
    locator: { file: 'src/runtime/cli.ts' },
  });
  const ev2 = ledger.addEvidence({
    taskId: 'task_cpack',
    kind: 'exact-search',
    locator: { file: 'src/runtime/evidence-ledger.ts' },
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
  const mockGitRunner = (args: any) => {
    if (args[0] === 'status') return mockStatusOutput;
    if (args[0] === 'rev-parse') return 'commit_abc123';
    return '';
  };

  const validator: any = new FreshnessValidator({ gitRunner: mockGitRunner });
  const ledger: any = new EvidenceLedger();

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
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

  // Everything the 'feature' template needs is satisfied by fresh evidence...
  const freshId = ledger.addEvidence({
    taskId: 'task_supersede',
    kind: 'structural',
    provenance: 'extracted',
    locator: { file: 'src/runtime/readiness.ts', line: 1 },
    content: 'use strict',
    establishes: ['affected_components'],
  });

  // ...but an older, unrelated item recorded for the same task has since gone stale.
  const staleId = ledger.addEvidence({
    taskId: 'task_supersede',
    kind: 'structural',
    provenance: 'extracted',
    locator: { file: 'src/runtime/evidence-ledger.ts', line: 1 },
    content: 'a fact recorded before evidence-ledger.ts changed',
  });
  ledger.getEvidence(staleId).freshness.status = 'STALE';

  const before = engine.evaluateReadiness(
    { taskId: 'task_supersede', taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' },
    ledger,
    claims,
  );

  assert.ok(before.requirements.every((r: any) => !r.required || r.satisfied),
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
  const ledger: any = new EvidenceLedger();
  const a = ledger.addEvidence({ taskId: 't', kind: 'structural', provenance: 'extracted', locator: { file: 'src/runtime/readiness.ts' } });
  const b = ledger.addEvidence({ taskId: 't', kind: 'structural', provenance: 'extracted', locator: { file: 'src/runtime/claims.ts' } });

  assert.throws(() => ledger.supersedeEvidence(a, 'no-such-id'), /No evidence 'no-such-id' is recorded/);
  assert.throws(() => ledger.supersedeEvidence(a, a), /cannot supersede itself/);

  ledger.supersedeEvidence(a, b);
  assert.equal(ledger.getEvidence(a).status, 'superseded');
  assert.equal(ledger.getEvidence(a).supersededBy, b);

  assert.throws(() => ledger.supersedeEvidence(a, b), /already superseded/);
});

// ── FR-005: a gate does not report READY on evidence whose locator no longer resolves ────────

test('FR-005: an unresolvable supporting locator keeps the gate off READY and names the item', () => {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

  // Recorded before FR-004 existed, or valid then and the file has since shrunk. Either way it is
  // FRESH and points at nothing.
  ledger.addEvidence({
    taskId: 'task_unresolvable',
    kind: 'exact-search',
    provenance: 'extracted',
    locator: { file: 'src/runtime/readiness.ts', line: 99999 },
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
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

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

test('a stale absence blocks its requirement with the specific reason and stays out of staleEvidence', (t) => {
  const root = tempDir(t, 'doflow-readiness-stale-absence-');
  const taskId = 't-stale-absence';
  updatePlan(root, taskId, null, () => ({ taskId, needs: [], providers: {
    'graphify.query': { refresh: 'graphify refresh' },
  } }));
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: root });
  const ledger: any = new EvidenceLedger({ repoRoot: root });
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  const id = ledger.addEvidence({ taskId, kind: 'structural', result: 'EMPTY', establishes: ['architecture_mapped'],
    source: { provider: 'graphify.query', capability: 'code.impact-analysis' }, freshness: { status: 'STALE', gitCommit: 'commit_test' } });

  const report = engine.evaluateReadiness({ taskId, taskClass: 'refactor' }, ledger, claims);
  const requirement = report.requirements.find((item: any) => item.id === 'architecture_mapped');
  assert.equal(report.state, 'NEEDS_EVIDENCE');
  assert.equal(requirement.reasonCode, 'stale-absence-unverified');
  assert.equal(requirement.reason, `'architecture_mapped' rests only on an empty answer from graphify.query, whose index was STALE when it was recorded (${id}). An empty answer from that index cannot establish absence. Run the declared refresh command (graphify refresh) and record the absence again, or re-run the lookup with a live provider such as native.rg: doflow evidence --task-id ${taskId} --action add --absence --need <intent> --provider native.rg ...`);
  assert.deepEqual(report.staleAbsence, [{ evidenceId: id, requirement: 'architecture_mapped', provider: 'graphify.query', freshness: 'STALE', refresh: 'graphify refresh' }]);
  assert.deepEqual(report.staleEvidence, []);
});

test('an UNKNOWN absence also blocks its requirement with stale-absence-unverified', (t) => {
  const root = tempDir(t, 'doflow-readiness-unknown-absence-');
  const taskId = 't-unknown-absence';
  updatePlan(root, taskId, null, () => ({ taskId, needs: [], providers: {} }));
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: root });
  const ledger: any = new EvidenceLedger({ repoRoot: root });
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  const id = ledger.addEvidence({ taskId, kind: 'structural', result: 'EMPTY', establishes: ['architecture_mapped'],
    source: { provider: 'unmapped.index', capability: 'code.impact-analysis' }, freshness: { status: 'UNKNOWN' } });

  const report = engine.evaluateReadiness({ taskId, taskClass: 'refactor' }, ledger, claims);
  const requirement = report.requirements.find((item: any) => item.id === 'architecture_mapped');
  assert.equal(report.state, 'NEEDS_EVIDENCE');
  assert.equal(requirement.satisfied, false);
  assert.equal(requirement.reasonCode, 'stale-absence-unverified');
  assert.deepEqual(report.staleAbsence, [{ evidenceId: id, requirement: 'architecture_mapped', provider: 'unmapped.index', freshness: 'UNKNOWN', refresh: null }]);
  assert.deepEqual(report.staleEvidence, []);
});

test('a fresh absence qualifies, while a query-bound unbound item does not', (t) => {
  const root = tempDir(t, 'doflow-readiness-binding-');
  const taskId = 't-readiness-binding';
  updatePlan(root, taskId, null, () => ({ taskId, planId: 'rp_test_1234', needs: [
    { intent: 'estimate-blast-radius', queryRef: 'rp_test_1234#estimate-blast-radius', capability: 'code.impact-analysis' },
  ] }));
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: root });
  const ledger: any = new EvidenceLedger({ repoRoot: root });
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  ledger.addEvidence({ taskId, kind: 'structural', result: 'EMPTY', establishes: ['architecture_mapped'],
    source: { provider: 'native.rg', capability: 'code.impact-analysis', queryRef: 'rp_test_1234#estimate-blast-radius' },
    freshness: { status: 'FRESH' } });
  const fresh = engine.evaluateReadiness({ taskId, taskClass: 'refactor' }, ledger, claims);
  assert.equal(fresh.requirements.find((item: any) => item.id === 'architecture_mapped').satisfied, true);

  const otherTask = 't-unbound-readiness';
  updatePlan(root, otherTask, null, () => ({ taskId: otherTask, planId: 'rp_test_5678', needs: [
    { intent: 'estimate-blast-radius', queryRef: 'rp_test_5678#estimate-blast-radius', capability: 'code.impact-analysis' },
  ] }));
  const otherLedger: any = new EvidenceLedger({ repoRoot: root });
  const id = otherLedger.addEvidence({ taskId: otherTask, kind: 'structural', establishes: ['architecture_mapped'],
    source: { provider: 'native.rg', capability: 'code.impact-analysis' } });
  const unbound = engine.evaluateReadiness({ taskId: otherTask, taskClass: 'refactor' }, otherLedger, claims);
  const requirement = unbound.requirements.find((item: any) => item.id === 'architecture_mapped');
  assert.equal(requirement.satisfied, false);
  assert.equal(requirement.reasonCode, 'unbound-retrieval-evidence');
  assert.equal(requirement.reason, `1 item(s) of the right kind are not bound to a declared need of plan rp_test_5678 (${id}), so they do not count. Re-record them with --need <intent>; declared: estimate-blast-radius.`);
  assert.deepEqual(unbound.unboundEvidence, { count: 1, ids: [id] });
});

test('an unbound observation with a failing exit does not qualify as retrieval evidence', (t) => {
  const root = tempDir(t, 'doflow-readiness-unbound-observation-');
  const taskId = 't-unbound-observation';
  updatePlan(root, taskId, null, () => ({ taskId, planId: 'rp_test_9012', needs: [
    { intent: 'run-baseline', queryRef: 'rp_test_9012#run-baseline', capability: 'code.exact-search' },
  ] }));
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: root, templates: {
    custom: { name: 'Custom', requirements: { baseline_tests: {
      description: 'Tests passed', required: true, evidenceKinds: ['test-result'],
      requiresObservation: true, expectedExit: 'zero',
    } } },
  } });
  const ledger: any = new EvidenceLedger({ repoRoot: root });
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  ledger.addEvidence({ taskId, kind: 'test-result', provenance: 'extracted', establishes: ['baseline_tests'],
    observation: { command: 'npm test', exitCode: 1 },
    source: { provider: 'native.rg', capability: 'code.exact-search' },
    freshness: { status: 'FRESH' } });

  const report = engine.evaluateReadiness({ taskId, taskClass: 'custom' }, ledger, claims);
  const requirement = report.requirements.find((item: any) => item.id === 'baseline_tests');
  assert.equal(requirement.satisfied, false);
  assert.equal(requirement.reasonCode, null);
});

test('legacy retrieval plans keep unbound evidence eligible and expose null reason codes', (t) => {
  const root = tempDir(t, 'doflow-readiness-legacy-');
  const taskId = 't-legacy-readiness';
  updatePlan(root, taskId, null, () => ({ taskId, needs: [{ intent: 'estimate-blast-radius', capability: 'code.impact-analysis' }] }));
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: root });
  const ledger: any = new EvidenceLedger({ repoRoot: root });
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  ledger.addEvidence({ taskId, kind: 'structural', establishes: ['architecture_mapped'],
    source: { provider: 'native.rg', capability: 'code.impact-analysis' } });

  const report = engine.evaluateReadiness({ taskId, taskClass: 'refactor' }, ledger, claims);
  const requirement = report.requirements.find((item: any) => item.id === 'architecture_mapped');
  assert.equal(requirement.satisfied, true);
  assert.equal(requirement.reasonCode, null);
  assert.equal(Object.hasOwn(report, 'unboundEvidence'), false);
});

test('FR-005: resolvable evidence leaves the verdict untouched', () => {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

  ledger.addEvidence({
    taskId: 'task_resolvable',
    kind: 'structural',
    provenance: 'extracted',
    locator: { file: 'src/runtime/readiness.ts', line: 1 },
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
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });

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
  const calls: any = [];
  const mockGit = (args: any) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return ' M src/runtime/cli.ts';
    if (args[0] === 'rev-parse') return 'commit_shared';
    if (args[0] === 'diff') return 'src/runtime/cli.ts';
    return '';
  };
  const validator: any = new FreshnessValidator({ gitRunner: mockGit });
  const ledger: any = new EvidenceLedger();

  // Five items, one recorded commit — the shape a stage batch actually produces.
  for (let i = 0; i < 5; i += 1) {
    ledger.addEvidence({
      taskId: 't_memo',
      kind: 'exact-search',
      provenance: 'extracted',
      locator: { file: 'src/runtime/cli.ts' },
      content: `item ${i}`,
    });
  }
  for (const item of ledger.getAllEvidence()) item.freshness.gitCommit = 'commit_shared';

  validator.validateLedgerFreshness(ledger);

  const diffCalls = calls.filter((c: any) => c.startsWith('diff'));
  assert.equal(diffCalls.length, 1,
    `five items on one commit should cost one diff, not ${diffCalls.length}`);
});

test('FR-003: distinct recorded commits each get their own diff', () => {
  const calls: any = [];
  const mockGit = (args: any) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return '';
    if (args[0] === 'diff') return 'src/runtime/cli.ts';
    return '';
  };
  const validator: any = new FreshnessValidator({ gitRunner: mockGit });
  const ledger: any = new EvidenceLedger();
  for (const sha of ['sha_a', 'sha_b', 'sha_a']) {
    const id = ledger.addEvidence({
      taskId: 't_memo2',
      kind: 'exact-search',
      provenance: 'extracted',
      locator: { file: 'src/runtime/cli.ts' },
      content: 'x',
    });
    ledger.getEvidence(id).freshness.gitCommit = sha;
  }

  validator.validateLedgerFreshness(ledger);

  const diffCalls = calls.filter((c: any) => c.startsWith('diff'));
  assert.equal(diffCalls.length, 2, 'two distinct commits, two diffs — the repeat is memoised');
});

// ── IC-010: every `readiness` call records its evaluation ──────────────────────────────────────

const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

function readinessCli(t: any, args: any) {
  const scratch = createScratch('doflow-readiness-cli-');
  t.after(() => {
    // The write-failure case makes the state directory read-only; give it back so it can be removed.
    try { fs.chmodSync(path.join(scratch.dir, 'p', '.doflow', 'state'), 0o755); } catch { /* not created by this case */ }
    scratch.remove();
  });
  const cwd = path.join(scratch.dir, 'p');
  fs.mkdirSync(cwd);
  const run = (extra: any = []) => spawnSync('node', [DOFLOW, 'readiness', '--task-class', 'trivial-edit', '--task-id', 'T-1', ...args, ...extra], {
    cwd, env: scratch.env(), encoding: 'utf8',
  });
  return { cwd, run };
}

test('readiness records its evaluation under the state root and names the file after Summary', (t) => {
  const { cwd, run } = readinessCli(t, ['--scope', 'src/a.js,src/lib/']);
  const res = run();
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n');
  const at = lines.findIndex((l: any) => l.startsWith('Summary:'));
  assert.equal(lines[at + 1], `Recorded:      ${path.join('.doflow', 'state', 'readiness', 'T-1.json')}`);
  assert.equal(lines[at + 2], 'Declared scope: src/a.js, src/lib/');
  const record = JSON.parse(fs.readFileSync(path.join(cwd, '.doflow', 'state', 'readiness', 'T-1.json'), 'utf8'));
  assert.equal(record.state, 'NEEDS_EVIDENCE');
  assert.equal(record.taskClass, 'trivial-edit');
  assert.deepEqual(record.inputs, { scope: 'src/a.js,src/lib/' });
  assert.deepEqual(record.declaredScope, ['src/a.js', 'src/lib/']);
});

test('a scope that is not a path list is recorded as a statement and says it bounds nothing', (t) => {
  const { cwd, run } = readinessCli(t, ['--scope', 'only the parser module']);
  const res = run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\nScope: {9}stated as text, not a path list; verify does not bound a change by it\n/);
  const record = JSON.parse(fs.readFileSync(path.join(cwd, '.doflow', 'state', 'readiness', 'T-1.json'), 'utf8'));
  assert.deepEqual(record.inputs, { scope: 'only the parser module' });
  assert.equal(record.declaredScope, null);
});

test('readiness --json carries the record and the declared scope; no scope prints no scope line', (t) => {
  const { cwd, run } = readinessCli(t, []);
  const json: any = run(['--json']);
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.deepEqual(data.record, { file: path.join(fs.realpathSync(cwd), '.doflow', 'state', 'readiness', 'T-1.json'), written: true });
  assert.equal(data.declaredScope, null);
  const human = run();
  assert.doesNotMatch(human.stdout, /Declared scope:|\nScope: /);
});

test('a state directory that cannot be written: the evaluation prints, the failure is named, exit 1', { skip: process.platform === 'win32' ? 'a chmod cannot make a directory unwritable on win32' : process.getuid && process.getuid() === 0 ? 'root ignores permissions' : false }, (t) => {
  const { cwd, run } = readinessCli(t, []);
  fs.mkdirSync(path.join(cwd, '.doflow', 'state'), { recursive: true });
  fs.chmodSync(path.join(cwd, '.doflow', 'state'), 0o555);
  const res = run();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /Overall State:/, 'the evaluation still prints');
  assert.doesNotMatch(res.stdout, /Recorded:/);
  assert.match(res.stderr, /^\[ERROR\] readiness: the evaluation was not recorded: /m);
  const json: any = run(['--json']);
  assert.equal(json.status, 1);
  const data = JSON.parse(json.stdout);
  assert.equal(data.record.written, false);
  assert.match(data.record.error, /EACCES|permission/i);
});

test('readiness replaces an unreadable record and says so; a record from a newer DoFlow stops it with exit 1', (t) => {
  const { cwd, run } = readinessCli(t, []);
  const file = path.join(cwd, '.doflow', 'state', 'readiness', 'T-1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  const replaced = run();
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.ok(replaced.stdout.includes(`Replaced:      the previous record could not be read; its bytes are kept in ${path.join('.doflow', 'state', 'readiness', 'T-1.json.unreadable')}\n`), replaced.stdout);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), 'not json');

  fs.writeFileSync(file, '{"version":2}');
  const newer = run();
  assert.equal(newer.status, 1);
  assert.match(newer.stderr, /\[ERROR\] readiness: the evaluation was not recorded: /);
  assert.ok(newer.stderr.includes(`${file} was written by a newer DoFlow (record version 2; this runtime reads 1)`), newer.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":2}');
});

test('an unreadable retrieval plan is warned about and treated as absent by readiness', (t) => {
  const { cwd, run } = readinessCli(t, []);
  const planFile = require('../../src/runtime/retrieval-record.ts').planPath(cwd, 'T-1');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });

  for (const contents of ['{bad', '{"version":2}']) {
    fs.writeFileSync(planFile, contents);
    const res: any = run(['--json']);
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.state, 'NEEDS_EVIDENCE');
    assert.equal(report.retrievalPlan.unreadable, true);
    assert.match(report.retrievalPlan.reason, /Failed to load state file|schema version 2/);
    assert.match(report.summary, /Warning: retrieval plan is unreadable and was treated as absent/);
  }
});

test('stale absences from a replaced retrieval plan are not reported as current', (t) => {
  const root = tempDir(t, 'doflow-readiness-replaced-plan-');
  const taskId = 't-replaced-plan';
  updatePlan(root, taskId, null, () => ({ taskId, planId: 'rp_current', needs: [
    { intent: 'estimate-blast-radius', queryRef: 'rp_current#estimate-blast-radius', capability: 'code.impact-analysis' },
  ] }));
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: root });
  const ledger: any = new EvidenceLedger({ repoRoot: root });
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  ledger.addEvidence({ taskId, kind: 'structural', result: 'EMPTY', establishes: ['architecture_mapped'],
    source: { provider: 'native.rg', capability: 'code.impact-analysis', queryRef: 'rp_replaced#estimate-blast-radius' },
    freshness: { status: 'STALE' } });

  const report = engine.evaluateReadiness({ taskId, taskClass: 'refactor' }, ledger, claims);
  assert.deepEqual(report.staleAbsence, []);
});

test('stale absence guidance distinguishes tree changes, unverifiable trees, and non-git records', (t) => {
  const root = tempDir(t, 'doflow-readiness-absence-guidance-');
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: root });
  for (const [index, [freshness, expected]] of ([
    [{ status: 'STALE', staleReason: 'tree-changed-since-recorded', gitCommit: 'commit_test' }, 'the working tree changed since it was recorded; re-run the lookup and record the absence again'],
    [{ status: 'UNKNOWN', staleReason: 'tree-unverifiable', gitCommit: 'commit_test' }, 'the working tree changed since it was recorded; re-run the lookup and record the absence again'],
    [{ status: 'UNKNOWN', gitCommit: null }, 'absence cannot be established outside a git work tree; record a positive item'],
  ] as any[]).entries()) {
    const ledger: any = new EvidenceLedger({ repoRoot: root });
    const claims: any = new ClaimsManager({ evidenceLedger: ledger });
    const taskId = `t-guidance-${index}`;
    const id = ledger.addEvidence({ taskId, kind: 'structural', result: 'EMPTY', establishes: ['architecture_mapped'],
      source: { provider: 'native.rg', capability: 'code.impact-analysis' }, freshness });
    if (freshness.staleReason) ledger.getEvidence(id).freshness.staleReason = freshness.staleReason;
    const report = engine.evaluateReadiness({ taskId, taskClass: 'refactor' }, ledger, claims);
    assert.match(report.requirements.find((item: any) => item.id === 'architecture_mapped').reason, new RegExp(expected));
  }
});

test('unbound evidence guidance counts only qualifying items', (t) => {
  const root = tempDir(t, 'doflow-readiness-unbound-count-');
  const taskId = 't-unbound-count';
  updatePlan(root, taskId, null, () => ({ taskId, planId: 'rp_count', needs: [
    { intent: 'estimate-blast-radius', queryRef: 'rp_count#estimate-blast-radius', capability: 'code.impact-analysis' },
  ] }));
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: root });
  const ledger: any = new EvidenceLedger({ repoRoot: root });
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  const qualifyingId = ledger.addEvidence({ taskId, kind: 'structural', provenance: 'extracted', establishes: ['architecture_mapped'],
    source: { provider: 'native.rg', capability: 'code.impact-analysis' }, freshness: { status: 'FRESH' } });
  ledger.addEvidence({ taskId, kind: 'exact-search', provenance: 'extracted', establishes: ['target_identified'],
    source: { provider: 'native.rg', capability: 'code.impact-analysis' }, freshness: { status: 'FRESH' } });

  const report = engine.evaluateReadiness({ taskId, taskClass: 'refactor' }, ledger, claims);
  const reason = report.requirements.find((item: any) => item.id === 'architecture_mapped').reason;
  assert.match(reason, new RegExp(`^1 item\\(s\\).*\\(${qualifyingId}\\)`));
});

// ── FU-h6671a: a superseded item is retired from the unresolvable check too ──────────────────
//
// Evidence recorded from a linked worktree for a file that exists only on the branch cannot be
// read from the checkout the records resolve against. Superseding it retires it from the stale
// check; the unresolvable check must honour the same retirement, or nothing can clear it.

function readyLedger(taskId: any) {
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  const freshId = ledger.addEvidence({
    taskId, kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/readiness.ts', line: 1 }, content: 'use strict',
    establishes: ['affected_components'],
  });
  return { ledger, claims, freshId };
}
const READY_INPUT = (taskId: any) => ({ taskId, taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' });

test('FU-h6671a: a superseded item with an unresolvable locator does not keep the gate off READY', () => {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const { ledger, claims, freshId } = readyLedger('task_superseded_unresolvable');
  const goneId = ledger.addEvidence({
    taskId: 'task_superseded_unresolvable', kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/branch-only-file.ts', line: 1 }, content: 'recorded from a worktree',
  });

  const before = engine.evaluateReadiness(READY_INPUT('task_superseded_unresolvable'), ledger, claims);
  assert.equal(before.state, 'NEEDS_EVIDENCE');
  assert.equal(before.unresolvableEvidence.length, 1);

  ledger.supersedeEvidence(goneId, freshId);
  const after = engine.evaluateReadiness(READY_INPUT('task_superseded_unresolvable'), ledger, claims);
  assert.deepEqual(after.unresolvableEvidence, []);
  assert.equal(after.state, 'READY');
});

test('FU-h6671a control: an unresolvable item that is NOT superseded still keeps the gate off READY', () => {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const { ledger, claims, freshId } = readyLedger('task_unresolvable_active');
  const goneId = ledger.addEvidence({
    taskId: 'task_unresolvable_active', kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/branch-only-file.ts', line: 1 }, content: 'x',
  });
  const otherId = ledger.addEvidence({
    taskId: 'task_unresolvable_active', kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/claims.ts', line: 1 }, content: 'y',
  });
  // Superseding a DIFFERENT item must not retire this one.
  ledger.supersedeEvidence(otherId, freshId);
  const report = engine.evaluateReadiness(READY_INPUT('task_unresolvable_active'), ledger, claims);
  assert.equal(report.state, 'NEEDS_EVIDENCE');
  assert.deepEqual(report.unresolvableEvidence.map((item: any) => item.evidenceId), [goneId]);
});

test('FU-h6671a control: a superseded item never satisfies a requirement', () => {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  const retired = ledger.addEvidence({
    taskId: 'task_superseded_alone', kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/readiness.ts', line: 1 }, content: 'retired fact',
    establishes: ['affected_components'],
  });
  const replacement = ledger.addEvidence({
    taskId: 'task_superseded_alone', kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/claims.ts', line: 1 }, content: 'replacement without establishes',
  });
  ledger.supersedeEvidence(retired, replacement);
  const report = engine.evaluateReadiness(READY_INPUT('task_superseded_alone'), ledger, claims);
  const requirement = report.requirements.find((r: any) => r.id === 'affected_components');
  assert.equal(requirement.satisfied, false, 'the retired item no longer proves affected_components');
  assert.notEqual(report.state, 'READY');
});

// ── 107-B review C-1: a claim counts only while a live item supports it ──────────────────────
//
// The claim branch of the gate read `taskClaims` and never `taskEvidence`, so a root-cause claim
// whose only support had been superseded kept the bug template READY once the superseded item
// stopped blocking through the unresolvable check.

function bugLedger(taskId: any) {
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  const reproduction = ledger.addEvidence({
    taskId, kind: 'runtime-observation', content: 'Observed HTTP 504', establishes: ['reproduction'],
    observation: { command: 'curl -sf http://localhost:8080/pay', exitCode: 22 },
  });
  const affected = ledger.addEvidence({
    taskId, kind: 'exact-search', locator: { file: 'src/runtime/readiness.ts', lineRange: [45, 60] },
    content: 'function processPayment()', establishes: ['affected_code'],
  });
  const blast = ledger.addEvidence({
    taskId, kind: 'structural', locator: { file: 'src/runtime/claims.ts' },
    content: 'CheckoutController -> PaymentService', establishes: ['blast_radius'],
  });
  return { ledger, claims, reproduction, affected, blast };
}
const BUG_INPUT = (taskId: any) => ({ taskId, taskClass: 'bug', verificationPlan: 'node --test test/payment.test.js' });

test('107-B C-1: a root-cause claim supported only by superseded evidence does not satisfy the bug template', () => {
  const taskId = 'task_c1_superseded_support';
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const { ledger, claims, affected } = bugLedger(taskId);
  const gone = ledger.addEvidence({
    taskId, kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/branch-only-file.ts', line: 1 }, content: 'recorded from a worktree',
  });
  const claimId = claims.addClaim({ taskId, statement: 'Missing keepalive', role: 'root-cause' });
  claims.linkEvidence(claimId, gone, 'supports');
  const before = engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims);
  assert.equal(before.state, 'NEEDS_EVIDENCE', 'unresolvable live support blocks before supersede');
  assert.equal(before.unresolvableEvidence.length, 1);

  ledger.supersedeEvidence(gone, affected);
  const report = engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims);
  const rootCause = report.requirements.find((r: any) => r.id === 'root_cause');
  assert.equal(rootCause.satisfied, false, 'a retired item no longer supports the claim');
  assert.equal(report.state, 'NEEDS_EVIDENCE');
  assert.ok(!(report.satisfiedRequirements || []).some((r: any) => (r.id || r) === 'root_cause'));
});

test('107-B C-1 control: a claim supported by live evidence still gives READY', () => {
  const taskId = 'task_c1_live_support';
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const { ledger, claims, affected } = bugLedger(taskId);
  const claimId = claims.addClaim({ taskId, statement: 'Missing keepalive', role: 'root-cause' });
  claims.linkEvidence(claimId, affected, 'supports');
  const report = engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims);
  assert.equal(report.state, 'READY');
});

test('107-B C-1 control: linking a valid replacement to the claim restores READY', () => {
  const taskId = 'task_c1_replacement_linked';
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const { ledger, claims, affected } = bugLedger(taskId);
  const gone = ledger.addEvidence({
    taskId, kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/branch-only-file.ts', line: 1 }, content: 'recorded from a worktree',
  });
  const claimId = claims.addClaim({ taskId, statement: 'Missing keepalive', role: 'root-cause' });
  claims.linkEvidence(claimId, gone, 'supports');
  ledger.supersedeEvidence(gone, affected);
  assert.equal(engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims).state, 'NEEDS_EVIDENCE');
  claims.linkEvidence(claimId, affected, 'supports');
  assert.equal(engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims).state, 'READY');
});

// ── 107-B re-review N-a: each half of the C-1 live-support condition has its own test ─────────
//
// The C-1 fix counts a supported claim only while one supporting id is in `taskEvidence`: active,
// FRESH and bound to the task's plan. Swapping that set for "any non-superseded item" kept every
// earlier test green, so the FRESH and bound halves each get a case that goes red without them.

test('107-B N-a: a root-cause claim whose valid-file support was superseded does not satisfy root_cause', () => {
  const taskId = 'task_na_valid_superseded';
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const { ledger, claims, affected } = bugLedger(taskId);
  const support = ledger.addEvidence({
    taskId, kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/claims.ts', line: 1 }, content: 'class ClaimsManager',
  });
  const claimId = claims.addClaim({ taskId, statement: 'Missing keepalive', role: 'root-cause' });
  claims.linkEvidence(claimId, support, 'supports');
  assert.equal(engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims).state, 'READY',
    'a valid live file supports the claim before it is superseded');

  ledger.supersedeEvidence(support, affected);
  const report = engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims);
  assert.equal(claims.getClaim(claimId).status, 'supported', 'the stored claim status still reads supported');
  assert.equal(report.requirements.find((r: any) => r.id === 'root_cause').satisfied, false);
  assert.equal(report.state, 'NEEDS_EVIDENCE');
});

test('107-B N-a: a supported claim whose only support went STALE does not satisfy root_cause', () => {
  const taskId = 'task_na_stale_support';
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const { ledger, claims } = bugLedger(taskId);
  const support = ledger.addEvidence({
    taskId, kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/branch-only-target.ts', line: 1 }, content: 'recorded before an edit',
  });
  const claimId = claims.addClaim({ taskId, statement: 'Missing keepalive', role: 'root-cause' });
  claims.linkEvidence(claimId, support, 'supports');
  // The file changes after the claim was evaluated: the item is STALE, the stored claim status is
  // still the `supported` it was given while its support was fresh.
  assert.equal(ledger.invalidateFiles(['src/runtime/branch-only-target.ts']), 1);
  assert.equal(claims.getClaim(claimId).status, 'supported');
  const report = engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims);
  assert.equal(report.requirements.find((r: any) => r.id === 'root_cause').satisfied, false,
    'stale support no longer backs the claim');
  assert.notEqual(report.state, 'READY');
});

test('107-B N-a: a supported claim whose only support is unbound to the task plan does not satisfy root_cause', (t) => {
  const root = tempDir(t, 'doflow-readiness-na-unbound-');
  const taskId = 'task_na_unbound_support';
  updatePlan(root, taskId, null, () => ({ taskId, planId: 'rp_na_1', needs: [
    { intent: 'estimate-blast-radius', queryRef: 'rp_na_1#estimate-blast-radius', capability: 'code.impact-analysis' },
  ] }));
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: root });
  const run = (queryRef: any) => {
    const ledger: any = new EvidenceLedger({ repoRoot: root });
    const claims: any = new ClaimsManager({ evidenceLedger: ledger });
    const support = ledger.addEvidence({ taskId, kind: 'structural', content: 'CheckoutController -> PaymentService',
      source: { provider: 'native.rg', capability: 'code.impact-analysis', queryRef } });
    const claimId = claims.addClaim({ taskId, statement: 'Missing keepalive', role: 'root-cause' });
    claims.linkEvidence(claimId, support, 'supports');
    assert.equal(claims.getClaim(claimId).status, 'supported');
    return engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims).requirements.find((r: any) => r.id === 'root_cause');
  };
  assert.equal(run('rp_old_0#estimate-blast-radius').satisfied, false, 'support recorded under a replaced plan does not count');
  assert.equal(run('rp_na_1#estimate-blast-radius').satisfied, true, 'support bound to a declared need still counts');
});

test('107-B N-b: a supported claim whose evidence was retired says so, with a reason code', () => {
  const taskId = 'task_nb_retired_reason';
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const { ledger, claims, affected } = bugLedger(taskId);
  const support = ledger.addEvidence({
    taskId, kind: 'structural', provenance: 'extracted',
    locator: { file: 'src/runtime/claims.ts', line: 1 }, content: 'class ClaimsManager',
  });
  const claimId = claims.addClaim({ taskId, statement: 'Missing keepalive', role: 'root-cause' });
  claims.linkEvidence(claimId, support, 'supports');
  ledger.supersedeEvidence(support, affected);
  const rootCause = engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims)
    .requirements.find((r: any) => r.id === 'root_cause');
  assert.equal(rootCause.satisfied, false);
  assert.equal(rootCause.reasonCode, 'claim-support-retired');
  assert.equal(rootCause.reason, `1 claim(s) with status 'supported' and role 'root-cause' have no live supporting `
    + `evidence (${claimId}): each supporting item was superseded, went stale or is not bound to the task plan. `
    + 'Link a fresh item with `claim --action link` and re-evaluate.');
});

test('107-B N-b control: a task with no supported claim keeps the plain reason and no code', () => {
  const taskId = 'task_nb_no_claim';
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const { ledger, claims } = bugLedger(taskId);
  const rootCause = engine.evaluateReadiness(BUG_INPUT(taskId), ledger, claims)
    .requirements.find((r: any) => r.id === 'root_cause');
  assert.equal(rootCause.reasonCode, null);
  assert.equal(rootCause.reason, "Requires at least one claim with status 'supported' and role 'root-cause'.");
});

// ── FU-afkns5: an unmet scope/invariants action names the flag that supplies it ──────────────
//
// `scope_clear`, `scope_verified` and `invariants_captured` are satisfied only by what the caller
// states (`--scope`, `--invariants`), yet their recommended action fell to the generic "Gather
// evidence", which names no flag a caller could pass.

function unmetAction(taskClass: any, reqId: any, profile: any = {}) {
  const engine: any = new ReadinessEngine({ repoRoot: REPO });
  const ledger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  const report = engine.evaluateReadiness({ taskId: `t-afkns5-${reqId}`, taskClass, ...profile }, ledger, claims);
  const requirement = report.requirements.find((item: any) => item.id === reqId);
  assert.equal(requirement.satisfied, false);
  return requirement.recommendedAction;
}

test('FU-afkns5: an unmet scope_clear action names --scope', () => {
  const action = unmetAction('feature', 'scope_clear', { verificationPlan: 'npm test' });
  assert.match(action.action, /--scope\b/);
  assert.doesNotMatch(action.action, /--invariants\b/);
});

test('FU-afkns5: an unmet scope_verified action names --scope', () => {
  assert.match(unmetAction('trivial-edit', 'scope_verified').action, /--scope\b/);
});

test('FU-afkns5: an unmet invariants_captured action names --invariants', () => {
  const action = unmetAction('refactor', 'invariants_captured');
  assert.match(action.action, /--invariants\b/);
  assert.doesNotMatch(action.action, /--scope\b/);
});

test('FU-afkns5 control: a requirement with no stated-input flag keeps the generic action', () => {
  const action = unmetAction('refactor', 'architecture_mapped');
  assert.doesNotMatch(action.action, /--scope\b|--invariants\b/);
});

// ── FU-tgrfdv: a relative locator resolves in the checkout the verb runs in ──────────────────
//
// In a linked worktree the records live in the main checkout (projectRoot) and the files live in
// the worktree (sourceRoot). The unresolvable check resolved a relative locator against
// projectRoot only, so evidence for a branch-only file was reported as `file-missing`.

function stateAndSource(t: any) {
  const state = tempDir(t, 'doflow-readiness-state-');
  const source = tempDir(t, 'doflow-readiness-source-');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'src', 'branch-only.ts'), 'export const x = 1;\n');
  return { state, source };
}

test('FU-tgrfdv: the engine resolves a relative locator against sourceRoot', (t) => {
  const { state, source } = stateAndSource(t);
  const taskId = 't-tgrfdv-engine';
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: state, sourceRoot: source });
  const ledger: any = new EvidenceLedger({ repoRoot: state });
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  ledger.addEvidence({ taskId, kind: 'structural', provenance: 'extracted', establishes: ['affected_components'],
    locator: { file: 'src/branch-only.ts', line: 1 }, content: 'recorded in the worktree', freshness: { status: 'FRESH' } });
  const report = engine.evaluateReadiness({ taskId, taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' }, ledger, claims);
  assert.deepEqual(report.unresolvableEvidence, []);
  assert.equal(report.state, 'READY');
});

test('FU-tgrfdv control: a locator missing from sourceRoot is still unresolvable', (t) => {
  const { state, source } = stateAndSource(t);
  fs.mkdirSync(path.join(state, 'src'), { recursive: true });
  fs.writeFileSync(path.join(state, 'src', 'state-only.ts'), 'export const y = 2;\n');
  const taskId = 't-tgrfdv-control';
  const engine: any = new ReadinessEngine({ repoRoot: REPO, projectRoot: state, sourceRoot: source });
  const ledger: any = new EvidenceLedger({ repoRoot: state });
  const claims: any = new ClaimsManager({ evidenceLedger: ledger });
  ledger.addEvidence({ taskId, kind: 'structural', provenance: 'extracted', establishes: ['affected_components'],
    locator: { file: 'src/state-only.ts', line: 1 }, content: 'only in the store checkout', freshness: { status: 'FRESH' } });
  const report = engine.evaluateReadiness({ taskId, taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' }, ledger, claims);
  assert.equal(report.unresolvableEvidence.length, 1);
  assert.equal(report.unresolvableEvidence[0].reason, 'file-missing');
  assert.equal(report.state, 'NEEDS_EVIDENCE');
});

test('FU-tgrfdv: evaluateTaskReadiness passes sourceRoot to the engine', (t) => {
  const { evaluateTaskReadiness } = require('../../src/runtime/readiness.ts');
  const { state, source } = stateAndSource(t);
  const taskId = 't-tgrfdv-wiring';
  const ledger: any = new EvidenceLedger({ repoRoot: state });
  ledger.addEvidence({ taskId, kind: 'structural', provenance: 'extracted', establishes: ['affected_components'],
    locator: { file: 'src/branch-only.ts', line: 1 }, content: 'recorded in the worktree',
    freshness: { status: 'FRESH', fileHash: require('../../src/runtime/freshness.ts').measureFreshness(source, { file: 'src/branch-only.ts', line: 1 }, null, source).fileHash } });
  ledger.save(taskId);
  const report = evaluateTaskReadiness({
    taskProfile: { taskId, taskClass: 'feature', scopeClear: 'stated', verificationPlan: 'npm test' },
    repoRoot: REPO, projectRoot: state, treeRoot: source, sourceRoot: source,
  });
  assert.deepEqual(report.unresolvableEvidence, []);
  assert.deepEqual(report.staleEvidence, []);
  assert.equal(report.state, 'READY');
});
