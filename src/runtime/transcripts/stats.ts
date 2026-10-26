'use strict';

/**
 * `transcript --action stats` (093 IC-023): traffic over the last window and who works with whom, for one
 * project. The agents are `buildTree`'s nodes (newest first, at most 32; the rest counted in `notChecked`).
 * A linked transcript is read in metadata mode (no text, no arguments), at most its last 256 KiB, in pages.
 * An event without a time (Kiro keeps none per record) takes the transcript's newest known time, which for
 * Kiro is the newest turn `end_timestamp`; if there is none, the window is unknown and the counts are null.
 * Unknown is never zero: a harness that does not record a value gives null, and an agent with no readable
 * transcript gives null everywhere. Zero is reported only for a transcript that was read and held nothing.
 * `pairs` says who works with whom: equal model id (`same-model`), active attempts or running worker runs on
 * one task id (`same-task`, `task`), and a plan `overlaps` pair held by two agents (`overlap`, `tasks`).
 * Nothing is written; no path, pid or raw session id is printed.
 */

const fs = require('node:fs');
const { buildTree, READERS } = require('../fleet/tree.ts');
const { loadPlan } = require('../task-attempts.ts');
const { overlaps } = require('../task-graph.ts');
const { parseCursor, toMs } = require('./cursor.ts');
const { inCheckouts, checkoutRoots, registryById } = require('./read.ts');

const DEFAULT_WINDOW = 10;
const MAX_AGENTS = 32;
const MAX_PAGES = 8;
const TAIL_RECORDS = 4096;
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

/** Sums of the fields any event recorded; a field no event recorded stays null, and none at all is null. */
function sumTokens(list: any[]): any {
  const out: Record<string, number | null> = {};
  for (const field of TOKEN_FIELDS) {
    const values = list.map((t) => t[field]).filter((v) => Number.isFinite(v));
    out[field] = values.length ? values.reduce((a, b) => a + b, 0) : null;
  }
  return Object.values(out).some((v) => v !== null) ? out : null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Every event of the transcript's window, in pages, with the newest time the reader knew. */
function readWindow(mod: any, node: any, internal: any): { events: any[]; clock: number } {
  const events: any[] = [];
  let cursor: string | undefined;
  let clock = NaN;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = mod.read({ file: internal.file, companion: internal.companion, mode: 'metadata', cursor, limit: 500, tailRecords: TAIL_RECORDS, agentKey: node.agentKey });
    events.push(...r.events);
    const c = parseCursor(r.cursor);
    clock = c && c.atMs > 0 ? c.atMs : clock;
    cursor = r.cursor;
    if (r.eof) break;
  }
  return { events, clock };
}

/** The per-agent numbers of the events at or after `startMs`. */
function summarize(events: any[], clock: number, startMs: number, windowMin: number): any {
  if (events.length === 0) {
    return { eventsPerMin: 0, toolCalls: 0, toolErrors: 0, toolDurationMs: null, tokens: null };
  }
  const timed = events.map((e) => ({ e, t: Number.isFinite(toMs(e.at)) ? toMs(e.at) : clock })).filter((x) => Number.isFinite(x.t));
  if (timed.length === 0) return { eventsPerMin: null, toolCalls: null, toolErrors: null, toolDurationMs: null, tokens: null };
  const inWindow = timed.filter((x) => x.t >= startMs).map((x) => x.e);
  const results = inWindow.filter((e) => e.kind === 'tool-result');
  const known = results.filter((e) => e.tool && e.tool.status !== null && e.tool.status !== undefined);
  const durations = results.map((e) => e.tool && e.tool.durationMs).filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  const usage = inWindow.filter((e) => e.kind === 'usage' && e.tokens).map((e) => e.tokens);
  return {
    eventsPerMin: round2(inWindow.length / windowMin),
    toolCalls: inWindow.filter((e) => e.kind === 'tool-call').length,
    toolErrors: results.length > 0 && known.length === 0 ? null : known.filter((e) => e.tool.status === 'error').length,
    toolDurationMs: durations.length ? { p50: durations[Math.ceil(durations.length / 2) - 1], max: durations[durations.length - 1], n: durations.length } : null,
    tokens: sumTokens(usage),
  };
}

function groupModels(agents: any[]): any[] {
  const byModel = new Map<string, any[]>();
  for (const a of agents) if (a.model !== null) byModel.set(a.model, [...(byModel.get(a.model) ?? []), a]);
  const sum = (list: any[], key: string): number | null => {
    const values = list.map((a) => a[key]).filter((v) => v !== null);
    return values.length ? round2(values.reduce((x, y) => x + y, 0)) : null;
  };
  return [...byModel.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([model, list]) => ({
    model, agents: list.length, eventsPerMin: sum(list, 'eventsPerMin'), toolCalls: sum(list, 'toolCalls'), tokens: sumTokens(list.map((a) => a.tokens).filter(Boolean)),
  }));
}

function pairsOf(agents: any[], holds: Map<string, any[]>, planOverlaps: (slug: string) => any[]): any[] {
  const out = new Map<string, any>();
  const add = (a: string, b: string, basis: string, task: string | null, tasks: string[] | null): void => {
    out.set(`${a}|${b}|${basis}|${task ?? ''}|${(tasks ?? []).join(',')}`, { a, b, basis, task, tasks });
  };
  const sorted = [...agents].sort((x, y) => (x.agentKey < y.agentKey ? -1 : 1));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const [x, y] = [sorted[i], sorted[j]];
      if (x.model !== null && x.model === y.model) add(x.agentKey, y.agentKey, 'same-model', null, null);
      const [hx, hy] = [holds.get(x.agentKey) ?? [], holds.get(y.agentKey) ?? []];
      for (const h of hx) {
        if (hy.some((g) => g.slug === h.slug && g.task === h.task)) add(x.agentKey, y.agentKey, 'same-task', h.task, null);
        for (const pair of planOverlaps(h.slug)) {
          const other = pair.a === h.task ? pair.b : pair.b === h.task ? pair.a : null;
          if (other !== null && hy.some((g) => g.slug === h.slug && g.task === other)) add(x.agentKey, y.agentKey, 'overlap', null, [h.task, other]);
        }
      }
    }
  }
  return [...out.values()].sort((p, q) => (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : p.b > q.b ? 1 : p.basis < q.basis ? -1 : p.basis > q.basis ? 1 : String(p.task ?? p.tasks).localeCompare(String(q.task ?? q.tasks))));
}

function computeStats({
  env = process.env, cwd = process.cwd(), windowMin = DEFAULT_WINDOW, exec, alive, fsImpl = fs, platform, home, now = Date.now,
}: any = {}): any {
  const built = buildTree({ env, cwd, ...(exec ? { exec } : {}), ...(alive ? { alive } : {}), ...(fsImpl !== fs ? { fsImpl } : {}), ...(platform ? { platform } : {}), ...(home ? { home } : {}) });
  if (!built.ok) return { ok: false, error: built.error };
  const registry = registryById();
  const roots = checkoutRoots({ cwd, exec, fsImpl });
  const startMs = now() - windowMin * 60000;
  const ranked = [...built.body.nodes].sort((a: any, b: any) => (a.lastRecordAt === b.lastRecordAt ? 0 : a.lastRecordAt === null ? 1 : b.lastRecordAt === null ? -1 : a.lastRecordAt < b.lastRecordAt ? 1 : -1) || (a.agentKey < b.agentKey ? -1 : 1));
  const chosen = ranked.slice(0, MAX_AGENTS);

  const holds = new Map<string, any[]>();
  const agents = chosen.map((node: any) => {
    const internal = built.internal.get(node.agentKey) ?? {};
    holds.set(node.agentKey, internal.holds ?? []);
    let numbers: any = { eventsPerMin: null, toolCalls: null, toolErrors: null, toolDurationMs: null, tokens: null };
    if (node.transcript.linked && internal.file) {
      try {
        const mod = READERS[registry[node.harness].reader]();
        const header = mod.header({ file: internal.file, companion: internal.companion });
        if (inCheckouts(header.cwd, roots, fsImpl)) {
          const { events, clock } = readWindow(mod, node, internal);
          numbers = summarize(events, clock, startMs, windowMin);
        }
      } catch { /* an unreadable transcript is unknown, not zero */ }
    }
    return { agentKey: node.agentKey, harness: node.harness, model: node.model, ...numbers, lastRecordAt: node.lastRecordAt };
  });

  const planCache = new Map<string, any[]>();
  const planOverlaps = (slug: string): any[] => {
    if (!planCache.has(slug)) {
      let list: any[] = [];
      try { list = overlaps(loadPlan({ roots, slug, fsImpl }).graph); } catch { /* no readable plan: no overlap pairs */ }
      planCache.set(slug, list);
    }
    return planCache.get(slug) as any[];
  };

  return {
    ok: true,
    body: {
      v: 1, projectKey: built.body.projectKey, windowMin, agents, models: groupModels(agents),
      pairs: pairsOf(agents, holds, planOverlaps), notChecked: Math.max(0, ranked.length - MAX_AGENTS),
    },
  };
}

module.exports = { computeStats, DEFAULT_WINDOW, MAX_AGENTS };
