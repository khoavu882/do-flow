'use strict';

// The client log store (feature 150, IC-019; plan task C.2). Like live-store.test.ts, the web root is copied beside a
// {"type":"module"} marker and log-store.js is imported. The live store is a fake that records subscriptions and lets a case
// push channel events and transport states; `apiGet` is a fake over a scripted file, so pages follow IC-001's rules on whole
// lines; the clock is fake, so nothing waits in real time.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let mod: any;

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-log-store-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  mod = await import(pathToFileURL(path.join(copy, 'log-store.js')).href);
});
after(() => { fs.rmSync(copy, { recursive: true, force: true }); });

const flush = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); };

function fakeClock() {
  const clock: any = {
    time: 0, timers: [] as Array<{ at: number, fn: () => void, id: number }>, id: 0,
    now: () => clock.time,
    setTimeout: (fn: () => void, ms: number) => { clock.id += 1; clock.timers.push({ at: clock.time + ms, fn, id: clock.id }); return clock.id; },
    clearTimeout: (id: number) => { clock.timers = clock.timers.filter((t: any) => t.id !== id); },
    async advance(ms: number) {
      const end = clock.time + ms;
      for (;;) {
        const due = clock.timers.filter((t: any) => t.at <= end).sort((a: any, b: any) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        clock.timers = clock.timers.filter((t: any) => t !== due);
        clock.time = due.at;
        due.fn();
        await flush();
      }
      clock.time = end;
    },
  };
  return clock;
}

function fakeStore(transport = 'idle') {
  const store: any = {
    subs: [] as Array<{ channel: string, listener: (event: any) => void, position: () => string | null, off: boolean }>,
    transportListeners: [] as Array<(event: any) => void>,
    transport,
    subscribe(channel: string, listener: (event: any) => void, options: any) {
      const sub = { channel, listener, position: options.position, off: false };
      store.subs.push(sub);
      return () => { sub.off = true; };
    },
    status: () => ({ transport: store.transport, lastFrameAt: null }),
    onTransport(listener: (event: any) => void) {
      store.transportListeners.push(listener);
      return () => { store.transportListeners = store.transportListeners.filter((l: any) => l !== listener); };
    },
    /** One channel event to every live subscriber. */
    emit(event: any) { for (const sub of store.subs) if (!sub.off) sub.listener(event); },
    state(state: string, code: string | null = null) {
      store.transport = state;
      for (const listener of [...store.transportListeners]) listener({ state, code, at: 0 });
    },
    position: () => store.subs.at(-1).position(),
  };
  return store;
}

const RUN = 'w-1a2b3c4d5e6f';
const BASE = `/api/worker-runs/feat-a/${RUN}/log?stream=out`;
const CH = `worker:${RUN}:out`;

/**
 * A file of whole lines and the GET over it: `tail`, `cursor` (forward) and `before` (backward) pages of at most `page` bytes,
 * as IC-001 cuts them (whole lines here), with the IC-002 body. `fail` makes the next reads throw the given errors.
 */
function fakeFile(options: { page?: number, ino?: string } = {}) {
  const file: any = {
    ino: options.ino ?? '77',
    lines: [] as string[],
    page: options.page ?? 1 << 17,
    phase: 'running',
    capped: null as boolean | null,
    log: null as string | null,
    calls: [] as string[],
    fail: [] as any[],
    hold: false,
    pending: [] as Array<() => void>,
  };
  /** The [at, text] of every line, offsets counting each line and its newline. */
  file.pieces = () => {
    let at = 0;
    return file.lines.map((text: string) => { const piece = { at, text }; at += Buffer.byteLength(text) + 1; return piece; });
  };
  file.size = () => file.lines.reduce((n: number, text: string) => n + Buffer.byteLength(text) + 1, 0);
  file.add = (...texts: string[]) => { file.lines.push(...texts); return file.size(); };
  const body = (from: number, to: number, reset: boolean) => {
    const pieces = file.pieces().filter((p: any) => p.at >= from && p.at < to).map((p: any) => ({ ...p, cut: false }));
    return {
      v: 1, runId: RUN, stream: 'out', phase: file.phase, log: file.log ?? 'open', ino: file.log && file.log !== 'open' ? null : file.ino,
      size: file.size(), from, to, pieces, eof: to === file.size(), reset,
      capped: file.phase === 'ended' ? file.capped : null, cursor: null, before: null,
    };
  };
  const boundaryAtOrAfter = (offset: number) => {
    const starts = [...file.pieces().map((p: any) => p.at), file.size()];
    return starts.find((b: number) => b >= offset);
  };
  const tail = (reset: boolean) => {
    const end = file.size();
    return body(boundaryAtOrAfter(Math.max(0, end - file.page)), end, reset);
  };
  file.apiGet = (url: string) => {
    file.calls.push(url);
    const answer = () => {
      if (file.fail.length > 0) throw file.fail.shift();
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      assert.equal(url.startsWith(BASE), true, url);
      const cursor = query.get('cursor');
      const back = query.get('before');
      if (file.log && file.log !== 'open') return { ...body(0, 0, false), pieces: [] };
      if (cursor !== null) {
        const [ino, offset] = cursor.split(':');
        if (ino !== file.ino || Number(offset) > file.size()) return tail(true);
        const from = Number(offset);
        const starts = [...file.pieces().map((p: any) => p.at), file.size()];
        const to = starts.filter((b: number) => b <= from + file.page && b <= file.size()).at(-1);
        return body(from, to, false);
      }
      if (back !== null) {
        const [ino, offset] = back.split(':');
        if (ino !== file.ino || Number(offset) > file.size()) return tail(true);
        const to = Math.min(Number(offset), file.size());
        return body(boundaryAtOrAfter(Math.max(0, to - file.page)), to, false);
      }
      return tail(false);
    };
    return new Promise((resolve, reject) => {
      const settle = () => { try { resolve(answer()); } catch (error) { reject(error); } };
      if (file.hold) file.pending.push(settle);
      else settle();
    });
  };
  file.release = () => { for (const fn of file.pending.splice(0)) fn(); };
  /** The live `append` of the bytes in [from, to), with the IC-007 id. */
  file.append = (from: number, to: number, n = 1) => ({
    kind: 'append', code: null, id: `${file.ino}:${to}:${n}:0`,
    state: { from, to, pieces: file.pieces().filter((p: any) => p.at >= from && p.at < to), phase: file.phase, end: file.phase === 'ended' ? { capped: file.capped } : null },
  });
  /** The live `snapshot` of the newest `bytes`. */
  file.snapshot = (bytes: number, n = 1) => {
    const end = file.size();
    const from = boundaryAtOrAfter(Math.max(0, end - bytes));
    return {
      kind: 'state', code: null, id: `${file.ino}:${end}:${n}:0`,
      state: { log: 'open', ino: file.ino, from, to: end, pieces: file.pieces().filter((p: any) => p.at >= from && p.at < end), phase: file.phase, end: file.phase === 'ended' ? { capped: file.capped } : null },
    };
  };
  return file;
}

/** A log stream over `file` and a fake store, opened, with every state it reported. */
async function rig(options: { page?: number, transport?: string, lines?: string[] } = {}) {
  const file = fakeFile({ page: options.page });
  if (options.lines) file.add(...options.lines);
  const store = fakeStore(options.transport);
  const clock = fakeClock();
  const log = mod.createLogStream({ apiGet: file.apiGet, store, clock, slug: 'feat-a', runId: RUN, stream: 'out' });
  const states: any[] = [];
  log.onChange((s: any) => states.push(s));
  const opened = log.open();
  await flush();
  await opened;
  return { file, store, clock, log, states, last: () => states.at(-1) };
}

const texts = (state: any) => state.pieces.map((p: any) => p.text);
const line = (i: number, width = 9) => `line ${String(i).padStart(width - 5, '0')}`;

// ---- first paint, subscribe, merge ---------------------------------------------------------------------

test('first paint: one tail GET, then one subscription of worker:<runId>:<stream> with since from the held ino:to', async () => {
  const r = await rig({ lines: ['alpha', 'beta'] });
  assert.deepEqual(r.file.calls, [BASE]);
  assert.equal(r.store.subs.length, 1);
  assert.equal(r.store.subs[0].channel, CH);
  assert.equal(r.store.position(), '77:11');
  assert.deepEqual(r.last(), {
    log: 'open', ino: '77', from: 0, to: 11, pieces: [{ at: 0, text: 'alpha' }, { at: 6, text: 'beta' }], phase: 'running', end: null,
    notices: [], following: true, mode: 'live', error: null,
  });
  assert.equal(mod.LOG_HOLD_BYTES, 1048576);
  assert.equal(mod.POLL_MS, 3000);
});

test('first paint: a stream of a run with no file yet is waiting, subscribes with no position, and an err stream reads its own path', async () => {
  const file = fakeFile();
  file.log = 'waiting';
  const errUrls: string[] = [];
  const store = fakeStore();
  const log = mod.createLogStream({ apiGet: (url: string) => { errUrls.push(url); return Promise.resolve({ ...{ v: 1, runId: RUN, stream: 'err', phase: 'starting', log: 'waiting', ino: null, size: 0, from: 0, to: 0, pieces: [], eof: true, reset: false, capped: null, cursor: null, before: null } }); }, store, clock: fakeClock(), slug: 'feat-a', runId: RUN, stream: 'err' });
  const states: any[] = [];
  log.onChange((s: any) => states.push(s));
  await log.open();
  assert.deepEqual(errUrls, [`/api/worker-runs/feat-a/${RUN}/log?stream=err`]);
  assert.equal(store.subs[0].channel, `worker:${RUN}:err`);
  assert.equal(store.subs[0].position(), null);
  assert.equal(states.at(-1).log, 'waiting');
  assert.deepEqual(states.at(-1).notices, ['waiting']);
  assert.throws(() => mod.createLogStream({ apiGet: file.apiGet, store, clock: fakeClock(), slug: 'feat-a', runId: RUN, stream: 'last' }), TypeError);
  assert.throws(() => mod.createLogStream({ apiGet: file.apiGet, store, clock: fakeClock(), slug: 'feat-a', runId: 'w-1', stream: 'out' }), TypeError);
});

test('merge: a page, a snapshot and an append over the same bytes give each line once, in byte order, keeping cut', async () => {
  const r = await rig({ lines: ['a1', 'a2'] });
  const before = r.file.size();
  r.file.add('b1', 'b2');
  // A snapshot that overlaps what the page gave, then an append that repeats part of the snapshot and adds one line.
  r.store.emit(r.file.snapshot(1 << 17, 1));
  await flush();
  assert.deepEqual(texts(r.last()), ['a1', 'a2', 'b1', 'b2']);
  const mid = r.file.size();
  r.file.add('c1');
  const repeat = r.file.append(before, r.file.size(), 2);
  r.store.emit(repeat);
  r.store.emit(repeat);
  await flush();
  assert.deepEqual(texts(r.last()), ['a1', 'a2', 'b1', 'b2', 'c1']);
  assert.equal(r.last().to, r.file.size());
  assert.equal(r.store.position(), `77:${r.file.size()}`);
  // A cut piece is held with its flag, so it joins the next piece when shown (IC-001).
  const at = r.file.size();
  r.store.emit({ kind: 'append', code: null, id: `77:${at + 40}:3:0`, state: { from: at, to: at + 40, pieces: [{ at, text: 'x'.repeat(30), cut: true }, { at: at + 30, text: 'tail' }], phase: 'running', end: null } });
  await flush();
  assert.deepEqual(r.last().pieces.slice(-2), [{ at, text: 'x'.repeat(30), cut: true }, { at: at + 30, text: 'tail' }]);
  assert.equal(mid < at, true);
  assert.deepEqual(r.file.calls, [BASE], 'no read: nothing was missing');
});

test('merge: a chunk of another inode replaces the held text; an append with no pieces changes phase and end only', async () => {
  const r = await rig({ lines: ['old'] });
  r.store.emit({ kind: 'state', code: null, id: '99:4:1:0', state: { log: 'open', ino: '99', from: 0, to: 4, pieces: [{ at: 0, text: 'new' }], phase: 'running', end: null } });
  await flush();
  assert.deepEqual([r.last().ino, texts(r.last())], ['99', ['new']]);
  r.store.emit({ kind: 'append', code: null, id: '99:4:2:0', state: { from: 4, to: 4, pieces: [], phase: 'ended', end: { capped: false } } });
  await flush();
  assert.deepEqual([r.last().phase, r.last().end, texts(r.last())], ['ended', { capped: false }, ['new']]);
});

// ---- gap fill ------------------------------------------------------------------------------------------

test('gap: a chunk past the held to reads forward from the held to, on that event, until the chunk\'s from, then merges', async () => {
  const r = await rig({ page: 20, lines: ['l0'] });
  const held = r.file.size();
  for (let i = 1; i <= 8; i += 1) r.file.add(`l${i}`);
  const gapEnd = r.file.size();
  r.file.add('l9');
  r.store.emit(r.file.append(gapEnd, r.file.size()));
  await flush();
  assert.deepEqual(texts(r.last()), ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9']);
  const reads = r.file.calls.slice(1);
  assert.equal(reads[0], `${BASE}&cursor=${encodeURIComponent(`77:${held}:0:0`)}`);
  assert.equal(reads.length, 2, 'two 20-byte pages cover the 24-byte gap');
  // Never on a timer: nothing more is read however long the stream stays live.
  await r.clock.advance(60000);
  assert.equal(r.file.calls.length, 3);
  assert.deepEqual(r.clock.timers, []);
});

test('gap: frames that arrive while a gap read runs wait for it and merge in order', async () => {
  const r = await rig({ lines: ['l0'] });
  r.file.add('l1');
  const gapEnd = r.file.size();
  r.file.add('l2');
  r.file.hold = true;
  r.store.emit(r.file.append(gapEnd, r.file.size(), 1));
  const second = r.file.size();
  r.file.add('l3');
  r.store.emit(r.file.append(second, r.file.size(), 2));
  await flush();
  assert.deepEqual(texts(r.last()), ['l0']);
  r.file.release();
  await flush();
  assert.deepEqual(texts(r.last()), ['l0', 'l1', 'l2', 'l3']);
  assert.equal(r.file.calls.length, 2);
});

test('gap: a gap of the hold bound or more is not read; the chunk replaces the held text and earlier text exists', async () => {
  const r = await rig({ lines: ['l0'] });
  const at = mod.LOG_HOLD_BYTES + 100;
  r.store.emit({ kind: 'append', code: null, id: `77:${at + 5}:1:0`, state: { from: at, to: at + 5, pieces: [{ at, text: 'late' }], phase: 'running', end: null } });
  await flush();
  assert.deepEqual(r.file.calls, [BASE]);
  assert.deepEqual([r.last().from, r.last().to, texts(r.last())], [at, at + 5, ['late']]);
  assert.deepEqual(r.last().notices, ['earlier']);
});

test('gap: a failed gap read keeps the newest text and reports the failure', async () => {
  const r = await rig({ lines: ['l0'] });
  r.file.add('l1');
  const gapEnd = r.file.size();
  r.file.add('l2');
  r.file.fail.push({ status: 502, code: 'core-error', network: false });
  r.store.emit(r.file.append(gapEnd, r.file.size()));
  await flush();
  assert.deepEqual([r.last().from, texts(r.last())], [gapEnd, ['l2']]);
  assert.deepEqual(r.last().error, { status: 502, code: 'core-error', network: false });
  assert.equal(r.last().mode, 'live');
});

// ---- hold bound, earlier pages, pause, jump to newest ---------------------------------------------------

test('hold bound: while following the oldest pieces beyond LOG_HOLD_BYTES are dropped and earlier text exists', async () => {
  const r = await rig({ lines: ['first'] });
  const big = 'y'.repeat(32767);
  const start = r.file.size();
  for (let i = 0; i < 33; i += 1) r.file.add(big);
  r.store.emit(r.file.append(start, r.file.size()));
  await flush();
  const s = r.last();
  assert.equal(s.to - s.from <= mod.LOG_HOLD_BYTES, true);
  assert.equal(s.to, r.file.size());
  assert.equal(s.from, s.pieces[0].at);
  assert.equal(s.pieces.length, 32);
  assert.equal(texts(s).includes('first'), false);
  assert.deepEqual(s.notices, ['earlier']);
  assert.equal(s.following, true);
});

test('earlier: Load earlier reads by before from the held from and prepends one page; past the bound following pauses', async () => {
  const big = 'z'.repeat(32767);
  const lines = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, '0')}${big.slice(2)}`);
  const r = await rig({ lines, page: 1 << 17 });
  let s = r.last();
  assert.equal(s.pieces.length, 4, 'the tail page is 128 KiB');
  assert.deepEqual(s.notices, ['earlier']);
  const from = s.from;
  await r.log.loadEarlier();
  assert.equal(r.file.calls.at(-1), `${BASE}&before=${encodeURIComponent(`77:${from}:0:0`)}`);
  s = r.last();
  assert.equal(s.pieces.length, 8);
  assert.equal(s.following, true);
  for (let i = 0; i < 7; i += 1) await r.log.loadEarlier();
  s = r.last();
  assert.equal(s.to - s.from, mod.LOG_HOLD_BYTES, 'eight loads hold 36 lines, cut back to the bound');
  assert.deepEqual([s.following, s.notices, s.pieces[0].text.slice(0, 2)], [false, ['earlier', 'paused'], '04']);
  await r.log.loadEarlier();
  s = r.last();
  assert.equal(s.to - s.from <= mod.LOG_HOLD_BYTES, true);
  assert.equal(s.following, false);
  assert.deepEqual(s.notices, ['paused'], 'nothing earlier than byte 0');
  assert.equal(s.pieces[0].text.slice(0, 2), '00', 'the held text reaches the start of the file');
  assert.equal(s.from, 0);
  assert.equal(texts(s).includes(lines[39]), false, 'the newest pieces were dropped');
  assert.equal(r.store.position(), null, 'a paused stream gives no position, so a reopen sends a snapshot');
  // While paused, live text is not merged, but phase and end are.
  const held = s.to;
  r.file.add('fresh');
  r.store.emit(r.file.append(r.file.size() - 6, r.file.size()));
  await flush();
  assert.equal(r.last().to, held);
  assert.deepEqual(texts(r.last()).includes('fresh'), false);
  // Jump to newest: a tail page replaces the held text and following starts again.
  const calls = r.file.calls.length;
  await r.log.jumpToNewest();
  assert.equal(r.file.calls.length, calls + 1);
  assert.equal(r.file.calls.at(-1), BASE);
  s = r.last();
  assert.equal(s.following, true);
  assert.equal(s.to, r.file.size());
  assert.equal(texts(s).at(-1), 'fresh');
  assert.deepEqual(s.notices, ['earlier']);
  assert.equal(r.store.position(), `77:${r.file.size()}`);
  // Nothing earlier than byte 0.
  const whole = await rig({ lines: ['only'] });
  await whole.log.loadEarlier();
  assert.equal(whole.file.calls.length, 1);
});

// ---- polling, return to live --------------------------------------------------------------------------

test('polling: while the connector is down, forward reads every POLL_MS while visible and not paused; live again stops them', async () => {
  const r = await rig({ lines: ['l0'] });
  r.store.state('closed');
  assert.equal(r.last().mode, 'polling');
  await r.clock.advance(2999);
  assert.equal(r.file.calls.length, 1);
  r.file.add('l1');
  await r.clock.advance(1);
  assert.equal(r.file.calls.at(-1), `${BASE}&cursor=${encodeURIComponent('77:3:0:0')}`);
  assert.deepEqual(texts(r.last()), ['l0', 'l1']);
  await r.clock.advance(3000);
  assert.equal(r.file.calls.length, 3);
  assert.equal(r.file.calls.at(-1), `${BASE}&cursor=${encodeURIComponent('77:6:0:0')}`);
  // Hidden or paused: no read; back: reads resume.
  r.store.state('hidden');
  await r.clock.advance(9000);
  assert.equal(r.file.calls.length, 3);
  r.store.state('refused', 'stream-limit');
  await r.clock.advance(3000);
  assert.equal(r.file.calls.length, 4);
  r.store.state('paused');
  await r.clock.advance(9000);
  assert.equal(r.file.calls.length, 4);
  r.store.state('closed');
  await r.clock.advance(3000);
  assert.equal(r.file.calls.length, 5);
  // Live returns: an open stream; the subscription stayed, so the store's reopen carries since at the held ino:to.
  r.store.state('open');
  assert.equal(r.last().mode, 'live');
  assert.equal(r.store.position(), `77:${r.file.size()}`);
  await r.clock.advance(30000);
  assert.equal(r.file.calls.length, 5, 'no timer-driven read while live');
  assert.equal(r.store.subs.length, 1);
});

test('polling: a channel error polls too, the next frame on the channel returns to live, and an ended run is not polled', async () => {
  const r = await rig({ lines: ['l0'] });
  r.store.emit({ kind: 'error', state: null, code: 'events-down' });
  assert.equal(r.last().mode, 'polling');
  r.store.state('open');
  assert.equal(r.last().mode, 'polling', 'an open stream with the lane in error is not live');
  await r.clock.advance(3000);
  assert.equal(r.file.calls.length, 2);
  r.file.add('l1');
  r.store.emit(r.file.snapshot(1 << 17));
  await flush();
  assert.equal(r.last().mode, 'live');
  await r.clock.advance(9000);
  assert.equal(r.file.calls.length, 2);
  // Polling an ended run: the page that says ended is the last read.
  r.store.state('closed');
  r.file.phase = 'ended';
  r.file.capped = false;
  await r.clock.advance(3000);
  assert.equal(r.file.calls.length, 3);
  assert.deepEqual(r.last().end, { capped: false });
  await r.clock.advance(30000);
  assert.equal(r.file.calls.length, 3);
});

test('polling: a stream opened while the connector is down polls from the start, and a waiting stream polls with tail reads', async () => {
  const file = fakeFile();
  file.log = 'waiting';
  const store = fakeStore('unsupported');
  const clock = fakeClock();
  const log = mod.createLogStream({ apiGet: file.apiGet, store, clock, slug: 'feat-a', runId: RUN, stream: 'out' });
  const states: any[] = [];
  log.onChange((s: any) => states.push(s));
  await log.open();
  assert.equal(states.at(-1).mode, 'polling');
  file.log = null;
  file.add('hello');
  await clock.advance(3000);
  assert.deepEqual(file.calls, [BASE, BASE]);
  assert.deepEqual([states.at(-1).log, texts(states.at(-1)), states.at(-1).notices], ['open', ['hello'], []]);
  await clock.advance(3000);
  assert.equal(file.calls.at(-1), `${BASE}&cursor=${encodeURIComponent('77:6:0:0')}`);
});

// ---- reset, gone, capped end, 501 and 404 -------------------------------------------------------------

test('reset: the channel\'s reset clears the held text and says so; the next snapshot replaces it; a reset page does the same', async () => {
  const r = await rig({ lines: ['old1', 'old2'] });
  r.store.emit({ kind: 'reset', state: null, code: 'replaced' });
  await flush();
  assert.deepEqual([r.last().ino, r.last().pieces, r.last().notices], [null, [], ['reset']]);
  assert.equal(r.store.position(), null);
  r.file.ino = '88';
  r.file.lines = ['new'];
  r.store.emit(r.file.snapshot(1 << 17));
  await flush();
  assert.deepEqual([r.last().ino, texts(r.last()), r.last().notices], ['88', ['new'], ['reset']]);
  // Polling over a replaced file: the forward read comes back as a reset tail page.
  r.store.state('closed');
  r.file.ino = '99';
  r.file.lines = ['newer'];
  await r.clock.advance(3000);
  assert.deepEqual([r.last().ino, texts(r.last()), r.last().notices], ['99', ['newer'], ['reset']]);
  await r.log.jumpToNewest();
  assert.deepEqual(r.last().notices, [], 'Jump to newest shows a fresh tail');
});

test('gone: the channel\'s gone keeps the text read so far, says gone and reads nothing more; a gone page at first paint subscribes to nothing', async () => {
  const r = await rig({ lines: ['l0'] });
  r.store.state('closed');
  r.store.emit({ kind: 'gone', state: null, code: null });
  await flush();
  assert.deepEqual([r.last().log, r.last().mode, texts(r.last()), r.last().notices], ['gone', 'gone', ['l0'], ['gone']]);
  await r.clock.advance(30000);
  assert.equal(r.file.calls.length, 1);
  const file = fakeFile();
  file.log = 'gone';
  file.phase = 'ended';
  const store = fakeStore();
  const log = mod.createLogStream({ apiGet: file.apiGet, store, clock: fakeClock(), slug: 'feat-a', runId: RUN, stream: 'out' });
  const states: any[] = [];
  log.onChange((s: any) => states.push(s));
  await log.open();
  assert.deepEqual([states.at(-1).log, states.at(-1).mode, states.at(-1).notices], ['gone', 'gone', ['gone']]);
  assert.equal(store.subs.length, 0);
});

test('capped end: an ended run whose output was capped says capped; a withheld piece says withheld', async () => {
  const r = await rig({ lines: ['l0'] });
  const at = r.file.size();
  r.store.emit({ kind: 'append', code: null, id: `77:${at + 10}:1:0`, state: { from: at, to: at + 10, pieces: [{ at, text: '', withheld: true }], phase: 'ended', end: { capped: true } } });
  await flush();
  assert.deepEqual([r.last().phase, r.last().end, r.last().notices], ['ended', { capped: true }, ['withheld', 'capped']]);
  assert.deepEqual(r.last().pieces.at(-1), { at, text: '', withheld: true });
  const file = fakeFile();
  file.add('x');
  file.phase = 'ended';
  file.capped = true;
  const log = mod.createLogStream({ apiGet: file.apiGet, store: fakeStore(), clock: fakeClock(), slug: 'feat-a', runId: RUN, stream: 'out' });
  const states: any[] = [];
  log.onChange((s: any) => states.push(s));
  await log.open();
  assert.deepEqual([states.at(-1).end, states.at(-1).notices], [{ capped: true }, ['capped']]);
});

test('501 and 404: a core without worker logs stops at not-in-core, an unknown run at not-found; neither subscribes nor reads again', async () => {
  for (const [status, code, mode] of [[501, 'core-lacks-verb', 'not-in-core'], [404, 'unknown-run', 'not-found']]) {
    const file = fakeFile();
    file.fail.push({ status, code, network: false });
    const store = fakeStore();
    const clock = fakeClock();
    const log = mod.createLogStream({ apiGet: file.apiGet, store, clock, slug: 'feat-a', runId: RUN, stream: 'out' });
    const states: any[] = [];
    log.onChange((s: any) => states.push(s));
    await log.open();
    assert.deepEqual([states.at(-1).mode, states.at(-1).error], [mode, { status, code, network: false }]);
    assert.equal(store.subs.length, 0);
    await clock.advance(60000);
    await log.loadEarlier();
    await log.jumpToNewest();
    assert.equal(file.calls.length, 1, String(status));
  }
  // Any other failure of the first paint is `failed`; open() tries again.
  const file = fakeFile();
  file.add('back');
  file.fail.push({ status: null, code: null, network: true });
  const store = fakeStore();
  const log = mod.createLogStream({ apiGet: file.apiGet, store, clock: fakeClock(), slug: 'feat-a', runId: RUN, stream: 'out' });
  const states: any[] = [];
  log.onChange((s: any) => states.push(s));
  await log.open();
  assert.deepEqual([states.at(-1).mode, states.at(-1).error], ['failed', { status: null, code: null, network: true }]);
  assert.equal(store.subs.length, 0);
  await log.open();
  assert.deepEqual([states.at(-1).mode, states.at(-1).error, texts(states.at(-1))], ['live', null, ['back']]);
  assert.equal(store.subs.length, 1);
});

test('a 404 while polling stops the stream at not-found', async () => {
  const r = await rig({ lines: ['l0'] });
  r.store.state('closed');
  r.file.fail.push({ status: 404, code: 'unknown-run', network: false });
  await r.clock.advance(3000);
  assert.equal(r.last().mode, 'not-found');
  assert.equal(r.store.subs[0].off, true);
  await r.clock.advance(30000);
  assert.equal(r.file.calls.length, 2);
});

// ---- close, listeners, memory -------------------------------------------------------------------------

test('close: unsubscribes, stops polling and drops late answers; onChange answers at once and its unsubscribe stops delivery', async () => {
  const r = await rig({ lines: ['l0'] });
  const seen: any[] = [];
  const off = r.log.onChange((s: any) => seen.push(s));
  assert.equal(seen.length, 1, 'the current state at once');
  off();
  r.store.state('closed');
  r.file.hold = true;
  await r.clock.advance(3000);
  const count = r.states.length;
  r.log.close();
  r.file.release();
  await flush();
  assert.equal(r.store.subs[0].off, true);
  assert.equal(r.states.length, count, 'nothing after close');
  await r.clock.advance(30000);
  assert.equal(r.file.calls.length, 2);
  assert.deepEqual(r.clock.timers, []);
  assert.equal(seen.length, 1);
});

test('source: log-store.js keeps everything in memory and opens no connection of its own', () => {
  const text = fs.readFileSync(path.join(WEB_ROOT, 'log-store.js'), 'utf8');
  assert.doesNotMatch(text, /\b(?:localStorage|sessionStorage|indexedDB|caches|CacheStorage|openDatabase|document\.cookie)\b/);
  assert.doesNotMatch(text, /\bEventSource\b|\bfetch\s*\(|\bsetInterval\b|\bhttps?:/);
});
