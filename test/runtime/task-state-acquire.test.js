'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const {
  updateTaskState,
  boundedAcquire,
  acquireLock,
  tryAcquireLock,
  readTaskState,
  SCHEMA_VERSION,
} = require('../../src/runtime/task-state.ts');

function stateRoot(t) {
  return tempDir(t, 'doflow-task-state-acquire-');
}

test('boundedAcquire: on a free lock, acquires lock and returns a release function', (t) => {
  const root = stateRoot(t);
  const file = path.join(root, 'free.json');
  fs.mkdirSync(root, { recursive: true });

  const release = boundedAcquire(fs, file);
  assert.equal(typeof release, 'function');
  assert.ok(fs.existsSync(`${file}.lock`), 'lock directory must exist while held');

  // While held, another boundedAcquire attempt throws store-locked
  assert.throws(
    () => boundedAcquire(fs, file, { retries: 0 }),
    (err) => err.message === 'store-locked' && err.code === 'store-locked'
  );

  release();
  assert.ok(!fs.existsSync(`${file}.lock`), 'lock directory must be removed after release');

  // Can acquire again after release
  const reRelease = boundedAcquire(fs, file);
  assert.equal(typeof reRelease, 'function');
  reRelease();
});

test('boundedAcquire: on a held lock, makes one try plus three 5 ms retries', (t) => {
  const root = stateRoot(t);
  const file = path.join(root, 'held.json');
  const lockDir = `${file}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });

  let attempts = 0;
  const waits = [];
  let caught = null;
  try {
    boundedAcquire(fs, file, {
      tryAcquireLockFn: (fsImpl, lockFile) => { attempts += 1; return tryAcquireLock(fsImpl, lockFile); },
      sleepFn: (ms) => waits.push(ms),
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'boundedAcquire must throw when lock is held');
  assert.equal(caught.message, 'store-locked');
  assert.equal(caught.code, 'store-locked');
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [5, 5, 5]);
  assert.ok(fs.existsSync(lockDir), 'held lock must not be removed by failed acquirer');
});

test('updateTaskState: with acquire: boundedAcquire writes on free lock and releases lock', (t) => {
  const root = stateRoot(t);
  const file = path.join(root, 'update-free.json');

  const written = updateTaskState({
    fsImpl: fs,
    file,
    build: (disk) => ({ items: ['alpha', 'beta'] }),
    acquire: boundedAcquire,
  });

  assert.equal(written, file);
  assert.ok(!fs.existsSync(`${file}.lock`), 'lock must be released after write');

  const state = readTaskState(fs, file);
  assert.equal(state.version, SCHEMA_VERSION);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.items, ['alpha', 'beta']);
});

test('updateTaskState: boundedAcquire retry policy prevents write when lock is held', (t) => {
  const root = stateRoot(t);
  const file = path.join(root, 'update-held.json');
  const lockDir = `${file}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });

  let attempts = 0;
  const waits = [];
  let caught = null;
  try {
    updateTaskState({
      fsImpl: fs,
      file,
      build: () => ({ shouldNotWrite: true }),
      acquire: (fsImpl, lockFile) => boundedAcquire(fsImpl, lockFile, {
        tryAcquireLockFn: (impl, target) => { attempts += 1; return tryAcquireLock(impl, target); },
        sleepFn: (ms) => waits.push(ms),
      }),
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'updateTaskState must throw when lock is held');
  assert.equal(caught.message, 'store-locked');
  assert.equal(caught.code, 'store-locked');
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [5, 5, 5]);
  assert.ok(!fs.existsSync(file), 'state file must not be created when lock cannot be acquired');
  assert.ok(fs.existsSync(lockDir), 'held lock must remain in place');
});

test('updateTaskState: defaults to acquireLock when acquire parameter is omitted', (t) => {
  const root = stateRoot(t);
  const file = path.join(root, 'default-acquire.json');

  const written = updateTaskState({
    fsImpl: fs,
    file,
    build: (disk) => ({ count: 42 }),
  });

  assert.equal(written, file);
  const state = readTaskState(fs, file);
  assert.equal(state.version, SCHEMA_VERSION);
  assert.equal(state.revision, 1);
  assert.equal(state.count, 42);
});

test('task-state-acquire: negative control - unbounded retries fail the retry-count assertion (IC-023)', (t) => {
  const root = stateRoot(t);
  const file = path.join(root, 'negative-control.json');
  fs.mkdirSync(`${file}.lock`, { recursive: true });

  function assertRetryPolicy(attempts, waits) {
    if (attempts !== 4) throw new Error(`expected 4 lock attempts, got ${attempts}`);
    if (JSON.stringify(waits) !== JSON.stringify([5, 5, 5])) throw new Error(`expected three 5 ms waits, got ${waits}`);
  }

  // Positive check: production boundedAcquire follows the documented retry policy.
  let attempts = 0;
  const waits = [];
  assert.throws(() => boundedAcquire(fs, file, {
    tryAcquireLockFn: (fsImpl, lockFile) => { attempts += 1; return tryAcquireLock(fsImpl, lockFile); },
    sleepFn: (ms) => waits.push(ms),
  }), (err) => err.message === 'store-locked');
  assertRetryPolicy(attempts, waits);

  // Negative control: an unbounded retry count fails the attempt-count assertion.
  assert.throws(
    () => assertRetryPolicy(5, [5, 5, 5, 5]),
    (err) => err.message.includes('expected 4 lock attempts')
  );

});
