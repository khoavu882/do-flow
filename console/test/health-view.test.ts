'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let view: any;
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
  value = '';
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
const buttons = (node: any): El[] => node.querySelectorAll('button');
const buttonNamed = (node: any, name: string) => buttons(node).find((b) => b.textContent === name) ?? null;
const flush = () => new Promise((resolve) => setImmediate(resolve));

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-health-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  await import(pathToFileURL(path.join(copy, 'views.js')).href);
  view = await import(pathToFileURL(path.join(copy, 'views', 'health.js')).href);
});
after(() => {
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
  else delete (globalThis as any).document;
  fs.rmSync(copy, { recursive: true, force: true });
});
const DOCTOR: any = {
  summary: { probed: 2, healthy: 1, unhealthy: 1, absent: 1, unverified: 1 },
  findings: [], warnings: [], findingsNotShown: 0, warningsNotShown: 0,
  harnesses: [{ id: 'codex', displayName: 'Codex', status: 'HEALTHY' }],
  externalTools: [{ id: 'git', displayName: 'Git', status: 'ABSENT', detail: 'not run' }],
  capabilities: [{ capability: 'read', status: 'PASS', activeProvider: null }],
  providers: [{ id: 'test', status: 'UNHEALTHY', answered: false, durationMs: null }],
  freshness: [{ providerId: 'test', label: 'Index', state: 'FRESH' }, { providerId: 'other', label: 'Other', state: 'UNAVAILABLE' }, { providerId: 'third', label: 'Third', state: 'UNKNOWN' }],
};
const STORAGE = { stores: [{ id: 'events', where: { anchor: 'project', rel: 'state' }, bound: '30 days', setting: 'storage.prune', entries: null, bytes: null, wouldPrune: 0, protected: 2, failed: 0, skipped: 'absent' }], storesNotShown: 0 };
const response = (refresh = 'ran') => ({ v: 1, at: '2026-11-09T10:00:00.000Z', refresh, doctor: structuredClone(DOCTOR) });
function inspector() { return { current: null as any, open(spec: any) { this.current = spec; }, close() { this.current = null; } }; }
function setup() {
  const pending: any[] = [];
  const calls: string[] = [];
  const apiGet = (url: string) => { calls.push(url); return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
  const local: any = { apiGet, inspector: inspector(), route: { id: 'health', params: {} }, link: () => {} };
  const render = () => view.renderHealth({ v: 1, at: '2026-11-09T10:00:00.000Z', storage: STORAGE }, {}, local);
  return { pending, calls, local, render };
}

test('doctor reads once per instance, retains its body during refresh, and reports too-soon and a failed read', async () => {
  const ctx = setup();
  const root = ctx.render();
  assert.deepEqual(ctx.calls, ['/api/doctor']);
  ctx.pending.shift().resolve(response()); await flush();
  assert.ok(root.textContent.includes('Doctor ran'));
  assert.ok(root.textContent.includes('No findings') && root.textContent.includes('No warnings'));
  assert.ok(root.textContent.includes('not run') && root.textContent.includes('not reported'));
  assert.deepEqual(root.querySelectorAll('.badge').map((b: El) => [b.textContent, b.getAttribute('data-state')]), [
    ['HEALTHY', 'done'], ['ABSENT', 'skipped'], ['PASS', 'done'], ['UNHEALTHY', 'failed'], ['FRESH', 'done'], ['UNAVAILABLE', 'failed'], ['UNKNOWN', 'unknown'],
  ]);
  const again = ctx.render();
  assert.equal(ctx.calls.length, 1, 'a poll or re-render does not read doctor');
  buttonNamed(again, 'Refresh')!.fire('click');
  assert.equal(ctx.calls[1], '/api/doctor?refresh=1');
  assert.equal(again.querySelector('.doctor-head').getAttribute('data-refreshing'), 'true');
  assert.ok(buttonNamed(again, 'Refresh')!.hasAttribute('disabled'));
  assert.ok(again.textContent.includes('HEALTHY'), 'last result stays during refresh');
  ctx.pending.shift().resolve(response('too-soon')); await flush();
  assert.ok(again.textContent.includes('Doctor ran less than 5 seconds ago; showing that result.'));
  buttonNamed(again, 'Refresh')!.fire('click');
  ctx.pending.shift().reject({ status: 502, code: 'core-error' }); await flush();
  assert.ok(again.textContent.includes('Could not load doctor'));
  assert.ok(again.textContent.includes('HEALTHY'), 'last result stays after failure');
});

test('storage unknown counts, inspector, telemetry, reroute and text safety', async () => {
  const ctx = setup();
  ctx.local.route.store = 'events';
  const root = ctx.render();
  ctx.pending.shift().resolve(response()); await flush();
  const link = root.querySelectorAll('a')[0];
  assert.equal(link.getAttribute('href'), '#/health/store/events');
  const text = root.textContent;
  assert.ok(text.includes('unknown') && text.includes('Telemetry contract version: unknown. No DoFlow output reports one.'));
  assert.ok(ctx.local.inspector.current.body.textContent.includes('<project>/state'));
  assert.ok(ctx.local.inspector.current.body.textContent.includes('30 days'));
  ctx.local.route.store = undefined;
  view.rerouteHealth(ctx.local);
  assert.equal(ctx.local.inspector.current, null);
  const planted = response(); planted.doctor.findings = [{ kind: 'warn', subject: '<img src=x>', detail: '<script>x</script>' }];
  buttonNamed(root, 'Refresh')!.fire('click'); ctx.pending.shift().resolve(planted); await flush();
  assert.ok(root.textContent.includes('<img src=x>'));
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.equal(root.querySelectorAll('script').length, 0);
  assert.equal(view.healthTitle({}, null), 'Health');
});
