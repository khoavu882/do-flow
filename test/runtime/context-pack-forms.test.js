'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { handleContextPackCommand } = require('../../src/runtime/context-pack.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { ClaimsManager } = require('../../src/runtime/claims.ts');

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

test('context-pack-forms: every mandatory field appears in both forms and selection is identical', (t) => {
  const root = tempDir(t, 'doflow-forms-test-');
  const featDir = path.join(root, 'agent-docs/doflow/feat-forms/intention');
  fs.mkdirSync(featDir, { recursive: true });

  const reqContent = `# Feature: Forms Parity

## 1. Summary
Form parity verification summary.

## 4. Non-Functional Requirements
| ID | Constraint | Kind | Status |
|---|---|---|---|
| NFR-001 | Constant time verification | performance | Live |

## 5. Out of Scope
- GUI client application

## 6. Acceptance Criteria
- [ ] **Scenario: Parity between forms**
  Given JSON and Markdown outputs
  When compared
  Then all mandatory fields match (FR-001, US1)
- [ ] Plain verification requirement checklist item

## 7. Open Questions
- What is the remote cache invalidation latency?
`;
  fs.writeFileSync(path.join(featDir, 'requirement.md'), reqContent, 'utf8');

  // Add conflicting claim via ClaimsManager
  const ledger = new EvidenceLedger({ repoRoot: root, slug: 'feat-forms' });
  ledger.load('task-forms');
  const ev1Id = ledger.addEvidence({
    taskId: 'task-forms',
    kind: 'runtime-observation',
    locator: { file: 'src/a.ts' },
    content: 'Observed speed 10ms',
  });
  const ev2Id = ledger.addEvidence({
    taskId: 'task-forms',
    kind: 'runtime-observation',
    locator: { file: 'src/b.ts' },
    content: 'Observed speed 200ms',
  });
  ledger.save('task-forms');

  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: root, slug: 'feat-forms' });
  claims.load('task-forms');
  const claimId = claims.addClaim({
    taskId: 'task-forms',
    statement: 'Speed is always 10ms',
    role: 'perf',
  });
  claims.linkEvidence(claimId, ev1Id, 'supports');
  claims.linkEvidence(claimId, ev2Id, 'contradicts');
  claims.evaluateAll();
  claims.save('task-forms');

  // Run JSON form
  const jsonRes = runPack({
    taskId: 'task-forms',
    taskClass: 'feature',
    stateRoot: root,
    slug: 'feat-forms',
    json: true,
  });
  const jsonPack = JSON.parse(jsonRes.out);

  // Run Markdown form
  const mdRes = runPack({
    taskId: 'task-forms',
    taskClass: 'feature',
    stateRoot: root,
    slug: 'feat-forms',
    json: false,
  });
  const mdText = mdRes.out;

  // 1. Check all mandatory fields in JSON
  assert.ok(jsonPack.objective && jsonPack.objective.includes('Form parity verification'));
  assert.equal(jsonPack.acceptanceCriteria.length, 1);
  assert.equal(jsonPack.constraints.length, 1);
  assert.equal(jsonPack.verificationRequirements.length, 1);
  assert.equal(jsonPack.scopeExcluded.length, 1);
  assert.equal(jsonPack.claims.conflicts.length, 1);
  assert.equal(jsonPack.blockingGaps.length, 1);
  assert.ok(jsonPack.mandatory && typeof jsonPack.mandatory === 'object');

  // 2. Check all mandatory fields in Markdown
  assert.ok(mdText.includes('**Objective:** Form parity verification'));
  assert.ok(mdText.includes('### Acceptance Criteria'));
  assert.ok(mdText.includes('Parity between forms'));
  assert.ok(mdText.includes('### Constraints'));
  assert.ok(mdText.includes('NFR-001 Constant time verification'));
  assert.ok(mdText.includes('### Verification Requirements'));
  assert.ok(mdText.includes('Plain verification requirement checklist item'));
  assert.ok(mdText.includes('### Out of Scope'));
  assert.ok(mdText.includes('GUI client application'));
  assert.ok(mdText.includes('### Blocking Conflicts'));
  assert.ok(mdText.includes('CONFLICT Speed is always 10ms'));
  assert.ok(mdText.includes('### Blocking Gaps'));
  assert.ok(mdText.includes('What is the remote cache invalidation latency?'));
  assert.ok(mdText.includes('### Mandatory Sources'));

  // 3. Check identical selection
  assert.equal(jsonPack.acceptanceCriteria[0].id, 'ac:1');
  assert.equal(jsonPack.constraints[0].id, 'NFR-001');
  assert.equal(jsonPack.verificationRequirements[0].id, 'vr:1');
  assert.equal(jsonPack.scopeExcluded[0].id, 'scope:1');
  assert.equal(jsonPack.blockingGaps[0].id, 'gap:1');
  assert.equal(jsonPack.claims.conflicts[0].id, claimId);

  // Positive verification helper
  function verifyMarkdownMandatoryRendered(markdown, fieldName) {
    if (fieldName === 'constraints') {
      if (!markdown.includes('### Constraints') || !markdown.includes('NFR-001')) {
        throw new Error("Mandatory field missing from markdown: constraints");
      }
    }
    if (fieldName === 'conflicts') {
      if (!markdown.includes('### Blocking Conflicts') || !markdown.includes('CONFLICT')) {
        throw new Error("Mandatory field missing from markdown: conflicts");
      }
    }
  }

  // Real markdown passes both
  verifyMarkdownMandatoryRendered(mdText, 'constraints');
  verifyMarkdownMandatoryRendered(mdText, 'conflicts');

  // Negative control 1: removing constraints renderer fails naming constraints
  const buggyNoConstraints = mdText.replace(/### Constraints[\s\S]*?(?=###)/, '');
  assert.throws(
    () => verifyMarkdownMandatoryRendered(buggyNoConstraints, 'constraints'),
    (err) => err.message.includes("Mandatory field missing from markdown: constraints")
  );

  // Negative control 2: removing conflicts renderer fails naming conflicts
  const buggyNoConflicts = mdText.replace(/### Blocking Conflicts[\s\S]*?(?=###)/, '');
  assert.throws(
    () => verifyMarkdownMandatoryRendered(buggyNoConflicts, 'conflicts'),
    (err) => err.message.includes("Mandatory field missing from markdown: conflicts")
  );
});
