'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Helpers and limits shared by every worker parser (IC-001, IC-002). Pure: no I/O, no state.
 * `parsers.ts` and each `parsers/<harness>.ts` import from here.
 */

const MAX_DENIALS = 20;
const DETAIL_CHARS = 200;
const SUMMARY_BYTES = 2000;

export type Denial = { action: string; detail: string };
export type Report = {
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

/** Parses one line as an event (a JSON object with a string `type`), or returns null. */
function eventOf(text: string): any {
  let value: any;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value.type === 'string' ? value : null;
}

/** The line as a string with one trailing `\r` removed (IC-002 rule 1); never throws. */
function lineText(text: unknown): string {
  return String(text ?? '').replace(/\r$/, '');
}

module.exports = { MAX_DENIALS, DETAIL_CHARS, SUMMARY_BYTES, cutBytes, cutChars, eventOf, lineText };
