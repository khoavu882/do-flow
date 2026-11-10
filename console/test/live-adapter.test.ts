'use strict';

// The live transport adapter (feature 149, IC-016; plan task C.1). Like live-discipline.test.ts, the web modules are copied
// beside a {"type":"module"} marker and imported; the EventSource, the probe and the clock are fakes, so nothing opens a
// socket or waits in real time.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let live: any;

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-live-adapter-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  live = await import(pathToFileURL(path.join(copy, 'live.js')).href);
});
after(() => { fs.rmSync(copy, { recursive: true, force: true }); });

const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  listeners = new Map<string, Function[]>();
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; FakeSource.all.push(this); }
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close() { this.closed = true; this.readyState = 2; }
  fire(type: string, event: unknown = {}) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  message(data: unknown) { this.fire('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  fail(readyState: number) { this.readyState = readyState; this.fire('error', {}); }
}

type Answer = { status: number, code: string | null } | Error;

function rig(answers: Answer[] = []) {
  FakeSource.all = [];
  const clock = { time: 1000, now: () => clock.time };
  const probes: string[] = [];
  const pending: Array<() => void> = [];
  let hold = false;
  const probe = (url: string) => {
    probes.push(url);
    const answer = answers.shift() ?? { status: 500, code: null };
    return new Promise((resolve, reject) => {
      const settle = () => (answer instanceof Error ? reject(answer) : resolve(answer));
      if (hold) pending.push(settle);
      else settle();
    });
  };
  const adapter = live.createLiveAdapter({ EventSource: FakeSource, probe, clock });
  const states: any[] = [];
  const frames: any[] = [];
  adapter.onState((s: any) => states.push(s));
  adapter.onFrame((f: any) => frames.push(f));
  return { adapter, clock, probes, states, frames, hold: () => { hold = true; }, release: () => { for (const fn of pending.splice(0)) fn(); } };
}

const words = (states: any[]) => states.map((s) => (s.code === null ? s.state : `${s.state}:${s.code}`));

const ENVELOPE = { v: 1, ch: 'run:feat-a:run-1', id: '3f9a0c12-17', type: 'patch', at: '2026-11-07T12:00:00.000Z', data: { set: { '/run/body/state': 'RUNNING' }, unset: [] } };
/** 150 IC-007's example: an `append` on a log channel with its byte-cursor id. */
const LOG_ENVELOPE = { v: 1, ch: 'worker:w-1a2b3c4d5e6f:out', id: '8812345:4096:3:1762581600000', type: 'append', at: '2026-11-08T05:00:00.000Z', data: { from: 3072, to: 4096, pieces: [{ at: 3072, text: 'tests passed' }], phase: 'running', end: null } };

// ---- the URL ------------------------------------------------------------------------------------------

test('url: ch is the comma-joined channels encoded, since is the encoded vector, and no since when null', () => {
  const r = rig();
  r.adapter.open(['run:a.b:c', 'now'], '0a1b2c3d/run:a.b:c=4,now=2');
  assert.equal(FakeSource.all[0].url, `/api/live?ch=${encodeURIComponent('run:a.b:c,now')}&since=${encodeURIComponent('0a1b2c3d/run:a.b:c=4,now=2')}`);
  assert.equal(FakeSource.all[0].url, '/api/live?ch=run%3Aa.b%3Ac%2Cnow&since=0a1b2c3d%2Frun%3Aa.b%3Ac%3D4%2Cnow%3D2');
  r.adapter.open(['run:a.b:c'], null);
  assert.equal(FakeSource.all[1].url, '/api/live?ch=run%3Aa.b%3Ac');
  r.adapter.open(['now']);
  assert.equal(FakeSource.all[2].url, '/api/live?ch=now');
  assert.equal(FakeSource.all[0].closed && FakeSource.all[1].closed, true, 'each open closes the source before it');
});

// ---- frames -------------------------------------------------------------------------------------------

test('frames: a valid message is delivered as the parsed envelope, for every IC-012 type and channel kind', () => {
  const r = rig();
  r.adapter.open(['now'], null);
  const src = FakeSource.all[0];
  src.message(ENVELOPE);
  assert.deepEqual(r.frames, [ENVELOPE]);
  const types = ['snapshot', 'patch', 'reset', 'error', 'gone'];
  const channels = ['now', 'run:feat-a:A.1', 'tasks:feat-a', 'worker:w-0123456789ab', `tasks:a${'b'.repeat(55)}`];
  types.forEach((type, i) => src.message({ ...ENVELOPE, type, ch: channels[i], id: `abcdef01-${i + 1}`, data: {} }));
  assert.equal(r.frames.length, 6);
  assert.deepEqual(r.frames.slice(1).map((f: any) => f.type), types);
  src.message({ ...ENVELOPE, id: '00000000-1234567890123456' });
  assert.equal(r.frames.length, 7, '16 digits is the bound');
});

test('frames: a log channel envelope with an IC-007 log id is delivered, append included, for out and err (150 IC-006, IC-007)', () => {
  const r = rig();
  r.adapter.open(['worker:w-1a2b3c4d5e6f:out'], null);
  const src = FakeSource.all[0];
  src.message(LOG_ENVELOPE);
  assert.deepEqual(r.frames, [LOG_ENVELOPE], 'an append on a log channel is accepted');
  const types = ['snapshot', 'append', 'reset', 'error', 'gone'];
  types.forEach((type, i) => src.message({ ...LOG_ENVELOPE, type, ch: `worker:w-1a2b3c4d5e6f:${i % 2 === 0 ? 'err' : 'out'}`, id: `0:0:${i + 1}:0`, data: {} }));
  assert.deepEqual(r.frames.slice(1).map((f: any) => f.type), types);
  src.message({ ...LOG_ENVELOPE, id: `${'9'.repeat(20)}:${'9'.repeat(16)}:${'9'.repeat(16)}:${'9'.repeat(16)}` });
  assert.equal(r.frames.length, 7, '20 digits of inode and 16 of offset, counter and clock are the bounds');
  assert.deepEqual([...live.LOG_FRAME_TYPES], types);
  assert.equal(live.LOG_ID.test('8812345:4096:3:1762581600000'), true);
  // The old refusals stay: the envelope of :108 (a log channel with an epoch id and a patch) and of :112 (an append on run:) are dropped.
  src.message({ ...ENVELOPE, ch: 'worker:w-0123456789ab:out' });
  src.message({ ...ENVELOPE, type: 'append' });
  assert.equal(r.frames.length, 7);
});

test('isChannel: the two log channels are channels; every other worker stream is not (150 IC-006)', () => {
  for (const ch of ['now', 'run:a:b', 'tasks:a', 'worker:w-0123456789ab', 'worker:w-0123456789ab:out', 'worker:w-0123456789ab:err']) assert.equal(live.isChannel(ch), true, ch);
  for (const ch of ['worker:w-0123456789ab:last', 'worker:w-0123456789ab:x', 'worker:w-0123456789ab:', 'worker:w-0123456789ab:out:x', 'worker:w-0123456789AB:out', 'worker:x:out', 'worker:out', 'tasks:a:out']) assert.equal(live.isChannel(ch), false, ch);
});

test('frames: every message failing the envelope grammar is dropped', () => {
  const r = rig();
  r.adapter.open(['now'], null);
  const src = FakeSource.all[0];
  const bad: unknown[] = [
    { ...ENVELOPE, v: 2 }, { ...ENVELOPE, v: '1' }, (({ v, ...rest }) => rest)(ENVELOPE),
    { ...ENVELOPE, ch: 'fleet:p1' }, { ...ENVELOPE, ch: 'worker:w-0123456789ab:out' }, { ...ENVELOPE, ch: 'worker:w-0123456789AB' },
    { ...ENVELOPE, ch: 'run:feat-a' }, { ...ENVELOPE, ch: 'tasks:.a' }, { ...ENVELOPE, ch: `tasks:a${'b'.repeat(56)}` }, { ...ENVELOPE, ch: 'Now' }, { ...ENVELOPE, ch: 7 },
    { ...ENVELOPE, id: '3f9a0c12-0' }, { ...ENVELOPE, id: '3F9A0C12-1' }, { ...ENVELOPE, id: '3f9a0c1-1' }, { ...ENVELOPE, id: '3f9a0c12-01' },
    { ...ENVELOPE, id: '3f9a0c12-12345678901234567' }, { ...ENVELOPE, id: 17 },
    { ...ENVELOPE, type: 'append' }, { ...ENVELOPE, type: 'fleet' }, { ...ENVELOPE, type: 'Snapshot' }, { ...ENVELOPE, type: undefined },
    { ...ENVELOPE, at: 0 }, (({ at, ...rest }) => rest)(ENVELOPE),
    { ...ENVELOPE, data: [] }, { ...ENVELOPE, data: null }, { ...ENVELOPE, data: 'x' }, (({ data, ...rest }) => rest)(ENVELOPE),
    [ENVELOPE], 'null', '1', '"text"',
    // 150 IC-006 and IC-007: the log kind is out and err only, with a log id; append is a log channel's frame only (D4).
    { ...LOG_ENVELOPE, ch: 'worker:w-0123456789ab:last' }, { ...LOG_ENVELOPE, ch: 'worker:w-0123456789ab:x' }, { ...LOG_ENVELOPE, ch: 'worker:w-0123456789ab:' },
    { ...LOG_ENVELOPE, ch: 'worker:w-0123456789AB:out' }, { ...LOG_ENVELOPE, ch: 'worker:w-0123456789ab:out:1' },
    { ...LOG_ENVELOPE, ch: 'run:feat-a:run-1' }, { ...LOG_ENVELOPE, ch: 'now', id: 'abcdef01-1' }, { ...LOG_ENVELOPE, ch: 'tasks:feat-a', id: 'abcdef01-1' },
    { ...LOG_ENVELOPE, id: '3f9a0c12-17' }, { ...ENVELOPE, id: LOG_ENVELOPE.id }, { ...ENVELOPE, type: 'snapshot', id: LOG_ENVELOPE.id },
    { ...LOG_ENVELOPE, type: 'patch' }, { ...LOG_ENVELOPE, type: 'Append' },
    { ...LOG_ENVELOPE, id: '8812345:4096:0:1762581600000' }, { ...LOG_ENVELOPE, id: '8812345:4096:03:1762581600000' },
    { ...LOG_ENVELOPE, id: '8812345:4096:3' }, { ...LOG_ENVELOPE, id: '8812345:4096:3:1:2' }, { ...LOG_ENVELOPE, id: 'a812345:4096:3:1' },
    { ...LOG_ENVELOPE, id: `${'1'.repeat(21)}:4096:3:1` }, { ...LOG_ENVELOPE, id: `1:${'1'.repeat(17)}:3:1` },
    { ...LOG_ENVELOPE, id: '1:1:12345678901234567:1' }, { ...LOG_ENVELOPE, id: `1:1:1:${'1'.repeat(17)}` }, { ...LOG_ENVELOPE, id: ':1:1:1' },
    { ...LOG_ENVELOPE, data: [] },
  ];
  for (const body of bad) src.message(body);
  src.message('{not json');
  src.message('');
  src.fire('message', { data: undefined });
  src.fire('message', undefined);
  assert.deepEqual(r.frames, []);
  src.message(ENVELOPE);
  assert.equal(r.frames.length, 1, 'the source keeps going after a dropped message');
});

test('frames: frames come only as unnamed messages; the one named event listened to is keepalive, which is no frame (DEC-028)', () => {
  const r = rig();
  r.adapter.open(['now'], null);
  assert.deepEqual([...FakeSource.all[0].listeners.keys()].sort(), ['error', 'keepalive', 'message', 'open']);
  FakeSource.all[0].fire('keepalive', { data: JSON.stringify(ENVELOPE) });
  assert.deepEqual(r.frames, [], 'a keepalive is never delivered as a frame');
});

// ---- states -------------------------------------------------------------------------------------------

test('states: connecting on open, open on the source\'s open, at from the injected clock, code null', () => {
  const r = rig();
  r.adapter.open(['now'], null);
  assert.deepEqual(r.states, [{ state: 'connecting', code: null, at: 1000 }]);
  r.clock.time = 2500;
  FakeSource.all[0].readyState = 1;
  FakeSource.all[0].fire('open');
  assert.deepEqual(r.states[1], { state: 'open', code: null, at: 2500 });
});

test('states: every error while CONNECTING is one retrying with no probe, and the reopened source is open again', async () => {
  const r = rig();
  r.adapter.open(['now'], null);
  const src = FakeSource.all[0];
  src.readyState = 1;
  src.fire('open');
  src.fail(0);
  src.fail(0);
  src.fail(0);
  await flush();
  assert.deepEqual(words(r.states), ['connecting', 'open', 'retrying', 'retrying', 'retrying'], 'one retrying per failed reconnect');
  assert.deepEqual(r.probes, []);
  assert.equal(src.closed, false, 'the browser keeps reconnecting the same source');
  src.readyState = 1;
  src.fire('open');
  assert.deepEqual(words(r.states), ['connecting', 'open', 'retrying', 'retrying', 'retrying', 'open']);
  assert.equal(FakeSource.all.length, 1);
});

// ---- with the real store (IC-016 + IC-017, DEC-041) ---------------------------------------------------

function fakeTimers(start = 1000) {
  let time = start;
  let seq = 0;
  const timers = new Map<number, { at: number, fn: () => void }>();
  return {
    now: () => time,
    setTimeout: (fn: () => void, ms: number) => { seq += 1; timers.set(seq, { at: time + ms, fn }); return seq; },
    clearTimeout: (handle: number) => { timers.delete(handle); },
    pending: () => timers.size,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = end;
    },
  };
}

async function storeRig() {
  const store = await import(pathToFileURL(path.join(copy, 'store.js')).href);
  FakeSource.all = [];
  const clock = fakeTimers();
  const probes: string[] = [];
  const adapter = live.createLiveAdapter({ EventSource: FakeSource, probe: async (url: string) => { probes.push(url); return { status: 500, code: null }; }, clock });
  const liveStore = store.createLiveStore({ adapter, clock, visibility: { hidden: () => false, subscribe: () => () => {} } });
  const transport: any[] = [];
  liveStore.onTransport((s: any) => transport.push(s));
  const events: any[] = [];
  liveStore.subscribe('now', (e: any) => events.push(e));
  clock.advance(50);
  assert.equal(FakeSource.all.length, 1, 'the store opens one source after 50 ms');
  const src = FakeSource.all[0];
  src.readyState = 1;
  src.fire('open');
  return { store, liveStore, clock, src, transport, events, probes };
}

test('with the store: RETRYING_LIMIT CONNECTING errors in a row are refused retry-limit, and the store reopens only after REFUSED_RETRY_MS', async () => {
  const r = await storeRig();
  assert.equal(r.store.RETRYING_LIMIT, 3);
  assert.equal(r.store.REFUSED_RETRY_MS, 30000);
  for (let i = 0; i < r.store.RETRYING_LIMIT; i += 1) r.src.fail(0);
  await flush();
  const last = r.transport[r.transport.length - 1];
  assert.deepEqual([last.state, last.code], ['refused', 'retry-limit']);
  assert.equal(r.liveStore.status().transport, 'refused');
  assert.equal(r.src.closed, true, 'the store closed the source through the adapter');
  assert.deepEqual(r.probes, []);
  r.clock.advance(r.store.REFUSED_RETRY_MS - 1);
  assert.equal(FakeSource.all.length, 1, 'no new EventSource before REFUSED_RETRY_MS');
  r.clock.advance(1);
  assert.equal(FakeSource.all.length, 2, 'one new EventSource at REFUSED_RETRY_MS');
  assert.equal(FakeSource.all[1].url, '/api/live?ch=now');
});

test('with the store: two errors, a valid frame, two errors is no refusal', async () => {
  const r = await storeRig();
  r.src.fail(0);
  r.src.fail(0);
  r.src.message({ ...ENVELOPE, ch: 'now', type: 'snapshot', id: '3f9a0c12-1', data: { state: { ok: true } } });
  r.src.fail(0);
  r.src.fail(0);
  await flush();
  assert.equal(r.events.length, 1, 'the frame reached the store');
  assert.equal(r.transport.some((s: any) => s.state === 'refused'), false);
  assert.equal(r.liveStore.status().transport, 'retrying');
  assert.equal(r.src.closed, false);
  r.clock.advance(r.store.REFUSED_RETRY_MS);
  assert.equal(FakeSource.all.length, 1, 'nothing reopened');
});

const MAPPINGS: Array<[string, Answer, string]> = [
  ['429', { status: 429, code: 'stream-limit' }, 'refused:stream-limit'],
  ['429 with no body code', { status: 429, code: null }, 'refused:stream-limit'],
  ['503', { status: 503, code: 'live-unavailable' }, 'unsupported:live-unavailable'],
  ['401 with the body code', { status: 401, code: 'session-required' }, 'refused:session-required'],
  ['403 with the body code', { status: 403, code: 'origin-refused' }, 'refused:origin-refused'],
  ['403 with no body code', { status: 403, code: null }, 'refused'],
  ['400', { status: 400, code: 'usage' }, 'closed'],
  ['500', { status: 500, code: null }, 'closed'],
  ['200', { status: 200, code: null }, 'closed'],
  ['a rejected probe', new Error('network'), 'closed'],
];

for (const [name, answer, expected] of MAPPINGS) {
  test(`states: an error while CLOSED probes the same URL once; ${name} is ${expected}, and nothing reopens`, async () => {
    const r = rig([answer]);
    r.adapter.open(['run:a.b:c', 'now'], 'deadbeef/now=3');
    const src = FakeSource.all[0];
    src.fail(2);
    await flush();
    assert.deepEqual(r.probes, [src.url], 'one probe of the stream URL');
    assert.equal(src.closed, true, 'the given-up source is closed');
    assert.deepEqual(words(r.states), ['connecting', expected]);
    src.fail(2);
    src.message(ENVELOPE);
    await flush();
    assert.equal(FakeSource.all.length, 1, 'no new EventSource after the probe');
    assert.equal(r.probes.length, 1);
    assert.deepEqual(r.frames, []);
    assert.equal(r.states.length, 2);
  });
}

test('states: the probe answer of a stream closed or replaced before it settled changes nothing', async () => {
  const r = rig([{ status: 429, code: null }, { status: 503, code: null }]);
  r.hold();
  r.adapter.open(['now'], null);
  FakeSource.all[0].fail(2);
  r.adapter.close();
  r.release();
  await flush();
  assert.deepEqual(words(r.states), ['connecting'], 'close() is silent and the late probe is dropped');
  r.adapter.open(['now'], null);
  FakeSource.all[1].fail(2);
  r.adapter.open(['tasks:feat-a'], null);
  r.release();
  await flush();
  assert.deepEqual(words(r.states), ['connecting', 'connecting', 'connecting']);
  assert.equal(r.probes.length, 2);
});

test('states: events of a closed or replaced source change nothing', () => {
  const r = rig();
  r.adapter.open(['now'], null);
  const first = FakeSource.all[0];
  r.adapter.open(['tasks:feat-a'], null);
  assert.equal(first.closed, true);
  first.fire('open');
  first.message(ENVELOPE);
  first.fail(0);
  assert.deepEqual(words(r.states), ['connecting', 'connecting']);
  assert.deepEqual(r.frames, []);
  const second = FakeSource.all[1];
  r.adapter.close();
  assert.equal(second.closed, true);
  second.fire('open');
  second.message(ENVELOPE);
  second.fail(2);
  assert.deepEqual(words(r.states), ['connecting', 'connecting']);
  assert.deepEqual(r.frames, []);
  assert.equal(FakeSource.all.length, 2);
});

test('states: with no EventSource constructor open is unsupported no-eventsource and opens nothing', async () => {
  for (const EventSource of [undefined, null]) {
    const probes: string[] = [];
    const states: any[] = [];
    const adapter = live.createLiveAdapter({ EventSource, probe: async (url: string) => { probes.push(url); return { status: 200, code: null }; }, clock: { now: () => 42 } });
    adapter.onState((s: any) => states.push(s));
    adapter.open(['now'], null);
    await flush();
    assert.deepEqual(states, [{ state: 'unsupported', code: live.NO_EVENTSOURCE, at: 42 }]);
    assert.equal(live.NO_EVENTSOURCE, 'no-eventsource');
    assert.deepEqual(probes, []);
  }
});

// ---- silence (FU-mnes07): a frozen server keeps the socket open and sends nothing ----------------------

function silentRig() {
  FakeSource.all = [];
  const clock = fakeTimers();
  const probes: string[] = [];
  const adapter = live.createLiveAdapter({ EventSource: FakeSource, probe: async (url: string) => { probes.push(url); return { status: 500, code: null }; }, clock });
  const states: any[] = [];
  const frames: any[] = [];
  adapter.onState((s: any) => states.push(s));
  adapter.onFrame((f: any) => frames.push(f));
  return { adapter, clock, probes, states, frames };
}

test('silence: SILENT_MS with no open, message or keepalive closes the source and reports closed silent at the last heard time, with no probe', async () => {
  assert.equal(live.SILENT_MS, 30000);
  const r = silentRig();
  r.adapter.open(['now'], null);
  const src = FakeSource.all[0];
  r.clock.advance(500);
  src.readyState = 1;
  src.fire('open');
  const heardAt = r.clock.now();
  r.clock.advance(live.SILENT_MS - 1);
  assert.deepEqual(words(r.states), ['connecting', 'open']);
  assert.equal(src.closed, false, 'one ms before SILENT_MS the source stays');
  r.clock.advance(1);
  assert.equal(src.closed, true, 'the silent source is closed');
  assert.deepEqual(r.states.at(-1), { state: 'closed', code: 'silent', at: heardAt });
  await flush();
  assert.deepEqual(r.probes, [], 'no probe on the silence path');
  assert.equal(r.clock.pending(), 0, 'no timer left');
  // Nothing of the closed source counts later, and nothing reopens here.
  src.fire('open');
  src.fire('keepalive', { data: '{}' });
  src.message(ENVELOPE);
  src.fail(2);
  r.clock.advance(live.SILENT_MS * 2);
  await flush();
  assert.equal(r.states.length, 3);
  assert.deepEqual(r.frames, []);
  assert.deepEqual(r.probes, []);
  assert.equal(FakeSource.all.length, 1);
});

test('silence: every message (valid or not) and every keepalive re-arms the timer; the state is silent from the last one', () => {
  const r = silentRig();
  r.adapter.open(['now'], null);
  const src = FakeSource.all[0];
  src.readyState = 1;
  src.fire('open');
  r.clock.advance(20_000);
  src.message(ENVELOPE);
  r.clock.advance(20_000);
  src.message('{not json');
  r.clock.advance(20_000);
  src.fire('keepalive', { data: '{}' });
  const lastHeard = r.clock.now();
  assert.equal(r.clock.pending(), 1, 'one silence timer per open source');
  r.clock.advance(live.SILENT_MS - 1);
  assert.equal(src.closed, false, '60 s in, heard 30 s ago less 1 ms: still open');
  assert.equal(r.frames.length, 1, 'the valid message was delivered');
  r.clock.advance(1);
  assert.equal(src.closed, true);
  assert.deepEqual(words(r.states), ['connecting', 'open', 'closed:silent']);
  assert.equal(r.states.at(-1).at, lastHeard);
});

test('silence: close() and a later open() leave no timer of the old source, and close() reports nothing', () => {
  const r = silentRig();
  r.adapter.open(['now'], null);
  assert.equal(r.clock.pending(), 1);
  r.adapter.open(['tasks:feat-a'], null);
  assert.equal(r.clock.pending(), 1, 'the reopen replaced the timer');
  r.adapter.close();
  assert.equal(r.clock.pending(), 0, 'close() leaves no timer');
  r.clock.advance(live.SILENT_MS * 2);
  assert.deepEqual(words(r.states), ['connecting', 'connecting'], 'no state after close');
});

test('silence: when the browser gives up the probe path runs as before and the silence timer is gone', async () => {
  const r = silentRig();
  r.adapter.open(['now'], null);
  const src = FakeSource.all[0];
  src.fail(2);
  await flush();
  assert.equal(r.clock.pending(), 0);
  assert.deepEqual(words(r.states), ['connecting', 'closed']);
  r.clock.advance(live.SILENT_MS * 2);
  assert.deepEqual(words(r.states), ['connecting', 'closed'], 'one closed, from the probe');
  assert.equal(r.probes.length, 1);
});

test('silence: errors while the browser reconnects do not re-arm the timer; the source goes silent 30 s after it last heard something', () => {
  const r = silentRig();
  r.adapter.open(['now'], null);
  const src = FakeSource.all[0];
  src.readyState = 1;
  src.fire('open');
  const heardAt = r.clock.now();
  r.clock.advance(10_000);
  src.fail(0);
  r.clock.advance(10_000);
  src.fail(0);
  r.clock.advance(10_000);
  assert.deepEqual(words(r.states), ['connecting', 'open', 'retrying', 'retrying', 'closed:silent']);
  assert.equal(r.states.at(-1).at, heardAt);
  assert.equal(src.closed, true);
});

test('silence: without clock timers the timer is the global one, unref\'d so it never holds the process', () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const made: any[] = [];
  const cleared: any[] = [];
  (globalThis as any).setTimeout = (fn: () => void, ms: number) => {
    const handle = { fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } };
    made.push(handle);
    return handle;
  };
  (globalThis as any).clearTimeout = (handle: any) => { cleared.push(handle); };
  try {
    FakeSource.all = [];
    const adapter = live.createLiveAdapter({ EventSource: FakeSource, probe: async () => ({ status: 500, code: null }), clock: { now: () => 5 } });
    adapter.open(['now'], null);
    assert.equal(made.length, 1);
    assert.equal(made[0].ms, live.SILENT_MS);
    assert.equal(made[0].unrefd, true);
    adapter.close();
    assert.deepEqual(cleared, [made[0]]);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test('listeners: the unsubscribe functions stop delivery', () => {
  const r = rig();
  const states: any[] = [];
  const frames: any[] = [];
  const offState = r.adapter.onState((s: any) => states.push(s));
  const offFrame = r.adapter.onFrame((f: any) => frames.push(f));
  r.adapter.open(['now'], null);
  FakeSource.all[0].message(ENVELOPE);
  offState();
  offFrame();
  FakeSource.all[0].fire('open');
  FakeSource.all[0].message(ENVELOPE);
  assert.equal(states.length, 1);
  assert.equal(frames.length, 1);
  assert.equal(r.frames.length, 2, 'other listeners still get them');
});

test('exports: the state words and frame types are the IC-016 and IC-012 sets', () => {
  assert.deepEqual([...live.LIVE_STATES], ['connecting', 'open', 'retrying', 'refused', 'unsupported', 'closed']);
  assert.deepEqual([...live.FRAME_TYPES], ['snapshot', 'patch', 'reset', 'error', 'gone']);
  assert.deepEqual([live.CONNECTING, live.OPEN, live.CLOSED], [0, 1, 2]);
});

test('source: live.js names no storage API and no absolute URL', () => {
  const text = fs.readFileSync(path.join(WEB_ROOT, 'live.js'), 'utf8');
  assert.doesNotMatch(text, /\b(?:localStorage|sessionStorage|indexedDB|caches|CacheStorage|openDatabase|document\.cookie)\b/);
  assert.doesNotMatch(text, /\bhttps?:/i);
  assert.doesNotMatch(text, /^\s*import\b/m, 'the adapter needs no module');
});
