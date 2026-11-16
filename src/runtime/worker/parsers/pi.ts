'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `pi-json-v1` (IC-007): the stream of `pi -p --mode json`, one JSON object per line.
 *
 *   - `agent_end` is the terminal event. Its last message decides the outcome: `role === "assistant"`,
 *     `stopReason === "stop"` and non-empty text (the concatenated `text` content blocks) is a success;
 *     `stopReason === "error"` is a failure whose summary is `errorMessage` when that is a string.
 *     `stopReason === "length"` (the answer was cut off at the output token limit) is a failure, reason `length`;
 *     the partial text Pi printed is kept as the summary when there is any.
 *     Any other last message is no positive signal, so it reports `unparsed`.
 *   - `agent_settled` with `aborted === true` turns a success into a failure, reason `aborted`.
 *   - `tool_execution_start` with a `toolName` matching /subagent/i is a spawn signal.
 *   - No denial event was observed for pi, so this parser never reports `denied`.
 *   - Usage and cost come from `message_end` events whose message is an assistant message (docs/json.md: `message_end`
 *     is "the authoritative final message"; docs/message-types.md: "Assistant messages always contain usage"). Each
 *     assistant message carries the usage of its own model call (the top-level `usage` of a `message_update` is the
 *     cumulative usage of that one response), so the report is the SUM over the stream's assistant messages.
 *       - A message's token count is `usage.input + usage.output`, as the claude, opencode and copilot parsers count
 *         it; Pi's `totalTokens` also adds cache reads and writes and is not read. A message whose `input` and
 *         `output` are not both non-negative safe integers has no count, and so has one where both are 0 (Pi starts
 *         every usage at zero, so an all-zero usage is read as "not reported").
 *       - All or nothing (as opencode.ts): if any assistant `message_end` has no count, the run tokens are `null`,
 *         and `usage` is then `null`. The one exception is a message whose stopReason is `error` or `aborted`: Pi's
 *         synthetic failure message carries no usage and is skipped, it does not null the total.
 *       - The cost is `usage.cost.total`, summed on its own field by the same rule: only when every counted message
 *         carries a finite non-negative cost, else `cost` is `null`. A cost on a message with no count is never added.
 *       - The sum of tokens must stay a safe integer and the sum of costs finite, else that figure is `null`.
 *       - An assistant `message_end` that gave no count counts in `ignoredLines`.
 *     Not counted, because Pi puts them outside the assistant messages: compaction and summarization calls and a
 *     tool's nested model work.
 *
 * Pure: no I/O, no state outside one instance. Only the masked summary text is kept.
 */

const { maskBody } = require('../../mask.ts');
const { SUMMARY_BYTES, cutBytes, eventOf, lineText } = require('./common.ts');

import type { Report } from './common.ts';

const ID = 'pi-json-v1';
const SPAWN_TOOL = /subagent/i;

type Terminal = { kind: 'stop'; text: string } | { kind: 'error'; message: string | null } | { kind: 'length'; text: string } | { kind: 'other' };

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The concatenated `text` blocks of an assistant message's content, or null when `content` is not a block list. */
function textOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
      text += (block as any).text;
    }
  }
  return text;
}

/** The terminal read from an `agent_end` event, or null when `messages[-1]` cannot be read. */
function terminalOf(event: any): Terminal | null {
  const messages = event.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return null;
  if (last.stopReason === 'error') {
    return { kind: 'error', message: typeof last.errorMessage === 'string' ? last.errorMessage : null };
  }
  const text = last.role === 'assistant' ? textOf(last.content) : null;
  if (text !== null && last.stopReason === 'stop') return text.trim() === '' ? { kind: 'other' } : { kind: 'stop', text };
  if (last.role === 'assistant' && last.stopReason === 'length') return { kind: 'length', text: text ?? '' };
  return { kind: 'other' };
}

function create() {
  let ignoredLines = 0;
  let oversizeJson = false;
  let spawnObserved = false;
  let aborted = false;
  let terminal: Terminal | null = null;
  let tokens = 0;
  let cost = 0;
  let counted = 0; // assistant messages that gave a token count
  let tokensBad = false; // a message with no count (not a skipped failure one), or a sum that left the safe range
  let costBad = false; // a counted message with no usable cost, or a sum that is not finite

  /** Reads one assistant message_end: its count and cost go into the sums, anything else is an ignored line. */
  function addUsage(message: any): void {
    const usage = message.usage;
    const input = usage?.input;
    const output = usage?.output;
    if (!isCount(input) || !isCount(output) || (input === 0 && output === 0) || !Number.isSafeInteger(input + output)) {
      ignoredLines++;
      // Pi's synthetic failure message carries no usage; every other message without a count makes the total unknown.
      if (message.stopReason !== 'error' && message.stopReason !== 'aborted') tokensBad = true;
      return;
    }
    counted++;
    tokens += input + output;
    if (!Number.isSafeInteger(tokens)) tokensBad = true;
    if (isAmount(usage.cost?.total)) cost += usage.cost.total;
    else costBad = true;
    if (!Number.isFinite(cost)) costBad = true;
  }

  return {
    oversize(looksJson: boolean): void {
      ignoredLines++;
      if (looksJson) oversizeJson = true;
    },
    line(text: string): void {
      let event: any;
      try { event = eventOf(lineText(text)); } catch { event = null; }
      if (!event) {
        ignoredLines++;
        return;
      }

      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        addUsage(event.message);
      } else if (event.type === 'agent_end') {
        const read = terminalOf(event);
        if (read) terminal = read;
        else ignoredLines++;
      } else if (event.type === 'agent_settled') {
        if (event.aborted === true) aborted = true;
        else if (typeof event.aborted !== 'boolean') ignoredLines++;
      } else if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
        if (SPAWN_TOOL.test(event.toolName)) spawnObserved = true;
        else ignoredLines++;
      } else {
        ignoredLines++;
      }
    },
    end(): Report {
      let status: Report['status'];
      let reason: string | null = null;
      let rawSummary: string | null = null;
      const done = terminal as Terminal | null;
      if (oversizeJson) { status = 'unparsed'; reason = 'oversize-line'; }
      else if (spawnObserved) { status = 'failure'; reason = 'spawn-observed'; }
      else if (done === null) { status = 'unparsed'; reason = 'no-agent-end'; }
      else if (done.kind === 'error') { status = 'failure'; rawSummary = done.message; }
      else if (done.kind === 'length') { status = 'failure'; reason = 'length'; rawSummary = done.text.trim() === '' ? null : done.text; }
      else if (done.kind === 'stop' && aborted) { status = 'failure'; reason = 'aborted'; }
      else if (done.kind === 'stop') { status = 'success'; rawSummary = done.text; }
      else { status = 'unparsed'; reason = 'no-final-message'; }

      // Masked first and cut second, so a cut never leaves an unmasked prefix of a secret behind.
      const summary = rawSummary === null ? null : cutBytes(maskBody(rawSummary).text, SUMMARY_BYTES);
      return { parser: ID, status, reason, summary, denials: [], deniedCount: 0, usage: counted === 0 || tokensBad ? null : { tokens, cost: costBad ? null : cost }, ignoredLines };
    },
  };
}

module.exports = { ID, create };
