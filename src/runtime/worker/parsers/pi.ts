'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `pi-json-v1` (IC-007): the stream of `pi -p --mode json`, one JSON object per line.
 *
 *   - `agent_end` is the terminal event. Its last message decides the outcome: `role === "assistant"`,
 *     `stopReason === "stop"` and non-empty text (the concatenated `text` content blocks) is a success;
 *     `stopReason === "error"` is a failure whose summary is `errorMessage` when that is a string.
 *     Any other last message is no positive signal, so it reports `unparsed`.
 *   - `agent_settled` with `aborted === true` turns a success into a failure, reason `aborted`.
 *   - `tool_execution_start` with a `toolName` matching /subagent/i is a spawn signal.
 *   - No denial event was observed for pi, so this parser never reports `denied`.
 *   - Usage is not read: IC-007 names no token field, so `usage` is always `null`.
 *
 * Pure: no I/O, no state outside one instance. Only the masked summary text is kept.
 */

const { maskBody } = require('../../mask.ts');
const { SUMMARY_BYTES, cutBytes, eventOf, lineText } = require('./common.ts');

import type { Report } from './common.ts';

const ID = 'pi-json-v1';
const SPAWN_TOOL = /subagent/i;

type Terminal = { kind: 'stop'; text: string } | { kind: 'error'; message: string | null } | { kind: 'other' };

/** The terminal read from an `agent_end` event, or null when `messages[-1]` cannot be read. */
function terminalOf(event: any): Terminal | null {
  const messages = event.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return null;
  if (last.stopReason === 'error') {
    return { kind: 'error', message: typeof last.errorMessage === 'string' ? last.errorMessage : null };
  }
  if (last.role === 'assistant' && last.stopReason === 'stop' && Array.isArray(last.content)) {
    let text = '';
    for (const block of last.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      }
    }
    return text.trim() === '' ? { kind: 'other' } : { kind: 'stop', text };
  }
  return { kind: 'other' };
}

function create() {
  let ignoredLines = 0;
  let oversizeJson = false;
  let spawnObserved = false;
  let aborted = false;
  let terminal: Terminal | null = null;

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

      if (event.type === 'agent_end') {
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
      else if (done.kind === 'stop' && aborted) { status = 'failure'; reason = 'aborted'; }
      else if (done.kind === 'stop') { status = 'success'; rawSummary = done.text; }
      else { status = 'unparsed'; reason = 'no-final-message'; }

      // Masked first and cut second, so a cut never leaves an unmasked prefix of a secret behind.
      const summary = rawSummary === null ? null : cutBytes(maskBody(rawSummary).text, SUMMARY_BYTES);
      return { parser: ID, status, reason, summary, denials: [], deniedCount: 0, usage: null, ignoredLines };
    },
  };
}

module.exports = { ID, create };
