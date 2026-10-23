'use strict';

// The person-written billing record `workers.billing`: registry type rules, value rules, the global-only
// reader (readWorkerBilling) and the effective-billing table (effectiveBilling). The dispatch side is
// in dispatch-billing-cap.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures');
const { loadRegistry } = require('../../src/registry/index.ts');
const { validateSettingsRegistry, REGISTRY_FILE } = require('../../src/runtime/settings/registry.ts');
const { validateValue } = require('../../src/runtime/settings/files.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { readWorkerBilling, effectiveBilling } = require('../../src/runtime/settings/worker-billing.ts');

const KEY = 'workers.billing';
const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));
const SPEC = SHIPPED.keys[KEY];
const WORKER_IDS = loadRegistry({ repoRoot: REPO }).harnesses.map((h) => h.id);
const CLAUDE_FREE = { claude: { billing: 'free', asserted: '2026-10-23' } };

const clone = (value) => JSON.parse(JSON.stringify(value));
const plant = (overrides) => ({ version: 1, description: 'planted', keys: { [KEY]: { ...clone(SPEC), ...overrides } } });
const errorsOf = (raw) => validateSettingsRegistry(JSON.parse(JSON.stringify(raw))).errors;

// ── registry type rules ──────────────────────────────────────────────────────────────────────────

test('the shipped workers.billing spec is the decided one and is valid', () => {
  assert.deepEqual(errorsOf(plant({})), [], 'control: the shipped spec alone is a valid registry');
  assert.equal(SPEC.type, 'worker-billing');
  assert.equal(SPEC.default, null);
  assert.equal(SPEC.scope, 'global-only');
  assert.equal(SPEC.combine, 'override');
  assert.equal(SPEC.securityRelevant, true);
  assert.deepEqual(SPEC.failSafe, { state: 'invalid' });
  assert.equal(SPEC.env, null);
  assert.equal(SPEC.flag, null);
});

for (const [label, overrides, fragment] of [
  ['a non-null default', { default: { claude: { billing: 'free', asserted: '2026-10-23' } } }, 'must default to null'],
  ['a defaultRef instead of the null default', { default: undefined, defaultRef: 'storage.lifecycleEventsDefaultHours' }, 'must default to null'],
  ['an order', { order: ['free', 'metered'] }, 'order is refused for a worker-billing key'],
  ['narrow-only scope', { scope: 'narrow-only' }, 'cannot be narrow-only'],
  ['combine narrowest', { combine: 'narrowest', order: undefined }, "must combine by 'override'"],
  ['no failSafe', { failSafe: undefined }, "needs failSafe {state: 'invalid'}"],
  ['a gate failSafe', { failSafe: { gate: 'advice.enabled' } }, "needs failSafe {state: 'invalid'}"],
  ['a plain failSafe value', { failSafe: 'off' }, "needs failSafe {state: 'invalid'}"],
]) {
  test(`registry refuses a worker-billing key with ${label}, naming the key`, () => {
    const errors = errorsOf(plant(overrides));
    const hit = errors.find((message) => message.includes(fragment));
    assert.ok(hit, `no error contains '${fragment}'; got:\n  ${errors.join('\n  ')}`);
    assert.ok(hit.startsWith(KEY), hit);
  });
}

test("a state failSafe satisfies securityRelevant for worker-billing only: an integer key keeps today's rule", () => {
  const integer = { type: 'integer', min: 1, default: 5, scope: 'project-overridable', combine: 'override', securityRelevant: true,
    failSafe: { state: 'invalid' }, env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
    consumers: ['src/runtime/settings/registry.ts'], description: 'A planted integer key.' };
  const errors = errorsOf({ version: 1, description: 'planted', keys: { 'storage.planted': integer } });
  assert.ok(errors.some((m) => m.startsWith('storage.planted') && m.includes('needs a failSafe value or {gate}')), errors.join('\n'));
});

// ── value rules ──────────────────────────────────────────────────────────────────────────────────

test('validateValue accepts a record of one to sixteen well-formed entries', () => {
  assert.equal(validateValue(SPEC, CLAUDE_FREE), null);
  assert.equal(validateValue(SPEC, { claude: { billing: 'metered', asserted: '2024-02-29', basis: 'pay per token' } }), null);
  assert.equal(validateValue(SPEC, { 'gemini-cli': { billing: 'free', asserted: '2999-01-01' } }), null, 'a future date is stated, not judged');
  const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`w${i}`, { billing: 'free', asserted: '2026-10-23' }]));
  assert.equal(validateValue(SPEC, sixteen), null);
});

for (const [label, value, code, fragment] of [
  ['a non-object', 'free', 'type', 'must be an object'],
  ['an array', [], 'type', 'must be an object'],
  ['null', null, 'type', 'must be an object'],
  ['an empty record', {}, 'range', '1 to 16'],
  ['seventeen entries', Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`w${i}`, { billing: 'free', asserted: '2026-10-23' }])), 'range', '1 to 16'],
  ['an entry key that is not a worker id', { Claude: { billing: 'free', asserted: '2026-10-23' } }, 'type', 'not a worker id'],
  ['an entry that is not an object', { claude: 'free' }, 'type', "entry 'claude' must be an object"],
  ['billing subscription', { claude: { billing: 'subscription', asserted: '2026-10-23' } }, 'enum', "entry 'claude' field 'billing'"],
  ['billing unknown', { claude: { billing: 'unknown', asserted: '2026-10-23' } }, 'enum', "field 'billing'"],
  ['billing not a string', { claude: { billing: true, asserted: '2026-10-23' } }, 'type', "field 'billing'"],
  ['a missing billing', { claude: { asserted: '2026-10-23' } }, 'type', "field 'billing'"],
  ['a missing asserted', { claude: { billing: 'free' } }, 'range', "entry 'claude' field 'asserted'"],
  ['an impossible date', { claude: { billing: 'free', asserted: '2026-02-30' } }, 'range', "field 'asserted'"],
  ['a date with a time', { claude: { billing: 'free', asserted: '2026-10-23T00:00:00Z' } }, 'range', "field 'asserted'"],
  ['an extra field', { claude: { billing: 'free', asserted: '2026-10-23', note: 'x' } }, 'type', 'a field other than'],
  ['an empty basis', { claude: { billing: 'free', asserted: '2026-10-23', basis: '' } }, 'range', "field 'basis'"],
  ['a two-line basis', { claude: { billing: 'free', asserted: '2026-10-23', basis: 'a\nb' } }, 'range', "field 'basis'"],
  ['a 121 character basis', { claude: { billing: 'free', asserted: '2026-10-23', basis: 'x'.repeat(121) } }, 'range', "field 'basis'"],
  ['a basis that is not a string', { claude: { billing: 'free', asserted: '2026-10-23', basis: 3 } }, 'type', "field 'basis'"],
]) {
  test(`validateValue refuses ${label} without echoing the value`, () => {
    const fault = validateValue(SPEC, value);
    assert.ok(fault, 'a fault');
    assert.equal(fault.code, code);
    assert.ok(fault.reason.includes(fragment), fault.reason);
    assert.equal(fault.reason.includes('subscription'), false, 'a rejected value is never echoed');
  });
}

// ── the reader ───────────────────────────────────────────────────────────────────────────────────

test('absent: no settings file, no config home, or no key', (t) => {
  const f = createSettingsEnv(t);
  assert.equal(readWorkerBilling(f.env(), { workerIds: WORKER_IDS }).state, 'absent');
  f.writeUserSettings({ schema: 1, 'autopilot.enabled': 'off' });
  assert.deepEqual(readWorkerBilling(f.env(), { workerIds: WORKER_IDS }), { state: 'absent', reason: null, workers: {} });
  const noHome = readWorkerBilling({ PATH: process.env.PATH }, { workerIds: WORKER_IDS });
  assert.equal(noHome.state, 'absent');
});

test('set: the user file decides and the read is fresh each call', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, [KEY]: { ...CLAUDE_FREE, claude: { ...CLAUDE_FREE.claude, basis: 'flat plan' } } });
  const first = readWorkerBilling(f.env(), { workerIds: WORKER_IDS });
  assert.deepEqual(first, { state: 'set', reason: null, workers: { claude: { billing: 'free', asserted: '2026-10-23', basis: 'flat plan' } } });
  f.writeUserSettings({ schema: 1, [KEY]: { claude: { billing: 'metered', asserted: '2026-10-24' } } });
  assert.equal(readWorkerBilling(f.env(), { workerIds: WORKER_IDS }).workers.claude.billing, 'metered', 'a changed file reads fresh');
});

test('a project or local settings file never supplies the record', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, [KEY]: CLAUDE_FREE });
  f.writeProjectLocal({ schema: 1, [KEY]: CLAUDE_FREE });
  assert.equal(readWorkerBilling(f.env(), { workerIds: WORKER_IDS }).state, 'absent');
  const project = loadSettings({ projectRoot: f.project, env: f.env() }).get(KEY, 'project');
  assert.equal(project.value, null);
  assert.deepEqual(project.candidates.filter((c) => c.layer !== 'default').map((c) => [c.layer, c.status]), [['project', 'ignored-scope'], ['local', 'ignored-scope']]);
  const shown = f.run(['config', '--show-origin']);
  assert.match(shown.stdout, /workers\.billing = \(none\)/);
  assert.match(shown.stdout, /project .*settings\.json: .* — ignored-scope: global-only/);
  assert.match(shown.stdout, /local .*settings\.local\.json: .* — ignored-scope: global-only/);
});

for (const [label, value, reasonFragment] of [
  ['billing subscription', { claude: { billing: 'subscription', asserted: '2026-10-23' } }, "field 'billing'"],
  ['a missing asserted', { claude: { billing: 'free' } }, "field 'asserted'"],
  ['asserted 2026-02-30', { claude: { billing: 'free', asserted: '2026-02-30' } }, "field 'asserted'"],
  ['an extra field', { claude: { billing: 'free', asserted: '2026-10-23', extra: 1 } }, 'a field other than'],
  ['a non-object value', 'free', 'must be an object'],
  ['a worker id that is not a registry harness', { agy: { billing: 'free', asserted: '2026-10-23' } }, 'unknown-worker:agy'],
]) {
  test(`invalid fails closed: ${label}`, (t) => {
    const f = createSettingsEnv(t);
    f.writeUserSettings({ schema: 1, [KEY]: value });
    const record = readWorkerBilling(f.env(), { workerIds: WORKER_IDS });
    assert.equal(record.state, 'invalid');
    assert.ok(record.reason.includes(reasonFragment), record.reason);
    assert.deepEqual(record.workers, {});
  });
}

// `config -g` flags a record the settings layer can judge by itself (shape, values); an id that is
// not a registry harness is only known to the dispatch reader, so it is not a config fault.
for (const [label, value] of [
  ['billing subscription', { claude: { billing: 'subscription', asserted: '2026-10-23' } }],
  ['a missing asserted', { claude: { billing: 'free' } }],
  ['a non-object value', 'free'],
]) {
  test(`config -g exits 1 for a malformed record: ${label}`, (t) => {
    const f = createSettingsEnv(t);
    f.writeUserSettings({ schema: 1, [KEY]: value });
    assert.equal(f.run(['config', '-g']).status, 1);
  });
}

test('invalid fails closed: an unparseable user settings file', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings('{ not json');
  assert.equal(readWorkerBilling(f.env(), { workerIds: WORKER_IDS }).state, 'invalid');
});

test('a valid record leaves `config -g` clean', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, [KEY]: CLAUDE_FREE });
  const listed = f.run(['config', 'list', '-g', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.json.keys[KEY].value, CLAUDE_FREE);
});

test('config set workers.billing is refused and nothing is written to the config home', (t) => {
  const f = createSettingsEnv(t);
  const refused = f.run(['config', 'set', KEY, '{}']);
  assert.notEqual(refused.status, 0);
  assert.equal(fs.existsSync(f.configDir), false, 'no config home was created');
  assert.equal(fs.existsSync(f.userFile('settings.json')), false);
});

// ── effective billing ────────────────────────────────────────────────────────────────────────────

const recordOf = (billing) => ({ state: 'set', reason: null, workers: { claude: { billing, asserted: '2026-10-23' } } });

test('effectiveBilling: the record lifts unknown, narrows free, and never lifts metered', () => {
  const lifted = effectiveBilling('unknown', 'claude', recordOf('free'));
  assert.deepEqual(lifted, { value: 'free', source: 'user-record', asserted: '2026-10-23' });
  assert.deepEqual(effectiveBilling('free', 'claude', recordOf('metered')), { value: 'metered', source: 'user-record', asserted: '2026-10-23' });
  assert.deepEqual(effectiveBilling('unknown', 'claude', recordOf('metered')), { value: 'metered', source: 'user-record', asserted: '2026-10-23' });
  assert.deepEqual(effectiveBilling('metered', 'claude', recordOf('free')), { value: 'metered', source: 'registry' });
  assert.deepEqual(effectiveBilling('free', 'claude', recordOf('free')), { value: 'free', source: 'registry' });
  assert.deepEqual(effectiveBilling('metered', 'claude', recordOf('metered')), { value: 'metered', source: 'registry' });
});

test('effectiveBilling: no record, another worker, an absent or invalid record is the registry value', () => {
  assert.deepEqual(effectiveBilling('unknown', 'claude', null), { value: 'unknown', source: 'registry' });
  assert.deepEqual(effectiveBilling(undefined, 'claude', recordOf('free')), { value: 'free', source: 'user-record', asserted: '2026-10-23' }, 'a missing descriptor billing reads unknown');
  assert.deepEqual(effectiveBilling('unknown', 'codex', recordOf('free')), { value: 'unknown', source: 'registry' });
  assert.deepEqual(effectiveBilling('unknown', 'claude', { state: 'absent', reason: null, workers: {} }), { value: 'unknown', source: 'registry' });
  assert.deepEqual(effectiveBilling('free', 'claude', { state: 'invalid', reason: 'x', workers: {} }), { value: 'free', source: 'registry' });
});
