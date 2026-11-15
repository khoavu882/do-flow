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
const { buildRoutes, consoleRoutes, isApiPath, jsonReply, healthz, staticFallback } = require('../src/routes.ts');
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
// 161 IC-009 (DEC-008): the row-160 four reads, the live stream, the sessions read and the worker-run reads.
const FOUR = ['/api/info', '/api/runs', '/api/runs/:slug/:taskId', '/api/workflows'];
const ADDED_161 = ['/api/live', '/api/sessions', '/api/worker-runs/:slug', '/api/worker-runs/:slug/:runId/result', '/api/worker-runs/:slug/:runId/status',
  '/api/worker-runs/:slug/:runId/log', '/api/worker-runs/:slug/:runId/transcript'];
const READS = [...FOUR, ...ADDED_161];
// The removed Fleet paths stay refused even on a table that still had them; so does every management route.
const OTHERS = ['/api/fleet', '/api/transcript', '/api/stream', '/api/settings', '/api/sessions-history', '/api/workers', '/api/doctor', '/api/followups', '/api/added-later'];
const probe = (routePath: string) => ({ method: 'GET', path: routePath, handler: (ctx: any) => jsonReply(200, { ran: routePath, session: ctx.session }) });
const concrete = (routePath: string) => routePath.replace(':slug', 'feat-a').replace(':taskId', 'run-1').replace(':runId', 'r1');
const allProbes = () => [healthz, ...[...READS, ...OTHERS].map(probe), staticFallback];

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
  for (const bad of [device.token, `Bearer ${device.token.slice(1)}`, `Bearer  ${device.token}`, 'Bearer']) {
    assert.deepEqual(json(await request('GET', '/api/info', { headers: { Authorization: bad } })), errorBody('device-unpaired'), bad);
  }
  // The scheme name is case-insensitive (RFC 9110); the token is not.
  for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
    assert.equal((await request('GET', '/api/info', { headers: { Authorization: `${scheme} ${device.token}` } })).status, 200, scheme);
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

test('a device passes exactly the device read routes (row 160 four plus the 161 live, sessions and worker-run reads) and gets 403 phone-scope on every other /api route; control reads the same', async (t) => {
  const { request, world } = await start(t);
  for (const scope of ['view', 'control'] as const) {
    const device = await world.pair(scope);
    for (const routePath of READS) {
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

test('the REAL route table: every /api route that is not in the device list is refused for a device, whichever scope; a route added later is refused by default', async (t) => {
  const world = lanWorld(t);
  const reached: string[] = [];
  // A runner that records any call and answers core-unreachable: a refused route must never reach it.
  const runner: any = new Proxy({}, {
    get: (_target, name) => (name === 'then' ? undefined : (..._args: unknown[]) => {
      reached.push(String(name));
      return name === 'follow' ? null : Promise.resolve({ ok: false, code: 'core-unreachable', exit: null });
    }),
  });
  const table = consoleRoutes(runner, world.auth, null, { projectRoot: os.tmpdir(), home: os.tmpdir() });
  const server = await lanServer(t, world, table, webRoot);
  const apiRoutes = table.filter((route: any) => isApiPath(route.path) && route.path !== '/api/pair');
  assert.ok(apiRoutes.length >= 15, `the table has ${apiRoutes.length} /api routes`);
  assert.deepEqual(apiRoutes.filter((route: any) => route.method !== 'GET'), [], 'every /api route but the pairing exchange is a GET');
  const allowed = apiRoutes.filter((route: any) => deviceMayUse('view', route.method, route.path)).map((route: any) => route.path).sort();
  assert.deepEqual(allowed, [...READS].sort(), 'the device list names routes the table really has, and nothing else');
  const refused = apiRoutes.filter((route: any) => !deviceMayUse('view', route.method, route.path)).map((route: any) => route.path);
  for (const management of ['/api/settings', '/api/doctor', '/api/storage', '/api/workers', '/api/followups', '/api/advice', '/api/sessions-history']) {
    assert.ok(refused.includes(management), `${management} stays off the device list`);
  }
  for (const removed of ['/api/fleet', '/api/transcript', '/api/stream']) assert.equal(apiRoutes.some((route: any) => route.path === removed), false, `${removed} is gone`);
  for (const scope of ['view', 'control'] as const) {
    const device = await world.pair(scope);
    for (const route of apiRoutes) {
      if (deviceMayUse(scope, route.method, route.path)) continue;
      const reply = await server.request('GET', concrete(route.path).replace(/:[A-Za-z]+/g, 'x1'), { headers: { Authorization: device.bearer } });
      assert.equal(reply.status, 403, `${scope} ${route.path}`);
      assert.deepEqual(json(reply), errorBody('phone-scope'), `${scope} ${route.path}`);
    }
  }
  assert.deepEqual(reached, [], 'no refused route ran a verb');
  // Every listed route of the real table is reached past the device check: whatever it answers, it is not the scope refusal.
  // (`/api/live` has no hub here, so it answers 503 live-unavailable; the others answer from the unreachable core or refuse a param.)
  const view = await world.pair('view', 'Reader');
  for (const routePath of READS) {
    const reply = await server.request('GET', routePath === '/api/live' ? '/api/live?ch=now' : concrete(routePath), { headers: { Authorization: view.bearer } });
    assert.ok(![401, 403].includes(reply.status), `view ${routePath}: ${reply.status} ${reply.body}`);
    assert.notEqual(json(reply).error?.code, 'phone-scope', `view ${routePath}`);
  }
  assert.deepEqual(JSON.parse((await server.request('GET', '/api/live?ch=now', { headers: { Authorization: view.bearer } })).body), errorBody('live-unavailable'));
  // A route nobody listed in scopes.ts: the probe table adds one.
  const later = await start(t);
  const device = await later.world.pair('control');
  const reply = await later.request('GET', '/api/added-later', { headers: { Authorization: device.bearer } });
  assert.deepEqual(json(reply), errorBody('phone-scope'));
});

test('an unpaired caller gets the one 401 device-unpaired on every /api path, existing or not, and every method; a paired one gets a true 404 or 405', async (t) => {
  const { request, world, origin } = await start(t);
  const post = { 'Content-Type': 'application/json' };
  const asks: Array<[string, string, Record<string, string>]> = [
    ['GET', '/api/info', {}], ['GET', '/api/sessions', {}], ['GET', '/api/nope', {}], ['GET', '/api/nope/deeper/still', {}],
    ['POST', '/api/session', post], ['POST', '/api/info', post], ['PUT', '/api/runs', post], ['DELETE', '/api/pair', {}], ['GET', '/api/pair', {}],
    ['GET', '/api/nope', { Origin: origin }], ['POST', '/api/nope', { ...post, Origin: origin }],
  ];
  const seen = new Set<string>();
  for (const [method, target, headers] of asks) {
    const reply = await request(method, target, { headers, ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}) });
    assert.equal(reply.status, 401, `${method} ${target}`);
    assert.equal(reply.headers.allow, undefined, `${method} ${target}`);
    seen.add(reply.body);
  }
  assert.deepEqual([...seen], [JSON.stringify(errorBody('device-unpaired'))], 'one body for all of them');
  const { bearer } = await world.pair('view');
  const authed = { Authorization: bearer };
  const missing = await request('GET', '/api/nope', { headers: authed });
  assert.equal(missing.status, 404);
  const exchange = await request('POST', '/api/session', { headers: { ...post, ...authed }, body: '{"code":"x"}' });
  assert.equal(exchange.status, 404, 'there is no launch-code exchange in LAN mode');
  assert.equal(exchange.headers.allow, undefined, 'and no Allow header claims one');
  const wrongMethod = await request('PUT', '/api/runs', { headers: { ...post, ...authed }, body: '{}' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET');
});

test('in LAN mode an /api request whose Sec-Fetch-Site is anything but same-origin or none is 403, for every method and credential', async (t) => {
  const { request, world, origin } = await start(t);
  const device = await world.pair('view');
  for (const site of ['cross-site', 'same-site', 'Cross-Site', '', 'same-origin, cross-site']) {
    for (const headers of [{ Cookie: device.cookie, Origin: origin }, { Cookie: device.cookie }, {}, { Authorization: device.bearer }]) {
      const reply = await request('GET', '/api/info', { headers: { ...headers, 'Sec-Fetch-Site': site } });
      assert.equal(reply.status, 403, `${JSON.stringify(site)} ${Object.keys(headers)}`);
    }
    assert.equal((await request('POST', '/api/info', { headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': site }, body: '{}' })).status, 403, site);
  }
  for (const site of ['same-origin', 'none']) {
    assert.equal((await request('GET', '/api/info', { headers: { Cookie: device.cookie, 'Sec-Fetch-Site': site } })).status, 200, site);
  }
  assert.equal((await request('GET', '/api/info', { headers: { Cookie: device.cookie } })).status, 200, 'no header at all: not a browser that sends one');
  assert.equal((await request('GET', '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'the static bundle is not an API request');
});

test('past the certificate end date every device request and the pairing exchange are 503 cert-expired; the ask is made on each request', async (t) => {
  let state: 'ok' | 'expiring' | 'expired' = 'ok';
  const world = lanWorld(t, undefined, { certState: () => state });
  const server = await lanServer(t, world, buildRoutes(world.auth, allProbes()), webRoot);
  const device = await world.pair('view');
  const { code } = await world.store.mintCode('view');
  assert.equal((await server.request('GET', '/api/info', { headers: { Authorization: device.bearer } })).status, 200);
  state = 'expiring';
  assert.equal((await server.request('GET', '/api/info', { headers: { Authorization: device.bearer } })).status, 200, 'a warning only');
  state = 'expired';
  const refused = await server.request('GET', '/api/info', { headers: { Authorization: device.bearer } });
  assert.equal(refused.status, 503);
  assert.deepEqual(json(refused), errorBody('cert-expired'));
  const pairing = await server.request('POST', '/api/pair', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code, name: 'x' }) });
  assert.equal(pairing.status, 503);
  assert.deepEqual(json(pairing), errorBody('cert-expired'));
  assert.equal(world.store.list().length, 1, 'the code was not spent');
});

test('the scope list is frozen, names the device reads for both scopes, and refuses an unknown scope or a write', () => {
  assert.ok(Object.isFrozen(DEVICE_ROUTES) && Object.isFrozen(DEVICE_ROUTES.view) && Object.isFrozen(DEVICE_ROUTES.control));
  assert.deepEqual([...DEVICE_ROUTES.view].sort(), READS.map((p) => `GET ${p}`).sort());
  assert.deepEqual([...DEVICE_ROUTES.control], [...DEVICE_ROUTES.view]);
  assert.deepEqual([...PAIRING_ROUTES], ['POST /api/pair']);
  assert.deepEqual([...PUBLIC_PATHS], ['GET /healthz', 'GET /* (static web bundle)']);
  assert.equal(deviceMayUse('view', 'GET', '/api/info'), true);
  assert.equal(deviceMayUse('view', 'POST', '/api/info'), false);
  assert.equal(deviceMayUse('admin', 'GET', '/api/info'), false);
  assert.equal(deviceMayUse('__proto__', 'GET', '/api/info'), false);
  assert.equal(deviceMayUse('view', 'GET', '/api/sessions'), true);
  assert.equal(deviceMayUse('view', 'GET', '/api/settings'), false);
  assert.equal(deviceMayUse('view', 'GET', '/api/sessions-history'), false);
  for (const removed of ['/api/fleet', '/api/transcript', '/api/stream']) assert.equal(deviceMayUse('control', 'GET', removed), false, removed);
});

test('the static bundle and /healthz stay public; there is no launch-code exchange in LAN mode', async (t) => {
  const { request } = await start(t);
  assert.equal((await request('GET', '/')).status, 200);
  assert.equal((await request('GET', '/index.html')).status, 200);
  assert.equal((await request('GET', '/healthz')).status, 200);
  assert.equal((await request('GET', '/api/nothing', { headers: { Authorization: 'Bearer x' } })).status, 401, 'an unknown /api path is the unpaired 401, not a 404');
  const exchange = await request('POST', '/api/session', { headers: { 'Content-Type': 'application/json' }, body: '{"code":"x"}' });
  assert.equal(exchange.status, 401);
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
