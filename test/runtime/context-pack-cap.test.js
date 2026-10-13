'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { handleContextPackCommand, TASK_CLASS_BUDGETS, ContextPackCompiler } = require('../../src/runtime/context-pack.ts');
const { computeEnvelopes } = require('../../src/runtime/context/compose.ts');
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

function boundedSweepCaps(mandatorySize) {
  const caps = new Set([20000, 23750]);
  const coarseStart = Math.ceil((mandatorySize - 500) / 250) * 250;
  for (let cap = coarseStart; cap <= mandatorySize + 500; cap += 250) caps.add(cap);
  for (let cap = mandatorySize - 60; cap <= mandatorySize + 60; cap += 10) caps.add(cap);
  return [...caps].sort((a, b) => a - b);
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
  const { linearFit, buildObjectiveItem, buildPackItem } = require('../../src/runtime/context/compose.ts');
  const mandatory = buildObjectiveItem('Objective');
  const optional = buildPackItem({
    id: 'opt-1',
    field: 'claims.supported',
    value: 'claim',
    md: '- claim\n',
    priority: 2,
    mdBytes: 200,
    jsonBytes: 200,
  });

  // With envelope included (300 B), mandatory + envelope + optional exceeds budget (500 B).
  // Thus optional item must be omitted with reason budget.
  const fitWithEnvelope = linearFit({
    items: [mandatory, optional],
    budget: 500,
    envelopeMd: 300,
    envelopeJson: 300,
  });

  assert.equal(fitWithEnvelope.overflow, false);
  assert.ok(
    fitWithEnvelope.omissions.some((o) => o.id === 'opt-1' && o.reason === 'budget'),
    'linearFit must omit optional item with reason budget when envelope term pushes cost over budget'
  );
  assert.ok(
    !fitWithEnvelope.kept.some((i) => i.id === 'opt-1'),
    'linearFit must not keep optional item when envelope term pushes cost over budget'
  );
});

function buildDenseSweepFixture() {
  const acList = Array.from({ length: 16 }, (_, i) => ({
    id: `ac:${i + 1}`,
    text: `Scenario: Invariant condition ${i + 1} is upheld under concurrent load`,
    requirements: [`FR-00${i + 1}`],
    stories: [`US${(i % 3) + 1}`],
  }));

  const nfrList = Array.from({ length: 8 }, (_, i) => ({
    id: `NFR-00${i + 1}`,
    text: `Maximum response latency under ${(i + 1) * 50}ms`,
    kind: 'performance',
  }));

  const evidence = Array.from({ length: 10 }, (_, i) => ({
    id: `ev:${i + 1}`,
    kind: 'exact-search',
    locator: { file: `src/module_${i + 1}.ts` },
    content: `Evidence sample ${i + 1} showing implementation details and search result for module ${i + 1}`,
    freshness: { status: 'FRESH' },
  }));

  const claims = {
    supported: Array.from({ length: 5 }, (_, i) => ({
      id: `claim:s${i + 1}`,
      subject: `Claim ${i + 1}: Module ${i + 1} operates predictably`,
      status: 'supported',
      evidenceIds: [`ev:${i + 1}`],
    })),
    hypotheses: Array.from({ length: 5 }, (_, i) => ({
      id: `claim:h${i + 1}`,
      subject: `Hypothesis ${i + 1}: Optimization ${i + 1} might reduce memory usage`,
      status: 'hypothesis',
    })),
  };

  const researchRequests = Array.from({ length: 5 }, (_, i) => ({
    id: `rr-${i + 1}`,
    topic: `Research topic ${i + 1} regarding performance under load`,
    blocking: false,
    status: 'answered',
    decision: `Use strategy ${i + 1}`,
  }));

  const decisions = {
    available: true,
    live: [
      { id: 'DEC-001', topic: 'Architecture choice', statement: 'Use layered compiler pipeline', decidedBy: 'architect', stage: 'design' },
      { id: 'DEC-002', topic: 'Data representation', statement: 'Use JSON and markdown duality', decidedBy: 'architect', stage: 'design' },
      { id: 'DEC-003', topic: 'Cache strategy', statement: 'In-memory LRU with file backing', decidedBy: 'lead', stage: 'design' },
      { id: 'DEC-004', topic: 'Concurrency handling', statement: 'Bounded lock acquisition with retries', decidedBy: 'lead', stage: 'design' },
      { id: 'DEC-005', topic: 'Fitting algorithm', statement: 'Single linear selection for both forms', decidedBy: 'architect', stage: 'design' },
    ],
    liveCount: 5,
  };

  return {
    taskId: 'task-dense-sweep',
    taskClass: 'feature',
    objective: 'Feature: Dense sweep cap verification across boundary',
    acceptanceCriteria: acList,
    constraints: nfrList,
    evidence,
    claims,
    researchRequests,
    decisions,
  };
}

test('context-pack-cap: dense sweep through compiler with no CLI spawn (CX.7)', () => {
  const fixture = buildDenseSweepFixture();
  const compiler = new ContextPackCompiler();

  const initialPack = compiler.compileContextPack({ ...fixture, maxBytes: 50000 });
  const mandSize = initialPack.size.mandatoryBytes;

  for (let cap = mandSize - 1000; cap <= mandSize + 10000; cap += 50) {
    const pack = compiler.compileContextPack({ ...fixture, maxBytes: cap });
    const md = compiler.formatMarkdown(pack);
    const json = compiler.formatJson(pack);

    const mdBytes = Buffer.byteLength(md, 'utf8');
    const jsonBytes = Buffer.byteLength(json, 'utf8');

    assert.equal(pack.status === 'OK' || pack.status === 'OVERFLOW', true);

    if (pack.status === 'OK') {
      assert.ok(
        mdBytes <= cap,
        `Markdown stdout (${mdBytes} B) exceeds cap (${cap} B) at OK status`
      );
      assert.ok(
        jsonBytes <= cap,
        `JSON stdout (${jsonBytes} B) exceeds cap (${cap} B) at OK status`
      );
    }
  }
});

test('context-pack-cap: negative control — removing the corrective step fails the sweep (CX.7)', () => {
  const fixture = buildDenseSweepFixture();
  const compiler = new ContextPackCompiler({ enableCorrective: false });
  const initialPack = compiler.compileContextPack({ ...fixture, maxBytes: 50000 }, { enableCorrective: false });
  const mandSize = initialPack.size.mandatoryBytes;

  assert.throws(
    () => {
      for (let cap = mandSize - 1000; cap <= mandSize + 10000; cap += 50) {
        const pack = compiler.compileContextPack({ ...fixture, maxBytes: cap }, { enableCorrective: false });
        compiler.formatMarkdown(pack);
        compiler.formatJson(pack);
      }
    },
    (err) => err.message.includes('exceeds budget')
  );
});

test('context-pack-cap: negative control — costing a self-referential field at a narrower width fails (CX.7)', () => {
  const fixture = buildDenseSweepFixture();
  const compiler = new ContextPackCompiler({ selfRefWidth: 1, enableCorrective: false });
  const initialPack = compiler.compileContextPack({ ...fixture, maxBytes: 50000 }, { selfRefWidth: 1, enableCorrective: false });
  const mandSize = initialPack.size.mandatoryBytes;

  assert.throws(
    () => {
      for (let cap = mandSize - 1000; cap <= mandSize + 10000; cap += 50) {
        const pack = compiler.compileContextPack({ ...fixture, maxBytes: cap }, { selfRefWidth: 1, enableCorrective: false });
        compiler.formatMarkdown(pack);
        compiler.formatJson(pack);
      }
    },
    (err) => err.message.includes('exceeds budget')
  );

  const envAt5 = computeEnvelopes({ taskId: 't', taskClass: 'feature', budget: { maxBytes: 18000 } });
  const envAt1 = computeEnvelopes({ taskId: 't', taskClass: 'feature', budget: { maxBytes: 18000 }, selfRefWidth: 1 });
  assert.ok(
    envAt5.envelopeJson > envAt1.envelopeJson,
    `envelopeJson costed at width 5 (${envAt5.envelopeJson}) must exceed width 1 (${envAt1.envelopeJson})`
  );
});

test('context-pack-cap: handler dense sweep costs recorded delivery and telemetry (DX.1)', (t) => {
  const root = tempDir(t, 'doflow-cap-handler-dx1-');
  const reqDir = path.join(root, 'agent-docs/doflow/dx1/intention');
  fs.mkdirSync(reqDir, { recursive: true });
  const criteria = Array.from({ length: 40 }, (_, i) => `- [ ] **Scenario: Criterion ${i + 1}**\n  Given ${'a'.repeat(250)}\n  When ${'b'.repeat(90)}\n  Then ${'c'.repeat(80)} (FR-${String(i + 1).padStart(3, '0')}, US1)`).join('\n');
  fs.writeFileSync(path.join(reqDir, 'requirement.md'), `# Feature: DX.1 dense handler sweep\n\n## 1. Summary\n${'Dense cap verification. '.repeat(30)}\n\n## 6. Acceptance Criteria\n${criteria}\n`, 'utf8');

  const baseline = runPack({ taskId: 'dx1-baseline', taskClass: 'feature', stateRoot: root, slug: 'dx1', maxBytes: 50000, json: true });
  const mandatorySize = JSON.parse(baseline.out).size.mandatoryBytes;
  for (const cap of boundedSweepCaps(mandatorySize)) {
    const taskId = `dx1-${cap}`;
    const results = {};
    for (const noRecord of [false, true]) {
      for (const json of [false, true]) {
        const result = runPack({ taskId, taskClass: 'feature', stateRoot: root, slug: 'dx1', maxBytes: cap, json, noRecord });
        assert.ok([EXIT.OK, EXIT.EMPTY, EXIT.OVERFLOW].includes(result.code), `cap ${cap}, json=${json}, noRecord=${noRecord}: ${result.out}`);
        assert.ok(result.out.length > 0, `cap ${cap}, json=${json}, noRecord=${noRecord} must emit a pack`);
        const bytes = Buffer.byteLength(result.out, 'utf8');
        if (json) {
          const pack = JSON.parse(result.out);
          assert.equal(bytes, pack.size.totalBytes, `JSON byte count at cap ${cap}`);
          if (pack.status === 'OK') assert.ok(bytes <= cap, `OK JSON exceeds cap ${cap}`);
        } else {
          const end = result.out.match(/\[end of pack\][^\n]*bytes=(\d{9})/);
          assert.ok(end, `markdown end line missing at cap ${cap}`);
          assert.equal(bytes, Number(end[1]), `markdown byte count at cap ${cap}`);
        }
        (results[noRecord ? 'off' : 'on'] ||= {})[json ? 'json' : 'markdown'] = result;
      }
      assert.equal(results[noRecord ? 'off' : 'on'].json.code, results[noRecord ? 'off' : 'on'].markdown.code, `forms disagree at cap ${cap}, noRecord=${noRecord}`);
    }
  }
});

test('context-pack-cap: negative control — a delivery field appended after fit exceeds the cap (DX.1)', () => {
  const fixture = buildDenseSweepFixture();
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({ ...fixture, maxBytes: 20000 });
  const initial = compiler.formatJson(pack);
  const cap = Buffer.byteLength(initial, 'utf8');
  pack.budget.maxBytes = cap;
  pack.delivery.lateField = true;
  assert.throws(() => compiler.formatJson(pack), (error) => error.message.includes('exceeds budget'));
});

test('context-pack-cap: real requirement sweep keeps both forms aligned with recording on and off (DX.3)', (t) => {
  const root = tempDir(t, 'doflow-cap-dx3-');
  const slug = 'real-feature';
  const reqDir = path.join(root, 'agent-docs/doflow', slug, 'intention');
  fs.mkdirSync(reqDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../fixtures/context-pack/real-feature-requirement.md'), path.join(reqDir, 'requirement.md'));

  const ledger = new EvidenceLedger({ repoRoot: root, slug });
  ledger.load('dx3-sweep');
  for (let i = 0; i < 30; i += 1) {
    ledger.addEvidence({
      taskId: 'dx3-sweep',
      kind: 'exact-search',
      locator: { file: `src/feature-${i}.ts` },
      content: `Evidence summary ${i + 1}: ${'implementation detail '.repeat(5)}`,
      freshness: { status: 'FRESH' },
    });
  }
  ledger.save('dx3-sweep');

  const baseline = runPack({ taskId: 'dx3-baseline', taskClass: 'feature', stateRoot: root, slug, maxBytes: 50000, json: true });
  const mandatorySize = JSON.parse(baseline.out).size.mandatoryBytes;
  for (const cap of boundedSweepCaps(mandatorySize)) {
    for (const noRecord of [false, true]) {
      const results = {};
      for (const json of [false, true]) {
        const result = runPack({
          taskId: 'dx3-sweep', taskClass: 'feature', stateRoot: root, slug,
          maxBytes: cap, reason: 'DX.3 boundary sweep', json, noRecord,
        });
        assert.ok([EXIT.OK, EXIT.EMPTY, EXIT.OVERFLOW].includes(result.code), `cap ${cap}, json=${json}, noRecord=${noRecord}: ${result.out}`);
        assert.ok(result.out.length > 0, `cap ${cap}, json=${json}, noRecord=${noRecord} emitted no pack`);
        const bytes = Buffer.byteLength(result.out, 'utf8');
        if (json) {
          const pack = JSON.parse(result.out);
          assert.equal(bytes, pack.size.totalBytes, `JSON bytes at cap ${cap}`);
          assert.equal(bytes, pack.packEnd.bytes, `JSON end bytes at cap ${cap}`);
          if (pack.status === 'OK') assert.ok(bytes <= cap, `OK JSON exceeded ${cap} B`);
          results.json = { code: result.code, status: pack.status };
        } else {
          const end = result.out.match(/\[end of pack\][^\n]*bytes=(\d{9})/);
          assert.ok(end, `Markdown end line missing at cap ${cap}`);
          assert.equal(bytes, Number(end[1]), `Markdown bytes at cap ${cap}`);
          results.markdown = { code: result.code, status: result.code === EXIT.OVERFLOW ? 'OVERFLOW' : result.code === EXIT.EMPTY ? 'EMPTY' : 'OK' };
        }
      }
      assert.equal(results.json.status, results.markdown.status, `forms disagree at cap ${cap}, noRecord=${noRecord}`);
      assert.equal(results.json.code, results.markdown.code, `exit codes disagree at cap ${cap}, noRecord=${noRecord}`);
    }
  }
});

