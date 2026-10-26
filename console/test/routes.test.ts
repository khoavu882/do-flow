'use strict';

// IC-005 read routes over a scripted runner (feature 093, C.1). The runner answers from the real core
// outputs under fixtures/core/ (which carry the planted marker in every free-text field), so each case
// checks what the route does with a runner result: body shape, error code mapping, the session check,
// the parameter pattern, and that the only non-GET route is POST /api/session. The real core is
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
const { createVerbRunner } = require('../src/verb-runner.ts');

const FIXTURES = path.join(__dirname, 'fixtures', 'core');
const MARKER = 'ZZ-MARKER-7f3';
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
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

test('route table: frozen, every route GET but the one POST /api/session, and exactly the IC-005 read paths', () => {
  const routes = consoleRoutes(scripted(), createSessions());
  assert.ok(Object.isFrozen(routes) && routes.every((route: any) => Object.isFrozen(route)));
  assert.deepEqual(routes.filter((route: any) => route.method !== 'GET').map((route: any) => `${route.method} ${route.path}`), ['POST /api/session']);
  assert.deepEqual(routes.filter((route: any) => route.method === 'GET').map((route: any) => route.path).sort(),
    ['/*', '/api/info', '/api/runs', '/api/runs/:slug/:taskId', '/api/workflows', '/healthz']);
});

test('session: every read route is 401 without the cookie and no verb runs', async (t) => {
  const runner = scripted();
  const { get } = await harness(runner, t);
  for (const target of ['/api/info', '/api/runs', '/api/runs/s1/t1', '/api/workflows']) {
    const reply = await get(target, false);
    assert.equal(reply.status, 401, target);
    assert.deepEqual(JSON.parse(reply.body), errorBody('unauthenticated'), target);
  }
  assert.deepEqual(runner.calls, []);
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
  assert.deepEqual(runner.calls.map((call) => call.shape).sort(), ['attempts', 'status', 'timeline', 'workflow']);
  const params = Object.fromEntries(runner.calls.map((call) => [call.shape, call.params]));
  assert.deepEqual(params.status, { taskId: 't1', slug: '093-console-web-ui' });
  assert.deepEqual(params.timeline, { taskId: 't1', slug: '093-console-web-ui' });
  assert.deepEqual(params.attempts, { slug: '093-console-web-ui' });
  assert.deepEqual(params.workflow, { taskClass: 'feature' });
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

test('error mapping: runner and projector failures become the IC-005 codes with the shape id and exit', async (t) => {
  const cases: Array<[string, Record<string, (params: any) => Answer>, number, any]> = [
    ['/api/runs/s1/t1', { status: () => ({ ok: false, code: 'core-error', exit: 1 }) }, 404, errorBody('run-not-found', 'status', 1)],
    ['/api/runs/s1/t1', { timeline: () => ({ ok: false, code: 'core-error', exit: 1 }) }, 404, errorBody('run-not-found', 'timeline', 1)],
    ['/api/runs/s1/t1', { status: () => ({ ok: false, code: 'core-error', exit: 2 }) }, 502, errorBody('core-error', 'status', 2)],
    ['/api/runs/s1/t1', { status: () => ({ ok: false, code: 'core-unreachable', exit: null }) }, 503, errorBody('core-unreachable', 'status')],
    ['/api/runs/s1/t1', { status: () => ok({ ...fixture('status'), state: 'PAUSED' }) }, 502, errorBody('core-contract-mismatch', 'status', 0)],
    ['/api/runs/s1/t1', { status: () => ok({ ...fixture('status'), taskClass: '../x' }) }, 502, errorBody('core-contract-mismatch', 'status', 0)],
    ['/api/runs/s1/t1', { timeline: () => ok({ ...fixture('timeline'), v: 2 }) }, 502, errorBody('core-contract-mismatch', 'timeline', 0)],
    ['/api/runs/s1/t1', { attempts: () => ok({ ...fixture('attempts'), tasks: null }) }, 502, errorBody('core-contract-mismatch', 'attempts', 0)],
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 1 }) }, 502, errorBody('core-error', 'attempts', 1)],
    // Only the core's plan-unreadable id is "no plan": a malformed plan, an unreadable store or a bare exit 2 is an error.
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'plan-malformed' }) }, 502, errorBody('core-error', 'attempts', 2)],
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'store-unreadable' }) }, 502, errorBody('core-error', 'attempts', 2)],
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 2 }) }, 502, errorBody('core-error', 'attempts', 2)],
    ['/api/runs/s1/t1', { attempts: () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'plan-unreadable' }) }, 502, errorBody('core-error', 'attempts', 1)],
    ['/api/runs/s1/t1', { workflow: () => ({ ok: false, code: 'core-error', exit: null }) }, 502, errorBody('core-error', 'workflow')],
    ['/api/runs', { list: () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'cannot-list-checkouts' }) }, 502, errorBody('cannot-list-checkouts', 'list', 1)],
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
