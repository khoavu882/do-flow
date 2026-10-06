'use strict';

/**
 * Store upkeep, run once by each lifecycle verb before its own work. A project whose store still
 * lives at `agent-docs/lifecycle/events/` has it copied once into `.doflow/state/lifecycle/events/`
 * by the first verb that runs: the files go into a temp folder beside the new store, and one
 * rename of that folder onto `events` commits the copy, so readers see no store or the whole
 * store. The old folder is only read, never written, and while it exists every verb prints one
 * line saying it is no longer read.
 *
 * Nothing is locked or created unless there is work to do, so a read in a project with no store
 * leaves the project as it was.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { acquireLock } = require('../task-state');
const { EVENTS_REL, LIFECYCLE_REL, lockTarget, isEventName, randomChars, StoreUnsafeError } = require('./event-store');

const LEGACY_LIFECYCLE_REL = path.join('agent-docs', 'lifecycle');
const LEGACY_EVENTS_REL = path.join(LEGACY_LIFECYCLE_REL, 'events');
const MIGRATING_PREFIX = 'events.migrating-';
const NOTICE = 'note: the lifecycle store is now .doflow/state/lifecycle/events; agent-docs/lifecycle/ is no longer read and can be deleted';

function lstatOrNull(fsImpl, file) {
  try { return fsImpl.lstatSync(file); } catch { return null; }
}

/** The names in a folder, or none when it is absent or not a folder. */
function namesIn(fsImpl, dir) {
  try {
    return fsImpl.readdirSync(dir).sort();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function refuseLinks(fsImpl, root, rels) {
  for (const rel of rels) {
    const folder = path.join(root, rel);
    const st = lstatOrNull(fsImpl, folder);
    if (st && st.isSymbolicLink()) throw new StoreUnsafeError(`${folder} is a symbolic link; the lifecycle store is never read or written through one`);
  }
}

/** The event files of the old folder that a copy takes: event-named regular files, nothing else. */
function legacyEventFiles(fsImpl, root) {
  const dir = path.join(root, LEGACY_EVENTS_REL);
  const st = lstatOrNull(fsImpl, dir);
  if (!st || !st.isDirectory()) return [];
  return namesIn(fsImpl, dir).filter((name) => {
    if (!isEventName(name)) return false;
    const entry = lstatOrNull(fsImpl, path.join(dir, name));
    return Boolean(entry && entry.isFile());
  });
}

/** The old folder holds events and the new store holds no event-named entry. */
function needsCopy(fsImpl, root) {
  return legacyEventFiles(fsImpl, root).length > 0 && !namesIn(fsImpl, path.join(root, EVENTS_REL)).some(isEventName);
}

function removeQuietly(fsImpl, target) {
  try { fsImpl.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Flushes one copied file; opened read-write because Windows refuses to flush a read-only handle. */
function fsyncFile(fsImpl, file) {
  const fd = fsImpl.openSync(file, 'r+');
  try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
}

/** Flushes a folder's entries where the platform lets a folder be opened. */
function fsyncFolder(fsImpl, dir) {
  let fd;
  try { fd = fsImpl.openSync(dir, 'r'); } catch { return; }
  try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
}

const migrationFailed = (code) => ({
  ok: false,
  finding: 'store-migration-failed',
  message: `could not copy agent-docs/lifecycle/events to .doflow/state/lifecycle/events (${code}); the old folder is unchanged and the next lifecycle command retries. Nothing was written.`,
  lines: [],
});

/**
 * The copy itself, under the store lock. Returns null when the store is in place, or the
 * `store-migration-failed` refusal.
 */
function copyLegacyStore(fsImpl, root) {
  if (!needsCopy(fsImpl, root)) return null; // another verb finished the copy while this one waited
  const lifecycleDir = path.join(root, LIFECYCLE_REL);
  const eventsDir = path.join(root, EVENTS_REL);
  const legacyDir = path.join(root, LEGACY_EVENTS_REL);
  let tmp = null;
  try {
    // Under the lock no temp folder belongs to a live copier.
    for (const name of namesIn(fsImpl, lifecycleDir)) {
      if (name.startsWith(MIGRATING_PREFIX)) fsImpl.rmSync(path.join(lifecycleDir, name), { recursive: true, force: true });
    }
    tmp = path.join(lifecycleDir, `${MIGRATING_PREFIX}${process.pid}-${randomChars(6)}`);
    fsImpl.mkdirSync(tmp);
    for (const name of legacyEventFiles(fsImpl, root)) {
      const copy = path.join(tmp, name);
      fsImpl.copyFileSync(path.join(legacyDir, name), copy, nodeFs.constants.COPYFILE_EXCL);
      fsyncFile(fsImpl, copy);
    }
    fsyncFolder(fsImpl, tmp);
    if (lstatOrNull(fsImpl, eventsDir)) {
      // An `events` here holds no event file; one that holds anything else is kept for its owner.
      const replaced = path.join(lifecycleDir, `events.replaced-${randomChars(6)}`);
      fsImpl.renameSync(eventsDir, replaced);
      try { fsImpl.rmdirSync(replaced); } catch { /* not empty: left in place */ }
    }
    try {
      fsImpl.renameSync(tmp, eventsDir);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      removeQuietly(fsImpl, tmp); // another copier committed first
    }
    return null;
  } catch (error) {
    if (tmp) removeQuietly(fsImpl, tmp);
    return migrationFailed(error.code || error.message);
  }
}

/**
 * Prepares the project store for one verb invocation.
 * @param {string} root projectRoot() result
 * @param {{fsImpl?: Object}} [options]
 * @returns {{ok: true, lines: string[]}
 *   | {ok: false, finding: 'store-migration-failed'|'store-locked', message: string, lines: string[]}}
 *   `lines` are for stderr, without the verb prefix.
 * @throws {StoreUnsafeError} a symlinked new store folder, or a symlinked old folder when a copy must read it
 */
function prepareStore(root, { fsImpl = nodeFs } = {}) {
  refuseLinks(fsImpl, root, [LIFECYCLE_REL, EVENTS_REL]);
  const legacyDir = lstatOrNull(fsImpl, path.join(root, LEGACY_EVENTS_REL));
  const lines = legacyDir && legacyDir.isDirectory() ? [NOTICE] : [];
  if (!needsCopy(fsImpl, root)) return { ok: true, lines };
  refuseLinks(fsImpl, root, [LEGACY_LIFECYCLE_REL, LEGACY_EVENTS_REL]);

  const lifecycleDir = path.join(root, LIFECYCLE_REL);
  try {
    fsImpl.mkdirSync(lifecycleDir, { recursive: true });
    // An unwritable folder would only show as a lock that never comes; name it for what it is.
    fsImpl.accessSync(lifecycleDir, nodeFs.constants.W_OK);
  } catch (error) {
    return migrationFailed(error.code || error.message);
  }
  let release;
  try {
    release = acquireLock(fsImpl, lockTarget(root));
  } catch (error) {
    if (/^Could not lock/.test(error.message || '')) return { ok: false, finding: 'store-locked', message: `${error.message} Nothing was written.`, lines: [] };
    throw error;
  }
  try {
    const failed = copyLegacyStore(fsImpl, root);
    return failed || { ok: true, lines };
  } finally {
    release();
  }
}

module.exports = { prepareStore, LEGACY_LIFECYCLE_REL, LEGACY_EVENTS_REL };
