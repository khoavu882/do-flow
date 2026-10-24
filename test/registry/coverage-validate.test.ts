'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadRegistry, validateCoverage } = require('../../src/registry/index.ts');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const ROOT = path.resolve(__dirname, '../..');
const base = loadRegistry({ repoRoot: ROOT });
function validate(block: any): string[] { const errors: string[] = []; validateCoverage(block, base.lifecycle, new Set(base.harnesses.map((item: any) => item.id)), errors); return errors; }

test('coverage validator rejects invalid enums, required fields, duplicate tuples and malformed digest', (t) => {
  const valid = JSON.parse(require('node:fs').readFileSync(path.join(ROOT, 'core/registry/lifecycle.json'), 'utf8')).coverage;
  assert.ok(!Object.hasOwn(valid, 'notShipped'), 'coverage has no retired notShipped list');
  assert.deepEqual(validate(valid), []);
  const badEnum = structuredClone(valid); badEnum.rows[0].class = 'almost-blocking';
  assert.ok(validate(badEnum).some((message) => message.includes('class')));
  const copiedRegistry = tempDir(t, 'doflow-coverage-validator-');
  fs.cpSync(path.join(ROOT, 'core/registry'), copiedRegistry, { recursive: true });
  const copiedLifecycle = path.join(copiedRegistry, 'lifecycle.json');
  const malformedRegistry = JSON.parse(fs.readFileSync(copiedLifecycle, 'utf8'));
  malformedRegistry.coverage.rows[0].class = 'almost-blocking';
  fs.writeFileSync(copiedLifecycle, JSON.stringify(malformedRegistry));
  assert.throws(() => loadRegistry({ repoRoot: ROOT, dir: copiedRegistry }), (error: any) => error.validation?.errors?.some((message: any) => message.includes('lifecycle.coverage.rows[0].class')));
  const missing = structuredClone(valid); delete missing.rows[0].harnessVersion;
  assert.ok(validate(missing).some((message) => message.includes('harnessVersion')));
  const duplicate = structuredClone(valid); duplicate.rows.push(structuredClone(duplicate.rows[0]));
  assert.ok(validate(duplicate).some((message) => message.includes('duplicates')));
  const malformedDigest = structuredClone(valid); malformedDigest.rowsDigest = 'sha256:BAD';
  assert.ok(validate(malformedDigest).some((message) => message.includes('rowsDigest')));
  assert.equal(base.coverage.rows.length, valid.rows.length, 'shipped registry loads through the coverage validator');
});

// Feature 078, IC-017 and IC-018: the endOfTurn and behaviours blocks beside coverage.rows.
const shipped = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'core/registry/lifecycle.json'), 'utf8')).coverage;

test('IC-017, IC-018: the shipped blocks load and validate, one entry per harness and per behaviour × harness', () => {
  const coverage = shipped();
  assert.deepEqual(validate(coverage), []);
  assert.equal(coverage.revision, 3);
  assert.equal(base.coverage.endOfTurn.length, base.harnesses.length, 'the shipped registry loads with endOfTurn');
  assert.equal(base.coverage.behaviours.length, 6 * base.harnesses.length, 'and with behaviours (48 pairs)');
  for (const entry of coverage.behaviours.filter((item: any) => item.status === 'enforced')) {
    for (const file of entry.tests) assert.ok(fs.existsSync(path.join(ROOT, file)), `${entry.behaviour}/${entry.harness}: ${file} exists`);
  }
  assert.ok(coverage.behaviours.filter((item: any) => item.behaviour === 'identity').every((item: any) => item.status === 'limitation'), 'identity stays a limitation (DEC-004)');
});

test('IC-017: a missing harness in endOfTurn is rejected', () => {
  const coverage = shipped(); coverage.endOfTurn = coverage.endOfTurn.filter((item: any) => item.harness !== 'gemini');
  assert.ok(validate(coverage).some((message) => message.includes('endOfTurn') && message.includes("harness 'gemini'")));
});

test('IC-017: a non-empty events without doc or types provenance is rejected, and empty events needs none', () => {
  const unsourced = shipped(); unsourced.endOfTurn.find((item: any) => item.harness === 'claude').provenance = [];
  assert.ok(validate(unsourced).some((message) => message.includes('endOfTurn[0].provenance') && message.includes('doc or types')));
  const unexplained = shipped(); delete unexplained.endOfTurn.find((item: any) => item.harness === 'gemini').none;
  assert.ok(validate(unexplained).some((message) => message.includes('.none')));
});

test('IC-018: a missing harness and a duplicate behaviour × harness pair are rejected', () => {
  const missing = shipped(); missing.behaviours = missing.behaviours.filter((item: any) => !(item.behaviour === 'identity' && item.harness === 'pi'));
  assert.ok(validate(missing).some((message) => message.includes("missing an entry for identity × harness 'pi'")));
  const duplicate = shipped(); duplicate.behaviours.push(structuredClone(duplicate.behaviours[0]));
  assert.ok(validate(duplicate).some((message) => message.includes("duplicates behaviour 'context-authority' × harness 'claude'")));
});

test('IC-018: an empty limitation and an enforced entry without tests are rejected', () => {
  const empty = shipped(); empty.behaviours.find((item: any) => item.status === 'limitation').limitation = '  ';
  assert.ok(validate(empty).some((message) => message.includes('.limitation') && message.includes('non-empty')));
  const untested = shipped(); untested.behaviours.find((item: any) => item.status === 'enforced').tests = [];
  assert.ok(validate(untested).some((message) => message.includes('.tests')));
});
