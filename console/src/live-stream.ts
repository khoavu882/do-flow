'use strict';

// The `/api/live` stream (feature 149, IC-011, IC-013, IC-014; DEC-027, DEC-028, DEC-030, DEC-041,
// DEC-044, DEC-046, DEC-055). routes.ts validates the query, takes the stream slot and checks
// availability; `serve` then owns the response: the `/api/stream` headers, `setNoDelay`, `retry: 2000`,
// a `: keepalive` comment every 15000 ms, and one unnamed SSE message per browser frame,
// `id: <epoch>/<ch>=<n>,...` (the position the client holds on every channel of the connection after
// that message) and `data: <IC-002 envelope>`.
//
// Subscribe (IC-013): after `hub.subscribe`, a channel that is gone gets `gone`, one in error its
// `error` frame, one with a state a `snapshot` at the hub's position unless the client's position (from
// `since`, else `Last-Event-ID`) is that position in the hub's epoch; a channel the hub owes a snapshot
// gets nothing, since the hub's own next frame is that snapshot.
//
// Queues (IC-014 as amended by DEC-044, DEC-046, DEC-055): one FIFO per channel, moved to `res.write`
// round-robin, whole messages only, while `res.writableLength` is under 65536, resumed on `drain`. A
// channel whose queue would pass 524288 bytes is cleared and gets one `error` `queue-full`; it then
// takes no hub frame until its queue is empty and `res.writableLength` is 0, and gets one `snapshot`
// of the hub's current state (or its error or `gone`). All queues plus `res.writableLength` over
// 1048576 bytes, or `res.writableLength` above 0 with no `drain` for 60000 ms, destroys the connection.
// A message over 262144 bytes is written as `reset` `frame-cap`; the channel then waits for a hub frame
// and answers a patch with a snapshot of the current state once one fits LIVE_FRAME_BUDGET.
//
// Ceilings: the queued size of a message is measured with the id vector as it stands at enqueue time;
// a lagging channel whose socket empties without a `drain` event resnapshots at the next write, frame or
// keepalive; a capped channel drops the frames it had queued, so an error among them shows only at the
// next hub frame.
//
// This module does not require routes.ts (live.ts reads routes.ts lazily; routes.ts requires this one).

const { securityHeaders } = require('./headers.ts');
const { envelopeText, isChannel, LIVE_FRAME_BUDGET } = require('./live.ts');

/** DEC-041. */
const RETRY_MS = 2_000;
const KEEPALIVE_MS = 15_000;
/** DEC-042: channels per connection; also the most entries of an id vector. */
const MAX_LIVE_CHANNELS = 8;
/** IC-013. */
const MAX_VECTOR_LENGTH = 2_048;
/** IC-014: the writer moves messages while `res.writableLength` is under this. */
const WRITE_HIGH_WATER = 65_536;
/** DEC-044, DEC-055: one channel's queue. */
const CHANNEL_QUEUE_BYTES = 524_288;
/** IC-014: all queues plus `res.writableLength`. */
const CONNECTION_BYTES = 1_048_576;
/** IC-014: no `drain` this long with bytes pending destroys the connection. */
const STALL_MS = 60_000;
/** IC-014, DEC-018: the largest SSE message written. */
const FRAME_CAP = 262_144;

const EPOCH = /^[0-9a-f]{8}$/;
const POSITION = /^[1-9][0-9]{0,15}$/;

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(handle: any): void;
}
type Frame = { ch: string; n: number; type: string; at: string; data: Record<string, unknown> };
type Current = { n: number; state: unknown; error: string | null; gone: boolean };
/** The live hub of live.ts, as far as a connection uses it. */
interface Hub {
  readonly epoch: string;
  subscribe(channel: string, listener: (frame: Frame) => void): () => void;
  current(channel: string): Current | null;
  readonly unsupported: boolean;
  onUnsupported(listener: () => void): void;
}
/** An IC-013 vector: the epoch and each channel's position. */
type Vector = { epoch: string; positions: Map<string, number> };
type Item = { n: number; envelope: string; bytes: number };
type Lane = { name: string; queue: Item[]; bytes: number; mode: 'live' | 'lagging' | 'capped'; unsubscribe: (() => void) | null };
type ServeParams = { channels: readonly string[]; resume: Vector | null; release: () => void };

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** IC-011 `ch`: 1 to 8 distinct IC-003 channels separated by commas, or null. */
function parseChannelList(text: unknown): string[] | null {
  if (typeof text !== 'string' || text === '') return null;
  const list = text.split(',');
  if (list.length > MAX_LIVE_CHANNELS || new Set(list).size !== list.length || !list.every(isChannel)) return null;
  return list;
}

/** IC-013 `epoch "/" entry *("," entry)`, `entry = channel "=" n`: at most 8 distinct entries and 2048 characters, or null. */
function parseVector(text: unknown): Vector | null {
  if (typeof text !== 'string' || text.length > MAX_VECTOR_LENGTH) return null;
  const slash = text.indexOf('/');
  if (slash < 0 || !EPOCH.test(text.slice(0, slash))) return null;
  const entries = text.slice(slash + 1).split(',');
  if (entries.length > MAX_LIVE_CHANNELS) return null;
  const positions = new Map<string, number>();
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const channel = entry.slice(0, eq);
    const n = entry.slice(eq + 1);
    if (eq < 0 || !isChannel(channel) || positions.has(channel) || !POSITION.test(n) || !Number.isSafeInteger(Number(n))) return null;
    positions.set(channel, Number(n));
  }
  return { epoch: text.slice(0, slash), positions };
}

/** `Last-Event-ID` as a vector over `channels`: a malformed one is null, entries for other channels are dropped. */
function lastEventVector(value: unknown, channels: readonly string[]): Vector | null {
  const vector = parseVector(value);
  if (vector === null) return null;
  for (const channel of [...vector.positions.keys()]) if (!channels.includes(channel)) vector.positions.delete(channel);
  return vector;
}

/** Live connections over `hub`, one per `serve`; an unsupported hub ends them all once its error frames are written. */
function createLiveStreams(hub: Hub, clock: Clock = realClock) {
  const open = new Set<{ unsupported(): void }>();
  hub.onUnsupported(() => {
    for (const connection of [...open]) connection.unsupported();
  });

  function serve(req: any, res: any, params: ServeParams): void {
    let closed = false;
    let ending = false;
    let cursor = 0;
    let keepaliveTimer: any = null;
    let stallTimer: any = null;
    const positions = new Map<string, number>();
    if (params.resume !== null && params.resume.epoch === hub.epoch) {
      for (const [channel, n] of params.resume.positions) if (params.channels.includes(channel)) positions.set(channel, n);
    }
    const lanes: Lane[] = params.channels.map((name) => ({ name, queue: [], bytes: 0, mode: 'live', unsubscribe: null }));

    const writable = (): number => (typeof res.writableLength === 'number' ? res.writableLength : 0);
    const queued = (): number => lanes.reduce((sum, lane) => sum + lane.bytes, 0);
    const frameOf = (ch: string, n: number, type: string, data: Record<string, unknown>): Frame => ({ ch, n, type, at: new Date(clock.now()).toISOString(), data });

    /** The vector after a message at `n` on `channel` (or as it stands, with no argument); '' when no channel has a position. */
    function vector(channel?: string, n?: number): string {
      const parts: string[] = [];
      for (const lane of lanes) {
        const at = lane.name === channel ? n : positions.get(lane.name);
        if (at !== undefined) parts.push(`${lane.name}=${at}`);
      }
      return parts.length === 0 ? '' : `${hub.epoch}/${parts.join(',')}`;
    }
    // JSON.stringify never emits a raw newline, so one `data:` line carries the whole envelope.
    const message = (id: string, envelope: string): string => `${id === '' ? '' : `id: ${id}\n`}data: ${envelope}\n\n`;

    function close(): void {
      if (closed) return;
      closed = true;
      open.delete(connection);
      params.release();
      if (keepaliveTimer !== null) clock.clearTimeout(keepaliveTimer);
      if (stallTimer !== null) clock.clearTimeout(stallTimer);
      keepaliveTimer = stallTimer = null;
      for (const lane of lanes) {
        lane.queue = [];
        lane.bytes = 0;
        const unsubscribe = lane.unsubscribe;
        lane.unsubscribe = null;
        if (unsubscribe !== null) unsubscribe();
      }
    }

    function destroy(): void {
      close();
      try {
        res.destroy();
      } catch {}
    }

    function armStall(): void {
      if (closed || stallTimer !== null || writable() === 0) return;
      stallTimer = clock.setTimeout(() => {
        stallTimer = null;
        if (!closed && writable() > 0) destroy();
      }, STALL_MS);
    }

    function clearStall(): void {
      if (stallTimer !== null) clock.clearTimeout(stallTimer);
      stallTimer = null;
    }

    /** One write; false (and the connection gone) when it failed or passed the connection cap. */
    function write(text: string): boolean {
      if (closed) return false;
      // Nothing pending before this write: the socket made progress since the stall timer was armed.
      if (writable() === 0) clearStall();
      try {
        res.write(text);
      } catch {
        destroy();
        return false;
      }
      if (queued() + writable() > CONNECTION_BYTES) {
        destroy();
        return false;
      }
      armStall();
      return true;
    }

    /** The hub's current frame for `lane`: gone, its error, a snapshot of its state, or null when it owes one. */
    function currentFrame(lane: Lane): Frame | null {
      const c = hub.current(lane.name);
      if (c === null) return null;
      if (c.gone) return frameOf(lane.name, c.n, 'gone', {});
      if (c.error !== null) return frameOf(lane.name, c.n, 'error', { code: c.error });
      if (c.state === null) return null;
      return frameOf(lane.name, c.n, 'snapshot', { state: c.state });
    }

    const fits = (frame: Frame): boolean => Buffer.byteLength(envelopeText(hub.epoch, frame), 'utf8') <= LIVE_FRAME_BUDGET;

    /** Queues the hub's current frame for `lane`; a snapshot over the budget is `reset` `frame-cap` and the lane is capped. */
    function resync(lane: Lane): void {
      const frame = currentFrame(lane);
      if (frame === null) return;
      if (frame.type === 'snapshot' && !fits(frame)) {
        lane.mode = 'capped';
        enqueue(lane, frameOf(lane.name, frame.n, 'reset', { reason: 'frame-cap' }));
        return;
      }
      enqueue(lane, frame);
    }

    /** IC-014 enqueue: the channel rule (shed), then the connection rule (destroy), then the writer. */
    function enqueue(lane: Lane, frame: Frame): void {
      if (closed) return;
      const envelope = envelopeText(hub.epoch, frame);
      const bytes = Buffer.byteLength(message(vector(lane.name, frame.n), envelope), 'utf8');
      if (lane.bytes + bytes > CHANNEL_QUEUE_BYTES) {
        // DEC-046: the error carries the last position written for the channel (or, with none, the oldest dropped one).
        const n = positions.get(lane.name) ?? (lane.queue.length > 0 ? lane.queue[0].n : frame.n);
        const shed = envelopeText(hub.epoch, frameOf(lane.name, n, 'error', { code: 'queue-full' }));
        lane.queue = [{ n, envelope: shed, bytes: Buffer.byteLength(message(vector(lane.name, n), shed), 'utf8') }];
        lane.bytes = lane.queue[0].bytes;
        lane.mode = 'lagging';
      } else {
        lane.queue.push({ n: frame.n, envelope, bytes });
        lane.bytes += bytes;
      }
      if (queued() + writable() > CONNECTION_BYTES) return destroy();
      pump();
    }

    /** The next lane with a queued message, round-robin from the last one served. */
    function nextLane(): Lane | null {
      for (let step = 0; step < lanes.length; step += 1) {
        const lane = lanes[(cursor + step) % lanes.length];
        if (lane.queue.length > 0) {
          cursor = (cursor + step + 1) % lanes.length;
          return lane;
        }
      }
      return null;
    }

    function pump(): void {
      while (!closed && writable() < WRITE_HIGH_WATER) {
        const lane = nextLane();
        if (lane === null) break;
        const item = lane.queue.shift()!;
        lane.bytes -= item.bytes;
        const id = vector(lane.name, item.n);
        let text = message(id, item.envelope);
        if (Buffer.byteLength(text, 'utf8') > FRAME_CAP) {
          text = message(id, envelopeText(hub.epoch, frameOf(lane.name, item.n, 'reset', { reason: 'frame-cap' })));
          lane.queue = [];
          lane.bytes = 0;
          lane.mode = 'capped';
        }
        if (!write(text)) return;
        positions.set(lane.name, item.n);
      }
      if (closed) return;
      for (const lane of lanes) {
        if (lane.mode === 'lagging' && lane.queue.length === 0 && writable() === 0) {
          lane.mode = 'live';
          resync(lane);
          if (closed) return;
        }
      }
      if (ending && lanes.every((lane) => lane.queue.length === 0)) {
        try {
          res.end();
        } catch {}
        close();
      }
    }

    function onFrame(lane: Lane, frame: Frame): void {
      if (closed || lane.mode === 'lagging') return;
      if (lane.mode === 'capped') {
        if (frame.type === 'patch') {
          const snapshot = currentFrame(lane);
          if (snapshot === null || snapshot.type !== 'snapshot' || !fits(snapshot)) return;
          lane.mode = 'live';
          return enqueue(lane, snapshot);
        }
        lane.mode = 'live';
      }
      enqueue(lane, frame);
    }

    const connection = {
      /** The hub's `error` `live-unavailable` frames are queued by now; a lane that was not taking frames gets its error too. */
      unsupported(): void {
        if (closed) return;
        ending = true;
        for (const lane of lanes) {
          if (lane.mode === 'live') continue;
          lane.mode = 'live';
          const frame = currentFrame(lane);
          if (frame !== null && frame.type === 'error') enqueue(lane, frame);
        }
        pump();
      },
    };

    function armKeepalive(): void {
      keepaliveTimer = clock.setTimeout(() => {
        keepaliveTimer = null;
        if (closed || !write(': keepalive\n\n')) return;
        armKeepalive();
        pump();
      }, KEEPALIVE_MS);
    }

    res.on('close', close);
    req.on('close', () => {
      // A completed GET request also closes `req` while its socket lives on; only a gone socket is a disconnect.
      if (!req.socket || req.socket.destroyed) close();
    });
    res.on('drain', () => {
      clearStall();
      pump();
    });
    res.writeHead(200, { ...securityHeaders(true), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform' });
    if (req.socket && typeof req.socket.setNoDelay === 'function') req.socket.setNoDelay(true);
    open.add(connection);
    if (!write(`retry: ${RETRY_MS}\n\n`)) return;
    armKeepalive();

    for (const lane of lanes) {
      if (closed) return;
      lane.unsubscribe = hub.subscribe(lane.name, (frame) => onFrame(lane, frame));
      const c = hub.current(lane.name);
      if (c === null || (!c.gone && c.error === null && (c.state === null || positions.get(lane.name) === c.n))) continue;
      resync(lane);
    }
  }

  return { serve, openConnections: (): number => open.size };
}

module.exports = {
  CHANNEL_QUEUE_BYTES,
  CONNECTION_BYTES,
  FRAME_CAP,
  KEEPALIVE_MS,
  MAX_LIVE_CHANNELS,
  MAX_VECTOR_LENGTH,
  RETRY_MS,
  STALL_MS,
  WRITE_HIGH_WATER,
  createLiveStreams,
  lastEventVector,
  parseChannelList,
  parseVector,
};
