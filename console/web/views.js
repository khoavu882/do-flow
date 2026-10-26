// The views table of the shell (D.2 note sections 2, 6.1, 6.2, 8 and 10): per route its title, view noun,
// the shape ids it reads (IC-003; client-core.test.ts checks them against the allow-list), poll interval,
// skeleton, head and loaded renderer. Nothing here runs at import time.

import { h, icon } from './dom.js';
import { skel, reltime } from './states.js';
import { loadHome, renderHome, skeletonHome, homeKey, tickHome } from './views/home.js';
import { renderRun, tickRun, releaseRun } from './views/run.js';
import { renderGraph } from './views/graph.js';
import { renderSessions } from './views/sessions.js';
import { renderWorkflows } from './views/workflows.js';
import { deriveSessions } from './derive/sessions.js';
import { runStepCopy } from './derive/rail.js';
import { workflowsOf } from './derive/workflows.js';
import {
  connectFleet, tickFleet, teardownFleet, renderFleetList, updateFleetList, listMeta, listEmpty, buildProjectHead, renderProject, updateProject,
  rerouteProject, projectMeta, projectTitle, skeletonFleetList, skeletonFleetProject,
} from './views/fleet.js';

/**
 * The core range this Console needs. IC-005 sends no range, so this is a client literal; client-core.test.ts
 * asserts it equals console/package.json `doflowCore`.
 */
const CORE_RANGE = '>=2.0.0-beta.7 <3.0.0';

/** IC-003's parameter pattern: a route parameter failing it is not-found before any fetch. */
const PARAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The Fleet keys of IC-019 and IC-020: 16 lower-case hex. */
const KEY16 = /^[0-9a-f]{16}$/;

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

const awaitingCount = (/** @type {any} */ data) => data.runs.filter((/** @type {any} */ run) => run.state === 'AWAITING_GATE').length;

/** The run head (CD-B8): crumb to Runs, the title with a muted task id, the meta line and the step counter. @param {any} params */
function buildRunHead(params) {
  const crumb = h('nav', { class: 'run-head__crumb', 'aria-label': 'Breadcrumb' }, [
    h('a', { href: '#/' }, 'Runs'), h('span', { 'aria-hidden': 'true' }, ' / '), h('span', { class: 'mono' }, params.slug),
  ]);
  const h1 = h('h1', { class: 'run-head__title', tabindex: '-1' }, [h('span', {}, params.slug), h('span', { class: 'run-head__task' }, ` / ${params.taskId}`)]);
  const meta = h('div', { class: 'run-head__metawrap' });
  const step = h('p', { class: 'run-head__step', hidden: true });
  return { root: h('header', { class: 'view-head run-head' }, [crumb, h1, meta, step]), h1, meta, step };
}

/** The meta line of the run head: badge, workflow name, started, revision, updated; one element per item. @param {any} params @param {any} data @param {any} nowMs */
function runMeta(params, data, nowMs) {
  if (!data) return null;
  const { run } = data;
  const started = Date.parse(run.startedAt);
  const items = [
    badge(run, nowMs),
    h('span', {}, run.workflowName || (data.workflow && data.workflow.name) || run.taskClass),
    Number.isFinite(started) ? h('span', {}, ['started ', reltime(run.startedAt, nowMs)]) : null,
    h('span', {}, `revision ${run.revision}`),
    h('span', {}, run.updatedAt ? ['Updated ', reltime(run.updatedAt, nowMs)] : 'Update time unknown'),
  ].filter(Boolean);
  // One element per item: adjacent text nodes would merge into a single flex item with no gap between them.
  return h('p', { class: 'view-head__meta run-head__meta' }, items.flatMap((item, index) => (index === 0 ? [item] : [h('span', { class: 'run-head__sep', 'aria-hidden': 'true' }, '·'), item])));
}

/** The step counter of the run head, or null without progress. @param {any} params @param {any} data */
function runStep(params, data) {
  const copy = data ? runStepCopy(data.run) : null;
  return copy === null ? null : [copy.lead, copy.n === null ? null : h('span', { class: 'run-head__step-n' }, String(copy.n)), copy.tail];
}

const slugTask = (/** @type {any} */ params) => `${params.slug} / ${params.taskId}`;

// ---- skeletons (6.1): the heights are binding for the views that fill them -------------------------

// The crumb and the h1 are real text; the meta line and, below 768, a step line fill the head; the body holds the rail card, the slot and the timeline (D.2 6.1 as amended by E.2 10.2).
const skeletonRun = () => h('div', { class: 'skeleton skeleton--run' }, [skel('skel--railcard'), skel('skel--slot'), skel('skel--timeline')]);
// The meta and step blocks go inside the head, in the slots the loaded meta and step fill (R3-3), so the head keeps its height.
const skeletonRunHead = () => ({ meta: skel('skel--meta'), step: skel('skel--stepline') });

const skeletonBlock = () => h('div', { class: 'skeleton' }, skel('skel--block'));

// Row skeletons of the Sessions view (E.7 7a): three checkout rows of the loaded rows' height.
const skeletonSessions = () => h('div', { class: 'skeleton skeleton--sessions' }, [skel('skel--srow'), skel('skel--srow'), skel('skel--srow')]);

/**
 * The Sessions body is re-mounted when the body changes or when the set of conflicts does: C2 (a claim passing 24 h) and
 * C4 depend on the clock, so a quiet body can still raise one.
 * @param {any} data
 */
const sessionsKey = (data) => JSON.stringify([data, deriveSessions(data, Date.now()).conflicts.map((conflict) => conflict.id)]);

// ---- the table --------------------------------------------------------------------------------------

/**
 * Each view: `id`; `noun` (error and loading copy); `shapes` (IC-003 ids it reads); `api(params)` the same-origin
 * path it reads, or null; `pollMs`; `wide`; `skeleton`; `head(params)` the h1; `meta(params, data, nowMs)`;
 * `render(data, params, local)` where `local` is the view instance's own memory; `isEmpty(data)`; `empty`;
 * `title(params, data)`. Optional: `load(local, apiGet)` reads more than `api` names; `dataKey(data)` decides when
 * the body is re-mounted; `tick(root, nowMs, local)` runs on the shell's 1 s timer. A `live: true` view (V.10, the Fleet
 * views) is mounted once and then patched: `connect(local, params, hooks)` returns a poller-shaped object over a stream,
 * `update(local, data, params)` patches the mounted body, `reroute(local, params, data)` moves between routes of one view
 * without a re-mount (the selected agent changed), and `empty` may be a function of the data.
 */
/** @type {Record<string, any>} */
const VIEWS = Object.freeze({
  runs: {
    id: 'runs',
    noun: 'runs',
    shapes: ['list', 'workflow'],
    api: () => '/api/runs',
    load: loadHome,
    dataKey: homeKey,
    tick: tickHome,
    pollMs: 5000,
    wide: false,
    skeleton: skeletonHome,
    head: () => ({ text: 'Runs', mono: false }),
    meta: () => null,
    render: (/** @type {any} */ data, /** @type {any} */ params, /** @type {any} */ local) => renderHome(data, { badge, local }),
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
    head: (/** @type {any} */ params) => ({ text: slugTask(params), mono: true, build: () => buildRunHead(params) }),
    meta: runMeta,
    step: runStep,
    headSkeleton: skeletonRunHead,
    tick: tickRun,
    teardown: releaseRun,
    render: renderRun,
    isEmpty: () => false,
    title: (/** @type {any} */ params) => slugTask(params),
  },
  tasks: {
    id: 'tasks',
    noun: 'tasks',
    // The graph reads the same body as the run view (IC-005): only `tasks` and `tasksReason` draw it, so only they re-mount it.
    shapes: ['status', 'timeline', 'attempts', 'workflow'],
    api: (/** @type {any} */ params) => `/api/runs/${params.slug}/${params.taskId}`,
    dataKey: (/** @type {any} */ data) => JSON.stringify([data && data.tasks, data && data.tasksReason]),
    pollMs: 3000,
    wide: true,
    skeleton: skeletonBlock,
    head: () => ({ text: 'Tasks', mono: false }),
    meta: (/** @type {any} */ params) => h('p', { class: 'view-head__meta mono' }, slugTask(params)),
    render: renderGraph,
    isEmpty: () => false,
    title: (/** @type {any} */ params) => `Tasks · ${slugTask(params)}`,
  },
  sessions: {
    id: 'sessions',
    noun: 'sessions',
    // IC-018 e: the body is built from these six shapes by the server; each section carries its own ok or code.
    shapes: ['observed', 'slots', 'list', 'attempts', 'worker-status', 'roadmap'],
    api: () => '/api/sessions',
    dataKey: sessionsKey,
    pollMs: 10000,
    wide: true,
    skeleton: skeletonSessions,
    head: () => ({ text: 'Sessions', mono: false }),
    meta: () => h('p', { class: 'view-head__meta' }, 'Who is working where, what each holds, and where work collides.'),
    render: renderSessions,
    isEmpty: () => false,
    title: () => 'Sessions',
  },
  workflows: {
    id: 'workflows',
    noun: 'workflows',
    // IC-005: one `workflow` read per registry class, answered as one body. The registry changes with the core, not by the minute.
    shapes: ['workflow'],
    api: () => '/api/workflows',
    pollMs: 30000,
    wide: true,
    skeleton: skeletonBlock,
    head: () => ({ text: 'Workflows', mono: false }),
    meta: () => h('p', { class: 'view-head__meta' }, 'The steps each kind of work goes through, and the gates that stop for you.'),
    render: renderWorkflows,
    isEmpty: (/** @type {any} */ data) => workflowsOf(data).length === 0,
    empty: {
      title: 'No workflows listed',
      sentence: 'The DoFlow core returned no workflow classes, so there is nothing to draw here.',
      note: 'This list refreshes every 30 seconds while this tab is open.',
    },
    title: () => 'Workflows',
  },
  fleet: {
    id: 'fleet',
    noun: 'projects',
    // IC-025: the fleet body is built from these shapes by the server; each project section carries its own ok or code.
    shapes: ['projects', 'tree', 'traffic'],
    api: () => '/api/fleet',
    live: true,
    connect: connectFleet,
    update: (/** @type {any} */ local, /** @type {any} */ data) => updateFleetList(local, data),
    tick: tickFleet,
    teardown: teardownFleet,
    pollMs: 5000,
    wide: true,
    skeleton: skeletonFleetList,
    head: () => ({ text: 'Fleet', mono: false }),
    meta: listMeta,
    render: renderFleetList,
    isEmpty: (/** @type {any} */ data) => data.store === 'absent' || data.projects.length === 0,
    empty: listEmpty,
    title: () => 'Fleet',
  },
  'fleet-project': {
    id: 'fleet-project',
    noun: 'this project',
    shapes: ['projects', 'tree', 'transcript', 'traffic'],
    api: () => '/api/fleet',
    live: true,
    connect: connectFleet,
    update: (/** @type {any} */ local, /** @type {any} */ data, /** @type {any} */ params) => updateProject(local, data, params),
    reroute: rerouteProject,
    tick: tickFleet,
    teardown: teardownFleet,
    pollMs: 5000,
    wide: true,
    skeleton: skeletonFleetProject,
    head: (/** @type {any} */ params) => ({ text: 'Project', mono: true, build: () => buildProjectHead(params) }),
    meta: projectMeta,
    render: renderProject,
    isEmpty: () => false,
    title: projectTitle,
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
  if (path === '/sessions') return { id: 'sessions', params: {}, view: VIEWS.sessions };
  if (path === '/fleet') return { id: 'fleet', params: {}, view: VIEWS.fleet };
  const parts = path.split('/'); // ['', 'run', slug, taskId, 'tasks'?]
  if (parts[1] === 'fleet') {
    // '', 'fleet', project, agent?: the keys of IC-019 and IC-020, nothing else (no path, label or session id is ever in a URL).
    if (parts.length < 3 || parts.length > 4 || !KEY16.test(parts[2]) || (parts.length === 4 && !KEY16.test(parts[3]))) return notFound;
    return { id: 'fleet-project', params: parts.length === 4 ? { project: parts[2], agent: parts[3] } : { project: parts[2] }, view: VIEWS['fleet-project'] };
  }
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
 * Which nav link is current: Runs on `#/` and every `#/run/...`, Workflows on `#/workflows`, Sessions on `#/sessions`, Fleet on
 * every `#/fleet...`, else none.
 * @param {any} route
 */
function navFor(route) {
  if (route.id === 'workflows' || route.id === 'sessions') return route.id;
  if (route.id === 'fleet' || route.id === 'fleet-project') return 'fleet';
  return route.id === 'not-found' ? null : 'runs';
}

export { CORE_RANGE, PARAM_PATTERN, KEY16, VIEWS, SHAPES_USED, parseRoute, titleFor, navFor, badge, awaitingCount };
