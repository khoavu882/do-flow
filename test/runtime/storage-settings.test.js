'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry');
const { resolveRoots, readPruneSetting, resolveStorePath } = require('../../src/runtime/storage/roots');

const REPO = path.resolve(__dirname, '../..');
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

function setup(t, { xdg = 'xdg', global = false } = {}) {
  const dir = tempDir(t, 'doflow-storage-settings-');
  const project = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const xdgPath = path.isAbsolute(xdg) ? xdg : path.join(dir, xdg);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (!path.isAbsolute(xdg)) fs.mkdirSync(xdgPath, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: path.isAbsolute(xdg) ? xdg : xdgPath };
  const registry = loadStorageRegistry({ repoRoot: REPO });
  return { dir, project, home, xdg: xdgPath, env, registry, roots: resolveRoots({ registry, projectRoot: project, global, env }) };
}
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function projectPrune(s) { return path.join(s.project, '.doflow', 'prune'); }
function userPrune(s) { return path.join(s.xdg, 'doflow', 'prune'); }

test('IC-014: project setting overrides user setting only for project roots and returns deciding file', (t) => {
  const s = setup(t); write(userPrune(s), 'off\n'); write(projectPrune(s), 'on\n');
  const project = readPruneSetting({ registry: s.registry, roots: s.roots, rootId: 'project-state' });
  const user = readPruneSetting({ registry: s.registry, roots: s.roots, rootId: 'user-state' });
  const config = readPruneSetting({ registry: s.registry, roots: s.roots, rootId: 'config-home' });
  assert.deepEqual(project, { setting: 'on', decidedBy: projectPrune(s) });
  assert.deepEqual(user, { setting: 'off', decidedBy: userPrune(s) });
  assert.deepEqual(config, { setting: 'off', decidedBy: userPrune(s) });
});

test('IC-014: project off, neither setting, and malformed settings are off', (t) => {
  const s = setup(t); write(userPrune(s), 'on\n'); write(projectPrune(s), 'off\n');
  assert.deepEqual(readPruneSetting({ registry: s.registry, roots: s.roots, rootId: 'project-doflow' }), { setting: 'off', decidedBy: projectPrune(s) });
  fs.rmSync(projectPrune(s)); fs.rmSync(userPrune(s));
  assert.deepEqual(readPruneSetting({ registry: s.registry, roots: s.roots, rootId: 'project-state' }), { setting: 'on', decidedBy: null });
  for (const content of ['', 'maybe\n', ' OFF \n']) {
    write(userPrune(s), content);
    assert.deepEqual(readPruneSetting({ registry: s.registry, roots: s.roots, rootId: 'user-state' }), { setting: 'off', decidedBy: userPrune(s) });
  }
});

test('IC-014: unreadable user setting is off', { skip: process.platform === 'win32' || ROOT_USER }, (t) => {
  const s = setup(t); write(userPrune(s), 'on\n'); fs.chmodSync(userPrune(s), 0);
  t.after(() => { if (fs.existsSync(userPrune(s))) fs.chmodSync(userPrune(s), 0o600); });
  assert.deepEqual(readPruneSetting({ registry: s.registry, roots: s.roots, rootId: 'user-state' }), { setting: 'off', decidedBy: userPrune(s) });
});

test('roots resolve project, global, and absolute XDG config paths', (t) => {
  const s = setup(t);
  assert.equal(s.roots['project-doflow'], path.join(s.project, '.doflow'));
  assert.equal(s.roots['project-state'], path.join(s.project, '.doflow', 'state'));
  assert.equal(s.roots['user-doflow'], path.join(s.home, '.doflow'));
  assert.equal(s.roots['user-state'], path.join(s.home, '.doflow', 'state'));
  assert.equal(s.roots['config-home'], path.join(s.xdg, 'doflow'));
  const globalRoots = resolveRoots({ registry: s.registry, projectRoot: s.project, global: true, env: s.env });
  assert.equal(globalRoots['project-doflow'], null); assert.equal(globalRoots['project-state'], null);
  const absolute = path.join(s.dir, 'absolute-xdg'); fs.mkdirSync(absolute);
  const absoluteRoots = resolveRoots({ registry: s.registry, projectRoot: s.project, env: { HOME: s.home, XDG_CONFIG_HOME: absolute } });
  assert.equal(absoluteRoots['config-home'], path.join(absolute, 'doflow'));
});

test('roots ignore a relative XDG config path', (t) => {
  const s = setup(t);
  const roots = resolveRoots({ registry: s.registry, projectRoot: s.project, env: { HOME: s.home, XDG_CONFIG_HOME: 'relative-xdg' } });
  assert.equal(roots['config-home'], null);
});

test('IC-006 P0: a symbolic link in a DoFlow-owned path component refuses the store', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t); const outside = path.join(s.dir, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(s.project, '.doflow'), { recursive: true });
  fs.symlinkSync(outside, path.join(s.project, '.doflow', 'state'));
  const store = s.registry.stores.find((item) => item.id === 'verification-logs');
  assert.equal(resolveStorePath({ store, roots: s.roots }), null);
});
