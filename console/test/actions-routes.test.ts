'use strict';

// The Console's action routes (feature 162, IC-001, IC-002, IC-007, IC-009; DEC-007, DEC-009) on the REAL route
// table, over a scratch device store, a scratch action log and a fake runner that records every `act`. LAN mode
// runs on an https server bound to 127.0.0.1 with the injected address check (lan-world.ts); loopback mode on the
// plain http server with a real launch-code session. Nothing reads the real config home: the log is created over
// a temp folder and the device store is the world's.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { consoleRoutes } = require('../src/routes.ts');
const { createServer } = require('../src/server.ts');
const { createSessions, cookieName } = require('../src/session.ts');
const { createActions, normalizeText } = require('../src/actions.ts');
const { createActionLog } = require('../src/action-log.ts');
const { lanWorld, lanServer } = require('./helpers/lan-world.ts');
const { TEXT_VECTORS } = require('./helpers/text-vectors.ts');

const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-actions-'));
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
after(() => fs.rmSync(webRoot, { recursive: true, force: true }));
const place = { projectRoot: os.tmpdir(), home: os.tmpdir() };

const IDS = ['decide-gate', 'close-run', 'cancel-worker'] as const;
type Id = typeof IDS[number];
const PK = '0123456789abcdef';
const RUN_ID = 'w-3f2a0b1c2d3e';
const rid = () => crypto.randomBytes(16).toString('base64url');
const BODIES: Record<Id, (over?: Record<string, unknown>) => Record<string, unknown>> = {
  'decide-gate': (over = {}) => ({ v: 1, requestId: rid(), projectKey: PK, slug: 'feat-a', taskId: 't1', gateId: 'gate-a', decision: 'approve', note: null, expect: { revision: 7 }, ...over }),
  'close-run': (over = {}) => ({ v: 1, requestId: rid(), projectKey: PK, slug: null, taskId: 'fix-x', note: 'work ended in PR 41', expect: { revision: 3 }, ...over }),
  'cancel-worker': (over = {}) => ({ v: 1, requestId: rid(), projectKey: PK, slug: 'feat-a', runId: RUN_ID, reason: 'stuck on a prompt', ...over }),
};

/** The core's `snapshotRun` (src/runtime/workflow-orchestrator.ts) of a run that moved on, and its worker cancel answer. */
const SNAPSHOT = {
  taskId: 't1', taskClass: 'feature', workflowName: 'feature', state: 'RUNNING',
  current: { type: 'stage', id: 'design', kind: null, agent: null, mutatesSource: false, readinessTemplate: null },
  awaitingGate: null, progress: { done: 3, total: 9 }, terminalStage: null, revision: 8,
};
const AWAITING = { ...SNAPSHOT, state: 'AWAITING_GATE', current: { ...SNAPSHOT.current, type: 'gate', id: 'gate-a' }, awaitingGate: { gateId: 'gate-a', name: 'Design approval', prompt: 'Approve?' }, revision: 7 };
const CANCELLED = { disposition: 'cancelled', runId: RUN_ID, endState: 'cancelled', cleanup: { status: 'verified', reason: null, survivors: [], zombies: [] }, attemptCancel: { disposition: 'cancelled', reason: null }, attemptCancelled: true };
const applied = (shape: string) => ({ ok: true, exit: 0, json: shape === 'cancel-worker' ? CANCELLED : SNAPSHOT });

type Answer = (shape: string, params: Record<string, string>) => any;
/** A runner whose `act` answers from `answer` (default: applied) and records every call; `projects` reads are counted. */
function fakeRunner(answer: Answer = (shape) => applied(shape), listing: Array<Record<string, unknown>> = []) {
  const acts: Array<{ shape: string, params: Record<string, string> }> = [];
  const reads: string[] = [];
  const readOptions: unknown[] = [];
  return {
    acts, reads, readOptions,
    act: async (shape: string, params: Record<string, string>) => { acts.push({ shape, params }); return answer(shape, params); },
    run: async (shape: string, _params?: unknown, options?: unknown) => { reads.push(shape); readOptions.push(options ?? null); return { ok: true, exit: 0, json: { v: 1, store: 'present', projects: listing, excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, truncated: false } }; },
    follow: () => null,
    stop: () => {},
  };
}

/** The action log over a scratch folder, and its lines parsed. */
function scratchLog(t: any, now?: () => number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-action-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createActionLog({ dir, ...(now ? { now } : {}) });
  const lines = (): any[] => {
    const file = path.join(dir, 'actions.ndjson');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line)) : [];
  };
  return { dir, log, lines };
}

/**
 * `actions` with a counter of the action requests whose body the server has read in full. After that read a handler runs
 * on to the queue and the memo with nothing left to wait for (actions.ts), so a test that waits for the count and then
 * yields one turn knows those requests have reached them: no fixed sleep. It adds a listener only; the route consumes the
 * body as before.
 */
function counting(actions: any) {
  let bodies = 0;
  const routes = actions.routes.map((route: any) => (route.method !== 'POST' ? route
    : { ...route, handler: (ctx: any) => { ctx.req.once('end', () => { bodies += 1; }); return route.handler(ctx); } }));
  const bodiesRead = async (count: number) => {
    await until(() => bodies >= count, `${count} action bodies read`);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { actions: { ...actions, routes }, bodiesRead };
}

/** The REAL LAN table over a scratch world, a scratch log and `runner`. */
async function lan(t: any, runner: any, options: { now?: () => number, log?: any } = {}) {
  const world = lanWorld(t);
  const scratch = scratchLog(t, options.now);
  const actions = createActions({ runner, log: options.log === undefined ? scratch.log : options.log, ...(options.now ? { now: options.now } : {}), warn: () => {} });
  t.after(() => actions.stop());
  const counted = counting(actions);
  const server = await lanServer(t, world, consoleRoutes(runner, world.auth, null, place, counted.actions), webRoot);
  const post = (id: string, body: unknown, headers: Record<string, string>) =>
    server.request('POST', `/api/actions/${id}`, { headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { world, server, actions, post, bodiesRead: counted.bodiesRead, ...scratch };
}

/** The REAL loopback table over a real launch-code session, a scratch log and `runner`; `post` sends the own Origin, the session cookie and JSON unless told otherwise (a null header is left out). */
async function loopback(t: any, runner: any, options: { now?: () => number, log?: any } = {}) {
  const sessions = createSessions();
  const scratch = scratchLog(t, options.now);
  const actions = createActions({ runner, log: options.log === undefined ? scratch.log : options.log, ...(options.now ? { now: options.now } : {}), warn: () => {} });
  t.after(() => actions.stop());
  const counted = counting(actions);
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions, null, place, counted.actions) });
  t.after(() => app.close());
  const cookie = `${cookieName(app.port)}=${sessions.exchange(sessions.mintLaunchCode())}`;
  const request = (method: string, target: string, headers: Record<string, string | null>, body?: string): Promise<{ status: number, headers: Record<string, any>, body: string }> =>
    new Promise((resolve, reject) => {
      const sent: Record<string, string> = { Host: `127.0.0.1:${app.port}`, Connection: 'close' };
      for (const [name, value] of Object.entries(headers)) if (value !== null) sent[name] = value;
      if (body !== undefined) sent['Content-Length'] = String(Buffer.byteLength(body));
      const req = http.request({ host: '127.0.0.1', port: app.port, method, path: target, headers: sent, agent: false }, (res: any) => {
        const chunks: any[] = [];
        res.on('data', (chunk: any) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(body);
    });
  const post = (id: string, body: unknown, headers: Record<string, string | null> = {}) => request('POST', `/api/actions/${id}`,
    { Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'application/json', Cookie: cookie, ...headers }, typeof body === 'string' ? body : JSON.stringify(body));
  const get = (target: string) => request('GET', target, { Cookie: cookie });
  return { app, actions, post, get, cookie, bodiesRead: counted.bodiesRead, ...scratch };
}

/** A clock the test moves. */
const manual = (start = Date.UTC(2026, 10, 15, 10, 0, 0)) => {
  const clock = { t: start, now: () => clock.t };
  return clock;
};
/** A runner whose act waits for `release()` before it answers applied. */
function heldRunner() {
  const gates: Array<() => void> = [];
  const runner = fakeRunner((shape) => new Promise((resolve) => gates.push(() => resolve(applied(shape)))));
  return { runner, gates, releaseAll: () => { while (gates.length) (gates.shift() as () => void)(); } };
}
const until = async (condition: () => boolean, what: string) => {
  for (let index = 0; index < 400 && !condition(); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), what);
};

const json = (reply: { body: string }) => JSON.parse(reply.body);
const errorOf = (reply: { body: string }) => json(reply).error.code;

test('on the real LAN table: a view device is 403 phone-scope and logged; a control token in a cookie is 403 action-transport on every action route and logged; a control device over Bearer reaches act with its relay label, logged begin and end', async (t) => {
  const runner = fakeRunner();
  const w = await lan(t, runner);
  const view = await w.world.pair('view', 'Viewer', 'native');
  for (const id of IDS) {
    const reply = await w.post(id, BODIES[id](), { Authorization: view.bearer });
    assert.equal(reply.status, 403, id);
    assert.deepEqual(json(reply), { error: { code: 'phone-scope', verb: null, exit: null } }, id);
  }
  const control = await w.world.pair('control');
  for (const id of IDS) {
    const reply = await w.post(id, BODIES[id](), { Cookie: control.cookie, Origin: w.server.origin, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(reply.status, 403, id);
    assert.deepEqual(json(reply), { error: { code: 'action-transport', verb: null, exit: null } }, id);
  }
  assert.equal(runner.acts.length, 0, 'no refused attempt reached the runner');
  assert.deepEqual(w.lines(), [], 'a refusal is counted on its minute\'s summary line, never a line of its own');
  for (const id of IDS) {
    const body = BODIES[id]();
    const reply = await w.post(id, body, { Authorization: control.bearer });
    assert.equal(reply.status, 200, `${id} ${reply.body}`);
    const answer = json(reply);
    assert.deepEqual([answer.v, answer.action, answer.requestId, answer.outcome, answer.replayed, answer.by], [1, id, body.requestId, 'applied', false, `device.${control.device.id}`]);
  }
  assert.deepEqual(runner.acts.map((call) => [call.shape, call.params.relay]), IDS.map((id) => [id, `device.${control.device.id}`]));
  const ran = w.lines().filter((line) => line.phase === 'begin' || line.phase === 'end');
  assert.deepEqual(ran.map((line) => [line.phase, line.action, line.actor.deviceId, line.outcome]), IDS.flatMap((id) => [['begin', id, control.device.id, null], ['end', id, control.device.id, 'applied']]));
  await w.actions.stop();
  const summaries = w.lines().filter((line) => line.phase === 'summary');
  assert.deepEqual(summaries.map((line) => [line.action, line.code, line.count, line.actor.deviceId, line.actor.scope, line.actor.transport, line.outcome]), [
    ['decide-gate', 'phone-scope', 3, view.device.id, 'view', 'native', 'refused'],
    ['decide-gate', 'action-transport', 3, control.device.id, 'control', 'browser', 'refused'],
  ]);
});

test('loopback: the local session acts with relay console; the server\'s non-GET checks still hold (no Origin 403, a foreign Origin 403, text/plain 415); no cookie is 401 and counted', async (t) => {
  const runner = fakeRunner();
  const w = await loopback(t, runner);
  for (const id of IDS) {
    const reply = await w.post(id, BODIES[id]());
    assert.equal(reply.status, 200, `${id} ${reply.body}`);
    assert.equal(json(reply).by, 'console');
  }
  assert.deepEqual(runner.acts.map((call) => call.params.relay), ['console', 'console', 'console']);
  assert.deepEqual(w.lines().filter((line) => line.phase === 'begin').map((line) => line.actor), IDS.map(() => ({ kind: 'local', deviceId: null, scope: 'local', transport: 'loopback' })));
  const checks: Array<[Record<string, string | null>, number, string]> = [
    [{ Origin: null }, 403, 'forbidden-origin'],
    [{ Origin: 'http://evil.example' }, 403, 'forbidden-origin'],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403, 'forbidden-origin'],
    [{ 'Content-Type': 'text/plain' }, 415, 'unsupported-media'],
    [{ 'Content-Type': 'application/json; charset=utf-8' }, 415, 'unsupported-media'],
    [{ Cookie: null }, 401, 'unauthenticated'],
    [{ Cookie: 'doflow_ui_1=nope' }, 401, 'unauthenticated'],
  ];
  for (const [headers, status, code] of checks) {
    const reply = await w.post('decide-gate', BODIES['decide-gate'](), headers);
    assert.equal(reply.status, status, JSON.stringify(headers));
    assert.equal(errorOf(reply), code, JSON.stringify(headers));
  }
  assert.equal(runner.acts.length, 3, 'no refused request reached the runner');
  await w.actions.stop();
  const summaries = w.lines().filter((line) => line.phase === 'summary');
  assert.deepEqual(summaries.map((line) => [line.code, line.count, line.address, line.actor.kind, line.actor.transport, line.action]),
    [['unauthenticated', 2, '127.0.0.1', 'unknown', 'loopback', 'decide-gate']]);
});

test('closed bodies: a key too many or too few, a wrong v, requestId, projectKey, id, decision, revision or run id, a body over 4 KiB, not JSON: 400 usage, counted, never run', async (t) => {
  const clock = manual();
  const runner = fakeRunner();
  const w = await loopback(t, runner, { now: clock.now });
  const bad: Array<[Id, unknown]> = [
    ['decide-gate', 'not json'], ['decide-gate', '[]'], ['decide-gate', 'null'], ['decide-gate', ''],
    ['decide-gate', BODIES['decide-gate']({ extra: 1 })],
    ['decide-gate', (() => { const b = BODIES['decide-gate'](); delete b.note; return b; })()],
    ['decide-gate', BODIES['decide-gate']({ v: 2 })], ['decide-gate', BODIES['decide-gate']({ v: '1' })],
    ['decide-gate', BODIES['decide-gate']({ requestId: 'a'.repeat(21) })], ['decide-gate', BODIES['decide-gate']({ requestId: 'a'.repeat(23) })],
    ['decide-gate', BODIES['decide-gate']({ requestId: `${'a'.repeat(21)}=` })],
    ['decide-gate', BODIES['decide-gate']({ projectKey: PK.toUpperCase() })], ['decide-gate', BODIES['decide-gate']({ projectKey: PK.slice(1) })],
    ['decide-gate', BODIES['decide-gate']({ slug: '..' })], ['decide-gate', BODIES['decide-gate']({ slug: '-x' })], ['decide-gate', BODIES['decide-gate']({ slug: 'a/b' })],
    ['decide-gate', BODIES['decide-gate']({ taskId: null })], ['decide-gate', BODIES['decide-gate']({ gateId: '' })],
    ['decide-gate', BODIES['decide-gate']({ decision: 'maybe' })], ['decide-gate', BODIES['decide-gate']({ decision: 'Approve' })],
    ['decide-gate', BODIES['decide-gate']({ expect: { revision: -1 } })], ['decide-gate', BODIES['decide-gate']({ expect: { revision: '7' } })],
    ['decide-gate', BODIES['decide-gate']({ expect: { revision: 1e10 } })], ['decide-gate', BODIES['decide-gate']({ expect: { revision: 1.5 } })],
    ['decide-gate', BODIES['decide-gate']({ expect: { revision: 7, state: 'x' } })], ['decide-gate', BODIES['decide-gate']({ expect: null })],
    ['decide-gate', BODIES['decide-gate']({ note: 7 })],
    ['decide-gate', BODIES['decide-gate']({ note: 'x'.repeat(4096) })],
    ['close-run', BODIES['close-run']({ note: null })], ['close-run', BODIES['close-run']({ gateId: 'gate-a' })],
    ['cancel-worker', BODIES['cancel-worker']({ slug: null })], ['cancel-worker', BODIES['cancel-worker']({ runId: 'w-XYZ' })],
    ['cancel-worker', BODIES['cancel-worker']({ runId: 'w-3f2a0b1c2d3e0' })], ['cancel-worker', BODIES['cancel-worker']({ reason: null })],
    ['cancel-worker', BODIES['cancel-worker']({ expect: { revision: 1 } })],
  ];
  for (const [id, body] of bad) {
    // A refusal counts against the actor's windows (6 a minute, 30 an hour): each one here is in a minute of its own.
    clock.t += 3 * MINUTE;
    const reply = await w.post(id, body);
    assert.equal(reply.status, 400, `${id} ${typeof body === 'string' ? body : JSON.stringify(body).slice(0, 120)}`);
    assert.equal(errorOf(reply), 'usage');
  }
  assert.equal(runner.acts.length, 0);
  clock.t += 3 * MINUTE;
  await w.actions.stop();
  const refused = w.lines();
  assert.equal(refused.length, bad.length, 'one summary line per minute that had a refusal');
  assert.ok(refused.every((line) => line.phase === 'summary' && line.code === 'usage' && line.outcome === 'refused' && line.count === 1));
  // The six keys of a well-formed body in any order are accepted.
  const body = BODIES['cancel-worker']();
  const reversed = Object.fromEntries(Object.entries(body).reverse());
  clock.t += 3 * MINUTE;
  assert.equal((await w.post('cancel-worker', reversed)).status, 200);
});

test('IC-009 text: NFC, whitespace to a space, controls and invisible marks removed, spaces collapsed, trimmed; 1..500 code points required (0..500 for a gate note, 0 leaves --note out); never in the log', async (t) => {
  for (const [raw, normalized] of TEXT_VECTORS) assert.equal(normalizeText(raw), normalized, JSON.stringify(raw));

  const clock = manual();
  const runner = fakeRunner();
  const w = await loopback(t, runner, { now: clock.now });
  const step = () => { clock.t += 3 * MINUTE; };
  const emoji = '😀'.repeat(500);
  const cases: Array<[Id, Record<string, unknown>, number, string | null | undefined]> = [
    ['close-run', { note: emoji }, 200, emoji],
    ['close-run', { note: `${emoji}x` }, 400, undefined],
    ['close-run', { note: ' \n\t ' }, 400, undefined],
    ['close-run', { note: 'line one\nline two' }, 200, 'line one line two'],
    ['cancel-worker', { reason: '​' }, 400, undefined],
    ['cancel-worker', { reason: '  stop\tnow ' }, 200, 'stop now'],
    ['decide-gate', { note: null }, 200, null],
    ['decide-gate', { note: '  ​ ' }, 200, null],
    ['decide-gate', { note: 'x'.repeat(500) }, 200, 'x'.repeat(500)],
    ['decide-gate', { note: 'x'.repeat(501) }, 400, undefined],
  ];
  for (const [id, over, status, passed] of cases) {
    step();
    const before = runner.acts.length;
    const reply = await w.post(id, BODIES[id](over));
    assert.equal(reply.status, status, `${id} ${JSON.stringify(over).slice(0, 60)} ${reply.body}`);
    if (status !== 200) {
      assert.equal(runner.acts.length, before, 'refused text never runs');
      continue;
    }
    const params = runner.acts.at(-1)!.params;
    if (passed === null) assert.equal(Object.hasOwn(params, 'note'), false, 'an empty gate note leaves --note out');
    else assert.equal(params.note, passed);
  }
  const text = fs.readFileSync(path.join(w.dir, 'actions.ndjson'), 'utf8');
  for (const word of ['line one', 'stop now', 'xxxxxxxx', '😀']) assert.equal(text.includes(word), false, `${word} is not logged`);
  const begins = w.lines().filter((line) => line.phase === 'begin');
  assert.deepEqual(begins.map((line) => line.input.textChars), [500, 17, 8, 0, 0, 500]);
});

const MINUTE = 60_000;

test('limits: the seventh action of an actor in a minute is 429 action-rate-limited with Retry-After to the oldest counted attempt, never run, counted on the summary line; the window slides', async (t) => {
  const clock = manual();
  const runner = fakeRunner();
  const w = await loopback(t, runner, { now: clock.now });
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await w.post('decide-gate', BODIES['decide-gate']())).status, 200);
    clock.t += 1_000;
  }
  const limited = await w.post('decide-gate', BODIES['decide-gate']());
  assert.equal(limited.status, 429);
  assert.equal(errorOf(limited), 'action-rate-limited');
  assert.equal(limited.headers['retry-after'], '54', 'the first attempt leaves the minute 54 s from now');
  assert.equal((await w.post('close-run', BODIES['close-run']())).status, 429, 'the limit is the actor\'s, across actions');
  assert.equal(runner.acts.length, 6);
  clock.t += 54_000;
  assert.equal((await w.post('decide-gate', BODIES['decide-gate']())).status, 200, 'the oldest attempt has left the window');
  await w.actions.stop();
  const summary = w.lines().filter((line) => line.phase === 'summary');
  assert.deepEqual(summary.map((line) => [line.code, line.count, line.actor.kind]), [['rate-limited', 2, 'local']]);
});

test('162 finding: Retry-After is the real wait, the seconds until the oldest counted attempt of the refusing limit leaves its window, rounded up, at least 1', async (t) => {
  const clock = manual();
  const w = await loopback(t, fakeRunner(), { now: clock.now });
  // Per minute: attempts at 0, 10, 20, 25, 26 and 27 s, so the oldest (0 s) leaves 60 s after it, whatever the others do.
  for (const at of [0, 10, 20, 25, 26, 27]) {
    clock.t = at * 1000;
    assert.equal((await w.post('decide-gate', BODIES['decide-gate']())).status, 200);
  }
  clock.t = 30_000;
  assert.equal((await w.post('decide-gate', BODIES['decide-gate']())).headers['retry-after'], '30', 'not a fixed 30: 60 s minus the age of the oldest');
  clock.t = 45_000;
  assert.equal((await w.post('decide-gate', BODIES['decide-gate']())).headers['retry-after'], '15');
  clock.t = 59_400;
  assert.equal((await w.post('decide-gate', BODIES['decide-gate']())).headers['retry-after'], '1', 'rounded up, never 0');
  clock.t = 60_000;
  assert.equal((await w.post('decide-gate', BODIES['decide-gate']())).status, 200, 'and at that second the oldest has left');
  // Per hour: one attempt every 100 s never fills a minute; the thirty-first, at 3000 s, waits for the first to leave the hour.
  const hourly = await loopback(t, fakeRunner(), { now: clock.now });
  for (let index = 0; index < 30; index += 1) {
    clock.t = 3_600_000 + index * 100_000;
    assert.equal((await hourly.post('close-run', BODIES['close-run']())).status, 200, `attempt ${index + 1}`);
  }
  clock.t = 3_600_000 + 3_000_000;
  const limited = await hourly.post('close-run', BODIES['close-run']());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '600', 'the hour window: 3600 s minus 3000 s');
});

test('limits: 30 an hour per actor, and 20 a minute per Console across devices', async (t) => {
  const clock = manual();
  const runner = fakeRunner();
  const w = await lan(t, runner, { now: clock.now });
  const devices = [];
  for (let index = 0; index < 4; index += 1) devices.push(await w.world.pair('control', `Phone ${index}`));
  // Five a minute for each of four devices: the twenty-first in the minute is the Console's limit.
  for (const device of devices) {
    for (let index = 0; index < 5; index += 1) assert.equal((await w.post('decide-gate', BODIES['decide-gate'](), { Authorization: device.bearer })).status, 200);
  }
  clock.t += 10_000;
  const full = await w.post('decide-gate', BODIES['decide-gate'](), { Authorization: devices[0].bearer });
  assert.equal(full.status, 429);
  assert.equal(full.headers['retry-after'], '50');
  // One device, five a minute, every ninety seconds: thirty in the hour, then the hour limit.
  clock.t += 2 * MINUTE;
  const one = devices[1];
  let sent = 5;
  while (sent < 30) {
    for (let index = 0; index < 5 && sent < 30; index += 1, sent += 1) assert.equal((await w.post('close-run', BODIES['close-run'](), { Authorization: one.bearer })).status, 200, `attempt ${sent + 1}`);
    clock.t += 90_000;
  }
  const hourly = await w.post('close-run', BODIES['close-run'](), { Authorization: one.bearer });
  assert.equal(hourly.status, 429);
  assert.equal(errorOf(hourly), 'action-rate-limited');
  const left = Number(hourly.headers['retry-after']);
  assert.ok(left > 60 && left <= 3600, `the hour window: ${left} s`);
  assert.equal((await w.post('close-run', BODIES['close-run'](), { Authorization: devices[2].bearer })).status, 200, 'another device is not held by it');
});

test('the queue: one in flight and four waiting; a fifth waiter is 429 action-busy with Retry-After 2, logged; the waiters run in order', async (t) => {
  const held = heldRunner();
  const w = await loopback(t, held.runner);
  const bodies = [0, 1, 2, 3, 4].map((index) => BODIES['close-run']({ taskId: `run-${index}` }));
  const pending = bodies.map((body) => w.post('close-run', body));
  await until(() => held.runner.acts.length === 1, 'the first attempt is in flight');
  await w.bodiesRead(bodies.length);
  const busy = await w.post('close-run', BODIES['close-run']({ taskId: 'run-5' }));
  assert.equal(busy.status, 429);
  assert.equal(errorOf(busy), 'action-busy');
  assert.equal(busy.headers['retry-after'], '2');
  for (let index = 0; index < 5; index += 1) {
    await until(() => held.runner.acts.length === index + 1, `attempt ${index + 1} runs`);
    held.releaseAll();
  }
  const replies = await Promise.all(pending);
  assert.deepEqual(replies.map((reply) => reply.status), [200, 200, 200, 200, 200]);
  assert.deepEqual(held.runner.acts.map((call) => call.params.taskId), ['run-0', 'run-1', 'run-2', 'run-3', 'run-4']);
  await w.actions.stop();
  assert.deepEqual(w.lines().filter((line) => line.phase === 'summary').map((line) => [line.code, line.count, line.actor.kind]), [['action-busy', 1, 'local']]);
});

test('idempotency: a repeated requestId runs act once and replays the first reply, uncounted; a pending duplicate awaits it; another body under the id is 409 request-reused; another actor has its own ids', async (t) => {
  const held = heldRunner();
  const clock = manual();
  const w = await lan(t, held.runner, { now: clock.now });
  const phone = await w.world.pair('control', 'Phone');
  const other = await w.world.pair('control', 'Tablet');
  const auth = { Authorization: phone.bearer };
  const body = BODIES['decide-gate']();
  const first = w.post('decide-gate', body, auth);
  await until(() => held.runner.acts.length === 1, 'the first attempt is in flight');
  const duplicate = w.post('decide-gate', body, auth);
  await w.bodiesRead(2);
  held.releaseAll();
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(held.runner.acts.length, 1, 'the pending duplicate did not run');
  assert.deepEqual([a.status, json(a).replayed], [200, false]);
  assert.deepEqual([b.status, json(b).replayed], [200, true]);
  assert.deepEqual({ ...json(b), replayed: false }, json(a));
  const again = await w.post('decide-gate', body, auth);
  assert.deepEqual([again.status, json(again).replayed], [200, true]);
  const reused = await w.post('decide-gate', { ...body, decision: 'reject' }, auth);
  assert.equal(reused.status, 409);
  assert.equal(errorOf(reused), 'request-reused');
  const crossAction = await w.post('close-run', BODIES['close-run']({ requestId: body.requestId }), auth);
  assert.equal(errorOf(crossAction), 'request-reused', 'an id is one request, whichever route');
  assert.equal(held.runner.acts.length, 1);
  // Replays are not counted; the two request-reused refusals are (162 review 1): three more new attempts are admitted, the
  // fourth new one is the limit.
  for (let index = 0; index < 3; index += 1) {
    const next = w.post('decide-gate', BODIES['decide-gate'](), auth);
    await until(() => held.runner.acts.length === index + 2, 'runs');
    held.releaseAll();
    assert.equal((await next).status, 200);
  }
  assert.equal((await w.post('decide-gate', BODIES['decide-gate'](), auth)).status, 429);
  // Another device's attempt under the same id is its own.
  const theirs = w.post('decide-gate', body, { Authorization: other.bearer });
  await until(() => held.runner.acts.length === 5, 'the other actor runs');
  held.releaseAll();
  assert.deepEqual([(await theirs).status, json(await theirs).replayed], [200, false]);
  const phases = w.lines().map((line) => [line.phase, line.outcome, line.code]);
  assert.deepEqual(phases.filter(([phase, outcome]) => phase === 'end' && outcome === 'replayed').length, 2);
  assert.deepEqual(phases.filter(([phase]) => phase === 'summary'), [], 'the minute of the two request-reused has not passed yet');
  // Ten minutes on, the id is forgotten and runs again.
  clock.t += 10 * MINUTE;
  const later = w.post('decide-gate', body, auth);
  await until(() => held.runner.acts.length === 6, 'a forgotten id runs');
  held.releaseAll();
  assert.equal(json(await later).replayed, false);
  await w.actions.stop();
  assert.deepEqual(w.lines().filter((line) => line.phase === 'summary').map((line) => [line.code, line.count, line.actor.deviceId]).sort(),
    [['rate-limited', 1, phone.device.id], ['request-reused', 2, phone.device.id]].sort());
});

test('fail closed: when the begin line cannot be written the reply is 503 action-log-unwritable and act is never called; the id is not remembered', async (t) => {
  const runner = fakeRunner();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-action-log-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'console');
  fs.writeFileSync(dir, 'a file where the folder should be');
  const w = await loopback(t, runner, { log: createActionLog({ dir }) });
  const body = BODIES['cancel-worker']();
  for (let index = 0; index < 2; index += 1) {
    const reply = await w.post('cancel-worker', body);
    assert.equal(reply.status, 503);
    assert.deepEqual(json(reply), { error: { code: 'action-log-unwritable', verb: null, exit: null } });
  }
  assert.equal(runner.acts.length, 0, 'nothing ran');
  fs.rmSync(dir);
  const reply = await w.post('cancel-worker', body);
  assert.equal(reply.status, 200, 'the same id runs once the log can be written');
  assert.equal(runner.acts.length, 1);
  // With no log at all (no config home), every action is refused the same way.
  const none = await loopback(t, runner, { log: null });
  assert.equal(errorOf(await none.post('decide-gate', BODIES['decide-gate']())), 'action-log-unwritable');
  assert.equal(runner.acts.length, 1);
});

test('every core refusal and runner failure maps per IC-002, with current on a refusal by state; an unknown project key refreshes the projects map once', async (t) => {
  const refusal = (error: string, current: unknown) => ({ ok: true, exit: 1, json: { v: 1, ok: false, error, current } });
  const workerRefusal = (reason: string, extra: Record<string, unknown> = {}) => ({ ok: true, exit: 1, json: { disposition: 'refused', reason, runId: RUN_ID, ...extra } });
  const runCurrent = { state: 'AWAITING_GATE', revision: 7, awaitingGate: { gateId: 'gate-a', name: 'Design approval' } };
  const cases: Array<[Id, any, number, string, unknown, number | null]> = [
    ...['stale-revision', 'not-awaiting-gate', 'gate-mismatch', 'run-terminal', 'concurrent-update', 'lock-lost'].flatMap((error) => [
      ['decide-gate', refusal(error, AWAITING), 409, 'stale', runCurrent, 1],
      ['close-run', refusal(error, AWAITING), 409, 'stale', runCurrent, 1],
    ] as Array<[Id, any, number, string, unknown, number | null]>),
    ['decide-gate', refusal('stale-revision', null), 409, 'stale', null, 1],
    ['decide-gate', refusal('no-run', null), 404, 'run-not-found', undefined, 1],
    ['close-run', refusal('no-run', null), 404, 'run-not-found', undefined, 1],
    ['decide-gate', refusal('ambiguous-run', null), 409, 'ambiguous-run', undefined, 1],
    ['close-run', refusal('other-feature', null), 409, 'ambiguous-run', undefined, 1],
    ['decide-gate', refusal('something-new', null), 502, 'core-contract-mismatch', undefined, 1],
    ['decide-gate', refusal('stale-revision', { state: 'x' }), 502, 'core-contract-mismatch', undefined, 1],
    ['decide-gate', { ok: true, exit: 0, json: { taskId: 't1' } }, 502, 'core-contract-mismatch', undefined, 0],
    ['cancel-worker', workerRefusal('unknown-run'), 404, 'run-not-found', undefined, 1],
    ['cancel-worker', workerRefusal('run-ended', { endState: 'exited' }), 409, 'stale', { state: 'ended', endState: 'exited' }, 1],
    ['cancel-worker', workerRefusal('cancel-in-progress', { requestedAt: '2026-11-15T10:00:00.000Z' }), 409, 'cancel-in-progress', { state: 'cancelling', requestedAt: '2026-11-15T10:00:00.000Z' }, 1],
    ['cancel-worker', workerRefusal('foreign-run'), 502, 'core-contract-mismatch', undefined, 1],
    ['cancel-worker', { ok: true, exit: 0, json: { disposition: 'cancelled' } }, 502, 'core-contract-mismatch', undefined, 0],
    ['decide-gate', { ok: false, code: 'core-error', exit: 1, reason: 'not-json' }, 502, 'core-contract-mismatch', undefined, 1],
    ['decide-gate', { ok: false, code: 'core-error', exit: 3 }, 502, 'core-error', undefined, 3],
    ['decide-gate', { ok: false, code: 'usage', exit: 2 }, 502, 'core-error', undefined, 2],
    ['close-run', { ok: false, code: 'core-unreachable', exit: null }, 503, 'core-unreachable', undefined, null],
    ['close-run', { ok: false, code: 'timeout', exit: null }, 504, 'action-timeout', undefined, null],
    ['cancel-worker', { ok: false, code: 'project-not-found', exit: null }, 404, 'project-not-found', undefined, null],
  ];
  const clock = manual();
  let next: any = null;
  const runner = fakeRunner(() => next);
  const w = await loopback(t, runner, { now: clock.now });
  for (const [id, result, status, code, current, exit] of cases) {
    clock.t += 3 * MINUTE;
    next = result;
    const reply = await w.post(id, BODIES[id]());
    const label = `${id} ${JSON.stringify(result).slice(0, 90)}`;
    assert.equal(reply.status, status, `${label}: ${reply.body}`);
    const body = json(reply);
    assert.deepEqual(body.error, { code, verb: id, exit }, label);
    if (current === undefined) assert.equal(Object.hasOwn(body, 'current'), false, label);
    else assert.deepEqual(body.current, current, label);
  }
  assert.equal(runner.reads.filter((shape) => shape === 'projects').length, 1, 'one projects refresh for the one unknown key');
  assert.equal(runner.acts.length, cases.length + 1, 'and one retry');
  const outcomes = w.lines().filter((line) => line.phase === 'end').map((line) => line.outcome);
  assert.deepEqual([...new Set(outcomes)].sort(), ['applied', 'failed', 'refused', 'unknown']);
  // A key the first map lacked but the refreshed one holds runs on the retry.
  let calls = 0;
  const late = fakeRunner((shape) => (calls++ === 0 ? { ok: false, code: 'project-not-found', exit: null } : applied(shape)));
  const v = await loopback(t, late);
  const ok = await v.post('decide-gate', BODIES['decide-gate']());
  assert.equal(ok.status, 200);
  assert.deepEqual(json(ok).result, { taskId: 't1', featureSlug: 'feat-a', state: 'RUNNING', revision: 8, awaitingGate: null, current: { type: 'stage', id: 'design' } });
  assert.deepEqual(late.reads, ['projects']);
  const stopped = await v.post('cancel-worker', BODIES['cancel-worker']());
  assert.deepEqual(json(stopped).result, { runId: RUN_ID, endState: 'cancelled', cleanup: { status: 'verified' }, attemptCancel: { disposition: 'cancelled', reason: null } });
});

test('GET /api/actions: local, a view device, a control device over Bearer and over a browser cookie each learn what they may do; an action that met an old core is core-lacks-action until restart', async (t) => {
  const runner = fakeRunner((shape) => (shape === 'close-run' ? { ok: false, code: 'core-error', exit: 1, reason: 'old-core' } : applied(shape)));
  const local = await loopback(t, runner);
  const listed = (reply: { body: string }) => json(reply).actions.map((entry: any) => [entry.id, entry.allowed, entry.reason]);
  const first = json(await local.get('/api/actions'));
  assert.deepEqual(first, {
    v: 1, actor: { kind: 'local', transport: 'loopback' },
    actions: IDS.map((id) => ({ id, allowed: true, reason: null })),
    project: null, textMax: 500, limits: { actor: { perMinute: 6, perHour: 30 }, console: { perMinute: 20 } },
  });
  const old = await local.post('close-run', BODIES['close-run']());
  assert.equal(old.status, 501);
  assert.deepEqual(json(old).error, { code: 'core-lacks-action', verb: 'close-run', exit: 1 });
  assert.deepEqual(listed(await local.get('/api/actions')), [['decide-gate', true, null], ['close-run', false, 'core-lacks-action'], ['cancel-worker', true, null]]);

  const w = await lan(t, fakeRunner());
  const view = await w.world.pair('view', 'Viewer', 'native');
  const browserView = await w.world.pair('view', 'Browser');
  const control = await w.world.pair('control');
  const get = (headers: Record<string, string>) => w.server.request('GET', '/api/actions', { headers });
  const asView = json(await get({ Authorization: view.bearer }));
  assert.deepEqual(asView.actor, { kind: 'device', deviceId: view.device.id, scope: 'view', transport: 'native' });
  assert.deepEqual(asView.actions.map((entry: any) => entry.reason), ['phone-scope', 'phone-scope', 'phone-scope']);
  assert.deepEqual(listed(await get({ Cookie: browserView.cookie })), IDS.map((id) => [id, false, 'phone-scope']));
  const asControl = json(await get({ Authorization: control.bearer }));
  assert.deepEqual(asControl.actor, { kind: 'device', deviceId: control.device.id, scope: 'control', transport: 'native' });
  assert.deepEqual(asControl.actions.map((entry: any) => entry.allowed), [true, true, true]);
  const asBrowser = json(await get({ Cookie: control.cookie, Origin: w.server.origin }));
  assert.equal(asBrowser.actor.transport, 'browser');
  assert.deepEqual(asBrowser.actions.map((entry: any) => entry.reason), ['action-transport', 'action-transport', 'action-transport']);
  assert.equal((await get({})).status, 401, 'no device, no answer');
});

test('GET /api/actions names the Console\'s own project (the listing\'s current entry: key and label); with no current entry, or a listing that cannot be read, it is null', async (t) => {
  const entry = (over: Record<string, unknown>) => ({ projectKey: PK, root: os.tmpdir(), label: 'do-flow', current: false, checkouts: 1, sources: ['hook-dirs'], lastRecordAt: null, ...over });
  const other = entry({ projectKey: 'fedcba9876543210', label: 'elsewhere' });
  const own = await loopback(t, fakeRunner(undefined, [other, entry({ current: true })]));
  assert.deepEqual(json(await own.get('/api/actions')).project, { projectKey: PK, label: 'do-flow' });
  const absent = await loopback(t, fakeRunner(undefined, [other]));
  assert.equal(json(await absent.get('/api/actions')).project, null);
  const broken = fakeRunner();
  broken.run = async () => ({ ok: false, code: 'core-error', exit: 1 }) as any;
  const unread = await loopback(t, broken);
  const reply = await unread.get('/api/actions');
  assert.equal(reply.status, 200);
  assert.equal(json(reply).project, null);
});

test('LAN 401s on the action routes are counted per address on one summary line a minute; no attempt runs', async (t) => {
  const runner = fakeRunner();
  const w = await lan(t, runner);
  const revoked = await w.world.pair('control', 'Lost phone');
  assert.equal(await w.world.store.revoke(revoked.device.id), 'revoked');
  const asks: Array<Record<string, string>> = [{}, { Authorization: 'Bearer dfd1_nope' }, { Authorization: revoked.bearer }, { Authorization: `Bearer dfd1_${'A'.repeat(43)}` }];
  for (const [index, headers] of asks.entries()) {
    const id = IDS[index % IDS.length];
    const reply = await w.post(id, BODIES[id](), headers);
    assert.equal(reply.status, 401, JSON.stringify(headers));
  }
  assert.equal(runner.acts.length, 0);
  assert.deepEqual(w.lines(), [], 'the aggregated line waits for its minute to pass');
  await w.actions.stop();
  const lines = w.lines();
  assert.deepEqual(lines.map((line) => [line.phase, line.code, line.count, line.address, line.actor.kind, line.actor.transport, line.outcome]),
    [['summary', 'unauthenticated', 4, '127.0.0.1', 'unknown', 'native', 'refused']]);
});

test('162 review 1: a flood of refusals that never reach the core (300 phone-scope from a view device, 300 bad bodies from a control device) adds a bounded number of summary lines, meets 429 once the actor\'s own window is full, and leaves an earlier begin and end in place', async (t) => {
  const clock = manual();
  const runner = fakeRunner();
  const w = await lan(t, runner, { now: clock.now });
  const control = await w.world.pair('control', 'Phone');
  const view = await w.world.pair('view', 'Viewer', 'native');
  assert.equal((await w.post('decide-gate', BODIES['decide-gate'](), { Authorization: control.bearer })).status, 200);
  const before = w.lines();
  assert.deepEqual(before.map((line) => line.phase), ['begin', 'end']);
  clock.t += 2 * MINUTE;
  const statuses: Record<string, number[]> = { view: [], control: [] };
  for (let index = 0; index < 300; index += 1) {
    statuses.view.push((await w.post('cancel-worker', BODIES['cancel-worker'](), { Authorization: view.bearer })).status);
    statuses.control.push((await w.post('decide-gate', 'not json', { Authorization: control.bearer })).status);
  }
  assert.equal(runner.acts.length, 1, 'no refused attempt reached the runner');
  // The actor's own windows (6 a minute) count a refusal: the first six are 403 or 400, the rest 429.
  assert.deepEqual([...new Set(statuses.view.slice(0, 6))], [403]);
  assert.deepEqual([...new Set(statuses.view.slice(6))], [429]);
  assert.deepEqual([...new Set(statuses.control.slice(0, 6))], [400]);
  assert.deepEqual([...new Set(statuses.control.slice(6))], [429]);
  await w.actions.stop();
  const lines = w.lines();
  assert.deepEqual(lines.slice(0, 2), before, 'the begin and end lines of the attempt that ran are still there, first');
  const summaries = lines.slice(2);
  assert.ok(summaries.length <= 4, `600 refusals in one minute add at most one line per code and actor: ${summaries.length}`);
  assert.deepEqual(summaries.map((line) => [line.phase, line.code, line.count, line.actor.deviceId]).sort(), [
    ['summary', 'phone-scope', 6, view.device.id],
    ['summary', 'rate-limited', 294, control.device.id],
    ['summary', 'rate-limited', 294, view.device.id],
    ['summary', 'usage', 6, control.device.id],
  ].sort());
  // One actor's refusals never fill the Console's window: another actor still acts.
  const other = await w.world.pair('control', 'Tablet');
  assert.equal((await w.post('close-run', BODIES['close-run'](), { Authorization: other.bearer })).status, 200);
});

test('162 review 2: GET /api/actions says allowed false, reason action-log-unwritable, when there is no log or the log cannot be written, as every POST would answer; it says allowed again once the log can be written', async (t) => {
  const runner = fakeRunner();
  const none = await loopback(t, runner, { log: null });
  const reasons = (reply: { body: string }) => json(reply).actions.map((entry: any) => [entry.id, entry.allowed, entry.reason]);
  assert.deepEqual(reasons(await none.get('/api/actions')), IDS.map((id) => [id, false, 'action-log-unwritable']));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-action-log-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'console');
  fs.writeFileSync(dir, 'a file where the folder should be');
  const broken = await loopback(t, runner, { log: createActionLog({ dir }) });
  assert.deepEqual(reasons(await broken.get('/api/actions')), IDS.map((id) => [id, false, 'action-log-unwritable']));
  assert.equal(errorOf(await broken.post('close-run', BODIES['close-run']())), 'action-log-unwritable');
  fs.rmSync(dir);
  assert.deepEqual(reasons(await broken.get('/api/actions')), IDS.map((id) => [id, true, null]));
  assert.equal(runner.acts.length, 0);
});

test('162 review 11: a repeated requestId whose first reply was an error replays it with replayed true, the original status and current, and runs the core once', async (t) => {
  const current = { ...SNAPSHOT, revision: 9 };
  const runner = fakeRunner(() => ({ ok: true, exit: 1, json: { v: 1, ok: false, error: 'stale-revision', current } }));
  const w = await loopback(t, runner);
  const body = BODIES['decide-gate']();
  const first = await w.post('decide-gate', body);
  const again = await w.post('decide-gate', body);
  assert.equal(runner.acts.length, 1);
  assert.deepEqual([first.status, again.status], [409, 409]);
  assert.equal(Object.hasOwn(json(first), 'replayed'), false, 'a first error reply is IC-005\'s, as before');
  assert.deepEqual(json(again), { ...json(first), replayed: true });
  assert.deepEqual(json(again).current, { state: 'RUNNING', revision: 9, awaitingGate: null });
});

test('162 review 10: the projects refresh before a 404 reads past the runner\'s cache (fresh), so a project registered seconds ago is found', async (t) => {
  let calls = 0;
  const late = fakeRunner((shape) => (calls++ === 0 ? { ok: false, code: 'project-not-found', exit: null } : applied(shape)));
  const w = await loopback(t, late);
  assert.equal((await w.post('decide-gate', BODIES['decide-gate']())).status, 200);
  assert.deepEqual([late.reads, late.readOptions], [['projects'], [{ fresh: true }]]);
});

test('162 review 9: a slug, task id and gate id of ID_MAX characters are accepted and recorded on the begin line; one more is 400 usage', async (t) => {
  const clock = manual();
  const runner = fakeRunner();
  const w = await loopback(t, runner, { now: clock.now });
  const long = (c: string, n = 128) => `a${c.repeat(n - 1)}`;
  assert.equal((await w.post('decide-gate', BODIES['decide-gate']({ slug: long('s'), taskId: long('t'), gateId: long('g') }))).status, 200);
  const begin = w.lines().find((line) => line.phase === 'begin');
  assert.deepEqual([begin.target.slug, begin.target.taskId, begin.target.gateId], [long('s'), long('t'), long('g')]);
  for (const over of [{ slug: long('s', 129) }, { taskId: long('t', 129) }, { gateId: long('g', 129) }]) {
    clock.t += 3 * MINUTE;
    assert.equal((await w.post('decide-gate', BODIES['decide-gate'](over))).status, 400, JSON.stringify(Object.keys(over)));
  }
  assert.equal(runner.acts.length, 1);
});
