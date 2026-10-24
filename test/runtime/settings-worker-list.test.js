'use strict';

// 120 IC-002, IC-003, IC-004: worker-list validity, ordered subset folding and person-written settings.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures');
const { validateValue } = require('../../src/runtime/settings/files.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { validateSettingsRegistry, REGISTRY_FILE } = require('../../src/runtime/settings/registry.ts');
const { LADDER_MAX } = require('../../src/registry/worker-ids.ts');

const KEY = 'workers.enabled';
const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));
const SPEC = SHIPPED.keys[KEY];
const IDS = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/harnesses.json'), 'utf8')).harnesses.map((h) => h.id);
const load = (f) => loadSettings({ projectRoot: f.project, env: f.env() });
const candidate = (r, layer) => r.candidates.find((c) => c.layer === layer);
const statuses = (r) => r.candidates.map((c) => `${c.layer}:${c.status}`);
const writeUser = (f, value) => f.writeUserSettings({ schema: 1, [KEY]: value });
const writeProject = (f, value) => f.writeProjectSettings({ schema: 1, [KEY]: value });

test('unset keeps the shipped worker order and primary; shipped billing ids remain valid', (t) => {
  const f = createSettingsEnv(t);
  const r = load(f).get(KEY);
  assert.deepEqual(r.value, [...IDS, 'primary']);
  assert.equal(r.state, 'ok');
  assert.equal(r.origin.layer, 'default');
  assert.equal(LADDER_MAX, 8);
  for (const id of IDS) {
    assert.equal(validateValue(SHIPPED.keys['workers.billing'], { [id]: { billing: 'free', asserted: '2026-10-23' } }), null, id);
  }
});

test('a project removes entries in the order below, and a local list narrows that result', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex', 'antigravity', 'primary']);
  writeProject(f, ['antigravity', 'codex']);
  let r = load(f).get(KEY);
  assert.deepEqual(r.value, ['codex', 'antigravity']);
  assert.deepEqual(statuses(r), ['user:overridden', 'project:decided']);
  assert.equal(candidate(r, 'project').code, 'order-ignored');
  assert.equal(candidate(r, 'project').reason, 'a project cannot reorder workers; the order below applies');
  f.writeProjectLocal({ schema: 1, [KEY]: ['antigravity'] });
  r = load(f).get(KEY);
  assert.deepEqual(r.value, ['antigravity']);
  assert.deepEqual(statuses(r), ['user:overridden', 'project:overridden', 'local:decided']);
  assert.equal(r.origin.layer, 'local');
});

test('an equal intersection is redundant, including a candidate that reverses its order', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex', 'antigravity']);
  for (const value of [['codex', 'antigravity'], ['antigravity', 'codex']]) {
    writeProject(f, value);
    const r = load(f).get(KEY);
    assert.deepEqual(r.value, ['codex', 'antigravity']);
    assert.deepEqual(statuses(r), ['user:decided', 'project:redundant']);
    assert.equal(r.origin.layer, 'user');
  }
});

test('an installed addition is not-narrower and names the first added worker', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex', 'primary']);
  writeProject(f, ['codex', 'kiro']);
  const r = load(f).get(KEY);
  assert.deepEqual(r.value, ['codex', 'primary']);
  assert.deepEqual(statuses(r), ['user:decided', 'project:not-narrower']);
  assert.equal(candidate(r, 'project').reason, "narrow-only: a project may only remove workers ('kiro' is not in the value below)");
});

test('a project can narrow the default, preserving shipped order', (t) => {
  const f = createSettingsEnv(t);
  writeProject(f, ['kiro', 'codex']);
  const r = load(f).get(KEY);
  assert.deepEqual(r.value, ['codex', 'kiro']);
  assert.equal(candidate(r, 'project').code, 'order-ignored');
});

test('a dangling user id remains valid and produces one note across views', (t) => {
  const f = createSettingsEnv(t);
  const file = writeUser(f, ['codex', 'agy', 'primary']);
  const view = load(f);
  assert.deepEqual(view.get(KEY).value, ['codex', 'agy', 'primary']);
  assert.equal(view.get(KEY).state, 'ok');
  view.get(KEY, 'global');
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.notes.filter((n) => n.code === 'dangling-worker'), [{
    code: 'dangling-worker', key: KEY, source: file,
    text: "workers.enabled: worker 'agy' is not installed (ignored)",
  }]);
});

test('a project dangling id is ignored for additions and is reported', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex', 'primary']);
  writeProject(f, ['codex', 'acme.coder']);
  const view = load(f);
  const r = view.get(KEY);
  assert.deepEqual(r.value, ['codex']);
  assert.equal(candidate(r, 'project').status, 'decided');
  assert.deepEqual(view.errors, []);
  assert.equal(view.notes.filter((n) => n.code === 'dangling-worker' && n.text.includes('acme.coder')).length, 1);
});

test('an empty intersection has no effect', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex']);
  writeProject(f, ['acme.coder']);
  const r = load(f).get(KEY);
  assert.deepEqual(r.value, ['codex']);
  assert.equal(candidate(r, 'project').status, 'no-effect');
  assert.equal(r.origin.layer, 'user');
});

for (const [value, code] of [
  [['primary', 'codex'], 'items'],
  [[], 'items'],
  [['codex', 'codex'], 'items'],
  [Array.from({ length: 9 }, (_, i) => `w${i}`), 'items'],
  [['codex', 'held'], 'reserved'],
  [['Codex'], 'type'],
  [[1], 'type'],
  ['codex', 'type'],
]) {
  test(`worker-list refuses ${JSON.stringify(value)} with ${code}`, () => {
    const fault = validateValue(SPEC, value);
    assert.ok(fault);
    assert.equal(fault.code, code);
    assert.equal(fault.reason.includes('held'), false);
    assert.equal(fault.reason.includes('Codex'), false);
  });
}

test('eight worker ids plus primary, primary alone and qualified ids are valid', () => {
  assert.equal(validateValue(SPEC, [...Array.from({ length: 8 }, (_, i) => `w${i}`), 'primary']), null);
  assert.equal(validateValue(SPEC, ['primary']), null);
  assert.equal(validateValue(SPEC, ['acme.coder']), null);
});

test('an invalid user list fails safe and a valid project cannot clear that state', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex', 'held']);
  let view = load(f);
  let r = view.get(KEY);
  assert.equal(r.state, 'invalid');
  assert.equal(r.origin.via, 'fail-safe');
  assert.equal(view.errors.find((e) => e.key === KEY).code, 'reserved');
  writeProject(f, ['codex']);
  view = load(f);
  r = view.get(KEY);
  assert.equal(r.state, 'invalid');
  assert.equal(r.origin.via, 'fail-safe');
  assert.equal(r.origin.layer, 'user');
  assert.equal(candidate(r, 'project').status, 'no-effect');
});

test('an invalid project list leaves a valid user list in place', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex', 'primary']);
  writeProject(f, ['codex', 'held']);
  const r = load(f).get(KEY);
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.value, ['codex', 'primary']);
  assert.deepEqual(statuses(r), ['user:decided', 'project:invalid']);
});

test('config set and unset refuse worker lists as security and create nothing', (t) => {
  const f = createSettingsEnv(t);
  for (const layer of ['user', 'project']) {
    for (const args of [['set', KEY, '["codex"]'], ['unset', KEY]]) {
      const result = f.run(['config', ...args, '--layer', layer, '--json']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.json.errors[0].code, 'security');
    }
  }
  assert.equal(fs.existsSync(f.configDir), false);
  assert.equal(fs.existsSync(f.userFile('settings.json')), false);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('config schema derives membership, default and the shared list cap', (t) => {
  const f = createSettingsEnv(t);
  const result = f.run(['config', 'schema', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const spec = result.json.keys.find((k) => k.key === KEY);
  assert.equal(spec.writable, false);
  assert.deepEqual(spec.values, IDS);
  assert.equal(spec.maxItems, 9);
  assert.deepEqual(spec.default, [...IDS, 'primary']);
});

test('config validate at the user layer accepts dangling ids and reports each once', (t) => {
  const f = createSettingsEnv(t);
  const result = f.run(['config', 'validate', KEY, '["codex","agy","zed"]', '--layer', 'user', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.json.notes, [
    "note: workers.enabled: worker 'agy' is not installed (ignored)",
    "note: workers.enabled: worker 'zed' is not installed (ignored)",
  ]);
  assert.equal(fs.existsSync(f.configDir), false);
  const reserved = f.run(['config', 'validate', KEY, '["codex","held"]', '--layer', 'user', '--json']);
  assert.equal(reserved.status, 1);
  assert.equal(reserved.json.errors[0].code, 'reserved');
  assert.deepEqual(reserved.json.errors[0].allowed, IDS);
  assert.equal(reserved.json.errors[0].message.includes('held'), false);
});

test('config validate uses project narrowing and reports ignored order and dangling ids', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex']);
  let result = f.run(['config', 'validate', KEY, '["codex","kiro"]', '--layer', 'project', '--json']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.json.errors[0].code, 'not-narrower');
  assert.match(result.json.errors[0].message, /kiro/);
  result = f.run(['config', 'validate', KEY, '["codex"]', '--layer', 'project', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  writeUser(f, ['codex', 'antigravity', 'primary']);
  result = f.run(['config', 'validate', KEY, '["antigravity","codex","acme.coder"]', '--layer', 'project', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.json.notes, [
    "note: workers.enabled: worker 'acme.coder' is not installed (ignored)",
    'note: workers.enabled: the order is ignored at the project layer; the order below applies',
  ]);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('registry accepts worker-list subset and refuses incompatible declarations', () => {
  const plant = (overrides) => {
    const spec = { ...structuredClone(SPEC), ...overrides };
    return { version: 1, description: 'planted', keys: { [KEY]: spec } };
  };
  assert.deepEqual(validateSettingsRegistry(plant({})).errors, []);
  for (const [overrides, fragment] of [
    [{ combine: 'override' }, "must combine by 'subset'"],
    [{ order: ['codex'] }, 'order is refused'],
    [{ orderRef: 'protocols.reviewPresetOrder' }, "'orderRef' is only for enum"],
    [{ values: ['codex'] }, "'values' is not allowed"],
    [{ maxItems: 9 }, "'maxItems' is only for string-list"],
    [{ maxLength: 32 }, "'maxLength' is only for string-list"],
    [{ type: 'enum', valuesRef: undefined, values: ['codex'], defaultRef: undefined, default: 'codex', order: ['codex'] }, "combine 'subset' is only for worker-list"],
    [{ needsConfigHome: true }, "failSafe {state: 'invalid'} cannot be combined"],
    [{ requires: [{ when: ['codex'], key: KEY, view: 'project' }] }, "failSafe {state: 'invalid'} cannot be combined"],
  ]) {
    const checked = validateSettingsRegistry(plant(overrides));
    assert.equal(checked.ok, false, JSON.stringify(overrides));
    assert.ok(checked.errors.some((e) => e.startsWith(KEY) && e.includes(fragment)), checked.errors.join('\n'));
  }
});
