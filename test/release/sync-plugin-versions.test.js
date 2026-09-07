'use strict';
// sync-plugin-versions.test.js — review R8: v1.2.1 shipped with all three plugin manifests still
// reading 1.2.0; the equality guards caught it after the fact. Distribution versions are now
// PROJECTED from package.json by src/release/sync-plugin-versions.js, wired into the npm `version`
// lifecycle so a release bump rewrites and stages the manifests in the same commit. The equality
// guards in test/install/doflow.test.js remain the independent check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncPluginVersions, PLUGIN_MANIFESTS } = require('../../src/release/sync-plugin-versions');

const REPO = path.resolve(__dirname, "../..");

function fixture(t, { pkgVersion, manifestVersion }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-relsync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: pkgVersion }, null, 2));
  for (const rel of PLUGIN_MANIFESTS) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{\n  "name": "doflow",\n  "version": "${manifestVersion}",\n  "description": "d"\n}\n`);
  }
  return root;
}

test('R8: a version bump projects into every plugin manifest, preserving formatting', (t) => {
  const root = fixture(t, { pkgVersion: '2.0.0', manifestVersion: '1.9.9' });
  const result = syncPluginVersions({ repoRoot: root });
  assert.equal(result.version, '2.0.0');
  assert.deepEqual(result.updated, PLUGIN_MANIFESTS);
  for (const rel of PLUGIN_MANIFESTS) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(text, /"version": "2\.0\.0"/);
    assert.match(text, /^\{\n  "name": "doflow",\n/, 'targeted replacement must not reformat the file');
  }
});

test('R8: already-synced manifests are reported unchanged, not rewritten', (t) => {
  const root = fixture(t, { pkgVersion: '2.0.0', manifestVersion: '2.0.0' });
  const before = PLUGIN_MANIFESTS.map((rel) => fs.statSync(path.join(root, rel)).mtimeMs);
  const result = syncPluginVersions({ repoRoot: root });
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.unchanged, PLUGIN_MANIFESTS);
  const after = PLUGIN_MANIFESTS.map((rel) => fs.statSync(path.join(root, rel)).mtimeMs);
  assert.deepEqual(after, before, 'no write happens when nothing drifted');
});

test('R8: the npm version lifecycle hook invokes the sync so a release cannot ship drifted manifests', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.version, /sync-plugin-versions\.js/,
    'the version lifecycle script must run the projection');
  for (const rel of PLUGIN_MANIFESTS) {
    assert.ok(pkg.scripts.version.includes(rel), `the hook must stage ${rel} into the release commit`);
  }
});

test('R8: this working tree is itself in sync', () => {
  const result = syncPluginVersions({
    repoRoot: REPO,
    fsImpl: { ...fs, writeFileSync: () => { throw new Error('drift detected — the manifests need a sync'); } },
  });
  assert.deepEqual(result.unchanged, PLUGIN_MANIFESTS);
});
