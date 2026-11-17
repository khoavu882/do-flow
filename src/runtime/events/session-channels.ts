'use strict';

// Row 170 (design IC-004, D7, D9, section 7, R-9): the `channels` section of `layers:<pk>`, derived from the project's
// `started-sessions.json`: for each started main session, whether it has a control channel, whose turn it is and the
// newest messages sent. The supervisor writes the facts (`channel.turn`, `channel.sent`, `channel.ledger`, IC-002); this
// module only reads them, and the one thing it adds is what a record cannot say about itself: a run that has not ended
// whose supervisor is gone (R-9), which reads `not observed`, `supervisor-gone`, channel or not.
//
// No text field exists in the record and none is copied: an item holds counts, kinds, actors, times and outcomes only.
// Ceilings: 16 items (open first, newest first), 8 `recent` each. Liveness (`ps`) is read for an open run at most once per
// LIVENESS_TTL_MS (the 5 s derived pass refreshes it; a store change between two passes reuses it), and for at most
// LIVENESS_READS runs per call; a run beyond that waits for the next call (the longest unread first) and meanwhile keeps its last reading or, with none, is not called dead.

const { storeFileFor, readRuns } = require('../worker/run-store.ts');
const { liveness, namingScan, STARTED_SLUG, KIND } = require('../worker/start-session.ts');
const { sha16 } = require('../scaffold/fingerprint.ts');

const ITEMS = 16;
const RECENT = 8;
/** A reading is reused while younger than this: under the detector's 5 s derived pass, so each pass reads afresh. */
const LIVENESS_TTL_MS = 4500;
/** The machine limit on open started sessions (165 P-4), the most `ps` reads one call makes. */
const LIVENESS_READS = 4;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const KINDS = ['first', 'follow-up', 'steer', 'stop'];
const OUTCOMES = ['written', 'refused', 'failed'];
const ANSWERS = ['accepted', 'refused'];
const CHANNEL_STATES: Record<string, 'open' | 'closed'> = { opening: 'open', open: 'open', closed: 'closed' };
const ACTOR_CHARS = 64;

type Turn = { observed: true; state: 'working' | 'waiting'; since: string; seq: number } | { observed: false; reason: string; since: string | null };
type Reading = { state: string; at: number; sig: string };

const isoOf = (value: unknown): string | null => (typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) ? value : null);
const count = (value: unknown): number => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0);
const gone = (reason: string, since: string | null = null): Turn => ({ observed: false, reason, since });
const byCreatedDesc = (a: any, b: any): number => Date.parse(b.createdAt) - Date.parse(a.createdAt) || 0;

/** The record's `channel.turn` as a Turn, or `no-event-yet` for a shape that is not one (nothing is inferred). */
function turnOf(value: any): Turn {
  if (value && value.observed === true && (value.state === 'working' || value.state === 'waiting') && isoOf(value.since) !== null && Number.isInteger(value.seq)) {
    return { observed: true, state: value.state, since: value.since, seq: value.seq };
  }
  if (value && value.observed === false && typeof value.reason === 'string' && value.reason !== '') return gone(value.reason.slice(0, 64), isoOf(value.since));
  return gone('no-event-yet');
}

/** The newest RECENT ledger entries, newest first, with the closed field set (the text a message carried is never in the record). */
function recentOf(ledger: unknown): any[] {
  const out: any[] = [];
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    const at = isoOf(entry?.at);
    if (!Number.isInteger(entry?.seq) || !KINDS.includes(entry.kind) || typeof entry.by !== 'string' || at === null || !OUTCOMES.includes(entry.outcome)) continue;
    out.push({ seq: entry.seq, kind: entry.kind, by: entry.by.slice(0, ACTOR_CHARS), at, bytes: count(entry.bytes), outcome: entry.outcome, answer: ANSWERS.includes(entry.answer) ? entry.answer : null });
  }
  return out.slice(-RECENT).reverse();
}

/** One item of IC-004 from a run record and the supervisor liveness read for it (`null` when none was read). */
function itemOf(run: any, alive: string | null): any {
  const channel = run.channel && typeof run.channel === 'object' ? run.channel : null;
  const state = channel ? CHANNEL_STATES[channel.state] : undefined;
  const ended = run.phase === 'ended';
  let turn: Turn;
  if (ended) turn = gone('run-ended', isoOf(run.end?.at));
  else if (alive === 'dead') turn = gone('supervisor-gone');
  else if (!channel || state === undefined) turn = gone('started-without-channel');
  else if (state === 'closed') turn = gone('channel-closed');
  else turn = turnOf(channel.turn);
  const sent = channel?.sent;
  return {
    runId: run.runId,
    agentKey: sha16(`worker:${run.runId}`), // as the start reply's run and the tree name it
    harness: typeof run.harness === 'string' ? run.harness : null,
    channel: state ?? 'none',
    reason: !channel || state === undefined ? 'started-without-channel'
      : state === 'closed' ? (typeof channel.closedReason === 'string' ? channel.closedReason.slice(0, 64) : null)
        : channel.state === 'opening' ? 'opening' : null,
    turn,
    sent: { count: count(sent?.count), lastAt: isoOf(sent?.lastAt) },
    recent: recentOf(channel?.ledger),
  };
}

/**
 * The `channels` section body for the started-sessions store of `root`: `{ v: 1, items }`. `cache` (a Map owned by the caller,
 * one per layers channel) holds the liveness readings between calls. A store that cannot be read throws (the caller answers
 * a failed section).
 */
function channelsBody({ root, now, platform = process.platform, cache, fsImpl }: { root: string; now: number; platform?: string; cache: Map<string, Reading>; fsImpl?: any }): any {
  const runs = (Object.values(readRuns(storeFileFor(root, STARTED_SLUG), fsImpl)) as any[]).filter((run) => run && run.kind === KIND && typeof run.runId === 'string');
  const open = runs.filter((run) => run.phase !== 'ended').sort(byCreatedDesc);
  const closed = runs.filter((run) => run.phase === 'ended').sort(byCreatedDesc);
  const shown = [...open, ...closed].slice(0, ITEMS);
  const sigOf = (run: any): string => JSON.stringify([run.supervisor?.pid ?? null, run.worker?.pid ?? null]);
  const fresh = (run: any): Reading | null => {
    const held = cache.get(run.runId);
    return held && held.sig === sigOf(run) && now - held.at < LIVENESS_TTL_MS ? held : null;
  };
  // The runs with no usable reading, the longest unread first, so a project with more open runs than the cap still reads each in turn.
  const due = shown.filter((run) => run.phase !== 'ended' && fresh(run) === null)
    .sort((a, b) => (cache.get(a.runId)?.at ?? 0) - (cache.get(b.runId)?.at ?? 0)).slice(0, LIVENESS_READS);
  if (due.length > 0) {
    const named = namingScan(platform);
    for (const run of due) cache.set(run.runId, { state: liveness(run, platform, now, named), at: now, sig: sigOf(run) });
  }
  const items = shown.map((run) => {
    const held = run.phase === 'ended' ? undefined : cache.get(run.runId);
    return itemOf(run, held && held.sig === sigOf(run) ? held.state : null);
  });
  const shownOpen = new Set(shown.filter((run) => run.phase !== 'ended').map((run) => run.runId));
  for (const id of [...cache.keys()]) if (!shownOpen.has(id)) cache.delete(id);
  return { v: 1, items };
}

module.exports = { channelsBody, ITEMS, RECENT, LIVENESS_TTL_MS, LIVENESS_READS };
