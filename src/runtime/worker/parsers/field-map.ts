'use strict';

/**
 * The `jsonl-field-map-v1` interpreter (design 171 section 3.3, IC-001): compiles a validated field map into a frozen
 * parser factory. One line is one JSON event; the first rule whose `when` all hold is applied; `end()` follows the
 * fixed precedence of the codex parser. Pure: no I/O and no state outside one instance, and `line` never throws.
 */

const { maskLine, maskBody } = require('../../mask.ts');
const { validateFieldMap } = require('../../../registry/field-map.ts');
const { MAX_DENIALS, DETAIL_CHARS, SUMMARY_BYTES, cutBytes, cutChars, lineText } = require('./common.ts');

import type { Denial, Report } from './common.ts';

type Instance = { line(text: string): void; oversize(looksJson: boolean): void; lastMessage?: (text: string) => void; end(): Report };
type Read = { present: boolean; value: any };
type Check = (event: any) => boolean;
type TextOf = (event: any) => string;

const ABSENT: Read = Object.freeze({ present: false, value: undefined });

function plain(value: any): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** One own property at a time; a step into anything but a plain object reads as absent. */
function read(event: any, path: string[]): Read {
  let current = event;
  for (const segment of path) {
    if (!plain(current) || !Object.hasOwn(current, segment)) return ABSENT;
    current = current[segment];
  }
  return { present: true, value: current };
}

function count(value: any): number | null { return Number.isInteger(value) && value >= 0 ? value : null; }

function isKind(kind: string, found: Read): boolean {
  if (!found.present) return false;
  const value = found.value;
  switch (kind) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'count': return count(value) !== null;
    case 'boolean': return typeof value === 'boolean';
    case 'object': return plain(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return true; // 'present'
  }
}

function compileTest(test: any): Check {
  const path: string[] = test.path.slice();
  if (Object.hasOwn(test, 'equals')) { const wanted = test.equals; return (event) => { const found = read(event, path); return found.present && found.value === wanted; }; }
  if (Object.hasOwn(test, 'in')) { const wanted: any[] = test.in.slice(); return (event) => { const found = read(event, path); return found.present && wanted.some((value) => value === found.value); }; }
  const kind: string = test.is;
  return (event) => isKind(kind, read(event, path));
}

function compileText(text: any): TextOf {
  if (Object.hasOwn(text, 'literal')) { const literal: string = text.literal; return () => literal; }
  const path: string[] = text.path.slice();
  return (event) => {
    try { return String(read(event, path).value ?? ''); } catch { return ''; }
  };
}

/** The string a capture reads; S1 puts a string test on the same path, so a non-string only arises from a bad map. */
function capture(event: any, path: string[]): string | null {
  const found = read(event, path);
  return found.present && typeof found.value === 'string' ? found.value : null;
}

type Actions = {
  final?: string[]; spawn?: true; denial?: { action: TextOf; detail: TextOf };
  usage?: { sum: string[][]; require: 'any' | 'all' }; streamError?: string[];
  terminal?: { outcome: 'completed' | 'failed'; summary?: string[] };
};

function compileActions(then: any): Actions {
  const out: Actions = {};
  if (then.final) out.final = then.final.slice();
  if (then.spawn) out.spawn = true;
  if (then.denial) out.denial = { action: compileText(then.denial.action), detail: compileText(then.denial.detail) };
  if (then.usage) out.usage = { sum: then.usage.tokens.sum.map((path: string[]) => path.slice()), require: then.usage.tokens.require };
  if (then.streamError) out.streamError = then.streamError.slice();
  if (then.terminal) out.terminal = { outcome: then.terminal.outcome, summary: then.terminal.summary?.slice() };
  return out;
}

/** A frozen `{id, create}` for a map `validateFieldMap` accepts; throws `field-map-invalid: <first error>` otherwise. */
function compileFieldMap(map: any) {
  const errors: string[] = [];
  validateFieldMap(map, 'fieldMap', errors);
  if (errors.length > 0) throw new Error(`field-map-invalid: ${errors[0]}`);

  const id: string = map.id;
  const eventType: string[] = map.eventType.slice();
  const missingTerminal: string = map.missingTerminal;
  const fallback = map.finalFallback === 'last-message-file';
  const rules = map.rules.map((rule: any) => ({ checks: rule.when.map(compileTest) as Check[], actions: compileActions(rule.then) }));

  function create(): Instance {
    const denials: Denial[] = [];
    let deniedCount = 0;
    let usage: { tokens: number } | null = null;
    let ignoredLines = 0;
    let oversizeJson = false;
    let final: string | null = null;
    let fileFinal: string | null = null;
    let spawned = false;
    let terminal: 'completed' | 'failed' | null = null;
    let failMessage: string | null = null;
    let streamError: string | null = null;

    function apply(event: any, actions: Actions): void {
      if (actions.final) final = capture(event, actions.final);
      if (actions.spawn) spawned = true;
      if (actions.denial) {
        deniedCount++;
        if (denials.length < MAX_DENIALS) {
          denials.push({
            action: cutChars(maskLine(actions.denial.action(event)).text, DETAIL_CHARS),
            detail: cutChars(maskLine(actions.denial.detail(event)).text, DETAIL_CHARS),
          });
        }
      }
      if (actions.usage) {
        const values = actions.usage.sum.map((path) => read(event, path).value);
        const parts = values.map(count);
        // Like the Pi parser: an integer part beyond the safe range, or a sum that leaves it, is no total at all.
        const tokens = parts.reduce((total: number, part) => total + (part ?? 0), 0);
        if (values.some((value) => Number.isInteger(value) && !Number.isSafeInteger(value)) || !Number.isSafeInteger(tokens)) usage = null;
        else if (actions.usage.require === 'all' ? parts.some((part) => part === null) : parts.every((part) => part === null)) usage = null;
        else usage = { tokens };
      }
      if (actions.streamError) streamError = capture(event, actions.streamError);
      if (actions.terminal) {
        terminal = actions.terminal.outcome;
        if (terminal === 'failed') failMessage = actions.terminal.summary ? capture(event, actions.terminal.summary) : null;
      }
    }

    const instance: Instance = {
      oversize(looksJson: boolean): void {
        ignoredLines++;
        if (looksJson) oversizeJson = true;
      },
      line(text: string): void {
        try {
          let event: any;
          try { event = JSON.parse(lineText(text)); } catch { event = undefined; }
          if (typeof read(event, eventType).value !== 'string') { ignoredLines++; return; }
          const rule = rules.find((candidate: any) => candidate.checks.every((check: Check) => check(event)));
          if (!rule) { ignoredLines++; return; }
          apply(event, rule.actions);
        } catch {
          ignoredLines++;
        }
      },
      end(): Report {
        let status: Report['status'];
        let reason: string | null = null;
        let rawSummary: string | null = null;
        if (deniedCount > 0) status = 'denied';
        else if (oversizeJson) { status = 'unparsed'; reason = 'oversize-line'; }
        else if (spawned) { status = 'failure'; reason = 'spawn-observed'; }
        else if (terminal === 'failed') { status = 'failure'; rawSummary = failMessage; }
        else if (terminal === 'completed' && (final ?? fileFinal) !== null) { status = 'success'; rawSummary = final ?? fileFinal; }
        else if (terminal === 'completed') { status = 'unparsed'; reason = 'no-final-message'; }
        else if (streamError !== null) { status = 'failure'; reason = 'stream-error'; rawSummary = streamError; }
        else { status = 'unparsed'; reason = missingTerminal; }

        // Masked first and cut second, so a cut never leaves an unmasked prefix of a secret behind.
        const summary = rawSummary === null ? null : cutBytes(maskBody(rawSummary).text, SUMMARY_BYTES);
        return { parser: id, status, reason, summary, denials: denials.slice(), deniedCount, usage, ignoredLines };
      },
    };
    if (fallback) instance.lastMessage = (text: string): void => { if (String(text ?? '').trim() !== '') fileFinal = String(text); };
    return instance;
  }

  return Object.freeze({ id, create });
}

module.exports = { compileFieldMap, compileTest, read };
