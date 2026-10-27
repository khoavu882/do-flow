'use strict';

// 127 IC-005: a settings value naming a retired harness id is classified `retired`, reported as an advisory
// (`<key>: '<id>' is retired; use '<replacement>'`) and ignored; it is never a hard error. The retired record
// is injected: a scratch repoRoot whose harnesses.json retires `oldtool` in favour of `antigravity`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');
const { tempDir } = require('../helper/tmp.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { readWorkerBilling } = require('../../src/runtime/settings/worker-billing.ts');
const { layerEntry } = require('../../src/runtime/settings/config-write.ts');
const { classifyWorkerId } = require('../../src/registry/worker-ids.ts');

const RETIRED = { id: 'oldtool', replacement: 'antigravity' };
const ADVISORY = (key: string) => `${key}: 'oldtool' is retired; use 'antigravity'`;
const AGE = { billing: 'free', asserted: '2026-10-26' };

/** A loaded settings registry over a scratch copy of core/registry whose harnesses.json retires `oldtool`. */
function registryWithRetired(t: any) {
  const dir = tempDir(t, 'doflow-retired-');
  fs.cpSync(path.join(REPO, 'core/registry'), path.join(dir, 'core/registry'), { recursive: true });
  const file = path.join(dir, 'core/registry/harnesses.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.retired = [{ ...RETIRED, displayName: 'Old Tool', retiredOn: '2026-10-26', reason: 'fixture', evidence: ['fixture'], removal: {} }];
  fs.writeFileSync(file, JSON.stringify(data));
  const loaded = loadSettingsRegistry({ repoRoot: dir });
  assert.equal(loaded.ok, true, loaded.detail);
  return loaded.registry;
}

const retiredNotes = (view: any) => view.notes.filter((n: any) => n.code === 'retired');

test('classifyWorkerId: retired beside dangling; an unknown non-retired id stays dangling', () => {
  const known = ['codex', 'claude'];
  assert.equal(classifyWorkerId('oldtool', known, [RETIRED]), 'retired');
  assert.equal(classifyWorkerId('codex', known, [RETIRED]), 'ok');
  assert.equal(classifyWorkerId('zzz', known, [RETIRED]), 'dangling');
  assert.equal(classifyWorkerId('oldtool', known), 'dangling');
  assert.equal(classifyWorkerId('primary', known, [RETIRED]), 'reserved');
  assert.equal(classifyWorkerId('OLD', known, [RETIRED]), 'malformed');
});

test('workers.enabled: a retired id is advised and dropped, the live id is kept, nothing is an error', (t) => {
  const f = createSettingsEnv(t);
  const file = f.writeUserSettings({ schema: 1, 'workers.enabled': ['oldtool', 'codex', 'primary'] });
  const view = loadSettings({ projectRoot: f.project, env: f.env(), registry: registryWithRetired(t) });
  const r = view.get('workers.enabled');
  assert.deepEqual(r.value, ['codex', 'primary']);
  assert.equal(r.state, 'ok');
  assert.deepEqual(view.errors, []);
  assert.deepEqual(retiredNotes(view), [{ code: 'retired', key: 'workers.enabled', source: file, text: ADVISORY('workers.enabled') }]);
  assert.equal(view.notes.some((n: any) => n.code === 'dangling-worker'), false, 'retired is not also dangling');
});

test('workers.enabled: a list of only retired ids has no effect and the default stands', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'workers.enabled': ['oldtool'] });
  const view = loadSettings({ projectRoot: f.project, env: f.env(), registry: registryWithRetired(t) });
  const r = view.get('workers.enabled');
  assert.equal(r.origin.layer, 'default');
  assert.equal(r.state, 'ok');
  assert.equal(r.candidates.find((c: any) => c.layer === 'user').status, 'no-effect');
  assert.equal(r.candidates.find((c: any) => c.layer === 'user').code, 'retired');
  assert.deepEqual(view.errors, []);
  assert.equal(retiredNotes(view).length, 1);
});

test('workers.enabled: a project list naming a retired id narrows by the live ids only', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'workers.enabled': ['codex', 'antigravity', 'primary'] });
  f.writeProjectSettings({ schema: 1, 'workers.enabled': ['oldtool', 'codex'] });
  const view = loadSettings({ projectRoot: f.project, env: f.env(), registry: registryWithRetired(t) });
  assert.deepEqual(view.get('workers.enabled').value, ['codex']);
  assert.deepEqual(view.errors, []);
  assert.equal(retiredNotes(view).length, 1, 'one advisory across the project and global views');
});

test('workers.models: a retired entry is advised and dropped, the live entry is kept', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'workers.models': { oldtool: { light: 'old-model' }, codex: { light: 'gpt-6-luna' } } });
  const view = loadSettings({ projectRoot: f.project, env: f.env(), registry: registryWithRetired(t) });
  const r = view.get('workers.models');
  assert.deepEqual(r.value, { codex: { light: 'gpt-6-luna' } });
  assert.deepEqual(view.errors, []);
  assert.deepEqual(retiredNotes(view).map((n: any) => n.text), [ADVISORY('workers.models')]);
});

test('workers.billing: a retired entry is ignored with the advisory; the record stays usable', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'workers.billing': { oldtool: AGE, codex: AGE } });
  const registry = registryWithRetired(t);
  const view = loadSettings({ global: true, env: f.env(), registry });
  assert.deepEqual(view.get('workers.billing', 'global').value, { codex: AGE });
  assert.deepEqual(view.errors, []);
  assert.deepEqual(retiredNotes(view).map((n: any) => n.text), [ADVISORY('workers.billing')]);
  const record = readWorkerBilling(f.env(), { workerIds: ['codex', 'claude'], registry });
  assert.deepEqual(record, { state: 'set', reason: null, workers: { codex: AGE } });
  // control: a non-retired unknown id still invalidates the record
  f.writeUserSettings({ schema: 1, 'workers.billing': { zzz: AGE, codex: AGE } });
  assert.deepEqual(readWorkerBilling(f.env(), { workerIds: ['codex', 'claude'], registry }),
    { state: 'invalid', reason: 'unknown-worker:zzz', workers: {} });
});

test('workers.billing: only retired entries leave the key absent', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'workers.billing': { oldtool: AGE } });
  const record = readWorkerBilling(f.env(), { workerIds: ['codex'], registry: registryWithRetired(t) });
  assert.deepEqual(record, { state: 'absent', reason: null, workers: {} });
});

test('primary.harness: a retired id is an advisory, the primary stays unresolved, nothing throws', (t) => {
  const registry = registryWithRetired(t);
  for (const where of ['user', 'project', 'env']) {
    const f = createSettingsEnv(t);
    if (where === 'user') f.writeUserSettings({ schema: 1, 'primary.harness': 'oldtool' });
    if (where === 'project') f.writeProjectSettings({ schema: 1, 'primary.harness': 'oldtool' });
    const env = f.env(where === 'env' ? { DOFLOW_PRIMARY_HARNESS: 'oldtool' } : {});
    const view = loadSettings({ projectRoot: f.project, env, registry });
    const r = view.get('primary.harness');
    assert.equal(r.value, 'unknown', where);
    assert.equal(r.state, 'ok', where);
    assert.deepEqual(view.errors, [], where);
    assert.deepEqual(retiredNotes(view).map((n: any) => n.text), [ADVISORY('primary.harness')], where);
    const candidate = r.candidates.find((c: any) => c.layer === where);
    assert.equal(candidate.status, 'no-effect', where);
    assert.equal(candidate.code, 'retired', where);
  }
});

test('primary.harness: a retired project id leaves a live user id in place', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'primary.harness': 'codex' });
  f.writeProjectSettings({ schema: 1, 'primary.harness': 'oldtool' });
  const view = loadSettings({ projectRoot: f.project, env: f.env(), registry: registryWithRetired(t) });
  assert.equal(view.get('primary.harness').value, 'codex');
  assert.deepEqual(view.errors, []);
});

test('negative control: an unknown non-retired id keeps its current treatment', (t) => {
  const registry = registryWithRetired(t);
  const f = createSettingsEnv(t);
  const file = f.writeUserSettings({ schema: 1, 'workers.enabled': ['zzz', 'codex'], 'primary.harness': 'zzz' });
  const view = loadSettings({ projectRoot: f.project, env: f.env(), registry });
  assert.deepEqual(view.get('workers.enabled').value, ['zzz', 'codex']);
  assert.deepEqual(view.notes.filter((n: any) => n.code === 'dangling-worker'),
    [{ code: 'dangling-worker', key: 'workers.enabled', source: file, text: "workers.enabled: worker 'zzz' is not installed (ignored)" }]);
  assert.deepEqual(retiredNotes(view), []);
  assert.equal(view.get('primary.harness').value, 'unknown');
  assert.equal(view.errors.length, 1);
  assert.equal(view.errors[0].key, 'primary.harness');
  assert.equal(view.errors[0].code, 'enum');
});

test('config validation: a retired id is a note, not an error; a dangling id is unchanged', (t) => {
  const registry = registryWithRetired(t);
  const f = createSettingsEnv(t);
  const judge = (key: string, value: unknown) => {
    const notes: string[] = [];
    const file = f.userFile('settings.json');
    const entry = layerEntry(registry, key, 'user', file, { ok: true, value },
      { env: f.env(), projectRoot: f.project, fsImpl: fs, repoRoot: REPO, notes });
    return { entry, notes };
  };
  assert.deepEqual(judge('workers.enabled', ['oldtool', 'codex']), { entry: null, notes: [`note: ${ADVISORY('workers.enabled')}`] });
  assert.deepEqual(judge('workers.enabled', ['zzz', 'codex']), { entry: null, notes: ["note: workers.enabled: worker 'zzz' is not installed (ignored)"] });
  assert.deepEqual(judge('primary.harness', 'oldtool'), { entry: null, notes: [`note: ${ADVISORY('primary.harness')}`] });
  assert.equal(judge('primary.harness', 'zzz').entry.code, 'enum');
});
