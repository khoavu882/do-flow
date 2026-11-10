'use strict';

// The `/api/live` stream (feature 149, IC-011, IC-013, IC-014; DEC-027, DEC-028, DEC-030, DEC-041,
// DEC-044, DEC-046, DEC-055). routes.ts validates the query, takes the stream slot and checks
// availability; `serve` then owns the response: the `/api/stream` headers, `setNoDelay`, `retry: 2000`,
// a named `keepalive` event (`event: keepalive`, `data: {}`, no `id:`) every 15000 ms, which the page
// sees and watches for silence (an SSE comment would be invisible to it, and an event with empty data
// is dropped), and one unnamed SSE message per browser frame, `id: <epoch>/<ch>=<pos>,...` (the position
// the client holds on every channel of the connection after that message: `<n>`, or `<ino>:<to>` on a
// log lane) and `data: <IC-002 envelope>`.
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
// Log lanes (150 IC-014), `worker:<runId>:out` and `:err`: a vector entry of a log channel is
// `<ino>:<offset>` (a log channel with `n`, or another channel with one, is malformed), used whatever
// the vector's epoch, and the SSE `id:` carries each log lane's `<ino>:<to>` from its last frame. On
// subscribe a gone lane gets `gone`, one in error its `error`, one whose hub window is null nothing;
// a position with the window's inode at a piece boundary inside `[from, to)` gets one `append` of the
// window from there, one at `to` nothing, any other one `snapshot` of the window. A lane shed by
// `queue-full` resyncs with that snapshot. Frames this module makes for a log lane carry IC-007 ids
// with the hub's `n` and this clock; a window frame over LIVE_FRAME_BUDGET is split at piece boundaries
// into consecutive `append` frames, as the hub splits its own.
//
// This module does not require routes.ts (live.ts reads routes.ts lazily; routes.ts requires this one).

const { securityHeaders } = require('./headers.ts');
const { envelopeText, isChannel, parseChannel, LIVE_FRAME_BUDGET } = require('./live.ts');

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
/** 150 IC-014 `logpos = ino ":" offset`, the first two parts of an IC-007 id. */
const LOG_INO = /^[0-9]{1,20}$/;
const LOG_OFFSET = /^[0-9]{1,16}$/;

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(handle: any): void;
}
/** `id` is set on a log channel's frames only (150 IC-007). */
type Frame = { ch: string; n: number; type: string; at: string; data: Record<string, unknown>; id?: string };
type LogPiece = { at: number; text: string; cut?: true; withheld?: true };
type LogWindow = { log: string; ino: string | null; from: number; to: number; pieces: LogPiece[]; phase: string | null; end: unknown };
type Current = { n: number; state: unknown; error: string | null; gone: boolean };
type LogCurrent = { n: number; window: LogWindow | null; error: string | null; gone: boolean };
/** The live hub of live.ts, as far as a connection uses it. */
interface Hub {
  readonly epoch: string;
  subscribe(channel: string, listener: (frame: Frame) => void): () => void;
  current(channel: string): Current | LogCurrent | null;
  readonly unsupported: boolean;
  onUnsupported(listener: () => void): void;
}
/** 150 IC-014: a log channel's file position. */
type LogPos = { ino: string; offset: number };
/** An IC-013 vector: the epoch and each channel's position, a log position on a log channel. */
type Vector = { epoch: string; positions: Map<string, number | LogPos> };
/** `pos` is the position the message leaves the channel at in the id vector: `<n>`, or `<ino>:<to>` on a log lane. */
type Item = { n: number; pos: string; envelope: string; bytes: number };
type Lane = { name: string; log: boolean; queue: Item[]; bytes: number; mode: 'live' | 'lagging' | 'capped'; unsubscribe: (() => void) | null };
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

const isLogChannel = (channel: string): boolean => parseChannel(channel)?.kind === 'log';

/** 150 IC-014 `logpos`, or null. */
function parseLogPos(text: string): LogPos | null {
  const colon = text.indexOf(':');
  const ino = text.slice(0, colon);
  const offset = text.slice(colon + 1);
  if (colon < 0 || !LOG_INO.test(ino) || !LOG_OFFSET.test(offset) || !Number.isSafeInteger(Number(offset))) return null;
  return { ino, offset: Number(offset) };
}

/**
 * IC-013 `epoch "/" entry *("," entry)`, 150 IC-014 `entry = channel "=" (n / logpos)` with `logpos` on
 * log channels only and `n` on every other: at most 8 distinct entries and 2048 characters, or null.
 */
function parseVector(text: unknown): Vector | null {
  if (typeof text !== 'string' || text.length > MAX_VECTOR_LENGTH) return null;
  const slash = text.indexOf('/');
  if (slash < 0 || !EPOCH.test(text.slice(0, slash))) return null;
  const entries = text.slice(slash + 1).split(',');
  if (entries.length > MAX_LIVE_CHANNELS) return null;
  const positions = new Map<string, number | LogPos>();
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const channel = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (eq < 0 || !isChannel(channel) || positions.has(channel)) return null;
    if (isLogChannel(channel)) {
      const pos = parseLogPos(value);
      if (pos === null) return null;
      positions.set(channel, pos);
    } else {
      if (!POSITION.test(value) || !Number.isSafeInteger(Number(value))) return null;
      positions.set(channel, Number(value));
    }
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
    /** Each channel's position the client holds, as the id vector prints it: `<n>`, or `<ino>:<to>` on a log lane. */
    const positions = new Map<string, string>();
    /** 150 IC-014: the log positions of the resume vector, whatever its epoch. */
    const logResume = new Map<string, LogPos>();
    if (params.resume !== null) {
      for (const [channel, at] of params.resume.positions) {
        if (!params.channels.includes(channel)) continue;
        if (typeof at === 'number') {
          if (params.resume.epoch === hub.epoch) positions.set(channel, String(at));
        } else {
          logResume.set(channel, at);
          positions.set(channel, `${at.ino}:${at.offset}`);
        }
      }
    }
    const lanes: Lane[] = params.channels.map((name) => ({ name, log: isLogChannel(name), queue: [], bytes: 0, mode: 'live', unsubscribe: null }));

    const writable = (): number => (typeof res.writableLength === 'number' ? res.writableLength : 0);
    const queued = (): number => lanes.reduce((sum, lane) => sum + lane.bytes, 0);
    const frameOf = (ch: string, n: number, type: string, data: Record<string, unknown>): Frame => ({ ch, n, type, at: new Date(clock.now()).toISOString(), data });
    /** A log lane's frame with the IC-007 id `<pos>:<n>:<ms>`, `pos` being `<ino>:<offset>`. */
    const logFrameOf = (ch: string, n: number, type: string, data: Record<string, unknown>, pos: string): Frame => {
      const ms = clock.now();
      return { ch, n, type, at: new Date(ms).toISOString(), data, id: `${pos}:${n}:${ms}` };
    };
    /** The position a frame leaves its lane at: its `n`, or the `<ino>:<offset>` of its IC-007 id on a log lane. */
    const posOf = (lane: Lane, frame: Frame): string =>
      lane.log ? (typeof frame.id === 'string' ? frame.id.split(':').slice(0, 2).join(':') : (positions.get(lane.name) ?? '0:0')) : String(frame.n);

    /** The vector after a message at `pos` on `channel` (or as it stands, with no argument); '' when no channel has a position. */
    function vector(channel?: string, pos?: string): string {
      const parts: string[] = [];
      for (const lane of lanes) {
        const at = lane.name === channel ? pos : positions.get(lane.name);
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

    /** The hub's current frame for `lane`: gone, its error, a snapshot of its state (or, on a log lane, of its whole window), or null when it owes one. */
    function currentFrame(lane: Lane): Frame | null {
      const c = hub.current(lane.name);
      if (c === null) return null;
      if (lane.log) {
        const w = (c as LogCurrent).window ?? null;
        // A reset, error or gone frame carries the channel's last position: the window's, else the one the client holds.
        const pos = w !== null ? `${w.ino ?? '0'}:${w.to}` : (positions.get(lane.name) ?? '0:0');
        if (c.gone) return logFrameOf(lane.name, c.n, 'gone', {}, pos);
        if (c.error !== null) return logFrameOf(lane.name, c.n, 'error', { code: c.error }, pos);
        if (w === null) return null;
        return logFrameOf(lane.name, c.n, 'snapshot', { log: w.log, ino: w.ino, from: w.from, to: w.to, pieces: w.pieces, phase: w.phase, end: w.end }, pos);
      }
      if (c.gone) return frameOf(lane.name, c.n, 'gone', {});
      if (c.error !== null) return frameOf(lane.name, c.n, 'error', { code: c.error });
      const state = (c as Current).state;
      if (state === null || state === undefined) return null;
      return frameOf(lane.name, c.n, 'snapshot', { state });
    }

    const fits = (frame: Frame): boolean => Buffer.byteLength(envelopeText(hub.epoch, frame), 'utf8') <= LIVE_FRAME_BUDGET;

    /**
     * Window `w` at the hub's `n` as one `snapshot` (`from` null) or one `append` of its pieces at or past
     * `from`, split at piece boundaries into consecutive `append` frames when over LIVE_FRAME_BUDGET (as
     * live.ts's sendLog); null when a single piece does not fit a frame of its own (the hub withholds those).
     */
    function windowFrames(lane: Lane, n: number, w: LogWindow, from: number | null): Frame[] | null {
      const ino = w.ino ?? '0';
      const pieces = from === null ? w.pieces : w.pieces.filter((piece) => piece.at >= from);
      const make = (kind: string, lo: number, hi: number, list: LogPiece[]): Frame =>
        logFrameOf(lane.name, n, kind, kind === 'snapshot'
          ? { log: w.log, ino: w.ino, from: lo, to: hi, pieces: list, phase: w.phase, end: w.end }
          : { from: lo, to: hi, pieces: list, phase: w.phase, end: w.end }, `${ino}:${hi}`);
      const count = pieces.length;
      // prefix[k] is the bytes of pieces [0, k); a frame holding [i, j) adds them and j - i - 1 commas to its empty envelope.
      const prefix = [0];
      for (const piece of pieces) prefix.push(prefix[prefix.length - 1] + Buffer.byteLength(JSON.stringify(piece), 'utf8'));
      const size = (kind: string, lo: number, hi: number, i: number, j: number): number =>
        Buffer.byteLength(envelopeText(hub.epoch, make(kind, lo, hi, [])), 'utf8') + prefix[j] - prefix[i] + Math.max(0, j - i - 1);
      const endOf = (j: number): number => (j < count ? pieces[j].at : w.to);
      const frames: Frame[] = [];
      let kind = from === null ? 'snapshot' : 'append';
      let lo = from === null ? w.from : from;
      let i = 0;
      for (;;) {
        if (size(kind, lo, w.to, i, count) <= LIVE_FRAME_BUDGET) {
          frames.push(make(kind, lo, w.to, pieces.slice(i)));
          return frames;
        }
        // The rest [i, count) does not fit: the most pieces from i that do, ending where the next piece starts.
        let j = i + 1;
        if (size(kind, lo, endOf(j), i, j) > LIVE_FRAME_BUDGET) return null;
        while (j + 1 < count && size(kind, lo, endOf(j + 1), i, j + 1) <= LIVE_FRAME_BUDGET) j += 1;
        frames.push(make(kind, lo, endOf(j), pieces.slice(i, j)));
        lo = endOf(j);
        i = j;
        kind = 'append';
      }
    }

    /** Queues window frames of `lane`; when they cannot fit, `reset` `frame-cap` and the lane is capped. */
    function sendWindow(lane: Lane, n: number, w: LogWindow, from: number | null): void {
      const frames = windowFrames(lane, n, w, from);
      if (frames === null) {
        lane.mode = 'capped';
        enqueue(lane, logFrameOf(lane.name, n, 'reset', { reason: 'frame-cap' }, positions.get(lane.name) ?? '0:0'));
        return;
      }
      for (const frame of frames) {
        // A shed part-way leaves the lane lagging; its resync sends the window again.
        if (closed || lane.mode === 'lagging') return;
        enqueue(lane, frame);
      }
    }

    /** Queues the hub's current frame for `lane`; a snapshot over the budget is `reset` `frame-cap` and the lane is capped (a log window is split first). */
    function resync(lane: Lane): void {
      const frame = currentFrame(lane);
      if (frame === null) return;
      if (lane.log && frame.type === 'snapshot') {
        const c = hub.current(lane.name) as LogCurrent;
        return sendWindow(lane, c.n, c.window as LogWindow, null);
      }
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
      const pos = posOf(lane, frame);
      const bytes = Buffer.byteLength(message(vector(lane.name, pos), envelope), 'utf8');
      if (lane.bytes + bytes > CHANNEL_QUEUE_BYTES) {
        // DEC-046: the error carries the last position written for the channel (or, with none, the oldest dropped one).
        const at = positions.get(lane.name) ?? (lane.queue.length > 0 ? lane.queue[0].pos : pos);
        const n = lane.log ? frame.n : Number(at);
        const shedFrame = lane.log ? logFrameOf(lane.name, n, 'error', { code: 'queue-full' }, at) : frameOf(lane.name, n, 'error', { code: 'queue-full' });
        const shed = envelopeText(hub.epoch, shedFrame);
        lane.queue = [{ n, pos: at, envelope: shed, bytes: Buffer.byteLength(message(vector(lane.name, at), shed), 'utf8') }];
        lane.bytes = lane.queue[0].bytes;
        lane.mode = 'lagging';
      } else {
        lane.queue.push({ n: frame.n, pos, envelope, bytes });
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
        let pos = item.pos;
        let text = message(vector(lane.name, pos), item.envelope);
        if (Buffer.byteLength(text, 'utf8') > FRAME_CAP) {
          // A log lane's reset carries the channel's last position written (IC-007), and leaves the client there.
          if (lane.log) pos = positions.get(lane.name) ?? '0:0';
          const reset = lane.log
            ? logFrameOf(lane.name, item.n, 'reset', { reason: 'frame-cap' }, pos)
            : frameOf(lane.name, item.n, 'reset', { reason: 'frame-cap' });
          text = message(vector(lane.name, pos), envelopeText(hub.epoch, reset));
          lane.queue = [];
          lane.bytes = 0;
          lane.mode = 'capped';
        }
        if (!write(text)) return;
        positions.set(lane.name, pos);
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

    /**
     * 150 IC-014 on subscribe: gone gets `gone`, an error its `error`, a null window nothing; a resumed
     * position with the window's inode at a piece boundary inside [from, to) one `append` from there,
     * at `to` nothing, and any other position (or none) one `snapshot` of the window.
     */
    function subscribeLog(lane: Lane, c: LogCurrent): void {
      const w = c.window ?? null;
      if (!c.gone && c.error === null) {
        if (w === null) return;
        const held = logResume.get(lane.name);
        if (held !== undefined && w.ino !== null && held.ino === w.ino) {
          if (held.offset === w.to) return;
          if (held.offset >= w.from && held.offset < w.to && w.pieces.some((piece) => piece.at === held.offset)) return sendWindow(lane, c.n, w, held.offset);
        }
      }
      resync(lane);
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
        if (closed || !write('event: keepalive\ndata: {}\n\n')) return;
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
      if (c === null) continue;
      if (lane.log) {
        subscribeLog(lane, c as LogCurrent);
        continue;
      }
      if (!c.gone && c.error === null && ((c as Current).state === null || positions.get(lane.name) === String(c.n))) continue;
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
