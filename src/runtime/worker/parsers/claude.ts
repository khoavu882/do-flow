'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `claude-stream-json-v1` (IC-003): `claude -p … --output-format stream-json --verbose`, one JSON
 * object per line. Pure, never throws, keeps only the masked summary and masked denial fields.
 * `result` is the one terminal event; `assistant` tool_use blocks and `subagent_stats` signal a spawn.
 */

const { maskLine, maskBody } = require('../../mask.ts');
const { MAX_DENIALS, DETAIL_CHARS, SUMMARY_BYTES, cutBytes, cutChars, eventOf, lineText } = require('./common.ts');

import type { Denial, Report } from './common.ts';

const ID = 'claude-stream-json-v1';
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** The masked, cut summary text; masked first and cut second so a cut never exposes a secret prefix. */
function summaryOf(text: string): string | null {
  return text.trim() === '' ? null : cutBytes(maskBody(text).text, SUMMARY_BYTES);
}

/** The target of a denied tool call: `tool_input.file_path`, else `tool_input.command`, else empty. */
function targetOf(entry: any): string {
  const input = entry?.tool_input;
  if (typeof input?.file_path === 'string') return input.file_path;
  if (typeof input?.command === 'string') return input.command;
  return '';
}

function create() {
  const denials: Denial[] = [];
  let deniedCount = 0;
  let usage: { tokens: number } | null = null;
  let ignoredLines = 0;
  let oversizeJson = false;
  let spawnObserved = false;
  let terminal: 'success' | 'failure' | null = null;
  let summary: string | null = null; // already masked and cut; the raw text is never kept

  function readResult(event: any): void {
    const ok = event.subtype === 'success' && event.is_error === false;
    terminal = ok ? 'success' : 'failure';
    summary = typeof event.result === 'string' ? summaryOf(event.result) : null;
    const reported = event.usage;
    usage = isCount(reported?.input_tokens) && isCount(reported?.output_tokens)
      ? { tokens: reported.input_tokens + reported.output_tokens }
      : null;
    if (typeof event.subagent_stats?.spawned === 'number' && event.subagent_stats.spawned > 0) spawnObserved = true;
    if (Array.isArray(event.permission_denials)) {
      for (const entry of event.permission_denials) {
        deniedCount++;
        if (denials.length < MAX_DENIALS) {
          const action = typeof entry?.tool_name === 'string' ? entry.tool_name : 'unknown';
          denials.push({ action: cutChars(maskLine(action).text, DETAIL_CHARS), detail: cutChars(maskLine(targetOf(entry)).text, DETAIL_CHARS) });
        }
      }
    }
  }

  return {
    oversize(looksJson: boolean): void {
      ignoredLines++;
      if (looksJson) oversizeJson = true;
    },
    line(text: string): void {
      try {
        const event = eventOf(lineText(text));
        if (event && event.type === 'result') {
          readResult(event);
        } else if (event && event.type === 'assistant' && Array.isArray(event.message?.content)) {
          const spawned = event.message.content.some((block: any) => block?.type === 'tool_use' && SPAWN_TOOLS.has(block.name));
          if (spawned) spawnObserved = true;
          else ignoredLines++;
        } else {
          ignoredLines++;
        }
      } catch {
        ignoredLines++;
      }
    },
    end(): Report {
      let status: Report['status'];
      let reason: string | null = null;
      let reported: string | null = null;
      if (deniedCount > 0) status = 'denied';
      else if (oversizeJson) { status = 'unparsed'; reason = 'oversize-line'; }
      else if (spawnObserved) { status = 'failure'; reason = 'spawn-observed'; }
      else if (terminal === 'failure') { status = 'failure'; reported = summary; }
      else if (terminal === 'success' && summary !== null) { status = 'success'; reported = summary; }
      else if (terminal === 'success') { status = 'unparsed'; reason = 'no-final-message'; }
      else { status = 'unparsed'; reason = 'no-result-event'; }
      return { parser: ID, status, reason, summary: reported, denials: denials.slice(), deniedCount, usage, ignoredLines };
    },
  };
}

module.exports = { ID, create };
