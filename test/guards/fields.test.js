'use strict';

// G1 — field recognition. A frontmatter key that no harness the asset deploys to actually
// recognizes is inert: it looks authoritative in the file and does nothing at runtime. Nothing in
// the install pipeline notices, because the pipeline validates structure (does it parse, does it
// copy) and never whether a declaration connects to anything real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRegistry, selectAssets } = require('../../src/registry');
const { REPO, frontmatterKeys, skillFiles, agentSpecFiles } = require('./_shared');

const registry = loadRegistry({ repoRoot: REPO });
const contractFor = (harness) => registry.contracts.find((c) => c.harness === harness);

/** Harnesses an asset id is actually projected to — a field only needs to be recognized somewhere
 * it is deployed. */
function harnessesFor(assetId) {
  return registry.harnesses
    .map((h) => h.id)
    .filter((id) => selectAssets(registry, { harness: id }).some((a) => a.id === assetId));
}

/** A key is a defect only when EVERY harness it ships to rejects it. Requiring the intersection
 * instead would flag `permissionMode`, which Claude genuinely honours, merely because a
 * lower-bound contract elsewhere does not list it. */
function unrecognized(keys, harnesses, field) {
  return keys.filter((key) => !harnesses.some((h) => (contractFor(h)?.[field] || []).includes(key)));
}

test('G1: every skill frontmatter key is recognized by at least one harness it deploys to', () => {
  const harnesses = harnessesFor('skills.doflow');
  assert.ok(harnesses.length, 'skills.doflow must project to at least one harness');
  const offenders = [];
  for (const { name, file } of skillFiles()) {
    for (const key of unrecognized(frontmatterKeys(file), harnesses, 'skillFields')) {
      offenders.push(`${name}: '${key}'`);
    }
  }
  assert.deepEqual(offenders, [], `unrecognized skill frontmatter keys:\n  ${offenders.join('\n  ')}`);
});

test('G1: every agent-spec frontmatter key is recognized by at least one harness it deploys to', () => {
  const harnesses = harnessesFor('agents.shared');
  assert.ok(harnesses.length, 'agents.shared must project to at least one harness');
  const offenders = [];
  for (const { name, file } of agentSpecFiles()) {
    for (const key of unrecognized(frontmatterKeys(file), harnesses, 'agentFields')) {
      offenders.push(`${name}: '${key}'`);
    }
  }
  assert.deepEqual(offenders, [], `unrecognized agent frontmatter keys:\n  ${offenders.join('\n  ')}`);
});
