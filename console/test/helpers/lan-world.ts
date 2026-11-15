'use strict';

// A scratch LAN world for the boundary tests (feature 160): a device store under a temp dir, the device
// auth over it, a way to pair a device without HTTP, and an https server on 127.0.0.1 in LAN mode with the
// injected address check (no LAN address is bound, nothing reads the real config home, no openssl).

const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createLanStore, sha256Hex } = require('../../src/lan-store.ts');
const { createDeviceAuth } = require('../../src/device-auth.ts');
const { ensureCertificate } = require('../../src/lan-cert.ts');
const { createServer } = require('../../src/server.ts');

type Reply = { status: number, headers: Record<string, any>, body: string };

/** A store, an auth and a log over a fresh temp dir removed when the test ends. `clock` replaces Date.now for both. */
function lanWorld(t: any, clock: { now: () => number } = { now: Date.now }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lan-world-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createLanStore({ dir, now: clock.now, host: 'testhost', pid: process.pid, lockWaitMs: 300 });
  const logs: string[] = [];
  const auth = createDeviceAuth({ store, now: clock.now, log: (line: string) => logs.push(line) });
  /** Pairs a device straight through the store: its token, the cookie header value and the Bearer header value. */
  const pair = async (scope: 'view' | 'control' = 'view', name = 'Test phone') => {
    const { code } = await store.mintCode(scope);
    const result = await store.consumeCode(code, { name, via: 'browser', address: '192.168.1.40' });
    return { ...result, cookie: `doflow_device=${result.token}`, bearer: `Bearer ${result.token}`, digest: sha256Hex(result.token) };
  };
  return { dir, store, auth, logs, pair };
}

/** An https server in LAN mode on 127.0.0.1 with a certificate from lan-cert.ts; `request` trusts it as its own CA. */
async function lanServer(t: any, world: { dir: string }, routes: readonly any[], webRoot: string) {
  const cert = ensureCertificate(world.dir, '127.0.0.1', Date.now());
  const app = await createServer({ webRoot, routes, mode: 'lan', host: '127.0.0.1', port: 0, addressCheck: () => null, tls: { certPath: cert.certPath, keyPath: cert.keyPath } });
  t.after(() => app.close());
  const ca = fs.readFileSync(cert.certPath);
  const request = (method: string, target: string, options: { headers?: Record<string, string>, body?: string } = {}): Promise<Reply> => new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${app.port}`, ...(options.headers ?? {}) };
    if (options.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(options.body));
    const req = https.request({ host: '127.0.0.1', port: app.port, method, path: target, ca, headers, agent: false, servername: '' }, (res: any) => {
      const chunks: any[] = [];
      res.on('data', (chunk: any) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
  return { app, cert, request, origin: app.origin };
}

/** A paired `scope` device's view of `routes` (built over the LAN auth) on an https LAN server: `json(target)` is one cookie GET parsed. */
async function deviceClient(t: any, buildRoutes: (auth: any) => readonly any[], webRoot: string, scope: 'view' | 'control' = 'view') {
  const world = lanWorld(t);
  const server = await lanServer(t, world, buildRoutes(world.auth), webRoot);
  const { cookie } = await world.pair(scope);
  const get = (target: string) => server.request('GET', target, { headers: { Cookie: cookie } });
  const json = async (target: string) => {
    const reply = await get(target);
    return { status: reply.status, body: JSON.parse(reply.body), text: reply.body };
  };
  return { ...server, world, get, json };
}

module.exports = { lanWorld, lanServer, deviceClient };
