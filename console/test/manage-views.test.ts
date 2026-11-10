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
    stream: await import(url('stream.js')),
    fleet: await import(url('derive/fleet.js')),
    derive: await import(url('derive/rail.js')),
    home: await import(url('views/home.js')),
    railView: await import(url('views/rail.js')),
    shell: await import(url('shell.js')),
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
  const link = (href: string, text: string) => el('a', { class: 'nav__link navrail__link', href }, [el('span', { class: 'navrail__label' }, [text])]);
  const radio = (choice: string) => el('button', { type: 'button', role: 'radio', class: 'theme__opt', 'aria-checked': 'false', tabindex: '-1', 'data-theme-choice': choice }, [el('span', { class: 'theme__label' }, [choice])]);
  const skip = el('a', { class: 'skip', href: '#main' }, ['Skip to content']);
  const nav = [link('#/', 'Now'), link('#/sessions', 'Sessions'), link('#/workflows', 'Workflows'), link('#/fleet', 'Fleet'), link('#/workers', 'Workers'), link('#/advice', 'Advice'), link('#/followups', 'Follow-ups'), link('#/settings', 'Settings'), link('#/health', 'Health')]; // 149 D.1: the fake page mirrors index.html's rail
  const radios = ['light', 'dark', 'system'].map(radio);
  const conn = el('p', { class: 'conn', id: 'conn', 'data-state': 'unknown' }, [el('span', { class: 'conn__long' }, ['Connecting']), el('span', { class: 'conn__short' }, ['Connecting'])]);
  const pause = el('button', { type: 'button', class: 'btn btn--ghost pause', id: 'pause', 'aria-pressed': 'false', hidden: '' }, [el('span', { class: 'pause__label' }, ['Pause updates'])]);
  const region = el('div', { class: 'vh', id: 'announcer' });
  const main = el('main', { id: 'main', class: 'page', tabindex: '-1' });
  const slot = el('div', { id: 'banner-slot' });
  const inspector = el('aside', { id: 'inspector', class: 'inspector', 'aria-label': 'Details', hidden: '' }, [
    el('div', { class: 'inspector__head' }, [el('h2', { class: 'inspector__title', id: 'inspector-title' }, ['Details']),
      el('button', { type: 'button', class: 'btn btn--ghost inspector__close' }, [el('span', { class: 'vh' }, ['Close details'])])]),
    el('p', { class: 'inspector__empty' }, ['Select an item to see its details here.']),
    el('div', { class: 'inspector__body' }),
  ]);
  const shell = el('div', { class: 'shell', id: 'shell', 'data-inspectable': 'false' }, [
    el('nav', { class: 'nav navrail', 'aria-label': 'Primary' }, [el('ul', {}, nav.map((a) => el('li', {}, [a])))]), main, inspector]);
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
const WORKFLOWS = { v: 1, workflows: [] };
const standard = (target: string, init: any): Reply => {
  if (target === '/api/session') return reply(204);
  if (target === '/api/info') return reply(200, INFO);
  if (target === '/api/runs') return reply(200, RUNS);
  if (target === '/api/workflows') return reply(200, WORKFLOWS); // F.2: the Workflows view reads it
  return errorReply(404, 'not-found');
};


const AT = '2026-11-09T10:00:00.000Z';
const missing = { ok: false, code: 'core-lacks-verb' };
const doctor = { summary: { probed: 0, healthy: 0, unhealthy: 0, absent: 0, unverified: 0 }, findings: [], warnings: [], findingsNotShown: 0, warningsNotShown: 0, harnesses: [], externalTools: [], capabilities: [], providers: [], freshness: [], workers: { rows: [] }, workerPool: { harnesses: [] } };
const responses: Record<string, any> = {
  '/api/settings': { v: 1, sections: { effective: missing, schema: missing } },
  '/api/advice': { v: 1, sections: { settings: missing, report: missing, picks: missing } },
  '/api/workers': { v: 1, sections: { matrix: missing, settings: missing } },
  '/api/storage': { v: 1, at: AT, storage: { stores: [], storesNotShown: 0 } },
  '/api/doctor': { v: 1, at: AT, refresh: 'ran', doctor },
  '/api/doctor?refresh=1': { v: 1, at: AT, refresh: 'ran', doctor },
  '/api/followups?state=open': { v: 1, state: 'open', cursor: null, sections: { list: { ok: true, at: AT, data: { count: 0, shown: 0, items: [], nextCursor: null, unreadable: { n: 0, rows: [] }, conflicts: { n: 0, rows: [] } } }, overview: missing } },
};
const manageFetch = (target: string, init: any) => Object.hasOwn(responses, target) ? reply(200, responses[target]) : standard(target, init);

test('management hashes are exact, round-trip, and reject invalid paths before a view can fetch', () => {
  const { parseRoute, hashFor, baseRoute, navFor } = mods.views;
  for (const hash of ['#/settings', '#/settings/workers.enabled', '#/advice', '#/advice/kind/tier/pick/adv-1762581600000-0a1b2c', '#/followups/FU-000001', '#/health/store/events', '#/workers/pi/orchestration/spawn']) {
    const route = parseRoute(hash); assert.notEqual(route.id, 'not-found', hash); assert.equal(hashFor(route), hash); assert.equal(navFor(route), route.id);
    assert.equal(parseRoute(hashFor(baseRoute(route))).id, route.id);
  }
  for (const hash of ['#/settings/Advice', '#/settings/a', '#/advice/kind/A', '#/advice/pick/adv-1', '#/advice/x/y', '#/followups/FU-ABCDEF', '#/followups/FU-l00000', '#/health/store', '#/health/x/y', '#/workers/claude', '#/workers/claude/routing/cli', '#/workers/claude/worker/Cli']) assert.equal(parseRoute(hash).id, 'not-found', hash);
  assert.deepEqual(baseRoute(parseRoute('#/advice/kind/tier/pick/adv-1762581600000-0a1b2c')).params, { kind: 'tier' });
});

test('the shell opens each management view and marks the rail; a missing section stays inline', async () => {
  const page = await start({ hash: '#/settings', fetch: manageFetch });
  for (const [hash, name, endpoint] of [['#/settings', 'Settings', '/api/settings'], ['#/advice', 'Advice', '/api/advice'], ['#/followups', 'Follow-ups', '/api/followups?state=open'], ['#/health', 'Health', '/api/storage'], ['#/workers', 'Workers', '/api/workers']]) {
    page.location.hash = hash; page.win.dispatch('hashchange'); await settle();
    assert.ok(apiCalls(page, endpoint).length, endpoint); assert.deepEqual(current(page), [name]); assert.equal(page.shell.dataset.inspectable, 'true');
    if (hash === '#/followups') assert.ok(text(page.main).includes('No open follow-ups.'));
  }
  assert.ok(text(page.main).includes('This DoFlow core does not provide the worker matrix.'));
  const oldCalls = apiCalls(page, '/api/workers').length; page.location.hash = '#/workers/claude'; page.win.dispatch('hashchange'); await settle();
  assert.equal(apiCalls(page, '/api/workers').length, oldCalls, 'invalid route makes no data request');
});

test('Health doctor is read once across polls and again only on Refresh', async () => {
  const page = await start({ hash: '#/health', fetch: manageFetch });
  assert.equal(apiCalls(page, '/api/doctor').length, 1);
  await advance(300000);
  assert.equal(apiCalls(page, '/api/doctor').length, 1); assert.ok(apiCalls(page, '/api/storage').length >= 5);
  const button = page.main.querySelectorAll('button').find((b: El) => text(b) === 'Refresh');
  if (!button) throw new Error('Refresh button missing');
  button.fire('click'); await settle();
  assert.equal(apiCalls(page, '/api/doctor').length, 2);
});

test('management polls use their intervals and stop on pause and hidden tabs without opening a stream', async () => {
  let streams = 0;
  class Stream { constructor() { streams += 1; } }
  const page = await start({ hash: '#/settings', fetch: manageFetch, eventSource: Stream });
  assert.equal(apiCalls(page, '/api/settings').length, 1);
  await advance(30000); assert.equal(apiCalls(page, '/api/settings').length, 2);
  page.pause.fire('click'); await advance(60000); assert.equal(apiCalls(page, '/api/settings').length, 2);
  page.pause.fire('click'); await settle();
  page.doc.hidden = true; for (const fn of page.doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' });
  const count = apiCalls(page, '/api/settings').length; await advance(60000); assert.equal(apiCalls(page, '/api/settings').length, count);
  page.doc.hidden = false; for (const fn of page.doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' }); await settle();
  assert.equal(apiCalls(page, '/api/settings').length, count + 1);
  assert.equal(streams, 0);
});

test('the command palette lists all five management screens', async () => {
  const page = await start({ fetch: manageFetch });
  const event = { type: 'keydown', key: 'k', target: page.doc.activeElement, ctrlKey: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const fn of page.doc.listeners.get('keydown') ?? []) fn(event);
  const labels = page.doc.getElementById('palette').querySelectorAll('li').map((li: El) => text(li.querySelector('.palette__label')));
  for (const name of ['Workers', 'Advice', 'Follow-ups', 'Settings', 'Health']) assert.ok(labels.includes(name), name);
});

for (const [hash, endpoint] of [['#/settings', '/api/settings'], ['#/advice', '/api/advice'], ['#/followups', '/api/followups?state=open'], ['#/health', '/api/storage'], ['#/workers', '/api/workers']]) {
  test(`shell loading and error states for ${hash}`, async () => {
    let rejectRead: any;
    const page = await start({ hash, fetch: (target, init) => target === endpoint ? new Promise((_resolve, reject) => { rejectRead = reject; }) : manageFetch(target, init) });
    assert.ok(text(page.main).toLowerCase().includes('loading'), 'loading copy while the read is pending');
    rejectRead(new Error('offline')); await settle();
    assert.ok(text(page.main).includes('Console') || text(page.main).includes('load'), 'a failed whole-route read is visible');
  });
}

test('an empty settings list reaches the shell empty state', async () => {
  const empty = { v: 1, sections: { effective: { ok: true, data: { keys: [] }, at: AT }, schema: missing } };
  const page = await start({ hash: '#/settings', fetch: (target, init) => target === '/api/settings' ? reply(200, empty) : manageFetch(target, init) });
  assert.ok(text(page.main).includes('The DoFlow core listed no settings.'));
});

for (const [label, hash, endpoint] of [['Workers', '#/workers', '/api/workers'], ['Advice', '#/advice', '/api/advice'], ['Follow-ups', '#/followups', '/api/followups?state=open'], ['Settings', '#/settings', '/api/settings'], ['Health', '#/health', '/api/storage']]) {
  test(`palette activates ${label} and shell keeps stale data`, async () => {
    let down = false;
    const page = await start({ fetch: (target, init) => down && target === endpoint ? errorReply(502, 'core-error') : manageFetch(target, init) });
    const event = { type: 'keydown', key: 'k', target: page.doc.body, ctrlKey: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of page.doc.listeners.get('keydown') ?? []) fn(event);
    const palette = page.doc.getElementById('palette');
    const input = palette.querySelector('input'); input.value = label; input.fire('input');
    const option = palette.querySelectorAll('li').find((li: El) => text(li.querySelector('.palette__label')) === label);
    if (!option) throw new Error(`missing palette target ${label}`);
    option.fire('click'); assert.equal(page.location.hash, hash);
    page.win.dispatch('hashchange'); await settle(); assert.deepEqual(current(page), [label]);
    assert.ok(apiCalls(page, endpoint).length > 0);
    down = true; await advance(hash === '#/health' ? 90000 : 60000);
    assert.ok(page.slot.querySelector('.banner'), `${label}: stale banner`);
    assert.equal(page.main.getAttribute('data-stale'), 'true');
    assert.ok(text(page.main).length > 0, 'the last body remains');
  });
}

const item = (key: string, value: any, type = 'string') => ({ key, meta: { type, default: null, scope: 'global-only', securityRelevant: false, env: null, description: 'Description', values: null }, views: [{ view: 'project', value, state: 'ok', origin: { layer: 'default', where: null, via: null }, candidates: [] }] });
const safeSettings = { keys: [item('advice.enabled', false), item('advice.kinds.tier', null), item('workers.enabled', ['codex', 'primary']), item('workers.models', null), item('workers.billing', null)], files: [], errors: [], notes: [], failSafe: false };
const safeReport = { window: { from: '2026-08-11', to: '2026-11-09' }, kinds: [{ kind: 'tier', n: { picks: 0, misses: 0 }, missesByReason: [], agreeStatic: null, agreeOutcome: null, elevated: null, modes: null, durationMs: null, missDurationMs: null }], verdicts: [] };
const safePicks = { kinds: ['tier'], days: [{ day: '2026-11-09', coverage: 'unknown', picks: {}, unreadableLines: 0 }], picks: [{ pickId: 'adv-1762581600000-0a1b2c', at: AT, kind: 'tier', mode: 'unrecorded', pick: 'x', static: null, agree: null, outcome: null }], limits: { shown: 1, notShown: 0 } };
const safeCell = { status: 'unknown', declared: false, evidence: [], verification: null, verifiedOn: null, reason: null, fallback: null, cut: false };
const safeMatrix = { groups: { worker: ['cli'], orchestration: ['spawn'] }, harnesses: [{ id: 'codex', billing: null, cells: { worker: { cli: safeCell }, orchestration: { spawn: safeCell } } }], counts: { worker: { supported: 0, unknown: 1, unsupported: 0 }, orchestration: { supported: 0, unknown: 1, unsupported: 0 } } };
const ok = (data: any) => ({ ok: true, at: AT, data });
const fullResponses: Record<string, any> = {
  ...responses,
  '/api/settings': { sections: { effective: ok(safeSettings), schema: ok({ invariants: [], ranges: [] }) } },
  '/api/advice': { sections: { settings: ok(safeSettings), report: ok(safeReport), picks: ok(safePicks) } },
  '/api/workers': { sections: { matrix: ok(safeMatrix), settings: ok(safeSettings) } },
  '/api/storage': { storage: { stores: [{ id: 'events', where: null, bound: '30 days', setting: 'storage.prune', entries: null, bytes: null, wouldPrune: null, protected: null, failed: null, skipped: null }], storesNotShown: 0 }, at: AT },
  '/api/followups?state=open': { sections: { list: ok({ count: 1, shown: 1, nextCursor: null, items: [{ id: 'FU-000001', state: 'open', statement: 'A follow-up' }], conflicts: { n: 0, rows: [] }, unreadable: { n: 0, rows: [] } }), overview: missing } },
  '/api/followups/FU-000001': { followup: { id: 'FU-000001', statement: 'A follow-up', source: { kind: 'manual' }, state: 'open', takenBy: null, intent: null, fix: null, added: null, excerpt: null, body: null, history: [], historyNotShown: 0 } },
};
const fullFetch = (target: string, init: any) => Object.hasOwn(fullResponses, target) ? reply(200, fullResponses[target]) : standard(target, init);

for (const [hash, target, selection] of [
  ['#/settings', 'a', '#/settings/advice.kinds.tier'],
  ['#/advice', 'select', '#/advice/pick/adv-1762581600000-0a1b2c'],
  ['#/followups', 'select', '#/followups/FU-000001'],
  ['#/health', 'a', '#/health/store/events'],
  ['#/workers', 'td[role="gridcell"]', '#/workers/codex/worker/cli'],
]) {
  test(`keyboard focus, inspector and unknown values on ${hash}`, async () => {
    const page = await start({ hash, fetch: fullFetch, width: 1440 });
    const control = page.main.querySelector(target);
    assert.ok(control, `${hash}: a keyboard target is rendered`);
    control.focus(); assert.equal(page.doc.activeElement, control, `${hash}: target accepts focus`);
    assert.match(fs.readFileSync(path.join(WEB_ROOT, 'app.css'), 'utf8'), /:focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\)/, 'the shared visible focus ring applies');
    for (const table of page.main.querySelectorAll('table.mtable')) {
      assert.equal(table.getAttribute('tabindex'), '0', `${hash}: each data table is a keyboard stop`);
      table.focus(); assert.equal(page.doc.activeElement, table);
    }
    for (const tag of ['a', 'select', 'button', 'summary']) for (const element of page.main.querySelectorAll(tag)) {
      if (element.getAttribute('disabled') === null) { element.focus(); assert.equal(page.doc.activeElement, element, `${hash}: ${tag} is reachable`); }
    }
    for (const grid of page.main.querySelectorAll('table.matrix')) {
      const cells = grid.querySelectorAll('td').filter((td: El) => td.getAttribute('role') === 'gridcell');
      assert.equal(cells.filter((td: El) => td.getAttribute('tabindex') === '0').length, 1, 'one grid cell is a tab stop');
      for (const cell of cells) assert.ok(['0', '-1'].includes(cell.getAttribute('tabindex') ?? ''), 'all grid cells participate in roving focus');
    }
    if (hash === '#/settings') assert.ok(text(page.main).includes('not set'));
    if (hash === '#/advice') assert.ok(text(page.main).includes('unknown') && text(page.main).includes('no outcome recorded'));
    if (hash === '#/health') {
      const table = page.main.querySelectorAll('table.mtable').find((table: El) => text(table.querySelector('caption')) === 'Storage stores');
      if (!table) throw new Error('Storage table missing');
      const row = table.querySelector('tbody').querySelector('tr');
      const cells = row.querySelectorAll('td').map((td: El) => text(td));
      assert.deepEqual(cells.slice(4), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    }
    if (hash === '#/workers') assert.ok(text(control).includes('Unknown'));
    page.location.hash = selection; page.win.dispatch('hashchange'); await settle();
    assert.ok(page.inspector.querySelector('.inspector__body').children.length > 0, `${hash}: inspector opens`);
    const close = page.inspector.querySelector('.inspector__close'); close.focus(); assert.equal(page.doc.activeElement, close);
  });
}
