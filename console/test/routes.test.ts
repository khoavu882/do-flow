'use strict';

// IC-005 read routes over a scripted runner (feature 093, C.1). The runner answers from the real core
// outputs under fixtures/core/ (which carry the planted marker in every free-text field), so each case
// checks what the route does with a runner result: body shape, error code mapping, the session check,
// the parameter pattern, and that the only non-GET routes are POST /api/session and the seven action routes
// (162; their behaviour is actions-routes.test.ts). The real core is
// exercised end to end by read-contract.test.ts.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createServer } = require('../src/server.ts');
const { consoleRoutes, TASK_CLASSES } = require('../src/routes.ts');
const { createSessions, cookieName } = require('../src/session.ts');
const { lanWorld } = require('./helpers/lan-world.ts');
const { createVerbRunner } = require('../src/verb-runner.ts');

const FIXTURES = path.join(__dirname, 'fixtures', 'core');
const MARKER = 'ZZ-MARKER-7f3';
const KEY = '0cc00ec6d2062bc0';
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

/** IC-018 core outputs with the marker in fields the projectors drop. */
const SAMPLES: Record<string, () => any> = {
  observed: () => ({ v: 1, store: 'present', truncated: false, unreadable: 0, sessions: [],
    checkouts: [{ worktreeKey: KEY, role: 'main', current: true, branch: `x ${MARKER} <b>`, head: 'febd2cc99487', headCommittedAt: '2026-10-26T09:45:48.000Z' }] }),
  slots: () => ({ v: 1, unreadable: 0, slots: [{ name: 'build', holder: { label: 'npm test', since: '2026-10-26T09:00:00.000Z', alive: false, worktreeKey: KEY, cwd: `/tmp/${MARKER}` }, waiters: 0 }] }),
  'worker-status': () => ({ disposition: 'status', run: null, task: 'A.1', token: 1 }),
  roadmap: () => ({ schema: 1, action: 'status', rowStatus: {}, rows: [], openIntents: [], run: null, holds: [],
    lease: { pid: 4242, host: `host-${MARKER}`, runId: null, acquiredAt: '2026-10-26T08:00:00.000Z' } }),
};
const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-routes-'));
after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

type Reply = { status: number, headers: Record<string, string>, body: string };
type Answer = { ok: true, json: any, exit: 0 } | { ok: false, code: string, exit: number | null, errorId?: string };

const ok = (json: any): Answer => ({ ok: true, json, exit: 0 });
const DEFAULTS: Record<string, () => Answer> = {
  version: () => ok('2.0.0-beta.7'),
  capabilities: () => ok(fixture('capabilities')),
  list: () => ok(fixture('list')),
  status: () => ok(fixture('status')),
  timeline: () => ok(fixture('timeline')),
  attempts: () => ok(fixture('attempts')),
  workflow: () => ok(fixture('workflow')),
  observed: () => ok(SAMPLES.observed()),
  slots: () => ok(SAMPLES.slots()),
  'worker-status': () => ok(SAMPLES['worker-status']()),
  roadmap: () => ok(SAMPLES.roadmap()),
};

/** A runner that answers each shape from `overrides`, else from the fixtures, and records every call. */
function scripted(overrides: Record<string, (params: any) => Answer> = {}) {
  const calls: Array<{ shape: string, params: any }> = [];
  return {
    calls,
    run: async (shape: string, params: any) => {
      calls.push({ shape, params });
      return (overrides[shape] ?? DEFAULTS[shape])(params);
    },
  };
}

function raw(port: number, text: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: any[] = [];
    socket.on('data', (chunk: any) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const all = Buffer.concat(chunks).toString('utf8');
      const split = all.indexOf('\r\n\r\n');
      const [statusLine, ...lines] = all.slice(0, split).split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines) headers[line.slice(0, line.indexOf(':')).toLowerCase()] = line.slice(line.indexOf(':') + 1).trim();
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body: all.slice(split + 4) });
    });
    socket.write(text, 'latin1');
  });
}

/** A server over `runner` with one live session; `get` sends the session cookie unless told not to. */
async function harness(runner: any, t: any) {
  const sessions = createSessions();
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions) });
  t.after(() => app.close());
  const token = sessions.exchange(sessions.mintLaunchCode());
  const get = (target: string, cookie = true) => raw(app.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n`
    + `${cookie ? `Cookie: ${cookieName(app.port)}=${token}\r\n` : ''}Connection: close\r\n\r\n`);
  const json = async (target: string) => {
    const reply = await get(target);
    assert.equal(reply.headers['cache-control'], 'no-store', target);
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8', target);
    assert.ok(!reply.body.includes(MARKER), `${target}: the planted marker reached the body`);
    return { status: reply.status, body: JSON.parse(reply.body) };
  };
  return { app, get, json };
}

const errorBody = (code: string, verb: string | null = null, exit: number | null = null) => ({ error: { code, verb, exit } });
/** 161: the fixtures, and core-unreachable for every shape they lack (a device now reaches the worker-run reads). */
const reachRunner = () => scripted(new Proxy({}, { get: (_target, shape) => (Object.hasOwn(DEFAULTS, shape) ? undefined : () => ({ ok: false, code: 'core-unreachable', exit: null })) }));

const ACTION_WRITES = ['POST /api/actions/decide-gate', 'POST /api/actions/close-run', 'POST /api/actions/cancel-worker', 'POST /api/actions/start-session',
  'POST /api/actions/session-send', 'POST /api/actions/session-steer', 'POST /api/actions/session-stop'];

test('route table: frozen, the only non-GET routes are POST /api/session and the seven action routes, the one stream route is GET /api/live (161: no Fleet routes), the IC-005 read paths plus /api/live and /api/actions, the device list the device reads', async (t) => {
  const routes = consoleRoutes(scripted(), createSessions());
  assert.ok(Object.isFrozen(routes) && routes.every((route: any) => Object.isFrozen(route)));
  assert.deepEqual(routes.filter((route: any) => route.method !== 'GET').map((route: any) => `${route.method} ${route.path}`), ['POST /api/session', ...ACTION_WRITES]);
  assert.deepEqual(routes.filter((route: any) => route.stream).map((route: any) => `${route.method} ${route.path}`), ['GET /api/live']);
  assert.deepEqual(routes.filter((route: any) => route.method === 'GET').map((route: any) => route.path).sort(),
    ['/*', '/api/actions', '/api/advice', '/api/doctor', '/api/followups', '/api/followups/:id', '/api/harness-login', '/api/info', '/api/live', '/api/runs', '/api/runs/:slug/:taskId', '/api/runs/:slug/:taskId/export',
      '/api/sessions', '/api/sessions-history', '/api/settings', '/api/start', '/api/start/options', '/api/storage',
      '/api/worker-runs/:slug', '/api/worker-runs/:slug/:runId/log', '/api/worker-runs/:slug/:runId/result', '/api/worker-runs/:slug/:runId/status',
      '/api/worker-runs/:slug/:runId/transcript', '/api/workers', '/api/workflows', '/healthz']);
  // The device list (scopes.ts, 160 IC-007, 161 IC-009) by behaviour: a paired device passes the device check on exactly the device reads,
  // and the LAN table has POST /api/pair and the seven action routes as its only non-GET routes and no launch-code exchange.
  const world = lanWorld(t);
  const { cookie } = await world.pair('view');
  const lanRoutes = consoleRoutes(reachRunner(), world.auth);
  assert.deepEqual(lanRoutes.filter((route: any) => route.method !== 'GET').map((route: any) => `${route.method} ${route.path}`), ['POST /api/pair', ...ACTION_WRITES]);
  const reachable: string[] = [];
  const refused: string[] = [];
  for (const route of lanRoutes.filter((item: any) => item.method === 'GET' && item.path.startsWith('/api/'))) {
    const reply = await route.handler({ req: { headers: { cookie }, url: route.path, socket: { remoteAddress: '192.168.1.40' } }, clientClass: 'browser', port: 4310, params: { slug: 'feat-a', taskId: 'run-1' }, pathname: route.path, webRoot: '/tmp', res: {} });
    if (reply === null || reply.status !== 403) reachable.push(route.path);
    else {
      assert.deepEqual(JSON.parse(reply.body), errorBody('phone-scope'), route.path);
      refused.push(route.path);
    }
  }
  assert.deepEqual(reachable.sort(), ['/api/actions', '/api/harness-login', '/api/info', '/api/live', '/api/runs', '/api/runs/:slug/:taskId', '/api/runs/:slug/:taskId/export', '/api/sessions', '/api/worker-runs/:slug', '/api/worker-runs/:slug/:runId/log',
    '/api/worker-runs/:slug/:runId/result', '/api/worker-runs/:slug/:runId/status', '/api/worker-runs/:slug/:runId/transcript', '/api/workflows']);
  // 151 IC-012 to IC-014, 152 IC-006: the management routes and sessions-history are among the refused.
  for (const path of ['/api/settings', '/api/advice', '/api/workers', '/api/followups', '/api/followups/:id', '/api/doctor', '/api/storage', '/api/sessions-history']) assert.ok(refused.includes(path), path);
});

test('session: every read route is 401 without the cookie and no verb runs', async (t) => {
  const runner = scripted();
  const { get } = await harness(runner, t);
  for (const target of ['/api/info', '/api/runs', '/api/runs/s1/t1', '/api/workflows', '/api/sessions', '/api/sessions-history', '/api/live?ch=now',
    '/api/worker-runs/s1', '/api/worker-runs/s1/w-0123456789ab/transcript']) {
    const reply = await get(target, false);
    assert.equal(reply.status, 401, target);
    assert.deepEqual(JSON.parse(reply.body), errorBody('unauthenticated'), target);
  }
  assert.deepEqual(runner.calls, []);
});

test('device session: only the device GET routes are allowed (160 four, 161 live, sessions and worker-run reads), for view and for control', async (t) => {
  const runner = reachRunner();
  const world = lanWorld(t);
  const routes = consoleRoutes(runner, world.auth);
  for (const scope of ['view', 'control'] as const) {
    const { cookie } = await world.pair(scope);
    const invoke = (route: any, params: Record<string, string> = {}) => route.handler({
      req: { headers: { cookie }, socket: { remoteAddress: '192.168.1.40' } }, clientClass: 'browser', port: 4310, params, pathname: route.path, webRoot: '/tmp', res: {},
    });
    const allowed = [
      ['/api/info', {}],
      ['/api/runs', {}],
      ['/api/runs/:slug/:taskId', { slug: 'feat-a', taskId: 'run-1' }],
      ['/api/runs/:slug/:taskId/export', { slug: 'feat-a', taskId: 'run-1' }],
      ['/api/workflows', {}],
      ['/api/harness-login', {}],
      ['/api/live', {}],
      ['/api/sessions', {}],
      ['/api/worker-runs/:slug', { slug: 'feat-a' }],
      ['/api/worker-runs/:slug/:runId/result', { slug: 'feat-a', runId: 'w-0123456789ab' }],
      ['/api/worker-runs/:slug/:runId/status', { slug: 'feat-a', runId: 'w-0123456789ab' }],
      ['/api/worker-runs/:slug/:runId/log', { slug: 'feat-a', runId: 'w-0123456789ab' }],
      ['/api/worker-runs/:slug/:runId/transcript', { slug: 'feat-a', runId: 'w-0123456789ab' }],
    ] as const;
    for (const [path, params] of allowed) {
      const route = routes.find((item: any) => item.method === 'GET' && item.path === path);
      assert.ok(route, path);
      const reply = await invoke(route, params as Record<string, string>);
      assert.notEqual(reply.status, 403, `${path} is on the device list (${scope})`);
    }
    for (const path of ['/api/settings', '/api/advice', '/api/workers', '/api/followups', '/api/followups/:id', '/api/doctor', '/api/storage', '/api/sessions-history']) {
      const route = routes.find((item: any) => item.method === 'GET' && item.path === path);
      assert.ok(route, path);
      const reply = await invoke(route);
      assert.equal(reply.status, 403, path);
      assert.deepEqual(JSON.parse(reply.body), errorBody('phone-scope'), path);
    }
  }
});

test('params: a slug or task id failing the IC-003 pattern is 400 usage before any verb runs', async (t) => {
  const runner = scripted();
  const { json } = await harness(runner, t);
  for (const [slug, taskId] of [['-x', 't1'], ['.hidden', 't1'], ['..', 't1'], ['a%2Fb', 't1'], ['a%20b', 't1'], ['s1', '_t'],
    ['s1', 't%00'], ['s1', '%E2%80%AE'], ['s1', 'a;b'], ['s1', 'a~b']]) {
    const reply = await json(`/api/runs/${slug}/${taskId}`);
    assert.equal(reply.status, 400, `${slug}/${taskId}`);
    assert.deepEqual(reply.body, errorBody('usage'), `${slug}/${taskId}`);
  }
  assert.deepEqual(runner.calls, []);
});

test('GET /api/info: the core version with its range verdict and the capability rows', async (t) => {
  const { json } = await harness(scripted(), t);
  const reply = await json('/api/info');
  assert.equal(reply.status, 200);
  assert.deepEqual(Object.keys(reply.body), ['v', 'core', 'capabilities']);
  assert.deepEqual(reply.body.core, { version: '2.0.0-beta.7', inRange: true });
  assert.deepEqual(reply.body.capabilities[0], { capability: 'code.exact-search', status: 'HEALTHY', providerId: 'native.rg' });
  const outside = await harness(scripted({ version: () => ok('3.1.0') }), t);
  assert.deepEqual((await outside.json('/api/info')).body.core, { version: '3.1.0', inRange: false });
  const broken = await harness(scripted({ version: () => ok('not a version') }), t);
  assert.deepEqual(await broken.json('/api/info'), { status: 502, body: errorBody('core-contract-mismatch', 'version', 0) });
});

test('GET /api/runs: the projected list with the unreadable count only', async (t) => {
  const { json } = await harness(scripted(), t);
  const reply = await json('/api/runs');
  assert.equal(reply.status, 200);
  assert.deepEqual(Object.keys(reply.body), ['v', 'runs', 'unreadableCount']);
  assert.equal(reply.body.runs.length, fixture('list').runs.length);
  assert.equal(reply.body.unreadableCount, fixture('list').unreadable.length);
});

test('GET /api/runs/:slug/:taskId: status, timeline, attempts and the class workflow, each called with the route params', async (t) => {
  const runner = scripted();
  const { json } = await harness(runner, t);
  const reply = await json('/api/runs/093-console-web-ui/t1');
  assert.equal(reply.status, 200);
  assert.deepEqual(Object.keys(reply.body), ['v', 'run', 'timeline', 'tasks', 'workflow']);
  assert.equal(reply.body.run.taskId, 't1');
  assert.equal(reply.body.run.journalGateDiffers, true, 'the fixture journal prompt carries the marker, so it differs from the registry');
  assert.equal(reply.body.timeline.taskId, 't1');
  assert.equal(reply.body.tasks.graph.graphPlan, true);
  assert.equal(reply.body.workflow.taskClass, 'feature');
  assert.deepEqual(runner.calls.map((call) => call.shape).sort(), ['attempts', 'list', 'status', 'timeline', 'workflow']);
  const params = Object.fromEntries(runner.calls.map((call) => [call.shape, call.params]));
  assert.deepEqual(params.status, { taskId: 't1', slug: '093-console-web-ui' });
  assert.deepEqual(params.timeline, { taskId: 't1', slug: '093-console-web-ui' });
  assert.deepEqual(params.attempts, { slug: '093-console-web-ui' });
  assert.deepEqual(params.workflow, { taskClass: 'feature' });
});

/** The list fixture with its `t1` row moved to feature `slug` (the fixture row is slug-less). */
function listWith(slug: string | null) {
  const list = fixture('list');
  for (const row of list.runs) if (row.taskId === 't1') row.featureSlug = slug;
  return list;
}

test('GET /api/runs/:slug/:taskId: featureSlug, startedAt, updatedAt and origin come from the list row with the same id and slug', async (t) => {
  const row = listWith('s1').runs.find((entry: any) => entry.taskId === 't1');
  const { json } = await harness(scripted({ list: () => ok(listWith('s1')) }), t);
  const { run } = (await json('/api/runs/s1/t1')).body;
  assert.deepEqual([run.featureSlug, run.startedAt, run.updatedAt, run.origin], [row.featureSlug, row.startedAt, row.updatedAt, row.origin]);
  assert.ok(run.updatedAt);
  // Same id under another slug, or no row at all: the fields stay null.
  for (const list of [listWith('s2'), listWith(null), { v: 1, runs: [], unreadable: [] }]) {
    const other = await harness(scripted({ list: () => ok(list) }), t);
    const reply = await other.json('/api/runs/s1/t1');
    assert.equal(reply.status, 200);
    assert.deepEqual([reply.body.run.featureSlug, reply.body.run.startedAt, reply.body.run.updatedAt, reply.body.run.origin], [null, null, null, null]);
  }
});

test('GET /api/runs/:slug/:taskId: tasks null with tasksReason no-plan (inspect error plan-unreadable) and legacy-plan (no graph header)', async (t) => {
  const noPlan = await harness(scripted({ attempts: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'plan-unreadable' }) }), t);
  const none = await noPlan.json('/api/runs/s1/t1');
  assert.equal(none.status, 200);
  assert.deepEqual([none.body.tasks, none.body.tasksReason], [null, 'no-plan']);
  const legacy = fixture('attempts');
  legacy.graph.graphPlan = false;
  const legacyPlan = await harness(scripted({ attempts: () => ok(legacy) }), t);
  const old = await legacyPlan.json('/api/runs/s1/t1');
  assert.deepEqual([old.body.tasks, old.body.tasksReason], [null, 'legacy-plan']);
  assert.deepEqual(Object.keys(old.body), ['v', 'run', 'timeline', 'tasks', 'workflow', 'tasksReason']);
});

test('GET /api/runs/:slug/:taskId: a timeline that cannot be read gives timeline null with timelineReason, never a failed route (E.2 Q4); run-not-found stays a 404', async (t) => {
  const cases: Array<[Record<string, (params: any) => Answer>, string]> = [
    [{ timeline: () => ({ ok: false, code: 'core-error', exit: 2 }) }, 'core-error'],
    [{ timeline: () => ({ ok: false, code: 'core-unreachable', exit: null }) }, 'core-unreachable'],
    [{ timeline: () => ok({ ...fixture('timeline'), v: 2 }) }, 'core-contract-mismatch'],
  ];
  for (const [overrides, reason] of cases) {
    const { json } = await harness(scripted(overrides), t);
    const reply = await json('/api/runs/s1/t1');
    assert.equal(reply.status, 200, reason);
    assert.deepEqual(Object.keys(reply.body), ['v', 'run', 'timeline', 'tasks', 'workflow', 'timelineReason'], reason);
    assert.deepEqual([reply.body.timeline, reply.body.timelineReason], [null, reason]);
    assert.equal(reply.body.run.taskId, 't1', 'the rest of the body is whole');
    assert.equal(reply.body.tasks.graph.graphPlan, true);
  }
  const both = await harness(scripted({ timeline: () => ({ ok: false, code: 'core-error', exit: 2 }), attempts: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'plan-unreadable' }) }), t);
  const bothBody = (await both.json('/api/runs/s1/t1')).body;
  assert.deepEqual(Object.keys(bothBody), ['v', 'run', 'timeline', 'tasks', 'workflow', 'tasksReason', 'timelineReason']);
  const gone = await harness(scripted({ timeline: () => ({ ok: false, code: 'core-error', exit: 1 }) }), t);
  assert.deepEqual(await gone.json('/api/runs/s1/t1'), { status: 404, body: errorBody('run-not-found', 'timeline', 1) });
});

test('161: the Fleet routes are gone: GET /api/stream, /api/fleet and /api/transcript are 404 with a session, with no redirect and no verb run', async (t) => {
  const runner = scripted();
  const { get } = await harness(runner, t);
  for (const target of ['/api/stream', '/api/stream?project=0cc00ec6d2062bc0', '/api/fleet', '/api/transcript', '/api/transcript?project=0cc00ec6d2062bc0&agent=0cc00ec6d2062bc0']) {
    const reply = await get(target);
    assert.equal(reply.status, 404, target);
    assert.equal(reply.headers.location, undefined, `${target}: no redirect`);
    assert.ok(!reply.body.includes('retry:'), `${target}: no stream`);
  }
  assert.deepEqual(runner.calls, []);
});

test('error mapping: runner and projector failures become the IC-005 codes with the shape id and exit', async (t) => {
  const cases: Array<[string, Record<string, (params: any) => Answer>, number, any]> = [
    ['/api/runs/s1/t1', { status: () => ({ ok: false, code: 'core-error', exit: 1 }) }, 404, errorBody('run-not-found', 'status', 1)],
    ['/api/runs/s1/t1', { timeline: () => ({ ok: false, code: 'core-error', exit: 1 }) }, 404, errorBody('run-not-found', 'timeline', 1)],
    ['/api/runs/s1/t1', { status: () => ({ ok: false, code: 'core-error', exit: 2 }) }, 502, errorBody('core-error', 'status', 2)],
    ['/api/runs/s1/t1', { status: () => ({ ok: false, code: 'core-unreachable', exit: null }) }, 503, errorBody('core-unreachable', 'status')],
    ['/api/runs/s1/t1', { status: () => ok({ ...fixture('status'), state: 'PAUSED' }) }, 502, errorBody('core-contract-mismatch', 'status', 0)],
    ['/api/runs/s1/t1', { status: () => ok({ ...fixture('status'), taskClass: '../x' }) }, 502, errorBody('core-contract-mismatch', 'status', 0)],
    ['/api/runs/s1/t1', { attempts: () => ok({ ...fixture('attempts'), tasks: null }) }, 502, errorBody('core-contract-mismatch', 'attempts', 0)],
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 1 }) }, 502, errorBody('core-error', 'attempts', 1)],
    // Only the core's plan-unreadable id is "no plan": a malformed plan, an unreadable store or a bare exit 2 is an error.
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'plan-malformed' }) }, 502, errorBody('core-error', 'attempts', 2)],
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'store-unreadable' }) }, 502, errorBody('core-error', 'attempts', 2)],
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 2 }) }, 502, errorBody('core-error', 'attempts', 2)],
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'plan-unreadable' }) }, 502, errorBody('core-error', 'attempts', 1)],
    ['/api/runs/s1/t1', { workflow: () => ({ ok: false, code: 'core-error', exit: null }) }, 502, errorBody('core-error', 'workflow')],
    ['/api/runs', { list: () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'cannot-list-checkouts' }) }, 502, errorBody('cannot-list-checkouts', 'list', 1)],
    ['/api/runs/s1/t1', { list: () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'cannot-list-checkouts' }) }, 502, errorBody('cannot-list-checkouts', 'list', 1)],
    ['/api/runs/s1/t1', { list: () => ({ ok: false, code: 'core-error', exit: 1 }) }, 502, errorBody('core-error', 'list', 1)],
    ['/api/runs/s1/t1', { list: () => ({ ok: false, code: 'core-unreachable', exit: null }) }, 503, errorBody('core-unreachable', 'list')],
    ['/api/runs/s1/t1', { list: () => ok({ ...fixture('list'), v: 2 }) }, 502, errorBody('core-contract-mismatch', 'list', 0)],
    ['/api/runs', { list: () => ({ ok: false, code: 'core-error', exit: 1 }) }, 502, errorBody('core-error', 'list', 1)],
    ['/api/runs', { list: () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'usage' }) }, 502, errorBody('core-error', 'list', 1)],
    ['/api/runs', { list: () => ({ ok: false, code: 'core-error', exit: 2 }) }, 502, errorBody('core-error', 'list', 2)],
    ['/api/runs', { list: () => ok({ ...fixture('list'), v: 2 }) }, 502, errorBody('core-contract-mismatch', 'list', 0)],
    ['/api/info', { version: () => ({ ok: false, code: 'core-unreachable', exit: null }) }, 503, errorBody('core-unreachable', 'version')],
    ['/api/info', { capabilities: () => ({ ok: false, code: 'core-error', exit: 1 }) }, 502, errorBody('core-error', 'capabilities', 1)],
    ['/api/workflows', { workflow: (p: any) => (p.taskClass === 'review' ? { ok: false, code: 'core-error', exit: 2 } : ok(fixture('workflow'))) }, 502, errorBody('core-error', 'workflow', 2)],
  ];
  for (const [target, overrides, status, body] of cases) {
    const { json } = await harness(scripted(overrides), t);
    assert.deepEqual(await json(target), { status, body }, `${target} with ${Object.keys(overrides).join(', ')}`);
  }
});

test('GET /api/workflows: one projected workflow per registry class, in registry order', async (t) => {
  const runner = scripted({ workflow: (p: any) => ok({ ...fixture('workflow'), taskClass: p.taskClass }) });
  const { json } = await harness(runner, t);
  const reply = await json('/api/workflows');
  assert.equal(reply.status, 200);
  assert.deepEqual(Object.keys(reply.body), ['v', 'workflows']);
  assert.deepEqual(reply.body.workflows.map((w: any) => w.taskClass), TASK_CLASSES);
  assert.deepEqual(runner.calls.map((call) => call.params.taskClass), TASK_CLASSES);
});

test('TASK_CLASSES is the core registry class list, in order (the copy cannot drift)', () => {
  const { WorkflowEngine } = require('../../src/runtime/workflow-engine.ts');
  assert.deepEqual([...TASK_CLASSES], new WorkflowEngine({ repoRoot: path.resolve(__dirname, '..', '..') }).listClasses());
});

test('runner hook: a failed call keeps only the core\'s JSON `error` id, when it matches the IC-003 pattern', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-errorid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const core = (name: string, stdout: string, exit: number) => {
    const file = path.join(dir, `${name}.js`);
    fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = ${exit};\n`);
    return createVerbRunner({ corePath: file, projectRoot: dir, env: {} }).run('attempts', { slug: 's1' });
  };
  const message = `no plan.md under ${dir} ${MARKER}`;
  assert.deepEqual(await core('plan', JSON.stringify({ ok: false, error: 'plan-unreadable', message, problems: [MARKER] }), 2),
    { ok: false, code: 'core-error', exit: 2, errorId: 'plan-unreadable' });
  assert.deepEqual(await core('list', JSON.stringify({ v: 1, error: 'cannot-list-checkouts' }), 1), { ok: false, code: 'core-error', exit: 1, errorId: 'cannot-list-checkouts' });
  for (const [name, stdout] of [['path', JSON.stringify({ error: '../etc' })], ['text', JSON.stringify({ error: message })], ['number', JSON.stringify({ error: 7 })],
    ['array', JSON.stringify([{ error: 'usage' }])], ['prose', `[ERROR] ${message}`], ['none', '']]) {
    assert.deepEqual(await core(name, stdout, 2), { ok: false, code: 'core-error', exit: 2 }, name);
  }
});

// ---- IC-018 e: GET /api/sessions ----

const SECTIONS = ['observed', 'slots', 'runs', 'tasks', 'workers', 'roadmap'];
const liveRun = (taskId: string, slug: string | null, state = 'RUNNING') => ({ ...fixture('list').runs[0], taskId, featureSlug: slug, state });

test('GET /api/sessions: every section ok from its own reads; tasks per live feature, workers per active attempt', async (t) => {
  const runner = scripted();
  const { json } = await harness(runner, t);
  const reply = await json('/api/sessions');
  assert.equal(reply.status, 200);
  assert.deepEqual(Object.keys(reply.body), ['v', 'sections', 'limits']);
  assert.deepEqual(Object.keys(reply.body.sections), SECTIONS);
  for (const name of SECTIONS) assert.equal(reply.body.sections[name].ok, true, name);
  const { observed, slots, runs, tasks, workers, roadmap } = reply.body.sections;
  assert.equal(observed.data.checkouts[0].branch, '(withheld)');
  assert.deepEqual(slots.data.slots[0].holder, { label: 'npm test', since: '2026-10-26T09:00:00.000Z', alive: false, worktreeKey: KEY });
  assert.deepEqual(Object.keys(runs.data), ['v', 'runs', 'unreadableCount']);
  // The list fixture has one RUNNING run with a feature, one COMPLETED and one AWAITING_GATE without a feature.
  assert.deepEqual(runner.calls.filter((call) => call.shape === 'attempts').map((call) => call.params), [{ slug: '060-write-set-completeness' }]);
  assert.deepEqual(tasks.data.map((entry: any) => Object.keys(entry)), [['slug', 'revision', 'overlaps', 'active']]);
  assert.deepEqual(tasks.data[0].overlaps, [{ a: 'A.1', b: 'A.2', fileCount: 2 }]);
  assert.deepEqual(tasks.data[0].active.map((a: any) => [a.task, a.state, a.worktreeKey, a.run, a.lineage]), [['A.1', 'active', KEY, 'local', 'main']]);
  assert.deepEqual(runner.calls.filter((call) => call.shape === 'worker-status').map((call) => call.params),
    [{ slug: '060-write-set-completeness', task: 'A.1', token: String(tasks.data[0].active[0].token) }]);
  assert.deepEqual(workers.data, [{ slug: '060-write-set-completeness', task: 'A.1', token: tasks.data[0].active[0].token, worker: null }]);
  assert.deepEqual(roadmap.data, { run: null, lease: { runId: null, acquiredAt: '2026-10-26T08:00:00.000Z' }, holds: [] });
  assert.deepEqual(reply.body.limits, { runsInspected: 1, runsNotChecked: 0, workersChecked: 1, workersNotChecked: 0 });
});

test('GET /api/sessions: one failing section leaves the others ok; tasks and workers fail with the runs they are built from', async (t) => {
  const failure = (code: string, exit: number | null, errorId?: string) => (): Answer => ({ ok: false, code, exit, ...(errorId ? { errorId } : {}) });
  const cases: Array<[Record<string, (params: any) => Answer>, Record<string, string>]> = [
    [{ observed: failure('core-error', 1, 'cannot-list-checkouts') }, { observed: 'cannot-list-checkouts' }],
    [{ observed: () => ok({ ...SAMPLES.observed(), store: 'maybe' }) }, { observed: 'core-contract-mismatch' }],
    [{ slots: failure('core-error', 1) }, { slots: 'core-error' }],
    [{ slots: failure('core-unreachable', null) }, { slots: 'core-unreachable' }],
    [{ roadmap: failure('core-error', 1, 'cannot-read-facts') }, { roadmap: 'core-error' }],
    [{ roadmap: () => ok({ ...SAMPLES.roadmap(), holds: 'x' }) }, { roadmap: 'core-contract-mismatch' }],
    [{ list: failure('core-error', 1, 'cannot-list-checkouts') }, { runs: 'cannot-list-checkouts', tasks: 'cannot-list-checkouts', workers: 'cannot-list-checkouts' }],
    [{ list: () => ok({ ...fixture('list'), v: 2 }) }, { runs: 'core-contract-mismatch', tasks: 'core-contract-mismatch', workers: 'core-contract-mismatch' }],
    [{ attempts: failure('core-error', 2, 'store-unreadable') }, { tasks: 'core-error', workers: 'core-error' }],
    [{ attempts: () => ok({ ...fixture('attempts'), tasks: null }) }, { tasks: 'core-contract-mismatch', workers: 'core-contract-mismatch' }],
    [{ 'worker-status': failure('core-error', 2) }, { workers: 'core-error' }],
    [{ 'worker-status': () => ok({ ...SAMPLES['worker-status'](), disposition: 'refused' }) }, { workers: 'core-contract-mismatch' }],
  ];
  for (const [overrides, failed] of cases) {
    const { json } = await harness(scripted(overrides), t);
    const reply = await json('/api/sessions');
    const label = Object.keys(overrides).join(', ');
    assert.equal(reply.status, 200, label);
    for (const name of SECTIONS) {
      if (failed[name]) assert.deepEqual(reply.body.sections[name], { ok: false, code: failed[name] }, `${label}: ${name}`);
      else assert.equal(reply.body.sections[name].ok, true, `${label}: ${name} stays ok`);
    }
  }
});

test('GET /api/sessions: no roadmap (usage, exit 2) is roadmap null; a feature with no plan has no tasks entry', async (t) => {
  const runner = scripted({
    roadmap: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'usage' }),
    list: () => ok({ v: 1, unreadable: [], runs: [liveRun('r1', 'no-plan-yet'), liveRun('r2', '060-write-set-completeness', 'AWAITING_GATE')] }),
    attempts: (p: any) => (p.slug === 'no-plan-yet' ? { ok: false, code: 'core-error', exit: 2, errorId: 'plan-unreadable' } : ok(fixture('attempts'))),
  });
  const { json } = await harness(runner, t);
  const { sections, limits } = (await json('/api/sessions')).body;
  assert.deepEqual(sections.roadmap, { ok: true, data: null });
  assert.deepEqual(sections.tasks.data.map((entry: any) => entry.slug), ['060-write-set-completeness']);
  assert.deepEqual(limits, { runsInspected: 2, runsNotChecked: 0, workersChecked: 1, workersNotChecked: 0 });
});

test('GET /api/sessions: a malformed plan is skipped and its runs counted as not checked; any other failed inspect still fails tasks', async (t) => {
  const list = () => ok({ v: 1, unreadable: [], runs: [liveRun('r1', 'bad-plan'), liveRun('r2', 'bad-plan', 'AWAITING_GATE'), liveRun('r3', '060-write-set-completeness')] });
  const attempts = (errorId: string) => (p: any): Answer => (p.slug === 'bad-plan' ? { ok: false, code: 'core-error', exit: 2, errorId } : ok(fixture('attempts')));
  const skipped = await harness(scripted({ list, attempts: attempts('plan-malformed') }), t);
  const { sections, limits } = (await skipped.json('/api/sessions')).body;
  assert.equal(sections.tasks.ok, true);
  assert.deepEqual(sections.tasks.data.map((entry: any) => entry.slug), ['060-write-set-completeness']);
  assert.equal(sections.workers.ok, true);
  assert.deepEqual(limits, { runsInspected: 1, runsNotChecked: 2, workersChecked: 1, workersNotChecked: 0 });
  const failed = await harness(scripted({ list, attempts: attempts('store-unreadable') }), t);
  const reply = (await failed.json('/api/sessions')).body;
  assert.deepEqual(reply.sections.tasks, { ok: false, code: 'core-error' });
  assert.deepEqual(reply.sections.workers, { ok: false, code: 'core-error' });
});

test('GET /api/sessions: at most 20 inspects and 16 worker-status calls, the rest counted as not checked', async (t) => {
  // 25 live runs on 23 features (two share one), plus a completed run and a slug-less one, neither inspected.
  const runs = Array.from({ length: 23 }, (_, i) => liveRun(`r${i}`, `f${i}`, i % 2 ? 'AWAITING_GATE' : 'RUNNING'));
  runs.push(liveRun('r-again', 'f0'), liveRun('r-late', 'f22'), liveRun('r-done', 'f1', 'COMPLETED'), liveRun('r-flat', null));
  const oneActive = (slug: string) => {
    const body = fixture('attempts');
    body.tasks[0].attempts[0].token = Number(slug.slice(1)) + 1;
    return body;
  };
  const runner = scripted({ list: () => ok({ v: 1, unreadable: [], runs }), attempts: (p: any) => ok(oneActive(p.slug)) });
  const { json } = await harness(runner, t);
  const { sections, limits } = (await json('/api/sessions')).body;
  const inspected = runner.calls.filter((call) => call.shape === 'attempts').map((call) => call.params.slug);
  assert.deepEqual(inspected, Array.from({ length: 20 }, (_, i) => `f${i}`));
  // r0..r19 and r-again (f0) are covered; r20, r21, r22 and r-late (f22) are not.
  assert.deepEqual(limits, { runsInspected: 21, runsNotChecked: 4, workersChecked: 16, workersNotChecked: 4 });
  assert.equal(sections.tasks.data.length, 20);
  assert.equal(runner.calls.filter((call) => call.shape === 'worker-status').length, 16);
  assert.equal(sections.workers.data.length, 16);
  assert.deepEqual(sections.workers.data.map((w: any) => w.slug), Array.from({ length: 16 }, (_, i) => `f${i}`));
});

test('GET /api/sessions-history: returns 200 with projected body, supports query params and enforces validation', async (t) => {
  const sampleHistoryBody = {
    v: 1,
    window: { from: '2026-10-11T12:00:00.000Z', to: '2026-11-10T12:00:00.000Z', maxAgeDays: 30 },
    sessions: [
      {
        slug: 'test-slug',
        taskId: 'test-task',
        taskClass: 'feature',
        workflowName: 'Feature Delivery',
        harness: 'codex',
        state: 'COMPLETED',
        startedAt: '2026-11-09T08:00:00.000Z',
        endedAt: '2026-11-09T10:00:00.000Z',
        durationMs: 7200000,
        stages: [
          { id: 'discovery', name: 'Discovery', skill: 'do-brainstorm', status: 'completed', outcome: 'completed', durationMs: 1200000 },
        ],
        workers: { count: 2, attempts: 2, retries: 0, quotaStops: 0 },
        cost: {
          tokens: { input: null, output: null, total: null },
          models: ['codex-5'],
          telemetry: 'unknown',
        },
        expired: false,
        project: { anchor: '<project>', rel: '' },
      },
    ],
    limits: { shown: 1, notShown: 0, pruned: 0 },
  };

  const runner = scripted({
    'sessions-history': (p: any) => ok(sampleHistoryBody),
  });

  const { json } = await harness(runner, t);

  // Default call
  const reply = await json('/api/sessions-history');
  assert.equal(reply.status, 200);
  assert.equal(reply.body.v, 1);
  assert.equal(reply.body.sessions.length, 1);
  assert.equal(reply.body.sessions[0].slug, 'test-slug');
  assert.equal(reply.body.sessions[0].cost.telemetry, 'unknown');
  assert.equal(reply.body.sessions[0].cost.tokens.total, null);

  // Call with valid query params
  const replyQuery = await json('/api/sessions-history?days=14&limit=50');
  assert.equal(replyQuery.status, 200);
  const lastCall = runner.calls[runner.calls.length - 1];
  assert.equal(lastCall.shape, 'sessions-history');
  assert.deepEqual(lastCall.params, { days: '14', limit: '50' });

  // Invalid query: unknown parameter
  const replyBadQuery = await json('/api/sessions-history?unknown=1');
  assert.equal(replyBadQuery.status, 400);

  // Invalid days (over 90)
  const replyOverDays = await json('/api/sessions-history?days=999');
  assert.equal(replyOverDays.status, 400);

  // Invalid limit (over 500)
  const replyOverLimit = await json('/api/sessions-history?limit=600');
  assert.equal(replyOverLimit.status, 400);
});

// ---- 172 IC-005: GET /api/harness-login ----

const LOGIN_STATE = () => fixture('login-state');
const deviceInvoke = (routes: any[], cookie: string) => (path: string) => {
  const route = routes.find((item: any) => item.method === 'GET' && item.path === path);
  assert.ok(route, path);
  return route.handler({ req: { headers: { cookie }, url: path, socket: { remoteAddress: '192.168.1.40' } }, clientClass: 'browser', port: 4310, params: {}, pathname: path, webRoot: '/tmp', res: {} });
};

test('172: a view device reads GET /api/harness-login and is refused GET /api/start/options', async (t) => {
  const runner = scripted({ 'login-state': () => ok(LOGIN_STATE()) });
  const world = lanWorld(t);
  const routes = consoleRoutes(runner, world.auth);
  for (const scope of ['view', 'control'] as const) {
    const { cookie } = await world.pair(scope);
    const call = deviceInvoke(routes as any[], cookie);
    const reply = await call('/api/harness-login');
    assert.equal(reply.status, 200, scope);
    const body = JSON.parse(reply.body);
    assert.equal(body.v, 1);
    assert.deepEqual(body.harnesses.map((entry: any) => entry.harness), LOGIN_STATE().harnesses.map((entry: any) => entry.harness));
    assert.equal(body.harnesses[0].state, 'unknown');
    assert.equal(body.harnesses[0].reason, 'never-checked');
    assert.equal(body.harnesses[0].caveat, null);
  }
  const { cookie } = await world.pair('view');
  const refused = await deviceInvoke(routes as any[], cookie)('/api/start/options');
  assert.equal(refused.status, 403);
  assert.deepEqual(JSON.parse(refused.body), errorBody('phone-scope'));
  assert.ok(runner.calls.every((call) => call.shape === 'login-state'), 'the refused route ran no verb');
});

test('172: GET /api/harness-login runs the login-state shape once, with a query refused as usage, and a body the projector refuses is 502 core-contract-mismatch', async (t) => {
  const runner = scripted({ 'login-state': () => ok(LOGIN_STATE()) });
  const { json } = await harness(runner, t);
  const reply = await json('/api/harness-login');
  assert.equal(reply.status, 200);
  assert.equal(reply.body.harnesses.length, 7);
  assert.deepEqual(runner.calls, [{ shape: 'login-state', params: {} }]);
  assert.equal((await json('/api/harness-login?x=1')).status, 400);
  assert.equal(runner.calls.length, 1, 'a bad query runs no verb');

  const bad = LOGIN_STATE(); bad.harnesses[0].state = 'uncalibrated';
  const refused = await harness(scripted({ 'login-state': () => ok(bad) }), t);
  const mismatch = await refused.json('/api/harness-login');
  assert.equal(mismatch.status, 502);
  assert.deepEqual(mismatch.body, errorBody('core-contract-mismatch', 'login-state', 0));
});

test('172: an older core with no login-state verb is 501 core-lacks-verb, a core that cannot be reached is the IC-005 reply', async (t) => {
  const old = await harness(scripted({ 'login-state': () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'usage' }) }), t);
  const lacks = await old.json('/api/harness-login');
  assert.equal(lacks.status, 501);
  assert.deepEqual(lacks.body, errorBody('core-lacks-verb', 'login-state', null));
  const down = await harness(scripted({ 'login-state': () => ({ ok: false, code: 'core-unreachable', exit: null }) }), t);
  assert.equal((await down.json('/api/harness-login')).status, 503);
});

test('172: a body of 32 harnesses with every field at its limit is at most 40 KiB, and a reason, hint or caveat holding a path is withheld, not sent', async (t) => {
  // One answer as large as the core lets it be: every word field at its limit (reason 160, hint 120, caveat 160) and as many providers
  // as fit, the way login.ts `bounded` trims an answer to 1 KiB.
  const full = (n: number) => {
    const answer = {
      harness: `h${String(n).padStart(2, '0')}`.padEnd(12, 'x'), state: 'unknown', reason: 'r'.repeat(160), source: 'recipe', at: '2026-11-16T08:00:00.000Z',
      billing: { mode: 'subscription', billing: 'metered' }, providers: [] as any[],
      provider: 'p0qqqqqq', hint: 'h'.repeat(120), expirySeen: true, last: { state: 'logged-in', source: 'recipe', at: '2026-11-15T08:00:00.000Z' }, caveat: 'c'.repeat(160),
    };
    while (answer.providers.length < 8) {
      answer.providers.push({ id: `p${answer.providers.length}`.padEnd(8, 'q'), state: 'unknown', mode: 'api-key', reason: null });
      if (Buffer.byteLength(JSON.stringify(answer)) > 1024) { answer.providers.pop(); break; }
    }
    return answer;
  };
  assert.ok(full(0).providers.length >= 1 && Buffer.byteLength(JSON.stringify(full(0))) <= 1024, 'the fixture answer is within the 1 KiB the core bounds an answer to');
  const answers = Array.from({ length: 32 }, (_, i) => full(i));
  const { get } = await harness(scripted({ 'login-state': () => ok({ harnesses: answers }) }), t);
  const reply = await get('/api/harness-login');
  assert.equal(reply.status, 200);
  assert.ok(Buffer.byteLength(reply.body) <= 40 * 1024, `${Buffer.byteLength(reply.body)} bytes`);
  assert.equal(JSON.parse(reply.body).harnesses.length, 32);

  const pathy = full(0);
  Object.assign(pathy, { reason: 'failed at /opt/x/.config/h', hint: 'run ~/bin/h login', caveat: 'see C:\\tools\\h' });
  const withheld = await harness(scripted({ 'login-state': () => ok({ harnesses: [pathy] }) }), t);
  const body = (await withheld.json('/api/harness-login')).body.harnesses[0];
  assert.deepEqual([body.reason, body.hint, body.caveat], ['(withheld)', '(withheld)', '(withheld)']);
  assert.ok(!JSON.stringify(body).includes('/opt/x'));
});
