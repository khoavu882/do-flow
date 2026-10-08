'use strict';

// run.lock — one DoFlow run at a time per scope. install, update, remove, reconcile and rollback
// read the ledger, doflow.lock and the install manifest, decide, and write them back; two runs in
// one scope interleaving those steps lose each other's rows. The lock serialises them.
//
// Taking it: the owner record goes into a private temp file first and is then hard-linked to
// run.lock, so the lock never exists half-written and a second link fails with EEXIST. Removing
// it, whether a holder releasing its own or a run clearing a stale one, happens only under a claim
// file named for the lock instance being removed (`run.lock.claim.<instance>`, created with `wx`),
// and only after re-reading run.lock under that claim and finding the same instance. One instance
// is therefore removed at most once, and never by a run that inspected a different one.
//
// Supported on a local POSIX filesystem on one host. The CLI is synchronous, so waiting blocks
// with Atomics.wait rather than a timer.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECORD_VERSION = 1;
const LOCK_FILE = 'run.lock';
const CLAIM_PREFIX = `${LOCK_FILE}.claim.`;

function loadVersion() {
  try { return require('../../package.json').version; } catch { return '0.0.0-installed'; }
}
const DOFLOW_VERSION = loadVersion();

/** Holds of this process, by resolved scope root: a nested acquisition counts instead of waiting on itself. */
const held = new Map();

function runLockPath(scopeRoot) { return path.join(path.resolve(scopeRoot), '.doflow', 'state', LOCK_FILE); }

function atomicsSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Alive when signal 0 reaches it, or it exists but belongs to someone else (EPERM). */
function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function scopeLabel({ scope, scopeRoot }) {
  return scope === 'global' ? `global scope (${scopeRoot})` : `project ${scopeRoot}`;
}

function holderLabel(holder) {
  return holder ? `pid ${holder.pid}, ${holder.command}, started ${holder.startedAt}` : 'holder unknown';
}

const STALE_REASONS = Object.freeze({ 'not-running': 'that process is not running', expired: 'it is older than 10 minutes' });

/**
 * The one text of every run-lock line, so the CLI prints exactly these.
 * @param {'waiting'|'cleared'|'timeout'|'lost'|'error'} kind
 * @param {{scope: string, scopeRoot: string, holder?: Object|null, waitMs?: number, reason?: string,
 *   lockPath?: string, waitedMs?: number, code?: string}} details
 */
function formatRunLockMessage(kind, details) {
  const where = scopeLabel(details);
  switch (kind) {
    case 'waiting':
      return `[INFO]  Waiting for another DoFlow run in ${where} (${holderLabel(details.holder)}); up to ${details.waitMs / 1000}s`;
    case 'cleared':
      return `[WARN]  Cleared a stale DoFlow run lock in ${where} (${holderLabel(details.holder)}): ${STALE_REASONS[details.reason]}`;
    case 'timeout':
      return `[ERROR] Another DoFlow run in ${where} (${holderLabel(details.holder)}) still holds ${details.lockPath} after ${Math.round(details.waitedMs / 1000)}s. Nothing was changed. Run the command again when it finishes; a lock whose process has exited is cleared automatically.`;
    case 'lost':
      return `[ERROR] This run's lock in ${where} was taken over by another DoFlow run while it waited; nothing was changed. Run the command again.`;
    case 'error':
      return `[ERROR] Cannot take the DoFlow run lock ${details.lockPath}: ${details.code}. Nothing was changed.`;
    default:
      throw new Error(`Unknown run-lock message kind: '${kind}'`);
  }
}

class RunLockError extends Error {
  constructor(details) {
    super(formatRunLockMessage('error', details));
    this.name = 'RunLockError';
    Object.assign(this, { code: details.code, lockPath: details.lockPath, scopeRoot: details.scopeRoot });
  }
}

class RunLockTimeoutError extends Error {
  constructor(details) {
    super(formatRunLockMessage('timeout', details));
    this.name = 'RunLockTimeoutError';
    Object.assign(this, { holder: details.holder, lockPath: details.lockPath, scopeRoot: details.scopeRoot, waitedMs: details.waitedMs });
  }
}

class RunLockLostError extends Error {
  constructor(details) {
    super(formatRunLockMessage('lost', details));
    this.name = 'RunLockLostError';
    Object.assign(this, { lockPath: details.lockPath, scopeRoot: details.scopeRoot });
  }
}

function isIdentified(record) {
  return Boolean(record) && typeof record.token === 'string' && Number.isInteger(record.pid) && typeof record.hostname === 'string';
}

/**
 * The lock file as one consistent read: content and stat come from the same open file, so a lock
 * replaced between the two calls can never pair one instance's record with another's age.
 * @returns {{record: Object|null, stat: fs.Stats, key: string}|null} null when there is no lock
 */
function readLockFile(fsImpl, lockPath) {
  let fd;
  try {
    fd = fsImpl.openSync(lockPath, 'r');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // A dangling symlink opens as ENOENT yet blocks link(); judge it by its own lstat.
    let stat;
    try { stat = fsImpl.lstatSync(lockPath); } catch (lstatErr) {
      if (lstatErr.code === 'ENOENT') return null;
      throw lstatErr;
    }
    return { record: null, stat, key: instanceKey(null, stat) };
  }
  try {
    const stat = fsImpl.fstatSync(fd);
    let record = null;
    try { record = JSON.parse(fsImpl.readFileSync(fd, 'utf8')); } catch { /* unidentified */ }
    if (!isIdentified(record)) record = null;
    return { record, stat, key: instanceKey(record, stat) };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function instanceKey(record, stat) {
  return record ? record.token : `u-${stat.dev}-${stat.ino}-${Math.floor(stat.mtimeMs)}`;
}

/** @returns {null|'not-running'|'expired'} */
function staleReason(found, { token, hostname, isAlive, now, staleMs }) {
  const { record, stat } = found;
  if (record && record.token === token) return null;
  if (record && record.hostname === hostname && (record.pid === process.pid || !isAlive(record.pid))) return 'not-running';
  if (now() - stat.mtimeMs > staleMs) return 'expired';
  return null;
}

function unlinkQuietly(fsImpl, file) {
  try { fsImpl.unlinkSync(file); } catch { /* already gone, or the stale rule clears it later */ }
}

function readRaw(fsImpl, file) {
  try { return fsImpl.readFileSync(file, 'utf8'); } catch { return null; }
}

/** A claim left by a run that died while clearing: its process is gone, or it is older than claimStaleMs. */
function isOrphanClaim(fsImpl, claimPath, { hostname, isAlive, now, claimStaleMs }) {
  let stat;
  try { stat = fsImpl.statSync(claimPath); } catch { return false; }
  if (now() - stat.mtimeMs > claimStaleMs) return true;
  let claim = null;
  try { claim = JSON.parse(fsImpl.readFileSync(claimPath, 'utf8')); } catch { return false; }
  return Boolean(claim) && claim.hostname === hostname && (claim.pid === process.pid || !isAlive(claim.pid));
}

/** Creates the claim for one lock instance. @returns {boolean} true when this run now holds it */
function createClaim(fsImpl, claimPath, { token, hostname, target }) {
  const body = `${JSON.stringify({ version: RECORD_VERSION, token, pid: process.pid, hostname, at: new Date().toISOString(), target })}\n`;
  try {
    fsImpl.writeFileSync(claimPath, body, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Takes a claim for instance `key`, removing an orphan claim first. A live claimant's claim means
 * another run is clearing this instance. The orphan is moved aside before it is deleted, and put
 * back when what was moved is not what was judged, so a fresh claim is never deleted by mistake.
 * @returns {boolean}
 */
function claimInstance(fsImpl, stateDir, key, options) {
  const claimPath = path.join(stateDir, `${CLAIM_PREFIX}${key}`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createClaim(fsImpl, claimPath, { token: options.token, hostname: options.hostname, target: key })) return true;
    const judged = readRaw(fsImpl, claimPath);
    if (judged === null || !isOrphanClaim(fsImpl, claimPath, options)) return false;
    const aside = `${claimPath}.${options.token}.gone`;
    try { fsImpl.renameSync(claimPath, aside); } catch { return false; }
    if (readRaw(fsImpl, aside) !== judged) {
      try { fsImpl.linkSync(aside, claimPath); } catch { /* another claim took the path; leave it */ }
      unlinkQuietly(fsImpl, aside);
      return false;
    }
    unlinkQuietly(fsImpl, aside);
  }
  return false;
}

/**
 * Removes the stale instance `found` under its claim.
 * @returns {'cleared'|'aborted'}
 */
function takeOver(fsImpl, stateDir, lockPath, found, options) {
  if (!claimInstance(fsImpl, stateDir, found.key, options)) return 'aborted';
  const claimPath = path.join(stateDir, `${CLAIM_PREFIX}${found.key}`);
  try {
    const current = readLockFile(fsImpl, lockPath);
    if (!current || current.key !== found.key) return 'aborted';
    // Judged again under the claim: a holder whose checkpoint renewed the lock since the first
    // judgment is no longer stale, and its lock stays.
    if (!staleReason(current, options)) return 'aborted';
    try { fsImpl.unlinkSync(lockPath); } catch (err) {
      if (err.code !== 'ENOENT') return 'aborted';
    }
    return 'cleared';
  } catch {
    return 'aborted';
  } finally {
    unlinkQuietly(fsImpl, claimPath);
  }
}

/** Removes, innermost first, the directories an acquisition created, stopping at the first non-empty one. */
function removeCreatedDirs(fsImpl, stateDir, firstCreated) {
  if (!firstCreated) return;
  const top = path.resolve(firstCreated);
  for (let dir = stateDir; ; dir = path.dirname(dir)) {
    try { fsImpl.rmdirSync(dir); } catch { return; }
    if (dir === top || path.dirname(dir) === dir) return;
  }
}

/**
 * Takes the run lock for one scope, waiting for a live holder and clearing a stale one.
 * @param {{scopeRoot: string, scope: 'global'|'project', command: string}} target
 * @param {Object} [options]
 * @returns {{lockPath: string, token: string, scopeRoot: string, waitedMs: number,
 *   cleared: Array<{pid: number|null, command: string|null, startedAt: string|null, reason: string}>,
 *   checkpoint: () => void, release: () => void}}
 * @throws {RunLockTimeoutError|RunLockError}
 */
function acquireRunLock({ scopeRoot, scope, command }, {
  waitMs = 60_000, pollMs = 250, staleMs = 600_000, claimStaleMs = 30_000,
  now = Date.now, isAlive = defaultIsAlive, hostname = os.hostname(),
  log = (line) => process.stderr.write(`${line}\n`), fsImpl = fs, sleep = atomicsSleep,
} = {}) {
  const root = path.resolve(scopeRoot);
  const existing = held.get(root);
  if (existing) {
    existing.count += 1;
    return existing.handle;
  }

  const lockPath = runLockPath(root);
  const stateDir = path.dirname(lockPath);
  const token = crypto.randomBytes(16).toString('hex');
  const where = { scope, scopeRoot: root, lockPath };
  const fail = (code) => new RunLockError({ ...where, code });

  const tempPath = path.join(stateDir, `.${LOCK_FILE}.${token}.tmp`);
  const record = {
    version: RECORD_VERSION, token, pid: process.pid, hostname, command, scope, scopeRoot: root,
    startedAt: new Date(now()).toISOString(), doflowVersion: DOFLOW_VERSION,
  };
  // A first-ever run that gives up removes the state directory it created. Doing so between this
  // run's mkdir and its temp write surfaces here as ENOENT, so both steps are tried once more.
  let firstCreated;
  for (let attempt = 0; ; attempt += 1) {
    try { firstCreated = fsImpl.mkdirSync(stateDir, { recursive: true }); } catch (err) { throw fail(err.code); }
    try {
      fsImpl.writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code === 'ENOENT' && attempt === 0) continue;
      unlinkQuietly(fsImpl, tempPath);
      removeCreatedDirs(fsImpl, stateDir, firstCreated);
      throw fail(err.code);
    }
  }
  const giveUp = (error) => {
    unlinkQuietly(fsImpl, tempPath);
    removeCreatedDirs(fsImpl, stateDir, firstCreated);
    return error;
  };

  const judge = { token, hostname, isAlive, now, staleMs, claimStaleMs };
  const start = now();
  const cleared = [];
  let lastHolder = null;
  let announced = false;
  while (now() - start < waitMs) {
    try {
      fsImpl.linkSync(tempPath, lockPath);
    } catch (err) {
      if (err.code !== 'EEXIST') throw giveUp(fail(err.code));
      let found;
      try { found = readLockFile(fsImpl, lockPath); } catch (readErr) { throw giveUp(fail(readErr.code)); }
      if (!found) continue;
      lastHolder = found.record;
      const reason = staleReason(found, judge);
      if (reason && takeOver(fsImpl, stateDir, lockPath, found, judge) === 'cleared') {
        const holder = found.record;
        cleared.push({ pid: holder?.pid ?? null, command: holder?.command ?? null, startedAt: holder?.startedAt ?? null, reason });
        log(formatRunLockMessage('cleared', { ...where, holder, reason }));
        continue;
      }
      if (!announced) {
        announced = true;
        log(formatRunLockMessage('waiting', { ...where, holder: found.record, waitMs }));
      }
      sleep(pollMs);
      continue;
    }
    unlinkQuietly(fsImpl, tempPath);
    return holdHandle({ fsImpl, root, stateDir, lockPath, token, hostname, firstCreated, where, now, waitedMs: now() - start, cleared });
  }
  throw giveUp(new RunLockTimeoutError({ ...where, holder: lastHolder, waitedMs: now() - start }));
}

function holdHandle({ fsImpl, root, stateDir, lockPath, token, hostname, firstCreated, where, now, waitedMs, cleared }) {
  const entry = { count: 1, handle: null };
  let released = false;

  const releaseNow = () => {
    if (released) return;
    released = true;
    held.delete(root);
    process.removeListener('exit', releaseNow);
    const claimPath = path.join(stateDir, `${CLAIM_PREFIX}${token}`);
    let claimed = false;
    try { claimed = createClaim(fsImpl, claimPath, { token, hostname, target: token }); } catch { /* swallowed: the stale rule clears it */ }
    if (claimed) {
      try {
        const found = readLockFile(fsImpl, lockPath);
        if (found && found.key === token) fsImpl.unlinkSync(lockPath);
      } catch { /* swallowed */ }
      unlinkQuietly(fsImpl, claimPath);
    }
    removeCreatedDirs(fsImpl, stateDir, firstCreated);
  };

  entry.handle = {
    lockPath,
    token,
    scopeRoot: root,
    waitedMs,
    cleared,
    // Under the same claim a takeover of this lock takes, so a renewal and a removal never
    // interleave: a claim already there means another run is removing this lock.
    checkpoint() {
      const claimPath = path.join(stateDir, `${CLAIM_PREFIX}${token}`);
      let claimed = false;
      try { claimed = createClaim(fsImpl, claimPath, { token, hostname, target: token }); } catch { /* no state directory: the lock is gone */ }
      if (!claimed) throw new RunLockLostError(where);
      try {
        let found = null;
        try { found = readLockFile(fsImpl, lockPath); } catch { /* unreadable counts as lost */ }
        if (!found || found.key !== token) throw new RunLockLostError(where);
        const seconds = now() / 1000;
        try { fsImpl.utimesSync(lockPath, seconds, seconds); } catch { /* renewal is best effort */ }
      } finally {
        unlinkQuietly(fsImpl, claimPath);
      }
    },
    release() {
      if (released) return;
      entry.count -= 1;
      if (entry.count > 0) return;
      releaseNow();
    },
  };
  held.set(root, entry);
  process.on('exit', releaseNow);
  return entry.handle;
}

module.exports = {
  acquireRunLock, RunLockTimeoutError, RunLockError, RunLockLostError, runLockPath, formatRunLockMessage,
};
