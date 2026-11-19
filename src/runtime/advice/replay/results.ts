'use strict';

// The user-level result store of local replays (175 IC-006, O-4): store `advice-results-user`, `<user state>/advice/results.json`.
// One entry per (project key, kind, model digest); a later write for that key replaces the earlier one, and entries of two
// projects for one kind and digest live side by side. The file holds ids from data, digests, counts and figures only: every
// entry is rebuilt from the allowlist below on write (an unknown field is left out) and on read (an entry with an unknown
// field, a digest that is not `sha256:<hex>` or a figure that is not a number is dropped). No standing is ever stored, so
// a reader always judges the numbers against the bars of the moment; no case id or case text is ever stored either.
// A write takes the store's lock, re-reads, replaces the key's entry, keeps the newest MAX_RESULTS by `runAt`, and lands
// through a temp file in the same folder and a rename. An unreadable store reads as no result. A write leaves every other
// object of the file as it was, also one that fails the read check (an entry another DoFlow version wrote, with a field
// this one does not know): the read ignores it, the write does not delete it. Such an entry counts toward MAX_RESULTS.

const fs = require('node:fs');
const path = require('node:path');
const { acquireLock } = require('../../task-state.ts');
const { writeFileAtomic } = require('../../write-file-atomic.ts');

const RESULTS_PATH = ['advice', 'results.json'];
const SCHEMA = 1;
const MAX_RESULTS = 256;

// Leaf shapes. Each one admits no free text: an id is a short lowercase slug, a model name has no space, a digest is hex.
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{1,128}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const NO_ANSWER_REASONS = ['timeout', 'over-budget', 'unreachable', 'malformed-reply', 'split'];

type Leaf = 'id' | 'model' | 'digest' | 'origin' | 'count' | 'figure' | 'time' | 'version' | 'reasons';
type Shape = Leaf | { [key: string]: Shape };

/**
 * Every field an entry may hold. `count` is a non-negative integer; `figure` a finite number, or null where `score` gives
 * null (a zero denominator, an undefined kappa); `reasons` maps a no-answer reason of `score` to a count. `metrics` is what
 * `replay/score.ts score` returns without `worseIds` (case ids) and without `perClass` and `labelCounts` (keyed by option
 * names; the replay prints them, nothing after it reads them).
 */
const ENTRY_FIELDS: { [key: string]: Shape } = {
  kind: 'id',
  provider: 'id',
  model: 'model',
  modelDigest: 'digest',
  questionDigest: 'digest',
  builderDigest: 'digest',
  barsDigest: 'digest',
  caseSet: { source: 'id', origin: 'origin', projectKey: 'digest', digest: 'digest', eligible: 'count', replayed: 'count' },
  metrics: {
    n: 'count',
    valid: 'count',
    validShare: 'figure',
    noAnswer: { count: 'count', share: 'figure', byReason: 'reasons' },
    accuracy: { model: 'figure', rule: 'figure' },
    kappa: { model: 'figure', rule: 'figure', lower: 'figure', gain: 'figure', gainLower: 'figure' },
    worse: 'count',
    better: 'count',
    worseShare: 'figure',
    minority: 'count',
    latencyMs: { first: 'figure', p50: 'figure', p95: 'figure', max: 'figure' },
  },
  runAt: 'time',
  doflowVersion: 'version',
};

const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: any): boolean => Number.isSafeInteger(value) && value >= 0;

function leafOk(leaf: Leaf, value: any): boolean {
  switch (leaf) {
    case 'id': return typeof value === 'string' && ID.test(value);
    case 'model': return typeof value === 'string' && MODEL.test(value);
    case 'digest': return typeof value === 'string' && DIGEST.test(value);
    case 'origin': return value === 'project' || value === 'package';
    case 'count': return isCount(value);
    case 'figure': return value === null || (typeof value === 'number' && Number.isFinite(value));
    case 'time': return typeof value === 'string' && TIME.test(value) && Number.isFinite(Date.parse(value));
    case 'version': return typeof value === 'string' && VERSION.test(value);
    case 'reasons': return isObject(value) && Object.entries(value).every(([key, count]) => NO_ANSWER_REASONS.includes(key) && isCount(count));
    default: return false;
  }
}

/**
 * `value` rebuilt from `shape`, or a message naming the first field that does not fit. `strict` (read) refuses an unknown
 * key; otherwise (write) an unknown key is left out. A missing field or a value of the wrong shape is refused either way.
 */
function rebuild(shape: Shape, value: any, where: string, strict: boolean): { ok: true; value: any } | { ok: false; error: string } {
  if (typeof shape === 'string') {
    if (!leafOk(shape, value)) return { ok: false, error: `${where} is not a valid ${shape}` };
    return { ok: true, value: shape === 'reasons' ? { ...value } : value };
  }
  if (!isObject(value)) return { ok: false, error: `${where} must be an object` };
  if (strict) {
    const unknown = Object.keys(value).find((key) => !Object.hasOwn(shape, key));
    if (unknown !== undefined) return { ok: false, error: `${where}.${unknown} is not a known field` };
  }
  const out: any = {};
  for (const [key, inner] of Object.entries(shape)) {
    const built = rebuild(inner, value[key], `${where}.${key}`, strict);
    if (!built.ok) return built;
    out[key] = built.value;
  }
  return { ok: true, value: out };
}

const keyOf = (entry: any): string => JSON.stringify([entry?.caseSet?.projectKey, entry?.kind, entry?.modelDigest]);

/** The store file under `roots['user-state']`, or null when that root does not resolve. */
function resultsFile(roots: any): string | null {
  const userState = roots?.['user-state'];
  return userState ? path.join(userState, ...RESULTS_PATH) : null;
}

function readFrom(file: string | null, fsImpl: any): any[] {
  if (file === null) return [];
  let parsed: any;
  try { parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return []; }
  if (!isObject(parsed) || parsed.schema !== SCHEMA || !Array.isArray(parsed.results)) return [];
  const entries: any[] = [];
  for (const raw of parsed.results) {
    const built = rebuild(ENTRY_FIELDS, raw, 'entry', true);
    if (built.ok) entries.push(built.value);
  }
  // A writer never leaves two entries for one key; a file that has them was not written by it, so neither is trusted.
  const seen = new Map<string, number>();
  for (const entry of entries) seen.set(keyOf(entry), (seen.get(keyOf(entry)) || 0) + 1);
  return entries.filter((entry) => seen.get(keyOf(entry)) === 1);
}

/**
 * Every object in the store's `results` as it is in the file, whether or not it passes the allowlist; `[]` for a missing,
 * unparsable or other-schema store. A write keeps these, so an entry another DoFlow version wrote survives it.
 */
function rawEntries(file: string, fsImpl: any): any[] {
  let parsed: any;
  try { parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return []; }
  if (!isObject(parsed) || parsed.schema !== SCHEMA || !Array.isArray(parsed.results)) return [];
  return parsed.results.filter(isObject);
}

/** Every entry of the store that passes the allowlist; a missing, unreadable or other-schema store is `[]`. */
function readResults({ roots, fsImpl = fs }: { roots: any; fsImpl?: any }): any[] {
  return readFrom(resultsFile(roots), fsImpl);
}

/**
 * Stores `entry` for its (project key, kind, model digest), replacing an earlier one, and returns the entry as stored.
 * Throws a TypeError, writing nothing, when an allowlisted field is missing or not its shape; throws an Error with
 * `code: 'results-locked'` when the store's lock cannot be taken in the lock's wait, or `code: 'results-lock-lost'` when
 * another writer reclaimed it before the rename. `lock` is passed to `acquireLock` (its `retries`).
 */
function writeResult({ roots, entry, fsImpl = fs, lock }: { roots: any; entry: any; fsImpl?: any; lock?: any }): any {
  const built = rebuild(ENTRY_FIELDS, entry, 'entry', false);
  if (!built.ok) throw new TypeError(`result not stored: ${built.error}`);
  const file = resultsFile(roots);
  if (file === null) throw new TypeError('result not stored: the user state folder does not resolve');

  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  let release: any;
  try { release = acquireLock(fsImpl, file, lock); } catch (error: any) {
    const locked: any = new Error(`result not stored: ${error?.message || `could not lock '${file}'`}`);
    locked.code = 'results-locked';
    throw locked;
  }
  try {
    const key = keyOf(built.value);
    const kept = rawEntries(file, fsImpl).filter((other) => keyOf(other) !== key);
    kept.push(built.value);
    // Oldest first. An entry with no readable runAt counts as the oldest, so it is pruned before any dated one.
    const age = (item: any): number => {
      const at = typeof item.runAt === 'string' ? Date.parse(item.runAt) : NaN;
      return Number.isFinite(at) ? at : -Infinity;
    };
    kept.sort((a, b) => (age(a) === age(b) ? 0 : age(a) < age(b) ? -1 : 1));
    const results = kept.slice(-MAX_RESULTS);
    writeFileAtomic(file, `${JSON.stringify({ schema: SCHEMA, results }, null, 2)}\n`, {
      fsImpl,
      beforeRename: () => {
        if (typeof release.held === 'function' && !release.held()) {
          const lost: any = new Error(`result not stored: another writer took the lock on '${file}' first; run the replay again`);
          lost.code = 'results-lock-lost';
          throw lost;
        }
      },
    });
  } finally {
    release();
  }
  return built.value;
}

module.exports = { readResults, writeResult, resultsFile, ENTRY_FIELDS, MAX_RESULTS };
