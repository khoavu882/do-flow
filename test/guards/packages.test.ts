'use strict';

// G68 — the package extension model's registry facts hold (feature 122, IC-002, IC-005, IC-015).
//
//   (a) `core/registry/contribution-points.json` is well formed: `validatePoints` reports nothing;
//   (b) every `bundled[]` entry names a directory whose IC-005 content digest equals `contentDigest`, so an edit
//       to the first-party package is a visible registry change (the runtime trusts a bundled package and never
//       re-hashes it; this guard is where it is verified), and whose manifest carries the bundled id and the
//       release version with the exact host range;
//   (c) `forbiddenFields` equals the list docs/reference.md prints;
//   (d) each bundled package passes the full package-mode check (`checkPackage`: read-only review seats, local seat
//       ids, comparability, tree rules). The runtime loads it in core mode only, so a bad first-party preset
//       is caught here, before a release, and not on a user's machine.
// (G67 is reserved for row 120.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { suiteTempDir } = require('../helper/tmp.ts');
const { loadPoints, validatePoints, templateFindings } = require(path.join(REPO, 'src', 'runtime', 'packages', 'points.ts'));
const { contentDigest } = require(path.join(REPO, 'src', 'runtime', 'packages', 'digest.ts'));
const { checkPackage, MANIFEST_FILE } = require(path.join(REPO, 'src', 'runtime', 'packages', 'manifest.ts'));
const { loadCoreProtocols } = require(path.join(REPO, 'src', 'runtime', 'review', 'protocols.ts'));

const POINTS_FILE = path.join(REPO, 'core', 'registry', 'contribution-points.json');
const POINTS = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const REFERENCE = fs.readFileSync(path.join(REPO, 'docs', 'reference.md'), 'utf8');

/** The `forbiddenFields` list docs/reference.md prints (the json block under "Package manifest: forbidden fields"), or null. */
function documentedForbiddenFields(text: string): any {
  const section = text.split(/^### Package manifest: forbidden fields\s*$/m)[1];
  const block = section?.match(/```json\n([\s\S]*?)\n```/);
  return block ? JSON.parse(block[1]) : null;
}

/** Offenders for one bundled entry: a missing directory, a digest that differs, a manifest of another id, version or range. */
function bundledOffenders(entry: any, root: string = REPO): string[] {
  const dir = path.join(root, entry.dir);
  if (!fs.existsSync(dir)) return [`${entry.id}: ${entry.dir} does not exist`];
  const offenders: string[] = [];
  const actual = contentDigest(dir, { limits: POINTS.limits });
  if (actual !== entry.contentDigest) offenders.push(`${entry.id}: contentDigest is ${entry.contentDigest}, the directory hashes to ${actual}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  if (manifest.id !== entry.id) offenders.push(`${entry.id}: the manifest id is '${manifest.id}'`);
  if (manifest.version !== VERSION) offenders.push(`${entry.id}: the manifest version is ${manifest.version}, package.json says ${VERSION}`);
  if (manifest.doflow !== `=${VERSION}`) offenders.push(`${entry.id}: the manifest range is ${manifest.doflow}, expected =${VERSION}`);
  return offenders;
}

test('G68.a the contribution point registry is well formed', () => {
  const loaded = loadPoints();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.ok, true);
  assert.deepEqual(validatePoints(POINTS).errors, []);
});

test('G68.b each bundled package digest equals the registry value, and its manifest is in step with the release', () => {
  assert.ok(POINTS.bundled.length > 0, 'the first-party package is listed');
  for (const entry of POINTS.bundled) assert.deepEqual(bundledOffenders(entry), [], entry.id);
});

test('G68.b control: one changed byte in the bundled directory, or a stale manifest version, is red', () => {
  const root = suiteTempDir('doflow-g68-');
  const [entry] = POINTS.bundled;
  fs.cpSync(path.join(REPO, entry.dir), path.join(root, entry.dir), { recursive: true });
  assert.deepEqual(bundledOffenders(entry, root), [], 'the copy is clean');
  const preset = path.join(root, entry.dir, 'presets', 'debate-3.json');
  fs.writeFileSync(preset, fs.readFileSync(preset, 'utf8').replace('"min": 3', '"min": 2'));
  assert.match(bundledOffenders(entry, root).join('\n'), /contentDigest is/);
  const manifestFile = path.join(root, entry.dir, MANIFEST_FILE);
  fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace(`"version": "${VERSION}"`, '"version": "0.0.1"'));
  assert.match(bundledOffenders(entry, root).join('\n'), /the manifest version is 0\.0\.1/);
});

test('G68.c forbiddenFields equals the list docs/reference.md prints', () => {
  assert.deepEqual(documentedForbiddenFields(REFERENCE), POINTS.forbiddenFields);
});

test('G68.c control: a list that differs or a missing section is red', () => {
  const edited = REFERENCE.replace('"postinstall"]', '"postinstall", "extra"]');
  assert.notDeepEqual(documentedForbiddenFields(edited), POINTS.forbiddenFields);
  assert.equal(documentedForbiddenFields('# nothing here'), null);
});

test('G68.d each bundled package passes the package-mode check', () => {
  const core = loadCoreProtocols();
  assert.equal(core.ok, true, core.errors.join('; '));
  for (const entry of POINTS.bundled) {
    const result = checkPackage(path.join(REPO, entry.dir), { pointsRegistry: POINTS, hostVersion: VERSION, bundled: POINTS.bundled.map((b: any) => b.id), protocols: core.registry });
    assert.deepEqual(result.findings, [], entry.id);
    assert.equal(result.contentDigest, entry.contentDigest, 'the checker and the registry hash the directory alike');
  }
});

test('G68.d control: a first-party preset that package mode refuses is red', () => {
  const root = suiteTempDir('doflow-g68-');
  const [entry] = POINTS.bundled;
  fs.cpSync(path.join(REPO, entry.dir), path.join(root, entry.dir), { recursive: true });
  const preset = path.join(root, entry.dir, 'presets', 'debate-3.json');
  const body = JSON.parse(fs.readFileSync(preset, 'utf8'));
  body.seats[0].agent = 'no-such-agent';
  fs.writeFileSync(preset, JSON.stringify(body));
  const result = checkPackage(path.join(root, entry.dir), { pointsRegistry: POINTS, hostVersion: VERSION, bundled: [entry.id], protocols: loadCoreProtocols().registry });
  assert.ok(result.findings.some((f: any) => f.code === 'contribution-invalid' && /seats\[0\]\.agent/.test(f.field)), JSON.stringify(result.findings));
});

test('G68.e shipped templates are valid and the README has its four sections', () => {
  assert.deepEqual(templateFindings({ registry: POINTS, repoRoot: REPO }), []);
  const readme = fs.readFileSync(path.join(REPO, 'core', 'registry', 'package-templates', 'README.md'), 'utf8');
  for (const heading of ['## What and why', '## Contributions', '## Check, add and trust', '## Editing after it is added']) {
    assert.ok(readme.split(/\r?\n/).includes(heading), heading);
  }
});

test('G68.e control: an unknown placeholder or missing README section is red', () => {
  const root = suiteTempDir('doflow-g68-template-');
  fs.cpSync(path.join(REPO, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  const stub = path.join(root, 'core', 'registry', 'package-templates', 'skill', 'files', 'SKILL.md');
  fs.writeFileSync(stub, fs.readFileSync(stub, 'utf8') + '\n{{x}}\n');
  const readme = path.join(root, 'core', 'registry', 'package-templates', 'README.md');
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('## What and why', '## Why'));
  assert.ok(templateFindings({ registry: POINTS, repoRoot: root }).some((finding: any) => finding.code === 'template-invalid' && /unknown template placeholder/.test(finding.message)));
  assert.ok(templateFindings({ registry: POINTS, repoRoot: root }).some((finding: any) => finding.field === 'templates.README.md' && /missing/.test(finding.message)));
});
