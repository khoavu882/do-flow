'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diffFiles } = require('../src/diff');
const { installTool } = require('../src/copy');

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-difftest-'));
}

test('installTool preserves mtime (dir mapping) so a fresh install reports zero diff', () => {
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'core', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'core', 'agents', 'a.md'), 'A');
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'core/agents/', dst: 'agents/' }];

  installTool(repoRoot, mappings, dstRoot);
  const changed = diffFiles({ repoRoot, mappings, dstRoot });
  assert.strictEqual(changed.length, 0, 'nothing should be "changed" immediately after install');
});

test('installTool preserves mtime (file mapping) so a fresh install reports zero diff', () => {
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'CLAUDE.md'), 'hello');
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'CLAUDE.md', dst: 'CLAUDE.md' }];

  installTool(repoRoot, mappings, dstRoot);
  const changed = diffFiles({ repoRoot, mappings, dstRoot });
  assert.strictEqual(changed.length, 0);
});

// Regression: a source mtime with a sub-second fraction near the next whole second (e.g. .999xs)
// must not drift the destination's mtime forward by a second. `Date` objects round mtimeMs to the
// nearest millisecond; `st.mtime` for such a file can round UP into the next second, and passing
// that Date straight to utimesSync silently copies the rounded-up value instead of the true mtime.
function setMtimeNearNextSecond(file) {
  const base = Math.floor(Date.now() / 1000);
  const nearBoundary = base + 0.9997;
  fs.utimesSync(file, nearBoundary, nearBoundary);
}

test('installTool preserves mtime (file mapping) even when the source mtime fraction is near the next second boundary', () => {
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const src = path.join(repoRoot, 'CLAUDE.md');
  fs.writeFileSync(src, 'hello');
  setMtimeNearNextSecond(src);
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'CLAUDE.md', dst: 'CLAUDE.md' }];

  installTool(repoRoot, mappings, dstRoot);
  const changed = diffFiles({ repoRoot, mappings, dstRoot });
  assert.strictEqual(changed.length, 0, 'a near-boundary source mtime must not drift dst forward a second');
});

test('installTool preserves mtime (dir mapping) even when the source mtime fraction is near the next second boundary', () => {
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'core', 'agents'), { recursive: true });
  const src = path.join(repoRoot, 'core', 'agents', 'a.md');
  fs.writeFileSync(src, 'A');
  setMtimeNearNextSecond(src);
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'core/agents/', dst: 'agents/' }];

  installTool(repoRoot, mappings, dstRoot);
  const changed = diffFiles({ repoRoot, mappings, dstRoot });
  assert.strictEqual(changed.length, 0, 'a near-boundary source mtime must not drift dst forward a second');
});

test('diffFiles (mtime mode) detects exactly the one file whose source mtime moved', () => {
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'core', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'core', 'agents', 'a.md'), 'A');
  fs.writeFileSync(path.join(repoRoot, 'core', 'agents', 'b.md'), 'B');
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'core/agents/', dst: 'agents/' }];
  installTool(repoRoot, mappings, dstRoot);

  const past = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(path.join(repoRoot, 'core', 'agents', 'a.md'), past, past);

  const changed = diffFiles({ repoRoot, mappings, dstRoot });
  assert.strictEqual(changed.length, 1);
  assert.ok(changed[0].srcAbs.endsWith('a.md'));
});

test('diffFiles reports missing dst files as changed', () => {
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'x.md'), 'x');
  const dstRoot = path.join(root, 'dst'); // never installed
  const changed = diffFiles({ repoRoot, mappings: [{ src: 'x.md', dst: 'x.md' }], dstRoot });
  assert.strictEqual(changed.length, 1);
});

test('diffFiles (the update code path) rejects a traversing dst just like installTool does', () => {
  // Regression test: assertWithinRoot was only wired into installTool (used by `install`), not
  // resolveFilePairs (used by `diffFiles`/`update`) — a `dst` escaping the tool dir was silently
  // accepted by `update` while `install` correctly rejected it. Both must now throw identically.
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'payload.md'), 'x');
  const dstRoot = path.join(root, 'victim-project', '.claude');
  const mappings = [{ src: 'payload.md', dst: '../../outside.md' }];

  assert.throws(() => diffFiles({ repoRoot, mappings, dstRoot }), /outside install root/);
  assert.throws(() => installTool(repoRoot, mappings, dstRoot), /outside install root/);
  assert.ok(!fs.existsSync(path.join(root, 'victim-project', '..', 'outside.md')), 'escaped file must never be written');
});

test('diffFiles --checksum mode detects content change even with a forced-equal mtime', () => {
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'x.md'), 'original');
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'x.md', dst: 'x.md' }];
  installTool(repoRoot, mappings, dstRoot);

  // mutate content but force mtimes to stay identical (mtime-mode would miss this)
  const same = new Date('2020-01-01T00:00:00Z');
  fs.writeFileSync(path.join(repoRoot, 'x.md'), 'mutated');
  fs.utimesSync(path.join(repoRoot, 'x.md'), same, same);
  fs.utimesSync(path.join(dstRoot, 'x.md'), same, same);

  assert.strictEqual(diffFiles({ repoRoot, mappings, dstRoot }).length, 0, 'mtime-mode misses a content-only change (expected)');
  assert.strictEqual(diffFiles({ repoRoot, mappings, dstRoot, checksum: true }).length, 1, 'checksum mode catches it');
});
