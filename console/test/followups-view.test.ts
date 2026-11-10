'use strict';

// The Follow-ups view (feature 151, IC-019; plan task C.5; FR-002, FR-011, FR-012, FR-026, NFR-005, NFR-009). Like
// figures.test.ts, the web root is copied beside a {"type":"module"} marker and the modules are imported from there (views.js
// first, the page's own import order). A small fake DOM (elements and text nodes; a markup write throws) records what the view
// builds; `apiGet` is a fake over a world of 60 open follow-ups that records every path it is asked for.

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
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-followups-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  await import(pathToFileURL(path.join(copy, 'views.js')).href);
  view = await import(pathToFileURL(path.join(copy, 'views', 'followups.js')).href);
});
after(() => {
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
  else delete (globalThis as any).document;
  fs.rmSync(copy, { recursive: true, force: true });
});

// ---- the world ----------------------------------------------------------------------------------

const AT = '2026-11-09T10:00:00.000Z';
const fuId = (n: number) => `FU-${String(n).padStart(6, '0')}`;
const cursorAt = (n: number) => `${n}:20261109T100000000Z-${String(n - 1).padStart(6, '0')}`;
const OPEN = Array.from({ length: 60 }, (_, i) => ({ id: fuId(i), statement: `Open follow-up number ${i}`, state: 'open' }));
const TAKEN = [{ id: 'FU-t00001', statement: 'A taken one', state: 'taken' }];

const EMPTY_PROBLEMS = { conflicts: { n: 0, rows: [] }, unreadable: { n: 0, rows: [] } };

function listBody(state: string, cursor: string | null, problems: any = EMPTY_PROBLEMS) {
  const all = state === 'open' ? OPEN : state === 'taken' ? TAKEN : state === 'all' ? [...OPEN, ...TAKEN] : [];
  const start = cursor === null ? 0 : Number(cursor.split(':')[0]);
  const items = all.slice(start, start + 25);
  const end = start + items.length;
  return { v: 1, state, count: all.length, shown: items.length, nextCursor: end < all.length ? cursorAt(end) : null, items, ...problems };
}

const OVERVIEW = {
  v: 1,
  mode: 'maintain',
  releaseMode: 'tagged',
  integrationRef: 'main',
  gitError: 'git could not read origin',
  followupsOpen: 60,
  intents: [{ where: { anchor: 'project', rel: 'agent-docs/intent.md' }, items: ['FU-000001', 'FU-000002'] }],
  intentsNotShown: 0,
  goals: [
    {
      goal: 'goal-ship-console', outcome: 'The Console shows management screens', items: { met: 3, total: 3 }, proposeDone: true,
      features: { finished: { count: 1, shown: ['feat-a'] }, awaitingRelease: { count: 0, shown: [] }, inProgress: { count: 0, shown: [] }, unknown: { count: 0, shown: [] } },
      nudges: ['every item is met'], conflicts: 0,
    },
    {
      goal: 'goal-docs', outcome: 'Docs are complete', items: { met: 1, total: 4 }, proposeDone: false,
      features: { finished: { count: 0, shown: [] }, awaitingRelease: { count: 0, shown: [] }, inProgress: { count: 1, shown: ['feat-docs'] }, unknown: { count: 0, shown: [] } },
      nudges: [], conflicts: 0,
    },
  ],
  goalsNotShown: 0,
  features: {
    finished: { count: 3, shown: ['feat-a', 'feat-b'] },
    awaitingRelease: { count: 1, shown: ['feat-c'] },
    inProgress: { count: 2, shown: ['feat-d', 'feat-e'] },
    unknown: { count: 0, shown: [] },
  },
  conflicts: 0,
  unreadable: 0,
  integrationBehind: null,
  note: null,
};

const RECORD = {
  id: 'FU-000003',
  statement: 'Statement of number three',
  source: { kind: 'stage', feature: '151-console-v2-manage', stage: 'review' },
  state: 'taken',
  takenBy: 'kiro-agent',
  intent: { anchor: 'project', rel: 'agent-docs/intent.md' },
  fix: 'Raise the ceiling in its own commit',
  added: '2026-11-01',
  excerpt: 'An excerpt of the report',
  body: 'on-this-machine',
  history: [{ type: 'filed', at: '2026-11-01T09:00:00.000Z', by: 'review' }, { type: 'taken', at: '2026-11-02T09:00:00.000Z', by: 'kiro-agent' }],
  historyNotShown: 4,
};

type Answer = (p: string) => any;

/** The route body of `/api/followups` and every record, scripted by path; each path asked for is recorded. */
function fakeApi(options: { overview?: any, problems?: any, records?: Record<string, Answer> } = {}) {
  const calls: string[] = [];
  const apiGet = (p: string) => {
    calls.push(p);
    const record = /^\/api\/followups\/(FU-[0-9a-z]{6})$/.exec(p);
    if (record) {
      const answer = options.records?.[record[1]];
      if (answer) return answer(p);
      return Promise.resolve({ v: 1, followup: { ...RECORD, id: record[1] } });
    }
    const url = new URL(p, 'http://localhost');
    assert.equal(url.pathname, '/api/followups');
    const state = url.searchParams.get('state') ?? 'open';
    const cursor = url.searchParams.get('cursor');
    const overview = options.overview ?? { ok: true, data: OVERVIEW, at: AT };
    return Promise.resolve({ v: 1, state, cursor, sections: { list: { ok: true, data: listBody(state, cursor, options.problems), at: AT }, overview } });
  };
  return { calls, apiGet };
}

/** A fake shell inspector: what is open, and how often it was opened and closed. */
function fakeInspector() {
  const inspector: any = {
    current: null as any,
    opened: 0,
    closed: 0,
    open(spec: any) { if (inspector.current && inspector.current.onClose) inspector.current.onClose(); inspector.current = spec; inspector.opened += 1; },
    close() { const was = inspector.current; inspector.current = null; inspector.closed += 1; if (was && was.onClose) was.onClose(); },
  };
  return inspector;
}

/** A view instance's memory as the shell gives it, and the first load and render. */
async function openView(api: any, route: any = { id: 'followups', params: {} }) {
  const inspector = fakeInspector();
  const links: any[] = [];
  const local: any = { inspector, route, link: (patch: any) => { links.push(patch); return true; } };
  const data = await view.loadFollowups(local, api.apiGet);
  const root = view.renderFollowups(data, route.params, local);
  return { local, root, inspector, links, data };
}

const countLine = (root: any) => root.querySelector('p.followups__count')?.textContent ?? null;
const rowIds = (root: any) => root.querySelectorAll('table.mtable')[0].querySelectorAll('a').map((a: El) => a.textContent);
const bodyText = (node: any) => {
  const parts: string[] = [];
  const walk = (n: any) => { if (n instanceof Txt) parts.push(n.data); else for (const c of n.children) walk(c); };
  walk(node);
  return parts.join(' ');
};

// ---- the list, the paging and the filter --------------------------------------------------------

test('IC-019 first page: 60 open follow-ups paged at 25 with the not-shown count, Next page and no First page', async () => {
  const api = fakeApi();
  const { root, local } = await openView(api);
  assert.deepEqual(api.calls, ['/api/followups?state=open'], 'load reads the list with the filter of local');
  assert.equal(local.state, 'open');
  assert.equal(local.cursor, null);
  assert.equal(countLine(root), '60 open follow-ups; showing 25; 35 not shown');
  const table = root.querySelector('table.mtable');
  assert.ok(table, 'a table.mtable');
  assert.ok(table.querySelector('caption'), 'the table has a caption');
  assert.deepEqual(table.querySelectorAll('th').map((th: El) => th.textContent), ['ID', 'State', 'Statement']);
  assert.ok(table.querySelectorAll('th').every((th: El) => th.getAttribute('scope') === 'col'));
  const links = table.querySelectorAll('a');
  assert.equal(links.length, 25);
  assert.equal(links[0].textContent, 'FU-000000');
  assert.equal(links[0].getAttribute('href'), '#/followups/FU-000000');
  const firstRow = table.querySelectorAll('tbody')[0].querySelectorAll('tr')[0];
  assert.deepEqual(firstRow.querySelectorAll('td').map((td: El) => td.textContent), ['FU-000000', 'open', 'Open follow-up number 0']);
  assert.ok(buttonNamed(root, 'Next page'), 'Next page while a nextCursor is given');
  assert.equal(buttonNamed(root, 'First page'), null, 'no First page without a cursor');
  const select = root.querySelector('select');
  assert.ok(select, 'a state select');
  const label = root.querySelector('label');
  assert.equal(label.getAttribute('for'), select.getAttribute('id'), 'the select is labelled');
  assert.deepEqual(select.querySelectorAll('option').map((o: El) => [o.getAttribute('value'), o.textContent]),
    [['open', 'Open'], ['taken', 'Taken'], ['done', 'Done'], ['dismissed', 'Dismissed'], ['all', 'All']]);
  assert.ok(select.querySelectorAll('option')[0].hasAttribute('selected'), 'Open is the selected state');
  assert.ok(nodesOf(root).every((n: any) => n instanceof El || n instanceof Txt), 'text nodes only');
});

test('IC-019 next and first page: the cursor comes from nextCursor, the not-shown count follows, First page clears it', async () => {
  const api = fakeApi();
  const { root, local } = await openView(api);
  buttonNamed(root, 'Next page')!.fire('click');
  await flush();
  assert.equal(api.calls.at(-1), `/api/followups?state=open&cursor=${cursorAt(25)}`);
  assert.equal(local.cursor, cursorAt(25));
  assert.equal(countLine(root), '60 open follow-ups; showing 25; 10 not shown');
  assert.equal(rowIds(root)[0], 'FU-000025');
  assert.ok(buttonNamed(root, 'Next page'));
  assert.ok(buttonNamed(root, 'First page'), 'First page once a cursor is set');

  buttonNamed(root, 'Next page')!.fire('click');
  await flush();
  assert.equal(api.calls.at(-1), `/api/followups?state=open&cursor=${cursorAt(50)}`);
  assert.equal(countLine(root), '60 open follow-ups; showing 10; 0 not shown');
  assert.equal(buttonNamed(root, 'Next page'), null, 'no Next page on the last page');

  // A poll on this page reads the same page again: the cursor lives in local.
  const polled = await view.loadFollowups(local, api.apiGet);
  assert.equal(api.calls.at(-1), `/api/followups?state=open&cursor=${cursorAt(50)}`);
  const again = view.renderFollowups(polled, {}, local);
  assert.equal(countLine(again), '60 open follow-ups; showing 10; 0 not shown');

  buttonNamed(again, 'First page')!.fire('click');
  await flush();
  assert.equal(api.calls.at(-1), '/api/followups?state=open');
  assert.equal(local.cursor, null);
  assert.equal(countLine(again), '60 open follow-ups; showing 25; 35 not shown');
  assert.equal(buttonNamed(again, 'First page'), null);
});

test('IC-019 the taken filter clears the cursor; an empty state reads "No <state> follow-ups."', async () => {
  const api = fakeApi();
  const { root, local } = await openView(api);
  buttonNamed(root, 'Next page')!.fire('click');
  await flush();
  assert.equal(local.cursor, cursorAt(25));

  const select = root.querySelector('select');
  select.value = 'taken';
  select.fire('change');
  await flush();
  assert.equal(local.state, 'taken');
  assert.equal(local.cursor, null, 'a filter change clears the cursor');
  assert.equal(api.calls.at(-1), '/api/followups?state=taken');
  assert.equal(countLine(root), '1 taken follow-ups; showing 1; 0 not shown');
  assert.deepEqual(rowIds(root), ['FU-t00001']);
  assert.equal(buttonNamed(root, 'First page'), null);
  assert.ok(root.querySelector('select').querySelectorAll('option')[1].hasAttribute('selected'), 'Taken is selected after the change');
  const polled = await view.loadFollowups(local, api.apiGet);
  assert.equal(api.calls.at(-1), '/api/followups?state=taken', 'the next poll keeps the filter');
  assert.equal(polled.state, 'taken');

  const done = root.querySelector('select');
  done.value = 'done';
  done.fire('change');
  await flush();
  assert.equal(api.calls.at(-1), '/api/followups?state=done');
  assert.equal(root.querySelector('table.mtable'), null);
  assert.ok(bodyText(root).includes('No done follow-ups.'));

  // Only values of the select reach the query.
  const odd = { inspector: null, route: { id: 'followups', params: {} }, state: 'open&x=1', cursor: '../x' };
  const oddApi = fakeApi();
  await view.loadFollowups(odd, oddApi.apiGet);
  assert.deepEqual(oddApi.calls, ['/api/followups?state=open']);
});

test('IC-019 the unreadable and conflict counts with each core reason', async () => {
  const problems = {
    unreadable: { n: 3, rows: [{ file: 'events-2026-11', reason: 'line 4 is not JSON' }, { file: 'events-2026-10', reason: null }] },
    conflicts: { n: 1, rows: [{ event: 'ev-1', type: 'take', code: 'already-taken', reason: 'taken twice' }] },
  };
  const { root } = await openView(fakeApi({ problems }));
  const text = bodyText(root);
  assert.ok(text.includes('3 follow-up records could not be read:'), text);
  assert.ok(text.includes('events-2026-11: line 4 is not JSON'));
  assert.ok(text.includes('events-2026-10: no reason recorded'));
  assert.ok(text.includes('1 more not shown'), 'the rows past the 50 shown are counted');
  assert.ok(text.includes('1 follow-up records are in conflict:'));
  assert.ok(text.includes('ev-1 (take, already-taken): taken twice'));

  const { root: clean } = await openView(fakeApi());
  assert.ok(!bodyText(clean).includes('could not be read'), 'no line when n is 0');
  assert.ok(!bodyText(clean).includes('in conflict'));
});

// ---- goals and release readiness ----------------------------------------------------------------

test('IC-019 goals with "Proposed done", the buckets, the release mode, the integration ref and the git error line', async () => {
  const { root } = await openView(fakeApi());
  const text = bodyText(root);
  const tags = root.querySelectorAll('.tag');
  assert.deepEqual(tags.map((t: El) => t.textContent), ['Proposed done'], 'one goal is proposed done');
  const goals = root.querySelectorAll('li.followups__goal');
  assert.equal(goals.length, 2);
  assert.ok(goals[0].textContent.includes('goal-ship-console'));
  assert.ok(goals[0].querySelector('.tag'));
  assert.equal(goals[1].querySelector('.tag'), null);
  assert.ok(goals[0].textContent.includes('The Console shows management screens'));
  assert.ok(goals[0].textContent.includes('3 of 3 items met'));
  assert.ok(goals[1].textContent.includes('1 of 4 items met'));
  assert.ok(goals[0].textContent.includes('Finished: 1 (feat-a)'));
  assert.ok(goals[1].textContent.includes('In progress: 1 (feat-docs)'));
  assert.ok(goals[0].textContent.includes('every item is met'), 'the nudges');

  const release = root.querySelector('section.followups__release');
  assert.ok(release);
  const rt = bodyText(release);
  assert.ok(rt.includes('Release mode') && rt.includes('tagged'), rt);
  assert.ok(rt.includes('Integration ref') && rt.includes('main'));
  assert.ok(rt.includes('Finished: 3 (feat-a, feat-b; 1 not shown)'), 'shown names and the count past them');
  assert.ok(rt.includes('Awaiting release: 1 (feat-c)'));
  assert.ok(rt.includes('In progress: 2 (feat-d, feat-e)'));
  assert.ok(rt.includes('Unknown: 0'));
  assert.ok(rt.includes('Git error: git could not read origin'));
  assert.ok(text.includes('<project>/agent-docs/intent.md'), 'an intent shows as a placed path');

  const unknownRef = { ...OVERVIEW, integrationRef: null, gitError: null, releaseMode: 'unknown' };
  const { root: other } = await openView(fakeApi({ overview: { ok: true, data: unknownRef, at: AT } }));
  const ot = bodyText(other.querySelector('section.followups__release'));
  assert.ok(!ot.includes('Git error'), 'no git error line when none is set');
  const figure = other.querySelector('section.followups__release').querySelectorAll('.figure');
  assert.ok(figure.some((f: El) => f.getAttribute('data-figure') === 'unknown'), 'a null integration ref reads unknown');
});

test('IC-019 a part the core does not provide reads its sentence; the other part keeps its data', async () => {
  const { root } = await openView(fakeApi({ overview: { ok: false, code: 'core-lacks-verb' } }));
  assert.ok(bodyText(root).includes('This DoFlow core does not provide goals and release readiness.'));
  assert.equal(countLine(root), '60 open follow-ups; showing 25; 35 not shown');
});

// ---- the inspector ------------------------------------------------------------------------------

test('IC-019 the record is fetched once per selection, never on a poll, and shows every IC-009 field', async () => {
  const api = fakeApi();
  const route = { id: 'followups', params: {}, item: 'FU-000003' };
  const { local, inspector, links } = await openView(api, route);
  assert.deepEqual(api.calls, ['/api/followups?state=open', '/api/followups/FU-000003']);
  await flush();
  assert.ok(inspector.current, 'the panel is open');
  const panel = inspector.current.body;
  const text = bodyText(panel);
  for (const part of [
    'FU-000003', 'Statement of number three', 'stage', '151-console-v2-manage', 'review', 'taken', 'kiro-agent',
    '<project>/agent-docs/intent.md', 'Raise the ceiling in its own commit', '2026-11-01', 'An excerpt of the report',
    'on this machine', 'filed', '2026-11-01T09:00:00.000Z', '2026-11-02T09:00:00.000Z', '4 older entries not shown',
  ]) assert.ok(text.includes(part), `${part} in ${text}`);

  // Polls: load and render again, with the same and with changed data.
  for (let i = 0; i < 3; i += 1) {
    const data = await view.loadFollowups(local, api.apiGet);
    view.renderFollowups(data, {}, local);
    await flush();
  }
  assert.equal(api.calls.filter((p) => p.startsWith('/api/followups/')).length, 1, 'no record fetch on a poll');
  assert.ok(inspector.current, 'the panel stays open across polls');

  // The selection changes: one more fetch.
  local.route = { ...route, item: 'FU-000004' };
  view.rerouteFollowups(local, {}, null);
  await flush();
  assert.deepEqual(api.calls.filter((p) => p.startsWith('/api/followups/')), ['/api/followups/FU-000003', '/api/followups/FU-000004']);
  assert.ok(bodyText(inspector.current.body).includes('FU-000004'));

  // No selection: the panel goes; closing from the inspector clears the address.
  local.route = { id: 'followups', params: {} };
  view.rerouteFollowups(local, {}, null);
  assert.equal(inspector.current, null);
  local.route = { ...route, item: 'FU-000005' };
  view.rerouteFollowups(local, {}, null);
  await flush();
  inspector.close();
  assert.deepEqual(links.at(-1), null, 'closing the panel links back to the base route');
});

test('IC-019 a 404 record and a 501 record read as their sentences', async () => {
  const records = {
    'FU-000404': () => Promise.reject({ status: 404, code: 'followup-not-found', network: false }),
    'FU-000501': () => Promise.reject({ status: 501, code: 'core-lacks-verb', network: false }),
  };
  const api = fakeApi({ records });
  const { local, inspector } = await openView(api, { id: 'followups', params: {}, item: 'FU-000404' });
  await flush();
  const notFound = bodyText(inspector.current.body);
  assert.ok(notFound.includes('This page does not exist'), notFound);
  assert.ok(notFound.includes('The address does not match any Console view.'), notFound);

  local.route = { id: 'followups', params: {}, item: 'FU-000501' };
  view.rerouteFollowups(local, {}, null);
  await flush();
  const lacks = bodyText(inspector.current.body);
  assert.ok(lacks.includes('This DoFlow core does not provide this follow-up.'), lacks);
  assert.equal(buttons(inspector.current.body).length, 0, 'no retry for an older core');
});

// ---- no actions ---------------------------------------------------------------------------------

test('IC-019 no control acts: the DOM holds no --take, --action init, settle or promote text and no write control', async () => {
  const problems = {
    unreadable: { n: 1, rows: [{ file: 'events-2026-11', reason: 'bad line' }] },
    conflicts: { n: 1, rows: [{ event: 'ev-1', type: 'take', code: 'already-taken', reason: 'taken twice' }] },
  };
  const api = fakeApi({ problems });
  const { root, inspector } = await openView(api, { id: 'followups', params: {}, item: 'FU-000003' });
  buttonNamed(root, 'Next page')!.fire('click');
  await flush();
  for (const node of [root, inspector.current.body]) {
    const text = bodyText(node);
    for (const banned of ['--take', '--action init', 'settle', 'promote', 'lifecycle --action', 'followup --action']) {
      assert.ok(!text.includes(banned), `no ${banned} text`);
    }
    assert.equal(node.querySelectorAll('input').length, 0);
    assert.equal(node.querySelectorAll('form').length, 0);
    assert.equal(node.querySelectorAll('textarea').length, 0);
    for (const b of buttons(node)) assert.ok(['Next page', 'First page', 'Retry'].includes(b.textContent), `only paging controls: ${b.textContent}`);
  }
  assert.equal(view.followupsTitle({}, null), 'Follow-ups');
});

test('IC-019 an API string reaches the page as text only', async () => {
  const planted = { v: 1, followup: { ...RECORD, statement: '<img src=x onerror=alert(1)>' } };
  const api = fakeApi({ records: { 'FU-000003': () => Promise.resolve(planted) } });
  const { inspector } = await openView(api, { id: 'followups', params: {}, item: 'FU-000003' });
  await flush();
  assert.equal(inspector.current.body.querySelectorAll('img').length, 0);
  assert.ok(bodyText(inspector.current.body).includes('<img src=x onerror=alert(1)>'));
});
