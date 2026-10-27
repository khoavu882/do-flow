'use strict';

// Row 093 E.5 (IC-018 b): `doflow slot --action peek` reads the slot files with no lock, no sweep
// and no mkdir. A dead holder stays on disk and is reported `alive: false`; the holder's pid,
// start and cwd never reach the output; a holder's `worktreeKey` is set only when its cwd lies in
// one of the project's checkouts. Control: `slot --action list` on the same fixture rewrites the
// dead holder's file, so the snapshot used here can see a write.
//
// Run with DOFLOW_UPKEEP=off, the environment the Console spawns core with (092 IC-009).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const LABEL = 'MARKER-e5 label <b>over</b> the rule \u0007 x'.padEnd(80, '!');

function treeSnapshot(root: string) {
  const entries: any = {};
  const visit = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const info = fs.lstatSync(file, { bigint: true });
      const base = { mtimeNs: info.mtimeNs.toString(), ino: info.ino.toString() };
      const rel = path.relative(root, file);
      if (info.isDirectory()) { entries[rel] = { type: 'dir', ...base }; visit(file); }
      else if (info.isFile()) entries[rel] = { type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ...base };
      else entries[rel] = { type: 'other', ...base };
    }
  };
  const top = fs.lstatSync(root, { bigint: true });
  entries['.'] = { mtimeNs: top.mtimeNs.toString(), ino: top.ino.toString() };
  visit(root);
  return entries;
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A pid that has exited: a child that ran and was reaped. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  assert.equal(r.status, 0);
  return r.pid;
}

function fixture(t: any) {
  const root = tempDir(t, 'doflow-slot-peek-');
  const f: any = { root, home: path.join(root, 'home'), main: path.join(root, 'proj'), linked: path.join(root, 'proj-wt'), elsewhere: path.join(root, 'elsewhere') };
  for (const d of [f.home, f.main, f.elsewhere]) fs.mkdirSync(d, { recursive: true });
  git(f.main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(f.main, 'a.txt'), 'a\n');
  git(f.main, 'add', '-A');
  git(f.main, 'commit', '-q', '-m', 'first');
  git(f.main, 'worktree', 'add', '-q', '-b', 'feat', f.linked);
  fs.mkdirSync(path.join(f.linked, 'sub'));
  f.slots = path.join(f.home, '.doflow', 'state', 'slots');
  f.dead = deadPid();
  f.env = {
    HOME: f.home, XDG_CONFIG_HOME: path.join(f.home, '.config'), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, DOFLOW_UPKEEP: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_FAILURE_CAPTURE: 'off',
  };
  return f;
}

function plant(f: any, { broken = false } = {}) {
  fs.mkdirSync(f.slots, { recursive: true });
  // A dead holder whose cwd is inside the linked worktree.
  fs.writeFileSync(path.join(f.slots, 'build.json'), JSON.stringify({
    name: 'build', holder: { pid: f.dead, start: 'x', childPid: null, childStart: null, label: LABEL, since: '2026-01-01T00:00:00.000Z', cwd: path.join(f.linked, 'sub') },
    waiters: [], lastRelease: null,
  }));
  // A holder whose liveness cannot be proven (no start time), in another directory, with one dead and one live waiter.
  fs.writeFileSync(path.join(f.slots, 'suite.json'), JSON.stringify({
    name: 'suite', holder: { pid: process.pid, start: null, childPid: null, childStart: null, label: 'suite@x', since: '2026-01-02T00:00:00.000Z', cwd: f.elsewhere },
    waiters: [{ pid: f.dead, start: 'x', label: 'w1', since: '2026-01-02T00:01:00.000Z', cwd: f.main }, { pid: process.pid, start: null, label: 'w2', since: '2026-01-02T00:02:00.000Z', cwd: f.main }],
    lastRelease: null,
  }));
  // `list` refuses a torn file, so only the field-set case plants one.
  if (broken) fs.writeFileSync(path.join(f.slots, 'broken.json'), '{not json');
}

function slot(f: any, args: string[], cwd = f.main) {
  return spawnSync(process.execPath, [CLI, 'slot', ...args], { cwd, env: f.env, encoding: 'utf8' });
}

test('peek reports each slot with label, since, alive and worktreeKey only (IC-018 b)', (t) => {
  const f = fixture(t);
  plant(f, { broken: true });
  const r = slot(f, ['--action', 'peek', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(body), ['v', 'slots', 'unreadable']);
  assert.equal(body.unreadable, 1);
  for (const s of body.slots) {
    assert.deepEqual(Object.keys(s), ['name', 'holder', 'waiters']);
    assert.deepEqual(Object.keys(s.holder), ['label', 'since', 'alive', 'worktreeKey']);
  }
  assert.deepEqual(body.slots, [
    { name: 'build', holder: { label: LABEL, since: '2026-01-01T00:00:00.000Z', alive: false, worktreeKey: cwdHash(f.linked) }, waiters: 0 },
    { name: 'suite', holder: { label: 'suite@x', since: '2026-01-02T00:00:00.000Z', alive: 'unknown', worktreeKey: null }, waiters: 1 },
  ]);
  for (const marker of [f.root, f.linked, f.elsewhere, `"pid"`, `"cwd"`, `"start"`, String(f.dead)]) {
    assert.ok(!r.stdout.includes(marker), `output carries no ${marker}`);
  }
});

test('peek leaves a dead holder on disk and the trees byte-identical; list (control) rewrites it (IC-018 b)', (t) => {
  const f = fixture(t);
  plant(f);
  const before = treeSnapshot(f.root);
  assert.equal(slot(f, ['--action', 'peek', '--json']).status, 0);
  assert.equal(slot(f, ['--action', 'peek'], f.linked).status, 0);
  assert.deepEqual(treeSnapshot(f.root), before, 'peek wrote nothing');
  assert.ok(fs.existsSync(path.join(f.slots, 'build.json')), 'the dead holder is still on disk');

  const listed = slot(f, ['--action', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.notDeepEqual(treeSnapshot(f.root), before, 'control: list changes the tree');
  assert.ok(!fs.existsSync(path.join(f.slots, 'build.json')), "control: list swept the dead holder's file");
});

test('peek with no slots directory creates nothing and lists nothing (IC-018 b)', (t) => {
  const f = fixture(t);
  const before = treeSnapshot(f.root);
  const r = slot(f, ['--action', 'peek', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { v: 1, slots: [], unreadable: 0 });
  assert.deepEqual(treeSnapshot(f.root), before);
  assert.ok(!fs.existsSync(path.join(f.home, '.doflow')), 'no directory and no lock created');
});

test('peek refuses an extra argument as usage (IC-018 b)', (t) => {
  const f = fixture(t);
  assert.equal(slot(f, ['--action', 'peek', 'extra']).status, 2);
});

test('peek without DOFLOW_UPKEEP=off still writes nothing: no .gitignore, no upkeep-due; list (control) runs upkeep (IC-018 b)', (t) => {
  const f = fixture(t);
  const env = { ...f.env };
  delete env.DOFLOW_UPKEEP;
  // One holder whose liveness is unknown and no waiter: `list` sweeps nothing, so any change it makes is upkeep.
  fs.mkdirSync(f.slots, { recursive: true });
  fs.writeFileSync(path.join(f.slots, 'suite.json'), JSON.stringify({
    name: 'suite', holder: { pid: process.pid, start: null, childPid: null, childStart: null, label: 'suite@x', since: '2026-01-02T00:00:00.000Z', cwd: f.main },
    waiters: [], lastRelease: null,
  }));
  const run = (args: string[], cwd = f.main) => spawnSync(process.execPath, [CLI, 'slot', ...args], { cwd, env, encoding: 'utf8' });
  const userState = path.join(f.home, '.doflow', 'state');
  const before = treeSnapshot(f.root);
  assert.equal(run(['--action', 'peek', '--json']).status, 0);
  assert.equal(run(['--action', 'peek'], f.linked).status, 0);
  assert.deepEqual(treeSnapshot(f.root), before, 'peek wrote nothing without the switch');
  assert.ok(!fs.existsSync(path.join(userState, '.gitignore')) && !fs.existsSync(path.join(userState, 'upkeep-due')));

  const listed = run(['--action', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(fs.existsSync(path.join(f.slots, 'suite.json')), 'control: list swept nothing');
  assert.notDeepEqual(treeSnapshot(f.root), before, 'control: list without the switch runs upkeep, which writes');
  assert.ok(fs.existsSync(path.join(userState, '.gitignore')) || fs.existsSync(path.join(userState, 'upkeep-due')), 'control: upkeep wrote its .gitignore or upkeep-due');
});
