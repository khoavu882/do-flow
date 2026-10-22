'use strict';

// Feature 117 A.1 (IC-001, IC-002): the actor gate over real child processes. Each schedule spawns
// two Node children that call the real task-attempt ledger with a gated fsImpl; the parent grants one
// gated fs call at a time. These cases check the gate itself (completion rule, faults, failure paths,
// ungated store calls, cleanup when the parent dies), not the ledger's correctness, which is the
// oracle's job (A.2).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { tempDir, removeTree } = require('../helper/tmp.js');
const { runSchedule, GATED_METHODS, parseTrace, formatTrace, WATCHDOG_MARGIN_MS } = require('../helper/sequence-gate.js');
const { INTERLEAVED } = require('../helper/ledger-scenarios.js');

const GATE = path.join(__dirname, '../helper/sequence-gate.js');

const REPLAYS = 20;
// A runs to its end first. S1: B's cancel then finds no active attempt; S2: B's claim finds A's
// active attempt. Either way B refuses without writing, so B has no write or rename. Each actor makes
// the lock and its owner entry (mkdir mkdir) and lists the lock (readdir: it is alone, so it holds);
// A checks its entry is still there (exists) before its rename.
const A_FIRST = 'A.mkdir A.mkdir A.readdir A.exists A.readFile A.writeFile A.exists A.rename A.rmdir A.rmdir '
  + 'B.mkdir B.mkdir B.readdir B.exists B.readFile B.rmdir B.rmdir';

const aFirst = (parked) => (parked.includes('A') ? 'A' : 'B');
// The run key and the (exec) worktree name the per-schedule temp dir, so they are left out of the comparison.
const outcomeKey = (o) => JSON.stringify({ trace: o.trace, actors: o.actors.map((a) => a.outcome), final: o.final, incomplete: o.incomplete },
  (key, value) => (['runKey', 'execWorktree', 'worktree'].includes(key) ? undefined : value));

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

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Polls `check()` every 25 ms until it is true or `ms` pass; resolves to its last value. */
async function until(check, ms) {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await sleep(25);
  return check();
}
/** Live pids among `pids`, a zombie counted dead (a blocked parent cannot reap its killed children). */
const running = (pids) => {
  try { return execFileSync('ps', ['-o', 'stat=', '-p', pids.join(',')], { encoding: 'utf8' }).split('\n').filter((s) => s.trim() && !s.trim().startsWith('Z')).length; } catch { return 0; }
};
const psOf = (pids) => {
  try { return execFileSync('ps', ['-o', 'pid=,ppid=,command=', '-p', pids.join(',')], { encoding: 'utf8' }).trim(); } catch { return '(none)'; }
};

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

test('completion rule: the INTERLEAVED trace replayed 20 times gives one outcome', async () => {
  const runs = await batch(REPLAYS, () => ({ scenario: 'S1', init: 'none', replay: INTERLEAVED }));
  const keys = new Set(runs.map(outcomeKey));
  assert.equal(keys.size, 1, [...keys].join('\n'));
  assert.equal(runs[0].incomplete, null);
  assert.equal(runs[0].trace, INTERLEAVED);
  // Recorded on the 117 Phase C lock: finish applied, cancel refused, final finished.
});

// The grant-on-release negative control (the completion rule reverted must break this determinism)
// runs on demand in test/explore/ledger-controls.js, outside npm test (117 D-ORCH budget option (b)).

test('faults: init stale seeds a 60 s old lock; age-lock@k lets B reclaim the lock A holds', async () => {
  let lockAgeMs = null;
  await runSchedule({
    scenario: 'S1', init: 'stale', chooser: aFirst,
    onFixture: (fixture) => { lockAgeMs = Date.now() - fs.statSync(`${fixture.file}.lock`).mtimeMs; },
  });
  assert.ok(lockAgeMs >= 59_000 && lockAgeMs < 70_000, `lock age ${lockAgeMs}`);

  // A takes the lock (mkdir, owner entry, list), then B makes eight calls in a row: on the aged lock
  // they list it, enter it, check it is the same directory, remove A's entry and list it again; on a
  // fresh one B only retries. Then the two alternate, so neither waits on the other forever.
  const script = ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'B', 'B', 'B', 'B'];
  const chooser = (parked, step) => {
    const want = script[step] ?? (step % 2 ? 'B' : 'A');
    return parked.includes(want) ? want : parked[0];
  };
  const aged = await runSchedule({ scenario: 'S1', init: 'none', fault: { kind: 'age-lock', at: 4 }, chooser });
  assert.ok(aged.trace.startsWith('A.mkdir A.mkdir A.readdir A.exists age-lock@4 B.mkdir B.stat B.readdir B.stat B.mkdir B.stat B.rmdir B.readdir'), aged.trace);
  assert.deepEqual(aged.fault, { kind: 'age-lock', at: 4 });
  assert.equal(aged.faultApplied, true);
  assert.equal(aged.incomplete, null);
  const fresh = await runSchedule({ scenario: 'S1', init: 'none', chooser });
  assert.ok(fresh.trace.startsWith('A.mkdir A.mkdir A.readdir A.exists B.mkdir B.stat B.mkdir B.stat'), fresh.trace);
  assert.equal(fresh.fault, null);
  assert.equal(fresh.faultApplied, null);
  // The fault survives a replay round trip.
  assert.deepEqual(parseTrace(aged.trace).fault, { kind: 'age-lock', at: 4 });
});

test('faults: a requested age-lock that never took effect ends INCOMPLETE fault-not-applied', async () => {
  // at 999: the schedule ends before grant 999. at 0 from init none: no lock exists before the first grant.
  const [late, early] = await Promise.all([999, 0].map((at) => runSchedule({ scenario: 'S1', init: 'none', fault: { kind: 'age-lock', at }, chooser: aFirst })));
  for (const o of [late, early]) {
    assert.equal(o.incomplete?.cause, 'fault-not-applied', JSON.stringify(o.incomplete));
    assert.equal(o.faultApplied, false);
  }
  assert.equal(late.trace, A_FIRST, 'no age-lock token: the fault never applied');
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

test('ungated store call: node:fs, fs.promises, a re-spelled path and a descriptor end INCOMPLETE ungated-store-call', async (t) => {
  // Each stub first parks once through the gate, so only the ungated call can end it INCOMPLETE.
  // The store spelled through a symlink to its directory: only the dirname's realpath matches it (N-3).
  const link = path.join(tempDir(t, 'doflow-seqgate-link-'), 'dir');
  const cases = [
    ['promises.writeFile', "fsImpl.promises.writeFile(fixture.file, '{}').catch(() => {});"],
    ['renameSync', "require('node:fs').renameSync(fixture.file, fixture.file);"], // the direct-node:fs shape
    ['appendFileSync', "fsImpl.appendFileSync(fixture.file.replace('/task-attempts/', '/task-attempts/./'), '');"],
    ['openSync', "require('node:fs').closeSync(require('node:fs').openSync(fixture.file, 'r'));"],
    ['appendFileSync', `fsImpl.appendFileSync(require('node:path').join(${JSON.stringify(link)}, require('node:path').basename(fixture.file)), '');`,
      (fixture) => fs.symlinkSync(path.dirname(fixture.file), link)],
  ];
  if (process.platform === 'darwin' || process.platform === 'win32') {
    cases.push(['appendFileSync', "fsImpl.appendFileSync(fixture.file.replace(/feat-race\\.json$/, 'FEAT-RACE.json'), '');"]);
  }
  const runs = await Promise.all(cases.map(([, call, onFixture]) => runSchedule({
    scenario: 'S1', init: 'none', chooser: aFirst, onFixture, actorModule: stub(t, `fsImpl.existsSync(fixture.file);\n${call}\nreturn { ok: true };`),
  })));
  runs.forEach((o, i) => {
    assert.equal(o.incomplete?.cause, 'ungated-store-call', `${cases[i][1]}: ${JSON.stringify(o.incomplete)}`);
    assert.match(o.incomplete.detail, new RegExp(`called ${cases[i][0].replace('.', '\\.')} on`), cases[i][1]);
  });
});

test('lock directory: a path under <store>.lock is lock-class, gated by a gated method and detected by any other', async (t) => {
  // An owner record inside the lock dir (N-1): the writeFileSync parks and is traced; unlinkSync is ungated.
  const actorModule = stub(t, "const lock = fixture.file + '.lock';\nfsImpl.mkdirSync(lock);\n"
    + "fsImpl.writeFileSync(lock + '/owner', String(process.pid));\nfsImpl.unlinkSync(lock + '/owner');\nfsImpl.rmdirSync(lock);\nreturn { ok: true };");
  const o = await runSchedule({ scenario: 'S1', init: 'none', chooser: aFirst, actorModule });
  assert.match(o.trace, /^A\.mkdir A\.writeFile\b/, o.trace);
  assert.equal(o.incomplete?.cause, 'ungated-store-call', JSON.stringify(o.incomplete));
  assert.match(o.incomplete.detail, /called unlinkSync on/);
});

test('vacuous schedules: no gated call, or an unreadable final store, end INCOMPLETE', async (t) => {
  const touch = stub(t, 'fsImpl.existsSync(fixture.file);\nreturn { ok: true };');
  const [none, dir, garbage] = await Promise.all([
    runSchedule({ scenario: 'S1', init: 'none', chooser: aFirst, actorModule: stub(t, "const e = new Error('plan gone'); e.code = 'EPLAN'; throw e;") }),
    runSchedule({ scenario: 'S1', init: 'none', chooser: aFirst, actorModule: touch, onFixture: (f) => { fs.rmSync(f.file); fs.mkdirSync(f.file); } }),
    runSchedule({ scenario: 'S1', init: 'none', chooser: aFirst, actorModule: touch, onFixture: (f) => fs.writeFileSync(f.file, '{"tasks":') }),
  ]);
  assert.equal(none.incomplete?.cause, 'no-store-call', JSON.stringify(none.incomplete));
  assert.deepEqual(none.actors.map((a) => a.outcome.kind), ['THREW', 'THREW']);
  assert.equal(dir.incomplete?.cause, 'store-unreadable', JSON.stringify(dir.incomplete));
  assert.match(dir.incomplete.detail, /EISDIR/);
  assert.equal(garbage.incomplete?.cause, 'store-unreadable', JSON.stringify(garbage.incomplete));
  for (const o of [dir, garbage]) assert.equal(o.final, null);
});

/**
 * Starts a driver process that runs one schedule whose actors hang outside waitGrant (Atomics.wait
 * before any fs call), waits until both actors run, then sends `signal` to the driver alone. With
 * `blockMs` instead of a signal, the driver blocks its own event loop for `blockMs` once both actors
 * run, before its deadline (`BLOCK`, else `LATE`): only the watchdog's timer can then end them.
 * Resolves `{ pids, dir, driverExit, driverAlive, gone, out, ms }` once the actors are dead and the
 * dir is gone, or `waitMs` passed; `ms` counts from the signal, or from `BLOCK`.
 */
async function orphanCase(t, { signal = null, blockMs = 0, deadlineMs, waitMs }) {
  const work = tempDir(t, 'doflow-seqgate-driver-');
  const pidsFile = path.join(work, 'pids');
  const actorModule = stub(t, `require('node:fs').appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');\n`
    + 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);');
  const driverFile = path.join(work, 'driver.js');
  fs.writeFileSync(driverFile, `'use strict';
const fs = require('node:fs');
const { runSchedule, abortAll } = require(${JSON.stringify(GATE)});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => {
  const first = abortAll();
  fs.writeSync(1, 'ABORT ' + JSON.stringify([first, abortAll()]) + '\\n');
  process.exit(3);
});
const start = Date.now();
runSchedule({ scenario: 'S1', init: 'none', chooser: (p) => p[0], deadlineMs: ${deadlineMs}, actorModule: ${JSON.stringify(actorModule)},
  onFixture: (f) => fs.writeSync(1, 'DIR ' + f.cwd + '\\n') });
if (${blockMs} > 0) {
  const poll = setInterval(() => {
    let n = 0;
    try { n = fs.readFileSync(${JSON.stringify(pidsFile)}, 'utf8').trim().split('\\n').length; } catch { return; }
    if (n < 2) return;
    clearInterval(poll);
    if (Date.now() - start >= ${deadlineMs}) { fs.writeSync(1, 'LATE\\n'); return; }
    fs.writeSync(1, 'BLOCK\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMs});
  }, 10);
}
`);
  const t0 = Date.now();
  const driver = spawn(process.execPath, [driverFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  driver.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => { driver.on('exit', (code, sig) => resolve(sig || code)); });
  let seen = []; // kept here: tempDir's own after hook may remove pidsFile first
  const pidsOf = () => {
    try { seen = fs.readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { /* not yet */ }
    return seen;
  };
  let dir = null;
  t.after(() => {
    for (const pid of seen) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    try { process.kill(driver.pid, 'SIGKILL'); } catch { /* gone */ }
    if (dir) removeTree(dir);
  });
  assert.ok(await until(() => pidsOf().length === 2 && /^DIR /m.test(out), 5000), `actors never started: ${out}`);
  dir = /^DIR (.+)$/m.exec(out)[1];
  const pids = pidsOf();
  if (blockMs > 0) {
    assert.ok(await until(() => /^(BLOCK|LATE)$/m.test(out), 5000), `the driver never blocked: ${out}`);
    assert.match(out, /^BLOCK$/m, 'the driver blocked before its own deadline could act');
    const blocked = Date.now();
    const gone = await until(() => !fs.existsSync(dir) && running(pids) === 0, waitMs);
    return { pids, dir, driverExit: null, driverAlive: isAlive(driver.pid), gone, out, ms: Date.now() - blocked };
  }
  assert.ok(pids.every(isAlive) && Date.now() - t0 < deadlineMs, 'the actors hang and the driver deadline has not passed');
  const signalled = Date.now();
  driver.kill(signal);
  const driverExit = await exited;
  const gone = await until(() => !pids.some(isAlive) && !fs.existsSync(dir), waitMs);
  return { pids, dir, driverExit, driverAlive: false, gone, out, ms: Date.now() - signalled };
}

// The watchdog's timer path waits deadline + WATCHDOG_MARGIN_MS, so it starts with the file and its
// wait overlaps the tests above; the parent-death test below collects it. Cleanup runs in after().
const cleanups = [];
const fileContext = { after: (fn) => cleanups.push(fn) };
let timerPath;
before(() => {
  timerPath = orphanCase(fileContext, { blockMs: 6000, deadlineMs: 800, waitMs: 800 + WATCHDOG_MARGIN_MS + 1000 });
  timerPath.catch(() => { /* reported by the test that awaits it */ });
});
after(() => { for (const fn of cleanups.reverse()) fn(); });

test('parent death: a hung actor outside waitGrant does not outlive its parent, nor its fixture dir', { concurrency: true }, async (t) => {
  await Promise.all([
    t.test('SIGTERM to the parent alone: abortAll() in its handler kills the actors and removes the dir', async (t2) => {
      const r = await orphanCase(t2, { signal: 'SIGTERM', deadlineMs: 20000, waitMs: 2000 });
      assert.ok(r.gone, `after ${r.ms} ms; dir left: ${fs.existsSync(r.dir)}; live: ${psOf(r.pids)}`);
      assert.equal(r.driverExit, 3);
      // Two actors and the watchdog killed, one dir removed; a second call finds nothing.
      assert.match(r.out, /^ABORT \[\{"killed":3,"removed":1\},\{"killed":0,"removed":0\}\]$/m);
    }),
    t.test('SIGKILL to the parent (no handler runs): the watchdog sees stdin close and cleans up long before its timer', async (t2) => {
      // The watchdog's timer is 21 s away: only the stdin-EOF path can end the actors within 1.5 s.
      const r = await orphanCase(t2, { signal: 'SIGKILL', deadlineMs: 20000, waitMs: 1500 });
      assert.ok(r.gone, `after ${r.ms} ms; dir left: ${fs.existsSync(r.dir)}; live: ${psOf(r.pids)}`);
      assert.equal(r.driverExit, 'SIGKILL');
    }),
    t.test('a parent alive but blocked (no handler, no stdin EOF): the watchdog timer cleans up by deadline + margin', async () => {
      const r = await timerPath;
      assert.ok(r.gone, `after ${r.ms} ms; dir left: ${fs.existsSync(r.dir)}; live: ${psOf(r.pids)}`);
      assert.ok(r.driverAlive, 'the driver was still alive (blocked) when the actors died');
    }),
  ]);
});

test('replay divergence: a trace that names the wrong call ends INCOMPLETE replay-divergence', async () => {
  const o = await runSchedule({ scenario: 'S1', init: 'none', replay: 'A.stat' });
  assert.equal(o.incomplete?.cause, 'replay-divergence', JSON.stringify(o.incomplete));
});
