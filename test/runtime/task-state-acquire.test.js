'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
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

test('boundedAcquire: on a held lock, throws store-locked within 40 ms', (t) => {
  const root = stateRoot(t);
  const file = path.join(root, 'held.json');
  const lockDir = `${file}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });

  const start = Date.now();
  let caught = null;
  try {
    boundedAcquire(fs, file);
  } catch (err) {
    caught = err;
  }
  const elapsed = Date.now() - start;

  assert.ok(caught, 'boundedAcquire must throw when lock is held');
  assert.equal(caught.message, 'store-locked');
  assert.equal(caught.code, 'store-locked');
  assert.ok(elapsed < 40, `boundedAcquire must throw within 40 ms, took ${elapsed} ms`);
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

test('updateTaskState: with acquire: boundedAcquire throws store-locked within 40 ms on held lock', (t) => {
  const root = stateRoot(t);
  const file = path.join(root, 'update-held.json');
  const lockDir = `${file}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });

  const start = Date.now();
  let caught = null;
  try {
    updateTaskState({
      fsImpl: fs,
      file,
      build: () => ({ shouldNotWrite: true }),
      acquire: boundedAcquire,
    });
  } catch (err) {
    caught = err;
  }
  const elapsed = Date.now() - start;

  assert.ok(caught, 'updateTaskState must throw when lock is held');
  assert.equal(caught.message, 'store-locked');
  assert.equal(caught.code, 'store-locked');
  assert.ok(elapsed < 40, `updateTaskState with boundedAcquire must throw within 40 ms, took ${elapsed} ms`);
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

test('task-state-acquire: negative control - an unbounded wait fails the 40 ms assertion (IC-023)', (t) => {
  const root = stateRoot(t);
  const file = path.join(root, 'negative-control.json');
  fs.mkdirSync(`${file}.lock`, { recursive: true });

  // Helper verifying that an acquirer fails with store-locked within 40 ms
  function assertBoundedWait(acquirerFn) {
    const start = Date.now();
    let thrown = null;
    try {
      acquirerFn();
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - start;
    if (!thrown || thrown.message !== 'store-locked') {
      throw new Error(`expected store-locked error, got: ${thrown ? thrown.message : 'none'}`);
    }
    if (elapsed >= 40) {
      throw new Error(`unbounded wait: operation took ${elapsed} ms (>= 40 ms bound)`);
    }
  }

  // Positive check: boundedAcquire passes the assertion on held lock
  assertBoundedWait(() => boundedAcquire(fs, file));

  // Negative control 1: an unbounded wait simulation (sleep >= 40 ms) fails the 40 ms assertion
  const unboundedWait = () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45);
    const err = new Error('store-locked');
    err.code = 'store-locked';
    throw err;
  };
  assert.throws(
    () => assertBoundedWait(unboundedWait),
    (err) => err.message.includes('unbounded wait: operation took') && err.message.includes('>= 40 ms bound')
  );

  // Negative control 2: a function throwing an error other than store-locked fails the assertion
  const wrongError = () => {
    throw new Error('something-else');
  };
  assert.throws(
    () => assertBoundedWait(wrongError),
    (err) => err.message.includes('expected store-locked error')
  );
});
