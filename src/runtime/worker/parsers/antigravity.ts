'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `agy-stream-json-v1`: Antigravity `--output-format stream-json`, one JSON object per line.
 * Implements IC-002 from agent-docs/doflow/138-agy-worker-parser/design/specs.md.
 */

const { maskBody } = require('../../mask.ts');
const { SUMMARY_BYTES, cutBytes, lineText } = require('./common.ts');

import type { Denial, Report } from './common.ts';

const ID = 'agy-stream-json-v1';
const SPAWN_TOOLS = new Set(['invoke_subagent', 'define_subagent', 'manage_subagents']);

function agyEventOf(text: string): any {
  let value: any;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const eventName = typeof value.event === 'string' ? value.event : (typeof value.type === 'string' ? value.type : null);
  if (!eventName) return null;
  return value;
}

function tokenUsage(usage: any): { tokens: number } | null {
  if (!usage || typeof usage !== 'object') return null;
  if (Number.isInteger(usage.total_tokens) && usage.total_tokens >= 0) {
    return { tokens: usage.total_tokens };
  }
  const hasIn = Number.isInteger(usage.input_tokens) && usage.input_tokens >= 0;
  const hasOut = Number.isInteger(usage.output_tokens) && usage.output_tokens >= 0;
  if (hasIn || hasOut) {
    const input = hasIn ? usage.input_tokens : 0;
    const output = hasOut ? usage.output_tokens : 0;
    return { tokens: input + output };
  }
  return null;
}

function cleanFinishedReason(value: unknown): string {
  if (typeof value !== 'string') return 'finished-unknown';
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return cleaned ? `finished-${cleaned}` : 'finished-unknown';
}

function create() {
  const denials: Denial[] = [];
  const deniedCount = 0;
  let usage: { tokens: number } | null = null;
  let ignoredLines = 0;
  let oversizeJson = false;
  let spawnObserved = false;
  let sawResult = false;
  let resultStatus: string | null = null;
  let rawSummary: string | null = null;
  let finishedReason: string | null = null;

  return {
    oversize(looksJson: boolean): void {
      ignoredLines++;
      if (looksJson) oversizeJson = true;
    },
    line(text: string): void {
      const event = agyEventOf(lineText(text));
      if (!event) {
        ignoredLines++;
        return;
      }
      const eventName = typeof event.event === 'string' ? event.event : event.type;
      const step = (event.step_update && typeof event.step_update === 'object') ? event.step_update : event;

      if (eventName === 'step_update') {
        const stepType = typeof step.step_type === 'string' ? step.step_type : null;
        const toolName = typeof step.tool_name === 'string' ? step.tool_name : (typeof event.tool_name === 'string' ? event.tool_name : null);
        if (stepType === 'subagent' || (toolName && SPAWN_TOOLS.has(toolName))) {
          spawnObserved = true;
          // Spawn observed does not add to ignoredLines
        } else {
          ignoredLines++;
        }
      } else if (eventName === 'result') {
        sawResult = true;
        const res = (event.result && typeof event.result === 'object') ? event.result : event;
        resultStatus = typeof res.status === 'string' ? res.status : null;
        const responseText = typeof res.response === 'string' ? res.response : '';
        const errorText = typeof res.error === 'string' ? res.error : '';

        if (resultStatus === 'SUCCESS') {
          rawSummary = responseText;
        } else {
          rawSummary = errorText || responseText || null;
        }

        if (res.finished_reason !== undefined && res.finished_reason !== null) {
          finishedReason = cleanFinishedReason(res.finished_reason);
        } else {
          finishedReason = null;
        }

        usage = tokenUsage(res.usage);
      } else {
        ignoredLines++;
      }
    },
    end(): Report {
      let status: Report['status'];
      let reason: string | null = null;
      let summary: string | null = null;

      if (oversizeJson) {
        status = 'unparsed';
        reason = 'oversize-line';
      } else if (spawnObserved) {
        status = 'failure';
        reason = 'spawn-observed';
      } else if (finishedReason !== null) {
        status = 'failure';
        reason = finishedReason;
        if (rawSummary) summary = cutBytes(maskBody(rawSummary).text, SUMMARY_BYTES);
      } else if (!sawResult) {
        status = 'unparsed';
        reason = 'no-result-event';
      } else if (resultStatus !== 'SUCCESS') {
        status = 'failure';
        reason = null;
        if (rawSummary) summary = cutBytes(maskBody(rawSummary).text, SUMMARY_BYTES);
      } else if (typeof rawSummary === 'string' && rawSummary.trim() !== '') {
        status = 'success';
        reason = null;
        summary = cutBytes(maskBody(rawSummary).text, SUMMARY_BYTES);
      } else {
        status = 'unparsed';
        reason = 'no-final-message';
      }

      return {
        parser: ID,
        status,
        reason,
        summary,
        denials: denials.slice(),
        deniedCount,
        usage,
        ignoredLines,
      };
    },
  };
}

module.exports = { ID, create };

