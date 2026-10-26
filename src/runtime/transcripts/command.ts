'use strict';

/**
 * `doflow transcript` (093 V8): the read-only per-agent transcript verb. `--action read --agent <key>` prints
 * one agent's recent events with DoFlow's own record events (IC-022, `readAgent`); `--action stats` prints the
 * project's traffic and who works with whom (IC-023, `computeStats`). Run with `cwd` = a project. It writes
 * nothing: no state, no config home, no harness home, no upkeep.
 */

const { finishRuntime, captureCaught } = require('../cli-result.ts');

const ACTION_FLAGS: Record<string, Set<string>> = {
  read: new Set(['--action', '--agent', '--cursor', '--limit', '--json']),
  stats: new Set(['--action', '--window', '--json']),
};
const AGENT_KEY = /^[0-9a-f]{16}$/;
const CURSOR = /^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/;
const DIGITS = /^[0-9]+$/;

const dash = (value: unknown): string => (value === null || value === undefined ? '-' : String(value));

/** The text form of `read`: a header, one line per event and a footer. Text and arguments are JSON-quoted (one line each). */
function readLines(body: any): string[] {
  const lines = [
    `agent ${body.agentKey} harness ${dash(body.harness)} reader ${dash(body.reader.id)} ${body.reader.status} transcript ${body.transcript.linked ? 'linked' : body.transcript.reason}`,
  ];
  for (const e of body.events) {
    const parts = [`event ${e.seq} ${dash(e.at)} ${e.kind}`];
    if (e.model !== null) parts.push(`model ${e.model}`);
    if (e.tool) parts.push(`tool ${dash(e.tool.name)} status ${dash(e.tool.status)} bytes ${dash(e.tool.bytes)} ms ${dash(e.tool.durationMs)}`);
    if (e.text !== null) parts.push(`text ${JSON.stringify(e.text)}`);
    if (e.args !== null) parts.push(`args ${JSON.stringify(e.args)}`);
    if (e.cut) parts.push('cut');
    if (e.tokens) parts.push(`tokens in ${dash(e.tokens.input)} out ${dash(e.tokens.output)} cache-read ${dash(e.tokens.cacheRead)} cache-write ${dash(e.tokens.cacheWrite)} reasoning ${dash(e.tokens.reasoning)}`);
    if (e.record) parts.push(`record ${e.record.type} task ${dash(e.record.task)} result ${dash(e.record.result)}`);
    lines.push(parts.join(' '));
  }
  lines.push(`cursor ${body.cursor} reset ${body.reset} eof ${body.eof} other ${body.otherRecords} unparsable ${body.unparsable} masked ${body.masked} warnings ${body.warnings.join(',') || '-'}`);
  return lines;
}

/** The text form of `stats`: keys, models and counts only. */
function statsLines(body: any): string[] {
  return [
    `project ${body.projectKey} window ${body.windowMin} min`,
    ...body.agents.map((a: any) => `agent ${a.agentKey} harness ${dash(a.harness)} model ${dash(a.model)} events/min ${dash(a.eventsPerMin)} tool-calls ${dash(a.toolCalls)} tool-errors ${dash(a.toolErrors)} tool-ms ${a.toolDurationMs ? `p50 ${a.toolDurationMs.p50} max ${a.toolDurationMs.max} n ${a.toolDurationMs.n}` : '-'} tokens ${a.tokens ? `in ${dash(a.tokens.input)} out ${dash(a.tokens.output)}` : '-'} last-record ${dash(a.lastRecordAt)}`),
    ...body.models.map((m: any) => `model ${m.model} agents ${m.agents} events/min ${dash(m.eventsPerMin)} tool-calls ${dash(m.toolCalls)}`),
    ...body.pairs.map((p: any) => `pair ${p.a} ${p.b} ${p.basis}${p.task ? ` task ${p.task}` : ''}${p.tasks ? ` tasks ${p.tasks.join(',')}` : ''}`),
    `not-checked ${body.notChecked}`,
  ];
}

function handleTranscriptCommand({
  action, agent, cursor, limit, window, json = false, flags = [], env = process.env, cwd = process.cwd(), exec, alive, now, out = (line: string) => console.log(line),
}: any = {}): number {
  const usage = (message: string): number => {
    out(json ? JSON.stringify({ ok: false, error: 'usage', message }) : `doflow transcript: ${message}`);
    return finishRuntime(2);
  };
  if (action !== 'read' && action !== 'stats') return usage('action must be read or stats');
  const extra = (flags as string[]).map((flag) => flag.split('=')[0]).find((flag) => !ACTION_FLAGS[action].has(flag));
  if (extra !== undefined) return usage(`unsupported flag ${extra} for ${action}; only ${[...ACTION_FLAGS[action]].join(', ')} apply`);

  let count: number | undefined;
  let minutes: number | undefined;
  if (action === 'read') {
    if (typeof agent !== 'string' || !AGENT_KEY.test(agent)) return usage('--agent must be an agent key of 16 hex characters');
    if (cursor !== undefined && (typeof cursor !== 'string' || !CURSOR.test(cursor))) return usage('--cursor must be the cursor of an earlier read');
    if (limit !== undefined) {
      if (typeof limit !== 'string' || !DIGITS.test(limit) || Number(limit) < 1) return usage('--limit must be a whole number of 1 or more (at most 500 are returned)');
      count = Math.min(500, Number(limit));
    }
  } else if (window !== undefined) {
    if (typeof window !== 'string' || !DIGITS.test(window) || Number(window) < 1 || Number(window) > 60) return usage('--window must be a whole number of minutes, 1 to 60');
    minutes = Number(window);
  }

  try {
    const common = { env, cwd, ...(exec ? { exec } : {}), ...(alive ? { alive } : {}), ...(now ? { now } : {}) };
    const result = action === 'read'
      ? require('./read.ts').readAgent({ ...common, agent, cursor, limit: count })
      : require('./stats.ts').computeStats({ ...common, ...(minutes !== undefined ? { windowMin: minutes } : {}) });
    if (!result.ok) {
      if (json) out(JSON.stringify({ v: 1, error: result.error }));
      else console.error(`[ERROR] transcript: ${result.error}`);
      return finishRuntime(1);
    }
    if (json) out(JSON.stringify(result.body));
    else for (const line of action === 'read' ? readLines(result.body) : statsLines(result.body)) out(line);
    return finishRuntime(0);
  } catch (error: any) {
    captureCaught(error, 'transcript', 1);
    console.error(`[ERROR] transcript: ${error?.message || String(error)}`);
    return finishRuntime(1);
  }
}

module.exports = { handleTranscriptCommand };
