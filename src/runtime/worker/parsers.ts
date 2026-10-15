'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The worker parser table (IC-016, DEC-027). A descriptor's `structuredOutput.parser` names an entry
 * of `PARSERS`; the supervisor feeds it stdout one line at a time and reads one `Report` at the end.
 *
 *   - `doflow-jsonl-v1`: a line that parses as a JSON object with a string `type` is an event;
 *     every other line, and every event whose type or fields this format does not accept, is counted
 *     in `ignoredLines`.
 *   - Any `permission-denied` event makes the report `denied`, whatever the `result` line says and
 *     whatever the exit status.
 *   - A line over the supervisor's 4 MiB line buffer arrives as one `oversize(looksJson)` event; a
 *     JSON-looking one makes the report `unparsed`, reason `oversize-line`, unless a denial was seen
 *     (DEC-057).
 *   - `unparsed` is the fallback for a null or unknown id, and always reports `status: 'unparsed'`.
 *
 * Every free-text field is masked before it is kept: `summary` with the body profile, `action` and
 * `detail` with the line profile. No I/O and no state outside one parser instance.
 */

const { maskLine, maskBody } = require('../mask.ts');

const JSONL_V1 = 'doflow-jsonl-v1';
const UNPARSED = 'unparsed';
const MAX_DENIALS = 20;
const DETAIL_CHARS = 200;
const SUMMARY_BYTES = 2000;
const RESULT_STATUSES = new Set(['success', 'failure']);

type Denial = { action: string; detail: string };
type Report = {
  parser: string;
  status: 'success' | 'failure' | 'denied' | 'unparsed';
  reason: string | null;
  summary: string | null;
  denials: Denial[];
  deniedCount: number;
  usage: { tokens: number } | null;
  ignoredLines: number;
};

/** Cuts `text` to at most `max` UTF-8 bytes without splitting a character. */
function cutBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // back off a continuation byte
  return bytes.subarray(0, end).toString('utf8');
}

/** Cuts `text` to at most `max` characters (code points, so no surrogate pair is split). */
function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** Parses one line as a `doflow-jsonl-v1` event, or returns null. */
function eventOf(text: string): any {
  let value: any;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value.type === 'string' ? value : null;
}

function createJsonlV1() {
  let result: { status: 'success' | 'failure'; summary: string } | null = null;
  const denials: Denial[] = [];
  let deniedCount = 0;
  let usage: { tokens: number } | null = null;
  let ignoredLines = 0;
  let oversizeJson = false;

  return {
    /** IC-016 (DEC-057): a stdout line over `OUTPUT_MAX_BYTES`, never a line with no denial. */
    oversize(looksJson: boolean): void {
      ignoredLines++;
      if (looksJson) oversizeJson = true;
    },
    line(text: string): void {
      const event = eventOf(String(text ?? '').replace(/\r$/, ''));
      if (event && event.type === 'result' && RESULT_STATUSES.has(event.status) && typeof event.summary === 'string') {
        result = { status: event.status, summary: event.summary };
      } else if (event && event.type === 'permission-denied' && typeof event.action === 'string' && typeof event.detail === 'string') {
        deniedCount++;
        if (denials.length < MAX_DENIALS) {
          denials.push({ action: maskLine(event.action).text, detail: cutChars(maskLine(event.detail).text, DETAIL_CHARS) });
        }
      } else if (event && event.type === 'usage' && Number.isInteger(event.tokens) && event.tokens >= 0) {
        usage = { tokens: event.tokens };
      } else {
        ignoredLines++;
      }
    },
    end(): Report {
      // Masked first and cut second, so a cut never leaves an unmasked prefix of a secret behind.
      const summary = result ? cutBytes(maskBody(result.summary).text, SUMMARY_BYTES) : null;
      let status: Report['status'];
      let reason: string | null = null;
      if (deniedCount > 0) status = 'denied';
      else if (oversizeJson) { status = 'unparsed'; reason = 'oversize-line'; }
      else if (result) status = result.status;
      else { status = 'unparsed'; reason = 'no-result-line'; }
      return { parser: JSONL_V1, status, reason, summary, denials: denials.slice(), deniedCount, usage, ignoredLines };
    },
  };
}

/** The fallback: reads nothing and reports `unparsed` with the reason it was chosen. */
function unparsedParser(reason: 'no-structured-output-declared' | 'parser-unknown') {
  return {
    id: UNPARSED,
    create() {
      let ignoredLines = 0;
      return {
        line(): void { ignoredLines++; },
        oversize(): void { ignoredLines++; },
        end(): Report {
          return { parser: UNPARSED, status: 'unparsed', reason, summary: null, denials: [], deniedCount: 0, usage: null, ignoredLines };
        },
      };
    },
  };
}

const PARSERS: Record<string, { id: string; create(): { line(text: string): void; oversize(looksJson: boolean): void; end(): Report } }> = Object.freeze({
  [JSONL_V1]: Object.freeze({ id: JSONL_V1, create: createJsonlV1 }),
});

/** The parser for `id`; the `unparsed` fallback for a null or unknown one. */
function parserFor(id: string | null | undefined) {
  if (id === null || id === undefined) return unparsedParser('no-structured-output-declared');
  return Object.prototype.hasOwnProperty.call(PARSERS, id) ? PARSERS[id] : unparsedParser('parser-unknown');
}

module.exports = { PARSERS, parserFor, JSONL_V1, UNPARSED, MAX_DENIALS, DETAIL_CHARS, SUMMARY_BYTES };
