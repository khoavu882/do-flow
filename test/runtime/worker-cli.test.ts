'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Feature 081 C.4 (IC-025, IC-026; DEC-032): the `worker` verb wired through `bin/doflow.js` and
// the `doflow-run` dispatcher, against the real registry.
//
// No harness binary can start (NFR-002). A direct `bin/doflow.js` child is `process.execPath` with
// PATH set to an empty scratch bin/. The dispatcher child is `/bin/bash` with PATH set to a scratch
// bin/ holding only `node` (a link to process.execPath) and the two coreutils the dispatcher calls.
// The node directory itself is never put on PATH, because a global npm install puts harness CLIs
// such as `codex` and `agy` there. Every child sets the five DOFLOW_* identity variables.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { ACTIVE_HARNESS_IDS } = require('../helper/harness-ids.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const HARNESSES: any = ACTIVE_HARNESS_IDS;
const ACTIONS: any = ['discover', 'probe', 'describe', 'select', 'run', 'status', 'cancel', 'evidence', 'start-session', 'start-options', 'login-state'];
const DISPATCHER_TOOLS: any = ['dirname', 'date'];
const WIN = process.platform === 'win32';

/** The first executable named `name` on this process's PATH. */
function onPath(name: any) {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  return (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, file))
    .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
}

function project(t: any, { dispatcher = false }: any = {}) {
  const dir = fs.realpathSync(tempDir(t, 'doflow-worker-cli-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const work = path.join(dir, 'project');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  const toolDirs = new Set<string>();
  if (dispatcher) {
    fs.symlinkSync(process.execPath, path.join(bin, WIN ? 'node.exe' : 'node'));
    for (const tool of DISPATCHER_TOOLS) {
      const found = onPath(tool);
      assert.ok(found, `${tool} must be on the test runner's PATH`);
      // A Git for Windows tool needs the msys runtime beside it, so a link elsewhere would not start: its own directory joins the PATH.
      if (WIN) toolDirs.add(path.dirname(found)); else fs.symlinkSync(found, path.join(bin, tool));
    }
  }
  const env: any = {
    PATH: [bin, ...toolDirs].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    TMPDIR: process.env.TMPDIR || (WIN ? process.env.TEMP : '/tmp'),
    DOFLOW_RUN_ID: 'r1',
    DOFLOW_LINEAGE_ID: 'main',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_WORKTREE: work,
    ...(dispatcher ? { DOFLOW_CLI: CLI } : {}),
  };
  const spawn = (cmd: any, args: any, edit?: any) => {
    const done = spawnSync(cmd, args, { cwd: work, env: edit ? edit({ ...env }) : env, encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(done.stdout); } catch { /* no JSON on stdout */ }
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, data };
  };
  return {
    bin,
    work,
    /** `cli` with the child's env edited by `edit` (given a copy), for a terminal outside any run or a worker session. */
    cliEnv: (edit: any, ...args: any[]) => spawn(process.execPath, [CLI, 'worker', ...args], edit),
    cli: (...args: any[]) => spawn(process.execPath, [CLI, 'worker', ...args]),
    run: (...args: any[]) => spawn(bashPath(), [RUN, 'worker', ...args]),
  };
}

function assertNotOnPath(r: any) {
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.data.disposition, 'discovered');
  assert.deepEqual(r.data.harnesses.map((h: any) => h.harness).sort(), [...HARNESSES].sort());
  for (const h of r.data.harnesses) {
    assert.equal(h.present, false, `${h.harness} must not be found`);
    assert.equal(h.reason, 'not-on-path', `${h.harness}: ${h.reason}`);
  }
}

test('worker --action discover --json reports all seven harnesses not-on-path (bin/doflow.js)', (t) => {
  const p = project(t);
  assert.deepEqual(fs.readdirSync(p.bin), [], 'the scratch PATH holds nothing');
  assertNotOnPath(p.cli('--action', 'discover', '--json'));
});

test('worker --action discover --json reaches the CLI through the doflow-run dispatcher', (t) => {
  const p = project(t, { dispatcher: true });
  assert.deepEqual(fs.readdirSync(p.bin).sort(), WIN ? ['node.exe'] : ['node', ...DISPATCHER_TOOLS].sort(), 'the scratch PATH holds only node and the dispatcher tools');
  assertNotOnPath(p.run('--action', 'discover', '--json'));
});

test('worker --action select returns none-eligible with exit 1 and JSON', (t) => {
  const r = project(t).cli('--action', 'select', '--json');
  assert.equal(r.status, 1, r.stderr || r.stdout);
  assert.ok(r.data, `exit 1 must carry JSON on stdout: ${r.stdout}`);
  assert.equal(r.data.disposition, 'none-eligible');
  assert.deepEqual(r.data.candidates.map((c: any) => c.harness).sort(), [...HARNESSES].sort());
  assert.ok(r.data.candidates.every((c: any) => c.eligible === false));
  assert.deepEqual(r.data.fallback.modes, ['sequential', 'manual']);
});

test('a missing --action is exit 2 usage', (t) => {
  const r = project(t).cli('--json');
  assert.equal(r.status, 2, r.stderr || r.stdout);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.error, 'usage');
  assert.match(r.data.message, /--action is required/);
});

test('--wait on status is exit 2 usage', (t) => {
  const r = project(t).cli('--action', 'status', '--wait', '--worker-run', 'w-0123456789ab', '--slug', 'feat-x', '--json');
  assert.equal(r.status, 2, r.stderr || r.stdout);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.error, 'usage');
  assert.match(r.data.message, /--wait/);
});

test('--reason with no value is a parser usage error: exit 1 and no JSON on stdout', (t) => {
  const r = project(t).cli('--action', 'cancel', '--json', '--reason');
  assert.equal(r.status, 1, r.stderr || r.stdout);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /--reason requires a value/);
});

test('worker --help lists the eleven actions, the evidence flags included', (t) => {
  const r = project(t).cli('--help');
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l: any) => /^\s+worker: /.test(l));
  assert.ok(line, 'the help names the worker actions');
  assert.deepEqual(line.trim().replace(/^worker: /, '').split('|'), ACTIONS);
  assert.match(r.stdout, /^ {2}worker {2,}\S/m, 'worker has a command line in the help');
  assert.match(r.stdout, /--checks, --out, --docs-root, --project-key,\n\s+--worktree-key, --entry\s+worker \(/, 'the help lists the evidence flags --checks, --out and --docs-root');
  assert.match(r.stdout, /evidence: --harness --out and exactly one of --checks/);
});

// ── 162 IC-004, IC-005: --operator and --via reach the verb through bin/doflow.js ───────────────

const OPERATOR_SLUG = 'feat-op';
const OPERATOR_RUN = 'w-0a1b2c3d4e5f';
const OPERATOR_VIA = 'device.d-0a1b2c3d4e5f';

/** A person's own terminal: every DOFLOW_* identity variable removed. */
function deskEnv(env: any) {
  for (const key of Object.keys(env)) if (key.startsWith('DOFLOW_')) delete env[key];
  return env;
}

/** A project with one `running` worker run whose caller is another lineage's; no process is started. */
function seededProject(t: any) {
  const p = project(t);
  fs.mkdirSync(path.join(p.work, '.git'));
  const store = path.join(p.work, '.doflow', 'state', 'worker-runs', `${OPERATOR_SLUG}.json`);
  const { insertRun } = require('../../src/runtime/worker/run-store.ts');
  const record = {
    runId: OPERATOR_RUN, task: 'A.1', token: 1, harness: 'claude', phase: 'running', execWorktree: p.work,
    createdAt: new Date().toISOString(), timeoutSeconds: 60,
    caller: { cwd: p.work, runKey: 'other-lineage', run: 'r9', lineage: 'other', attempt: null, role: 'main', lineageKind: 'default-main' },
    needs: [],
  };
  assert.equal(insertRun(store, record).applied, true);
  const cancel = (edit: any, ...extra: any[]) => p.cliEnv(edit, '--action', 'cancel', '--slug', OPERATOR_SLUG, '--worker-run', OPERATOR_RUN, '--reason', 'x', '--json', ...extra);
  const status = () => p.cliEnv(deskEnv, '--action', 'status', '--slug', OPERATOR_SLUG, '--worker-run', OPERATOR_RUN, '--json');
  return { p, store, cancel, status };
}

test('worker --action cancel --operator --via from a terminal outside any run ends the run, and status shows cancelBy', (t) => {
  const { store, cancel, status } = seededProject(t);
  const done = cancel(deskEnv, '--operator', '--via', OPERATOR_VIA);
  assert.equal(done.status, 0, done.stderr || done.stdout);
  assert.equal(done.data.disposition, 'cancelled');
  assert.equal(done.data.endState, 'cancelled');
  const read = status();
  assert.equal(read.status, 0, read.stderr || read.stdout);
  assert.equal(read.data.state, 'cancelled');
  assert.deepEqual({ by: read.data.cancelBy.by, source: read.data.cancelBy.source }, { by: OPERATOR_VIA, source: 'operator' });
  assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).runs[OPERATOR_RUN].cancel.source, 'operator');
});

test('worker --action cancel --operator in a worker session is refused operator-in-run and writes nothing', (t) => {
  const { store, cancel } = seededProject(t);
  const before = fs.readFileSync(store);
  const r = cancel((env: any) => { deskEnv(env); env.DOFLOW_SESSION_ROLE = 'worker'; return env; }, '--operator', '--via', 'console');
  assert.equal(r.status, 1, r.stderr || r.stdout);
  assert.deepEqual([r.data.disposition, r.data.reason], ['refused', 'operator-in-run']);
  assert.deepEqual(fs.readFileSync(store), before, 'a refused cancel leaves the store byte-identical');
});

test('worker --operator without --via, and --via without --operator, are exit 2 usage', (t) => {
  const { store, cancel } = seededProject(t);
  const before = fs.readFileSync(store);
  for (const flags of [['--operator'], ['--via', 'console']]) {
    const r = cancel(deskEnv, ...flags);
    assert.equal(r.status, 2, `${flags.join(' ')}: ${r.stderr || r.stdout}`);
    assert.deepEqual([r.data.ok, r.data.error], [false, 'usage']);
  }
  assert.deepEqual(fs.readFileSync(store), before, 'a usage error writes nothing');
});
