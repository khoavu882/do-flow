'use strict';

/**
 * Store upkeep, run once by each lifecycle verb before its own work. A project whose store still
 * lives at `agent-docs/lifecycle/events/` has it copied once into `.doflow/state/lifecycle/events/`
 * by the first verb that runs: the files go into a temp folder beside the new store, and one
 * rename of that folder onto `events` commits the copy, so readers see no store or the whole
 * store. The copy then writes a completion marker beside the store; once the marker exists the old
 * folder is never listed or read again, so a store that retention later empties is not filled from
 * it a second time. A store that already holds event files without a marker (one this project
 * started at the new location) gets the marker and no copy. The old folder is only read, never
 * written, and while it exists every verb prints one line saying it is no longer read.
 *
 * With `DOFLOW_RETENTION_HOURS` set, it then deletes the event files of settled items older than
 * that many hours (retention.js decides which). The files to delete are first listed in the
 * retention journal, so every reader hides them from that moment, then unlinked; a pass that stops
 * part way leaves them hidden, and the next verb finishes the removal before anything else.
 *
 * Nothing is locked or created unless there is work to do, so a read in a project with no store
 * leaves the project as it was.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { acquireLock } = require('../task-state');
const {
  EVENTS_REL, LIFECYCLE_REL, JOURNAL_REL, lockTarget, isEventName, randomChars, readEvents, readJournal, StoreUnsafeError,
} = require('./event-store');
const { parseWindow, selectExpired } = require('./retention');

const LEGACY_LIFECYCLE_REL = path.join('agent-docs', 'lifecycle');
const LEGACY_EVENTS_REL = path.join(LEGACY_LIFECYCLE_REL, 'events');
/** Written once the store is in place at the new location; its presence alone is what counts. */
const MARKER_REL = path.join(LIFECYCLE_REL, 'migrated.json');
const MIGRATING_PREFIX = 'events.migrating-';
const NOTICE = 'note: the lifecycle store is now .doflow/state/lifecycle/events; agent-docs/lifecycle/ is no longer read and can be deleted';
const removedLine = (count, hours) => `retention: removed ${count} event files older than ${hours} h`;
const invalidLine = (raw) => `warning: DOFLOW_RETENTION_HOURS='${raw}' is not a positive whole number of hours; ignored, nothing removed`;
const unlinkLine = (code) => `warning: retention could not remove every file (${code}); they stay hidden and the next lifecycle command finishes the removal`;

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

const hasMarker = (fsImpl, root) => lstatOrNull(fsImpl, path.join(root, MARKER_REL)) !== null;
const storeHasEvents = (fsImpl, root) => namesIn(fsImpl, path.join(root, EVENTS_REL)).some(isEventName);

function removeQuietly(fsImpl, target) {
  try { fsImpl.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Flushes one copied file. The copy takes the source's mode, so it is made writable by its owner
 * first, like any file the store writes: Windows refuses to flush a read-only handle.
 */
function fsyncCopy(fsImpl, file) {
  fsImpl.chmodSync(file, 0o644);
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
const legacyUnreadable = (code) => ({
  ok: false,
  finding: 'store-migration-failed',
  message: `could not list agent-docs/lifecycle/events (${code}), so the old store cannot be copied to .doflow/state/lifecycle/events; make the folder readable, or delete it if its events are not needed, and the next lifecycle command retries. Nothing was written.`,
  lines: [],
});

/** Writes `text` to `file` by a flushed temp file in the same folder and a rename. */
function writeAtomic(fsImpl, file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file, '.json')}-${process.pid}-${randomChars(6)}.tmp`);
  try {
    const fd = fsImpl.openSync(tmp, 'wx', 0o644);
    try {
      fsImpl.writeFileSync(fd, text, 'utf8');
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    fsImpl.renameSync(tmp, file);
  } catch (error) {
    try { fsImpl.unlinkSync(tmp); } catch { /* never written */ }
    throw error;
  }
  fsyncFolder(fsImpl, dir);
}

/** Records that the store is in place; false when it cannot be written, so a later verb tries again. */
function writeMarker(fsImpl, root, copied, now) {
  try {
    writeAtomic(fsImpl, path.join(root, MARKER_REL), `${JSON.stringify({ v: 1, from: 'agent-docs/lifecycle/events', copied, at: now.toISOString() })}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The copy itself, under the store lock, of the event files the caller listed. Returns the number
 * copied, or the `store-migration-failed` refusal.
 */
function copyLegacyStore(fsImpl, root, files) {
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
    for (const name of files) {
      const copy = path.join(tmp, name);
      fsImpl.copyFileSync(path.join(legacyDir, name), copy, nodeFs.constants.COPYFILE_EXCL);
      fsyncCopy(fsImpl, copy);
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
    fsyncFolder(fsImpl, lifecycleDir);
    return files.length;
  } catch (error) {
    if (tmp) removeQuietly(fsImpl, tmp);
    return migrationFailed(error.code || error.message);
  }
}

/** The UTC time an event file name's id starts with. */
function idTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : NaN;
}

/** Writes the retention journal by temp file and rename, with a new generation. */
function writeJournal(fsImpl, root, pending) {
  const file = path.join(root, JOURNAL_REL);
  const tmp = path.join(root, LIFECYCLE_REL, `.retention-${process.pid}-${randomChars(6)}.tmp`);
  try {
    fsImpl.writeFileSync(tmp, `${JSON.stringify({ v: 1, generation: randomChars(16), pending })}\n`, { encoding: 'utf8', flag: 'wx' });
    fsImpl.renameSync(tmp, file);
  } catch (error) {
    try { fsImpl.unlinkSync(tmp); } catch { /* never written */ }
    throw error;
  }
}

/** Unlinks the named event files, ignoring one already gone, then empties the journal. */
function removePending(fsImpl, root, names) {
  const dir = path.join(root, EVENTS_REL);
  for (const name of names) {
    try { fsImpl.unlinkSync(path.join(dir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  writeJournal(fsImpl, root, []);
}

/**
 * The retention pass, under the store lock: finish a pass that stopped part way, then remove what
 * is eligible now. A removal that fails leaves its files listed in the journal, and so hidden, and
 * gives the warning line instead of the count line.
 * @returns {{removed: string[], warning: string[]}}
 */
function retain(fsImpl, root, window, now) {
  try {
    const pending = readJournal(root, fsImpl).pending;
    if (pending.length) removePending(fsImpl, root, pending);
    if (window.state !== 'on') return { removed: [], warning: [] };
    const { files } = selectExpired(readEvents(root, { fsImpl }).events, { now, windowMs: window.ms });
    if (files.length === 0) return { removed: [], warning: [] };
    writeJournal(fsImpl, root, files);
    removePending(fsImpl, root, files);
    return { removed: [removedLine(files.length, window.hours)], warning: [] };
  } catch (error) {
    return { removed: [], warning: [unlinkLine(error.code || error.message)] };
  }
}

/** Whether a lock-free look finds anything for the retention pass to remove. */
function needsPrune(fsImpl, root, window, now) {
  if (window.state !== 'on') return false;
  const cutoff = now.getTime() - window.ms;
  if (!namesIn(fsImpl, path.join(root, EVENTS_REL)).some((name) => isEventName(name) && idTime(name) < cutoff)) return false;
  return selectExpired(readEvents(root, { fsImpl }).events, { now, windowMs: window.ms }).files.length > 0;
}

/**
 * Prepares the project store for one verb invocation.
 * @param {string} root projectRoot() result
 * @param {{env?: Object, now?: Date, fsImpl?: Object}} [options] defaults process.env, new Date(), node:fs
 * @returns {{ok: true, lines: string[]}
 *   | {ok: false, finding: 'store-migration-failed'|'store-locked', message: string, lines: string[]}}
 *   `lines` are for stderr, without the verb prefix.
 * @throws {StoreUnsafeError} a symlinked new store folder, or a symlinked old folder when a copy must read it
 */
function prepareStore(root, { env = process.env, now = new Date(), fsImpl = nodeFs } = {}) {
  refuseLinks(fsImpl, root, [LIFECYCLE_REL, EVENTS_REL]);
  const legacyDir = lstatOrNull(fsImpl, path.join(root, LEGACY_EVENTS_REL));
  const notice = legacyDir && legacyDir.isDirectory() ? [NOTICE] : [];
  const window = parseWindow(env);
  const invalid = window.state === 'invalid' ? [invalidLine(window.raw)] : [];
  let migrate = false;
  let markerDue = false;
  if (!hasMarker(fsImpl, root)) {
    if (storeHasEvents(fsImpl, root)) {
      markerDue = true;
    } else {
      try { migrate = legacyEventFiles(fsImpl, root).length > 0; } catch (error) { return legacyUnreadable(error.code || error.message); }
    }
  }
  const retentionDue = readJournal(root, fsImpl).pending.length > 0 || needsPrune(fsImpl, root, window, now);
  if (!migrate && !markerDue && !retentionDue) return { ok: true, lines: [...notice, ...invalid] };
  if (migrate) refuseLinks(fsImpl, root, [LEGACY_LIFECYCLE_REL, LEGACY_EVENTS_REL]);

  const lifecycleDir = path.join(root, LIFECYCLE_REL);
  try {
    fsImpl.mkdirSync(lifecycleDir, { recursive: true });
    // An unwritable folder would only show as a lock that never comes; name it for what it is.
    fsImpl.accessSync(lifecycleDir, nodeFs.constants.W_OK);
  } catch (error) {
    // Without a copy to make, an unwritable store only stops the retention pass, not the verb.
    if (!migrate) return { ok: true, lines: [...notice, ...invalid, ...(retentionDue ? [unlinkLine(error.code || error.message)] : [])] };
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
    // Decided again under the lock: another verb may have finished the copy while this one waited.
    let marked = hasMarker(fsImpl, root);
    if (!marked && storeHasEvents(fsImpl, root)) {
      marked = writeMarker(fsImpl, root, 0, now);
    } else if (!marked) {
      let files;
      try { files = legacyEventFiles(fsImpl, root); } catch (error) { return legacyUnreadable(error.code || error.message); }
      if (files.length) {
        refuseLinks(fsImpl, root, [LEGACY_LIFECYCLE_REL, LEGACY_EVENTS_REL]);
        const copied = copyLegacyStore(fsImpl, root, files);
        if (typeof copied !== 'number') return copied;
        marked = writeMarker(fsImpl, root, copied, now);
      }
    }
    // Retention runs only on a marked store, so emptying it can never bring the old folder back.
    if (!marked) return { ok: true, lines: [...notice, ...invalid] };
    const { removed, warning } = retain(fsImpl, root, window, now);
    return { ok: true, lines: [...notice, ...removed, ...invalid, ...warning] };
  } finally {
    release();
  }
}

module.exports = { prepareStore, LEGACY_LIFECYCLE_REL, LEGACY_EVENTS_REL, MARKER_REL };
