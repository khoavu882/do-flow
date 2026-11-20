'use strict';
const { bashPath } = require('../../helper/bash-locator.ts');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir } = require('../../helper/tmp.ts');
const registry = require('../../../core/registry/storage.json');
const engine = require('../../../src/runtime/storage/engine.ts');
const { RunLedger } = require('../../../src/runtime/trace/ledger.ts');
const { resolveRoots } = require('../../../src/runtime/storage/roots.ts');
const REPO = path.resolve(__dirname, '../../..');
const RUN = path.join(REPO, 'core/shared/scripts/doflow/bin/doflow-run');
const NOW = Date.parse('2026-10-10T12:00:00Z');
const DAY = 86400000;
const IGNORE = `${registry.settings.ignoreFile.lines.join('\n')}\n`;
const upkeep = () => require('../../../src/runtime/storage/upkeep.ts');

function fixture(t: any, rootIds: any = ['project-state']) {
  const dir = tempDir(t, 'doflow-upkeep-');
  const projectRoot = path.join(dir, 'project');
  const env: any = { ...process.env, HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  delete env.DOFLOW_RETENTION_HOURS;
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(env.HOME);
  fs.mkdirSync(env.XDG_CONFIG_HOME);
  const roots = resolveRoots({ registry, projectRoot, env });
  rootIds.forEach((id: any) => fs.mkdirSync(roots[id], { recursive: true }));
  return { dir, roots, projectRoot, env, now: NOW };
}
const PRUNE_OFF = '{"schema":1,"storage.prune":"off"}\n';
const PRUNE_ON = '{"schema":1,"storage.prune":"on"}\n';
function put(dir: any, name: any, text: any = '{}', age: any = 0) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(NOW - age * DAY), new Date(NOW - age * DAY));
  return file;
}
function spyFs(overrides: any) {
  return new Proxy(fs, { get(target, key) {
    if (overrides[key]) return overrides[key];
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function records(root: any) {
  const dir = path.join(root, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name: any) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .flatMap((name: any) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
function capture(fn: any): any {
  const out: any = [], err: any = [];
  const log = console.log, error = console.error, exitCode = process.exitCode;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try { fn(); return { out, err, exitCode: process.exitCode }; }
  finally { console.log = log; console.error = error; process.exitCode = exitCode; }
}

for (const marker of [null, 'unreadable', '-1\n', `${NOW / 1000 - 1}\n`, `${NOW / 1000}\n`, 'nonsense\n']) {
  test(`IC-015: ${marker === null ? 'missing' : marker.trim()} marker is due`, t => {
    const f = fixture(t), root = f.roots['project-state'];
    const log = put(path.join(root, 'verification/logs'), `${NOW - 31 * DAY}-expired.log`, 'log');
    const markerFile = path.join(root, 'upkeep-due');
    if (marker !== null) fs.writeFileSync(markerFile, marker);
    const fsImpl = spyFs({ readFileSync(file: any, ...args: any[]) {
      if (marker === 'unreadable' && file === markerFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.readFileSync(file, ...args);
    } });
    upkeep().upkeepAfterVerb({ ...f, fsImpl });
    assert.equal(fs.existsSync(log), false);
    assert.equal(fs.readFileSync(markerFile, 'utf8'), `${NOW / 1000 + registry.settings.upkeepIntervalHours * 3600}\n`);
    assert.equal(fs.existsSync(path.join(root, 'upkeep.lock')), false);
    assert.equal(records(root).length, 1);
  });
}

test('IC-015: atomic marker is in place under the lock before the pass; partial rewrites it to now', t => {
  const f = fixture(t), root = f.roots['project-state'];
  const writes: any = [], renames: any = [];
  const fsImpl = spyFs({
    writeFileSync(file: any, ...args: any[]) { writes.push(file); return fs.writeFileSync(file, ...args); },
    renameSync(from: any, to: any) { renames.push([from, to]); return fs.renameSync(from, to); },
  });
  t.mock.method(engine, 'runPass', (options: any) => {
    assert.equal(options.mode, 'prune');
    assert.equal(fs.existsSync(path.join(root, 'upkeep.lock')), true);
    assert.equal(fs.readFileSync(path.join(root, 'upkeep-due'), 'utf8'), `${NOW / 1000 + 86400}\n`);
    return { partial: true, durationMs: 1, stores: [] };
  });
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  const marker = path.join(root, 'upkeep-due');
  assert.equal(fs.readFileSync(marker, 'utf8'), `${NOW / 1000}\n`);
  assert.equal(renames.filter(([, to]: any) => to === marker).length, 2);
  for (const [from, to] of renames) {
    assert.equal(path.dirname(from), path.dirname(to));
    assert.notEqual(from, to);
    assert.ok(writes.includes(from));
    assert.equal(fs.existsSync(from), false);
  }
  assert.equal(writes.includes(marker), false);
  assert.equal(records(root)[0].outcome, 'partial');
});

for (const stale of [false, true]) {
  test(`IC-015: ${stale ? 'stale lock is removed but this pass skips' : 'held lock skips'}`, t => {
    const f = fixture(t), root = f.roots['project-state'], lock = path.join(root, 'upkeep.lock');
    fs.mkdirSync(lock);
    fs.utimesSync(lock, new Date(NOW - (stale ? registry.settings.passLockStaleSeconds + 1 : 1) * 1000), new Date(NOW - (stale ? registry.settings.passLockStaleSeconds + 1 : 1) * 1000));
    const log = put(path.join(root, 'verification/logs'), `${NOW - 31 * DAY}-expired.log`);
    upkeep().upkeepAfterVerb(f);
    assert.equal(fs.existsSync(log), true);
    assert.equal(fs.existsSync(lock), !stale);
    assert.equal(fs.existsSync(path.join(root, 'upkeep-due')), false);
    assert.deepEqual(records(root), []);
  });
}

test('IC-014/016: off writes exact atomic ignore bytes but no marker, lock or pass', t => {
  const f = fixture(t, ['project-state', 'user-state', 'config-home']);
  put(f.roots['config-home'], 'settings.json', PRUNE_OFF);
  const commits: any = [];
  upkeep().upkeepAfterVerb({ ...f, fsImpl: spyFs({
    renameSync(from: any, to: any) { commits.push([from, to]); return fs.renameSync(from, to); },
    linkSync(from: any, to: any) { commits.push([from, to]); return fs.linkSync(from, to); },
  }) });
  for (const id of ['project-state', 'user-state']) assert.equal(fs.readFileSync(path.join(f.roots[id], '.gitignore'), 'utf8'), IGNORE);
  for (const id of ['project-state', 'user-state', 'config-home']) {
    assert.equal(fs.existsSync(path.join(f.roots[id], 'upkeep-due')), false);
    assert.equal(fs.existsSync(path.join(f.roots[id], 'upkeep.lock')), false);
  }
  assert.equal(commits.filter(([from, to]: any) => path.basename(to) === '.gitignore' && path.dirname(from) === path.dirname(to)).length, 2);
  assert.deepEqual(records(f.roots['project-state']), []);
  assert.deepEqual(records(f.roots['user-state']), []);
});

test('IC-016: absent state folders are never created, and existing ignore bytes/mtime are never overwritten', t => {
  const f = fixture(t, []);
  upkeep().upkeepAfterVerb(f);
  assert.equal(fs.existsSync(f.roots['project-state']), false);
  assert.equal(fs.existsSync(f.roots['user-state']), false);
  fs.mkdirSync(f.roots['project-state'], { recursive: true });
  const ignore = put(f.roots['project-state'], '.gitignore', 'user-managed\n', 1);
  const mtime = fs.statSync(ignore).mtimeMs;
  const other = put(f.roots['project-state'], 'unrelated', 'leave me');
  upkeep().upkeepAfterVerb(f);
  assert.equal(fs.readFileSync(ignore, 'utf8'), 'user-managed\n');
  assert.equal(fs.statSync(ignore).mtimeMs, mtime);
  assert.equal(fs.readFileSync(other, 'utf8'), 'leave me');
  assert.equal(fs.existsSync(f.roots['user-state']), false);
});

test('IC-017: one append per newly created project ignore; user pass rewrites duplicates and gone roots atomically', t => {
  const f = fixture(t, ['project-state', 'user-state', 'config-home']);
  put(f.roots['config-home'], 'settings.json', PRUNE_OFF);
  const index = path.join(f.roots['user-state'], 'upkeep-roots'), appends: any = [], renames: any = [];
  const fsImpl = spyFs({
    appendFileSync(file: any, ...args: any[]) { if (file === index) appends.push(args[0]); return fs.appendFileSync(file, ...args); },
    renameSync(from: any, to: any) { renames.push([from, to]); return fs.renameSync(from, to); },
  });
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  assert.deepEqual(appends, [`${fs.realpathSync(f.projectRoot)}\n`]);
  const gone = path.join(f.dir, 'gone');
  fs.writeFileSync(index, `${f.projectRoot}\n${f.projectRoot}\n${gone}\n`);
  put(f.roots['config-home'], 'settings.json', PRUNE_ON);
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  assert.equal(fs.readFileSync(index, 'utf8'), `${f.projectRoot}\n`);
  assert.ok(renames.some(([from, to]: any) => to === index && from !== index));
});

test('IC-017: a project registered while the user pass is between reading and replacing the roots index is not lost', async t => {
  const f = fixture(t, ['project-state', 'user-state', 'config-home']);
  const index = path.join(f.roots['user-state'], 'upkeep-roots');
  const gone = path.join(f.dir, 'gone');
  fs.writeFileSync(index, `${gone}\n`);
  const other = path.join(f.dir, 'other');
  fs.mkdirSync(path.join(other, '.doflow/state'), { recursive: true });
  const signal = path.join(f.dir, 'child-is-at-the-index-lock');
  // The child reports through its fs the first time it finds the index lock taken, that is, once it is at the append.
  const script = `const fs = require('node:fs');
let told = false;
const fsImpl = new Proxy(fs, { get(target, key) {
  if (key === 'mkdirSync') return (p, ...rest) => { try { return target.mkdirSync(p, ...rest); } catch (error) { if (!told && String(p).endsWith('upkeep-roots.lock') && error.code === 'EEXIST') { told = true; target.writeFileSync(${JSON.stringify(signal)}, '1'); } throw error; } };
  const value = target[key];
  return typeof value === 'function' ? value.bind(target) : value;
} });
require(${JSON.stringify(path.join(REPO, 'src/runtime/storage/upkeep.ts'))}).upkeepAfterVerb({ projectRoot: ${JSON.stringify(other)}, now: ${NOW}, fsImpl });`;
  let child: any;
  const fsImpl = spyFs({
    renameSync(from: any, to: any) {
      if (to === index && !child) {
        // The pass has read the index. Start the registering process and hold the replace back until it reports
        // it is at the append (never on a clock); without the lock it never reports, so the wait is capped.
        child = spawn(process.execPath, ['-e', script], { env: f.env, stdio: 'ignore' });
        const until = Date.now() + 5000;
        while (!fs.existsSync(signal) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return fs.renameSync(from, to);
    },
  });
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  assert.ok(child, 'the index was replaced');
  assert.equal(fs.existsSync(signal), true, 'the registering process was held at the index lock while the pass replaced the index');
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
  const lines = fs.readFileSync(index, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.includes(fs.realpathSync(other)), 'the concurrent registration survived the replace');
  assert.ok(lines.includes(fs.realpathSync(f.projectRoot)));
  assert.ok(!lines.includes(gone), 'the gone root was dropped');
  assert.equal(fs.existsSync(path.join(f.roots['user-state'], 'upkeep-roots.lock')), false, 'the index lock is released');
});

/** A stale lock directory whose first removal (rmdir of it, or a rename of it aside) finds another process's fresh lock in its place. */
function staleLockTakenOverAtRemoval(lock: any) {
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - (registry.settings.passLockStaleSeconds + 10) * 1000);
  fs.utimesSync(lock, old, old);
  let fired = false;
  const swap = () => { if (fired) return; fired = true; fs.rmdirSync(lock); fs.mkdirSync(lock); };
  const fsImpl = spyFs({
    rmdirSync(p: any) { if (p === lock) swap(); return fs.rmdirSync(p); },
    renameSync(from: any, to: any) { if (from === lock) swap(); return fs.renameSync(from, to); },
  });
  return { fsImpl, fired: () => fired };
}

test('IC-017: the roots-index lock another process took while this one was removing a stale one is not removed', t => {
  const f = fixture(t, ['project-state', 'user-state', 'config-home']);
  put(f.roots['config-home'], 'settings.json', PRUNE_OFF);
  const lock = path.join(f.roots['user-state'], 'upkeep-roots.lock');
  const { fsImpl, fired } = staleLockTakenOverAtRemoval(lock);
  upkeep().upkeepAfterVerb({ ...f, now: Date.now(), fsImpl });
  assert.equal(fired(), true);
  assert.equal(fs.statSync(lock).isDirectory(), true, 'the fresh lock is still held');
  assert.ok(Date.now() - fs.statSync(lock).mtimeMs < 60_000, 'it is the fresh one');
  assert.equal(fs.existsSync(path.join(f.roots['user-state'], 'upkeep-roots')), false, 'no append ran inside a lock it did not hold');
  assert.deepEqual(fs.readdirSync(f.roots['user-state']).filter((name: any) => name.endsWith('.gone')), []);
});

test('IC-015: the pass lock another process took while this one was removing a stale one is not removed', t => {
  const f = fixture(t, ['project-state']);
  const lock = path.join(f.roots['project-state'], 'upkeep.lock');
  const { fsImpl, fired } = staleLockTakenOverAtRemoval(lock);
  upkeep().upkeepAfterVerb({ ...f, now: Date.now(), fsImpl });
  assert.equal(fired(), true);
  assert.equal(fs.statSync(lock).isDirectory(), true, 'the fresh lock is still held');
  assert.ok(Date.now() - fs.statSync(lock).mtimeMs < 60_000, 'it is the fresh one');
  assert.deepEqual(fs.readdirSync(f.roots['project-state']).filter((name: any) => name.endsWith('.gone')), []);
});

test('IC-017: a stale index lock is removed, and a moved-aside directory a dead process left is swept by age', t => {
  const f = fixture(t, ['project-state', 'user-state']);
  const lock = path.join(f.roots['user-state'], 'upkeep-roots.lock');
  const left = `${lock}.4242.deadbeef.gone`;
  const old = new Date(Date.now() - (registry.settings.passLockStaleSeconds + 10) * 1000);
  for (const dir of [lock, left]) { fs.mkdirSync(dir); fs.utimesSync(dir, old, old); }
  upkeep().upkeepAfterVerb({ ...f, now: Date.now() });
  assert.equal(fs.readFileSync(path.join(f.roots['user-state'], 'upkeep-roots'), 'utf8'), `${fs.realpathSync(f.projectRoot)}\n`);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(left), false);
});

test('IC-019: project uninstall that cannot take the index lock says so once and names the project; global uninstall removes a left-over index lock', t => {
  const f = fixture(t, ['project-state', 'user-state']);
  const index = path.join(f.roots['user-state'], 'upkeep-roots');
  const lock = path.join(f.roots['user-state'], 'upkeep-roots.lock');
  fs.writeFileSync(index, `${fs.realpathSync(f.projectRoot)}\n`);
  fs.mkdirSync(lock);
  const said = capture(() => upkeep().storageForgetScope({ scope: 'project', scopeRoot: f.projectRoot, env: f.env }));
  assert.equal(said.err.length, 1);
  assert.ok(said.err[0].includes(fs.realpathSync(f.projectRoot)) && /was held for 2 s/.test(said.err[0]) && /stays in the upkeep index until/.test(said.err[0]) && !/next upkeep pass removes/.test(said.err[0]), said.err[0]);
  assert.equal(fs.readFileSync(index, 'utf8'), `${fs.realpathSync(f.projectRoot)}\n`, 'the index was left alone');
  capture(() => upkeep().storageForgetScope({ scope: 'global', scopeRoot: f.env.HOME, env: f.env }));
  assert.equal(fs.existsSync(lock), false);
});

test('IC-019: project uninstall reports a lock that could not be created for what it is, not as busy', t => {
  const f = fixture(t, ['project-state', 'user-state']);
  const index = path.join(f.roots['user-state'], 'upkeep-roots');
  fs.writeFileSync(index, `${fs.realpathSync(f.projectRoot)}\n`);
  const fsImpl = spyFs({ mkdirSync(p: any, ...rest: any[]) {
    if (String(p).endsWith('upkeep-roots.lock')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.mkdirSync(p, ...rest);
  } });
  const said = capture(() => upkeep().storageForgetScope({ scope: 'project', scopeRoot: f.projectRoot, env: f.env, fsImpl }));
  assert.equal(said.err.length, 1);
  assert.ok(/EACCES/.test(said.err[0]) && !/was held/.test(said.err[0]), said.err[0]);
});

test('IC-019: global uninstall removes the moved-aside lock names it owns and prints each path', t => {
  const f = fixture(t, ['project-state', 'user-state', 'config-home']);
  const aside = [
    path.join(f.roots['user-state'], 'upkeep-roots.lock.4242.deadbeef.gone'),
    path.join(f.roots['user-state'], 'upkeep.lock.4242.deadbeef.gone'),
  ];
  const file = path.join(f.roots['config-home'], 'settings.json.lock.4242.deadbeef.gone');
  const keep = path.join(f.roots['config-home'], 'settings.json.lock.4242.notmine.gone');
  aside.forEach((dir) => fs.mkdirSync(dir));
  fs.writeFileSync(file, 'x'); fs.writeFileSync(keep, 'x');
  const said = capture(() => upkeep().storageForgetScope({ scope: 'global', scopeRoot: f.env.HOME, env: f.env }));
  for (const gone of [...aside, file]) {
    assert.equal(fs.existsSync(gone), false, gone);
    assert.ok(said.out.some((line: any) => line.includes(gone)), `${gone} is printed`);
  }
  assert.equal(fs.existsSync(keep), true, 'a name that is not one of ours is left');
});

test('IC-017/IC-019: a project first seen before user state existed is indexed by its next pass and cleaned by global uninstall (G.1)', t => {
  const f = fixture(t, ['project-state']);
  upkeep().upkeepAfterVerb(f);
  assert.equal(fs.readFileSync(path.join(f.roots['project-state'], '.gitignore'), 'utf8'), IGNORE);
  const index = path.join(f.roots['user-state'], 'upkeep-roots');
  assert.equal(fs.existsSync(index), false);
  fs.mkdirSync(f.roots['user-state'], { recursive: true });
  upkeep().upkeepAfterVerb({ ...f, now: NOW + 2 * DAY });
  assert.equal(fs.readFileSync(index, 'utf8'), `${fs.realpathSync(f.projectRoot)}\n`);
  upkeep().upkeepAfterVerb({ ...f, now: NOW + 4 * DAY });
  assert.equal(fs.readFileSync(index, 'utf8'), `${fs.realpathSync(f.projectRoot)}\n`, 'registered once');
  capture(() => upkeep().storageForgetScope({ scope: 'global', scopeRoot: f.env.HOME, env: f.env }));
  assert.equal(fs.existsSync(path.join(f.roots['project-state'], '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(f.roots['project-state'], 'upkeep-due')), false);
});

test('IC-008: exactly one metadata-only ledger append per root pass, config-home uses the user ledger', t => {
  const f = fixture(t, ['project-state', 'user-state', 'config-home']);
  const events: any = [], original = RunLedger.prototype.append;
  t.mock.method(RunLedger.prototype, 'append', function(this: any, event: any) { events.push({ dir: this.dir, event }); return original.call(this, event); });
  upkeep().upkeepAfterVerb(f);
  assert.equal(events.length, 3);
  events.forEach(({ event }: any) => {
    assert.deepEqual(Object.keys(event).sort(), ['duration_ms', 'kind', 'outcome', 'verb']);
    assert.equal(event.verb, 'storage'); assert.equal(event.kind, 'upkeep'); assert.equal(event.outcome, 'ok');
    assert.ok(event.duration_ms >= 0);
  });
  assert.equal(records(f.roots['project-state']).length, 1);
  assert.equal(records(f.roots['user-state']).length, 2);
  assert.equal(fs.existsSync(path.join(f.roots['config-home'], 'state/runs')), false);
});

test('IC-009: not due costs at most three reads and two existsSync calls, no enumeration/writes', t => {
  const f = fixture(t, ['project-state', 'user-state', 'config-home']);
  for (const id of ['project-state', 'user-state']) put(f.roots[id], '.gitignore', IGNORE);
  for (const id of ['project-state', 'user-state', 'config-home']) put(f.roots[id], 'upkeep-due', `${NOW / 1000 + 1}\n`);
  let reads = 0, exists = 0;
  upkeep().upkeepAfterVerb({ ...f, fsImpl: spyFs({
    readFileSync(...args: any[]) { reads++; return fs.readFileSync(...args); },
    existsSync(...args: any[]) { exists++; return fs.existsSync(...args); },
    readdirSync() { assert.fail('not-due call enumerated a store'); },
    writeFileSync() { assert.fail('not-due call wrote a file'); },
    mkdirSync() { assert.fail('not-due call took a lock'); },
  }) });
  assert.ok(reads <= 3, `${reads} reads`);
  assert.ok(exists <= 2, `${exists} existsSync calls`);
});

test('IC-008: all automatic functions swallow filesystem/pass errors, stay silent and restore exitCode', t => {
  const f = fixture(t);
  const broken = spyFs({ lstatSync() { process.exitCode = 99; throw new Error('failure'); } });
  const previous = process.exitCode;
  process.exitCode = 7;
  try {
    const result = capture(() => {
      upkeep().upkeepAfterVerb({ ...f, fsImpl: broken });
      upkeep().upkeepAfterVerify({ ...f, fsImpl: broken });
      upkeep().storageAfterInstall({ scope: 'project', scopeRoot: f.projectRoot, env: f.env, fsImpl: broken });
    });
    assert.deepEqual(result, { out: [], err: [], exitCode: 7 });
    t.mock.method(engine, 'runPass', () => { process.exitCode = 42; throw new Error('engine failure'); });
    assert.deepEqual(capture(() => upkeep().upkeepAfterVerb(f)), { out: [], err: [], exitCode: 7 });
    assert.equal(records(f.roots['project-state'])[0].outcome, 'error');
    assert.equal(fs.existsSync(path.join(f.roots['project-state'], 'upkeep.lock')), false);
  } finally { process.exitCode = previous; }
});

test('IC-010: verify is unthrottled, locked and restricted to project verification logs and reuse', t => {
  const f = fixture(t), root = f.roots['project-state'];
  const log = put(path.join(root, 'verification/logs'), `${NOW - 31 * DAY}-old.log`);
  const work = put(path.join(root, 'research'), 'finished.json', '{}', 31);
  const marker = put(root, 'upkeep-due', `${NOW / 1000 + 86400}\n`);
  const original = engine.runPass, calls: any = [];
  t.mock.method(engine, 'runPass', (options: any) => { calls.push(options.stores); assert.ok(fs.existsSync(path.join(root, 'upkeep.lock'))); return original(options); });
  upkeep().upkeepAfterVerify(f);
  assert.deepEqual(calls, [['verification-logs', 'verification-reuse']]);
  assert.equal(fs.existsSync(log), false); assert.equal(fs.existsSync(work), true);
  assert.equal(fs.readFileSync(marker, 'utf8'), `${NOW / 1000 + 86400}\n`);
  put(f.roots['project-doflow'], 'settings.json', PRUNE_OFF);
  const kept = put(path.join(root, 'verification/logs'), `${NOW - 32 * DAY}-off.log`);
  upkeep().upkeepAfterVerify(f);
  assert.equal(fs.existsSync(kept), true);
  assert.equal(calls.length, 1);
});

for (const scope of ['project', 'global']) {
  test(`IC-011: ${scope} install prunes only its recovery store and writes the scope ignore file`, t => {
    const f = fixture(t, ['project-state', 'user-state']);
    const names = Array.from({ length: 5 }, (_, i) => `recovery_2026-01-0${i + 1}T00-00-00-000Z_a.json`);
    for (const id of ['project-state', 'user-state']) {
      names.forEach(name => put(path.join(f.roots[id], 'recovery'), name));
      put(f.roots[id], 'ledger.json', JSON.stringify({ lastRecoveryId: names[0].slice(0, -5) }));
    }
    const work = put(path.join(f.roots['project-state'], 'research'), 'old.json', '{}', 31);
    upkeep().storageAfterInstall({ scope, scopeRoot: scope === 'project' ? f.projectRoot : f.env.HOME, env: f.env, now: NOW });
    const target = scope === 'project' ? 'project-state' : 'user-state';
    assert.equal(fs.readdirSync(path.join(f.roots[target], 'recovery')).length, 4);
    assert.equal(fs.readdirSync(path.join(f.roots[scope === 'project' ? 'user-state' : 'project-state'], 'recovery')).length, 5);
    assert.equal(fs.readFileSync(path.join(f.roots[target], '.gitignore'), 'utf8'), IGNORE);
    assert.equal(fs.existsSync(work), true);
    assert.equal(fs.existsSync(path.join(f.roots[target], 'upkeep-due')), false);
    if (scope === 'project') assert.equal(fs.readFileSync(path.join(f.roots['user-state'], 'upkeep-roots'), 'utf8'), `${f.projectRoot}\n`);
  });
}

function controls(root: any, ignore: any = IGNORE) {
  put(root, '.gitignore', ignore); put(root, 'upkeep-due', '1\n');
  fs.mkdirSync(path.join(root, 'upkeep.lock')); put(root, 'keep.json', 'state');
}
test('IC-019: forgetting project removes only owned controls/index line and leaves settings/state', t => {
  const f = fixture(t, ['project-state', 'user-state']);
  controls(f.roots['project-state']);
  put(f.roots['project-doflow'], 'settings.json', PRUNE_OFF); put(f.roots['project-doflow'], 'prompt-nudge', 'on\n');
  const index = put(f.roots['user-state'], 'upkeep-roots', `${f.projectRoot}\n${f.env.HOME}\n`);
  const result = capture(() => upkeep().storageForgetScope({ scope: 'project', scopeRoot: f.projectRoot, env: f.env }));
  assert.deepEqual(result.out, ['[INFO] Storage: removed 3 DoFlow control file(s)']);
  assert.deepEqual(result.err, []);
  assert.equal(fs.readFileSync(index, 'utf8'), `${f.env.HOME}\n`);
  assert.deepEqual(fs.readdirSync(f.roots['project-state']), ['keep.json']);
  assert.equal(fs.readFileSync(path.join(f.roots['project-doflow'], 'settings.json'), 'utf8'), PRUNE_OFF);
  assert.equal(fs.readFileSync(path.join(f.roots['project-doflow'], 'prompt-nudge'), 'utf8'), 'on\n');
  controls(f.roots['project-state'], 'custom\n');
  capture(() => upkeep().storageForgetScope({ scope: 'project', scopeRoot: f.projectRoot, env: f.env }));
  assert.equal(fs.readFileSync(path.join(f.roots['project-state'], '.gitignore'), 'utf8'), 'custom\n');
});

test('IC-019: forgetting global preserves installed projects, cleans departed roots and user controls only', t => {
  const f = fixture(t, ['project-state', 'user-state', 'config-home']);
  const installed = path.join(f.dir, 'installed'), installedState = path.join(installed, '.doflow/state');
  controls(f.roots['project-state']); controls(installedState); controls(f.roots['user-state']);
  put(path.join(installed, '.doflow'), 'doflow.lock', '{}');
  put(f.roots['config-home'], 'upkeep-due', '1\n'); fs.mkdirSync(path.join(f.roots['config-home'], 'upkeep.lock'));
  put(f.roots['config-home'], 'settings.json', PRUNE_OFF); put(f.roots['config-home'], 'prompt-nudge', 'on\n');
  put(f.roots['user-state'], 'upkeep-roots', `${f.projectRoot}\n${installed}\n`);
  const result = capture(() => upkeep().storageForgetScope({ scope: 'global', scopeRoot: f.env.HOME, env: f.env }));
  assert.deepEqual(result.out, ['[INFO] Storage: removed 9 DoFlow control file(s)']);
  assert.deepEqual(result.err, []);
  assert.deepEqual(fs.readdirSync(f.roots['project-state']), ['keep.json']);
  assert.deepEqual(fs.readdirSync(f.roots['user-state']), ['keep.json']);
  assert.equal(fs.readFileSync(path.join(installedState, '.gitignore'), 'utf8'), IGNORE);
  assert.equal(fs.existsSync(path.join(installedState, 'upkeep.lock')), true);
  assert.deepEqual(fs.readdirSync(f.roots['config-home']).sort(), ['prompt-nudge', 'settings.json']);
});

for (const scope of ['project', 'global']) {
  test(`IC-019: no info line when ${scope} scope has no controls`, t => {
    const f = fixture(t, ['project-state', 'user-state', 'config-home']);
    const scopeRoot = scope === 'project' ? f.projectRoot : f.env.HOME;
    const result = capture(() => upkeep().storageForgetScope({ scope, scopeRoot, env: f.env }));
    assert.deepEqual(result.out, []);
    assert.deepEqual(result.err, []);
    assert.equal(result.exitCode, process.exitCode);
  });
}

test('IC-019: one warning per failed control removal, no exit-status change', t => {
  const f = fixture(t); controls(f.roots['project-state']);
  const fsImpl = spyFs({ unlinkSync(file: any) { if (path.basename(file) === 'upkeep-due') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.unlinkSync(file); } });
  const result = capture(() => upkeep().storageForgetScope({ scope: 'project', scopeRoot: f.projectRoot, env: f.env, fsImpl }));
  assert.equal(result.err.length, 1); assert.match(result.err[0], /^\[WARN\].*upkeep-due.*EACCES/);
  assert.equal(result.exitCode, process.exitCode);
  assert.equal(fs.existsSync(path.join(f.roots['project-state'], 'upkeep-due')), true);
});

test('IC-008: expired entry under read-only parent stays; triggering verb equals prune-off bytes/status', {
  skip: process.platform === 'win32' || typeof process.getuid === 'function' && process.getuid() === 0,
}, t => {
  const f = fixture(t, ['project-state', 'config-home']);
  const logDir = path.join(f.roots['project-state'], 'verification/logs');
  const log = put(logDir, `${Date.now() - 31 * DAY}-expired.log`);
  const run = () => spawnSync(bashPath(), [RUN, 'evidence', '--action', 'list', '--task-id', 'idle', '--json'], {
    cwd: f.projectRoot, env: { ...f.env, DOFLOW_CLI: path.join(REPO, 'bin/doflow.js'), DOFLOW_CONFIG_DIR: f.roots['project-doflow'] }, encoding: 'utf8',
  });
  put(f.roots['config-home'], 'settings.json', PRUNE_OFF);
  const off = run(); assert.equal(off.status, 0, off.stderr);
  put(f.roots['config-home'], 'settings.json', PRUNE_ON);
  fs.chmodSync(logDir, 0o555);
  try {
    const on = run();
    assert.deepEqual([on.stdout, on.stderr, on.status], [off.stdout, off.stderr, off.status]);
    assert.equal(fs.existsSync(log), true);
    assert.equal(records(f.roots['project-state']).filter((r: any) => r.kind === 'upkeep').at(-1).outcome, 'error');
  } finally { fs.chmodSync(logDir, 0o755); }
});

test('IC-015 (G.3 A1): an unreadable lifecycle event fails the pass without stopping it; the marker advances normally', t => {
  const f = fixture(t), root = f.roots['project-state'];
  put(path.join(root, 'lifecycle/events'), '20260101T000000000Z-abcdef.json', '{not json');
  upkeep().upkeepAfterVerb(f);
  assert.equal(fs.readFileSync(path.join(root, 'upkeep-due'), 'utf8'), `${NOW / 1000 + registry.settings.upkeepIntervalHours * 3600}\n`);
  assert.deepEqual(records(root).map((record: any) => record.outcome), ['error']);
  const result = engine.runPass({ registry, roots: f.roots, stores: ['lifecycle-events'], mode: 'prune', setting: { 'project-state': 'on' }, now: NOW, env: f.env });
  assert.equal(result.partial, false);
  assert.deepEqual(result.stores[0].failed, [{ name: 'lifecycle-events', code: 'EIO' }]);
});

test('IC-016 (G.3 A5): an ignore file created between the check and the commit is never overwritten', t => {
  const f = fixture(t), root = f.roots['project-state'], ignore = path.join(root, '.gitignore');
  let raced = 0;
  const race = (to: any) => { if (to === ignore && !fs.existsSync(ignore)) { fs.writeFileSync(ignore, 'user-managed\n'); raced++; } };
  const fsImpl = spyFs({
    renameSync(from: any, to: any) { race(to); return fs.renameSync(from, to); },
    linkSync(from: any, to: any) { race(to); return fs.linkSync(from, to); },
  });
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  assert.equal(raced, 1, 'the commit step was reached');
  assert.equal(fs.readFileSync(ignore, 'utf8'), 'user-managed\n');
  assert.deepEqual(fs.readdirSync(root).filter((name: any) => name.endsWith('.tmp')), [], 'the temp file is removed');
});

test('N2: upkeepAfterVerb({projectRoot:<W>}) when due writes upkeep-due, .gitignore, ledger line under <P>/.doflow/state, and upkeep-roots lists <P> not <W>', (t) => {
  const dir = tempDir(t, 'doflow-upkeep-n2-');
  const P = path.join(dir, 'project');
  const W = path.join(P, '.doflow', 'state', 'dispatch-worktrees', 'd-000000000001');
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(P, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg };
  delete env.DOFLOW_RETENTION_HOURS;
  delete env.DOFLOW_CONFIG_DIR;

  fs.mkdirSync(path.join(P, '.doflow', 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(W, '.doflow', 'state', 'delivery'), { recursive: true });
  fs.writeFileSync(path.join(W, '.doflow', 'state', 'delivery', 'A.1.json'), '{}');

  const roots = resolveRoots({ registry, projectRoot: P, env });
  fs.mkdirSync(roots['user-state'], { recursive: true });

  upkeep().upkeepAfterVerb({ projectRoot: W, now: NOW, env });

  assert.equal(fs.existsSync(path.join(P, '.doflow', 'state', 'upkeep-due')), true, 'upkeep-due written under <P>');
  assert.equal(fs.existsSync(path.join(P, '.doflow', 'state', '.gitignore')), true, '.gitignore written under <P>');
  assert.ok(records(path.join(P, '.doflow', 'state')).filter((r: any) => r.kind === 'upkeep').length >= 1, 'ledger line under <P>');

  assert.equal(fs.existsSync(path.join(W, '.doflow', 'state', 'upkeep-due')), false, 'no upkeep-due under <W>');
  assert.equal(fs.existsSync(path.join(W, '.doflow', 'state', '.gitignore')), false, 'no .gitignore under <W>');
  assert.equal(records(path.join(W, '.doflow', 'state')).length, 0, 'no ledger line under <W>');

  const indexFile = path.join(roots['user-state'], 'upkeep-roots');
  assert.equal(fs.existsSync(indexFile), true, 'upkeep-roots index exists');
  const indexed = fs.readFileSync(indexFile, 'utf8');
  assert.ok(indexed.includes(fs.realpathSync(P)), 'upkeep-roots lists <P>');
  assert.ok(!indexed.includes(W), 'upkeep-roots does not list <W>');
});

test('F2: upkeepAfterVerify({projectRoot:<W>}) writes ledger line under <P>/.doflow/state and upkeep-roots lists <P> not <W>', (t) => {
  const dir = tempDir(t, 'doflow-upkeep-f2-');
  const P = path.join(dir, 'project');
  const W = path.join(P, '.doflow', 'state', 'dispatch-worktrees', 'd-000000000001');
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(P, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg };
  delete env.DOFLOW_RETENTION_HOURS;
  delete env.DOFLOW_CONFIG_DIR;

  fs.mkdirSync(path.join(P, '.doflow', 'state', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(P, '.doflow', 'state', '.gitignore'), IGNORE);
  fs.mkdirSync(path.join(W, '.doflow', 'state', 'delivery'), { recursive: true });
  fs.writeFileSync(path.join(W, '.doflow', 'state', 'delivery', 'A.1.json'), '{}');

  const roots = resolveRoots({ registry, projectRoot: P, env });
  fs.mkdirSync(roots['user-state'], { recursive: true });

  upkeep().upkeepAfterVerify({ projectRoot: W, now: NOW, env });

  assert.equal(fs.existsSync(path.join(P, '.doflow', 'state', '.gitignore')), true, '.gitignore exists under <P>');
  assert.ok(records(path.join(P, '.doflow', 'state')).filter((r: any) => r.kind === 'upkeep').length >= 1, 'ledger line under <P>');

  assert.equal(fs.existsSync(path.join(W, '.doflow', 'state', '.gitignore')), false, 'no .gitignore under <W>');
  assert.equal(records(path.join(W, '.doflow', 'state')).length, 0, 'no ledger line under <W>');

  const indexFile = path.join(roots['user-state'], 'upkeep-roots');
  assert.equal(fs.existsSync(indexFile), true, 'upkeep-roots index exists');
  const indexed = fs.readFileSync(indexFile, 'utf8');
  assert.ok(indexed.includes(fs.realpathSync(P)), 'upkeep-roots lists <P>');
  assert.ok(!indexed.includes(W), 'upkeep-roots does not list <W>');
});

test('C-8: bound.either on verification-reuse prunes when either count or age is exceeded; mtime store without either requires both', t => {
  const f = fixture(t, ['project-state']);
  const reuseDir = path.join(f.roots['project-state'], 'verification/reuse');
  const v0Dir = path.join(f.roots['project-state'], 'verification/v0');

  // S1: 401 recent records (age 0) in verification-reuse -> keeps 400 (prunes 1)
  for (let i = 0; i < 401; i++) {
    put(reuseDir, `reuse-${i.toString(16).padStart(16, '0')}.json`, '{}', 0);
  }
  // Control: 41 recent records (age 0) in verification-v0 (keepNewest: 40, maxAgeDays: 7, no either) -> keeps all 41
  for (let i = 0; i < 41; i++) {
    put(v0Dir, `failed-first-T-${i}.json`, '{}', 0);
  }

  upkeep().upkeepAfterVerb(f);

  assert.equal(fs.readdirSync(reuseDir).length, 400, 'S1: 401 recent records keeps 400 (prunes 1)');
  assert.equal(fs.readdirSync(v0Dir).length, 41, 'control: mtime store without either keeps all 41 recent records');

  // S2: 400 records 3 days old in verification-reuse (maxAgeDays: 2) -> prunes all 400 (0 left)
  for (const file of fs.readdirSync(reuseDir)) fs.unlinkSync(path.join(reuseDir, file));
  for (let i = 0; i < 400; i++) {
    put(reuseDir, `reuse-${i.toString(16).padStart(16, '0')}.json`, '{}', 3);
  }
  // Control: 40 records 8 days old in verification-v0 (maxAgeDays: 7, count <= 40) -> keeps all 40
  for (const file of fs.readdirSync(v0Dir)) fs.unlinkSync(path.join(v0Dir, file));
  for (let i = 0; i < 40; i++) {
    put(v0Dir, `failed-first-T-${i}.json`, '{}', 8);
  }

  upkeep().upkeepAfterVerb({ ...f, now: NOW + 2 * DAY });

  assert.equal(fs.readdirSync(reuseDir).length, 0, 'S2: 400 records 3 days old prunes all (0 left)');
  assert.equal(fs.readdirSync(v0Dir).length, 40, 'control: mtime store without either keeps all 40 old records because count not exceeded');
});


