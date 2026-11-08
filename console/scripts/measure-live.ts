'use strict';

// Event-to-pixel latency of the live Run view (feature 149, E.2; NFR-001, DEC-015, DEC-049, IC-016, IC-018). Dev only:
// console/scripts/ is not in the package's `files`.
//
//   node console/scripts/measure-live.ts [--core <abs path to bin/doflow.js>] [--ticks <20..24>]
//
// It starts the fixture Console (fixture-console.ts) as a child with `--tick` set far beyond the run, so every step comes
// from a `tick` line written to its stdin. The page side runs in this process: the web root is copied into a scratch
// folder as an ES module tree (as console/test/live-recovery.test.ts loads it), and the Run view of `run-tick` is opened
// through views.js VIEWS.run.connect over the page's store (store.js) and the transport adapter (live.js), whose
// EventSource is an SSE reader on node:http. Every view update is rendered with the view's own renderer into a small Node
// element shim, as the shell paints a changed body.
//
// A sample runs from the return of the fixture's tick() (it prints its step line on stderr right after the synchronous core
// call returns; the sample starts when that line is read here) to the end of the first render whose body carries the
// run revision the step wrote (read from the run's journal once the line is in). The three state steps of `--tick` run
// first and are reported apart (`warmup`); the samples are the annotate ticks, each one timeline entry, and the render must
// show one event more than the one before. This is a render into a Node element shim, not a browser layout or paint
// (DEC-049); the JSON says so in `measure`.
//
// Output: one JSON object on stdout. Exit 0 when p95 < 500 ms, 1 when p95 >= 500 ms or the measurement failed, 2 on a
// usage error.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixture-console.ts');
const WEB_ROOT = path.join(__dirname, '..', 'web');
const DEFAULT_CORE = path.join(REPO, 'bin', 'doflow.js');
const USAGE = 'usage: measure-live.ts [--core <absolute path to bin/doflow.js>] [--ticks <20..24>]';

/** NFR-001: p95 of event-to-pixel under this many milliseconds. */
const P95_BAR_MS = 500;
/** DEC-015 asks for at least 20 samples; the fixture has 24 annotate ticks (DEC-048). */
const MIN_TICKS = 20;
const MAX_TICKS = 24;
/** The fixture's state steps before its annotate ticks: design, planning, gate-a. */
const STATE_STEPS = 3;
/** The fixture's tick interval: far longer than a run, so its timer never takes a step. */
const NO_TIMER_S = 86_400;
const BOOT_MS = 60_000;
const LIVE_MS = 30_000;
/** A step not rendered within this is a failed measurement; the slowest rescan of IC-006 is 30 s. */
const STEP_MS = 40_000;
/** Pause after a render before the next tick. */
const GAP_MS = 200;
const STOP_MS = 10_000;
const RUN = Object.freeze({ slug: 'feat-tick', taskId: 'run-tick' });

const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (ms: number) => Math.round(ms * 10) / 10;

/** Waits in real time until `check` holds; throws with `label` after `ms`. */
async function until(check: () => boolean, label: string, ms: number) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error(`measure-live: timed out after ${ms} ms: ${label}`);
    await realDelay(5);
  }
}

/** Nearest-rank percentile: the smallest sample with at least `p` of the samples at or below it. */
function percentile(samples: number[], p: number): number {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('percentile: no samples');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1];
}

/** NFR-001's p95, by nearest rank. */
const p95 = (samples: number[]) => percentile(samples, 0.95);

/** The median: the middle sample, or the mean of the two middle ones. */
function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---- the Node element shim ----------------------------------------------------------------------------------------
// The surface the Run view's renderers touch (dom.js, views/run.js, views/rail.js, views/replay.js, states.js): elements
// with attributes, dataset, classList, custom properties on `style`, listeners and a tree; text nodes. No layout: every
// size reads as undefined, so the code paths that need one skip themselves as they do without a layout.

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class ShimText {
  parent: any = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
  set textContent(value: string) { this.data = String(value); }
  remove() { if (this.parent) this.parent.detach(this); }
}

class ShimElement {
  parent: any = null;
  nodes: any[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Function[]>();
  style = { vars: new Map<string, string>(), setProperty(name: string, value: string) { this.vars.set(name, String(value)); } };
  tagName: string;
  dataset: any;
  classList: any;
  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_t, prop) => (typeof prop === 'string' ? self.attrs.get(`data-${kebab(prop)}`) : undefined),
      set: (_t, prop, value) => { self.attrs.set(`data-${kebab(String(prop))}`, String(value)); return true; },
      deleteProperty: (_t, prop) => { self.attrs.delete(`data-${kebab(String(prop))}`); return true; },
    });
    const tokens = () => (self.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
    const write = (list: string[]) => self.attrs.set('class', list.join(' '));
    this.classList = {
      add: (...names: string[]) => write([...new Set([...tokens(), ...names])]),
      remove: (...names: string[]) => write(tokens().filter((t) => !names.includes(t))),
      contains: (name: string) => tokens().includes(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !tokens().includes(name);
        write(on ? [...new Set([...tokens(), name])] : tokens().filter((t) => t !== name));
        return on;
      },
    };
  }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(value: string) { this.attrs.set('class', String(value)); }
  get id() { return this.attrs.get('id') ?? ''; }
  get children() { return this.nodes.filter((node) => node instanceof ShimElement); }
  get textContent(): string { return this.nodes.map((node) => node.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(...(value === '' ? [] : [String(value)])); }
  adopt(node: any) {
    const child = typeof node === 'string' ? new ShimText(node) : node;
    if (child.parent) child.parent.detach(child);
    child.parent = this;
    return child;
  }
  detach(node: any) {
    const at = this.nodes.indexOf(node);
    if (at >= 0) this.nodes.splice(at, 1);
    node.parent = null;
  }
  append(...nodes: any[]) { for (const node of nodes) this.nodes.push(this.adopt(node)); }
  prepend(...nodes: any[]) { this.nodes.unshift(...nodes.map((node) => this.adopt(node))); }
  replaceChildren(...nodes: any[]) {
    for (const node of this.nodes) node.parent = null;
    this.nodes = [];
    this.append(...nodes);
  }
  insertBefore(node: any, ref: any) {
    const child = this.adopt(node);
    const at = ref === null || ref === undefined ? -1 : this.nodes.indexOf(ref);
    if (at === -1) this.nodes.push(child);
    else this.nodes.splice(at, 0, child);
    return child;
  }
  remove() { if (this.parent) this.parent.detach(this); }
  contains(node: any): boolean { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Function) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  focus() {}
  /** A tag, a `.class`, or `tag.class`: the selectors the Run view's renderers query. */
  matches(selector: string) {
    const [tag, ...classes] = selector.split('.');
    return (tag === '' || this.tagName === tag.toUpperCase()) && classes.every((name) => this.classList.contains(name));
  }
  querySelectorAll(selector: string): ShimElement[] {
    const out: ShimElement[] = [];
    const walk = (node: ShimElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

/** The page's `document` as the Run view uses it: element factories, the announcer region, and visibility. */
function shimDocument() {
  const announcer = new ShimElement('div');
  announcer.setAttribute('id', 'announcer');
  return {
    hidden: false,
    title: '',
    activeElement: null,
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimText(String(text)),
    getElementById: (id: string) => (id === 'announcer' ? announcer : null),
    addEventListener() {},
    removeEventListener() {},
  };
}

// ---- the page's transport over node:http --------------------------------------------------------------------------

type Origin = { port: number, cookie: string };
type Wire = { status: number | null, frameAt: number | null };

/**
 * An EventSource constructor for live.js over node:http on the Console's origin. Unnamed messages reach `message` with
 * their data, a named event (the keepalive) its own listeners; `open` on a 200 head. It does not reconnect: on the end of
 * the stream or a refused head it is CLOSED and fires `error`, and the adapter's probe (below) reports the status this
 * reader saw. `wire.frameAt` is the arrival time of the message being dispatched, so a render the message causes can be
 * told from one a GET causes.
 */
function nodeEventSource(origin: Origin, wire: Wire) {
  return class NodeEventSource {
    readyState = 0;
    url: string;
    listeners = new Map<string, Function[]>();
    req: any;
    constructor(url: string) {
      this.url = url;
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
            this.dispatch(block, performance.now());
          }
        });
        res.on('error', () => {});
        res.on('close', () => this.fail());
      });
      this.req.on('error', () => this.fail());
      this.req.end();
    }
    dispatch(block: string, at: number) {
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
      // A named event (the live keepalive) goes to its own listeners, as a browser's EventSource sends it; it is no frame.
      if (name !== 'message') {
        this.emit(name, { type: name, data: data.join('\n') });
        return;
      }
      wire.frameAt = at;
      try {
        this.emit('message', { type: 'message', data: data.join('\n') });
      } finally {
        wire.frameAt = null;
      }
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

/** One request to the Console; the reply's status and body text. */
function request(origin: Origin, method: string, target: string, headers: Record<string, string> = {}, body: string | null = null): Promise<{ status: number, headers: any, text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: origin.port, method, path: target, agent: false, headers: { ...(origin.cookie ? { Cookie: origin.cookie } : {}), ...headers } }, (res: any) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

/** The launch-code exchange the shell makes first (POST /api/session); the session cookie. */
async function exchange(port: number, code: string): Promise<string> {
  const reply = await request({ port, cookie: '' }, 'POST', '/api/session', { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, JSON.stringify({ code }));
  const set = reply.headers['set-cookie'];
  const line = Array.isArray(set) ? set[0] : set;
  if (reply.status !== 204 || typeof line !== 'string') throw new Error(`measure-live: the session exchange answered ${reply.status}`);
  return line.split(';')[0];
}

/** The view's GET, rejected as the shell's apiGet rejects: `{ status, code, network }`. */
async function getJson(origin: Origin, target: string) {
  let reply;
  try {
    reply = await request(origin, 'GET', target, { Accept: 'application/json' });
  } catch {
    throw { status: null, code: null, network: true };
  }
  let body: any = null;
  try {
    body = JSON.parse(reply.text);
  } catch {
    body = null;
  }
  if (reply.status !== 200) throw { status: reply.status, code: body && body.error ? body.error.code ?? null : null, network: false };
  return body;
}

// ---- the fixture Console -----------------------------------------------------------------------------------------

type Fixture = { port: number, code: string, project: string, tick(): Promise<{ at: number, line: string }>, stop(): Promise<void> };

/** Starts fixture-console.ts with its scratch under `scratchRoot`; resolves once its URL and project lines are out. */
async function startFixture(core: string, scratchRoot: string, log: (line: string) => void): Promise<Fixture> {
  const child = spawn(process.execPath, [FIXTURE, '--core', core, '--tick', String(NO_TIMER_S)], {
    env: { ...process.env, DOFLOW_FIXTURE_SCRATCH_ROOT: scratchRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) => child.on('exit', (code: number | null) => { exitCode = code; resolve(); }));
  let out = '';
  let errText = '';
  let pending = '';
  let project: string | null = null;
  const tickLines: Array<{ at: number, line: string }> = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { out += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const at = performance.now();
    errText = (errText + chunk).slice(-8192);
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const where = /^fixture-console: scratch directory .+; project (.+)$/.exec(line);
      if (where) project = where[1];
      // The line tick() prints right after the step's core call returned, or the line of a failed or exhausted step.
      if (/^fixture-console: (run-tick: |tick failed|no step left)/.test(line)) tickLines.push({ at, line });
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
  };
  try {
    await until(() => exitCode !== undefined || (project !== null && /^doflow ui: /m.test(out)), 'the fixture Console boot', BOOT_MS);
  } catch (error) {
    await stop();
    throw error;
  }
  const url = /^doflow ui: http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]{64})$/m.exec(out);
  if (exitCode !== undefined || url === null || project === null) {
    await stop();
    throw new Error(`measure-live: the fixture Console did not boot (exit ${exitCode}); stderr ${JSON.stringify(errText)}`);
  }
  let taken = 0;
  return {
    port: Number(url[1]),
    code: url[2],
    project,
    async tick() {
      const index = taken;
      taken += 1;
      child.stdin.write('tick\n');
      await until(() => tickLines.length > index || exitCode !== undefined, 'the fixture tick line', STEP_MS);
      const entry = tickLines[index];
      if (entry === undefined) throw new Error(`measure-live: the fixture Console exited ${exitCode} during a tick`);
      if (!/^fixture-console: run-tick: /.test(entry.line)) throw new Error(`measure-live: ${entry.line}`);
      return entry;
    },
    stop,
  };
}

/** The revision in the run's journal (`orchestrate` writes it with every step). */
function journalRevision(project: string): number {
  const file = path.join(project, '.doflow', 'state', 'orchestration', RUN.slug, `${RUN.taskId}.json`);
  return Number(JSON.parse(fs.readFileSync(file, 'utf8')).revision);
}

// ---- the measurement ---------------------------------------------------------------------------------------------

type Render = { at: number, revision: number, events: number | null, frameAt: number | null };
type Options = { core: string, ticks: number, scratch: string, log?: (line: string) => void };

/** The event count the rendered timeline head shows (`... · N events`), or null without one. */
function shownEvents(root: ShimElement): number | null {
  const meta = root.querySelector('.timeline__meta');
  const found = meta === null ? null : /(\d+) events?$/.exec(meta.textContent);
  return found === null ? null : Number(found[1]);
}

/**
 * Runs the fixture Console in `scratch` (which the caller owns and removes) and measures `ticks` annotate ticks.
 * Resolves with the samples and their summary; throws when a step is not rendered or the view never goes live.
 */
async function measure(options: Options) {
  const { core, ticks, scratch } = options;
  const log = options.log ?? (() => {});
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > MAX_TICKS) throw new Error(`measure-live: ticks must be 1 to ${MAX_TICKS}`);
  const web = path.join(scratch, 'web');
  fs.cpSync(WEB_ROOT, web, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"type":"module"}\n');
  const load = (name: string) => import(pathToFileURL(path.join(web, name)).href);
  const [views, storeMod, live, dom] = await Promise.all([load('views.js'), load('store.js'), load('live.js'), load('dom.js')]);

  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: shimDocument(), configurable: true, writable: true });
  let fixture: Fixture | null = null;
  let poller: any = null;
  let adapter: any = null;
  try {
    fixture = await startFixture(core, path.join(scratch, 'fixture'), log);
    const origin: Origin = { port: fixture.port, cookie: await exchange(fixture.port, fixture.code) };
    const wire: Wire = { status: null, frameAt: null };
    adapter = live.createLiveAdapter({
      EventSource: nodeEventSource(origin, wire),
      probe: async () => ({ status: wire.status ?? 0, code: null }),
    });
    const store = storeMod.createLiveStore({ adapter, visibility: { hidden: () => false, subscribe: () => () => {} } });

    // The view as the shell runs it (app.js startPoller and onData): a changed body is painted at once.
    const params = { slug: RUN.slug, taskId: RUN.taskId };
    const route = { id: 'run', params, view: views.VIEWS.run };
    const local = { inspector: null, route, link: null };
    const main = new ShimElement('main');
    const renders: Render[] = [];
    const failures: any[] = [];
    let dataText: string | null = null;
    poller = views.VIEWS.run.connect(local, params, {
      fetchJson: (target: string) => getJson(origin, target),
      onData: (body: any) => {
        const text = JSON.stringify(body);
        if (text === dataText) return;
        dataText = text;
        const frameAt = wire.frameAt;
        dom.mount(main, views.VIEWS.run.render(body, params, local));
        renders.push({ at: performance.now(), revision: Number(body.run.revision), events: shownEvents(main), frameAt });
      },
      onFailure: (error: any) => { failures.push(error); },
      store: () => store,
      fetchOnce: () => getJson(origin, views.VIEWS.run.api(params)),
    });
    poller.start();
    await until(() => poller.mode === 'live' && renders.length > 0, 'the Run view live with a first render', LIVE_MS);
    log(`measure-live: the Run view is live (revision ${renders.at(-1)!.revision}, ${renders.at(-1)!.events} events)`);

    const warmup: number[] = [];
    const samples: number[] = [];
    const clientMs: number[] = [];
    for (let step = 0; step < STATE_STEPS + ticks; step += 1) {
      const from = renders.length;
      const before = renders.at(-1)!;
      const { at, line } = await fixture.tick();
      const target = journalRevision(fixture.project);
      const label = line.replace(/^fixture-console: /, '');
      const shown = () => renders.slice(from).find((entry) => entry.revision >= target);
      await until(() => shown() !== undefined, `a render of revision ${target} (${label})`, STEP_MS);
      const render = shown()!;
      if (poller.mode !== 'live' || render.frameAt === null) throw new Error(`measure-live: ${label} was rendered from the view's GET (mode ${poller.mode}), not from a live frame`);
      const ms = render.at - at;
      if (step < STATE_STEPS) warmup.push(round(ms));
      else {
        if (before.events === null || render.events !== before.events + 1) throw new Error(`measure-live: ${label} rendered ${render.events} events after ${before.events}`);
        samples.push(round(ms));
        clientMs.push(round(render.at - render.frameAt));
      }
      log(`measure-live: ${label}: ${round(ms)} ms`);
      await realDelay(GAP_MS);
    }
    if (failures.length > 0) log(`measure-live: the view reported ${failures.length} failure(s): ${JSON.stringify(failures)}`);
    return {
      measure: 'node-dom-shim',
      from: 'return of the fixture tick(): its stderr line read here',
      to: 'end of the Run view render (views.js VIEWS.run.render into a Node element shim) showing the step; no browser layout or paint',
      samples,
      p95: p95(samples),
      min: Math.min(...samples),
      median: round(median(samples)),
      max: Math.max(...samples),
      clientMs,
      warmup,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    };
  } finally {
    if (poller !== null) poller.stop();
    if (adapter !== null) adapter.close();
    if (fixture !== null) await fixture.stop();
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete (globalThis as any).document;
  }
}

function parseFlags(argv: readonly string[]): { core: string, ticks: number } | { error: string } {
  const flags = { core: DEFAULT_CORE, ticks: MAX_TICKS };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name !== '--core' && name !== '--ticks') return { error: `unknown argument ${JSON.stringify(name)}` };
    if (value === undefined) return { error: `${name} needs a value` };
    index += 1;
    if (name === '--core') flags.core = value;
    else if (/^\d+$/.test(value) && Number(value) >= MIN_TICKS && Number(value) <= MAX_TICKS) flags.ticks = Number(value);
    else return { error: `--ticks needs a whole number from ${MIN_TICKS} to ${MAX_TICKS}` };
  }
  if (!path.isAbsolute(flags.core)) return { error: '--core must be an absolute path' };
  if (!fs.existsSync(flags.core)) return { error: `--core does not exist: ${flags.core}` };
  return flags;
}

async function main(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv);
  if ('error' in flags) {
    process.stderr.write(`measure-live: ${flags.error}\n${USAGE}\n`);
    return 2;
  }
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-measure-live-')));
  try {
    const result = await measure({ ...flags, scratch, log: (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(`${JSON.stringify({ ...result, bar: P95_BAR_MS, ok: result.p95 < P95_BAR_MS })}\n`);
    return result.p95 < P95_BAR_MS ? 0 : 1;
  } catch (error: any) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    return 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { P95_BAR_MS, MIN_TICKS, MAX_TICKS, percentile, p95, median, measure, parseFlags };

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
