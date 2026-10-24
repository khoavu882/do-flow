'use strict';
// sync-plugin-versions.test.js — review R8: v1.2.1 shipped with all three plugin manifests still
// reading 1.2.0; the equality guards caught it after the fact. Distribution versions are now
// PROJECTED from package.json by src/release/sync-plugin-versions.ts, wired into the npm `version`
// lifecycle so a release bump rewrites and stages the manifests in the same commit. The equality
// guards in test/install/doflow.test.js remain the independent check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { syncPluginVersions, PLUGIN_MANIFESTS } = require('../../src/release/sync-plugin-versions.ts');
const { tempDir } = require('../helper/tmp');
const { contentDigest } = require('../../src/runtime/packages/digest.ts');

const REPO = path.resolve(__dirname, "../..");

function fixture(t, { pkgVersion, manifestVersion }) {
  const root = tempDir(t, 'doflow-relsync-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: pkgVersion }, null, 2));
  for (const rel of PLUGIN_MANIFESTS) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{\n  "name": "doflow",\n  "version": "${manifestVersion}",\n  "description": "d"\n}\n`);
  }
  bundledFixture(root, pkgVersion);
  return root;
}

const BUNDLED_DIR = 'core/registry/packages/doflow';
const POINTS = 'core/registry/contribution-points.json';
const REAL_POINTS = JSON.parse(fs.readFileSync(path.join(REPO, POINTS), 'utf8'));

/** The bundled first-party package of `version` (122 PN-8) under `root`, with its digest pinned the way G68 holds it. */
function bundledFixture(root, version) {
  const dir = path.join(root, BUNDLED_DIR);
  fs.cpSync(path.join(REPO, BUNDLED_DIR), dir, { recursive: true });
  const manifest = path.join(dir, 'doflow-package.json');
  const text = fs.readFileSync(manifest, 'utf8').replace(/("version": ")[^"]*"/, `$1${version}"`).replace(/("doflow": ")[^"]*"/, `$1=${version}"`);
  fs.writeFileSync(manifest, text);
  const points = { ...REAL_POINTS, bundled: [{ ...REAL_POINTS.bundled[0], contentDigest: contentDigest(dir, { limits: REAL_POINTS.limits }) }] };
  fs.mkdirSync(path.join(root, 'core/registry'), { recursive: true });
  fs.writeFileSync(path.join(root, POINTS), `${JSON.stringify(points, null, 2)}\n`);
}
const digestOf = (root) => contentDigest(path.join(root, BUNDLED_DIR), { limits: REAL_POINTS.limits });
const pinned = (root) => JSON.parse(fs.readFileSync(path.join(root, POINTS), 'utf8')).bundled[0].contentDigest;

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

test('PN-8: a bump rewrites the bundled manifest version and range and re-pins the digest, so the G68 digest check stays true', (t) => {
  const root = fixture(t, { pkgVersion: '2.0.0', manifestVersion: '2.0.0' });
  const manifestFile = path.join(root, BUNDLED_DIR, 'doflow-package.json');
  const before = fs.readFileSync(manifestFile, 'utf8');
  const oldPin = pinned(root);
  assert.equal(oldPin, digestOf(root), 'the fixture starts at G68 parity');
  assert.deepEqual(syncPluginVersions({ repoRoot: root }).bundled, [], 'in step: nothing to rewrite');

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '2.1.0-beta.1' }));
  const result = syncPluginVersions({ repoRoot: root });
  assert.deepEqual(result.bundled.sort(), [POINTS, `${BUNDLED_DIR}/doflow-package.json`].sort());
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.equal(manifest.version, '2.1.0-beta.1');
  assert.equal(manifest.doflow, '=2.1.0-beta.1');
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), before.replace(/2\.0\.0/g, '2.1.0-beta.1'), 'targeted replacement: only the two fields moved');
  assert.notEqual(pinned(root), oldPin, 'the digest moved with the manifest bytes');
  assert.equal(pinned(root), digestOf(root), 'the G68 digest check is true after the bump');
  assert.deepEqual(syncPluginVersions({ repoRoot: root }).bundled, [], 'a second run changes nothing');
});

test('PN-8 control: a manifest bumped without the sync leaves the pinned digest stale', (t) => {
  const root = fixture(t, { pkgVersion: '2.0.0', manifestVersion: '2.0.0' });
  const manifestFile = path.join(root, BUNDLED_DIR, 'doflow-package.json');
  fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace(/2\.0\.0/g, '2.1.0-beta.1'));
  assert.notEqual(pinned(root), digestOf(root));
});

test('PN-8: the npm version lifecycle hook also stages the bundled manifest and the point registry', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  for (const rel of [`${BUNDLED_DIR}/doflow-package.json`, POINTS]) {
    assert.ok(pkg.scripts.version.includes(rel), `the hook must stage ${rel} into the release commit`);
  }
});

test('R8: the npm version lifecycle hook invokes the sync so a release cannot ship drifted manifests', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.version, /sync-plugin-versions\.ts/,
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
