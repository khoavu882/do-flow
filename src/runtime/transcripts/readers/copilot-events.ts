'use strict';

/**
 * 093 V.4 (IC-022): GitHub Copilot CLI reader. `~/.copilot/session-state/<sessionId>/events.jsonl`, envelope
 * `{id, parentId, timestamp, type, agentId, data}` (R§3). Whitelist: `assistant.message`,
 * `tool.execution_start`, `tool.execution_complete`, `subagent.started` and the usage records. Usage is
 * cumulative per model, so each record is differenced against the previous one; the first record of a window
 * is differenced against the last usage record before the window (a negative step means the counter restarted
 * and the value itself is the step). Reasoning, encrypted content, user messages and every other type are
 * counted, never read.
 */

const { readTranscript, headRecords, label, sizeOf, tokens } = require('../cursor.ts');

const REQUIRED_KEYS = ['id', 'timestamp', 'type', 'data'];
const USAGE_TYPES = new Set(['session.usage_record', 'session.usage_checkpoint', 'session.shutdown']);
const FIELDS: Array<[string, string]> = [
  ['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cacheReadTokens'], ['cacheWrite', 'cacheWriteTokens'], ['reasoning', 'reasoningTokens'],
];

/** model -> cumulative `usage` object of one usage record. */
function metricsOf(rec: any): Array<[string, any]> {
  const mm = rec && rec.data && rec.data.modelMetrics;
  if (!mm || typeof mm !== 'object') return [];
  return Object.entries(mm).filter(([, v]: any) => v && typeof v.usage === 'object' && v.usage !== null).map(([k, v]: any) => [k, v.usage]);
}

const SPEC = {
  id: 'copilot-events',
  requiredKeys: REQUIRED_KEYS,
  init: (win: any) => {
    const base = new Map<string, any>();
    for (const text of win.prior()) {
      try {
        const rec = JSON.parse(text);
        if (rec && USAGE_TYPES.has(rec.type)) for (const [model, usage] of metricsOf(rec)) base.set(model, usage);
      } catch { /* torn line */ }
    }
    return { base, model: null };
  },
  parse(rec: any, ctx: any): { events: any[]; other: number } {
    const events: any[] = [];
    const d = rec.data && typeof rec.data === 'object' ? rec.data : {};
    let other = 0;
    if (rec.type === 'assistant.message' && typeof d.content === 'string') {
      events.push(ctx.event('reply', rec.timestamp, { model: d.model, text: d.content }));
    } else if (rec.type === 'tool.execution_start') {
      ctx.noteCall(d.toolCallId, rec.timestamp, d.toolName);
      events.push(ctx.event('tool-call', rec.timestamp, { model: d.model, tool: ctx.tool(d.toolName, d.toolCallId), args: d.arguments }));
    } else if (rec.type === 'tool.execution_complete') {
      const call = ctx.callOf(d.toolCallId);
      events.push(ctx.event('tool-result', rec.timestamp, {
        model: d.model,
        tool: ctx.tool(call && call.name, d.toolCallId, {
          status: d.success === true ? 'ok' : d.success === false ? 'error' : null, bytes: sizeOf(d.result && d.result.content),
          durationMs: ctx.durationOf(d.toolCallId, rec.timestamp),
        }),
      }));
    } else if (rec.type === 'subagent.started') {
      events.push(ctx.event('subagent-start', rec.timestamp, { model: d.model }));
    } else if (USAGE_TYPES.has(rec.type)) {
      for (const [model, cur] of metricsOf(rec)) {
        const prev = ctx.state.base.get(model) || {};
        const step = (key: string) => (Number.isFinite(cur[key]) ? cur[key] - (Number.isFinite(prev[key]) ? prev[key] : 0) : null);
        const restarted = FIELDS.some(([, key]) => (step(key) ?? 0) < 0);
        const t = tokens(Object.fromEntries(FIELDS.map(([name, key]) => [name, restarted ? cur[key] : step(key)])));
        ctx.state.base.set(model, cur);
        if (t && Object.values(t).some((v) => v)) events.push(ctx.event('usage', rec.timestamp, { model, tokens: t }));
      }
      return { events, other: 0 };
    } else other = 1;
    if (events.length === 0 && other === 0) other = 1;
    return { events, other };
  },
};

/** Header facts: `session.start` ids and the sub-agents this session started (`agentId` and its `agentName`). */
function header({ file }: { file: string }): any {
  const records = headRecords(file, 2000, 256 * 1024);
  const start = records.find((r: any) => r.type === 'session.start');
  const d = (start && start.data) || {};
  return {
    sessionId: typeof d.sessionId === 'string' ? d.sessionId : null, agentId: null,
    cwd: d.context && typeof d.context.cwd === 'string' ? d.context.cwd : null, parentSessionId: null, label: null, depth: null, model: null,
    children: records.filter((r: any) => r.type === 'subagent.started' && typeof r.agentId === 'string')
      .map((r: any) => ({ agentId: r.agentId, label: label(r.data && r.data.agentName), depth: null })),
  };
}

module.exports = { id: 'copilot-events', REQUIRED_KEYS, read: (opts: any) => readTranscript(SPEC, opts), header };
