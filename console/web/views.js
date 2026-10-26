// The views table of the shell (D.2 note sections 2, 6.1, 6.2, 8 and 10): per route its title, view noun,
// the shape ids it reads (IC-003; client-core.test.ts checks them against the allow-list), poll interval,
// skeleton, head and loaded renderer. Nothing here runs at import time.

import { h, icon } from './dom.js';
import { skel, reltime } from './states.js';

/**
 * The core range this Console needs. IC-005 sends no range, so this is a client literal; client-core.test.ts
 * asserts it equals console/package.json `doflowCore`.
 */
const CORE_RANGE = '>=2.0.0-beta.7 <3.0.0';

/** IC-003's parameter pattern: a route parameter failing it is not-found before any fetch. */
const PARAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PRODUCT = 'DoFlow Console';
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- loaded pieces ----------------------------------------------------------------------------------

/** The run state badge (design-system 4): shape, word and tint together. */
/** @type {Record<string, { token: string, face: string, word: string }>} */
const BADGES = Object.freeze({
  RUNNING: { token: 'running', face: 'running', word: 'Running' },
  AWAITING_GATE: { token: 'awaiting', face: 'awaiting', word: 'Waiting for you' },
  COMPLETED: { token: 'done', face: 'check', word: 'Completed' },
  REJECTED: { token: 'rejected', face: 'rejected', word: 'Rejected' },
  stale: { token: 'stale', face: 'stale', word: 'Stale' },
});

/** @param {any} run @param {any} nowMs */
function badge(run, nowMs) {
  const updated = Date.parse(run.updatedAt);
  const staleRun = run.state === 'RUNNING' && Number.isFinite(updated) && nowMs - updated > DAY_MS;
  const spec = staleRun ? BADGES.stale : BADGES[run.state];
  return h('span', { class: 'badge', dataset: { state: spec.token } }, [icon(spec.face, 12), spec.word]);
}

/** @param {any} options */
function tile({ label, face, token, count, attention }) {
  return h('div', { class: 'tile', dataset: { state: token, attention: attention ? 'true' : null } }, [
    h('p', { class: 'tile__label' }, [icon(face, 12), label]),
    h('p', { class: 'tile__count' }, String(count)),
  ]);
}

const countOf = (/** @type {any[]} */ runs, /** @type {string[]} */ ...states) => runs.filter((run) => states.includes(run.state)).length;
const awaitingCount = (/** @type {any} */ data) => countOf(data.runs, 'AWAITING_GATE');

/** @param {any} data */
function renderRuns(data) {
  const needs = awaitingCount(data);
  const unreadable = data.unreadableCount;
  return [
    h('div', { class: 'summary' }, [
      tile({ label: 'Needs you', face: 'awaiting', token: 'awaiting', count: needs, attention: needs > 0 }),
      tile({ label: 'Running', face: 'running', token: 'running', count: countOf(data.runs, 'RUNNING') }),
      tile({ label: 'Finished', face: 'check', token: 'done', count: countOf(data.runs, 'COMPLETED', 'REJECTED') }),
    ]),
    unreadable > 0 ? h('p', { class: 'view-note' }, `${unreadable} ${unreadable === 1 ? 'run' : 'runs'} could not be read.`) : null,
  ];
}

/** @param {any} params @param {any} data @param {any} nowMs */
function runMeta(params, data, nowMs) {
  if (!data) return null;
  const { run } = data;
  // One element per item: adjacent text nodes would merge into a single flex item with no gap between them.
  return h('p', { class: 'view-head__meta' }, [
    h('span', {}, run.taskClass),
    badge(run, nowMs),
    h('span', {}, `revision ${run.revision}`),
    h('span', {}, run.updatedAt ? ['Updated ', reltime(run.updatedAt, nowMs)] : 'Update time unknown'),
  ]);
}

const note = (/** @type {string} */ text) => h('p', { class: 'view-note' }, text);
const slugTask = (/** @type {any} */ params) => `${params.slug} / ${params.taskId}`;

// ---- skeletons (6.1): the heights are binding for the views that fill them -------------------------

const skeletonRuns = () => h('div', { class: 'skeleton' }, [
  h('div', { class: 'summary' }, [skel('skel--tile'), skel('skel--tile'), skel('skel--tile')]),
  h('div', { class: 'skel-rows' }, [skel('skel--row'), skel('skel--row'), skel('skel--row'), skel('skel--row')]),
]);

const skeletonRun = () => h('div', { class: 'skeleton' }, [
  skel('skel--meta'),
  h('div', { class: 'skel-rail' }, [skel('skel--step'), skel('skel--step'), skel('skel--step'), skel('skel--step')]),
  skel('skel--slot'),
]);

const skeletonBlock = () => h('div', { class: 'skeleton' }, skel('skel--block'));

// ---- the table --------------------------------------------------------------------------------------

/**
 * Each view: `id`; `noun` (error and loading copy); `shapes` (IC-003 ids it reads); `api(params)` the same-origin
 * path it reads, or null; `pollMs`; `wide`; `skeleton`; `head(params)` the h1; `meta(params, data, nowMs)`;
 * `render(data, params)`; `isEmpty(data)`; `empty`; `title(params, data)`.
 */
/** @type {Record<string, any>} */
const VIEWS = Object.freeze({
  runs: {
    id: 'runs',
    noun: 'runs',
    shapes: ['list'],
    api: () => '/api/runs',
    pollMs: 5000,
    wide: false,
    skeleton: skeletonRuns,
    head: () => ({ text: 'Runs', mono: false }),
    meta: () => null,
    render: renderRuns,
    isEmpty: (/** @type {any} */ data) => data.runs.length === 0,
    empty: {
      title: 'No runs yet',
      sentence: 'A run appears here as soon as a workflow starts in this project. Start one from your coding tool:',
      command: '/do <describe the change you want>',
      note: 'Runs refresh every 5 seconds while this tab is open.',
    },
    title: (/** @type {any} */ params, /** @type {any} */ data) => `${data && awaitingCount(data) > 0 ? `(${awaitingCount(data)}) ` : ''}Runs`,
  },
  run: {
    id: 'run',
    noun: 'this run',
    shapes: ['status', 'timeline', 'attempts', 'workflow'],
    api: (/** @type {any} */ params) => `/api/runs/${params.slug}/${params.taskId}`,
    pollMs: 3000,
    wide: false,
    skeleton: skeletonRun,
    head: (/** @type {any} */ params) => ({ text: slugTask(params), mono: true }),
    meta: runMeta,
    render: () => null,
    isEmpty: () => false,
    title: (/** @type {any} */ params) => slugTask(params),
  },
  tasks: {
    id: 'tasks',
    noun: 'tasks',
    shapes: [],
    api: () => null,
    pollMs: 5000,
    wide: false,
    skeleton: skeletonBlock,
    head: () => ({ text: 'Tasks', mono: false }),
    meta: (/** @type {any} */ params) => h('p', { class: 'view-head__meta mono' }, slugTask(params)),
    render: () => note('Built in plan task E.3.'),
    isEmpty: () => false,
    title: (/** @type {any} */ params) => `Tasks · ${slugTask(params)}`,
  },
  workflows: {
    id: 'workflows',
    noun: 'workflows',
    shapes: [],
    api: () => null,
    pollMs: 5000,
    wide: false,
    skeleton: skeletonBlock,
    head: () => ({ text: 'Workflows', mono: false }),
    meta: () => null,
    render: () => note('Built in plan task F.2.'),
    isEmpty: () => false,
    title: () => 'Workflows',
  },
  'not-found': {
    id: 'not-found',
    noun: 'this page',
    shapes: [],
    api: () => null,
    pollMs: 5000,
    wide: false,
    skeleton: skeletonBlock,
    head: () => ({ text: 'Not found', mono: false }),
    meta: () => null,
    render: () => null,
    isEmpty: () => false,
    title: () => 'Not found',
  },
});

/** Every shape id any view reads (the test checks this set against the verb allow-list). */
const SHAPES_USED = Object.freeze([...new Set(Object.values(VIEWS).flatMap((view) => view.shapes))]);

/**
 * A location hash to `{ id, params, view }`. An unknown route, or a parameter failing IC-003's pattern,
 * is `not-found`: no fetch is made for it.
 * @param {any} hash
 */
function parseRoute(hash) {
  const text = String(hash ?? '');
  const path = text === '' || text === '#' ? '/' : text.startsWith('#/') ? text.slice(1) : null;
  const notFound = { id: 'not-found', params: {}, view: VIEWS['not-found'] };
  if (path === null) return notFound;
  if (path === '/') return { id: 'runs', params: {}, view: VIEWS.runs };
  if (path === '/workflows') return { id: 'workflows', params: {}, view: VIEWS.workflows };
  const parts = path.split('/'); // ['', 'run', slug, taskId, 'tasks'?]
  if (parts[1] !== 'run' || parts.length < 4 || parts.length > 5) return notFound;
  const [slug, taskId] = [parts[2], parts[3]];
  if (!PARAM_PATTERN.test(slug) || !PARAM_PATTERN.test(taskId)) return notFound;
  if (parts.length === 4) return { id: 'run', params: { slug, taskId }, view: VIEWS.run };
  return parts[4] === 'tasks' ? { id: 'tasks', params: { slug, taskId }, view: VIEWS.tasks } : notFound;
}

/**
 * `document.title` for a route (data is the last loaded body, or null).
 * @param {any} route
 * @param {any} [data]
 */
function titleFor(route, data = null) {
  const view = route.view;
  const base = view.title(route.params, data);
  return `${base} · ${PRODUCT}`;
}

/**
 * Which nav link is current: Runs on `#/` and every `#/run/...`, Workflows on `#/workflows`, else none.
 * @param {any} route
 */
function navFor(route) {
  if (route.id === 'workflows') return 'workflows';
  return route.id === 'not-found' ? null : 'runs';
}

export { CORE_RANGE, PARAM_PATTERN, VIEWS, SHAPES_USED, parseRoute, titleFor, navFor, badge, awaitingCount };
