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
  // Deliberately not named CLAUDE.md: that destination is merge-managed (src/claude-md-merge.js)
  // and excluded from diffFiles entirely — using it here would make this test vacuously pass
  // regardless of whether mtime preservation actually works. See diff-update.test.js's dedicated
  // CLAUDE.md-exclusion tests below for that behavior.
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'other.md'), 'hello');
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'other.md', dst: 'other.md' }];

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
  // Not CLAUDE.md — see the comment on the previous mtime test for why.
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const src = path.join(repoRoot, 'other.md');
  fs.writeFileSync(src, 'hello');
  setMtimeNearNextSecond(src);
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'other.md', dst: 'other.md' }];

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

test('installTool routes the real CLAUDE.md mapping through the marker merge, not a plain copy', () => {
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'core'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'core', 'CLAUDE.md'), 'doflow framework content');
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'core/CLAUDE.md', dst: 'CLAUDE.md' }];

  installTool(repoRoot, mappings, dstRoot);
  const fresh = fs.readFileSync(path.join(dstRoot, 'CLAUDE.md'), 'utf8');
  assert.match(fresh, /doflow:start/, 'a fresh install must wrap content in the doflow markers, not copy it plain');
  assert.notStrictEqual(fresh, 'doflow framework content', 'CLAUDE.md must never be a byte-for-byte plain copy');

  // Foreign pre-existing content must survive, with doflow's section appended after it.
  fs.writeFileSync(path.join(dstRoot, 'CLAUDE.md'), 'user-owned project instructions\n');
  installTool(repoRoot, mappings, dstRoot);
  const merged = fs.readFileSync(path.join(dstRoot, 'CLAUDE.md'), 'utf8');
  assert.ok(merged.startsWith('user-owned project instructions\n'), 'foreign content must be preserved, not overwritten');
  assert.match(merged, /doflow:start/, 'doflow section must be appended after the foreign content');
});

test('diffFiles never reports the CLAUDE.md pair as changed, in either mtime or checksum mode', () => {
  const root = scratchDir();
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'core'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'core', 'CLAUDE.md'), 'v1 content');
  const dstRoot = path.join(root, 'dst');
  const mappings = [{ src: 'core/CLAUDE.md', dst: 'CLAUDE.md' }];
  installTool(repoRoot, mappings, dstRoot);

  // Force an obvious content divergence and a stale mtime — a plain-mirrored file would be
  // reported changed by both detectors; CLAUDE.md must be excluded from both regardless.
  const past = new Date('2000-01-01T00:00:00Z');
  fs.writeFileSync(path.join(dstRoot, 'CLAUDE.md'), 'completely different content, no markers');
  fs.utimesSync(path.join(dstRoot, 'CLAUDE.md'), past, past);

  assert.strictEqual(diffFiles({ repoRoot, mappings, dstRoot }).length, 0, 'mtime mode must exclude CLAUDE.md');
  assert.strictEqual(diffFiles({ repoRoot, mappings, dstRoot, checksum: true }).length, 0, 'checksum mode must exclude CLAUDE.md');
});
