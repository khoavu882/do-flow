'use strict';

// Append-to-page lag of the Layers streams (feature 161 T8; IC-010, AC-8, NFR-001). Dev only: console/scripts/ is not in the
// package's `files`. It follows measure-log.ts (feature 150, D.2).
//
//   node console/scripts/measure-layers.ts [--core <abs path to bin/doflow.js>] [--samples <1..100>]
//
// It starts the fixture Console (fixture-console.ts) as a child in `--layers` mode with the REAL core: a Claude hook session whose
// `subagent-audit.log` the core's `layers:<pk>` channel reads, and a task brief the artifacts index lists. Every append is a line
// written to the fixture's stdin: `audit` appends one SubagentStart line (agent id `m-<n>`) to the log, `brief` one line
// `brief chunk <n>` to the brief; the fixture prints `audit <n>` / `brief <n>` on stderr after the write returned.
//
// The page side runs in this process over the web modules (copied into a scratch folder as an ES module tree): the transport
// adapter (live.js) over an SSE reader on node:http, the live store (store.js), the Layers project view's own connector
// (views.js VIEWS['layers-project'].connect, which subscribes `layers:<pk>` and `machine` and folds them into the data the view
// paints) and, for the brief, the log store's file lane (log-store.js createLogStream({ store, file }), the lane the file pane
// follows). Both kinds go core `events` -> Console hub -> /api/live -> adapter -> store; nothing is read by a GET.
//
// A sample runs from reading the fixture's `audit <n>` / `brief <n>` line here (the time its stderr chunk arrived) to
//   audit: the first data the Layers connector delivers (the same tick the store changed in) whose `sessions` section lists the
//          line's agent key in its audit.recent, and
//   brief: the first change of the file lane's log stream whose pieces hold the text `brief chunk <n>`.
// This is the page's data path up to the point where the view paints from it, not a render: an audit line shows on the page only
// as a status word of an agent row (and a fixture agent that has no transcript is not a row), so a DOM would not show every
// line. The JSON says so in `measure`.
//
// 24 audit and 24 brief appends by default (--samples), alternating, each after the previous one was seen, with a random 100 to
// 400 ms gap. Output: one JSON object on stdout with p50, p95 and max per kind (nearest rank). Exit 0 when, for both kinds,
// p50 < 300 ms and max < 1000 ms; 1 when not or when the measurement failed; 2 on a usage error.
//
// The worst case is stated in the output (`worstCaseNote`), not hidden: when a watch event is lost, the core's 1 s backstop pass
// finds the change and the lag is about 1.2 s, above the 1 s max target. Plan DEC-007: the owner accepts that case.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { percentile } = require('./measure-log.ts');
const { sha16 } = require('../../src/runtime/scaffold/fingerprint.ts');
const { LAYERS, LAYERS_APPENDS } = require('./fixture-console.ts');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixture-console.ts');
const WEB_ROOT = path.join(__dirname, '..', 'web');
const DEFAULT_CORE = path.join(REPO, 'bin', 'doflow.js');
const USAGE = 'usage: measure-layers.ts [--core <absolute path to bin/doflow.js>] [--samples <1 to 100>]';

/** IC-010: p50 and max of append-to-page, per kind. */
const P50_BAR_MS = 300;
const MAX_BAR_MS = 1000;
const DEFAULT_SAMPLES = 24;
const MAX_SAMPLES = LAYERS_APPENDS;
const GAP_MIN_MS = 100;
const GAP_MAX_MS = 400;
const BOOT_MS = 90_000;
const LIVE_MS = 30_000;
/** An append not seen within this is a failed measurement. */
const STEP_MS = 40_000;
const SETTLE_MS = 500;
const STOP_MS = 10_000;
const MEASURE = 'the page data path (adapter, store, Layers connector or file-lane log stream), not a render or a browser paint';
const WORST_CASE_NOTE = 'Target: p50 < 300 ms and max < 1 s per kind while watch events arrive. When a watch event is lost the core finds the change on its 1 s backstop pass instead, and the lag is about 1.2 s (design IC-010; an estimate, not measured here): above the 1 s max target. Plan DEC-007: the owner accepts that case; it is stated, not hidden.';
const REQUIRED_KINDS = ['machine', 'layers', 'file'];

const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (ms: number) => Math.round(ms * 10) / 10;

/** Waits in real time until `check` holds; throws with `label` after `ms`. */
async function until(check: () => boolean, label: string, ms: number) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error(`measure-layers: timed out after ${ms} ms: ${label}`);
    await realDelay(5);
  }
}

// ---- the numbers -----------------------------------------------------------------------------------------------------------------

/** Count, min, p50 (nearest rank), p95 (nearest rank) and max of a kind's samples. */
function summarize(samples: number[]) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('summarize: no samples');
  return { n: samples.length, min: Math.min(...samples), p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples) };
}

/** IC-010: each kind passes when its p50 < 300 ms and its max < 1000 ms; the run exits 0 when both do. */
function verdict(samples: { audit: number[], brief: number[] }) {
  const judge = (list: number[]) => { const s = summarize(list); return { ...s, ok: s.p50 < P50_BAR_MS && s.max < MAX_BAR_MS }; };
  const audit = judge(samples.audit);
  const brief = judge(samples.brief);
  const ok = audit.ok && brief.ok;
  return { ok, exit: ok ? 0 : 1, audit, brief };
}

// ---- the page's transport over node:http ------------------------------------------------------------------------------------------

type Origin = { port: number, cookie: string };

/**
 * An EventSource constructor for live.js over node:http on the Console's origin (measure-log.ts's reader, without its render
 * bookkeeping). Unnamed messages reach `message` with their data, a named event (the keepalive) its own listeners; `open` on a
 * 200 head. It does not reconnect: on the end of the stream or a refused head it is CLOSED and fires `error`.
 */
function nodeEventSource(origin: Origin, wire: { status: number | null }) {
  return class NodeEventSource {
    readyState = 0;
    listeners = new Map<string, Function[]>();
    req: any;
    constructor(url: string) {
      this.req = http.request({ host: '127.0.0.1', port: origin.port, path: url, agent: false, headers: { Cookie: origin.cookie, Accept: 'text/event-stream' } }, (res: any) => {
        wire.status = res.statusCode;
        if (res.statusCode !== 200) {
          res.resume();
          this.fail();
          return;
        }
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
      if (data.length === 0) return;
      this.emit(name, { type: name, data: data.join('\n') });
    }
    fail() {
      if (this.readyState === 2) return;
      this.readyState = 2;
      this.emit('error', { type: 'error' });
    }
    emit(type: string, event: any) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
    addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    close() {
      this.readyState = 2;
      this.req.destroy();
    }
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
        if (res.statusCode !== 204 || typeof line !== 'string') reject(new Error(`measure-layers: the session exchange answered ${res.statusCode}`));
        else resolve(line.split(';')[0]);
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify({ code }));
  });
}

// ---- the fixture Console -----------------------------------------------------------------------------------------------------------

type Fixture = { port: number, code: string, append(kind: 'audit' | 'brief'): Promise<{ at: number, n: number }>, stop(): Promise<number | null> };

/** Starts fixture-console.ts --layers with its scratch under `scratchRoot`; resolves once its URL and project lines are out. */
async function startFixture(core: string, scratchRoot: string, log: (line: string) => void): Promise<Fixture> {
  const child = spawn(process.execPath, [FIXTURE, '--core', core, '--layers'], {
    env: { ...process.env, DOFLOW_FIXTURE_SCRATCH_ROOT: scratchRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) => child.on('exit', (code: number | null) => { exitCode = code; resolve(); }));
  let out = '';
  let errText = '';
  let pending = '';
  let booted = false;
  const lines: Record<'audit' | 'brief', Array<{ at: number, line: string }>> = { audit: [], brief: [] };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { out += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const at = performance.now();
    errText = (errText + chunk).slice(-8192);
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const line of parts) {
      if (/^fixture-console: scratch directory .+; project .+$/.test(line)) booted = true;
      // The line an append prints after the write returned, or the line of a failed or exhausted append.
      const found = /^fixture-console: (audit|brief) (?:\d+|failed.*)$/.exec(line) ?? /^fixture-console: no (audit|brief) line left$/.exec(line);
      if (found) lines[found[1] as 'audit' | 'brief'].push({ at, line });
      log(line);
    }
  });
  const stop = async () => {
    if (exitCode === undefined) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
      await exited;
      clearTimeout(timer);
    }
    return exitCode ?? null;
  };
  try {
    await until(() => exitCode !== undefined || (booted && /^doflow ui: /m.test(out)), 'the fixture Console boot', BOOT_MS);
  } catch (error) {
    await stop();
    throw error;
  }
  const url = /^doflow ui: http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]{64})$/m.exec(out);
  if (exitCode !== undefined || url === null) {
    await stop();
    throw new Error(`measure-layers: the fixture Console did not boot (exit ${exitCode}); stderr ${JSON.stringify(errText)}`);
  }
  const taken = { audit: 0, brief: 0 };
  return {
    port: Number(url[1]),
    code: url[2],
    async append(kind) {
      const index = taken[kind];
      taken[kind] += 1;
      child.stdin.write(`${kind}\n`);
      await until(() => lines[kind].length > index || exitCode !== undefined, `the fixture ${kind} line`, STEP_MS);
      const entry = lines[kind][index];
      if (entry === undefined) throw new Error(`measure-layers: the fixture Console exited ${exitCode} during an append`);
      const found = new RegExp(`^fixture-console: ${kind} (\\d+)$`).exec(entry.line);
      if (found === null || Number(found[1]) !== index + 1) throw new Error(`measure-layers: wanted ${kind} ${index + 1}, the fixture said ${JSON.stringify(entry.line)}`);
      return { at: entry.at, n: index + 1 };
    },
    stop,
  };
}

/** DEC-012: the channel kinds the core lists (`events --kinds --json`), read in a scratch HOME. */
function coreKinds(core: string, home: string): string[] {
  fs.mkdirSync(home, { recursive: true });
  const run = spawnSync(process.execPath, [core, 'events', '--kinds', '--json'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'), DOFLOW_UPKEEP: 'off', DOFLOW_TELEMETRY: 'off' },
    encoding: 'utf8', timeout: 30_000,
  });
  let body: any = null;
  try { body = JSON.parse(run.stdout); } catch { body = null; }
  if (run.status !== 0 || !body || !Array.isArray(body.kinds)) throw new Error(`measure-layers: events --kinds --json exited ${run.status}: ${run.stdout}${run.stderr}`);
  const missing = REQUIRED_KINDS.filter((kind) => !body.kinds.includes(kind));
  if (missing.length > 0) throw new Error(`measure-layers: the core does not list the channel kind(s) ${missing.join(', ')} (events --kinds: ${body.kinds.join(', ')})`);
  return body.kinds;
}

// ---- the measurement -------------------------------------------------------------------------------------------------------------

type Options = { core: string, samples: number, scratch: string, log?: (line: string) => void };

/**
 * Runs the fixture Console in `scratch` (which the caller owns and removes) and measures `samples` audit appends and `samples`
 * brief appends. Resolves with the samples and their verdict; throws when an append is not seen or the page never goes live.
 */
async function measure(options: Options) {
  const { core, samples, scratch } = options;
  const log = options.log ?? (() => {});
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) throw new Error(`measure-layers: samples must be 1 to ${MAX_SAMPLES}`);
  const kinds = coreKinds(core, path.join(scratch, 'home'));
  const web = path.join(scratch, 'web');
  fs.cpSync(WEB_ROOT, web, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"type":"module"}\n');
  const load = (name: string) => import(pathToFileURL(path.join(web, name)).href);
  const [views, storeMod, live, logStore, derive] = await Promise.all([load('views.js'), load('store.js'), load('live.js'), load('log-store.js'), load('derive/layers.js')]);

  let fixture: Fixture | null = null;
  let adapter: any = null;
  let connector: any = null;
  let local: any = null;
  let stream: any = null;
  let fixtureExit: number | null = null;
  let result: any = null;
  try {
    fixture = await startFixture(core, path.join(scratch, 'fixture'), log);
    const origin: Origin = { port: fixture.port, cookie: await exchange(fixture.port, fixture.code) };
    const wire = { status: null as number | null };
    adapter = live.createLiveAdapter({ EventSource: nodeEventSource(origin, wire), probe: async () => ({ status: wire.status ?? 0, code: null }) });
    const store = storeMod.createLiveStore({ adapter, visibility: { hidden: () => false, subscribe: () => () => {} } });

    // The page's own first step: the machine channel lists the projects; the one marked current is the Console's.
    let projectKey: string | null = null;
    const offMachine = store.subscribe('machine', (event: any) => {
      if (event.kind !== 'state' || !event.state || !event.state.machine || event.state.machine.status !== 200) return;
      const projects = derive.sectionOf(event.state.machine.body, 'projects');
      const current = projects.state === 'ok' ? projects.data.projects.find((p: any) => p.current === true) : null;
      if (current) projectKey = current.projectKey;
    });
    await until(() => projectKey !== null, 'the machine channel listing the current project', LIVE_MS);
    offMachine();
    const pk = projectKey as unknown as string;

    // The Layers project view's connector: `layers:<pk>` and `machine`, folded into the data the view paints.
    const auditKey = (n: number) => sha16(`claude:${LAYERS.session}:m-${n}`);
    const auditSeen = new Map<string, number>();
    let layersData: any = null;
    let following = false;
    const failures: any[] = [];
    const params = { project: pk };
    local = {};
    connector = views.VIEWS['layers-project'].connect(local, params, {
      store: () => store,
      onData: (data: any) => {
        const at = performance.now();
        following = data.stream.token === 'following';
        if (data.stream.token !== 'following' && data.stream.token !== 'connecting') failures.push(data.stream);
        layersData = data.layers;
        const sessions = derive.sectionOf(data.layers, 'sessions');
        if (sessions.state !== 'ok') return;
        for (const row of sessions.data) {
          if (!row.audit || row.audit.observed !== true) continue;
          for (const line of row.audit.recent) if (typeof line.agentKey === 'string' && !auditSeen.has(line.agentKey)) auditSeen.set(line.agentKey, at);
        }
      },
    });
    connector.start();
    const briefItem = () => {
      const artifacts = derive.sectionOf(layersData, 'artifacts');
      return artifacts.state === 'ok' ? artifacts.data.find((a: any) => a.kind === 'task-brief') ?? null : null;
    };
    await until(() => following && auditSeen.has(auditKey(0)) && briefItem() !== null, `the Layers view live on ${pk} with the audit line m-0 and the task brief listed`, LIVE_MS);

    // The file lane the file pane follows, on the brief the index lists.
    const brief = briefItem();
    const briefSeen = new Map<number, number>();
    let briefText = false;
    stream = logStore.createLogStream({ store, file: { projectKey: pk, fileKey: brief.fileKey } });
    stream.onChange((state: any) => {
      const at = performance.now();
      for (const piece of state.pieces) {
        if (piece.text.includes('Task 1 brief')) briefText = true;
        for (const found of String(piece.text).matchAll(/brief chunk (\d+)/g)) if (!briefSeen.has(Number(found[1]))) briefSeen.set(Number(found[1]), at);
      }
    });
    stream.open();
    await until(() => briefText, "the brief's first text on its file lane", LIVE_MS);
    log(`measure-layers: the Layers view is live on ${pk}; kinds ${kinds.join(', ')}; the brief is on its file lane`);
    await realDelay(SETTLE_MS);

    const out: { audit: number[], brief: number[] } = { audit: [], brief: [] };
    let early = 0;
    for (let step = 0; step < samples; step += 1) {
      const a = await fixture.append('audit');
      await until(() => auditSeen.has(auditKey(a.n)), `the page showing audit line ${a.n}`, STEP_MS);
      const aMs = auditSeen.get(auditKey(a.n))! - a.at;
      if (aMs < 0) early += 1;
      out.audit.push(round(aMs));
      log(`measure-layers: audit ${a.n}: ${round(aMs)} ms`);
      await realDelay(GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS));

      const b = await fixture.append('brief');
      await until(() => briefSeen.has(b.n), `the file lane showing brief chunk ${b.n}`, STEP_MS);
      const bMs = briefSeen.get(b.n)! - b.at;
      if (bMs < 0) early += 1;
      out.brief.push(round(bMs));
      log(`measure-layers: brief ${b.n}: ${round(bMs)} ms`);
      await realDelay(GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS));
    }
    result = { ...verdict(out), samples: out, early, viewFailures: failures.length, coreKinds: kinds };
  } finally {
    if (stream !== null) stream.close();
    if (connector !== null) connector.stop();
    if (local !== null) views.VIEWS['layers-project'].teardown(local);
    if (adapter !== null) adapter.close();
    if (fixture !== null) fixtureExit = await fixture.stop();
  }
  if (fixtureExit !== 0) throw new Error(`measure-layers: the fixture Console exited ${fixtureExit} on SIGTERM, not 0`);
  return { ...result, fixtureExit };
}

/** The JSON the script prints for a finished measurement. */
function report(result: any) {
  const kind = (name: 'audit' | 'brief') => ({ samples: result.samples[name], min: result[name].min, p50: result[name].p50, p95: result[name].p95, max: result[name].max, ok: result[name].ok });
  return {
    measure: MEASURE,
    from: "reading the fixture's `audit <n>` / `brief <n>` stderr line here (printed after the append returned)",
    to: "audit: the first Layers-connector data whose `sessions` section lists the line's agent key; brief: the first file-lane log-stream change holding the chunk's text",
    percentileMethod: 'nearest rank',
    bar: { p50Ms: P50_BAR_MS, maxMs: MAX_BAR_MS },
    audit: kind('audit'),
    brief: kind('brief'),
    ok: result.ok,
    worstCaseNote: WORST_CASE_NOTE,
    coreKinds: result.coreKinds,
    early: result.early,
    viewFailures: result.viewFailures,
    fixtureExit: result.fixtureExit,
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
    process.stderr.write(`measure-layers: ${flags.error}\n${USAGE}\n`);
    return 2;
  }
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-measure-layers-')));
  try {
    const result = await measure({ ...flags, scratch, log: (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(`${JSON.stringify(report(result))}\n`);
    return result.exit;
  } catch (error: any) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    return 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { P50_BAR_MS, MAX_BAR_MS, DEFAULT_SAMPLES, WORST_CASE_NOTE, MEASURE, summarize, verdict, measure, report, parseFlags };

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
