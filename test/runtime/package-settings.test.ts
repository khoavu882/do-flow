'use strict';

// 122 B.3: the `packages.disabled` settings key, the `packages.ids` ref and the package view's reading of them
// (IC-011, PN-7). Every case runs on a scratch HOME and config home; nothing touches the real ones.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');
const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { REF_META, createRefs } = require('../../src/runtime/settings/refs.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { packageView, resetPackageView, applySettingsDisable } = require('../../src/runtime/packages/view.ts');

const KEY = 'packages.disabled';

/** os.homedir() reads USERPROFILE on win32, and the fixture env sets only HOME: follow it for the subprocess. */
const scratchProfile = (f: any) => ({ env: { USERPROFILE: f.home } });

/** A global lock at `<home>/.doflow/doflow.lock` that records the given package ids. */
function writeLock(home: any, ids: any) {
  const file = path.join(home, '.doflow', 'doflow.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = { version: 1, scope: 'global', scopeRoot: home, generatedAt: null, sourceVersion: null, targets: [], assets: [], mcpSelections: {},
    packages: ids.map((id: any) => ({ id, version: '1.0.0', source: { type: 'local', path: '/x' }, contentDigest: 'a'.repeat(64), capabilityDigest: 'b'.repeat(64), enabled: false, addedAt: '2026-10-24T00:00:00Z' })) };
  fs.writeFileSync(file, `${JSON.stringify(lock)}\n`);
}

/** A non-bundled package state, as B.5 builds them. */
const third = (id: any, extra = {}) => ({ id, source: { type: 'local', path: '/x' }, firstParty: false, enabled: true, state: 'active', reasons: [], contributions: [{ point: 'review-preset', qualifiedId: `${id}/p`, active: true }], ...extra });
const bundled = () => ({ id: 'doflow', source: { type: 'bundled' }, firstParty: true, enabled: true, state: 'active', reasons: [], contributions: [{ point: 'review-preset', qualifiedId: 'review-deep', active: true }] });

test('the shipped registry carries packages.disabled with its ref and loads with refs resolved', () => {
  const loaded = loadSettingsRegistry({ verifyRefs: true, checkConsumers: true });
  assert.equal(loaded.ok, true, loaded.detail);
  const spec = loaded.registry.keys.get(KEY);
  assert.equal(spec.type, 'string-list');
  assert.equal(spec.valuesRef, 'packages.ids');
  assert.equal(spec.combine, 'union');
  assert.equal(spec.scope, 'project-overridable');
  assert.deepEqual(spec.failSafe, { state: 'invalid' });
  assert.deepEqual(REF_META['packages.ids'], { kind: 'values', dependsOn: [] });
});

test('packages.ids is doflow alone without a lock, a v1 lock or a damaged lock, and adds the ids a lock records', (t) => {
  const f = createSettingsEnv(t);
  assert.deepEqual(createRefs({ homeDir: f.home }).resolve('packages.ids'), ['doflow']);
  writeLock(f.home, []);
  assert.deepEqual(createRefs({ homeDir: f.home }).resolve('packages.ids'), ['doflow']);
  writeLock(f.home, ['acme', 'zed']);
  assert.deepEqual(createRefs({ homeDir: f.home }).resolve('packages.ids'), ['doflow', 'acme', 'zed']);
  fs.writeFileSync(path.join(f.home, '.doflow', 'doflow.lock'), '{ not json');
  assert.deepEqual(createRefs({ homeDir: f.home }).resolve('packages.ids'), ['doflow'], 'an unreadable lock must not break settings');
});

test('user and project lists add up, and a project id not recorded on this machine is kept with a warning, not an error', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ [KEY]: ['doflow'] });
  f.writeProjectSettings({ [KEY]: ['acme'] });
  const view = loadSettings({ projectRoot: f.project, env: f.env() });
  const resolution = view.get(KEY);
  assert.deepEqual(resolution.value, ['doflow', 'acme']);
  assert.equal(resolution.state, 'ok');
  assert.deepEqual(view.errors.filter((e: any) => e.key === KEY), []);
  const notes = view.notes.filter((n: any) => n.key === KEY);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].code, 'unknown-member');
  assert.match(notes[0].text, /acme/);
  assert.doesNotMatch(notes[0].text, /doflow/, 'only the unrecorded ids are named');
  assert.deepEqual(resolution.candidates.map((c: any) => [c.layer, c.status]), [['user', 'decided'], ['project', 'decided']]);
});

test('an id the global lock records raises no warning (subprocess, scratch HOME)', (t) => {
  const f = createSettingsEnv(t);
  writeLock(f.home, ['acme']);
  f.writeProjectSettings({ [KEY]: ['acme'] });
  const out = f.node(`
    const { loadSettings } = require(${JSON.stringify(path.join(REPO, 'src/runtime/settings/resolve.ts'))});
    const v = loadSettings({ projectRoot: process.cwd(), env: process.env });
    console.log(JSON.stringify({ value: v.get('${KEY}').value, notes: v.notes.filter((n) => n.key === '${KEY}'), errors: v.errors }));`, scratchProfile(f));
  assert.deepEqual(out, { value: ['acme'], notes: [], errors: [] });
});

test('an invalid project value is the key failSafe: state invalid and an error; the member warning never hides a type fault', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ [KEY]: 'acme' });
  const view = loadSettings({ projectRoot: f.project, env: f.env() });
  assert.equal(view.get(KEY).state, 'invalid');
  assert.equal(view.errors.filter((e: any) => e.key === KEY).length, 1);
  // a list that breaks a rule other than membership is invalid too, whatever its ids
  f.writeProjectSettings({ [KEY]: ['acme', 'acme'] });
  const repeated = loadSettings({ projectRoot: f.project, env: f.env() });
  assert.equal(repeated.get(KEY).state, 'invalid');
});

test('config set packages.disabled is allowed on every writable layer, including project, and lists the recorded ids', (t) => {
  const f = createSettingsEnv(t);
  const project = f.run(['config', 'set', KEY, '["doflow"]', '--layer', 'project', '--json']);
  assert.equal(project.status, 0, project.stderr + project.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.projectFile('settings.json'), 'utf8'))[KEY], ['doflow']);
  const user = f.run(['config', 'set', KEY, '["doflow"]', '--layer', 'user', '--json']);
  assert.equal(user.status, 0, user.stderr + user.stdout);
  const listed = f.run(['config', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.json.keys[KEY].value, ['doflow']);
  assert.deepEqual(listed.json.keys[KEY].meta.values, ['doflow']);
});

test('applySettingsDisable: a listed id is disabled and the reason names the layer that listed it', () => {
  const out = applySettingsDisable([bundled(), third('acme'), third('other')], { value: ['acme'], layer: 'project' });
  const by = Object.fromEntries(out.map((p: any) => [p.id, p]));
  assert.equal(by.acme.state, 'disabled');
  assert.deepEqual(by.acme.reasons, ['disabled-by-project']);
  assert.equal(by.acme.contributions[0].active, false);
  assert.equal(by.other.state, 'active');
  assert.equal(by.doflow.state, 'active');
});

test('applySettingsDisable: byId names the first layer that listed each id; the bundled package can be disabled by the person', () => {
  const entry = { value: ['doflow', 'acme'], layer: 'project', byId: { doflow: 'user', acme: 'project' } };
  const by = Object.fromEntries(applySettingsDisable([bundled(), third('acme')], entry).map((p: any) => [p.id, p]));
  assert.deepEqual(by.doflow.reasons, ['disabled-by-user']);
  assert.equal(by.doflow.state, 'disabled');
  assert.equal(by.doflow.contributions[0].active, false);
  assert.deepEqual(by.acme.reasons, ['disabled-by-project']);
});

test('applySettingsDisable: an invalid value disables every non-bundled package with settings-invalid and leaves the bundled one', () => {
  const out = applySettingsDisable([bundled(), third('acme'), third('other')], { value: null, layer: 'project', state: 'invalid' });
  const by = Object.fromEntries(out.map((p: any) => [p.id, p]));
  for (const id of ['acme', 'other']) {
    assert.equal(by[id].state, 'disabled');
    assert.deepEqual(by[id].reasons, ['settings-invalid']);
    assert.equal(by[id].contributions[0].active, false);
  }
  assert.equal(by.doflow.state, 'active');
});

test('applySettingsDisable: incompatible and suspended outrank disabled, and nothing to disable returns the same array', () => {
  const packages = [third('acme', { state: 'incompatible', reasons: ['host-incompatible'] }), third('s', { state: 'suspended', reasons: ['content-changed'] })];
  const out = applySettingsDisable(packages, { value: ['acme', 's'], layer: 'user' });
  assert.deepEqual(out.map((p: any) => [p.state, p.reasons]), [['incompatible', ['host-incompatible']], ['suspended', ['content-changed']]]);
  assert.equal(applySettingsDisable(packages, { value: [], layer: 'user' }), packages);
  assert.equal(applySettingsDisable(packages, undefined), packages);
});

test('packageView: an injected settings view with doflow listed disables the bundled package; unlisted ids change nothing', () => {
  resetPackageView();
  const off = packageView({ settingsView: { [KEY]: { value: ['doflow'], layer: 'user' } } });
  assert.equal(off.packages[0].state, 'disabled');
  assert.deepEqual(off.packages[0].reasons, ['disabled-by-user']);
  assert.equal(off.packages[0].contributions.every((c: any) => c.active === false), true);
  const base = packageView({ settingsView: { [KEY]: { value: ['acme'], layer: 'project' } } });
  assert.equal(base.packages[0].state, 'active', 'an id that names no package in the view changes nothing');
  const invalid = packageView({ settingsView: { [KEY]: { value: null, layer: 'project', state: 'invalid' } } });
  assert.equal(invalid.packages[0].state, 'active', 'the bundled package is not a non-bundled package');
  resetPackageView();
});

test('packageView reads the project layer itself when no settings view is passed (subprocess, scratch HOME)', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ [KEY]: ['doflow'] });
  const out = f.node(`
    const { packageView } = require(${JSON.stringify(path.join(REPO, 'src/runtime/packages/view.ts'))});
    const p = packageView().packages[0];
    console.log(JSON.stringify({ state: p.state, reasons: p.reasons }));`, scratchProfile(f));
  assert.deepEqual(out, { state: 'disabled', reasons: ['disabled-by-project'] });
  fs.rmSync(f.projectFile('settings.json'));
  const plain = f.node(`
    const { packageView } = require(${JSON.stringify(path.join(REPO, 'src/runtime/packages/view.ts'))});
    console.log(JSON.stringify({ state: packageView().packages[0].state }));`, scratchProfile(f));
  assert.deepEqual(plain, { state: 'active' });
});
