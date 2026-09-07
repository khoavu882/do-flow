'use strict';

// ── Durable per-task state: locked, merged, versioned ────────────────────────────────────────────
//
// EvidenceLedger.save and ClaimsManager.save used to overwrite their whole JSON file with
// writeFileSync — no writer exclusion, no revision check. Two sessions whose read-modify-write
// operations overlapped both reported success and the final file held only the later writer's
// items (architecture review R4, reproduced with two ledger instances on one task). Atomic rename
// alone does not fix that: it prevents a torn file, not a lost update.
//
// This module is the one seam both stores persist through:
//
//   - a per-file lock (`<file>.lock` directory — mkdirSync is atomic on every platform) makes the
//     read-merge-write below a critical section across processes on this machine;
//   - inside the lock, the writer re-reads the file and MERGES what is on disk into its own view
//     before writing, so an overlapping writer's items survive;
//   - the payload carries a monotonically increasing `revision`, so an overlapped-and-merged
//     history is visible in the record rather than silent;
//   - the write itself is tmp-file + rename, so an interrupted writer leaves the previous state
//     intact plus an ignorable `*.tmp` — never a half-written file;
//   - `readTaskState` validates the schema version and refuses a file from a future schema with
//     the version named, instead of guessing at its shape.

const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

/** Three-way merge against the reader's snapshot. Unchanged local records never overwrite a
 * newer disk version; concurrent edits to the same record must be retried after an explicit read. */
function mergeRecords(local, disk, baseline) {
  const merged = new Map(disk.map(item => [item.id, item]));
  for (const item of local) {
    const previous = baseline.get(item.id);
    const current = merged.get(item.id);
    if (isDeepStrictEqual(item, previous)) continue;
    if (current && !isDeepStrictEqual(current, previous) && !isDeepStrictEqual(current, item)) {
      throw new Error(`Concurrent update to '${item.id}'; reload the task and reapply the change. Nothing was written.`);
    }
    merged.set(item.id, item);
  }
  return [...merged.values()];
}

const SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 250;
const LOCK_WAIT_MS = 20;

/** Synchronous sleep without spinning: Atomics.wait on a throwaway buffer. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Takes the cross-process lock for one state file. Returns the release function.
 * A lock older than LOCK_STALE_MS is broken: its holder died mid-write (the rename-based write
 * below means the file it guarded is still whole), and honouring a dead writer's lock forever
 * turns one crash into a permanently unwritable task.
 * @param {Object} fsImpl
 * @param {string} file
 * @returns {() => void}
 */
function acquireLock(fsImpl, file) {
  const lockDir = `${file}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
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

/**
 * Reads and validates one task-state file. Returns null when the file does not exist.
 * @param {Object} fsImpl
 * @param {string} file
 * @returns {Object|null} the parsed payload
 */
function readTaskState(fsImpl, file) {
  if (!fsImpl.existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to load state file '${file}': ${error.message}. The write path is atomic `
      + '(tmp + rename), so a torn file means outside interference; recover it from version control '
      + 'or move it aside and re-record the task\'s items.');
  }
  if (data && typeof data === 'object' && data.version !== undefined && data.version !== SCHEMA_VERSION) {
    throw new Error(`State file '${file}' has schema version ${data.version}; this runtime reads version ${SCHEMA_VERSION}. `
      + 'Refusing to guess at its shape — upgrade the runtime or migrate the file.');
  }
  return data;
}

/**
 * The one durable-update path: lock, re-read, merge, bump revision, atomic write.
 *
 * @param {Object} options
 * @param {Object} options.fsImpl fs implementation (tests substitute one)
 * @param {string} options.file absolute path of the state file
 * @param {(diskPayload: Object|null) => Object} options.build called INSIDE the lock with what is
 *   currently on disk; must fold any disk items unknown to the caller into the caller's view and
 *   return the complete new payload (without `version`/`revision`, which are stamped here)
 * @returns {string} the file path written
 */
function updateTaskState({ fsImpl, file, build }) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireLock(fsImpl, file);
  try {
    const disk = readTaskState(fsImpl, file);
    const payload = {
      ...build(disk),
      version: SCHEMA_VERSION,
      revision: (disk && Number.isInteger(disk.revision) ? disk.revision : 0) + 1,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fsImpl.renameSync(tmp, file);
    return file;
  } finally {
    release();
  }
}

module.exports = { updateTaskState, readTaskState, mergeRecords, SCHEMA_VERSION };
