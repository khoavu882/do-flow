'use strict';

/**
 * The project lifecycle event store (IC-001, IC-002, IC-003). One JSON file per event under
 * `<root>/.doflow/state/lifecycle/events/`, created with an exclusive create and never edited or
 * renamed. The store is local to a checkout, not shared through git. DoFlow never runs `git add`,
 * `git commit` or `git push` on these paths and never writes an ignore rule for them (DEC-012).
 *
 * A write holds the store lock, folds what is there, refuses an event that would be illegal at the
 * end of that fold (`illegal-transition`, nothing written) and stamps `at` as the later of the
 * clock and one millisecond past the newest `at` it has seen, so a later event on one clone never
 * sorts before one it has read.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireLock } = require('../task-state');
const { printSafe } = require('../mask');
const { foldInto, finalize, applyEvent } = require('./fold');

const LIFECYCLE_REL = path.join('.doflow', 'state', 'lifecycle');
const EVENTS_REL = path.join(LIFECYCLE_REL, 'events');
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** `<UTC YYYYMMDDTHHMMSSmmmZ>-<6 lowercase Crockford base32 characters>`. */
const EVENT_ID = /^[0-9]{8}T[0-9]{9}Z-[0-9a-hjkmnp-tv-z]{6}$/;
const COLLISION_RETRIES = 5;
/** The largest legitimate event is a goal with 100 items of 280 characters (about 30 KiB); a file over this is not one. */
const MAX_EVENT_BYTES = 256 * 1024;
/** The decision register's channel vocabulary: who the caller says is acting. */
const CHANNEL_BY = { question: 'user', gate: 'user', prompt: 'user', default: 'agent' };

function eventsDir(root) { return path.join(root, EVENTS_REL); }
function lockTarget(root) { return path.join(root, EVENTS_REL); }

/** @param {string} [channel] defaults to `default` @returns {'user'|'agent'|null} null for an unknown channel */
function byFromChannel(channel = 'default') { return CHANNEL_BY[channel] ?? null; }

/** `length` random characters of the lowercase Crockford base32 alphabet. */
function randomChars(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

function idFor(at, random) { return `${at.replace(/[-:.]/g, '')}-${random(6)}`; }

/** DEC-045: `at` is a strict UTC timestamp that is a real instant, so year 10000 and "+275760-..." never parse. */
const STRICT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isStrictAt(at) {
  if (typeof at !== 'string' || !STRICT_AT.test(at)) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && new Date(ms).toISOString() === at;
}

/** An IC-002 envelope whose `at` is strict and equals the time prefix of its file id. */
function isEnvelope(event, idFromName) {
  return event && typeof event === 'object' && event.v === 1 && event.id === idFromName
    && typeof event.type === 'string' && typeof event.by === 'string'
    && isStrictAt(event.at) && idFromName.startsWith(`${event.at.replace(/[-:.]/g, '')}-`)
    && event.data && typeof event.data === 'object' && !Array.isArray(event.data);
}

/** The store folders are the project's own: a symlink at either one could send a read or a write outside the repository. */
class StoreUnsafeError extends Error {}

function assertStoreFolders(root, fsImpl) {
  for (const rel of [LIFECYCLE_REL, EVENTS_REL]) {
    const folder = path.join(root, rel);
    let link = false;
    try { link = fsImpl.lstatSync(folder).isSymbolicLink(); } catch { /* absent: nothing to follow */ }
    if (link) throw new StoreUnsafeError(`${folder} is a symbolic link; the lifecycle store is never read or written through one`);
  }
}

/**
 * One event file's text, or `{reason}` when it must not be read: not a regular file (a symlink, a
 * FIFO, a device, a folder), larger than MAX_EVENT_BYTES, or gone. A symlink is refused by `lstat`
 * and again by `O_NOFOLLOW` where the platform has it; `O_NONBLOCK` keeps a FIFO swapped in after
 * the `lstat` from blocking the open, and the descriptor is checked again before any read.
 */
function readEventFile(fsImpl, file) {
  const flags = nodeFs.constants;
  let fd;
  try {
    if (!fsImpl.lstatSync(file).isFile()) return { reason: 'not a regular file' };
    fd = fsImpl.openSync(file, flags.O_RDONLY | (flags.O_NOFOLLOW || 0) | (flags.O_NONBLOCK || 0));
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) return { reason: 'not a regular file' };
    if (st.size > MAX_EVENT_BYTES) return { reason: `larger than ${MAX_EVENT_BYTES / 1024} KiB` };
    const buffer = Buffer.allocUnsafe(MAX_EVENT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fsImpl.readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    return length > MAX_EVENT_BYTES ? { reason: `larger than ${MAX_EVENT_BYTES / 1024} KiB` } : { text: buffer.toString('utf8', 0, length) };
  } catch (error) {
    return { reason: error.code || 'unreadable' };
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* read already done */ } }
  }
}

/** The event with every string print-safe; a report excerpt is multi-line by design, so it keeps its line breaks (cli.js removes them when printing). */
function cleanEvent(event) {
  const clean = printSafe(event);
  if (typeof event.data.excerpt === 'string') clean.data.excerpt = printSafe(event.data.excerpt, { keepLineBreaks: true });
  return clean;
}

/**
 * Reads every event file. A missing folder is an empty store; a file whose name is not an event id
 * is ignored; a matching entry that is not a regular file of at most MAX_EVENT_BYTES, or is not an
 * IC-002 envelope (including one still being written), is skipped and named in `unreadable`, with
 * the reason in `reasons[name]` when it is not simply a corrupt file. A symlinked store folder
 * throws StoreUnsafeError.
 * @returns {{events: Object[], unreadable: string[], reasons: Object<string,string>}}
 */
function readEvents(root, { fsImpl = nodeFs } = {}) {
  assertStoreFolders(root, fsImpl);
  const dir = eventsDir(root);
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { events: [], unreadable: [], reasons: {} };
    throw error;
  }
  const events = [];
  const unreadable = [];
  const reasons = {};
  for (const name of names.sort()) {
    const match = /^(.+)\.json$/.exec(name);
    if (!match || !EVENT_ID.test(match[1])) continue;
    const read = readEventFile(fsImpl, path.join(dir, name));
    if (read.reason) { unreadable.push(name); reasons[name] = read.reason; continue; }
    try {
      const event = JSON.parse(read.text);
      // Someone else's file is shown as it is read, so its text is made print-safe here (stored bytes are not changed).
      if (isEnvelope(event, match[1])) events.push(cleanEvent(event)); else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { events, unreadable, reasons };
}

/**
 * Reads and folds the store.
 * @param {string} root the IC-001 root
 * @param {{hasBody?: Function, fsImpl?: Object}} [options]
 * @returns {Object} the fold result (see fold.js) plus `unreadable`
 */
function readFold(root, { fsImpl = nodeFs, hasBody, now = new Date() } = {}) {
  const { events, unreadable, reasons } = readEvents(root, { fsImpl });
  return { ...finalize(foldInto(events, { now }), { hasBody }), unreadable, unreadableReasons: reasons };
}

/** Picks a free, valid id for each draft before any file is created, so a batch is all or nothing. */
function allocateIds(fsImpl, dir, stamped, random) {
  const chosen = new Set();
  const ids = [];
  for (const { at, id } of stamped) {
    let candidate = id;
    for (let attempt = 0; attempt <= COLLISION_RETRIES; attempt += 1) {
      if (attempt > 0) candidate = idFor(at, random);
      if (EVENT_ID.test(candidate) && !chosen.has(candidate) && !fsImpl.existsSync(path.join(dir, `${candidate}.json`))) break;
      candidate = null;
    }
    if (!candidate) return null;
    chosen.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

/**
 * Appends events. All are checked against the local fold first; one illegal event refuses the whole
 * call and nothing is written.
 *
 * @param {string} root the IC-001 root
 * @param {Array<{type:string, by:'user'|'agent', data:Object}>} drafts
 * @param {{now?: Date, fsImpl?: Object, random?: (n:number)=>string}} [options]
 * @returns {{ok:true, written: Array<{id:string, file:string, event:Object}>}
 *   | {ok:false, finding:string, message:string, conflict?:Object, written?: Array}}
 *   `file` is root-relative with `/` separators. The findings are `illegal-transition` (any fold
 *   conflict, with its own `code` in `conflict.code`), `id-collision`, `invalid-id` (the clock or
 *   the random source cannot produce an id of the IC-001 shape) and `store-locked`.
 */
function appendEvents(root, drafts, { now = new Date(), fsImpl = nodeFs, random = randomChars } = {}) {
  const dir = eventsDir(root);
  // A write that would be refused leaves nothing behind, not even the store folder (IC-001: created
  // on the first write), so the check runs once before the folder and the lock and again under the lock.
  const early = planEvents(root, drafts, { now, fsImpl, random });
  if (early.refused) return early.refused;
  fsImpl.mkdirSync(dir, { recursive: true });
  let release;
  try {
    release = acquireLock(fsImpl, lockTarget(root));
  } catch (error) {
    if (/^Could not lock/.test(error.message || '')) return { ok: false, finding: 'store-locked', message: `${error.message} Nothing was written.` };
    throw error;
  }
  try {
    const { stamped, refused } = planEvents(root, drafts, { now, fsImpl, random });
    if (refused) return refused;
    const ids = allocateIds(fsImpl, dir, stamped, random);
    if (!ids) return { ok: false, finding: 'id-collision', written: [], message: `could not find a free event id after ${COLLISION_RETRIES} tries. Nothing was written.` };
    const written = [];
    stamped.forEach(({ draft, at }, index) => {
      const event = { v: 1, id: ids[index], type: draft.type, at, by: draft.by, data: draft.data };
      const file = path.join(dir, `${event.id}.json`);
      // The ids are free under the lock; the exclusive create only guards against a writer outside it.
      fsImpl.writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      written.push({ id: event.id, file: path.relative(root, file).split(path.sep).join('/'), event });
    });
    return { ok: true, written };
  } finally {
    release();
  }
}

/** Folds the store, stamps each draft and applies it; `refused` is the whole call's refusal when any is illegal. */
function planEvents(root, drafts, { now, fsImpl, random }) {
  const state = foldInto(readEvents(root, { fsImpl }).events, { now });
  // An event dated far ahead is not in the fold (DEC-045), so it cannot push this stamp forward.
  let floor = state.newestAt === null ? -Infinity : state.newestAt + 1;
  const stamped = [];
  for (const draft of drafts) {
    const atMs = Math.max(now.getTime(), floor);
    floor = atMs + 1;
    let at;
    try { at = new Date(atMs).toISOString(); } catch { at = null; }
    // The dry run draws the id the write will try first, so a conflict names the event it refuses.
    const id = at && isStrictAt(at) ? idFor(at, random) : null;
    if (!id || !EVENT_ID.test(id)) {
      return { refused: { ok: false, finding: 'invalid-id', message: 'cannot build an event id of the form <UTC time>-<6 base32 characters> from the clock and the random source. Nothing was written.' } };
    }
    const raised = applyEvent(state, { v: 1, id, type: draft.type, at, by: draft.by, data: draft.data }, { checkFuture: false });
    if (raised.length) {
      return { refused: { ok: false, finding: 'illegal-transition', conflict: raised[0], message: `${raised[0].reason}. Nothing was written.` } };
    }
    stamped.push({ draft, at, id });
  }
  return { stamped };
}

module.exports = {
  appendEvents, readEvents, readFold, byFromChannel, randomChars, StoreUnsafeError, MAX_EVENT_BYTES,
  EVENT_ID, EVENTS_REL, LIFECYCLE_REL, ALPHABET, COLLISION_RETRIES, lockTarget,
};
