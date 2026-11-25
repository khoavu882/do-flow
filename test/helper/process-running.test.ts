'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { processRunning } = require('./process-running.ts');

// A zombie that stays one: the shell starts a short `sleep` in the background, prints its pid and becomes a long `sleep`, which
// never collects the exit status of the child it inherited. The child must still run when the shell execs: a child that has
// already exited is reaped by the shell itself (macOS CI: `kill ESRCH`), so no zombie would ever exist.
test('a running process is running; a zombie and a pid that is gone are not', { skip: process.platform === 'win32' && 'POSIX processes and ps' }, async (t) => {
  const holder = spawn('sh', ['-c', 'sleep 0.3 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* already gone */ } });
  const zombie = Number(await new Promise((resolve) => holder.stdout.once('data', (chunk: Buffer) => resolve(String(chunk).trim()))));
  assert.ok(zombie > 1, 'the shell printed its child\'s pid');
  for (let i = 0; i < 100 && processRunning(zombie); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotThrow(() => process.kill(zombie, 0), 'kill(pid, 0) still answers for the zombie');
  assert.equal(processRunning(zombie), false, 'the zombie runs nothing');
  assert.equal(processRunning(holder.pid), true, 'the sleep that holds it is running');
  // Review Seat B: a ps that gives no answer is not "gone"; kill(pid, 0) stands, so the zombie counts as running.
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try { assert.equal(processRunning(zombie), true, 'with no ps to ask, kill(pid, 0) is the answer'); } finally { process.env.PATH = savedPath; }
  // Only ESRCH is gone: pid 1 answers EPERM to a user that may not signal it, and is running either way.
  assert.equal(processRunning(1), true, 'pid 1 is running');
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  assert.equal(processRunning(holder.pid), false, 'a reaped pid is gone');
});
