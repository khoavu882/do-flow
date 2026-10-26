'use strict';

/**
 * 093 V.4 (IC-022): Kiro reader. `~/.kiro/sessions/cli/<uuid>.jsonl` (`{version, kind, data}`) with its
 * companion `<uuid>.json` (R§3). Whitelist: `AssistantMessage` (`text`, `toolUse`) and `ToolResults`.
 * Thinking, prompts, context, `Clear` and every other kind are counted, never read. The JSONL has no
 * timestamp per record, so every event has `at: null`; per-turn tokens come from the companion's
 * `user_turn_metadatas[]` as `usage` events (the cursor's `recordAtMs` is the newest turn `end_timestamp`
 * already returned, so a turn is returned once).
 */

const { readTranscript, readJsonFile, label, toMs, sizeOf, tokens } = require('../cursor.ts');

const REQUIRED_KEYS = ['version', 'kind', 'data'];
const TAIL_TURNS = 64;

function blocks(data: any): any[] {
  return Array.isArray(data && data.content) ? data.content.filter((b: any) => b && typeof b === 'object' && b.data && typeof b.data === 'object') : [];
}

const SPEC = {
  id: 'kiro-jsonl',
  requiredKeys: REQUIRED_KEYS,
  at: () => NaN, // no per-record time
  init: () => ({ model: null }),
  parse(rec: any, ctx: any): { events: any[]; other: number } {
    const events: any[] = [];
    let other = 0;
    if (rec.kind === 'AssistantMessage') {
      for (const b of blocks(rec.data)) {
        if (typeof b.data.modelId === 'string' && b.kind !== 'thinking') ctx.state.model = b.data.modelId;
        if (b.kind === 'text' && typeof b.data.text === 'string') events.push(ctx.event('reply', null, { text: b.data.text }));
        else if (b.kind === 'toolUse') {
          ctx.noteCall(b.data.toolUseId, null, b.data.name);
          events.push(ctx.event('tool-call', null, { tool: ctx.tool(b.data.name, b.data.toolUseId), args: b.data.input }));
        } else other += 1; // thinking
      }
    } else if (rec.kind === 'ToolResults') {
      for (const b of blocks(rec.data)) {
        if (b.kind !== 'toolResult') { other += 1; continue; }
        const call = ctx.callOf(b.data.toolUseId);
        const status = b.data.status === 'success' ? 'ok' : typeof b.data.status === 'string' ? 'error' : null;
        events.push(ctx.event('tool-result', null, { tool: ctx.tool(call && call.name, b.data.toolUseId, { status, bytes: sizeOf(b.data.content) }) }));
      }
    } else other = 1;
    if (events.length === 0 && other === 0) other = 1;
    return { events, other };
  },
  /** Per-turn usage from the companion `.json`, after the JSONL events. */
  extra(ctx: any, win: any, opts: any, room: number): { events: any[]; atMs: number; more: boolean } {
    const j = readJsonFile(opts.companion ?? opts.file.replace(/\.jsonl$/, '.json'));
    const turns = ((j && Array.isArray(j.user_turn_metadatas)) ? j.user_turn_metadatas : [])
      .filter((t: any) => t && typeof t === 'object')
      .map((t: any) => ({ t, ms: toMs(t.end_timestamp) }));
    const fresh = win.tail ? turns.slice(-TAIL_TURNS) : turns.filter((x: any) => !(x.ms <= win.cursor.atMs));
    const take = fresh.slice(0, Math.max(0, room));
    const events = take.map(({ t }: any) => ctx.event('usage', null, {
      model: t.model ?? (j.rts_model_state && j.rts_model_state.model_info && j.rts_model_state.model_info.model_id),
      tokens: tokens({ input: t.input_token_count, output: t.output_token_count, cacheRead: t.cache_read_token_count, cacheWrite: t.cache_write_token_count }),
    })).filter((e: any) => e.tokens !== null);
    const newest = take.map((x: any) => x.ms).filter(Number.isFinite);
    return { events, atMs: newest.length ? Math.max(...newest) : NaN, more: take.length < fresh.length };
  },
};

/** Header facts from the companion `.json`; `sessionId`, `cwd` and `parentSessionId` are for core only. */
function header({ file, companion }: { file: string; companion?: string }): any {
  const j = readJsonFile(companion ?? file.replace(/\.jsonl$/, '.json')) || {};
  const model = j.rts_model_state && j.rts_model_state.model_info && j.rts_model_state.model_info.model_id;
  return {
    sessionId: typeof j.session_id === 'string' ? j.session_id : null, agentId: null, cwd: typeof j.cwd === 'string' ? j.cwd : null,
    parentSessionId: typeof j.parent_session_id === 'string' ? j.parent_session_id : null,
    label: null, depth: null, model: label(model), children: [],
  };
}

module.exports = { id: 'kiro-jsonl', REQUIRED_KEYS, read: (opts: any) => readTranscript(SPEC, opts), header };
