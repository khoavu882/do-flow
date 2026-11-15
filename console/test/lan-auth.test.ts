'use strict';

// The LAN boundary (feature 160, IC-005 and IC-007): in LAN mode, bound to 127.0.0.1 with the injected
// address check, a request is read as a browser (cookie) or a native client (Bearer), every /api route is
// behind the paired-device check and the one scope list, and the refusals carry their own codes. A real
// https server over a certificate from lan-cert.ts; nothing binds a LAN address.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRoutes, jsonReply, healthz, staticFallback } = require('../src/routes.ts');
const { DEVICE_ROUTES, PAIRING_ROUTES, PUBLIC_PATHS, deviceMayUse } = require('../src/scopes.ts');
const { IDLE_MS } = require('../src/lan-store.ts');
const { lanWorld, lanServer } = require('./helpers/lan-world.ts');

const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-lan-auth-'));
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

const errorBody = (code: string) => ({ error: { code, verb: null, exit: null } });
const json = (reply: { body: string }) => JSON.parse(reply.body);

// One probe per route path of the Console's table that a device is or is not meant to reach; a handler
// that runs answers 200 and names the session it was given.
const FOUR = ['/api/info', '/api/runs', '/api/runs/:slug/:taskId', '/api/workflows'];
const OTHERS = ['/api/sessions', '/api/fleet', '/api/transcript', '/api/stream', '/api/live', '/api/settings', '/api/worker-runs/:slug', '/api/doctor'];
const probe = (routePath: string) => ({ method: 'GET', path: routePath, handler: (ctx: any) => jsonReply(200, { ran: routePath, session: ctx.session }) });
const concrete = (routePath: string) => routePath.replace(':slug', 'feat-a').replace(':taskId', 'run-1').replace(':runId', 'r1');
const allProbes = () => [healthz, ...[...FOUR, ...OTHERS].map(probe), staticFallback];

async function start(t: any, clock?: { now: () => number }) {
  const world = lanWorld(t, clock);
  const server = await lanServer(t, world, buildRoutes(world.auth, allProbes()), webRoot);
  return { world, ...server };
}

test('in LAN mode on 127.0.0.1: no token is 401 device-unpaired, for a browser and for a native client', async (t) => {
  const { request, origin } = await start(t);
  for (const headers of [{}, { Origin: origin }, { 'Sec-Fetch-Site': 'same-origin' }, { Cookie: 'doflow_device=dfd1_nope' }, { Authorization: 'Bearer dfd1_nope' }, { Authorization: 'Basic abc' }]) {
    const reply = await request('GET', '/api/info', { headers });
    assert.equal(reply.status, 401, JSON.stringify(headers));
    assert.deepEqual(json(reply), errorBody('device-unpaired'), JSON.stringify(headers));
    assert.equal(reply.headers['set-cookie'], undefined, JSON.stringify(headers));
  }
});

test('an unknown but well-formed token is device-unpaired too, and no store file is created by asking', async (t) => {
  const { request, world } = await start(t);
  const token = `dfd1_${'A'.repeat(43)}`;
  assert.deepEqual(json(await request('GET', '/api/info', { headers: { Cookie: `doflow_device=${token}` } })), errorBody('device-unpaired'));
  assert.deepEqual(json(await request('GET', '/api/info', { headers: { Authorization: `Bearer ${token}` } })), errorBody('device-unpaired'));
  assert.equal(fs.existsSync(path.join(world.dir, 'lan.json')), false);
});

test('a paired device passes with its cookie (browser) and with its Bearer (native), and gets the same frozen session', async (t) => {
  const { request, world, origin } = await start(t);
  const device = await world.pair('view');
  const viaCookie = await request('GET', '/api/info', { headers: { Cookie: device.cookie, Origin: origin } });
  assert.equal(viaCookie.status, 200);
  assert.deepEqual(json(viaCookie).session, { scope: 'view', deviceId: device.device.id });
  const viaBearer = await request('GET', '/api/info', { headers: { Authorization: device.bearer } });
  assert.equal(viaBearer.status, 200);
  assert.deepEqual(json(viaBearer).session, { scope: 'view', deviceId: device.device.id });
  // A browser that sends only the cookie, with no Origin, is still a browser (the cookie makes it one).
  assert.equal((await request('GET', '/api/info', { headers: { Cookie: device.cookie } })).status, 200);
  // Cache and security headers ride on LAN replies like loopback ones.
  assert.equal(viaCookie.headers['cache-control'], 'no-store');
  assert.equal(viaCookie.headers['x-content-type-options'], 'nosniff');
});

test('a native client is read by Bearer only: its cookie is not a credential, a malformed Bearer is unpaired', async (t) => {
  const { request, world } = await start(t);
  const device = await world.pair();
  // No Origin, no Sec-Fetch-Site and a cookie that is not ours: a native client with no Bearer.
  assert.deepEqual(json(await request('GET', '/api/info', { headers: { Cookie: 'other=1' } })), errorBody('device-unpaired'));
  for (const bad of [device.token, `bearer ${device.token}`, `Bearer ${device.token.slice(1)}`, `Bearer  ${device.token}`, 'Bearer']) {
    assert.deepEqual(json(await request('GET', '/api/info', { headers: { Authorization: bad } })), errorBody('device-unpaired'), bad);
  }
});

test('a Bearer on a browser request is 403 forbidden-origin: with an Origin, a Sec-Fetch-Site or the cookie, alone or together', async (t) => {
  const { request, world, origin } = await start(t);
  const device = await world.pair();
  for (const headers of [
    { Authorization: device.bearer, Origin: origin },
    { Authorization: device.bearer, 'Sec-Fetch-Site': 'same-origin' },
    { Authorization: device.bearer, Cookie: device.cookie },
    { Authorization: device.bearer, Cookie: device.cookie, Origin: origin },
  ]) {
    const reply = await request('GET', '/api/info', { headers });
    assert.equal(reply.status, 403, JSON.stringify(Object.keys(headers)));
    assert.deepEqual(json(reply), errorBody('forbidden-origin'));
  }
  // A foreign Origin is refused whatever it carries.
  const foreign = await request('GET', '/api/info', { headers: { Cookie: device.cookie, Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.deepEqual(json(foreign), errorBody('forbidden-origin'));
});

test('a wrong Host is 421 with an empty body, before any credential is read', async (t) => {
  const { request, world, app } = await start(t);
  const device = await world.pair();
  for (const host of ['evil.example', `localhost:${app.port}`, '127.0.0.1', `127.0.0.1:${app.port + 1}`]) {
    const reply = await request('GET', '/api/info', { headers: { Host: host, Cookie: device.cookie } });
    assert.equal(reply.status, 421, host);
    assert.equal(reply.body, '', host);
  }
});

test('a revoked device is 401 device-revoked, and its browser gets a clearing cookie; a native client does not', async (t) => {
  const { request, world, origin } = await start(t);
  const device = await world.pair();
  assert.equal((await request('GET', '/api/info', { headers: { Cookie: device.cookie } })).status, 200);
  assert.equal(await world.store.revoke(device.device.id), 'revoked');
  const browser = await request('GET', '/api/info', { headers: { Cookie: device.cookie, Origin: origin } });
  assert.equal(browser.status, 401);
  assert.deepEqual(json(browser), errorBody('device-revoked'));
  assert.deepEqual(browser.headers['set-cookie'], ['doflow_device=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0']);
  const native = await request('GET', '/api/info', { headers: { Authorization: device.bearer } });
  assert.equal(native.status, 401);
  assert.deepEqual(json(native), errorBody('device-revoked'));
  assert.equal(native.headers['set-cookie'], undefined);
  assert.deepEqual(world.logs, [`device ${device.device.id} refused: revoked`], 'said once per device per process');
});

test('a device idle for more than 30 days is 401 device-expired with a clearing cookie', async (t) => {
  let now = Date.UTC(2026, 10, 15, 10, 0, 0);
  const { request, world } = await start(t, { now: () => now });
  const device = await world.pair();
  now += IDLE_MS + 1;
  const reply = await request('GET', '/api/info', { headers: { Cookie: device.cookie } });
  assert.equal(reply.status, 401);
  assert.deepEqual(json(reply), errorBody('device-expired'));
  assert.match(reply.headers['set-cookie'][0], /^doflow_device=; .*Max-Age=0$/);
  assert.deepEqual(world.logs, [`device ${device.device.id} refused: expired`]);
});

test('a revoke by another process is seen on the next request with no restart', async (t) => {
  const { request, world } = await start(t);
  const device = await world.pair();
  assert.equal((await request('GET', '/api/info', { headers: { Authorization: device.bearer } })).status, 200);
  // Another process's store instance over the same dir.
  const { createLanStore } = require('../src/lan-store.ts');
  assert.equal(await createLanStore({ dir: world.dir }).revoke(device.device.id), 'revoked');
  assert.deepEqual(json(await request('GET', '/api/info', { headers: { Authorization: device.bearer } })), errorBody('device-revoked'));
});

test('an unreadable store is 503 store-unreadable for devices, never overwritten, and heals when fixed', async (t) => {
  const { request, world } = await start(t);
  const device = await world.pair();
  const file = path.join(world.dir, 'lan.json');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ broken');
  const reply = await request('GET', '/api/info', { headers: { Authorization: device.bearer } });
  assert.equal(reply.status, 503);
  assert.deepEqual(json(reply), errorBody('store-unreadable'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
  assert.equal(world.logs.length, 1);
  assert.match(world.logs[0], /^device store unreadable: .*lan\.json/);
  fs.writeFileSync(file, good);
  assert.equal((await request('GET', '/api/info', { headers: { Authorization: device.bearer } })).status, 200);
});

test('a device passes exactly the four read routes and gets 403 phone-scope on every other /api route; control reads the same four', async (t) => {
  const { request, world } = await start(t);
  for (const scope of ['view', 'control'] as const) {
    const device = await world.pair(scope);
    for (const routePath of FOUR) {
      const reply = await request('GET', concrete(routePath), { headers: { Authorization: device.bearer } });
      assert.equal(reply.status, 200, `${scope} ${routePath}`);
      assert.equal(json(reply).session.scope, scope);
    }
    for (const routePath of OTHERS) {
      const reply = await request('GET', concrete(routePath), { headers: { Authorization: device.bearer } });
      assert.equal(reply.status, 403, `${scope} ${routePath}`);
      assert.deepEqual(json(reply), errorBody('phone-scope'), `${scope} ${routePath}`);
    }
  }
});

test('the scope list is frozen, names the four reads for both scopes, and refuses an unknown scope or a write', () => {
  assert.ok(Object.isFrozen(DEVICE_ROUTES) && Object.isFrozen(DEVICE_ROUTES.view) && Object.isFrozen(DEVICE_ROUTES.control));
  assert.deepEqual([...DEVICE_ROUTES.view].sort(), FOUR.map((p) => `GET ${p}`).sort());
  assert.deepEqual([...DEVICE_ROUTES.control], [...DEVICE_ROUTES.view]);
  assert.deepEqual([...PAIRING_ROUTES], ['POST /api/pair']);
  assert.deepEqual([...PUBLIC_PATHS], ['GET /healthz', 'GET /* (static web bundle)']);
  assert.equal(deviceMayUse('view', 'GET', '/api/info'), true);
  assert.equal(deviceMayUse('view', 'POST', '/api/info'), false);
  assert.equal(deviceMayUse('admin', 'GET', '/api/info'), false);
  assert.equal(deviceMayUse('__proto__', 'GET', '/api/info'), false);
  assert.equal(deviceMayUse('view', 'GET', '/api/sessions'), false);
});

test('the static bundle and /healthz stay public; there is no launch-code exchange in LAN mode', async (t) => {
  const { request } = await start(t);
  assert.equal((await request('GET', '/')).status, 200);
  assert.equal((await request('GET', '/index.html')).status, 200);
  assert.equal((await request('GET', '/healthz')).status, 200);
  assert.equal((await request('GET', '/api/nothing', { headers: { Authorization: 'Bearer x' } })).status, 404, 'an unknown /api path is 404, not a credential question');
  const exchange = await request('POST', '/api/session', { headers: { 'Content-Type': 'application/json' }, body: '{"code":"x"}' });
  assert.equal(exchange.status, 405);
});

test('a refreshed cookie rides on a browser reply when last-seen is written (an hour on); a native reply gets none', async (t) => {
  let now = Date.UTC(2026, 10, 15, 10, 0, 0);
  const { request, world, origin } = await start(t, { now: () => now });
  const device = await world.pair();
  const quiet = await request('GET', '/api/info', { headers: { Cookie: device.cookie, Origin: origin } });
  assert.equal(quiet.headers['set-cookie'], undefined, 'nothing written, nothing refreshed');
  now += 60 * 60 * 1000;
  const refreshed = await request('GET', '/api/info', { headers: { Cookie: device.cookie, Origin: origin } });
  assert.equal(refreshed.status, 200);
  assert.deepEqual(refreshed.headers['set-cookie'], [`doflow_device=${device.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`]);
  now += 60 * 60 * 1000;
  const native = await request('GET', '/api/info', { headers: { Authorization: device.bearer } });
  assert.equal(native.status, 200);
  assert.equal(native.headers['set-cookie'], undefined);
  assert.equal(world.store.list()[0].lastSeenAt, new Date(now).toISOString());
});

test('a failed last-seen write does not fail the request; it is said once a minute', async (t) => {
  let now = Date.UTC(2026, 10, 15, 10, 0, 0);
  const { request, world } = await start(t, { now: () => now });
  const device = await world.pair();
  now += 60 * 60 * 1000;
  const lock = path.join(world.dir, 'lan.json.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'testhost', at: Date.now(), id: 'held' }));
  assert.equal((await request('GET', '/api/info', { headers: { Authorization: device.bearer } })).status, 200);
  assert.equal((await request('GET', '/api/info', { headers: { Authorization: device.bearer } })).status, 200);
  assert.deepEqual(world.logs, ['lan entry not updated: store-busy']);
});
