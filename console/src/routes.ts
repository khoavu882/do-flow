'use strict';

// The Console route table (IC-005). A route declares its method, so the server answers 405 for every
// method no route declares for a path; the only non-GET route the contract allows is
// `POST /api/session`, the launch-code exchange (092 IC-011). `buildRoutes` puts every other /api
// route behind the session check, so a route added to the table cannot skip it. Paths are literal segments, `:name` segments (one non-empty raw segment,
// still percent-encoded: handlers validate it), or the whole-table static fallback `/*`, which never
// matches under /api.

const { readStatic } = require('./static.ts');
const { processSessions, sessionCookie, readCookie, cookieName } = require('./session.ts');
const { project } = require('./project.ts');
const { handshake } = require('./handshake.ts');
const { PARAM_PATTERN } = require('./verb-runner.ts');

type Reply = { status: number, headers?: Record<string, string>, body?: string | Uint8Array };
type RouteContext = { req: any, pathname: string, params: Record<string, string>, webRoot: string, port: number, session?: { scope: 'read' } };
type Route = Readonly<{ method: 'GET' | 'POST', path: string, handler: (ctx: RouteContext) => Reply | Promise<Reply> }>;

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
type Read = { ok: true, body: any, exit: number } | { ok: false, reply: Reply, exit: number | null, errorId?: string };

/**
 * The registry's task classes in registry order: a copy of the keys of `classes` in
 * core/registry/workflows.json (this package ships without the core, and no allow-listed verb lists
 * them on success). routes.test.ts checks it against the core's own `listClasses()`.
 */
const TASK_CLASSES: readonly string[] = Object.freeze(['feature', 'bug', 'refactor', 'review', 'research', 'documentation',
  'dependency-change', 'operations', 'trivial-edit']);

/** IC-005's code for a runner failure; `exit` is the core's exit code when it ran. */
function failureReply(shapeId: string, failure: { code: string, exit: number | null }): Reply {
  if (failure.code === 'core-unreachable') return errorReply(503, 'core-unreachable', shapeId, null);
  if (failure.code === 'usage') return errorReply(400, 'usage', shapeId, null);
  return errorReply(502, 'core-error', shapeId, failure.exit);
}

/** One allow-listed call, projected; a projector refusal is `core-contract-mismatch` (no partial body). */
async function read(runner: Runner, shapeId: string, params: Record<string, string>, context?: unknown): Promise<Read> {
  const result = await runner.run(shapeId, params);
  if (!result.ok) return { ok: false, reply: failureReply(shapeId, result), exit: result.exit, errorId: result.errorId };
  const projected = project(shapeId, result.json, context);
  return projected.ok ? { ok: true, body: projected.body, exit: 0 } : { ok: false, reply: errorReply(502, 'core-contract-mismatch', shapeId, 0), exit: 0 };
}

async function info(runner: Runner): Promise<Reply> {
  const [checked, capabilities] = await Promise.all([handshake(runner), read(runner, 'capabilities', {})]);
  if (!checked.ok) return checked.code === 'core-contract-mismatch' ? errorReply(502, checked.code, 'version', 0) : failureReply('version', checked);
  if (!capabilities.ok) return capabilities.reply;
  return jsonReply(200, { v: 1, core: { version: checked.version, inRange: checked.inRange }, capabilities: capabilities.body.capabilities });
}

async function runs(runner: Runner): Promise<Reply> {
  const list = await read(runner, 'list', {});
  if (list.ok) return jsonReply(200, list.body);
  // The core's own id for a checkout enumeration failure (workflow-orchestrator.ts listRuns); any other failure is core-error.
  return list.errorId === 'cannot-list-checkouts' ? errorReply(502, 'cannot-list-checkouts', 'list', list.exit) : list.reply;
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
  if (!timeline.ok) return timeline.exit === 1 ? errorReply(404, 'run-not-found', 'timeline', 1) : timeline.reply;
  const graph = await tasksCall;
  if (!graph.ok) return graph.reply;
  const body: Record<string, unknown> = { v: 1, run: run.body, timeline: timeline.body, tasks: graph.tasks, workflow: workflow.body };
  if (graph.tasks === null) body.tasksReason = graph.reason;
  return jsonReply(200, body);
}

async function workflows(runner: Runner): Promise<Reply> {
  const reads = await Promise.all(TASK_CLASSES.map((taskClass) => read(runner, 'workflow', { taskClass })));
  const failed = reads.find((entry) => !entry.ok);
  if (failed && !failed.ok) return failed.reply;
  return jsonReply(200, { v: 1, workflows: reads.map((entry) => (entry as any).body) });
}

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
    staticFallback,
  ]);
}

module.exports = { ROUTES, TASK_CLASSES, buildRoutes, consoleRoutes, isApiPath, matchPath, jsonReply, errorReply, JSON_TYPE };
