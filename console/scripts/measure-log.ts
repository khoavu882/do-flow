'use strict';

// Append-to-render lag of a worker run's Log tab (feature 150, D.2; NFR-001, IC-021). Dev only: console/scripts/ is not in
// the package's `files`. It follows measure-live.ts (feature 149, E.2).
//
//   node console/scripts/measure-log.ts [--core <abs path to bin/doflow.js>] [--appends <20..24>]
//
// It starts the fixture Console (fixture-console.ts) as a child with `--worker-log` set far beyond the run, so every append
// comes from a `log` line written to its stdin: the fixture appends one line to each of R1's out and err files and prints
// `fixture-console: log <n>` on stderr after both writes returned. The page side runs in this process: the web root is copied
// into a scratch folder as an ES module tree, and the Session view of `run-chain` is opened with the route selection of
// IC-015, `{ node: { kind: 'worker', runId: R1 }, tab: 'log' }`, through views.js VIEWS.session.connect over the page's
// store (store.js) and the transport adapter (live.js), whose EventSource is an SSE reader on node:http. The view's panel is
// shown in the shell's own inspector (shell.js createInspector, docked), so the Log tab (worker-tabs.js) and its two log
// streams (log-store.js) run as on the page. Every view update is rendered with the view's own renderer into a small Node
// element shim, as the shell paints a changed body; the Log tab draws its text into the shim itself.
//
// A sample runs from reading the fixture's `log <n>` line here (the time its stderr chunk arrived) to the end of the first
// render whose stdout region (`section[aria-label="stdout"]` and its `pre`) holds the line `R1 out line <n>`. "End of the
// render" is the first microtask after the shim was changed: the synchronous work that changed it (a frame's dispatch through
// the adapter, the store, the log stream's merge and the pane's render) has finished by then. Every append is a sample,
// the first one included (it creates R1's files). This is a render into a Node element shim, not a browser layout or paint;
// the JSON says so in `measure`.
//
// Output: one JSON object on stdout. Exit 0 when p95 < 1000 ms, 1 when p95 >= 1000 ms or the measurement failed, 2 on a
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
const USAGE = 'usage: measure-log.ts [--core <absolute path to bin/doflow.js>] [--appends <20..24>]';

/** NFR-001: p95 of append-to-render under this many milliseconds. */
const P95_BAR_MS = 1000;
/** Requirement A8 asks for at least 20 samples; the fixture makes 24 appends before R1 ends (IC-021). */
const MIN_APPENDS = 20;
const MAX_APPENDS = 24;
/** The fixture's append interval: far longer than a run, so its timer never appends (its own bound is 2_147_483 s). */
const NO_TIMER_S = 86_400;
const BOOT_MS = 60_000;
const LIVE_MS = 30_000;
/** An append not rendered within this is a failed measurement. */
const STEP_MS = 40_000;
/** Pause after a render before the next append. */
const GAP_MS = 200;
const STOP_MS = 10_000;
const RUN = Object.freeze({ slug: 'feat-chain', taskId: 'run-chain' });
const MEASURE = 'render in a Node element shim, not a browser paint';

const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (ms: number) => Math.round(ms * 10) / 10;

/** Waits in real time until `check` holds; throws with `label` after `ms`. */
async function until(check: () => boolean, label: string, ms: number) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error(`measure-log: timed out after ${ms} ms: ${label}`);
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
// measure-live.ts's shim (it does not export it), with one addition: every change of the tree or of an attribute calls
// `changed()`, so the measurement can look at the stdout region at the end of the render that changed it. No layout: every
// size reads as undefined, so the code paths that need one skip themselves as they do without a layout.

let onChange: (() => void) | null = null;
const changed = () => { if (onChange !== null) onChange(); };

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class ShimText {
  parent: any = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
  set textContent(value: string) { this.data = String(value); changed(); }
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
      set: (_t, prop, value) => { self.setAttribute(`data-${kebab(String(prop))}`, String(value)); return true; },
      deleteProperty: (_t, prop) => { self.removeAttribute(`data-${kebab(String(prop))}`); return true; },
    });
    const tokens = () => (self.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
    const write = (list: string[]) => self.setAttribute('class', list.join(' '));
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
  set className(value: string) { this.setAttribute('class', String(value)); }
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
    changed();
  }
  append(...nodes: any[]) { for (const node of nodes) this.nodes.push(this.adopt(node)); changed(); }
  prepend(...nodes: any[]) { this.nodes.unshift(...nodes.map((node) => this.adopt(node))); changed(); }
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
    changed();
    return child;
  }
  remove() { if (this.parent) this.parent.detach(this); }
  contains(node: any): boolean { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); changed(); }
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) { this.attrs.delete(name); changed(); }
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Function) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  focus() {}
  /** A tag, a `.class`, or `tag.class`: the selectors the renderers and the inspector query. */
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

/** The page's `document` as the Session view and the inspector use it: element factories, the announcer region, body. */
function shimDocument() {
  const announcer = new ShimElement('div');
  announcer.setAttribute('id', 'announcer');
  return {
    hidden: false,
    title: '',
    activeElement: null,
    body: new ShimElement('body'),
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimText(String(text)),
    getElementById: (id: string) => (id === 'announcer' ? announcer : null),
    addEventListener() {},
    removeEventListener() {},
  };
}

/** The first element under `root` (itself included) for which `test` holds, depth first. */
function findElement(root: ShimElement, test: (el: ShimElement) => boolean): ShimElement | null {
  if (test(root)) return root;
  for (const child of root.children) {
    const found = findElement(child, test);
    if (found !== null) return found;
  }
  return null;
}

/** The stdout region of the Log tab under `root`, or null. */
const stdoutRegion = (root: ShimElement) => findElement(root, (el) => el.tagName === 'SECTION' && el.getAttribute('aria-label') === 'stdout');

/** The appended line numbers the stdout region's `pre` shows (`R1 out line <n>`), empty while it is hidden or absent. */
function shownLines(region: ShimElement | null): number[] {
  const pre = region === null ? null : region.children.find((child) => child.tagName === 'PRE') ?? null;
  if (pre === null || pre.hasAttribute('hidden')) return [];
  const out: number[] = [];
  for (const line of pre.textContent.split('\n')) {
    const found = /^R1 out line (\d+)(?: |$)/.exec(line);
    if (found) out.push(Number(found[1]));
  }
  return out;
}

// ---- the page's transport over node:http --------------------------------------------------------------------------

type Origin = { port: number, cookie: string };
type Source = { readyState: number, channels: string[], seen: Set<string> };
type Wire = { status: number | null, frameAt: number | null, current: Source | null };

/**
 * An EventSource constructor for live.js over node:http on the Console's origin (measure-live.ts's reader). Unnamed messages
 * reach `message` with their data, a named event (the keepalive) its own listeners; `open` on a 200 head. It does not
 * reconnect: on the end of the stream or a refused head it is CLOSED and fires `error`, and the adapter's probe reports the
 * status this reader saw. `wire.frameAt` is the arrival time of the message being dispatched, so a render the message causes
 * can be told from one a GET causes; `wire.current` is the newest reader, with the channels of its URL and the channels a
 * frame has arrived on.
 */
function nodeEventSource(origin: Origin, wire: Wire) {
  return class NodeEventSource {
    readyState = 0;
    url: string;
    channels: string[];
    seen = new Set<string>();
    listeners = new Map<string, Function[]>();
    req: any;
    constructor(url: string) {
      this.url = url;
      const ch = new URL(url, 'http://127.0.0.1').searchParams.get('ch');
      this.channels = ch === null ? [] : ch.split(',');
      wire.current = this;
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
      if (name !== 'message') {
        this.emit(name, { type: name, data: data.join('\n') });
        return;
      }
      const text = data.join('\n');
      try {
        const envelope = JSON.parse(text);
        if (envelope && typeof envelope.ch === 'string') this.seen.add(envelope.ch);
      } catch {
        // not an envelope: the adapter drops it
      }
      wire.frameAt = at;
      try {
        this.emit('message', { type: 'message', data: text });
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
  if (reply.status !== 204 || typeof line !== 'string') throw new Error(`measure-log: the session exchange answered ${reply.status}`);
  return line.split(';')[0];
}

/** The page's GET, rejected as the shell's apiGet rejects: `{ status, code, network }`. */
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

type Fixture = { port: number, code: string, runId: string, append(): Promise<{ at: number, n: number }>, stop(): Promise<number | null> };

/** Starts fixture-console.ts with its scratch under `scratchRoot`; resolves once its URL, project and R1 lines are out. */
async function startFixture(core: string, scratchRoot: string, log: (line: string) => void): Promise<Fixture> {
  const child = spawn(process.execPath, [FIXTURE, '--core', core, '--worker-log', String(NO_TIMER_S)], {
    env: { ...process.env, DOFLOW_FIXTURE_SCRATCH_ROOT: scratchRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) => child.on('exit', (code: number | null) => { exitCode = code; resolve(); }));
  let out = '';
  let errText = '';
  let pending = '';
  let project: string | null = null;
  let runId: string | null = null;
  const logLines: Array<{ at: number, line: string }> = [];
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
      const r1 = new RegExp(`^fixture-console: ${RUN.taskId}: R1 (w-[0-9a-f]{12})$`).exec(line);
      if (r1) runId = r1[1];
      // The line logOnce() prints after both appends returned, or the line of a failed or exhausted append.
      if (/^fixture-console: (log \d+$|log failed|no log line left)/.test(line)) logLines.push({ at, line });
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
    await until(() => exitCode !== undefined || (project !== null && runId !== null && /^doflow ui: /m.test(out)), 'the fixture Console boot', BOOT_MS);
  } catch (error) {
    await stop();
    throw error;
  }
  const url = /^doflow ui: http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]{64})$/m.exec(out);
  if (exitCode !== undefined || url === null || project === null || runId === null) {
    await stop();
    throw new Error(`measure-log: the fixture Console did not boot (exit ${exitCode}); stderr ${JSON.stringify(errText)}`);
  }
  let taken = 0;
  return {
    port: Number(url[1]),
    code: url[2],
    runId,
    async append() {
      const index = taken;
      taken += 1;
      child.stdin.write('log\n');
      await until(() => logLines.length > index || exitCode !== undefined, 'the fixture log line', STEP_MS);
      const entry = logLines[index];
      if (entry === undefined) throw new Error(`measure-log: the fixture Console exited ${exitCode} during an append`);
      const found = /^fixture-console: log (\d+)$/.exec(entry.line);
      if (found === null || Number(found[1]) !== index + 1) throw new Error(`measure-log: wanted log ${index + 1}, the fixture said ${JSON.stringify(entry.line)}`);
      return { at: entry.at, n: index + 1 };
    },
    stop,
  };
}

// ---- the measurement ---------------------------------------------------------------------------------------------

type Shown = { at: number, frameAt: number | null };
type Options = { core: string, appends: number, scratch: string, log?: (line: string) => void };

/** The shell's inspector (shell.js createInspector) on shim elements, docked (no media query). */
function shimInspector(shell: any, doc: any, main: ShimElement) {
  const el = new ShimElement('aside');
  el.setAttribute('id', 'inspector');
  const title = new ShimElement('h2');
  title.className = 'inspector__title';
  title.setAttribute('id', 'inspector-title');
  const close = new ShimElement('button');
  close.className = 'inspector__close';
  const empty = new ShimElement('p');
  empty.className = 'inspector__empty';
  const body = new ShimElement('div');
  body.className = 'inspector__body';
  el.append(title, close, empty, body);
  const page = new ShimElement('div');
  page.setAttribute('id', 'shell');
  page.append(main, el);
  const inspector = shell.createInspector({ doc, shell: page, el, main });
  inspector.setInspectable(true);
  return { page, inspector };
}

/**
 * Runs the fixture Console in `scratch` (which the caller owns and removes) and measures `appends` appends to R1's logs.
 * Resolves with the samples and their summary; throws when an append is not rendered or the view never goes live.
 */
async function measure(options: Options) {
  const { core, appends, scratch } = options;
  const log = options.log ?? (() => {});
  if (!Number.isInteger(appends) || appends < 1 || appends > MAX_APPENDS) throw new Error(`measure-log: appends must be 1 to ${MAX_APPENDS}`);
  const web = path.join(scratch, 'web');
  fs.cpSync(WEB_ROOT, web, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"type":"module"}\n');
  const load = (name: string) => import(pathToFileURL(path.join(web, name)).href);
  const [views, storeMod, live, dom, shell] = await Promise.all([load('views.js'), load('store.js'), load('live.js'), load('dom.js'), load('shell.js')]);

  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = shimDocument();
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  let fixture: Fixture | null = null;
  let poller: any = null;
  let adapter: any = null;
  let local: any = null;
  let fixtureExit: number | null = null;
  let result: any = null;
  try {
    fixture = await startFixture(core, path.join(scratch, 'fixture'), log);
    const runId = fixture.runId;
    const outChannel = `worker:${runId}:out`;
    const origin: Origin = { port: fixture.port, cookie: await exchange(fixture.port, fixture.code) };
    const wire: Wire = { status: null, frameAt: null, current: null };
    adapter = live.createLiveAdapter({
      EventSource: nodeEventSource(origin, wire),
      probe: async () => ({ status: wire.status ?? 0, code: null }),
    });
    const store = storeMod.createLiveStore({ adapter, visibility: { hidden: () => false, subscribe: () => () => {} } });

    const main = new ShimElement('main');
    const { page, inspector } = shimInspector(shell, doc, main);

    // Every change of the shim is looked at once, at the end of the synchronous work that made it: the first time the
    // stdout region shows line n is that render's end.
    const shown = new Map<number, Shown>();
    let scheduled = false;
    let batchFrameAt: number | null = null;
    onChange = () => {
      if (wire.frameAt !== null) batchFrameAt = wire.frameAt;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        const at = performance.now();
        const frameAt = batchFrameAt;
        scheduled = false;
        batchFrameAt = null;
        for (const n of shownLines(stdoutRegion(page))) if (!shown.has(n)) shown.set(n, { at, frameAt });
      });
    };

    // The view as the shell runs it (app.js startPoller, onData and linkSelection): a changed body is painted at once.
    const params = { slug: RUN.slug, taskId: RUN.taskId };
    const base = { id: 'session', params, view: views.VIEWS.session };
    local = { inspector, route: { ...base, node: { kind: 'worker', runId }, tab: 'log' }, link: null };
    local.link = (patch: any) => { local.route = patch === null ? base : { ...base, ...patch }; return true; };
    let renders = 0;
    const failures: any[] = [];
    let dataText: string | null = null;
    poller = views.VIEWS.session.connect(local, params, {
      fetchJson: (target: string) => getJson(origin, target),
      onData: (body: any) => {
        const text = JSON.stringify(body);
        if (text === dataText) return;
        dataText = text;
        dom.mount(main, views.VIEWS.session.render(body, params, local));
        renders += 1;
      },
      onFailure: (error: any) => { failures.push(error); },
      store: () => store,
      fetchOnce: () => views.VIEWS.session.load(local, (target: string) => getJson(origin, target)),
    });
    poller.start();
    const ready = () => {
      const region = stdoutRegion(page);
      const source = wire.current;
      return poller.mode === 'live' && renders > 0 && region !== null && ['empty', 'ready'].includes(String(region.dataset.state))
        && source !== null && source.readyState === 1 && source.channels.includes(outChannel) && source.seen.has(outChannel);
    };
    await until(ready, `the Session view live with R1's Log tab open and ${outChannel} on the stream`, LIVE_MS);
    if (shown.size > 0) throw new Error(`measure-log: the stdout region shows lines before the first append: ${[...shown.keys()].join(', ')}`);
    log(`measure-log: the Session view is live on ${runId}, Log tab open (stdout ${stdoutRegion(page)!.dataset.state})`);
    await realDelay(GAP_MS);

    const samples: number[] = [];
    const clientMs: Array<number | null> = [];
    let early = 0;
    for (let step = 0; step < appends; step += 1) {
      const { at, n } = await fixture.append();
      await until(() => shown.has(n), `a render of stdout line ${n}`, STEP_MS);
      const render = shown.get(n)!;
      if (poller.mode !== 'live') throw new Error(`measure-log: log ${n} was rendered while the view was ${poller.mode}`);
      const ms = render.at - at;
      if (ms < 0) early += 1;
      samples.push(round(ms));
      clientMs.push(render.frameAt === null ? null : round(render.at - render.frameAt));
      log(`measure-log: log ${n}: ${round(ms)} ms`);
      await realDelay(GAP_MS);
    }
    if (failures.length > 0) log(`measure-log: the view reported ${failures.length} failure(s): ${JSON.stringify(failures)}`);
    result = {
      measure: MEASURE,
      from: "reading the fixture's `log <n>` stderr line here (it is printed after both appends returned)",
      to: 'end of the first render (the microtask after the shim changed) whose stdout region (section[aria-label="stdout"] pre) holds line n',
      p95Method: 'nearest rank',
      samples,
      p95: p95(samples),
      min: Math.min(...samples),
      median: round(median(samples)),
      max: Math.max(...samples),
      clientMs,
      early,
      viewFailures: failures.length,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    };
  } finally {
    onChange = null;
    if (local !== null) views.VIEWS.session.teardown(local);
    if (poller !== null) poller.stop();
    if (adapter !== null) adapter.close();
    if (fixture !== null) fixtureExit = await fixture.stop();
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete (globalThis as any).document;
  }
  if (fixtureExit !== 0) throw new Error(`measure-log: the fixture Console exited ${fixtureExit} on SIGTERM, not 0`);
  return { ...result, fixtureExit };
}

function parseFlags(argv: readonly string[]): { core: string, appends: number } | { error: string } {
  const flags = { core: DEFAULT_CORE, appends: MAX_APPENDS };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name !== '--core' && name !== '--appends') return { error: `unknown argument ${JSON.stringify(name)}` };
    if (value === undefined) return { error: `${name} needs a value` };
    index += 1;
    if (name === '--core') flags.core = value;
    else if (/^\d+$/.test(value) && Number(value) >= MIN_APPENDS && Number(value) <= MAX_APPENDS) flags.appends = Number(value);
    else return { error: `--appends needs a whole number from ${MIN_APPENDS} to ${MAX_APPENDS}` };
  }
  if (!path.isAbsolute(flags.core)) return { error: '--core must be an absolute path' };
  if (!fs.existsSync(flags.core)) return { error: `--core does not exist: ${flags.core}` };
  return flags;
}

async function main(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv);
  if ('error' in flags) {
    process.stderr.write(`measure-log: ${flags.error}\n${USAGE}\n`);
    return 2;
  }
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-measure-log-')));
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

module.exports = { P95_BAR_MS, MIN_APPENDS, MAX_APPENDS, MEASURE, percentile, p95, median, measure, parseFlags };

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
