'use strict';

// Now across projects (180 C3, design §2; FR-A2..A6): the other shown projects' open runs from the `machine` member, the scope
// chips and the title count, counts only from an older core, the opt-in notification and the look of "Since you looked". The
// web modules run in one copied graph over a small fake DOM, a fake storage and, where a case needs it, a fake Notification.

const { test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let mods: any;

// ---- a fake DOM ---------------------------------------------------------------------------------

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class Txt {
  parent: any = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
}

class El {
  parent: any = null;
  children: any[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Function[]>();
  dataset: any;
  classList: any;
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
    this.classList = { contains: (name: string) => tokens().includes(name), add: (...names: string[]) => self.attrs.set('class', [...new Set([...tokens(), ...names])].join(' ')), remove() {} };
  }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(value: string) { this.attrs.set('class', value); }
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
  replaceChildren(...nodes: any[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  contains(node: any): boolean { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type: string) { for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this, preventDefault() {} }); }
  focus() { doc.activeElement = this; }
  /** `tag`, `.class`, `[attr]`, `[attr="value"]`, combined. */
  matches(selector: string) {
    const tag = /^[a-z0-9]+/i.exec(selector);
    if (tag && this.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    for (const m of selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(m[1])) return false;
    for (const m of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) if (m[2] === undefined ? !this.attrs.has(m[1]) : this.attrs.get(m[1]) !== m[2]) return false;
    return true;
  }
  querySelectorAll(selector: string): El[] {
    const out: El[] = [];
    const walk = (node: any) => {
      for (const child of node.children) if (child instanceof El) { if (child.matches(selector)) out.push(child); walk(child); }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

const doc: any = {
  hidden: false, title: '', activeElement: null, listeners: new Map<string, Function[]>(),
  createElement: (tag: string) => new El(tag),
  createElementNS: (_ns: string, tag: string) => new El(tag),
  createTextNode: (text: string) => new Txt(text),
  getElementById: () => null,
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); },
  removeEventListener(type: string, fn: Function) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f: Function) => f !== fn)); },
  setHidden(value: boolean) { this.hidden = value; for (const fn of this.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' }); },
};

/** The storage the page sees: a map, or one that throws (a private window). */
const storage = { map: new Map<string, string>(), refuse: false };
const fakeStorage = {
  getItem: (k: string) => { if (storage.refuse) throw new Error('blocked'); return storage.map.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (storage.refuse) throw new Error('blocked'); storage.map.set(k, v); },
};

/** A fake Notification: what was raised, and every permission request. */
const notes = { raised: [] as Array<{ title: string, options: any }>, asked: 0, answer: 'granted' };
class FakeNotification {
  static permission = 'default';
  static requestPermission() { notes.asked += 1; FakeNotification.permission = notes.answer; return Promise.resolve(notes.answer); }
  constructor(title: string, options: any) { notes.raised.push({ title, options }); }
  addEventListener() {}
  close() {}
}

const SAVED = ['document', 'localStorage', 'Notification'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const setGlobal = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-now-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  setGlobal('document', doc);
  setGlobal('localStorage', fakeStorage);
  const url = (name: string) => pathToFileURL(path.join(copy, name)).href;
  mods = { views: await import(url('views.js')), home: await import(url('views/home.js')), notify: await import(url('notify.js')) };
});
after(() => {
  for (const [name, descriptor] of SAVED) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as any)[name];
  }
  fs.rmSync(copy, { recursive: true, force: true });
});
beforeEach(() => {
  mods.home.resetHome();
  mods.notify.resetNotify();
  storage.map.clear();
  storage.refuse = false;
  doc.hidden = false;
  doc.title = '';
  doc.listeners.clear();
  notes.raised = [];
  notes.asked = 0;
  notes.answer = 'granted';
  FakeNotification.permission = 'default';
  delete (globalThis as any).Notification;
});
afterEach(() => { mock.timers.reset(); });

// ---- fixtures -----------------------------------------------------------------------------------

const HERE = 'a1b2c3d4e5f60718';
const THERE = 'c1c2c3c4c5c6c7c8';
const THIRD = 'e1e2e3e4e5e6e7e8';
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ok = (data: any) => ({ ok: true, data });
const run = (taskId: string, state: string) => ({ taskId, featureSlug: 'feat-a', taskClass: 'feature', state, revision: 1, updatedAt: ago(1) });
const open = (taskId: string, state: string, slug = 'feat-b') => ({ slug, taskId, state, workflowName: 'Feature Delivery', step: { done: 2, total: 9 }, updatedAt: ago(3),
  gateName: state === 'AWAITING_GATE' ? 'Approve design' : null });
const item = (projectKey: string, openRuns: any[] | null, counts = { open: 0, awaiting: 0 }) => ({ projectKey, runs: counts, gates: [], openRuns, workers: { open: 0 }, sessions: { observed: 0, harnesses: [] }, unreadable: [] });
const machine = (items: any[], notShown = 0) => ({
  v: 1,
  sections: {
    projects: ok({ v: 1, store: 'present', excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, truncated: false, projects: [
      { projectKey: HERE, label: 'here', current: true, temp: false, checkouts: 1, sources: [], lastRecordAt: null },
      { projectKey: THERE, label: 'there', current: false, temp: false, checkouts: 1, sources: [], lastRecordAt: null },
      { projectKey: THIRD, label: 'third', current: false, temp: false, checkouts: 1, sources: [], lastRecordAt: null },
    ] }),
    activity: ok({ v: 1, limits: { projects: items.length, notShown, watched: items.length, fingerprintOnly: 0 }, items }),
  },
});
/** Three projects: this one (one waiting, one running), `there` (one waiting, one running), `third` (one running). */
const THREE = () => machine([
  item(HERE, [open('r1', 'AWAITING_GATE', 'feat-a'), open('r2', 'RUNNING', 'feat-a')], { open: 2, awaiting: 1 }),
  item(THERE, [open('T-1', 'AWAITING_GATE'), open('T-2', 'RUNNING')], { open: 2, awaiting: 1 }),
  item(THIRD, [open('X-1', 'RUNNING', 'feat-c')], { open: 1, awaiting: 0 }),
], 3);
const data = (body: any, runs = [run('r1', 'AWAITING_GATE'), run('r2', 'RUNNING')]) => ({ runs, unreadableCount: 0, workflows: new Map(), machine: body });
const render = (d: any, local: any = {}) => mods.views.VIEWS.runs.render(d, {}, local);
const otherRows = (root: any) => root.querySelectorAll('li[data-project]');
const button = (root: any, name: string) => root.querySelectorAll('button').find((b: El) => b.textContent === name) ?? null;
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// ---- (b) every project, the scope and the title -------------------------------------------------

test('(b) Now lists this project’s runs and the other two projects’ open runs, each labelled, linking to their Layers page', () => {
  const root = render(data(THREE()));
  const rows = otherRows(root);
  assert.deepEqual(rows.map((li: El) => [li.dataset.project, li.querySelector('.tag')?.textContent, li.querySelector('a')?.getAttribute('href')]), [
    [THERE, 'there', `#/layers/${THERE}`], [THERE, 'there', `#/layers/${THERE}`], [THIRD, 'third', `#/layers/${THIRD}`],
  ], 'the current project’s own machine rows are not drawn twice');
  assert.ok(!rows.some((li: El) => String(li.querySelector('a')?.getAttribute('href')).startsWith('#/run/')), 'never the run page: it reads this project only');
  assert.equal(root.querySelectorAll('.gate-card').length, 1, 'this project’s waiting run keeps its gate card');
  assert.match(rows[0].querySelector('.run-row__meta').textContent, /Feature Delivery · 2 of 9 steps done · at Approve design/);
  assert.equal(mods.views.VIEWS.runs.title({}, data(THREE())), '(2) Now', 'the title counts the waiting rows shown: one here, one there');
  assert.equal(mods.views.VIEWS.runs.isEmpty(data(THREE(), [])), false, 'no run here but open runs elsewhere: Now is not empty');
  assert.equal(mods.views.VIEWS.runs.isEmpty(data(null, [])), true);
});

test('(b) This project hides the other projects’ rows and the title counts what it shows; Every project brings them back', () => {
  const d = data(THREE());
  const root = render(d);
  assert.equal(button(root, 'Every project').getAttribute('aria-pressed'), 'true', 'Every project is the default');
  button(root, 'This project').fire('click');
  assert.equal(otherRows(root).length, 0);
  assert.equal(button(root, 'This project').getAttribute('aria-pressed'), 'true');
  assert.equal(mods.views.VIEWS.runs.title({}, d), '(1) Now');
  assert.equal(doc.title, '(1) Now · DoFlow Console', 'the chip sets the title the shell set from the data');
  assert.equal(root.querySelector('[data-note="not-shown"]'), null, 'the not-shown note belongs to Every project');
  button(root, 'Every project').fire('click');
  assert.equal(otherRows(root).length, 3);
  assert.equal(doc.title, '(2) Now · DoFlow Console');
  assert.match(root.querySelector('[data-note="not-shown"]').textContent, /^3 more projects are not shown here\./);
});

test('(b) without a machine member (no stream yet) Now is this project only, with no scope chips', () => {
  const root = render(data(null));
  assert.equal(otherRows(root).length, 0);
  assert.equal(button(root, 'Every project'), null);
  assert.equal(mods.views.VIEWS.runs.title({}, data(null)), '(1) Now');
});

test('(b) the connector merges each machine frame into the last data; a closed machine channel drops the other projects', async () => {
  const subs = new Map<string, Function>();
  const store = { status: () => ({ transport: 'open', lastFrameAt: null }), onTransport: () => () => {}, subscribe: (ch: string, fn: Function) => { subs.set(ch, fn); return () => subs.delete(ch); }, pause() {}, resume() {} };
  const delivered: any[] = [];
  const local: any = {};
  const body = { v: 1, runs: [run('r1', 'AWAITING_GATE')], unreadableCount: 0 };
  const connector = mods.views.VIEWS.runs.connect(local, {}, {
    fetchJson: async () => ({ v: 1, workflows: [] }), onData: (d: any) => delivered.push(d), onFailure: () => {}, store: () => store,
    fetchOnce: async () => ({ runs: body.runs, unreadableCount: 0, workflows: new Map(), machine: local.machine ?? null }),
  });
  connector.start();
  await settle();
  assert.ok(subs.has('now') && subs.has('machine'), 'both channels are followed');
  assert.equal(delivered.at(-1).machine, null);
  const m = THREE();
  subs.get('machine')!({ kind: 'state', state: { machine: { status: 200, body: m } }, code: null });
  assert.equal(delivered.at(-1).machine, m);
  assert.deepEqual(delivered.at(-1).runs, body.runs, 'the runs are the last ones delivered');
  subs.get('machine')!({ kind: 'error', state: null, code: 'gone' });
  assert.equal(delivered.at(-1).machine, null, 'an errored channel drops the rows it no longer follows');
  connector.stop();
  assert.ok(!subs.has('machine'), 'stop unsubscribes');
});

// ---- (c) an older core ----------------------------------------------------------------------------

test('(c) a machine body without openRuns shows the other projects as counts only, with no rows', () => {
  const body = machine([item(HERE, null, { open: 2, awaiting: 1 }), item(THERE, null, { open: 2, awaiting: 1 }), item(THIRD, null, { open: 0, awaiting: 0 })]);
  const root = render(data(body));
  assert.equal(otherRows(root).length, 0);
  const note = root.querySelector('[data-note="counts-only"]');
  assert.ok(note, 'the counts-only note is drawn');
  assert.equal(note.textContent, 'Other projects, counts only (this DoFlow core lists no runs): there 2 open, 1 waiting.');
  assert.equal(note.querySelector('a').getAttribute('href'), `#/layers/${THERE}`);
  assert.equal(mods.views.VIEWS.runs.title({}, data(body)), '(1) Now', 'counts only: the title counts this project’s rows');
  assert.equal(render(data(THREE())).querySelector('[data-note="counts-only"]'), null, 'control: a body with openRuns has no counts-only note');
});

// ---- (d) the notification ---------------------------------------------------------------------------

const waitingThere = () => [{ projectKey: THERE, projectLabel: 'there', taskId: 'T-1', slug: 'feat-b', state: 'AWAITING_GATE', updatedAt: ago(1), gateName: 'Approve design' }];
const lookOf = (states: Record<string, string>) => ({ at: Date.now() - 60_000, states });

test('(d) the switch asks permission only from its click; rendering, connecting and checking never ask', async () => {
  setGlobal('Notification', FakeNotification);
  const local: any = {};
  const root = render(data(THREE()), local);
  mods.notify.notifyWaiting(waitingThere(), null);
  const store = { status: () => ({ transport: 'open', lastFrameAt: null }), onTransport: () => () => {}, subscribe: () => () => {}, pause() {}, resume() {} };
  const connector = mods.views.VIEWS.runs.connect(local, {}, { fetchJson: async () => ({}), onData: () => {}, onFailure: () => {}, store: () => store, fetchOnce: async () => data(null), watchStore: () => store });
  connector.start();
  await settle();
  connector.stop();
  assert.equal(notes.asked, 0, 'no prompt without a gesture');
  const control = button(root, 'Notify me when a run waits');
  assert.equal(control.getAttribute('aria-pressed'), 'false');
  control.fire('click');
  assert.equal(notes.asked, 1, 'the click asks, synchronously inside the gesture');
  await settle();
  assert.equal(button(root, 'Notify me when a run waits').getAttribute('aria-pressed'), 'true', 'granted: switched on');
  assert.equal(mods.notify.notifyActive(), true);
  button(root, 'Notify me when a run waits').fire('click');
  assert.equal(notes.asked, 1, 'switching off asks nothing');
  assert.equal(mods.notify.notifyActive(), false);
  delete (globalThis as any).Notification;
  assert.equal(button(render(data(THREE())), 'Notify me when a run waits'), null, 'no Notification: no switch');
});

test('(d) a run entering AWAITING_GATE while hidden and granted raises one notification with project, slug and gate; none when visible, off, denied or already waiting at the last look', () => {
  setGlobal('Notification', FakeNotification);
  FakeNotification.permission = 'granted';
  mods.notify.setNotify(true);
  const before = lookOf({ [`${THERE}:T-1`]: 'RUNNING' });
  doc.hidden = false;
  assert.equal(mods.notify.notifyWaiting(waitingThere(), before), 0, 'visible: none');
  doc.hidden = true;
  assert.equal(mods.notify.notifyWaiting(waitingThere(), before), 1);
  assert.deepEqual(notes.raised, [{ title: 'Waiting for you', options: { body: 'there · feat-b · Approve design' } }], 'project label, slug and gate name only');
  assert.equal(mods.notify.notifyWaiting(waitingThere(), before), 0, 'one notification per wait, not one per frame');
  mods.notify.resetNotify();
  mods.notify.setNotify(true);
  assert.equal(mods.notify.notifyWaiting(waitingThere(), lookOf({ [`${THERE}:T-1`]: 'AWAITING_GATE' })), 0, 'already waiting at the last look');
  mods.notify.setNotify(false);
  assert.equal(mods.notify.notifyWaiting(waitingThere(), before), 0, 'switched off');
  mods.notify.setNotify(true);
  FakeNotification.permission = 'denied';
  assert.equal(mods.notify.notifyWaiting(waitingThere(), before), 0, 'denied');
  FakeNotification.permission = 'granted';
  assert.equal(mods.notify.notifyWaiting(waitingThere(), before), 1, 'control: allowed again, it is raised');
});

test('(d) once switched on, the hidden-tab watcher follows machine and raises the notification from its frame', async () => {
  setGlobal('Notification', FakeNotification);
  FakeNotification.permission = 'granted';
  const subs = new Map<string, Function>();
  const watchStore = { subscribe: (ch: string, fn: Function) => { subs.set(ch, fn); return () => subs.delete(ch); } };
  const page = { status: () => ({ transport: 'open', lastFrameAt: null }), onTransport: () => () => {}, subscribe: () => () => {}, pause() {}, resume() {} };
  const hooks = { fetchJson: async () => ({}), onData: () => {}, onFailure: () => {}, store: () => page, fetchOnce: async () => data(null), watchStore: () => watchStore };
  const first = mods.views.VIEWS.runs.connect({}, {}, hooks);
  first.start();
  assert.equal(subs.has('machine'), false, 'switched off: no second stream is followed');
  first.stop();
  mods.notify.setNotify(true);
  const second = mods.views.VIEWS.runs.connect({}, {}, hooks);
  second.start();
  await settle();
  second.stop();
  assert.equal(subs.has('machine'), true, 'switched on and allowed: the watcher follows machine, and outlives Now');
  doc.hidden = true;
  subs.get('machine')!({ kind: 'state', state: { machine: { status: 200, body: THREE() } }, code: null });
  assert.deepEqual(notes.raised.map((n) => n.options.body), ['here · feat-a · Approve design', 'there · feat-b · Approve design'], 'every shown project, this one too');
});

// ---- (f) the look ---------------------------------------------------------------------------------

const stored = () => JSON.parse(storage.map.get('doflow-console-now-seen') ?? 'null');

test('(f) a look is recorded after Now has been visible for 2 s, never while hidden', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-20T10:00:00.000Z') });
  const local: any = {};
  render(data(THREE()), local);
  mock.timers.tick(1999);
  assert.equal(stored(), null, 'not before 2 s');
  mock.timers.tick(1);
  const look = stored();
  assert.equal(look.at, Date.parse('2026-11-20T10:00:02.000Z'));
  assert.deepEqual(Object.keys(look.states).sort(), [`${HERE}:r1`, `${HERE}:r2`, `${THERE}:T-1`, `${THERE}:T-2`, `${THIRD}:X-1`].sort());
  mods.home.teardownHome(local);
  storage.map.clear();
  doc.hidden = true;
  const hidden: any = {};
  render(data(THREE()), hidden);
  mock.timers.tick(5000);
  assert.equal(stored(), null, 'a hidden tab records no look');
  doc.setHidden(false);
  mock.timers.tick(2000);
  assert.ok(stored(), 'back to visible for 2 s: a look');
  mods.home.teardownHome(hidden);
});

test('(f) "Since you looked" lists what moved against the last look; "Mark as seen" records a look and empties it', () => {
  storage.map.set('doflow-console-now-seen', JSON.stringify(lookOf({ [`${HERE}:r1`]: 'RUNNING', [`${HERE}:r2`]: 'RUNNING', [`${THERE}:T-1`]: 'AWAITING_GATE', [`${THERE}:T-2`]: 'RUNNING', [`${THERE}:T-9`]: 'RUNNING' })));
  const local: any = {};
  const root = render(data(THREE()), local);
  const strip = root.querySelector('[data-section="digest"]');
  assert.ok(strip, 'the strip is drawn');
  assert.deepEqual(strip.querySelectorAll('li').map((li: El) => li.textContent), [
    'third feat-c: new, running', 'here feat-a: running → waiting for you', 'there T-9: no longer open',
  ]);
  button(root, 'This project').fire('click');
  assert.deepEqual(root.querySelector('[data-section="digest"]').querySelectorAll('li').map((li: El) => li.textContent), ['here feat-a: running → waiting for you'], 'the scope filters the strip');
  button(root, 'Mark as seen').fire('click');
  assert.equal(root.querySelector('[data-section="digest"]'), null, 'marked: nothing to say');
  assert.equal(stored().states[`${THIRD}:X-1`], 'RUNNING', 'the look is stored');
  assert.equal(stored().states[`${THERE}:T-9`], undefined);
  mods.home.teardownHome(local);
});

test('(f) the page works with no storage: the look and the switch hold for this load only', () => {
  storage.refuse = true;
  setGlobal('Notification', FakeNotification);
  FakeNotification.permission = 'granted';
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-20T10:00:00.000Z') });
  const local: any = {};
  const root = render(data(THREE()), local);
  button(root, 'Notify me when a run waits').fire('click');
  assert.equal(mods.notify.notifyActive(), true, 'the switch holds in memory');
  mock.timers.tick(2000);
  assert.equal(Object.keys(mods.notify.readSeen().states).length, 5, 'the look holds in memory');
  mods.home.teardownHome(local);
});
