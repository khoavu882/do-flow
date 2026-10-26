'use strict';

/**
 * 093 V.4 (IC-022): Claude Code reader. `~/.claude/projects/<cwd>/<sessionId>.jsonl`, and a sub-agent's
 * `<sessionId>/subagents/agent-<id>.jsonl` with its `.meta.json` (R§3). Whitelist: `assistant` records
 * (`message.content[]` `text` and `tool_use`, `message.usage`), `user` records' `tool_result` blocks.
 * Thinking, user prompts, attachments, system and every other type are counted, never read. Usage is
 * deduplicated by `message.id` (the same usage repeats on every line of one message).
 */

const { readTranscript, headRecords, readJsonFile, label, sizeOf, tokens } = require('../cursor.ts');

const REQUIRED_KEYS = ['type', 'timestamp', 'sessionId'];

function blocksOf(content: any): any[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

const SPEC = {
  id: 'claude-jsonl',
  requiredKeys: REQUIRED_KEYS,
  init: () => ({ seen: new Set<string>() }),
  parse(rec: any, ctx: any): { events: any[]; other: number } {
    const events: any[] = [];
    let other = 0;
    const msg = rec.message && typeof rec.message === 'object' ? rec.message : null;
    if (rec.type === 'assistant' && msg) {
      for (const b of blocksOf(msg.content)) {
        if (b && b.type === 'text' && typeof b.text === 'string') events.push(ctx.event('reply', rec.timestamp, { model: msg.model, text: b.text }));
        else if (b && b.type === 'tool_use') {
          ctx.noteCall(b.id, rec.timestamp, b.name);
          events.push(ctx.event('tool-call', rec.timestamp, { model: msg.model, tool: ctx.tool(b.name, b.id), args: b.input }));
        } else other += 1; // thinking and anything else
      }
      const first = typeof msg.id !== 'string' || !ctx.state.seen.has(msg.id);
      if (msg.usage && typeof msg.usage === 'object' && first) {
        if (typeof msg.id === 'string') ctx.state.seen.add(msg.id);
        const t = tokens({
          input: msg.usage.input_tokens, output: msg.usage.output_tokens,
          cacheRead: msg.usage.cache_read_input_tokens, cacheWrite: msg.usage.cache_creation_input_tokens,
        });
        if (t) events.push(ctx.event('usage', rec.timestamp, { model: msg.model, tokens: t }));
      }
    } else if (rec.type === 'user' && msg) {
      for (const b of blocksOf(msg.content)) {
        if (b && b.type === 'tool_result') {
          const call = ctx.callOf(b.tool_use_id);
          events.push(ctx.event('tool-result', rec.timestamp, {
            tool: ctx.tool(call && call.name, b.tool_use_id, {
              status: b.is_error === true ? 'error' : b.is_error === false ? 'ok' : null,
              bytes: sizeOf(b.content), durationMs: ctx.durationOf(b.tool_use_id, rec.timestamp),
            }),
          }));
        } else other += 1; // the user's own text
      }
    } else other = 1;
    return { events, other };
  },
};

/** Header facts of a main or sub-agent file; `sessionId` and `cwd` are for core only, never printed. */
function header({ file, metaFile }: { file: string; metaFile?: string }): any {
  const first = headRecords(file).find((r: any) => typeof r.sessionId === 'string') || {};
  const meta = readJsonFile(metaFile ?? file.replace(/\.jsonl$/, '.meta.json')) || {};
  return {
    sessionId: first.sessionId ?? null, agentId: typeof first.agentId === 'string' ? first.agentId : null,
    cwd: typeof first.cwd === 'string' ? first.cwd : null, parentSessionId: null,
    label: label(meta.agentType), depth: Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : null, model: label(meta.model),
    children: [],
  };
}

module.exports = { id: 'claude-jsonl', REQUIRED_KEYS, read: (opts: any) => readTranscript(SPEC, opts), header };
