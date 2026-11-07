'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `copilot-json-v1` (IC-005): `copilot -p … --output-format json`, one `{type, data, …}` object per
 * line. Follows the IC-002 rules; precedence in `end()` is the codex parser's.
 *
 * SOURCE: probe-oc-copilot.json P1b/P1c/P1d (copilot 1.0.104): the `result` event with `exitCode`,
 * the `tool.execution_complete` `success` + `error.code === "denied"`, `subagent.started`.
 * SOURCE, live run (copilot 1.0.105, 142 C.2): `assistant.message` `data.content` (a string, empty on
 * a tool-call turn) and `data.error.code` are as inferred. CORRECTED: `tool.execution_complete` carries
 * `toolCallId` but no `toolName` and no `arguments`; both sit on the earlier `tool.execution_start`
 * with the same `toolCallId`, so a denial looks them up there (the complete event's own fields, when
 * present, win).
 * INFERENCE (not seen live): the token field names under `result.usage` (the live `usage` held
 * `premiumRequests` and durations only), so `usage` stays null.
 */

const { maskLine, maskBody } = require('../../mask.ts');
const { MAX_DENIALS, DETAIL_CHARS, SUMMARY_BYTES, cutBytes, cutChars, eventOf, lineText } = require('./common.ts');

import type { Denial, Report } from './common.ts';

const ID = 'copilot-json-v1';
const MAX_STARTED = 256;

/** A non-negative integer token count from `usage`, under the camelCase or snake_case name; else null. */
function tokenCount(usage: any, camel: string, snake: string): number | null {
  for (const name of [camel, snake]) {
    const value = usage?.[name];
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

/** The target a denied tool call carried: a string `path`, `file_path` or `command`, else ''. */
function targetOf(data: any): string {
  const args = data?.arguments;
  for (const name of ['path', 'file_path', 'command']) {
    if (typeof args?.[name] === 'string') return args[name];
  }
  return '';
}

function create() {
  const denials: Denial[] = [];
  let deniedCount = 0;
  let usage: { tokens: number } | null = null;
  let ignoredLines = 0;
  let oversizeJson = false;
  let final: string | null = null; // already masked and cut: no raw event text is kept
  let spawnObserved = false;
  let exitCode: number | null = null;
  const started = new Map<string, { toolName: unknown; arguments: unknown }>(); // by toolCallId, bounded

  return {
    oversize(looksJson: boolean): void {
      ignoredLines++;
      if (looksJson) oversizeJson = true;
    },
    line(text: string): void {
      try {
        const event = eventOf(lineText(text));
        if (!event) {
          ignoredLines++;
          return;
        }
        const data = event.data;

        if (event.type === 'assistant.message' && typeof data?.content === 'string') {
          // An empty message (a tool-call turn) is not a final message and does not displace one.
          if (data.content.trim()) final = cutBytes(maskBody(data.content).text, SUMMARY_BYTES);
        } else if (event.type === 'subagent.started') {
          spawnObserved = true;
        } else if (event.type === 'tool.execution_complete' && data?.success === false && data?.error?.code === 'denied') {
          deniedCount++;
          if (denials.length < MAX_DENIALS) {
            const begun = typeof data.toolCallId === 'string' ? started.get(data.toolCallId) : undefined;
            const name = typeof data.toolName === 'string' && data.toolName ? data.toolName : begun?.toolName;
            const tool = typeof name === 'string' && name ? name : 'tool';
            const own = targetOf(data);
            denials.push({
              action: cutChars(maskLine(tool).text, DETAIL_CHARS),
              detail: cutChars(maskLine(own || targetOf({ arguments: begun?.arguments })).text, DETAIL_CHARS),
            });
          }
        } else if (event.type === 'tool.execution_start') {
          ignoredLines++; // counted as unread, but remembered so a later denial can name its tool
          if (typeof data?.toolCallId === 'string' && started.size < MAX_STARTED) {
            started.set(data.toolCallId, { toolName: data.toolName, arguments: data.arguments });
          }
        } else if (event.type === 'result' && Number.isInteger(event.exitCode)) {
          exitCode = event.exitCode;
          const input = tokenCount(event.usage, 'inputTokens', 'input_tokens');
          const output = tokenCount(event.usage, 'outputTokens', 'output_tokens');
          usage = input !== null && output !== null ? { tokens: input + output } : null;
        } else {
          ignoredLines++;
        }
      } catch {
        ignoredLines++; // no input makes a parser throw
      }
    },
    end(): Report {
      let status: Report['status'];
      let reason: string | null = null;
      let summary: string | null = null;
      if (deniedCount > 0) status = 'denied';
      else if (oversizeJson) { status = 'unparsed'; reason = 'oversize-line'; }
      else if (spawnObserved) { status = 'failure'; reason = 'spawn-observed'; }
      else if (exitCode !== null && exitCode !== 0) { status = 'failure'; summary = final; }
      else if (exitCode === 0 && final !== null) { status = 'success'; summary = final; }
      else if (exitCode === 0) { status = 'unparsed'; reason = 'no-final-message'; }
      else { status = 'unparsed'; reason = 'no-result-event'; }
      return { parser: ID, status, reason, summary, denials: denials.slice(), deniedCount, usage, ignoredLines };
    },
  };
}

module.exports = { ID, create };
