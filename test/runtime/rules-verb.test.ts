'use strict';

// `doflow rules`: the read-only view of the values the runtime owns (review protocol per class, gate floors, tiers,
// settings), each with its source. Run through `bin/doflow.js` in a scratch HOME and a scratch project directory.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');

function scratch(t: any, userSettings: any = null, projectSettings: any = null) {
  const dir = tempDir(t, 'doflow-rules-cli-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(home);
  if (userSettings) {
    fs.mkdirSync(path.join(home, '.config', 'doflow'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'doflow', 'settings.json'), JSON.stringify({ schema: 1, ...userSettings }));
  }
  fs.mkdirSync(path.join(cwd, '.doflow', 'state'), { recursive: true });
  if (projectSettings) fs.writeFileSync(path.join(cwd, '.doflow', 'settings.json'), JSON.stringify({ schema: 1, ...projectSettings }));
  const env: any = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    FORCE_COLOR: '', DOFLOW_CLI: CLI, DOFLOW_TELEMETRY: 'off',
  };
  delete env.DOFLOW_CONFIG_DIR;
  delete env.DOFLOW_AUTOPILOT_ENABLED;
  const cli = (args: any) => spawnSync(process.execPath, [CLI, 'rules', ...args], { cwd, env, encoding: 'utf8' });
  const json = (args: any = []) => {
    const res = cli([...args, '--json']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return JSON.parse(res.stdout);
  };
  return { root: dir, cwd, cli, json };
}

/** Every entry under `root` (directories too), as relative path -> content or null for a directory. */
function snapshot(root: any, base: any = root, out: any = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) { out[`${rel}/`] = null; snapshot(full, base, out); }
    else out[rel] = fs.readFileSync(full, 'latin1');
  }
  return out;
}

test('feature class unattended resolves to review-deep through the seat floor, origin floor; attended follows the preset', (t) => {
  const report = scratch(t).json();
  const feature = report.review.classes.feature;
  assert.equal(feature.unattended.preset, 'review-deep');
  assert.equal(feature.unattended.origin, 'floor');
  assert.equal(feature.unattended.source, 'core/registry/gates.json');
  assert.equal(feature.unattended.seats.count, 2);
  assert.deepEqual(feature.unattended.seats.roles, ['reviewer', 'reviewer']);
  assert.deepEqual({ min: feature.unattended.rounds.min, max: feature.unattended.rounds.max, default: feature.unattended.rounds.default }, { min: 2, max: 3, default: 2 });
  assert.equal(feature.unattended.crossAnswer, true);
  assert.equal(feature.unattended.synthesizer, 'separate');
  assert.equal(feature.attended.preset, 'review-single');
  assert.equal(feature.attended.origin, 'registry');
  assert.equal(feature.attended.source, 'core/registry/protocols.json');
  assert.equal(feature.attended.seats.count, 1);
  assert.equal(feature.attended.synthesizer, 'seat');
  assert.equal(feature.attended.crossAnswer, false);
});

test('bug class attended resolves to the user review.preset, with the user layer as origin and source', (t) => {
  const report = scratch(t, { 'review.preset': 'review-deep' }).json();
  const bug = report.review.classes.bug;
  assert.equal(bug.attended.preset, 'review-deep');
  assert.equal(bug.attended.origin, 'user');
  assert.equal(bug.attended.source, 'settings:user');
  assert.equal(bug.unattended.preset, 'review-deep');
  assert.deepEqual(report.settings['review.preset'], { value: 'review-deep', layer: 'user', source: 'settings:user' });
});

test('a project layer cannot loosen the user preset: the report shows the user value', (t) => {
  const s = scratch(t, { 'review.preset': 'review-deep' }, { 'review.preset': 'review-single' });
  const report = s.json();
  assert.equal(report.settings['review.preset'].value, 'review-deep');
  assert.equal(report.settings['review.preset'].layer, 'user');
  assert.equal(report.review.classes.bug.attended.preset, 'review-deep');
  assert.equal(report.review.classes.bug.attended.origin, 'user');
});

test('a project layer that tightens shows the project value and origin', (t) => {
  const report = scratch(t, null, { 'review.preset': 'review-deep' }).json();
  assert.equal(report.review.classes.bug.attended.preset, 'review-deep');
  assert.equal(report.review.classes.bug.attended.origin, 'project');
  assert.equal(report.settings['review.preset'].layer, 'project');
});

test('-g reads the user layer only', (t) => {
  const s = scratch(t, null, { 'review.preset': 'review-deep' });
  const report = s.json(['-g']);
  assert.equal(report.settings['review.preset'].layer, 'default');
  assert.equal(report.review.classes.bug.attended.preset, 'review-single');
});

test('a value the runtime cannot resolve prints as unresolved:<reason>, never dropped', (t) => {
  const s = scratch(t, null, { 'review.preset': 'no-such-preset' });
  const report = s.json();
  assert.match(report.settings['review.preset'].value, /^unresolved:/);
  assert.match(report.review.classes.bug.attended, /^unresolved:/);
  assert.match(report.review.classes.feature.unattended, /^unresolved:/);
  // the sections that do not depend on that setting still resolve
  assert.equal(report.gates.classes.feature['gate-b'].minSeats, 2);
  const text = s.cli([]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /unresolved:/);
});

test('--json: schema 1 with review, gates, tiers and settings sections', (t) => {
  const report = scratch(t).json();
  assert.equal(report.schema, 1);
  assert.deepEqual(Object.keys(report), ['schema', 'review', 'gates', 'tiers', 'settings']);
  const packaged = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'gates.json'), 'utf8'));
  assert.deepEqual(Object.keys(report.review.classes), Object.keys(packaged.classes));
  assert.equal(report.gates.source, 'core/registry/gates.json');
  assert.deepEqual(report.gates.classes.feature['gate-b'], { autopilot: 'approve', minSeats: 2 });
  assert.deepEqual(report.gates.loop, { maxSteps: packaged.loop.maxSteps, wip: packaged.loop.wip });
  const models = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'models.json'), 'utf8'));
  assert.deepEqual(report.tiers.byOwner, models.dispatchTiers.byOwner);
  assert.equal(report.tiers.source, 'core/registry/models.json');
  const workers = Object.keys(report.tiers.models);
  assert.ok(workers.length > 0);
  for (const tier of models.dispatchTiers.tiers) assert.equal(report.tiers.models[workers[0]][tier], 'unset');
  assert.deepEqual(Object.keys(report.settings), ['review.preset', 'review.rounds', 'review.sameFamily', 'autopilot.enabled']);
  assert.deepEqual(report.settings['autopilot.enabled'], { value: 'off', layer: 'default', source: 'core/registry/settings.json' });
  assert.equal(report.settings['review.rounds'].value, null);
});

test('a worker model set in the user settings shows against its worker and tier', (t) => {
  const s = scratch(t);
  const first = Object.keys(s.json().tiers.models)[0];
  fs.mkdirSync(path.join(s.root, 'home', '.config', 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'home', '.config', 'doflow', 'settings.json'),
    JSON.stringify({ schema: 1, 'workers.models': { [first]: { frontier: 'some-model' } } }));
  const report = s.json();
  assert.equal(report.tiers.models[first].frontier, 'some-model');
  assert.equal(report.tiers.models[first].standard, 'unset');
});

test('--task-class narrows review and gates to that class; an unknown class is usage (exit 2)', (t) => {
  const s = scratch(t);
  const report = s.json(['--task-class', 'feature']);
  assert.deepEqual(Object.keys(report.review.classes), ['feature']);
  assert.deepEqual(Object.keys(report.gates.classes), ['feature']);
  const bad = s.cli(['--task-class', 'nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr + bad.stdout, /nope/);
});

test('text mode is compact: at most 60 lines for all classes, with the sections and the sources', (t) => {
  const res = scratch(t).cli([]);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trimEnd().split('\n');
  assert.ok(lines.length <= 60, `${lines.length} lines`);
  assert.match(res.stdout, /^review/m);
  assert.match(res.stdout, /^gates/m);
  assert.match(res.stdout, /^tiers/m);
  assert.match(res.stdout, /^settings/m);
  assert.match(res.stdout, /feature .*review-deep.*origin=floor/s);
  assert.match(res.stdout, /core\/registry\/gates\.json/);
});

test('exit 0 and nothing is written: the scratch tree is identical before and after, text and --json', (t) => {
  const s = scratch(t, { 'review.preset': 'review-deep' });
  const before = snapshot(s.root);
  assert.equal(s.cli([]).status, 0);
  assert.equal(s.cli(['--json']).status, 0);
  assert.equal(s.cli(['-g']).status, 0);
  assert.deepEqual(snapshot(s.root), before);
});

test('usage: a second positional or -g with a project path is exit 2; a missing project directory is exit 2', (t) => {
  const s = scratch(t);
  assert.equal(s.cli(['.', 'extra']).status, 2);
  assert.equal(s.cli(['-g', '.']).status, 2);
  assert.equal(s.cli([path.join(s.root, 'missing')]).status, 2);
  assert.equal(s.cli(['--no-such-flag']).status, 2);
});

test('the project argument selects the project whose settings are read', (t) => {
  const s = scratch(t, null, { 'review.preset': 'review-deep' });
  const other = path.join(s.root, 'other');
  fs.mkdirSync(path.join(other, '.doflow'), { recursive: true });
  const res = s.cli([other, '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).settings['review.preset'].layer, 'default');
});

function writeOverride(s: any, bytes: string) {
  fs.writeFileSync(path.join(s.cwd, '.doflow', 'gates.override.json'), bytes);
}

test('no gates override: override is none in the review and gates sections and in the text', (t) => {
  const s = scratch(t);
  const report = s.json();
  assert.equal(report.review.override, 'none');
  assert.equal(report.gates.override, 'none');
  assert.match(s.cli([]).stdout, /override: none/);
});

test('an override that raises minSeats shows in the unattended row, the gates section and the text', (t) => {
  const s = scratch(t);
  writeOverride(s, JSON.stringify({ classes: { feature: { 'gate-b': { minSeats: 3 } } } }));
  const report = s.json();
  assert.equal(report.review.override, 'applied');
  assert.equal(report.gates.override, 'applied');
  assert.equal(report.gates.classes.feature['gate-b'].minSeats, 3);
  const row = report.review.classes.feature.unattended;
  assert.equal(row.seats.count, 3);
  assert.equal(row.origin, 'floor');
  assert.equal(report.review.classes.feature.attended.seats.count, 1);
  assert.match(s.cli([]).stdout, /override: applied/);
});

test('an override that tries to widen prints unresolved for the unattended rows, never the packaged floor', (t) => {
  const s = scratch(t);
  writeOverride(s, JSON.stringify({ classes: { feature: { 'gate-b': { minSeats: 1 } } } }));
  const report = s.json();
  assert.match(report.review.override, /^invalid:policy-override-widens/);
  assert.match(report.review.classes.feature.unattended, /^unresolved:policy-override-widens/);
  assert.match(report.review.classes.bug.unattended, /^unresolved:policy-override-widens/);
  assert.equal(report.review.classes.feature.attended.preset, 'review-single');
  assert.match(report.gates.classes, /^unresolved:/);
  const text = s.cli([]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /feature unattended: unresolved:policy-override-widens/);
});

test('an override that is not valid JSON is unresolved:policy-override-invalid for the unattended rows', (t) => {
  const s = scratch(t);
  writeOverride(s, '{not json');
  const report = s.json();
  assert.equal(report.review.override, 'invalid:policy-override-invalid');
  assert.equal(report.review.classes.feature.unattended, 'unresolved:policy-override-invalid');
});
