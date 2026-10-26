'use strict';

/**
 * 093 V.4 (IC-022): Pi reader. `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`, session format v3 (R§3).
 * Whitelist: `model_change`, `message` with role `assistant` (`text`, `toolCall`, `usage`) and `toolResult`.
 * Thinking, user messages, the session header, custom messages and every other type are counted, never read.
 */

const { readTranscript, headRecords, label, sizeOf, tokens } = require('../cursor.ts');

const REQUIRED_KEYS = ['type', 'timestamp'];

const SPEC = {
  id: 'pi-jsonl',
  requiredKeys: REQUIRED_KEYS,
  init: () => ({ model: null }),
  parse(rec: any, ctx: any): { events: any[]; other: number } {
    const events: any[] = [];
    let other = 0;
    const m = rec.message && typeof rec.message === 'object' ? rec.message : null;
    if (rec.type === 'model_change' && typeof rec.modelId === 'string') {
      ctx.state.model = rec.modelId;
      events.push(ctx.event('model-change', rec.timestamp, { model: rec.modelId }));
    } else if (rec.type === 'message' && m && m.role === 'assistant') {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b && b.type === 'text' && typeof b.text === 'string') events.push(ctx.event('reply', rec.timestamp, { model: m.model, text: b.text }));
        else if (b && b.type === 'toolCall') {
          ctx.noteCall(b.id, rec.timestamp, b.name);
          events.push(ctx.event('tool-call', rec.timestamp, { model: m.model, tool: ctx.tool(b.name, b.id), args: b.arguments }));
        } else other += 1; // thinking
      }
      const u = m.usage && typeof m.usage === 'object' ? m.usage : null;
      const t = u && tokens({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: u.reasoning });
      if (t) events.push(ctx.event('usage', rec.timestamp, { model: m.model, tokens: t }));
    } else if (rec.type === 'message' && m && m.role === 'toolResult') {
      events.push(ctx.event('tool-result', rec.timestamp, {
        tool: ctx.tool(m.toolName, m.toolCallId, {
          status: m.isError === true ? 'error' : m.isError === false ? 'ok' : null, bytes: sizeOf(m.content),
          durationMs: Number.isFinite(m.durationMs) ? m.durationMs : null,
        }),
      }));
    } else other = 1;
    if (events.length === 0 && other === 0) other = 1;
    return { events, other };
  },
};

/** Header facts from the `session` record; `sessionId`, `cwd` and the parent id are for core only. */
function header({ file }: { file: string }): any {
  const h = headRecords(file, 1)[0] || {};
  const parent = typeof h.parentSession === 'string' ? /_([0-9a-f-]{36})\.jsonl$/.exec(h.parentSession) : null;
  return {
    sessionId: h.type === 'session' && typeof h.id === 'string' ? h.id : null, agentId: null,
    cwd: typeof h.cwd === 'string' ? h.cwd : null, parentSessionId: parent ? parent[1] : null,
    label: label(null), depth: null, model: null, children: [],
  };
}

module.exports = { id: 'pi-jsonl', REQUIRED_KEYS, read: (opts: any) => readTranscript(SPEC, opts), header };
