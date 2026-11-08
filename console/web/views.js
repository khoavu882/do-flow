// The views table of the shell (D.2 note sections 2, 6.1, 6.2, 8 and 10): per route its title, view noun,
// the shape ids it reads (IC-003; client-core.test.ts checks them against the allow-list), poll interval,
// skeleton, head and loaded renderer. Nothing here runs at import time.

import { h, icon } from './dom.js';
import { skel, reltime } from './states.js';
import { loadHome, homeOf, renderHome, skeletonHome, homeKey, tickHome } from './views/home.js';
import { connectLive } from './live-view.js';
import { renderRun, tickRun, releaseRun, rerouteRun } from './views/run.js';
import { renderGraph, rerouteGraph } from './views/graph.js';
import { renderSessions, rerouteSessions } from './views/sessions.js';
import { renderWorkflows } from './views/workflows.js';
// session.js reaches back here through worker-tabs.js (CORE_RANGE), so when it is imported first this module's body runs
// before session.js's: at this module's evaluation only session.js's function declarations are read, and its `const`
// exports (`sessionApi`, `skeletonSession`) only inside calls. client-core.test.ts imports session.js first in a fresh graph.
import {
  sessionApi, loadSession, connectSession, skeletonSession, renderSession, rerouteSession, tickSession, teardownSession,
} from './views/session.js';
import { deriveSessions } from './derive/sessions.js';
import { runStepCopy, runToken } from './derive/rail.js';
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

/** IC-015's run id of a worker node (RUN_ID, src/runtime/worker/run-store.ts:27). */
const RUN_ID = /^w-[0-9a-f]{12}$/;

/** IC-015's worker tabs, in the order the tab list shows them. */
const SESSION_TABS = Object.freeze(['log', 'transcript', 'result', 'process']);

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

/**
 * Whether a run is live (feature 133, FR-1): RUNNING, or waiting at a gate, and not stale. A run at a gate stays live because the
 * person decides it outside the Console and the view must notice quickly. Finished and stale runs are idle.
 * @param {any} run @param {number} nowMs
 */
const runIsRunning = (run, nowMs) => {
  const token = runToken(run, nowMs);
  return token === 'RUNNING' || token === 'AWAITING_GATE';
};

/** The tasks of the plan graph in a run body: the size that scales the refresh interval. @param {any} data */
const graphSize = (data) => (data && data.graph && Array.isArray(data.graph.tasks) ? data.graph.tasks.length : 0);

const awaitingCount = (/** @type {any} */ data) => data.runs.filter((/** @type {any} */ run) => run.state === 'AWAITING_GATE').length;

/**
 * The run head (CD-B8): crumb to Runs, the title with a muted task id, the meta line, and the step counter with, beside it in
 * the same grid area, the link to the run's Session screen (150 IC-020). @param {any} params
 */
function buildRunHead(params) {
  const crumb = h('nav', { class: 'run-head__crumb', 'aria-label': 'Breadcrumb' }, [
    h('a', { href: '#/' }, 'Runs'), h('span', { 'aria-hidden': 'true' }, ' / '), h('span', { class: 'mono' }, params.slug),
  ]);
  const h1 = h('h1', { class: 'run-head__title', tabindex: '-1' }, [h('span', {}, params.slug), h('span', { class: 'run-head__task' }, ` / ${params.taskId}`)]);
  const meta = h('div', { class: 'run-head__metawrap' });
  const step = h('p', { class: 'run-head__step', hidden: true });
  const chainHref = hashFor({ id: 'session', params: { slug: params.slug, taskId: params.taskId } });
  const chain = chainHref === null ? null : h('a', { class: 'graph__back', href: chainHref }, 'Chain');
  const aside = h('div', { class: 'run-head__aside' }, [step, chain]);
  return { root: h('header', { class: 'view-head run-head' }, [crumb, h1, meta, aside]), h1, meta, step };
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

/** The live channel of a run and its task graph (IC-003, IC-018). @param {any} params */
const runChannel = (params) => `run:${params.slug}:${params.taskId}`;

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
 * `title(params, data)`. Optional: `active(data, nowMs)` false when nothing is running (the poll interval is x10; a view without it
 * is always active) and `size(data)` the graph size in nodes (the poll interval is at least size/1000 s); `load(local, apiGet)` reads more than `api` names; `dataKey(data)` decides when
 * the body is re-mounted; `tick(root, nowMs, local)` runs on the shell's 1 s timer. A `live: true` view (V.10, the Fleet
 * views) is mounted once and then patched: `connect(local, params, hooks)` returns a poller-shaped object over a stream,
 * `update(local, data, params)` patches the mounted body, `reroute(local, params, data)` moves between routes of one view
 * without a re-mount (the selected agent changed), and `empty` may be a function of the data. The Runs, Run, Tasks and Sessions
 * views have `connect` too (IC-018, live-view.js: the live store, or their GET polled at their interval) but not `live: true`:
 * their body is re-mounted by `dataKey` as when polled. The Run, Tasks, Sessions and Session views have `reroute` too (IC-019,
 * 150 IC-015): it applies the selection of `local.route` to the mounted body, and their render reads it from there.
 */
/** @type {Record<string, any>} */
const VIEWS = Object.freeze({
  runs: {
    id: 'runs',
    inspectable: false,
    noun: 'runs',
    shapes: ['list', 'workflow'],
    api: () => '/api/runs',
    load: loadHome,
    // IC-018: the `runs` member of `now`, wrapped as loadHome wraps `/api/runs`; polled every 5 s without the stream.
    connect: connectLive({ channel: () => 'now', member: 'runs', intervalMs: 5000, wrap: homeOf }),
    dataKey: homeKey,
    tick: tickHome,
    active: (/** @type {any} */ data, /** @type {number} */ nowMs) => data.runs.some((/** @type {any} */ run) => runIsRunning(run, nowMs)),
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
    inspectable: true,
    noun: 'this run',
    shapes: ['status', 'timeline', 'attempts', 'workflow'],
    api: (/** @type {any} */ params) => `/api/runs/${params.slug}/${params.taskId}`,
    connect: connectLive({ channel: runChannel, member: 'run', intervalMs: 3000 }),
    active: (/** @type {any} */ data, /** @type {number} */ nowMs) => Boolean(data && data.run) && runIsRunning(data.run, nowMs),
    size: graphSize,
    pollMs: 3000,
    wide: false,
    skeleton: skeletonRun,
    head: (/** @type {any} */ params) => ({ text: slugTask(params), mono: true, build: () => buildRunHead(params) }),
    meta: runMeta,
    step: runStep,
    headSkeleton: skeletonRunHead,
    tick: tickRun,
    teardown: releaseRun,
    reroute: rerouteRun,
    render: renderRun,
    isEmpty: () => false,
    title: (/** @type {any} */ params) => slugTask(params),
  },
  tasks: {
    id: 'tasks',
    inspectable: true,
    noun: 'tasks',
    // The graph reads the same body as the run view (IC-005): only `tasks` and `tasksReason` draw it, so only they re-mount it.
    shapes: ['status', 'timeline', 'attempts', 'workflow'],
    api: (/** @type {any} */ params) => `/api/runs/${params.slug}/${params.taskId}`,
    connect: connectLive({ channel: runChannel, member: 'run', intervalMs: 3000 }),
    dataKey: (/** @type {any} */ data) => JSON.stringify([data && data.tasks, data && data.tasksReason]),
    active: (/** @type {any} */ data, /** @type {number} */ nowMs) => Boolean(data && data.run) && runIsRunning(data.run, nowMs),
    size: graphSize,
    pollMs: 3000,
    wide: true,
    skeleton: skeletonBlock,
    head: () => ({ text: 'Tasks', mono: false }),
    meta: (/** @type {any} */ params) => h('p', { class: 'view-head__meta mono' }, slugTask(params)),
    reroute: rerouteGraph,
    render: renderGraph,
    isEmpty: () => false,
    title: (/** @type {any} */ params) => `Tasks · ${slugTask(params)}`,
  },
  session: {
    id: 'session',
    inspectable: true,
    noun: 'this run',
    // IC-017: SESSION_SHAPES of views/session.js, written out because that const cannot be read while this table is built
    // (the import cycle above); client-core.test.ts asserts the two lists are equal.
    shapes: ['status', 'timeline', 'attempts', 'workflow', 'worker-runs', 'worker-status', 'worker-run-status', 'worker-result', 'worker-log', 'projects', 'transcript'],
    api: (/** @type {any} */ params) => sessionApi(params),
    // The run and `/api/worker-runs/<slug>` side by side, as `{ run, workers, workersError }`; polled at SESSION_POLL_MS (3000).
    load: loadSession,
    connect: connectSession,
    pollMs: 3000,
    wide: false,
    skeleton: () => skeletonSession(),
    head: () => ({ text: 'Chain', mono: false }),
    meta: (/** @type {any} */ params) => h('p', { class: 'view-head__meta mono' }, slugTask(params)),
    tick: tickSession,
    teardown: teardownSession,
    reroute: rerouteSession,
    render: renderSession,
    isEmpty: () => false,
    title: (/** @type {any} */ params) => `Chain · ${slugTask(params)}`,
  },
  sessions: {
    id: 'sessions',
    inspectable: true,
    noun: 'sessions',
    // IC-018 e: the body is built from these six shapes by the server; each section carries its own ok or code.
    shapes: ['observed', 'slots', 'list', 'attempts', 'worker-status', 'roadmap'],
    api: () => '/api/sessions',
    connect: connectLive({ channel: () => 'now', member: 'sessions', intervalMs: 10000 }),
    dataKey: sessionsKey,
    pollMs: 10000,
    wide: true,
    skeleton: skeletonSessions,
    head: () => ({ text: 'Sessions', mono: false }),
    meta: () => h('p', { class: 'view-head__meta' }, 'Who is working where, what each holds, and where work collides.'),
    reroute: rerouteSessions,
    render: renderSessions,
    isEmpty: () => false,
    title: () => 'Sessions',
  },
  workflows: {
    id: 'workflows',
    inspectable: false,
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
    inspectable: false,
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
    inspectable: true,
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
    inspectable: false,
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

/** IC-019's worker token: a positive integer without a leading zero. */
const TOKEN = /^[1-9][0-9]*$/;

/**
 * A Sessions lane in the hash (IC-019) to its key in the form derive/sessions.js builds, or null when a part fails its
 * pattern. `parts` are the segments after `sessions`.
 * @param {string[]} parts
 */
function laneOfParts(parts) {
  const [kind, ...rest] = parts;
  if ((kind === 'hook' || kind === 'launched') && rest.length === 1 && KEY16.test(rest[0])) return `${kind}:${rest[0]}`;
  if (kind === 'lock' && rest.length === 1 && PARAM_PATTERN.test(rest[0])) return `lock:${rest[0]}`;
  if (kind === 'worker' && rest.length === 3 && PARAM_PATTERN.test(rest[0]) && PARAM_PATTERN.test(rest[1]) && TOKEN.test(rest[2])) return `worker:${rest.join('/')}`;
  if (kind === 'run' && rest.length === 3 && KEY16.test(rest[0]) && PARAM_PATTERN.test(rest[1]) && PARAM_PATTERN.test(rest[2])) return `run:${rest.join('/')}`;
  return null;
}

/**
 * The hash segments of a lane key, or null when the key cannot be linked: a part is absent (`-`, DEC-034) or fails its
 * pattern. The inverse of `laneOfParts`.
 * @param {any} key
 */
function laneSegments(key) {
  const text = String(key ?? '');
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const parts = [text.slice(0, colon), ...text.slice(colon + 1).split('/')];
  return laneOfParts(parts) === text ? parts.join('/') : null;
}

/**
 * The selection of a Session route (IC-015) from the segments after `session/<slug>/<taskId>`: `{}` for none, `{ node }` or
 * `{ node, tab }`, or null when a segment fails its pattern. `tab` comes only with a worker node.
 * @param {string[]} parts
 */
function sessionSelection(parts) {
  if (parts.length === 0) return {};
  const [kind, ...rest] = parts;
  if (kind === 'main') return rest.length === 0 ? { node: { kind: 'main' } } : null;
  if (kind === 'stage' || kind === 'gate' || kind === 'task') return rest.length === 1 && PARAM_PATTERN.test(rest[0]) ? { node: { kind, id: rest[0] } } : null;
  if (kind === 'attempt') {
    if (rest.length !== 2 || !PARAM_PATTERN.test(rest[0]) || !TOKEN.test(rest[1])) return null;
    const token = Number(rest[1]);
    // A token past 2^53 has no number that writes it back: no route names it.
    return Number.isSafeInteger(token) ? { node: { kind: 'attempt', task: rest[0], token } } : null;
  }
  if (kind === 'worker' && (rest.length === 1 || rest.length === 2) && RUN_ID.test(rest[0])) {
    const node = { kind: 'worker', runId: rest[0] };
    if (rest.length === 1) return { node };
    return SESSION_TABS.includes(rest[1]) ? { node, tab: rest[1] } : null;
  }
  return null;
}

/**
 * The hash segments of a Session route's selection, the inverse of `sessionSelection`: '' for none, null when the node or tab
 * fails its pattern or a tab comes without a worker node.
 * @param {any} route
 */
function sessionSegments(route) {
  const { node, tab } = route;
  if (node === undefined) return tab === undefined ? '' : null;
  if (node === null || typeof node !== 'object') return null;
  if (tab !== undefined && (node.kind !== 'worker' || !SESSION_TABS.includes(tab))) return null;
  switch (node.kind) {
    case 'main': return '/main';
    case 'stage': case 'gate': case 'task': return typeof node.id === 'string' && PARAM_PATTERN.test(node.id) ? `/${node.kind}/${node.id}` : null;
    case 'attempt':
      return typeof node.task === 'string' && PARAM_PATTERN.test(node.task) && Number.isSafeInteger(node.token) && TOKEN.test(String(node.token))
        ? `/attempt/${node.task}/${node.token}` : null;
    case 'worker':
      return typeof node.runId === 'string' && RUN_ID.test(node.runId) ? `/worker/${node.runId}${tab === undefined ? '' : `/${tab}`}` : null;
    default: return null;
  }
}

/**
 * A location hash to `{ id, params, view }`, and the selection it names (IC-019, 150 IC-015): `sel: { type, id }` on `run`,
 * `task` on `tasks`, `lane` on `sessions`, `node` and `tab` on `session` (Fleet's agent stays in `params`). An unknown route,
 * or a segment failing its pattern, is `not-found`: no fetch is made for it.
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
  const parts = path.split('/'); // ['', 'run', slug, taskId, ...selection]
  if (parts[1] === 'fleet') {
    // '', 'fleet', project, agent?: the keys of IC-019 and IC-020, nothing else (no path, label or session id is ever in a URL).
    if (parts.length < 3 || parts.length > 4 || !KEY16.test(parts[2]) || (parts.length === 4 && !KEY16.test(parts[3]))) return notFound;
    return { id: 'fleet-project', params: parts.length === 4 ? { project: parts[2], agent: parts[3] } : { project: parts[2] }, view: VIEWS['fleet-project'] };
  }
  if (parts[1] === 'sessions') {
    const lane = laneOfParts(parts.slice(2));
    return lane === null ? notFound : { id: 'sessions', params: {}, view: VIEWS.sessions, lane };
  }
  if (parts[1] === 'session') {
    // '', 'session', slug, taskId, ...node (IC-015).
    if (parts.length < 4 || !PARAM_PATTERN.test(parts[2]) || !PARAM_PATTERN.test(parts[3])) return notFound;
    const selection = sessionSelection(parts.slice(4));
    return selection === null ? notFound : { id: 'session', params: { slug: parts[2], taskId: parts[3] }, view: VIEWS.session, ...selection };
  }
  if (parts[1] !== 'run' || parts.length < 4 || parts.length > 6) return notFound;
  const [slug, taskId] = [parts[2], parts[3]];
  if (!PARAM_PATTERN.test(slug) || !PARAM_PATTERN.test(taskId)) return notFound;
  const params = { slug, taskId };
  if (parts.length === 4) return { id: 'run', params, view: VIEWS.run };
  if (parts[4] === 'tasks') {
    if (parts.length === 5) return { id: 'tasks', params, view: VIEWS.tasks };
    return PARAM_PATTERN.test(parts[5]) ? { id: 'tasks', params, view: VIEWS.tasks, task: parts[5] } : notFound;
  }
  if ((parts[4] === 'stage' || parts[4] === 'gate') && parts.length === 6 && PARAM_PATTERN.test(parts[5])) {
    return { id: 'run', params, view: VIEWS.run, sel: { type: parts[4], id: parts[5] } };
  }
  return notFound;
}

/**
 * The hash of a route, the inverse of `parseRoute` (IC-019): `parseRoute(hashFor(route))` equals `route` for every route it
 * gives a hash for. Null for `not-found`, for a part failing its pattern, and for a lane that cannot be linked (DEC-034).
 * @param {any} route
 */
function hashFor(route) {
  const params = (route && route.params) || {};
  const id = route ? route.id : null;
  if (id === 'runs') return '#/';
  if (id === 'workflows') return '#/workflows';
  if (id === 'fleet') return '#/fleet';
  if (id === 'fleet-project') {
    if (!KEY16.test(params.project) || (params.agent !== undefined && !KEY16.test(params.agent))) return null;
    return `#/fleet/${params.project}${params.agent === undefined ? '' : `/${params.agent}`}`;
  }
  if (id === 'sessions') {
    if (route.lane === undefined) return '#/sessions';
    const lane = laneSegments(route.lane);
    return lane === null ? null : `#/sessions/${lane}`;
  }
  if (id !== 'run' && id !== 'tasks' && id !== 'session') return null;
  if (!PARAM_PATTERN.test(params.slug) || !PARAM_PATTERN.test(params.taskId)) return null;
  if (id === 'session') {
    const selection = sessionSegments(route);
    return selection === null ? null : `#/session/${params.slug}/${params.taskId}${selection}`;
  }
  const base = `#/run/${params.slug}/${params.taskId}`;
  if (id === 'tasks') {
    if (route.task === undefined) return `${base}/tasks`;
    return PARAM_PATTERN.test(route.task) ? `${base}/tasks/${route.task}` : null;
  }
  if (route.sel === undefined) return base;
  const { type, id: selId } = route.sel;
  return (type === 'stage' || type === 'gate') && PARAM_PATTERN.test(selId) ? `${base}/${type}/${selId}` : null;
}

/**
 * The route without its selection (IC-019, 150 IC-015): the base a selection hash change stays inside. Fleet's base keeps the
 * project.
 * @param {any} route
 */
function baseRoute(route) {
  const { sel, task, lane, node, tab, ...rest } = route;
  if (route.id !== 'fleet-project') return rest;
  return { ...rest, params: { project: route.params.project } };
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
 * Which rail link is current (IC-020, DEC-035; 150 IC-015): Now on `#/`, every `#/run/...` and every `#/session/...` (the
 * id stays `runs`; the Runs heading and title keep Runs), Workflows on `#/workflows`, Sessions on `#/sessions`, Fleet on
 * every `#/fleet...`, else none.
 * @param {any} route
 */
function navFor(route) {
  if (route.id === 'workflows' || route.id === 'sessions') return route.id;
  if (route.id === 'fleet' || route.id === 'fleet-project') return 'fleet';
  return route.id === 'not-found' ? null : 'runs';
}

export { CORE_RANGE, PARAM_PATTERN, KEY16, VIEWS, SHAPES_USED, parseRoute, hashFor, baseRoute, titleFor, navFor, badge, awaitingCount };
