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
function setup(matrix: any = MATRIX, slots: any = { standard: 'model-one' }) {
  const requests: string[] = []; const pending = new Map<string, { resolve: (body: any) => void, reject: (error: any) => void }>();
  const inspector: any = { current: null, open(spec: any) { this.current = spec; }, close() { this.current = null; } };
  const local: any = { route: { id: 'workers', params: {} }, inspector, link: (patch: any) => { local.route.cell = patch?.cell; }, apiGet: (p: string) => { requests.push(p); return new Promise((resolve, reject) => { pending.set(p, { resolve, reject }); }); } };
  const body = { sections: { matrix: matrix === null ? { ok: false, code: 'core-lacks-verb' } : { ok: true, data: matrix, at: AT }, settings: { ok: true, data: { keys: settings.keys.map((k: any) => (k.key === 'workers.models' ? { ...k, views: [{ value: { codex: slots }, origin: { layer: 'user' } }] } : k)) }, at: AT } } };
  const render = () => view.renderWorkers(body, {}, local);
  return {
    requests, local, inspector, render,
    answerDoctorRefresh: () => pending.get('/api/doctor?refresh=1')!.resolve({ doctor: { workers: { rows: [] }, workerPool: { harnesses: [] } }, at: AT, refresh: 'ran' }),
    answer: (doctor: any) => pending.get('/api/doctor')!.resolve({ doctor, at: AT, refresh: 'ran' }),
    answerLogin: (harnesses: any[]) => pending.get('/api/harness-login')!.resolve({ v: 1, harnesses }),
    failLogin: () => pending.get('/api/harness-login')!.reject({ status: 502, code: 'core-contract-mismatch', network: false }),
  };
}
const gridcells = (root: any) => root.querySelectorAll('td').filter((el: El) => el.getAttribute('role') === 'gridcell');

test('matrix renders every harness and cell with readable states and a roving keyboard model', async () => {
  const ctx = setup(); const root = ctx.render();
  const matrix = root.querySelector('table.matrix');
  assert.equal(matrix.getAttribute('role'), 'grid'); assert.equal(matrix.getAttribute('aria-label'), 'Harness capabilities');
  assert.ok(matrix.querySelector('caption')); assert.equal(matrix.querySelectorAll('tbody')[0].querySelectorAll('tr').length, 7);
  // 165 T1: the column count is every capability key of the fixture (+ mainSession per harness), not a literal.
  const columnCount = Object.values(MATRIX.groups as Record<string, string[]>).reduce((n, names) => n + names.length, 0);
  assert.equal(gridcells(root).length, MATRIX.harnesses.length * columnCount);
  assert.equal(gridcells(root).filter((td: El) => td.getAttribute('tabindex') === '0').length, 1);
  const pi = gridcells(root).find((td: El) => td.getAttribute('data-key') === 'pi/orchestration/spawn');
  assert.equal(pi?.textContent, 'Unsupported'); assert.equal(pi?.querySelector('.badge').getAttribute('data-state'), 'rejected');
  const first = gridcells(root)[0]; first.key('ArrowRight');
  const second = (globalThis as any).__focused; assert.equal(second.getAttribute('data-col'), '1'); assert.equal(second.getAttribute('tabindex'), '0');
  second.key('End'); const last = (globalThis as any).__focused; assert.equal(last.getAttribute('data-col'), String(columnCount - 1));
  last.key('Home'); const back = (globalThis as any).__focused; assert.equal(back.getAttribute('data-col'), '0');
  back.key('ArrowDown'); const below = (globalThis as any).__focused; assert.equal(below.getAttribute('data-row'), '1');
  below.key('Enter'); assert.equal(below.getAttribute('aria-selected'), 'true'); assert.ok(ctx.local.route.cell);
  assert.ok(ctx.inspector.current); assert.deepEqual(ctx.requests, ['/api/doctor', '/api/harness-login']);
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
  ctx.answer({ workers: { rows: [{ harness: 'codex', eligible: false, firstGap: { requirement: 'installed', result: 'fail', reason: 'missing' } }] }, workerPool: { harnesses: [{ harness: 'codex', installed: false }] } }); await flush();
  assert.ok(root.textContent.includes('installed: fail: missing'));
  ctx.render(); assert.deepEqual(ctx.requests, ['/api/doctor', '/api/harness-login']);
  const item = matrix.harnesses[0].cells.worker[name]; item.evidence = [];
  const other = setup(matrix); other.local.route.cell = { harness: first.id, group: 'worker', cell: name }; other.render();
  assert.ok(other.inspector.current.body.textContent.includes('No evidence recorded'));
});

test('169: the Workers page shows each tier slot as bindingText, an object slot with its provider and effort', () => {
  const root = setup(MATRIX, { light: 'model-one', standard: { model: 'gpt-y', provider: 'openai', effort: 'low' }, frontier: { model: 'gpt-z' }, bad: 7 }).render();
  assert.ok(root.textContent.includes('light: model-one, standard: gpt-y (provider openai, effort low), frontier: gpt-z, bad: 7'), root.textContent);
});

test('missing matrix keeps settings and doctor panel usable', () => {
  const ctx = setup(null); const root = ctx.render();
  assert.ok(root.textContent.includes('This DoFlow core does not provide the worker matrix.'));
  assert.ok(root.textContent.includes('Worker settings')); assert.ok(root.textContent.includes('model-one'));
  assert.equal(root.querySelectorAll('table.matrix').length, 0);
  assert.equal(view.workersTitle({}, null), 'Workers');
});

const answerOf = (over: any) => ({ harness: 'codex', state: 'unknown', reason: 'never-checked', source: 'never-checked', at: null, billing: null, providers: [], provider: null, hint: null, expirySeen: false, last: null, caveat: null, ...over });
/** The Login cell of a worker row, by the worker's name in the first cell. */
const loginCellOf = (root: any, id: string) => root.querySelector('table.mtable').querySelectorAll('tr').find((tr: El) => tr.children[0]?.textContent === id)?.children[4].textContent;

test('172: the Login column reads GET /api/harness-login once, apart from doctor, and says the state and where it came from', async () => {
  const ctx = setup(); const root = ctx.render();
  assert.equal(loginCellOf(root, 'codex'), 'not checked yet', 'before the read answers');
  ctx.answerLogin([
    answerOf({ harness: 'codex', state: 'logged-in', reason: null, source: 'recipe', at: AT }),
    answerOf({ harness: 'claude', state: 'logged-in', reason: null, source: 'last-run', at: AT }),
    answerOf({ harness: 'pi', state: 'expired', reason: null, source: 'last-run', at: AT, provider: 'openai-codex' }),
    answerOf({ harness: 'copilot', state: 'logged-out', reason: 'logged-out', source: 'recipe', at: AT }),
    answerOf({ harness: 'kiro' }),
    answerOf({ harness: 'opencode', reason: 'no-recipe: its help documents no exit code' }),
    answerOf({ harness: 'antigravity', reason: 'stale', last: { state: 'logged-in', source: 'recipe', at: AT } }),
  ]);
  await flush();
  assert.deepEqual(['codex', 'claude', 'pi', 'copilot', 'kiro', 'opencode', 'antigravity'].map((id) => loginCellOf(root, id)),
    ['logged-in (login check)', 'logged-in (run)', 'expired (run)', 'logged-out (login check)', 'unknown (never checked)', 'unknown (no login check)', 'unknown (stale)']);
  ctx.render();
  assert.deepEqual(ctx.requests.filter((r: string) => r === '/api/harness-login'), ['/api/harness-login'], 'a repaint reads nothing again');
  ctx.answer({ workers: { rows: [] }, workerPool: { harnesses: [] } }); await flush();
  assert.equal(loginCellOf(root, 'codex'), 'logged-in (login check)', 'doctor answering later does not change the login cell');
});

test('172: a failed login read says unknown in the Login column and leaves the other columns alone; a harness the answer lacks is unknown', async () => {
  const ctx = setup(); const root = ctx.render();
  ctx.failLogin(); await flush();
  assert.equal(loginCellOf(root, 'codex'), 'unknown (could not read)', 'a failed read is not a real unknown');
  const other = setup(); const second = other.render();
  other.answerLogin([answerOf({ harness: 'pi', state: 'logged-in', reason: null, source: 'recipe', at: AT })]); await flush();
  assert.equal(loginCellOf(second, 'codex'), 'unknown');
});

test('172: each doctor refresh reads the login answer again; a failed re-read says could not read, a later good one answers', async () => {
  const ctx = setup(); const root = ctx.render();
  ctx.answerLogin([answerOf({ harness: 'codex', state: 'logged-in', reason: null, source: 'recipe', at: AT })]); await flush();
  ctx.answer({ workers: { rows: [] }, workerPool: { harnesses: [] } }); await flush();
  assert.equal(loginCellOf(root, 'codex'), 'logged-in (login check)');
  const reads = () => ctx.requests.filter((r: string) => r === '/api/harness-login').length;
  assert.equal(reads(), 1);
  void ctx.local.workersMemory.controller.refresh(); await flush();
  assert.equal(reads(), 2, 'the refresh read the login answer again');
  assert.ok(ctx.requests.includes('/api/doctor?refresh=1'));
  ctx.failLogin(); await flush();
  assert.equal(loginCellOf(root, 'codex'), 'unknown (could not read)', 'the old answer is not shown as if it were current');
  ctx.answerDoctorRefresh(); await flush();
  void ctx.local.workersMemory.controller.refresh(); await flush();
  assert.equal(reads(), 3);
  ctx.answerLogin([answerOf({ harness: 'codex', state: 'logged-out', reason: 'logged-out', source: 'recipe', at: AT })]); await flush();
  assert.equal(loginCellOf(root, 'codex'), 'logged-out (login check)');
});
