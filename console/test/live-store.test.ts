'use strict';

// The live client store (feature 149, IC-017; plan task C.2). Like live-discipline.test.ts, the web root is copied beside a
// {"type":"module"} marker and store.js is imported. A fake adapter stands in for live.js (IC-016): it records every open and
// close, delivers frames only while open (as a closed EventSource delivers nothing), and lets a case push adapter states. The
// clock is fake, so nothing waits in real time. The Adapter seam scenario drives the store with patches made by the server's own
// diff (console/src/live.ts diffState), so the fake sends what a real hub would.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { diffState } = require('../src/live.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let mods: any;
const url = (name: string) => pathToFileURL(path.join(copy, name)).href;

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-store-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  mods = { store: await import(url('store.js')) };
});
after(() => { fs.rmSync(copy, { recursive: true, force: true }); });

function fakeClock() {
  const clock: any = {
    time: 0, timers: [] as Array<{ at: number, fn: () => void, id: number }>, id: 0,
    now: () => clock.time,
    setTimeout: (fn: () => void, ms: number) => { clock.id += 1; clock.timers.push({ at: clock.time + ms, fn, id: clock.id }); return clock.id; },
    clearTimeout: (id: number) => { clock.timers = clock.timers.filter((t: any) => t.id !== id); },
    advance(ms: number) {
      const end = clock.time + ms;
      for (;;) {
        const due = clock.timers.filter((t: any) => t.at <= end).sort((a: any, b: any) => a.at - b.at)[0];
        if (!due) break;
        clock.timers = clock.timers.filter((t: any) => t !== due);
        clock.time = due.at;
        due.fn();
      }
      clock.time = end;
    },
  };
  return clock;
}

function fakeAdapter() {
  const adapter: any = {
    opens: [] as Array<{ channels: string[], since: string | null }>,
    closes: 0,
    isOpen: false,
    frameListeners: [] as Array<(envelope: any) => void>,
    stateListeners: [] as Array<(event: any) => void>,
    open(channels: string[], since: string | null) { adapter.opens.push({ channels, since }); adapter.isOpen = true; },
    close() { adapter.closes += 1; adapter.isOpen = false; },
    onFrame(listener: (envelope: any) => void) { adapter.frameListeners.push(listener); },
    onState(listener: (event: any) => void) { adapter.stateListeners.push(listener); },
    /** A frame on the open connection; a closed adapter delivers nothing. */
    push(envelope: any) {
      if (!adapter.isOpen) return false;
      for (const listener of adapter.frameListeners) listener(envelope);
      return true;
    },
    /** A frame delivered whatever the adapter's state, to check the store's own guard. */
    stray(envelope: any) { for (const listener of adapter.frameListeners) listener(envelope); },
    state(state: string, code: string | null = null) {
      if (state === 'closed' || state === 'refused' || state === 'unsupported') adapter.isOpen = false;
      for (const listener of adapter.stateListeners) listener({ state, code, at: 'at' });
    },
  };
  return adapter;
}

function setup(options: { hidden?: boolean } = {}) {
  const clock = fakeClock();
  const adapter = fakeAdapter();
  let hidden = options.hidden === true;
  let onVisibility: () => void = () => {};
  const visibility = { hidden: () => hidden, subscribe: (fn: () => void) => { onVisibility = fn; return () => {}; } };
  const store = mods.store.createLiveStore({ adapter, clock, visibility });
  const setHidden = (value: boolean) => { hidden = value; onVisibility(); };
  return { clock, adapter, store, setHidden };
}

function recorder() {
  const events: any[] = [];
  const listener = (event: any) => { events.push(event); };
  return { events, listener, last: () => events[events.length - 1] };
}

const E = '0a1b2c3d';
const F = 'ffee0011';
const env = (ch: string, id: string, type: string, data: any) => ({ v: 1, ch, id, type, at: '2026-11-07T12:00:00.000Z', data });
const snapshot = (ch: string, id: string, state: any) => env(ch, id, 'snapshot', { state });
const patch = (ch: string, id: string, set: any = {}, unset: string[] = []) => env(ch, id, 'patch', { set, unset });

/** A store with `channels` open (50 ms passed) and one recorder per channel. */
function opened(channels: string[]) {
  const ctx = setup();
  const rec: Record<string, ReturnType<typeof recorder>> = {};
  for (const ch of channels) { rec[ch] = recorder(); ctx.store.subscribe(ch, rec[ch].listener); }
  ctx.clock.advance(50);
  return { ...ctx, rec };
}

test('one adapter connection carries the union of two subscribers, opened 50 ms after the first subscribe', () => {
  const { clock, adapter, store } = setup();
  assert.deepEqual(store.status(), { transport: 'idle', lastFrameAt: null });
  store.subscribe('now', () => {});
  store.subscribe('run:feat-a:t1', () => {});
  clock.advance(49);
  assert.equal(adapter.opens.length, 0);
  clock.advance(1);
  assert.deepEqual(adapter.opens, [{ channels: ['now', 'run:feat-a:t1'], since: null }]);
  assert.equal(adapter.closes, 0);
  // A second subscriber of a channel already in the union changes nothing.
  store.subscribe('now', () => {});
  clock.advance(1000);
  assert.equal(adapter.opens.length, 1);
});

test('a third channel reopens once, 50 ms later, with since built from the applied positions of the opened channels', () => {
  const { clock, adapter, store } = opened(['now', 'run:feat-a:t1']);
  adapter.push(snapshot('now', `${E}-3`, { runs: { status: 200, body: [] } }));
  adapter.push(snapshot('run:feat-a:t1', `${E}-5`, { run: { status: 200, body: {} } }));
  store.subscribe('tasks:feat-a', () => {});
  clock.advance(49);
  assert.equal(adapter.opens.length, 1);
  clock.advance(1);
  assert.equal(adapter.closes, 1);
  assert.deepEqual(adapter.opens[1], { channels: ['now', 'run:feat-a:t1', 'tasks:feat-a'], since: `${E}/now=3,run:feat-a:t1=5` });
});

test('changes inside 50 ms make one reopen; the last unsubscribe closes the adapter without an empty open', () => {
  const { clock, adapter, store } = setup();
  const offA = store.subscribe('now', () => {});
  const offB = store.subscribe('tasks:feat-a', () => {});
  clock.advance(20);
  const offC = store.subscribe('tasks:feat-b', () => {});
  clock.advance(20);
  offB();
  offB(); // a second call is a no-op
  clock.advance(10);
  assert.deepEqual(adapter.opens, [{ channels: ['now', 'tasks:feat-b'], since: null }]);
  clock.advance(1000);
  assert.equal(adapter.opens.length, 1);
  offA();
  offC();
  clock.advance(49);
  assert.equal(adapter.closes, 0);
  clock.advance(1);
  assert.equal(adapter.closes, 1);
  assert.equal(adapter.opens.length, 1);
  assert.equal(store.status().transport, 'idle');
});

test('a snapshot replaces the state; a later subscriber gets the applied state at once', () => {
  const { adapter, store, rec } = opened(['now']);
  adapter.push(snapshot('now', `${E}-1`, { runs: { status: 200, body: [1] } }));
  adapter.push(snapshot('now', `${E}-2`, { sessions: { status: 200, body: {} } }));
  assert.deepEqual(rec.now.events.map((e) => e.kind), ['state', 'state']);
  assert.deepEqual(rec.now.last(), { kind: 'state', state: { sessions: { status: 200, body: {} } }, code: null });
  const late = recorder();
  store.subscribe('now', late.listener);
  assert.deepEqual(late.events, [{ kind: 'state', state: { sessions: { status: 200, body: {} } }, code: null }]);
});

test('a patch sets and unsets nested pointers to depth 4, decodes ~1 then ~0, and replaces arrays whole', () => {
  const { adapter, rec } = opened(['now']);
  adapter.push(snapshot('now', `${E}-1`, {
    sessions: { status: 200, body: { sections: { slots: { a: 1 }, list: [1, 2, 3], gone: true }, 'a/b': 1, 'm~n': 2, '~1': 3 } },
    runs: { status: 200, body: [] },
  }));
  adapter.push(patch('now', `${E}-2`, {
    '/sessions/body/sections/slots': { b: 2 },
    '/sessions/body/sections/list': [9],
    '/sessions/body/a~1b': 10,
    '/sessions/body/m~0n': 20,
    '/sessions/body/~01': 30,
    '/fresh/body/x/y': 'made',
  }, ['/sessions/body/sections/gone', '/runs']));
  assert.deepEqual(rec.now.last(), {
    kind: 'state',
    code: null,
    state: {
      sessions: { status: 200, body: { sections: { slots: { b: 2 }, list: [9] }, 'a/b': 10, 'm~n': 20, '~1': 30 } },
      fresh: { body: { x: { y: 'made' } } },
    },
  });
});

test('a malformed pointer or one through a non-object is dropped and the channel leaves since until a snapshot', () => {
  const { clock, adapter, rec } = opened(['now', 'tasks:feat-a']);
  const base = { runs: { status: 200, body: { list: [1] } } };
  adapter.push(snapshot('now', `${E}-1`, base));
  adapter.push(snapshot('tasks:feat-a', `${E}-4`, { tasks: { status: 200, body: {} } }));
  for (const [i, bad] of ['/a/b/c/d/e', '', 'runs', '/runs/body/list/0', '/runs/bad~2'].entries()) {
    const ctx = opened(['now']);
    ctx.adapter.push(snapshot('now', `${E}-1`, base));
    ctx.adapter.push(patch('now', `${E}-2`, { [bad]: 1 }));
    assert.equal(ctx.rec.now.events.length, 1, `pointer ${i} applied`);
    ctx.adapter.push(patch('now', `${E}-3`, { '/runs/status': 500 }));
    assert.equal(ctx.rec.now.events.length, 1, `pointer ${i}: a patch applied after the channel needed a snapshot`);
  }
  adapter.push(patch('now', `${E}-2`, {}, ['/runs/body/list/0']));
  assert.equal(rec.now.events.length, 1);
  assert.deepEqual(rec.now.last().state, base);
  clock.advance(50);
  assert.deepEqual(adapter.opens[1], { channels: ['now', 'tasks:feat-a'], since: `${E}/tasks:feat-a=4` });
  adapter.push(snapshot('now', `${E}-6`, { runs: { status: 200, body: {} } }));
  adapter.push(patch('now', `${E}-7`, { '/runs/status': 503 }));
  assert.deepEqual(rec.now.last().state, { runs: { status: 503, body: {} } });
});

test('a patch with a lower or equal n, or before any snapshot, is dropped', () => {
  const { adapter, rec } = opened(['now']);
  adapter.push(patch('now', `${E}-1`, { '/runs': 1 }));
  assert.equal(rec.now.events.length, 0);
  adapter.push(snapshot('now', `${E}-5`, { runs: 0 }));
  adapter.push(patch('now', `${E}-5`, { '/runs': 1 }));
  adapter.push(patch('now', `${E}-4`, { '/runs': 2 }));
  assert.equal(rec.now.events.length, 1);
  adapter.push(patch('now', `${E}-7`, { '/runs': 3 }));
  adapter.push(patch('now', `${E}-6`, { '/runs': 4 }));
  assert.deepEqual(rec.now.events.map((e) => e.state), [{ runs: 0 }, { runs: 3 }]);
});

test('a patch of another epoch is dropped, marks the channel, and its position stays out of the next since', () => {
  const { clock, adapter, rec } = opened(['now', 'run:feat-a:t1']);
  adapter.push(snapshot('now', `${E}-3`, { runs: 0 }));
  adapter.push(snapshot('run:feat-a:t1', `${F}-2`, { run: 0 }));
  adapter.push(patch('now', `${F}-4`, { '/runs': 1 }));
  adapter.push(patch('now', `${F}-5`, { '/runs': 2 }));
  assert.deepEqual(rec.now.events.map((e) => e.state), [{ runs: 0 }]);
  clock.advance(50);
  assert.deepEqual(adapter.opens[1], { channels: ['now', 'run:feat-a:t1'], since: `${F}/run:feat-a:t1=2` });
});

test('reset drops the state, tells reset, and patches are ignored until the next snapshot', () => {
  const { clock, adapter, store, rec } = opened(['now']);
  adapter.push(snapshot('now', `${E}-1`, { runs: 0 }));
  adapter.push(env('now', `${E}-2`, 'reset', { reason: 'frame-cap' }));
  assert.deepEqual(rec.now.last(), { kind: 'reset', state: null, code: 'frame-cap' });
  adapter.push(patch('now', `${E}-3`, { '/runs': 1 }));
  assert.equal(rec.now.events.length, 2);
  store.subscribe('tasks:feat-a', () => {});
  clock.advance(50);
  assert.equal(adapter.opens[1].since, null);
  adapter.push(snapshot('now', `${E}-4`, { runs: 2 }));
  adapter.push(patch('now', `${E}-5`, { '/runs': 3 }));
  assert.deepEqual(rec.now.events.slice(2).map((e) => e.state), [{ runs: 2 }, { runs: 3 }]);
});

test('error keeps the subscription and the connection; the next snapshot tells state again', () => {
  const { clock, adapter, store, rec } = opened(['now']);
  adapter.push(snapshot('now', `${E}-1`, { runs: 0 }));
  adapter.push(env('now', `${E}-2`, 'error', { code: 'store-unreadable' }));
  assert.deepEqual(rec.now.last(), { kind: 'error', state: null, code: 'store-unreadable' });
  const late = recorder();
  store.subscribe('now', late.listener);
  assert.deepEqual(late.events, [{ kind: 'error', state: null, code: 'store-unreadable' }]);
  clock.advance(60000);
  assert.equal(adapter.opens.length, 1);
  assert.equal(adapter.closes, 0);
  adapter.push(patch('now', `${E}-3`, { '/runs': 9 }));
  assert.equal(rec.now.events.length, 2);
  adapter.push(snapshot('now', `${E}-4`, { runs: 4 }));
  assert.deepEqual(rec.now.last(), { kind: 'state', state: { runs: 4 }, code: null });
  assert.deepEqual(late.last(), { kind: 'state', state: { runs: 4 }, code: null });
});

test('gone tells gone, drops the channel and takes it out of the union', () => {
  const { clock, adapter, rec } = opened(['now', 'tasks:feat-a']);
  adapter.push(snapshot('now', `${E}-1`, { runs: 0 }));
  adapter.push(snapshot('tasks:feat-a', `${E}-2`, { tasks: 0 }));
  adapter.push(env('tasks:feat-a', `${E}-3`, 'gone', {}));
  assert.deepEqual(rec['tasks:feat-a'].last(), { kind: 'gone', state: null, code: null });
  adapter.push(snapshot('tasks:feat-a', `${E}-4`, { tasks: 1 }));
  assert.equal(rec['tasks:feat-a'].events.length, 2);
  clock.advance(50);
  assert.deepEqual(adapter.opens[1], { channels: ['now'], since: `${E}/now=1` });
});

test('pause closes the adapter, nothing is applied while paused, and resume reopens at once with since', () => {
  const { clock, adapter, store, rec } = opened(['now']);
  adapter.push(snapshot('now', `${E}-1`, { runs: 0 }));
  store.pause();
  store.pause();
  assert.equal(adapter.closes, 1);
  assert.equal(store.status().transport, 'paused');
  assert.equal(adapter.push(patch('now', `${E}-2`, { '/runs': 1 })), false);
  adapter.stray(patch('now', `${E}-2`, { '/runs': 1 }));
  adapter.stray(snapshot('now', `${E}-3`, { runs: 7 }));
  adapter.state('closed');
  store.subscribe('tasks:feat-a', () => {});
  clock.advance(60000);
  assert.equal(adapter.opens.length, 1);
  assert.equal(rec.now.events.length, 1);
  assert.equal(store.status().lastFrameAt, 50);
  store.resume();
  store.resume();
  assert.deepEqual(adapter.opens[1], { channels: ['now', 'tasks:feat-a'], since: `${E}/now=1` });
  assert.equal(adapter.opens.length, 2);
});

test('a hidden tab closes the adapter like a pause and reopens with since when visible', () => {
  const { clock, adapter, store, setHidden, rec } = opened(['now']);
  adapter.push(snapshot('now', `${E}-2`, { runs: 0 }));
  setHidden(true);
  assert.equal(adapter.closes, 1);
  assert.equal(store.status().transport, 'hidden');
  adapter.stray(patch('now', `${E}-3`, { '/runs': 1 }));
  clock.advance(60000);
  assert.equal(adapter.opens.length, 1);
  assert.equal(rec.now.events.length, 1);
  // Paused while hidden: becoming visible does not reopen; resume does.
  store.pause();
  setHidden(false);
  assert.equal(adapter.opens.length, 1);
  store.resume();
  assert.deepEqual(adapter.opens[1], { channels: ['now'], since: `${E}/now=2` });
  // A store made while hidden opens on its first visible change.
  const late = setup({ hidden: true });
  late.store.subscribe('now', () => {});
  late.clock.advance(1000);
  assert.equal(late.adapter.opens.length, 0);
  late.setHidden(false);
  assert.deepEqual(late.adapter.opens, [{ channels: ['now'], since: null }]);
});

test('refused and unsupported reopen every 30000 ms; closed reopens after 5000 ms', () => {
  for (const state of ['refused', 'unsupported']) {
    const { clock, adapter, store } = opened(['now']);
    adapter.state(state, state === 'refused' ? 'stream-limit' : 'live-unavailable');
    assert.equal(store.status().transport, state);
    clock.advance(29999);
    assert.equal(adapter.opens.length, 1, state);
    clock.advance(1);
    assert.equal(adapter.opens.length, 2, state);
    adapter.state(state);
    clock.advance(30000);
    assert.equal(adapter.opens.length, 3, `${state} repeats`);
  }
  // Closed, then refused and hidden during the wait: nothing opens until visible, then at once.
  const { clock, adapter, setHidden } = opened(['now']);
  adapter.state('closed');
  clock.advance(4999);
  assert.equal(adapter.opens.length, 1);
  clock.advance(1);
  assert.equal(adapter.opens.length, 2);
  adapter.state('refused', 'stream-limit');
  setHidden(true);
  clock.advance(60000);
  assert.equal(adapter.opens.length, 2);
  setHidden(false);
  assert.equal(adapter.opens.length, 3);
});

test('three retrying states without a frame close the adapter as a refusal; a frame between them resets the count', () => {
  const { clock, adapter, store } = opened(['now']);
  const transport: any[] = [];
  store.onTransport((event: any) => { transport.push(event); });
  adapter.state('retrying');
  adapter.state('retrying');
  adapter.push(snapshot('now', `${E}-1`, { runs: 0 }));
  adapter.state('retrying');
  adapter.state('open');
  adapter.state('retrying');
  assert.equal(adapter.closes, 0);
  adapter.state('retrying');
  adapter.state('retrying');
  assert.equal(adapter.closes, 1);
  assert.deepEqual(transport.map((e) => e.state), ['retrying', 'retrying', 'retrying', 'open', 'retrying', 'retrying', 'retrying', 'refused']);
  assert.deepEqual(transport[transport.length - 1], { state: 'refused', code: 'retry-limit', at: 50 });
  assert.deepEqual(store.status(), { transport: 'refused', lastFrameAt: 50 });
  clock.advance(29999);
  assert.equal(adapter.opens.length, 1);
  clock.advance(1);
  assert.deepEqual(adapter.opens[1], { channels: ['now'], since: `${E}/now=1` });
});

test('FU-314stt: quiet reconnects (open without frame) reset retrying; three open/retrying cycles do not refuse', () => {
  const { adapter } = opened(['now']);
  for (let i = 0; i < 3; i++) {
    adapter.state('retrying');
    adapter.state('open');
  }
  assert.equal(adapter.closes, 0);
});

test('a patch never changes a state object a listener already holds', () => {
  const { adapter, rec } = opened(['now']);
  adapter.push(snapshot('now', `${E}-1`, { runs: { status: 200, body: { sections: { list: { a: 1 }, keep: { b: 2 } } } } }));
  const held = rec.now.last().state;
  const text = JSON.stringify(held);
  adapter.push(patch('now', `${E}-2`, { '/runs/body/sections/list': { a: 2 } }, ['/runs/body/sections/keep']));
  assert.equal(JSON.stringify(held), text);
  const next = rec.now.last().state;
  assert.notEqual(next, held);
  assert.deepEqual(next, { runs: { status: 200, body: { sections: { list: { a: 2 } } } } });
});

test('more than 8 channels: the extra subscriber hears too-many-channels and joins when a slot frees', () => {
  const { clock, adapter, store } = setup();
  const offs = Array.from({ length: 8 }, (_, i) => store.subscribe(`tasks:f${i}`, () => {}));
  const extra = recorder();
  store.subscribe('tasks:f8', extra.listener);
  assert.deepEqual(extra.events, [{ kind: 'error', state: null, code: 'too-many-channels' }]);
  clock.advance(50);
  assert.equal(adapter.opens[0].channels.length, 8);
  assert.ok(!adapter.opens[0].channels.includes('tasks:f8'));
  offs[0]();
  clock.advance(50);
  assert.deepEqual(adapter.opens[1].channels, ['tasks:f1', 'tasks:f2', 'tasks:f3', 'tasks:f4', 'tasks:f5', 'tasks:f6', 'tasks:f7', 'tasks:f8']);
});

test('Adapter seam: a fake adapter sending the hub diff ends at the hub state (snapshot and two patches)', () => {
  const { adapter, store, rec } = opened(['now']);
  const s0 = { runs: { status: 200, body: { runs: [{ id: 'r1' }], meta: { a: { b: { c: 1 } } } } }, sessions: { status: 200, body: { sections: { slots: { x: 1 }, list: [] } } } };
  const s1 = { runs: { status: 200, body: { runs: [{ id: 'r1' }, { id: 'r2' }], meta: { a: { b: { c: 2, d: 'x/y~z' } } } } }, sessions: { status: 200, body: { sections: { slots: {}, list: [1] } } } };
  const s2 = { runs: { status: 503, body: { error: { code: 'live-unavailable' } } }, sessions: { status: 200, body: { sections: { list: [1] }, 'k/~': true } } };
  adapter.push(snapshot('now', `${E}-1`, s0));
  adapter.push(env('now', `${E}-2`, 'patch', diffState(s0, s1)));
  assert.deepEqual(rec.now.last().state, s1);
  adapter.push(env('now', `${E}-3`, 'patch', diffState(s1, s2)));
  assert.deepEqual(rec.now.last().state, s2);
  assert.equal(rec.now.events.length, 3);
  assert.equal(store.status().transport, 'idle');
  adapter.state('open');
  assert.deepEqual(store.status(), { transport: 'open', lastFrameAt: 50 });
});

// ---- 150 IC-006, IC-007, IC-014, IC-019: the log lane ----------------------------------------------------

const OUT = 'worker:w-1a2b3c4d5e6f:out';
const ERR = 'worker:w-1a2b3c4d5e6f:err';
const logSnap = (ch: string, id: string, data: any = {}) => env(ch, id, 'snapshot', { log: 'open', ino: id.split(':')[0], from: 0, to: Number(id.split(':')[1]), pieces: [], phase: 'running', end: null, ...data });
const logAppend = (ch: string, id: string, from: number, pieces: any[] = []) => env(ch, id, 'append', { from, to: Number(id.split(':')[1]), pieces, phase: 'running', end: null });

test('log lane: an append on a log channel is applied in order, with its id; an append on any other channel is still dropped', () => {
  const { adapter, rec } = opened(['now', OUT]);
  adapter.push(env('now', `${E}-1`, 'append', { from: 0, to: 1, pieces: [] }));
  assert.equal(rec.now.events.length, 0, 'append is not a frame of now');
  adapter.push(snapshot('now', `${E}-2`, { runs: 0 }));
  adapter.push(env('now', `${E}-3`, 'append', { from: 0, to: 1, pieces: [] }));
  assert.deepEqual(rec.now.events.map((e) => e.kind), ['state'], 'and it is dropped after a snapshot too');
  const a1 = logAppend(OUT, '77:10:1:5', 0, [{ at: 0, text: 'one' }]);
  const a2 = logAppend(OUT, '77:20:2:6', 10, [{ at: 10, text: 'two' }]);
  adapter.push(a1);
  adapter.push(a2);
  assert.deepEqual(rec[OUT].events, [
    { kind: 'append', state: a1.data, code: null, id: '77:10:1:5' },
    { kind: 'append', state: a2.data, code: null, id: '77:20:2:6' },
  ]);
  const snap = logSnap(OUT, '77:30:3:7');
  adapter.push(snap);
  assert.deepEqual(rec[OUT].last(), { kind: 'state', state: snap.data, code: null, id: '77:30:3:7' });
});

test('log lane: the id checks follow the kind, a patch never applies, and log frames leave the epoch alone', () => {
  const { clock, adapter, store, rec } = opened(['now', OUT]);
  adapter.push(logAppend(OUT, `${E}-1`, 0));
  adapter.push(logAppend(OUT, '77:10:0:5', 0));
  adapter.push(logAppend(OUT, '77:10', 0));
  adapter.push(snapshot('now', '77:10:1:5', { runs: 0 }));
  assert.equal(store.status().lastFrameAt, null, 'a frame whose id is not of its channel\'s kind is not heard');
  adapter.push(env(OUT, '77:10:1:5', 'patch', { set: {}, unset: [] }));
  adapter.push(env(OUT, '77:10:2:5', 'append', []));
  assert.equal(rec[OUT].events.length, 0);
  assert.equal(rec.now.events.length, 0);
  adapter.push(logAppend(OUT, '77:10:3:5', 0));
  assert.equal(rec[OUT].events.length, 1);
  store.subscribe('tasks:feat-a', () => {});
  clock.advance(50);
  assert.deepEqual(adapter.opens[1], { channels: ['now', OUT, 'tasks:feat-a'], since: `00000000/${OUT}=77:10` }, 'a log position is used whatever the epoch');
});

test('log lane: since carries each log lane\'s ino:to beside the n positions, from the position the subscriber gives or else the last frame', () => {
  const ctx = setup();
  let held: string | null = '8812345:4096';
  const out = recorder();
  ctx.store.subscribe('now', () => {});
  ctx.store.subscribe(OUT, out.listener, { position: () => held });
  ctx.store.subscribe(ERR, () => {});
  ctx.clock.advance(50);
  assert.deepEqual(ctx.adapter.opens[0], { channels: ['now', OUT, ERR], since: `00000000/${OUT}=8812345:4096` });
  ctx.adapter.push(snapshot('now', `${E}-3`, { runs: 0 }));
  ctx.adapter.push(logSnap(ERR, '5:40:1:1'));
  held = '8812345:8192';
  ctx.store.subscribe('tasks:feat-a', () => {});
  ctx.clock.advance(50);
  assert.deepEqual(ctx.adapter.opens[1].since, `${E}/now=3,${OUT}=8812345:8192,${ERR}=5:40`, 'the given position is read at each open');
  // No position (nothing held, or following paused) and a malformed one leave the lane out, so it gets a snapshot.
  for (const value of [null, '8812345', 'x:1', '1:2:3', 7]) {
    held = value as any;
    ctx.store.pause();
    ctx.store.resume();
    assert.equal(ctx.adapter.opens.at(-1).since, `${E}/now=3,${ERR}=5:40`, String(value));
  }
});

test('log lane: reset, error and gone drop the lane\'s own position; reset tells its reason', () => {
  const { clock, adapter, store, rec } = opened([OUT, ERR]);
  adapter.push(logSnap(OUT, '9:10:1:1'));
  adapter.push(logSnap(ERR, '9:20:1:1'));
  adapter.push(env(OUT, '9:10:2:1', 'reset', { reason: 'replaced' }));
  assert.deepEqual(rec[OUT].last(), { kind: 'reset', state: null, code: 'replaced' });
  adapter.push(env(ERR, '9:20:2:1', 'error', { code: 'events-down' }));
  assert.deepEqual(rec[ERR].last(), { kind: 'error', state: null, code: 'events-down' });
  store.subscribe('now', () => {});
  clock.advance(50);
  assert.equal(adapter.opens[1].since, null);
  adapter.push(logAppend(ERR, '9:30:3:1', 20));
  adapter.push(env(ERR, '9:30:4:1', 'gone', {}));
  assert.deepEqual(rec[ERR].last(), { kind: 'gone', state: null, code: null });
  clock.advance(50);
  assert.deepEqual(adapter.opens[2].channels, [OUT, 'now'], 'a gone log lane leaves the union');
});
