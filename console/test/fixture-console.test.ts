'use strict';

// The fixture Console (feature 093, C.2; design C14, FR-013, IC-015) through the Console's own API: the
// script of scripts/fixture-console.ts is started in-process, which builds the fixture with real core
// verbs and boots bin/doflow-ui.js on it. The code is exchanged and /api/runs and the run routes are read.
// One run per run state, a stale run, a shape-mismatch run, a flat run, a 12-task plan over 3 owners with
// finished, released and active attempts, several gate kinds; `--empty` and `--core-missing` modes; and
// the live steps. The "running lane" case is the one that needs the fixture's active attempts.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CORE_CLI } = require('./helpers/core-fixture.ts');
const { RUNS, OWNERS, SCRATCH_ROOT, startFixtureConsole, parseFlags } = require('../scripts/fixture-console.ts');

const DAY = 24 * 60 * 60 * 1000;
const URL_FORM = /^http:\/\/127\.0\.0\.1:\d+\/#c=[0-9a-f]{64}$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Api = { get(target: string): Promise<{ status: number, json: any }>, exchange: number, health: number };

/** Exchanges the launch code (POST /api/session) and returns a GET over the session cookie. */
async function session(app: any): Promise<Api> {
  const own = `http://127.0.0.1:${app.port}`;
  const exchange = await fetch(`${own}/api/session`, { method: 'POST', headers: { Origin: own, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: app.code }) });
  const cookie = String(exchange.headers.get('set-cookie')).split(';')[0];
  const health = await fetch(`${own}/healthz`);
  return {
    exchange: exchange.status,
    health: health.status,
    async get(target: string) {
      const reply = await fetch(`${own}${target}`, { headers: { Cookie: cookie } });
      return { status: reply.status, json: await reply.json() };
    },
  };
}

const row = (runs: any[], taskId: string) => {
  const found = runs.find((entry) => entry.taskId === taskId);
  assert.ok(found, `${taskId} is listed`);
  return found;
};

let full: any;
let fullApi: Api;
before(async () => {
  full = await startFixtureConsole({ core: CORE_CLI });
  fullApi = await session(full);
}, { timeout: 120_000 });
after(async () => { if (full) await full.stop(); });

test('the fixture lists one run per run state, a stale run, a shape-mismatch run and a flat run', async () => {
  assert.match(full.url, URL_FORM);
  assert.equal(fullApi.exchange, 204);
  const listed = await fullApi.get('/api/runs');
  assert.equal(listed.status, 200);
  const runs = listed.json.runs;

  const stateOf = (taskId: string) => row(runs, taskId).state;
  assert.equal(stateOf(RUNS.work.taskId), 'RUNNING');
  assert.equal(stateOf('run-gate'), 'AWAITING_GATE');
  assert.equal(stateOf(RUNS.done.taskId), 'COMPLETED');
  assert.equal(stateOf(RUNS.rejected.taskId), 'REJECTED');
  assert.equal(new Set(runs.map((entry: any) => entry.state)).size, 4, 'every run state is present');

  // Stale: RUNNING and silent for more than 24 h; no other RUNNING run is.
  const stale = row(runs, RUNS.stale.taskId);
  assert.equal(stale.state, 'RUNNING');
  assert.ok(Date.now() - Date.parse(stale.updatedAt) > DAY, `updatedAt ${stale.updatedAt} is more than 24 h old`);
  for (const taskId of [RUNS.work.taskId, RUNS.tick.taskId, RUNS.shape.taskId, 'run-live']) {
    assert.ok(Date.now() - Date.parse(row(runs, taskId).updatedAt) < DAY, `${taskId} is not stale`);
  }

  // Shape mismatch: the workflow's program (stages and their gates) is longer than the run's.
  const workflow = (await fullApi.get('/api/workflows')).json.workflows.find((entry: any) => entry.taskClass === 'feature');
  const programLength = workflow.stages.reduce((total: number, stage: any) => total + 1 + stage.gatesAfter.length, 0);
  assert.equal(row(runs, RUNS.work.taskId).progress.total, programLength);
  assert.equal(row(runs, RUNS.shape.taskId).progress.total, programLength - 1);

  // Gate kinds: a clarification gate and an approval gate are both awaited.
  const gateKind = (gateId: string) => workflow.stages.flatMap((stage: any) => stage.gatesAfter).find((entry: any) => entry.id === gateId).kind;
  assert.equal(row(runs, 'run-gate').awaitingGate.gateId, 'gate-0');
  assert.equal(gateKind('gate-0'), 'clarification');
  assert.equal(row(runs, RUNS.approval.taskId).awaitingGate.gateId, 'gate-a');
  assert.equal(gateKind('gate-a'), 'approval');

  // A flat run cannot be opened: no slug.
  assert.equal(row(runs, 'run-flat').featureSlug, null);
});

test('the run routes open: events, a skipped stage, a forced gate, and the empty plan states', async () => {
  const open = async (run: { slug: string, taskId: string }) => fullApi.get(`/api/runs/${run.slug}/${run.taskId}`);
  const work = await open(RUNS.work);
  assert.equal(work.status, 200);
  assert.ok(work.json.timeline.events.some((event: any) => event.action === 'decide-gate' && event.node === 'gate-0' && event.forced), 'gate-0 was approved forced');
  const done = await open(RUNS.done);
  assert.equal(done.status, 200);
  assert.ok(done.json.timeline.events.some((event: any) => event.action === 'skip-stage'), 'a stage was skipped');

  assert.equal(done.json.tasks, null);
  assert.equal(done.json.tasksReason, 'no-plan', 'a run without a plan');
  assert.equal((await open({ slug: 'feat-legacy', taskId: 'run-live' })).json.tasksReason, 'legacy-plan');
  const approval = await open(RUNS.approval);
  assert.equal(approval.json.tasks.graph.tasks.length, 3);
  assert.ok(approval.json.tasks.tasks.every((task: any) => task.attempts.length === 0), 'a plan without attempts');
});

test('the work run has 12 tasks over 3 owners with finished, released and active attempts, and a running lane', async () => {
  const reply = await fullApi.get(`/api/runs/${RUNS.work.slug}/${RUNS.work.taskId}`);
  assert.equal(reply.status, 200);
  const { graph, tasks } = reply.json.tasks;
  assert.equal(graph.tasks.length, 12);
  assert.equal(tasks.length, 12);
  assert.deepEqual([...new Set(graph.tasks.map((task: any) => task.owner))].sort(), [...OWNERS].sort());

  const attempts = tasks.flatMap((task: any) => task.attempts);
  for (const state of ['finished', 'released', 'active']) assert.ok(attempts.some((entry: any) => entry.state === state), `an attempt is ${state}`);
  assert.ok(attempts.some((entry: any) => entry.state === 'finished' && entry.result === 'COMPLETED'), 'a finished attempt succeeded');
  assert.ok(attempts.some((entry: any) => entry.state === 'finished' && entry.result === 'FAILED'), 'a finished attempt failed');

  // The running lane: tasks with an active attempt, in more than one owner's lane.
  const running = tasks.filter((task: any) => task.attempts.some((entry: any) => entry.state === 'active'));
  assert.deepEqual(running.map((task: any) => task.id).sort(), ['A.3', 'B.1', 'C.2'], 'the tasks with an active attempt');
  assert.ok(running.every((task: any) => task.state === 'RUNNING'));
  const laneOf = (task: any) => task.attempts.find((entry: any) => entry.state === 'active').owner;
  assert.equal(new Set(running.map(laneOf)).size, 3, 'an active attempt in each of the 3 lanes');
});

test('--empty has no runs; --core-missing serves the boundary and answers every core call core-unreachable', { timeout: 120_000 }, async (t: any) => {
  const empty = await startFixtureConsole({ core: CORE_CLI, empty: true });
  t.after(() => empty.stop());
  const emptyApi = await session(empty);
  const listed = await emptyApi.get('/api/runs');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json, { v: 1, runs: [], unreadableCount: 0 });

  // The first requests after boot, so nothing is cached (the runner caches `version` for good).
  const missing = await startFixtureConsole({ core: CORE_CLI, coreMissing: true });
  t.after(() => missing.stop());
  const missingApi = await session(missing);
  assert.equal(missingApi.exchange, 204, 'the page and its session still work');
  assert.equal(missingApi.health, 200);
  const info = await missingApi.get('/api/info');
  assert.equal(info.status, 503);
  assert.equal(info.json.error.code, 'core-unreachable');
  const runs = await missingApi.get('/api/runs');
  assert.equal(runs.status, 503);
  assert.equal(runs.json.error.code, 'core-unreachable');
});

test('every scratch directory is made under SCRATCH_ROOT and is gone after stop', { timeout: 120_000 }, async (t: any) => {
  const app = await startFixtureConsole({ core: CORE_CLI, empty: true, coreMissing: true });
  t.after(() => app.stop());
  // The fixture project and the core symlink directory.
  assert.equal(app.scratch.length, 2);
  for (const dir of app.scratch) {
    assert.equal(path.dirname(dir), SCRATCH_ROOT, `${dir} is directly under the root`);
    assert.ok(fs.existsSync(dir), `${dir} exists while the Console runs`);
  }
  await app.stop();
  for (const dir of app.scratch) assert.ok(!fs.existsSync(dir), `${dir} is gone after stop`);
  assert.ok(fs.existsSync(SCRATCH_ROOT), 'only the directories it made are removed, not the root');
});

test('--core must be an absolute path to an existing file', () => {
  assert.deepEqual(Object.keys(parseFlags(['--core', CORE_CLI, '--empty', '--core-missing', '--keep', '--tick', '2'])).sort(), ['coreMissing', 'core', 'empty', 'keep', 'tick'].sort());
  for (const argv of [[], ['--core', 'relative/doflow.js'], ['--core', path.join(path.dirname(CORE_CLI), 'no-such.js')], ['--core', CORE_CLI, '--bogus'], ['--core', CORE_CLI, '--tick', '0']]) {
    assert.ok('error' in parseFlags(argv), `refused: ${argv.join(' ')}`);
  }
});

// Last: it changes the fixture.
test('each tick takes the next step of the live run, then reports none left', { timeout: 60_000 }, async () => {
  const state = async () => row((await fullApi.get('/api/runs')).json.runs, RUNS.tick.taskId);
  assert.equal((await state()).current.id, 'design');
  assert.match(full.tick(), /design completed/);
  assert.match(full.tick(), /awaiting gate-a/);
  await sleep(2_200); // the list is cached for 2 s
  const waiting = await state();
  assert.equal(waiting.state, 'AWAITING_GATE');
  assert.equal(waiting.awaitingGate.gateId, 'gate-a');
  assert.match(full.tick(), /gate-a approved/);
  await sleep(2_200);
  const running = await state();
  assert.equal(running.state, 'RUNNING');
  assert.equal(running.current.id, 'implementation');
  assert.equal(full.tick(), null);
});
