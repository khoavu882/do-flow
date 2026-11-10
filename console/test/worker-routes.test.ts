'use strict';

// 150 IC-012: the five GET routes under /api/worker-runs/:slug, over a real verb runner on the fake core
// (fixtures/fake-core.js modes `worker-reads` and `old-core`) where it can answer, and over an
// in-process stub for what it cannot (a `log-unreadable` page, a `worker` refusal, the transcript
// reads, the active attempts of the older-core fallback). Each case checks the status, the IC-005
// error body and which verbs ran.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createServer } = require('../src/server.ts');
const { consoleRoutes, workerAgentKey, workerRuns, SESSION_LIMITS } = require('../src/routes.ts');
const { createSessions, cookieName } = require('../src/session.ts');
const { createVerbRunner } = require('../src/verb-runner.ts');

const FAKE_CORE = path.join(__dirname, 'fixtures', 'fake-core.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'core');
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
/** The fake core's runs in mode `worker-reads`, and its planted process numbers. */
const RUN = 'w-1a2b3c4d5e6f';
const CHILD = 'w-0f0e0d0c0b0a';
const UNKNOWN = 'w-ffffffffffff';
const PLANTED = ['424242', '424243'];
const SLUG = 'feat-a';
const BASE = `/api/worker-runs/${SLUG}/${RUN}`;
const TARGETS = [`/api/worker-runs/${SLUG}`, `${BASE}/result`, `${BASE}/status`, `${BASE}/log?stream=out`, `${BASE}/transcript`];
const KEY_A = '0cc00ec6d2062bc0';
const KEY_B = '1dd11fd7e3173cd1';

const dirs: string[] = [];
const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-worker-routes-'));
dirs.push(webRoot);
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

type Reply = { status: number, headers: Record<string, string>, body: string };
type Answer = { ok: true, json: any, exit: 0 } | { ok: false, code: string, exit: number | null, errorId?: string, reason?: string };
type Runner = { run(shape: string, params?: any): Promise<any> };

const ok = (json: any): Answer => ({ ok: true, json, exit: 0 });
const errorBody = (code: string, verb: string | null = null, exit: number | null = null) => ({ error: { code, verb, exit } });

/** A real verb runner over fake-core.js in `mode`, stopped after the test. */
function fakeCore(mode: string, t: any): Runner {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-worker-project-'));
  dirs.push(made);
  const runner = createVerbRunner({ corePath: FAKE_CORE, projectRoot: fs.realpathSync(made), env: { FAKE_CORE_MODE: mode } });
  t.after(() => runner.stop());
  return runner;
}

/** Records every call; a shape in `overrides` is answered in process, every other one by `inner` (none: the test fails on it). */
function recording(inner: Runner | null, overrides: Record<string, (params: any) => Answer> = {}) {
  const calls: Array<{ shape: string, params: any }> = [];
  return {
    calls,
    run: async (shape: string, params: any) => {
      calls.push({ shape, params });
      if (Object.hasOwn(overrides, shape)) return overrides[shape](params);
      if (inner === null) throw new Error(`unexpected verb ${shape}`);
      return inner.run(shape, params);
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

/** A server over `runner` with one session of `scope`; `get` sends its cookie unless told not to. */
async function harness(runner: Runner, t: any, scope: 'read' | 'phone' = 'read') {
  const sessions = createSessions(scope === 'phone' ? { scope: 'phone' } : undefined);
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions) });
  t.after(() => app.close());
  const token = sessions.exchange(sessions.mintLaunchCode());
  const get = (target: string, cookie = true) => raw(app.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n`
    + `${cookie ? `Cookie: ${cookieName(app.port)}=${token}\r\n` : ''}Connection: close\r\n\r\n`);
  const json = async (target: string) => {
    const reply = await get(target);
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8', target);
    return { status: reply.status, body: JSON.parse(reply.body), text: reply.body };
  };
  return { get, json };
}

/** The core's `worker --action status` answer for an attempt's run, with the process numbers a body must never show. */
const statusOf = (runId: string, task: string, token: number, state = 'running') => ({
  disposition: 'status', runId, task, token, harness: 'codex', identity: null, state, reason: null,
  startedAt: '2026-11-08T05:00:01.000Z', endedAt: state === 'running' ? null : '2026-11-08T05:03:00.000Z', attemptActive: true,
  pid: 424242, pgid: 424243, process: null,
});

test('session: the five routes are 401 without the cookie, and no verb runs', async (t) => {
  const runner = recording(null);
  const { get } = await harness(runner, t);
  for (const target of TARGETS) {
    const reply = await get(target, false);
    assert.equal(reply.status, 401, target);
    assert.deepEqual(JSON.parse(reply.body), errorBody('unauthenticated'), target);
  }
  assert.deepEqual(runner.calls, []);
});

test('phone scope: the five routes are 403 phone-scope (PHONE_ROUTE_ALLOWLIST unchanged), and no verb runs', async (t) => {
  const runner = recording(null);
  const { json } = await harness(runner, t, 'phone');
  for (const target of TARGETS) assert.deepEqual(await json(target), { status: 403, body: errorBody('phone-scope'), text: JSON.stringify(errorBody('phone-scope')) }, target);
  assert.deepEqual(runner.calls, []);
});

test('params and query: each bad slug, run id or query is 400 usage on its routes before any verb runs', async (t) => {
  const runner = recording(null);
  const { json } = await harness(runner, t);
  const routes = (slug: string, runId: string) => [`/api/worker-runs/${slug}`, ...['result', 'status', 'log?stream=out', 'transcript'].map((tail) => `/api/worker-runs/${slug}/${runId}/${tail}`)];
  const targets: string[] = [];
  for (const slug of ['-x', '.hidden', '..', 'a%2Fb', 'a%20b', 'a;b', '%E2%80%AE']) targets.push(...routes(slug, RUN));
  for (const runId of ['w-1A2B3C4D5E6F', 'w-1a2b3c4d5e6', 'w-1a2b3c4d5e6f0', 'x-1a2b3c4d5e6f', 'w_1a2b3c4d5e6f', '%77-1a2b3c4d5e6f', 'w-1a2b3c4d5e6g']) {
    targets.push(...routes(SLUG, runId).slice(1));
  }
  // Any query on the four routes that take none, and an unknown or repeated name on the log route.
  targets.push(`/api/worker-runs/${SLUG}?x=1`, `/api/worker-runs/${SLUG}?slug=${SLUG}`, `${BASE}/result?x=1`, `${BASE}/status?stream=out`,
    `${BASE}/transcript?cursor=1:2:3:4`, `${BASE}/transcript?agent=${KEY_A}`, `${BASE}/log?stream=out&x=1`, `${BASE}/log?stream=out&stream=err`,
    `${BASE}/log?stream=out&cursor=1:2:3:4&cursor=1:2:3:5`);
  // The log query itself: stream required and out or err; at most one of cursor and before, each a cursor.
  targets.push(`${BASE}/log`, `${BASE}/log?cursor=1:2:3:4`, `${BASE}/log?stream=`, `${BASE}/log?stream=last`, `${BASE}/log?stream=OUT`,
    `${BASE}/log?stream=out&cursor=1:2:3:4&before=1:2:3:4`, `${BASE}/log?stream=out&cursor=1:2`, `${BASE}/log?stream=out&cursor=`,
    `${BASE}/log?stream=err&before=a:b:c:d`, `${BASE}/log?stream=err&before=1:2:3:4:5`);
  for (const target of targets) {
    const reply = await json(target);
    assert.equal(reply.status, 400, target);
    assert.deepEqual(reply.body, errorBody('usage'), target);
  }
  assert.deepEqual(runner.calls, []);
});

test('R-4, R-5: a slug the core\'s isSafeSlug refuses and a cursor past the core\'s digit bounds are 400 usage before any verb runs', async (t) => {
  const refused = (params: any): Answer => ({ ok: false, code: 'core-error', exit: 1, errorId: `seen-${params.slug}` });
  const runner = recording(null, { 'worker-runs': refused, 'worker-log': refused });
  const { json } = await harness(runner, t);
  const routes = (slug: string) => [`/api/worker-runs/${slug}`, ...['result', 'status', 'log?stream=out', 'transcript'].map((tail) => `/api/worker-runs/${slug}/${RUN}/${tail}`)];
  const targets: string[] = [];
  // PARAM_PATTERN accepts each of these; the core's isSafeSlug (src/runtime/task-scope.ts) refuses any `..`.
  for (const slug of ['a..b', 'a..', '1..2', 'x.y..z', 'a...b']) targets.push(...routes(slug));
  // The core's CURSOR (src/runtime/worker/reads.ts): ino 1-20 digits, offset, seq and ms 1-16 each.
  const over = [`${'1'.repeat(21)}:0:0:0`, `1:${'2'.repeat(17)}:0:0`, `1:2:${'3'.repeat(17)}:0`, `1:2:3:${'4'.repeat(17)}`];
  for (const cursor of over) targets.push(`${BASE}/log?stream=out&cursor=${cursor}`, `${BASE}/log?stream=err&before=${cursor}`);
  for (const target of targets) {
    const reply = await json(target);
    assert.deepEqual([reply.status, reply.body], [400, errorBody('usage')], target);
  }
  assert.deepEqual(runner.calls, []);
  // Controls: a slug with single dots and a cursor at every digit bound still reach the verb.
  const atBound = `${'9'.repeat(20)}:${'9'.repeat(16)}:${'9'.repeat(16)}:${'9'.repeat(16)}`;
  for (const target of ['/api/worker-runs/a.b-c_d', `/api/worker-runs/a.b/${RUN}/log?stream=out&cursor=${atBound}`, `${BASE}/log?stream=err&before=${atBound}`]) {
    assert.equal((await json(target)).status, 502, target);
  }
  assert.deepEqual(runner.calls, [
    { shape: 'worker-runs', params: { slug: 'a.b-c_d' } },
    { shape: 'worker-log', params: { slug: 'a.b', runId: RUN, stream: 'out', cursor: atBound } },
    { shape: 'worker-log', params: { slug: SLUG, runId: RUN, stream: 'err', before: atBound } },
  ]);
});

test('GET /api/worker-runs/:slug: the worker-runs list, ended and child runs included; worker-runs is the only verb', async (t) => {
  const runner = recording(fakeCore('worker-reads', t));
  const { json } = await harness(runner, t);
  const reply = await json(`/api/worker-runs/${SLUG}`);
  assert.equal(reply.status, 200);
  assert.deepEqual(Object.keys(reply.body), ['v', 'slug', 'source', 'store', 'runs', 'limits']);
  assert.deepEqual([reply.body.slug, reply.body.source, reply.body.store], [SLUG, 'worker-runs', 'present']);
  assert.deepEqual(reply.body.runs.map((r: any) => [r.runId, r.childOf, r.phase]), [[RUN, null, 'ended'], [CHILD, RUN, 'ended']]);
  assert.deepEqual(reply.body.limits, { shown: 2, notShown: 0, ended: 'listed' });
  assert.deepEqual(runner.calls, [{ shape: 'worker-runs', params: { slug: SLUG } }]);
});

test('GET .../result: the worker-result body; an unknown run is 404 unknown-run', async (t) => {
  const runner = recording(fakeCore('worker-reads', t));
  const { json } = await harness(runner, t);
  const reply = await json(`${BASE}/result`);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, {
    v: 1, runId: RUN, task: 'A.1', token: 1, harness: 'codex', phase: 'ended', endState: 'exited', endedAt: '2026-11-08T05:03:00.000Z',
    reportStatus: 'success', readOnly: 'clean', isolation: null, resultOffered: true, withheld: [], quota: null,
  });
  assert.deepEqual(await json(`/api/worker-runs/${SLUG}/${UNKNOWN}/result`), { status: 404, body: errorBody('unknown-run', 'worker-result', 1), text: JSON.stringify(errorBody('unknown-run', 'worker-result', 1)) });
  assert.deepEqual(runner.calls, [{ shape: 'worker-result', params: { slug: SLUG, runId: RUN } }, { shape: 'worker-result', params: { slug: SLUG, runId: UNKNOWN } }]);
});

test('GET .../status: worker-run-status through the widened projector, with no pid or pgid anywhere in the body; no run is 404 unknown-run', async (t) => {
  const runner = recording(fakeCore('worker-reads', t));
  const { json } = await harness(runner, t);
  const reply = await json(`${BASE}/status`);
  assert.equal(reply.status, 200);
  assert.deepEqual([reply.body.runId, reply.body.state, reply.body.deadline, reply.body.childOf], [RUN, 'exited', '2026-11-08T05:30:01.000Z', null]);
  assert.deepEqual([reply.body.process.kind, reply.body.process.code], ['exited', 0]);
  for (const planted of ['pid', 'pgid', ...PLANTED]) assert.ok(!reply.text.includes(planted), `${planted} reached the status body`);
  const child = await json(`/api/worker-runs/${SLUG}/${CHILD}/status`);
  assert.equal(child.body.childOf, RUN);
  // The real core refuses an unknown run id with exit 1 (src/runtime/worker/command.ts); a `run: null` answer names no run either.
  assert.deepEqual(runner.calls.map((call) => call.params), [{ slug: SLUG, runId: RUN }, { slug: SLUG, runId: CHILD }]);
  assert.ok(runner.calls.every((call) => call.shape === 'worker-run-status'));

  const refusing = recording(null, { 'worker-run-status': () => ({ ok: false, code: 'core-error', exit: 1 }) });
  const refused = await harness(refusing, t);
  assert.deepEqual((await refused.json(`${BASE}/status`)), { status: 404, body: errorBody('unknown-run', 'worker-run-status', 1), text: JSON.stringify(errorBody('unknown-run', 'worker-run-status', 1)) });
  const noRun = recording(null, { 'worker-run-status': () => ok({ disposition: 'status', run: null, task: 'A.1', token: 1 }) });
  assert.deepEqual((await (await harness(noRun, t)).json(`${BASE}/status`)).body, errorBody('unknown-run', 'worker-run-status', 0));
  // Control: any other failure keeps its IC-005 mapping.
  const usage = recording(null, { 'worker-run-status': () => ({ ok: false, code: 'core-error', exit: 2 }) });
  assert.deepEqual((await (await harness(usage, t)).json(`${BASE}/status`)).body, errorBody('core-error', 'worker-run-status', 2));
});

test('GET .../log: worker-log with the stream and the given cursor flag; an unknown run is 404 unknown-run', async (t) => {
  const runner = recording(fakeCore('worker-reads', t));
  const { json } = await harness(runner, t);
  const tail = await json(`${BASE}/log?stream=out`);
  assert.equal(tail.status, 200);
  assert.deepEqual([tail.body.runId, tail.body.stream, tail.body.log, tail.body.from, tail.body.pieces.length], [RUN, 'out', 'open', 0, 3]);
  assert.deepEqual(tail.body.pieces[1].cut, true);
  const forward = await json(`${BASE}/log?stream=out&cursor=8812345:10:0:1`);
  assert.deepEqual([forward.status, forward.body.from, forward.body.pieces.map((p: any) => p.at)], [200, 10, [10, 32768]]);
  const backward = await json(`${BASE}/log?before=8812345:10:0:1&stream=err`);
  assert.deepEqual([backward.status, backward.body.stream, backward.body.from], [200, 'err', 0]);
  assert.deepEqual(await json(`/api/worker-runs/${SLUG}/${UNKNOWN}/log?stream=out`), { status: 404, body: errorBody('unknown-run', 'worker-log', 1), text: JSON.stringify(errorBody('unknown-run', 'worker-log', 1)) });
  assert.deepEqual(runner.calls, [
    { shape: 'worker-log', params: { slug: SLUG, runId: RUN, stream: 'out' } },
    { shape: 'worker-log', params: { slug: SLUG, runId: RUN, stream: 'out', cursor: '8812345:10:0:1' } },
    { shape: 'worker-log', params: { slug: SLUG, runId: RUN, stream: 'err', before: '8812345:10:0:1' } },
    { shape: 'worker-log', params: { slug: SLUG, runId: UNKNOWN, stream: 'out' } },
  ]);
});

test('GET .../log: the core\'s log-unreadable (exit 1) is 502 core-error with the exit', async (t) => {
  const runner = recording(null, { 'worker-log': () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'log-unreadable' }) });
  const { json } = await harness(runner, t);
  const reply = await json(`${BASE}/log?stream=err`);
  assert.deepEqual([reply.status, reply.body], [502, errorBody('core-error', 'worker-log', 1)]);
  assert.equal(runner.calls.length, 1);
});

test('older core: result and log are 501 core-lacks-verb, and status too when --worker-run is an unknown flag; nothing is retried', async (t) => {
  const runner = recording(fakeCore('old-core', t));
  const { json } = await harness(runner, t);
  for (const [target, verb] of [[`${BASE}/result`, 'worker-result'], [`${BASE}/log?stream=out`, 'worker-log'], [`${BASE}/status`, 'worker-run-status']]) {
    const reply = await json(target);
    assert.deepEqual([reply.status, reply.body], [501, errorBody('core-lacks-verb', verb, null)], target);
  }
  assert.deepEqual(runner.calls.map((call) => call.shape), ['worker-result', 'worker-log', 'worker-run-status']);
});

test('older core: /api/worker-runs/:slug falls back to tasks and one worker-status per active attempt, ended runs not checked', async (t) => {
  const runner = recording(fakeCore('old-core', t), {
    attempts: () => ok(fixture('attempts')),
    'worker-status': (p: any) => ok(statusOf(RUN, p.task, Number(p.token))),
  });
  const { json } = await harness(runner, t);
  const reply = await json(`/api/worker-runs/${SLUG}`);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, {
    v: 1, slug: SLUG, source: 'active-attempts', store: 'present',
    runs: [{ runId: RUN, task: 'A.1', token: 1, harness: 'codex', childOf: null, phase: null, endState: null, createdAt: null,
      startedAt: '2026-11-08T05:00:01.000Z', endedAt: null, edit: null }],
    limits: { shown: 1, notShown: 0, ended: 'not-checked' },
  });
  for (const planted of PLANTED) assert.ok(!reply.text.includes(planted));
  assert.deepEqual(runner.calls, [
    { shape: 'worker-runs', params: { slug: SLUG } },
    { shape: 'attempts', params: { slug: SLUG } },
    { shape: 'worker-status', params: { slug: SLUG, task: 'A.1', token: '1' } },
  ]);
});

test('older-core fallback: at most SESSION_LIMITS.workers status reads, the rest notShown; an attempt with no run adds none; end state from the status', async (t) => {
  const many = fixture('attempts');
  const active = many.tasks[0];
  many.tasks = Array.from({ length: SESSION_LIMITS.workers + 2 }, (_, i) => ({ ...active, id: `T.${i}`, attempts: [{ ...active.attempts[0], token: i + 1 }] }));
  const runner = recording(null, {
    'worker-runs': () => ({ ok: false, code: 'core-error', exit: 1, reason: 'old-core' }),
    attempts: () => ok(many),
    'worker-status': (p: any) => (p.task === 'T.3' ? ok({ disposition: 'status', run: null, task: p.task, token: Number(p.token) })
      : ok(statusOf(`w-${Number(p.token).toString(16).padStart(12, '0')}`, p.task, Number(p.token), p.task === 'T.0' ? 'timed-out' : 'running'))),
  });
  const reply = JSON.parse((await workerRuns(runner, SLUG)).body);
  const reads = runner.calls.filter((call) => call.shape === 'worker-status');
  assert.equal(reads.length, SESSION_LIMITS.workers);
  assert.deepEqual(reads.map((call) => call.params.task), Array.from({ length: SESSION_LIMITS.workers }, (_, i) => `T.${i}`));
  assert.equal(reply.runs.length, SESSION_LIMITS.workers - 1);
  assert.ok(!reply.runs.some((r: any) => r.task === 'T.3'));
  assert.deepEqual(reply.limits, { shown: SESSION_LIMITS.workers - 1, notShown: 2, ended: 'not-checked' });
  assert.deepEqual([reply.runs[0].endState, reply.runs[0].endedAt, reply.runs[1].endState], ['timed-out', '2026-11-08T05:03:00.000Z', null]);
});

test('older-core fallback: no plan is an empty list; a failed fallback read is its IC-005 error; a worker-runs failure that is not old-core never falls back', async (t) => {
  const oldCore = (): Answer => ({ ok: false, code: 'core-error', exit: 1, reason: 'old-core' });
  const noPlan = recording(null, { 'worker-runs': oldCore, attempts: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'plan-unreadable' }) });
  const empty = await workerRuns(noPlan, SLUG);
  assert.equal(empty.status, 200);
  assert.deepEqual(JSON.parse(empty.body), { v: 1, slug: SLUG, source: 'active-attempts', store: 'present', runs: [], limits: { shown: 0, notShown: 0, ended: 'not-checked' } });

  const attemptsFail = recording(null, { 'worker-runs': oldCore, attempts: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'store-unreadable' }) });
  assert.deepEqual(JSON.parse((await workerRuns(attemptsFail, SLUG)).body), errorBody('core-error', 'attempts', 2));
  const statusFail = recording(null, { 'worker-runs': oldCore, attempts: () => ok(fixture('attempts')), 'worker-status': () => ({ ok: false, code: 'core-unreachable', exit: null }) });
  const unreachable = await workerRuns(statusFail, SLUG);
  assert.deepEqual([unreachable.status, JSON.parse(unreachable.body)], [503, errorBody('core-unreachable', 'worker-status', null)]);

  for (const failure of [{ ok: false, code: 'core-error', exit: 2, errorId: 'store-unreadable' }, { ok: false, code: 'core-error', exit: 1 }, { ok: false, code: 'core-unreachable', exit: null }] as Answer[]) {
    const runner = recording(null, { 'worker-runs': () => failure });
    const reply = await workerRuns(runner, SLUG);
    assert.notEqual(reply.status, 200, JSON.stringify(failure));
    assert.deepEqual(runner.calls.map((call) => call.shape), ['worker-runs'], JSON.stringify(failure));
  }
  // workerRuns checks the slug itself, as runDetail does, for the live hub that imports it.
  const guarded = recording(null);
  assert.deepEqual(JSON.parse((await workerRuns(guarded, '../x')).body), errorBody('usage'));
  assert.deepEqual(guarded.calls, []);
});

const TRANSCRIPT = (agentKey: string) => ({
  v: 1, agentKey, harness: 'codex', reader: { id: 'codex-rollout', status: 'supported' }, transcript: { linked: true, reason: null }, events: [],
  cursor: '0:0:0:0', reset: false, eof: true, otherRecords: 0, unparsable: 0, masked: 0, warnings: [],
});
const PROJECTS = (currentKey: string | null) => ({
  v: 1, store: 'present', truncated: false, excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 },
  projects: [KEY_A, KEY_B].map((projectKey) => ({ projectKey, label: projectKey, current: projectKey === currentKey, checkouts: 1, sources: ['hook-dirs'], lastRecordAt: null })),
});

test('workerAgentKey: sha256 of worker:<runId>, first 16 lowercase hex (the core\'s workerKey rule)', () => {
  assert.equal(workerAgentKey(RUN), crypto.createHash('sha256').update(`worker:${RUN}`).digest('hex').slice(0, 16));
  assert.match(workerAgentKey(CHILD), /^[0-9a-f]{16}$/);
  assert.notEqual(workerAgentKey(RUN), workerAgentKey(CHILD));
});

test('GET .../transcript: projects, then one transcript read in the current project under the run\'s agent key, no cursor, page 200', async (t) => {
  const runner = recording(null, { projects: () => ok(PROJECTS(KEY_B)), transcript: (p: any) => ok(TRANSCRIPT(p.agent)) });
  const { json } = await harness(runner, t);
  const reply = await json(`${BASE}/transcript`);
  assert.equal(reply.status, 200);
  assert.deepEqual([reply.body.agentKey, reply.body.reader, reply.body.eof], [workerAgentKey(RUN), { id: 'codex-rollout', status: 'supported' }, true]);
  assert.deepEqual(runner.calls, [
    { shape: 'projects', params: {} },
    { shape: 'transcript', params: { projectKey: KEY_B, agent: workerAgentKey(RUN), limit: '200' } },
  ]);
});

test('GET .../transcript: 404 agent-not-in-project passes through after one read; no current project is 404 project-not-found with no read', async (t) => {
  const missing = recording(null, { projects: () => ok(PROJECTS(KEY_A)), transcript: () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'agent-not-in-project' }) });
  const reply = await (await harness(missing, t)).json(`${BASE}/transcript`);
  assert.deepEqual([reply.status, reply.body], [404, errorBody('agent-not-in-project', 'transcript', 1)]);
  assert.equal(missing.calls.filter((call) => call.shape === 'transcript').length, 1);

  const none = recording(null, { projects: () => ok(PROJECTS(null)) });
  const noProject = await (await harness(none, t)).json(`${BASE}/transcript`);
  assert.deepEqual([noProject.status, noProject.body], [404, errorBody('project-not-found', 'projects', null)]);
  assert.deepEqual(none.calls.map((call) => call.shape), ['projects']);

  const listFail = recording(null, { projects: () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'cannot-list-projects' }) });
  const failed = await (await harness(listFail, t)).json(`${BASE}/transcript`);
  assert.deepEqual([failed.status, failed.body], [502, errorBody('cannot-list-projects', 'projects', 1)]);
});
