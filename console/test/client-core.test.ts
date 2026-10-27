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
    stream: await import(url('stream.js')),
    fleet: await import(url('derive/fleet.js')),
    derive: await import(url('derive/rail.js')),
    home: await import(url('views/home.js')),
    railView: await import(url('views/rail.js')),
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
  // Classes are read outside [attr="value"] brackets: a value such as card:B.1 holds a dot that is no class.
  for (const m of selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)) out.classes.push(m[1]);
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
  /** `style` records custom properties only: the code under test may call nothing else on it (IC-007). */
  style = { vars: new Map<string, string>(), setProperty(name: string, value: string) { this.vars.set(name, String(value)); }, getPropertyValue(name: string) { return this.vars.get(name) ?? ''; } };
  dataset: any;
  classList: any;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  offsetHeight = 0;
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
  insertBefore(node: any, ref: any) {
    this.adopt(node);
    const at = ref === null || ref === undefined ? -1 : this.children.indexOf(ref);
    if (at === -1) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  }
  querySelectorAll(selector: string): El[] {
    // A comma list (outside [attr] brackets) is a union in document order.
    const list = selector.split(/,(?![^[]*\])/).map((part) => compound(part.trim()));
    const out: El[] = [];
    const walk = (node: any) => {
      for (const child of node.children) {
        if (child instanceof El) {
          if (list.some((c) => child.matches(c))) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string) {
    const c = compound(selector);
    for (let n: any = this; n; n = n.parent) if (n instanceof El && n.matches(c)) return n;
    return null;
  }
}

/** Every element and text node of the tree under `node`, tags only for elements. */
function tags(node: any): string[] {
  return node.children.flatMap((c: any) => (c instanceof El ? [c.tagName.toLowerCase(), ...tags(c)] : []));
}

const GLOBALS = ['document', 'location', 'history', 'localStorage', 'fetch', 'navigator', 'scrollTo', 'requestAnimationFrame', 'addEventListener', 'getSelection', 'Node', 'EventSource'];
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
  region: El, main: El, conn: El, slot: El, nav: El[], radios: El[], skip: El, pause: El,
};

/** The page of index.html as the shell finds it, a fake window around it, and a scripted fetch. */
function installPage(opts: { hash?: string, stored?: string | null, throwStorage?: boolean, eventSource?: unknown, fetch: (url: string, init: any) => Reply | Promise<Reply> | 'network' }): Page {
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
  const nav = [link('#/', 'Runs'), link('#/workflows', 'Workflows'), link('#/sessions', 'Sessions'), link('#/fleet', 'Fleet')]; // E.7 and V.10: the fake page mirrors index.html's links
  const radios = ['light', 'dark', 'system'].map(radio);
  const conn = el('p', { class: 'conn', id: 'conn', 'data-state': 'unknown' }, [el('span', { class: 'conn__long' }, ['Connecting']), el('span', { class: 'conn__short' }, ['Connecting'])]);
  const pause = el('button', { type: 'button', class: 'btn btn--ghost pause', id: 'pause', 'aria-pressed': 'false', hidden: '' }, [el('span', { class: 'pause__label' }, ['Pause updates'])]);
  const region = el('div', { class: 'vh', id: 'announcer' });
  const main = el('main', { id: 'main', class: 'page', tabindex: '-1' });
  const slot = el('div', { id: 'banner-slot' });
  body.append(skip,
    el('header', { class: 'site-header' }, [el('a', { class: 'brand', href: '#/' }, [el('span', { class: 'brand__name' }, ['DoFlow'])]),
      el('nav', {}, [el('ul', {}, nav.map((a) => el('li', {}, [a])))]), conn, pause, el('p', { id: 'core-version' }),
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
  const page: any = { doc, calls, store, history, scrolls, location, region, main, conn, slot, nav, radios, skip, pause, reloads: 0 };
  page.win = { dispatch: (type: string) => { for (const fn of winListeners.get(type) ?? []) fn({ type }); } };

  setGlobal('document', doc);
  setGlobal('location', location);
  setGlobal('history', { replaceState: (_s: unknown, _t: string, target: string) => { history.push(target); const i = target.indexOf('#'); location.hash = i === -1 ? '' : target.slice(i); } });
  setGlobal('localStorage', {
    getItem: (k: string) => { if (opts.throwStorage) throw new Error('blocked'); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (opts.throwStorage) throw new Error('blocked'); store.set(k, v); },
  });
  setGlobal('navigator', { platform: 'Linux', clipboard: undefined });
  if ('eventSource' in opts) setGlobal('EventSource', opts.eventSource); // V.10: a fake stream, or none
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
async function start(opts: Parameters<typeof installPage>[0], root: string | null = null): Promise<Page> {
  epoch += 10_000_000;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: epoch });
  const page = installPage(opts);
  imports += 1;
  await import(root === null ? url('app.js', `?run=${imports}`) : `${pathToFileURL(path.join(root, 'app.js')).href}?run=${imports}`);
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
  if (target === '/api/workflows') return reply(200, WORKFLOWS); // F.2: the Workflows view reads it
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
  assert.deepEqual(Object.keys(VIEWS).sort(), ['fleet', 'fleet-project', 'not-found', 'run', 'runs', 'sessions', 'tasks', 'workflows']); // E.7 adds the sessions view, V.10 the two Fleet views
});

test('index.html provides the elements the shell needs', () => {
  const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  for (const id of ['main', 'conn', 'core-version', 'banner-slot', 'announcer', 'pause']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-live="polite"/);
  assert.deepEqual([...html.matchAll(/class="nav__link" href="([^"]+)"/g)].map((m) => m[1]), ['#/', '#/workflows', '#/sessions', '#/fleet']); // E.7 adds the Sessions link, V.10 the Fleet link
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

test('run head (CD-B8 replaces the D.2 meta order): badge, workflow name, started, revision, updated, one element per item with separators between', async () => {
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1'
    ? reply(200, { v: 1, run: { ...row('RUNNING'), revision: 5, updatedAt: null }, timeline: {}, tasks: null, workflow: {} }) : standard(target, init)) });
  const meta = page.main.querySelector('.view-head__meta');
  assert.ok(meta);
  assert.ok(meta.children.every((c: any) => c instanceof El), 'no bare text node among the items');
  const items = meta.children.filter((c: El) => c.getAttribute('aria-hidden') !== 'true');
  assert.deepEqual(items.map((c: any) => text(c)), ['Running', 'feature', 'revision 5', 'Update time unknown']);
  assert.ok(items[0].classList.contains('badge'));
  assert.equal(meta.children.length, items.length * 2 - 1, 'a separator sits between every two items');
  assert.ok(meta.children.filter((c: El) => c.getAttribute('aria-hidden') === 'true').every((c: El) => text(c) === '·'));
});

test('router: the old view stops polling when the route changes', async () => {
  const page = await start({ hash: '', fetch: standard });
  const runsBefore = apiCalls(page, '/api/runs').length;
  page.location.hash = '#/workflows';
  page.win.dispatch('hashchange');
  await advance(30_000);
  assert.equal(apiCalls(page, '/api/runs').length, runsBefore, 'the Runs poller is gone');
  // F.2: Workflows reads /api/workflows, so its own poll (30 s) replaces the heartbeat that stood in while the view had no data.
  assert.ok(apiCalls(page, '/api/workflows').length >= 2, 'the Workflows view polls its own route');
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

// ---- E.1: the runs home and the stage rail (design note E.1) --------------------------------------------------
// Rows are built inside the fetch callbacks (`() => [...]`), after start() has put Date on mock time.

/** Identity check that does not print the (cyclic) element tree when it fails. */
const same = (a: unknown, b: unknown, message: string) => assert.ok(a === b, message);
const MIN_MS = 60_000;
const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();
const stageDef = (id: string, gatesAfter: any[] = [], optional = false) => ({ id, kind: id, optional, skill: `do-${id}`, agent: 'delivery-lead', purpose: `Purpose of ${id}.`, gatesAfter });
const gateDef = (id: string, kind: string) => ({ id, name: `Name of ${id}`, kind, trigger: kind === 'approval' ? 'always' : 'unresolved-clarifications', prompt: `Prompt of ${id}.` });
// discovery, gate-0 (clarification), design, planning, gate-a (approval): five nodes
const WF_FEATURE = { taskClass: 'feature', name: 'Feature Delivery', stages: [stageDef('discovery', [gateDef('gate-0', 'clarification')]), stageDef('design'), stageDef('planning', [gateDef('gate-a', 'approval')])] };
const WF_DOC = { taskClass: 'documentation', name: 'Documentation', stages: [stageDef('authoring'), stageDef('verification', [], true), stageDef('review', [], true)] };
const WORKFLOWS = { v: 1, workflows: [WF_FEATURE, WF_DOC] };
const PROGRAM: Array<[string, string]> = [['stage', 'discovery'], ['gate', 'gate-0'], ['stage', 'design'], ['stage', 'planning'], ['gate', 'gate-a']];

/** A feature run row with the cursor on node `cursor` (5 = COMPLETED). */
function frow(taskId: string, cursor: number, over: any = {}) {
  const done = cursor >= 5;
  const [type, id] = done ? [null, null] : PROGRAM[cursor];
  const state = done ? 'COMPLETED' : type === 'gate' ? 'AWAITING_GATE' : 'RUNNING';
  return {
    taskId, featureSlug: 'feat-a', taskClass: 'feature', workflowName: 'Feature Delivery', state,
    current: done ? null : { type, id, kind: type === 'gate' ? (id === 'gate-0' ? 'clarification' : 'approval') : id },
    awaitingGate: state === 'AWAITING_GATE' ? { gateId: id } : null, progress: { done: cursor, total: 5 },
    revision: 1, startedAt: agoIso(3_600_000), updatedAt: agoIso(MIN_MS), origin: 'current', ...over,
  };
}
const body = (runs: any[], unreadableCount = 0) => ({ v: 1, runs, unreadableCount });
const rowsOf = (page: Page) => page.main.querySelectorAll('.run-row');
const linkText = (r: El) => text(r.querySelector('.run-row__link') ?? r.querySelector('.run-row__id'));
const rowOf = (page: Page, title: string) => rowsOf(page).find((r) => linkText(r) === title)!;
const cardsOf = (page: Page) => page.main.querySelectorAll('.gate-card');
const cardId = (c: El) => c.querySelector('.gate-card__id').children.filter((x: El) => !x.classList.contains('tag')).map(text).join('');
const cardOf = (page: Page, title: string) => cardsOf(page).find((c) => cardId(c) === title)!;
const homeFetch = (current: () => any, workflows: () => Reply = () => reply(200, WORKFLOWS)) => (target: string, init: any) => {
  if (target === '/api/runs') return reply(200, current());
  if (target === '/api/workflows') return workflows();
  return standard(target, init);
};

test('E.1 home: Needs you first and oldest first, then Running and Finished newest first; flat and other-checkout rows are marked', async () => {
  mods.home.resetHome();
  const runs = () => [
    frow('w-new', 4, { updatedAt: agoIso(10 * MIN_MS) }), frow('w-old', 1, { updatedAt: agoIso(30 * MIN_MS) }),
    frow('r-old', 2, { updatedAt: agoIso(5 * MIN_MS) }), frow('r-new', 0, { updatedAt: agoIso(MIN_MS) }),
    frow('f-1', 5, { updatedAt: agoIso(60 * MIN_MS) }), frow('f-2', 1, { state: 'REJECTED', updatedAt: agoIso(20 * MIN_MS) }),
    frow('flat-1', 0, { featureSlug: null, updatedAt: agoIso(9 * MIN_MS) }), frow('other-1', 2, { origin: 'other', updatedAt: agoIso(7 * MIN_MS) }),
  ];
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs(), 1)) });
  const sections = page.main.querySelectorAll('.run-section');
  assert.deepEqual(sections.map((s) => s.getAttribute('data-section')), ['needs', 'running', 'finished']);
  assert.deepEqual(sections.map((s) => text(s.querySelector('.run-section__title'))), ['Needs you2', 'Running4', 'Finished2']);
  const order = (section: El) => section.querySelectorAll('.run-row').map(linkText);
  // CD-B1: the Needs you section is gate cards, not rows; the oldest wait is first.
  assert.deepEqual(sections[0].querySelectorAll('.gate-card').map(cardId), ['feat-a / w-old', 'feat-a / w-new']);
  assert.equal(sections[0].querySelectorAll('.run-row').length, 0);
  assert.deepEqual(order(sections[1]), ['feat-a / r-new', 'feat-a / r-old', 'feat-a / other-1', 'flat-1']);
  assert.deepEqual(order(sections[2]), ['feat-a / f-2', 'feat-a / f-1']);
  const flat = rowOf(page, 'flat-1');
  assert.equal(flat.getAttribute('data-openable'), 'false');
  assert.equal(flat.querySelector('a'), null, 'a flat run is not a link and so not a tab stop');
  assert.deepEqual(flat.querySelectorAll('.tag').map(text), ['No feature folder']);
  assert.match(text(flat.querySelector('.run-row__desc')), /This run has no feature folder, so it cannot be opened here\.$/);
  const other = rowOf(page, 'feat-a / other-1');
  assert.deepEqual(other.querySelectorAll('.tag').map(text), ['Other checkout']);
  assert.equal(other.querySelector('.run-row__link').getAttribute('href'), '#/run/feat-a/other-1');
  assert.ok(rowsOf(page).every((r) => r.getAttribute('data-attention') === null), 'CD-B1 removed the left bar and data-attention from rows');
  const note = page.main.querySelector('.view-note');
  assert.equal(text(note), '1 run could not be read.');
  assert.equal(note.parent.children.at(-1), note, 'the unreadable note comes after the last section');
  assert.equal(page.doc.title, '(2) Runs · DoFlow Console');
});

test('E.1 home: each row draws a compact rail of its class, hidden from assistive technology, with the description read on focus', async () => {
  mods.home.resetHome();
  const runs = () => [frow('w1', 4), frow('d1', 1, { state: 'RUNNING', taskClass: 'documentation', workflowName: 'Documentation', progress: { done: 1, total: 3 }, current: { type: 'stage', id: 'verification', kind: 'verification' } })];
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs())) });
  const rails = page.main.querySelectorAll('.rail--compact');
  assert.deepEqual(rails.map((r) => r.children.length).sort(), [3, 5]);
  assert.ok(rails.every((r) => r.getAttribute('aria-hidden') === 'true'));
  const feature = cardOf(page, 'feat-a / w1').querySelector('.rail--compact');
  assert.ok(feature.classList.contains('rail--lg'), 'the gate card draws the large variant');
  assert.deepEqual(feature.children.map((g: El) => [g.getAttribute('data-type'), g.getAttribute('data-state')]), [['stage', 'done'], ['gate', 'done'], ['stage', 'done'], ['stage', 'done'], ['gate', 'awaiting']]);
  assert.deepEqual(feature.children.filter((g: El) => g.getAttribute('data-type') === 'gate').map((g: El) => g.getAttribute('data-kind')), ['clarification', 'approval']);
  assert.equal(page.main.querySelectorAll('[data-changed]').length, 0, 'nothing is marked on the first paint');
  // CD-B1 replaces the needs-you row description with the card description (E.1 7.1).
  const cardLink = cardOf(page, 'feat-a / w1').querySelector('.gate-card__link');
  assert.match(text(page.doc.getElementById(cardLink.getAttribute('aria-describedby'))), /^Name of gate-a\. Approval gate\. Waiting for you for 1 min\. Feature Delivery, step 5 of 5\.$/);
  assert.equal(cardLink.getAttribute('aria-label'), 'Open the run to decide: feat-a / w1');
  assert.equal(cardLink.dataset.focusKey, 'run:feat-a/w1');
  // CD-B5: the title has a slug and a muted task id; the meta carries the workflow name and the step part per band.
  const doc = rowOf(page, 'feat-a / d1');
  const link = doc.querySelector('.run-row__link');
  assert.equal(link.getAttribute('title'), 'feat-a / d1');
  assert.deepEqual([text(link.children[0]), text(link.children[1])], ['feat-a', ' / d1']);
  assert.equal(link.dataset.focusKey, 'run:feat-a/d1');
  assert.equal(text(doc.querySelector('.run-row__wf')), 'Documentation · ');
  assert.equal(text(doc.querySelector('.run-row__sp')), 'verification');
  assert.equal(text(doc.querySelector('.run-row__st')), 'Step 2 of 3 · verification');
  assert.equal(text(doc.querySelector('.run-row__frac')), ' · 2/3');
  assert.equal(text(doc.querySelector('.run-row__step')), '2 / 3');
  assert.equal(doc.querySelector('.run-row__step').getAttribute('aria-hidden'), 'true');
  assert.equal(text(doc.querySelector('.run-row__upd')), 'Updated ');
});

test('E.1 home: a degraded rail and an unavailable workflow show the one-line fallback, and the row stays openable', async () => {
  mods.home.resetHome();
  const runs = () => [
    frow('shape', 2, { progress: { done: 2, total: 8 } }),
    frow('cursor', 2, { progress: { done: 3, total: 5 } }),
    frow('other-class', 0, { taskClass: 'operations', workflowName: 'Operations', progress: { done: 0, total: 4 }, current: { type: 'stage', id: 'state-check', kind: 'state-check' } }),
  ];
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs())) });
  const fallback = (id: string) => text(rowOf(page, `feat-a / ${id}`).querySelector('.rail-fallback'));
  assert.equal(fallback('shape'), 'Step 3 of 8 · workflow changed');
  assert.equal(fallback('cursor'), 'Step 4 of 5 · position unconfirmed');
  assert.equal(fallback('other-class'), 'Step 1 of 4 · workflow unavailable');
  assert.equal(page.main.querySelectorAll('.rail--compact').length, 0);
  assert.ok(rowsOf(page).every((r) => r.getAttribute('data-openable') === 'true'));
  const described = (id: string) => text(page.doc.getElementById(rowOf(page, `feat-a / ${id}`).querySelector('.run-row__link').getAttribute('aria-describedby')));
  assert.match(described('shape'), /Workflow changed since this run started\.$/);
  assert.match(described('cursor'), /Position not confirmed\.$/);
  assert.match(described('other-class'), /Workflow unavailable\.$/);
});

test('E.1 home: a failed workflows fetch never fails the view; it is read again at most once a minute, and only when a row needs it', async () => {
  mods.home.resetHome();
  let workflowsUp = false;
  const page = await start({ hash: '', fetch: homeFetch(() => body([frow('a', 0), frow('b', 4)]), () => (workflowsUp ? reply(200, WORKFLOWS) : errorReply(502, 'core-error'))) });
  assert.equal(page.main.querySelectorAll('.tile').length, 3, 'the view is loaded');
  assert.equal(page.main.querySelectorAll('.rail-fallback').length, 2);
  assert.equal(page.slot.querySelectorAll('.banner').length, 0);
  assert.equal(apiCalls(page, '/api/workflows').length, 1);
  await advance(30_000);
  assert.equal(apiCalls(page, '/api/workflows').length, 1, 'not again within a minute');
  workflowsUp = true;
  await advance(35_000);
  assert.equal(apiCalls(page, '/api/workflows').length, 2, 'once the minute has passed, because a row has no workflow');
  await advance(6_000);
  assert.equal(page.main.querySelectorAll('.rail--compact').length, 2, 'the next poll draws the rails');
  assert.equal(page.main.querySelectorAll('.rail-fallback').length, 0);
  await advance(120_000);
  assert.equal(apiCalls(page, '/api/workflows').length, 2, 'every class has a workflow now: no more reads');
});

test('E.1 home: the summary tiles are the state filter: one pressed at a time, a section only, and "Show all runs" returns focus to the tile', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '', fetch: homeFetch(() => body([frow('w1', 4), frow('r1', 0), frow('r2', 2), frow('f1', 5)])) });
  const tiles = () => page.main.querySelectorAll('.tile');
  assert.ok(tiles().every((t) => t.tagName.toLowerCase() === 'button'));
  assert.deepEqual(tiles().map((t) => t.getAttribute('aria-pressed')), ['false', 'false', 'false']);
  assert.equal(page.main.querySelector('.filter-status'), null);
  tiles()[1].fire('click');
  assert.deepEqual(tiles().map((t) => t.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  assert.deepEqual(page.main.querySelectorAll('.run-section').map((s) => s.getAttribute('data-section')), ['running']);
  assert.equal(text(page.main.querySelector('.filter-status').children[0]), 'Showing only running runs.');
  same(page.doc.activeElement, tiles()[1], 'focus stays on the pressed tile');
  assert.equal(tiles()[1].querySelectorAll('.tile__check').length, 1, 'selection is never colour alone');
  tiles()[0].fire('click');
  assert.deepEqual(tiles().map((t) => t.getAttribute('aria-pressed')), ['true', 'false', 'false'], 'single select');
  assert.equal(text(page.main.querySelector('.filter-status').children[0]), 'Showing only runs that need you.');
  page.main.querySelector('[data-focus-key="filter-clear"]').fire('click');
  assert.equal(page.main.querySelector('.filter-status'), null);
  assert.equal(page.main.querySelectorAll('.run-section').length, 3);
  same(page.doc.activeElement, tiles()[0], 'the clear button is gone: focus goes to the tile that was pressed');
  tiles()[2].fire('click');
  tiles()[2].fire('click');
  assert.equal(page.main.querySelectorAll('.run-section').length, 3, 'pressing the pressed tile clears the filter');
  tiles()[2].fire('click');
  assert.equal(text(page.main.querySelector('.run-section__title')), 'Finished1');
  // The filter lives for the tab: a route change and back keeps it.
  page.location.hash = '#/workflows';
  page.win.dispatch('hashchange');
  page.location.hash = '#/';
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(page.main.querySelectorAll('.tile')[2].getAttribute('aria-pressed'), 'true');
  mods.home.resetHome();
});

test('E.1 home: an empty section says so; the Finished list is capped at 10 and expands in place', async () => {
  mods.home.resetHome();
  const finished = () => Array.from({ length: 12 }, (_, i) => frow(`f${String(i).padStart(2, '0')}`, 5, { updatedAt: agoIso((i + 1) * MIN_MS) }));
  const page = await start({ hash: '', fetch: homeFetch(() => body(finished())) });
  assert.deepEqual(page.main.querySelectorAll('.run-section__empty').map(text), ['Nothing is waiting for you.', 'Nothing is running right now.']);
  assert.equal(page.main.querySelectorAll('.run-row').length, 10);
  const more = page.main.querySelector('.run-section__more');
  assert.equal(text(more), 'Show all 12 finished runs');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  more.fire('click');
  assert.equal(page.main.querySelectorAll('.run-row').length, 12);
  const fewer = page.main.querySelector('.run-section__more');
  assert.equal(text(fewer), 'Show fewer');
  assert.equal(fewer.getAttribute('aria-expanded'), 'true');
  same(page.doc.activeElement, fewer, 'focus stays on the button across the rebuild');
  fewer.fire('click');
  assert.equal(page.main.querySelectorAll('.run-row').length, 10);
  mods.home.resetHome();
});

test('E.1 home: a run that begins to wait is announced once; the first poll announces nothing; changed glyphs are marked for one poll interval', async () => {
  mods.home.resetHome();
  let runs = () => [frow('a', 2), frow('b', 4)];
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs())) });
  assert.equal(text(page.region), '', 'the first poll announces nothing, not even the run that already waits');
  assert.equal(page.main.querySelectorAll('[data-changed]').length, 0);
  runs = () => [frow('a', 4, { updatedAt: agoIso(0) }), frow('b', 4)];
  await advance(5_000);
  assert.equal(text(page.region), 'feat-a / a is waiting for you at gate-a.');
  const marked = cardOf(page, 'feat-a / a').querySelectorAll('[data-changed]');
  assert.deepEqual(marked.map((g) => g.getAttribute('data-state')), ['done', 'done', 'awaiting'], 'design and planning finished and the gate began to wait; discovery and gate-0 did not change');
  assert.equal(page.main.querySelectorAll('[data-changed]').length, 3, 'the run that did not change has no mark');
  runs = () => [frow('a', 4, { updatedAt: agoIso(0) }), frow('b', 4), frow('c', 4), frow('d', 1)];
  await advance(5_000);
  assert.equal(text(page.region), '2 runs are waiting for you.');
  await advance(6_000);
  assert.equal(page.main.querySelectorAll('[data-changed]').length, 0, 'the mark lasts one poll interval');
  mods.home.resetHome();
});

test('E.1 home: focus stays on the same run link across a re-mount, because the key is the same', async () => {
  mods.home.resetHome();
  let runs = () => [frow('a', 2), frow('b', 2, { updatedAt: agoIso(2 * MIN_MS) })];
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs())) });
  const linkOf = (id: string) => rowOf(page, `feat-a / ${id}`).querySelector('.run-row__link');
  const before = linkOf('b');
  before.focus();
  same(page.doc.activeElement, before, 'focus');
  runs = () => [frow('a', 4), frow('b', 2, { updatedAt: agoIso(2 * MIN_MS) })]; // a moves to Needs you; b stays
  await advance(5_000);
  const after = linkOf('b');
  assert.ok(after !== before, 'the body was re-mounted');
  same(page.doc.activeElement, after, 'focus is back on the run with the same key');
  // A key that no longer exists falls back to the heading.
  after.focus();
  runs = () => [frow('a', 4)];
  await advance(5_000);
  same(page.doc.activeElement, heading(page), 'focus');
});

test('E.1 home: the row description follows the minute on the 1 s tick', async () => {
  mods.home.resetHome();
  let at: string | null = null;
  const page = await start({ hash: '', fetch: homeFetch(() => { at ??= agoIso(10_000); return body([frow('a', 2, { updatedAt: at })]); }) });
  const desc = () => text(page.main.querySelector('.run-row__desc'));
  assert.match(desc(), /Updated less than a minute ago\.$/);
  await advance(1_000);
  assert.match(desc(), /Updated less than a minute ago\.$/);
  await advance(3 * MIN_MS);
  assert.match(desc(), /Updated 3 minutes ago\.$/);
});

test('E.1 home: the loading skeleton is the strip, a title block and a list block (no row skeletons)', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '', fetch: (target, init) => (target === '/api/runs' ? new Promise<Reply>(() => {}) : standard(target, init)) });
  await advance(400);
  assert.deepEqual(page.main.querySelectorAll('.skel').map((s) => s.className.replace('skel ', '')), ['skel--tile', 'skel--tile', 'skel--tile', 'skel--title', 'skel--list']);
  assert.equal(page.main.querySelectorAll('.skel--row').length, 0);
});

test('E.1 views: the runs view reads list and workflow, the badge words equal the derivation words, and a body re-mount ignores the workflow bodies', () => {
  const { VIEWS, SHAPES_USED, badge } = mods.views;
  assert.deepEqual(VIEWS.runs.shapes, ['list', 'workflow']);
  assert.ok(SHAPES_USED.includes('workflow') && SHAPES_USED.includes('list'));
  assert.equal(typeof VIEWS.runs.load, 'function');
  assert.equal(typeof VIEWS.runs.dataKey, 'function');
  assert.equal(typeof VIEWS.run.render, 'function');
  installPage({ fetch: () => reply(204) });
  const now = 1_700_000_000_000 * 1.0;
  for (const [state, updatedAt] of [['RUNNING', new Date(now).toISOString()], ['AWAITING_GATE', null], ['COMPLETED', null], ['REJECTED', null], ['RUNNING', new Date(now - 25 * 3_600_000).toISOString()]]) {
    const run = { state, updatedAt };
    assert.equal(text(badge(run, now)), mods.derive.runWord(run, now), `${state} ${updatedAt}`);
  }
  const base = { runs: [{ ...frow('a', 0), updatedAt: new Date(now).toISOString() }], unreadableCount: 0 };
  const keyOf = VIEWS.runs.dataKey;
  assert.equal(keyOf({ ...base, workflows: new Map([['feature', WF_FEATURE]]) }), keyOf({ ...base, workflows: new Map([['feature', { ...WF_FEATURE, name: 'Renamed' }]]) }), 'same classes, other registry text: no re-mount');
  assert.notEqual(keyOf({ ...base, workflows: new Map() }), keyOf({ ...base, workflows: new Map([['feature', WF_FEATURE]]) }), 'a class gaining a workflow re-mounts');
  uninstallPage();
});

// ---- E.1: the full rail on the run route --------------------------------------------------------------------------

function runBody(row: any, workflow: any, events: any[] = []) {
  return { v: 1, run: row, timeline: { v: 1, taskId: row.taskId, featureSlug: row.featureSlug, revision: 2, startedAt: agoIso(3_600_000), events }, tasks: null, workflow };
}
const ev = (minutesAgo: number, action: string, node: string | null, over: any = {}) => ({ at: agoIso(minutesAgo * MIN_MS), action, node, outcome: null, decision: null, forced: false, synthetic: false, ...over });
const runRoute = (build: () => any) => (target: string, init: any) => (target === '/api/runs/feat-a/run-1' ? reply(200, build()) : standard(target, init));

test('E.1 rail: the run route shows the full rail with one tab stop on the cursor node and a name per node', async () => {
  mods.home.resetHome();
  const events = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve', forced: true }), ev(30, 'complete-stage', 'design', { outcome: 'passed' }), ev(20, 'complete-stage', 'planning', { outcome: 'unverified' })];
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(frow('run-1', 4), WF_FEATURE, events())) });
  assert.equal(page.main.querySelector('.rail--full').getAttribute('aria-label'), 'Stages of feat-a / run-1');
  const buttons = page.main.querySelectorAll('.rail__node');
  assert.equal(buttons.length, 5);
  assert.deepEqual(buttons.map((b) => b.getAttribute('tabindex')), ['-1', '-1', '-1', '-1', '0']);
  assert.match(buttons[0].getAttribute('aria-label'), /^1 of 5\. discovery\. Stage\. Done, passed\. 10 min after the previous event\.$/);
  assert.match(buttons[1].getAttribute('aria-label'), /^2 of 5\. gate-0\. Clarification gate\. Approved, forced\. 10 min after the previous event\.$/);
  assert.match(buttons[3].getAttribute('aria-label'), /^4 of 5\. planning\. Stage\. Done, unverified\. 10 min after the previous event\.$/);
  assert.match(buttons[4].getAttribute('aria-label'), /^5 of 5\. gate-a\. Approval gate\. Waiting for you for 20 min\.$/);
  assert.equal(text(page.main.querySelectorAll('.rail__gate-label')[0]), 'gate-0forced');
  assert.equal(page.main.querySelectorAll('.rail__item')[1].getAttribute('data-forced'), 'true');
  assert.equal(page.main.querySelector('.rail-note'), null);
});

test('E.1 rail: arrows, Home and End move the single tab stop without wrapping; Enter opens the detail, Escape closes it and focus stays on the node', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(frow('run-1', 2), WF_FEATURE, [ev(30, 'start', null)])) });
  const buttons = () => page.main.querySelectorAll('.rail__node');
  const stops = () => buttons().map((b) => b.getAttribute('tabindex'));
  assert.deepEqual(stops(), ['-1', '-1', '0', '-1', '-1']);
  const key = (button: El, k: string) => button.fire('keydown', { key: k });
  buttons()[2].focus();
  key(buttons()[2], 'ArrowRight');
  assert.deepEqual(stops(), ['-1', '-1', '-1', '0', '-1']);
  same(page.doc.activeElement, buttons()[3], 'focus');
  key(buttons()[3], 'End');
  same(page.doc.activeElement, buttons()[4], 'focus');
  key(buttons()[4], 'ArrowDown');
  same(page.doc.activeElement, buttons()[4], 'no wrap at the end');
  key(buttons()[4], 'Home');
  same(page.doc.activeElement, buttons()[0], 'focus');
  key(buttons()[0], 'ArrowLeft');
  same(page.doc.activeElement, buttons()[0], 'no wrap at the start');
  key(buttons()[0], 'ArrowUp');
  assert.deepEqual(stops(), ['0', '-1', '-1', '-1', '-1']);
  // Enter and Space reach a button as a click.
  buttons()[3].fire('click');
  const detail = page.main.querySelector('.rail-detail');
  assert.ok(detail);
  assert.equal(detail.getAttribute('role'), 'region');
  assert.equal(detail.getAttribute('aria-labelledby'), 'rail-detail-title');
  assert.equal(text(detail.querySelector('.rail-detail__title')), 'planning');
  assert.deepEqual(detail.querySelectorAll('dt').map(text), ['Kind', 'Skill / Agent', 'Purpose', 'Recorded']);
  assert.equal(text(detail.querySelectorAll('dd')[2]), 'Purpose of planning.');
  assert.equal(text(detail.querySelectorAll('dd')[3]), 'Not yet');
  assert.equal(buttons()[3].getAttribute('aria-expanded'), 'true');
  assert.equal(buttons()[3].getAttribute('data-selected'), 'true');
  assert.equal(buttons()[0].getAttribute('aria-expanded'), 'false');
  buttons()[4].fire('click');
  assert.equal(text(page.main.querySelector('.rail-detail__title')), 'gate-a', 'a second node switches the detail');
  const gateDetail = page.main.querySelector('.rail-detail');
  assert.deepEqual(gateDetail.querySelectorAll('dt').map(text), ['Kind', 'When asked', 'Asks', 'Recorded']);
  assert.equal(text(gateDetail.querySelectorAll('dd')[1]), 'Every run');
  buttons()[4].fire('click');
  assert.equal(page.main.querySelector('.rail-detail'), null, 'the same node closes it');
  buttons()[2].fire('click');
  assert.ok(page.main.querySelector('.rail-detail'));
  key(buttons()[2], 'Escape');
  assert.equal(page.main.querySelector('.rail-detail'), null);
  same(page.doc.activeElement, buttons()[2], 'focus stays on the node');
  buttons()[2].fire('click');
  const close = page.main.querySelector('[data-focus-key="rail-detail-close"]');
  assert.equal(text(close), 'Close details');
  close.fire('click');
  assert.equal(page.main.querySelector('.rail-detail'), null);
  same(page.doc.activeElement, buttons()[2], 'the Close button returns focus to its node');
});

test('E.1 rail: the open detail and the roving stop survive a poll, focus stays on the same node, and the detail closes when its node is gone', async () => {
  mods.home.resetHome();
  let row0 = () => frow('run-1', 2);
  let workflow: any = WF_FEATURE;
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(row0(), workflow, [ev(30, 'start', null)])) });
  const buttons = () => page.main.querySelectorAll('.rail__node');
  buttons()[1].focus();
  buttons()[1].fire('click');
  assert.ok(page.main.querySelector('.rail-detail'));
  const old = buttons()[1];
  row0 = () => frow('run-1', 3);
  await advance(3_000);
  assert.ok(buttons()[1] !== old, 'the body was re-mounted');
  assert.equal(text(page.main.querySelector('.rail-detail__title')), 'gate-0', 'the detail stays open');
  same(page.doc.activeElement, buttons()[1], 'focus is restored by node key');
  assert.deepEqual(buttons().map((b) => b.getAttribute('tabindex')), ['-1', '0', '-1', '-1', '-1'], 'the roving stop stays where the person put it');
  workflow = { ...WF_FEATURE, stages: WF_FEATURE.stages.slice(1) };
  row0 = () => frow('run-1', 3, { progress: { done: 3, total: 3 } });
  await advance(3_000);
  assert.equal(page.main.querySelector('.rail-detail'), null, 'its node no longer exists: the detail closes');
});

test('E.1 rail: a degraded run shows its current node, an unknown track and the note; a missing workflow is the same with its own note', async () => {
  mods.home.resetHome();
  const cases: Array<[() => any, RegExp, string]> = [
    [() => runBody(frow('run-1', 2, { progress: { done: 2, total: 8 } }), WF_FEATURE), /^This run started on a different workflow version, so only its current step is shown\.$/, 'Step 3 of 8'],
    [() => runBody(frow('run-1', 2, { progress: { done: 3, total: 5 } }), WF_FEATURE), /recorded position does not match its progress/, 'Step 4 of 5'],
    [() => runBody(frow('run-1', 2), {}), /could not be read, so only its current step is shown/, 'Step 3 of 5'],
  ];
  for (const [build, note, step] of cases) {
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(build) });
    assert.equal(page.main.querySelectorAll('.rail__node').length, 1);
    assert.equal(page.main.querySelector('.rail__node').getAttribute('tabindex'), '0');
    assert.equal(text(page.main.querySelector('.rail__unknown')), step);
    assert.match(text(page.main.querySelector('.rail-note')), note);
    uninstallPage();
    mock.timers.reset();
  }
});

test('E.1 rail: the run route announces what moved: a gate waiting, a stage running and completion', async () => {
  mods.home.resetHome();
  let row0 = () => frow('run-1', 0);
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(row0(), WF_FEATURE, [ev(5, 'start', null)])) });
  assert.equal(text(page.region), '', 'the first load announces nothing');
  row0 = () => frow('run-1', 1);
  await advance(3_000);
  assert.equal(text(page.region), 'gate-0 is waiting for you.');
  row0 = () => frow('run-1', 2);
  await advance(3_000);
  assert.equal(text(page.region), 'design running.');
  row0 = () => frow('run-1', 5);
  await advance(3_000);
  assert.equal(text(page.region), 'Run completed.');
});


// ---- E.1 review fixes (F3, F4, F7, F8, F9, F11) ------------------------------------------------------------

test('E.1 F4: ages over an hour read in hours and days, floored', () => {
  const { ageUnits, ageText } = mods.states;
  assert.equal(ageUnits(59 * 60_000 + 59_000), '59 min');
  assert.equal(ageUnits(60 * 60_000), '1 h');
  assert.equal(ageUnits(23 * 3_600_000 + 59 * 60_000), '23 h');
  assert.equal(ageUnits(24 * 3_600_000), '1 d');
  assert.equal(ageUnits(2881 * 60_000), '2 d');
  assert.equal(ageText(2881 * 60_000), '2 d ago');
  assert.equal(ageText(12_000), '12 s ago');
});

test('E.1 F3: the scroller math measures against the scroller, not the li the button sits in', () => {
  const { ensureVisible, centerOn } = mods.railView;
  // Rects say the node is at x 900..980 of a 100..820 scroller with scrollLeft 0; offsetLeft (relative to its li) says 12.
  const make = (left: number, scrollLeft: number) => ({
    scroller: { scrollLeft, clientWidth: 720, getBoundingClientRect: () => ({ left: 100 }) },
    button: { offsetLeft: 12, offsetWidth: 80, getBoundingClientRect: () => ({ left, width: 80 }) },
  });
  let { scroller, button } = make(900, 0);
  ensureVisible(scroller, button);
  assert.equal(scroller.scrollLeft, 800 + 80 + 32 - 720, 'a node past the right edge is brought in with 32 px to spare');
  ({ scroller, button } = make(120, 400));
  ensureVisible(scroller, button);
  assert.equal(scroller.scrollLeft, 400 + 20 - 32, 'a node before the left edge is brought in with 32 px to spare');
  ({ scroller, button } = make(300, 50));
  ensureVisible(scroller, button);
  assert.equal(scroller.scrollLeft, 50, 'a visible node does not move the scroller');
  ({ scroller, button } = make(900, 0));
  centerOn(scroller, button);
  assert.equal(scroller.scrollLeft, 800 + 40 - 360, 'the current node is centred');
});

test('E.1 F7: the roving tab stop follows focus, so a poll that moves the cursor leaves it on the focused node', async () => {
  mods.home.resetHome();
  let row0 = () => frow('run-1', 2);
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(row0(), WF_FEATURE, [ev(30, 'start', null)])) });
  const buttons = () => page.main.querySelectorAll('.rail__node');
  buttons()[0].focus();
  buttons()[0].fire('focus');
  assert.deepEqual(buttons().map((b) => b.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1']);
  row0 = () => frow('run-1', 3);
  await advance(3_000);
  assert.deepEqual(buttons().map((b) => b.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1'], 'the focused node keeps the stop; the new cursor does not take it');
  same(page.doc.activeElement, buttons()[0], 'focus restored');
});

test('E.1 F8a: Escape inside the detail closes it and puts focus on its node', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(frow('run-1', 2), WF_FEATURE, [ev(30, 'start', null)])) });
  const buttons = () => page.main.querySelectorAll('.rail__node');
  buttons()[3].fire('click');
  const detail = page.main.querySelector('.rail-detail');
  detail.fire('keydown', { key: 'Escape' });
  assert.ok(page.main.querySelector('.rail-detail') === null, 'closed');
  same(page.doc.activeElement, buttons()[3], 'focus is on the node');
  buttons()[3].fire('click');
  page.main.querySelector('.rail-detail').fire('keydown', { key: 'a' });
  assert.ok(page.main.querySelector('.rail-detail'), 'another key leaves it open');
});

test('E.1 F9: a degraded node is named by the run record, with the reason', async () => {
  mods.home.resetHome();
  const cases: Array<[() => any, string]> = [
    [() => runBody(frow('run-1', 2, { progress: { done: 2, total: 8 } }), WF_FEATURE), '3 of 8. design. Stage. Running. Workflow changed since this run started.'],
    [() => runBody(frow('run-1', 2, { progress: { done: 3, total: 5 } }), WF_FEATURE), '4 of 5. design. Stage. Running. Position not confirmed.'],
    [() => runBody(frow('run-1', 2), {}), '3 of 5. design. Stage. Running. Workflow unavailable.'],
  ];
  for (const [build, name] of cases) {
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(build) });
    assert.equal(page.main.querySelector('.rail__node').getAttribute('aria-label'), name);
    uninstallPage();
    mock.timers.reset();
  }
  assert.equal(mods.railView.NOTES['workflow-unavailable'], 'This run’s workflow could not be read, so only its current step is shown.');
});

test('E.1 F11: the description of an openable row is hidden (read once, through the link); a flat row keeps it visible to assistive technology', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '', fetch: homeFetch(() => body([frow('a', 2), frow('flat', 0, { featureSlug: null })])) });
  const desc = (title: string) => rowOf(page, title).querySelector('.run-row__desc');
  assert.equal(desc('feat-a / a').getAttribute('hidden'), '');
  assert.ok(text(desc('feat-a / a')).length > 0, 'still readable through aria-describedby');
  assert.equal(desc('flat').getAttribute('hidden'), null);
});

// ---- Claude Design pass (CD-B1 to CD-B8) ----------------------------------------------------------------------

test('CD-B1 gate cards: one per waiting run, longest wait first, with the registry name and prompt, the kind, the wait and the link', async () => {
  mods.home.resetHome();
  const runs = () => [
    frow('new', 4, { updatedAt: agoIso(2 * MIN_MS) }), frow('old', 1, { updatedAt: agoIso(134 * MIN_MS) }),
    frow('far', 4, { origin: 'other', updatedAt: agoIso(20 * MIN_MS) }), frow('flat', 1, { featureSlug: null, updatedAt: agoIso(50 * MIN_MS) }),
  ];
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs())) });
  assert.deepEqual(cardsOf(page).map(cardId), ['feat-a / old', 'flat', 'feat-a / far', 'feat-a / new']);
  const card = cardOf(page, 'feat-a / old');
  assert.equal(card.getAttribute('data-kind'), 'clarification');
  assert.equal(text(card.querySelector('.gate-card__kind')), 'Clarification gate');
  assert.equal(text(card.querySelector('.gate-card__wait-word')), 'waiting');
  assert.equal(text(card.querySelector('.gate-card__wait-dur')), '2 h 14 min');
  assert.equal(text(card.querySelector('.gate-card__name')), 'Name of gate-0');
  assert.equal(text(card.querySelector('.gate-card__prompt')), 'Prompt of gate-0.');
  assert.equal(card.querySelector('.gate-card__head').getAttribute('aria-hidden'), 'true');
  assert.equal(text(card.querySelector('.gate-card__meta')), 'Feature Delivery · step 2 of 5');
  const link = card.querySelector('.gate-card__link');
  assert.equal(link.getAttribute('href'), '#/run/feat-a/old');
  assert.equal(link.getAttribute('aria-label'), 'Open the run to decide: feat-a / old');
  assert.equal(card.getAttribute('data-openable'), 'true');
  assert.equal(card.querySelector('.rail--lg').getAttribute('aria-hidden'), 'true');
  assert.equal(cardOf(page, 'feat-a / new').getAttribute('data-kind'), 'approval');
  assert.deepEqual(cardOf(page, 'feat-a / far').querySelectorAll('.tag').map(text), ['Other checkout']);
  assert.match(text(page.doc.getElementById(cardOf(page, 'feat-a / far').querySelector('.gate-card__link').getAttribute('aria-describedby'))), /From another checkout\.$/);
  const flat = cardOf(page, 'flat');
  assert.equal(flat.getAttribute('data-openable'), 'false');
  assert.equal(flat.querySelector('a'), null, 'a flat run has no link and so no tab stop');
  assert.equal(text(flat.querySelector('.gate-card__note')), 'Decide in a terminal. This run has no feature folder, so it cannot be opened here.');
  assert.deepEqual(flat.querySelectorAll('.tag').map(text), ['No feature folder']);
});

test('CD-B1 gate card fallback: no workflow gives the gate id as the name, no prompt, the fallback rail line and the short description', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '', fetch: homeFetch(() => body([frow('a', 4)]), () => errorReply(502, 'core-error')) });
  const card = cardsOf(page)[0];
  assert.equal(text(card.querySelector('.gate-card__name')), 'gate-a');
  assert.ok(card.querySelector('.gate-card__name').querySelector('.mono'));
  assert.equal(card.querySelector('.gate-card__prompt'), null);
  assert.equal(text(card.querySelector('.rail-fallback')), 'Step 5 of 5 · workflow unavailable');
  assert.equal(text(card.querySelector('.gate-card__kind')), 'Approval gate', 'the kind comes from the current node');
  assert.equal(text(page.doc.getElementById(card.querySelector('.gate-card__link').getAttribute('aria-describedby'))), 'Gate gate-a. Waiting for you for 1 min. Feature Delivery, step 5 of 5.');
});

test('CD-B1 the wait on a card follows the 1 s tick', async () => {
  mods.home.resetHome();
  let at: string | null = null;
  const page = await start({ hash: '', fetch: homeFetch(() => { at ??= agoIso(5 * MIN_MS); return body([frow('a', 4, { updatedAt: at })]); }) });
  assert.equal(text(page.main.querySelector('.gate-card__wait-dur')), '5 min');
  await advance(3 * MIN_MS);
  assert.equal(text(page.main.querySelector('.gate-card__wait-dur')), '8 min');
  assert.match(text(page.doc.getElementById(cardsOf(page)[0].querySelector('.gate-card__link').getAttribute('aria-describedby'))), /Waiting for you for 8 min\./);
});

test('CD-B3 rows: a badge only for exceptions (stale, and every Finished row), the step column, the muted task id', async () => {
  mods.home.resetHome();
  const runs = () => [
    frow('live', 2), frow('silent', 2, { updatedAt: agoIso(30 * 3_600_000) }), frow('ok', 5), frow('no', 1, { state: 'REJECTED' }),
  ];
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs())) });
  const badgeOf = (id: string) => rowOf(page, `feat-a / ${id}`).querySelector('.run-row__state').children.map(text);
  assert.deepEqual(badgeOf('live'), [], 'a running row with fresh data has no badge');
  assert.deepEqual(badgeOf('silent'), ['Stale']);
  assert.deepEqual(badgeOf('ok'), ['Completed']);
  assert.deepEqual(badgeOf('no'), ['Rejected']);
  assert.equal(text(rowOf(page, 'feat-a / live').querySelector('.run-row__step')), '3 / 5');
  assert.deepEqual(rowOf(page, 'feat-a / live').querySelector('.run-row__step').children.map(text), ['3', ' / 5']);
  assert.equal(text(rowOf(page, 'feat-a / ok').querySelector('.run-row__sp')), 'all steps done');
  assert.equal(text(rowOf(page, 'feat-a / no').querySelector('.run-row__sp')), 'stopped at gate-0');
  assert.match(text(page.doc.getElementById(rowOf(page, 'feat-a / live').querySelector('.run-row__link').getAttribute('aria-describedby'))), /^Feature Delivery\. Running\./, 'the description still says the state word');
  assert.ok(rowOf(page, 'feat-a / live').querySelector('.run-row__task'));
});

test('CD-B4 tiles: one fact each, a long and a short form, in the accessible name; the check sits on the count line', async () => {
  mods.home.resetHome();
  const runs = () => [frow('w', 4, { updatedAt: agoIso(134 * MIN_MS) }), frow('r', 2), frow('s', 2, { updatedAt: agoIso(50 * 3_600_000) }), frow('c1', 5), frow('c2', 5), frow('x', 1, { state: 'REJECTED' })];
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs())) });
  const tiles = page.main.querySelectorAll('.tile');
  const sub = (t: El) => [text(t.querySelector('.tile__sub-long')), text(t.querySelector('.tile__sub-short'))];
  assert.deepEqual(sub(tiles[0]), ['longest wait 2 h 14 min', 'longest wait 2 h 14 min']);
  assert.equal(text(tiles[0].querySelector('.tile__sub-short').children[0]), 'longest wait ');
  assert.equal(tiles[0].querySelector('.tile__sub-short').children[0].classList.contains('vh'), true);
  assert.deepEqual(sub(tiles[1]), ['1 stale, no update for 2 d 2 h', '1 stale']);
  assert.deepEqual(sub(tiles[2]), ['2 completed, 1 rejected', '1 rejected']);
  tiles[0].fire('click');
  const pressed = page.main.querySelector('.tile');
  assert.ok(pressed.querySelector('.tile__count').querySelector('.tile__check'), 'the check is on the count line');
  assert.equal(pressed.querySelector('.tile__label').querySelector('.tile__check'), null);
  mods.home.resetHome();
});

test('CD-B4 tiles: the facts follow the tick', async () => {
  mods.home.resetHome();
  let at: string | null = null;
  const page = await start({ hash: '', fetch: homeFetch(() => { at ??= agoIso(5 * MIN_MS); return body([frow('w', 4, { updatedAt: at })]); }) });
  assert.equal(text(page.main.querySelector('.tile__sub-long')), 'longest wait 5 min');
  await advance(2 * MIN_MS);
  assert.equal(text(page.main.querySelector('.tile__sub-long')), 'longest wait 7 min');
});

test('CD-B8 run head: crumb to Runs, mono title with a muted task id, meta in order, and the step counter per run state', async () => {
  mods.home.resetHome();
  const cases: Array<[any, string, string]> = [
    [frow('run-1', 4), 'step 5 of 5', '5'],
    [frow('run-1', 5), 'all 5 steps done', ''],
    [frow('run-1', 1, { state: 'REJECTED' }), 'stopped at step 2 of 5', '2'],
  ];
  for (const [r, copy, numeral] of cases) {
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(r, WF_FEATURE, [ev(5, 'start', null)])) });
    const crumb = page.main.querySelector('.run-head__crumb');
    assert.equal(crumb.getAttribute('aria-label'), 'Breadcrumb');
    assert.equal(crumb.querySelector('a').getAttribute('href'), '#/');
    assert.equal(text(crumb.querySelector('a')), 'Runs');
    assert.equal(text(crumb.querySelector('.mono')), 'feat-a');
    const title = heading(page);
    assert.equal(text(title), 'feat-a / run-1', 'the accessible text is slug / taskId');
    assert.equal(text(title.querySelector('.run-head__task')), ' / run-1');
    assert.equal(title.getAttribute('tabindex'), '-1');
    const step = page.main.querySelector('.run-head__step');
    assert.equal(text(step), copy);
    assert.equal(text(step.querySelector('.run-head__step-n') ?? { textContent: '' }), numeral);
    const items = page.main.querySelector('.run-head__meta').children.filter((c: El) => c.getAttribute('aria-hidden') !== 'true').map(text);
    assert.match(items[1], /^Feature Delivery$/);
    assert.match(items[2], /^started /);
    assert.match(items[3], /^revision 1$/);
    assert.match(items[4], /^Updated /);
    uninstallPage();
    mock.timers.reset();
  }
});

test('CD-B7 the full rail names its duration under every node and keeps the words in the node name', async () => {
  mods.home.resetHome();
  let fixed: any[] | null = null;
  const events = () => (fixed ??= [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve', forced: true }), ev(30, 'complete-stage', 'design', { outcome: 'passed' }), ev(20, 'complete-stage', 'planning', { outcome: 'passed' })]);
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(frow('run-1', 4, { updatedAt: fixed?.[0]?.at ?? agoIso(MIN_MS) }), WF_FEATURE, events())) });
  const lines = page.main.querySelectorAll('.rail__dur');
  assert.deepEqual(lines.map(text), ['10 min', '10 min', '10 min', '10 min', 'for 20 min']);
  assert.ok(lines.every((l) => l.getAttribute('aria-hidden') === 'true'));
  assert.equal(lines[4].getAttribute('data-tone'), 'awaiting');
  assert.equal(lines[0].getAttribute('data-tone'), null);
  await advance(5 * MIN_MS);
  assert.equal(text(page.main.querySelectorAll('.rail__dur')[4]), 'for 25 min', 'the cursor duration follows the tick');
});

test('CD-B8 the run route loads with a real crumb and title, then meta, step, rail card and slot blocks', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1' ? new Promise<Reply>(() => {}) : standard(target, init)) });
  assert.equal(text(heading(page)), 'feat-a / run-1', 'the title is real text from the route params');
  assert.equal(text(page.main.querySelector('.run-head__crumb').querySelector('a')), 'Runs');
  assert.ok(page.main.querySelector('.run-head__step').getAttribute('hidden') !== null, 'no step counter before data');
  await advance(400);
  assert.deepEqual(page.main.querySelectorAll('.skel').map((x) => x.className.replace('skel ', '')), ['skel--meta', 'skel--stepline', 'skel--railcard', 'skel--slot', 'skel--timeline']);
});


// ---- E.1 review r3 -----------------------------------------------------------------------------------------------

test('R3-7 stale data: the card wait, the Needs-you subline and the description stop counting and read "since"; they count again when fresh', async () => {
  mods.home.resetHome();
  let down = false;
  let at: string | null = null;
  const page = await start({ hash: '', fetch: (target, init) => (target === '/api/runs' && down ? errorReply(502, 'core-error') : homeFetch(() => { at ??= agoIso(10 * MIN_MS); return body([frow('a', 4, { updatedAt: at })]); })(target, init)) });
  assert.equal(text(page.main.querySelector('.gate-card__wait-word')), 'waiting');
  assert.match(text(page.main.querySelector('.gate-card__wait-dur')), /min$/);
  down = true;
  await advance(20_000);
  assert.equal(page.main.getAttribute('data-stale'), 'true');
  // R4-3: the day form off today's local date.
  const hmOf = (iso: string) => {
    const [a, b] = [new Date(iso), new Date()];
    const clock = `${String(a.getHours()).padStart(2, '0')}:${String(a.getMinutes()).padStart(2, '0')}`;
    const same = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    return same ? clock : `${a.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][a.getMonth()]} ${clock}`;
  };
  assert.equal(text(page.main.querySelector('.gate-card__wait-word')), 'since');
  assert.equal(text(page.main.querySelector('.gate-card__wait-dur')), hmOf(at!));
  assert.equal(text(page.main.querySelector('.tile__sub-long')), `waiting since ${hmOf(at!)}`);
  assert.match(text(page.doc.getElementById(cardsOf(page)[0].querySelector('.gate-card__link').getAttribute('aria-describedby'))), new RegExp(`Waiting for you since ${hmOf(at!)}\\.`));
  const frozen = text(page.main.querySelector('.gate-card__wait-dur'));
  await advance(5 * MIN_MS);
  assert.equal(text(page.main.querySelector('.gate-card__wait-dur')), frozen, 'it does not grow while stale');
});

test('R3-8 below 768 a Finished row leaves the n/m fraction out; a running row keeps it', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '', fetch: homeFetch(() => body([frow('live', 2), frow('ok', 5), frow('no', 1, { state: 'REJECTED' })])) });
  assert.equal(rowOf(page, 'feat-a / live').querySelector('.run-row__frac') !== null, true);
  assert.equal(rowOf(page, 'feat-a / ok').querySelector('.run-row__frac'), null);
  assert.equal(rowOf(page, 'feat-a / no').querySelector('.run-row__frac'), null);
  assert.equal(text(rowOf(page, 'feat-a / ok').querySelector('.run-row__step')), '5 / 5', 'the step column is unchanged');
});

test('R3-3 the run skeleton fills the head slots, so the rail card block keeps its loaded place', async () => {
  mods.home.resetHome();
  let release: (r: Reply) => void = () => {};
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1' ? new Promise<Reply>((resolve) => { release = resolve; }) : standard(target, init)) });
  await advance(400);
  const metaSlot = page.main.querySelector('.run-head__metawrap');
  const stepSlot = page.main.querySelector('.run-head__step');
  assert.deepEqual(metaSlot.children.map((c: El) => c.className.replace('skel ', '')), ['skel--meta']);
  assert.deepEqual(stepSlot.children.map((c: El) => c.className.replace('skel ', '')), ['skel--stepline']);
  assert.equal(stepSlot.getAttribute('hidden'), null);
  assert.deepEqual(page.main.querySelector('.view-body').querySelectorAll('.skel').map((c: El) => c.className.replace('skel ', '')), ['skel--railcard', 'skel--slot', 'skel--timeline'], 'the body holds the card, the slot and the timeline');
  release(runReply());
  await advance(600);
  assert.equal(page.main.querySelectorAll('.skel').length, 0);
  assert.ok(page.main.querySelector('.run-head__meta'), 'the loaded meta replaced the skeleton');
});


test('R3-8 residual: below 768 a rejected row reads "at gate-a" with "stopped " in a wide-only span, and a completed row has no step part; the text is whole from 768', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '', fetch: homeFetch(() => body([frow('ok', 5), frow('no', 1, { state: 'REJECTED' })])) });
  const sp = (id: string) => rowOf(page, `feat-a / ${id}`).querySelector('.run-row__sp');
  assert.equal(text(sp('no')), 'stopped at gate-0', 'the whole text is there for the bands that show it');
  assert.equal(text(sp('no').querySelector('.run-row__wide')), 'stopped ');
  assert.equal(text(sp('ok')), 'all steps done');
  assert.equal(rowOf(page, 'feat-a / ok').getAttribute('data-state'), 'COMPLETED', 'the CSS hides the completed step part by this state');
});

class FakeObserver {
  static all: FakeObserver[] = [];
  observed: any[] = [];
  disconnected = false;
  callback: () => void;
  constructor(callback: () => void) { this.callback = callback; FakeObserver.all.push(this); }
  observe(el: any) { this.observed.push(el); }
  disconnect() { this.disconnected = true; }
}

// ---- E.2: the live run view (slot, timeline, announcements) ---------------------------------------------------------

const att = (token: number, owner: string, state: string, startedMinAgo: number, over: any = {}) => ({ token, owner, mode: 'sequential', state, startedAt: agoIso(startedMinAgo * MIN_MS), endedAt: null, result: null, ...over });
const taskOf = (id: string, ...attempts: any[]) => ({ id, state: 'IN_PROGRESS', reason: null, budget: { used: attempts.length, limit: 20 }, attempts });
const tasksBody = (...tasks: any[]) => ({ revision: 3, graph: { tasks: [] }, tasks });
const runBodyWith = (row: any, events: any[], tasks: any = null, over: any = {}) => ({ ...runBody(row, WF_FEATURE, events), tasks, ...over });
const hasAll = (el: El, names: string[]) => names.every((name) => el.querySelector(name) !== null);

test('E.2 gate slot: registry name and prompt, two commands with their own Copy names, the read-only note, and a wait that counts from the last progress event', async () => {
  mods.home.resetHome();
  const events = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(30, 'complete-stage', 'design', { outcome: 'passed' }), ev(20, 'complete-stage', 'planning', { outcome: 'passed' }), ev(5, 'annotate', 'planning')];
  const journal = { gateId: 'gate-a', name: 'Journal name', prompt: 'Journal prompt' };
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', 4, { awaitingGate: journal, journalGateDiffers: true }), events(), tasksBody(taskOf('A.2', att(1, 'quality-guardian', 'active', 12))))) });
  const slot = page.main.querySelector('.activity--gate');
  assert.ok(slot, 'the gate slot is there');
  assert.equal(slot.getAttribute('aria-labelledby'), 'activity-title');
  assert.equal(text(slot.querySelector('.activity__gate')), 'Approval gate, waiting for you');
  assert.equal(text(slot.querySelector('.activity__name')), 'Name of gate-a', 'the registry name, not the journal copy');
  assert.equal(text(slot.querySelector('.activity__prompt')), 'Prompt of gate-a.');
  assert.equal(text(slot.querySelector('.activity__wait')), 'waiting 20 min', 'from planning completing at 20 min ago, not from the note 5 min ago');
  assert.equal(text(slot.querySelector('.activity__idline')), 'gate-a · after planning');
  assert.ok(slot.querySelector('.activity__journal'));
  assert.deepEqual(slot.querySelectorAll('.cmd__text').map(text), [
    'doflow orchestrate --action decide-gate --task-id run-1 --gate gate-a --decision approve',
    'doflow orchestrate --action decide-gate --task-id run-1 --gate gate-a --decision reject',
  ]);
  assert.deepEqual(slot.querySelectorAll('.cmd__copy').map((b: El) => b.getAttribute('aria-label')), ['Copy the approve command', 'Copy the reject command']);
  assert.deepEqual(slot.querySelectorAll('.cmd__copy').map((b: El) => b.getAttribute('data-focus-key')), ['copy:approve', 'copy:reject']);
  assert.equal(text(slot.querySelector('.activity__note')), 'The Console only reads. Deciding stays in the terminal.');
  assert.match(text(slot.querySelector('.activity__tasks')), /^1 task attempt is still active\. Open the task graph →$/);
  assert.equal(slot.querySelector('.attempts__link').getAttribute('href'), '#/run/feat-a/run-1/tasks');
  assert.equal(slot.getAttribute('data-changed'), null, 'nothing flashes on first paint');
  assert.equal(slot.querySelectorAll('button').length, 2, 'only the two Copy buttons: nothing decides');
});

test('E.2 stage slot: the registry stage, the active attempts oldest first, no plan copy; an attempt that starts is announced once and flashes only its row', async () => {
  mods.home.resetHome();
  let tasks: any = tasksBody(taskOf('A.3', att(1, 'system-architect', 'finished', 50, { result: 'FAILED', endedAt: agoIso(40 * MIN_MS) }), att(2, 'system-architect', 'active', 30)));
  const events = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(35, 'complete-stage', 'design', { outcome: 'passed' })];
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', 3), events(), tasks)) });
  const slot = page.main.querySelector('.activity--stage');
  assert.equal(text(slot.querySelector('.activity__eyebrow')), 'Now running · stage 3 of 3');
  assert.equal(text(slot.querySelector('.activity__id')), 'planning');
  assert.equal(text(slot.querySelector('.activity__purpose')), 'Purpose of planning.');
  assert.deepEqual(slot.querySelectorAll('dt').map(text), ['Skill', 'Agent', 'Running since']);
  assert.match(text(slot.querySelectorAll('dd')[2]), /^\d\d:\d\d \(35 min\), when design completed, passed$/);
  assert.equal(text(slot.querySelector('.activity__count')), '1 active');
  assert.equal(text(slot.querySelector('.attempt')), 'A.3system-architectsequential · attempt 2 · since ' + text(slot.querySelector('.attempt__meta')).split('since ')[1]);
  assert.equal(slot.querySelector('.attempts__link').getAttribute('data-focus-key'), 'attempts-graph');
  assert.equal(page.region.textContent, '');
  tasks = tasksBody(taskOf('A.3', att(1, 'system-architect', 'finished', 50, { result: 'FAILED', endedAt: agoIso(40 * MIN_MS) }), att(2, 'system-architect', 'active', 30)), taskOf('B.1', att(1, 'core-implementer', 'active', 0)));
  await advance(3_000);
  assert.equal(text(page.region), 'B.1 started by core-implementer.');
  const rows = page.main.querySelectorAll('.attempt');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r: El) => r.getAttribute('data-changed')), [null, 'true'], 'only the new attempt is marked');
  assert.equal(page.main.querySelector('.activity--stage').getAttribute('data-changed'), null, 'the slot did not change');
  tasks = null;
  await advance(3_000);
  assert.equal(text(page.main.querySelector('.attempts__empty')), 'This run has no task plan, so there are no task attempts to show.');
  assert.equal(page.main.querySelector('.attempts__link'), null, 'no plan, no link');
});

test('E.2 the slot flashes when the step changes, and the rail announcement keeps the poll', async () => {
  mods.home.resetHome();
  let cursor = 2;
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', cursor), [ev(60, 'start', null), ev(5, 'complete-stage', 'discovery', { outcome: 'passed' })])) });
  assert.equal(page.main.querySelector('.activity--stage').getAttribute('data-changed'), null);
  cursor = 4;
  await advance(3_000);
  assert.equal(page.main.querySelector('.activity--gate').getAttribute('data-changed'), 'true');
  assert.equal(text(page.region), 'gate-a is waiting for you.');
  await advance(3_500);
  assert.equal(page.main.querySelector('.activity--gate').getAttribute('data-changed'), null, 'the mark lasts one poll interval');
});

test('E.2 finished and no-timeline slots: the run took, the counts; an unreadable timeline reads as not available and the card says why', async () => {
  mods.home.resetHome();
  const done = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', 5), [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(30, 'complete-stage', 'design', { outcome: 'passed' }), ev(20, 'complete-stage', 'planning', { outcome: 'passed' }), ev(15, 'decide-gate', 'gate-a', { decision: 'approve' }), ev(15, 'complete-run', null)])) });
  const slot = done.main.querySelector('.activity--done');
  assert.equal(text(slot.querySelector('.activity__title')), 'Run completed');
  assert.match(text(slot.querySelector('.activity__summary')), /^Took 45 min, from \d\d:\d\d to \d\d:\d\d\.$/);
  assert.equal(text(slot.querySelector('.activity__counts')), '5 steps: 3 passed, 2 approved.');
  assert.equal(done.main.querySelector('.tl__now'), null, 'a finished run has no now line');
  uninstallPage();
  mock.timers.reset();
  mods.home.resetHome();
  const none = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', 2), [], null, { timeline: null, tasksReason: 'no-plan' })) });
  const stage = none.main.querySelector('.activity--stage');
  assert.deepEqual(stage.querySelectorAll('dd').map(text).slice(-2), ['not available', 'not available']);
  assert.match(text(none.main.querySelector('.timeline__note')), /^The run’s event record could not be read just now\./);
  assert.equal(none.main.querySelector('.tl'), null);
});

test('E.2 timeline: rows on one axis in program order, bars placed with custom properties only, a live bar and a now line, the list newest first, the toggle', async () => {
  mods.home.resetHome();
  const events = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(45, 'annotate', 'discovery'), ev(40, 'decide-gate', 'gate-0', { decision: 'approve', forced: true }), ev(30, 'complete-stage', 'design', { outcome: 'failed' })];
  let frozen: any = null; // later in the test the body stops changing, so only the tick moves things
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => frozen ?? runBodyWith(frow('run-1', 3), events())) });
  const rows = page.main.querySelectorAll('.tl__row');
  assert.deepEqual(rows.map((r: El) => text(r.querySelector('.tl__id'))), ['discovery', 'gate-0', 'design', 'planning', 'gate-a']);
  const bar = (row: El, kind: string) => row.querySelector(`.tl__bar[data-kind="${kind}"]`);
  assert.equal(bar(rows[0], 'stage').getAttribute('data-tone'), 'done');
  assert.equal(bar(rows[1], 'wait').getAttribute('data-forced'), 'true');
  assert.equal(bar(rows[2], 'stage').getAttribute('data-tone'), 'failed');
  assert.equal(bar(rows[3], 'live').getAttribute('data-tone'), 'running');
  assert.equal(rows[4].querySelectorAll('.tl__bar').length, 0, 'a step not reached has no bar');
  assert.equal(text(rows[1].querySelector('.tl__dur')), 'waited 10 min, forced');
  const live = bar(rows[3], 'live');
  const [start0, end0] = [Number(live.style.vars.get('--tl-start')), Number(live.style.vars.get('--tl-end'))];
  assert.ok(start0 > 0 && end0 > start0 && end0 <= 1, 'fractions of the track');
  assert.deepEqual([...live.attrs.keys()].filter((k) => k === 'style'), [], 'no style attribute: custom properties only');
  assert.equal(rows[0].querySelector('.tl__mark') !== null, true, 'the note on discovery is a marker on its row');
  const now = page.main.querySelector('.tl__now');
  assert.ok(now);
  assert.match(text(page.main.querySelector('.tl__nowlabel')), /^now \d\d:\d\d$/);
  assert.equal(text(page.main.querySelector('ol.vh').querySelector('li')).startsWith('discovery. Stage. Done, passed.'), true, 'the accessible copy follows the drawing');
  assert.deepEqual(page.main.querySelectorAll('.tl-item').map((i: El) => text(i.querySelector('.tl-item__words'))), ['design completed, failed', 'gate-0 approved, forced', 'Note added on discovery', 'discovery completed, passed', 'Run started']);
  assert.equal(page.main.querySelector('.timeline').getAttribute('data-view'), 'chart');
  const toggle = page.main.querySelector('.timeline__view');
  assert.equal(text(toggle), 'Show as list');
  toggle.fire('click');
  assert.equal(page.main.querySelector('.timeline').getAttribute('data-view'), 'list');
  assert.equal(text(page.main.querySelector('.timeline__view')), 'Show as chart');
  await advance(3_000);
  assert.equal(page.main.querySelector('.timeline').getAttribute('data-view'), 'list', 'the choice survives the poll');
  frozen = runBodyWith(frow('run-1', 3), events());
  await advance(3_000);
  const before = Number(page.main.querySelector('.tl__bar[data-kind="live"]').style.vars.get('--tl-end'));
  await advance(60_000);
  assert.ok(Number(page.main.querySelector('.tl__bar[data-kind="live"]').style.vars.get('--tl-end')) > before, 'the tick moves the live bar');
});

test('E.2 stale data: no figure grows, durations read as stamps and the now line says the data is old', async () => {
  mods.home.resetHome();
  let down = false;
  const events = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(30, 'complete-stage', 'design', { outcome: 'passed' })];
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1' && down ? errorReply(502, 'core-error') : runRoute(() => runBodyWith(frow('run-1', 3), events()))(target, init)) });
  assert.match(text(page.main.querySelector('.activity__since')), /^ \(30 min\)$/);
  down = true;
  await advance(20_000);
  assert.equal(page.main.getAttribute('data-stale'), 'true');
  assert.equal(text(page.main.querySelector('.activity__since')), '');
  assert.match(text(page.main.querySelector('.tl__nowlabel')), /^data as of \d\d:\d\d:\d\d$/);
  assert.match(text(page.main.querySelector('.tl__row[data-state="running"]').querySelector('.tl__dur')), /^since \d\d:\d\d$/);
  const frozen = text(page.main.querySelector('.tl__nowlabel'));
  await advance(5 * MIN_MS);
  assert.equal(text(page.main.querySelector('.tl__nowlabel')), frozen, 'it does not move while stale');
});

test('E.2 the list keeps the 20 newest until asked, and the button keeps its place', async () => {
  mods.home.resetHome();
  const many = () => Array.from({ length: 30 }, (_, i) => ev(60 - i, 'annotate', 'discovery'));
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', 0), [ev(61, 'start', null), ...many()])) });
  assert.equal(page.main.querySelectorAll('.tl-item').length, 20);
  const more = page.main.querySelector('.timeline__more');
  assert.equal(text(more), 'Show all 31 events');
  assert.equal(more.getAttribute('data-focus-key'), 'tl-more');
  more.fire('click');
  assert.equal(page.main.querySelectorAll('.tl-item').length, 31);
  assert.equal(text(page.main.querySelector('.timeline__more')), 'Show the newest 20');
});

test('R4-1 the rail scroller is watched for resizes; the observer goes when the rail is replaced and when the view unmounts', async () => {
  mods.home.resetHome();
  FakeObserver.all = [];
  // E.2 adds the timeline's observer beside the rail's: this test follows the rail's.
  const rails = () => FakeObserver.all.filter((o) => o.observed[0] && o.observed[0].classList.contains('rail-scroll'));
  const timelines = () => FakeObserver.all.filter((o) => o.observed[0] && o.observed[0].classList.contains('timeline__chart'));
  let row0 = () => frow('run-1', 2);
  Object.defineProperty(globalThis, 'ResizeObserver', { value: FakeObserver, configurable: true, writable: true });
  try {
    const next = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(row0(), WF_FEATURE, [ev(5, 'start', null)])) });
    assert.equal(rails().length, 1);
    assert.ok(rails()[0].observed[0].classList.contains('rail-scroll'), 'it observes the scroller');
    row0 = () => frow('run-1', 3);
    await advance(3_000);
    assert.ok(rails()[0].disconnected, 'the replaced scroller lets its observer go');
    assert.equal(rails().length, 2);
    assert.equal(rails()[1].disconnected, false);
    next.location.hash = '#/';
    next.win.dispatch('hashchange');
    assert.ok(rails()[1].disconnected, 'leaving the view disconnects it');
    assert.ok(timelines().length >= 2 && timelines().every((o) => o.disconnected), 'E.2: the timeline observer goes the same way');
    await advance(300);
  } finally {
    delete (globalThis as any).ResizeObserver;
  }
});

// ---- E.3: the task graph (board, lane list, panel, keyboard) -------------------------------------------------------

const gtask = (id: string, deps: string[] = [], owner: string | null = 'core-implementer') => ({ id, phase: id.split('.')[0], owner, taskDeps: deps, parallel: false });
const gstate = (id: string, state: string, reason: string, ...attempts: any[]) => ({ id, state, reason, budget: { used: attempts.length, limit: 20 }, attempts });
const graphTasks = (graph: any[], rows: any[]) => ({ revision: 3, graph: { digest: `sha256:${'a'.repeat(64)}`, graphPlan: true, tasks: graph, overlaps: [] }, tasks: rows });
// Two roots, one task behind both, one behind that in another lane, and a two-task cycle.
const GRAPH_PLAN = () => graphTasks(
  [gtask('A.1'), gtask('A.2', [], 'quality-guardian'), gtask('B.1', ['A.1', 'A.2']), gtask('C.1', ['B.1'], 'quality-guardian'), gtask('X.1', ['X.2'], null), gtask('X.2', ['X.1'], null)],
  [gstate('A.1', 'RUNNING', 'active-attempt', att(1, 'worker-a', 'active', 12)), gstate('A.2', 'SUCCEEDED', 'completed', att(1, 'quality-guardian', 'finished', 50, { result: 'COMPLETED', endedAt: agoIso(40 * MIN_MS) })),
    gstate('B.1', 'PLANNED', 'unmet-dependency'), gstate('C.1', 'PLANNED', 'unmet-dependency'), gstate('X.1', 'PLANNED', 'unmet-dependency'), gstate('X.2', 'PLANNED', 'unmet-dependency')],
);
const graphRoute = (tasks: () => any, over: () => any = () => ({})) => runRoute(() => runBodyWith(frow('run-1', 3), [ev(60, 'start', null)], tasks(), over()));
const gcardOf = (page: Page, id: string): any => page.main.querySelectorAll('.gcard').find((c: El) => c.getAttribute('data-card') === id);
const growOf = (page: Page, id: string): any => page.main.querySelectorAll('.grow__btn').find((c: El) => c.getAttribute('data-row') === id);

test('E.3 board: one card per task in a lane by owner, an edge per dependency, a layer head per column, and a single tab stop', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(GRAPH_PLAN) });
  assert.equal(text(heading(page)), 'Tasks');
  assert.equal(apiCalls(page, '/api/runs/feat-a/run-1').length >= 1, true, 'it reads the run route');
  const board = page.main.querySelector('.graph__board');
  assert.equal(board.getAttribute('role'), 'group');
  assert.equal(board.getAttribute('aria-label'), 'Task board: 6 tasks in 4 lanes, laid out by dependency');
  assert.deepEqual(page.main.querySelectorAll('.gcard').map((c: El) => c.getAttribute('data-card')), ['A.1', 'A.2', 'B.1', 'C.1', 'X.1', 'X.2']);
  assert.deepEqual(page.main.querySelectorAll('.graph__lanename').map(text), ['worker-a', 'quality-guardian', 'core-implementer', 'unassigned'], 'lanes in order of first appearance: A.1 has an active attempt, B.1 declares core-implementer');
  assert.deepEqual(page.main.querySelectorAll('.graph__layerhead').map(text), ['Layer 1', 'Layer 2', 'Layer 3', 'Unresolved']);
  assert.equal(page.main.querySelectorAll('.graph__edge').length, 3, 'A.1>B.1, A.2>B.1, B.1>C.1; none inside the unresolved column');
  assert.equal(text(page.main.querySelector('.graph__summary')), '6 tasks · 4 lanes · 1 running · 1 done · 4 planned');
  assert.match(text(page.main.querySelector('.graph__unresolved')), /^2 tasks have no place in the layers/);
  assert.equal(page.main.querySelectorAll('.gcard').filter((c: El) => c.getAttribute('tabindex') === '0').length, 1, 'one tab stop');
  assert.equal(gcardOf(page, 'A.1').getAttribute('tabindex'), '0');
  assert.equal(gcardOf(page, 'A.1').getAttribute('data-state'), 'running');
  assert.equal(gcardOf(page, 'A.2').getAttribute('data-state'), 'done');
  assert.equal(gcardOf(page, 'X.1').getAttribute('data-unresolved'), 'true');
  assert.equal(text(gcardOf(page, 'A.1')), 'A.1Running1 of 20 attempts');
  assert.match(gcardOf(page, 'B.1').getAttribute('aria-label'), /^B\.1, Planned, 0 of 20 attempts, lane core-implementer, layer 2, waits for A\.1, A\.2$/);
  assert.equal(gcardOf(page, 'B.1').style.getPropertyValue('--g-x') !== '', true);
  assert.equal(board.style.getPropertyValue('--g-w') !== '', true);
  assert.equal(page.main.querySelectorAll('.glane').length, 4, 'the lane list has the same lanes');
  assert.equal(page.main.querySelector('.graph[data-open]').getAttribute('data-open'), 'false');
  assert.equal(page.main.querySelector('.graph__panel').getAttribute('hidden'), '');
  assert.ok(!tags(page.main).includes('script'));
});

test('E.3 keys and panel: arrows walk the lane and the lanes, a click opens the panel with the attempts, Escape closes it and returns the focus', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(GRAPH_PLAN) });
  const board = page.main.querySelector('.graph__board');
  const press = (from: string, key: string) => { const ev2 = board.fire('keydown', { key, target: gcardOf(page, from) }); return ev2.defaultPrevented; };
  // lanes: worker-a [A.1] | quality-guardian [A.2, C.1] | core-implementer [B.1] | unassigned [X.1, X.2]
  assert.equal(press('A.1', 'ArrowDown'), true);
  assert.equal(page.doc.activeElement.getAttribute('data-card'), 'A.2');
  assert.equal(gcardOf(page, 'A.2').getAttribute('tabindex'), '0');
  assert.equal(gcardOf(page, 'A.1').getAttribute('tabindex'), '-1', 'the tab stop moves with the focus');
  assert.equal(press('A.2', 'ArrowRight'), true);
  assert.equal(page.doc.activeElement.getAttribute('data-card'), 'C.1');
  assert.equal(press('C.1', 'ArrowRight'), false, 'the end of the lane does not move and does not swallow the key');
  assert.equal(press('C.1', 'Home'), true);
  assert.equal(page.doc.activeElement.getAttribute('data-card'), 'A.2');

  const a1 = gcardOf(page, 'A.1');
  assert.equal(a1.getAttribute('aria-expanded'), 'false');
  a1.fire('click');
  assert.equal(a1.getAttribute('aria-expanded'), 'true');
  const panel = page.main.querySelector('.graph__panel');
  assert.equal(panel.getAttribute('hidden'), null);
  assert.equal(page.main.querySelector('.graph').getAttribute('data-open'), 'true');
  assert.equal(text(panel.querySelector('.graph__paneltitle')), 'A.1');
  assert.deepEqual(panel.querySelectorAll('dt').map(text), ['Phase', 'Lane', 'Planned owner', 'Attempts', 'Position', 'Waits for']);
  assert.deepEqual(panel.querySelectorAll('dd').map(text), ['A', 'worker-a (running an attempt)', 'core-implementer', '1 of 20 attempts', 'Layer 1', 'nothing']);
  assert.equal(text(panel.querySelector('.gdetail__why')), 'An attempt is running.');
  assert.equal(panel.querySelectorAll('.gattempt').length, 1);
  assert.match(text(panel.querySelector('.gattempt')), /^Attempt 1worker-a · sequentialactivesince \d\d:\d\d$/);
  assert.equal(page.main.querySelectorAll('.graph__edge').filter((e: El) => e.getAttribute('data-active') === 'true').length, 1, 'the edge A.1>B.1 is marked');
  assert.equal(panel.querySelector('.graph__close').getAttribute('aria-label'), 'Close the details of A.1');
  assert.equal(panel.querySelectorAll('input, textarea, select').length, 0);

  // Escape inside the panel closes it and puts the focus back on the card.
  page.main.querySelector('.graph').fire('keydown', { key: 'Escape', target: panel.querySelector('.graph__close') });
  assert.equal(panel.getAttribute('hidden'), '');
  assert.equal(a1.getAttribute('aria-expanded'), 'false');
  assert.ok(page.doc.activeElement === a1, 'the focus is back on the card');
  // Escape with the focus on a card closes the panel and leaves the focus alone.
  a1.fire('click');
  assert.equal(a1.getAttribute('aria-expanded'), 'true');
  page.doc.activeElement = gcardOf(page, 'B.1');
  page.main.querySelector('.graph').fire('keydown', { key: 'Escape', target: gcardOf(page, 'B.1') });
  assert.equal(a1.getAttribute('aria-expanded'), 'false');
  assert.ok(page.doc.activeElement === gcardOf(page, 'B.1'), 'the focus stayed on B.1');
  // The same control again closes it (aria-expanded is a toggle).
  a1.fire('click');
  a1.fire('click');
  assert.equal(a1.getAttribute('aria-expanded'), 'false');
});

test('E.3 a poll that changes the tasks keeps the selected task open and the tab stop; one that changes only the timeline re-mounts nothing', async () => {
  mods.home.resetHome();
  let rows = GRAPH_PLAN();
  let events = [ev(60, 'start', null)];
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: runRoute(() => runBodyWith(frow('run-1', 3), events, rows)) });
  gcardOf(page, 'B.1').fire('click');
  page.doc.activeElement = gcardOf(page, 'B.1');
  const view = page.main.querySelector('.graph');
  events = [...events, ev(1, 'annotate', 'planning')];
  await advance(3_000);
  assert.equal(page.main.querySelector('.graph'), view, 'a timeline-only change leaves the board in place');
  rows = graphTasks(rows.graph.tasks, [...rows.tasks.slice(0, 2), gstate('B.1', 'RUNNING', 'active-attempt', att(1, 'worker-b', 'active', 1)), ...rows.tasks.slice(3)]);
  await advance(3_000);
  assert.notEqual(page.main.querySelector('.graph'), view, 'a task change re-mounts it');
  assert.equal(gcardOf(page, 'B.1').getAttribute('aria-expanded'), 'true', 'B.1 is still open');
  assert.equal(text(page.main.querySelector('.graph__paneltitle')), 'B.1');
  assert.equal(text(page.main.querySelector('.graph__panel').querySelector('.badge')), 'Running');
  assert.equal(page.doc.activeElement && page.doc.activeElement.getAttribute('data-card'), 'B.1', 'the focus came back to the card by its focus key');
  assert.ok(page.doc.activeElement === gcardOf(page, 'B.1'), 'and it is the new card');
  // A selected task that leaves the plan closes the panel.
  rows = graphTasks(rows.graph.tasks.filter((t: any) => t.id !== 'B.1'), rows.tasks.filter((r: any) => r.id !== 'B.1'));
  await advance(3_000);
  assert.equal(page.main.querySelector('.graph').getAttribute('data-open'), 'false');
});

test('E.3 lane list: each lane is a section with its tasks in layer order, dependencies as text, and a row opens its attempts in place', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(GRAPH_PLAN) });
  const lanes = page.main.querySelectorAll('.glane');
  assert.deepEqual(lanes.map((l: El) => text(l.querySelector('.glane__name'))), ['worker-a1 task', 'quality-guardian2 tasks', 'core-implementer1 task', 'unassigned2 tasks']);
  assert.deepEqual(lanes[1].querySelectorAll('.grow__id').map(text), ['A.2', 'C.1']);
  assert.equal(text(growOf(page, 'C.1').querySelector('.grow__line')), 'Waits for B.1 · 0 of 20 attempts');
  assert.equal(text(growOf(page, 'C.1').querySelector('.grow__layer')), 'Layer 3');
  assert.equal(text(growOf(page, 'X.1').querySelector('.grow__layer')), 'No layer');
  assert.equal(text(growOf(page, 'A.1').querySelector('.grow__line')), 'Waits for nothing · 1 of 20 attempts');
  const row = growOf(page, 'A.2');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  row.fire('click');
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  const slot = row.parent.querySelector('.grow__panel');
  assert.equal(slot.getAttribute('hidden'), null);
  assert.match(text(slot.querySelector('.gattempt')), /^Attempt 1quality-guardian · sequentialfinished, completed\d\d:\d\d to \d\d:\d\d \(10 min\)$/);
  assert.equal(page.main.querySelectorAll('.grow__panel').filter((s: El) => s.getAttribute('hidden') === null).length, 1);
  row.fire('click');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  assert.equal(slot.getAttribute('hidden'), '');
});

test('E.3 without a graph: no plan, an older plan and an empty plan each say so, with a way back to the run; nothing is drawn', async () => {
  mods.home.resetHome();
  let tasks: any = null;
  let over: any = { tasksReason: 'no-plan' };
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(() => tasks, () => over) });
  assert.equal(text(page.main.querySelector('.graph__emptytext')), 'This run has no task plan, so there is no task graph to show.');
  assert.equal(page.main.querySelector('.graph__back').getAttribute('href'), '#/run/feat-a/run-1');
  assert.equal(page.main.querySelector('.graph__board'), null);
  over = { tasksReason: 'legacy-plan' };
  await advance(3_000);
  assert.equal(text(page.main.querySelector('.graph__emptytext')), 'This run’s plan is in an older format, so its task graph cannot be shown.');
  tasks = graphTasks([], []);
  over = {};
  await advance(3_000);
  assert.equal(text(page.main.querySelector('.graph__emptytitle')), 'No tasks');
  assert.equal(page.main.querySelector('.gcard'), null);
});

test('E.3 hostile text: a task id, owner and attempt owner reach the page as text only', async () => {
  mods.home.resetHome();
  const hostile = '<img src=x onerror=alert(1)>';
  const plan = () => graphTasks([gtask('A.1', [], hostile)], [gstate('A.1', 'RUNNING', 'active-attempt', att(1, hostile, 'active', 3))]);
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(plan) });
  gcardOf(page, 'A.1').fire('click');
  assert.ok(!tags(page.main).includes('img'));
  assert.equal(text(page.main.querySelector('.graph__lanename')), hostile);
  assert.ok(text(page.main.querySelector('.gattempt__owner')).startsWith(hostile));
});

// ---- E.4: the replay bar on the run view and the task graph ---------------------------------------------------------

const replayEvents = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(30, 'complete-stage', 'design', { outcome: 'passed' }), ev(20, 'complete-stage', 'planning', { outcome: 'passed' })];
const replayOf = (page: Page): any => ({
  bar: page.main.querySelector('.replay'), range: page.main.querySelector('.replay__range'), banner: page.main.querySelector('.replay__banner'),
  read: text(page.main.querySelector('.replay__read')), button: (label: string): any => page.main.querySelectorAll('.replay__btn').find((b: El) => b.getAttribute('aria-label') === label),
});
const scrubTo = (page: Page, index: number) => { const { range } = replayOf(page); range.value = String(index); range.fire('input'); };

test('E.4 run view: the bar sits below the timeline; scrubbing draws the rail and the slot at that event, with a banner; a poll keeps the place; play runs to the end; Back to live clears it', async () => {
  mods.home.resetHome();
  // Run events at 60, 50, 40, 30 and 20 min ago plus A.2 claimed (50) and finished (40), A.1 claimed (12): ten events.
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', 4), replayEvents(), GRAPH_PLAN())) });
  const kids = page.main.querySelector('.view-body').children.filter((c: any) => c instanceof El).map((c: El) => c.className.split(' ')[0]);
  assert.ok(kids.indexOf('replay') > kids.indexOf('replay-host'), `the bar is after the run view: ${kids}`);
  const hosted = page.main.querySelector('.replay-host').children.filter((c: any) => c instanceof El).map((c: El) => c.className.split(' ')[0]);
  assert.equal(hosted[hosted.length - 1], 'timeline', `and the timeline is the last thing in it: ${hosted}`);
  let r = replayOf(page);
  assert.equal(r.bar.getAttribute('data-mode'), 'live');
  assert.equal(r.banner.getAttribute('hidden'), '', 'no banner while live');
  assert.equal(r.read, 'Live · 8 events');
  assert.equal(r.range.getAttribute('max'), '7');
  assert.equal(page.main.querySelectorAll('.replay__tick').length, 8, 'one tick per event');
  assert.equal(text(page.main.querySelector('.activity__name')), 'Name of gate-a');
  assert.ok(r.button('Next event').getAttribute('disabled') !== null, 'live is the last event: there is no next');

  scrubTo(page, 1);
  r = replayOf(page);
  assert.equal(r.bar.getAttribute('data-mode'), 'replay');
  assert.equal(r.banner.getAttribute('hidden'), null);
  assert.match(text(r.banner), /^Replaying .+ · event 2 of 8: discovery completed, passed$/);
  assert.equal(text(page.main.querySelector('.activity__name')), 'Name of gate-0', 'the slot shows the gate the run stood at then');
  assert.equal(page.main.querySelectorAll('.rail__item').filter((b: El) => b.getAttribute('data-state') === 'done').length, 1);

  r.button('Next event').fire('click');
  assert.match(text(replayOf(page).banner), /event 3 of 8: A\.2 attempt 1 started by quality-guardian$/);
  scrubTo(page, 0);
  assert.ok(replayOf(page).button('Previous event').getAttribute('disabled') !== null, 'no previous before the first event');

  await advance(3_000);
  assert.equal(replayOf(page).range.value, '0', 'a poll that changes the body keeps the place');
  assert.equal(replayOf(page).bar.getAttribute('data-mode'), 'replay');

  page.main.querySelector('.replay__speed[data-speed="16"]').fire('click');
  assert.equal(page.main.querySelector('.replay__speed[data-speed="16"]').getAttribute('aria-pressed'), 'true');
  replayOf(page).button('Play').fire('click');
  assert.ok(replayOf(page).button('Pause'), 'play turns into pause');
  await advance(1_000);
  r = replayOf(page);
  assert.equal(r.range.value, '7', 'it played to the last event');
  assert.ok(r.button('Play'), 'and paused there');
  assert.equal(r.bar.getAttribute('data-mode'), 'replay', 'the last event is still replay: Back to live leaves it');

  page.main.querySelector('.replay__live').fire('click');
  r = replayOf(page);
  assert.equal(r.bar.getAttribute('data-mode'), 'live');
  assert.equal(r.banner.getAttribute('hidden'), '');
  assert.equal(text(page.main.querySelector('.activity__name')), 'Name of gate-a');
});

test('E.4 the graph: the bar sits above the board; scrubbing redraws the cards and lanes as they stood, and nothing is drawn without a plan', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(GRAPH_PLAN) });
  let r = replayOf(page);
  assert.equal(r.read, 'Live · 4 events');
  const kids = page.main.querySelector('.view-body').children.filter((c: any) => c instanceof El).map((c: El) => c.className.split(' ')[0]);
  assert.ok(kids.indexOf('replay') < kids.indexOf('replay-host'), `the bar is above the board: ${kids}`);
  assert.ok(page.main.querySelector('.replay-host').querySelector('.graph'), 'the board is in the replayed part');
  const lanes = () => page.main.querySelectorAll('.glane__name').map(text);
  const stateOfCard = (id: string) => gcardOf(page, id).getAttribute('data-state');
  assert.deepEqual(lanes(), ['worker-a1 task', 'quality-guardian2 tasks', 'core-implementer1 task', 'unassigned2 tasks']);
  assert.equal(stateOfCard('A.2'), 'done');

  scrubTo(page, 0);
  assert.deepEqual(lanes(), ['core-implementer2 tasks', 'quality-guardian2 tasks', 'unassigned2 tasks'], 'before any attempt the lanes are the declared owners');
  assert.equal(stateOfCard('A.2'), 'pending');
  assert.match(text(replayOf(page).banner), /^Replaying .+ · event 1 of 4: Run started$/);
  scrubTo(page, 2);
  assert.equal(stateOfCard('A.2'), 'done', 'A.2 finished at its second event');
  assert.equal(stateOfCard('A.1'), 'pending', 'A.1 had not started');
  gcardOf(page, 'A.2').fire('click');
  assert.equal(text(page.main.querySelector('.graph__paneltitle')), 'A.2');
  scrubTo(page, 3);
  assert.equal(page.main.querySelector('.graph__paneltitle') && text(page.main.querySelector('.graph__paneltitle')), 'A.2', 'the open task stays open while scrubbing');
  assert.equal(stateOfCard('A.1'), 'running');

  page.main.querySelector('.replay__live').fire('click');
  assert.deepEqual(lanes(), ['worker-a1 task', 'quality-guardian2 tasks', 'core-implementer1 task', 'unassigned2 tasks']);
  assert.equal(replayOf(page).bar.getAttribute('data-mode'), 'live');
});

test('E.4 the graph on an older plan has no replay bar', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: runRoute(() => runBodyWith(frow('run-1', 3), [ev(60, 'start', null)], null, { tasksReason: 'legacy-plan' })) });
  assert.equal(page.main.querySelector('.replay'), null, 'an older plan has no graph to replay');
  assert.ok(page.main.querySelector('.graph--empty'));
});

test('E.4 a run with no recorded event has no replay bar', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', 0), [], null)) });
  assert.equal(page.main.querySelector('.replay'), null);
  assert.ok(page.main.querySelector('.timeline'));
});

test('E.4 hostile text: a task id and an owner in the replay banner reach the page as text only', async () => {
  mods.home.resetHome();
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const tasks = () => graphTasks([gtask('A.1', [], hostile)], [gstate('A.1', 'RUNNING', 'active-attempt', att(1, hostile, 'active', 12))]);
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(tasks) });
  scrubTo(page, 1);
  assert.ok(text(replayOf(page).banner).includes(hostile));
  assert.ok(!tags(page.main).includes('img') && !tags(page.main).includes('script'));
});

// ---- E.7: the Sessions view (design.md 7a V7) -----------------------------------------------------------------------

const sk = (n: number) => n.toString(16).padStart(16, '0');
const sCheckout = (n: number, over: any = {}) => ({ worktreeKey: sk(n), role: n === 1 ? 'main' : 'linked', current: n === 1, branch: `feat-${n}`, head: 'abcdef012345', headCommittedAt: null, ...over });
const sHook = (n: number, wk: number, over: any = {}) => ({
  sessionKey: sk(100 + n), worktreeKey: sk(wk), kind: 'hook', harness: 'codex', model: 'gpt-6-luna', modelFirstSeenAt: agoIso(3 * 60 * MIN_MS), startedAt: agoIso(3 * 60 * MIN_MS),
  branchAtStart: null, lastHookRecordAt: agoIso(60 * MIN_MS), launched: null, ...over,
});
const sAttempt = (token: number, task: string, over: any = {}) => ({ task, token, owner: 'core-implementer', mode: 'subagent', state: 'active', startedAt: agoIso(30 * MIN_MS), endedAt: null, result: null, worktreeKey: sk(1), run: 'local', lineage: 'main', ...over });
const sOk = (data: any) => ({ ok: true, data });
const sessionsBody = (parts: any = {}) => ({
  v: 1,
  sections: {
    observed: sOk(parts.observed ?? { v: 1, store: 'present', checkouts: [sCheckout(1), sCheckout(2), sCheckout(3)], sessions: [], truncated: false, unreadable: 0 }),
    slots: sOk(parts.slots ?? { v: 1, slots: [], unreadable: 0 }),
    runs: sOk({ v: 1, runs: [], unreadableCount: 0 }),
    tasks: sOk(parts.tasks ?? []),
    workers: sOk([]),
    roadmap: sOk(parts.roadmap ?? null),
    ...(parts.sections ?? {}),
  },
  limits: { runsInspected: 2, runsNotChecked: 0, workersChecked: 1, workersNotChecked: 3 },
});
const sessionsRoute = (build: () => any) => (target: string, init: any) => (target === '/api/sessions' ? reply(200, build()) : standard(target, init));
/** Two checkouts with records: a hook session in the main one, a dead lock and an overlap across two runs. */
const BUSY = () => sessionsBody({
  observed: { v: 1, store: 'present', checkouts: [sCheckout(1), sCheckout(2), sCheckout(3)], sessions: [sHook(1, 1), sHook(2, 2, { harness: null, model: null, modelFirstSeenAt: null })], truncated: false, unreadable: 0 },
  slots: { v: 1, slots: [{ name: 'build', holder: { label: 'build@feat-2', since: agoIso(2 * 60 * MIN_MS), alive: false, worktreeKey: sk(2) }, waiters: 0 }], unreadable: 0 },
  tasks: [{ slug: 'feat-a', revision: 1, overlaps: [{ a: 'A.4', b: 'A.6', fileCount: 2 }], active: [sAttempt(1, 'A.4'), sAttempt(1, 'A.6', { run: 'run-two', lineage: 'lin2' })] }],
});
const srowOf = (page: Page, label: string): any => page.main.querySelectorAll('.srow').find((r: El) => text(r.querySelector('.srow__name')) === label);
const slaneOf = (page: Page, key: string): any => page.main.querySelectorAll('.slane').find((l: El) => l.getAttribute('data-lane-key') === key);
const srowHeads = (page: Page) => page.main.querySelectorAll('.srow__head');

test('E.7 sessions: the route, the title and the six shapes it reads', () => {
  const { parseRoute, titleFor, navFor, VIEWS, SHAPES_USED } = mods.views;
  assert.equal(parseRoute('#/sessions').id, 'sessions');
  assert.equal(parseRoute('#/sessions/').id, 'not-found');
  assert.equal(titleFor(parseRoute('#/sessions')), 'Sessions \u00b7 DoFlow Console');
  assert.equal(navFor(parseRoute('#/sessions')), 'sessions');
  assert.deepEqual(VIEWS.sessions.shapes, ['observed', 'slots', 'list', 'attempts', 'worker-status', 'roadmap']);
  for (const shape of VIEWS.sessions.shapes) assert.ok(SHAPES_USED.includes(shape) && SHAPE_IDS.includes(shape), `${shape} is read and on the allow-list`);
  assert.equal(VIEWS.sessions.api(), '/api/sessions');
  assert.equal(VIEWS.sessions.pollMs, 10_000);
});

test('E.7 sessions: rows run current, conflict, records, none; conflicts lead in a bar; lanes, holds, footer and legend are on the page', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/sessions', fetch: sessionsRoute(BUSY) });
  assert.equal(text(heading(page)), 'Sessions');
  assert.deepEqual(current(page), ['Sessions'], 'the Sessions link is current on #/sessions');
  assert.deepEqual(page.main.querySelectorAll('.srow').map((r: El) => [text(r.querySelector('.srow__name')), r.getAttribute('data-group')]), [['feat-1', 'current'], ['feat-2', 'conflict'], ['feat-3', 'none']]);
  const bar = page.main.querySelector('.sbar');
  assert.equal(text(bar.querySelector('.sbar__title')), '2 conflicts');
  const sessions = page.main.querySelector('.sessions');
  const order = sessions.children.map((c: El) => c.className);
  assert.ok(order.indexOf('sbar') >= 0 && order.indexOf('sbar') < order.indexOf('sessions__layout'), 'the bar comes before the rows');
  assert.deepEqual(bar.querySelectorAll('.sbar__item').map((i: El) => [i.getAttribute('data-code'), text(i.querySelector('.badge'))]), [['C1', 'Overlap'], ['C3', 'Dead lock holder']]);
  assert.match(text(bar.querySelector('.sbar__text')), /^A\.4 and A\.6 A\.4 and A\.6 share 2 declared files, held by two runs$|^A\.4 and A\.6 share 2 declared files/);
  // The conflict row is tinted by data, says "Conflict" in a word, and the current row has no conflict.
  assert.equal(srowOf(page, 'feat-2').getAttribute('data-conflict'), 'true');
  assert.equal(text(srowOf(page, 'feat-2').querySelector('.badge')), 'Conflict');
  assert.equal(srowOf(page, 'feat-1').getAttribute('data-conflict'), 'true', 'the overlap is held in the main checkout too');
  // Lanes: the hook session is recorded only, never live; the dead lock is stale with a word.
  const hook = slaneOf(page, `hook:${sk(101)}`);
  assert.match(hook.getAttribute('aria-label'), /^Hook session, codex, model gpt-6-luna, started \d\d:\d\d, last hook record \d\d:\d\d, holds nothing, checkout feat-1$/);
  assert.equal(hook.getAttribute('data-state'), 'unknown');
  assert.equal(hook.querySelector('.slane__mark').getAttribute('data-mark'), 'recorded');
  assert.equal(text(hook.querySelector('.slane__state')), 'Recorded only');
  assert.match(slaneOf(page, `hook:${sk(102)}`).getAttribute('aria-label'), /^Hook session, harness not recorded, model not recorded,/);
  const lock = slaneOf(page, 'lock:build');
  assert.equal(lock.getAttribute('data-state'), 'stale');
  assert.equal(text(lock.querySelector('.slane__state')), 'Process gone');
  assert.equal(lock.querySelector('.slane__mark').getAttribute('data-mark'), 'checked');
  assert.match(text(srowOf(page, 'feat-1').querySelector('.srow__holdlist')), /A\.4 in feat-a by core-implementer/);
  // The footer: what was checked and the three blind spots; the legend says what the marks mean.
  assert.deepEqual(page.main.querySelectorAll('.sfoot__box')[0].querySelectorAll('li').map(text), ['2 runs checked', '1 worker checked, 3 not checked']);
  assert.equal(text(page.main.querySelectorAll('.sfoot__title')[1]), 'What this view cannot see');
  assert.equal(page.main.querySelectorAll('.sfoot__box')[1].querySelectorAll('li').length, 3);
  assert.match(text(page.main.querySelector('.sessions__legend')), /a process was checked.*recorded only/);
  assert.doesNotMatch(text(page.main), /\b(active|online|idle)\b/i, 'no copy claims a session is active, online or idle');
});

test('E.7 sessions: the Sessions nav link is current on #/sessions and only there', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/sessions', fetch: sessionsRoute(BUSY) });
  assert.deepEqual(current(page), ['Sessions']);
  page.location.hash = '#/workflows';
  page.win.dispatch('hashchange');
  assert.deepEqual(current(page), ['Workflows']);
});

test('E.7 sessions: one tab stop; Right enters the lanes, Down and Up walk them, Left comes back; Enter opens the panel with the command as text; Escape closes it and returns the focus', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/sessions', fetch: sessionsRoute(BUSY) });
  const host = page.main.querySelector('.sessions__rows');
  const press = (from: El, key: string) => host.fire('keydown', { key, target: from }).defaultPrevented;
  assert.deepEqual(srowHeads(page).map((h: El) => h.getAttribute('tabindex')), ['0', '-1', '-1'], 'one tab stop down the rows');
  assert.equal(press(srowHeads(page)[0], 'ArrowDown'), true);
  assert.equal(page.doc.activeElement.getAttribute('data-focus-key'), `row:${sk(2)}`);
  assert.deepEqual(srowHeads(page).map((h: El) => h.getAttribute('tabindex')), ['-1', '0', '-1']);
  assert.equal(press(srowHeads(page)[2], 'ArrowDown'), false, 'the last row does not move and does not swallow the key');
  assert.equal(press(srowHeads(page)[1], 'ArrowRight'), true);
  assert.equal(page.doc.activeElement.getAttribute('data-focus-key'), `lane:${sk(102) === '' ? '' : `hook:${sk(102)}`}`);
  assert.equal(press(page.doc.activeElement, 'ArrowDown'), true);
  assert.equal(page.doc.activeElement.getAttribute('data-focus-key'), 'lane:lock:build');
  assert.equal(press(page.doc.activeElement, 'ArrowDown'), false);
  assert.equal(press(page.doc.activeElement, 'ArrowLeft'), true);
  assert.equal(page.doc.activeElement.getAttribute('data-focus-key'), `row:${sk(2)}`);

  const lock = slaneOf(page, 'lock:build');
  const panel = page.main.querySelector('.spanel');
  assert.equal(panel.getAttribute('hidden'), '');
  lock.fire('click');
  assert.equal(slaneOf(page, 'lock:build').getAttribute('aria-expanded'), 'true');
  const open = page.main.querySelector('.spanel');
  assert.equal(open.getAttribute('hidden'), null);
  assert.equal(page.main.querySelector('.sessions').getAttribute('data-open'), 'true');
  assert.equal(text(open.querySelector('.spanel__title')), 'Lock build');
  assert.deepEqual(open.querySelectorAll('dt').map(text), ['Kind', 'Checkout', 'Label', 'Process', 'Held since', 'Waiting']);
  assert.equal(text(open.querySelector('.cmd__text')), 'doflow slot --action peek --json', 'the command is text with a Copy button, never a button that runs it');
  assert.equal(open.querySelectorAll('input, textarea, select').length, 0);
  assert.ok(page.doc.activeElement === slaneOf(page, 'lock:build'), 'the lane keeps the focus after it opens');

  page.main.querySelector('.sessions').fire('keydown', { key: 'Escape', target: open.querySelector('.spanel__close') });
  assert.equal(page.main.querySelector('.spanel').getAttribute('hidden'), '');
  assert.equal(slaneOf(page, 'lock:build').getAttribute('aria-expanded'), 'false');
  assert.equal(page.doc.activeElement.getAttribute('data-focus-key'), 'lane:lock:build', 'the focus is back on the lane');
});

test('E.7 sessions: a row collapses, and the chips filter by conflicts, records or all as a radio group', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/sessions', fetch: sessionsRoute(BUSY) });
  const chips = () => page.main.querySelectorAll('.sfilter__opt');
  assert.deepEqual(chips().map((c: El) => [text(c), c.getAttribute('aria-checked'), c.getAttribute('tabindex')]), [['Conflicts', 'false', '-1'], ['With records', 'false', '-1'], ['All', 'true', '0']]);
  chips()[0].fire('click');
  assert.deepEqual(page.main.querySelectorAll('.srow').map((r: El) => text(r.querySelector('.srow__name'))), ['feat-1', 'feat-2']);
  assert.equal(chips()[0].getAttribute('aria-checked'), 'true');
  page.main.querySelector('.sfilter').fire('keydown', { key: 'ArrowRight', target: chips()[0] });
  assert.equal(chips()[1].getAttribute('aria-checked'), 'true');
  assert.deepEqual(page.main.querySelectorAll('.srow').map((r: El) => text(r.querySelector('.srow__name'))), ['feat-1', 'feat-2'], 'with records: the two rows with a lane or hold');
  chips()[2].fire('click');
  assert.equal(page.main.querySelectorAll('.srow').length, 3);
  const head = srowHeads(page)[1];
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  head.fire('click');
  assert.equal(srowHeads(page)[1].getAttribute('aria-expanded'), 'false');
  assert.equal(srowOf(page, 'feat-2').querySelector('.srow__body').getAttribute('hidden'), '');
  chips()[0].fire('click');
  assert.ok(srowOf(page, 'feat-2'), 'a collapsed row is still listed');
});

test('E.7 sessions: no config home, only this checkout, a failed section and a failed checkout list each say so in place', async () => {
  mods.home.resetHome();
  const absent = await start({ hash: '#/sessions', fetch: sessionsRoute(() => sessionsBody({ observed: { v: 1, store: 'absent', checkouts: [sCheckout(1), sCheckout(2)], sessions: [], truncated: false, unreadable: 0 } })) });
  assert.match(text(absent.main.querySelector('.snote')), /Hook records are off on this machine: no config home/);
  assert.equal(absent.main.querySelectorAll('.srow').length, 2, 'checkouts still list');
  uninstallPage();
  mock.timers.reset();

  const empty = await start({ hash: '#/sessions', fetch: sessionsRoute(() => sessionsBody({ observed: { v: 1, store: 'present', checkouts: [sCheckout(1)], sessions: [], truncated: false, unreadable: 0 } })) });
  assert.equal(text(empty.main.querySelector('.empty__title')), 'Only this checkout, and DoFlow has no session record here yet');
  assert.equal(empty.main.querySelector('.empty__ways').children.length, 2, 'the two ways a session gets recorded');
  assert.ok(empty.main.querySelector('.sfoot'), 'the footer stays');
  assert.equal(empty.main.querySelector('.srow'), null);
  uninstallPage();
  mock.timers.reset();

  const part = await start({ hash: '#/sessions', fetch: sessionsRoute(() => sessionsBody({ sections: { slots: { ok: false, code: 'core-error' } } })) });
  assert.equal(text(part.main.querySelector('.snote')), 'Locks could not be read. DoFlow returned an error.');
  assert.equal(part.main.querySelectorAll('.srow').length, 3, 'the other sections still render');
  uninstallPage();
  mock.timers.reset();

  const none = await start({ hash: '#/sessions', fetch: sessionsRoute(() => sessionsBody({ sections: { observed: { ok: false, code: 'cannot-list-checkouts' } } })) });
  assert.match(text(none.main.querySelector('.snote')), /^Checkouts and hook records could not be read\. Git did not answer for this project\.$/);
  assert.equal(none.main.querySelector('.srow'), null);
  assert.ok(none.main.querySelector('.sfoot'));
});

/** Runs `fn` against a fresh copy of the web modules: the shared announcer of dom.js keeps a timer from an earlier test's mocked clock, which would swallow every later announcement. */
async function withFreshModules(fn: () => Promise<void>) {
  const kept = copy;
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-client-fresh-'));
  fs.cpSync(WEB_ROOT, fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, 'package.json'), '{"type":"module"}\n');
  copy = fresh;
  try { await fn(); } finally { copy = kept; fs.rmSync(fresh, { recursive: true, force: true }); }
}

test('E.7 sessions: a new conflict is announced once and flashes its row once; the first read announces nothing', async () => {
  await withFreshModules(async () => {
    mods.home.resetHome();
    let withConflict = false;
    const body = () => (withConflict
      ? sessionsBody({ tasks: [{ slug: 'feat-a', revision: 1, overlaps: [{ a: 'A.4', b: 'A.6', fileCount: 2 }], active: [sAttempt(1, 'A.4'), sAttempt(1, 'A.6', { run: 'run-two', lineage: 'lin2' })] }] })
      : sessionsBody());
    const page = await start({ hash: '#/sessions', fetch: sessionsRoute(body) });
    assert.equal(text(page.region), '', 'the first read announces nothing');
    assert.equal(page.main.querySelector('.sbar'), null);
    withConflict = true;
    await advance(10_000);
    assert.equal(text(page.region), 'New conflict: A.4 and A.6 overlap, held by two runs');
    assert.equal(srowOf(page, 'feat-1').getAttribute('data-fresh'), 'true', 'the row of the new conflict is marked for one read');
    assert.equal(text(page.main.querySelector('.sbar__title')), '1 conflict');
    await advance(10_000);
    assert.equal(srowOf(page, 'feat-1').getAttribute('data-fresh'), null, 'the mark lasts one read');
    assert.equal(text(page.region), 'New conflict: A.4 and A.6 overlap, held by two runs', 'nothing new was said');
    withConflict = false;
    await advance(10_000);
    assert.equal(page.main.querySelector('.sbar'), null);
    assert.equal(srowOf(page, 'feat-1').getAttribute('data-cleared'), 'true', 'a cleared conflict marks its row once');
  });
});

test('E.7 sessions: a poll keeps the selected lane, the open rows and the tab stop', async () => {
  mods.home.resetHome();
  let seed = 0;
  const body = () => { seed += 1; const b = BUSY(); b.limits.runsInspected = 2 + seed; return b; };
  const page = await start({ hash: '#/sessions', fetch: sessionsRoute(body) });
  srowHeads(page)[2].fire('click');
  slaneOf(page, 'lock:build').fire('click');
  assert.equal(slaneOf(page, 'lock:build').getAttribute('aria-expanded'), 'true');
  await advance(10_000);
  assert.equal(slaneOf(page, 'lock:build').getAttribute('aria-expanded'), 'true', 'the selection survives the re-mount');
  assert.equal(srowHeads(page)[2].getAttribute('aria-expanded'), 'false', 'the collapsed row stays collapsed');
  assert.match(text(page.main.querySelectorAll('.sfoot__box')[0]), /4 runs checked/, 'the body did re-mount with the new figures');
});

test('E.7 sessions hostile text: a branch, a model, an owner and a lock label reach the page as text only', async () => {
  mods.home.resetHome();
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const body = () => sessionsBody({
    observed: { v: 1, store: 'present', checkouts: [sCheckout(1, { branch: hostile })], sessions: [sHook(1, 1, { model: hostile })], truncated: false, unreadable: 0 },
    slots: { v: 1, slots: [{ name: 'build', holder: { label: hostile, since: agoIso(MIN_MS), alive: true, worktreeKey: sk(1) }, waiters: 0 }], unreadable: 0 },
    tasks: [{ slug: 'feat-a', revision: 1, overlaps: [], active: [sAttempt(1, 'A.1', { owner: hostile })] }],
  });
  const page = await start({ hash: '#/sessions', fetch: sessionsRoute(body) });
  slaneOf(page, 'lock:build').fire('click');
  assert.ok(!tags(page.main).includes('img') && !tags(page.main).includes('script'));
  assert.equal(text(srowOf(page, hostile).querySelector('.srow__name')), hostile);
  assert.ok(text(page.main.querySelector('.spanel')).includes(hostile));
});

test('E.7 sessions: the loading skeleton is three checkout rows of the loaded rows\' height', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/sessions', fetch: (target, init) => (target === '/api/sessions' ? new Promise<Reply>(() => {}) : standard(target, init)) });
  await advance(400);
  assert.equal(page.main.querySelectorAll('.skel--srow').length, 3);
  assert.equal(text(page.main.querySelector('.vh')), 'Loading sessions');
});

// ---- F.2: the Workflows view ---------------------------------------------------------------------

const CLASS_IDS = ['feature', 'bug', 'refactor', 'review', 'research', 'documentation', 'dependency-change', 'operations', 'trivial-edit'];
const wfOf = (taskClass: string, over: any = {}) => ({
  taskClass, name: `Name of ${taskClass}`,
  stages: [stageDef('one', [gateDef('gate-x', 'clarification')]), stageDef('two', [], true), stageDef('three', [gateDef('gate-y', 'approval')])], ...over,
});
const wfRoute = (list: () => any[]) => (target: string, init: any): Reply => (target === '/api/workflows' ? reply(200, { v: 1, workflows: list() }) : standard(target, init));
const wfSection = (page: Page, taskClass: string) => page.main.querySelectorAll('.wf').find((s) => s.getAttribute('data-class') === taskClass)!;

test('F.2 workflows: every class from the route gets a heading, an image with a text alternative and its ordered stage list', async () => {
  const page = await start({ hash: '#/workflows', fetch: wfRoute(() => CLASS_IDS.map((c) => wfOf(c))) });
  assert.deepEqual(apiCalls(page, '/api/workflows').length > 0, true);
  const sections = page.main.querySelectorAll('.wf');
  assert.deepEqual(sections.map((s) => s.getAttribute('data-class')), CLASS_IDS);
  for (const section of sections) {
    const taskClass = section.getAttribute('data-class')!;
    const title = section.querySelector('h2');
    assert.ok(text(title).startsWith(`Name of ${taskClass}`), 'the heading names the workflow');
    assert.equal(section.getAttribute('aria-labelledby'), title.getAttribute('id'));
    const imgs = section.querySelectorAll('img');
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].getAttribute('src'), `/diagrams/${taskClass}.svg`);
    assert.ok((imgs[0].getAttribute('alt') ?? '').length > 20, 'a non-empty text alternative');
    assert.match(imgs[0].getAttribute('alt')!, /clarification gate Name of gate-x/);
    const items = section.querySelectorAll('ol')[0].querySelectorAll('li');
    assert.equal(section.querySelectorAll('ol').length, 1);
    assert.deepEqual(items.map((li) => text(li.querySelector('.wf__id'))), ['one', 'Name of gate-x', 'two', 'three', 'Name of gate-y']);
    assert.match(text(items[2]), /optional/);
    assert.match(text(items[1]), /clarification gate/);
    assert.match(text(items[4]), /approval gate/);
  }
  assert.deepEqual(current(page), ['Workflows']);
});

test('F.2 workflows: an image that fires error is replaced by the text fallback, the list stays, the others keep their image and a poll keeps the fallback', async () => {
  const page = await start({ hash: '#/workflows', fetch: wfRoute(() => [wfOf('feature'), wfOf('bug')]) });
  const feature = wfSection(page, 'feature');
  assert.equal(feature.querySelectorAll('img').length, 1);
  feature.querySelector('img').fire('error');
  assert.equal(wfSection(page, 'feature').querySelectorAll('img').length, 0, 'no broken image');
  assert.match(text(wfSection(page, 'feature').querySelector('.wf__fallback')), /Diagram not available/);
  assert.equal(wfSection(page, 'feature').querySelectorAll('ol')[0].querySelectorAll('li').length, 5, 'the ordered list is still there');
  assert.equal(wfSection(page, 'bug').querySelectorAll('img').length, 1, 'another class keeps its image');
  assert.equal(wfSection(page, 'bug').querySelectorAll('.wf__fallback').length, 0);
  await advance(60_000);
  assert.equal(wfSection(page, 'feature').querySelectorAll('img').length, 0, 'a later render does not bring the broken image back');
  assert.equal(wfSection(page, 'feature').querySelectorAll('.wf__fallback').length, 1);
});

test('F.2 workflows: a class id that is not a plain id never reaches an image path; the list is still shown', async () => {
  const page = await start({ hash: '#/workflows', fetch: wfRoute(() => [wfOf('../escape')]) });
  const section = page.main.querySelectorAll('.wf')[0];
  assert.equal(section.querySelectorAll('img').length, 0);
  assert.equal(section.querySelectorAll('.wf__fallback').length, 1);
  assert.equal(section.querySelectorAll('li').length, 5);
});

test('F.2 workflows hostile text: names, skills, purposes and gate names reach the page as text only', async () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const workflow = wfOf('feature', { name: hostile, stages: [{ ...stageDef('one', [{ ...gateDef('g', 'approval'), name: hostile }]), skill: hostile, purpose: hostile }] });
  const page = await start({ hash: '#/workflows', fetch: wfRoute(() => [workflow]) });
  assert.equal(tags(page.main).filter((t) => t === 'img').length, 1, 'only the diagram image');
  assert.ok(!tags(page.main).includes('script'));
  assert.ok(text(page.main.querySelector('h2')).includes(hostile));
  assert.ok(text(page.main.querySelectorAll('li')[0]).includes(hostile));
});

test('F.2 workflows: an empty route body shows the empty state; a failed read shows the inline error for workflows', async () => {
  const empty = await start({ hash: '#/workflows', fetch: wfRoute(() => []) });
  assert.equal(empty.main.querySelectorAll('.wf').length, 0);
  assert.equal(text(empty.main.querySelector('.empty__title')), 'No workflows listed');
  uninstallPage();
  mock.timers.reset();
  const failed = await start({ hash: '#/workflows', fetch: (target, init) => (target === '/api/workflows' ? errorReply(502, 'core-error') : standard(target, init)) });
  await advance(400);
  assert.equal(failed.main.querySelectorAll('.wf').length, 0);
  assert.match(text(failed.main), /workflows/i);
});

// ---- V.10: the Fleet views and the stream (IC-005, IC-025, IC-026; design ui/V8.md) ------------------------------
// A fake EventSource and a scripted fetch stand in for the Console. The cases check the transport (push, then the polling
// fallback after 3 errors, on 429 and without EventSource; closed while the tab is hidden), the `live: true` rule (a body is
// patched, never re-mounted: the element and the focus survive), the tree, the stream panel and what the page may say.

const fk = (n: number) => n.toString(16).padStart(16, '0');
const P1 = fk(0x11);
const P2 = fk(0x12);
const [A_MAIN, A_SUB, A_OC, A_ORPHAN] = [fk(0xa1), fk(0xa2), fk(0xa3), fk(0xa4)];
const AT = (min: number) => new Date(Date.UTC(2026, 9, 27, 12, 0, 0) - min * 60_000).toISOString();

const fNode = (key: string, extra: any = {}) => ({
  agentKey: key, kind: 'main-session', harness: 'claude', model: 'model-a', modelBasis: 'harness-record', label: null, depth: 0, worktreeKey: fk(1),
  startedAt: AT(90), lastRecordAt: AT(3), liveness: 'not-checked', ended: null, transcript: { reader: 'claude-jsonl', linked: true, reason: null }, ...extra,
});
const fAgent = (key: string, extra: any = {}) => ({ agentKey: key, harness: 'claude', model: 'model-a', eventsPerMin: 8, toolCalls: 14, toolErrors: 1, toolDurationMs: { p50: 1200, max: 9800, n: 14 }, tokens: { input: 12400, output: 3100, cacheRead: null, cacheWrite: null, reasoning: null }, lastRecordAt: AT(3), ...extra });
const fProject = (key: string, label: string, current: boolean, nodes: any[], edges: any[] = [], traffic: any = {}) => ({
  projectKey: key, label, current, checkouts: 1, lastRecordAt: AT(3),
  tree: { ok: true, data: { v: 1, projectKey: key, nodes, edges, limits: { nodes: 256, notChecked: 0 }, unparsable: 0, masked: 0, warnings: [] } },
  traffic: { ok: true, data: { v: 1, projectKey: key, windowMin: 10, agents: nodes.filter((n) => n.transcript.linked).map((n) => fAgent(n.agentKey)), models: [{ model: 'model-a', agents: 1, eventsPerMin: 8, toolCalls: 14, tokens: null }], pairs: [], notChecked: 0, ...traffic } },
});
const fBody = (projects: any[]) => ({ v: 1, store: 'present', projects, excluded: { missing: 1, temp: 2, notDoflow: 3, unreadable: 0 }, limits: { projectsShown: projects.length, projectsNotShown: 0, truncated: false } });
const TREE_NODES = () => [
  fNode(A_MAIN),
  fNode(A_SUB, { kind: 'harness-subagent', label: 'system-architect', depth: 1, startedAt: AT(60), lastRecordAt: AT(10) }),
  fNode(A_OC, { kind: 'harness-subagent', harness: 'opencode', depth: 1, startedAt: AT(50), transcript: { reader: null, linked: false, reason: 'no-reader' } }),
  fNode(A_ORPHAN, { kind: 'doflow-run', harness: null, model: null, modelBasis: null, startedAt: AT(40), transcript: { reader: null, linked: false, reason: 'not-found' } }),
];
const TREE_EDGES = () => [{ from: A_MAIN, to: A_SUB, basis: 'harness-subagent-record' }, { from: A_MAIN, to: A_OC, basis: 'harness-subagent-record' }];
const FLEET_TWO = () => fBody([fProject(P1, 'example-project', true, TREE_NODES(), TREE_EDGES()), fProject(P2, 'other-project', false, [fNode(fk(0xb1), { liveness: 'process-seen' })])]);

/** A scripted EventSource: tests open it, emit named events and fail it. */
class FakeES {
  static all: FakeES[] = [];
  url: string;
  readyState = 0;
  closed = false;
  listeners = new Map<string, Function[]>();
  constructor(url: string) { this.url = url; FakeES.all.push(this); }
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close() { this.readyState = 2; this.closed = true; }
  emit(type: string, data?: unknown) { for (const fn of this.listeners.get(type) ?? []) fn({ type, data: data === undefined ? undefined : JSON.stringify(data), lastEventId: '' }); }
  open() { this.readyState = 1; this.emit('open'); }
  fail(state = 0) { this.readyState = state; this.emit('error'); }
}
const esOf = (match: string): FakeES => FakeES.all.filter((e) => e.url.includes(match) && !e.closed).at(-1)!;

const fleetRoute = (build: () => any = FLEET_TWO) => (target: string, init: any): Reply => (target === '/api/fleet' ? reply(200, build()) : standard(target, init));
async function startFleet(hash: string, route = fleetRoute(), root: string | null = null, eventSource: unknown = FakeES): Promise<Page> {
  FakeES.all = [];
  return start({ hash, fetch: route, eventSource: eventSource === 'absent' ? undefined : eventSource }, root);
}

test('V.10 fleet: routes take only 16-hex keys; the title, the nav item and the shapes read', () => {
  const { parseRoute, titleFor, navFor, VIEWS, SHAPES_USED } = mods.views;
  assert.equal(parseRoute('#/fleet').id, 'fleet');
  assert.deepEqual(parseRoute(`#/fleet/${P1}`).params, { project: P1 });
  assert.deepEqual(parseRoute(`#/fleet/${P1}/${A_MAIN}`).params, { project: P1, agent: A_MAIN });
  for (const bad of ['#/fleet/', '#/fleet/xyz', `#/fleet/${'A'.repeat(16)}`, `#/fleet/${P1}/${A_MAIN}/x`, `#/fleet/${P1}/not-a-key`, '#/fleet/../x', `#/fleet/${'a'.repeat(17)}`]) {
    assert.equal(parseRoute(bad).id, 'not-found', bad);
  }
  assert.equal(titleFor(parseRoute('#/fleet')), 'Fleet · DoFlow Console');
  assert.equal(navFor(parseRoute('#/fleet')), 'fleet');
  assert.equal(navFor(parseRoute(`#/fleet/${P1}/${A_MAIN}`)), 'fleet');
  assert.equal(VIEWS.fleet.live, true);
  assert.equal(VIEWS['fleet-project'].live, true);
  for (const shape of [...VIEWS.fleet.shapes, ...VIEWS['fleet-project'].shapes]) assert.ok(SHAPES_USED.includes(shape) && SHAPE_IDS.includes(shape), `${shape} is read and on the allow-list`);
  const project = fProject(P1, 'example-project', true, TREE_NODES(), TREE_EDGES());
  assert.equal(titleFor(parseRoute(`#/fleet/${P1}`), fBody([project])), 'example-project · Fleet · DoFlow Console');
  assert.equal(titleFor(parseRoute(`#/fleet/${P1}/${A_SUB}`), fBody([project])), 'system-architect · example-project · Fleet · DoFlow Console');
  assert.equal(titleFor(parseRoute(`#/fleet/${P1}`), fBody([])), 'Fleet · DoFlow Console', 'a project not in the list reads Fleet');
});

const treeItem = (page: Page, key: string): any => page.main.querySelectorAll('.fnode').find((li: El) => li.dataset.key === key);
const rowsText = (page: Page) => page.main.querySelectorAll('.project-row').map((r: El) => text(r.querySelector('.pr__link')));
const transport = (page: Page) => text(page.main.querySelector('.fleet-transport'));
const BAD_WORDS = /\b(active|online|idle|live|working|busy)\b/i;
const mutated: string[] = [];
after(() => { for (const dir of mutated) fs.rmSync(dir, { recursive: true, force: true }); });

/** A copy of the web root with one text replaced in one file, as a root `start` can boot. */
function mutatedWeb(file: string, from: string, to: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-client-mut-'));
  mutated.push(dir);
  fs.cpSync(WEB_ROOT, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  const source = fs.readFileSync(path.join(dir, file), 'utf8');
  assert.ok(source.includes(from), `${file} holds the text to mutate`);
  fs.writeFileSync(path.join(dir, file), source.replace(from, to));
  return dir;
}

/** A private copy of the web root: dom.js keeps one announcer per module instance, and a pending timer of an earlier test (mock time was reset) would hold this test's message back. */
function freshWeb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-client-fresh-'));
  mutated.push(dir);
  fs.cpSync(WEB_ROOT, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  return dir;
}

test('V.10 fleet list: the stream opens on a listed project, the rows show records only, and the footer counts what is not listed', async () => {
  const page = await startFleet('#/fleet');
  await settle();
  assert.equal(apiCalls(page, '/api/fleet').length, 1, 'no project key on the list yet: the fleet is read once');
  assert.equal(FakeES.all.length, 1);
  assert.equal(FakeES.all[0].url, `/api/stream?project=${P1}`, 'the stream opens on the first listed project; the list itself needs no agent');
  assert.deepEqual(current(page), ['Fleet']);
  assert.equal(page.doc.title, 'Fleet \u00b7 DoFlow Console');
  assert.deepEqual(rowsText(page), ['example-project', 'other-project']);
  const first = page.main.querySelectorAll('.project-row')[0];
  assert.equal(text(first.querySelector('.tag--accent')), 'this project');
  assert.equal(first.querySelector('.pr__link').getAttribute('href'), `#/fleet/${P1}`);
  assert.match(text(first), /1 checkout/);
  assert.match(text(first), /1 main session · 3 subagents/);
  assert.match(text(first), /model-a/);
  assert.match(text(first), /16\s*events\/min/);
  assert.equal(text(page.main.querySelectorAll('.project-row')[1].querySelector('.pr__seen')).trim(), '1 process seen');
  const limits = text(page.main.querySelector('.fleet-limits'));
  assert.match(limits, /Not listed/);
  assert.match(limits, /1 root no longer exists/);
  assert.match(limits, /2 under a temporary directory/);
  assert.match(limits, /3 without DoFlow state/);
  assert.match(text(page.main.querySelector('.fleet-blind')), /What this view cannot see/);
  assert.match(text(page.main.querySelector('.fleet-blind')), /no transcript reader for it|DoFlow has no transcript reader for it/);
  assert.doesNotMatch(text(page.main), BAD_WORDS, 'no row claims an agent is working now');
  const hrefs = page.main.querySelectorAll('a').map((a: El) => a.getAttribute('href'));
  assert.ok(hrefs.every((href: any) => /^#\/fleet\/[0-9a-f]{16}$/.test(href)), `no path or label in a link: ${hrefs}`);
  FakeES.all[0].open();
  FakeES.all[0].emit('snapshot', FLEET_TWO());
  await settle();
  assert.match(transport(page), /^Pushed by the Console · updated \d\d:\d\d:\d\d$/);
});

test('V.10 fleet list: no project and no user state have their own empty panels', async () => {
  const none = await startFleet('#/fleet', fleetRoute(() => fBody([])));
  await settle();
  assert.equal(text(none.main.querySelector('.empty__title')), 'No DoFlow project on this machine yet');
  assert.match(text(none.main), /doflow doctor/);
  uninstallPage();
  mock.timers.reset();
  const absent = await startFleet('#/fleet', fleetRoute(() => ({ ...fBody([]), store: 'absent' })));
  await settle();
  assert.equal(text(absent.main.querySelector('.empty__title')), 'This machine has no DoFlow user state');
  assert.doesNotMatch(text(absent.main), /doflow doctor/);
});

/** The live scenario: the tree is focused, a delta arrives. Returns what survived. */
async function liveRun(root: string | null) {
  const page = await startFleet(`#/fleet/${P1}`, fleetRoute(), root);
  const es = esOf(`project=${P1}`);
  es.open();
  es.emit('snapshot', FLEET_TWO());
  await settle();
  const tree = page.main.querySelector('.ftree');
  const sub = treeItem(page, A_SUB);
  sub.focus();
  const focusCalls = page.doc.focusLog.length;
  const next = FLEET_TWO();
  const project = next.projects[0];
  project.tree.data.nodes = [...project.tree.data.nodes.filter((n: any) => n.agentKey !== A_SUB), { ...project.tree.data.nodes.find((n: any) => n.agentKey === A_SUB), lastRecordAt: AT(1) }, fNode(fk(0xa5), { kind: 'harness-subagent', label: 'quality-guardian', depth: 1, startedAt: AT(5) })];
  project.tree.data.edges = [...TREE_EDGES(), { from: A_MAIN, to: fk(0xa5), basis: 'harness-subagent-record' }];
  es.emit('fleet', { v: 1, store: 'present', excluded: next.excluded, limits: next.limits, projects: [project], gone: [] });
  await settle();
  return {
    page,
    sameTree: page.main.querySelector('.ftree') === tree,
    sameRow: treeItem(page, A_SUB) === sub,
    focusKept: page.doc.activeElement === sub && page.doc.focusLog.length === focusCalls,
  };
}

test('V.10 fleet project: a live view is patched, never re-mounted: the tree, the focused row and the focus survive a push', async () => {
  const run = await liveRun(null);
  assert.equal(run.sameTree, true, 'the tree element is the same');
  assert.equal(run.sameRow, true, 'the focused row is the same element');
  assert.equal(run.focusKept, true, 'the focus was never taken and given back');
  const page = run.page;
  assert.ok(treeItem(page, fk(0xa5)), 'the new node is in the tree');
  assert.equal(treeItem(page, fk(0xa5)).dataset.fresh, 'true', 'a node that appears after the first paint flashes once');
  assert.equal(treeItem(page, A_SUB).dataset.fresh, undefined);
  assert.equal(text(page.main.querySelector('.fleet-title__label')), 'example-project');
  assert.equal(page.doc.title, 'example-project \u00b7 Fleet \u00b7 DoFlow Console');
});

test('control: re-mounting a live view instead of patching it loses the element and the focus (client-core red)', async () => {
  const root = mutatedWeb('app.js', "view.route.view.live === true ? 'data:live' : `data:${view.dataText}`", '`data:${view.dataText}`');
  uninstallPage();
  mock.timers.reset();
  const run = await liveRun(root);
  assert.equal(run.sameTree, false, 'a re-mount builds a new tree');
  assert.equal(run.focusKept, false, 'and the focus is given back to a new element');
});

test('V.10 fleet project: the tree orders agents, names them from records only and keeps a parentless node apart', async () => {
  const page = await startFleet(`#/fleet/${P1}`);
  const es = esOf(`project=${P1}`);
  es.open();
  es.emit('snapshot', FLEET_TWO());
  await settle();
  const items = page.main.querySelectorAll('.fnode');
  assert.deepEqual(items.map((li: El) => li.dataset.key), [A_MAIN, A_SUB, A_OC, A_ORPHAN]);
  assert.deepEqual(items.map((li: El) => li.getAttribute('aria-level')), ['1', '2', '2', '1']);
  assert.equal(items[0].getAttribute('aria-expanded'), 'true');
  assert.equal(items[1].getAttribute('aria-expanded'), null, 'a leaf has no expanded state');
  assert.equal(page.main.querySelector('.ftree').getAttribute('role'), 'tree');
  assert.equal(items[1].getAttribute('role'), 'treeitem');
  assert.match(items[1].getAttribute('aria-label'), /^system-architect\. Subagent\. claude, model model-a, from the harness record\. Started (?:[A-Z][a-z]{2} \d+ )?\d\d:\d\d, last record (?:[A-Z][a-z]{2} \d+ )?\d\d:\d\d\. Recorded, process not checked\. Transcript available\./);
  assert.match(items[2].getAttribute('aria-label'), /No transcript reader for opencode\./);
  assert.match(text(items[2]), /no transcript reader for opencode/);
  assert.match(items[3].getAttribute('aria-label'), /No parent in the records\.$/);
  assert.equal(items[3].dataset.orphanStart, 'true');
  assert.equal(items.filter((li: El) => li.getAttribute('tabindex') === '0').length, 1, 'one tab stop');
  assert.equal(items[0].getAttribute('tabindex'), '0');
  assert.doesNotMatch(text(page.main), BAD_WORDS);
  assert.doesNotMatch(items.map((li: El) => li.getAttribute('aria-label')).join(' '), BAD_WORDS);
  assert.match(text(page.main.querySelector('.fleet-crumb')), /Fleet \/ example-project/);
  assert.match(text(page.main.querySelector('.traffic')), /Traffic/);
  assert.match(text(page.main.querySelector('.together')), /No two agents share a task, files or a model in the last 10 min\./);
});

test('V.10 fleet project: the tree keyboard (arrows, Home, End, Left and Right, typeahead) and Enter selects by the route', async () => {
  const page = await startFleet(`#/fleet/${P1}`);
  const es = esOf(`project=${P1}`);
  es.open();
  es.emit('snapshot', FLEET_TWO());
  await settle();
  const tree = page.main.querySelector('.ftree');
  const key = (target: El, name: string, extra: any = {}) => tree.fire('keydown', { key: name, target, ...extra });
  treeItem(page, A_MAIN).focus();
  key(treeItem(page, A_MAIN), 'ArrowDown');
  assert.equal(page.doc.activeElement, treeItem(page, A_SUB));
  key(treeItem(page, A_SUB), 'End');
  assert.equal(page.doc.activeElement, treeItem(page, A_ORPHAN));
  key(treeItem(page, A_ORPHAN), 'Home');
  assert.equal(page.doc.activeElement, treeItem(page, A_MAIN));
  key(treeItem(page, A_MAIN), 'ArrowLeft');
  assert.equal(treeItem(page, A_MAIN).getAttribute('aria-expanded'), 'false', 'Left collapses an expanded node');
  assert.equal(treeItem(page, A_MAIN).querySelector('ul').getAttribute('hidden'), '', 'its children are hidden');
  key(treeItem(page, A_MAIN), 'ArrowDown');
  assert.equal(page.doc.activeElement, treeItem(page, A_ORPHAN), 'a hidden child is skipped');
  key(treeItem(page, A_ORPHAN), 'Home');
  key(treeItem(page, A_MAIN), 'ArrowRight');
  assert.equal(treeItem(page, A_MAIN).getAttribute('aria-expanded'), 'true', 'Right expands a collapsed node');
  key(treeItem(page, A_MAIN), 'ArrowRight');
  assert.equal(page.doc.activeElement, treeItem(page, A_SUB), 'Right on an expanded node goes to its first child');
  key(treeItem(page, A_SUB), 'ArrowLeft');
  assert.equal(page.doc.activeElement, treeItem(page, A_MAIN), 'Left on a leaf goes to its parent');
  key(treeItem(page, A_MAIN), 's');
  assert.equal(page.doc.activeElement, treeItem(page, A_SUB), 'typeahead finds "system-architect"');
  assert.equal(page.location.hash, `#/fleet/${P1}`, 'moving the focus does not select');
  key(treeItem(page, A_SUB), 'Enter');
  assert.equal(page.location.hash, `#/fleet/${P1}/${A_SUB}`, 'Enter selects by the route');
  assert.equal(esOf('agent='), undefined, 'the stream is reopened by the route change, not by the key');
});

test('V.10 fleet project: selecting an agent moves between routes without a re-mount: the focus stays, the stream is retargeted and the panel names the agent', async () => {
  const page = await startFleet(`#/fleet/${P1}`);
  const first = esOf(`project=${P1}`);
  first.open();
  first.emit('snapshot', FLEET_TWO());
  await settle();
  const tree = page.main.querySelector('.ftree');
  treeItem(page, A_SUB).focus();
  page.location.hash = `#/fleet/${P1}/${A_SUB}`;
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(page.main.querySelector('.ftree'), tree, 'the tree is the same element');
  assert.equal(page.doc.activeElement, treeItem(page, A_SUB), 'the focus stayed in the tree');
  assert.equal(first.closed, true, 'the stream without an agent is closed');
  const second = esOf(`agent=${A_SUB}`);
  assert.equal(second.url, `/api/stream?project=${P1}&agent=${A_SUB}`);
  assert.equal(treeItem(page, A_SUB).getAttribute('aria-selected'), 'true');
  assert.equal(treeItem(page, A_MAIN).getAttribute('aria-selected'), 'false');
  assert.equal(page.doc.title, 'system-architect \u00b7 example-project \u00b7 Fleet \u00b7 DoFlow Console');
  assert.equal(text(page.main.querySelector('.fpanel__title')), 'system-architect');
  assert.equal(page.main.querySelector('.fleet--project').dataset.selected, 'true');
  assert.deepEqual(current(page), ['Fleet']);
});

const reply1 = (n: number, extra: any = {}) => ({ seq: n, at: new Date(Date.UTC(2026, 9, 27, 12, 0, n)).toISOString(), kind: 'reply', agentKey: A_SUB, model: null, tool: null, text: `reply number ${n}`, args: null, cut: false, tokens: null, record: null, ...extra });
const tBody = (events: any[], extra: any = {}) => ({
  v: 1, agent: A_SUB, agentKey: A_SUB, harness: 'claude', reader: { id: 'claude-jsonl', status: 'ok' }, transcript: { linked: true, reason: null }, events,
  cursor: '1:2:3:4', reset: false, eof: true, otherRecords: 14, unparsable: 0, masked: 3, warnings: [], ...extra,
});

async function startPanel(hash = `#/fleet/${P1}/${A_SUB}`, route = fleetRoute(), root: string | null = null) {
  const page = await startFleet(hash, route, root);
  const es = esOf('agent=');
  es.open();
  es.emit('snapshot', FLEET_TWO());
  await settle();
  return { page, es };
}

test('V.10 stream panel: replies, tool calls with their result attached, usage and dividers; masked markers become chips; nothing is markup', async () => {
  const { page, es } = await startPanel();
  es.emit('transcript', tBody([
    reply1(1, { text: 'Done. password=<masked> mail <email> at <ip> <script>alert(1)</script>' }),
    reply1(2, { kind: 'tool-call', text: null, args: '{"path":"<masked>"}', tool: { name: 'Read', callKey: 'k1', status: null, bytes: null, durationMs: null } }),
    reply1(3, { kind: 'tool-result', text: null, tool: { name: 'Read', callKey: 'k1', status: 'ok', bytes: 2400, durationMs: 1200 } }),
    reply1(4, { kind: 'usage', text: null, tokens: { input: 1204, output: 312, cacheRead: 18000, cacheWrite: 0, reasoning: null } }),
    reply1(5, { kind: 'turn-end', text: null }),
  ]));
  await settle();
  const rows = page.main.querySelectorAll('.ev');
  assert.equal(rows.length, 4, 'a result is no row of its own');
  assert.deepEqual(rows.map((r: El) => r.dataset.kind), ['reply', 'tool-call', 'usage', 'turn-end']);
  assert.deepEqual(page.main.querySelectorAll('.masked').map((m: El) => text(m)), ['masked', 'email', 'ip', 'masked']);
  assert.ok(!tags(page.main).includes('script'), 'a script-looking reply is text');
  assert.match(text(rows[0]), /<script>alert\(1\)<\/script>/);
  assert.match(text(rows[1].querySelector('.ev__status')), /^ok · 2\.3 KB · 1\.2 s$/);
  assert.equal(text(rows[2]).includes('Tokens: 1,204 in · 312 out · 18,000 cache read · 0 cache write'), true);
  const list = page.main.querySelector('.stream');
  assert.equal(list.getAttribute('aria-live'), null, 'streamed text is never announced');
  assert.equal(list.getAttribute('role'), null);
  const foot = text(page.main.querySelector('.fpanel__foot'));
  assert.match(foot, /masked, best effort/);
  assert.match(foot, /Not shown: 14 other records \(prompts, thinking, attachments, system\)\. 0 unreadable\./);
  assert.match(text(page.main.querySelector('.fpanel__masked')), /3 values masked/);
  assert.doesNotMatch(text(page.main.querySelector('.fpanel')), BAD_WORDS);
});

test('V.10 stream panel: Follow scrolls to the end, scrolling up turns it off and shows the pill, the pill returns to the end; the filter hides rows', async () => {
  const { page, es } = await startPanel();
  const scroll = page.main.querySelector('.fpanel__scroll');
  scroll.scrollHeight = 1000;
  scroll.clientHeight = 400;
  scroll.scrollTop = 0;
  es.emit('transcript', tBody([reply1(1), reply1(2)]));
  await settle();
  assert.equal(scroll.scrollTop, 1000, 'follow on: the list is scrolled to its end');
  const follow = page.main.querySelector('.fpanel__follow');
  assert.equal(follow.getAttribute('aria-pressed'), 'true');
  scroll.scrollTop = 100;
  scroll.fire('scroll');
  assert.equal(follow.getAttribute('aria-pressed'), 'false', 'scrolling up turns Follow off');
  es.emit('transcript', tBody([reply1(3), reply1(4), reply1(5)]));
  await settle();
  assert.equal(scroll.scrollTop, 100, 'with Follow off the reading position does not move');
  const pill = page.main.querySelector('.fpanel__new');
  assert.equal(pill.getAttribute('hidden'), null);
  assert.equal(text(pill), '3 new events');
  pill.fire('click');
  assert.equal(follow.getAttribute('aria-pressed'), 'true');
  assert.equal(scroll.scrollTop, 1000);
  assert.equal(pill.getAttribute('hidden'), '');
  es.emit('transcript', tBody([reply1(6, { kind: 'tool-call', text: null, args: 'x', tool: { name: 'Bash', callKey: 'k2', status: null, bytes: null, durationMs: null } })]));
  await settle();
  const chip = (word: string) => page.main.querySelector('.fpanel__filter').querySelectorAll('.chip').find((c: El) => text(c) === word);
  chip('Tools')!.fire('click');
  const hiddenKinds = page.main.querySelectorAll('.ev').filter((r: El) => r.getAttribute('hidden') !== null).map((r: El) => r.dataset.kind);
  assert.equal(hiddenKinds.length, 5, 'the five replies are hidden under Tools');
  assert.equal(chip('Tools')!.getAttribute('aria-checked'), 'true');
  chip('All')!.fire('click');
  assert.equal(page.main.querySelectorAll('.ev').filter((r: El) => r.getAttribute('hidden') !== null).length, 0, 'the filter hides rows, it never drops them');
});

test('V.10 stream panel: above 500 events the oldest are removed from the top, the note shows, and the reading position keeps its place', async () => {
  const { page, es } = await startPanel();
  const scroll = page.main.querySelector('.fpanel__scroll');
  scroll.scrollHeight = 5000;
  scroll.clientHeight = 400;
  scroll.scrollTop = 1000;
  scroll.fire('scroll');
  for (let batch = 0; batch < 3; batch += 1) {
    es.emit('transcript', tBody(Array.from({ length: 200 }, (_, i) => reply1(batch * 200 + i, { text: `r${batch * 200 + i}` }))));
  }
  await settle();
  const rows = page.main.querySelectorAll('.ev');
  assert.equal(rows.length, 500);
  assert.equal(text(rows[0].querySelector('.ev__text')), 'r100', 'the oldest hundred were removed');
  assert.equal(text(page.main.querySelector('.ev--bound')), 'Earlier events are not kept in this view (500 shown).');
  assert.equal(scroll.scrollTop, 1000, 'no height to subtract in a fake DOM, and the position is not moved to the end');
});

test('V.10 stream panel: a reset starts the list over with a divider and an announcement; a resumed stream drops what the panel already holds', async () => {
  const { page, es } = await startPanel(`#/fleet/${P1}/${A_SUB}`, fleetRoute(), freshWeb());
  es.emit('transcript', tBody([reply1(1), reply1(2)]));
  await settle();
  assert.equal(page.main.querySelectorAll('.ev').length, 2);
  es.emit('transcript', tBody([reply1(10, { text: 'after the rewrite' })], { reset: true }));
  await settle();
  const rows = page.main.querySelectorAll('.ev');
  assert.equal(rows.length, 2, 'the divider and the one new reply');
  assert.match(text(rows[0]), /The transcript was rewritten\. Showing its last 64 records\./);
  assert.match(text(page.region), /The transcript was rewritten; showing its last 64 records\./);
  // Hidden, then back: the new stream starts from the transcript's last records.
  page.doc.hidden = true;
  for (const fn of page.doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' });
  assert.equal(es.closed, true, 'a hidden tab closes the stream');
  const before = FakeES.all.length;
  page.doc.hidden = false;
  for (const fn of page.doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' });
  await settle();
  assert.equal(FakeES.all.length, before + 1, 'and a visible tab opens a new one');
  const again = esOf('agent=');
  again.open();
  again.emit('transcript', tBody([reply1(10, { text: 'after the rewrite' }), reply1(11, { text: 'new' })]));
  await settle();
  assert.deepEqual(page.main.querySelectorAll('.ev__text').map((t: El) => text(t)), ['after the rewrite', 'new'], 'no duplicate event');
});

test('V.10 stream panel states: no reader, not linked, not found, format drift, gone agent and a tick error keep their copy', async () => {
  const oc = await startPanel(`#/fleet/${P1}/${A_OC}`);
  oc.es.emit('transcript', tBody([reply1(1, { kind: 'record', text: null, record: { type: 'hook-record', task: null, result: null } })], { agent: A_OC, agentKey: A_OC, harness: 'opencode', reader: { id: null, status: 'events-only' }, transcript: { linked: false, reason: 'no-reader' } }));
  await settle();
  assert.match(text(oc.page.main.querySelector('.fbanner')), /No transcript reader for opencode\. DoFlow’s own records for this agent are listed below\./);
  assert.equal(text(oc.page.main.querySelector('.ev__record')).includes('hook record'), true, 'the panel is never blank');
  assert.equal(text(oc.page.main.querySelector('.fpanel__title')), 'Subagent');
  uninstallPage();
  mock.timers.reset();

  const orphan = await startPanel(`#/fleet/${P1}/${A_ORPHAN}`);
  assert.match(text(orphan.page.main.querySelector('.fbanner')), /Transcript not found\./);
  orphan.es.emit('transcript', tBody([], { agent: A_ORPHAN, agentKey: A_ORPHAN, warnings: ['format-unrecognized'], transcript: { linked: true, reason: null } }));
  await settle();
  assert.match(text(orphan.page.main.querySelector('.fpanel__notice')), /records this reader does not recognise\. Showing the ones it could read\./);
  assert.match(text(orphan.page.main.querySelector('.fpanel__state')), /No reply or tool call is recorded for this agent yet\./);
  orphan.es.emit('error', { code: 'core-contract-mismatch', verb: 'transcript', exit: 1 });
  assert.match(transport(orphan.page), /core-contract-mismatch/);
  orphan.es.emit('error', { code: 'agent-not-in-project', verb: 'transcript', exit: 1 });
  assert.match(text(orphan.page.main.querySelector('.fpanel__state')), /This agent is no longer in this project’s records\./);
  assert.equal(orphan.es.closed, true, 'a gone agent ends the stream');
  uninstallPage();
  mock.timers.reset();

  const none = await startFleet(`#/fleet/${P1}`);
  const stream = esOf(`project=${P1}`);
  stream.open();
  stream.emit('snapshot', FLEET_TWO());
  await settle();
  assert.match(text(none.main.querySelector('.fpanel__state')), /Select an agent in the tree to follow its replies and tool calls\./);
});

test('V.10 fleet project: a project the list no longer holds says so, with a way back', async () => {
  const page = await startFleet(`#/fleet/${fk(0x99)}`);
  const es = esOf(`project=${fk(0x99)}`);
  es.open();
  es.emit('snapshot', FLEET_TWO());
  await settle();
  assert.match(text(page.main), /This project is not in the Fleet list any more\./);
  const back = page.main.querySelectorAll('a').find((a: El) => text(a) === 'Back to Fleet');
  assert.equal(back!.getAttribute('href'), '#/fleet');
});

test('V.10 fleet transport: three stream errors in a row, a 429 and a missing EventSource each end in the polling mode, announced once', async () => {
  const errors = await startFleet(`#/fleet/${P1}/${A_SUB}`, fleetRoute(), freshWeb());
  const es = esOf('agent=');
  es.open();
  es.emit('snapshot', FLEET_TWO());
  await settle();
  const polls = () => apiCalls(errors, '/api/fleet').length;
  assert.equal(polls(), 0, 'nothing is polled while the stream holds');
  es.fail();
  es.fail();
  assert.equal(polls(), 0, 'two errors in a row are not enough');
  es.fail();
  await settle();
  assert.equal(es.closed, true);
  assert.equal(polls(), 1, 'the third error polls at once');
  assert.match(transport(errors), /^Push unavailable: polling every 5 s · updated \d\d:\d\d:\d\d$/);
  assert.match(text(errors.region), /Push unavailable; polling every 5 seconds\./);
  assert.equal(apiCalls(errors, '/api/transcript').length, 1, 'the transcript is polled too');
  await advance(5000);
  assert.equal(polls(), 2, 'then every 5 s');
  await advance(2000);
  assert.ok(apiCalls(errors, '/api/transcript').length >= 2, 'and the transcript every 2 s');
  assert.ok(errors.calls.some((c) => c.url.startsWith('/api/fleet')), 'the polled body renders the same views');
  assert.deepEqual(rowsTextOf(errors), []);
  uninstallPage();
  mock.timers.reset();

  const noes = await startFleet(`#/fleet/${P1}`, fleetRoute(), null, 'absent');
  await settle();
  assert.equal(FakeES.all.length, 0);
  assert.match(transport(noes), /^Push unavailable: polling every 5 s/);
  assert.equal(apiCalls(noes, '/api/fleet').length, 1);
  await advance(5000);
  assert.equal(apiCalls(noes, '/api/fleet').length, 2);
  assert.ok(noes.main.querySelector('.ftree'), 'the polled fleet draws the same tree');
  uninstallPage();
  mock.timers.reset();

  const limited = await startFleet(`#/fleet/${P1}`, (target, init) => (target.startsWith('/api/stream') ? errorReply(429, 'stream-limit') : fleetRoute()(target, init)));
  const refused = esOf(`project=${P1}`);
  refused.fail(2);
  await advance(10);
  assert.match(transport(limited), /^Another tab holds this page’s push; this tab polls every 5 s$/);
  assert.equal(apiCalls(limited, '/api/fleet').length, 1);
});
const rowsTextOf = (page: Page) => page.main.querySelectorAll('.project-row').map((r: El) => text(r));

test('V.10 fleet transport: a stream that stays broken for 20 s is stale; the page says so and reads the time without "ago"', async () => {
  const page = await startFleet(`#/fleet/${P1}`);
  const es = esOf(`project=${P1}`);
  es.open();
  es.emit('snapshot', FLEET_TWO());
  await advance(1000);
  assert.equal(page.main.getAttribute('data-stale'), null);
  es.fail();
  await advance(21_000);
  assert.equal(page.main.getAttribute('data-stale'), 'true');
  assert.match(transport(page), /^No update for \d+ s · last \d\d:\d\d:\d\d$/);
});

test('V.10 fleet pages: the Fleet link is current on every Fleet route and the copy of the whole page never says an agent is working', async () => {
  const page = await startFleet(`#/fleet/${P1}/${A_MAIN}`);
  const es = esOf('agent=');
  es.open();
  es.emit('snapshot', FLEET_TWO());
  es.emit('transcript', tBody([reply1(1)], { agent: A_MAIN, agentKey: A_MAIN }));
  await settle();
  assert.deepEqual(current(page), ['Fleet']);
  assert.doesNotMatch(text(page.main), BAD_WORDS);
  assert.ok(!page.main.querySelectorAll('a').some((a: El) => !/^#\//.test(a.getAttribute('href') ?? '')), 'no link leaves the page');
});

// ---- stream.js on its own: a fake clock, a fake EventSource and a scripted fetch ---------------------------------

function streamRig(opts: { project?: string | null, agent?: string | null, noES?: boolean, probe?: any, fail?: boolean } = {}) {
  const clock = fakeClock();
  let hidden = false;
  let listener: () => void = () => {};
  const sources: FakeES[] = [];
  class ES extends FakeES { constructor(url: string) { super(url); sources.push(this); } }
  const log = { snapshot: [] as any[], fleet: [] as any[], transcript: [] as any[], modes: [] as string[], errors: [] as any[], failures: [] as any[], paths: [] as string[] };
  const body = { projects: [{ projectKey: P1 }] };
  const stream = mods.stream.createFleetStream({
    project: opts.project === undefined ? P1 : opts.project,
    agent: opts.agent === undefined ? null : opts.agent,
    ...(opts.noES ? { EventSource: undefined } : { EventSource: ES }),
    clock,
    visibility: { hidden: () => hidden, subscribe: (fn: () => void) => { listener = fn; return () => {}; } },
    probe: opts.probe ?? (async () => ({ status: 500, code: null })),
    fetchJson: async (path: string) => {
      log.paths.push(path);
      if (opts.fail) throw { status: null, code: null, network: true };
      return path.startsWith('/api/fleet') ? body : { cursor: '9:9:9:9', events: [] };
    },
    handlers: {
      snapshot: (b: any) => log.snapshot.push(b),
      fleet: (b: any) => log.fleet.push(b),
      transcript: (b: any, meta: any) => log.transcript.push({ b, meta }),
      streamError: (i: any) => log.errors.push(i),
      mode: (m: any) => log.modes.push(m.mode + (m.reason ? `:${m.reason}` : '')),
      failure: (e: any) => log.failures.push(e),
    },
  });
  return { stream, clock, sources, log, setHidden(value: boolean) { hidden = value; listener(); } };
}

test('V.10 stream.js: one EventSource opens on the project and agent; its first frame is push; the polling is never started', async () => {
  const rig = streamRig({ agent: A_SUB });
  rig.stream.start();
  assert.equal(rig.sources.length, 1);
  assert.equal(rig.sources[0].url, `/api/stream?project=${P1}&agent=${A_SUB}`);
  assert.deepEqual(rig.log.modes, [], 'the first mode is connecting and is not announced');
  rig.sources[0].open();
  rig.sources[0].emit('snapshot', { projects: [] });
  rig.sources[0].emit('transcript', { cursor: '1:1:1:1', events: [] });
  assert.deepEqual(rig.log.modes, ['push']);
  assert.equal(rig.log.snapshot.length, 1);
  assert.deepEqual(rig.log.transcript[0].meta, { resumed: false });
  await rig.clock.advance(60_000);
  assert.deepEqual(rig.log.paths, [], 'nothing is polled while the stream holds');
  assert.equal(rig.stream.isStale(), false);
  rig.stream.stop();
  assert.equal(rig.sources[0].closed, true);
});

test('V.10 stream.js: three errors in a row fall back to polling at 5 s and 2 s from the last cursor; a good frame resets the count', async () => {
  const rig = streamRig({ agent: A_SUB });
  rig.stream.start();
  const es = rig.sources[0];
  es.fail();
  es.fail();
  es.emit('snapshot', { projects: [] });
  es.fail();
  es.fail();
  assert.deepEqual(rig.log.paths, [], 'a frame between the errors reset the count');
  es.emit('transcript', { cursor: '4:5:6:7', events: [] });
  es.fail();
  es.fail();
  es.fail();
  await rig.clock.flush();
  assert.equal(rig.stream.mode, 'fallback');
  assert.deepEqual(rig.log.paths.slice(0, 2), ['/api/fleet', `/api/transcript?project=${P1}&agent=${A_SUB}&cursor=4%3A5%3A6%3A7`]);
  await rig.clock.advance(5000);
  assert.equal(rig.log.paths.filter((p) => p === '/api/fleet').length, 2);
  assert.ok(rig.log.paths.filter((p) => p.startsWith('/api/transcript')).length >= 3, 'every 2 s');
  assert.ok(rig.log.paths.filter((p) => p.startsWith('/api/transcript')).slice(1).every((p) => p.includes('cursor=9%3A9%3A9%3A9')), 'each poll continues from the cursor of the last answer');
});

test('V.10 stream.js: a refused stream (the browser closed it) is probed once; 429 is the stream limit and polls, anything else counts as an error', async () => {
  const limited = streamRig({ probe: async () => ({ status: 429, code: 'stream-limit' }) });
  limited.stream.start();
  limited.sources[0].fail(2);
  await limited.clock.flush();
  assert.equal(limited.stream.mode, 'limit');
  assert.deepEqual(limited.log.paths, ['/api/fleet']);
  const other = streamRig({ probe: async () => ({ status: 500, code: null }) });
  other.stream.start();
  other.sources[0].fail(2);
  await other.clock.flush();
  assert.equal(other.stream.mode, 'connecting', 'one refusal is one error');
  await other.clock.advance(5000);
  assert.equal(other.sources.length, 2, 'the page reopens the stream after the Console’s retry delay');
});

test('V.10 stream.js: without EventSource the page polls at once and never tries a stream', async () => {
  const rig = streamRig({ noES: true, agent: A_SUB });
  rig.stream.start();
  await rig.clock.flush();
  assert.equal(rig.stream.mode, 'fallback');
  assert.equal(rig.stream.reason, 'no-eventsource');
  assert.deepEqual(rig.log.paths.slice(0, 2), ['/api/fleet', `/api/transcript?project=${P1}&agent=${A_SUB}`]);
  await rig.clock.advance(120_000);
  assert.equal(rig.sources.length, 0);
});

test('V.10 stream.js: a hidden tab closes the stream and polls nothing; on return it reopens, and the next transcript batch is marked resumed', async () => {
  const rig = streamRig({ agent: A_SUB });
  rig.stream.start();
  rig.sources[0].open();
  rig.sources[0].emit('transcript', { cursor: '1:1:1:1', events: [] });
  rig.setHidden(true);
  assert.equal(rig.sources[0].closed, true, 'hidden closes the stream');
  await rig.clock.advance(60_000);
  assert.equal(rig.sources.length, 1, 'nothing is opened while hidden');
  assert.equal(rig.stream.isStale(), false, 'a hidden page is not stale');
  rig.setHidden(false);
  assert.equal(rig.sources.length, 2);
  rig.sources[1].open();
  rig.sources[1].emit('transcript', { cursor: '2:2:2:2', events: [] });
  rig.sources[1].emit('transcript', { cursor: '3:3:3:3', events: [] });
  assert.deepEqual(rig.log.transcript.map((entry) => entry.meta.resumed), [false, true, false]);
});

test('V.10 stream.js: while polling, a push is tried again every 60 s; its first frame ends the polling and restores the push mode', async () => {
  const rig = streamRig();
  rig.stream.start();
  rig.sources[0].fail();
  rig.sources[0].fail();
  rig.sources[0].fail();
  await rig.clock.flush();
  assert.equal(rig.stream.mode, 'fallback');
  const polled = () => rig.log.paths.filter((p) => p === '/api/fleet').length;
  await rig.clock.advance(59_000);
  assert.equal(rig.sources.length, 1);
  await rig.clock.advance(2000);
  assert.equal(rig.sources.length, 2, 'a trial stream opens after a minute');
  rig.sources[1].fail();
  assert.equal(rig.stream.mode, 'fallback', 'a failed trial changes nothing');
  assert.equal(rig.sources[1].closed, true);
  await rig.clock.advance(60_000);
  assert.equal(rig.sources.length, 3);
  const before = polled();
  rig.sources[2].emit('snapshot', { projects: [] });
  assert.equal(rig.stream.mode, 'push');
  assert.deepEqual(rig.log.modes.slice(-2), ['fallback:errors', 'push']);
  await rig.clock.advance(30_000);
  assert.equal(polled(), before, 'the polls ended');
});

test('V.10 stream.js: the stale rule — 20 s of a broken stream under push, 3 missed polls under fallback', async () => {
  const rig = streamRig();
  rig.stream.start();
  rig.sources[0].open();
  rig.sources[0].emit('snapshot', { projects: [] });
  assert.equal(rig.stream.isStale(), false);
  rig.sources[0].fail();
  await rig.clock.advance(19_000);
  assert.equal(rig.stream.isStale(), false);
  await rig.clock.advance(2000);
  assert.equal(rig.stream.isStale(), true);
  const polled = streamRig({ noES: true, fail: true });
  polled.stream.start();
  await polled.clock.flush();
  assert.equal(polled.stream.isStale(), false, 'no frame yet: nothing to be stale');
  const ok = streamRig({ noES: true });
  ok.stream.start();
  await ok.clock.flush();
  assert.equal(ok.stream.misses, 0);
});

test('V.10 stream.js: a gone target ends the stream, and the project list opens its stream only once a project is listed', async () => {
  const rig = streamRig({ agent: A_SUB });
  rig.stream.start();
  rig.sources[0].emit('error', { code: 'agent-not-in-project', verb: 'transcript', exit: 1 });
  assert.equal(rig.stream.ended, true);
  assert.equal(rig.sources[0].closed, true);
  assert.deepEqual(rig.log.errors, [{ code: 'agent-not-in-project', verb: 'transcript', exit: 1 }]);
  await rig.clock.advance(120_000);
  assert.deepEqual(rig.log.paths, [], 'a gone agent is not polled');

  const list = streamRig({ project: null });
  list.stream.start();
  assert.equal(list.sources.length, 0, 'no key to open a stream on yet');
  await list.clock.flush();
  assert.deepEqual(list.log.paths, ['/api/fleet']);
  assert.equal(list.sources.length, 1);
  assert.equal(list.sources[0].url, `/api/stream?project=${P1}`);
});


// ---- feature 133: pause control, reconnect discipline ---------------------------------------------------

test('133 pause: the control shows on a data view, suspends polling with a Paused pill, and resume refetches at once', async () => {
  await withFreshModules(async () => {
  const page = await start({ fetch: standard });
  assert.equal(page.pause.getAttribute('hidden'), null, 'shown on the Runs view');
  assert.equal(page.pause.getAttribute('aria-pressed'), 'false');
  assert.equal(text(page.pause), 'Pause updates');
  const before = apiCalls(page, '/api/runs').length;
  page.pause.fire('click');
  assert.equal(page.pause.getAttribute('aria-pressed'), 'true');
  assert.equal(text(page.pause), 'Resume updates');
  assert.match(text(page.conn), /^Paused/);
  assert.equal(page.conn.dataset.state, 'paused');
  await advance(120_000);
  assert.equal(apiCalls(page, '/api/runs').length, before, 'no poll while paused');
  assert.equal(page.slot.children.length, 0, 'a paused view never raises the stale banner');
  assert.match(text(page.region), /Updates paused/);
  page.pause.fire('click');
  await settle();
  assert.equal(apiCalls(page, '/api/runs').length, before + 1, 'resume fetches the full state at once');
  assert.equal(page.pause.getAttribute('aria-pressed'), 'false');
  assert.doesNotMatch(text(page.conn), /^Paused/);
  await advance(6000);
  assert.ok(apiCalls(page, '/api/runs').length >= before + 2, 'polling continues after resume');
  });
});

test('133 pause: it is per view and absent where nothing is polled', async () => {
  const page = await start({ hash: '#/nowhere', fetch: standard });
  assert.notEqual(page.pause.getAttribute('hidden'), null, 'no control on a not-found page');
});

test('133 reconnect: the first data after a long absence announces one summary, not each change', async () => {
  await withFreshModules(async () => {
  let runs: any = RUNS;
  const page = await start({ fetch: (target, init) => (target === '/api/runs' ? reply(200, runs) : standard(target, init)) });
  const hide = (value: boolean) => { page.doc.hidden = value; for (const fn of page.doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' }); };
  hide(true);
  await advance(60_000);
  runs = { ...RUNS, runs: [row('AWAITING_GATE', 'r1'), row('AWAITING_GATE', 'r9'), row('AWAITING_GATE', 'r8'), row('RUNNING', 'r2')] };
  hide(false);
  await advance(1000);
  assert.equal(text(page.region), 'Reconnected. The view was refreshed in full.');
  });
});

test('133 reconnect: a short absence keeps the per-item announcements', async () => {
  await withFreshModules(async () => {
  let runs: any = { ...RUNS, runs: [row('RUNNING', 'r2')] };
  const page = await start({ fetch: (target, init) => (target === '/api/runs' ? reply(200, runs) : standard(target, init)) });
  const hide = (value: boolean) => { page.doc.hidden = value; for (const fn of page.doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' }); };
  hide(true);
  await advance(5_000);
  runs = { ...RUNS, runs: [row('RUNNING', 'r2'), row('AWAITING_GATE', 'r1')] };
  hide(false);
  await advance(1000);
  assert.match(text(page.region), /is waiting for you/);
  });
});

const keydownOn = (page: Page, key: string, extra: any = {}) => {
  const event = { type: 'keydown', key, target: page.doc.activeElement ?? page.doc.body, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  for (const fn of page.doc.listeners.get('keydown') ?? []) fn(event);
  return event;
};

test('133 shortcuts: p pauses, g then w navigates, ? opens the list with focus inside and Esc closes it and restores focus', async () => {
  await withFreshModules(async () => {
    const page = await start({ fetch: standard });
    keydownOn(page, 'p');
    assert.equal(page.pause.getAttribute('aria-pressed'), 'true');
    keydownOn(page, 'p');
    assert.equal(page.pause.getAttribute('aria-pressed'), 'false');
    keydownOn(page, 'g');
    keydownOn(page, 'w');
    assert.equal(page.location.hash, '#/workflows');
    page.pause.focus();
    const open = keydownOn(page, '?');
    assert.equal(open.defaultPrevented, true);
    const help = page.doc.getElementById('help');
    assert.equal(help.getAttribute('hidden'), null);
    assert.equal(help.getAttribute('role'), 'dialog');
    assert.equal(help.getAttribute('aria-modal'), 'true');
    assert.equal(page.doc.activeElement.className.includes('help__close'), true, 'focus moves into the dialog');
    assert.match(text(help), /Go to Runs/);
    keydownOn(page, 'p');
    assert.equal(page.pause.getAttribute('aria-pressed'), 'false', 'a modal dialog keeps the page keys off');
    const tab = keydownOn(page, 'Tab');
    assert.equal(tab.defaultPrevented, true);
    keydownOn(page, 'Escape');
    assert.notEqual(help.getAttribute('hidden'), null);
    assert.equal(page.doc.activeElement, page.pause, 'focus returns to the opener');
  });
});

test('133 shortcuts: typing in a field and held modifiers never trigger one; a chord times out', async () => {
  await withFreshModules(async () => {
    const page = await start({ fetch: standard });
    const field = page.doc.createElement('input');
    keydownOn(page, 'p', { target: field });
    assert.equal(page.pause.getAttribute('aria-pressed'), 'false');
    keydownOn(page, 'p', { ctrlKey: true });
    keydownOn(page, 'p', { metaKey: true });
    assert.equal(page.pause.getAttribute('aria-pressed'), 'false');
    keydownOn(page, 'g');
    await advance(2000);
    keydownOn(page, 'w');
    assert.notEqual(page.location.hash, '#/workflows', 'the second key came too late');
  });
});

test('133 pause: a known outage is not hidden by pausing; the pill shows it with Paused, and only a successful fetch clears the banner', async () => {
  await withFreshModules(async () => {
    let down = false;
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1' ? (down ? errorReply(502, 'core-error') : runReply()) : standard(target, init)) });
    down = true;
    await advance(17_000);
    assert.equal(page.slot.querySelectorAll('.banner').length, 1, 'stale before the pause');
    page.pause.fire('click');
    await advance(5000);
    assert.equal(page.slot.querySelectorAll('.banner').length, 1, 'the banner survives the pause');
    assert.equal(page.main.getAttribute('data-stale'), 'true');
    assert.match(text(page.conn.querySelector('.conn__long')), /^Paused \u00b7 Stale/);
    assert.equal(page.conn.getAttribute('data-state'), 'stale');
    page.pause.fire('click'); // resume while the core still fails
    await advance(100);
    assert.equal(page.slot.querySelectorAll('.banner').length, 1, 'a failed refetch does not clear it');
    down = false;
    await advance(40_000);
    assert.equal(page.slot.querySelectorAll('.banner').length, 0, 'a successful fetch clears it');
  });
});

test('133 pause: a paused view that is offline says so in the pill', async () => {
  await withFreshModules(async () => {
    let down = false;
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1' ? (down ? 'network' : runReply()) : standard(target, init)) });
    down = true;
    await advance(4000);
    page.pause.fire('click');
    assert.match(text(page.conn.querySelector('.conn__long')), /^Paused \u00b7 (Offline|Retrying)/);
  });
});
