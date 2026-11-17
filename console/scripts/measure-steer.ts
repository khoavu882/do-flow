'use strict';

// Send-to-page lag of a message to a started session (row 170 T8b; requirement NFR-003, design section 10). Dev only: console/scripts/ is
// not in the package's `files`. It follows measure-layers.ts (feature 161 T8), whose budget it keeps (row 161: p50 < 300 ms, max < 1000 ms).
//
//   node console/scripts/measure-steer.ts [--core <abs path to bin/doflow.js>] [--samples <1..40>]
//
// The world is a scratch git project with ONE started channel session over `test/helper/fake-channel-harness.ts` (a stand-in shaped like
// Pi's RPC mode; never a real harness): the run record is seeded as start-session writes it and supervised in this process by the real
// supervisor, on a PATH that holds a scratch bin/ alone (the fake as `fake-pi`, node, git), so no real harness CLI can run. The Console is
// the real one (bin/doflow-ui.js) as a child over that project and the real core. The page side runs here over the web modules (copied
// into a scratch folder as an ES module tree): the transport adapter (live.js) over an SSE reader on node:http, the live store (store.js),
// the Layers project view's own connector (views.js VIEWS['layers-project'].connect, which holds the `channels` section) and the file
// lane's log stream (log-store.js createLogStream), the lane the session pane follows.
//
// A sample is one message: while the turn is waiting, `worker --action send` writes a follow-up through the core (one message from a fresh
// `device.d-<12 hex>` actor each, so the core's own six-a-minute limit per actor, R-5, is never met), and the supervisor's ledger entry
// names the time it was admitted (`message.at` of the reply). The fake then starts a turn and prints `working on record <n>`. Two
// intervals run from that admission time:
//   reply: to the first change of the file lane's log stream that holds this message's reply line;
//   turn:  to the first Layers-connector data whose `channels` item says the turn is `working` after the turn it was waiting in.
// The fake holds each turn open until its gate file is written, so the turn change is a state the page can see; the gate is released
// once both were seen. This is the page's data path up to the point where the view paints from it, not a render or a browser paint.
//
// Output: one JSON object on stdout; the three verdict lines (reply, turn, verdict) on stderr and in the JSON `lines`. Exit 0 when, for
// both, p50 < 300 ms and max < 1000 ms; 1 when not or when the measurement failed; 2 on a usage error.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { summarize, P50_BAR_MS, MAX_BAR_MS } = require('./measure-layers.ts');
const { superviseRun } = require('../../src/runtime/worker/supervisor.ts');
const { storeFileFor, newRunId, insertRun, readRuns } = require('../../src/runtime/worker/run-store.ts');
const { writePrompt } = require('../../src/runtime/worker/session-prompt.ts');
const { mainLaunchRecord } = require('../../src/runtime/worker/launch.ts');
const { workerCatalogue } = require('../../src/runtime/worker/catalogue.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { listCheckouts } = require('../../src/runtime/checkouts.ts');

const REPO = path.resolve(__dirname, '..', '..');
const WEB_ROOT = path.join(__dirname, '..', 'web');
const UI_BIN = path.join(__dirname, '..', 'bin', 'doflow-ui.js');
const DEFAULT_CORE = path.join(REPO, 'bin', 'doflow.js');
/** The only harness this script runs, by its path under the repo. */
const FAKE_HARNESS = 'test/helper/fake-channel-harness.ts';
const FAKE_CHANNEL = path.join(REPO, FAKE_HARNESS);
const USAGE = 'usage: measure-steer.ts [--core <absolute path to bin/doflow.js>] [--samples <1 to 40>]';
const DEFAULT_SAMPLES = 12;
/** The core keeps 128 ledger entries and 16 spool files; 40 samples stay well inside both. */
const MAX_SAMPLES = 40;
const MEASURE = 'the page data path (adapter, store, Layers connector or file-lane log stream), not a render or a browser paint';
const BOOT_MS = 60_000;
const LIVE_MS = 30_000;
const STEP_MS = 20_000;
const GAP_MS = 150;
const STOP_MS = 10_000;
const URL_LINE = /^doflow ui: http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]{64})$/m;

const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (ms: number) => Math.round(ms * 10) / 10;

/** Waits in real time until `check` holds; throws with `label` after `ms`. */
async function until(check: () => boolean, label: string, ms: number) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error(`measure-steer: timed out after ${ms} ms: ${label}`);
    await realDelay(5);
  }
}

// ---- the numbers -----------------------------------------------------------------------------------------------------------------

/** Each of the two intervals passes when its p50 < 300 ms and its max < 1000 ms; the run exits 0 when both do. */
function verdict(samples: { reply: number[], turn: number[] }) {
  const judge = (list: number[]) => { const s = summarize(list); return { ...s, ok: s.p50 < P50_BAR_MS && s.max < MAX_BAR_MS }; };
  const reply = judge(samples.reply);
  const turn = judge(samples.turn);
  const ok = reply.ok && turn.ok;
  return { ok, exit: ok ? 0 : 1, reply, turn };
}

/** The verdict lines: p50 and max of each interval against the bars, then the verdict. */
function verdictLines(result: ReturnType<typeof verdict>): string[] {
  const line = (name: 'reply' | 'turn') => {
    const s = result[name];
    return `measure-steer: ${name.padEnd(5)} n=${s.n} p50 ${s.p50} ms (bar < ${P50_BAR_MS}) max ${s.max} ms (bar < ${MAX_BAR_MS}) ${s.ok ? 'ok' : 'FAIL'}`;
  };
  return [line('reply'), line('turn'), `measure-steer: verdict ${result.ok ? 'ok' : 'FAIL'}`];
}

// ---- the page's transport over node:http -----------------------------------------------------------------------------------------

type Origin = { port: number, cookie: string };

/** An EventSource constructor for live.js over node:http on the Console's origin (as measure-layers.ts); it does not reconnect. */
function nodeEventSource(origin: Origin, wire: { status: number | null }) {
  return class NodeEventSource {
    readyState = 0;
    listeners = new Map<string, Function[]>();
    req: any;
    constructor(url: string) {
      this.req = http.request({ host: '127.0.0.1', port: origin.port, path: url, agent: false, headers: { Cookie: origin.cookie, Accept: 'text/event-stream' } }, (res: any) => {
        wire.status = res.statusCode;
        if (res.statusCode !== 200) { res.resume(); this.fail(); return; }
        this.readyState = 1;
        this.emit('open', { type: 'open' });
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            this.dispatch(block);
          }
        });
        res.on('error', () => {});
        res.on('close', () => this.fail());
      });
      this.req.on('error', () => this.fail());
      this.req.end();
    }
    dispatch(block: string) {
      if (this.readyState !== 1) return;
      const data: string[] = [];
      let name = 'message';
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else if (field === 'event' && value !== '') name = value;
      }
      if (data.length > 0) this.emit(name, { type: name, data: data.join('\n') });
    }
    fail() {
      if (this.readyState === 2) return;
      this.readyState = 2;
      this.emit('error', { type: 'error' });
    }
    emit(type: string, event: any) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
    addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    close() { this.readyState = 2; this.req.destroy(); }
  };
}

/** The launch-code exchange the shell makes first (POST /api/session); the session cookie. */
function exchange(port: number, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/session', agent: false, headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } }, (res: any) => {
      res.resume();
      res.on('end', () => {
        const set = res.headers['set-cookie'];
        const line = Array.isArray(set) ? set[0] : set;
        if (res.statusCode !== 204 || typeof line !== 'string') reject(new Error(`measure-steer: the session exchange answered ${res.statusCode}`));
        else resolve(line.split(';')[0]);
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify({ code }));
  });
}

// ---- the world: a scratch project with one channel session over the fake harness ----------------------------------------------------

/** The channel the fake speaks (Pi's RPC shape, design 4.3), declared for this script only; no harness entry of the registry is changed. */
const CHANNEL = Object.freeze({
  status: 'supported', evidence: ['measure'], verification: 'declared for the latency measurement only', verifiedOn: '2026-11-17',
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
  unverified: ['declared for the measurement only'],
});

/** `opened`: the newest record number whose gate file was written (the cleanup opens every gate up to it). */
type World = { dir: string, root: string, key: string, runId: string, env: Record<string, string | undefined>, gate: string, opened: number, stop(): Promise<void> };

/** Builds the scratch project and starts the supervised session; resolves once its first turn is working. Under the OS temp folder, which the core's project listing does not leave out. */
async function buildWorld(): Promise<World> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-measure-steer-')));
  const root = path.join(dir, 'proj');
  const bin = path.join(dir, 'bin');
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    if (r.status !== 0) throw new Error(`measure-steer: git ${args.join(' ')}: ${r.stderr}`);
  };
  fs.mkdirSync(root);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  fs.mkdirSync(path.join(root, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(bin);
  fs.symlinkSync(FAKE_CHANNEL, path.join(bin, 'fake-pi'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const gitBinary = (process.env.PATH ?? '').split(path.delimiter).map((entry) => path.join(entry, 'git')).find((file) => fs.existsSync(file));
  if (!gitBinary) throw new Error('measure-steer: git is not on the PATH');
  fs.symlinkSync(gitBinary, path.join(bin, 'git'));
  fs.mkdirSync(path.join(dir, 'home', '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  // The project is listed because HOME names it (the start-session e2e's project index primer).
  fs.writeFileSync(path.join(dir, 'home', '.doflow', 'state', 'upkeep-roots'), `${root}\n`);
  const gate = path.join(dir, 'gate');
  const env: Record<string, string | undefined> = {
    HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'config'), TMPDIR: process.env.TMPDIR, PATH: bin,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off',
  };
  const file = storeFileFor(root, 'started-sessions');
  const key = cwdHash(listCheckouts({ cwd: root }).main);
  const supervising: Promise<any>[] = [];
  const world: World = { dir, root, key, runId: '', env, gate, opened: 0, stop: async () => {} };
  const stop = async () => {
    for (let n = 1; n <= world.opened + 2; n += 1) { try { fs.writeFileSync(`${gate}-${n}`, ''); } catch { /* gone */ } }
    let runs: any = {};
    try { runs = readRuns(file); } catch { runs = {}; }
    for (const run of Object.values(runs) as any[]) {
      for (const proc of [run.worker, run.supervisor]) {
        if (proc && Number.isInteger(proc.pid) && proc.pid !== process.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    for (const done of supervising) await Promise.race([done.catch(() => null), realDelay(5000)]);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const registry = loadRegistry({ repoRoot: REPO });
    const pi = workerCatalogue({ registry }).find((entry: any) => entry.id === 'pi').worker;
    const runId = newRunId();
    world.runId = runId;
    const descriptor: any = { ...structuredClone(pi), cli: { binary: path.join(bin, 'fake-pi') }, controlChannel: structuredClone(CHANNEL) };
    const first = 'first prompt';
    writePrompt(root, runId, first, { isEnded: () => false });
    const inserted = insertRun(file, {
      runId, kind: 'main-session', task: 'main-session', token: 1, request: `r${crypto.randomBytes(16).toString('base64url').slice(1)}`, childOf: null, harness: 'pi', phase: 'starting',
      createdAt: new Date().toISOString(), timeoutSeconds: 600, startedBy: 'console', project: { projectKey: key, worktreeKey: 'b'.repeat(16) },
      execWorktree: root, entry: 'none', binding: null,
      prompt: { store: 'session-prompts', name: `${runId}.prompt.txt`, sha256: crypto.createHash('sha256').update(first, 'utf8').digest('hex'), bytes: Buffer.byteLength(first) },
      ...mainLaunchRecord(descriptor, first, null, true),
      descriptor,
    });
    if (inserted.applied !== true) throw new Error('measure-steer: the session record was not inserted');
    supervising.push(superviseRun({ file, runId, env: { ...env, FAKE_CHANNEL_GATE: gate }, cwd: root, channel: { pollMs: 20 } }));
    await until(() => { const r = readRuns(file)[runId]; return r?.channel?.state === 'open' && r.channel.turn.state === 'working'; }, 'the first turn working', LIVE_MS);
    world.stop = stop;
    return world;
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The Console as a child over the scratch project and the real core; resolves once its URL line is out. */
async function startConsole(world: World, core: string, log: (line: string) => void) {
  const child = spawn(process.execPath, [UI_BIN, '--core', core, '--project', world.root, '--port', '0'], { cwd: world.root, env: world.env as any, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) => child.on('exit', (code: number | null) => { exitCode = code; resolve(); }));
  child.stdout.on('data', (chunk: any) => { out += chunk; });
  child.stderr.on('data', (chunk: any) => { err = (err + chunk).slice(-8192); log(String(chunk).trimEnd()); });
  const stop = async () => {
    if (exitCode === undefined) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
      await exited;
      clearTimeout(timer);
    }
  };
  try {
    await until(() => exitCode !== undefined || URL_LINE.test(out), 'the Console boot', BOOT_MS);
  } catch (error) {
    await stop();
    throw error;
  }
  const url = URL_LINE.exec(out);
  if (exitCode !== undefined || url === null) {
    await stop();
    throw new Error(`measure-steer: the Console did not boot (exit ${exitCode}); stderr ${JSON.stringify(err)}`);
  }
  return { port: Number(url[1]), code: url[2], stop };
}

/**
 * One follow-up through the core verb, from the actor `device.d-<n as 12 hex>`; the reply's admission time (ms since the epoch). The verb waits up
 * to 2 s for the supervisor's ledger entry and the supervisor runs in THIS process, so the child is awaited, never run synchronously.
 */
async function sendFollowUp(world: World, core: string, n: number, text: string): Promise<number> {
  const actor = `device.d-${n.toString(16).padStart(12, '0')}`;
  const requestId = `r${crypto.randomBytes(16).toString('base64url').slice(1)}`;
  const child = spawn(process.execPath, [core, 'worker', '--action', 'send', '--project-key', world.key, '--worker-run', world.runId, '--request-id', requestId, '--via', actor, '--stdin', '--json'], {
    cwd: world.root, env: world.env as any, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: any) => { stdout += chunk; });
  child.stderr.on('data', (chunk: any) => { stderr += chunk; });
  child.stdin.end(text);
  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('exit', (code: number | null) => { clearTimeout(timer); resolve(code); });
  });
  let body: any = null;
  try { body = JSON.parse(stdout); } catch { body = null; }
  if (status !== 0 || !body || body.ok !== true) throw new Error(`measure-steer: send ${n} exited ${status}: ${stdout}${stderr}`);
  if (body.message.state !== 'written') throw new Error(`measure-steer: send ${n} was ${body.message.state}, not written`);
  const at = Date.parse(body.message.at);
  if (!Number.isFinite(at)) throw new Error(`measure-steer: send ${n} has no admission time: ${JSON.stringify(body.message)}`);
  return at;
}

// ---- the measurement -------------------------------------------------------------------------------------------------------------

type Options = { core: string, samples: number, scratch: string, log?: (line: string) => void };

/**
 * Runs the world in a scratch folder (`scratch` holds the page's web copy; the caller owns and removes it) and measures `samples` follow-ups.
 * Resolves with the samples and their verdict; throws when a reply or a turn change is not seen or the page never goes live.
 */
async function measure(options: Options) {
  const { core, samples, scratch } = options;
  const log = options.log ?? (() => {});
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) throw new Error(`measure-steer: samples must be 1 to ${MAX_SAMPLES}`);
  const web = path.join(scratch, 'web');
  fs.cpSync(WEB_ROOT, web, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"type":"module"}\n');
  const load = (name: string) => import(pathToFileURL(path.join(web, name)).href);
  const [views, storeMod, live, logStore, derive] = await Promise.all([load('views.js'), load('store.js'), load('live.js'), load('log-store.js'), load('derive/layers.js')]);

  let world: World | null = null;
  let consoleChild: { stop(): Promise<void>, port: number, code: string } | null = null;
  let adapter: any = null;
  let connector: any = null;
  let local: any = null;
  let stream: any = null;
  try {
    world = await buildWorld();
    const w = world;
    consoleChild = await startConsole(w, core, log);
    const origin: Origin = { port: consoleChild.port, cookie: await exchange(consoleChild.port, consoleChild.code) };
    const wire = { status: null as number | null };
    adapter = live.createLiveAdapter({ EventSource: nodeEventSource(origin, wire), probe: async () => ({ status: wire.status ?? 0, code: null }) });
    const store = storeMod.createLiveStore({ adapter, visibility: { hidden: () => false, subscribe: () => () => {} } });

    // The Layers project view's connector: `layers:<pk>` and `machine`, folded into the data the view paints.
    let layersData: any = null;
    let following = false;
    const failures: any[] = [];
    /** Every change of the session's turn the connector delivered, with the time it arrived (ms since the epoch). */
    const turns: Array<{ at: number, state: string | null, seq: number | null }> = [];
    local = {};
    connector = views.VIEWS['layers-project'].connect(local, { project: w.key }, {
      store: () => store,
      onData: (data: any) => {
        const at = Date.now();
        following = data.stream.token === 'following';
        if (data.stream.token !== 'following' && data.stream.token !== 'connecting') failures.push(data.stream);
        layersData = data.layers;
        const turn = derive.channelIn(data.layers, w.runId).item?.turn;
        const state = turn && turn.observed === true ? turn.state : null;
        const seq = turn && turn.observed === true ? turn.seq : null;
        const last = turns[turns.length - 1];
        if (!last || last.state !== state || last.seq !== seq) turns.push({ at, state, seq });
      },
    });
    connector.start();
    const startedNode = () => {
      const tree = derive.sectionOf(layersData, 'tree');
      return tree.state === 'ok' ? tree.data.nodes.find((node: any) => node.kind === 'started-session' && node.runId === w.runId) ?? null : null;
    };
    await until(() => following && startedNode() !== null && derive.channelIn(layersData, w.runId).item !== null, `the Layers view live on ${w.key} with the session and its channels entry`, LIVE_MS);

    // The session's output lane, the one its pane follows: each reply line is `working on record <n>`.
    const lines = new Map<number, number>();
    stream = logStore.createLogStream({ store, file: { projectKey: w.key, fileKey: startedNode().fileKeys.out } });
    stream.onChange((state: any) => {
      const at = Date.now();
      for (const piece of state.pieces) for (const found of String(piece.text).matchAll(/working on record (\d+)/g)) if (!lines.has(Number(found[1]))) lines.set(Number(found[1]), at);
    });
    stream.open();
    // The first turn (the first prompt, record 1) is released and waits, so every sample starts from a waiting turn.
    fs.writeFileSync(`${w.gate}-1`, '');
    const waiting = () => { const last = turns[turns.length - 1]; return last !== undefined && last.state === 'waiting'; };
    await until(() => waiting() && lines.has(1), "the first turn's reply line and its settling on the page", LIVE_MS);
    log(`measure-steer: the Layers view is live on ${w.key}; the session ${w.runId} is waiting`);

    const out: { reply: number[], turn: number[] } = { reply: [], turn: [] };
    let early = 0;
    for (let step = 1; step <= samples; step += 1) {
      const record = step + 1;
      await realDelay(GAP_MS);
      const base = turns[turns.length - 1].seq as number;
      const admitted = await sendFollowUp(w, core, step, `message ${step}`);
      w.opened = record;
      const turnAfter = () => turns.find((t) => t.state === 'working' && (t.seq as number) > base) ?? null;
      await until(() => lines.has(record) && turnAfter() !== null, `the page showing the reply of record ${record} and its turn working`, STEP_MS);
      const replyMs = lines.get(record)! - admitted;
      const turnMs = turnAfter()!.at - admitted;
      if (replyMs < 0 || turnMs < 0) early += 1;
      out.reply.push(round(replyMs));
      out.turn.push(round(turnMs));
      log(`measure-steer: message ${step}: reply ${round(replyMs)} ms, turn ${round(turnMs)} ms`);
      fs.writeFileSync(`${w.gate}-${record}`, '');
      await until(waiting, `the turn of record ${record} settling on the page`, STEP_MS);
    }
    return { ...verdict(out), samples: out, early, viewFailures: failures.length };
  } finally {
    if (stream !== null) stream.close();
    if (connector !== null) connector.stop();
    if (local !== null) views.VIEWS['layers-project'].teardown(local);
    if (adapter !== null) adapter.close();
    if (consoleChild !== null) await consoleChild.stop();
    if (world !== null) await world.stop();
  }
}

/** The JSON the script prints for a finished measurement. */
function report(result: ReturnType<typeof verdict> & { samples: { reply: number[], turn: number[] }, early: number, viewFailures: number }) {
  const kind = (name: 'reply' | 'turn') => ({ samples: result.samples[name], min: result[name].min, p50: result[name].p50, p95: result[name].p95, max: result[name].max, ok: result[name].ok });
  return {
    measure: MEASURE,
    harness: { fake: FAKE_HARNESS, real: false },
    from: "the admission time the core's ledger gives a follow-up (`message.at` of the `worker --action send` reply), one message per fresh actor",
    to: {
      reply: "the first change of the session's `file:` lane log stream that holds this message's reply line",
      turn: "the first Layers-connector data whose `channels` item says the turn is working after the turn it was waiting in",
    },
    percentileMethod: 'nearest rank',
    bar: { p50Ms: P50_BAR_MS, maxMs: MAX_BAR_MS },
    reply: kind('reply'),
    turn: kind('turn'),
    ok: result.ok,
    lines: verdictLines(result),
    early: result.early,
    viewFailures: result.viewFailures,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
}

function parseFlags(argv: readonly string[]): { core: string, samples: number } | { error: string } {
  const flags = { core: DEFAULT_CORE, samples: DEFAULT_SAMPLES };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name !== '--core' && name !== '--samples') return { error: `unknown argument ${JSON.stringify(name)}` };
    if (value === undefined) return { error: `${name} needs a value` };
    index += 1;
    if (name === '--core') flags.core = value;
    else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_SAMPLES) flags.samples = Number(value);
    else return { error: `--samples needs a whole number from 1 to ${MAX_SAMPLES}` };
  }
  if (!path.isAbsolute(flags.core)) return { error: '--core must be an absolute path' };
  if (!fs.existsSync(flags.core)) return { error: `--core does not exist: ${flags.core}` };
  return flags;
}

async function main(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv);
  if ('error' in flags) {
    process.stderr.write(`measure-steer: ${flags.error}\n${USAGE}\n`);
    return 2;
  }
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-measure-steer-web-')));
  try {
    const result = await measure({ ...flags, scratch, log: (line) => process.stderr.write(`${line}\n`) });
    const printed = report(result);
    for (const line of printed.lines) process.stderr.write(`${line}\n`);
    process.stdout.write(`${JSON.stringify(printed)}\n`);
    return result.exit;
  } catch (error: any) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    return 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { P50_BAR_MS, MAX_BAR_MS, DEFAULT_SAMPLES, MAX_SAMPLES, FAKE_HARNESS, MEASURE, verdict, verdictLines, measure, report, parseFlags };

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
