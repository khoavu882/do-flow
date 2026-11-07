'use strict';

// One events child per Console, outside the pool (feature 149, B.6; DEC-017, DEC-022, NFR-008; FR-011,
// FR-017). The Console's own parts as main() wires them (verb runner, events supervisor, live hub,
// consoleRoutes on a real server on 127.0.0.1:0), all on one fake clock, over a stand-in core: a
// test-local wrapper that runs fixtures/fake-core.js in mode `events` (script `follow`) for
// `events --follow --control stdin` and answers the pooled verbs a case reads with fixed, valid bodies.
// Every spawn goes through an injected `spawnImpl`, which is how children are counted.
//   - No events child before the first /api/live open; exactly one while three connections are open;
//     none after the last closes (stdin end, SIGTERM, SIGKILL after 1 s), and no restart after that.
//   - While the follow child lives, the pool of 2 and the reserved transcript slot still run three
//     GET reads at once.
//   - While live, 60 s of fake time with the core patching every channel starts no pooled verb: the
//     only pooled read of the live path is the cached `workflow` read.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createVerbRunner, KILL_GRACE_MS, POOL_SIZE, RESERVED_SLOTS } = require('../src/verb-runner.ts');
const { createLiveChild } = require('../src/live-child.ts');
const { createLiveHub } = require('../src/live.ts');
const { createServer } = require('../src/server.ts');
const { consoleRoutes } = require('../src/routes.ts');
const { createSessions, cookieName } = require('../src/session.ts');

const FAKE_CORE = path.join(__dirname, 'fixtures', 'fake-core.js');
const AT = '2026-11-07T12:00:00.000Z';
const SLUG = 'feat-a';
const RUN = `run:${SLUG}:run-1`;
const TASKS = `tasks:${SLUG}`;
const KEY = 'aaaaaaaaaaaaaaaa';
const AGENT = '0123456789abcdef';
const FOLLOW_ARGV = ['events', '--follow', '--control', 'stdin', '--json'];

// ---- the stand-in core: bodies every projector accepts ----

const RUN_FIELDS = { taskId: 'run-1', taskClass: 'bug', workflowName: 'Bug fix', state: 'RUNNING', current: null, awaitingGate: null, progress: { done: 0, total: 1 }, revision: 1 };
const LIST = { v: 1, runs: [{ ...RUN_FIELDS, featureSlug: SLUG, startedAt: AT, updatedAt: AT, origin: 'current' }], unreadable: [] };
/** The `sections` of every frame the fake core sends: `now`, `run:` and `tasks:` each find theirs (IC-004). */
const SECTIONS = {
  list: { exit: 0, json: LIST },
  observed: { exit: 0, json: { v: 1, store: 'absent', checkouts: [], sessions: [], truncated: false, unreadable: 0 } },
  slots: { exit: 0, json: { v: 1, slots: [], unreadable: 0 } },
  roadmap: { exit: 2, json: { ok: false, error: 'usage', message: 'no roadmap seed' } },
  status: { exit: 0, json: RUN_FIELDS },
  timeline: { exit: 0, json: { v: 1, taskId: 'run-1', featureSlug: SLUG, revision: 1, startedAt: AT, events: [], otherEvents: 0 } },
  attempts: { exit: 0, json: { revision: 1, graph: { digest: `sha256:${'0'.repeat(64)}`, graphPlan: true, tasks: [], overlaps: [] }, tasks: [] } },
};
const TRANSCRIPT = {
  v: 1, agentKey: AGENT, harness: null, reader: { id: null, status: 'events-only' }, transcript: { linked: false, reason: null }, events: [],
  cursor: '0:0:0:0', reset: false, eof: true, otherRecords: 0, unparsable: 0, masked: 0, warnings: [],
};

/**
 * The wrapper core. `events`: fake-core.js in mode `events`, with each stdout line's `"revision"` set
 * to a counter, so every core patch changes the browser state. While the file LIVE_HOLD names exists,
 * `list`, `capabilities` and `transcript` wait before they answer (20 s at most).
 */
function wrapperSource(root: string): string {
  const projects = { v: 1, store: 'present', projects: [{ projectKey: KEY, root, label: 'p', current: true, checkouts: 1, sources: ['hook-dirs'], lastRecordAt: null }], excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, truncated: false };
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    'const argv = process.argv.slice(2);',
    "const print = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));",
    'const held = (answer) => {',
    '  const deadline = Date.now() + 20000;',
    '  const wait = () => (process.env.LIVE_HOLD && fs.existsSync(process.env.LIVE_HOLD) && Date.now() < deadline ? setTimeout(wait, 10) : print(answer));',
    '  wait();',
    '};',
    "if (argv[0] === 'events') {",
    '  let n = 0;',
    '  const write = process.stdout.write.bind(process.stdout);',
    '  process.stdout.write = (chunk, ...rest) => { n += 1; return write(String(chunk).replace(/"revision":\\d+/g, `"revision":${n}`), ...rest); };',
    "  process.env.FAKE_CORE_MODE = 'events';",
    `  require(${JSON.stringify(FAKE_CORE)});`,
    "} else if (argv[0] === '--version') print('9.9.9-fake\\n');",
    "else if (argv[0] === 'workflow') print({ taskClass: argv[2], name: 'Bug fix', stages: [] });",
    `else if (argv[0] === 'fleet' && argv[2] === 'projects') print(${JSON.stringify(projects)});`,
    `else if (argv[0] === 'orchestrate' && argv[2] === 'list') held(${JSON.stringify(LIST)});`,
    "else if (argv[0] === 'capabilities') held({ capabilities: [] });",
    `else if (argv[0] === 'transcript') held(${JSON.stringify(TRANSCRIPT)});`,
    "else { process.env.FAKE_CORE_MODE = 'echo'; require(" + JSON.stringify(FAKE_CORE) + '); }',
    '',
  ].join('\n');
}

// ---- harness ----

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
    advance(ms: number) {
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

const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Spawned = { argv: string[], child: any, closed: boolean };
type Stream = { status: number, text(): string, closed: Promise<void>, destroy(): void };

function get(port: number, target: string, cookie: string): Promise<{ status: number, body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, agent: false, headers: { Cookie: cookie } }, (res: any) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** The data frames of a live stream, parsed. */
function framesOf(stream: Stream): any[] {
  return stream.text().split('\n\n').slice(0, -1)
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice(6)));
}
const snapshotOf = (stream: Stream, channel: string) => framesOf(stream).find((frame) => frame.ch === channel && frame.type === 'snapshot');
const hasSnapshots = (stream: Stream, channels: string[]) => channels.every((channel) => snapshotOf(stream, channel) !== undefined);

/** Bounded wait in real time; the fake clock does not move. */
async function until(check: () => boolean, label: string, ms = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) assert.fail(`timed out: ${label}`);
    await realDelay(10);
  }
}

/** The Console's parts over the wrapper core, wired as main() wires them, on one fake clock. */
async function world(t: any, extraEnv: Record<string, string> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-live-server-')));
  const project = path.join(dir, 'project');
  const webRoot = path.join(dir, 'web');
  fs.mkdirSync(project);
  fs.mkdirSync(webRoot);
  const core = path.join(dir, 'core.js');
  fs.writeFileSync(core, wrapperSource(project));
  const hold = path.join(dir, 'hold');
  const clock = fakeClock();
  const spawns: Spawned[] = [];
  const runner = createVerbRunner({
    corePath: core,
    projectRoot: project,
    env: { FAKE_EVENTS_SCRIPT: 'follow', FAKE_EVENTS_SECTIONS: JSON.stringify(SECTIONS), LIVE_HOLD: hold, ...extraEnv },
    clock,
    spawnImpl: (command: string, args: string[], options: any) => {
      const child = childProcess.spawn(command, args, options);
      const entry: Spawned = { argv: args.slice(1), child, closed: false };
      child.on('close', () => { entry.closed = true; });
      spawns.push(entry);
      return child;
    },
  });
  const supervisor = createLiveChild({ runner, clock });
  const coreFrames: any[] = [];
  supervisor.onFrame((envelope: any) => coreFrames.push(envelope));
  // What the hub's compositions ask the real runner for (IC-010: only workflow, version and capabilities may get there).
  const hubCalls: string[] = [];
  const hub = createLiveHub({ runner: { run: (shape: string, params?: any) => { hubCalls.push(shape); return runner.run(shape, params); } }, supervisor, clock });
  const sessions = createSessions();
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions, hub) });
  const cookie = `${cookieName(app.port)}=${sessions.exchange(sessions.mintLaunchCode())}`;
  const streams: Stream[] = [];
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    hub.stop();
    runner.stop();
    await app.close();
    for (const entry of spawns) if (!entry.closed) entry.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // main()'s boot handshake reads `version` (cached for the process) before the server serves.
  assert.equal((await runner.run('version', {})).ok, true);

  const isEvents = (entry: Spawned) => entry.argv[0] === 'events';
  return {
    clock, runner, supervisor, hub, port: app.port, cookie, hold, spawns, coreFrames, hubCalls,
    events: () => spawns.filter(isEvents),
    eventsAlive: () => spawns.filter((entry) => isEvents(entry) && !entry.closed),
    pooled: () => spawns.filter((entry) => !isEvents(entry)),
    get: (target: string) => get(app.port, target, cookie),
    /** Opens GET /api/live on `channels`; resolves at the response headers. */
    open(channels: string[]): Promise<Stream> {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: app.port, path: `/api/live?ch=${channels.join(',')}`, agent: false, headers: { Cookie: cookie } }, (res: any) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { text += chunk; });
          res.on('error', () => {});
          const closed = new Promise<void>((done) => res.on('close', () => done()));
          const stream = { status: res.statusCode, text: () => text, closed, destroy: () => req.destroy() };
          streams.push(stream);
          resolve(stream);
        });
        req.on('error', (error: any) => { if (error.code !== 'ECONNRESET') reject(error); });
        req.end();
      });
    },
    /** Moves the fake clock 25 ms per round (the hub's debounce) until `check` holds; bounded in real time. */
    async pumpUntil(check: () => boolean, label: string, ms = 5_000) {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > ms) assert.fail(`timed out: ${label}`);
        clock.advance(25);
        await realDelay(10);
      }
    },
    /** `rounds` rounds of 25 ms of fake time, each followed by 10 ms of real time for I/O. */
    async pump(rounds: number) {
      for (let i = 0; i < rounds; i += 1) {
        clock.advance(25);
        await realDelay(10);
      }
    },
  };
}

// ---- cases ----

test('one events child per Console: none before the first /api/live open, one for three connections, none after the last closes', async (t: any) => {
  const w = await world(t);
  assert.equal((await w.get('/api/runs')).status, 200, 'a GET read');
  w.clock.advance(60_000);
  await realDelay(50);
  assert.equal(w.events().length, 0, 'no events child before the first /api/live open');
  assert.equal(w.supervisor.state, 'stopped');

  const a = await w.open(['now']);
  const b = await w.open([RUN, TASKS]);
  const c = await w.open(['now', TASKS]);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  await w.pumpUntil(() => hasSnapshots(a, ['now']) && hasSnapshots(b, [RUN, TASKS]) && hasSnapshots(c, ['now', TASKS]), 'a snapshot on every channel of every connection');
  assert.equal(w.events().length, 1, 'one events child for three connections');
  assert.equal(w.eventsAlive().length, 1);
  assert.deepEqual(w.events()[0].argv, FOLLOW_ARGV);
  assert.equal(w.supervisor.state, 'running');
  // The snapshots are composed (IC-012 members), so the child really serves the three connections.
  assert.deepEqual(Object.keys(snapshotOf(a, 'now').data.state), ['runs', 'sessions']);
  assert.deepEqual(Object.values(snapshotOf(a, 'now').data.state).map((member: any) => member.status), [200, 200]);
  assert.equal(snapshotOf(b, RUN).data.state.run.status, 200);
  assert.equal(snapshotOf(b, TASKS).data.state.tasks.status, 200);

  a.destroy();
  await a.closed;
  await w.pump(10);
  assert.deepEqual([w.events().length, w.eventsAlive().length], [1, 1], 'two connections open: the same child');
  b.destroy();
  await b.closed;
  await w.pumpUntil(() => w.hub.current(RUN) === null, 'the run channel is dropped');
  assert.deepEqual([w.events().length, w.eventsAlive().length], [1, 1], 'one connection open: the same child');
  assert.equal(w.supervisor.state, 'running');

  c.destroy();
  await c.closed;
  // The supervisor's end: stdin end and SIGTERM at once, SIGKILL after KILL_GRACE_MS of the runner's clock.
  await w.pumpUntil(() => w.eventsAlive().length === 0, 'the events child exits after the last connection closed', KILL_GRACE_MS * 5);
  assert.equal(w.supervisor.state, 'stopped');
  w.clock.advance(60_000);
  await realDelay(50);
  assert.equal(w.events().length, 1, 'no restart once no connection is open');
});

test('the follow child takes no pool or reserved slot: two pooled GET reads and a transcript run at once beside it', async (t: any) => {
  assert.deepEqual([POOL_SIZE, RESERVED_SLOTS], [2, 1]);
  const w = await world(t);
  assert.equal((await w.runner.run('projects', {})).ok, true, 'the project key is known');
  const stream = await w.open(['now']);
  await w.pumpUntil(() => hasSnapshots(stream, ['now']), 'the follow child serves the connection');
  assert.equal(w.eventsAlive().length, 1);

  fs.writeFileSync(w.hold, '');
  const base = w.pooled().length;
  const replies = Promise.all([w.get('/api/runs'), w.get('/api/info'), w.get(`/api/transcript?project=${KEY}&agent=${AGENT}`)]);
  const held = () => w.pooled().slice(base).filter((entry) => !entry.closed);
  await until(() => held().length === POOL_SIZE + RESERVED_SLOTS, 'two pooled reads and a transcript running at once');
  assert.deepEqual(held().map((entry) => entry.argv.slice(0, 3).join(' ')).sort(), ['capabilities --json', 'orchestrate --action list', 'transcript --action read']);
  assert.equal(w.eventsAlive().length, 1, 'the follow child lives beside them');
  fs.rmSync(w.hold);
  const [runs, info, transcript] = await replies;
  assert.deepEqual([runs.status, info.status, transcript.status], [200, 200, 200]);
  assert.equal(runs.body.runs[0].taskId, 'run-1');
  assert.deepEqual(info.body.core, { version: '9.9.9-fake', inRange: false });
  assert.equal(transcript.body.agentKey, AGENT);
  assert.equal(w.eventsAlive().length, 1, 'and still lives after them');
  assert.equal(w.events().length, 1);
});

test('while live, 60 s of fake time with the core patching every channel starts no pooled verb for Now, Run, Tasks or Sessions; only the cached workflow read', async (t: any) => {
  const w = await world(t, { FAKE_EVENTS_TICK_MS: '40' });
  const stream = await w.open(['now', RUN, TASKS]);
  await w.pumpUntil(() => hasSnapshots(stream, ['now', RUN, TASKS]), 'a snapshot on every channel');
  const argvOf = (entry: Spawned) => entry.argv.join(' ');
  // The boot handshake's version, then the one workflow read of the run's class (NFR-008).
  assert.deepEqual(w.pooled().map(argvOf), ['--version --json', 'workflow --task-class bug --json']);
  assert.ok(w.hubCalls.every((shape) => shape === 'workflow'), `the hub asked the runner only for workflow: ${w.hubCalls}`);

  const base = { spawns: w.spawns.length, core: w.coreFrames.length, workflow: w.hubCalls.length, frames: framesOf(stream).length, at: w.clock.now() };
  for (let step = 0; step < 120; step += 1) {
    w.clock.advance(500);
    await realDelay(10);
  }
  assert.ok(w.clock.now() - base.at >= 60_000, '60 s of fake time');
  assert.equal(w.spawns.length, base.spawns, `no spawn while live: ${w.spawns.slice(base.spawns).map(argvOf)}`);
  assert.equal(w.events().length, 1);
  // Non-vacuity: the core patched, the hub recomposed (Run asked for workflow again, served from the cache) and each channel got patches.
  assert.ok(w.coreFrames.length - base.core >= 3, `core frames in the window: ${w.coreFrames.length - base.core}`);
  assert.ok(w.hubCalls.length > base.workflow, 'the run channel was recomposed in the window');
  assert.ok(w.hubCalls.every((shape) => shape === 'workflow'));
  const patched = new Set(framesOf(stream).slice(base.frames).filter((frame) => frame.type === 'patch').map((frame) => frame.ch));
  assert.deepEqual([...patched].sort(), [RUN, TASKS, 'now'].sort(), 'Now (runs and sessions), Run and Tasks were patched');
  const sessionsPatched = framesOf(stream).slice(base.frames).some((frame) => frame.ch === 'now' && frame.type === 'patch' && Object.keys(frame.data.set).some((pointer) => pointer.startsWith('/sessions/')));
  assert.ok(sessionsPatched, 'the Sessions member was patched');
  assert.ok(framesOf(stream).every((frame) => frame.type === 'snapshot' || frame.type === 'patch'), `no error frame: ${framesOf(stream).filter((f) => f.type !== 'snapshot' && f.type !== 'patch').map((f) => `${f.ch}/${f.type}/${JSON.stringify(f.data)}`)}`);
});
