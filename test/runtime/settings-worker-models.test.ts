'use strict';

// 120 IC-002, IC-003: person-written model maps, registry tiers, scope and CLI validation.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');
const { validateValue } = require('../../src/runtime/settings/files.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { loadSettingsRegistry, validateSettingsRegistry, REGISTRY_FILE } = require('../../src/runtime/settings/registry.ts');
const { createRefs, REF_META } = require('../../src/runtime/settings/refs.ts');

const KEY = 'workers.models';
const MODELS_FILE = 'core/registry/models.json';
const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));
const SPEC = loadSettingsRegistry().registry.keys.get(KEY);
const TIERS = JSON.parse(fs.readFileSync(path.join(REPO, MODELS_FILE), 'utf8')).dispatchTiers.tiers;
const IDS = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/harnesses.json'), 'utf8')).harnesses.map((h: any) => h.id);
const GOOD = {
  codex: { light: 'gpt-6-luna', frontier: 'gpt-6.1-sol' },
  antigravity: { standard: 'Gemini 4 Argon (Medium)' },
};

// IC-003: every resolver and CLI fixture uses its own config home and project.
const load = (f: any) => loadSettings({ projectRoot: f.project, env: f.env() });
const candidate = (r: any, layer: any) => r.candidates.find((c: any) => c.layer === layer);
const writeUser = (f: any, value: any) => f.writeUserSettings({ schema: 1, [KEY]: value });
const writeProject = (f: any, value: any) => f.writeProjectSettings({ schema: 1, [KEY]: value });

// IC-002: plant the shipped declaration without its loaded, non-enumerable tiers getter.
const plant = (overrides = {}) => ({
  version: 1,
  description: 'planted worker models',
  keys: { [KEY]: { ...structuredClone(SHIPPED.keys[KEY]), ...overrides } },
});

test('unset is null with a default origin; schema derives workers and tiers', (t) => {
  const f = createSettingsEnv(t);
  const r = load(f).get(KEY);
  assert.equal(r.value, null);
  assert.equal(r.state, 'ok');
  assert.equal(r.origin.layer, 'default');
  const result = f.run(['config', 'schema', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entry = result.json.keys.find((k: any) => k.key === KEY);
  assert.equal(entry.type, 'worker-models');
  assert.equal(entry.writable, false);
  assert.equal(entry.default, null);
  assert.deepEqual(entry.values, IDS);
  assert.deepEqual(entry.tiers, TIERS);
  for (const other of result.json.keys.filter((k: any) => k.key !== KEY)) {
    assert.equal(other.tiers, null, other.key);
  }
  assert.equal(fs.existsSync(f.configDir), false);
});

test('a user model map applies without errors or notes', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, GOOD);
  const view = load(f);
  const r = view.get(KEY);
  assert.deepEqual(r.value, GOOD);
  assert.equal(r.state, 'ok');
  assert.equal(r.origin.layer, 'user');
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.notes, []);
});

test('an invalid user tier fails safe and a project cannot clear the invalid state', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, { codex: { ultra: 'x' } });
  let view = load(f);
  let r = view.get(KEY);
  assert.equal(r.state, 'invalid');
  assert.equal(r.origin.via, 'fail-safe');
  assert.equal(view.errors.find((e: any) => e.key === KEY).code, 'enum');
  assert.equal(view.errors.find((e: any) => e.key === KEY).reason.includes('ultra'), false);
  writeProject(f, GOOD);
  view = load(f);
  r = view.get(KEY);
  assert.equal(candidate(r, 'project').status, 'ignored-scope');
  assert.equal(r.state, 'invalid');
  assert.equal(r.origin.layer, 'user');
  assert.equal(r.origin.via, 'fail-safe');
});

test('project and local model maps are ignored with and without a user value', (t) => {
  const f = createSettingsEnv(t);
  writeProject(f, GOOD);
  f.writeProjectLocal({ schema: 1, [KEY]: GOOD });
  let r = load(f).get(KEY);
  assert.equal(r.value, null);
  assert.equal(r.state, 'ok');
  assert.equal(candidate(r, 'project').status, 'ignored-scope');
  assert.equal(candidate(r, 'local').status, 'ignored-scope');
  writeUser(f, GOOD);
  r = load(f).get(KEY);
  assert.deepEqual(r.value, GOOD);
  assert.equal(r.origin.layer, 'user');
  assert.equal(candidate(r, 'project').status, 'ignored-scope');
  assert.equal(candidate(r, 'local').status, 'ignored-scope');
});

test('worker-models faults use stable codes and never echo input keys, tiers or models', () => {
  const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`w${i}`, { light: 'x' }]));
  for (const [value, code, secret] of [
    [{}, 'items'],
    [seventeen, 'items'],
    [[], 'type'],
    [null, 'type'],
    ['private-input-text', 'type', 'private-input-text'],
    [new Date(0), 'type'],
    [{ codex: {} }, 'items'],
    [{ codex: { light: 'x', standard: 'x', frontier: 'x', ultra: 'x' } }, 'items', 'ultra'],
    [{ codex: 'private-entry-text' }, 'type', 'private-entry-text'],
    [{ codex: [] }, 'type'],
    [{ codex: new Date(0) }, 'type'],
    [{ held: { light: 'x' } }, 'reserved', 'held'],
    [{ primary: { light: 'x' } }, 'reserved', 'primary'],
    [{ Codex: { light: 'x' } }, 'type', 'Codex'],
    [{ codex: { ultra: 'x' } }, 'enum', 'ultra'],
    [{ codex: { light: '-rf' } }, 'type', '-rf'],
    [{ codex: { light: 5 } }, 'type', '5'],
    [{ codex: { light: 'z'.repeat(121) } }, 'length', 'z'.repeat(121)],
  ]) {
    const fault = validateValue(SPEC, value);
    assert.ok(fault, JSON.stringify(value));
    assert.equal(fault.code, code, JSON.stringify(value));
    assert.equal(fault.reason.includes('codex'), false);
    if (secret) assert.equal(fault.reason.includes(secret), false, fault.reason);
  }
});

test('worker-models accepts sixteen workers, all three tiers and qualified ids', () => {
  const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`w${i}`, { light: 'x' }]));
  assert.equal(validateValue(SPEC, sixteen), null);
  assert.equal(validateValue(SPEC, GOOD), null);
  assert.equal(validateValue(SPEC, { codex: { light: 'a', standard: 'b', frontier: 'c' } }), null);
  assert.equal(validateValue(SPEC, { 'acme.coder': { light: 'provider/model#v' } }), null);
  assert.equal(validateValue(SPEC, { codex: { light: 'Model [1m]' } }), null);
});

test('worker-models needs available tiers and reports the first fault in traversal order', () => {
  const fault = validateValue({ type: 'worker-models' }, { codex: { light: 'x' } });
  assert.deepEqual(fault, { code: 'enum', reason: 'has no allowed tiers available' });
  assert.equal(validateValue(SPEC, { Codex: {} }).code, 'type');
  assert.equal(validateValue(SPEC, { held: {} }).code, 'reserved');
  assert.equal(validateValue(SPEC, { codex: { light: '-rf', ultra: 'x' } }).code, 'type');
  assert.equal(validateValue(SPEC, { codex: { ultra: 'x', light: '-rf' } }).code, 'enum');
  assert.equal(validateValue(SPEC, { codex: {}, held: { light: 'x' } }).code, 'items');
});

test('dangling model-map keys remain valid and produce one note per id across both views', (t) => {
  const f = createSettingsEnv(t);
  const value = { codex: { light: 'x' }, agy: { light: 'y' }, 'acme.coder': { standard: 'z' } };
  const file = writeUser(f, value);
  const view = load(f);
  assert.deepEqual(view.get(KEY).value, value);
  assert.equal(view.get(KEY).state, 'ok');
  assert.deepEqual(view.get(KEY, 'global').value, value);
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.notes.filter((n: any) => n.code === 'dangling-worker'), [
    { code: 'dangling-worker', key: KEY, source: file, text: "workers.models: worker 'agy' is not installed (ignored)" },
    { code: 'dangling-worker', key: KEY, source: file, text: "workers.models: worker 'acme.coder' is not installed (ignored)" },
  ]);
});

test('no config home returns the invalid fail-safe object via no-config-home', (t) => {
  const f = createSettingsEnv(t);
  const view = loadSettings({ projectRoot: f.project, env: { PATH: process.env.PATH } });
  const r = view.get(KEY, 'global');
  assert.deepEqual(r.value, { state: 'invalid' });
  assert.equal(r.origin.via, 'no-config-home');
  assert.deepEqual(view.configHome, { dir: null, ignored: [] });
});

test('config set and unset refuse worker models as security and create nothing', (t) => {
  const f = createSettingsEnv(t);
  for (const layer of ['user', 'project']) {
    for (const args of [['set', KEY, JSON.stringify(GOOD)], ['unset', KEY]]) {
      const result = f.run(['config', ...args, '--layer', layer, '--json']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.json.errors[0].code, 'security');
    }
  }
  assert.equal(fs.existsSync(f.configDir), false);
  assert.equal(fs.existsSync(f.userFile('settings.json')), false);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('config validate accepts user model maps and shape-only validation without writing', (t) => {
  const f = createSettingsEnv(t);
  for (const layerArgs of [[], ['--layer', 'user']]) {
    const result = f.run(['config', 'validate', KEY, JSON.stringify(GOOD), ...layerArgs, '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.json.ok, true);
    assert.deepEqual(result.json.errors, []);
  }
  assert.equal(fs.existsSync(f.configDir), false);
  assert.equal(fs.existsSync(f.userFile('settings.json')), false);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('config validate reports dangling model-map keys in key order', (t) => {
  const f = createSettingsEnv(t);
  const value = { codex: { light: 'x' }, agy: { light: 'y' }, 'acme.coder': { standard: 'z' } };
  const result = f.run(['config', 'validate', KEY, JSON.stringify(value), '--layer', 'user', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.json.notes, [
    "note: workers.models: worker 'agy' is not installed (ignored)",
    "note: workers.models: worker 'acme.coder' is not installed (ignored)",
  ]);
  assert.equal(fs.existsSync(f.configDir), false);
});

test('config validate reports enum and scope faults while billing keeps its security refusal', (t) => {
  const f = createSettingsEnv(t);
  const invalid = f.run(['config', 'validate', KEY, '{"codex":{"ultra":"x"}}', '--layer', 'user', '--json']);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.equal(invalid.json.errors[0].code, 'enum');
  assert.equal(invalid.json.errors[0].message.includes('ultra'), false);
  assert.deepEqual(invalid.json.errors[0].allowed, IDS);
  const project = f.run(['config', 'validate', KEY, JSON.stringify(GOOD), '--layer', 'project', '--json']);
  assert.equal(project.status, 1, project.stdout + project.stderr);
  assert.equal(project.json.errors[0].code, 'scope');
  const billing = f.run(['config', 'validate', 'workers.billing', '{}', '--layer', 'user', '--json']);
  assert.equal(billing.status, 1, billing.stdout + billing.stderr);
  assert.equal(billing.json.errors[0].code, 'security');
  assert.equal(fs.existsSync(f.configDir), false);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
});

test('registry accepts the shipped worker-models declaration alone and refuses incompatible rules', () => {
  assert.deepEqual(validateSettingsRegistry(plant()).errors, []);
  assert.equal(validateSettingsRegistry(plant({ needsConfigHome: true })).ok, true);
  const missingTiers = plant();
  delete missingTiers.keys[KEY].tiersRef;
  assert.ok(validateSettingsRegistry(missingTiers).errors.some((e: any) => e.includes("a worker-models key needs 'tiersRef'")));
  for (const [overrides, fragment] of [
    [{ scope: 'narrow-only' }, 'cannot be narrow-only'],
    [{ combine: 'subset' }, "must combine by 'override'"],
    [{ default: GOOD }, 'must default to null'],
    [{ order: ['light'] }, 'order is refused'],
    [{ failSafe: 'off' }, "needs failSafe {state: 'invalid'}"],
    [{ tiersRef: 'protocols.reviewPresetOrder' }, "tiersRef 'protocols.reviewPresetOrder' is not a known values ref"],
    [{ tiersRef: 'models.missing' }, "tiersRef 'models.missing' is not a known values ref"],
    [{ maxItems: 16 }, "'maxItems' is only for string-list"],
    [{ values: IDS }, "'values' is not allowed"],
    [{ requires: [{ when: GOOD, key: KEY, view: 'global' }] }, "failSafe {state: 'invalid'} cannot be combined"],
  ]) {
    const checked = validateSettingsRegistry(plant(overrides));
    assert.equal(checked.ok, false, JSON.stringify(overrides));
    assert.ok(checked.errors.some((e: any) => e.startsWith(KEY) && e.includes(fragment)), checked.errors.join('\n'));
  }
  const list = {
    version: 1,
    description: 'planted worker list',
    keys: { 'workers.enabled': { ...structuredClone(SHIPPED.keys['workers.enabled']), tiersRef: 'models.tierIds' } },
  };
  assert.ok(validateSettingsRegistry(list).errors.some((e: any) => e.includes("'tiersRef' is only for worker-models keys")));
});

test('registry verifies tiersRef resolves to a non-empty list of distinct strings', () => {
  for (const tiers of [[], ['light', 'light'], [1], null]) {
    const checked = validateSettingsRegistry(plant(), {
      meta: REF_META,
      resolve: (name: any) => name === 'models.tierIds' ? tiers : IDS,
    });
    assert.equal(checked.ok, false);
    assert.ok(checked.errors.some((e: any) => e.endsWith("tiersRef 'models.tierIds' did not resolve to a non-empty list of strings")), checked.errors.join('\n'));
  }
  assert.equal(validateSettingsRegistry(plant(), {
    meta: REF_META,
    resolve: (name: any) => name === 'models.tierIds' ? TIERS : IDS,
  }).ok, true);
});

test('loaded tiers are lazy, non-enumerable, cached and null on source failure', () => {
  for (const broken of [false, true]) {
    let reads = 0;
    const loaded = loadSettingsRegistry({
      repoRoot: REPO,
      fsImpl: {
        readFileSync(file: any, ...args: any[]) {
          if (file === path.join(REPO, MODELS_FILE)) {
            reads += 1;
            if (broken) throw new Error('unavailable');
          }
          return fs.readFileSync(file, ...args);
        },
      },
    });
    assert.equal(loaded.ok, true, loaded.detail);
    assert.equal(reads, 0);
    const spec: any = loaded.registry.keys.get(KEY);
    assert.equal(Object.isFrozen(spec), true);
    assert.equal(Object.getOwnPropertyDescriptor(spec, 'tiers')!.enumerable, false);
    assert.equal(Object.keys(spec).includes('tiers'), false);
    assert.deepEqual(spec.tiers, broken ? null : TIERS);
    assert.deepEqual(spec.tiers, broken ? null : TIERS);
    assert.equal(reads, 1);
    if (broken) assert.equal(validateValue(spec, GOOD).code, 'enum');
  }
});

test('models.tierIds names its source and rejects missing, empty or duplicate tiers', (t) => {
  assert.deepEqual(REF_META['models.tierIds'], { kind: 'values', dependsOn: [] });
  assert.deepEqual(createRefs({ repoRoot: REPO }).resolve('models.tierIds'), TIERS);
  const repoRoot = tempDir(t, 'doflow-model-tier-ref-');
  const file = path.join(repoRoot, MODELS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const data of [
    {},
    { dispatchTiers: {} },
    { dispatchTiers: { tiers: [] } },
    { dispatchTiers: { tiers: ['light', 'light'] } },
    { dispatchTiers: { tiers: [''] } },
    { dispatchTiers: { tiers: [1] } },
  ]) {
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(() => createRefs({ repoRoot }).resolve('models.tierIds'), /core\/registry\/models\.json dispatchTiers\.tiers/);
  }
});

test('IC-003: every shipped model-id or worker-models key defaults to null', () => {
  assert.equal(SHIPPED.keys[KEY].type, 'worker-models');
  for (const [key, spec] of Object.entries(SHIPPED.keys)) {
    if (spec.type === 'model-id' || spec.type === 'worker-models') {
      assert.equal(spec.default, null, key);
      assert.equal(Object.hasOwn(spec, 'defaultRef'), false, key);
    }
  }
});
