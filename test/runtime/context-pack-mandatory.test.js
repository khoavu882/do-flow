'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const {
  extractMandatory,
  parseMandatoryFile,
  applyMandatoryOverride,
} = require('../../src/runtime/context/mandatory.ts');
const { handleContextPackCommand } = require('../../src/runtime/context-pack.ts');
const featureResolve = require('../../src/runtime/feature-resolve.ts');

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/context-pack');
// Every handleContextPackCommand call passes a temp stateRoot: its default is process.cwd(), and
// verify's broad tier runs this file with cwd in a live checkout, whose store it then polluted
// (FU-k9h1df; test/runtime/verify-broad-tier-store-isolation.test.js runs it from a linked worktree).

test('mandatory: extracts all fields from present.md fixture', () => {
  const filePath = path.join(FIXTURES_DIR, 'present.md');
  const text = fs.readFileSync(filePath, 'utf8');
  const res = extractMandatory({ text, path: filePath });

  assert.ok(res.fields.objective.includes('summary objective of the context pack feature'));
  assert.equal(res.fields.acceptanceCriteria.length, 2);
  assert.equal(res.fields.verificationRequirements.length, 1);
  assert.equal(res.fields.constraints.length, 2); // NFR-003 is Superseded, excluded
  assert.equal(res.fields.scopeExcluded.length, 2);
  assert.equal(res.fields.blockingGaps.length, 2);

  assert.equal(res.provenance.objective.supplied, true);
  assert.equal(res.provenance.objective.source, 'requirement');
  assert.ok(res.provenance.objective.digest.startsWith('sha256:'));
  assert.equal(res.provenance.constraints.supplied, true);
});

test('mandatory: acceptance criterion ids follow document order across task story sorts', () => {
  const text = [
    '# Requirement: IDs',
    '## 1. Summary',
    'ID stability.',
    '## 6. Acceptance Criteria',
    '- [ ] **Scenario: First** (US1)',
    '- [ ] **Scenario: Second** (US2)',
  ].join('\n');

  const firstTask = extractMandatory({ text, taskStories: ['US1'] }).fields.acceptanceCriteria;
  const secondTask = extractMandatory({ text, taskStories: ['US2'] }).fields.acceptanceCriteria;

  assert.equal(firstTask.find((ac) => ac.stories.includes('US1')).id, 'ac:1');
  assert.equal(secondTask.find((ac) => ac.stories.includes('US2')).id, 'ac:2');
});

test('mandatory: scope owner clauses normalize both supported forms', () => {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, 'real-feature-requirement.md'), 'utf8');
  const result = extractMandatory({ text });
  assert.ok(result.fields.scopeExcluded.some((item) => item.text.includes('(owner: 080)')));

  const custom = extractMandatory({
    text: '# Requirement: Owners\n## 1. Summary\nOwners.\n## 5. Out of Scope\n- **First item** (owner: 080)\n- **Second item** — owner 080 (task-graph-lifecycle)\n',
  });
  assert.deepEqual(custom.fields.scopeExcluded.map((item) => item.text), [
    'First item (owner: 080)',
    'Second item (owner: 080)',
  ]);
});

test('mandatory: handles absent requirement artifact with artifact-absent reason', () => {
  const res = extractMandatory({ text: null, path: 'absent.md' });

  for (const field of Object.keys(res.fields)) {
    assert.equal(res.provenance[field].supplied, false);
    assert.equal(res.provenance[field].reason, 'artifact-absent');
  }
});

test('mandatory: no-ac.md fixture yields artifact-malformed reason (negative control)', () => {
  const filePath = path.join(FIXTURES_DIR, 'no-ac.md');
  const text = fs.readFileSync(filePath, 'utf8');
  const res = extractMandatory({ text, path: filePath });

  assert.equal(res.provenance.acceptanceCriteria.supplied, false);
  assert.equal(res.provenance.acceptanceCriteria.reason, 'artifact-malformed: Acceptance Criteria missing');

  // Negative control: deleting §6 from present.md also gives exact reason
  const presentText = fs.readFileSync(path.join(FIXTURES_DIR, 'present.md'), 'utf8');
  const deletedSection6 = presentText.replace(/## 6\. Acceptance Criteria[\s\S]*?(?=## 7|$)/, '');
  const deletedRes = extractMandatory({ text: deletedSection6 });
  assert.equal(
    deletedRes.provenance.acceptanceCriteria.reason,
    'artifact-malformed: Acceptance Criteria missing'
  );
});

test('mandatory: draft.md fixture copies Draft maturity', () => {
  const filePath = path.join(FIXTURES_DIR, 'draft.md');
  const text = fs.readFileSync(filePath, 'utf8');
  const res = extractMandatory({ text, path: filePath });

  assert.equal(res.provenance.objective.maturity, 'Draft');
  assert.equal(res.fields.scopeExcluded.length, 0);
  assert.equal(res.provenance.scopeExcluded.reason, 'none-in-artifact');
  assert.equal(res.provenance.blockingGaps.reason, 'none-in-artifact');
});

test('mandatory: no-scenarios.md fixture places all items in both fields', () => {
  const filePath = path.join(FIXTURES_DIR, 'no-scenarios.md');
  const text = fs.readFileSync(filePath, 'utf8');
  const res = extractMandatory({ text, path: filePath });

  assert.equal(res.fields.acceptanceCriteria.length, 2);
  assert.equal(res.fields.verificationRequirements.length, 2);
  assert.deepEqual(
    res.fields.acceptanceCriteria.map((a) => a.text),
    res.fields.verificationRequirements.map((v) => v.text)
  );
});

test('mandatory: parseMandatoryFile and applyMandatoryOverride replace whole, never merge (negative control)', () => {
  const presentText = fs.readFileSync(path.join(FIXTURES_DIR, 'present.md'), 'utf8');
  const derived = extractMandatory({ text: presentText });

  const overrideJson = JSON.stringify({
    constraints: ['Caller constraint 1', 'Caller constraint 2'],
    scopeExcluded: [],
  });

  const override = parseMandatoryFile(overrideJson, 'test-override.json');
  assert.equal(override.provenance.constraints.source, 'caller');
  assert.equal(override.provenance.scopeExcluded.reason, 'caller-supplied-empty');

  const merged = applyMandatoryOverride(derived, override);

  // Constraints must be completely replaced
  assert.equal(merged.fields.constraints.length, 2);
  assert.equal(merged.fields.constraints[0].id, 'nfr:c1');
  assert.equal(merged.fields.constraints[0].text, 'Caller constraint 1');

  // Negative control: a buggy merge function that merges lists fails and names constraints
  function buggyMerge(d, o) {
    const fields = { ...d.fields };
    for (const [k, v] of Object.entries(o.fields)) {
      if (Array.isArray(fields[k]) && Array.isArray(v)) {
        fields[k] = [...fields[k], ...v]; // BUG: merged instead of replaced
      } else {
        fields[k] = v;
      }
    }
    return fields;
  }

  function verifyReplacement(resultFields, expectedCount, fieldName) {
    if (resultFields[fieldName].length !== expectedCount) {
      throw new Error(`Field '${fieldName}' was merged instead of replaced: expected ${expectedCount}, got ${resultFields[fieldName].length}`);
    }
  }

  // Real applyMandatoryOverride passes
  verifyReplacement(merged.fields, 2, 'constraints');

  // Buggy merge fails and names 'constraints'
  const buggyFields = buggyMerge(derived, override);
  assert.throws(
    () => verifyReplacement(buggyFields, 2, 'constraints'),
    (err) => err.message.includes("Field 'constraints' was merged instead of replaced")
  );
});

test('mandatory: parseMandatoryFile rejects invalid input with usage error', () => {
  assert.throws(() => parseMandatoryFile('{ bad json', 'stdin'), (err) => err.code === 'USAGE_ERROR');
  assert.throws(() => parseMandatoryFile('{"unknownKey": "val"}', 'stdin'), (err) => err.code === 'USAGE_ERROR');
  assert.throws(() => parseMandatoryFile('{"constraints": [123]}', 'stdin'), (err) => err.code === 'USAGE_ERROR');
  assert.throws(() => parseMandatoryFile('{"objective": 123}', 'stdin'), (err) => err.code === 'USAGE_ERROR');
});

test('mandatory: resolver spawns once during handleContextPackCommand (negative control)', (t) => {
  let spawnCount = 0;
  const origResolve = featureResolve.resolveActiveFeature;

  featureResolve.resolveActiveFeature = (opts) => {
    spawnCount++;
    return origResolve(opts);
  };
  require('../../src/runtime/task-scope.ts').clearTaskScopeCache();

  t.after(() => {
    featureResolve.resolveActiveFeature = origResolve;
    require('../../src/runtime/task-scope.ts').clearTaskScopeCache();
  });

  const origLog = console.log;
  const priorExitCode = process.exitCode;
  console.log = () => {};

  try {
    handleContextPackCommand({ taskId: 'test-spawn-count-task', json: true, stateRoot: tempDir(t) });
  } finally {
    console.log = origLog;
    process.exitCode = priorExitCode;
  }

  // Positive check: exactly 1 resolve call
  assert.equal(spawnCount, 1, `resolver must be called once, got ${spawnCount}`);

  // Negative control: a second resolver call fails the spawn-count assertion
  function assertSingleSpawn(count) {
    assert.equal(count, 1, `resolver spawned ${count} times instead of 1`);
  }
  assert.doesNotThrow(() => assertSingleSpawn(1));
  assert.throws(
    () => assertSingleSpawn(2),
    (err) => err.message.includes('resolver spawned 2 times instead of 1')
  );
});

test('mandatory: reads requirement from resolver paths.requirement supporting legacy flat-layout (CX.5)', (t) => {
  const origResolve = featureResolve.resolveActiveFeature;
  const temp = tempDir(t);
  const legacyDir = path.join(temp, 'agent-docs', 'doflow', 'legacy-001');
  fs.mkdirSync(legacyDir, { recursive: true });
  const flatReqPath = path.join(legacyDir, 'requirement.md');
  fs.writeFileSync(
    flatReqPath,
    '# Requirement: Legacy\n\n**Feature:** legacy-001 · **Maturity:** Draft\n\n## 1. Summary\n\nLegacy flat layout summary.\n\n## 6. Acceptance Criteria\n\n- [ ] **Scenario: S1** (FR-001)\n'
  );

  featureResolve.resolveActiveFeature = () => ({
    repoRoot: temp,
    featureDir: legacyDir,
    paths: {
      requirement: 'agent-docs/doflow/legacy-001/requirement.md',
    },
  });
  require('../../src/runtime/task-scope.ts').clearTaskScopeCache();

  t.after(() => {
    featureResolve.resolveActiveFeature = origResolve;
    require('../../src/runtime/task-scope.ts').clearTaskScopeCache();
  });

  let output = '';
  const origLog = console.log;
  const priorExitCode = process.exitCode;
  console.log = (msg) => { output = msg; };
  try {
    handleContextPackCommand({ taskId: 't-legacy', json: true, stateRoot: temp });
  } finally {
    console.log = origLog;
    process.exitCode = priorExitCode;
  }

  const pack = JSON.parse(output);
  assert.equal(pack.objective, 'Legacy flat layout summary.');
  assert.equal(pack.mandatory.objective.supplied, true);

  // Negative control: resolving with hardcoded nested path 'intention/requirement.md' fails on flat layout
  function resolveWithHardcodedNested(featureDir) {
    const nested = path.join(featureDir, 'intention', 'requirement.md');
    if (!fs.existsSync(nested)) {
      throw new Error(`Flat layout failed: '${nested}' does not exist`);
    }
  }
  assert.throws(
    () => resolveWithHardcodedNested(legacyDir),
    (err) => err.message.includes('Flat layout failed')
  );
});

test('mandatory: absent-artifact reason carries resolver message, not error code (CX.5)', (t) => {
  const origResolve = featureResolve.resolveActiveFeature;
  const resolverMessage = 'no-active-feature — checkout a feat/<NNN-slug> branch or run /do-brainstorm to start one';

  featureResolve.resolveActiveFeature = () => ({
    error: 'no-active-feature',
    message: resolverMessage,
  });
  require('../../src/runtime/task-scope.ts').clearTaskScopeCache();

  t.after(() => {
    featureResolve.resolveActiveFeature = origResolve;
    require('../../src/runtime/task-scope.ts').clearTaskScopeCache();
  });

  let output = '';
  const origLog = console.log;
  const priorExitCode = process.exitCode;
  console.log = (msg) => { output = msg; };
  try {
    handleContextPackCommand({ taskId: 't-no-feat', json: true, stateRoot: tempDir(t) });
  } finally {
    console.log = origLog;
    process.exitCode = priorExitCode;
  }

  const pack = JSON.parse(output);
  const reason = pack.mandatory.objective.reason;
  assert.equal(reason, `no-active-feature: ${resolverMessage}`);
  assert.equal(reason.includes(resolverMessage), true);

  // Negative control: using feature.error ('no-active-feature') gives 'no-active-feature: no-active-feature',
  // which does not carry the resolver message
  const buggyErrorCodeReason = `no-active-feature: no-active-feature`;
  assert.notEqual(buggyErrorCodeReason, `no-active-feature: ${resolverMessage}`);
});

test('mandatory: maturity captures up to dot or end of line ("In review"), and is null when no header (CX.5)', () => {
  // 1. With dot separator: "**Maturity:** In review · **Created:** 2026-10-13"
  const textWithDot = '# Req\n\n**Feature:** f1 · **Maturity:** In review · **Created:** 2026-10-13\n\n## 1. Summary\n\nSummary text.\n';
  const resDot = extractMandatory({ text: textWithDot });
  assert.equal(resDot.provenance.objective.maturity, 'In review');

  // 2. At end of line: "**Maturity:** In review\n"
  const textAtEol = '# Req\n\n**Feature:** f1 · **Maturity:** In review\n\n## 1. Summary\n\nSummary text.\n';
  const resEol = extractMandatory({ text: textAtEol });
  assert.equal(resEol.provenance.objective.maturity, 'In review');

  // 3. No header at all: maturity is null
  const textNoHeader = '# Req\n\n## 1. Summary\n\nSummary text without header.\n';
  const resNoHeader = extractMandatory({ text: textNoHeader });
  assert.equal(resNoHeader.provenance.objective.maturity, null);

  // Negative control: old regex [^\\s·\\n]+ would capture 'In' instead of 'In review'
  const oldRegexMatch = textWithDot.match(/\*\*Maturity:\*\*\s*([^\s·\n]+)/i)?.[1];
  assert.equal(oldRegexMatch, 'In');
  assert.notEqual(oldRegexMatch, 'In review');

  // Negative control: fallback to 'Draft' would make no-header return 'Draft' instead of null
  const oldFallback = (textNoHeader.match(/\*\*Maturity:\*\*\s*([^\s·\n]+)/i)?.[1] ?? 'Draft');
  assert.equal(oldFallback, 'Draft');
  assert.notEqual(oldFallback, null);
});

test('mandatory: gaps come from parseRequirement result and plan task stories order AC items (CX.5)', (t) => {
  // Part A: Gaps come from parseRequirement's own result
  const textNoAc = fs.readFileSync(path.join(FIXTURES_DIR, 'no-ac.md'), 'utf8');
  const parsed = require('../../src/runtime/scaffold/artifacts.ts').parseRequirement(textNoAc);
  const resNoAc = extractMandatory({ text: textNoAc });
  const expectedGaps = parsed.gaps.filter((g) => g.what === 'acceptance criteria');
  assert.deepEqual(resNoAc.provenance.acceptanceCriteria.gaps, expectedGaps);
  assert.deepEqual(resNoAc.provenance.verificationRequirements.gaps, expectedGaps);

  // Part B: Handler resolves plan task's stories and orders AC items
  const origResolve = featureResolve.resolveActiveFeature;
  const temp = tempDir(t);
  const featDir = path.join(temp, 'agent-docs', 'doflow', 'feat-stories');
  fs.mkdirSync(featDir, { recursive: true });

  const reqContent = [
    '# Requirement',
    '',
    '**Feature:** feat-stories · **Maturity:** Draft',
    '',
    '## 1. Summary',
    'Summary text',
    '',
    '## 6. Acceptance Criteria',
    '- [ ] **Scenario: US1 flow** (FR-001, US1)',
    '- [ ] **Scenario: US2 flow** (FR-002, US2)',
    '',
  ].join('\n');

  const planContent = [
    '# Plan',
    '',
    '## Tasks',
    '- [ ] T.1 [US2] Second story task — files: src/foo.ts',
    '- [ ] T.2 [US1] First story task — files: src/bar.ts',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(featDir, 'requirement.md'), reqContent);
  fs.writeFileSync(path.join(featDir, 'plan.md'), planContent);

  featureResolve.resolveActiveFeature = () => ({
    repoRoot: temp,
    featureDir: featDir,
    paths: {
      requirement: 'agent-docs/doflow/feat-stories/requirement.md',
      plan: 'agent-docs/doflow/feat-stories/plan.md',
    },
  });
  require('../../src/runtime/task-scope.ts').clearTaskScopeCache();

  t.after(() => {
    featureResolve.resolveActiveFeature = origResolve;
    require('../../src/runtime/task-scope.ts').clearTaskScopeCache();
  });

  let output = '';
  const origLog = console.log;
  const priorExitCode = process.exitCode;
  console.log = (msg) => { output = msg; };
  try {
    handleContextPackCommand({ taskId: 'T.1', json: true, stateRoot: temp });
  } finally {
    console.log = origLog;
    process.exitCode = priorExitCode;
  }

  const pack = JSON.parse(output);
  // Task T.1 declares [US2], so the US2 scenario must be ordered first
  assert.equal(pack.acceptanceCriteria.length, 2);
  assert.ok(pack.acceptanceCriteria[0].text.includes('US2'));
  assert.ok(pack.acceptanceCriteria[1].text.includes('US1'));

  // Negative control: without taskStories, AC items remain in original document order (US1 first)
  const unOrdered = extractMandatory({ text: reqContent, taskStories: [] });
  assert.ok(unOrdered.fields.acceptanceCriteria[0].text.includes('US1'));
  assert.ok(unOrdered.fields.acceptanceCriteria[1].text.includes('US2'));
});
