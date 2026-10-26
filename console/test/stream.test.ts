'use strict';

// IC-005 / IC-025 (feature 093, V.8): the stream route kind and the Fleet routes.
//   A. stream.ts over a fake request and response, a fake views object (the fake runner) and node:test
//      mock timers: the opening, the three tick kinds, ids and Last-Event-ID, the failure rule, close,
//      and the no-child rule.
//   B. The routes over a real server on 127.0.0.1:0 with a scripted runner: headers, 401, 400, 429 before
//      any stream header, client disconnect, server close within 2 s.
//   C. GET /api/fleet and GET /api/transcript over the scripted runner.
// No browser: EventSource in a real browser is the person's check.

const { test, mock, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createStreams, parseLastEventId, FLEET_MS, TRANSCRIPT_MS, KEEPALIVE_MS, MAX_STREAMS_PER_SESSION } = require('../src/stream.ts');
const { createServer } = require('../src/server.ts');
const { consoleRoutes } = require('../src/routes.ts');
const { createSessions, cookieName } = require('../src/session.ts');
const { securityHeaders } = require('../src/headers.ts');

const PROJECT = '00000000000000a1';
const AGENT = '00000000000000b1';
const CURSOR_1 = '1:100:1:1790000000000';
const CURSOR_2 = '1:200:2:1790000001000';
const CURSOR_3 = '1:300:3:1790000002000';
const MARKER = 'ZZ-MARKER-7f3';

// ---- A. stream.ts over fakes ----

type Frame = { event?: string, id?: string, data?: any, comment?: string };

function fakeResponse() {
  const res: any = new EventEmitter();
  res.head = null;
  res.chunks = [] as string[];
  res.writableEnded = false;
  res.writeHead = (status: number, headers: Record<string, string>) => { res.head = { status, headers }; };
  res.write = (text: string) => { res.chunks.push(text); return true; };
  res.end = () => { res.writableEnded = true; res.emit('close'); };
  return res;
}
const fakeRequest = () => Object.assign(new EventEmitter(), { socket: { destroyed: false, setNoDelay() {} }, destroyed: false });

/** The frames written so far (a frame is a `\n\n`-terminated block), the `retry:` line apart. */
function frames(res: any): Frame[] {
  return res.chunks.join('').split('\n\n').filter((block: string) => block !== '').map((block: string) => {
    const frame: Frame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(': ')) frame.comment = line.slice(2);
      else if (line.startsWith('retry: ')) frame.event = 'retry';
      else if (line.startsWith('event: ')) frame.event = line.slice(7);
      else if (line.startsWith('id: ')) frame.id = line.slice(4);
      else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
    }
    return frame;
  });
}
const named = (res: any, event: string) => frames(res).filter((frame) => frame.event === event);

const section = (key: string, mark = 'a') => ({ projectKey: key, label: `p-${key.slice(-2)}`, current: false, checkouts: 1, lastRecordAt: null, tree: { ok: true, data: { mark } }, traffic: { ok: true, data: {} } });
const fleetBody = (sections: any[]) => ({ v: 1, store: 'present', projects: sections, excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, limits: { projectsShown: sections.length, projectsNotShown: 0, truncated: false } });
const KEY_A = '00000000000000c1';
const KEY_B = '00000000000000c2';
const transcriptBody = (cursor: string, events: any[] = []) => ({ v: 1, agentKey: AGENT, events, cursor, reset: false, eof: true });
const event = (seq: number) => ({ seq, kind: 'reply', text: `reply ${seq}` });

/**
 * Fake views: each call is a "child" that is alive from its start until it settles. `fleetQueue` and
 * `transcriptQueue` give the answers in order (the last one repeats); an Error value is a thrown fault.
 */
function fakeViews(fleetQueue: any[], transcriptQueue: any[] = []) {
  const stats = { alive: 0, peak: 0, fleetCalls: 0, transcriptCalls: [] as Array<string | null> };
  const answer = (queue: any[], index: number) => {
    const value = queue[Math.min(index, queue.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  };
  const track = async <T>(fn: () => T): Promise<T> => {
    stats.alive += 1;
    stats.peak = Math.max(stats.peak, stats.alive);
    try {
      await Promise.resolve();
      return fn();
    } finally {
      stats.alive -= 1;
    }
  };
  return {
    stats,
    fleet: () => track(() => answer(fleetQueue, stats.fleetCalls++)),
    transcript: (_project: string, _agent: string, cursor: string | null) => track(() => answer(transcriptQueue, stats.transcriptCalls.push(cursor) - 1)),
  };
}
const good = (body: any) => ({ ok: true, body });
const bad = (code: string, verb: string | null = 'projects', exit: number | null = 1) => ({ ok: false, error: { code, verb, exit } });

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
/** Advances the mock clock by `ms` in 250 ms steps, letting async ticks finish between steps. */
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 250) {
    mock.timers.tick(Math.min(250, left));
    await settle();
  }
}

/** Opens one stream over fakes with mock timers on. */
function open(views: any, options: { agent?: string | null, revision?: number, cursor?: string | null } = {}) {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const streams = createStreams(views);
  const session = {};
  const release = streams.acquire(session)!;
  let released = 0;
  const req = fakeRequest();
  const res = fakeResponse();
  streams.serve(req, res, { project: PROJECT, agent: options.agent ?? null, revision: options.revision ?? 0, cursor: options.cursor ?? null, release: () => { released += 1; release(); } });
  return { streams, session, req, res, released: () => released };
}
const done = () => mock.timers.reset();

// The no-child rule: after every tick has settled, no call is still running.
function assertNoChild(views: any, label: string) {
  assert.equal(views.stats.alive, 0, `${label}: a call outlived its tick`);
}

test('opening: IC-006 headers plus text/event-stream and no-store, no-transform; retry, then the snapshot', async () => {
  const views = fakeViews([good(fleetBody([section(KEY_A)]))]);
  const { res } = open(views);
  await settle();
  try {
    assert.equal(res.head.status, 200);
    const expected = { ...securityHeaders(true), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform' };
    assert.deepEqual(res.head.headers, expected);
    assert.equal(res.head.headers['Content-Security-Policy'], securityHeaders(false)['Content-Security-Policy']);
    assert.equal(res.chunks[0], 'retry: 5000\n\n');
    const [retry, snapshot, ...more] = frames(res);
    assert.equal(retry.event, 'retry');
    assert.equal(snapshot.event, 'snapshot');
    assert.equal(snapshot.id, '1.');
    assert.deepEqual(snapshot.data, fleetBody([section(KEY_A)]));
    assert.deepEqual(more, []);
  } finally {
    done();
  }
});

test('fleet ticks: every 5 s, only the changed sections and the keys that left; nothing when nothing changed', async () => {
  const views = fakeViews([
    good(fleetBody([section(KEY_A), section(KEY_B)])),
    good(fleetBody([section(KEY_A), section(KEY_B)])),
    good(fleetBody([section(KEY_A), section(KEY_B, 'changed')])),
    good(fleetBody([section(KEY_B, 'changed')])),
  ]);
  const { res } = open(views);
  try {
    await settle();
    assert.equal(views.stats.fleetCalls, 1);
    await advance(FLEET_MS - 250);
    assert.equal(views.stats.fleetCalls, 1, 'no tick before 5 s');
    await advance(250);
    assert.equal(views.stats.fleetCalls, 2);
    assert.deepEqual(named(res, 'fleet'), [], 'an unchanged tick sends nothing');
    await advance(FLEET_MS);
    const [changed] = named(res, 'fleet');
    assert.equal(changed.id, '2.');
    assert.deepEqual(changed.data.projects, [section(KEY_B, 'changed')]);
    assert.deepEqual(changed.data.gone, []);
    await advance(FLEET_MS);
    const [, left] = named(res, 'fleet');
    assert.equal(left.id, '3.');
    assert.deepEqual(left.data.projects, []);
    assert.deepEqual(left.data.gone, [KEY_A]);
    assert.equal(named(res, 'snapshot').length, 1);
  } finally {
    done();
  }
});

test('transcript ticks: every 1 s with an agent, from the current cursor, ids <revision>.<cursor>; none without an agent', async () => {
  const views = fakeViews([good(fleetBody([]))], [
    good(transcriptBody(CURSOR_1, [event(0), event(1)])),
    good(transcriptBody(CURSOR_1)),
    good(transcriptBody(CURSOR_2, [event(2)])),
  ]);
  const { res } = open(views, { agent: AGENT });
  try {
    await settle();
    assert.deepEqual(views.stats.transcriptCalls, []);
    await advance(TRANSCRIPT_MS);
    await advance(TRANSCRIPT_MS);
    await advance(TRANSCRIPT_MS);
    assert.deepEqual(views.stats.transcriptCalls, [null, CURSOR_1, CURSOR_1]);
    const sent = named(res, 'transcript');
    assert.deepEqual(sent.map((frame) => frame.id), [`1.${CURSOR_1}`, `1.${CURSOR_2}`], 'an empty read at the same cursor sends nothing');
    assert.equal(sent[0].data.agent, AGENT);
    assert.deepEqual(sent[0].data.events.map((e: any) => e.seq), [0, 1]);
  } finally {
    done();
  }
  const quiet = fakeViews([good(fleetBody([]))], [good(transcriptBody(CURSOR_1))]);
  open(quiet);
  try {
    await advance(10 * TRANSCRIPT_MS);
    assert.deepEqual(quiet.stats.transcriptCalls, []);
  } finally {
    done();
  }
});

test('transcript ticks: the first answer is sent even when empty (reader status), later empty reads are not', async () => {
  const views = fakeViews([good(fleetBody([]))], [good(transcriptBody(CURSOR_1))]);
  const { res } = open(views, { agent: AGENT });
  try {
    await advance(3 * TRANSCRIPT_MS);
    assert.equal(named(res, 'transcript').length, 1);
  } finally {
    done();
  }
});

test('transcript ticks: none runs until this stream\'s first fleet read has answered, ok or not', async () => {
  let release: (value: any) => void = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const calls: Array<string | null> = [];
  const views = { fleet: () => held, transcript: async (_p: string, _a: string, cursor: string | null) => { calls.push(cursor); return good(transcriptBody(CURSOR_1, [event(0)])); } };
  const { res } = open(views, { agent: AGENT });
  try {
    await advance(3 * TRANSCRIPT_MS);
    assert.deepEqual(calls, [], 'no transcript read while the first fleet read is pending');
    assert.deepEqual(named(res, 'error'), []);
    assert.deepEqual(named(res, 'transcript'), []);
    release(good(fleetBody([section(KEY_A)])));
    await advance(TRANSCRIPT_MS);
    assert.deepEqual(calls, [null], 'the first tick after the answer reads');
    assert.deepEqual(named(res, 'transcript').map((frame) => frame.data.events.map((e: any) => e.seq)), [[0]]);
  } finally {
    done();
  }
  const failing = { fleet: async () => bad('core-error'), transcript: async () => good(transcriptBody(CURSOR_1, [event(0)])) };
  const second = open(failing, { agent: AGENT });
  try {
    await advance(TRANSCRIPT_MS);
    assert.equal(named(second.res, 'transcript').length, 1, 'a failed first fleet read still lets the transcript tick run');
  } finally {
    done();
  }
});

test('keepalive: a comment every 15 s, with no id', async () => {
  const views = fakeViews([good(fleetBody([section(KEY_A)]))]);
  const { res } = open(views);
  try {
    await advance(KEEPALIVE_MS - 250);
    assert.equal(frames(res).filter((frame) => frame.comment === 'keepalive').length, 0);
    await advance(250);
    const keepalives = frames(res).filter((frame) => frame.comment === 'keepalive');
    assert.equal(keepalives.length, 1);
    assert.equal(keepalives[0].id, undefined);
    await advance(KEEPALIVE_MS);
    assert.equal(frames(res).filter((frame) => frame.comment === 'keepalive').length, 2);
  } finally {
    done();
  }
});

test('Last-Event-ID: <revision>.<cursor> resumes the cursor and keeps the revision rising; anything else resumes nothing', async () => {
  assert.deepEqual(parseLastEventId(`7.${CURSOR_2}`), { revision: 7, cursor: CURSOR_2 });
  assert.deepEqual(parseLastEventId('7.'), { revision: 7, cursor: null });
  assert.deepEqual(parseLastEventId('7.not-a-cursor'), { revision: 7, cursor: null }, 'a bad cursor is dropped, the revision kept');
  for (const bad of [undefined, '', '7', 'x.1:2:3:4', `1234567890.${CURSOR_1}`, `7.${CURSOR_1}\nevent: x`, ['7.']]) {
    assert.deepEqual(parseLastEventId(bad), { revision: 0, cursor: null }, JSON.stringify(bad));
  }
  const views = fakeViews([good(fleetBody([]))], [good(transcriptBody(CURSOR_3, [event(9)]))]);
  const { res } = open(views, { agent: AGENT, revision: 7, cursor: CURSOR_2 });
  try {
    await advance(TRANSCRIPT_MS);
    assert.deepEqual(views.stats.transcriptCalls, [CURSOR_2], 'the first read starts at the resumed cursor');
    assert.equal(named(res, 'snapshot')[0].id, `8.${CURSOR_2}`);
    assert.equal(named(res, 'transcript')[0].id, `8.${CURSOR_3}`);
  } finally {
    done();
  }
});

test('limit: at most two streams per session, a release frees a slot, sessions are independent', () => {
  const streams = createStreams(fakeViews([good(fleetBody([]))]));
  const session = {};
  const first = streams.acquire(session);
  const second = streams.acquire(session);
  assert.ok(first && second);
  assert.equal(MAX_STREAMS_PER_SESSION, 2);
  assert.equal(streams.acquire(session), null);
  assert.ok(streams.acquire({}), 'another session is not limited by this one');
  first!();
  first!();
  assert.equal(streams.openStreams(), 2, 'a release counts once');
  assert.ok(streams.acquire(session));
  assert.equal(streams.acquire(session), null);
});

test('a failed tick sends event: error {code, verb, exit} and keeps the stream open; a success resets the count', async () => {
  const views = fakeViews([good(fleetBody([section(KEY_A)])), bad('cannot-list-projects'), bad('cannot-list-projects'), good(fleetBody([section(KEY_A)])), bad('core-unreachable', 'projects', null), bad('core-unreachable', 'projects', null), good(fleetBody([section(KEY_A)]))]);
  const { res, released } = open(views);
  try {
    await advance(2 * FLEET_MS);
    assert.deepEqual(named(res, 'error').map((frame) => frame.data), [
      { code: 'cannot-list-projects', verb: 'projects', exit: 1 },
      { code: 'cannot-list-projects', verb: 'projects', exit: 1 },
    ]);
    assert.equal(res.writableEnded, false);
    await advance(4 * FLEET_MS);
    assert.equal(res.writableEnded, false, 'two failures, a success, two failures: still open');
    assert.equal(released(), 0);
  } finally {
    done();
  }
});

test('three failed ticks in a row close the stream and stop its timers', async () => {
  const views = fakeViews([good(fleetBody([section(KEY_A)])), bad('core-error', 'projects', 2)]);
  const { res, released } = open(views);
  try {
    await advance(3 * FLEET_MS);
    assert.equal(named(res, 'error').length, 3);
    assert.equal(res.writableEnded, true);
    assert.equal(released(), 1);
    const calls = views.stats.fleetCalls;
    await advance(10 * FLEET_MS);
    assert.equal(views.stats.fleetCalls, calls, 'no tick after the close');
    assertNoChild(views, 'closed on failures');
  } finally {
    done();
  }
});

test('a view that throws is a core-error tick, not a crash', async () => {
  const views = fakeViews([good(fleetBody([])), new Error('boom /home/x')]);
  const { res } = open(views);
  try {
    await advance(FLEET_MS);
    const [failure] = named(res, 'error');
    assert.deepEqual(failure.data, { code: 'core-error', verb: null, exit: null });
    assert.ok(!res.chunks.join('').includes('boom'), 'no fault text reaches the stream');
  } finally {
    done();
  }
});

test('the first snapshot failing sends error, then the next good tick is the snapshot, not a delta', async () => {
  const views = fakeViews([bad('cannot-list-projects'), good(fleetBody([section(KEY_A)]))]);
  const { res } = open(views);
  try {
    await advance(FLEET_MS);
    assert.deepEqual(named(res, 'error').length, 1);
    assert.equal(named(res, 'snapshot').length, 1);
    assert.deepEqual(named(res, 'fleet'), []);
  } finally {
    done();
  }
});

test('client disconnect: ticks stop, the slot is released, nothing is written afterwards', async () => {
  const views = fakeViews([good(fleetBody([section(KEY_A)]))], [good(transcriptBody(CURSOR_1, [event(0)]))]);
  const { res, req, released, streams, session } = open(views, { agent: AGENT });
  try {
    await advance(2 * TRANSCRIPT_MS);
    req.socket.destroyed = true;
    req.emit('close');
    assert.equal(released(), 1);
    assert.equal(streams.acquire(session) !== null, true);
    const written = res.chunks.length;
    const calls = [views.stats.fleetCalls, views.stats.transcriptCalls.length];
    await advance(3 * KEEPALIVE_MS);
    assert.deepEqual([views.stats.fleetCalls, views.stats.transcriptCalls.length], calls, 'no tick after the disconnect');
    assert.equal(res.chunks.length, written);
    assertNoChild(views, 'after disconnect');
  } finally {
    done();
  }
});

test('a completed GET request closing its req is not a disconnect while the socket lives', async () => {
  const views = fakeViews([good(fleetBody([]))]);
  const { res, req, released } = open(views);
  try {
    req.emit('close');
    await advance(FLEET_MS);
    assert.equal(released(), 0);
    assert.equal(res.writableEnded, false);
  } finally {
    done();
  }
});

test('an answer arriving after the client left is dropped, not written', async () => {
  let release: (value: any) => void = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const views = { fleet: () => held, transcript: async () => good(transcriptBody(CURSOR_1)) };
  const { res } = open(views);
  try {
    await settle();
    res.emit('close');
    release(good(fleetBody([section(KEY_A)])));
    await settle();
    assert.deepEqual(named(res, 'snapshot'), []);
  } finally {
    done();
  }
});

test('no child: one call per tick at a time, none alive between ticks, none after the close', async () => {
  const views = fakeViews([good(fleetBody([section(KEY_A)]))], [good(transcriptBody(CURSOR_1, [event(0)]))]);
  const { res } = open(views, { agent: AGENT });
  try {
    for (let step = 0; step < 24; step += 1) {
      await advance(250);
      assertNoChild(views, `step ${step}`);
    }
    assert.ok(views.stats.peak <= 2, 'at most one call per tick kind at a time');
    res.emit('close');
    await advance(60_000);
    assertNoChild(views, 'after close');
  } finally {
    done();
  }
});

test('no child: a call still running at its next tick is not started twice', async () => {
  const pending: Array<(value: any) => void> = [];
  let started = 0;
  const views = {
    fleet: () => { started += 1; return new Promise((resolve) => pending.push(resolve)); },
    transcript: async () => good(transcriptBody(CURSOR_1)),
  };
  open(views);
  try {
    await advance(5 * FLEET_MS);
    assert.equal(started, 1, 'ticks do not pile up behind a slow call');
  } finally {
    done();
  }
});

test('control: a handler that keeps a call (a child) across ticks fails the no-child check', async () => {
  const leak = { stats: { alive: 0, peak: 0, fleetCalls: 0, transcriptCalls: [] as any[] }, fleet: () => { leak.stats.alive += 1; return new Promise(() => {}); }, transcript: async () => good(transcriptBody(CURSOR_1)) };
  open(leak);
  try {
    await advance(3 * FLEET_MS);
    assert.throws(() => assertNoChild(leak, 'leaky handler'), /outlived its tick/);
  } finally {
    done();
  }
});

// ---- B and C. The routes over a real server and a scripted runner ----

const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-stream-'));
after(() => fs.rmSync(webRoot, { recursive: true, force: true }));

const keyOf = (n: number) => n.toString(16).padStart(16, '0');
const rawProjects = (count: number) => ({
  v: 1, store: 'present',
  projects: Array.from({ length: count }, (_, i) => ({ projectKey: keyOf(i + 1), root: `/work/${MARKER}/${i}`, label: `proj${i + 1}`, current: i === 0, checkouts: 1, sources: ['upkeep-roots'], lastRecordAt: null })),
  excluded: { missing: 1, temp: 2, notDoflow: 3, unreadable: 0 }, truncated: false,
});
const rawTree = (key: string) => ({ v: 1, projectKey: key, nodes: [], edges: [], limits: { nodes: 256, notChecked: 0 }, unreadable: 0 });
const rawTraffic = (key: string) => ({ v: 1, projectKey: key, windowMin: 10, agents: [], models: [], pairs: [], notChecked: 0 });
const rawTranscript = (cursor: string, events: any[] = []) => ({
  v: 1, agentKey: AGENT, harness: 'claude', reader: { id: 'claude-jsonl', status: 'supported' }, transcript: { linked: true, reason: null },
  events, cursor, reset: false, eof: true, otherRecords: 0, unparsable: 0, masked: 0, warnings: [],
});
const rawReply = (seq: number) => ({ seq, at: '2026-10-26T09:00:00.000Z', kind: 'reply', agentKey: AGENT, model: null, tool: null, text: `hello ${seq}`, args: null, cut: false, tokens: null, record: null });

type Answer = { ok: true, json: any, exit: 0 } | { ok: false, code: string, exit: number | null, errorId?: string };
const ok = (json: any): Answer => ({ ok: true, json, exit: 0 });
const DEFAULTS: Record<string, (params: any) => Answer> = {
  projects: () => ok(rawProjects(2)),
  tree: (p) => ok(rawTree(p.projectKey)),
  traffic: (p) => ok(rawTraffic(p.projectKey)),
  transcript: () => ok(rawTranscript(CURSOR_1, [rawReply(0)])),
};
function scripted(overrides: Record<string, (params: any) => Answer> = {}) {
  const calls: Array<{ shape: string, params: any }> = [];
  return {
    calls,
    run: async (shape: string, params: any) => {
      calls.push({ shape, params });
      return (overrides[shape] ?? DEFAULTS[shape])(params);
    },
  };
}

type Reply = { status: number, headers: Record<string, string | string[] | undefined>, body: string };
function get(app: any, target: string, cookie: string | null, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: target, agent: false, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res: any) => {
      const chunks: any[] = [];
      res.on('data', (chunk: any) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A live stream: the response head at once, the text as it arrives. */
function openStream(app: any, target: string, cookie: string | null, headers: Record<string, string> = {}) {
  return new Promise<{ status: number, headers: any, text(): string, closed: Promise<number>, destroy(): void }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: target, agent: false, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res: any) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      const started = Date.now();
      const closed = new Promise<number>((done) => { res.on('close', () => done(Date.now() - started)); res.on('error', () => {}); });
      resolve({ status: res.statusCode, headers: res.headers, text: () => text, closed, destroy: () => req.destroy() });
    });
    req.on('error', (error: any) => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end();
  });
}
async function until(check: () => boolean, label: string, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) assert.fail(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function harness(runner: any, t: any) {
  const sessions = createSessions();
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions) });
  t.after(() => app.close());
  const token = sessions.exchange(sessions.mintLaunchCode());
  const cookie = `${cookieName(app.port)}=${token}`;
  const json = async (target: string) => {
    const reply = await get(app, target, cookie);
    assert.equal(reply.headers['cache-control'], 'no-store', target);
    assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8', target);
    assert.ok(!reply.body.includes(MARKER), `${target}: the planted marker reached the body`);
    return { status: reply.status, body: JSON.parse(reply.body) };
  };
  return { app, cookie, json };
}
const errorBody = (code: string, verb: string | null = null, exit: number | null = null) => ({ error: { code, verb, exit } });

test('GET /api/stream: session-guarded (401 JSON), parameters checked first (400 JSON), no verb runs for either', async (t) => {
  const runner = scripted();
  const { app, cookie } = await harness(runner, t);
  const anonymous = await get(app, `/api/stream?project=${PROJECT}`, null);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(JSON.parse(anonymous.body), errorBody('unauthenticated'));
  assert.match(String(anonymous.headers['content-type']), /^application\/json/);
  for (const query of ['', '?project=nothex', `?project=${PROJECT.toUpperCase()}`, `?project=${PROJECT}&agent=short`, `?project=${PROJECT}&agent=${AGENT}&agent=${AGENT}`,
    `?project=${PROJECT}&extra=1`, `?agent=${AGENT}`, `?project=${PROJECT}&project=${PROJECT}`]) {
    const reply = await get(app, `/api/stream${query}`, cookie);
    assert.equal(reply.status, 400, query);
    assert.deepEqual(JSON.parse(reply.body), errorBody('usage'), query);
    assert.match(String(reply.headers['content-type']), /^application\/json/, query);
  }
  assert.deepEqual(runner.calls, []);
});

test('GET /api/stream: headers, retry, then the snapshot (the /api/fleet body), through the real server', async (t) => {
  const { app, cookie, json } = await harness(scripted(), t);
  const stream = await openStream(app, `/api/stream?project=${keyOf(1)}`, cookie);
  t.after(() => stream.destroy());
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(stream.headers['cache-control'], 'no-store, no-transform');
  for (const [name, value] of Object.entries(securityHeaders(true))) {
    if (name !== 'Cache-Control') assert.equal(stream.headers[name.toLowerCase()], value, name);
  }
  await until(() => stream.text().includes('event: snapshot'), 'the snapshot');
  assert.ok(stream.text().startsWith('retry: 5000\n\n'));
  const snapshot = stream.text().split('\n\n').find((block) => block.startsWith('event: snapshot'))!;
  const lines = snapshot.split('\n');
  assert.equal(lines[1], 'id: 1.');
  assert.deepEqual(JSON.parse(lines[2].slice('data: '.length)), (await json('/api/fleet')).body);
  assert.ok(!stream.text().includes(MARKER));
});

test('GET /api/stream: a third stream of one session is 429 stream-limit JSON before any stream header; a closed one frees a slot', async (t) => {
  const runner = scripted();
  const { app, cookie } = await harness(runner, t);
  const first = await openStream(app, `/api/stream?project=${keyOf(1)}&agent=${AGENT}`, cookie);
  const second = await openStream(app, `/api/stream?project=${keyOf(1)}`, cookie);
  t.after(() => { first.destroy(); second.destroy(); });
  assert.deepEqual([first.status, second.status], [200, 200]);
  const third = await get(app, `/api/stream?project=${keyOf(1)}`, cookie);
  assert.equal(third.status, 429);
  assert.deepEqual(JSON.parse(third.body), errorBody('stream-limit'));
  assert.match(String(third.headers['content-type']), /^application\/json/);
  assert.equal(third.headers['cache-control'], 'no-store');
  assert.ok(!String(third.headers['content-type']).includes('event-stream'));
  first.destroy();
  await first.closed;
  let again: any = null;
  for (let attempt = 0; attempt < 50 && again === null; attempt += 1) {
    const stream = await openStream(app, `/api/stream?project=${keyOf(1)}`, cookie);
    if (stream.status === 200) again = stream;
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(again && again.status === 200, 'the slot of a disconnected client is free again');
  again.destroy();
});

test('GET /api/stream: Last-Event-ID resumes the cursor through the route; a bad one resumes nothing', async (t) => {
  const runner = scripted({ transcript: () => ok(rawTranscript(CURSOR_3, [rawReply(7)])) });
  const { app, cookie } = await harness(runner, t);
  const stream = await openStream(app, `/api/stream?project=${keyOf(1)}&agent=${AGENT}`, cookie, { 'Last-Event-ID': `4.${CURSOR_2}` });
  t.after(() => stream.destroy());
  await until(() => stream.text().includes('event: snapshot'), 'the snapshot');
  assert.ok(stream.text().includes(`id: 5.${CURSOR_2}`), 'the snapshot carries the resumed cursor and the next revision');
  await until(() => stream.text().includes('event: transcript'), 'a transcript tick', 3000);
  const first = runner.calls.find((call) => call.shape === 'transcript')!;
  assert.deepEqual(first.params, { projectKey: keyOf(1), agent: AGENT, limit: '200', cursor: CURSOR_2 });
  assert.ok(stream.text().includes(`id: 5.${CURSOR_3}`));
});

test('GET /api/stream: a Last-Event-ID that is not <revision>.<cursor> resumes nothing', async (t) => {
  const runner = scripted();
  const { app, cookie } = await harness(runner, t);
  const stream = await openStream(app, `/api/stream?project=${keyOf(1)}&agent=${AGENT}`, cookie, { 'Last-Event-ID': 'garbage' });
  t.after(() => stream.destroy());
  await until(() => runner.calls.some((call) => call.shape === 'transcript'), 'a transcript tick', 3000);
  assert.deepEqual(runner.calls.find((call) => call.shape === 'transcript')!.params, { projectKey: keyOf(1), agent: AGENT, limit: '200' });
  assert.ok(stream.text().includes('id: 1.\n'));
});

test('GET /api/stream: server close ends an open stream within 2 s; a client disconnect ends the server side', async (t) => {
  const runner = scripted();
  const sessions = createSessions();
  const app = await createServer({ webRoot, routes: consoleRoutes(runner, sessions) });
  const token = sessions.exchange(sessions.mintLaunchCode());
  const cookie = `${cookieName(app.port)}=${token}`;
  const stream = await openStream(app, `/api/stream?project=${keyOf(1)}&agent=${AGENT}`, cookie);
  await until(() => stream.text().includes('event: snapshot'), 'the snapshot');
  const start = Date.now();
  await app.close();
  const elapsed = await stream.closed;
  assert.ok(Date.now() - start < 2000 && elapsed < 2500, `closed in ${Date.now() - start} ms`);
  const calls = runner.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(runner.calls.length, calls, 'no verb runs after the server closed');
});

test('GET /api/stream: a client disconnect stops the ticks (no verb runs afterwards)', async (t) => {
  const runner = scripted();
  const { app, cookie } = await harness(runner, t);
  const stream = await openStream(app, `/api/stream?project=${keyOf(1)}&agent=${AGENT}`, cookie);
  await until(() => runner.calls.some((call) => call.shape === 'transcript'), 'a transcript tick', 3000);
  stream.destroy();
  await stream.closed;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const calls = runner.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(runner.calls.length, calls, 'no verb runs after the client left');
});

test('route table: the only non-GET route is /api/session, the only stream route is /api/stream, both behind the session check', async (t) => {
  const sessions = createSessions();
  const routes = consoleRoutes(scripted(), sessions);
  assert.deepEqual(routes.filter((route: any) => route.method !== 'GET').map((route: any) => route.path), ['/api/session']);
  assert.deepEqual(routes.filter((route: any) => route.stream).map((route: any) => route.path), ['/api/stream']);
  assert.ok(routes.every((route: any) => route.stream === undefined || route.stream === true));
  const app = await createServer({ webRoot, routes });
  t.after(() => app.close());
  for (const target of ['/api/stream?project=' + PROJECT, '/api/fleet', `/api/transcript?project=${PROJECT}&agent=${AGENT}`]) {
    const reply = await get(app, target, null);
    assert.equal(reply.status, 401, target);
    assert.deepEqual(JSON.parse(reply.body), errorBody('unauthenticated'), target);
  }
});

test('GET /api/fleet: per-project sections from tree and traffic, the root dropped, window 10 min, at most 12 projects with the rest counted', async (t) => {
  const runner = scripted({ projects: () => ok(rawProjects(15)) });
  const { json } = await harness(runner, t);
  const { status, body } = await json('/api/fleet');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ['v', 'store', 'projects', 'excluded', 'limits']);
  assert.equal(body.v, 1);
  assert.equal(body.projects.length, 12);
  assert.deepEqual(body.limits, { projectsShown: 12, projectsNotShown: 3, truncated: false });
  assert.deepEqual(body.excluded, { missing: 1, temp: 2, notDoflow: 3, unreadable: 0 });
  assert.deepEqual(Object.keys(body.projects[0]), ['projectKey', 'label', 'current', 'checkouts', 'lastRecordAt', 'tree', 'traffic']);
  assert.equal(body.projects[0].current, true);
  assert.equal(body.projects[0].tree.ok, true);
  assert.equal(body.projects[0].tree.data.projectKey, keyOf(1));
  assert.equal(body.projects[0].traffic.data.windowMin, 10);
  const shapes = runner.calls.map((call) => call.shape);
  assert.equal(shapes[0], 'projects');
  assert.equal(shapes.filter((s) => s === 'tree').length, 12);
  assert.equal(shapes.filter((s) => s === 'traffic').length, 12);
  assert.ok(runner.calls.filter((call) => call.shape !== 'projects').every((call) => Object.keys(call.params).join() === 'projectKey'), 'tree and traffic take the project key only');
  assert.ok(!runner.calls.some((call) => call.params.projectKey === keyOf(13)), 'the 13th project is never read');
});

test('GET /api/fleet: a failing tree or traffic fails its own section only, with the IC-005 code', async (t) => {
  const runner = scripted({
    tree: (p) => (p.projectKey === keyOf(2) ? { ok: false, code: 'project-not-found', exit: null } : ok(rawTree(p.projectKey))),
    traffic: (p) => (p.projectKey === keyOf(1) ? { ok: false, code: 'core-unreachable', exit: null } : ok({ ...rawTraffic(p.projectKey), windowMin: 99 })),
  });
  const { json } = await harness(runner, t);
  const { status, body } = await json('/api/fleet');
  assert.equal(status, 200);
  const [one, two] = body.projects;
  assert.equal(one.tree.ok, true);
  assert.deepEqual(one.traffic, { ok: false, code: 'core-unreachable' });
  assert.deepEqual(two.tree, { ok: false, code: 'project-not-found' });
  assert.deepEqual(two.traffic, { ok: false, code: 'core-contract-mismatch' });
});

test('GET /api/fleet: projects failing is the route error: cannot-list-projects 502 (the core id), core-unreachable 503, a mismatch 502', async (t) => {
  const cases: Array<[Answer | (() => Answer), number, any]> = [
    [{ ok: false, code: 'core-error', exit: 1, errorId: 'cannot-list-projects' }, 502, errorBody('cannot-list-projects', 'projects', 1)],
    [{ ok: false, code: 'core-error', exit: 1 }, 502, errorBody('core-error', 'projects', 1)],
    [{ ok: false, code: 'core-error', exit: 1, errorId: 'agent-not-in-project' }, 502, errorBody('core-error', 'projects', 1)],
    [{ ok: false, code: 'core-unreachable', exit: null }, 503, errorBody('core-unreachable', 'projects')],
    [ok({ ...rawProjects(1), v: 2 }), 502, errorBody('core-contract-mismatch', 'projects', 0)],
  ];
  for (const [answer, status, body] of cases) {
    const { json } = await harness(scripted({ projects: () => answer as Answer }), t);
    assert.deepEqual(await json('/api/fleet'), { status, body });
  }
});

test('GET /api/transcript: the projected page for project, agent and cursor; the root and raw ids never reach the body', async (t) => {
  const runner = scripted({ transcript: () => ok({ ...rawTranscript(CURSOR_2, [rawReply(3)]), path: `/home/${MARKER}/t.jsonl` }) });
  const { json } = await harness(runner, t);
  const { status, body } = await json(`/api/transcript?project=${keyOf(1)}&agent=${AGENT}&cursor=${CURSOR_1}`);
  assert.equal(status, 200);
  assert.equal(body.cursor, CURSOR_2);
  assert.equal(body.events[0].text, 'hello 3');
  assert.deepEqual(runner.calls, [{ shape: 'transcript', params: { projectKey: keyOf(1), agent: AGENT, limit: '200', cursor: CURSOR_1 } }]);
  await json(`/api/transcript?project=${keyOf(1)}&agent=${AGENT}`);
  assert.equal(Object.hasOwn(runner.calls[1].params, 'cursor'), false);
});

test('GET /api/transcript: bad parameters are 400 usage before any verb runs', async (t) => {
  const runner = scripted();
  const { json } = await harness(runner, t);
  for (const query of ['', `?project=${PROJECT}`, `?agent=${AGENT}`, `?project=${PROJECT}&agent=zz`, `?project=zz&agent=${AGENT}`, `?project=${PROJECT}&agent=${AGENT}&cursor=1:2:3`,
    `?project=${PROJECT}&agent=${AGENT}&cursor=a:b:c:d`, `?project=${PROJECT}&agent=${AGENT}&limit=500`, `?project=${PROJECT}&agent=${AGENT}&agent=${AGENT}`, `?project=%2e%2e&agent=${AGENT}`]) {
    const reply = await json(`/api/transcript${query}`);
    assert.deepEqual(reply, { status: 400, body: errorBody('usage') }, query);
  }
  assert.deepEqual(runner.calls, []);
});

test('GET /api/transcript: the Fleet codes get their IC-005 statuses (fleetError before the generic mapping)', async (t) => {
  const target = `/api/transcript?project=${PROJECT}&agent=${AGENT}`;
  const cases: Array<[Answer, number, any]> = [
    [{ ok: false, code: 'project-not-found', exit: null }, 404, errorBody('project-not-found', 'transcript')],
    [{ ok: false, code: 'core-error', exit: 1, errorId: 'agent-not-in-project' }, 404, errorBody('agent-not-in-project', 'transcript', 1)],
    [{ ok: false, code: 'core-error', exit: 1, errorId: 'session-not-in-project' }, 404, errorBody('session-not-in-project', 'transcript', 1)],
    [{ ok: false, code: 'core-error', exit: 1, errorId: 'cannot-list-projects' }, 502, errorBody('core-error', 'transcript', 1)],
    [{ ok: false, code: 'core-error', exit: 2 }, 502, errorBody('core-error', 'transcript', 2)],
    [{ ok: false, code: 'core-unreachable', exit: null }, 503, errorBody('core-unreachable', 'transcript')],
    [{ ok: false, code: 'usage', exit: null }, 400, errorBody('usage', 'transcript')],
    [ok({ ...rawTranscript(CURSOR_1), v: 2 }), 502, errorBody('core-contract-mismatch', 'transcript', 0)],
  ];
  for (const [answer, status, body] of cases) {
    const { json } = await harness(scripted({ transcript: () => answer }), t);
    assert.deepEqual(await json(target), { status, body });
  }
});

test('stream tick errors use the same codes: an unknown agent is event: error agent-not-in-project, three close the stream', async (t) => {
  const runner = scripted({ transcript: () => ({ ok: false, code: 'core-error', exit: 1, errorId: 'agent-not-in-project' }) });
  const { app, cookie } = await harness(runner, t);
  const stream = await openStream(app, `/api/stream?project=${keyOf(1)}&agent=${AGENT}`, cookie);
  t.after(() => stream.destroy());
  await until(() => stream.text().includes('event: error'), 'an error event', 3000);
  const frame = stream.text().split('\n\n').find((block) => block.startsWith('event: error'))!;
  assert.deepEqual(JSON.parse(frame.split('\n')[1].slice('data: '.length)), { code: 'agent-not-in-project', verb: 'transcript', exit: 1 });
  const elapsed = await stream.closed;
  assert.ok(elapsed < 5000, `closed after three failed ticks (${elapsed} ms)`);
  assert.equal((stream.text().match(/event: error/g) ?? []).length, 3);
});
