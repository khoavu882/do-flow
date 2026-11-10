'use strict';

// Feature 149 A.3 (IC-002, IC-007, DEC-026, DEC-040): the NDJSON envelope of `doflow events --follow`.
//
// One envelope per line, `{v: 1, ch, id, type, at, data}` produced by `JSON.stringify` and ended by
// `\n`. `id` is `<epoch>-<n>`: the epoch is 8 lowercase hex minted once per writer, `n` starts at 1
// per channel and rises by one with every frame the writer makes on that channel. Every string leaf
// of a section's `json` passes through `maskBody` (src/runtime/mask.ts) before it is framed; object
// keys are left as they are. No line is longer than `LINE_CAP_BYTES`, newline included: a snapshot
// or patch over the cap is split by whole sections, every frame but the last carrying `more: true`,
// and a section too big for a frame of its own turns the whole emission into `reset` `frame-cap`.
//
// No I/O: the writer returns lines and the events command writes them. The clock is injectable.
//
// Feature 150 A.2 (IC-007): the log channels `worker:<runId>:out` and `:err` are framed by
// `logSnapshot` and `append`, never by `snapshot` or `patch`. A log frame's id is the byte cursor
// `<ino>:<offset>:<n>:<ms>`: `n` is the same per-channel counter, `ms` the clock at emit, `offset`
// the frame's `to` (the channel's last `to` for `reset`, `error` and `gone`). Every piece text is
// masked with `maskBody` again; an `append` over the cap is split at piece boundaries into
// consecutive `append` frames, and a log snapshot over the cap drops pieces from its front.

const crypto = require('node:crypto');
const { maskBody } = require('../mask.ts');
const { parseChannel } = require('./channels.ts');
const { RUN_ID, PHASES } = require('../worker/run-store.ts');

/** IC-002: the envelope's `v`. */
const ENVELOPE_VERSION = 1;

/** IC-002, IC-007: every frame type. `append` is the log frame: only `worker:<runId>:out|err` carry it. */
const FRAME_TYPES: readonly string[] = Object.freeze(['snapshot', 'patch', 'append', 'reset', 'error', 'gone']);

/** IC-002: the codes of an `error` frame at the core level. */
const ERROR_CODES: readonly string[] = Object.freeze(['unsupported-version', 'store-unreadable', 'producer-failed', 'too-many-channels']);

/** IC-002: the reasons of a `reset` frame. */
const RESET_REASONS: readonly string[] = Object.freeze(['frame-cap', 'replaced']);

/** IC-007: the longest line printed, in UTF-8 bytes, newline included. */
const LINE_CAP_BYTES = 262144;

/** IC-002 (DEC-026): the grammar of an envelope `id`. */
const ENVELOPE_ID = /^[0-9a-f]{8}-[1-9][0-9]{0,15}$/;

/** The epoch half of an envelope id. */
const EPOCH_PATTERN = /^[0-9a-f]{8}$/;

/** IC-007: the grammar of a log frame's id, `<ino>:<offset>:<n>:<ms>`. */
const LOG_ID = /^[0-9]{1,20}:[0-9]{1,16}:[1-9][0-9]{0,15}:[0-9]{1,16}$/;

/** IC-007: the `log` states of a log snapshot. */
const LOG_STATES: readonly string[] = Object.freeze(['waiting', 'open', 'none']);

type SectionResult = { exit: number; json: unknown };
type Sections = Record<string, SectionResult>;

/** IC-001: one piece of a log page. */
type LogPiece = { at: number; text: string; cut?: true };
type LogEnd = { capped: boolean | null } | null;

/** IC-007: the data of a log `snapshot`. */
interface LogSnapshotData {
  log: 'waiting' | 'open' | 'none';
  ino: string | null;
  from: number;
  to: number;
  pieces: readonly LogPiece[];
  phase: string | null;
  end: LogEnd;
}

/** IC-007: the data of an `append`. */
interface AppendData {
  from: number;
  to: number;
  pieces: readonly LogPiece[];
  phase: string | null;
  end: LogEnd;
}

interface EnvelopeWriter {
  readonly epoch: string;
  snapshot(ch: string, sections: Sections): string[];
  patch(ch: string, sections: Sections, removed?: readonly string[]): string[];
  logSnapshot(ch: string, data: LogSnapshotData): string[];
  append(ch: string, data: AppendData): string[];
  reset(ch: string, reason: string): string[];
  error(ch: string, code: string): string[];
  gone(ch: string): string[];
  needsSnapshot(ch: string): boolean;
}

/**
 * Mints a random epoch: 8 lowercase hex.
 * @returns {string}
 */
function newEpoch(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Masks every string leaf of a JSON value with `maskBody`; object keys, numbers, booleans and null
 * are kept. Returns a new value; the input is not changed. Objects come back with a null prototype
 * so a `__proto__` key stays an own key.
 * @param {unknown} value a JSON value
 * @returns {unknown}
 */
function maskJson(value: unknown): unknown {
  if (typeof value === 'string') return maskBody(value).text;
  if (Array.isArray(value)) return value.map(maskJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) out[key] = maskJson((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks a sections map and masks it (IC-007): each value must be a `SectionResult`
 * `{exit: <integer 0..255>, json}`; `json` is masked by `maskJson`, and an absent `json` becomes
 * null. The events command compares sections by the JSON text of this result (IC-006).
 * @param {Record<string, SectionResult>} sections
 * @returns {Record<string, SectionResult>} a new map, in the given order
 * @throws {TypeError} when the map or a result is malformed (a producer defect)
 */
function maskSections(sections: Sections): Sections {
  if (!isPlainObject(sections)) throw new TypeError('sections must be an object of section results');
  const out: Sections = Object.create(null);
  for (const name of Object.keys(sections)) {
    const result = sections[name];
    if (name === '') throw new TypeError('a section name must be non-empty');
    if (!isPlainObject(result) || !Number.isInteger(result.exit) || result.exit < 0 || result.exit > 255) {
      throw new TypeError(`section '${name}' must be {exit: <integer 0..255>, json}`);
    }
    out[name] = { exit: result.exit, json: result.json === undefined ? null : maskJson(result.json) };
  }
  return out;
}

/**
 * Whether `ch` is a log channel (IC-006, IC-007): `worker:<runId>:out` or `worker:<runId>:err`.
 * @param {unknown} ch
 * @returns {boolean}
 */
function isLogChannel(ch: unknown): ch is string {
  if (typeof ch !== 'string') return false;
  const parts = ch.split(':');
  return parts.length === 3 && parts[0] === 'worker' && RUN_ID.test(parts[1]) && (parts[2] === 'out' || parts[2] === 'err');
}

/** A channel framed by sections (`snapshot`, `patch`): every channel of 149 IC-003, never a log channel. */
function checkChannel(ch: unknown): string {
  if (isLogChannel(ch)) throw new TypeError(`cannot frame channel '${ch}' by sections: a log channel takes logSnapshot and append`);
  const parsed = parseChannel(ch);
  if (!parsed.ok) throw new TypeError(`cannot frame channel: ${parsed.reason}`);
  return parsed.channel.name;
}

/** A channel framed by `reset`, `error` or `gone`: a section channel or a log channel. */
function checkAnyChannel(ch: unknown): string {
  return isLogChannel(ch) ? ch : checkChannel(ch);
}

/** A channel framed by `logSnapshot` or `append`: a log channel only. */
function checkLogChannel(ch: unknown): string {
  if (!isLogChannel(ch)) throw new TypeError('cannot frame a log on this channel: only worker:<runId>:out and worker:<runId>:err are log channels');
  return ch;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const isOffset = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Checks a log frame's byte range and pieces (IC-001) and masks every piece text with `maskBody`
 * again (IC-007). Pieces must start at `from`, rise strictly and lie inside `[from, to)`; no pieces
 * means `from === to`. Returns new pieces holding `at`, the masked `text` and `cut: true` when set.
 * @throws {TypeError} when the range or a piece is malformed (a producer defect)
 */
function maskPieces(pieces: unknown, from: unknown, to: unknown): LogPiece[] {
  if (!isOffset(from) || !isOffset(to) || from > to) throw new TypeError('from and to must be byte offsets with from <= to');
  if (!Array.isArray(pieces)) throw new TypeError('pieces must be an array of {at, text}');
  if ((pieces.length === 0) !== (from === to)) throw new TypeError('a log frame holds pieces exactly when from < to');
  let last = -1;
  return pieces.map((piece: unknown, index: number) => {
    if (!isPlainObject(piece) || !isOffset(piece.at) || typeof piece.text !== 'string' || (piece.cut !== undefined && piece.cut !== true)) {
      throw new TypeError(`piece ${index} must be {at: <byte offset>, text: <string>, cut?: true}`);
    }
    if ((index === 0 && piece.at !== from) || piece.at <= last || piece.at >= to) {
      throw new TypeError(`piece ${index} at ${piece.at} is not inside the frame's range in rising order`);
    }
    last = piece.at;
    const out: LogPiece = { at: piece.at, text: maskBody(piece.text).text };
    if (piece.cut === true) out.cut = true;
    return out;
  });
}

/**
 * Checks a log frame's `phase` and `end` (IC-007): `phase` null or one of `PHASES`; `end` null
 * while the phase is not `ended`, and `{capped: null | boolean}` once it is.
 * @throws {TypeError} when either is malformed
 */
function checkLogState(phase: unknown, end: unknown): { phase: string | null; end: LogEnd } {
  if (phase !== null && !PHASES.includes(phase)) throw new TypeError(`phase must be null or one of ${PHASES.join(', ')}`);
  if (end === null) {
    if (phase === 'ended') throw new TypeError('end must be {capped} once the phase is ended');
    return { phase: phase as string | null, end: null };
  }
  if (!isPlainObject(end) || !(end.capped === null || typeof end.capped === 'boolean')) throw new TypeError('end must be null or {capped: null | boolean}');
  if (phase !== 'ended') throw new TypeError('end must be null while the phase is not ended');
  return { phase, end: { capped: end.capped } };
}

/**
 * Creates the envelope writer of one events process. Each method returns the lines to print, in
 * order, each ending in `\n`, and advances the channel's `n` by the number of lines. A channel owes
 * a `snapshot` (a `logSnapshot` on a log channel) at first and again after `reset`, `error` or
 * `gone`; `patch` and `append` throw while one is owed.
 * @param {{epoch?: string, clock?: () => number}} [options] `epoch` (8 lowercase hex) overrides the
 *   random one; `clock` returns epoch milliseconds for `at` (default `Date.now`), read once per call
 * @returns {EnvelopeWriter} `{epoch, snapshot(ch, sections), patch(ch, sections, removed?),
 *   logSnapshot(ch, data), append(ch, data), reset(ch, reason), error(ch, code), gone(ch),
 *   needsSnapshot(ch)}`
 * @throws {TypeError} when `epoch` is not 8 lowercase hex or `clock` is not a function
 */
function createEnvelopeWriter(options: { epoch?: string; clock?: () => number } = {}): EnvelopeWriter {
  const epoch = options.epoch === undefined ? newEpoch() : options.epoch;
  if (typeof epoch !== 'string' || !EPOCH_PATTERN.test(epoch)) throw new TypeError('epoch must be 8 lowercase hex');
  const clock = options.clock === undefined ? Date.now : options.clock;
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning epoch milliseconds');
  const counters = new Map<string, number>();
  const open = new Set<string>();
  /** Per log channel: the inode (`0` while there is no file) and `to` of its last log frame. */
  const cursors = new Map<string, { ino: string; to: number }>();

  const encode = (ch: string, id: string, type: string, at: string, data: Record<string, unknown>): string =>
    `${JSON.stringify({ v: ENVELOPE_VERSION, ch, id, type, at, data })}\n`;

  const sectionId = (n: number): string => `${epoch}-${n}`;

  /** IC-007: `<ino>:<offset>:<n>:<ms>`. */
  const logId = (ino: string, offset: number, n: number, ms: number): string => {
    const whole = Math.floor(ms);
    if (!Number.isSafeInteger(whole) || whole < 0) throw new TypeError('clock must return non-negative epoch milliseconds for a log id');
    return `${ino}:${offset}:${n}:${whole}`;
  };

  /** Commits lines made with the channel's next numbers. */
  const emit = (ch: string, lines: string[]): string[] => {
    counters.set(ch, (counters.get(ch) || 0) + lines.length);
    return lines;
  };

  /** One frame; on a log channel its id carries the channel's last inode and `to` (`0:0` before any). */
  const single = (ch: string, type: string, data: Record<string, unknown>): string[] => {
    const ms = clock();
    const n = (counters.get(ch) || 0) + 1;
    const cursor = cursors.get(ch);
    const id = isLogChannel(ch) ? logId(cursor ? cursor.ino : '0', cursor ? cursor.to : 0, n, ms) : sectionId(n);
    return emit(ch, [encode(ch, id, type, new Date(ms).toISOString(), data)]);
  };

  const resetLines = (ch: string, reason: string): string[] => {
    open.delete(ch);
    return single(ch, 'reset', { reason });
  };

  /**
   * Splits sections into frames under the cap (IC-007). The first frame has `firstType` and carries
   * `removed`; the rest are patches; all but the last carry `more: true`. A frame is the last one
   * when every remaining section fits in it without `more`. Returns null when a section does not
   * fit a frame on its own. Sizes are summed per section and checked again on the built lines.
   */
  const split = (ch: string, firstType: string, sections: Sections, removed: readonly string[]): string[] | null => {
    const at = new Date(clock()).toISOString();
    const names = Object.keys(sections);
    const pieces = names.map((name) => byteLength(JSON.stringify(name)) + 1 + byteLength(JSON.stringify(sections[name])));
    const base = counters.get(ch) || 0;
    const dataOf = (index: number, from: number, to: number, more: boolean): Record<string, unknown> => {
      const part: Sections = Object.create(null);
      for (let k = from; k < to; k += 1) part[names[k]] = sections[names[k]];
      const data: Record<string, unknown> = { sections: part };
      if (index === 0 && removed.length > 0) data.removed = [...removed];
      if (more) data.more = true;
      return data;
    };
    // Bytes of a frame holding sections [from, to): its envelope with empty sections, plus each piece and the commas between.
    const size = (index: number, from: number, to: number, more: boolean): number => {
      const shell = byteLength(encode(ch, sectionId(base + index + 1), index === 0 ? firstType : 'patch', at, dataOf(index, 0, 0, more)));
      let body = 0;
      for (let k = from; k < to; k += 1) body += pieces[k];
      return shell + body + Math.max(0, to - from - 1);
    };
    const bounds: Array<[number, number, boolean]> = [];
    let from = 0;
    for (;;) {
      const index = bounds.length;
      if (size(index, from, names.length, false) <= LINE_CAP_BYTES) {
        bounds.push([from, names.length, false]);
        break;
      }
      let to = from;
      while (to < names.length && size(index, from, to + 1, true) <= LINE_CAP_BYTES) to += 1;
      if (to === from) return null;
      bounds.push([from, to, true]);
      from = to;
    }
    const lines = bounds.map(([start, end, more], index) => encode(ch, sectionId(base + index + 1), index === 0 ? firstType : 'patch', at, dataOf(index, start, end, more)));
    return lines.every((line) => byteLength(line) <= LINE_CAP_BYTES) ? lines : null;
  };

  /** Bytes each piece adds inside a `pieces` array, and their prefix sums: pieces [i, j) cost `sums[j] - sums[i]` plus `j - i - 1` commas. */
  const pieceSums = (pieces: readonly LogPiece[]): number[] => {
    const sums = [0];
    for (const piece of pieces) sums.push(sums[sums.length - 1] + byteLength(JSON.stringify(piece)));
    return sums;
  };
  const piecesBytes = (sums: readonly number[], i: number, j: number): number => sums[j] - sums[i] + Math.max(0, j - i - 1);

  return {
    epoch,

    /**
     * Frames every section of a channel as a `snapshot`, split into `snapshot` + `patch` frames when
     * over the cap, or a single `reset` `frame-cap` when one section does not fit a frame.
     */
    snapshot(ch: string, sections: Sections): string[] {
      const name = checkChannel(ch);
      const lines = split(name, 'snapshot', maskSections(sections), []);
      if (lines === null) return resetLines(name, 'frame-cap');
      open.add(name);
      return emit(name, lines);
    },

    /**
     * Frames the changed sections and the removed names as a `patch`, split by section when over
     * the cap, or `reset` `frame-cap` as for a snapshot. Nothing changed and nothing removed: no line.
     * @throws {TypeError} while the channel owes a snapshot, or on a malformed `removed`
     */
    patch(ch: string, sections: Sections, removed: readonly string[] = []): string[] {
      const name = checkChannel(ch);
      if (!open.has(name)) throw new TypeError(`channel '${name}' owes a snapshot before any patch`);
      const masked = maskSections(sections);
      if (!Array.isArray(removed) || removed.some((item) => typeof item !== 'string' || item === '' || Object.prototype.hasOwnProperty.call(masked, item))) {
        throw new TypeError('removed must list section names, none of them also in sections');
      }
      if (Object.keys(masked).length === 0 && removed.length === 0) return [];
      const lines = split(name, 'patch', masked, removed);
      return lines === null ? resetLines(name, 'frame-cap') : emit(name, lines);
    },

    /**
     * IC-007: one log `snapshot` `{log, ino, from, to, pieces, phase, end}` on `worker:<runId>:out`
     * or `:err`, its id `<ino>:<to>:<n>:<ms>` (`ino` `0` while there is no file). Piece texts are
     * masked again; a frame over the cap drops pieces from its front and `from` moves to the first
     * kept piece (to `to` when none is kept). The channel's cursor becomes this frame's `ino` and `to`.
     * @throws {TypeError} on a channel that is not a log channel, or malformed data
     */
    logSnapshot(ch: string, data: LogSnapshotData): string[] {
      const name = checkLogChannel(ch);
      if (!isPlainObject(data)) throw new TypeError('log snapshot data must be an object');
      if (!LOG_STATES.includes(data.log)) throw new TypeError(`log must be one of ${LOG_STATES.join(', ')}`);
      if (data.log === 'open') {
        if (typeof data.ino !== 'string' || !/^[0-9]{1,20}$/.test(data.ino)) throw new TypeError('an open log needs ino as a decimal string');
      } else if (data.ino !== null || data.from !== 0 || data.to !== 0) {
        throw new TypeError(`a '${data.log}' log has ino null and from and to 0`);
      }
      const pieces = maskPieces(data.pieces, data.from, data.to);
      const { phase, end } = checkLogState(data.phase, data.end);
      const ino = data.ino === null ? '0' : data.ino;
      const to = data.to;
      const ms = clock();
      const at = new Date(ms).toISOString();
      const id = logId(ino, to, (counters.get(name) || 0) + 1, ms);
      const dataOf = (keep: number, withPieces: boolean): Record<string, unknown> => ({
        log: data.log,
        ino: data.ino,
        from: keep === 0 ? data.from : keep < pieces.length ? pieces[keep].at : to,
        to,
        pieces: withPieces ? pieces.slice(keep) : [],
        phase,
        end,
      });
      const sums = pieceSums(pieces);
      const size = (keep: number): number => byteLength(encode(name, id, 'snapshot', at, dataOf(keep, false))) + piecesBytes(sums, keep, pieces.length);
      let keep = 0;
      while (keep < pieces.length && size(keep) > LINE_CAP_BYTES) keep += 1;
      open.add(name);
      cursors.set(name, { ino, to });
      return emit(name, [encode(name, id, 'snapshot', at, dataOf(keep, true))]);
    },

    /**
     * IC-007: the bytes past the channel's last `to` in the same file, `{from, to, pieces, phase,
     * end}` with `from` equal to that `to`; no pieces (`from === to`) reports a change of `phase` or
     * `end` only. Piece texts are masked again. A frame over the cap is split at piece boundaries
     * into consecutive `append` frames, each `from` the previous `to`, each with `phase` and `end`;
     * a piece too big for a frame of its own turns the emission into `reset` `frame-cap`. Each id is
     * `<ino>:<to>:<n>:<ms>` with the inode of the channel's last snapshot.
     * @throws {TypeError} on a channel that is not a log channel, while the channel owes a snapshot,
     *   when `from` is not the channel's last `to`, or on malformed data
     */
    append(ch: string, data: AppendData): string[] {
      const name = checkLogChannel(ch);
      const cursor = cursors.get(name);
      if (!open.has(name) || cursor === undefined) throw new TypeError(`channel '${name}' owes a snapshot before any append`);
      if (!isPlainObject(data)) throw new TypeError('append data must be an object');
      const pieces = maskPieces(data.pieces, data.from, data.to);
      if (data.from !== cursor.to) throw new TypeError(`append from ${data.from} is not the channel's last to ${cursor.to}`);
      const { phase, end } = checkLogState(data.phase, data.end);
      const ms = clock();
      const at = new Date(ms).toISOString();
      const base = counters.get(name) || 0;
      const sums = pieceSums(pieces);
      const count = pieces.length;
      // The frame `index` holding pieces [i, j) and bytes [from, to).
      const frame = (index: number, i: number, j: number, from: number, to: number, withPieces: boolean): string =>
        encode(name, logId(cursor.ino, to, base + index + 1, ms), 'append', at, { from, to, pieces: withPieces ? pieces.slice(i, j) : [], phase, end });
      const size = (index: number, i: number, j: number, from: number, to: number): number =>
        byteLength(frame(index, i, j, from, to, false)) + piecesBytes(sums, i, j);
      const bounds: Array<[number, number, number, number]> = [];
      let i = 0;
      let from = data.from;
      for (;;) {
        const index = bounds.length;
        if (size(index, i, count, from, data.to) <= LINE_CAP_BYTES) {
          bounds.push([i, count, from, data.to]);
          break;
        }
        // A frame that is not the last ends where its next piece starts.
        let j = i;
        while (j + 1 < count && size(index, i, j + 1, from, pieces[j + 1].at) <= LINE_CAP_BYTES) j += 1;
        if (j === i) return resetLines(name, 'frame-cap');
        bounds.push([i, j, from, pieces[j].at]);
        from = pieces[j].at;
        i = j;
      }
      const lines = bounds.map(([start, stop, lo, hi], index) => frame(index, start, stop, lo, hi, true));
      cursors.set(name, { ino: cursor.ino, to: data.to });
      return emit(name, lines);
    },

    /** One `reset` frame (`frame-cap` or `replaced`); the channel then owes a snapshot. */
    reset(ch: string, reason: string): string[] {
      const name = checkAnyChannel(ch);
      if (!RESET_REASONS.includes(reason)) throw new TypeError(`unknown reset reason '${reason}'`);
      return resetLines(name, reason);
    },

    /** One `error` frame with an IC-002 code; the channel then owes a snapshot. */
    error(ch: string, code: string): string[] {
      const name = checkAnyChannel(ch);
      if (!ERROR_CODES.includes(code)) throw new TypeError(`unknown error code '${code}'`);
      open.delete(name);
      return single(name, 'error', { code });
    },

    /** One `gone` frame; the channel then owes a snapshot should it be followed again. */
    gone(ch: string): string[] {
      const name = checkAnyChannel(ch);
      open.delete(name);
      return single(name, 'gone', {});
    },

    /** Whether the channel's next frame must be a snapshot. */
    needsSnapshot(ch: string): boolean {
      return !open.has(ch);
    },
  };
}

module.exports = {
  createEnvelopeWriter,
  newEpoch,
  maskJson,
  maskSections,
  ENVELOPE_VERSION,
  FRAME_TYPES,
  ERROR_CODES,
  RESET_REASONS,
  LINE_CAP_BYTES,
  ENVELOPE_ID,
  EPOCH_PATTERN,
  LOG_ID,
};
