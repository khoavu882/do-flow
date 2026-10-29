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
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { securityHeaders } = require('./headers.ts');
const { ROUTES, isApiPath, matchPath, errorReply } = require('./routes.ts');

const BIND_HOST = '127.0.0.1';

type Reply = { status: number, headers?: Record<string, string>, body?: string | Uint8Array };
type ServerOptions = { webRoot?: string, routes?: readonly any[], host?: string, port?: number, tls?: { certPath: string, keyPath: string } };
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

// Loopback remains the default. Remote binds require an assigned private interface and explicit TLS;
// host and origin checks below remain exact in either mode (092 IC-010).
async function createServer(options: ServerOptions = {}): Promise<ConsoleServer> {
  const host = options.host ?? BIND_HOST;
  const remote = host !== BIND_HOST;
  if (remote) {
    const problem = remoteAddressError(host);
    if (problem) throw new Error(`doflow ui refused remote bind: ${problem}`);
    if (!options.tls || !path.isAbsolute(options.tls.certPath) || !path.isAbsolute(options.tls.keyPath)) {
      throw new Error('doflow ui remote bind requires absolute TLS certificate and key paths');
    }
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
    return hit.route.handler({ req, res, pathname, params: hit.params, webRoot, port: boundPort, secure: remote });
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
  if (remote && options.tls) {
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
  const protocol = remote ? 'https' : 'http';
  ({ hosts: allowedHosts, origins: allowedOrigins } = allowedAuthorities(hostForUrl, boundPort, remote));

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
