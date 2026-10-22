'use strict';

// Feature 117 A.1 (IC-001, IC-002): the actor gate over real child processes. Each schedule spawns
// two Node children that call the real task-attempt ledger with a gated fsImpl; the parent grants one
// gated fs call at a time. These cases check the gate itself (completion rule, faults, failure paths,
// ungated store calls), not the ledger's correctness, which is the oracle's job (A.2).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.js');
const { runSchedule, GATED_METHODS, parseTrace, formatTrace } = require('../helper/sequence-gate.js');

// Round 3's P1 trace on S1 from a stale lock (A = finish, B = cancel). On the unfixed lock it ends
// finish `applied`, cancel `cancelled`, final attempt `cancelled`: both acknowledged, one lost.
const P1 = 'B.mkdir A.mkdir B.stat A.stat B.rmdir B.mkdir B.exists A.rmdir A.mkdir A.exists B.readFile B.writeFile '
  + 'A.readFile A.writeFile A.rename B.rename A.rmdir B.rmdir';
const REPLAYS = 20;
// A runs to its end first. S1: B's cancel then finds no active attempt; S2: B's claim finds A's
// active attempt. Either way B refuses without writing, so B has no write or rename.
const A_FIRST = 'A.mkdir A.exists A.readFile A.writeFile A.rename A.rmdir B.mkdir B.exists B.readFile B.rmdir';

const aFirst = (parked) => (parked.includes('A') ? 'A' : 'B');
// The run key and exec worktree name the per-schedule temp dir, so they are left out of the comparison.
const outcomeKey = (o) => JSON.stringify({ trace: o.trace, actors: o.actors.map((a) => a.outcome), final: o.final, incomplete: o.incomplete },
  (key, value) => (key === 'runKey' || key === 'execWorktree' ? undefined : value));

/** Run `n` schedules from `make()`, `width` at a time. */
async function batch(n, make, width = 10) {
  const out = [];
  for (let i = 0; i < n; i += width) {
    out.push(...await Promise.all(Array.from({ length: Math.min(width, n - i) }, () => runSchedule(make()))));
  }
  return out;
}

/** Writes an actor module stub into a test temp dir; `body` is the function body over ({ fixture, fsImpl }). */
function stub(t, body) {
  const file = path.join(tempDir(t, 'doflow-seqgate-stub-'), 'actor.js');
  fs.writeFileSync(file, `'use strict';\nmodule.exports = ({ fixture, fsImpl }) => {\n${body}\n};\n`);
  return file;
}

/** Records the schedule's temp dir so a test can check it is gone afterwards. */
function dirProbe() {
  const seen = [];
  return { seen, onFixture: (fixture) => seen.push(fixture.cwd) };
}

test('gate: S1 and S2 from lock none complete, both DONE, every gated call traced', async () => {
  for (const scenario of ['S1', 'S2']) {
    const o = await runSchedule({ scenario, init: 'none', chooser: aFirst });
    assert.equal(o.incomplete, null, `${scenario}: ${JSON.stringify(o.incomplete)}`);
    assert.deepEqual(o.actors.map((a) => a.outcome.kind), ['DONE', 'DONE'], scenario);
    assert.deepEqual(o.gatedMethods, [...GATED_METHODS].sort());
    assert.equal(o.trace, A_FIRST, scenario);
    assert.ok(o.final && Array.isArray(o.final.attempts), scenario);
    assert.ok(o.ms > 0);
    assert.equal(formatTrace(parseTrace(o.trace)), o.trace);
  }
});

test('completion rule: the P1 trace replayed 20 times gives one outcome', async () => {
  const runs = await batch(REPLAYS, () => ({ scenario: 'S1', init: 'stale', replay: P1 }));
  const keys = new Set(runs.map(outcomeKey));
  assert.equal(keys.size, 1, [...keys].join('\n'));
  assert.equal(runs[0].incomplete, null);
  assert.equal(runs[0].trace, P1);
  // Recorded on the unfixed lock (e76352b0): finish applied, cancel cancelled, final cancelled.
});

// Measured over 200 release-mode replays: 123 final cancelled, 57 final finished, 20 replay-divergence,
// so 20 identical replays by chance has probability below 1e-4.
test('negative control: granting on release instead of on re-park breaks the 20-replay determinism', async () => {
  const runs = await batch(REPLAYS, () => ({ scenario: 'S1', init: 'stale', replay: P1, grantOn: 'release' }));
  const keys = new Set(runs.map(outcomeKey));
  assert.ok(keys.size > 1, `release-mode grants gave one outcome over ${runs.length} replays: ${[...keys][0]}`);
});

test('faults: init stale seeds a 60 s old lock; age-lock@k lets B break the lock A holds', async () => {
  let lockAgeMs = null;
  await runSchedule({
    scenario: 'S1', init: 'stale', chooser: aFirst,
    onFixture: (fixture) => { lockAgeMs = Date.now() - fs.statSync(`${fixture.file}.lock`).mtimeMs; },
  });
  assert.ok(lockAgeMs >= 59_000 && lockAgeMs < 70_000, `lock age ${lockAgeMs}`);

  // A takes the lock, then B tries four times in a row.
  const script = ['A', 'B', 'B', 'B', 'B'];
  const chooser = (parked, step) => script[step] ?? aFirst(parked);
  const aged = await runSchedule({ scenario: 'S1', init: 'none', fault: { kind: 'age-lock', at: 1 }, chooser });
  assert.ok(aged.trace.startsWith('A.mkdir age-lock@1 B.mkdir B.stat B.rmdir B.mkdir'), aged.trace);
  assert.deepEqual(aged.fault, { kind: 'age-lock', at: 1 });
  const fresh = await runSchedule({ scenario: 'S1', init: 'none', chooser });
  assert.ok(fresh.trace.startsWith('A.mkdir B.mkdir B.stat B.mkdir'), fresh.trace);
  assert.equal(fresh.fault, null);
  // The fault survives a replay round trip.
  assert.deepEqual(parseTrace(aged.trace).fault, { kind: 'age-lock', at: 1 });
});

test('failure path: a child that throws ends THREW and the temp dir is removed', async (t) => {
  const probe = dirProbe();
  const actorModule = stub(t, "fsImpl.existsSync(fixture.file);\nconst e = new Error('boom\\nline two'); e.code = 'EBOOM'; throw e;");
  const o = await runSchedule({ scenario: 'S1', init: 'none', chooser: aFirst, actorModule, onFixture: probe.onFixture });
  assert.equal(o.incomplete, null);
  for (const a of o.actors) assert.deepEqual(a.outcome, { kind: 'THREW', code: 'EBOOM', message: 'boom line two' });
  assert.equal(o.trace, 'A.exists B.exists');
  assert.equal(fs.existsSync(probe.seen[0]), false);
});

test('failure path: a child killed mid-schedule ends INCOMPLETE child-crash and the temp dir is removed', async (t) => {
  const probe = dirProbe();
  const actorModule = stub(t, "fsImpl.existsSync(fixture.file);\nprocess.kill(process.pid, 'SIGKILL');");
  const o = await runSchedule({ scenario: 'S1', init: 'none', chooser: aFirst, actorModule, onFixture: probe.onFixture });
  assert.equal(o.incomplete?.cause, 'child-crash', JSON.stringify(o.incomplete));
  assert.equal(o.actors[0].outcome.kind, 'NONE');
  assert.equal(fs.existsSync(probe.seen[0]), false);
});

test('failure path: a deadline overrun ends INCOMPLETE schedule-deadline and the temp dir is removed', async (t) => {
  const probe = dirProbe();
  const actorModule = stub(t, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);');
  const t0 = Date.now();
  const o = await runSchedule({ scenario: 'S1', init: 'none', chooser: aFirst, actorModule, deadlineMs: 300, onFixture: probe.onFixture });
  assert.equal(o.incomplete?.cause, 'schedule-deadline', JSON.stringify(o.incomplete));
  assert.ok(Date.now() - t0 < 3000, 'children were killed at the deadline');
  assert.deepEqual(o.actors.map((a) => a.outcome.kind), ['NONE', 'NONE']);
  assert.equal(fs.existsSync(probe.seen[0]), false);
});

test('ungated store call: a store path through an ungated fs method ends INCOMPLETE ungated-store-call', async (t) => {
  const probe = dirProbe();
  const actorModule = stub(t, "fsImpl.appendFileSync(fixture.file, ' ');\nreturn { ok: true };");
  const o = await runSchedule({ scenario: 'S1', init: 'none', chooser: aFirst, actorModule, onFixture: probe.onFixture });
  assert.equal(o.incomplete?.cause, 'ungated-store-call', JSON.stringify(o.incomplete));
  assert.match(o.incomplete.detail, /appendFileSync/);
  assert.equal(fs.existsSync(probe.seen[0]), false);
});

test('replay divergence: a trace that names the wrong call ends INCOMPLETE replay-divergence', async () => {
  const o = await runSchedule({ scenario: 'S1', init: 'none', replay: 'A.stat' });
  assert.equal(o.incomplete?.cause, 'replay-divergence', JSON.stringify(o.incomplete));
});
