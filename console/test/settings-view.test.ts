'use strict';

// The Settings view (feature 151, plan task C.3; IC-017, IC-007, IC-012, IC-016; FR-004 to FR-010, FR-026, NFR-005,
// NFR-009). The body is the fixture world's own (D2): the settings part of the `--manage` world (helpers/manage-world.ts:
// a user file with `advice.enabled` true and an unknown key holding a planted email, a project file that sets
// `advice.kinds.task-class` and `workers.enabled`, which the user file also sets, and a local file that does not parse)
// is written to a scratch project, the real core answers `config list --json` (exit 1) and `config schema --json`, and the
// Console's own projectors (console/src/project.ts) build the `/api/settings` sections from them in process. As in
// figures.test.ts, the web root is copied beside a {"type":"module"} marker and imported from there (views.js first); a
// small fake DOM (elements and text nodes; a markup write throws) records what the view builds, and a fake inspector
// records what it shows.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { project } = require('../src/project.ts');
const { anchorsOf } = require('../src/place.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const REPO_ROOT = path.join(__dirname, '..', '..');
const CORE = path.join(REPO_ROOT, 'bin', 'doflow.js');
const VIEW_FILE = path.join(WEB_ROOT, 'views', 'settings.js');
const REGISTRY_KEYS: string[] = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'settings.json'), 'utf8')).keys);

const PLANTED_EMAIL = 'manage.person@example.invalid';
const PLANTED_MARKER = 'MANAGE-WORLD-MARKER-3c6f';
const UNKNOWN_KEY = `contact.${PLANTED_EMAIL}`;
const ENV_SENTENCE = 'Settings set by environment variables in the shell that started the Console are not visible here: the Console runs DoFlow without them, so a terminal in that shell may resolve a different value.';
const GROUPS = ['Workers', 'Advice and shadow', 'Review and debate', 'Rollout', 'Other'];
const COLUMNS = ['Key', 'Value', 'Type', 'Default', 'Scope', 'State', 'Layer', 'Source'];
const LAYERS = ['env', 'local', 'project', 'user', 'default'];
const AT = '2026-11-09T10:00:00.000Z';

let copy: string;
let world: string;
let view: any;
let savedDocument: PropertyDescriptor | undefined;
/** The projected `config-list` body of the project view (exit 1), of the global view (`-g`, exit 1), and `config-schema`. */
let effective: any;
let globalEffective: any;
let schema: any;
let raw: any;

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
    return elementsOf(this).filter((el) => el.matches(tag === '' ? null : tag, cls ?? null));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() {}
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
function elementsOf(node: any): El[] {
  return nodesOf(node).filter((n: any) => n instanceof El);
}
const byData = (node: any, name: string, value?: string) => elementsOf(node).filter((el) => el.hasAttribute(`data-${name}`) && (value === undefined || el.getAttribute(`data-${name}`) === value));
const textOf = (node: any) => node.textContent as string;
/** Text with each element's children joined, so cell words do not run together. */
const spaced = (node: any): string => (node instanceof Txt ? node.data : node.children.map(spaced).join(' ')).replace(/\s+/g, ' ').trim();

/** A fake inspector that records what is shown (shell.js `createInspector`'s surface). */
function fakeInspector() {
  const shown: any[] = [];
  let closes = 0;
  let current: any = null;
  return {
    shown,
    get closes() { return closes; },
    get current() { return current; },
    open(spec: any) { shown.push(spec); current = spec; },
    close() { closes += 1; current = null; },
    isOpen: () => current !== null,
    mode: () => 'dock',
    setInspectable() {},
  };
}

function localFor(route: any = { id: 'settings', params: {} }) {
  const links: any[] = [];
  const retries: number[] = [];
  return { inspector: fakeInspector(), route, links, retries, link: (patch: any) => { links.push(patch); }, retry: () => { retries.push(1); } };
}

const bodyOf = (eff: any = { ok: true, data: effective, at: AT }, sch: any = { ok: true, data: schema, at: AT }) => ({ v: 1, sections: { effective: eff, schema: sch } });
const render = (body: any = bodyOf(), local: any = localFor()) => ({ root: view.renderSettings(body, {}, local), local });

// ---- the fixture world ------------------------------------------------------------------------------

/** The core as the Console runs it: no DOFLOW_* variable but the world's own (console/src/verb-runner.ts childEnv). */
function core(args: string[], cwd: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, [CORE, ...args, '--json'], { cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
  return { exit: result.status, json: JSON.parse(result.stdout) };
}

before(async () => {
  world = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-settings-world-'));
  const home = path.join(world, 'home');
  const xdg = path.join(world, 'config');
  const main = path.join(world, 'project');
  const configHome = path.join(xdg, 'doflow');
  const layers = path.join(main, '.doflow');
  for (const dir of [home, configHome, layers]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', main], { stdio: 'ignore' });
  // helpers/manage-world.ts's settings layers, value for value.
  fs.writeFileSync(path.join(configHome, 'settings.json'), `${JSON.stringify({ 'advice.enabled': true, 'workers.enabled': ['codex', 'claude', 'primary'], 'workers.models': { codex: { standard: 'gpt-5-codex' } }, [UNKNOWN_KEY]: true }, null, 2)}\n`);
  fs.writeFileSync(path.join(layers, 'settings.json'), `${JSON.stringify({ 'advice.kinds.task-class': 'shadow', 'workers.enabled': ['codex', 'primary'] }, null, 2)}\n`);
  fs.writeFileSync(path.join(layers, 'settings.local.json'), `{ "advice.kinds.tier": "shadow", "${PLANTED_MARKER}": \n`);
  const env = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_UPKEEP: 'off' };
  const anchors = anchorsOf({ projectRoot: main, home });

  const list = core(['config', 'list'], main, env);
  assert.equal(list.exit, 1, 'the world makes config list exit 1 (D7)');
  raw = list.json;
  const projected = project('config-list', list.json, { anchors, exit: list.exit });
  assert.equal(projected.ok, true, 'the config-list projector reads the real body');
  effective = projected.body;
  const global = core(['config', 'list', '-g'], main, env);
  assert.equal(global.exit, 1);
  globalEffective = project('config-list', global.json, { anchors, exit: global.exit }).body;
  const sch = core(['config', 'schema'], main, env);
  assert.equal(sch.exit, 0);
  const schemaProjected = project('config-schema', sch.json, { anchors });
  assert.equal(schemaProjected.ok, true);
  schema = schemaProjected.body;

  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-settings-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  await import(pathToFileURL(path.join(copy, 'views.js')).href);
  view = await import(pathToFileURL(path.join(copy, 'views', 'settings.js')).href);
});
after(() => {
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
  else delete (globalThis as any).document;
  for (const dir of [copy, world]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// ---- premises of the world ----------------------------------------------------------------------

test('the world: 47 registry keys, the fail-safe exit, the unparseable local file and the unknown key note reach the projected body', () => {
  assert.equal(REGISTRY_KEYS.length, 47);
  assert.deepEqual(effective.keys.map((k: any) => k.key), REGISTRY_KEYS);
  assert.equal(effective.failSafe, true);
  assert.equal(effective.keys.find((k: any) => k.key === 'advice.enabled').views[0].origin.via, 'fail-safe');
  assert.ok(effective.files.some((f: any) => f.layer === 'local' && f.status === 'invalid' && f.code === 'unparseable'));
  assert.ok(effective.notes.some((n: any) => n.code === 'unknown-key' && n.text.includes('is not a DoFlow setting (ignored)')));
  assert.ok(raw.notes.some((n: any) => n.key === UNKNOWN_KEY), 'the raw body names the planted key');
  assert.equal(globalEffective.keys.find((k: any) => k.key === 'advice.enabled').views[0].origin.via, 'cross-key');
});

// ---- exports ------------------------------------------------------------------------------------

test('exports renderSettings, rerouteSettings and settingsTitle; the title is Settings', () => {
  assert.equal(typeof view.renderSettings, 'function');
  assert.equal(typeof view.rerouteSettings, 'function');
  assert.equal(view.settingsTitle({}, null), 'Settings');
  assert.equal(view.settingsTitle({}, bodyOf()), 'Settings');
});

// ---- groups and rows (FR-004, FR-005, FR-007) ----------------------------------------------------

test('47 keys in five groups: each a section.sgroup with an h2 and a captioned table.mtable of eight th scope="col" columns', () => {
  const { root } = render();
  const groups = root.querySelectorAll('section.sgroup');
  assert.deepEqual(groups.map((g: any) => textOf(g.querySelector('h2'))), GROUPS);
  const keys: string[] = [];
  for (const group of groups) {
    const h2 = group.querySelector('h2');
    assert.ok(h2.getAttribute('id'), 'the h2 has an id');
    assert.equal(group.getAttribute('aria-labelledby'), h2.getAttribute('id'));
    const tables = group.querySelectorAll('table.mtable');
    assert.equal(tables.length, 1);
    const table = tables[0];
    assert.ok(textOf(table.querySelector('caption')).length > 0, 'captioned');
    const heads = table.querySelector('thead').querySelectorAll('th');
    assert.deepEqual(heads.map((th: any) => textOf(th)), COLUMNS);
    for (const th of heads) assert.equal(th.getAttribute('scope'), 'col');
    for (const tr of table.querySelector('tbody').querySelectorAll('tr')) {
      const cells = tr.children.filter((c: any) => c instanceof El && (c.tagName === 'td' || c.tagName === 'th'));
      assert.equal(cells.length, 8, 'eight cells per row');
      for (const cell of cells) assert.ok(textOf(cell).trim().length > 0, `no empty cell in ${tr.getAttribute('data-key')}`);
      keys.push(tr.getAttribute('data-key'));
    }
  }
  assert.equal(keys.length, 48, '47 keys, storage.prune twice');
  assert.deepEqual([...new Set(keys)].sort(), [...REGISTRY_KEYS].sort(), 'every registry key, none missing or twice');
  assert.deepEqual(groups.map((g: any) => new Set(g.querySelectorAll('tr').map((tr: any) => tr.getAttribute('data-key')).filter(Boolean)).size), [7, 21, 7, 1, 11]);
});

test('the Key cell links to #/settings/<key>; the row reads the body\'s value, type, default, scope, state, layer and source', () => {
  const { root } = render();
  const row = (key: string) => root.querySelectorAll('tr').find((tr: any) => tr.getAttribute('data-key') === key);
  const cells = (key: string) => row(key).children.filter((c: any) => c instanceof El).map((c: any) => spaced(c));
  for (const key of REGISTRY_KEYS) {
    const link = row(key).querySelector('a');
    assert.equal(link.getAttribute('href'), `#/settings/${key}`, key);
    assert.equal(textOf(link), key);
  }
  // workers.enabled: the project layer wins over the user layer.
  const workers = cells('workers.enabled');
  assert.deepEqual(workers.slice(1), ['["codex","primary"]', 'worker-list', '["claude","codex","opencode","pi","copilot","kiro","antigravity","primary"]', 'narrow-only', 'ok', 'project', '<project layers>/settings.json']);
  // advice.model: no value at any layer reads as the core reports it, "not set", never an invented value.
  const model = cells('advice.model');
  assert.equal(model[1], 'not set');
  assert.equal(model[3], 'not set', 'its default is null too');
  // A fail-safe key names its state with the core's via word.
  assert.match(cells('advice.enabled')[5], /fail-safe/);
  // The default layer's source is the registry file.
  assert.equal(cells('debate.preset')[6], 'default');
  assert.equal(cells('debate.preset')[7], 'core/registry/settings.json');
});

test('storage.prune: a "project view" and a "global view" row, each with its own layer and source', () => {
  const { root } = render();
  const rows = root.querySelectorAll('tr').filter((tr: any) => tr.getAttribute('data-key') === 'storage.prune');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((tr: any) => tr.getAttribute('data-view')), ['project', 'global']);
  assert.match(spaced(rows[0].children[0]), /project view/);
  assert.match(spaced(rows[1].children[0]), /global view/);
  const entry = effective.keys.find((k: any) => k.key === 'storage.prune');
  for (const [index, tr] of rows.entries()) {
    const cells = tr.children.filter((c: any) => c instanceof El).map((c: any) => spaced(c));
    assert.equal(cells[6], entry.views[index].origin.layer);
  }
  const sources = rows.map((tr: any) => spaced(tr.children[7]));
  assert.notDeepEqual(sources[0], undefined);
  assert.equal(rows.map((tr: any) => spaced(tr.children[6])).join(' '), entry.views.map((v: any) => v.origin.layer).join(' '));
});

test('every meta.securityRelevant key carries .tag "Security-relevant" with an icon and the word; no other key does', () => {
  const { root } = render();
  for (const entry of effective.keys) {
    for (const tr of root.querySelectorAll('tr').filter((r: any) => r.getAttribute('data-key') === entry.key)) {
      const tags = tr.querySelectorAll('.tag').filter((t: any) => textOf(t).includes('Security-relevant'));
      assert.equal(tags.length, entry.meta.securityRelevant ? 1 : 0, entry.key);
      if (tags.length) {
        assert.equal(textOf(tags[0]), 'Security-relevant');
        assert.equal(tags[0].querySelectorAll('svg').length, 1, 'an icon');
      }
    }
  }
  const marked = (key: string) => root.querySelectorAll('tr').find((tr: any) => tr.getAttribute('data-key') === key).querySelectorAll('.tag').length;
  assert.equal(marked('workers.enabled'), 1);
  assert.equal(marked('advice.enabled'), 1);
  assert.equal(marked('storage.retentionHours'), 0);
});

test('value words: null reads "not set", (withheld) reads "withheld", everything else is JSON text', () => {
  const data = structuredClone(effective);
  const entry = data.keys.find((k: any) => k.key === 'primary.model');
  entry.views[0].value = '(withheld)';
  entry.meta.default = '(withheld)';
  const { root } = render(bodyOf({ ok: true, data, at: AT }));
  const cells = root.querySelectorAll('tr').find((tr: any) => tr.getAttribute('data-key') === 'primary.model').children.map((c: any) => spaced(c));
  assert.equal(cells[1], 'withheld');
  assert.equal(cells[3], 'withheld');
  const tier = root.querySelectorAll('tr').find((tr: any) => tr.getAttribute('data-key') === 'advice.kinds.tier').children.map((c: any) => spaced(c));
  assert.equal(tier[1], '"off"');
});

// ---- the top of the body (FR-008, FR-009, FR-010) ------------------------------------------------

test('the environment sentence comes first, once', () => {
  const { root } = render();
  const first = elementsOf(root).find((el) => el.tagName === 'p');
  assert.equal(textOf(first), ENV_SENTENCE);
  assert.equal(elementsOf(root).filter((el) => el.children.some((c: any) => c instanceof Txt && c.data === ENV_SENTENCE)).length, 1);
  assert.ok(textOf(root).indexOf(ENV_SENTENCE) < textOf(root).indexOf('Read '), 'before the read line and the layer list');
});

test('fail-safe is data: a notice names each fail-safe key with the core\'s reason and its candidates, and no error state is shown', () => {
  const { root } = render();
  const notices = byData(root, 'notice', 'fail-safe');
  assert.equal(notices.length, 1);
  const notice = notices[0];
  const viaKeys = effective.keys.filter((k: any) => k.views.some((v: any) => v.origin.via === 'fail-safe' || v.origin.via === 'cross-key')).map((k: any) => k.key);
  assert.ok(viaKeys.includes('advice.enabled'));
  const items = notice.querySelectorAll('li').filter((li: any) => li.hasAttribute('data-key'));
  assert.deepEqual(items.map((li: any) => li.getAttribute('data-key')), viaKeys);
  const enabled = spaced(items.find((li: any) => li.getAttribute('data-key') === 'advice.enabled'));
  assert.match(enabled, /fail-safe/);
  assert.ok(enabled.includes(effective.errors.find((e: any) => e.key === 'advice.enabled').reason), 'the core\'s reason from errors[]');
  assert.match(enabled, /local invalid/, 'its candidates');
  assert.equal(byData(root, 'state', 'error').length, 0, 'never the error state');
  assert.equal(root.querySelectorAll('.state-panel').length, 0);
  assert.equal(byData(root, 'state', 'ready').length, 2, 'both sections render as data');
  // Under -g the cross-key rule fires: the notice names it with the core's cross-key error.
  const globalRoot = render(bodyOf({ ok: true, data: globalEffective, at: AT })).root;
  const globalItem = byData(globalRoot, 'notice', 'fail-safe')[0].querySelectorAll('li').find((li: any) => li.getAttribute('data-key') === 'advice.enabled');
  const crossKey = globalEffective.errors.find((e: any) => e.key === 'advice.enabled' && e.code === 'cross-key');
  assert.ok(crossKey);
  assert.match(spaced(globalItem), /cross-key/);
  assert.ok(spaced(globalItem).includes(crossKey.reason));
  // No fail-safe and no via: no notice.
  const calm = structuredClone(effective);
  calm.failSafe = false;
  for (const k of calm.keys) for (const v of k.views) v.origin.via = null;
  assert.equal(byData(render(bodyOf({ ok: true, data: calm, at: AT })).root, 'notice', 'fail-safe').length, 0);
});

test('the layer files: layer, placed file, kind, status and code; the local file reads invalid with unparseable', () => {
  const { root } = render();
  const table = root.querySelectorAll('table').find((t: any) => t.getAttribute('data-table') === 'files');
  assert.ok(table);
  assert.deepEqual(table.querySelector('thead').querySelectorAll('th').map((th: any) => textOf(th)), ['Layer', 'File', 'Kind', 'Status', 'Code']);
  for (const th of table.querySelector('thead').querySelectorAll('th')) assert.equal(th.getAttribute('scope'), 'col');
  const rows = table.querySelector('tbody').querySelectorAll('tr').map((tr: any) => tr.children.map((c: any) => spaced(c)));
  assert.equal(rows.length, effective.files.length);
  assert.ok(rows.some((r: string[]) => r.join('|') === 'local|<project layers>/settings.local.json|settings|invalid|unparseable'), JSON.stringify(rows));
  assert.ok(rows.some((r: string[]) => r[0] === 'user' && r[1] === '<config home>/settings.json' && r[3] === 'ok'));
  for (const r of rows) for (const cell of r) assert.ok(cell.length > 0, 'no empty cell');
});

test('errors and notes, one line each: the unknown key shows the core\'s note, the planted email masked', () => {
  const { root } = render();
  const lines = byData(root, 'issue');
  assert.equal(lines.length, effective.errors.length + effective.notes.length);
  const unknown = lines.filter((li) => li.getAttribute('data-code') === 'unknown-key');
  assert.equal(unknown.length, 1);
  assert.match(spaced(unknown[0]), /is not a DoFlow setting \(ignored\)/);
  assert.match(spaced(unknown[0]), /<config home>\/settings\.json/);
  const error = lines.find((li) => li.getAttribute('data-code') === 'unparseable');
  assert.match(spaced(error), /advice\.enabled/);
  assert.match(spaced(error), /<project layers>\/settings\.local\.json/);
  assert.ok(spaced(error).includes(effective.errors.find((e: any) => e.code === 'unparseable').reason));
  for (const planted of [PLANTED_EMAIL, PLANTED_MARKER, world]) assert.equal(textOf(root).includes(planted), false, `${planted} is not on the page`);
});

test('the locked rules: each schema invariant with its id, statement and enforcing verb', () => {
  const { root } = render();
  const rules = byData(root, 'invariant');
  assert.equal(rules.length, schema.invariants.length);
  assert.ok(rules.length >= 8);
  for (const [index, invariant] of schema.invariants.entries()) {
    const line = spaced(rules[index]);
    assert.equal(rules[index].getAttribute('data-invariant'), invariant.id);
    assert.ok(line.includes(invariant.id) && line.includes(invariant.statement) && line.includes(invariant.enforcedBy), line);
  }
});

// ---- the inspector (FR-006, FR-009) ----------------------------------------------------------------

/** The layers list of a shown panel as `[layer, text]`. */
const layersOf = (panel: any) => byData(panel, 'layer').map((li) => [li.getAttribute('data-layer'), spaced(li)]);

test('the inspector for workers.enabled, set at the user and the project layer: description, type, values, no variable, every layer', () => {
  const { local } = render(bodyOf(), localFor({ id: 'settings', params: {}, key: 'workers.enabled' }));
  assert.equal(local.inspector.shown.length, 1);
  const spec = local.inspector.current;
  const panel = spec.body;
  assert.equal(spec.labelledBy, 'settings-panel-title');
  assert.equal(textOf(panel.querySelector('h2')), 'workers.enabled');
  assert.equal(panel.querySelector('h2').getAttribute('id'), 'settings-panel-title');
  const text = spaced(panel);
  const entry = effective.keys.find((k: any) => k.key === 'workers.enabled');
  assert.ok(text.includes(entry.meta.description), 'the description');
  assert.ok(text.includes('worker-list'), 'the type');
  assert.ok(text.includes('Allowed values'), 'a closed set');
  for (const value of entry.meta.values) assert.ok(text.includes(JSON.stringify(value)), value);
  assert.ok(text.includes('no environment variable'));
  const layers = layersOf(panel);
  assert.deepEqual(layers.map(([layer]) => layer), LAYERS, 'every layer, in the order env, local, project, user, default');
  const by = Object.fromEntries(layers);
  assert.match(by.env, /no value at this layer/);
  assert.match(by.local, /invalid/);
  assert.ok(by.local.includes(entry.views[0].candidates.find((c: any) => c.layer === 'local').reason));
  assert.match(by.project, /decided/);
  assert.match(by.project, /\["codex","primary"\]/, 'the display');
  assert.match(by.user, /overridden/);
  assert.match(by.user, /\["codex","claude","primary"\]/);
  assert.match(by.default, /no value at this layer/);
  assert.equal(panel.querySelectorAll('ol.candidates').length, 1);
  // The owner is the key's link, so the focus goes back to it.
  assert.equal(spec.owner.tagName, 'a');
  assert.equal(spec.owner.getAttribute('href'), '#/settings/workers.enabled');
});

test('the inspector for a key with a variable: its name, a range from config-schema, and the env layer "not visible to the Console"', () => {
  const { local } = render(bodyOf(), localFor({ id: 'settings', params: {}, key: 'team.writerCap' }));
  const panel = local.inspector.current.body;
  const text = spaced(panel);
  assert.ok(text.includes('DOFLOW_TEAM_WRITER_CAP'));
  assert.ok(text.includes('Range'));
  assert.ok(text.includes('1 to 8'), text);
  const by = Object.fromEntries(layersOf(panel));
  assert.match(by.env, /not visible to the Console/);
  assert.doesNotMatch(by.env, /no value at this layer/, 'the removal is never read as no environment value');
});

test('the inspector for storage.prune lists the layers of each view', () => {
  const { local } = render(bodyOf(), localFor({ id: 'settings', params: {}, key: 'storage.prune' }));
  const panel = local.inspector.current.body;
  assert.equal(panel.querySelectorAll('ol.candidates').length, 2);
  assert.deepEqual(panel.querySelectorAll('h3').map((h3: any) => textOf(h3)).filter((t: string) => /view/.test(t)), ['project view', 'global view']);
  assert.equal(layersOf(panel).length, 10);
});

test('reroute: a route key opens its panel, a route without one hides it; closing the panel clears the address', () => {
  const local = localFor();
  view.renderSettings(bodyOf(), {}, local);
  assert.equal(local.inspector.shown.length, 0, 'no key, no panel');
  local.route = { id: 'settings', params: {}, key: 'advice.enabled' };
  view.rerouteSettings(local);
  assert.equal(local.inspector.shown.length, 1);
  assert.equal(textOf(local.inspector.current.body.querySelector('h2')), 'advice.enabled');
  local.route = { id: 'settings', params: {}, key: 'review.rounds' };
  view.rerouteSettings(local);
  assert.equal(textOf(local.inspector.current.body.querySelector('h2')), 'review.rounds');
  assert.ok(spaced(local.inspector.current.body).includes('1 to 3'));
  local.inspector.current.onClose();
  assert.deepEqual(local.links, [null], 'the close writes the base address');
  local.route = { id: 'settings', params: {}, key: undefined };
  const closes = local.inspector.closes;
  view.rerouteSettings(local);
  assert.ok(local.inspector.closes > closes, 'the panel is taken away');
  // A key this body does not list: the panel says so instead of showing an invented setting.
  local.route = { id: 'settings', params: {}, key: 'not.listed' };
  view.rerouteSettings(local);
  assert.match(spaced(local.inspector.current.body), /not\.listed/);
  assert.match(spaced(local.inspector.current.body), /not a setting this DoFlow core lists/);
  // A reroute before any render keeps the key for the first render.
  const early: any = { inspector: fakeInspector(), route: { id: 'settings', params: {}, key: 'team.writerCap' } };
  view.rerouteSettings(early);
  view.renderSettings(bodyOf(), {}, early);
  assert.equal(textOf(early.inspector.current.body.querySelector('h2')), 'team.writerCap');
});

// ---- sections (FR-029, IC-016) ------------------------------------------------------------------

test('a schema section with core-lacks-verb: the not-in-core sentence while effective renders every key', () => {
  const { root, local } = render(bodyOf(undefined, { ok: false, code: 'core-lacks-verb' }), localFor({ id: 'settings', params: {}, key: 'team.writerCap' }));
  const missing = byData(root, 'state', 'not-in-core');
  assert.equal(missing.length, 1);
  assert.equal(textOf(missing[0]), 'This DoFlow core does not provide the settings schema.');
  assert.equal(byData(root, 'state', 'error').length, 0);
  assert.equal(new Set(root.querySelectorAll('tr').map((tr: any) => tr.getAttribute('data-key')).filter(Boolean)).size, 47);
  assert.equal(byData(root, 'invariant').length, 0);
  assert.match(spaced(local.inspector.current.body), /Range unknown/, 'the range is unknown without the schema, never invented');
});

test('an effective section that failed: an inline error with Retry, which asks the view to read again; the schema still renders', () => {
  const { root, local } = render(bodyOf({ ok: false, code: 'core-error' }));
  const errors = byData(root, 'state', 'error');
  assert.equal(errors.length, 1);
  assert.equal(root.querySelectorAll('section.sgroup').length, 0);
  assert.equal(byData(root, 'invariant').length, schema.invariants.length);
  const retry = errors[0].querySelectorAll('button').find((b: any) => textOf(b) === 'Retry');
  if (!retry) throw new Error('Retry button is missing');
  retry.fire('click');
  assert.deepEqual(local.retries, [1]);
  assert.equal(textOf(root).indexOf(ENV_SENTENCE), 0, 'the environment sentence still leads');
});

test('a schema section that failed retries through the shell callback while effective settings render', () => {
  const { root, local } = render(bodyOf(undefined, { ok: false, code: 'core-error' }));
  assert.equal(root.querySelectorAll('section.sgroup').length, 5);
  const errors = byData(root, 'state', 'error');
  assert.equal(errors.length, 1);
  const retry = errors[0].querySelectorAll('button').find((b: any) => textOf(b) === 'Retry');
  if (!retry) throw new Error('Retry button is missing');
  retry.fire('click');
  assert.deepEqual(local.retries, [1]);
});

test('an effective body with no keys shows the empty copy: the core listed no settings', () => {
  const data = { ...structuredClone(effective), keys: [] };
  const { root } = render(bodyOf({ ok: true, data, at: AT }));
  assert.equal(root.querySelectorAll('section.sgroup').length, 0);
  assert.match(textOf(root), /The DoFlow core listed no settings/);
});

// ---- no edit control, text nodes only (FR-007, NFR-005) ----------------------------------------------

const FORBIDDEN_TAGS = ['input', 'textarea', 'select', 'form'];
const WRITE_TEXT = /config\s+(?:set|unset)/i;

function forbidden(root: any): string[] {
  const found: string[] = [];
  for (const el of elementsOf(root)) {
    if (FORBIDDEN_TAGS.includes(el.tagName.toLowerCase())) found.push(el.tagName);
    if (el.hasAttribute('contenteditable')) found.push('contenteditable');
  }
  if (WRITE_TEXT.test(textOf(root))) found.push('write command text');
  return found;
}

test('no input, textarea, select, form or contenteditable and no config set or unset text, in the page, the panels or the module', () => {
  const variants = [
    render(bodyOf(), localFor({ id: 'settings', params: {}, key: 'workers.enabled' })),
    render(bodyOf({ ok: true, data: globalEffective, at: AT }), localFor({ id: 'settings', params: {}, key: 'storage.prune' })),
    render(bodyOf(undefined, { ok: false, code: 'core-lacks-verb' })),
    render(bodyOf({ ok: false, code: 'core-error' })),
  ];
  for (const { root, local } of variants) {
    assert.deepEqual(forbidden(root), []);
    for (const spec of local.inspector.shown) assert.deepEqual(forbidden(spec.body), []);
  }
  for (const key of REGISTRY_KEYS) {
    const local = localFor({ id: 'settings', params: {}, key });
    view.renderSettings(bodyOf(), {}, local);
    assert.deepEqual(forbidden(local.inspector.current.body), [], key);
  }
  const source = fs.readFileSync(VIEW_FILE, 'utf8');
  assert.doesNotMatch(source, WRITE_TEXT);
  assert.doesNotMatch(source, /contenteditable/i);
  assert.doesNotMatch(source, /['"`](?:input|textarea|select|form)['"`]/);
});

test('control: the forbidden scan finds a planted field and a planted write command', () => {
  const root = doc.createElement('div');
  root.append(doc.createElement('input'));
  root.append('run doflow config set workers.enabled');
  assert.deepEqual(forbidden(root), ['input', 'write command text']);
});

test('text nodes only: a planted markup string in the body reaches the page as text', () => {
  const data = structuredClone(effective);
  const entry = data.keys.find((k: any) => k.key === 'workers.enabled');
  entry.meta.description = '<img src=x onerror=alert(1)>';
  entry.views[0].value = '<b>bold</b>';
  data.notes[0].text = '<script>x</script>';
  const local = localFor({ id: 'settings', params: {}, key: 'workers.enabled' });
  const root = view.renderSettings(bodyOf({ ok: true, data, at: AT }), {}, local);
  for (const node of [root, local.inspector.current.body]) {
    assert.ok(nodesOf(node).every((n: any) => n instanceof El || n instanceof Txt));
    for (const tag of ['img', 'b', 'script']) assert.equal(node.querySelectorAll(tag).length, 0, tag);
  }
  assert.ok(textOf(local.inspector.current.body).includes('<img src=x onerror=alert(1)>'), 'whole, as the server sent it (D12)');
  assert.ok(textOf(root).includes('"<b>bold</b>"'));
  assert.ok(textOf(root).includes('<script>x</script>'));
});
