'use strict';

// The task-state lock of runtimes from before 117 Phase C, for old-vs-new contention tests. This is a
// frozen copy of `tryAcquireLock` and `acquireLock` from src/runtime/task-state.ts at e003dc0d
// (lines 52-118; type annotations and the doc comments removed, the logic unchanged): an installed older runtime keeps
// running exactly this code against stores a newer runtime also writes, so it must never be updated
// to follow the current lock. It breaks any lock older than LOCK_STALE_MS by name and releases by name.

const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 250;
const LOCK_WAIT_MS = 20;

function sleep(ms: any) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryAcquireLock(fsImpl: any, file: any) {
  const lockDir = `${file}.lock`;
  const release = () => { try { fsImpl.rmdirSync(lockDir); } catch { /* released is released */ } };
  try {
    fsImpl.mkdirSync(lockDir);
    return release;
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
  }
  let lock;
  try { lock = fsImpl.statSync(lockDir); } catch (error: any) {
    if (error.code !== 'ENOENT') return null;
    try { fsImpl.mkdirSync(lockDir); return release; } catch (retryError: any) {
      if (retryError.code === 'EEXIST') return null;
      throw retryError;
    }
  }
  if (Date.now() - lock.mtimeMs <= LOCK_STALE_MS) return null;
  try { fsImpl.rmdirSync(lockDir); } catch (error: any) {
    if (error.code !== 'ENOENT') return null;
  }
  try { fsImpl.mkdirSync(lockDir); return release; } catch (error: any) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
}

function acquireLock(fsImpl: any, file: any) {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + LOCK_RETRIES * LOCK_WAIT_MS;
  for (let attempt = 0; attempt < LOCK_RETRIES && (attempt === 0 || Date.now() < deadline); attempt += 1) {
    try {
      fsImpl.mkdirSync(lockDir);
      return () => { try { fsImpl.rmdirSync(lockDir); } catch { /* released is released */ } };
    } catch {
      try {
        if (Date.now() - fsImpl.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          fsImpl.rmdirSync(lockDir);
          continue;
        }
      } catch { /* the holder released between our mkdir and stat — retry immediately */ }
      sleep(LOCK_WAIT_MS);
    }
  }
  throw new Error(`Could not lock '${file}' after ${(LOCK_RETRIES * LOCK_WAIT_MS) / 1000}s — another writer holds '${file}.lock'. `
    + 'If no other session is running, the lock is leftover from a crash younger than its stale timeout; retry shortly.');
}

module.exports = { tryAcquireLock, acquireLock, LOCK_STALE_MS };
