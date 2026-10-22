'use strict';

// Feature 117 B.1 (IC-005): in-suite regressions for the task-attempt ledger's stale-lock defect.
// Up to e003dc0d the lock in src/runtime/task-state.ts broke a lock older than LOCK_STALE_MS without
// checking its holder and released unconditionally, so a paused holder and a breaker both "owned" the
// lock. 117 Phase C (FU-8acds5, FU-vgkrvd) gave the lock an owner entry, an in-place reclaim and a
// pre-write ownership check; these regressions now run required:
//
//   R-nested       one process: finish stalls inside its store read, the lock ages, cancel runs nested
//   R-two-process  S1 from a stale lock: both actors judge it stale before either acts on it; A acts
//                  first and reaches its store read, then B acts on its judgement
//   R-claim        S2 from a stale lock: the same rule with B acting first, then A
//
// R-two-process and R-claim are chooser rules over the parked calls, not replay strings, so they hold
// for any lock implementation: on develop up to e003dc0d each ends in an oracle VIOLATION (the second
// actor's stale break removes the first one's live lock, a lost acknowledgement or a double grant).
//
// Every regression asserts the correct behaviour (the oracle's PASS). A known open defect's PASS test
// is `todo`: KNOWN_DEFECTS below is the marker list, and a fix removes its entries in the same commit,
// which turns the PASS tests required. Required checks keep a todo honest: each schedule completed (so
// a todo never fails for a harness reason), each todo names an open followup, and a todo that starts
// passing fails the suite until its marker is removed.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, suiteTempDir, removeTree } = require('../helper/tmp.js');
const { runSchedule, GATED_METHODS } = require('../helper/sequence-gate.js');
const { SCENARIOS, DEFAULT_REPO, buildFixture, actorCall, ageLock } = require('../helper/ledger-scenarios.js');
const { check, MODEL_VERSION } = require('../helper/ledger-oracle.js');

// The open defects whose regressions are registered `todo`. FU-8acds5 is the stale-lock takeover race;
// FU-vgkrvd (the same lock's unconditional break and release) is the related followup the fix settles too.
// 117 Phase C settled both and removed their three markers (R-nested, R-two-process, R-claim).
const KNOWN_DEFECTS = [];
const FOLLOWUP_ID = /^FU-[a-z0-9]{6}$/;
// The regressions this file must always run, pinned apart from the todo list: Phase C removes todo
// markers, never these ids, so dropping a regression together with its marker still fails (C-13).
const REQUIRED_REGRESSIONS = ['R-nested', 'R-two-process', 'R-claim'];

// Round 3's P1 trace (S1, init stale; A = finish, B = cancel): the lost-ack on the pre-fix lock (e003dc0d
// and earlier). It no longer replays: the fixed lock makes other fs calls. Kept as the oracle control below.
const P1 = 'B.mkdir A.mkdir B.stat A.stat B.rmdir B.mkdir B.exists A.rmdir A.mkdir A.exists B.readFile B.writeFile '
  + 'A.readFile A.writeFile A.rename B.rename A.rmdir B.rmdir';

/**
 * The chooser rule of R-two-process and R-claim: "both judge the stale lock before either acts on it".
 * Both actors run to their first stat of the lock (each judges it stale); then `first` runs until it
 * is parked on its store read (it holds the lock); then the other runs on its judgement, up to 12 calls
 * or until it too is parked on its store read; then the two alternate, `first` first, to the end.
 */
function bothJudgeFirst(first) {
  const second = first === 'A' ? 'B' : 'A';
  let phase = 'judge';
  let secondCalls = 0;
  let turn = 0;
  return (parked, step, { methods, trace }) => {
    const has = (name) => parked.includes(name);
    if (phase === 'judge') {
      for (const name of ['A', 'B']) if (has(name) && !trace.includes(`${name}.stat`)) return name;
      phase = 'first';
    }
    if (phase === 'first') {
      if (has(first) && methods[first] !== 'readFile') return first;
      phase = 'second';
    }
    if (phase === 'second') {
      if (has(second) && methods[second] !== 'readFile' && secondCalls < 12) { secondCalls += 1; return second; }
      phase = 'alternate';
    }
    turn += 1;
    const want = turn % 2 ? first : second;
    return has(want) ? want : parked[0];
  };
}
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
  { id: 'R-two-process', run: () => runSchedule({ scenario: 'S1', init: 'stale', chooser: bothJudgeFirst('A') }) },
  { id: 'R-claim', run: () => runSchedule({ scenario: 'S2', init: 'stale', chooser: bothJudgeFirst('B') }) },
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

// ── followup store, read the way the runtime reads it (C-3) ───────────────────────────────────────
// The store lives under the IC-001 project root (root.ts `projectRoot`, DEC-043: the main worktree of a
// clone), never a linked worktree's own `.doflow`. It is folded by the runtime's own `loadFollowups`
// (event-store `readFold` + fold `withDerivedDone`), so batch `ids`, `kept`/`fix` (item stays open)
// and a taken item whose feature derives `finished` all read as the runtime reads them.
const lifecycle = (file) => require(path.join(DEFAULT_REPO, 'src/runtime/lifecycle', file));
const STORE_REL = path.join('.doflow', 'state', 'lifecycle', 'events');
const SETTLED_STATES = new Set(['done', 'dismissed']);

// `readEvents` can write: when the retention journal's generation moves it falls back to the store
// lock (task-state acquireLock: mkdirSync/rmdirSync). The safeguard therefore reads through an fs whose
// every write method throws, so a read that would write fails loudly instead of touching the store.
// (deriveStatuses also runs git, read-only: log, for-each-ref, rev-parse, rev-list, tag --list.)
const WRITE_METHOD = /^(write|writev|append|appendFile|mkdir|mkdtemp|rename|rm|rmdir|unlink|copyFile|cp|symlink|link|chmod|lchmod|fchmod|chown|lchown|fchown|utimes|lutimes|futimes|truncate|ftruncate|createWriteStream)(File)?(Sync)?$/;
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
const refuseWrite = (name) => { throw Object.assign(new Error(`read-only fs: ${name} refused`), { code: 'EROFS' }); };
/** `base` with every write method throwing; `onCall(name)` sees each method the reader uses. */
function readOnlyFs(base = fs, onCall = () => {}) {
  return new Proxy(base, {
    get(target, key) {
      const value = target[key];
      if (typeof key !== 'string') return value;
      if (key === 'promises') return refuseWrite(key); // no async reader is expected; refuse the whole namespace
      if (WRITE_METHOD.test(key)) return () => refuseWrite(key);
      if (key === 'openSync' || key === 'open') {
        return (file, flags = 'r', ...rest) => {
          onCall(key);
          const writes = typeof flags === 'number' ? (flags & WRITE_FLAGS) !== 0 : !/^(r|rs|sr)$/.test(String(flags));
          return writes ? refuseWrite(`${key}(${String(flags)})`) : value.call(target, file, flags, ...rest);
        };
      }
      if (typeof value !== 'function') return value;
      return (...args) => { onCall(key); return value.apply(target, args); };
    },
  });
}

/** The followup store this checkout's runtime reads: under the project root, never a worktree's own. */
const followupRoot = (cwd) => lifecycle('root.ts').projectRoot(cwd);
const storeExists = (root) => fs.existsSync(path.join(root, STORE_REL));

/** The runtime's own derivation (git reads; ~0.45 s on this repository), the default `derive`. */
const deriveStatuses = ({ root, fold }) => lifecycle('status.ts').deriveStatuses({ root, fold });

/**
 * Ids the runtime folds to `done` (derived done included) or `dismissed`, read without writing.
 * Given `markers`, feature statuses are derived only when a marker's own followup is `taken`: derived
 * done changes nothing but a taken item, so for any other store an empty `statuses` gives the same
 * answer for the markers without running git. `statuses` injects a derivation outright.
 */
function settledFollowupIds(root, { fsImpl = readOnlyFs(), statuses, markers, derive = deriveStatuses } = {}) {
  let given = statuses;
  if (!given) {
    const fold = lifecycle('event-store.ts').readFold(root, { fsImpl });
    const wanted = markers ? new Set(markers.map((m) => m.followup)) : null;
    const needed = fold.followups.some((item) => item.state === 'taken' && (!wanted || wanted.has(item.id)));
    given = needed ? derive({ root, fold }) : { statuses: {} };
  }
  const { followups } = lifecycle('followup.ts').loadFollowups(root, { fsImpl, statuses: given });
  return new Set(followups.filter((item) => SETTLED_STATES.has(item.state)).map((item) => item.id));
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

test('todo safeguard: the required regression ids are all present and every marker names one of them', () => {
  const sorted = (list) => [...list].sort();
  assert.deepEqual(sorted(REGRESSIONS.map((r) => r.id)), sorted(REQUIRED_REGRESSIONS), 'REGRESSIONS must run exactly REQUIRED_REGRESSIONS');
  for (const entry of KNOWN_DEFECTS) assert.ok(REQUIRED_REGRESSIONS.includes(entry.id), `${entry.id} is not a required regression`);
});

/** The live safeguard over the followup store under `root`; an absent store is a visible skip. */
function checkNoStaleMarker(t, root) {
  if (!storeExists(root)) {
    t.skip('UNREACHED: followup store absent');
    return;
  }
  const stale = staleMarkers(KNOWN_DEFECTS, settledFollowupIds(root, { markers: KNOWN_DEFECTS }));
  assert.deepEqual(stale, [], `settled followups still marked todo: ${stale.map((s) => `${s.id} (${s.followup})`).join(', ')}; remove the markers`);
}

test('todo safeguard: no todo marker outlives its settled followup', (t) => checkNoStaleMarker(t, followupRoot(DEFAULT_REPO)));

test('todo safeguard: an absent followup store skips the live check visibly, and does nothing else', (t) => {
  const calls = [];
  const recorder = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); } });
  checkNoStaleMarker(recorder, tempDir(t, 'doflow-ledger-nostore-'));
  assert.deepEqual(calls, [['skip', 'UNREACHED: followup store absent']]);
});

// ── the store read against a main checkout and a linked worktree (C-3) ────────────────────────────

const FU = 'FU-8acds5';
const MARKERS = [{ id: 'R-x', followup: FU }];
let pair;
/** A main checkout and a linked worktree of it, built once; `seed` replaces both stores' events. */
function worktreePair() {
  if (pair) return pair;
  const dir = suiteTempDir('doflow-ledger-store-');
  const main = path.join(dir, 'main');
  const wt = path.join(dir, 'wt');
  const git = (cwd, ...args) => {
    const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
    assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  };
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '--detach', wt);
  const store = (root) => path.join(root, STORE_REL);
  const write = (root, events) => {
    removeTree(path.join(root, '.doflow'));
    if (events === null) return;
    fs.mkdirSync(store(root), { recursive: true });
    for (const [n, type, data] of events) {
      const at = `2020-01-0${n}T00:00:00.000Z`;
      const id = `2020010${n}T000000000Z-${'abcdefg'[n]}aaaaa`;
      fs.writeFileSync(path.join(store(root), `${id}.json`), JSON.stringify({ v: 1, id, type, at, by: 'agent', data }));
    }
  };
  pair = { main, wt, root: followupRoot(wt), seed: ({ main: m = null, wt: w = null }) => { write(main, m); write(wt, w); } };
  return pair;
}
const added = [1, 'followup.added', { id: FU, statement: 'stale lock race', source: { kind: 'manual' } }];
const settled = (data) => [2, 'followup.settled', { id: FU, evidence: 'x', reason: 'r', ...data }];
/** The ids the safeguard reads when run from the linked worktree, through the read-only fs. A seed the
 * fold rejects would make every "kept" case pass vacuously, so the fixture store must fold cleanly. */
function idsFromWorktree(options = {}) {
  const { root } = worktreePair();
  const fold = lifecycle('event-store.ts').readFold(root, { fsImpl: readOnlyFs() });
  assert.deepEqual([fold.conflicts, fold.unreadable, fold.followups.some((i) => i.id === FU)], [[], [], true], 'the seeded store folds cleanly');
  return settledFollowupIds(root, options);
}

test('todo safeguard store: the read-only fs refuses every write and still reads', (t) => {
  const dir = tempDir(t, 'doflow-ledger-rofs-');
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'x');
  const ro = readOnlyFs();
  for (const call of [() => ro.writeFileSync(file, 'y'), () => ro.appendFileSync(file, 'y'), () => ro.mkdirSync(path.join(dir, 'd')),
    () => ro.renameSync(file, `${file}2`), () => ro.rmSync(file), () => ro.unlinkSync(file), () => ro.rmdirSync(dir),
    () => ro.openSync(file, 'w'), () => ro.openSync(file, 'a'), () => ro.openSync(file, 'r+'),
    () => ro.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT), () => ro.promises]) {
    assert.throws(call, { code: 'EROFS' });
  }
  assert.equal(ro.readFileSync(file, 'utf8'), 'x');
  ro.closeSync(ro.openSync(file, fs.constants.O_RDONLY));
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
});

test('todo safeguard store: the root is the main checkout, read through the read-only fs', () => {
  const { main, root, seed } = worktreePair();
  assert.equal(root, fs.realpathSync(main), 'resolved from the linked worktree');
  seed({ main: [added, settled({ as: 'done' })] });
  const used = new Set();
  const ids = idsFromWorktree({ fsImpl: readOnlyFs(fs, (name) => used.add(name)) });
  assert.deepEqual([...ids], [FU]);
  assert.ok(used.has('readdirSync') && used.has('openSync'), `the runtime read went through the given fs: ${[...used]}`);
});

const CASES = [
  ['main done + an empty worktree events dir', { main: [added, settled({ as: 'done' })], wt: [] }, true],
  ['main done + an unrelated worktree event', { main: [added, settled({ as: 'done' })],
    wt: [[3, 'followup.added', { id: 'FU-zzzzzz', statement: 'x', source: { kind: 'manual' } }]] }, true],
  ['batch ids settled done', { main: [added, [2, 'followup.settled', { ids: [FU], as: 'done', evidence: 'x' }]] }, true],
  ['dismissed', { main: [added, settled({ as: 'dismissed' })] }, true],
  ['as fix (still open)', { main: [added, settled({ as: 'fix' })] }, false],
  ['as kept (still open)', { main: [added, settled({ as: 'kept' })] }, false],
];
for (const [name, stores, stale] of CASES) {
  test(`todo safeguard store: ${name} -> marker ${stale ? 'stale' : 'kept'}`, () => {
    worktreePair().seed(stores);
    assert.deepEqual(staleMarkers(MARKERS, idsFromWorktree()), stale ? MARKERS : []);
  });
}

// A taken item is done while its feature derives `finished` (fold withDerivedDone); the derivation is
// injected in loadFollowups' `statuses` shape, `{ statuses: { <slug>: { status } } }`, not read from git.
for (const [status, stale] of [['finished', true], ['merged', false]]) {
  test(`todo safeguard store: taken by a feature that derives ${status} -> marker ${stale ? 'stale' : 'kept'}`, () => {
    worktreePair().seed({ main: [added, [2, 'feature.tracked', { slug: 'feat-x' }], [3, 'followup.taken', { ids: [FU], feature: 'feat-x' }]] });
    const ids = idsFromWorktree({ statuses: { statuses: { 'feat-x': { status } } } });
    assert.deepEqual(staleMarkers(MARKERS, ids), stale ? MARKERS : []);
  });
}

// Derivation runs git (~0.45 s on this repository), so it runs only when a marker's own followup is taken.
const OTHER = 'FU-zzzzzz';
const tracked = [2, 'feature.tracked', { slug: 'feat-x' }];
const addedOther = [3, 'followup.added', { id: OTHER, statement: 'other', source: { kind: 'manual' } }];
for (const [name, takenId, calls, stale] of [['an unrelated followup taken: no derivation', OTHER, 0, false],
  ['the marker followup taken by a finished feature: derived, stale', FU, 1, true]]) {
  test(`todo safeguard store: ${name}`, () => {
    worktreePair().seed({ main: [added, tracked, addedOther, [4, 'followup.taken', { ids: [takenId], feature: 'feat-x' }]] });
    let derived = 0;
    const derive = () => { derived += 1; return { statuses: { 'feat-x': { status: 'finished' } } }; };
    const ids = idsFromWorktree({ markers: MARKERS, derive });
    assert.equal(derived, calls, 'derivations run');
    assert.deepEqual(staleMarkers(MARKERS, ids), stale ? MARKERS : []);
  });
}
