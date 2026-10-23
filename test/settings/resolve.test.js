'use strict';

// 086 C.3 (IC-006, IC-007, IC-008; FR-002, FR-004, FR-005, FR-008, FR-010, FR-012, NFR-003, NFR-005):
// the settings resolver. Compatibility rows C1-C21 of data-model §5 are reproduced THROUGH THE
// RESOLVER on the same fixtures as compat-matrix.test.js (which keeps testing the public functions),
// plus origins and candidates, the scope rules, fail-safes by layer, the gate and cross-key rules,
// views, worktrees, the memo, bounded reads, laziness and determinism.
//
// Negative controls: each group has a `control` test whose fixture change flips the observable the
// group asserts. Isolation: every test owns a temp HOME/XDG/project (settings-fixtures) and passes the
// environment explicitly; the memo and laziness cases run in a subprocess whose whole environment is
// the fixture's, so process.env never names the real home.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, userDecision, write, REPO } = require('../helper/settings-fixtures');
const { tempDir } = require('../helper/tmp');
const { loadSettings, clearSettingsCache } = require('../../src/runtime/settings/resolve.ts');
const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { PROJECT_NOTE } = require('../../src/runtime/settings/legacy.ts');
const { MARKER } = require('../../src/runtime/settings/project-layers.ts');

const REGISTRY = 'core/registry/settings.json';
const ENDPOINT = 'http://127.0.0.1:11434';
const POSIX = process.platform !== 'win32';

function fx(t, options) { return createSettingsEnv(t, options); }
function load(f, { env = {}, projectRoot = f.project, ...rest } = {}) {
  return loadSettings({ projectRoot, env: f.env(env), ...rest });
}
const statuses = (r) => r.candidates.map((c) => `${c.layer}${c.legacy ? '*' : ''}:${c.status}`);
const origin = (layer, source, extra = {}) => ({ layer, source, legacy: false, checkout: null, via: null, ...extra });
const DEFAULT = origin('default', REGISTRY);

// ── advice: C1-C8 ─────────────────────────────────────────────────────────────────────────────

test('C1: no advice file: every advice key is its registry default and nothing is explicit', (t) => {
  const f = fx(t);
  const v = load(f);
  const expected = { 'advice.enabled': false, 'advice.provider': 'ollama', 'advice.endpoint': ENDPOINT, 'advice.model': null };
  for (const [key, value] of Object.entries(expected)) {
    const r = v.get(key);
    assert.equal(r.value, value, key);
    assert.deepEqual(r.origin, DEFAULT, key);
    assert.equal(r.explicit, false, key);
    assert.deepEqual(r.candidates, [], key);
  }
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.notes, []);
});

test('C2: a user decision-model {enabled:true, model} enables from the old file; provider and endpoint stay default', (t) => {
  const f = fx(t);
  const file = f.writeUserDecision({ schema: 1, enabled: true, model: 'm' });
  const v = load(f);
  assert.equal(v.get('advice.enabled').value, true);
  assert.deepEqual(v.get('advice.enabled').origin, origin('user', file, { legacy: true }));
  assert.equal(v.get('advice.model').value, 'm');
  assert.deepEqual(v.get('advice.model').origin, origin('user', file, { legacy: true }));
  assert.deepEqual(v.get('advice.provider').origin, DEFAULT);
  assert.equal(v.get('advice.endpoint').value, ENDPOINT);
  assert.deepEqual(v.get('advice.endpoint').origin, DEFAULT);
  const deprecated = v.notes.filter((n) => n.code === 'deprecated').map((n) => n.text);
  assert.deepEqual(deprecated, [
    `${file} is deprecated; set "advice.enabled" in ${f.userFile('settings.json')} (read through 2.x)`,
    `${file} is deprecated; set "advice.model" in ${f.userFile('settings.json')} (read through 2.x)`,
  ]);
});

test('C3: a project {enabled:false} narrows: decided by the project file in the project view only', (t) => {
  const f = fx(t);
  const userFile = f.writeUserDecision(userDecision());
  const projectFile = f.writeProjectDecision({ schema: 1, enabled: false });
  const v = load(f);
  const r = v.get('advice.enabled');
  assert.equal(r.value, false);
  assert.deepEqual(r.origin, origin('project', projectFile, { legacy: true, checkout: 'own' }));
  assert.deepEqual(statuses(r), ['user*:overridden', 'project*:decided']);
  assert.equal(v.get('advice.enabled', 'global').value, true);
  assert.deepEqual(v.get('advice.enabled', 'global').origin.source, userFile);
});

test('C4: a project {model:p} overrides the model in the project view; the global view keeps the user model', (t) => {
  const f = fx(t);
  f.writeUserDecision(userDecision());
  const projectFile = f.writeProjectDecision({ schema: 1, model: 'p' });
  const v = load(f);
  assert.equal(v.get('advice.model').value, 'p');
  assert.equal(v.get('advice.model').origin.source, projectFile);
  assert.equal(v.get('advice.model', 'global').value, 'clef-flash');
  assert.equal(v.get('advice.enabled').value, true);
  assert.equal(v.get('advice.endpoint').value, ENDPOINT);
});

test('C5: a project {enabled:true, endpoint, provider} changes nothing; scope statuses and the three 2.0 notes', (t) => {
  const f = fx(t);
  const userFile = f.writeUserDecision(userDecision());
  const projectFile = f.writeProjectDecision({ schema: 1, enabled: true, endpoint: 'http://example.invalid', provider: 'other' });
  const v = load(f);
  assert.equal(v.get('advice.enabled').value, true);
  assert.equal(v.get('advice.enabled').origin.source, userFile);
  assert.deepEqual(statuses(v.get('advice.enabled')), ['user*:decided', 'project*:redundant']);
  for (const [key, value] of [['advice.provider', 'ollama'], ['advice.endpoint', ENDPOINT]]) {
    const r = v.get(key);
    assert.equal(r.value, value, key);
    assert.equal(r.origin.source, userFile, key);
    const project = r.candidates.find((c) => c.layer === 'project');
    assert.equal(project.status, 'ignored-scope', key);
    assert.equal(project.value, null, key);
  }
  assert.deepEqual(v.notes.filter((n) => n.source === projectFile && n.code !== 'deprecated').map((n) => [n.code, n.key, n.text]), [
    ['scope', 'advice.enabled', `project key 'enabled' ignored: ${PROJECT_NOTE}`],
    ['scope', 'advice.endpoint', `project key 'endpoint' ignored: ${PROJECT_NOTE}`],
    ['scope', 'advice.provider', `project key 'provider' ignored: ${PROJECT_NOTE}`],
  ]);
});

test('C5 shape: with no user setting, a project cannot enable advice (not-narrower) or set a global-only key', (t) => {
  const f = fx(t);
  f.writeProjectSettings({ schema: 1, 'advice.enabled': true, 'advice.endpoint': 'http://203.0.113.5:11434', 'advice.provider': 'ollama' });
  const v = load(f);
  assert.equal(v.get('advice.enabled').value, false);
  assert.deepEqual(statuses(v.get('advice.enabled')), ['project:not-narrower']);
  assert.equal(v.get('advice.enabled').candidates[0].reason, 'narrow-only: a project may only narrow it');
  assert.deepEqual(statuses(v.get('advice.endpoint')), ['project:ignored-scope']);
  assert.deepEqual(statuses(v.get('advice.provider')), ['project:ignored-scope']);
  // never validated: an invalid global-only project value is still only ignored-scope, and no error
  f.writeProjectSettings({ schema: 1, 'advice.endpoint': 'not a url', 'advice.provider': 'nope' });
  const w = load(f);
  assert.deepEqual(statuses(w.get('advice.endpoint')), ['project:ignored-scope']);
  assert.deepEqual(statuses(w.get('advice.provider')), ['project:ignored-scope']);
  assert.equal(w.get('advice.enabled').origin.via, null, 'no gate trip from a project value');
  assert.deepEqual(w.errors, []);
});

test('C6: user {enabled:false}: an equal project value is redundant and never takes the origin; an invalid one is skipped', (t) => {
  const f = fx(t);
  const userFile = f.writeUserDecision(userDecision({ enabled: false }));
  f.writeProjectDecision({ schema: 1, enabled: false });
  let r = load(f).get('advice.enabled');
  assert.equal(r.value, false);
  assert.equal(r.origin.source, userFile);
  assert.deepEqual(statuses(r), ['user*:decided', 'project*:redundant']);
  f.writeProjectDecision('{this is not json');
  r = load(f).get('advice.enabled');
  assert.equal(r.value, false);
  assert.equal(r.origin.source, userFile);
  assert.equal(r.origin.via, null);
  assert.deepEqual(statuses(r), ['user*:decided', 'project*:invalid']);
});

const C7_CASES = [
  ['a', '{not json', null],
  ['b', '[]', 'user setting must be a JSON object'],
  ['c', userDecision({ schema: 2 }), 'user setting schema must be 1'],
  ['d', userDecision({ enabled: 'yes' }), 'user setting enabled must be a boolean'],
  ['e', userDecision({ provider: 'nope' }), "user setting provider 'nope' is not in advice.json providers"],
  ['f', userDecision({ model: undefined }), 'user setting model is required when enabled is true'],
];
for (const [letter, content, reason] of C7_CASES) {
  test(`C7${letter}: an invalid user decision-model fails closed via fail-safe at the user layer, today's error text`, (t) => {
    const f = fx(t);
    const file = f.writeUserDecision(content);
    const v = load(f);
    const r = v.get('advice.enabled');
    assert.equal(r.value, false);
    assert.deepEqual(r.origin, origin('user', file, { legacy: true, via: 'fail-safe' }));
    assert.equal(r.explicit, true);
    assert.equal(v.get('advice.model').value, null);
    const errors = v.errors.filter((e) => e.key === 'advice.enabled');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].source, file);
    if (reason) assert.equal(errors[0].reason, reason);
    else {
      assert.match(errors[0].reason, /^not valid JSON at offset \d+$/);
      assert.equal(errors[0].offset, 1);
      assert.ok(!JSON.stringify(v.report()).includes('not json'), 'no file text in any output');
    }
  });
}

test('C7 (new file): enabled with no model is cross-key; an invalid endpoint trips the advice.enabled gate', (t) => {
  const f = fx(t);
  const file = f.writeUserSettings({ schema: 1, 'advice.enabled': true });
  let v = load(f);
  assert.equal(v.get('advice.enabled').value, false);
  assert.deepEqual(v.get('advice.enabled').origin, origin('user', file, { via: 'cross-key' }));
  assert.deepEqual(v.errors.map((e) => [e.key, e.code]), [['advice.enabled', 'cross-key']]);
  // a model only in the project view does not satisfy the rule: it reads the global view
  f.writeProjectSettings({ schema: 1, 'advice.model': 'p' });
  assert.equal(load(f).get('advice.enabled').origin.via, 'cross-key');

  f.writeUserSettings({ schema: 1, 'advice.enabled': true, 'advice.model': 'm', 'advice.endpoint': 'not a url' });
  v = load(f);
  const r = v.get('advice.enabled');
  assert.equal(r.value, false);
  assert.deepEqual(r.origin, origin('user', file, { via: 'fail-safe' }));
  assert.deepEqual(statuses(r), ['user:overridden']);
  assert.equal(v.get('advice.endpoint').value, ENDPOINT, 'the gated key keeps its lower value');
  assert.deepEqual(statuses(v.get('advice.endpoint')), ['user:invalid']);
});

// 119 phase-BC item 6: advice.model is security-relevant with advice.enabled as its fail-safe gate, so an invalid
// project decision-model trips the gate: advice.enabled takes its fail-safe (off), the gated keys keep the user values.
test('C8: an invalid project decision-model trips the advice.enabled gate: advice is off, the user values stand', (t) => {
  const f = fx(t);
  f.writeUserDecision(userDecision());
  const projectFile = f.writeProjectDecision('{not json');
  const v = load(f);
  assert.equal(v.get('advice.enabled').value, false);
  assert.deepEqual(v.get('advice.enabled').origin, origin('project', projectFile, { checkout: 'own', legacy: true, via: 'fail-safe' }));
  assert.equal(v.get('advice.model').value, 'clef-flash');
  assert.deepEqual(statuses(v.get('advice.model')), ['user*:decided', 'project*:invalid']);
  assert.deepEqual(statuses(v.get('advice.endpoint')), ['user*:decided', 'project*:ignored-scope']);
  assert.ok(v.errors.some((e) => e.source === projectFile && e.code === 'unparseable'));
});

test('control C1-C8: the deciding layer changes the advice result', (t) => {
  const f = fx(t);
  assert.equal(load(f).get('advice.enabled').origin.layer, 'default');
  f.writeUserDecision(userDecision());
  assert.equal(load(f).get('advice.enabled').value, true);
  f.writeProjectDecision({ schema: 1, enabled: false });
  assert.equal(load(f).get('advice.enabled').value, false);                       // C3 differs from C2
  f.writeUserDecision(userDecision({ enabled: false }));
  f.writeProjectDecision({ schema: 1, enabled: true });
  assert.equal(load(f).get('advice.enabled').candidates[1].status, 'not-narrower'); // C5 vs C6
  f.writeUserDecision('{not json');
  assert.equal(load(f).get('advice.enabled').origin.via, 'fail-safe');            // C7 differs from C2
});

// ── storage.prune: C9-C13, the root split and D-11 ──────────────────────────────────────────────

test('C9: no prune file: on from the default in both views', (t) => {
  const f = fx(t);
  const v = load(f);
  for (const view of ['project', 'global']) {
    assert.equal(v.get('storage.prune', view).value, 'on', view);
    assert.deepEqual(v.get('storage.prune', view).origin, DEFAULT, view);
  }
});

test('C10: a user prune=off is off in both views, from the user file', (t) => {
  const f = fx(t);
  const file = f.writeUserPrune('off\n');
  const v = load(f);
  for (const view of ['project', 'global']) {
    assert.equal(v.get('storage.prune', view).value, 'off', view);
    assert.equal(v.get('storage.prune', view).origin.source, file, view);
  }
});

test('C11: user off, project on: the project view is on from the project file, the global view off from the user file', (t) => {
  const f = fx(t);
  const userFile = f.writeUserPrune('off\n');
  const projectFile = f.writeProjectPrune('on\n');
  const v = load(f);
  assert.equal(v.get('storage.prune', 'project').value, 'on');
  assert.equal(v.get('storage.prune', 'project').origin.source, projectFile);
  assert.deepEqual(statuses(v.get('storage.prune', 'project')), ['user*:overridden', 'project*:decided']);
  assert.equal(v.get('storage.prune', 'global').value, 'off');
  assert.equal(v.get('storage.prune', 'global').origin.source, userFile);
});

test('C11 (equal values, OI-3): an override that agrees still takes the origin, so the project file is named', (t) => {
  const f = fx(t);
  f.writeUserPrune('on\n');
  const projectFile = f.writeProjectPrune('on\n');
  const r = load(f).get('storage.prune', 'project');
  assert.equal(r.value, 'on');
  assert.equal(r.origin.source, projectFile);
  assert.deepEqual(statuses(r), ['user*:overridden', 'project*:decided']);
});

test('C12: project off with no user file: off in the project view, on (default) in the global view', (t) => {
  const f = fx(t);
  const projectFile = f.writeProjectPrune('off\n');
  const v = load(f);
  assert.equal(v.get('storage.prune', 'project').value, 'off');
  assert.equal(v.get('storage.prune', 'project').origin.source, projectFile);
  assert.deepEqual(v.get('storage.prune', 'global').origin, DEFAULT);
});

test('C13: a prune file that is empty, garbage or a folder decides off; the first line is trimmed, any case', (t) => {
  const f = fx(t);
  const file = f.userFile('prune');
  for (const content of ['', 'maybe\n', 'on yes\n', '\n']) {
    f.writeUserPrune(content);
    const r = load(f).get('storage.prune', 'global');
    assert.deepEqual([r.value, r.origin.source], ['off', file], JSON.stringify(content));
  }
  f.remove(file);
  fs.mkdirSync(file);
  assert.deepEqual([load(f).get('storage.prune', 'global').value, load(f).get('storage.prune', 'global').origin.source], ['off', file]);
  f.remove(file);
  f.writeUserPrune('  ON  \r\nsecond line ignored\n');
  assert.equal(load(f).get('storage.prune', 'global').value, 'on');
});

test('D-11: a new file shadows the old one at the same layer (prune and model)', (t) => {
  const f = fx(t);
  f.writeUserPrune('off\n');
  const settings = f.writeUserSettings({ schema: 1, 'storage.prune': 'on', 'advice.model': 'b' });
  f.writeUserDecision(userDecision({ enabled: false, model: 'a' }));
  const v = load(f);
  assert.equal(v.get('storage.prune', 'global').value, 'on');
  assert.equal(v.get('storage.prune', 'global').origin.source, settings);
  assert.deepEqual(statuses(v.get('storage.prune', 'global')), ['user*:shadowed', 'user:decided']);
  assert.equal(v.get('advice.model').value, 'b');
  const old = v.get('advice.model').candidates[0];
  assert.deepEqual([old.legacy, old.status, old.display], [true, 'shadowed', '"a"']);
});

test('invalid prune by layer: the user and project layers can widen prune, so it takes the fail-safe off', (t) => {
  const f = fx(t);
  const userFile = f.writeUserSettings({ schema: 1, 'storage.prune': 'maybe' });
  let v = load(f);
  assert.equal(v.get('storage.prune', 'global').value, 'off');
  assert.deepEqual(v.get('storage.prune', 'global').origin, origin('user', userFile, { via: 'fail-safe' }));
  f.remove(userFile);
  const projectFile = f.writeProjectSettings({ schema: 1, 'storage.prune': 7 });
  v = load(f);
  assert.equal(v.get('storage.prune', 'project').value, 'off');
  assert.deepEqual(v.get('storage.prune', 'project').origin, origin('project', projectFile, { checkout: 'own', via: 'fail-safe' }));
  assert.equal(v.get('storage.prune', 'global').value, 'on', 'the project fault affects no other layer');
});

test('control C9-C13: the file content and the view decide prune', (t) => {
  const f = fx(t);
  f.writeUserPrune('off\n');
  f.writeProjectPrune('on\n');
  assert.notEqual(load(f).get('storage.prune', 'project').value, load(f).get('storage.prune', 'global').value); // C11
  f.writeProjectPrune('banana\n');
  assert.equal(load(f).get('storage.prune', 'project').value, 'off');            // C13: off, not the default
  f.writeProjectPrune('on\n');
  assert.equal(load(f).get('storage.prune', 'project').value, 'on');
});

// ── storage.retentionHours: C14-C16, D-8 ─────────────────────────────────────────────────────────

test('C14: env unset: 4320 hours from the storage registry default, not explicit', (t) => {
  const f = fx(t);
  const r = load(f).get('storage.retentionHours');
  assert.equal(r.value, 4320);
  assert.equal(r.state, 'ok');
  assert.equal(r.explicit, false);
  assert.deepEqual(r.origin, DEFAULT);
  assert.equal(load(f, { env: { DOFLOW_RETENTION_HOURS: '' } }).get('storage.retentionHours').explicit, false, 'empty = unset');
});

test('C15: DOFLOW_RETENTION_HOURS=48 is explicit from the env, whatever prune says', (t) => {
  const f = fx(t);
  f.writeUserPrune('off\n');
  const r = load(f, { env: { DOFLOW_RETENTION_HOURS: '48' } }).get('storage.retentionHours');
  assert.deepEqual([r.value, r.state, r.explicit], [48, 'ok', true]);
  assert.deepEqual(r.origin, origin('env', 'DOFLOW_RETENTION_HOURS'));
});

test('C16: DOFLOW_RETENTION_HOURS=abc: the env can widen, so the fail-safe {state: invalid} applies', (t) => {
  const f = fx(t);
  const v = load(f, { env: { DOFLOW_RETENTION_HOURS: 'abc' } });
  const r = v.get('storage.retentionHours');
  assert.equal(r.state, 'invalid');
  assert.deepEqual(r.origin, origin('env', 'DOFLOW_RETENTION_HOURS', { via: 'fail-safe' }));
  assert.equal(r.candidates[0].display, 'abc', 'the raw value the warning names');
  assert.deepEqual(v.errors.map((e) => [e.key, e.layer, e.code]), [['storage.retentionHours', 'env', 'type']]);
  for (const raw of ['0', '-1', '1.5', '9007199254740993']) {
    assert.equal(load(f, { env: { DOFLOW_RETENTION_HOURS: raw } }).get('storage.retentionHours').state, 'invalid', raw);
  }
});

test('FU-k5g213: DOFLOW_RETENTION_HOURS with a leading zero stays invalid and the fault says no leading zeros', (t) => {
  const f = fx(t);
  for (const raw of ['024', '007']) {
    const r = load(f, { env: { DOFLOW_RETENTION_HOURS: raw } }).get('storage.retentionHours');
    assert.equal(r.state, 'invalid', raw);
    assert.match(JSON.stringify(r.candidates[0]), /no leading zeros/, raw);
  }
  const plain = load(f, { env: { DOFLOW_RETENTION_HOURS: 'abc' } }).get('storage.retentionHours');
  assert.doesNotMatch(JSON.stringify(plain.candidates[0]), /leading zeros/);
});

test('D-8: a project retention value applies (explicit) while the project turns prune off; a valid env beats an invalid file', (t) => {
  const f = fx(t);
  const projectFile = f.writeProjectSettings({ schema: 1, 'storage.prune': 'off', 'storage.retentionHours': 48 });
  let v = load(f);
  assert.equal(v.get('storage.prune').value, 'off');
  assert.deepEqual([v.get('storage.retentionHours').value, v.get('storage.retentionHours').explicit], [48, true]);
  assert.equal(v.get('storage.retentionHours').origin.source, projectFile);
  f.writeUserSettings({ schema: 1, 'storage.retentionHours': 'soon' });
  f.remove(projectFile);
  v = load(f);
  assert.equal(v.get('storage.retentionHours').state, 'invalid');
  v = load(f, { env: { DOFLOW_RETENTION_HOURS: '12' } });
  assert.deepEqual([v.get('storage.retentionHours').value, v.get('storage.retentionHours').state], [12, 'ok']);
  assert.deepEqual(statuses(v.get('storage.retentionHours')), ['user:invalid', 'env:decided']);
});

test('control C14-C16: the env value changes the window', (t) => {
  const f = fx(t);
  const at = (raw) => load(f, { env: { DOFLOW_RETENTION_HOURS: raw } }).get('storage.retentionHours');
  assert.notDeepEqual([at('48').value, at('48').state], [at(undefined).value, at(undefined).state]);
  assert.notEqual(at('abc').state, at('48').state);
});

// ── failure.capture: C17-C21 ────────────────────────────────────────────────────────────────────

test('C17: no sentinel, env unset: capture on from the default', (t) => {
  const f = fx(t);
  const r = load(f).get('failure.capture', 'global');
  assert.equal(r.value, 'on');
  assert.deepEqual(r.origin, DEFAULT);
});

test('C18: a failures/off sentinel is off whatever the env says, from the sentinel', (t) => {
  const f = fx(t);
  const sentinel = f.writeSentinel();
  for (const value of [undefined, 'on', '1', 'true', 'off']) {
    const r = load(f, { env: { DOFLOW_FAILURE_CAPTURE: value } }).get('failure.capture', 'global');
    assert.equal(r.value, 'off', String(value));
    assert.deepEqual(r.origin, origin('user', sentinel, { legacy: true }), String(value));
  }
  fs.rmSync(sentinel);
  fs.mkdirSync(sentinel);
  assert.equal(load(f).get('failure.capture').value, 'on', 'a folder named off is not a sentinel');
});

test('C19: env off|0|false|no, any case, padded, is off from the env', (t) => {
  const f = fx(t);
  for (const value of ['off', '0', 'false', 'no', 'OFF', 'False', ' No ', '  0\t']) {
    const r = load(f, { env: { DOFLOW_FAILURE_CAPTURE: value } }).get('failure.capture', 'global');
    assert.equal(r.value, 'off', JSON.stringify(value));
    assert.deepEqual(r.origin, origin('env', 'DOFLOW_FAILURE_CAPTURE'), JSON.stringify(value));
  }
});

test('C20: any other env word has no effect; the env cannot turn an off file on', (t) => {
  const f = fx(t);
  for (const value of ['on', '1', 'true', 'yes', 'banana', 'offf', ' ']) {
    const r = load(f, { env: { DOFLOW_FAILURE_CAPTURE: value } }).get('failure.capture', 'global');
    assert.equal(r.value, 'on', value);
    assert.deepEqual(statuses(r), ['env:no-effect'], value);
  }
  const file = f.writeUserSettings({ schema: 1, 'failure.capture': 'off' });
  const r = load(f, { env: { DOFLOW_FAILURE_CAPTURE: 'on' } }).get('failure.capture');
  assert.equal(r.value, 'off');
  assert.equal(r.origin.source, file);
  // off-dominance: a later "on" never beats an off below it, and an equal off is redundant
  f.writeSentinel();
  f.writeUserSettings({ schema: 1, 'failure.capture': 'on' });
  assert.deepEqual(statuses(load(f).get('failure.capture')), ['user*:decided', 'user:not-narrower']);
  assert.deepEqual(statuses(load(f, { env: { DOFLOW_FAILURE_CAPTURE: 'off' } }).get('failure.capture')), ['user*:decided', 'user:not-narrower', 'env:redundant']);
});

test('capture uses the lexical rule on the user file and ignores the project (global-only)', (t) => {
  const f = fx(t);
  f.writeProjectSettings({ schema: 1, 'failure.capture': 'off' });
  let r = load(f).get('failure.capture', 'project');
  assert.equal(r.value, 'on');
  assert.deepEqual(statuses(r), ['project:ignored-scope']);
  // JSON-invalid type and a broken file still read lexically, as the shell readers do
  f.writeUserSettings('{"schema":1,"failure.capture":true}');
  assert.equal(load(f).get('failure.capture').value, 'off');
  f.writeUserSettings('{"failure.capture":"off", broken');
  const v = load(f);
  assert.equal(v.get('failure.capture').value, 'off');
  assert.equal(v.get('storage.prune').origin.via, 'fail-safe', 'the other keys of the broken layer are invalid');
  r = v.get('failure.capture');
  assert.deepEqual(statuses(r), ['user:decided', 'project:ignored-scope']);
});

test('C21: an absolute XDG_CONFIG_HOME is the config home', (t) => {
  const f = fx(t);
  const v = load(f);
  assert.deepEqual(v.configHome, { dir: path.join(f.xdg, 'doflow'), ignored: [] });
  f.writeUserDecision(userDecision());
  assert.equal(load(f).get('advice.enabled').origin.source, path.join(f.xdg, 'doflow', 'decision-model.json'));
});

test('control C17-C21: the sentinel, the env word and the user file each flip capture', (t) => {
  const f = fx(t);
  assert.equal(load(f).get('failure.capture').value, 'on');
  assert.equal(load(f, { env: { DOFLOW_FAILURE_CAPTURE: 'off' } }).get('failure.capture').value, 'off');
  assert.equal(load(f, { env: { DOFLOW_FAILURE_CAPTURE: 'banana' } }).get('failure.capture').value, 'on');
  f.writeUserSettings({ schema: 1, 'failure.capture': 'off' });
  assert.equal(load(f).get('failure.capture').value, 'off');
  f.remove(f.userFile('settings.json'));
  f.writeSentinel();
  assert.equal(load(f).get('failure.capture').value, 'off');
});

// ── no config home: C22, C23 ──────────────────────────────────────────────────────────────────────

test('C22: HOME and XDG unset: no user layer, capture off via no-config-home, the rest default', (t) => {
  const f = fx(t);
  // HOME is unset in the env handed over; nothing reads os.homedir(), so only project files are touched
  const v = loadSettings({ projectRoot: f.project, env: { PATH: process.env.PATH } });
  assert.deepEqual(v.configHome, { dir: null, ignored: [] });
  const r = v.get('failure.capture', 'global');
  assert.equal(r.value, 'off');
  assert.deepEqual(r.origin, { layer: 'default', source: null, legacy: false, checkout: null, via: 'no-config-home' });
  assert.equal(v.get('advice.enabled').value, false);
  assert.deepEqual(v.get('storage.prune', 'global').origin, DEFAULT);
  v.report();
  assert.deepEqual(v.files.filter((file) => file.layer === 'user'), [], 'no user-layer file is looked at');
  const relative = loadSettings({ projectRoot: f.project, env: { HOME: 'rel-home' } });
  assert.deepEqual(relative.configHome, { dir: null, ignored: ['HOME'] });
});

test('C23: a relative XDG_CONFIG_HOME is ignored and named; the config home is $HOME/.config/doflow', (t) => {
  const f = fx(t);
  write(path.join(f.project, 'rel-xdg', 'doflow', 'prune'), 'off\n');
  const v = load(f, { env: { XDG_CONFIG_HOME: 'rel-xdg' } });
  assert.deepEqual(v.configHome, { dir: path.join(f.home, '.config', 'doflow'), ignored: ['XDG_CONFIG_HOME'] });
  assert.equal(v.get('storage.prune', 'global').value, 'on');
  write(path.join(f.home, '.config', 'doflow', 'prune'), 'off\n');
  assert.equal(load(f, { env: { XDG_CONFIG_HOME: 'rel-xdg' } }).get('storage.prune', 'global').value, 'off'); // control
});

// ── precedence, views, unparseable files ─────────────────────────────────────────────────────────

test('per-key precedence (§6.1): project prune on, user prune off, env retention 48', (t) => {
  const f = fx(t);
  const userFile = f.writeUserSettings({ schema: 1, 'storage.prune': 'off' });
  const projectFile = f.writeProjectSettings({ schema: 1, 'storage.prune': 'on' });
  const v = load(f, { env: { DOFLOW_RETENTION_HOURS: '48' } });
  assert.deepEqual([v.get('storage.prune', 'project').value, v.get('storage.prune', 'project').origin.source], ['on', projectFile]);
  assert.deepEqual([v.get('storage.prune', 'global').value, v.get('storage.prune', 'global').origin.source], ['off', userFile]);
  assert.deepEqual(statuses(v.get('storage.prune', 'project')), ['user:overridden', 'project:decided']);
  assert.deepEqual([v.get('storage.retentionHours').value, v.get('storage.retentionHours').origin.layer], [48, 'env']);
  // resolution is per key: the local file setting one key hides nothing else
  f.writeProjectLocal({ schema: 1, 'storage.retentionHours': 6 });
  const w = load(f);
  assert.equal(w.get('storage.prune').origin.source, projectFile);
  assert.equal(w.get('storage.retentionHours').origin.layer, 'local');
  assert.equal(load(f, { env: { DOFLOW_RETENTION_HOURS: '48' } }).get('storage.retentionHours').value, 48, 'env above local');
});

test('the global view omits the project layers and refuses a project get', (t) => {
  const f = fx(t);
  f.writeProjectSettings({ schema: 1, 'storage.prune': 'off', 'advice.model': 'p' });
  f.writeProjectPrune('off\n');
  const v = load(f, { global: true });
  assert.equal(v.scope, 'global');
  assert.deepEqual(v.project, { root: null, layersFrom: null, checkout: null });
  assert.equal(v.get('storage.prune').value, 'on');
  assert.equal(v.get('advice.model').value, null);
  assert.throws(() => v.get('storage.prune', 'project'), /global/);
  assert.throws(() => v.get('no.such'), /unknown settings key/);
  v.report();
  assert.ok(v.files.every((file) => file.layer === 'user'), 'no project file is looked at');
  assert.equal(load(f).get('storage.prune').value, 'off', 'control: the project view reads them');
});

test('an unparseable user file marks every key of that layer invalid and affects no other layer; offset only', (t) => {
  const f = fx(t);
  const file = f.writeUserSettings('root:x:0:0:root:/root:/bin/bash\n');
  f.writeProjectSettings({ schema: 1, 'advice.model': 'p' });
  const v = load(f);
  const report = v.report();
  assert.deepEqual(v.get('advice.enabled').origin, origin('user', file, { via: 'fail-safe' }));
  assert.deepEqual([v.get('storage.prune', 'global').value, v.get('storage.prune', 'global').origin.via], ['off', 'fail-safe']);
  assert.equal(v.get('storage.retentionHours').state, 'invalid');
  assert.equal(v.get('advice.model').value, 'p', 'the project layer is untouched');
  assert.equal(v.get('failure.capture').value, 'on', 'capture reads the file lexically: no match is no setting');
  const userErrors = v.errors.filter((e) => e.source === file);
  assert.deepEqual(userErrors.map((e) => e.key).sort(), ['advice.enabled', 'advice.endpoint', 'advice.model', 'advice.provider', 'autopilot.enabled', 'debate.preset', 'dispatch.fallback', 'review.blockerClauses', 'review.crossFamilyRereview', 'review.extraLenses', 'review.preset', 'review.rounds', 'review.sameFamily', 'storage.prune', 'storage.retentionHours', 'verify.reuse', 'workers.billing']);
  // V8 quotes the input in an "Unexpected token" message and gives no position: no offset then
  assert.ok(userErrors.every((e) => e.code === 'unparseable' && e.offset === null && e.reason === 'not valid JSON'));
  assert.ok(!JSON.stringify(report).includes('root:x'), 'no byte of the file in any output');
});

test('an unparseable project file: project-overridable keys fail safe in the project view, narrow-only skip', (t) => {
  const f = fx(t);
  f.writeUserSettings({ schema: 1, 'advice.enabled': true, 'advice.model': 'm' });
  const file = f.writeProjectSettings('{nope');
  const v = load(f);
  // 119 phase-BC item 6: advice.model gates advice.enabled, so the broken project layer turns advice off
  assert.equal(v.get('advice.enabled').value, false, 'advice.model is security-relevant: the project layer trips the advice.enabled gate');
  assert.deepEqual(v.get('advice.enabled').origin, origin('project', file, { checkout: 'own', via: 'fail-safe' }));
  assert.deepEqual(statuses(v.get('advice.enabled')), ['user:overridden', 'project:invalid']);
  assert.equal(v.get('advice.model').value, 'm', 'the gated key keeps its lower value');
  assert.deepEqual(v.get('storage.prune').origin, origin('project', file, { checkout: 'own', via: 'fail-safe' }));
  assert.equal(v.get('storage.retentionHours').state, 'invalid');
  assert.equal(v.get('storage.prune', 'global').value, 'on');
  assert.equal(v.files.find((rec) => rec.path === file).status, 'invalid');
});

test('unknown and nested keys are notes, never errors; url values are shown without user-info', (t) => {
  const f = fx(t);
  const file = f.writeUserSettings({ schema: 1, 'some.thing': 1, advice: { model: 'x' }, 'advice.endpoint': 'http://tok:secret@h:1/p', 'advice.enabled': false });
  const v = load(f);
  v.report();
  assert.deepEqual(v.notes.map((n) => [n.code, n.source]), [['unknown-key', file], ['nested', file]]);
  assert.deepEqual(v.errors, []);
  assert.equal(v.get('advice.endpoint').value, 'http://tok:secret@h:1/p');
  assert.equal(v.get('advice.endpoint').candidates[0].display, '"http://***@h:1/p"');
  assert.ok(!v.get('advice.endpoint').candidates.some((c) => c.display.includes('secret')), 'value stays real; only display is masked');
});

// ── fixture registry: narrow enum, ascending integer, inverted boolean, env narrow-only ─────────

function fixtureRegistry(t) {
  const dir = tempDir(t, 'doflow-settings-reg-');
  const common = { combine: 'override', flag: null, shellRead: null, needsConfigHome: false, legacy: [], consumers: ['src/runtime/settings/resolve.ts'] };
  write(path.join(dir, 'core', 'registry', 'settings.json'), {
    version: 1,
    description: 'fixture',
    keys: {
      'fixture.level': { ...common, type: 'enum', values: ['low', 'mid', 'high'], order: ['low', 'mid', 'high'], default: 'high', scope: 'narrow-only', securityRelevant: false, failSafe: 'low', env: null, description: 'narrow enum' },
      'fixture.count': { ...common, type: 'integer', min: 1, order: 'ascending', default: 10, scope: 'narrow-only', securityRelevant: true, failSafe: 1, env: { name: 'DOFLOW_FIXTURE_COUNT', parse: 'positive-int', direction: 'narrow' }, description: 'ascending integer' },
      'fixture.strict': { ...common, type: 'boolean', order: [true, false], default: false, scope: 'narrow-only', securityRelevant: false, env: null, description: 'inverted boolean' },
    },
  });
  const loaded = loadSettingsRegistry({ repoRoot: dir });
  assert.equal(loaded.ok, true, loaded.detail);
  return loaded.registry;
}

test('narrow enum: a narrower project value applies, an equal one is redundant, a wider one not-narrower', (t) => {
  const f = fx(t);
  const registry = fixtureRegistry(t);
  f.writeUserSettings({ schema: 1, 'fixture.level': 'mid' });
  const at = (value) => {
    f.writeProjectSettings({ schema: 1, 'fixture.level': value });
    return load(f, { registry }).get('fixture.level');
  };
  assert.deepEqual([at('low').value, statuses(at('low'))], ['low', ['user:overridden', 'project:decided']]);
  assert.deepEqual([at('mid').value, at('mid').origin.layer, statuses(at('mid'))], ['mid', 'user', ['user:decided', 'project:redundant']]);
  assert.deepEqual([at('high').value, statuses(at('high'))], ['mid', ['user:decided', 'project:not-narrower']]);
  // invalid by layer class: the user layer widens (fail-safe low), the project layer cannot (skip)
  assert.deepEqual([at('bogus').value, at('bogus').origin.layer], ['mid', 'user']);
  f.writeUserSettings({ schema: 1, 'fixture.level': 'bogus' });
  f.remove(f.projectFile('settings.json'));
  assert.deepEqual([load(f, { registry }).get('fixture.level').value, load(f, { registry }).get('fixture.level').origin.via], ['low', 'fail-safe']);
});

test('ascending integer with a narrow-only env binding: the env may only narrow, an invalid env value is skipped', (t) => {
  const f = fx(t);
  const registry = fixtureRegistry(t);
  f.writeProjectLocal({ schema: 1, 'fixture.count': 5 });
  const at = (raw) => load(f, { registry, env: { DOFLOW_FIXTURE_COUNT: raw } }).get('fixture.count');
  assert.deepEqual([at(undefined).value, at(undefined).origin.layer], [5, 'local']);
  assert.deepEqual([at('3').value, at('3').origin.layer], [3, 'env']);
  assert.deepEqual([at('5').value, at('5').origin.layer, at('5').candidates[1].status], [5, 'local', 'redundant']);
  assert.deepEqual([at('50').value, at('50').candidates[1].status], [5, 'not-narrower']);
  assert.deepEqual([at('x').value, at('x').origin.via, at('x').candidates[1].status], [5, null, 'invalid'], 'a narrow env cannot widen: skip');
  f.writeProjectLocal({ schema: 1, 'fixture.count': 20 });
  assert.deepEqual([at(undefined).value, at(undefined).candidates[0].status], [10, 'not-narrower']);
});

test('inverted boolean order: true is the narrower value', (t) => {
  const f = fx(t);
  const registry = fixtureRegistry(t);
  f.writeProjectSettings({ schema: 1, 'fixture.strict': true });
  assert.equal(load(f, { registry }).get('fixture.strict').value, true);
  f.writeUserSettings({ schema: 1, 'fixture.strict': true });
  f.writeProjectSettings({ schema: 1, 'fixture.strict': false });
  const r = load(f, { registry }).get('fixture.strict');
  assert.deepEqual([r.value, statuses(r)], [true, ['user:decided', 'project:not-narrower']]);
});

// ── worktrees and sandboxes (W1, FR-012) ──────────────────────────────────────────────────────────

test('W1 (this release): a linked worktree with no settings of its own reads the main checkout files, named as such', (t) => {
  const f = fx(t, { worktree: true });
  f.writeUserDecision(userDecision());
  const prune = f.writeProjectPrune('off\n');
  const decision = f.writeProjectDecision({ schema: 1, enabled: false });
  const v = load(f, { projectRoot: f.worktree });
  assert.equal(v.project.checkout, 'main');
  assert.equal(v.project.layersFrom, path.join(fs.realpathSync(f.project), '.doflow'));
  const main = (file) => path.join(fs.realpathSync(f.project), path.relative(f.project, file));
  assert.deepEqual(v.get('storage.prune').origin, origin('project', main(prune), { legacy: true, checkout: 'main' }));
  assert.equal(v.get('advice.enabled').value, false);
  assert.equal(v.get('advice.enabled').origin.source, main(decision));
  // W1b: the worktree's own file wins, and then nothing comes from the main checkout
  const own = f.writeProjectPrune('on\n', f.worktree);
  const w = load(f, { projectRoot: f.worktree });
  assert.equal(w.project.checkout, 'own');
  assert.deepEqual(w.get('storage.prune').origin, origin('project', own, { legacy: true, checkout: 'own' }));
  assert.equal(w.get('advice.enabled').value, true);
});

test('a sandbox reads only its own checkout', (t) => {
  const f = fx(t, { worktree: true });
  f.writeProjectPrune('off\n');
  write(path.join(f.worktree, MARKER), 'base\n');
  const v = load(f, { projectRoot: f.worktree });
  assert.equal(v.project.checkout, 'sandbox');
  assert.deepEqual(v.get('storage.prune').origin, DEFAULT);
  fs.rmSync(path.join(f.worktree, MARKER));
  assert.equal(load(f, { projectRoot: f.worktree }).get('storage.prune').value, 'off', 'control: without the marker it inherits');
});

// ── before this release ────────────────────────────────────────────────────────────────────────

test('a machine from earlier betas with only old files resolves to legacy values, each with a deprecation note', (t) => {
  const f = fx(t);
  const decision = f.writeUserDecision(userDecision());
  const userPrune = f.writeUserPrune('off\n');
  const projectPrune = f.writeProjectPrune('on\n');
  const sentinel = f.writeSentinel();
  const v = load(f);
  const got = Object.fromEntries(['advice.enabled', 'advice.provider', 'advice.endpoint', 'advice.model', 'failure.capture'].map((k) => [k, v.get(k).value]));
  assert.deepEqual(got, { 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': ENDPOINT, 'advice.model': 'clef-flash', 'failure.capture': 'off' });
  assert.deepEqual([v.get('storage.prune', 'project').value, v.get('storage.prune', 'global').value], ['on', 'off']);
  const deprecated = new Set(v.report().notes.filter((n) => n.code === 'deprecated').map((n) => `${n.source}|${n.key}`));
  for (const entry of [`${decision}|advice.enabled`, `${decision}|advice.provider`, `${decision}|advice.endpoint`, `${decision}|advice.model`,
    `${userPrune}|storage.prune`, `${projectPrune}|storage.prune`, `${sentinel}|failure.capture`]) {
    assert.ok(deprecated.has(entry), entry);
  }
  assert.equal(v.notes.find((n) => n.source === projectPrune && n.code === 'deprecated').text,
    `${projectPrune} is deprecated; set "storage.prune" in ${f.projectFile('settings.json')} (read through 2.x)`);
});

// ── reads, laziness, memo, spawn, determinism ─────────────────────────────────────────────────────

/** A real fs whose calls are counted per path. */
function countingFs() {
  const calls = [];
  const wrap = (name) => (p, ...rest) => { calls.push([name, p]); return fs[name](p, ...rest); };
  return { calls, statSync: wrap('statSync'), lstatSync: wrap('lstatSync'), readFileSync: wrap('readFileSync'), realpathSync: wrap('realpathSync') };
}

test('bounded reads: every path is stat-ed and read at most once per view, only present files are read', (t) => {
  const f = fx(t);
  const present = [
    f.writeUserSettings({ schema: 1, 'storage.prune': 'on', 'failure.capture': 'on' }),
    f.writeUserDecision(userDecision()),
    f.writeProjectSettings({ schema: 1, 'advice.model': 'p' }),
    f.writeProjectPrune('off\n'),
  ];
  const spy = countingFs();
  const v = loadSettings({ projectRoot: f.project, env: f.env(), fsImpl: spy });
  v.report();
  v.report();
  const count = (name) => {
    const per = new Map();
    for (const [n, p] of spy.calls) if (n === name) per.set(p, (per.get(p) || 0) + 1);
    return per;
  };
  for (const [p, n] of count('statSync')) assert.equal(n, 1, `stat ${p}`);
  assert.deepEqual([...count('readFileSync').keys()].sort(), present.sort(), 'only present files are read');
  for (const [p, n] of count('readFileSync')) assert.equal(n, 1, `read ${p}`);
  assert.equal(count('statSync').size, 9, 'two settings files and a local, two decision-models, two prunes, two sentinels');
  // a fresh view reads again (the per-view bound, not a process-wide cache for an injected fs)
  loadSettings({ projectRoot: f.project, env: f.env(), fsImpl: spy }).get('storage.prune');
  assert.ok(count('statSync').get(f.userFile('settings.json')) === 2);
});

test('a key reads only its own sources: retention needs no legacy file', (t) => {
  const f = fx(t);
  const spy = countingFs();
  loadSettings({ projectRoot: f.project, env: f.env(), fsImpl: spy }).get('storage.retentionHours');
  const stated = spy.calls.filter(([n]) => n === 'statSync').map(([, p]) => path.basename(p)).sort();
  assert.deepEqual(stated, ['settings.json', 'settings.json', 'settings.local.json']);
});

function nodeIn(f, script, extra = {}) {
  return f.node(`const repo = ${JSON.stringify(REPO)};\n${script}`, { env: extra });
}

test('legacy.ts is not loaded without a stat hit on a legacy path, and is loaded on one', (t) => {
  const f = fx(t);
  const script = `
    const { loadSettings } = require(repo + '/src/runtime/settings/resolve.ts');
    loadSettings({ projectRoot: process.cwd() }).report();
    const loaded = (name) => Object.keys(require.cache).some((p) => p.endsWith('/settings/' + name));
    process.stdout.write(JSON.stringify({ legacy: loaded('legacy.ts'), lexical: loaded('lexical.ts') }));`;
  f.writeUserSettings({ schema: 1, 'storage.prune': 'off' });
  assert.deepEqual(nodeIn(f, script), { legacy: false, lexical: true });
  f.writeProjectPrune('off\n');
  assert.deepEqual(nodeIn(f, script), { legacy: true, lexical: true });
  const prune = `
    const { loadSettings } = require(repo + '/src/runtime/settings/resolve.ts');
    loadSettings({ projectRoot: process.cwd() }).get('storage.retentionHours');
    process.stdout.write(JSON.stringify(Object.keys(require.cache).some((p) => p.endsWith('/settings/legacy.ts') || p.endsWith('/settings/lexical.ts'))));`;
  assert.equal(nodeIn(f, prune), false, 'retention alone loads neither');
});

test('memo: the real env and fs share one view per process until clearSettingsCache(); writes are seen after it', (t) => {
  const f = fx(t);
  const script = `
    const fs = require('node:fs');
    const { loadSettings, clearSettingsCache } = require(repo + '/src/runtime/settings/resolve.ts');
    const root = process.cwd();
    const a = loadSettings({ projectRoot: root });
    const before = a.get('storage.prune').value;
    fs.writeFileSync(root + '/.doflow/settings.json', JSON.stringify({ schema: 1, 'storage.prune': 'off' }));
    const b = loadSettings({ projectRoot: root });
    const stale = b.get('storage.prune').value;
    const otherScope = loadSettings({ projectRoot: root, global: true }) === a;
    const ownEnv = loadSettings({ projectRoot: root, env: { ...process.env } }) === a;
    const ownFs = loadSettings({ projectRoot: root, fsImpl: { ...fs } }) === a;
    process.env.DOFLOW_RETENTION_HOURS = '5';
    const envChanged = loadSettings({ projectRoot: root }) === a;
    delete process.env.DOFLOW_RETENTION_HOURS;
    clearSettingsCache();
    const c = loadSettings({ projectRoot: root });
    process.stdout.write(JSON.stringify({ same: a === b, before, stale, otherScope, ownEnv, ownFs, envChanged, fresh: c !== a, after: c.get('storage.prune').value }));`;
  assert.deepEqual(nodeIn(f, script), {
    same: true, before: 'on', stale: 'on', otherScope: false, ownEnv: false, ownFs: false, envChanged: false, fresh: true, after: 'off',
  });
  assert.equal(typeof clearSettingsCache, 'function');
});

test('no child process is spawned, in a linked worktree with every file present', (t) => {
  const f = fx(t, { worktree: true });
  f.writeUserDecision(userDecision());
  f.writeProjectPrune('off\n');
  f.writeSentinel();
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const saved = Object.fromEntries(names.map((n) => [n, childProcess[n]]));
  const calls = [];
  for (const n of names) childProcess[n] = (...args) => { calls.push(n); return saved[n](...args); };
  try {
    load(f, { projectRoot: f.worktree }).report();
    assert.deepEqual(calls, []);
    childProcess.spawnSync(process.execPath, ['-e', '0']);
    assert.deepEqual(calls, ['spawnSync'], 'control: the spy sees a spawn');
  } finally {
    Object.assign(childProcess, saved);
  }
});

test('deterministic: the same tree gives the same report, and reading creates nothing', { skip: !POSIX }, (t) => {
  const f = fx(t, { worktree: true });
  f.writeUserDecision(userDecision());
  f.writeProjectSettings({ schema: 1, 'storage.prune': 'off', bad: { x: 1 } });
  f.writeProjectLocal('{oops');
  const snapshot = () => childProcess.spawnSync('find', [f.dir], { encoding: 'utf8' }).stdout.split('\n').sort();
  const before = snapshot();
  const a = load(f, { projectRoot: f.worktree, env: { DOFLOW_RETENTION_HOURS: 'x' } }).report();
  const b = load(f, { projectRoot: f.worktree, env: { DOFLOW_RETENTION_HOURS: 'x' } }).report();
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'plain data');
  assert.deepEqual(snapshot(), before);
  clearSettingsCache();
});

test('legacy unknown project keys are JSON-escaped and capped before becoming notes', (t) => {
  const f = fx(t);
  const key = `unsafe\u001b]0;title\u0007${'x'.repeat(100)}${'y'.repeat(40)}`;
  const file = f.writeProjectDecision({ schema: 1, enabled: false, [key]: 'ignored' });
  const view = load(f);
  view.get('advice.enabled');
  const note = view.notes.find((entry) => entry.source === file && entry.text.startsWith('unknown project key'));
  assert.ok(note, 'the legacy key is still reported');
  const shown = JSON.stringify(`${key.slice(0, 80)}...`);
  assert.equal(note.text, `unknown project key ${shown} ignored`);
  assert.doesNotMatch(note.text, /[\u0000-\u001f\u007f-\u009f]/, 'terminal control bytes are escaped');
  assert.ok(!note.text.includes(key.slice(80)), 'long keys are capped');
});

test('without a config home, the fail-safe owns failure.capture and the env candidate is overridden', (t) => {
  const f = fx(t);
  const noHome = load(f, { env: { HOME: undefined, XDG_CONFIG_HOME: undefined, DOFLOW_FAILURE_CAPTURE: 'off' } });
  const resolution = noHome.get('failure.capture', 'global');
  assert.equal(resolution.value, 'off');
  assert.equal(resolution.origin.via, 'no-config-home');
  assert.equal(resolution.candidates.find((candidate) => candidate.layer === 'env').status, 'overridden');

  const withHome = load(f, { env: { DOFLOW_FAILURE_CAPTURE: 'off' } }).get('failure.capture', 'global');
  assert.equal(withHome.origin.layer, 'env');
  assert.equal(withHome.candidates.find((candidate) => candidate.layer === 'env').status, 'decided', 'control: the env holds origin when a config home exists');
});
