'use strict';

// Feature 117 B.1 (IC-005): in-suite regressions for the task-attempt ledger's stale-lock defect.
// The lock in src/runtime/task-state.ts breaks a lock older than LOCK_STALE_MS without checking its
// holder and releases unconditionally, so a paused holder and a breaker both "own" the lock:
//
//   R-nested       one process: finish stalls inside its store read, the lock ages, cancel runs nested
//   R-two-process  round 3's P1 trace on S1 from a stale lock, replayed through the actor gate
//   R-claim        a double-grant trace on S2 from a stale lock, replayed through the actor gate
//
// Every regression asserts the correct behaviour (the oracle's PASS). While the defect is open its
// PASS test is `todo`: KNOWN_DEFECTS below is the marker list, and the fix removes its entries in the
// same commit, which turns the PASS tests required. Required checks keep the todo honest: each
// schedule completed (so a todo never fails for a harness reason), each todo names an open followup,
// and a todo that starts passing fails the suite until its marker is removed.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir, removeTree } = require('../helper/tmp.js');
const { runSchedule, GATED_METHODS } = require('../helper/sequence-gate.js');
const { SCENARIOS, DEFAULT_REPO, buildFixture, actorCall, ageLock } = require('../helper/ledger-scenarios.js');
const { check, MODEL_VERSION } = require('../helper/ledger-oracle.js');

// The open defects whose regressions are registered `todo`. FU-8acds5 is the stale-lock takeover race;
// FU-vgkrvd (the same lock's unconditional break and release) is the related followup the fix settles too.
const KNOWN_DEFECTS = [
  { id: 'R-nested', followup: 'FU-8acds5', defect: 'resurrected cancel' },
  { id: 'R-two-process', followup: 'FU-8acds5', defect: 'lost-ack' },
  { id: 'R-claim', followup: 'FU-8acds5', defect: 'double-grant' },
];
const FOLLOWUP_ID = /^FU-[a-z0-9]{6}$/;

// Round 3's P1 trace (S1, init stale; A = finish, B = cancel).
const P1 = 'B.mkdir A.mkdir B.stat A.stat B.rmdir B.mkdir B.exists A.rmdir A.mkdir A.exists B.readFile B.writeFile '
  + 'A.readFile A.writeFile A.rename B.rename A.rmdir B.rmdir';
// pinned: derived by hand; C.1 replaces it with the sampler's shortest trace.
// S2, init stale: both mkdirs fail, both stats see the stale lock, A breaks it and takes it, B breaks
// A's live lock and takes it, both read the empty task before either writes: both answer `claimed` token 1.
const R_CLAIM = 'A.mkdir B.mkdir A.stat B.stat A.rmdir A.mkdir B.rmdir B.mkdir A.exists B.exists A.readFile B.readFile '
  + 'A.writeFile A.rename B.writeFile B.rename A.rmdir B.rmdir';
const R_NESTED_TRACE = 'A.finish(readFile store) age-lock B.cancel(nested, to its end) A.finish(continues)';

const aFirst = (parked) => (parked.includes('A') ? 'A' : 'B');

/** R-nested (one process, no gate): finish's first store read ages the lock and runs cancel to its end. */
function runNested() {
  const started = performance.now();
  const dir = suiteTempDir('doflow-ledger-nested-');
  const [finish, cancel] = SCENARIOS.S1.actors;
  const outcomes = { A: { kind: 'NONE' }, B: { kind: 'NONE' } };
  const call = (name, op, args, fsImpl, fixture) => {
    try {
      outcomes[name] = { kind: 'DONE', response: actorCall({ fixture, op, args, fsImpl }) ?? null };
    } catch (error) {
      outcomes[name] = { kind: 'THREW', code: error?.code ?? null, message: String(error?.message ?? error) };
    }
  };
  try {
    const fixture = buildFixture({ dir, scenario: 'S1', init: 'none' });
    let fired = false;
    const slowFs = {
      ...fs,
      readFileSync: (p, ...rest) => {
        const data = fs.readFileSync(p, ...rest);
        if (!fired && p === fixture.file) {
          fired = true; // finish holds the lock and has read the store; it now "stalls" past LOCK_STALE_MS
          ageLock(fixture.file);
          call('B', cancel.op, cancel.args, fs, fixture);
        }
        return data;
      },
    };
    call('A', finish.op, finish.args, slowFs, fixture);
    let final = null;
    try { final = JSON.parse(fs.readFileSync(fixture.file, 'utf8')).tasks?.['A.1'] ?? null; } catch { /* null */ }
    return {
      scenario: 'S1', init: 'none', fault: { kind: 'age-lock', at: 0 }, trace: R_NESTED_TRACE, gatedMethods: [],
      actors: [{ ...finish, outcome: outcomes.A }, { ...cancel, outcome: outcomes.B }].map(({ name, op, args, outcome }) => ({ name, op, args, outcome })),
      final,
      incomplete: fired ? null : { cause: 'replay-divergence', detail: 'finish never read the store; cancel did not run nested' },
      ms: Math.round((performance.now() - started) * 10) / 10,
      maxRssKb: null,
    };
  } finally {
    removeTree(dir);
  }
}

const REGRESSIONS = [
  { id: 'R-nested', run: async () => runNested() },
  { id: 'R-two-process', run: () => runSchedule({ scenario: 'S1', init: 'stale', replay: P1 }) },
  { id: 'R-claim', run: () => runSchedule({ scenario: 'S2', init: 'stale', replay: R_CLAIM }) },
];
const SELF_TESTS = ['S1', 'S2'];

// Every schedule runs once, all at the same time; the required and the todo tests share the result.
const results = new Map();
before(async () => {
  const jobs = [
    ...REGRESSIONS.map((r) => [r.id, r.run]),
    ...SELF_TESTS.map((s) => [`self-${s}`, () => runSchedule({ scenario: s, init: 'none', chooser: aFirst })]),
  ];
  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  jobs.forEach(([key], i) => results.set(key, settled[i]));
});
const observation = (key) => {
  const r = results.get(key);
  if (r.status === 'rejected') throw r.reason;
  return r.value;
};

let commit;
/** The IC-006 identity a failure message carries. */
function identity(id, o) {
  if (commit === undefined) {
    const out = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: DEFAULT_REPO, encoding: 'utf8' });
    commit = out.status === 0 ? out.stdout.trim() : 'unknown';
  }
  return [`${id}: commit ${commit}`, `node ${process.version}`, `platform ${process.platform}`,
    `scenario ${o.scenario}`, `init ${o.init}`, `fault ${o.fault ? `${o.fault.kind}@${o.fault.at}` : 'none'}`,
    `trace ${o.trace}`, `gated ${o.gatedMethods.length ? o.gatedMethods.join(',') : 'n/a (in-process, ungated)'}`,
    `model ${MODEL_VERSION}`].join('; ');
}
const outcomes = (o) => JSON.stringify(o.actors.map((a) => ({
  [a.name]: a.outcome.kind === 'DONE' ? { disposition: a.outcome.response?.disposition, reason: a.outcome.response?.reason, token: a.outcome.response?.token } : a.outcome,
})));
const finalOf = (o) => JSON.stringify(o.final && o.final.attempts.map((a) => ({ token: a.token, state: a.state, result: a.result, cancel: 'cancel' in a })));

/** Entries of `knownDefects` whose followup id is in `settledIds`: markers the fix forgot to remove. */
function staleMarkers(knownDefects, settledIds) {
  return knownDefects.filter((entry) => settledIds.has(entry.followup));
}

/** The followup event store: the checkout's own, else the main checkout's when this is a worktree. */
function followupEventsDir() {
  const roots = [DEFAULT_REPO];
  const out = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: DEFAULT_REPO, encoding: 'utf8' });
  if (out.status === 0) roots.push(path.dirname(out.stdout.trim()));
  return roots.map((r) => path.join(r, '.doflow', 'state', 'lifecycle', 'events')).find((d) => fs.existsSync(d)) ?? null;
}

/** Ids named by `followup.settled` events in `dir` (read-only). */
function settledFollowups(dir) {
  const ids = new Set();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let event;
    try { event = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (event?.type === 'followup.settled' && typeof event.data?.id === 'string') ids.add(event.data.id);
  }
  return ids;
}

// ── regressions ─────────────────────────────────────────────────────────────────────────────────

const registeredTodos = [];
for (const { id } of REGRESSIONS) {
  const marker = KNOWN_DEFECTS.find((k) => k.id === id);

  test(`${id}: the schedule completes, both actors DONE`, () => {
    const o = observation(id);
    assert.equal(o.incomplete, null, `${identity(id, o)}; incomplete ${JSON.stringify(o.incomplete)}`);
    assert.deepEqual(o.actors.map((a) => a.outcome.kind), ['DONE', 'DONE'], `${identity(id, o)}; outcomes ${outcomes(o)}`);
  });

  const options = marker ? { todo: `${marker.followup} known ${marker.defect} defect; the Phase C lock fix removes this marker` } : {};
  if (marker) registeredTodos.push({ id, todo: options.todo });
  test(`${id}: the history is linearizable (oracle PASS)`, options, () => {
    const o = observation(id);
    const v = check(o);
    assert.equal(v.verdict, 'PASS', `${identity(id, o)}; verdict ${v.verdict} ${v.class ?? ''}: ${v.detail}; outcomes ${outcomes(o)}; final ${finalOf(o)}`);
  });

  if (marker) {
    test(`${id}: a todo regression that starts passing is reported`, () => {
      const o = observation(id);
      if (check(o).verdict === 'PASS') {
        assert.fail(`${id} now PASSES while marked todo: remove the marker and settle ${marker.followup} (${identity(id, o)})`);
      }
    });
  }
}

// ── required controls ───────────────────────────────────────────────────────────────────────────

for (const scenario of SELF_TESTS) {
  test(`gate self-test: ${scenario} from lock none, no fault, A first completes and passes`, () => {
    const o = observation(`self-${scenario}`);
    assert.equal(o.incomplete, null, `${identity(scenario, o)}; ${JSON.stringify(o.incomplete)}`);
    assert.deepEqual(o.actors.map((a) => a.outcome.kind), ['DONE', 'DONE'], outcomes(o));
    const v = check(o);
    assert.equal(v.verdict, 'PASS', `${identity(scenario, o)}; ${v.class}: ${v.detail}`);
  });
}

test('oracle negative control: a recorded lost-ack history is a violation, a linearizable one passes', () => {
  const actor = (name, op, args, response) => ({ name, op, args, outcome: { kind: 'DONE', response } });
  const [finish, cancel] = SCENARIOS.S1.actors;
  // P1's outcome on the unfixed lock: both acknowledged, finish's write lost under cancel's rename.
  const lostAck = {
    scenario: 'S1', init: 'stale', fault: null, trace: P1, gatedMethods: [...GATED_METHODS].sort(), incomplete: null,
    actors: [
      actor('A', 'finish', finish.args, { disposition: 'applied', taskId: 'A.1', token: 1, result: 'BLOCKED' }),
      actor('B', 'cancel', cancel.args, { disposition: 'cancelled', taskId: 'A.1', token: 1 }),
    ],
    final: { nextToken: 2, attempts: [{ token: 1, state: 'cancelled', result: null, cancel: { by: 'lead', reason: 'stop' } }] },
  };
  const violation = check(lostAck);
  assert.deepEqual([violation.verdict, violation.class], ['VIOLATION', 'lost-ack']);
  // finish, then cancel finds no active attempt and refuses without writing.
  const linearizable = {
    ...lostAck,
    actors: [
      lostAck.actors[0],
      actor('B', 'cancel', cancel.args, { disposition: 'refused', taskId: 'A.1', token: 1, reason: 'no-active-attempt' }),
    ],
    final: { nextToken: 2, attempts: [{ token: 1, state: 'finished', result: 'BLOCKED' }] },
  };
  assert.equal(check(linearizable).verdict, 'PASS');
});

// ── todo safeguard (D-ORCH) ─────────────────────────────────────────────────────────────────────

test('todo safeguard: every todo regression names an open followup id', () => {
  const ids = new Set(REGRESSIONS.map((r) => r.id));
  assert.equal(registeredTodos.length, KNOWN_DEFECTS.length, 'every KNOWN_DEFECTS entry registers one todo');
  for (const entry of KNOWN_DEFECTS) {
    assert.ok(ids.has(entry.id), `${entry.id} names no regression in this file`);
    assert.match(entry.followup, FOLLOWUP_ID, `${entry.id}`);
  }
  for (const { id, todo } of registeredTodos) assert.match(todo, /FU-[a-z0-9]{6}/, id);
});

test('todo safeguard: staleMarkers flags a marker whose followup is settled (negative control)', () => {
  const known = [{ id: 'R-a', followup: 'FU-aaaaaa' }, { id: 'R-b', followup: 'FU-bbbbbb' }];
  assert.deepEqual(staleMarkers(known, new Set(['FU-bbbbbb', 'FU-zzzzzz'])), [known[1]]);
  assert.deepEqual(staleMarkers(known, new Set()), []);
});

test('todo safeguard: no todo marker outlives its settled followup', (t) => {
  const dir = followupEventsDir();
  if (!dir) {
    t.diagnostic('followup store absent: settled-marker check UNREACHED in this checkout');
    return;
  }
  const stale = staleMarkers(KNOWN_DEFECTS, settledFollowups(dir));
  assert.deepEqual(stale, [], `settled followups still marked todo: ${stale.map((s) => `${s.id} (${s.followup})`).join(', ')}; remove the markers`);
});

