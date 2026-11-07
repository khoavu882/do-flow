'use strict';

// Feature 149 A.6 (IC-001, IC-003, IC-006, AC-10, AC-11, AC-12, AC-13): `doflow events --follow
// --channels ...` in a terminal, on a real project. The CLI is spawned with its cwd in a temp git
// project and its own HOME and config home: one snapshot, then a patch with a greater id after the
// run takes one step through the real `orchestrate` verb; a record of version 2 errors its channel
// only; refused kinds exit 2 before any envelope; SIGTERM exits 0; and a follow session leaves every
// DoFlow tree byte-identical. Every wait has a generous deadline and every child is killed after.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { ENVELOPE_ID } = require('../../src/runtime/events/envelope.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SOURCE = fs.readFileSync(path.join(REPO, 'src', 'cli', 'runtime-commands.ts'), 'utf8');
const WIN = process.platform === 'win32';
const SLUG = 'feat-a';
const DEADLINE_MS = 20000;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

function fixture(t: any) {
  const root = tempDir(t, 'doflow-events-follow-');
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), main: path.join(root, 'proj') };
  for (const d of [f.home, f.config, f.main]) fs.mkdirSync(d, { recursive: true });
  git(f.main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(f.main, 'a.js'), '// a\n');
  git(f.main, 'add', '-A');
  git(f.main, 'commit', '-q', '-m', 'first');
  // No DOFLOW_UPKEEP or DOFLOW_TELEMETRY switch: the read-only case shows the verb writes nothing on its own.
  f.env = {
    HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.config,
    PATH: process.env.PATH, ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}),
    TMPDIR: process.env.TMPDIR, ...(process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
  };
  return f;
}

/** A write verb for the fixture, with upkeep and telemetry off so only its own record changes. */
function ok(f: any, args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], {
    cwd: f.main, env: { ...f.env, DOFLOW_UPKEEP: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_FAILURE_CAPTURE: 'off' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function journal(f: any, taskId: string): string {
  return path.join(f.main, '.doflow', 'state', 'orchestration', SLUG, `${taskId}.json`);
}

/** Names, contents, mtime and inode of every entry under `root` (absent: null). */
function treeSnapshot(root: string) {
  if (!fs.existsSync(root)) return null;
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
  visit(root);
  return entries;
}

/** A spawned follower: its stdout as parsed lines, waits with a deadline, killed after the test. */
function follow(t: any, f: any, channels: string) {
  const child = spawn(process.execPath, [CLI, 'events', '--follow', '--channels', channels, '--json'], { cwd: f.main, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const s: any = { child, out: '', err: '', waiters: [] as Array<() => void> };
  const poke = () => { for (const w of s.waiters.splice(0)) w(); };
  child.stdout.on('data', (d: Buffer) => { s.out += d.toString('utf8'); poke(); });
  child.stderr.on('data', (d: Buffer) => { s.err += d.toString('utf8'); poke(); });
  s.exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('exit', (code: number | null, signal: string | null) => { resolve({ code, signal }); poke(); }));
  s.frames = () => s.out.split('\n').filter((l: string) => l !== '').map((l: string) => JSON.parse(l));
  /** Resolves with the frames once `predicate(frames)` holds; rejects after the deadline. */
  s.until = (what: string, predicate: (frames: any[]) => boolean) => new Promise<any[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; stdout ${s.out} stderr ${s.err}`)), DEADLINE_MS);
    const check = () => {
      let frames: any[];
      try { frames = s.frames(); } catch (error) { clearTimeout(timer); reject(error); return; }
      if (predicate(frames)) { clearTimeout(timer); resolve(frames); return; }
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); reject(new Error(`exited ${child.exitCode} before ${what}; stderr ${s.err}`)); return; }
      s.waiters.push(check);
    };
    check();
  });
  s.exit = () => Promise.race([s.exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`no exit; stderr ${s.err}`)), DEADLINE_MS); timer.unref(); })]);
  return s;
}

const of = (frames: any[], ch: string) => frames.filter((frame) => frame.ch === ch);
const n = (frame: any): number => Number(frame.id.split('-')[1]);

function checkEnvelopes(frames: any[]) {
  for (const frame of frames) {
    assert.equal(frame.v, 1);
    assert.match(frame.id, ENVELOPE_ID);
    assert.ok(['snapshot', 'patch', 'reset', 'error', 'gone'].includes(frame.type), frame.type);
    assert.match(frame.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
}

test('AC-10: a terminal follow prints a snapshot, then a patch with a greater id after the run takes a step; a version 2 record errors its channel only', async (t) => {
  const f = fixture(t);
  ok(f, ['orchestrate', '--action', 'start', '--task-id', 'a1', '--task-class', 'feature', '--slug', SLUG]);
  ok(f, ['orchestrate', '--action', 'start', '--task-id', 'b1', '--task-class', 'feature', '--slug', SLUG]);
  const newer = JSON.parse(fs.readFileSync(journal(f, 'b1'), 'utf8'));
  newer.version = 2;
  fs.writeFileSync(journal(f, 'b1'), JSON.stringify(newer, null, 2));

  const s = follow(t, f, `run:${SLUG}:a1,run:${SLUG}:b1`);
  let frames = await s.until('the a1 snapshot and the b1 error', (all: any[]) => of(all, `run:${SLUG}:a1`).length >= 1 && of(all, `run:${SLUG}:b1`).length >= 1);
  const [snapshot] = of(frames, `run:${SLUG}:a1`);
  assert.equal(snapshot.type, 'snapshot');
  assert.deepEqual(Object.keys(snapshot.data.sections).sort(), ['status', 'timeline']);
  assert.equal(snapshot.data.sections.status.exit, 0);
  assert.equal(snapshot.data.sections.status.json.taskId, 'a1');
  assert.deepEqual(of(frames, `run:${SLUG}:b1`).map((frame) => [frame.type, frame.data]), [['error', { code: 'unsupported-version' }]]);

  ok(f, ['orchestrate', '--action', 'complete-stage', '--task-id', 'a1', '--stage', 'discovery', '--result', 'passed', '--slug', SLUG]);
  frames = await s.until('the a1 patch', (all: any[]) => of(all, `run:${SLUG}:a1`).some((frame) => frame.type === 'patch'));
  const patch = of(frames, `run:${SLUG}:a1`).find((frame) => frame.type === 'patch');
  assert.equal(patch.id.split('-')[0], snapshot.id.split('-')[0], 'one epoch');
  assert.ok(n(patch) > n(snapshot));
  assert.ok(Object.keys(patch.data.sections).length >= 1);
  assert.ok(Object.keys(patch.data.sections).every((name) => name === 'status' || name === 'timeline'));
  for (const name of Object.keys(patch.data.sections)) assert.notDeepEqual(patch.data.sections[name], snapshot.data.sections[name], `${name} changed`);
  assert.ok(of(frames, `run:${SLUG}:b1`).every((frame) => frame.type === 'error'), 'no section of the version 2 record is emitted');
  checkEnvelopes(frames);
  assert.equal(s.err, '');

  if (WIN) return; // no POSIX signals on win32; the child is killed after the test
  s.child.kill('SIGTERM');
  const { code } = await s.exit();
  assert.equal(code, 0, s.err);
  checkEnvelopes(s.frames());
});

test('AC-13: a refused kind exits 2 before any envelope', (t) => {
  const root = tempDir(t, 'doflow-events-follow-refused-');
  for (const channels of ['worker:w-0123456789ab:out', 'worker:w-0123456789ab:err', 'transcript:x', 'fleet:x', 'followups', 'advice', `now,fleet:x`]) {
    const r = spawnSync(process.execPath, [CLI, 'events', '--follow', '--channels', channels, '--json'], {
      cwd: root, env: { ...process.env, DOFLOW_UPKEEP: 'off', DOFLOW_TELEMETRY: 'off' }, encoding: 'utf8',
    });
    assert.equal(r.status, 2, `${channels}: ${r.stderr}`);
    assert.equal(r.stdout, '', channels);
    assert.match(r.stderr, /^doflow events: .*refused/, channels);
    assert.ok(!r.stderr.includes('[ERROR]'));
  }
  assert.deepEqual(fs.readdirSync(root), [], 'nothing was created');
});

test('AC-11: a follow session leaves the project state, user state and config home byte-identical', async (t) => {
  const f = fixture(t);
  ok(f, ['orchestrate', '--action', 'start', '--task-id', 'a1', '--task-class', 'feature', '--slug', SLUG]);
  for (const dir of [path.join(f.main, '.doflow', 'state'), path.join(f.home, '.doflow', 'state')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'upkeep-due'), '1\n');
  }
  fs.mkdirSync(path.join(f.config, 'doflow', 'session-env', 'sessions', 's1'), { recursive: true });
  const trees = [path.join(f.main, '.doflow'), f.home, f.config];
  const before = trees.map(treeSnapshot);
  const channels = ['now', `run:${SLUG}:a1`, `tasks:${SLUG}`, 'worker:w-0123456789ab'];
  const s = follow(t, f, channels.join(','));
  const frames = await s.until('a first frame on every channel', (all: any[]) => channels.every((ch) => of(all, ch).length >= 1));
  for (const ch of channels) assert.equal(of(frames, ch)[0].type, 'snapshot', ch);
  checkEnvelopes(frames);
  // Let at least one 1 s pass run over every followed source before stopping.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (WIN) s.child.kill();
  else s.child.kill('SIGTERM');
  const { code } = await s.exit();
  if (!WIN) assert.equal(code, 0, s.err);
  assert.equal(s.err, '');
  assert.deepEqual(trees.map(treeSnapshot), before);
});

test('IC-001: SIGTERM ends a follow with exit 0', { skip: WIN ? 'no POSIX signals on win32' : false }, async (t) => {
  const f = fixture(t);
  const s = follow(t, f, 'now');
  await s.until('the now snapshot', (all: any[]) => of(all, 'now').length >= 1);
  const started = Date.now();
  s.child.kill('SIGTERM');
  const { code, signal } = await s.exit();
  assert.deepEqual([code, signal], [0, null], s.err);
  // The verb closes its watchers at once; the bound here is generous because the machine may be loaded.
  assert.ok(Date.now() - started < 10000, `exited after ${Date.now() - started} ms`);
});

test('NO_UPKEEP holds events (IC-001, NFR-007)', () => {
  const set = SOURCE.match(/const NO_UPKEEP = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'NO_UPKEEP is declared as a literal set');
  assert.ok(set[1].split(',').map((v: string) => v.trim().replace(/'/g, '')).includes('events'));
});
