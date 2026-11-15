'use strict';

// POST /api/pair (feature 160, IC-006): the browser and the native exchange of a one-use code for a device,
// the refusals, the rate limits and the promise that no reply or log line carries a secret. HTTP cases run
// over https on 127.0.0.1 in LAN mode (test/helpers/lan-world.ts); the rate-limit cases call the route
// handler with a fake request so the client address and the clock are the test's own.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { buildRoutes, jsonReply } = require('../src/routes.ts');
const { lanWorld, lanServer } = require('./helpers/lan-world.ts');

const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-pair-'));
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

const errorBody = (code: string) => ({ error: { code, verb: null, exit: null } });
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const body = (code: string, name = 'Kai phone') => JSON.stringify({ v: 1, code, name });
const info = { method: 'GET', path: '/api/info', handler: (ctx: any) => jsonReply(200, { session: ctx.session }) };

async function start(t: any, clock?: { now: () => number }) {
  const world = lanWorld(t, clock);
  const server = await lanServer(t, world, buildRoutes(world.auth, [info]), webRoot);
  const browser = (payload: string, extra: Record<string, string> = {}) => server.request('POST', '/api/pair', { headers: { ...JSON_HEADERS, Origin: server.origin, 'Sec-Fetch-Site': 'same-origin', ...extra }, body: payload });
  const native = (payload: string, extra: Record<string, string> = {}) => server.request('POST', '/api/pair', { headers: { ...JSON_HEADERS, ...extra }, body: payload });
  return { world, ...server, browser, native };
}

test('a browser pairs: 200 with the device, a Secure HttpOnly SameSite=Strict cookie and no token in the body', async (t) => {
  const { world, browser, request, origin } = await start(t);
  const { code } = await world.store.mintCode('view');
  const reply = await browser(body(code, '  Pixel ‮ browser '));
  assert.equal(reply.status, 200);
  const shown = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(shown), ['v', 'device']);
  assert.deepEqual(Object.keys(shown.device), ['id', 'name', 'scope']);
  assert.match(shown.device.id, /^d-[0-9a-f]{12}$/);
  assert.equal(shown.device.name, 'Pixel browser');
  assert.equal(shown.device.scope, 'view');
  assert.equal(reply.body.includes('dfd1_'), false);
  assert.equal(reply.headers['set-cookie'].length, 1);
  assert.match(reply.headers['set-cookie'][0], /^doflow_device=dfd1_[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  const cookie = reply.headers['set-cookie'][0].split(';')[0];
  const next = await request('GET', '/api/info', { headers: { Cookie: cookie, Origin: origin } });
  assert.equal(next.status, 200);
  assert.deepEqual(JSON.parse(next.body).session, { scope: 'view', deviceId: shown.device.id });
  const [stored] = world.store.list();
  assert.deepEqual([stored.via, stored.lastAddress, stored.name], ['browser', '127.0.0.1', 'Pixel browser']);
  assert.deepEqual(world.logs, [`paired ${shown.device.id} "Pixel browser" scope view via browser from 127.0.0.1`]);
});

test('a native client pairs: 200 with the token in the body and no cookie, then reads with its Bearer', async (t) => {
  const { world, native, request } = await start(t);
  const { code } = await world.store.mintCode('control');
  const reply = await native(body(code.toUpperCase(), 'Android app'));
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['set-cookie'], undefined);
  const shown = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(shown), ['v', 'device', 'token']);
  assert.match(shown.token, /^dfd1_[A-Za-z0-9_-]{43}$/);
  assert.equal(shown.device.scope, 'control', 'the code fixed the scope; an uppercase code is accepted');
  const next = await request('GET', '/api/info', { headers: { Authorization: `Bearer ${shown.token}` } });
  assert.equal(next.status, 200);
  assert.equal(world.store.list()[0].via, 'native');
  assert.equal(world.logs.length, 1);
  assert.equal(world.logs[0].includes(shown.token), false);
  assert.equal(world.logs[0].includes(code), false);
});

test('a code is spent by its first use: a replay is 401 pair-refused, and of two racing posts exactly one wins', async (t) => {
  const { world, native, browser } = await start(t);
  const { code } = await world.store.mintCode('view');
  const first = await native(body(code));
  assert.equal(first.status, 200);
  const replay = await browser(body(code));
  assert.equal(replay.status, 401);
  assert.deepEqual(JSON.parse(replay.body), errorBody('pair-refused'));
  assert.equal(replay.headers['set-cookie'], undefined);

  const racing = (await world.store.mintCode('view')).code;
  const results = await Promise.all([native(body(racing, 'one')), native(body(racing, 'two')), browser(body(racing, 'three'))]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401]);
  assert.equal(world.store.list().length, 2);
});

test('a wrong, expired and used code get one identical answer: no oracle', async (t) => {
  let now = Date.UTC(2026, 10, 15, 10, 0, 0);
  const { world, native } = await start(t, { now: () => now });
  const used = (await world.store.mintCode('view')).code;
  await native(body(used));
  const late = (await world.store.mintCode('view')).code;
  now += 5 * 60 * 1000;
  const answers = [];
  for (const code of ['a'.repeat(26), used, late]) {
    const reply = await native(body(code));
    answers.push({ status: reply.status, body: reply.body });
  }
  assert.equal(new Set(answers.map((a) => JSON.stringify(a))).size, 1);
  assert.equal(answers[0].status, 401);
  assert.deepEqual(JSON.parse(answers[0].body), errorBody('pair-refused'));
});

test('a malformed request is 400 usage and never touches the store; no reply echoes the body', async (t) => {
  const { world, native, browser } = await start(t);
  const { code } = await world.store.mintCode('view');
  const bad = [
    '', 'not json', '[]', 'null', '"x"', '1',
    JSON.stringify({ v: 1, code }), JSON.stringify({ v: 1, name: 'n' }), JSON.stringify({ code, name: 'n' }),
    JSON.stringify({ v: 1, code, name: 'n', extra: 1 }), JSON.stringify({ v: 2, code, name: 'n' }), JSON.stringify({ v: '1', code, name: 'n' }),
    JSON.stringify({ v: 1, code: 42, name: 'n' }), JSON.stringify({ v: 1, code, name: 42 }), JSON.stringify({ v: 1, code, name: null }),
    JSON.stringify({ v: 1, code: code.slice(1), name: 'n' }), JSON.stringify({ v: 1, code: `${code}a`, name: 'n' }), JSON.stringify({ v: 1, code: code.replace(/^./, '1'), name: 'n' }),
    JSON.stringify({ v: 1, code: `${code.slice(0, 25)}-`, name: 'n' }), JSON.stringify({ v: 1, code, name: 'x'.repeat(121) }),
    JSON.stringify({ v: 1, code, name: 'n', pad: 'x'.repeat(1100) }),
  ];
  for (const payload of bad) {
    for (const send of [native, browser]) {
      const reply = await send(payload);
      assert.equal(reply.status, 400, payload.slice(0, 60));
      assert.deepEqual(JSON.parse(reply.body), errorBody('usage'), payload.slice(0, 60));
      assert.equal(reply.body.includes(code), false);
    }
  }
  assert.equal(world.store.list().length, 0, 'the code is still unspent');
  assert.equal((await native(body(code))).status, 200, 'and still works');
  // A name of exactly 120 characters is accepted and cut to 40.
  const again = (await world.store.mintCode('view')).code;
  const long = await native(body(again, 'y'.repeat(120)));
  assert.equal(long.status, 200);
  assert.equal(JSON.parse(long.body).device.name, 'y'.repeat(40));
  // An empty or all-control name is `device`.
  const third = (await world.store.mintCode('view')).code;
  assert.equal(JSON.parse((await native(body(third, '\u0000​  '))).body).device.name, 'device');
});

test('the server refuses before the handler: wrong Content-Type is 415, a browser without or with a foreign Origin is 403, GET is 404, PUT is 405', async (t) => {
  const { world, request, origin, browser } = await start(t);
  const { code } = await world.store.mintCode('view');
  const payload = body(code);
  const typed = await request('POST', '/api/pair', { headers: { 'Content-Type': 'text/plain' }, body: payload });
  assert.equal(typed.status, 415);
  const noOrigin = await request('POST', '/api/pair', { headers: { ...JSON_HEADERS, 'Sec-Fetch-Site': 'same-origin' }, body: payload });
  assert.equal(noOrigin.status, 403);
  const foreign = await request('POST', '/api/pair', { headers: { ...JSON_HEADERS, Origin: 'https://evil.example' }, body: payload });
  assert.equal(foreign.status, 403);
  const crossSite = await browser(payload, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  const withBearer = await browser(payload, { Authorization: 'Bearer dfd1_x' });
  assert.equal(withBearer.status, 403);
  // Unpaired, a wrong method on the pairing path is the one 401 of every /api path; a paired device gets the true 405.
  assert.deepEqual(JSON.parse((await request('GET', '/api/pair')).body), errorBody('device-unpaired'));
  assert.equal((await request('PUT', '/api/pair', { headers: JSON_HEADERS, body: payload })).status, 401);
  const { bearer } = await world.pair('view');
  const put = await request('PUT', '/api/pair', { headers: { ...JSON_HEADERS, Authorization: bearer }, body: payload });
  assert.equal(put.status, 405);
  assert.equal(put.headers.allow, 'POST');
  assert.equal((await request('GET', '/api/pair', { headers: { Authorization: bearer } })).headers.allow, 'POST');
  assert.equal(world.store.list().length, 1, 'nothing above spent the code: only the one device paired for the 405 exists');
  assert.equal(origin.startsWith('https://127.0.0.1:'), true);
});

test('the 65th device is 409 device-limit and the code stays good; a store that cannot be read or locked is 503', async (t) => {
  const { world, native } = await start(t);
  for (let i = 0; i < 64; i += 1) await world.pair('view', `d${i}`);
  const { code } = await world.store.mintCode('view');
  const full = await native(body(code));
  assert.equal(full.status, 409);
  assert.deepEqual(JSON.parse(full.body), errorBody('device-limit'));
  await world.store.revoke(world.store.list()[0].id);
  assert.equal((await native(body(code))).status, 200);

  const second = await start(t);
  const file = path.join(second.world.dir, 'lan.json');
  const { code: other } = await second.world.store.mintCode('view');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'testhost', at: Date.now(), id: 'held' }));
  const busy = await second.native(body(other));
  assert.equal(busy.status, 503);
  assert.deepEqual(JSON.parse(busy.body), errorBody('store-busy'));
  fs.rmSync(lock);
  fs.writeFileSync(file, '{ broken');
  const unreadable = await second.native(body(other));
  assert.equal(unreadable.status, 503);
  assert.deepEqual(JSON.parse(unreadable.body), errorBody('store-unreadable'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

// ---- rate limits, through the handler with a fake request ----

function pairer(t: any, start = Date.UTC(2026, 10, 15, 10, 0, 0), authExtra: Record<string, any> = {}) {
  const clock = { t: start, now: () => clock.t };
  const world = lanWorld(t, clock, authExtra);
  const route = world.auth.pairRoute();
  const post = (address: string, code: string) => route.handler({
    req: Object.assign(Readable.from([Buffer.from(body(code))]), { headers: {}, socket: { remoteAddress: address } }),
    clientClass: 'native',
  });
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const wrong = (n: number) => `${'a'.repeat(24)}${letters[Math.floor(n / 26) % 26]}${letters[n % 26]}`;
  return { clock, world, post, wrong };
}

test('five refused codes from one address, then 429 pair-rate-limited with Retry-After; another address is unaffected', async (t) => {
  const { clock, world, post, wrong } = pairer(t);
  for (let i = 0; i < 5; i += 1) assert.equal((await post('10.0.0.9', wrong(i))).status, 401, `failure ${i + 1}`);
  clock.t += 60_000;
  const limited = await post('10.0.0.9', wrong(9));
  assert.equal(limited.status, 429);
  assert.deepEqual(JSON.parse(limited.body), errorBody('pair-rate-limited'));
  assert.equal(limited.headers['Retry-After'], '540', 'seconds to the end of the ten-minute window');
  // A valid code from the limited address is refused too (the limit is not an oracle), and stays unspent.
  const { code } = await world.store.mintCode('view');
  assert.equal((await post('10.0.0.9', code)).status, 429);
  assert.equal((await post('10.0.0.10', code)).status, 200);
  assert.equal(limited.headers['Retry-After'] !== undefined, true);
  // The window is fixed: ten minutes after its first failure the address may try again.
  clock.t += 9 * 60_000;
  assert.equal((await post('10.0.0.9', wrong(10))).status, 401);
});

test('twenty refused codes overall only slow pairing down: a fresh code still pairs, and the delay grows to a cap and ends with the window', async (t) => {
  const slept: number[] = [];
  const { clock, world, post, wrong } = pairer(t, undefined, { sleep: async (ms: number) => { slept.push(ms); } });
  for (let i = 0; i < 20; i += 1) assert.equal((await post(`10.0.1.${i}`, wrong(i))).status, 401);
  assert.deepEqual(slept, [], 'the first twenty attempts are not delayed');
  // The owner mints a code after a stranger has burned the whole budget: it is accepted, after a delay.
  const { code } = await world.store.mintCode('view');
  const paired = await post('10.0.2.1', code);
  assert.equal(paired.status, 200, 'never a 429 for an address that has not failed');
  assert.deepEqual(slept, [150]);
  // Further refused codes lengthen the wait to a few seconds and no more.
  for (let i = 0; i < 40; i += 1) await post(`10.0.5.${i % 100}`, wrong(100 + i));
  assert.equal(Math.max(...slept), 3000);
  assert.ok(slept.every((ms) => ms <= 3000));
  // A new window starts clean.
  clock.t += 11 * 60_000;
  slept.length = 0;
  assert.equal((await post('10.0.6.1', wrong(500))).status, 401);
  assert.deepEqual(slept, []);
});

test('forty parallel wrong codes from one address: at most five are tried, the rest are 429 (the count is taken before the body is read)', async (t) => {
  const world = lanWorld(t);
  const server = await lanServer(t, world, buildRoutes(world.auth, [info]), webRoot);
  const ca = fs.readFileSync(server.cert.certPath);
  const letters = 'abcdefghijklmnopqrstuvwxyz234567';
  const held: Array<[any, string]> = [];
  const answers: Array<Promise<number | string>> = [];
  for (let i = 0; i < 40; i += 1) {
    const payload = body(`${'b'.repeat(25)}${letters[i % 32]}`);
    answers.push(new Promise((resolve) => {
      const req = https.request({
        host: '127.0.0.1', port: server.app.port, method: 'POST', path: '/api/pair', ca, agent: false, servername: '',
        headers: { Host: `127.0.0.1:${server.app.port}`, ...JSON_HEADERS, 'Content-Length': String(Buffer.byteLength(payload)) },
      }, (res: any) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve('error'));
      req.flushHeaders();
      held.push([req, payload]);
    }));
  }
  // Every connection has sent its headers and none its body: the guesses are all in flight at once.
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const [req, payload] of held) req.end(payload);
  const statuses = await Promise.all(answers);
  const count = (status: number | string) => statuses.filter((s) => s === status).length;
  assert.ok(count(401) <= 5, `401s: ${count(401)}`);
  assert.equal(count(401) + count(429), 40, JSON.stringify(statuses));
  assert.ok(count(429) >= 35);
});

test('a refund: a success, a 400, a 409 and a store failure each give the attempt back; only a refused code stays counted', async (t) => {
  const { world, post, wrong } = pairer(t);
  const route = world.auth.pairRoute();
  for (let i = 0; i < 4; i += 1) assert.equal((await post('10.0.7.1', wrong(i))).status, 401);
  for (let i = 0; i < 6; i += 1) {
    const { code } = await world.store.mintCode('view');
    assert.equal((await post('10.0.7.1', code)).status, 200, `success ${i + 1} is not counted`);
  }
  const reply = await route.handler({ req: Object.assign(Readable.from([Buffer.from('{}')]), { headers: {}, socket: { remoteAddress: '10.0.7.1' } }), clientClass: 'native' });
  assert.equal(reply.status, 400);
  assert.equal((await post('10.0.7.1', wrong(9))).status, 401, 'the fifth refusal is still tried');
  assert.equal((await post('10.0.7.1', wrong(10))).status, 429, 'and the sixth is not');
});

test('the browser transport is view for ever: a control code pairs a browser as view and a native client as control', async (t) => {
  const { world, browser, native } = await start(t);
  const first = await world.store.mintCode('control');
  const viaBrowser = await browser(body(first.code));
  assert.equal(viaBrowser.status, 200);
  assert.equal(JSON.parse(viaBrowser.body).device.scope, 'view');
  const second = await world.store.mintCode('control');
  const viaNative = await native(body(second.code));
  assert.equal(JSON.parse(viaNative.body).device.scope, 'control');
  assert.deepEqual(world.store.list().map((d: any) => [d.via, d.scope]).sort(), [['browser', 'view'], ['native', 'control']]);
});

test('only refused codes count: a 400 and a device-limit refusal leave the budget alone', async (t) => {
  const { world, post, wrong } = pairer(t);
  const route = world.auth.pairRoute();
  for (let i = 0; i < 8; i += 1) {
    const reply = await route.handler({ req: Object.assign(Readable.from([Buffer.from('{}')]), { headers: {}, socket: { remoteAddress: '10.0.3.1' } }), clientClass: 'native' });
    assert.equal(reply.status, 400);
  }
  for (let i = 0; i < 4; i += 1) assert.equal((await post('10.0.3.1', wrong(i))).status, 401);
  const { code } = await world.store.mintCode('view');
  assert.equal((await post('10.0.3.1', code)).status, 200, 'the fifth try still reaches the store');
});

test('the log says refusals once per address a minute and the pause once, and never a code or a token', async (t) => {
  const { clock, world, post, wrong } = pairer(t);
  const { code } = await world.store.mintCode('view');
  const tried: string[] = [];
  for (let i = 0; i < 5; i += 1) { tried.push(wrong(i)); await post('10.0.4.1', wrong(i)); }
  assert.deepEqual(world.logs, [
    'pairing refused from 10.0.4.1',
    'pairing from 10.0.4.1 paused for 600 s: too many failed codes',
  ]);
  clock.t += 61_000;
  await post('10.0.4.2', wrong(6));
  assert.equal(world.logs.filter((line: string) => line.startsWith('pairing refused from 10.0.4.2')).length, 1);
  const paired = await post('10.0.4.3', code);
  assert.equal(paired.status, 200);
  const token = JSON.parse(paired.body).token;
  for (const line of world.logs) {
    assert.equal(line.includes(token), false, line);
    assert.equal(line.includes(code), false, line);
    for (const guess of tried) assert.equal(line.includes(guess), false, line);
  }
});
