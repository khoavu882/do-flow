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

test('context-profile guard: all 7 harnesses carry contextProfile with verified or unverified facts (085 A-19)', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.equal(registry.harnesses.length, 7, 'must declare exactly 7 harnesses');

  for (const harness of registry.harnesses) {
    assert.ok(harness.contextProfile, `harness '${harness.id}' must declare contextProfile block`);
    const profile = harness.contextProfile;

    for (const field of CONTEXT_PROFILE_FIELDS) {
      assert.ok(
        Object.hasOwn(profile, field),
        `harness '${harness.id}' contextProfile must contain '${field}'`
      );
      const fact = profile[field];
      assert.ok(fact && typeof fact === 'object', `harness '${harness.id}' fact '${field}' must be an object`);
      assert.ok(fact.verifiedOn, `harness '${harness.id}' fact '${field}' must carry verifiedOn`);
      if (fact.value !== undefined) {
        assert.ok(fact.source, `harness '${harness.id}' declared fact '${field}' must carry source`);
      } else {
        assert.ok(fact.unverified, `harness '${harness.id}' undeclared fact '${field}' must carry unverified reason`);
      }
    }
  }
});

test('context-profile guard: removing one field from one harness fails, naming the harness and the field (negative control)', () => {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  const harness = registry.harnesses.find((h: any) => h.id === 'claude');
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
  const harness = registry.harnesses.find((h: any) => h.id === 'antigravity');
  assert.ok(harness, "must find harness 'antigravity'");

  harness.contextProfile.capacityTokens = {
    value: 128000,
    verifiedOn: '2026-10-13',
  };

  const result = validateRegistry(registry, { repoRoot: REPO });
  assert.equal(result.ok, false, 'registry validation must fail when a declared value lacks source');
  const errorText = result.errors.join('\n');
  assert.match(
    errorText,
    /harness 'antigravity'.*contextProfile 'capacityTokens': a declared value requires a non-empty source/,
    'error must report missing source for declared value'
  );
});

test('context-profile guard: an extra key fails (negative control)', () => {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  const harness = registry.harnesses.find((h: any) => h.id === 'codex');
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
