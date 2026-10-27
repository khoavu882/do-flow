'use strict';

// G1 — field recognition. A frontmatter key that no harness the asset deploys to actually
// recognizes is inert: it looks authoritative in the file and does nothing at runtime. Nothing in
// the install pipeline notices, because the pipeline validates structure (does it parse, does it
// copy) and never whether a declaration connects to anything real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRegistry, selectAssets } = require('../../src/registry/index.ts');
const { REPO, frontmatterKeys, skillFiles, agentSpecFiles } = require('./_shared.ts');

const registry = loadRegistry({ repoRoot: REPO });
const contractFor = (harness: any) => registry.contracts.find((c: any) => c.harness === harness);

/** Harnesses an asset id is actually projected to — a field only needs to be recognized somewhere
 * it is deployed. */
function harnessesFor(assetId: any) {
  return registry.harnesses
    .map((h: any) => h.id)
    .filter((id: any) => selectAssets(registry, { harness: id }).some((a: any) => a.id === assetId));
}

/** Agent-spec keys DoFlow reads itself and never projects (118 IC-002, IC-005): the adapters turn
 * `access` into each harness's own limit keys and drop it, so no harness has to recognize it.
 * `test/adapters/agent-limits-projection.test.ts` fails if `access` reaches any projected agent file:
 * it requires a transform on every harness that agents.shared applies to, renders each through it,
 * and runs the Codex copy path end to end. */
const DOFLOW_INTERNAL_AGENT_KEYS: any = new Set(['access']);

/** A key is a defect only when EVERY harness it ships to rejects it. Requiring the intersection
 * instead would flag `permissionMode`, which Claude genuinely honours, merely because a
 * lower-bound contract elsewhere does not list it. */
function unrecognized(keys: any, harnesses: any, field: any) {
  return keys.filter((key: any) => !harnesses.some((h: any) => (contractFor(h)?.[field] || []).includes(key)));
}

test('G1: every skill frontmatter key is recognized by at least one harness it deploys to', () => {
  const harnesses = harnessesFor('skills.doflow');
  assert.ok(harnesses.length, 'skills.doflow must project to at least one harness');
  const offenders: any = [];
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
  const offenders: any = [];
  for (const { name, file } of agentSpecFiles()) {
    const keys = frontmatterKeys(file).filter((key: any) => !DOFLOW_INTERNAL_AGENT_KEYS.has(key));
    for (const key of unrecognized(keys, harnesses, 'agentFields')) {
      offenders.push(`${name}: '${key}'`);
    }
  }
  assert.deepEqual(offenders, [], `unrecognized agent frontmatter keys:\n  ${offenders.join('\n  ')}`);
});
