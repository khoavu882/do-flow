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
// Vacuity guard: the same boot and reads with DOFLOW_UPKEEP=off taken out of every core child's
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
const { createVerbRunner, fleetError } = require('../src/verb-runner.ts');
const { project } = require('../src/project.ts');

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

/** Exchanges the launch code, then reads every route the views use. Returns each reply by target. */
async function readEverything(app: Booted): Promise<Map<string, Reply>> {
  const own = `http://127.0.0.1:${app.port}`;
  const exchange = await request(app.port, 'POST', '/api/session', { Origin: own, 'Content-Type': 'application/json' }, JSON.stringify({ code: app.code }));
  assert.equal(exchange.status, 204, `exchange: ${exchange.body}`);
  const cookie = String(exchange.headers['set-cookie']).split(';')[0];
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

test('the Console reads every route from the real core, leaks no free text, and changes no DoFlow tree', { timeout: 120_000 }, async (t: any) => {
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

  // Vacuity guard: the same boot and reads with the switch removed from every core child must write.
  const controlBefore = snapshotTrees(f.roots);
  const control = await boot(args, f.env, f.main, true);
  await readEverything(control);
  await shutdown(control);
  const controlAfter = snapshotTrees(f.roots);
  assert.ok(control.stderr().includes('drop-upkeep-switch: removed'), 'the control hook ran');
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
