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

test('route table: frozen, every route GET but the one POST /api/session, and exactly the IC-005 read paths', () => {
  const routes = consoleRoutes(scripted(), createSessions());
  assert.ok(Object.isFrozen(routes) && routes.every((route: any) => Object.isFrozen(route)));
  assert.deepEqual(routes.filter((route: any) => route.method !== 'GET').map((route: any) => `${route.method} ${route.path}`), ['POST /api/session']);
  assert.deepEqual(routes.filter((route: any) => route.method === 'GET').map((route: any) => route.path).sort(),
    ['/*', '/api/info', '/api/runs', '/api/runs/:slug/:taskId', '/api/sessions', '/api/workflows', '/healthz']);
});

test('session: every read route is 401 without the cookie and no verb runs', async (t) => {
  const runner = scripted();
  const { get } = await harness(runner, t);
  for (const target of ['/api/info', '/api/runs', '/api/runs/s1/t1', '/api/workflows', '/api/sessions']) {
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
    [{ attempts: failure('core-error', 2, 'plan-malformed') }, { tasks: 'core-error', workers: 'core-error' }],
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
