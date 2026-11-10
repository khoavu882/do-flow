'use strict';

// The Advice view (feature 151, plan task C.4; IC-018; FR-013 to FR-017, FR-026, FR-029, NFR-005, NFR-009). The
// `/api/advice` body is built the way the route builds it (IC-012), from the core's own reads over a real world: the
// advice world's records (console/test/helpers/advice-world.ts, the core's `appendPick`, `appendMiss` and
// `appendOutcome`), `config list --json` run against a project whose layer sets `advice.kinds.task-class` to `shadow`,
// `buildReport` and `advicePicksBody` in process, each through its projector (console/src/project.ts, IC-007, IC-008).
// One partition of the window is a directory, so the core cannot read that day. Like figures.test.ts, the web root is
// copied beside a {"type":"module"} marker and the modules are imported from there (views.js first, the page's own
// order), over a small fake DOM in which a markup write throws.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { project } = require('../src/project.ts');
const { anchorsOf } = require('../src/place.ts');
const { buildAdviceWorld, ADVICE_PLANTED } = require('./helpers/advice-world.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const REPO_ROOT = path.join(__dirname, '..', '..');
const CORE = path.join(REPO_ROOT, 'bin', 'doflow.js');
const { buildReport } = require(path.join(REPO_ROOT, 'src', 'runtime', 'advice', 'report.ts'));
const { advicePicksBody } = require(path.join(REPO_ROOT, 'src', 'runtime', 'advice', 'picks.ts'));
const { loadAdviceRegistry } = require(path.join(REPO_ROOT, 'src', 'runtime', 'advice', 'registry.ts'));
const { loadStorageRegistry } = require(path.join(REPO_ROOT, 'src', 'runtime', 'storage', 'registry.ts'));
const { resolveRoots } = require(path.join(REPO_ROOT, 'src', 'runtime', 'storage', 'roots.ts'));

const SETTINGS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'settings.json'), 'utf8')).keys;
const SHIPPED_VERDICTS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'advice-verdicts.json'), 'utf8'));
const KINDS: string[] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'advice.json'), 'utf8')).kinds.map((k: any) => k.id);

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const AT = '2026-11-09T10:00:05.000Z';
/** The partition the core cannot read: a directory where a file is expected. */
const UNREAD_DAY = '2026-10-01';
const UNSET = "not set (the kind's own path)";
const GATE_LEAD = "A kind acts on the model's pick only when a shipped bench verdict passes for it; until then act is gated.";

let copy: string;
let world: string;
let view: any;
let savedDocument: PropertyDescriptor | undefined;
let savedLocation: PropertyDescriptor | undefined;
/** The `/api/advice` body over the world, as IC-012 builds it. */
let BODY: any;
let PICK_IDS: any;

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
const elementsOf = (node: any): El[] => nodesOf(node).filter((n: any) => n instanceof El);

/** The `section` whose `aria-labelledby` is `id`. */
function sectionOf(root: any, id: string): El {
  const found = root.querySelectorAll('section').find((s: El) => s.getAttribute('aria-labelledby') === id);
  assert.ok(found, `a section labelled by ${id}`);
  const heading = elementsOf(found).find((el) => el.getAttribute('id') === id);
  assert.ok(heading && /^h[1-6]$/.test(heading.tagName), `${id} names a heading inside its section`);
  return found;
}

/** A `dl` as `[term, description]` pairs. */
const factsOf = (dl: any): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < dl.children.length; i += 2) out.push([dl.children[i].textContent, dl.children[i + 1].textContent]);
  return out;
};
const factMap = (el: any) => new Map(factsOf(el.querySelector('dl')));

/** A table as its header texts and its body rows of cell texts. */
function tableOf(table: any) {
  const head = table.querySelector('thead').querySelectorAll('th').map((th: El) => th.textContent);
  const rows = table.querySelector('tbody').querySelectorAll('tr').map((tr: El) => tr.children.map((cell: any) => cell.textContent));
  return { head, rows, caption: table.querySelector('caption')?.textContent ?? null };
}

/** A fake inspector that records each showing and closing. */
function fakeInspector() {
  const calls: any[] = [];
  return {
    calls,
    open(spec: any) { calls.push(['open', spec]); },
    close() { calls.push(['close']); },
    isOpen: () => calls.length > 0 && calls.at(-1)[0] === 'open',
    mode: () => 'dock',
  };
}

const clone = (value: any) => JSON.parse(JSON.stringify(value));
const render = (body: any, params: any = {}, local: any = {}) => view.renderAdvice(body, params, { inspector: null, route: { id: 'advice', params }, link: null, ...local });

// ---- the world ----------------------------------------------------------------------------------

before(async () => {
  world = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-advice-view-'));
  const home = path.join(world, 'home');
  const proj = path.join(world, 'proj');
  for (const dir of [home, path.join(proj, '.doflow')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(proj, '.doflow', 'settings.json'), JSON.stringify({ 'advice.kinds.task-class': 'shadow' }));
  const env: Record<string, string> = { PATH: String(process.env.PATH), HOME: home, DOFLOW_UPKEEP: 'off' };

  const listed = spawnSync(process.execPath, [CORE, 'config', 'list', '--json'], { cwd: proj, env, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const built = buildAdviceWorld({ core: CORE, projectRoot: proj, env, now: NOW });
  PICK_IDS = built.picks;
  fs.mkdirSync(path.join(built.store, `${UNREAD_DAY}.jsonl`));
  const picks = advicePicksBody({ cwd: proj, env, now: new Date(NOW), json: true });
  assert.equal(picks.exit, 0);
  const registry = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
  const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: proj, global: false, env });
  const report = buildReport({ roots, kinds: registry.kinds.map((k: any) => k.id), now: () => new Date(NOW), adviceRegistry: registry, projectRoot: proj, env });

  const anchors = anchorsOf({ projectRoot: proj, home });
  const projected = (shape: string, raw: any) => {
    const result = project(shape, raw, { exit: 0, anchors });
    assert.equal(result.ok, true, `${shape} projects`);
    return result.body;
  };
  const effective = projected('config-list', JSON.parse(listed.stdout));
  const kept = (key: string | null) => key === null || key.startsWith('advice.');
  const settings = { ...effective, keys: effective.keys.filter((row: any) => kept(row.key)), errors: effective.errors.filter((row: any) => kept(row.key)), notes: effective.notes.filter((row: any) => kept(row.key)) };
  BODY = {
    v: 1,
    kind: null,
    sections: {
      settings: { ok: true, data: settings, at: AT },
      report: { ok: true, data: projected('advise-report', report), at: AT },
      picks: { ok: true, data: projected('advice-picks', picks.json), at: AT },
    },
  };

  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-advice-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: { hash: '#/advice', reload() { (this as any).reloads = ((this as any).reloads ?? 0) + 1; } }, configurable: true, writable: true });
  await import(pathToFileURL(path.join(copy, 'views.js')).href);
  view = await import(pathToFileURL(path.join(copy, 'views', 'advice.js')).href);
});

after(() => {
  if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
  else delete (globalThis as any).document;
  if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
  else delete (globalThis as any).location;
  if (copy) fs.rmSync(copy, { recursive: true, force: true });
  if (world) fs.rmSync(world, { recursive: true, force: true });
});

// ---- the world is what the cases say ------------------------------------------------------------

test('fixture: the world holds the cases the view is checked against', () => {
  const { settings, report, picks } = BODY.sections;
  const keyRow = (key: string) => settings.data.keys.find((row: any) => row.key === key);
  assert.equal(keyRow('advice.kinds.task-class').views[0].value, 'shadow');
  assert.equal(keyRow('advice.kinds.task-class').views[0].origin.layer, 'project');
  for (const kind of KINDS.filter((k) => k !== 'task-class')) assert.equal(keyRow(`advice.kinds.${kind}`).views[0].value, null, kind);
  const tier = report.data.kinds.find((row: any) => row.kind === 'tier');
  assert.deepEqual(tier.agreeOutcome, { n: 0, agree: 0 }, 'tier has picks and no outcome');
  const verify = report.data.kinds.find((row: any) => row.kind === 'verify-risk');
  assert.equal(verify.agreeStatic, null, 'verify-risk has no record');
  assert.equal(verify.modes, null);
  assert.deepEqual(report.data.verdicts, [], 'the shipped verdicts file has no row');
  assert.equal(picks.data.days.length, 91);
  assert.equal(picks.data.days.find((d: any) => d.day === UNREAD_DAY).coverage, 'unknown');
  assert.equal(picks.data.limits.notShown, 0);
  const modes = new Set(picks.data.picks.map((p: any) => p.mode));
  assert.ok(modes.has('shadow') && modes.has('unrecorded'));
});

// ---- the gate -----------------------------------------------------------------------------------

test('IC-018 gate: the lead sentence, and over the shipped empty verdicts file "No bench verdict ships for any kind."', () => {
  assert.deepEqual(SHIPPED_VERDICTS.verdicts, [], 'core/registry/advice-verdicts.json ships with no verdict');
  const gate = sectionOf(render(BODY), 'advice-gate');
  const lead = gate.querySelector('p');
  assert.equal(lead.textContent, GATE_LEAD);
  assert.equal(lead.querySelector('code').textContent, 'act', 'act is set as code');
  const sentences = gate.querySelectorAll('li').map((li: El) => li.textContent);
  assert.deepEqual(sentences, ['No bench verdict ships for any kind.']);
});

test('IC-018 gate: with verdict rows, one sentence per kind from C.2 (a pass names its model, a stale row reads its reason)', () => {
  const body = clone(BODY);
  body.sections.report.data.verdicts = [
    { kind: 'tier', model: 'qwen3:8b', arm: null, result: 'pass', stale: false, reason: null },
    { kind: 'task-class', model: 'm1', arm: null, result: 'pass', stale: true, reason: 'verdict stale: the bench changed' },
  ];
  const sentences = sectionOf(render(body), 'advice-gate').querySelectorAll('li').map((li: El) => li.textContent);
  assert.ok(sentences.includes('A passing verdict ships for tier with qwen3:8b.'));
  assert.ok(sentences.includes('verdict stale: the bench changed'));
  assert.ok(sentences.includes('No bench verdict ships for verify-risk.'));
});

// ---- settings -----------------------------------------------------------------------------------

test('IC-018 settings: advice.enabled and every kind with its layer; task-class shadow at the project layer, the rest not set', () => {
  const section = sectionOf(render(BODY), 'advice-settings');
  const table = tableOf(section.querySelector('table'));
  assert.ok(section.querySelector('table').classList.contains('mtable'));
  assert.ok(table.caption, 'the table has a caption');
  assert.deepEqual(table.head, ['Key', 'Value', 'Layer']);
  const rows = new Map(table.rows.map((row: string[]) => [row[0], row.slice(1)]));
  assert.deepEqual(rows.get('advice.enabled'), ['false', 'default']);
  assert.deepEqual(rows.get('advice.kinds.task-class'), ['shadow', 'project']);
  for (const kind of KINDS.filter((k) => k !== 'task-class')) assert.deepEqual(rows.get(`advice.kinds.${kind}`), [UNSET, 'default'], kind);
  assert.equal(table.rows.length, 1 + KINDS.length, 'advice.enabled and the eight kinds');
  for (const th of section.querySelector('tbody').querySelectorAll('th')) assert.equal(th.getAttribute('scope'), 'row');
});

test('IC-018 settings: the rerank and claim-support key descriptions say act is held at shadow; no combined mode is computed', () => {
  const root = render(BODY);
  const section = sectionOf(root, 'advice-settings');
  const text = section.textContent;
  for (const kind of ['rerank', 'claim-support']) {
    const description = SETTINGS[`advice.kinds.${kind}`].description;
    assert.ok(description.includes('act is accepted but held at shadow'), `${kind}: the registry says it`);
    assert.ok(text.includes(description), `${kind}: its description is shown whole`);
  }
  assert.ok(!text.includes(SETTINGS['advice.kinds.tier'].description), 'only the two held kinds show a description');
  assert.doesNotMatch(root.textContent, /effective|combined/i, 'DEC-008: no combined effective mode');
});

// ---- figures ------------------------------------------------------------------------------------

test('IC-018 figures: the window line with its dates, and per kind each figure with its n', () => {
  const section = sectionOf(render(BODY), 'advice-figures');
  assert.ok(section.querySelectorAll('p').some((p: El) => p.textContent === 'Last 90 days: 2026-08-11 to 2026-11-09 (UTC)'), 'the window line');
  const task = factMap(sectionOf(section, 'advice-kind-task-class'));
  assert.equal(task.get('Picks'), '4');
  assert.equal(task.get('Misses'), '1 (timeout 1)');
  assert.equal(task.get('Agrees with the rule'), '2 of 4 (50%), n=4');
  assert.equal(task.get('Agrees with the outcome'), '0 of 1 (0%), n=1');
  assert.equal(task.get('Elevated'), '0 of 4');
  assert.equal(task.get('Mode shadow'), '2 of 4');
  assert.equal(task.get('Mode act'), '0 of 4');
  assert.equal(task.get('Mode unrecorded'), '2 of 4');
  assert.equal(task.get('Pick duration'), 'p50 120 ms, p90 120 ms, p95 120 ms, n=4');
  assert.equal(task.get('Miss duration'), 'p50 5000 ms, p90 5000 ms, p95 5000 ms, n=1');
  const tier = factMap(sectionOf(section, 'advice-kind-tier'));
  assert.equal(tier.get('Agrees with the outcome'), 'no data (n=0)', 'the kind without outcomes');
  assert.equal(tier.get('Miss duration'), 'no data (n=0)');
  assert.equal(tier.get('Misses'), '0');
});

test('IC-018 figures: no 0 and no empty cell where the body holds null (FR-026)', () => {
  const section = sectionOf(render(BODY), 'advice-figures');
  const nullable = ['Agrees with the rule', 'Agrees with the outcome', 'Elevated', 'Mode shadow', 'Mode act', 'Mode unrecorded', 'Pick duration', 'Miss duration'];
  for (const row of BODY.sections.report.data.kinds.filter((k: any) => k.agreeStatic === null)) {
    const facts = factMap(sectionOf(section, `advice-kind-${row.kind}`));
    for (const term of nullable) assert.equal(facts.get(term), 'unknown', `${row.kind} ${term}`);
  }
  for (const cell of [...section.querySelectorAll('dd'), ...section.querySelectorAll('td')]) {
    assert.notEqual(cell.textContent.trim(), '', 'no empty cell');
  }
});

test('IC-018 figures: the rerank and claim-support blocks follow the kinds', () => {
  const section = sectionOf(render(BODY), 'advice-figures');
  const rerank = factMap(sectionOf(section, 'advice-rerank'));
  assert.equal(rerank.get('Top-1 changed'), 'no data (n=0)');
  assert.equal(rerank.get('Mean rank displacement per candidate'), 'no data (n=0)');
  assert.equal(rerank.get('Criteria in force'), 'registry, digest 9939ded87e67');
  assert.equal(rerank.get('Criteria warning'), 'no warning');
  assert.equal(rerank.get('Would drop, ladder arm (measurement only)'), 'no data (n=0)');
  const claim = factMap(sectionOf(section, 'advice-claim-support'));
  assert.equal(claim.get('Supports'), 'no data (n=0)');
  assert.equal(claim.get('Contradicts'), 'no data (n=0)');
  assert.equal(claim.get('Pick duration'), 'no data (n=0)');

  const body = clone(BODY);
  body.sections.report.data.claimSupport.byRelation.supports = { n: 4, modelYes: 3, agree: 3 };
  body.sections.report.data.rerank.top1Changed = { n: 4, changed: 1 };
  const again = sectionOf(render(body), 'advice-figures');
  assert.equal(factMap(sectionOf(again, 'advice-claim-support')).get('Supports'), 'picks 4; model said yes 3 of 4; agrees with the recorded relation 3 of 4 (75%), n=4');
  assert.equal(factMap(sectionOf(again, 'advice-rerank')).get('Top-1 changed'), '1 of 4 (25%), n=4');

  delete body.sections.report.data.rerank;
  delete body.sections.report.data.claimSupport;
  const without = render(body);
  assert.ok(!without.querySelectorAll('section').some((s: El) => s.getAttribute('aria-labelledby') === 'advice-rerank'), 'no block the report did not print');
});

// ---- picks per day ------------------------------------------------------------------------------

test('IC-018 picks per day: days with picks and their counts, 0 on the read days, unknown on the day not read', () => {
  const section = sectionOf(render(BODY), 'advice-days');
  const lines = section.querySelector('ul').querySelectorAll('li').map((li: El) => li.textContent);
  const task = lines.find((line: string) => line.startsWith('task-class'));
  assert.equal(task, 'task-class: 2026-11-07: 2, 2026-11-08: 1, 2026-11-09: 1; 0 on 87 days read; unknown on 1 day not read');
  const verify = lines.find((line: string) => line.startsWith('verify-risk'));
  assert.equal(verify, 'verify-risk: 0 on 90 days read; unknown on 1 day not read');

  const details = section.querySelector('details');
  assert.ok(details, 'a details element holds the full table');
  assert.ok(details.querySelector('summary').textContent.length > 0);
  const table = tableOf(details.querySelector('table'));
  assert.ok(details.querySelector('table').classList.contains('mtable'));
  assert.ok(table.caption);
  assert.deepEqual(table.head, ['Day', 'Coverage', ...BODY.sections.picks.data.kinds]);
  assert.equal(table.rows.length, 91);
  const column = 2 + BODY.sections.picks.data.kinds.indexOf('task-class');
  const day = (d: string) => table.rows.find((row: string[]) => row[0] === d);
  assert.equal(day('2026-11-07')[column], '2', 'a day with picks');
  assert.equal(day('2026-11-06')[column], '0', 'a read day with none');
  assert.equal(day('2026-11-06')[1], 'read');
  assert.deepEqual(day(UNREAD_DAY).slice(1), ['unknown', ...BODY.sections.picks.data.kinds.map(() => 'unknown')], 'the day not read');
});

// ---- recent picks -------------------------------------------------------------------------------

test('IC-018 recent picks: the table with its columns, "unrecorded" rows and "no outcome recorded"; no planted text', () => {
  const root = render(BODY);
  const section = sectionOf(root, 'advice-recent');
  const el = section.querySelector('table');
  assert.ok(el.classList.contains('mtable'));
  const table = tableOf(el);
  assert.ok(table.caption);
  assert.deepEqual(table.head, ['Time', 'Kind', 'Mode', "Model's pick", "Rule's answer", 'Agreed', 'Outcome']);
  for (const th of el.querySelector('thead').querySelectorAll('th')) assert.equal(th.getAttribute('scope'), 'col');
  const picks = BODY.sections.picks.data.picks;
  assert.equal(table.rows.length, picks.length);
  picks.forEach((pick: any, index: number) => {
    const row = table.rows[index];
    assert.equal(row[0], pick.at);
    assert.equal(row[1], pick.kind);
    assert.equal(row[2], pick.mode);
    assert.equal(row[3], pick.pick);
    assert.equal(row[4], pick.static === null ? 'not recorded' : pick.static);
    assert.equal(row[5], pick.agree === null ? 'unknown' : pick.agree ? 'yes' : 'no');
  });
  const byId = new Map<string, string[]>(picks.map((p: any, i: number) => [p.pickId, table.rows[i]]));
  assert.equal(byId.get(PICK_IDS.taskClass[1])![6], 'feature, differs from the pick', 'the outcome that names the pick');
  assert.equal(byId.get(PICK_IDS.taskClass[1])![2], 'unrecorded', 'a pick with no mode is never shown as shadow');
  assert.equal(byId.get(PICK_IDS.taskClass[0])![2], 'shadow');
  assert.equal(byId.get(PICK_IDS.tier[0])![6], 'no outcome recorded');
  assert.ok(table.rows.filter((row: string[]) => row[2] === 'unrecorded').length >= 2);
  for (const value of Object.values(ADVICE_PLANTED)) assert.ok(!root.textContent.includes(value as string), `${value} is on no page`);
});

test('IC-018 recent picks: the not-shown line from limits.notShown', () => {
  const lineOf = (root: any) => sectionOf(root, 'advice-recent').querySelectorAll('p').map((p: El) => p.textContent).filter((t: string) => / not shown\.$/.test(t));
  assert.deepEqual(lineOf(render(BODY)), ['0 older picks in the window are not shown.']);
  const body = clone(BODY);
  body.sections.picks.data.limits.notShown = 4;
  assert.deepEqual(lineOf(render(body)), ['4 older picks in the window are not shown.']);
  body.sections.picks.data.limits.notShown = 1;
  assert.deepEqual(lineOf(render(body)), ['1 older pick in the window is not shown.']);
});

test('IC-018 kind filter: a labelled select of All and each kind that sets #/advice/kind/<kind> or #/advice', () => {
  const section = sectionOf(render(BODY), 'advice-recent');
  const select = section.querySelector('select');
  const label = section.querySelector('label');
  assert.ok(select.getAttribute('id'));
  assert.equal(label.getAttribute('for'), select.getAttribute('id'), 'the label names the select');
  const options = select.querySelectorAll('option');
  assert.deepEqual(options.map((o: El) => o.textContent), ['All', ...BODY.sections.picks.data.kinds]);
  assert.deepEqual(options.map((o: El) => o.getAttribute('value')), ['', ...BODY.sections.picks.data.kinds]);
  assert.ok(options[0].hasAttribute('selected'), 'All is selected with no kind');
  select.value = 'tier';
  select.fire('change');
  assert.equal(globalThis.location.hash, '#/advice/kind/tier');
  select.value = '';
  select.fire('change');
  assert.equal(globalThis.location.hash, '#/advice');

  const tierBody = clone(BODY);
  tierBody.kind = 'tier';
  tierBody.sections.picks.data.kind = 'tier';
  tierBody.sections.picks.data.kinds = ['tier'];
  tierBody.sections.picks.data.picks = tierBody.sections.picks.data.picks.filter((p: any) => p.kind === 'tier');
  const filtered = sectionOf(render(tierBody, { kind: 'tier' }), 'advice-recent');
  const filteredOptions = filtered.querySelector('select').querySelectorAll('option');
  assert.ok(filteredOptions.length > 2, 'the filter still offers every kind the report lists');
  const tierOption = filteredOptions.find((o: El) => o.getAttribute('value') === 'tier');
  assert.ok(tierOption?.hasAttribute('selected'));
  const links = filtered.querySelector('tbody').querySelectorAll('a');
  assert.deepEqual(links.map((a: El) => a.getAttribute('href')), PICK_IDS.tier.slice().reverse().map((id: string) => `#/advice/kind/tier/pick/${id}`));
});

test('IC-018 pick inspector: a row links to .../pick/<pickId>, and the inspector shows the same fields and the pick id', () => {
  const root = render(BODY);
  const links = sectionOf(root, 'advice-recent').querySelector('tbody').querySelectorAll('a');
  const picks = BODY.sections.picks.data.picks;
  assert.deepEqual(links.map((a: El) => a.getAttribute('href')), picks.map((p: any) => `#/advice/pick/${p.pickId}`));

  const inspector = fakeInspector();
  const linked: any[] = [];
  const id = PICK_IDS.taskClass[1];
  const local: any = { inspector, route: { id: 'advice', params: {}, pick: id }, link: (patch: any) => linked.push(patch) };
  const shown = view.renderAdvice(BODY, {}, local);
  const open = inspector.calls.filter((c: any) => c[0] === 'open');
  assert.equal(open.length, 1);
  const spec = open[0][1];
  const facts = new Map(factsOf(spec.body.querySelector('dl')));
  const pick = picks.find((p: any) => p.pickId === id);
  assert.equal(facts.get('Pick id'), id);
  assert.equal(facts.get('Kind'), 'task-class');
  assert.equal(facts.get('Time'), pick.at);
  assert.equal(facts.get('Mode'), 'unrecorded');
  assert.equal(facts.get("Model's pick"), 'bug');
  assert.equal(facts.get("Rule's answer"), 'bug');
  assert.equal(facts.get('Agreed'), 'yes');
  assert.equal(facts.get('Outcome'), 'feature, differs from the pick');
  assert.equal(facts.get('Outcome recorded at'), pick.outcome.at);
  assert.ok(spec.labelledBy && elementsOf(spec.body).some((el) => el.getAttribute('id') === spec.labelledBy), 'the panel is labelled by its heading');
  const selected = sectionOf(shown, 'advice-recent').querySelector('tbody').querySelectorAll('a').filter((a: El) => a.getAttribute('aria-current') === 'true');
  assert.deepEqual(selected.map((a: El) => a.getAttribute('href')), [`#/advice/pick/${id}`], 'the selected row is marked');

  spec.onClose();
  assert.deepEqual(linked, [null], 'closing the inspector goes back to the base route');

  // A reroute with no pick takes the panel away; one naming another pick shows that one.
  local.route = { id: 'advice', params: {} };
  view.rerouteAdvice(local, {}, BODY);
  assert.deepEqual(inspector.calls.at(-1), ['close']);
  local.route = { id: 'advice', params: {}, pick: PICK_IDS.tier[0] };
  view.rerouteAdvice(local, {}, BODY);
  assert.equal(inspector.calls.at(-1)[0], 'open');
  assert.equal(new Map(factsOf(inspector.calls.at(-1)[1].body.querySelector('dl'))).get('Pick id'), PICK_IDS.tier[0]);

  // A pick id the list does not hold says so.
  local.route = { id: 'advice', params: {}, pick: 'adv-0000000000000-000000' };
  view.rerouteAdvice(local, {}, BODY);
  assert.equal(inspector.calls.at(-1)[0], 'open');
  assert.match(inspector.calls.at(-1)[1].body.textContent, /adv-0000000000000-000000 is not among the picks this screen lists/);
});

// ---- sections that failed ----------------------------------------------------------------------

test('FR-029: a report section not in this core reads so in its parts, while the picks render', () => {
  const body = clone(BODY);
  body.sections.report = { ok: false, code: 'core-lacks-verb' };
  const root = render(body);
  for (const id of ['advice-gate', 'advice-figures']) {
    const notInCore = sectionOf(root, id).querySelectorAll('p').filter((p: El) => p.getAttribute('data-state') === 'not-in-core');
    assert.deepEqual(notInCore.map((p: El) => p.textContent), ['This DoFlow core does not provide the advice report.'], id);
  }
  assert.equal(sectionOf(root, 'advice-gate').querySelector('p').textContent, GATE_LEAD, 'the gate rule is stated still');
  assert.equal(sectionOf(root, 'advice-recent').querySelector('tbody').querySelectorAll('tr').length, BODY.sections.picks.data.picks.length);
  assert.ok(sectionOf(root, 'advice-days').querySelector('details'));
  assert.ok(sectionOf(root, 'advice-settings').querySelector('table'));
});

test('D13: a picks section with code usage is renderSection\'s inline error, never an empty list; the filter stays', () => {
  const body = clone(BODY);
  body.kind = 'nope';
  body.sections.picks = { ok: false, code: 'usage' };
  let retries = 0;
  const root = render(body, { kind: 'nope' }, { retry: () => { retries += 1; } });
  for (const id of ['advice-days', 'advice-recent']) {
    const section = sectionOf(root, id);
    const panel = section.querySelectorAll('section').find((s: El) => s.getAttribute('data-state') === 'error');
    if (!panel) throw new Error(`${id}: the inline error is missing`);
    assert.equal(panel.querySelector('.code-chip').textContent, 'usage');
    assert.equal(section.querySelectorAll('table').length, 0, `${id}: no table`);
    assert.ok(!/not shown\.|No pick/.test(section.textContent), `${id}: no empty list`);
  }
  const recent = sectionOf(root, 'advice-recent');
  assert.ok(recent.querySelector('select'), 'the kind filter is still offered');
  const retry = recent.querySelectorAll('button').find((b: El) => b.textContent === 'Retry');
  if (!retry) throw new Error('Retry button is missing');
  retry.fire('click');
  assert.equal(retries, 1, 'Retry reads the route again');
  assert.ok(sectionOf(root, 'advice-figures').querySelector('dl'), 'the report still renders');
});

test('an ok picks section with no pick says so', () => {
  const body = clone(BODY);
  body.sections.picks.data.picks = [];
  body.sections.picks.data.limits = { shown: 0, notShown: 0, skipped: 0 };
  const recent = sectionOf(render(body), 'advice-recent');
  assert.equal(recent.querySelectorAll('table').length, 0);
  assert.ok(recent.querySelectorAll('p').some((p: El) => p.textContent === 'No pick is recorded in the window.'));
});

// ---- text nodes, title --------------------------------------------------------------------------

test('NFR-005: every string reaches the page as a text node; links are fragments of the advice route only', () => {
  const body = clone(BODY);
  const row = body.sections.settings.data.keys.find((r: any) => r.key === 'advice.kinds.rerank');
  row.meta.description = '<img src=x onerror=alert(1)> held';
  const inspector = fakeInspector();
  const root = view.renderAdvice(body, {}, { inspector, route: { id: 'advice', params: {}, pick: PICK_IDS.tier[1] }, link: null });
  const panel = inspector.calls.find((c: any) => c[0] === 'open')[1].body;
  for (const node of [...nodesOf(root), ...nodesOf(panel)]) assert.ok(node instanceof El || node instanceof Txt);
  assert.ok(root.textContent.includes('<img src=x onerror=alert(1)> held'), 'planted markup is text');
  assert.equal(root.querySelectorAll('img').length, 0);
  for (const a of root.querySelectorAll('a')) assert.match(a.getAttribute('href'), /^#\/advice(?:\/kind\/[a-z][a-z0-9-]{0,31})?\/pick\/adv-[0-9]{13}-[0-9a-f]{6}$/);
  for (const tag of ['input', 'textarea', 'form']) assert.equal(root.querySelectorAll(tag).length, 0, tag);
  assert.ok(!elementsOf(root).some((el) => el.hasAttribute('contenteditable')));
});

test('adviceTitle: the screen name, with the kind when one is chosen', () => {
  assert.equal(view.adviceTitle({}, null), 'Advice and shadow');
  assert.equal(view.adviceTitle({ kind: 'tier' }, null), 'Advice and shadow · tier');
  assert.equal(view.adviceTitle({ kind: 'Bad Kind' }, null), 'Advice and shadow');
});
