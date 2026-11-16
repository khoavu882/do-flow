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
  // Every installed harness (a scratch PATH may hold none: `harnesses` is then empty) with the three tiers and the orchestrator, null = harness default.
  assert.ok(Array.isArray(report.tiers.models.harnesses));
  for (const row of report.tiers.models.harnesses) {
    for (const tier of models.dispatchTiers.tiers) assert.equal(row[tier], null);
    assert.ok(['binding', 'main-session', 'frontier-binding', 'harness-default'].includes(row.orchestratorSource));
  }
  assert.ok('primary' in report.tiers.models && 'bindings' in report.tiers.models);
  assert.deepEqual(Object.keys(report.settings), ['review.preset', 'review.rounds', 'review.sameFamily', 'autopilot.enabled']);
  assert.deepEqual(report.settings['autopilot.enabled'], { value: 'off', layer: 'default', source: 'core/registry/settings.json' });
  assert.equal(report.settings['review.rounds'].value, null);
});

test('a worker model set in the user settings shows against its worker and tier', (t) => {
  const s = scratch(t);
  const first = 'codex';
  fs.mkdirSync(path.join(s.root, 'home', '.config', 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'home', '.config', 'doflow', 'settings.json'),
    JSON.stringify({ schema: 1, 'workers.models': { [first]: { frontier: 'some-model' } } }));
  const report = s.json();
  const row = report.tiers.models.harnesses.find((h: any) => h.harness === first);
  assert.deepEqual(row.frontier, { model: 'some-model', provider: null, effort: null, check: { model: 'unchecked', effort: null } });
  assert.equal(row.standard, null);
  // No orchestrator binding and no main session: the bound frontier model is the orchestrator's.
  assert.deepEqual(row.orchestrator, row.frontier);
  assert.equal(row.orchestratorSource, 'frontier-binding');
});

test('169: rules text and JSON, and models list, render a provider/effort binding and a several-providers plain id through the one bindingText', async (t) => {
  const { bindingText } = require('../../src/runtime/models/binding-text.ts');
  const { handleModelsCommand } = require('../../src/runtime/models/command.ts');
  const s = scratch(t, { 'workers.models': { codex: { light: 'gpt-x', standard: { model: 'gpt-y', effort: 'low' } } } });
  const catalogue = path.join(s.cwd, '.doflow', 'state', 'models', 'catalogue.json');
  fs.mkdirSync(path.dirname(catalogue), { recursive: true });
  fs.writeFileSync(catalogue, JSON.stringify({ version: 1, syncedAt: new Date().toISOString(), harnesses: { codex: {
    harnessId: 'codex', binary: 'codex', installed: true, version: '1', detectedMode: 'subscription', derivedBilling: 'free', lastSyncedAt: new Date().toISOString(),
    offeredModels: [{ id: 'gpt-x', provider: 'openai' }, { id: 'gpt-x', provider: 'other' }, { id: 'gpt-y' }], modelList: { status: 'listed' },
  } } }));
  const row = s.json().tiers.models.harnesses.find((h: any) => h.harness === 'codex');
  assert.deepEqual(row.light.check, { model: 'several-providers', effort: null });
  assert.deepEqual(row.standard, { model: 'gpt-y', provider: null, effort: 'low', check: { model: 'listed', effort: 'unchecked' }, refused: 'effort:unsupported' });
  assert.equal(bindingText(row.light), 'gpt-x [several providers list it]');
  assert.equal(bindingText(row.standard), 'gpt-y (effort low) [effort unchecked, dispatch refuses it (effort:unsupported)]');
  const text = s.cli([]).stdout;
  assert.match(text, new RegExp(`codex: light=${bindingText(row.light).replace(/[[\]()]/g, '\\$&')} standard=${bindingText(row.standard).replace(/[[\]()]/g, '\\$&')} frontier=harness default`));
  // The same two cells, printed by `models --action list`.
  const home = path.join(s.root, 'home');
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: path.join(s.root, 'no-bin') };
  delete env.DOFLOW_CONFIG_DIR;
  let out = '';
  const log = console.log;
  console.log = (line: any) => { out += `${line}\n`; };
  try { await handleModelsCommand({ actionGiven: true, action: 'list', projectRoot: s.cwd, env, json: false, syncOptions: { view: { packages: [], stateRead: { state: {} }, grants: { grants: [] } } } }); } finally { console.log = log; }
  assert.ok(out.includes(`light=${bindingText(row.light)}  standard=${bindingText(row.standard)}`), out);
});

test('169 A-03: a binding dispatch would refuse is shown as refused, with the reason, in rules JSON and text and in models list', async (t) => {
  const { bindingText } = require('../../src/runtime/models/binding-text.ts');
  const { handleModelsCommand } = require('../../src/runtime/models/command.ts');
  // Codex effort is `unknown` in the shipped descriptor, so a bound effort cannot reach the argv.
  const s = scratch(t, { 'workers.models': { codex: { light: { model: 'gpt-x', effort: 'low' } } } });
  const catalogue = path.join(s.cwd, '.doflow', 'state', 'models', 'catalogue.json');
  fs.mkdirSync(path.dirname(catalogue), { recursive: true });
  fs.writeFileSync(catalogue, JSON.stringify({ version: 1, syncedAt: new Date().toISOString(), harnesses: { codex: {
    harnessId: 'codex', binary: 'codex', installed: true, version: '1', detectedMode: 'subscription', derivedBilling: 'free', lastSyncedAt: new Date().toISOString(),
    offeredModels: [{ id: 'gpt-x' }], modelList: { status: 'listed' },
  } } }));
  const row = s.json().tiers.models.harnesses.find((h: any) => h.harness === 'codex');
  assert.equal(row.light.refused, 'effort:unsupported');
  assert.equal(Object.hasOwn(row.light, 'refused'), true);
  assert.equal(bindingText(row.light), 'gpt-x (effort low) [effort unchecked, dispatch refuses it (effort:unsupported)]');
  assert.ok(s.cli([]).stdout.includes(`light=${bindingText(row.light)}`));
  const home = path.join(s.root, 'home');
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: path.join(s.root, 'no-bin') };
  delete env.DOFLOW_CONFIG_DIR;
  let out = '';
  const log = console.log;
  console.log = (line: any) => { out += `${line}\n`; };
  try { await handleModelsCommand({ actionGiven: true, action: 'list', projectRoot: s.cwd, env, json: false, syncOptions: { view: { packages: [], stateRead: { state: {} }, grants: { grants: [] } } } }); } finally { console.log = log; }
  assert.ok(out.includes('dispatch refuses it (effort:unsupported)'), out);
});

test('an unreadable workers.models gives unresolved:<reason> for every tier and the orchestrator, never null (the harness default)', (t) => {
  const s = scratch(t, { 'workers.models': { codex: { bogus: 'x' } } });
  // A fake codex on a scratch PATH, so the harness row exists whatever this machine has installed.
  const bin = path.join(s.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const res = spawnSync(process.execPath, [CLI, 'rules', '--json'], { cwd: s.cwd, env: { ...process.env, HOME: path.join(s.root, 'home'), XDG_CONFIG_HOME: path.join(s.root, 'home', '.config'), PATH: bin, DOFLOW_CLI: CLI, DOFLOW_TELEMETRY: 'off' }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const models = JSON.parse(res.stdout).tiers.models;
  assert.equal(models.bindings.state, 'invalid');
  const row = models.harnesses.find((h: any) => h.harness === 'codex');
  assert.ok(row, 'the installed harness has a row');
  for (const key of ['light', 'standard', 'frontier', 'orchestrator']) assert.match(row[key], /^unresolved:.+/, key);
  assert.equal(row.orchestratorSource, 'invalid');
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
