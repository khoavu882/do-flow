'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveModelRole, resolveRetrievalSlot, availableProviderIds, BACKEND_CLI } = require('../../src/runtime/model-router');
const { loadRegistry } = require('../../src/registry');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const registry = loadRegistry({ repoRoot: REPO });

test('every shipped role resolves against real providers, tiers bound in models.json', () => {
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

test('absent slots resolve inactive and leave role routing byte-identical', () => {
  // Shipped registry declares no slots: both lookups stay lexical, no throw.
  for (const slotId of ['dense', 'rerank']) {
    const resolution = resolveRetrievalSlot({ registry, slotId });
    assert.deepEqual(resolution, { slotId, active: false, reason: 'undeclared' });
  }
  // Adding disabled slots to a fixture must not perturb role routing at all — the outputs are
  // deep-equal with and without them.
  const base = {
    modelProviders: structuredClone(registry.modelProviders),
    modelRoles: structuredClone(registry.modelRoles),
  };
  const without = resolveModelRole({ registry: base, roleId: 'triage' });
  const withDisabled = resolveModelRole({
    registry: { ...base, retrievalSlots: [
      { id: 'dense', provider: 'ollama', model: 'nomic-embed-text', enabled: false },
      { id: 'rerank', provider: 'ollama', model: 'bge-reranker-base', enabled: false },
    ] },
    roleId: 'triage',
  });
  assert.deepEqual(without, withDisabled);
});

test('an enabled dense slot routes through its bound provider with probed availability', () => {
  const slotted = {
    ...registry,
    retrievalSlots: [{ id: 'dense', provider: 'ollama', model: 'nomic-embed-text', enabled: true }],
  };
  const installed = resolveRetrievalSlot({ registry: slotted, slotId: 'dense', isAvailable: (id) => id === 'ollama' });
  assert.equal(installed.active, true);
  assert.equal(installed.provider, 'ollama');
  assert.equal(installed.model, 'nomic-embed-text');
  assert.equal(installed.kind, 'local');
  assert.equal(installed.backendCli, 'ollama');
  assert.equal(installed.available, true);
  // Same slot, backend absent: still reported, availability false — the caller stays lexical
  // rather than guessing; the binding itself is never hidden.
  const missing = resolveRetrievalSlot({ registry: slotted, slotId: 'dense', isAvailable: () => false });
  assert.equal(missing.active, true);
  assert.equal(missing.available, false);
  // No probe supplied: unknown stays null, never guessed into either boolean.
  const unprobed = resolveRetrievalSlot({ registry: slotted, slotId: 'dense' });
  assert.equal(unprobed.available, null);
});

test('a declared-but-disabled slot resolves inactive with its reason reported', () => {
  const slotted = {
    ...registry,
    retrievalSlots: [{ id: 'rerank', provider: 'ollama', model: 'bge-reranker-base', enabled: false }],
  };
  assert.deepEqual(resolveRetrievalSlot({ registry: slotted, slotId: 'rerank' }), {
    slotId: 'rerank', active: false, reason: 'disabled',
  });
});
