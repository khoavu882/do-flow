'use strict';

// Feature 117 (D-ORCH budget option (b)): the two slow controls of the sequence instrument, run on
// demand outside npm test: `node --test test/explore/ledger-controls.js`.
//   1. Completion-rule negative control: granting the next step on release instead of on re-park
//      must break the 20-replay determinism that test/state/sequence-gate.test.js asserts.
//   2. Sampler seed determinism: one seed gives byte-equal records (same trace digest) twice, and
//      another seed gives other schedules.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runSchedule } = require('../helper/sequence-gate.js');

const REPO = path.resolve(__dirname, '../..');
const SAMPLER = path.join(REPO, 'test/explore/ledger-sampler.js');
const P1 = 'B.mkdir A.mkdir B.stat A.stat B.rmdir B.mkdir B.exists A.rmdir A.mkdir A.exists B.readFile B.writeFile '
  + 'A.readFile A.writeFile A.rename B.rename A.rmdir B.rmdir';
const REPLAYS = 20;
const outcomeKey = (o) => JSON.stringify({ trace: o.trace, actors: o.actors.map((a) => a.outcome), final: o.final, incomplete: o.incomplete },
  (key, value) => (key === 'runKey' || key === 'execWorktree' ? undefined : value));

async function batch(n, make, width = 10) {
  const out = [];
  for (let i = 0; i < n; i += width) {
    out.push(...await Promise.all(Array.from({ length: Math.min(width, n - i) }, () => runSchedule(make()))));
  }
  return out;
}

// Measured over 200 release-mode replays: 123 final cancelled, 57 final finished, 20 replay-divergence,
// so 20 identical replays by chance has probability below 1e-4.
test('negative control: granting on release instead of on re-park breaks the 20-replay determinism', async () => {
  const runs = await batch(REPLAYS, () => ({ scenario: 'S1', init: 'stale', replay: P1, grantOn: 'release' }));
  const keys = new Set(runs.map(outcomeKey));
  assert.ok(keys.size > 1, `release-mode grants gave one outcome over ${runs.length} replays: ${[...keys][0]}`);
});

function sample(seed) {
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
