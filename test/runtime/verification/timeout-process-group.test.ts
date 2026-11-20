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
  const runner: any = new VerificationContractRunner({ cwd });
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
