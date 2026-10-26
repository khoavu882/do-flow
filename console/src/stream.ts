'use strict';

// The stream route kind (IC-005, IC-025; gate-a Q6 A): `GET /api/stream` writes Server-Sent Events over
// time. A stream owns no child process: every tick is one bounded verb run through the runner (the
// `views` below), started by a timer, finished before the next of its kind starts, and abandoned (its
// result dropped) when the client has gone. Timers are read from the globals at call time, so a test
// can drive them with node:test mock timers.
//
// Opening: IC-006's headers plus `text/event-stream` and `no-store, no-transform`, `retry: 5000`, then
// `event: snapshot` (the fleet body). Ticks: every 5 s `event: fleet` with only the changed project
// sections (and the keys that left the list), every 1 s `event: transcript` for the selected agent from
// the current cursor, every 15 s a `: keepalive` comment. `id:` is `<fleetRevision>.<transcriptCursor>`;
// `Last-Event-ID` resumes both. A failed tick sends `event: error` with `{code, verb, exit}` and keeps
// the stream open; three failed ticks of one kind in a row close it. At most two open streams per
// session. Ceiling: one transcript tick reads at most one bounded page (200 events), so a stream that
// is far behind catches up at one page per second.

const { securityHeaders } = require('./headers.ts');

const RETRY_MS = 5_000;
const FLEET_MS = 5_000;
const TRANSCRIPT_MS = 1_000;
const KEEPALIVE_MS = 15_000;
const MAX_STREAMS_PER_SESSION = 2;
const MAX_FAILED_TICKS = 3;
/** A client that stops reading is dropped once this much is queued for it. */
const MAX_QUEUED_BYTES = 1024 * 1024;

type ErrorInfo = { code: string, verb: string | null, exit: number | null };
type Outcome = { ok: true, body: any } | { ok: false, error: ErrorInfo };
/** The two bounded reads a tick makes; routes.ts builds them over the runner. */
type Views = {
  fleet(): Promise<Outcome>,
  transcript(project: string, agent: string, cursor: string | null): Promise<Outcome>,
};
type Open = { project: string, agent: string | null, revision: number, cursor: string | null, release: () => void };

const CURSOR = /^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/;

/** `Last-Event-ID` is `<fleetRevision>.<transcriptCursor>`; anything else resumes nothing. */
function parseLastEventId(value: unknown): { revision: number, cursor: string | null } {
  const match = typeof value === 'string' ? /^([0-9]{1,9})\.(.*)$/.exec(value) : null;
  if (!match) return { revision: 0, cursor: null };
  return { revision: Number(match[1]), cursor: CURSOR.test(match[2]) ? match[2] : null };
}

function createStreams(views: Views) {
  const open = new Map<object, number>();

  /** A release function for one more stream of `session`, or null when it already has two. */
  function acquire(session: object): (() => void) | null {
    const count = open.get(session) ?? 0;
    if (count >= MAX_STREAMS_PER_SESSION) return null;
    open.set(session, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (open.get(session) ?? 1) - 1;
      if (left <= 0) open.delete(session);
      else open.set(session, left);
    };
  }

  function serve(req: any, res: any, params: Open): void {
    let closed = false;
    let revision = params.revision;
    let cursor = params.cursor;
    let snapshotSent = false;
    let answered = false;
    // projectKey -> the JSON last sent for that section; `rest` is the JSON of everything else in the body.
    let sent = new Map<string, string>();
    let rest: string | null = null;
    const failures = { fleet: 0, transcript: 0 };
    const busy = { fleet: false, transcript: false };
    const timers: any[] = [];

    function stop(): void {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      params.release();
      try {
        if (!res.writableEnded) res.end();
      } catch {}
    }

    function write(text: string): boolean {
      if (closed) return false;
      try {
        res.write(text);
      } catch {
        stop();
        return false;
      }
      if (typeof res.writableLength === 'number' && res.writableLength > MAX_QUEUED_BYTES) {
        stop();
        return false;
      }
      return true;
    }

    const id = () => `${revision}.${cursor ?? ''}`;
    // JSON.stringify never emits a raw newline, so one `data:` line carries the whole body.
    const event = (name: string, body: unknown, withId: boolean) =>
      write(`event: ${name}\n${withId ? `id: ${id()}\n` : ''}data: ${JSON.stringify(body)}\n\n`);

    /** Counts a failed tick of `kind`; the third in a row closes the stream. */
    function failed(kind: 'fleet' | 'transcript', error: ErrorInfo): void {
      event('error', { code: error.code, verb: error.verb, exit: error.exit }, false);
      failures[kind] += 1;
      if (failures[kind] >= MAX_FAILED_TICKS) stop();
    }

    async function fleetTick(): Promise<void> {
      if (busy.fleet || closed) return;
      busy.fleet = true;
      try {
        const out = await views.fleet();
        if (closed) return;
        if (!out.ok) return failed('fleet', out.error);
        failures.fleet = 0;
        const { projects, ...others } = out.body;
        const fresh = new Map<string, string>(projects.map((section: any) => [section.projectKey, JSON.stringify(section)]));
        const restJson = JSON.stringify(others);
        if (!snapshotSent) {
          snapshotSent = true;
          revision += 1;
          event('snapshot', out.body, true);
        } else {
          const changed = projects.filter((section: any) => sent.get(section.projectKey) !== fresh.get(section.projectKey));
          const gone = [...sent.keys()].filter((key) => !fresh.has(key));
          if (changed.length === 0 && gone.length === 0 && restJson === rest) return;
          revision += 1;
          event('fleet', { ...others, projects: changed, gone }, true);
        }
        sent = fresh;
        rest = restJson;
      } catch {
        if (!closed) failed('fleet', { code: 'core-error', verb: null, exit: null });
      } finally {
        busy.fleet = false;
      }
    }

    async function transcriptTick(): Promise<void> {
      if (busy.transcript || closed || params.agent === null) return;
      busy.transcript = true;
      try {
        const out = await views.transcript(params.project, params.agent, cursor);
        if (closed) return;
        if (!out.ok) return failed('transcript', out.error);
        failures.transcript = 0;
        const body = out.body;
        const moved = typeof body.cursor === 'string' && body.cursor !== cursor;
        if (moved) cursor = body.cursor;
        // An empty read at the same cursor says nothing new; the first read always answers so the panel has its reader status.
        if (body.events.length > 0 || body.reset || !answered) event('transcript', { agent: params.agent, ...body }, true);
        answered = true;
      } catch {
        if (!closed) failed('transcript', { code: 'core-error', verb: null, exit: null });
      } finally {
        busy.transcript = false;
      }
    }

    res.on('close', stop);
    req.on('close', () => {
      // A completed GET request also closes `req` while its socket lives on; only a gone socket is a disconnect.
      if (!req.socket || req.socket.destroyed) stop();
    });
    res.writeHead(200, { ...securityHeaders(true), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform' });
    if (req.socket && typeof req.socket.setNoDelay === 'function') req.socket.setNoDelay(true);
    write(`retry: ${RETRY_MS}\n\n`);

    timers.push(setInterval(() => { void fleetTick(); }, FLEET_MS));
    if (params.agent !== null) {
      timers.push(setInterval(() => { void transcriptTick(); }, TRANSCRIPT_MS));
    }
    timers.push(setInterval(() => { write(': keepalive\n\n'); }, KEEPALIVE_MS));
    void fleetTick();
  }

  return { acquire, serve, openStreams: () => [...open.values()].reduce((sum, count) => sum + count, 0) };
}

module.exports = { createStreams, parseLastEventId, FLEET_MS, TRANSCRIPT_MS, KEEPALIVE_MS, RETRY_MS, MAX_STREAMS_PER_SESSION, MAX_FAILED_TICKS };
