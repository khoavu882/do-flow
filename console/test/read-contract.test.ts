'use strict';

// Read contract against the REAL core (feature 093, C.1 and E.6; IC-002, IC-004, IC-005, IC-012,
// IC-013, IC-018; FR-003, FR-016, NFR-003). bin/doflow-ui.js is booted as a child against this checkout's bin/doflow.js on a
// fixture made with real verbs (helpers/core-fixture.ts). The test reads the URL line, exchanges the
// launch code, reads every route, checks the bodies, checks that no planted free text and no path
// reaches any of them, shuts the Console down with a signal, and compares the DoFlow trees byte for
// byte (file list, contents, mtime, inode) with their state before boot.
//
// V.7 adds the Fleet shapes (IC-024, IC-026): the runner and the projectors, with no route yet (V.8), run against the real
// core over two projects; see the last test of this file for what its fixture is.
//
// Feature 149 B.6 (IC-007, IC-011, IC-012, IC-023; FR-015, NFR-007) adds GET /api/live to the first test: the
// `now`, `run:`, `tasks:` and `worker:` channels from the real core's `events --follow`, with a worker run record
// holding a planted secret, email, IP and absolute path; each channel's snapshot equals its GET replies, no
// planted text reaches a frame, and every tree is unchanged after the connection closed and the Console shut down.
//
// Feature 150 B.6 (IC-012, IC-013, IC-014, IC-021, IC-022; FR-018, FR-020, NFR-007; plan D7, RK8, RK10) replaces that
// one hand-written record with the shared worker world (helpers/worker-world.ts): every run's five worker routes, each
// body equal to its projector over the core verb's own output; `/api/live` on `tasks:`, `worker:` and the running run's
// `:out` and `:err` lanes while lines are appended, a second connection resuming the lanes from log positions; no
// planted value, pid, prompt, `.last.log` text or path in any body or frame; `workerAgentKey` equal to the agent key
// of the core's `fleet --action tree` for every run; the four new shapes on the allow-list. The tree comparison of
// that boot is taken after the world is planted and before the Console starts; the two files the test appends to
// must afterwards hold exactly their old bytes followed by the appended ones (same inode, only their mtime and
// digest moved), and every other entry must be unchanged.
//
// Vacuity guard: the same boot and reads (the live route included) with DOFLOW_UPKEEP=off taken out of every core child's
// environment must change a tree, or the fixture proves nothing and the test fails. The switch is
// removed by a test-only preload (helpers/drop-upkeep-switch.ts) given on the Console's own node command
// line; the shipped code has no way to turn it off, and no HTTP request can load a preload.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { CORE_CLI, FLEET_FORBIDDEN, MARKER, SLUGS, TREE_IDS, buildFixture, buildFleetWorld, snapshotTrees } = require('./helpers/core-fixture.ts');
const { buildWorkerWorld } = require('./helpers/worker-world.ts');
const { SHAPES, SHAPE_IDS, createVerbRunner, fleetError } = require('../src/verb-runner.ts');
const { CLOSED_SETS, project } = require('../src/project.ts');
const { workerAgentKey } = require('../src/routes.ts');
const crypto = require('node:crypto');

const BIN = path.join(__dirname, '..', 'bin', 'doflow-ui.js');
const PRELOAD = path.join(__dirname, 'helpers', 'drop-upkeep-switch.ts');
const URL_LINE = /^doflow ui: http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]{64})\n$/;
const BOOT_MS = 20_000;

type Booted = { child: any, port: number, code: string, stdout: () => string, stderr: () => string, exit: Promise<{ code: number | null, ms: number }> };

/** Boots the Console; resolves once the URL line is out. */
function boot(args: string[], env: Record<string, string>, cwd: string, preload = false): Promise<Booted> {
  const child = spawn(process.execPath, [...(preload ? ['--require', PRELOAD] : []), BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let signalledAt = 0;
  const exit = new Promise<{ code: number | null, ms: number }>((resolve) => child.on('exit', (code: number | null) => resolve({ code, ms: Date.now() - signalledAt })));
  const originalKill = child.kill.bind(child);
  child.kill = (signal: string) => {
    signalledAt = Date.now();
    return originalKill(signal);
  };
  child.stderr.on('data', (chunk: any) => { err += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no URL line within ${BOOT_MS} ms; stdout ${JSON.stringify(out)} stderr ${JSON.stringify(err)}`));
    }, BOOT_MS);
    child.stdout.on('data', (chunk: any) => {
      out += chunk;
      const match = URL_LINE.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]), code: match[2], stdout: () => out, stderr: () => err, exit });
      }
    });
    exit.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`doflow-ui exited ${code} before its URL line; stderr ${JSON.stringify(err)}`));
    });
  });
}

type Reply = { status: number, headers: Record<string, any>, body: string };

function request(port: number, method: string, target: string, headers: Record<string, string> = {}, body = ''): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { Connection: 'close', ...headers } }, (res: any) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Exchanges the launch code; returns the session cookie (`name=value`). */
async function exchange(app: Booted): Promise<string> {
  const own = `http://127.0.0.1:${app.port}`;
  const reply = await request(app.port, 'POST', '/api/session', { Origin: own, 'Content-Type': 'application/json' }, JSON.stringify({ code: app.code }));
  assert.equal(reply.status, 204, `exchange: ${reply.body}`);
  return String(reply.headers['set-cookie']).split(';')[0];
}

/** Exchanges the launch code (unless a cookie is given), then reads every route the views use. Returns each reply by target. */
async function readEverything(app: Booted, session?: string): Promise<Map<string, Reply>> {
  const cookie = session ?? await exchange(app);
  const replies = new Map<string, Reply>();
  const get = async (target: string) => {
    const reply = await request(app.port, 'GET', target, { Cookie: cookie });
    replies.set(target, reply);
    return reply;
  };
  await get('/healthz');
  await get('/');
  await get('/api/info');
  const runs = await get('/api/runs');
  assert.equal(runs.status, 200, runs.body);
  for (const row of JSON.parse(runs.body).runs) {
    if (row.featureSlug !== null) await get(`/api/runs/${row.featureSlug}/${row.taskId}`);
  }
  await get('/api/workflows');
  await get('/api/sessions');
  await get(`/api/runs/${SLUGS.graph}/no-such-run`);
  await get('/api/runs/..%2f/run-gate');
  return replies;
}

/** SIGTERM, then the exit: 0 within 2 s. */
async function shutdown(app: Booted, signal = 'SIGTERM') {
  app.child.kill(signal);
  const { code, ms } = await app.exit;
  assert.equal(code, 0, `exit after ${signal}; stderr ${app.stderr()}`);
  assert.ok(ms < 2_000, `shut down in ${ms} ms`);
}

const body = (replies: Map<string, Reply>, target: string) => {
  const reply = replies.get(target);
  assert.ok(reply, `${target} was read`);
  return JSON.parse(reply!.body);
};

// ---- Feature 149 B.6: GET /api/live against the real core (IC-007, IC-011, IC-012, IC-023 row for this file) ----

type LiveRead = { status: number, headers: Record<string, any>, text: string, frames: any[] };

/** The complete SSE messages of `text` that carry data, as their parsed envelopes. */
function liveFrames(text: string): any[] {
  return text.split('\n\n').slice(0, -1)
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice(6)));
}

const hasSnapshot = (frames: any[], channel: string) => frames.some((frame) => frame.ch === channel && frame.type === 'snapshot');

/**
 * Opens `GET /api/live` on `channels` with the session cookie, reads until every channel has had a
 * snapshot (or `ms` passed), then closes the connection and resolves once its response closed.
 */
function readLive(port: number, cookie: string, channels: string[], ms = 30_000): Promise<LiveRead> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/api/live?ch=${channels.join(',')}`, agent: false, headers: { Cookie: cookie } }, (res: any) => {
      let text = '';
      const timer = setTimeout(() => req.destroy(), ms);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        const frames = liveFrames(text);
        if (channels.every((channel) => hasSnapshot(frames, channel))) req.destroy();
      });
      res.on('error', () => {});
      res.on('close', () => {
        clearTimeout(timer);
        settled = true;
        resolve({ status: res.statusCode, headers: res.headers, text, frames: liveFrames(text) });
      });
    });
    req.on('error', (error: any) => { if (!settled && error.code !== 'ECONNRESET') reject(error); });
    req.end();
  });
}

// ---- Feature 150 B.6: the worker world, its routes and log lanes against the real core ----

type LiveMessage = { id: string | null, frame: any };
type LiveConnection = {
  status: number, headers: Record<string, any>, text: () => string, messages: () => LiveMessage[],
  /** Resolves true once `done(frames)` holds, false after `ms` or once the response closed without it. */
  until: (done: (frames: any[]) => boolean, ms?: number) => Promise<boolean>,
  close: () => Promise<void>,
};

/** The complete SSE messages of `text` that carry data, with the `id:` line of each (null when it has none). */
function liveMessages(text: string): LiveMessage[] {
  const messages: LiveMessage[] = [];
  for (const block of text.split('\n\n').slice(0, -1)) {
    const lines = block.split('\n');
    const data = lines.find((line) => line.startsWith('data: '));
    const id = lines.find((line) => line.startsWith('id: '));
    if (data !== undefined) messages.push({ id: id === undefined ? null : id.slice(4), frame: JSON.parse(data.slice(6)) });
  }
  return messages;
}

/** Opens `GET /api/live` on `channels` (and `since`, when given) and resolves once the response head arrived; the connection stays open until `close`. */
function openLive(port: number, cookie: string, channels: string[], since?: string): Promise<LiveConnection> {
  const query = `ch=${channels.join(',')}${since === undefined ? '' : `&since=${encodeURIComponent(since)}`}`;
  return new Promise((resolve, reject) => {
    let opened = false;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/api/live?${query}`, agent: false, headers: { Cookie: cookie } }, (res: any) => {
      opened = true;
      let text = '';
      let ended = false;
      const waiters = new Set<() => void>();
      const wake = () => { for (const waiter of [...waiters]) waiter(); };
      const closed = new Promise<void>((done) => res.on('close', () => { ended = true; wake(); done(); }));
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; wake(); });
      res.on('error', () => {});
      resolve({
        status: res.statusCode,
        headers: res.headers,
        text: () => text,
        messages: () => liveMessages(text),
        until: (done, ms = 30_000) => new Promise((settle) => {
          let timer: any = null;
          const finish = (value: boolean) => { clearTimeout(timer); waiters.delete(check); settle(value); };
          function check() {
            if (done(liveMessages(text).map((message) => message.frame))) finish(true);
            else if (ended) finish(false);
          }
          timer = setTimeout(() => finish(false), ms);
          waiters.add(check);
          check();
        }),
        close: () => { req.destroy(); return closed; },
      });
    });
    req.on('error', (error: any) => { if (!opened) reject(error); });
    req.end();
  });
}

/** The core's own `--json` output of `argv`, spawned with `env` in `cwd`: `{exit, json}`. */
function coreJson(cwd: string, env: Record<string, string>, argv: string[]): Promise<{ exit: number | null, json: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CORE_CLI, ...argv, '--json'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (exit: number | null) => {
      try {
        resolve({ exit, json: JSON.parse(out) });
      } catch (error) {
        reject(new Error(`doflow ${argv.join(' ')} exited ${exit} with no JSON: ${String(error)}`));
      }
    });
  });
}

/** `fn` over `items`, at most `size` at a time. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

/** The log cursor without its informative `ms` part (IC-002: `<ino>:<offset>:<seq>:<ms>`), which differs per read. */
const cursorAt = (value: string | null) => (value === null ? null : value.split(':').slice(0, 3).join(':'));
const logPage = (body: any) => ({ ...body, cursor: cursorAt(body.cursor), before: cursorAt(body.before) });
/** A projected page's pieces in the hub's form: `cut` only where true (live.ts LogPiece). */
const hubPieces = (pieces: any[]) => pieces.map((piece: any) => (piece.cut ? { at: piece.at, text: piece.text, cut: true } : { at: piece.at, text: piece.text }));
/** IC-007's log frame id. */
const LOG_ID = /^[0-9]{1,20}:[0-9]{1,16}:[1-9][0-9]{0,15}:[0-9]{1,16}$/;
/** Keys that would carry a process number or start (IC-011 never reads them). */
const PROCESS_KEYS = new Set(['pid', 'pgid', 'start', 'survivors', 'zombies']);
/** Byte offsets and counts, which may equal a small pid by chance. */
const OFFSET_KEYS = new Set(['at', 'from', 'to', 'size', 'token', 'v', 'shown', 'notShown']);

/** No process field in `value`, and no number outside an offset that equals one of `pids` (this process's own, by default). */
function assertNoProcessNumbers(what: string, value: unknown, pids: readonly number[] = [process.pid], key = '') {
  if (Array.isArray(value)) {
    for (const item of value) assertNoProcessNumbers(what, item, pids, key);
  } else if (value !== null && typeof value === 'object') {
    for (const [name, inner] of Object.entries(value)) {
      assert.ok(!PROCESS_KEYS.has(name), `${what}: a ${name} field`);
      assertNoProcessNumbers(what, inner, pids, name);
    }
  } else if (typeof value === 'number' && !OFFSET_KEYS.has(key)) {
    assert.ok(!pids.includes(value), `${what}: the process number ${value} under ${key}`);
  }
}

test('the Console reads every route from the real core, leaks no free text, and changes no DoFlow tree', { timeout: 240_000 }, async (t: any) => {
  const f = buildFixture((fn: () => void) => t.after(fn));
  const args = ['--core', CORE_CLI, '--project', f.main, '--port', '0'];
  const direct = (...argv: string[]) => spawnSync(process.execPath, [CORE_CLI, ...argv], { cwd: f.main, env: { ...f.env, DOFLOW_UPKEEP: 'off' }, encoding: 'utf8' }).stdout;
  const coreVersion = direct('--version').trim();
  // The leak check is live: the core's own inspect output carries the marker (a plan file path) that the projector drops.
  assert.ok(direct('task-attempt', '--action', 'inspect', '--slug', SLUGS.graph, '--json').includes(MARKER), 'the raw core output carries the marker');

  const before = snapshotTrees(f.roots);
  const app = await boot(args, f.env, f.main);
  const replies = await readEverything(app);
  await shutdown(app);
  const after = snapshotTrees(f.roots);
  assert.deepEqual(after, before, 'reading every route changed a DoFlow tree');

  // IC-002: exactly one stdout line; the code appears nowhere else.
  assert.match(app.stdout(), URL_LINE);
  assert.ok(!app.stderr().includes(app.code));
  for (const [target, reply] of replies) {
    assert.ok(!reply.body.includes(MARKER), `${target}: the planted marker reached the body`);
    assert.ok(!JSON.stringify(reply.headers).includes(MARKER), `${target}: the planted marker reached a header`);
    assert.ok(!reply.body.includes(f.dir), `${target}: a fixture path reached the body`);
    assert.ok(!reply.body.includes(app.code), `${target}: the launch code reached the body`);
    if (target.startsWith('/api/')) {
      assert.equal(reply.headers['cache-control'], 'no-store', target);
      assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8', target);
    }
  }

  assert.deepEqual(body(replies, '/healthz'), { status: 'ok' });
  assert.ok([200, 404].includes(replies.get('/')!.status), 'the static root answers without crashing');

  const info = body(replies, '/api/info');
  assert.deepEqual(Object.keys(info), ['v', 'core', 'capabilities']);
  assert.deepEqual(info.core, { version: coreVersion, inRange: true });
  assert.ok(info.capabilities.length > 0);
  for (const row of info.capabilities) assert.deepEqual(Object.keys(row), ['capability', 'status', 'providerId']);

  const list = body(replies, '/api/runs');
  assert.deepEqual(Object.keys(list), ['v', 'runs', 'unreadableCount']);
  assert.equal(list.v, 1);
  assert.equal(list.unreadableCount, 1, 'the malformed record is counted, not shown');
  assert.deepEqual(list.runs.map((row: any) => row.taskId).sort(), f.runs.map((run: any) => run.taskId).sort());
  for (const run of f.runs) {
    const row = list.runs.find((entry: any) => entry.taskId === run.taskId);
    assert.equal(row.state, run.state, run.taskId);
    assert.equal(row.featureSlug, run.slug, run.taskId);
    assert.equal(row.origin, run.taskId === 'run-other' ? 'other' : 'current', run.taskId);
  }

  for (const row of list.runs.filter((entry: any) => entry.featureSlug !== null && entry.featureSlug !== SLUGS.broken)) {
    const detail = body(replies, `/api/runs/${row.featureSlug}/${row.taskId}`);
    assert.deepEqual(Object.keys(detail).slice(0, 5), ['v', 'run', 'timeline', 'tasks', 'workflow'], row.taskId);
    assert.equal(detail.v, 1);
    assert.equal(detail.run.taskId, row.taskId);
    assert.equal(detail.run.state, row.state);
    assert.equal(detail.run.revision, row.revision, `${row.taskId}: list and status agree on the revision`);
    // status carries no slug, times or origin: the run head takes them from the matching list row.
    assert.ok(detail.run.updatedAt, `${row.taskId}: run.updatedAt is set`);
    for (const key of ['featureSlug', 'startedAt', 'updatedAt', 'origin']) assert.equal(detail.run[key], row[key], `${row.taskId}: run.${key} is the list row's`);
    assert.equal(detail.run.journalGateDiffers, false, `${row.taskId}: the journal gate copy matches the registry`);
    assert.equal(detail.timeline.taskId, row.taskId);
    assert.equal(detail.timeline.revision, row.revision);
    assert.equal(detail.workflow.taskClass, row.taskClass);
  }

  const gate = body(replies, `/api/runs/${SLUGS.graph}/run-gate`);
  assert.deepEqual(gate.timeline.events.map((event: any) => event.action), ['start', 'complete-stage', 'annotate']);
  assert.equal(gate.tasks.graph.graphPlan, true);
  assert.equal(gate.tasksReason, undefined);
  const attempts = Object.fromEntries(gate.tasks.tasks.map((task: any) => [task.id, task.attempts.map((a: any) => `${a.owner}/${a.mode}/${a.state}/${a.result}`)]));
  assert.deepEqual(attempts, {
    'A.1': ['core-implementer/subagent/finished/FAILED'],
    'A.2': ['quality-guardian/manual/released/null', 'quality-guardian/sequential/active/null'],
    'B.1': [],
  });
  const live = body(replies, `/api/runs/${SLUGS.legacy}/run-live`);
  assert.deepEqual([live.tasks, live.tasksReason], [null, 'legacy-plan']);
  const other = body(replies, `/api/runs/${SLUGS.other}/run-other`);
  assert.deepEqual([other.tasks, other.tasksReason], [null, 'no-plan']);
  // A malformed plan is an error, never shown as "no plan".
  assert.equal(replies.get(`/api/runs/${SLUGS.broken}/run-broken`)!.status, 502);
  assert.deepEqual(body(replies, `/api/runs/${SLUGS.broken}/run-broken`), { error: { code: 'core-error', verb: 'attempts', exit: 2 } });

  const { WorkflowEngine } = require('../../src/runtime/workflow-engine.ts');
  const classes = new WorkflowEngine({ repoRoot: path.resolve(__dirname, '..', '..') }).listClasses();
  const workflows = body(replies, '/api/workflows');
  assert.deepEqual(Object.keys(workflows), ['v', 'workflows']);
  assert.deepEqual(workflows.workflows.map((w: any) => w.taskClass), classes);

  assert.equal(replies.get(`/api/runs/${SLUGS.graph}/no-such-run`)!.status, 404);
  assert.deepEqual(body(replies, `/api/runs/${SLUGS.graph}/no-such-run`), { error: { code: 'run-not-found', verb: 'status', exit: 1 } });
  assert.equal(replies.get('/api/runs/..%2f/run-gate')!.status, 400);
  assert.deepEqual(body(replies, '/api/runs/..%2f/run-gate'), { error: { code: 'usage', verb: null, exit: null } });

  // IC-018 e: every Sessions read is a read. The broken feature's plan is skipped (no entry) and its run counted as not checked; every section stays ok.
  const sessions = body(replies, '/api/sessions');
  assert.deepEqual(Object.keys(sessions), ['v', 'sections', 'limits']);
  assert.deepEqual(sessions.sections.tasks.data.map((entry: any) => entry.slug).sort(), [SLUGS.graph, SLUGS.legacy]);
  assert.deepEqual(sessions.sections.workers.data, [{ slug: SLUGS.graph, task: 'A.2', token: 2, worker: null }]);
  assert.deepEqual(sessions.limits, { runsInspected: 3, runsNotChecked: 1, workersChecked: 1, workersNotChecked: 0 });
  assert.deepEqual(sessions.sections.roadmap, { ok: true, data: null }, 'the fixture has no roadmap seed');
  assert.deepEqual(sessions.sections.slots, { ok: true, data: { v: 1, slots: [], unreadable: 0 } });
  assert.deepEqual(sessions.sections.runs.data, list);
  const observed = sessions.sections.observed.data;
  assert.deepEqual(observed.checkouts.map((c: any) => [c.role, c.current, c.branch]), [['main', true, observed.checkouts[0].branch], ['linked', false, 'doflow-ui-fixture-linked']]);
  for (const c of observed.checkouts) assert.match(c.worktreeKey, /^[0-9a-f]{16}$/);
  assert.deepEqual(observed.sessions, []);

  // With the broken plan repaired, `tasks` and `workers` come from real inspects and a real worker-status, still writing nothing.
  fs.writeFileSync(path.join(f.main, 'agent-docs', 'doflow', SLUGS.broken, 'plan.md'),
    ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '', '- [ ] A.1 one step; owner: core-implementer; files: a.js', ''].join('\n'));
  const repairedBefore = snapshotTrees(f.roots);
  const again = await boot(args, f.env, f.main);
  const repaired = body(await readEverything(again), '/api/sessions');
  await shutdown(again);
  assert.deepEqual(snapshotTrees(f.roots), repairedBefore, 'reading /api/sessions changed a DoFlow tree');
  for (const name of Object.keys(repaired.sections)) assert.equal(repaired.sections[name].ok, true, `${name} is ok`);
  // feat-other has no plan (no entry); run-flat has no feature; run-gate, run-live and run-broken are live.
  assert.deepEqual(repaired.sections.tasks.data.map((entry: any) => entry.slug).sort(), [SLUGS.broken, SLUGS.graph, SLUGS.legacy]);
  const graphEntry = repaired.sections.tasks.data.find((entry: any) => entry.slug === SLUGS.graph);
  assert.deepEqual(graphEntry.overlaps, []);
  assert.deepEqual(graphEntry.active.map((a: any) => [a.task, a.token, a.owner, a.mode, a.worktreeKey, a.run, a.lineage]),
    [['A.2', 2, 'quality-guardian', 'sequential', observed.checkouts[0].worktreeKey, 'local', 'main']]);
  assert.deepEqual(repaired.sections.workers.data, [{ slug: SLUGS.graph, task: 'A.2', token: 2, worker: null }], 'no worker run serves the attempt');
  assert.deepEqual(repaired.limits, { runsInspected: 4, runsNotChecked: 0, workersChecked: 1, workersNotChecked: 0 });
  const repairedText = JSON.stringify(repaired);
  assert.ok(!repairedText.includes(MARKER) && !repairedText.includes(f.dir), 'no marker or path in the repaired Sessions body');

  // ---- Feature 149 B.6 and 150 B.6: the worker world, its five routes and GET /api/live against the real core ----
  // Test-local setup, before the snapshot: the shared worker world (helpers/worker-world.ts) on the graph feature's own
  // attempts (A.1/1 finished, A.2/1 released, A.2/2 active), every record written by the core's insertRun and transition.
  const graphAttempts = gate.tasks.tasks.flatMap((task: any) => task.attempts.map((a: any) => ({ task: task.id, token: a.token, state: a.state })));
  const world = buildWorkerWorld({ projectRoot: f.main, slug: SLUGS.graph, attempts: graphAttempts });
  const running = world.runs.running;
  const planted = world.planted;
  const pids = [process.pid, ...planted.pids];
  /** Planted text no body, frame or Console stderr may carry: record free text, prompt, `.last.log`, process starts, paths. */
  const forbidden = [planted.secret, planted.email, planted.ip, planted.path, planted.prompt, planted.lastLog, ...planted.starts, MARKER, f.dir];
  const off = { ...f.env, DOFLOW_UPKEEP: 'off' };
  const base = `/api/worker-runs/${SLUGS.graph}`;
  const ROUTE_TAILS = ['result', 'status', 'log?stream=out', 'log?stream=err', 'transcript'];

  // 150 IC-010: the four new shapes are on the allow-list, each running the verb its route reads.
  for (const [shape, verb] of [['worker-runs', ['worker-runs']], ['worker-result', ['worker-result']], ['worker-run-status', ['worker', '--action', 'status']], ['worker-log', ['worker-log']]] as Array<[string, string[]]>) {
    assert.ok(SHAPE_IDS.includes(shape), `${shape} is in SHAPE_IDS`);
    assert.deepEqual(SHAPES[shape].argv.slice(0, verb.length), verb, `${shape} runs ${verb.join(' ')}`);
  }

  // The core's own output over the world, with the switch on, before the snapshot: what each projector is given.
  const rawRuns = await coreJson(f.main, off, ['worker-runs', '--slug', SLUGS.graph]);
  assert.equal(rawRuns.exit, 0);
  const raw = new Map<string, any>();
  await inBatches(world.all, 3, async (runId: string) => {
    const one = ['--slug', SLUGS.graph, '--worker-run', runId];
    for (const [key, argv] of [['result', ['worker-result', ...one]], ['status', ['worker', '--action', 'status', ...one]],
      ['log?stream=out', ['worker-log', ...one, '--stream', 'out']], ['log?stream=err', ['worker-log', ...one, '--stream', 'err']]] as Array<[string, string[]]>) {
      const read = await coreJson(f.main, off, argv);
      assert.equal(read.exit, 0, `doflow ${argv.join(' ')}: ${JSON.stringify(read.json)}`);
      raw.set(`${runId}/${key}`, read.json);
    }
  });
  // The leak checks are live: the store, the `.last.log` file and the core's own answers carry what the bodies must not.
  const storeText = fs.readFileSync(world.store, 'utf8');
  for (const value of [planted.secret, planted.email, planted.ip, planted.path, planted.prompt, ...planted.starts, ...pids.map(String)]) assert.ok(storeText.includes(value), `the store carries ${value}`);
  assert.ok(fs.readFileSync(path.join(world.outputDir, `${world.runs.lastLog}.last.log`), 'utf8').includes(planted.lastLog), 'the .last.log file carries its marker');
  const rawStatus = JSON.stringify(raw.get(`${world.runs.violated}/status`));
  for (const value of [planted.secret, planted.email, planted.ip, planted.path, String(planted.pids[2])]) assert.ok(rawStatus.includes(value), `the raw worker status carries ${value}`);
  // The core masks the secret, email and IP in log text and, since DEC-012 (R-1), another user's /home
  // path too (mask rule 17); the Console's second pass finds nothing left to mask in it.
  const rawOut = JSON.stringify(raw.get(`${running}/log?stream=out`));
  assert.ok(!rawOut.includes(planted.path), 'the raw worker-log page does not carry the planted /home path');
  assert.ok(rawOut.includes('/home/<masked>/'), 'the core masked the planted /home path itself');

  // RK10: the Console's copy of the worker agent-key rule names the same node as the real core's Fleet tree, for every run.
  const fleet = await coreJson(f.main, off, ['fleet', '--action', 'tree']);
  assert.equal(fleet.exit, 0, JSON.stringify(fleet.json));
  const workerNodes = fleet.json.nodes.filter((node: any) => node.kind === 'worker-run' || node.kind === 'child-worker-run');
  assert.deepEqual(workerNodes.map((node: any) => node.agentKey).sort(), world.all.map(workerAgentKey).sort(), 'the tree holds one worker node per run, under workerAgentKey');
  const listed = project('worker-runs', rawRuns.json);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.body.runs.map((run: any) => run.runId).sort(), [...world.all].sort(), 'worker-runs lists every run, ended and child runs included');
  for (const run of listed.body.runs) {
    const key = workerAgentKey(run.runId);
    const node = workerNodes.find((entry: any) => entry.agentKey === key);
    assert.equal(node.kind, run.childOf === null ? 'worker-run' : 'child-worker-run', run.runId);
    assert.equal(node.startedAt, run.startedAt, `${run.runId}: the node under its key is this run`);
    assert.equal(node.ended === null ? null : node.ended.at, run.endedAt, run.runId);
    if (run.childOf !== null) {
      assert.ok(fleet.json.edges.some((edge: any) => edge.from === workerAgentKey(run.childOf) && edge.to === key && edge.basis === 'worker-childOf'), `${run.runId}: the childOf edge`);
    }
  }

  // The live boot: the snapshot is taken after the world is planted and before the Console starts.
  const outFile = world.logFile(running, 'out');
  const errFile = world.logFile(running, 'err');
  const oldBytes = { out: fs.readFileSync(outFile), err: fs.readFileSync(errFile) };
  const appended: { out: Buffer[], err: Buffer[] } = { out: [], err: [] };
  const liveBefore = snapshotTrees(f.roots);
  const viewed = await boot(args, f.env, f.main);
  const liveCookie = await exchange(viewed);
  const liveGets = await readEverything(viewed, liveCookie);
  const get = async (target: string) => {
    const reply = await request(viewed.port, 'GET', target, { Cookie: liveCookie });
    liveGets.set(target, reply);
    return reply;
  };
  await get(base);
  await inBatches(world.all, 2, async (runId: string) => {
    for (const tail of ROUTE_TAILS) await get(`${base}/${runId}/${tail}`);
  });
  const reply200 = (target: string) => {
    const reply = liveGets.get(target);
    assert.ok(reply, `${target} was read`);
    assert.equal(reply!.status, 200, `${target}: ${reply!.body}`);
    return JSON.parse(reply!.body);
  };
  const projected = (shape: string, json: any) => {
    const result = project(shape, json);
    assert.equal(result.ok, true, `${shape} projects: ${JSON.stringify(result)}`);
    return result.body;
  };

  // IC-012: every body is its projector over the core verb's own output (a log cursor's informative `ms` aside).
  assert.deepEqual(reply200(base), listed.body);
  for (const runId of world.all) {
    assert.deepEqual(reply200(`${base}/${runId}/result`), projected('worker-result', raw.get(`${runId}/result`)), `${runId} result`);
    assert.deepEqual(reply200(`${base}/${runId}/status`), projected('worker-run-status', raw.get(`${runId}/status`)), `${runId} status`);
    for (const stream of ['out', 'err']) {
      const target = `${base}/${runId}/log?stream=${stream}`;
      assert.deepEqual(logPage(reply200(target)), logPage(projected('worker-log', raw.get(`${runId}/${target.split('/').pop()}`))), target);
    }
    // The fixture lists no Fleet project, so the transcript read stops at `projects` (RK10 is checked against the tree above).
    const transcript = liveGets.get(`${base}/${runId}/transcript`)!;
    assert.deepEqual([transcript.status, JSON.parse(transcript.body)], [404, { error: { code: 'project-not-found', verb: 'projects', exit: null } }], `${runId} transcript`);
  }
  // The world's cases reached the bodies: every withheld code, the offered results, the live, overdue, capped and absent logs.
  const results = world.all.map((runId: string) => reply200(`${base}/${runId}/result`));
  assert.deepEqual([...new Set(results.flatMap((r: any) => r.withheld))].sort(), [...CLOSED_SETS.withheldCodes].sort());
  assert.deepEqual(results.filter((r: any) => r.resultOffered).map((r: any) => r.runId).sort(), [world.runs.offered, world.runs.capped, world.runs.lastLog].sort());
  assert.deepEqual(results.find((r: any) => r.runId === world.runs.quota).quota, { signal: 'rate limit', basis: 'documented' });
  const statusOf = (role: string) => reply200(`${base}/${world.runs[role]}/status`);
  assert.deepEqual([statusOf('running').state, statusOf('running').childOf], ['running', null]);
  assert.deepEqual([statusOf('child').state, statusOf('child').childOf], ['running', running]);
  assert.equal(statusOf('overdue').overdue, true);
  assert.deepEqual(statusOf('violated').process, { kind: 'exited', code: 0, signal: null, at: statusOf('violated').endedAt, reason: null, groupAlive: true, leftover: { status: 'survivors', reason: null } });
  const logOf = (role: string, stream: string) => reply200(`${base}/${world.runs[role]}/log?stream=${stream}`);
  assert.deepEqual([logOf('running', 'out').log, logOf('child', 'out').log, logOf('edit', 'out').log, logOf('offered', 'out').log], ['open', 'waiting', 'gone', 'open']);
  assert.deepEqual([logOf('capped', 'out').capped, logOf('capped', 'err').capped, logOf('offered', 'out').capped], [true, false, false]);
  const tail = { out: logOf('running', 'out'), err: logOf('running', 'err') };

  // GET /api/live on the 149 channel kinds and the running run's two log lanes (IC-013, IC-014).
  const runChannel = `run:${SLUGS.graph}:run-gate`;
  const tasksChannel = `tasks:${SLUGS.graph}`;
  const workerChannel = `worker:${running}`;
  const laneOf = { out: `${workerChannel}:out`, err: `${workerChannel}:err` };
  const liveChannels = ['now', runChannel, tasksChannel, workerChannel, laneOf.out, laneOf.err];
  const first = await openLive(viewed.port, liveCookie, liveChannels);
  assert.equal(first.status, 200, first.text());
  assert.equal(first.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.ok(await first.until((frames) => liveChannels.every((channel) => hasSnapshot(frames, channel))),
    `every channel got its snapshot; frames ${JSON.stringify(first.messages().map((m) => `${m.frame.ch}/${m.frame.type}`))}`);
  assert.ok(first.text().startsWith('retry: 2000\n\n'), 'retry: 2000 first');
  const frames = () => first.messages().map((message) => message.frame);
  const snapshotOf = (channel: string) => {
    const frame = frames().find((entry) => entry.ch === channel && entry.type === 'snapshot');
    assert.deepEqual(Object.keys(frame), ['v', 'ch', 'id', 'type', 'at', 'data'], channel);
    assert.equal(frame.v, 1);
    assert.match(frame.id, /^[0-9a-f]{8}-[1-9][0-9]*$/, channel);
    assert.deepEqual(Object.keys(frame.data), ['state'], channel);
    return frame.data.state;
  };
  // IC-012: each member is {status, body} equal to the matching GET reply read from the same Console.
  const member = (reply: Reply) => ({ status: reply.status, body: JSON.parse(reply.body) });
  const now = snapshotOf('now');
  assert.deepEqual(Object.keys(now), ['runs', 'sessions']);
  assert.deepEqual(now.runs, member(liveGets.get('/api/runs')!));
  assert.deepEqual(now.sessions, member(liveGets.get('/api/sessions')!));
  const runState = snapshotOf(runChannel);
  assert.deepEqual(Object.keys(runState), ['run']);
  const detail = member(liveGets.get(`/api/runs/${SLUGS.graph}/run-gate`)!);
  assert.deepEqual(runState.run, detail);
  // 150 IC-013: the `tasks:` channel's `workers` and the `worker:` channel's members are the worker-run routes' replies.
  assert.deepEqual(snapshotOf(tasksChannel), { tasks: { status: 200, body: { tasks: detail.body.tasks } }, workers: member(liveGets.get(base)!) });
  const worker = snapshotOf(workerChannel);
  assert.deepEqual(Object.keys(worker), ['worker', 'result']);
  assert.deepEqual(worker.worker, member(liveGets.get(`${base}/${running}/status`)!));
  assert.deepEqual(worker.result, member(liveGets.get(`${base}/${running}/result`)!));
  assert.deepEqual([worker.worker.body.runId, worker.worker.body.task, worker.worker.body.token, worker.worker.body.state], [running, 'A.2', 2, 'running']);
  // The planted world reached Sessions: the running run now serves the active A.2/2 attempt.
  assert.equal(now.sessions.body.sections.workers.data[0].worker.runId, running);

  // IC-007, IC-013: each log lane opens with the hub's window, which is the projected tail page.
  const logFrames = (connection: LiveConnection, stream: 'out' | 'err') => connection.messages().map((m) => m.frame).filter((frame) => frame.ch === laneOf[stream]);
  const windows = { out: { ino: '', to: 0 }, err: { ino: '', to: 0 } };
  for (const stream of ['out', 'err'] as const) {
    const [snapshot] = logFrames(first, stream);
    assert.equal(snapshot.type, 'snapshot', `${stream}: the first frame is the snapshot`);
    assert.deepEqual(Object.keys(snapshot), ['v', 'ch', 'id', 'type', 'at', 'data'], stream);
    assert.match(snapshot.id, LOG_ID, stream);
    assert.deepEqual(snapshot.data, { log: 'open', ino: tail[stream].ino, from: tail[stream].from, to: tail[stream].to, pieces: hubPieces(tail[stream].pieces), phase: 'running', end: null }, stream);
    assert.ok(snapshot.id.startsWith(`${tail[stream].ino}:${tail[stream].to}:`), `${stream}: the id is the window's inode and end`);
    assert.equal(tail[stream].to, oldBytes[stream].length, `${stream}: the window reaches the file's end`);
    windows[stream] = { ino: tail[stream].ino, to: tail[stream].to };
  }

  /** Appends `count` lines to each stream, a few ms apart, as the sink would; returns the lines by stream. */
  const appendBatch = async (name: string, count: number) => {
    const lines: { out: string[], err: string[] } = { out: [], err: [] };
    for (let i = 1; i <= count; i += 1) {
      for (const stream of ['out', 'err'] as const) {
        const line = `appended ${name} ${stream} ${i} ${planted.text}`;
        const written = world.appendLine(running, stream, line);
        assert.equal(written.from, oldBytes[stream].length + appended[stream].reduce((sum, bytes) => sum + bytes.length, 0));
        appended[stream].push(Buffer.from(`${line}\n`));
        lines[stream].push(line);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return lines;
  };
  const sizeOf = (stream: 'out' | 'err') => fs.statSync(world.logFile(running, stream)).size;
  const reached = (connection: LiveConnection) => connection.until(() => (['out', 'err'] as const).every((stream) => logFrames(connection, stream).some((frame) => frame.data.to === sizeOf(stream))));
  /** A lane's frames after `from`: contiguous `append` frames with IC-007 ids, `from` each the previous `to`; returns their pieces. */
  const appendsFrom = (list: any[], stream: 'out' | 'err', from: number) => {
    let at = from;
    const pieces: any[] = [];
    for (const frame of list) {
      assert.equal(frame.type, 'append', `${stream}: ${JSON.stringify(frame)}`);
      assert.deepEqual(Object.keys(frame.data), ['from', 'to', 'pieces', 'phase', 'end'], stream);
      assert.equal(frame.data.from, at, `${stream}: no gap and no repeat`);
      assert.deepEqual([frame.data.phase, frame.data.end], ['running', null], stream);
      assert.match(frame.id, LOG_ID, stream);
      assert.ok(frame.id.startsWith(`${windows[stream].ino}:${frame.data.to}:`), `${stream}: the append id is its inode and end`);
      at = frame.data.to;
      pieces.push(...frame.data.pieces);
    }
    return { to: at, pieces };
  };

  // Lines appended while the connection is open arrive as appends, masked as the projected forward page is.
  const batch1 = await appendBatch('b1', 3);
  assert.ok(await reached(first), `batch 1 reached both lanes; frames ${JSON.stringify(first.messages().map((m) => `${m.frame.ch}/${m.frame.type}`))}`);
  const v1 = [...first.messages()].reverse().find((message) => message.id !== null)!.id!;
  for (const stream of ['out', 'err'] as const) {
    const got = appendsFrom(logFrames(first, stream).slice(1), stream, windows[stream].to);
    assert.equal(got.to, sizeOf(stream), stream);
    const at = `${windows[stream].ino}:${windows[stream].to}:0:0`;
    await get(`${base}/${running}/log?stream=${stream}&cursor=${at}`);
    const forward = reply200(`${base}/${running}/log?stream=${stream}&cursor=${at}`);
    assert.deepEqual([forward.from, forward.to], [windows[stream].to, got.to], `${stream}: the forward page covers the appends`);
    assert.deepEqual(got.pieces, hubPieces(forward.pieces), `${stream}: the live pieces are the projected forward page`);
    assert.deepEqual(got.pieces.map((piece: any) => piece.text.split(' password=')[0]), batch1[stream].map((line) => line.split(' password=')[0]), `${stream}: every line, in order`);
    for (const piece of got.pieces) assert.ok(piece.text.includes('password=<masked>') && piece.text.includes('<email>') && piece.text.includes('<ip>') && piece.text.includes('/home/<masked>/'), `${stream}: masked ${piece.text}`);
    // DEC-012 (R-1): the core's own forward page over the same bytes already holds every marker,
    // the /home one included, so the live text is the core's text and maskLite added nothing.
    const coreForward = await coreJson(f.main, off, ['worker-log', '--slug', SLUGS.graph, '--worker-run', running, '--stream', stream, '--cursor', at]);
    assert.equal(coreForward.exit, 0, JSON.stringify(coreForward.json));
    for (const piece of coreForward.json.pieces) assert.ok(piece.text.includes('/home/<masked>/') && !piece.text.includes(planted.path), `${stream}: the core masked ${piece.text}`);
    assert.deepEqual(coreForward.json.pieces.map((piece: any) => piece.text), got.pieces.map((piece: any) => piece.text), `${stream}: the core's pieces are the live pieces`);
    await get(`${base}/${running}/log?stream=${stream}&before=${at}`);
    const backward = reply200(`${base}/${running}/log?stream=${stream}&before=${at}`);
    assert.deepEqual(hubPieces(backward.pieces), hubPieces(tail[stream].pieces), `${stream}: the backward page ends where the window began`);
    // 150 IC-014: the SSE id vector carries the lane's `<ino>:<to>`.
    assert.ok(v1.split('/')[1].split(',').includes(`${laneOf[stream]}=${windows[stream].ino}:${got.to}`), `${stream}: ${v1}`);
  }

  // A second connection resuming from that vector, after more lines, gets exactly the lines past it: no loss, no repeat.
  const resumeAt = { out: sizeOf('out'), err: sizeOf('err') };
  const batch2 = await appendBatch('b2', 2);
  assert.ok(await reached(first), 'batch 2 reached the first connection');
  const second = await openLive(viewed.port, liveCookie, liveChannels, v1);
  assert.equal(second.status, 200, second.text());
  assert.ok(await reached(second), `batch 2 reached the resumed connection; frames ${JSON.stringify(second.messages().map((m) => `${m.frame.ch}/${m.frame.type}`))}`);
  for (const stream of ['out', 'err'] as const) {
    const fromFirst = appendsFrom(logFrames(first, stream).slice(1), stream, windows[stream].to).pieces.filter((piece: any) => piece.at >= resumeAt[stream]);
    const resumed = appendsFrom(logFrames(second, stream), stream, resumeAt[stream]);
    assert.equal(resumed.to, sizeOf(stream), stream);
    assert.deepEqual(resumed.pieces, fromFirst, `${stream}: the resumed lane carries what the first one got past the vector`);
    assert.deepEqual(resumed.pieces.map((piece: any) => piece.text.split(' password=')[0]), batch2[stream].map((line) => line.split(' password=')[0]), stream);
  }
  await second.close();
  await first.close();
  await shutdown(viewed);

  // Read-only: every entry of every tree is as it was, apart from the two files this test appended to, which hold
  // exactly their old bytes followed by the appended ones under the same inode (only their mtime and digest moved).
  const liveAfter = snapshotTrees(f.roots);
  const expected: any = JSON.parse(JSON.stringify(liveBefore));
  for (const [stream, file] of [['out', outFile], ['err', errFile]] as Array<['out' | 'err', string]>) {
    const id = Object.keys(f.roots).find((root) => !path.relative(f.roots[root], file).startsWith('..'))!;
    const rel = path.relative(f.roots[id], file).split(path.sep).join('/');
    const was: any = liveBefore[id][rel];
    const is: any = liveAfter[id][rel];
    assert.ok(was && is, `${rel} is in the ${id} tree`);
    const bytes = Buffer.concat([oldBytes[stream], ...appended[stream]]);
    assert.ok(fs.readFileSync(file).equals(bytes), `${rel}: its old bytes followed by the appended ones`);
    assert.notEqual(is.sha256, was.sha256, `${rel}: the appends are in the file`);
    expected[id][rel] = { ...was, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mtimeNs: is.mtimeNs };
  }
  assert.deepEqual(liveAfter, expected, 'the worker routes or the live route changed a DoFlow tree');

  // No planted value, pid, process start, prompt, `.last.log` text or path in any body, header or frame.
  const liveText = first.text() + second.text();
  for (const value of [...forbidden, viewed.code]) {
    assert.ok(!liveText.includes(value), `a live frame carries ${value}`);
    for (const [target, reply] of liveGets) {
      assert.ok(!reply.body.includes(value), `${target}: the body carries ${value}`);
      assert.ok(!JSON.stringify(reply.headers).includes(value), `${target}: a header carries ${value}`);
    }
  }
  for (const [target, reply] of liveGets) {
    if (!target.startsWith('/api/')) continue;
    assert.equal(reply.headers['cache-control'], 'no-store', target);
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8', target);
    if (target.startsWith(base)) assertNoProcessNumbers(target, JSON.parse(reply.body), pids);
  }
  for (const message of [...first.messages(), ...second.messages()]) {
    if (liveChannels.slice(2).includes(message.frame.ch)) assertNoProcessNumbers(`${message.frame.ch} ${message.frame.type}`, message.frame.data, pids);
  }
  for (const value of [planted.secret, planted.email, planted.ip, planted.lastLog, MARKER]) assert.ok(!viewed.stderr().includes(value), `the Console stderr carries ${value}`);

  // Vacuity guard: the same boot and reads with the switch removed from every core child must write.
  const controlBefore = snapshotTrees(f.roots);
  const control = await boot(args, f.env, f.main, true);
  const controlCookie = await exchange(control);
  await readEverything(control, controlCookie);
  await request(control.port, 'GET', base, { Cookie: controlCookie });
  await inBatches(world.all, 2, async (runId: string) => {
    for (const tail of ROUTE_TAILS) await request(control.port, 'GET', `${base}/${runId}/${tail}`, { Cookie: controlCookie });
  });
  const controlStream = await readLive(control.port, controlCookie, liveChannels);
  await shutdown(control);
  const controlAfter = snapshotTrees(f.roots);
  assert.ok(control.stderr().includes('drop-upkeep-switch: removed'), 'the control hook ran');
  for (const channel of liveChannels) assert.ok(hasSnapshot(controlStream.frames, channel), `control: ${channel} got its snapshot`);
  const changed = TREE_IDS.filter((id: string) => !isDeepStrictEqual(controlBefore[id], controlAfter[id]));
  assert.ok(changed.length > 0, 'Fixture is vacuous: the reads without DOFLOW_UPKEEP=off changed none of the three trees');
});

test('Fleet shapes against the real core over two projects: nothing written, no planted marker or path in any body, errors as IC-005 names them', { timeout: 180_000 }, async (t: any) => {
  const w = buildFleetWorld((fn: () => void) => t.after(fn));
  const runner = createVerbRunner({ corePath: w.core, projectRoot: w.alpha, env: w.env });
  t.after(() => runner.stop());
  const before = snapshotTrees(w.roots);
  const bodies: Array<[string, string]> = []; // [what, JSON of the projected body], scanned for planted text below
  const read = async (shape: string, params: Record<string, string>) => {
    const result = await runner.run(shape, params);
    assert.equal(result.ok, true, `${shape} ${JSON.stringify(params)}: ${JSON.stringify(result)}`);
    const projected = project(shape, result.json);
    assert.equal(projected.ok, true, `${shape} projects: ${JSON.stringify(projected)}`);
    bodies.push([`${shape} ${JSON.stringify(params)}`, JSON.stringify(projected.body)]);
    return { raw: result.json, body: projected.body };
  };

  // The scan below is live: the planted text is in the transcripts the core reads.
  const transcriptText = (dir: string): string => fs.readdirSync(dir, { withFileTypes: true }).map((e: any) =>
    (e.isDirectory() ? transcriptText(path.join(dir, e.name)) : /\.jsonl$/.test(e.name) ? fs.readFileSync(path.join(dir, e.name), 'utf8') : '')).join('\n');
  const planted = transcriptText(w.home);
  for (const marker of ['fx-Secret-4471', 'FIXTURE-THINKING-MARKER-7f3a', 'FIXTURE-USER-PROMPT-MARKER-91c2', 'fixture.person@example.invalid', 'FIXTURE-OTHER-PROJECT-REPLY-2b8d']) {
    assert.ok(planted.includes(marker), `${marker} is planted in the fixture transcripts`);
  }

  // projects: the core's body carries both roots (so the key map can be filled); the projected body carries neither.
  const listed = await read('projects', {});
  const rawText = JSON.stringify(listed.raw);
  assert.ok(rawText.includes(w.alpha) && rawText.includes(w.beta), 'the raw core body carries the roots');
  assert.ok(!JSON.stringify(listed.body).includes(w.dir) && !JSON.stringify(listed.body).includes('root'), 'the projected body carries no root');
  assert.deepEqual(listed.body.projects.map((p: any) => [p.label, p.current, p.checkouts]), [['main', true, 2], ['beta', false, 1]]);
  assert.deepEqual(listed.body.projects.map((p: any) => p.sources), [['hook-dirs'], ['hook-dirs']]);
  const [keyA, keyB] = listed.body.projects.map((p: any) => p.projectKey);
  assert.notEqual(keyA, keyB);
  assert.equal(listed.body.excluded.temp, 0);

  // tree, traffic and every agent's transcript, per project, from the key alone.
  const trees: Record<string, any> = {};
  for (const key of [keyA, keyB]) {
    trees[key] = (await read('tree', { projectKey: key })).body;
    assert.equal(trees[key].projectKey, key);
    const stats = (await read('traffic', { projectKey: key })).body;
    assert.equal(stats.projectKey, key);
    assert.equal(stats.windowMin, 10);
  }
  const harnessOf = (node: any) => node.harness;
  assert.deepEqual([...new Set(trees[keyA].nodes.map(harnessOf))].filter(Boolean).sort(), ['antigravity', 'claude', 'codex', 'copilot', 'kiro', 'opencode', 'pi']);
  assert.deepEqual(trees[keyB].nodes.filter((n: any) => n.kind === 'main-session').map((n: any) => [n.harness, n.transcript.linked, n.transcript.reason]).sort(), [['claude', false, 'not-found'], ['claude', true, null]]);

  const events: Record<string, any[]> = {};
  const bodiesOfAlpha: any[] = [];
  for (const node of trees[keyA].nodes) {
    const first = (await read('transcript', { projectKey: keyA, agent: node.agentKey, limit: '500' })).body;
    bodiesOfAlpha.push(first);
    assert.equal(first.agentKey, node.agentKey);
    // A second read from the returned cursor continues (a read-only cursor: it must not fail and must not repeat reader events).
    const second = (await read('transcript', { projectKey: keyA, agent: node.agentKey, cursor: first.cursor, limit: '500' })).body;
    assert.ok(second.events.every((e: any) => e.kind === 'record' || !first.events.some((x: any) => x.seq === e.seq && x.kind === e.kind && x.at === e.at && x.kind !== 'record')), `${node.agentKey}: no reader event repeated`);
    events[`${node.harness}/${node.kind}`] = [...(events[`${node.harness}/${node.kind}`] ?? []), ...first.events];
  }
  const kindsOf = (id: string) => new Set((events[id] ?? []).map((e: any) => e.kind));
  for (const id of ['claude/main-session', 'codex/main-session', 'pi/main-session', 'kiro/main-session', 'copilot/main-session']) assert.ok(kindsOf(id).has('reply'), `${id}: a reply was read`);
  // Unavailable transcripts still read: record events only, with the reason in the body.
  for (const harness of ['antigravity', 'opencode']) {
    const node = trees[keyA].nodes.find((n: any) => n.harness === harness);
    const body = bodiesOfAlpha.find((b: any) => b.agentKey === node.agentKey);
    assert.equal(body.reader.status, 'events-only', harness);
    assert.equal(body.transcript.reason, harness === 'antigravity' ? 'not-linked' : 'no-reader');
    assert.ok(body.events.every((e: any) => e.kind === 'record'), harness);
  }
  // The second pass is live: the replies carry the markers the core wrote, and no secret came through.
  const replies = Object.values(events).flat().filter((e: any) => e.kind === 'reply').map((e: any) => e.text).join('\n');
  assert.ok(replies.includes('<masked>') && replies.includes('<email>'), `masked replies: ${replies.slice(0, 200)}`);
  assert.ok(Object.values(events).flat().some((e: any) => e.kind === 'tool-call' && e.args !== null), 'tool arguments were read');

  // Errors: an unknown agent, and an agent of another project (beta carries alpha's claude session id, so its tree joins a file whose cwd is alpha).
  const unknown = await runner.run('transcript', { projectKey: keyA, agent: 'ffffffffffffffff', limit: '10' });
  assert.deepEqual(unknown, { ok: false, code: 'core-error', exit: 1, errorId: 'agent-not-in-project' });
  assert.deepEqual(fleetError('transcript', unknown), { status: 404, code: 'agent-not-in-project' });
  const foreign = trees[keyB].nodes.find((n: any) => n.kind === 'main-session' && n.transcript.linked);
  const crossed = await runner.run('transcript', { projectKey: keyB, agent: foreign.agentKey, limit: '10' });
  assert.deepEqual(fleetError('transcript', crossed), { status: 404, code: 'session-not-in-project' });
  assert.deepEqual(await runner.run('tree', { projectKey: 'cccccccccccccccc' }), { ok: false, code: 'project-not-found', exit: null });

  // No planted marker, raw session id, fixture path or other project's reply in any projected body; every key a hex key.
  for (const [what, text] of bodies) {
    for (const marker of [...FLEET_FORBIDDEN, w.dir, w.alpha, w.beta]) assert.ok(!text.includes(marker), `${what}: ${marker}`);
    assert.ok(!/"(?:cwd|path|file|sessionId|root|pid)"/.test(text), `${what}: a path-like field`);
  }
  assert.ok(trees[keyA].nodes.every((n: any) => /^[0-9a-f]{16}$/.test(n.agentKey)));

  // Read-only: no tree changed, no file added or removed anywhere under the fixture (both projects, every harness home, the three DoFlow trees).
  assert.deepEqual(snapshotTrees(w.roots), before, 'reading the Fleet shapes changed a tree');

  // Vacuity guard: a verb that runs upkeep, without the switch, does write in this fixture.
  const upkeep = spawnSync(process.execPath, [CORE_CLI, 'orchestrate', '--action', 'list', '--json'], { cwd: w.alpha, env: w.env, encoding: 'utf8' });
  assert.equal(upkeep.status, 0, upkeep.stderr);
  const changed = Object.keys(before).filter((id) => !isDeepStrictEqual(before[id], snapshotTrees(w.roots)[id]));
  assert.ok(changed.length > 0, 'Fixture is vacuous: a verb with upkeep on changed no tree');
});

/** A stand-in core that prints only a version line, for the boot cases that need no real core. */
function fakeCore(t: any, version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-fake-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'doflow.js');
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(`${version}\n`)});\n`);
  return file;
}

function runToExit(args: string[]): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: os.tmpdir(), encoding: 'utf8', timeout: BOOT_MS });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('entry: an unknown, repeated or malformed flag is exit 2 with nothing on stdout', (t: any) => {
  const core = fakeCore(t, '2.0.0-beta.7');
  for (const args of [[], ['--core'], ['--core', 'relative/doflow.js'], ['--core', core, '--host', '0.0.0.0'], ['--core', core, '--core', core],
    ['--core', core, '--port', '70000'], ['--core', core, '--port', '-1'], ['--core', core, '--project', 'rel'], ['--core', core, '--project', path.join(core, 'nope')],
    ['--core', core, '--open'], [`--core=${core}`]]) {
    const result = runToExit(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '', args.join(' '));
  }
});

test('entry: a core outside doflowCore is exit 2 naming the version found and the range needed', (t: any) => {
  const { doflowCore } = require('../package.json');
  const result = runToExit(['--core', fakeCore(t, '1.4.0')]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes('found 1.4.0') && result.stderr.includes(`needed ${doflowCore}`), result.stderr);
  const missing = runToExit(['--core', path.join(os.tmpdir(), 'doflow-ui-no-such-core.js')]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, '');
});

test('entry: a port that cannot be bound is exit 1; SIGINT shuts a running Console down with exit 0', async (t: any) => {
  const core = fakeCore(t, '2.0.0-beta.7');
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => holder.close());
  const taken = runToExit(['--core', core, '--port', String(holder.address().port)]);
  assert.equal(taken.status, 1, taken.stderr);
  assert.equal(taken.stdout, '');

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value as string;
  const app = await boot(['--core', core], env, os.tmpdir());
  assert.deepEqual((await request(app.port, 'GET', '/healthz')).status, 200);
  await shutdown(app, 'SIGINT');
});
