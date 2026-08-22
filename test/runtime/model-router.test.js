'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveModelRole, availableProviderIds, BACKEND_CLI } = require('../../src/runtime/model-router');
const { loadRegistry } = require('../../src/registry');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const registry = loadRegistry({ repoRoot: REPO });

test('every shipped role resolves against real providers, tiers bound in models.yaml', () => {
  for (const roleId of registry.modelRoles.map((r) => r.id)) {
    const resolution = resolveModelRole({ registry, roleId });
    assert.ok(resolution.candidates.length >= 3, `${roleId} sees all declared providers`);
    if (resolution.policy.prefer) {
      assert.ok(resolution.candidates.some((c) => c.servesPreferredTier),
        `${roleId}'s preferred tier '${resolution.policy.prefer}' must be served by at least one provider`);
    }
  }
});

test('ordering: available backends first, then preferred-tier match, registry order breaking ties', () => {
  const resolution = resolveModelRole({
    registry,
    roleId: 'reasoning',
    isAvailable: (id) => id === 'ollama', // only local backend installed
  });
  // ollama is the only available one → first despite not serving capable-long.
  assert.equal(resolution.candidates[0].id, 'ollama');
  const claude = resolution.candidates.find((c) => c.id === 'claude');
  assert.equal(claude.available, false);
  assert.equal(claude.servesPreferredTier, true, 'claude serves capable-long');
  // Among unavailable candidates, tier match outranks registry order:
  // claude (serves capable-long) sits directly behind the only installed backend.
  const order = resolution.candidates.map((c) => c.id);
  assert.equal(order.indexOf('claude'), 1);
  assert.ok(order.indexOf('codex') > order.indexOf('claude'));
  assert.ok(order.indexOf('copilot') > order.indexOf('claude'));
});

test('triage prefers cheap-fast: tier-matched unavailable beats unmatched available? No — availability dominates', () => {
  const resolution = resolveModelRole({
    registry,
    roleId: 'triage',
    isAvailable: (id) => id === 'claude',
  });
  assert.equal(resolution.candidates[0].id, 'claude', 'an installed backend is usable; a matching-but-absent one is not');
  assert.ok(resolution.candidates.slice(1).some((c) => c.servesPreferredTier));
});

test('review with exclude drops the implementer and reports it, per different-family policy', () => {
  const resolution = resolveModelRole({
    registry,
    roleId: 'review',
    isAvailable: () => true,
    exclude: ['claude'],
  });
  assert.ok(!resolution.candidates.some((c) => c.id === 'claude'));
  assert.deepEqual(resolution.excluded, ['claude']);
  assert.equal(resolution.policy.require, 'different-family');
});

test('unknown roles are rejected with the valid set; ids are never guessed', () => {
  try {
    resolveModelRole({ registry, roleId: 'vibes' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, /Unknown model role 'vibes'/);
    for (const valid of registry.modelRoles.map((r) => r.id)) assert.match(error.message, new RegExp(valid));
  }
});

test('availability probe scans PATH via fs only (no spawn), injectable everywhere', () => {
  const fakeFs = {
    accessSync(p) {
      if (String(p).endsWith(path.sep + 'ollama')) return;
      throw new Error('ENOENT');
    },
    constants: { X_OK: 1 },
  };
  const ids = availableProviderIds({
    fsImpl: fakeFs,
    pathEnv: '/usr/bin:/usr/local/bin',
  });
  assert.deepEqual(ids, ['ollama']);
  assert.equal(BACKEND_CLI.claude, 'claude');
});
