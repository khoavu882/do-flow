'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

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
//     read-merge-write below a critical section across processes on this machine; the holder
//     marks the directory with its own `owner-*` entry, so release and the pre-write check act on
//     that holder's lock only, and a stale lock is reclaimed by exactly one process (see the
//     protocol above `attemptLock`);
//   - inside the lock, the writer re-reads the file and MERGES what is on disk into its own view
//     before writing, so an overlapping writer's items survive;
//   - the payload carries a monotonically increasing `revision`, so an overlapped-and-merged
//     history is visible in the record rather than silent;
//   - the write itself is tmp-file + rename, so an interrupted writer leaves the previous state
//     intact plus an ignorable `*.tmp` — never a half-written file;
//   - `readTaskState` validates the schema version and refuses a file from a future schema with
//     the version named, instead of guessing at its shape.

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

/** Three-way merge against the reader's snapshot. Unchanged local records never overwrite a
 * newer disk version; concurrent edits to the same record must be retried after an explicit read. */
function mergeRecords(local: any[], disk: any[], baseline: Map<any, any>): any[] {
  const merged = new Map(disk.map((item: any) => [item.id, item]));
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
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── The lock protocol (117 Phase C; FU-8acds5, FU-vgkrvd) ───────────────────────────────────────────
//
// The lock is still the `<file>.lock` directory, created with mkdirSync. What changed is who may
// remove it. Before, any process that found it older than LOCK_STALE_MS removed it by name, and
// every release removed it by name: two waiters that judged the same stale lock could both take it,
// and each one's release could delete the other's.
//
//   - Acquire: mkdir `<file>.lock`, then mkdir `<file>.lock/owner-<pid>-<random>` (the holder's own
//     entry). The lock is held while that entry is in the directory at `<file>.lock`.
//   - Release removes the holder's own entry, then the directory. A holder whose entry is gone (its
//     lock was reclaimed) removes nothing, so it can never delete a newer holder's lock.
//   - Reclaim (a lock older than LOCK_STALE_MS): list the directory, confirm it is still the same
//     directory, then mkdir `<file>.lock/reclaim` (exclusive: one reclaimer wins). A non-empty
//     directory cannot be removed by rmdir, so from that moment only the claimant can move it. The
//     claimant lists it again: the same directory with no entry it lacked when judged (its holder may
//     have released meanwhile) means it is the lock that was judged stale, and the claimant renames it
//     aside and deletes it; anything else (a new lock appeared in between) and the claimant removes
//     its claim and starts over.
//   - A new holder checks for a `reclaim` entry after writing its own (`settle`): a claim placed
//     before the holder's entry existed may still move the directory, so the holder waits until
//     the claim is withdrawn (it holds the lock) or its own entry has gone (it does not).
//   - `updateTaskState` makes the same check (`release.held()`) after writing its tmp file and
//     before the rename: a holder that was paused past LOCK_STALE_MS and reclaimed writes nothing.
//
// Runtimes from before this protocol see a directory they did not create: they wait on a fresh one,
// and on a stale one their rmdir fails (it is not empty), so they fail closed ("Could not lock",
// `store-locked`) instead of taking it; their release of a lock that was reclaimed from them fails
// the same way and leaves the new holder's lock in place. Bounds, not covered: a holder paused past
// LOCK_STALE_MS between `held()` and its rename; an older runtime and a new one reclaiming the same
// stale lock at the same moment (the older one still breaks by name); a reclaimer that dies holding
// its claim leaves the lock in place until someone removes `<file>.lock` (the error names it).
const OWNER_PREFIX = 'owner-';
const RECLAIM_ENTRY = 'reclaim';
// How long a new holder waits for a concurrent reclaimer to decide; it decides in a few fs calls.
const SETTLE_MS = 1000;
const SETTLE_WAIT_MS = 2;
const IMMEDIATE_ATTEMPTS = 3;

type LockStep = 'held' | 'busy' | 'again';

/** Same directory: same device and inode, and the same birth time where the platform reports one. */
function sameDir(a: any, b: any): boolean {
  return a.dev === b.dev && a.ino === b.ino && (!a.birthtimeMs || !b.birthtimeMs || a.birthtimeMs === b.birthtimeMs);
}

/** True while `token` is this holder's entry in the lock and no reclaimer's claim is deciding. */
function settle(fsImpl: any, lockDir: string, token: string): boolean {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    // The claim is checked first: a claimant that moves the directory between the two checks takes
    // the owner entry with it, and the second check then sees it gone.
    const claimed = fsImpl.existsSync(path.join(lockDir, RECLAIM_ENTRY));
    if (!fsImpl.existsSync(path.join(lockDir, token))) return false;
    if (!claimed) return true;
    if (Date.now() >= deadline) return false;
    sleep(SETTLE_WAIT_MS);
  }
}

/** Reclaims the lock at `lockDir` when it is stale; never takes it. `again` means look again now. */
function reclaimIfStale(fsImpl: any, lockDir: string): LockStep {
  const missing = (error: any): LockStep => (error.code === 'ENOENT' ? 'again' : 'busy');
  let judged: any;
  let entries: string[];
  try {
    judged = fsImpl.statSync(lockDir);
    if (Date.now() - judged.mtimeMs <= LOCK_STALE_MS) return 'busy';
    entries = fsImpl.readdirSync(lockDir);
    if (entries.includes(RECLAIM_ENTRY)) return 'busy';
    const listed = fsImpl.statSync(lockDir);
    if (!sameDir(judged, listed) || listed.mtimeMs !== judged.mtimeMs) return 'again';
  } catch (error: any) { return missing(error); }
  const claim = path.join(lockDir, RECLAIM_ENTRY);
  try { fsImpl.mkdirSync(claim); } catch (error: any) { return error.code === 'EEXIST' ? 'busy' : missing(error); }
  // Only this claimant can move or remove the directory now; it is the judged lock or a newer one.
  let same = false;
  try {
    // An entry can only have gone (its holder released), never come, while it is the judged lock.
    const now = fsImpl.readdirSync(lockDir).filter((name: string) => name !== RECLAIM_ENTRY);
    same = sameDir(judged, fsImpl.statSync(lockDir)) && now.every((name: string) => entries.includes(name));
  } catch { /* unreadable: treat it as changed */ }
  if (same) {
    const aside = `${lockDir}.reclaimed-${randomBytes(6).toString('hex')}`;
    try {
      fsImpl.renameSync(lockDir, aside);
    } catch {
      same = false;
    }
    if (same) {
      try { fsImpl.rmSync(aside, { recursive: true, force: true }); } catch { /* an orphan aside dir holds no lock */ }
      return 'again';
    }
  }
  try { fsImpl.rmdirSync(claim); } catch { /* the claim stays; the lock then needs removing by hand (see acquireLock) */ }
  return 'again';
}

/** One step towards holding the lock under `token`: held, busy (wait), or again (retry now). */
function attemptLock(fsImpl: any, lockDir: string, token: string): LockStep {
  try {
    fsImpl.mkdirSync(lockDir);
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    return reclaimIfStale(fsImpl, lockDir);
  }
  try {
    fsImpl.mkdirSync(path.join(lockDir, token));
  } catch (error: any) {
    if (error.code === 'ENOENT') return 'again'; // removed before it was marked: an older runtime's release or a reclaim
    try { fsImpl.rmdirSync(lockDir); } catch { /* left for the stale rule */ }
    throw error;
  }
  return settle(fsImpl, lockDir, token) ? 'held' : 'again';
}

/** The release function of a held lock; `release.held()` re-checks ownership before a write. */
function ownedRelease(fsImpl: any, lockDir: string, token: string): any {
  let released = false;
  const release: any = () => {
    if (released) return;
    released = true;
    try { fsImpl.rmdirSync(path.join(lockDir, token)); } catch { return; } // reclaimed: the lock is not ours to remove
    try { fsImpl.rmdirSync(lockDir); } catch { /* a reclaimer's claim is deciding; it moves or frees the directory */ }
  };
  release.held = () => !released && settle(fsImpl, lockDir, token);
  return release;
}

const newToken = () => `${OWNER_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`;

/**
 * Makes one non-waiting attempt to take the cross-process lock for a state file. A lock older than
 * LOCK_STALE_MS may be reclaimed; a live holder is never waited on. Returns a release function or null.
 * @param {Object} fsImpl
 * @param {string} file
 * @returns {(() => void)|null}
 */
function tryAcquireLock(fsImpl: any, file: string): (() => void) | null {
  const lockDir = `${file}.lock`;
  const token = newToken();
  for (let attempt = 0; attempt < IMMEDIATE_ATTEMPTS; attempt += 1) {
    const step = attemptLock(fsImpl, lockDir, token);
    if (step === 'held') return ownedRelease(fsImpl, lockDir, token);
    if (step === 'busy') return null;
  }
  return null;
}

/**
 * Takes the cross-process lock for one state file, retrying for the existing bounded wait interval.
 * A stale lock is reclaimed because its holder died or stalled; the rename-based write keeps the file whole.
 * @param {Object} fsImpl
 * @param {string} file
 * @returns {() => void}
 */
function acquireLock(fsImpl: any, file: string): () => void {
  const lockDir = `${file}.lock`;
  const token = newToken();
  // The stale rule below is wall-clock, so the wait must be too: on a host where each attempt costs
  // real time, counting attempts alone would outlive a live holder's staleness window.
  const deadline = Date.now() + LOCK_RETRIES * LOCK_WAIT_MS;
  for (let attempt = 0; attempt < LOCK_RETRIES && (attempt === 0 || Date.now() < deadline); attempt += 1) {
    const step = attemptLock(fsImpl, lockDir, token);
    if (step === 'held') return ownedRelease(fsImpl, lockDir, token);
    if (step === 'busy') sleep(LOCK_WAIT_MS);
  }
  throw new Error(`Could not lock '${file}' after ${(LOCK_RETRIES * LOCK_WAIT_MS) / 1000}s — another writer holds '${lockDir}'. `
    + 'If no other session is running, the lock is leftover from a crash younger than its stale timeout; retry shortly. '
    + `If it holds a '${RECLAIM_ENTRY}' entry older than that, a process died reclaiming it: remove '${lockDir}' once no DoFlow process is running.`);
}

/**
 * Takes the cross-process lock for one state file with a bounded wait.
 * Makes 1 try plus `retries` retries (default 3) separated by `waitMs` (default 5).
 * Throws an Error('store-locked') after one try plus retries.
 * @param {Object} fsImpl
 * @param {string} file
 * @param {Object} [options]
 * @param {number} [options.retries=3]
 * @param {number} [options.waitMs=5]
 * @returns {() => void} release function
 */
function boundedAcquire(
  fsImpl: any,
  file: string,
  options: {
    retries?: number;
    waitMs?: number;
    sleepFn?: (ms: number) => void;
    tryAcquireLockFn?: (fsImpl: any, file: string) => (() => void) | null;
  } = {}
): () => void {
  const retries = options?.retries ?? 3;
  const waitMs = options?.waitMs ?? 5;
  const sleepFn = options?.sleepFn ?? sleep;
  const tryAcquire = options?.tryAcquireLockFn ?? tryAcquireLock;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const release = tryAcquire(fsImpl, file);
    if (release) return release;
    if (attempt < retries && waitMs > 0) {
      sleepFn(waitMs);
    }
  }
  const error = new Error('store-locked');
  (error as any).code = 'store-locked';
  throw error;
}

/**
 * Reads and validates one task-state file. Returns null when the file does not exist.
 * @param {Object} fsImpl
 * @param {string} file
 * @returns {Object|null} the parsed payload
 */
function readTaskState(fsImpl: any, file: string): any {
  if (!fsImpl.existsSync(file)) return null;
  let data: any;
  try {
    data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (error: any) {
    const failure: any = new Error(`Failed to load state file '${file}': ${error.message}. The write path is atomic `
      + '(tmp + rename), so a torn file means outside interference; recover it from version control '
      + 'or move it aside and re-record the task\'s items.');
    failure.code = 'store-unreadable';
    throw failure;
  }
  if (data && typeof data === 'object' && data.version !== undefined && data.version !== SCHEMA_VERSION) {
    const failure: any = new Error(`State file '${file}' has schema version ${data.version}; this runtime reads version ${SCHEMA_VERSION}. `
      + 'Refusing to guess at its shape — upgrade the runtime or migrate the file.');
    failure.code = 'store-unreadable';
    throw failure;
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
 * @param {() => void} [options.prepare] called INSIDE the lock before the file is read, for a store
 *   that must inspect or set aside what is there under the same exclusion as the write
 * @param {(fsImpl: Object, file: string) => () => void} [options.acquire] optional lock acquirer
 *   defaulting to acquireLock
 * @param {number} [options.lostLockRetries=0] how many times to run the whole locked update again
 *   when the lock was reclaimed from this writer before its rename (nothing was written); only for a
 *   caller whose `prepare` and `build` have no effect outside the payload they return
 * @returns {string|null} the file path written, or null when build declines a write
 */
function updateTaskState({
  fsImpl,
  file,
  build,
  prepare,
  acquire = acquireLock,
  lostLockRetries = 0,
}: {
  fsImpl: any;
  file: string;
  build: (disk: any) => any;
  prepare?: () => void;
  acquire?: (fsImpl: any, file: string) => () => void;
  lostLockRetries?: number;
}): string | null {
  for (let attempt = 0; ; attempt += 1) {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const release: any = acquire(fsImpl, file);
    try {
      if (prepare) prepare();
      const disk = readTaskState(fsImpl, file);
      const built = build(disk);
      if (built === null) return null;
      const payload = {
        ...built,
        version: SCHEMA_VERSION,
        revision: (disk && Number.isInteger(disk.revision) ? disk.revision : 0) + 1,
      };
      const tmp = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      // A writer paused past LOCK_STALE_MS may have been reclaimed; its read is then stale.
      if (typeof release.held === 'function' && !release.held()) {
        if (attempt < lostLockRetries) continue;
        const lost: any = new Error(`Lost the lock on '${file}' to another writer before writing (this writer stalled past `
          + `${LOCK_STALE_MS / 1000}s). Nothing was written; retry.`);
        lost.code = 'lock-lost';
        throw lost;
      }
      fsImpl.renameSync(tmp, file);
      return file;
    } finally {
      release();
    }
  }
}

module.exports = {
  acquireLock,
  tryAcquireLock,
  boundedAcquire,
  updateTaskState,
  readTaskState,
  mergeRecords,
  SCHEMA_VERSION,
};
