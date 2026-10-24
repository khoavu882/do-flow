'use strict';

// Feature 117 (D-ORCH budget option (b)): the two slow controls of the sequence instrument, run on
// demand outside npm test: `node --test test/explore/ledger-controls.js`.
//   1. Completion-rule negative control: granting the next step on release instead of on re-park
//      must break the replay determinism that test/state/sequence-gate.test.js asserts.
//   2. Sampler seed determinism: one seed gives byte-equal records (same trace digest) twice, and
//      another seed gives other schedules.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const { runSchedule } = require('../helper/sequence-gate.ts');
const { INTERLEAVED } = require('../helper/ledger-scenarios.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const SAMPLER = path.join(REPO, 'test/explore/ledger-sampler.ts');
// More replays than the 20 the determinism test makes: one release-mode outcome is more likely here.
const REPLAYS = 40;
const outcomeKey = (o: any) => JSON.stringify({ trace: o.trace, actors: o.actors.map((a: any) => a.outcome), final: o.final, incomplete: o.incomplete },
  (key, value) => (['runKey', 'execWorktree', 'worktree'].includes(key) ? undefined : value));

async function batch(n: any, make: any, width = 10) {
  const out = [];
  for (let i = 0; i < n; i += width) {
    out.push(...await Promise.all(Array.from({ length: Math.min(width, n - i) }, () => runSchedule(make()))));
  }
  return out;
}

// Measured over 200 release-mode replays of INTERLEAVED (117 Phase C lock, fix round): 115 completed
// with one outcome, 85 replay-divergence, so 40 identical replays by chance has probability below 1e-5.
test('negative control: granting on release instead of on re-park breaks the replay determinism', async () => {
  const runs = await batch(REPLAYS, () => ({ scenario: 'S1', init: 'none', replay: INTERLEAVED, grantOn: 'release' }));
  const keys = new Set(runs.map(outcomeKey));
  assert.ok(keys.size > 1, `release-mode grants gave one outcome over ${runs.length} replays: ${[...keys][0]}`);
});

function sample(seed: any) {
  const out = spawnSync(process.execPath, [SAMPLER, '--scenario', 'S1', '--init', 'none', '--schedules', '5', '--seed', String(seed), '--json'],
    { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
  if (out.error) throw out.error;
  assert.equal(out.status, 0, out.stderr);
  const record = JSON.parse(out.stdout);
  for (const key of Object.keys(record)) if (/^(ms|.*rss)/i.test(key)) delete record[key];
  return record;
}

test('sampler seed determinism: one seed twice gives the same record, another seed other schedules', () => {
  const first = sample(1);
  assert.deepEqual(sample(1), first);
  assert.notEqual(sample(2).traceDigest, first.traceDigest);
});

test('sampler SIGTERM emits a partial record and removes actors and fixture dirs', async (t) => {
  const tmpRoot = tempDir(t, 'doflow-sampler-tmp-');
  const tracker = path.join(tmpRoot, 'track-spawns.js');
  const spawnLog = path.join(tmpRoot, 'spawns.jsonl');
  fs.writeFileSync(tracker, [
    "const fs = require('node:fs');",
    "const childProcess = require('node:child_process');",
    'const originalSpawn = childProcess.spawn;',
    'childProcess.spawn = function (...args) {',
    '  const child = originalSpawn.apply(this, args);',
    '  child.once(\'spawn\', () => fs.appendFileSync(process.env.DOFLOW_TEST_SPAWN_LOG, JSON.stringify({ pid: child.pid, argv: args[1] }) + \'\\n\'));',
    '  return child;',
    '};',
  ].join('\n'));
  const child = spawn(process.execPath, [SAMPLER, '--scenario', 'S1', '--init', 'none', '--schedules', '200', '--seed', '1', '--json'], {
    cwd: REPO,
    env: { ...process.env, TMPDIR: tmpRoot, DOFLOW_TEST_SPAWN_LOG: spawnLog, NODE_OPTIONS: `--require=${tracker}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: any) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: any) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code: any, signal: any) => resolve({ code, signal }));
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(child.exitCode, null, `sampler ended before SIGTERM: ${stderr}`);
    child.kill('SIGTERM');
    const result: any = await closed;
    assert.equal(result.code, 3, stderr);
    const record = JSON.parse(stdout);
    assert.ok(record.schedulesRun >= 1, `no completed schedule in partial record: ${stdout}`);
    assert.equal(record.interrupted, 'SIGTERM');
    assert.match(record.result, /INCOMPLETE: .*SIGTERM.*not a pass/);

    const spawned = fs.readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).map((line: any) => JSON.parse(line));
    const actors = spawned.filter((entry: any) => JSON.stringify(entry.argv).includes('--gate-actor') && JSON.stringify(entry.argv).includes(REPO));
    assert.ok(actors.length > 0, 'tracker did not observe any gate actors');
    const liveActors = actors.filter((actor: any) => {
      try { process.kill(actor.pid, 0); return true; } catch (error: any) { if (error.code === 'ESRCH') return false; throw error; }
    });
    assert.deepEqual(liveActors, [], `orphan gate actors remain: ${JSON.stringify(liveActors)}`);
    assert.deepEqual(fs.readdirSync(tmpRoot).filter((name: any) => name.startsWith('doflow-seqgate-')), [], 'sequence-gate fixture dirs remain in TMPDIR');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await closed.catch(() => {});
    }
    if (fs.existsSync(spawnLog)) {
      for (const line of fs.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (JSON.stringify(entry.argv).includes('--gate-actor')) process.kill(entry.pid, 'SIGKILL');
        } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }
});
