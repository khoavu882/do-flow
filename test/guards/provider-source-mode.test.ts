'use strict';

// Every capability provider declares how it answers (`sourceMode`: live or index), and every
// index-backed provider has an artifact layout in health.ts PROVIDER_ARTIFACTS (feature 068).
//
// Without a layout the freshness probe returns null and the retrieval plan can only say UNKNOWN for
// that provider. That is the safe outcome, but it means the provider's index age is never measured,
// so an index provider added without a layout is a gap to decide on purpose. EXPLAINED_UNMEASURED
// is where that decision is written down; it is empty because both shipped index providers have one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { PROVIDER_ARTIFACTS } = require('../../src/runtime/health.ts');

const SOURCE_MODES: any = ['live', 'index'];
/** provider id -> why it is index-backed yet has no PROVIDER_ARTIFACTS entry. */
const EXPLAINED_UNMEASURED: any = {};

const { capabilities } = loadRegistry({ repoRoot: REPO });
const declarations = Object.entries(capabilities).flatMap(([capabilityId, capability]) => capability.providers
  .map((provider: any) => ({ capabilityId, provider })));

test('every capability provider declares sourceMode as live or index', () => {
  const bad = declarations
    .filter(({ provider }) => !SOURCE_MODES.includes(provider.sourceMode))
    .map(({ capabilityId, provider }) => `${capabilityId}/${provider.id}: ${JSON.stringify(provider.sourceMode)}`);
  assert.deepEqual(bad, [], `providers without a valid sourceMode (${SOURCE_MODES.join('|')}) in core/registry/capabilities.json`);
});

test('a provider id declares the same sourceMode under every capability', () => {
  const modes: any = new Map();
  for (const { provider } of declarations) {
    modes.set(provider.id, new Set([...(modes.get(provider.id) || []), provider.sourceMode]));
  }
  const mixed = [...modes].filter(([, set]) => set.size > 1).map(([id, set]) => `${id}: ${[...set].join(', ')}`);
  assert.deepEqual(mixed, []);
});

test('every index provider has a PROVIDER_ARTIFACTS layout, or an explained reason it does not', () => {
  const unmeasured: any = [...new Set(declarations.filter(({ provider }) => provider.sourceMode === 'index').map(({ provider }) => provider.id))]
    .filter((id) => !PROVIDER_ARTIFACTS[id] && !EXPLAINED_UNMEASURED[id]);
  assert.deepEqual(unmeasured, [], `index providers with no artifact layout in ${path.join('src', 'runtime', 'health.ts')} and no entry in EXPLAINED_UNMEASURED`);
  for (const [id, reason] of Object.entries(EXPLAINED_UNMEASURED)) {
    assert.ok(reason && reason.length > 20, `${id}: the explanation must say why`);
    assert.ok(!PROVIDER_ARTIFACTS[id], `${id} now has a layout; drop its EXPLAINED_UNMEASURED entry`);
  }
});

test('every PROVIDER_ARTIFACTS entry belongs to a provider declared index', () => {
  const index: any = new Set(declarations.filter(({ provider }) => provider.sourceMode === 'index').map(({ provider }) => provider.id));
  const stray = Object.keys(PROVIDER_ARTIFACTS).filter((id) => !index.has(id));
  assert.deepEqual(stray, [], 'a provider with an artifact layout is index-backed and must say so');
});
