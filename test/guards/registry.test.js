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

// FR-007 extension contract (design.md §4, "Adding a harness"): a harness declared in
// harnesses.yaml is not actually usable until three other things agree with it. This is the exact
// defect the multi-harness-parity feature exists to prevent recurring — opencode and pi were
// declared in the registry for a time with no adapter module wired to dispatch, no contract entry,
// and no --target id, i.e. present on paper but unreachable by any real command.
test('G5: every declared harness has an adapter module, exactly one contract, and a valid --target id', () => {
  const { VALID } = require('../../src/targets');
  const offenders = [];
  for (const harness of registry.harnesses) {
    const dirAdapter = path.join(REPO, 'src', 'adapters', harness.adapter, 'index.js');
    const fileAdapter = path.join(REPO, 'src', 'adapters', `${harness.adapter}.js`);
    if (!fs.existsSync(dirAdapter) && !fs.existsSync(fileAdapter)) {
      offenders.push(`${harness.id}: no adapter module at src/adapters/${harness.adapter}/index.js or src/adapters/${harness.adapter}.js`);
    }
    const contractCount = registry.contracts.filter((c) => c.harness === harness.id).length;
    if (contractCount !== 1) {
      offenders.push(`${harness.id}: expected exactly one contracts.yaml entry, found ${contractCount}`);
    }
    if (!VALID.includes(harness.id)) {
      offenders.push(`${harness.id}: not in src/targets.js's VALID array, so '--target ${harness.id}' would be rejected`);
    }
  }
  assert.deepEqual(offenders, [], `harness declared without a full extension contract:\n  ${offenders.join('\n  ')}`);
});

// A module existing on disk is not the same as it being reachable: src/lifecycle/view.js once kept
// its own, separate adapter registry that silently fell behind the one in bin/doflow.js (fixed in
// 96006da). Grep every createAdapterRegistry({...}) call site — install, update, and remove in
// bin/doflow.js, plus the one shared by src/lifecycle/view.js — and confirm each declared harness's
// id is actually passed in as a key, not just that its file exists somewhere under src/adapters/.
test('G5: every declared harness is wired into every createAdapterRegistry(...) dispatch call site', () => {
  const files = [
    path.join(REPO, 'bin', 'doflow.js'),
    path.join(REPO, 'src', 'lifecycle', 'view.js'),
  ];
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const blocks = [...text.matchAll(/createAdapterRegistry\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
    if (blocks.length === 0) {
      offenders.push(`${path.relative(REPO, file)}: no createAdapterRegistry({...}) call site found`);
      continue;
    }
    blocks.forEach((block, i) => {
      for (const harness of registry.harnesses) {
        const key = new RegExp(`(^|[{,]|\\s)${harness.id}\\s*:`);
        if (!key.test(block)) {
          offenders.push(`${path.relative(REPO, file)}: createAdapterRegistry call #${i + 1} is missing the '${harness.id}' key`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `a declared harness is not wired into dispatch:\n  ${offenders.join('\n  ')}`);
});
