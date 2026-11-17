'use strict';

// The Console actions end to end on the REAL core (feature 162 T8; requirement AC-3, AC-4, AC-6, AC-8; design IC-002,
// IC-005). The route table is the real one (consoleRoutes + createActions) and the runner is the real verb runner over
// this checkout's bin/doflow.js, aimed at the two-project fixture of core-fixture.ts (the core's `fleet --action
// projects` run with an empty tempRoots, as read-contract.test.ts does). Everything lives under scratch directories:
// HOME and XDG_CONFIG_HOME are the fixture's, the device store and the action log are temp folders. A person's
// decision travels HTTP -> route -> runner.act -> the core, and what the core wrote is read back with the core's own
// verbs. A refused action (view scope, stale revision, old core) leaves the three state trees byte-identical.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { consoleRoutes } = require('../src/routes.ts');
const { createServer } = require('../src/server.ts');
const { createSessions, cookieName } = require('../src/session.ts');
const { createActions } = require('../src/actions.ts');
const { createActionLog } = require('../src/action-log.ts');
const { createVerbRunner } = require('../src/verb-runner.ts');
const { lanWorld, lanServer } = require('./helpers/lan-world.ts');
const { buildFleetWorld, snapshotTrees } = require('./helpers/core-fixture.ts');
const { buildWorkerWorld } = require('./helpers/worker-world.ts');
const processTree = require('../../src/runtime/worker/process-tree.ts');

const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-actions-e2e-'));
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

// A start-session id begins with a letter or digit (a CLI flag value cannot begin with `-`), so no id here begins with `-` or `_`.
const rid = () => `r${crypto.randomBytes(16).toString('base64url').slice(1)}`;
const json = (reply: { body: string }) => JSON.parse(reply.body);
const GRAPH = 'feat-graph';
const LEGACY = 'feat-legacy';

/** The fixture world and its two projects' keys, as the real core lists them. */
function world(t: any) {
  const w = buildFleetWorld((fn: () => void) => t.after(fn));
  const call = (args: string[], cwd: string = w.alpha, core: string = w.core) => {
    const result = spawnSync(process.execPath, [core, ...args, '--json'], { cwd, env: { ...w.env, DOFLOW_UPKEEP: 'off' }, encoding: 'utf8' });
    return { status: result.status, json: result.stdout.trim() ? JSON.parse(result.stdout) : null, stderr: result.stderr };
  };
  const projects = call(['fleet', '--action', 'projects']).json.projects;
  const key = projects.find((entry: any) => fs.realpathSync(entry.root) === w.alpha)?.projectKey;
  assert.match(key, /^[0-9a-f]{16}$/, 'the fixture project is listed by the core');
  const status = (slug: string, taskId: string) => call(['orchestrate', '--action', 'status', '--task-id', taskId, '--slug', slug]).json;
  const timeline = (slug: string, taskId: string) => call(['orchestrate', '--action', 'timeline', '--task-id', taskId, '--slug', slug]).json;
  return { ...w, call, key, status, timeline };
}

/** The action log over a scratch folder and its lines parsed. */
function scratchLog(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-e2e-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createActionLog({ dir });
  const lines = (): any[] => {
    const file = path.join(dir, 'actions.ndjson');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line)) : [];
  };
  return { log, lines };
}

/** The real LAN table over a scratch device store, the real runner (`corePath`) and a scratch log. */
async function lan(t: any, w: any, corePath: string = w.core) {
  const runner = createVerbRunner({ corePath, projectRoot: w.alpha, env: w.env });
  t.after(() => runner.stop());
  const devices = lanWorld(t);
  const scratch = scratchLog(t);
  const actions = createActions({ runner, log: scratch.log, warn: () => {} });
  t.after(() => actions.stop());
  const place = { projectRoot: w.alpha, home: w.home };
  const server = await lanServer(t, devices, consoleRoutes(runner, devices.auth, null, place, actions), webRoot);
  const post = (id: string, body: unknown, bearer: string) =>
    server.request('POST', `/api/actions/${id}`, { headers: { 'Content-Type': 'application/json', Authorization: bearer }, body: JSON.stringify(body) });
  const list = (bearer: string) => server.request('GET', '/api/actions', { headers: { Authorization: bearer } });
  return { devices, server, post, list, actions, ...scratch };
}

/** The real loopback table over a real launch-code session. */
async function loopback(t: any, w: any) {
  const runner = createVerbRunner({ corePath: w.core, projectRoot: w.alpha, env: w.env });
  t.after(() => runner.stop());
  const sessions = createSessions();
  const scratch = scratchLog(t);
  const actions = createActions({ runner, log: scratch.log, warn: () => {} });
  t.after(() => actions.stop());
  const place = { projectRoot: w.alpha, home: w.home };
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions, null, place, actions) });
  t.after(() => app.close());
  const cookie = `${cookieName(app.port)}=${sessions.exchange(sessions.mintLaunchCode())}`;
  const post = (id: string, payload: unknown): Promise<{ status: number, headers: Record<string, any>, body: string }> => new Promise((resolve, reject) => {
    const text = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: app.port, method: 'POST', path: `/api/actions/${id}`, agent: false,
      headers: { Host: `127.0.0.1:${app.port}`, Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'application/json', Cookie: cookie, 'Content-Length': String(Buffer.byteLength(text)), Connection: 'close' },
    }, (res: any) => {
      const chunks: any[] = [];
      res.on('data', (chunk: any) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(text);
  });
  return { post, ...scratch };
}

const gateBody = (w: any, revision: number, over: Record<string, unknown> = {}) => ({
  v: 1, requestId: rid(), projectKey: w.key, slug: GRAPH, taskId: 'run-gate', gateId: 'gate-0', decision: 'approve', note: null, expect: { revision }, ...over,
});
const closeBody = (w: any, revision: number, over: Record<string, unknown> = {}) => ({
  v: 1, requestId: rid(), projectKey: w.key, slug: LEGACY, taskId: 'run-live', note: 'work ended in PR 41', expect: { revision }, ...over,
});

test('decide-gate on the real core: a control device approves at the stream revision (200, the core records by device.d-...); the old revision is 409 stale with current and writes nothing; a view device is 403 and writes nothing', { timeout: 180_000 }, async (t: any) => {
  const w = world(t);
  const l = await lan(t, w);
  const view = await l.devices.pair('view', 'Viewer');
  const control = await l.devices.pair('control', 'Phone');
  const before = w.status(GRAPH, 'run-gate');
  assert.equal(before.state, 'AWAITING_GATE');
  assert.equal(before.awaitingGate.gateId, 'gate-0');
  assert.equal(json(await l.list(control.bearer)).project.projectKey, w.key, 'the Console\'s own project, as the real core lists it');

  const refusedView = await l.post('decide-gate', gateBody(w, before.revision), view.bearer);
  assert.equal(refusedView.status, 403);
  assert.deepEqual(json(refusedView), { error: { code: 'phone-scope', verb: null, exit: null } });

  const reply = await l.post('decide-gate', gateBody(w, before.revision), control.bearer);
  assert.equal(reply.status, 200, reply.body);
  const answer = json(reply);
  assert.deepEqual([answer.action, answer.outcome, answer.replayed, answer.by], ['decide-gate', 'applied', false, `device.${control.device.id}`]);
  assert.equal(answer.result.taskId, 'run-gate');
  assert.ok(answer.result.revision > before.revision, 'the run moved on');
  const decided = w.timeline(GRAPH, 'run-gate').events.filter((event: any) => event.action === 'decide-gate');
  assert.equal(decided.length, 1);
  assert.deepEqual([decided[0].decision, decided[0].by], ['approve', `device.${control.device.id}`]);
  assert.equal(w.status(GRAPH, 'run-gate').revision, answer.result.revision, 'the reply is the core\'s own state');

  const afterApply = snapshotTrees(w.roots);
  const stale = await l.post('decide-gate', gateBody(w, before.revision), control.bearer);
  assert.equal(stale.status, 409, stale.body);
  assert.equal(json(stale).error.code, 'stale');
  assert.deepEqual(json(stale).current.revision, answer.result.revision, 'current is the core\'s present state');
  assert.equal(typeof json(stale).current.state, 'string');
  assert.deepEqual(snapshotTrees(w.roots), afterApply, 'a stale attempt wrote nothing');
  assert.equal(w.timeline(GRAPH, 'run-gate').events.filter((event: any) => event.action === 'decide-gate').length, 1);

  await l.actions.stop();
  assert.deepEqual(l.lines().map((line) => [line.phase, line.action, line.outcome, line.code ?? null, line.actor.deviceId]), [
    ['begin', 'decide-gate', null, null, control.device.id],
    ['end', 'decide-gate', 'applied', null, control.device.id],
    ['begin', 'decide-gate', null, null, control.device.id],
    ['end', 'decide-gate', 'refused', 'stale', control.device.id],
    ['summary', 'decide-gate', 'refused', 'phone-scope', view.device.id],
  ]);
});

test('decide-gate through the loopback session records by console; a stale reject writes nothing', { timeout: 180_000 }, async (t: any) => {
  const w = world(t);
  const lb = await loopback(t, w);
  const before = w.status(GRAPH, 'run-gate');
  const early = snapshotTrees(w.roots);
  const wrong = await lb.post('decide-gate', gateBody(w, before.revision + 5, { decision: 'reject' }));
  assert.equal(wrong.status, 409, wrong.body);
  assert.equal(json(wrong).error.code, 'stale');
  assert.equal(json(wrong).current.revision, before.revision);
  assert.deepEqual(snapshotTrees(w.roots), early, 'a stale revision wrote nothing');

  const reply = await lb.post('decide-gate', gateBody(w, before.revision, { decision: 'reject', note: 'not this one' }));
  assert.equal(reply.status, 200, reply.body);
  assert.equal(json(reply).by, 'console');
  const decided = w.timeline(GRAPH, 'run-gate').events.filter((event: any) => event.action === 'decide-gate').at(-1);
  assert.deepEqual([decided.decision, decided.by], ['reject', 'console']);
  assert.deepEqual(lb.lines().filter((line) => line.phase === 'end').map((line) => [line.outcome, line.code ?? null]), [['refused', 'stale'], ['applied', null]]);
});

test('close-run on the real core: a control device closes at the current revision (200, by device.d-...); a wrong revision before and a repeat after are 409 stale and write nothing; a view device is 403 and writes nothing; the loopback session records console', { timeout: 180_000 }, async (t: any) => {
  const w = world(t);
  const l = await lan(t, w);
  const view = await l.devices.pair('view', 'Viewer');
  const control = await l.devices.pair('control', 'Phone');
  const lb = await loopback(t, w);
  const before = w.status(LEGACY, 'run-live');
  assert.equal(before.state, 'RUNNING');
  const early = snapshotTrees(w.roots);

  const refusedView = await l.post('close-run', closeBody(w, before.revision), view.bearer);
  assert.equal(refusedView.status, 403);
  assert.equal(json(refusedView).error.code, 'phone-scope');
  const wrong = await l.post('close-run', closeBody(w, before.revision + 3), control.bearer);
  assert.equal(wrong.status, 409, wrong.body);
  assert.equal(json(wrong).error.code, 'stale');
  assert.equal(json(wrong).current.revision, before.revision);
  assert.deepEqual(snapshotTrees(w.roots), early, 'a view device and a stale revision wrote nothing');

  const reply = await l.post('close-run', closeBody(w, before.revision), control.bearer);
  assert.equal(reply.status, 200, reply.body);
  assert.deepEqual([json(reply).outcome, json(reply).by], ['applied', `device.${control.device.id}`]);
  const closed = w.timeline(LEGACY, 'run-live').events.filter((event: any) => event.action === 'close-run');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].by, `device.${control.device.id}`);
  assert.equal(w.status(LEGACY, 'run-live').state, json(reply).result.state);

  const afterClose = snapshotTrees(w.roots);
  const again = await l.post('close-run', closeBody(w, before.revision), control.bearer);
  assert.equal(again.status, 409, again.body);
  assert.equal(json(again).error.code, 'stale');
  assert.equal(typeof json(again).current.state, 'string');
  assert.deepEqual(snapshotTrees(w.roots), afterClose, 'a repeat close wrote nothing');

  // The loopback session closes another run: the flat one has no slug.
  const flatRun = w.call(['orchestrate', '--action', 'status', '--task-id', 'run-flat']).json;
  const local = await lb.post('close-run', closeBody(w, flatRun.revision, { slug: null, taskId: 'run-flat' }));
  assert.equal(local.status, 200, local.body);
  assert.equal(json(local).by, 'console');
  const flatClosed = w.call(['orchestrate', '--action', 'timeline', '--task-id', 'run-flat']).json.events.filter((event: any) => event.action === 'close-run');
  assert.equal(flatClosed.at(-1).by, 'console');
});

test('162 finding: GET /api/runs right after an applied close-run shows the run closed at the new revision, not the cached list (the runner drops what the write may have changed)', { timeout: 180_000 }, async (t: any) => {
  const w = world(t);
  const l = await lan(t, w);
  const control = await l.devices.pair('control', 'Phone');
  const row = async () => (json(await l.server.request('GET', '/api/runs', { headers: { Authorization: control.bearer } })).runs as any[]).find((r) => r.featureSlug === LEGACY && r.taskId === 'run-live');
  const before = await row();
  assert.equal(before.state, 'RUNNING');
  assert.equal((await row()).revision, before.revision, 'the second read is the cached one');
  const reply = await l.post('close-run', closeBody(w, before.revision), control.bearer);
  assert.equal(reply.status, 200, reply.body);
  const after = await row();
  assert.notEqual(after.state, 'RUNNING', 'the list says what the action returned');
  assert.equal(after.state, json(reply).result.state);
  assert.ok(after.revision > before.revision);
});

/** A real process of its own group, standing in for a worker; its pid and start as the core records them. Stopped by `t.after`. */
function sleeper(t: any) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  t.after(() => {
    try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already ended */ }
    try { process.kill(child.pid as number, 'SIGKILL'); } catch { /* already ended */ }
  });
  return { child, gone, proc: { pid: child.pid as number, pgid: child.pid as number, start: processTree.procStart(child.pid) as string | null } };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('cancel-worker on the real core: a control device stops another lineage\'s running worker (200; the process ends; the run is cancelled with cancelBy device.d-... source operator); a second cancel is 409 stale with current.endState; a view device is 403 and writes nothing', { timeout: 180_000 }, async (t: any) => {
  const w = world(t);
  const l = await lan(t, w);
  const view = await l.devices.pair('view', 'Viewer');
  const control = await l.devices.pair('control', 'Phone');
  const worker = sleeper(t);
  assert.ok(worker.proc.start, 'the sleeper has a recorded start');
  const planted = buildWorkerWorld({
    projectRoot: w.alpha, slug: GRAPH, runningWorker: worker.proc,
    attempts: [
      { task: 'A.2', token: 2, state: 'active', runKey: 'other-lineage-key-7c1d' },
      { task: 'A.1', token: 1, state: 'finished' },
      { task: 'A.1', token: 2, state: 'released' },
    ],
  });
  const runId = planted.runs.running;
  const body = (over: Record<string, unknown> = {}) => ({ v: 1, requestId: rid(), projectKey: w.key, slug: GRAPH, runId, reason: 'stuck on a prompt', ...over });
  const early = snapshotTrees(w.roots);

  const refusedView = await l.post('cancel-worker', body(), view.bearer);
  assert.equal(refusedView.status, 403);
  assert.equal(json(refusedView).error.code, 'phone-scope');
  assert.deepEqual(snapshotTrees(w.roots), early, 'a view device wrote nothing');
  assert.ok(alive(worker.proc.pid), 'the worker still runs');

  const reply = await l.post('cancel-worker', body(), control.bearer);
  assert.equal(reply.status, 200, reply.body);
  const answer = json(reply);
  assert.deepEqual([answer.action, answer.outcome, answer.by, answer.result.runId, answer.result.endState], ['cancel-worker', 'applied', `device.${control.device.id}`, runId, 'cancelled']);
  await Promise.race([worker.gone, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  assert.equal(alive(worker.proc.pid), false, 'the worker process ended');
  const status = w.call(['worker', '--action', 'status', '--slug', GRAPH, '--worker-run', runId]).json;
  assert.equal(status.state, 'cancelled', JSON.stringify(status).slice(0, 400));
  assert.deepEqual([status.cancelBy.by, status.cancelBy.source], [`device.${control.device.id}`, 'operator']);

  const afterCancel = snapshotTrees(w.roots);
  const again = await l.post('cancel-worker', body(), control.bearer);
  assert.equal(again.status, 409, again.body);
  assert.equal(json(again).error.code, 'stale');
  assert.deepEqual(json(again).current, { state: 'ended', endState: 'cancelled' });
  assert.deepEqual(snapshotTrees(w.roots), afterCancel, 'a second cancel wrote nothing');
  assert.deepEqual(l.lines().filter((line) => line.phase === 'end').map((line) => [line.outcome, line.code ?? null]), [['applied', null], ['refused', 'stale']]);
});

test('AC-8: an old core (exit 1, unknown flag on stderr, empty stdout) is 501 core-lacks-action on every action (165: start-session too), writes nothing, and GET /api/actions then reports each action with core-lacks-action', { timeout: 180_000 }, async (t: any) => {
  const w = world(t);
  const oldCore = path.join(w.dir, 'old-core.js');
  fs.writeFileSync(oldCore, [
    "'use strict';",
    'const argv = process.argv.slice(2);',
    `if (argv[0] === 'fleet' && argv[1] === '--action' && argv[2] === 'projects') require(${JSON.stringify(w.core)});`,
    "else { process.stderr.write('unknown flag ' + (argv.find((part) => part.startsWith('--expect') || part === '--operator') || '--via') + '\\n'); process.exitCode = 1; }",
    '',
  ].join('\n'));
  const l = await lan(t, w, oldCore);
  const control = await l.devices.pair('control', 'Phone');
  const before = w.status(GRAPH, 'run-gate');
  const early = snapshotTrees(w.roots);
  const listed = async () => json(await l.list(control.bearer)).actions.map((row: any) => [row.id, row.allowed, row.reason]);
  // Seven actions: the three of 162, 165's start-session, and 170's session-send, session-steer and session-stop.
  const SESSION = [['session-send', true, null], ['session-steer', true, null], ['session-stop', true, null]];
  assert.deepEqual(await listed(), [['decide-gate', true, null], ['close-run', true, null], ['cancel-worker', true, null], ['start-session', true, null], ...SESSION]);

  const gate = await l.post('decide-gate', gateBody(w, before.revision), control.bearer);
  assert.equal(gate.status, 501, gate.body);
  assert.equal(json(gate).error.code, 'core-lacks-action');
  assert.deepEqual(await listed(), [['decide-gate', false, 'core-lacks-action'], ['close-run', true, null], ['cancel-worker', true, null], ['start-session', true, null], ...SESSION]);
  const close = await l.post('close-run', closeBody(w, 1), control.bearer);
  assert.equal(close.status, 501, close.body);
  const cancel = await l.post('cancel-worker', { v: 1, requestId: rid(), projectKey: w.key, slug: GRAPH, runId: 'w-0123456789ab', reason: 'r' }, control.bearer);
  assert.equal(cancel.status, 501, cancel.body);
  assert.equal(json(cancel).error.code, 'core-lacks-action');
  assert.deepEqual(await listed(), [['decide-gate', false, 'core-lacks-action'], ['close-run', false, 'core-lacks-action'], ['cancel-worker', false, 'core-lacks-action'], ['start-session', true, null], ...SESSION]);
  // 165 FR-016: a core without start-session is 501 core-lacks-action too, and nothing starts.
  const start = await l.post('start-session', { v: 1, requestId: rid(), projectKey: w.key, worktreeKey: '0123456789abcdef', harness: 'claude', model: null, provider: null, effort: null, entry: 'do', prompt: 'hello' }, control.bearer);
  assert.equal(start.status, 501, start.body);
  assert.equal(json(start).error.code, 'core-lacks-action');
  assert.equal(start.body.includes('hello'), false);
  assert.deepEqual((await listed()).find((row: any) => row[0] === 'start-session'), ['start-session', false, 'core-lacks-action']);
  // 170: a core without send, steer and stop is 501 core-lacks-action on each (R-5: none is counted against D11's six a minute); the message is in no reply.
  for (const id of ['session-send', 'session-steer', 'session-stop']) {
    const sessionBody = { v: 1, requestId: rid(), projectKey: w.key, runId: 'w-0123456789ab', ...(id === 'session-stop' ? {} : { message: 'hello again' }) };
    const reply = await l.post(id, sessionBody, control.bearer);
    assert.equal(reply.status, 501, `${id}: ${reply.body}`);
    assert.equal(json(reply).error.code, 'core-lacks-action', id);
    assert.equal(reply.body.includes('hello'), false, id);
  }
  assert.deepEqual((await listed()).slice(-3), [['session-send', false, 'core-lacks-action'], ['session-steer', false, 'core-lacks-action'], ['session-stop', false, 'core-lacks-action']]);
  assert.deepEqual(snapshotTrees(w.roots), early, 'an old core wrote nothing');
  assert.equal(w.status(GRAPH, 'run-gate').revision, before.revision);
});


// ---- 170 IC-005: a loopback send, steer and stop on the REAL core, the real supervisor and the fake channel harness ----
//
// A started channel session is seeded in a scratch project's store (as start-session records it) and supervised in this process,
// over `test/helper/fake-channel-harness.ts` linked into a scratch bin/ as `fake-pi`, on a PATH that holds that bin/ alone, so no real
// harness CLI can run. The Console's route table and verb runner are the real ones; the runner spawns `bin/doflow.js worker --action
// send | steer | stop` in the scratch project. Every process group the store names is killed in `after`.

const crypto2 = require('node:crypto');
const { superviseRun } = require('../../src/runtime/worker/supervisor.ts');
const { storeFileFor, newRunId, insertRun, readRuns } = require('../../src/runtime/worker/run-store.ts');
const { writePrompt } = require('../../src/runtime/worker/session-prompt.ts');
const { mainLaunchRecord } = require('../../src/runtime/worker/launch.ts');
const { workerCatalogue } = require('../../src/runtime/worker/catalogue.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { listCheckouts } = require('../../src/runtime/checkouts.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CORE_BIN = path.join(REPO, 'bin', 'doflow.js');
const FAKE_CHANNEL = path.join(REPO, 'test', 'helper', 'fake-channel-harness.ts');
const POSIX: any = { skip: process.platform === 'win32' && 'worker process control is unverified on win32' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CHANNEL = Object.freeze({
  status: 'supported', evidence: ['test'], verification: 'v', verifiedOn: '2026-11-17',
  argv: ['--mode', 'rpc', '--no-approve'], framing: 'jsonl-lf', parser: 'pi-json-v1', commandPrefix: '/',
  messages: {
    followUp: { type: 'prompt', message: '{text}', streamingBehavior: 'followUp', id: '{id}' },
    steer: { type: 'steer', message: '{text}', id: '{id}' },
    stop: { type: 'abort', id: '{id}' },
  },
  turn: { working: [{ path: ['type'], equals: 'agent_start' }], settled: [{ path: ['type'], equals: 'agent_end' }] },
  answer: {
    id: ['id'],
    accepted: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: true }],
    refused: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: false }],
  },
  close: { stdinEof: 'exits', graceSeconds: 3 },
  unverified: ['declared for the tests only'],
});

async function waitFor<T>(read: () => T, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A scratch project with a supervised channel session over the fake harness; its processes end after the test. */
async function channelWorld(t: any) {
  // Under the OS temp folder, not test/helper/tmp.ts's scratch root: the core's project listing leaves out scratch folders, and this world is listed.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-steer-e2e-')));
  const f: any = { dir, root: path.join(dir, 'proj'), bin: path.join(dir, 'bin'), log: path.join(dir, 'fake.log'), gate: path.join(dir, 'gate'), supervising: [] as Promise<any>[] };
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', f.root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  fs.mkdirSync(f.root);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.doflow/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  fs.mkdirSync(path.join(f.root, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(f.bin);
  fs.symlinkSync(FAKE_CHANNEL, path.join(f.bin, 'fake-pi'));
  fs.symlinkSync(process.execPath, path.join(f.bin, 'node'));
  const gitBinary = (process.env.PATH ?? '').split(path.delimiter).map((entry) => path.join(entry, 'git')).find((file) => fs.existsSync(file));
  assert.ok(gitBinary, 'git is on the PATH');
  fs.symlinkSync(gitBinary, path.join(f.bin, 'git'));
  fs.mkdirSync(path.join(dir, 'home', '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  // The project index primer of the start-session e2e: the project is listed because HOME names it.
  fs.writeFileSync(path.join(dir, 'home', '.doflow', 'state', 'upkeep-roots'), `${f.root}\n`);
  f.env = {
    HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'config'), TMPDIR: process.env.TMPDIR, PATH: f.bin,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off', FAKE_CHANNEL_LOG: f.log,
  };
  f.file = storeFileFor(f.root, 'started-sessions');
  f.key = cwdHash(listCheckouts({ cwd: f.root }).main);
  t.after(async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) { try { fs.writeFileSync(`${f.gate}-${n}`, ''); } catch { /* gone */ } }
    let runs: any = {};
    try { runs = readRuns(f.file); } catch { runs = {}; }
    for (const run of Object.values(runs) as any[]) {
      for (const proc of [run.worker, run.supervisor]) {
        if (proc && Number.isInteger(proc.pid) && proc.pid !== process.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    for (const done of f.supervising) await Promise.race([done.catch(() => null), sleep(5000)]);
  });
  // After the kill above (hooks run in the order they are registered): the store it reads lives in `dir`.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = loadRegistry({ repoRoot: REPO });
  const pi = workerCatalogue({ registry }).find((entry: any) => entry.id === 'pi').worker;
  const runId = newRunId();
  const descriptor: any = { ...structuredClone(pi), cli: { binary: path.join(f.bin, 'fake-pi') }, controlChannel: structuredClone(CHANNEL) };
  const first = 'first prompt';
  writePrompt(f.root, runId, first, { isEnded: () => false });
  const inserted = insertRun(f.file, {
    runId, kind: 'main-session', task: 'main-session', token: 1, request: `r${crypto2.randomBytes(16).toString('base64url').slice(1)}`, childOf: null, harness: 'pi', phase: 'starting',
    createdAt: new Date().toISOString(), timeoutSeconds: 600, startedBy: 'console', project: { projectKey: f.key, worktreeKey: 'b'.repeat(16) },
    execWorktree: f.root, entry: 'none', binding: null,
    prompt: { store: 'session-prompts', name: `${runId}.prompt.txt`, sha256: crypto2.createHash('sha256').update(first, 'utf8').digest('hex'), bytes: Buffer.byteLength(first) },
    ...mainLaunchRecord(descriptor, first, null, true),
    descriptor,
  });
  assert.equal(inserted.applied, true);
  f.runId = runId;
  f.supervising.push(superviseRun({ file: f.file, runId, env: { ...f.env, FAKE_CHANNEL_GATE: f.gate }, cwd: f.root, channel: { pollMs: 20 } }));
  const run = () => readRuns(f.file)[runId];
  await waitFor(() => run()?.channel?.state === 'open' && run().channel.turn.state === 'working', 'the first turn working');
  f.run = run;
  f.records = (): string[] => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').split(/(?<=\n)/).filter(Boolean) : []);
  return f;
}

test('170 a loopback send, steer and stop reach a session through the real core, supervisor and the fake channel harness; the reply is the IC-001 projection, refusals carry their status, and no message text is logged', { ...POSIX, timeout: 120_000 }, async (t: any) => {
  const f = await channelWorld(t);
  const runner = createVerbRunner({ corePath: CORE_BIN, projectRoot: f.root, env: f.env });
  t.after(() => runner.stop());
  assert.equal((await runner.run('projects', {})).ok, true);
  const sessions = createSessions();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-steer-e2e-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createActionLog({ dir });
  const actions = createActions({ runner, log, warn: () => {} });
  t.after(() => actions.stop());
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions, null, { projectRoot: f.root, home: f.env.HOME }, actions) });
  t.after(() => app.close());
  const cookie = `${cookieName(app.port)}=${sessions.exchange(sessions.mintLaunchCode())}`;
  const post = (id: string, payload: unknown): Promise<{ status: number, headers: Record<string, any>, body: string }> => new Promise((resolve, reject) => {
    const text = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: app.port, method: 'POST', path: `/api/actions/${id}`, agent: false,
      headers: { Host: `127.0.0.1:${app.port}`, Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'application/json', Cookie: cookie, 'Content-Length': String(Buffer.byteLength(text)), Connection: 'close' },
    }, (res: any) => {
      const chunks: any[] = [];
      res.on('data', (chunk: any) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(text);
  });
  const body = (over: Record<string, unknown> = {}) => ({ v: 1, requestId: rid(), projectKey: f.key, runId: f.runId, ...over });
  const SECRET = `SECRET-${crypto2.randomBytes(5).toString('hex')}`;

  // The turn is working: a steer is written and the harness answers it.
  const steerBody = body({ message: `change course ${SECRET}` });
  const steered = await post('session-steer', steerBody);
  assert.equal(steered.status, 200, steered.body);
  const steer = json(steered);
  assert.deepEqual([steer.action, steer.outcome, steer.by, steer.replayed], ['session-steer', 'applied', 'console', false]);
  // The fake answers its records in order, so the steer's answer waits for the gated first turn: the reply is `written` with no answer yet, and the ledger gets it once the turn ends.
  assert.deepEqual([steer.result.replayed, steer.result.channel, steer.result.message.kind, steer.result.message.state, steer.result.message.bytes],
    [false, 'open', 'steer', 'written', Buffer.byteLength(`change course ${SECRET}`)]);
  assert.ok([null, 'accepted'].includes(steer.result.message.answer), String(steer.result.message.answer));
  assert.equal(steer.result.turn.observed, true);
  assert.equal(f.records()[1], `${JSON.stringify({ ...CHANNEL.messages.steer, message: `change course ${SECRET}`, id: 'd-2' })}\n`, 'the harness read the steer byte-exact');

  // Let the turn settle: a steer needs a turn in progress (409 not-working, with the turn), a follow-up goes through.
  fs.writeFileSync(`${f.gate}-1`, '');
  fs.writeFileSync(`${f.gate}-2`, '');
  await waitFor(() => f.run().channel.turn.state === 'waiting', 'the turn waiting');
  await waitFor(() => f.run().channel.ledger.find((entry: any) => entry.requestId === steerBody.requestId)?.answer === 'accepted', 'the harness accepted the steer');
  const notWorking = await post('session-steer', body({ message: 'too late' }));
  assert.equal(notWorking.status, 409, notWorking.body);
  assert.equal(json(notWorking).error.code, 'not-working');
  assert.equal(json(notWorking).current.turn.state, 'waiting');
  const sentBody = body({ message: `and then this ${SECRET}` });
  const sent = await post('session-send', sentBody);
  assert.equal(sent.status, 200, sent.body);
  assert.deepEqual([json(sent).result.message.kind, json(sent).result.message.state], ['follow-up', 'written']);
  // The same request id again is the core's replay: nothing more reaches the harness.
  const records = f.records().length;
  const again = await post('session-send', sentBody);
  assert.equal(again.status, 200);
  assert.equal(json(again).replayed, true, 'the Console\'s memo answers a duplicate');
  assert.equal(f.records().length, records);

  // A stop ends the turn; failure cases map to their statuses and never reach the harness.
  await waitFor(() => f.run().channel.turn.state === 'working', 'working again');
  const stopped = await post('session-stop', body());
  assert.equal(stopped.status, 200, stopped.body);
  assert.deepEqual([json(stopped).result.message.kind, json(stopped).result.message.state, json(stopped).result.message.bytes], ['stop', 'written', 0]);
  const unknown = await post('session-send', body({ runId: 'w-000000000000', message: 'hello' }));
  assert.equal(unknown.status, 404, unknown.body);
  assert.equal(json(unknown).error.code, 'unknown-run');
  const command = await post('session-send', body({ message: '/quit now' }));
  assert.equal(command.status, 400, command.body);
  assert.equal(json(command).error.code, 'command-not-allowed');
  const empty = await post('session-send', body({ message: '  ' }));
  assert.equal(empty.status, 400, empty.body);
  assert.equal(json(empty).error.code, 'prompt-empty');
  const wrongProject = await post('session-stop', body({ projectKey: '0123456789abcdef' }));
  assert.equal(wrongProject.status, 404, wrongProject.body);
  assert.equal(json(wrongProject).error.code, 'project-not-found');
  // R-5: nine attempts of one actor in one minute, and the Console's own windows (six a minute) refused none of them.
  assert.equal([steered, notWorking, sent, again, stopped, unknown, command, empty, wrongProject].some((reply) => reply.status === 429), false);

  // The action log names the run and holds no message text; no reply holds it either.
  const lines = fs.readFileSync(path.join(dir, 'actions.ndjson'), 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
  const ends = lines.filter((line: any) => line.phase === 'end' && line.action.startsWith('session-'));
  assert.deepEqual(ends.map((line: any) => [line.action, line.outcome, line.target.runId]), [
    ['session-steer', 'applied', f.runId], ['session-steer', 'refused', f.runId], ['session-send', 'applied', f.runId], ['session-send', 'replayed', f.runId],
    ['session-stop', 'applied', f.runId], ['session-send', 'refused', 'w-000000000000'], ['session-send', 'refused', f.runId], ['session-stop', 'refused', f.runId]]);
  const logged = fs.readFileSync(path.join(dir, 'actions.ndjson'), 'utf8');
  for (const word of [SECRET, 'change course', 'and then this', 'too late']) {
    assert.equal(logged.includes(word), false, `${word} is not logged`);
    for (const reply of [steered, notWorking, sent, again, stopped]) assert.equal(reply.body.includes(word), false, `${word} is in no reply`);
  }
});
