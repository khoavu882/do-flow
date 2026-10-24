'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { resolveRegistrySource } = require('../../src/adapters/resolve-source.ts');

function registryFor(t) {
  return { repoRoot: tempDir(t, 'doflow-source-root-repo-') };
}

test('sourceRoot resolves a relative source inside the store and returns its real path', (t) => {
  const storeRoot = tempDir(t, 'doflow-source-root-relative-');
  const registry = registryFor(t);
  fs.writeFileSync(path.join(storeRoot, 'asset.txt'), 'asset');
  assert.equal(resolveRegistrySource(registry, 'asset.txt', 'relative', storeRoot),
    fs.realpathSync(path.join(storeRoot, 'asset.txt')));
});

test('sourceRoot resolves an absolute source inside the store and returns its real path', (t) => {
  const storeRoot = tempDir(t, 'doflow-source-root-absolute-');
  const registry = registryFor(t);
  const source = path.join(storeRoot, 'asset.txt');
  fs.writeFileSync(source, 'asset');
  assert.equal(resolveRegistrySource(registry, source, 'absolute', storeRoot), fs.realpathSync(source));
});

test('sourceRoot reached through a symlinked directory resolves its source', (t) => {
  const parent = tempDir(t, 'doflow-source-root-symlink-dir-');
  const registry = registryFor(t);
  const realRoot = path.join(parent, 'store');
  fs.mkdirSync(realRoot);
  const source = path.join(realRoot, 'asset.txt');
  fs.writeFileSync(source, 'asset');
  const linkedRoot = path.join(parent, 'store-link');
  fs.symlinkSync(realRoot, linkedRoot, 'dir');
  assert.equal(resolveRegistrySource(registry, 'asset.txt', 'linked', linkedRoot), fs.realpathSync(source));
});

test('sourceRoot refuses a lexical path that escapes with ..', (t) => {
  const parent = tempDir(t, 'doflow-source-root-dotdot-');
  const registry = registryFor(t);
  const storeRoot = path.join(parent, 'store');
  fs.mkdirSync(storeRoot);
  fs.writeFileSync(path.join(parent, 'outside.txt'), 'outside');
  assert.throws(() => resolveRegistrySource(registry, '../outside.txt', 'dotdot', storeRoot),
    /escapes source root/);
});

test('sourceRoot refuses a symlink inside the store that points outside it', (t) => {
  const parent = tempDir(t, 'doflow-source-root-symlink-');
  const registry = registryFor(t);
  const storeRoot = path.join(parent, 'store');
  fs.mkdirSync(storeRoot);
  const outside = path.join(parent, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(storeRoot, 'link.txt'));
  assert.throws(() => resolveRegistrySource(registry, 'link.txt', 'symlink', storeRoot),
    /escapes source root/);
});

test('sourceRoot reports a missing source under the store root', (t) => {
  const storeRoot = tempDir(t, 'doflow-source-root-missing-');
  const registry = registryFor(t);
  assert.throws(() => resolveRegistrySource(registry, 'missing.txt', 'missing', storeRoot),
    /missing under source root/);
});

test('without sourceRoot, repository-root lexical containment is preserved', (t) => {
  const registry = registryFor(t);
  fs.writeFileSync(path.join(registry.repoRoot, 'asset.txt'), 'asset');
  assert.equal(resolveRegistrySource(registry, 'asset.txt', 'legacy'),
    path.resolve(registry.repoRoot, 'asset.txt'));
  assert.throws(() => resolveRegistrySource(registry, '../outside.txt', 'legacy'),
    /escapes repository/);
});
