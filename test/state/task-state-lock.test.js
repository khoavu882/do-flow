'use strict';

// 117 Phase C (FU-8acds5, FU-vgkrvd): the task-state lock's owner entry, exclusive reclaim, owned
// release and pre-write check, and how it meets the lock of runtimes from before it
// (test/helper/legacy-lock.js, the e003dc0d code). Interleavings across processes are explored by
// test/state/ledger-lock-race.test.js and the opt-in sampler; these are the single-process cases.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.js');
const { runSchedule } = require('../helper/sequence-gate.js');
const { check } = require('../helper/ledger-oracle.js');
const { acquireLock, tryAcquireLock, updateTaskState, readTaskState } = require('../../src/runtime/task-state.ts');
const legacy = require('../helper/legacy-lock.js');

const STALE_AGE_MS = 60_000;

function storeFile(t) {
  return path.join(tempDir(t, 'doflow-task-state-lock-'), 'store.json');
}
const lockOf = (file) => `${file}.lock`;
/** Sets the lock directory's mtime 60 s back, as a holder stalled past LOCK_STALE_MS leaves it. */
function age(file) {
  const past = new Date(Date.now() - STALE_AGE_MS);
  fs.utimesSync(lockOf(file), past, past);
}
const owners = (file) => fs.readdirSync(lockOf(file)).filter((name) => name.startsWith('owner-'));
const siblings = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.lock`));
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
  release();
  assert.equal(fs.existsSync(lockOf(file)), false);
  assert.equal(release.held(), false, 'a released lock is not held');
  release(); // a second release is a no-op
});

test('a stale lock is reclaimed by moving it aside; nothing is left beside the store', (t) => {
  const file = storeFile(t);
  const stalled = acquireLock(fs, file);
  age(file);
  const release = tryAcquireLock(fs, file);
  assert.ok(release, 'the stale lock is reclaimed');
  assert.equal(stalled.held(), false, 'the stalled holder has lost it');
  assert.deepEqual(siblings(file), [path.basename(lockOf(file))], 'no reclaimed-* directory remains');
  stalled(); // the stalled holder's release must not remove the new holder's lock
  assert.equal(release.held(), true);
  assert.equal(owners(file).length, 1);
  release();
  assert.equal(fs.existsSync(lockOf(file)), false);
});

test('negative control: a stale lock with a reclaim entry (a reclaimer died deciding) is never broken', (t) => {
  const file = storeFile(t);
  fs.mkdirSync(path.join(lockOf(file), 'reclaim'), { recursive: true });
  age(file);
  assert.equal(tryAcquireLock(fs, file), null);
  fastClock(t);
  assert.throws(() => acquireLock(fs, file), (error) => /remove '.*store\.json\.lock' once no DoFlow process is running/.test(error.message));
  assert.deepEqual(fs.readdirSync(lockOf(file)), ['reclaim'], 'left in place for the person to remove');
});

test('a writer whose lock is reclaimed mid-update writes nothing: lock-lost, or one fresh retry when allowed', (t) => {
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
      assert.throws(run, { code: 'lock-lost' });
      assert.deepEqual(readTaskState(fs, file).items, ['other'], 'the stalled writer wrote nothing');
    } else {
      run();
      assert.deepEqual(builds, [0, 1], 'the retry built on the other writer\'s store');
      assert.deepEqual(readTaskState(fs, file).items, ['other', 'mine']);
    }
    assert.equal(fs.existsSync(lockOf(file)), false, 'both writers released');
  }
});

// FU-vgkrvd: two processes that judged the same stale lock. Here the other one (A) completes its whole
// reclaim at one of three points of B's: after B judged the lock stale, after B listed it, after B
// re-checked it. B must then not take A's live lock.
for (const [point, calls] of [['judged', 1], ['listed', 2], ['re-checked', 3]]) {
  test(`exclusive reclaim: a reclaimer that judged a stale lock does not take the lock another reclaimer then took (${point})`, (t) => {
    const file = storeFile(t);
    legacy.acquireLock(fs, file); // a holder died
    age(file);
    let seen = 0;
    let other = null;
    const after = (result) => {
      seen += 1;
      if (seen === calls) other = tryAcquireLock(fs, file);
      return result;
    };
    const fsImpl = {
      ...fs,
      statSync: (target, ...rest) => (target === lockOf(file) && seen < 3 && seen !== 1 ? after(fs.statSync(target, ...rest)) : fs.statSync(target, ...rest)),
      readdirSync: (target, ...rest) => (target === lockOf(file) && seen === 1 ? after(fs.readdirSync(target, ...rest)) : fs.readdirSync(target, ...rest)),
    };
    const mine = tryAcquireLock(fsImpl, file);
    assert.equal(seen >= calls, true, `B reached its ${point} step`);
    assert.ok(other, 'the other reclaimer took the stale lock');
    assert.equal(mine, null, 'B does not take the live lock');
    assert.equal(other.held(), true);
    assert.equal(owners(file).length, 1);
    other();
  });
}

// A holder that stalled past LOCK_STALE_MS after its tmp write (age-lock@7) checks ownership while B's
// reclaim claim sits in its lock: it must wait for B to decide, not write. Chooser: A to its tmp write,
// B judges, lists and claims, A checks for a claim and for its entry (both there), B takes the lock and
// reads, then the two alternate. A holder that did not wait would rename next, over B's read.
test('pre-write check waits on a reclaimer\'s claim: the stalled holder never writes over the reclaimer', async () => {
  const script = 'A A A A A A A B B B B B A A B B B B B B B B B B'.split(' ');
  const o = await runSchedule({ scenario: 'S1', init: 'none', fault: { kind: 'age-lock', at: 7 },
    chooser: (parked, step) => { const want = script[step] ?? (step % 2 ? 'B' : 'A'); return parked.includes(want) ? want : parked[0]; } });
  assert.equal(o.incomplete, null, JSON.stringify(o.incomplete));
  assert.match(o.trace, /^A\.mkdir A\.mkdir A\.exists A\.exists A\.exists A\.readFile A\.writeFile age-lock@7 B\.mkdir B\.stat B\.readdir B\.stat B\.mkdir A\.exists A\.exists B\.readdir /, o.trace);
  const v = check(o);
  assert.equal(v.verdict, 'PASS', `${v.class}: ${v.detail}; ${o.trace}`);
});

// ── against the lock of runtimes from before 117 Phase C ────────────────────────────────────────

test('older runtime: waits on a fresh new lock and fails closed on a stale one, leaving it untouched', (t) => {
  const file = storeFile(t);
  const release = acquireLock(fs, file);
  const entries = fs.readdirSync(lockOf(file));
  assert.equal(legacy.tryAcquireLock(fs, file), null, 'fresh: busy');
  age(file);
  assert.equal(legacy.tryAcquireLock(fs, file), null, 'stale: rmdir of a non-empty lock fails, store-locked');
  fastClock(t);
  assert.throws(() => legacy.acquireLock(fs, file), /Could not lock/);
  t.mock.restoreAll();
  assert.deepEqual(fs.readdirSync(lockOf(file)), entries, 'the new holder\'s lock is unchanged');
  assert.equal(release.held(), true);
  release();
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

test('older runtime: a new runtime waits on its fresh lock and reclaims its stale one', (t) => {
  const file = storeFile(t);
  const oldRelease = legacy.acquireLock(fs, file);
  assert.equal(tryAcquireLock(fs, file), null, 'fresh: busy');
  oldRelease();
  legacy.acquireLock(fs, file); // an older runtime died holding it
  age(file);
  const release = tryAcquireLock(fs, file);
  assert.ok(release);
  assert.deepEqual(siblings(file), [path.basename(lockOf(file))]);
  release();
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
