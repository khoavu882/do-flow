'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./tmp.ts');
const { untilLockReclaimable, MTIME_MARGIN_MS } = require('./killed-lock-holder.ts');
const { LOCK_STALE_MS, updateTaskState, readTaskState } = require(path.join(__dirname, '..', '..', 'src', 'runtime', 'task-state.ts'));

// A virtual clock: `sleep` moves it, so no test here waits for real time.
function clockAt(start: number) {
  const clock = { at: start, slept: 0 };
  return { clock, now: () => clock.at, sleep: async (ms: number) => { clock.at += ms; clock.slept += ms; } };
}

test('no lock answers absent at once; a lock left by a dead holder answers reclaimable once it is past the stale age, and the next writer then takes it', async (t: any) => {
  const file = path.join(tempDir(t, 'doflow-killed-lock-'), 'store.json');
  const none = clockAt(Date.now());
  assert.equal(await untilLockReclaimable(file, none), 'absent');
  assert.equal(none.clock.slept, 0);

  // What a writer SIGKILLed inside its critical section leaves: the lock directory and its owner entry.
  fs.mkdirSync(`${file}.lock`);
  fs.mkdirSync(path.join(`${file}.lock`, 'owner-999999-0123456789ab'));
  const mtime = fs.statSync(`${file}.lock`).mtimeMs;
  const left = clockAt(mtime);
  assert.equal(await untilLockReclaimable(file, left), 'reclaimable');
  assert.ok(left.clock.at - mtime > LOCK_STALE_MS + MTIME_MARGIN_MS, 'not before the stale age and its margin');
  assert.ok(left.clock.at - mtime <= LOCK_STALE_MS + MTIME_MARGIN_MS + 200, 'and not much later');

  // The real lock agrees: once the lock is that old (its time set back), the next writer reclaims it instead of failing.
  const past = (Date.now() - LOCK_STALE_MS - MTIME_MARGIN_MS - 1) / 1000;
  fs.utimesSync(`${file}.lock`, past, past);
  assert.equal(await untilLockReclaimable(file), 'reclaimable');
  updateTaskState({ fsImpl: fs, file, build: () => ({ written: true }) });
  assert.equal(readTaskState(fs, file).written, true);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a lock that stays young for three stale ages is a live writer\'s: the wait gives up and names it', async (t: any) => {
  const file = path.join(tempDir(t, 'doflow-killed-lock-'), 'store.json');
  fs.mkdirSync(`${file}.lock`);
  const live = clockAt(Date.now());
  // Each poll re-takes the lock, as a live writer would.
  const sleep = async (ms: number) => { await live.sleep(ms); const s = live.clock.at / 1000; fs.utimesSync(`${file}.lock`, s, s); };
  await assert.rejects(untilLockReclaimable(file, { now: live.now, sleep }), /stayed fresh .* a live writer holds it/);
  assert.ok(live.clock.slept >= 3 * LOCK_STALE_MS);
});
