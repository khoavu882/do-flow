'use strict';

// The slot lock of runtimes from before FU-31dyvs, for old-vs-new contention tests. This is a frozen
// copy of `ownerFile`, `readLockOwner` and `acquireSlotLock` from src/runtime/slots.ts at 694ec9ba
// (lines 107-190; type annotations removed, the logic unchanged): an installed older runtime keeps
// running exactly this code against the slot files a newer runtime also writes, so it must never be
// updated to follow the current lock. It marks the lock with an `owner.json` file, renames a lock it
// judges stale aside (a dead token, or no token and older than 10 s) and returns no `held()`.

const path = require('node:path');

const SLOT_LOCK_STALE_MS = 10_000;
const SLOT_LOCK_WAIT_MS = 20;
const SLOT_LOCK_RETRIES = 1500;

function blockingSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ownerFile(lockDir) {
  return path.join(lockDir, 'owner.json');
}

function readLockOwner(fsImpl, lockDir) {
  const file = ownerFile(lockDir);
  try {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const owner = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
    return { pid: owner.pid, start: owner.start ?? null };
  } catch {
    return null;
  }
}

/**
 * Slot writes need a stronger lock than task-state's age-only default: a slow live critical section
 * must not be mistaken for a crashed writer. The owner token is written only after mkdir succeeds;
 * stale directories are renamed aside before removal so competing reclaimers cannot delete a new
 * owner's directory.
 */
function acquireSlotLock(fsImpl, file, deps) {
  const lockDir = `${file}.lock`;
  const token = { pid: deps.pid, start: deps.procStart(deps.pid) };
  const tokenFile = ownerFile(lockDir);
  const sameOwner = (owner) => owner && owner.pid === token.pid && owner.start === token.start;

  for (let attempt = 0; attempt < SLOT_LOCK_RETRIES; attempt += 1) {
    try {
      fsImpl.mkdirSync(lockDir);
      try {
        fsImpl.writeFileSync(tokenFile, JSON.stringify(token), 'utf8');
      } catch (error) {
        try { fsImpl.rmdirSync(lockDir); } catch { /* the failed writer still owns the empty directory */ }
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (!sameOwner(readLockOwner(fsImpl, lockDir))) return;
        try { fsImpl.unlinkSync(tokenFile); } catch (error) { if (error.code !== 'ENOENT') return; }
        try { fsImpl.rmdirSync(lockDir); } catch { /* another process already removed or replaced it */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    let stat;
    try { stat = fsImpl.statSync(lockDir); } catch (error) {
      if (error.code === 'ENOENT') continue;
      blockingSleep(SLOT_LOCK_WAIT_MS);
      continue;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    const owner = readLockOwner(fsImpl, lockDir);
    let ownerAlive = 'unknown';
    if (owner) {
      try { ownerAlive = deps.alive({ pid: owner.pid, start: owner.start }); } catch { ownerAlive = 'unknown'; }
    }
    const stale = owner
      ? ownerAlive === false || (ownerAlive === 'unknown' && ageMs > SLOT_LOCK_STALE_MS)
      : ageMs > SLOT_LOCK_STALE_MS;
    if (stale) {
      const abandoned = `${lockDir}.stale-${deps.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        fsImpl.renameSync(lockDir, abandoned);
        try { fsImpl.unlinkSync(ownerFile(abandoned)); } catch { /* a token may never have been written */ }
        try { fsImpl.rmdirSync(abandoned); } catch { /* leave unexpected contents for inspection */ }
        continue;
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EEXIST') continue;
      }
    }
    if (attempt + 1 < SLOT_LOCK_RETRIES) blockingSleep(SLOT_LOCK_WAIT_MS);
  }
  throw new Error(`Could not lock '${file}' after ${(SLOT_LOCK_RETRIES * SLOT_LOCK_WAIT_MS) / 1000}s — another writer holds '${lockDir}'.`);
}

module.exports = { acquireSlotLock, readLockOwner };
