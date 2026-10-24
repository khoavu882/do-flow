'use strict';

// 119 B.1 (IC-006, D-1): the settings registry's add-only `string-list` type (combine: union), the
// integer `max` and null default, and the three protocols refs. Every case builds a scratch repoRoot
// that copies the shipped core/registry files it needs and adds test-only keys; the shipped
// settings.json is never edited. A test reads only its own repo (FU-rvzby1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');
const { tempDir } = require('../helper/tmp.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { loadSettingsRegistry, validateSettingsRegistry, REGISTRY_FILE } = require('../../src/runtime/settings/registry.ts');
const { REF_META, createRefs } = require('../../src/runtime/settings/refs.ts');
const { validateValue } = require('../../src/runtime/settings/files.ts');

const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));
const PROTOCOLS = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/protocols.json'), 'utf8'));
const COMMON: any = { flag: null, shellRead: null, needsConfigHome: false, legacy: [], consumers: ['src/runtime/settings/resolve.ts'], securityRelevant: false, env: null };
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const statuses = (r: any) => r.candidates.map((c: any) => `${c.layer}:${c.status}`);

const KEYS: any = {
  'fixture.lenses': { ...COMMON, type: 'string-list', valuesRef: 'protocols.lensIds', maxItems: 3, maxLength: 40, default: [], scope: 'project-overridable', combine: 'union', description: 'lens ids' },
  'fixture.tags': { ...COMMON, type: 'string-list', maxItems: 3, maxLength: 5, default: ['seed'], scope: 'project-overridable', combine: 'union', description: 'free tags' },
  'fixture.cap': { ...COMMON, type: 'integer', min: 1, max: 5, order: 'descending', default: null, scope: 'narrow-only', combine: 'override', description: 'unset cap' },
};

/** A scratch repoRoot: the shipped protocols.json plus a settings.json of the test-only keys. */
function scratch(t: any, keys: any = KEYS) {
  const dir = tempDir(t, 'doflow-list-type-');
  fs.mkdirSync(path.join(dir, 'core', 'registry'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'core/registry/protocols.json'), path.join(dir, 'core/registry/protocols.json'));
  fs.writeFileSync(path.join(dir, REGISTRY_FILE), JSON.stringify({ version: 1, description: 'fixture', keys }));
  const loaded = loadSettingsRegistry({ repoRoot: dir, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.detail);
  return loaded.registry;
}

function view(t: any, keys: any, user?: any, project?: any) {
  const f = createSettingsEnv(t);
  if (user) f.writeUserSettings({ schema: 1, ...user });
  if (project) f.writeProjectSettings({ schema: 1, ...project });
  return loadSettings({ projectRoot: f.project, env: f.env(), registry: scratch(t, keys) });
}

test('union: user and project lists both apply; the user candidate stays decided, the origin is the project', (t) => {
  const v = view(t, KEYS, { 'fixture.lenses': ['correctness'] }, { 'fixture.lenses': ['boundaries'] });
  const r = v.get('fixture.lenses');
  assert.deepEqual(r.value, ['correctness', 'boundaries']);
  assert.deepEqual(statuses(r), ['user:decided', 'project:decided']);
  assert.equal(r.origin.layer, 'project');
  assert.deepEqual(v.errors, []);
});

test('union: an item already present is dropped and a candidate adding nothing is redundant', (t) => {
  const v = view(t, KEYS, { 'fixture.lenses': ['correctness', 'boundaries'] }, { 'fixture.lenses': ['boundaries'] });
  const r = v.get('fixture.lenses');
  assert.deepEqual(r.value, ['correctness', 'boundaries']);
  assert.deepEqual(statuses(r), ['user:decided', 'project:redundant']);
  assert.equal(r.origin.layer, 'user');
  assert.match(r.candidates[1].reason, /already present/);
});

test('union: the default list is the start, and an unset key resolves to it', (t) => {
  assert.deepEqual(view(t, KEYS).get('fixture.tags').value, ['seed']);
  const r = view(t, KEYS, { 'fixture.tags': ['seed', 'a'] }).get('fixture.tags');
  assert.deepEqual(r.value, ['seed', 'a']);
});

test('validateValue: duplicate and over-count -> items, over-length -> length, outside the ref list -> enum, shape -> type', (t) => {
  const registry = scratch(t);
  const lenses = registry.keys.get('fixture.lenses');
  const tags = registry.keys.get('fixture.tags');
  const code = (spec: any, value: any) => validateValue(spec, value, registry.enumValues(spec === lenses ? 'fixture.lenses' : 'fixture.tags'))?.code ?? null;
  assert.equal(code(tags, ['a', 'a']), 'items');
  assert.equal(code(tags, ['a', 'b', 'c', 'd']), 'items');
  assert.equal(code(tags, ['abcdef']), 'length');
  assert.equal(code(lenses, ['correctness', 'nope']), 'enum');
  assert.equal(code(tags, 'a'), 'type');
  assert.equal(code(tags, ['a', 3]), 'type');
  assert.equal(code(tags, ['a', '']), 'type');
  assert.equal(code(tags, ['a', 'b']), null);
  assert.equal(code(lenses, ['correctness', 'boundaries']), null);
  assert.equal(code(lenses, []), null);
  assert.deepEqual(registry.enumValues('fixture.lenses'), PROTOCOLS.lenses.map((l: any) => l.id));
  assert.equal(registry.enumValues('fixture.tags'), null);
  assert.equal(registry.enumValues('fixture.cap'), null);
  assert.equal(validateValue(lenses, ['correctness'], null)?.code, 'enum', 'no list available -> enum');
  for (const fault of [validateValue(tags, ['abcdef'], null), validateValue(lenses, ['SECRET'], registry.enumValues('fixture.lenses'))]) {
    assert.ok(!JSON.stringify(fault).includes('abcdef') && !JSON.stringify(fault).includes('SECRET'), 'reason never echoes the value');
  }
});

test('layer reads: a duplicate inside one layer is an items error and the key falls through; meta carries the list', (t) => {
  const v = view(t, KEYS, { 'fixture.tags': ['x', 'x'] }, { 'fixture.lenses': ['correctness', 'bad'] });
  const tags = v.get('fixture.tags');
  assert.equal(tags.candidates[0].status, 'invalid');
  assert.equal(tags.candidates[0].code, 'items');
  assert.deepEqual(tags.value, ['seed'], 'the invalid candidate is skipped when the key has no failSafe');
  const lenses = v.get('fixture.lenses');
  assert.equal(lenses.candidates[0].code, 'enum');
  assert.deepEqual(lenses.value, []);
  assert.deepEqual(lenses.meta.values, PROTOCOLS.lenses.map((l: any) => l.id));
  assert.equal(tags.meta.values, null);
  assert.deepEqual(v.errors.map((e: any) => [e.key, e.code]), [['fixture.tags', 'items'], ['fixture.lenses', 'enum']]);
});

test('integer max: a value above it is a range error ("at most"), min keeps "at least"', (t) => {
  const cap = scratch(t).keys.get('fixture.cap');
  assert.equal(validateValue(cap, 6)?.code, 'range');
  assert.match(validateValue(cap, 6).reason, /at most 5/);
  assert.match(validateValue(cap, 0).reason, /at least 1/);
  assert.equal(validateValue(cap, 5), null);
});

test('integer null default resolves to null; a narrow-only descending value over the unset value applies (L-B4)', (t) => {
  const none = view(t, KEYS).get('fixture.cap');
  assert.equal(none.value, null);
  assert.equal(none.explicit, false);
  const set = view(t, KEYS, null, { 'fixture.cap': 2 }).get('fixture.cap');
  assert.equal(set.value, 2);
  assert.deepEqual(statuses(set), ['project:decided']);
  const wider = view(t, KEYS, { 'fixture.cap': 2 }, { 'fixture.cap': 1 }).get('fixture.cap');
  assert.equal(wider.value, 2, 'against a set value the narrowing rule is unchanged');
  assert.deepEqual(statuses(wider), ['user:decided', 'project:not-narrower']);
  const over = view(t, KEYS, null, { 'fixture.cap': 9 });
  assert.equal(over.get('fixture.cap').value, null);
  assert.equal(over.errors[0].code, 'range');
});

test('registry validator refuses the new type used wrongly, each with a passing control', () => {
  const cases: any = [
    ['union on an enum key', (keys: any) => { keys['storage.prune'].combine = 'union'; }, /storage\.prune .*union/],
    ['narrow-only on a string-list', (keys: any) => { keys['fixture.tags'].scope = 'narrow-only'; }, /fixture\.tags .*narrow-only/],
    ['string-list without maxItems', (keys: any) => { delete keys['fixture.tags'].maxItems; }, /fixture\.tags .*maxItems/],
    ['string-list without maxLength', (keys: any) => { delete keys['fixture.tags'].maxLength; }, /fixture\.tags .*maxLength/],
    ['string-list combined by override', (keys: any) => { keys['fixture.tags'].combine = 'override'; }, /fixture\.tags .*union/],
    ['string-list with literal values', (keys: any) => { keys['fixture.tags'].values = ['a']; }, /fixture\.tags .*values/],
    ['string-list with an order', (keys: any) => { keys['fixture.tags'].order = 'ascending'; }, /fixture\.tags .*order/],
    ['string-list default that is not a valid list', (keys: any) => { keys['fixture.tags'].default = ['a', 'a']; }, /fixture\.tags default is not valid/],
    ['maxItems on an integer key', (keys: any) => { keys['fixture.cap'].maxItems = 2; }, /fixture\.cap .*maxItems/],
    ['max on a non-integer', (keys: any) => { keys['fixture.tags'].max = 3; }, /fixture\.tags .*max/],
    ['max below min', (keys: any) => { keys['fixture.cap'].max = 0; }, /fixture\.cap .*max/],
    ['unknown valuesRef on a string-list', (keys: any) => { keys['fixture.lenses'].valuesRef = 'protocols.nope'; }, /fixture\.lenses .*valuesRef/],
  ];
  const base = () => { const raw = clone(SHIPPED); Object.assign(raw.keys, clone(KEYS)); return raw; };
  assert.deepEqual(validateSettingsRegistry(base()).errors, [], 'control: the valid registry with the new keys passes');
  for (const [name, plant, expected] of cases) {
    const raw = base();
    plant(raw.keys);
    const result = validateSettingsRegistry(raw);
    assert.equal(result.ok, false, name);
    assert.ok(result.errors.some((e: any) => expected.test(e)), `${name}: ${result.errors.join(' | ')}`);
  }
});

test('the protocols refs resolve to the shipped values; a bad shape names the file and field', (t) => {
  const refs = createRefs({ repoRoot: REPO });
  const review = refs.resolve('protocols.reviewPresetIds');
  assert.equal(review[0], 'auto');
  assert.deepEqual(review.slice(1), PROTOCOLS.order.review);
  assert.deepEqual(refs.resolve('protocols.debatePresetIds'), PROTOCOLS.order.debate);
  assert.deepEqual(refs.resolve('protocols.lensIds'), PROTOCOLS.lenses.map((l: any) => l.id));
  for (const name of ['protocols.reviewPresetIds', 'protocols.debatePresetIds', 'protocols.lensIds']) {
    assert.deepEqual(REF_META[name], { kind: 'values', dependsOn: [] }, name);
  }
  const bad = tempDir(t, 'doflow-list-refs-');
  fs.mkdirSync(path.join(bad, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'core/registry/protocols.json'), JSON.stringify({ order: { review: [], debate: ['ok', 3] }, lenses: [{ id: '' }] }));
  const broken = createRefs({ repoRoot: bad });
  for (const [name, field] of [['protocols.reviewPresetIds', 'order.review'], ['protocols.debatePresetIds', 'order.debate'], ['protocols.lensIds', 'lenses']]) {
    assert.throws(() => broken.resolve(name), (error: any) => error.message.includes('core/registry/protocols.json') && error.message.includes(field), name);
  }
});
