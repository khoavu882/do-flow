// The Session screen (feature 150, IC-017; FR-001, FR-002, FR-004, FR-005, FR-007): one run's chain as an outline tree of
// its main session, stages and gates, tasks, attempts and worker runs (C.1's model, derive/chain.js), and an inspector panel
// for the selected node. Every string from the Console reaches the page as a text node (149 NFR-004). The tree owns its keys:
// Up, Down, Right, Left, Home and End move the focus and Enter or Space selects, on a listener of the tree element; no
// document listener and no shortcut entry is added (NFR-006).
//
// What C.5 wires into `VIEWS.session` (views.js):
//   shapes    SESSION_SHAPES (IC-017)
//   api       sessionApi(params): `/api/runs/<slug>/<taskId>`
//   load      loadSession(local, apiGet): reads the run and `/api/worker-runs/<slug>` and answers `{ run, workers, workersError }`;
//             a failed run read rejects as the GET does, a failed worker read is `workers: null` with `workersError`
//             `{ status, code, network }` (a 501 is an older core that does not list worker runs)
//   connect   connectSession: live-view.js's two-member connector (`parts`, IC-017), polling `load` every SESSION_POLL_MS
//   render    renderSession(data, params, local); skeleton: skeletonSession; reroute: rerouteSession(local, params, data);
//             tick: tickSession(root, nowMs, local); teardown: teardownSession(local)
// The selection comes in as `local.route.node` (IC-015's node object) and `local.route.tab`, and goes out through
// `local.link(patch)` with `{ node }` or `{ node, tab }` (null for none), which C.5 writes into the hash; groups (Tasks, Not
// linked) have no hash form and are expanded or collapsed instead of selected.
//
// Channels (IC-017): the connector holds `run:<slug>:<taskId>` and `tasks:<slug>`; this view subscribes `worker:<runId>` for
// the selected worker run, and its tabs (worker-tabs.js) hold `worker:<runId>:out` and `:err` while the Log tab is open. That
// is at most 5. Selecting another node drops the previous run's channels. The tabs get no platform: nothing in the Console
// says what the core's host is, and the core's own `liveness-unknown` reason makes Process read unknown where it applies.

import { h, icon, mount } from '../dom.js';
import { clockTime, skel } from '../states.js';
import { showPanel, hidePanel } from '../shell.js';
import { connectLive } from '../live-view.js';
import { deriveChain, headSentence, markerWords } from '../derive/chain.js';
import { mergeTasks, attemptsByTask, layoutGraph, attemptList } from '../derive/graph.js';
import { sinceStamp, formatDuration } from '../derive/rail.js';
import { railDetail } from './rail.js';
import { detailBody } from './graph.js';
import { mountWorkerTabs } from './worker-tabs.js';

/** The IC-003 shape ids the Session view reads (IC-017). */
const SESSION_SHAPES = Object.freeze(['status', 'timeline', 'attempts', 'workflow', 'worker-runs', 'worker-status', 'worker-run-status',
  'worker-result', 'worker-log', 'projects', 'transcript']);
/** The poll interval while live is unavailable: the Run view's (IC-017, proposed). */
const SESSION_POLL_MS = 3000;

/** IC-017's sentence for the main node. */
const UNLINKED_SESSION = 'No record ties a coding-tool session to this run, so the session is not shown.';
/** The outline head when the core has no worker-run list (a 501 on the `workers` member, FR-019). */
const WORKERS_NOT_IN_CORE = 'This DoFlow core does not list worker runs, so attempts’ worker runs are not checked.';
const NOT_IN_RECORDS = 'Nothing in this run’s records matches this item.';
const BAD_RUN_ID = 'The details of this worker run cannot be read: its id is not in the form DoFlow writes.';

const RUN_ID = /^w-[0-9a-f]{12}$/;
const PANEL_TITLE = 'chain-panel-title';

/** The 12 px face of each chip token. */
/** @type {Readonly<Record<string, string>>} */
const TOKEN_FACE = Object.freeze({ running: 'running', done: 'check', failed: 'failed', unknown: 'unknown', rejected: 'rejected', skipped: 'skipped', pending: 'pending', awaiting: 'awaiting', stale: 'stale' });
/** The word before a node's label in its accessible name. */
/** @type {Readonly<Record<string, string>>} */
const KIND_WORDS = Object.freeze({ main: 'Run', stage: 'Stage', gate: 'Gate', task: 'Task', worker: 'Worker run' });
/** Groups: no hash form, so activating one expands or collapses it. */
const GROUPS = Object.freeze(['tasks', 'unlinked']);

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object';

/** A failed `apiGet` as `{ status, code, network }`. @param {any} error */
const failureOf = (error) => ({
  status: error && typeof error.status === 'number' ? error.status : null,
  code: error && typeof error.code === 'string' ? error.code : null,
  network: Boolean(error && error.network === true),
});

/** @param {any} params */
const sessionApi = (params) => `/api/runs/${encodeURIComponent(params.slug)}/${encodeURIComponent(params.taskId)}`;
/** @param {string} slug */
const workersApi = (slug) => `/api/worker-runs/${encodeURIComponent(slug)}`;

/** The connector's parts (IC-017). */
const SESSION_PARTS = Object.freeze([
  Object.freeze({ channel: (/** @type {any} */ params) => `run:${params.slug}:${params.taskId}`, member: 'run', as: 'run' }),
  Object.freeze({ channel: (/** @type {any} */ params) => `tasks:${params.slug}`, member: 'workers', as: 'workers' }),
]);

/**
 * The view's GET read: the run and its feature's worker runs, side by side.
 * @param {any} local the view's memory (`local.route.params` names the run)
 * @param {(path: string) => Promise<any>} apiGet
 */
async function loadSession(local, apiGet) {
  const params = local.route.params;
  local.apiGet = apiGet;
  const [run, workers] = await Promise.all([
    apiGet(sessionApi(params)),
    apiGet(workersApi(params.slug)).then((body) => ({ body, error: null }), (error) => ({ body: null, error: failureOf(error) })),
  ]);
  return { run, workers: workers.body, workersError: workers.error };
}

const connectParts = connectLive({ parts: /** @type {any} */ (SESSION_PARTS), intervalMs: SESSION_POLL_MS });

/**
 * The view's `connect`: the two-member connector, with the page's GET and live store kept for the worker tabs.
 * @param {any} local @param {any} params @param {any} hooks
 */
function connectSession(local, params, hooks) {
  local.apiGet = hooks.fetchJson;
  local.liveStore = hooks.store;
  const connector = connectParts(local, params, hooks);
  local.connector = connector;
  return connector;
}

/** The loading outline. */
const skeletonSession = () => h('div', { class: 'skeleton chain', dataset: { state: 'loading' } }, [skel('skel--meta'), skel('skel--meta'), skel('skel--meta')]);

// ---- route and node keys ----------------------------------------------------------------------------------------------

/** The chain key (derive/chain.js `keyOf`) of an IC-015 route node, or null. @param {any} node */
function keyOfRouteNode(node) {
  if (!isObject(node)) return null;
  switch (node.kind) {
    case 'main': return 'main';
    case 'stage': case 'gate': case 'task': return typeof node.id === 'string' ? `${node.kind}:${node.id}` : null;
    case 'attempt': return typeof node.task === 'string' && Number.isInteger(node.token) ? `attempt:${node.task}/${node.token}` : null;
    case 'worker': return typeof node.runId === 'string' ? `worker:${node.runId}` : null;
    default: return null;
  }
}

/** The IC-015 route node of a chain node, or null for a group. @param {any} node */
function routeNodeOf(node) {
  switch (node.kind) {
    case 'main': return { kind: 'main' };
    case 'stage': case 'gate': return { kind: node.kind, id: node.ref.id };
    case 'task': return { kind: 'task', id: node.ref.id };
    case 'attempt': return { kind: 'attempt', task: node.ref.task, token: node.ref.token };
    case 'worker': return { kind: 'worker', runId: node.ref.runId };
    default: return null;
  }
}

// ---- memory -----------------------------------------------------------------------------------------------------------

/** @param {any} local */
function memoryOf(local) {
  if (local.session) return local.session;
  const route = isObject(local.route) ? local.route : {};
  local.session = {
    selected: keyOfRouteNode(route.node),
    tab: typeof route.tab === 'string' ? route.tab : 'log',
    focus: null,
    /** @type {Map<string, boolean>} expansion the person chose, by key */
    expanded: new Map(),
    /** @type {Map<string, any>} key -> { node, level, parent, li, group } of the drawn tree */
    items: new Map(),
    chain: null, data: null, params: null,
    panelHost: h('div', {}),
    tabsHost: h('div', {}),
    tabs: null, tabsRunId: null, workerOff: null, members: { worker: undefined, result: undefined },
    shown: null, panelSig: null, stale: false,
  };
  return local.session;
}

/** Whether a node with children is open: the person's choice, else main, the groups and any node with a live child. @param {any} memory @param {any} node */
function isOpen(memory, node) {
  if (node.children.length === 0) return false;
  const chosen = memory.expanded.get(node.key);
  if (chosen !== undefined) return chosen;
  return node.kind === 'main' || GROUPS.includes(node.kind) || (node.live ?? 0) > 0;
}

/** The keys of the items shown, in document order. @param {any} memory */
function visibleKeys(memory) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {any} */ node) => {
    out.push(node.key);
    if (isOpen(memory, node)) for (const child of node.children) walk(child);
  };
  if (memory.chain) walk(memory.chain.root);
  return out;
}

/** Opens every ancestor of `key` so it is shown. @param {any} memory @param {string} key */
function revealKey(memory, key) {
  let item = memory.items.get(key);
  while (item && item.parent !== null) {
    memory.expanded.set(item.parent, true);
    item = memory.items.get(item.parent);
  }
}

// ---- the outline ------------------------------------------------------------------------------------------------------

/** The accessible name of a tree item. @param {any} node */
function nameOf(node) {
  const lead = KIND_WORDS[node.kind] ? `${KIND_WORDS[node.kind]} ${node.label}` : node.label;
  const parts = [lead, node.chip.word];
  if ((node.live ?? 0) > 0) parts.push(`${node.live} live`);
  const marker = markerWords(node.marker);
  if (marker !== null) parts.push(marker);
  return parts.join(', ');
}

/** One node's row: label, chip, live count and marker. @param {any} node */
function rowOf(node) {
  const marker = markerWords(node.marker);
  return h('div', {}, [
    h('span', { class: node.kind === 'worker' || node.kind === 'main' ? 'mono' : null }, node.label),
    h('span', { class: 'badge chain__chip', dataset: { state: node.chip.token } }, [icon(TOKEN_FACE[node.chip.token] ?? 'pending', 12), node.chip.word]),
    (node.live ?? 0) > 0 ? h('span', { class: 'chain__live' }, `${node.live} live`) : null,
    marker !== null ? h('span', { class: 'chain__marker', dataset: { marker: node.marker } }, marker) : null,
  ]);
}

/** Builds the tree items of `node` and its children into `list`. @param {any} memory @param {any} node @param {number} level @param {string | null} parent @param {any} list */
function buildItem(memory, node, level, parent, list) {
  const li = h('li', {
    class: 'chain__item', role: 'treeitem', tabindex: '-1', 'aria-level': String(level), 'aria-label': nameOf(node),
    dataset: { key: node.key, kind: node.kind, focusKey: `chain:${node.key}` },
  }, rowOf(node));
  /** @type {any} */
  let group = null;
  if (node.children.length > 0) {
    group = h('ul', { role: 'group' });
    li.append(group);
  }
  memory.items.set(node.key, { node, level, parent, li, group });
  list.append(li);
  for (const child of node.children) buildItem(memory, child, level + 1, node.key, group);
}

/** Applies selection, expansion and the tab stop to the drawn items in place. @param {any} memory */
function paintTree(memory) {
  const shown = new Set(visibleKeys(memory));
  if (memory.focus === null || !shown.has(memory.focus)) {
    // The tab stop: the focused item, else the selected one, else the nearest shown ancestor of either, else main.
    let key = memory.focus ?? memory.selected;
    let item = key === null ? undefined : memory.items.get(key);
    while (item && !shown.has(item.node.key)) item = item.parent === null ? undefined : memory.items.get(item.parent);
    key = item ? item.node.key : 'main';
    memory.focus = key;
  }
  for (const [key, item] of memory.items) {
    const open = isOpen(memory, item.node);
    if (item.group) {
      item.li.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) item.group.removeAttribute('hidden');
      else item.group.setAttribute('hidden', '');
    }
    if (key === memory.selected) item.li.setAttribute('aria-selected', 'true');
    else item.li.removeAttribute('aria-selected');
    item.li.setAttribute('tabindex', key === memory.focus ? '0' : '-1');
  }
}

/** Moves the focus (and the tab stop) to `key`. @param {any} memory @param {string} key */
function focusKey(memory, key) {
  memory.focus = key;
  paintTree(memory);
  const item = memory.items.get(key);
  if (item) item.li.focus();
}

/** The outline head: what was not read, and why there are no tasks. @param {any} data @param {any} chain */
function headNotes(data, chain) {
  const notes = [];
  const failed = isObject(data.workersError) ? data.workersError : null;
  if (failed && failed.status === 501) notes.push(WORKERS_NOT_IN_CORE);
  else {
    const sentence = headSentence(chain.counts);
    if (sentence !== null) notes.push(sentence);
  }
  const tasks = chain.byKey.get('tasks');
  if (tasks && tasks.ref && typeof tasks.ref.sentence === 'string') notes.push(tasks.ref.sentence);
  return notes;
}

/** The outline's state: ready, partial (some worker runs not read), or not-in-core (the core lists no worker runs). @param {any} data @param {any} chain */
function outlineState(data, chain) {
  const failed = isObject(data.workersError) ? data.workersError : null;
  if (failed && failed.status === 501) return 'not-in-core';
  return failed || headSentence(chain.counts) !== null ? 'partial' : 'ready';
}

// ---- the inspector panels ---------------------------------------------------------------------------------------------

/** One term and value of a facts list. @param {string} term @param {any} value */
const fact = (term, value) => h('div', { class: 'facts__row' }, [h('dt', {}, term), h('dd', {}, value)]);

/** A time as a `time` element in local HH:MM:SS, or `missing`. @param {any} iso @param {string} missing */
function timeOr(iso, missing) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? h('time', { datetime: iso }, clockTime(ms)) : missing;
}

/** @param {any} text @param {boolean} [mono] */
const title = (text, mono = false) => h('h2', { id: PANEL_TITLE, class: mono ? 'mono' : null }, text);

/** The main node: the run's own facts and the unlinked sentence. @param {any} node */
function mainPanel(node) {
  const ref = node.ref;
  return [
    title(node.label, true),
    h('span', { class: 'badge', dataset: { state: node.chip.token } }, [icon(TOKEN_FACE[node.chip.token] ?? 'pending', 12), node.chip.word]),
    h('dl', { class: 'facts' }, [
      fact('Feature', ref.featureSlug ?? 'not recorded'),
      fact('Class', ref.taskClass ?? 'not recorded'),
      fact('Workflow', ref.workflowName ?? 'not recorded'),
      fact('Started', timeOr(ref.startedAt, 'not recorded')),
      fact('Updated', timeOr(ref.updatedAt, 'not recorded')),
    ]),
    h('p', {}, UNLINKED_SESSION),
  ];
}

/** The task's merged row and graph card, as the Tasks view has them. @param {any} tasksBody @param {string} id */
function taskAndCard(tasksBody, id) {
  let tasks = mergeTasks(tasksBody);
  if (tasks === null || !tasks.some((task) => task.id === id)) {
    // A task row the plan graph does not list: drawn alone, with no dependencies.
    const row = isObject(tasksBody) && Array.isArray(tasksBody.tasks) ? tasksBody.tasks.find((/** @type {any} */ task) => isObject(task) && task.id === id) : null;
    tasks = /** @type {any[]} */ (mergeTasks({ graph: { tasks: [{ id }] }, tasks: row ? [row] : [] }));
  }
  const layout = layoutGraph(tasks, attemptsByTask(tasks));
  return { task: tasks.find((task) => task.id === id), card: layout.cards.find((card) => card.id === id) };
}

/** The attempt's row of the Tasks panel's list (graph.js detailBody draws the same row). @param {any} ref @param {number} nowMs */
function attemptRow(ref, nowMs) {
  const [attempt] = attemptList([ref]);
  const start = attempt.startedAt === null ? null : sinceStamp(Date.parse(attempt.startedAt), nowMs);
  const end = attempt.endedAt === null ? null : sinceStamp(Date.parse(attempt.endedAt), nowMs);
  const took = formatDuration(attempt.durationMs);
  const when = start === null ? 'start not recorded' : end === null ? `since ${start}` : `${start} to ${end}${took === null ? '' : ` (${took})`}`;
  return h('ol', { class: 'gattempts' }, h('li', { class: 'gattempt', dataset: { state: attempt.state } }, [
    h('span', { class: 'gattempt__no' }, `Attempt ${ref.token}`),
    h('span', { class: 'gattempt__owner' }, `${attempt.owner ?? 'unknown owner'} · ${attempt.mode ?? 'unknown mode'}`),
    h('span', { class: 'gattempt__state' }, attempt.result === null ? attempt.state : `${attempt.state}, ${attempt.result}`),
    h('span', { class: 'gattempt__when' }, when),
  ]));
}

/**
 * The panel of a node that is not a worker run: `{ title, labelledBy, body }`.
 * @param {any} local @param {any} node @param {number} nowMs
 */
function staticPanel(local, node, nowMs) {
  const memory = local.session;
  const data = memory.data;
  if (node.kind === 'stage' || node.kind === 'gate') {
    return { title: 'Step details', labelledBy: 'rail-detail-title', body: railDetail(node.ref, data.run && data.run.workflow, { onEscape: () => select(local, null, true, true) }) };
  }
  if (node.kind === 'task') {
    const { task, card } = taskAndCard(data.run && data.run.tasks, node.ref.id);
    return { title: 'Task details', labelledBy: PANEL_TITLE, body: [title(node.ref.id, true), detailBody(task, card, nowMs)] };
  }
  if (node.kind === 'attempt') {
    return { title: 'Attempt details', labelledBy: PANEL_TITLE, body: [title([h('span', { class: 'mono' }, node.ref.task), ` · Attempt ${node.ref.token}`]), attemptRow(node.ref, nowMs)] };
  }
  return { title: 'Run details', labelledBy: PANEL_TITLE, body: mainPanel(node) };
}

/** Closes the selected worker run's tabs and drops its channel. @param {any} memory */
function closeWorker(memory) {
  if (memory.workerOff) memory.workerOff();
  memory.workerOff = null;
  if (memory.tabs) memory.tabs.destroy();
  memory.tabs = null;
  memory.tabsRunId = null;
  memory.members = { worker: undefined, result: undefined };
}

/** The selected worker run's row of the worker-runs list (the tabs read IC-011's row), else the chain's copy. @param {any} memory @param {any} node */
function workerRow(memory, node) {
  const workers = memory.data && memory.data.workers;
  const rows = isObject(workers) && Array.isArray(workers.runs) ? workers.runs : [];
  return rows.find((/** @type {any} */ row) => isObject(row) && row.runId === node.ref.runId) ?? node.ref;
}

/** Opens (or patches) the worker tabs of `node` and follows `worker:<runId>`. @param {any} local @param {any} node */
function openWorker(local, node) {
  const memory = local.session;
  const runId = node.ref.runId;
  const row = workerRow(memory, node);
  if (memory.tabs && memory.tabsRunId === runId) {
    memory.tabs.update({ run: row });
    return;
  }
  closeWorker(memory);
  const store = typeof local.liveStore === 'function' ? local.liveStore() : local.liveStore;
  memory.tabs = mountWorkerTabs(memory.tabsHost, {
    apiGet: local.apiGet, store, slug: memory.params.slug, run: row, tab: memory.tab, platform: null,
    onTab: (/** @type {string} */ tab) => {
      memory.tab = tab;
      if (typeof local.link === 'function') local.link({ node: { kind: 'worker', runId }, tab });
    },
  });
  memory.tabsRunId = runId;
  if (memory.stale) memory.tabs.update({ stale: true });
  memory.workerOff = store.subscribe(`worker:${runId}`, (/** @type {any} */ event) => {
    if (!memory.tabs || memory.tabsRunId !== runId || !event || event.kind !== 'state' || !isObject(event.state)) return;
    /** @type {Record<string, any>} */
    const patch = {};
    for (const name of /** @type {Array<'worker' | 'result'>} */ (['worker', 'result'])) {
      const entry = event.state[name];
      if (entry !== undefined && entry !== memory.members[name]) {
        memory.members[name] = entry;
        patch[name] = entry;
      }
    }
    if (Object.keys(patch).length > 0) memory.tabs.update(patch);
  });
}

/** Shows the selected node's panel in the inspector, or takes it away; opens and closes the worker channels. @param {any} local */
function showSelection(local) {
  const memory = local.session;
  const key = memory.selected;
  if (key === null) {
    closeWorker(memory);
    memory.shown = null;
    memory.panelSig = null;
    hidePanel(local.inspector, local);
    return;
  }
  const node = memory.chain ? memory.chain.byKey.get(key) : undefined;
  const nowMs = Date.now();
  /** @type {{ title: string, labelledBy: string, body: any }} */
  let spec;
  let sig;
  if (node && node.kind === 'worker' && RUN_ID.test(node.ref.runId)) {
    openWorker(local, node);
    spec = { title: 'Worker run', labelledBy: PANEL_TITLE, body: [title(node.ref.runId, true), memory.tabsHost] };
    // The tabs patch themselves: their panel is drawn again only when another run is selected.
    sig = JSON.stringify(['worker', node.ref.runId]);
  } else {
    closeWorker(memory);
    if (!node) spec = { title: 'Details', labelledBy: PANEL_TITLE, body: [title('Not in the records'), h('p', {}, NOT_IN_RECORDS)] };
    else if (node.kind === 'worker') spec = { title: 'Worker run', labelledBy: PANEL_TITLE, body: [title(node.ref.runId, true), h('p', {}, BAD_RUN_ID)] };
    else spec = staticPanel(local, node, nowMs);
    sig = JSON.stringify([key, node ? [node.ref, node.chip, node.marker] : null, node && node.kind === 'main' ? memory.data.run : null, node && (node.kind === 'stage' || node.kind === 'gate') ? memory.data.run.workflow : null]);
  }
  if (sig !== memory.panelSig) {
    memory.panelSig = sig;
    mount(memory.panelHost, spec.body);
  }
  if (memory.shown === key) return;
  memory.shown = key;
  const item = memory.items.get(key);
  showPanel(local.inspector, local, {
    title: spec.title,
    labelledBy: spec.labelledBy,
    body: memory.panelHost,
    owner: item ? item.li : null,
    // The inspector's own close, Escape or scrim: the selection ends and the focus goes back to the item.
    onClose: () => {
      memory.shown = null;
      memory.panelSig = null;
      select(local, null, true, true, true);
    },
  });
}

/**
 * Selects `key` (null for none): marks the tree, shows the panel and, when `link`, reports the selection for the hash.
 * @param {any} local @param {string | null} key @param {boolean} link @param {boolean} [refocus] focus the item that was selected
 * @param {boolean} [closed] the inspector already closed itself
 */
function select(local, key, link, refocus = false, closed = false) {
  const memory = local.session;
  const previous = memory.selected;
  memory.selected = key;
  if (key !== null) {
    revealKey(memory, key);
    memory.focus = key;
  }
  paintTree(memory);
  if (closed) closeWorker(memory);
  else showSelection(local);
  if (refocus && previous !== null) {
    const item = memory.items.get(previous);
    if (item) item.li.focus();
  }
  if (link && typeof local.link === 'function') {
    const node = key === null ? null : memory.chain.byKey.get(key);
    const routeNode = node ? routeNodeOf(node) : null;
    local.link(routeNode === null ? null : { node: routeNode });
  }
}

/** Enter, Space or a click on an item: a group opens or closes; a node is selected (again: it opens or closes). @param {any} local @param {string} key */
function activate(local, key) {
  const memory = local.session;
  const item = memory.items.get(key);
  if (!item) return;
  const node = item.node;
  if (GROUPS.includes(node.kind) || (key === memory.selected && node.children.length > 0)) {
    memory.expanded.set(key, !isOpen(memory, node));
    memory.focus = key;
    paintTree(memory);
    return;
  }
  if (node.children.length > 0) memory.expanded.set(key, true);
  if (key === memory.selected) return;
  // Another worker run opens on Log, as its hash without a tab says (IC-015).
  if (node.kind === 'worker') memory.tab = 'log';
  select(local, key, true);
}

/** The tree's keys (WAI-ARIA tree view): a listener on the tree element only. @param {any} local @param {any} event */
function onTreeKey(local, event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const memory = local.session;
  const owner = event.target && typeof event.target.closest === 'function' ? event.target.closest('[role="treeitem"]') : null;
  const key = owner && owner.dataset ? owner.dataset.key : memory.focus;
  const item = key ? memory.items.get(key) : undefined;
  if (!item) return;
  const shown = visibleKeys(memory);
  const at = shown.indexOf(key);
  const node = item.node;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (at < shown.length - 1) focusKey(memory, shown[at + 1]);
      break;
    case 'ArrowUp':
      event.preventDefault();
      if (at > 0) focusKey(memory, shown[at - 1]);
      break;
    case 'Home':
      event.preventDefault();
      focusKey(memory, shown[0]);
      break;
    case 'End':
      event.preventDefault();
      focusKey(memory, shown[shown.length - 1]);
      break;
    case 'ArrowRight':
      event.preventDefault();
      if (node.children.length === 0) break;
      if (!isOpen(memory, node)) {
        memory.expanded.set(key, true);
        paintTree(memory);
      } else focusKey(memory, node.children[0].key);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      if (node.children.length > 0 && isOpen(memory, node)) {
        memory.expanded.set(key, false);
        paintTree(memory);
      } else if (item.parent !== null) focusKey(memory, item.parent);
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      activate(local, key);
      break;
    default:
  }
}

/**
 * The Session view's body: the outline head and tree, with the selected node's panel in the inspector. What must outlive a
 * re-mount (selection, expansion, the tab stop, the worker tabs and their channels) is kept in `local.session`.
 * @param {any} data `{ run, workers, workersError }` (loadSession or the connector)
 * @param {{ slug: string, taskId: string }} params
 * @param {any} local the view instance's own memory
 */
function renderSession(data, params, local) {
  const memory = memoryOf(local);
  memory.data = data;
  memory.params = params;
  const chain = deriveChain({ run: data.run, workers: data.workers, nowMs: Date.now() });
  memory.chain = chain;
  memory.items = new Map();
  const tree = h('ul', { role: 'tree', 'aria-label': 'Run chain' });
  buildItem(memory, chain.root, 1, null, tree);
  tree.addEventListener('keydown', (/** @type {any} */ event) => onTreeKey(local, event));
  tree.addEventListener('click', (/** @type {any} */ event) => {
    const owner = event.target && typeof event.target.closest === 'function' ? event.target.closest('[role="treeitem"]') : null;
    if (!owner || !owner.dataset || !memory.items.has(owner.dataset.key)) return;
    memory.focus = owner.dataset.key;
    activate(local, owner.dataset.key);
    owner.focus();
  });
  if (memory.selected !== null && memory.items.has(memory.selected)) revealKey(memory, memory.selected);
  paintTree(memory);
  showSelection(local);
  return h('section', { class: 'chain', 'aria-label': 'Run chain outline', dataset: { state: outlineState(data, chain) } }, [
    ...headNotes(data, chain).map((sentence) => h('p', {}, sentence)),
    tree,
  ]);
}

/** The route's selection changed without a re-mount (IC-015): select its node and tab on the mounted outline. @param {any} local */
function rerouteSession(local) {
  const memory = local.session;
  if (!memory || !memory.chain) return;
  const route = isObject(local.route) ? local.route : {};
  const key = keyOfRouteNode(route.node);
  const tab = typeof route.tab === 'string' ? route.tab : 'log';
  const tabChanged = tab !== memory.tab;
  memory.tab = tab;
  if (key !== memory.selected) select(local, key, false);
  else if (tabChanged && memory.tabs) memory.tabs.update({ tab });
}

/** The shell's 1 s tick: the worker tabs carry the connector's stale state. @param {any} _root @param {number} _nowMs @param {any} local */
function tickSession(_root, _nowMs, local) {
  const memory = local.session;
  if (!memory || !local.connector) return;
  const stale = local.connector.isStale() === true;
  if (stale === memory.stale) return;
  memory.stale = stale;
  if (memory.tabs) memory.tabs.update({ stale });
}

/** Leaving the view: the worker tabs close and the worker channels are dropped. @param {any} local */
function teardownSession(local) {
  if (local.session) closeWorker(local.session);
}

export {
  SESSION_SHAPES, SESSION_PARTS, SESSION_POLL_MS, UNLINKED_SESSION, WORKERS_NOT_IN_CORE,
  sessionApi, loadSession, connectSession, skeletonSession, renderSession, rerouteSession, tickSession, teardownSession,
  keyOfRouteNode, routeNodeOf,
};
