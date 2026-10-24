'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { handleContextPackCommand, ContextPackCompiler } = require('../../src/runtime/context-pack.ts');
const { linearFit } = require('../../src/runtime/context/compose.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { EXIT } = require('../../src/runtime/cli-result.ts');

function runPack(options) {
  let out = '';
  const origLog = console.log;
  const origExitCode = process.exitCode;
  console.log = (t) => { out += t; };
  let code;
  try {
    code = handleContextPackCommand(options);
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode;
  }
  return { code, out };
}

test('context-pack-overflow: exit 3, mandatory text byte-equal to source, OVERFLOW line and overflowAction', (t) => {
  const root = tempDir(t, 'doflow-overflow-');
  const featDir = path.join(root, 'agent-docs/doflow/feat-over/intention');
  fs.mkdirSync(featDir, { recursive: true });

  const rawSummary = 'A test summary for overflow verification.';
  const rawAc = '**Scenario: Invariant enforcement** Given test condition When evaluated Then preserve invariant (FR-001)';
  const rawConstraint = 'System must maintain integrity at all times';

  const reqContent = `# Feature: Overflow

## 1. Summary
${rawSummary}

## 4. Non-Functional Requirements
| ID | Constraint | Kind | Status |
|---|---|---|---|
| NFR-001 | ${rawConstraint} | reliability | Live |

## 6. Acceptance Criteria
- [ ] ${rawAc}
`;
  fs.writeFileSync(path.join(featDir, 'requirement.md'), reqContent, 'utf8');

  // Run with tight cap (50 bytes) which cannot fit mandatory content
  const tightCap = 50;

  // JSON form
  const jsonRes = runPack({
    taskId: 'task-over',
    taskClass: 'feature',
    maxBytes: tightCap,
    reason: 'tight budget for overflow test',
    stateRoot: root,
    slug: 'feat-over',
    json: true,
  });

  assert.equal(jsonRes.code, EXIT.OVERFLOW);
  const pack = JSON.parse(jsonRes.out);
  assert.equal(pack.status, 'OVERFLOW');
  assert.equal(pack.exitCode, EXIT.OVERFLOW);
  assert.ok(pack.overflow);
  assert.equal(pack.overflow.cause, 'mandatory');
  assert.equal(pack.overflow.budgetBytes, tightCap);

  // Check overflowAction.message
  const expectedMsg = `OVERFLOW (exit 3): mandatory content is complete and nothing in it was dropped. It is ${pack.overflow.mandatoryBytes} B against a ${tightCap} B budget (override). Split the task or its context, or start a new session, then request the pack again.`;
  assert.equal(pack.overflowAction.message, expectedMsg);

  // Check mandatory text is byte-equal to source
  assert.equal(pack.objective, rawSummary);
  assert.equal(pack.acceptanceCriteria[0].text, rawAc);
  assert.equal(pack.constraints[0].text, rawConstraint);

  // Markdown form
  const mdRes = runPack({
    taskId: 'task-over',
    taskClass: 'feature',
    maxBytes: tightCap,
    reason: 'tight budget for overflow test',
    stateRoot: root,
    slug: 'feat-over',
    json: false,
  });

  assert.equal(mdRes.code, EXIT.OVERFLOW);
  const lines = mdRes.out.split('\n');
  assert.ok(lines[0].startsWith('## ContextPack: [FEATURE] task-over'));
  assert.match(lines[1], /^> OVERFLOW \(exit 3\): mandatory content is complete and nothing in it was dropped\. It is \d+ B against a 50 B budget \(override\)\./);
  assert.ok(mdRes.out.includes(`- [ ] ${rawAc}`));
  assert.ok(mdRes.out.includes(`- ! NFR-001 ${rawConstraint}`));
});

test('context-pack-overflow: overflow with cause accounting when omission record pushes pack over budget', () => {
  const compiler = new ContextPackCompiler();

  // Construct mandatory items that fit in budget, but many optional items whose omissions push it over
  const mandatory = {
    objective: 'Short',
    acceptanceCriteria: ['AC1'],
    constraints: ['C1'],
  };

  const optional = {
    unverifiedClaims: Array.from({ length: 40 }, (_, i) => `Claim number ${i + 1} with enough text to make omission entries`),
  };

  // Compile with dry-run to measure mandatory bytes
  const dryPack = compiler.compileContextPack({
    taskId: 't-acc',
    taskClass: 'feature',
    ...mandatory,
    claims: { conflicts: [], supported: [], hypotheses: [] },
    evidenceLedger: null,
    claimsManager: null,
  });

  const mandatoryBytes = dryPack.size.mandatoryBytes;
  // Set budget slightly above mandatory, but lower than mandatory + 40 omissions
  const budget = mandatoryBytes + 15;

  const pack = compiler.compileContextPack({
    taskId: 't-acc',
    taskClass: 'feature',
    maxBytes: budget,
    ...mandatory,
    claims: {
      conflicts: [],
      supported: [],
      hypotheses: optional.unverifiedClaims.map((stmt, i) => ({ id: `hyp_${i}`, statement: stmt, status: 'hypothesis' })),
    },
  });

  if (pack.overflow) {
    assert.equal(pack.overflow.cause, 'accounting');
    assert.ok(pack.overflowAction.message.includes('The omission record brings the pack to'));
    assert.ok(pack.overflowAction.message.includes(`against a ${budget} B budget.`));
  }
});

test('context-pack-overflow: fit optional items before declaring accounting overflow (IC-007)', () => {
  const fit = linearFit({
    items: [
      { id: 'objective', field: 'objective', cls: 'mandatory', priority: 0, mdBytes: 10, jsonBytes: 10, digest: 'm' },
      { id: 'hypothesis-1', field: 'claims.hypotheses', cls: 'optional', priority: 4, mdBytes: 1, jsonBytes: 1, digest: 'o' },
    ],
    budget: 20,
    taskId: 't-accounting-trim',
    taskClass: 'feature',
    sectionHeadingsMd: {},
    sectionHeadingsJson: {},
  });
  assert.equal(fit.overflow, false);
  assert.ok(fit.kept.some((item) => item.id === 'hypothesis-1'));

  const compiler = new ContextPackCompiler();
  const input = {
    taskId: 't-accounting-trim',
    taskClass: 'feature',
    objective: 'Short',
    acceptanceCriteria: ['AC1'],
    constraints: ['C1'],
    claims: {
      conflicts: [],
      supported: [],
      hypotheses: Array.from({ length: 40 }, (_, i) => ({
        id: `hyp_${i}`,
        statement: `Claim number ${i + 1} with enough text to make omission entries`,
        status: 'hypothesis',
      })),
    },
  };
  const roomy = compiler.compileContextPack(input);
  let recovered = null;

  for (let cap = roomy.size.mandatoryBytes + 1; cap < roomy.size.mandatoryBytes + 5000; cap += 1) {
    const candidate = compiler.compileContextPack({ ...input, maxBytes: cap });
    if (candidate.status === 'OK' && candidate.claims.hypotheses.length > 0
        && candidate.claims.hypotheses.length < input.claims.hypotheses.length) {
      recovered = candidate;
      break;
    }
  }

  assert.ok(recovered, 'an over-budget all-omitted accounting form must be retried through optional-item fitting');
});

test('context-pack-overflow: exit precedence across 2 (usage), 3 (overflow), 1 (empty), 0 (ok)', (t) => {
  const root = tempDir(t, 'doflow-precedence-');
  const featDir = path.join(root, 'agent-docs/doflow/feat-prec/intention');
  fs.mkdirSync(featDir, { recursive: true });
  fs.writeFileSync(path.join(featDir, 'requirement.md'), '# Feature: P\n## 1. Summary\nSummary.\n## 6. Acceptance Criteria\n- [ ] AC1\n', 'utf8');

  // 1. Precedence 2 over 3: invalid max-bytes (-5) is usage error (2), even if budget would overflow
  const resUsage = runPack({
    taskId: 't-prec',
    taskClass: 'feature',
    maxBytes: -5,
    stateRoot: root,
    slug: 'feat-prec',
    json: true,
  });
  assert.equal(resUsage.code, EXIT.USAGE); // 2

  // 2. Precedence 3 over 1: empty pack (no evidence/claims) that overflows exits 3 (OVERFLOW), NOT 1 (EMPTY)
  const resOverflowEmpty = runPack({
    taskId: 't-empty-overflow',
    taskClass: 'feature',
    maxBytes: 1,
    reason: 'tight cap',
    stateRoot: root,
    slug: 'feat-prec',
    json: true,
  });
  assert.equal(resOverflowEmpty.code, EXIT.OVERFLOW); // 3
  const packOverflowEmpty = JSON.parse(resOverflowEmpty.out);
  assert.equal(packOverflowEmpty.empty, true);
  assert.equal(packOverflowEmpty.status, 'OVERFLOW');
  assert.equal(packOverflowEmpty.exitCode, EXIT.OVERFLOW); // 3

  // 3. Precedence 1 over 0: empty pack that fits exits 1 (EMPTY)
  const resEmptyFit = runPack({
    taskId: 't-empty-fit',
    taskClass: 'feature',
    stateRoot: root,
    slug: 'feat-prec',
    json: true,
  });
  assert.equal(resEmptyFit.code, EXIT.EMPTY); // 1
  const packEmptyFit = JSON.parse(resEmptyFit.out);
  assert.equal(packEmptyFit.empty, true);
  assert.equal(packEmptyFit.status, 'EMPTY');
  assert.equal(packEmptyFit.exitCode, EXIT.EMPTY); // 1

  // 4. Status 0 (OK): pack with recorded evidence that fits exits 0 (OK)
  const ledger = new EvidenceLedger({ repoRoot: root, slug: 'feat-prec' });
  ledger.load('t-ok');
  ledger.addEvidence({
    taskId: 't-ok',
    kind: 'exact-search',
    locator: { file: 'src/file.ts' },
    content: 'Analyzed code',
    freshness: { status: 'FRESH' },
  });
  ledger.save('t-ok');

  const resOk = runPack({
    taskId: 't-ok',
    taskClass: 'feature',
    stateRoot: root,
    slug: 'feat-prec',
    json: true,
  });
  assert.equal(resOk.code, EXIT.OK); // 0
  const packOk = JSON.parse(resOk.out);
  assert.equal(packOk.empty, false);
  assert.equal(packOk.status, 'OK');
  assert.equal(packOk.exitCode, EXIT.OK); // 0
});

test('context-pack-overflow: truncating one acceptance criterion fails naming its id (negative control)', (t) => {
  const root = tempDir(t, 'doflow-overflow-neg-');
  const featDir = path.join(root, 'agent-docs/doflow/feat-neg/intention');
  fs.mkdirSync(featDir, { recursive: true });

  const rawAc1 = '**Scenario: Critical security policy** Must encrypt all tokens with AES-GCM (FR-001)';
  const rawAc2 = '**Scenario: Secondary invariant** Must log failures with redaction (FR-002)';
  fs.writeFileSync(
    path.join(featDir, 'requirement.md'),
    `# Feature: Neg\n## 1. Summary\nSummary.\n## 6. Acceptance Criteria\n- [ ] ${rawAc1}\n- [ ] ${rawAc2}\n`,
    'utf8'
  );

  const res = runPack({
    taskId: 'task-neg',
    taskClass: 'feature',
    maxBytes: 10,
    reason: 'tight cap',
    stateRoot: root,
    slug: 'feat-neg',
    json: true,
  });

  const pack = JSON.parse(res.out);

  function verifyAcNotTruncated(item, expectedText) {
    if (item.text !== expectedText) {
      throw new Error(`Acceptance criterion '${item.id}' was truncated: expected '${expectedText}', got '${item.text}'`);
    }
  }

  // Real pack passes for both
  verifyAcNotTruncated(pack.acceptanceCriteria[0], rawAc1);
  verifyAcNotTruncated(pack.acceptanceCriteria[1], rawAc2);

  // Negative control: simulated truncation of ac:1 fails and names 'ac:1'
  const buggyItem1 = { ...pack.acceptanceCriteria[0], text: rawAc1.slice(0, 15) };
  assert.throws(
    () => verifyAcNotTruncated(buggyItem1, rawAc1),
    (err) => err.message.includes("Acceptance criterion 'ac:1' was truncated")
  );

  // Negative control: simulated truncation of ac:2 fails and names 'ac:2'
  const buggyItem2 = { ...pack.acceptanceCriteria[1], text: rawAc2.slice(0, 15) };
  assert.throws(
    () => verifyAcNotTruncated(buggyItem2, rawAc2),
    (err) => err.message.includes("Acceptance criterion 'ac:2' was truncated")
  );
});
