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
const { MAX_DENIALS, DETAIL_CHARS, SUMMARY_BYTES, cutBytes, cutChars, eventOf, lineText } = require('./parsers/common.ts');

const claude = require('./parsers/claude.ts');
const opencode = require('./parsers/opencode.ts');
const copilot = require('./parsers/copilot.ts');
const kiro = require('./parsers/kiro.ts');
const pi = require('./parsers/pi.ts');

import type { Denial, Report } from './parsers/common.ts';

const JSONL_V1 = 'doflow-jsonl-v1';
const CODEX_EXEC_JSON_V1 = 'codex-exec-json-v1';
const UNPARSED = 'unparsed';
const RESULT_STATUSES = new Set(['success', 'failure']);

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
      const event = eventOf(lineText(text));
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

/** Parses Codex `exec --json` events (IC-003). */
function createCodexExecJsonV1() {
  const denials: Denial[] = [];
  let deniedCount = 0;
  let usage: { tokens: number } | null = null;
  let ignoredLines = 0;
  let oversizeJson = false;
  let final: string | null = null;
  let fileFinal: string | null = null;
  let spawnObserved = false;
  let terminal: 'completed' | 'failed' | null = null;
  let failMessage: string | null = null;
  let streamError: string | null = null;

  return {
    oversize(looksJson: boolean): void {
      ignoredLines++;
      if (looksJson) oversizeJson = true;
    },
    line(text: string): void {
      const event = eventOf(lineText(text));
      if (!event) {
        ignoredLines++;
        return;
      }

      const item = event.item;
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
        final = item.text;
      } else if (['item.started', 'item.updated', 'item.completed'].includes(event.type)
        && item?.type === 'collab_tool_call' && item.tool === 'spawn_agent') {
        spawnObserved = true;
      } else if (event.type === 'item.completed' && item?.type === 'command_execution' && item.status === 'declined') {
        deniedCount++;
        if (denials.length < MAX_DENIALS) {
          denials.push({ action: 'command', detail: cutChars(maskLine(String(item.command ?? '')).text, DETAIL_CHARS) });
        }
      } else if (event.type === 'turn.completed') {
        terminal = 'completed';
        const reported = event.usage;
        const input = Number.isInteger(reported?.input_tokens) && reported.input_tokens >= 0 ? reported.input_tokens : null;
        const output = Number.isInteger(reported?.output_tokens) && reported.output_tokens >= 0 ? reported.output_tokens : null;
        usage = input === null && output === null ? null : { tokens: (input ?? 0) + (output ?? 0) };
      } else if (event.type === 'turn.failed' && typeof event.error?.message === 'string') {
        terminal = 'failed';
        failMessage = event.error.message;
      } else if (event.type === 'error' && typeof event.message === 'string') {
        streamError = event.message;
      } else {
        ignoredLines++;
      }
    },
    lastMessage(text: string): void {
      if (String(text ?? '').trim()) fileFinal = String(text);
    },
    end(): Report {
      let status: Report['status'];
      let reason: string | null = null;
      let rawSummary: string | null = null;
      if (deniedCount > 0) status = 'denied';
      else if (oversizeJson) { status = 'unparsed'; reason = 'oversize-line'; }
      else if (spawnObserved) { status = 'failure'; reason = 'spawn-observed'; }
      else if (terminal === 'failed') { status = 'failure'; rawSummary = failMessage; }
      else if (terminal === 'completed' && (final ?? fileFinal) !== null) {
        status = 'success';
        rawSummary = final ?? fileFinal;
      } else if (terminal === 'completed') { status = 'unparsed'; reason = 'no-final-message'; }
      else if (streamError !== null) { status = 'failure'; reason = 'stream-error'; rawSummary = streamError; }
      else { status = 'unparsed'; reason = 'no-turn-end'; }

      const summary = rawSummary === null ? null : cutBytes(maskBody(rawSummary).text, SUMMARY_BYTES);
      return { parser: CODEX_EXEC_JSON_V1, status, reason, summary, denials: denials.slice(), deniedCount, usage, ignoredLines };
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

type ParserInstance = { line(text: string): void; oversize(looksJson: boolean): void; lastMessage?: (text: string) => void; end(): Report };
type ParserFactory = { id: string; create(): ParserInstance };

const PARSERS: Readonly<Record<string, ParserFactory>> = Object.freeze({
  [JSONL_V1]: Object.freeze({ id: JSONL_V1, create: createJsonlV1 }),
  [CODEX_EXEC_JSON_V1]: Object.freeze({ id: CODEX_EXEC_JSON_V1, create: createCodexExecJsonV1 }),
  [claude.ID]: Object.freeze({ id: claude.ID, create: claude.create }),
  [opencode.ID]: Object.freeze({ id: opencode.ID, create: opencode.create }),
  [copilot.ID]: Object.freeze({ id: copilot.ID, create: copilot.create }),
  [kiro.ID]: Object.freeze({ id: kiro.ID, create: kiro.create }),
  [pi.ID]: Object.freeze({ id: pi.ID, create: pi.create }),
});

/** The parser for `id`; the `unparsed` fallback for a null or unknown one. */
function parserFor(id: string | null | undefined) {
  if (id === null || id === undefined) return unparsedParser('no-structured-output-declared');
  return Object.prototype.hasOwnProperty.call(PARSERS, id) ? PARSERS[id] : unparsedParser('parser-unknown');
}

module.exports = { PARSERS, parserFor, JSONL_V1, CODEX_EXEC_JSON_V1, UNPARSED, MAX_DENIALS, DETAIL_CHARS, SUMMARY_BYTES };
