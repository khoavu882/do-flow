'use strict';

// The Console route table (IC-005). A route declares its method, so the server answers 405 for every
// method no route declares for a path; the only non-GET route the contract allows is
// `POST /api/session` (A.5). Paths are literal segments, `:name` segments (one non-empty raw segment,
// still percent-encoded: handlers validate it), or the whole-table static fallback `/*`, which never
// matches under /api.

const { readStatic } = require('./static.ts');

type Reply = { status: number, headers?: Record<string, string>, body?: string | Uint8Array };
type RouteContext = { req: any, pathname: string, params: Record<string, string>, webRoot: string, port: number };
type Route = Readonly<{ method: 'GET' | 'POST', path: string, handler: (ctx: RouteContext) => Reply | Promise<Reply> }>;

const JSON_TYPE = 'application/json; charset=utf-8';

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

const ROUTES: readonly Route[] = Object.freeze([
  Object.freeze({ method: 'GET', path: '/healthz', handler: () => jsonReply(200, { status: 'ok' }) }),
  Object.freeze({ method: 'GET', path: '/*', handler: serveStatic }),
] as Route[]);

module.exports = { ROUTES, isApiPath, matchPath, jsonReply, errorReply, JSON_TYPE };
