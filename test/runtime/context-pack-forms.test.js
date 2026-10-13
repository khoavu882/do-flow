'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { handleContextPackCommand, ContextPackCompiler } = require('../../src/runtime/context-pack.ts');
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
  assert.deepEqual(Object.keys(jsonPack.budgetEnforcement.limits), [
    'maxFiles', 'maxClaims', 'maxEvidenceItems', 'maxResearchRequests', 'maxStructuralItems',
  ]);
  assert.doesNotMatch(jsonRes.out, /enableCorrective|selfRefWidth/);

  // Run Markdown form
  const mdRes = runPack({
    taskId: 'task-forms',
    taskClass: 'feature',
    stateRoot: root,
    slug: 'feat-forms',
    json: false,
  });
  assert.doesNotMatch(mdRes.out, /enableCorrective|selfRefWidth/);
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

test('context-pack-forms: supported claims carry evidenceIds mapped from supportingEvidence (CX.4)', () => {
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 't-claim-ev',
    claims: [
      { id: 'c1', statement: 'Wire carries key', status: 'supported', supportingEvidence: ['ev-10', 'ev-20'] },
    ],
  });
  assert.equal(pack.claims.supported.length, 1);
  assert.deepEqual(pack.claims.supported[0].evidenceIds, ['ev-10', 'ev-20']);
  const md = compiler.formatMarkdown(pack);
  assert.ok(md.includes('- ✓ Wire carries key *(ev: ev-10, ev-20)*'));
});

test('context-pack-forms: blocking unanswered research requests render under Blocking Gaps (CX.4)', () => {
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 't-rr-blocking',
    researchRequests: [
      { id: 'r1', status: 'OPEN', blocking: true, stageId: 'design', question: 'API path?', gap: 'missing route' },
      { id: 'r2', status: 'OPEN', blocking: false, stageId: 'design', question: 'Cache TTL?' },
      { id: 'r3', status: 'ANSWERED', blocking: true, stageId: 'design', question: 'Auth mode?' },
    ],
  });
  const md = compiler.formatMarkdown(pack);
  // Blocking unanswered under Blocking Gaps
  assert.match(md, /### Blocking Gaps\n- OPEN \(blocking\) design: API path\? — missing route/);
  // Not supplied must not appear when blocking gap is present
  assert.equal(md.includes('### Blocking Gaps\n- not supplied:'), false);
  // Feature Research Requests holds others (non-blocking, and answered blocking)
  assert.match(md, /### Feature Research Requests\n- OPEN \(nonblocking\) design: Cache TTL\?\n- ANSWERED \(blocking\) design: Auth mode\?/);
  // API path? must not be in Feature Research Requests
  assert.equal(md.slice(md.indexOf('### Feature Research Requests')).includes('API path?'), false);

  // When no blocking gaps or requests exist, not supplied appears
  const emptyPack = compiler.compileContextPack({ taskId: 't-no-gaps' });
  const emptyMd = compiler.formatMarkdown(emptyPack);
  assert.match(emptyMd, /### Blocking Gaps\n- not supplied:/);
});

test('context-pack-forms: caller-supplied objective sets provenance to source: caller (CX.4)', () => {
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 't-caller-obj',
    objective: 'Custom override goal',
    mandatory: {
      provenance: {
        objective: { supplied: true, source: 'requirement', locator: 'req.md#1', digest: 'sha256:111' },
      },
    },
  });
  assert.equal(pack.objective, 'Custom override goal');
  assert.equal(pack.mandatory.objective.source, 'caller');
  assert.equal(pack.mandatory.objective.supplied, true);
  const md = compiler.formatMarkdown(pack);
  assert.match(md, /- objective: caller/);
});

test('context-pack-forms: bare mode drops mandatory items except objective and has no footer beyond end line (CX.4)', () => {
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 't-bare',
    bare: true,
    objective: 'Bare objective statement',
    acceptanceCriteria: [{ id: 'ac:1', text: 'Should be dropped' }],
    constraints: [{ id: 'nfr:1', text: 'Should be dropped', kind: 'security' }],
    verificationRequirements: [{ id: 'vr:1', text: 'Should be dropped' }],
    scopeExcluded: [{ id: 'scope:1', text: 'Should be dropped' }],
    blockingGaps: [{ id: 'gap:1', text: 'Should be dropped' }],
    claims: {
      conflicts: [{ id: 'c1', statement: 'Conflict dropped' }],
      supported: [{ id: 'c2', statement: 'Supported dropped' }],
    },
    researchRequests: [{ id: 'r1', status: 'OPEN', blocking: true, stageId: 'design', question: 'Dropped?' }],
  });
  // In JSON
  assert.equal(pack.objective, 'Bare objective statement');
  assert.equal(pack.acceptanceCriteria.length, 0);
  assert.equal(pack.constraints.length, 0);
  assert.equal(pack.verificationRequirements.length, 0);
  assert.equal(pack.scopeExcluded.length, 0);
  assert.equal(pack.blockingGaps.length, 0);
  assert.equal(pack.claims.conflicts.length, 0);
  assert.equal(pack.researchRequests.length, 0);
  assert.equal(pack.packEnd.objective, 1);
  assert.equal(pack.packEnd.acceptanceCriteria, 0);
  assert.equal(pack.packEnd.constraints, 0);
  assert.equal(pack.packEnd.verificationRequirements, 0);
  assert.equal(pack.packEnd.scopeExcluded, 0);
  assert.equal(pack.packEnd.conflicts, 0);
  assert.equal(pack.packEnd.blockingGaps, 0);
  assert.equal(pack.packEnd.omitted, 0);

  // In Markdown
  const md = compiler.formatMarkdown(pack);
  assert.ok(md.includes('**Objective:** Bare objective statement'));
  assert.equal(md.includes('### Acceptance Criteria'), false);
  assert.equal(md.includes('### Constraints'), false);
  assert.equal(md.includes('_Budget '), false, 'Bare mode must have no footer beyond end line');
  assert.match(md, /\[end of pack\] mode=bare objective=1 ac=0 constraints=0 verification=0 scope=0 conflicts=0 gaps=0 omitted=0 bytes=\d{9} digest=sha256:[a-f0-9]{12}\n$/);
});

test('context-pack-forms: structural context capped at 5 and together with research requests stays within 20 (CX.4)', () => {
  const compiler = new ContextPackCompiler();
  // 1. Structural context alone: 8 items -> exactly 5 kept, 3 omitted with item-cap
  const structPack = compiler.compileContextPack({
    taskId: 't-struct-cap',
    evidence: Array.from({ length: 8 }, (_, i) => ({
      id: `ev-struct-${i + 1}`,
      kind: 'structural',
      content: `Node-${i + 1}`,
      freshness: { status: 'FRESH' },
    })),
  });
  assert.equal(structPack.structuralContext.length, 5);
  const structOmissions = structPack.omissions.groups.find(g => g.reason === 'item-cap');
  assert.ok(structOmissions);
  assert.equal(structOmissions.ids.filter(id => id.startsWith('struct:')).length, 3);

  // 2. Together with non-blocking research requests: 18 requests + 5 structural = 23 -> exactly 20 kept (18 requests + 2 structural)
  const comboPack = compiler.compileContextPack({
    taskId: 't-combo-cap',
    researchRequests: Array.from({ length: 18 }, (_, i) => ({
      id: `rr-nonblock-${i + 1}`,
      status: 'OPEN',
      blocking: false,
      stageId: 'design',
      question: `Question ${i + 1}`,
    })),
    evidence: Array.from({ length: 5 }, (_, i) => ({
      id: `ev-struct-combo-${i + 1}`,
      kind: 'structural',
      content: `ComboNode-${i + 1}`,
      freshness: { status: 'FRESH' },
    })),
  });
  assert.equal(comboPack.researchRequests.length, 18);
  assert.equal(comboPack.structuralContext.length, 2);
  const comboOmissions = comboPack.omissions.groups.find(g => g.reason === 'item-cap');
  assert.ok(comboOmissions);
  assert.equal(comboOmissions.ids.filter(id => id.startsWith('struct:')).length, 3);
});
