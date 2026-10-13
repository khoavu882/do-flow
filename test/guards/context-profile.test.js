'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadRegistry,
  validateRegistry,
  CONTEXT_PROFILE_FIELDS,
} = require('../../src/registry/index.ts');

const REPO = path.resolve(__dirname, '../..');

test('context-profile guard: all 8 harnesses carry contextProfile with every value unverified in 075 (FR-016)', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.equal(registry.harnesses.length, 8, 'must declare exactly 8 harnesses');

  const EXPECTED_UNVERIFIED = 'values belong to 085 (A-19)';
  const EXPECTED_DATE = '2026-10-13';

  for (const harness of registry.harnesses) {
    assert.ok(harness.contextProfile, `harness '${harness.id}' must declare contextProfile block`);
    const profile = harness.contextProfile;

    for (const field of CONTEXT_PROFILE_FIELDS) {
      assert.ok(
        Object.hasOwn(profile, field),
        `harness '${harness.id}' contextProfile must contain '${field}'`
      );
      const fact = profile[field];
      assert.equal(
        fact.unverified,
        EXPECTED_UNVERIFIED,
        `harness '${harness.id}' ${field}.unverified must match 075 contract`
      );
      assert.equal(
        fact.verifiedOn,
        EXPECTED_DATE,
        `harness '${harness.id}' ${field}.verifiedOn must match 075 date`
      );
      assert.equal(
        Object.hasOwn(fact, 'value'),
        false,
        `harness '${harness.id}' ${field} must not declare a value in 075`
      );
    }
  }
});

test('context-profile guard: removing one field from one harness fails, naming the harness and the field (negative control)', () => {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  const harness = registry.harnesses.find((h) => h.id === 'claude');
  assert.ok(harness, "must find harness 'claude'");

  delete harness.contextProfile.capacityTokens;

  const result = validateRegistry(registry, { repoRoot: REPO });
  assert.equal(result.ok, false, 'registry validation must fail when a field is removed');
  const errorText = result.errors.join('\n');
  assert.match(
    errorText,
    /harness 'claude'.*missing field 'capacityTokens'/,
    'error must name the harness and the missing field'
  );
});

test('context-profile guard: a declared value without source fails (negative control)', () => {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  const harness = registry.harnesses.find((h) => h.id === 'gemini');
  assert.ok(harness, "must find harness 'gemini'");

  harness.contextProfile.capacityTokens = {
    value: 128000,
    verifiedOn: '2026-10-13',
  };

  const result = validateRegistry(registry, { repoRoot: REPO });
  assert.equal(result.ok, false, 'registry validation must fail when a declared value lacks source');
  const errorText = result.errors.join('\n');
  assert.match(
    errorText,
    /harness 'gemini'.*contextProfile 'capacityTokens': a declared value requires a non-empty source/,
    'error must report missing source for declared value'
  );
});

test('context-profile guard: an extra key fails (negative control)', () => {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  const harness = registry.harnesses.find((h) => h.id === 'codex');
  assert.ok(harness, "must find harness 'codex'");

  harness.contextProfile.unauthorizedKey = {
    unverified: 'extra key',
    verifiedOn: '2026-10-13',
  };

  const result = validateRegistry(registry, { repoRoot: REPO });
  assert.equal(result.ok, false, 'registry validation must fail when an extra key is added');
  const errorText = result.errors.join('\n');
  assert.match(
    errorText,
    /harness 'codex'.*contextProfile has unknown key 'unauthorizedKey'/,
    'error must name the harness and the unknown key'
  );
});
