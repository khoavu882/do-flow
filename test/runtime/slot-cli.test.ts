'use strict';

// Feature 115 B.1 (IC-008): the `slot` verb through `bin/doflow.js` and the doflow-run dispatcher,
// in a scratch HOME. Every background process started here is this test's own child.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SLEEPER = 'setTimeout(() => {}, 120000)';

function scratch(t: any) {
  const dir = tempDir(t, 'doflow-slot-cli-');
  const home = path.join(dir, 'home');
  const cwdA = path.join(dir, 'a');
  const cwdB = path.join(dir, 'b');
  for (const d of [home, cwdA, cwdB]) fs.mkdirSync(d);
  const livenessPreload = path.join(dir, 'slot-liveness-preload.cjs');
  fs.writeFileSync(livenessPreload, `
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      const loaded = originalLoad.call(this, request, parent, isMain);
      if (request.endsWith('process-tree.ts') && parent && parent.filename.endsWith('/src/runtime/slots.ts')) {
        return { ...loaded,
          procStart(pid) { return Number.isInteger(pid) && pid > 0 ? 'test-' + pid : null; },
          alive(proc) {
            if (!proc || !Number.isInteger(proc.pid) || proc.pid <= 0) return 'unknown';
            try { process.kill(proc.pid, 0); return true; }
            catch (error) { return error.code === 'ESRCH' ? false : error.code === 'EPERM' ? true : 'unknown'; }
          },
        };
      }
      return loaded;
    };
  `);
  const env: any = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    DOFLOW_CLI: CLI,
    NODE_OPTIONS: `--require=${livenessPreload}`,
  };
  delete env.DOFLOW_SLOT;
  delete env.FORCE_COLOR;
  const cli = (args: any, cwd: any = cwdA) => spawnSync(process.execPath, [CLI, 'slot', ...args], { cwd, env, encoding: 'utf8' });
  const dispatcher = (args: any, cwd: any = cwdA) => spawnSync('/bin/bash', [RUN, 'slot', ...args], { cwd, env, encoding: 'utf8' });
  const list = (cwd: any = cwdA) => {
    const done = cli(['--action', 'list', '--json'], cwd);
    assert.equal(done.status, 0, done.stderr);
    return JSON.parse(done.stdout);
  };
  const holder = (name: any, held: any) => {
    const child = spawn(process.execPath, [CLI, 'slot', '--action', 'run', '--name', name, ...(held.label ? ['--label', held.label] : []), '--', process.execPath, '-e', SLEEPER], { cwd: cwdA, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited: any = new Promise((resolve) => child.on('exit', (code: any, signal: any) => resolve({ code, signal })));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    return { child, exited };
  };
  const waitForHolder = async (name: any, cwd: any = cwdA) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const found = list(cwd).slots.find((slot: any) => slot.name === name && slot.holder && Number.isInteger(slot.holder.childPid));
      if (found) return found;
      assert.ok(Date.now() < deadline, `no holder for slot ${name} within 20 s`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  return { home, cwdA, cwdB, env, cli, dispatcher, list, holder, waitForHolder, livenessPreload };
}

function waitForFile(file: any, timeoutMs: any = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`file was not created: ${file}`));
      setTimeout(poll, 10);
    };
    poll();
  });
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
  const cases: any = [
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
  const fromB = s.list(s.cwdB).slots.find((slot: any) => slot.name === 'shared');
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
  assert.equal(s.list().slots.find((slot: any) => slot.name === 'shared').holder.pid, fromA.holder.pid);
  const free = s.cli(['--action', 'release', '--name', 'nothing-here', '--by', 'tester', '--reason', 'check', '--json']);
  assert.equal(free.status, 0);
  assert.deepEqual(JSON.parse(free.stdout), { ok: true, disposition: 'free' });

  bg.child.kill('SIGTERM');
  const ended: any = await bg.exited;
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

test('SIGKILL between spawn and registration keeps the gated command from running; the next caller is granted', async (t) => {
  const s = scratch(t);
  const dir = path.dirname(s.home);
  const runnerScript = path.join(dir, 'paused-slot-runner.cjs');
  const pauseFile = path.join(dir, 'child-spawned');
  const commandMarker = path.join(dir, 'command-ran');
  const nextMarker = path.join(dir, 'next-command-ran');
  const slotsFile = path.join(REPO_ROOT, 'src', 'runtime', 'slots.ts');
  const commandCode = `setTimeout(()=>require('node:fs').writeFileSync(process.env.RUNNER_MARKER,'ran'),100)`;
  fs.writeFileSync(runnerScript, `
    const fs = require('node:fs');
    const { runSlot } = require(process.env.SLOTS_MODULE || ${JSON.stringify(slotsFile)});
    const deps = {
      procStart(pid) {
        if (process.env.PAUSE_ON_CHILD === '1' && pid !== process.pid) {
          fs.writeFileSync(process.env.SLOT_PAUSE_FILE, 'spawned');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
        }
        return 'test-' + pid;
      },
      alive(proc) {
        try { process.kill(proc.pid, 0); return true; }
        catch (error) { return error.code === 'ESRCH' ? false : 'unknown'; }
      },
    };
    runSlot({ name: 'killed-runner', command: [process.execPath, '-e', ${JSON.stringify(commandCode)}], env: process.env, deps })
      .then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 99; });
  `);
  const runEnv: any = {
    ...s.env,
    HOME: s.home,
    XDG_CONFIG_HOME: path.join(s.home, '.config'),
    SLOT_PAUSE_FILE: pauseFile,
    PAUSE_ON_CHILD: '1',
    RUNNER_MARKER: commandMarker,
  };
  const runner = spawn(process.execPath, [runnerScript], {
    cwd: s.cwdA, env: runEnv, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let runnerStderr = '';
  runner.stderr.on('data', (chunk: any) => { runnerStderr += chunk; });
  const exited: any = new Promise((resolve) => runner.on('exit', (code: any, signal: any) => resolve({ code, signal })));
  t.after(async () => {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  });

  try {
    await waitForFile(pauseFile, 3000);
  } catch (error: any) {
    runner.kill('SIGKILL');
    await exited;
    throw new Error(`${error.message}; runner stderr: ${runnerStderr}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  runner.kill('SIGKILL');
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' }, runnerStderr);
  assert.equal(fs.existsSync(commandMarker), false, 'the child command did not cross the closed go gate');

  const next = spawnSync(process.execPath, [runnerScript], {
    cwd: s.cwdA,
    env: { ...runEnv, PAUSE_ON_CHILD: '0', RUNNER_MARKER: nextMarker },
    encoding: 'utf8',
  });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(fs.readFileSync(nextMarker, 'utf8'), 'ran');
  assert.equal(fs.existsSync(commandMarker), false);
});
