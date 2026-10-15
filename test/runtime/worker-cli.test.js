'use strict';

// Feature 081 C.4 (IC-025, IC-026; DEC-032): the `worker` verb wired through `bin/doflow.js` and
// the `doflow-run` dispatcher, against the real registry.
//
// No harness binary can start (NFR-002). A direct `bin/doflow.js` child is `process.execPath` with
// PATH set to an empty scratch bin/. The dispatcher child is `/bin/bash` with PATH set to a scratch
// bin/ holding only `node` (a link to process.execPath) and the two coreutils the dispatcher calls.
// The node directory itself is never put on PATH, because a global npm install puts harness CLIs
// such as `codex` and `gemini` there. Every child sets the five DOFLOW_* identity variables.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity'];
const ACTIONS = ['discover', 'probe', 'describe', 'select', 'run', 'status', 'cancel'];
const DISPATCHER_TOOLS = ['dirname', 'date'];

/** The first executable named `name` on this process's PATH. */
function onPath(name) {
  return (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, name))
    .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
}

function project(t, { dispatcher = false } = {}) {
  const dir = fs.realpathSync(tempDir(t, 'doflow-worker-cli-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const work = path.join(dir, 'project');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  if (dispatcher) {
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    for (const tool of DISPATCHER_TOOLS) {
      const found = onPath(tool);
      assert.ok(found, `${tool} must be on the test runner's PATH`);
      fs.symlinkSync(found, path.join(bin, tool));
    }
  }
  const env = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    TMPDIR: process.env.TMPDIR || '/tmp',
    DOFLOW_RUN_ID: 'r1',
    DOFLOW_LINEAGE_ID: 'main',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_WORKTREE: work,
    ...(dispatcher ? { DOFLOW_CLI: CLI } : {}),
  };
  const spawn = (cmd, args) => {
    const done = spawnSync(cmd, args, { cwd: work, env, encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(done.stdout); } catch { /* no JSON on stdout */ }
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, data };
  };
  return {
    bin,
    cli: (...args) => spawn(process.execPath, [CLI, 'worker', ...args]),
    run: (...args) => spawn('/bin/bash', [RUN, 'worker', ...args]),
  };
}

function assertNotOnPath(r) {
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.data.disposition, 'discovered');
  assert.deepEqual(r.data.harnesses.map((h) => h.harness).sort(), [...HARNESSES].sort());
  for (const h of r.data.harnesses) {
    assert.equal(h.present, false, `${h.harness} must not be found`);
    assert.equal(h.reason, 'not-on-path', `${h.harness}: ${h.reason}`);
  }
}

test('worker --action discover --json reports all eight harnesses not-on-path (bin/doflow.js)', (t) => {
  const p = project(t);
  assert.deepEqual(fs.readdirSync(p.bin), [], 'the scratch PATH holds nothing');
  assertNotOnPath(p.cli('--action', 'discover', '--json'));
});

test('worker --action discover --json reaches the CLI through the doflow-run dispatcher', (t) => {
  const p = project(t, { dispatcher: true });
  assert.deepEqual(fs.readdirSync(p.bin).sort(), ['node', ...DISPATCHER_TOOLS].sort(), 'the scratch PATH holds only node and the dispatcher tools');
  assertNotOnPath(p.run('--action', 'discover', '--json'));
});

test('worker --action select returns none-eligible with exit 1 and JSON', (t) => {
  const r = project(t).cli('--action', 'select', '--json');
  assert.equal(r.status, 1, r.stderr || r.stdout);
  assert.ok(r.data, `exit 1 must carry JSON on stdout: ${r.stdout}`);
  assert.equal(r.data.disposition, 'none-eligible');
  assert.deepEqual(r.data.candidates.map((c) => c.harness).sort(), [...HARNESSES].sort());
  assert.ok(r.data.candidates.every((c) => c.eligible === false));
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

test('worker --help lists the seven actions', (t) => {
  const r = project(t).cli('--help');
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => /^\s+worker: /.test(l));
  assert.ok(line, 'the help names the worker actions');
  assert.deepEqual(line.trim().replace(/^worker: /, '').split('|'), ACTIONS);
  assert.match(r.stdout, /^ {2}worker {2,}\S/m, 'worker has a command line in the help');
});
