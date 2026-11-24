'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { processRunning } = require('./process-running.ts');

// A zombie that stays one: the shell starts `true` in the background, prints its pid and becomes `sleep`, which never
// collects the exit status of the child it inherited.
test('a running process is running; a zombie and a pid that is gone are not', { skip: process.platform === 'win32' && 'POSIX processes and ps' }, async (t) => {
  const holder = spawn('sh', ['-c', 'true & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* already gone */ } });
  const zombie = Number(await new Promise((resolve) => holder.stdout.once('data', (chunk: Buffer) => resolve(String(chunk).trim()))));
  assert.ok(zombie > 1, 'the shell printed its child\'s pid');
  for (let i = 0; i < 100 && processRunning(zombie); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotThrow(() => process.kill(zombie, 0), 'kill(pid, 0) still answers for the zombie');
  assert.equal(processRunning(zombie), false, 'the zombie runs nothing');
  assert.equal(processRunning(holder.pid), true, 'the sleep that holds it is running');
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  assert.equal(processRunning(holder.pid), false, 'a reaped pid is gone');
});
