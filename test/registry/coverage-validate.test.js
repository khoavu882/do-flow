'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadRegistry, validateCoverage } = require('../../src/registry/index.ts');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const ROOT = path.resolve(__dirname, '../..');
const base = loadRegistry({ repoRoot: ROOT });
function validate(block) { const errors = []; validateCoverage(block, base.lifecycle, new Set(base.harnesses.map((item) => item.id)), errors); return errors; }

test('coverage validator rejects invalid enums, required fields, duplicate tuples and malformed digest', (t) => {
  const valid = JSON.parse(require('node:fs').readFileSync(path.join(ROOT, 'core/registry/lifecycle.json'), 'utf8')).coverage;
  assert.deepEqual(validate(valid), []);
  const badEnum = structuredClone(valid); badEnum.rows[0].class = 'almost-blocking';
  assert.ok(validate(badEnum).some((message) => message.includes('class')));
  const copiedRegistry = tempDir(t, 'doflow-coverage-validator-');
  fs.cpSync(path.join(ROOT, 'core/registry'), copiedRegistry, { recursive: true });
  const copiedLifecycle = path.join(copiedRegistry, 'lifecycle.json');
  const malformedRegistry = JSON.parse(fs.readFileSync(copiedLifecycle, 'utf8'));
  malformedRegistry.coverage.rows[0].class = 'almost-blocking';
  fs.writeFileSync(copiedLifecycle, JSON.stringify(malformedRegistry));
  assert.throws(() => loadRegistry({ repoRoot: ROOT, dir: copiedRegistry }), (error) => error.validation?.errors?.some((message) => message.includes('lifecycle.coverage.rows[0].class')));
  const missing = structuredClone(valid); delete missing.rows[0].harnessVersion;
  assert.ok(validate(missing).some((message) => message.includes('harnessVersion')));
  const duplicate = structuredClone(valid); duplicate.rows.push(structuredClone(duplicate.rows[0]));
  assert.ok(validate(duplicate).some((message) => message.includes('duplicates')));
  const malformedDigest = structuredClone(valid); malformedDigest.rowsDigest = 'sha256:BAD';
  assert.ok(validate(malformedDigest).some((message) => message.includes('rowsDigest')));
  assert.equal(base.coverage.rows.length, valid.rows.length, 'shipped registry loads through the coverage validator');
});
