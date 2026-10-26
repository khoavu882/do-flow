'use strict';

// The client shell's core (feature 093, plan task D.2; IC-003, IC-005, IC-007; design note D.2.md). The web
// modules are ES modules in a CommonJS package, so they are copied to a temp directory beside a
// {"type":"module"} marker and imported from there. A small fake DOM records what the code does:
//   - dom.js: a tree with a <script>-looking text renders text only; style and on* are refused;
//   - the announcer, the poller (pause on hidden, 5/10/30 s backoff, stale after 3 misses), classify;
//   - views.js: the shapes are on the verb allow-list, CORE_RANGE equals the manifest's doflowCore, routes;
//   - app.js end to end: theme first, the fragment code exchanged once and removed, the router moves focus
//     to the new heading, the five global states, the stale banner.

const { test, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SHAPE_IDS } = require('../src/verb-runner.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const CODE = '0123456789abcdef'.repeat(4);

// ---- loading the modules ------------------------------------------------------------------------

let copy: string;
let mods: any;
const url = (name: string, query = '') => `${pathToFileURL(path.join(copy, name)).href}${query}`;

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-client-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  mods = {
    dom: await import(url('dom.js')),
    poll: await import(url('poll.js')),
    states: await import(url('states.js')),
    views: await import(url('views.js')),
  };
});
after(() => { fs.rmSync(copy, { recursive: true, force: true }); });

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
  for (const m of selector.matchAll(/\.([\w-]+)/g)) out.classes.push(m[1]);
  for (const m of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) out.attrs.push([m[1], m[2] ?? null]);
  const id = /#([\w-]+)/.exec(selector);
  if (id) out.attrs.push(['id', id[1]]);
  return out;
}

class El {
  parent: any = null;
  children: any[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Function[]>();
  dataset: any;
  classList: any;
  tagName: string;
  doc: any;
  ns: string | null;
  constructor(tagName: string, doc: any, ns: string | null = null) {
    this.tagName = tagName;
    this.doc = doc;
    this.ns = ns;
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
        if (on) this.classList.add(name); else this.classList.remove(name);
        return on;
      },
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
  contains(node: any): boolean { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Function) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  fire(type: string, extra: any = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  focus() { this.doc.activeElement = this; this.doc.focusLog.push(this); }
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

/** Every element and text node of the tree under `node`, tags only for elements. */
function tags(node: any): string[] {
  return node.children.flatMap((c: any) => (c instanceof El ? [c.tagName.toLowerCase(), ...tags(c)] : []));
}

const GLOBALS = ['document', 'location', 'history', 'localStorage', 'fetch', 'navigator', 'scrollTo', 'requestAnimationFrame', 'addEventListener', 'getSelection', 'Node'];
let saved: Map<string, PropertyDescriptor | undefined> | null = null;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

type Reply = { ok: boolean, status: number, json(): Promise<any> };
const reply = (status: number, body: any = null): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === null) throw new Error('no body'); return body; } });
const errorReply = (status: number, code: string): Reply => reply(status, { error: { code, verb: null, exit: null } });

const INFO = { v: 1, core: { version: '2.0.0-beta.7', inRange: true }, capabilities: [] };
const row = (state: string, taskId = 'run-1') => ({ taskId, featureSlug: 'feat-a', taskClass: 'feature', state, revision: 1, updatedAt: null });
const RUNS = { v: 1, runs: [row('AWAITING_GATE', 'r1'), row('RUNNING', 'r2'), row('RUNNING', 'r3'), row('COMPLETED', 'r4'), row('REJECTED', 'r5')], unreadableCount: 2 };

type Call = { url: string, method: string, body: any, theme: string | undefined, hash: string };
type Page = {
  doc: any, win: any, calls: Call[], store: Map<string, string>, history: string[], scrolls: Array<[number, number]>, location: any,
  region: El, main: El, conn: El, slot: El, nav: El[], radios: El[], skip: El,
};

/** The page of index.html as the shell finds it, a fake window around it, and a scripted fetch. */
function installPage(opts: { hash?: string, stored?: string | null, throwStorage?: boolean, fetch: (url: string, init: any) => Reply | Promise<Reply> | 'network' }): Page {
  saved = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const doc: any = { activeElement: null, focusLog: [], hidden: false, title: '', listeners: new Map<string, Function[]>() };
  const el = (tag: string, attrs: Record<string, string> = {}, children: any[] = []) => {
    const node = new El(tag, doc);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    node.append(...children);
    return node;
  };
  const html = el('html', { class: 'booting' });
  const body = el('body');
  const link = (href: string, text: string) => el('a', { class: 'nav__link', href }, [text]);
  const radio = (choice: string) => el('button', { type: 'button', role: 'radio', class: 'theme__opt', 'aria-checked': 'false', tabindex: '-1', 'data-theme-choice': choice }, [el('span', { class: 'theme__label' }, [choice])]);
  const skip = el('a', { class: 'skip', href: '#main' }, ['Skip to content']);
  const nav = [link('#/', 'Runs'), link('#/workflows', 'Workflows')];
  const radios = ['light', 'dark', 'system'].map(radio);
  const conn = el('p', { class: 'conn', id: 'conn', 'data-state': 'unknown' }, [el('span', { class: 'conn__long' }, ['Connecting']), el('span', { class: 'conn__short' }, ['Connecting'])]);
  const region = el('div', { class: 'vh', id: 'announcer' });
  const main = el('main', { id: 'main', class: 'page', tabindex: '-1' });
  const slot = el('div', { id: 'banner-slot' });
  body.append(skip,
    el('header', { class: 'site-header' }, [el('a', { class: 'brand', href: '#/' }, [el('span', { class: 'brand__name' }, ['DoFlow'])]),
      el('nav', {}, [el('ul', {}, nav.map((a) => el('li', {}, [a])))]), conn, el('p', { id: 'core-version' }),
      el('div', { class: 'theme' }, radios)]),
    slot, main, region);
  html.append(body);
  Object.assign(doc, {
    documentElement: html, body, activeElement: body,
    createElement: (tag: string) => new El(tag, doc),
    createElementNS: (ns: string, tag: string) => new El(tag, doc, ns),
    createTextNode: (text: string) => new Txt(text),
    getElementById: (id: string) => html.querySelector(`#${id}`),
    querySelector: (sel: string) => html.querySelector(sel),
    querySelectorAll: (sel: string) => html.querySelectorAll(sel),
    addEventListener: (type: string, fn: Function) => doc.listeners.set(type, [...(doc.listeners.get(type) ?? []), fn]),
    removeEventListener: (type: string, fn: Function) => doc.listeners.set(type, (doc.listeners.get(type) ?? []).filter((f: Function) => f !== fn)),
  });

  const location: any = { hash: opts.hash ?? '', pathname: '/', search: '', reload() { page.reloads += 1; } };
  const store = new Map<string, string>();
  if (opts.stored) store.set('doflow-console-theme', opts.stored);
  const winListeners = new Map<string, Function[]>();
  const history: string[] = [];
  const calls: Call[] = [];
  const scrolls: Array<[number, number]> = [];
  const page: any = { doc, calls, store, history, scrolls, location, region, main, conn, slot, nav, radios, skip, reloads: 0 };
  page.win = { dispatch: (type: string) => { for (const fn of winListeners.get(type) ?? []) fn({ type }); } };

  setGlobal('document', doc);
  setGlobal('location', location);
  setGlobal('history', { replaceState: (_s: unknown, _t: string, target: string) => { history.push(target); const i = target.indexOf('#'); location.hash = i === -1 ? '' : target.slice(i); } });
  setGlobal('localStorage', {
    getItem: (k: string) => { if (opts.throwStorage) throw new Error('blocked'); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (opts.throwStorage) throw new Error('blocked'); store.set(k, v); },
  });
  setGlobal('navigator', { platform: 'Linux', clipboard: undefined });
  setGlobal('scrollTo', (x: number, y: number) => scrolls.push([x, y]));
  setGlobal('requestAnimationFrame', (fn: () => void) => globalThis.setTimeout(fn, 0));
  setGlobal('addEventListener', (type: string, fn: Function) => winListeners.set(type, [...(winListeners.get(type) ?? []), fn]));
  setGlobal('getSelection', () => ({ removeAllRanges() {}, addRange() {} }));
  setGlobal('fetch', async (target: string, init: any = {}) => {
    calls.push({ url: target, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, theme: html.dataset.theme, hash: location.hash });
    const result = await opts.fetch(target, init);
    if (result === 'network') throw new TypeError('network');
    return result;
  });
  return page;
}

function uninstallPage() {
  if (!saved) return;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as any)[name];
  }
  saved = null;
}

let epoch = 1_700_000_000_000;
let imports = 0;
async function settle() { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); }
async function advance(ms: number) {
  for (let done = 0; done < ms; done += 100) {
    mock.timers.tick(Math.min(100, ms - done));
    await settle();
  }
}

/** Installs the page, mock time, imports a fresh app.js (which boots at import) and lets the boot settle. */
async function start(opts: Parameters<typeof installPage>[0]): Promise<Page> {
  epoch += 10_000_000;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: epoch });
  const page = installPage(opts);
  imports += 1;
  await import(url('app.js', `?run=${imports}`));
  await settle();
  return page;
}
afterEach(() => { mock.timers.reset(); uninstallPage(); });

const text = (node: any) => node.textContent as string;
const heading = (page: Page) => page.main.querySelector('h1');
const current = (page: Page) => page.nav.filter((a) => a.getAttribute('aria-current') === 'page').map(text);
const apiCalls = (page: Page, prefix: string) => page.calls.filter((c) => c.url.startsWith(prefix));
const standard = (target: string, init: any): Reply => {
  if (target === '/api/session') return reply(204);
  if (target === '/api/info') return reply(200, INFO);
  if (target === '/api/runs') return reply(200, RUNS);
  return errorReply(404, 'not-found');
};

// ---- dom.js --------------------------------------------------------------------------------------

test('mount: a tree with a <script>-looking text renders text only', () => {
  const page = installPage({ fetch: () => reply(204) });
  const { h, mount } = mods.dom;
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const target = page.doc.createElement('div');
  mount(target, h('p', { class: 'note' }, [hostile, h('b', {}, hostile)]));
  assert.deepEqual(tags(target), ['p', 'b']);
  assert.equal(text(target), hostile + hostile);
  assert.ok(!tags(target).includes('script') && !tags(target).includes('img'));
  uninstallPage();
});

test('h refuses a style attribute, an on* handler and a javascript-style href; icon sets only its five attributes', () => {
  const page = installPage({ fetch: () => reply(204) });
  const { h, icon } = mods.dom;
  assert.throws(() => h('div', { style: 'color: red' }), /not allowed/);
  assert.throws(() => h('div', { onclick: 'x()' }), /not allowed/);
  assert.throws(() => h('a', { href: 'data:text/html,x' }), /fragment or a same-origin/);
  assert.equal(h('a', { href: '#/' }, 'go').getAttribute('href'), '#/');
  const svg = icon('copy', 16);
  assert.deepEqual([...svg.attrs.keys()].sort(), ['aria-hidden', 'class', 'focusable', 'viewBox']);
  assert.deepEqual(svg.children.map((p: El) => [...p.attrs.keys()].sort()), [['d'], ['d']]);
  assert.throws(() => icon('nope'), /unknown/);
  uninstallPage();
});

test('announcer: identical text within 2 s is dropped, a burst is coalesced to its last message, one message per 2 s', () => {
  let now = 1000;
  const timers: Array<{ at: number, fn: () => void }> = [];
  const written: string[] = [];
  const announcer = mods.dom.createAnnouncer({
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimer: (t: any) => timers.splice(timers.indexOf(t), 1),
    write: (v: string) => { if (v !== '') written.push(v); },
  });
  const run = (to: number) => { now = to; for (const t of timers.filter((x) => x.at <= to)) { timers.splice(timers.indexOf(t), 1); t.fn(); } };
  announcer.announce('A');
  assert.deepEqual(written, ['A']);
  now = 1500; announcer.announce('A');
  run(3200);
  assert.deepEqual(written, ['A'], 'identical within 2 s: dropped, and nothing is spoken later either');
  now = 3300; announcer.announce('B');
  assert.deepEqual(written, ['A', 'B'], 'a message after a quiet 2 s is spoken at once');
  now = 3400; announcer.announce('C');
  now = 3500; announcer.announce('D');
  assert.deepEqual(written, ['A', 'B'], 'nothing before the 2 s gap');
  run(5400);
  assert.deepEqual(written, ['A', 'B', 'D'], 'the burst is coalesced to its last message');
  now = 5600; announcer.announce('E');
  run(7500);
  assert.deepEqual(written, ['A', 'B', 'D', 'E']);
  now = 9600; announcer.announce('E');
  assert.deepEqual(written, ['A', 'B', 'D', 'E', 'E'], 'the same text is allowed again after 2 s');
});

// ---- poll.js -------------------------------------------------------------------------------------

function fakeClock() {
  const clock: any = {
    time: 0, timers: [] as Array<{ at: number, fn: () => void, id: number }>, id: 0,
    now: () => clock.time,
    setTimeout: (fn: () => void, ms: number) => { clock.id += 1; clock.timers.push({ at: clock.time + ms, fn, id: clock.id }); return clock.id; },
    clearTimeout: (id: number) => { clock.timers = clock.timers.filter((t: any) => t.id !== id); },
    async advance(ms: number) {
      const end = clock.time + ms;
      await clock.flush();
      for (;;) {
        const due = clock.timers.filter((t: any) => t.at <= end).sort((a: any, b: any) => a.at - b.at)[0];
        if (!due) break;
        clock.timers = clock.timers.filter((t: any) => t !== due);
        clock.time = due.at;
        due.fn();
        await clock.flush();
      }
      clock.time = end;
    },
    async flush() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); },
  };
  return clock;
}

function poller(script: Array<'ok' | 'fail'>, extra: any = {}) {
  const clock = fakeClock();
  let hidden = false;
  let listener: () => void = () => {};
  const fetched: number[] = [];
  const instance = mods.poll.createPoller({
    clock,
    visibility: { hidden: () => hidden, subscribe: (fn: () => void) => { listener = fn; return () => {}; } },
    intervalMs: 5000,
    fetchOnce: () => {
      fetched.push(clock.time);
      return (script.shift() ?? 'ok') === 'ok' ? Promise.resolve({ n: fetched.length }) : Promise.reject({ status: null, network: true });
    },
    ...extra,
  });
  return { instance, clock, fetched, setHidden(value: boolean) { hidden = value; listener(); } };
}

test('poller: failures back off 5, 10, 30, 30 s; a success returns to the interval', async () => {
  const p = poller(['fail', 'fail', 'fail', 'fail', 'ok', 'ok']);
  p.instance.start();
  await p.clock.advance(200_000);
  assert.deepEqual(p.fetched.slice(0, 7), [0, 5000, 15000, 45000, 75000, 80000, 85000]);
});

test('poller: it pauses while the tab is hidden and polls at once on return', async () => {
  const p = poller([]);
  p.instance.start();
  await p.clock.advance(1);
  assert.deepEqual(p.fetched, [0]);
  p.setHidden(true);
  await p.clock.advance(60_000);
  assert.deepEqual(p.fetched, [0], 'no fetch while hidden');
  p.setHidden(false);
  await p.clock.advance(1);
  assert.equal(p.fetched.length, 2, 'one fetch on return');
  assert.equal(p.fetched[1], 60_001);
});

test('poller: a fetch that settles while the tab is hidden schedules nothing', async () => {
  const clock = fakeClock();
  let hidden = false;
  let listener: () => void = () => {};
  let release: (v: any) => void = () => {};
  let calls = 0;
  const instance = mods.poll.createPoller({
    clock,
    visibility: { hidden: () => hidden, subscribe: (fn: () => void) => { listener = fn; return () => {}; } },
    intervalMs: 5000,
    fetchOnce: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); },
  });
  instance.start();
  hidden = true; listener();
  release(1);
  await clock.advance(60_000);
  assert.equal(calls, 1, 'the success arrived while hidden: no timer');
  assert.equal(instance.nextAt, null);
});

test('poller: three misses in a row make the data stale even when the last success is recent', async () => {
  const p = poller(['ok', 'fail', 'fail', 'fail']);
  p.instance.start();
  await p.clock.advance(5001);
  assert.equal(p.instance.misses, 1);
  p.instance.refreshNow();
  await p.clock.advance(1);
  p.instance.refreshNow();
  await p.clock.advance(1);
  assert.equal(p.instance.misses, 3);
  assert.ok(p.clock.time - p.instance.lastSuccessAt < 15_000, 'the last success is under 15 s old');
  assert.equal(p.instance.isStale(), true);
});

test('poller: stale after 3 misses in a row, or when the last success is older than 15 s', async () => {
  const misses = poller(['ok', 'fail', 'fail', 'fail']);
  misses.instance.start();
  await misses.clock.advance(1);
  assert.equal(misses.instance.isStale(), false);
  await misses.clock.advance(5000);
  assert.equal(misses.instance.misses, 1);
  await misses.clock.advance(5000);
  assert.equal(misses.instance.misses, 2);
  assert.equal(misses.instance.isStale(), false, 'two misses, 10 s: not yet');
  await misses.clock.advance(10_000); // third miss at 20 s, and older than 15 s
  assert.equal(misses.instance.misses, 3);
  assert.equal(misses.instance.isStale(), true);

  const age = poller(['ok']);
  age.instance.start();
  await age.clock.advance(1);
  const never = age.instance;
  assert.equal(never.isStale(), false);
  // a poll that never settles keeps the success at t=0: the age alone makes it stale
  let release: () => void = () => {};
  const slow = poller(['ok'], { fetchOnce: (() => { let n = 0; return () => (n++ === 0 ? Promise.resolve(1) : new Promise((r) => { release = () => r(2); })); })() });
  slow.instance.start();
  await slow.clock.advance(5001);
  await slow.clock.advance(10_000);
  assert.equal(slow.instance.misses, 0);
  assert.equal(slow.instance.isStale(), true, '15.001 s since the last success');
  release();
});

test('poller: stale is not evaluated while hidden, nor until the poll after a return settles', async () => {
  const clock = fakeClock();
  let hidden = false;
  let listener: () => void = () => {};
  let release: (v: any) => void = () => {};
  let calls = 0;
  const instance = mods.poll.createPoller({
    clock,
    visibility: { hidden: () => hidden, subscribe: (fn: () => void) => { listener = fn; return () => {}; } },
    intervalMs: 5000,
    fetchOnce: () => (calls++ === 0 ? Promise.resolve(1) : new Promise((resolve) => { release = resolve; })),
  });
  instance.start();
  await clock.advance(1);
  hidden = true; listener();
  await clock.advance(120_000);
  assert.equal(instance.isStale(), false, 'hidden: not evaluated');
  hidden = false; listener();
  await clock.advance(1);
  assert.equal(instance.isStale(), false, 'the poll after the return is in flight: not evaluated');
  release(2);
  await clock.advance(1);
  assert.equal(instance.isStale(), false, 'fresh after it settled');
});

test('poller: refreshNow restarts the backoff; retry=false ends polling; stop ignores a late result', async () => {
  const p = poller(['fail', 'fail', 'fail']);
  p.instance.start();
  await p.clock.advance(5000 + 10_000 + 1);
  assert.deepEqual(p.fetched, [0, 5000, 15000]);
  p.instance.refreshNow();
  await p.clock.advance(1);
  assert.equal(p.fetched.length, 4, 'refreshNow fetches at once');
  await p.clock.advance(5000);
  assert.equal(p.fetched.length, 5, 'and the next failure waits 5 s again, not 30 s');

  const ends = poller(['fail'], { retry: () => false });
  ends.instance.start();
  await ends.clock.advance(100_000);
  assert.equal(ends.fetched.length, 1);

  const late = mods.poll.createPoller({
    clock: fakeClock(), visibility: { hidden: () => false, subscribe: () => () => {} }, intervalMs: 1,
    fetchOnce: () => new Promise((resolve) => setTimeout(resolve, 0)), onSuccess: () => { throw new Error('late result delivered'); },
  });
  late.start();
  late.stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
});

// ---- states.js: classify ---------------------------------------------------------------------------

test('classify sorts every IC-005 outcome into the rows of the error table (6.6)', () => {
  const { classify, ERROR_COPY } = mods.states;
  const c = (status: number | null, code: string | null, ctx: any = {}) => classify({ status, code, network: status === null }, ctx);
  const key = (...args: [number | null, string | null, any?]) => c(...args).key;
  assert.equal(key(401, 'unauthenticated', { exchange: 'used' }), 'session-used');
  assert.equal(key(401, 'unauthenticated', { exchange: 'none', sessionWorked: false }), 'session-unauth');
  assert.equal(key(401, 'unauthenticated', { exchange: 'ok', sessionWorked: true }), 'session-ended');
  assert.equal(key(403, 'forbidden-origin'), 'forbidden-origin');
  assert.equal(key(null, null), 'offline');
  assert.equal(key(503, 'core-unreachable'), 'runtime-missing');
  assert.equal(key(503, 'core-version'), 'runtime-range');
  assert.equal(key(502, 'core-error'), 'core-error');
  assert.equal(key(500, null), 'core-error');
  assert.equal(key(502, 'core-contract-mismatch'), 'contract-mismatch');
  assert.equal(key(502, 'cannot-list-checkouts'), 'cannot-list');
  assert.equal(key(404, 'run-not-found'), 'run-not-found');
  assert.equal(key(404, 'not-found'), 'not-found');
  for (const [status, code] of [[400, 'usage'], [415, 'unsupported-media'], [421, null], [405, null]] as const) assert.equal(key(status, code), 'refused');
  assert.deepEqual(['core-error', 'contract-mismatch', 'cannot-list', 'offline', 'runtime-missing'].map((k) => c(k === 'offline' ? null : k === 'runtime-missing' ? 503 : 502, k === 'contract-mismatch' ? 'core-contract-mismatch' : k === 'cannot-list' ? 'cannot-list-checkouts' : k === 'runtime-missing' ? 'core-unreachable' : k === 'core-error' ? 'core-error' : null).auto), [true, true, true, true, true]);
  assert.equal(c(404, 'run-not-found').auto, false);
  assert.equal(c(401, null).scope, 'session');
  for (const k of ['session-used', 'session-unauth', 'session-ended', 'forbidden-origin', 'offline', 'core-error', 'contract-mismatch', 'cannot-list', 'run-not-found', 'not-found', 'refused']) {
    assert.ok(ERROR_COPY[k], `copy for ${k}`);
  }
});

// ---- views.js ------------------------------------------------------------------------------------

test('views: every shape id a view reads is on the verb allow-list (IC-003)', () => {
  assert.ok(mods.views.SHAPES_USED.length >= 4);
  for (const shape of mods.views.SHAPES_USED) assert.ok(SHAPE_IDS.includes(shape), `${shape} is on the allow-list`);
  const control = ['list', 'indicators'];
  assert.ok(control.some((shape) => !SHAPE_IDS.includes(shape)), 'control: a shape off the list is detected');
});

test('views: CORE_RANGE equals console/package.json doflowCore, and the check goes red when one side changes', () => {
  assert.equal(mods.views.CORE_RANGE, MANIFEST.doflowCore);
  const source = fs.readFileSync(path.join(WEB_ROOT, 'views.js'), 'utf8');
  const literal = (text: string) => /const CORE_RANGE = '([^']+)';/.exec(text)?.[1];
  assert.equal(literal(source), MANIFEST.doflowCore);
  assert.notEqual(literal(source.replace('<3.0.0', '<4.0.0')), MANIFEST.doflowCore, 'control: a changed literal differs from the manifest');
  assert.notEqual(mods.views.CORE_RANGE, MANIFEST.doflowCore.replace('beta.7', 'beta.8'), 'control: a changed manifest differs from the literal');
});

test('views: the router table maps hashes to views, and a bad parameter is not-found before any fetch', () => {
  const { parseRoute, titleFor, navFor, VIEWS } = mods.views;
  const id = (hash: string) => parseRoute(hash).id;
  assert.equal(id(''), 'runs');
  assert.equal(id('#'), 'runs');
  assert.equal(id('#/'), 'runs');
  assert.equal(id('#/workflows'), 'workflows');
  assert.equal(id('#/run/feat-a/run-1'), 'run');
  assert.deepEqual(parseRoute('#/run/feat-a/run-1').params, { slug: 'feat-a', taskId: 'run-1' });
  assert.equal(id('#/run/feat-a/run-1/tasks'), 'tasks');
  for (const bad of ['#/nope', '#/run/-x/y', '#/run/x/.y', '#/run/a%2Fb/c', '#/run/a', '#/run/a/b/c/d', '#/run/a/b/files', '#/workflows/', '#main', '#c=1']) {
    assert.equal(id(bad), 'not-found', bad);
  }
  assert.equal(titleFor(parseRoute('#/')), 'Runs \u00b7 DoFlow Console');
  assert.equal(titleFor(parseRoute('#/'), { runs: [row('AWAITING_GATE'), row('AWAITING_GATE'), row('RUNNING')], unreadableCount: 0 }), '(2) Runs \u00b7 DoFlow Console');
  assert.equal(titleFor(parseRoute('#/workflows')), 'Workflows \u00b7 DoFlow Console');
  assert.equal(titleFor(parseRoute('#/run/s/t')), 's / t \u00b7 DoFlow Console');
  assert.equal(titleFor(parseRoute('#/run/s/t/tasks')), 'Tasks \u00b7 s / t \u00b7 DoFlow Console');
  assert.equal(titleFor(parseRoute('#/x')), 'Not found \u00b7 DoFlow Console');
  assert.equal(navFor(parseRoute('#/run/s/t/tasks')), 'runs');
  assert.equal(navFor(parseRoute('#/workflows')), 'workflows');
  assert.equal(navFor(parseRoute('#/x')), null);
  assert.deepEqual(Object.keys(VIEWS).sort(), ['not-found', 'run', 'runs', 'tasks', 'workflows']);
});

test('index.html provides the elements the shell needs', () => {
  const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  for (const id of ['main', 'conn', 'core-version', 'banner-slot', 'announcer']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-live="polite"/);
  assert.deepEqual([...html.matchAll(/class="nav__link" href="([^"]+)"/g)].map((m) => m[1]), ['#/', '#/workflows']);
  assert.deepEqual([...html.matchAll(/data-theme-choice="([^"]+)"/g)].map((m) => m[1]), ['light', 'dark', 'system']);
  assert.match(html, /<html lang="en" class="booting">/);
  assert.match(html, /<main id="main" class="page" tabindex="-1">/);
});

// ---- app.js: boot --------------------------------------------------------------------------------

test('boot: the stored theme is applied before anything is fetched, and the fragment code is exchanged once and removed first', async () => {
  const page = await start({ hash: `#c=${CODE}`, stored: 'dark', fetch: standard });
  const [first, ...rest] = page.calls;
  assert.equal(first.url, '/api/session');
  assert.equal(first.method, 'POST');
  assert.deepEqual(first.body, { code: CODE });
  assert.equal(first.theme, 'dark', 'theme applied before the first call');
  assert.equal(first.hash, '#/', 'the code was already out of the address bar when the exchange went out');
  assert.deepEqual(page.history, ['/#/']);
  assert.ok(!JSON.stringify(page.history).includes(CODE));
  assert.equal(page.calls.filter((c) => c.method === 'POST').length, 1, 'exchanged once');
  assert.ok(rest.every((c) => c.method === 'GET' && !JSON.stringify(c).includes(CODE)));
  assert.equal(page.doc.documentElement.classList.contains('booting'), false);
  assert.equal(page.doc.documentElement.dataset.theme, 'dark');
  assert.equal(text(heading(page)), 'Runs');
  assert.equal(page.doc.activeElement, page.doc.body, 'first load does not move focus');
  assert.equal(page.doc.focusLog.length, 0);
  assert.deepEqual(current(page), ['Runs']);
  assert.equal(text(page.doc.getElementById('core-version')), 'core 2.0.0-beta.7');
  assert.deepEqual(page.radios.map((r) => r.getAttribute('aria-checked')), ['false', 'true', 'false']);
  assert.deepEqual(page.radios.map((r) => r.getAttribute('tabindex')), ['-1', '0', '-1']);
});

test('boot: a launch code that was already used shows the used page, removes the code anyway, and polls nothing', async () => {
  const page = await start({ hash: `#c=${CODE}`, fetch: (target) => (target === '/api/session' ? errorReply(401, 'unauthenticated') : errorReply(401, 'unauthenticated')) });
  assert.deepEqual(page.history, ['/#/']);
  assert.equal(page.location.hash, '#/');
  assert.equal(text(heading(page)), 'This link has already been used');
  assert.equal(page.main.querySelector('.cmd__text') && text(page.main.querySelector('.cmd__text')), 'doflow ui');
  assert.equal(page.doc.activeElement, heading(page), 'a full page replacing #main with focus on the body takes the heading');
  assert.equal(page.conn.getAttribute('data-state'), 'failed');
  await advance(30_000);
  assert.equal(apiCalls(page, '/api/runs').length, 0, 'no data polling after a session error');
});

test('boot: blocked storage still renders, as System', async () => {
  const page = await start({ hash: '', throwStorage: true, fetch: standard });
  assert.equal(page.doc.documentElement.dataset.theme, undefined);
  assert.equal(page.doc.documentElement.classList.contains('booting'), false);
  assert.equal(text(heading(page)), 'Runs');
  assert.deepEqual(page.radios.map((r) => r.getAttribute('aria-checked')), ['false', 'false', 'true']);
  page.radios[0].fire('click');
  assert.equal(page.doc.documentElement.dataset.theme, 'light', 'the choice still applies for this page load');
});

test('theme control: arrows move and select with wrapping, Home and End jump, and the choice is stored', async () => {
  const page = await start({ hash: '', fetch: standard });
  const [light, dark, system] = page.radios;
  system.fire('keydown', { key: 'ArrowRight' });
  assert.equal(page.doc.activeElement, light, 'wraps to the first');
  assert.equal(page.doc.documentElement.dataset.theme, 'light');
  assert.equal(page.store.get('doflow-console-theme'), 'light');
  light.fire('keydown', { key: 'ArrowDown' });
  assert.equal(page.doc.documentElement.dataset.theme, 'dark');
  dark.fire('keydown', { key: 'End' });
  assert.equal(page.doc.documentElement.dataset.theme, undefined, 'System removes the attribute');
  assert.equal(page.store.get('doflow-console-theme'), 'system');
  system.fire('keydown', { key: 'Home' });
  assert.equal(page.doc.activeElement, light);
  light.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(page.doc.activeElement, system, 'wraps to the last');
  assert.deepEqual(page.radios.map((r) => r.getAttribute('tabindex')), ['-1', '-1', '0']);
  assert.ok(page.doc.documentElement.classList.contains('theme-switching'));
  await advance(100);
  assert.ok(!page.doc.documentElement.classList.contains('theme-switching'), 'transitions are back after two frames');
});

// ---- app.js: the router ----------------------------------------------------------------------------

test('router: a route change sets the title and the current link, and moves focus to the new heading; first load did not', async () => {
  const page = await start({ hash: '', fetch: (target, init) => (target === '/api/runs/feat-a/run-1' ? reply(200, { v: 1, run: { ...row('RUNNING'), updatedAt: new Date(Date.now() - 12_000).toISOString() }, timeline: {}, tasks: null, workflow: {} }) : standard(target, init)) });
  assert.equal(page.doc.activeElement, page.doc.body);
  assert.equal(page.doc.title, '(1) Runs \u00b7 DoFlow Console');

  page.location.hash = '#/run/feat-a/run-1';
  page.win.dispatch('hashchange');
  assert.equal(text(heading(page)), 'feat-a / run-1', 'the head is drawn synchronously');
  assert.equal(page.doc.activeElement, heading(page));
  assert.equal(page.doc.title, 'feat-a / run-1 \u00b7 DoFlow Console');
  assert.deepEqual(current(page), ['Runs']);
  assert.deepEqual(page.scrolls.at(-1), [0, 0]);
  await settle();
  assert.equal(page.doc.activeElement, heading(page), 'a poll update does not move focus');
  assert.match(text(page.main), /Running/);
  assert.match(text(page.main), /revision 1/);
  assert.match(text(page.main), /12 s ago/);

  page.location.hash = '#/workflows';
  page.win.dispatch('hashchange');
  assert.equal(text(heading(page)), 'Workflows');
  assert.equal(page.doc.activeElement, heading(page));
  assert.deepEqual(current(page), ['Workflows']);

  page.location.hash = '#/run/-bad/x';
  const before = page.calls.length;
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(text(heading(page)), 'Not found');
  assert.match(text(page.main), /This page does not exist/);
  assert.deepEqual(current(page), []);
  assert.equal(page.calls.slice(before).filter((c) => c.url.startsWith('/api/runs')).length, 0, 'no fetch for an invalid parameter');
});

test('run head: the meta line holds one element per item, so no two texts merge into one flex item', async () => {
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1'
    ? reply(200, { v: 1, run: { ...row('RUNNING'), revision: 5, updatedAt: null }, timeline: {}, tasks: null, workflow: {} }) : standard(target, init)) });
  const meta = page.main.querySelector('.view-head__meta');
  assert.ok(meta);
  assert.deepEqual(meta.children.map((c: any) => c instanceof El), [true, true, true, true], 'no bare text node among the items');
  assert.deepEqual(meta.children.map((c: any) => text(c)), ['feature', 'Running', 'revision 5', 'Update time unknown']);
  assert.ok(meta.children[1].classList.contains('badge'));
});

test('router: the old view stops polling when the route changes', async () => {
  const page = await start({ hash: '', fetch: standard });
  const runsBefore = apiCalls(page, '/api/runs').length;
  page.location.hash = '#/workflows';
  page.win.dispatch('hashchange');
  await advance(30_000);
  assert.equal(apiCalls(page, '/api/runs').length, runsBefore, 'the Runs poller is gone');
  assert.ok(apiCalls(page, '/api/info').length >= 4, 'the connection heartbeat stands in for a view with no data');
});

test('router: the skip link moves focus to the heading without changing the route', async () => {
  const page = await start({ hash: '', fetch: standard });
  const event = page.skip.fire('click');
  assert.equal(event.defaultPrevented, true);
  assert.equal(page.doc.activeElement, heading(page));
  assert.equal(page.location.hash, '', 'the hash is untouched');
});

// ---- app.js: the global states ---------------------------------------------------------------------

test('loaded: the home summary counts the runs by state and flags what needs you', async () => {
  const page = await start({ hash: '', fetch: standard });
  const tiles = page.main.querySelectorAll('.tile');
  assert.deepEqual(tiles.map((t) => text(t.querySelector('.tile__label'))), ['Needs you', 'Running', 'Finished']);
  assert.deepEqual(tiles.map((t) => text(t.querySelector('.tile__count'))), ['1', '2', '2']);
  assert.equal(tiles[0].getAttribute('data-attention'), 'true');
  assert.equal(tiles[1].getAttribute('data-attention'), null);
  assert.match(text(page.main), /2 runs could not be read\./);
  assert.equal(page.doc.title, '(1) Runs \u00b7 DoFlow Console');
  assert.equal(page.conn.getAttribute('data-state'), 'done');
  assert.match(text(page.conn.querySelector('.conn__long')), /^Updated just now$/);
});

test('empty: no runs shows the panel with the command block; a poll with the same body repaints nothing', async () => {
  const page = await start({ hash: '', fetch: (target, init) => (target === '/api/runs' ? reply(200, { v: 1, runs: [], unreadableCount: 0 }) : standard(target, init)) });
  assert.equal(text(page.main.querySelector('.empty__title')), 'No runs yet');
  assert.equal(text(page.main.querySelector('.cmd__text')), '/do <describe the change you want>');
  assert.match(text(page.main.querySelector('.empty__note')), /refresh every 5 seconds/);
  const panel = page.main.querySelector('.empty');
  await advance(11_000);
  assert.equal(page.main.querySelector('.empty'), panel, 'the same panel node: unchanged data is not repainted');
});

test('loading: nothing for 300 ms, then the skeleton, held for 300 ms before the data replaces it', async () => {
  let release: (r: Reply) => void = () => {};
  const page = await start({ hash: '', fetch: (target, init) => (target === '/api/runs' ? new Promise<Reply>((resolve) => { release = resolve; }) : standard(target, init)) });
  assert.equal(text(heading(page)), 'Runs', 'the heading is real text at once');
  assert.equal(page.main.getAttribute('aria-busy'), 'true');
  assert.match(text(page.main), /Loading runs/);
  assert.equal(page.main.querySelectorAll('.skel').length, 0);
  await advance(200);
  assert.equal(page.main.querySelectorAll('.skel').length, 0, 'not before 300 ms');
  await advance(100);
  assert.equal(page.main.querySelectorAll('.skel').length > 0, true, 'at 300 ms');
  assert.ok(page.main.querySelectorAll('.skel').every((s) => s.getAttribute('aria-hidden') === 'true'));
  release(reply(200, RUNS));
  await advance(100);
  assert.equal(page.main.querySelectorAll('.skel').length > 0, true, 'held for 300 ms after it appeared');
  await advance(300);
  assert.equal(page.main.querySelectorAll('.skel').length, 0);
  assert.equal(page.main.querySelectorAll('.tile').length, 3);
  assert.equal(page.main.getAttribute('aria-busy'), null);
});

test('error: an inline error keeps the heading, shows no server text, retries on the backoff and recovers', async () => {
  let mode = 'error';
  const page = await start({
    hash: '',
    fetch: (target, init) => (target === '/api/runs' ? (mode === 'error' ? reply(502, { error: { code: 'core-error', verb: 'list', exit: 1, message: 'SERVER SECRET <b>x</b>' } }) : reply(200, RUNS)) : standard(target, init)),
  });
  assert.equal(text(heading(page)), 'Runs');
  assert.equal(text(page.main.querySelector('.state-panel__title')), 'Could not load runs');
  assert.equal(text(page.main.querySelector('.code-chip')), 'core-error \u00b7 502');
  assert.ok(!text(page.main).includes('SERVER SECRET'));
  assert.match(text(page.main.querySelector('.countdown')), /^Trying again in [45] s$/);
  assert.equal(page.doc.activeElement, page.doc.body, 'entering an error does not steal focus');
  await settle();
  assert.match(text(page.region), /^Could not load runs\. Trying again in \d s\.$/);
  assert.equal(page.conn.getAttribute('data-state'), 'unknown');
  assert.equal(text(page.conn.querySelector('.conn__long')), 'Retrying');
  mode = 'ok';
  await advance(5000);
  assert.equal(page.main.querySelectorAll('.state-panel').length, 0);
  assert.equal(page.main.querySelectorAll('.tile').length, 3);
});

test('error: run-not-found is final (no retry), names the way back, and the heartbeat keeps the pill honest', async () => {
  const page = await start({ hash: '#/run/feat-a/nope', fetch: (target, init) => (target === '/api/runs/feat-a/nope' ? errorReply(404, 'run-not-found') : standard(target, init)) });
  assert.equal(text(heading(page)), 'feat-a / nope');
  assert.equal(text(page.main.querySelector('.state-panel__title')), 'This run is not in the record');
  assert.equal(page.main.querySelector('.countdown'), null);
  assert.equal(page.main.querySelector('a.btn').getAttribute('href'), '#/');
  await advance(20_000);
  assert.equal(apiCalls(page, '/api/runs/feat-a/nope').length, 1, 'not retried');
  assert.equal(page.conn.getAttribute('data-state'), 'done');
});

test('no-runtime: a full page with the facts and the command; /api/info is retried until the core returns', async () => {
  let up = false;
  const page = await start({ hash: '', fetch: (target, init) => (target === '/api/info' ? (up ? reply(200, INFO) : errorReply(503, 'core-unreachable')) : standard(target, init)) });
  assert.equal(text(page.main.querySelector('.eyebrow')), 'No runtime');
  assert.equal(text(heading(page)), 'DoFlow is not reachable');
  assert.deepEqual(page.main.querySelectorAll('.facts__row').map((r) => [text(r.querySelector('dt')), text(r.querySelector('dd'))]), [['Needs', 'doflow core >=2.0.0-beta.7 <3.0.0'], ['Found', 'nothing']]);
  assert.equal(text(page.main.querySelector('.cmd__text')), 'npm install -g @khoavu882/doflow');
  assert.equal(page.conn.getAttribute('data-state'), 'failed');
  assert.equal(text(page.conn.querySelector('.conn__long')), 'Core unreachable');
  assert.match(text(page.main.querySelector('.countdown')), /^Checking again in [45] s$/);
  const heading1 = heading(page);
  page.location.hash = '#/workflows';
  page.win.dispatch('hashchange');
  assert.equal(text(page.main.querySelector('.eyebrow')), 'No runtime', 'every route shows the same full page');
  assert.equal(page.doc.activeElement, heading(page));
  assert.ok(heading1);
  up = true;
  await advance(5000);
  assert.equal(page.main.querySelector('.eyebrow'), null);
  assert.equal(text(heading(page)), 'Workflows');
  assert.equal(text(page.region), 'DoFlow is reachable again.');
});

test('no-runtime: a core outside the range shows the out-of-range variant with the version found', async () => {
  const page = await start({ hash: '', fetch: (target, init) => (target === '/api/info' ? reply(200, { v: 1, core: { version: '1.9.0', inRange: false }, capabilities: [] }) : standard(target, init)) });
  assert.equal(text(heading(page)), 'This DoFlow version does not fit the Console');
  assert.deepEqual(page.main.querySelectorAll('.facts__row').map((r) => text(r.querySelector('dd'))), ['doflow core >=2.0.0-beta.7 <3.0.0', '1.9.0']);
  assert.equal(text(page.main.querySelector('.cmd__text')), 'doflow --version');
});

const runReply = () => reply(200, { v: 1, run: { ...row('RUNNING'), updatedAt: new Date(Date.now()).toISOString() }, timeline: {}, tasks: null, workflow: {} });

test('stale: after 15 s of failures the data stays, a banner appears, times read absolute; it clears when polling works again', async () => {
  let down = false;
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1' ? (down ? errorReply(502, 'core-error') : runReply()) : standard(target, init)) });
  assert.equal(page.slot.querySelectorAll('.banner').length, 0);
  assert.equal(page.conn.getAttribute('data-state'), 'done');
  assert.ok(page.main.querySelector('.reltime__abs'), 'the absolute time is there for the stale case');
  down = true;
  await advance(8000); // misses at 3 s and 8 s: "Retrying", the data is still there
  assert.equal(text(page.conn.querySelector('.conn__long')), 'Retrying');
  assert.match(text(page.main), /Running/);
  assert.equal(page.slot.querySelectorAll('.banner').length, 0);
  await advance(9000); // 17 s since the last success
  const banner = page.slot.querySelector('.banner');
  assert.ok(banner, 'the stale banner is shown');
  assert.match(text(banner), /^Not updated since \d\d:\d\d:\d\d \(\d+ s ago\)\. DoFlow returned an error\.Try now$/);
  assert.equal(page.main.getAttribute('data-stale'), 'true');
  assert.equal(page.conn.getAttribute('data-state'), 'stale');
  assert.equal(text(page.conn.querySelector('.conn__short')), 'Stale');
  assert.match(text(page.conn.querySelector('.conn__long')), /^Stale \u00b7 \d\d:\d\d:\d\d$/);
  assert.match(text(page.main), /Running/, 'the data is not removed');
  assert.match(text(page.region), /^Data is out of date\. Last updated \d\d:\d\d:\d\d\.$/);
  down = false;
  banner.querySelector('button').fire('click');
  await advance(100);
  assert.ok(banner.classList.contains('banner--leaving'), 'the banner fades out');
  await advance(300);
  assert.equal(page.slot.querySelectorAll('.banner').length, 0, 'then it is removed');
  assert.equal(page.main.getAttribute('data-stale'), null);
  assert.match(text(page.region), /^Data is out of date/, 'one message per 2 s: the second is held');
  await advance(2000);
  assert.equal(text(page.region), 'Up to date again.');
  assert.equal(page.conn.getAttribute('data-state'), 'done');
});

test('offline: with data on screen the pill reads Retrying, then Offline once stale, and the banner names the server', async () => {
  let down = false;
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1' ? (down ? 'network' : runReply()) : standard(target, init)) });
  down = true;
  await advance(4000);
  assert.equal(text(page.conn.querySelector('.conn__long')), 'Retrying');
  assert.match(text(page.main), /Running/, 'a failure after data never removes it');
  await advance(14_000);
  assert.equal(text(page.conn.querySelector('.conn__long')), 'Offline');
  assert.match(text(page.slot.querySelector('.banner')), /The Console server is not answering\./);
  assert.match(text(page.main), /Running/);
});

test('offline: with no data at all it is a full page that says the Console has stopped', async () => {
  const page = await start({ hash: '', fetch: (target, init) => (target === '/api/info' || target === '/api/runs' ? 'network' : standard(target, init)) });
  assert.equal(text(heading(page)), 'The Console has stopped');
  assert.equal(text(page.main.querySelector('.cmd__text')), 'doflow ui');
  assert.equal(text(page.conn.querySelector('.conn__long')), 'Offline');
  assert.match(text(page.main.querySelector('.countdown')), /^Checking again in [45] s$/);
});

test('hidden tab: polling and the stale check pause, and nothing flashes stale on return', async () => {
  const page = await start({ hash: '', fetch: standard });
  const before = apiCalls(page, '/api/runs').length;
  page.doc.hidden = true;
  for (const fn of page.doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' });
  await advance(120_000);
  assert.equal(apiCalls(page, '/api/runs').length, before, 'no polling while hidden');
  assert.equal(page.slot.querySelectorAll('.banner').length, 0, 'no stale banner while hidden');
  page.doc.hidden = false;
  for (const fn of page.doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' });
  assert.equal(page.slot.querySelectorAll('.banner').length, 0, 'not on the way back either');
  await settle();
  assert.equal(apiCalls(page, '/api/runs').length, before + 1, 'one poll at once on return');
  assert.equal(page.slot.querySelectorAll('.banner').length, 0);
});

test('safety: hostile strings from the API reach the page as text only', async () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1'
    ? reply(200, { v: 1, run: { ...row('RUNNING'), taskClass: hostile, updatedAt: null }, timeline: {}, tasks: null, workflow: {} }) : standard(target, init)) });
  assert.match(text(page.main), /<img src=x onerror=alert\(1\)><script>alert\(2\)<\/script>/);
  assert.ok(!tags(page.main).includes('img') && !tags(page.main).includes('script'));
});
