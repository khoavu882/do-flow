'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { resolveSetting, writeSetting } = require('../../src/runtime/advice/config');

const REPO = path.resolve(__dirname, '../..');
const ADVICE = loadAdviceRegistry({ repoRoot: REPO }).registry;
const STORAGE = loadStorageRegistry({ repoRoot: REPO });

function fixture(t, global = false) {
  const home = tempDir(t, 'doflow-advice-home-');
  const project = tempDir(t, 'doflow-advice-project-');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot: project, global, env });
  return {
    roots,
    userFile: roots['config-home'] && path.join(roots['config-home'], 'decision-model.json'),
    projectFile: roots['project-doflow'] && path.join(roots['project-doflow'], 'decision-model.json'),
  };
}

function userSetting(overrides = {}) {
  return {
    schema: 1, enabled: true, provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'clef-flash', ...overrides,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function resolve(paths, extra = {}) {
  return resolveSetting({ adviceRegistry: ADVICE, roots: paths.roots, ...extra });
}

test('IC-001 step 1: an absent user file is off and does not consult the project', (t) => {
  const paths = fixture(t);
  writeJson(paths.projectFile, { schema: 1, enabled: false });
  const result = resolve(paths);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'not-configured');
  assert.deepEqual(result.decidedBy, { user: null, project: null });
  assert.equal(result.modelFrom, null);
});

test('IC-001 step 2: invalid user files fail closed with config-invalid', (t) => {
  const paths = fixture(t);
  fs.mkdirSync(path.dirname(paths.userFile), { recursive: true });
  fs.writeFileSync(paths.userFile, '{not json');
  let result = resolve(paths);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'config-invalid');
  assert.equal(result.decidedBy.user, paths.userFile);
  writeJson(paths.userFile, { schema: 1, model: 'missing-enabled' });
  result = resolve(paths);
  assert.equal(result.reason, 'config-invalid');
  assert.equal(result.decidedBy.user, paths.userFile);
});

test('IC-001 step 2: unreadable user file fails closed without throwing', (t) => {
  const paths = fixture(t);
  const fsImpl = Object.create(fs);
  fsImpl.readFileSync = (file, ...args) => {
    if (file === paths.userFile) throw Object.assign(new Error('unreadable fixture'), { code: 'EACCES' });
    return fs.readFileSync(file, ...args);
  };
  const result = resolve(paths, { fsImpl });
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'config-invalid');
  assert.equal(result.decidedBy.user, paths.userFile);
});

test('IC-001 step 3: user disabled takes precedence over project settings', (t) => {
  const paths = fixture(t);
  writeJson(paths.userFile, userSetting({ enabled: false }));
  writeJson(paths.projectFile, { schema: 1, model: 'nimble' });
  const result = resolve(paths);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'user-disabled');
  assert.equal(result.decidedBy.user, paths.userFile);
  assert.equal(result.decidedBy.project, null);
});

test('IC-001 step 5: enabled user setting supplies defaults and records its source', (t) => {
  const paths = fixture(t);
  writeJson(paths.userFile, { schema: 1, enabled: true, model: 'clef-flash' });
  const result = resolve(paths);
  assert.equal(result.state, 'on');
  assert.equal(result.reason, null);
  assert.equal(result.provider, 'ollama');
  assert.equal(result.endpoint, 'http://127.0.0.1:11434');
  assert.equal(result.model, 'clef-flash');
  assert.equal(result.modelFrom, 'user');
  assert.deepEqual(result.decidedBy, { user: paths.userFile, project: null });
});

test('IC-001 step 4: project enabled:false turns the user setting off', (t) => {
  const paths = fixture(t);
  writeJson(paths.userFile, userSetting());
  writeJson(paths.projectFile, { schema: 1, enabled: false });
  const result = resolve(paths);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'project-disabled');
  assert.deepEqual(result.decidedBy, { user: paths.userFile, project: paths.projectFile });
});

test('IC-001 step 5: project model overrides only the model and reports modelFrom', (t) => {
  const paths = fixture(t);
  writeJson(paths.userFile, userSetting());
  writeJson(paths.projectFile, { schema: 1, model: 'nimble' });
  const result = resolve(paths);
  assert.equal(result.state, 'on');
  assert.equal(result.model, 'nimble');
  assert.equal(result.modelFrom, 'project');
  assert.equal(result.endpoint, 'http://127.0.0.1:11434');
  assert.deepEqual(result.decidedBy, { user: paths.userFile, project: paths.projectFile });
});

test('IC-001 lists unknown user keys and ignores project enable, endpoint and provider with notes', (t) => {
  const paths = fixture(t);
  writeJson(paths.userFile, userSetting({ futureUserKey: 'keep-noted' }));
  writeJson(paths.projectFile, {
    schema: 1, enabled: true, model: 'nimble', endpoint: 'http://example.invalid', provider: 'other', futureProjectKey: true,
  });
  const result = resolve(paths);
  assert.equal(result.state, 'on');
  assert.equal(result.model, 'nimble');
  for (const key of ['futureUserKey', 'enabled', 'endpoint', 'provider', 'futureProjectKey']) {
    assert.ok(result.notes.some((note) => note.includes(key)), `missing note for ${key}`);
  }
  for (const key of ['enabled', 'endpoint', 'provider']) {
    assert.ok(result.notes.some((note) => note.includes(key) && note.includes('a project cannot enable the decision model or choose its endpoint')));
  }
});

test('IC-001 ignores an invalid project file with a note and keeps the user setting on', (t) => {
  const paths = fixture(t);
  writeJson(paths.userFile, userSetting());
  fs.mkdirSync(path.dirname(paths.projectFile), { recursive: true });
  fs.writeFileSync(paths.projectFile, '{broken');
  const result = resolve(paths);
  assert.equal(result.state, 'on');
  assert.equal(result.model, 'clef-flash');
  assert.equal(result.modelFrom, 'user');
  assert.equal(result.decidedBy.project, null);
  assert.ok(result.notes.some((note) => note.includes(paths.projectFile)));
});

test('IC-001 global mode reads only the user setting', (t) => {
  const paths = fixture(t, true);
  writeJson(paths.userFile, userSetting());
  assert.equal(paths.projectFile, null);
  const result = resolve(paths);
  assert.equal(result.state, 'on');
  assert.equal(result.decidedBy.project, null);
});

test('IC-021 writer creates config-home and atomically renames the user setting', (t) => {
  const paths = fixture(t, true);
  const calls = [];
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => { calls.push([from, to]); return fs.renameSync(from, to); };
  const setting = userSetting();
  const result = writeSetting({ file: paths.userFile, setting, fsImpl });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.userFile, 'utf8')), setting);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], paths.userFile);
  assert.equal(path.dirname(calls[0][0]), path.dirname(paths.userFile));
  assert.equal(fs.readdirSync(path.dirname(paths.userFile)).length, 1);
});

test('IC-021 --off keeps existing fields and unknown keys', (t) => {
  const paths = fixture(t, true);
  writeJson(paths.userFile, userSetting({ future: 'preserved' }));
  const result = writeSetting({ file: paths.userFile, setting: { schema: 1, enabled: false } });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.userFile, 'utf8')), userSetting({ enabled: false, future: 'preserved' }));
});

test('IC-021 refuses malformed existing JSON without force and replaces it with force', (t) => {
  const paths = fixture(t, true);
  fs.mkdirSync(path.dirname(paths.userFile), { recursive: true });
  fs.writeFileSync(paths.userFile, '{broken');
  let result = writeSetting({ file: paths.userFile, setting: userSetting() });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(paths.userFile, 'utf8'), '{broken');
  result = writeSetting({ file: paths.userFile, setting: userSetting(), force: true });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.userFile, 'utf8')), userSetting());
});

test('IC-021 writer handles project model and project off shapes', (t) => {
  const paths = fixture(t);
  let result = writeSetting({ file: paths.projectFile, level: 'project', setting: { schema: 1, model: 'nimble', future: 'preserved' } });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.projectFile, 'utf8')), { schema: 1, model: 'nimble', future: 'preserved' });
  result = writeSetting({ file: paths.projectFile, level: 'project', setting: { schema: 1, enabled: false } });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.projectFile, 'utf8')), { schema: 1, enabled: false, future: 'preserved' });
});
