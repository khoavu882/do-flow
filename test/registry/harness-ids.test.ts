'use strict';
// Row 171 IC-004: the active harness ids, their binaries and the retired ids come from
// core/registry/harnesses.json, so a ninth harness is a registry edit and no list changes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { idsFrom, activeIds, binaryOf, retiredIds } = require('../../src/registry/harness-ids.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8'));

/** A scratch root holding a copy of harnesses.json with `mutate` applied. */
function scratchRoot(t: any, mutate: (registry: any) => void): string {
  const root = tempDir(t, 'doflow-harness-ids-');
  fs.mkdirSync(path.join(root, 'core', 'registry'), { recursive: true });
  const registry = structuredClone(REGISTRY);
  mutate(registry);
  fs.writeFileSync(path.join(root, 'core', 'registry', 'harnesses.json'), JSON.stringify(registry));
  return root;
}

// The one hand-written list of the active harness ids in the test suite, and the one place their order is
// written (row 171 A-1, A-3). Every other test and fixture that needs all of them reads
// test/helper/harness-ids.ts, which returns activeIds(); G83 fails on any other literal holding every id.
// Adding a harness edits core/registry/harnesses.json and this list.
test('the active harnesses are exactly these', () => {
  assert.deepEqual(activeIds(), ['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']);
});

test('activeIds reads the given root: a scratch root with a ninth id appends it in file order', (t) => {
  const root = scratchRoot(t, (r) => r.harnesses.push({ ...structuredClone(r.harnesses[0]), id: 'ninth' }));
  assert.deepEqual(activeIds(root), [...activeIds(), 'ninth']);
  assert.equal(activeIds(root).length, activeIds().length + 1);
});

test('binaryOf names a harness binary, reads the given root, and is null for an unknown id', (t) => {
  assert.equal(binaryOf('kiro'), 'kiro-cli');
  assert.equal(binaryOf('antigravity'), 'agy');
  assert.equal(binaryOf('nope'), null);
  const root = scratchRoot(t, (r) => r.harnesses.push({ ...structuredClone(r.harnesses[0]), id: 'ninth', worker: { cli: { binary: 'ninth-bin' } } }));
  assert.equal(binaryOf('ninth', root), 'ninth-bin');
});

test('retiredIds names the retired ids and is empty when the registry has none', (t) => {
  assert.deepEqual(retiredIds(), ['gemini']);
  assert.deepEqual(retiredIds(scratchRoot(t, (r) => { delete r.retired; })), []);
});

test('idsFrom reads a registry object; a harness without a worker binary has no entry', (t) => {
  const out = idsFrom({ harnesses: [{ id: 'a', worker: { cli: { binary: 'abin' } } }, { id: 'b' }], retired: [{ id: 'z' }] });
  assert.deepEqual(out.active, ['a', 'b']);
  assert.deepEqual(out.binaries, { a: 'abin' });
  assert.deepEqual(out.retired, ['z']);
});

test('the lists are frozen', (t) => {
  assert.ok(Object.isFrozen(activeIds()));
  assert.ok(Object.isFrozen(retiredIds()));
  const out = idsFrom(REGISTRY);
  assert.ok(Object.isFrozen(out.active) && Object.isFrozen(out.binaries) && Object.isFrozen(out.retired));
});

test('the result is cached per root', (t) => {
  const root = scratchRoot(t, () => {});
  const first = activeIds(root);
  assert.equal(activeIds(root), first);
  fs.writeFileSync(path.join(root, 'core', 'registry', 'harnesses.json'), JSON.stringify({ harnesses: [{ id: 'only' }] }));
  assert.deepEqual(activeIds(root), first, 'a second read of the same root does not re-read the file');
  assert.notEqual(activeIds(scratchRoot(t, (r) => { r.harnesses.length = 1; })), first);
});
