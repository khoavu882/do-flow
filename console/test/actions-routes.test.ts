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
/** Every action GET /api/actions lists, in ACTIONS order: the three of 162 and 165's start-session. */
const ALL_IDS = [...IDS, 'start-session'];
type Id = typeof IDS[number];
const PK = '0123456789abcdef';
const RUN_ID = 'w-3f2a0b1c2d3e';
// Never begins with '-' or '_': start-session carries the id as a CLI flag value, and the row refuses such an id (165 row fix).
const rid = () => `r${crypto.randomBytes(16).toString('base64url').slice(1)}`;
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
    [['forbidden-origin', 3, null, 'none', null, null], ['unsupported-media', 2, null, 'none', null, null], ['unauthenticated', 2, '127.0.0.1', 'unknown', 'loopback', 'decide-gate']]);
});

test('162 finding: a request refused before an actor exists (403 forbidden-origin, 415 unsupported-media) on an action route is counted on one summary line a minute per reason, actor none; a flood adds no more, and other routes are not counted', async (t) => {
  const clock = manual();
  const runner = fakeRunner();
  const w = await lan(t, runner, { now: clock.now });
  const control = await w.world.pair('control', 'Phone');
  const refusals: Array<[Record<string, string>, number, string]> = [
    [{ Authorization: control.bearer, Origin: 'https://evil.example' }, 403, 'forbidden-origin'],
    [{ Authorization: control.bearer, 'Sec-Fetch-Site': 'cross-site' }, 403, 'forbidden-origin'],
    [{ Authorization: control.bearer, 'Content-Type': 'text/plain' }, 415, 'unsupported-media'],
  ];
  for (let minute = 0; minute < 3; minute += 1) {
    for (let index = 0; index < 100; index += 1) {
      for (const [headers, status, code] of refusals) {
        const reply = await w.post('close-run', BODIES['close-run'](), headers);
        assert.equal(reply.status, status);
        assert.equal(errorOf(reply), code);
      }
    }
    clock.t += MINUTE;
  }
  // The same refusals on a read route are not the action log's business.
  assert.equal((await w.server.request('GET', '/api/actions', { headers: { Authorization: control.bearer, Origin: 'https://evil.example' } })).status, 403);
  assert.equal(runner.acts.length, 0);
  await w.actions.stop();
  const lines = w.lines();
  assert.deepEqual(lines.map((line) => [line.phase, line.code, line.count, line.actor, line.address, line.action, line.outcome]),
    [0, 1, 2].flatMap(() => [
      ['summary', 'forbidden-origin', 200, { kind: 'none', deviceId: null, scope: null, transport: null }, null, null, 'refused'],
      ['summary', 'unsupported-media', 100, { kind: 'none', deviceId: null, scope: null, transport: null }, null, null, 'refused'],
    ]), 'one line per reason per minute, 900 refusals in all');
  assert.ok(Buffer.byteLength(JSON.stringify(lines)) < 4096);
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
    actions: ALL_IDS.map((id) => ({ id, allowed: true, reason: null })),
    project: null, textMax: 500, limits: { actor: { perMinute: 6, perHour: 30 }, console: { perMinute: 20 } },
  });
  const old = await local.post('close-run', BODIES['close-run']());
  assert.equal(old.status, 501);
  assert.deepEqual(json(old).error, { code: 'core-lacks-action', verb: 'close-run', exit: 1 });
  assert.deepEqual(listed(await local.get('/api/actions')), [['decide-gate', true, null], ['close-run', false, 'core-lacks-action'], ['cancel-worker', true, null], ['start-session', true, null]]);

  const w = await lan(t, fakeRunner());
  const view = await w.world.pair('view', 'Viewer', 'native');
  const browserView = await w.world.pair('view', 'Browser');
  const control = await w.world.pair('control');
  const get = (headers: Record<string, string>) => w.server.request('GET', '/api/actions', { headers });
  const asView = json(await get({ Authorization: view.bearer }));
  assert.deepEqual(asView.actor, { kind: 'device', deviceId: view.device.id, scope: 'view', transport: 'native' });
  assert.deepEqual(asView.actions.map((entry: any) => entry.reason), ALL_IDS.map(() => 'phone-scope'));
  assert.deepEqual(listed(await get({ Cookie: browserView.cookie })), ALL_IDS.map((id) => [id, false, 'phone-scope']));
  const asControl = json(await get({ Authorization: control.bearer }));
  assert.deepEqual(asControl.actor, { kind: 'device', deviceId: control.device.id, scope: 'control', transport: 'native' });
  assert.deepEqual(asControl.actions.map((entry: any) => entry.allowed), ALL_IDS.map(() => true));
  const asBrowser = json(await get({ Cookie: control.cookie, Origin: w.server.origin }));
  assert.equal(asBrowser.actor.transport, 'browser');
  assert.deepEqual(asBrowser.actions.map((entry: any) => entry.reason), ALL_IDS.map(() => 'action-transport'));
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
  assert.deepEqual(reasons(await none.get('/api/actions')), ALL_IDS.map((id) => [id, false, 'action-log-unwritable']));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-action-log-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'console');
  fs.writeFileSync(dir, 'a file where the folder should be');
  const broken = await loopback(t, runner, { log: createActionLog({ dir }) });
  assert.deepEqual(reasons(await broken.get('/api/actions')), ALL_IDS.map((id) => [id, false, 'action-log-unwritable']));
  assert.equal(errorOf(await broken.post('close-run', BODIES['close-run']())), 'action-log-unwritable');
  fs.rmSync(dir);
  assert.deepEqual(reasons(await broken.get('/api/actions')), ALL_IDS.map((id) => [id, true, null]));
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

// ---- 165 IC-004: the start-session action and the two start reads ----

const WK = 'fedcba9876543210';
const AGENT_KEY = 'aa11bb22cc33dd44';
const START_RUN = {
  runId: RUN_ID, kind: 'main-session', phase: 'running', harness: 'claude', model: null, modelSource: 'default', worktreeKey: WK, startedBy: 'console',
  createdAt: '2026-11-15T10:00:00.000Z', agentKey: AGENT_KEY, layers: `/layers/${PK}/agent/${AGENT_KEY}`, files: { out: '1111222233334444', err: '5555666677778888' },
};
const startedReply = (over: Record<string, unknown> = {}, replayed = false) => ({ ok: true, exit: 0, json: { ok: true, replayed, run: { ...START_RUN, ...over } } });
const PROMPT = 'Fix the flaky upload test\nand say why it failed';
const startBody = (over: Record<string, unknown> = {}) => ({ v: 1, requestId: rid(), projectKey: PK, worktreeKey: WK, harness: 'claude', model: null, entry: 'do', prompt: PROMPT, ...over });
const START_OPTIONS = {
  project: { projectKey: PK, label: 'alpha', root: null },
  checkouts: [{ worktreeKey: WK, label: 'alpha', branch: 'main', main: true, busy: null, observedSession: { harness: 'claude', lastSeenAt: '2026-11-15T09:00:00.000Z' } },
    { worktreeKey: '0000111122223333', label: 'alpha-fix', branch: null, main: false, busy: { runId: 'w-aaaabbbbcccc' }, observedSession: null }],
  harnesses: [
    { harness: 'claude', startable: true, reason: null, words: 'claude can start a session here', warnings: ['runnable-not-checked'],
      login: { harness: 'claude', state: 'logged-in', reason: null, source: 'recipe', at: '2026-11-15T09:00:00.000Z', billing: null, providers: [], provider: null, hint: null, expirySeen: false, last: null, caveat: null }, version: '2.1.0', liveVerified: false, models: [{ id: 'claude-opus-5-5', source: 'frontier' }, { id: null, source: 'default' }] },
    { harness: 'copilot', startable: false, reason: 'no-main-session-shape', words: 'DoFlow has no recorded headless way to start copilot', warnings: [],
      login: null, version: null, liveVerified: false, models: [{ id: null, source: 'default' }] },
  ],
  limits: { perCheckout: 1, perActor: 2, machine: 4, perActorPerHour: 6 },
  open: { machine: 1 }, dispatch: { running: true, slug: 'feat-a' }, promptMax: { codePoints: 8000, bytes: 32768 },
  entries: ['do', 'none'], entryLine: 'Use the DoFlow do skill for this request:',
};
const LISTING = [
  { projectKey: PK, label: 'alpha', current: true, temp: false, checkouts: 2, sources: ['hook-dirs'], lastRecordAt: null, root: '/secret/alpha' },
  { projectKey: '1111111111111111', label: 'beta', current: false, temp: false, checkouts: 1, sources: ['upkeep-roots'], lastRecordAt: '2026-11-15T08:00:00.000Z', root: '/secret/beta' },
];

/** fakeRunner, whose `act` starts by default, and whose `start-options` read answers `options` (or `optionsAnswer`). */
function startRunner(answer: Answer = () => startedReply(), optionsAnswer: (params: any) => any = () => ({ ok: true, exit: 0, json: START_OPTIONS })) {
  const runner: any = fakeRunner(answer, LISTING);
  const listing = runner.run;
  runner.optionParams = [] as unknown[];
  runner.run = async (shape: string, params?: unknown, options?: unknown) => {
    if (shape !== 'start-options') return listing(shape, params, options);
    runner.reads.push(shape);
    runner.readOptions.push(options ?? null);
    runner.optionParams.push(params);
    return optionsAnswer(params);
  };
  return runner;
}

test('a view device gets 403 phone-scope on POST /api/actions/start-session and GET /api/start/options; a browser-transport control device gets 403 action-transport on the POST and may read; a control device over Bearer starts with its relay label', async (t) => {
  const runner = startRunner();
  const w = await lan(t, runner);
  const view = await w.world.pair('view', 'Viewer', 'native');
  const get = (target: string, headers: Record<string, string>) => w.server.request('GET', target, { headers });
  const posted = await w.post('start-session', startBody(), { Authorization: view.bearer });
  assert.equal(posted.status, 403);
  assert.deepEqual(json(posted), { error: { code: 'phone-scope', verb: null, exit: null } });
  for (const target of [`/api/start/options?projectKey=${PK}`, '/api/start']) {
    const reply = await get(target, { Authorization: view.bearer });
    assert.equal(reply.status, 403, target);
    assert.equal(errorOf(reply), 'phone-scope', target);
  }
  const control = await w.world.pair('control');
  const browser = await w.post('start-session', startBody(), { Cookie: control.cookie, Origin: w.server.origin, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(browser.status, 403);
  assert.equal(errorOf(browser), 'action-transport');
  assert.equal(runner.acts.length, 0, 'no refused start reached the runner');
  // D7: the reads need the control scope; the transport rule (162 FR-003) is the action's.
  assert.equal((await get(`/api/start/options?projectKey=${PK}`, { Cookie: control.cookie, Origin: w.server.origin })).status, 200);
  assert.equal((await get('/api/start', { Authorization: control.bearer })).status, 200);
  const body = startBody();
  const reply = await w.post('start-session', body, { Authorization: control.bearer });
  assert.equal(reply.status, 200, reply.body);
  const answer = json(reply);
  assert.deepEqual([answer.action, answer.requestId, answer.outcome, answer.replayed, answer.by], ['start-session', body.requestId, 'applied', false, `device.${control.device.id}`]);
  assert.deepEqual(runner.acts.map((call: any) => [call.shape, call.params.relay]), [['start-session', `device.${control.device.id}`]]);
  const begin = w.lines().find((line) => line.phase === 'begin');
  assert.deepEqual([begin.actor.kind, begin.actor.deviceId, begin.actor.transport], ['device', control.device.id, 'native']);
});

test('local start: the prompt reaches act as the stdin parameter only; a null model leaves --model out; the reply carries the core\'s run; the log has FR-010\'s fields and the prompt\'s length, and the prompt is in no line, reply or error', async (t) => {
  const clock = manual();
  let next: any = startedReply();
  const runner = startRunner(() => next);
  const w = await loopback(t, runner, { now: clock.now });
  const body = startBody();
  const reply = await w.post('start-session', body);
  assert.equal(reply.status, 200, reply.body);
  assert.deepEqual(runner.acts[0], { shape: 'start-session', params: { projectKey: PK, worktreeKey: WK, harness: 'claude', entry: 'do', relay: 'console', requestId: body.requestId, prompt: PROMPT } });
  assert.deepEqual(json(reply), { v: 1, action: 'start-session', requestId: body.requestId, outcome: 'applied', replayed: false, by: 'console', result: { replayed: false, run: START_RUN } });
  clock.t += 3 * MINUTE;
  next = startedReply({ model: 'claude-opus-5-5', modelSource: 'frontier', phase: 'ended', end: { state: 'exited', at: '2026-11-15T10:00:02.000Z' } });
  const modelled = await w.post('start-session', startBody({ model: 'claude-opus-5-5', entry: 'none' }));
  assert.equal(modelled.status, 200, modelled.body);
  assert.equal(runner.acts[1].params.model, 'claude-opus-5-5');
  assert.equal(runner.acts[1].params.entry, 'none');
  assert.deepEqual(json(modelled).result.run.end, { state: 'exited', at: '2026-11-15T10:00:02.000Z' });
  clock.t += 3 * MINUTE;
  next = { ok: true, exit: 1, json: { ok: false, code: 'checkout-busy', message: `busy: ${PROMPT}`, current: { runId: 'w-aaaabbbbcccc' } } };
  const busy = await w.post('start-session', startBody());
  assert.equal(busy.status, 409);
  assert.deepEqual(json(busy), { error: { code: 'checkout-busy', verb: 'start-session', exit: 1 }, current: { runId: 'w-aaaabbbbcccc' } });
  for (const call of runner.acts) {
    const others = Object.entries(call.params).filter(([name]) => name !== 'prompt').map(([, value]) => value);
    assert.equal(others.some((value) => String(value).includes('flaky')), false, 'the prompt is in no other parameter');
  }
  const ends = w.lines().filter((line) => line.phase === 'end');
  const begins = w.lines().filter((line) => line.phase === 'begin');
  assert.deepEqual(begins[0].target, { slug: null, taskId: null, gateId: null, runId: null, worktreeKey: WK, harness: 'claude', model: 'default' });
  assert.deepEqual(begins[0].input, { decision: null, textChars: [...PROMPT].length, entry: 'do' });
  assert.equal(begins[0].project, PK);
  assert.deepEqual([begins[1].target.model, begins[1].input.entry], ['claude-opus-5-5', 'none']);
  assert.deepEqual(ends.map((line) => [line.outcome, line.code, line.target.runId, line.exit, typeof line.ms]),
    [['applied', null, RUN_ID, 0, 'number'], ['applied', null, RUN_ID, 0, 'number'], ['refused', 'checkout-busy', null, 1, 'number']]);
  const text = fs.readFileSync(path.join(w.dir, 'actions.ndjson'), 'utf8');
  for (const word of ['flaky', 'upload test', 'say why']) {
    assert.equal(text.includes(word), false, `${word} is not logged`);
    for (const r of [reply, modelled, busy]) assert.equal(r.body.includes(word), false, `${word} is in no reply`);
  }
});

test('the prompt kind: CRLF and CR become LF, C0 (but tab and LF), C1 and bidi controls go; NUL or a lone surrogate is 400 usage; empty is 400 prompt-empty; past 8000 code points 400 prompt-too-long; a body past 40960 bytes is 400 usage; the 162 rows keep 4 KiB', async (t) => {
  const clock = manual();
  const runner = startRunner();
  const w = await loopback(t, runner, { now: clock.now });
  const emoji = '\u{1F600}'.repeat(8000);
  const cases: Array<[string, number, string | null]> = [
    ['one\r\ntwo\rthree', 200, 'one\ntwo\nthree'],
    ['a\u0007b\u0085c\u200Ed\u2066e\u061Cf\u202Eg\u001Bh', 200, 'abcdefgh'],
    ['col\tcol\nrow', 200, 'col\tcol\nrow'],
    [emoji, 200, emoji],
    ['a\u0000b', 400, 'usage'],
    ['a\uD800b', 400, 'usage'],
    ['', 400, 'prompt-empty'],
    [' \n\t\u200F ', 400, 'prompt-empty'],
    [`${emoji}x`, 400, 'prompt-too-long'],
    ['\u0001'.repeat(7000), 400, 'usage'],
  ];
  for (const [prompt, status, expected] of cases) {
    // One an hour: the start limit (six an hour) and the generic windows never refuse here.
    clock.t += 61 * MINUTE;
    const before = runner.acts.length;
    const reply = await w.post('start-session', startBody({ prompt }));
    assert.equal(reply.status, status, `${JSON.stringify(prompt).slice(0, 60)}: ${reply.body.slice(0, 200)}`);
    if (status === 200) assert.equal(runner.acts.at(-1).params.prompt, expected);
    else {
      assert.equal(runner.acts.length, before, 'a refused prompt never runs');
      assert.deepEqual(json(reply), { error: { code: expected, verb: null, exit: null } });
    }
  }
  clock.t += 61 * MINUTE;
  assert.equal((await w.post('start-session', startBody({ prompt: 'x'.repeat(5000) }))).status, 200, 'a start body is past 4 KiB and under its own cap');
  clock.t += 61 * MINUTE;
  assert.equal((await w.post('close-run', BODIES['close-run']({ note: 'x'.repeat(5000) }))).status, 400, 'the 162 rows keep their 4 KiB cap');
  for (const [name, value] of [['worktreeKey', WK.toUpperCase()], ['harness', '.claude'], ['model', ''], ['model', '-x'], ['entry', 'auto'], ['entry', null], ['prompt', null], ['relay', 'console']] as Array<[string, unknown]>) {
    clock.t += 61 * MINUTE;
    const reply = await w.post('start-session', startBody({ [name]: value }));
    assert.equal(reply.status, 400, `${name}=${JSON.stringify(value)}`);
    assert.equal(errorOf(reply), 'usage');
  }
  clock.t += 61 * MINUTE;
  const missing = startBody();
  delete (missing as any).entry;
  assert.equal(errorOf(await w.post('start-session', missing)), 'usage', 'entry is never defaulted: absent is usage');
});

test('the seventh start of an actor in an hour is 429 start-rate-limited with Retry-After; it counts the attempts that reach the core (a core refusal too), not a replay, a body refusal or a start that spawned nothing; another actor has its own hour', async (t) => {
  const clock = manual();
  let next: any = startedReply();
  const runner = startRunner((shape) => (shape === 'start-session' ? next : applied(shape)));
  const w = await lan(t, runner, { now: clock.now });
  const phone = await w.world.pair('control', 'Phone');
  const tablet = await w.world.pair('control', 'Tablet');
  const start = (device: any, over: Record<string, unknown> = {}) => w.post('start-session', startBody(over), { Authorization: device.bearer });
  const first = clock.t;
  const repeated = startBody();
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await start(phone)).status, 200, `start ${index + 1}`);
    clock.t += 2 * MINUTE;
  }
  assert.equal((await w.post('start-session', repeated, { Authorization: phone.bearer })).status, 200, 'start 5');
  assert.equal((await w.post('start-session', repeated, { Authorization: phone.bearer })).status, 200, 'a replay is not counted');
  assert.equal((await start(phone, { prompt: '' })).status, 400, 'a body refusal is not a start');
  clock.t += 2 * MINUTE;
  next = { ok: false, code: 'project-not-found', exit: null };
  assert.equal((await start(phone)).status, 404, 'a start the runner never spawned is not counted');
  next = startedReply();
  assert.equal((await start(phone)).status, 200, 'start 6');
  assert.equal(runner.acts.length, 8, 'six starts reached act, and the unknown key twice');
  const limited = await start(phone);
  assert.equal(limited.status, 429, limited.body);
  assert.equal(errorOf(limited), 'start-rate-limited');
  assert.equal(limited.headers['retry-after'], String(60 * 60 - 10 * 60), 'until the first start leaves its hour');
  assert.equal(runner.acts.length, 8, 'never run');
  assert.equal((await start(tablet)).status, 200, 'another actor has its own hour');
  assert.equal((await w.post('decide-gate', BODIES['decide-gate'](), { Authorization: phone.bearer })).status, 200, 'the start limit holds starts only');
  clock.t = first + 60 * MINUTE;
  next = { ok: true, exit: 1, json: { ok: false, code: 'machine-limit', message: 'full', current: { open: 4, max: 4 } } };
  const refused = await start(phone);
  assert.equal(refused.status, 429, 'the first start has left the hour');
  assert.equal(errorOf(refused), 'machine-limit');
  assert.equal(errorOf(await start(phone)), 'start-rate-limited', 'a core refusal reached the core, so it counts');
  await w.actions.stop();
  const summaries = w.lines().filter((line) => line.phase === 'summary' && line.code === 'start-rate-limited');
  assert.deepEqual(summaries.map((line) => [line.count, line.actor.deviceId, line.action]), [[1, phone.device.id, 'start-session'], [1, phone.device.id, 'start-session']]);
});

test('a start-session request id beginning with \'-\' is 400 usage and spawns nothing', async (t) => {
  const runner = startRunner();
  const w = await loopback(t, runner);
  for (const lead of ['-', '_']) {
    const reply = await w.post('start-session', startBody({ requestId: `${lead}ELeibJmLoXmIne4mqreyQ`.slice(0, 22) }));
    assert.equal(reply.status, 400, `leading ${lead}`);
    assert.equal(errorOf(reply), 'usage');
  }
  assert.equal(runner.acts.length, 0, 'the core never saw it');
  assert.equal((await w.post('start-session', startBody({ requestId: 'ELeibJmLoXmIne4mqreyQ-' }))).status, 200, 'a dash inside the id is fine');
});

test('FR-011: a double tap with one request id starts once and replays the first reply; a repeat the core answers as replayed is 200 with result.replayed', async (t) => {
  const held = heldRunner();
  const runner = startRunner((shape, params) => (shape === 'start-session' ? new Promise((resolve) => held.gates.push(() => resolve(startedReply()))) : applied(shape)));
  const w = await loopback(t, runner);
  const body = startBody();
  const firstTap = w.post('start-session', body);
  const secondTap = w.post('start-session', body);
  await w.bodiesRead(2);
  await until(() => held.gates.length === 1, 'the first tap reached act');
  held.releaseAll();
  const [one, two] = await Promise.all([firstTap, secondTap]);
  assert.deepEqual([one.status, two.status], [200, 200]);
  assert.equal(runner.acts.length, 1, 'one start');
  assert.deepEqual([json(one).replayed, json(two).replayed], [false, true]);
  assert.deepEqual(json(two).result, json(one).result);
  const again = startRunner(() => startedReply({}, true));
  const v = await loopback(t, again);
  const replayed = await v.post('start-session', startBody());
  assert.equal(replayed.status, 200);
  assert.deepEqual([json(replayed).replayed, json(replayed).result.replayed, json(replayed).result.run.runId], [false, true, RUN_ID]);
  assert.equal(v.lines().find((line) => line.phase === 'end').outcome, 'replayed', 'the log says the core started nothing');
});

test('every start-session refusal id maps to IC-004\'s status with the core\'s current; an older core\'s usage is 501 core-lacks-action and GET /api/actions says so; an unknown project is 404 after one refresh and nothing spawns', async (t) => {
  const refusal = (code: string, current?: unknown) => ({ ok: true, exit: 1, json: { ok: false, code, message: 'words', ...(current === undefined ? {} : { current }) } });
  const cases: Array<[any, number, string, unknown, number | null]> = [
    ...['unknown-worktree', 'worktree-gone', 'prompt-empty', 'prompt-nul', 'prompt-too-long', 'prompt-leading-dash', 'prompt-leading-at']
      .map((code) => [refusal(code), 400, code, undefined, 1] as [any, number, string, unknown, number | null]),
    [refusal('model-not-offered', { harness: 'claude', models: [{ id: 'claude-opus-5-5', source: 'frontier' }, { id: null, source: 'default' }] }), 400, 'model-not-offered',
      { harness: 'claude', models: [{ id: 'claude-opus-5-5', source: 'frontier' }, { id: null, source: 'default' }] }, 1],
    [refusal('checkout-busy', { runId: 'w-aaaabbbbcccc' }), 409, 'checkout-busy', { runId: 'w-aaaabbbbcccc' }, 1],
    // 165 review A-1: a run whose liveness cannot be read holds the checkout under its own id.
    [refusal('checkout-busy-unknown', { runId: 'w-aaaabbbbcccc' }), 409, 'checkout-busy-unknown', { runId: 'w-aaaabbbbcccc' }, 1],
    [refusal('dispatch-running', { slug: 'feat-a', driverPid: 4242 }), 409, 'dispatch-running', { slug: 'feat-a', dispatchId: null, driverPid: 4242, reason: null }, 1],
    [refusal('dispatch-running', { slug: 'feat-a', dispatchId: 'd-1' }), 409, 'dispatch-running', { slug: 'feat-a', dispatchId: 'd-1', driverPid: null, reason: null }, 1],
    [refusal('dispatch-running', { slug: 'feat-b', reason: 'store-unreadable' }), 409, 'dispatch-running', { slug: 'feat-b', dispatchId: null, driverPid: null, reason: 'store-unreadable' }, 1],
    [refusal('dispatch-running', { slug: null, reason: 'dispatch-unreadable', detail: 'EACCES' }), 409, 'dispatch-running', { slug: null, dispatchId: null, driverPid: null, reason: 'dispatch-unreadable' }, 1],
    [refusal('harness-not-startable', { harness: 'copilot', reason: 'no-main-session-shape' }), 409, 'harness-not-startable', { harness: 'copilot', reason: 'no-main-session-shape' }, 1],
    [refusal('harness-not-startable', { harness: 'codex', reason: 'logged-out' }), 409, 'harness-not-startable', { harness: 'codex', reason: 'logged-out' }, 1],
    [refusal('nested-start', { runId: 'w-aaaabbbbcccc' }), 409, 'nested-start', { runId: 'w-aaaabbbbcccc' }, 1],
    [refusal('actor-limit', { open: 2, max: 2 }), 429, 'actor-limit', { open: 2, max: 2 }, 1],
    [refusal('machine-limit', { open: 4, max: 4 }), 429, 'machine-limit', { open: 4, max: 4 }, 1],
    [refusal('project-mismatch', { projectKey: '1111111111111111' }), 404, 'project-not-found', undefined, 1],
    [refusal('project-not-indexed'), 404, 'project-not-found', undefined, 1],
    [refusal('something-new'), 502, 'core-contract-mismatch', undefined, 1],
    [refusal('checkout-busy', { runId: '../x' }), 502, 'core-contract-mismatch', undefined, 1],
    [refusal('harness-not-startable', { harness: 'copilot', reason: 'a reason of its own' }), 502, 'core-contract-mismatch', undefined, 1],
    [{ ok: true, exit: 0, json: { ok: true, replayed: false, run: { ...START_RUN, layers: '/elsewhere' } } }, 502, 'core-contract-mismatch', undefined, 0],
    [{ ok: true, exit: 0, json: { ok: true, replayed: false, run: { ...START_RUN, kind: 'worker' } } }, 502, 'core-contract-mismatch', undefined, 0],
    [{ ok: false, code: 'timeout', exit: null }, 504, 'action-timeout', undefined, null],
    [{ ok: false, code: 'core-error', exit: 3 }, 502, 'core-error', undefined, 3],
    [{ ok: false, code: 'usage', exit: 2 }, 501, 'core-lacks-action', undefined, 2],
  ];
  const clock = manual();
  let next: any = null;
  const runner = startRunner(() => next);
  const w = await loopback(t, runner, { now: clock.now });
  for (const [result, status, code, current, exit] of cases) {
    clock.t += 61 * MINUTE;
    next = result;
    const reply = await w.post('start-session', startBody());
    const label = JSON.stringify(result).slice(0, 100);
    assert.equal(reply.status, status, `${label}: ${reply.body}`);
    assert.deepEqual(json(reply).error, { code, verb: 'start-session', exit }, label);
    if (current === undefined) assert.equal(Object.hasOwn(json(reply), 'current'), false, label);
    else assert.deepEqual(json(reply).current, current, label);
  }
  const listed = json(await w.get('/api/actions')).actions.find((entry: any) => entry.id === 'start-session');
  assert.deepEqual(listed, { id: 'start-session', allowed: false, reason: 'core-lacks-action' });
  // The runner's map lacks the key, refreshed once: 404, and the runner never spawned (it refuses an unknown key before any spawn).
  const lost = startRunner(() => ({ ok: false, code: 'project-not-found', exit: null }));
  const v = await loopback(t, lost);
  const gone = await v.post('start-session', startBody());
  assert.equal(gone.status, 404);
  assert.deepEqual(json(gone).error, { code: 'project-not-found', verb: 'start-session', exit: null });
  assert.deepEqual([lost.acts.length, lost.reads, lost.readOptions], [2, ['projects'], [{ fresh: true }]]);
});

test('165 F1: an exit 2 of start-session is 501 core-lacks-action only for the id usage or none; any other id is 502 core-error carrying the id, and the action stays offered', async (t) => {
  const clock = manual();
  let next: any = null;
  const runner = startRunner(() => next);
  const w = await loopback(t, runner, { now: clock.now });
  const cases: Array<[any, number, string, string | undefined]> = [
    [{ ok: false, code: 'usage', exit: 2, errorId: 'store-unreadable' }, 502, 'core-error', 'store-unreadable'],
    [{ ok: false, code: 'usage', exit: 2, errorId: 'registry-invalid' }, 502, 'core-error', 'registry-invalid'],
    [{ ok: false, code: 'usage', exit: 2, errorId: 'usage' }, 501, 'core-lacks-action', undefined],
  ];
  for (const [result, status, code, id] of cases) {
    clock.t += 61 * MINUTE;
    next = result;
    const reply = await w.post('start-session', startBody());
    assert.equal(reply.status, status, reply.body);
    assert.deepEqual(json(reply).error, { code, verb: 'start-session', exit: 2, ...(id === undefined ? {} : { id }) });
    if (status === 502) {
      const listed = json(await w.get('/api/actions')).actions.find((entry: any) => entry.id === 'start-session');
      assert.deepEqual(listed, { id: 'start-session', allowed: true, reason: null }, 'a core error is not a missing action');
    }
  }
});

test('GET /api/start lists the projects by key and label, never a root; GET /api/start/options passes IC-002 through with root null; a bad query is 400 usage, an unknown key 404 after one refresh, an older core 501, a body that does not project 502', async (t) => {
  let options: any = { ok: true, exit: 0, json: START_OPTIONS };
  const runner = startRunner(undefined, () => options);
  const w = await loopback(t, runner);
  const list = await w.get('/api/start');
  assert.equal(list.status, 200, list.body);
  assert.deepEqual(json(list), { v: 1, projects: [{ projectKey: PK, label: 'alpha', current: true }, { projectKey: '1111111111111111', label: 'beta', current: false }], truncated: false });
  assert.equal(list.body.includes('/secret'), false, 'no root');
  const read = await w.get(`/api/start/options?projectKey=${PK}`);
  assert.equal(read.status, 200, read.body);
  assert.deepEqual(json(read), { v: 1, ...START_OPTIONS });
  assert.deepEqual(runner.optionParams, [{ projectKey: PK }]);
  for (const target of ['/api/start/options', `/api/start/options?projectKey=${PK.toUpperCase()}`, `/api/start/options?projectKey=${PK}&projectKey=${PK}`, `/api/start/options?projectKey=${PK}&x=1`, '/api/start?x=1']) {
    const reply = await w.get(target);
    assert.equal(reply.status, 400, target);
    assert.equal(errorOf(reply), 'usage', target);
  }
  assert.equal(runner.optionParams.length, 1, 'a bad query never reads');
  const projected: Array<[unknown, number, string]> = [
    [{ ok: true, exit: 0, json: { ...START_OPTIONS, project: { ...START_OPTIONS.project, root: '/secret/alpha' } } }, 502, 'core-contract-mismatch'],
    [{ ok: true, exit: 0, json: { ...START_OPTIONS, harnesses: [{ ...START_OPTIONS.harnesses[0], startable: 'yes' }] } }, 502, 'core-contract-mismatch'],
    [{ ok: false, code: 'core-error', exit: 2, errorId: 'usage' }, 501, 'core-lacks-verb'],
    [{ ok: false, code: 'core-error', exit: 1, reason: 'old-core' }, 501, 'core-lacks-verb'],
    [{ ok: false, code: 'core-error', exit: 2, errorId: 'store-unreadable' }, 502, 'core-error'],
  ];
  for (const [answer, status, code] of projected) {
    options = answer;
    const reply = await w.get(`/api/start/options?projectKey=${PK}`);
    assert.equal(reply.status, status, `${JSON.stringify(answer).slice(0, 90)}: ${reply.body}`);
    assert.equal(errorOf(reply), code);
    assert.equal(reply.body.includes('/secret'), false);
  }
  options = { ok: false, code: 'project-not-found', exit: null };
  runner.reads.length = 0;
  runner.readOptions.length = 0;
  const gone = await w.get(`/api/start/options?projectKey=${PK}`);
  assert.equal(gone.status, 404);
  assert.equal(errorOf(gone), 'project-not-found');
  assert.deepEqual([runner.reads, runner.readOptions], [['start-options', 'projects', 'start-options'], [null, { fresh: true }, null]], 'one fresh projects read, then once more');
});

test('a POST to /api/actions/start-session refused before an actor exists (403 forbidden-origin, 415 unsupported-media) is counted on the pre-actor summary line of its reason', async (t) => {
  const runner = startRunner();
  const w = await loopback(t, runner);
  assert.equal((await w.post('start-session', startBody(), { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await w.post('start-session', startBody(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(runner.acts.length, 0);
  await w.actions.stop();
  assert.deepEqual(w.lines().map((line) => [line.phase, line.code, line.count, line.actor.kind, line.action]),
    [['summary', 'forbidden-origin', 1, 'none', null], ['summary', 'unsupported-media', 1, 'none', null]]);
});
