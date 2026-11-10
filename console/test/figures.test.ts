'use strict';

// Shared figure words, section states and the doctor read controller (feature 151, IC-016; plan task C.1; FR-002, FR-024,
// FR-026, FR-029). Like session-view.test.ts, the web root is copied beside a {"type":"module"} marker and the modules are
// imported from there (views.js first, the page's own import order). A small fake DOM (elements and text nodes; a markup
// write throws) records what the code builds; `apiGet` is a fake over scripted answers that records every path.

const { test, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { renderText } = require('../../src/runtime/advice/report.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let figures: any;
let doctorRead: any;
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
    this.classList = { contains: (name: string) => tokens().includes(name), add: (...names: string[]) => self.attrs.set('class', [...new Set([...tokens(), ...names])].join(' ')) };
  }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(value: string) { this.attrs.set('class', value); }
  get textContent(): string { return this.children.map((c) => c.textContent).join(''); }
  set textContent(value: string) {
    for (const c of this.children) c.parent = null;
    this.children = value === '' ? [] : [this.adopt(new Txt(value))];
  }
  /** Markup strings never reach the page (NFR-005): any write is a failure. */
  set innerHTML(_value: string) { throw new Error('markup written'); }
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
  fire(type: string) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (let node: any = this; node; node = node.parent) for (const fn of node.listeners?.get(type) ?? []) fn(event);
  }
  matches(tag: string | null, cls: string | null) {
    return (tag === null || this.tagName.toLowerCase() === tag) && (cls === null || this.classList.contains(cls));
  }
  /** `tag`, `.class` or `tag.class` only. */
  querySelectorAll(selector: string): El[] {
    const [tag, cls] = selector.split('.');
    const out: El[] = [];
    const walk = (node: any) => {
      for (const child of node.children) {
        if (child instanceof El) {
          if (child.matches(tag === '' ? null : tag, cls ?? null)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

const doc: any = {
  createElement: (tag: string) => new El(tag),
  createElementNS: (_ns: string, tag: string) => new El(tag),
  createTextNode: (text: string) => new Txt(text),
  getElementById: () => null,
};

/** Every node under `node`, depth first. */
function nodesOf(node: any): any[] {
  return node.children.flatMap((c: any) => (c instanceof El ? [c, ...nodesOf(c)] : [c]));
}
const buttons = (node: any) => node.querySelectorAll('button');

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-figures-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  await import(pathToFileURL(path.join(copy, 'views.js')).href);
  figures = await import(pathToFileURL(path.join(copy, 'figures.js')).href);
  doctorRead = await import(pathToFileURL(path.join(copy, 'doctor-read.js')).href);
  states = await import(pathToFileURL(path.join(copy, 'states.js')).href);
});
after(() => {
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
  else delete (globalThis as any).document;
  fs.rmSync(copy, { recursive: true, force: true });
});
afterEach(() => {
  mock.timers.reset();
});

// ---- the words ----------------------------------------------------------------------------------

test('IC-016 words: unknown for null, "no data (n=0)" for n 0, the value with its n otherwise; never 0 for unknown', () => {
  const { UNKNOWN, NO_DATA, countText, ratioText, figureText } = figures;
  assert.equal(UNKNOWN, 'unknown');
  assert.equal(NO_DATA, 'no data (n=0)');

  assert.equal(countText(null), 'unknown');
  assert.equal(countText(undefined), 'unknown');
  assert.equal(countText(0), '0', 'a known count of 0 is 0');
  assert.equal(countText(42), '42');
  for (const odd of ['3', 1.5, Number.NaN, -1, {}, true]) assert.equal(countText(odd), 'unknown', `${String(odd)} is not a count`);

  assert.equal(ratioText(null), 'unknown');
  assert.equal(ratioText(undefined), 'unknown');
  assert.equal(ratioText({ n: 0, agree: 0 }), 'no data (n=0)');
  assert.equal(ratioText({ n: 3, agree: 2 }), '2 of 3 (67%), n=3');
  assert.equal(ratioText({ n: 8, agree: 0 }), '0 of 8 (0%), n=8');
  assert.equal(ratioText({ n: 3 }), 'unknown', 'a part without agree is unknown, not 0');

  assert.equal(figureText(null, 5), 'unknown');
  assert.equal(figureText(undefined, 5), 'unknown');
  assert.equal(figureText(120, 0), 'no data (n=0)');
  assert.equal(figureText(null, 0), 'no data (n=0)', 'n 0 is known: no samples, as the report says');
  assert.equal(figureText(120, 4), '120, n=4');
  assert.equal(figureText(0, 4), '0, n=4', 'a known 0 with its n');
  assert.equal(figureText(7, null), '7, n=unknown');

  for (const text of [countText(null), ratioText(null), figureText(null, 3)]) assert.notEqual(text, '0');
});

test('IC-016 ratioText reads as the core report\'s own ratio line (src/runtime/advice/report.ts ratio)', () => {
  const zero = { n: 0, p50: null, p90: null, p95: null };
  for (const part of [{ n: 0, agree: 0 }, { n: 3, agree: 2 }, { n: 7, agree: 7 }, { n: 9, agree: 1 }, { n: 200, agree: 133 }]) {
    const report = {
      scope: 'project', window: { from: '2026-08-11', to: '2026-11-09', maxAgeDays: 90 }, unreadable: 0, verdicts: [],
      kinds: { tier: { n: { picks: part.n, misses: 0 }, missesByReason: {}, agreeStatic: part, agreeOutcome: part, elevated: 0, modes: { shadow: 0, act: 0, unrecorded: 0 }, durationMs: zero, missDurationMs: zero } },
    };
    const line = renderText(report).split('\n').find((l: string) => l.includes('agrees with the static answer: '));
    assert.ok(line, 'the report prints the ratio line');
    assert.equal(figures.ratioText(part), line.split('agrees with the static answer: ')[1], `n=${part.n} agree=${part.agree}`);
  }
});

test('IC-016 figure: a span.figure whose data-figure is unknown, no-data or value, with the text as a text node', () => {
  const { figure, countText, ratioText, figureText } = figures;
  const cases: Array<[string, string]> = [
    [countText(null), 'unknown'],
    [ratioText({ n: 0, agree: 0 }), 'no-data'],
    [figureText(null, 0), 'no-data'],
    [figureText(12, 3), 'value'],
    [countText(0), 'value'],
  ];
  for (const [text, kind] of cases) {
    const el = figure(text);
    assert.equal(el.tagName, 'span');
    assert.ok(el.classList.contains('figure'));
    assert.equal(el.getAttribute('data-figure'), kind, text);
    assert.equal(el.children.length, 1);
    assert.ok(el.children[0] instanceof Txt, 'text node only');
    assert.equal(el.textContent, text);
  }
  const planted = figure('<img src=x>');
  assert.ok(planted.children[0] instanceof Txt);
  assert.equal(planted.querySelectorAll('img').length, 0);
});

// ---- sections -----------------------------------------------------------------------------------

const AT = '2026-11-09T10:00:00.000Z';
const NOW = Date.parse(AT) + 3 * 60_000;

test('IC-016 renderSection ok: the rendered data and "Read <reltime>" from at', () => {
  const seen: any[] = [];
  const retries: number[] = [];
  const el = figures.renderSection({ ok: true, data: { keys: 3 }, at: AT }, {
    noun: 'settings', nowMs: NOW, onRetry: () => retries.push(1),
    render: (data: any) => { seen.push(data); return doc.createElement('table'); },
  });
  assert.deepEqual(seen, [{ keys: 3 }]);
  assert.equal(el.getAttribute('data-state'), 'ready');
  assert.equal(el.querySelectorAll('table').length, 1);
  const time = el.querySelector('.reltime');
  assert.ok(time, 'a reltime');
  assert.equal(time.getAttribute('data-ts'), String(Date.parse(AT)));
  assert.ok(el.textContent.includes('Read 3 min ago'), el.textContent);
  assert.equal(buttons(el).length, 0, 'no Retry on a ready section');
  assert.ok(nodesOf(el).every((n: any) => n instanceof El || n instanceof Txt));
  const unknownAt = figures.renderSection({ ok: true, data: {}, at: null }, { noun: 'settings', nowMs: NOW, onRetry: () => {}, render: () => null });
  assert.ok(unknownAt.textContent.includes('Read time unknown'), 'no invented age');
});

test('IC-016 renderSection core-lacks-verb: the not-in-core sentence with data-state="not-in-core", no Retry, no render', () => {
  let rendered = 0;
  const el = figures.renderSection({ ok: false, code: 'core-lacks-verb' }, { noun: 'the advice report', nowMs: NOW, onRetry: () => {}, render: () => { rendered += 1; return null; } });
  assert.equal(rendered, 0);
  assert.equal(el.getAttribute('data-state'), 'not-in-core');
  assert.equal(el.textContent, 'This DoFlow core does not provide the advice report.');
  assert.equal(buttons(el).length, 0);
});

test('IC-016 renderSection any other code: an inline error with its ERROR_COPY entry and Retry', () => {
  const cases: Array<[string, string]> = [
    ['core-error', 'core-error'],
    ['core-contract-mismatch', 'contract-mismatch'],
    ['core-unreachable', 'core-error'],
    ['usage', 'refused'],
    ['something-new', 'core-error'],
  ];
  for (const [code, key] of cases) {
    let retries = 0;
    let rendered = 0;
    const el = figures.renderSection({ ok: false, code }, { noun: 'the picks', nowMs: NOW, onRetry: () => { retries += 1; }, render: () => { rendered += 1; return null; } });
    assert.equal(rendered, 0);
    assert.equal(el.getAttribute('data-state'), 'error', code);
    const copy = states.ERROR_COPY[key];
    assert.equal(el.querySelector('.state-panel__title').textContent, states.errorTitle({ key }, 'the picks'), code);
    assert.equal(el.querySelector('.state-panel__sentence').textContent, copy.sentence.split('`').join(''), code);
    const retry = buttons(el).filter((b: any) => b.textContent === 'Retry');
    assert.equal(retry.length, 1, `${code}: one Retry`);
    retry[0].fire('click');
    assert.equal(retries, 1, `${code}: Retry calls onRetry`);
    assert.equal(el.querySelector('.code-chip').textContent, code);
  }
  const missing = figures.renderSection(null, { noun: 'the picks', nowMs: NOW, onRetry: () => {}, render: () => null });
  assert.equal(missing.getAttribute('data-state'), 'error');
  assert.equal(missing.querySelector('.code-chip').textContent, 'core-contract-mismatch', 'a missing section is a body this page does not read');
  assert.throws(() => figures.renderSection({ ok: true, data: {}, at: AT }, { noun: 'x', render: () => null }), TypeError, 'Retry needs its action');
  assert.throws(() => figures.renderSection({ ok: true, data: {}, at: AT }, { noun: 'x', onRetry: () => {} }), TypeError);
});

// ---- classify on 501 ----------------------------------------------------------------------------

test('IC-016 classify: 501 core-lacks-verb is an inline key with the not-in-core sentence; other 501s stay core-error', () => {
  const { classify, ERROR_COPY, renderError } = states;
  assert.deepEqual(classify({ status: 501, code: 'core-lacks-verb', network: false }), { scope: 'inline', key: 'core-lacks-verb', auto: false, status: 501, code: 'core-lacks-verb' });
  assert.equal(classify({ status: 501, code: null, network: false }).key, 'core-error');
  const copy = ERROR_COPY['core-lacks-verb'];
  assert.ok(copy, 'its ERROR_COPY entry');
  assert.equal(copy.sentence('this follow-up'), 'This DoFlow core does not provide this follow-up.');
  const panel = renderError({ info: classify({ status: 501, code: 'core-lacks-verb', network: false }), noun: 'this follow-up', range: '>=1', onRetry: () => {}, onReload: () => {} });
  assert.equal(panel.querySelector('.state-panel__sentence').textContent, 'This DoFlow core does not provide this follow-up.');
  assert.equal(buttons(panel).length, 0, 'not auto: retrying an older core gives the same answer');
  assert.equal(panel.querySelector('.code-chip').textContent, 'core-lacks-verb · 501');
});

// ---- the doctor read controller -----------------------------------------------------------------

function deferred() {
  let resolve: any;
  let reject: any;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A fake GET that records each path and answers with the next scripted deferred. */
function fakeApi() {
  const calls: string[] = [];
  const pending: any[] = [];
  const apiGet = (p: string) => {
    calls.push(p);
    const d = deferred();
    pending.push(d);
    return d.promise;
  };
  return { calls, pending, apiGet };
}

const DOCTOR = (summary: number) => ({ v: 1, at: AT, refresh: null, doctor: { v: 1, exit: 0, summary: { probed: summary } } });

test('IC-016 createDoctorRead: open() makes one GET /api/doctor; a second open() makes none', async () => {
  const api = fakeApi();
  const changes: any[] = [];
  const read = doctorRead.createDoctorRead({ apiGet: api.apiGet, onChange: (state: any) => changes.push(state) });
  assert.deepEqual(read.state, { body: null, error: null, inFlight: false, refresh: null });
  const opened = read.open();
  assert.deepEqual(api.calls, ['/api/doctor']);
  assert.equal(read.state.inFlight, true);
  read.open();
  assert.deepEqual(api.calls, ['/api/doctor'], 'no second GET while the first runs');
  api.pending[0].resolve(DOCTOR(1));
  await opened;
  assert.deepEqual(read.state, { body: DOCTOR(1), error: null, inFlight: false, refresh: null });
  read.open();
  assert.deepEqual(api.calls, ['/api/doctor'], 'open() reads once per controller');
  assert.deepEqual(changes.map((s) => s.inFlight), [true, false]);
});

test('IC-016 createDoctorRead: refresh() makes one GET ?refresh=1 and none while a request is in flight; the last body stays', async () => {
  const api = fakeApi();
  const read = doctorRead.createDoctorRead({ apiGet: api.apiGet, onChange: () => {} });
  const opened = read.open();
  api.pending[0].resolve(DOCTOR(1));
  await opened;

  const first = read.refresh();
  assert.deepEqual(api.calls, ['/api/doctor', '/api/doctor?refresh=1']);
  assert.equal(read.state.inFlight, true);
  assert.deepEqual(read.state.body, DOCTOR(1), 'the last body stays while the refresh runs');
  const second = read.refresh();
  read.open();
  assert.deepEqual(api.calls, ['/api/doctor', '/api/doctor?refresh=1'], 'no call while in flight');
  api.pending[1].resolve({ ...DOCTOR(2), refresh: 'ran' });
  await Promise.all([first, second]);
  assert.deepEqual(read.state, { body: { ...DOCTOR(2), refresh: 'ran' }, error: null, inFlight: false, refresh: 'ran' });

  const third = read.refresh();
  assert.equal(api.calls.length, 3);
  api.pending[2].resolve({ ...DOCTOR(2), refresh: 'too-soon' });
  await third;
  assert.equal(read.state.refresh, 'too-soon');
});

test('IC-016 createDoctorRead: an error keeps the last body and records the classified failure', async () => {
  const api = fakeApi();
  const changes: any[] = [];
  const read = doctorRead.createDoctorRead({ apiGet: api.apiGet, onChange: (state: any) => changes.push(state) });
  const opened = read.open();
  api.pending[0].resolve({ ...DOCTOR(1), refresh: null });
  await opened;
  const refreshed = read.refresh();
  api.pending[1].reject({ status: 502, code: 'core-error', network: false });
  await refreshed;
  assert.deepEqual(read.state.body, DOCTOR(1), 'the last body is kept on an error');
  assert.equal(read.state.inFlight, false);
  assert.equal(read.state.refresh, null);
  assert.equal(read.state.error.key, 'core-error');
  assert.equal(read.state.error.status, 502);
  assert.deepEqual(changes.at(-1), read.state);

  // A failed first read: no body, the error; Refresh from there runs the same GET and clears the error.
  const api2 = fakeApi();
  const read2 = doctorRead.createDoctorRead({ apiGet: api2.apiGet, onChange: () => {} });
  const opened2 = read2.open();
  api2.pending[0].reject({ status: null, code: null, network: true });
  await opened2;
  assert.equal(read2.state.body, null);
  assert.equal(read2.state.error.key, 'offline');
  const again = read2.refresh();
  assert.deepEqual(api2.calls, ['/api/doctor', '/api/doctor?refresh=1']);
  api2.pending[1].resolve({ ...DOCTOR(3), refresh: 'ran' });
  await again;
  assert.equal(read2.state.error, null);
  assert.deepEqual(read2.state.body, { ...DOCTOR(3), refresh: 'ran' });
});

test('IC-016 createDoctorRead: a fake clock advanced 5 minutes makes no call (FR-024)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(AT) });
  const api = fakeApi();
  const read = doctorRead.createDoctorRead({ apiGet: api.apiGet, onChange: () => {} });
  const opened = read.open();
  api.pending[0].resolve(DOCTOR(1));
  await opened;
  for (let i = 0; i < 300; i += 1) mock.timers.tick(1000);
  assert.deepEqual(api.calls, ['/api/doctor'], 'no timer calls the controller');
});

test('IC-016 createDoctorRead: refuses a missing apiGet or onChange', () => {
  assert.throws(() => doctorRead.createDoctorRead({ onChange: () => {} }), TypeError);
  assert.throws(() => doctorRead.createDoctorRead({ apiGet: () => Promise.resolve(null) }), TypeError);
});
