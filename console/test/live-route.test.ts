'use strict';

// GET /api/live (feature 149, IC-011, IC-013, IC-014, IC-015).
//   A. live-stream.ts over a fake hub, a fake request, a fake response whose `writableLength` and
//      `drain` a case controls, and a fake clock: the opening, keepalive, the id vector,
//      snapshot-on-subscribe, the per-channel queues and their shed, the connection cap, the stall,
//      the frame cap, close, and an unsupported hub.
//   B. The route over a real server on 127.0.0.1:0: every refusal as JSON with the security headers
//      and no stream header, with no verb run, no follow and no hub subscribe; Host and Origin; the
//      stream headers; `since` over `Last-Event-ID`; the slot; the real hub's supervisor set.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  createLiveStreams, parseChannelList, parseVector, lastEventVector,
  KEEPALIVE_MS, STALL_MS, CHANNEL_QUEUE_BYTES, CONNECTION_BYTES, FRAME_CAP, RETRY_MS,
} = require('../src/live-stream.ts');
const { createLiveHub } = require('../src/live.ts');
const { createServer } = require('../src/server.ts');
const { consoleRoutes } = require('../src/routes.ts');
const { createSessions, cookieName } = require('../src/session.ts');
const { securityHeaders } = require('../src/headers.ts');

const EPOCH = 'a1b2c3d4';
const AT = '2026-11-07T12:00:00.000Z';
const TASKS = 'tasks:feat-a';
const STREAM_HEADERS = { ...securityHeaders(true), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform' };

// ---- fakes ----

type Current = { n: number, state: any, error: string | null, gone: boolean };

/** A hub as live.ts exposes it: `emit` moves a channel's counter and current state as the real hub does, then calls its listeners. */
function fakeHub(epoch = EPOCH) {
  const listeners = new Map<string, Set<(frame: any) => void>>();
  const unsupportedListeners: Array<() => void> = [];
  const states = new Map<string, Current>();
  const hub = {
    epoch,
    unsupported: false,
    subscribes: [] as string[],
    unsubscribes: [] as string[],
    states,
    subscribe(ch: string, listener: (frame: any) => void) {
      hub.subscribes.push(ch);
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch)!.add(listener);
      return () => {
        hub.unsubscribes.push(ch);
        listeners.get(ch)!.delete(listener);
      };
    },
    current: (ch: string): Current => states.get(ch) ?? { n: 0, state: null, error: null, gone: false },
    onUnsupported(listener: () => void) {
      unsupportedListeners.push(listener);
    },
    /** One frame on `ch`; a patch takes the state it leaves (`state`). */
    emit(ch: string, type: string, data: any, state?: any) {
      const c = { ...hub.current(ch) };
      c.n += 1;
      if (type === 'snapshot') Object.assign(c, { state: data.state, error: null });
      if (type === 'patch') c.state = state;
      if (type === 'error') Object.assign(c, { state: null, error: data.code });
      if (type === 'reset') Object.assign(c, { state: null, error: null });
      if (type === 'gone') c.gone = true;
      states.set(ch, c);
      for (const listener of [...(listeners.get(ch) ?? [])]) listener({ ch, n: c.n, type, at: AT, data });
    },
    /** As live.ts onDown('live-unavailable'): an error frame on every subscribed channel, then the unsupported listeners. */
    goUnsupported() {
      hub.unsupported = true;
      for (const [ch, set] of listeners) if (set.size > 0) hub.emit(ch, 'error', { code: 'live-unavailable' });
      for (const listener of unsupportedListeners) listener();
    },
  };
  return hub;
}

function fakeClock() {
  let now = Date.parse(AT);
  const timers = new Set<{ at: number, fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const handle = { at: now + ms, fn };
      timers.add(handle);
      return handle;
    },
    clearTimeout(handle: any) {
      timers.delete(handle);
    },
    pending: () => timers.size,
    step(ms: number) {
      now += ms;
      for (const handle of [...timers].sort((a, b) => a.at - b.at)) {
        if (handle.at <= now && timers.has(handle)) {
          timers.delete(handle);
          handle.fn();
        }
      }
    },
  };
}

/** A response whose socket a case holds (`hold`: writes stay in `writableLength`) and drains (`flush`). */
function fakeResponse() {
  const res: any = new EventEmitter();
  res.head = null;
  res.chunks = [] as string[];
  res.writableLength = 0;
  res.hold = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = (status: number, headers: Record<string, string>) => { res.head = { status, headers }; };
  res.write = (text: string) => {
    res.chunks.push(text);
    if (res.hold) res.writableLength += Buffer.byteLength(text);
    return !res.hold;
  };
  res.end = () => { res.writableEnded = true; res.emit('close'); };
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  res.flush = (keepHolding = false) => {
    res.hold = keepHolding;
    res.writableLength = 0;
    res.emit('drain');
  };
  return res;
}
function fakeRequest() {
  const req: any = new EventEmitter();
  req.socket = { destroyed: false, noDelay: false, setNoDelay(on: boolean) { req.socket.noDelay = on; } };
  return req;
}

type Message = { retry?: string, comment?: string, id?: string, event?: string, data?: any };
function messages(chunks: string[]): Message[] {
  return chunks.join('').split('\n\n').filter((block) => block !== '').map((block) => {
    const message: Message = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('retry: ')) message.retry = line.slice(7);
      else if (line.startsWith(': ')) message.comment = line.slice(2);
      else if (line.startsWith('id: ')) message.id = line.slice(4);
      else if (line.startsWith('event: ')) message.event = line.slice(7);
      else if (line.startsWith('data: ')) message.data = JSON.parse(line.slice(6));
    }
    return message;
  });
}
const dataOf = (res: any) => messages(res.chunks).filter((message) => message.data !== undefined && message.event === undefined);
const summary = (res: any) => dataOf(res).map((message) => `${message.data.type}@${message.data.id}`);

function openLive(hub: any, channels: string[], resume: any = null) {
  const clock = fakeClock();
  const streams = createLiveStreams(hub, clock);
  let released = 0;
  const req = fakeRequest();
  const res = fakeResponse();
  streams.serve(req, res, { channels, resume, release: () => { released += 1; } });
  return { clock, streams, req, res, released: () => released };
}
const big = (size: number) => ({ set: { '/runs/body': 'x'.repeat(size) }, unset: [] });

// ---- A. live-stream.ts ----

test('grammar: ch is 1 to 8 distinct IC-003 channels; a vector is epoch/ch=n with at most 8 entries and 2048 characters', () => {
  assert.deepEqual(parseChannelList('now'), ['now']);
  assert.deepEqual(parseChannelList(`now,${TASKS},run:feat-a:t1,worker:w-0123456789ab`), ['now', TASKS, 'run:feat-a:t1', 'worker:w-0123456789ab']);
  const eight = Array.from({ length: 8 }, (_, i) => `tasks:f${i}`);
  assert.deepEqual(parseChannelList(eight.join(',')), eight);
  // 150 IC-006: the log channels are channels; `last` and every other stream are not.
  assert.deepEqual(parseChannelList('worker:w-0123456789ab:out,worker:w-0123456789ab:err'), ['worker:w-0123456789ab:out', 'worker:w-0123456789ab:err']);
  for (const bad of [undefined, '', 'now,', ',now', 'now,now', [...eight, 'now'].join(','), 'nope', 'worker:w-xyz', 'worker:w-0123456789ab:last', 'worker:w-0123456789ab:x',
    'worker:w-0123456789ab:out:1', 'worker:w-xyz:out', 'transcript:a', 'fleet:x', 'now ']) {
    assert.equal(parseChannelList(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseVector(`${EPOCH}/now=3,${TASKS}=12`), { epoch: EPOCH, positions: new Map([['now', 3], [TASKS, 12]]) });
  assert.deepEqual(parseVector(`${EPOCH}/${eight.map((ch) => `${ch}=1`).join(',')}`)!.positions.size, 8);
  for (const bad of [undefined, '', EPOCH, `${EPOCH}/`, `${EPOCH}/now`, `${EPOCH}/now=`, `${EPOCH}/now=0`, `${EPOCH}/now=01`, `${EPOCH}/now=-1`, `${EPOCH}/now=1.5`,
    `${EPOCH}/now=1,now=2`, `${EPOCH}/now=1,`, `${EPOCH.toUpperCase()}/now=1`, 'a1b2c3d/now=1', `${EPOCH}0/now=1`, `${EPOCH}/nope=1`, `${EPOCH}/now=99999999999999999`,
    `${EPOCH}/${[...eight, 'now'].map((ch) => `${ch}=1`).join(',')}`, `${EPOCH}/now=1\n`, `${EPOCH}/tasks:${'a'.repeat(2040)}=1`]) {
    assert.equal(parseVector(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(lastEventVector(`${EPOCH}/now=3,${TASKS}=4`, ['now']), { epoch: EPOCH, positions: new Map([['now', 3]]) }, 'entries for other channels are dropped');
  assert.equal(lastEventVector('garbage', ['now']), null);
});

test('opening: the /api/stream headers, setNoDelay, retry: 2000 first; every message unnamed with an id vector', () => {
  const hub = fakeHub();
  const { res, req } = openLive(hub, ['now', TASKS]);
  assert.equal(res.head.status, 200);
  assert.deepEqual(res.head.headers, STREAM_HEADERS);
  assert.equal(req.socket.noDelay, true);
  assert.equal(RETRY_MS, 2000);
  assert.equal(res.chunks[0], 'retry: 2000\n\n');
  assert.deepEqual(hub.subscribes, ['now', TASKS]);
  hub.emit('now', 'snapshot', { state: { runs: { status: 200, body: { v: 1 } } } });
  hub.emit(TASKS, 'snapshot', { state: { tasks: { status: 200, body: {} } } });
  hub.emit('now', 'patch', { set: { '/runs/body/v': 2 }, unset: [] }, { runs: { status: 200, body: { v: 2 } } });
  const sent = dataOf(res);
  assert.deepEqual(sent.map((message) => message.id), [`${EPOCH}/now=1`, `${EPOCH}/now=1,${TASKS}=1`, `${EPOCH}/now=2,${TASKS}=1`]);
  assert.ok(messages(res.chunks).every((message) => message.event === undefined), 'no event: field');
  assert.deepEqual(sent[2].data, { v: 1, ch: 'now', id: `${EPOCH}-2`, type: 'patch', at: AT, data: { set: { '/runs/body/v': 2 }, unset: [] } });
  assert.ok(res.chunks.slice(1).every((chunk: string) => /^(id: [^\n]+\ndata: [^\n]+\n\n|event: keepalive\ndata: \{\}\n\n)$/.test(chunk)), 'whole messages, one per write');
});

test('keepalive: a named keepalive event with data {} every 15000 ms, no id, from the injected clock', () => {
  const { res, clock } = openLive(fakeHub(), ['now']);
  const keepalives = () => messages(res.chunks).filter((message) => message.event === 'keepalive');
  clock.step(KEEPALIVE_MS - 1);
  assert.equal(keepalives().length, 0);
  clock.step(1);
  assert.equal(keepalives().length, 1);
  assert.equal(keepalives()[0].id, undefined);
  assert.deepEqual(keepalives()[0].data, {}, 'a data line, so EventSource dispatches it');
  assert.equal(res.chunks.at(-1), 'event: keepalive\ndata: {}\n\n');
  assert.equal(messages(res.chunks).some((message) => message.comment !== undefined), false, 'no SSE comment');
  assert.deepEqual(dataOf(res), [], 'the keepalive is no frame');
  clock.step(KEEPALIVE_MS);
  assert.equal(keepalives().length, 2);
});

test('snapshot-on-subscribe: the given position equal to the hub\'s sends nothing; any other position or epoch a snapshot at the current n', () => {
  const state = { runs: { status: 200, body: { v: 1, runs: [] } } };
  const at = (n: number, epoch = EPOCH) => ({ epoch, positions: new Map([['now', n]]) });
  const cases: Array<[string, any, string[]]> = [
    ['equal', at(5), []],
    ['behind', at(4), [`snapshot@${EPOCH}-5`]],
    ['ahead', at(6), [`snapshot@${EPOCH}-5`]],
    ['other epoch', at(5, 'ffffffff'), [`snapshot@${EPOCH}-5`]],
    ['no position', null, [`snapshot@${EPOCH}-5`]],
  ];
  for (const [label, resume, expected] of cases) {
    const hub = fakeHub();
    hub.states.set('now', { n: 5, state, error: null, gone: false });
    const { res } = openLive(hub, ['now'], resume);
    assert.deepEqual(summary(res), expected, label);
    if (expected.length > 0) {
      assert.deepEqual(dataOf(res)[0].data.data, { state }, label);
      assert.equal(dataOf(res)[0].id, `${EPOCH}/now=5`, label);
    }
  }
});

test('snapshot-on-subscribe: an error channel gets its error frame (even at an equal position), a gone one gone, one owed a snapshot nothing', () => {
  const hub = fakeHub();
  hub.states.set('now', { n: 3, state: null, error: 'events-down', gone: false });
  hub.states.set(TASKS, { n: 2, state: null, error: null, gone: true });
  hub.states.set('run:feat-a:t1', { n: 0, state: null, error: null, gone: false });
  const { res } = openLive(hub, ['now', TASKS, 'run:feat-a:t1'], { epoch: EPOCH, positions: new Map([['now', 3]]) });
  assert.deepEqual(summary(res), [`error@${EPOCH}-3`, `gone@${EPOCH}-2`]);
  assert.deepEqual(dataOf(res)[0].data.data, { code: 'events-down' });
  assert.deepEqual(dataOf(res)[1].data.data, {});
  assert.equal(dataOf(res)[1].id, `${EPOCH}/now=3,${TASKS}=2`);
});

test('snapshot-on-subscribe over the real hub: a channel dropped and created again keeps its n, so a position from before it was dropped gets a snapshot of the new state', async () => {
  const RUN = 'w-0123456789ab';
  const CH = `worker:${RUN}`;
  const body = (state: string) => ({ disposition: 'status', runId: RUN, task: 'A.1', token: 1, harness: 'codex', state, reason: null, supervisorLost: false,
    overdue: false, startedAt: '2026-10-26T09:00:00.000Z', endedAt: null, deadline: '2026-10-26T10:00:00.000Z', attemptActive: true });
  let onFrame: (envelope: any) => void = () => {};
  let seq = 0;
  const supervisor = {
    state: 'stopped',
    need(set: Set<string>) { supervisor.state = set.size > 0 ? 'running' : 'stopped'; },
    onFrame(listener: (envelope: any) => void) { onFrame = listener; },
    onDown() {},
    stop() {},
  };
  const push = (type: string, state: string) => {
    seq += 1;
    onFrame({ v: 1, ch: CH, id: `0badc0de-${seq}`, type, at: AT, data: { sections: { status: { exit: 0, json: body(state) } } } });
  };
  const clock = fakeClock();
  const hub = createLiveHub({ runner: { run: async () => ({ ok: false, code: 'core-unreachable', exit: null }) }, supervisor, clock });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const compose = async () => {
    for (let step = 0; step < 4; step += 1) {
      clock.step(25);
      await settle();
      await settle();
    }
  };
  try {
    const first = openLive(hub, [CH]);
    push('snapshot', 'running');
    await compose();
    push('patch', 'exited');
    await compose();
    assert.deepEqual(summary(first.res), [`snapshot@${hub.epoch}-1`, `patch@${hub.epoch}-2`]);
    const held = dataOf(first.res).at(-1)!.id!;
    first.res.destroy();
    assert.equal(hub.current(CH), null, 'the last subscriber left: the hub dropped the channel');

    // Another tab opens the channel again; the run moved on twice.
    const other = openLive(hub, [CH]);
    push('snapshot', 'timed-out');
    await compose();
    push('patch', 'cancelled');
    await compose();
    // The first tab reconnects with the vector it held.
    const resumed = openLive(hub, [CH], parseVector(held));
    assert.deepEqual(summary(resumed.res), [`snapshot@${hub.epoch}-4`]);
    assert.equal(dataOf(resumed.res)[0].data.data.state.worker.body.state, 'cancelled');
    other.res.destroy();
    resumed.res.destroy();
  } finally {
    hub.stop();
  }
});

test('id vector: a resumed position counts as held; every channel of the connection with a position, in connection order', () => {
  const hub = fakeHub();
  hub.states.set('now', { n: 5, state: { a: 1 }, error: null, gone: false });
  const { res } = openLive(hub, [TASKS, 'now'], { epoch: EPOCH, positions: new Map([['now', 5]]) });
  assert.deepEqual(dataOf(res), []);
  hub.emit(TASKS, 'snapshot', { state: { tasks: { status: 200, body: {} } } });
  hub.emit('now', 'patch', { set: { '/a': 2 }, unset: [] }, { a: 2 });
  assert.deepEqual(dataOf(res).map((message) => message.id), [`${EPOCH}/${TASKS}=1,now=5`, `${EPOCH}/${TASKS}=1,now=6`]);
});

test('queues: round-robin across channels while writableLength is under 65536, resumed on drain', () => {
  const hub = fakeHub();
  const { res } = openLive(hub, ['now', TASKS]);
  res.hold = true;
  res.writableLength = 70_000;
  hub.emit('now', 'snapshot', { state: { a: 1 } });
  hub.emit('now', 'patch', { set: { '/a': 2 }, unset: [] }, { a: 2 });
  hub.emit(TASKS, 'snapshot', { state: { b: 1 } });
  hub.emit(TASKS, 'patch', { set: { '/b': 2 }, unset: [] }, { b: 2 });
  assert.deepEqual(dataOf(res), [], 'nothing moves while the socket is over the mark');
  res.flush();
  assert.deepEqual(summary(res), [`snapshot@${EPOCH}-1`, `snapshot@${EPOCH}-1`, `patch@${EPOCH}-2`, `patch@${EPOCH}-2`]);
  assert.deepEqual(dataOf(res).map((message) => message.data.ch), ['now', TASKS, 'now', TASKS]);
});

test('queues: a channel past 524288 bytes is cleared, gets one error queue-full, takes nothing until drained, then one snapshot', () => {
  assert.equal(CHANNEL_QUEUE_BYTES, 524_288);
  const hub = fakeHub();
  const { res, released } = openLive(hub, ['now', TASKS]);
  hub.emit('now', 'snapshot', { state: { a: 1 } });
  res.hold = true;
  res.writableLength = 70_000;
  hub.emit('now', 'patch', big(200_000), { a: 2 });
  hub.emit('now', 'patch', big(200_000), { a: 3 });
  hub.emit('now', 'patch', big(200_000), { a: 4 });
  hub.emit('now', 'patch', big(10), { a: 5 });
  hub.emit(TASKS, 'snapshot', { state: { b: 1 } });
  assert.deepEqual(summary(res), [`snapshot@${EPOCH}-1`]);
  res.flush(true);
  const after = dataOf(res).slice(1).map((message) => [message.data.ch, message.data.type, message.data.id, message.data.data]);
  assert.deepEqual(after.sort(), [['now', 'error', `${EPOCH}-1`, { code: 'queue-full' }], [TASKS, 'snapshot', `${EPOCH}-1`, { state: { b: 1 } }]],
    'the queue cleared to one error at the last n written; the other channel goes on');
  hub.emit('now', 'patch', big(10), { a: 6 });
  assert.equal(summary(res).length, 3, 'a lagging channel takes no frame and, with bytes still pending, sends no snapshot yet');
  res.flush();
  const last = dataOf(res).at(-1)!;
  assert.deepEqual([last.data.type, last.data.id, last.data.ch, last.data.data], ['snapshot', `${EPOCH}-6`, 'now', { state: { a: 6 } }]);
  assert.equal(last.id, `${EPOCH}/now=6,${TASKS}=1`);
  hub.emit('now', 'patch', { set: { '/a': 7 }, unset: [] }, { a: 7 });
  assert.equal(dataOf(res).at(-1)!.data.type, 'patch', 'after the snapshot the channel is live again');
  assert.equal(released(), 0);
  assert.equal(res.destroyed, false);
});

test('queues: all queues plus writableLength over 1048576 bytes destroys the connection, releasing its slot and its channels', () => {
  assert.equal(CONNECTION_BYTES, 1_048_576);
  const hub = fakeHub();
  const { res, released, clock } = openLive(hub, ['now', TASKS]);
  res.hold = true;
  res.writableLength = 600_000;
  hub.emit('now', 'patch', big(200_000), { a: 1 });
  hub.emit(TASKS, 'patch', big(200_000), { b: 1 });
  assert.equal(res.destroyed, false, '1000000-odd bytes is under the cap');
  hub.emit(TASKS, 'patch', big(100_000), { b: 2 });
  assert.equal(res.destroyed, true);
  assert.equal(released(), 1);
  assert.deepEqual(hub.unsubscribes.sort(), ['now', TASKS].sort());
  assert.equal(clock.pending(), 0, 'no timer left');
  assert.ok(!res.chunks.join('').includes('queue-full'), 'no channel was over its own cap');
});

test('stall: writableLength above 0 with no drain for 60000 ms destroys the connection; a drain in time keeps it', () => {
  assert.equal(STALL_MS, 60_000);
  const hub = fakeHub();
  const stalled = openLive(hub, ['now']);
  stalled.res.hold = true;
  hub.emit('now', 'snapshot', { state: { a: 1 } });
  stalled.clock.step(STALL_MS - 1);
  assert.equal(stalled.res.destroyed, false);
  stalled.clock.step(1);
  assert.equal(stalled.res.destroyed, true);
  assert.equal(stalled.released(), 1);

  const hub2 = fakeHub();
  const kept = openLive(hub2, ['now']);
  kept.res.hold = true;
  hub2.emit('now', 'snapshot', { state: { a: 1 } });
  kept.clock.step(STALL_MS / 2);
  kept.res.flush(true);
  kept.clock.step(STALL_MS / 2 + 1);
  assert.equal(kept.res.destroyed, false, 'the drain at 30 s reset the stall clock');
  kept.clock.step(STALL_MS);
  assert.equal(kept.res.destroyed, true, 'the keepalive written after the drain stayed pending for 60 s with no drain');
});

test('frame cap: a message over 262144 bytes is written as reset frame-cap; the next patch is answered with a snapshot that fits', () => {
  assert.equal(FRAME_CAP, 262_144);
  const hub = fakeHub();
  const { res } = openLive(hub, ['now']);
  hub.emit('now', 'patch', big(FRAME_CAP), { a: 'x'.repeat(FRAME_CAP) });
  assert.deepEqual(summary(res), [`reset@${EPOCH}-1`]);
  assert.deepEqual(dataOf(res)[0].data.data, { reason: 'frame-cap' });
  assert.ok(res.chunks.every((chunk: string) => Buffer.byteLength(chunk) <= FRAME_CAP));
  hub.emit('now', 'patch', { set: { '/a': 'x' }, unset: [] }, { a: 'x'.repeat(FRAME_CAP) });
  assert.equal(summary(res).length, 1, 'a patch whose state does not fit is dropped, not reset again');
  hub.emit('now', 'patch', { set: { '/a': 'small' }, unset: [] }, { a: 'small' });
  assert.deepEqual(summary(res), [`reset@${EPOCH}-1`, `snapshot@${EPOCH}-3`]);
  assert.deepEqual(dataOf(res)[1].data.data, { state: { a: 'small' } });
  hub.emit('now', 'patch', { set: { '/a': 'next' }, unset: [] }, { a: 'next' });
  assert.equal(dataOf(res).at(-1)!.data.type, 'patch');
});

test('close: res close releases the slot once, unsubscribes every channel and clears the timers; a completed req close is not a disconnect', () => {
  const hub = fakeHub();
  const { res, req, released, clock, streams } = openLive(hub, ['now', TASKS]);
  assert.equal(streams.openConnections(), 1);
  req.emit('close');
  assert.equal(released(), 0, 'the socket lives on');
  res.emit('close');
  res.emit('close');
  assert.equal(released(), 1);
  assert.deepEqual(hub.unsubscribes, ['now', TASKS]);
  assert.equal(clock.pending(), 0);
  assert.equal(streams.openConnections(), 0);
  const written = res.chunks.length;
  hub.emit('now', 'snapshot', { state: { a: 1 } });
  clock.step(3 * KEEPALIVE_MS);
  assert.equal(res.chunks.length, written, 'nothing is written after the close');

  const other = openLive(fakeHub(), ['now']);
  other.req.socket.destroyed = true;
  other.req.emit('close');
  assert.equal(other.released(), 1, 'a gone socket is a disconnect');
});

test('unsupported while open: the hub\'s error live-unavailable frames are written, then the response ends', () => {
  const hub = fakeHub();
  const { res, released } = openLive(hub, ['now', TASKS]);
  hub.emit('now', 'snapshot', { state: { a: 1 } });
  hub.goUnsupported();
  assert.deepEqual(summary(res), [`snapshot@${EPOCH}-1`, `error@${EPOCH}-2`, `error@${EPOCH}-1`]);
  assert.ok(dataOf(res).slice(1).every((message) => message.data.data.code === 'live-unavailable'));
  assert.equal(res.writableEnded, true);
  assert.equal(released(), 1);
  assert.deepEqual(hub.unsubscribes, ['now', TASKS]);

  const held = fakeHub();
  const waiting = openLive(held, ['now']);
  waiting.res.hold = true;
  waiting.res.writableLength = 70_000;
  held.goUnsupported();
  assert.equal(waiting.res.writableEnded, false, 'the error frame is still queued');
  waiting.res.flush();
  assert.deepEqual(summary(waiting.res), [`error@${EPOCH}-1`]);
  assert.equal(waiting.res.writableEnded, true, 'ended once the error frame is written');

  const lagging = fakeHub();
  const shed = openLive(lagging, ['now']);
  shed.res.hold = true;
  shed.res.writableLength = 70_000;
  for (let i = 0; i < 3; i += 1) lagging.emit('now', 'patch', big(200_000), { a: i });
  lagging.goUnsupported();
  shed.res.flush();
  assert.deepEqual(dataOf(shed.res).map((message) => message.data.data.code), ['queue-full', 'live-unavailable'], 'a lagging channel still gets the error');
  assert.equal(shed.res.writableEnded, true);

  const stuck = fakeHub();
  const stalled = openLive(stuck, ['now']);
  stalled.res.hold = true;
  stuck.emit('now', 'snapshot', { state: { a: 1 } });
  stalled.res.writableLength = 70_000;
  stuck.goUnsupported();
  stalled.clock.step(STALL_MS);
  assert.equal(stalled.res.destroyed, true, 'a stalled one is destroyed');
  assert.equal(stalled.released(), 1);
});

// ---- B. The route over a real server ----

const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-live-'));
after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

/** A runner that counts every call and every follow start: a refusal must make neither. */
function countingRunner() {
  const runner = {
    calls: 0,
    follows: 0,
    run: async () => { runner.calls += 1; return { ok: false, code: 'core-unreachable', exit: null }; },
    follow: () => { runner.follows += 1; return null; },
  };
  return runner;
}

type Reply = { status: number, headers: Record<string, any>, body: string };
function get(port: number, target: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, agent: false, headers }, (res: any) => {
      const chunks: any[] = [];
      res.on('data', (chunk: any) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
function openStream(port: number, target: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number, headers: any, text(): string, closed: Promise<number>, destroy(): void }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, agent: false, headers }, (res: any) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      const started = Date.now();
      const closed = new Promise<number>((done) => { res.on('close', () => done(Date.now() - started)); res.on('error', () => {}); });
      resolve({ status: res.statusCode, headers: res.headers, text: () => text, closed, destroy: () => req.destroy() });
    });
    req.on('error', (error: any) => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end();
  });
}
async function until(check: () => boolean, label: string, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) assert.fail(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function harness(t: any, live: any, scope: 'read' | 'phone' = 'read') {
  const runner = countingRunner();
  const sessions = createSessions(scope === 'phone' ? { scope: 'phone' } : undefined);
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions, live) });
  t.after(() => app.close());
  const cookie = `${cookieName(app.port)}=${sessions.exchange(sessions.mintLaunchCode())}`;
  return { app, runner, cookie, port: app.port };
}

const errorBody = (code: string) => ({ error: { code, verb: null, exit: null } });

/** A JSON refusal: the IC-005 body, the security headers, and no stream header. */
function assertRefusal(reply: Reply, status: number, code: string, label: string) {
  assert.equal(reply.status, status, label);
  assert.deepEqual(JSON.parse(reply.body), errorBody(code), label);
  assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8', label);
  for (const [name, value] of Object.entries(securityHeaders(true))) assert.equal(reply.headers[name.toLowerCase()], value, `${label}: ${name}`);
  assert.ok(!reply.body.includes('retry:'), label);
}

test('GET /api/live: no or a bad cookie is 401, with nothing subscribed and no verb or follow', async (t) => {
  const hub = fakeHub();
  const { port, runner } = await harness(t, hub);
  assertRefusal(await get(port, '/api/live?ch=now'), 401, 'unauthenticated', 'no cookie');
  assertRefusal(await get(port, '/api/live?ch=now', { Cookie: `${cookieName(port)}=${'0'.repeat(64)}` }), 401, 'unauthenticated', 'bad cookie');
  assertRefusal(await get(port, '/api/live?ch=nope'), 401, 'unauthenticated', 'the session check comes before the query');
  assert.deepEqual([hub.subscribes.length, runner.calls, runner.follows], [0, 0, 0]);
});

test('GET /api/live: a bad query is 400 usage before any slot, subscribe, verb or follow', async (t) => {
  const hub = fakeHub();
  const { port, runner, cookie } = await harness(t, hub);
  const nine = Array.from({ length: 9 }, (_, i) => `tasks:f${i}`).join(',');
  for (const query of ['', '?ch=', '?ch=now&x=1', '?x=1', '?ch=now&ch=now', '?ch=now&since=a1b2c3d4/now=1&since=a1b2c3d4/now=1', '?ch=nope', '?ch=worker:w-xyz',
    '?ch=transcript:a', '?ch=now,now', `?ch=${nine}`, '?ch=now,', '?ch=now&since=garbage', '?ch=now&since=', '?ch=now&since=a1b2c3d4/now=0', '?ch=now&since=a1b2c3d4/now=01',
    '?ch=now&since=A1B2C3D4/now=1', '?ch=now&since=a1b2c3d4/', `?ch=now&since=a1b2c3d4/${TASKS}=1`, `?ch=now&since=a1b2c3d4/now=1,${TASKS}=1`]) {
    assertRefusal(await get(port, `/api/live${query}`, { Cookie: cookie }), 400, 'usage', query);
  }
  assert.deepEqual([hub.subscribes.length, runner.calls, runner.follows], [0, 0, 0]);
  const eight = Array.from({ length: 8 }, (_, i) => `tasks:f${i}`).join(',');
  const ok = await openStream(port, `/api/live?ch=${eight}&since=ffffffff/tasks:f0=3`, { Cookie: cookie });
  t.after(() => ok.destroy());
  assert.equal(ok.status, 200, 'control: eight channels and a since over them open');
});

test('GET /api/live: a phone session is 403 phone-scope (not in the phone allow-list)', async (t) => {
  const hub = fakeHub();
  const { port, runner, cookie } = await harness(t, hub, 'phone');
  assertRefusal(await get(port, '/api/live?ch=now', { Cookie: cookie }), 403, 'phone-scope', 'phone');
  assert.deepEqual([hub.subscribes.length, runner.calls, runner.follows], [0, 0, 0]);
});

test('GET /api/live: Host not allowed is 421 with an empty body; a cross Origin is 403 forbidden-origin', async (t) => {
  const hub = fakeHub();
  const { port, cookie } = await harness(t, hub);
  const host = await get(port, '/api/live?ch=now', { Cookie: cookie, Host: `evil.test:${port}` });
  assert.equal(host.status, 421);
  assert.equal(host.body, '');
  assert.equal(host.headers['content-security-policy'], securityHeaders(true)['Content-Security-Policy']);
  assertRefusal(await get(port, '/api/live?ch=now', { Cookie: cookie, Origin: 'http://evil.test' }), 403, 'forbidden-origin', 'origin');
  assert.equal(hub.subscribes.length, 0);
});

test('GET /api/live: a fifth stream is 429 stream-limit before any stream header; closing one frees its slot and unsubscribes it', async (t) => {
  const hub = fakeHub();
  const { port, cookie } = await harness(t, hub);
  const open: Array<Awaited<ReturnType<typeof openStream>>> = [];
  for (let i = 0; i < 4; i += 1) open.push(await openStream(port, '/api/live?ch=now', { Cookie: cookie }));
  t.after(() => { for (const stream of open) stream.destroy(); });
  assert.deepEqual(open.map((stream) => stream.status), [200, 200, 200, 200]);
  assertRefusal(await get(port, '/api/live?ch=now', { Cookie: cookie }), 429, 'stream-limit', 'fifth');
  assert.equal(hub.subscribes.length, 4);
  open[0].destroy();
  await open[0].closed;
  await until(() => hub.unsubscribes.length === 1, 'the closed connection unsubscribes');
  let again: any = null;
  for (let attempt = 0; attempt < 50 && again === null; attempt += 1) {
    const stream = await openStream(port, '/api/live?ch=now', { Cookie: cookie });
    if (stream.status === 200) again = stream;
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(again, 'the freed slot opens');
  again.destroy();
});

test('GET /api/live: with no hub, or an unsupported one, 503 live-unavailable with the slot released first', async (t) => {
  const none = await harness(t, null);
  for (let i = 0; i < 6; i += 1) assertRefusal(await get(none.port, '/api/live?ch=now', { Cookie: none.cookie }), 503, 'live-unavailable', `no hub ${i}`);
  assert.deepEqual([none.runner.calls, none.runner.follows], [0, 0]);
  const hub = fakeHub();
  hub.unsupported = true;
  const off = await harness(t, hub);
  for (let i = 0; i < 6; i += 1) assertRefusal(await get(off.port, '/api/live?ch=now', { Cookie: off.cookie }), 503, 'live-unavailable', `unsupported ${i}`);
  assert.equal(hub.subscribes.length, 0);
  hub.unsupported = false;
  const open: Array<Awaited<ReturnType<typeof openStream>>> = [];
  for (let i = 0; i < 4; i += 1) open.push(await openStream(off.port, '/api/live?ch=now', { Cookie: off.cookie }));
  t.after(() => { for (const stream of open) stream.destroy(); });
  assert.deepEqual(open.map((stream) => stream.status), [200, 200, 200, 200], 'six refusals held no slot');
});

/** A supervisor for the real hub: records `need`, starts nothing. */
function fakeSupervisor(state: string) {
  return {
    state,
    needs: [] as string[][],
    stopped: 0,
    need(set: Set<string>) { this.needs.push([...set].sort()); },
    onFrame() {},
    onDown() {},
    stop() { this.stopped += 1; },
  };
}

test('GET /api/live over the real hub: unsupported is 503 and the supervisor is never asked; open asks for the channel, close lets it go', async (t) => {
  const offSupervisor = fakeSupervisor('unsupported');
  const offHub = createLiveHub({ runner: countingRunner(), supervisor: offSupervisor });
  t.after(() => offHub.stop());
  const off = await harness(t, offHub);
  assertRefusal(await get(off.port, '/api/live?ch=now', { Cookie: off.cookie }), 503, 'live-unavailable', 'real hub unsupported');
  assert.deepEqual(offSupervisor.needs, [], 'no child before the stream step (AC-16)');

  const supervisor = fakeSupervisor('running');
  const hub = createLiveHub({ runner: countingRunner(), supervisor });
  t.after(() => hub.stop());
  const on = await harness(t, hub);
  assertRefusal(await get(on.port, '/api/live?ch=nope', { Cookie: on.cookie }), 400, 'usage', 'bad query');
  assert.deepEqual(supervisor.needs, []);
  const stream = await openStream(on.port, `/api/live?ch=${TASKS}`, { Cookie: on.cookie });
  assert.equal(stream.status, 200);
  assert.deepEqual(supervisor.needs, [[TASKS]]);
  stream.destroy();
  await stream.closed;
  await until(() => supervisor.needs.length === 2, 'the supervisor set is recomputed');
  assert.deepEqual(supervisor.needs[1], []);
});

test('GET /api/live: the stream headers and retry: 2000 through the real server; since wins over Last-Event-ID; a malformed Last-Event-ID is ignored', async (t) => {
  const hub = fakeHub();
  hub.states.set('now', { n: 5, state: { runs: { status: 200, body: { v: 1 } } }, error: null, gone: false });
  const { port, cookie } = await harness(t, hub);
  const open = async (query: string, headers: Record<string, string> = {}) => {
    const stream = await openStream(port, `/api/live?ch=now${query}`, { Cookie: cookie, ...headers });
    t.after(() => stream.destroy());
    await until(() => stream.text().startsWith('retry: 2000\n\n'), 'retry');
    return stream;
  };
  const first = await open('');
  assert.equal(first.status, 200);
  for (const [name, value] of Object.entries(STREAM_HEADERS)) assert.equal(first.headers[name.toLowerCase()], value, name);
  await until(() => first.text().includes('data: '), 'the snapshot');
  first.destroy();
  await first.closed;
  // Each case at the hub's position n then: the query, the Last-Event-ID header, and whether a snapshot comes first.
  const cases: Array<[(n: number) => string, (n: number) => Record<string, string>, boolean]> = [
    [(n) => `&since=${EPOCH}/now=${n}`, (n) => ({ 'Last-Event-ID': `${EPOCH}/now=${n - 1}` }), false],
    [(n) => `&since=${EPOCH}/now=${n - 1}`, (n) => ({ 'Last-Event-ID': `${EPOCH}/now=${n}` }), true],
    [() => '', (n) => ({ 'Last-Event-ID': `${EPOCH}/now=${n}` }), false],
    [() => '', (n) => ({ 'Last-Event-ID': `${EPOCH}/now=${n},nope=1` }), true],
    [() => '', () => ({ 'Last-Event-ID': 'garbage' }), true],
    [() => '', (n) => ({ 'Last-Event-ID': `${EPOCH}/now=${n},${TASKS}=2` }), false],
  ];
  for (const [index, [query, headers, snapshot]] of cases.entries()) {
    const n = hub.current('now').n;
    const stream = await open(query(n), headers(n));
    assert.equal(stream.status, 200, `case ${index}`);
    hub.emit('now', 'patch', { set: { '/runs/body/v': n }, unset: [] }, { runs: { status: 200, body: { v: n } } });
    await until(() => stream.text().includes(`"id":"${EPOCH}-${n + 1}"`), `the patch on case ${index}`);
    const sent = messages([stream.text()]).filter((message) => message.data !== undefined).map((message) => message.data.type);
    assert.deepEqual(sent, snapshot ? ['snapshot', 'patch'] : ['patch'], `case ${index}`);
    const gone = hub.unsubscribes.length + 1;
    stream.destroy();
    await stream.closed;
    await until(() => hub.unsubscribes.length === gone, `case ${index} closes`);
  }
});

test('GET /api/live: server close ends an open live stream within 2 s and releases its channels', async (t) => {
  const hub = fakeHub();
  const runner = countingRunner();
  const sessions = createSessions();
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions, hub) });
  const cookie = `${cookieName(app.port)}=${sessions.exchange(sessions.mintLaunchCode())}`;
  const stream = await openStream(app.port, '/api/live?ch=now', { Cookie: cookie });
  await until(() => stream.text().startsWith('retry: 2000'), 'retry');
  const start = Date.now();
  await app.close();
  await stream.closed;
  assert.ok(Date.now() - start < 2000, `closed in ${Date.now() - start} ms`);
  await until(() => hub.unsubscribes.length === 1, 'unsubscribed');
});
