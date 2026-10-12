'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const registry = require('../../core/registry/storage.json');
const engine = require('../../src/runtime/storage/engine');
const { RunLedger } = require('../../src/runtime/trace/ledger.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots');
const REPO = path.resolve(__dirname, '../..');
const RUN = path.join(REPO, 'core/shared/scripts/doflow/bin/doflow-run');
const NOW = Date.parse('2026-10-10T12:00:00Z');
const DAY = 86400000;
const IGNORE = `${registry.settings.ignoreFile.lines.join('\n')}\n`;
const upkeep = () => require('../../src/runtime/storage/upkeep');

function fixture(t, rootIds = ['project-state']) {
  const dir = tempDir(t, 'doflow-upkeep-');
  const projectRoot = path.join(dir, 'project');
  const env = { ...process.env, HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  delete env.DOFLOW_RETENTION_HOURS;
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(env.HOME);
  fs.mkdirSync(env.XDG_CONFIG_HOME);
  const roots = resolveRoots({ registry, projectRoot, env });
  rootIds.forEach(id => fs.mkdirSync(roots[id], { recursive: true }));
  return { dir, roots, projectRoot, env, now: NOW };
}
function put(dir, name, text = '{}', age = 0) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(NOW - age * DAY), new Date(NOW - age * DAY));
  return file;
}
function spyFs(overrides) {
  return new Proxy(fs, { get(target, key) {
    if (overrides[key]) return overrides[key];
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function records(root) {
  const dir = path.join(root, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
function capture(fn) {
  const out = [], err = [];
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
    const fsImpl = spyFs({ readFileSync(file, ...args) {
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
  const writes = [], renames = [];
  const fsImpl = spyFs({
    writeFileSync(file, ...args) { writes.push(file); return fs.writeFileSync(file, ...args); },
    renameSync(from, to) { renames.push([from, to]); return fs.renameSync(from, to); },
  });
  t.mock.method(engine, 'runPass', options => {
    assert.equal(options.mode, 'prune');
    assert.equal(fs.existsSync(path.join(root, 'upkeep.lock')), true);
    assert.equal(fs.readFileSync(path.join(root, 'upkeep-due'), 'utf8'), `${NOW / 1000 + 86400}\n`);
    return { partial: true, durationMs: 1, stores: [] };
  });
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  const marker = path.join(root, 'upkeep-due');
  assert.equal(fs.readFileSync(marker, 'utf8'), `${NOW / 1000}\n`);
  assert.equal(renames.filter(([, to]) => to === marker).length, 2);
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
  put(f.roots['config-home'], 'prune', 'off\n');
  const commits = [];
  upkeep().upkeepAfterVerb({ ...f, fsImpl: spyFs({
    renameSync(from, to) { commits.push([from, to]); return fs.renameSync(from, to); },
    linkSync(from, to) { commits.push([from, to]); return fs.linkSync(from, to); },
  }) });
  for (const id of ['project-state', 'user-state']) assert.equal(fs.readFileSync(path.join(f.roots[id], '.gitignore'), 'utf8'), IGNORE);
  for (const id of ['project-state', 'user-state', 'config-home']) {
    assert.equal(fs.existsSync(path.join(f.roots[id], 'upkeep-due')), false);
    assert.equal(fs.existsSync(path.join(f.roots[id], 'upkeep.lock')), false);
  }
  assert.equal(commits.filter(([from, to]) => path.basename(to) === '.gitignore' && path.dirname(from) === path.dirname(to)).length, 2);
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
  put(f.roots['config-home'], 'prune', 'off\n');
  const index = path.join(f.roots['user-state'], 'upkeep-roots'), appends = [], renames = [];
  const fsImpl = spyFs({
    appendFileSync(file, ...args) { if (file === index) appends.push(args[0]); return fs.appendFileSync(file, ...args); },
    renameSync(from, to) { renames.push([from, to]); return fs.renameSync(from, to); },
  });
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  assert.deepEqual(appends, [`${fs.realpathSync(f.projectRoot)}\n`]);
  const gone = path.join(f.dir, 'gone');
  fs.writeFileSync(index, `${f.projectRoot}\n${f.projectRoot}\n${gone}\n`);
  put(f.roots['config-home'], 'prune', 'on\n');
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  assert.equal(fs.readFileSync(index, 'utf8'), `${f.projectRoot}\n`);
  assert.ok(renames.some(([from, to]) => to === index && from !== index));
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
  const events = [], original = RunLedger.prototype.append;
  t.mock.method(RunLedger.prototype, 'append', function(event) { events.push({ dir: this.dir, event }); return original.call(this, event); });
  upkeep().upkeepAfterVerb(f);
  assert.equal(events.length, 3);
  events.forEach(({ event }) => {
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
    readFileSync(...args) { reads++; return fs.readFileSync(...args); },
    existsSync(...args) { exists++; return fs.existsSync(...args); },
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

test('IC-010: verify is unthrottled, locked and restricted to project verification logs', t => {
  const f = fixture(t), root = f.roots['project-state'];
  const log = put(path.join(root, 'verification/logs'), `${NOW - 31 * DAY}-old.log`);
  const work = put(path.join(root, 'research'), 'finished.json', '{}', 31);
  const marker = put(root, 'upkeep-due', `${NOW / 1000 + 86400}\n`);
  const original = engine.runPass, calls = [];
  t.mock.method(engine, 'runPass', options => { calls.push(options.stores); assert.ok(fs.existsSync(path.join(root, 'upkeep.lock'))); return original(options); });
  upkeep().upkeepAfterVerify(f);
  assert.deepEqual(calls, [['verification-logs']]);
  assert.equal(fs.existsSync(log), false); assert.equal(fs.existsSync(work), true);
  assert.equal(fs.readFileSync(marker, 'utf8'), `${NOW / 1000 + 86400}\n`);
  put(f.roots['project-doflow'], 'prune', 'off\n');
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

function controls(root, ignore = IGNORE) {
  put(root, '.gitignore', ignore); put(root, 'upkeep-due', '1\n');
  fs.mkdirSync(path.join(root, 'upkeep.lock')); put(root, 'keep.json', 'state');
}
test('IC-019: forgetting project removes only owned controls/index line and leaves settings/state', t => {
  const f = fixture(t, ['project-state', 'user-state']);
  controls(f.roots['project-state']);
  put(f.roots['project-doflow'], 'prune', 'off\n'); put(f.roots['project-doflow'], 'prompt-nudge', 'on\n');
  const index = put(f.roots['user-state'], 'upkeep-roots', `${f.projectRoot}\n${f.env.HOME}\n`);
  const result = capture(() => upkeep().storageForgetScope({ scope: 'project', scopeRoot: f.projectRoot, env: f.env }));
  assert.deepEqual(result.out, ['[INFO] Storage: removed 3 DoFlow control file(s)']);
  assert.deepEqual(result.err, []);
  assert.equal(fs.readFileSync(index, 'utf8'), `${f.env.HOME}\n`);
  assert.deepEqual(fs.readdirSync(f.roots['project-state']), ['keep.json']);
  assert.equal(fs.readFileSync(path.join(f.roots['project-doflow'], 'prune'), 'utf8'), 'off\n');
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
  put(f.roots['config-home'], 'prune', 'off\n'); put(f.roots['config-home'], 'prompt-nudge', 'on\n');
  put(f.roots['user-state'], 'upkeep-roots', `${f.projectRoot}\n${installed}\n`);
  const result = capture(() => upkeep().storageForgetScope({ scope: 'global', scopeRoot: f.env.HOME, env: f.env }));
  assert.deepEqual(result.out, ['[INFO] Storage: removed 9 DoFlow control file(s)']);
  assert.deepEqual(result.err, []);
  assert.deepEqual(fs.readdirSync(f.roots['project-state']), ['keep.json']);
  assert.deepEqual(fs.readdirSync(f.roots['user-state']), ['keep.json']);
  assert.equal(fs.readFileSync(path.join(installedState, '.gitignore'), 'utf8'), IGNORE);
  assert.equal(fs.existsSync(path.join(installedState, 'upkeep.lock')), true);
  assert.deepEqual(fs.readdirSync(f.roots['config-home']).sort(), ['prompt-nudge', 'prune']);
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
  const fsImpl = spyFs({ unlinkSync(file) { if (path.basename(file) === 'upkeep-due') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.unlinkSync(file); } });
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
  const run = () => spawnSync('/bin/bash', [RUN, 'evidence', '--action', 'list', '--task-id', 'idle', '--json'], {
    cwd: f.projectRoot, env: { ...f.env, DOFLOW_CLI: path.join(REPO, 'bin/doflow.js'), DOFLOW_CONFIG_DIR: f.roots['project-doflow'] }, encoding: 'utf8',
  });
  put(f.roots['config-home'], 'prune', 'off\n');
  const off = run(); assert.equal(off.status, 0, off.stderr);
  put(f.roots['config-home'], 'prune', 'on\n');
  fs.chmodSync(logDir, 0o555);
  try {
    const on = run();
    assert.deepEqual([on.stdout, on.stderr, on.status], [off.stdout, off.stderr, off.status]);
    assert.equal(fs.existsSync(log), true);
    assert.equal(records(f.roots['project-state']).filter(r => r.kind === 'upkeep').at(-1).outcome, 'error');
  } finally { fs.chmodSync(logDir, 0o755); }
});

test('IC-015 (G.3 A1): an unreadable lifecycle event fails the pass without stopping it; the marker advances normally', t => {
  const f = fixture(t), root = f.roots['project-state'];
  put(path.join(root, 'lifecycle/events'), '20260101T000000000Z-abcdef.json', '{not json');
  upkeep().upkeepAfterVerb(f);
  assert.equal(fs.readFileSync(path.join(root, 'upkeep-due'), 'utf8'), `${NOW / 1000 + registry.settings.upkeepIntervalHours * 3600}\n`);
  assert.deepEqual(records(root).map(record => record.outcome), ['error']);
  const result = engine.runPass({ registry, roots: f.roots, stores: ['lifecycle-events'], mode: 'prune', setting: { 'project-state': 'on' }, now: NOW, env: f.env });
  assert.equal(result.partial, false);
  assert.deepEqual(result.stores[0].failed, [{ name: 'lifecycle-events', code: 'EIO' }]);
});

test('IC-016 (G.3 A5): an ignore file created between the check and the commit is never overwritten', t => {
  const f = fixture(t), root = f.roots['project-state'], ignore = path.join(root, '.gitignore');
  let raced = 0;
  const race = (to) => { if (to === ignore && !fs.existsSync(ignore)) { fs.writeFileSync(ignore, 'user-managed\n'); raced++; } };
  const fsImpl = spyFs({
    renameSync(from, to) { race(to); return fs.renameSync(from, to); },
    linkSync(from, to) { race(to); return fs.linkSync(from, to); },
  });
  upkeep().upkeepAfterVerb({ ...f, fsImpl });
  assert.equal(raced, 1, 'the commit step was reached');
  assert.equal(fs.readFileSync(ignore, 'utf8'), 'user-managed\n');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), [], 'the temp file is removed');
});
