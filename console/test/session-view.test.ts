'use strict';

// The Session screen (feature 150, IC-017; plan task C.4, D5). Like client-core.test.ts and worker-tabs.test.ts, the web
// root is copied beside a {"type":"module"} marker and views/session.js is imported from there (after views.js, the page's
// own import order). A small fake DOM (elements and text nodes; an innerHTML write throws) records what the code builds. The
// live store is a fake that records subscriptions and pushes channel frames, `apiGet` is a fake over scripted routes that
// records every path, the inspector is a fake that records what it shows, and the connector runs under mocked timers.

const { test, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { project } = require('../src/project.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
/** session.js without its comments: the scans below read code, not the header. */
const SOURCE = fs.readFileSync(path.join(WEB_ROOT, 'views', 'session.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
let copy: string;
let mod: any;
let states: any;
let savedDocument: PropertyDescriptor | undefined;

// ---- a fake DOM ---------------------------------------------------------------------------------

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class Txt {
  parent: any = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
}

type Compound = { tag: string | null, classes: string[], attrs: Array<[string, string | null]> };
function compound(selector: string): Compound {
  const out: Compound = { tag: null, classes: [], attrs: [] };
  const tag = /^[a-z0-9]+/i.exec(selector);
  if (tag) out.tag = tag[0].toLowerCase();
  for (const m of selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)) out.classes.push(m[1]);
  for (const m of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) out.attrs.push([m[1], m[2] ?? null]);
  return out;
}

const docListeners = new Map<string, Function[]>();
const doc: any = {
  activeElement: null,
  hidden: false,
  addEventListener(type: string, fn: Function) { docListeners.set(type, [...(docListeners.get(type) ?? []), fn]); },
  removeEventListener(type: string, fn: Function) { docListeners.set(type, (docListeners.get(type) ?? []).filter((f) => f !== fn)); },
};

class El {
  parent: any = null;
  children: any[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Function[]>();
  dataset: any;
  classList: any;
  style: any;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
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
      toggle: (name: string, on: boolean) => (on ? this.classList.add(name) : this.classList.remove(name)),
    };
    this.style = { setProperty: () => {} };
  }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(value: string) { this.attrs.set('class', value); }
  get id() { return this.attrs.get('id') ?? ''; }
  get textContent(): string { return this.children.map((c) => c.textContent).join(''); }
  set textContent(value: string) {
    for (const c of this.children) c.parent = null;
    this.children = value === '' ? [] : [this.adopt(new Txt(value))];
  }
  /** Markup strings never reach the page (149 NFR-004): any write is a failure. */
  set innerHTML(_value: string) { throw new Error('innerHTML written'); }
  adopt(node: any) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    return node;
  }
  append(...nodes: any[]) { for (const n of nodes) this.children.push(this.adopt(typeof n === 'string' ? new Txt(n) : n)); }
  prepend(node: any) { this.children.unshift(this.adopt(node)); }
  replaceChildren(...nodes: any[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  insertBefore(node: any, ref: any) {
    this.adopt(node);
    const at = ref === null || ref === undefined ? -1 : this.children.indexOf(ref);
    if (at === -1) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Function) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  /** Dispatches `type` from this element up through its ancestors, as a bubbling event. */
  fire(type: string, extra: any = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (let node: any = this; node; node = node.parent) for (const fn of node.listeners?.get(type) ?? []) fn(event);
    return event;
  }
  focus() { doc.activeElement = this; }
  contains(node: any) { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
  matches(c: Compound) {
    if (c.tag && this.tagName.toLowerCase() !== c.tag) return false;
    if (!c.classes.every((k) => this.classList.contains(k))) return false;
    return c.attrs.every(([name, value]) => (value === null ? this.attrs.has(name) : this.attrs.get(name) === value));
  }
  closest(selector: string) {
    const c = compound(selector);
    for (let node: any = this; node instanceof El; node = node.parent) if (node.matches(c)) return node;
    return null;
  }
  querySelectorAll(selector: string): El[] {
    const c = compound(selector);
    const out: El[] = [];
    const walk = (node: any) => {
      for (const child of node.children) {
        if (child instanceof El) {
          if (child.matches(c)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

Object.assign(doc, {
  createElement: (tag: string) => new El(tag),
  createElementNS: (_ns: string, tag: string) => new El(tag),
  createTextNode: (text: string) => new Txt(text),
  getElementById: () => null,
});

/** Every node under `node`, depth first. */
function nodesOf(node: any): any[] {
  return node.children.flatMap((c: any) => (c instanceof El ? [c, ...nodesOf(c)] : [c]));
}

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-session-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  await import(pathToFileURL(path.join(copy, 'views.js')).href);
  mod = await import(pathToFileURL(path.join(copy, 'views', 'session.js')).href);
  states = await import(pathToFileURL(path.join(copy, 'states.js')).href);
});
after(() => {
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
  else delete (globalThis as any).document;
  fs.rmSync(copy, { recursive: true, force: true });
});
afterEach(() => {
  mock.timers.reset();
  doc.hidden = false;
});

// ---- bodies -------------------------------------------------------------------------------------

const MIN = 60_000;
const T0 = Date.parse('2026-11-08T05:00:00.000Z');
const iso = (min: number) => new Date(T0 + min * MIN).toISOString();
const SLUG = 'feat-a';
const TASK_ID = 'run-1';
const PARAMS = { slug: SLUG, taskId: TASK_ID };

const WORKFLOW = {
  taskClass: 'feature', name: 'Feature Flow',
  stages: [
    { id: 'plan', kind: 'planning', optional: false, skill: 'do-plan', agent: 'planner', purpose: 'Plan it', gatesAfter: [{ id: 'gate-plan', kind: 'approval', trigger: 'always', name: 'n', prompt: 'Approve the plan?' }] },
    { id: 'build', kind: 'implementation', optional: false, skill: 'do-implement', agent: 'core-implementer', purpose: 'Build it', gatesAfter: [] },
  ],
};
const ROW = {
  taskId: TASK_ID, taskClass: 'feature', workflowName: 'Feature Flow', state: 'RUNNING', current: { type: 'stage', id: 'build', kind: 'implementation' },
  awaitingGate: null, progress: { done: 2, total: 3 }, revision: 4, journalGateDiffers: false,
  featureSlug: SLUG, startedAt: iso(0), updatedAt: iso(20), origin: 'current',
};
const ev = (min: number, action: string, node: string | null, over: any = {}) => ({ at: iso(min), action, node, outcome: null, decision: null, forced: false, synthetic: false, ...over });
const TIMELINE = {
  v: 1, taskId: TASK_ID, featureSlug: SLUG, revision: 4, startedAt: iso(0), otherEvents: 0,
  events: [ev(0, 'start', null), ev(5, 'complete-stage', 'plan', { outcome: 'passed' }), ev(8, 'decide-gate', 'gate-plan', { decision: 'approve' })],
};
const att = (token: number, state: string, startMin: number, endMin: number | null, result: string | null = null) => ({
  token, owner: 'core-implementer', mode: 'subagent', state, startedAt: iso(startMin), endedAt: endMin === null ? null : iso(endMin), result, worktreeKey: null, run: null, lineage: null,
});
const TASKS = {
  revision: 3,
  graph: { digest: 'd', graphPlan: true, tasks: [{ id: 'A.1', phase: 'A', owner: 'core-implementer', taskDeps: [], parallel: false }, { id: 'A.2', phase: 'A', owner: 'core-implementer', taskDeps: ['A.1'], parallel: false }], overlaps: [] },
  tasks: [
    { id: 'A.1', state: 'SUCCEEDED', reason: 'completed', budget: { used: 1, limit: 3 }, attempts: [att(1, 'finished', 9, 14, 'COMPLETED')] },
    { id: 'A.2', state: 'RUNNING', reason: 'active-attempt', budget: { used: 2, limit: 3 }, attempts: [att(1, 'superseded', 10, 15), att(2, 'active', 16, null)] },
  ],
};
const runBody = (over: any = {}) => ({ v: 1, run: ROW, timeline: TIMELINE, tasks: TASKS, workflow: WORKFLOW, ...over });

const RUN_A11 = 'w-0000000000a1';
const RUN_A21 = 'w-0000000000b1';
const RUN_A22 = 'w-0000000000b2';
const RUN_CHILD = 'w-0000000000c1';

const wr = (runId: string, task: string, token: number, phase: string, endState: string | null, min: number, childOf: string | null = null) => ({
  runId, task, token, harness: 'codex', childOf, phase, endState, createdAt: iso(min), startedAt: iso(min), endedAt: phase === 'ended' ? iso(min + 3) : null, edit: false,
});
const RUNS = [
  wr(RUN_A11, 'A.1', 1, 'ended', 'exited', 9),
  wr(RUN_A21, 'A.2', 1, 'ended', 'cancelled', 10),
  wr(RUN_A22, 'A.2', 2, 'running', null, 16),
  wr(RUN_CHILD, 'A.2', 2, 'running', null, 17, RUN_A22),
];

/** The `/api/worker-runs/:slug` body as the Console projects the core's `worker-runs` output. */
function listed(runs: any[] = RUNS, notShown = 0) {
  const projected = project('worker-runs', { v: 1, slug: SLUG, store: 'present', runs, limits: { shown: runs.length, notShown } });
  assert.ok(projected.ok, 'the worker-runs projector accepts the fixture');
  return projected.body;
}

/** The older-core fallback body (`workerRuns` in console/src/routes.ts): active attempts' runs only. */
function fallback(runs: any[]) {
  return {
    v: 1, slug: SLUG, source: 'active-attempts', store: 'present',
    runs: runs.map((r) => ({ runId: r.runId, task: r.task, token: r.token, harness: r.harness, childOf: null, phase: null, endState: null, createdAt: null, startedAt: r.startedAt, endedAt: null, edit: null })),
    limits: { shown: runs.length, notShown: 0, ended: 'not-checked' },
  };
}

const RUN_PATH = `/api/runs/${SLUG}/${TASK_ID}`;
const WORKERS_PATH = `/api/worker-runs/${SLUG}`;
const wbase = (runId: string) => `/api/worker-runs/${SLUG}/${runId}`;
const logPage = (runId: string, stream: string, over: any = {}) => {
  const pieces = over.pieces ?? [{ at: 0, text: `${stream} text` }];
  const to = pieces.length ? pieces[pieces.length - 1].at + pieces[pieces.length - 1].text.length + 1 : 0;
  return { v: 1, runId, stream, phase: 'running', log: 'open', ino: '7', size: to, from: 0, to, pieces, eof: true, reset: false, capped: null, cursor: `7:${to}:0:0`, before: null, ...over };
};
const statusBody = (runId: string, over: any = {}) => ({
  runId, task: 'A.2', token: 2, harness: 'codex', state: 'running', reason: null, startedAt: iso(16), endedAt: null,
  overdue: false, supervisorLost: false, attemptActive: true, deadline: iso(60), childOf: null, process: null, cleanup: null, ...over,
});
const transcriptBody = () => ({
  v: 1, agentKey: '0123456789abcdef', harness: 'codex', reader: { id: 'codex', status: 'supported' }, transcript: { linked: true, reason: null },
  events: [{ seq: 1, at: iso(17), kind: 'reply', agentKey: '0123456789abcdef', model: null, tool: null, text: 'working on it', args: null, cut: false, tokens: null, record: null }], cursor: null,
});
/** Every worker route of `runId` answering 200. */
const workerRoutes = (runId: string) => ({
  [`${wbase(runId)}/log?stream=out`]: logPage(runId, 'out'),
  [`${wbase(runId)}/log?stream=err`]: logPage(runId, 'err'),
  [`${wbase(runId)}/status`]: statusBody(runId),
  [`${wbase(runId)}/transcript`]: transcriptBody(),
});

// ---- fakes --------------------------------------------------------------------------------------

const flush = async () => { for (let i = 0; i < 80; i += 1) await Promise.resolve(); };

/** A failure as apiGet throws it. */
const fail = (status: number, code: string) => ({ fail: { status, code, network: false } });

/** `apiGet` over scripted routes: a body, a `fail(...)`, or a function of the call count. Records every path. */
function fakeApi(routes: Record<string, any>) {
  const calls: string[] = [];
  const apiGet = async (target: string) => {
    calls.push(target);
    let entry = routes[target];
    if (typeof entry === 'function') entry = entry(calls.filter((c) => c === target).length);
    if (entry === undefined) throw { status: 404, code: 'not-found', network: false };
    const value = await entry;
    if (value && typeof value === 'object' && 'fail' in value) throw value.fail;
    return value;
  };
  return { apiGet, calls, routes, count: (target: string) => calls.filter((c) => c === target).length };
}

function fakeStore(transport = 'open') {
  const store: any = {
    subs: [] as Array<{ channel: string, listener: (event: any) => void, off: boolean }>,
    transportListeners: [] as Array<(event: any) => void>,
    transport,
    pauses: 0,
    resumes: 0,
    subscribe(channel: string, listener: (event: any) => void) {
      const sub = { channel, listener, off: false };
      store.subs.push(sub);
      return () => { sub.off = true; };
    },
    status: () => ({ transport: store.transport, lastFrameAt: null }),
    onTransport(listener: (event: any) => void) {
      store.transportListeners.push(listener);
      return () => { store.transportListeners = store.transportListeners.filter((l: any) => l !== listener); };
    },
    setTransport(state: string) {
      store.transport = state;
      for (const listener of [...store.transportListeners]) listener({ state, code: null, at: Date.now() });
    },
    pause() { store.pauses += 1; },
    resume() { store.resumes += 1; },
    emit(channel: string, event: any) { for (const sub of [...store.subs]) if (!sub.off && sub.channel === channel) sub.listener(event); },
    live: () => store.subs.filter((s: any) => !s.off).map((s: any) => s.channel),
  };
  return store;
}

/** A channel `state` frame holding members `{ name: [status, body] }`. */
const stateOf = (members: Record<string, [number, any]>) => ({
  kind: 'state', code: null, state: Object.fromEntries(Object.entries(members).map(([name, [status, body]]) => [name, { status, body }])),
});

/** The shell's inspector, reduced to what showPanel and hidePanel call; it tells the replaced showing it closed, as shell.js does. */
function fakeInspector() {
  const inspector: any = {
    spec: null, opens: 0, closes: 0,
    open(spec: any) {
      const previous = inspector.spec;
      inspector.spec = null;
      if (previous && typeof previous.onClose === 'function') previous.onClose();
      inspector.spec = spec;
      inspector.opens += 1;
    },
    close() {
      const previous = inspector.spec;
      if (previous === null) return;
      inspector.spec = null;
      inspector.closes += 1;
      if (typeof previous.onClose === 'function') previous.onClose();
    },
    body: () => (inspector.spec ? inspector.spec.body : null),
  };
  return inspector;
}

/** Renders the view over `data` into a container, with a local that records the selections reported for the hash. */
function mountView(data: any, opts: any = {}) {
  const api = fakeApi({ ...workerRoutes(RUN_A22), ...workerRoutes(RUN_CHILD), ...workerRoutes(RUN_A11), ...(opts.routes ?? {}) });
  const store = opts.store ?? fakeStore();
  const inspector = fakeInspector();
  const links: any[] = [];
  const local: any = {
    inspector, route: { id: 'session', params: PARAMS, node: opts.node, tab: opts.tab },
    link: (patch: any) => { links.push(patch); return true; },
    apiGet: api.apiGet, liveStore: () => store,
  };
  const container = new El('main');
  const paint = (next: any) => { const root = mod.renderSession(next, PARAMS, local); container.replaceChildren(root); return root; };
  const root = paint(data);
  const view: any = {
    local, store, inspector, links, api, container, paint,
    get root() { return container.children[0]; },
    tree: () => view.root.querySelector('[role="tree"]') as El,
    items: () => view.root.querySelectorAll('[role="treeitem"]') as El[],
    item: (key: string) => view.root.querySelectorAll('[role="treeitem"]').find((li: El) => li.dataset.key === key) as El,
    shown: () => view.items().filter((li: El) => !hiddenUp(li)).map((li: El) => li.dataset.key),
    press: (key: string, extra: any = {}) => (doc.activeElement as El).fire('keydown', { key, ...extra }),
    panel: () => inspector.body() as El,
  };
  void root;
  return view;
}

/** Whether `el` sits inside a `hidden` group. */
function hiddenUp(el: any): boolean {
  for (let node = el.parent; node instanceof El; node = node.parent) if (node.hasAttribute('hidden')) return true;
  return false;
}

const text = (node: any) => node.textContent as string;
const ready = () => ({ run: runBody(), workers: listed(), workersError: null });
/** The keys of the tree in document order with level, expansion and selection: what a person can perceive of it. */
const outline = (view: any) => view.items().map((li: El) => [li.dataset.key, li.getAttribute('aria-level'), li.getAttribute('aria-expanded'), li.getAttribute('aria-selected'), li.getAttribute('aria-label'), hiddenUp(li)]);

// ---- the tree -----------------------------------------------------------------------------------

test('outline markup: ul[role=tree] "Run chain" of li[role=treeitem] with aria-level, aria-expanded on parents only, one tab stop, text nodes only', () => {
  const view = mountView(ready());
  const tree = view.tree();
  assert.equal(tree.tagName, 'ul');
  assert.equal(tree.getAttribute('aria-label'), 'Run chain');
  assert.equal(view.root.dataset.state, 'ready');
  const items = view.items();
  assert.ok(items.every((li: El) => li.tagName === 'li' && li.classList.contains('chain__item')));
  assert.deepEqual(items.map((li: El) => li.dataset.key), [
    'main', 'stage:plan', 'gate:gate-plan', 'stage:build', 'tasks', 'task:A.1', 'attempt:A.1/1', `worker:${RUN_A11}`,
    'task:A.2', 'attempt:A.2/1', `worker:${RUN_A21}`, 'attempt:A.2/2', `worker:${RUN_A22}`, `worker:${RUN_CHILD}`,
  ]);
  const level = (key: string) => view.item(key).getAttribute('aria-level');
  assert.deepEqual(['main', 'stage:plan', 'tasks', 'task:A.2', 'attempt:A.2/2', `worker:${RUN_A22}`, `worker:${RUN_CHILD}`].map(level), ['1', '2', '2', '3', '4', '5', '6']);
  // aria-expanded only where there are children; the groups of children are ul[role=group].
  for (const li of items) {
    const group = li.children.find((c: any) => c instanceof El && c.tagName === 'ul');
    assert.equal(li.hasAttribute('aria-expanded'), Boolean(group), li.dataset.key);
    if (group) assert.equal(group.getAttribute('role'), 'group');
  }
  // Open by default: main, the groups and nodes with a live child; ended work is collapsed.
  assert.equal(view.item('main').getAttribute('aria-expanded'), 'true');
  assert.equal(view.item('tasks').getAttribute('aria-expanded'), 'true');
  assert.equal(view.item('task:A.1').getAttribute('aria-expanded'), 'false');
  assert.equal(view.item('task:A.2').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(items.filter((li: El) => li.getAttribute('tabindex') === '0').map((li: El) => li.dataset.key), ['main']);
  assert.ok(items.every((li: El) => ['0', '-1'].includes(String(li.getAttribute('tabindex')))));
  assert.equal(items.filter((li: El) => li.hasAttribute('aria-selected')).length, 0, 'nothing selected yet');
  // Rows: label, chip, live count, marker; the main node is marked not linked.
  assert.equal(view.item('main').getAttribute('aria-label'), 'Run run-1, Running, 2 live, Not linked');
  assert.ok(view.item('main').querySelector('.chain__marker'));
  assert.equal(text(view.item('task:A.2').querySelector('.chain__live')), '1 live');
  assert.ok(view.item('task:A.2').querySelector('.chain__chip'));
  // Text nodes only, and the tree is the only element with a key listener.
  for (const node of nodesOf(view.root)) {
    if (node instanceof El) assert.equal((node.listeners.get('keydown') ?? []).length, node === tree ? 1 : 0, `${node.tagName} ${node.dataset.key ?? ''}`);
  }
  assert.ok(nodesOf(view.root).every((n: any) => n instanceof El || n instanceof Txt));
});

test('keyboard: Down, Up, Home and End move over shown items; Right expands or enters; Left collapses or goes to the parent', () => {
  const view = mountView(ready());
  view.item('main').focus();
  const at = () => (doc.activeElement as El).dataset.key;
  const stop = () => view.items().filter((li: El) => li.getAttribute('tabindex') === '0').map((li: El) => li.dataset.key);
  const steps: Array<[string, string]> = [['ArrowDown', 'stage:plan'], ['ArrowDown', 'gate:gate-plan'], ['ArrowUp', 'stage:plan'], ['End', `worker:${RUN_CHILD}`], ['Home', 'main']];
  for (const [key, want] of steps) {
    const event = view.press(key);
    assert.equal(event.defaultPrevented, true, key);
    assert.equal(at(), want, key);
    assert.deepEqual(stop(), [want], `${key}: one tab stop, on the focused item`);
  }
  assert.equal(view.press('ArrowUp').defaultPrevented, true);
  assert.equal(at(), 'main', 'Up on the first item stays');
  // A collapsed task: Right expands it, Right again enters its first child, Left goes back up, Left again collapses.
  view.item('task:A.1').focus();
  assert.equal(view.item('task:A.1').getAttribute('aria-expanded'), 'false');
  assert.ok(!view.shown().includes('attempt:A.1/1'));
  view.press('ArrowRight');
  assert.equal(view.item('task:A.1').getAttribute('aria-expanded'), 'true');
  assert.equal(at(), 'task:A.1');
  assert.ok(view.shown().includes('attempt:A.1/1'));
  view.press('ArrowRight');
  assert.equal(at(), 'attempt:A.1/1');
  view.press('ArrowLeft');
  assert.equal(at(), 'task:A.1', 'Left on a collapsed item goes to its parent');
  view.press('ArrowLeft');
  assert.equal(view.item('task:A.1').getAttribute('aria-expanded'), 'false');
  assert.equal(at(), 'task:A.1');
  // Right on a leaf does nothing; Down skips what a collapsed item hides.
  view.item('stage:plan').focus();
  view.press('ArrowRight');
  assert.equal(at(), 'stage:plan');
  view.item('task:A.1').focus();
  view.press('ArrowDown');
  assert.equal(at(), 'task:A.2');
  // A modified key is not the tree's.
  assert.equal(view.press('ArrowDown', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(at(), 'task:A.2');
  assert.deepEqual(view.links, [], 'moving the focus selects nothing');
});

test('selection by keyboard: Enter and Space select, mark aria-selected on that item only, and report the node for the hash', () => {
  const view = mountView(ready());
  view.item('task:A.1').focus();
  assert.equal(view.press('Enter').defaultPrevented, true);
  const selected = () => view.items().filter((li: El) => li.getAttribute('aria-selected') === 'true').map((li: El) => li.dataset.key);
  assert.deepEqual(selected(), ['task:A.1']);
  assert.deepEqual(view.links.at(-1), { node: { kind: 'task', id: 'A.1' } });
  view.item('gate:gate-plan').focus();
  assert.equal(view.press(' ').defaultPrevented, true);
  assert.deepEqual(selected(), ['gate:gate-plan']);
  assert.deepEqual(view.links.at(-1), { node: { kind: 'gate', id: 'gate-plan' } });
  view.item('attempt:A.2/2').focus();
  view.press('Enter');
  assert.deepEqual(view.links.at(-1), { node: { kind: 'attempt', task: 'A.2', token: 2 } });
  view.item('main').focus();
  view.press('Enter');
  assert.deepEqual(view.links.at(-1), { node: { kind: 'main' } });
  // A group has no hash form: Enter opens or closes it and reports nothing.
  const reported = view.links.length;
  view.item('tasks').focus();
  view.press('Enter');
  assert.equal(view.item('tasks').getAttribute('aria-expanded'), 'false');
  view.press(' ');
  assert.equal(view.item('tasks').getAttribute('aria-expanded'), 'true');
  assert.equal(view.links.length, reported);
  assert.deepEqual(selected(), ['main']);
});

test('selection by pointer: a click on a row selects its item, focuses it and reports it; the listener is the tree\'s', () => {
  const view = mountView(ready());
  const row = view.item('stage:build').children[0];
  row.children[0].fire('click');
  assert.equal(view.item('stage:build').getAttribute('aria-selected'), 'true');
  assert.equal(doc.activeElement, view.item('stage:build'));
  assert.equal(view.item('stage:build').getAttribute('tabindex'), '0');
  assert.deepEqual(view.links.at(-1), { node: { kind: 'stage', id: 'build' } });
  assert.equal((view.tree().listeners.get('click') ?? []).length, 1);
  assert.ok(view.items().every((li: El) => (li.listeners.get('click') ?? []).length === 0));
  // A click on a worker run nested deep selects that run, not an ancestor.
  view.item(`worker:${RUN_CHILD}`).children[0].fire('click');
  assert.deepEqual(view.links.at(-1), { node: { kind: 'worker', runId: RUN_CHILD } });
  mod.teardownSession(view.local);
});

test('no document keydown listener, no shortcut entry and no markup sink in session.js', () => {
  assert.doesNotMatch(SOURCE, /document\s*\.\s*addEventListener/);
  assert.doesNotMatch(SOURCE, /SHORTCUTS/);
  assert.doesNotMatch(SOURCE, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(SOURCE, /\b(setTimeout|setInterval)\b/, 'the view runs no timer; polling is the connector\'s');
});

// ---- the inspector panels -----------------------------------------------------------------------

test('panels: a stage or gate shows the rail detail, a task the Tasks panel body, an attempt its row, the main node its facts and sentence', () => {
  const view = mountView(ready(), { node: { kind: 'stage', id: 'plan' } });
  assert.equal(view.item('stage:plan').getAttribute('aria-selected'), 'true');
  assert.equal(view.inspector.spec.title, 'Step details');
  assert.equal(view.inspector.spec.labelledBy, 'rail-detail-title');
  assert.equal(view.inspector.spec.owner, view.item('stage:plan'));
  const stage = view.panel().querySelector('.rail-detail');
  assert.ok(stage);
  assert.equal(text(stage.querySelector('[id="rail-detail-title"]')), 'plan');
  assert.ok(text(stage).includes('do-plan'));

  view.local.route = { ...view.local.route, node: { kind: 'gate', id: 'gate-plan' } };
  mod.rerouteSession(view.local, PARAMS, ready());
  assert.ok(text(view.panel().querySelector('.rail-detail')).includes('Approve the plan?'));
  assert.ok(text(view.panel()).includes('Approved'));

  view.local.route = { ...view.local.route, node: { kind: 'task', id: 'A.2' } };
  mod.rerouteSession(view.local, PARAMS, ready());
  assert.equal(view.inspector.spec.title, 'Task details');
  const task = view.panel();
  assert.equal(text(task.querySelector('h2')), 'A.2');
  assert.ok(task.querySelector('.gdetail__facts'), 'detailBody facts');
  assert.ok(text(task).includes('An attempt is running.'));
  assert.ok(text(task.querySelector('.gdetail__facts')).includes('A.1'), 'waits for A.1, from the plan graph');
  assert.equal(task.querySelectorAll('.gattempt').length, 2);

  view.local.route = { ...view.local.route, node: { kind: 'attempt', task: 'A.2', token: 2 } };
  mod.rerouteSession(view.local, PARAMS, ready());
  const attempt = view.panel();
  assert.equal(view.inspector.spec.title, 'Attempt details');
  assert.equal(attempt.querySelectorAll('.gattempt').length, 1);
  const row = attempt.querySelector('.gattempt');
  assert.equal(text(row.querySelector('.gattempt__no')), 'Attempt 2');
  assert.equal(text(row.querySelector('.gattempt__owner')), 'core-implementer · subagent');
  assert.ok(text(row.querySelector('.gattempt__when')).startsWith('since '));

  view.local.route = { ...view.local.route, node: { kind: 'main' } };
  mod.rerouteSession(view.local, PARAMS, ready());
  const main = view.panel();
  assert.equal(view.inspector.spec.title, 'Run details');
  assert.ok(text(main).includes('No record ties a coding-tool session to this run, so the session is not shown.'));
  assert.equal(mod.UNLINKED_SESSION, 'No record ties a coding-tool session to this run, so the session is not shown.');
  for (const part of ['feature', 'Feature Flow', 'Started', SLUG]) assert.ok(text(main).includes(part), part);
  // A route node no record matches says so; no selection is a closed panel.
  view.local.route = { ...view.local.route, node: { kind: 'task', id: 'Z.9' } };
  mod.rerouteSession(view.local, PARAMS, ready());
  assert.ok(text(view.panel()).includes('Nothing in this run’s records matches this item.'));
  view.local.route = { ...view.local.route, node: undefined };
  mod.rerouteSession(view.local, PARAMS, ready());
  assert.equal(view.inspector.spec, null);
  assert.equal(view.items().filter((li: El) => li.hasAttribute('aria-selected')).length, 0);
});

test('panels: a worker run shows the worker tabs; Escape or the inspector close ends the selection and reports none', async () => {
  const view = mountView(ready(), { node: { kind: 'worker', runId: RUN_A22 } });
  await flush();
  const panel = view.panel();
  assert.equal(view.inspector.spec.title, 'Worker run');
  assert.equal(text(panel.querySelector('h2')), RUN_A22);
  assert.ok(panel.querySelector('[role="tablist"][aria-label="Worker run"]'));
  assert.deepEqual(panel.querySelectorAll('[role="tab"]').map(text), ['Log', 'Transcript', 'Result', 'Process']);
  assert.equal(panel.querySelector('[role="tab"][aria-selected="true"]').dataset.tab, 'log', 'a worker node without a tab shows Log');
  assert.ok(text(panel).includes('stdout') && text(panel).includes('out text'));
  // The inspector's own close: the selection ends, the worker channels go and the hash loses the node.
  view.inspector.close();
  assert.equal(view.items().filter((li: El) => li.hasAttribute('aria-selected')).length, 0);
  assert.equal(view.links.at(-1), null);
  assert.deepEqual(view.store.live(), []);
  assert.equal(doc.activeElement, view.item(`worker:${RUN_A22}`), 'the focus goes back to the item');
  // Escape inside a stage's rail detail does the same.
  const stage = mountView(ready(), { node: { kind: 'stage', id: 'plan' } });
  stage.panel().querySelector('.rail-detail').fire('keydown', { key: 'Escape' });
  assert.equal(stage.inspector.spec, null);
  assert.equal(stage.links.at(-1), null);
});

test('panels: the tab the route names is selected; choosing a tab reports the node and tab; a reroute moves the tab without a re-mount', async () => {
  const view = mountView(ready(), { node: { kind: 'worker', runId: RUN_A22 }, tab: 'process' });
  await flush();
  const tabs = () => view.panel().querySelectorAll('[role="tab"]');
  assert.equal(view.panel().querySelector('[role="tab"][aria-selected="true"]').dataset.tab, 'process');
  assert.ok(text(view.panel()).includes('Running'));
  tabs()[1].fire('click');
  assert.deepEqual(view.links.at(-1), { node: { kind: 'worker', runId: RUN_A22 }, tab: 'transcript' });
  const tablist = view.panel().querySelector('[role="tablist"]');
  view.local.route = { ...view.local.route, tab: 'result' };
  mod.rerouteSession(view.local, PARAMS, ready());
  assert.equal(view.panel().querySelector('[role="tablist"]'), tablist, 'the same tabs');
  assert.equal(view.panel().querySelector('[role="tab"][aria-selected="true"]').dataset.tab, 'result');
  mod.teardownSession(view.local);
});

// ---- outline states -----------------------------------------------------------------------------

test('outline states: loading skeleton, ready, partial (not all worker runs listed), worker level not in core, run not found', async () => {
  const loading = mod.skeletonSession();
  assert.equal(loading.dataset.state, 'loading');
  assert.ok(loading.classList.contains('chain'));

  assert.equal(mountView(ready()).root.dataset.state, 'ready');
  assert.equal(mountView(ready()).root.querySelectorAll('p').length, 0, 'nothing to say when every run was read');

  const partial = mountView({ run: runBody(), workers: listed(RUNS.slice(2), 2), workersError: null });
  assert.equal(partial.root.dataset.state, 'partial');
  assert.equal(text(partial.root.querySelector('p')), '2 older worker runs are not shown, so some attempts’ runs are not checked.');
  assert.equal(partial.item('attempt:A.1/1').getAttribute('aria-label'), 'Attempt 1, Finished, Worker runs not checked');

  // A 501 on the workers member: the outline says so; stages, gates, tasks and attempts still work.
  const api = fakeApi({ [RUN_PATH]: runBody(), [WORKERS_PATH]: fail(501, 'core-lacks-verb') });
  const local: any = { route: { id: 'session', params: PARAMS } };
  const data = await mod.loadSession(local, api.apiGet);
  assert.deepEqual(data, { run: runBody(), workers: null, workersError: { status: 501, code: 'core-lacks-verb', network: false } });
  const older = mountView(data);
  assert.equal(older.root.dataset.state, 'not-in-core');
  assert.equal(text(older.root.querySelector('p')), 'This DoFlow core does not list worker runs, so attempts’ worker runs are not checked.');
  assert.deepEqual(older.items().map((li: El) => li.dataset.key), ['main', 'stage:plan', 'gate:gate-plan', 'stage:build', 'tasks', 'task:A.1', 'attempt:A.1/1', 'task:A.2', 'attempt:A.2/1', 'attempt:A.2/2']);
  assert.ok(older.items().filter((li: El) => li.dataset.kind === 'attempt').every((li: El) => li.querySelector('.chain__marker')));
  older.item('task:A.2').children[0].fire('click');
  assert.ok(older.panel().querySelector('.gdetail__facts'), 'a task panel works without worker runs');
  // Another worker-level failure is partial: the runs are not checked, the rest works.
  const flaky = await mod.loadSession(local, fakeApi({ [RUN_PATH]: runBody(), [WORKERS_PATH]: fail(502, 'core-contract-mismatch') }).apiGet);
  const broken = mountView(flaky);
  assert.equal(broken.root.dataset.state, 'partial');
  assert.equal(text(broken.root.querySelector('p')), 'Worker runs could not be read, so they are not checked.');

  // Run not found: the read rejects as the run GET does, which the shell shows as its run-not-found state.
  const missing = fakeApi({ [RUN_PATH]: fail(404, 'run-not-found'), [WORKERS_PATH]: listed() });
  await assert.rejects(mod.loadSession(local, missing.apiGet), (error: any) => {
    assert.equal(states.classify(error).key, 'run-not-found');
    return true;
  });
  assert.equal(mod.sessionApi(PARAMS), RUN_PATH);
  assert.deepEqual(mod.SESSION_SHAPES, ['status', 'timeline', 'attempts', 'workflow', 'worker-runs', 'worker-status', 'worker-run-status', 'worker-result', 'worker-log', 'projects', 'transcript']);
});

test('older core: the fallback list makes the outline partial; Process and Transcript work, Log and Result say the core lacks them', async () => {
  const runs = [RUNS[2]];
  const routes = {
    [`${wbase(RUN_A22)}/log?stream=out`]: fail(501, 'core-lacks-verb'),
    [`${wbase(RUN_A22)}/log?stream=err`]: fail(501, 'core-lacks-verb'),
    [`${wbase(RUN_A22)}/result`]: fail(501, 'core-lacks-verb'),
  };
  const view = mountView({ run: runBody(), workers: fallback(runs), workersError: null }, { node: { kind: 'worker', runId: RUN_A22 }, routes });
  assert.equal(view.root.dataset.state, 'partial');
  assert.equal(text(view.root.querySelector('p')), 'This version of DoFlow lists only the worker runs of active attempts, so ended attempts’ runs are not checked.');
  assert.ok(view.item('attempt:A.1/1').querySelector('.chain__marker'), 'an ended attempt is not checked, never "no worker run"');
  await flush();
  const panel = () => view.panel().querySelector('[role="tabpanel"]');
  const choose = async (i: number) => { view.panel().querySelectorAll('[role="tab"]')[i].fire('click'); await flush(); };
  assert.equal(panel().dataset.state, 'not-in-core');
  assert.ok(text(panel()).includes('This DoFlow core does not provide worker logs.'));
  await choose(2);
  assert.equal(panel().dataset.state, 'not-in-core');
  assert.ok(text(panel()).includes('This DoFlow core does not provide worker results.'));
  await choose(3);
  assert.equal(panel().dataset.state, 'ready');
  assert.ok(text(panel()).includes('Running'));
  await choose(1);
  assert.equal(panel().dataset.state, 'ready');
  assert.ok(text(panel()).includes('working on it'));
  assert.equal(view.api.count(`${wbase(RUN_A22)}/status`), 1);
  assert.equal(view.api.count(`${wbase(RUN_A22)}/transcript`), 1);
  mod.teardownSession(view.local);
});

// ---- channels -----------------------------------------------------------------------------------

/** Starts the connector and the view over one fake store and GET, as the shell does: the first paint is `load`. */
async function liveSession(opts: any = {}) {
  const store = opts.store ?? fakeStore();
  const api = fakeApi({ [RUN_PATH]: runBody(), [WORKERS_PATH]: listed(), ...workerRoutes(RUN_A22), ...workerRoutes(RUN_CHILD), ...workerRoutes(RUN_A11), ...(opts.routes ?? {}) });
  const inspector = fakeInspector();
  const links: any[] = [];
  const local: any = { inspector, route: { id: 'session', params: PARAMS, node: opts.node, tab: opts.tab }, link: (patch: any) => { links.push(patch); return true; } };
  const delivered: any[] = [];
  const failures: any[] = [];
  const container = new El('main');
  const connector = mod.connectSession(local, PARAMS, {
    fetchJson: api.apiGet,
    onData: (data: any) => { delivered.push(data); container.replaceChildren(mod.renderSession(data, PARAMS, local)); },
    onFailure: (error: any) => failures.push(error),
    store: () => store,
    fetchOnce: () => mod.loadSession(local, api.apiGet),
  });
  connector.start();
  await flush();
  const item = (key: string) => container.querySelectorAll('[role="treeitem"]').find((li: El) => li.dataset.key === key) as El;
  return { store, api, inspector, links, local, delivered, failures, container, connector, item };
}

test('channels: run and tasks always; worker:<runId> for the selected run, its out and err only while Log is open; at most 5; reselecting drops the old run\'s', async () => {
  const s = await liveSession();
  const channels = () => s.store.live().sort();
  const RUN_CH = `run:${SLUG}:${TASK_ID}`;
  const TASKS_CH = `tasks:${SLUG}`;
  assert.deepEqual(channels(), [RUN_CH, TASKS_CH].sort());
  s.item(`worker:${RUN_A22}`).children[0].fire('click');
  await flush();
  assert.deepEqual(channels(), [RUN_CH, TASKS_CH, `worker:${RUN_A22}`, `worker:${RUN_A22}:out`, `worker:${RUN_A22}:err`].sort());
  assert.ok(s.store.live().length <= 5);
  // Another tab: the log channels go, the run's channel stays.
  s.inspector.body().querySelectorAll('[role="tab"]')[3].fire('click');
  await flush();
  assert.deepEqual(channels(), [RUN_CH, TASKS_CH, `worker:${RUN_A22}`].sort());
  s.inspector.body().querySelectorAll('[role="tab"]')[0].fire('click');
  await flush();
  assert.equal(s.store.live().length, 5);
  // Another worker run: the previous run's three channels are dropped, the new run's opened, on Log.
  s.item(`worker:${RUN_CHILD}`).children[0].fire('click');
  await flush();
  assert.deepEqual(channels(), [RUN_CH, TASKS_CH, `worker:${RUN_CHILD}`, `worker:${RUN_CHILD}:out`, `worker:${RUN_CHILD}:err`].sort());
  assert.equal(s.inspector.body().querySelector('[role="tab"][aria-selected="true"]').dataset.tab, 'log');
  // A node that is no worker run: only the connector's two remain.
  s.item('stage:plan').children[0].fire('click');
  await flush();
  assert.deepEqual(channels(), [RUN_CH, TASKS_CH].sort());
  // The worker member reaches the Process tab live.
  s.item(`worker:${RUN_A22}`).children[0].fire('click');
  await flush();
  s.inspector.body().querySelectorAll('[role="tab"]')[3].fire('click');
  await flush();
  s.store.emit(`worker:${RUN_A22}`, stateOf({ worker: [200, statusBody(RUN_A22, { state: 'exited', process: { kind: 'exited', code: 0, signal: null, groupAlive: false, leftover: null } })] }));
  await flush();
  assert.ok(text(s.inspector.body()).includes('exit code 0'));
  mod.teardownSession(s.local);
  assert.deepEqual(channels(), [RUN_CH, TASKS_CH].sort(), 'leaving the view drops the worker channels; the connector stops its own');
  s.connector.stop();
  assert.deepEqual(channels(), []);
});

test('Chain updates live: after the first paint frames update the outline with no timer-driven GET, equal to a fresh read', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 + 30 * MIN });
  const s = await liveSession();
  assert.equal(s.delivered.length, 1, 'the first paint is the GET');
  assert.deepEqual(s.delivered[0], { run: runBody(), workers: listed(), workersError: null });
  const gets = s.api.calls.length;
  // Both members arrive: live, nothing new to draw (equal bodies are other objects, so one delivery).
  s.store.emit(`run:${SLUG}:${TASK_ID}`, stateOf({ run: [200, runBody()] }));
  assert.equal(s.connector.mode, 'connecting', 'live once every part holds a state');
  s.store.emit(`tasks:${SLUG}`, stateOf({ workers: [200, listed()] }));
  assert.equal(s.connector.mode, 'live');
  // The chain moves: A.2's attempt 2 finishes, its run ends.
  const ended = RUNS.map((r) => (r.runId === RUN_A22 || r.runId === RUN_CHILD ? { ...r, phase: 'ended', endState: 'exited', endedAt: iso(25) } : r));
  const tasksAfter = { ...TASKS, tasks: [TASKS.tasks[0], { ...TASKS.tasks[1], state: 'SUCCEEDED', reason: 'completed', attempts: [TASKS.tasks[1].attempts[0], att(2, 'finished', 16, 25, 'COMPLETED')] }] };
  const runAfter = runBody({ tasks: tasksAfter });
  s.store.emit(`run:${SLUG}:${TASK_ID}`, stateOf({ run: [200, runAfter] }));
  s.store.emit(`tasks:${SLUG}`, stateOf({ workers: [200, listed(ended)] }));
  await flush();
  for (let i = 0; i < 30; i += 1) { mock.timers.tick(1000); await flush(); }
  assert.equal(s.api.calls.length, gets, 'no GET while live');
  const last = s.delivered.at(-1);
  assert.deepEqual(last, { run: runAfter, workers: listed(ended), workersError: null });
  assert.equal(s.item('task:A.2').getAttribute('aria-label'), 'Task A.2, Done');
  assert.equal(s.item(`worker:${RUN_A22}`).getAttribute('aria-label'), `Worker run ${RUN_A22}, Exited`);
  // A fresh read of the same bodies draws the same outline.
  const fresh = await mod.loadSession({ route: { params: PARAMS } }, fakeApi({ [RUN_PATH]: runAfter, [WORKERS_PATH]: listed(ended) }).apiGet);
  assert.deepEqual(fresh, last);
  const other = mountView(fresh);
  const liveView: any = { items: () => s.container.querySelectorAll('[role="treeitem"]') };
  assert.deepEqual(outline(liveView), outline(other));
  // A frame in which no member changed delivers nothing.
  const count = s.delivered.length;
  const same = stateOf({ run: [200, runAfter] });
  s.store.emit(`run:${SLUG}:${TASK_ID}`, same);
  assert.equal(s.delivered.length, count + 1, 'a new member object is delivered');
  s.store.emit(`run:${SLUG}:${TASK_ID}`, same);
  assert.equal(s.delivered.length, count + 1, 'the same member object is not');
  assert.equal(s.api.calls.length, gets);
  s.connector.stop();
});

test('live members: a non-200 run goes to onFailure; a non-200 workers member reaches the outline as the worker-level message', async () => {
  const s = await liveSession();
  s.store.emit(`run:${SLUG}:${TASK_ID}`, stateOf({ run: [200, runBody()] }));
  s.store.emit(`tasks:${SLUG}`, stateOf({ workers: [501, { error: { code: 'core-lacks-verb' } }] }));
  await flush();
  assert.deepEqual(s.delivered.at(-1), { run: runBody(), workers: null, workersError: { status: 501, code: 'core-lacks-verb', network: false } });
  assert.equal(s.failures.length, 0);
  assert.equal(s.container.children[0].dataset.state, 'not-in-core');
  assert.ok(s.item('stage:build'), 'stages still drawn');
  const shown = s.delivered.length;
  s.store.emit(`run:${SLUG}:${TASK_ID}`, stateOf({ run: [404, { error: { code: 'run-not-found' } }] }));
  assert.deepEqual(s.failures, [{ status: 404, code: 'run-not-found', network: false }]);
  assert.equal(s.delivered.length, shown);
  s.connector.stop();
});

test('polling fallback: without live the view reads `load` every 3000 ms in Polling mode; pause and a hidden tab read nothing', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 + 30 * MIN });
  const store = fakeStore('unsupported');
  const s = await liveSession({ store });
  assert.equal(s.connector.mode, 'polling');
  assert.equal(s.connector.intervalMs, 3000);
  assert.equal(mod.SESSION_POLL_MS, 3000);
  const reads = () => s.api.count(RUN_PATH);
  assert.equal(reads(), 1);
  assert.equal(s.api.count(WORKERS_PATH), 1, 'load reads both members');
  mock.timers.tick(2999); await flush();
  assert.equal(reads(), 1);
  mock.timers.tick(1); await flush();
  assert.equal(reads(), 2);
  assert.equal(s.api.count(WORKERS_PATH), 2);
  assert.ok(s.connector.lastSuccessAt !== null);
  assert.equal(s.connector.isStale(), false);
  // The person's pause: no read; resume reads again.
  s.connector.pause();
  assert.equal(store.pauses, 1);
  for (let i = 0; i < 4; i += 1) { mock.timers.tick(3000); await flush(); }
  assert.equal(reads(), 2);
  s.connector.resume();
  await flush();
  mock.timers.tick(3000); await flush();
  assert.ok(reads() >= 3);
  // A hidden tab: no read while hidden.
  const before = reads();
  doc.hidden = true;
  for (const fn of docListeners.get('visibilitychange') ?? []) fn();
  for (let i = 0; i < 4; i += 1) { mock.timers.tick(3000); await flush(); }
  assert.equal(reads(), before);
  doc.hidden = false;
  for (const fn of docListeners.get('visibilitychange') ?? []) fn();
  await flush();
  assert.ok(reads() > before);
  // Stale: failures in a row while polling.
  s.api.routes[RUN_PATH] = fail(500, 'core-error');
  for (let i = 0; i < 8; i += 1) { mock.timers.tick(30000); await flush(); }
  assert.equal(s.connector.isStale(), true);
  // The tabs carry the stale state on the shell's tick.
  s.api.routes[RUN_PATH] = runBody();
  s.local.route = { ...s.local.route, node: { kind: 'worker', runId: RUN_A22 } };
  mod.rerouteSession(s.local, PARAMS, s.delivered.at(-1));
  mod.tickSession(null, Date.now(), s.local);
  assert.equal(s.inspector.body().querySelector('[role="tabpanel"]').dataset.stale, 'true');
  mod.teardownSession(s.local);
  s.connector.stop();
});

test('back to live: an open stream with both channels holding a state ends polling', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 + 30 * MIN });
  const store = fakeStore('closed');
  const s = await liveSession({ store });
  assert.equal(s.connector.mode, 'polling');
  s.store.emit(`run:${SLUG}:${TASK_ID}`, stateOf({ run: [200, runBody()] }));
  assert.equal(s.connector.mode, 'polling', 'one part is not enough');
  s.store.emit(`tasks:${SLUG}`, stateOf({ workers: [200, listed()] }));
  assert.equal(s.connector.mode, 'live');
  // The connection drops and comes back with both channels' states kept: live again with no new frame.
  store.setTransport('closed');
  assert.equal(s.connector.mode, 'polling');
  store.setTransport('open');
  assert.equal(s.connector.mode, 'live');
  // A part's channel in error is polled until that channel sends a state again.
  s.store.emit(`tasks:${SLUG}`, { kind: 'error', code: 'events-down', state: null });
  assert.equal(s.connector.mode, 'polling');
  store.setTransport('open');
  assert.equal(s.connector.mode, 'polling', 'the errored part holds no state');
  s.store.emit(`tasks:${SLUG}`, stateOf({ workers: [200, listed()] }));
  assert.equal(s.connector.mode, 'live');
  s.connector.stop();
});
