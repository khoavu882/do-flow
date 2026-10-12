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
 * With `DOFLOW_RETENTION_HOURS` set, or unset while the project's `prune` setting is on, it then
 * deletes the event files of settled items older than the effective retention window (retention.js
 * decides which). The files to delete are first listed in the retention journal, so every reader hides them from that moment, then unlinked; a pass that stops
 * part way leaves them hidden, and the next verb finishes the removal before anything else.
 *
 * Nothing is locked or created unless there is work to do, so a read in a project with no store
 * leaves the project as it was.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { acquireLock, tryAcquireLock } = require('../task-state.ts');
const {
  EVENTS_REL, LIFECYCLE_REL, JOURNAL_REL, lockTarget, isEventName, randomChars, readEvents, readJournal, StoreUnsafeError,
} = require('./event-store.ts');
const { retentionWindow, selectExpired } = require('./retention.ts');

const LEGACY_LIFECYCLE_REL = path.join('agent-docs', 'lifecycle');
const LEGACY_EVENTS_REL = path.join(LEGACY_LIFECYCLE_REL, 'events');
/** Written once the store is in place at the new location; its presence alone is what counts. */
const MARKER_REL = path.join(LIFECYCLE_REL, 'migrated.json');
const MIGRATING_PREFIX = 'events.migrating-';
const NOTICE = 'note: the lifecycle store is now .doflow/state/lifecycle/events; agent-docs/lifecycle/ is no longer read and can be deleted';
const removedLine = (count, hours) => `retention: removed ${count} event files older than ${hours} h`;
const invalidLine = (raw) => `warning: DOFLOW_RETENTION_HOURS='${raw}' is not a positive whole number of hours; ignored, nothing removed`;
/** Bounds one pass, so its journal stays far below the reader's cap and its lock is held briefly. */
const MAX_PASS_FILES = 20000;
/** Unlinks between two refreshes of the lock's age. */
const REFRESH_EVERY = 500;
const unwritableLine = (code) => `warning: retention skipped: .doflow/state/lifecycle cannot be written (${code}); nothing was hidden or removed`;
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

/** Writes the retention journal, flushed to disk, with a new generation. */
function writeJournal(fsImpl, root, pending) {
  writeAtomic(fsImpl, path.join(root, JOURNAL_REL), `${JSON.stringify({ v: 1, generation: randomChars(16), pending })}\n`);
}

/**
 * Keeps the held store lock from looking stale: another verb breaks a lock whose folder is older
 * than the lock's stale timeout, so a long pass renews its folder's time as it goes.
 */
function refreshLock(fsImpl, root) {
  const now = new Date();
  try { fsImpl.utimesSync(`${lockTarget(root)}.lock`, now, now); } catch { /* the lock folder is ours; a failed touch only shortens its life */ }
}

/** Unlinks pending event files without clearing the journal until every hidden name is finished. */
function removePending(fsImpl, root, names, onRemoved = () => {}, { maxFiles = Infinity, shouldStop } = {}) {
  const dir = path.join(root, EVENTS_REL);
  let removed = 0;
  for (let index = 0; index < names.length; index += 1) {
    if (shouldStop?.()) return { complete: false, removed };
    const file = path.join(dir, names[index]);
    if (removed >= maxFiles) {
      try { fsImpl.lstatSync(file); return { complete: false, removed }; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; continue; }
    }
    if (index % REFRESH_EVERY === 0) refreshLock(fsImpl, root);
    try {
      fsImpl.unlinkSync(file);
      removed += 1;
      onRemoved();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  writeJournal(fsImpl, root, []);
  return { complete: true, removed };
}

/** Selects whole units only; a unit that does not fit waits for the next pass. */
function passFiles(units, { maxFiles = MAX_PASS_FILES, shouldStop } = {}) {
  const files = [], limit = Math.max(0, Math.min(MAX_PASS_FILES, Number.isFinite(maxFiles) ? maxFiles : MAX_PASS_FILES));
  let partial = false;
  for (const unit of units) {
    if (shouldStop?.()) { partial = true; break; }
    if (files.length + unit.files.length > limit) { partial = true; break; }
    files.push(...unit.files);
  }
  return { files: files.sort(), partial };
}

/**
 * The retention pass, under the store lock: finish a pending journal within the caller's remaining
 * limits, then remove whole eligible units. A stopped deletion keeps the complete name set hidden.
 */
function retain(fsImpl, root, window, now, { maxFiles = MAX_PASS_FILES, shouldStop } = {}) {
  let removedCount = 0;
  const selected = [];
  try {
    if (shouldStop?.()) return { removed: [], removedCount, warning: [], partial: true, selected };
    const pending = readJournal(root, fsImpl).pending;
    if (shouldStop?.()) return { removed: [], removedCount, warning: [], partial: true, selected };
    if (pending.length) {
      const result = removePending(fsImpl, root, pending, () => { removedCount += 1; }, { maxFiles, shouldStop });
      if (!result.complete) return { removed: [], removedCount, warning: [], partial: true, selected };
    }
    const remaining = Math.max(0, maxFiles - removedCount);
    if (window.state !== 'on') return { removed: [], removedCount, warning: [], partial: false, selected };
    if (shouldStop?.()) return { removed: [], removedCount, warning: [], partial: true, selected };
    const snapshot = readEvents(root, { fsImpl, lockFallback: false, shouldStop });
    if (snapshot.incomplete) return { removed: [], removedCount, warning: [], partial: true, selected };
    if (snapshot.unreadable.length) throw Object.assign(new Error('unreadable lifecycle events'), { code: 'EIO' });
    refreshLock(fsImpl, root);
    const selection = selectExpired(snapshot.events, { now, windowMs: window.ms, shouldStop });
    if (selection.incomplete) return { removed: [], removedCount, warning: [], partial: true, selected };
    const bounded = passFiles(selection.units, { maxFiles: remaining, shouldStop });
    if (shouldStop?.()) return { removed: [], removedCount, warning: [], partial: true, selected };
    for (const name of bounded.files) {
      if (shouldStop?.()) return { removed: [], removedCount, warning: [], partial: true, selected };
      const file = path.join(root, EVENTS_REL, name);
      let info;
      try { info = fsImpl.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      selected.push({ name, bytes: info?.isFile() ? info.size : 0 });
    }
    refreshLock(fsImpl, root);
    if (bounded.files.length === 0) return { removed: [], removedCount, warning: [], partial: bounded.partial, selected };
    writeJournal(fsImpl, root, bounded.files);
    const result = removePending(fsImpl, root, bounded.files, () => { removedCount += 1; }, { maxFiles: remaining, shouldStop });
    return {
      removed: window.source === 'default' ? [] : [removedLine(bounded.files.length, window.hours)],
      removedCount, warning: [], partial: bounded.partial || !result.complete, selected,
    };
  } catch (error) {
    // A failure is not a stopped pass: `partial` means only a stop, a held lock or the removal cap,
    // so throttled upkeep advances its due time instead of retrying a failing pass on every verb.
    return { removed: [], removedCount, warning: [unlinkLine(error.code || error.message)], partial: false, selected, code: error.code || 'EIO' };
  }
}

/** Runs a bounded lifecycle retention pass under a non-waiting store lock for the storage engine. */
function retainLocked(root, options = {}) {
  const { window, now = new Date(), fsImpl = nodeFs, maxFiles = MAX_PASS_FILES, shouldStop } = options;
  const bounded = Object.hasOwn(options, 'maxFiles') || Object.hasOwn(options, 'shouldStop');
  const outcome = (removed, warning, partial = false, selected = [], code) => bounded
    ? { removed, warning, partial, selected, ...(code ? { code } : {}) }
    : { removed, warning };
  const eventsDir = path.join(root, EVENTS_REL);
  const st = lstatOrNull(fsImpl, eventsDir);
  if (!st || !st.isDirectory()) return outcome(0, []);
  if (shouldStop?.()) return outcome(0, [], true);
  const release = tryAcquireLock(fsImpl, lockTarget(root));
  if (!release) return outcome(0, [], true);
  try {
    const result = retain(fsImpl, root, window, now, { maxFiles, shouldStop });
    return outcome(result.removedCount, result.warning, result.partial, result.selected, result.code);
  } finally {
    release();
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
function prepareStore(root, { env = process.env, now = new Date(), fsImpl = nodeFs, registry } = {}) {
  refuseLinks(fsImpl, root, [LIFECYCLE_REL, EVENTS_REL]);
  const legacyDir = lstatOrNull(fsImpl, path.join(root, LEGACY_EVENTS_REL));
  const notice = legacyDir && legacyDir.isDirectory() ? [NOTICE] : [];
  const window = retentionWindow({ env, projectRoot: root, registry, fsImpl });
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
    if (!migrate) return { ok: true, lines: [...notice, ...invalid, ...(retentionDue ? [unwritableLine(error.code || error.message)] : [])] };
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

module.exports = { prepareStore, retainLocked, LEGACY_LIFECYCLE_REL, LEGACY_EVENTS_REL, MARKER_REL };
