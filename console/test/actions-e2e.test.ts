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

const rid = () => crypto.randomBytes(16).toString('base64url');
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
  return { devices, server, post, list, ...scratch };
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

  const ran = l.lines().filter((line) => line.phase === 'begin' || line.phase === 'end' || line.phase === 'refused');
  assert.deepEqual(ran.map((line) => [line.phase, line.action, line.outcome, line.code ?? null, line.actor.deviceId]), [
    ['refused', 'decide-gate', 'refused', 'phone-scope', view.device.id],
    ['begin', 'decide-gate', null, null, control.device.id],
    ['end', 'decide-gate', 'applied', null, control.device.id],
    ['begin', 'decide-gate', null, null, control.device.id],
    ['end', 'decide-gate', 'refused', 'stale', control.device.id],
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

test('AC-8: an old core (exit 1, unknown flag on stderr, empty stdout) is 501 core-lacks-action on every action, writes nothing, and GET /api/actions then reports each action with core-lacks-action', { timeout: 180_000 }, async (t: any) => {
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
  assert.deepEqual(await listed(), [['decide-gate', true, null], ['close-run', true, null], ['cancel-worker', true, null]]);

  const gate = await l.post('decide-gate', gateBody(w, before.revision), control.bearer);
  assert.equal(gate.status, 501, gate.body);
  assert.equal(json(gate).error.code, 'core-lacks-action');
  assert.deepEqual(await listed(), [['decide-gate', false, 'core-lacks-action'], ['close-run', true, null], ['cancel-worker', true, null]]);
  const close = await l.post('close-run', closeBody(w, 1), control.bearer);
  assert.equal(close.status, 501, close.body);
  const cancel = await l.post('cancel-worker', { v: 1, requestId: rid(), projectKey: w.key, slug: GRAPH, runId: 'w-0123456789ab', reason: 'r' }, control.bearer);
  assert.equal(cancel.status, 501, cancel.body);
  assert.equal(json(cancel).error.code, 'core-lacks-action');
  assert.deepEqual(await listed(), [['decide-gate', false, 'core-lacks-action'], ['close-run', false, 'core-lacks-action'], ['cancel-worker', false, 'core-lacks-action']]);
  assert.deepEqual(snapshotTrees(w.roots), early, 'an old core wrote nothing');
  assert.equal(w.status(GRAPH, 'run-gate').revision, before.revision);
});
