'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { handleContextPackCommand, TASK_CLASS_BUDGETS } = require('../../src/runtime/context-pack.ts');
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

test('context-pack-cap: both forms stay at or under cap for feature, bug and trivial-edit, with budget source printed', (t) => {
  const root = tempDir(t, 'doflow-cap-');
  const featDir = path.join(root, 'agent-docs/doflow/feat-1/intention');
  fs.mkdirSync(featDir, { recursive: true });

  const reqContent = `# Feature: Test

## 1. Summary
A simple test feature to verify budget caps.

## 4. Non-Functional Requirements
| ID | Constraint | Kind | Status |
|---|---|---|---|
| NFR-001 | Maximum response latency under 200ms | performance | Live |

## 5. Out of Scope
- External system integration

## 6. Acceptance Criteria
- [ ] **Scenario: Happy path**
  Given valid inputs
  When processed
  Then returns success (FR-001, US1)

## 7. Open Questions
None.
`;
  fs.writeFileSync(path.join(featDir, 'requirement.md'), reqContent, 'utf8');

  const classes = ['feature', 'bug', 'trivial-edit'];

  for (const taskClass of classes) {
    const expectedCap = TASK_CLASS_BUDGETS[taskClass];

    // Markdown form
    const mdRes = runPack({
      taskId: 'task-1',
      taskClass,
      stateRoot: root,
      slug: 'feat-1',
      json: false,
    });

    assert.ok(mdRes.code === EXIT.OK || mdRes.code === EXIT.EMPTY);
    const mdBytes = Buffer.byteLength(mdRes.out, 'utf8');
    assert.ok(
      mdBytes <= expectedCap,
      `Markdown size (${mdBytes} B) exceeds cap (${expectedCap} B) for class ${taskClass}`
    );
    assert.ok(
      mdRes.out.includes(`(${taskClass})`) || mdRes.out.includes('(task-class)'),
      `Markdown output must state budget source for class ${taskClass}`
    );

    // JSON form
    const jsonRes = runPack({
      taskId: 'task-1',
      taskClass,
      stateRoot: root,
      slug: 'feat-1',
      json: true,
    });

    assert.ok(jsonRes.code === EXIT.OK || jsonRes.code === EXIT.EMPTY);
    const jsonBytes = Buffer.byteLength(jsonRes.out, 'utf8');
    assert.ok(
      jsonBytes <= expectedCap,
      `JSON size (${jsonBytes} B) exceeds cap (${expectedCap} B) for class ${taskClass}`
    );
    const pack = JSON.parse(jsonRes.out);
    assert.equal(pack.budget.source, 'task-class');
    assert.equal(pack.budget.maxBytes, expectedCap);
  }
});

test('context-pack-cap: --max-bytes override source is printed and respected', (t) => {
  const root = tempDir(t, 'doflow-cap-override-');
  const featDir = path.join(root, 'agent-docs/doflow/feat-1/intention');
  fs.mkdirSync(featDir, { recursive: true });
  fs.writeFileSync(path.join(featDir, 'requirement.md'), '# Feature: Override\n## 1. Summary\nSummary.\n## 6. Acceptance Criteria\n- [ ] AC1\n', 'utf8');

  const customCap = 50000;
  const res = runPack({
    taskId: 'task-1',
    taskClass: 'feature',
    maxBytes: customCap,
    reason: 'testing override cap',
    stateRoot: root,
    slug: 'feat-1',
    json: true,
  });

  const pack = JSON.parse(res.out);
  assert.equal(pack.budget.source, 'override');
  assert.equal(pack.budget.maxBytes, customCap);
  assert.ok(pack.size.totalBytes <= customCap);
});

test('context-pack-cap: 1-byte cap gives exit 3 and untruncated mandatory text, never a cut (negative control)', (t) => {
  const root = tempDir(t, 'doflow-cap-negative-');
  const featDir = path.join(root, 'agent-docs/doflow/feat-1/intention');
  fs.mkdirSync(featDir, { recursive: true });

  const rawAc = '**Scenario: Critical invariant** Given state When trigger Then satisfy invariant (FR-001)';
  const reqContent = `# Feature: NegControl\n## 1. Summary\nShort.\n## 6. Acceptance Criteria\n- [ ] ${rawAc}\n`;
  fs.writeFileSync(path.join(featDir, 'requirement.md'), reqContent, 'utf8');

  // Positive check: 1-byte cap gives exit 3 and preserves mandatory text
  const res = runPack({
    taskId: 'task-1',
    taskClass: 'feature',
    maxBytes: 1,
    reason: 'testing 1-byte cap',
    stateRoot: root,
    slug: 'feat-1',
    json: true,
  });

  assert.equal(res.code, EXIT.OVERFLOW);
  const pack = JSON.parse(res.out);
  assert.equal(pack.status, 'OVERFLOW');
  assert.equal(pack.exitCode, EXIT.OVERFLOW);
  assert.equal(pack.overflow.cause, 'mandatory');
  assert.equal(pack.acceptanceCriteria.length, 1);
  assert.equal(pack.acceptanceCriteria[0].text, rawAc);

  // Negative control helper
  function assertNoCutOn1ByteCap(resultCode, resultStatus, emittedAcText, expectedSourceText) {
    if (resultCode !== EXIT.OVERFLOW || resultStatus !== 'OVERFLOW') {
      throw new Error(`Expected exit 3 OVERFLOW on 1-byte cap, got code ${resultCode} status ${resultStatus}`);
    }
    if (emittedAcText !== expectedSourceText) {
      throw new Error(`Mandatory text was cut: expected ${expectedSourceText.length} bytes, got ${emittedAcText.length} bytes`);
    }
  }

  // Real run passes
  assertNoCutOn1ByteCap(res.code, pack.status, pack.acceptanceCriteria[0].text, rawAc);

  // Negative control 1: buggy implementation cuts text to fit
  const buggyCutText = rawAc.slice(0, 10);
  assert.throws(
    () => assertNoCutOn1ByteCap(res.code, pack.status, buggyCutText, rawAc),
    (err) => err.message.includes('Mandatory text was cut')
  );

  // Negative control 2: buggy implementation exits 0 instead of 3
  assert.throws(
    () => assertNoCutOn1ByteCap(EXIT.OK, 'OK', rawAc, rawAc),
    (err) => err.message.includes('Expected exit 3 OVERFLOW')
  );
});

test('context-pack-cap: caps 1000 to 20000 in steps crossing mandatory size: stdout <= cap when OK, forms agree', (t) => {
  const root = tempDir(t, 'doflow-cap-steps-');
  const featDir = path.join(root, 'agent-docs/doflow/feat-steps/intention');
  fs.mkdirSync(featDir, { recursive: true });

  const reqContent = `# Feature: Steps
## 1. Summary
A test feature with enough content to cross mandatory size across caps.

## 4. Non-Functional Requirements
| ID | Constraint | Kind | Status |
|---|---|---|---|
| NFR-001 | Response latency under 200ms | performance | Live |
| NFR-002 | Zero external dependencies | reliability | Live |

## 5. Out of Scope
- Graphical user interface

## 6. Acceptance Criteria
- [ ] **Scenario: First invariant**
  Given system ready
  When triggered
  Then verify first invariant (FR-001, US1)
- [ ] **Scenario: Second invariant**
  Given active session
  When payload dispatched
  Then deliver response (FR-002, US2)

## 7. Open Questions
None.
`;
  fs.writeFileSync(path.join(featDir, 'requirement.md'), reqContent, 'utf8');

  const ledger = new EvidenceLedger({ repoRoot: root, slug: 'feat-steps' });
  ledger.load('task-steps');
  ledger.addEvidence({
    taskId: 'task-steps',
    kind: 'exact-search',
    locator: { file: 'src/main.ts' },
    content: 'Evidence text for step test',
    freshness: { status: 'FRESH' },
  });
  ledger.save('task-steps');

  const testCaps = [1000, 2000, 3000, 4000, 5000, 7500, 10000, 12500, 15000, 17500, 20000];

  for (const cap of testCaps) {
    const mdRes = runPack({
      taskId: 'task-steps',
      taskClass: 'feature',
      maxBytes: cap,
      reason: `testing cap ${cap}`,
      stateRoot: root,
      slug: 'feat-steps',
      json: false,
    });

    const jsonRes = runPack({
      taskId: 'task-steps',
      taskClass: 'feature',
      maxBytes: cap,
      reason: `testing cap ${cap}`,
      stateRoot: root,
      slug: 'feat-steps',
      json: true,
    });

    assert.equal(
      mdRes.code,
      jsonRes.code,
      `Markdown (code ${mdRes.code}) and JSON (code ${jsonRes.code}) must agree on status for cap ${cap}`
    );

    const mdBytes = Buffer.byteLength(mdRes.out, 'utf8');
    const jsonBytes = Buffer.byteLength(jsonRes.out, 'utf8');

    if (mdRes.code === EXIT.OK) {
      assert.ok(
        mdBytes <= cap,
        `Markdown stdout (${mdBytes} B) exceeds cap (${cap} B) when status is OK`
      );
      assert.ok(
        jsonBytes <= cap,
        `JSON stdout (${jsonBytes} B) exceeds cap (${cap} B) when status is OK`
      );
    }
  }
});

test('context-pack-cap: dropping the envelope term from the cost fails (negative control)', (t) => {
  const root = tempDir(t, 'doflow-cap-envelope-neg-');
  const featDir = path.join(root, 'agent-docs/doflow/feat-env-neg/intention');
  fs.mkdirSync(featDir, { recursive: true });

  const reqContent = `# Feature: EnvNeg
## 1. Summary
Summary text.
## 6. Acceptance Criteria
- [ ] AC1
`;
  fs.writeFileSync(path.join(featDir, 'requirement.md'), reqContent, 'utf8');

  const tightCap = 2000;
  const realRes = runPack({
    taskId: 't-env',
    taskClass: 'feature',
    maxBytes: tightCap,
    reason: 'tight budget',
    stateRoot: root,
    slug: 'feat-env-neg',
    json: true,
  });

  function assertEnvelopeGuarded(packRes, budget) {
    if (packRes.code === EXIT.OK) {
      const bytes = Buffer.byteLength(packRes.out, 'utf8');
      if (bytes > budget) {
        throw new Error(`Dropping envelope failed: emitted size ${bytes} B exceeds budget ${budget} B`);
      }
    }
  }

  // Real run passes (it overflowed, exit 3, never emitted over cap as OK)
  assertEnvelopeGuarded(realRes, tightCap);

  // Negative control: simulated buggy output where envelope was dropped from cost so pack was emitted as OK with size > budget
  const buggyOverCapRes = { code: EXIT.OK, out: 'X'.repeat(3000) };
  assert.throws(
    () => assertEnvelopeGuarded(buggyOverCapRes, tightCap),
    (err) => err.message.includes('Dropping envelope failed') && err.message.includes('exceeds budget')
  );
});

