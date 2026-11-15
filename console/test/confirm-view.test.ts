'use strict';

// 162 IC-010 (T7): the one confirmation dialog (console/web/views/confirm.js) and the action client (console/web/actions.js).
// Like worker-tabs.test.ts, the web root is copied beside a {"type":"module"} marker and the modules are imported from there; a small
// fake DOM (elements and text nodes; an innerHTML write throws) records what the code builds. The transport seam takes a recorder, so
// no request leaves the test: the replies are the IC-002 shapes as fixtures.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let confirm: any;
let client: any;
let words: any;
let savedDocument: PropertyDescriptor | undefined;

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
  for (const m of selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)) out.classes.push(m[1]);
  for (const m of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) out.attrs.push([m[1], m[2] ?? null]);
  return out;
}

const doc: any = { activeElement: null };

class El {
  parent: any = null;
  children: any[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Function[]>();
  dataset: any;
  classList: any;
  value = '';
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
    const write = (list: string[]) => self.attrs.set('class', list.join(' '));
    this.classList = {
      add: (...names: string[]) => write([...new Set([...tokens(), ...names])]),
      remove: (...names: string[]) => write(tokens().filter((t) => !names.includes(t))),
      contains: (name: string) => tokens().includes(name),
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
  /** Markup strings never reach the page (149 NFR-004): any write is a failure. */
  set innerHTML(_value: string) { throw new Error('innerHTML written'); }
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
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  contains(node: any): boolean { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type: string, extra: any = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  focus() { doc.activeElement = this; }
  matches(c: Compound) {
    if (c.tag && this.tagName.toLowerCase() !== c.tag) return false;
    if (!c.classes.every((k) => this.classList.contains(k))) return false;
    return c.attrs.every(([name, value]) => (value === null ? this.attrs.has(name) : this.attrs.get(name) === value));
  }
  querySelectorAll(selector: string): El[] {
    const c = compound(selector);
    const out: El[] = [];
    const walk = (node: any) => {
      for (const child of node.children) {
        if (child instanceof El) {
          if (child.matches(c)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

Object.assign(doc, {
  createElement: (tag: string) => new El(tag),
  createElementNS: (_ns: string, tag: string) => new El(tag),
  createTextNode: (text: string) => new Txt(text),
  getElementById: (id: string) => doc.body.querySelectorAll('*').find((node: El) => node.getAttribute('id') === id) ?? null,
  querySelector: (selector: string) => doc.body.querySelector(selector),
  body: new El('body'),
});

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-confirm-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  const href = (...parts: string[]) => pathToFileURL(path.join(copy, ...parts)).href;
  confirm = await import(href('views', 'confirm.js'));
  client = await import(href('actions.js'));
  words = await import(href('derive', 'actions.js'));
});
after(() => {
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
  else delete (globalThis as any).document;
  fs.rmSync(copy, { recursive: true, force: true });
});
afterEach(() => {
  confirm.closeConfirm();
  confirm.releaseActionAreas();
  client.resetActions();
  doc.activeElement = null;
  doc.body.children = [];
});

// ---- fixtures: the IC-002 replies -----------------------------------------------------------------

const PK = '0123456789abcdef';
const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const text = (node: any) => node.textContent as string;

type Sent = { method: string, path: string, headers: Record<string, string>, body: any };
/** Installs a recording transport answering `answer(request)`; returns what was sent. */
function transportOf(answer: (request: Sent) => any): Sent[] {
  const sent: Sent[] = [];
  client.setActionTransport(async (request: any) => {
    const entry = { ...request, body: request.body === null ? null : JSON.parse(request.body) };
    sent.push(entry);
    const out = await answer(entry);
    if (out instanceof Error) throw out;
    return out;
  });
  return sent;
}

const ok200 = (over: any = {}) => ({
  status: 200, headers: {}, body: { v: 1, action: 'decide-gate', requestId: 'x', outcome: 'applied', replayed: false, by: 'console',
    result: { taskId: 'run-1', featureSlug: 'feat-a', state: 'RUNNING', revision: 8, awaitingGate: null, current: { type: 'stage', id: 'design' } }, ...over },
});
const refusal = (status: number, code: string, extra: any = {}, headers: Record<string, string> = {}) => ({ status, headers, body: { error: { code, verb: 'orchestrate', exit: 1 }, ...extra } });

const gateSpec = (over: any = {}) => words.buildConfirmation('decide-gate', {
  projectKey: PK, project: 'do-flow', slug: 'feat-a', taskId: 'run-1', gate: { id: 'gate-a', name: 'Design approval' }, decision: 'approve', revision: 7, ...over,
});
const closeSpec = () => words.buildConfirmation('close-run', { projectKey: PK, project: 'do-flow', slug: null, taskId: 'fix-x', current: { type: 'stage', id: 'implement' }, revision: 3 });
const stopSpec = () => words.buildConfirmation('cancel-worker', { projectKey: PK, project: 'do-flow', slug: 'feat-a', worker: { runId: 'w-1a2b3c4d5e6f', harness: 'codex', task: 'A.1' } });

/** Opens the dialog over the fake body, with the person's focus on a control that opened it. */
function open(spec: any, options: any = {}) {
  const opener = new El('button');
  doc.body.append(opener);
  opener.focus();
  const handle = confirm.openConfirm(spec, options);
  const root = handle.el as El;
  const by = (cls: string) => root.querySelector(`.${cls}`) as El;
  return {
    handle, root, opener, panel: by('confirm__panel'), cancel: by('confirm__cancel'), verb: by('confirm__verb'), review: by('confirm__review'), area: by('confirm__input'),
    count: by('confirm__count'), result: by('confirm__result'),
    type(value: string) { this.area.value = value; this.area.fire('input'); },
    disabled: (el: El) => el.getAttribute('disabled') !== null,
    hidden: (el: El) => el.getAttribute('hidden') !== null,
  };
}

// ---- the dialog ---------------------------------------------------------------------------------

test('open: a modal dialog named by its title, focus on Cancel, the effect sentence shown, and nothing posted', async () => {
  const sent = transportOf(() => ok200());
  const d = open(gateSpec());
  assert.equal(d.panel.getAttribute('role'), 'dialog');
  assert.equal(d.panel.getAttribute('aria-modal'), 'true');
  const title = d.root.querySelector('.confirm__title') as El;
  assert.equal(d.panel.getAttribute('aria-labelledby'), title.id);
  assert.equal(text(title), 'Approve Design approval');
  assert.equal(text(d.root.querySelector('.confirm__effect')), 'Approve Design approval (gate-a) of run feat-a/run-1 in do-flow. The run continues past this gate.');
  assert.equal(doc.activeElement, d.cancel, 'focus starts on Cancel');
  assert.equal(text(d.cancel), 'Cancel');
  assert.equal(text(d.verb), 'Approve gate-a');
  await flush();
  assert.equal(sent.length, 0, 'opening posts nothing');
  assert.equal(d.root.parent, doc.body);
});

test('a required reason keeps the verb button disabled until there is one; an optional note does not; over 500 disables it again', () => {
  transportOf(() => ok200());
  const close = open(closeSpec());
  assert.equal(close.disabled(close.verb), true, 'a close with no reason');
  close.type('   ');
  assert.equal(close.disabled(close.verb), true, 'spaces are no reason');
  close.type('work ended in PR 41');
  assert.equal(close.disabled(close.verb), false);
  assert.equal(text(close.count), '19 / 500');
  close.type('x'.repeat(501));
  assert.equal(close.disabled(close.verb), true);
  assert.equal(close.count.getAttribute('data-over'), 'true');
  confirm.closeConfirm();
  const approve = open(gateSpec());
  assert.equal(approve.disabled(approve.verb), false, 'a gate note is optional');
  const stop = open(stopSpec());
  assert.equal(stop.disabled(stop.verb), true, 'a stop with no reason');
  assert.equal(text(stop.verb), 'Stop worker');
});

test('the verb button posts once with the IC-002 body: a 22-character requestId, the expect drawn at open, the typed note, and Content-Type application/json', async () => {
  const sent = transportOf(() => ok200());
  const d = open(closeSpec());
  d.type('  work ended\tin PR 41 ');
  d.verb.fire('click');
  d.verb.fire('click');
  await flush();
  assert.equal(sent.length, 1, 'a second press while sending posts nothing');
  const [request] = sent;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/actions/close-run');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.match(request.body.requestId, /^[A-Za-z0-9_-]{22}$/);
  const { requestId, ...rest } = request.body;
  assert.deepEqual(rest, { v: 1, projectKey: PK, slug: null, taskId: 'fix-x', note: 'work ended in PR 41', expect: { revision: 3 } });
  assert.equal(typeof requestId, 'string');
  assert.equal(d.handle.state(), 'applied');
});

test('the requestId is fresh for each dialog and fixed for one; the gate note is null when empty; a worker cancel carries no expect', async () => {
  const sent = transportOf(() => ok200());
  const a = open(gateSpec());
  a.verb.fire('click');
  await flush();
  confirm.closeConfirm();
  const b = open(gateSpec());
  b.verb.fire('click');
  await flush();
  assert.notEqual(sent[0].body.requestId, sent[1].body.requestId);
  assert.equal(sent[0].body.note, null);
  assert.deepEqual(sent[0].body.expect, { revision: 7 });
  assert.equal(sent[0].path, '/api/actions/decide-gate');
  confirm.closeConfirm();
  const spec = stopSpec();
  const c = open(spec);
  spec.body.slug = 'tampered';
  c.type('stuck on a prompt');
  c.verb.fire('click');
  await flush();
  assert.deepEqual(Object.keys(sent[2].body).sort(), ['projectKey', 'reason', 'requestId', 'runId', 'slug', 'v']);
  assert.equal(sent[2].body.slug, 'feat-a', 'the body is fixed when the dialog opens');
  assert.equal(sent[2].body.reason, 'stuck on a prompt');
  assert.equal(sent[2].path, '/api/actions/cancel-worker');
});

test('sending: every control is disabled and Escape does nothing until the reply arrives', async () => {
  let release: (value: any) => void = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  transportOf(() => held);
  const d = open(gateSpec());
  d.verb.fire('click');
  await flush();
  assert.equal(d.handle.state(), 'sending');
  assert.equal(d.root.getAttribute('data-state'), 'sending');
  for (const el of [d.verb, d.cancel, d.area]) assert.equal(d.disabled(el), true);
  const esc = d.root.fire('keydown', { key: 'Escape' });
  assert.equal(esc.defaultPrevented, true);
  assert.equal(d.root.parent, doc.body, 'still open');
  release(ok200());
  await flush();
  assert.equal(d.handle.state(), 'applied');
});

test('applied: the notice replaces the field, the verb button is gone and Cancel reads Close', async () => {
  transportOf(() => ok200());
  const d = open(gateSpec({ decision: 'reject' }));
  d.verb.fire('click');
  await flush();
  assert.equal(text(d.result), 'Rejected. The page shows the run’s new state.');
  assert.equal(d.hidden(d.verb), true);
  assert.equal(text(d.cancel), 'Close');
  assert.equal(doc.activeElement, d.cancel);
  d.cancel.fire('click');
  assert.equal(d.root.parent, null, 'Close removes the dialog');
  assert.equal(doc.activeElement, d.opener, 'focus returns to the control that opened it');
  assert.equal(confirm.isConfirmOpen(), false);
});

test('162 review B-6: an applied action, an unknown outcome and a stale refusal each tell the page once, so it refetches at once; another refusal does not', async () => {
  const told: string[] = [];
  const stop = confirm.onRefetch(() => { told.push('refetch'); return Promise.resolve(true); });
  try {
    transportOf(() => refusal(403, 'action-transport'));
    const refused = open(closeSpec());
    refused.type('why');
    refused.verb.fire('click');
    await flush();
    confirm.closeConfirm();
    assert.deepEqual(told, [], 'a refusal before the core changed nothing');
    for (const [answer, state] of [[() => ok200(), 'applied'], [() => refusal(504, 'action-timeout'), 'unknown'], [() => new TypeError('network'), 'unknown'],
      [() => refusal(409, 'stale', { current: { state: 'RUNNING', revision: 4 } }), 'stale']] as const) {
      told.length = 0;
      transportOf(answer as any);
      const d = open(gateSpec());
      d.verb.fire('click');
      await flush();
      assert.equal(d.handle.state(), state);
      assert.deepEqual(told, ['refetch'], state);
      confirm.closeConfirm();
    }
  } finally {
    stop();
  }
});

test('162 review B-6: Review again waits for the refetch and builds from the refreshed row, never from the old revision', async () => {
  let row = { gate: { id: 'gate-a', name: 'Design approval' }, revision: 7 };
  let landed: (ok: boolean) => void = () => {};
  const stop = confirm.onRefetch(() => new Promise<boolean>((resolve) => { landed = (ok) => resolve(ok); }));
  try {
    transportOf(() => refusal(409, 'stale', { current: { state: 'AWAITING_GATE', revision: 8, awaitingGate: { gateId: 'gate-a', name: 'Design approval' } } }));
    const spec = gateSpec();
    spec.reopen = () => gateSpec(row);
    const d = open(spec);
    d.verb.fire('click');
    await flush();
    d.review.fire('click');
    await flush();
    assert.equal(d.root.parent !== null, true, 'the refetch has not landed: the stale dialog stays');
    assert.equal(d.disabled(d.review), true, 'and Review again waits');
    row = { ...row, revision: 8 };
    landed(true);
    await flush();
    const next = doc.body.querySelector('.confirm') as El;
    assert.notEqual(next, d.root);
    const sent = transportOf(() => ok200());
    (next.querySelector('.confirm__verb') as El).fire('click');
    await flush();
    assert.equal(sent[0].body.expect.revision, 8, 'the new dialog carries the refreshed revision');
    confirm.closeConfirm();

    // The refetch failed and the row still holds the old revision: no dialog is built from it.
    row = { ...row, revision: 7 };
    transportOf(() => refusal(409, 'stale', { current: { state: 'AWAITING_GATE', revision: 9 } }));
    const again = gateSpec();
    again.reopen = () => gateSpec(row);
    const e = open(again);
    e.verb.fire('click');
    await flush();
    e.review.fire('click');
    landed(false);
    await flush();
    assert.equal(doc.body.querySelectorAll('.confirm').length, 1);
    assert.equal(doc.body.querySelector('.confirm'), e.root, 'the stale dialog stays; no dialog of revision 7 opens');
    assert.match(text(e.result), /not read the run again/);
  } finally {
    stop();
  }
});

test('162 review B-5: on close focus returns to the opener while it is on the page, else to #main, else to the h1', () => {
  transportOf(() => ok200());
  const kept = open(gateSpec());
  kept.handle.close();
  assert.equal(doc.activeElement, kept.opener);

  const main = new El('main');
  main.setAttribute('id', 'main');
  const h1 = new El('h1');
  doc.body.append(main, h1);
  const rebuilt = open(gateSpec());
  rebuilt.opener.remove();
  rebuilt.handle.close();
  assert.equal(doc.activeElement, main, 'the opener was rebuilt: #main');

  main.remove();
  const gone = open(gateSpec());
  gone.opener.remove();
  gone.handle.close();
  assert.equal(doc.activeElement, h1, 'no #main: the h1');
});

test('stale (409): the current state in words, "Nothing was applied.", and Review again, which reopens from the page’s current row', async () => {
  transportOf(() => refusal(409, 'stale', { current: { state: 'AWAITING_GATE', revision: 8, awaitingGate: { gateId: 'gate-b', name: 'Plan approval' } } }));
  const spec = gateSpec();
  spec.reopen = () => gateSpec({ gate: { id: 'gate-b', name: 'Plan approval' }, revision: 8 });
  const d = open(spec);
  d.verb.fire('click');
  await flush();
  assert.equal(d.handle.state(), 'stale');
  const lines = d.result.querySelectorAll('.confirm__line').map(text);
  assert.deepEqual(lines, ['This run changed since you opened it.', 'It is now waiting at Plan approval (gate-b).', 'Nothing was applied.']);
  assert.equal(d.hidden(d.verb), true);
  assert.equal(d.hidden(d.review), false);
  d.review.fire('click');
  await flush();
  const next = doc.body.querySelector('.confirm') as El;
  assert.notEqual(next, d.root);
  assert.equal(d.root.parent, null);
  assert.equal(text(next.querySelector('.confirm__title') as El), 'Approve Plan approval');
  assert.equal(doc.activeElement, next.querySelector('.confirm__cancel'));
});

test('a 504 shows the unknown outcome, never "applied" or "refused"; so does a transport that fails', async () => {
  transportOf(() => refusal(504, 'action-timeout'));
  const d = open(gateSpec());
  d.verb.fire('click');
  await flush();
  assert.equal(d.handle.state(), 'unknown');
  assert.equal(text(d.result), 'The outcome is unknown. The page shows the run as it is now.');
  assert.equal(d.hidden(d.review), true);
  confirm.closeConfirm();
  transportOf(() => new TypeError('network'));
  const e = open(gateSpec());
  e.verb.fire('click');
  await flush();
  assert.equal(e.handle.state(), 'unknown');
  assert.equal(text(e.result), 'The outcome is unknown. The page shows the run as it is now.');
});

test('other refusals: the code in words; a 429 adds the wait; a 501 refreshes the actions the page holds', async () => {
  transportOf(() => refusal(403, 'phone-scope'));
  const a = open(gateSpec());
  a.verb.fire('click');
  await flush();
  assert.equal(a.handle.state(), 'refused');
  assert.equal(text(a.result.querySelector('.confirm__line') as El), words.refusalWords('phone-scope'));
  confirm.closeConfirm();
  transportOf(() => refusal(429, 'action-rate-limited', {}, { 'retry-after': '12' }));
  const b = open(gateSpec());
  b.verb.fire('click');
  await flush();
  assert.deepEqual(b.result.querySelectorAll('.confirm__line').map(text), [words.refusalWords('action-rate-limited'), 'Try again in 12 s.']);
  confirm.closeConfirm();
  let actionReads = 0;
  client.setActionTransport(async (request: any) => {
    if (request.method === 'GET') {
      actionReads += 1;
      return { status: 200, headers: {}, body: { v: 1, actor: { kind: 'local', transport: 'loopback' }, actions: [{ id: 'decide-gate', allowed: actionReads < 2, reason: actionReads < 2 ? null : 'core-lacks-action' }], textMax: 500 } };
    }
    return refusal(501, 'core-lacks-action');
  });
  await client.loadActions();
  assert.equal(client.actionPower('decide-gate').allowed, true);
  const c = open(gateSpec());
  c.verb.fire('click');
  await flush();
  assert.equal(actionReads, 2, 'a 501 reads GET /api/actions again');
  assert.deepEqual(client.actionPower('decide-gate'), { allowed: false, reason: 'core-lacks-action' });
});

test('Escape closes; Tab and Shift+Tab wrap among the reachable controls', () => {
  transportOf(() => ok200());
  const d = open(closeSpec());
  d.type('why');
  // DOM order: the text field, Cancel, (Review again, hidden), the verb button.
  doc.activeElement = d.verb;
  const forward = d.root.fire('keydown', { key: 'Tab' });
  assert.equal(forward.defaultPrevented, true);
  assert.equal(doc.activeElement, d.area, 'Tab from the last control wraps to the first');
  const back = d.root.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(back.defaultPrevented, true);
  assert.equal(doc.activeElement, d.verb, 'Shift+Tab from the first control wraps to the last');
  doc.activeElement = d.cancel;
  assert.equal(d.root.fire('keydown', { key: 'Tab' }).defaultPrevented, false, 'Tab inside is left to the browser');
  const esc = d.root.fire('keydown', { key: 'Escape' });
  assert.equal(esc.defaultPrevented, true);
  assert.equal(d.root.parent, null);
  assert.equal(doc.activeElement, d.opener);
});

test('a disabled verb button is skipped by Tab, so the wrap lands on the last reachable control', () => {
  transportOf(() => ok200());
  const d = open(closeSpec());
  doc.activeElement = d.cancel;
  d.root.fire('keydown', { key: 'Tab' });
  assert.equal(doc.activeElement, d.area, 'the verb button is disabled: Cancel is the last stop');
});

test('only one dialog is open at a time; opening another closes the first and a closed one posts nothing more', async () => {
  const sent = transportOf(() => ok200());
  const first = open(gateSpec());
  const second = open(closeSpec());
  assert.equal(first.root.parent, null);
  assert.equal(doc.body.querySelectorAll('.confirm').length, 1);
  second.type('why');
  second.verb.fire('click');
  second.handle.close();
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(second.handle.state(), 'sending', 'a reply that arrives after close changes nothing on screen');
});

test('requestId: 16 random bytes as 22 base64url characters', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 50; i += 1) ids.add(confirm.newRequestId());
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.match(confirm.newRequestId({ getRandomValues: (bytes: Uint8Array) => bytes.fill(255) }), /^_{21}w$/);
});

// ---- the action client --------------------------------------------------------------------------

const actionsBody = (actions: any[], extra: any = {}) => ({ v: 1, actor: { kind: 'device', deviceId: 'd-0a1b2c3d4e5f', scope: 'view', transport: 'browser' }, actions, textMax: 500, limits: {}, ...extra });

test('loadActions reads GET /api/actions once per page load; a view-scope device gets no allowed action, with its reason', async () => {
  const sent = transportOf(() => ({ status: 200, headers: {}, body: actionsBody([
    { id: 'decide-gate', allowed: false, reason: 'phone-scope' }, { id: 'close-run', allowed: false, reason: 'phone-scope' }, { id: 'cancel-worker', allowed: false, reason: 'phone-scope' }]) }));
  assert.deepEqual(client.actionPower('decide-gate'), { allowed: false, reason: null }, 'before the read: no button, no reason');
  const [a, b] = await Promise.all([client.loadActions(), client.loadActions()]);
  await client.loadActions();
  assert.equal(sent.length, 1, 'one read, however many views ask');
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].path, '/api/actions');
  assert.equal(a, b);
  assert.deepEqual(client.actionPower('close-run'), { allowed: false, reason: 'phone-scope' });
  assert.equal(words.notAllowedWords('phone-scope'), 'Actions need a control device paired from the Android app.');
  // 162 review 2: a Console that cannot write its action log offers no action, and says why.
  assert.equal(words.notAllowedWords('action-log-unwritable'), 'Actions are off: the Console cannot write its action log.');
});

test('a local actor may do every action; a failed read, an older Console and a reply of another shape leave the page without buttons', async () => {
  transportOf(() => ({ status: 200, headers: {}, body: actionsBody(['decide-gate', 'close-run', 'cancel-worker'].map((id) => ({ id, allowed: true, reason: null })),
    { actor: { kind: 'local', transport: 'loopback' }, project: { projectKey: PK, label: 'do-flow' } }) }));
  const seen: number[] = [];
  client.onActions(() => seen.push(1));
  await client.loadActions();
  assert.equal(client.actionPower('cancel-worker').allowed, true);
  assert.deepEqual(client.currentProject(), { projectKey: PK, label: 'do-flow' });
  assert.equal(seen.length, 1, 'a view hears that the actions are known');
  for (const answer of [() => ({ status: 404, headers: {}, body: { error: { code: 'not-found' } } }), () => ({ status: 200, headers: {}, body: { nope: true } }), () => new TypeError('network')]) {
    client.resetActions();
    transportOf(answer);
    assert.equal(await client.loadActions(), null);
    assert.deepEqual(client.actionPower('decide-gate'), { allowed: false, reason: null });
    assert.equal(client.currentProject(), null);
  }
});

test('the transport seam: setActionTransport(fn) carries every call as { method, path, headers, body }; the default is fetch with the cookie', async () => {
  const calls: any[] = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true, writable: true,
    value: async (target: string, init: any) => {
      calls.push([target, init]);
      return { status: 200, headers: new Map([['Retry-After', '3']]), json: async () => ({ v: 1 }) };
    },
  });
  try {
    const reply = await client.postAction('decide-gate', { v: 1, requestId: 'r'.repeat(22) });
    assert.equal(calls.length, 1);
    const [target, init] = calls[0];
    assert.equal(target, '/api/actions/decide-gate');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { v: 1, requestId: 'r'.repeat(22) });
    assert.deepEqual(reply, { status: 200, headers: { 'retry-after': '3' }, body: { v: 1 } });
    const bridged: any[] = [];
    client.setActionTransport(async (request: any) => { bridged.push(request); return { status: 204, headers: {}, body: null }; });
    await client.postAction('close-run', { v: 1 });
    assert.equal(calls.length, 1, 'the bridge replaced fetch');
    assert.deepEqual(Object.keys(bridged[0]).sort(), ['body', 'headers', 'method', 'path']);
    assert.equal(bridged[0].path, '/api/actions/close-run');
    assert.throws(() => client.setActionTransport('nope'), TypeError);
    await assert.rejects(client.postAction('../etc', {}), TypeError);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    else delete (globalThis as any).fetch;
  }
});

// ---- the buttons that open it ----------------------------------------------------------------------

const allowedBody = (allowed: boolean, reason: string | null = null) => actionsBody(['decide-gate', 'close-run', 'cancel-worker'].map((id) => ({ id, allowed, reason })),
  { project: { projectKey: PK, label: 'do-flow' } });

test('an action area draws the buttons once the page learns it may, and the reason line and nothing else when it may not', async () => {
  transportOf(() => ({ status: 200, headers: {}, body: allowedBody(true) }));
  const make = (decision: string) => () => gateSpec({ decision });
  const build = () => [
    confirm.actionButton({ id: 'decide-gate', label: 'Approve', tone: 'approve', make: make('approve') }),
    confirm.actionButton({ id: 'decide-gate', label: 'Reject', tone: 'danger', make: make('reject') }),
    confirm.notAllowedLine(['decide-gate']),
  ];
  const area = confirm.actionArea(build);
  doc.body.append(area);
  assert.deepEqual(area.children.length, 0, 'before the page hears, there is neither a button nor a reason');
  await flush();
  const buttons = area.querySelectorAll('button');
  assert.deepEqual(buttons.map(text), ['Approve', 'Reject']);
  assert.deepEqual(buttons.map((b: El) => b.getAttribute('data-tone')), ['approve', 'danger']);
  assert.equal(area.querySelector('.acts__reason'), null);
  buttons[1].fire('click');
  const dialog = doc.body.querySelector('.confirm') as El;
  assert.equal(text(dialog.querySelector('.confirm__verb') as El), 'Reject gate-a');
  assert.equal(client.actionPower('decide-gate').allowed, true);
});

test('a view-scope page: no button, one muted reason line; a failed read: neither; the dialog is never opened by drawing', async () => {
  const sent = transportOf(() => ({ status: 200, headers: {}, body: allowedBody(false, 'phone-scope') }));
  const area = confirm.actionArea(() => [confirm.actionButton({ id: 'close-run', label: 'Close run', tone: 'danger', make: closeSpec }), confirm.notAllowedLine(['close-run'])]);
  doc.body.append(area);
  await flush();
  assert.equal(area.querySelectorAll('button').length, 0);
  assert.equal(text(area.querySelector('.acts__reason') as El), 'Actions need a control device paired from the Android app.');
  assert.equal(doc.body.querySelector('.confirm'), null);
  assert.equal(sent.filter((r) => r.method === 'POST').length, 0);
  confirm.releaseActionAreas();
  client.resetActions();
  transportOf(() => new TypeError('network'));
  const failed = confirm.actionArea(() => [confirm.actionButton({ id: 'close-run', label: 'Close run', tone: 'danger', make: closeSpec }), confirm.notAllowedLine(['close-run'])]);
  await flush();
  assert.equal(failed.children.length, 0);
});

test('a button is not drawn when the page cannot build its confirmation (no project, no revision), even when the action is allowed', async () => {
  transportOf(() => ({ status: 200, headers: {}, body: allowedBody(true) }));
  const area = confirm.actionArea(() => confirm.actionButton({ id: 'close-run', label: 'Close run', tone: 'danger', make: () => null }));
  await flush();
  assert.equal(area.querySelectorAll('button').length, 0);
});

test('"Review again" builds the confirmation from what `make` returns by then, not from the row the button was drawn with', async () => {
  transportOf((request) => (request.method === 'GET' ? { status: 200, headers: {}, body: allowedBody(true) } : refusal(409, 'stale', { current: { state: 'AWAITING_GATE', revision: 9, awaitingGate: { gateId: 'gate-b', name: 'Plan approval' } } })));
  let row = { gate: { id: 'gate-a', name: 'Design approval' }, revision: 7 };
  const area = confirm.actionArea(() => confirm.actionButton({ id: 'decide-gate', label: 'Approve', tone: 'approve', make: () => gateSpec({ ...row }) }));
  doc.body.append(area);
  await flush();
  (area.querySelector('button') as El).fire('click');
  const first = doc.body.querySelector('.confirm') as El;
  (first.querySelector('.confirm__verb') as El).fire('click');
  await flush();
  row = { gate: { id: 'gate-b', name: 'Plan approval' }, revision: 9 };
  (first.querySelector('.confirm__review') as El).fire('click');
  await flush();
  const next = doc.body.querySelector('.confirm') as El;
  assert.equal(text(next.querySelector('.confirm__title') as El), 'Approve Plan approval');
});
