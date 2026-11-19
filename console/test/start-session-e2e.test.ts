'use strict';

// Row 165 T8a: starting, watching and stopping a session through the Console on the REAL core (bin/doflow.js) and the real
// Console server (real routes, real actions table, real verb runner, real live hub). Every harness is a fake: one node script
// linked into a scratch bin/ as `codex`, `opencode`, `pi` and `claude`, on a PATH that holds that bin/ alone (a `node` and a
// `git` link beside the fakes), so no real harness CLI can run and `kiro-cli` is never on it. HOME, XDG_CONFIG_HOME, the device
// store, the action log and the project roots are scratch directories. Each fake appends its argv, stdin and environment to
// FAKE_LOG, prints a first line, waits for the file `go2`, prints a second line, and waits for the file `end` (or 60 s).

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
const { createLiveHub } = require('../src/live.ts');
const { createLiveChild } = require('../src/live-child.ts');
const { lanWorld, lanServer } = require('./helpers/lan-world.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CORE = path.join(REPO, 'bin', 'doflow.js');
const POSIX: any = { skip: process.platform === 'win32' && 'worker process control is unverified on win32' };

const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-start-e2e-web-'));
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

// A leading `-` in a request id (1 in 64 of a random base64url id) makes the core read `--request-id <id>` as a missing value: a product
// defect reported with this row's hand-back (src/runtime/worker/command.ts argument parsing), so this file's ids start with a letter.
const rid = () => `r${crypto.randomBytes(16).toString('base64url').slice(1)}`;
const json = (reply: { body: string }) => JSON.parse(reply.body);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MARKER = `MARKER-${crypto.randomBytes(6).toString('hex')}`;

const FAKE = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch { stdin = ''; }
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('fake 1.0.0\\n'); process.exit(0); }
const env = {};
for (const k of ['DOFLOW_STARTED_RUN', 'DOFLOW_SESSION_ROLE', 'DOFLOW_RUN_ID']) env[k] = process.env[k] === undefined ? null : process.env[k];
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name: path.basename(process.argv[1]), argv, cwd: process.cwd(), stdin, env, pid: process.pid }) + '\\n');
const dir = process.env.FAKE_DIR;
process.stdout.write('first line\\n');
const until = Date.now() + 60000;
let stage = 1;
const tick = () => {
  if (Date.now() > until || fs.existsSync(path.join(dir, 'end'))) process.exit(0);
  if (stage === 1 && fs.existsSync(path.join(dir, 'go2'))) { stage = 2; process.stdout.write('second line\\n'); }
  setTimeout(tick, 20);
};
tick();
`;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A scratch world: a git project with a linked worktree, fake harnesses on a scratch PATH, a scratch HOME. Ends every child it started. */
function world(t: any, { fakes = ['claude', 'codex', 'opencode', 'pi'], extraEnv = {} as Record<string, string> } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-start-e2e-')));
  const w: any = {
    dir, home: path.join(dir, 'home'), config: path.join(dir, 'config'), main: path.join(dir, 'proj'), linked: path.join(dir, 'proj-linked'),
    bin: path.join(dir, 'bin'), log: path.join(dir, 'fake.log'), fakeDir: path.join(dir, 'fake'),
  };
  fs.mkdirSync(w.main, { recursive: true });
  git(w.main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w.main, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(w.main, '.gitignore'), '.doflow/\n');
  git(w.main, 'add', '-A');
  git(w.main, 'commit', '-q', '-m', 'first');
  git(w.main, 'worktree', 'add', '-q', '-b', 'feat-x', w.linked);
  fs.mkdirSync(path.join(w.main, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(path.join(w.home, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(path.join(w.config, 'doflow'), { recursive: true });
  fs.mkdirSync(w.fakeDir);
  // The index primer the start-session unit test uses: the project is listed because HOME names it, no retry loop.
  fs.writeFileSync(path.join(w.home, '.doflow', 'state', 'upkeep-roots'), `${w.main}\n`);
  fs.mkdirSync(w.bin);
  const script = path.join(dir, 'fake-harness.js');
  fs.writeFileSync(script, FAKE, { mode: 0o755 });
  for (const name of fakes) fs.symlinkSync(script, path.join(w.bin, name));
  fs.symlinkSync(process.execPath, path.join(w.bin, 'node'));
  const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(gitPath, path.join(w.bin, 'git'));
  w.env = {
    HOME: w.home, XDG_CONFIG_HOME: w.config, TMPDIR: process.env.TMPDIR, PATH: w.bin,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off',
    FAKE_LOG: w.log, FAKE_DIR: w.fakeDir, ...extraEnv,
  };
  w.key = cwdHash(w.main);
  w.mainKey = cwdHash(w.main);
  w.linkedKey = cwdHash(w.linked);
  w.store = path.join(w.main, '.doflow', 'state', 'worker-runs', 'started-sessions.json');
  const closers: Array<() => void> = [];
  w.onClose = (fn: () => void) => closers.push(fn);
  w.open = () => { fs.writeFileSync(path.join(w.fakeDir, 'end'), ''); };
  w.calls = (): any[] => (fs.existsSync(w.log) ? fs.readFileSync(w.log, 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l)) : []);
  w.runs = (): any => { try { return JSON.parse(fs.readFileSync(w.store, 'utf8')).runs ?? {}; } catch { return {}; } };
  w.core = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [CORE, ...args, '--json'], { cwd: w.main, env: { ...w.env, ...env }, encoding: 'utf8' });
    return { status: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
  };
  t.after(() => {
    // End every process group the store recorded (supervisor and harness) and every fake, then the scratch dir.
    try { fs.writeFileSync(path.join(w.fakeDir, 'end'), ''); } catch { /* gone */ }
    const runs = w.runs();
    for (const run of Object.values(runs) as any[]) {
      for (const proc of [run.worker, run.supervisor]) {
        if (proc && Number.isInteger(proc.pid)) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(proc.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    for (const call of w.calls()) { try { process.kill(call.pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const fn of closers.splice(0).reverse()) { try { fn(); } catch { /* closed */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return w;
}

function scratchLog(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-start-e2e-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createActionLog({ dir });
  const file = path.join(dir, 'actions.ndjson');
  const lines = (): any[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line)) : []);
  const text = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return { dir, log, lines, text };
}

/** The real Console pieces over the world: runner, live hub, actions, one action log. `restart` replaces them, keeping the log and devices. */
function pieces(t: any, w: any, opts: { env?: Record<string, string>, log?: any } = {}) {
  const runner = createVerbRunner({ corePath: CORE, projectRoot: w.main, env: { ...w.env, ...(opts.env ?? {}) } });
  const hub = createLiveHub({ runner, supervisor: createLiveChild({ runner }) });
  const scratch = opts.log ?? scratchLog(t);
  const actions = createActions({ runner, log: scratch.log, warn: () => {} });
  const stop = () => { try { hub.stop(); } catch { /* stopped */ } try { actions.stop(); } catch { /* stopped */ } try { runner.stop(); } catch { /* stopped */ } };
  t.after(stop);
  return { runner, hub, actions, scratch, stop, place: { projectRoot: w.main, home: w.home } };
}

/** The real loopback server over a launch-code session: a cookie client for GET and POST. */
async function loopback(t: any, w: any, opts: { env?: Record<string, string>, log?: any } = {}) {
  const p = pieces(t, w, opts);
  const sessions = createSessions();
  const app = await createServer({ webRoot, routes: consoleRoutes(p.runner, sessions, p.hub, p.place, p.actions) });
  t.after(() => app.close());
  const cookie = `${cookieName(app.port)}=${sessions.exchange(sessions.mintLaunchCode())}`;
  const request = (method: string, target: string, payload?: unknown): Promise<{ status: number, headers: Record<string, any>, body: string }> => new Promise((resolve, reject) => {
    const text = payload === undefined ? undefined : JSON.stringify(payload);
    const headers: Record<string, string> = { Host: `127.0.0.1:${app.port}`, Cookie: cookie, Connection: 'close' };
    if (method !== 'GET') headers.Origin = `http://127.0.0.1:${app.port}`;
    if (text !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(text)); }
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path: target, agent: false, headers }, (res: any) => {
      const chunks: any[] = [];
      res.on('data', (chunk: any) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(text);
  });
  /** An open `/api/live` stream over the channels: its parsed frames, growing. */
  const live = (channels: string[]) => {
    const frames: any[] = [];
    const req = http.request({ host: '127.0.0.1', port: app.port, method: 'GET', path: `/api/live?ch=${channels.join(',')}`, agent: false, headers: { Host: `127.0.0.1:${app.port}`, Cookie: cookie } }, (res: any) => {
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const data = buffer.slice(0, at).split('\n').filter((line: any) => line.startsWith('data: ')).map((line: any) => line.slice(6)).join('');
          buffer = buffer.slice(at + 2);
          if (data !== '') { try { frames.push(JSON.parse(data)); } catch { /* not a frame */ } }
        }
      });
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end();
    t.after(() => req.destroy());
    return frames;
  };
  return { ...p, app, request, live, post: (id: string, body: unknown) => request('POST', `/api/actions/${id}`, body) };
}

/** The real LAN server (https, Bearer) over scratch devices. */
async function lan(t: any, w: any, opts: { env?: Record<string, string>, log?: any } = {}) {
  const p = pieces(t, w, opts);
  const devices = lanWorld(t);
  const server = await lanServer(t, devices, consoleRoutes(p.runner, devices.auth, p.hub, p.place, p.actions), webRoot);
  const post = (id: string, body: unknown, bearer: string) =>
    server.request('POST', `/api/actions/${id}`, { headers: { 'Content-Type': 'application/json', Authorization: bearer }, body: JSON.stringify(body) });
  const get = (target: string, bearer: string) => server.request('GET', target, { headers: { Authorization: bearer } });
  return { ...p, devices, server, post, get };
}

const startBody = (w: any, over: Record<string, unknown> = {}) => ({
  v: 1, requestId: rid(), projectKey: w.key, worktreeKey: w.linkedKey, harness: 'codex', model: null, provider: null, effort: null, entry: 'do', prompt: `hello ${MARKER}`, ...over,
});

async function until(check: () => any, what: string, ms = 20_000) {
  const stop = Date.now() + ms;
  for (;;) {
    const got = check();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const textOf = (frames: any[]) => frames.filter((f) => f.type === 'snapshot' || f.type === 'append').flatMap((f) => f.data.pieces ?? []).map((p: any) => p.text).join('');
const startedNodes = (w: any) => {
  const tree = w.core(['fleet', '--action', 'tree']);
  assert.equal(tree.status, 0, tree.stderr);
  return JSON.stringify(tree.json).match(/"kind":"started-session"/g)?.length ?? 0;
};
/** Every pid the fakes and the store name is gone, within 10 s of the end this test asked for (a real leftover still fails). */
const noProcess = async (w: any) => {
  const pids = () => [...w.calls().map((call: any) => call.pid), ...(Object.values(w.runs()) as any[]).flatMap((run: any) => [run.worker, run.supervisor]
    .filter((proc: any) => proc && Number.isInteger(proc.pid)).map((proc: any) => proc.pid))];
  const stop = Date.now() + 10_000;
  while (pids().some(alive) && Date.now() < stop) await sleep(50);
  for (const pid of pids()) assert.equal(alive(pid), false, `process ${pid} ended`);
};

test('a control device over Bearer starts a fake codex session and its out log streams', { ...POSIX, timeout: 90_000 }, async (t: any) => {
  const w = world(t);
  const lb = await loopback(t, w);
  const reply = await lb.post('start-session', startBody(w));
  assert.equal(reply.status, 200, reply.body);
  const answer = json(reply);
  assert.deepEqual([answer.action, answer.outcome, answer.by], ['start-session', 'applied', 'console']);
  const run = answer.result.run;
  assert.equal(run.kind, 'main-session');
  assert.equal(run.harness, 'codex');
  assert.equal(run.phase, 'running');
  const frames = lb.live([`file:${w.key}:${run.files.out}`]);
  await until(() => textOf(frames).includes('first line'), 'the first line on the live channel');
  assert.equal(textOf(frames).includes('second line'), false, 'the second line is not out yet');
  assert.equal(w.runs()[run.runId].phase !== 'ended', true);
  // C-5 end to end: the second line reaches the follower while the run is still running.
  fs.writeFileSync(path.join(w.fakeDir, 'go2'), '');
  const wrote = Date.now();
  await until(() => textOf(frames).includes('second line'), 'the second line on the live channel', 15_000);
  const arrivedMs = Date.now() - wrote;
  assert.notEqual(w.runs()[run.runId].phase, 'ended', 'the run was still running when the second line arrived');
  assert.equal(w.core(['worker', '--action', 'status', '--slug', 'started-sessions', '--worker-run', run.runId]).json.state, 'running');
  console.log(`# second line arrived ${arrivedMs} ms after it was written`);

  assert.equal(startedNodes(w), 1, 'one started-session node');
  assert.equal(w.calls().length, 1, 'one fake launched');
  assert.equal(w.calls()[0].env.DOFLOW_STARTED_RUN, run.runId, 'the session carries its run id');
  // Row 173 §6.6: the core sends the person's text as the request document of a prompt frame whose instruction is the entry line.
  assert.equal(w.calls()[0].stdin, [
    '<input>', '<document id="request">', `hello ${MARKER}`, '</document>', '</input>', '',
    '<instructions>', 'Use the DoFlow do skill for the request in input.', '', '## Stop rule', 'Stop when the do skill\'s workflow ends or asks the person a question.', '</instructions>', '',
    '<output_format>', 'The person who started this session reads this reply; put the conclusion first.', '</output_format>', '',
  ].join('\n'));

  const cancel = await lb.post('cancel-worker', { v: 1, requestId: rid(), projectKey: w.key, slug: 'started-sessions', runId: run.runId, reason: 'stop it' });
  assert.equal(cancel.status, 200, cancel.body);
  assert.equal(json(cancel).result.endState, 'cancelled');
  const ended = await until(() => (w.runs()[run.runId]?.phase === 'ended' ? w.runs()[run.runId] : null), 'the run to end');
  assert.equal(ended.end.state, 'cancelled');
  await until(() => !alive(w.calls()[0].pid), 'the fake to be gone', 10_000);
  await noProcess(w);
});

test('a control device over Bearer starts: startedBy is device.d-<12 hex>; the action log carries device, project, harness, model, time and prompt length and never the prompt', { ...POSIX, timeout: 90_000 }, async (t: any) => {
  const w = world(t);
  const l = await lan(t, w);
  const control = await l.devices.pair('control', 'Phone');
  const body = startBody(w);
  const reply = await l.post('start-session', body, control.bearer);
  assert.equal(reply.status, 200, reply.body);
  const run = json(reply).result.run;
  assert.match(run.startedBy, /^device\.d-[0-9a-f]{12}$/);
  assert.equal(run.startedBy, `device.${control.device.id}`);
  assert.equal(json(reply).by, run.startedBy);
  assert.equal(w.runs()[run.runId].startedBy, run.startedBy, 'the core recorded it');
  await l.actions.stop();
  const lines = l.scratch.lines();
  const begin = lines.find((line: any) => line.phase === 'begin' && line.action === 'start-session');
  const end = lines.find((line: any) => line.phase === 'end' && line.action === 'start-session');
  assert.ok(begin && end, JSON.stringify(lines));
  assert.equal(end.outcome, 'applied');
  assert.equal(end.actor.deviceId, control.device.id);
  // 165 review B-6: each fact in its own field, not a substring of the line.
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  assert.match(begin.at, ISO, 'the begin time');
  assert.match(end.at, ISO, 'the end time');
  assert.ok(Date.parse(end.at) >= Date.parse(begin.at), 'the end is not before the begin');
  for (const line of [begin, end]) {
    assert.equal(line.project, w.key, 'the project');
    assert.deepEqual(line.target, { slug: null, taskId: null, gateId: null, runId: line === end ? run.runId : null, worktreeKey: w.linkedKey, harness: 'codex', model: 'default' }, 'harness, model default, checkout');
    assert.deepEqual(line.input, { decision: null, textBytes: Buffer.byteLength(body.prompt, 'utf8'), entry: 'do' }, 'the prompt size in bytes and the entry');
    assert.deepEqual([line.actor.kind, line.actor.deviceId, line.actor.scope, line.actor.transport], ['device', control.device.id, 'control', 'native']);
  }
  assert.equal(l.scratch.text().includes(MARKER), false, 'the prompt text is in no log line');
  assert.equal(reply.body.includes(MARKER), false, 'the prompt text is in no reply');
  assert.equal(JSON.stringify(w.runs()).includes(MARKER), false, 'nor in the run record');
  w.open();
});

test('refusals: view 403 phone-scope; browser-transport control 403 action-transport; unknown project 404; not-startable 409; second start in a checkout 409 checkout-busy; leading dash 400; nested start 409', { ...POSIX, timeout: 120_000 }, async (t: any) => {
  const w = world(t);
  const l = await lan(t, w);
  const view = await l.devices.pair('view', 'Viewer');
  const control = await l.devices.pair('control', 'Phone');
  const spawned = () => w.calls().length;

  const asView = await l.post('start-session', startBody(w), view.bearer);
  assert.deepEqual([asView.status, json(asView).error.code], [403, 'phone-scope']);
  const asBrowser = await l.server.request('POST', '/api/actions/start-session', {
    headers: { 'Content-Type': 'application/json', Cookie: control.cookie, Origin: l.server.origin, 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(startBody(w)),
  });
  assert.equal(asBrowser.status, 403, asBrowser.body);
  assert.equal(json(asBrowser).error.code, 'action-transport');
  const unknown = await l.post('start-session', startBody(w, { projectKey: '0123456789abcdef' }), control.bearer);
  assert.deepEqual([unknown.status, json(unknown).error.code], [404, 'project-not-found']);
  const noCopilot = await l.post('start-session', startBody(w, { harness: 'copilot' }), control.bearer);
  assert.deepEqual([noCopilot.status, json(noCopilot).error.code], [409, 'harness-not-startable'], noCopilot.body);
  assert.equal(json(noCopilot).current.harness, 'copilot');
  const gone = await l.post('start-session', startBody(w, { harness: 'claude' }), control.bearer);
  assert.equal(gone.status, 200, 'claude is on the scratch PATH and starts');
  await until(() => w.calls().length >= 1, 'the fake to start');
  assert.equal(spawned(), 1, 'only the one valid start spawned');
  // Same checkout again: the open session holds it.
  const busy = await l.post('start-session', startBody(w, { harness: 'codex' }), control.bearer);
  assert.deepEqual([busy.status, json(busy).error.code], [409, 'checkout-busy'], busy.body);
  assert.equal(json(busy).current.runId, json(gone).result.run.runId);
  assert.equal(spawned(), 1, 'a refusal spawns nothing');
  // A leading dash is refused for the argv harness whatever the entry, and for any harness with entry none (in the other checkout).
  // pi with entry do is not in the loop: since row 170 pi has a control channel, so its prompt goes on stdin, not argv, and the dash is
  // accepted by design (session-prompt.test.ts 'the leading-dash rule'); posting it here would spawn a session and take the checkout.
  const dashes = await lan(t, w);
  const dashDevice = await dashes.devices.pair('control', 'Dash phone');
  for (const [harness, entry] of [['opencode', 'do'], ['opencode', 'none'], ['pi', 'none']]) {
    const dash = await dashes.post('start-session', startBody(w, { harness, entry, worktreeKey: w.mainKey, prompt: `-x ${MARKER}` }), dashDevice.bearer);
    assert.deepEqual([dash.status, json(dash).error.code], [400, 'prompt-leading-dash'], `${harness}/${entry}: ${dash.body}`);
  }
  assert.equal(spawned(), 1);

  // Nested start: the first session's own environment names its run; a start made with that environment is refused.
  const call = w.calls()[0];
  assert.match(call.env.DOFLOW_STARTED_RUN, /^w-[0-9a-f]{12}$/);
  // The core itself, called from inside the session with the variable the fake recorded, refuses it; a Console run inside a started
  // session passes the variable for the start shape (verb-runner.ts WRITE_PASS_THROUGH), see the B-1 test below.
  const nested = spawnSync(process.execPath, [CORE, 'worker', '--action', 'start-session', '--project-key', w.key, '--worktree-key', w.mainKey, '--harness', 'codex',
    '--entry', 'do', '--via', 'console', '--request-id', rid(), '--stdin', '--json'], {
    cwd: w.main, input: 'nested hello', encoding: 'utf8', env: { ...w.env, DOFLOW_STARTED_RUN: call.env.DOFLOW_STARTED_RUN },
  });
  assert.equal(nested.status, 1, nested.stdout + nested.stderr);
  const refusal = JSON.parse(nested.stdout);
  assert.deepEqual([refusal.ok, refusal.code, refusal.current.runId], [false, 'nested-start', call.env.DOFLOW_STARTED_RUN]);
  assert.equal(spawned(), 1, 'a nested start spawns nothing');
  w.open();
  await until(() => w.runs()[json(gone).result.run.runId]?.phase === 'ended', 'the session to end');
  await noProcess(w);
});

test('a harness not on the scratch PATH is 409 harness-not-startable, and nothing spawns', { ...POSIX, timeout: 60_000 }, async (t: any) => {
  const w = world(t, { fakes: ['codex'] });
  const l = await lan(t, w);
  const control = await l.devices.pair('control', 'Phone');
  const reply = await l.post('start-session', startBody(w, { harness: 'pi' }), control.bearer);
  assert.deepEqual([reply.status, json(reply).error.code], [409, 'harness-not-startable'], reply.body);
  assert.equal(json(reply).current.reason, 'not-installed');
  assert.equal(w.calls().length, 0);
});

test('165 review B-1: a Console run inside a started session passes DOFLOW_STARTED_RUN to the core for a start only: 409 nested-start, nothing spawns, reads are unchanged', { ...POSIX, timeout: 60_000 }, async (t: any) => {
  const w = world(t);
  const inside = 'w-0123456789ab';
  const l = await loopback(t, w, { env: { DOFLOW_STARTED_RUN: inside } });
  const reply = await l.post('start-session', startBody(w));
  assert.deepEqual([reply.status, json(reply).error.code], [409, 'nested-start'], reply.body);
  assert.equal(w.calls().length, 0, 'a nested start spawns nothing');
  assert.deepEqual(w.runs(), {}, 'and records nothing');
  const options = await l.request('GET', `/api/start/options?projectKey=${w.key}`);
  assert.equal(options.status, 200, 'a read is not refused: the variable reaches the start shape only');
});

test('the same requestId is one run (memo); after a Console restart it is 200 replayed with the first run id and nothing new spawns', { ...POSIX, timeout: 90_000 }, async (t: any) => {
  const w = world(t);
  const log = scratchLog(t);
  const first = await loopback(t, w, { log });
  const body = startBody(w);
  const [a, b] = await Promise.all([first.post('start-session', body), first.post('start-session', body)]);
  const replies = [a, b];
  assert.ok(replies.every((r) => r.status === 200), replies.map((r) => r.body).join(' | '));
  const ids = replies.map((r) => json(r).result.run.runId);
  assert.equal(ids[0], ids[1], 'one run for a double tap');
  assert.equal(Object.keys(w.runs()).length, 1);
  await until(() => w.calls().length >= 1, 'the fake to start');
  assert.equal(w.calls().length, 1, 'one spawn');
  first.stop();
  await first.app.close();

  const second = await loopback(t, w, { log });
  const again = await second.post('start-session', body);
  assert.equal(again.status, 200, again.body);
  assert.equal(json(again).result.replayed, true);
  await second.actions.stop();
  assert.equal(log.lines().filter((line: any) => line.phase === 'end').at(-1).outcome, 'replayed', JSON.stringify(log.lines()));
  assert.equal(json(again).result.run.runId, ids[0]);
  assert.equal(Object.keys(w.runs()).length, 1);
  assert.equal(w.calls().length, 1, 'nothing new spawned');
  w.open();
});

/**
 * One real core process starting `codex` in the linked checkout of `w` as `actor` (the core's `--via` label), its fake told to wait on
 * `fakeDir`: `{ exit, body }` once it exits.
 */
function raceStart(w: any, fakeDir: string, actor: string): Promise<{ exit: number | null, body: any, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CORE, 'worker', '--action', 'start-session', '--project-key', w.key, '--worktree-key', w.linkedKey, '--harness', 'codex',
      '--entry', 'none', '--via', actor, '--request-id', rid(), '--stdin', '--json'], { cwd: w.main, env: { ...w.env, FAKE_DIR: fakeDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: any) => { out += chunk; });
    child.stderr.on('data', (chunk: any) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (exit: number | null) => { try { resolve({ exit, body: JSON.parse(out), stderr: err }); } catch { reject(new Error(`no JSON (exit ${exit}): ${out} ${err}`)); } });
    child.stdin.end('race');
  });
}

const RACE_ROUNDS = 20;

test(`165 review B-7: two real core processes start in one checkout at once, ${RACE_ROUNDS} rounds: exactly one is admitted each round, the other is refused checkout-busy`, { ...POSIX, timeout: 240_000 }, async (t: any) => {
  const w = world(t);
  const admitted: string[] = [];
  for (let round = 0; round < RACE_ROUNDS; round += 1) {
    // Each round's fakes wait on their own directory, so ending one round's session never ends the next round's early.
    const fakeDir = path.join(w.dir, `race-${round}`);
    fs.mkdirSync(fakeDir);
    // Both are spawned in the same tick and meet only at the core's run-store lock: no sleep orders them.
    // 170 R-5: the core allows an actor 6 starts an hour. Each round is its own actor, so the twenty rounds do not meet that limit and the
    // two starts of a round, one actor, still meet only the checkout lock.
    const actor = `device.d-${round.toString(16).padStart(12, '0')}`;
    const replies = await Promise.all([raceStart(w, fakeDir, actor), raceStart(w, fakeDir, actor)]);
    const won = replies.filter((r) => r.exit === 0);
    const lost = replies.filter((r) => r.exit !== 0);
    assert.equal(won.length, 1, `round ${round}: ${JSON.stringify(replies.map((r) => [r.exit, r.body]))}`);
    assert.deepEqual([lost[0].exit, lost[0].body.ok, lost[0].body.code], [1, false, 'checkout-busy'], `round ${round}: ${JSON.stringify(lost[0].body)}`);
    const runId = won[0].body.run.runId;
    assert.deepEqual(lost[0].body.current, { runId }, 'the refusal names the admitted run');
    const open = Object.values(w.runs()).filter((run: any) => run.phase !== 'ended');
    assert.deepEqual(open.map((run: any) => run.runId), [runId], `round ${round}: one open run in the checkout`);
    admitted.push(runId);
    fs.writeFileSync(path.join(fakeDir, 'end'), '');
    await until(() => w.runs()[runId]?.phase === 'ended', `round ${round}'s session to end`, 30_000);
  }
  assert.equal(new Set(admitted).size, RACE_ROUNDS);
  assert.equal(Object.keys(w.runs()).length, RACE_ROUNDS, 'one run recorded per round, none for a refused start');
});

test('GET /api/start and /api/start/options for the loopback session: every registry harness listed, the fake ones startable, none preferred', { ...POSIX, timeout: 60_000 }, async (t: any) => {
  const w = world(t);
  const lb = await loopback(t, w);
  const projects = await lb.request('GET', '/api/start');
  assert.equal(projects.status, 200, projects.body);
  assert.ok(json(projects).projects.some((p: any) => p.projectKey === w.key), 'the scratch project is listed');
  const options = await lb.request('GET', `/api/start/options?projectKey=${w.key}`);
  assert.equal(options.status, 200, options.body);
  const body = json(options);
  const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8'));
  const ids = (Array.isArray(registry) ? registry : registry.harnesses ?? Object.keys(registry).map((id) => ({ id, ...registry[id] }))).map((h: any) => h.id);
  const listed = body.harnesses.map((h: any) => h.harness);
  assert.deepEqual([...listed].sort(), [...ids].sort(), 'every registry harness is listed');
  const startable = (id: string) => body.harnesses.find((h: any) => h.harness === id);
  for (const id of ['claude', 'codex', 'opencode', 'pi']) assert.equal(startable(id).startable, true, `${id}: ${JSON.stringify(startable(id))}`);
  assert.equal(startable('copilot').startable, false);
  assert.equal(body.harnesses.some((h: any) => h.preferred === true || h.default === true), false, 'none preferred');
  // 165 review B-5: the real field, `checkouts`, with the linked checkout present beside the main one.
  assert.equal('worktrees' in body, false);
  assert.ok(Array.isArray(body.checkouts), JSON.stringify(body).slice(0, 200));
  assert.deepEqual(body.checkouts.map((c: any) => [c.worktreeKey, c.main, c.busy]), [[w.mainKey, true, null], [w.linkedKey, false, null]], 'the main checkout first, then the linked one, neither busy');
  for (const c of body.checkouts) assert.deepEqual(Object.keys(c).sort(), ['branch', 'busy', 'label', 'main', 'observedSession', 'worktreeKey']);

});

test('178 O-3, O-6 (a): a Console started from a Claude Code shell offers the claude default with no session to follow, and its start passes no --effort', { ...POSIX, timeout: 90_000 }, async (t: any) => {
  const w = world(t);
  const lb = await loopback(t, w, { env: { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_EFFORT: 'high' } });
  const options = await lb.request('GET', `/api/start/options?projectKey=${w.key}`);
  assert.equal(options.status, 200, options.body);
  const claude = json(options).harnesses.find((h: any) => h.harness === 'claude');
  assert.deepEqual(claude.models.at(-1).effortPlan, { pass: null, source: 'none', reason: 'session-unknown', session: { harness: null, reason: 'no-session-harness', level: null, origin: null } });
  const reply = await lb.post('start-session', startBody(w, { harness: 'claude' }));
  assert.equal(reply.status, 200, reply.body);
  const [call] = await until(() => (w.calls().length >= 1 ? w.calls() : null), 'the fake claude to start');
  assert.equal(call.argv.includes('--effort'), false, JSON.stringify(call.argv));
  const run = (w.runs() as any)[json(reply).result.run.runId];
  assert.deepEqual([run.binding.effort, run.binding.flag, run.binding.effortPlan.source], [null, null, 'none']);
});

test('178 F-11: with primary.harness pi in the settings, a Console start still declares no main harness: its plan and note are the O-3 "no harness session to follow"', { ...POSIX, timeout: 90_000 }, async (t: any) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.config, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'primary.harness': 'pi' }));
  const declared = w.core(['primary', '--action', 'resolve']);
  assert.equal(declared.json?.declared?.harness, 'pi', `the settings declare pi outside the Console: ${JSON.stringify(declared.json)}`);
  const lb = await loopback(t, w);
  const options = await lb.request('GET', `/api/start/options?projectKey=${w.key}`);
  assert.equal(options.status, 200, options.body);
  const plan = json(options).harnesses.find((h: any) => h.harness === 'claude').models.at(-1).effortPlan;
  const o3 = { pass: null, source: 'none', reason: 'session-unknown', session: { harness: null, reason: 'no-session-harness', level: null, origin: null } };
  assert.deepEqual(plan, o3);
  const { effortText } = require('../../src/runtime/models/effort-text.ts');
  assert.equal(effortText(plan, { worker: 'claude' }), 'harness default (no harness session to follow)');
  const reply = await lb.post('start-session', startBody(w, { harness: 'claude' }));
  assert.equal(reply.status, 200, reply.body);
  await until(() => (w.calls().length >= 1 ? w.calls() : null), 'the fake claude to start');
  assert.deepEqual((w.runs() as any)[json(reply).result.run.runId].binding.effortPlan, o3);
});
