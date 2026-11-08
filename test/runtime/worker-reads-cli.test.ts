'use strict';

// Feature 150 A.4 (IC-005; IC-002, IC-003, IC-004; FR-013, FR-014, NFR-007): the three worker read
// verbs through `bin/doflow.js`, the way the Console and a terminal run them. The CLI is spawned with
// its cwd in a temp project (no git, so the lifecycle root is that directory) and its own HOME and
// config home, over a run store built with insertRun and transition. Each verb's `--json` body is one
// compact `v: 1` line; an unknown flag and a bad run id exit 2; `worker-result` of a missing run exits
// 1; a session of every verb leaves every DoFlow tree byte-identical; and NO_UPKEEP holds each verb.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { storeFileFor, insertRun, transition, readRuns } = require('../../src/runtime/worker/run-store.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SOURCE = fs.readFileSync(path.join(REPO, 'src', 'cli', 'runtime-commands.ts'), 'utf8');
const WIN = process.platform === 'win32';
const SLUG = '150-reads-cli';
const VERBS = ['worker-log', 'worker-result', 'worker-runs'];
const RUNNING = 'w-0000000000a1';
const ENDED = 'w-0000000000b2';
const MISSING = 'w-0000000000ff';

/** A temp project with a run store of one running and one ended run, and the running run's out log. */
function fixture(t: any) {
  const root = fs.realpathSync(tempDir(t, 'doflow-worker-reads-cli-'));
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), main: path.join(root, 'proj') };
  for (const d of [f.home, f.config, f.main]) fs.mkdirSync(d, { recursive: true });
  f.store = storeFileFor(f.main, SLUG);
  addRun(f.store, { runId: RUNNING, task: 'A.1', token: 1, harness: 'codex', createdAt: '2026-11-08T05:00:00.000Z', startedAt: '2026-11-08T05:00:01.000Z', phase: 'running' });
  addRun(f.store, {
    runId: ENDED, task: 'A.2', token: 1, harness: 'codex', createdAt: '2026-11-08T04:00:00.000Z', startedAt: '2026-11-08T04:00:01.000Z',
    caller: { cwd: '/home/test/PLANTED-caller' }, prompt: { path: '/home/test/PLANTED-prompt.md' },
    readOnly: { status: 'clean', changes: ['PLANTED-change'] },
    report: { status: 'success', summary: 'PLANTED-summary' },
    output: { stdout: { path: 'worker-output/PLANTED.out.log', bytes: 0, written: 0, truncated: false } },
    phase: 'ended', end: { state: 'exited', at: '2026-11-08T04:03:00.000Z' },
  });
  const output = path.join(f.main, '.doflow', 'state', 'worker-output');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, `${RUNNING}.out.log`), 'compiling\nlinking\npartial');
  fs.writeFileSync(path.join(output, `${RUNNING}.last.log`), 'PLANTED-last-message\n');
  // No DOFLOW_UPKEEP or DOFLOW_TELEMETRY switch: the read-only case shows the verbs write nothing on their own.
  f.env = {
    HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.config,
    PATH: process.env.PATH, ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}),
    TMPDIR: process.env.TMPDIR, ...(process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
  };
  return f;
}

/** Inserts a run as `starting`, then writes every other field (and the phase) by one transition. */
function addRun(store: string, fields: any) {
  const { runId, task, token, harness, createdAt, ...rest } = fields;
  assert.equal(insertRun(store, { runId, task, token, harness, createdAt, phase: 'starting' }).applied, true);
  assert.equal(transition(store, runId, ['starting'], (r: any) => { Object.assign(r, rest); }).applied, true);
  return readRuns(store)[runId];
}

function run(f: any, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: f.main, env: f.env, encoding: 'utf8' });
}

/** A `--json` run: exactly one compact JSON line on stdout, parsed. */
function runJson(f: any, args: string[]) {
  const r = run(f, [...args, '--json']);
  assert.equal(r.stdout.indexOf('\n'), r.stdout.length - 1, `${args.join(' ')}: one stdout line, got ${r.stdout} / ${r.stderr}`);
  const json = JSON.parse(r.stdout);
  assert.equal(r.stdout, `${JSON.stringify(json)}\n`, 'the line is compact JSON');
  assert.equal(json.v, 1);
  return { ...r, json };
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

test('IC-002: worker-log --json prints one v 1 page of the out log; the partial last line waits', (t) => {
  const f = fixture(t);
  const r = runJson(f, ['worker-log', '--worker-run', RUNNING, '--stream', 'out', '--slug', SLUG]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.json), ['v', 'runId', 'stream', 'phase', 'log', 'ino', 'size', 'from', 'to', 'pieces', 'eof', 'reset', 'capped', 'cursor', 'before']);
  assert.equal(r.json.runId, RUNNING);
  assert.equal(r.json.phase, 'running');
  assert.equal(r.json.log, 'open');
  assert.deepEqual(r.json.pieces, [{ at: 0, text: 'compiling' }, { at: 10, text: 'linking' }]);
  assert.equal(r.json.to, 18);
  assert.match(r.json.cursor, /^[0-9]+:18:0:[0-9]+$/);
  assert.equal(r.stderr, '');
  // Without --slug the store that holds the run is found, as the worker:<runId> channel finds it.
  const found = runJson(f, ['worker-log', '--worker-run', RUNNING, '--stream', 'out', '--cursor', r.json.cursor]);
  assert.equal(found.status, 0, found.stderr);
  assert.deepEqual([found.json.from, found.json.to, found.json.pieces], [18, 18, []]);
  // The ended run never wrote its log: the record names the output, so the page says it is gone.
  const gone = runJson(f, ['worker-log', '--worker-run', ENDED, '--stream', 'out', '--slug', SLUG]);
  assert.equal(gone.status, 0, gone.stderr);
  assert.deepEqual([gone.json.log, gone.json.ino, gone.json.cursor], ['gone', null, null]);
});

test('IC-002: without --json worker-log prints the pieces as lines and one summary line on stderr', (t) => {
  const f = fixture(t);
  const r = run(f, ['worker-log', '--worker-run', RUNNING, '--stream', 'out', '--slug', SLUG]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'compiling\nlinking\n');
  assert.equal(r.stderr, `${RUNNING} out open bytes 0 to 18 of 25\n`);
});

test('IC-003: worker-result --json prints exactly the result fields; a missing run exits 1', (t) => {
  const f = fixture(t);
  const r = runJson(f, ['worker-result', '--worker-run', ENDED, '--slug', SLUG]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.json), ['v', 'runId', 'task', 'token', 'harness', 'phase', 'endState', 'endedAt', 'reportStatus', 'readOnly', 'isolation', 'resultOffered', 'withheld', 'quota']);
  assert.deepEqual([r.json.phase, r.json.endState, r.json.reportStatus, r.json.readOnly], ['ended', 'exited', 'success', 'clean']);
  assert.equal(r.stdout.includes('PLANTED'), false, 'nothing outside the result fields reaches the body');
  for (const args of [['--slug', SLUG], []]) {
    const missing = runJson(f, ['worker-result', '--worker-run', MISSING, ...args]);
    assert.equal(missing.status, 1, missing.stderr);
    assert.deepEqual(missing.json, { v: 1, ok: false, error: 'unknown-run' });
    assert.match(missing.stderr, /^doflow worker-result: .+\n$/);
  }
});

test('IC-004: worker-runs --json lists the feature\'s runs oldest first', (t) => {
  const f = fixture(t);
  const r = runJson(f, ['worker-runs', '--slug', SLUG]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.json), ['v', 'slug', 'store', 'runs', 'limits']);
  assert.deepEqual([r.json.slug, r.json.store], [SLUG, 'present']);
  assert.deepEqual(r.json.runs.map((x: any) => [x.runId, x.phase, x.endState]), [[ENDED, 'ended', 'exited'], [RUNNING, 'running', null]]);
  assert.deepEqual(r.json.limits, { shown: 2, notShown: 0 });
  const absent = runJson(f, ['worker-runs', '--slug', 'no-such-feature']);
  assert.equal(absent.status, 0, absent.stderr);
  assert.deepEqual([absent.json.store, absent.json.runs], ['absent', []]);
});

test('IC-002 to IC-004: an unknown flag, a bad run id and a bad stream exit 2 with the usage body', (t) => {
  const f = fixture(t);
  const cases = [
    ['worker-log', '--worker-run', RUNNING, '--stream', 'out', '--bogus'],
    ['worker-log', '--worker-run', 'w-NOT-A-RUN', '--stream', 'out'],
    ['worker-log', '--worker-run', RUNNING, '--stream', 'last'],
    ['worker-log', '--worker-run', RUNNING, '--stream', 'out', '--cursor', '1:0:0:0', '--before', '1:0:0:0'],
    ['worker-log', '--worker-run', RUNNING, '--stream', 'out', '--cursor', 'not-a-cursor'],
    ['worker-log', '--stream', 'out'],
    ['worker-result', '--worker-run', ENDED, '--bogus'],
    ['worker-result', '--worker-run', 'run-1'],
    ['worker-result', '--worker-run', ENDED, '--stream', 'out'],
    ['worker-runs', '--slug', SLUG, '--bogus'],
    ['worker-runs', '--slug', SLUG, '--worker-run', RUNNING],
  ];
  for (const args of cases) {
    const r = runJson(f, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.deepEqual(r.json, { v: 1, ok: false, error: 'usage' }, args.join(' '));
    assert.match(r.stderr, new RegExp(`^doflow ${args[0]}: .+\\n$`), args.join(' '));
    assert.ok(!r.stderr.includes('[ERROR]'), args.join(' '));
  }
});

test('NFR-007: a session of every verb leaves the project state, user state and config home byte-identical', (t) => {
  const f = fixture(t);
  // An upkeep-due marker in both state roots: upkeep, if it ran, would consume or rewrite it.
  for (const dir of [path.join(f.main, '.doflow', 'state'), path.join(f.home, '.doflow', 'state')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'upkeep-due'), '1\n');
  }
  fs.mkdirSync(path.join(f.config, 'doflow'), { recursive: true });
  const trees = [path.join(f.main, '.doflow'), f.home, f.config];
  const before = trees.map(treeSnapshot);
  const projectBefore = fs.readdirSync(f.main).sort();
  const calls = [
    ['worker-log', '--worker-run', RUNNING, '--stream', 'out', '--slug', SLUG, '--json'],
    ['worker-log', '--worker-run', RUNNING, '--stream', 'err', '--json'],
    ['worker-log', '--worker-run', ENDED, '--stream', 'out', '--slug', SLUG],
    ['worker-result', '--worker-run', RUNNING, '--json'],
    ['worker-result', '--worker-run', MISSING, '--slug', SLUG, '--json'],
    ['worker-runs', '--slug', SLUG, '--json'],
    ['worker-runs', '--slug', SLUG, '--bogus'],
  ];
  for (const args of calls) {
    const r = run(f, args);
    assert.ok([0, 1, 2].includes(r.status as number), `${args.join(' ')}: ${r.status} ${r.stderr}`);
    assert.equal(`${r.stdout}${r.stderr}`.includes('PLANTED'), false, `${args.join(' ')} prints no planted value`);
  }
  assert.deepEqual(trees.map(treeSnapshot), before);
  assert.deepEqual(fs.readdirSync(f.main).sort(), projectBefore, 'nothing was created beside .doflow');
});

test('NO_UPKEEP holds worker-log, worker-result and worker-runs (IC-005, NFR-007)', () => {
  const set = SOURCE.match(/const NO_UPKEEP = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'NO_UPKEEP is declared as a literal set');
  const names = set[1].split(',').map((v: string) => v.trim().replace(/'/g, ''));
  for (const verb of VERBS) assert.ok(names.includes(verb), `${verb} is in NO_UPKEEP`);
});
