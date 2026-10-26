'use strict';

/**
 * `transcript --action read` (093 IC-022): one agent's recent events. The agent is resolved inside core from
 * `buildTree`'s node set for the current project (a key outside it is `agent-not-in-project`); its transcript
 * file is the one the tree joined by session id, and its header `cwd` must lie in one of the project's
 * checkouts (`session-not-in-project`, R24). Text mode, so reply text and tool arguments come back masked and
 * capped by the reader. Every agent also gets `record` events, DoFlow's own records of it (worker run start and
 * end, attempt claim and end, hook records): they carry no text and make a panel non-blank whatever the reader
 * status. A read with a cursor returns only the record events newer than the cursor's `recordAtMs`; without
 * one (or after a reset) the 64 newest. Nothing is written; no path, pid or raw session id is printed.
 *
 * The cursor stays the reader's four parts. `recordSeq` also counts the record events returned, so `seq` is
 * one running sequence. `recordAtMs` is raised to the newest record event returned, so one is not returned
 * twice, except for Kiro, whose reader uses that field as its turn clock (raising it could skip a turn): a
 * Kiro record event newer than the newest turn can come back again on the next read.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildTree, READERS } = require('../fleet/tree.ts');
const { listCheckouts } = require('../checkouts.ts');
const { loadTranscriptRegistry } = require('./registry.ts');
const { parseCursor, toMs, toIso } = require('./cursor.ts');

const RECORD_EVENTS = 64;
const AGENT_KEY = /^[0-9a-f]{16}$/;

/** True when `cwd` is a checkout or lies under one. An absent cwd cannot be checked and passes (the join was by session id). */
function inCheckouts(cwd: unknown, checkouts: string[], fsImpl: any = fs): boolean {
  if (cwd === null || cwd === undefined) return true;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  let real = path.resolve(cwd);
  try { real = fsImpl.realpathSync(real); } catch { /* a cwd that is gone is compared as written */ }
  return checkouts.some((root) => {
    let r = root;
    try { r = fsImpl.realpathSync(root); } catch { /* as written */ }
    return real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
}

/** The project's non-sandbox checkouts. */
function checkoutRoots({ cwd, exec, fsImpl }: any): string[] {
  const listed = listCheckouts({ cwd, ...(exec ? { exec } : {}), ...(fsImpl ? { fsImpl } : {}) });
  return listed.ok ? listed.entries.filter((e: any) => !e.sandbox).map((e: any) => e.path) : [];
}

/** What the registry says about a node's harness: the reader id and status the body prints. */
function readerFor(registry: Record<string, any>, node: any): { id: string | null; status: string } {
  const entry = node.harness ? registry[node.harness] : null;
  if (!entry) return { id: null, status: 'events-only' };
  if (node.transcript.reason === 'no-reader' || node.transcript.reason === 'not-linked') return { id: null, status: 'events-only' };
  return { id: entry.reader, status: entry.status };
}

function registryById(): Record<string, any> {
  const loaded = loadTranscriptRegistry();
  const out: Record<string, any> = {};
  for (const entry of loaded.ok ? loaded.registry.entries : []) out[entry.harness] = entry;
  return out;
}

/** The record events of `records` newer than `sinceMs` (all when null), at most 64 newest, oldest first. */
function recordEvents(records: any[], node: any, sinceMs: number | null, firstSeq: number): any[] {
  const timed = records.map((r) => ({ r, ms: toMs(r.at) })).filter((x) => Number.isFinite(x.ms) && (sinceMs === null || x.ms > sinceMs));
  timed.sort((a, b) => a.ms - b.ms || (a.r.type < b.r.type ? -1 : 1));
  return timed.slice(-RECORD_EVENTS).map(({ r }, i) => ({
    seq: firstSeq + i, at: toIso(r.at), kind: 'record', agentKey: node.agentKey, model: null, tool: null, text: null, args: null, cut: false, tokens: null,
    record: { type: r.type, task: r.task ?? null, result: r.result ?? null },
  }));
}

function readAgent({
  env = process.env, cwd = process.cwd(), agent, cursor, limit, exec, alive, fsImpl = fs, platform, home, now,
}: any = {}): any {
  const built = buildTree({ env, cwd, ...(exec ? { exec } : {}), ...(alive ? { alive } : {}), ...(fsImpl !== fs ? { fsImpl } : {}), ...(platform ? { platform } : {}), ...(home ? { home } : {}), ...(now ? { now } : {}) });
  if (!built.ok) return { ok: false, error: built.error };
  const node = AGENT_KEY.test(agent ?? '') ? built.body.nodes.find((n: any) => n.agentKey === agent) : undefined;
  if (!node) return { ok: false, error: 'agent-not-in-project' };
  const internal = built.internal.get(node.agentKey) ?? {};
  const registry = registryById();
  const reader = readerFor(registry, node);
  let transcript = { linked: node.transcript.linked, reason: node.transcript.reason };
  let result: any = null;

  if (node.transcript.linked && internal.file) {
    const mod = READERS[registry[node.harness].reader]();
    const header = mod.header({ file: internal.file, companion: internal.companion });
    if (!inCheckouts(header.cwd, checkoutRoots({ cwd, exec, fsImpl }), fsImpl)) return { ok: false, error: 'session-not-in-project' };
    try {
      result = mod.read({ file: internal.file, companion: internal.companion, mode: 'text', cursor, limit, agentKey: node.agentKey });
    } catch (error: any) {
      if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'EACCES')) throw error;
      transcript = { linked: false, reason: 'not-found' }; // the file went away between the tree and the read
    }
  }

  const parsed = parseCursor(cursor);
  const fresh = parsed === null || (result !== null && result.reset);
  const readerEvents = result ? result.events : [];
  const firstSeq = result ? parseCursor(result.cursor).seq : parsed ? parsed.seq : 0;
  const recs = recordEvents(internal.records ?? [], node, fresh ? null : parsed.atMs, firstSeq);
  const newest = recs.length ? Math.max(...recs.map((e: any) => toMs(e.at))) : null;

  let nextCursor: string;
  if (result) {
    const c = parseCursor(result.cursor);
    const raise = registry[node.harness].reader !== 'kiro-jsonl' && newest !== null ? Math.max(c.atMs, newest) : c.atMs;
    nextCursor = `${c.ino}:${c.offset}:${c.seq + recs.length}:${raise}`;
  } else {
    const prior = parsed ? parsed.atMs : 0;
    nextCursor = `0:0:${firstSeq + recs.length}:${Math.max(prior, newest ?? 0)}`;
  }

  return {
    ok: true,
    body: {
      v: 1, agentKey: node.agentKey, harness: node.harness, reader, transcript,
      events: [...readerEvents, ...recs], cursor: nextCursor, reset: result ? result.reset : false, eof: result ? result.eof : true,
      otherRecords: result ? result.otherRecords : 0, unparsable: result ? result.unparsable : 0, masked: result ? result.masked : 0,
      warnings: result ? result.warnings : [],
    },
  };
}

module.exports = { readAgent, inCheckouts, checkoutRoots, registryById, AGENT_KEY };
