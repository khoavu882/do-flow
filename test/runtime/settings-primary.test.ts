'use strict';

// 120 A.2 (IC-002 model-id and env parse `verbatim`, IC-003 primary.*): the three primary declaration
// keys, the model-id value type, and a worker launch that never inherits the declaration. Every case
// uses a scratch HOME and project (test/helper/settings-fixtures.js); nothing reads the real config.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { loadSettingsRegistry, validateSettingsRegistry, REGISTRY_FILE } = require('../../src/runtime/settings/registry.ts');
const { validateValue } = require('../../src/runtime/settings/files.ts');
const { launchEnv } = require('../../src/runtime/worker/launch.ts');

const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const statuses = (r: any) => r.candidates.map((c: any) => `${c.layer}:${c.status}`);

test('primary.harness: the env variable overrides the project layer', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'primary.harness': 'codex' });
  const r = loadSettings({ projectRoot: f.project, env: f.env({ DOFLOW_PRIMARY_HARNESS: 'claude' }) }).get('primary.harness');
  assert.equal(r.value, 'claude');
  assert.equal(r.origin.layer, 'env');
  assert.deepEqual(statuses(r), ['project:overridden', 'env:decided']);
});

test('primary.harness: an env value outside the harness ids is an invalid candidate, never taken', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'primary.harness': 'codex' });
  const v = loadSettings({ projectRoot: f.project, env: f.env({ DOFLOW_PRIMARY_HARNESS: 'not-a-harness' }) });
  const r = v.get('primary.harness');
  assert.equal(r.value, 'codex');
  assert.equal(r.candidates.find((c: any) => c.layer === 'env').status, 'invalid');
  assert.equal(JSON.stringify(v.errors).includes('not-a-harness'), false, 'the reason never echoes the value');
});

test('primary.harness: default unknown, and the allowed list is unknown plus every registry harness in order', () => {
  const loaded = loadSettingsRegistry({ verifyRefs: true, checkConsumers: true });
  assert.equal(loaded.ok, true, loaded.detail);
  const ids = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/harnesses.json'), 'utf8')).harnesses.map((h: any) => h.id);
  assert.deepEqual(loaded.registry.enumValues('primary.harness'), ['unknown', ...ids]);
  assert.equal(loaded.registry.keys.get('primary.harness').default, 'unknown');
  assert.equal(loaded.registry.keys.get('primary.model').default, null);
});

test('primary.onContradiction: a project may only narrow, so a project warn under a user refuse is not-narrower', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'primary.onContradiction': 'refuse' });
  f.writeProjectSettings({ schema: 1, 'primary.onContradiction': 'warn' });
  const r = loadSettings({ projectRoot: f.project, env: f.env() }).get('primary.onContradiction');
  assert.equal(r.value, 'refuse');
  assert.deepEqual(statuses(r), ['user:decided', 'project:not-narrower']);
});

test('model-id: a leading dash, a trailing space, a non-string and an empty string are type; over 120 characters is length', () => {
  const spec = SHIPPED.keys['primary.model'];
  const cases = [['-rf', 'type'], ['gpt ', 'type'], ['', 'type'], [5, 'type'], [null, 'type'], ['a\nb', 'type'], ['a'.repeat(121), 'length']];
  for (const [value, code] of cases) {
    const fault = validateValue(spec, value);
    assert.equal(fault?.code, code, `${JSON.stringify(value).slice(0, 20)}`);
    if (typeof value === 'string' && value.length > 0) assert.equal(fault.reason.includes(value), false, 'the reason never echoes the value');
  }
  assert.equal(validateValue(spec, 'a'.repeat(120)), null);
  for (const ok of ['Gemini 4 Argon (Medium)', 'gpt-6-luna', 'provider/model#v', 'claude-x[1m]']) assert.equal(validateValue(spec, ok), null, ok);
});

test('model-id: an invalid file value is reported with a code and the value is not echoed', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'primary.model': '-rf secret' });
  const v = loadSettings({ projectRoot: f.project, env: f.env() });
  assert.equal(v.get('primary.model').value, null);
  assert.equal(v.errors[0].code, 'type');
  assert.equal(JSON.stringify(v.errors).includes('secret'), false);
});

test('the registry check refuses verbatim on a securityRelevant key and on an integer key, order and narrow-only on a model-id key', () => {
  const withEdit = (key: any, edit: any) => {
    const raw = clone(SHIPPED);
    edit(raw.keys[key]);
    return validateSettingsRegistry(raw);
  };
  assert.equal(validateSettingsRegistry(clone(SHIPPED)).ok, true);

  const secure = withEdit('advice.model', (s: any) => { s.env = { name: 'DOFLOW_ADVICE_MODEL', parse: 'verbatim', direction: 'any' }; });
  assert.equal(secure.ok, false);
  assert.ok(secure.errors.some((e: any) => e.startsWith('advice.model ') && /security-relevant|direction/.test(e)), secure.errors.join('; '));

  const integer = withEdit('review.rounds', (s: any) => { s.env = { name: 'DOFLOW_REVIEW_ROUNDS', parse: 'verbatim', direction: 'any' }; });
  assert.equal(integer.ok, false);
  assert.ok(integer.errors.some((e: any) => e.startsWith('review.rounds ') && /verbatim/.test(e)), integer.errors.join('; '));

  const ordered = withEdit('primary.model', (s: any) => { s.order = ['a', 'b']; });
  assert.ok(ordered.errors.some((e: any) => e.startsWith('primary.model ') && /order/.test(e)), ordered.errors.join('; '));
  const narrow = withEdit('primary.model', (s: any) => { s.scope = 'narrow-only'; });
  assert.ok(narrow.errors.some((e: any) => e.startsWith('primary.model ') && /narrow-only/.test(e)), narrow.errors.join('; '));
});

test('doflow config set primary.harness codex --layer project writes the project file (not refused as security)', (t) => {
  const f = createSettingsEnv(t);
  const result = f.run(['config', 'set', 'primary.harness', '"codex"', '--layer', 'project', '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.projectFile('settings.json'), 'utf8')), { schema: 1, 'primary.harness': 'codex' });
});

test('a worker launch never inherits the primary declaration, and the caller env is unchanged', (t) => {
  const f = createSettingsEnv(t);
  const caller = f.env({ DOFLOW_PRIMARY_HARNESS: 'claude', DOFLOW_PRIMARY_MODEL: 'some-model' });
  const before = { ...caller };
  const { env } = launchEnv({ env: caller, runKey: 'abcdef0123456789/local/main', token: 1, execWorktree: f.project, runId: 'w-0123456789ab' });
  assert.equal('DOFLOW_PRIMARY_HARNESS' in env, false);
  assert.equal('DOFLOW_PRIMARY_MODEL' in env, false);
  assert.equal(env.DOFLOW_SESSION_ROLE, 'worker');
  assert.deepEqual(caller, before);
});
