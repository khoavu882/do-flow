'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { handleStorageCommand } = require('../../src/runtime/storage/cli');
const DAY = 86400000;

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
function run(args, cwd, env) {
  return spawnSync(process.execPath, [BIN, 'storage', ...args], { cwd, env, encoding: 'utf8' });
}
function treeHash(root) {
  const hash = crypto.createHash('sha256');
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), info = fs.lstatSync(file);
      hash.update(path.relative(root, file)); hash.update(String(info.mode));
      if (info.isDirectory()) visit(file); else if (info.isFile()) hash.update(fs.readFileSync(file));
    }
  }
  visit(root); return hash.digest('hex');
}
function putAged(dir, name, ageMs, content = 'x') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name), time = new Date(Date.now() - ageMs);
  fs.writeFileSync(file, content); fs.utimesSync(file, time, time);
  return file;
}

test('storage report is read-only and names declared stores and bounds', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const env = scratch.env();
    const before = treeHash(scratch.dir);
    const result = run([], project, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verification-logs/);
    assert.match(result.stdout, /Location|location/);
    assert.equal(treeHash(scratch.dir), before, 'report must not modify its roots');
    for (const root of [path.join(project, '.doflow/state'), path.join(scratch.home, '.doflow/state'), path.join(scratch.xdg, 'doflow')]) {
      assert.equal(fs.existsSync(path.join(root, 'upkeep-due')), false);
      assert.equal(fs.existsSync(path.join(root, 'upkeep.lock')), false);
    }
  } finally { scratch.remove(); }
});

test('storage report JSON includes effective settings and all pass result fields', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const result = run(['--json'], project, scratch.env());
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report.setting).sort(), ['decidedBy', 'project', 'user']);
    assert.deepEqual(Object.keys(report.setting.decidedBy).sort(), ['project', 'user']);
    assert.equal(report.mode, 'report');
    assert.ok(Array.isArray(report.stores));
    assert.ok(report.stores.every(row => ['id', 'location', 'entries', 'bytes', 'bound', 'selected'].every(key => key in row)));
  } finally { scratch.remove(); }
});

test('storage report shows deciding paths and caps listed recovery names at twenty', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const projectDoflow = path.join(project, '.doflow'); fs.mkdirSync(projectDoflow);
    const projectSetting = path.join(projectDoflow, 'prune'); fs.writeFileSync(projectSetting, 'on\n');
    const recovery = path.join(projectDoflow, 'state/recovery');
    for (let i = 0; i < 25; i++) putAged(recovery, `recovery_${String(i).padStart(2, '0')}.json`, (25 - i) * 1000);
    fs.writeFileSync(path.join(projectDoflow, 'state/ledger.json'), JSON.stringify({ lastRecoveryId: 'recovery_24' }));
    const before = treeHash(scratch.dir);
    const result = run([], project, scratch.env());
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`project on (${projectSetting})`));
    assert.ok(result.stdout.includes(`user off (${path.join(scratch.xdg, 'doflow/prune')})`));
    assert.match(result.stdout, /Would remove: 22/);
    assert.ok(result.stdout.includes('... and 2 more'));
    assert.match(result.stdout, /Bound:.*3/);
    assert.equal([...result.stdout.matchAll(/recovery_[A-Za-z0-9_-]+\.json/g)].length, 20);
    assert.equal(treeHash(scratch.dir), before, 'report must not mutate the recovery store');
  } finally { scratch.remove(); }
});

test('storage prune ignores upkeep-due and includes recovery stores', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const projectDoflow = path.join(project, '.doflow'); fs.mkdirSync(projectDoflow);
    fs.writeFileSync(path.join(projectDoflow, 'prune'), 'on\n');
    fs.writeFileSync(path.join(scratch.xdg, 'doflow/prune'), 'on\n');
    const state = path.join(projectDoflow, 'state'); fs.mkdirSync(state);
    const marker = path.join(state, 'upkeep-due'); fs.writeFileSync(marker, 'future\n');
    const oldLog = putAged(path.join(state, 'verification/logs'), `${Date.now() - 31 * DAY}-expired.log`, 31 * DAY, 'old');
    const recovery = path.join(state, 'recovery');
    const snapshots = [5, 4, 3, 2, 1].map(days => putAged(recovery, `recovery_${days}.json`, days * DAY));
    fs.writeFileSync(path.join(state, 'ledger.json'), JSON.stringify({ lastRecoveryId: 'recovery_1' }));
    const result = run(['--action', 'prune'], project, scratch.env());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(oldLog), false, 'manual prune must not consult the throttle marker');
    assert.equal(fs.existsSync(snapshots[3]), false, 'manual prune includes the recovery store');
    assert.ok(snapshots.slice(0, 3).every(file => fs.existsSync(file)));
    assert.equal(fs.existsSync(snapshots[4]), true, 'the ledger-named recovery snapshot is preserved');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'future\n');
    assert.match(result.stdout, /storage: removed [1-9][0-9]* entr/);
  } finally { scratch.remove(); }
});

test('global storage report drops project roots', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const projectState = path.join(project, '.doflow/state/verification/logs');
    putAged(projectState, `${Date.now() - 31 * DAY}-expired.log`, 31 * DAY, 'old');
    const result = run(['--json', '-g'], project, scratch.env());
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stores.some(row => row.location && path.resolve(row.location).startsWith(path.resolve(project))), false);
  } finally { scratch.remove(); }
});

test('storage reports registry failures as usage errors', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const target = path.join(REPO_ROOT, 'core/registry/storage.json');
    const code = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { handleStorageCommand } = require(${JSON.stringify(path.join(REPO_ROOT, 'src/runtime/storage/cli.js'))});
      const registry = ${JSON.stringify(target)};
      const fsImpl = new Proxy(fs, { get(target, key) {
        if (key === 'readFileSync') return (file, ...args) => {
          if (path.resolve(String(file)) === registry) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
          return fs.readFileSync(file, ...args);
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      handleStorageCommand({ projectRoot: process.cwd(), env: process.env, fsImpl });
    `;
    const result = spawnSync(process.execPath, ['-e', code], { cwd: project, env: scratch.env(), encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /storage registry unavailable.*Could not load storage registry/);
  } finally { scratch.remove(); }
});

test('storage upkeep stays silent and exits 0 when the registry is unavailable (G.1)', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const target = path.join(REPO_ROOT, 'core/registry/storage.json');
    const code = `
      const fs = require('node:fs');
      const path = require('node:path');
      const registry = ${JSON.stringify(target)};
      const readFileSync = fs.readFileSync;
      fs.readFileSync = (file, ...args) => {
        if (path.resolve(String(file)) === registry) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
        return readFileSync(file, ...args);
      };
      const { handleStorageCommand } = require(${JSON.stringify(path.join(REPO_ROOT, 'src/runtime/storage/cli.js'))});
      handleStorageCommand({ action: 'upkeep', json: true, projectRoot: process.cwd(), env: process.env });
    `;
    const result = spawnSync(process.execPath, ['-e', code], { cwd: project, env: scratch.env(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally { scratch.remove(); }
});

test('storage prune honors off and upkeep is silent', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const off = run(['--action', 'prune'], project, scratch.env());
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /storage: pruning is off .*; nothing removed/);
    const upkeep = run(['--action', 'upkeep', '--json'], project, scratch.env());
    assert.equal(upkeep.status, 0, upkeep.stderr);
    assert.equal(upkeep.stdout, '');
  } finally { scratch.remove(); }
});

test('storage rejects invalid actions and the dispatcher recognizes storage', { skip: process.platform === 'win32' }, () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const invalid = run(['--action', 'unknown'], project, scratch.env());
    assert.equal(invalid.status, 2);
    const dispatcher = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
    const result = spawnSync('/bin/bash', [dispatcher, 'storage', '--action', 'upkeep'], { cwd: project, env: scratch.env(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally { scratch.remove(); }
});

function settledEvents(project) {
  const dir = path.join(project, '.doflow/state/lifecycle/events'); fs.mkdirSync(dir, { recursive: true });
  const id = 'FU-abcdef';
  for (const [suffix, type, data] of [['000000', 'followup.added', { id, statement: 'old item', source: { kind: 'manual' } }], ['000001', 'followup.settled', { id, as: 'dismissed', reason: 'closed' }]]) {
    const eventId = `20260101T000000000Z-${suffix}`;
    fs.writeFileSync(path.join(dir, `${eventId}.json`), JSON.stringify({ v: 1, id: eventId, at: '2026-01-01T00:00:00.000Z', type, by: 'agent', data }));
  }
  return dir;
}

test('storage prune with pruning off reports the lifecycle events an explicit DOFLOW_RETENTION_HOURS removed (G.3 A2)', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(path.join(project, '.doflow'), { recursive: true });
    fs.writeFileSync(path.join(project, '.doflow/prune'), 'off\n');
    const events = settledEvents(project);
    const kept = run(['--action', 'prune'], project, scratch.env());
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /storage: pruning is off .*; nothing removed/);
    assert.equal(fs.readdirSync(events).length, 2);
    const removed = run(['--action', 'prune'], project, scratch.env({ DOFLOW_RETENTION_HOURS: '1' }));
    assert.equal(removed.status, 0, removed.stderr);
    assert.doesNotMatch(removed.stdout, /nothing removed/);
    assert.match(removed.stdout, /storage: pruning is off .*DOFLOW_RETENTION_HOURS.*removed 2 entries/);
    assert.equal(fs.readdirSync(events).length, 0);
  } finally { scratch.remove(); }
});

test('storage report lists lifecycle events only under the window prune would use (G.3 A4)', () => {
  const scratch = createScratch('doflow-storage-cli-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    settledEvents(project);
    const off = run(['--json'], project, scratch.env());
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(JSON.parse(off.stdout).stores.find(row => row.id === 'lifecycle-events').selected, []);
    const env = run(['--json'], project, scratch.env({ DOFLOW_RETENTION_HOURS: '1' }));
    assert.equal(env.status, 0, env.stderr);
    assert.equal(JSON.parse(env.stdout).stores.find(row => row.id === 'lifecycle-events').selected.length, 2);
  } finally { scratch.remove(); }
});
