'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `kiro-stream-json-v1` (IC-006): `kiro-cli chat --no-interactive --output-format stream-json`.
 * Pure, never throws, keeps only the masked final text. `runFinished` is the one terminal event;
 * a `sessionUpdate` `tool_call` whose name starts with `subagent` signals a spawn. This parser
 * reports no denial: a refused headless write has no captured event shape, and a text match on its
 * permission message is not an accepted signal (IC-006), so `deniedCount` is always 0.
 */

const { maskBody } = require('../../mask.ts');
const { SUMMARY_BYTES, cutBytes, eventOf, lineText } = require('./common.ts');

import type { Report } from './common.ts';

const ID = 'kiro-stream-json-v1';

/**
 * INFERENCE (IC-006): the probe states the `subagent_<agent>` tool naming but not where a
 * `tool_call` event carries it. Read `data.update` (ACP shape) or `data` itself, field `title`,
 * `name` or `toolName`. A live capture (IC-012) confirms or corrects this.
 */
function toolNameOf(event: any): string | null {
  const data = event.data;
  const update = data && typeof data === 'object' && data.update && typeof data.update === 'object' ? data.update : data;
  if (!update || typeof update !== 'object') return null;
  const kind = update.sessionUpdate ?? update.kind;
  if (kind !== 'tool_call') return null;
  for (const key of ['title', 'name', 'toolName']) {
    if (typeof update[key] === 'string') return update[key];
  }
  return null;
}

/** The masked, cut summary; masked first and cut second so a cut never exposes a secret prefix. */
function summaryOf(text: string): string {
  return cutBytes(maskBody(text).text, SUMMARY_BYTES);
}

function create() {
  let ignoredLines = 0;
  let oversizeJson = false;
  let spawnObserved = false;
  // The last readable `runFinished`; `summary` is already masked and cut, the raw text is not kept.
  let finished: { status: string; stopReason: unknown; summary: string | null } | null = null;

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
        if (event.type === 'runFinished' && event.data && typeof event.data.status === 'string') {
          const finalText = event.data.finalText;
          finished = {
            status: event.data.status,
            stopReason: event.data.stopReason,
            summary: typeof finalText === 'string' && finalText.trim() !== '' ? summaryOf(finalText) : null,
          };
        } else if (event.type === 'sessionUpdate' && /^\s*subagent/i.test(toolNameOf(event) ?? '')) {
          spawnObserved = true;
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
      let summary: string | null = null;
      if (oversizeJson) { status = 'unparsed'; reason = 'oversize-line'; }
      else if (spawnObserved) { status = 'failure'; reason = 'spawn-observed'; }
      else if (finished === null) { status = 'unparsed'; reason = 'no-run-finished'; }
      else if (finished.status === 'success' && finished.stopReason === 'end_turn') {
        if (finished.summary !== null) { status = 'success'; summary = finished.summary; }
        else { status = 'unparsed'; reason = 'no-final-message'; }
      } else {
        // Any other status, or a success that did not stop on end_turn (cut off), fails closed.
        status = 'failure';
        summary = finished.summary;
      }
      return { parser: ID, status, reason, summary, denials: [], deniedCount: 0, usage: null, ignoredLines };
    },
  };
}

module.exports = { ID, create };
