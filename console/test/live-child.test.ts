'use strict';

// Events supervisor (feature 149, IC-009 as amended by DEC-054). Most cases drive a fake runner whose
// follow handles the test exits by hand, on a fake clock, so the 1 s, 2 s, 5 s and 30 s restarts and
// the 60 s step reset take no real time. Two cases spawn fixtures/fake-core.js through the real verb
// runner: an old core's `unknown flag '--follow'` reply and an internal `[ERROR]` fault.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createLiveChild, isCoreEnvelope, RESTART_DELAYS_MS, STEP_RESET_MS } = require('../src/live-child.ts');
const { createVerbRunner } = require('../src/verb-runner.ts');

const FAKE_CORE = path.join(__dirname, 'fixtures', 'fake-core.js');

function fakeClock() {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
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
    advance(ms: number) {
      now += ms;
      for (const handle of [...timers].sort((a, b) => a.at - b.at)) {
        if (handle.at <= now) {
          timers.delete(handle);
          handle.fn();
        }
      }
    },
  };
}

type Exit = { code: number | null; signal: string | null; lines: number; sawError: boolean; sawUnknown: boolean; reason: string };

/** One fake follow child: what it was sent, how often it was ended, and `line` / `exit` to drive it. */
function fakeChild() {
  const sent: string[] = [];
  const listeners: Array<(line: string) => void> = [];
  let open = true;
  let lines = 0;
  let resolve: (exit: Exit) => void = () => {};
  const exited = new Promise<Exit>((done) => {
    resolve = done;
  });
  const child = {
    sent,
    ended: 0,
    handle: {
      send(message: { op: string; ch: string }) {
        if (!open) return false;
        sent.push(`${message.op} ${message.ch}`);
        return true;
      },
      onLine(listener: (line: string) => void) {
        listeners.push(listener);
      },
      exited,
      end() {
        child.ended += 1;
        open = false;
      },
    },
    line(text: string) {
      lines += 1;
      for (const listener of listeners) listener(text);
    },
    exit(fields: Partial<Exit> = {}) {
      open = false;
      resolve({ code: 0, signal: null, lines, sawError: false, sawUnknown: false, reason: 'exit', ...fields });
    },
  };
  return child;
}

function fakeRunner() {
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const runner = {
    children,
    calls: [] as string[],
    refuse: false,
    follow(shapeId: string) {
      runner.calls.push(shapeId);
      if (runner.refuse) return null;
      const child = fakeChild();
      children.push(child);
      return child.handle;
    },
  };
  return runner;
}

/** Lets the `exited` continuations run. */
const settle = () => new Promise((done) => setImmediate(done));

function setup() {
  const clock = fakeClock();
  const runner = fakeRunner();
  const live = createLiveChild({ runner, clock });
  const frames: any[] = [];
  const downs: Array<{ code: string; at: number; wall: number }> = [];
  live.onFrame((envelope: any) => frames.push(envelope));
  live.onDown((code: string) => downs.push({ code, at: clock.now(), wall: Date.now() }));
  return { clock, runner, live, frames, downs };
}

const envelope = (fields: Record<string, unknown> = {}) => ({ v: 1, ch: 'now', id: '0fa4ec0d-1', type: 'snapshot', at: '2026-11-07T12:00:00.000Z', data: { sections: {} }, ...fields });

/** Exits the newest child the way `fields` says and lets the supervisor see it. */
async function exitLast(runner: ReturnType<typeof fakeRunner>, fields: Partial<Exit> = {}) {
  runner.children[runner.children.length - 1].exit(fields);
  await settle();
}

test('a non-empty set starts one child through follow("events") with one sub per channel', () => {
  const { runner, live } = setup();
  assert.equal(live.state, 'stopped');
  live.need(new Set(['now', 'tasks:feat-a']));
  assert.equal(live.state, 'running');
  assert.deepEqual(runner.calls, ['events']);
  assert.deepEqual(runner.children[0].sent, ['sub now', 'sub tasks:feat-a']);
});

test('while running only the difference is sent', () => {
  const { runner, live } = setup();
  live.need(new Set(['now', 'tasks:a']));
  live.need(new Set(['now', 'run:a:t1']));
  live.need(new Set(['now', 'run:a:t1']));
  assert.deepEqual(runner.children[0].sent, ['sub now', 'sub tasks:a', 'unsub tasks:a', 'sub run:a:t1']);
  assert.deepEqual(runner.calls, ['events']);
});

test('an empty set ends the child at once and is stopped; its exit is neither down nor restarted', async () => {
  const { clock, runner, live, downs } = setup();
  live.need(new Set(['now']));
  live.need(new Set());
  assert.equal(runner.children[0].ended, 1);
  assert.equal(live.state, 'stopped');
  await exitLast(runner, { code: 0 });
  clock.advance(10 * 60_000);
  assert.equal(live.state, 'stopped');
  assert.deepEqual(downs, []);
  assert.equal(runner.calls.length, 1);
});

test('a set needed again before the ended child exits starts the next child after that exit', async () => {
  const { runner, live, downs } = setup();
  live.need(new Set(['now']));
  live.need(new Set());
  live.need(new Set(['tasks:a']));
  live.need(new Set(['tasks:a', 'now']));
  assert.equal(runner.calls.length, 1, 'the runner allows one follow child at a time');
  await exitLast(runner, { code: 0 });
  assert.equal(runner.calls.length, 2);
  assert.equal(live.state, 'running');
  assert.deepEqual(runner.children[1].sent, ['sub tasks:a', 'sub now']);
  assert.deepEqual(downs, []);
});

test('IC-002 envelopes reach onFrame in order', () => {
  const { runner, live, frames } = setup();
  live.need(new Set(['now']));
  runner.children[0].line(JSON.stringify(envelope()));
  runner.children[0].line(JSON.stringify(envelope({ id: '0fa4ec0d-2', type: 'patch' })));
  assert.deepEqual(frames, [envelope(), envelope({ id: '0fa4ec0d-2', type: 'patch' })]);
  assert.equal(runner.children[0].ended, 0);
});

test('isCoreEnvelope accepts every frame type and refuses every other shape', () => {
  for (const type of ['snapshot', 'patch', 'append', 'reset', 'error', 'gone']) assert.equal(isCoreEnvelope(envelope({ type })), true, type);
  assert.equal(isCoreEnvelope(envelope({ id: 'ffffffff-1234567890123456' })), true);
  const refused: unknown[] = [
    null,
    [],
    'text',
    envelope({ v: 2 }),
    envelope({ v: '1' }),
    envelope({ ch: '' }),
    envelope({ ch: 7 }),
    envelope({ id: '0FA4EC0D-1' }),
    envelope({ id: '0fa4ec0d-0' }),
    envelope({ id: '0fa4ec0d-12345678901234567' }),
    envelope({ id: '0fa4ec0-1' }),
    envelope({ type: 'other' }),
    envelope({ at: 1 }),
    envelope({ data: [] }),
    envelope({ data: null }),
    envelope({ extra: true }),
    (() => {
      const value: any = envelope();
      delete value.at;
      return value;
    })(),
  ];
  for (const value of refused) assert.equal(isCoreEnvelope(value), false, JSON.stringify(value));
  assert.equal(isCoreEnvelope(JSON.parse('{"v":1,"ch":"now","id":"0fa4ec0d-1","type":"patch","at":"x","data":{},"__proto__":{}}')), false);
});

test('a line that is not an envelope ends the child; later lines are dropped and the exit takes the restart path', async () => {
  const { clock, runner, live, frames, downs } = setup();
  live.need(new Set(['now']));
  runner.children[0].line(JSON.stringify(envelope()));
  runner.children[0].line('{"v":1,"ch":"now"}');
  runner.children[0].line(JSON.stringify(envelope({ id: '0fa4ec0d-2' })));
  assert.equal(runner.children[0].ended, 1);
  assert.equal(frames.length, 1);
  assert.equal(live.state, 'running');
  await exitLast(runner, { code: 0 });
  assert.equal(live.state, 'down');
  assert.deepEqual(downs.map((down) => down.code), ['events-down']);
  clock.advance(1_000);
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(runner.children[1].sent, ['sub now']);
});

test('a non-JSON line is a protocol fault too', async () => {
  const { runner, live } = setup();
  live.need(new Set(['now']));
  runner.children[0].line('not json');
  assert.equal(runner.children[0].ended, 1);
  await exitLast(runner, { code: 0 });
  assert.equal(live.state, 'down');
});

test('onDown reports events-down within 100 ms of the exit, with no timer', async () => {
  const { clock, runner, live, downs } = setup();
  live.need(new Set(['now']));
  clock.advance(500);
  const exitWall = Date.now();
  await exitLast(runner, { code: 0 });
  assert.equal(downs.length, 1);
  assert.equal(downs[0].code, 'events-down');
  assert.equal(downs[0].at, 500, 'reported before the clock moves');
  assert.ok(downs[0].wall - exitWall < 100);
  assert.equal(live.state, 'down');
});

test('restarts after 1000, 2000, 5000, then every 30000 ms, never early', async () => {
  const { clock, runner, live } = setup();
  live.need(new Set(['now']));
  assert.deepEqual(RESTART_DELAYS_MS, [1_000, 2_000, 5_000, 30_000]);
  for (const delay of [1_000, 2_000, 5_000, 30_000, 30_000, 30_000]) {
    const before = runner.calls.length;
    await exitLast(runner, { code: 0 });
    clock.advance(delay - 1);
    assert.equal(runner.calls.length, before, `nothing at ${delay - 1} ms`);
    assert.equal(live.state, 'down');
    clock.advance(1);
    assert.equal(runner.calls.length, before + 1, `a restart at ${delay} ms`);
    assert.equal(live.state, 'running');
  }
});

test('a child that ran 60000 ms puts the step back to 1000 ms; one that ran 59999 ms does not', async () => {
  const { clock, runner, live } = setup();
  live.need(new Set(['now']));
  await exitLast(runner);
  clock.advance(1_000);
  await exitLast(runner);
  clock.advance(2_000);
  clock.advance(59_999);
  await exitLast(runner);
  clock.advance(4_999);
  assert.equal(runner.calls.length, 3, 'the 5000 ms step still applies');
  clock.advance(1);
  assert.equal(runner.calls.length, 4);
  clock.advance(STEP_RESET_MS);
  await exitLast(runner);
  clock.advance(999);
  assert.equal(runner.calls.length, 4);
  clock.advance(1);
  assert.equal(runner.calls.length, 5, 'back to the first delay');
  await exitLast(runner);
  clock.advance(2_000);
  assert.equal(runner.calls.length, 6, 'then 2000 ms again');
});

test('a restarted child gets a sub for every channel of the current set, including changes made while down', async () => {
  const { clock, runner, live } = setup();
  live.need(new Set(['now', 'tasks:a']));
  await exitLast(runner, { code: 1 });
  clock.advance(1_000);
  assert.deepEqual(runner.children[1].sent, ['sub now', 'sub tasks:a']);
  await exitLast(runner, { code: 1 });
  live.need(new Set(['now', 'run:a:t1', 'worker:w-0123456789ab']));
  assert.equal(live.state, 'down');
  assert.equal(runner.calls.length, 2, 'need while down does not start early');
  clock.advance(2_000);
  assert.deepEqual(runner.children[2].sent, ['sub now', 'sub run:a:t1', 'sub worker:w-0123456789ab']);
});

for (const [name, fields] of [
  ['the old core (exit 1, unknown flag or command)', { code: 1, sawUnknown: true }],
  ['the projected dispatcher (exit 2, unknown verb)', { code: 2, sawUnknown: true }],
] as const) {
  test(`${name} is unsupported for good: live-unavailable, no restart, need ignored`, async () => {
    const { clock, runner, live, downs } = setup();
    live.need(new Set(['now']));
    await exitLast(runner, fields);
    assert.equal(live.state, 'unsupported');
    assert.deepEqual(downs.map((down) => down.code), ['live-unavailable']);
    assert.equal(clock.pending(), 0);
    clock.advance(10 * 60_000);
    live.need(new Set(['tasks:a']));
    live.need(new Set());
    live.need(new Set(['now']));
    clock.advance(10 * 60_000);
    assert.equal(live.state, 'unsupported');
    assert.equal(runner.calls.length, 1);
    assert.equal(downs.length, 1);
  });
}

for (const [name, fields] of [
  ['an internal fault (exit 1 with [ERROR], before any frame)', { code: 1, sawError: true }],
  ['an internal fault that also names an unknown flag', { code: 1, sawError: true, sawUnknown: true }],
  ['exit 2 with no line and no marker', { code: 2 }],
  ['exit 1 with no line and no marker', { code: 1 }],
  ['frames then exit 1 naming an unknown flag', { code: 1, sawUnknown: true, lines: 2 }],
  ['the line cap', { code: null, signal: 'SIGKILL', reason: 'line-cap' }],
  ['a spawn failure', { code: null, reason: 'spawn-failed' }],
  ['the runner stopping the child', { code: null, signal: 'SIGKILL', reason: 'stopped' }],
  ['a signal', { code: null, signal: 'SIGTERM' }],
] as const) {
  test(`${name} is down and restarts`, async () => {
    const { clock, runner, live, downs } = setup();
    live.need(new Set(['now']));
    await exitLast(runner, fields);
    assert.equal(live.state, 'down');
    assert.deepEqual(downs.map((down) => down.code), ['events-down']);
    clock.advance(1_000);
    assert.equal(runner.calls.length, 2);
    assert.equal(live.state, 'running');
  });
}

test('a follow() that returns null is down and keeps to the restart steps', () => {
  const { clock, runner, live, downs } = setup();
  runner.refuse = true;
  live.need(new Set(['now']));
  assert.equal(live.state, 'down');
  assert.deepEqual(downs.map((down) => down.code), ['events-down']);
  clock.advance(1_000);
  assert.equal(runner.calls.length, 2);
  assert.equal(downs.length, 2);
  runner.refuse = false;
  clock.advance(1_999);
  assert.equal(runner.calls.length, 2);
  clock.advance(1);
  assert.equal(live.state, 'running');
  assert.deepEqual(runner.children[0].sent, ['sub now']);
});

test('stop() ends the child, cancels a pending restart and ignores later need', async () => {
  const { clock, runner, live, downs } = setup();
  live.need(new Set(['now']));
  await exitLast(runner, { code: 0 });
  assert.equal(clock.pending(), 1);
  live.stop();
  assert.equal(clock.pending(), 0);
  assert.equal(live.state, 'stopped');
  clock.advance(10 * 60_000);
  live.need(new Set(['now']));
  assert.equal(runner.calls.length, 1);
  assert.equal(downs.length, 1);
});

test('stop() while running ends the child; its exit is not reported', async () => {
  const { clock, runner, live, downs } = setup();
  live.need(new Set(['now']));
  live.stop();
  assert.equal(runner.children[0].ended, 1);
  await exitLast(runner, { code: 0 });
  clock.advance(10 * 60_000);
  assert.equal(live.state, 'stopped');
  assert.deepEqual(downs, []);
  assert.equal(runner.calls.length, 1);
});

test('an empty set while down cancels the restart and is stopped; a later set starts at once', async () => {
  const { clock, runner, live } = setup();
  live.need(new Set(['now']));
  await exitLast(runner, { code: 1 });
  live.need(new Set(['tasks:a']));
  live.need(new Set());
  assert.equal(live.state, 'stopped');
  assert.equal(clock.pending(), 0);
  clock.advance(10 * 60_000);
  assert.equal(runner.calls.length, 1);
  live.need(new Set(['now']));
  assert.equal(runner.calls.length, 2);
  assert.equal(live.state, 'running');
});

test('a throwing listener breaks neither the supervisor nor the other listeners', async () => {
  const { clock, runner, live, frames, downs } = setup();
  live.onFrame(() => {
    throw new Error('frame listener');
  });
  live.onDown(() => {
    throw new Error('down listener');
  });
  const lateFrames: unknown[] = [];
  live.onFrame((value: unknown) => lateFrames.push(value));
  live.need(new Set(['now']));
  runner.children[0].line(JSON.stringify(envelope()));
  assert.equal(frames.length, 1);
  assert.equal(lateFrames.length, 1);
  assert.equal(runner.children[0].ended, 0);
  await exitLast(runner, { code: 0 });
  assert.equal(downs.length, 1);
  clock.advance(1_000);
  assert.equal(live.state, 'running');
});

// Real spawns through the verb runner. The supervisor's clock is fake, so a restart happens only when the case advances it.
const runners: any[] = [];
after(() => {
  for (const runner of runners) runner.stop();
});

function realSetup(script: string) {
  const runner = createVerbRunner({ corePath: FAKE_CORE, projectRoot: os.tmpdir(), env: { ...process.env, FAKE_CORE_MODE: 'events', FAKE_EVENTS_SCRIPT: script } });
  runners.push(runner);
  const clock = fakeClock();
  const live = createLiveChild({ runner, clock });
  const downs: string[] = [];
  let wake: () => void = () => {};
  live.onDown((code: string) => {
    downs.push(code);
    wake();
  });
  const nextDown = () => new Promise<void>((done) => {
    wake = done;
  });
  return { runner, clock, live, downs, nextDown };
}

test('real spawn: an old core that refuses --follow is unsupported', async () => {
  const { runner, clock, live, downs, nextDown } = realSetup('old-flag');
  const down = nextDown();
  live.need(new Set(['now']));
  await down;
  assert.equal(live.state, 'unsupported');
  assert.deepEqual(downs, ['live-unavailable']);
  assert.equal(clock.pending(), 0);
  live.stop();
  runner.stop();
});

test('real spawn: an [ERROR] fault before any frame is down and restarts', async () => {
  const { runner, clock, live, downs, nextDown } = realSetup('fault');
  let down = nextDown();
  live.need(new Set(['now']));
  await down;
  assert.equal(live.state, 'down');
  down = nextDown();
  clock.advance(1_000);
  assert.equal(live.state, 'running');
  await down;
  assert.equal(live.state, 'down');
  assert.deepEqual(downs, ['events-down', 'events-down']);
  live.stop();
  runner.stop();
});
