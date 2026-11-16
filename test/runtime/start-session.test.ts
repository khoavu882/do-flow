'use strict';

// Row 165 T3 (design IC-001, IC-002, IC-003, D1, D9, §9): `worker --action start-session` starts a harness
// headless as a worker run of kind `main-session` in `worker-runs/started-sessions.json`, and
// `worker --action start-options` answers the start form. Every harness here is a fake: a node script
// linked into a scratch bin/ under `fake-<harness>` names, on a PATH that holds that bin/ alone (a `node`
// link beside the fakes), so no real harness CLI can run. Each fake appends `{ name, argv, cwd, stdin, env }`
// to FAKE_LOG. Every child a test starts is ended in its `after`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO, 'src', 'runtime');
const { executeWorkerCommand } = require(path.join(SRC, 'worker', 'command.ts'));
const { readRuns, insertRun } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { procStart } = require(path.join(SRC, 'worker', 'process-tree.ts'));
const { cwdHash } = require(path.join(SRC, 'context', 'identity.ts'));
const { clearCheckoutCache } = require(path.join(SRC, 'checkouts.ts'));
const { listProjects } = require(path.join(SRC, 'fleet', 'projects.ts'));
const { mutateDispatch, storeFileFor: dispatchStoreFor } = require(path.join(SRC, 'dispatch', 'store.ts'));
const { sha16 } = require(path.join(SRC, 'scaffold', 'fingerprint.ts'));
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));
const { workerCatalogue } = require(path.join(SRC, 'worker', 'catalogue.ts'));

const POSIX: any = { skip: process.platform === 'win32' && 'worker process control is unverified on win32' };
const ENTRY_LINE = 'Use the DoFlow do skill for this request:';
const STORE = (root: string) => path.join(root, '.doflow', 'state', 'worker-runs', 'started-sessions.json');

const FAKE = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch { stdin = ''; }
const argv = process.argv.slice(2);
const pick = (k) => (process.env[k] === undefined ? null : process.env[k]);
const env = {};
for (const k of ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE', 'DOFLOW_WORKER_RUN', 'DOFLOW_STARTED_RUN', 'DOFLOW_PRIMARY_HARNESS', 'DOFLOW_PRIMARY_MODEL']) env[k] = pick(k);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name: path.basename(process.argv[1]), argv, cwd: process.cwd(), stdin, env, pid: process.pid }) + '\\n');
const o = argv.indexOf('-o');
if (o !== -1 && argv[o + 1]) fs.writeFileSync(argv[o + 1], 'fake last message\\n');
process.stdout.write('fake output line\\n');
const gate = process.env.FAKE_GATE;
if (gate) {
  const until = Date.now() + 60000;
  const tick = () => { if (fs.existsSync(gate) || Date.now() > until) process.exit(0); setTimeout(tick, 20); };
  tick();
} else process.exit(Number(process.env.FAKE_EXIT || 0));
`;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function repo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.doflow/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
}

/** The registry's worker blocks with each binary renamed `fake-<harness>`, so only a fake can be found. */
function fakeDescriptors() {
  const reg = loadRegistry({ repoRoot: REPO });
  const out: any = {};
  for (const entry of workerCatalogue({ registry: reg })) {
    const worker = structuredClone(entry.worker);
    worker.cli = { ...worker.cli, binary: `fake-${entry.id}` };
    out[entry.id] = worker;
  }
  return out;
}

const DESCRIPTORS = fakeDescriptors();
/** listProjects with the shipped scratch filter turned off: every fixture lives under the test temp root. */
const projectsImpl = (o: any) => listProjects({ ...o, scratchName: 'no-such-scratch-name' });
const children: any[] = [];

function fixture(t: any, { fakes = ['claude', 'codex', 'opencode', 'pi'] }: { fakes?: string[] } = {}) {
  clearCheckoutCache();
  let f: any = null;
  // Registered before tempDir's own removal hook, so it runs first: open the gate, then end every
  // process group the store recorded (supervisor and harness), while the store still exists.
  t.after(() => {
    if (!f) return;
    try { fs.writeFileSync(f.gate, ''); } catch { /* dir gone */ }
    let runs: any = {};
    try { runs = readRuns(f.store); } catch { runs = {}; }
    for (const run of Object.values(runs) as any[]) {
      for (const proc of [run.worker, run.supervisor]) {
        if (proc && Number.isInteger(proc.pid)) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    for (const child of children.splice(0)) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  });
  const dir = fs.realpathSync(tempDir(t, 'doflow-start-session-'));
  f = {
    dir, home: path.join(dir, 'home'), config: path.join(dir, 'config'), main: path.join(dir, 'proj'),
    linked: path.join(dir, 'proj-linked'), bin: path.join(dir, 'bin'), log: path.join(dir, 'fake.log'), gate: path.join(dir, 'gate'),
  };
  repo(f.main);
  git(f.main, 'worktree', 'add', '-q', '-b', 'feat-x', f.linked);
  fs.mkdirSync(path.join(f.home, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(path.join(f.config, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${f.main}\n`);
  fs.mkdirSync(f.bin);
  const script = path.join(dir, 'fake-harness.js');
  fs.writeFileSync(script, FAKE, { mode: 0o755 });
  for (const name of fakes) fs.symlinkSync(script, path.join(f.bin, `fake-${name}`));
  fs.symlinkSync(process.execPath, path.join(f.bin, 'node'));
  f.env = {
    HOME: f.home, XDG_CONFIG_HOME: f.config, TMPDIR: process.env.TMPDIR, PATH: f.bin,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', FAKE_LOG: f.log,
  };
  f.projectKey = cwdHash(f.main);
  f.mainKey = cwdHash(f.main);
  f.linkedKey = cwdHash(f.linked);
  f.store = STORE(f.main);
  return f;
}

// The core refuses an id that begins with '-' or '_'.
const requestId = () => `r${crypto.randomBytes(16).toString('base64url').slice(1)}`;

function startArgs(f: any, over: any = {}) {
  return {
    action: 'start-session', projectKey: f.projectKey, worktreeKey: f.linkedKey, harness: 'codex', entry: 'do', via: 'console',
    requestId: requestId(), stdin: true, readStdin: () => 'hello there', env: f.env, cwd: f.main,
    descriptors: DESCRIPTORS, projects: projectsImpl, ...over,
  };
}

const start = (f: any, over: any = {}) => executeWorkerCommand(startArgs(f, over));

async function ended(f: any, runId: string, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const run = readRuns(f.store)[runId];
    if (run && run.phase === 'ended') return run;
    if (Date.now() > until) throw new Error(`run ${runId} did not end: ${JSON.stringify(run)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const fakeLogAll = (f: any) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l)) : []);
/** The launches only: readiness runs each fake once with `--version` before a start. */
const fakeLog = (f: any) => fakeLogAll(f).filter((c: any) => c.argv[0] !== '--version');

test('codex shape: argv is exec --json -o <file> -, the prompt is on stdin, DOFLOW_SESSION_ROLE is unset', POSIX, async (t: any) => {
  const f = fixture(t);
  const { exit, body } = await start(f, { harness: 'codex' });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.ok, true);
  const run = await ended(f, body.run.runId);
  const [call] = fakeLog(f);
  assert.equal(call.name, 'fake-codex');
  assert.equal(call.argv.length, 5);
  assert.deepEqual([call.argv[0], call.argv[1], call.argv[2], call.argv[4]], ['exec', '--json', '-o', '-']);
  assert.equal(call.argv[3], path.join(f.main, '.doflow', 'state', 'worker-output', `${body.run.runId}.last.log`));
  assert.equal(call.stdin, `${ENTRY_LINE}\n\nhello there`);
  assert.equal(call.cwd, f.linked);
  assert.equal(call.env.DOFLOW_SESSION_ROLE, null);
  assert.equal(call.env.DOFLOW_STARTED_RUN, body.run.runId);
  assert.equal(run.end.state, 'exited');
  assert.equal(run.process.code, 0);
});

/** Every file under `<main>/.doflow/state`, path to bytes (hex): a refusal must leave it as it was. */
function stateSnapshot(f: any) {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(f.main, p)] = fs.readFileSync(p).toString('hex');
    }
  };
  walk(path.join(f.main, '.doflow', 'state'));
  return out;
}

/** A long-lived child of this test: the live pid a fixture run or driver names. Ended in `after`. */
function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  children.push(child);
  return { pid: child.pid, pgid: child.pid, start: procStart(child.pid) };
}

/** An open main-session run inserted straight into a started-sessions store. */
function openRun(root: string, { startedBy = 'console', worktreeKey = 'a'.repeat(16), proc = liveChild(), createdAt = new Date().toISOString() }: any = {}) {
  const runId = `w-${crypto.randomBytes(6).toString('hex')}`;
  const r = insertRun(STORE(root), {
    runId, kind: 'main-session', task: 'main-session', token: 1, request: requestId(), childOf: null, harness: 'codex',
    phase: 'running', createdAt, startedBy, project: { projectKey: cwdHash(root), worktreeKey }, supervisor: proc, worker: proc,
  });
  assert.equal(r.applied, true);
  return runId;
}

for (const [harness, expectArgv, viaStdin] of [
  ['claude', ['-p', '--output-format', 'text'], true],
  ['opencode', ['run', '--format', 'json', '<prompt>'], false],
  ['pi', ['-p', '--mode', 'json', '--', '<prompt>'], false],
] as const) {
  test(`${harness} shape: argv ${expectArgv.join(' ')}, the prompt ${viaStdin ? 'on stdin' : 'as one argv element'}, identity unset, DOFLOW_STARTED_RUN set`, POSIX, async (t: any) => {
    const f = fixture(t);
    const { exit, body } = await start(f, { harness });
    assert.equal(exit, 0, JSON.stringify(body));
    await ended(f, body.run.runId);
    const [call] = fakeLog(f);
    const sent = `${ENTRY_LINE}\n\nhello there`;
    assert.equal(call.name, `fake-${harness}`);
    assert.deepEqual(call.argv, expectArgv.map((a) => (a === '<prompt>' ? sent : a)));
    assert.equal(call.stdin, viaStdin ? sent : '');
    assert.equal(call.cwd, f.linked);
    for (const k of ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE', 'DOFLOW_WORKER_RUN']) assert.equal(call.env[k], null, k);
    assert.equal(call.env.DOFLOW_STARTED_RUN, body.run.runId);
  });
}

test('identity: the caller\'s identity and primary-session variables never reach the started session', POSIX, async (t: any) => {
  const f = fixture(t);
  const env = { ...f.env, DOFLOW_RUN_ID: 'r-caller', DOFLOW_LINEAGE_ID: 'l-caller', DOFLOW_ATTEMPT: '3', DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: '/x', DOFLOW_PRIMARY_HARNESS: 'claude', DOFLOW_PRIMARY_MODEL: 'm' };
  const { exit, body } = await start(f, { env, via: undefined });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.run.startedBy, 'manual');
  await ended(f, body.run.runId);
  const [call] = fakeLog(f);
  for (const k of Object.keys(call.env)) assert.equal(call.env[k], k === 'DOFLOW_STARTED_RUN' ? body.run.runId : null, k);
});

test('entry none sends the text alone; the model part is spliced per harness as whole elements', POSIX, async (t: any) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.config, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'workers.models': { codex: { standard: 'gpt-x' }, claude: { frontier: 'opus-x' }, opencode: { light: 'oc/x' }, pi: { standard: 'pi-x' } } }));
  const cases: any = { codex: ['gpt-x', ['exec', '--json', '-o', '*', '-m', 'gpt-x', '-']], claude: ['opus-x', ['-p', '--output-format', 'text', '--model', 'opus-x']], opencode: ['oc/x', ['run', '--format', 'json', '--model', 'oc/x', 'just text']], pi: ['pi-x', ['-p', '--mode', 'json', '--model', 'pi-x', '--', 'just text']] };
  for (const [harness, [model, argv]] of Object.entries(cases) as any) {
    const worktreeKey = harness === 'codex' || harness === 'opencode' ? f.linkedKey : f.mainKey;
    const { exit, body } = await start(f, { harness, model, entry: 'none', worktreeKey, readStdin: () => 'just text' });
    assert.equal(exit, 0, JSON.stringify(body));
    assert.equal(body.run.model, model);
    await ended(f, body.run.runId);
    const call = fakeLog(f).find((c: any) => c.env.DOFLOW_STARTED_RUN === body.run.runId);
    assert.deepEqual(call.argv.map((a: string, i: number) => (argv[i] === '*' ? '*' : a)), argv, harness);
    if (harness === 'codex' || harness === 'claude') assert.equal(call.stdin, 'just text');
  }
});

test('the prompt file is 0600, the record holds its sha256 and bytes only, and the prompt is in no record or log', POSIX, async (t: any) => {
  const f = fixture(t);
  const secret = 'a very particular prompt text 7f3a';
  const { body } = await start(f, { harness: 'claude', readStdin: () => secret });
  await ended(f, body.run.runId);
  const file = path.join(f.main, '.doflow', 'state', 'session-prompts', `${body.run.runId}.prompt.txt`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const sent = `${ENTRY_LINE}\n\n${secret}`;
  assert.equal(fs.readFileSync(file, 'utf8'), sent);
  const run = readRuns(f.store)[body.run.runId];
  assert.deepEqual(run.prompt, { store: 'session-prompts', name: `${body.run.runId}.prompt.txt`, sha256: crypto.createHash('sha256').update(sent).digest('hex'), bytes: Buffer.byteLength(sent) });
  assert.equal(fs.readFileSync(f.store, 'utf8').includes(secret), false);
  const outLog = path.join(f.main, '.doflow', 'state', 'worker-output', `${body.run.runId}.out.log`);
  assert.equal(fs.readFileSync(outLog, 'utf8').includes(secret), false);
});

test('reply: IC-001 run with agentKey sha16(worker:runId), the layers path and the artifact file keys', POSIX, async (t: any) => {
  const f = fixture(t);
  const { body } = await start(f, { harness: 'claude' });
  const { run } = body;
  assert.equal(body.replayed, false);
  assert.equal(run.kind, 'main-session');
  assert.equal(run.agentKey, sha16(`worker:${run.runId}`));
  assert.equal(run.layers, `/layers/${f.projectKey}/agent/${run.agentKey}`);
  assert.equal(run.files.out, sha16(`${f.main}\0.doflow/state/worker-output/${run.runId}.out.log`));
  assert.equal(run.files.err, sha16(`${f.main}\0.doflow/state/worker-output/${run.runId}.err.log`));
  assert.deepEqual([run.harness, run.model, run.modelSource, run.worktreeKey, run.startedBy], ['claude', null, 'default', f.linkedKey, 'console']);
});

test('replay: the same request id returns the run it started and starts nothing', POSIX, async (t: any) => {
  const f = fixture(t);
  const id = requestId();
  const first = await start(f, { harness: 'claude', requestId: id });
  await ended(f, first.body.run.runId);
  const again = await start(f, { harness: 'claude', requestId: id, worktreeKey: f.mainKey });
  assert.equal(again.exit, 0);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.run.runId, first.body.run.runId);
  assert.equal(again.body.run.phase, 'ended');
  assert.ok(again.body.run.end);
  assert.equal(Object.keys(readRuns(f.store)).length, 1);
  assert.equal(fakeLog(f).length, 1);
});

test('refusals: every IC-001 id, exit 1, and no store is changed', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['codex', 'opencode', 'pi'] });
  const other = path.join(f.dir, 'other');
  repo(other);
  const cases: any[] = [
    ['nested-start', { env: { ...f.env, DOFLOW_STARTED_RUN: 'w-000000000000' } }, { runId: 'w-000000000000' }],
    ['project-mismatch', { cwd: other }, { projectKey: cwdHash(other) }],
    ['unknown-worktree', { worktreeKey: 'f'.repeat(16) }],
    ['prompt-empty', { readStdin: () => '' }],
    ['prompt-nul', { readStdin: () => 'a\0b' }],
    ['prompt-too-long', { readStdin: () => 'x'.repeat(8001) }],
    ['prompt-leading-dash', { entry: 'none', readStdin: () => '-rf' }],
    ['prompt-leading-dash', { harness: 'opencode', readStdin: () => '--help' }],
    ['prompt-leading-at', { harness: 'pi', readStdin: () => '@secrets' }],
    ['harness-not-startable', { harness: 'copilot' }, { harness: 'copilot', reason: 'no-main-session-shape' }],
    ['harness-not-startable', { harness: 'kiro' }, { harness: 'kiro', reason: 'no-main-session-shape' }],
    ['harness-not-startable', { harness: 'claude' }, { harness: 'claude', reason: 'not-installed' }],
    ['harness-not-startable', { harness: 'nosuch' }, { harness: 'nosuch', reason: 'not-listed' }],
    ['model-not-offered', { model: 'gpt-unbound' }],
  ];
  const before = stateSnapshot(f);
  for (const [code, over, current] of cases) {
    const { exit, body } = await start(f, over);
    assert.equal(exit, 1, `${code}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, false);
    assert.equal(body.code, code, JSON.stringify(body));
    assert.equal(typeof body.message, 'string');
    if (current) assert.deepEqual(body.current, current, code);
    if (code === 'model-not-offered') assert.deepEqual(body.current.models, [{ id: null, source: 'default' }]);
  }
  assert.deepEqual(stateSnapshot(f), before);
  assert.equal(fakeLog(f).length, 0);
  // project-not-indexed: the index lists no project.
  fs.writeFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), '');
  const unindexed = await start(f);
  assert.equal(unindexed.body.code, 'project-not-indexed');
  // worktree-gone: git still lists the checkout, its directory is removed.
  fs.writeFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${f.main}\n`);
  fs.rmSync(f.linked, { recursive: true, force: true });
  clearCheckoutCache();
  const gone = await start(f);
  assert.equal(gone.body.code, 'worktree-gone', JSON.stringify(gone.body));
  assert.deepEqual(stateSnapshot(f), before);
});

test('usage: a missing --stdin, a malformed key or request id is exit 2 usage', POSIX, async (t: any) => {
  const f = fixture(t);
  for (const over of [{ stdin: false }, { projectKey: 'XYZ' }, { requestId: 'short' }, { requestId: `-${'a'.repeat(21)}` }, { requestId: `_${'a'.repeat(21)}` }, { entry: 'maybe' }, { via: 'phone' }]) {
    const { exit, body } = await start(f, over);
    assert.equal(exit, 2, JSON.stringify(over));
    assert.equal(body.error, 'usage');
  }
});

test('dispatch-running: a live driver, and an open dispatch in a main-session mode, refuse the start', POSIX, async (t: any) => {
  const f = fixture(t);
  const file = dispatchStoreFor(f.main, 'feat-x');
  const proc = liveChild();
  mutateDispatch(file, (s: any) => { s.drivers.push({ pid: proc.pid, start: proc.start, registeredAt: new Date().toISOString(), endedAt: null }); return { write: true, result: null }; });
  const live = await start(f);
  assert.equal(live.exit, 1);
  assert.equal(live.body.code, 'dispatch-running');
  assert.deepEqual(live.body.current, { slug: 'feat-x', driverPid: proc.pid });
  mutateDispatch(file, (s: any) => {
    s.drivers[0].endedAt = new Date().toISOString();
    s.dispatches['d-000000000001'] = { dispatchId: 'd-000000000001', phase: 'admitted', mode: 'sequential' };
    return { write: true, result: null };
  });
  const moded = await start(f);
  assert.equal(moded.body.code, 'dispatch-running', JSON.stringify(moded.body));
  assert.equal(moded.body.current.slug, 'feat-x');
  assert.equal(fakeLog(f).length, 0);
});

test('limits: checkout-busy, actor-limit and machine-limit under the store lock; a dead supervisor is not counted', POSIX, async (t: any) => {
  const f = fixture(t);
  const second = path.join(f.dir, 'second');
  repo(second);
  fs.writeFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${f.main}\n${second}\n`);
  // A run whose supervisor and worker are gone holds nothing.
  const gone = spawnSync(process.execPath, ['-e', '']);
  openRun(f.main, { worktreeKey: f.linkedKey, proc: { pid: gone.pid, pgid: gone.pid, start: 'Thu Jan  1 00:00:00 1970' } });
  const busyRun = openRun(f.main, { worktreeKey: f.linkedKey, startedBy: 'manual' });
  const busy = await start(f);
  assert.deepEqual([busy.exit, busy.body.code, busy.body.current], [1, 'checkout-busy', { runId: busyRun }]);
  openRun(f.main, { startedBy: 'console', worktreeKey: 'b'.repeat(16) });
  openRun(second, { startedBy: 'console' });
  const actor = await start(f, { worktreeKey: f.mainKey });
  assert.deepEqual([actor.exit, actor.body.code, actor.body.current], [1, 'actor-limit', { open: 2, max: 2 }]);
  openRun(second, { startedBy: 'manual', worktreeKey: 'c'.repeat(16) });
  const machine = await start(f, { worktreeKey: f.mainKey, via: 'device.d-0123456789ab' });
  assert.deepEqual([machine.exit, machine.body.code, machine.body.current], [1, 'machine-limit', { open: 4, max: 4 }]);
  assert.equal(fakeLog(f).length, 0);
});

test('cancel --slug started-sessions ends a running session cancelled, skips the attempt step and leaves the attempt store byte-identical', POSIX, async (t: any) => {
  const f = fixture(t);
  const attempts = path.join(f.main, '.doflow', 'state', 'task-attempts');
  fs.mkdirSync(attempts, { recursive: true });
  fs.writeFileSync(path.join(attempts, 'feat-x.json'), '{"tasks":{}}\n');
  const attemptBytes = () => fs.readdirSync(attempts).sort().map((n: string) => [n, fs.readFileSync(path.join(attempts, n), 'hex')]);
  const before = attemptBytes();
  const { body } = await start(f, { harness: 'claude', env: { ...f.env, FAKE_GATE: f.gate } });
  assert.equal(body.run.phase, 'running', JSON.stringify(body));
  const status = await executeWorkerCommand({ action: 'status', slug: 'started-sessions', workerRun: body.run.runId, env: f.env, cwd: f.main, descriptors: DESCRIPTORS });
  assert.equal(status.exit, 0, JSON.stringify(status.body));
  assert.deepEqual([status.body.kind, status.body.startedBy, status.body.entry, status.body.model], ['main-session', 'console', 'do', null]);
  const cancel = await executeWorkerCommand({ action: 'cancel', slug: 'started-sessions', workerRun: body.run.runId, by: 'test', reason: 'done with it', env: f.env, cwd: f.main, descriptors: DESCRIPTORS });
  assert.equal(cancel.exit, 0, JSON.stringify(cancel.body));
  assert.equal(cancel.body.disposition, 'cancelled');
  assert.deepEqual(cancel.body.attemptCancel, { disposition: 'skipped', reason: 'main-session' });
  const run = await ended(f, body.run.runId);
  assert.equal(run.end.state, 'cancelled');
  assert.deepEqual(attemptBytes(), before);
});

test('slug-reserved: worker run and dispatch refuse the started-sessions store', POSIX, async (t: any) => {
  const f = fixture(t);
  const prompt = path.join(f.dir, 'p.txt');
  fs.writeFileSync(prompt, 'x');
  const run = await executeWorkerCommand({ action: 'run', slug: 'started-sessions', harness: 'codex', task: 'A.1', token: '1', promptFile: prompt, env: f.env, cwd: f.main, descriptors: DESCRIPTORS });
  assert.equal(run.exit, 1, JSON.stringify(run.body));
  assert.deepEqual([run.body.disposition, run.body.reason], ['refused', 'slug-reserved']);
  const { executeDispatchCommand } = require(path.join(SRC, 'dispatch', 'command.ts'));
  const d = await executeDispatchCommand({ action: 'inspect', slug: 'started-sessions', env: f.env, cwd: f.main });
  assert.equal(d.exit, 1, JSON.stringify(d.body));
  assert.deepEqual(d.body, { disposition: 'refused', reason: 'slug-reserved', slug: 'started-sessions' });
});

test('start-options: checkouts, the startable shapes, not-startable reasons, model order and the limits; writes nothing', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['codex', 'opencode', 'pi'] });
  fs.writeFileSync(path.join(f.config, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'workers.models': { codex: { light: 'gpt-l', frontier: 'gpt-f', standard: 'gpt-f' } } }));
  const busyRun = openRun(f.main, { worktreeKey: f.linkedKey });
  const before = stateSnapshot(f);
  const { exit, body } = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors: DESCRIPTORS, projects: projectsImpl });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.deepEqual(Object.keys(body), ['project', 'checkouts', 'harnesses', 'limits', 'open', 'dispatch', 'promptMax', 'entries', 'entryLine']);
  assert.deepEqual(body.project, { projectKey: f.projectKey, label: 'proj', root: null });
  assert.deepEqual(body.checkouts.map((c: any) => [c.worktreeKey, c.label, c.branch, c.main, c.busy]), [
    [f.mainKey, 'proj', 'main', true, null], [f.linkedKey, 'proj-linked', 'feat-x', false, { runId: busyRun }],
  ]);
  const by = Object.fromEntries(body.harnesses.map((h: any) => [h.harness, h]));
  for (const h of ['codex', 'opencode', 'pi']) assert.equal(by[h].startable, true, h);
  assert.deepEqual(by.opencode.warnings.includes('prompt-in-argv'), true);
  assert.deepEqual([by.claude.startable, by.claude.reason], [false, 'not-installed']);
  for (const h of ['copilot', 'kiro', 'antigravity']) assert.deepEqual([by[h].startable, by[h].reason], [false, 'no-main-session-shape'], h);
  assert.match(by.copilot.words, /^DoFlow has no recorded headless way to start copilot: /);
  assert.deepEqual(by.codex.models, [{ id: 'gpt-f', source: 'frontier' }, { id: 'gpt-l', source: 'light' }, { id: null, source: 'default' }]);
  assert.deepEqual(body.limits, { perCheckout: 1, perActor: 2, machine: 4, perActorPerHour: 6 });
  assert.deepEqual(body.open, { machine: 1 });
  assert.deepEqual(body.dispatch, { running: false });
  assert.deepEqual(body.entries, ['do', 'none']);
  assert.equal(body.entryLine, ENTRY_LINE);
  assert.deepEqual(stateSnapshot(f), before);
  assert.equal(fakeLog(f).length, 0);
  const mismatch = await executeWorkerCommand({ action: 'start-options', projectKey: 'f'.repeat(16), env: f.env, cwd: f.main, descriptors: DESCRIPTORS, projects: projectsImpl });
  assert.deepEqual([mismatch.exit, mismatch.body.code], [1, 'project-mismatch']);
});

// ---- 165 review A-1: a run is dead only on positive evidence ------------------------------------------------------------------

const { startSession } = require(path.join(SRC, 'worker', 'start-session.ts'));
const { SUPERVISOR_FILE } = require(path.join(SRC, 'worker', 'supervisor.ts'));

/** A record whose supervisor never got its pid recorded and whose worker is `proc` (or none), `ageMs` old. */
function unsupervisedRun(f: any, { proc = null, ageMs = 120000, worktreeKey = f.linkedKey }: any = {}) {
  const runId = `w-${crypto.randomBytes(6).toString('hex')}`;
  const r = insertRun(f.store, {
    runId, kind: 'main-session', task: 'main-session', token: 1, request: requestId(), childOf: null, harness: 'codex',
    phase: proc ? 'running' : 'starting', createdAt: new Date(Date.now() - ageMs).toISOString(), startedBy: 'console',
    project: { projectKey: f.projectKey, worktreeKey }, ...(proc ? { worker: proc } : {}),
  });
  assert.equal(r.applied, true);
  return runId;
}

test('A-1: the CLI dies after spawning the supervisor and before recording its pid; the worker runs; 61 s later a second start is refused checkout-busy', POSIX, async (t: any) => {
  const f = fixture(t);
  const env = { ...f.env, FAKE_GATE: f.gate };
  const reg = loadRegistry({ repoRoot: REPO });
  // The first start, with a spawn that launches the real supervisor and then "dies": it never records the supervisor's pid.
  const first = await startSession({
    ...startArgs(f, { env, harness: 'claude' }), root: f.main, reg, platform: process.platform, clock: () => new Date(), sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    spawnSupervisor: ({ file, runId }: any) => {
      const child = spawn(process.execPath, [SUPERVISOR_FILE, file, runId], { detached: true, stdio: 'ignore', cwd: f.main, env });
      children.push(child);
      child.unref();
    },
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const run = readRuns(f.store)[first.run.runId];
  assert.equal(run.phase, 'running', JSON.stringify(run));
  assert.equal(run.supervisor, undefined, 'the supervisor pid was never recorded');
  assert.ok(run.worker && Number.isInteger(run.worker.pid), 'the supervisor recorded its worker');
  const later = () => new Date(Date.now() + 61000);
  const second = await start(f, { now: later, harness: 'codex' });
  assert.deepEqual([second.exit, second.body.code, second.body.current], [1, 'checkout-busy', { runId: first.run.runId }], JSON.stringify(second.body));
  assert.equal(Object.keys(readRuns(f.store)).length, 1, 'nothing was inserted');
});

test('A-1: a run with neither pid recorded, past the launch window, is open while a process names it and dead once none does', POSIX, async (t: any) => {
  const f = fixture(t);
  const runId = unsupervisedRun(f);
  // A process whose environment names the run, as a started harness's does.
  const named = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', env: { ...f.env, DOFLOW_STARTED_RUN: runId } });
  children.push(named);
  await new Promise((r) => named.once('spawn', r));
  const held = await start(f, { harness: 'codex' });
  assert.deepEqual([held.exit, held.body.code, held.body.current], [1, 'checkout-busy', { runId }], JSON.stringify(held.body));
  named.kill('SIGKILL');
  await new Promise((r) => named.once('exit', r));
  const free = await start(f, { harness: 'codex' });
  assert.equal(free.exit, 0, JSON.stringify(free.body));
  await ended(f, free.body.run.runId);
});

test('A-1: a run whose liveness cannot be read is refused checkout-busy-unknown with the cancel that clears it; after that cancel a start is admitted', POSIX, async (t: any) => {
  const f = fixture(t);
  // A live pid with no recorded start: `alive` cannot tell it from a reused pid, so the reading is unknown.
  const proc = { ...liveChild(), start: null };
  const runId = unsupervisedRun(f, { proc });
  const refused = await start(f, { harness: 'codex' });
  assert.deepEqual([refused.exit, refused.body.code, refused.body.current], [1, 'checkout-busy-unknown', { runId }], JSON.stringify(refused.body));
  assert.match(refused.body.message, new RegExp(`doflow worker --action cancel --slug started-sessions --worker-run ${runId} --operator --via console --reason ended`));
  const cancel = await executeWorkerCommand({ action: 'cancel', slug: 'started-sessions', workerRun: runId, operator: true, via: 'console', reason: 'ended', env: f.env, cwd: f.main, descriptors: DESCRIPTORS });
  assert.equal(cancel.exit, 0, JSON.stringify(cancel.body));
  assert.equal(readRuns(f.store)[runId].phase, 'ended');
  const free = await start(f, { harness: 'codex' });
  assert.equal(free.exit, 0, JSON.stringify(free.body));
  await ended(f, free.body.run.runId);
});

// ---- 165 review A-3: only a missing dispatch directory means "no dispatch records" -----------------------------------------------

test('A-3: a dispatch directory that cannot be listed (EACCES) refuses the start and marks the options running; a missing one does not', { ...POSIX, skip: POSIX.skip || (process.getuid?.() === 0 && 'root reads a mode-000 directory') }, async (t: any) => {
  const f = fixture(t);
  const dir = path.join(f.main, '.doflow', 'state', 'dispatch');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o000);
  t.after(() => { try { fs.chmodSync(dir, 0o755); } catch { /* gone */ } });
  const refused = await start(f);
  assert.deepEqual([refused.exit, refused.body.code, refused.body.current], [1, 'dispatch-running', { slug: null, reason: 'dispatch-unreadable', detail: 'EACCES' }], JSON.stringify(refused.body));
  assert.doesNotMatch(refused.body.message, /running in null/);
  const options = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors: DESCRIPTORS, projects: projectsImpl });
  assert.deepEqual(options.body.dispatch, { running: true, slug: null, reason: 'dispatch-unreadable' });
  fs.chmodSync(dir, 0o755);
  fs.rmSync(dir, { recursive: true });
  const free = await start(f);
  assert.equal(free.exit, 0, JSON.stringify(free.body));
  await ended(f, free.body.run.runId);
  assert.equal(fakeLog(f).length, 1);
});

// ---- 165 review A-2: a package worker is listed like any harness ---------------------------------------------------------------

const { planPackage, applyPlan } = require(path.join(SRC, 'packages', 'store.ts'));
const { packageView, resetPackageView } = require(path.join(SRC, 'packages', 'view.ts'));
const { readLock, writeLock, lockPackages } = require(path.join(REPO, 'src', 'state', 'lockfile.ts'));

/** An active package `acme` with two worker contributions on the fake CLI `fake-acme`: `acme.worker` has a main-session shape, `acme.bare` none. */
function acmePackage(f: any) {
  const unknown = (what: string) => ({ status: 'unknown', evidence: [], verification: `Check ${what}`, verifiedOn: '2026-11-16', reason: 'test' });
  const supported = (extra: any) => ({ status: 'supported', evidence: ['test'], verification: 'test', verifiedOn: '2026-11-16', ...extra });
  const worker = (mainSession: boolean) => ({
    profile: null, billing: 'unknown', family: 'custom-family',
    cli: supported({ binary: 'fake-acme', versionArgv: ['--version'] }),
    oneShot: supported({ argv: ['{prompt}'], promptVia: 'argv' }),
    structuredOutput: supported({ argv: [], parser: 'doflow-jsonl-v1' }),
    ...(mainSession ? { mainSession: supported({ argv: ['{prompt}'], promptVia: 'argv', parser: null }) } : {}),
    readOnly: unknown('readOnly'), spawnDenial: unknown('spawnDenial'), runnableProbe: unknown('runnableProbe'), hooksProbe: unknown('hooksProbe'),
    guidanceProbe: unknown('guidanceProbe'), loginProbe: unknown('loginProbe'), persistentSession: unknown('persistentSession'), resume: unknown('resume'), steering: unknown('steering'),
    modelChecks: [],
  });
  const src = path.join(f.dir, 'pkg-src');
  fs.mkdirSync(path.join(src, 'workers'), { recursive: true });
  fs.writeFileSync(path.join(src, 'doflow-package.json'), JSON.stringify({
    manifest: 1, id: 'acme', version: '1.0.0', summary: 'Two workers', doflow: '>=2.0.0-beta.1 <3.0.0',
    programs: [{ id: 'cli', binary: 'fake-acme', argv: 'worker-recipe' }],
    contributions: [
      { point: 'worker', version: 1, id: 'worker', file: 'workers/worker.json', programs: ['cli'] },
      { point: 'worker', version: 1, id: 'bare', file: 'workers/bare.json', programs: ['cli'] },
    ],
  }, null, 2));
  fs.writeFileSync(path.join(src, 'workers', 'worker.json'), JSON.stringify(worker(true), null, 2));
  fs.writeFileSync(path.join(src, 'workers', 'bare.json'), JSON.stringify(worker(false), null, 2));
  fs.writeFileSync(path.join(src, 'README.md'), 'notes\n');
  const planned = planPackage({ action: 'add', source: src, homeDir: f.home, repoRoot: REPO, now: Date.parse('2026-11-16T09:00:00Z') });
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));
  const applied = applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: f.home, repoRoot: REPO, env: f.env });
  assert.equal(applied.ok, true, JSON.stringify(applied.findings));
  const lockOpts = { scope: 'global', homeDir: f.home };
  const lock = readLock(lockOpts);
  writeLock(lockOpts, { ...lock, packages: lockPackages(lock).map((r: any) => (r.id === 'acme' ? { ...r, enabled: true } : r)) });
  const grants = path.join(f.config, 'doflow', 'packages', 'grants.jsonl');
  fs.mkdirSync(path.dirname(grants), { recursive: true });
  fs.appendFileSync(grants, `${planned.plan.grantLines.trust}\n`);
  resetPackageView();
  // The fixture lives under the temp root, where grants are read as misplaced; NO_TMP moves that rule out of the way.
  const view = packageView({ repoRoot: REPO, homeDir: f.home, env: f.env, tmpDir: '/nonexistent-doflow-tmp' });
  assert.equal(view.packages.find((p: any) => p.id === 'acme')?.state, 'active');
  return view;
}

test('A-2: an active package worker is listed like any harness: startable with a main-session shape, not startable without, and it starts', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['codex', 'acme'] });
  const view = acmePackage(f);
  const options = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors: DESCRIPTORS, projects: projectsImpl, view });
  assert.equal(options.exit, 0, JSON.stringify(options.body));
  const by = Object.fromEntries(options.body.harnesses.map((h: any) => [h.harness, h]));
  assert.deepEqual([by['acme.worker']?.startable, by['acme.worker']?.reason], [true, null], JSON.stringify(by['acme.worker'] ?? null));
  assert.deepEqual([by['acme.bare']?.startable, by['acme.bare']?.reason], [false, 'no-main-session-shape']);
  assert.equal(by.codex.startable, true);
  const started = await start(f, { harness: 'acme.worker', view });
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  await ended(f, started.body.run.runId);
  assert.deepEqual(fakeLog(f).map((c: any) => c.name), ['fake-acme']);
  const bare = await start(f, { harness: 'acme.bare', view });
  assert.deepEqual([bare.exit, bare.body.code, bare.body.current?.reason], [1, 'harness-not-startable', 'no-main-session-shape'], JSON.stringify(bare.body));
  // An id outside the registry's grammar is not listed, not a usage error: the Console's form pattern is looser than the grammar.
  const odd = await start(f, { harness: 'Acme.Worker', view });
  assert.deepEqual([odd.exit, odd.body.code, odd.body.current?.reason], [1, 'harness-not-startable', 'not-listed'], JSON.stringify(odd.body));
});
