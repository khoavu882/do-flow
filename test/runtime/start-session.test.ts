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
const { recordRecipeAnswer } = require(path.join(SRC, 'worker', 'login-store.ts'));
const { recipeDigest } = require(path.join(SRC, 'worker', 'login.ts'));

const POSIX: any = { skip: process.platform === 'win32' && 'worker process control is unverified on win32' };
const ENTRY_LINE = 'Use the DoFlow do skill for this request:';
/** 169 IC-007: the harness default, the one entry whose model is null (a start-options entry is `{model, provider, effort, source, check}`). */
const DEFAULT_ENTRY = { model: null, provider: null, effort: null, source: 'default', check: null };
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
if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
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
/** Pi ships a supported control channel (170 T9a), so a Pi start goes through it; the print-mode shape tests run Pi with its channel unknown. */
const PRINT_PI = { ...DESCRIPTORS, pi: { ...DESCRIPTORS.pi, controlChannel: { status: 'unknown', evidence: [], verification: 'print-mode fixture', verifiedOn: '2026-11-17', reason: 'print-mode fixture' } } };
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
  ['pi', ['-p', '--mode', 'json', '--no-approve', '--', '<prompt>'], false],
] as const) {
  test(`${harness} shape: argv ${expectArgv.join(' ')}, the prompt ${viaStdin ? 'on stdin' : 'as one argv element'}, identity unset, DOFLOW_STARTED_RUN set`, POSIX, async (t: any) => {
    const f = fixture(t);
    const { exit, body } = await start(f, { harness, descriptors: PRINT_PI });
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
  const cases: any = { codex: ['gpt-x', ['exec', '--json', '-o', '*', '-m', 'gpt-x', '-']], claude: ['opus-x', ['-p', '--output-format', 'text', '--model', 'opus-x']], opencode: ['oc/x', ['run', '--format', 'json', '--model', 'oc/x', 'just text']], pi: ['pi-x', ['-p', '--mode', 'json', '--no-approve', '--model', 'pi-x', '--', 'just text']] };
  for (const [harness, [model, argv]] of Object.entries(cases) as any) {
    const worktreeKey = harness === 'codex' || harness === 'opencode' ? f.linkedKey : f.mainKey;
    const { exit, body } = await start(f, { harness, model, entry: 'none', worktreeKey, readStdin: () => 'just text', descriptors: PRINT_PI });
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
    const { exit, body } = await start(f, { descriptors: PRINT_PI, ...over });
    assert.equal(exit, 1, `${code}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, false);
    assert.equal(body.code, code, JSON.stringify(body));
    assert.equal(typeof body.message, 'string');
    if (current) assert.deepEqual(body.current, current, code);
    if (code === 'model-not-offered') assert.deepEqual(body.current.models, [DEFAULT_ENTRY]);
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

test('165 review B-3: a start without any one of START_FLAGS.required is exit 2 usage, and one with all of them starts', POSIX, async (t: any) => {
  const { START_FLAGS } = require(path.join(SRC, 'worker', 'start-session.ts'));
  const KEYS: Record<string, string> = { '--project-key': 'projectKey', '--worktree-key': 'worktreeKey', '--harness': 'harness', '--entry': 'entry', '--request-id': 'requestId', '--stdin': 'stdin' };
  assert.deepEqual(Object.keys(KEYS).sort(), [...START_FLAGS.required].sort());
  const f = fixture(t);
  for (const flag of START_FLAGS.required) {
    const { exit, body } = await start(f, { [KEYS[flag]]: undefined, via: undefined });
    assert.deepEqual([exit, body.error], [2, 'usage'], flag);
  }
  const { exit, body } = await start(f, { via: undefined, model: undefined });
  assert.equal(exit, 0, JSON.stringify(body));
  await ended(f, body.run.runId);
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

/** 169 T7: pi takes a provider (id prefix) and an effort (flag); its catalogue lists gpt-y under openai and under other. */
function bindPi(f: any, slot: any, others: any = {}) {
  fs.writeFileSync(path.join(f.config, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'workers.models': { ...others, pi: { standard: slot, light: 'gpt-y' } } }));
  fs.mkdirSync(path.join(f.main, '.doflow', 'state', 'models'), { recursive: true });
  fs.writeFileSync(path.join(f.main, '.doflow', 'state', 'models', 'catalogue.json'), JSON.stringify({
    version: 1, syncedAt: '2026-11-17T00:00:00.000Z',
    harnesses: { pi: { installed: true, offeredModels: [{ id: 'gpt-y', provider: 'openai', effortLevels: ['low', 'high'] }, { id: 'gpt-y', provider: 'other' }, { id: 'gpt-z', provider: 'openai' }], modelList: { status: 'listed' } } },
  }));
}

test('169 start-options: each binding and observed model is {model, provider, effort, source, check}; a binding a part of which the harness cannot take is refused', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['codex', 'pi'] });
  bindPi(f, { model: 'gpt-y', provider: 'openai', effort: 'low' }, { codex: { standard: { model: 'gpt-x', effort: 'low' } } });
  const { exit, body } = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors: DESCRIPTORS, projects: projectsImpl });
  assert.equal(exit, 0, JSON.stringify(body));
  const by = Object.fromEntries(body.harnesses.map((h: any) => [h.harness, h]));
  assert.deepEqual(by.pi.models, [
    { model: 'gpt-y', provider: 'openai', effort: 'low', source: 'standard', check: { model: 'listed', effort: 'listed' }, effortMayLower: true },
    { model: 'gpt-y', provider: null, effort: null, source: 'light', check: { model: 'several-providers', effort: null } },
    { model: 'gpt-y', provider: 'openai', effort: null, source: 'observed', check: { model: 'listed', effort: null } },
    { model: 'gpt-y', provider: 'other', effort: null, source: 'observed', check: { model: 'listed', effort: null } },
    { model: 'gpt-z', provider: 'openai', effort: null, source: 'observed', check: { model: 'listed', effort: null } },
    DEFAULT_ENTRY,
  ]);
  assert.deepEqual(by.codex.models, [
    { model: 'gpt-x', provider: null, effort: 'low', source: 'standard', check: { model: 'unchecked', effort: 'unchecked' }, refused: 'effort:unsupported' },
    DEFAULT_ENTRY,
  ]);
});

test('169 start-session: --model --provider --effort starts only an offered triple, with the part reaching the argv and the record', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['pi'] });
  bindPi(f, { model: 'gpt-y', provider: 'openai', effort: 'low' });
  const triple = { harness: 'pi', worktreeKey: f.mainKey, entry: 'none', readStdin: () => 'just text', descriptors: PRINT_PI };
  const before = stateSnapshot(f);
  for (const over of [
    { model: 'gpt-y', provider: 'openai', effort: 'high' }, { model: 'gpt-y', provider: 'other', effort: 'low' }, { model: 'gpt-z', provider: 'openai', effort: 'low' },
    { model: 'gpt-q', provider: 'openai', effort: 'low' }, { model: 'gpt-y', effort: 'low' },
  ]) {
    const { exit, body } = await start(f, { ...triple, ...over });
    assert.deepEqual([exit, body.code], [1, 'model-not-offered'], JSON.stringify(over));
    assert.ok(body.current.models.every((m: any) => 'provider' in m && 'effort' in m && 'check' in m));
  }
  assert.deepEqual(stateSnapshot(f), before);
  assert.equal(fakeLog(f).length, 0);
  const { exit, body } = await start(f, { ...triple, model: 'gpt-y', provider: 'openai', effort: 'low' });
  assert.equal(exit, 0, JSON.stringify(body));
  const run = await ended(f, body.run.runId);
  assert.deepEqual(fakeLog(f)[0].argv, ['-p', '--mode', 'json', '--no-approve', '--model', 'openai/gpt-y', '--thinking', 'low', '--', 'just text']);
  assert.deepEqual([run.binding.model, run.binding.provider, run.binding.effort, run.binding.source], ['gpt-y', 'openai', 'low', 'standard']);
  // 170 T4: the record also carries the harness's controlChannel entry (here the fixture's `unknown`), so a reader can say why it has no channel.
  assert.deepEqual(Object.keys(run.descriptor).sort(), ['cli', 'controlChannel', 'effort', 'loginProbe', 'mainSession', 'model', 'provider']);
});

test('169 start-session: a refused entry does not start, and a provider or effort without a model, or outside its pattern, is usage', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['codex'] });
  fs.writeFileSync(path.join(f.config, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'workers.models': { codex: { standard: { model: 'gpt-x', effort: 'low' } } } }));
  const before = stateSnapshot(f);
  const refused = await start(f, { model: 'gpt-x', effort: 'low' });
  assert.deepEqual([refused.exit, refused.body.code], [1, 'model-not-offered']);
  assert.equal(refused.body.current.models[0].refused, 'effort:unsupported');
  for (const over of [{ provider: 'openai' }, { effort: 'low' }, { model: 'gpt-x', provider: 'a b' }, { model: 'gpt-x', effort: '-low' }]) {
    const { exit, body } = await start(f, over);
    assert.deepEqual([exit, body.error], [2, 'usage'], JSON.stringify(over));
  }
  assert.deepEqual(stateSnapshot(f), before);
  assert.equal(fakeLog(f).length, 0);
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
  const plain = (model: string, source: string) => ({ model, provider: null, effort: null, source, check: { model: 'unchecked', effort: null } });
  assert.deepEqual(by.codex.models, [plain('gpt-f', 'frontier'), plain('gpt-l', 'light'), DEFAULT_ENTRY]);
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

test('165 review B-8: a startable harness whose main-session evidence is help-only says liveVerified false; one citing a live-run record says true; nothing is downgraded', POSIX, async (t: any) => {
  const f = fixture(t);
  const options = async (descriptors: any) => {
    const { exit, body } = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors, projects: projectsImpl });
    assert.equal(exit, 0, JSON.stringify(body));
    return Object.fromEntries(body.harnesses.map((h: any) => [h.harness, h]));
  };
  const by = await options(DESCRIPTORS);
  // Every built-in main-session shape today rests on a cli-check (--help) record only.
  for (const h of ['claude', 'codex', 'opencode', 'pi']) assert.deepEqual([by[h].startable, by[h].liveVerified], [true, false], h);
  for (const h of ['copilot', 'kiro', 'antigravity']) assert.deepEqual([by[h].startable, by[h].liveVerified], [false, false], h);
  // A live-run record of the harness itself in the evidence list makes it true; one of another harness, a missing file or a cli-check does not.
  const cited = (evidence: string[]) => ({ ...DESCRIPTORS, claude: { ...DESCRIPTORS.claude, mainSession: { ...DESCRIPTORS.claude.mainSession, evidence } } });
  const MAIN = 'core/worker-evidence/claude/2026-11-15-cli-check-main-session.json';
  assert.equal((await options(cited([MAIN, 'core/worker-evidence/claude/2026-11-07-live-run-read-only.json']))).claude.liveVerified, true);
  assert.equal((await options(cited([MAIN, 'core/worker-evidence/codex/2026-10-18-live-run-read-only.json']))).claude.liveVerified, false, 'another harness\'s run');
  assert.equal((await options(cited([MAIN, 'core/worker-evidence/claude/no-such-record.json']))).claude.liveVerified, false, 'a missing record');
  assert.equal((await options(cited([MAIN]))).claude.startable, true, 'help-only stays startable');
});

test('170 IC-006: each harness entry carries the channel fact; a supported channel not cited to a live run warns channel-not-verified-live', POSIX, async (t: any) => {
  const f = fixture(t);
  const options = async (descriptors: any) => {
    const { exit, body } = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors, projects: projectsImpl });
    assert.equal(exit, 0, JSON.stringify(body));
    return Object.fromEntries(body.harnesses.map((h: any) => [h.harness, h]));
  };
  // Every built-in but pi's is unknown with the descriptor's own reason: nothing is said without evidence (R-11).
  const by = await options(DESCRIPTORS);
  // Pi ships a supported channel on capture C-1 with no live run: its fact is supported, unverified, and warns.
  assert.deepEqual(by.pi.channel, { state: 'supported', reason: null, liveVerified: false, unverified: DESCRIPTORS.pi.controlChannel.unverified });
  assert.ok(by.pi.warnings.includes('channel-not-verified-live'));
  for (const [harness, entry] of Object.entries(by).filter(([harness]) => harness !== 'pi') as any[]) {
    assert.equal(DESCRIPTORS[harness].controlChannel.status, 'unknown', harness);
    assert.deepEqual(entry.channel, { state: 'unknown', reason: DESCRIPTORS[harness].controlChannel.reason, liveVerified: false, unverified: [] }, harness);
    assert.equal(typeof entry.channel.reason, 'string');
    assert.ok(!entry.warnings.includes('channel-not-verified-live'), harness);
  }
  // A supported channel with no live-run citation: state supported, the descriptor's unverified phrases, and the warning on a startable harness.
  const withChannel = (harness: string, over: any) => ({ ...DESCRIPTORS, [harness]: { ...DESCRIPTORS[harness], controlChannel: { ...DESCRIPTORS[harness].controlChannel, status: 'supported', ...over } } });
  const CLI_CHECK = 'core/worker-evidence/claude/2026-11-15-cli-check-main-session.json';
  const LIVE = 'core/worker-evidence/claude/2026-11-07-live-run-read-only.json';
  const unverified = await options(withChannel('claude', { evidence: [CLI_CHECK], unverified: ['follow-up not run', 'steer not run'] }));
  assert.deepEqual(unverified.claude.channel, { state: 'supported', reason: null, liveVerified: false, unverified: ['follow-up not run', 'steer not run'] });
  assert.equal(unverified.claude.startable, true);
  assert.ok(unverified.claude.warnings.includes('channel-not-verified-live'));
  // Citing a live-run record of the harness itself verifies it: no warning. Another harness's record does not.
  const verified = await options(withChannel('claude', { evidence: [CLI_CHECK, LIVE] }));
  assert.deepEqual(verified.claude.channel, { state: 'supported', reason: null, liveVerified: true, unverified: [] });
  assert.ok(!verified.claude.warnings.includes('channel-not-verified-live'));
  const other = await options(withChannel('claude', { evidence: [CLI_CHECK, 'core/worker-evidence/codex/2026-10-18-live-run-read-only.json'] }));
  assert.equal(other.claude.channel.liveVerified, false);
  assert.ok(other.claude.warnings.includes('channel-not-verified-live'));
  // The fact does not depend on the harness being startable: copilot has no main-session shape and still reports its channel.
  const shut = await options(withChannel('copilot', { evidence: [CLI_CHECK], unverified: ['nothing run'] }));
  assert.deepEqual([shut.copilot.startable, shut.copilot.channel.state, shut.copilot.warnings], [false, 'supported', []]);
  // A descriptor with no controlChannel entry is unknown, never unsupported.
  const { controlChannel, ...bare } = DESCRIPTORS.pi;
  assert.deepEqual((await options({ ...DESCRIPTORS, pi: bare })).pi.channel, { state: 'unknown', reason: 'no-control-channel-entry', liveVerified: false, unverified: [] });
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
function acmePackage(f: any, { fieldMap = null }: { fieldMap?: any } = {}) {
  const unknown = (what: string) => ({ status: 'unknown', evidence: [], verification: `Check ${what}`, verifiedOn: '2026-11-16', reason: 'test' });
  const supported = (extra: any) => ({ status: 'supported', evidence: ['test'], verification: 'test', verifiedOn: '2026-11-16', ...extra });
  const worker = (mainSession: boolean) => ({
    profile: null, billing: 'unknown', family: 'custom-family',
    cli: supported({ binary: 'fake-acme', versionArgv: ['--version'] }),
    oneShot: supported({ argv: ['{prompt}'], promptVia: 'argv' }),
    structuredOutput: supported(fieldMap ? { argv: [], fieldMap } : { argv: [], parser: 'doflow-jsonl-v1' }),
    ...(mainSession ? { mainSession: supported({ argv: ['{prompt}'], promptVia: 'argv', parser: fieldMap ? fieldMap.id : null }) } : {}),
    readOnly: unknown('readOnly'), spawnDenial: unknown('spawnDenial'), runnableProbe: unknown('runnableProbe'), hooksProbe: unknown('hooksProbe'),
    guidanceProbe: unknown('guidanceProbe'), loginProbe: unknown('loginProbe'), persistentSession: unknown('persistentSession'), resume: unknown('resume'), controlChannel: unknown('controlChannel'),
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

/** A valid `jsonl-field-map-v1` map: a `message` event carries the final text, a `done` event ends the turn. */
const ACME_MAP = {
  id: 'acme-stream-v1', format: 'jsonl-field-map-v1', eventType: ['type'], missingTerminal: 'no-done',
  rules: [
    { when: [{ path: ['type'], equals: 'message' }, { path: ['text'], is: 'string' }], then: { final: ['text'] } },
    { when: [{ path: ['type'], equals: 'done' }], then: { terminal: { outcome: 'completed' }, usage: { tokens: { sum: [['tokens']], require: 'any' } } } },
  ],
};

test('171 T3b: a package worker whose mainSession.parser names its own fieldMap id starts, and its run record\'s descriptor carries that map', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['codex', 'acme'] });
  const view = acmePackage(f, { fieldMap: ACME_MAP });
  f.env.FAKE_STDOUT = `${JSON.stringify({ type: 'message', text: 'all done' })}\n${JSON.stringify({ type: 'done', tokens: 7 })}\n`;
  const started = await start(f, { harness: 'acme.worker', view });
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  const run = await ended(f, started.body.run.runId);
  assert.deepEqual(run.descriptor.structuredOutput, { fieldMap: ACME_MAP });
  assert.equal(run.descriptor.mainSession.parser, ACME_MAP.id);
  // The map's own parser read the stream: its id is on the report, and the map's success shape is a real success.
  assert.equal(run.report.parser, ACME_MAP.id);
  assert.equal(run.report.status, 'success');
  assert.equal(run.report.summary, 'all done');
  // The launch was not refused parser-unknown: the fake CLI ran once, and the run ended by exiting.
  assert.deepEqual(fakeLog(f).map((c: any) => c.name), ['fake-acme']);
  assert.equal(run.end.state, 'exited');
});

test('171 T3b: a built-in\'s stored descriptor has no structuredOutput, and a package worker naming a core parser carries none', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['codex', 'acme'] });
  const view = acmePackage(f);
  const builtin = await start(f, { harness: 'codex', view });
  assert.equal(builtin.exit, 0, JSON.stringify(builtin.body));
  const run = await ended(f, builtin.body.run.runId);
  assert.deepEqual(Object.keys(run.descriptor).sort(), ['cli', 'controlChannel', 'mainSession', 'model'], '170 T4: the controlChannel entry is copied');
  // codex's own map is compiled into PARSERS, so it is not copied into the record either.
  assert.equal(Object.hasOwn(run.descriptor, 'structuredOutput'), false);
  const plain = await start(f, { harness: 'acme.worker', view });
  assert.equal(plain.exit, 0, JSON.stringify(plain.body));
  const plainRun = await ended(f, plain.body.run.runId);
  assert.equal(Object.hasOwn(plainRun.descriptor, 'structuredOutput'), false);
});

// 172 FR-011: a started session goes through the same supervisor, so a failure whose summary holds the worker's expiry
// sign marks the run and the login store, and the start form then reads the harness as expired (startable, warned).
test('172 FR-011: a started session that fails with an expiry sign is recorded expired, and start-options says so', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['codex'] });
  const codex = structuredClone(DESCRIPTORS.codex);
  codex.loginProbe = { ...codex.loginProbe, expirySigns: { signs: ['OAuth refresh failed for {provider}'], basis: 'source', evidence: ['test'] }, hint: 'codex login' };
  const descriptors = { ...DESCRIPTORS, codex };
  f.env.FAKE_STDOUT = `${JSON.stringify({ type: 'turn.failed', error: { message: 'OAuth refresh failed for openai' } })}\n`;
  const fresh = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors, projects: projectsImpl });
  const before = fresh.body.harnesses.find((h: any) => h.harness === 'codex');
  assert.deepEqual([before.startable, before.login.state, before.login.source], [true, 'unknown', 'never-checked']);
  assert.ok(before.warnings.includes('login-unknown'), JSON.stringify(before.warnings));

  const started = await start(f, { descriptors });
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  const run = await ended(f, started.body.run.runId);
  assert.deepEqual(run.descriptor.loginProbe, { expirySigns: codex.loginProbe.expirySigns });
  assert.equal(run.report.status, 'failure');
  assert.deepEqual(run.report.loginExpired, { sign: 'OAuth refresh failed for {provider}', provider: 'openai' });

  const after = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors, projects: projectsImpl });
  const h = after.body.harnesses.find((item: any) => item.harness === 'codex');
  assert.deepEqual([h.startable, h.login.state, h.login.source, h.login.provider, h.login.hint], [true, 'expired', 'last-run', 'openai', 'codex login']);
  assert.ok(h.warnings.includes('login-expired'));
  assert.equal(h.warnings.includes('login-unknown'), false);
});

// 172 AC-6 on the SHIPPED descriptors: codex, opencode, copilot, kiro and antigravity carry no login recipe, so each reads
// `unknown` with the descriptor's own `loginProbe.reason`, and login never blocks a start. The expected reason is read from
// core/registry/harnesses.json, not copied. copilot, kiro and antigravity are non-startable for a reason unrelated to login
// (`no-main-session-shape`: no recorded headless way to start them), so for those the proof is the login-state answer plus
// that start-options names no `logged-out` reason; codex and opencode are startable and carry the `login-unknown` warning.
test('172 AC-6: the five harnesses without a recipe read unknown with their loginProbe.reason and are not blocked by login', POSIX, async (t: any) => {
  const FIVE = ['codex', 'opencode', 'copilot', 'kiro', 'antigravity'];
  const f = fixture(t, { fakes: FIVE });
  const shipped = loadRegistry({ repoRoot: REPO });
  const reasonOf = (id: string) => {
    const entry = workerCatalogue({ registry: shipped }).find((e: any) => e.id === id);
    assert.equal(entry.worker.loginProbe.status, 'unknown', `${id} ships no recipe`);
    assert.equal(typeof entry.worker.loginProbe.reason, 'string', id);
    return entry.worker.loginProbe.reason;
  };

  const state = await executeWorkerCommand({ action: 'login-state', env: f.env, cwd: f.main, descriptors: DESCRIPTORS, projects: projectsImpl });
  assert.equal(state.exit, 0, JSON.stringify(state.body));
  const answers = Object.fromEntries(state.body.harnesses.map((a: any) => [a.harness, a]));

  const options = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors: DESCRIPTORS, projects: projectsImpl });
  assert.equal(options.exit, 0, JSON.stringify(options.body));
  const by = Object.fromEntries(options.body.harnesses.map((h: any) => [h.harness, h]));

  for (const id of FIVE) {
    const want = reasonOf(id);
    assert.equal(answers[id].state, 'unknown', id);
    assert.equal(answers[id].reason, `no-recipe: ${want.slice(0, 120)}`, id);
    assert.notEqual(by[id].reason, 'logged-out', id);
  }
  for (const id of ['codex', 'opencode']) {
    assert.deepEqual([by[id].startable, by[id].reason], [true, null], id);
    assert.equal(by[id].login.state, 'unknown', id);
    assert.equal(by[id].login.reason, answers[id].reason, id);
    assert.ok(by[id].warnings.includes('login-unknown'), `${id}: ${JSON.stringify(by[id].warnings)}`);
  }
  for (const id of ['copilot', 'kiro', 'antigravity']) {
    assert.deepEqual([by[id].startable, by[id].reason], [false, 'no-main-session-shape'], `${id} is blocked by its missing main-session shape, not by login`);
  }
});

// Control for the test above: the same assertions would fail if one of the five read `logged-out`. A scratch codex that
// carries a recipe, with a stored `logged-out` recipe answer for that recipe, is blocked (reason `logged-out`, not
// startable, no `login-unknown` warning), so "reason is not logged-out, startable, login-unknown" separates the two.
test('172 AC-6 control: a codex with a recipe and a stored logged-out answer is blocked, unlike the shipped no-recipe codex', POSIX, async (t: any) => {
  const f = fixture(t, { fakes: ['codex'] });
  const codex = structuredClone(DESCRIPTORS.codex);
  codex.loginProbe = {
    status: 'supported', evidence: ['test'], verification: 'test', verifiedOn: '2026-11-16', argv: ['probe', 'login'], output: 'none',
    answers: [{ exit: 0, state: 'logged-in' }, { exit: 1, state: 'logged-out' }], expiry: 'not-seen', hint: 'codex login',
  };
  const descriptors = { ...DESCRIPTORS, codex };
  recordRecipeAnswer(f.env, 'codex', { state: 'logged-out', reason: 'exit 1', at: new Date().toISOString(), billing: null, providers: [], checked: 1, listed: 1 }, recipeDigest(codex));
  const { exit, body } = await executeWorkerCommand({ action: 'start-options', projectKey: f.projectKey, env: f.env, cwd: f.main, descriptors, projects: projectsImpl });
  assert.equal(exit, 0, JSON.stringify(body));
  const h = body.harnesses.find((item: any) => item.harness === 'codex');
  assert.deepEqual([h.startable, h.reason, h.login.state], [false, 'logged-out', 'logged-out']);
  assert.equal(h.warnings.includes('login-unknown'), false);
});

// ---- 170 T4 (A-2, R-4, R-5): a channel harness starts through its channel; a command is refused; starts per hour --------------

/** A channel shaped like Pi's RPC mode (design 4.3): the shipped descriptors all say `unknown`, so the tests declare one. */
const PI_CHANNEL = {
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
};
const WITH_CHANNEL = { ...DESCRIPTORS, pi: { ...DESCRIPTORS.pi, controlChannel: PI_CHANNEL } };

/** The fixture with `fake-pi` linked to the fake channel harness (test/helper/fake-channel-harness.ts). */
function channelFixture(t: any) {
  const f = fixture(t, { fakes: ['claude', 'codex', 'opencode'] });
  fs.symlinkSync(path.join(REPO, 'test', 'helper', 'fake-channel-harness.ts'), path.join(f.bin, 'fake-pi'));
  f.channelLog = path.join(f.dir, 'channel.log');
  f.env = { ...f.env, FAKE_CHANNEL_LOG: f.channelLog };
  return f;
}

test('A-2: a harness with a supported channel starts through it: the record says promptVia channel and carries the entry, the first prompt is the framed follow-up', POSIX, async (t: any) => {
  const f = channelFixture(t);
  const { exit, body } = await start(f, { harness: 'pi', descriptors: WITH_CHANNEL });
  assert.equal(exit, 0, JSON.stringify(body));
  const runId = body.run.runId;
  const sent = `${ENTRY_LINE}\n\nhello there`;
  const until = Date.now() + 10000;
  while (!(fs.existsSync(f.channelLog) && readRuns(f.store)[runId]?.channel?.state === 'open') && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  const run = readRuns(f.store)[runId];
  assert.deepEqual([run.recipe.promptVia, run.recipe.parser, run.recipe.argvShape], ['channel', 'pi-json-v1', ['--mode', 'rpc', '--no-approve']]);
  assert.deepEqual(run.descriptor.controlChannel, PI_CHANNEL);
  assert.equal(run.channel.state, 'open');
  assert.equal(fs.readFileSync(f.channelLog, 'utf8'), `${JSON.stringify({ type: 'prompt', message: sent, streamingBehavior: 'followUp', id: 'd-1' })}\n`);
  const cancel = await executeWorkerCommand({ action: 'cancel', slug: 'started-sessions', workerRun: runId, by: 'test', reason: 'done with it', env: f.env, cwd: f.main, descriptors: WITH_CHANNEL });
  assert.equal(cancel.body.disposition, 'cancelled', JSON.stringify(cancel.body));
  const done = await ended(f, runId);
  assert.deepEqual([done.channel.state, done.channel.closedReason], ['closed', 'cancelled']);
  // The live supervisor removes the spool once the harness streams are drained, after the cancel's end is written.
  const spoolDir = path.join(f.main, '.doflow', 'state', 'channel-spool', runId);
  const by = Date.now() + 10000;
  while (fs.existsSync(spoolDir) && Date.now() < by) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.existsSync(spoolDir), false, 'the spool is removed');
});

test('T9a: the shipped Pi descriptor starts through its channel on the C-1 argv, the first prompt a framed follow-up', POSIX, async (t: any) => {
  const f = channelFixture(t);
  const { exit, body } = await start(f, { harness: 'pi' });
  assert.equal(exit, 0, JSON.stringify(body));
  const runId = body.run.runId;
  const until = Date.now() + 10000;
  while (!(fs.existsSync(f.channelLog) && readRuns(f.store)[runId]?.channel?.state === 'open') && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  const run = readRuns(f.store)[runId];
  assert.deepEqual([run.recipe.promptVia, run.recipe.parser, run.recipe.argvShape], ['channel', 'pi-json-v1', ['--mode', 'rpc', '--no-approve']]);
  assert.equal(fs.readFileSync(f.channelLog, 'utf8'), `${JSON.stringify({ type: 'prompt', message: `${ENTRY_LINE}\n\nhello there`, streamingBehavior: 'followUp', id: 'd-1' })}\n`);
  const cancel = await executeWorkerCommand({ action: 'cancel', slug: 'started-sessions', workerRun: runId, by: 'test', reason: 'done with it', env: f.env, cwd: f.main, descriptors: DESCRIPTORS });
  assert.equal(cancel.body.disposition, 'cancelled', JSON.stringify(cancel.body));
  await ended(f, runId);
});

test('170 T4c: a channel start with an 8000-code-point text and entry do is accepted, not prompt-too-long; 8001 still is', POSIX, async (t: any) => {
  const f = channelFixture(t);
  const text = 'a'.repeat(8000);
  const { exit, body } = await start(f, { harness: 'pi', entry: 'do', descriptors: WITH_CHANNEL, readStdin: () => text });
  assert.equal(exit, 0, JSON.stringify(body));
  const runId = body.run.runId;
  const until = Date.now() + 10000;
  while (!(fs.existsSync(f.channelLog) && readRuns(f.store)[runId]?.channel?.state === 'open') && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.equal(JSON.parse(fs.readFileSync(f.channelLog, 'utf8')).message, `${ENTRY_LINE}\n\n${text}`);
  const cancel = await executeWorkerCommand({ action: 'cancel', slug: 'started-sessions', workerRun: runId, by: 'test', reason: 'done with it', env: f.env, cwd: f.main, descriptors: WITH_CHANNEL });
  assert.equal(cancel.body.disposition, 'cancelled', JSON.stringify(cancel.body));
  await ended(f, runId);
  const over = await start(f, { harness: 'pi', entry: 'do', descriptors: WITH_CHANNEL, readStdin: () => 'a'.repeat(8001) });
  assert.deepEqual([over.exit, over.body.code], [1, 'prompt-too-long']);
});

test('R-4: a first prompt that starts with the channel command prefix is refused command-not-allowed before any write; a harness without a channel starts it as before', POSIX, async (t: any) => {
  const f = channelFixture(t);
  const before = stateSnapshot(f);
  for (const entry of ['do', 'none']) {
    const { exit, body } = await start(f, { harness: 'pi', entry, descriptors: WITH_CHANNEL, readStdin: () => '/help' });
    assert.deepEqual([exit, body.ok, body.code], [1, false, 'command-not-allowed'], JSON.stringify(body));
    assert.equal(typeof body.message, 'string');
  }
  assert.deepEqual(stateSnapshot(f), before, 'no run, prompt or spool is written');
  assert.equal(fs.existsSync(f.channelLog), false, 'nothing reached the harness');
  // codex has no channel: its prompt is not a channel record, so the prefix means nothing to it (row 165 unchanged).
  const plain = await start(f, { harness: 'codex', readStdin: () => '/help' });
  assert.equal(plain.exit, 0, JSON.stringify(plain.body));
  const run = await ended(f, plain.body.run.runId);
  assert.equal(run.recipe.promptVia, 'stdin');
  assert.equal(run.channel, undefined);
  assert.equal(run.descriptor.controlChannel.status, 'unknown', 'the unsupported entry is copied for the reader');
  assert.equal(fakeLog(f)[0].stdin, `${ENTRY_LINE}\n\n/help`);
});

test('R-5: the seventh start by one actor within an hour, counting ended runs here and in another indexed project, is refused start-rate-limited with retryAfterSeconds', POSIX, async (t: any) => {
  const f = fixture(t);
  const second = path.join(f.dir, 'second');
  repo(second);
  fs.writeFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${f.main}\n${second}\n`);
  const now = Date.now();
  const endedRun = (root: string, minutesAgo: number, startedBy = 'console') => {
    const runId = `w-${crypto.randomBytes(6).toString('hex')}`;
    const createdAt = new Date(now - minutesAgo * 60000).toISOString();
    const r = insertRun(STORE(root), {
      runId, kind: 'main-session', task: 'main-session', token: 1, request: requestId(), childOf: null, harness: 'codex',
      phase: 'ended', createdAt, startedBy, project: { projectKey: cwdHash(root), worktreeKey: 'a'.repeat(16) }, end: { state: 'exited', at: createdAt },
    });
    assert.equal(r.applied, true);
  };
  // Six by console in the hour (the oldest 50 minutes ago), one older than the hour, and one by another actor.
  for (const minutes of [50, 40, 30, 20]) endedRun(f.main, minutes);
  for (const minutes of [10, 5]) endedRun(second, minutes);
  endedRun(f.main, 61);
  endedRun(f.main, 1, 'manual');
  const before = stateSnapshot(f);
  const { exit, body } = await start(f);
  assert.deepEqual([exit, body.code, body.current.started, body.current.max], [1, 'start-rate-limited', 6, 6], JSON.stringify(body));
  assert.ok(body.current.retryAfterSeconds > 9 * 60 && body.current.retryAfterSeconds <= 10 * 60, `the oldest of the six leaves its hour in about 10 minutes: ${body.current.retryAfterSeconds}`);
  assert.equal(typeof body.message, 'string');
  assert.deepEqual(stateSnapshot(f), before);
  assert.equal(fakeLog(f).length, 0);
  // Another actor has its own count.
  const other = await start(f, { via: undefined });
  assert.equal(other.exit, 0, JSON.stringify(other.body));
  await ended(f, other.body.run.runId);
});
