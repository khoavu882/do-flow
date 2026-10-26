'use strict';

// The Console route table (IC-005). A route declares its method, so the server answers 405 for every
// method no route declares for a path; the only non-GET route the contract allows is
// `POST /api/session`, the launch-code exchange (092 IC-011). `buildRoutes` puts every other /api
// route behind the session check, so a route added to the table cannot skip it. Paths are literal segments, `:name` segments (one non-empty raw segment,
// still percent-encoded: handlers validate it), or the whole-table static fallback `/*`, which never
// matches under /api.

const { readStatic } = require('./static.ts');
const { processSessions, sessionCookie, readCookie, cookieName } = require('./session.ts');

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

const ROUTES: readonly Route[] = buildRoutes(processSessions, [
  { method: 'GET', path: '/healthz', handler: () => jsonReply(200, { status: 'ok' }) },
  { method: 'GET', path: '/*', handler: serveStatic },
]);

module.exports = { ROUTES, buildRoutes, isApiPath, matchPath, jsonReply, errorReply, JSON_TYPE };
