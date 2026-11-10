'use strict';

// 149 IC-004: every section of every channel kind is the `{exit, json}` the matching verb prints with
// `--json`. Over one fixture (a git project with an orchestration run, a feature plan with two active
// attempts and a worker run, a session directory, a slot file and no roadmap seed), each section of
// `channelSpec(...).compute()` is compared with the exit code and parsed stdout of `doflow <verb> ...
// --json` run in the same directory with the same environment: the documented failures included
// (a missing run, status exit 1; a missing plan, inspect exit 2; no seed, roadmap exit 2). Releasing an
// attempt lists its worker section in `removed`. The declared sources and derived list of each channel
// are checked, and computing writes nothing. 150 IC-009: `tasks:` `runs` and `worker:` `result` equal
// the `worker-runs` and `worker-result` handlers' `--json` output and their body functions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { channelSpec, resolveContext, findWorkerRun, workerSources, CATALOGUE, WORKER_SECTIONS, WORKER_SECTION_LIMIT } = require('../../src/runtime/events/sections.ts');
const { workerResultBody, workerRunsBody, handleWorkerResultCommand, handleWorkerRunsCommand } = require('../../src/runtime/worker/reads.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SLUG = 'feat-a';
const RUN_ID = 'w-0123456789ab';
const MISSING_RUN_ID = 'w-ffffffffffff';

const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '',
  '### Phase A', '',
  '- [ ] A.1 [P] first; owner: core-implementer; files: a.js',
  '- [ ] A.2 [P] second; owner: quality-guardian; files: b.js',
  '',
].join('\n');

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A pid that has exited: a child that ran and was reaped. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  assert.equal(r.status, 0);
  return r.pid;
}

function treeSnapshot(root: string) {
  const entries: any = {};
  const visit = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const info = fs.lstatSync(file, { bigint: true });
      const base = { mtimeNs: info.mtimeNs.toString(), ino: info.ino.toString() };
      const rel = path.relative(root, file);
      if (info.isDirectory()) { entries[rel] = { type: 'dir', ...base }; visit(file); }
      else if (info.isFile()) entries[rel] = { type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ...base };
      else entries[rel] = { type: 'other', ...base };
    }
  };
  visit(root);
  return entries;
}

function fixture(t: any) {
  const root = tempDir(t, 'doflow-events-sections-');
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), main: path.join(root, 'proj') };
  for (const d of [f.home, f.config, f.main]) fs.mkdirSync(d, { recursive: true });
  git(f.main, 'init', '-q', '-b', 'main');
  for (const name of ['a.js', 'b.js']) fs.writeFileSync(path.join(f.main, name), `// ${name}\n`);
  git(f.main, 'add', '-A');
  git(f.main, 'commit', '-q', '-m', 'first');
  f.env = {
    HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.config,
    PATH: process.platform === 'win32' ? process.env.PATH : `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    DOFLOW_UPKEEP: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_FAILURE_CAPTURE: 'off',
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: f.main,
  };
  return f;
}

function cli(f: any, args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: f.main, env: f.env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  let json: any = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { exit: r.status, json, stderr: r.stderr };
}

function ok(f: any, args: string[]) {
  const r = cli(f, args);
  assert.equal(r.exit, 0, `${args.join(' ')}: ${r.stderr} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** One run, a plan with A.1 and A.2 active, a worker run on A.1, a session directory, a dead-holder slot. */
function plant(f: any) {
  ok(f, ['orchestrate', '--action', 'start', '--task-id', 'a1', '--task-class', 'feature', '--slug', SLUG]);
  const planFile = path.join(f.main, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  ok(f, ['task-attempt', '--action', 'start', '--slug', SLUG, '--by', 'tester']);
  f.tokenA1 = ok(f, ['task-attempt', '--action', 'claim', '--slug', SLUG, '--task', 'A.1', '--owner', 'core-implementer', '--mode', 'subagent', '--epoch', '1']).token;
  f.tokenA2 = ok(f, ['task-attempt', '--action', 'claim', '--slug', SLUG, '--task', 'A.2', '--owner', 'quality-guardian', '--mode', 'manual', '--epoch', '1']).token;
  f.workerRuns = path.join(f.main, '.doflow', 'state', 'worker-runs', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(f.workerRuns), { recursive: true });
  f.run = {
    runId: RUN_ID, task: 'A.1', token: f.tokenA1, harness: 'codex', phase: 'ended', seq: 3, childOf: null, request: null,
    createdAt: '2026-01-05T00:00:00.000Z', startedAt: '2026-01-05T00:00:01.000Z', deadline: '2026-01-05T00:10:00.000Z',
    end: { state: 'exited', at: '2026-01-05T00:05:00.000Z' },
  };
  fs.writeFileSync(f.workerRuns, JSON.stringify({ slug: SLUG, runs: { [RUN_ID]: f.run }, version: 1, revision: 4 }, null, 2));
  f.sessions = path.join(f.config, 'doflow', 'session-env', 'sessions');
  const session = path.join(f.sessions, 'events-session-1');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, 'git-context.json'), JSON.stringify({ branch: 'main', sha: '', cwd: f.main, captured_at: '2026-01-03T00:00:00Z' }));
  f.slots = path.join(f.home, '.doflow', 'state', 'slots');
  fs.mkdirSync(f.slots, { recursive: true });
  fs.writeFileSync(path.join(f.slots, 'build.json'), JSON.stringify({
    name: 'build', holder: { pid: deadPid(), start: 'x', childPid: null, childStart: null, label: 'build@x', since: '2026-01-01T00:00:00.000Z', cwd: f.main },
    waiters: [], lastRelease: null,
  }));
}

/** The section equals the CLI's answer: the same exit code and deep-equal parsed stdout. */
function same(own: any, theirs: any, label: string) {
  assert.ok(own, `${label}: section present`);
  assert.equal(own.exit, theirs.exit, `${label}: exit (${theirs.stderr})`);
  assert.deepEqual(own.json, theirs.json, label);
}

const dirsOf = (sources: any) => sources.directories.map((d: any) => d.path);

/**
 * 150 IC-009: a `worker-runs` or `worker-result` CLI handler run in-process with `--json`, its stdout
 * captured: the exit code and the parsed line, as `cli` returns them. `process.exitCode` is restored.
 */
function handlerJson(handler: any, options: any) {
  let text = '';
  const stdout = { write(s: string) { text += s; } };
  const stderr = { write() {} };
  const saved = process.exitCode;
  let exit: number;
  try { exit = handler({ json: true, ...options, stdout, stderr }); } finally { process.exitCode = saved; }
  return { exit, json: JSON.parse(text) };
}

/** A body function's `{exit, json}` as its handler prints it: `json` through one JSON round trip. */
const printed = (body: any) => ({ exit: body.exit, json: JSON.parse(JSON.stringify(body.json)) });

test('IC-004: every section of every channel kind equals its verb with --json over one fixture', async (t) => {
  const f = fixture(t);
  plant(f);
  const ctx = { cwd: f.main, env: f.env };
  const state = path.join(f.main, '.doflow', 'state');

  await t.test('resolveContext names the roots the CLI resolves', () => {
    const c = resolveContext(ctx);
    assert.equal(c.stateRoot, f.main);
    assert.equal(c.lifecycleRoot, f.main);
    assert.equal(c.mainRoot, f.main);
    assert.equal(c.sessionsDir, f.sessions);
    assert.equal(c.slotsDir, f.slots);
  });

  await t.test('now: list, observed, slots and roadmap (no seed, exit 2)', async () => {
    const spec = channelSpec('now', ctx);
    assert.deepEqual(spec.sectionNames(), ['list', 'observed', 'slots', 'roadmap']);
    assert.deepEqual([...spec.derived], ['observed', 'slots']);
    assert.deepEqual(['list', 'observed', 'slots', 'roadmap'].map((n) => spec.isDerived(n)), [false, true, true, false]);
    const before = treeSnapshot(f.root);
    const { sections, removed } = await spec.compute();
    assert.deepEqual(treeSnapshot(f.root), before, 'computing wrote nothing');
    assert.equal(removed, undefined);
    assert.deepEqual(Object.keys(sections), ['list', 'observed', 'slots', 'roadmap']);
    same(sections.list, cli(f, ['orchestrate', '--action', 'list']), 'list');
    assert.deepEqual(sections.list.json.runs.map((r: any) => r.taskId), ['a1']);
    same(sections.observed, cli(f, ['primary', '--action', 'observed']), 'observed');
    assert.equal(sections.observed.json.sessions.length, 1);
    same(sections.slots, cli(f, ['slot', '--action', 'peek']), 'slots');
    assert.equal(sections.slots.json.slots[0].holder.alive, false);
    same(sections.roadmap, cli(f, ['roadmap', '--action', 'status']), 'roadmap');
    assert.equal(sections.roadmap.exit, 2, 'a missing seed is the documented usage error');

    const derivedOnly = await spec.compute(spec.derived);
    assert.deepEqual(Object.keys(derivedOnly.sections), ['observed', 'slots']);
    await assert.rejects(spec.compute(['attempts']), TypeError);

    const sources = spec.sources();
    assert.equal(sources.primary, null, 'now has no primary record');
    assert.deepEqual(sources.derived, ['observed', 'slots']);
    const dirs = dirsOf(sources);
    for (const dir of [path.join(state, 'orchestration'), path.join(state, 'orchestration', SLUG), path.join(f.main, '.git', 'worktrees'),
      f.sessions, f.slots, path.join(state, 'roadmap'), path.join(state, 'roadmap', 'runs'), path.join(f.main, 'agent-docs', 'roadmap')]) {
      assert.ok(dirs.includes(dir), `now declares ${dir}`);
    }
    const store = sources.directories.find((d: any) => d.path === path.join(state, 'orchestration'));
    assert.ok(store.match.test(SLUG) && store.match.test('a1.json') && !store.match.test('a1.json.lock') && !store.match.test('a1.json.123.tmp'));
  });

  await t.test('run:<slug>:<task>: status and timeline, and a missing run (exit 1)', async () => {
    const spec = channelSpec(`run:${SLUG}:a1`, ctx);
    assert.deepEqual(spec.sectionNames(), ['status', 'timeline']);
    assert.deepEqual([...spec.derived], []);
    const { sections } = await spec.compute();
    same(sections.status, cli(f, ['orchestrate', '--action', 'status', '--task-id', 'a1', '--slug', SLUG]), 'status');
    same(sections.timeline, cli(f, ['orchestrate', '--action', 'timeline', '--task-id', 'a1', '--slug', SLUG]), 'timeline');
    assert.equal(sections.status.exit, 0);
    const journal = path.join(state, 'orchestration', SLUG, 'a1.json');
    assert.ok(fs.existsSync(journal));
    const sources = spec.sources();
    assert.deepEqual(sources.primary, { path: journal });
    assert.ok(dirsOf(sources).includes(path.dirname(journal)));
    assert.deepEqual(sources.derived, []);

    const missing = channelSpec(`run:${SLUG}:zz9`, ctx);
    const gone = await missing.compute();
    same(gone.sections.status, cli(f, ['orchestrate', '--action', 'status', '--task-id', 'zz9', '--slug', SLUG]), 'missing status');
    same(gone.sections.timeline, cli(f, ['orchestrate', '--action', 'timeline', '--task-id', 'zz9', '--slug', SLUG]), 'missing timeline');
    assert.deepEqual(gone.sections.status, { exit: 1, json: null });
    assert.deepEqual(missing.sources().primary, { path: path.join(state, 'orchestration', SLUG, 'zz9.json') }, 'the expected journal while there is none');
  });

  await t.test('tasks:<slug>: attempts, a worker section per active attempt, then removed when one ends', async () => {
    const spec = channelSpec(`tasks:${SLUG}`, ctx);
    assert.deepEqual([...spec.derived], [WORKER_SECTIONS]);
    assert.equal(WORKER_SECTION_LIMIT, 16);
    const first = await spec.compute();
    const w1 = `worker:A.1:${f.tokenA1}`;
    const w2 = `worker:A.2:${f.tokenA2}`;
    assert.deepEqual(Object.keys(first.sections), ['attempts', 'runs', w1, w2], 'task order then attempt order');
    assert.equal(first.removed, undefined);
    assert.deepEqual(spec.sectionNames(), ['attempts', 'runs', w1, w2]);
    assert.ok(spec.isDerived(w1) && !spec.isDerived('attempts'));
    assert.equal(spec.isDerived('runs'), false, 'runs is not derived from the clock or a process');
    same(first.sections.attempts, cli(f, ['task-attempt', '--action', 'inspect', '--slug', SLUG]), 'attempts');
    same(first.sections.runs, handlerJson(handleWorkerRunsCommand, { slug: SLUG, cwd: f.main, env: f.env }), 'runs = worker-runs handler');
    same(first.sections.runs, printed(workerRunsBody({ slug: SLUG, cwd: f.main, env: f.env })), 'runs = workerRunsBody');
    assert.equal(first.sections.runs.exit, 0);
    assert.deepEqual(first.sections.runs.json.runs.map((r: any) => r.runId), [RUN_ID]);
    assert.deepEqual(first.sections.runs.json.limits, { shown: 1, notShown: 0 });
    same(first.sections[w1], cli(f, ['worker', '--action', 'status', '--slug', SLUG, '--task', 'A.1', '--token', String(f.tokenA1)]), w1);
    same(first.sections[w2], cli(f, ['worker', '--action', 'status', '--slug', SLUG, '--task', 'A.2', '--token', String(f.tokenA2)]), w2);
    assert.equal(first.sections[w1].json.runId, RUN_ID);
    assert.equal(first.sections[w2].json.run, null, 'an active attempt with no worker run');

    const sources = spec.sources();
    assert.deepEqual(sources.primary, { path: path.join(state, 'task-attempts', `${SLUG}.json`) });
    assert.deepEqual(sources.derived, [WORKER_SECTIONS]);
    for (const dir of [path.join(state, 'task-attempts'), path.join(state, 'worker-runs'), path.join(f.main, 'agent-docs', 'doflow', SLUG)]) {
      assert.ok(dirsOf(sources).includes(dir), `tasks declares ${dir}`);
    }
    const ledgerDir = sources.directories.find((d: any) => d.path === path.join(state, 'task-attempts'));
    assert.ok(ledgerDir.match.test(`${SLUG}.json`) && !ledgerDir.match.test(`${SLUG}.json.lock`) && !ledgerDir.match.test('feat-ab.json'));

    ok(f, ['task-attempt', '--action', 'release', '--slug', SLUG, '--task', 'A.1', '--token', String(f.tokenA1), '--reason', 'done here']);
    const derivedPass = await spec.compute(spec.derived);
    assert.deepEqual(derivedPass.removed, [w1]);
    assert.deepEqual(Object.keys(derivedPass.sections), ['attempts', w2], 'a worker recompute returns the attempts it read');
    same(derivedPass.sections.attempts, cli(f, ['task-attempt', '--action', 'inspect', '--slug', SLUG]), 'attempts after release');
    same(derivedPass.sections[w2], cli(f, ['worker', '--action', 'status', '--slug', SLUG, '--task', 'A.2', '--token', String(f.tokenA2)]), `${w2} after release`);
    assert.equal((await spec.compute()).removed, undefined, 'removed is reported once');
    assert.deepEqual(Object.keys((await spec.compute(['attempts'])).sections), ['attempts']);
    assert.deepEqual(Object.keys((await spec.compute(['runs'])).sections), ['attempts', 'runs'], 'attempts is always read with the asked sections');
  });

  await t.test('tasks:<slug> with no plan is inspect exit 2 plan-unreadable', async () => {
    const spec = channelSpec('tasks:feat-none', ctx);
    const { sections, removed } = await spec.compute();
    assert.deepEqual(Object.keys(sections), ['attempts', 'runs']);
    assert.equal(removed, undefined);
    same(sections.attempts, cli(f, ['task-attempt', '--action', 'inspect', '--slug', 'feat-none']), 'attempts without a plan');
    assert.equal(sections.attempts.exit, 2);
    assert.equal(sections.attempts.json.error, 'plan-unreadable');
    same(sections.runs, handlerJson(handleWorkerRunsCommand, { slug: 'feat-none', cwd: f.main, env: f.env }), 'runs of a feature with no store');
    assert.equal(sections.runs.exit, 0);
    assert.equal(sections.runs.json.store, 'absent');
  });

  await t.test('worker:<runId>: status and result of the run, and of a run no store holds', async () => {
    const spec = channelSpec(`worker:${RUN_ID}`, ctx);
    assert.deepEqual(spec.sectionNames(), ['status', 'result']);
    assert.deepEqual([...spec.derived], ['status']);
    assert.equal(spec.isDerived('result'), false, 'result is not derived from the clock or a process');
    const { sections } = await spec.compute();
    assert.deepEqual(Object.keys(sections), ['status', 'result']);
    same(sections.status, cli(f, ['worker', '--action', 'status', '--slug', SLUG, '--worker-run', RUN_ID]), 'worker status');
    same(sections.status, cli(f, ['worker', '--action', 'status', '--slug', SLUG, '--task', 'A.1', '--token', String(f.tokenA1)]), 'worker status by task and token');
    assert.equal(sections.status.json.runId, RUN_ID);
    same(sections.result, handlerJson(handleWorkerResultCommand, { workerRun: RUN_ID, slug: SLUG, cwd: f.main, env: f.env }), 'result = worker-result handler');
    same(sections.result, printed(workerResultBody({ workerRun: RUN_ID, slug: SLUG, cwd: f.main, env: f.env })), 'result = workerResultBody');
    assert.equal(sections.result.exit, 0);
    assert.equal(sections.result.json.runId, RUN_ID);
    assert.equal(sections.result.json.endState, 'exited');
    assert.deepEqual(Object.keys((await spec.compute(spec.derived)).sections), ['status'], 'a derived pass leaves result alone');
    assert.deepEqual(Object.keys((await spec.compute(['result'])).sections), ['result']);
    const sources = spec.sources();
    assert.equal(sources.primary.path, f.workerRuns);
    const doc = JSON.parse(fs.readFileSync(f.workerRuns, 'utf8'));
    assert.deepEqual(sources.primary.pick(doc), f.run);
    assert.equal(sources.primary.pick({ runs: {} }), undefined);
    assert.ok(dirsOf(sources).includes(path.join(state, 'worker-runs')));
    assert.deepEqual(sources.derived, ['status']);

    const missing = channelSpec(`worker:${MISSING_RUN_ID}`, ctx);
    const answer = await missing.compute();
    same(answer.sections.status, cli(f, ['worker', '--action', 'status', '--worker-run', MISSING_RUN_ID]), 'unknown worker run');
    assert.notEqual(answer.sections.status.exit, 0);
    same(answer.sections.result, handlerJson(handleWorkerResultCommand, { workerRun: MISSING_RUN_ID, cwd: f.main, env: f.env }), 'result of an unknown worker run');
    assert.deepEqual(answer.sections.result, { exit: 1, json: { v: 1, ok: false, error: 'unknown-run' } });
    assert.equal(missing.sources().primary, null, 'no primary record while no store holds the run');
  });

  await t.test('findWorkerRun and workerSources are exported as the worker channel uses them', () => {
    const c = resolveContext(ctx);
    assert.deepEqual(findWorkerRun(c, RUN_ID), { slug: SLUG, file: f.workerRuns });
    assert.equal(findWorkerRun(c, MISSING_RUN_ID), null);
    const sources = workerSources(c, RUN_ID);
    assert.equal(sources.primary.path, f.workerRuns);
    assert.deepEqual(dirsOf(sources), dirsOf(channelSpec(`worker:${RUN_ID}`, ctx).sources()));
    assert.deepEqual(sources.derived, [...CATALOGUE.worker.derived]);
  });
});
