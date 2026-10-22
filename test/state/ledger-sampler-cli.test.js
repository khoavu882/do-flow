'use strict';

// Feature 117 B.2 (IC-004, IC-006): the opt-in sampler's CLI contract, fast enough for the suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.js');

const REPO = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO, 'test/explore/ledger-sampler.js');
const P1 = 'B.mkdir A.mkdir B.stat A.stat B.rmdir B.mkdir B.exists A.rmdir A.mkdir A.exists B.readFile B.writeFile A.readFile A.writeFile A.rename B.rename A.rmdir B.rmdir';

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

function stableRecord(stdout) {
  const record = JSON.parse(stdout);
  for (const key of Object.keys(record)) if (/^(ms|.*rss)/i.test(key)) delete record[key];
  delete record.msPerSchedule;
  return record;
}

test('CLI usage and bounded seeded JSON record', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--scenario/);
  assert.match(help.stdout, /--run-timeout-ms/);
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(run(['--scenario', 'S1', '--schedules', '6000']).status, 2);

  const args = ['--scenario', 'S1', '--init', 'none', '--schedules', '5', '--seed', '1', '--json'];
  const first = run(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const record = JSON.parse(first.stdout);
  assert.equal(record.scenario, 'S1');
  assert.equal(record.init, 'none');
  assert.equal(record.seed, 1);
  assert.equal(record.schedulesRun, 5);
  assert.ok(record.commit && record.nodeVersion && record.platform && record.fsNote && record.gatedMethods.length && record.modelVersion);
  assert.ok(record.detectionPower.some((entry) => entry.p === 0.01));
  const second = run(args);
  assert.equal(second.status, 0, second.stderr);
  assert.match(record.traceDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(stableRecord(second.stdout), stableRecord(first.stdout));
  const other = run(['--scenario', 'S1', '--init', 'none', '--schedules', '5', '--seed', '2', '--json']);
  assert.notEqual(JSON.parse(other.stdout).traceDigest, record.traceDigest, 'another seed gives other schedules');
});

test('replay reports the lost acknowledgment and per-run timeout is incomplete', () => {
  const replay = run(['--scenario', 'S1', '--init', 'stale', '--replay', P1]);
  assert.equal(replay.status, 1, replay.stderr);
  assert.match(replay.stdout, /lost-ack/);
  assert.ok(replay.stdout.includes(P1));

  const timeout = run(['--scenario', 'S1', '--init', 'none', '--schedules', '5', '--seed', '1', '--run-timeout-ms', '1', '--json']);
  assert.equal(timeout.status, 3, timeout.stderr);
  assert.equal(JSON.parse(timeout.stdout).schedulesRun, 1);
});

test('negative control: replay uses the real oracle after a sampler oracle stub says PASS', (t) => {
  const dir = tempDir(t, 'doflow-sampler-');
  const stub = path.join(dir, 'oracle.js');
  fs.writeFileSync(stub, "'use strict'; module.exports = { check: () => ({ verdict: 'PASS', class: null, detail: 'stub' }) };\n");
  const replay = run(['--scenario', 'S1', '--init', 'stale', '--replay', P1], { env: { DOFLOW_SAMPLER_ORACLE: stub } });
  assert.equal(replay.status, 1, replay.stderr);
  assert.match(replay.stdout, /lost-ack/);
});
