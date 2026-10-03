'use strict';

/**
 * The project lifecycle event store (IC-001, IC-002, IC-003). One JSON file per event under
 * `<root>/agent-docs/lifecycle/events/`, created with an exclusive create and never edited, renamed
 * or deleted, so two clones merge by adding files. DoFlow never runs `git add`, `git commit` or
 * `git push` on these paths and never writes an ignore rule for them (DEC-012).
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
const { foldInto, finalize, applyEvent } = require('./fold');

const LIFECYCLE_REL = path.join('agent-docs', 'lifecycle');
const EVENTS_REL = path.join(LIFECYCLE_REL, 'events');
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** `<UTC YYYYMMDDTHHMMSSmmmZ>-<6 lowercase Crockford base32 characters>`. */
const EVENT_ID = /^[0-9]{8}T[0-9]{9}Z-[0-9a-hjkmnp-tv-z]{6}$/;
const COLLISION_RETRIES = 5;
/** The decision register's channel vocabulary: who the caller says is acting. */
const CHANNEL_BY = { question: 'user', gate: 'user', prompt: 'user', default: 'agent' };

function eventsDir(root) { return path.join(root, EVENTS_REL); }
function lockTarget(root) { return path.join(root, LIFECYCLE_REL, 'events'); }

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

function isEnvelope(event, idFromName) {
  return event && typeof event === 'object' && event.v === 1 && event.id === idFromName
    && typeof event.type === 'string' && typeof event.by === 'string'
    && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))
    && event.data && typeof event.data === 'object' && !Array.isArray(event.data);
}

/**
 * Reads every event file. A missing folder is an empty store; a file whose name is not an event id
 * is ignored; a matching file that is not an IC-002 envelope (including one still being written) is
 * skipped and named in `unreadable`.
 * @returns {{events: Object[], unreadable: string[]}}
 */
function readEvents(root, { fsImpl = nodeFs } = {}) {
  const dir = eventsDir(root);
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { events: [], unreadable: [] };
    throw error;
  }
  const events = [];
  const unreadable = [];
  for (const name of names.sort()) {
    const match = /^(.+)\.json$/.exec(name);
    if (!match || !EVENT_ID.test(match[1])) continue;
    try {
      const event = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8'));
      if (isEnvelope(event, match[1])) events.push(event); else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { events, unreadable };
}

/**
 * Reads and folds the store.
 * @param {string} root the IC-001 root
 * @param {{hasBody?: Function, fsImpl?: Object}} [options]
 * @returns {Object} the fold result (see fold.js) plus `unreadable`
 */
function readFold(root, { fsImpl = nodeFs, hasBody } = {}) {
  const { events, unreadable } = readEvents(root, { fsImpl });
  return { ...finalize(foldInto(events), { hasBody }), unreadable };
}

/** One try with `firstId`, then up to COLLISION_RETRIES more with fresh random characters. */
function createExclusive(fsImpl, dir, build, firstId, random) {
  for (let attempt = 0; attempt <= COLLISION_RETRIES; attempt += 1) {
    const event = build(attempt === 0 ? firstId : null, random);
    const file = path.join(dir, `${event.id}.json`);
    try {
      fsImpl.writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return { event, file };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return null;
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
 *   conflict, with its own `code` in `conflict.code`), `id-collision` and `store-locked`.
 */
function appendEvents(root, drafts, { now = new Date(), fsImpl = nodeFs, random = randomChars } = {}) {
  const dir = eventsDir(root);
  fsImpl.mkdirSync(dir, { recursive: true });
  let release;
  try {
    release = acquireLock(fsImpl, lockTarget(root));
  } catch (error) {
    if (/^Could not lock/.test(error.message || '')) return { ok: false, finding: 'store-locked', message: `${error.message} Nothing was written.` };
    throw error;
  }
  try {
    const { events } = readEvents(root, { fsImpl });
    const state = foldInto(events);
    let floor = state.newestAt === null ? -Infinity : state.newestAt + 1;
    const stamped = [];
    for (const draft of drafts) {
      const atMs = Math.max(now.getTime(), floor);
      floor = atMs + 1;
      const at = new Date(atMs).toISOString();
      // The dry run draws the id the write will try first, so a conflict names the event it refuses.
      const id = idFor(at, random);
      const probe = { v: 1, id, type: draft.type, at, by: draft.by, data: draft.data };
      const raised = applyEvent(state, probe);
      if (raised.length) {
        return {
          ok: false, finding: 'illegal-transition', conflict: raised[0],
          message: `${raised[0].reason}. Nothing was written.`,
        };
      }
      stamped.push({ draft, at, id });
    }
    const written = [];
    for (const { draft, at, id } of stamped) {
      const build = (first, rand) => ({ v: 1, id: first || idFor(at, rand), type: draft.type, at, by: draft.by, data: draft.data });
      const made = createExclusive(fsImpl, dir, build, id, random);
      if (!made) {
        return { ok: false, finding: 'id-collision', written, message: `could not create a free event id after ${COLLISION_RETRIES} tries; ${written.length} of ${stamped.length} events were written.` };
      }
      written.push({ id: made.event.id, file: path.relative(root, made.file).split(path.sep).join('/'), event: made.event });
    }
    return { ok: true, written };
  } finally {
    release();
  }
}

module.exports = {
  appendEvents, readEvents, readFold, byFromChannel, randomChars,
  EVENT_ID, EVENTS_REL, LIFECYCLE_REL, ALPHABET, COLLISION_RETRIES,
};
