'use strict';

// Console HTTP boundary (feature 093, C2; IC-005, IC-006; 092 IC-010). Every case talks to a real
// listening server over a raw socket, so the request line and headers reach the server byte for byte
// (no client normalises `..`, sets Host, or drops a NUL). The web root is a temp directory built per
// run, so symlinks and dotfiles exist without being committed and console/web/ is not needed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { createServer } = require('../src/server.ts');
const { ROUTES } = require('../src/routes.ts');

// Pinned here, not imported: the test is the contract's copy (092 IC-010).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; "
  + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const BASE_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
const JSON_TYPE = 'application/json; charset=utf-8';
// Headers whose value depends on the clock, the connection or the body length.
const VOLATILE = new Set(['date', 'connection', 'keep-alive', 'content-length', 'transfer-encoding']);

type Reply = { status: number, headers: Record<string, string>, body: string };

let tmp: string;
let webRoot: string;
let app: any;
let port: number;

function buildWebRoot(): void {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-server-'));
  webRoot = path.join(tmp, 'web');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(webRoot, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(webRoot, '.hidden'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(webRoot, 'app.js'), 'export {};\n');
  fs.writeFileSync(path.join(webRoot, 'app.css'), 'body{}\n');
  fs.writeFileSync(path.join(webRoot, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(webRoot, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(webRoot, 'font.woff2'), 'wOF2');
  fs.writeFileSync(path.join(webRoot, 'notes.txt'), 'not served');
  fs.writeFileSync(path.join(webRoot, 'data.json'), '{}');
  fs.writeFileSync(path.join(webRoot, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(webRoot, '.hidden', 'app.js'), 'hidden');
  fs.writeFileSync(path.join(webRoot, 'sub', 'ok.js'), 'ok');
  fs.writeFileSync(path.join(outside, 'secret.js'), 'secret');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"secret":true}');
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(webRoot, 'link.js'));
  fs.symlinkSync(path.join(webRoot, 'app.js'), path.join(webRoot, 'inside-link.js'));
  fs.symlinkSync(outside, path.join(webRoot, 'linkdir'));
}

function raw(text: string, targetPort = port): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(targetPort, '127.0.0.1');
    const chunks: any[] = [];
    socket.on('data', (chunk: any) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const all = Buffer.concat(chunks).toString('latin1');
      const split = all.indexOf('\r\n\r\n');
      if (split < 0) return reject(new Error(`no response head in ${JSON.stringify(all)}`));
      const [statusLine, ...lines] = all.slice(0, split).split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body: all.slice(split + 4) });
    });
    socket.write(text, 'latin1');
  });
}

function request(method: string, target: string, headers: Record<string, string | null> = {}, body = ''): Promise<Reply> {
  const all: Record<string, string | null> = { Host: `127.0.0.1:${port}`, Connection: 'close', ...headers };
  if (body) all['Content-Length'] = String(Buffer.byteLength(body));
  const lines = Object.entries(all).filter(([, value]) => value !== null).map(([name, value]) => `${name}: ${value}`);
  return raw(`${method} ${target} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${body}`);
}

const get = (target: string, headers: Record<string, string | null> = {}) => request('GET', target, headers);

function snapshot(reply: Reply): Record<string, string> {
  return Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !VOLATILE.has(name)));
}

function assertError(reply: Reply, status: number, code: string): void {
  assert.equal(reply.status, status);
  assert.equal(reply.headers['content-type'], JSON_TYPE);
  assert.deepEqual(JSON.parse(reply.body), { error: { code, verb: null, exit: null } });
}

before(async () => {
  buildWebRoot();
  app = await createServer({ webRoot });
  port = app.port;
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('bind: listens on the literal 127.0.0.1, on an OS-picked port by default', () => {
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.ok(port > 0);
});

test('bind: every host other than the literal 127.0.0.1 is refused before anything listens', async () => {
  const original = http.createServer;
  let created = 0;
  http.createServer = (...args: any[]) => { created += 1; return original(...args); };
  try {
    for (const host of ['0.0.0.0', '::', '::1', 'localhost', '127.0.0.2', '192.168.1.10', '', ' 127.0.0.1']) {
      await assert.rejects(createServer({ webRoot, host }), /127\.0\.0\.1/, `host ${JSON.stringify(host)}`);
    }
  } finally {
    http.createServer = original;
  }
  assert.equal(created, 0, 'a refused host must not create a server');
});

test('Host: a foreign or missing Host gets 421 with an empty body on every route class', async () => {
  const badHosts: (string | null)[] = ['evil.test:' + port, `127.0.0.1:${port + 1}`, '127.0.0.1', 'localhost', `evil.test:${port}@127.0.0.1:${port}`, null];
  for (const target of ['/', '/app.js', '/healthz', '/api/x', '/nope.txt']) {
    for (const host of badHosts) {
      const reply = await get(target, { Host: host });
      assert.equal(reply.status, 421, `${target} with Host ${host}`);
      assert.equal(reply.body, '', `${target} with Host ${host}`);
    }
  }
  for (const method of ['POST', 'DELETE']) {
    assert.equal((await request(method, '/healthz', { Host: `evil.test:${port}` })).status, 421, `${method} is Host-checked first`);
  }
});

test('Host: 127.0.0.1:<port> and localhost:<port> are both accepted', async () => {
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
    const reply = await get('/healthz', { Host: host });
    assert.equal(reply.status, 200, host);
  }
});

test('healthz: {"status":"ok"} with no session', async () => {
  const reply = await get('/healthz');
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-type'], JSON_TYPE);
  assert.deepEqual(JSON.parse(reply.body), { status: 'ok' });
});

test('Origin: GET /api/* refuses Origin null and any cross origin with 403 forbidden-origin', async () => {
  for (const origin of ['null', 'http://evil.test', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`]) {
    assertError(await get('/api/x', { Origin: origin }), 403, 'forbidden-origin');
  }
});

test('Origin: GET /api/* accepts an absent or same origin (here reaching 404 not-found: no API route yet)', async () => {
  assertError(await get('/api/x'), 404, 'not-found');
  assertError(await get('/api/x', { Origin: `http://127.0.0.1:${port}` }), 404, 'not-found');
  assertError(await get('/api/x', { Origin: `http://localhost:${port}` }), 404, 'not-found');
});

test('methods: any non-GET to a path no route declares that method for is 405', async () => {
  const declared = new Set(ROUTES.map((route: any) => `${route.method} ${route.path}`));
  for (const target of ['/', '/index.html', '/app.js', '/healthz', '/api/x', '/api/session', '/missing.js']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      if (declared.has(`${method} ${target}`)) continue;
      const reply = await request(method, target, { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, method === 'POST' ? '{}' : '');
      assert.equal(reply.status, 405, `${method} ${target}`);
      assert.equal(reply.body, '', `${method} ${target}`);
      assert.equal(reply.headers.allow, target === '/api/session' ? 'POST' : 'GET', `${method} ${target}`);
    }
  }
});

test('route table: every route declares GET or POST, and the only non-GET route allowed is POST /api/session', () => {
  assert.ok(Object.isFrozen(ROUTES));
  for (const route of ROUTES) {
    assert.ok(Object.isFrozen(route));
    assert.ok(route.method === 'GET' || route.method === 'POST', `${route.method} ${route.path}`);
    assert.equal(typeof route.path, 'string');
    assert.equal(typeof route.handler, 'function');
  }
  const writes = ROUTES.filter((route: any) => route.method !== 'GET').map((route: any) => `${route.method} ${route.path}`);
  assert.ok(writes.every((entry: string) => entry === 'POST /api/session'), `non-GET routes: ${writes.join(', ')}`);
  assert.ok(writes.length <= 1);
  assert.deepEqual(ROUTES.filter((route: any) => route.method === 'GET').map((route: any) => route.path).sort(), ['/*', '/healthz']);
});

test('non-GET rules: an allowed Origin is required, Sec-Fetch-Site same-origin when sent, Content-Type exactly application/json', async () => {
  const echo = Object.freeze({ method: 'POST', path: '/api/echo', handler: () => ({ status: 200, body: '' }) });
  const local = await createServer({ webRoot, routes: Object.freeze([echo]) });
  try {
    const own = `http://127.0.0.1:${local.port}`;
    const post = (headers: Record<string, string | null>) => {
      const all: Record<string, string | null> = { Host: `127.0.0.1:${local.port}`, Connection: 'close', 'Content-Length': '2', ...headers };
      const lines = Object.entries(all).filter(([, v]) => v !== null).map(([n, v]) => `${n}: ${v}`);
      return raw(`POST /api/echo HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n{}`, local.port);
    };
    assertError(await post({ 'Content-Type': 'application/json' }), 403, 'forbidden-origin');
    assertError(await post({ Origin: 'null', 'Content-Type': 'application/json' }), 403, 'forbidden-origin');
    assertError(await post({ Origin: 'http://evil.test', 'Content-Type': 'application/json' }), 403, 'forbidden-origin');
    assertError(await post({ Origin: own, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }), 403, 'forbidden-origin');
    assertError(await post({ Origin: own, 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'application/json' }), 403, 'forbidden-origin');
    for (const type of [null, 'text/plain', 'application/json; charset=utf-8', 'application/x-www-form-urlencoded']) {
      assertError(await post({ Origin: own, 'Content-Type': type }), 415, 'unsupported-media');
    }
    assert.equal((await post({ Origin: own, 'Content-Type': 'application/json' })).status, 200);
    assert.equal((await post({ Origin: own, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' })).status, 200);
  } finally {
    await local.close();
  }
});

test('static: GET / serves index.html and each allowed extension has its fixed type', async () => {
  const cases: [string, string, string][] = [
    ['/', 'text/html; charset=utf-8', '<!doctype html><title>t</title>'],
    ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>t</title>'],
    ['/app.js', 'text/javascript; charset=utf-8', 'export {};\n'],
    ['/app.js?v=1', 'text/javascript; charset=utf-8', 'export {};\n'],
    ['/app.css', 'text/css; charset=utf-8', 'body{}\n'],
    ['/logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['/img.png', 'image/png', '\x89PNG'],
    ['/font.woff2', 'font/woff2', 'wOF2'],
    ['/sub/ok.js', 'text/javascript; charset=utf-8', 'ok'],
  ];
  for (const [target, type, body] of cases) {
    const reply = await get(target);
    assert.equal(reply.status, 200, target);
    assert.equal(reply.headers['content-type'], type, target);
    assert.equal(reply.body, body, target);
  }
});

test('static: traversal, encoded separators, NUL, dotfiles, symlinks and unknown extensions are 404', async () => {
  const targets = [
    '/../package.json', '/sub/../../package.json', '/%2e%2e/package.json', '/%2E%2E/package.json', '/.%2e/package.json',
    '/sub%2fok.js', '/sub%2Fok.js', '/sub%5cok.js', '/sub\\ok.js', '/sub/..%2f..%2fpackage.json',
    '/app.js%00', '/%00.js', '/app%00.js', '/%zz.js',
    '/.env', '/.hidden/app.js', '/sub/./ok.js', '/./app.js',
    '/link.js', '/inside-link.js', '/linkdir/secret.js',
    '/notes.txt', '/data.json', '/app.JS', '/sub', '/sub/', '//app.js', '/sub//ok.js', '/missing.js',
    `http://127.0.0.1:${port}/app.js`,
  ];
  for (const target of targets) {
    assertError(await get(target), 404, 'not-found');
  }
});

test('headers: the 092 IC-010 set on every response class (snapshot)', async () => {
  const api = { ...BASE_HEADERS, 'cache-control': 'no-store' };
  const cases: [string, Promise<Reply>, Record<string, string>][] = [
    ['static html', get('/'), { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8' }],
    ['static js', get('/app.js'), { ...BASE_HEADERS, 'content-type': 'text/javascript; charset=utf-8' }],
    ['static 404', get('/.env'), { ...BASE_HEADERS, 'content-type': JSON_TYPE }],
    ['healthz', get('/healthz'), { ...BASE_HEADERS, 'content-type': JSON_TYPE }],
    ['api 404', get('/api/x'), { ...api, 'content-type': JSON_TYPE }],
    ['api 403', get('/api/x', { Origin: 'null' }), { ...api, 'content-type': JSON_TYPE }],
    ['api 405', request('DELETE', '/api/x'), { ...api, allow: 'GET' }],
    ['static 405', request('POST', '/', {}, '{}'), { ...BASE_HEADERS, allow: 'GET' }],
    ['421 static', get('/', { Host: 'evil.test' }), { ...BASE_HEADERS }],
    ['421 api', get('/api/x', { Host: 'evil.test' }), { ...api }],
    ['400 malformed', raw('GET / HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n'), { ...BASE_HEADERS }],
  ];
  for (const [name, pending, expected] of cases) {
    const reply = await pending;
    assert.deepEqual(snapshot(reply), expected, name);
  }
});

test('handler failure: a throwing handler gives 500 with an empty body and the header set', async () => {
  const boom = Object.freeze({ method: 'GET', path: '/api/boom', handler: () => { throw new Error('/abs/path leaked?'); } });
  const local = await createServer({ webRoot, routes: Object.freeze([boom]) });
  try {
    const reply = await raw(`GET /api/boom HTTP/1.1\r\nHost: 127.0.0.1:${local.port}\r\nConnection: close\r\n\r\n`, local.port);
    assert.equal(reply.status, 500);
    assert.equal(reply.body, '');
    assert.deepEqual(snapshot(reply), { ...BASE_HEADERS, 'cache-control': 'no-store' });
  } finally {
    await local.close();
  }
});

test('reply failure: a reply Node cannot write still answers 500 instead of hanging the socket', async () => {
  const bad = Object.freeze({ method: 'GET', path: '/bad', handler: () => ({ status: 200, headers: { 'X-Bad': 'a\nb' }, body: 'x' }) });
  const local = await createServer({ webRoot, routes: Object.freeze([bad]) });
  try {
    const reply = await raw(`GET /bad HTTP/1.1\r\nHost: 127.0.0.1:${local.port}\r\nConnection: close\r\n\r\n`, local.port);
    assert.equal(reply.status, 500);
    assert.deepEqual(snapshot(reply), BASE_HEADERS);
  } finally {
    await local.close();
  }
});

test('headers: a handler cannot replace a header of the set', async () => {
  const sneaky = Object.freeze({ method: 'GET', path: '/api/sneaky', handler: () => ({ status: 200, headers: {
    'Content-Security-Policy': "default-src *", 'referrer-policy': 'unsafe-url', 'Cache-Control': 'max-age=60' }, body: '' }) });
  const local = await createServer({ webRoot, routes: Object.freeze([sneaky]) });
  try {
    const reply = await raw(`GET /api/sneaky HTTP/1.1\r\nHost: 127.0.0.1:${local.port}\r\nConnection: close\r\n\r\n`, local.port);
    assert.deepEqual(snapshot(reply), { ...BASE_HEADERS, 'cache-control': 'no-store' });
  } finally {
    await local.close();
  }
});

test('route params: a :name segment matches one non-empty raw segment', async () => {
  const echo = Object.freeze({ method: 'GET', path: '/api/runs/:slug/:taskId', handler: (ctx: any) => ({ status: 200, headers: { 'Content-Type': JSON_TYPE }, body: JSON.stringify(ctx.params) }) });
  const local = await createServer({ webRoot, routes: Object.freeze([echo]) });
  try {
    const at = (target: string) => raw(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${local.port}\r\nConnection: close\r\n\r\n`, local.port);
    assert.deepEqual(JSON.parse((await at('/api/runs/f-1/t.2')).body), { slug: 'f-1', taskId: 't.2' });
    assertError(await at('/api/runs/f-1'), 404, 'not-found');
    assertError(await at('/api/runs//t'), 404, 'not-found');
    assertError(await at('/api/runs/a/b/c'), 404, 'not-found');
  } finally {
    await local.close();
  }
});

test('options: webRoot must be an existing directory and port an integer 0..65535', async () => {
  await assert.rejects(createServer({}), /webRoot/);
  await assert.rejects(createServer({ webRoot: path.join(tmp, 'absent') }), /webRoot/);
  await assert.rejects(createServer({ webRoot: path.join(webRoot, 'app.js') }), /webRoot/);
  await assert.rejects(createServer({ webRoot, port: -1 }), /port/);
  await assert.rejects(createServer({ webRoot, port: 1.5 }), /port/);
});
