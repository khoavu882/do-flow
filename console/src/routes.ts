'use strict';

// The Console route table (IC-005). A route declares its method, so the server answers 405 for every
// method no route declares for a path; the only non-GET route the contract allows is
// `POST /api/session`, the launch-code exchange (092 IC-011), and the only stream route is
// `GET /api/stream` (`stream: true`: its handler writes to `ctx.res` over time and returns null once it
// has taken the response over; before that it may still return an error Reply). `buildRoutes` puts every
// other /api route behind the session check, so a route added to the table cannot skip it. Paths are literal segments, `:name` segments (one non-empty raw segment,
// still percent-encoded: handlers validate it), or the whole-table static fallback `/*`, which never
// matches under /api.

const { readStatic } = require('./static.ts');
const { processSessions, sessionCookie, readCookie, cookieName } = require('./session.ts');
const { project } = require('./project.ts');
const { handshake } = require('./handshake.ts');
const { PARAM_PATTERN, fleetError } = require('./verb-runner.ts');
const { createStreams, parseLastEventId } = require('./stream.ts');

type Reply = { status: number, headers?: Record<string, string>, body?: string | Uint8Array };
type RouteContext = { req: any, res: any, pathname: string, params: Record<string, string>, webRoot: string, port: number, session?: { scope: 'read' } };
type Route = Readonly<{ method: 'GET' | 'POST', path: string, stream?: true, handler: (ctx: RouteContext) => Reply | null | Promise<Reply | null> }>;

const JSON_TYPE = 'application/json; charset=utf-8';
const SESSION_PATH = '/api/session';
// `{"code":"<64 hex>"}` is 75 bytes; anything far past that is not an exchange.
const SESSION_BODY_CAP = 1024;

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function jsonReply(status: number, value: unknown): Reply {
  return { status, headers: { 'Content-Type': JSON_TYPE }, body: JSON.stringify(value) };
}

// IC-005's error body. `verb` is the shape id and `exit` the core's exit code when a verb ran.
function errorReply(status: number, code: string, verb: string | null = null, exit: number | null = null): Reply {
  return jsonReply(status, { error: { code, verb, exit } });
}

// The route's params when `pattern` matches `pathname`, else null.
function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  if (pattern === '/*') return isApiPath(pathname) ? null : {};
  const want = pattern.split('/');
  const have = pathname.split('/');
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < want.length; index += 1) {
    if (want[index].startsWith(':')) {
      if (have[index] === '') return null;
      params[want[index].slice(1)] = have[index];
    } else if (want[index] !== have[index]) {
      return null;
    }
  }
  return params;
}

async function serveStatic(ctx: RouteContext): Promise<Reply> {
  const file = await readStatic(ctx.webRoot, ctx.pathname);
  return file ? { status: 200, headers: { 'Content-Type': file.type }, body: file.body } : errorReply(404, 'not-found');
}

// The body as text, or null past `cap` bytes. An oversized body is still drained, not destroyed, so
// the client gets the 400 rather than a reset.
async function readBody(req: any, cap: number): Promise<string | null> {
  const chunks: any[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= cap) chunks.push(chunk);
  }
  return size <= cap ? Buffer.concat(chunks).toString('utf8') : null;
}

// POST /api/session `{"code":"..."}`: the server has already checked Origin, Sec-Fetch-Site and the
// content type. No reply echoes the body, so a code never comes back in an error.
function sessionRoute(sessions: any): Route {
  return {
    method: 'POST',
    path: SESSION_PATH,
    handler: async (ctx) => {
      const text = await readBody(ctx.req, SESSION_BODY_CAP);
      let body: any;
      try {
        body = text === null ? null : JSON.parse(text);
      } catch {
        body = null;
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.code !== 'string') return errorReply(400, 'usage');
      const token = sessions.exchange(body.code);
      if (token === null) return errorReply(401, 'unauthenticated');
      return { status: 204, headers: { 'Set-Cookie': sessionCookie(ctx.port, token) } };
    },
  };
}

function requireSession(sessions: any, handler: Route['handler']): Route['handler'] {
  return (ctx) => {
    const session = sessions.verify(readCookie(ctx.req.headers.cookie, cookieName(ctx.port)));
    return session ? handler({ ...ctx, session }) : errorReply(401, 'unauthenticated');
  };
}

// The frozen route table over `sessions`: the exchange route plus `table`, with every /api route of
// `table` wrapped in the session check.
function buildRoutes(sessions: any, table: readonly Route[]): readonly Route[] {
  const guarded = table.map((route) => (isApiPath(route.path) ? { ...route, handler: requireSession(sessions, route.handler) } : route));
  return Object.freeze([sessionRoute(sessions), ...guarded].map((route) => Object.freeze({ ...route })));
}

const healthz: Route = { method: 'GET', path: '/healthz', handler: () => jsonReply(200, { status: 'ok' }) };
const staticFallback: Route = { method: 'GET', path: '/*', handler: serveStatic };

// The boundary table with no core behind it (the server's default; server and session tests).
const ROUTES: readonly Route[] = buildRoutes(processSessions, [healthz, staticFallback]);

// ---- IC-005 read routes over the verb runner (A.6) and the projectors (A.7) ----

type Runner = { run(shapeId: string, params?: Record<string, string>): Promise<any> };
type ErrorInfo = { code: string, verb: string | null, exit: number | null };
type Read = { ok: true, body: any, exit: number } | { ok: false, reply: Reply, code: string, exit: number | null, errorId?: string, error: ErrorInfo };

/**
 * The registry's task classes in registry order: a copy of the keys of `classes` in
 * core/registry/workflows.json (this package ships without the core, and no allow-listed verb lists
 * them on success). routes.test.ts checks it against the core's own `listClasses()`.
 */
const TASK_CLASSES: readonly string[] = Object.freeze(['feature', 'bug', 'refactor', 'review', 'research', 'documentation',
  'dependency-change', 'operations', 'trivial-edit']);

/** IC-005's status and code for a runner failure. */
function failureStatus(failure: { code: string }): [number, string] {
  if (failure.code === 'core-unreachable') return [503, 'core-unreachable'];
  if (failure.code === 'usage') return [400, 'usage'];
  return [502, 'core-error'];
}

/**
 * IC-005's status and error body for a runner failure; `exit` is the core's exit code when it ran.
 * The Fleet codes (IC-024) come first: `fleetError` maps them, anything else is `failureStatus`.
 */
function failureInfo(shapeId: string, failure: { code: string, exit: number | null, errorId?: string }): { status: number, error: ErrorInfo } {
  const fleet = fleetError(shapeId, failure);
  if (fleet) return { status: fleet.status, error: { code: fleet.code, verb: shapeId, exit: failure.exit } };
  const [status, code] = failureStatus(failure);
  return { status, error: { code, verb: shapeId, exit: status === 502 ? failure.exit : null } };
}

function failureReply(shapeId: string, failure: { code: string, exit: number | null, errorId?: string }): Reply {
  const { status, error } = failureInfo(shapeId, failure);
  return errorReply(status, error.code, error.verb, error.exit);
}

/** One allow-listed call, projected; a projector refusal is `core-contract-mismatch` (no partial body). */
async function read(runner: Runner, shapeId: string, params: Record<string, string>, context?: unknown): Promise<Read> {
  const result = await runner.run(shapeId, params);
  if (!result.ok) {
    const { error } = failureInfo(shapeId, result);
    return { ok: false, reply: failureReply(shapeId, result), code: error.code, exit: result.exit, errorId: result.errorId, error };
  }
  const projected = project(shapeId, result.json, context);
  return projected.ok
    ? { ok: true, body: projected.body, exit: 0 }
    : { ok: false, reply: errorReply(502, 'core-contract-mismatch', shapeId, 0), code: 'core-contract-mismatch', exit: 0, error: { code: 'core-contract-mismatch', verb: shapeId, exit: 0 } };
}

async function info(runner: Runner): Promise<Reply> {
  const [checked, capabilities] = await Promise.all([handshake(runner), read(runner, 'capabilities', {})]);
  if (!checked.ok) return checked.code === 'core-contract-mismatch' ? errorReply(502, checked.code, 'version', 0) : failureReply('version', checked);
  if (!capabilities.ok) return capabilities.reply;
  return jsonReply(200, { v: 1, core: { version: checked.version, inRange: checked.inRange }, capabilities: capabilities.body.capabilities });
}

/** A failed `list`: the core's own id for a checkout enumeration failure (workflow-orchestrator.ts listRuns), else its IC-005 error. */
const listFailure = (list: Read & { ok: false }): Reply =>
  list.errorId === 'cannot-list-checkouts' ? errorReply(502, 'cannot-list-checkouts', 'list', list.exit) : list.reply;

async function runs(runner: Runner): Promise<Reply> {
  const list = await read(runner, 'list', {});
  return list.ok ? jsonReply(200, list.body) : listFailure(list);
}

/**
 * `tasks: null, tasksReason: 'no-plan'` only when inspect fails with the core's `plan-unreadable` id
 * (task-attempts.ts loadPlan); `legacy-plan` when inspect succeeds on a plan without the task-graph
 * header (`graph.graphPlan` false). Every other failure, `plan-malformed` and `store-unreadable`
 * included, is IC-005's error. Ceiling: the core uses `plan-unreadable` both for a missing plan.md and
 * for one it cannot read, so an unreadable plan file also shows as no-plan.
 */
async function tasks(runner: Runner, slug: string): Promise<{ ok: true, tasks: any, reason: string | null } | { ok: false, reply: Reply }> {
  const result = await runner.run('attempts', { slug });
  if (!result.ok) return result.exit === 2 && result.errorId === 'plan-unreadable' ? { ok: true, tasks: null, reason: 'no-plan' } : { ok: false, reply: failureReply('attempts', result) };
  const raw = result.json;
  if (raw && typeof raw === 'object' && raw.graph && typeof raw.graph === 'object' && raw.graph.graphPlan === false) {
    return { ok: true, tasks: null, reason: 'legacy-plan' };
  }
  const projected = project('attempts', raw);
  return projected.ok ? { ok: true, tasks: projected.body, reason: null } : { ok: false, reply: errorReply(502, 'core-contract-mismatch', 'attempts', 0) };
}

async function runDetail(runner: Runner, slug: string, taskId: string): Promise<Reply> {
  if (!PARAM_PATTERN.test(slug) || !PARAM_PATTERN.test(taskId)) return errorReply(400, 'usage');
  const statusCall = runner.run('status', { taskId, slug });
  const timelineCall = read(runner, 'timeline', { taskId, slug });
  const tasksCall = tasks(runner, slug);
  const listCall = read(runner, 'list', {});
  const status = await statusCall;
  // `status` and `timeline` exit 1 when no such run exists (092 N7: a listed row status cannot open).
  if (!status.ok) return status.exit === 1 ? errorReply(404, 'run-not-found', 'status', 1) : failureReply('status', status);
  // The class picks the registry workflow the status projector compares the journal's gate copy with.
  const taskClass = status.json && typeof status.json === 'object' ? status.json.taskClass : undefined;
  if (typeof taskClass !== 'string' || !PARAM_PATTERN.test(taskClass)) return errorReply(502, 'core-contract-mismatch', 'status', 0);
  const workflow = await read(runner, 'workflow', { taskClass });
  if (!workflow.ok) return workflow.reply;
  const run = project('status', status.json, { workflow: workflow.body });
  if (!run.ok) return errorReply(502, 'core-contract-mismatch', 'status', 0);
  const timeline = await timelineCall;
  // E.2 Q4: only a run that is not there stops the route; any other timeline failure degrades to `timeline: null` with its code.
  if (!timeline.ok && timeline.exit === 1) return errorReply(404, 'run-not-found', 'timeline', 1);
  const graph = await tasksCall;
  if (!graph.ok) return graph.reply;
  // `status` carries no slug, times or origin; the list row of the same id and slug does (null when none matches).
  const list = await listCall;
  if (!list.ok) return listFailure(list);
  const row = list.body.runs.find((entry: any) => entry.taskId === taskId && entry.featureSlug === slug);
  const head = { featureSlug: row ? row.featureSlug : null, startedAt: row ? row.startedAt : null, updatedAt: row ? row.updatedAt : null, origin: row ? row.origin : null };
  const body: Record<string, unknown> = { v: 1, run: { ...run.body, ...head }, timeline: timeline.ok ? timeline.body : null, tasks: graph.tasks, workflow: workflow.body };
  if (graph.tasks === null) body.tasksReason = graph.reason;
  if (!timeline.ok) body.timelineReason = timeline.code;
  return jsonReply(200, body);
}

// ---- IC-018 e: GET /api/sessions ----

/** IC-018 e's bounds: inspects per request and worker-status calls per request. */
const SESSION_LIMITS = Object.freeze({ inspects: 20, workers: 16 });
/** The run states whose feature's attempts are inspected. */
const LIVE_RUN_STATES: readonly string[] = Object.freeze(['RUNNING', 'AWAITING_GATE']);

type Section = { ok: true, data: any } | { ok: false, code: string };
const failedSection = (code: string): Section => ({ ok: false, code });

/** A failed read as its section: the code of its IC-005 error, `cannot-list-checkouts` (observed, list) included. */
const sectionOf = (result: Read): Section => {
  if (result.ok) return { ok: true, data: result.body };
  return failedSection(result.errorId === 'cannot-list-checkouts' && result.code === 'core-error' ? 'cannot-list-checkouts' : result.code);
};

/**
 * `tasks`: one inspect per feature of a RUNNING or AWAITING_GATE run, at most SESSION_LIMITS.inspects;
 * a run counts as inspected when its feature was. A feature with no plan (`plan-unreadable`, as
 * runDetail reads it) holds nothing and has no entry. A feature whose plan the core calls
 * `plan-malformed` has no entry either, and its runs count as not checked. Any other failed inspect
 * fails the section: IC-018 e keeps each section whole or absent.
 */
async function sessionTasks(runner: Runner, runs: any[]) {
  const live = runs.filter((row) => LIVE_RUN_STATES.includes(row.state) && row.featureSlug !== null);
  const slugs: string[] = [];
  let runsInspected = 0;
  for (const row of live) {
    if (!slugs.includes(row.featureSlug) && slugs.length < SESSION_LIMITS.inspects) slugs.push(row.featureSlug);
    if (slugs.includes(row.featureSlug)) runsInspected += 1;
  }
  const counts = { runsInspected, runsNotChecked: live.length - runsInspected };
  const results = await Promise.all(slugs.map((slug) => runner.run('attempts', { slug })));
  const entries: any[] = [];
  for (const [index, result] of results.entries()) {
    if (!result.ok) {
      if (result.exit === 2 && result.errorId === 'plan-unreadable') continue;
      if (result.exit === 2 && result.errorId === 'plan-malformed') {
        const skipped = live.filter((row) => row.featureSlug === slugs[index]).length;
        counts.runsInspected -= skipped;
        counts.runsNotChecked += skipped;
        continue;
      }
      return { section: failedSection(failureStatus(result)[1]), counts };
    }
    const projected = project('attempts', result.json);
    if (!projected.ok) return { section: failedSection('core-contract-mismatch'), counts };
    const { revision, graph, tasks: rows } = projected.body;
    const active = rows.flatMap((task: any) => task.attempts.filter((a: any) => a.state === 'active').map((a: any) => ({ task: task.id, ...a })));
    entries.push({ slug: slugs[index], revision, overlaps: graph.overlaps, active });
  }
  return { section: { ok: true, data: entries } as Section, counts };
}

/** `workers`: one worker-status per active attempt, in `tasks` order, at most SESSION_LIMITS.workers. A failed call fails the section. */
async function sessionWorkers(runner: Runner, tasks: any[]) {
  const active = tasks.flatMap((entry: any) => entry.active.map((a: any) => ({ slug: entry.slug, task: a.task, token: a.token })));
  const checked = active.slice(0, SESSION_LIMITS.workers);
  const counts = { workersChecked: checked.length, workersNotChecked: active.length - checked.length };
  const reads = await Promise.all(checked.map((a) => read(runner, 'worker-status', { slug: a.slug, task: a.task, token: String(a.token) })));
  const failed = reads.find((entry) => !entry.ok);
  if (failed) return { section: sectionOf(failed), counts };
  return { section: { ok: true, data: checked.map((a, index) => ({ ...a, worker: (reads[index] as any).body })) } as Section, counts };
}

/**
 * IC-018 e: every Sessions section from its own reads. A failed shape fails its section only (and the
 * sections built from it: `tasks` and `workers` need `runs`, `workers` needs `tasks`). A project with
 * no roadmap is `roadmap: null`. Ceiling: the core answers `usage` (exit 2) both for a missing seed
 * and for an invalid one, so an invalid seed also reads as no roadmap.
 */
async function sessionsView(runner: Runner): Promise<Reply> {
  const [observed, slots, list, roadmap] = await Promise.all([
    read(runner, 'observed', {}), read(runner, 'slots', {}), read(runner, 'list', {}), read(runner, 'roadmap', {}),
  ]);
  const runsSection = sectionOf(list);
  const limits = { runsInspected: 0, runsNotChecked: 0, workersChecked: 0, workersNotChecked: 0 };
  let tasksSection = runsSection;
  let workersSection = runsSection;
  if (runsSection.ok) {
    const tasks = await sessionTasks(runner, runsSection.data.runs);
    Object.assign(limits, tasks.counts);
    tasksSection = workersSection = tasks.section;
    if (tasks.section.ok) {
      const workers = await sessionWorkers(runner, tasks.section.data);
      Object.assign(limits, workers.counts);
      workersSection = workers.section;
    }
  }
  const noRoadmap = !roadmap.ok && roadmap.code === 'core-error' && roadmap.exit === 2 && roadmap.errorId === 'usage';
  return jsonReply(200, {
    v: 1,
    sections: {
      observed: sectionOf(observed),
      slots: sectionOf(slots),
      runs: runsSection,
      tasks: tasksSection,
      workers: workersSection,
      roadmap: noRoadmap ? { ok: true, data: null } : sectionOf(roadmap),
    },
    limits,
  });
}

async function workflows(runner: Runner): Promise<Reply> {
  const reads = await Promise.all(TASK_CLASSES.map((taskClass) => read(runner, 'workflow', { taskClass })));
  const failed = reads.find((entry) => !entry.ok);
  if (failed && !failed.ok) return failed.reply;
  return jsonReply(200, { v: 1, workflows: reads.map((entry) => (entry as any).body) });
}

// ---- IC-025: GET /api/fleet, GET /api/transcript, GET /api/stream ----

/** IC-025: projects shown per Fleet read; the rest are counted. The traffic window (10 min) is a literal of the `traffic` shape. */
const FLEET_PROJECT_LIMIT = 12;
/** One transcript page per read: the core's own default (IC-022). */
const TRANSCRIPT_PAGE = '200';
// The verb runner checks these again (IC-024); routes check them first so a bad parameter is a 400 before any verb runs.
const KEY16 = /^[0-9a-f]{16}$/;
const CURSOR = /^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/;

/**
 * IC-025: `projects`, then `tree` and `traffic` for at most FLEET_PROJECT_LIMIT of them. A failed
 * `projects` fails the read (`cannot-list-projects`); a failed `tree` or `traffic` fails its own section.
 */
async function fleetRead(runner: Runner): Promise<Read> {
  const list = await read(runner, 'projects', {});
  if (!list.ok) return list;
  const shown: any[] = list.body.projects.slice(0, FLEET_PROJECT_LIMIT);
  const projects = await Promise.all(shown.map(async (entry) => {
    const [tree, traffic] = await Promise.all([
      read(runner, 'tree', { projectKey: entry.projectKey }),
      read(runner, 'traffic', { projectKey: entry.projectKey }),
    ]);
    return { projectKey: entry.projectKey, label: entry.label, current: entry.current, checkouts: entry.checkouts, lastRecordAt: entry.lastRecordAt, tree: sectionOf(tree), traffic: sectionOf(traffic) };
  }));
  return {
    ok: true,
    exit: 0,
    body: {
      v: 1,
      store: list.body.store,
      projects,
      excluded: list.body.excluded,
      limits: { projectsShown: shown.length, projectsNotShown: list.body.projects.length - shown.length, truncated: list.body.truncated },
    },
  };
}

function transcriptRead(runner: Runner, project: string, agent: string, cursor: string | null): Promise<Read> {
  return read(runner, 'transcript', { projectKey: project, agent, limit: TRANSCRIPT_PAGE, ...(cursor === null ? {} : { cursor }) });
}

/** The query parameters of `req`, or null when one is unknown or given twice. */
function queryOf(req: any, names: readonly string[]): Map<string, string> | null {
  const url: string = typeof req.url === 'string' ? req.url : '';
  const mark = url.indexOf('?');
  const found = new Map<string, string>();
  let ok = true;
  new URLSearchParams(mark < 0 ? '' : url.slice(mark + 1)).forEach((value, name) => {
    if (!names.includes(name) || found.has(name)) ok = false;
    found.set(name, value);
  });
  return ok ? found : null;
}

const fleetRoute = (runner: Runner): Route['handler'] => async () => {
  const fleet = await fleetRead(runner);
  return fleet.ok ? jsonReply(200, fleet.body) : fleet.reply;
};

const transcriptRoute = (runner: Runner): Route['handler'] => async (ctx) => {
  const query = queryOf(ctx.req, ['project', 'agent', 'cursor']);
  const project = query?.get('project');
  const agent = query?.get('agent');
  const cursor = query?.get('cursor') ?? null;
  if (!query || project === undefined || agent === undefined || !KEY16.test(project) || !KEY16.test(agent) || (cursor !== null && !CURSOR.test(cursor))) return errorReply(400, 'usage');
  const page = await transcriptRead(runner, project, agent, cursor);
  return page.ok ? jsonReply(200, page.body) : page.reply;
};

/**
 * The stream route kind: validated here, then handed to stream.ts, which owns the response from
 * `retry:` on. At most two streams per session; a third is `429 stream-limit` as a JSON body before
 * any stream header.
 */
const streamRoute = (runner: Runner): Route['handler'] => {
  const streams = createStreams({ fleet: fleetRead.bind(null, runner), transcript: (project: string, agent: string, cursor: string | null) => transcriptRead(runner, project, agent, cursor) });
  return (ctx) => {
    const query = queryOf(ctx.req, ['project', 'agent']);
    const project = query?.get('project');
    const agent = query?.get('agent') ?? null;
    if (!query || project === undefined || !KEY16.test(project) || (agent !== null && !KEY16.test(agent))) return errorReply(400, 'usage');
    const release = streams.acquire(ctx.session as object);
    if (release === null) return errorReply(429, 'stream-limit');
    const resume = parseLastEventId(ctx.req.headers['last-event-id']);
    streams.serve(ctx.req, ctx.res, { project, agent, revision: resume.revision, cursor: agent === null ? null : resume.cursor, release });
    return null;
  };
};

/**
 * The Console's table (IC-005) over `runner`: every /api route but the exchange is behind the session
 * check (buildRoutes), every one is GET, and each answers `{v:1, ...}` or IC-005's error body.
 */
function consoleRoutes(runner: Runner, sessions: any = processSessions): readonly Route[] {
  return buildRoutes(sessions, [
    healthz,
    { method: 'GET', path: '/api/info', handler: () => info(runner) },
    { method: 'GET', path: '/api/runs', handler: () => runs(runner) },
    { method: 'GET', path: '/api/runs/:slug/:taskId', handler: (ctx) => runDetail(runner, ctx.params.slug, ctx.params.taskId) },
    { method: 'GET', path: '/api/workflows', handler: () => workflows(runner) },
    { method: 'GET', path: '/api/sessions', handler: () => sessionsView(runner) },
    { method: 'GET', path: '/api/fleet', handler: fleetRoute(runner) },
    { method: 'GET', path: '/api/transcript', handler: transcriptRoute(runner) },
    { method: 'GET', path: '/api/stream', stream: true, handler: streamRoute(runner) },
    staticFallback,
  ]);
}

module.exports = { ROUTES, SESSION_LIMITS, TASK_CLASSES, buildRoutes, consoleRoutes, isApiPath, matchPath, jsonReply, errorReply, JSON_TYPE };
