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
  focus() { (globalThis as any).__focused = this; }
  key(key: string) { const event = { key, target: this, preventDefault() {} }; for (let n: any = this; n; n = n.parent) for (const fn of n.listeners?.get('keydown') ?? []) fn(event); }
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


const { spawnSync } = require('node:child_process');
const { project } = require('../src/project.ts');
const { anchorsOf } = require('../src/place.ts');
let MATRIX: any;
before(async () => {
  const root = path.join(__dirname, '..', '..');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/doflow.js'), 'worker-matrix', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const projected = project('worker-matrix', JSON.parse(result.stdout), { anchors: anchorsOf({ projectRoot: root, home: os.homedir() }) });
  assert.equal(projected.ok, true);
  MATRIX = projected.body;
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-workers-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true }); fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  await import(pathToFileURL(path.join(copy, 'views.js')).href);
  view = await import(pathToFileURL(path.join(copy, 'views', 'workers.js')).href);
});
after(() => { if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else delete (globalThis as any).document; fs.rmSync(copy, { recursive: true, force: true }); });
const AT = '2026-11-09T10:00:00.000Z';
const settings = { keys: [
  { key: 'workers.enabled', views: [{ value: ['codex', 'primary'], origin: { layer: 'project' } }] },
  { key: 'workers.models', views: [{ value: { codex: { standard: 'model-one' } }, origin: { layer: 'user' } }] },
  { key: 'workers.billing', views: [{ value: {}, origin: { layer: 'default' } }] },
] };
function setup(matrix: any = MATRIX) {
  const requests: string[] = []; let resolve: any;
  const inspector: any = { current: null, open(spec: any) { this.current = spec; }, close() { this.current = null; } };
  const local: any = { route: { id: 'workers', params: {} }, inspector, link: (patch: any) => { local.route.cell = patch?.cell; }, apiGet: (p: string) => { requests.push(p); return new Promise((r) => { resolve = r; }); } };
  const body = { sections: { matrix: matrix === null ? { ok: false, code: 'core-lacks-verb' } : { ok: true, data: matrix, at: AT }, settings: { ok: true, data: settings, at: AT } } };
  const render = () => view.renderWorkers(body, {}, local);
  return { requests, local, inspector, render, answer: (doctor: any) => resolve({ doctor, at: AT, refresh: 'ran' }) };
}
const gridcells = (root: any) => root.querySelectorAll('td').filter((el: El) => el.getAttribute('role') === 'gridcell');

test('matrix renders every harness and cell with readable states and a roving keyboard model', async () => {
  const ctx = setup(); const root = ctx.render();
  const matrix = root.querySelector('table.matrix');
  assert.equal(matrix.getAttribute('role'), 'grid'); assert.equal(matrix.getAttribute('aria-label'), 'Harness capabilities');
  assert.ok(matrix.querySelector('caption')); assert.equal(matrix.querySelectorAll('tbody')[0].querySelectorAll('tr').length, 7);
  assert.equal(gridcells(root).length, 140);
  assert.equal(gridcells(root).filter((td: El) => td.getAttribute('tabindex') === '0').length, 1);
  const pi = gridcells(root).find((td: El) => td.getAttribute('data-key') === 'pi/orchestration/spawn');
  assert.equal(pi?.textContent, 'Unsupported'); assert.equal(pi?.querySelector('.badge').getAttribute('data-state'), 'rejected');
  const first = gridcells(root)[0]; first.key('ArrowRight');
  const second = (globalThis as any).__focused; assert.equal(second.getAttribute('data-col'), '1'); assert.equal(second.getAttribute('tabindex'), '0');
  second.key('End'); const last = (globalThis as any).__focused; assert.equal(last.getAttribute('data-col'), '19');
  last.key('Home'); const back = (globalThis as any).__focused; assert.equal(back.getAttribute('data-col'), '0');
  back.key('ArrowDown'); const below = (globalThis as any).__focused; assert.equal(below.getAttribute('data-row'), '1');
  below.key('Enter'); assert.equal(below.getAttribute('aria-selected'), 'true'); assert.ok(ctx.local.route.cell);
  assert.ok(ctx.inspector.current); assert.deepEqual(ctx.requests, ['/api/doctor']);
});

test('inspector keeps evidence text inert and concept waits for doctor with no repeated reads', async () => {
  const matrix = structuredClone(MATRIX); const first = matrix.harnesses[0]; const name = matrix.groups.worker[0];
  first.cells.worker[name].evidence = ['repo/path/file.ts', 'https://example.invalid/a']; first.cells.worker[name].cut = true;
  const ctx = setup(matrix); ctx.local.route.cell = { harness: first.id, group: 'worker', cell: name };
  const root = ctx.render(); assert.ok(root.textContent.includes('not checked yet'));
  assert.ok(ctx.inspector.current.body.textContent.includes('https://example.invalid/a'));
  assert.equal(ctx.inspector.current.body.querySelectorAll('a').length, 0);
  assert.ok(ctx.inspector.current.body.textContent.includes('Some text of this cell was cut by DoFlow.'));
  assert.ok(root.textContent.includes('model-one') && root.textContent.includes('primary') && root.textContent.includes('project'));
  ctx.answer({ workers: { rows: [{ harness: 'codex', eligible: false, firstGap: { requirement: 'installed', result: 'fail', reason: 'missing' } }] }, workerPool: { harnesses: [{ harness: 'codex', installed: false, loginState: 'unknown' }] } }); await flush();
  assert.ok(root.textContent.includes('installed: fail: missing'));
  ctx.render(); assert.deepEqual(ctx.requests, ['/api/doctor']);
  const item = matrix.harnesses[0].cells.worker[name]; item.evidence = [];
  const other = setup(matrix); other.local.route.cell = { harness: first.id, group: 'worker', cell: name }; other.render();
  assert.ok(other.inspector.current.body.textContent.includes('No evidence recorded'));
});

test('missing matrix keeps settings and doctor panel usable', () => {
  const ctx = setup(null); const root = ctx.render();
  assert.ok(root.textContent.includes('This DoFlow core does not provide the worker matrix.'));
  assert.ok(root.textContent.includes('Worker settings')); assert.ok(root.textContent.includes('model-one'));
  assert.equal(root.querySelectorAll('table.matrix').length, 0);
  assert.equal(view.workersTitle({}, null), 'Workers');
});
