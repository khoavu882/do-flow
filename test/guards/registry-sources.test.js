'use strict';

// G48 — registry source mode (feature 109, IC-001 / FR-001, FR-002).
//
// The source tree requires every declared source and asset to exist (package checkout / dev tree).
// An installed runtime ships only bin/, src/, and core/registry/ (no shared assets or harness-native
// sources); verbs running from an installed runtime must load the registry in skip mode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { loadRegistry, validateRegistry, registrySourceMode } = require('../../src/registry/index.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

function makeRuntimeShapedTree() {
  const root = suiteTempDir('doflow-g46-runtime-');
  fs.cpSync(path.join(REPO, 'bin'), path.join(root, 'bin'), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.cpSync(path.join(REPO, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  return root;
}

test('G48: the source tree loads in require mode with validation.sources === "require"', () => {
  assert.equal(registrySourceMode(REPO), 'require');
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.equal(registry.validation.sources, 'require');

  // Negative control: a missing asset source fails validation in require mode
  const mutated = structuredClone(registry);
  mutated.assets[0].source = 'core/shared/nonexistent-for-g46.md';
  const control = validateRegistry(mutated, { repoRoot: REPO, sources: 'require' });
  assert.equal(control.ok, false);
  assert.match(control.errors.join('\n'), /source does not exist inside repository: core\/shared\/nonexistent-for-g46\.md/);
});

test('G48: a runtime-shaped copy loads with skip mode and validation.sources === "skip"', () => {
  const runtimeRoot = makeRuntimeShapedTree();
  assert.equal(registrySourceMode(runtimeRoot), 'skip');

  const registry = loadRegistry({ repoRoot: runtimeRoot });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.equal(registry.validation.sources, 'skip');
  assert.deepEqual(registry.validation.errors, []);

  // Negative control: a path resolving outside repoRoot still fails even in skip mode
  const mutated = structuredClone(registry);
  mutated.assets[0].source = '../escaped-g46.md';
  const control = validateRegistry(mutated, { repoRoot: runtimeRoot, sources: 'skip' });
  assert.equal(control.ok, false);
  assert.match(control.errors.join('\n'), /source does not exist inside repository: \.\.\/escaped-g46\.md/);
});

test('G48: a runtime-shaped copy fails in require mode with missing-source lines', () => {
  const runtimeRoot = makeRuntimeShapedTree();
  const registry = loadRegistry({ repoRoot: runtimeRoot });

  const result = validateRegistry(registry, { repoRoot: runtimeRoot, sources: 'require' });
  assert.equal(result.ok, false);
  assert.equal(result.sources, 'require');
  assert.equal(result.errors.length, 24);

  for (const error of result.errors) {
    assert.match(error, /source does not exist inside repository: /);
  }

  // Negative control: loadRegistry in require mode must throw the Invalid DoFlow registry error
  assert.throws(
    () => loadRegistry({ repoRoot: runtimeRoot, sources: 'require' }),
    (err) => {
      assert.match(err.message, /^Invalid DoFlow registry:\n- /);
      assert.equal(err.validation.ok, false);
      assert.equal(err.validation.sources, 'require');
      assert.equal(err.validation.errors.length, 24);
      return true;
    },
  );
});
