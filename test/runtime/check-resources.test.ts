'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { VerificationContractRunner, childCpuTicks } = require('../../src/runtime/verification/contract-runner.ts');
const { tempDir } = require('../helper/tmp.ts');

test('Linux busy child cpu_ms > 0 only when a Linux container exists', {
  skip: process.platform !== 'linux' ? 'Docker is not available here; Linux container required for /proc/self/stat' : false,
}, (t) => {
  const dir = tempDir(t, 'doflow-check-resources-linux-');
  const runner: any = new VerificationContractRunner({ cwd: dir });
  // Busy loop in child process to ensure measurable user+sys cpu ticks
  const res = runner.runCheck('busy-cpu', 'node -e "let x = 0; for (let i = 0; i < 2e7; i++) x += i;"');
  assert.equal(res.status, 'PASS');
  const metrics = runner.metrics.get(res);
  assert.ok(metrics, 'metrics recorded');
  assert.equal(metrics.resourceBasis, 'proc-children');
  assert.ok(typeof metrics.cpuMs === 'number' && metrics.cpuMs > 0, `expected cpuMs > 0, got ${metrics.cpuMs}`);
});

test('darwin asserts unreached-platform and cpu_ms is null (never 0)', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('darwin only test');
    return;
  }
  const dir = tempDir(t, 'doflow-check-resources-darwin-');
  const runner: any = new VerificationContractRunner({ cwd: dir });
  const res = runner.runCheck('darwin-check', 'node -e "process.exit(0)"');
  assert.equal(res.status, 'PASS');
  const metrics = runner.metrics.get(res);
  assert.ok(metrics, 'metrics recorded');
  assert.equal(metrics.resourceBasis, 'unreached-platform');
  assert.equal(metrics.cpuMs, null, 'cpuMs must be null, never 0 on non-Linux');
});

test('stubbed read fault yields unreached-read and null cpu_ms', (t) => {
  const dir = tempDir(t, 'doflow-check-resources-read-fault-');
  const stubFs: any = {
    ...fs,
    readFileSync: (p: any, ...args: any[]) => {
      if (typeof p === 'string' && p.includes('/proc/self/stat')) {
        throw new Error('EACCES: permission denied');
      }
      return fs.readFileSync(p, ...args);
    },
  };

  // Test childCpuTicks directly with stubbed fsImpl
  assert.equal(childCpuTicks(stubFs, 'linux'), null, 'childCpuTicks returns null on read fault');

  // Test in runner simulating Linux platform with throwing fsImpl
  const runner: any = new VerificationContractRunner({
    cwd: dir,
    fsImpl: stubFs,
    platform: 'linux',
  });
  const res = runner.runCheck('read-fault-check', 'node -e "process.exit(0)"');
  assert.equal(res.status, 'PASS');
  const metrics = runner.metrics.get(res);
  assert.ok(metrics, 'metrics recorded');
  assert.equal(metrics.resourceBasis, 'unreached-read');
  assert.equal(metrics.cpuMs, null);
});
