'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO }: any = require('../helper/settings-fixtures.ts');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { writeLayer }: any = require('../../src/runtime/settings/write.ts');
const { loadSettings }: any = require('../../src/runtime/settings/resolve.ts');

test('writes schema first and owned keys in registry order, and keeps foreign keys', (t: any) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({
    'future.flag': 'preserve me',
    'storage.prune': 'off',
    'advice.model': 'old-model',
    'failure.capture': 'off',
  });

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
    ok: true, action: 'capture', effective: 'off', env: null, home: null,
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


// The layer lock: a stale lock is reclaimed, a live or unreadable owner's is not (src/runtime/settings/write.ts).
const HERE = os.hostname();
const DARWIN = process.platform === 'darwin';
function lockedLayer(t: any, content: string, ageSeconds = 0) {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, content);
  if (ageSeconds) { const at = (Date.now() / 1000) - ageSeconds; fs.utimesSync(lock, at, at); }
  return { file, lock };
}
const owner = (fields: any) => `${JSON.stringify({ host: HERE, start: null, id: 'x', ...fields })}\n`;
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
/** A live process other than this one: this pid with an id this process does not hold counts as a leftover of an earlier hold. */
function livePid(t: any) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  return child.pid;
}
const writeKey = (file: string, extra: any = {}) => writeLayer({ file, set: { 'storage.prune': 'off' }, ...extra });

test('a lock whose owner process is dead (ESRCH, this host) is reclaimed and the write goes through', (t: any) => {
  const { file, lock } = lockedLayer(t, owner({ pid: deadPid() }));
  const result = writeKey(file);
  assert.equal(result.ok, true, result.detail);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
});

test('a lock held by a live owner is refused as locked and left in place', (t: any) => {
  const { file, lock } = lockedLayer(t, owner({ pid: livePid(t) }));
  const result = writeKey(file);
  assert.equal(result.code, 'locked');
  assert.equal(fs.existsSync(lock), true);
});

test('a lock from another host is never judged by its pid, even a dead one, while young', (t: any) => {
  const { file, lock } = lockedLayer(t, owner({ pid: deadPid(), host: 'some-other-host' }));
  assert.equal(writeKey(file).code, 'locked');
  assert.equal(fs.existsSync(lock), true);
});

test('a lock whose owner cannot be told apart (no recorded start, a pid we may not signal) is refused while young', (t: any) => {
  const { file, lock } = lockedLayer(t, owner({ pid: 1 }));
  assert.equal(writeKey(file).code, 'locked');
  assert.equal(fs.existsSync(lock), true);
});

test('a lock older than ten minutes is reclaimed whatever its owner: live, other host, old format or empty', (t: any) => {
  for (const content of [owner({ pid: process.pid }), owner({ pid: 1, host: 'some-other-host' }), `${process.pid} deadbeefdeadbeef\n`, '']) {
    const { file } = lockedLayer(t, content, 3600);
    assert.equal(writeKey(file).ok, true, `content ${JSON.stringify(content)}`);
  }
});

test('an old-format or empty lock is refused while young', (t: any) => {
  for (const content of [`${process.pid} deadbeefdeadbeef\n`, '']) {
    const { file } = lockedLayer(t, content, 60);
    assert.equal(writeKey(file).code, 'locked');
  }
});

test('a live pid whose start time is not the recorded one (a reused pid) is reclaimed on darwin, and kept on a platform whose start time is not stable', (t: any) => {
  const { file } = lockedLayer(t, owner({ pid: livePid(t), start: 'Mon Jan  1 00:00:00 2001' }));
  const result = writeKey(file);
  if (DARWIN) assert.equal(result.ok, true, result.detail);
  else assert.equal(result.code, 'locked');
});

/**
 * Forced interleave, no timing: the reclaimer has judged a stale lock and is about to remove it; at that
 * exact call another writer replaces it with its own live lock. The reclaimer must leave that lock held.
 * `hook` runs once, before the first removal of the lock (`rmSync` of it, or `renameSync` of it aside).
 */
function reclaimerStalledBeforeRemoval(file: string, lock: string, hook: () => void) {
  let fired = false;
  const fire = (target: any) => { if (!fired && target === lock) { fired = true; hook(); } };
  const fsImpl = new Proxy(fs, { get(target: any, key: any) {
    if (key === 'rmSync') return (p: any, ...rest: any[]) => { fire(p); return target.rmSync(p, ...rest); };
    if (key === 'renameSync') return (from: any, to: any) => { fire(from); return target.renameSync(from, to); };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { result: writeKey(file, { fsImpl }), fired: () => fired };
}

test('a reclaimer that stalls after judging a lock stale does not remove the lock another writer took meanwhile', (t: any) => {
  const { file, lock } = lockedLayer(t, owner({ pid: deadPid() }));
  const fresh = owner({ pid: livePid(t), id: 'writer-b' });
  const { result, fired } = reclaimerStalledBeforeRemoval(file, lock, () => {
    fs.rmSync(lock); // writer B reclaims the stale lock and takes its own
    fs.writeFileSync(lock, fresh, { flag: 'wx' });
  });
  assert.equal(fired(), true, 'the interleave happened');
  assert.equal(result.code, 'locked', 'the stalled reclaimer waited for writer B instead of taking the lock');
  assert.equal(fs.readFileSync(lock, 'utf8'), fresh, "writer B's lock is intact");
  assert.equal(fs.existsSync(file), false, 'the stalled reclaimer wrote nothing');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json.lock'], 'no moved-aside file is left');
});

test('a moved-aside file left by a reclaimer that died is swept by age, a young one is kept', (t: any) => {
  const { file, lock } = lockedLayer(t, owner({ pid: deadPid() }));
  const old = `${lock}.4242.deadbeef.gone`, young = `${lock}.4243.deadbeef.gone`;
  fs.writeFileSync(old, 'x'); fs.writeFileSync(young, 'x');
  const at = (Date.now() / 1000) - 3600;
  fs.utimesSync(old, at, at);
  assert.equal(writeKey(file).ok, true);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(young), true);
});

test('a lock with this pid and an id this process does not hold (left by a release that missed it) is reclaimed at once', (t: any) => {
  const { file, lock } = lockedLayer(t, owner({ pid: process.pid, id: 'left-by-an-earlier-hold' }));
  const result = writeKey(file);
  assert.equal(result.ok, true, result.detail);
  assert.equal(fs.existsSync(lock), false);
});

test('a lock this process holds now is not taken for a leftover by a second writer in the same process', (t: any) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let inner: any = null;
  const fsImpl = new Proxy(fs, { get(target: any, key: any) {
    if (key === 'renameSync') return (from: any, to: any) => {
      if (!inner) inner = writeKey(file); // a second writer while the first is in its critical section
      return target.renameSync(from, to);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const outer = writeKey(file, { fsImpl });
  assert.equal(outer.ok, true, outer.detail);
  assert.equal(inner.code, 'locked', 'the held lock was waited for, not reclaimed');
});

test('a writer whose lock a reclaimer moved aside while it finished removes it when the reclaimer links it back', (t: any) => {
  const f = createSettingsEnv(t);
  const file = f.userFile('settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`, aside = `${lock}.4242.deadbeef.gone`;
  let reads = 0;
  // Reclaimer A, in the writer's release: first it has the lock moved aside, then (during the writer's retry) links it back.
  const fsImpl = new Proxy(fs, { get(target: any, key: any) {
    if (key === 'readFileSync') return (p: any, ...rest: any[]) => {
      if (p === lock) {
        reads += 1;
        if (reads === 1) target.renameSync(lock, aside);
        if (reads === 2) target.linkSync(aside, lock);
      }
      return target.readFileSync(p, ...rest);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = writeKey(file, { fsImpl });
  assert.equal(result.ok, true, result.detail);
  assert.equal(reads, 2, 'the release looked again once, and found the lock');
  if (fs.existsSync(aside)) fs.rmSync(aside);
  assert.equal(fs.existsSync(lock), false, 'no lock is left with nobody holding it');
  assert.equal(writeKey(file).ok, true, 'the next write is not refused');
});

test('a lock with no bytes is not the same lock as another with no bytes: a fresh empty one a reclaimer meets is left held', (t: any) => {
  const { file, lock } = lockedLayer(t, '', 3600);
  const { result, fired } = reclaimerStalledBeforeRemoval(file, lock, () => {
    fs.rmSync(lock); // another writer reclaims it and has opened its own lock but not written it yet
    fs.writeFileSync(lock, '', { flag: 'wx' });
  });
  assert.equal(fired(), true);
  assert.equal(result.code, 'locked');
  assert.equal(fs.existsSync(lock), true, 'the fresh empty lock is still there');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json.lock']);
});
