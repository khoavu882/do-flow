'use strict';

// Feature 161 T5 (IC-005; FR-009, NFR-001): the `transcript:<pk>:<ak>` lane of `doflow events --follow`:
// one agent's transcript as a snapshot of the transcript read body and appended events.
//
// The agent is resolved with `resolveAgent` (src/runtime/transcripts/read.ts) on the project index's
// main checkout, once when the lane is made and again when the last resolution is RESOLVE_MS old (the
// detector's 30 s pass always finds it so); every read is `readResolved(resolved, cursor, 200)`, so the
// reader's own bounds hold (200 events, 256 KiB of file per read, text masked then cut). No path, pid or
// raw session id is in a frame: the body is the verb's, and the writer masks every string leaf again.
//
//   gone         the project is not in the index, or the agent left the project's tree
//   snapshot     the read body at first, after an error, after `reset`; an agent whose session belongs to
//                another project (`session-not-in-project`) gets one with `transcript.linked` false and
//                that reason, no events
//   reset        `replaced`, then a snapshot, when the reader rejects the cursor (another inode or a shorter file)
//   append       `{events, cursor, eof, masked, warnings}` for the events past the cursor, at most
//                CATCHUP_FRAMES reads per recompute and then a re-mark
//
// The cursor lives in this lane: a new child (a restart) reads a fresh snapshot, so its appends continue
// from that snapshot's cursor and no event is in both. The transcript file is the detector's one tail
// while it changed in the last TAIL_ACTIVE_MS. Read-only: no file is written or locked, and the tree
// build runs no git process (the project index replays its checkout list).

const { resolveAgent, readResolved } = require('../transcripts/read.ts');
const { clearCheckoutCache, listCheckouts } = require('../checkouts.ts');
const { CATCHUP_FRAMES } = require('./logs.ts');
const { TAIL_ACTIVE_MS, RESOLVE_MS } = require('./files.ts');

/** The events one read returns at most (IC-005). */
const READ_LIMIT = 200;

type TranscriptChannel = { kind: 'transcript'; name: string; projectKey: string; agentKey: string };
type Resolution = 'ok' | 'gone' | 'unlinked' | 'failed';
interface LaneStep { lines: string[]; gone?: true; again?: number | null }

interface TranscriptLaneOptions {
  channel: TranscriptChannel;
  /** The channel context of the events command: `index` is the child's project index. */
  ctx: { cwd: string; env?: Record<string, string | undefined>; index?: any; alive?: any };
  writer: any;
  fsImpl?: any;
  now?: () => number;
}

/** The snapshot body of an agent the reader refuses because its session belongs to another project. */
function unlinkedBody(agentKey: string): Record<string, unknown> {
  return {
    v: 1, agentKey, harness: null, reader: { id: null, status: 'events-only' }, transcript: { linked: false, reason: 'session-not-in-project' },
    events: [], cursor: '0:0:0:0', reset: false, eof: true, otherRecords: 0, unparsable: 0, masked: 0, warnings: [],
  };
}

/**
 * Makes the lane of one `transcript:<pk>:<ak>` channel.
 * @param {TranscriptLaneOptions} options
 */
function createTranscriptLane(options: TranscriptLaneOptions): any {
  const { channel, writer, ctx } = options;
  if (!channel || channel.kind !== 'transcript') throw new TypeError('a transcript lane needs a transcript channel');
  if (!ctx || !ctx.index) throw new TypeError('a transcript lane needs the project index');
  const index = ctx.index;
  const env = ctx.env ?? process.env;
  const fsImpl = options.fsImpl;
  const now = options.now ?? Date.now;
  const ch = channel.name;

  let resolved: any = null;
  let status: Resolution | null = null;
  let resolvedAt = -Infinity;
  let done = false;
  let failed = false;
  /** What the last snapshot said: `linked`, `unlinked`, or null while one is owed. */
  let mode: 'linked' | 'unlinked' | null = null;
  let cursor: string | undefined;

  /** One tree build and one agent lookup; the checkout list comes from the project index, not from git. */
  function resolve(): Resolution {
    resolvedAt = now();
    const entry = index.lookup(channel.projectKey);
    if (entry === null) return 'gone';
    clearCheckoutCache();
    listCheckouts({ cwd: entry.main, exec: index.replay });
    const found = resolveAgent({
      env, cwd: entry.main, agent: channel.agentKey, exec: index.replay, now: () => index.now(),
      ...(ctx.alive ? { alive: ctx.alive } : {}), ...(fsImpl ? { fsImpl } : {}),
    });
    if (found.ok) { resolved = found.resolved; return 'ok'; }
    resolved = null;
    if (found.error === 'agent-not-in-project') return 'gone';
    return found.error === 'session-not-in-project' ? 'unlinked' : 'failed';
  }

  const fileOf = (): string | null => (resolved !== null && typeof resolved.internal?.file === 'string' ? resolved.internal.file : null);

  function active(): boolean {
    const file = fileOf();
    if (file === null) return false;
    try { return now() - (fsImpl ?? require('node:fs')).statSync(file).mtimeMs < TAIL_ACTIVE_MS; } catch { return false; }
  }

  function gone(): LaneStep {
    done = true;
    return { lines: writer.gone(ch), gone: true };
  }

  function fail(): LaneStep {
    resolvedAt = -Infinity; // the next recompute resolves again
    if (failed) return { lines: [] };
    failed = true;
    mode = null;
    return { lines: writer.error(ch, 'producer-failed') };
  }

  function snapshot(body: any): string[] {
    const lines = writer.transcriptSnapshot(ch, body);
    mode = 'linked';
    cursor = body.cursor;
    return lines;
  }

  return {
    channel,

    /** The transcript file as the detector's one tail (none while the agent has no linked transcript). */
    sources() {
      if (status === null) status = resolve();
      const file = fileOf();
      return {
        directories: [], files: [], derived: [], primary: null,
        tails: file === null ? [] : [{ path: file, active: () => !done && active() }],
      };
    },

    /** Moves when a new resolution finds another file, so the command swaps the lane's tail. */
    sourcesKey: () => fileOf() ?? '',

    recompute(snapshotAsked: boolean): LaneStep {
      if (done) return { lines: [] };
      if (status === null || now() - resolvedAt >= RESOLVE_MS) status = resolve();
      if (status === 'gone') return gone();
      if (status === 'failed') return fail();
      const owe = snapshotAsked || mode === null || writer.needsSnapshot(ch);
      if (status === 'unlinked') {
        if (mode === 'unlinked' && !owe) return { lines: [] };
        failed = false;
        mode = 'unlinked';
        cursor = undefined;
        return { lines: writer.transcriptSnapshot(ch, unlinkedBody(channel.agentKey)) };
      }
      const lines: string[] = [];
      let from: string | undefined = owe || mode !== 'linked' ? undefined : cursor;
      for (let reads = 1; ; reads += 1) {
        let body: any;
        try {
          body = readResolved(resolved, from, READ_LIMIT).body;
        } catch {
          const failure = fail();
          return { lines: [...lines, ...failure.lines] };
        }
        failed = false;
        if (from === undefined) {
          lines.push(...snapshot(body));
        } else if (body.reset) {
          lines.push(...writer.reset(ch, 'replaced'), ...snapshot(body));
        } else {
          if (body.events.length > 0) {
            lines.push(...writer.transcriptAppend(ch, { events: body.events, cursor: body.cursor, eof: body.eof, masked: body.masked, warnings: body.warnings }));
            if (writer.needsSnapshot(ch)) { // `reset` `frame-cap`: the next recompute snapshots
              mode = null;
              return { lines, again: 0 };
            }
          }
          cursor = body.cursor;
        }
        if (body.eof) return { lines };
        if (reads >= CATCHUP_FRAMES) return { lines, again: 0 };
        from = cursor;
      }
    },

    end(): void {
      done = true;
    },
  };
}

module.exports = { createTranscriptLane, READ_LIMIT };
