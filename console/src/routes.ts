'use strict';

// The Console route table (IC-005). A route declares its method, so the server answers 405 for every
// method no route declares for a path; the non-GET routes the contract allows are
// `POST /api/session`, the launch-code exchange (092 IC-011), in loopback mode and `POST /api/pair`
// (device-auth.ts, 160 IC-006) in LAN mode, and in both modes the action routes `POST /api/actions/<id>`
// (actions.ts, 162 IC-002; `action: true`: the wrappers log their refusals through the route's own `refused`
// and `unauthenticated`; 165 adds `start-session`, and the start form's two reads `GET /api/start` and `GET /api/start/options`,
// which scopes.ts gives to `control` only), and the one stream route is
// `GET /api/live` (`stream: true`: the handler writes to `ctx.res` over time and
// returns null once it has taken the response over; before that it may still return an error Reply). `buildRoutes` puts every
// other /api route behind the session check (loopback) or the paired-device check and the scope list of
// scopes.ts (LAN), so a route added to the table cannot skip it. Paths are literal segments, `:name` segments (one non-empty raw segment,
// still percent-encoded: handlers validate it), or the whole-table static fallback `/*`, which never
// matches under /api.

const crypto = require('node:crypto');
const os = require('node:os');
const { readStatic } = require('./static.ts');
const { processSessions, sessionCookie, readCookie, cookieName } = require('./session.ts');
const { deviceMayUse } = require('./scopes.ts');
const { project } = require('./project.ts');
const { maskLite } = require('./mask-lite.ts');
const manifest = require('../package.json');
const { anchorsOf } = require('./place.ts');
const { handshake } = require('./handshake.ts');
const { PARAM_PATTERN, PATTERNS, fleetError } = require('./verb-runner.ts');
const { createStreamCap, MAX_STREAMS_PER_CONSOLE, MAX_STREAMS_PER_SESSION } = require('./stream-cap.ts');
const { createLiveStreams, lastEventVector, parseChannelList, parseVector } = require('./live-stream.ts');

type Reply = { status: number, headers?: Record<string, string>, body?: string | Uint8Array };
type Session = { scope: 'local' } | { scope: 'view' | 'control', deviceId: string, via: 'browser' | 'native' };
// `clientClass` is set in LAN mode only: a request with an Origin, a Sec-Fetch-Site or a device cookie is a
// browser, any other a native client (160 IC-005). `recheck` is set in LAN mode only: the device check again,
// for a stream to run on each keepalive (161 IC-009).
type RouteContext = { req: any, res: any, pathname: string, params: Record<string, string>, webRoot: string, port: number, clientClass?: 'browser' | 'native', session?: Session,
  recheck?: () => Promise<boolean> };
/**
 * An `action` route (162 IC-007) also carries `refused(ctx, session, code)`, which logs a refusal before it replies
 * 403, and `unauthenticated(ctx, code)`, which counts a 401 for the log's aggregated line; the wrappers call both. server.ts
 * calls `refusedEarly(code)` for its own 403 forbidden-origin and 415 unsupported-media, which come before the wrappers.
 */
type Route = Readonly<{ method: 'GET' | 'POST', path: string, stream?: true, action?: true,
  handler: (ctx: RouteContext) => Reply | null | Promise<Reply | null>,
  refused?: (ctx: RouteContext, session: Session, code: string) => Promise<Reply>,
  unauthenticated?: (ctx: RouteContext, code: string) => Promise<void>,
  /** server.ts's refusals before the route's wrappers run, so before any actor exists (`forbidden-origin`, `unsupported-media`): counts one for the log. */
  refusedEarly?: (code: string) => Promise<void> }>;
type StreamCap = { acquire(session: object): (() => void) | null, open(): number };
/** The live hub of live.ts (one per Console, made in main.ts), as far as the route and live-stream.ts use it. */
type LiveHub = {
  readonly epoch: string,
  subscribe(channel: string, listener: (frame: any) => void): () => void,
  current(channel: string): { n: number, state: unknown, error: string | null, gone: boolean } | null,
  readonly unsupported: boolean,
  onUnsupported(listener: () => void): void,
  /** The hub's clock; its streams keep time by it (keepalive, stall, the device recheck). */
  readonly clock?: { now(): number, setTimeout(fn: () => void, ms: number): any, clearTimeout(handle: any): void },
};

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

function requireSession(sessions: any, route: Route): Route['handler'] {
  return async (ctx) => {
    const session = sessions.verify(readCookie(ctx.req.headers.cookie, cookieName(ctx.port)));
    if (!session) {
      if (route.unauthenticated) await route.unauthenticated(ctx, 'unauthenticated');
      return errorReply(401, 'unauthenticated');
    }
    return route.handler({ ...ctx, session });
  };
}

/** The IC-005 error code of a reply this module built, or null. */
function codeOf(reply: Reply): string | null {
  try {
    const code = JSON.parse(String(reply.body)).error.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

// LAN mode: the credential is checked by the device auth (device-auth.ts), then the device's scope must
// list the route (scopes.ts); a refreshed cookie rides on the reply of a browser whose last-seen was written.
// The handler gets `recheck`, the same two checks again on the same request (161 IC-009: a stream runs it
// on each keepalive, so a revoked or expired device is cut off within one). An action route's 401 and 403 go
// through its own `unauthenticated` and `refused` (162 IC-007), in the same order, so each is logged.
function requireDevice(auth: any, route: Route): Route['handler'] {
  return async (ctx) => {
    const checked = await auth.authenticate(ctx);
    if ('reply' in checked) {
      if (route.unauthenticated && checked.reply.status === 401) await route.unauthenticated(ctx, codeOf(checked.reply) ?? 'unauthenticated');
      return checked.reply;
    }
    if (!deviceMayUse(checked.session.scope, route.method, route.path)) {
      return route.refused ? route.refused(ctx, checked.session, 'phone-scope') : errorReply(403, 'phone-scope');
    }
    const recheck = async (): Promise<boolean> => {
      const again = await auth.authenticate(ctx);
      return !('reply' in again) && deviceMayUse(again.session.scope, route.method, route.path);
    };
    const reply = await route.handler({ ...ctx, session: checked.session, recheck });
    return reply !== null && checked.refresh ? { ...reply, headers: { ...reply.headers, 'Set-Cookie': checked.refresh } } : reply;
  };
}

// The frozen route table over `access`: the loopback sessions (the exchange route plus `table`, every /api
// route wrapped in the session check) or, when `access.mode` is 'lan', the device auth (the pairing route
// plus `table`, every /api route wrapped in the device check; no launch-code exchange exists).
function buildRoutes(access: any, table: readonly Route[]): readonly Route[] {
  const lan = access.mode === 'lan';
  const guarded = table.map((route) => (isApiPath(route.path) ? { ...route, handler: lan ? requireDevice(access, route) : requireSession(access, route) } : route));
  return Object.freeze([lan ? access.pairRoute() : sessionRoute(access), ...guarded].map((route) => Object.freeze({ ...route })));
}

const healthz: Route = { method: 'GET', path: '/healthz', handler: () => jsonReply(200, { status: 'ok' }) };
const staticFallback: Route = { method: 'GET', path: '/*', handler: serveStatic };

// The boundary table with no core behind it (the server's default; server and session tests).
const ROUTES: readonly Route[] = buildRoutes(processSessions, [healthz, staticFallback]);

// ---- IC-005 read routes over the verb runner (A.6) and the projectors (A.7) ----

type Runner = { run(shapeId: string, params?: Record<string, string>, options?: { fresh: true }): Promise<any> };
type ErrorInfo = { code: string, verb: string | null, exit: number | null };
type Read = { ok: true, body: any, exit: number } | { ok: false, reply: Reply, code: string, exit: number | null, errorId?: string, error: ErrorInfo };

/**
 * The registry's task classes in registry order: a copy of the keys of `classes` in
 * core/registry/workflows.json (this package ships without the core, and no allow-listed verb lists
 * them on success). routes.test.ts checks it against the core's own `listClasses()`.
 */
const TASK_CLASSES: readonly string[] = Object.freeze(['feature', 'bug', 'refactor', 'review', 'research', 'documentation',
  'dependency-change', 'operations', 'trivial-edit']);

/** IC-005's status and code for a runner failure; 150 IC-010: an older core lacking the verb or flag is `501 core-lacks-verb`. */
function failureStatus(failure: { code: string, reason?: string }): [number, string] {
  if (failure.reason === 'old-core') return [501, 'core-lacks-verb'];
  if (failure.code === 'core-unreachable') return [503, 'core-unreachable'];
  if (failure.code === 'usage') return [400, 'usage'];
  return [502, 'core-error'];
}

/**
 * IC-005's status and error body for a runner failure; `exit` is the core's exit code when it ran.
 * The Fleet codes (IC-024) come first: `fleetError` maps them, anything else is `failureStatus`.
 */
function failureInfo(shapeId: string, failure: { code: string, exit: number | null, errorId?: string, reason?: string }): { status: number, error: ErrorInfo } {
  const fleet = fleetError(shapeId, failure);
  if (fleet) return { status: fleet.status, error: { code: fleet.code, verb: shapeId, exit: failure.exit } };
  const [status, code] = failureStatus(failure);
  return { status, error: { code, verb: shapeId, exit: status === 502 ? failure.exit : null } };
}

function failureReply(shapeId: string, failure: { code: string, exit: number | null, errorId?: string, reason?: string }): Reply {
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

/** `value` with every string leaf passed through `maskLite`; keys and other leaves are kept, so the result is the same shape and still serialises to valid JSON. */
function maskLeaves(value: any): any {
  if (typeof value === 'string') return maskLite(value);
  if (Array.isArray(value)) return value.map(maskLeaves);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskLeaves(item)]));
  return value;
}

/**
 * 180 IC-180-B1: one run's chain as one file for a bug report. It is the run page's answer (`runDetail`, so one read path and the
 * same errors), cut to `{v, exportedAt, console, run, timeline, tasks}` and masked again, because the file leaves the machine in a
 * person's hands. The mask is per string leaf, not over the serialised text, so a pattern cannot cut a JSON escape.
 */
async function runExport(runner: Runner, slug: string, taskId: string): Promise<Reply> {
  const page = await runDetail(runner, slug, taskId);
  if (page.status !== 200) return page;
  const { run, timeline, tasks } = JSON.parse(page.body as string);
  const reply = jsonReply(200, maskLeaves({ v: 1, exportedAt: new Date().toISOString(), console: manifest.version, run, timeline, tasks }));
  return { ...reply, headers: { ...reply.headers, 'Content-Disposition': `attachment; filename="doflow-run-${taskId}.json"` } };
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

// ---- the transcript read of a worker run ----

/** One transcript page per read: the core's own default (IC-022). */
const TRANSCRIPT_PAGE = '200';

function transcriptRead(runner: Runner, project: string, agent: string): Promise<Read> {
  return read(runner, 'transcript', { projectKey: project, agent, limit: TRANSCRIPT_PAGE });
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

// ---- 150 IC-012: GET /api/worker-runs/:slug and the four per-run routes ----

/** The core's RUN_ID (src/runtime/worker/run-store.ts); the verb runner checks it again. */
const RUN_ID = /^w-[0-9a-f]{12}$/;
const LOG_STREAM = /^(?:out|err)$/;
/** IC-002's log cursor with the core's digit bounds (`CURSOR`, src/runtime/worker/reads.ts), so an overlong one is a 400 here, not the core's `usage` as a 502. */
const LOG_CURSOR = /^[0-9]{1,20}:[0-9]{1,16}:[0-9]{1,16}:[0-9]{1,16}$/;
/** The core's `isSafeSlug` (src/runtime/task-scope.ts): PARAM_PATTERN's shape and no `..`, so a slug the core refuses is a 400 here. */
const isWorkerSlug = (slug: string) => PARAM_PATTERN.test(slug) && !slug.includes('..');

/** A worker run's Fleet agent key: a copy of the core's `workerKey` (src/runtime/fleet/tree.ts), sha256('worker:' + runId), first 16 hex. */
function workerAgentKey(runId: string): string {
  return crypto.createHash('sha256').update(`worker:${runId}`).digest('hex').slice(0, 16);
}

/** One run of the fallback list, from the projected `worker-status`: what an older core cannot say (phase, creation, granter, edit) is null. */
const fallbackRun = (status: any) => ({
  runId: status.runId,
  task: status.task,
  token: status.token,
  harness: status.harness,
  childOf: null,
  phase: null,
  endState: ['exited', 'timed-out', 'cancelled'].includes(status.state) ? status.state : null,
  createdAt: null,
  startedAt: status.startedAt,
  endedAt: status.endedAt,
  edit: null,
});

/**
 * IC-012: the worker runs of feature `slug`, from `worker-runs` (ended and child runs included). On a
 * core without that verb (`core-lacks-verb`), the reads every supported core has: `tasks`, then one
 * `worker-status` per active attempt, at most SESSION_LIMITS.workers, the rest counted in
 * `limits.notShown`; ended attempts are not read (`ended: 'not-checked'`). An attempt with no worker
 * run adds no run. Any failed read is its IC-005 error reply.
 */
async function workerRuns(runner: Runner, slug: string): Promise<Reply> {
  if (!isWorkerSlug(slug)) return errorReply(400, 'usage');
  const listed = await read(runner, 'worker-runs', { slug });
  if (listed.ok) return jsonReply(200, listed.body);
  if (listed.code !== 'core-lacks-verb') return listed.reply;
  const graph = await tasks(runner, slug);
  if (!graph.ok) return graph.reply;
  const rows: any[] = graph.tasks === null ? [] : graph.tasks.tasks;
  const active = rows.flatMap((task: any) => task.attempts.filter((a: any) => a.state === 'active').map((a: any) => ({ task: task.id, token: a.token })));
  const checked = active.slice(0, SESSION_LIMITS.workers);
  const reads = await Promise.all(checked.map((a) => read(runner, 'worker-status', { slug, task: a.task, token: String(a.token) })));
  const failed = reads.find((entry) => !entry.ok);
  if (failed && !failed.ok) return failed.reply;
  const runs = reads.map((entry) => (entry as any).body).filter((status) => status !== null).map(fallbackRun);
  return jsonReply(200, {
    v: 1, slug, source: 'active-attempts', store: 'present', runs,
    limits: { shown: runs.length, notShown: active.length - checked.length, ended: 'not-checked' },
  });
}

type WorkerRead = 'result' | 'status' | 'log' | 'transcript';

/**
 * The four per-run routes. `slug`, `runId` and the query are checked before any verb runs (400
 * usage); only the log route takes a query (`stream` required, at most one of `cursor` and `before`).
 */
const workerRunRoute = (runner: Runner, kind: WorkerRead): Route['handler'] => async (ctx) => {
  const query = queryOf(ctx.req, kind === 'log' ? ['stream', 'cursor', 'before'] : []);
  const { slug, runId } = ctx.params;
  if (query === null || !isWorkerSlug(slug) || !RUN_ID.test(runId)) return errorReply(400, 'usage');
  if (kind === 'result') {
    const result = await read(runner, 'worker-result', { slug, runId });
    return result.ok ? jsonReply(200, result.body) : result.reply;
  }
  if (kind === 'status') {
    // The `worker` verb exits 1 only when it refuses, and `--action status` refuses only `unknown-run`
    // (src/runtime/worker/command.ts); a `run: null` answer names no run either.
    const status = await read(runner, 'worker-run-status', { slug, runId });
    if (!status.ok) return status.code === 'core-error' && status.exit === 1 ? errorReply(404, 'unknown-run', 'worker-run-status', 1) : status.reply;
    return status.body === null ? errorReply(404, 'unknown-run', 'worker-run-status', 0) : jsonReply(200, status.body);
  }
  if (kind === 'log') {
    const stream = query.get('stream');
    const cursor = query.get('cursor');
    const before = query.get('before');
    if (stream === undefined || !LOG_STREAM.test(stream) || (cursor !== undefined && before !== undefined)
      || (cursor !== undefined && !LOG_CURSOR.test(cursor)) || (before !== undefined && !LOG_CURSOR.test(before))) return errorReply(400, 'usage');
    const page = await read(runner, 'worker-log', { slug, runId, stream, ...(cursor === undefined ? {} : { cursor }), ...(before === undefined ? {} : { before }) });
    return page.ok ? jsonReply(200, page.body) : page.reply;
  }
  // The transcript: once per request, in the current project, under the run's agent key; no channel exists for it.
  const list = await read(runner, 'projects', {});
  if (!list.ok) return list.reply;
  const current = list.body.projects.find((entry: any) => entry.current === true);
  if (!current) return errorReply(404, 'project-not-found', 'projects', null);
  const page = await transcriptRead(runner, current.projectKey, workerAgentKey(runId));
  return page.ok ? jsonReply(200, page.body) : page.reply;
};

const workerRunsRoute = (runner: Runner): Route['handler'] => (ctx) => (queryOf(ctx.req, []) === null ? errorReply(400, 'usage') : workerRuns(runner, ctx.params.slug));

/**
 * `GET /api/live` (IC-011). After the session check of buildRoutes: the query (`ch`, `since`; 400
 * usage), the slot from the Console's stream cap (429 stream-limit: four per session or device, sixteen
 * in all, 161 IC-008), availability (503 live-unavailable with the slot released first: no hub, or a hub
 * whose supervisor is unsupported), then live-stream.ts owns the response, with the device recheck of
 * `requireDevice` in LAN mode (161 IC-009). No hub subscribe, so no events child, happens before that
 * last step (AC-16). `since` wins over `Last-Event-ID`; a malformed `Last-Event-ID` resumes nothing.
 */
const liveRoute = (live: LiveHub | null, cap: StreamCap): Route['handler'] => {
  const streams = live === null ? null : createLiveStreams(live, live.clock);
  return (ctx) => {
    const query = queryOf(ctx.req, ['ch', 'since']);
    const channels = query === null ? null : parseChannelList(query.get('ch'));
    if (query === null || channels === null) return errorReply(400, 'usage');
    const sinceText = query.get('since');
    const since = sinceText === undefined ? null : parseVector(sinceText);
    if (sinceText !== undefined && (since === null || [...since.positions.keys()].some((channel: string) => !channels.includes(channel)))) return errorReply(400, 'usage');
    const release = cap.acquire(ctx.session as object);
    if (release === null) return errorReply(429, 'stream-limit');
    if (live === null || streams === null || live.unsupported) {
      release();
      return errorReply(503, 'live-unavailable');
    }
    const resume = since ?? lastEventVector(ctx.req.headers['last-event-id'], channels);
    streams.serve(ctx.req, ctx.res, { channels, resume, release, recheck: ctx.recheck ?? null });
    return null;
  };
};

// ---- 151 IC-012 to IC-014: the management routes ----

type Anchors = { project: string[], projectLayers: string[], configHome: string[], home: string[] };
/** Where the Console runs: the runner's project root and the home folder, the base anchors of place.ts (IC-006). */
type Place = { projectRoot: string, home: string };
/** One management read: the projected body with the ISO time its run ended (IC-005 `at`) and how a fresh call was answered, or the failure. */
type ManageRead = { ok: true, body: any, at: string, fresh: string | null }
  | { ok: false, reply: Reply, code: string, exit: number | null, errorId?: string };
/** IC-012: a section is its data and the time of the run it came from, or the IC-005 code of the failed read. */
type ManageSection = { ok: true, data: any, at: string } | { ok: false, code: string };

/** IC-012: the settings keys `/api/advice` and `/api/workers` keep. */
const ADVICE_KEY_PREFIXES: readonly string[] = Object.freeze(['advice.']);
const WORKER_KEY_PREFIXES: readonly string[] = Object.freeze(['workers.', 'dispatch.', 'team.']);

/**
 * One allow-listed management read, projected with the runner's exit (`config-list`'s fail-safe, `doctor`'s
 * findings: IC-005 data exits) and the server's anchors (IC-006). A projector refusal is `core-contract-mismatch`.
 */
async function manageRead(runner: Runner, anchors: Anchors, shapeId: string, params: Record<string, string>, options?: { fresh: true }): Promise<ManageRead> {
  const result = await runner.run(shapeId, params, options);
  if (!result.ok) {
    const { error } = failureInfo(shapeId, result);
    return { ok: false, reply: failureReply(shapeId, result), code: error.code, exit: result.exit, errorId: result.errorId };
  }
  const projected = project(shapeId, result.json, { exit: result.exit, anchors });
  if (!projected.ok) return { ok: false, reply: errorReply(502, 'core-contract-mismatch', shapeId, result.exit), code: 'core-contract-mismatch', exit: result.exit };
  // `at` is a non-enumerable property of every runner result (IC-005), read directly.
  return { ok: true, body: projected.body, at: new Date(result.at || Date.now()).toISOString(), fresh: result.fresh ?? null };
}

const manageSection = (read: ManageRead): ManageSection => (read.ok ? { ok: true, data: read.body, at: read.at } : { ok: false, code: read.code });

/** IC-012: a `picks` read the core refuses with its JSON `usage` id (a kind its registry does not hold) is section `usage` (D13), not core-error. */
const picksSection = (read: ManageRead): ManageSection =>
  (!read.ok && read.code === 'core-error' && read.exit === 2 && read.errorId === 'usage' ? { ok: false, code: 'usage' } : manageSection(read));

/**
 * The `config-list` section kept to the keys under `prefixes`, with every file, and the errors and notes that
 * name no key or a kept key (IC-012). A failed section stays as it is.
 */
function settingsSubset(section: ManageSection, prefixes: readonly string[]): ManageSection {
  if (!section.ok) return section;
  const kept = (key: string) => prefixes.some((prefix) => key.startsWith(prefix));
  const named = (row: { key: string | null }) => row.key === null || kept(row.key);
  const body = section.data;
  return {
    ok: true,
    data: { ...body, keys: body.keys.filter((row: any) => kept(row.key)), errors: body.errors.filter(named), notes: body.notes.filter(named) },
    at: section.at,
  };
}

/** IC-012 `GET /api/settings`: `effective` from `config-list` and `schema` from `config-schema`, read together. No query. */
const settingsRoute = (runner: Runner, anchors: Anchors): Route['handler'] => async (ctx) => {
  if (queryOf(ctx.req, []) === null) return errorReply(400, 'usage');
  const [effective, schema] = await Promise.all([manageRead(runner, anchors, 'config-list', {}), manageRead(runner, anchors, 'config-schema', {})]);
  return jsonReply(200, { v: 1, sections: { effective: manageSection(effective), schema: manageSection(schema) } });
};

/** IC-012 `GET /api/advice[?kind=<adviceKind>]`: the advice settings, the report and the picks (of `kind` when given). */
const adviceRoute = (runner: Runner, anchors: Anchors): Route['handler'] => async (ctx) => {
  const query = queryOf(ctx.req, ['kind']);
  const kind = query?.get('kind');
  if (query === null || (kind !== undefined && !PATTERNS.adviceKind.test(kind))) return errorReply(400, 'usage');
  const [settings, report, picks] = await Promise.all([
    manageRead(runner, anchors, 'config-list', {}),
    manageRead(runner, anchors, 'advise-report', {}),
    manageRead(runner, anchors, 'advice-picks', kind === undefined ? {} : { kind }),
  ]);
  return jsonReply(200, {
    v: 1,
    kind: kind ?? null,
    sections: { settings: settingsSubset(manageSection(settings), ADVICE_KEY_PREFIXES), report: manageSection(report), picks: picksSection(picks) },
  });
};

/** IC-012 `GET /api/workers`: the matrix and the worker settings. Never doctor, so a poll of it never runs doctor (FR-024). */
const workersRoute = (runner: Runner, anchors: Anchors): Route['handler'] => async (ctx) => {
  if (queryOf(ctx.req, []) === null) return errorReply(400, 'usage');
  const [matrix, settings] = await Promise.all([manageRead(runner, anchors, 'worker-matrix', {}), manageRead(runner, anchors, 'config-list', {})]);
  return jsonReply(200, { v: 1, sections: { matrix: manageSection(matrix), settings: settingsSubset(manageSection(settings), WORKER_KEY_PREFIXES) } });
};

/** IC-013 `GET /api/followups[?state=...][&cursor=<fuCursor>]`: one page of 25 and the lifecycle overview; `state` defaults to `open`. */
const followupsRoute = (runner: Runner, anchors: Anchors): Route['handler'] => async (ctx) => {
  const query = queryOf(ctx.req, ['state', 'cursor']);
  const state = query?.get('state') ?? 'open';
  const cursor = query?.get('cursor');
  if (query === null || !PATTERNS.fuState.test(state) || (cursor !== undefined && !PATTERNS.fuCursor.test(cursor))) return errorReply(400, 'usage');
  const [list, overview] = await Promise.all([
    manageRead(runner, anchors, 'followups', cursor === undefined ? { state } : { state, cursor }),
    manageRead(runner, anchors, 'lifecycle-overview', {}),
  ]);
  return jsonReply(200, { v: 1, state, cursor: cursor ?? null, sections: { list: manageSection(list), overview: manageSection(overview) } });
};

/** IC-013 `GET /api/followups/:id`: the record, `404 followup-not-found` when the read holds none, else the IC-005 error reply. */
const followupRoute = (runner: Runner, anchors: Anchors): Route['handler'] => async (ctx) => {
  const { id } = ctx.params;
  if (queryOf(ctx.req, []) === null || !PATTERNS.fuId.test(id)) return errorReply(400, 'usage');
  const record = await manageRead(runner, anchors, 'followup-record', { id });
  if (!record.ok) return record.reply;
  return record.body.followup === null ? errorReply(404, 'followup-not-found', 'followup-record', 0) : jsonReply(200, { v: 1, followup: record.body.followup });
};

/**
 * IC-014 `GET /api/doctor[?refresh=1]`: the only route that runs `doctor`. Without `refresh` a run younger than the
 * shape's ttl is served from the cache; with it the runner's fresh rules apply (joined, too-soon, ran).
 */
const doctorRoute = (runner: Runner, anchors: Anchors): Route['handler'] => async (ctx) => {
  const query = queryOf(ctx.req, ['refresh']);
  const refresh = query?.get('refresh');
  if (query === null || (refresh !== undefined && refresh !== '1')) return errorReply(400, 'usage');
  const doctor = await manageRead(runner, anchors, 'doctor', {}, refresh === undefined ? undefined : { fresh: true });
  return doctor.ok ? jsonReply(200, { v: 1, at: doctor.at, refresh: doctor.fresh, doctor: doctor.body }) : doctor.reply;
};

/** IC-014 `GET /api/storage`: the storage report. No query. */
const storageRoute = (runner: Runner, anchors: Anchors): Route['handler'] => async (ctx) => {
  if (queryOf(ctx.req, []) === null) return errorReply(400, 'usage');
  const storage = await manageRead(runner, anchors, 'storage-report', {});
  return storage.ok ? jsonReply(200, { v: 1, at: storage.at, storage: storage.body }) : storage.reply;
};

/** 152 IC-006 `GET /api/sessions-history[?days=<n>][&limit=<n>]`: finished workflow sessions. */
const sessionsHistoryRoute = (runner: Runner, anchors: Anchors): Route['handler'] => async (ctx) => {
  const query = queryOf(ctx.req, ['days', 'limit']);
  if (query === null) return errorReply(400, 'usage');
  const days = query.get('days');
  const limit = query.get('limit');
  if (days !== undefined && (!PATTERNS.days.test(days) || Number(days) > 90)) return errorReply(400, 'usage');
  if (limit !== undefined && (!PATTERNS.limit.test(limit) || Number(limit) > 500)) return errorReply(400, 'usage');

  const params: Record<string, string> = {};
  if (days !== undefined) params.days = days;
  if (limit !== undefined) params.limit = limit;

  const history = await manageRead(runner, anchors, 'sessions-history', params);
  return history.ok ? jsonReply(200, history.body) : history.reply;
};

// ---- 165 D7, IC-002: the start form's reads, GET /api/start and GET /api/start/options (scopes.ts: control and local only) ----

/** `GET /api/start`: the projects a session can start in, by key and label (and the Console's own as `current`); never a root. */
const startProjectsRoute = (runner: Runner): Route['handler'] => async (ctx) => {
  if (queryOf(ctx.req, []) === null) return errorReply(400, 'usage');
  const list = await read(runner, 'projects', {});
  if (!list.ok) return list.reply;
  const projects = list.body.projects.map((entry: any) => ({ projectKey: entry.projectKey, label: entry.label, current: entry.current }));
  return jsonReply(200, { v: 1, projects, truncated: list.body.truncated });
};

/**
 * `GET /api/start/options?projectKey=K`: IC-002 for one project, through `start-options` (scoped: run in that project's root). A
 * key the runner's map lacks refreshes `projects` once, past its cache (as an action does), before 404 project-not-found. An older
 * core is 501 core-lacks-verb: a reply naming an unknown flag, or `usage` to a query whose one parameter the runner checked.
 */
const startOptionsRoute = (runner: Runner): Route['handler'] => async (ctx) => {
  const query = queryOf(ctx.req, ['projectKey']);
  const projectKey = query?.get('projectKey');
  if (projectKey === undefined || !PATTERNS.key16.test(projectKey)) return errorReply(400, 'usage');
  let result = await runner.run('start-options', { projectKey });
  if (!result.ok && result.code === 'project-not-found') {
    await runner.run('projects', {}, { fresh: true });
    result = await runner.run('start-options', { projectKey });
  }
  if (!result.ok) {
    if (result.code === 'core-error' && result.exit === 2 && result.errorId === 'usage') return errorReply(501, 'core-lacks-verb', 'start-options', null);
    return failureReply('start-options', result);
  }
  const projected = project('start-options', result.json, { projectKey });
  return projected.ok ? jsonReply(200, { v: 1, ...projected.body }) : errorReply(502, 'core-contract-mismatch', 'start-options', 0);
};

/**
 * 172 IC-005 `GET /api/harness-login`: each worker harness's login answer (`worker --action login-state`), at most 32, one KiB each.
 * An older core without the action answers its JSON `usage` id: 501 core-lacks-verb.
 */
const harnessLoginRoute = (runner: Runner): Route['handler'] => async (ctx) => {
  if (queryOf(ctx.req, []) === null) return errorReply(400, 'usage');
  const result = await runner.run('login-state', {});
  if (!result.ok) {
    if (result.code === 'core-error' && result.exit === 2 && result.errorId === 'usage') return errorReply(501, 'core-lacks-verb', 'login-state', null);
    return failureReply('login-state', result);
  }
  const projected = project('login-state', result.json);
  return projected.ok ? jsonReply(200, { v: 1, ...projected.body }) : errorReply(502, 'core-contract-mismatch', 'login-state', 0);
};

/**
 * The Console's table (IC-005) over `runner`: every /api route but the exchange is behind the session
 * check (buildRoutes), every one is GET but the action routes of `actions` (actions.ts, 162 IC-002: one
 * `POST /api/actions/<id>` per ACTIONS row, and `GET /api/actions`; without `actions` they are made over no log,
 * so every action answers 503 action-log-unwritable), and each answers `{v:1, ...}` or IC-005's error body. The
 * stream route takes its slots from one stream cap (DEC-031, 161 IC-008), made here once per table. `live` is the Console's live
 * hub; without one (route tests over a scripted runner) `/api/live` answers 503 live-unavailable.
 * `place` gives the anchors the management routes place paths and text under (151 IC-006).
 */
function consoleRoutes(runner: Runner, access: any = processSessions, live: LiveHub | null = null,
  place: Place = { projectRoot: process.cwd(), home: os.homedir() }, actions: { routes: readonly Route[] } | null = null): readonly Route[] {
  const streamCap = createStreamCap(MAX_STREAMS_PER_SESSION, MAX_STREAMS_PER_CONSOLE);
  // Required here, not at the top: actions.ts requires this module for its reply helpers.
  const actionRoutes = (actions ?? require('./actions.ts').createActions({ runner, log: null })).routes;
  const anchors: Anchors = anchorsOf({ projectRoot: place.projectRoot, home: place.home });
  return buildRoutes(access, [
    healthz,
    { method: 'GET', path: '/api/info', handler: () => info(runner) },
    { method: 'GET', path: '/api/runs', handler: () => runs(runner) },
    { method: 'GET', path: '/api/runs/:slug/:taskId', handler: (ctx) => runDetail(runner, ctx.params.slug, ctx.params.taskId) },
    { method: 'GET', path: '/api/runs/:slug/:taskId/export', handler: (ctx) => runExport(runner, ctx.params.slug, ctx.params.taskId) },
    { method: 'GET', path: '/api/workflows', handler: () => workflows(runner) },
    { method: 'GET', path: '/api/sessions', handler: () => sessionsView(runner) },
    { method: 'GET', path: '/api/worker-runs/:slug', handler: workerRunsRoute(runner) },
    { method: 'GET', path: '/api/worker-runs/:slug/:runId/result', handler: workerRunRoute(runner, 'result') },
    { method: 'GET', path: '/api/worker-runs/:slug/:runId/status', handler: workerRunRoute(runner, 'status') },
    { method: 'GET', path: '/api/worker-runs/:slug/:runId/log', handler: workerRunRoute(runner, 'log') },
    { method: 'GET', path: '/api/worker-runs/:slug/:runId/transcript', handler: workerRunRoute(runner, 'transcript') },
    { method: 'GET', path: '/api/settings', handler: settingsRoute(runner, anchors) },
    { method: 'GET', path: '/api/advice', handler: adviceRoute(runner, anchors) },
    { method: 'GET', path: '/api/workers', handler: workersRoute(runner, anchors) },
    { method: 'GET', path: '/api/followups', handler: followupsRoute(runner, anchors) },
    { method: 'GET', path: '/api/followups/:id', handler: followupRoute(runner, anchors) },
    { method: 'GET', path: '/api/doctor', handler: doctorRoute(runner, anchors) },
    { method: 'GET', path: '/api/storage', handler: storageRoute(runner, anchors) },
    { method: 'GET', path: '/api/sessions-history', handler: sessionsHistoryRoute(runner, anchors) },
    { method: 'GET', path: '/api/live', stream: true, handler: liveRoute(live, streamCap) },
    { method: 'GET', path: '/api/start', handler: startProjectsRoute(runner) },
    { method: 'GET', path: '/api/start/options', handler: startOptionsRoute(runner) },
    { method: 'GET', path: '/api/harness-login', handler: harnessLoginRoute(runner) },
    ...actionRoutes,
    staticFallback,
  ]);
}

module.exports = { ROUTES, SESSION_LIMITS, TASK_CLASSES, buildRoutes, consoleRoutes, isApiPath, matchPath, jsonReply, errorReply, readBody, healthz, staticFallback, JSON_TYPE, runs, tasks, runDetail, sessionsView, workerRuns, workerAgentKey };
