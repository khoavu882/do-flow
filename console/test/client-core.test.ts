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
const { project } = require('../src/project.ts');

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
    derive: await import(url('derive/rail.js')),
    home: await import(url('views/home.js')),
    railView: await import(url('views/rail.js')),
    shell: await import(url('shell.js')),
    actions: await import(url('actions.js')),
    confirm: await import(url('views/confirm.js')),
    liveView: await import(url('live-view.js')),
    start: await import(url('derive/start.js')),
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
  value = '';
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
  get isConnected(): boolean { return this.doc.documentElement ? this.doc.documentElement.contains(this) : false; }
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

const GLOBALS = ['document', 'location', 'history', 'localStorage', 'fetch', 'navigator', 'scrollTo', 'requestAnimationFrame', 'addEventListener', 'getSelection', 'Node', 'EventSource', 'matchMedia'];
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
  region: El, main: El, conn: El, slot: El, nav: El[], radios: El[], skip: El, pause: El, shell: El, inspector: El, media: any,
};

/** The page of index.html as the shell finds it, a fake window around it, and a scripted fetch. */
function installPage(opts: { hash?: string, stored?: string | null, throwStorage?: boolean, eventSource?: unknown, width?: number, fetch: (url: string, init: any) => Reply | Promise<Reply> | 'network' }): Page {
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
  const link = (href: string, text: string) => el('a', { class: 'navrail__link', href }, [el('span', { class: 'navrail__label' }, [text])]);
  const radio = (choice: string) => el('button', { type: 'button', role: 'radio', class: 'theme__opt', 'aria-checked': 'false', tabindex: '-1', 'data-theme-choice': choice }, [el('span', { class: 'theme__label' }, [choice])]);
  const skip = el('a', { class: 'skip', href: '#main' }, ['Skip to content']);
  const nav = [link('#/', 'Now'), link('#/sessions', 'Sessions'), link('#/layers', 'Layers'), link('#/more', 'More'), link('#/followups', 'Follow-ups'), link('#/workflows', 'Workflows'), link('#/workers', 'Workers'), link('#/advice', 'Advice'), link('#/settings', 'Settings'), link('#/health', 'Health')]; // 149 D.1: the fake page mirrors index.html's rail
  const radios = ['light', 'dark', 'system'].map(radio);
  const conn = el('p', { class: 'conn', id: 'conn', 'data-state': 'unknown' }, [el('span', { class: 'conn__long' }, ['Connecting']), el('span', { class: 'conn__short' }, ['Connecting'])]);
  const pause = el('button', { type: 'button', class: 'btn btn--ghost pause', id: 'pause', 'aria-pressed': 'false', hidden: '' }, [el('span', { class: 'pause__label' }, ['Pause updates'])]);
  const region = el('div', { class: 'vh', id: 'announcer' });
  const main = el('main', { id: 'main', class: 'page', tabindex: '-1' });
  const slot = el('div', { id: 'banner-slot' });
  const inspector = el('aside', { id: 'inspector', class: 'inspector', 'aria-label': 'Details', hidden: '' }, [
    el('div', { class: 'inspector__head' }, [el('h2', { class: 'inspector__title', id: 'inspector-title' }, ['Details']),
      el('button', { type: 'button', class: 'btn btn--ghost inspector__close' }, [el('span', { class: 'vh' }, ['Close details'])])]),
    el('div', { class: 'inspector__body' }),
  ]);
  const shell = el('div', { class: 'shell', id: 'shell', 'data-inspectable': 'false' }, [
    el('nav', { class: 'navrail', 'aria-label': 'Primary' }, [el('ul', {}, nav.map((a) => el('li', {}, [a])))]), el('p', { class: 'attention', id: 'attention', hidden: '' }), main, inspector]);
  body.append(skip,
    el('header', { class: 'site-header' }, [el('a', { class: 'brand', href: '#/' }, [el('span', { class: 'brand__name' }, ['DoFlow'])]),
      conn, pause, el('p', { id: 'core-version' }),
      el('div', { class: 'theme' }, radios)]),
    slot, shell, region);
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
  const page: any = { doc, calls, store, history, scrolls, location, region, main, conn, slot, nav, radios, skip, pause, shell, inspector, reloads: 0 };
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
  if (opts.width !== undefined) {
    // 149 D.1: a viewport width the shell reads through matchMedia; page.media.resize(w) fires each list's change.
    const lists: any[] = [];
    const min = (query: string) => Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
    page.media = { width: opts.width, resize(w: number) { page.media.width = w; for (const l of lists) for (const fn of l.fns) fn({ matches: l.matches }); } };
    setGlobal('matchMedia', (query: string) => {
      const list = { fns: [] as Function[], get matches() { return page.media.width >= min(query); }, addEventListener(_t: string, fn: Function) { list.fns.push(fn); } };
      lists.push(list);
      return list;
    });
  }
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
/** The buttons in the inspector that close it, by their visible or accessible name (FU-a0n90q: the inspector's own only). */
const closeControlsOf = (page: Page) => page.inspector.querySelectorAll('button').filter((b: El) => /close/i.test(`${b.getAttribute('aria-label') ?? ''} ${text(b)}`));
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

test('poller: refreshAfterAction fetches at once, and the answer of a fetch already in flight is dropped, never painted', async () => {
  const clock = fakeClock();
  const releases: Array<(value: any) => void> = [];
  const painted: any[] = [];
  const instance = mods.poll.createPoller({
    clock, visibility: { hidden: () => false, subscribe: () => () => {} }, intervalMs: 5000,
    fetchOnce: () => new Promise((resolve) => { releases.push(resolve); }), onSuccess: (data: any) => painted.push(data),
  });
  instance.start();
  assert.equal(releases.length, 1, 'the first fetch is in flight');
  assert.equal(instance.refreshAfterAction(), true);
  assert.equal(releases.length, 1, 'nothing starts while one is in flight');
  releases[0]('before the action');
  await clock.advance(1);
  assert.deepEqual(painted, [], 'the answer that began before the action is not painted');
  assert.equal(releases.length, 2, 'and a fetch begins at once instead');
  releases[1]('after the action');
  await clock.advance(1);
  assert.deepEqual(painted, ['after the action']);
  assert.equal(instance.refreshAfterAction(), true);
  assert.equal(releases.length, 3, 'idle: it fetches at once');
  instance.stop();
  assert.equal(instance.refreshAfterAction(), false);
});

test('162 review B-6: poller refreshAfterAction(done) answers true once the post-action data is painted, false when that fetch fails', async () => {
  const clock = fakeClock();
  const releases: Array<{ resolve: (value: any) => void, reject: (error: any) => void }> = [];
  const order: string[] = [];
  const instance = mods.poll.createPoller({
    clock, visibility: { hidden: () => false, subscribe: () => () => {} }, intervalMs: 5000,
    fetchOnce: () => new Promise((resolve, reject) => { releases.push({ resolve, reject }); }), onSuccess: (data: any) => order.push(`painted ${data}`),
  });
  instance.start();
  assert.equal(instance.refreshAfterAction((ok: boolean) => order.push(`done ${ok}`)), true);
  releases[0].resolve('before');
  await clock.advance(1);
  assert.deepEqual(order, [], 'the dropped answer neither paints nor answers');
  releases[1].resolve('after');
  await clock.advance(1);
  assert.deepEqual(order, ['painted after', 'done true']);
  order.length = 0;
  instance.refreshAfterAction((ok: boolean) => order.push(`done ${ok}`));
  releases[2].reject(new Error('down'));
  await clock.advance(1);
  assert.deepEqual(order, ['done false']);
  instance.refreshAfterAction((ok: boolean) => order.push(`stopped ${ok}`));
  instance.stop();
  assert.deepEqual(order, ['done false', 'stopped false'], 'a stop answers a waiting caller');
});

test('162 review B-7: live refreshAfterAction drops a GET already in flight unpainted and starts a new one, as the poller does', async () => {
  const releases: Array<(value: any) => void> = [];
  const painted: any[] = [];
  const store = {
    status: () => ({ transport: 'open' }),
    onTransport: () => () => {},
    subscribe: (_ch: string, fn: (event: any) => void) => { fn({ kind: 'state', state: { runs: { status: 200, body: 'live' } } }); return () => {}; },
    pause() {}, resume() {},
  };
  const view = mods.liveView.connectLive({ channel: () => 'now', member: 'runs', intervalMs: 5000 })({}, {}, {
    fetchJson: async () => null, onData: (data: any) => painted.push(data), onFailure: () => {}, store: () => store,
    fetchOnce: () => new Promise((resolve) => { releases.push(resolve); }),
  });
  view.start();
  assert.equal(view.mode, 'live');
  assert.deepEqual(painted, ['live']);
  assert.equal(view.refreshNow(), true, 'a GET while live is in flight');
  assert.equal(releases.length, 1);
  const answers: boolean[] = [];
  assert.equal(view.refreshAfterAction((ok: boolean) => answers.push(ok)), true);
  assert.equal(releases.length, 2, 'the action starts a new GET at once');
  releases[0]('before the action');
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.deepEqual(painted, ['live'], 'the GET that began before the action is dropped unpainted');
  assert.deepEqual(answers, []);
  releases[1]('after the action');
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.deepEqual(painted, ['live', 'after the action']);
  assert.deepEqual(answers, [true]);
  view.stop();
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
  for (const code of ['device-unpaired', 'device-revoked', 'device-expired']) {
    assert.deepEqual(c(401, code, { exchange: 'none', sessionWorked: true }), { scope: 'session', key: code, auto: false, status: 401, code }, code);
  }
  assert.deepEqual(c(503, 'store-unreadable'), { scope: 'session', key: 'store-unreadable', auto: false, status: 503, code: 'store-unreadable' });
  assert.deepEqual(c(503, 'cert-expired'), { scope: 'session', key: 'cert-expired', auto: false, status: 503, code: 'cert-expired' });
  assert.deepEqual(c(403, 'phone-scope'), { scope: 'inline', key: 'phone-scope', auto: false, status: 403, code: 'phone-scope' });
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
  for (const k of ['session-used', 'session-unauth', 'session-ended', 'forbidden-origin', 'offline', 'core-error', 'contract-mismatch', 'cannot-list', 'run-not-found', 'not-found', 'refused', 'device-unpaired', 'device-revoked', 'device-expired', 'store-unreadable']) {
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
  // 150 C.5 (IC-015): the Session route with no node and with each node form; tabs only on a worker node.
  for (const hash of ['#/session/feat-a/run-1', '#/session/feat-a/run-1/main', '#/session/feat-a/run-1/stage/design', '#/session/feat-a/run-1/gate/gate-0',
    '#/session/feat-a/run-1/task/A.1', '#/session/feat-a/run-1/attempt/A.1/2', '#/session/feat-a/run-1/worker/w-0123456789ab',
    ...['log', 'transcript', 'result', 'process'].map((tab) => `#/session/feat-a/run-1/worker/w-0123456789ab/${tab}`)]) {
    assert.equal(id(hash), 'session', hash);
    assert.deepEqual(parseRoute(hash).params, { slug: 'feat-a', taskId: 'run-1' }, hash);
    assert.equal(parseRoute(hash).view, VIEWS.session, hash);
  }
  for (const bad of ['#/nope', '#/run/-x/y', '#/run/x/.y', '#/run/a%2Fb/c', '#/run/a', '#/run/a/b/c/d', '#/run/a/b/files', '#/workflows/', '#main', '#c=1']) {
    assert.equal(id(bad), 'not-found', bad);
  }
  // 150 C.5 (IC-015): the Session route's not-found cases.
  for (const bad of ['#/session/a', '#/session/a/b/c', '#/session/a/b/worker/w-0123', '#/session/a/b/worker/w-0123456789ab/last', '#/session/a/b/attempt/A.1/0']) {
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
  assert.equal(navFor(parseRoute('#/session/s/t')), 'runs', '150 C.5: the Session route marks Now');
  assert.equal(navFor(parseRoute('#/session/s/t/worker/w-0123456789ab/log')), 'runs');
  assert.equal(titleFor(parseRoute('#/session/s/t/main')), 'Chain \u00b7 s / t \u00b7 DoFlow Console');
  assert.deepEqual(Object.keys(VIEWS).sort(), ['advice', 'compare', 'followups', 'health', 'layers', 'layers-project', 'more', 'not-found', 'run', 'runs', 'session', 'sessions', 'settings', 'start', 'tasks', 'workers', 'workflows']); // 165 the start view, E.7 adds the sessions view, 161 the two Layers views (the Fleet views are gone), 150 C.5 the session view, 152 C.2 compare view
});

test('index.html provides the elements the shell needs', () => {
  const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  for (const id of ['main', 'conn', 'core-version', 'banner-slot', 'announcer', 'pause']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-live="polite"/);
  assert.deepEqual([...html.matchAll(/class="navrail__link" href="([^"]+)"><span class="navrail__label">([^<]+)</g)].map((m) => [m[1], m[2]]),
    [['#/', 'Now'], ['#/sessions', 'Sessions'], ['#/layers', 'Layers'], ['#/more', 'More'], ['#/followups', 'Follow-ups'], ['#/workflows', 'Workflows'], ['#/workers', 'Workers'], ['#/advice', 'Advice'], ['#/settings', 'Settings'], ['#/health', 'Health']]); // the tab bar's four, then the Manage group
  assert.match(html, /<li class="navrail__more"><a class="navrail__link" href="#\/more">/, 'More is marked: it shows below 768 px only');
  assert.match(html, /<li class="navrail__slot" data-slot="start-session"><a class="navrail__link" href="#\/start"><svg [^>]*aria-hidden="true"[^>]*>.*<\/svg><span class="navrail__label">Start<\/span><\/a><\/li>/, 'the slot of the start-a-session entry holds its link and its label (row 165)');
  assert.match(html, /<p class="attention" id="attention" hidden><\/p>/, 'the attention strip starts hidden and empty');
  assert.match(html, /viewport-fit=cover/, 'the page may draw under the safe areas, which the tokens then pad');
  assert.deepEqual([...html.matchAll(/data-theme-choice="([^"]+)"/g)].map((m) => m[1]), ['light', 'dark', 'system']);
  assert.match(html, /<html lang="en" class="booting">/);
  assert.match(html, /<main id="main" class="page" tabindex="-1">/);
  // 149 D.1: the header keeps its controls, and after the banner slot the shell holds the rail, #main and the inspector, in that order.
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  for (const id of ['conn', 'pause', 'core-version']) assert.match(header, new RegExp(`id="${id}"`));
  assert.match(header, /class="brand"/);
  assert.match(header, /class="theme" role="radiogroup"/);
  assert.doesNotMatch(header, /<nav\b/, 'the navigation left the header for the rail');
  const order = ['id="banner-slot"', '<div class="shell" id="shell" data-inspectable=', '<nav class="navrail" aria-label="Primary">', '<main id="main"',
    '<aside id="inspector" class="inspector" aria-label="Details" hidden>', 'class="inspector__title"', 'class="btn btn--ghost inspector__close"', 'class="inspector__body"'];
  const at = order.map((piece) => html.indexOf(piece));
  assert.ok(at.every((index) => index > -1), `every shell piece is present: ${JSON.stringify(at)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in document order');
  assert.equal([...html.matchAll(/aria-label="Primary"/g)].length, 1, 'one primary navigation');
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
  assert.deepEqual(current(page), ['Now']);
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

// ---- app.js: pairing a device on a LAN Console (160 IC-009) ----

const PAIR_CODE = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 22) + '2345';
const PAIR_FP = '0123456789abcdef'.repeat(4);
const PAIR_HASH = `#pair=${PAIR_CODE}&fp=${PAIR_FP}&v=1`;
const pairReply = (status: number, code: string | null, headers: Record<string, string> = {}): Reply & { headers: any } => ({
  ok: status === 200, status, json: async () => (code === null ? { v: 1, device: { id: 'd-0123456789ab', name: 'x', scope: 'view' } } : { error: { code, verb: null, exit: null } }),
  headers: { get: (name: string) => headers[name] ?? null },
});
const pairForm = (page: Page) => page.main.querySelector('form');
const pairInput = (page: Page) => page.main.querySelector('input');
const pairButton = (page: Page) => page.main.querySelector('button');

test('pair: a #pair= fragment is removed at once, nothing is fetched, and the form shows the name field and the fingerprint', async () => {
  const page = await start({ hash: PAIR_HASH, fetch: standard });
  assert.deepEqual(page.history, ['/#/']);
  assert.equal(page.location.hash, '#/');
  assert.deepEqual(page.calls.map((c) => `${c.method} ${c.url}`), [], 'no request before the person acts');
  assert.equal(text(heading(page)), 'Pair this device with the Console');
  assert.equal(pairInput(page).value, 'Phone browser');
  assert.equal(page.main.querySelector('label').getAttribute('for'), 'pair-name');
  assert.equal(pairInput(page).getAttribute('id'), 'pair-name');
  assert.equal(text(page.main.querySelector('.pair__fp')), PAIR_FP.toUpperCase().match(/../g)!.join(':'));
  assert.match(text(page.main), /Fingerprint from your link/, 'the page labels its own value as the link\u2019s');
  assert.match(text(page.main), /before you proceed past your browser.s warning: compare the fingerprint printed in your terminal/);
  assert.doesNotMatch(text(page.main), /pair only when they are the same/, 'the click is never presented as the check');
  assert.match(text(page.main), /A device paired in a browser can only view/);
  assert.equal(text(page.main).includes(PAIR_CODE), false, 'the code is never on the page');
  assert.equal(page.doc.documentElement.classList.contains('booting'), false);
});

test('pair: Pair posts the code once with the typed name, then boots as a paired device', async () => {
  const page = await start({ hash: PAIR_HASH, fetch: (target, init) => (target === '/api/pair' ? pairReply(200, null) : standard(target, init)) });
  pairInput(page).value = '  Kai phone  ';
  pairForm(page).fire('submit');
  await settle();
  const posts = page.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map((c) => [c.url, c.body]), [['/api/pair', { v: 1, code: PAIR_CODE, name: 'Kai phone' }]]);
  assert.equal(apiCalls(page, '/api/info').length >= 1, true);
  assert.equal(text(heading(page)), 'Runs');
  assert.equal(JSON.stringify(page.history).includes(PAIR_CODE), false);
  assert.equal(text(page.main).includes(PAIR_CODE), false);
});

test('pair: an empty name posts the default, and a double click posts once', async () => {
  let release: (value: Reply) => void = () => {};
  const held = new Promise<Reply>((resolve) => { release = resolve; });
  const page = await start({ hash: PAIR_HASH, fetch: (target, init) => (target === '/api/pair' ? held : standard(target, init)) });
  pairInput(page).value = '   ';
  pairForm(page).fire('submit');
  pairForm(page).fire('submit');
  await settle();
  assert.equal(pairButton(page).getAttribute('disabled'), '');
  assert.equal(text(pairButton(page)), 'Pairing…');
  release(pairReply(200, null));
  await settle();
  const posts = page.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map((c) => c.body.name), ['Phone browser']);
});

test('pair: a refused code says so in the form, offers no second try, and tells what to run', async () => {
  const page = await start({ hash: PAIR_HASH, fetch: (target, init) => (target === '/api/pair' ? pairReply(401, 'pair-refused') : standard(target, init)) });
  pairForm(page).fire('submit');
  await settle();
  assert.equal(text(page.main.querySelector('.pair__failure-title')), 'This code was not accepted');
  assert.match(text(page.main.querySelector('.pair__failure-text')), /doflow ui --action pair/);
  assert.equal(pairButton(page).getAttribute('disabled'), '');
  pairForm(page).fire('submit');
  await settle();
  assert.equal(page.calls.filter((c) => c.method === 'POST').length, 1, 'the spent code is not posted again');
  assert.equal(apiCalls(page, '/api/info').length, 0);
});

test('pair: rate limited shows the wait and stays open for another try; full, busy, unreadable and offline each have their own words', async () => {
  const answers: Array<Reply | 'network'> = [pairReply(429, 'pair-rate-limited', { 'Retry-After': '540' }), pairReply(409, 'device-limit'), pairReply(503, 'store-busy'), pairReply(503, 'store-unreadable'), 'network'];
  const page = await start({ hash: PAIR_HASH, fetch: (target, init) => (target === '/api/pair' ? answers.shift() as any : standard(target, init)) });
  const titles: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    pairForm(page).fire('submit');
    await settle();
    titles.push(text(page.main.querySelector('.pair__failure-title')));
    if (i === 0) assert.match(text(page.main.querySelector('.pair__failure-text')), /Try again in 9 min/);
    assert.equal(pairButton(page).getAttribute('disabled'), null, `try ${i + 1} stays open`);
  }
  assert.deepEqual(titles, ['Pairing is paused', 'This Console has no room for another device', 'The device store is busy', 'The Console cannot read its device store', 'The Console did not answer']);
  assert.equal(page.calls.filter((c) => c.method === 'POST').length, 5);
});

test('pair: a device refused after pairing gets its own full page: unpaired, revoked, expired, store unreadable', async () => {
  const cases: Array<[number, string, string, string | null]> = [
    [401, 'device-unpaired', 'This device is not paired', 'doflow ui --action pair'],
    [401, 'device-revoked', 'This device was revoked', 'doflow ui --action pair'],
    [401, 'device-expired', 'This device was idle too long', 'doflow ui --action pair'],
    [503, 'store-unreadable', 'The Console cannot read its device store', null],
    [503, 'cert-expired', 'The Console’s certificate has ended', 'doflow ui --lan'],
  ];
  for (const [status, code, title, command] of cases) {
    const page = await start({ hash: '', fetch: (target, init) => (target === '/api/info' ? errorReply(status, code) : standard(target, init)) });
    assert.equal(text(heading(page)), title, code);
    const shown = page.main.querySelector('.cmd__text');
    assert.equal(shown ? text(shown) : null, command, code);
    assert.equal(page.conn.getAttribute('data-state'), 'failed');
    uninstallPage();
    mock.timers.reset();
  }
});

test('pair: a fragment that does not parse is removed and the page boots as it would without it', async () => {
  for (const hash of ['#pair=short&fp=abc&v=1', `#pair=${PAIR_CODE.toUpperCase()}&fp=${PAIR_FP}&v=1`, `#pair=${PAIR_CODE}&fp=${PAIR_FP}&v=2`, `#pair=${PAIR_CODE}&fp=${PAIR_FP}&v=1&x=1`]) {
    const page = await start({ hash, fetch: (target, init) => (target === '/api/info' ? errorReply(401, 'device-unpaired') : standard(target, init)) });
    assert.deepEqual(page.history, ['/#/'], hash);
    assert.equal(text(heading(page)), 'This device is not paired', hash);
    assert.equal(page.calls.filter((c) => c.method === 'POST').length, 0);
    uninstallPage();
    mock.timers.reset();
  }
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

test('162 review B-10: without storage a control built later marks the theme the page applies, not System', async () => {
  const page = await start({ hash: '', throwStorage: true, fetch: standard });
  page.radios[1].fire('click');
  assert.equal(page.doc.documentElement.dataset.theme, 'dark');
  goTo(page, '#/more');
  await settle();
  const radios = page.main.querySelectorAll('[data-theme-choice]');
  assert.deepEqual(radios.map((r: El) => r.getAttribute('aria-checked')), ['false', 'true', 'false'], 'the More page control marks Dark, the applied theme');
  assert.deepEqual(radios.map((r: El) => r.getAttribute('tabindex')), ['-1', '0', '-1']);
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
  assert.deepEqual(current(page), ['Now']);
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

// ---- 149 D.1: the shell's bands and the inspector API (IC-020, DEC-036) -----------------------------

test('shell: data-inspectable per view, the rail icons, and the docked column with its empty note at 1280 px and wider', async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(mods.views.VIEWS).map(([id, view]: [string, any]) => [id, view.inspectable])),
    { runs: false, run: true, tasks: true, session: true, sessions: true, workflows: false, layers: false, 'layers-project': true, settings: true, advice: true, followups: true, health: true, workers: true, compare: false, more: false, start: false, 'not-found': false });
  const page = await start({ hash: '', width: 1440, fetch: standard });
  assert.deepEqual(page.nav.map((a) => a.querySelector('.icon') && a.querySelector('.icon').getAttribute('class')),
    ['now', 'sessions', 'layers', 'more', 'followups', 'workflows', 'workers', 'advice', 'settings', 'health'].map((name) => `icon icon--20 icon--rail-${name}`));
  assert.equal(page.shell.dataset.inspectable, 'false');
  assert.equal(page.inspector.dataset.mode, 'dock');
  assert.equal(page.inspector.getAttribute('hidden'), '', 'no docked column on Runs');
  for (const [hash, inspectable] of [['#/run/feat-a/run-1', 'true'], ['#/workflows', 'false'], ['#/sessions', 'true'], ['#/run/feat-a/run-1/tasks', 'true'], ['#/x', 'false']]) {
    page.location.hash = hash;
    page.win.dispatch('hashchange');
    await settle();
    assert.equal(page.shell.dataset.inspectable, inspectable, hash);
    assert.equal(page.inspector.getAttribute('hidden'), '', `${hash}: no docked column while nothing is open, so an empty column takes no width`);
    assert.equal(page.shell.dataset.panel, 'closed', hash);
    if (inspectable === 'true') assert.equal(page.inspector.getAttribute('role'), null, 'docked, it is a complementary landmark, not a dialog');
  }
  page.location.hash = '#/run/feat-a/run-1/tasks';
  page.win.dispatch('hashchange');
  await settle();
  assert.deepEqual(current(page), ['Now'], 'Tasks marks Now');
  assert.equal(page.doc.querySelectorAll('.inspector__scrim').length, 1, 'one scrim');
  assert.equal(page.doc.querySelector('.inspector__scrim').getAttribute('hidden'), '', 'no scrim when docked');
});

test('shell: the band follows the width: dock at 1280, drawer from 768 to 1279, sheet below 768, and a resize re-reads it', () => {
  for (const [width, mode] of [[1920, 'dock'], [1280, 'dock'], [1279, 'drawer'], [768, 'drawer'], [767, 'sheet'], [360, 'sheet']] as Array<[number, string]>) {
    const page = installPage({ width, fetch: () => reply(204) });
    const inspector = mods.shell.createInspector({ doc: page.doc, shell: page.shell, el: page.inspector, main: page.main, matchMedia: globalThis.matchMedia });
    assert.equal(inspector.mode(), mode, `${width} px`);
    assert.equal(page.inspector.dataset.mode, mode);
    uninstallPage();
  }
  const page = installPage({ width: 1440, fetch: () => reply(204) });
  const inspector = mods.shell.createInspector({ doc: page.doc, shell: page.shell, el: page.inspector, main: page.main, matchMedia: globalThis.matchMedia });
  inspector.setInspectable(true);
  inspector.open({ title: 'Step', body: 'x' });
  assert.equal(page.inspector.getAttribute('role'), null);
  page.media.resize(1024);
  assert.equal(inspector.mode(), 'drawer');
  assert.equal(page.inspector.getAttribute('role'), 'dialog', 'open across the change, it becomes a dialog');
  assert.equal(page.inspector.getAttribute('aria-modal'), 'true');
  assert.equal(page.doc.querySelector('.inspector__scrim').getAttribute('hidden'), null);
  page.media.resize(1280);
  assert.equal(inspector.mode(), 'dock');
  assert.equal(page.inspector.getAttribute('role'), null);
  assert.equal(page.doc.querySelector('.inspector__scrim').getAttribute('hidden'), '');
  const noMedia = mods.shell.createInspector({ doc: page.doc, shell: page.shell, el: page.inspector, main: page.main });
  assert.equal(noMedia.mode(), 'dock', 'without matchMedia it docks');
});

test('inspector docked: open shows the title and body without taking focus; close empties it, keeps focus and calls onClose once', () => {
  const page = installPage({ width: 1440, fetch: () => reply(204) });
  const inspector = mods.shell.createInspector({ doc: page.doc, shell: page.shell, el: page.inspector, main: page.main, matchMedia: globalThis.matchMedia });
  inspector.setInspectable(true);
  const owner = page.doc.createElement('button');
  page.main.append(owner);
  owner.focus();
  const closed: string[] = [];
  const panel = mods.dom.h('p', { class: 'detail' }, 'Step detail');
  inspector.open({ title: 'implementation', body: panel, owner, onClose: () => closed.push('a') });
  assert.equal(inspector.isOpen(), true);
  assert.equal(text(page.inspector.querySelector('.inspector__title')), 'implementation');
  assert.equal(page.inspector.querySelector('.inspector__body').children[0], panel, 'the view passes the node it built');
  assert.equal(page.inspector.getAttribute('hidden'), null, 'the docked column appears with its content');
  assert.equal(page.shell.dataset.panel, 'open');
  assert.equal(page.doc.activeElement, owner, 'docked, focus stays where it was');
  inspector.open({ title: 'review', body: 'Other', onClose: () => closed.push('b') });
  assert.deepEqual(closed, ['a'], 'replacing the content closes the previous owner');
  assert.equal(text(page.inspector.querySelector('.inspector__body')), 'Other');
  page.inspector.fire('keydown', { key: 'Escape' });
  assert.equal(inspector.isOpen(), false, 'the close shortcut closes it');
  assert.deepEqual(closed, ['a', 'b']);
  assert.equal(text(page.inspector.querySelector('.inspector__title')), 'Details');
  assert.equal(page.inspector.querySelector('.inspector__body').children.length, 0);
  assert.equal(page.inspector.getAttribute('hidden'), '', 'the docked column leaves with its content');
  assert.equal(page.shell.dataset.panel, 'closed');
  assert.equal(page.doc.activeElement, owner);
  inspector.close();
  assert.deepEqual(closed, ['a', 'b'], 'a second close is a no-op');
});

test('inspector as drawer and sheet: a modal dialog with the scrim; focus moves in, Tab stays inside, and closing returns it', () => {
  for (const width of [1024, 360]) {
    const page = installPage({ width, fetch: () => reply(204) });
    const inspector = mods.shell.createInspector({ doc: page.doc, shell: page.shell, el: page.inspector, main: page.main, matchMedia: globalThis.matchMedia });
    inspector.setInspectable(true);
    const scrim = page.doc.querySelector('.inspector__scrim');
    assert.equal(page.inspector.getAttribute('hidden'), '', `${width}: hidden while closed`);
    assert.equal(scrim.getAttribute('hidden'), '');
    const owner = page.doc.createElement('button');
    page.main.append(owner);
    owner.focus();
    const link = mods.dom.h('a', { href: '#/layers' }, 'Open');
    inspector.open({ title: 'Lane', body: [mods.dom.h('p', {}, 'Lane detail'), link] });
    const close = page.inspector.querySelector('.inspector__close');
    assert.equal(page.inspector.getAttribute('hidden'), null);
    assert.equal(page.inspector.getAttribute('role'), 'dialog');
    assert.equal(page.inspector.getAttribute('aria-modal'), 'true');
    assert.equal(page.inspector.getAttribute('aria-label'), 'Details');
    assert.equal(scrim.getAttribute('hidden'), null);
    assert.equal(page.doc.activeElement, close, `${width}: focus moves into the inspector`);
    assert.ok(close.querySelector('.icon'), 'the close button has its icon');
    page.doc.activeElement = link;
    let event = page.inspector.fire('keydown', { key: 'Tab' });
    assert.equal(page.doc.activeElement, close, 'Tab from the last item wraps to the first');
    assert.equal(event.defaultPrevented, true);
    event = page.inspector.fire('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(page.doc.activeElement, link, 'Shift+Tab from the first wraps to the last');
    event = page.inspector.fire('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(event.defaultPrevented, false, 'inside the list, Tab moves as usual');
    page.inspector.fire('keydown', { key: 'Escape' });
    assert.equal(inspector.isOpen(), false);
    assert.equal(page.inspector.getAttribute('hidden'), '');
    assert.equal(page.inspector.getAttribute('role'), null);
    assert.equal(scrim.getAttribute('hidden'), '');
    assert.equal(page.doc.activeElement, owner, 'focus returns to the control that opened it');

    inspector.open({ title: 'Lane', body: 'x', owner });
    owner.remove();
    scrim.fire('click');
    assert.equal(inspector.isOpen(), false, 'a click on the scrim closes it');
    assert.equal(page.doc.activeElement, page.main, 'the owner is gone: focus goes to #main');
    inspector.open({ title: 'Lane', body: 'x' });
    close.fire('click');
    assert.equal(inspector.isOpen(), false, 'the close button closes it');
    uninstallPage();
  }
});

test('inspector open while docked: narrowing into drawer or sheet moves focus into it, and closing returns it to the owner', () => {
  for (const width of [1024, 360]) {
    const page = installPage({ width: 1440, fetch: () => reply(204) });
    const inspector = mods.shell.createInspector({ doc: page.doc, shell: page.shell, el: page.inspector, main: page.main, matchMedia: globalThis.matchMedia });
    inspector.setInspectable(true);
    const owner = page.doc.createElement('button');
    page.main.append(owner);
    owner.focus();
    const link = mods.dom.h('a', { href: '#/layers' }, 'Open');
    inspector.open({ title: 'Step', body: link, owner });
    assert.equal(page.doc.activeElement, owner, 'docked, focus stays on the owner');
    const close = page.inspector.querySelector('.inspector__close');
    page.media.resize(width);
    assert.equal(page.inspector.getAttribute('aria-modal'), 'true', `${width}: a modal dialog`);
    assert.equal(page.doc.activeElement, close, `${width}: focus moves into the inspector, to the close button`);
    page.doc.activeElement = link;
    page.media.resize(width === 1024 ? 360 : 1024);
    assert.equal(page.doc.activeElement, link, `${width}: between drawer and sheet, focus already inside stays where it is`);
    page.inspector.fire('keydown', { key: 'Escape' });
    assert.equal(inspector.isOpen(), false);
    assert.equal(page.doc.activeElement, owner, `${width}: focus returns to the control that opened it`);
    inspector.open({ title: 'Step', body: 'x', owner });
    page.media.resize(1440);
    owner.focus();
    page.media.resize(width);
    assert.equal(page.doc.activeElement, close, `${width}: docked again and narrowed again, focus moves in again`);
    uninstallPage();
  }
});

test('inspector name (FU-h7e7dx): open names it by the title and the labelledBy heading in every mode; without labelledBy the title alone; close drops it', () => {
  for (const width of [1440, 1024, 360]) {
    const page = installPage({ width, fetch: () => reply(204) });
    const inspector = mods.shell.createInspector({ doc: page.doc, shell: page.shell, el: page.inspector, main: page.main, matchMedia: globalThis.matchMedia });
    inspector.setInspectable(true);
    assert.equal(page.inspector.getAttribute('aria-labelledby'), null, `${width}: no name of its own while closed`);
    inspector.open({ title: 'Step details', labelledBy: 'rail-detail-title', body: mods.dom.h('h3', { id: 'rail-detail-title' }, 'planning') });
    assert.equal(page.inspector.getAttribute('aria-labelledby'), 'inspector-title rail-detail-title', `${width}: the title and the heading`);
    const named = String(page.inspector.getAttribute('aria-labelledby')).split(' ').map((id: string) => text(page.doc.getElementById(id)));
    assert.deepEqual(named, ['Step details', 'planning'], `${width}: both ids resolve inside the inspector`);
    inspector.open({ title: 'Lane details', body: 'x' });
    assert.equal(page.inspector.getAttribute('aria-labelledby'), 'inspector-title', `${width}: without labelledBy, the title alone`);
    inspector.close();
    assert.equal(page.inspector.getAttribute('aria-labelledby'), null, `${width}: close drops it`);
    assert.equal(page.inspector.getAttribute('aria-label'), 'Details', `${width}: index.html's label is left as it is`);
    uninstallPage();
  }
});

test('stale: setStale marks #inspector beside #main, and a route change clears both', async () => {
  let down = false;
  const page = await start({ hash: '#/run/feat-a/run-1', width: 1440, fetch: (target, init) => (target === '/api/runs/feat-a/run-1' ? (down ? errorReply(502, 'core-error') : runReply()) : standard(target, init)) });
  down = true;
  await advance(17000);
  assert.equal(page.main.getAttribute('data-stale'), 'true');
  assert.equal(page.inspector.getAttribute('data-stale'), 'true');
  page.location.hash = '#/workflows';
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(page.main.getAttribute('data-stale'), null);
  assert.equal(page.inspector.getAttribute('data-stale'), null);
});

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

test('device scope: restricted view explains access and links to runs without retrying', async () => {
  const page = await start({ hash: '#/sessions', fetch: (target, init) => (target === '/api/sessions' ? errorReply(403, 'phone-scope') : standard(target, init)) });
  assert.equal(text(page.main.querySelector('.state-panel__title')), 'This view is unavailable on a paired device');
  assert.match(text(page.main), /Paired devices can view runs, workflows, sessions and worker runs/);
  assert.equal(page.main.querySelector('a.btn').getAttribute('href'), '#/');
  assert.equal(page.main.querySelector('.countdown'), null);
  await advance(20_000);
  assert.equal(apiCalls(page, '/api/sessions').length, 1);
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
  assert.equal(page.conn.getAttribute('data-state'), 'unknown');
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
  await advance(100); // C.3: the live connector settles into polling first (the fake page has no stream support)
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

// The Running tile counts live runs only; silent runs (over a day) show as a Stale count beside it, and stay in the list.
const DAY_MS = 24 * 3_600_000;
const liveRuns = () => [frow('l1', 2, { updatedAt: agoIso(MIN_MS) }), frow('l2', 2, { updatedAt: agoIso(5 * MIN_MS) }), frow('l3', 2, { updatedAt: agoIso(9 * MIN_MS) })];
const staleRuns = () => [frow('s1', 2, { updatedAt: agoIso(DAY_MS + 3_600_000) }), frow('s2', 2, { updatedAt: agoIso(2 * DAY_MS) })];
async function runningTile(runs: () => any[]) {
  mods.home.resetHome();
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs())) });
  const tile = page.main.querySelectorAll('.tile')[1];
  return { page, tile, count: text(tile.querySelector('.tile__count')), chip: tile.querySelector('.tile__stale'), sub: text(tile.querySelector('.tile__sub-long')) };
}

test('E.1 home: 3 live and 2 stale runs: Running counts 3, a Stale count of 2 sits beside it, and the stale rows stay listed with their badge', async () => {
  const { page, tile, count, chip, sub } = await runningTile(() => [...liveRuns(), ...staleRuns()]);
  assert.equal(text(tile.querySelector('.tile__label')), 'Running');
  assert.equal(count, '3 live runs, 2 stale', 'read in order: the live count with its noun, then the chip');
  assert.equal(text(chip), '2 stale');
  assert.equal(sub, 'no update for 2 d');
  const running = page.main.querySelectorAll('.run-section')[1];
  assert.equal(running.querySelectorAll('.run-row').length, 5, 'stale runs stay in the list');
  assert.equal(running.querySelectorAll('.badge').map(text).filter((word) => word === 'Stale').length, 2);
});

test('E.1 home: a run that turns stale by age while no poll lands moves to the Stale count on the next tick', async () => {
  mods.home.resetHome();
  let down = false;
  // Built on the first read, under the mocked clock, and served unchanged after it.
  let snapshot: any = null;
  const runs = () => (snapshot ??= body([...liveRuns(), frow('edge', 2, { updatedAt: agoIso(DAY_MS - 30_000) })]));
  const page = await start({ hash: '', fetch: (target: string, init: any) => (target === '/api/runs' && down ? 'network' : homeFetch(runs)(target, init)) });
  const tile = () => page.main.querySelectorAll('.tile')[1];
  assert.equal(tile().querySelector('.tile__stale'), null);
  down = true;
  await advance(60_000);
  assert.equal(text(tile().querySelector('.tile__stale')), '1 stale');
  assert.equal(text(tile().querySelector('.tile__count')), '3 live runs, 1 stale');
});

test('E.1 home: 3 live and no stale runs: Running counts 3 and no Stale count shows', async () => {
  const { count, chip, sub } = await runningTile(liveRuns);
  assert.equal(count, '3');
  assert.equal(chip, null);
  assert.equal(sub, 'all updating');
});

test('E.1 home: only stale runs: Running counts 0 and the Stale count carries them', async () => {
  const { count, chip } = await runningTile(staleRuns);
  assert.equal(count, '0 live runs, 2 stale');
  assert.equal(text(chip), '2 stale');
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
  assert.deepEqual(page.main.querySelectorAll('.run-section__empty').map(text), ['Nothing is waiting for you in this project.', 'Nothing is running in this project right now.']);
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
  const detail = page.inspector.querySelector('.rail-detail');
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
  assert.equal(text(page.inspector.querySelector('.rail-detail__title')), 'gate-a', 'a second node switches the detail');
  const gateDetail = page.inspector.querySelector('.rail-detail');
  assert.deepEqual(gateDetail.querySelectorAll('dt').map(text), ['Kind', 'When asked', 'Asks', 'Recorded']);
  assert.equal(text(gateDetail.querySelectorAll('dd')[1]), 'Every run');
  buttons()[4].fire('click');
  assert.equal(page.inspector.querySelector('.rail-detail'), null, 'the same node closes it');
  buttons()[2].fire('click');
  assert.ok(page.inspector.querySelector('.rail-detail'));
  key(buttons()[2], 'Escape');
  assert.equal(page.inspector.querySelector('.rail-detail'), null);
  same(page.doc.activeElement, buttons()[2], 'focus stays on the node');
  buttons()[2].fire('click');
  const closes = closeControlsOf(page);
  assert.deepEqual(closes.map((b: El) => b.className), ['btn btn--ghost inspector__close'], 'one close control: the inspector\'s own');
  // Escape inside the detail closes it and returns focus to its node.
  page.inspector.querySelector('.rail-detail').fire('keydown', { key: 'Escape' });
  assert.equal(page.inspector.querySelector('.rail-detail'), null);
  same(page.doc.activeElement, buttons()[2], 'Escape in the detail returns focus to its node');
  buttons()[2].fire('click');
  closes[0].fire('click');
  assert.equal(page.inspector.querySelector('.rail-detail'), null);
  same(page.doc.activeElement, buttons()[2], 'the inspector\'s close returns focus to its node');
});

test('E.1 rail: the open detail and the roving stop survive a poll, focus stays on the same node, and the detail closes when its node is gone', async () => {
  mods.home.resetHome();
  let row0 = () => frow('run-1', 2);
  let workflow: any = WF_FEATURE;
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(row0(), workflow, [ev(30, 'start', null)])) });
  const buttons = () => page.main.querySelectorAll('.rail__node');
  buttons()[1].focus();
  buttons()[1].fire('click');
  assert.ok(page.inspector.querySelector('.rail-detail'));
  const old = buttons()[1];
  row0 = () => frow('run-1', 3);
  await advance(3_000);
  assert.ok(buttons()[1] !== old, 'the body was re-mounted');
  assert.equal(text(page.inspector.querySelector('.rail-detail__title')), 'gate-0', 'the detail stays open');
  same(page.doc.activeElement, buttons()[1], 'focus is restored by node key');
  assert.deepEqual(buttons().map((b) => b.getAttribute('tabindex')), ['-1', '0', '-1', '-1', '-1'], 'the roving stop stays where the person put it');
  workflow = { ...WF_FEATURE, stages: WF_FEATURE.stages.slice(1) };
  row0 = () => frow('run-1', 3, { progress: { done: 3, total: 3 } });
  await advance(3_000);
  assert.equal(page.inspector.querySelector('.rail-detail'), null, 'its node no longer exists: the detail closes');
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
  const detail = page.inspector.querySelector('.rail-detail');
  detail.fire('keydown', { key: 'Escape' });
  assert.ok(page.inspector.querySelector('.rail-detail') === null, 'closed');
  same(page.doc.activeElement, buttons()[3], 'focus is on the node');
  buttons()[3].fire('click');
  page.inspector.querySelector('.rail-detail').fire('keydown', { key: 'a' });
  assert.ok(page.inspector.querySelector('.rail-detail'), 'another key leaves it open');
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
  assert.deepEqual(sub(tiles[1]), ['no update for 2 d 2 h', 'no update for 2 d 2 h']);
  assert.equal(text(tiles[1].querySelector('.tile__count')), '1 live run, 1 stale', 'one live run, one stale beside it');
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

test('E.2 gate slot: registry name and prompt, two commands with their own Copy names, the note on where deciding works, and a wait that counts from the last progress event', async () => {
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
    'doflow orchestrate --action decide-gate --task-id run-1 --slug feat-a --gate gate-a --decision approve',
    'doflow orchestrate --action decide-gate --task-id run-1 --slug feat-a --gate gate-a --decision reject',
  ]);
  assert.deepEqual(slot.querySelectorAll('.cmd__copy').map((b: El) => b.getAttribute('aria-label')), ['Copy the approve command', 'Copy the reject command']);
  assert.deepEqual(slot.querySelectorAll('.cmd__copy').map((b: El) => b.getAttribute('data-focus-key')), ['copy:approve', 'copy:reject']);
  assert.equal(text(slot.querySelector('.activity__note')), 'Deciding from this page needs the Console on this machine or a paired control device. The terminal commands still work.');
  assert.match(text(slot.querySelector('.activity__tasks')), /^1 task attempt is still active\. Open the task graph →$/);
  assert.equal(slot.querySelector('.attempts__link').getAttribute('href'), '#/run/feat-a/run-1/tasks');
  assert.equal(slot.getAttribute('data-changed'), null, 'nothing flashes on first paint');
  assert.equal(slot.querySelectorAll('button').length, 2, 'only the two Copy buttons: the page has not been told it may act (no /api/actions)');
});

// ---- 162 IC-010: the actions on the run page ----------------------------------------------------

const PK162 = '0123456789abcdef';
const actionsReply = (allowed: boolean, reason: string | null, actor: any, project: any = { projectKey: PK162, label: 'do-flow' }) => reply(200, {
  v: 1, actor, textMax: 500, limits: {}, ...(project ? { project } : {}),
  actions: ['decide-gate', 'close-run', 'cancel-worker'].map((id) => ({ id, allowed, reason })),
});
/** The page's actions as the run page finds them are read once per page load; each 162 test starts from nothing and leaves the "read failed" state the others expect. */
async function withActions(run: () => Promise<void>) {
  mods.confirm.releaseActionAreas();
  mods.actions.resetActions();
  try {
    await run();
  } finally {
    mods.confirm.closeConfirm();
    mods.confirm.releaseActionAreas();
    mods.actions.resetActions();
  }
}
const gateEvents162 = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(30, 'complete-stage', 'design', { outcome: 'passed' }), ev(20, 'complete-stage', 'planning', { outcome: 'passed' })];

test('162 run page, a view-scope device: no button anywhere, the command block stays with one muted reason line, and nothing is posted', async () => {
  mods.home.resetHome();
  await withActions(async () => {
    const route = (target: string, init: any) => (target === '/api/actions' ? actionsReply(false, 'phone-scope', { kind: 'device', deviceId: 'd-0a1b2c3d4e5f', scope: 'view', transport: 'browser' })
      : runRoute(() => runBodyWith(frow('run-1', 4, { revision: 6 }), gateEvents162()))(target, init));
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    const slot = page.main.querySelector('.activity--gate');
    assert.equal(slot.querySelectorAll('.btn--act').length, 0);
    assert.deepEqual(slot.querySelectorAll('.cmd__text').map(text), [
      'doflow orchestrate --action decide-gate --task-id run-1 --slug feat-a --gate gate-a --decision approve',
      'doflow orchestrate --action decide-gate --task-id run-1 --slug feat-a --gate gate-a --decision reject',
    ]);
    assert.deepEqual(slot.querySelectorAll('.acts__reason').map(text), ['Actions need a control device paired from the Android app.']);
    assert.equal(text(slot.querySelector('.activity__note')), 'Deciding from this page needs the Console on this machine or a paired control device. The terminal commands still work.');
    assert.equal(page.calls.filter((c) => c.method === 'POST').length, 0);
  });
});

test('162 run page, the local actor: Approve and Reject replace the command block; Approve opens the dialog with focus on Cancel and posts only from its verb button, with the revision the page drew', async () => {
  mods.home.resetHome();
  await withActions(async () => {
    const route = (target: string, init: any) => {
      if (target === '/api/actions' && (init.method ?? 'GET') === 'GET') return actionsReply(true, null, { kind: 'local', transport: 'loopback' });
      if (target === '/api/actions/decide-gate') return reply(200, { v: 1, action: 'decide-gate', requestId: 'x', outcome: 'applied', replayed: false, by: 'console', result: { taskId: 'run-1', featureSlug: 'feat-a', state: 'RUNNING', revision: 7, awaitingGate: null, current: { type: 'stage', id: 'implementation' } } });
      return runRoute(() => runBodyWith(frow('run-1', 4, { revision: 6 }), gateEvents162()))(target, init);
    };
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    const slot = page.main.querySelector('.activity--gate');
    const buttons = slot.querySelectorAll('.btn--act');
    assert.deepEqual(buttons.map(text), ['Approve', 'Reject']);
    assert.deepEqual(buttons.map((b: El) => b.getAttribute('data-tone')), ['approve', 'danger']);
    assert.deepEqual(page.main.querySelector('.run-head__acts').querySelectorAll('.btn--act').map(text), ['Close run'], 'Close run is in the run head, not in the slot');
    assert.equal(slot.querySelectorAll('.cmd__text').length, 0, 'the buttons replace the command block');
    assert.equal(page.calls.filter((c) => c.method === 'POST').length, 0, 'drawing a button posts nothing');
    buttons[0].fire('click');
    const dialog = page.doc.body.querySelector('.confirm');
    assert.ok(dialog, 'the dialog is open');
    assert.equal(page.doc.activeElement, dialog.querySelector('.confirm__cancel'));
    assert.equal(text(dialog.querySelector('.confirm__effect')), 'Approve Name of gate-a (gate-a) of run feat-a/run-1 in do-flow. The run continues past this gate.');
    assert.equal(page.calls.filter((c) => c.method === 'POST').length, 0, 'opening the dialog posts nothing');
    const reads = apiCalls(page, '/api/runs/feat-a/run-1').length;
    dialog.querySelector('.confirm__verb').fire('click');
    await settle();
    assert.equal(apiCalls(page, '/api/runs/feat-a/run-1').length, reads + 1, '162: an applied action makes the page read the run again at once, not at its next interval');
    const posts = page.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/api/actions/decide-gate');
    assert.deepEqual({ ...posts[0].body, requestId: undefined }, { v: 1, projectKey: PK162, slug: 'feat-a', taskId: 'run-1', gateId: 'gate-a', decision: 'approve', note: null, expect: { revision: 6 }, requestId: undefined });
    assert.equal(text(dialog.querySelector('.confirm__result')), 'Approved. The page shows the run\u2019s new state.');
  });
});

test('162 review B-4: the dialog closes on a route change, and while it is open the global shortcuts do nothing; palette and help cannot open over it', async () => {
  mods.home.resetHome();
  await withActions(async () => {
    const route = (target: string, init: any) => (target === '/api/actions' ? actionsReply(true, null, { kind: 'local', transport: 'loopback' })
      : runRoute(() => runBodyWith(frow('run-1', 4, { revision: 6 }), gateEvents162()))(target, init));
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    const openDialog = () => {
      page.main.querySelector('.activity--gate').querySelectorAll('.btn--act')[0].fire('click');
      const dialog = page.doc.body.querySelector('.confirm');
      assert.ok(dialog, 'the dialog is open');
      return dialog;
    };
    const dialog = openDialog();
    const cancel = dialog.querySelector('.confirm__cancel');
    for (const [key, extra] of [['?', {}], ['k', { ctrlKey: true }], ['k', { metaKey: true }], ['p', {}], ['g', {}], ['r', {}], ['g', {}], ['w', {}]] as const) {
      const event = keydownOn(page, key, extra);
      assert.equal(event.defaultPrevented, false, `${key} is not taken`);
    }
    assert.equal(page.doc.getElementById('help'), null, 'the help list did not open');
    assert.equal(paletteOf(page), null, 'the palette did not open');
    assert.equal(page.pause.getAttribute('aria-pressed'), 'false', 'p did not pause');
    assert.equal(page.location.hash, '#/run/feat-a/run-1', 'no chord navigated');
    assert.equal(page.doc.body.querySelector('.confirm'), dialog, 'the dialog is still open');
    assert.equal(page.doc.activeElement, cancel);

    goTo(page, '#/');
    await settle();
    assert.equal(page.doc.body.querySelector('.confirm'), null, 'a route change closes it');
    keydownOn(page, '?');
    assert.notEqual(page.doc.getElementById('help'), null, 'with it closed the shortcuts work again');
    keydownOn(page, 'Escape');

    // Back (a hashchange to the run again, then away) closes a dialog opened there too.
    goTo(page, '#/run/feat-a/run-1');
    await settle();
    openDialog();
    goTo(page, '#/');
    await settle();
    assert.equal(page.doc.body.querySelector('.confirm'), null);
  });
});

test('162 run page: the timeline says who decided or closed a step; a stage that is running has a Close run button and no decision buttons', async () => {
  mods.home.resetHome();
  await withActions(async () => {
    const events = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve', by: 'device.d-0a1b2c3d4e5f' }), ev(30, 'decide-gate', 'gate-1', { decision: 'approve', by: 'autopilot' })];
    const route = (target: string, init: any) => (target === '/api/actions' ? actionsReply(true, null, { kind: 'local', transport: 'loopback' })
      : runRoute(() => runBodyWith(frow('run-1', 3, { revision: 4 }), events()))(target, init));
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    assert.deepEqual(page.main.querySelectorAll('.tl-item__by').map(text), ['by autopilot', 'from paired device d-0a1b2c3d4e5f']);
    const slot = page.main.querySelector('.activity--stage');
    assert.equal(slot.querySelectorAll('.btn--act').length, 0, 'the slot has no button: Close run is in the run head');
    const head = page.main.querySelector('.run-head__acts');
    assert.deepEqual(head.querySelectorAll('.btn--act').map(text), ['Close run']);
    head.querySelector('.btn--act').fire('click');
    const dialog = page.doc.body.querySelector('.confirm');
    assert.equal(text(dialog.querySelector('.confirm__effect')), 'Close run feat-a/run-1 in do-flow, now at planning. It ends as closed where it stands. This cannot be undone.');
    assert.equal(dialog.querySelector('.confirm__verb').getAttribute('disabled') !== null, true, 'a close needs a reason');
  });
});

test('162 run page: a Console that does not name its project gives no button (nothing to build a request from) and the command block stays', async () => {
  mods.home.resetHome();
  await withActions(async () => {
    const route = (target: string, init: any) => (target === '/api/actions' ? actionsReply(true, null, { kind: 'local', transport: 'loopback' }, null)
      : runRoute(() => runBodyWith(frow('run-1', 4), gateEvents162()))(target, init));
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    assert.equal(page.main.querySelectorAll('.btn--act').length, 0);
    assert.equal(page.main.querySelectorAll('.cmd__text').length, 2);
  });
});

test('162 run page, the run head: no Close run for a view-scope device, and none when the run is over', async () => {
  mods.home.resetHome();
  await withActions(async () => {
    const route = (target: string, init: any) => (target === '/api/actions' ? actionsReply(false, 'phone-scope', { kind: 'device', deviceId: 'd-0a1b2c3d4e5f', scope: 'view', transport: 'browser' })
      : runRoute(() => runBodyWith(frow('run-1', 3, { revision: 4 }), gateEvents162()))(target, init));
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    assert.equal(page.main.querySelector('.run-head__acts').querySelectorAll('.btn--act').length, 0);
  });
  uninstallPage();
  mock.timers.reset();

  mods.home.resetHome();
  await withActions(async () => {
    const route = (target: string, init: any) => (target === '/api/actions' ? actionsReply(true, null, { kind: 'local', transport: 'loopback' })
      : runRoute(() => runBodyWith(frow('run-1', 5), gateEvents162()))(target, init));
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    assert.equal(page.main.querySelector('.run-head__acts').querySelectorAll('.btn--act').length, 0);
  });
});

test('162 run page, the run head: the Close run button leaves the head when the run completes', async () => {
  mods.home.resetHome();
  await withActions(async () => {
    let cursor = 3;
    const route = (target: string, init: any) => (target === '/api/actions' ? actionsReply(true, null, { kind: 'local', transport: 'loopback' })
      : runRoute(() => runBodyWith(frow('run-1', cursor, { revision: 4 }), gateEvents162()))(target, init));
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    assert.deepEqual(page.main.querySelector('.run-head__acts').querySelectorAll('.btn--act').map(text), ['Close run']);
    cursor = 5;
    await advance(3_000);
    assert.equal(page.main.querySelector('.run-head__acts').querySelectorAll('.btn--act').length, 0, 'a run that is over has no Close run');
  });
});

test('162 review B-11: a run page re-rendered by its polls, and then left, holds none of the action areas it took off the page', async () => {
  const v8 = require('node:v8');
  const vm = require('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const collected = async (ref: WeakRef<object>) => {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
    return ref.deref() === undefined;
  };
  mods.home.resetHome();
  await withActions(async () => {
    let revision = 6;
    const route = (target: string, init: any) => (target === '/api/actions' ? actionsReply(true, null, { kind: 'local', transport: 'loopback' })
      : runRoute(() => runBodyWith(frow('run-1', 4, { revision }), gateEvents162()))(target, init));
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    const areasNow = () => [page.main.querySelector('.activity--gate').querySelector('.acts'), page.main.querySelector('.acts--close')];
    const first = areasNow().map((node) => new WeakRef(node));
    assert.ok(first.every((ref) => ref.deref()), 'the page draws the gate buttons and Close run');
    revision = 7;
    await advance(3_000);
    const second = areasNow();
    assert.ok(second.every((node, i) => node && node !== first[i].deref()), 'the poll re-rendered both areas');
    const secondRefs = second.map((node) => new WeakRef(node));
    second.length = 0;
    for (const ref of first) assert.equal(await collected(ref), true, 'an area a re-render took off the page is not held');
    goTo(page, '#/');
    await settle();
    for (const [i, ref] of secondRefs.entries()) assert.equal(await collected(ref), true, `leaving the view lets its areas go (${i})`);
  });
});

test('162 run page: a completed run has nothing to decide or close, whatever the page may do', async () => {
  mods.home.resetHome();
  await withActions(async () => {
    const route = (target: string, init: any) => (target === '/api/actions' ? actionsReply(true, null, { kind: 'local', transport: 'loopback' })
      : runRoute(() => runBodyWith(frow('run-1', 5), gateEvents162()))(target, init));
    const page = await start({ hash: '#/run/feat-a/run-1', fetch: route });
    assert.equal(page.main.querySelectorAll('.btn--act').length, 0);
  });
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
  assert.equal(page.inspector.querySelector('.graph__panel'), null, 'no task is open, so the inspector holds no panel');
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
  const panel = page.inspector.querySelector('.graph__panel');
  assert.equal(panel.getAttribute('hidden'), null);
  assert.equal(page.main.querySelector('.graph').getAttribute('data-open'), 'true');
  assert.equal(text(panel.querySelector('.graph__paneltitle')), 'A.1');
  assert.deepEqual(panel.querySelectorAll('dt').map(text), ['Phase', 'Lane', 'Planned owner', 'Attempts', 'Position', 'Waits for']);
  assert.deepEqual(panel.querySelectorAll('dd').map(text), ['A', 'worker-a (running an attempt)', 'core-implementer', '1 of 20 attempts', 'Layer 1', 'nothing']);
  assert.equal(text(panel.querySelector('.gdetail__why')), 'An attempt is running.');
  assert.equal(panel.querySelectorAll('.gattempt').length, 1);
  assert.match(text(panel.querySelector('.gattempt')), /^Attempt 1worker-a · sequentialactivesince \d\d:\d\d$/);
  assert.equal(page.main.querySelectorAll('.graph__edge').filter((e: El) => e.getAttribute('data-active') === 'true').length, 1, 'the edge A.1>B.1 is marked');
  assert.deepEqual(closeControlsOf(page).map((b: El) => b.className), ['btn btn--ghost inspector__close'], 'one close control: the inspector\'s own');
  assert.equal(panel.querySelectorAll('button').length, 0, 'the panel holds no close control of its own');
  assert.equal(panel.querySelectorAll('input, textarea, select').length, 0);

  // Escape inside the panel closes it and puts the focus back on the card.
  page.inspector.fire('keydown', { key: 'Escape', target: panel.querySelector('.graph__paneltitle') });
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
  assert.equal(text(page.inspector.querySelector('.graph__paneltitle')), 'B.1');
  assert.equal(text(page.inspector.querySelector('.graph__panel').querySelector('.badge')), 'Running');
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
  const slot = page.inspector.querySelector('.graph__panel');
  assert.equal(slot.getAttribute('hidden'), null);
  // sinceStamp prefixes `D Mon ` when the instant is not on today's local date, so a run just after
  // midnight shows the day on a start or end from the previous date (FU-8xhd5w).
  assert.match(text(slot.querySelector('.gattempt')), /^Attempt 1quality-guardian · sequentialfinished, completed(?:\d{1,2} [A-Z][a-z]{2} )?\d\d:\d\d to (?:\d{1,2} [A-Z][a-z]{2} )?\d\d:\d\d \(10 min\)$/);
  assert.equal(page.inspector.querySelectorAll('.graph__panel').filter((s: El) => s.getAttribute('hidden') === null).length, 1);
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
  assert.ok(!tags(page.inspector).includes('img'));
  assert.ok(text(page.inspector.querySelector('.gattempt__owner')).startsWith(hostile));
});

// ---- E.4: the replay bar on the run view and the task graph ---------------------------------------------------------

const replayEvents = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(30, 'complete-stage', 'design', { outcome: 'passed' }), ev(20, 'complete-stage', 'planning', { outcome: 'passed' })];
const replayOf = (page: Page): any => ({
  bar: page.main.querySelector('.replay'), range: page.main.querySelector('.replay__range'), banner: page.main.querySelector('.replay__banner'),
  read: text(page.main.querySelector('.replay__read')), button: (label: string): any => page.main.querySelectorAll('.replay__btn').find((b: El) => b.getAttribute('aria-label') === label),
});
const scrubTo = (page: Page, index: number) => { const { range } = replayOf(page); range.value = String(index); range.fire('input'); };

test('E.4 run view: replay sits between activity and timeline; scrubbing draws the rail and slot at that event, with a banner; a poll keeps the place; play runs to the end; Back to live clears it', async () => {
  mods.home.resetHome();
  // Run events at 60, 50, 40, 30 and 20 min ago plus A.2 claimed (50) and finished (40), A.1 claimed (12): ten events.
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', 4), replayEvents(), GRAPH_PLAN())) });
  const kids = page.main.querySelector('.view-body').children.filter((c: any) => c instanceof El).map((c: El) => c.className.split(' ')[0]);
  assert.deepEqual(kids, ['replay-host'], `the run view and contextual replay controls share one ordered host: ${kids}`);
  const hosted = page.main.querySelector('.replay-host').children.filter((c: any) => c instanceof El).map((c: El) => c.className.split(' ')[0]);
  assert.ok(hosted.indexOf('activity') < hosted.indexOf('replay'), `activity comes before its replay controls: ${hosted}`);
  assert.ok(hosted.indexOf('replay') < hosted.indexOf('timeline'), `replay controls sit next to the timeline: ${hosted}`);
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
  const replayOrder = page.main.querySelector('.replay-host').children.filter((c: any) => c instanceof El).map((c: El) => c.className.split(' ')[0]);
  assert.ok(replayOrder.indexOf('replay__banner') < replayOrder.indexOf('activity'), `the replay notice labels history before it is read: ${replayOrder}`);
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
  assert.equal(text(page.inspector.querySelector('.graph__paneltitle')), 'A.2');
  scrubTo(page, 3);
  assert.equal(page.inspector.querySelector('.graph__paneltitle') && text(page.inspector.querySelector('.graph__paneltitle')), 'A.2', 'the open task stays open while scrubbing');
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
  sessionKey: sk(100 + n), worktreeKey: sk(wk), kind: 'hook', harness: 'codex', model: 'gpt-6-luna', modelFirstSeenAt: agoIso(3 * 60 * MIN_MS), contextCapturedAt: agoIso(3 * 60 * MIN_MS),
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
  assert.match(hook.getAttribute('aria-label'), /^Hook session, codex, model gpt-6-luna, context captured \d\d:\d\d, last hook record \d\d:\d\d, holds nothing, checkout feat-1$/);
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
  await settle();
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
  assert.equal(page.inspector.querySelector('.spanel'), null, 'no lane is open, so the inspector holds no panel');
  lock.fire('click');
  assert.equal(slaneOf(page, 'lock:build').getAttribute('aria-expanded'), 'true');
  const open = page.inspector.querySelector('.spanel');
  assert.equal(open.getAttribute('hidden'), null);
  assert.equal(page.main.querySelector('.sessions').getAttribute('data-open'), 'true');
  assert.equal(text(open.querySelector('.spanel__title')), 'Lock build');
  assert.deepEqual(open.querySelectorAll('dt').map(text), ['Kind', 'Checkout', 'Label', 'Process', 'Held since', 'Waiting']);
  assert.equal(text(open.querySelector('.cmd__text')), 'doflow slot --action peek --json', 'the command is text with a Copy button, never a button that runs it');
  assert.equal(open.querySelectorAll('input, textarea, select').length, 0);
  assert.ok(page.doc.activeElement === slaneOf(page, 'lock:build'), 'the lane keeps the focus after it opens');
  assert.deepEqual(closeControlsOf(page).map((b: El) => b.className), ['btn btn--ghost inspector__close'], 'one close control: the inspector\'s own');

  page.inspector.fire('keydown', { key: 'Escape', target: open.querySelector('.spanel__title') });
  assert.equal(open.getAttribute('hidden'), '');
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
  assert.ok(!tags(page.inspector).includes('img') && !tags(page.inspector).includes('script'));
  assert.ok(text(page.inspector.querySelector('.spanel')).includes(hostile));
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

// ---- 161: the Layers views draw from /api/live frames alone (design section 8; FR-009, FR-012, AC-5) -----------------------------
// A fake EventSource stands in for the Console. The cases check that no GET reads a Layers page, that the first paint is the first
// frame, the stream states (connecting, following, stream down, refused, unsupported, core-lacks-channel), the one loop of a view,
// the inspector lanes, and what the page may say.

const fk = (n: number) => n.toString(16).padStart(16, '0');
const P1 = fk(0x11);
const P2 = fk(0x12);
const [A_MAIN, A_SUB, A_OC] = [fk(0xa1), fk(0xa2), fk(0xa3)];
const F_BRIEF = fk(0xf1);
const WK_MAIN = fk(0xb1);
const AT = (min: number) => new Date(Date.UTC(2026, 9, 27, 12, 0, 0) - min * 60_000).toISOString();

/**
 * A scripted EventSource: tests open it, emit named events and fail it. While open it hears the live server's `keepalive`
 * every 15 s (console/src/live-stream.ts KEEPALIVE_MS), so a quiet open stream stays open past the adapter's silence
 * timer; a case that wants the silence of a frozen server sets `keepalive = false`.
 */
class FakeES {
  static all: FakeES[] = [];
  url: string;
  readyState = 0;
  closed = false;
  keepalive = true;
  beat: any = null;
  listeners = new Map<string, Function[]>();
  constructor(url: string) { this.url = url; FakeES.all.push(this); }
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close() { this.readyState = 2; this.closed = true; this.stopBeat(); }
  emit(type: string, data?: unknown) { for (const fn of this.listeners.get(type) ?? []) fn({ type, data: data === undefined ? undefined : JSON.stringify(data), lastEventId: '' }); }
  open() {
    this.readyState = 1;
    this.stopBeat();
    this.beat = setInterval(() => { if (this.keepalive && this.readyState === 1) this.emit('keepalive', {}); }, 15_000);
    if (this.beat && typeof this.beat.unref === 'function') this.beat.unref();
    this.emit('open');
  }
  fail(state = 0) { this.readyState = state; if (state === 2) this.stopBeat(); this.emit('error'); }
  stopBeat() { if (this.beat !== null) clearInterval(this.beat); this.beat = null; }
}
const esOf = (match: string): FakeES => FakeES.all.filter((e) => e.url.includes(match) && !e.closed).at(-1)!;

const BAD_WORDS = /\b(active|online|idle|live|working|busy)\b/i;
const mutated: string[] = [];
after(() => { for (const dir of mutated) fs.rmSync(dir, { recursive: true, force: true }); });

/** A private copy of the web root: dom.js keeps one announcer per module instance, and a pending timer of an earlier test (mock time was reset) would hold this test's message back. */
function freshWeb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-client-fresh-'));
  mutated.push(dir);
  fs.cpSync(WEB_ROOT, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  return dir;
}

const lok = (data: any) => ({ ok: true, data });
const lbad = (code: string) => ({ ok: false, code });
const gateOf = (taskId: string, gateId: string, name: string | null, minAgo = 5) => ({ slug: 'feat-a', taskId, gateId, name, recordAt: AT(minAgo) });
const machineBody = (gates: any[] = [], over: any = {}) => ({
  v: 1,
  sections: {
    projects: lok({ v: 1, store: 'present', excluded: { missing: 1, temp: 2, notDoflow: 3, unreadable: 0 }, truncated: false, projects: [
      { projectKey: P1, label: 'example-project', current: true, temp: false, checkouts: 2, sources: [], lastRecordAt: AT(3) },
      { projectKey: P2, label: 'other-project', current: false, temp: true, checkouts: 1, sources: [], lastRecordAt: null },
    ] }),
    activity: lok({ v: 1, limits: { projects: 2, notShown: 0, watched: 2, fingerprintOnly: 0 }, items: [
      { projectKey: P1, runs: { open: 1, awaiting: gates.length }, gates, workers: { open: 0 }, sessions: { observed: 2, harnesses: ['claude'] }, unreadable: [] },
      { projectKey: P2, runs: { open: 0, awaiting: 0 }, gates: [], workers: { open: 0 }, sessions: { observed: 0, harnesses: [] }, unreadable: [] },
    ] }),
    ...over,
  },
});
const lnode = (key: string, over: any = {}) => ({
  agentKey: key, kind: 'main-session', harness: 'claude', model: 'model-a', modelBasis: 'hook-observation', label: null, depth: 0, worktreeKey: WK_MAIN,
  startedAt: null, contextCapturedAt: AT(90), lastRecordAt: AT(3), liveness: 'not-checked', ended: null, transcript: { reader: 'claude-jsonl', linked: true, reason: null }, ...over,
});
const never = { observed: false, reason: 'no-audit-hook' };
const layersBody = (over: any = {}) => ({
  v: 1, projectKey: P1,
  sections: {
    checkouts: lok([{ worktreeKey: WK_MAIN, label: 'do-flow', branch: 'feat/161', main: true }]),
    tree: lok({ v: 1, projectKey: P1, nodes: [lnode(A_MAIN), lnode(A_SUB, { kind: 'harness-subagent', label: 'system-architect', depth: 1 }), lnode(A_OC, { kind: 'harness-subagent', harness: 'opencode', depth: 1, transcript: { reader: null, linked: false, reason: 'no-reader' } })], edges: [], limits: { nodes: 3, notChecked: 0 }, unreadable: 0 }),
    runs: lok({ v: 1, runs: [], limits: {} }),
    gates: lok([]),
    artifacts: lok([{ fileKey: F_BRIEF, kind: 'brief', worktreeKey: WK_MAIN, feature: 'feat-a', task: 'T-3', bytes: 20, at: AT(8) }]),
    reviews: lok([]),
    sessions: lok([]),
    traffic: lok({ v: 1, projectKey: P1, windowMin: 10, agents: [], models: [], pairs: [], notChecked: 0 }),
    coverage: lok([
      { harness: 'claude', main: { observed: true }, subagents: { observed: true }, transcript: { observed: true }, permissions: { observed: true }, questions: { observed: false, reason: 'no-harness-record' } },
      { harness: 'opencode', main: { observed: true }, subagents: never, transcript: never, permissions: never, questions: { observed: true } },
    ]),
    ...over,
  },
});
const member = (name: string, body: any) => ({ state: { [name]: { status: 200, body } } });

/** Boots a Layers page over a private copy of the web root; the base route answers the boot reads only. */
async function startLayers(hash: string, eventSource: unknown = FakeES, base: (target: string, init: any) => Reply | Promise<Reply> = standard): Promise<Page> {
  FakeES.all = [];
  liveSeq = 0;
  return start({ hash, fetch: (target: string, init: any) => (target.startsWith('/api/live') ? reply(500) : base(target, init)), eventSource: eventSource === 'absent' ? undefined : eventSource }, freshWeb());
}
/** The page's one stream, opened, with the machine snapshot (and the project snapshot on a project page) delivered. */
async function openedLayers(page: Page, gates: any[] = [], layers: any = layersBody()) {
  await advance(100);
  const es = liveES();
  es.open();
  const project = decodeURIComponent(es.url).includes('layers:');
  if (project) es.emit('message', liveFrame(`layers:${P1}`, 'snapshot', member('layers', layers)));
  es.emit('message', liveFrame('machine', 'snapshot', member('machine', machineBody(gates))));
  await settle();
  return es;
}
const channelsOf = (es: FakeES) => decodeURIComponent(new URL(es.url, 'http://x').searchParams.get('ch') ?? '').split(',').sort();
const GETS_OF_THE_OLD_FLEET = ['/api/fleet', '/api/stream', '/api/transcript', '/api/machine', '/api/layers'];
const noReads = (page: Page) => { for (const gone of GETS_OF_THE_OLD_FLEET) assert.equal(apiCalls(page, gone).length, 0, `no GET of ${gone}`); };
const loops = (page: Page) => page.main.querySelectorAll('[data-loop="on"]').length;

test('161 layers: routes take only 16-hex keys; the title, the nav item and the views read', () => {
  const { parseRoute, titleFor, navFor, hashFor, VIEWS } = mods.views;
  assert.equal(parseRoute('#/layers').id, 'layers');
  assert.deepEqual(parseRoute(`#/layers/${P1}`).params, { project: P1 });
  assert.deepEqual(parseRoute(`#/layers/${P1}/agent/${A_MAIN}`).params, { project: P1, agent: A_MAIN });
  assert.deepEqual(parseRoute(`#/layers/${P1}/file/${F_BRIEF}`).params, { project: P1, file: F_BRIEF });
  for (const bad of ['#/layers/', '#/layers/xyz', `#/layers/${'A'.repeat(16)}`, `#/layers/${P1}/agent`, `#/layers/${P1}/agent/${A_MAIN}/x`, `#/layers/${P1}/agent/not-a-key`,
    `#/layers/${P1}/other/${A_MAIN}`, '#/layers/../x', `#/layers/${'a'.repeat(17)}`, '#/fleet', `#/fleet/${P1}`]) {
    assert.equal(parseRoute(bad).id, 'not-found', bad);
  }
  assert.equal(titleFor(parseRoute('#/layers')), 'Layers · DoFlow Console');
  assert.equal(navFor(parseRoute('#/layers')), 'layers');
  assert.equal(navFor(parseRoute(`#/layers/${P1}/agent/${A_MAIN}`)), 'layers');
  for (const id of ['layers', 'layers-project']) {
    assert.equal(VIEWS[id].live, true);
    assert.equal(VIEWS[id].api(), null, `${id} reads no GET`);
    assert.equal(VIEWS[id].pollMs, 0, `${id} has no poll`);
    assert.deepEqual(VIEWS[id].shapes, []);
  }
  assert.equal(VIEWS.fleet, undefined);
  assert.equal(VIEWS['fleet-project'], undefined);
  const body = { machine: machineBody([]), layers: layersBody() };
  assert.equal(titleFor(parseRoute(`#/layers/${P1}`), body), 'example-project · Layers · DoFlow Console');
  assert.equal(titleFor(parseRoute(`#/layers/${P1}/agent/${A_SUB}`), body), 'system-architect · example-project · Layers · DoFlow Console');
  assert.match(titleFor(parseRoute(`#/layers/${P1}`), null), / · Layers · DoFlow Console$/, 'a project not in the machine member still has a title');
  for (const hash of ['#/layers', `#/layers/${P1}`, `#/layers/${P1}/agent/${A_MAIN}`, `#/layers/${P1}/file/${F_BRIEF}`]) assert.equal(hashFor(parseRoute(hash)), hash, hash);
  assert.equal(hashFor({ id: 'layers-project', params: { project: P1, agent: A_MAIN, file: F_BRIEF } }), null, 'an agent and a file at once is no route');
});

test('161 layers machine: no GET reads the page; the first paint is the first frame; the project rows link by key; one loop only', async () => {
  const page = await startLayers('#/layers');
  assert.equal(FakeES.all.length, 0, 'the store opens 50 ms after the first subscribe');
  assert.equal(page.main.querySelector('.state-panel').dataset.kind, 'stream-connecting', 'before any frame the view says it is connecting');
  await advance(100);
  const es = liveES();
  assert.deepEqual(channelsOf(es), ['machine']);
  es.open();
  es.emit('message', liveFrame('machine', 'snapshot', member('machine', machineBody([gateOf('T-1', 'g-design', 'Design approval')]))));
  await settle();
  assert.equal(page.main.querySelector('.state-panel'), null, 'the first frame replaces the connecting state');
  assert.equal(text(heading(page)), 'Layers');
  const cards = page.main.querySelectorAll('.gate-card');
  assert.equal(cards.length, 1);
  assert.match(text(cards[0]), /Design approval/);
  assert.match(text(cards[0]), /Waiting for you/);
  assert.equal(cards[0].querySelector('.gate-card__link').getAttribute('href'), '#/run/feat-a/T-1', 'the run of the current project opens to decide');
  const rows = page.main.querySelectorAll('.lrow');
  assert.deepEqual(rows.map((r: El) => text(r.querySelector('.lrow__link'))), ['example-project', 'other-project']);
  assert.deepEqual(rows.map((r: El) => r.querySelector('.lrow__link').getAttribute('href')), [`#/layers/${P1}`, `#/layers/${P2}`]);
  assert.match(text(rows[1]), /Not summarized|0 open runs|no record time/);
  assert.equal(loops(page), 1, 'the one loop of the view is the first awaiting gate glyph');
  assert.equal(page.main.querySelectorAll('.gate-card__glyph').filter((g: El) => g.dataset.loop === 'on').length, 1);
  await advance(61_000);
  noReads(page);
  assert.equal(apiCalls(page, '/api/live').length, 0, 'no probe while the stream holds');
  assert.equal(FakeES.all.length, 1, 'one stream');
  assert.equal(page.slot.querySelectorAll('.banner').length, 0, 'an open stream is never stale');
});

test('162 review 3: a Layers gate card that cannot open its run says where deciding works, not that the Console only reads', async () => {
  const page = await startLayers('#/layers');
  await openedLayers(page, [{ ...gateOf('T-9', 'g-flat', 'Flat gate'), slug: null }]);
  const card = page.main.querySelector('.gate-card');
  assert.equal(text(card.querySelector('.gate-card__note')),
    'Decide in a terminal in that project. Deciding from this page needs the Console on this machine or a paired control device.');
});

test('162 layers machine: a gate card has Approve and Reject when the page may act, and the request names the card\u2019s project, run, gate and revision', async () => {
  await withActions(async () => {
    const base = (target: string, init: any) => {
      if (target === '/api/actions' && (init.method ?? 'GET') === 'GET') return actionsReply(true, null, { kind: 'local', transport: 'loopback' }, null);
      if (target === '/api/actions/decide-gate') return reply(200, { v: 1, action: 'decide-gate', requestId: 'x', outcome: 'applied', replayed: false, by: 'console', result: { taskId: 'T-1', featureSlug: 'feat-a', state: 'RUNNING', revision: 5, awaitingGate: null, current: null } });
      return standard(target, init);
    };
    const page = await startLayers('#/layers', FakeES, base);
    await openedLayers(page, [{ ...gateOf('T-1', 'g-design', 'Design approval'), revision: 4 }, gateOf('T-2', 'g-old', 'Older core')]);
    await settle();
    const cards = page.main.querySelectorAll('.gate-card');
    assert.equal(cards.length, 2);
    assert.deepEqual(cards[0].querySelectorAll('.btn--act').map(text), ['Approve', 'Reject']);
    assert.equal(cards[0].querySelectorAll('.gate-card__note').length, 0, 'the terminal note goes when the buttons are there');
    assert.equal(cards[1].querySelectorAll('.btn--act').length, 0, 'a gate row with no revision (an older core) has nothing to send as the precondition');
    assert.ok(cards[1].querySelector('.gate-card__link'), 'it keeps the link to the run, where the command is');
    cards[0].querySelectorAll('.btn--act')[1].fire('click');
    const dialog = page.doc.body.querySelector('.confirm');
    assert.equal(text(dialog.querySelector('.confirm__effect')), `Reject Design approval (g-design) of run feat-a/T-1 in example-project. The run ends as rejected. This cannot be undone.`);
    dialog.querySelector('.confirm__verb').fire('click');
    await settle();
    const posts = page.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual({ ...posts[0].body, requestId: undefined }, { v: 1, projectKey: P1, slug: 'feat-a', taskId: 'T-1', gateId: 'g-design', decision: 'reject', note: null, expect: { revision: 4 }, requestId: undefined });
  });
});

test('162 layers machine: a view-scope device sees the cards as before, with the one reason line and no button', async () => {
  await withActions(async () => {
    const base = (target: string, init: any) => (target === '/api/actions' ? actionsReply(false, 'phone-scope', { kind: 'device', deviceId: 'd-0a1b2c3d4e5f', scope: 'view', transport: 'browser' }, null) : standard(target, init));
    const page = await startLayers('#/layers', FakeES, base);
    await openedLayers(page, [{ ...gateOf('T-1', 'g-design', 'Design approval'), revision: 4 }]);
    await settle();
    const card = page.main.querySelector('.gate-card');
    assert.equal(card.querySelectorAll('.btn--act').length, 0);
    assert.deepEqual(card.querySelectorAll('.acts__reason').map(text), ['Actions need a control device paired from the Android app.']);
    assert.equal(card.querySelector('.gate-card__link').getAttribute('href'), '#/run/feat-a/T-1');
  });
});

test('161 layers machine: a patch adding an awaiting gate adds its card, marks it fresh and announces it; a recorded gate keeps its card', async () => {
  const page = await startLayers('#/layers');
  const es = await openedLayers(page, [gateOf('T-1', 'g-a', 'Old gate')]);
  assert.equal(page.main.querySelectorAll('.gate-card').length, 1);
  assert.equal(page.main.querySelector('.gate-card').dataset.fresh, undefined, 'the first paint marks nothing as new');
  const next = machineBody([gateOf('T-2', 'g-b', 'New gate', 1), gateOf('T-1', 'g-a', 'Old gate')]);
  es.emit('message', liveFrame('machine', 'patch', { set: { '/machine/body/sections/activity': next.sections.activity }, unset: [] }));
  await settle();
  const cards = page.main.querySelectorAll('.gate-card');
  assert.deepEqual(cards.map((c: El) => text(c.querySelector('.gate-card__name'))), ['New gate', 'Old gate'], 'the newest gate leads');
  assert.equal(cards[0].dataset.fresh, 'true');
  assert.equal(cards[1].dataset.fresh, undefined);
  assert.match(text(page.region), /A gate is waiting for you: New gate in example-project/);
  assert.equal(loops(page), 1);
  assert.equal(page.main.querySelectorAll('.layers-sections').length, 1, 'patched, never re-mounted');
  noReads(page);
});

test('161 layers machine: a section that failed says unreadable with its code; no project says so with the next step', async () => {
  const page = await startLayers('#/layers');
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('machine', 'snapshot', member('machine', machineBody([], { activity: lbad('core-contract-mismatch') }))));
  await settle();
  const note = page.main.querySelector('.layers-unreadable');
  assert.match(text(note), /unreadable/);
  assert.match(text(note), /Nothing is claimed/);
  assert.equal(page.main.querySelectorAll('.lrow').length, 2, 'the project list still draws from its own section');
  es.emit('message', liveFrame('machine', 'snapshot', member('machine', machineBody([], { projects: lok({ v: 1, store: 'present', excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, truncated: false, projects: [] }) }))));
  await settle();
  assert.match(text(page.main), /No DoFlow project on this machine yet/);
});

test('161 layers project: the page reads layers:<pk> and machine; checkouts hold their agents, an opencode source reads not observed with its reason, never idle', async () => {
  const page = await startLayers(`#/layers/${P1}`);
  await advance(100);
  const es = liveES();
  assert.deepEqual(channelsOf(es), [`layers:${P1}`, 'machine'].sort());
  es.open();
  es.emit('message', liveFrame(`layers:${P1}`, 'snapshot', member('layers', layersBody({ gates: lok([{ runKey: `${WK_MAIN}/run-1/main`, slug: 'feat-a', taskId: 'T-1', gateId: 'g-design', name: 'Design approval', state: 'awaiting', at: AT(5), by: null }]) }))));
  es.emit('message', liveFrame('machine', 'snapshot', member('machine', machineBody())));
  await settle();
  assert.equal(page.doc.title, 'example-project · Layers · DoFlow Console');
  assert.equal(text(page.main.querySelector('.layers-title__label')), 'example-project');
  const lane = page.main.querySelector('.lane');
  assert.equal(lane.dataset.main, 'true');
  const agents = page.main.querySelectorAll('.lrow--agent');
  assert.equal(agents.length, 3);
  assert.deepEqual(agents.map((a: El) => a.querySelector('.lrow__link').getAttribute('href')), [A_MAIN, A_SUB, A_OC].map((k) => `#/layers/${P1}/agent/${k}`));
  assert.match(text(agents[2]), /transcript not observed: no reader/);
  assert.equal(page.main.querySelectorAll('.lrow--file').length, 1);
  assert.equal(page.main.querySelectorAll('.gate-card').length, 1, 'an awaiting gate leads the page');
  const table = page.main.querySelector('.layers-coverage');
  const opencode = table.querySelectorAll('tr').find((tr: El) => /opencode/.test(text(tr)));
  assert.match(text(opencode), /not observed/);
  assert.match(text(opencode), /no audit hook/);
  assert.doesNotMatch(text(opencode), /\bidle\b/i);
  const claude = table.querySelectorAll('tr').find((tr: El) => /claude/.test(text(tr)));
  assert.match(text(claude!.querySelectorAll('td')[4]), /not observed/, 'questions is not observed for every harness');
  assert.equal(loops(page), 1);
  noReads(page);
  assert.equal(apiCalls(page, '/api/info').length, 1, 'the boot read only');
});

test('161 layers project: a patch of the layers member reaches the page; the copy of the whole page never says an agent is working', async () => {
  const page = await startLayers(`#/layers/${P1}`);
  const es = await openedLayers(page);
  assert.equal(page.main.querySelectorAll('.gate-card').length, 0);
  assert.match(text(page.main), /Nothing is waiting for you in this project/);
  es.emit('message', liveFrame(`layers:${P1}`, 'patch', { set: { '/layers/body/sections/gates': lok([{ runKey: null, slug: 'feat-a', taskId: 'T-4', gateId: 'g-x', name: null, state: 'awaiting', at: AT(1), by: null }]) }, unset: [] }));
  await settle();
  const cards = page.main.querySelectorAll('.gate-card');
  assert.equal(cards.length, 1, 'the awaiting gate moved to the lead card');
  assert.equal(cards[0].dataset.fresh, 'true');
  assert.equal(loops(page), 1);
  const words = text(page.main).replace(/[0-9a-f]{16}/g, '');
  assert.doesNotMatch(words, BAD_WORDS);
  assert.doesNotMatch(text(page.region), BAD_WORDS);
});

test('161 layers states: connecting, then following; a stream that went down keeps its records and says so, with no polling; the next frame follows again', async () => {
  const page = await startLayers('#/layers');
  const es = await openedLayers(page, [gateOf('T-1', 'g-a', 'Gate')]);
  assert.equal(page.main.querySelector('.layers').dataset.stream, 'following');
  assert.equal(page.main.querySelector('.layers-banner'), null, 'following is the quiet default');
  es.fail(2);
  await settle();
  assert.equal(page.main.querySelector('.layers').dataset.stream, 'down');
  assert.match(text(page.main.querySelector('.layers-banner')), /stream down/i);
  assert.equal(page.main.querySelectorAll('.gate-card').length, 1, 'the records it holds stay on the page');
  assert.equal(page.main.querySelectorAll('.lrow').length, 2);
  assert.deepEqual(pillOf(page).slice(0, 1).concat(pillOf(page)[2]), ['stale', 'Down'], 'the pill is the stale shape and says Down, not Live');
  assert.match(pillOf(page)[1], /^Stream down/);
  const calls = page.calls.length;
  await advance(20_000);
  assert.equal(apiCalls(page, '/api/machine').length, 0);
  assert.deepEqual(page.calls.slice(calls).filter((c) => !c.url.startsWith('/api/live')).map((c) => c.url), [], 'no GET and no poll while down');
  await advance(6000);
  const again = liveES();
  assert.notEqual(again, es, 'the store reopens');
  again.open();
  again.emit('message', liveFrame('machine', 'snapshot', member('machine', machineBody([gateOf('T-1', 'g-a', 'Gate')]))));
  await settle();
  assert.equal(page.main.querySelector('.layers').dataset.stream, 'following');
  assert.equal(page.main.querySelector('.layers-banner'), null);
});

test('161 layers states: a refused stream (401) keeps the records, says refused and does not poll', async () => {
  const refused = await (async () => {
    FakeES.all = [];
    liveSeq = 0;
    return start({ hash: '#/layers', fetch: (target: string, init: any) => (target.startsWith('/api/live') ? errorReply(401, 'unauthorized') : standard(target, init)), eventSource: FakeES }, freshWeb());
  })();
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('machine', 'snapshot', member('machine', machineBody())));
  await settle();
  es.fail(2);
  await settle();
  assert.equal(refused.main.querySelector('.layers').dataset.stream, 'refused');
  assert.match(text(refused.main.querySelector('.layers-banner')), /refused|no longer|not allowed/i);
  assert.equal(refused.main.querySelectorAll('.lrow').length, 2, 'the records it holds stay');
  await advance(60_000);
  noReads(refused);
});

test('161 layers states: a browser without EventSource says unsupported and reads nothing', async () => {
  const noES = await startLayers('#/layers', 'absent');
  await advance(100);
  assert.equal(FakeES.all.length, 0);
  assert.equal(noES.main.querySelector('.layers').dataset.stream, 'unsupported');
  assert.equal(noES.main.querySelector('.state-panel').dataset.kind, 'stream-unsupported');
  assert.match(text(noES.main.querySelector('.state-panel')), /no polling fallback/i);
  await advance(60_000);
  noReads(noES);
  assert.equal(noES.calls.filter((c) => !c.url.startsWith('/api/info') && !c.url.startsWith('/api/session')).length, 0, 'nothing else is read');
});

test('161 layers states: an error frame core-lacks-channel names the old core; the code is shown, nothing is polled', async () => {
  const page = await startLayers('#/layers');
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('machine', 'error', { code: 'core-lacks-channel' }));
  await settle();
  assert.equal(page.main.querySelector('.layers').dataset.stream, 'core-lacks-channel');
  const panel = page.main.querySelector('.state-panel');
  assert.equal(panel.dataset.kind, 'stream-core-lacks-channel');
  assert.match(text(panel), /core-lacks-channel/);
  assert.match(text(panel), /older|too old|does not have|lacks/i);
  await advance(60_000);
  noReads(page);
});

test('161 layers inspector: an agent route opens its transcript lane over the stream; events arrive as frames and append; closing goes back to the project route', async () => {
  const page = await startLayers(`#/layers/${P1}/agent/${A_SUB}`);
  const es = await openedLayers(page);
  assert.equal(inspectorOpen(page), true);
  assert.equal(text(page.inspector.querySelector('.inspector__title')), 'Agent transcript');
  assert.equal(page.main.querySelector('.fpanel'), null, 'the transcript is not mounted inline');
  assert.equal(text(page.inspector.querySelector('.fpanel__title')), 'system-architect');
  await advance(100);
  const lane = `transcript:${P1}:${A_SUB}`;
  const channels = channelsOf(liveES());
  assert.ok(channels.includes(lane), `the lane is in the union: ${channels}`);
  const ev = (seq: number, text: string) => ({ seq, at: AT(2), kind: 'reply', agentKey: A_SUB, model: null, tool: null, text, args: null, cut: false, tokens: null, record: null });
  const body = (events: any[], extra: any = {}) => ({ v: 1, agentKey: A_SUB, harness: 'claude', reader: { id: 'claude-jsonl', status: 'supported' }, transcript: { linked: true, reason: null }, events, cursor: '1:1:1:1', eof: true, masked: 0, warnings: [], ...extra });
  const open = liveES();
  open.open();
  open.emit('message', liveFrame(lane, 'snapshot', body([ev(1, 'first reply'), ev(2, 'second reply')])));
  await settle();
  assert.equal(page.inspector.querySelectorAll('.ev').length, 2);
  open.emit('message', liveFrame(lane, 'append', { events: [ev(3, 'third reply')], cursor: '2:2:2:2', eof: true, masked: 1, warnings: [] }));
  await settle();
  assert.equal(page.inspector.querySelectorAll('.ev').length, 3, 'an append adds its events');
  assert.match(text(page.inspector), /masked/i);
  noReads(page);
  closeInspector(page);
  assert.equal(page.location.hash, `#/layers/${P1}`, 'closing goes back to the project');
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(inspectorOpen(page), false);
  assert.equal(page.inspector.querySelector('.fpanel'), null);
  await advance(100);
  assert.equal(channelsOf(liveES()).includes(lane), false, 'the lane left the union');
  void es;
});

test('161 layers inspector: a second agent keeps the inspector open and retargets the lane; a file route follows its file lane; an unknown agent says so', async () => {
  const page = await startLayers(`#/layers/${P1}`);
  await openedLayers(page);
  assert.equal(inspectorOpen(page), false);
  page.location.hash = `#/layers/${P1}/agent/${A_SUB}`;
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(inspectorOpen(page), true);
  const panel = page.inspector.querySelector('.fpanel');
  page.location.hash = `#/layers/${P1}/agent/${A_MAIN}`;
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(inspectorOpen(page), true, 'the second selection keeps it open');
  assert.equal(page.inspector.querySelector('.fpanel'), panel, 'the same panel, retargeted');
  await advance(100);
  const channels = channelsOf(liveES());
  assert.ok(channels.includes(`transcript:${P1}:${A_MAIN}`) && !channels.includes(`transcript:${P1}:${A_SUB}`), `the lane follows the new agent: ${channels}`);
  const selected = page.main.querySelectorAll('.lrow--agent').filter((r: El) => r.dataset.selected === 'true');
  assert.deepEqual(selected.map((r: El) => r.dataset.key), [A_MAIN]);
  page.location.hash = `#/layers/${P1}/file/${F_BRIEF}`;
  page.win.dispatch('hashchange');
  await settle();
  await advance(100);
  const fileLane = `file:${P1}:${F_BRIEF}`;
  assert.ok(channelsOf(liveES()).includes(fileLane), 'the file lane is followed');
  const file = liveES();
  file.open();
  file.emit('message', { v: 1, ch: fileLane, id: '4242:20:1:1', type: 'snapshot', at: new Date(Date.now()).toISOString(), data: { log: 'open', ino: '4242', from: 0, to: 20, pieces: [{ at: 0, text: '# Task 3 brief' }, { at: 15, text: 'goal' }], phase: null, end: null } });
  await settle();
  assert.match(text(page.inspector.querySelector('pre')), /# Task 3 brief\ngoal/);
  noReads(page);
  page.location.hash = `#/layers/${P1}/agent/${fk(0x99)}`;
  page.win.dispatch('hashchange');
  await settle();
  assert.match(text(page.inspector), /no longer in this project/);
  assert.equal(page.inspector.querySelectorAll('a').filter((a: El) => text(a) === 'Back to the project')[0].getAttribute('href'), `#/layers/${P1}`);
});

test('161 layers pages: the Layers link is current on every Layers route', async () => {
  const page = await startLayers(`#/layers/${P1}/agent/${A_MAIN}`);
  await openedLayers(page);
  assert.deepEqual(current(page), ['Layers']);
  page.location.hash = '#/layers';
  page.win.dispatch('hashchange');
  await settle();
  assert.deepEqual(current(page), ['Layers']);
});

test('161 layers: the old Fleet routes are not routes any more', async () => {
  const page = await startLayers('#/fleet');
  assert.match(text(page.main), /not found|Not found/i);
  noReads(page);
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
  await advance(100); // C.3: the live connector settles into polling first (the fake page has no stream support)
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
  await advance(100); // C.3: the live connector settles into polling first (the fake page has no stream support)
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

test('133 reconnect: a resume or a long absence says Reconnected even when the data is unchanged', async () => {
  await withFreshModules(async () => {
    const page = await start({ fetch: standard });
    page.pause.fire('click');
    await advance(5000);
    page.pause.fire('click');
    await advance(3000); // the announcer speaks one message per 2 s: "Updates resumed." first
    assert.equal(text(page.region), 'Reconnected. The view was refreshed in full.');
  });
});

test('133 shortcuts: when the opener was rebuilt while help was open, Esc moves focus to the main region', async () => {
  await withFreshModules(async () => {
    const page = await start({ fetch: standard });
    const opener = page.doc.createElement('button');
    page.main.append(opener);
    opener.focus();
    keydownOn(page, '?');
    opener.remove(); // polling rebuilt the view under the dialog
    keydownOn(page, 'Escape');
    assert.notEqual(page.doc.getElementById('help').getAttribute('hidden'), null);
    assert.ok(page.doc.activeElement === page.main, 'focus is on the main region'); // not assert.equal: a failing equal inspects the whole fake DOM
  });
});

test('133 shortcuts: with no main region the view heading takes the focus', async () => {
  await withFreshModules(async () => {
    const page = await start({ fetch: standard });
    const opener = page.doc.createElement('button');
    page.main.append(opener);
    opener.focus();
    keydownOn(page, '?');
    opener.remove();
    page.main.setAttribute('id', 'gone');
    const h1 = page.main.querySelector('h1');
    keydownOn(page, 'Escape');
    assert.ok(h1 !== null && page.doc.activeElement === h1, 'focus is on the view heading');
  });
});

// ---- 149 D.4: the command palette (IC-021, DEC-011, DEC-037) ----------------------------------------------

const paletteOf = (page: Page) => page.doc.getElementById('palette');
const paletteInput = (page: Page) => paletteOf(page).querySelector('input');
const paletteOptions = (page: Page) => paletteOf(page).querySelectorAll('li').map((li: El) => text(li.querySelector('.palette__label')));
const paletteType = (page: Page, query: string) => { const input = paletteInput(page); input.value = query; input.fire('input'); };

test('149 palette: Ctrl K and Cmd K open the combobox dialog (not with Alt); Escape closes it and returns focus', async () => {
  await withFreshModules(async () => {
    const page = await start({ fetch: standard });
    page.pause.focus();
    const open = keydownOn(page, 'k', { ctrlKey: true });
    assert.equal(open.defaultPrevented, true);
    const dialog = paletteOf(page);
    assert.equal(dialog.getAttribute('hidden'), null);
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(page.doc.getElementById(dialog.getAttribute('aria-labelledby')).tagName, 'h2');
    const input = paletteInput(page);
    assert.ok(page.doc.activeElement === input, 'focus moves into the input');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    const list = page.doc.getElementById(input.getAttribute('aria-controls'));
    assert.equal(list.getAttribute('role'), 'listbox');
    assert.ok(list.querySelectorAll('li').every((li: El) => li.getAttribute('role') === 'option'));
    assert.deepEqual(paletteOptions(page), ['Now', 'Sessions', 'Layers', 'Follow-ups', 'Workflows', 'Workers', 'Advice', 'Settings', 'Health', 'More', 'feat-a / r1', 'feat-a / r2', 'feat-a / r3', 'feat-a / r4', 'feat-a / r5'], 'an empty query: the screens, then the runs');
    assert.equal(input.getAttribute('aria-activedescendant'), 'palette-opt-0');
    assert.equal(page.doc.getElementById('palette-opt-0').getAttribute('aria-selected'), 'true');
    const tab = input.fire('keydown', { key: 'Tab' });
    assert.equal(tab.defaultPrevented, true, 'Tab stays inside');
    const esc = input.fire('keydown', { key: 'Escape' });
    assert.equal(esc.defaultPrevented, true);
    assert.notEqual(dialog.getAttribute('hidden'), null);
    assert.ok(page.doc.activeElement === page.pause, 'focus returns to the opener');

    keydownOn(page, 'K', { metaKey: true, shiftKey: true });
    assert.equal(dialog.getAttribute('hidden'), null, 'Cmd K opens it too');
    paletteInput(page).fire('keydown', { key: 'Escape' });
    assert.ok(page.doc.activeElement === page.pause);
    const alt = keydownOn(page, 'k', { ctrlKey: true, altKey: true });
    assert.equal(alt.defaultPrevented, false);
    assert.notEqual(dialog.getAttribute('hidden'), null, 'never with Alt');
    keydownOn(page, 'k');
    assert.notEqual(dialog.getAttribute('hidden'), null, 'a plain k is no shortcut');
  });
});

test('149 palette: ignored while typing in a field and while the help is open; the two are never open together', async () => {
  await withFreshModules(async () => {
    const page = await start({ fetch: standard });
    const field = page.doc.createElement('input');
    const typed = keydownOn(page, 'k', { ctrlKey: true, target: field });
    assert.equal(typed.defaultPrevented, false);
    assert.equal(paletteOf(page), null, 'nothing was opened');
    keydownOn(page, '?');
    keydownOn(page, 'k', { ctrlKey: true });
    assert.equal(paletteOf(page), null, 'the help list is modal');
    keydownOn(page, 'Escape');
    keydownOn(page, 'k', { metaKey: true });
    assert.equal(paletteOf(page).getAttribute('hidden'), null);
    keydownOn(page, '?', { target: page.doc.body });
    assert.notEqual(paletteOf(page).getAttribute('hidden'), null, 'opening the help closes the palette');
    assert.equal(page.doc.getElementById('help').getAttribute('hidden'), null);
  });
});

test('149 palette: part of a slug then Enter opens the Run view with focus on its heading; Up and Down move; no fetch', async () => {
  await withFreshModules(async () => {
    const page = await start({ fetch: (target, init) => (target === '/api/runs/feat-a/r2' ? runReply() : standard(target, init)) });
    const before = page.calls.length;
    keydownOn(page, 'k', { ctrlKey: true });
    paletteType(page, 'FEAT');
    // 150 C.6 (IC-020): each run's `session` target (hint Chain) follows the run targets, as the session kind does.
    const runs = ['feat-a / r1', 'feat-a / r2', 'feat-a / r3', 'feat-a / r4', 'feat-a / r5'];
    assert.deepEqual(paletteOptions(page), [...runs, ...runs], 'case-insensitive substring');
    const input = paletteInput(page);
    input.fire('keydown', { key: 'ArrowDown' });
    assert.equal(input.getAttribute('aria-activedescendant'), 'palette-opt-1');
    assert.equal(page.doc.getElementById('palette-opt-1').getAttribute('aria-selected'), 'true');
    input.fire('keydown', { key: 'ArrowUp' });
    input.fire('keydown', { key: 'ArrowUp' });
    assert.equal(input.getAttribute('aria-activedescendant'), 'palette-opt-9', 'Up from the first wraps to the last');
    paletteType(page, 'zzz');
    assert.deepEqual(paletteOptions(page), []);
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(input.getAttribute('aria-activedescendant'), null);
    paletteType(page, 'a / r2');
    assert.deepEqual(paletteOptions(page), ['feat-a / r2', 'feat-a / r2'], 'the run target, then its Chain target (150 C.6)');
    assert.equal(page.calls.length, before, 'the palette fetches nothing');
    input.fire('keydown', { key: 'Enter' });
    assert.equal(page.location.hash, '#/run/feat-a/r2');
    assert.notEqual(paletteOf(page).getAttribute('hidden'), null);
    page.win.dispatch('hashchange');
    assert.equal(text(heading(page)), 'feat-a / r2');
    assert.ok(page.doc.activeElement === heading(page), 'the route change moves focus to the view heading');
  });
});

test('149 palette: matchTargets orders screens, runs, sessions, projects, matches the hint too and lists at most 50', async () => {
  const { matchTargets, MAX_OPTIONS } = await import(url('palette.js'));
  const t = (kind: string, label: string, hint = '') => ({ kind, label, hint, hash: '#/' });
  const list = [t('project', 'Alpha project'), t('session', 'Worker', 'Session · main'), t('run', 'alpha / r1'), t('screen', 'Layers'), t('screen', 'Now')];
  assert.deepEqual(matchTargets(list, 'ALPHA').map((x: any) => x.label), ['alpha / r1', 'Alpha project']);
  assert.deepEqual(matchTargets(list, 'main').map((x: any) => x.label), ['Worker'], 'the hint matches');
  assert.deepEqual(matchTargets(list, '').map((x: any) => x.label), ['Layers', 'Now', 'alpha / r1'], 'empty: the screens, then the runs');
  const many = Array.from({ length: 60 }, (_, i) => t('run', `feat / r${i}`));
  assert.equal(MAX_OPTIONS, 50);
  assert.equal(matchTargets(many, 'feat').length, 50);
});

test('149 palette: targets are the loaded Sessions lanes and Layers projects, as hashes from hashFor', async () => {
  await withFreshModules(async () => {
    FakeES.all = [];
    liveSeq = 0;
    const both = (target: string, init: any) => (target === '/api/sessions' ? reply(200, BUSY()) : target.startsWith('/api/live') ? reply(500) : standard(target, init));
    const page = await start({ hash: '#/sessions', fetch: both, eventSource: FakeES });
    keydownOn(page, 'k', { ctrlKey: true, target: page.doc.body });
    paletteType(page, 'project');
    assert.deepEqual(paletteOptions(page), [], 'no Layers body is loaded yet: nothing is fetched for it');
    paletteType(page, 'session · feat-1');
    assert.deepEqual(paletteOptions(page), ['DoFlow run local/main', 'DoFlow run run-two/lin2', 'Hook session'], 'the lanes of one checkout, by the titles the Sessions view shows; the checkout is the hint');
    paletteType(page, 'hook session');
    assert.deepEqual(paletteOptions(page), ['Hook session', 'Hook session']);
    paletteInput(page).fire('keydown', { key: 'Enter' });
    assert.match(page.location.hash, /^#\/sessions\/hook\/[0-9a-f]{16}$/);
    assert.equal(mods.views.parseRoute(page.location.hash).id, 'sessions');
    page.location.hash = '#/layers';
    page.win.dispatch('hashchange');
    await advance(100);
    const es = liveES();
    es.open();
    es.emit('message', liveFrame('machine', 'snapshot', member('machine', machineBody())));
    await settle();
    const before = page.calls.length;
    keydownOn(page, 'k', { ctrlKey: true, target: page.doc.body });
    paletteType(page, 'layers project');
    assert.deepEqual(paletteOptions(page), ['example-project', 'other-project']);
    paletteType(page, 'session');
    assert.ok(paletteOptions(page).length > 0, 'the Sessions body loaded earlier is still a source');
    paletteType(page, 'other');
    paletteInput(page).fire('keydown', { key: 'Enter' });
    assert.equal(page.location.hash, `#/layers/${P2}`);
    assert.equal(page.calls.length, before, 'the palette fetches nothing');
  });
});

test('replay keeps its controls attached while scrubbing and starting playback', async () => {
  const page = installPage({ fetch: () => reply(204) });
  const { withReplay, releaseReplay } = await import(url('views/replay.js'));
  const data = { timeline: { events: [{ action: 'start', at: '2026-01-01T00:00:00Z' }, { action: 'complete-stage', at: '2026-01-01T00:00:01Z' }] }, tasks: null };
  const local: any = {};
  const [host] = withReplay(data, local, () => [new El('div', page.doc), Object.assign(new El('div', page.doc), { className: 'timeline' })], { place: 'before-timeline' });
  const bar = host.querySelector('.replay');
  const range = host.querySelector('[data-focus-key="replay-range"]');
  const play = host.querySelector('[data-focus-key="replay-play"]');
  // Any removal of the bar, even if immediately reinserted, loses real browser focus/pointer capture.
  const replace = host.replaceChildren.bind(host);
  host.replaceChildren = (...nodes: any[]) => { assert.fail('replay host replaced its controls'); };
  range.focus();
  range.value = '0';
  range.fire('input');
  assert.equal(bar.parent, host);
  assert.equal(page.doc.activeElement, range);
  play.focus();
  play.fire('click');
  assert.equal(bar.parent, host);
  assert.equal(page.doc.activeElement, play);
  releaseReplay(local);
  host.replaceChildren = replace;
});

// ---- feature 149 C.3: the live views (IC-018) -----------------------------------------------------------------
// Runs, Run, Tasks and Sessions read the page's one live store over a fake EventSource that emits unnamed `message` events
// (IC-002 envelopes, IC-012 members). Each case boots a private copy of the web root, so the announcer starts clean.

const LIVE_EPOCH = '0a1b2c3d';
let liveSeq = 0;
const liveFrame = (ch: string, type: string, data: any) => ({ v: 1, ch, id: `${LIVE_EPOCH}-${(liveSeq += 1)}`, type, at: new Date(Date.now()).toISOString(), data });
const nowState = (runs: any, sessions: any = sessionsBody()) => ({ state: { runs: { status: 200, body: runs }, sessions: { status: 200, body: sessions } } });
const RUN_CH = 'run:feat-a:run-1';
const liveRunBody = (revision: number) => ({ v: 1, run: { ...row('RUNNING'), revision, updatedAt: new Date(Date.now()).toISOString() }, timeline: {}, tasks: null, workflow: {} });
/** `base` for every GET; the live route (the adapter's probe after the browser gave up) answers `probe()`. */
const liveRoute = (base: (target: string, init: any) => Reply | Promise<Reply>, probe: () => Reply = () => reply(500)) =>
  (target: string, init: any) => (target.startsWith('/api/live') ? probe() : base(target, init));
async function startLive(hash: string, route: (target: string, init: any) => Reply | Promise<Reply>, eventSource: unknown = FakeES): Promise<Page> {
  FakeES.all = [];
  liveSeq = 0;
  return start({ hash, fetch: route, eventSource: eventSource === 'absent' ? undefined : eventSource }, freshWeb());
}
const liveES = () => FakeES.all.filter((e) => e.url.startsWith('/api/live') && !e.closed).at(-1)!;
const pillOf = (page: Page) => [page.conn.getAttribute('data-state'), text(page.conn.querySelector('.conn__long')), text(page.conn.querySelector('.conn__short'))];
const tileCounts = (page: Page) => page.main.querySelectorAll('.tile').map((t: El) => text(t.querySelector('.tile__count')));
const RUNS_TWO_WAIT = { v: 1, runs: [row('AWAITING_GATE', 'r1'), row('AWAITING_GATE', 'r7'), row('COMPLETED', 'r4')], unreadableCount: 0 };

test('149 live runs: the first paint is the GET, then frames update the view with no GET timer, and the pill reads Live', async () => {
  const page = await startLive('#/', liveRoute(standard));
  assert.deepEqual(tileCounts(page), ['1', '2', '2'], 'painted from the GET before any snapshot');
  assert.equal(FakeES.all.length, 0, 'the store opens 50 ms after the first subscribe');
  await advance(100);
  const es = liveES();
  assert.equal(es.url, '/api/live?ch=now%2Cmachine');
  es.open();
  es.emit('message', liveFrame('now', 'snapshot', nowState(RUNS_TWO_WAIT)));
  await settle();
  assert.deepEqual(tileCounts(page), ['2', '0', '1']);
  assert.deepEqual(pillOf(page), ['done', 'Live \u00b7 last change just now', 'Live']);
  es.emit('message', liveFrame('now', 'patch', { set: { '/runs/body/runs': [row('RUNNING', 'r2')] }, unset: [] }));
  await settle();
  assert.deepEqual(tileCounts(page), ['0', '1', '0'], 'a patch of the member reaches the view');
  await advance(61_000);
  assert.equal(apiCalls(page, '/api/runs').length, 1, 'only the first paint: no GET timer while live');
  assert.equal(apiCalls(page, '/api/info').length, 1, 'the boot read only: no heartbeat');
  assert.equal(apiCalls(page, '/api/live').length, 0, 'no probe while the stream holds');
  assert.equal(FakeES.all.length, 1, 'one stream');
  assert.deepEqual(pillOf(page), ['done', 'Live \u00b7 last change 1 min ago', 'Live'], 'the age is the time since the newest frame');
  assert.equal(page.slot.querySelectorAll('.banner').length, 0, 'an open stream is never stale');
});

test('149 live runs: a first-paint GET answer that arrives after the snapshot is ignored', async () => {
  let release: (r: Reply) => void = () => {};
  const page = await startLive('#/', liveRoute((target, init) => (target === '/api/runs' ? new Promise<Reply>((resolve) => { release = resolve; }) : standard(target, init))));
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('now', 'snapshot', nowState(RUNS_TWO_WAIT)));
  await settle();
  assert.deepEqual(tileCounts(page), ['2', '0', '1'], 'the snapshot paints');
  release(reply(200, RUNS));
  await settle();
  assert.deepEqual(tileCounts(page), ['2', '0', '1'], 'the late GET answer does not replace it');
  assert.deepEqual(pillOf(page), ['done', 'Live \u00b7 last change just now', 'Live']);
});

test('149 live runs: a closed stream (probe 500) polls every 5 s and says so; the store\'s reopen and the next snapshot return to live', async () => {
  const page = await startLive('#/', liveRoute(standard, () => reply(500)));
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('now', 'snapshot', nowState(RUNS)));
  await settle();
  es.fail(2);
  await settle();
  assert.equal(apiCalls(page, '/api/live').length, 1, 'one probe after the browser gave up');
  assert.equal(apiCalls(page, '/api/runs').length, 2, 'polling starts with a GET at once');
  assert.equal(text(page.region), 'Push unavailable; polling every 5 seconds.');
  assert.deepEqual(pillOf(page), ['unknown', 'Polling \u00b7 Updated just now', 'Polling']);
  assert.deepEqual(tileCounts(page), ['1', '2', '2'], 'the polled body renders');
  await advance(5000);
  assert.equal(apiCalls(page, '/api/runs').length, 3, 'then every 5 s');
  const again = liveES();
  assert.notEqual(again, es, 'the store reopened after 5 s');
  assert.equal(again.url, `/api/live?ch=now%2Cmachine&since=${encodeURIComponent(`${LIVE_EPOCH}/now=1`)}`, 'from the kept position');
  again.open();
  await settle();
  assert.equal(text(page.region), 'Push restored.', 'an open stream over a kept state is live again: the server sends nothing when nothing moved');
  await advance(1000);
  assert.deepEqual(pillOf(page), ['done', 'Live \u00b7 last change just now', 'Live'], 'the age is the newest fetch, a second ago');
  again.emit('message', liveFrame('now', 'patch', { set: { '/runs/body/runs': RUNS_TWO_WAIT.runs }, unset: [] }));
  await settle();
  assert.deepEqual(tileCounts(page), ['2', '0', '1']);
  const polled = apiCalls(page, '/api/runs').length;
  await advance(20_000);
  assert.equal(apiCalls(page, '/api/runs').length, polled, 'the poller stopped');
});

test('149 live run: a refused stream (429) polls every 3 s; the store reopens after 30 s and the next snapshot is live again', async () => {
  const page = await startLive('#/run/feat-a/run-1', liveRoute((target, init) => (target === '/api/runs/feat-a/run-1' ? runReply() : standard(target, init)), () => errorReply(429, 'stream-limit')));
  await advance(100);
  const es = liveES();
  assert.equal(es.url, `/api/live?ch=${encodeURIComponent(`${RUN_CH},machine`)}`);
  es.fail(2);
  await settle();
  assert.equal(text(page.region), 'Push unavailable; polling every 3 seconds.');
  assert.equal(apiCalls(page, '/api/runs/feat-a/run-1').length, 1, 'the first paint keeps its cadence: no extra GET when polling begins');
  await advance(1000);
  assert.deepEqual(pillOf(page), ['unknown', 'Polling \u00b7 Updated just now', 'Polling'], 'the shell\'s 1 s status tick names the mode');
  await advance(2000);
  assert.equal(apiCalls(page, '/api/runs/feat-a/run-1').length, 2, 'every 3 s');
  assert.equal(FakeES.all.length, 1, 'no reopen before 30 s');
  await advance(27_000);
  const again = liveES();
  assert.notEqual(again, es);
  again.open();
  again.emit('message', liveFrame(RUN_CH, 'snapshot', { state: { run: { status: 200, body: liveRunBody(7) } } }));
  await settle();
  assert.equal(text(page.region), 'Push restored.');
  assert.match(text(page.main), /revision 7/);
  assert.deepEqual(pillOf(page), ['done', 'Live \u00b7 last change just now', 'Live']);
  const polled = apiCalls(page, '/api/runs/feat-a/run-1').length;
  await advance(9000);
  assert.equal(apiCalls(page, '/api/runs/feat-a/run-1').length, polled, 'no GET timer while live');
  again.emit('message', liveFrame(RUN_CH, 'patch', { set: { '/run/body/run': { ...liveRunBody(8).run } }, unset: [] }));
  await settle();
  assert.match(text(page.main), /revision 8/, 'a patch reaches the run head');
});

test('149 live run: a member with an error status reaches the view as a failed GET does', async () => {
  const page = await startLive('#/run/feat-a/nope', liveRoute((target, init) => (target === '/api/runs/feat-a/nope' ? new Promise<Reply>(() => {}) : standard(target, init))));
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('run:feat-a:nope', 'snapshot', { state: { run: { status: 404, body: { error: { code: 'run-not-found', verb: null, exit: null } } } } }));
  await settle();
  assert.equal(text(page.main.querySelector('.state-panel__title')), 'This run is not in the record');
  await advance(100);
  assert.equal(es.closed, true, 'a final answer ends the view\'s subscription, so the store closes the stream');
  await advance(20_000);
  assert.equal(apiCalls(page, '/api/runs/feat-a/nope').length, 1, 'not retried');
});

test('149 live tasks: frames redraw the graph; an old core (503 live-unavailable) polls every 3 s and the view still renders', async () => {
  const live = await startLive('#/run/feat-a/run-1/tasks', liveRoute(graphRoute(() => null)));
  assert.match(text(live.main), /This run has no task plan/, 'the first paint');
  await advance(100);
  const es = liveES();
  assert.equal(es.url, `/api/live?ch=${encodeURIComponent(`${RUN_CH},machine`)}`);
  es.open();
  es.emit('message', liveFrame(RUN_CH, 'snapshot', { state: { run: { status: 200, body: runBodyWith(frow('run-1', 3), [ev(60, 'start', null)], GRAPH_PLAN()) } } }));
  await settle();
  assert.ok(gcardOf(live, 'B.1'), 'the snapshot draws the graph');
  assert.deepEqual(pillOf(live), ['done', 'Live \u00b7 last change just now', 'Live']);
  await advance(9000);
  assert.equal(apiCalls(live, '/api/runs/feat-a/run-1').length, 1, 'only the first paint');
  uninstallPage();
  mock.timers.reset();

  const old = await startLive('#/run/feat-a/run-1/tasks', liveRoute(graphRoute(GRAPH_PLAN), () => errorReply(503, 'live-unavailable')));
  await advance(100);
  liveES().fail(2);
  await settle();
  assert.equal(text(old.region), 'Push unavailable; polling every 3 seconds.');
  await advance(1000);
  assert.deepEqual(pillOf(old), ['unknown', 'Polling \u00b7 Updated just now', 'Polling']);
  assert.ok(gcardOf(old, 'B.1'), 'the polled body draws the same graph');
  assert.equal(old.main.querySelector('.state-panel__title'), null, 'no error page: the Console keeps working');
});

test('149 live sessions: without EventSource it polls every 10 s from the start, as before, and says so', async () => {
  const page = await startLive('#/sessions', liveRoute(sessionsRoute(() => sessionsBody())), 'absent');
  assert.equal(apiCalls(page, '/api/sessions').length, 1);
  await advance(100);
  assert.equal(FakeES.all.length, 0, 'nothing is opened');
  assert.equal(text(page.region), 'Push unavailable; polling every 10 seconds.');
  await advance(1000);
  assert.deepEqual(pillOf(page), ['unknown', 'Polling \u00b7 Updated just now', 'Polling']);
  assert.equal(apiCalls(page, '/api/sessions').length, 1);
  await advance(9000);
  assert.equal(apiCalls(page, '/api/sessions').length, 2, 'the poll cadence of before');
  assert.equal(apiCalls(page, '/api/live').length, 0, 'no probe either');
});

test('149 live sessions: a channel error polls every 10 s; the next snapshot on the same stream is live again', async () => {
  const page = await startLive('#/sessions', liveRoute(sessionsRoute(() => sessionsBody())));
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('now', 'snapshot', nowState(RUNS, BUSY())));
  await settle();
  assert.match(text(page.main), /build/, 'the member draws the slot');
  assert.deepEqual(pillOf(page), ['done', 'Live \u00b7 last change just now', 'Live']);
  await advance(6000);
  es.emit('message', liveFrame('now', 'patch', { set: { '/runs/body/unreadableCount': 3 }, unset: [] }));
  await settle();
  await advance(1000);
  assert.deepEqual(pillOf(page), ['done', 'Live \u00b7 last change 6 s ago', 'Live'], 'a patch of another member is no change of this view');
  es.emit('message', liveFrame('now', 'error', { code: 'events-down' }));
  await settle();
  assert.equal(text(page.region), 'Push unavailable; polling every 10 seconds.');
  assert.equal(apiCalls(page, '/api/sessions').length, 2, 'polling starts with a GET at once');
  assert.deepEqual(pillOf(page), ['unknown', 'Polling \u00b7 Updated just now', 'Polling']);
  await advance(10_000);
  assert.equal(apiCalls(page, '/api/sessions').length, 3);
  es.emit('message', liveFrame('now', 'snapshot', nowState(RUNS, BUSY())));
  await settle();
  assert.equal(text(page.region), 'Push restored.');
  assert.deepEqual(pillOf(page), ['done', 'Live \u00b7 last change just now', 'Live']);
  await advance(30_000);
  assert.equal(apiCalls(page, '/api/sessions').length, 3, 'the poller stopped');
});

test('149 live runs: pause closes the stream and nothing is applied; resume reopens with since and reads once', async () => {
  const page = await startLive('#/', liveRoute(standard));
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('now', 'snapshot', nowState(RUNS_TWO_WAIT)));
  es.emit('message', liveFrame('now', 'patch', { set: { '/runs/body/unreadableCount': 1 }, unset: [] }));
  await settle();
  page.pause.fire('click');
  assert.equal(page.pause.getAttribute('aria-pressed'), 'true');
  assert.equal(es.closed, true, 'the pause closes the stream');
  es.emit('message', liveFrame('now', 'patch', { set: { '/runs/body/runs': [] }, unset: [] }));
  await settle();
  assert.deepEqual(tileCounts(page), ['2', '0', '1'], 'nothing is applied while paused');
  assert.equal(pillOf(page)[2], 'Paused');
  await advance(60_000);
  assert.equal(FakeES.all.length, 1, 'nothing reopens while paused');
  assert.equal(apiCalls(page, '/api/runs').length, 1);
  page.pause.fire('click');
  const again = liveES();
  assert.notEqual(again, es);
  assert.equal(again.url, `/api/live?ch=now%2Cmachine&since=${encodeURIComponent(`${LIVE_EPOCH}/now=2`)}`);
  await settle();
  assert.equal(apiCalls(page, '/api/runs').length, 2, 'one read on resume, as a polled view refetches in full');
  await advance(2000);
  assert.equal(text(page.region), 'Reconnected. The view was refreshed in full.');
  again.open();
  await advance(30_000);
  assert.equal(apiCalls(page, '/api/runs').length, 2, 'and no GET timer after it');
  assert.deepEqual(pillOf(page)[0], 'done');
});

// ---- feature 149 C.4: the client acceptance scenarios (requirement.md :236-275) -----------------------------------------
// Views off polling, Resume without loss, Old core and Hidden tab and pause run end to end over the page, a fresh web root
// and FakeES. "Equal to a fresh GET": the live page is taken down and the Console boots again at the same mock time over the
// same scripted fetch with no EventSource, so its #main is painted from the view's GET reply of that moment; the text and the
// element tree of both #main must be equal. "Shown once": the re-mounts of `.view-body` are counted (app.js paint mounts it
// once per changed paint key), so a change applied twice, or an older state replayed over a newer one, mounts again. The
// Adapter seam case drives the view connector (VIEWS.run.connect, live-view.js) over store.js, once with a fake adapter and
// once with live.js over FakeES, and compares what reaches the view.

/** A frame at position `n` of the live epoch: a snapshot on subscribe is sent at the channel's current position (IC-013). */
const frameAt = (n: number, ch: string, type: string, data: any) => ({ v: 1, ch, id: `${LIVE_EPOCH}-${n}`, type, at: new Date(Date.now()).toISOString(), data });
const c4Patch = (n: number, ch: string, set: Record<string, any>) => frameAt(n, ch, 'patch', { set, unset: [] });
const mainView = (page: Page) => ({ text: text(page.main), tags: tags(page.main) });
const setHidden = (page: Page, hidden: boolean) => { page.doc.hidden = hidden; for (const fn of page.doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' }); };
type Route = (target: string, init: any) => Reply | Promise<Reply>;

/** Counts the re-mounts of the view body from now on. */
function bodyMounts(page: Page): { n: number } {
  const host = page.main.querySelector('.view-body');
  assert.ok(host, 'the view body is mounted');
  const count = { n: 0 };
  const replace = host.replaceChildren.bind(host);
  host.replaceChildren = (...nodes: any[]) => { count.n += 1; replace(...nodes); };
  return count;
}

/** What a fresh GET of the view shows now: the Console booted again at this mock time over `route`, without EventSource. */
async function freshGetView(hash: string, route: Route, getPath: string) {
  const at = Date.now();
  uninstallPage();
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: at });
  FakeES.all = [];
  const page = installPage({ hash, fetch: route, eventSource: undefined });
  imports += 1;
  await import(`${pathToFileURL(path.join(freshWeb(), 'app.js')).href}?run=${imports}`);
  await settle();
  assert.equal(apiCalls(page, getPath).length, 1, 'the reference is painted from one GET of the view route');
  return mainView(page);
}

/** One change on the server at `at` ms after the stream is up: `make()` changes the server's body and returns the patch's `set`. */
type Change = { at: number, make: () => Record<string, any> };

/** Views off polling (FR-017, NFR-008): the view goes live, the changes are made over 60 s of fake time, and the verb calls are counted. */
async function offPolling(hash: string, route: Route, getPath: string, channel: string, state: () => any, changes: Change[]) {
  const page = await startLive(hash, liveRoute(route));
  const booted = page.calls.length;
  assert.equal(apiCalls(page, getPath).length, 1, 'the first paint is one GET of the view route');
  await advance(100);
  const es = liveES();
  es.open();
  let n = 1;
  es.emit('message', frameAt(n, channel, 'snapshot', { state: state() }));
  await settle();
  const first = mainView(page);
  let elapsed = 0;
  for (const change of changes) {
    await advance(change.at - elapsed);
    elapsed = change.at;
    n += 1;
    es.emit('message', c4Patch(n, channel, change.make()));
    await settle();
  }
  await advance(60_000 - elapsed);
  assert.deepEqual(page.calls.slice(booted).map((c) => c.url), [], '60 s live: no GET of the view route, no heartbeat, no probe');
  assert.equal(apiCalls(page, getPath).length, 1, 'only the first-paint GET');
  assert.equal(FakeES.all.length, 1, 'one stream, never reopened');
  assert.equal(es.closed, false);
  assert.equal(pillOf(page)[0], 'done');
  assert.match(pillOf(page)[1] as string, /^Live \u00b7 last change /);
  const end = mainView(page);
  assert.notDeepEqual(end, first, 'the patches reached the view');
  assert.deepEqual(end, await freshGetView(hash, route, getPath), 'the view equals a fresh GET read at the end');
}

test('149 C.4 Views off polling: Now (Runs) live for 60 s makes only its first-paint GET and ends equal to a fresh GET', async () => {
  let runs: any = RUNS;
  await offPolling('#/', homeFetch(() => runs), '/api/runs', 'now', () => nowState(runs).state, [
    { at: 10_000, make: () => { runs = { ...runs, runs: RUNS_TWO_WAIT.runs }; return { '/runs/body/runs': runs.runs }; } },
    { at: 30_000, make: () => ({ '/sessions/body/limits/runsInspected': 3 }) }, // another member: not this view's GET
    { at: 50_000, make: () => { runs = { ...runs, unreadableCount: 1 }; return { '/runs/body/unreadableCount': 1 }; } },
  ]);
});

test('149 C.4 Views off polling: Run live for 60 s makes only its first-paint GET and ends equal to a fresh GET', async () => {
  let server: any = null;
  const current = () => (server ??= runBodyWith(frow('run-1', 2), [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' })]));
  await offPolling('#/run/feat-a/run-1', runRoute(current), '/api/runs/feat-a/run-1', RUN_CH, () => ({ run: { status: 200, body: current() } }), [
    { at: 10_000, make: () => { server = { ...server, run: frow('run-1', 3) }; return { '/run/body/run': server.run }; } },
    { at: 30_000, make: () => {
      const events = [...server.timeline.events, ev(0, 'complete-stage', 'design', { outcome: 'passed' })];
      server = { ...server, timeline: { ...server.timeline, events } };
      return { '/run/body/timeline/events': events };
    } },
    { at: 50_000, make: () => { server = { ...server, timeline: { ...server.timeline, revision: 3 } }; return { '/run/body/timeline/revision': 3 }; } },
  ]);
});

test('149 C.4 Views off polling: Tasks live for 60 s makes only its first-paint GET and ends equal to a fresh GET', async () => {
  let server: any = null;
  const current = () => (server ??= runBodyWith(frow('run-1', 3), [ev(60, 'start', null)], GRAPH_PLAN()));
  await offPolling('#/run/feat-a/run-1/tasks', runRoute(current), '/api/runs/feat-a/run-1', RUN_CH, () => ({ run: { status: 200, body: current() } }), [
    { at: 20_000, make: () => {
      const rows = server.tasks.tasks.map((t: any) => (t.id === 'A.1' ? gstate('A.1', 'SUCCEEDED', 'completed', att(1, 'worker-a', 'finished', 50, { result: 'COMPLETED', endedAt: agoIso(0) })) : t));
      server = { ...server, tasks: { ...server.tasks, tasks: rows } };
      return { '/run/body/tasks/tasks': rows };
    } },
    { at: 40_000, make: () => { server = { ...server, run: { ...server.run, revision: 2 } }; return { '/run/body/run/revision': 2 }; } },
  ]);
});

test('149 C.4 Views off polling: Sessions live for 60 s makes only its first-paint GET and ends equal to a fresh GET', async () => {
  let server: any = null;
  const current = () => (server ??= BUSY());
  await offPolling('#/sessions', sessionsRoute(current), '/api/sessions', 'now', () => nowState(RUNS, current()).state, [
    { at: 20_000, make: () => {
      const slots = sOk({ v: 1, slots: [], unreadable: 0 });
      server = { ...server, sections: { ...server.sections, slots } };
      return { '/sessions/body/sections/slots': slots };
    } },
    { at: 40_000, make: () => ({ '/runs/body/unreadableCount': 4 }) }, // another member: not this view's GET
  ]);
});

test('Run live: the now label follows the clock when the line has not moved a pixel', async () => {
  // A run that began days ago: one minute is far less than a pixel of its axis.
  const body = runBodyWith(frow('run-1', 2), [ev(6000, 'start', null), ev(5000, 'complete-stage', 'discovery', { outcome: 'passed' })]);
  const page = await startLive('#/run/feat-a/run-1', liveRoute(runRoute(() => body), () => reply(500)));
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', frameAt(1, RUN_CH, 'snapshot', { state: { run: { status: 200, body } } }));
  await settle();
  const label = () => text(page.main.querySelector('.tl__nowlabel'));
  const before = label();
  assert.match(before, /^now \d\d:\d\d$/);
  await advance(60_000);
  assert.match(label(), /^now \d\d:\d\d$/);
  assert.notEqual(label(), before, 'a minute later the label names the new minute');
});

test('149 C.4 Resume without loss: a dropped Run view reopens with since, shows each of two steps once, and equals GET /api/runs/<slug>/<task>', async () => {
  const GET = '/api/runs/feat-a/run-1';
  let server: any = null;
  const current = () => (server ??= runBodyWith(frow('run-1', 2), [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' })]));
  const route = runRoute(current);
  const page = await startLive('#/run/feat-a/run-1', liveRoute(route, () => reply(500)));
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', frameAt(1, RUN_CH, 'snapshot', { state: { run: { status: 200, body: current() } } }));
  server = { ...server, timeline: { ...server.timeline, revision: 3 } };
  es.emit('message', c4Patch(2, RUN_CH, { '/run/body/timeline/revision': 3 }));
  await settle();
  const items = () => page.main.querySelectorAll('.tl-item').map((li: El) => text(li.querySelector('.tl-item__words')));
  const before = items();
  assert.equal(before.length, 3, 'applied up to id 2: three events');
  assert.equal(pillOf(page)[2], 'Live');
  const mounts = bodyMounts(page);

  es.fail(2); // the connection drops and the browser gives up (CLOSED); the probe answers 500, so the store reopens after 5 s
  await settle();
  assert.equal(apiCalls(page, '/api/live').length, 1, 'one probe');
  assert.equal(text(page.region), 'Push unavailable; polling every 3 seconds.');
  await advance(3500); // the polls at once and at 3 s read the state before the steps
  assert.equal(apiCalls(page, GET).length, 3);
  // The run takes two steps; the hub's patches for them go to the dropped source.
  const step = (cursor: number, node: string) => {
    server = { ...server, run: frow('run-1', cursor), timeline: { ...server.timeline, events: [...server.timeline.events, ev(0, 'complete-stage', node, { outcome: 'passed' })] } };
    return { '/run/body/run': server.run, '/run/body/timeline/events': server.timeline.events };
  };
  const step1 = c4Patch(3, RUN_CH, step(3, 'design'));
  const step2 = c4Patch(4, RUN_CH, step(4, 'planning'));
  es.emit('message', step1);
  es.emit('message', step2);
  await settle();
  assert.deepEqual(items(), before, 'nothing of the dropped source is applied');
  assert.equal(mounts.n, 0);

  await advance(1500); // 5 s after the drop
  const again = liveES();
  assert.notEqual(again, es, 'the store reopened');
  assert.equal(again.url, `/api/live?ch=${encodeURIComponent(`${RUN_CH},machine`)}&since=${encodeURIComponent(`${LIVE_EPOCH}/${RUN_CH}=2`)}`, 'since names the last applied id');
  again.open();
  // The position differs: one snapshot at the current position, then the two step patches replayed (as a resend would).
  again.emit('message', frameAt(4, RUN_CH, 'snapshot', { state: { run: { status: 200, body: server } } }));
  again.emit('message', step1);
  again.emit('message', step2);
  await settle();
  assert.equal(mounts.n, 1, 'the two steps arrive in one paint; the replayed patches change nothing');
  const after = items();
  assert.equal(after.length, 5);
  assert.deepEqual(after.slice(2), before, 'the earlier events stay');
  for (const [i, li] of page.main.querySelectorAll('.tl-item').entries()) {
    assert.equal(li.getAttribute('data-changed'), i < 2 ? 'true' : null, `item ${i}: only the two steps are new`);
  }
  for (const word of after.slice(0, 2)) assert.equal(after.filter((w) => w === word).length, 1, `${word}: shown once`);
  assert.notEqual(after[0], after[1]);
  assert.equal(text(page.region), 'Push restored.');
  await advance(9000);
  assert.equal(apiCalls(page, GET).length, 3, 'no GET timer after the resume');
  assert.equal(mounts.n, 1);
  assert.deepEqual(mainView(page), await freshGetView('#/run/feat-a/run-1', route, GET), 'the view equals a fresh GET body');
});

test('149 C.4 Old core: /api/live answers 503 live-unavailable, so Now loads and updates by polling every 5 s and the pill reads Polling', async () => {
  let runs: any = RUNS;
  const page = await startLive('#/', liveRoute(homeFetch(() => runs), () => errorReply(503, 'live-unavailable')));
  assert.deepEqual(tileCounts(page), ['1', '2', '2'], 'Now loads from its GET');
  await advance(100);
  const es = liveES();
  assert.equal(es.url, '/api/live?ch=now%2Cmachine');
  es.fail(2); // the stream's reply is the 503: the browser gives up at once
  await settle();
  assert.equal(apiCalls(page, '/api/live').length, 1, 'one probe names the old core');
  assert.equal(text(page.region), 'Push unavailable; polling every 5 seconds.');
  await advance(900);
  assert.deepEqual(pillOf(page), ['unknown', 'Polling \u00b7 Updated just now', 'Polling']);
  runs = RUNS_TWO_WAIT;
  await advance(4000); // 5 s after the first paint
  assert.equal(apiCalls(page, '/api/runs').length, 2);
  assert.deepEqual(tileCounts(page), ['2', '0', '1'], 'and updates by polling');
  assert.deepEqual(pillOf(page), ['unknown', 'Polling \u00b7 Updated just now', 'Polling']);
  await advance(25_100); // 30 s after `unsupported` the store tries the stream again
  const again = liveES();
  assert.notEqual(again, es);
  again.fail(2);
  await settle();
  assert.equal(apiCalls(page, '/api/live').length, 2);
  await advance(4900);
  assert.equal(apiCalls(page, '/api/runs').length, 8, 'one read every 5 s throughout: 0, 5, ..., 35 s');
  assert.equal(FakeES.all.length, 2);
  assert.deepEqual(pillOf(page), ['unknown', 'Polling \u00b7 Updated just now', 'Polling']);
});

const AFTER_TWO = { ...RUNS, runs: [row('COMPLETED', 'r1'), row('AWAITING_GATE', 'r2'), row('RUNNING', 'r3'), row('COMPLETED', 'r4'), row('REJECTED', 'r5')] };
const titlesOf = (page: Page) => [...rowsOf(page).map(linkText), ...cardsOf(page).map(cardId)];

/** Hidden tab and pause (FR-019): Now is live, the person goes away for 60 s while two runs change, then comes back. */
async function awayWhileTwoRunsChange(how: 'hidden' | 'paused') {
  let runs: any = RUNS;
  const route = homeFetch(() => runs);
  const page = await startLive('#/', liveRoute(route));
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', frameAt(1, 'now', 'snapshot', nowState(RUNS)));
  await settle();
  assert.deepEqual(tileCounts(page), ['1', '2', '2']);
  const before = mainView(page);
  const mounts = bodyMounts(page);
  const calls = page.calls.length;
  if (how === 'hidden') setHidden(page, true);
  else page.pause.fire('click');
  assert.equal(es.closed, true, 'the stream is closed while away');
  if (how === 'paused') assert.equal(pillOf(page)[2], 'Paused');
  await advance(20_000);
  runs = { ...RUNS, runs: [AFTER_TWO.runs[0], ...RUNS.runs.slice(1)] };
  es.emit('message', c4Patch(2, 'now', { '/runs/body/runs': runs.runs }));
  await advance(20_000);
  runs = AFTER_TWO;
  es.emit('message', c4Patch(3, 'now', { '/runs/body/runs': runs.runs }));
  await advance(20_000);
  assert.deepEqual(mainView(page), before, 'nothing changes in the view while away');
  assert.equal(mounts.n, 0);
  assert.deepEqual(page.calls.slice(calls).map((c) => c.url), [], 'no GET and no probe while away');
  assert.equal(FakeES.all.length, 1, 'nothing reopens while away');
  if (how === 'hidden') setHidden(page, false);
  else page.pause.fire('click');
  const again = liveES();
  assert.notEqual(again, es);
  assert.equal(again.url, `/api/live?ch=now%2Cmachine&since=${encodeURIComponent(`${LIVE_EPOCH}/now=1`)}`, 'the reopen names the last applied position');
  await settle();
  assert.equal(apiCalls(page, '/api/runs').length, 2, 'one GET on return');
  again.open();
  again.emit('message', frameAt(3, 'now', 'snapshot', nowState(runs))); // the position moved: one snapshot at the current one
  await settle();
  await advance(2000);
  assert.deepEqual(tileCounts(page), ['1', '1', '3'], 'both changes show');
  assert.equal(mounts.n, 1, 'the GET on return and the snapshot show them in one paint');
  for (const title of ['feat-a / r1', 'feat-a / r2']) assert.equal(titlesOf(page).filter((t) => t === title).length, 1, `${title}: shown once`);
  assert.deepEqual(cardsOf(page).map(cardId), ['feat-a / r2'], 'r2 now waits');
  assert.equal(text(page.region), 'Reconnected. The view was refreshed in full.');
  assert.equal(pillOf(page)[2], 'Live');
  await advance(30_000);
  assert.equal(apiCalls(page, '/api/runs').length, 2, 'no GET timer after the return');
  assert.equal(mounts.n, 1);
  assert.deepEqual(mainView(page), await freshGetView('#/', route, '/api/runs'), 'the view equals a fresh GET');
}

test('149 C.4 Hidden tab and pause: a tab hidden for 60 s closes the stream, applies nothing, and on return shows both changes once', async () => {
  await awayWhileTwoRunsChange('hidden');
});

test('149 C.4 Hidden tab and pause: a 60 s pause closes the stream, applies nothing, and on resume shows both changes once', async () => {
  await awayWhileTwoRunsChange('paused');
});

test('149 C.4 Adapter seam: a fake adapter (open, close, onFrame, onState) drives the Run view connector as live.js over EventSource does', async () => {
  epoch += 10_000_000;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: epoch });
  installPage({ fetch: standard }); // poll.js and notices.js read the page's document
  const root = freshWeb();
  const load = (name: string) => import(pathToFileURL(path.join(root, name)).href);
  const views = await load('views.js');
  const storeMod = await load('store.js');
  const liveMod = await load('live.js');
  const visible = { hidden: () => false, subscribe: () => () => {} };
  const missing = { error: { code: 'run-not-found', verb: null, exit: null } };
  const body7 = liveRunBody(7);
  const frames = [
    frameAt(1, RUN_CH, 'snapshot', { state: { run: { status: 200, body: body7 } } }),
    frameAt(1, 'now', 'snapshot', nowState(RUNS)), // a channel the view does not follow
    c4Patch(2, RUN_CH, { '/run/body/run/revision': 8 }),
    c4Patch(2, RUN_CH, { '/run/body/run/revision': 99 }), // not after the applied position: dropped
    c4Patch(3, RUN_CH, { '/run': { status: 404, body: missing } }),
  ];

  async function drive(viaEventSource: boolean) {
    const seen: any[] = [];
    const opened: any[] = [];
    let frame: (envelope: any) => void = () => {};
    let state: (event: any) => void = () => {};
    const adapter = viaEventSource
      ? liveMod.createLiveAdapter({ EventSource: FakeES, probe: async () => ({ status: 500, code: null }) })
      : {
        open: (channels: string[], since: string | null) => { opened.push({ channels, since }); },
        close: () => { opened.push('close'); },
        onFrame: (listener: (envelope: any) => void) => { frame = listener; },
        onState: (listener: (event: any) => void) => { state = listener; },
      };
    FakeES.all = [];
    const store = storeMod.createLiveStore({ adapter, visibility: visible });
    const view = views.VIEWS.run.connect({}, { slug: 'feat-a', taskId: 'run-1' }, {
      fetchJson: async () => { throw new Error('the run view does not wrap its member'); },
      onData: (data: any) => { seen.push(['data', data]); },
      onFailure: (error: any) => { seen.push(['failure', error]); },
      store: () => store,
      fetchOnce: () => new Promise(() => {}), // the first-paint GET never answers: only the live path reaches the view
    });
    view.start();
    await advance(100);
    if (viaEventSource) {
      assert.equal(FakeES.all.length, 1);
      const es = FakeES.all[0];
      opened.push({ url: es.url });
      es.open();
      for (const envelope of frames) es.emit('message', envelope);
    } else {
      state({ state: 'connecting', code: null, at: Date.now() });
      state({ state: 'open', code: null, at: Date.now() });
      for (const envelope of frames) frame(structuredClone(envelope));
    }
    await settle();
    seen.push(['mode', view.mode]);
    const result = { seen, opened: [...opened] };
    view.stop();
    return result;
  }

  const fake = await drive(false);
  const sse = await drive(true);
  assert.deepEqual(fake.opened, [{ channels: [RUN_CH], since: null }], 'the store opens the fake adapter on the view channel');
  assert.deepEqual(sse.opened, [{ url: `/api/live?ch=${encodeURIComponent(RUN_CH)}` }]);
  assert.deepEqual(fake.seen, [
    ['data', body7],
    ['data', { ...body7, run: { ...body7.run, revision: 8 } }],
    ['failure', { status: 404, code: 'run-not-found', network: false }],
    ['mode', 'live'],
  ]);
  assert.deepEqual(sse.seen, fake.seen, 'the view gets exactly the updates it gets over SSE');
  for (const name of ['store.js', 'live-view.js', 'views.js', 'app.js']) {
    assert.ok(!fs.readFileSync(path.join(WEB_ROOT, name), 'utf8').includes('EventSource'), `${name} does not reference EventSource`);
  }
});

// ---- 149 D.2: the inspector hosts the Run rail detail, the Tasks panel, the Sessions lane panel and the Layers transcript ----

const inspectorOpen = (page: Page) => page.shell.dataset.panel === 'open';
const closeInspector = (page: Page) => page.inspector.querySelector('.inspector__close').fire('click');

test('D.2 Run rail: a second node keeps the inspector open on the new node; the inspector close closes it and the focus goes back to the node', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(frow('run-1', 2), WF_FEATURE, [ev(30, 'start', null)])) });
  const buttons = () => page.main.querySelectorAll('.rail__node');
  assert.equal(inspectorOpen(page), false);
  buttons()[3].fire('click');
  assert.equal(inspectorOpen(page), true);
  assert.equal(text(page.inspector.querySelector('.inspector__title')), 'Step details');
  assert.equal(page.inspector.getAttribute('aria-labelledby'), 'inspector-title rail-detail-title', 'named by the title and the node heading');
  assert.equal(text(page.inspector.querySelector('#rail-detail-title')), 'planning');
  assert.equal(page.main.querySelector('.rail-detail'), null, 'the detail is not mounted inline');
  buttons()[4].fire('click');
  assert.equal(inspectorOpen(page), true, 'the second selection keeps it open');
  assert.equal(page.inspector.querySelectorAll('.rail-detail').length, 1);
  assert.equal(text(page.inspector.querySelector('.rail-detail__title')), 'gate-a');
  assert.equal(buttons()[3].getAttribute('aria-expanded'), 'false');
  assert.equal(buttons()[4].getAttribute('aria-expanded'), 'true');
  closeInspector(page);
  assert.equal(inspectorOpen(page), false);
  assert.equal(page.inspector.querySelector('.rail-detail'), null);
  assert.equal(page.inspector.getAttribute('aria-labelledby'), null, 'closed, the name is dropped');
  assert.equal(buttons()[4].getAttribute('aria-expanded'), 'false');
  assert.ok(page.doc.activeElement === buttons()[4], 'the focus is on the node that was open');
  buttons()[4].fire('click');
  assert.equal(inspectorOpen(page), true, 'it opens again');
});

test('D.2 Tasks: a second task keeps the inspector open on the new task; the inspector close closes it and the focus goes back to the card', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(GRAPH_PLAN) });
  gcardOf(page, 'A.1').fire('click');
  assert.equal(inspectorOpen(page), true);
  assert.equal(text(page.inspector.querySelector('.inspector__title')), 'Task details');
  assert.equal(page.inspector.getAttribute('aria-labelledby'), 'inspector-title graph-panel-title', 'named by the title and the task heading');
  assert.equal(text(page.inspector.querySelector('#graph-panel-title')), 'A.1');
  assert.equal(page.main.querySelector('.graph__panel'), null, 'the panel is not mounted inline');
  gcardOf(page, 'B.1').fire('click');
  assert.equal(inspectorOpen(page), true, 'the second selection keeps it open');
  assert.equal(text(page.inspector.querySelector('.graph__paneltitle')), 'B.1');
  assert.equal(gcardOf(page, 'A.1').getAttribute('aria-expanded'), 'false');
  assert.equal(gcardOf(page, 'B.1').getAttribute('aria-expanded'), 'true');
  closeInspector(page);
  assert.equal(inspectorOpen(page), false);
  assert.equal(gcardOf(page, 'B.1').getAttribute('aria-expanded'), 'false');
  assert.equal(page.main.querySelector('.graph').getAttribute('data-open'), 'false');
  assert.ok(page.doc.activeElement === gcardOf(page, 'B.1'), 'the focus is on the card');
  // A row of the lane list opens the same panel in the inspector.
  growOf(page, 'A.2').fire('click');
  assert.equal(text(page.inspector.querySelector('.graph__paneltitle')), 'A.2');
  growOf(page, 'A.2').fire('click');
  assert.equal(inspectorOpen(page), false, 'the same row again closes it');
});

test('D.2 Sessions: a second lane keeps the inspector open on the new lane; the inspector close closes it and the focus goes back to the lane', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/sessions', fetch: sessionsRoute(BUSY) });
  const keys: string[] = page.main.querySelectorAll('.slane').map((l: El) => String(l.getAttribute('data-lane-key')));
  const [a, b] = keys;
  assert.ok(a && b && a !== b, 'two lanes');
  slaneOf(page, a).fire('click');
  assert.equal(inspectorOpen(page), true);
  assert.equal(text(page.inspector.querySelector('.inspector__title')), 'Lane details');
  assert.equal(page.inspector.getAttribute('aria-labelledby'), 'inspector-title sessions-panel-title', 'named by the title and the lane heading');
  assert.equal(text(page.inspector.querySelector('#sessions-panel-title')), text(page.inspector.querySelector('.spanel__title')));
  assert.equal(page.main.querySelector('.spanel'), null, 'the panel is not mounted inline');
  const firstTitle = text(page.inspector.querySelector('.spanel__title'));
  slaneOf(page, b).fire('click');
  assert.equal(inspectorOpen(page), true, 'the second selection keeps it open');
  assert.equal(page.inspector.querySelectorAll('.spanel').length, 1);
  assert.notEqual(text(page.inspector.querySelector('.spanel__title')), firstTitle);
  assert.equal(slaneOf(page, a).getAttribute('aria-expanded'), 'false');
  assert.equal(slaneOf(page, b).getAttribute('aria-expanded'), 'true');
  closeInspector(page);
  assert.equal(inspectorOpen(page), false);
  assert.equal(slaneOf(page, b).getAttribute('aria-expanded'), 'false');
  assert.equal(page.main.querySelector('.sessions').getAttribute('data-open'), 'false');
  assert.equal(page.doc.activeElement.getAttribute('data-focus-key'), `lane:${b}`);
});

/** Opens the row of `label` when it is closed (the fake matchMedia reads every max-width query as a phone). */
const openRow = (page: Page, label: string) => {
  const head = srowOf(page, label).querySelector('.srow__head');
  if (head.getAttribute('aria-expanded') !== 'true') head.fire('click');
};

test('D.2 Sessions focus (FU-n5a22a): as a drawer, a lane opens the inspector with the focus on its close control, and Escape there returns the focus to the lane', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/sessions', width: 1024, fetch: sessionsRoute(BUSY) });
  assert.equal(page.inspector.dataset.mode, 'drawer');
  openRow(page, 'feat-2');
  const lane = slaneOf(page, 'lock:build');
  lane.focus();
  lane.fire('click'); // Enter on a button reaches it as a click
  assert.equal(page.inspector.getAttribute('aria-modal'), 'true');
  assert.ok(page.doc.activeElement === page.inspector.querySelector('.inspector__close'), 'the focus is on the inspector close, not pulled back to the lane');
  assert.deepEqual(closeControlsOf(page).map((b: El) => b.className), ['btn btn--ghost inspector__close'], 'one close control: the inspector\'s own');
  page.inspector.fire('keydown', { key: 'Escape', target: page.doc.activeElement });
  assert.equal(inspectorOpen(page), false);
  assert.equal(page.inspector.getAttribute('aria-modal'), null);
  assert.ok(page.doc.activeElement === slaneOf(page, 'lock:build'), 'the focus is back on the lane, the node now on the page');
});

test('D.2 Sessions focus (FU-n5a22a): docked, Escape with the focus on a lane closes the panel and the focus stays on that lane', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/sessions', width: 1440, fetch: sessionsRoute(BUSY) });
  assert.equal(page.inspector.dataset.mode, 'dock');
  openRow(page, 'feat-2');
  slaneOf(page, 'lock:build').fire('click');
  assert.equal(inspectorOpen(page), true);
  const lane = slaneOf(page, 'lock:build');
  assert.ok(page.doc.activeElement === lane, 'docked, the lane keeps the focus after it opens');
  page.main.querySelector('.sessions').fire('keydown', { key: 'Escape', target: lane });
  assert.equal(inspectorOpen(page), false, 'Escape on the lane closes the panel');
  const fresh = slaneOf(page, 'lock:build');
  assert.ok(fresh !== lane, 'the rows were re-mounted');
  assert.ok(page.doc.activeElement === fresh, 'the focus is on the same lane, by its focus key');
  assert.equal(fresh.getAttribute('aria-expanded'), 'false');
});

// ---- 149 D.3: hash permalinks (IC-019, DEC-034) ----

const callsSince = (page: Page, from: number, prefix: string) => page.calls.slice(from).filter((c) => c.url.startsWith(prefix)).length;

/** 150 C.5 (IC-015): a Session hash with no node, with each node form, and a worker node with each tab. */
const SESSION_RUN_ID = 'w-0123456789ab';
const SESSION_HASHES = ['', '/main', '/stage/design', '/gate/gate-0', '/task/A.1', '/attempt/A.1/1', '/attempt/B.2/12', `/worker/${SESSION_RUN_ID}`,
  ...['log', 'transcript', 'result', 'process'].map((tab) => `/worker/${SESSION_RUN_ID}/${tab}`)].map((node) => `#/session/feat-a/run-1${node}`);

test('D.3 grammar: parseRoute names the selection of Run, Tasks and Sessions; hashFor is its inverse; a lane with an absent part has no hash', () => {
  const { parseRoute, hashFor, VIEWS } = mods.views;
  const run = parseRoute('#/run/feat-a/run-1/stage/planning');
  assert.equal(run.id, 'run');
  assert.deepEqual(run.params, { slug: 'feat-a', taskId: 'run-1' });
  assert.deepEqual(run.sel, { type: 'stage', id: 'planning' });
  assert.deepEqual(parseRoute('#/run/feat-a/run-1/gate/gate-a').sel, { type: 'gate', id: 'gate-a' });
  const tasks = parseRoute('#/run/feat-a/run-1/tasks/A.1');
  assert.equal(tasks.id, 'tasks');
  assert.equal(tasks.task, 'A.1');
  assert.equal(tasks.view, VIEWS.tasks);
  const lanes: Array<[string, string]> = [
    [`#/sessions/hook/${sk(101)}`, `hook:${sk(101)}`],
    [`#/sessions/launched/${sk(102)}`, `launched:${sk(102)}`],
    ['#/sessions/lock/build', 'lock:build'],
    ['#/sessions/worker/feat-a/A.1/3', 'worker:feat-a/A.1/3'],
    [`#/sessions/run/${sk(1)}/run-two/lin2`, `run:${sk(1)}/run-two/lin2`],
  ];
  for (const [hash, lane] of lanes) {
    const route = parseRoute(hash);
    assert.equal(route.id, 'sessions', hash);
    assert.equal(route.lane, lane, hash);
    assert.equal(hashFor(route), hash, `${hash} round trips`);
  }
  // Layers keeps its params (an agent or a file, never both); routes without a selection carry no selection field.
  assert.deepEqual(parseRoute(`#/layers/${sk(7)}/agent/${sk(8)}`).params, { project: sk(7), agent: sk(8) });
  assert.deepEqual(parseRoute(`#/layers/${sk(7)}/file/${sk(8)}`).params, { project: sk(7), file: sk(8) });
  assert.equal('sel' in parseRoute('#/run/feat-a/run-1'), false);
  assert.equal('task' in parseRoute('#/run/feat-a/run-1/tasks'), false);
  assert.equal('lane' in parseRoute('#/sessions'), false);
  // The round trip: parseRoute(hashFor(r)) equals r for every route hashFor gives a hash for.
  const hashes = ['#/', '#/workflows', '#/sessions', '#/layers', `#/layers/${sk(7)}`, `#/layers/${sk(7)}/agent/${sk(8)}`, `#/layers/${sk(7)}/file/${sk(8)}`, '#/run/feat-a/run-1', '#/run/feat-a/run-1/tasks',
    '#/run/feat-a/run-1/tasks/A.1', '#/run/feat-a/run-1/stage/design', '#/run/feat-a/run-1/gate/gate-0', ...lanes.map(([hash]) => hash), ...SESSION_HASHES];
  for (const hash of hashes) {
    const route = parseRoute(hash);
    assert.notEqual(route.id, 'not-found', hash);
    assert.equal(hashFor(route), hash, hash);
    assert.deepEqual(parseRoute(hashFor(route)), route, hash);
  }
  // DEC-034: a lane key with an absent part has no hash; nor has a key failing its pattern, nor Not found.
  for (const lane of ['run:-/run-two/lin2', `run:${sk(1)}/-/lin2`, 'run:-/-/-', 'hook:-', 'worker:feat-a/A.1/0', 'lock:-x', 'other:x']) {
    assert.equal(hashFor({ id: 'sessions', params: {}, view: VIEWS.sessions, lane }), null, lane);
  }
  assert.equal(hashFor({ id: 'run', params: { slug: 'feat-a', taskId: 'run-1' }, view: VIEWS.run, sel: { type: 'node', id: 'x' } }), null);
  assert.equal(hashFor(parseRoute('#/nope')), null);
  // A selection segment failing its pattern is Not found.
  for (const bad of ['#/run/a/b/stage/-x', '#/run/a/b/gate', '#/run/a/b/stage/x/y', '#/run/a/b/tasks/.x', '#/run/a/b/tasks/A.1/x', '#/run/a/b/node/x',
    '#/sessions/hook/XYZ', `#/sessions/hook/${sk(1)}/x`, '#/sessions/run/-/a/b', `#/sessions/run/${sk(1)}/-/b`, '#/sessions/worker/a/b/0', '#/sessions/worker/a/b',
    '#/sessions/lock/', '#/sessions/other/x']) {
    assert.equal(parseRoute(bad).id, 'not-found', bad);
  }
});

test('D.3 a failing selection segment is Not found with no fetch', async () => {
  const page = await start({ hash: '#/run/feat-a/run-1/stage/-x', fetch: runRoute(() => runBody(frow('run-1', 2), WF_FEATURE, [ev(30, 'start', null)])) });
  assert.equal(text(heading(page)), 'Not found');
  assert.equal(callsSince(page, 0, '/api/runs'), 0, 'no fetch for the run');
  const before = page.calls.length;
  page.location.hash = '#/sessions/run/-/run-two/lin2';
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(text(heading(page)), 'Not found');
  assert.equal(callsSince(page, before, '/api/sessions'), 0, 'no fetch for the sessions');
  assert.equal(inspectorOpen(page), false);
});

test('D.3 Run: selecting a node sets the hash; a hash change in the run reroutes without a re-mount; closing removes the segment', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(frow('run-1', 2), WF_FEATURE, [ev(30, 'start', null)])) });
  const buttons = () => page.main.querySelectorAll('.rail__node');
  const h1 = heading(page);
  buttons()[4].fire('click');
  assert.equal(page.location.hash, '#/run/feat-a/run-1/gate/gate-a');
  assert.equal(inspectorOpen(page), true);
  const before = page.calls.length;
  page.win.dispatch('hashchange'); // the hash the view wrote: nothing to do
  assert.equal(heading(page), h1, 'no re-mount');
  assert.equal(inspectorOpen(page), true);
  // Back, or a typed hash, to another node of the same run.
  page.location.hash = '#/run/feat-a/run-1/gate/gate-0';
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(heading(page), h1, 'no re-mount');
  assert.equal(callsSince(page, before, '/api/runs'), 0, 'no new fetch');
  assert.equal(text(page.inspector.querySelector('.rail-detail__title')), 'gate-0');
  assert.equal(buttons()[1].getAttribute('aria-expanded'), 'true');
  assert.equal(buttons()[4].getAttribute('aria-expanded'), 'false');
  page.location.hash = '#/run/feat-a/run-1/stage/design';
  page.win.dispatch('hashchange');
  assert.equal(buttons()[2].getAttribute('aria-expanded'), 'true');
  // No selection in the route: the inspector is closed.
  page.location.hash = '#/run/feat-a/run-1';
  page.win.dispatch('hashchange');
  assert.equal(heading(page), h1, 'no re-mount');
  assert.equal(inspectorOpen(page), false);
  assert.equal(buttons()[2].getAttribute('aria-expanded'), 'false');
  // The inspector close removes the segment.
  buttons()[3].fire('click');
  assert.equal(page.location.hash, '#/run/feat-a/run-1/stage/planning');
  closeInspector(page);
  assert.equal(page.location.hash, '#/run/feat-a/run-1');
  assert.equal(inspectorOpen(page), false);
  // The same node again closes it and removes the segment too.
  buttons()[3].fire('click');
  buttons()[3].fire('click');
  assert.equal(page.location.hash, '#/run/feat-a/run-1');
  assert.equal(inspectorOpen(page), false);
  // Another run is another base route: a re-mount.
  page.location.hash = '#/run/feat-a/run-2/stage/design';
  page.win.dispatch('hashchange');
  assert.notEqual(heading(page), h1, 'another run re-mounts');
  await settle();
});

test('D.3 reload restores the selection: a Run hash opens its node in the inspector, and a poll keeps it', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1/gate/gate-a', fetch: runRoute(() => runBody(frow('run-1', 2), WF_FEATURE, [ev(30, 'start', null)])) });
  const buttons = () => page.main.querySelectorAll('.rail__node');
  assert.equal(inspectorOpen(page), true);
  assert.equal(text(page.inspector.querySelector('.rail-detail__title')), 'gate-a');
  assert.equal(buttons()[4].getAttribute('aria-expanded'), 'true');
  await advance(3_000);
  assert.equal(inspectorOpen(page), true);
  assert.equal(page.location.hash, '#/run/feat-a/run-1/gate/gate-a');
});

test('D.3 Tasks: selecting a task sets the hash; a hash change reroutes without a re-mount; reload restores it; closing removes the segment', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1/tasks/B.1', fetch: graphRoute(GRAPH_PLAN) });
  assert.equal(inspectorOpen(page), true, 'reload restores the selection');
  assert.equal(text(page.inspector.querySelector('.graph__paneltitle')), 'B.1');
  assert.equal(gcardOf(page, 'B.1').getAttribute('aria-expanded'), 'true');
  const graph = page.main.querySelector('.graph');
  gcardOf(page, 'A.1').fire('click');
  assert.equal(page.location.hash, '#/run/feat-a/run-1/tasks/A.1');
  assert.equal(text(page.inspector.querySelector('.graph__paneltitle')), 'A.1');
  const before = page.calls.length;
  page.location.hash = '#/run/feat-a/run-1/tasks/A.2';
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(page.main.querySelector('.graph'), graph, 'no re-mount');
  assert.equal(callsSince(page, before, '/api/runs'), 0, 'no new fetch');
  assert.equal(text(page.inspector.querySelector('.graph__paneltitle')), 'A.2');
  assert.equal(gcardOf(page, 'A.2').getAttribute('aria-expanded'), 'true');
  assert.equal(gcardOf(page, 'A.1').getAttribute('aria-expanded'), 'false');
  // A task the plan does not list opens nothing.
  page.location.hash = '#/run/feat-a/run-1/tasks/Z.9';
  page.win.dispatch('hashchange');
  assert.equal(page.main.querySelector('.graph'), graph);
  assert.equal(inspectorOpen(page), false);
  page.location.hash = '#/run/feat-a/run-1/tasks/A.1';
  page.win.dispatch('hashchange');
  assert.equal(inspectorOpen(page), true);
  closeInspector(page);
  assert.equal(page.location.hash, '#/run/feat-a/run-1/tasks');
  assert.equal(inspectorOpen(page), false);
  assert.equal(page.main.querySelector('.graph'), graph);
});

test('D.3 Sessions: selecting a lane sets the hash, reload restores it, a hash change reroutes without a re-mount; a lane with an absent part is not linked', async () => {
  mods.home.resetHome();
  const body = () => {
    const b = BUSY();
    b.sections.tasks.data[0].active.push(sAttempt(2, 'A.5', { worktreeKey: null, run: null, lineage: null }));
    return b;
  };
  const page = await start({ hash: '#/sessions/lock/build', fetch: sessionsRoute(body) });
  assert.equal(inspectorOpen(page), true, 'reload restores the selection');
  assert.equal(slaneOf(page, 'lock:build').getAttribute('aria-expanded'), 'true');
  const root = page.main.querySelector('.sessions');
  const hook = `hook:${sk(101)}`;
  slaneOf(page, hook).fire('click');
  assert.equal(page.location.hash, `#/sessions/hook/${sk(101)}`);
  assert.equal(slaneOf(page, hook).getAttribute('aria-expanded'), 'true');
  const before = page.calls.length;
  page.location.hash = '#/sessions/lock/build';
  page.win.dispatch('hashchange');
  await settle();
  assert.equal(page.main.querySelector('.sessions'), root, 'no re-mount');
  assert.equal(callsSince(page, before, '/api/sessions'), 0, 'no new fetch');
  assert.equal(slaneOf(page, 'lock:build').getAttribute('aria-expanded'), 'true');
  assert.equal(slaneOf(page, hook).getAttribute('aria-expanded'), 'false');
  // DEC-034: the lane opens, and the address stays at the base route.
  const unplaced = 'run:-/-/-';
  assert.ok(slaneOf(page, unplaced), 'the lane with absent parts is on the page');
  slaneOf(page, unplaced).fire('click');
  assert.equal(page.location.hash, '#/sessions');
  assert.equal(inspectorOpen(page), true);
  assert.equal(slaneOf(page, unplaced).getAttribute('aria-expanded'), 'true');
  page.win.dispatch('hashchange'); // the hash the view wrote: the lane stays open
  assert.equal(inspectorOpen(page), true);
  closeInspector(page);
  assert.equal(page.location.hash, '#/sessions');
  assert.equal(inspectorOpen(page), false);
  // Closing a linked lane removes its segment.
  slaneOf(page, 'lock:build').fire('click');
  assert.equal(page.location.hash, '#/sessions/lock/build');
  closeInspector(page);
  assert.equal(page.location.hash, '#/sessions');
  assert.equal(page.main.querySelector('.sessions'), root);
});

// ---- 150 C.5: the Session route and its permalinks (IC-015, IC-017) ---------------------------------------------------

test('C.5 grammar: parseRoute names the Session node and tab; hashFor is its inverse; a failing segment or a stray tab has no route', () => {
  const { parseRoute, hashFor, baseRoute, VIEWS } = mods.views;
  const base = { id: 'session', params: { slug: 'feat-a', taskId: 'run-1' }, view: VIEWS.session };
  const expected: Array<[string, any]> = [
    ['', {}],
    ['/main', { node: { kind: 'main' } }],
    ['/stage/design', { node: { kind: 'stage', id: 'design' } }],
    ['/gate/gate-0', { node: { kind: 'gate', id: 'gate-0' } }],
    ['/task/A.1', { node: { kind: 'task', id: 'A.1' } }],
    ['/attempt/A.1/1', { node: { kind: 'attempt', task: 'A.1', token: 1 } }],
    ['/attempt/B.2/12', { node: { kind: 'attempt', task: 'B.2', token: 12 } }],
    [`/worker/${SESSION_RUN_ID}`, { node: { kind: 'worker', runId: SESSION_RUN_ID } }],
    ...['log', 'transcript', 'result', 'process'].map((tab): [string, any] => [`/worker/${SESSION_RUN_ID}/${tab}`, { node: { kind: 'worker', runId: SESSION_RUN_ID }, tab }]),
  ];
  assert.deepEqual(expected.map(([node]) => `#/session/feat-a/run-1${node}`), SESSION_HASHES);
  for (const [node, selection] of expected) {
    const hash = `#/session/feat-a/run-1${node}`;
    const route = parseRoute(hash);
    assert.deepEqual(route, { ...base, ...selection }, hash);
    assert.equal(hashFor(route), hash, hash);
    assert.deepEqual(parseRoute(hashFor(route)), route, hash);
    assert.deepEqual(baseRoute(route), base, `${hash}: the base drops node and tab`);
  }
  assert.equal('node' in parseRoute('#/session/feat-a/run-1'), false);
  assert.equal('tab' in parseRoute(`#/session/feat-a/run-1/worker/${SESSION_RUN_ID}`), false, 'a worker node without a tab carries none (Log)');
  // Every segment is checked: ids by PARAM_PATTERN, tokens by TOKEN, run ids by RUN_ID, tabs by the four names.
  for (const bad of ['#/session', '#/session/', '#/session/a/', '#/session/-a/b', '#/session/a/.b', '#/session/a/b/main/x', '#/session/a/b/stage', '#/session/a/b/stage/-x',
    '#/session/a/b/gate/x/y', '#/session/a/b/task/.x', '#/session/a/b/attempt/A.1', '#/session/a/b/attempt/A.1/01', '#/session/a/b/attempt/-x/1', '#/session/a/b/attempt/A.1/1/x',
    '#/session/a/b/attempt/A.1/99999999999999999999', '#/session/a/b/worker', `#/session/a/b/worker/${SESSION_RUN_ID.toUpperCase()}`, '#/session/a/b/worker/w-0123456789abc',
    `#/session/a/b/worker/${SESSION_RUN_ID}/Log`, `#/session/a/b/worker/${SESSION_RUN_ID}/log/x`, '#/session/a/b/tab/log', '#/session/a/b/main/log', '#/session/a/b/lane/x']) {
    assert.equal(parseRoute(bad).id, 'not-found', bad);
  }
  // hashFor gives no hash for a route parseRoute could not have made.
  const worker = { kind: 'worker', runId: SESSION_RUN_ID };
  for (const [label, extra] of [
    ['a tab on a stage', { node: { kind: 'stage', id: 'design' }, tab: 'log' }], ['a tab without a node', { tab: 'log' }], ['an unknown tab', { node: worker, tab: 'last' }],
    ['a short run id', { node: { kind: 'worker', runId: 'w-0123' } }], ['token 0', { node: { kind: 'attempt', task: 'A.1', token: 0 } }],
    ['a token as text', { node: { kind: 'attempt', task: 'A.1', token: '1' } }], ['a fractional token', { node: { kind: 'attempt', task: 'A.1', token: 1.5 } }],
    ['a bad id', { node: { kind: 'task', id: '-x' } }], ['an unknown kind', { node: { kind: 'lane', id: 'x' } }], ['a null node', { node: null }],
  ] as Array<[string, any]>) {
    assert.equal(hashFor({ ...base, ...extra }), null, label);
  }
  assert.equal(hashFor({ ...base, params: { slug: '-x', taskId: 'run-1' } }), null, 'a bad slug');
});

test('C.5 VIEWS.session: inspectable, IC-017 shapes equal to SESSION_SHAPES, the run path, and the view functions of session.js', async () => {
  const session = await import(url('views/session.js'));
  const view = mods.views.VIEWS.session;
  assert.equal(view.id, 'session');
  assert.equal(view.inspectable, true);
  assert.deepEqual(view.shapes, [...session.SESSION_SHAPES]);
  assert.notDeepEqual(view.shapes.slice(1), [...session.SESSION_SHAPES], 'control: a list missing a shape differs');
  for (const shape of view.shapes) assert.ok(mods.views.SHAPES_USED.includes(shape), shape);
  assert.equal(view.api({ slug: 'feat-a', taskId: 'run-1' }), '/api/runs/feat-a/run-1');
  assert.equal(view.pollMs, session.SESSION_POLL_MS);
  assert.equal(view.load, session.loadSession);
  assert.equal(view.connect, session.connectSession);
  assert.equal(view.render, session.renderSession);
  assert.equal(view.reroute, session.rerouteSession);
  assert.equal(view.tick, session.tickSession);
  assert.equal(view.teardown, session.teardownSession);
  // load reads `/api/worker-runs/<slug>` as well as the run.
  const paths: string[] = [];
  const data = await view.load({ route: { params: { slug: 'feat-a', taskId: 'run-1' } } }, async (target: string) => { paths.push(target); return { target }; });
  assert.deepEqual(paths.sort(), ['/api/runs/feat-a/run-1', '/api/worker-runs/feat-a']);
  assert.deepEqual(data, { run: { target: '/api/runs/feat-a/run-1' }, workers: { target: '/api/worker-runs/feat-a' }, workersError: null });
});

test('C.5 leaf module: session.js imported before views.js in a fresh module graph loads both without circular TDZ', () => {
  const { spawnSync } = require('node:child_process');
  const probe = (root: string) => spawnSync(process.execPath, ['--input-type=module', '-e', [
    `const session = await import(${JSON.stringify(pathToFileURL(path.join(root, 'views', 'session.js')).href)});`,
    `const views = await import(${JSON.stringify(pathToFileURL(path.join(root, 'views.js')).href)});`,
    'const same = JSON.stringify(views.VIEWS.session.shapes) === JSON.stringify(session.SESSION_SHAPES);',
    "process.stdout.write(JSON.stringify({ same, keys: Object.keys(views.VIEWS).includes('session'), route: views.parseRoute('#/session/a/b/main').id }));",
  ].join('\n')], { encoding: 'utf8' });
  const result = probe(copy);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { same: true, keys: true, route: 'session' });
  // With leaf routes.js, views.js eagerly reading SESSION_SHAPES also succeeds (no circular TDZ).
  const verified = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-cycle-'));
  try {
    fs.cpSync(copy, verified, { recursive: true });
    const file = path.join(verified, 'views.js');
    const source = fs.readFileSync(file, 'utf8');
    const literal = /shapes: \['status', 'timeline', 'attempts', 'workflow', 'worker-runs',[^\]]*\],/.exec(source);
    assert.ok(literal, 'the inline shapes list is in views.js');
    if (literal === null) return;
    fs.writeFileSync(file, source.replace(literal[0], 'shapes: SESSION_SHAPES,').replace('  sessionApi, loadSession,', '  SESSION_SHAPES, sessionApi, loadSession,'));
    const eager = probe(verified);
    assert.equal(eager.status, 0, eager.stderr);
  } finally {
    fs.rmSync(verified, { recursive: true, force: true });
  }
});

const SESSION_RUN_B = 'w-00000000000b';
const sessionWorkerRow = (runId: string) => ({
  runId, task: 'A.1', token: 1, harness: 'codex', childOf: null, phase: 'running', endState: null, createdAt: agoIso(12 * MIN_MS), startedAt: agoIso(12 * MIN_MS), endedAt: null, edit: false,
});
function sessionWorkers() {
  const runs = [sessionWorkerRow(SESSION_RUN_ID), sessionWorkerRow(SESSION_RUN_B)];
  const projected = project('worker-runs', { v: 1, slug: 'feat-a', store: 'present', runs, limits: { shown: runs.length, notShown: 0 } });
  assert.ok(projected.ok, 'the worker-runs projector accepts the fixture');
  return projected.body;
}
const sessionLogPage = (runId: string, stream: string) => {
  const pieces = [{ at: 0, text: `${stream} text` }];
  const to = pieces[0].text.length + 1;
  return { v: 1, runId, stream, phase: 'running', log: 'open', ino: '7', size: to, from: 0, to, pieces, eof: true, reset: false, capped: null, cursor: `7:${to}:0:0`, before: null };
};
const sessionTranscript = () => ({
  v: 1, agentKey: '0123456789abcdef', harness: 'codex', reader: { id: 'codex', status: 'supported' }, transcript: { linked: true, reason: null },
  events: [{ seq: 1, at: agoIso(11 * MIN_MS), kind: 'reply', agentKey: '0123456789abcdef', model: null, tool: null, text: 'working on it', args: null, cut: false, tokens: null, record: null }], cursor: null,
});
/** The run (a plan with an active attempt on A.1), its feature's two worker runs on that attempt, and their log and transcript. */
const sessionRoute = () => (target: string, init: any): Reply => {
  if (target === '/api/runs/feat-a/run-1') {
    return reply(200, runBodyWith(frow('run-1', 3), [ev(60, 'start', null)], graphTasks([gtask('A.1'), gtask('B.1', ['A.1'])],
      [gstate('A.1', 'RUNNING', 'active-attempt', att(1, 'worker-a', 'active', 12)), gstate('B.1', 'PLANNED', 'unmet-dependency')])));
  }
  if (target === '/api/worker-runs/feat-a') return reply(200, sessionWorkers());
  for (const runId of [SESSION_RUN_ID, SESSION_RUN_B]) {
    const at = `/api/worker-runs/feat-a/${runId}`;
    if (target === `${at}/log?stream=out` || target === `${at}/log?stream=err`) return reply(200, sessionLogPage(runId, target.endsWith('out') ? 'out' : 'err'));
    if (target === `${at}/transcript`) return reply(200, sessionTranscript());
  }
  return standard(target, init);
};
const chainItem = (page: Page, key: string): any => page.main.querySelectorAll('.chain__item').find((item: El) => item.getAttribute('data-key') === key);
const chainSelected = (page: Page) => page.main.querySelectorAll('.chain__item').filter((item: El) => item.getAttribute('aria-selected') === 'true').map((item: El) => item.getAttribute('data-key'));
/** A click on a tree item, as it bubbles to the tree's listener. */
const clickChain = (page: Page, key: string) => page.main.querySelector('.chain').querySelector('ul').fire('click', { target: chainItem(page, key) });
const workerTab = (page: Page, tab: string): any => page.inspector.querySelectorAll('.wtabs__tab').find((b: El) => b.getAttribute('data-tab') === tab);
const selectedTab = (page: Page) => page.inspector.querySelectorAll('.wtabs__tab').filter((b: El) => b.getAttribute('aria-selected') === 'true').map((b: El) => b.getAttribute('data-tab'));
const exactCalls = (page: Page, from: number, target: string) => page.calls.slice(from).filter((c) => c.url === target).length;

test('C.5 a failing Session segment is Not found with no fetch, on load and on a hash change', async () => {
  const bad = ['#/session/a', '#/session/a/b/c', '#/session/a/b/worker/w-0123', '#/session/a/b/worker/w-0123456789ab/last', '#/session/a/b/attempt/A.1/0'];
  for (const hash of bad) {
    const page = await start({ hash, fetch: sessionRoute() });
    assert.equal(text(heading(page)), 'Not found', hash);
    assert.equal(callsSince(page, 0, '/api/runs'), 0, `${hash}: no run fetch`);
    assert.equal(callsSince(page, 0, '/api/worker-runs'), 0, `${hash}: no worker-runs fetch`);
    assert.equal(inspectorOpen(page), false, hash);
    uninstallPage();
    mock.timers.reset();
  }
  const page = await start({ hash: '#/session/feat-a/run-1/main', fetch: sessionRoute() });
  assert.equal(text(heading(page)), 'Chain');
  for (const hash of bad.map((h) => h.replace('#/session/a', '#/session/feat-a').replace('/b', '/run-1'))) {
    const before = page.calls.length;
    page.location.hash = hash;
    page.win.dispatch('hashchange');
    await settle();
    assert.equal(text(heading(page)), 'Not found', hash);
    assert.equal(callsSince(page, before, '/api/runs'), 0, `${hash}: no run fetch`);
    assert.equal(callsSince(page, before, '/api/worker-runs'), 0, `${hash}: no worker-runs fetch`);
    assert.equal(inspectorOpen(page), false, hash);
  }
});

test('C.5 reload restores node and tab: a worker run opens on its tab, and a worker node without a tab shows Log; Now is current', async () => {
  const page = await start({ hash: `#/session/feat-a/run-1/worker/${SESSION_RUN_ID}/transcript`, fetch: sessionRoute() });
  assert.equal(text(heading(page)), 'Chain');
  assert.deepEqual(current(page), ['Now']);
  assert.equal(page.shell.dataset.inspectable, 'true');
  assert.equal(exactCalls(page, 0, '/api/runs/feat-a/run-1'), 1);
  assert.equal(exactCalls(page, 0, '/api/worker-runs/feat-a'), 1, 'load reads the worker runs too');
  assert.equal(inspectorOpen(page), true);
  assert.deepEqual(chainSelected(page), [`worker:${SESSION_RUN_ID}`]);
  assert.deepEqual(selectedTab(page), ['transcript']);
  assert.equal(exactCalls(page, 0, `/api/worker-runs/feat-a/${SESSION_RUN_ID}/transcript`), 1);
  await advance(3_000);
  assert.equal(inspectorOpen(page), true, 'a poll keeps the selection');
  assert.deepEqual(selectedTab(page), ['transcript']);
  assert.equal(page.location.hash, `#/session/feat-a/run-1/worker/${SESSION_RUN_ID}/transcript`);
  uninstallPage();
  mock.timers.reset();

  const log = await start({ hash: `#/session/feat-a/run-1/worker/${SESSION_RUN_B}`, fetch: sessionRoute() });
  assert.equal(inspectorOpen(log), true);
  assert.deepEqual(chainSelected(log), [`worker:${SESSION_RUN_B}`]);
  assert.deepEqual(selectedTab(log), ['log'], 'no tab in the hash: Log');
  assert.ok(exactCalls(log, 0, `/api/worker-runs/feat-a/${SESSION_RUN_B}/log?stream=out`) >= 1, 'the Log tab reads its stream');
  assert.equal(log.location.hash, `#/session/feat-a/run-1/worker/${SESSION_RUN_B}`, 'showing Log writes no tab');
  uninstallPage();
  mock.timers.reset();

  for (const [node, key] of [['/attempt/A.1/1', 'attempt:A.1/1'], ['/task/B.1', 'task:B.1'], ['/gate/gate-0', 'gate:gate-0'], ['/main', 'main']]) {
    const other = await start({ hash: `#/session/feat-a/run-1${node}`, fetch: sessionRoute() });
    assert.equal(inspectorOpen(other), true, node);
    assert.deepEqual(chainSelected(other), [key], node);
    uninstallPage();
    mock.timers.reset();
  }
  const none = await start({ hash: '#/session/feat-a/run-1', fetch: sessionRoute() });
  assert.equal(inspectorOpen(none), false, 'no node: the inspector is closed');
  assert.deepEqual(chainSelected(none), []);
});

test('C.5 a node or tab change reroutes with no re-mount; the inspector is open exactly when the route carries a node; selections write the hash', async () => {
  const page = await start({ hash: '#/session/feat-a/run-1', fetch: sessionRoute() });
  const h1 = heading(page);
  const outline = page.main.querySelector('.chain');
  assert.ok(outline, 'the outline is on the page');
  assert.equal(inspectorOpen(page), false);
  const same = (label: string) => {
    assert.equal(heading(page), h1, `${label}: no re-mount`);
    assert.equal(page.main.querySelector('.chain'), outline, `${label}: the outline is kept`);
  };
  // A selection in the outline writes its node.
  clickChain(page, 'task:A.1');
  assert.equal(page.location.hash, '#/session/feat-a/run-1/task/A.1');
  assert.equal(inspectorOpen(page), true);
  page.win.dispatch('hashchange'); // the hash the view wrote: nothing to do
  same('own hash');
  assert.equal(inspectorOpen(page), true);
  const before = page.calls.length;
  // A typed or back-button node change.
  page.location.hash = `#/session/feat-a/run-1/worker/${SESSION_RUN_ID}`;
  page.win.dispatch('hashchange');
  await settle();
  same('to a worker');
  assert.deepEqual(chainSelected(page), [`worker:${SESSION_RUN_ID}`]);
  assert.deepEqual(selectedTab(page), ['log']);
  assert.equal(inspectorOpen(page), true);
  // A tab change in the hash.
  page.location.hash = `#/session/feat-a/run-1/worker/${SESSION_RUN_ID}/transcript`;
  page.win.dispatch('hashchange');
  await settle();
  same('to a tab');
  assert.deepEqual(selectedTab(page), ['transcript']);
  // Choosing a tab writes it into the hash.
  workerTab(page, 'log').fire('click');
  assert.equal(page.location.hash, `#/session/feat-a/run-1/worker/${SESSION_RUN_ID}/log`);
  page.win.dispatch('hashchange');
  same('own tab');
  assert.deepEqual(selectedTab(page), ['log']);
  // Another worker run from the outline opens on Log, with no tab in the hash.
  workerTab(page, 'transcript').fire('click');
  clickChain(page, `worker:${SESSION_RUN_B}`);
  assert.equal(page.location.hash, `#/session/feat-a/run-1/worker/${SESSION_RUN_B}`);
  assert.deepEqual(selectedTab(page), ['log']);
  page.location.hash = '#/session/feat-a/run-1/main';
  page.win.dispatch('hashchange');
  await settle();
  same('to main');
  assert.deepEqual(chainSelected(page), ['main']);
  assert.equal(inspectorOpen(page), true);
  assert.equal(exactCalls(page, before, '/api/runs/feat-a/run-1'), 0, 'no new run fetch');
  assert.equal(exactCalls(page, before, '/api/worker-runs/feat-a'), 0, 'no new worker-runs fetch');
  // No node in the route: the inspector is closed.
  page.location.hash = '#/session/feat-a/run-1';
  page.win.dispatch('hashchange');
  same('to no node');
  assert.equal(inspectorOpen(page), false);
  assert.deepEqual(chainSelected(page), []);
  // The inspector's close removes the node.
  clickChain(page, 'stage:design');
  assert.equal(page.location.hash, '#/session/feat-a/run-1/stage/design');
  assert.equal(inspectorOpen(page), true);
  closeInspector(page);
  assert.equal(page.location.hash, '#/session/feat-a/run-1');
  assert.equal(inspectorOpen(page), false);
  same('closed');
  // Another run is another base route: a re-mount.
  page.location.hash = '#/session/feat-a/run-2/main';
  page.win.dispatch('hashchange');
  assert.notEqual(heading(page), h1, 'another run re-mounts');
  await settle();
});

// ---- 149 D.5: one loop per view (IC-022, DEC-038) ---------------------------------------------------------------------

test('149 D.5 one loop per view: Run marks the running edge, else the awaiting gate; Now marks the first Needs you glyph; a skeleton only while it shows', async () => {
  mods.home.resetHome();
  let cursor = 3;
  const events = () => [ev(60, 'start', null), ev(50, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(40, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(30, 'complete-stage', 'design', { outcome: 'passed' })];
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBodyWith(frow('run-1', cursor), events())) });
  const marked = () => [...page.main.querySelectorAll('[data-loop="on"]'), ...page.inspector.querySelectorAll('[data-loop="on"]')];
  let loops = marked();
  assert.equal(loops.length, 1, 'one marked element on the Run view');
  assert.ok(loops[0].classList.contains('flow-edge'), 'the running connector');
  assert.equal(loops[0].parent.getAttribute('data-state'), 'running');
  assert.equal(page.main.querySelectorAll('.flow-edge').length, 1, 'only the running node has a flowing edge');
  cursor = 4;
  await advance(3_000);
  loops = marked();
  assert.equal(loops.length, 1, 'still one marked element');
  assert.ok(loops[0].classList.contains('rail__glyph'), 'the awaiting gate glyph');
  assert.equal(loops[0].parent.parent.getAttribute('data-type'), 'gate');
  assert.equal(page.main.querySelector('.flow-edge'), null, 'no running node, no flowing edge');
  uninstallPage();
  mock.timers.reset();
  mods.home.resetHome();

  const home = await start({ hash: '', fetch: homeFetch(() => body([frow('w-new', 4, { updatedAt: agoIso(10 * MIN_MS) }), frow('w-old', 1, { updatedAt: agoIso(30 * MIN_MS) }), frow('r-1', 2)])) });
  assert.equal(cardsOf(home).length, 2);
  const pulses = home.main.querySelectorAll('[data-loop="on"]').filter((node: El) => !node.classList.contains('flow-dot'));
  assert.equal(pulses.length, 1, 'one pulse on Now');
  assert.equal(cardsOf(home)[0].querySelectorAll('[data-loop="on"]').length, 1, 'in the first Needs you card');
  assert.equal(cardsOf(home)[0].querySelector('[data-loop="on"]').getAttribute('data-state'), 'awaiting');
  // The dot flow: the connector into a stage the data says is running carries the dot, and no other glyph does.
  const dots = home.main.querySelectorAll('.flow-dot');
  assert.equal(dots.length, 1, 'one running run, one dot');
  assert.equal(dots[0].getAttribute('data-loop'), 'on');
  assert.deepEqual([dots[0].parent.getAttribute('data-type'), dots[0].parent.getAttribute('data-state')], ['stage', 'running']);
  assert.ok(rowOf(home, 'feat-a / r-1').querySelector('.flow-dot'), 'in the running row');

  const shown = mods.states.renderLoading({ noun: 'runs', skeleton: () => mods.dom.h('div', { class: 'skeleton' }), showSkeleton: true });
  assert.equal(shown[1].getAttribute('data-loop'), 'on', 'a skeleton loops while it shows');
  assert.equal(mods.states.renderLoading({ noun: 'runs', skeleton: () => mods.dom.h('div', { class: 'skeleton' }), showSkeleton: false })[1], null);
});

// ---- 150 C.6: links into the Session screen (IC-020) ---------------------------------------------------------------

/** Each link of `el` as `[href, text]`, in document order. */
const linksOf = (el: El) => el.querySelectorAll('a').map((a: El) => [a.getAttribute('href'), text(a)]);

test('150 C.6 Now: a run row and a gate card each add a Chain link to the Session screen after the link they had', async () => {
  mods.home.resetHome();
  const runs = () => [frow('w1', 4), frow('r1', 2), frow('flat-1', 0, { featureSlug: null })];
  const page = await start({ hash: '', fetch: homeFetch(() => body(runs())) });
  const { parseRoute } = mods.views;

  const row = rowOf(page, 'feat-a / r1');
  assert.deepEqual(linksOf(row), [['#/run/feat-a/r1', 'feat-a / r1'], ['#/session/feat-a/r1', 'Chain']], 'the run link first, unchanged, then Chain');
  const rowChain = row.querySelectorAll('a')[1];
  assert.equal(rowChain.getAttribute('aria-label'), 'Chain: feat-a / r1');
  assert.equal(rowChain.dataset.focusKey, 'chain:feat-a/r1');
  assert.equal(row.querySelector('.run-row__link').dataset.focusKey, 'run:feat-a/r1', 'the run link keeps its focus key');
  assert.deepEqual(parseRoute(rowChain.getAttribute('href')).params, { slug: 'feat-a', taskId: 'r1' });
  assert.equal(parseRoute(rowChain.getAttribute('href')).id, 'session');

  const card = cardOf(page, 'feat-a / w1');
  assert.deepEqual(linksOf(card), [['#/run/feat-a/w1', 'Open the run to decide →'], ['#/session/feat-a/w1', 'Chain']], 'the decide link first, unchanged, then Chain');
  const cardLink = card.querySelector('.gate-card__link');
  assert.equal(cardLink.getAttribute('aria-label'), 'Open the run to decide: feat-a / w1');
  assert.equal(cardLink.dataset.focusKey, 'run:feat-a/w1');
  const cardChain = card.querySelectorAll('a')[1];
  assert.equal(cardChain.getAttribute('aria-label'), 'Chain: feat-a / w1');
  assert.equal(cardChain.dataset.focusKey, 'chain:feat-a/w1');
  assert.equal(cardId(card), 'feat-a / w1', 'the run id line is unchanged');

  assert.equal(rowOf(page, 'flat-1').querySelector('a'), null, 'a run with no feature folder has no Chain link either');
  assert.ok([rowChain, cardChain].every((a: El) => a.children.length === 1 && a.children[0] instanceof Txt), 'the link text is one text node');
  assert.ok([rowChain, cardChain].every((a: El) => a.classList.contains('run-row__chain')), 'both carry the class that lifts them above the stretched run link');
});

test('150 C.6 CSS: the Now Chain link stacks above the stretched run link, and the run head Chain shares the step area', () => {
  const css = fs.readFileSync(path.join(WEB_ROOT, 'app.css'), 'utf8');
  const components = css.indexOf('@layer components {');
  const states = css.indexOf('@layer states {');
  const rule = (selector: string) => {
    const at = css.indexOf(`  ${selector} {`);
    assert.ok(at > components && at < states, `${selector} is in the components layer`);
    return css.slice(at, css.indexOf('}', at));
  };
  for (const stretched of ['.run-row__link::after', '.gate-card__link::after']) assert.match(rule(stretched), /position: absolute; inset: 0;/);
  const chain = rule('.run-row__chain');
  assert.match(chain, /position: relative;/);
  assert.match(chain, /z-index: 1;/);
  assert.match(rule('.run-head__aside'), /grid-area: step;/);
  assert.doesNotMatch(rule('.run-head__step'), /grid-area/, 'only the aside takes the step area');
});

test('150 C.6 Run head: a Chain link follows the step counter; the crumb keeps its one link to Runs', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1', fetch: runRoute(() => runBody(frow('run-1', 4), WF_FEATURE, [ev(5, 'start', null)])) });
  const head = page.main.querySelector('.run-head');
  assert.deepEqual(head.children.map((c: El) => c.className), ['run-head__crumb', 'run-head__title', 'run-head__metawrap', 'run-head__aside']);
  const aside = head.querySelector('.run-head__aside');
  assert.deepEqual(aside.children.map((c: El) => c.className), ['run-head__step', 'graph__back', 'run-head__acts'], 'Chain sits beside the step counter, in its grid area (IC-020); the place of Close run (162 IC-010) follows it');
  assert.deepEqual(linksOf(head), [['#/', 'Runs'], ['#/session/feat-a/run-1', 'Chain']]);
  assert.equal(text(page.main.querySelector('.run-head__step')), 'step 5 of 5', 'the step counter is unchanged');
  assert.equal(mods.views.parseRoute(head.querySelectorAll('a')[1].getAttribute('href')).id, 'session');
  uninstallPage();
  mock.timers.reset();

  mods.home.resetHome();
  const waiting = await start({ hash: '#/run/feat-a/run-1', fetch: (target, init) => (target === '/api/runs/feat-a/run-1' ? new Promise<Reply>(() => {}) : standard(target, init)) });
  assert.deepEqual(linksOf(waiting.main.querySelector('.run-head')), [['#/', 'Runs'], ['#/session/feat-a/run-1', 'Chain']], 'the link is there before the data, from the route params');
});

test('150 C.6 Tasks head: a Chain link follows Back to the run, on the board and on each no-graph note', async () => {
  mods.home.resetHome();
  const page = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(GRAPH_PLAN) });
  const top = page.main.querySelector('.graph__top');
  assert.deepEqual(linksOf(top), [['#/run/feat-a/run-1', '← Back to the run'], ['#/session/feat-a/run-1', 'Chain']]);
  assert.deepEqual(top.children.slice(0, 3).map((c: El) => c.className), ['graph__back', 'graph__back', 'graph__summary']);
  assert.equal(page.main.querySelector('.graph__back').getAttribute('href'), '#/run/feat-a/run-1', 'the first is still the way back');
  uninstallPage();
  mock.timers.reset();

  mods.home.resetHome();
  const empty = await start({ hash: '#/run/feat-a/run-1/tasks', fetch: graphRoute(() => null, () => ({ tasksReason: 'no-plan' })) });
  const note = empty.main.querySelector('.graph--empty');
  assert.deepEqual(linksOf(note), [['#/run/feat-a/run-1', '← Back to the run'], ['#/session/feat-a/run-1', 'Chain']]);
  assert.equal(empty.main.querySelector('.graph__board'), null);
});

test('150 C.6 palette: one session target per run, labelled slug / taskId with the hint Chain, as a hash from hashFor', async () => {
  await withFreshModules(async () => {
    const page = await start({ fetch: (target, init) => standard(target, init) });
    const before = page.calls.length;
    keydownOn(page, 'k', { ctrlKey: true });
    assert.deepEqual(paletteOptions(page), ['Now', 'Sessions', 'Layers', 'Follow-ups', 'Workflows', 'Workers', 'Advice', 'Settings', 'Health', 'More', 'feat-a / r1', 'feat-a / r2', 'feat-a / r3', 'feat-a / r4', 'feat-a / r5'], 'an empty query is unchanged: the screens, then the runs');
    paletteType(page, 'chain');
    const options = paletteOf(page).querySelectorAll('li');
    assert.deepEqual(options.map((li: El) => [text(li.querySelector('.palette__label')), text(li.querySelector('.palette__hint')), li.dataset.kind]),
      ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => [`feat-a / ${id}`, 'Chain', 'session']));
    paletteType(page, 'feat-a / r3');
    assert.deepEqual(paletteOf(page).querySelectorAll('li').map((li: El) => [li.dataset.kind, text(li.querySelector('.palette__hint'))]), [['run', 'Run · feature'], ['session', 'Chain']], 'the run target keeps its kind and hint');
    const input = paletteInput(page);
    input.fire('keydown', { key: 'ArrowDown' });
    input.fire('keydown', { key: 'Enter' });
    assert.equal(page.location.hash, '#/session/feat-a/r3');
    assert.equal(mods.views.parseRoute(page.location.hash).id, 'session');
    assert.equal(page.calls.length, before, 'the palette fetches nothing');
  });
});

// ---- the redesigned shell: the attention strip, the count on the Layers link, the More page ----

const goTo = (page: Page, hash: string) => { page.location.hash = hash; page.win.dispatch('hashchange'); };
const hiddenEl = (node: El) => node.getAttribute('hidden') !== null;
const strip = (page: Page) => page.doc.getElementById('attention');
const navLink = (page: Page, href: string) => page.doc.querySelectorAll('.navrail__link').find((a: El) => a.getAttribute('href') === href);

test('shell attention: gates waiting anywhere on the machine show on every page but Layers, with a count on the Layers link', async () => {
  const page = await startLayers('#/');
  assert.equal(hiddenEl(strip(page)), true, 'nothing is said before the first record');
  const es = await openedLayers(page, [gateOf('T-1', 'g-a', 'Approve the plan')]);
  assert.ok(channelsOf(es).includes('machine'), 'every page follows the machine channel');
  assert.equal(hiddenEl(strip(page)), false);
  assert.equal(strip(page).getAttribute('data-state'), 'awaiting');
  assert.equal(text(strip(page).querySelector('.attention__count')), '1 gate waiting for you');
  assert.equal(strip(page).querySelector('.attention__link').getAttribute('href'), '#/run/feat-a/T-1', 'one gate in this project: straight to its run');
  assert.equal(text(strip(page).querySelector('.attention__where')), 'on this machine, in this project', 'the strip counts the machine');
  assert.equal(text(page.main.querySelector('.view-head__meta')), 'Runs of example-project, the project this Console was started in.', 'Now names the one project it lists');
  assert.equal(text(navLink(page, '#/layers').querySelector('.navrail__badge')), '1 1 gate waiting for you');

  const two = machineBody([gateOf('T-2', 'g-b', null, 1), gateOf('T-1', 'g-a', 'Approve the plan')]);
  es.emit('message', liveFrame('machine', 'patch', { set: { '/machine/body/sections/activity': two.sections.activity } }));
  await settle();
  assert.equal(text(strip(page).querySelector('.attention__count')), '2 gates waiting for you');
  assert.equal(strip(page).querySelector('.attention__link').getAttribute('href'), '#/layers');

  goTo(page, '#/layers');
  await settle();
  assert.equal(hiddenEl(strip(page)), true, 'the Layers page leads with the same gates');
  assert.equal(text(navLink(page, '#/layers').querySelector('.navrail__badge')).startsWith('2'), true, 'the count stays on the link');

  const none = machineBody([]);
  es.emit('message', liveFrame('machine', 'patch', { set: { '/machine/body/sections/activity': none.sections.activity } }));
  goTo(page, '#/more');
  await settle();
  assert.equal(hiddenEl(strip(page)), true, 'a readable record with no gate says nothing');
  assert.equal(navLink(page, '#/layers').querySelector('.navrail__badge'), null);
});

test('162 review B-2: a record held after the stream dropped is never absent: zero gates read not observed since its time, and why', async () => {
  const page = await startLayers('#/');
  const es = await openedLayers(page, []);
  assert.equal(hiddenEl(strip(page)), true, 'a followed record with no gate says nothing');
  es.fail(0);
  await settle();
  assert.equal(hiddenEl(strip(page)), false, 'the held record is not read as clear');
  assert.equal(strip(page).getAttribute('data-state'), 'unknown');
  assert.match(text(strip(page).querySelector('.attention__count')), /^Waiting gates not observed since \d{2}:\d{2}/);
  assert.match(text(strip(page).querySelector('.attention__where')), /^the stream from the Console is down/);
  assert.doesNotMatch(text(strip(page)), /nothing|idle/i);
});

test('162 review B-8: the badge digit is hidden from a screen reader; the Layers link names the count once', async () => {
  const page = await startLayers('#/');
  await openedLayers(page, [gateOf('T-1', 'g-a', 'Approve the plan')]);
  const badge = navLink(page, '#/layers').querySelector('.navrail__badge');
  const digit = badge.querySelectorAll('span').find((node: El) => node.getAttribute('aria-hidden') === 'true');
  assert.ok(digit, 'the digit is aria-hidden');
  assert.equal(text(digit), '1');
  const spoken = badge.querySelectorAll('span').filter((node: El) => node.getAttribute('aria-hidden') !== 'true');
  assert.deepEqual(spoken.map((node: El) => text(node).trim()), ['1 gate waiting for you'], 'the count is said once, in words');
});

test('shell attention: without a stream the strip says the gates are not observed and why, never that nothing waits', async () => {
  const page = await startLayers('#/', 'absent');
  await advance(100);
  await settle();
  assert.equal(hiddenEl(strip(page)), false);
  assert.equal(strip(page).getAttribute('data-state'), 'unknown');
  assert.equal(text(strip(page).querySelector('.attention__count')), 'Waiting gates not observed');
  assert.match(text(strip(page).querySelector('.attention__where')), /^this browser cannot follow a stream/);
  assert.equal(navLink(page, '#/layers').querySelector('.navrail__badge'), null);
  assert.doesNotMatch(text(strip(page)), /nothing|idle/i);
});

test('the More page lists the Manage destinations and the records without a tab, holds the theme control and marks its own tab for a Manage page', async () => {
  const page = await start({ hash: '#/more', fetch: standard });
  await settle();
  assert.equal(text(page.main.querySelector('h1')), 'More');
  assert.deepEqual(page.main.querySelectorAll('.more__item').map((a: El) => [a.getAttribute('href'), text(a.querySelector('.more__label'))]), [
    ['#/followups', 'Follow-ups'], ['#/workflows', 'Workflows'], ['#/workers', 'Workers'], ['#/advice', 'Advice'], ['#/settings', 'Settings'], ['#/health', 'Health'],
    ['#/sessions/history', 'Session history'], ['#/compare', 'Compare runs'],
  ]);
  assert.ok(page.main.querySelectorAll('.more__hint').every((hint: El) => text(hint).length > 0), 'every destination says what it answers');
  assert.equal(navLink(page, '#/more').getAttribute('aria-current'), 'page');

  const radios = page.main.querySelectorAll('[data-theme-choice]');
  assert.deepEqual(radios.map((r: El) => r.getAttribute('data-theme-choice')), ['light', 'dark', 'system']);
  radios[1].fire('click');
  assert.equal(page.doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.deepEqual(page.doc.querySelectorAll('[data-theme-choice="dark"]').map((r: El) => r.getAttribute('aria-checked')), ['true', 'true'], 'the app bar control follows the page control');

  goTo(page, '#/settings');
  await settle();
  assert.equal(navLink(page, '#/settings').getAttribute('aria-current'), 'page');
  assert.equal(navLink(page, '#/more').getAttribute('aria-current'), 'true', 'on a phone More is the tab a Manage page sits under');
  goTo(page, '#/sessions');
  await settle();
  assert.equal(navLink(page, '#/more').getAttribute('aria-current'), null);
});

test('165: #/start parses, its hash round-trips, the Start link is current on it, and it has no other route shape', () => {
  const { parseRoute, hashFor, navFor, titleFor, VIEWS } = mods.views;
  const route = parseRoute('#/start');
  assert.equal(route.id, 'start');
  assert.equal(route.view, VIEWS.start);
  assert.equal(hashFor(route), '#/start');
  assert.deepEqual(parseRoute(hashFor(route)), route);
  assert.equal(navFor(route), 'start');
  assert.equal(titleFor(route), 'Start a session \u00b7 DoFlow Console');
  for (const hash of ['#/start/x', '#/start/', '#/starts']) assert.equal(parseRoute(hash).id, 'not-found', hash);
  assert.equal(VIEWS.start.inspectable, false);
  assert.deepEqual(VIEWS.start.shapes, [], 'the page reads /api/start, which no verb shape backs');
});

// ---- 165: the start view, the started-session node of Layers and "Started here" of Sessions -----------------------------------------

const RUN165 = 'w-0123456789ab';
const FILE_OUT = fk(0x71);
const FILE_ERR = fk(0x72);
const startedAgentKey = () => mods.start.agentKeyOf(RUN165);
const startedItem165 = (over: any = {}) => ({ runId: RUN165, harness: 'claude', model: null, phase: 'running', startedBy: 'console', worktreeKey: WK_MAIN, createdAt: AT(2), ...over });
const startedMachine = (items: any[] = [startedItem165()], count = items.length) => machineBody([], {
  activity: lok({ v: 1, limits: { projects: 2, notShown: 0, watched: 2, fingerprintOnly: 0 }, items: [
    { projectKey: P1, runs: { open: 0, awaiting: 0 }, gates: [], workers: { open: 0 }, sessions: { observed: 1, harnesses: ['claude'] }, unreadable: [], started: items, startedCount: count },
    { projectKey: P2, runs: { open: 0, awaiting: 0 }, gates: [], workers: { open: 0 }, sessions: { observed: 0, harnesses: [] }, unreadable: [] },
  ] }),
});
const startedNode = (over: any = {}) => lnode(startedAgentKey(), {
  kind: 'started-session', model: null, modelBasis: null, contextCapturedAt: null, startedAt: AT(2), lastRecordAt: AT(2), runId: RUN165, startedBy: 'console', phase: 'running', end: null, liveness: 'process-seen',
  fileKeys: { out: FILE_OUT, err: FILE_ERR }, observed: { state: 'not-observed', reason: 'not-yet-observed' }, transcript: { reader: null, linked: false, reason: 'no-reader' }, ...over,
});
const treeWith = (nodes: any[]) => ({ tree: lok({ v: 1, projectKey: P1, nodes, edges: [], limits: { nodes: nodes.length, notChecked: 0 }, unreadable: 0 }) });
const actions165 = (allowed: boolean, reason: string | null = null, actor: any = { kind: 'local', transport: 'loopback' }) => reply(200, {
  v: 1, actor, textMax: 500, limits: {}, project: { projectKey: P1, label: 'example-project' },
  actions: ['start-session', 'cancel-worker', 'decide-gate', 'close-run', 'session-send', 'session-steer', 'session-stop'].map((id) => ({ id, allowed, reason })),
});
const fileFrame = (fileKey: string, _id: string, pieces: any[], to: number) => ({ v: 1, ch: `file:${P1}:${fileKey}`, id: `4242:${to}:1:1`, type: 'snapshot', at: new Date(Date.now()).toISOString(), data: { log: 'open', ino: '4242', from: 0, to, pieces, phase: null, end: null } });

test('165 layers: a started session is one node in the orchestrator lane, titled started session, with its starter, "session not observed" and its reason', async () => {
  const page = await startLayers(`#/layers/${P1}`);
  await openedLayers(page, [], layersBody(treeWith([lnode(A_MAIN), startedNode()])));
  const rows = page.main.querySelectorAll('.lane')[0].querySelectorAll('.lrow--agent');
  assert.equal(rows.length, 2, 'the main session and the started session; no second node for the one run');
  const row = rows.find((r: El) => r.dataset.key === startedAgentKey());
  if (!row) throw new Error('the started row is missing');
  assert.match(text(row.querySelector('.lrow__link')), /started session/i);
  assert.equal(text(row.querySelector('[data-started-by="true"]')), 'started from the Console');
  assert.match(text(row.querySelector('.lrow__facts')), /session not observed: not seen yet/);
  assert.equal(page.main.querySelectorAll('.lane')[0].querySelectorAll('.lane__title').filter((t: El) => text(t) === 'Worker runs').length, 0, 'never a worker row');
});

test('165 layers: the pane of a started session follows its out and err file lanes, and End session opens the cancel-worker confirmation of the started-sessions store', async () => {
  const base = (target: string, init: any) => (target === '/api/actions' ? actions165(true)
    : target === '/api/actions/cancel-worker' ? reply(200, { v: 1, action: 'cancel-worker', requestId: 'x', outcome: 'applied', replayed: false, by: 'console', result: { runId: RUN165 } })
      : standard(target, init));
  const page = await startLayers(`#/layers/${P1}/agent/${startedAgentKey()}`, FakeES, base);
  await openedLayers(page, [], layersBody(treeWith([lnode(A_MAIN), startedNode()])));
  await settle();
  await advance(100);
  const channels = channelsOf(liveES());
  assert.ok(channels.includes(`file:${P1}:${FILE_OUT}`) && channels.includes(`file:${P1}:${FILE_ERR}`), `both output lanes are followed: ${channels}`);
  assert.equal(text(page.inspector.querySelector('.inspector__title')), 'Started session');
  const open = liveES();
  open.open();
  open.emit('message', fileFrame(FILE_OUT, '1', [{ at: 0, text: 'hello from the session' }], 22));
  await settle();
  assert.match(text(page.inspector.querySelectorAll('pre')[0]), /hello from the session/);
  assert.match(text(page.inspector), /masked/i);
  const stop = page.inspector.querySelector('.btn--act');
  assert.equal(text(stop), 'End session');
  stop.fire('click');
  const dialog = page.doc.body.querySelector('.confirm');
  assert.match(text(dialog.querySelector('.confirm__title')), new RegExp(`Stop worker ${RUN165}`));
  dialog.querySelector('.confirm__input').value = 'not needed';
  dialog.querySelector('.confirm__input').fire('input');
  dialog.querySelector('.confirm__verb').fire('click');
  await settle();
  const posts = page.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual({ ...posts[0].body, requestId: undefined }, { v: 1, projectKey: P1, slug: 'started-sessions', runId: RUN165, reason: 'not needed', requestId: undefined });
});

test('165 F2 layers: Stop comes from the node\'s own run id, with the machine list empty (a run past the newest eight still has it)', async () => {
  const base = (target: string, init: any) => (target === '/api/actions' ? actions165(true) : standard(target, init));
  const page = await startLayers(`#/layers/${P1}/agent/${startedAgentKey()}`, FakeES, base);
  const es = await openedLayers(page, [], layersBody(treeWith([lnode(A_MAIN), startedNode()])));
  es.emit('message', liveFrame('machine', 'patch', { set: { '/machine/body/sections/activity': startedMachine([], 20).sections.activity }, unset: [] }));
  await settle();
  assert.equal(page.inspector.querySelectorAll('.btn--act').length, 1);
  assert.doesNotMatch(text(page.inspector), /Stop is offered once/);
});

const END_CASES_165: Array<[any, RegExp]> = [
  [{ state: 'exited', exitCode: 0, reason: null }, /exited with code 0/], [{ state: 'exited', exitCode: 3, reason: null }, /exited with code 3/],
  [{ state: 'cancelled', exitCode: null, reason: null }, /was stopped/], [{ state: 'timed-out', exitCode: null, reason: null }, /passed its 3600 s limit/],
  [{ state: 'exited', exitCode: null, reason: 'prompt-unwritable' }, /did not start: its prompt could not be written/],
];
for (const [end, want] of END_CASES_165) {
  test(`165 F2 layers: an ended started session shows no Stop and words its end: ${JSON.stringify(end)}`, async () => {
    const base = (target: string, init: any) => (target === '/api/actions' ? actions165(true) : standard(target, init));
    const ended = await startLayers(`#/layers/${P1}/agent/${startedAgentKey()}`, FakeES, base);
    await openedLayers(ended, [], layersBody(treeWith([lnode(A_MAIN), startedNode({ phase: 'ended', ended: { at: AT(1), result: end.state }, end })])));
    await settle();
    assert.equal(ended.inspector.querySelectorAll('.btn--act').length, 0);
    assert.match(text(ended.inspector), want);
  });
}

// ---- 170 design §10: the turn badge, the message box and End session on the pane of a started session ----------------------------------

const turn170 = (state: 'working' | 'waiting') => ({ observed: true, state, since: AT(1), seq: 3 });
const chan170 = (over: any = {}) => ({
  runId: RUN165, agentKey: startedAgentKey(), harness: 'pi', channel: 'open', reason: null, words: null, turn: turn170('working'), sent: { count: 1, lastAt: AT(1) },
  recent: [{ seq: 3, kind: 'follow-up', by: 'console', at: AT(1), bytes: 41, outcome: 'written', answer: 'accepted' }], ...over,
});
const applied170 = (action: string) => reply(200, { v: 1, action, requestId: 'x', outcome: 'applied', replayed: false, by: 'console', result: { runId: RUN165 } });
const VIEW_DEVICE = { kind: 'device', deviceId: 'd-0a1b2c3d4e5f', scope: 'view', transport: 'browser' };
/** The Layers pane of the started session with `item` in its `channels` section (null: the section holds no entry for the run). */
async function pane170(item: any, how: { actions?: Reply, node?: any, post?: (target: string, init: any) => Reply } = {}) {
  const base = (target: string, init: any) => (target === '/api/actions' ? how.actions ?? actions165(true)
    : target === '/api/actions/cancel-worker' ? applied170('cancel-worker')
      : target.startsWith('/api/actions/session-') ? (how.post ? how.post(target, init) : applied170(target.slice('/api/actions/'.length)))
        : standard(target, init));
  const page = await startLayers(`#/layers/${P1}/agent/${startedAgentKey()}`, FakeES, base);
  const body = (it: any) => layersBody({ ...treeWith([lnode(A_MAIN), startedNode(how.node ?? {})]), channels: lok({ v: 1, items: it === null ? [] : [it] }) });
  const es = await openedLayers(page, [], body(item));
  await settle();
  return { page, es, body };
}
const button170 = (page: Page, label: string) => page.inspector.querySelectorAll('button').find((b: El) => text(b) === label);
const labels170 = (page: Page) => page.inspector.querySelectorAll('button').map((b: El) => text(b)).filter((t: string) => t !== 'Close details');
const off170 = (b: El) => b.getAttribute('disabled') !== null;
const type170 = (page: Page, value: string) => { const area = page.inspector.querySelector('textarea'); area.value = value; area.fire('input'); };

test('170 layers pane, open and working: badge "Working"; Send, Steer, Stop turn and End session; Send and Steer wait for text; Send posts the message with a fresh request id', async () => {
  const { page } = await pane170(chan170());
  assert.match(text(page.inspector.querySelector('[data-fact="turn"]')), /Working/);
  assert.deepEqual(labels170(page), ['Send', 'Steer', 'Stop turn', 'End session']);
  assert.deepEqual(['Send', 'Steer', 'Stop turn'].map((l) => off170(button170(page, l)!)), [true, true, false], 'no text: Send and Steer are shut');
  type170(page, 'Also run the lint');
  assert.deepEqual(['Send', 'Steer', 'Stop turn'].map((l) => off170(button170(page, l)!)), [false, false, false]);
  button170(page, 'Send')!.fire('click');
  const dialog = page.doc.body.querySelector('.confirm');
  assert.equal(dialog.querySelector('.confirm__field').getAttribute('hidden'), '', 'the box holds the text; the dialog has no field');
  dialog.querySelector('.confirm__verb').fire('click');
  await settle();
  const posts = page.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/api\/actions\/session-send$/);
  assert.match(posts[0].body.requestId, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual({ ...posts[0].body, requestId: undefined }, { v: 1, projectKey: P1, runId: RUN165, message: 'Also run the lint', requestId: undefined });
  assert.equal(page.inspector.querySelector('textarea').value, '', 'an applied send empties the box');
  const recent = text(page.inspector.querySelector('[data-fact="recent-messages"]'));
  assert.match(recent, /Send.*Console.*41 B.*accepted/);
  assert.doesNotMatch(recent, /Also run the lint/, 'a recent message shows kind, who, size and result, never its text');
});

test('170 review A-07: a pending answer says "waiting to be taken" and keeps the text in the box; the replay of the same request id that answers written gives the final state and empties it', async () => {
  const message = (state: string) => ({ seq: state === 'pending' ? null : 3, kind: 'follow-up', state, answer: state === 'pending' ? null : 'accepted', at: AT(1), bytes: 17 });
  const answers = ['pending', 'written'];
  const { page } = await pane170(chan170(), { post: (target) => reply(200, { v: 1, action: 'session-send', requestId: 'x', outcome: 'applied', replayed: answers.length === 1, by: 'console', result: { replayed: answers.length === 1, message: message(answers.shift()!), turn: turn170('working'), channel: 'open' } }) });
  type170(page, 'Also run the lint');
  button170(page, 'Send')!.fire('click');
  page.doc.body.querySelector('.confirm__verb').fire('click');
  await settle();
  assert.match(text(page.doc.body.querySelector('.confirm__result')), /^Waiting to be taken/);
  assert.equal(page.inspector.querySelector('textarea').value, 'Also run the lint', 'a pending message keeps its text');
  assert.match(text(page.inspector.querySelector('[data-fact="message-pending"]')), /^Waiting to be taken/);
  page.doc.body.querySelectorAll('.confirm').forEach((d: El) => d.remove());
  button170(page, 'Send')!.fire('click');
  page.doc.body.querySelector('.confirm__verb').fire('click');
  await settle();
  const posts = page.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.requestId, posts[0].body.requestId, 'the same request id, so the replay says what became of it');
  assert.match(text(page.doc.body.querySelector('.confirm__result')), /^Sent\./);
  assert.equal(page.inspector.querySelector('textarea').value, '', 'the final state empties the box');
  assert.equal(page.inspector.querySelector('[data-fact="message-pending"]').getAttribute('hidden'), '');
});

test('170 layers pane, Steer posts session-steer with the message, Stop turn posts session-stop with no message, and End session is the separate cancel-worker confirmation', async () => {
  const { page } = await pane170(chan170());
  type170(page, 'Use the other branch');
  button170(page, 'Steer')!.fire('click');
  page.doc.body.querySelector('.confirm__verb').fire('click');
  await settle();
  button170(page, 'Stop turn')!.fire('click');
  assert.match(text(page.doc.body.querySelector('.confirm__title')), /^Stop turn session w-/);
  page.doc.body.querySelector('.confirm__verb').fire('click');
  await settle();
  const posts = page.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map((c) => c.url.replace(/^.*\/api\/actions\//, '')), ['session-steer', 'session-stop']);
  assert.deepEqual({ ...posts[0].body, requestId: undefined }, { v: 1, projectKey: P1, runId: RUN165, message: 'Use the other branch', requestId: undefined });
  assert.deepEqual({ ...posts[1].body, requestId: undefined }, { v: 1, projectKey: P1, runId: RUN165, requestId: undefined }, 'Stop turn carries no message');
  page.doc.body.querySelectorAll('.confirm').forEach((d: El) => d.remove());
  button170(page, 'End session')!.fire('click');
  assert.match(text(page.doc.body.querySelector('.confirm__title')), new RegExp(`Stop worker ${RUN165}`), 'End session is the cancel-worker confirmation, not session-stop');
});

test('170 layers pane, open and waiting: "Waiting for you"; Send stays on, Steer says "it is waiting: send instead", Stop turn is shut', async () => {
  const { page } = await pane170(chan170({ turn: turn170('waiting') }));
  assert.match(text(page.inspector.querySelector('[data-fact="turn"]')), /Waiting for you/);
  type170(page, 'Yes, go on');
  assert.deepEqual(['Send', 'Steer', 'Stop turn'].map((l) => off170(button170(page, l)!)), [false, true, true]);
  assert.match(text(page.inspector.querySelector('[data-fact="message-box"]')), /it is waiting: send instead/);
  assert.ok(button170(page, 'End session'));
});

test('170 layers pane, not observed: the reason in words with every button on; a supervisor that stopped disables Send and says End it with End session', async () => {
  const seen = await pane170(chan170({ turn: { observed: false, reason: 'message-refused', since: null } }));
  assert.match(text(seen.page.inspector.querySelector('[data-fact="turn"]')), /^Not observed: its last message was refused/);
  type170(seen.page, 'hello');
  assert.deepEqual(['Send', 'Steer', 'Stop turn'].map((l) => off170(button170(seen.page, l)!)), [false, false, false]);
  mock.timers.reset();
  uninstallPage();
  const gone = await pane170(chan170({ turn: { observed: false, reason: 'supervisor-gone', since: null } }));
  assert.match(text(gone.page.inspector.querySelector('[data-fact="turn"]')), /Not observed: its supervisor stopped\. End it with End session\./);
  type170(gone.page, 'hello');
  assert.equal(off170(button170(gone.page, 'Send')!), true);
  assert.ok(button170(gone.page, 'End session'));
});

test('170 layers pane, no channel: "Send is unavailable: <reason>" and End session only; an ended or closed one says "Ended: <why>" with no button', async () => {
  const none = await pane170(chan170({ channel: 'none', reason: 'no-channel', words: 'the harness reads one prompt only.', turn: { observed: false, reason: 'no-channel', since: null }, recent: [] }));
  assert.match(text(none.page.inspector.querySelector('[data-fact="channel-note"]')), /^Send is unavailable: the harness reads one prompt only$/);
  assert.deepEqual(labels170(none.page), ['End session']);
  mock.timers.reset();
  uninstallPage();
  const closed = await pane170(chan170({ channel: 'closed', reason: 'unused-timeout', turn: { observed: false, reason: 'run-ended', since: AT(0) } }), { node: { phase: 'ended', ended: { at: AT(0), result: 'cancelled' }, end: { state: 'cancelled', exitCode: null, reason: null } } });
  assert.match(text(closed.page.inspector.querySelector('[data-fact="turn"]')), /^Ended: /);
  assert.deepEqual(labels170(closed.page), []);
});

test('170 layers pane, a view device sees the badge and the replies and the words that sending needs control; no button; a core without the channels section shows End session only', async () => {
  const view = await pane170(chan170(), { actions: actions165(false, 'phone-scope', VIEW_DEVICE) });
  assert.match(text(view.page.inspector.querySelector('[data-fact="turn"]')), /Working/);
  assert.match(text(view.page.inspector.querySelector('[data-fact="channel-note"]')), /^Sending needs this machine’s Console or a phone paired with control over the app\.$/);
  assert.deepEqual(labels170(view.page), []);
  assert.equal(view.page.inspector.querySelector('textarea'), null, 'no box for a device that cannot send');
  assert.equal(view.page.calls.filter((c) => c.method === 'POST').length, 0);
  mock.timers.reset();
  uninstallPage();
  const old = await pane170(null);
  assert.match(text(old.page.inspector.querySelector('[data-fact="turn"]')), /^Not observed: the Console holds no channel record/);
});

test('170 layers pane: the typed message and the focus survive a new snapshot that changes the turn', async () => {
  const { page, es, body } = await pane170(chan170());
  type170(page, 'half a thought');
  const area = page.inspector.querySelector('textarea');
  area.focus();
  es.emit('message', liveFrame(`layers:${P1}`, 'snapshot', member('layers', body(chan170({ turn: turn170('waiting') })))));
  await settle();
  assert.match(text(page.inspector.querySelector('[data-fact="turn"]')), /Waiting for you/);
  assert.equal(page.inspector.querySelector('textarea').value, 'half a thought');
  assert.equal(page.doc.activeElement, page.inspector.querySelector('textarea'));
});

test('170 start flow panel: the same badge, message box and End session under the run, fed by the layers member; the harness row says whether it can be talked to', async () => {
  const withChannel = (state: string, reason: string | null, extra: any = {}) => ({ state, reason, liveVerified: state === 'supported' && extra.liveVerified !== false, unverified: extra.unverified ?? [] });
  const options = options165({ harnesses: [
    harness165('claude', { channel: withChannel('supported', null) }),
    harness165('opencode', { channel: withChannel('supported', null, { liveVerified: false, unverified: ['no live run recorded'] }) }),
    harness165('codex', { channel: withChannel('unsupported', 'the harness reads one prompt only.'), startable: true, reason: null }),
  ] });
  const page = await startPage165({ options, post: () => applied165() });
  const rows = page.main.querySelectorAll('[data-fact="channel"]').map((n: El) => text(n));
  assert.deepEqual(rows, ['You can talk to it while it runs.', 'You can talk to it while it runs.', 'Runs one prompt; Send is unavailable: the harness reads one prompt only.']);
  assert.match(text(page.main.querySelector('[data-warning="channel-not-verified-live"]')), /^Talking to it is not verified on a live run: no live run recorded/);
  await fill165(page);
  page.main.querySelector('#start-submit').fire('click');
  page.doc.body.querySelector('.confirm__verb').fire('click');
  await settle();
  await advance(100);
  const live = liveES();
  live.open();
  live.emit('message', liveFrame(`layers:${P1}`, 'snapshot', member('layers', layersBody({ ...treeWith([startedNode()]), channels: lok({ v: 1, items: [chan170()] }) }))));
  await settle();
  const flow = page.main.querySelector('.start__flow');
  assert.match(text(flow.querySelector('[data-fact="turn"]')), /Working/);
  assert.deepEqual(flow.querySelectorAll('button').map((b: El) => text(b)).filter((t: string) => ['Send', 'Steer', 'Stop turn', 'End session'].includes(t)), ['Send', 'Steer', 'Stop turn', 'End session']);
});

test('165 sessions: "Started here" lists the sessions started in the project with a Layers link each; a core that reports none says so, and nothing shows before the machine member arrives', async () => {
  const page = await startLive('#/sessions', liveRoute(sessionsRoute(BUSY)));
  assert.equal(page.main.querySelectorAll('.started-here').length, 0, 'nothing before the machine member');
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('machine', 'snapshot', member('machine', startedMachine([startedItem165(), startedItem165({ runId: 'w-0123456789ac', harness: 'codex', model: 'gpt-x', phase: 'starting', startedBy: 'device.d-0123456789ab' })], 10))));
  await settle();
  const rows = page.main.querySelectorAll('.started-here__row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.started-here__link').getAttribute('href'), `#/layers/${P1}/agent/${startedAgentKey()}`);
  assert.match(text(rows[0]), /claude.*started by console.*process seen/);
  assert.match(text(rows[1]), /codex.*gpt-x.*started by device\.d-0123456789ab.*starting/);
  assert.match(text(page.main.querySelector('.started-here')), /8 older sessions are not listed/);
  assert.equal(text(page.main.querySelector('.started-here__title')), 'Sessions started in this project');
  es.emit('message', liveFrame('machine', 'patch', { set: { '/machine/body/sections/activity': machineBody([], { activity: lok({ v: 1, limits: {}, items: [{ projectKey: P1, runs: { open: 0, awaiting: 0 }, gates: [], workers: { open: 0 }, sessions: { observed: 0, harnesses: [] }, unreadable: [] }] }) }).sections.activity }, unset: [] }));
  await settle();
  assert.match(text(page.main.querySelector('.started-here')), /does not report the sessions started in this project/);
});

test('165 review B-4: Sessions lists an ended started session with how and when it ended and who started it; the empty words show only when the store holds none', async () => {
  const page = await startLive('#/sessions', liveRoute(sessionsRoute(BUSY)));
  await advance(100);
  const es = liveES();
  es.open();
  es.emit('message', liveFrame('machine', 'snapshot', member('machine', startedMachine([
    startedItem165({ startedBy: 'manual', end: null }),
    startedItem165({ runId: 'w-0123456789ac', phase: 'ended', startedBy: 'device.d-0123456789ab', end: { state: 'cancelled', at: AT(3) } }),
  ], 2))));
  await settle();
  const rows = page.main.querySelectorAll('.started-here__row');
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /started by terminal.*process seen/);
  assert.match(text(rows[1]), /started by device\.d-0123456789ab.*ended: stopped/);
  assert.equal(page.main.querySelectorAll('.started-here__none').length, 0, 'no empty words while the store holds sessions');
  es.emit('message', liveFrame('machine', 'snapshot', member('machine', startedMachine([], 0))));
  await settle();
  assert.equal(text(page.main.querySelector('.started-here__none')).startsWith('No session has been started in this project, from the Console, a paired device or a terminal.'), true);
});

const WORDS165 = { claude: 'claude can start a session here', opencode: 'opencode can start a session here', codex: 'codex is logged out. Run codex login, then read this page again.', copilot: 'copilot has no recorded way to start a main session, so it is not offered.' };
/** 169 IC-007: a start-options model entry. */
const model165 = (model: string | null, source: string, over: any = {}) => ({ model, provider: null, effort: null, source, check: model === null ? null : { model: 'unchecked', effort: null }, ...over });
const harness165 = (name: string, over: any = {}) => ({ harness: name, startable: true, reason: null, words: (WORDS165 as any)[name], warnings: ['runnable-not-checked'], login: { harness: name, state: 'logged-in', reason: null, source: 'recipe', at: AT(5), billing: null, providers: [], provider: null, hint: null, expirySeen: false, last: null, caveat: null }, version: '1.0.0', models: [model165(null, 'default')], ...over });
const options165 = (over: any = {}) => ({
  v: 1, project: { projectKey: P1, label: 'example-project', root: null },
  checkouts: [{ worktreeKey: WK_MAIN, label: 'do-flow', branch: 'develop', main: true, busy: null, observedSession: null }],
  harnesses: [
    harness165('claude', { models: [model165(null, 'default'), model165('claude-haiku-5', 'light'), model165('claude-sonnet-5', 'standard'), model165('claude-opus-5-5', 'orchestrator'), model165('claude-seen', 'observed')] }),
    harness165('opencode', { warnings: ['prompt-in-argv', 'login-unknown'] }),
    harness165('codex', { startable: false, reason: 'logged-out', warnings: [] }),
    harness165('copilot', { startable: false, reason: 'no-main-session-shape', warnings: [], login: null }),
  ],
  limits: { perCheckout: 1, perActor: 2, machine: 4, perActorPerHour: 6 }, open: { machine: 0 }, dispatch: { running: false }, promptMax: { codePoints: 8000, bytes: 32768 },
  entries: ['do', 'none'], entryLine: 'Use the DoFlow do skill for the request in input.', ...over,
});
function route165(state: { options?: any, actions?: Reply, post?: (init: any) => Reply | 'network' } = {}) {
  return (target: string, init: any): Reply | 'network' | Promise<Reply> => {
    if (target === '/api/start') return reply(200, { v: 1, projects: [{ projectKey: P1, label: 'example-project', current: true }], truncated: false });
    if (target.startsWith('/api/start/options')) return reply(200, state.options ?? options165());
    if (target === '/api/actions') return state.actions ?? actions165(true);
    if (target === '/api/actions/start-session') return state.post ? state.post(init) : reply(500);
    if (target.startsWith('/api/live')) return reply(500);
    return standard(target, init);
  };
}
async function startPage165(state: Parameters<typeof route165>[0] = {}): Promise<Page> {
  FakeES.all = [];
  liveSeq = 0;
  const page = await start({ hash: '#/start', fetch: route165(state), eventSource: FakeES }, freshWeb());
  await settle();
  return page;
}
const radios165 = (page: Page, name: string) => page.main.querySelectorAll('input').filter((i: El) => i.getAttribute('name') === name);
const run165 = (over: any = {}) => ({ runId: RUN165, kind: 'main-session', phase: 'running', harness: 'claude', model: null, modelSource: 'default', worktreeKey: WK_MAIN, startedBy: 'console', createdAt: AT(0), agentKey: startedAgentKey(), layers: `#/layers/${P1}`, files: { out: FILE_OUT, err: FILE_ERR }, ...over });
const applied165 = (run = run165()) => reply(200, { v: 1, action: 'start-session', requestId: 'x', outcome: 'applied', replayed: false, by: 'console', result: { replayed: false, run } });
async function fill165(page: Page, harness = 'claude', prompt = 'Fix the failing test') {
  radios165(page, 'start-harness').find((i: El) => i.getAttribute('value') === harness)!.fire('change');
  await settle();
  const area = page.main.querySelector('textarea');
  area.value = prompt;
  area.fire('input');
}

test('165 start: a device that may not start gets the explanation and the terminal command as text, no form and no button', async () => {
  const page = await startPage165({ actions: actions165(false, 'phone-scope', { kind: 'device', deviceId: 'd-0a1b2c3d4e5f', scope: 'view', transport: 'browser' }) });
  assert.match(text(page.main), /Starting a session needs this machine’s Console or a phone paired with control over the app/);
  // 165 review B-3: the whole command from the form's choices (the project, its one free checkout, the do entry) and a request id; the
  // harness nobody chose is the reference's placeholder.
  assert.match(text(page.main.querySelector('.cmd__text')), new RegExp(`^doflow worker --action start-session --project-key ${P1} --worktree-key ${WK_MAIN} --harness <id> --entry do --request-id [A-Za-z0-9][A-Za-z0-9_-]{21} --stdin$`));
  assert.equal(page.main.querySelectorAll('button').filter((b: El) => /^Start$/.test(text(b))).length, 0);
  assert.equal(page.main.querySelectorAll('input').length, 0);
  assert.equal(page.calls.filter((c) => c.method === 'POST').length, 0);
});

test('165 start: nothing is preselected; the harnesses that cannot start are listed with the core’s words; the argv warning shows before a choice; models are grouped in the owner’s order; Start waits for the form', async () => {
  const page = await startPage165();
  assert.equal(page.main.querySelector('h1') && text(page.main.querySelector('h1')), 'Start a session');
  assert.deepEqual(radios165(page, 'start-harness').map((i: El) => i.getAttribute('value')), ['claude', 'opencode'], 'only a startable harness is a choice');
  assert.deepEqual(radios165(page, 'start-harness').map((i: El) => i.getAttribute('checked')), [null, null], 'no harness is preselected');
  assert.deepEqual(page.main.querySelector('.start__blocked-list').children.map((li: El) => [li.dataset.harness, li.dataset.reason, text(li).includes((WORDS165 as any)[li.dataset.harness])]), [['codex', 'logged-out', true], ['copilot', 'no-main-session-shape', true]]);
  assert.match(text(page.main.querySelector('[data-warning="prompt-in-argv"]')), /process list/);
  assert.match(text(page.main.querySelector('[data-fact="permission"]')), /own permission settings.*nobody can give it here/);
  assert.equal(radios165(page, 'start-checkout').length, 1);
  assert.equal(radios165(page, 'start-checkout')[0].getAttribute('checked'), '', 'the one free checkout is the only choice made for the person');
  assert.deepEqual(radios165(page, 'start-entry').map((i: El) => [i.getAttribute('value'), i.getAttribute('checked')]), [['do', ''], ['none', null]]);
  assert.match(text(page.main), /Start with DoFlow's do skill/);
  assert.match(text(page.main), /Send my text only/);
  assert.equal(page.main.querySelector('#start-submit').getAttribute('disabled'), '', 'Start waits for a harness and a text');
  await fill165(page, 'claude', '');
  assert.deepEqual(page.main.querySelectorAll('optgroup').map((g: El) => g.getAttribute('label')), ['Orchestrator', 'Standard', 'Light', 'Seen in use', 'Harness default']);
  const area = page.main.querySelector('textarea');
  area.value = 'Fix the failing test';
  area.fire('input');
  assert.equal(text(page.main.querySelector('#start-count')), '20 / 8000');
  assert.equal(page.main.querySelector('#start-submit').getAttribute('disabled'), null, 'a harness, a checkout and a text: Start opens');
  area.value = '-rf';
  area.fire('input');
  assert.equal(text(page.main.querySelector('#start-issue')), '', 'a text starting with a dash is fine for claude with the do entry');
  assert.equal(page.main.querySelector('#start-submit').getAttribute('disabled'), null);
  await fill165(page, 'opencode', '-rf');
  assert.match(text(page.main.querySelector('#start-issue')), /starts with “-”/, 'opencode takes the prompt as an argument: a leading dash is refused whatever the entry');
  assert.equal(page.main.querySelector('#start-submit').getAttribute('disabled'), '');
});

test('169 start: options are labelled with bindingText and keyed by their triple; the note under the select says the notes in words; a refused option is disabled with its reason; the chosen triple is posted and shown in the terminal command', async () => {
  const entries = [
    model165(null, 'default'),
    model165('gpt-y', 'standard', { provider: 'openai', effort: 'low', check: { model: 'listed', effort: 'unchecked' }, effortMayLower: true }),
    model165('gpt-y', 'light', { check: { model: 'several-providers', effort: null } }),
    model165('gpt-q', 'observed', { effort: 'high', check: { model: 'listed', effort: 'listed' }, refused: 'effort:unsupported' }),
  ];
  const page = await startPage165({ options: options165({ harnesses: [harness165('claude', { models: entries }), harness165('opencode')] }), post: () => applied165() });
  assert.equal(text(page.main.querySelector('#start-model')), 'Choose a harness first');
  assert.equal(page.main.querySelector('#start-modelnote').getAttribute('hidden'), '', 'no note before a harness is chosen');
  await fill165(page);
  const select = page.main.querySelector('#start-model');
  const optionOf = (label: string) => select.querySelectorAll('option').find((o: El) => text(o) === label)!;
  assert.deepEqual(select.querySelectorAll('option').map((o: El) => text(o)), [
    'gpt-y (provider openai, effort low) [effort unchecked, the harness may lower the effort]',
    'gpt-y [several providers list it]',
    'gpt-q (effort high) [cannot start: effort:unsupported]',
    'Harness default',
  ]);
  assert.equal(optionOf('gpt-q (effort high) [cannot start: effort:unsupported]').getAttribute('disabled'), '');
  assert.equal(optionOf('Harness default').getAttribute('selected'), '', 'the harness default is the choice once a harness is picked');
  const note = () => page.main.querySelector('#start-modelnote');
  assert.equal(text(note()), 'The harness picks its own model and effort.');
  const bound = optionOf('gpt-y (provider openai, effort low) [effort unchecked, the harness may lower the effort]');
  select.value = bound.getAttribute('value') ?? '';
  select.fire('change');
  await settle();
  assert.equal(text(page.main.querySelector('#start-modelnote')), '? effort unchecked, the harness may lower the effort.');
  page.main.querySelector('#start-submit').fire('click');
  const dialog = page.doc.body.querySelector('.confirm');
  assert.match(text(dialog.querySelector('.confirm__effect')), /^Start claude \(gpt-y \(provider openai, effort low\) \[effort unchecked, the harness may lower the effort\]\) in /);
  dialog.querySelector('.confirm__verb').fire('click');
  await settle();
  const posts = page.calls.filter((c) => c.method === 'POST');
  assert.deepEqual([posts[0].body.model, posts[0].body.provider, posts[0].body.effort], ['gpt-y', 'openai', 'low']);
});

test('165 review B-8: a startable harness whose main session was not verified on a live run shows one line saying so; a verified one does not', async () => {
  const page = await startPage165({ options: options165({ harnesses: [harness165('claude', { liveVerified: false }), harness165('opencode', { liveVerified: true, warnings: [] })] }) });
  const lines = page.main.querySelectorAll('[data-fact="live-verified"]');
  assert.equal(lines.length, 1);
  assert.equal(text(lines[0]), 'not yet verified on a live run');
  assert.equal(lines[0].closest('label')!.querySelector('input').getAttribute('value'), 'claude');
});

test('165 start: a start through the dialog posts the body once, then shows Running with no output yet, Streaming once the out lane writes, and Ended with its words', async () => {
  const page = await startPage165({ post: () => applied165() });
  await fill165(page);
  page.main.querySelector('#start-submit').fire('click');
  const dialog = page.doc.body.querySelector('.confirm');
  assert.ok(dialog, 'the existing confirm dialog opens');
  assert.equal(dialog.querySelector('.confirm__field').getAttribute('hidden'), '', 'it has no field of its own: the form holds the text');
  dialog.querySelector('.confirm__verb').fire('click');
  await settle();
  const posts = page.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/api\/actions\/start-session$/);
  assert.match(posts[0].body.requestId, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual({ ...posts[0].body, requestId: undefined }, { v: 1, projectKey: P1, worktreeKey: WK_MAIN, harness: 'claude', model: null, provider: null, effort: null, entry: 'do', prompt: 'Fix the failing test', requestId: undefined });
  assert.match(text(page.main.querySelector('.start__flow-title')), /^.\s?Running: claude in example-project \/ do-flow/);
  assert.match(text(page.main.querySelector('.start__flow')), /No output yet/);
  assert.equal(page.main.querySelectorAll('textarea').length, 0, 'the form is out of the way while a session runs');
  await advance(100);
  const channels = channelsOf(liveES());
  assert.ok(channels.includes(`file:${P1}:${FILE_OUT}`) && channels.includes(`file:${P1}:${FILE_ERR}`) && channels.includes(`layers:${P1}`), `the lanes and the node are followed: ${channels}`);
  const live = liveES();
  live.open();
  live.emit('message', fileFrame(FILE_OUT, '1', Array.from({ length: 250 }, (_, i) => ({ at: i * 8, text: `out ${i}` })), 2000));
  await settle();
  assert.match(text(page.main.querySelector('.start__flow')), /the last 200 lines/);
  const out = text(page.main.querySelectorAll('pre')[0]);
  assert.ok(out.startsWith('out 50\n') && out.endsWith('out 249'), 'the last 200 lines');
  assert.match(text(page.main.querySelector('.start__flow')), /End session/);
  live.emit('message', liveFrame(`layers:${P1}`, 'snapshot', member('layers', layersBody(treeWith([startedNode({ phase: 'ended', ended: { at: AT(0), result: 'timed-out' }, end: { state: 'timed-out', exitCode: null, reason: null } })])))));
  await settle();
  assert.match(text(page.main.querySelector('.start__flow-title')), /Ended: claude/);
  assert.match(text(page.main.querySelector('.start__flow')), /passed its 3600 s limit/);
  assert.equal(page.main.querySelectorAll('.btn--act').filter((b: El) => /End session/.test(text(b))).length, 0);
  assert.ok(String(page.main.querySelector('.layers-link')?.getAttribute('href')).startsWith(`#/layers/${P1}/agent/`));
});

test('165 start: a refusal says its reason in words, keeps the form with what was typed and reads the options again; a 504 keeps the request id for the retry; a new submit gets a new one', async () => {
  const answers: Array<Reply | 'network'> = [reply(409, { error: { code: 'checkout-busy', verb: 'worker', exit: 1 }, current: { runId: RUN165 } }), reply(504, { error: { code: 'action-timeout', verb: 'worker', exit: null } }), reply(504, { error: { code: 'action-timeout', verb: 'worker', exit: null } }), applied165()];
  const page = await startPage165({ post: () => answers.shift()! });
  await fill165(page);
  const submit = async () => { page.main.querySelector('#start-submit').fire('click'); const d = page.doc.body.querySelector('.confirm'); d.querySelector('.confirm__verb').fire('click'); await settle(); return d; };
  let dialog = await submit();
  assert.match(text(dialog.querySelector('.confirm__result')), /A started session is already open in this checkout.*Nothing was started/);
  dialog.querySelector('.confirm__cancel').fire('click');
  await settle();
  assert.equal(text(page.main.querySelector('textarea')), 'Fix the failing test', 'the form kept the text');
  assert.equal(apiCalls(page, '/api/start/options').length, 2, 'the options were read again');
  assert.match(text(page.main.querySelector('.start__flow')), /The session did not start/);
  dialog = await submit();
  assert.match(text(dialog.querySelector('.confirm__result')), /No answer; check Sessions before trying again/);
  dialog.querySelector('.confirm__cancel').fire('click');
  await settle();
  const first = page.calls.filter((c) => c.method === 'POST').map((c) => c.body.requestId);
  dialog = await submit();
  dialog.querySelector('.confirm__cancel').fire('click');
  await settle();
  const posts = page.calls.filter((c) => c.method === 'POST').map((c) => c.body.requestId);
  assert.notEqual(posts[0], posts[1], 'a new submit after a refusal is a new request');
  assert.equal(posts[1], posts[2], 'the retry of an unanswered start reuses its id');
  assert.equal(first.length, 2);
});

test('165 start: a prompt over the limit turns the count red and keeps Start shut; the do entry and the text-only entry are both offered; Copilot is never a choice', async () => {
  const page = await startPage165();
  await fill165(page, 'claude', 'x'.repeat(8001));
  assert.equal(text(page.main.querySelector('#start-count')), '8001 / 8000');
  assert.equal(page.main.querySelector('#start-count').dataset.over, 'true');
  assert.equal(page.main.querySelector('#start-submit').getAttribute('disabled'), '');
  assert.equal(radios165(page, 'start-harness').some((i: El) => i.getAttribute('value') === 'copilot'), false);
});
