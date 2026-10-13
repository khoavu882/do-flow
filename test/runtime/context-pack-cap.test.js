'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { handleContextPackCommand, TASK_CLASS_BUDGETS } = require('../../src/runtime/context-pack.ts');
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
