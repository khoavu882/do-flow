'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProbe } = require('../../src/runtime/health.ts');

/** A stub exec: the first `timeouts` calls time out the way execFileSync reports it, the rest answer. */
function stub(timeouts: number) {
  const calls: string[] = [];
  const impl = (bin: string) => {
    calls.push(bin);
    if (calls.length <= timeouts) throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' });
    return 'git version 2.50.0\n';
  };
  return { impl, calls };
}

test('the git probe is retried once after a timeout and then answers (FU-93wtsf)', () => {
  const s = stub(1);
  const probe = runProbe(['git', '--version'], { execFileImpl: s.impl });
  assert.equal(probe.ok, true);
  assert.equal(probe.output, 'git version 2.50.0');
  assert.equal(s.calls.length, 2);
});

test('the git probe that times out twice is reported timed out, after exactly two attempts', () => {
  const s = stub(2);
  const probe = runProbe(['git', '--version'], { execFileImpl: s.impl });
  assert.equal(probe.ok, false);
  assert.equal(probe.timedOut, true);
  assert.equal(s.calls.length, 2);
});

test('another probe is not retried after a timeout', () => {
  const s = stub(1);
  const probe = runProbe(['semble', '--version'], { execFileImpl: s.impl });
  assert.equal(probe.ok, false);
  assert.equal(probe.timedOut, true);
  assert.equal(s.calls.length, 1);
});

test('a git probe that fails without timing out is not retried', () => {
  const calls: string[] = [];
  const probe = runProbe(['git', '--version'], { execFileImpl: (bin: string) => { calls.push(bin); throw Object.assign(new Error('exit 1'), { status: 1 }); } });
  assert.equal(probe.ok, false);
  assert.equal(probe.timedOut, false);
  assert.equal(calls.length, 1);
});
