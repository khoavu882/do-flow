'use strict';

// Console live discipline (feature 133, FR-1 to FR-3 and FR-6; agent-docs/doflow/133-console-live-discipline/design.md).
// Like client-core.test.ts, the web modules are copied beside a {"type":"module"} marker and imported; the poller and the stream
// run on a fake clock, so nothing waits in real time.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let mods: any;
const url = (name: string) => pathToFileURL(path.join(copy, name)).href;

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-live-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  mods = { poll: await import(url('poll.js')), views: await import(url('views.js')) };
});
after(() => { fs.rmSync(copy, { recursive: true, force: true }); });

function fakeClock() {
  const clock: any = {
    time: 0, timers: [] as Array<{ at: number, fn: () => void, id: number }>, id: 0,
    now: () => clock.time,
    setTimeout: (fn: () => void, ms: number) => { clock.id += 1; clock.timers.push({ at: clock.time + ms, fn, id: clock.id }); return clock.id; },
    clearTimeout: (id: number) => { clock.timers = clock.timers.filter((t: any) => t.id !== id); },
    async advance(ms: number) {
      const end = clock.time + ms;
      await clock.flush();
      for (;;) {
        const due = clock.timers.filter((t: any) => t.at <= end).sort((a: any, b: any) => a.at - b.at)[0];
        if (!due) break;
        clock.timers = clock.timers.filter((t: any) => t !== due);
        clock.time = due.at;
        due.fn();
        await clock.flush();
      }
      clock.time = end;
    },
    async flush() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); },
  };
  return clock;
}

function poller(extra: any = {}, script: Array<'ok' | 'fail'> = []) {
  const clock = fakeClock();
  let hidden = false;
  let listener: () => void = () => {};
  const fetched: number[] = [];
  const instance = mods.poll.createPoller({
    clock,
    visibility: { hidden: () => hidden, subscribe: (fn: () => void) => { listener = fn; return () => {}; } },
    intervalMs: 5000,
    fetchOnce: () => {
      fetched.push(clock.time);
      return (script.shift() ?? 'ok') === 'ok' ? Promise.resolve({ n: fetched.length }) : Promise.reject({ status: null, network: true });
    },
    ...extra,
  });
  return { instance, clock, fetched, setHidden(value: boolean) { hidden = value; listener(); } };
}

// ---- FR-1: activity-aware polling -----------------------------------------------------------------------

test('poller: the interval is x10 while nothing is running and returns to the base when something runs', async () => {
  let active = true;
  const p = poller({ isActive: () => active });
  p.instance.start();
  await p.clock.advance(5001);
  assert.deepEqual(p.fetched, [0, 5000], 'active: the base interval');
  active = false;
  await p.clock.advance(5000); // the poll at 10000 is already scheduled at the base; it reads the idle state on settling
  assert.deepEqual(p.fetched, [0, 5000, 10000]);
  await p.clock.advance(49_998);
  assert.deepEqual(p.fetched, [0, 5000, 10000], 'idle: nothing for 50 s after the last poll');
  await p.clock.advance(2);
  assert.deepEqual(p.fetched, [0, 5000, 10000, 60000]);
  active = true;
  await p.clock.advance(50_001); // the idle wait already scheduled finishes; the next delay is the base again
  assert.deepEqual(p.fetched, [0, 5000, 10000, 60000, 110000]);
  await p.clock.advance(5000);
  assert.equal(p.fetched[5], 115000);
});

test('poller: the interval is at least nodes/1000 s and grows with the graph', async () => {
  let nodes = 0;
  const p = poller({ size: () => nodes });
  p.instance.start();
  await p.clock.advance(1);
  nodes = 800; // 0.8 s: under the base, no effect
  await p.clock.advance(5000);
  assert.deepEqual(p.fetched, [0, 5000]);
  nodes = 12_000; // 12 s
  await p.clock.advance(5000);
  assert.deepEqual(p.fetched, [0, 5000, 10000]);
  await p.clock.advance(11_998);
  assert.deepEqual(p.fetched, [0, 5000, 10000], 'the next poll is 12 s after the last');
  await p.clock.advance(2);
  assert.equal(p.fetched.length, 4);
  assert.equal(p.fetched[3], 22000);
});

test('poller: idle and size multiply (the larger base times 10)', async () => {
  const p = poller({ isActive: () => false, size: () => 8000 });
  p.instance.start();
  await p.clock.advance(1);
  await p.clock.advance(79_998);
  assert.deepEqual(p.fetched, [0], 'the first success schedules 8 s x 10');
  await p.clock.advance(2);
  assert.deepEqual(p.fetched, [0, 80000]);
});

test('poller: failure backoff stays 5/10/30 s whatever the activity and size', async () => {
  const p = poller({ isActive: () => false, size: () => 20_000 }, ['fail', 'fail', 'fail', 'fail']);
  p.instance.start();
  await p.clock.advance(100_000);
  assert.deepEqual(p.fetched.slice(0, 5), [0, 5000, 15000, 45000, 75000]);
});

test('poller: the hidden-tab pause and the stale rule are unchanged by the activity sources', async () => {
  const p = poller({ isActive: () => false });
  p.instance.start();
  await p.clock.advance(1);
  p.setHidden(true);
  await p.clock.advance(120_000);
  assert.deepEqual(p.fetched, [0]);
  assert.equal(p.instance.isStale(), false, 'not evaluated while hidden');
  p.setHidden(false);
  await p.clock.advance(1);
  assert.equal(p.fetched.length, 2);
  const stale = poller({ isActive: () => false }, ['ok', 'fail', 'fail', 'fail']);
  stale.instance.start();
  await stale.clock.advance(1);
  assert.equal(stale.instance.isStale(), false);
  stale.instance.refreshNow();
  await stale.clock.advance(5000);
  await stale.clock.advance(10000);
  assert.equal(stale.instance.misses, 3);
  assert.equal(stale.instance.isStale(), true);
});

test('views: runs, run and tasks say when nothing is running, and the run views give the graph size', () => {
  const { VIEWS } = mods.views;
  const now = Date.parse('2026-10-27T12:00:00Z');
  const run = (state: string, updatedAt = '2026-10-27T11:59:00Z') => ({ state, updatedAt });
  assert.equal(VIEWS.runs.active({ runs: [run('COMPLETED'), run('RUNNING')] }, now), true);
  assert.equal(VIEWS.runs.active({ runs: [run('COMPLETED'), run('AWAITING_GATE')] }, now), true, 'a run at a gate is live');
  assert.equal(VIEWS.runs.active({ runs: [run('COMPLETED'), run('REJECTED')] }, now), false);
  assert.equal(VIEWS.runs.active({ runs: [run('RUNNING', '2026-10-25T11:00:00Z')] }, now), false, 'a stale run is idle');
  assert.equal(VIEWS.runs.active({ runs: [] }, now), false);
  for (const id of ['run', 'tasks']) {
    assert.equal(VIEWS[id].active({ run: run('RUNNING') }, now), true);
    assert.equal(VIEWS[id].active({ run: run('AWAITING_GATE') }, now), true);
    assert.equal(VIEWS[id].active({ run: run('REJECTED') }, now), false);
    assert.equal(VIEWS[id].size({ graph: { tasks: new Array(3000).fill({}) } }), 3000);
    assert.equal(VIEWS[id].size({}), 0);
  }
  assert.equal(VIEWS.sessions.active, undefined, 'a view without the hook is always active');
});

test('poller: the stale age allows for the deliberate idle wait, so a quiet view does not read stale', async () => {
  const p = poller({ isActive: () => false });
  p.instance.start();
  await p.clock.advance(1);
  await p.clock.advance(30_000);
  assert.equal(p.instance.isStale(), false, '30 s into a 50 s idle wait is not stale');
  await p.clock.advance(20_000); // 50 s after the success: the next poll is due
  assert.equal(p.fetched.length, 2);
  const base = poller({});
  base.instance.start();
  await base.clock.advance(1);
  base.instance.stop();
  base.instance.start(60_000);
  assert.equal(base.instance.isStale(), false);
});
