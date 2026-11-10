'use strict';

// Feature 151 A.5 (IC-001, IC-003, IC-004, IC-024; FR-025, NFR-001): the two management read verbs
// `advice-picks` and `worker-matrix` registered and run from a terminal through `bin/doflow.js`, with
// the working directory in a temp git project and its own HOME and config home. Each `--json` body is
// one line with `v: 1` and its `limits`; an unknown flag, a positional and an unknown `--kind` exit 2
// with the usage body; no DoFlow tree changes, with upkeep left on; `NO_UPKEEP` holds both verbs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SOURCE = fs.readFileSync(path.join(REPO, 'src', 'cli', 'runtime-commands.ts'), 'utf8');
const WIN = process.platform === 'win32';
const USAGE = { v: 1, ok: false, error: 'usage' };
const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

/** A git project with one advice pick in its project store and an `upkeep-due` marker in both state roots. */
function fixture(t: any) {
  const root = tempDir(t, 'doflow-manage-reads-');
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), main: path.join(root, 'proj') };
  for (const d of [f.home, f.config, f.main]) fs.mkdirSync(d, { recursive: true });
  git(f.main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(f.main, 'a.js'), '// a\n');
  git(f.main, 'add', '-A');
  git(f.main, 'commit', '-q', '-m', 'first');
  // Yesterday noon UTC: inside the 90-day window whichever side of midnight the CLI reads its clock.
  const at = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS / 2);
  const picks = path.join(f.main, '.doflow', 'state', 'advice', 'picks');
  fs.mkdirSync(picks, { recursive: true });
  const record = { schema: 1, type: 'pick', kind: 'tier', pickId: `adv-${at.getTime()}-0a1b2c`, at: at.toISOString(), mode: 'shadow', pick: 'standard', static: 'light', question: 'planted question text' };
  fs.writeFileSync(path.join(picks, `${at.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
  // Upkeep would consume these markers, so an unchanged tree also shows that no upkeep ran.
  for (const dir of [path.join(f.main, '.doflow', 'state'), path.join(f.home, '.doflow', 'state')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'upkeep-due'), '1\n');
  }
  // No DOFLOW_UPKEEP or DOFLOW_TELEMETRY switch: the verbs must write nothing on their own.
  f.env = {
    HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.config,
    PATH: process.env.PATH, ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}),
    TMPDIR: process.env.TMPDIR, ...(process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
  };
  f.pickId = record.pickId;
  return f;
}

function run(f: any, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: f.main, env: f.env, encoding: 'utf8' });
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

/** The single stdout line, parsed; the output must be exactly one line. */
function oneLine(stdout: string) {
  assert.ok(stdout.endsWith('\n'), 'the body ends with a newline');
  const lines = stdout.slice(0, -1).split('\n');
  assert.equal(lines.length, 1, 'the body is one line');
  return JSON.parse(lines[0]);
}

test('IC-001: advice-picks --json is one line with v: 1, the window, the project pick and its limits', (t) => {
  const f = fixture(t);
  const r = run(f, ['advice-picks', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const body = oneLine(r.stdout);
  assert.equal(body.v, 1);
  assert.equal(body.window.maxAgeDays, 90);
  assert.equal(body.days.length, 91);
  assert.equal(body.kind, null);
  assert.deepEqual(body.stores, { 'project-state': 'read', 'user-state': 'absent' });
  assert.deepEqual(body.limits, { shown: 1, notShown: 0, skipped: 0 });
  assert.deepEqual(body.picks.map((p: any) => [p.pickId, p.kind, p.mode, p.pick, p.static, p.agree, p.outcome]), [[f.pickId, 'tier', 'shadow', 'standard', 'light', false, null]]);
  assert.ok(!r.stdout.includes('planted question text'), 'no question text reaches the body');
  const narrowed = oneLine(run(f, ['advice-picks', '--kind', 'task-class', '--json']).stdout);
  assert.deepEqual(narrowed.kinds, ['task-class']);
  assert.deepEqual(narrowed.limits, { shown: 0, notShown: 0, skipped: 0 });
});

test('IC-003: worker-matrix --json is one line with v: 1, both groups and its limits', (t) => {
  const f = fixture(t);
  const r = run(f, ['worker-matrix', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const body = oneLine(r.stdout);
  assert.equal(body.v, 1);
  assert.deepEqual(Object.keys(body.groups), ['worker', 'orchestration']);
  assert.ok(body.harnesses.length > 0);
  assert.deepEqual(Object.keys(body.limits), ['shown', 'notShown', 'cellsNotShown', 'cut']);
  assert.equal(body.limits.shown, body.harnesses.length);
  assert.deepEqual(run(f, ['worker-matrix']).stdout, r.stdout, 'the same line without --json');
});

test('IC-004: an unknown flag and a positional exit 2 with the usage body and one stderr line, for each verb', (t) => {
  const f = fixture(t);
  for (const verb of ['advice-picks', 'worker-matrix']) {
    for (const args of [[verb, '--bogus', '--json'], [verb, 'extra', '--json'], [verb, '--slug', 'x', '--json']]) {
      const r = run(f, args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.deepEqual(oneLine(r.stdout), USAGE, args.join(' '));
      assert.match(r.stderr, new RegExp(`^doflow ${verb}: [^\\n]+\\n$`), args.join(' '));
    }
  }
});

test('IC-001: advice-picks --kind nope exits 2 usage', (t) => {
  const f = fixture(t);
  for (const args of [['advice-picks', '--kind', 'nope', '--json'], ['advice-picks', '--kind=nope']]) {
    const r = run(f, args);
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(oneLine(r.stdout), USAGE);
    assert.match(r.stderr, /^doflow advice-picks: unknown --kind 'nope'/);
  }
});

test('FR-025, NFR-001: both verbs, answered and refused, leave every DoFlow tree byte for byte unchanged with upkeep on', (t) => {
  const f = fixture(t);
  const trees = [f.main, f.home, f.config];
  const before = trees.map(treeSnapshot);
  assert.ok(before[0]['.doflow/state/upkeep-due'.split('/').join(path.sep)], 'the control marker upkeep would consume is there');
  for (const args of [['advice-picks', '--json'], ['advice-picks'], ['advice-picks', '--kind', 'tier', '--json'], ['advice-picks', '--kind', 'nope'],
    ['worker-matrix', '--json'], ['worker-matrix'], ['worker-matrix', '--bogus']]) {
    const r = run(f, args);
    assert.ok(r.status === 0 || r.status === 2, `${args.join(' ')}: exit ${r.status} ${r.stderr}`);
  }
  assert.deepEqual(trees.map(treeSnapshot), before);
});

test('NO_UPKEEP holds advice-picks and worker-matrix (IC-004)', () => {
  const set = SOURCE.match(/const NO_UPKEEP = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'NO_UPKEEP is declared as a literal set');
  const names = set[1].split(',').map((v: string) => v.trim().replace(/'/g, ''));
  assert.ok(names.includes('advice-picks'));
  assert.ok(names.includes('worker-matrix'));
});
