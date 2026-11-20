'use strict';

// Row 180 C4 (IC-180-B1): GET /api/runs/:slug/:taskId/export answers one run's chain as one masked JSON file. The runner is
// scripted from the real core outputs under fixtures/core/, as routes.test.ts does; the run page's reads and errors are
// the export's (it builds on `runDetail`), and the body leaves through `maskLite` once more.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server.ts');
const { consoleRoutes } = require('../src/routes.ts');
const { createSessions, cookieName } = require('../src/session.ts');
const { lanWorld, lanServer } = require('./helpers/lan-world.ts');
const manifest = require('../package.json');

const FIXTURES = path.join(__dirname, 'fixtures', 'core');
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-export-'));
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

type Answer = { ok: true, json: any, exit: 0 } | { ok: false, code: string, exit: number | null, errorId?: string };
const ok = (json: any): Answer => ({ ok: true, json, exit: 0 });
const DEFAULTS: Record<string, () => Answer> = {
  version: () => ok('2.0.0-beta.7'),
  list: () => ok(fixture('list')),
  status: () => ok(fixture('status')),
  timeline: () => ok(fixture('timeline')),
  attempts: () => ok(fixture('attempts')),
  workflow: () => ok(fixture('workflow')),
};
/** A runner answering each shape from `overrides`, else from the fixtures, else core-unreachable. */
const scripted = (overrides: Record<string, () => Answer> = {}) => ({
  run: async (shape: string, _params: any) => (overrides[shape] ?? DEFAULTS[shape] ?? (() => ({ ok: false, code: 'core-unreachable', exit: null })))(),
});
const errorBody = (code: string, verb: string | null = null, exit: number | null = null) => ({ error: { code, verb, exit } });
/** The list fixture with its `t1` row moved to feature `slug`. */
const listWith = (slug: string) => {
  const list = fixture('list');
  for (const row of list.runs) if (row.taskId === 't1') row.featureSlug = slug;
  return list;
};

type Reply = { status: number, headers: Record<string, any>, body: string };
const get = (port: number, target: string, cookie?: string): Promise<Reply> => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: target, headers: cookie ? { Cookie: cookie } : {} }, (res: any) => {
    const chunks: any[] = [];
    res.on('data', (chunk: any) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  }).on('error', reject);
});

/** A loopback server over `runner` with one live session: `get(target, withCookie)`. */
async function loopback(runner: any, t: any) {
  const sessions = createSessions();
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions) });
  t.after(() => app.close());
  const cookie = `${cookieName(app.port)}=${sessions.exchange(sessions.mintLaunchCode())}`;
  return (target: string, withCookie = true) => get(app.port, target, withCookie ? cookie : undefined);
}

const EXPORT = '/api/runs/093-console-web-ui/t1/export';

test('export: 200 with an attachment named for the task id and {v, exportedAt, console, run, timeline, tasks}, the run page\'s own reads', async (t) => {
  const fetch = await loopback(scripted(), t);
  const before = Date.now();
  const reply = await fetch(EXPORT);
  assert.equal(reply.status, 200);
  assert.match(reply.headers['content-type'], /^application\/json/);
  assert.equal(reply.headers['content-disposition'], 'attachment; filename="doflow-run-t1.json"');
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['v', 'exportedAt', 'console', 'run', 'timeline', 'tasks']);
  assert.equal(body.v, 1);
  assert.equal(body.console, manifest.version);
  assert.ok(Date.parse(body.exportedAt) >= before - 1000 && Date.parse(body.exportedAt) <= Date.now() + 1000, body.exportedAt);
  const page = JSON.parse((await fetch('/api/runs/093-console-web-ui/t1')).body);
  assert.deepEqual(body.run, page.run);
  assert.deepEqual(body.timeline, page.timeline);
  assert.deepEqual(body.tasks, page.tasks);
  assert.equal(body.run.taskId, 't1');
  assert.equal(body.timeline.taskId, 't1');
});

test('export: the body passes the second mask once more, so an address or a token-shaped value that got through the projection is masked', async (t) => {
  const slug = '10.0.0.5';
  const fetch = await loopback(scripted({ list: () => ok(listWith(slug)) }), t);
  // The run page keeps the slug (an id of the grammar); the file the person sends on does not.
  assert.equal(JSON.parse((await fetch(`/api/runs/${slug}/t1`)).body).run.featureSlug, slug);
  const reply = await fetch(`/api/runs/${slug}/t1/export`);
  assert.equal(reply.status, 200);
  assert.equal(JSON.parse(reply.body).run.featureSlug, '<ip>');
  assert.ok(!reply.body.includes(slug), 'the address is not in the file');
  const token = 'AbCdEfGh12345678AbCdEfGh12345678x9';
  const second = await loopback(scripted({ list: () => ok(listWith(token)) }), t);
  assert.equal(JSON.parse((await second(`/api/runs/${token}/t1/export`)).body).run.featureSlug, '<masked>');
});

test('export: a bad slug or task id is 400 usage with no verb run; an unknown run, a malformed plan and a missing status are the run page\'s reply', async (t) => {
  const calls: string[] = [];
  const runner = { run: async (shape: string, params: any) => { calls.push(shape); return scripted().run(shape, params); } };
  const fetch = await loopback(runner, t);
  for (const target of ['/api/runs/-x/t1/export', '/api/runs/s1/_t/export', '/api/runs/a%2Fb/t1/export', '/api/runs/s1/a;b/export']) {
    const reply = await fetch(target);
    assert.equal(reply.status, 400, target);
    assert.deepEqual(JSON.parse(reply.body), errorBody('usage'), target);
    assert.equal(reply.headers['content-disposition'], undefined, target);
  }
  assert.deepEqual(calls, []);
  const missing = await loopback(scripted({ status: () => ({ ok: false, code: 'core-error', exit: 1 }) }), t);
  const unknown = await missing(EXPORT);
  const page = await missing('/api/runs/093-console-web-ui/t1');
  assert.equal(unknown.status, 404);
  assert.deepEqual(JSON.parse(unknown.body), errorBody('run-not-found', 'status', 1));
  assert.deepEqual([unknown.status, unknown.body], [page.status, page.body]);
  assert.equal(unknown.headers['content-disposition'], undefined);
  const broken = await loopback(scripted({ attempts: () => ({ ok: false, code: 'core-error', exit: 2, errorId: 'plan-malformed' }) }), t);
  const brokenExport = await broken(EXPORT);
  const brokenPage = await broken('/api/runs/093-console-web-ui/t1');
  assert.ok(brokenPage.status >= 400);
  assert.deepEqual([brokenExport.status, brokenExport.body], [brokenPage.status, brokenPage.body]);
  assert.equal(brokenExport.headers['content-disposition'], undefined);
});

test('export: loopback without the session cookie is 401, with it 200', async (t) => {
  const calls: string[] = [];
  const fetch = await loopback({ run: async (shape: string, params: any) => { calls.push(shape); return scripted().run(shape, params); } }, t);
  const reply = await fetch(EXPORT, false);
  assert.equal(reply.status, 401);
  assert.deepEqual(JSON.parse(reply.body), errorBody('unauthenticated'));
  assert.deepEqual(calls, []);
  assert.equal((await fetch(EXPORT)).status, 200);
});

test('export: LAN, a paired device of either scope may export; an unpaired request is refused', async (t) => {
  const world = lanWorld(t);
  const server = await lanServer(t, world, consoleRoutes(scripted(), world.auth), webRoot);
  for (const scope of ['view', 'control'] as const) {
    const device = await world.pair(scope);
    const reply = await server.request('GET', EXPORT, { headers: { Authorization: device.bearer } });
    assert.equal(reply.status, 200, scope);
    assert.equal(reply.headers['content-disposition'], 'attachment; filename="doflow-run-t1.json"');
    assert.equal(JSON.parse(reply.body).run.taskId, 't1');
  }
  const unpaired = await server.request('GET', EXPORT);
  assert.equal(unpaired.status, 401);
  assert.deepEqual(JSON.parse(unpaired.body), errorBody('device-unpaired'));
});
