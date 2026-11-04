'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSettingsEnv, userDecision, REPO }: any = require('../helper/settings-fixtures.ts');
const { writeLayer }: any = require('../../src/runtime/settings/write.ts');
const { loadSettings }: any = require('../../src/runtime/settings/resolve.ts');

function sha256(file: any) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('writes schema first and owned keys in registry order, keeps foreign keys, and leaves legacy files byte-identical', (t: any) => {
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
  const renames: any = [];
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from: any, to: any) => { renames.push([from, to]); return fs.renameSync(from, to); };
  const result = writeLayer({
    file,
    set: { 'advice.enabled': true, 'advice.model': 'new-model', 'failure.capture': 'on' },
    fsImpl,
  });

  assert.equal(result.ok, true, result.detail);
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], file);
  assert.equal(path.dirname(renames[0][0]), path.dirname(file));
  // file modes are not expressible on Windows (a writable file reports 0o666)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
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

test('a no-op keeps the existing settings file byte-identical', (t: any) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = '{\n  "foreign": "kept",\n  "storage.prune": "off",\n  "schema": 1\n}\n';
  fs.writeFileSync(file, original);

  const result = writeLayer({ file, set: { 'storage.prune': 'off' } });

  assert.equal(result.ok, true, result.detail);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('writer reads the layer once and loads the registry through its injected file system', (t: any) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"schema":1,"storage.prune":"on"}\n');
  const reads: any = [];
  const fsImpl = Object.create(fs);
  fsImpl.readFileSync = (target: any, ...args: any[]) => {
    reads.push(path.resolve(target));
    return fs.readFileSync(target, ...args);
  };

  const result = writeLayer({ file, set: { 'storage.prune': 'off' }, fsImpl });

  assert.equal(result.ok, true, result.detail);
  assert.equal(reads.filter((target: any) => target === path.resolve(file)).length, 1, 'the settings layer is read once');
  assert.ok(reads.includes(path.join(REPO, 'core/registry/settings.json')), 'the injected fsImpl reads the registry');
});

test('writer creates a missing config-home directory with private permissions', (t: any) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  const directory = path.dirname(file);
  assert.equal(fs.existsSync(directory), false);

  const result = writeLayer({ file, set: { 'storage.prune': 'off' } });

  assert.equal(result.ok, true, result.detail);
  if (process.platform !== 'win32') assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
});

test('refuses an invalid settings file unless force is set', (t: any) => {
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

test('refuses with code too-large, writing nothing, when the file as written would be over the reader\'s limit (C-13)', (t: any) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  const { MAX_BYTES }: any = require('../../src/runtime/settings/files.ts');
  const pad = 'p'.repeat(MAX_BYTES - 1 - JSON.stringify({ schema: 1, 'x.pad': '' }).length);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ schema: 1, 'x.pad': pad })}\n`);
  assert.equal(fs.statSync(file).size, MAX_BYTES, 'the file on disk is exactly at the limit and reads');
  const before = fs.readFileSync(file);

  const result = writeLayer({ file, set: { 'storage.prune': 'off' } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'config-invalid');
  assert.equal(result.code, 'too-large');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'], 'no temporary or lock file is left');
});

test('writes through a symlinked user settings file, keeps the link and leaves no temporary file', (t: any) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  const dotfiles = path.join(f.dir, 'dotfiles');
  const target = path.join(dotfiles, 'doflow-settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(dotfiles, { recursive: true });
  fs.writeFileSync(target, '{\n  "schema": 1,\n  "storage.prune": "on"\n}\n');
  fs.symlinkSync(target, file);

  const result = writeLayer({ file, set: { 'storage.prune': 'off' } });

  assert.equal(result.ok, true, result.detail);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true, 'the link is kept');
  assert.equal(fs.realpathSync(file), fs.realpathSync(target));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schema: 1, 'storage.prune': 'off' });
  assert.deepEqual(fs.readdirSync(dotfiles), ['doflow-settings.json'], 'the temporary file was made in the target folder and renamed');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['settings.json']);
});

test('refuses a project settings file that is a symlink to a path outside the project, naming the file', (t: any) => {
  const f = createSettingsEnv(t);
  const projectDir = path.join(f.dir, 'proj');
  fs.mkdirSync(path.join(projectDir, '.doflow'), { recursive: true });
  const outside = path.join(f.dir, 'elsewhere.json');
  fs.writeFileSync(outside, '{"schema":1,"storage.prune":"on"}\n');
  const file = path.join(projectDir, '.doflow', 'settings.json');
  fs.symlinkSync(outside, file);
  const before = fs.readFileSync(outside);

  const result = writeLayer({ file, set: { 'storage.prune': 'off' }, backup: true });

  assert.equal(result.ok, false);
  assert.ok(result.detail.startsWith(file), result.detail);
  assert.match(result.detail, /outside the project/);
  assert.deepEqual(fs.readFileSync(outside), before);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, '.doflow')), ['settings.json'], 'no backup, lock or temporary file');
});

test('writes through a project settings symlink that stays inside the project', (t: any) => {
  const f = createSettingsEnv(t);
  const projectDir = path.join(f.dir, 'proj');
  fs.mkdirSync(path.join(projectDir, '.doflow'), { recursive: true });
  const inside = path.join(projectDir, 'shared-settings.json');
  fs.writeFileSync(inside, '{"schema":1,"storage.prune":"on"}\n');
  const file = path.join(projectDir, '.doflow', 'settings.json');
  fs.symlinkSync(inside, file);

  const result = writeLayer({ file, set: { 'storage.prune': 'off' } });

  assert.equal(result.ok, true, result.detail);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(inside, 'utf8'))['storage.prune'], 'off');
});

test('refuses a symlinked settings file whose target does not exist', (t: any) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(path.join(f.dir, 'missing.json'), file);

  const result = writeLayer({ file, set: { 'storage.prune': 'off' } });

  assert.equal(result.ok, false);
  assert.ok(result.detail.startsWith(file), result.detail);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(f.dir, 'missing.json')), false);
});

test('refuses to rewrite a file holding a number JSON cannot write back exactly, naming the key', (t: any) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = '{\n  "schema": 1,\n  "x.big": 12345678901234567890,\n  "x.nested": {"n": [1, 2.5, 9007199254740991]},\n  "storage.prune": "on"\n}\n';
  fs.writeFileSync(file, text);

  const refused = writeLayer({ file, set: { 'storage.prune': 'off' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'number-precision');
  assert.match(refused.detail, /'x\.big'/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);

  const safe = '{"schema":1,"x.nested":{"n":[1,2.5,9007199254740991,0.1]},"storage.prune":"on"}\n';
  fs.writeFileSync(file, safe);
  const ok = writeLayer({ file, set: { 'storage.prune': 'off' } });
  assert.equal(ok.ok, true, ok.detail);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['x.nested'].n, [1, 2.5, 9007199254740991, 0.1], 'safe integers and short floats still round-trip');
});

test('a failure --set with no config home keeps the existing no-home output and writes nothing', (t: any) => {
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

test('clears the resolver cache after writing', (t: any) => {
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

test('FU-84052t: refuses to write into a .doflow symlinked outside the project root', (t: any) => {
  const f = createSettingsEnv(t);
  const outside = path.join(f.dir, 'outside-folder');
  fs.mkdirSync(outside, { recursive: true });
  const projectDir = path.join(f.dir, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  const doflowDir = path.join(projectDir, '.doflow');
  fs.symlinkSync(outside, doflowDir);
  const file = path.join(doflowDir, 'settings.json');

  const result = writeLayer({ file, set: { 'storage.prune': 'off' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'scope');
  assert.match(result.detail, /\.doflow symlink points outside the project/);
  assert.equal(fs.existsSync(path.join(outside, 'settings.json')), false);
});

