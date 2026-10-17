'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSettingsEnv, userDecision } = require('../helper/settings-fixtures');
const { writeLayer } = require('../../src/runtime/settings/write.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('writes schema first and owned keys in registry order, keeps foreign keys, and leaves legacy files byte-identical', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({
    'future.flag': 'preserve me',
    'storage.prune': 'off',
    'advice.model': 'old-model',
    'failure.capture': 'off',
  });
  const legacy = f.writeUserDecision(userDecision());
  const legacyHash = sha256(legacy);
  const sentinel = f.writeSentinel('off sentinel\n');
  const sentinelHash = sha256(sentinel);

  const file = f.userFile('settings.json');
  const renames = [];
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => { renames.push([from, to]); return fs.renameSync(from, to); };
  const result = writeLayer({
    file,
    set: { 'advice.enabled': true, 'advice.model': 'new-model', 'failure.capture': 'on' },
    fsImpl,
  });

  assert.equal(result.ok, true, result.detail);
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], file);
  assert.equal(path.dirname(renames[0][0]), path.dirname(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(parsed), [
    'schema', 'advice.enabled', 'advice.model', 'storage.prune', 'failure.capture', 'future.flag',
  ]);
  assert.deepEqual(parsed, {
    schema: 1,
    'advice.enabled': true,
    'advice.model': 'new-model',
    'storage.prune': 'off',
    'failure.capture': 'on',
    'future.flag': 'preserve me',
  });
  assert.equal(sha256(legacy), legacyHash);
  assert.equal(sha256(sentinel), sentinelHash);
});

test('a no-op keeps the existing settings file byte-identical', (t) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = '{\n  "foreign": "kept",\n  "storage.prune": "off",\n  "schema": 1\n}\n';
  fs.writeFileSync(file, original);

  const result = writeLayer({ file, set: { 'storage.prune': 'off' } });

  assert.equal(result.ok, true, result.detail);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('refuses an invalid settings file unless force is set', (t) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken\n');

  const refused = writeLayer({ file, set: { 'storage.prune': 'off' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'config-invalid');
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken\n');

  const forced = writeLayer({ file, set: { 'storage.prune': 'off' }, force: true });
  assert.equal(forced.ok, true, forced.detail);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: 1, 'storage.prune': 'off' });
});

test('replaces a symlinked settings target without changing its referent', (t) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  const target = f.userFile('target.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(target, '{\n  "schema": 1,\n  "storage.prune": "on"\n}\n');
  const targetHash = sha256(target);
  fs.symlinkSync(target, file);

  const result = writeLayer({ file, set: { 'storage.prune': 'off' } });

  assert.equal(result.ok, true, result.detail);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(sha256(target), targetHash);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: 1, 'storage.prune': 'off' });
});

test('negative control: a direct write through the symlink fails the replacement assertions', (t) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  const target = f.userFile('target.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(target, 'original\n');
  const targetHash = sha256(target);
  fs.symlinkSync(target, file);

  assert.throws(() => {
    fs.writeFileSync(file, 'wrong: write-through\n');
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(sha256(target), targetHash);
  }, assert.AssertionError);
});

test('a failure --set with no config home keeps the existing no-home output and writes nothing', (t) => {
  const f = createSettingsEnv(t);
  const snapshot = () => fs.readdirSync(f.dir, { recursive: true }).sort();
  const before = snapshot();

  const result = f.run(['failure', '--action', 'capture', '--set', 'off', '--json'], {
    env: { HOME: undefined, XDG_CONFIG_HOME: undefined },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json, {
    ok: true, action: 'capture', effective: 'off', sentinel: false, env: null, home: null,
  });
  assert.deepEqual(snapshot(), before);
});

test('clears the resolver cache after writing', (t) => {
  const f = createSettingsEnv(t);
  const names = ['HOME', 'XDG_CONFIG_HOME', 'DOFLOW_FAILURE_CAPTURE'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.HOME = f.home;
    process.env.XDG_CONFIG_HOME = f.xdg;
    delete process.env.DOFLOW_FAILURE_CAPTURE;
    const file = f.userFile('settings.json');
    assert.equal(loadSettings({ global: true }).get('failure.capture', 'global').value, 'on');

    const result = writeLayer({ file, set: { 'failure.capture': 'off' } });

    assert.equal(result.ok, true, result.detail);
    assert.equal(loadSettings({ global: true }).get('failure.capture', 'global').value, 'off');
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
