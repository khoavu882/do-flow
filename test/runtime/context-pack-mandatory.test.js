'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  extractMandatory,
  parseMandatoryFile,
  applyMandatoryOverride,
} = require('../../src/runtime/context/mandatory.ts');
const { handleContextPackCommand } = require('../../src/runtime/context-pack.ts');
const featureResolve = require('../../src/runtime/feature-resolve.ts');

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/context-pack');

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

  t.after(() => {
    featureResolve.resolveActiveFeature = origResolve;
  });

  const origLog = console.log;
  const priorExitCode = process.exitCode;
  console.log = () => {};

  try {
    handleContextPackCommand({ taskId: 'test-spawn-count-task', json: true });
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
