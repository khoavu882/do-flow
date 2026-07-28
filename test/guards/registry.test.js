'use strict';

// G5 — registry truth. The only guard that reads src/ and core/harnesses/ as data. It answers a
// question no other test asks: does the registry describe the code that actually exists? A
// capability declared `unavailable` while its deployer ships is not a stale comment — it is
// published as fact in the generated capability map.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry, selectAssets } = require('../../src/registry');
const { REPO } = require('./_shared');

const registry = loadRegistry({ repoRoot: REPO });

/** Evidence that a capability is actually deployed: a native target, a projected asset, or
 * harness-native source content on disk. Existence only — never a behavioural claim, so this
 * stays decoupled from adapter internals. */
function deployed(harness, capability) {
  if (harness.nativeTargets?.[capability]) return true;
  if (selectAssets(registry, { harness: harness.id, capability }).length) return true;
  return fs.existsSync(path.join(REPO, 'core', 'harnesses', harness.id, capability));
}

// NOTE: `capabilities` states what the HARNESS supports, not what DoFlow chooses to deploy, so
// "supported but we ship nothing for it" is legitimate (`plugin` is marketplace discovery; `mcp`
// installs through a separate mechanism). Only the reverse direction is a contradiction. An
// earlier draft asserted supported => deployed and flagged claude.modes/claude.plugin/codex.plugin
// — that was the assertion being wrong, not the registry.
test('G5: every capability an asset actually projects is declared by its harness', () => {
  const offenders = [];
  for (const harness of registry.harnesses) {
    for (const asset of selectAssets(registry, { harness: harness.id })) {
      if (!asset.capability) continue;
      if (!harness.capabilities?.[asset.capability]) offenders.push(`${harness.id}: '${asset.capability}' (asset ${asset.id})`);
    }
  }
  assert.deepEqual(offenders, [], `assets project capabilities the harness never declares:\n  ${offenders.join('\n  ')}`);
});

test('G5: a capability marked unavailable has no deployer contradicting it', () => {
  const offenders = [];
  for (const harness of registry.harnesses) {
    for (const [capability, declaration] of Object.entries(harness.capabilities || {})) {
      if (declaration.status !== 'unavailable') continue;
      if (deployed(harness, capability)) offenders.push(`${harness.id}.${capability}`);
    }
  }
  assert.deepEqual(offenders, [],
    `declared unavailable while a deployer ships — the capability map publishes this as fact:\n  ${offenders.join('\n  ')}`);
});

// Only `supported` entries must exist in the harness contract. An `unavailable` entry names an
// event the harness deliberately does NOT have — recording that gap explicitly is the point, and
// requiring it to also be in the contract would make a gap impossible to express.
test('G5: every per-event hook status marked supported is in its harness contract', () => {
  const offenders = [];
  for (const harness of registry.harnesses) {
    const allowed = new Set(registry.contracts.find((c) => c.harness === harness.id)?.hookEvents || []);
    for (const [event, detail] of Object.entries(harness.capabilities?.hooks?.events || {})) {
      if (detail.status === 'supported' && !allowed.has(event)) offenders.push(`${harness.id}: '${event}'`);
    }
  }
  assert.deepEqual(offenders, [], `events declared supported but absent from the harness contract:\n  ${offenders.join('\n  ')}`);
});

test('G5: every unavailable event carries a note explaining why no equivalent exists', () => {
  const offenders = [];
  for (const harness of registry.harnesses) {
    for (const [event, detail] of Object.entries(harness.capabilities?.hooks?.events || {})) {
      if (detail.status === 'unavailable' && !detail.note) offenders.push(`${harness.id}: '${event}'`);
    }
  }
  assert.deepEqual(offenders, [], `an unrecorded gap is indistinguishable from an oversight:\n  ${offenders.join('\n  ')}`);
});
