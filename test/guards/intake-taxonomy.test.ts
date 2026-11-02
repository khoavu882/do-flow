'use strict';

// G-136a — core/registry/intake.json keeps its closed shape (136 IC-005, NFR-004). The category list is data that
// docs/guide.md renders and the intake engine reads, so a malformed file must fail here, before an install does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { validateTaxonomy, loadTaxonomy } = require('../../src/runtime/intake/taxonomy.ts');

const FILE = path.join(REPO, 'core', 'registry', 'intake.json');
const read = (): any => JSON.parse(fs.readFileSync(FILE, 'utf8'));

test('intake.json holds the closed shape: no finding', () => {
  assert.deepEqual(validateTaxonomy(read()).errors, []);
  assert.equal(loadTaxonomy({ repoRoot: REPO, contributions: false }).ok, true);
});

test('a malformed registry fails the guard: an unknown key, a duplicate name and a bad pattern are each named', () => {
  const reg = read();
  reg.categories[0].colour = 'red';
  reg.categories[3].names.push(reg.categories[2].names[0]);
  reg.categories[0].rules[0].namePattern = '[';
  const errors = validateTaxonomy(reg).errors;
  assert.ok(errors.some((m: string) => /colour is not an allowed key/.test(m)), errors.join('; '));
  assert.ok(errors.some((m: string) => /is used by both/.test(m)), errors.join('; '));
  assert.ok(errors.some((m: string) => /namePattern does not compile/.test(m)), errors.join('; '));
});

test('the promptCategory names a category without rules', () => {
  const reg = read();
  const prompt = reg.categories.find((c: any) => c.id === reg.promptCategory);
  assert.ok(prompt, `promptCategory '${reg.promptCategory}' must be a category id`);
  assert.deepEqual(prompt.rules, []);
});
