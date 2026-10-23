'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { resolveSetting } = require('../../src/runtime/advice/config.ts');

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
  writeJson(paths.userFile, userSetting());
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

test('IC-001 an invalid project file turns advice off (fail-closed, config-invalid) and keeps the note', (t) => {
  const paths = fixture(t);
  writeJson(paths.userFile, userSetting());
  fs.mkdirSync(path.dirname(paths.projectFile), { recursive: true });
  fs.writeFileSync(paths.projectFile, '{broken');
  const result = resolve(paths);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'config-invalid');
  assert.equal(result.decidedBy.project, paths.projectFile, 'the invalid project file is what turned advice off');
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

test('C4: decision-model JSON failures report offsets without file contents', (t) => {
  const paths = fixture(t);
  const userSecret = 'S3CR3T!';
  fs.mkdirSync(path.dirname(paths.userFile), { recursive: true });
  fs.writeFileSync(paths.userFile, `{"token":"${userSecret}"`);

  let result = resolve(paths);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'config-invalid');
  assert.match(result.notes[0], /could not be read: not valid JSON at offset \d+/);
  assert.doesNotMatch(result.notes.join('\n'), new RegExp(userSecret));

  writeJson(paths.userFile, userSetting());
  const projectSecret = 'P!';
  fs.mkdirSync(path.dirname(paths.projectFile), { recursive: true });
  fs.writeFileSync(paths.projectFile, projectSecret);
  result = resolve(paths);
  assert.equal(result.state, 'off');
  assert.equal(result.reason, 'config-invalid');
  assert.match(result.notes[0], /ignored: not valid JSON(?: at offset \d+)?/);
  assert.doesNotMatch(result.notes.join('\n'), new RegExp(projectSecret));
});

test('C4: the default provider comes from the settings registry', (t) => {
  const paths = fixture(t);
  writeJson(paths.userFile, { schema: 1, enabled: true, model: 'registry-default-check' });

  const loaded = loadSettingsRegistry({ repoRoot: REPO });
  assert.equal(loaded.ok, true, loaded.detail);
  const configHome = path.dirname(paths.roots['config-home']);
  const view = loadSettings({
    projectRoot: path.dirname(paths.roots['project-doflow']),
    env: { HOME: path.dirname(configHome), XDG_CONFIG_HOME: configHome },
    registry: loaded.registry,
  });
  const result = resolve(paths);
  assert.equal(view.get('advice.provider', 'global').origin.layer, 'default');
  assert.equal(result.provider, view.get('advice.provider', 'global').value);
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, 'src/runtime/advice/config.ts'), 'utf8'), /['"]ollama['"]/);
});

test('C4: a subdirectory projectRoot reads its own layer like the 2.0 direct path', (t) => {
  const repository = tempDir(t, 'doflow-advice-repository-');
  const nested = path.join(repository, 'packages', 'service');
  const home = tempDir(t, 'doflow-advice-home-');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  writeJson(path.join(env.XDG_CONFIG_HOME, 'doflow', 'decision-model.json'), userSetting());
  writeJson(path.join(repository, '.doflow', 'decision-model.json'), { schema: 1, enabled: false });
  const projectFile = path.join(nested, '.doflow', 'decision-model.json');
  writeJson(projectFile, { schema: 1, model: 'nested-project-model' });

  const result = resolveSetting({ adviceRegistry: ADVICE, storageRegistry: STORAGE, projectRoot: nested, env });
  assert.equal(result.state, 'on');
  assert.equal(result.model, 'nested-project-model');
  assert.deepEqual(result.decidedBy, { user: path.join(env.XDG_CONFIG_HOME, 'doflow', 'decision-model.json'), project: projectFile });
});
