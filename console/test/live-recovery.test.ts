'use strict';

// Kill-child recovery (feature 149, E.3; NFR-002, DEC-020, FR-011, FR-018, IC-009, IC-018).
//
// Server part: the Console's parts as main() wires them (verb runner, events supervisor, live hub,
// consoleRoutes on a real server on 127.0.0.1:0, all on the real clock) over the REAL core
// (bin/doflow.js) in a project built by helpers/core-fixture.ts, which also owns the temp folder.
// Every spawn goes through an injected `spawnImpl` that records the child, its spawn time and its
// close time. One `/api/live` connection follows `run:<slug>:<task>` and the two core channels the run
// composition reads (`tasks:<slug>`, `now`); once each has its snapshot the events child is killed once
// with SIGKILL, and the case asserts, on the open connection:
//   - an `error` `events-down` frame on every channel within 3000 ms of the kill;
//   - the second events child spawned no earlier than 1000 ms after the first one closed (IC-009);
//   - a fresh `snapshot` (a greater n than the error, same epoch) on every channel within 10000 ms of
//     the kill, equal to the state before the kill for the run and tasks channels; exactly two events
//     children in all.
//
// Client part: the Run view's connector (views.js VIEWS.run.connect, live-view.js) over the page's
// store (store.js) with a fake adapter, on node:test's mock timers (setTimeout, setInterval, Date).
// The pill is the shell's own `pillFor` (app.js), taken from the app.js source and run with the real
// `classify` and `clockTime` of states.js, because app.js does not export it and needs a whole page.
//   - one kill: the `error` `events-down` frame turns the pill to Polling at once (100 ms after the
//     kill), the view keeps updating by its 3 s GET, and the fresh snapshot (9 s after the kill)
//     turns it back to Live and stops the GET timer; push-lost and push-back are announced;
//   - a child that keeps failing: no snapshot comes, so for 60 s (a browser reconnect included,
//     whose stream re-sends the channel's error) the pill reads Polling at every 1 s tick and the
//     view keeps updating by GET; push-back is never announced;
//   - a frozen server (FU-mnes07): the adapter's `closed` `silent` after live data hands over to a poller whose GET never
//     answers, and the view is stale once 20 s passed since the stream went quiet.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const { CORE_CLI, SLUGS, buildFixture } = require('./helpers/core-fixture.ts');
const { tempDir } = require('../../test/helper/tmp.ts');
const { createVerbRunner } = require('../src/verb-runner.ts');
const { createLiveChild, RESTART_DELAYS_MS } = require('../src/live-child.ts');
const { createLiveHub } = require('../src/live.ts');
const { createServer } = require('../src/server.ts');
const { consoleRoutes } = require('../src/routes.ts');
const { createSessions, cookieName } = require('../src/session.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const FOLLOW_ARGV = ['events', '--follow', '--control', 'stdin', '--json'];
/** NFR-002 and IC-009 bars. */
const DOWN_WITHIN_MS = 3_000;
const RESTART_NOT_BEFORE_MS = 1_000;
const LIVE_AGAIN_WITHIN_MS = 10_000;
/** The first snapshot of every channel from a cold real core; the longest real-time wait of the file. */
const FIRST_SNAPSHOT_MS = 12_000;

const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded wait in real time. */
async function until(check: () => boolean, label: string, ms: number) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) assert.fail(`timed out after ${ms} ms: ${label}`);
    await realDelay(10);
  }
}

// ---- server part ----

type Spawned = { argv: string[], child: any, spawnedAt: number, closedAt: number | null };
type Received = { frame: any, at: number };
type LiveStream = { status: number, received: Received[], closed: () => boolean, destroy(): void };

/** Opens GET /api/live on `channels`; every complete SSE message with data is recorded with its arrival time. */
function openLive(port: number, cookie: string, channels: string[]): Promise<LiveStream> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/live?ch=${channels.join(',')}`, agent: false, headers: { Cookie: cookie } }, (res: any) => {
      const received: Received[] = [];
      let buffer = '';
      let closed = false;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        const at = performance.now();
        buffer += chunk;
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const line = block.split('\n').find((entry) => entry.startsWith('data: '));
          if (line !== undefined) received.push({ frame: JSON.parse(line.slice(6)), at });
        }
      });
      res.on('error', () => {});
      res.on('close', () => { closed = true; });
      resolve({ status: res.statusCode, received, closed: () => closed, destroy: () => req.destroy() });
    });
    req.on('error', (error: any) => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end();
  });
}

const framesOn = (stream: LiveStream, channel: string, type: string, after = -Infinity) =>
  stream.received.filter((entry) => entry.frame.ch === channel && entry.frame.type === type && entry.at >= after);
const nOf = (frame: any) => Number(frame.id.split('-')[1]);
const epochOf = (frame: any) => frame.id.split('-')[0];

test('one kill of the real events child: events-down on every channel within 3 s, no restart before 1 s, a fresh snapshot within 10 s', { timeout: 60_000 }, async (t: any) => {
  const cleanups: Array<() => void> = [];
  const f = buildFixture((fn: () => void) => cleanups.push(fn));
  const SLUG = SLUGS.graph;
  const RUN = `run:${SLUG}:run-gate`;
  const TASKS = `tasks:${SLUG}`;
  const CHANNELS = [RUN, TASKS, 'now'];
  const webRoot = path.join(f.dir, 'web');
  fs.mkdirSync(webRoot);

  const spawns: Spawned[] = [];
  const runner = createVerbRunner({
    corePath: CORE_CLI,
    projectRoot: f.main,
    env: f.env,
    spawnImpl: (command: string, args: string[], options: any) => {
      const child = childProcess.spawn(command, args, options);
      const entry: Spawned = { argv: args.slice(1), child, spawnedAt: performance.now(), closedAt: null };
      child.on('close', () => { entry.closedAt = performance.now(); });
      spawns.push(entry);
      return child;
    },
  });
  const supervisor = createLiveChild({ runner });
  const hub = createLiveHub({ runner, supervisor });
  const sessions = createSessions();
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions, hub) });
  const cookie = `${cookieName(app.port)}=${sessions.exchange(sessions.mintLaunchCode())}`;
  let stream: LiveStream | null = null;
  // One hook, so the children are gone before the fixture's folder is removed.
  t.after(async () => {
    stream?.destroy();
    hub.stop();
    runner.stop();
    await app.close();
    for (const entry of spawns) if (entry.closedAt === null) entry.child.kill('SIGKILL');
    await until(() => spawns.every((entry) => entry.closedAt !== null), 'every core child closed', 5_000).catch(() => {});
    for (const fn of cleanups) fn();
  });

  const events = () => spawns.filter((entry) => entry.argv[0] === 'events');
  const live = await openLive(app.port, cookie, CHANNELS);
  stream = live;
  assert.equal(live.status, 200);
  await until(() => CHANNELS.every((ch) => framesOn(live, ch, 'snapshot').length > 0), `a first snapshot on ${CHANNELS.join(', ')}`, FIRST_SNAPSHOT_MS);
  assert.equal(events().length, 1, 'one events child serves the connection');
  assert.deepEqual(events()[0].argv, FOLLOW_ARGV);
  assert.equal(supervisor.state, 'running');
  const before = Object.fromEntries(CHANNELS.map((ch) => [ch, framesOn(live, ch, 'snapshot').at(-1)!.frame]));
  assert.equal(before[RUN].data.state.run.status, 200, 'the run channel is composed from the real core');
  assert.equal(before[RUN].data.state.run.body.run.taskId, 'run-gate');

  const first = events()[0];
  const killAt = performance.now();
  assert.equal(first.child.kill('SIGKILL'), true, 'the kill was delivered');

  await until(() => CHANNELS.every((ch) => framesOn(live, ch, 'error', killAt).length > 0), 'an error frame on every channel', DOWN_WITHIN_MS + 500);
  const downs: Record<string, Received> = {};
  for (const ch of CHANNELS) {
    const [down, ...more] = framesOn(live, ch, 'error', killAt);
    assert.deepEqual(down.frame.data, { code: 'events-down' }, `${ch}: the error is events-down`);
    assert.ok(down.at - killAt <= DOWN_WITHIN_MS, `${ch}: events-down ${Math.round(down.at - killAt)} ms after the kill`);
    assert.equal(more.length, 0, `${ch}: one error frame`);
    downs[ch] = down;
  }

  await until(() => events().length >= 2, 'the restarted events child', LIVE_AGAIN_WITHIN_MS);
  const second = events()[1];
  assert.ok(first.closedAt !== null, 'the killed child closed');
  assert.ok(second.spawnedAt - first.closedAt! >= RESTART_NOT_BEFORE_MS, `restart ${Math.round(second.spawnedAt - first.closedAt!)} ms after the close`);
  assert.equal(RESTART_DELAYS_MS[0], RESTART_NOT_BEFORE_MS);
  assert.deepEqual(second.argv, FOLLOW_ARGV);

  await until(() => CHANNELS.every((ch) => framesOn(live, ch, 'snapshot', downs[ch].at).some((entry) => nOf(entry.frame) > nOf(downs[ch].frame))),
    'a fresh snapshot on every channel', Math.max(0, LIVE_AGAIN_WITHIN_MS - (performance.now() - killAt)) + 500);
  const timings: Record<string, number> = {};
  for (const ch of CHANNELS) {
    const fresh = framesOn(live, ch, 'snapshot', downs[ch].at).find((entry) => nOf(entry.frame) > nOf(downs[ch].frame))!;
    assert.ok(fresh.at - killAt <= LIVE_AGAIN_WITHIN_MS, `${ch}: fresh snapshot ${Math.round(fresh.at - killAt)} ms after the kill`);
    assert.equal(epochOf(fresh.frame), epochOf(downs[ch].frame), `${ch}: same epoch`);
    assert.equal(nOf(fresh.frame), nOf(downs[ch].frame) + 1, `${ch}: the snapshot is the next frame after the error`);
    timings[ch] = Math.round(fresh.at - killAt);
    if (ch !== 'now') assert.deepEqual(fresh.frame.data.state, before[ch].data.state, `${ch}: the recomposed state equals the state before the kill`);
    else assert.deepEqual(Object.values(fresh.frame.data.state).map((member: any) => member.status), [200, 200]);
  }
  t.diagnostic(`down ${CHANNELS.map((ch) => `${ch}=${Math.round(downs[ch].at - killAt)}ms`).join(' ')}; restart ${Math.round(second.spawnedAt - first.closedAt!)} ms after close; fresh snapshot ${CHANNELS.map((ch) => `${ch}=${timings[ch]}ms`).join(' ')}`);
  assert.equal(live.closed(), false, 'the connection stayed open through the kill');
  assert.equal(events().length, 2, 'exactly one restart');
  assert.equal(second.closedAt, null, 'the restarted child is alive');
  assert.equal(supervisor.state, 'running');
});

// ---- client part ----

const SLUG_C = 'feat-a';
const RUN_C = `run:${SLUG_C}:run-1`;
const EPOCH = '0a1b2c3d';
const KILL_TO_DOWN_MS = 100; // IC-009: onDown within 100 ms of the exit; the server part measures the real path
const KILL_TO_SNAPSHOT_MS = 9_000;
const LIVE_PILL = ['done', 'Live \u00b7 last change just now', 'Live'];
const POLLING_PILL = ['unknown', 'Polling \u00b7 Updated just now', 'Polling'];

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= Math.min(left, 100)) {
    mock.timers.tick(Math.min(left, 100));
    await settle();
  }
}

/** A run body whose revision tells the GET and the frames apart. */
const runBody = (revision: number) => ({ v: 1, run: { taskId: 'run-1', featureSlug: SLUG_C, state: 'RUNNING', revision }, timeline: { events: [] }, tasks: null, workflow: {} });
const envelope = (n: number, type: string, data: any) => ({ v: 1, ch: RUN_C, id: `${EPOCH}-${n}`, type, at: new Date(Date.now()).toISOString(), data });

/** The shell's pillFor (app.js), run over the real classify and clockTime of states.js. */
function loadPill(web: string, states: any): (view: any, now: number) => { state: string, long: string, short: string } {
  const source = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
  const found = /\nfunction pillFor\(view, now\) \{\n[\s\S]*?\n\}\n/.exec(source);
  const pillSource = found === null ? '' : found[0];
  assert.ok(pillSource !== '', 'app.js defines pillFor(view, now)');
  const app = { fatal: null, ready: true };
  const ctx = () => ({ exchange: 'done', sessionWorked: true });
  return new Function('app', 'classify', 'ctx', 'clockTime', `${pillSource}\nreturn pillFor;`)(app, states.classify, ctx, states.clockTime);
}

/** The Run view connected to a store over a fake adapter; the page's `document` is a stub holding the announcer region. */
async function clientRig(t: any) {
  const region = { textContent: '' };
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: (id: string) => (id === 'announcer' ? region : null) };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 10, 7, 12, 0, 0) });
  let stopView = () => {};
  // One hook: the view stops (its poller unsubscribes from `document`) before the stub and the mock timers go.
  t.after(() => {
    stopView();
    mock.timers.reset();
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete (globalThis as any).document;
  });
  // The web root as an ES module tree (console/package.json is commonjs), copied per case so dom.js's announcer and
  // notices.js's memory start fresh; the folder comes from the root suite's temp helper and is removed after the case.
  const web = tempDir(t, 'doflow-ui-recovery-web-');
  fs.cpSync(WEB_ROOT, web, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"type":"module"}\n');
  const load = (name: string) => import(pathToFileURL(path.join(web, name)).href);
  const [views, storeMod, notices, states] = await Promise.all([load('views.js'), load('store.js'), load('notices.js'), load('states.js')]);
  notices.resetNotices();
  const pillFor = loadPill(web, states);

  const opened: Array<{ channels: string[], since: string | null }> = [];
  let frame: (envelope: any) => void = () => {};
  let state: (event: any) => void = () => {};
  const adapter = {
    open: (channels: string[], since: string | null) => { opened.push({ channels, since }); },
    close: () => {},
    onFrame: (listener: (envelope: any) => void) => { frame = listener; },
    onState: (listener: (event: any) => void) => { state = listener; },
  };
  const store = storeMod.createLiveStore({ adapter, visibility: { hidden: () => false, subscribe: () => () => {} } });

  let server = runBody(1);
  let hang = false;
  const gets: number[] = [];
  const seen: any[] = [];
  const failures: any[] = [];
  const view: any = { paused: false, hasData: false, poller: null };
  view.poller = views.VIEWS.run.connect({}, { slug: SLUG_C, taskId: 'run-1' }, {
    fetchJson: async () => { throw new Error('the run view does not wrap its member'); },
    onData: (data: any) => { view.hasData = true; seen.push(data); },
    onFailure: (error: any) => { failures.push(error); },
    store: () => store,
    // A frozen server (`hang`) never answers the GET.
    fetchOnce: () => { gets.push(Date.now()); return hang ? new Promise(() => {}) : Promise.resolve(structuredClone(server)); },
  });
  stopView = () => view.poller.stop();

  return {
    view, opened, gets, seen, failures, region,
    pill: () => { const p = pillFor(view, Date.now()); return [p.state, p.long, p.short]; },
    setServer: (revision: number) => { server = runBody(revision); },
    freeze: () => { hang = true; },
    emit: (envelope: any) => frame(structuredClone(envelope)),
    transport: (name: string, code: string | null = null, at: number = Date.now()) => state({ state: name, code, at }),
  };
}

/** Starts the view and brings it live on snapshot n=1 of revision 1. */
async function goLive(c: Awaited<ReturnType<typeof clientRig>>) {
  c.view.poller.start();
  await settle();
  assert.equal(c.gets.length, 1, 'the first paint is one GET');
  await advance(100);
  assert.deepEqual(c.opened, [{ channels: [RUN_C], since: null }], 'the store opens the run channel');
  c.transport('connecting');
  c.transport('open');
  c.emit(envelope(1, 'snapshot', { state: { run: { status: 200, body: runBody(1) } } }));
  await settle();
  assert.equal(c.view.poller.mode, 'live');
  assert.deepEqual(c.pill(), LIVE_PILL);
  await advance(6_000);
  assert.equal(c.gets.length, 1, 'no GET timer while live');
  assert.equal(c.view.poller.mode, 'live');
}

test('client, one kill: the pill reads Polling at the events-down frame, the view polls its GET, and the fresh snapshot makes it Live again', async (t: any) => {
  const c = await clientRig(t);
  await goLive(c);

  const killAt = Date.now();
  c.setServer(2); // the run moves while the child is down
  await advance(KILL_TO_DOWN_MS);
  c.emit(envelope(2, 'error', { code: 'events-down' }));
  await settle();
  assert.equal(c.view.poller.mode, 'polling');
  assert.deepEqual(c.pill(), POLLING_PILL, `Polling ${Date.now() - killAt} ms after the kill`);
  assert.ok(Date.now() - killAt <= DOWN_WITHIN_MS);
  assert.equal(c.region.textContent, 'Push unavailable; polling every 3 seconds.');
  assert.equal(c.gets.length, 2, 'polling reads the GET at once');
  assert.equal(c.seen.at(-1).run.revision, 2, 'and the view shows the moved run');

  // While the child is down and restarting (1 s), the view keeps updating by its 3 s GET.
  for (let second = 1; second <= 8; second += 1) {
    await advance(1_000);
    assert.deepEqual(c.pill(), POLLING_PILL, `${Date.now() - killAt} ms after the kill`);
    if (second === 4) c.setServer(3);
  }
  assert.equal(c.gets.length, 4, 'the first paint, then GETs 0.1, 3.1 and 6.1 s after the kill');
  assert.equal(c.seen.at(-1).run.revision, 3, 'the poll showed the second move');

  // The restarted child's snapshot, on the same open connection, at the next position.
  await advance(KILL_TO_SNAPSHOT_MS - (Date.now() - killAt));
  c.setServer(4);
  c.emit(envelope(3, 'snapshot', { state: { run: { status: 200, body: runBody(4) } } }));
  await settle();
  const backAt = Date.now() - killAt;
  assert.ok(backAt <= LIVE_AGAIN_WITHIN_MS, `Live again ${backAt} ms after the kill`);
  assert.equal(c.view.poller.mode, 'live');
  assert.deepEqual(c.pill(), LIVE_PILL);
  assert.equal(c.seen.at(-1).run.revision, 4, 'the snapshot reached the view');
  assert.equal(c.region.textContent, 'Push restored.');
  const getsAtBack = c.gets.length;
  await advance(9_000);
  assert.equal(c.gets.length, getsAtBack, 'the GET timer stopped');
  assert.deepEqual(c.pill().slice(0, 1), ['done']);
  assert.equal(c.view.poller.mode, 'live');
  assert.deepEqual(c.failures, []);
  assert.equal(c.opened.length, 1, 'the store never reopened: the connection carried the error and the snapshot');
});

test('client, a child that keeps failing: no snapshot comes, so the pill reads Polling for 60 s and the view keeps updating by GET', async (t: any) => {
  const c = await clientRig(t);
  await goLive(c);

  const killAt = Date.now();
  await advance(KILL_TO_DOWN_MS);
  c.emit(envelope(2, 'error', { code: 'events-down' }));
  await settle();
  assert.deepEqual(c.pill(), POLLING_PILL);
  const getsAtDown = c.gets.length;
  let revision = 1;
  for (let second = 1; second <= 60; second += 1) {
    await advance(1_000);
    if (second % 6 === 1) c.setServer((revision += 1)); // the last move (55 s) is read by the GET at 57.1 s
    if (second === 20) {
      // The browser's own reconnect while the child is still failing: the new stream re-sends the channel's error (IC-013).
      c.transport('retrying');
      c.transport('open');
      c.emit(envelope(2, 'error', { code: 'events-down' }));
      await settle();
    }
    assert.equal(c.view.poller.mode, 'polling', `${Date.now() - killAt} ms after the kill`);
    assert.deepEqual(c.pill(), POLLING_PILL, `${Date.now() - killAt} ms after the kill`);
  }
  assert.ok(c.gets.length - getsAtDown >= 19, `GETs every 3 s for 60 s: ${c.gets.length - getsAtDown}`);
  assert.equal(c.seen.at(-1).run.revision, revision, 'the view shows the latest polled run');
  assert.equal(c.region.textContent, 'Push unavailable; polling every 3 seconds.', 'push-back was never announced');
  assert.deepEqual(c.failures, []);
});

test('client, a frozen server (FU-mnes07): after live data, closed silent hands over to a poller whose GET never answers, and the view is stale once 20 s passed since the stream went quiet', async (t: any) => {
  const c = await clientRig(t);
  await goLive(c);
  assert.equal(c.view.poller.isStale(), false);

  c.freeze();
  // The adapter reports `closed` `silent` with `at` the last time it heard anything (after the snapshot); 5 s ago here.
  const quietAt = Date.now() - 5_000;
  c.transport('closed', 'silent', quietAt);
  await settle();
  assert.equal(c.view.poller.mode, 'polling', 'polling took over');
  const getsAtDown = c.gets.length;
  assert.equal(getsAtDown, 2, 'the polling GET was made, and it hangs');
  assert.equal(c.view.poller.isStale(), false, '5 s since the stream went quiet: not stale');
  await advance(15_000);
  assert.equal(Date.now() - quietAt, 20_000);
  assert.equal(c.view.poller.isStale(), false, 'exactly 20 s: not yet');
  await advance(1);
  assert.equal(c.view.poller.isStale(), true, 'more than 20 s with no answer: stale');
  assert.equal(c.gets.length, getsAtDown, 'the one polling GET is still pending');
  assert.equal(c.view.poller.lastSuccessAt < quietAt, true, 'what the view shows is the snapshot from before the stream went quiet');
});
