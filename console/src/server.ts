'use strict';

// The Console HTTP boundary (design C2; IC-005, IC-006; 092 IC-010). Per request, in this order:
// Host allow-list (else 421, empty body) -> Origin for /api/* (absent or own origin; else 403) ->
// route by path and declared method (no route for the path: GET 404, any other method 405) ->
// for a non-GET route: an own Origin, `Sec-Fetch-Site: same-origin` when sent, and
// `Content-Type: application/json` exactly (else 403 / 415) -> the handler. Every response, including
// Node's own 400 for a malformed request, carries the header set of headers.ts. A stream route's
// handler gets `res` and returns null once it owns the response (stream.ts writes the same header set
// itself); a Reply it returns instead is sent as usual.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { securityHeaders } = require('./headers.ts');
const { ROUTES, isApiPath, matchPath, errorReply } = require('./routes.ts');

const BIND_HOST = '127.0.0.1';

type Reply = { status: number, headers?: Record<string, string>, body?: string | Uint8Array };
type ServerOptions = { webRoot?: string, routes?: readonly any[], host?: string, port?: number };
type ConsoleServer = { server: any, port: number, origin: string, close(): Promise<void> };

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request' };

function rawErrorResponse(status: number): string {
  const lines = Object.entries(securityHeaders(false)).map(([name, value]) => `${name}: ${value}`);
  return `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n${lines.join('\r\n')}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
}

// Refuses every host but the literal 127.0.0.1 before anything is created (092 IC-010: no override).
async function createServer(options: ServerOptions = {}): Promise<ConsoleServer> {
  const host = options.host ?? BIND_HOST;
  if (host !== BIND_HOST) throw new Error(`doflow ui binds only ${BIND_HOST}; refused host ${JSON.stringify(host)}`);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`port must be an integer 0..65535, got ${port}`);
  if (typeof options.webRoot !== 'string' || !path.isAbsolute(options.webRoot)) throw new Error('webRoot must be an absolute path');
  let webRoot: string;
  try {
    webRoot = fs.realpathSync(options.webRoot);
  } catch {
    throw new Error(`webRoot does not exist: ${options.webRoot}`);
  }
  if (!fs.statSync(webRoot).isDirectory()) throw new Error(`webRoot is not a directory: ${options.webRoot}`);
  const routes = options.routes ?? ROUTES;

  let boundPort = 0;
  let allowedHosts: Set<string> = new Set();
  let allowedOrigins: Set<string> = new Set();

  async function decide(req: any, res: any, pathname: string, api: boolean): Promise<Reply | null> {
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string' || !allowedHosts.has(hostHeader.toLowerCase())) return { status: 421 };
    const origin = req.headers.origin;
    if (api && origin !== undefined && !allowedOrigins.has(origin)) return errorReply(403, 'forbidden-origin');

    const matches = routes
      .map((route: any) => ({ route, params: matchPath(route.path, pathname) }))
      .filter((match: any) => match.params !== null);
    const hit = matches.find((match: any) => match.route.method === req.method);
    if (!hit) {
      if (req.method === 'GET') return errorReply(404, 'not-found');
      const declared = [...new Set(matches.map((match: any) => match.route.method))];
      return { status: 405, headers: { Allow: declared.length ? declared.join(', ') : 'GET' } };
    }
    if (req.method !== 'GET') {
      if (origin === undefined || !allowedOrigins.has(origin)) return errorReply(403, 'forbidden-origin');
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite !== undefined && fetchSite !== 'same-origin') return errorReply(403, 'forbidden-origin');
      if (req.headers['content-type'] !== 'application/json') return errorReply(415, 'unsupported-media');
    }
    return hit.route.handler({ req, res, pathname, params: hit.params, webRoot, port: boundPort });
  }

  function send(res: any, api: boolean, reply: Reply): void {
    const body = reply.body ?? '';
    // The header set is applied last, so no handler can replace or drop one of its headers.
    const headers = { ...(reply.headers ?? {}), ...securityHeaders(api), 'Content-Length': String(typeof body === 'string' ? Buffer.byteLength(body) : body.length) };
    res.writeHead(reply.status, headers);
    res.end(body);
  }

  // requireHostHeader off: Node's own 400 for a missing Host would skip the header set; the allow-list
  // answers it with 421 like any other foreign Host.
  const server = (http as any).createServer({ requireHostHeader: false }, (req: any, res: any) => {
    const url = typeof req.url === 'string' ? req.url : '';
    // Only origin-form targets route; an absolute-form or `*` target matches nothing but the 404.
    const pathname = url.startsWith('/') ? url.split('?')[0] : '';
    const api = isApiPath(pathname);
    Promise.resolve()
      .then(() => decide(req, res, pathname, api))
      .then((reply) => (reply === null ? undefined : send(res, api, reply)))
      .catch(() => {
        // A handler or reply fault is reported by status only: its message may carry paths (092 IC-012).
        // If even the 500 cannot be written, the socket is dropped rather than left hanging.
        try {
          if (!res.headersSent) return send(res, api, { status: 500 });
        } catch {}
        res.destroy();
      });
  });
  server.on('clientError', (error: any, socket: any) => {
    if (error.code === 'ECONNRESET' || !socket.writable) return socket.destroy();
    socket.end(rawErrorResponse(400));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  boundPort = server.address().port;
  allowedHosts = new Set([`${BIND_HOST}:${boundPort}`, `localhost:${boundPort}`]);
  allowedOrigins = new Set([`http://${BIND_HOST}:${boundPort}`, `http://localhost:${boundPort}`]);

  return {
    server,
    port: boundPort,
    origin: `http://${BIND_HOST}:${boundPort}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

module.exports = { createServer, BIND_HOST };
