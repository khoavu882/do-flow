'use strict';

// Feature 122 A.4 (IC-001, IC-003, IC-004, IC-005): the manifest checker, the tree rules, the digests and
// `doflow package --action check`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadPoints } = require('../../src/runtime/packages/points.ts');
const { checkManifest, checkPackage } = require('../../src/runtime/packages/manifest.ts');
const { contentDigest, capabilityDigest } = require('../../src/runtime/packages/digest.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const POINTS = loadPoints().registry;
// The effective core registry (122 A.6): `debate-3` is contributed by the bundled package, so the built-in ids a
// third-party bare id is checked against come from the merged view, as `checkManifest`'s own default does.
const CORE = structuredClone(require('../../src/runtime/review/protocols.ts').loadProtocols().registry);
const clone = (value: any): any => JSON.parse(JSON.stringify(value));
const HOST = '2.0.0-beta.7';
const OPTIONS: any = { pointsRegistry: POINTS, hostVersion: HOST, bundled: [] };

/** review-deep without its depth: a package preset that dominates both core review presets. */
function reviewPreset(): any {
  const preset = clone(CORE.presets['review-deep']);
  delete preset.depth;
  return preset;
}
/** A one-seat, light-tier preset that dominates no core review preset. */
function weakReviewPreset(): any {
  return {
    kind: 'review',
    seats: [{ id: 'solo', agent: 'reviewer', lenses: [], model: { tier: 'light' } }],
    rounds: { default: 1, min: 1 },
    crossAnswer: false, synthesizer: 'none', decider: 'gate',
  };
}
const manifestOf = (overrides: any = {}): any => ({
  manifest: 1, id: 'acme', version: '1.2.0', summary: 'Stricter review presets', doflow: '>=2.0.0-beta.1 <3.0.0',
  contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
  ...overrides,
});

/** Write a package directory: `files` maps a relative path to text (or a function `(abs: any) => void`). */
function makePackage(t: any, manifest: any, files: Record<string, any> = { 'presets/strict.json': reviewPreset() }): string {
  const dir = path.join(tempDir(t, 'doflow-pkg-'), 'pkg');
  fs.mkdirSync(dir);
  if (manifest !== null) fs.writeFileSync(path.join(dir, 'doflow-package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (typeof body === 'function') body(abs);
    else fs.writeFileSync(abs, typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}
const codes = (findings: any[]) => findings.map((f: any) => f.code);
const errors = (result: any) => result.findings.filter((f: any) => f.severity === 'error');

test('a valid package has no findings and carries both digests', (t: any) => {
  const result = checkPackage(makePackage(t, manifestOf()), OPTIONS);
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
  assert.match(result.contentDigest, /^[0-9a-f]{64}$/);
  assert.match(result.capabilityDigest, /^[0-9a-f]{64}$/);
});

test('one bad preset field plus one undeclared point gives exactly two findings with field, code and allowed', (t: any) => {
  const bad = reviewPreset();
  bad.seats[0].model.tier = 'ultra';
  const dir = makePackage(t, manifestOf({
    contributions: [
      { point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' },
      { point: 'mystery-point', version: 1, id: 'other', file: 'presets/other.json' },
    ],
  }), { 'presets/strict.json': bad, 'presets/other.json': reviewPreset() });
  const result = checkPackage(dir, OPTIONS);
  assert.equal(result.findings.length, 2, JSON.stringify(result.findings));
  const [invalid, undeclared] = result.findings;
  assert.equal(invalid.code, 'contribution-invalid');
  assert.equal(invalid.field, 'acme.strict.seats[0].model.tier');
  assert.deepEqual(invalid.allowed, ['light', 'standard', 'frontier']);
  assert.equal(undeclared.code, 'undeclared-point');
  assert.equal(undeclared.field, 'contributions[1].point');
  assert.deepEqual(undeclared.allowed, ['review-preset', 'debate-preset', 'skill', 'agent', 'worker', 'capability-provider']);
  for (const f of result.findings) {
    assert.equal(f.package, 'acme');
    assert.equal(f.severity, 'error');
    assert.equal(typeof f.message, 'string');
  }
  assert.equal(result.ok, false);
  assert.equal(result.contentDigest, undefined);
});

test('enabled, settings, order and replaces are each forbidden-field, at the top level and inside an entry', () => {
  for (const key of ['enabled', 'settings', 'order', 'replaces']) {
    const top = checkManifest(manifestOf({ [key]: key === 'enabled' ? true : {} }), OPTIONS);
    assert.deepEqual(top.filter((f: any) => f.field === key).map((f: any) => f.code), ['forbidden-field'], key);
    const entry = manifestOf();
    entry.contributions[0][key] = key === 'enabled' ? true : 'x';
    const inner = checkManifest(entry, OPTIONS);
    assert.deepEqual(inner.filter((f: any) => f.field === `contributions[0].${key}`).map((f: any) => f.code), ['forbidden-field'], key);
  }
});

test('every field of the registry forbiddenFields list is refused, never reported as unknown', () => {
  for (const key of POINTS.forbiddenFields) {
    const findings = checkManifest(manifestOf({ [key]: 1 }), OPTIONS);
    assert.deepEqual(findings.filter((f: any) => f.field === key).map((f: any) => f.code), ['forbidden-field'], key);
  }
});

test('an unknown key, a wrong manifest number and a duplicate key are findings', () => {
  assert.deepEqual(checkManifest(manifestOf({ colour: 'red' }), OPTIONS).map((f: any) => [f.field, f.code]), [['colour', 'unknown-key']]);
  const unsupported = checkManifest(manifestOf({ manifest: 2 }), OPTIONS);
  assert.deepEqual(unsupported.map((f: any) => [f.code, f.allowed]), [['unsupported-manifest', [1]]]);
  const text = JSON.stringify(manifestOf()).replace('"version":"1.2.0"', '"version":"1.2.0","version":"1.3.0"');
  assert.deepEqual(codes(checkManifest(text, OPTIONS)), ['duplicate-key']);
  assert.deepEqual(codes(checkManifest('{ not json', OPTIONS)), ['bad-type']);
  assert.deepEqual(codes(checkManifest('x'.repeat(65 * 1024), OPTIONS)), ['too-large']);
});

test('a symlink, a ../ path and a 300 KiB file give symlink, path-escapes-root and too-large', (t: any) => {
  const outside = path.join(tempDir(t, 'doflow-outside-'), 'x.json');
  fs.writeFileSync(outside, '{}');
  const dir = makePackage(t, manifestOf({
    contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: '../x.json' }],
  }), {
    link: (abs: any) => fs.symlinkSync(outside, abs),
    'big.bin': Buffer.alloc(300 * 1024, 1),
  });
  const result = checkPackage(dir, OPTIONS);
  const byCode = Object.fromEntries(result.findings.map((f: any) => [f.code, f.field]));
  assert.equal(byCode['path-escapes-root'], 'contributions[0].file');
  assert.equal(byCode.symlink, 'tree.link');
  assert.equal(byCode['too-large'], 'tree.big.bin');
  assert.equal(result.ok, false);
});

test('a contribution path through a symlinked directory resolves outside the root', (t: any) => {
  const outsideDir = tempDir(t, 'doflow-outside-');
  fs.writeFileSync(path.join(outsideDir, 'strict.json'), JSON.stringify(reviewPreset()));
  const dir = makePackage(t, manifestOf({
    contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'via/strict.json' }],
  }), { via: (abs: any) => fs.symlinkSync(outsideDir, abs) });
  const result = checkPackage(dir, OPTIONS);
  assert.ok(codes(result.findings).includes('path-escapes-root'));
  assert.ok(codes(result.findings).includes('symlink'));
});

test('a special file, a hidden segment, too many files and too many bytes are tree findings', (t: any) => {
  const dir = makePackage(t, manifestOf(), {
    'presets/strict.json': reviewPreset(),
    '.git/config': 'x',
    '.hidden': 'x',
    'a.txt': 'aaaa',
    'b.txt': 'bbbb',
  });
  const fifo = spawnSync('mkfifo', [path.join(dir, 'pipe')]);
  const small = clone(POINTS);
  small.limits = { files: 3, bytes: 100, fileBytes: 262144, pathLength: 200 };
  const result = checkPackage(dir, { ...OPTIONS, pointsRegistry: small });
  const found = codes(result.findings);
  if (fifo.status === 0) assert.ok(found.includes('special-file'));
  assert.ok(found.includes('too-many-files'));
  assert.equal(result.findings.filter((f: any) => f.code === 'bad-type' && f.field.startsWith('tree.')).length >= 1, true);
  const fields = result.findings.map((f: any) => f.field);
  assert.ok(!fields.some((f: any) => f.startsWith('tree..git/')), 'a rejected directory is not entered');
});

test('a total over the byte limit is too-large', (t: any) => {
  const small = clone(POINTS);
  small.limits = { files: 512, bytes: 1000, fileBytes: 262144, pathLength: 200 };
  const dir = makePackage(t, manifestOf(), { 'presets/strict.json': reviewPreset(), 'pad.txt': 'x'.repeat(2000) });
  const result = checkPackage(dir, { ...OPTIONS, pointsRegistry: small });
  assert.deepEqual(result.findings.filter((f: any) => f.code === 'too-large').map((f: any) => f.field), ['tree']);
});

test('package id doflow, do-x and a bare built-in contribution id are reserved-id', (t: any) => {
  for (const id of ['doflow', 'do-x', 'core']) {
    const found = checkManifest(manifestOf({ id }), OPTIONS);
    assert.deepEqual(found.map((f: any) => [f.field, f.code]), [['id', 'reserved-id']], id);
  }
  const bare = manifestOf();
  bare.contributions[0].id = 'debate-3';
  bare.contributions[0].point = 'debate-preset';
  assert.deepEqual(checkManifest(bare, OPTIONS).map((f: any) => [f.field, f.code]), [['contributions[0].id', 'reserved-id']]);
  // A grammar break is a different code.
  assert.deepEqual(checkManifest(manifestOf({ id: 'Acme' }), OPTIONS).map((f: any) => f.code), ['bad-id']);
});

test('only a bundled manifest may use the reserved id and bare contribution ids', (t: any) => {
  const debate3 = clone(CORE.presets['debate-3']);
  const dir = makePackage(t, {
    manifest: 1, id: 'doflow', version: HOST, summary: 'DoFlow first-party presets', doflow: `=${HOST}`,
    contributions: [{ point: 'debate-preset', version: 1, id: 'debate-3', file: 'presets/debate-3.json' }],
  }, { 'presets/debate-3.json': debate3 });
  const result = checkPackage(dir, { ...OPTIONS, bundled: ['doflow'] });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(checkPackage(dir, OPTIONS).findings.map((f: any) => [f.field, f.code]), [['id', 'reserved-id'], ['contributions[0].id', 'reserved-id']]);
});

test('a preset that dominates no core preset of its kind is incomparable', (t: any) => {
  const result = checkPackage(makePackage(t, manifestOf(), { 'presets/strict.json': weakReviewPreset() }), OPTIONS);
  assert.deepEqual(result.findings.map((f: any) => [f.field, f.code]), [['acme.strict', 'incomparable']]);
  assert.equal(result.ok, false);
});

test('package-mode preset rules: depth, kind, agents, seat ids and the round cap', (t: any) => {
  const run = (mutate: (preset: any) => void, extra: any = {}) => {
    const preset = reviewPreset();
    mutate(preset);
    return checkPackage(makePackage(t, manifestOf(extra), { 'presets/strict.json': preset }), OPTIONS).findings;
  };
  assert.deepEqual(run((p: any) => { p.depth = 'deep'; }).map((f: any) => [f.field, f.code]), [['acme.strict.depth', 'forbidden-field']]);
  assert.ok(run((p: any) => { p.kind = 'debate'; }).some((f: any) => f.field === 'acme.strict.kind' && f.code === 'contribution-invalid'));
  assert.ok(run((p: any) => { p.seats[0].agent = 'core-implementer'; }).some((f: any) => f.field === 'acme.strict.seats[0].agent'));
  assert.ok(run((p: any) => { p.seats[0].agent = 'no-such-agent'; }).some((f: any) => f.field === 'acme.strict.seats[0].agent'));
  assert.ok(run((p: any) => { p.seats[0].id = 'Seat_A'; }).some((f: any) => f.field === 'acme.strict.seats[0].id'));
  assert.ok(run((p: any) => { p.rounds = { default: 9, min: 2 }; }).some((f: any) => f.field === 'acme.strict.rounds.default'));
  assert.ok(run((p: any) => { p.seats[0].lenses = ['no-such-lens']; }).some((f: any) => f.field === 'acme.strict.seats[0].lenses'));
  // A debate preset may name a write-access core agent, as the core debate presets do.
  const debate = clone(CORE.presets['debate-3']);
  const found = checkPackage(makePackage(t, manifestOf({ contributions: [{ point: 'debate-preset', version: 1, id: 'wide', file: 'presets/strict.json' }] }), { 'presets/strict.json': debate }), OPTIONS).findings;
  assert.deepEqual(found, []);
});

test('a reserved point, an unsupported point version and a wrong entry kind are refused', (t: any) => {
  const optionsWithReserved = {
    ...OPTIONS,
    pointsRegistry: {
      ...POINTS,
      points: [
        ...POINTS.points,
        { id: 'future-point', versions: [1], tier: 'inert', status: 'reserved', entry: 'file', opensWith: 'row 999', slice: 'Z', combine: 'add-only', validator: null, consumer: null, referencedBy: [] },
      ],
    },
  };
  const reserved = checkManifest(manifestOf({ contributions: [{ point: 'future-point', version: 1, id: 'triage', file: 'providers/x.json' }] }), optionsWithReserved);
  assert.deepEqual(codes(reserved), ['point-reserved']);
  assert.match(reserved[0].message, /row 999/);
  const version = checkManifest(manifestOf({ contributions: [{ point: 'review-preset', version: 7, id: 'strict', file: 'a.json' }] }), OPTIONS);
  assert.deepEqual(version.map((f: any) => [f.code, f.allowed]), [['unsupported-point-version', [1]]]);
  const kind = checkManifest(manifestOf({ contributions: [{ point: 'review-preset', version: 1, id: 'strict', dir: 'presets' }] }), OPTIONS);
  assert.deepEqual(codes(kind), ['bad-type']);
  const dup = manifestOf({ contributions: [
    { point: 'review-preset', version: 1, id: 'strict', file: 'a.json' },
    { point: 'review-preset', version: 1, id: 'strict', file: 'b.json' },
  ] });
  assert.ok(checkManifest(dup, OPTIONS).some((f: any) => f.code === 'bad-id' && f.field === 'contributions[1].id'));
  assert.deepEqual(codes(checkManifest(manifestOf({ programs: [] }), OPTIONS)), ['forbidden-field']);
});

test('the host range: outside the range is host-incompatible, a malformed range is bad-type with the grammar', (t: any) => {
  const outside = checkManifest(manifestOf({ doflow: '>=3.0.0 <4.0.0' }), OPTIONS);
  assert.deepEqual(outside.map((f: any) => [f.field, f.code]), [['doflow', 'host-incompatible']]);
  assert.deepEqual(checkManifest(manifestOf({ doflow: '>=2.0.0-beta.7 <3.0.0' }), OPTIONS), []);
  // An unreadable running version fails closed: the range cannot be shown to hold.
  for (const unknown of [null, undefined, '']) {
    const found = checkManifest(manifestOf(), { ...OPTIONS, hostVersion: unknown });
    assert.deepEqual(found.map((f: any) => [f.field, f.code, f.severity]), [['doflow', 'host-incompatible', 'error']], String(unknown));
    assert.equal(found[0].message, 'the running DoFlow version cannot be read');
    assert.equal(found[0].allowed, manifestOf().doflow);
  }
  const unreadable = checkPackage(makePackage(t, manifestOf()), { ...OPTIONS, hostVersion: null });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.contentDigest, undefined);
  for (const range of ['^1.0.0', '*', '>=1.0.0', 5]) {
    const found = checkManifest(manifestOf({ doflow: range }), OPTIONS);
    assert.deepEqual(found.map((f: any) => [f.field, f.code]), [['doflow', 'bad-type']], String(range));
    assert.match(found[0].allowed, /comparators/);
  }
});

test('bad version and summary values are bad-type; a missing required field is reported', () => {
  assert.deepEqual(checkManifest(manifestOf({ version: '1.2' }), OPTIONS).map((f: any) => f.field), ['version']);
  assert.deepEqual(checkManifest(manifestOf({ summary: 'use <b>' }), OPTIONS).map((f: any) => f.field), ['summary']);
  assert.deepEqual(checkManifest(manifestOf({ summary: 'x'.repeat(121) }), OPTIONS).map((f: any) => f.field), ['summary']);
  const missing: any = manifestOf();
  delete missing.doflow;
  delete missing.contributions;
  assert.deepEqual(checkManifest(missing, OPTIONS).map((f: any) => f.field), ['doflow', 'contributions']);
  assert.deepEqual(checkManifest([], OPTIONS).map((f: any) => f.code), ['bad-type']);
  assert.deepEqual(checkManifest(null, OPTIONS).map((f: any) => f.code), ['bad-type']);
});

test('the checker does not throw on hostile content', (t: any) => {
  const hostile = [
    { manifest: 1, id: {}, version: [], doflow: 1, contributions: [null, 1, [], { point: {}, version: 'x' }, { point: 'review-preset', version: 1, id: 7 }] },
    { contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: { a: 1 } }] },
  ];
  for (const manifest of hostile) assert.doesNotThrow(() => checkManifest(manifest, { ...OPTIONS, root: tempDir(t, 'doflow-pkg-') }));
  const missingManifest = checkPackage(makePackage(t, null, {}), OPTIONS);
  assert.deepEqual(codes(missingManifest.findings), ['file-missing']);
  assert.deepEqual(codes(checkPackage(path.join(tempDir(t, 'doflow-pkg-'), 'nope'), OPTIONS).findings), ['file-missing']);
  const garbage = checkPackage(makePackage(t, manifestOf(), { 'presets/strict.json': '{ nope' }), OPTIONS);
  assert.deepEqual(garbage.findings.map((f: any) => [f.field, f.code]), [['acme.strict', 'contribution-invalid']]);
});

// ---- digests (IC-005) -------------------------------------------------------------------------------------

const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

test('contentDigest follows the IC-005 construction exactly', (t: any) => {
  const dir = path.join(tempDir(t, 'doflow-digest-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee');
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'ay');
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const expected = sha(`doflow-package-content-v1\nb.txt\u00000\u0000${sha('bee')}\n`
    + `run.sh\u00001\u0000${sha('#!/bin/sh\n')}\nsub/a.txt\u00000\u0000${sha('ay')}\n`);
  assert.equal(contentDigest(dir), expected);
});

test('contentDigest is stable across creation order and mtime, and flips on one byte or an execute bit', (t: any) => {
  const make = (order: string[], mtime: Date): string => {
    const dir = path.join(tempDir(t, 'doflow-digest-'), 'pkg');
    fs.mkdirSync(path.join(dir, 'd'), { recursive: true });
    const files: Record<string, string> = { 'one.txt': 'first', 'two.txt': 'second', 'd/three.txt': 'third' };
    for (const rel of order) {
      fs.writeFileSync(path.join(dir, rel), files[rel]);
      fs.utimesSync(path.join(dir, rel), mtime, mtime);
    }
    return dir;
  };
  const a = make(['one.txt', 'two.txt', 'd/three.txt'], new Date('2020-01-01T00:00:00Z'));
  const b = make(['d/three.txt', 'two.txt', 'one.txt'], new Date('2031-06-01T00:00:00Z'));
  const base = contentDigest(a);
  assert.equal(contentDigest(b), base);
  fs.writeFileSync(path.join(b, 'two.txt'), 'secone');
  assert.notEqual(contentDigest(b), base, 'one changed byte');
  fs.writeFileSync(path.join(b, 'two.txt'), 'second');
  assert.equal(contentDigest(b), base);
  fs.chmodSync(path.join(b, 'two.txt'), 0o755);
  assert.notEqual(contentDigest(b), base, 'an execute bit');
  fs.chmodSync(path.join(b, 'two.txt'), 0o644);
  fs.writeFileSync(path.join(b, 'extra.txt'), 'x');
  assert.notEqual(contentDigest(b), base, 'a new file');
});

test('contentDigest refuses a tree that breaks a tree rule', (t: any) => {
  const dir = makePackage(t, manifestOf(), { link: (abs: any) => fs.symlinkSync('/', abs) });
  assert.throws(() => contentDigest(dir), /symlink/);
});

test('capabilityDigest changes with the policy version, the tier and the manifest, not with entry order', () => {
  const tiers = { 'review-preset': 'inert', 'debate-preset': 'inert' };
  const manifest = manifestOf({ contributions: [
    { point: 'review-preset', version: 1, id: 'strict', file: 'a.json' },
    { point: 'debate-preset', version: 1, id: 'wide', file: 'b.json' },
  ] });
  const base = capabilityDigest(manifest, { trustPolicyVersion: 1, tiers });
  assert.match(base, /^[0-9a-f]{64}$/);
  const reordered = { ...manifest, contributions: [...manifest.contributions].reverse() };
  assert.equal(capabilityDigest(reordered, { trustPolicyVersion: 1, tiers }), base);
  const moved = { ...manifest, summary: 'changed text', contributions: manifest.contributions.map((c: any) => ({ ...c, file: 'z.json' })) };
  assert.equal(capabilityDigest(moved, { trustPolicyVersion: 1, tiers }), base, 'bytes the capabilities do not name');
  assert.notEqual(capabilityDigest(manifest, { trustPolicyVersion: 2, tiers }), base);
  assert.notEqual(capabilityDigest(manifest, { trustPolicyVersion: 1, tiers: { ...tiers, 'review-preset': 'executable' } }), base);
  assert.notEqual(capabilityDigest({ ...manifest, version: '1.2.1' }, { trustPolicyVersion: 1, tiers }), base);
  assert.notEqual(capabilityDigest({ ...manifest, doflow: '>=2.0.0 <3.0.0' }, { trustPolicyVersion: 1, tiers }), base);
});

// ---- doflow package --action check ------------------------------------------------------------------------

/** sha256 over the sorted (path, file bytes) of a tree; a directory that does not exist hashes as "absent". */
function treeHash(dir: string): string {
  if (!fs.existsSync(dir)) return 'absent';
  const hash = crypto.createHash('sha256');
  const walk = (current: string, rel: string) => {
    for (const name of fs.readdirSync(current).sort()) {
      const abs = path.join(current, name);
      const stat = fs.lstatSync(abs);
      hash.update(`${rel}/${name}\0${stat.isDirectory() ? 'd' : sha(fs.readFileSync(abs))}\n`);
      if (stat.isDirectory()) walk(abs, `${rel}/${name}`);
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

function cliScratch(t: any): any {
  const base = tempDir(t, 'doflow-pkgcli-');
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(cwd, '.doflow', 'state'), { recursive: true });
  const env: any = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, FORCE_COLOR: '', DOFLOW_TELEMETRY: 'off',
  };
  delete env.DOFLOW_CONFIG_DIR;
  return { home, cwd, run: (args: string[]) => spawnSync(process.execPath, [CLI, 'package', ...args], { cwd, env, encoding: 'utf8' }) };
}

test('package --action check: a valid package exits 0, prints digests and writes nothing', (t: any) => {
  const scratch = cliScratch(t);
  const dir = makePackage(t, manifestOf({ doflow: '>=0.0.1 <999.0.0' }));
  const before = [treeHash(path.join(scratch.home, '.doflow')), treeHash(path.join(scratch.cwd, '.doflow', 'state')), treeHash(scratch.home), treeHash(dir)];
  const text = scratch.run(['--action', 'check', '--path', dir]);
  assert.equal(text.status, 0, text.stderr + text.stdout);
  assert.match(text.stdout, /package ok:/);
  assert.match(text.stdout, /contentDigest [0-9a-f]{64}/);
  const json = scratch.run(['--action', 'check', '--path', dir, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(body), ['path', 'ok', 'findings', 'contentDigest', 'capabilityDigest']);
  assert.equal(body.ok, true);
  assert.equal(body.contentDigest, contentDigest(dir));
  const after = [treeHash(path.join(scratch.home, '.doflow')), treeHash(path.join(scratch.cwd, '.doflow', 'state')), treeHash(scratch.home), treeHash(dir)];
  assert.deepEqual(after, before, 'check wrote nothing');
});

test('package --action check: errors exit 1 and list findings; a missing --path exits 2', (t: any) => {
  const scratch = cliScratch(t);
  const dir = makePackage(t, manifestOf({ doflow: '>=0.0.1 <999.0.0', enabled: true }));
  const bad = scratch.run(['--action', 'check', '--path', dir, '--json']);
  assert.equal(bad.status, 1, bad.stderr);
  const body = JSON.parse(bad.stdout);
  assert.equal(body.ok, false);
  assert.deepEqual(body.findings.map((f: any) => [f.field, f.code]), [['enabled', 'forbidden-field']]);
  assert.equal(body.contentDigest, undefined);
  const plain = scratch.run(['--action', 'check', '--path', dir]);
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /error forbidden-field enabled:/);
  assert.equal(scratch.run(['--action', 'check']).status, 2);
  assert.equal(scratch.run(['--action', 'check', '--path', dir, '--path', dir]).status, 2);
  assert.equal(scratch.run(['--action', 'bogus']).status, 2);
});
