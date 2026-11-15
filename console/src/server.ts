'use strict';

// The Console HTTP boundary (design C2; IC-005, IC-006; 092 IC-010; 160 IC-005). Per request, in this order:
// Host allow-list (else 421, empty body) -> in LAN mode, classify the client (browser or native) and refuse
// an Authorization header on a browser request -> Origin for /api/* (absent or own origin; else 403) ->
// route by path and declared method (no route for the path: GET 404, any other method 405) ->
// for a non-GET route: an own Origin, `Sec-Fetch-Site: same-origin` when sent (a native LAN client sends
// neither), and `Content-Type: application/json` exactly (else 403 / 415) -> the handler. Every response, including
// Node's own 400 for a malformed request, carries the header set of headers.ts. A stream route's
// handler gets `res` and returns null once it owns the response (live-stream.ts writes the same header set
// itself); a Reply it returns instead is sent as usual.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { securityHeaders } = require('./headers.ts');
const { ROUTES, isApiPath, matchPath, errorReply } = require('./routes.ts');
const { readCookie, DEVICE_COOKIE } = require('./session.ts');

const BIND_HOST = '127.0.0.1';

type Reply = { status: number, headers?: Record<string, string>, body?: string | Uint8Array };
type ServerOptions = {
  webRoot?: string, routes?: readonly any[], host?: string, port?: number, tls?: { certPath: string, keyPath: string },
  /** `loopback` (the default): plain http on 127.0.0.1. `lan`: https on `host`, paired devices only (160 IC-005). */
  mode?: 'loopback' | 'lan',
  /** LAN mode only: the problem with `host`, or null. Defaults to `remoteAddressError`; tests inject `() => null` to bind loopback. */
  addressCheck?: (address: string) => string | null,
  /** LAN mode only: the device check (device-auth.ts `authenticate`), run before a path that matches no /api route is answered, so an unpaired caller learns nothing about which paths exist. */
  authenticate?: (ctx: any) => Promise<{ session: any } | { reply: Reply }>,
};
type ConsoleServer = { server: any, port: number, origin: string, close(): Promise<void> };

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request' };

function rawErrorResponse(status: number): string {
  const lines = Object.entries(securityHeaders(false)).map(([name, value]) => `${name}: ${value}`);
  return `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n${lines.join('\r\n')}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6 && !address.includes('%')) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    // Unique-local IPv6 (fc00::/7); reject loopback, link-local and IPv4-mapped addresses.
    const firstHextet = parseInt(normalized.split(':')[0] || '0', 16);
    return firstHextet >= 0xfc00 && firstHextet <= 0xfdff;
  }
  return false;
}

function isAssignedAddress(address: string, interfaces: any = os.networkInterfaces()): boolean {
  const normalize = (value: string) => net.isIP(value) === 6
    ? new URL(`http://[${value.split('%')[0]}]/`).hostname
    : value;
  const target = normalize(address);
  return Object.values(interfaces).some((entries: any) => Array.isArray(entries)
    && entries.some((entry: any) => typeof entry.address === 'string' && normalize(entry.address) === target));
}

function remoteAddressError(address: string): string | null {
  if (net.isIP(address) === 0) return 'listen address must be a literal private IP address';
  if (!isPrivateAddress(address)) return 'listen address must be RFC1918, Tailscale CGNAT, or IPv6 unique-local';
  if (!isAssignedAddress(address)) return 'listen address must be assigned to a local network interface';
  return null;
}

function urlHost(address: string): string {
  return net.isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname : address;
}

function allowedAuthorities(host: string, port: number, remote: boolean): { hosts: Set<string>, origins: Set<string> } {
  const protocol = remote ? 'https' : 'http';
  const names = remote ? [host] : [host, 'localhost'];
  const hosts = new Set(names.map((name) => `${name}:${port}`.toLowerCase()));
  const origins = new Set(names.map((name) => `${protocol}://${name}:${port}`));
  // Browsers omit the scheme's default port in Host and Origin.
  if (port === (remote ? 443 : 80)) {
    for (const name of names) {
      hosts.add(name.toLowerCase());
      origins.add(`${protocol}://${name}`);
    }
  }
  return { hosts, origins };
}

// Loopback remains the default. LAN mode requires an address the check accepts (an assigned private one) and
// explicit TLS; host and origin checks below remain exact in either mode (092 IC-010). The mode is asked for,
// never inferred from the host.
async function createServer(options: ServerOptions = {}): Promise<ConsoleServer> {
  const host = options.host ?? BIND_HOST;
  const lan = options.mode === 'lan';
  if (lan) {
    const problem = (options.addressCheck ?? remoteAddressError)(host);
    if (problem) throw new Error(`doflow ui refused remote bind: ${problem}`);
    if (!options.tls || !path.isAbsolute(options.tls.certPath) || !path.isAbsolute(options.tls.keyPath)) {
      throw new Error('doflow ui remote bind requires absolute TLS certificate and key paths');
    }
  } else if (host !== BIND_HOST) {
    throw new Error(`doflow ui loopback mode binds only ${BIND_HOST}`);
  } else if (options.tls) {
    throw new Error('doflow ui TLS options require an explicit private listen address');
  }
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
    // An action route counts its requests refused here (403 forbidden-origin, 415 unsupported-media), before any actor exists.
    const refusedBefore = async (status: number, code: string): Promise<Reply> => {
      const route = routes.find((candidate: any) => typeof candidate.refusedEarly === 'function' && candidate.method === req.method && matchPath(candidate.path, pathname) !== null);
      if (route) await route.refusedEarly(code);
      return errorReply(status, code);
    };
    // LAN mode: a request that carries an Origin, a Sec-Fetch-Site or the device cookie is a browser and is
    // read by cookie only; any other is a native client and is read by Bearer only (device-auth.ts).
    let clientClass: 'browser' | 'native' | undefined;
    if (lan) {
      const browser = origin !== undefined || req.headers['sec-fetch-site'] !== undefined || readCookie(req.headers.cookie, DEVICE_COOKIE) !== null;
      clientClass = browser ? 'browser' : 'native';
      if (api && browser && req.headers.authorization !== undefined) return refusedBefore(403, 'forbidden-origin');
      // A cross-site, same-site or other-mode request is refused for every method; a missing header (not a browser) passes.
      const site = req.headers['sec-fetch-site'];
      if (api && site !== undefined && site !== 'same-origin' && site !== 'none') return refusedBefore(403, 'forbidden-origin');
    }
    if (api && origin !== undefined && !allowedOrigins.has(origin)) return refusedBefore(403, 'forbidden-origin');

    const matches = routes
      .map((route: any) => ({ route, params: matchPath(route.path, pathname) }))
      .filter((match: any) => match.params !== null);
    const hit = matches.find((match: any) => match.route.method === req.method);
    if (lan && api && !(hit && isApiPath(hit.route.path))) {
      // No /api route answers this: an unpaired caller gets the one 401 whatever the path; a paired one a true 404 or 405.
      if (options.authenticate) {
        const checked = await options.authenticate({ req, res, pathname, params: {}, webRoot, port: boundPort, clientClass });
        if ('reply' in checked) return checked.reply;
      }
      const declared = [...new Set(matches.filter((match: any) => isApiPath(match.route.path)).map((match: any) => match.route.method))];
      return declared.length ? { status: 405, headers: { Allow: declared.join(', ') } } : errorReply(404, 'not-found');
    }
    if (!hit) {
      if (req.method === 'GET') return errorReply(404, 'not-found');
      const declared = [...new Set(matches.map((match: any) => match.route.method))];
      return { status: 405, headers: { Allow: declared.length ? declared.join(', ') : 'GET' } };
    }
    if (req.method !== 'GET') {
      if (clientClass !== 'native') {
        if (origin === undefined || !allowedOrigins.has(origin)) return refusedBefore(403, 'forbidden-origin');
        const fetchSite = req.headers['sec-fetch-site'];
        if (fetchSite !== undefined && fetchSite !== 'same-origin') return refusedBefore(403, 'forbidden-origin');
      }
      if (req.headers['content-type'] !== 'application/json') return refusedBefore(415, 'unsupported-media');
    }
    return hit.route.handler({ req, res, pathname, params: hit.params, webRoot, port: boundPort, ...(clientClass === undefined ? {} : { clientClass }) });
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
  const onRequest = (req: any, res: any) => {
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
  };
  let server: any;
  if (lan && options.tls) {
    let cert: Buffer;
    let key: Buffer;
    try {
      cert = fs.readFileSync(options.tls.certPath);
      key = fs.readFileSync(options.tls.keyPath);
    } catch {
      throw new Error('doflow ui could not read the TLS certificate and key');
    }
    let leaf: any;
    let privateKey: any;
    try {
      leaf = new crypto.X509Certificate(cert);
      privateKey = crypto.createPrivateKey(key);
    } catch {
      throw new Error('doflow ui could not parse the TLS certificate or private key');
    }
    if (!leaf.checkIP(host)) {
      throw new Error(`doflow ui TLS certificate must contain an IP subject alternative name for ${host}`);
    }
    if (!leaf.checkPrivateKey(privateKey)) {
      throw new Error('doflow ui TLS certificate does not match the private key');
    }
    server = (https as any).createServer({ requireHostHeader: false, cert, key, minVersion: 'TLSv1.2' }, onRequest);
  } else {
    server = (http as any).createServer({ requireHostHeader: false }, onRequest);
  }
  server.on('clientError', (error: any, socket: any) => {
    if (error.code === 'ECONNRESET' || !socket.writable) return socket.destroy();
    socket.end(rawErrorResponse(400));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  boundPort = server.address().port;
  const hostForUrl = urlHost(host);
  const protocol = lan ? 'https' : 'http';
  ({ hosts: allowedHosts, origins: allowedOrigins } = allowedAuthorities(hostForUrl, boundPort, lan));

  return {
    server,
    port: boundPort,
    origin: `${protocol}://${hostForUrl}:${boundPort}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

module.exports = { createServer, BIND_HOST, isPrivateAddress, isAssignedAddress, remoteAddressError, urlHost, allowedAuthorities };
