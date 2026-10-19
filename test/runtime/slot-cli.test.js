'use strict';

// Feature 115 B.1 (IC-008): the `slot` verb through `bin/doflow.js` and the doflow-run dispatcher,
// in a scratch HOME. Every background process started here is this test's own child.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SLEEPER = 'setTimeout(() => {}, 120000)';

function scratch(t) {
  const dir = tempDir(t, 'doflow-slot-cli-');
  const home = path.join(dir, 'home');
  const cwdA = path.join(dir, 'a');
  const cwdB = path.join(dir, 'b');
  for (const d of [home, cwdA, cwdB]) fs.mkdirSync(d);
  const env = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '', DOFLOW_CLI: CLI,
  };
  delete env.DOFLOW_SLOT;
  const cli = (args, cwd = cwdA) => spawnSync(process.execPath, [CLI, 'slot', ...args], { cwd, env, encoding: 'utf8' });
  const dispatcher = (args, cwd = cwdA) => spawnSync('/bin/bash', [RUN, 'slot', ...args], { cwd, env, encoding: 'utf8' });
  const list = (cwd = cwdA) => {
    const done = cli(['--action', 'list', '--json'], cwd);
    assert.equal(done.status, 0, done.stderr);
    return JSON.parse(done.stdout);
  };
  const holder = (name, held) => {
    const child = spawn(process.execPath, [CLI, 'slot', '--action', 'run', '--name', name, ...(held.label ? ['--label', held.label] : []), '--', process.execPath, '-e', SLEEPER], { cwd: cwdA, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    return { child, exited };
  };
  const waitForHolder = async (name, cwd = cwdA) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const found = list(cwd).slots.find((slot) => slot.name === name && slot.holder && Number.isInteger(slot.holder.childPid));
      if (found) return found;
      assert.ok(Date.now() < deadline, `no holder for slot ${name} within 20 s`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  return { home, cwdA, cwdB, cli, dispatcher, list, holder, waitForHolder };
}

test('slot run passes the child exit code and prints the grant line on stderr only', (t) => {
  const s = scratch(t);
  const done = s.cli(['--action', 'run', '--name', 'suite', '--label', 'unit', '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(done.status, 3);
  assert.equal(done.stdout, '');
  assert.match(done.stderr, /^doflow slot: suite granted after \d+ s \(unit\)$/m);
  assert.equal(s.cli(['--action', 'run', '--name', 'suite', '--', process.execPath, '-e', '0']).status, 0);
  assert.deepEqual(s.list().slots, []);
});

test('the command argv reaches the child verbatim, flags included, with DOFLOW_SLOT set', (t) => {
  const s = scratch(t);
  const code = 'console.log(process.argv.slice(1).join(",") + "|" + process.env.DOFLOW_SLOT)';
  const done = s.cli(['--action', 'run', '--name', 'argv', '--', process.execPath, '-e', code, '--', '--x', '-y', '--json', '-h']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, '--x,-y,--json,-h|argv\n');
});

test('slot rejects missing or bad arguments with exit 2', (t) => {
  const s = scratch(t);
  const cases = [
    ['--action', 'run', '--name', 'x'],
    ['--action', 'run', '--name', 'x', '--'],
    ['--action', 'run', '--name', 'Bad_Name', '--', 'true'],
    ['--action', 'run', '--name', 'x', '--timeout', '0', '--', 'true'],
    ['--action', 'run', '--name', 'x', '--timeout', '86401', '--', 'true'],
    ['--action', 'run', '--', 'true'],
    ['--action', 'list', 'extra'],
    ['--action', 'list', '--bogus'],
    ['--action', 'release', '--name', 'x', '--by', 'me'],
    ['--action', 'release', '--name', 'x', '--reason', 'r'],
    ['--action', 'release', '--by', 'me', '--reason', 'r'],
    ['--action', 'bogus'],
    [],
  ];
  for (const args of cases) {
    const done = s.cli(args);
    assert.equal(done.status, 2, JSON.stringify(args) + ' ' + done.stderr);
    assert.equal(done.stdout, '', JSON.stringify(args));
    assert.match(done.stderr, /doflow slot:/, JSON.stringify(args));
  }
  const json = s.cli(['--action', 'run', '--name', 'x', '--json']);
  assert.equal(json.status, 2);
  assert.deepEqual({ ok: JSON.parse(json.stdout).ok, error: JSON.parse(json.stdout).error }, { ok: false, error: 'usage' });
});

test('tokens after -- are never read as doflow flags for the slot verb', (t) => {
  const s = scratch(t);
  const done = s.cli(['--action', 'run', '--name', 'dashes', '--', process.execPath, '-e', 'process.exit(0)', '--', '--action', 'bogus', '--name', 'Bad_Name']);
  assert.equal(done.status, 0, done.stderr);
});

test('a bare -- is still refused as an unknown flag for every other verb', (t) => {
  const s = scratch(t);
  const done = spawnSync(process.execPath, [CLI, 'workflow', '--', 'x'], { cwd: s.cwdA, env: process.env, encoding: 'utf8' });
  assert.equal(done.status, 1);
  assert.match(done.stderr, /unknown flag '--'/);
});

test('list on an empty machine, then a live holder, is visible from two directories and release refuses it', async (t) => {
  const s = scratch(t);
  assert.equal(s.cli(['--action', 'list']).stdout, 'no slots held\n');
  assert.deepEqual(s.list(), { ok: true, slots: [] });

  const bg = s.holder('shared', { label: 'long job' });
  const fromA = await s.waitForHolder('shared', s.cwdA);
  assert.equal(fromA.holder.label, 'long job');
  assert.equal(fromA.holder.cwd, s.cwdA);
  const fromB = s.list(s.cwdB).slots.find((slot) => slot.name === 'shared');
  assert.deepEqual(fromB, fromA);
  assert.match(s.cli(['--action', 'list'], s.cwdB).stdout, /^shared {2}held by \d+ \(long job\) since \S+; 0 waiting\n$/);

  const refused = s.cli(['--action', 'release', '--name', 'shared', '--by', 'tester', '--reason', 'try', '--json']);
  assert.equal(refused.status, 1);
  const body = JSON.parse(refused.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.disposition, 'holder-alive');
  assert.equal(body.holder.pid, fromA.holder.pid);

  const busy = s.cli(['--action', 'run', '--name', 'shared', '--no-wait', '--', process.execPath, '-e', 'process.exit(0)'], s.cwdB);
  assert.equal(busy.status, 75);
  assert.match(busy.stderr, /doflow slot: shared busy; held by \d+ \(long job\) since /);

  const timed = s.cli(['--action', 'run', '--name', 'shared', '--timeout', '1', '--', process.execPath, '-e', 'process.exit(0)'], s.cwdB);
  assert.equal(timed.status, 75);
  assert.match(timed.stderr, /doflow slot: shared timed out after \d+ s; held by \d+ \(long job\)/);

  // The holder is still the same one, and releasing a slot nobody holds is a success.
  assert.equal(s.list().slots.find((slot) => slot.name === 'shared').holder.pid, fromA.holder.pid);
  const free = s.cli(['--action', 'release', '--name', 'nothing-here', '--by', 'tester', '--reason', 'check', '--json']);
  assert.equal(free.status, 0);
  assert.deepEqual(JSON.parse(free.stdout), { ok: true, disposition: 'free' });

  bg.child.kill('SIGTERM');
  const ended = await bg.exited;
  assert.equal(ended.code, 143);
  assert.deepEqual(s.list().slots, []);
});

test('the doflow-run dispatcher forwards -- and every following argument unchanged', (t) => {
  const s = scratch(t);
  const code = 'console.log(process.argv.slice(1).join(",")); process.stderr.write("err-line\\n"); process.exit(4)';
  const done = s.dispatcher(['--action', 'run', '--name', 'disp', '--', process.execPath, '-e', code, '--', '--x', '-y']);
  assert.equal(done.status, 4, done.stderr);
  assert.equal(done.stdout, '--x,-y\n');
  assert.match(done.stderr, /granted after/);
  assert.match(done.stderr, /err-line/);
  const listed = s.dispatcher(['--action', 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, 'no slots held\n');
});
