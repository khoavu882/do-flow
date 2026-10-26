'use strict';

/**
 * 093 V.4 (IC-022): Codex reader. `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, lines
 * `{timestamp, type, payload}` (R§3). Whitelist: `turn_context` (model), `response_item` assistant
 * `message`, `function_call`, `custom_tool_call` and their outputs, `event_msg` `token_count` (per-call
 * `last_token_usage`) and `agent_message`. Reasoning, user and developer messages, `session_meta` and every
 * other type are counted, never read. Codex writes a reply as both a message item and an `agent_message`;
 * an identical reply straight after another is skipped.
 */

const { readTranscript, headRecords, label, sizeOf, tokens } = require('../cursor.ts');

const REQUIRED_KEYS = ['timestamp', 'type', 'payload'];

const SPEC = {
  id: 'codex-rollout',
  requiredKeys: REQUIRED_KEYS,
  init: () => ({ model: null, lastReply: null }),
  parse(rec: any, ctx: any): { events: any[]; other: number } {
    const events: any[] = [];
    let other = 0;
    const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
    const reply = (text: any) => {
      if (typeof text !== 'string' || text === ctx.state.lastReply) { other += 1; return; }
      ctx.state.lastReply = text;
      events.push(ctx.event('reply', rec.timestamp, { text }));
    };
    if (rec.type === 'turn_context' && typeof p.model === 'string') {
      ctx.state.model = p.model;
      events.push(ctx.event('model-change', rec.timestamp, { model: p.model }));
    } else if (rec.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      for (const c of Array.isArray(p.content) ? p.content : []) {
        if (c && c.type === 'output_text') reply(c.text);
        else other += 1;
      }
    } else if (rec.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      ctx.noteCall(p.call_id, rec.timestamp, p.name);
      events.push(ctx.event('tool-call', rec.timestamp, { tool: ctx.tool(p.name, p.call_id), args: p.type === 'function_call' ? p.arguments : p.input }));
    } else if (rec.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      const call = ctx.callOf(p.call_id);
      events.push(ctx.event('tool-result', rec.timestamp, {
        tool: ctx.tool(call && call.name, p.call_id, { bytes: sizeOf(p.output), durationMs: ctx.durationOf(p.call_id, rec.timestamp) }),
      }));
    } else if (rec.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage) {
      const u = p.info.last_token_usage;
      const t = tokens({ input: u.input_tokens, output: u.output_tokens, cacheRead: u.cached_input_tokens, cacheWrite: u.cache_write_input_tokens, reasoning: u.reasoning_output_tokens });
      if (t) events.push(ctx.event('usage', rec.timestamp, { tokens: t }));
      else other = 1;
    } else if (rec.type === 'event_msg' && p.type === 'agent_message') reply(p.message);
    else other = 1;
    if (events.length === 0 && other === 0) other = 1;
    return { events, other };
  },
};

/** Header facts from `session_meta`; `sessionId` and `cwd` are for core only. A sub-agent's `source` names its parent thread. */
function header({ file }: { file: string }): any {
  const meta = headRecords(file).find((r: any) => r.type === 'session_meta');
  const p = (meta && meta.payload) || {};
  const spawn = (p.source && p.source.SubAgent && p.source.SubAgent.ThreadSpawn) || null;
  return {
    sessionId: typeof p.id === 'string' ? p.id : null, agentId: null, cwd: typeof p.cwd === 'string' ? p.cwd : null,
    parentSessionId: spawn && typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id : null,
    label: spawn ? label(spawn.agent_role) : null, depth: spawn && Number.isInteger(spawn.depth) ? spawn.depth : null, model: null,
    children: [],
  };
}

module.exports = { id: 'codex-rollout', REQUIRED_KEYS, read: (opts: any) => readTranscript(SPEC, opts), header };
