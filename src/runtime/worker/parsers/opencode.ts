'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `opencode-run-json-v1` (IC-004): `opencode run --standalone --format json`, one JSON object per line.
 *
 * Field tags (IC-004):
 *   - SOURCE `probe-oc-copilot.json` P1b/P1c/P1d: the event types `step_start`, `tool_use`, `text`,
 *     `step_finish`; `part.reason === "stop"` on the last `step_finish`; `tool_use.part.state.status`;
 *     the tool names `task` and `subagent`; no top-level result event.
 *   - INFERENCE (to be confirmed or dropped by the captured fixture, IC-014): `part.text` on `text`;
 *     `part.tool` on `tool_use`; `part.tokens.input` and `part.tokens.output` on `step_finish`.
 *   - SOURCE (observed, opencode v2.2.5): `error.message` on an `error` event.
 *     `opencode run --agent <missing> --format json` emits
 *     `{"type":"error","error":{"message":"Agent not found..."}}`. The top-level `message`
 *     fallback below was not observed.
 *
 * Decisions:
 *   - Terminal: the last readable `step_finish`. One whose `part.reason` is not a string unsets the
 *     terminal, so an earlier `stop` cannot make the run a success (fail closed).
 *   - Denials are never reported: the probes show denied tools removed from the toolset, not refused.
 *     The worktree check carries read-only.
 *   - An `error` event is a failure only while no `step_finish` was read (the codex precedence: a
 *     terminal signal is not undone by a stream error).
 *   - Usage: the sum of `tokens.input` + `tokens.output` over every `step_finish`; `null` unless each
 *     `step_finish` states both as non-negative integers. Cache and reasoning counts are not added.
 *   - Only the masked last non-empty `text` (or an error message) is kept. Masked first, cut second.
 */

const { maskLine, maskBody } = require('../../mask.ts');
const { SUMMARY_BYTES, cutBytes, cutChars, eventOf, lineText } = require('./common.ts');

import type { Report } from './common.ts';

const ID = 'opencode-run-json-v1';
const SPAWN_TOOLS = new Set(['task', 'subagent']);
const REASON_CHARS = 40;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function create() {
  let ignoredLines = 0;
  let oversizeJson = false;
  let spawnObserved = false;
  let lastText: string | null = null;
  let finishReason: string | null = null; // the last readable step_finish; null when none or unreadable
  let sawFinish = false;
  let tokens = 0;
  let usageValid = true;
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
      const part = event.part !== null && typeof event.part === 'object' ? event.part : null;

      if (event.type === 'step_finish') {
        sawFinish = true;
        const input = part?.tokens?.input;
        const output = part?.tokens?.output;
        if (isCount(input) && isCount(output)) tokens += input + output;
        else usageValid = false;
        if (typeof part?.reason === 'string') finishReason = part.reason;
        else { finishReason = null; ignoredLines++; }
      } else if (event.type === 'text' && typeof part?.text === 'string' && part.text.trim() !== '') {
        lastText = part.text;
      } else if (event.type === 'tool_use' && typeof part?.tool === 'string' && SPAWN_TOOLS.has(part.tool)) {
        spawnObserved = true;
      } else if (event.type === 'error' && (typeof event.error?.message === 'string' || typeof event.message === 'string')) {
        streamError = typeof event.error?.message === 'string' ? event.error.message : event.message;
      } else {
        ignoredLines++;
      }
    },
    end(): Report {
      let status: Report['status'];
      let reason: string | null = null;
      let rawSummary: string | null = null;
      if (oversizeJson) { status = 'unparsed'; reason = 'oversize-line'; }
      else if (spawnObserved) { status = 'failure'; reason = 'spawn-observed'; }
      else if (finishReason !== null && finishReason !== 'stop') {
        status = 'failure';
        reason = cutChars(`finish-${maskLine(finishReason).text}`, REASON_CHARS);
        rawSummary = lastText;
      } else if (finishReason === 'stop' && lastText !== null) {
        status = 'success';
        rawSummary = lastText;
      } else if (finishReason === 'stop') { status = 'unparsed'; reason = 'no-final-message'; }
      else if (!sawFinish && streamError !== null) { status = 'failure'; reason = 'stream-error'; rawSummary = streamError; }
      else { status = 'unparsed'; reason = 'no-final-step'; }

      const summary = rawSummary === null ? null : cutBytes(maskBody(rawSummary).text, SUMMARY_BYTES);
      return {
        parser: ID, status, reason, summary, denials: [], deniedCount: 0,
        usage: sawFinish && usageValid ? { tokens } : null, ignoredLines,
      };
    },
  };
}

module.exports = { ID, create };
