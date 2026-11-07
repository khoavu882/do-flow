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

const crypto = require('node:crypto');
const { maskBody } = require('../mask.ts');
const { parseChannel } = require('./channels.ts');

/** IC-002: the envelope's `v`. */
const ENVELOPE_VERSION = 1;

/** IC-002: every frame type. `append` is reserved for P2 log channels; nothing here emits it. */
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

type SectionResult = { exit: number; json: unknown };
type Sections = Record<string, SectionResult>;

interface EnvelopeWriter {
  readonly epoch: string;
  snapshot(ch: string, sections: Sections): string[];
  patch(ch: string, sections: Sections, removed?: readonly string[]): string[];
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

function checkChannel(ch: unknown): string {
  const parsed = parseChannel(ch);
  if (!parsed.ok) throw new TypeError(`cannot frame channel: ${parsed.reason}`);
  return parsed.channel.name;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Creates the envelope writer of one events process. Each method returns the lines to print, in
 * order, each ending in `\n`, and advances the channel's `n` by the number of lines. A channel owes
 * a `snapshot` at first and again after `reset`, `error` or `gone`; `patch` throws while one is owed.
 * @param {{epoch?: string, clock?: () => number}} [options] `epoch` (8 lowercase hex) overrides the
 *   random one; `clock` returns epoch milliseconds for `at` (default `Date.now`), read once per call
 * @returns {EnvelopeWriter} `{epoch, snapshot(ch, sections), patch(ch, sections, removed?),
 *   reset(ch, reason), error(ch, code), gone(ch), needsSnapshot(ch)}`
 * @throws {TypeError} when `epoch` is not 8 lowercase hex or `clock` is not a function
 */
function createEnvelopeWriter(options: { epoch?: string; clock?: () => number } = {}): EnvelopeWriter {
  const epoch = options.epoch === undefined ? newEpoch() : options.epoch;
  if (typeof epoch !== 'string' || !EPOCH_PATTERN.test(epoch)) throw new TypeError('epoch must be 8 lowercase hex');
  const clock = options.clock === undefined ? Date.now : options.clock;
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning epoch milliseconds');
  const counters = new Map<string, number>();
  const open = new Set<string>();

  const encode = (ch: string, n: number, type: string, at: string, data: Record<string, unknown>): string =>
    `${JSON.stringify({ v: ENVELOPE_VERSION, ch, id: `${epoch}-${n}`, type, at, data })}\n`;

  /** Commits lines made with the channel's next numbers. */
  const emit = (ch: string, lines: string[]): string[] => {
    counters.set(ch, (counters.get(ch) || 0) + lines.length);
    return lines;
  };

  const single = (ch: string, type: string, data: Record<string, unknown>): string[] =>
    emit(ch, [encode(ch, (counters.get(ch) || 0) + 1, type, new Date(clock()).toISOString(), data)]);

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
      const shell = byteLength(encode(ch, base + index + 1, index === 0 ? firstType : 'patch', at, dataOf(index, 0, 0, more)));
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
    const lines = bounds.map(([start, end, more], index) => encode(ch, base + index + 1, index === 0 ? firstType : 'patch', at, dataOf(index, start, end, more)));
    return lines.every((line) => byteLength(line) <= LINE_CAP_BYTES) ? lines : null;
  };

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

    /** One `reset` frame (`frame-cap` or `replaced`); the channel then owes a snapshot. */
    reset(ch: string, reason: string): string[] {
      const name = checkChannel(ch);
      if (!RESET_REASONS.includes(reason)) throw new TypeError(`unknown reset reason '${reason}'`);
      return resetLines(name, reason);
    },

    /** One `error` frame with an IC-002 code; the channel then owes a snapshot. */
    error(ch: string, code: string): string[] {
      const name = checkChannel(ch);
      if (!ERROR_CODES.includes(code)) throw new TypeError(`unknown error code '${code}'`);
      open.delete(name);
      return single(name, 'error', { code });
    },

    /** One `gone` frame; the channel then owes a snapshot should it be followed again. */
    gone(ch: string): string[] {
      const name = checkChannel(ch);
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
};
