'use strict';

// 117 Phase C (FU-8acds5, FU-vgkrvd): the task-state lock's owner entry, in-place reclaim, publication
// bound, contention rule, owned release and pre-write check, and how it meets the lock of runtimes
// from before it (test/helper/legacy-lock.js, the e003dc0d code). Interleavings across processes are
// explored by test/state/ledger-lock-race.test.js and the opt-in sampler; these are the single-process
// cases. The safety argument they check, one interleaving at a time, is in the 117 feature records
// (research/phase-c-protocol.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.js');
const { acquireLock, tryAcquireLock, boundedAcquire, updateTaskState, readTaskState } = require('../../src/runtime/task-state.ts');
const legacy = require('../helper/legacy-lock.js');

const STALE_AGE_MS = 60_000;
const PAUSE_MS = 11_000; // past LOCK_STALE_MS (10 s)

function storeFile(t) {
  return path.join(tempDir(t, 'doflow-task-state-lock-'), 'store.json');
}
const lockOf = (file) => `${file}.lock`;
/** Sets a lock directory's mtime 60 s back, as a holder stalled past LOCK_STALE_MS leaves it. */
function ageDir(dir) {
  const past = new Date(Date.now() - STALE_AGE_MS);
  try { fs.utimesSync(dir, past, past); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const age = (file) => ageDir(lockOf(file));
const entries = (file) => (fs.existsSync(lockOf(file)) ? fs.readdirSync(lockOf(file)).sort() : null);
const owners = (file) => (entries(file) || []).filter((name) => name.startsWith('owner-'));
const siblings = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.`));
const DEAD = 'owner-999999-dead00000000';
/** Makes the legacy acquireLock's 5 s wall-clock wait pass in a few real milliseconds. */
function fastClock(t) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => { now += 500; return now; });
}

// ── the protocol ────────────────────────────────────────────────────────────────────────────────

test('acquire marks the lock with one owner entry; release removes the entry and the lock', (t) => {
  const file = storeFile(t);
  const release = acquireLock(fs, file);
  assert.equal(owners(file).length, 1);
  assert.equal(release.held(), true);
  assert.equal(tryAcquireLock(fs, file), null, 'a live holder is not taken');
  assert.equal(owners(file).length, 1, 'the refused attempt left no entry');
  release();
  assert.equal(fs.existsSync(lockOf(file)), false);
  assert.equal(release.held(), false, 'a released lock is not held');
  release(); // a second release is a no-op
});

test('a stale lock is reclaimed in place: same directory, the stalled holder loses it, nothing beside the store', (t) => {
  const file = storeFile(t);
  const stalled = acquireLock(fs, file);
  const before = fs.statSync(lockOf(file));
  age(file);
  const release = tryAcquireLock(fs, file);
  assert.ok(release, 'the stale lock is reclaimed');
  assert.equal(fs.statSync(lockOf(file)).ino, before.ino, 'the same directory, never moved or emptied');
  assert.equal(stalled.held(), false, 'the stalled holder has lost it');
  assert.deepEqual(siblings(file), [path.basename(lockOf(file))], 'nothing else beside the store');
  stalled(); // the stalled holder's release must not remove the new holder's lock
  assert.equal(release.held(), true);
  assert.equal(owners(file).length, 1);
  release();
  assert.equal(fs.existsSync(lockOf(file)), false);
});

// C-3: whatever a process was doing when it died, what it left is reclaimed once LOCK_STALE_MS old, with
// nobody's help: no entry blocks a store for good (e003dc0d recovered from any crash in 10 s too).
const LEFTOVERS = {
  'an empty lock (died between its mkdir and its entry)': [],
  'one owner entry (died holding, or reclaiming after its entry)': [DEAD],
  'two owner entries (died while contending)': ['owner-999998-dead00000002', 'owner-999999-dead00000003'],
  'a reclaim entry (a 45c533e6 build died reclaiming)': ['reclaim'],
};
for (const [label, leftover] of Object.entries(LEFTOVERS)) {
  test(`self-healing: ${label} blocks while fresh and is reclaimed once stale`, (t) => {
    const file = storeFile(t);
    fs.mkdirSync(lockOf(file), { recursive: true });
    for (const name of leftover) fs.mkdirSync(path.join(lockOf(file), name));
    assert.equal(tryAcquireLock(fs, file), null, 'fresh: it may be a live process');
    assert.deepEqual(entries(file), [...leftover].sort(), 'the refused attempt left nothing');
    age(file);
    const release = tryAcquireLock(fs, file);
    assert.ok(release, 'stale: reclaimed');
    assert.equal(owners(file).length, 1);
    assert.deepEqual(entries(file).filter((name) => !name.startsWith('owner-')), [], 'the leftovers are gone');
    release();
    assert.equal(fs.existsSync(lockOf(file)), false);
  });
}

function deliveryEntry(n) {
  const { makeTokenRecord } = require('../../src/runtime/context/delivery-store.ts');
  const digest = `sha256:${String(n).repeat(64)}`;
  return { key: `${digest}.json.unstated`, packDigest: digest, form: 'json', harness: null, firstAt: new Date().toISOString(),
    mode: 'full', budget: { maxBytes: 1024, source: 'task-class' }, since: null, deltaRefused: null,
    retention: { status: 'unknown', basis: 'test' }, items: {}, mandatoryIds: [], sources: {}, pointers: [],
    bytes: 20, tokens: makeTokenRecord(20), omissions: [], expansions: [] };
}

test('self-healing through the callers: context-pack delivery and lifecycle upkeep take a dead process\'s lock once stale', (t) => {
  const { recordDelivery } = require('../../src/runtime/context/delivery-store.ts');
  const { retainLocked } = require('../../src/runtime/lifecycle/store-upkeep.ts');
  const store = require('../../src/runtime/lifecycle/event-store.ts');
  const root = tempDir(t, 'doflow-task-state-heal-');
  const dead = (lock) => fs.mkdirSync(path.join(lock, DEAD), { recursive: true });

  const deliveryLock = path.join(root, '.doflow/state/delivery/T1.json.lock');
  dead(deliveryLock);
  assert.throws(() => recordDelivery({ projectRoot: root, taskId: 'T1', entry: deliveryEntry(1) }), { message: 'store-locked' });
  ageDir(deliveryLock);
  assert.equal(recordDelivery({ projectRoot: root, taskId: 'T1', entry: deliveryEntry(1) }).recorded, true);
  assert.equal(fs.existsSync(deliveryLock), false);

  const eventsLock = `${store.lockTarget(root)}.lock`;
  fs.mkdirSync(store.lockTarget(root), { recursive: true });
  dead(eventsLock);
  const window = { state: 'on', hours: 1, ms: 3_600_000 };
  assert.equal(retainLocked(root, { window, now: new Date(), maxFiles: 10 }).partial, true, 'fresh: the pass is skipped');
  ageDir(eventsLock);
  assert.equal(retainLocked(root, { window, now: new Date(), maxFiles: 10 }).partial, false, 'stale: the pass runs');
  assert.equal(fs.existsSync(eventsLock), false);
});

test('a writer whose lock is reclaimed mid-update writes nothing and leaves no temp file: lock-lost, or one fresh retry', (t) => {
  for (const lostLockRetries of [0, 1]) {
    const file = storeFile(t);
    let nested = false;
    const builds = [];
    const run = () => updateTaskState({
      fsImpl: fs, file, lostLockRetries,
      build: (disk) => {
        builds.push(disk ? disk.items.length : 0);
        if (!nested) {
          nested = true; // this writer now stalls past LOCK_STALE_MS; another writer reclaims and writes
          age(file);
          updateTaskState({ fsImpl: fs, file, build: (inner) => ({ items: [...(inner?.items || []), 'other'] }) });
        }
        return { items: [...(disk?.items || []), 'mine'] };
      },
    });
    if (lostLockRetries === 0) {
      assert.throws(run, (error) => error.code === 'lock-lost' && /run the command again/.test(error.message));
      assert.deepEqual(readTaskState(fs, file).items, ['other'], 'the stalled writer wrote nothing');
    } else {
      run();
      assert.deepEqual(builds, [0, 1], 'the retry built on the other writer\'s store');
      assert.deepEqual(readTaskState(fs, file).items, ['other', 'mine']);
    }
    assert.deepEqual(siblings(file), [], 'both writers released; no temp file is left (C-11)');
  }
});

// ── every step: B paused there past LOCK_STALE_MS while others act ────────────────────────────────
//
// `sweep` runs B's attempt (tryAcquireLock) once per step k of its lock calls. After B's k-th call
// returns, B "pauses past the stale age": the lock ages, `others` run their own attempts to the end with
// the real clock, and B's clock is then 11 s ahead until B starts its next attempt (its next mkdir of
// the lock). B then continues. Whatever the step, B and the other process must not both hold.

function sweep(t, { seed, others }) {
  let covered = 0;
  for (let k = 1; k <= 60; k += 1) {
    const file = storeFile(t);
    seed(file);
    let calls = 0;
    let skew = 0;
    let other = null;
    const real = Date.now;
    t.mock.method(Date, 'now', () => real() + skew);
    const hooked = (name) => (target, ...rest) => {
      if (name === 'mkdirSync' && target === lockOf(file)) skew = 0; // a new attempt: B's clock is real again
      const out = fs[name](target, ...rest);
      if (String(target).startsWith(lockOf(file))) {
        calls += 1;
        if (calls === k) {
          age(file);
          skew = 0;
          other = others(file);
          skew = PAUSE_MS;
        }
      }
      return out;
    };
    const fsB = { ...fs };
    for (const name of ['mkdirSync', 'statSync', 'readdirSync', 'rmdirSync', 'existsSync']) fsB[name] = hooked(name);
    let mine;
    try { mine = tryAcquireLock(fsB, file); } finally { t.mock.restoreAll(); }
    if (calls < k) break; // B finished before step k: every step was covered
    covered += 1;
    const bHolds = Boolean(mine && mine.held());
    const otherHolds = Boolean(other?.release && (other.kind === 'old' || other.release.held()));
    assert.ok(!(bHolds && otherHolds), `step ${k}: B and the ${other?.kind} process both hold; lock entries ${JSON.stringify(entries(file))}`);
    if (bHolds) assert.equal(owners(file).length, 1, `step ${k}: one owner entry`);
  }
  assert.ok(covered >= 3, `the sweep covered ${covered} steps`);
}

const OTHERS = {
  'a new runtime reclaims and holds': (file) => ({ kind: 'new', release: tryAcquireLock(fs, file) }),
  'a new runtime reclaims and releases, and another takes a fresh lock': (file) => {
    const first = tryAcquireLock(fs, file);
    if (first) first();
    return { kind: 'new', release: tryAcquireLock(fs, file) };
  },
  'an older runtime breaks the lock and holds': (file) => ({ kind: 'old', release: legacy.tryAcquireLock(fs, file) }),
  'a new runtime reclaims and releases, and an older runtime takes a fresh lock': (file) => {
    const first = tryAcquireLock(fs, file);
    if (first) first();
    return { kind: 'old', release: legacy.tryAcquireLock(fs, file) };
  },
};
const SEEDS = {
  // C-1: no lock before; B creates it and pauses at each step from its mkdir on (V1 with an older runtime).
  'C-1 publication window: B paused at every step of a fresh acquire': () => {},
  'reclaim: B paused at every step of reclaiming a dead new holder\'s stale lock': (file) => {
    fs.mkdirSync(path.join(lockOf(file), DEAD), { recursive: true });
    age(file);
  },
  'reclaim: B paused at every step of reclaiming a crashed older runtime\'s empty stale lock': (file) => {
    legacy.acquireLock(fs, file);
    age(file);
  },
};
for (const [seedLabel, seed] of Object.entries(SEEDS)) {
  for (const [label, others] of Object.entries(OTHERS)) {
    test(`${seedLabel}; ${label}: never two holders`, (t) => sweep(t, { seed, others }));
  }
}

// C-4 (a): the contention rule, without a pause. Two processes judged one stale lock and both enter it;
// the other one (A) completes its whole attempt between B's judgement and B's entry.
test('contention: two reclaimers of one stale lock; the one that finished first holds, B does not', (t) => {
  const file = storeFile(t);
  fs.mkdirSync(path.join(lockOf(file), DEAD), { recursive: true });
  age(file);
  let other = null;
  const fsB = {
    ...fs,
    mkdirSync: (target, ...rest) => {
      if (!other && path.dirname(target) === lockOf(file)) other = tryAcquireLock(fs, file); // A: judge, enter, hold
      return fs.mkdirSync(target, ...rest);
    },
  };
  const mine = tryAcquireLock(fsB, file);
  assert.ok(other && other.held(), 'A took the stale lock');
  assert.equal(mine, null, 'B saw A\'s entry and did not take the lock');
  assert.equal(owners(file).length, 1, 'B left no entry');
  other();
  assert.equal(fs.existsSync(lockOf(file)), false, 'A\'s release removed the lock: nothing orphaned');
});

// C-2: an attempt that does not hold leaves nothing of its own and no empty lock; tryAcquireLock does
// not wait on a holder. B reclaims a stale lock and finds another reclaimer's entry H in it; B's entry
// sorts first, so B waits for H to leave.
function contended(t, { onElect, onWithdraw }) {
  const file = storeFile(t);
  fs.mkdirSync(path.join(lockOf(file), DEAD), { recursive: true });
  age(file);
  const H = 'owner-zzzzzz-contender000'; // sorts after any real entry
  let listed = 0;
  let made = false;
  const fsB = {
    ...fs,
    mkdirSync: (target, ...rest) => {
      const out = fs.mkdirSync(target, ...rest);
      if (!made && path.dirname(target) === lockOf(file)) { made = true; fs.mkdirSync(path.join(lockOf(file), H)); } // H enters just after B
      return out;
    },
    readdirSync: (target, ...rest) => { listed += 1; if (onElect) onElect(listed, file, H); return fs.readdirSync(target, ...rest); },
    rmdirSync: (target, ...rest) => { const out = fs.rmdirSync(target, ...rest); if (onWithdraw && path.basename(target).startsWith('owner-') && path.basename(target) !== H && path.basename(target) !== DEAD) onWithdraw(file, H); return out; },
  };
  const started = performance.now();
  const mine = tryAcquireLock(fsB, file);
  return { file, H, mine, ms: performance.now() - started };
}

test('C-2: a waiting attempt holds as soon as the other reclaimer leaves', (t) => {
  const { file, mine } = contended(t, { onElect: (n, f, H) => { if (n === 4) fs.rmdirSync(path.join(lockOf(f), H)); } });
  assert.ok(mine && mine.held(), 'held once H left');
  mine();
  assert.equal(fs.existsSync(lockOf(file)), false);
});

test('C-2: a waiting attempt gives up after 40 ms, leaving no entry of its own', (t) => {
  const { file, H, mine, ms } = contended(t, {});
  assert.equal(mine, null);
  assert.ok(ms < 1000, `bounded: ${ms} ms`);
  assert.deepEqual(entries(file), [H], 'only the other reclaimer\'s entry is left');
});

test('C-2: an attempt that gives up just as the other left takes the emptied lock instead of orphaning it', (t) => {
  const { file, mine } = contended(t, { onWithdraw: (f, H) => { if (fs.existsSync(path.join(lockOf(f), H))) fs.rmdirSync(path.join(lockOf(f), H)); } });
  assert.ok(mine && mine.held(), 'it entered the emptied lock again and holds it');
  mine();
  assert.equal(fs.existsSync(lockOf(file)), false, 'no orphan entry, no orphan empty lock');
  assert.ok(boundedAcquire(fs, file), 'the store is acquirable at once');
});

test('C-2: tryAcquireLock returns at once on a held lock and leaves nothing', (t) => {
  const file = storeFile(t);
  const holder = acquireLock(fs, file);
  const held = entries(file);
  const started = performance.now();
  assert.equal(tryAcquireLock(fs, file), null);
  assert.ok(performance.now() - started < 20, 'a live holder is not waited on');
  assert.deepEqual(entries(file), held);
  holder();
});

// ── against the lock of runtimes from before 117 Phase C ────────────────────────────────────────

test('older runtime: waits on a fresh new lock and fails closed on a stale one, leaving it untouched', (t) => {
  const file = storeFile(t);
  const release = acquireLock(fs, file);
  const held = entries(file);
  assert.equal(legacy.tryAcquireLock(fs, file), null, 'fresh: busy');
  age(file);
  assert.equal(legacy.tryAcquireLock(fs, file), null, 'stale: rmdir of a non-empty lock fails, store-locked');
  fastClock(t);
  assert.throws(() => legacy.acquireLock(fs, file), /Could not lock/);
  t.mock.restoreAll();
  assert.deepEqual(entries(file), held, 'the new holder\'s lock is unchanged');
  assert.equal(release.held(), true);
  release();
});

test('older runtime: a crashed new holder\'s lock makes it fail closed; a new runtime then reclaims it', (t) => {
  const file = storeFile(t);
  acquireLock(fs, file); // the new holder dies holding it
  age(file);
  fastClock(t);
  assert.throws(() => legacy.acquireLock(fs, file), /Could not lock/);
  t.mock.restoreAll();
  const release = tryAcquireLock(fs, file);
  assert.ok(release);
  release();
  const old = legacy.tryAcquireLock(fs, file);
  assert.ok(old, 'once released, the older runtime takes it as before');
  old();
});

test('older runtime: its release after a new runtime reclaimed its stale lock leaves the new lock alone', (t) => {
  const file = storeFile(t);
  const oldRelease = legacy.acquireLock(fs, file);
  age(file);
  const release = acquireLock(fs, file);
  oldRelease(); // rmdir by name: the directory now holds the new owner entry, so it fails
  assert.equal(release.held(), true);
  assert.equal(owners(file).length, 1);
  release();
  assert.equal(fs.existsSync(lockOf(file)), false);
});

test('older runtime: a new runtime waits on its fresh lock and reclaims its stale one in place', (t) => {
  const file = storeFile(t);
  const oldRelease = legacy.acquireLock(fs, file);
  assert.equal(tryAcquireLock(fs, file), null, 'fresh: busy');
  assert.deepEqual(entries(file), [], 'the refused attempt left the older holder\'s lock empty');
  oldRelease();
  legacy.acquireLock(fs, file); // an older runtime died holding it
  age(file);
  const release = tryAcquireLock(fs, file);
  assert.ok(release);
  assert.deepEqual(siblings(file), [path.basename(lockOf(file))]);
  release();
});

// r2-oldnew V2: an older runtime judged a crashed lock stale and stops before its rmdir; a new runtime
// reclaims that lock meanwhile. Its rmdir then fails (the lock is not empty): it does not take the lock.
test('older runtime (V2): one that judged a lock stale and paused before its rmdir does not take the lock a new runtime reclaimed', (t) => {
  const file = storeFile(t);
  legacy.acquireLock(fs, file); // crashed older holder
  age(file);
  let mine = null;
  const fsOld = { ...fs, statSync: (target, ...rest) => { const out = fs.statSync(target, ...rest); if (!mine) mine = tryAcquireLock(fs, file); return out; } };
  const old = legacy.tryAcquireLock(fsOld, file);
  assert.ok(mine && mine.held(), 'the new runtime reclaimed it');
  assert.equal(old, null, 'the older runtime failed closed');
  mine();
});

// V2, the other order: the older runtime breaks the stale lock by name and takes a new one between the
// new runtime's judgement and its entry. The entry lands in the older runtime's lock; the new runtime
// sees a directory other than the one it judged and leaves it.
test('older runtime (V2): a lock broken and re-taken by an older runtime between our judgement and our entry is left to it', (t) => {
  const file = storeFile(t);
  legacy.acquireLock(fs, file);
  age(file);
  let old = null;
  const fsNew = {
    ...fs,
    mkdirSync: (target, ...rest) => {
      if (!old && path.dirname(target) === lockOf(file)) old = legacy.tryAcquireLock(fs, file);
      return fs.mkdirSync(target, ...rest);
    },
  };
  const mine = tryAcquireLock(fsNew, file);
  assert.ok(old, 'the older runtime broke the stale lock and holds a new one');
  assert.equal(mine, null, 'the new runtime does not join it');
  assert.deepEqual(entries(file), [], 'and leaves it as the older holder made it');
  old();
  assert.equal(fs.existsSync(lockOf(file)), false, 'the older holder\'s release works');
});

test('older runtime: a lock removed between the new mkdir and its owner entry is taken again', (t) => {
  const file = storeFile(t);
  let removed = false;
  const fsImpl = {
    ...fs,
    mkdirSync: (target, ...rest) => {
      const out = fs.mkdirSync(target, ...rest);
      if (!removed && target === lockOf(file)) {
        removed = true;
        fs.rmdirSync(lockOf(file)); // an older runtime's release by name removes the still-empty new lock
      }
      return out;
    },
  };
  const release = acquireLock(fsImpl, file);
  assert.equal(removed, true);
  assert.equal(release.held(), true);
  assert.equal(owners(file).length, 1);
  release();
});

// M1's control: a holder that lost its lock must not remove whatever lock is there by the time it
// releases; here an older runtime's fresh (empty) lock, which an rmdir by name would delete.
test('a reclaimed holder\'s release removes nothing: an older runtime\'s later lock survives it', (t) => {
  const file = storeFile(t);
  const stalled = acquireLock(fs, file);
  age(file);
  const reclaimer = tryAcquireLock(fs, file);
  reclaimer();
  const old = legacy.tryAcquireLock(fs, file);
  assert.ok(old);
  stalled();
  assert.equal(fs.existsSync(lockOf(file)), true, 'the older runtime\'s lock is still there');
  old();
});

// ── C-6: an exhausted lock-lost keeps its code through the callers ──────────────────────────────────

/** An fs whose every temp-file write is followed by another writer reclaiming the lock (age + take + release). */
function reclaimedAfterTmp(lockedFile, counter = { n: 0 }) {
  return {
    ...fs,
    writeFileSync: (target, ...rest) => {
      const out = fs.writeFileSync(target, ...rest);
      if (String(target).startsWith(`${lockedFile}.`) && String(target).endsWith('.tmp')) {
        counter.n += 1;
        age(lockedFile);
        tryAcquireLock(fs, lockedFile)();
      }
      return out;
    },
  };
}

test('C-6: the ledger reports an exhausted lock-lost as lock-lost after its two re-runs; the store is unchanged', (t) => {
  const { claim, TaskAttemptError } = require('../../src/runtime/task-attempts.ts');
  const { buildFixture } = require('../helper/ledger-scenarios.js');
  const fixture = buildFixture({ dir: tempDir(t, 'doflow-task-state-lost-'), scenario: 'S2' });
  const before = fs.readFileSync(fixture.file, 'utf8');
  const counter = { n: 0 };
  const { file, roots, slug, env, cwd } = fixture;
  assert.throws(() => claim({ file, fsImpl: reclaimedAfterTmp(file, counter), roots, slug, env, cwd, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1 }),
    (error) => error instanceof TaskAttemptError && error.code === 'lock-lost' && /run the command again/.test(error.message));
  assert.equal(counter.n, 3, 'the decision ran three times');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing was written');
  assert.deepEqual(siblings(file), [], 'no lock or temp file left');
});

test('C-6: context-pack delivery names an exhausted lock-lost lock-lost, not an unwritable store', (t) => {
  const { recordDelivery } = require('../../src/runtime/context/delivery-store.ts');
  const { classifyStoreFailure } = require('../../src/runtime/context-pack.ts');
  const root = tempDir(t, 'doflow-task-state-lost-pack-');
  const file = path.join(root, '.doflow/state/delivery/T1.json');
  let thrown = null;
  try { recordDelivery({ projectRoot: root, taskId: 'T1', fsImpl: reclaimedAfterTmp(file), entry: deliveryEntry(2) }); } catch (error) { thrown = error; }
  assert.equal(thrown?.code, 'lock-lost');
  assert.equal(classifyStoreFailure(thrown), 'lock-lost');
  assert.equal(fs.existsSync(file), false, 'nothing was written');
});
