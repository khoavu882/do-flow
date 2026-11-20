'use strict';
// FU-rfbjrm: a contract check that hit its timeout killed only the shell it spawned; a grandchild (a
// `node --test` worker under `npm test`) was left running under init. The runner now starts the check
// as a process-group leader and kills the whole group on a timeout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../helper/tmp.ts');
const { VerificationContractRunner } = require('../../../src/runtime/verification/contract-runner.ts');
const { VerificationEngine } = require('../../../src/runtime/verification/engine.ts');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== 'ESRCH'; }
}

async function gone(pid: number, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

test('a timed-out check leaves no grandchild running', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = tempDir(t, 'doflow-verification-pgroup-');
  const pidFile = path.join(cwd, 'grandchild.pid');
  // The sleeper is a grandchild that keeps the check's stdout open, as a node --test worker does.
  const command = `echo started; sleep 300 & echo $! > ${JSON.stringify(pidFile)}; wait`;
  // The runner the verify verb uses: the engine builds it with no exec of its own.
  const runner: any = new VerificationEngine({ cwd }).runner;
  const result = runner.runCheck('hangs', command, 1000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.exitCode, 124);
  assert.equal(result.error, 'TimeoutExpired');
  assert.match(result.stdout, /started/, 'output captured before the kill is kept');
  assert.equal(await gone(pid), true, 'the grandchild is killed with the check');
});

test('a check that finishes in time keeps its exit code and output', (t) => {
  const cwd = tempDir(t, 'doflow-verification-pgroup-');
  const runner: any = new VerificationContractRunner({ cwd });
  const ok = runner.runCheck('ok', 'echo out; echo err 1>&2', 5000);
  assert.equal(ok.status, 'PASS');
  assert.match(ok.stdout, /out/);
  assert.match(ok.stderr, /err/);
  const bad = runner.runCheck('bad', 'exit 3', 5000);
  assert.equal(bad.status, 'FAIL');
  assert.equal(bad.exitCode, 3);
});

// Review R-01: the check's own process group no longer gets a terminal's Ctrl-C, so the runner forwards
// INT/TERM/HUP to it. The runner sits in a fresh process group, as doflow does under a terminal, and the
// SIGINT goes to that whole group the way Ctrl-C does. The marker rides in the check's argv; a node sleeper
// stands in for `exec -a <marker> sleep`, which dash (/bin/sh on Linux) does not support.
const { spawn, spawnSync } = require('node:child_process');

function markerPids(marker: string): number[] {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return String(ps.stdout || '').split('\n').filter((line) => line.includes(marker))
    .map((line) => Number(line.trim().split(/\s+/)[0])).filter((pid) => Number.isInteger(pid) && pid > 1);
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test('a SIGINT to the runner\'s process group kills the check\'s own group', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = tempDir(t, 'doflow-verification-pgroup-');
  const marker = `doflow-r01-${process.pid}-${Date.now()}`;
  t.after(() => { for (const pid of markerPids(marker)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } });
  const script = path.join(cwd, 'run-check.js');
  fs.writeFileSync(script, [
    // The runner the verify verb uses: the engine builds it with no exec of its own.
    `const { VerificationEngine } = require(${JSON.stringify(require.resolve('../../../src/runtime/verification/engine.ts'))});`,
    `new VerificationEngine({ cwd: ${JSON.stringify(cwd)} }).runner.runCheck('sleeps', process.env.R01_CHECK, 60000);`,
  ].join('\n'));
  const check = `exec ${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 40000)" ${marker}`;
  const runner = spawn(process.execPath, [script], { cwd, detached: true, stdio: 'ignore', env: { ...process.env, R01_CHECK: check } });
  const exited = new Promise((resolve) => runner.on('exit', resolve));
  assert.equal(await until(() => markerPids(marker).length > 0, 10000), true, 'the check started');
  process.kill(-runner.pid, 'SIGINT');
  await exited;
  assert.equal(await until(() => markerPids(marker).length === 0, 5000), true, `no process carries ${marker}`);
});

// Review R-08: the guard re-raised the check's signal on itself, but Node ignores SIGPIPE and takes SIGUSR1
// for its inspector, so a check that died by either read as PASS. Each death reports as a plain spawn does.
test('a check killed by a signal reports it as a plain spawn does', { skip: process.platform === 'win32' }, (t) => {
  const cwd = tempDir(t, 'doflow-verification-pgroup-');
  const guarded: any = new VerificationContractRunner({ cwd });
  const plain: any = new VerificationContractRunner({ cwd, exec: spawnSync });
  const shape = (r: any) => ({ status: r.status, exitCode: r.exitCode, error: r.error, stdout: r.stdout, stderr: r.stderr });
  for (const signal of ['SIGPIPE', 'SIGUSR1', 'SIGSEGV']) {
    const command = `echo before; kill -${signal.slice(3)} $$`;
    const result = guarded.runCheck(`guarded-${signal}`, command, 10000);
    assert.equal(result.status, 'FAIL', `${signal} is not a PASS`);
    assert.equal(result.error, `Terminated by signal ${signal}`);
    assert.deepEqual(shape(result), shape(plain.runCheck(`plain-${signal}`, command, 10000)));
  }
});
