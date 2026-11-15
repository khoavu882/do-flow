'use strict';

// Feature 161 T3 (D4, D9, IC-001, IC-002, IC-008, NFR-002): the `machine` channel and the project
// index behind it. Scratch HOME and config home, scratch git projects; the in-process case injects
// the clock, the watch and a counting exec so the git processes of the index are counted: git runs
// on an index refresh only, never per pass.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { handleEventsCommand } = require('../../src/runtime/events/command.ts');
const { channelSpec } = require('../../src/runtime/events/sections.ts');
const { createProjectsIndex, REFRESH_MS } = require('../../src/runtime/events/projects-index.ts');
const { ACTIVITY_PROJECTS, GATE_LIMIT, STARTED_LIMIT } = require('../../src/runtime/events/machine.ts');

const WIN = process.platform === 'win32';
const SCRATCH = 'scratch.noindex'; // not in any fixture path, so the scratch projects are listed

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakeClock() {
  let now = Date.UTC(2026, 10, 15);
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: null }); return nextId; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: ms }); return nextId; },
    clearInterval(id: number) { timers.delete(id); },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await settle();
        let pick: [number, { at: number; fn: () => void; every: number | null }] | null = null;
        for (const entry of timers) if (entry[1].at <= target && (!pick || entry[1].at < pick[1].at)) pick = entry;
        if (!pick) break;
        const [id, timer] = pick;
        now = timer.at;
        if (timer.every !== null) timer.at += timer.every; else timers.delete(id);
        timer.fn();
      }
      now = target;
      await settle();
    },
  };
}

function fakeWatch() {
  return (dir: string) => ({ dir, close() {}, on() { return this; } });
}

function fakeStdin() {
  const stdin: any = new EventEmitter();
  stdin.pause = () => {};
  stdin.destroy = () => {};
  stdin.json = (op: string, ch: string) => stdin.emit('data', Buffer.from(`${JSON.stringify({ op, ch })}\n`, 'utf8'));
  return stdin;
}

function sink() {
  const s: any = { text: '', write(chunk: string) { s.text += chunk; return true; } };
  s.frames = () => s.text.split('\n').filter((l: string) => l !== '').map((l: string) => JSON.parse(l));
  return s;
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

function fixture(t: any) {
  const root = fs.realpathSync(tempDir(t, 'doflow-events-machine-'));
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config') };
  fs.mkdirSync(path.join(f.home, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(path.join(f.config, 'doflow'), { recursive: true });
  f.env = {
    HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.config, TMPDIR: process.env.TMPDIR,
    PATH: process.env.PATH, ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, DOFLOW_TELEMETRY: 'off',
  };
  return f;
}

/** A DoFlow project (a git repository with `.doflow/state`), registered in `upkeep-roots`. */
function project(f: any, name: string): string {
  const dir = path.join(f.root, name);
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.appendFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${dir}\n`);
  return dir;
}

/** spawnSync, counted: each call's git subcommand. */
function countingExec() {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[], options: any) => {
    calls.push(args[0] === '-C' ? args[2] : args[0]);
    return spawnSync(cmd, args, options);
  };
  return { exec, calls, count: (sub: string) => calls.filter((c) => c === sub).length };
}

function indexFor(f: any, cwd: string, exec: any, now: () => number = Date.now) {
  return createProjectsIndex({ env: f.env, cwd, exec, now, tempRoots: [], scratchName: SCRATCH });
}

function journal(root: string, slug: string | null, taskId: string, changes: any = {}): string {
  const file = path.join(root, '.doflow', 'state', 'orchestration', ...(slug ? [slug] : []), `${taskId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1, taskId, taskClass: 'feature', workflowName: 'Feature Delivery', terminalStage: null, state: 'RUNNING', cursor: 0,
    program: [{ type: 'stage', id: 'build', status: 'pending' }], history: [], revision: 1, updatedAt: '2026-11-15T00:00:00.000Z', ...changes,
  }, null, 2));
  return file;
}

function awaiting(root: string, slug: string | null, taskId: string, gateId: string, updatedAt: string): string {
  return journal(root, slug, taskId, {
    state: 'AWAITING_GATE', updatedAt,
    program: [{ type: 'gate', id: gateId, kind: 'approval', name: `Approve ${gateId}`, prompt: 'PRIVATE-PROMPT-161', status: 'pending' }],
  });
}

const machineOf = (frames: any[]) => frames.filter((frame) => frame.ch === 'machine');
const keysOf = (body: any) => body.projects.map((p: any) => p.projectKey);

test('161 T3: a second project registered in upkeep-roots appears as a patch on machine within the next pass, and the index ran git once per candidate, not per pass', async (t) => {
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const counter = countingExec();
  const clock = fakeClock();
  const stdin = fakeStdin();
  const stdout = sink();
  const stderr = sink();
  const done = handleEventsCommand({
    follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd: a, env: f.env,
    stdin, stdout, stderr, clock, watch: fakeWatch(), signals: new EventEmitter(), epoch: '0a1b2c3d',
    projectsIndex: indexFor(f, a, counter.exec, () => clock.now()),
  });

  stdin.json('sub', 'machine');
  await settle();
  const [snapshot] = machineOf(stdout.frames());
  assert.equal(snapshot.type, 'snapshot', stdout.text + stderr.text);
  assert.deepEqual(Object.keys(snapshot.data.sections).sort(), ['activity', 'projects']);
  assert.deepEqual(keysOf(snapshot.data.sections.projects.json), [cwdHash(a)]);
  // One refresh: a rev-parse per candidate plus the cwd's, a worktree list per project.
  assert.deepEqual([counter.count('rev-parse'), counter.count('worktree')], [2, 1]);

  await clock.advance(3000); // three 1 s passes with nothing changed
  assert.equal(counter.calls.length, 3, 'no git process on a pass that found nothing moved');
  assert.equal(machineOf(stdout.frames()).length, 1);

  const b = project(f, 'proj-b');
  await clock.advance(1100); // the next pass sees upkeep-roots move
  const patch = machineOf(stdout.frames()).find((frame) => frame.type === 'patch');
  assert.ok(patch, `a machine patch within the next pass: ${stdout.text}`);
  assert.deepEqual([...keysOf(patch.data.sections.projects.json)].sort(), [cwdHash(a), cwdHash(b)].sort());
  assert.deepEqual(patch.data.sections.activity.json.items.map((i: any) => i.projectKey).sort(), [cwdHash(a), cwdHash(b)].sort());
  // The second refresh: two candidates plus the cwd, one worktree list per project.
  assert.deepEqual([counter.count('rev-parse'), counter.count('worktree')], [2 + 3, 1 + 2]);
  const afterRefresh = counter.calls.length;

  // The new project's store was swapped into the detector's sources: an awaiting gate there is a patch.
  awaiting(b, 'feat-b', 't1', 'gate-a', '2026-11-15T01:00:00.000Z');
  await clock.advance(1100);
  const last = machineOf(stdout.frames()).at(-1);
  assert.equal(last.type, 'patch');
  assert.deepEqual(Object.keys(last.data.sections), ['activity'], 'a store change recomputes activity only');
  const item = last.data.sections.activity.json.items.find((i: any) => i.projectKey === cwdHash(b));
  assert.deepEqual(item.runs, { open: 1, awaiting: 1 });
  assert.deepEqual(item.gates.map((g: any) => [g.slug, g.taskId, g.gateId]), [['feat-b', 't1', 'gate-a']]);

  await clock.advance(20000); // passes and derived passes up to 25 s: no refresh
  assert.equal(counter.calls.length, afterRefresh, 'activity recomputes and passes start no git process');
  stdin.emit('end');
  assert.equal(await done, 0);
  assert.equal(stderr.text, '');
  assert.ok(!stdout.text.includes(f.root), 'no absolute path leaves the core');
  assert.ok(!stdout.text.includes('PRIVATE-PROMPT-161'), 'no gate prompt');
});

test('161 IC-002: projects is the fleet body without root; activity summarizes the first 16 with notShown', async (t) => {
  const f = fixture(t);
  const roots: string[] = [];
  for (let i = 0; i < ACTIVITY_PROJECTS + 1; i += 1) roots.push(project(f, `p${String(i).padStart(2, '0')}`));
  const counter = countingExec();
  const index = indexFor(f, roots[0], counter.exec);
  const spec = channelSpec('machine', { cwd: roots[0], env: f.env, index, counts: () => ({ watched: 7, fingerprintOnly: 2 }) });
  const { sections } = await spec.compute();
  const projects = sections.projects.json;
  assert.equal(sections.projects.exit, 0);
  assert.deepEqual(Object.keys(projects).sort(), ['excluded', 'projects', 'store', 'truncated', 'v']);
  assert.equal(projects.projects.length, ACTIVITY_PROJECTS + 1);
  for (const p of projects.projects) assert.deepEqual(Object.keys(p).sort(), ['checkouts', 'current', 'label', 'lastRecordAt', 'projectKey', 'sources', 'temp']);
  const activity = sections.activity.json;
  assert.deepEqual(Object.keys(activity).sort(), ['items', 'limits', 'v']);
  assert.deepEqual(activity.limits, { projects: 16, notShown: 1, watched: 7, fingerprintOnly: 2 });
  assert.deepEqual(activity.items.map((i: any) => i.projectKey), keysOf(projects).slice(0, 16), 'the first 16 in projects order');
  for (const item of activity.items) {
    assert.deepEqual(Object.keys(item).sort(), ['gates', 'projectKey', 'runs', 'sessions', 'started', 'startedCount', 'unreadable', 'workers']);
    assert.deepEqual([item.runs, item.gates, item.workers, item.sessions, item.started, item.startedCount, item.unreadable], [{ open: 0, awaiting: 0 }, [], { open: 0 }, { observed: 0, harnesses: [] }, [], 0, []]);
  }
  const text = JSON.stringify(sections);
  for (const root of roots) assert.ok(!text.includes(root), 'no project path');
  const gitCalls = counter.calls.length;
  await spec.compute(['activity']);
  await spec.compute(['projects', 'activity']);
  assert.equal(counter.calls.length, gitCalls, 'a recompute with nothing moved starts no git process');
  // The declared sources: the index stores mark both sections, each shown project's stores activity only.
  const sources = spec.sources();
  assert.deepEqual(sources.policies, { activity: { throttleMs: 1000 } });
  assert.deepEqual(sources.directories.filter((d: any) => d.sections.includes('projects')).map((d: any) => path.basename(d.path)).sort(), ['projects', 'state']);
  const rootOf = (key: string) => roots.find((root) => cwdHash(root) === key) as string;
  assert.ok(sources.directories.some((d: any) => d.path === path.join(rootOf(keysOf(projects)[15]), '.doflow', 'state', 'worker-runs')));
  const unshown = rootOf(keysOf(projects)[16]);
  assert.ok(!sources.directories.some((d: any) => d.path.startsWith(unshown + path.sep)), 'the 17th project is not watched');
});

test('161 IC-002: awaiting gates newest first and at most 8, open runs and workers, observed sessions, and unreadable stores by name', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  for (let i = 0; i < GATE_LIMIT + 2; i += 1) awaiting(a, 'feat-a', `g${i}`, `gate-${i}`, `2026-11-15T0${i}:00:00.000Z`);
  journal(a, 'feat-a', 'running-1');
  journal(a, null, 'done-1', { state: 'COMPLETED' });
  const workers = path.join(a, '.doflow', 'state', 'worker-runs');
  fs.mkdirSync(workers, { recursive: true });
  fs.writeFileSync(path.join(workers, 'feat-a.json'), JSON.stringify({ version: 1, revision: 2, runs: {
    'w-0123456789ab': { phase: 'running', seq: 1 }, 'w-0123456789ac': { phase: 'ended', seq: 3 }, 'w-0123456789ad': { phase: 'starting', seq: 0 },
  } }));
  // A session that worked in the project, with a model observation of its harness.
  const sessionEnv = path.join(f.config, 'doflow', 'session-env');
  fs.mkdirSync(path.join(sessionEnv, 'sessions', 'sess-1'), { recursive: true });
  fs.writeFileSync(path.join(sessionEnv, 'sessions', 'sess-1', 'git-context.json'), JSON.stringify({ cwd: a, branch: 'main', captured_at: '2026-11-15T00:00:00Z' }));
  const observations = path.join(sessionEnv, 'primary', cwdHash(a), 'claude');
  fs.mkdirSync(observations, { recursive: true });
  fs.writeFileSync(path.join(observations, 'o.json'), JSON.stringify({ schema: 1, harness: 'claude', model: 'claude-opus-4', event: 'SessionStart', observedAt: new Date(Date.now() - 60000).toISOString(), session: 'aaaaaaaaaaaaaaaa' }));

  const counter = countingExec();
  const spec = channelSpec('machine', { cwd: a, env: f.env, index: indexFor(f, a, counter.exec) });
  let item = (await spec.compute()).sections.activity.json.items[0];
  assert.deepEqual(item.runs, { open: GATE_LIMIT + 3, awaiting: GATE_LIMIT + 2 });
  assert.equal(item.gates.length, GATE_LIMIT);
  assert.deepEqual(item.gates[0], { slug: 'feat-a', taskId: 'g9', gateId: 'gate-9', name: 'Approve gate-9', recordAt: '2026-11-15T09:00:00.000Z', revision: 1 });
  assert.deepEqual(item.gates.map((g: any) => g.taskId), ['g9', 'g8', 'g7', 'g6', 'g5', 'g4', 'g3', 'g2'], 'newest first');
  assert.deepEqual(item.workers, { open: 2 });
  assert.deepEqual(item.sessions, { observed: 2, harnesses: ['claude'] });
  assert.deepEqual(item.unreadable, []);
  const gitCalls = counter.calls.length;

  // A torn journal and a torn worker-run store are named; the rest of the item still reads.
  fs.writeFileSync(path.join(a, '.doflow', 'state', 'orchestration', 'feat-a', 'torn.json'), '{"version":');
  fs.writeFileSync(path.join(workers, 'feat-b.json'), '{');
  item = (await spec.compute(['activity'])).sections.activity.json.items[0];
  assert.deepEqual(item.unreadable, ['task-orchestration', 'worker-runs']);
  assert.deepEqual([item.runs.awaiting, item.workers.open], [GATE_LIMIT + 2, 2]);
  assert.equal(counter.calls.length, gitCalls, 'the session reader got its checkout list from the index, not from git');
});

test('165 D8: open started sessions are listed newest first, at most 8, and are not counted as worker runs; an ended one and an ordinary run are not listed', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const dir = path.join(a, '.doflow', 'state', 'worker-runs');
  fs.mkdirSync(dir, { recursive: true });
  const runs: any = {};
  const hex = (i: number) => `w-${String(i).padStart(12, '0')}`;
  for (let i = 1; i <= STARTED_LIMIT + 3; i += 1) {
    runs[hex(i)] = {
      runId: hex(i), kind: 'main-session', task: 'main-session', seq: 1, phase: i % 2 ? 'running' : 'starting', harness: 'claude', startedBy: i === 1 ? 'device.d-0123456789ab' : 'console',
      project: { projectKey: cwdHash(a), worktreeKey: cwdHash(a) }, binding: { model: i === 2 ? null : 'claude-x', source: 'catalogue' }, createdAt: `2026-11-15T01:${String(i).padStart(2, '0')}:00.000Z`,
      prompt: { store: 'session-prompts', name: `${hex(i)}.prompt.txt`, sha256: 'x', bytes: 1 }, execWorktree: a,
    };
  }
  runs[hex(90)] = { ...runs[hex(1)], runId: hex(90), phase: 'ended', createdAt: '2026-11-15T09:00:00.000Z', end: { state: 'exited', at: '2026-11-15T09:01:00.000Z' } };
  runs[hex(91)] = { runId: hex(91), task: 'A.1', token: 1, seq: 1, phase: 'running', harness: 'codex', createdAt: '2026-11-15T10:00:00.000Z' };
  fs.writeFileSync(path.join(dir, 'started-sessions.json'), JSON.stringify({ version: 1, revision: 1, slug: 'started-sessions', runs }));
  const spec = channelSpec('machine', { cwd: a, env: f.env, index: indexFor(f, a, countingExec().exec) });
  const item = (await spec.compute()).sections.activity.json.items[0];
  assert.deepEqual(item.workers, { open: 1 }, 'only the ordinary run');
  assert.equal(item.startedCount, STARTED_LIMIT + 3);
  assert.equal(item.started.length, STARTED_LIMIT);
  assert.deepEqual(item.started.map((r: any) => r.runId), Array.from({ length: STARTED_LIMIT }, (_, i) => hex(STARTED_LIMIT + 3 - i)), 'newest first');
  assert.deepEqual(item.started.at(-1), { runId: hex(4), harness: 'claude', model: 'claude-x', phase: 'starting', startedBy: 'console', worktreeKey: cwdHash(a), createdAt: '2026-11-15T01:04:00.000Z' });
  assert.deepEqual(Object.keys(item.started[0]).sort(), ['createdAt', 'harness', 'model', 'phase', 'runId', 'startedBy', 'worktreeKey']);
  assert.ok(!JSON.stringify(item).includes(a) && !JSON.stringify(item).includes('prompt.txt'), 'no path, no prompt');
});

test('161 IC-002: a failing project index is the channel producer-failed error, not an exit', async (t) => {
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const clock = fakeClock();
  const stdin = fakeStdin();
  const stdout = sink();
  const missing = () => ({ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) });
  const done = handleEventsCommand({
    follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd: a, env: f.env,
    stdin, stdout, stderr: sink(), clock, watch: fakeWatch(), signals: new EventEmitter(), epoch: '0a1b2c3d',
    projectsIndex: indexFor(f, a, missing, () => clock.now()),
  });
  stdin.json('sub', 'machine');
  await settle();
  assert.deepEqual(stdout.frames().map((frame: any) => [frame.ch, frame.type, frame.data]), [['machine', 'error', { code: 'producer-failed' }]]);
  stdin.emit('end');
  assert.equal(await done, 0);
});

test('161 IC-001: lookup returns a project main checkout and checkouts; an unknown key refreshes at most once per 5 s', (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const linked = path.join(f.root, 'proj-a-linked');
  fs.writeFileSync(path.join(a, 'x.txt'), 'x\n');
  git(a, 'add', '-A');
  git(a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first');
  git(a, 'worktree', 'add', '-q', '-b', 'feat-x', linked);
  let now = 1_000_000;
  const counter = countingExec();
  const index = indexFor(f, a, counter.exec, () => now);
  assert.deepEqual(index.lookup(cwdHash(a)), { projectKey: cwdHash(a), main: a, checkouts: [a, linked] });
  const refreshes = index.generation();
  assert.equal(index.lookup('ffffffffffffffff'), null, 'unknown after a refresh under 5 s old');
  assert.equal(index.generation(), refreshes, 'no second refresh within 5 s');
  now += REFRESH_MS;
  assert.equal(index.lookup('ffffffffffffffff'), null);
  assert.equal(index.generation(), refreshes + 1, 'one refresh for the unknown key after 5 s');
  const calls = counter.calls.length;
  assert.equal(index.lookup('ffffffffffffffff'), null);
  assert.equal(counter.calls.length, calls, 'and none again until 5 s more');
});

test('162 IC-006, D15: an awaiting gate item carries the run record revision (a record without one gives 0)', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-rev');
  journal(a, 'feat-a', 't1', {
    state: 'AWAITING_GATE', revision: 5, updatedAt: '2026-11-15T01:00:00.000Z',
    program: [{ type: 'gate', id: 'gate-a', kind: 'approval', name: 'Approve gate-a', prompt: 'p', status: 'pending' }],
  });
  const old = awaiting(a, 'feat-a', 't2', 'gate-b', '2026-11-15T00:30:00.000Z');
  const doc = JSON.parse(fs.readFileSync(old, 'utf8'));
  delete doc.revision;
  fs.writeFileSync(old, JSON.stringify(doc));
  const spec = channelSpec('machine', { cwd: a, env: f.env, index: indexFor(f, a, countingExec().exec) });
  const item = (await spec.compute()).sections.activity.json.items[0];
  assert.deepEqual(item.gates.map((g: any) => [g.taskId, g.gateId, g.revision]), [['t1', 'gate-a', 5], ['t2', 'gate-b', 0]]);
});

test('161 FX1: an awaiting gate whose record has no name is listed with its gate id as name, never null', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  journal(a, 'feat-a', 't1', {
    state: 'AWAITING_GATE', updatedAt: '2026-11-15T01:00:00.000Z',
    program: [{ type: 'gate', id: 'gate-x', kind: 'approval', prompt: 'p', status: 'pending' }],
  });
  const spec = channelSpec('machine', { cwd: a, env: f.env, index: indexFor(f, a, countingExec().exec) });
  const item = (await spec.compute()).sections.activity.json.items[0];
  assert.equal(item.gates.length, 1);
  assert.equal(item.gates[0].name, 'gate-x');
});
