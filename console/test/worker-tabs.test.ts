'use strict';

// The worker tabs of the Session screen (feature 150, IC-018; plan task C.3, D5). Like client-core.test.ts, the web root is
// copied beside a {"type":"module"} marker and views/worker-tabs.js is imported from there. A small fake DOM (elements and
// text nodes; an innerHTML write throws) records what the code builds. The live store is a fake that records subscriptions
// and pushes channel frames, `apiGet` is a fake over scripted routes that records every path, and the log streams get a fake
// clock, so nothing waits in real time.

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CLOSED_SETS } = require('../src/project.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
/** worker-tabs.js without its comments: the scans below read code, not the header that names the log streams' clock. */
const SOURCE = fs.readFileSync(path.join(WEB_ROOT, 'views', 'worker-tabs.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
let copy: string;
let mod: any;
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

const doc: any = { activeElement: null };

class El {
  parent: any = null;
  children: any[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Function[]>();
  dataset: any;
  classList: any;
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
    };
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
  fire(type: string, extra: any = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  focus() { doc.activeElement = this; }
  matches(c: Compound) {
    if (c.tag && this.tagName.toLowerCase() !== c.tag) return false;
    if (!c.classes.every((k) => this.classList.contains(k))) return false;
    return c.attrs.every(([name, value]) => (value === null ? this.attrs.has(name) : this.attrs.get(name) === value));
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
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-worker-tabs-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  mod = await import(pathToFileURL(path.join(copy, 'views', 'worker-tabs.js')).href);
});
after(() => {
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
  else delete (globalThis as any).document;
  fs.rmSync(copy, { recursive: true, force: true });
});

// ---- fakes --------------------------------------------------------------------------------------

const flush = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); };

function fakeClock() {
  const clock: any = {
    timers: [] as Array<{ fn: () => void, ms: number, id: number }>, id: 0,
    now: () => 0,
    setTimeout: (fn: () => void, ms: number) => { clock.id += 1; clock.timers.push({ fn, ms, id: clock.id }); return clock.id; },
    clearTimeout: (id: number) => { clock.timers = clock.timers.filter((t: any) => t.id !== id); },
  };
  return clock;
}

function fakeStore() {
  const store: any = {
    subs: [] as Array<{ channel: string, listener: (event: any) => void, off: boolean }>,
    subscribe(channel: string, listener: (event: any) => void) {
      const sub = { channel, listener, off: false };
      store.subs.push(sub);
      return () => { sub.off = true; };
    },
    status: () => ({ transport: 'open', lastFrameAt: null }),
    onTransport: () => () => {},
    emit(channel: string, event: any) { for (const sub of store.subs) if (!sub.off && sub.channel === channel) sub.listener(event); },
    live: () => store.subs.filter((s: any) => !s.off).map((s: any) => s.channel),
  };
  return store;
}

/** A failure as apiGet throws it. */
const fail = (status: number, code: string) => ({ fail: { status, code, network: false } });

function deferred() {
  let resolve: (value: any) => void = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const SLUG = 'feat-a';
const RUN = 'w-1a2b3c4d5e6f';
const RUN2 = 'w-aaaaaaaaaaaa';
const base = (runId = RUN) => `/api/worker-runs/${SLUG}/${runId}`;
const LOG_OUT = (runId = RUN) => `${base(runId)}/log?stream=out`;
const LOG_ERR = (runId = RUN) => `${base(runId)}/log?stream=err`;

const runRow = (over: any = {}) => ({
  runId: RUN, task: 'A.1', token: 1, harness: 'codex', childOf: null, phase: 'running', endState: null,
  createdAt: '2026-11-08T05:00:00.000Z', startedAt: '2026-11-08T05:00:01.000Z', endedAt: null, edit: false, ...over,
});

const logPage = (over: any = {}) => {
  const pieces = over.pieces ?? [{ at: 0, text: 'hello' }];
  const to = over.to ?? (pieces.length ? pieces[pieces.length - 1].at + pieces[pieces.length - 1].text.length + 1 : 0);
  return { v: 1, runId: RUN, stream: 'out', phase: 'running', log: 'open', ino: '7', size: to, from: 0, to, pieces, eof: true, reset: false, capped: null, cursor: `7:${to}:0:0`, before: null, ...over };
};

const resultBody = (over: any = {}) => ({
  v: 1, runId: RUN, task: 'A.1', token: 1, harness: 'codex', phase: 'ended', endState: 'exited', endedAt: '2026-11-08T05:03:00.000Z',
  reportStatus: 'success', readOnly: 'clean', isolation: null, resultOffered: true, withheld: [], quota: null, ...over,
});

const statusBody = (over: any = {}) => ({
  runId: RUN, task: 'A.1', token: 1, harness: 'codex', state: 'running', reason: null, startedAt: '2026-11-08T05:00:01.000Z', endedAt: null,
  overdue: false, supervisorLost: false, attemptActive: true, deadline: '2026-11-08T06:00:00.000Z', childOf: null, process: null, cleanup: null, ...over,
});

const transcriptBody = (over: any = {}) => ({
  v: 1, agentKey: '0123456789abcdef', harness: 'codex', reader: { id: 'codex', status: 'supported' }, transcript: { linked: true, reason: null },
  events: [], cursor: null, ...over,
});

/** Mounts the tabs over scripted routes; a route is a body, a `fail(...)`, a promise, or a function of the call count. */
function mountTabs(routes: Record<string, any>, opts: any = {}) {
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
  const container = new El('div');
  const store = fakeStore();
  const clock = fakeClock();
  const chosen: string[] = [];
  const handle = mod.mountWorkerTabs(container, { apiGet, store, slug: SLUG, run: runRow(), clock, onTab: (tab: string) => chosen.push(tab), ...opts });
  const root = handle.el;
  return {
    handle, root, container, store, clock, calls, chosen,
    panel: root.querySelector('[role="tabpanel"]') as El,
    tablist: root.querySelector('[role="tablist"]') as El,
    tabs: root.querySelectorAll('[role="tab"]') as El[],
    count: (target: string) => calls.filter((c) => c === target).length,
  };
}

const text = (node: any) => node.textContent as string;
const selectedOf = (tabs: El[]) => tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map(text);
/** The `dd` of the facts row whose `dt` is `term`, as text. */
const factOf = (root: El, term: string) => {
  const row = root.querySelectorAll('.facts__row').find((r) => text(r.querySelector('dt')) === term);
  return row ? text(row.querySelector('dd')) : null;
};

const LOG_ROUTES = { [LOG_OUT()]: logPage(), [LOG_ERR()]: logPage({ stream: 'err', pieces: [{ at: 0, text: 'warn' }] }) };
const ALL_ROUTES = {
  ...LOG_ROUTES,
  [`${base()}/transcript`]: transcriptBody(),
  [`${base()}/result`]: resultBody(),
  [`${base()}/status`]: statusBody(),
};

// ---- markup and keyboard ------------------------------------------------------------------------

test('markup: head facts, then a tab list of Log, Transcript, Result and Process, then one tab panel labelled by the selected tab', async () => {
  const t = mountTabs(ALL_ROUTES, { run: runRow({ childOf: 'w-bbbbbbbbbbbb' }) });
  await flush();
  const [head, tablist, panel] = t.root.children;
  assert.equal(tablist, t.tablist);
  assert.equal(panel, t.panel);
  assert.equal(t.tablist.tagName, 'div');
  assert.equal(t.tablist.getAttribute('aria-label'), 'Worker run');
  assert.deepEqual(t.tabs.map(text), ['Log', 'Transcript', 'Result', 'Process']);
  for (const tab of t.tabs) {
    assert.equal(tab.tagName, 'button');
    assert.equal(tab.getAttribute('aria-controls'), t.panel.id);
  }
  assert.deepEqual(t.tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false', 'false', 'false']);
  assert.deepEqual(t.tabs.map((tab) => tab.getAttribute('tabindex')), ['0', '-1', '-1', '-1']);
  assert.equal(t.panel.tagName, 'div');
  assert.equal(t.panel.getAttribute('tabindex'), '0');
  assert.equal(t.panel.getAttribute('aria-labelledby'), t.tabs[0].id);
  assert.equal(t.root.querySelectorAll('[role="tabpanel"]').length, 1);
  // Head: harness, chip, task and token, the granter of a child run, start and end.
  const words = text(head);
  for (const part of ['codex', 'Running', 'A.1', 'token 1', 'Granted by', 'w-bbbbbbbbbbbb', 'Started', 'Ended']) assert.ok(words.includes(part), part);
  assert.equal(head.querySelector('time').getAttribute('datetime'), '2026-11-08T05:00:01.000Z');
  assert.equal(factOf(head, 'Ended'), 'not recorded yet');
  t.handle.destroy();
});

test('keyboard: Left, Right, Home and End move and select (wrapping), focus the tab and report it for the hash', async () => {
  const t = mountTabs(ALL_ROUTES);
  await flush();
  const press = (key: string) => t.tablist.fire('keydown', { key });
  const steps: Array<[string, string]> = [['ArrowRight', 'Transcript'], ['ArrowRight', 'Result'], ['ArrowLeft', 'Transcript'], ['End', 'Process'],
    ['ArrowRight', 'Log'], ['ArrowLeft', 'Process'], ['Home', 'Log']];
  for (const [key, word] of steps) {
    const event = press(key);
    assert.equal(event.defaultPrevented, true, key);
    assert.deepEqual(selectedOf(t.tabs), [word], key);
    const at = t.tabs.findIndex((tab) => text(tab) === word);
    assert.deepEqual(t.tabs.map((tab) => tab.getAttribute('tabindex')), t.tabs.map((_tab, i) => (i === at ? '0' : '-1')), key);
    assert.equal(doc.activeElement, t.tabs[at], key);
    assert.equal(t.panel.getAttribute('aria-labelledby'), t.tabs[at].id, key);
    await flush();
  }
  assert.deepEqual(t.chosen, ['transcript', 'result', 'transcript', 'process', 'log', 'process', 'log']);
  // Up, Down and other keys do nothing here.
  for (const key of ['ArrowDown', 'ArrowUp', 'a', 'Enter']) {
    assert.equal(press(key).defaultPrevented, false, key);
    assert.deepEqual(selectedOf(t.tabs), ['Log'], key);
  }
  // A click selects and reports; the hash moving (update) selects without reporting.
  t.tabs[2].fire('click');
  assert.deepEqual(selectedOf(t.tabs), ['Result']);
  assert.equal(t.chosen.at(-1), 'result');
  const reported = t.chosen.length;
  t.handle.update({ tab: 'process' });
  assert.deepEqual(selectedOf(t.tabs), ['Process']);
  assert.equal(t.chosen.length, reported);
  // The tab the hash names on mount is selected.
  const u = mountTabs(ALL_ROUTES, { tab: 'result' });
  assert.deepEqual(selectedOf(u.tabs), ['Result']);
  assert.deepEqual(u.chosen, []);
  t.handle.destroy();
  u.handle.destroy();
});

test('no document keydown listener, no shortcut entry, no timer and no markup sink in worker-tabs.js', () => {
  assert.doesNotMatch(SOURCE, /document\s*\.\s*addEventListener/);
  assert.doesNotMatch(SOURCE, /SHORTCUTS/);
  assert.doesNotMatch(SOURCE, /\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\b/);
  assert.doesNotMatch(SOURCE, /innerHTML|outerHTML|insertAdjacentHTML|aria-live/);
});

// ---- Log tab ------------------------------------------------------------------------------------

test('Log tab: stdout then stderr, each a pre of text nodes, never a live region, with the masked best-effort sentence', async () => {
  const t = mountTabs({
    [LOG_OUT()]: logPage({ pieces: [{ at: 0, text: '<script>alert(1)</script>' }, { at: 26, text: 'line two' }] }),
    [LOG_ERR()]: logPage({ stream: 'err', pieces: [{ at: 0, text: 'warn' }] }),
  });
  await flush();
  assert.equal(t.panel.dataset.state, 'ready');
  const sections = t.panel.querySelectorAll('section');
  assert.deepEqual(sections.map((s) => s.getAttribute('aria-label')), ['stdout', 'stderr']);
  assert.ok(text(t.panel).includes('Text is masked, best effort: DoFlow’s redactor can miss a secret that has no known shape.'));
  for (const section of sections) {
    const pres = section.querySelectorAll('pre');
    assert.equal(pres.length, 1);
    assert.ok(pres[0].children.length > 0);
    assert.ok(pres[0].children.every((c: any) => c instanceof Txt), 'only text nodes in the pre');
  }
  assert.equal(text(sections[0].querySelector('pre')), '<script>alert(1)</script>\nline two');
  assert.equal(sections[0].querySelector('pre').children.length, 2);
  assert.equal(text(sections[1].querySelector('pre')), 'warn');
  assert.deepEqual(t.store.live(), [`worker:${RUN}:out`, `worker:${RUN}:err`]);
  // Live text is appended as text nodes too, and still nothing announces it.
  t.store.emit(`worker:${RUN}:out`, { kind: 'append', id: '7:40:0:0', state: { from: 35, to: 40, pieces: [{ at: 35, text: 'three' }], phase: 'running', end: null } });
  await flush();
  const pre = sections[0].querySelector('pre');
  assert.equal(text(pre), '<script>alert(1)</script>\nline two\nthree');
  assert.ok(pre.children.every((c: any) => c instanceof Txt));
  for (const node of [t.root, ...nodesOf(t.root)]) {
    if (!(node instanceof El)) continue;
    assert.equal(node.hasAttribute('aria-live'), false, `${node.tagName} is no live region`);
    assert.ok(!['log', 'status', 'alert'].includes(String(node.getAttribute('role'))), `${node.tagName} has no live role`);
  }
  t.handle.destroy();
});

test('Log tab: every per-stream note IC-018 names, with Load earlier and Jump to newest', async () => {
  const cases: Array<[string, any, string]> = [
    ['waiting', { log: 'waiting', ino: null, pieces: [], to: 0 }, 'Waiting for the worker\'s first output.'],
    ['none', { log: 'none', ino: null, pieces: [], to: 0, phase: 'ended' }, 'This run recorded no output on this stream.'],
    ['capped', { phase: 'ended', capped: true }, 'Log capped: the worker wrote more than 4 MiB and later output was not kept.'],
    ['gone', { log: 'gone', ino: null, pieces: [], to: 0, phase: 'ended' }, 'This log was pruned by retention.'],
    ['earlier', { from: 100, pieces: [{ at: 100, text: 'tail' }], to: 105 }, 'Earlier text exists and is not shown.'],
    ['withheld', { pieces: [{ at: 0, text: 'ok' }, { at: 3, text: '', withheld: true }], to: 9 }, 'A line too long to show after masking was left out.'],
  ];
  for (const [notice, over, sentence] of cases) {
    const t = mountTabs({ [LOG_OUT()]: logPage(over), [LOG_ERR()]: logPage({ stream: 'err' }) });
    await flush();
    const out = t.panel.querySelector('section[aria-label="stdout"]');
    const note = out.querySelector(`.logpane__note[data-notice="${notice}"]`);
    assert.ok(note, notice);
    assert.ok(text(note).startsWith(sentence), `${notice}: ${text(note)}`);
    assert.equal(t.panel.querySelector('section[aria-label="stderr"]').querySelector(`[data-notice="${notice}"]`), null, `${notice} is per stream`);
    if (notice === 'earlier') {
      const button = note.querySelector('button');
      assert.equal(text(button), 'Load earlier');
      button.fire('click');
      await flush();
      assert.ok(t.calls.includes(`${LOG_OUT()}&before=${encodeURIComponent('7:100:0:0')}`));
    }
    t.handle.destroy();
  }
  // reset: the channel says the file was replaced.
  const r = mountTabs(LOG_ROUTES);
  await flush();
  r.store.emit(`worker:${RUN}:out`, { kind: 'reset', state: null, code: null });
  await flush();
  const note = r.panel.querySelector('section[aria-label="stdout"]').querySelector('.logpane__note[data-notice="reset"]');
  assert.ok(note, 'reset');
  assert.equal(text(note), 'The log file was replaced; showing its newest page.');
  r.handle.destroy();
});

test('Log tab: Load earlier past the hold bound pauses following; Jump to newest follows again', async () => {
  const bound = 1048576;
  const t = mountTabs({
    [LOG_OUT()]: (n: number) => (n === 1
      ? logPage({ from: 1000000, to: 1100000, size: 1100000, pieces: [{ at: 1000000, text: 'newest' }] })
      : logPage({ from: 1000000, to: 1100001, size: 1100001, pieces: [{ at: 1000000, text: 'newest again' }] })),
    [`${LOG_OUT()}&before=${encodeURIComponent('7:1000000:0:0')}`]: logPage({ from: 0, to: 1000000, size: 1100000, pieces: [{ at: 0, text: 'old' }, { at: 500000, text: 'mid' }] }),
    [LOG_ERR()]: logPage({ stream: 'err' }),
  });
  await flush();
  const out = () => t.panel.querySelector('section[aria-label="stdout"]');
  out().querySelector('[data-notice="earlier"]').querySelector('button').fire('click');
  await flush();
  assert.ok(1100000 > bound);
  const paused = out().querySelector('[data-notice="paused"]');
  assert.ok(paused, 'Following paused shows');
  assert.ok(text(paused).startsWith('Following paused'));
  const jump = paused.querySelector('button');
  assert.equal(text(jump), 'Jump to newest');
  assert.equal(text(out().querySelector('pre')), 'old\nmid');
  jump.fire('click');
  await flush();
  assert.equal(out().querySelector('[data-notice="paused"]'), null);
  assert.equal(text(out().querySelector('pre')), 'newest again');
  t.handle.destroy();
});

test('Log tab states: loading, empty, error (149 copy keys, Try again), run not found, not-in-core, stale', async () => {
  // loading
  const gate = deferred();
  const a = mountTabs({ [LOG_OUT()]: gate.promise, [LOG_ERR()]: gate.promise });
  await flush();
  assert.equal(a.panel.dataset.state, 'loading');
  assert.ok(text(a.panel).includes('Loading stdout'));
  gate.resolve(logPage({ pieces: [], to: 0 }));
  await flush();
  // empty
  assert.equal(a.panel.dataset.state, 'empty');
  assert.ok(text(a.panel).includes('No output on this stream yet.'));
  assert.equal(a.panel.querySelector('pre').getAttribute('hidden'), '');
  // stale
  a.handle.update({ stale: true });
  assert.equal(a.panel.getAttribute('data-stale'), 'true');
  a.handle.update({ stale: false });
  assert.equal(a.panel.hasAttribute('data-stale'), false);
  a.handle.destroy();

  // error: core-error copy, Try again pressed by the person reads again
  const b = mountTabs({ [LOG_OUT()]: (n: number) => (n === 1 ? fail(502, 'core-error') : logPage()), [LOG_ERR()]: logPage({ stream: 'err' }) });
  await flush();
  assert.equal(b.panel.dataset.state, 'error');
  const out = b.panel.querySelector('section[aria-label="stdout"]');
  assert.equal(out.dataset.state, 'error');
  assert.equal(text(out.querySelector('.state-panel__title')), 'Could not load the stdout log');
  assert.ok(text(out).includes('DoFlow returned an error while reading this data.'));
  assert.equal(out.querySelector('.countdown'), null, 'nothing counts down to a timed retry');
  const again = out.querySelectorAll('button').find((button) => text(button) === 'Try again');
  assert.ok(again);
  again!.fire('click');
  await flush();
  assert.equal(b.count(LOG_OUT()), 2);
  assert.equal(b.panel.dataset.state, 'ready');
  b.handle.destroy();

  // 404 unknown-run: the run-not-found copy
  const c = mountTabs({ [LOG_OUT()]: fail(404, 'unknown-run'), [LOG_ERR()]: fail(404, 'unknown-run') });
  await flush();
  assert.equal(c.panel.dataset.state, 'error');
  assert.equal(text(c.panel.querySelector('.state-panel__title')), 'This run is not in the record');
  c.handle.destroy();

  // 501 core-lacks-verb: the older-core sentence, no stream region
  const d = mountTabs({ [LOG_OUT()]: fail(501, 'core-lacks-verb'), [LOG_ERR()]: fail(501, 'core-lacks-verb') });
  await flush();
  assert.equal(d.panel.dataset.state, 'not-in-core');
  assert.equal(text(d.panel), 'This DoFlow core does not provide worker logs.');
  assert.equal(d.panel.querySelectorAll('section').length, 0);
  d.handle.destroy();
});

test('Log tab: another tab closes both streams; another run opens its own; destroy closes and drops late answers', async () => {
  const late = deferred();
  const t = mountTabs({ ...ALL_ROUTES, [LOG_OUT(RUN2)]: late.promise, [LOG_ERR(RUN2)]: logPage({ stream: 'err' }) });
  await flush();
  assert.equal(t.store.live().length, 2);
  t.tabs[3].fire('click');
  await flush();
  assert.deepEqual(t.store.live(), []);
  t.tabs[0].fire('click');
  await flush();
  assert.equal(t.store.live().length, 2);
  t.handle.update({ run: runRow({ runId: RUN2 }) });
  await flush();
  assert.ok(t.calls.includes(LOG_OUT(RUN2)));
  assert.deepEqual(t.store.live(), [`worker:${RUN2}:err`]);
  t.handle.destroy();
  assert.deepEqual(t.store.live(), []);
  assert.equal(t.container.children.length, 0);
  late.resolve(logPage());
  await flush();
  assert.deepEqual(t.store.live(), []);
});

// ---- Result tab ---------------------------------------------------------------------------------

test('Result tab: the table holds exactly the 11 withheld codes, one distinct sentence each', () => {
  assert.deepEqual(Object.keys(mod.WITHHELD_SENTENCES).sort(), [...CLOSED_SETS.withheldCodes].sort());
  assert.equal(CLOSED_SETS.withheldCodes.length, 11);
  const sentences = Object.values(mod.WITHHELD_SENTENCES) as string[];
  assert.equal(new Set(sentences).size, 11);
  for (const sentence of sentences) assert.match(sentence, /^[A-Z].+\.$/);
});

test('Result tab: every withheld code shows its sentence under "Result withheld"', async () => {
  for (const code of CLOSED_SETS.withheldCodes) {
    const t = mountTabs({ [`${base()}/result`]: resultBody({ resultOffered: false, withheld: [code], reportStatus: 'failure' }) }, { tab: 'result' });
    await flush();
    assert.equal(t.panel.dataset.state, 'ready', code);
    assert.ok(text(t.panel).trim().startsWith('Result withheld'), code);
    const items = t.panel.querySelectorAll('li');
    assert.equal(items.length, 1, code);
    assert.equal(items[0].dataset.code, code);
    assert.equal(text(items[0]), mod.WITHHELD_SENTENCES[code], code);
    t.handle.destroy();
  }
  const all = mountTabs({ [`${base()}/result`]: resultBody({ resultOffered: false, withheld: [...CLOSED_SETS.withheldCodes] }) }, { tab: 'result' });
  await flush();
  assert.deepEqual(all.panel.querySelectorAll('li').map(text), CLOSED_SETS.withheldCodes.map((code: string) => mod.WITHHELD_SENTENCES[code]));
  all.handle.destroy();
});

test('Result tab: offered, then report status, check with its reason, and quota stop, in that order', async () => {
  const t = mountTabs({ [`${base()}/result`]: resultBody({ reportStatus: 'success', readOnly: 'clean' }) }, { tab: 'result' });
  await flush();
  const [verdict, facts] = t.panel.children;
  assert.equal(text(verdict).trim(), 'Result offered');
  assert.deepEqual(facts.querySelectorAll('dt').map(text), ['Ended', 'Report', 'Read-only check', 'Quota stop']);
  assert.equal(factOf(t.panel, 'Report'), 'success');
  assert.equal(factOf(t.panel, 'Read-only check'), 'clean');
  assert.equal(factOf(t.panel, 'Quota stop'), 'none');
  assert.ok(factOf(t.panel, 'Ended')!.startsWith('exited'));
  t.handle.destroy();

  const u = mountTabs({ [`${base()}/result`]: resultBody({
    readOnly: null, isolation: { status: 'violated', reason: 'branch-moved' }, reportStatus: 'failure', resultOffered: false,
    withheld: ['branch-moved', 'report-quota'], quota: { signal: 'rate-limit', basis: 'exit-text' },
  }) }, { tab: 'result', run: runRow({ edit: true, phase: 'ended', endState: 'exited' }) });
  await flush();
  const kids = u.panel.children.map((c: any) => c.tagName);
  assert.deepEqual(kids, ['p', 'ul', 'dl']);
  assert.ok(text(u.panel.children[0]).includes('Result withheld'));
  assert.equal(factOf(u.panel, 'Report'), 'failure');
  assert.equal(factOf(u.panel, 'Isolation check'), 'violated: the attempt branch moved');
  assert.equal(factOf(u.panel, 'Quota stop'), 'signal rate-limit, basis exit-text');
  u.handle.destroy();
});

test('Result tab: while the phase is not ended, the verdict and every end field read "not recorded yet"', async () => {
  for (const phase of ['starting', 'running', 'cancelling']) {
    const t = mountTabs({ [`${base()}/result`]: resultBody({ phase, endState: null, endedAt: null, reportStatus: null, readOnly: null, resultOffered: false, withheld: ['not-exited', 'read-only-unverifiable', 'report-unparsed'] }) }, { tab: 'result' });
    await flush();
    const words = text(t.panel);
    assert.ok(words.includes('Result: not recorded yet'), phase);
    assert.ok(!words.includes('Result withheld') && !words.includes('Result offered'), phase);
    assert.equal(t.panel.querySelectorAll('li').length, 0, phase);
    for (const term of ['Ended', 'Report', 'Read-only check', 'Quota stop']) assert.equal(factOf(t.panel, term), 'not recorded yet', `${phase} ${term}`);
    t.handle.destroy();
  }
});

test('Result tab states: loading, error, run not found, not-in-core, the live member, stale', async () => {
  const gate = deferred();
  const a = mountTabs({ [`${base()}/result`]: gate.promise }, { tab: 'result' });
  await flush();
  assert.equal(a.panel.dataset.state, 'loading');
  assert.ok(text(a.panel).includes('Loading the result'));
  a.handle.update({ stale: true });
  assert.equal(a.panel.getAttribute('data-stale'), 'true');
  gate.resolve(resultBody());
  await flush();
  assert.equal(a.panel.dataset.state, 'ready');
  assert.equal(a.panel.getAttribute('data-stale'), 'true', 'stale holds across a redraw');
  a.handle.destroy();

  const b = mountTabs({ [`${base()}/result`]: (n: number) => (n === 1 ? fail(502, 'core-error') : resultBody()) }, { tab: 'result' });
  await flush();
  assert.equal(b.panel.dataset.state, 'error');
  assert.equal(text(b.panel.querySelector('.state-panel__title')), 'Could not load the result');
  b.panel.querySelectorAll('button').find((button) => text(button) === 'Try again')!.fire('click');
  await flush();
  assert.equal(b.count(`${base()}/result`), 2);
  assert.equal(b.panel.dataset.state, 'ready');
  b.handle.destroy();

  const c = mountTabs({ [`${base()}/result`]: fail(404, 'unknown-run') }, { tab: 'result' });
  await flush();
  assert.equal(text(c.panel.querySelector('.state-panel__title')), 'This run is not in the record');
  c.handle.destroy();

  const d = mountTabs({ [`${base()}/result`]: fail(501, 'core-lacks-verb') }, { tab: 'result' });
  await flush();
  assert.equal(d.panel.dataset.state, 'not-in-core');
  assert.equal(text(d.panel), 'This DoFlow core does not provide worker results.');
  d.handle.destroy();

  // A member given before the tab is shown replaces the GET; a later member replaces what is held.
  const e = mountTabs(LOG_ROUTES);
  e.handle.update({ result: { status: 200, body: resultBody({ phase: 'running', endState: null, endedAt: null, resultOffered: false, withheld: ['not-exited'], reportStatus: null, readOnly: null }) } });
  e.tabs[2].fire('click');
  await flush();
  assert.equal(e.count(`${base()}/result`), 0);
  assert.ok(text(e.panel).includes('Result: not recorded yet'));
  e.handle.update({ result: { status: 200, body: resultBody() } });
  assert.ok(text(e.panel).includes('Result offered'));
  e.handle.update({ result: { status: 501, body: { error: { code: 'core-lacks-verb' } } } });
  assert.equal(e.panel.dataset.state, 'not-in-core');
  e.handle.destroy();
});

// ---- Process tab --------------------------------------------------------------------------------

test('Process tab: state, start, deadline, exit, group-alive, leftover and cleanup in words; no pid or group number', async () => {
  const planted = statusBody({
    state: 'exited', endedAt: '2026-11-08T05:03:00.000Z', attemptActive: false, pid: 424242, pgid: 434343,
    process: { kind: 'exited', code: 3, signal: null, at: '2026-11-08T05:03:00.000Z', reason: null, groupAlive: true, leftover: { status: 'survivors', reason: 'kill-timeout' }, pid: 424242, pgid: 434343, start: 99887766 },
    cleanup: { status: 'verified', reason: null },
  });
  const t = mountTabs({ [`${base()}/status`]: planted }, { tab: 'process' });
  await flush();
  assert.equal(t.panel.dataset.state, 'ready');
  const words = text(t.panel);
  assert.ok(words.startsWith('Exited'));
  assert.equal(factOf(t.panel, 'Exit'), 'exit code 3');
  assert.equal(factOf(t.panel, 'Process group'), 'the process group was still running after the exit');
  assert.equal(factOf(t.panel, 'Leftover'), 'survivors: processes were left (kill-timeout)');
  assert.equal(factOf(t.panel, 'Cancel cleanup'), 'verified: no process was left');
  assert.equal(factOf(t.panel, 'Overdue'), 'no');
  assert.ok(t.panel.querySelectorAll('time').some((el) => el.getAttribute('datetime') === '2026-11-08T06:00:00.000Z'), 'the deadline');
  for (const number of ['424242', '434343', '99887766']) assert.ok(!words.includes(number), `no ${number}`);
  assert.doesNotMatch(words, /\bpid\b|pgid/i);
  t.handle.destroy();

  const rows: Array<[any, string, string]> = [
    [{ kind: 'exited', code: null, signal: 'SIGTERM', at: null, reason: null, groupAlive: false, leftover: { status: 'verified', reason: null } }, 'signal SIGTERM', 'the process group was gone'],
    [{ kind: 'exited', code: 0, signal: null, at: null, reason: null, groupAlive: 'unknown', leftover: null }, 'exit code 0', 'unknown'],
  ];
  for (const [proc, exit, group] of rows) {
    const u = mountTabs({ [`${base()}/status`]: statusBody({ state: 'exited', process: proc }) }, { tab: 'process' });
    await flush();
    assert.equal(factOf(u.panel, 'Exit'), exit);
    assert.equal(factOf(u.panel, 'Process group'), group);
    u.handle.destroy();
  }
  const v = mountTabs({ [`${base()}/status`]: statusBody({ state: 'exited', process: { kind: 'not-started', code: null, signal: null, at: null, reason: 'spawn-failed', groupAlive: null, leftover: null } }) }, { tab: 'process' });
  await flush();
  assert.equal(factOf(v.panel, 'Exit'), 'not started: spawn-failed');
  assert.equal(factOf(v.panel, 'Process group'), null);
  v.handle.destroy();
});

test('Process tab: running, overdue and supervisor lost; liveness reads unknown on win32 and the tab says so', async () => {
  const t = mountTabs({ [`${base()}/status`]: statusBody({ overdue: true }) }, { tab: 'process' });
  await flush();
  assert.ok(text(t.panel).startsWith('Running'));
  assert.equal(factOf(t.panel, 'Overdue'), 'yes, past the deadline');
  assert.equal(factOf(t.panel, 'Exit'), 'not recorded yet');
  assert.equal(factOf(t.panel, 'Liveness'), 'process seen');
  assert.ok(!text(t.panel).includes('Windows'));
  t.handle.destroy();

  const u = mountTabs({ [`${base()}/status`]: statusBody({ state: 'unknown', reason: 'supervisor-lost', supervisorLost: true }) }, { tab: 'process' });
  await flush();
  assert.ok(text(u.panel).includes('The supervisor process is gone, so DoFlow did not see the run finish.'));
  assert.ok(text(u.panel).includes('Supervisor lost'));
  u.handle.destroy();

  for (const body of [statusBody(), statusBody({ state: 'unknown', reason: 'liveness-unknown' })]) {
    const w = mountTabs({ [`${base()}/status`]: body }, { tab: 'process', platform: 'win32' });
    await flush();
    assert.equal(factOf(w.panel, 'Liveness'), 'unknown');
    assert.ok(text(w.panel).includes('Liveness is unknown on Windows: DoFlow cannot check processes there.'));
    w.handle.destroy();
  }
});

test('Process tab states: loading, empty, error, run not found, the live member, not-in-core, stale', async () => {
  const gate = deferred();
  const a = mountTabs({ [`${base()}/status`]: gate.promise }, { tab: 'process' });
  await flush();
  assert.equal(a.panel.dataset.state, 'loading');
  assert.ok(text(a.panel).includes('Loading the process status'));
  gate.resolve(null);
  await flush();
  assert.equal(a.panel.dataset.state, 'empty');
  assert.equal(text(a.panel), 'The core holds no status for this worker run.');
  a.handle.update({ stale: true });
  assert.equal(a.panel.getAttribute('data-stale'), 'true');
  a.handle.destroy();

  const b = mountTabs({ [`${base()}/status`]: fail(502, 'core-contract-mismatch') }, { tab: 'process' });
  await flush();
  assert.equal(b.panel.dataset.state, 'error');
  assert.equal(text(b.panel.querySelector('.state-panel__title')), 'Could not read the process status');
  b.handle.destroy();

  const c = mountTabs({ [`${base()}/status`]: fail(404, 'unknown-run') }, { tab: 'process' });
  await flush();
  assert.equal(text(c.panel.querySelector('.state-panel__title')), 'This run is not in the record');
  c.handle.destroy();

  const d = mountTabs(LOG_ROUTES);
  d.handle.update({ worker: { status: 200, body: statusBody({ state: 'timed-out', process: { kind: 'exited', code: null, signal: 'SIGKILL', at: null, reason: null, groupAlive: false, leftover: null } }) } });
  d.tabs[3].fire('click');
  await flush();
  assert.equal(d.count(`${base()}/status`), 0);
  assert.ok(text(d.panel).startsWith('Timed out'));
  assert.ok(text(d.root.children[0]).includes('Timed out'), 'the member drives the head chip');
  d.handle.destroy();

  // An older core without `worker --action status --worker-run`: the old-core marker answers 501 core-lacks-verb (plan RK2).
  const e = mountTabs({ [`${base()}/status`]: fail(501, 'core-lacks-verb') }, { tab: 'process' });
  await flush();
  assert.equal(e.panel.dataset.state, 'not-in-core');
  assert.equal(text(e.panel), 'This DoFlow core does not provide worker process status.');
  e.handle.destroy();

  const f = mountTabs(LOG_ROUTES);
  f.handle.update({ worker: { status: 501, body: { error: { code: 'core-lacks-verb' } } } });
  f.tabs[3].fire('click');
  await flush();
  assert.equal(f.count(`${base()}/status`), 0);
  assert.equal(f.panel.dataset.state, 'not-in-core');
  assert.equal(text(f.panel), 'This DoFlow core does not provide worker process status.');
  f.handle.destroy();
});

// ---- Transcript tab -----------------------------------------------------------------------------

test('Transcript tab: exactly one GET per run, the first time it is shown, and none on a timer', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const routes = { ...ALL_ROUTES, [`${base(RUN2)}/transcript`]: transcriptBody(), [LOG_OUT(RUN2)]: logPage(), [LOG_ERR(RUN2)]: logPage({ stream: 'err' }) };
    const t = mountTabs(routes);
    await flush();
    assert.equal(t.count(`${base()}/transcript`), 0, 'not read before it is shown');
    t.tabs[1].fire('click');
    await flush();
    assert.equal(t.count(`${base()}/transcript`), 1);
    t.tabs[0].fire('click');
    await flush();
    t.tabs[1].fire('click');
    await flush();
    mock.timers.tick(10 * 60 * 1000);
    await flush();
    assert.equal(t.count(`${base()}/transcript`), 1);
    assert.equal(t.clock.timers.length, 0, 'no log stream timer either');
    t.handle.update({ run: runRow({ runId: RUN2 }) });
    await flush();
    assert.equal(t.count(`${base(RUN2)}/transcript`), 1);
    t.handle.update({ run: runRow() });
    await flush();
    mock.timers.tick(10 * 60 * 1000);
    await flush();
    assert.equal(t.count(`${base()}/transcript`), 1);
    assert.equal(t.count(`${base(RUN2)}/transcript`), 1);
    t.handle.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('Transcript tab: events as the Fleet panel shows them, with the masked sentence', async () => {
  const events = [
    { seq: 1, at: '2026-11-08T05:00:02.000Z', kind: 'reply', agentKey: '0123456789abcdef', model: 'gpt-5', tool: null, text: 'I will read <b>it</b>', args: null, cut: false, tokens: null, record: null },
    { seq: 2, at: '2026-11-08T05:00:03.000Z', kind: 'tool-call', agentKey: '0123456789abcdef', model: null, tool: { name: 'shell', callKey: 'aaaaaaaaaaaaaaaa', status: null, bytes: null, durationMs: null }, text: null, args: 'ls', cut: false, tokens: null, record: null },
    { seq: 3, at: '2026-11-08T05:00:04.000Z', kind: 'tool-result', agentKey: '0123456789abcdef', model: null, tool: { name: 'shell', callKey: 'aaaaaaaaaaaaaaaa', status: 'ok', bytes: 10, durationMs: 5 }, text: null, args: null, cut: false, tokens: null, record: null },
  ];
  const t = mountTabs({ [`${base()}/transcript`]: transcriptBody({ events }) }, { tab: 'transcript' });
  await flush();
  assert.equal(t.panel.dataset.state, 'ready');
  const rows = t.panel.querySelectorAll('li');
  assert.equal(rows.length, 2, 'the result is attached to its call');
  assert.ok(text(rows[0]).includes('I will read <b>it</b>'));
  assert.ok(text(rows[1]).includes('shell'));
  assert.ok(text(rows[1].querySelector('.ev__result')).startsWith('ok'));
  assert.ok(text(t.panel).includes('Text is masked, best effort'));
  t.handle.destroy();
});

test('Transcript tab: the reason sentence from the panel\'s copy, and agent-not-in-project', async () => {
  const cases: Array<[any, string, string]> = [
    [{ transcript: { linked: false, reason: 'not-found' } }, 'not-found', 'Transcript not found.'],
    [{ transcript: { linked: false, reason: 'not-linked' } }, 'not-linked', 'DoFlow could not match this session to a codex transcript file.'],
    [{ transcript: { linked: false, reason: 'no-reader' } }, 'no-reader', 'No transcript reader for codex.'],
    [{ reader: { id: null, status: 'events-only' } }, 'no-reader', 'No transcript reader for codex.'],
    [{ reader: { id: null, status: 'events-only' }, transcript: { linked: false, reason: 'not-found' } }, 'not-found', 'Transcript not found.'],
  ];
  for (const [over, kind, words] of cases) {
    const t = mountTabs({ [`${base()}/transcript`]: transcriptBody(over) }, { tab: 'transcript' });
    await flush();
    const banners = t.panel.querySelectorAll('.fbanner');
    assert.equal(banners.length, 1, kind);
    assert.equal(banners[0].dataset.kind, kind);
    assert.ok(text(banners[0]).includes(words), words);
    t.handle.destroy();
  }
  const gone = mountTabs({ [`${base()}/transcript`]: fail(404, 'agent-not-in-project') }, { tab: 'transcript' });
  await flush();
  assert.equal(text(gone.panel), 'The core did not include this worker run in its read.');
  assert.equal(gone.panel.dataset.state, 'empty');
  gone.handle.destroy();
});

test('Transcript tab states: loading, empty, error with Try again, not-in-core, stale', async () => {
  const gate = deferred();
  const a = mountTabs({ [`${base()}/transcript`]: gate.promise }, { tab: 'transcript' });
  await flush();
  assert.equal(a.panel.dataset.state, 'loading');
  assert.ok(text(a.panel).includes('Loading the transcript'));
  gate.resolve(transcriptBody());
  await flush();
  assert.equal(a.panel.dataset.state, 'empty');
  assert.ok(text(a.panel).includes('No reply or tool call is recorded for this worker run yet.'));
  a.handle.update({ stale: true });
  assert.equal(a.panel.getAttribute('data-stale'), 'true');
  a.handle.destroy();

  const b = mountTabs({ [`${base()}/transcript`]: (n: number) => (n === 1 ? fail(502, 'core-error') : transcriptBody()) }, { tab: 'transcript' });
  await flush();
  assert.equal(b.panel.dataset.state, 'error');
  assert.equal(text(b.panel.querySelector('.state-panel__title')), 'Could not load the transcript');
  b.panel.querySelectorAll('button').find((button) => text(button) === 'Try again')!.fire('click');
  await flush();
  assert.equal(b.count(`${base()}/transcript`), 2);
  assert.equal(b.panel.dataset.state, 'empty');
  b.handle.destroy();

  // Defensive: every supported core has the transcript read, but IC-018 names not-in-core for every tab.
  const c = mountTabs({ [`${base()}/transcript`]: fail(501, 'core-lacks-verb') }, { tab: 'transcript' });
  await flush();
  assert.equal(c.panel.dataset.state, 'not-in-core');
  assert.equal(text(c.panel), 'This DoFlow core does not provide transcripts.');
  c.handle.destroy();
});

// ---- every tab ----------------------------------------------------------------------------------

test('every tab builds text nodes only and has no live region', async () => {
  const t = mountTabs({
    ...ALL_ROUTES,
    [`${base()}/result`]: resultBody({ resultOffered: false, withheld: [...CLOSED_SETS.withheldCodes] }),
    [`${base()}/status`]: statusBody({ state: 'exited', process: { kind: 'exited', code: 1, signal: null, at: null, reason: null, groupAlive: true, leftover: null } }),
  });
  for (const tab of t.tabs) {
    tab.fire('click');
    await flush();
    for (const node of nodesOf(t.root)) {
      assert.ok(node instanceof El || node instanceof Txt, 'an element or a text node');
      if (node instanceof El) assert.equal(node.hasAttribute('aria-live'), false, `${text(tab)}: ${node.tagName}`);
    }
  }
  t.handle.destroy();
});
