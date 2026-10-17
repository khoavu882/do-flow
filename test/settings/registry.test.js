'use strict';

// 086 C.1 (IC-001, DD-1, DD-4, DD-5, DD-6): the shipped settings registry equals the pinned v1 entries,
// every load-time check fails on a planted bad registry (each with a control that passes without the
// planted fault), and a bad registry fails the loader instead of becoming a default. No test touches
// the real home: nothing here reads HOME or XDG_CONFIG_HOME.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('../helper/settings-fixtures');
const { validateSettingsRegistry, loadSettingsRegistry, derivedEnvName, REGISTRY_FILE } = require('../../src/runtime/settings/registry.ts');
const { REF_META, createRefs } = require('../../src/runtime/settings/refs.ts');

const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));

// The seven v1 entries, exactly as design/data-model.md §1 states them (the design folder is not in
// the repo, so the contract is pinned here; a registry edit must change this table on purpose).
const V1 = {
  'advice.enabled': { type: 'boolean', order: [false, true], default: false,
    scope: 'narrow-only', combine: 'override', securityRelevant: true, failSafe: false,
    requires: [{ when: true, key: 'advice.model', view: 'global' }],
    env: null, flag: null, shellRead: null, needsConfigHome: false,
    legacy: [{ layer: 'user', kind: 'decision-model', path: 'decision-model.json', field: 'enabled' },
      { layer: 'project', kind: 'decision-model', path: 'decision-model.json', field: 'enabled' }],
    consumers: ['src/runtime/advice/config.ts'], description: 'Turns the local decision model on; a project may only turn it off.' },
  'advice.provider': { type: 'enum', valuesRef: 'advice.providerIds', default: 'ollama',
    scope: 'global-only', combine: 'override', securityRelevant: true, failSafe: { gate: 'advice.enabled' },
    env: null, flag: null, shellRead: null, needsConfigHome: false,
    legacy: [{ layer: 'user', kind: 'decision-model', path: 'decision-model.json', field: 'provider' },
      { layer: 'project', kind: 'decision-model', path: 'decision-model.json', field: 'provider' }],
    consumers: ['src/runtime/advice/config.ts'], description: 'Decision-model provider id from advice.json.' },
  'advice.endpoint': { type: 'url', defaultRef: 'advice.providerDefaultEndpoint',
    scope: 'global-only', combine: 'override', securityRelevant: true, failSafe: { gate: 'advice.enabled' },
    env: null, flag: null, shellRead: null, needsConfigHome: false,
    legacy: [{ layer: 'user', kind: 'decision-model', path: 'decision-model.json', field: 'endpoint' },
      { layer: 'project', kind: 'decision-model', path: 'decision-model.json', field: 'endpoint' }],
    consumers: ['src/runtime/advice/config.ts'], description: "Decision-model endpoint; default is the provider's defaultEndpoint." },
  'advice.model': { type: 'string', default: null, scope: 'project-overridable', combine: 'override',
    securityRelevant: false, env: null, flag: null, shellRead: null, needsConfigHome: false,
    legacy: [{ layer: 'user', kind: 'decision-model', path: 'decision-model.json', field: 'model' },
      { layer: 'project', kind: 'decision-model', path: 'decision-model.json', field: 'model' }],
    consumers: ['src/runtime/advice/config.ts'], description: 'Decision-model name; a project may choose it while advice is on.' },
  'storage.prune': { type: 'enum', values: ['off', 'on'], order: ['off', 'on'], default: 'on',
    scope: 'project-overridable', combine: 'override', views: ['project', 'global'], securityRelevant: false,
    failSafe: 'off', env: null, flag: null, shellRead: null, needsConfigHome: false,
    legacy: [{ layer: 'user', kind: 'line-onoff', path: 'prune' }, { layer: 'project', kind: 'line-onoff', path: 'prune' }],
    consumers: ['src/runtime/storage/roots.ts', 'src/runtime/storage/upkeep.ts', 'src/runtime/storage/cli.ts', 'src/runtime/lifecycle/retention.ts'],
    description: 'Storage pruning; project value applies to project roots only.' },
  'storage.retentionHours': { type: 'integer', min: 1, defaultRef: 'storage.lifecycleEventsDefaultHours',
    scope: 'project-overridable', combine: 'override', securityRelevant: false, failSafe: { state: 'invalid' },
    env: { name: 'DOFLOW_RETENTION_HOURS', parse: 'positive-int', direction: 'any' },
    flag: null, shellRead: null, needsConfigHome: false, legacy: [],
    consumers: ['src/runtime/lifecycle/retention.ts'], description: 'Lifecycle-events window in hours; an explicit value applies even while pruning is off.' },
  'failure.capture': { type: 'enum', values: ['off', 'on'], order: ['off', 'on'], default: 'on',
    scope: 'global-only', combine: 'narrowest', securityRelevant: false, failSafe: 'off',
    env: { name: 'DOFLOW_FAILURE_CAPTURE', parse: 'off-words', direction: 'narrow' },
    flag: null, shellRead: 'lexical-v1', needsConfigHome: true,
    legacy: [{ layer: 'user', kind: 'sentinel', path: 'failures/off', value: 'off' }],
    consumers: ['src/runtime/failure/home.ts'], description: "Capture of DoFlow's own failures on this machine; any layer saying off wins." },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

// ── the shipped registry ───────────────────────────────────────────────────────────────────────

test('the shipped registry has exactly the seven v1 entries, equal to data-model §1, in display order', () => {
  assert.equal(SHIPPED.version, 1);
  assert.deepEqual(Object.keys(SHIPPED.keys), Object.keys(V1));
  assert.deepEqual(SHIPPED.keys, V1);
  assert.equal(Object.keys(SHIPPED.keys).length, 7);
});

test('prompt-nudge is not registered (D-2) and no key outside the seven exists', () => {
  assert.equal(Object.keys(SHIPPED.keys).some((key) => /nudge/i.test(key)), false);
  assert.equal(JSON.stringify(SHIPPED).includes('prompt-nudge'), false);
});

test('the shipped registry loads with refs resolved and every consumer path present', () => {
  const loaded = loadSettingsRegistry({ verifyRefs: true, checkConsumers: true });
  assert.equal(loaded.ok, true, loaded.detail);
  assert.deepEqual([...loaded.registry.keys.keys()], Object.keys(V1));
  assert.deepEqual(loaded.registry.enumValues('advice.provider'), ['ollama']);
  assert.deepEqual(loaded.registry.enumValues('storage.prune'), ['off', 'on']);
  assert.equal(loaded.registry.enumValues('advice.model'), null, 'not an enum');
});

test('the default load (no ref resolution, no consumer check) also accepts the shipped file and is cached per process', () => {
  const first = loadSettingsRegistry();
  assert.equal(first.ok, true);
  assert.equal(loadSettingsRegistry(), first, 'same object: the file is read once');
  assert.notEqual(loadSettingsRegistry({ verifyRefs: true }), first, 'a different option set is a different load');
});

test('defaultRef values equal advice.json defaultEndpoint and storage.json lifecycle-events defaultHours', () => {
  const advice = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/advice.json'), 'utf8'));
  const storage = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/storage.json'), 'utf8'));
  const refs = createRefs();
  assert.equal(refs.resolve('advice.providerDefaultEndpoint', { 'advice.provider': 'ollama' }), advice.providers.find((p) => p.id === 'ollama').defaultEndpoint);
  assert.equal(refs.resolve('storage.lifecycleEventsDefaultHours'), storage.stores.find((s) => s.id === 'lifecycle-events').bound.defaultHours);
  assert.equal(refs.resolve('storage.lifecycleEventsDefaultHours'), 4320);
  assert.deepEqual(refs.resolve('advice.providerIds'), advice.providers.map((p) => p.id));
  assert.deepEqual(Object.keys(REF_META).sort(), ['advice.providerDefaultEndpoint', 'advice.providerIds', 'storage.lifecycleEventsDefaultHours']);
});

test('refs: an unknown name (including an inherited property name) and an unreadable source throw without file text', () => {
  const refs = createRefs();
  assert.throws(() => refs.resolve('nope'), /unknown settings ref 'nope'/);
  assert.throws(() => refs.resolve('constructor'), /unknown settings ref/);
  assert.throws(() => refs.resolve('__proto__'), /unknown settings ref/);
  const secret = 'SECRET-JSON-TEXT';
  const broken = createRefs({ fsImpl: { readFileSync: () => `{ ${secret}` } });
  assert.throws(() => broken.resolve('advice.providerIds'), (error) => /advice\.json could not be read as JSON/.test(error.message) && !error.message.includes(secret));
  const wrongShape = createRefs({ fsImpl: { readFileSync: () => '{"providers":[]}' } });
  assert.throws(() => wrongShape.resolve('advice.providerIds'), /providers\[\]\.id/);
  const noStore = createRefs({ fsImpl: { readFileSync: () => '{"stores":[]}' } });
  assert.throws(() => noStore.resolve('storage.lifecycleEventsDefaultHours'), /defaultHours/);
});

// ── load-time checks: a planted bad registry per rule, each with a control ───────────────────────

const GOOD = {
  type: 'integer', min: 1, default: 5, scope: 'project-overridable', combine: 'override', securityRelevant: false,
  env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
  consumers: ['src/runtime/settings/registry.ts'], description: 'A planted integer key.',
};
const registryOf = (keys) => ({ version: 1, description: 'planted', keys });
const keyed = (overrides, name = 'storage.planted') => registryOf({ [name]: { ...clone(GOOD), ...overrides } });

function errorsOf(raw, refs, options) {
  // The JSON round trip drops `undefined` fields, as reading a real file would.
  const result = validateSettingsRegistry(JSON.parse(JSON.stringify(raw)), refs, options);
  assert.equal(result.ok, result.errors.length === 0);
  return result.errors;
}

test('control: the planted-registry template itself is valid', () => {
  assert.deepEqual(errorsOf(keyed({})), []);
  assert.deepEqual(errorsOf(keyed({}), { meta: REF_META, resolve: createRefs().resolve }, { consumerExists: (p) => fs.existsSync(path.join(REPO, p)) }), []);
});

// [label, registry, expected fragment in an error, the name the error must start with]
const BAD = [
  ['narrow-only url', registryOf({ 'advice.planted': { ...clone(GOOD), type: 'url', default: 'http://127.0.0.1:1', scope: 'narrow-only' } }), 'cannot be narrow-only', 'advice.planted'],
  ['narrow-only string', keyed({ type: 'string', default: null, min: undefined, scope: 'narrow-only' }), 'cannot be narrow-only', 'storage.planted'],
  ['narrowest without order', keyed({ combine: 'narrowest' }), "combine 'narrowest' requires an 'order'", 'storage.planted'],
  ['narrow-only without order', keyed({ type: 'boolean', min: undefined, default: false, scope: 'narrow-only' }), "scope 'narrow-only' requires an 'order'", 'storage.planted'],
  ['order on a string key', keyed({ type: 'string', min: undefined, default: null, order: ['a', 'b'] }), 'order is refused for a string key', 'storage.planted'],
  ['order that omits a value', keyed({ type: 'boolean', min: undefined, default: false, order: [true] }), 'order must list both false and true', 'storage.planted'],
  ['order that repeats a value', keyed({ order: [1, 1] }), 'distinct values', 'storage.planted'],
  ['ascending order on a boolean', keyed({ type: 'boolean', min: undefined, default: false, order: 'ascending' }), 'only for integer keys', 'storage.planted'],
  ['security key with env direction any', registryOf({ 'advice.planted': { ...clone(GOOD), securityRelevant: true, failSafe: 1, env: { name: 'DOFLOW_ADVICE_PLANTED', parse: 'positive-int', direction: 'any' } } }), "env.direction must be 'narrow'", 'advice.planted'],
  ['global-only key with a widening env', registryOf({ 'storage.planted': { ...clone(GOOD), scope: 'global-only', env: { name: 'DOFLOW_STORAGE_PLANTED', parse: 'positive-int', direction: 'any' } } }), "env.direction must be 'narrow'", 'storage.planted'],
  ['narrow env without an order', keyed({ env: { name: 'DOFLOW_STORAGE_PLANTED', parse: 'positive-int', direction: 'narrow' } }), "needs an 'order'", 'storage.planted'],
  ['security key without a failSafe', keyed({ securityRelevant: true }), 'needs a failSafe value or {gate}', 'storage.planted'],
  ['security key with only a state failSafe', keyed({ securityRelevant: true, failSafe: { state: 'invalid' } }), 'needs a failSafe value or {gate}', 'storage.planted'],
  ['unknown defaultRef', keyed({ default: undefined, defaultRef: 'storage.nowhere' }), "defaultRef 'storage.nowhere' is not a known default ref", 'storage.planted'],
  ['a values ref used as a defaultRef', keyed({ default: undefined, defaultRef: 'advice.providerIds' }), 'is not a known default ref', 'storage.planted'],
  ['both default and defaultRef', keyed({ defaultRef: 'storage.lifecycleEventsDefaultHours' }), "exactly one of 'default' or 'defaultRef'", 'storage.planted'],
  ['neither default nor defaultRef', keyed({ default: undefined }), "exactly one of 'default' or 'defaultRef'", 'storage.planted'],
  ['a default that fails the key rules', keyed({ default: 0 }), 'default is not valid: must be at least 1', 'storage.planted'],
  ['unknown valuesRef', keyed({ type: 'enum', min: undefined, default: 'a', valuesRef: 'advice.nowhere' }), "valuesRef 'advice.nowhere' is not a known values ref", 'storage.planted'],
  ['enum with both values and valuesRef', keyed({ type: 'enum', min: undefined, default: 'a', values: ['a'], valuesRef: 'advice.providerIds' }), "exactly one of 'values' or 'valuesRef'", 'storage.planted'],
  ['values on a non-enum', keyed({ values: ['a'] }), "'values' is only for enum keys", 'storage.planted'],
  ['min on a non-integer', keyed({ type: 'string', default: null }), "'min' is only for integer keys", 'storage.planted'],
  ['a declared flag', keyed({ flag: '--storage-planted' }), 'flag must be null in v1', 'storage.planted'],
  ['a declared flag equal to --set', keyed({ flag: '--set' }), 'flag must be null in v1', 'storage.planted'],
  ['env name off the DOFLOW_<KEY> pattern', keyed({ env: { name: 'DOFLOW_SOMETHING_ELSE', parse: 'positive-int', direction: 'any' } }), 'env.name must be DOFLOW_STORAGE_PLANTED', 'storage.planted'],
  ['env name outside DOFLOW_', keyed({ env: { name: 'SOMETHING', parse: 'positive-int', direction: 'any' } }), 'env.name must match', 'storage.planted'],
  ['positive-int parse on an enum', keyed({ type: 'enum', min: undefined, default: 'a', values: ['a', 'b'], env: { name: 'DOFLOW_STORAGE_PLANTED', parse: 'positive-int', direction: 'any' } }), 'positive-int needs an integer key', 'storage.planted'],
  ['off-words parse on an enum without off', keyed({ type: 'enum', min: undefined, default: 'a', values: ['a', 'b'], env: { name: 'DOFLOW_STORAGE_PLANTED', parse: 'off-words', direction: 'any' } }), "off-words needs an enum key with the value 'off'", 'storage.planted'],
  ['.. in legacy.path', keyed({ legacy: [{ layer: 'user', kind: 'line-onoff', path: '../outside' }] }), "legacy[0].path must be a relative path inside its root (no '..')", 'storage.planted'],
  ['an absolute legacy.path', keyed({ legacy: [{ layer: 'user', kind: 'line-onoff', path: '/etc/passwd' }] }), 'legacy[0].path', 'storage.planted'],
  ['decision-model legacy without a field', keyed({ legacy: [{ layer: 'user', kind: 'decision-model', path: 'decision-model.json' }] }), 'legacy[0].field is required', 'storage.planted'],
  ['sentinel legacy without a value', keyed({ legacy: [{ layer: 'user', kind: 'sentinel', path: 'failures/off' }] }), 'legacy[0].value is required', 'storage.planted'],
  ['unknown field on a key', keyed({ colour: 'red' }), "has unknown field 'colour'", 'storage.planted'],
  ['a missing required field', keyed({ scope: undefined }), "is missing 'scope'", 'storage.planted'],
  ['a bad key name', registryOf({ 'Storage.Planted': clone(GOOD) }), 'is not a valid key name', 'Storage.Planted'],
  ['a key with no namespace', registryOf({ planted: clone(GOOD) }), 'is not a valid key name', 'planted'],
  ['an unknown type', keyed({ type: 'float' }), 'type must be one of', 'storage.planted'],
  ['a bad shellRead', keyed({ shellRead: 'lexical-v9' }), "shellRead must be null or 'lexical-v1'", 'storage.planted'],
  ['an empty consumers list', keyed({ consumers: [] }), 'consumers must be a non-empty list', 'storage.planted'],
  ['a two-line description', keyed({ description: 'one\ntwo' }), 'description must be one non-empty line', 'storage.planted'],
  ['an invalid failSafe form', keyed({ failSafe: { gate: 'a.b', state: 'invalid' } }), 'failSafe object must be', 'storage.planted'],
  ['a failSafe value that fails the key rules', keyed({ failSafe: 'zero' }), 'failSafe is not valid', 'storage.planted'],
  ['a views list that is not project[, global]', keyed({ views: ['global'] }), 'views must be', 'storage.planted'],
  ['a requires rule without a view', keyed({ requires: [{ when: 3, key: 'storage.planted' }] }), 'requires[0] must be {when, key, view}', 'storage.planted'],
  ['a wrong registry version', { ...keyed({}), version: 2 }, 'registry version must be 1', 'registry'],
  ['an unknown top-level field', { ...keyed({}), colour: 'red' }, "registry has unknown field 'colour'", 'registry'],
  ['no keys', registryOf({}), 'keys must be a non-empty object', 'registry'],
];

for (const [label, raw, fragment, start] of BAD) {
  test(`load-time check fails: ${label}`, () => {
    // JSON round trip drops `undefined`, as a real file would.
    const errors = errorsOf(JSON.parse(JSON.stringify(raw)));
    const hit = errors.find((message) => message.includes(fragment));
    assert.ok(hit, `no error contains '${fragment}'; got:\n  ${errors.join('\n  ')}`);
    assert.ok(hit.startsWith(start), `the error must start with the key it is about (${start}): ${hit}`);
  });
}

test('cross-key checks: a duplicate env name, a gate without a plain failSafe, a gate on itself, an unknown gate or requires key', () => {
  const env = (name) => ({ name, parse: 'positive-int', direction: 'any' });
  const two = (a, b) => registryOf({ 'storage.first': { ...clone(GOOD), ...a }, 'storage.second': { ...clone(GOOD), ...b } });

  // control: distinct names pass
  assert.deepEqual(errorsOf(two({ env: env('DOFLOW_STORAGE_FIRST') }, { env: env('DOFLOW_STORAGE_SECOND') })), []);
  // the existing name kept for a key that was already bound; a second key cannot take it
  const dup = errorsOf(registryOf({
    'storage.retentionHours': { ...clone(GOOD), env: env('DOFLOW_RETENTION_HOURS') },
    'storage.second': { ...clone(GOOD), env: env('DOFLOW_RETENTION_HOURS') },
  }));
  assert.ok(dup.some((m) => m.startsWith('storage.second') && m.includes('env.name must be DOFLOW_STORAGE_SECOND')), dup.join('\n'));
  assert.ok(dup.some((m) => m.startsWith('storage.second') && m.includes('env.name DOFLOW_RETENTION_HOURS is already bound by storage.retentionHours')), dup.join('\n'));
  const sameDerived = errorsOf(registryOf({
    'storage.first': { ...clone(GOOD), env: env('DOFLOW_STORAGE_FIRST') },
    'storage.firstCopy': { ...clone(GOOD), env: env('DOFLOW_STORAGE_FIRST') },
  }));
  assert.ok(sameDerived.some((m) => m.includes('env.name must be DOFLOW_STORAGE_FIRST_COPY')), sameDerived.join('\n'));
  // a grandfathered name belongs to its own key only
  const grand = errorsOf(registryOf({
    'storage.retentionHours': { ...clone(GOOD), env: env('DOFLOW_RETENTION_HOURS') },
    'failure.capture': { ...clone(GOOD), type: 'enum', min: undefined, default: 'on', values: ['off', 'on'], order: ['off', 'on'],
      env: { name: 'DOFLOW_RETENTION_HOURS', parse: 'off-words', direction: 'narrow' } },
  }));
  assert.ok(grand.some((m) => m.startsWith('failure.capture') && m.includes('env.name must be DOFLOW_FAILURE_CAPTURE')), grand.join('\n'));
  assert.ok(grand.some((m) => m.startsWith('failure.capture') && m.includes('already bound by storage.retentionHours')), grand.join('\n'));

  const gate = (target, targetFields) => registryOf({
    'advice.planted': { ...clone(GOOD), securityRelevant: true, failSafe: { gate: target } },
    'advice.target': { ...clone(GOOD), ...targetFields },
  });
  // control: a gate on a key with a plain failSafe passes (a false value counts)
  assert.deepEqual(errorsOf(gate('advice.target', { type: 'boolean', min: undefined, default: false, failSafe: false })), []);
  const noSafe = errorsOf(gate('advice.target', {}));
  assert.ok(noSafe.some((m) => m.startsWith('advice.planted') && m.includes("failSafe gate 'advice.target' needs a plain failSafe value")), noSafe.join('\n'));
  const stateSafe = errorsOf(gate('advice.target', { failSafe: { state: 'invalid' } }));
  assert.ok(stateSafe.some((m) => m.includes('needs a plain failSafe value')), stateSafe.join('\n'));
  const self = errorsOf(gate('advice.planted', {}));
  assert.ok(self.some((m) => m.includes('names the key itself')), self.join('\n'));
  const unknown = errorsOf(gate('advice.absent', {}));
  assert.ok(unknown.some((m) => m.includes("'advice.absent' is not a registered key")), unknown.join('\n'));

  const requires = (key) => keyed({ type: 'boolean', min: undefined, default: false, order: [false, true], requires: [{ when: true, key, view: 'global' }] });
  assert.deepEqual(errorsOf(requires('storage.planted')), []);
  const missing = errorsOf(requires('storage.absent'));
  assert.ok(missing.some((m) => m.startsWith('storage.planted') && m.includes("'storage.absent', which is not a registered key")), missing.join('\n'));
});

test('a ref cycle between two keys is a load error naming the path (injected refs)', () => {
  const refs = { meta: { 'x.refA': { kind: 'default', dependsOn: ['storage.b'] }, 'x.refB': { kind: 'default', dependsOn: ['storage.a'] }, 'x.refC': { kind: 'default', dependsOn: [] } } };
  const plant = (aRef, bRef) => registryOf({
    'storage.a': { ...clone(GOOD), default: undefined, defaultRef: aRef },
    'storage.b': { ...clone(GOOD), default: undefined, defaultRef: bRef },
  });
  const raw = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(errorsOf(raw(plant('x.refA', 'x.refC')), refs), [], 'control: a -> b -> (no dependency) is acyclic');
  const cyc = errorsOf(raw(plant('x.refA', 'x.refB')), refs);
  assert.ok(cyc.some((m) => /defaultRef forms a cycle: storage\.a -> storage\.b -> storage\.a/.test(m)), cyc.join('\n'));
  const self = errorsOf(raw(registryOf({ 'storage.a': { ...clone(GOOD), default: undefined, defaultRef: 'x.refS' } })), { meta: { 'x.refS': { kind: 'default', dependsOn: ['storage.a'] } } });
  assert.ok(self.some((m) => m.includes('storage.a defaultRef forms a cycle: storage.a -> storage.a')), self.join('\n'));
  const dangling = errorsOf(raw(plant('x.refA', 'x.refC')), { meta: { ...refs.meta, 'x.refA': { kind: 'default', dependsOn: ['storage.ghost'] } } });
  assert.ok(dangling.some((m) => m.includes("depends on 'storage.ghost', which is not a registered key")), dangling.join('\n'));
});

test('refs are resolved on request: an unresolvable ref and a ref value that fails the key are load errors', () => {
  const planted = (defaultRef) => JSON.parse(JSON.stringify(keyed({ default: undefined, defaultRef })));
  const meta = { 'x.hours': { kind: 'default', dependsOn: [] } };
  assert.deepEqual(errorsOf(planted('x.hours'), { meta, resolve: () => 24 }), [], 'control: a good value');
  assert.deepEqual(errorsOf(planted('x.hours'), { meta }), [], 'control: without a resolver only the name is checked');
  const bad = errorsOf(planted('x.hours'), { meta, resolve: () => 0 });
  assert.ok(bad.some((m) => m.startsWith('storage.planted') && m.includes("defaultRef 'x.hours' resolves to an invalid value: must be at least 1")), bad.join('\n'));
  const thrown = errorsOf(planted('x.hours'), { meta, resolve: () => { throw new Error('source is gone'); } });
  assert.ok(thrown.some((m) => m.includes("defaultRef 'x.hours' does not resolve: source is gone")), thrown.join('\n'));
  const enumKey = JSON.parse(JSON.stringify(keyed({ type: 'enum', min: undefined, default: 'z', valuesRef: 'x.ids' })));
  const idsMeta = { 'x.ids': { kind: 'values', dependsOn: [] } };
  assert.deepEqual(errorsOf(enumKey, { meta: idsMeta }), [], 'unresolved list: any string default passes');
  const outside = errorsOf(enumKey, { meta: idsMeta, resolve: () => ['a', 'b'] });
  assert.ok(outside.some((m) => m.startsWith('storage.planted') && m.includes('default is not valid: must be one of: a, b')), outside.join('\n'));
  const empty = errorsOf(enumKey, { meta: idsMeta, resolve: () => [] });
  assert.ok(empty.some((m) => m.includes('did not resolve to a non-empty list of strings')), empty.join('\n'));
});

test('the consumer check names a path that does not exist, and only runs when asked', () => {
  const raw = keyed({ consumers: ['src/runtime/settings/registry.ts', 'src/runtime/settings/gone.ts'] });
  assert.deepEqual(errorsOf(raw), [], 'not asked: a path is only checked for shape');
  const asked = errorsOf(raw, undefined, { consumerExists: (p) => fs.existsSync(path.join(REPO, p)) });
  assert.deepEqual(asked.filter((m) => !m.includes('gone.ts')), []);
  assert.ok(asked.some((m) => m.startsWith('storage.planted') && m.includes("consumer 'src/runtime/settings/gone.ts' does not exist")), asked.join('\n'));
  assert.ok(errorsOf(keyed({ consumers: ['../outside.ts'] })).some((m) => m.includes('relative path inside the tree')));
});

test('env names: DOFLOW_<KEY_UPPER_SNAKE> for new bindings, the two existing names kept', () => {
  assert.equal(derivedEnvName('failure.capture'), 'DOFLOW_FAILURE_CAPTURE');
  assert.equal(derivedEnvName('storage.retentionHours'), 'DOFLOW_STORAGE_RETENTION_HOURS');
  assert.equal(derivedEnvName('advice.model'), 'DOFLOW_ADVICE_MODEL');
  const names = Object.values(SHIPPED.keys).filter((spec) => spec.env).map((spec) => spec.env.name).sort();
  assert.deepEqual(names, ['DOFLOW_FAILURE_CAPTURE', 'DOFLOW_RETENTION_HOURS']);
  // control: the same key under a renamed variable that is not one of the grandfathered pair fails
  const renamed = clone(SHIPPED);
  renamed.keys['storage.retentionHours'].env.name = 'DOFLOW_KEEP_HOURS';
  assert.ok(errorsOf(renamed).some((m) => m.startsWith('storage.retentionHours') && m.includes('env.name must be DOFLOW_STORAGE_RETENTION_HOURS')));
  // and a security-relevant or global-only key may bind env only to narrow
  const widened = clone(SHIPPED);
  widened.keys['failure.capture'].env.direction = 'any';
  assert.ok(errorsOf(widened).some((m) => m.startsWith('failure.capture') && m.includes("env.direction must be 'narrow'")));
});

test('every failSafe form of the shipped registry validates, and each form is refused when planted wrongly', () => {
  assert.deepEqual(errorsOf(clone(SHIPPED)), []);
  const forms = Object.fromEntries(Object.entries(SHIPPED.keys).filter(([, s]) => 'failSafe' in s).map(([k, s]) => [k, s.failSafe]));
  assert.deepEqual(forms, {
    'advice.enabled': false,
    'advice.provider': { gate: 'advice.enabled' },
    'advice.endpoint': { gate: 'advice.enabled' },
    'storage.prune': 'off',
    'storage.retentionHours': { state: 'invalid' },
    'failure.capture': 'off',
  });
  const wrongValue = clone(SHIPPED);
  wrongValue.keys['storage.prune'].failSafe = 'maybe';
  assert.ok(errorsOf(wrongValue).some((m) => m.startsWith('storage.prune') && m.includes('failSafe is not valid')));
  const wrongState = clone(SHIPPED);
  wrongState.keys['storage.retentionHours'].failSafe = { state: 'valid' };
  assert.ok(errorsOf(wrongState).some((m) => m.startsWith('storage.retentionHours') && m.includes('failSafe object must be')));
  const gateOnNoSafe = clone(SHIPPED);
  gateOnNoSafe.keys['advice.provider'].failSafe = { gate: 'advice.model' };
  assert.ok(errorsOf(gateOnNoSafe).some((m) => m.startsWith('advice.provider') && m.includes('needs a plain failSafe value')));
});

// ── the loader: a bad registry fails, never a default ────────────────────────────────────────────

/** A file system that serves `text` for the registry file and the real tree for everything else. */
function fsServing(text) {
  return {
    readFileSync: (file, ...rest) => (file === path.join(REPO, REGISTRY_FILE) ? text : fs.readFileSync(file, ...rest)),
    existsSync: (file) => fs.existsSync(file),
  };
}

test('loader: a registry with a broken rule fails with settings-registry-invalid and names the key', () => {
  const broken = clone(SHIPPED);
  broken.keys['advice.model'].scope = 'narrow-only';
  const loaded = loadSettingsRegistry({ fsImpl: fsServing(JSON.stringify(broken)) });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'settings-registry-invalid');
  assert.match(loaded.detail, /advice\.model a string key cannot be narrow-only/);
  assert.equal('registry' in loaded, false, 'no registry is handed back');
  // control: the unmodified text loads from the same fake
  assert.equal(loadSettingsRegistry({ fsImpl: fsServing(JSON.stringify(SHIPPED)) }).ok, true);
});

test('loader: an unreadable file and an unparseable file fail, and the failure carries an offset, never file text', () => {
  const missing = loadSettingsRegistry({ fsImpl: { readFileSync: () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); } } });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /core\/registry\/settings\.json could not be read/);

  const secret = 'SECRET-REGISTRY-TEXT';
  const unparseable = loadSettingsRegistry({ fsImpl: fsServing(`{"version": 1, ${secret}`) });
  assert.equal(unparseable.ok, false);
  assert.match(unparseable.detail, /is not valid JSON/);
  assert.equal(JSON.stringify(unparseable).includes(secret), false, 'no file text in the result');
});

test('loader: verifyRefs turns an unreadable advice.json into a load failure, the default load does not read it', () => {
  const failingAdvice = {
    readFileSync: (file, ...rest) => {
      if (file.endsWith('advice.json')) throw new Error('advice.json is gone');
      return fs.readFileSync(file, ...rest);
    },
    existsSync: (file) => fs.existsSync(file),
  };
  assert.equal(loadSettingsRegistry({ fsImpl: failingAdvice }).ok, true);
  const verified = loadSettingsRegistry({ fsImpl: failingAdvice, verifyRefs: true });
  assert.equal(verified.ok, false);
  assert.match(verified.detail, /advice\.provider valuesRef 'advice\.providerIds' does not resolve/);
});

test('loader: the registry hands back enum lists and refs lazily and keys are frozen', () => {
  const { registry } = loadSettingsRegistry({ fsImpl: fsServing(JSON.stringify(SHIPPED)) });
  assert.equal(Object.isFrozen(registry.keys.get('advice.enabled')), true);
  assert.deepEqual(registry.enumValues('failure.capture'), ['off', 'on']);
  assert.deepEqual(registry.resolveRef('advice.providerIds'), ['ollama']);
  assert.equal(registry.resolveRef('storage.lifecycleEventsDefaultHours'), 4320);
});
