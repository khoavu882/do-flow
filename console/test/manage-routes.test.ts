'use strict';

// 151 IC-012 to IC-014: the seven management GET routes over a real verb runner on the fake core
// (fixtures/fake-core.js modes `manage`, `slow-doctor`, `usage-json` and `old-manage`). The fake core logs
// every start, so each case can say which verbs ran, and its bodies name the project root and the home
// folder, so a case can check that no anchor value reaches a body. Each case checks the status, the
// sections or the IC-005 error body, and the starts.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createServer } = require('../src/server.ts');
const { consoleRoutes } = require('../src/routes.ts');
const { createSessions, cookieName } = require('../src/session.ts');
const { createVerbRunner, PATTERNS } = require('../src/verb-runner.ts');

const FAKE_CORE = path.join(__dirname, 'fixtures', 'fake-core.js');
const ADVICE_REGISTRY = path.join(__dirname, '..', '..', 'core', 'registry', 'advice.json');
/** The fake core's follow-up with a record, one without, and a list cursor (the core's FU_ID and CURSOR forms). */
const FU_KNOWN = 'FU-0a1b2c';
const FU_MISSING = 'FU-zzzzzz';
const FU_CURSOR = '1762581600000:20261108T050000000Z-0a1b2c';
const ROUTES = ['/api/settings', '/api/advice', '/api/workers', '/api/followups', `/api/followups/${FU_KNOWN}`, '/api/doctor', '/api/storage'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const dirs: string[] = [];
const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-manage-routes-'));
dirs.push(webRoot);
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

type Reply = { status: number, headers: Record<string, string>, body: string };

const errorBody = (code: string, verb: string | null = null, exit: number | null = null) => ({ error: { code, verb, exit } });
const tempDir = (prefix: string) => {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(made);
  return fs.realpathSync(made);
};

function fakeClock() {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const handle = { at: now + ms, fn };
      timers.add(handle);
      return handle;
    },
    clearTimeout(handle: any) {
      timers.delete(handle);
    },
    advance(ms: number) {
      now += ms;
      for (const handle of [...timers].sort((a, b) => a.at - b.at)) {
        if (handle.at <= now) {
          timers.delete(handle);
          handle.fn();
        }
      }
    },
  };
}

/**
 * A project root and a home folder (both temp dirs), a real verb runner over the fake core in `mode` with
 * its project root, and the fake core's start log. `starts()` is the argv of every start but `--version`.
 */
function world(mode: string, t: any, options: { env?: Record<string, string>, clock?: any } = {}) {
  const project = tempDir('doflow-ui-manage-project-');
  const home = tempDir('doflow-ui-manage-home-');
  const log = path.join(tempDir('doflow-ui-manage-log-'), 'starts.jsonl');
  const runner = createVerbRunner({
    corePath: FAKE_CORE,
    projectRoot: project,
    env: { FAKE_CORE_MODE: mode, FAKE_CORE_LOG: log, FAKE_HOME: home, ...options.env },
    ...(options.clock ? { clock: options.clock } : {}),
  });
  t.after(() => runner.stop());
  const starts = (): string[][] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line: string) => JSON.parse(line).argv) : [])
    .filter((argv: string[]) => argv[0] !== '--version');
  return { runner, project, home, starts, place: { projectRoot: project, home } };
}

function raw(port: number, text: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: any[] = [];
    socket.on('data', (chunk: any) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const all = Buffer.concat(chunks).toString('utf8');
      const split = all.indexOf('\r\n\r\n');
      const [statusLine, ...lines] = all.slice(0, split).split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines) headers[line.slice(0, line.indexOf(':')).toLowerCase()] = line.slice(line.indexOf(':') + 1).trim();
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body: all.slice(split + 4) });
    });
    socket.write(text, 'latin1');
  });
}

/** A server over `w.runner` with its place and one session of `scope`; `json` sends the cookie and parses the reply. */
async function harness(w: { runner: any, place: any }, t: any, scope: 'read' | 'phone' = 'read') {
  const sessions = createSessions(scope === 'phone' ? { scope: 'phone' } : undefined);
  const app = await createServer({ webRoot, routes: consoleRoutes(w.runner, sessions, null, w.place) });
  t.after(() => app.close());
  const token = sessions.exchange(sessions.mintLaunchCode());
  const get = (target: string, cookie = true) => raw(app.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n`
    + `${cookie ? `Cookie: ${cookieName(app.port)}=${token}\r\n` : ''}Connection: close\r\n\r\n`);
  const json = async (target: string) => {
    const reply = await get(target);
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8', target);
    assert.equal(reply.headers['cache-control'], 'no-store', target);
    return { status: reply.status, body: JSON.parse(reply.body), text: reply.body };
  };
  return { get, json };
}

/** The verb of a start: the first argv word, or the shape the argv is. */
const verbsOf = (starts: string[][]) => starts.map((argv) => (argv[0] === 'advise' || argv[0] === 'storage' || argv[0] === 'lifecycle' || argv[0] === 'config' ? `${argv[0]} ${argv[argv[1] === '--action' ? 2 : 1]}` : argv[0]));
const okSection = (section: any, name: string) => {
  assert.equal(section.ok, true, `${name}: ${JSON.stringify(section)}`);
  assert.deepEqual(Object.keys(section), ['ok', 'data', 'at'], name);
  assert.match(section.at, ISO, `${name}: at`);
  return section.data;
};

test('session: the seven routes are 401 without the cookie, and no verb runs', async (t) => {
  const w = world('manage', t);
  const { get } = await harness(w, t);
  for (const target of [...ROUTES, `/api/followups/${FU_MISSING}`, '/api/doctor?refresh=1']) {
    const reply = await get(target, false);
    assert.equal(reply.status, 401, target);
    assert.deepEqual(JSON.parse(reply.body), errorBody('unauthenticated'), target);
  }
  assert.deepEqual(w.starts(), []);
});

test('phone scope: the seven routes are 403 phone-scope, and no verb runs', async (t) => {
  const w = world('manage', t);
  const { json } = await harness(w, t, 'phone');
  for (const target of [...ROUTES, '/api/advice?kind=tier', '/api/followups?state=all', '/api/doctor?refresh=1']) {
    const reply = await json(target);
    assert.equal(reply.status, 403, target);
    assert.deepEqual(reply.body, errorBody('phone-scope'), target);
  }
  assert.deepEqual(w.starts(), []);
  // Control: a phone route still answers.
  assert.notEqual((await json('/api/runs')).status, 403);
});

test('query: an unknown, repeated or bad kind, state, cursor, id or refresh is 400 usage before any verb runs', async (t) => {
  const w = world('manage', t);
  const { json } = await harness(w, t);
  const refused = [
    '/api/settings?kind=tier', '/api/settings?x=1', '/api/settings?refresh=1',
    '/api/advice?kind=Tier', '/api/advice?kind=', '/api/advice?kind=-tier', '/api/advice?kind=1tier', '/api/advice?kind=tier_x', '/api/advice?kind=tier%0A',
    `/api/advice?kind=t${'a'.repeat(32)}`, '/api/advice?kind=tier&kind=tier', '/api/advice?kind=tier&kind=rerank', '/api/advice?kinds=tier', '/api/advice?kind=--json',
    '/api/workers?refresh=1', '/api/workers?harness=claude',
    '/api/followups?state=closed', '/api/followups?state=OPEN', '/api/followups?state=', '/api/followups?state=open&state=open', '/api/followups?state=open%20--limit%20500',
    '/api/followups?cursor=12:34:5:6789', '/api/followups?cursor=', `/api/followups?cursor=${FU_CURSOR}&cursor=${FU_CURSOR}`, '/api/followups?limit=50',
    '/api/followups?view=full',
    '/api/followups/FU-0A1B2C', '/api/followups/FU-0a1b2i', '/api/followups/FU-0a1b2', '/api/followups/x', '/api/followups/FU-0a1b2c%2CFU-0a1b2d',
    '/api/followups/%46U-0a1b2c', `/api/followups/${FU_KNOWN}?view=full`,
    '/api/doctor?refresh=0', '/api/doctor?refresh=true', '/api/doctor?refresh=', '/api/doctor?refresh=1&refresh=1', '/api/doctor?fix=1', '/api/doctor?refresh=01',
    '/api/storage?action=prune', '/api/storage?refresh=1',
  ];
  for (const target of refused) {
    const reply = await json(target);
    assert.equal(reply.status, 400, target);
    assert.deepEqual(reply.body, errorBody('usage'), target);
  }
  assert.deepEqual(w.starts(), [], 'the fake core never started');
});

test('the seven routes on the fake core: sections with data and at, the IC-013 and IC-014 bodies, and only /api/doctor runs doctor', async (t) => {
  const w = world('manage', t);
  const { json } = await harness(w, t);
  const startedAt = Date.now();

  const settings = await json('/api/settings');
  assert.equal(settings.status, 200);
  assert.deepEqual(Object.keys(settings.body), ['v', 'sections']);
  assert.equal(settings.body.v, 1);
  assert.deepEqual(Object.keys(settings.body.sections), ['effective', 'schema']);
  const effective = okSection(settings.body.sections.effective, 'effective');
  assert.equal(effective.failSafe, false);
  assert.ok(effective.keys.length >= 8);
  assert.ok(Date.parse(settings.body.sections.effective.at) >= startedAt - 1000 && Date.parse(settings.body.sections.effective.at) <= Date.now());
  assert.deepEqual(okSection(settings.body.sections.schema, 'schema').invariants.map((row: any) => row.id), ['INV-1']);

  const advice = await json('/api/advice');
  assert.equal(advice.status, 200);
  assert.deepEqual(Object.keys(advice.body), ['v', 'kind', 'sections']);
  assert.equal(advice.body.kind, null);
  assert.deepEqual(Object.keys(advice.body.sections), ['settings', 'report', 'picks']);
  const adviceSettings = okSection(advice.body.sections.settings, 'advice settings');
  // The advice.* keys only; the files whole; the errors and notes that name no key or an advice.* key.
  assert.deepEqual(adviceSettings.keys.map((row: any) => row.key), effective.keys.map((row: any) => row.key).filter((key: string) => key.startsWith('advice.')));
  assert.deepEqual(adviceSettings.keys.map((row: any) => row.key), ['advice.enabled', 'advice.model', 'advice.kinds.task-class']);
  assert.deepEqual(adviceSettings.files, effective.files);
  assert.deepEqual(adviceSettings.errors, effective.errors.filter((row: any) => row.key === null || row.key.startsWith('advice.')));
  assert.deepEqual(adviceSettings.errors.map((row: any) => row.key), ['advice.enabled', null]);
  assert.deepEqual(adviceSettings.notes.map((row: any) => row.key), ['advice.kinds.task-class', null]);
  assert.equal(adviceSettings.failSafe, false);
  okSection(advice.body.sections.report, 'report');
  assert.equal(okSection(advice.body.sections.picks, 'picks').kind, null);

  const workers = await json('/api/workers');
  assert.equal(workers.status, 200);
  assert.deepEqual(Object.keys(workers.body), ['v', 'sections']);
  assert.deepEqual(Object.keys(workers.body.sections), ['matrix', 'settings']);
  assert.deepEqual(okSection(workers.body.sections.matrix, 'matrix').groups.orchestration, ['spawn']);
  const workerSettings = okSection(workers.body.sections.settings, 'workers settings');
  assert.deepEqual(workerSettings.keys.map((row: any) => row.key), ['dispatch.fallback', 'workers.enabled', 'team.writerCap']);
  assert.deepEqual(workerSettings.errors.map((row: any) => row.key), [null]);
  assert.deepEqual(workerSettings.notes.map((row: any) => row.key), ['workers.enabled', null]);

  const followups = await json('/api/followups');
  assert.equal(followups.status, 200);
  assert.deepEqual(Object.keys(followups.body), ['v', 'state', 'cursor', 'sections']);
  assert.deepEqual([followups.body.state, followups.body.cursor], ['open', null]);
  assert.deepEqual(Object.keys(followups.body.sections), ['list', 'overview']);
  const list = okSection(followups.body.sections.list, 'list');
  assert.deepEqual([list.state, list.nextCursor, list.items.map((item: any) => item.id)], ['open', FU_CURSOR, [FU_KNOWN, 'FU-0a1b2d']]);
  assert.equal(okSection(followups.body.sections.overview, 'overview').goals[0].proposeDone, true);

  const record = await json(`/api/followups/${FU_KNOWN}`);
  assert.equal(record.status, 200);
  assert.deepEqual(Object.keys(record.body), ['v', 'followup']);
  assert.equal(record.body.followup.id, FU_KNOWN);
  assert.deepEqual(record.body.followup.intent, { anchor: 'project', rel: 'agent-docs/intent/loader.md' });

  const storage = await json('/api/storage');
  assert.equal(storage.status, 200);
  assert.deepEqual(Object.keys(storage.body), ['v', 'at', 'storage']);
  assert.match(storage.body.at, ISO);
  assert.deepEqual(storage.body.storage.stores.map((row: any) => row.where), [{ anchor: 'project', rel: '.doflow/state/verification/runs' }, { anchor: 'home', rel: '.doflow/traces' }]);

  // No route but /api/doctor ran doctor (IC-012 /api/workers, FR-024).
  // Reads of one route run in parallel, so their start order is not fixed.
  assert.deepEqual(verbsOf(w.starts()).sort(), ['advice-picks', 'advise report', 'config list', 'config schema', 'followup', 'followup', 'lifecycle overview', 'storage report', 'worker-matrix']);

  const doctor = await json('/api/doctor');
  assert.equal(doctor.status, 200);
  assert.deepEqual(Object.keys(doctor.body), ['v', 'at', 'refresh', 'doctor']);
  assert.deepEqual([doctor.body.v, doctor.body.refresh, doctor.body.doctor.exit], [1, null, 0]);
  assert.match(doctor.body.at, ISO);
  assert.equal(doctor.body.doctor.warnings[0].subject, '~/.claude/settings.json: permissions.allow');
  assert.equal(verbsOf(w.starts()).filter((verb) => verb === 'doctor').length, 1);
});

test('the reads a route makes: config list once for three routes (the runner cache), --kind passed, the state default and the cursor', async (t) => {
  const w = world('manage', t);
  const { json } = await harness(w, t);
  await json('/api/settings');
  await json('/api/advice');
  await json('/api/workers');
  assert.equal(w.starts().filter((argv) => argv[0] === 'config' && argv[1] === 'list').length, 1, 'shared by argv through the cache');

  const tier = await json('/api/advice?kind=tier');
  assert.equal(tier.status, 200);
  assert.equal(tier.body.kind, 'tier');
  assert.deepEqual(okSection(tier.body.sections.picks, 'picks').kinds, ['tier']);
  assert.deepEqual(w.starts().at(-1), ['advice-picks', '--kind', 'tier', '--json']);

  await json('/api/followups');
  assert.deepEqual(w.starts().find((argv) => argv[0] === 'followup'), ['followup', '--action', 'list', '--state', 'open', '--limit', '25', '--json']);
  const paged = await json(`/api/followups?cursor=${FU_CURSOR}&state=all`);
  assert.equal(paged.status, 200);
  assert.deepEqual([paged.body.state, paged.body.cursor, paged.body.sections.list.data.state], ['all', FU_CURSOR, 'all']);
  assert.ok(w.starts().some((argv) => argv.join(' ') === `followup --action list --state all --cursor ${FU_CURSOR} --limit 25 --json`));
  for (const state of ['open', 'taken', 'done', 'dismissed', 'all']) assert.equal((await json(`/api/followups?state=${state}`)).body.state, state);
});

test('D13: adviceKind gates /api/advice; a pattern-valid kind the core lacks is section usage, never a 502 or core-error', async (t) => {
  const w = world('manage', t);
  const { json } = await harness(w, t);
  const registry = JSON.parse(fs.readFileSync(ADVICE_REGISTRY, 'utf8')).kinds.map((entry: any) => entry.id);
  const accepted = [...registry, 'adhoc'];
  const unknown = ['no-such-kind', 'a', 'z9', `t${'a'.repeat(31)}`];
  const refused = ['Tier', '-tier', '1tier', 'tier_x', 'tier.x', `t${'a'.repeat(32)}`];
  for (const kind of [...accepted, ...unknown]) assert.ok(PATTERNS.adviceKind.test(kind), kind);
  for (const kind of refused) assert.equal(PATTERNS.adviceKind.test(kind), false, kind);

  for (const kind of accepted) {
    const reply = await json(`/api/advice?kind=${kind}`);
    assert.equal(reply.status, 200, kind);
    assert.equal(okSection(reply.body.sections.picks, kind).kind, kind);
  }
  for (const kind of unknown) {
    const reply = await json(`/api/advice?kind=${kind}`);
    assert.equal(reply.status, 200, kind);
    assert.equal(reply.body.kind, kind);
    assert.deepEqual(reply.body.sections.picks, { ok: false, code: 'usage' }, kind);
    okSection(reply.body.sections.settings, `${kind} settings`);
    okSection(reply.body.sections.report, `${kind} report`);
  }
  const before = w.starts().length;
  for (const kind of refused) {
    const reply = await json(`/api/advice?kind=${encodeURIComponent(kind)}`);
    assert.deepEqual([reply.status, reply.body], [400, errorBody('usage')], kind);
  }
  assert.equal(w.starts().length, before, 'a refused kind runs nothing');
});

test('one failing read fails its own section only; a failed single read is its IC-005 error reply', async (t) => {
  const cases: Array<[string, string, string, string[]]> = [
    ['config-schema', '/api/settings', 'schema', ['effective']],
    ['config-list', '/api/settings', 'effective', ['schema']],
    ['config-list', '/api/advice', 'settings', ['report', 'picks']],
    ['advise-report', '/api/advice', 'report', ['settings', 'picks']],
    ['advice-picks', '/api/advice', 'picks', ['settings', 'report']],
    ['worker-matrix', '/api/workers', 'matrix', ['settings']],
    ['config-list', '/api/workers', 'settings', ['matrix']],
    ['lifecycle-overview', '/api/followups', 'overview', ['list']],
    ['followups', '/api/followups', 'list', ['overview']],
  ];
  for (const [shape, target, failed, siblings] of cases) {
    const w = world('manage', t, { env: { FAKE_MANAGE_FAIL: shape } });
    const { json } = await harness(w, t);
    const reply = await json(target);
    assert.equal(reply.status, 200, `${shape} on ${target}`);
    assert.deepEqual(reply.body.sections[failed], { ok: false, code: 'core-error' }, `${shape} on ${target}`);
    for (const name of siblings) okSection(reply.body.sections[name], `${target} ${name} beside a failed ${shape}`);
    assert.ok(!reply.text.includes('secret-stderr-text'));
  }
  const single: Array<[string, string, number]> = [['followup-record', `/api/followups/${FU_KNOWN}`, 3], ['doctor', '/api/doctor', 3], ['storage-report', '/api/storage', 3]];
  for (const [shape, target, exit] of single) {
    const w = world('manage', t, { env: { FAKE_MANAGE_FAIL: shape } });
    const { json } = await harness(w, t);
    const reply = await json(target);
    assert.deepEqual([reply.status, reply.body], [502, errorBody('core-error', shape, exit)], target);
  }
});

test('older cores: core-lacks-verb per section, and 501 core-lacks-verb on the single reads', async (t) => {
  const old = world('old-manage', t);
  const oldServer = await harness(old, t);
  const advice = await oldServer.json('/api/advice');
  assert.equal(advice.status, 200);
  okSection(advice.body.sections.settings, 'settings');
  assert.deepEqual(advice.body.sections.report, { ok: false, code: 'core-lacks-verb' });
  assert.deepEqual(advice.body.sections.picks, { ok: false, code: 'core-lacks-verb' });
  const workers = await oldServer.json('/api/workers');
  assert.equal(workers.status, 200);
  assert.deepEqual(workers.body.sections.matrix, { ok: false, code: 'core-lacks-verb' });
  okSection(workers.body.sections.settings, 'settings');

  // A core that answers every argv with its JSON usage id: the shapes the route checks to the core's rule are an older core.
  const usage = world('usage-json', t);
  const usageServer = await harness(usage, t);
  const settings = await usageServer.json('/api/settings');
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.body.sections, { effective: { ok: false, code: 'core-error' }, schema: { ok: false, code: 'core-lacks-verb' } });
  const followups = await usageServer.json('/api/followups');
  assert.equal(followups.status, 200);
  assert.deepEqual(followups.body.sections, { list: { ok: false, code: 'core-lacks-verb' }, overview: { ok: false, code: 'core-lacks-verb' } });
  const usageAdvice = await usageServer.json('/api/advice');
  assert.deepEqual(usageAdvice.body.sections, { settings: { ok: false, code: 'core-error' }, report: { ok: false, code: 'core-lacks-verb' }, picks: { ok: false, code: 'usage' } });
  const record = await usageServer.json(`/api/followups/${FU_KNOWN}`);
  assert.deepEqual([record.status, record.body], [501, errorBody('core-lacks-verb', 'followup-record')]);
  const storage = await usageServer.json('/api/storage');
  assert.deepEqual([storage.status, storage.body], [501, errorBody('core-lacks-verb', 'storage-report')]);
  // doctor is not a usageIsOldCore shape (IC-005), so its usage answer stays the core's error.
  const doctor = await usageServer.json('/api/doctor');
  assert.deepEqual([doctor.status, doctor.body], [502, errorBody('core-error', 'doctor', 2)]);
});

test('GET /api/followups/:id: a record that does not exist is 404 followup-not-found', async (t) => {
  const w = world('manage', t);
  const { json } = await harness(w, t);
  const reply = await json(`/api/followups/${FU_MISSING}`);
  assert.deepEqual([reply.status, reply.body], [404, errorBody('followup-not-found', 'followup-record', 0)]);
  assert.deepEqual(w.starts(), [['followup', '--action', 'list', '--view', 'full', '--ids', FU_MISSING, '--json']]);
});

test('exit 1 is data: config list flags the fail-safe body and doctor reports exit 1, both 200', async (t) => {
  const w = world('manage', t, { env: { FAKE_MANAGE_EXIT1: 'config-list,doctor' } });
  const { json } = await harness(w, t);
  const settings = await json('/api/settings');
  assert.equal(settings.status, 200);
  assert.equal(okSection(settings.body.sections.effective, 'effective').failSafe, true);
  okSection(settings.body.sections.schema, 'schema');
  for (const target of ['/api/advice', '/api/workers']) assert.equal(okSection((await json(target)).body.sections.settings, target).failSafe, true, target);
  const doctor = await json('/api/doctor');
  assert.equal(doctor.status, 200);
  assert.equal(doctor.body.doctor.exit, 1);
  assert.equal(doctor.body.doctor.findings.length, 1);
  assert.ok(!settings.text.includes('secret-stderr-text') && !doctor.text.includes('secret-stderr-text'));
  // Control: the same world with exit 0 is not fail-safe.
  const plain = world('manage', t);
  assert.equal((await (await harness(plain, t)).json('/api/settings')).body.sections.effective.data.failSafe, false);
});

test('doctor: served from the 60 s cache, too-soon under the 5 s floor, ran past it, at the time the run ended', async (t) => {
  const clock = fakeClock();
  const w = world('manage', t, { clock });
  const { json } = await harness(w, t);
  const doctorStarts = () => w.starts().filter((argv) => argv[0] === 'doctor').length;
  clock.advance(1_000);
  const first = await json('/api/doctor');
  assert.deepEqual([first.status, first.body.refresh, first.body.at], [200, null, '1970-01-01T00:00:01.000Z']);
  assert.equal(doctorStarts(), 1);

  clock.advance(59_999);
  const cached = await json('/api/doctor');
  assert.deepEqual([cached.body.refresh, cached.body.at], [null, first.body.at]);
  assert.deepEqual(cached.body.doctor, first.body.doctor);
  assert.equal(doctorStarts(), 1, 'served from the cache under the 60 s ttl');
  clock.advance(1);
  const expired = await json('/api/doctor');
  assert.deepEqual([expired.body.refresh, expired.body.at], [null, '1970-01-01T00:01:01.000Z']);
  assert.equal(doctorStarts(), 2, 'run again at the ttl');

  clock.advance(4_999);
  const soon = await json('/api/doctor?refresh=1');
  assert.deepEqual([soon.status, soon.body.refresh, soon.body.at], [200, 'too-soon', expired.body.at]);
  assert.equal(doctorStarts(), 2, 'too-soon runs nothing');
  clock.advance(1);
  const ran = await json('/api/doctor?refresh=1');
  assert.deepEqual([ran.status, ran.body.refresh, ran.body.at], [200, 'ran', '1970-01-01T00:01:06.000Z']);
  assert.equal(doctorStarts(), 3, 'past the floor a refresh runs inside the ttl');
  const after = await json('/api/doctor');
  assert.deepEqual([after.body.refresh, after.body.at], [null, ran.body.at]);
  assert.equal(doctorStarts(), 3, 'the refreshed run is the cache');
});

test('doctor: a refresh while a run is in flight joins it', async (t) => {
  const w = world('slow-doctor', t, { env: { FAKE_CORE_DELAY_MS: '400' } });
  const { json } = await harness(w, t);
  const plain = json('/api/doctor');
  for (let i = 0; i < 500 && !w.starts().some((argv) => argv[0] === 'doctor'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const joined = json('/api/doctor?refresh=1');
  const [a, b] = await Promise.all([plain, joined]);
  assert.deepEqual([a.status, a.body.refresh, b.status, b.body.refresh], [200, null, 200, 'joined']);
  assert.equal(b.body.at, a.body.at);
  assert.deepEqual(b.body.doctor, a.body.doctor);
  assert.equal(w.starts().filter((argv) => argv[0] === 'doctor').length, 1);
});

test('no anchor value in any body: the project root, the home folder and the config home are placed or replaced', async (t) => {
  const w = world('manage', t);
  const { json } = await harness(w, t);
  const texts: string[] = [];
  for (const target of [...ROUTES, '/api/advice?kind=task-class', `/api/followups/${FU_MISSING}`, '/api/followups?state=all', '/api/doctor?refresh=1']) {
    const reply = await json(target);
    assert.ok(reply.status === 200 || reply.status === 404, `${target}: ${reply.status}`);
    texts.push(reply.text);
  }
  const all = texts.join('\n');
  for (const anchor of [w.project, w.home, `${w.home}/.config/doflow`, path.basename(w.project), path.basename(w.home)]) {
    assert.ok(!all.includes(anchor), `an anchor value reached a body: ${anchor}`);
  }
  // Not vacuous: the fake core put each anchor in paths and free text, and the bodies carry their places.
  for (const placed of ['"anchor":"project"', '"anchor":"home"', '"anchor":"config-home"', '"anchor":"project-layers"', '<project>', '~/', '<config home>']) {
    assert.ok(all.includes(placed), placed);
  }
  const raw = fs.readFileSync(FAKE_CORE, 'utf8');
  assert.ok(raw.includes('process.cwd()') && raw.includes('FAKE_HOME'));
});
