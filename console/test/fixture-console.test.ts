'use strict';

// The fixture Console (feature 093, C.2; design C14, FR-013, IC-015) through the Console's own API: the
// script of scripts/fixture-console.ts is started in-process, which builds the fixture with real core
// verbs and boots bin/doflow-ui.js on it. The code is exchanged and /api/runs and the run routes are read.
// One run per run state, a stale run, a shape-mismatch run, a flat run, a 12-task plan over 3 owners with
// finished, released and active attempts, several gate kinds; `--empty` and `--core-missing` modes; and
// the live steps. The "running lane" case is the one that needs the fixture's active attempts. The `--worker-log`
// cases (feature 150 D.1, IC-021) run the script as a child and drive it with stdin `log` lines.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CORE_CLI } = require('./helpers/core-fixture.ts');
const { RUNS, OWNERS, SCRATCH_ROOT, CHAIN, LOG_APPENDS, startFixtureConsole, parseFlags } = require('../scripts/fixture-console.ts');
const { readRuns } = require('../../src/runtime/worker/run-store.ts');
const crypto = require('node:crypto');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

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

test('the Sessions fixture: two checkouts, hook records from the real scripts, a dead holder, an overlap held by two runs, a 30 h claim, and nothing of the second project', async () => {
  const reply = await fullApi.get('/api/sessions');
  assert.equal(reply.status, 200);
  const { sections, limits } = reply.json;
  for (const name of ['observed', 'slots', 'runs', 'tasks', 'workers', 'roadmap']) assert.equal(sections[name].ok, true, `${name} is whole`);
  const key = (id: string) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);

  // Two checkouts; the linked one has a commit after every record there.
  const { checkouts, sessions, store } = sections.observed.data;
  assert.equal(store, 'present');
  assert.deepEqual(checkouts.map((c: any) => [c.role, c.current]), [['main', true], ['linked', false]]);
  // Hook records: the claude session has both records (one lane), the codex one an observation only, the launched unit of the second run.
  const bySession = (id: string) => sessions.find((entry: any) => entry.sessionKey === key(id));
  const linked = bySession('fixture-session-linked-RAWID-1');
  assert.equal(linked.harness, 'claude');
  assert.equal(linked.model, 'claude-sonnet-4');
  assert.ok(linked.startedAt !== null && linked.lastHookRecordAt !== null, 'both records joined by the session key');
  const codex = bySession('fixture-session-main-RAWID-2');
  assert.equal(codex.harness, 'codex');
  assert.equal(codex.startedAt, null, 'an observation with no session directory');
  assert.ok(sessions.some((entry: any) => entry.kind === 'launched' && entry.launched.run === 'run-two' && entry.launched.lineage === 'lin2'));
  // Two Sessions hook sessions, and the four of the Fleet world (V.10: claude, codex, antigravity, opencode); the second projects' sessions are not listed.
  assert.equal(sessions.filter((entry: any) => entry.kind === 'hook').length, 6, 'the other projects\' sessions are not listed');
  const text = JSON.stringify(reply.json);
  assert.ok(!text.includes(key('fixture-session-other-RAWID-3')) && !text.includes('RAWID'), 'no key of another project, no raw session id');

  // Locks: a dead holder in the linked worktree, an unknown one in main, and the second project's, held from another directory.
  const holders = Object.fromEntries(sections.slots.data.slots.map((slot: any) => [slot.name, slot.holder]));
  assert.equal(holders.build.alive, false);
  assert.equal(holders.build.worktreeKey, checkouts[1].worktreeKey);
  assert.equal(holders.suite.alive, 'unknown');
  assert.equal(holders['other-suite'].worktreeKey, null);

  // The overlap held by two runs, and the 30 h claim.
  const entry = sections.tasks.data.find((item: any) => item.slug === RUNS.sessions.slug);
  assert.deepEqual(entry.overlaps, [{ a: 'S.1', b: 'S.2', fileCount: 1 }]);
  const claim = (task: string) => entry.active.find((a: any) => a.task === task);
  assert.notEqual(`${claim('S.1').run}/${claim('S.1').lineage}`, `${claim('S.2').run}/${claim('S.2').lineage}`);
  assert.ok(Date.now() - Date.parse(claim('S.3').startedAt) > 29 * 60 * 60 * 1000, 'S.3 was claimed about 30 h ago');
  assert.equal(limits.runsNotChecked, 0);

  // The real body, through the derivation: every conflict kind is there, and the rows come out in order.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-fixture-derive-'));
  try {
    fs.cpSync(path.join(__dirname, '..', 'web', 'derive'), path.join(dir, 'derive'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    const { deriveSessions } = await import(pathToFileURL(path.join(dir, 'derive', 'sessions.js')).href);
    const result = deriveSessions(reply.json, Date.now());
    assert.deepEqual([...new Set(result.conflicts.map((c: any) => c.code))].sort(), ['C1', 'C2', 'C3', 'C4']);
    assert.deepEqual(result.rows.map((r: any) => r.group), ['current', 'conflict', 'records']);
    assert.equal(result.rows[2].kind, 'unplaced', 'the lock held from another directory sits in its own last row');
    assert.equal(result.rows[1].conflicts.map((c: any) => c.code).sort().join(), 'C3,C4', 'the linked checkout: the dead holder and the commit after its last record');
    assert.equal(result.rows[0].lanes.find((l: any) => l.kind === 'run' && l.run === 'run-two').launched.length, 1, 'the launched unit joined its run lane');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  assert.deepEqual(Object.keys(parseFlags(['--core', CORE_CLI, '--empty', '--core-missing', '--keep', '--tick', '2', '--append', '1'])).sort(), ['append', 'coreMissing', 'core', 'empty', 'history', 'keep', 'manage', 'tick', 'workerLog'].sort()); // V.10 adds --append, 150 D.1 --worker-log, 152 D.1 --history
  for (const argv of [[], ['--core', 'relative/doflow.js'], ['--core', path.join(path.dirname(CORE_CLI), 'no-such.js')], ['--core', CORE_CLI, '--bogus'], ['--core', CORE_CLI, '--tick', '0'], ['--core', CORE_CLI, '--append', '0']]) {
    assert.ok('error' in parseFlags(argv), `refused: ${argv.join(' ')}`);
  }
});

const FIXTURE_SCRIPT = path.join(__dirname, '..', 'scripts', 'fixture-console.ts');

test('--worker-log takes a positive number of seconds; 0, a negative, a non-number, a missing value and --empty are usage errors', () => {
  assert.equal((parseFlags(['--core', CORE_CLI, '--worker-log', '86400']) as any).workerLog, 86400);
  assert.equal((parseFlags(['--core', CORE_CLI, '--worker-log', '0.5']) as any).workerLog, 0.5);
  assert.equal((parseFlags(['--core', CORE_CLI]) as any).workerLog, null);
  const bad = [['0'], ['-1'], ['abc'], ['1e3'], ['9999999'], [], ['--keep']].map((value) => ['--core', CORE_CLI, '--worker-log', ...value]);
  for (const argv of [...bad, ['--core', CORE_CLI, '--empty', '--worker-log', '5']]) {
    assert.ok('error' in parseFlags(argv), `refused: ${argv.join(' ')}`);
    const run = spawnSync(process.execPath, [FIXTURE_SCRIPT, ...argv], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 2, `${argv.join(' ')}: ${run.stderr}`);
    assert.equal(run.stdout, '', 'no URL line on a usage error');
    assert.match(run.stderr, /^fixture-console: --worker-log /);
    assert.match(run.stderr, /\[--worker-log <seconds>\]/, 'the usage line names --worker-log');
  }
});

test('--worker-log: feat-chain from real verbs, R1 alive with no log files, one line per stream per `log`, `log <n>` after the write, R1 ended after 24', { timeout: 240_000 }, async (t: any) => {
  // A seconds value far beyond the test, so every append comes from a stdin `log` line.
  const child = spawn(process.execPath, [FIXTURE_SCRIPT, '--core', CORE_CLI, '--worker-log', '86400'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code: number | null) => resolve(code)));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } });
  let out = '';
  let pending = '';
  const lines: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { out += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() as string;
    lines.push(...parts);
  });
  const until = async (find: () => any, what: string, ms = 180_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`the fixture exited ${child.exitCode} waiting for ${what}: ${lines.join('\n')}`);
      if (Date.now() > deadline) throw new Error(`no ${what} within ${ms} ms: ${lines.join('\n')}`);
      await sleep(10);
    }
  };
  const lineAt = (from: number, pattern: RegExp) => () => { for (let i = from; i < lines.length; i += 1) { const m = pattern.exec(lines[i]); if (m) return { index: i, m }; } return null; };

  // The first stdout line stays the Console URL.
  const urlLine = await until(() => /^doflow ui: (http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]{64}))\n/.exec(out), 'URL line');
  assert.match(urlLine[1], URL_FORM);
  const { m: where } = await until(lineAt(0, /^fixture-console: scratch directory (.+); project (.+)$/), 'project line');
  const project = where[2];
  const { m: named } = await until(lineAt(0, /^fixture-console: run-chain: R1 (w-[0-9a-f]{12})$/), 'R1 line');
  const r1 = named[1];
  const store = path.join(project, '.doflow', 'state', 'worker-runs', `${CHAIN.slug}.json`);
  const file = (stream: string) => path.join(project, '.doflow', 'state', 'worker-output', `${r1}.${stream}.log`);

  // The run, from real verbs: RUNNING in planning (discovery and design passed, gate-0 approved).
  const api = await session({ port: Number(urlLine[2]), code: urlLine[3] });
  const listed = row((await api.get('/api/runs')).json.runs, CHAIN.taskId);
  assert.equal(listed.featureSlug, CHAIN.slug);
  assert.equal(listed.state, 'RUNNING');
  assert.equal(listed.current.id, 'planning');

  // The world: every role of worker-world.ts, R1 running with this fixture process as its live supervisor, no log files yet.
  const before = readRuns(store);
  assert.equal(Object.keys(before).length, 12, 'the shared worker world');
  assert.equal(before[r1].phase, 'running');
  assert.equal(before[r1].childOf, null);
  assert.equal(before[r1].supervisor.pid, child.pid, 'R1\'s supervisor is the fixture process');
  assert.ok(Object.values(before).some((run: any) => run.childOf === r1), 'a child run of R1');
  assert.ok(!fs.existsSync(file('out')) && !fs.existsSync(file('err')), 'R1\'s out and err files do not exist before the first tick');

  const linesOf = (stream: string) => fs.readFileSync(file(stream), 'utf8').split('\n').slice(0, -1);
  for (let n = 1; n <= LOG_APPENDS; n += 1) {
    const from = lines.length;
    child.stdin.write('log\n');
    await until(lineAt(from, new RegExp(`^fixture-console: log ${n}$`)), `log ${n}`);
    // Read when the line arrives: the write had returned before it was printed.
    for (const stream of ['out', 'err']) {
      const text = linesOf(stream);
      assert.equal(text.length, n, `${stream} holds one line per tick at ${n}`);
      assert.match(text[n - 1], new RegExp(`^R1 ${stream} line ${n}( |$)`));
    }
    if (n < LOG_APPENDS) assert.equal(readRuns(store)[r1].phase, 'running', `R1 still runs after ${n}`);
  }
  await until(lineAt(0, /^fixture-console: R1 ended after 24 appends$/), 'the end line');
  const ended = readRuns(store)[r1];
  assert.equal(ended.phase, 'ended');
  assert.equal(ended.process.kind, 'exited');
  for (const [key, stream] of [['stdout', 'out'], ['stderr', 'err']]) {
    const size = fs.statSync(file(stream)).size;
    assert.deepEqual(ended.output[key], { path: `worker-output/${r1}.${stream}.log`, bytes: size, written: size, truncated: false }, `the ${key} pointer`);
  }
  // Nothing past the 24th.
  const from = lines.length;
  child.stdin.write('log\n');
  await until(lineAt(from, /^fixture-console: no log line left$/), 'the exhausted line');
  assert.equal(linesOf('out').length, LOG_APPENDS);

  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(!fs.existsSync(project), 'the scratch project is removed on exit');
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
  // DEC-048: 24 more ticks, each an annotation of implementation that adds one timeline entry (read from the core: the route caches 2 s).
  const events = () => {
    const result = spawnSync(process.execPath, [CORE_CLI, 'orchestrate', '--action', 'timeline', '--task-id', RUNS.tick.taskId, '--slug', RUNS.tick.slug, '--json'],
      { cwd: full.project, env: { ...full.env, DOFLOW_UPKEEP: 'off' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).events;
  };
  let count = events().length;
  for (let k = 1; k <= 24; k += 1) {
    assert.match(full.tick(), new RegExp(`implementation annotated, tick ${k}$`));
    const now = events();
    assert.equal(now.length, count + 1, `tick ${k} adds one timeline entry`);
    assert.equal(now[now.length - 1].action, 'annotate');
    assert.equal(now[now.length - 1].node, 'implementation');
    count = now.length;
  }
  assert.equal(full.tick(), null);
});

test('the Fleet fixture (V.10): two projects, the harness homes, nodes with their transcript notes, and the appending writer', async () => {
  const listed = await fullApi.get('/api/fleet');
  assert.equal(listed.status, 200);
  const body = listed.json;
  assert.equal(body.store, 'present');
  assert.deepEqual(body.projects.map((p: any) => [p.label, p.current]), [['main', true], ['beta', false]], 'the Console\'s project first, then the second');
  assert.ok(body.excluded.notDoflow >= 1, 'the Sessions fixture\'s second repository has no DoFlow state and is counted');
  const [alpha, beta] = body.projects;
  assert.equal(alpha.tree.ok, true);
  assert.equal(beta.tree.ok, true);
  const nodes = alpha.tree.data.nodes;
  const by = (harness: string) => nodes.filter((n: any) => n.harness === harness);
  assert.ok(by('claude').length >= 3, 'the Claude main session and its two subagents');
  assert.ok(nodes.some((n: any) => n.kind === 'harness-subagent' && n.harness === 'claude'));
  assert.equal(by('opencode')[0].transcript.reason, 'no-reader');
  assert.equal(by('antigravity')[0].transcript.reason, 'not-linked');
  assert.ok(nodes.some((n: any) => n.transcript.linked), 'a transcript is linked');
  assert.equal(beta.tree.data.nodes.length >= 1, true);
  const text = JSON.stringify(body);
  for (const marker of ['/work/fixture-project', 'fa000000', 'fx-Secret-4471', 'fixture.person@example.invalid', full.project, full.dir]) assert.ok(!text.includes(marker), `no ${marker} in the Fleet body`);

  // The appending writer: a reply, a tool call and its result show in the transcript within one read.
  const agent = nodes.find((n: any) => n.harness === 'claude' && n.kind === 'main-session' && n.transcript.linked);
  assert.ok(agent, 'the Claude main session is linked to its transcript');
  const url = `/api/transcript?project=${alpha.projectKey}&agent=${agent.agentKey}`;
  const first = await fullApi.get(url);
  assert.equal(first.status, 200);
  const before = JSON.stringify(first.json.events);
  assert.ok(!before.includes('FIXTURE-APPEND-1'));
  const wrote = full.append();
  assert.equal(wrote, 'FIXTURE-APPEND-1');
  const second = await fullApi.get(`${url}&cursor=${encodeURIComponent(first.json.cursor)}`);
  assert.equal(second.status, 200);
  const replies = second.json.events.filter((e: any) => e.kind === 'reply').map((e: any) => e.text);
  assert.ok(replies.some((t: string) => t.includes('FIXTURE-APPEND-1')), `the appended reply is read from the old cursor: ${JSON.stringify(replies)}`);
  assert.ok(second.json.events.some((e: any) => e.kind === 'tool-call'));
  assert.ok(!JSON.stringify(second.json).includes('FIXTURE-APPEND-RESULT'), 'tool-result text never arrives');
});


test('--manage adds the management world and refuses --empty', { timeout: 240_000 }, async () => {
  assert.equal((parseFlags(['--core', CORE_CLI, '--manage']) as any).manage, true);
  const refused = spawnSync(process.execPath, [FIXTURE_SCRIPT, '--core', CORE_CLI, '--manage', '--empty'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /--manage cannot be combined with --empty/);
  assert.match(refused.stderr, /\[--manage\]/);
  const app = await startFixtureConsole({ core: CORE_CLI, manage: true });
  try {
    const api = await session(app);
    const settings = await api.get('/api/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.json.sections.effective.ok, true);
    const effective = settings.json.sections.effective.data;
    assert.equal(effective.keys.length, 47);
    assert.equal(effective.keys.find((row: any) => row.key === 'advice.enabled').views[0].origin.via, 'fail-safe');
    assert.ok(effective.files.some((file: any) => file.layer === 'local' && file.code === 'unparseable'));
    const followups = await api.get('/api/followups?state=open');
    assert.equal(followups.status, 200);
    assert.equal(followups.json.sections.list.data.count, 60);
    const advice = await api.get('/api/advice');
    assert.equal(advice.status, 200);
    assert.ok(advice.json.sections.picks.data.days.filter((day: any) => (day.picks['task-class'] ?? 0) > 0).length >= 3);
  } finally { await app.stop(); }
});

test('--history adds completed history runs and refuses --empty', { timeout: 240_000 }, async () => {
  assert.equal((parseFlags(['--core', CORE_CLI, '--history']) as any).history, true);
  const refused = spawnSync(process.execPath, [FIXTURE_SCRIPT, '--core', CORE_CLI, '--history', '--empty'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /--history cannot be combined with --empty/);
  assert.match(refused.stderr, /\[--history\]/);
  const app = await startFixtureConsole({ core: CORE_CLI, history: true });
  try {
    const api = await session(app);
    const hist = await api.get('/api/sessions-history');
    assert.equal(hist.status, 200);
    assert.equal(hist.json.v, 1);
    assert.ok(Array.isArray(hist.json.sessions));
    assert.ok(hist.json.sessions.length >= 3);
  } finally { await app.stop(); }
});
