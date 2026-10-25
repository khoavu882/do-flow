'use strict';

// 086 C.1 (IC-001, DD-1, DD-4, DD-5, DD-6): the shipped settings registry equals the pinned v1 entries,
// every load-time check fails on a planted bad registry (each with a control that passes without the
// planted fault), and a bad registry fails the loader instead of becoming a default. No test touches
// the real home: nothing here reads HOME or XDG_CONFIG_HOME.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir }: any = require('../helper/tmp.ts');
const { REPO, createSettingsEnv }: any = require('../helper/settings-fixtures.ts');
const { loadSettings }: any = require('../../src/runtime/settings/resolve.ts');
const { validateSettingsRegistry, loadSettingsRegistry, derivedEnvName, REGISTRY_FILE }: any = require('../../src/runtime/settings/registry.ts');
const { REF_META, createRefs }: any = require('../../src/runtime/settings/refs.ts');

const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));

// Fields shared by the seven 119 protocol keys.
const PROTOCOL_COMMON = { securityRelevant: false, env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
  consumers: ['src/runtime/review/resolve-protocol.ts'] };

// Fields shared by the three 120 primary keys (a key with an env binding overrides `env`).
const PRIMARY_COMMON = { securityRelevant: false, env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
  consumers: ['src/runtime/context/primary.ts'] };

// The seven v1 entries plus 112's project-only guard entry, 089's verify.reuse switch and 106's
// dispatch.fallback default (the
// design folder is not in the repo, so the contract is pinned here; a registry edit must change
// this table on purpose).
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
    securityRelevant: true, failSafe: { gate: 'advice.enabled' }, env: null, flag: null, shellRead: null, needsConfigHome: false,
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
  'autopilot.enabled': { type: 'enum', values: ['off', 'on'], order: ['off', 'on'], default: 'off',
    scope: 'global-only', combine: 'override', securityRelevant: true, failSafe: 'off',
    env: { name: 'DOFLOW_AUTOPILOT_ENABLED', parse: 'off-words', direction: 'narrow' },
    flag: null, shellRead: null, needsConfigHome: true,
    legacy: [{ layer: 'user', kind: 'sentinel', path: 'autopilot/off', value: 'off' }],
    consumers: ['src/runtime/settings/autopilot.ts'],
    description: 'Roadmap autopilot kill switch, off until the owner turns it on; the env and the autopilot/off sentinel can only turn it off.' },
  'guard.workerDropDatabases': { type: 'string', default: null, scope: 'project-only', combine: 'override',
    securityRelevant: true, failSafe: { state: 'invalid' }, env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
    consumers: ['src/runtime/worker/launch.ts'],
    description: 'Space-separated exact database names a worker session may DROP DATABASE; project layer only.' },
  'verify.reuse': { type: 'enum', values: ['off', 'on'], order: ['off', 'on'], default: 'off',
    scope: 'global-only', combine: 'override', securityRelevant: true, failSafe: 'off',
    env: { name: 'DOFLOW_VERIFY_REUSE', parse: 'off-words', direction: 'narrow' },
    flag: null, shellRead: null, needsConfigHome: true, legacy: [],
    consumers: ['src/runtime/verification/engine.ts'],
    description: 'Reuse of a recorded PASS at L1/L2 when the check key is unchanged, off until the owner turns it on; the env can only turn it off.' },
  // 106 IC-005: the quota fallback default; `auto` is deliberately not a value (per run only).
  'dispatch.fallback': { type: 'enum', values: ['off', 'ask'], order: ['off', 'ask'], default: 'ask',
    scope: 'narrow-only', combine: 'override', securityRelevant: false, failSafe: 'off',
    env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
    consumers: ['src/runtime/dispatch/command.ts'],
    description: 'Quota fallback ladder default for dispatch runs: ask holds and proposes, off holds without a proposal; auto exists only per run via --fallback.' },
  // The person-written billing record per headless worker id; a state failSafe is its fail-safe.
  'workers.billing': { type: 'worker-billing', default: null,
    scope: 'global-only', combine: 'override', securityRelevant: true, failSafe: { state: 'invalid' },
    env: null, flag: null, shellRead: null, needsConfigHome: true, legacy: [],
    consumers: ['src/runtime/settings/worker-billing.ts'],
    description: 'Person-written billing record per headless worker id: free or metered, with the date asserted. Lets dispatch --billing-cap free launch a worker the registry lists as unknown; global-only.' },
  // 119 IC-006: the review and debate protocol keys the resolver reads (src/runtime/review/resolve-protocol.ts).
  'review.preset': { type: 'enum', valuesRef: 'protocols.reviewPresetIds', orderRef: 'protocols.reviewPresetOrder', default: 'auto',
    scope: 'narrow-only', combine: 'override', ...PROTOCOL_COMMON,
    description: 'Review protocol preset for this project: auto follows the risk rule; a project may only pick a stricter preset.' },
  'review.rounds': { type: 'integer', min: 1, max: 3, order: 'descending', default: null,
    scope: 'narrow-only', combine: 'override', ...PROTOCOL_COMMON,
    description: "Review rounds; unset uses the preset's rounds, a project may only choose more rounds than its user layer." },
  'review.sameFamily': { type: 'enum', values: ['refuse', 'warn'], order: ['refuse', 'warn'], default: 'warn',
    scope: 'narrow-only', combine: 'override', ...PROTOCOL_COMMON,
    description: "Whether a reviewer seat from the author's model family is refused or only warned about; a project may only choose refuse." },
  'review.crossFamilyRereview': { type: 'enum', values: ['on', 'off'], order: ['on', 'off'], default: 'on',
    scope: 'narrow-only', combine: 'override', ...PROTOCOL_COMMON,
    description: 'Cross-family re-review of a changed record; a project may only keep it on.' },
  'review.extraLenses': { type: 'string-list', valuesRef: 'protocols.lensIds', maxItems: 4, maxLength: 40, default: [],
    scope: 'project-overridable', combine: 'union', ...PROTOCOL_COMMON,
    description: 'Lens ids added to every review seat; lists from all layers add up and never remove.' },
  'review.blockerClauses': { type: 'string-list', maxItems: 8, maxLength: 200, default: [],
    scope: 'project-overridable', combine: 'union', ...PROTOCOL_COMMON,
    description: 'Extra project rules a reviewer must treat as blockers; lists from all layers add up and never remove.' },
  'debate.preset': { type: 'enum', valuesRef: 'protocols.debatePresetIds', default: 'debate-2',
    scope: 'project-overridable', combine: 'override', ...PROTOCOL_COMMON,
    description: 'Debate protocol preset for this project.' },
  // 120 IC-003: primary declarations are read by context/primary.ts.
  'primary.harness': { type: 'enum', valuesRef: 'harnesses.primaryIds', default: 'unknown',
    scope: 'project-overridable', combine: 'override', ...PRIMARY_COMMON,
    env: { name: 'DOFLOW_PRIMARY_HARNESS', parse: 'verbatim', direction: 'any' },
    description: 'Which harness the main session runs, so DoFlow can tell the primary from its workers; unknown means undeclared.' },
  'primary.model': { type: 'model-id', default: null,
    scope: 'project-overridable', combine: 'override', ...PRIMARY_COMMON,
    env: { name: 'DOFLOW_PRIMARY_MODEL', parse: 'verbatim', direction: 'any' },
    description: 'Model the main session runs, as the harness names it; a declaration the hook probe checks where it can.' },
  'primary.onContradiction': { type: 'enum', values: ['refuse', 'warn'], order: ['refuse', 'warn'], default: 'warn',
    scope: 'narrow-only', combine: 'override', ...PRIMARY_COMMON,
    description: 'What happens when the probe sees a model other than the declared one: warn, or refuse; a project may only choose refuse.' },
  'workers.enabled': { type: 'worker-list', valuesRef: 'workers.ids', defaultRef: 'workers.defaultRungs',
    scope: 'narrow-only', combine: 'subset', securityRelevant: true, failSafe: { state: 'invalid' },
    env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
    consumers: ['src/runtime/worker/active.ts'],
    description: 'Ordered list of worker ids a run may use, optionally ending in primary; a project can only remove entries.' },
  'workers.models': { type: 'worker-models', valuesRef: 'workers.ids', tiersRef: 'models.tierIds', default: null,
    scope: 'global-only', combine: 'override', securityRelevant: true, failSafe: { state: 'invalid' },
    env: null, flag: null, shellRead: null, needsConfigHome: true, legacy: [],
    consumers: ['src/runtime/worker/models.ts'],
    description: 'Person-written model per worker and tier; a worker or tier not listed keeps the harness default.' },
  'models.enabled': { type: 'model-list', default: [],
    scope: 'project-overridable', combine: 'subset', direction: 'narrow-only', securityRelevant: false,
    env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
    consumers: ['src/runtime/worker/models.ts'],
    description: 'Allow-list of models permitted for task bindings and dispatch rungs.' },
  // 122 IC-011 + PN-7: the package disable list; an id not recorded on this machine is a warning (unknownMembers).
  'packages.disabled': { type: 'string-list', valuesRef: 'packages.ids', unknownMembers: 'warn', maxItems: 32, maxLength: 32, default: [],
    scope: 'project-overridable', combine: 'union', securityRelevant: false, failSafe: { state: 'invalid' },
    env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
    consumers: ['src/runtime/packages/view.ts'],
    description: 'Package ids turned off for this view; lists from all layers add up, so a project can only turn packages off.' },
  'rollout.profile': {
    type: 'enum',
    values: ['baseline', 'canary', 'staged', 'full'],
    order: ['baseline', 'canary', 'staged', 'full'],
    default: 'baseline',
    scope: 'project-overridable',
    combine: 'override',
    securityRelevant: false,
    failSafe: 'baseline',
    env: {
      name: 'DOFLOW_ROLLOUT_PROFILE',
      parse: 'verbatim',
      direction: 'any',
    },
    flag: null,
    shellRead: null,
    needsConfigHome: false,
    legacy: [],
    consumers: ['src/runtime/profiles/resolve.ts'],
    description: 'Active rollout profile governing retrieval, decision advisor, code graph, and verification automation.',
  },
  'team.writerCap': {
    type: 'integer',
    min: 1,
    max: 8,
    order: 'ascending',
    default: 2,
    scope: 'project-overridable',
    combine: 'override',
    securityRelevant: false,
    failSafe: 2,
    env: {
      name: 'DOFLOW_TEAM_WRITER_CAP',
      parse: 'positive-int',
      direction: 'any',
    },
    flag: null,
    shellRead: null,
    needsConfigHome: false,
    legacy: [],
    consumers: ['src/runtime/team/admission.ts'],
    description: 'Maximum number of concurrent mutating worker sessions permitted across the active task graph.',
  },
  'team.maxAttempts': {
    type: 'integer',
    min: 1,
    max: 10,
    order: 'ascending',
    default: 3,
    scope: 'project-overridable',
    combine: 'override',
    securityRelevant: false,
    failSafe: 3,
    env: {
      name: 'DOFLOW_TEAM_MAX_ATTEMPTS',
      parse: 'positive-int',
      direction: 'any',
    },
    flag: null,
    shellRead: null,
    needsConfigHome: false,
    legacy: [],
    consumers: ['src/runtime/team/admission.ts'],
    description: 'Maximum attempt count permitted for any single plan task before escalating to operator intervention.',
  },
};

const clone = (value: any) => JSON.parse(JSON.stringify(value));

test('project-only refuses every environment binding, including a narrowing binding', () => {
  for (const direction of ['any', 'narrow']) {
    const raw = clone(SHIPPED);
    // An otherwise valid integer binding isolates the scope check from string parse rules.
    Object.assign(raw.keys['storage.retentionHours'], { scope: 'project-only', order: 'ascending',
      env: { name: 'DOFLOW_RETENTION_HOURS', parse: 'positive-int', direction } });
    const rejected = validateSettingsRegistry(raw);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((e: any) => e.includes('storage.retentionHours') && e.includes('project-only') && e.includes('env must be null')), rejected.errors.join('\n'));
    raw.keys['storage.retentionHours'].env = null;
    assert.equal(validateSettingsRegistry(raw).ok, true, 'the same project-only key with no env binding is valid');
  }
});

test("N-3: failSafe {state: 'invalid'} cannot be combined with requires or needsConfigHome (they would resolve to the failSafe object as the value)", () => {
  const guard = 'guard.workerDropDatabases';
  assert.equal(validateSettingsRegistry(clone(SHIPPED)).ok, true, 'the shipped project-only security key is valid');
  for (const extra of [
    { requires: [{ when: 'on', key: 'storage.retentionHours', view: 'project' }] },
    { needsConfigHome: true },
  ]) {
    const raw = clone(SHIPPED);
    Object.assign(raw.keys[guard], extra);
    const rejected = validateSettingsRegistry(raw);
    assert.equal(rejected.ok, false, JSON.stringify(extra));
    assert.ok(rejected.errors.some((e: any) => e.includes(guard) && e.includes("failSafe {state: 'invalid'}") && e.includes('requires')), rejected.errors.join('\n'));
  }
  const empty = clone(SHIPPED);
  empty.keys[guard].requires = [];
  assert.equal(validateSettingsRegistry(empty).ok, true, 'an empty requires list resolves nothing');
});

test('project-only ignores user/global values and env; project and local files alone decide', (t) => {
  const w = createSettingsEnv(t);
  const key = 'guard.workerDropDatabases';
  const get = () => loadSettings({ projectRoot: w.project,
    env: w.env({ DOFLOW_GUARD_DROP_DATABASES: 'env_db', DOFLOW_GUARD_WORKER_DROP_DATABASES: 'env_db' }) });
  w.writeUserSettings({ [key]: 'global_db' });
  let view = get();
  for (const name of ['project', 'global']) {
    const r = view.get(key, name);
    assert.equal(r.value, null);
    assert.equal(r.origin.layer, 'default');
    assert.equal(r.candidates.find((c: any) => c.layer === 'user').status, 'ignored-scope');
    assert.match(r.candidates.find((c: any) => c.layer === 'user').reason, /project-only/);
    assert.equal(r.candidates.some((c: any) => c.layer === 'env'), false);
  }
  w.writeProjectSettings({ [key]: 'project_db' });
  view = get();
  assert.equal(view.get(key).value, 'project_db');
  assert.equal(view.get(key).origin.layer, 'project');
  assert.equal(view.get(key, 'global').value, null);
  w.writeProjectLocal({ [key]: 'local_db' });
  assert.equal(get().get(key).value, 'local_db');
  assert.equal(get().get(key).origin.layer, 'local');
  w.writeUserSettings({ [key]: 42 });
  assert.equal(get().get(key).candidates.find((c: any) => c.layer === 'user').status, 'ignored-scope', 'scope precedes type validation, mirroring global-only');
});

// ── the shipped registry ───────────────────────────────────────────────────────────────────────

test("the shipped registry pins base keys plus primary, worker and package settings in display order", () => {
  assert.equal(SHIPPED.version, 1);
  assert.deepEqual(Object.keys(SHIPPED.keys), Object.keys(V1));
  assert.deepEqual(SHIPPED.keys, V1);
  assert.equal(Object.keys(SHIPPED.keys).length, 29);
});

test('prompt-nudge is not registered (D-2) and no key outside the pinned entries exists', () => {
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
  // C-9: review.preset's values and order are derived from protocols.json and equal what was hand-kept before.
  assert.deepEqual(loaded.registry.enumValues('review.preset'), ['auto', 'review-deep', 'review-single']);
  assert.deepEqual(loaded.registry.keys.get('review.preset').order, ['review-deep', 'auto', 'review-single']);
  assert.deepEqual(loadSettingsRegistry().registry.keys.get('review.preset').order, ['review-deep', 'auto', 'review-single'], 'the default load derives it too');
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
  assert.equal(refs.resolve('advice.providerDefaultEndpoint', { 'advice.provider': 'ollama' }), advice.providers.find((p: any) => p.id === 'ollama').defaultEndpoint);
  assert.equal(refs.resolve('storage.lifecycleEventsDefaultHours'), storage.stores.find((s: any) => s.id === 'lifecycle-events').bound.defaultHours);
  assert.equal(refs.resolve('storage.lifecycleEventsDefaultHours'), 4320);
  assert.deepEqual(refs.resolve('advice.providerIds'), advice.providers.map((p: any) => p.id));
  const harnesses = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/harnesses.json'), 'utf8'));
  assert.deepEqual(refs.resolve('harnesses.primaryIds'), ['unknown', ...harnesses.harnesses.map((h: any) => h.id)]);
  assert.deepEqual(refs.resolve('workers.ids'), harnesses.harnesses.filter((h: any) => h.worker).map((h: any) => h.id));
  assert.deepEqual(refs.resolve('workers.defaultRungs'), [...harnesses.harnesses.filter((h: any) => h.worker).map((h: any) => h.id), 'primary']);
  const models = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/models.json'), 'utf8'));
  assert.deepEqual(refs.resolve('models.tierIds'), models.dispatchTiers.tiers);
  assert.deepEqual(Object.keys(REF_META).sort(), ['advice.providerDefaultEndpoint', 'advice.providerIds', 'harnesses.primaryIds', 'models.tierIds', 'packages.ids', 'protocols.debatePresetIds', 'protocols.lensIds', 'protocols.reviewPresetIds', 'protocols.reviewPresetOrder', 'storage.lifecycleEventsDefaultHours', 'workers.defaultRungs', 'workers.ids']);
});

test('refs: an unknown name (including an inherited property name) and an unreadable source throw without file text', () => {
  const refs = createRefs();
  assert.throws(() => refs.resolve('nope'), /unknown settings ref 'nope'/);
  assert.throws(() => refs.resolve('constructor'), /unknown settings ref/);
  assert.throws(() => refs.resolve('__proto__'), /unknown settings ref/);
  const secret = 'SECRET-JSON-TEXT';
  const broken = createRefs({ fsImpl: { readFileSync: () => `{ ${secret}` } });
  assert.throws(() => broken.resolve('advice.providerIds'), (error: any) => /advice\.json could not be read as JSON/.test(error.message) && !error.message.includes(secret));
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
const registryOf = (keys: any) => ({ version: 1, description: 'planted', keys });
const keyed = (overrides: any, name = 'storage.planted') => registryOf({ [name]: { ...clone(GOOD), ...overrides } });

function errorsOf(raw: any, refs?: any, options?: any) {
  // The JSON round trip drops `undefined` fields, as reading a real file would.
  const result = validateSettingsRegistry(JSON.parse(JSON.stringify(raw)), refs, options);
  assert.equal(result.ok, result.errors.length === 0);
  return result.errors;
}

test('control: the planted-registry template itself is valid', () => {
  assert.deepEqual(errorsOf(keyed({})), []);
  assert.deepEqual(errorsOf(keyed({}), { meta: REF_META, resolve: createRefs().resolve }, { consumerExists: (p: any) => fs.existsSync(path.join(REPO, p)) }), []);
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
  ['orderRef on an integer key', keyed({ orderRef: 'protocols.reviewPresetOrder' }), "'orderRef' is only for enum keys with a 'valuesRef'", 'storage.planted'],
  ['orderRef on an enum with literal values', keyed({ type: 'enum', min: undefined, default: 'a', values: ['a'], orderRef: 'protocols.reviewPresetOrder' }), "'orderRef' is only for enum keys with a 'valuesRef'", 'storage.planted'],
  ['both order and orderRef', keyed({ type: 'enum', min: undefined, default: 'auto', valuesRef: 'protocols.reviewPresetIds', order: ['auto'], orderRef: 'protocols.reviewPresetOrder' }), "at most one of 'order' or 'orderRef'", 'storage.planted'],
  ['unknown orderRef', keyed({ type: 'enum', min: undefined, default: 'auto', valuesRef: 'protocols.reviewPresetIds', orderRef: 'protocols.nowhere' }), "orderRef 'protocols.nowhere' is not a known order ref", 'storage.planted'],
  ['a values ref used as an orderRef', keyed({ type: 'enum', min: undefined, default: 'auto', valuesRef: 'protocols.reviewPresetIds', orderRef: 'protocols.reviewPresetIds' }), 'is not a known order ref', 'storage.planted'],
  ['an order ref used as a valuesRef', keyed({ type: 'enum', min: undefined, default: 'auto', valuesRef: 'protocols.reviewPresetOrder' }), 'is not a known values ref', 'storage.planted'],
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
  ['unknownMembers on a key with no valuesRef', keyed({ type: 'string-list', min: undefined, default: [], maxItems: 2, maxLength: 5, combine: 'union', unknownMembers: 'warn' }), "'unknownMembers' is only for string-list keys with a 'valuesRef'", 'storage.planted'],
  ['unknownMembers other than warn', keyed({ type: 'string-list', min: undefined, default: [], maxItems: 2, maxLength: 5, combine: 'union', valuesRef: 'protocols.lensIds', unknownMembers: 'ignore' }), "unknownMembers must be 'warn'", 'storage.planted'],
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
    const hit = errors.find((message: any) => message.includes(fragment));
    assert.ok(hit, `no error contains '${fragment}'; got:\n  ${errors.join('\n  ')}`);
    assert.ok(hit.startsWith(start), `the error must start with the key it is about (${start}): ${hit}`);
  });
}

test('C-9: a resolved orderRef must rank every allowed value exactly once, and one that does not resolve is named', () => {
  const derived = keyed({ type: 'enum', min: undefined, default: 'auto', valuesRef: 'protocols.reviewPresetIds', orderRef: 'protocols.reviewPresetOrder', scope: 'narrow-only' });
  const refsWith = (order: any) => ({ meta: REF_META, resolve: (name: any) => (name === 'protocols.reviewPresetIds' ? ['auto', 'a', 'b'] : order()) });
  assert.deepEqual(errorsOf(derived, refsWith(() => ['a', 'auto', 'b'])), [], 'control: a permutation of the values');
  assert.match(errorsOf(derived, refsWith(() => ['a', 'auto'])).join('\n'), /^storage\.planted orderRef 'protocols\.reviewPresetOrder' must resolve to every allowed value exactly once/m);
  assert.match(errorsOf(derived, refsWith(() => ['a', 'a', 'auto', 'b'])).join('\n'), /must resolve to every allowed value exactly once/);
  assert.match(errorsOf(derived, refsWith(() => { throw new Error('no deep preset'); })).join('\n'), /orderRef 'protocols\.reviewPresetOrder' does not resolve: no deep preset/);
  assert.deepEqual(errorsOf(derived), [], 'without ref resolution an orderRef satisfies narrow-only');
});

test('cross-key checks: a duplicate env name, a gate without a plain failSafe, a gate on itself, an unknown gate or requires key', () => {
  const env = (name: any) => ({ name, parse: 'positive-int', direction: 'any' });
  const two = (a: any, b: any) => registryOf({ 'storage.first': { ...clone(GOOD), ...a }, 'storage.second': { ...clone(GOOD), ...b } });

  // control: distinct names pass
  assert.deepEqual(errorsOf(two({ env: env('DOFLOW_STORAGE_FIRST') }, { env: env('DOFLOW_STORAGE_SECOND') })), []);
  // the existing name kept for a key that was already bound; a second key cannot take it
  const dup = errorsOf(registryOf({
    'storage.retentionHours': { ...clone(GOOD), env: env('DOFLOW_RETENTION_HOURS') },
    'storage.second': { ...clone(GOOD), env: env('DOFLOW_RETENTION_HOURS') },
  }));
  assert.ok(dup.some((m: any) => m.startsWith('storage.second') && m.includes('env.name must be DOFLOW_STORAGE_SECOND')), dup.join('\n'));
  assert.ok(dup.some((m: any) => m.startsWith('storage.second') && m.includes('env.name DOFLOW_RETENTION_HOURS is already bound by storage.retentionHours')), dup.join('\n'));
  const sameDerived = errorsOf(registryOf({
    'storage.first': { ...clone(GOOD), env: env('DOFLOW_STORAGE_FIRST') },
    'storage.firstCopy': { ...clone(GOOD), env: env('DOFLOW_STORAGE_FIRST') },
  }));
  assert.ok(sameDerived.some((m: any) => m.includes('env.name must be DOFLOW_STORAGE_FIRST_COPY')), sameDerived.join('\n'));
  // a grandfathered name belongs to its own key only
  const grand = errorsOf(registryOf({
    'storage.retentionHours': { ...clone(GOOD), env: env('DOFLOW_RETENTION_HOURS') },
    'failure.capture': { ...clone(GOOD), type: 'enum', min: undefined, default: 'on', values: ['off', 'on'], order: ['off', 'on'],
      env: { name: 'DOFLOW_RETENTION_HOURS', parse: 'off-words', direction: 'narrow' } },
  }));
  assert.ok(grand.some((m: any) => m.startsWith('failure.capture') && m.includes('env.name must be DOFLOW_FAILURE_CAPTURE')), grand.join('\n'));
  assert.ok(grand.some((m: any) => m.startsWith('failure.capture') && m.includes('already bound by storage.retentionHours')), grand.join('\n'));

  const gate = (target: any, targetFields: any) => registryOf({
    'advice.planted': { ...clone(GOOD), securityRelevant: true, failSafe: { gate: target } },
    'advice.target': { ...clone(GOOD), ...targetFields },
  });
  // control: a gate on a key with a plain failSafe passes (a false value counts)
  assert.deepEqual(errorsOf(gate('advice.target', { type: 'boolean', min: undefined, default: false, failSafe: false })), []);
  const noSafe = errorsOf(gate('advice.target', {}));
  assert.ok(noSafe.some((m: any) => m.startsWith('advice.planted') && m.includes("failSafe gate 'advice.target' needs a plain failSafe value")), noSafe.join('\n'));
  const stateSafe = errorsOf(gate('advice.target', { failSafe: { state: 'invalid' } }));
  assert.ok(stateSafe.some((m: any) => m.includes('needs a plain failSafe value')), stateSafe.join('\n'));
  const self = errorsOf(gate('advice.planted', {}));
  assert.ok(self.some((m: any) => m.includes('names the key itself')), self.join('\n'));
  const unknown = errorsOf(gate('advice.absent', {}));
  assert.ok(unknown.some((m: any) => m.includes("'advice.absent' is not a registered key")), unknown.join('\n'));

  const requires = (key: any) => keyed({ type: 'boolean', min: undefined, default: false, order: [false, true], requires: [{ when: true, key, view: 'global' }] });
  assert.deepEqual(errorsOf(requires('storage.planted')), []);
  const missing = errorsOf(requires('storage.absent'));
  assert.ok(missing.some((m: any) => m.startsWith('storage.planted') && m.includes("'storage.absent', which is not a registered key")), missing.join('\n'));
});

test('a ref cycle between two keys is a load error naming the path (injected refs)', () => {
  const refs = { meta: { 'x.refA': { kind: 'default', dependsOn: ['storage.b'] }, 'x.refB': { kind: 'default', dependsOn: ['storage.a'] }, 'x.refC': { kind: 'default', dependsOn: [] } } };
  const plant = (aRef: any, bRef: any) => registryOf({
    'storage.a': { ...clone(GOOD), default: undefined, defaultRef: aRef },
    'storage.b': { ...clone(GOOD), default: undefined, defaultRef: bRef },
  });
  const raw = (value: any) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(errorsOf(raw(plant('x.refA', 'x.refC')), refs), [], 'control: a -> b -> (no dependency) is acyclic');
  const cyc = errorsOf(raw(plant('x.refA', 'x.refB')), refs);
  assert.ok(cyc.some((m: any) => /defaultRef forms a cycle: storage\.a -> storage\.b -> storage\.a/.test(m)), cyc.join('\n'));
  const self = errorsOf(raw(registryOf({ 'storage.a': { ...clone(GOOD), default: undefined, defaultRef: 'x.refS' } })), { meta: { 'x.refS': { kind: 'default', dependsOn: ['storage.a'] } } });
  assert.ok(self.some((m: any) => m.includes('storage.a defaultRef forms a cycle: storage.a -> storage.a')), self.join('\n'));
  const dangling = errorsOf(raw(plant('x.refA', 'x.refC')), { meta: { ...refs.meta, 'x.refA': { kind: 'default', dependsOn: ['storage.ghost'] } } });
  assert.ok(dangling.some((m: any) => m.includes("depends on 'storage.ghost', which is not a registered key")), dangling.join('\n'));
});

test('refs are resolved on request: an unresolvable ref and a ref value that fails the key are load errors', () => {
  const planted = (defaultRef: any) => JSON.parse(JSON.stringify(keyed({ default: undefined, defaultRef })));
  const meta = { 'x.hours': { kind: 'default', dependsOn: [] } };
  assert.deepEqual(errorsOf(planted('x.hours'), { meta, resolve: () => 24 }), [], 'control: a good value');
  assert.deepEqual(errorsOf(planted('x.hours'), { meta }), [], 'control: without a resolver only the name is checked');
  const bad = errorsOf(planted('x.hours'), { meta, resolve: () => 0 });
  assert.ok(bad.some((m: any) => m.startsWith('storage.planted') && m.includes("defaultRef 'x.hours' resolves to an invalid value: must be at least 1")), bad.join('\n'));
  const thrown = errorsOf(planted('x.hours'), { meta, resolve: () => { throw new Error('source is gone'); } });
  assert.ok(thrown.some((m: any) => m.includes("defaultRef 'x.hours' does not resolve: source is gone")), thrown.join('\n'));
  const enumKey = JSON.parse(JSON.stringify(keyed({ type: 'enum', min: undefined, default: 'z', valuesRef: 'x.ids' })));
  const idsMeta = { 'x.ids': { kind: 'values', dependsOn: [] } };
  assert.deepEqual(errorsOf(enumKey, { meta: idsMeta }), [], 'unresolved list: any string default passes');
  const outside = errorsOf(enumKey, { meta: idsMeta, resolve: () => ['a', 'b'] });
  assert.ok(outside.some((m: any) => m.startsWith('storage.planted') && m.includes('default is not valid: must be one of: a, b')), outside.join('\n'));
  const empty = errorsOf(enumKey, { meta: idsMeta, resolve: () => [] });
  assert.ok(empty.some((m: any) => m.includes('did not resolve to a non-empty list of strings')), empty.join('\n'));
});

test('the consumer check names a path that does not exist, and only runs when asked', () => {
  const raw = keyed({ consumers: ['src/runtime/settings/registry.ts', 'src/runtime/settings/gone.ts'] });
  assert.deepEqual(errorsOf(raw), [], 'not asked: a path is only checked for shape');
  const asked = errorsOf(raw, undefined, { consumerExists: (p: any) => fs.existsSync(path.join(REPO, p)) });
  assert.deepEqual(asked.filter((m: any) => !m.includes('gone.ts')), []);
  assert.ok(asked.some((m: any) => m.startsWith('storage.planted') && m.includes("consumer 'src/runtime/settings/gone.ts' does not exist")), asked.join('\n'));
  assert.ok(errorsOf(keyed({ consumers: ['../outside.ts'] })).some((m: any) => m.includes('relative path inside the tree')));
});

test('env names: DOFLOW_<KEY_UPPER_SNAKE> for new bindings, the two existing names kept', () => {
  assert.equal(derivedEnvName('failure.capture'), 'DOFLOW_FAILURE_CAPTURE');
  assert.equal(derivedEnvName('storage.retentionHours'), 'DOFLOW_STORAGE_RETENTION_HOURS');
  assert.equal(derivedEnvName('advice.model'), 'DOFLOW_ADVICE_MODEL');
  const names = Object.values(SHIPPED.keys).filter((spec: any) => spec.env).map((spec: any) => spec.env.name).sort();
  assert.deepEqual(names, [
    'DOFLOW_AUTOPILOT_ENABLED',
    'DOFLOW_FAILURE_CAPTURE',
    'DOFLOW_PRIMARY_HARNESS',
    'DOFLOW_PRIMARY_MODEL',
    'DOFLOW_RETENTION_HOURS',
    'DOFLOW_ROLLOUT_PROFILE',
    'DOFLOW_TEAM_MAX_ATTEMPTS',
    'DOFLOW_TEAM_WRITER_CAP',
    'DOFLOW_VERIFY_REUSE',
  ]);
  assert.equal(derivedEnvName('verify.reuse'), 'DOFLOW_VERIFY_REUSE', '089: the new binding takes the derived name');
  // control: the same key under a renamed variable that is not one of the grandfathered pair fails
  const renamed = clone(SHIPPED);
  renamed.keys['storage.retentionHours'].env.name = 'DOFLOW_KEEP_HOURS';
  assert.ok(errorsOf(renamed).some((m: any) => m.startsWith('storage.retentionHours') && m.includes('env.name must be DOFLOW_STORAGE_RETENTION_HOURS')));
  // and a security-relevant or global-only key may bind env only to narrow
  const widened = clone(SHIPPED);
  widened.keys['failure.capture'].env.direction = 'any';
  assert.ok(errorsOf(widened).some((m: any) => m.startsWith('failure.capture') && m.includes("env.direction must be 'narrow'")));
});

test('a project-only security key may carry the {state: invalid} fail-safe; any other scope may not', () => {
  const projectOnly = keyed({ scope: 'project-only', securityRelevant: true, failSafe: { state: 'invalid' } });
  assert.deepEqual(errorsOf(projectOnly), []);
  const widening = keyed({ scope: 'project-overridable', securityRelevant: true, failSafe: { state: 'invalid' } });
  assert.ok(errorsOf(widening).some((m: any) => m.startsWith('storage.planted') && m.includes('needs a failSafe value or {gate}')));
});

test('every failSafe form of the shipped registry validates, and each form is refused when planted wrongly', () => {
  assert.deepEqual(errorsOf(clone(SHIPPED)), []);
  const forms = Object.fromEntries(Object.entries(SHIPPED.keys).filter(([, s]: any) => 'failSafe' in s).map(([k, s]: any) => [k, s.failSafe]));
  assert.deepEqual(forms, {
    'advice.enabled': false,
    'advice.provider': { gate: 'advice.enabled' },
    'advice.endpoint': { gate: 'advice.enabled' },
    'advice.model': { gate: 'advice.enabled' },
    'storage.prune': 'off',
    'storage.retentionHours': { state: 'invalid' },
    'failure.capture': 'off',
    'autopilot.enabled': 'off',
    'guard.workerDropDatabases': { state: 'invalid' },
    'verify.reuse': 'off',
    'dispatch.fallback': 'off',
    'workers.billing': { state: 'invalid' },
    'workers.enabled': { state: 'invalid' },
    'workers.models': { state: 'invalid' },
    'packages.disabled': { state: 'invalid' },
    'rollout.profile': 'baseline',
    'team.writerCap': 2,
    'team.maxAttempts': 3,
  });
  const wrongValue = clone(SHIPPED);
  wrongValue.keys['storage.prune'].failSafe = 'maybe';
  assert.ok(errorsOf(wrongValue).some((m: any) => m.startsWith('storage.prune') && m.includes('failSafe is not valid')));
  const wrongState = clone(SHIPPED);
  wrongState.keys['storage.retentionHours'].failSafe = { state: 'valid' };
  assert.ok(errorsOf(wrongState).some((m: any) => m.startsWith('storage.retentionHours') && m.includes('failSafe object must be')));
  const gateOnNoSafe = clone(SHIPPED);
  gateOnNoSafe.keys['advice.provider'].failSafe = { gate: 'advice.model' };
  assert.ok(errorsOf(gateOnNoSafe).some((m: any) => m.startsWith('advice.provider') && m.includes('needs a plain failSafe value')));
});

// ── the loader: a bad registry fails, never a default ────────────────────────────────────────────

/** A file system that serves `text` for the registry file and the real tree for everything else. */
function fsServing(text: any) {
  return {
    readFileSync: (file: any, ...rest: any[]) => (file === path.join(REPO, REGISTRY_FILE) ? text : fs.readFileSync(file, ...rest)),
    existsSync: (file: any) => fs.existsSync(file),
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
    readFileSync: (file: any, ...rest: any[]) => {
      if (file.endsWith('advice.json')) throw new Error('advice.json is gone');
      return fs.readFileSync(file, ...rest);
    },
    existsSync: (file: any) => fs.existsSync(file),
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

test('loader rejects lexical-v1 on any key except failure.capture', (t) => {
  const fixture = (raw: any) => {
    const root = tempDir(t, 'doflow-settings-shellread-');
    const file = path.join(root, REGISTRY_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    return root;
  };
  const bad = structuredClone(SHIPPED);
  bad.keys['advice.enabled'].shellRead = 'lexical-v1';
  const rejected = loadSettingsRegistry({ repoRoot: fixture(bad) });
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /advice\.enabled shellRead 'lexical-v1' is only allowed for 'failure\.capture'/);

  const control = structuredClone(SHIPPED);
  control.keys['advice.enabled'].shellRead = null;
  const accepted = loadSettingsRegistry({ repoRoot: fixture(control) });
  assert.equal(accepted.ok, true, accepted.detail);
});
