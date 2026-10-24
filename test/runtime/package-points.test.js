'use strict';

// Feature 122 A.3 (IC-002, IC-012 `points`, IC-020): the contribution point registry, its closed validator,
// the contribution judge A.4 uses, and the read-only `doflow package --action points` verb.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const {
  loadPoints, validatePoints, judgeContribution, pointRows, POINT_VALIDATORS, POINTS_FILE,
} = require('../../src/runtime/packages/points.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const REAL = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'contribution-points.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

// IC-001's forbidden-field list, verbatim: the registry holds the one copy a guard and the docs read.
const FORBIDDEN = [
  'enabled', 'defaultEnabled', 'trust', 'trusted', 'settings', 'guards', 'hooks', 'floors', 'invariants', 'order',
  'position', 'replaces', 'override', 'familyProven', 'crossFamily', 'firstParty', 'scripts', 'install', 'postinstall',
];

function scratch(t) {
  const dir = tempDir(t, 'doflow-points-cli-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(cwd, '.doflow', 'state'), { recursive: true });
  const env = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '', DOFLOW_CLI: CLI, DOFLOW_TELEMETRY: 'off',
  };
  delete env.DOFLOW_CONFIG_DIR;
  const run = (cli, args) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
  return { root: dir, cwd, home, cli: (args) => run(CLI, args), run };
}

/** A copy of the runtime (bin, src, core/registry) whose contribution-points.json is replaced by `text`. */
function runtimeWithPoints(root, text) {
  const tree = path.join(root, 'runtime');
  fs.mkdirSync(path.join(tree, 'core'), { recursive: true });
  for (const part of ['bin', 'src']) fs.cpSync(path.join(REPO_ROOT, part), path.join(tree, part), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(tree, 'core', 'registry'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(tree, 'package.json'));
  fs.writeFileSync(path.join(tree, 'core', 'registry', 'contribution-points.json'), text);
  return tree;
}

function snapshot(root, base = root, out = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) { out[`${rel}/`] = null; snapshot(full, base, out); }
    else out[rel] = fs.readFileSync(full, 'latin1');
  }
  return out;
}

test('the shipped registry is valid and holds the IC-002 facts', () => {
  assert.equal(POINTS_FILE, 'core/registry/contribution-points.json');
  const loaded = loadPoints();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.ok, true);
  const reg = loaded.registry;
  assert.equal(reg.version, 1);
  assert.equal(reg.trustPolicyVersion, 1);
  assert.deepEqual(reg.forbiddenFields, FORBIDDEN);
  assert.deepEqual(reg.limits, { files: 512, bytes: 4194304, fileBytes: 262144, pathLength: 200 });
  assert.deepEqual(reg.bundled.map((b) => [b.id, b.dir, /^[0-9a-f]{64}$/.test(b.contentDigest)]), [['doflow', 'core/registry/packages/doflow', true]],
    'the first-party package (122 A.6); its digest is held to the directory by G68');
  assert.deepEqual(reg.points.map((p) => [p.id, p.status, p.tier]), [
    ['review-preset', 'open', 'inert'], ['debate-preset', 'open', 'inert'],
    ['skill', 'open', 'instruction'], ['agent', 'open', 'instruction'],
    ['worker', 'reserved', 'executable'], ['capability-provider', 'reserved', 'executable'],
  ]);
  const byId = Object.fromEntries(reg.points.map((p) => [p.id, p]));
  assert.equal(byId.skill.validator, 'skill-v1');
  assert.equal(byId.agent.validator, 'agent-v1');
  assert.equal(byId.worker.opensWith, 'slice D');
  assert.equal(byId['capability-provider'].opensWith, 'row 121');
  assert.deepEqual(byId['capability-provider'].versions, []);
  assert.equal(byId['capability-provider'].validator, null);
  assert.deepEqual(byId['review-preset'].referencedBy, ['review.preset']);
  assert.deepEqual(byId['debate-preset'].referencedBy, ['debate.preset']);
  // Every referencedBy key is a key that exists today.
  const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'settings.json'), 'utf8'));
  const keys = new Set(Object.keys(settings.keys ?? settings));
  for (const p of reg.points) for (const key of p.referencedBy) assert.ok(keys.has(key), `${p.id} references unknown settings key ${key}`);
});

test('POINT_VALIDATORS is a literal map; the preset validators call validatePreset', () => {
  assert.deepEqual(Object.keys(POINT_VALIDATORS).sort(), ['agent-v1', 'debate-preset-v1', 'review-preset-v1', 'skill-v1']);
  const protocols = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
  const context = { lensIds: protocols.lenses.map((l) => l.id), hardRoundCap: protocols.hardRoundCap };
  const review = protocols.presets['review-deep'];
  const debate = protocols.presets['debate-2'];
  assert.deepEqual(POINT_VALIDATORS['review-preset-v1']('review-deep', review, context), []);
  assert.deepEqual(POINT_VALIDATORS['debate-preset-v1']('debate-2', debate, context), []);
  // The point fixes the kind: a debate preset is not a review-preset contribution, and the reverse.
  assert.match(POINT_VALIDATORS['review-preset-v1']('debate-2', debate, context).join('\n'), /kind/);
  assert.match(POINT_VALIDATORS['debate-preset-v1']('review-deep', review, context).join('\n'), /kind/);
  // And an invalid preset body surfaces validatePreset's own error.
  assert.match(POINT_VALIDATORS['review-preset-v1']('review-deep', { ...review, seats: [] }, context).join('\n'), /seats/);
});

test('points --json lists six points with id, versions, tier, status, entry and opensWith', (t) => {
  const s = scratch(t);
  const res = s.cli(['package', '--action', 'points', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(out), ['points']);
  assert.equal(out.points.length, 6);
  assert.deepEqual(out.points[0], { id: 'review-preset', versions: [1], tier: 'inert', status: 'open', entry: 'file', opensWith: null });
  const cap = out.points.find((p) => p.id === 'capability-provider');
  assert.deepEqual(cap, { id: 'capability-provider', versions: [], tier: 'executable', status: 'reserved', entry: 'file', opensWith: 'row 121' });
  assert.deepEqual(out.points, pointRows(REAL));
});

test('points text prints one line per point and writes nothing', (t) => {
  const s = scratch(t);
  const before = { cwd: snapshot(s.cwd), home: snapshot(s.home) };
  const res = s.cli(['package', '--action', 'points']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^point review-preset: tier=inert status=open entry=file versions=1$/);
  assert.match(lines[5], /^point capability-provider: tier=executable status=reserved entry=file versions=- opensWith=row 121$/);
  assert.deepEqual({ cwd: snapshot(s.cwd), home: snapshot(s.home) }, before);
});

test('a missing, unknown or later action is usage, exit 2', (t) => {
  const s = scratch(t);
  for (const args of [['package'], ['package', '--action', 'add'], ['package', '--action', 'bogus', '--json'], ['package', '--action']]) {
    const res = s.cli(args);
    assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
  }
});

test('a scratch registry is refused naming the field', () => {
  const bad = (mutate) => {
    const reg = clone(REAL);
    mutate(reg);
    const result = validatePoints(reg);
    assert.equal(result.ok, false);
    return result.errors.join('\n');
  };
  assert.match(bad((r) => { r.points[0].validator = 'nope-v1'; }), /points\[0\]\.validator.*nope-v1.*POINT_VALIDATORS/);
  assert.match(bad((r) => { r.points[1].tier = 'wizard'; }), /points\[1\]\.tier/);
  assert.match(bad((r) => { r.points[2].status = 'maybe'; }), /points\[2\]\.status/);
  assert.match(bad((r) => { r.points[0].entry = 'tree'; }), /points\[0\]\.entry/);
  assert.match(bad((r) => { r.points[1].id = 'review-preset'; }), /points\[1\]\.id.*duplicate|duplicate.*review-preset/);
  assert.match(bad((r) => { r.points[0].id = 'Review_Preset'; }), /points\[0\]\.id/);
  assert.match(bad((r) => { r.points[0].extra = 1; }), /points\[0\].*unknown key 'extra'/);
  assert.match(bad((r) => { r.surprise = 1; }), /unknown key 'surprise'/);
  assert.match(bad((r) => { delete r.points[5].opensWith; }), /points\[5\]\.opensWith/);
  assert.match(bad((r) => { r.points[0].combine = 'replace'; }), /points\[0\]\.combine/);
  assert.match(bad((r) => { r.points[0].validator = null; }), /points\[0\]\.validator/);
  assert.match(bad((r) => { r.points[0].versions = [2, 1]; }), /points\[0\]\.versions/);
  assert.match(bad((r) => { r.trustPolicyVersion = 0; }), /trustPolicyVersion/);
  assert.match(bad((r) => { r.version = 2; }), /version/);
  assert.match(bad((r) => { r.limits.files = -1; }), /limits\.files/);
  assert.match(bad((r) => { r.forbiddenFields = ['enabled', 'enabled']; }), /forbiddenFields/);
  assert.match(bad((r) => { r.bundled = [{ id: 'doflow', dir: 'x', contentDigest: 'abc' }]; }), /bundled\[0\]\.contentDigest/);
  assert.deepEqual(validatePoints(REAL), { ok: true, errors: [] });
});

test('loadPoints refuses an unreadable or malformed file with an error result, never a throw', (t) => {
  const dir = tempDir(t, 'doflow-points-load-');
  assert.equal(loadPoints({ repoRoot: dir }).ok, false);
  const file = path.join(dir, 'points.json');
  fs.writeFileSync(file, '{ not json');
  const corrupt = loadPoints({ file });
  assert.equal(corrupt.ok, false);
  assert.match(corrupt.errors[0], /points\.json/);
  fs.writeFileSync(file, JSON.stringify({ ...REAL, points: 'x' }));
  assert.match(loadPoints({ file }).errors.join('\n'), /points/);
});

test('judgeContribution: undeclared, unsupported version and reserved points get the IC-004 finding', () => {
  const judge = (entry) => judgeContribution(REAL, entry, { packageId: 'acme', index: 3 });
  assert.equal(judge({ point: 'review-preset', version: 1 }), null);
  assert.equal(judge({ point: 'debate-preset', version: 1 }), null);

  const undeclared = judge({ point: 'hook', version: 1 });
  assert.equal(undeclared.code, 'undeclared-point');
  assert.equal(undeclared.severity, 'error');
  assert.equal(undeclared.package, 'acme');
  assert.equal(undeclared.field, 'contributions[3].point');
  assert.deepEqual(undeclared.allowed, ['review-preset', 'debate-preset', 'skill', 'agent']);

  const version = judge({ point: 'review-preset', version: 2 });
  assert.equal(version.code, 'unsupported-point-version');
  assert.equal(version.field, 'contributions[3].version');
  assert.deepEqual(version.allowed, [1]);

  const reserved = judge({ point: 'capability-provider', version: 1 });
  assert.equal(reserved.code, 'point-reserved');
  assert.match(reserved.message, /row 121/);
  assert.equal(reserved.field, 'contributions[3].point');
  assert.equal(judge({ point: 'skill', version: 1 }), null);
  assert.equal(judge({ point: 'agent', version: 1 }), null);
  assert.match(judge({ point: 'worker', version: 1 }).message, /slice D/);
  // Reserved wins over the version check: capability-provider has no version to compare.
  assert.equal(judge({ point: 'capability-provider', version: 9 }).code, 'point-reserved');
});

test('a corrupt registry fails points with exit 1 and leaves protocol --action list at exit 0', (t) => {
  const s = scratch(t);
  const tree = runtimeWithPoints(s.root, '{ "version": 1, "points": [ ');
  const cli = path.join(tree, 'bin', 'doflow.js');
  const points = s.run(cli, ['package', '--action', 'points']);
  assert.equal(points.status, 1, points.stdout + points.stderr);
  assert.match(points.stdout + points.stderr, /contribution-points\.json/);
  const json = s.run(cli, ['package', '--action', 'points', '--json']);
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'points-invalid');
  const protocol = s.run(cli, ['protocol', '--action', 'list']);
  assert.equal(protocol.status, 0, protocol.stdout + protocol.stderr);
  assert.match(protocol.stdout, /^preset /m);

  // A parseable file that breaks the closed shape is refused the same way, naming the field.
  const bad = clone(REAL);
  bad.points[0].tier = 'wizard';
  const tree2 = runtimeWithPoints(path.join(s.root, 'second'), JSON.stringify(bad));
  const refused = s.run(path.join(tree2, 'bin', 'doflow.js'), ['package', '--action', 'points']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /points\[0\]\.tier/);
});
