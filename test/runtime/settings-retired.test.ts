'use strict';

// A settings value naming a retired harness id is an unknown id like any other: the `retired` class and its
// advisory ("<key>: '<id>' is retired; use '<replacement>'") are gone, so it gets the dangling note or the enum
// error that `zzz` gets. The retired record is injected: a scratch repoRoot whose harnesses.json retires `oldtool`.

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
const DANGLING = (key: string, id: string) => `${key}: worker '${id}' is not installed (ignored)`;
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

const noRetiredNotes = (view: any) => view.notes.filter((n: any) => /retired/.test(n.text) || n.code === 'retired');

test('classifyWorkerId: a retired id is dangling like any unknown id', () => {
  const known = ['codex', 'claude'];
  assert.equal(classifyWorkerId('oldtool', known), 'dangling');
  assert.equal(classifyWorkerId('codex', known), 'ok');
  assert.equal(classifyWorkerId('zzz', known), 'dangling');
  assert.equal(classifyWorkerId('primary', known), 'reserved');
  assert.equal(classifyWorkerId('OLD', known), 'malformed');
});

test('workers.enabled: a retired id is a dangling note, kept in the value, with no retired advisory', (t) => {
  const f = createSettingsEnv(t);
  const file = f.writeUserSettings({ schema: 1, 'workers.enabled': ['oldtool', 'codex', 'primary'] });
  const view = loadSettings({ projectRoot: f.project, env: f.env(), registry: registryWithRetired(t) });
  assert.deepEqual(view.get('workers.enabled').value, ['oldtool', 'codex', 'primary']);
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.notes.filter((n: any) => n.code === 'dangling-worker'),
    [{ code: 'dangling-worker', key: 'workers.enabled', source: file, text: DANGLING('workers.enabled', 'oldtool') }]);
  assert.deepEqual(noRetiredNotes(view), []);
});

test('workers.billing: a retired entry invalidates the record like any unknown id', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'workers.billing': { oldtool: AGE, codex: AGE } });
  const registry = registryWithRetired(t);
  assert.deepEqual(readWorkerBilling(f.env(), { workerIds: ['codex', 'claude'], registry }),
    { state: 'invalid', reason: 'unknown-worker:oldtool', workers: {} });
});

test('primary.harness: a retired id is an enum error and the primary stays unresolved, for every layer', (t) => {
  const registry = registryWithRetired(t);
  for (const where of ['user', 'project', 'env']) {
    const f = createSettingsEnv(t);
    if (where === 'user') f.writeUserSettings({ schema: 1, 'primary.harness': 'oldtool' });
    if (where === 'project') f.writeProjectSettings({ schema: 1, 'primary.harness': 'oldtool' });
    const env = f.env(where === 'env' ? { DOFLOW_PRIMARY_HARNESS: 'oldtool' } : {});
    const view = loadSettings({ projectRoot: f.project, env, registry });
    assert.equal(view.get('primary.harness').value, 'unknown', where);
    assert.equal(view.errors.length, 1, where);
    assert.equal(view.errors[0].code, 'enum', where);
    assert.deepEqual(noRetiredNotes(view), [], where);
  }
});

test('config validation: a retired id gets the dangling note or the enum error that an unknown id gets', (t) => {
  const registry = registryWithRetired(t);
  const f = createSettingsEnv(t);
  const judge = (key: string, value: unknown) => {
    const notes: string[] = [];
    const file = f.userFile('settings.json');
    const entry = layerEntry(registry, key, 'user', file, { ok: true, value },
      { env: f.env(), projectRoot: f.project, fsImpl: fs, repoRoot: REPO, notes });
    return { entry, notes };
  };
  assert.deepEqual(judge('workers.enabled', ['oldtool', 'codex']), { entry: null, notes: [`note: ${DANGLING('workers.enabled', 'oldtool')}`] });
  assert.deepEqual(judge('workers.enabled', ['zzz', 'codex']), { entry: null, notes: [`note: ${DANGLING('workers.enabled', 'zzz')}`] });
  assert.equal(judge('primary.harness', 'oldtool').entry.code, 'enum');
  assert.equal(judge('primary.harness', 'zzz').entry.code, 'enum');
});
