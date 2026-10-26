'use strict';

// Launch code and session (feature 093, FR-003; 092 IC-011; IC-005, IC-016). The store cases run on
// an injected clock; the HTTP cases talk to a real listening server over a raw socket with a route
// table built on a fresh store, so each case owns its code and nothing depends on the process store.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createSessions, cookieName, LAUNCH_CODE_TTL_MS } = require('../src/session.ts');
const { ROUTES, buildRoutes, jsonReply } = require('../src/routes.ts');
const { createServer } = require('../src/server.ts');

const HEX64 = /^[0-9a-f]{64}$/;
const JSON_TYPE = 'application/json; charset=utf-8';
const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-session-'));
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');

after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

type Reply = { status: number, headers: Record<string, string>, body: string, head: string };

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function raw(port: number, text: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
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
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body: all.slice(split + 4), head: all.slice(0, split) });
    });
    socket.write(text, 'latin1');
  });
}

// A server over a fresh store, with one guarded probe route standing in for C.1's read routes.
async function harness(now = clock()) {
  const sessions = createSessions({ now: now.now });
  const seen: any[] = [];
  const probe = { method: 'GET', path: '/api/probe', handler: (ctx: any) => { seen.push(ctx.session); return jsonReply(200, { ok: true }); } };
  const app = await createServer({ webRoot, routes: buildRoutes(sessions, [probe, ...ROUTES.filter((route: any) => route.method === 'GET')]) });
  const own = `http://127.0.0.1:${app.port}`;
  const send = (method: string, target: string, headers: Record<string, string | null>, body = '') => {
    const all: Record<string, string | null> = { Host: `127.0.0.1:${app.port}`, Connection: 'close', ...headers };
    if (method === 'POST') all['Content-Length'] = String(Buffer.byteLength(body));
    const lines = Object.entries(all).filter(([, v]) => v !== null).map(([n, v]) => `${n}: ${v}`);
    return raw(app.port, `${method} ${target} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${body}`);
  };
  const exchange = (body: string, headers: Record<string, string | null> = {}) =>
    send('POST', '/api/session', { Origin: own, 'Content-Type': 'application/json', ...headers }, body);
  const probeWith = (cookie: string | null) => send('GET', '/api/probe', { Cookie: cookie });
  return { sessions, app, own, seen, send, exchange, probeWith, name: cookieName(app.port) };
}

function assertError(reply: Reply, status: number, code: string): void {
  assert.equal(reply.status, status);
  assert.equal(reply.headers['content-type'], JSON_TYPE);
  assert.deepEqual(JSON.parse(reply.body), { error: { code, verb: null, exit: null } });
}

function cookieValue(reply: Reply, name: string): string {
  const match = new RegExp(`^${name}=([0-9a-f]{64}); `).exec(reply.headers['set-cookie'] ?? '');
  if (!match) throw new assert.AssertionError({ message: `Set-Cookie ${reply.headers['set-cookie']}` });
  return match[1];
}

test('launch code: 32 random bytes as 64 lowercase hex chars, one per store, different per store', () => {
  const a = createSessions({ now: clock().now });
  const code = a.mintLaunchCode();
  assert.match(code, HEX64);
  assert.throws(() => a.mintLaunchCode(), /once/);
  assert.notEqual(createSessions({ now: clock().now }).mintLaunchCode(), code);
  assert.equal(LAUNCH_CODE_TTL_MS, 5 * 60 * 1000);
});

test('launch code: single use; the second exchange of the same code is refused', () => {
  const store = createSessions({ now: clock().now });
  const code = store.mintLaunchCode();
  const token = store.exchange(code);
  assert.match(token, HEX64);
  assert.notEqual(token, code);
  assert.equal(store.exchange(code), null, 'reuse');
  assert.deepEqual(store.verify(token), { scope: 'read' }, 'the first session survives the refused reuse');
});

test('launch code: valid for 5 min on the injected clock, refused from 5 min on', () => {
  const early = clock();
  const fresh = createSessions({ now: early.now });
  const ok = fresh.mintLaunchCode();
  early.advance(LAUNCH_CODE_TTL_MS - 1);
  assert.match(fresh.exchange(ok), HEX64);

  const late = clock();
  const stale = createSessions({ now: late.now });
  const old = stale.mintLaunchCode();
  late.advance(LAUNCH_CODE_TTL_MS);
  assert.equal(stale.exchange(old), null, 'at 5 min');
  late.advance(-LAUNCH_CODE_TTL_MS);
  assert.equal(stale.exchange(old), null, 'an expired code stays dead even if the clock steps back');
});

test('launch code: a wrong code is refused and leaves the right one usable', () => {
  const store = createSessions({ now: clock().now });
  const code = store.mintLaunchCode();
  const flipped = (code[0] === 'a' ? 'b' : 'a') + code.slice(1);
  for (const guess of [flipped, code.toUpperCase(), code.slice(0, 63), code + '0', '', 'x'.repeat(4096)]) {
    assert.equal(store.exchange(guess), null, `guess of length ${guess.length}`);
  }
  assert.match(store.exchange(code), HEX64);
});

test('launch code: right, wrong, wrong-length, consumed and unminted codes all take one timingSafeEqual on equal-length buffers', () => {
  const original = crypto.timingSafeEqual;
  const calls: number[][] = [];
  crypto.timingSafeEqual = (a: any, b: any) => { calls.push([a.length, b.length]); return original(a, b); };
  try {
    const unminted = createSessions({ now: clock().now });
    const store = createSessions({ now: clock().now });
    const code = store.mintLaunchCode();
    const guesses: [any, string][] = [
      [unminted, code], [store, code.slice(1)], [store, code + 'ff'], [store, ''], [store, 'z'.repeat(64)],
      [store, code], [store, code],
    ];
    for (const [target, guess] of guesses) {
      const before = calls.length;
      target.exchange(guess);
      assert.equal(calls.length, before + 1, `one compare for a guess of length ${guess.length}`);
      const [a, b] = calls[calls.length - 1];
      assert.ok(a === b && a > 0, `equal-length buffers (${a}, ${b})`);
    }
  } finally {
    crypto.timingSafeEqual = original;
  }
});

test('session: the token is 256-bit hex, scope read, and an unknown or malformed token is refused', () => {
  const store = createSessions({ now: clock().now });
  const token = store.exchange(store.mintLaunchCode());
  assert.deepEqual(store.verify(token), { scope: 'read' });
  for (const bad of [null, undefined, '', token.slice(1), token.toUpperCase(), crypto.randomBytes(32).toString('hex')]) {
    assert.equal(store.verify(bad), null, String(bad));
  }
});

test('exchange: POST /api/session sets doflow_ui_<port> HttpOnly, SameSite=Strict, Path=/ with no lifetime, and the cookie opens /api/*', async () => {
  const h = await harness();
  try {
    const code = h.sessions.mintLaunchCode();
    const reply = await h.exchange(JSON.stringify({ code }));
    assert.equal(reply.status, 204);
    assert.equal(reply.body, '');
    const token = cookieValue(reply, h.name);
    assert.equal(reply.headers['set-cookie'], `${h.name}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.doesNotMatch(reply.headers['set-cookie'], /max-age|expires|domain/i);

    const ok = await h.probeWith(`other=1; ${h.name}=${token}; doflow_ui_1=x`);
    assert.equal(ok.status, 200);
    assert.deepEqual(h.seen, [{ scope: 'read' }]);

    assertError(await h.exchange(JSON.stringify({ code })), 401, 'unauthenticated');
  } finally {
    await h.app.close();
  }
});

test('session check: /api/* without a valid cookie is 401 unauthenticated, and the handler never runs', async () => {
  const h = await harness();
  try {
    const token = h.sessions.exchange(h.sessions.mintLaunchCode());
    const refused = [
      null, '', `${h.name}=`, `${h.name}=${token.slice(1)}`, `${h.name}=${crypto.randomBytes(32).toString('hex')}`,
      `doflow_ui_${h.app.port + 1}=${token}`, `x${h.name}=${token}`, `${h.name}x=${token}`,
    ];
    for (const cookie of refused) assertError(await h.probeWith(cookie), 401, 'unauthenticated');
    assert.equal(h.seen.length, 0);
    assert.equal((await h.probeWith(`${h.name}=${token}`)).status, 200);
    assert.equal((await h.send('GET', '/healthz', {})).status, 200, '/healthz needs no session');
    assert.equal((await h.send('GET', '/', {})).status, 200, 'static needs no session');
  } finally {
    await h.app.close();
  }
});

test('exchange: wrong content type 415, cross-site or foreign origin 403, and none of them spends the code', async () => {
  const h = await harness();
  try {
    const code = h.sessions.mintLaunchCode();
    const body = JSON.stringify({ code });
    for (const type of [null, 'text/plain', 'application/json; charset=utf-8', 'application/x-www-form-urlencoded']) {
      assertError(await h.exchange(body, { 'Content-Type': type }), 415, 'unsupported-media');
    }
    for (const site of ['cross-site', 'same-site', 'none']) {
      assertError(await h.exchange(body, { 'Sec-Fetch-Site': site }), 403, 'forbidden-origin');
    }
    for (const origin of [null, 'null', 'http://evil.test']) {
      assertError(await h.exchange(body, { Origin: origin }), 403, 'forbidden-origin');
    }
    assert.equal((await h.exchange(body, { 'Sec-Fetch-Site': 'same-origin' })).status, 204);
  } finally {
    await h.app.close();
  }
});

test('exchange: a malformed body is 400 usage and a wrong code 401, both leaving the code usable', async () => {
  const h = await harness();
  try {
    const code = h.sessions.mintLaunchCode();
    for (const body of ['', 'not json', '"x"', 'null', '[]', '{}', '{"code":1}', '{"code":null}', JSON.stringify({ code: 'a'.repeat(5000) })]) {
      assertError(await h.exchange(body), 400, 'usage');
    }
    for (const guess of ['0'.repeat(64), code.slice(2), 'x']) {
      assertError(await h.exchange(JSON.stringify({ code: guess })), 401, 'unauthenticated');
    }
    assert.equal((await h.exchange(JSON.stringify({ code }))).status, 204);
  } finally {
    await h.app.close();
  }
});

test('exchange: an expired code is 401 over HTTP', async () => {
  const now = clock();
  const h = await harness(now);
  try {
    const code = h.sessions.mintLaunchCode();
    now.advance(LAUNCH_CODE_TTL_MS);
    assertError(await h.exchange(JSON.stringify({ code })), 401, 'unauthenticated');
  } finally {
    await h.app.close();
  }
});

test('the code never reaches a log line, a response header or a response body', async () => {
  const h = await harness();
  const written: string[] = [];
  const streams = [process.stdout, process.stderr];
  const writes = streams.map((stream: any) => stream.write);
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const consoles = methods.map((name) => (console as any)[name]);
  streams.forEach((stream: any, index: number) => {
    stream.write = (chunk: any, ...rest: any[]) => { written.push(String(chunk)); return writes[index].call(stream, chunk, ...rest); };
  });
  methods.forEach((name) => { (console as any)[name] = (...args: any[]) => { written.push(args.map(String).join(' ')); }; });
  const replies: Reply[] = [];
  let code = '';
  try {
    code = h.sessions.mintLaunchCode();
    const body = JSON.stringify({ code });
    replies.push(await h.exchange(body, { 'Content-Type': 'text/plain' }));
    replies.push(await h.exchange(body, { 'Sec-Fetch-Site': 'cross-site' }));
    replies.push(await h.exchange(JSON.stringify({ code: code.slice(1) })));
    replies.push(await h.exchange(body));
    replies.push(await h.exchange(body));
    replies.push(await h.probeWith(`${h.name}=${code}`));
    replies.push(await h.exchange(`{"code":"${code}",`));
  } finally {
    streams.forEach((stream: any, index: number) => { stream.write = writes[index]; });
    methods.forEach((name, index) => { (console as any)[name] = consoles[index]; });
    await h.app.close();
  }
  assert.match(code, HEX64);
  assert.equal(replies.length, 7);
  for (const reply of replies) assert.ok(!reply.head.includes(code) && !reply.body.includes(code), `code leaked in a ${reply.status}`);
  for (const line of written) assert.ok(!line.includes(code), 'code leaked in an output line');
});

test('process table: ROUTES carries the one non-GET route POST /api/session and guards every other /api route', async () => {
  const writes = ROUTES.filter((route: any) => route.method !== 'GET').map((route: any) => `${route.method} ${route.path}`);
  assert.deepEqual(writes, ['POST /api/session']);
  assert.ok(Object.isFrozen(ROUTES) && ROUTES.every((route: any) => Object.isFrozen(route)));
  const app = await createServer({ webRoot });
  try {
    const reply = await raw(app.port, `POST /api/session HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\nOrigin: http://127.0.0.1:${app.port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
    assertError(reply, 400, 'usage');
  } finally {
    await app.close();
  }
});
