'use strict';

// Feature 117 B.2 (IC-004, IC-006): the opt-in sampler's CLI contract, fast enough for the suite.

const test: any = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { exitCodeFor, resultLine, renderText } = require('../explore/ledger-sampler.ts');
const { LOST_ACK } = require('../helper/ledger-scenarios.ts');

const REPO = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO, 'test/explore/ledger-sampler.ts');

function run(args: any, options: any = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

function runAsync(args: any, options: any = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: REPO,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: any) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: any) => { stderr += chunk; });
    child.once('error', (error: any) => { clearTimeout(timer); reject(error); });
    child.once('close', (status: any, signal: any) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

test('CLI usage and bounded seeded JSON record', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--scenario/);
  assert.match(help.stdout, /--run-timeout-ms/);
  assert.match(help.stdout, /Exit codes: 0 .*; 1 .*; 2 .*; 3 /);
  assert.match(help.stdout, /in-call overlap, network filesystems, process death and win32 are outside this model/);
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(run(['--scenario', 'S1', '--schedules', '6000']).status, 2);

  // One seeded schedule: the IC-006 record and a detection-power entry. Seed determinism (the same seed
  // twice, another seed) runs on demand in test/explore/ledger-controls.js (117 D-ORCH budget option (b)).
  const first = run(['--scenario', 'S1', '--init', 'none', '--schedules', '1', '--seed', '1', '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const record = JSON.parse(first.stdout);
  assert.equal(record.scenario, 'S1');
  assert.equal(record.init, 'none');
  assert.equal(record.seed, 1);
  assert.equal(record.schedulesRun, 1);
  assert.ok(record.commit && record.nodeVersion && record.platform && record.fsNote && record.gatedMethods.length && record.modelVersion);
  assert.equal(record.oracle, 'real');
  assert.equal(record.faultAppliedCount, 0);
  assert.equal(record.result, 'no violation within bounds over 1 completed schedules; not a proof of safety or liveness');
  assert.match(renderText(record, []), /result: no violation within bounds over 1 completed schedules; not a proof of safety or liveness/);
  assert.match(record.traceDigest, /^[0-9a-f]{64}$/);
  assert.ok(record.detectionPower.some((entry: any) => entry.p === 0.01));
});

test('exit decision fails closed for any incomplete schedule and report-write failure', () => {
  const record = (verdictCounts: any) => ({ verdictCounts, timedOut: false });
  assert.equal(exitCodeFor(record({ PASS: 199, VIOLATION: 0, INCOMPLETE: 1 })), 3);
  assert.equal(exitCodeFor(record({ PASS: 198, VIOLATION: 1, INCOMPLETE: 1 })), 3);
  assert.equal(exitCodeFor(record({ PASS: 199, VIOLATION: 1, INCOMPLETE: 0 })), 1);
  assert.equal(exitCodeFor(record({ PASS: 200, VIOLATION: 0, INCOMPLETE: 0 })), 0);
  assert.equal(exitCodeFor(record({ PASS: 1, VIOLATION: 0, INCOMPLETE: 0 }), { emitFailed: true }), 3);
  assert.equal(exitCodeFor(record({ PASS: 1, VIOLATION: 0, INCOMPLETE: 0 }), { sourceExists: false }), 3);
  assert.match(resultLine({ verdictCounts: { INCOMPLETE: 0 }, incompleteCauses: {}, interrupted: 'SIGTERM' }), /INCOMPLETE: 0 schedules .*SIGTERM.*exploration incomplete, not a pass/);
  assert.equal(resultLine({ verdictCounts: { INCOMPLETE: 1 }, incompleteCauses: { 'fault-not-applied': 1 } }), 'INCOMPLETE: 1 schedules ({"fault-not-applied":1}); exploration incomplete, not a pass');
  assert.equal(resultLine({ verdictCounts: { INCOMPLETE: 0, VIOLATION: 1 }, incompleteCauses: {}, violationCounts: { 'lost-ack': 1 } }), 'violation: {"lost-ack":1}; replay strings above');
});

test('sampling oracle, unapplied fault, and output failures fail closed', async (t: any) => {
  const dir = tempDir(t, 'doflow-sampler-');
  const stub = path.join(dir, 'oracle.js');
  const invalidStub = path.join(dir, 'invalid-oracle.js');
  fs.writeFileSync(stub, "'use strict'; module.exports = { check: () => ({ verdict: 'PASS' }) };\n");
  fs.writeFileSync(invalidStub, "'use strict'; module.exports = { check: () => ({ verdict: 'BANANA' }) };\n");
  const [pass, invalid, fault, output]: any = await Promise.all([
    runAsync(['--scenario', 'S1', '--init', 'none', '--schedules', '2', '--seed', '1', '--json'], { env: { DOFLOW_SAMPLER_ORACLE: stub } }),
    runAsync(['--scenario', 'S1', '--init', 'none', '--schedules', '1', '--seed', '1', '--json'], { env: { DOFLOW_SAMPLER_ORACLE: invalidStub } }),
    runAsync(['--age-at', '999', '--scenario', 'S1', '--init', 'none', '--schedules', '2', '--seed', '1', '--json']),
    runAsync(['--scenario', 'S1', '--init', 'none', '--schedules', '1', '--out', path.join(dir, 'no-such-dir', 'x', 'r.json')]),
  ]);
  assert.equal(pass.status, 3, pass.stderr);
  const passRecord = JSON.parse(pass.stdout);
  assert.equal(passRecord.oracle, path.resolve(stub));
  assert.match(passRecord.result, /INCOMPLETE: 0 schedules .*oracle override is untrusted.*not a pass/i);

  assert.equal(invalid.status, 3, invalid.stderr);
  const invalidRecord = JSON.parse(invalid.stdout);
  assert.equal(invalidRecord.verdictCounts.INCOMPLETE, 1);
  assert.equal(invalidRecord.incompleteCauses['oracle-invalid-verdict'], 1);

  assert.equal(fault.status, 3, fault.stderr);
  const record = JSON.parse(fault.stdout);
  assert.equal(record.faultAppliedCount, 0);
  assert.equal(record.verdictCounts.INCOMPLETE, 2);
  assert.equal(record.incompleteCauses['fault-not-applied'], 2);
  assert.equal(output.status, 3);
  assert.match(output.stderr, /cannot write --out/);
});

test('replay reports lost acknowledgment through the real oracle under an override; timeout is incomplete', (t: any) => {
  const dir = tempDir(t, 'doflow-sampler-');
  const stub = path.join(dir, 'oracle.js');
  fs.writeFileSync(stub, "'use strict'; module.exports = { check: () => ({ verdict: 'PASS', class: null, detail: 'stub' }) };\n");
  const replay = run(['--scenario', 'S1', '--init', 'none', '--replay', LOST_ACK], { env: { DOFLOW_SAMPLER_ORACLE: stub } });
  assert.equal(replay.status, 1, replay.stderr);
  assert.match(replay.stdout, /lost-ack/);
  assert.ok(replay.stdout.includes(LOST_ACK));
  // --replay ignores the override and judges with the real oracle, so the record names it.
  assert.ok(replay.stdout.includes('oracle: real'));
  assert.match(replay.stdout, /result: violation/);

  const timeout = run(['--scenario', 'S1', '--init', 'none', '--schedules', '5', '--seed', '1', '--run-timeout-ms', '100', '--json']);
  assert.equal(timeout.status, 3, timeout.stderr);
  assert.equal(JSON.parse(timeout.stdout).schedulesRun, 1);
});
