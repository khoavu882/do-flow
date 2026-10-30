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
//     that holder's lock only, and a stale lock is reclaimed in place by one process (see the
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
// The lock is the `<file>.lock` directory, created with mkdirSync. A holder marks it with its own
// `owner-<pid>-<random>` entry. Before this protocol any process that found the lock older than
// LOCK_STALE_MS removed it by name and every release removed it by name, so two waiters that judged
// one stale lock could both take it and each one's release could delete the other's. Three facts
// carry the protocol (the safety argument, one interleaving at a time, is in the 117 feature records:
// research/phase-c-protocol.md):
//
//   - Pinned: no DoFlow runtime renames a lock directory and rmdir removes only an empty one, so a
//     directory with an entry in it stays at `<file>.lock` until it is empty. A process whose entry
//     is in the lock knows the directory at that path is the one holding its entry.
//   - Released: this runtime removes a lock directory only in its release, after removing its own
//     entry from the lock it held; it reclaims a stale lock in place. Older runtimes remove one by
//     name in their release, or after judging a lock stale.
//   - Alone: a process holds the lock when its entry is the only entry in it. Two processes whose
//     entries are in one directory cannot both have been alone in it.
//
//   - Acquire: note the time, mkdir `<file>.lock`, mkdir its entry inside, read the time again. Under
//     PUBLISH_BOUND_MS, no process can have judged the new directory stale before the entry landed,
//     so the entry is in this process's own directory. Over it, the entry may have landed in a
//     directory another process made after reclaiming this one (an older runtime's empty lock looks
//     exactly like a new one), so the process removes its entry and starts over. Then it lists the
//     lock: alone, it holds.
//   - Reclaim (the lock is older than LOCK_STALE_MS): stat, list, stat again (the same directory,
//     unchanged, so every entry listed has been there that long); mkdir its own entry; stat again:
//     not the same directory means the judged one was removed and the entry landed in a newer lock,
//     so it removes its entry and starts over. Then it removes the judged entries by name (names are
//     unique, so a later holder's entry is never among them) and lists the lock: alone, it holds. The
//     directory never empties on the way, so an older runtime's rmdir of a stale lock fails instead of
//     removing it.
//   - Contention: two entries mean two processes reached the lock. The one whose entry name sorts
//     first waits for the other to leave (it holds next); the other removes its entry and waits. A
//     process that removes its entry and finds the lock emptied enters it again (once, under a fresh
//     name, after checking it is the same directory) instead of leaving an empty lock everyone would
//     wait 10 s on.
//   - Release notes the lock's identity while its entry is in it, removes the entry, then removes the
//     directory only if it is still that one (an older runtime may have made a new, empty lock there
//     if the release stalled). A holder whose entry is gone (its lock was reclaimed) removes nothing;
//     a waiting process's entry keeps the directory, and that process holds next.
//   - `updateTaskState` checks the holder's entry is still in the lock (`release.held()`) after
//     writing its tmp file and before the rename: a holder that was paused past LOCK_STALE_MS and
//     reclaimed writes nothing.
//
// Runtimes from before this protocol see a directory they did not create: they wait on a fresh one,
// and on a stale one their rmdir fails (it is not empty), so they fail closed ("Could not lock",
// `store-locked`) instead of taking it; their release of a lock reclaimed from them fails the same
// way. Whatever a process leaves when it dies is reclaimed once LOCK_STALE_MS old.
const OWNER_PREFIX = 'owner-';
// The longest a fresh acquire may take from its mkdir to its entry and still trust the directory is
// its own: half the stale age, so a process that judged it stale cannot have done so before the
// entry landed, with room for coarse file timestamps.
const PUBLISH_BOUND_MS = LOCK_STALE_MS / 2;
// How long tryAcquireLock waits for a process that reached the lock at the same moment to leave.
const CONTEND_MS = 40;
const CONTEND_WAIT_MS = 2;

type LockStep = 'held' | 'busy' | 'again' | 'queued';

/**
 * Optional lock settings (FU-31dyvs, for a store whose holders are identified by their entry): the
 * defaults are the protocol above, unchanged.
 *   - `stale` replaces the age rule of a reclaim. It is asked after the listing re-check, with the
 *     entries listed and the lock's age, and the reclaim goes ahead only when it says true. It must
 *     treat an empty lock by age (an acquire in progress makes an empty lock first; see
 *     PUBLISH_BOUND_MS), and it may judge an entry by its owner: an entry whose owner is dead can be
 *     reclaimed at any age, because a dead process never acts on it again.
 *   - `entryName` makes this process's entry name (default `owner-<pid>-<random>`); every name it
 *     makes must be unique.
 *   - `removeEntry` removes one judged entry by name (default rmdir); it throws as rmdir would.
 *   - `retries` is acquireLock's attempt budget (default LOCK_RETRIES, each LOCK_WAIT_MS apart).
 */
type LockOptions = {
  stale?: (lock: { lockDir: string; entries: string[]; ageMs: number }) => boolean;
  entryName?: () => string;
  removeEntry?: (fsImpl: any, lockDir: string, name: string) => void;
  retries?: number;
};

/** Same directory: same device and inode, and the same birth time where the platform reports one. */
function sameDir(a: any, b: any): boolean {
  return a.dev === b.dev && a.ino === b.ino && (!a.birthtimeMs || !b.birthtimeMs || a.birthtimeMs === b.birthtimeMs);
}

/** This attempt's entry name; `leave` gives it a fresh one when it re-enters an emptied lock. */
type Entry = { name: string };

/** Removes this process's entry; gone already is fine (a reclaimer removed it). */
function withdraw(fsImpl: any, lockDir: string, me: Entry): void {
  try { fsImpl.rmdirSync(path.join(lockDir, me.name)); } catch { /* not there: nothing of ours is left */ }
}

/**
 * With this process's entry in the lock: `held` when it is the only entry; `queued` when another
 * entry is there and ours sorts first (we hold once it leaves); otherwise we leave (`busy`, or `held`
 * when leaving found everyone else gone). `again` when our entry is gone (the lock was reclaimed from
 * us). With `rejoin` false (an entry that came back to an emptied lock) it never queues or comes back.
 */
function elect(fsImpl: any, lockDir: string, me: Entry, rejoin = true, options: LockOptions = {}): LockStep {
  let entries: string[];
  let pinned: any;
  try {
    entries = fsImpl.readdirSync(lockDir);
    if (!entries.includes(me.name)) return 'again';
    if (entries.length === 1) return 'held';
    if (rejoin && entries.every((name: string) => name === me.name || me.name < name)) return 'queued';
    pinned = pinnedDir(fsImpl, lockDir, me);
  } catch { pinned = null; }
  if (!pinned) { withdraw(fsImpl, lockDir, me); return 'again'; }
  if (!rejoin) { withdraw(fsImpl, lockDir, me); return 'busy'; }
  return leave(fsImpl, lockDir, me, pinned, options);
}

/** The stat of the lock while our entry is in it (so it is the directory holding our entry), or null. */
function pinnedDir(fsImpl: any, lockDir: string, me: Entry): any {
  try {
    const stat = fsImpl.statSync(lockDir);
    return fsImpl.existsSync(path.join(lockDir, me.name)) ? stat : null;
  } catch { return null; }
}

/**
 * Removes our entry from the lock `pinned` (its stat taken while our entry was in it). If that left
 * it empty, everyone else left after we looked, and an empty lock would block every process until it
 * is stale: we enter it again, once, under a fresh name (a reclaimer that listed the old name removes
 * names it listed), and hold it if we are alone. Never removes the directory.
 */
function leave(fsImpl: any, lockDir: string, me: Entry, pinned: any, options: LockOptions = {}): LockStep {
  withdraw(fsImpl, lockDir, me);
  try {
    if (fsImpl.readdirSync(lockDir).length > 0) return 'busy';
    me.name = (options.entryName || newToken)();
    fsImpl.mkdirSync(path.join(lockDir, me.name));
  } catch (error: any) { return error.code === 'ENOENT' ? 'again' : 'busy'; }
  let same = false;
  try { same = sameDir(pinned, fsImpl.statSync(lockDir)); } catch { /* treat it as changed */ }
  if (!same) { withdraw(fsImpl, lockDir, me); return 'again'; }
  return elect(fsImpl, lockDir, me, false, options);
}

/** A queued attempt that stops waiting: leave the lock (or hold it, when the other left meanwhile). */
function giveUp(fsImpl: any, lockDir: string, me: Entry, options: LockOptions = {}): LockStep {
  const step = elect(fsImpl, lockDir, me, true, options);
  if (step !== 'queued') return step;
  const pinned = pinnedDir(fsImpl, lockDir, me);
  if (!pinned) { withdraw(fsImpl, lockDir, me); return 'again'; }
  return leave(fsImpl, lockDir, me, pinned, options);
}

/** Reclaims the lock at `lockDir` in place when it is stale. `again` means look again now. */
function reclaimIfStale(fsImpl: any, lockDir: string, me: Entry, options: LockOptions = {}): LockStep {
  const missing = (error: any): LockStep => (error.code === 'ENOENT' ? 'again' : 'busy');
  let judged: any;
  let entries: string[];
  try {
    judged = fsImpl.statSync(lockDir);
    if (!options.stale && Date.now() - judged.mtimeMs <= LOCK_STALE_MS) return 'busy';
    entries = fsImpl.readdirSync(lockDir);
    const listed = fsImpl.statSync(lockDir);
    if (!sameDir(judged, listed) || listed.mtimeMs !== judged.mtimeMs) return 'again';
  } catch (error: any) { return missing(error); }
  if (options.stale && !options.stale({ lockDir, entries, ageMs: Date.now() - judged.mtimeMs })) return 'busy';
  try { fsImpl.mkdirSync(path.join(lockDir, me.name)); } catch (error: any) { return missing(error); }
  // Our entry pins the directory it landed in; it must be the one judged stale.
  let same = false;
  try { same = sameDir(judged, fsImpl.statSync(lockDir)); } catch { /* treat it as changed */ }
  if (!same) {
    withdraw(fsImpl, lockDir, me);
    return 'again';
  }
  for (const name of entries) {
    try {
      if (options.removeEntry) options.removeEntry(fsImpl, lockDir, name);
      else fsImpl.rmdirSync(path.join(lockDir, name));
    } catch (error: any) {
      if (error.code === 'ENOENT') continue; // another reclaimer, or its released holder, removed it
      withdraw(fsImpl, lockDir, me); // not an entry this protocol makes: leave the lock alone
      return 'busy';
    }
  }
  return elect(fsImpl, lockDir, me, true, options);
}

/**
 * A queued attempt's next look, for a lock with a `stale` rule (FU-31dyvs C-5): the other entries are
 * judged as a reclaim judges them (listing re-check, `stale`, the directory still the one holding our
 * entry), and when they are stale they are removed by name, so a queued process does not wait out its
 * budget behind a holder that died. Without a `stale` rule this is `elect`, unchanged.
 */
function queuedStep(fsImpl: any, lockDir: string, me: Entry, options: LockOptions): LockStep {
  if (!options.stale) return elect(fsImpl, lockDir, me, true, options);
  let judged: any;
  let others: string[];
  try {
    judged = fsImpl.statSync(lockDir);
    const entries: string[] = fsImpl.readdirSync(lockDir);
    const listed = fsImpl.statSync(lockDir);
    if (!sameDir(judged, listed) || listed.mtimeMs !== judged.mtimeMs || !entries.includes(me.name)) return elect(fsImpl, lockDir, me, true, options);
    others = entries.filter((name: string) => name !== me.name);
  } catch { return elect(fsImpl, lockDir, me, true, options); }
  if (others.length === 0 || !options.stale({ lockDir, entries: others, ageMs: Date.now() - judged.mtimeMs })) return elect(fsImpl, lockDir, me, true, options);
  const pinned = pinnedDir(fsImpl, lockDir, me);
  if (!pinned || !sameDir(pinned, judged)) return elect(fsImpl, lockDir, me, true, options);
  for (const name of others) {
    try {
      if (options.removeEntry) options.removeEntry(fsImpl, lockDir, name);
      else fsImpl.rmdirSync(path.join(lockDir, name));
    } catch (error: any) {
      if (error.code !== 'ENOENT') break; // not removable now: elect decides as before
    }
  }
  return elect(fsImpl, lockDir, me, true, options);
}

/** One step towards holding the lock under `me`: held, queued (our entry waits in it), busy, or again. */
function attemptLock(fsImpl: any, lockDir: string, me: Entry, options: LockOptions = {}): LockStep {
  const started = Date.now();
  try {
    fsImpl.mkdirSync(lockDir);
  } catch (error: any) {
    // Windows reports EPERM/EACCES for a lock folder another process is deleting at this moment.
    if (error.code !== 'EEXIST' && !(process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES'))) throw error;
    return reclaimIfStale(fsImpl, lockDir, me, options);
  }
  try {
    fsImpl.mkdirSync(path.join(lockDir, me.name));
  } catch (error: any) {
    if (error.code === 'ENOENT') return 'again'; // removed before it was marked: an older runtime's release or stale break
    throw error;
  }
  if (Date.now() - started >= PUBLISH_BOUND_MS) {
    // Paused long enough for the new directory to be judged stale and replaced: the entry may sit in
    // another process's lock. Leave it; the directory (ours or not) is left as found.
    withdraw(fsImpl, lockDir, me);
    return 'again';
  }
  return elect(fsImpl, lockDir, me, true, options);
}

/** The release function of a held lock; `release.held()` re-checks ownership before a write. */
function ownedRelease(fsImpl: any, lockDir: string, me: Entry): any {
  const entry = path.join(lockDir, me.name);
  let released = false;
  const release: any = () => {
    if (released) return;
    released = true;
    const mine = pinnedDir(fsImpl, lockDir, me); // the directory we hold, while our entry pins it
    try { fsImpl.rmdirSync(entry); } catch { return; } // reclaimed: the lock is not ours to remove
    // Removed only if it is still that directory: a release stalled here past LOCK_STALE_MS may find
    // an older runtime's new (empty) lock at the path. What stays is the gap between this stat and the
    // rmdir.
    try {
      if (mine && sameDir(mine, fsImpl.statSync(lockDir))) fsImpl.rmdirSync(lockDir);
    } catch { /* a waiting process's entry is in it; that process holds next */ }
  };
  release.held = () => !released && fsImpl.existsSync(entry);
  return release;
}

const newToken = () => `${OWNER_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`;

/**
 * Makes one attempt to take the cross-process lock for a state file, without waiting on a holder:
 * a lock older than LOCK_STALE_MS is reclaimed, a live holder is never waited on. It waits only when
 * another process reached the lock at the same moment, for at most CONTEND_MS (40 ms) for that
 * process to leave. Returns a release function or null.
 * @param {Object} fsImpl
 * @param {string} file
 * @param {LockOptions} [options] see LockOptions; the defaults are the protocol above
 * @returns {(() => void)|null}
 */
function tryAcquireLock(fsImpl: any, file: string, options: LockOptions = {}): (() => void) | null {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + CONTEND_MS;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const me = { name: (options.entryName || newToken)() };
    let step = attemptLock(fsImpl, lockDir, me, options);
    while (step === 'queued' && Date.now() < deadline) {
      sleep(CONTEND_WAIT_MS);
      step = queuedStep(fsImpl, lockDir, me, options);
    }
    if (step === 'queued') step = giveUp(fsImpl, lockDir, me, options);
    if (step === 'held') return ownedRelease(fsImpl, lockDir, me);
    if (step === 'busy') return null;
  }
  return null;
}

/**
 * Takes the cross-process lock for one state file, waiting up to LOCK_RETRIES * LOCK_WAIT_MS (5 s).
 * A lock older than LOCK_STALE_MS is reclaimed: its holder died or stalled, and the rename-based write
 * keeps the file whole.
 * @param {Object} fsImpl
 * @param {string} file
 * @param {LockOptions} [options] see LockOptions; the defaults are the protocol above
 * @returns {() => void}
 */
function acquireLock(fsImpl: any, file: string, options: LockOptions = {}): () => void {
  const lockDir = `${file}.lock`;
  const retries = options.retries ?? LOCK_RETRIES;
  // The stale rule below is wall-clock, so the wait must be too: on a host where each attempt costs
  // real time, counting attempts alone would outlive a live holder's staleness window.
  const deadline = Date.now() + retries * LOCK_WAIT_MS;
  let step: LockStep = 'again';
  let me: Entry = { name: '' };
  for (let attempt = 0; attempt < retries && (attempt === 0 || Date.now() < deadline); attempt += 1) {
    if (step === 'queued') step = queuedStep(fsImpl, lockDir, me, options);
    else {
      me = { name: (options.entryName || newToken)() }; // a fresh entry name per attempt: an earlier one's name never comes back
      step = attemptLock(fsImpl, lockDir, me, options);
    }
    if (step === 'held') return ownedRelease(fsImpl, lockDir, me);
    if (step === 'busy' || step === 'queued') sleep(LOCK_WAIT_MS);
  }
  if (step === 'queued' && giveUp(fsImpl, lockDir, me, options) === 'held') return ownedRelease(fsImpl, lockDir, me);
  throw new Error(`Could not lock '${file}' after ${(retries * LOCK_WAIT_MS) / 1000}s — another writer holds '${lockDir}'. `
    + `If no other DoFlow process is running, the lock is left from a crash and is reclaimed once it is ${LOCK_STALE_MS / 1000}s old; retry then.`
    + strayEntries(fsImpl, lockDir));
}

/** Names a non-directory entry in the lock (no DoFlow runtime makes one; it blocks the lock until removed). */
function strayEntries(fsImpl: any, lockDir: string): string {
  let stray: string[] = [];
  try { stray = fsImpl.readdirSync(lockDir, { withFileTypes: true }).filter((d: any) => !d.isDirectory()).map((d: any) => d.name); } catch { return ''; }
  if (stray.length === 0) return '';
  return ` It holds ${stray.map((name) => `'${name}'`).join(', ')}, which no DoFlow runtime makes and which keeps it locked: `
    + `remove ${stray.length > 1 ? 'them' : 'it'} once no DoFlow process is running.`;
}

/**
 * Takes the cross-process lock for one state file with a bounded wait.
 * Makes 1 try plus `retries` retries (default 3) separated by `waitMs` (default 5); each try is one
 * tryAcquireLock, which waits at most 40 ms, and only on a process that reached the lock at the same moment.
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
    // The parser's own message quotes the first bytes of the file; a state file can hold text the
    // reader should not echo, so only the error's class is named.
    const failure: any = new Error(`Failed to load state file '${file}': its content is not valid JSON (${error?.name || 'Error'}). The write path is atomic `
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

/** How many times the folder is made again when it vanishes before the lock can be made in it. */
const FOLDER_RACE_RETRIES = 5;

/**
 * Makes the state file's folder and takes the lock in it. The lock is a folder inside the state
 * file's folder and is made without `recursive`, so a sweep that removes an empty namespace folder
 * between the two steps makes the lock fail with ENOENT. The folder is then made again, a bounded
 * number of times; the sweep never removes a folder that holds a lock, so a taken lock keeps it.
 */
function acquireInFolder(fsImpl: any, file: string, acquire: (fsImpl: any, file: string) => () => void): () => void {
  for (let tries = 0; ; tries += 1) {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    try {
      return acquire(fsImpl, file);
    } catch (error: any) {
      if (error && error.code === 'ENOENT' && tries < FOLDER_RACE_RETRIES) continue;
      throw error;
    }
  }
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
    const release: any = acquireInFolder(fsImpl, file, acquire);
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
        try { fsImpl.rmSync(tmp, { force: true }); } catch { /* stale-temp pruning removes it later */ }
        if (attempt < lostLockRetries) continue;
        const lost: any = new Error(`Lost the lock on '${file}' to another writer before writing (this writer stalled past `
          + `${LOCK_STALE_MS / 1000}s${lostLockRetries ? `, ${lostLockRetries + 1} times` : ''}). Nothing was written; run the command again.`);
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
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  boundedAcquire,
  updateTaskState,
  readTaskState,
  mergeRecords,
  SCHEMA_VERSION,
};
