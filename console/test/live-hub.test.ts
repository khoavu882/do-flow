'use strict';

// Live hub (feature 149, IC-010 and IC-012). A fake events supervisor records every `need` set and
// lets a case push core envelopes and `onDown` codes; a fake clock drives the 25 ms debounce and the
// 5000 ms pending timer; a fake verb runner counts every call that leaves the hub. Section JSON is
// the core fixtures of fixtures/core/ and the IC-018 bodies of routes.test.ts and project.test.ts, so
// the projectors accept them. Each member is checked against the GET composer of routes.ts run over
// a plain runner that answers the same section results.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLiveHub, diffState, envelopeText, isChannel, parseChannel, resultOf, HUB_WINDOW_BYTES, LIVE_FRAME_BUDGET, MAX_POINTER_DEPTH } = require('../src/live.ts');
const { createLiveChild } = require('../src/live-child.ts');
const { consoleRoutes, matchPath, runs, tasks, runDetail, sessionsView, workerRuns } = require('../src/routes.ts');
const { createSessions, cookieName } = require('../src/session.ts');
const { maskLite } = require('../src/mask-lite.ts');
const { project } = require('../src/project.ts');

const FIXTURES = path.join(__dirname, 'fixtures', 'core');
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const KEY = '0cc00ec6d2062bc0';
/** The list fixture's one RUNNING run with a feature; the attempts fixture's one active attempt is A.1 token 1. */
const SLUG = '060-write-set-completeness';
const TASK = '060-write-set-completeness';
const RUN_ID = 'w-0123456789ab';

const SAMPLES: Record<string, () => any> = {
  observed: () => ({ v: 1, store: 'present', truncated: false, unreadable: 0, sessions: [],
    checkouts: [{ worktreeKey: KEY, role: 'main', current: true, branch: 'feat/149-console-v2-live', head: 'febd2cc99487', headCommittedAt: '2026-10-26T09:45:48.000Z' }] }),
  slots: () => ({ v: 1, unreadable: 0, slots: [{ name: 'build', holder: { label: 'npm test', since: '2026-10-26T09:00:00.000Z', alive: false, worktreeKey: KEY }, waiters: 0 }] }),
  roadmap: () => ({ schema: 1, action: 'status', rowStatus: {}, rows: [], openIntents: [], run: null, holds: [],
    lease: { pid: 4242, host: 'host-a', runId: null, acquiredAt: '2026-10-26T08:00:00.000Z' } }),
  noWorker: () => ({ disposition: 'status', run: null, task: 'A.1', token: 1 }),
  worker: () => ({
    disposition: 'status', runId: RUN_ID, task: 'A.1', token: 1, harness: 'codex', state: 'running', reason: null, supervisorLost: false, overdue: true,
    startedAt: '2026-10-26T09:00:00.000Z', endedAt: null, deadline: '2026-10-26T10:00:00.000Z', attemptActive: true,
  }),
  // 150 IC-004 and IC-003 bodies, as the core's `runs` and `result` sections carry them.
  runs: () => ({
    v: 1, slug: SLUG, store: 'present',
    runs: [{ runId: RUN_ID, task: 'A.1', token: 1, harness: 'codex', childOf: null, phase: 'running', endState: null, createdAt: '2026-10-26T08:59:59.000Z',
      startedAt: '2026-10-26T09:00:00.000Z', endedAt: null, edit: false }],
    limits: { shown: 1, notShown: 0 },
  }),
  result: () => ({
    v: 1, runId: RUN_ID, task: 'A.1', token: 1, harness: 'codex', phase: 'running', endState: null, endedAt: null, reportStatus: null, readOnly: null,
    isolation: null, resultOffered: false, withheld: ['not-exited'], quota: null,
  }),
};

type Section = { exit: number, json: any };
const ok = (json: any): Section => ({ exit: 0, json });
/** The pooled runner's answer for a core without the verb (150 IC-010). */
const OLD_CORE = Object.freeze({ ok: false, code: 'core-error', exit: 1, reason: 'old-core' });

/** The sections of each core channel the cases use, as the events verb would print them. */
function coreSections(): Record<string, Record<string, Section>> {
  return {
    now: { list: ok(fixture('list')), observed: ok(SAMPLES.observed()), slots: ok(SAMPLES.slots()), roadmap: ok(SAMPLES.roadmap()) },
    [`run:${SLUG}:${TASK}`]: { status: ok(fixture('status')), timeline: ok(fixture('timeline')) },
    [`tasks:${SLUG}`]: { attempts: ok(fixture('attempts')), runs: ok(SAMPLES.runs()), 'worker:A.1:1': ok(SAMPLES.noWorker()) },
    [`worker:${RUN_ID}`]: { status: ok(SAMPLES.worker()), result: ok(SAMPLES.result()) },
  };
}

/** The verb runner: every call recorded; `workflow` answers the fixture, a shape in `answers` its function, any other `core-unreachable`. */
function realRunner(answers: Record<string, (params: any) => any> = {}) {
  const calls: Array<{ shape: string, params: any }> = [];
  return {
    calls,
    run: async (shape: string, params: any) => {
      calls.push({ shape, params });
      if (Object.hasOwn(answers, shape)) return answers[shape](params);
      return shape === 'workflow' ? { ok: true, json: fixture('workflow'), exit: 0 } : { ok: false, code: 'core-unreachable', exit: null };
    },
  };
}

/**
 * A plain runner over `sections` with the IC-010 table written out by hand, and `workflow` from the
 * fixture. A `runs` or `result` section that is not there is an older core: the old-core result.
 */
function plainRunner(sections: Record<string, Record<string, Section>>) {
  const at = (channel: string, name: string) => resultOf(sections[channel][name]);
  const newer = (channel: string, name: string) => (Object.hasOwn(sections[channel], name) ? at(channel, name) : { ...OLD_CORE });
  return {
    run: async (shape: string, params: any = {}) => {
      if (shape === 'workflow') return { ok: true, json: fixture('workflow'), exit: 0 };
      if (['list', 'observed', 'slots', 'roadmap'].includes(shape)) return at('now', shape);
      if (shape === 'status' || shape === 'timeline') return at(`run:${params.slug}:${params.taskId}`, shape);
      if (shape === 'attempts') return at(`tasks:${params.slug}`, 'attempts');
      if (shape === 'worker-status') return at(`tasks:${params.slug}`, `worker:${params.task}:${params.token}`);
      if (shape === 'worker-runs') return newer(`tasks:${params.slug}`, 'runs');
      if (shape === 'worker-result') return newer(`worker:${params.runId}`, 'result');
      if (shape === 'worker-run-status') return at(`worker:${params.runId}`, 'status');
      throw new Error(`unexpected shape ${shape}`);
    },
  };
}

const member = (reply: any) => ({ status: reply.status, body: JSON.parse(reply.body) });

/** A GET reply over `runner` as a member, through the Console's route table with a live session. */
async function getMember(runner: any, target: string) {
  const port = 4173;
  const sessions = createSessions();
  const token = sessions.exchange(sessions.mintLaunchCode());
  const route = consoleRoutes(runner, sessions).find((entry: any) => entry.method === 'GET' && entry.path !== '/*' && matchPath(entry.path, target) !== null);
  const reply = await route.handler({ req: { url: target, headers: { cookie: `${cookieName(port)}=${token}` } }, res: null, pathname: target, params: matchPath(route.path, target), port });
  return member(reply);
}

function fakeClock() {
  let now = Date.parse('2026-11-07T12:00:00.000Z');
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
    step(ms: number) {
      now += ms;
      for (const handle of [...timers].sort((a, b) => a.at - b.at)) {
        if (handle.at <= now && timers.has(handle)) {
          timers.delete(handle);
          handle.fn();
        }
      }
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A fake supervisor. `need` records each set (sorted); with `serve` set it answers every channel that
 * joins the set with a snapshot of its sections, as a child would after `sub`.
 */
function fakeSupervisor(serve: Record<string, Record<string, Section>> | null = null) {
  let frameListener: (envelope: any) => void = () => {};
  let downListener: (code: string) => void = () => {};
  let seq = 0;
  let last = new Set<string>();
  const sup = {
    needs: [] as string[][],
    state: 'stopped' as string,
    stopped: 0,
    serve,
    need(channels: ReadonlySet<string>) {
      const next = new Set(channels);
      sup.needs.push([...next].sort());
      if (next.size === 0) sup.state = 'stopped';
      else if (sup.state === 'stopped') sup.state = 'running';
      const added = [...next].filter((ch) => !last.has(ch));
      last = next;
      if (sup.serve) for (const ch of added) if (sup.serve[ch]) sup.push(ch, 'snapshot', { sections: sup.serve[ch] });
    },
    get last(): string[] {
      return sup.needs.length === 0 ? [] : sup.needs[sup.needs.length - 1];
    },
    onFrame(listener: (envelope: any) => void) {
      frameListener = listener;
    },
    onDown(listener: (code: string) => void) {
      downListener = listener;
    },
    stop() {
      sup.stopped += 1;
    },
    push(ch: string, type: string, data: any) {
      seq += 1;
      frameListener({ v: 1, ch, id: `0badc0de-${seq}`, type, at: '2026-11-07T12:00:00.000Z', data });
    },
    down(code: 'events-down' | 'live-unavailable') {
      sup.state = code === 'events-down' ? 'down' : 'unsupported';
      downListener(code);
    },
  };
  return sup;
}

function setup(serve: Record<string, Record<string, Section>> | null = coreSections(), runner = realRunner()) {
  const clock = fakeClock();
  const supervisor = fakeSupervisor(serve);
  const hub = createLiveHub({ runner, supervisor, clock });
  /** Moves the clock in 25 ms steps, letting each composition finish. */
  const advance = async (ms: number) => {
    await settle();
    for (let done = 0; done < ms; done += 25) {
      clock.step(Math.min(25, ms - done));
      await settle();
      await settle();
    }
  };
  const listen = (channel: string) => {
    const frames: any[] = [];
    const unsubscribe = hub.subscribe(channel, (frame: any) => frames.push(frame));
    return { frames, unsubscribe };
  };
  return { clock, supervisor, runner, hub, advance, listen };
}

// ---- members equal the GET replies ----

test('now: runs and sessions equal GET /api/runs and GET /api/sessions over the same section results', async () => {
  const sections = coreSections();
  const { hub, advance, listen, supervisor, runner } = setup(sections);
  const { frames } = listen('now');
  await advance(100);
  assert.deepEqual(frames.map((f) => f.type), ['snapshot']);
  const plain = plainRunner(sections);
  const expected = { runs: member(await runs(plain)), sessions: member(await sessionsView(plain)) };
  assert.equal(expected.runs.status, 200);
  assert.equal(expected.sessions.status, 200);
  assert.ok(expected.sessions.body.sections.workers.ok, 'the sessions fixture reaches the worker section');
  assert.deepEqual(frames[0].data.state, expected);
  assert.deepEqual(hub.current('now'), { n: 1, state: expected, error: null, gone: false });
  // sessionsView inspected the live feature, so its tasks channel joined the set.
  assert.deepEqual(supervisor.last, ['now', `tasks:${SLUG}`]);
  assert.deepEqual(runner.calls, []);
});

test('run: the run member equals GET /api/runs/:slug/:taskId; the only verb call is the cached workflow read', async () => {
  const sections = coreSections();
  const { advance, listen, supervisor, runner } = setup(sections);
  const { frames } = listen(`run:${SLUG}:${TASK}`);
  assert.deepEqual(supervisor.needs[0], ['now', `run:${SLUG}:${TASK}`, `tasks:${SLUG}`]);
  await advance(100);
  const expected = member(await runDetail(plainRunner(sections), SLUG, TASK));
  assert.equal(expected.status, 200);
  assert.deepEqual(frames.map((f) => f.type), ['snapshot']);
  assert.deepEqual(frames[0].data.state, { run: expected });
  assert.deepEqual(runner.calls.map((call) => call.shape), ['workflow']);
  assert.deepEqual(runner.calls[0].params, { taskClass: 'feature' });
});

test('tasks: the tasks member is {tasks, tasksReason?} as runDetail builds it, or its error reply; workers equals GET /api/worker-runs/:slug', async () => {
  const sections = coreSections();
  const { advance, listen, runner } = setup(sections);
  const { frames } = listen(`tasks:${SLUG}`);
  await advance(100);
  const graph = await tasks(plainRunner(sections), SLUG);
  assert.equal(graph.ok, true);
  const run = member(await runDetail(plainRunner(sections), SLUG, TASK));
  const workers = member(await workerRuns(plainRunner(sections), SLUG));
  assert.equal(workers.status, 200);
  assert.equal(workers.body.source, 'worker-runs');
  assert.deepEqual(frames[0].data.state, { tasks: { status: 200, body: { tasks: graph.tasks } }, workers });
  assert.deepEqual(frames[0].data.state.tasks.body.tasks, run.body.tasks);
  assert.equal(Object.hasOwn(run.body, 'tasksReason'), false);

  // No plan: tasks null with tasksReason, the same fields runDetail puts in the run body.
  const noPlan = coreSections();
  noPlan[`tasks:${SLUG}`].attempts = { exit: 2, json: { error: 'plan-unreadable', message: 'no plan.md' } };
  const second = setup(noPlan);
  const listener = second.listen(`tasks:${SLUG}`);
  await second.advance(100);
  const body = member(await runDetail(plainRunner(noPlan), SLUG, TASK)).body;
  assert.deepEqual(listener.frames[0].data.state, { tasks: { status: 200, body: { tasks: body.tasks, tasksReason: body.tasksReason } }, workers });
  assert.deepEqual(listener.frames[0].data.state.tasks.body, { tasks: null, tasksReason: 'no-plan' });

  // Any other failed inspect: the tasks member is the IC-005 error reply.
  const broken = coreSections();
  broken[`tasks:${SLUG}`].attempts = { exit: 2, json: { error: 'store-unreadable' } };
  const third = setup(broken);
  const failed = third.listen(`tasks:${SLUG}`);
  await third.advance(100);
  const reply = await tasks(plainRunner(broken), SLUG);
  assert.equal(reply.ok, false);
  assert.deepEqual(failed.frames[0].data.state, { tasks: member(reply.reply), workers });
  assert.deepEqual(failed.frames[0].data.state.tasks, { status: 502, body: { error: { code: 'core-error', verb: 'attempts', exit: 2 } } });
  assert.deepEqual([...runner.calls, ...second.runner.calls, ...third.runner.calls], []);
});

test('worker: worker equals GET .../status (the widened worker-status body; 404 unknown-run for exit 1 or no run) and result equals GET .../result', async () => {
  const { advance, listen, runner } = setup();
  const { frames } = listen(`worker:${RUN_ID}`);
  await advance(100);
  const projected = project('worker-run-status', SAMPLES.worker());
  assert.equal(projected.ok, true);
  const result = project('worker-result', SAMPLES.result());
  assert.equal(result.ok, true);
  assert.deepEqual(frames[0].data.state, { worker: { status: 200, body: projected.body }, result: { status: 200, body: result.body } });

  const none = coreSections();
  none[`worker:${RUN_ID}`].status = ok(SAMPLES.noWorker());
  const second = setup(none);
  const nothing = second.listen(`worker:${RUN_ID}`);
  await second.advance(100);
  assert.deepEqual(nothing.frames[0].data.state.worker, { status: 404, body: { error: { code: 'unknown-run', verb: 'worker-run-status', exit: 0 } } });
  assert.deepEqual(nothing.frames[0].data.state.worker, await getMember(plainRunner(none), `/api/worker-runs/${SLUG}/${RUN_ID}/status`));

  const failing = coreSections();
  failing[`worker:${RUN_ID}`].status = { exit: 1, json: { error: 'run-not-found' } };
  const third = setup(failing);
  const failed = third.listen(`worker:${RUN_ID}`);
  await third.advance(100);
  assert.deepEqual(failed.frames[0].data.state.worker, { status: 404, body: { error: { code: 'unknown-run', verb: 'worker-run-status', exit: 1 } } });
  assert.deepEqual(failed.frames[0].data.state.worker, await getMember(plainRunner(failing), `/api/worker-runs/${SLUG}/${RUN_ID}/status`));
  // Any other failed status is its IC-005 error reply, as over GET.
  const crashed = coreSections();
  crashed[`worker:${RUN_ID}`].status = { exit: 2, json: { error: 'usage' } };
  const fourth = setup(crashed);
  const broken = fourth.listen(`worker:${RUN_ID}`);
  await fourth.advance(100);
  assert.deepEqual(broken.frames[0].data.state.worker, { status: 502, body: { error: { code: 'core-error', verb: 'worker-run-status', exit: 2 } } });
  assert.deepEqual(broken.frames[0].data.state.worker, await getMember(plainRunner(crashed), `/api/worker-runs/${SLUG}/${RUN_ID}/status`));
  assert.deepEqual([...runner.calls, ...second.runner.calls, ...third.runner.calls, ...fourth.runner.calls], []);
});

// ---- 150 IC-013: the new members ----

test('150 members: workers on tasks:<slug>, and worker and result on worker:<runId>, equal their GET replies over the same section results', async () => {
  const cases: Array<[string, (s: Record<string, Record<string, Section>>) => void]> = [
    ['a newer core', () => {}],
    ['a result the core refuses as unknown-run', (s) => { s[`worker:${RUN_ID}`].result = { exit: 1, json: { error: 'unknown-run', message: 'no such run' } }; }],
    ['a result the core fails', (s) => { s[`worker:${RUN_ID}`].result = { exit: 2, json: null }; }],
    ['a result body the projector refuses', (s) => { s[`worker:${RUN_ID}`].result = ok({ ...SAMPLES.result(), withheld: ['made-up'] }); }],
    ['a run list the core fails', (s) => { s[`tasks:${SLUG}`].runs = { exit: 2, json: { error: 'store-unreadable' } }; }],
    ['an ended and a child run', (s) => {
      const body = SAMPLES.runs();
      body.runs.push({ ...body.runs[0], runId: 'w-ba9876543210', childOf: RUN_ID, phase: 'ended', endState: 'exited', endedAt: '2026-10-26T09:30:00.000Z' });
      body.limits.shown = 2;
      s[`tasks:${SLUG}`].runs = ok(body);
    }],
  ];
  for (const [label, edit] of cases) {
    const sections = coreSections();
    edit(sections);
    const { advance, listen, runner } = setup(sections);
    const graph = listen(`tasks:${SLUG}`).frames;
    const worker = listen(`worker:${RUN_ID}`).frames;
    await advance(100);
    const plain = plainRunner(sections);
    const workers = await getMember(plain, `/api/worker-runs/${SLUG}`);
    const status = await getMember(plain, `/api/worker-runs/${SLUG}/${RUN_ID}/status`);
    const result = await getMember(plain, `/api/worker-runs/${SLUG}/${RUN_ID}/result`);
    assert.deepEqual(graph.map((f) => f.type), ['snapshot'], label);
    assert.deepEqual(graph[0].data.state.workers, workers, label);
    if (result.status === 502 && result.body.error.code === 'core-contract-mismatch') {
      // DEC-040: a projector refusal is the channel's error, not a member.
      assert.deepEqual(worker.map((f) => [f.type, f.data]), [['error', { code: 'core-contract-mismatch' }]], label);
    } else {
      assert.deepEqual(worker[0].data.state, { worker: status, result }, label);
    }
    assert.deepEqual(runner.calls, [], `${label}: no verb call`);
  }
  // The exact values the cases above reached.
  const refused = coreSections();
  refused[`worker:${RUN_ID}`].result = { exit: 1, json: { error: 'unknown-run', message: 'no such run' } };
  assert.deepEqual(await getMember(plainRunner(refused), `/api/worker-runs/${SLUG}/${RUN_ID}/result`), { status: 404, body: { error: { code: 'unknown-run', verb: 'worker-result', exit: 1 } } });
  const listed = await getMember(plainRunner(coreSections()), `/api/worker-runs/${SLUG}`);
  assert.deepEqual(listed.body.runs.map((run: any) => run.runId), [RUN_ID]);
  assert.deepEqual(listed.body.limits, { shown: 1, notShown: 0, ended: 'listed' });
});

test('150 older core: a complete snapshot without runs or result answers old-core, so workers is the active-attempts fallback and result 501 core-lacks-verb, as over GET', async () => {
  const sections = coreSections();
  delete sections[`tasks:${SLUG}`].runs;
  delete sections[`worker:${RUN_ID}`].result;
  // The attempt's worker section names a run, so the fallback lists it.
  sections[`tasks:${SLUG}`]['worker:A.1:1'] = ok(SAMPLES.worker());
  const { advance, listen, runner, supervisor } = setup(null);
  const graph = listen(`tasks:${SLUG}`).frames;
  const worker = listen(`worker:${RUN_ID}`).frames;
  // A split snapshot is not complete: a section missing from its first part is still pending.
  const { attempts, ...rest } = sections[`tasks:${SLUG}`];
  supervisor.push(`tasks:${SLUG}`, 'snapshot', { sections: { attempts }, more: true });
  await advance(100);
  assert.deepEqual(graph, []);
  supervisor.push(`tasks:${SLUG}`, 'patch', { sections: rest });
  supervisor.push(`worker:${RUN_ID}`, 'snapshot', { sections: sections[`worker:${RUN_ID}`] });
  await advance(100);
  const plain = plainRunner(sections);
  const workers = await getMember(plain, `/api/worker-runs/${SLUG}`);
  assert.equal(workers.status, 200);
  assert.equal(workers.body.source, 'active-attempts');
  assert.deepEqual(workers.body.runs.map((run: any) => run.runId), [RUN_ID]);
  assert.deepEqual(workers.body.limits, { shown: 1, notShown: 0, ended: 'not-checked' });
  assert.deepEqual(graph.map((f) => f.type), ['snapshot']);
  assert.deepEqual(graph[0].data.state.workers, workers);
  const result = await getMember(plain, `/api/worker-runs/${SLUG}/${RUN_ID}/result`);
  assert.deepEqual(result, { status: 501, body: { error: { code: 'core-lacks-verb', verb: 'worker-result', exit: null } } });
  assert.deepEqual(worker[0].data.state, { worker: await getMember(plain, `/api/worker-runs/${SLUG}/${RUN_ID}/status`), result });
  assert.deepEqual(runner.calls, [], 'the old-core answer is the hub\'s own; no verb runs');
  // A missing section an older core does make is still pending, never old-core.
  const other = setup(null);
  const waiting = other.listen(`worker:${RUN_ID}`).frames;
  other.supervisor.push(`worker:${RUN_ID}`, 'snapshot', { sections: { result: ok(SAMPLES.result()) } });
  await other.advance(100);
  assert.deepEqual(waiting, []);
});

test('runner mapping: a section becomes a runner result as spawnCore maps a child', () => {
  assert.deepEqual(resultOf({ exit: 0, json: { v: 1 } }), { ok: true, json: { v: 1 }, exit: 0 });
  assert.deepEqual(resultOf({ exit: 0, json: null }), { ok: false, code: 'core-error', exit: 0, reason: 'not-json' });
  assert.deepEqual(resultOf({ exit: 2, json: { error: 'plan-unreadable', message: 'x' } }), { ok: false, code: 'core-error', exit: 2, errorId: 'plan-unreadable' });
  // errorIdOf: only an object's `error` id matching PARAM_PATTERN.
  assert.deepEqual(resultOf({ exit: 1, json: { error: 'has space' } }), { ok: false, code: 'core-error', exit: 1 });
  assert.deepEqual(resultOf({ exit: 1, json: [{ error: 'x' }] }), { ok: false, code: 'core-error', exit: 1 });
  assert.deepEqual(resultOf({ exit: 1, json: null }), { ok: false, code: 'core-error', exit: 1 });
});

test('channels: the IC-003 grammar with the core length bound, and 150 IC-006\'s out and err log channels only', () => {
  for (const good of ['now', 'run:feat-a:A.3', 'tasks:feat_a', `worker:${RUN_ID}`, `tasks:${'a'.repeat(56)}`, `worker:${RUN_ID}:out`, `worker:${RUN_ID}:err`]) assert.equal(isChannel(good), true, good);
  for (const bad of ['', 'now:x', 'run:a', 'run:a:b:c', 'run:-a:b', 'run:.a:b', 'tasks:a/b', `tasks:${'a'.repeat(57)}`, 'worker:w-0123', 'worker:w-0123456789AB',
    `worker:${RUN_ID}:last`, `worker:${RUN_ID}:x`, `worker:${RUN_ID}:OUT`, `worker:${RUN_ID}:out:1`, `worker:${RUN_ID}:`, 'worker:w-0123:out', 'tasks:a:out',
    'transcript:x', 'followups', 'fleet:x', 'tasks:', 'tasks:a b']) {
    assert.equal(isChannel(bad), false, bad);
  }
  assert.deepEqual(parseChannel('run:feat-a:A.3'), { kind: 'run', name: 'run:feat-a:A.3', slug: 'feat-a', taskId: 'A.3' });
  assert.deepEqual(parseChannel(`worker:${RUN_ID}:err`), { kind: 'log', name: `worker:${RUN_ID}:err`, runId: RUN_ID, stream: 'err' });
});

// ---- pending, debounce ----

test('pending: a missing dependency joins the need set and the channel composes once its snapshot arrives', async () => {
  const sections = coreSections();
  const { advance, listen, supervisor } = setup(null);
  const { frames } = listen('now');
  assert.deepEqual(supervisor.needs, [['now']]);
  await advance(100);
  assert.deepEqual(frames, []);
  supervisor.push('now', 'snapshot', { sections: sections.now });
  await advance(50);
  // sessionsView read the live feature's attempts: pending on its tasks channel, nothing sent.
  assert.deepEqual(supervisor.last, ['now', `tasks:${SLUG}`]);
  assert.deepEqual(frames, []);
  // A split snapshot is not complete until its last patch.
  const { attempts, ...workers } = sections[`tasks:${SLUG}`];
  supervisor.push(`tasks:${SLUG}`, 'snapshot', { sections: { attempts }, more: true });
  await advance(50);
  assert.deepEqual(frames, []);
  supervisor.push(`tasks:${SLUG}`, 'patch', { sections: workers });
  await advance(50);
  assert.deepEqual(frames.map((f) => f.type), ['snapshot']);
  assert.deepEqual(frames[0].data.state.sessions, member(await sessionsView(plainRunner(sections))));
});

test('pending: error pending-timeout after 5000 ms while the child runs, not while it is down; the next frame is a snapshot', async () => {
  const sections = coreSections();
  const { advance, listen, supervisor } = setup(null);
  const { frames } = listen(`tasks:${SLUG}`);
  assert.equal(supervisor.state, 'running');
  await advance(4_975);
  assert.deepEqual(frames, []);
  await advance(100);
  assert.deepEqual(frames.map((f) => [f.type, f.data]), [['error', { code: 'pending-timeout' }]]);
  await advance(10_000);
  assert.equal(frames.length, 1, 'one pending-timeout per pending spell');
  supervisor.push(`tasks:${SLUG}`, 'snapshot', { sections: sections[`tasks:${SLUG}`] });
  await advance(50);
  assert.deepEqual(frames.map((f) => f.type), ['error', 'snapshot']);

  // Down: events-down, and no pending-timeout however long the child stays down.
  const other = setup(null);
  const watched = other.listen(`tasks:${SLUG}`);
  await other.advance(1_000);
  other.supervisor.down('events-down');
  await other.advance(20_000);
  assert.deepEqual(watched.frames.map((f) => [f.type, f.data]), [['error', { code: 'events-down' }]]);
  other.supervisor.state = 'running';
  await other.advance(5_100);
  assert.deepEqual(watched.frames.map((f) => f.data.code), ['events-down', 'pending-timeout']);
});

test('debounce: two core frames within 25 ms give one composition and one patch', async () => {
  const sections = coreSections();
  const { advance, listen, supervisor, runner } = setup(sections);
  const { frames } = listen(`run:${SLUG}:${TASK}`);
  await advance(100);
  assert.equal(runner.calls.length, 1);
  const status = fixture('status');
  supervisor.push(`run:${SLUG}:${TASK}`, 'patch', { sections: { status: ok({ ...status, revision: 3 }) } });
  await advance(10);
  supervisor.push(`run:${SLUG}:${TASK}`, 'patch', { sections: { status: ok({ ...status, revision: 4 }) } });
  await advance(100);
  assert.equal(runner.calls.length, 2, 'one more composition (one more workflow read)');
  assert.deepEqual(frames.map((f) => f.type), ['snapshot', 'patch']);
  assert.deepEqual(frames[1].data, { set: { '/run/body/run/revision': 4 }, unset: [] });
});

// ---- patch pointers ----

test('diff: depth 4 or less, arrays whole, a member whose status changed whole, RFC 6901 escaping, unset, and null when unchanged', () => {
  const before = { m: { status: 200, body: { a: { b: { c: 1, d: 2 } }, list: [1, 2], 'x/y~z': 1, old: true, same: { k: 1 } } } };
  const after = { m: { status: 200, body: { a: { b: { c: 3, d: 2 } }, list: [1, 2, 3], 'x/y~z': 2, same: { k: 1 }, added: 'new' } } };
  const patch = diffState(before, after);
  assert.deepEqual(patch, {
    set: { '/m/body/a/b': { c: 3, d: 2 }, '/m/body/list': [1, 2, 3], '/m/body/x~1y~0z': 2, '/m/body/added': 'new' },
    unset: ['/m/body/old'],
  });
  for (const pointer of [...Object.keys(patch.set), ...patch.unset]) assert.ok(pointer.split('/').length - 1 <= MAX_POINTER_DEPTH, pointer);
  assert.deepEqual(diffState({ run: { status: 200, body: { x: 1 } } }, { run: { status: 404, body: { x: 1 } } }), { set: { '/run': { status: 404, body: { x: 1 } } }, unset: [] });
  assert.deepEqual(diffState({ run: { status: 200, body: { x: 1 } }, gone: { status: 200, body: null } }, { run: { status: 200, body: { x: 1 } } }), { set: {}, unset: ['/gone'] });
  assert.equal(diffState(structuredClone(after), structuredClone(after)), null);
});

test('patch: a recomposition that changes nothing sends nothing; a change sends set and unset pointers', async () => {
  const sections = coreSections();
  const { advance, listen, supervisor } = setup(sections);
  const { frames } = listen(`tasks:${SLUG}`);
  await advance(100);
  // A field the projector drops changed: the member is the same, so no frame.
  const attempts = fixture('attempts');
  attempts.graph.warnings = [];
  supervisor.push(`tasks:${SLUG}`, 'patch', { sections: { attempts: ok(attempts) } });
  await advance(100);
  assert.deepEqual(frames.map((f) => f.type), ['snapshot']);
  attempts.revision = 7;
  attempts.graph.overlaps = [];
  supervisor.push(`tasks:${SLUG}`, 'patch', { sections: { attempts: ok(attempts) } });
  await advance(100);
  assert.deepEqual(frames.map((f) => f.type), ['snapshot', 'patch']);
  assert.deepEqual(frames[1].data, { set: { '/tasks/body/tasks/revision': 7, '/tasks/body/tasks/graph': frames[1].data.set['/tasks/body/tasks/graph'] }, unset: [] });
  assert.deepEqual(frames[1].data.set['/tasks/body/tasks/graph'].overlaps, []);
});

// ---- frames: cap, reset, errors, gone, down ----

/** An attempts body whose projection is far over the frame budget. */
function bigAttempts() {
  const body = fixture('attempts');
  const many = Array.from({ length: 2_500 }, (_, i) => `T.${i}`);
  body.graph.tasks = many.map((id) => ({ id, phase: 'T', owner: 'core-implementer', taskDeps: [], parallel: true }));
  body.graph.overlaps = [];
  body.tasks = many.map((id) => ({ id, state: 'PLANNED', reason: 'ready', budget: { used: 0, limit: 20 }, attempts: [] }));
  return body;
}

test('frame cap: a snapshot or patch over LIVE_FRAME_BUDGET is reset frame-cap, and the next frame that fits is a snapshot', async () => {
  assert.equal(LIVE_FRAME_BUDGET, 262_144 - 4_096);
  const sections = coreSections();
  sections[`tasks:${SLUG}`].attempts = ok(bigAttempts());
  const { hub, advance, listen, supervisor } = setup(sections);
  const { frames } = listen(`tasks:${SLUG}`);
  await advance(100);
  assert.deepEqual(frames.map((f) => [f.type, f.data]), [['reset', { reason: 'frame-cap' }]]);
  assert.deepEqual(hub.current(`tasks:${SLUG}`), { n: 1, state: null, error: null, gone: false });
  // The same oversize state again sends nothing more.
  supervisor.push(`tasks:${SLUG}`, 'patch', { sections: { attempts: ok(bigAttempts()) } });
  await advance(100);
  assert.equal(frames.length, 1);
  supervisor.push(`tasks:${SLUG}`, 'patch', { sections: { attempts: ok(fixture('attempts')) } });
  await advance(100);
  assert.deepEqual(frames.map((f) => f.type), ['reset', 'snapshot']);
  // A patch over the budget is replaced as well.
  supervisor.push(`tasks:${SLUG}`, 'patch', { sections: { attempts: ok(bigAttempts()) } });
  await advance(100);
  assert.deepEqual(frames.map((f) => f.type), ['reset', 'snapshot', 'reset']);
  for (const frame of frames) assert.ok(Buffer.byteLength(envelopeText(hub.epoch, frame), 'utf8') <= LIVE_FRAME_BUDGET);
  supervisor.push(`tasks:${SLUG}`, 'patch', { sections: { attempts: ok(fixture('attempts')) } });
  await advance(100);
  assert.deepEqual(frames.map((f) => f.type), ['reset', 'snapshot', 'reset', 'snapshot']);
});

test('core reset is reset core-reset, then a snapshot; a core error passes through, then a snapshot', async () => {
  const sections = coreSections();
  const { hub, advance, listen, supervisor } = setup(sections);
  const { frames } = listen(`tasks:${SLUG}`);
  await advance(100);
  supervisor.push(`tasks:${SLUG}`, 'reset', { reason: 'replaced' });
  assert.deepEqual(frames.map((f) => [f.type, f.data]).slice(1), [['reset', { reason: 'core-reset' }]]);
  supervisor.push(`tasks:${SLUG}`, 'snapshot', { sections: sections[`tasks:${SLUG}`] });
  await advance(100);
  assert.deepEqual(frames.map((f) => f.type), ['snapshot', 'reset', 'snapshot']);

  for (const code of ['store-unreadable', 'unsupported-version', 'producer-failed', 'too-many-channels']) {
    supervisor.push(`tasks:${SLUG}`, 'error', { code });
    assert.deepEqual(frames[frames.length - 1].data, { code });
    assert.equal(hub.current(`tasks:${SLUG}`).error, code);
    // Frames of an errored core channel compose nothing until its snapshot.
    await advance(10_000);
    assert.equal(frames[frames.length - 1].type, 'error');
    supervisor.push(`tasks:${SLUG}`, 'snapshot', { sections: sections[`tasks:${SLUG}`] });
    await advance(100);
    assert.equal(frames[frames.length - 1].type, 'snapshot', code);
    assert.equal(hub.current(`tasks:${SLUG}`).error, null);
  }
  supervisor.push(`tasks:${SLUG}`, 'error', { code: 'something-new' });
  assert.deepEqual(frames[frames.length - 1].data, { code: 'core-contract-mismatch' });
});

test('gone: the channel resting on a pruned core channel gets gone and leaves the need set; a channel reading it on the side reads it again', async () => {
  const sections = coreSections();
  const { hub, advance, listen, supervisor } = setup(sections);
  const ownFrames = listen(`tasks:${SLUG}`).frames;
  const nowFrames = listen('now').frames;
  await advance(100);
  assert.deepEqual(supervisor.last, ['now', `tasks:${SLUG}`]);
  const needsBefore = supervisor.needs.length;
  supervisor.push(`tasks:${SLUG}`, 'gone', {});
  assert.deepEqual(ownFrames.map((f) => [f.type, f.data]).slice(1), [['gone', {}]]);
  assert.equal(hub.current(`tasks:${SLUG}`).gone, true);
  // `now` read the same channel through sessionsView: it is dropped from the set, then followed again.
  assert.deepEqual(supervisor.needs[needsBefore], ['now']);
  await advance(100);
  assert.deepEqual(supervisor.last, ['now', `tasks:${SLUG}`]);
  assert.deepEqual(nowFrames.map((f) => f.type), ['snapshot']);
  assert.deepEqual(ownFrames.map((f) => f.type), ['snapshot', 'gone']);
});

test('events-down and live-unavailable reach every channel; after events-down the next frame is a snapshot', async () => {
  const sections = coreSections();
  const { hub, advance, listen, supervisor } = setup(sections);
  const a = listen(`tasks:${SLUG}`).frames;
  const b = listen(`worker:${RUN_ID}`).frames;
  let unsupported = 0;
  hub.onUnsupported(() => {
    unsupported += 1;
  });
  await advance(100);
  supervisor.down('events-down');
  for (const frames of [a, b]) assert.deepEqual(frames.map((f) => [f.type, f.data]), [['snapshot', { state: frames[0].data.state }], ['error', { code: 'events-down' }]]);
  // The restarted child sends fresh snapshots.
  supervisor.state = 'running';
  supervisor.push(`tasks:${SLUG}`, 'snapshot', { sections: sections[`tasks:${SLUG}`] });
  supervisor.push(`worker:${RUN_ID}`, 'snapshot', { sections: sections[`worker:${RUN_ID}`] });
  await advance(100);
  for (const frames of [a, b]) assert.deepEqual(frames.map((f) => f.type), ['snapshot', 'error', 'snapshot']);
  assert.equal(hub.unsupported, false);
  supervisor.down('live-unavailable');
  for (const frames of [a, b]) assert.deepEqual(frames[frames.length - 1].data, { code: 'live-unavailable' });
  assert.equal(hub.unsupported, true);
  assert.equal(unsupported, 1);
  hub.stop();
  assert.equal(supervisor.stopped, 1);
});

test('core-contract-mismatch: a projector refusal is the channel\'s error, and a later good state is a snapshot', async () => {
  const sections = coreSections();
  sections[`worker:${RUN_ID}`].status = ok({ ...SAMPLES.worker(), disposition: 'refused' });
  sections[`tasks:${SLUG}`].attempts = ok({ ...fixture('attempts'), tasks: null });
  const { hub, advance, listen, supervisor } = setup(sections);
  const worker = listen(`worker:${RUN_ID}`).frames;
  const graph = listen(`tasks:${SLUG}`).frames;
  await advance(100);
  assert.deepEqual(worker.map((f) => [f.type, f.data]), [['error', { code: 'core-contract-mismatch' }]]);
  assert.deepEqual(graph.map((f) => [f.type, f.data]), [['error', { code: 'core-contract-mismatch' }]]);
  assert.equal(hub.current(`worker:${RUN_ID}`).error, 'core-contract-mismatch');
  supervisor.push(`worker:${RUN_ID}`, 'patch', { sections: { status: ok(SAMPLES.worker()) } });
  await advance(100);
  assert.deepEqual(worker.map((f) => f.type), ['error', 'snapshot']);
  // A malformed core frame is a contract break too.
  supervisor.push(`worker:${RUN_ID}`, 'patch', { sections: { status: { exit: 'zero' } } });
  assert.deepEqual(worker[worker.length - 1].data, { code: 'core-contract-mismatch' });
});

// ---- ids, subscribers ----

test('ids: an 8-hex epoch; n starts at 1 and rises by one per frame on each channel; a second subscriber is sent nothing', async () => {
  const sections = coreSections();
  const { hub, advance, listen, supervisor } = setup(sections);
  assert.match(hub.epoch, /^[0-9a-f]{8}$/);
  const first = listen(`tasks:${SLUG}`).frames;
  const worker = listen(`worker:${RUN_ID}`).frames;
  await advance(100);
  supervisor.push(`tasks:${SLUG}`, 'reset', { reason: 'replaced' });
  supervisor.push(`tasks:${SLUG}`, 'snapshot', { sections: sections[`tasks:${SLUG}`] });
  await advance(100);
  assert.deepEqual(first.map((f) => f.n), [1, 2, 3]);
  assert.deepEqual(worker.map((f) => f.n), [1]);
  const late = listen(`tasks:${SLUG}`).frames;
  await advance(100);
  assert.deepEqual(late, []);
  assert.equal(hub.current(`tasks:${SLUG}`).n, 3);
  supervisor.push(`tasks:${SLUG}`, 'error', { code: 'store-unreadable' });
  assert.deepEqual(first.map((f) => f.n), [1, 2, 3, 4]);
  assert.deepEqual(late.map((f) => f.n), [4]);
  const envelope = JSON.parse(envelopeText(hub.epoch, late[0]));
  assert.deepEqual(Object.keys(envelope), ['v', 'ch', 'id', 'type', 'at', 'data']);
  assert.equal(envelope.id, `${hub.epoch}-4`);
  assert.equal(hub.current('now'), null);
});

test('ids: a channel dropped on its last unsubscribe and created again continues from its last n, so an id names one state in the epoch', async () => {
  const { hub, advance, listen, supervisor } = setup(coreSections());
  const ch = `worker:${RUN_ID}`;
  const one = listen(ch);
  await advance(100);
  supervisor.push(ch, 'patch', { sections: { status: ok({ ...SAMPLES.worker(), state: 'exited' }) } });
  await advance(100);
  assert.deepEqual(one.frames.map((f) => `${f.type}@${f.n}`), ['snapshot@1', 'patch@2']);
  one.unsubscribe();
  assert.equal(hub.current(ch), null);
  const two = listen(ch);
  assert.deepEqual(hub.current(ch), { n: 2, state: null, error: null, gone: false }, 'created again, owing a snapshot, at the old n');
  await advance(100);
  assert.deepEqual(two.frames.map((f) => `${f.type}@${f.n}`), ['snapshot@3']);
  assert.equal(two.frames[0].data.state.worker.body.state, 'running');
});

test('subscribers: the last unsubscribe drops the channel and shrinks the need set, to empty at the end', async () => {
  const sections = coreSections();
  const { hub, advance, supervisor } = setup(sections);
  const one = hub.subscribe(`tasks:${SLUG}`, () => {});
  const two = hub.subscribe(`tasks:${SLUG}`, () => {});
  const worker = hub.subscribe(`worker:${RUN_ID}`, () => {});
  await advance(100);
  assert.deepEqual(supervisor.last, [`tasks:${SLUG}`, `worker:${RUN_ID}`]);
  const count = supervisor.needs.length;
  one();
  one();
  assert.equal(supervisor.needs.length, count, 'a channel with a subscriber left keeps its dependencies');
  two();
  assert.equal(hub.current(`tasks:${SLUG}`), null);
  assert.deepEqual(supervisor.last, [`worker:${RUN_ID}`]);
  worker();
  assert.deepEqual(supervisor.last, []);
  assert.equal(supervisor.state, 'stopped');
  assert.throws(() => hub.subscribe('fleet:x', () => {}), TypeError);
});

test('dependencies: a composition that no longer reads a core channel takes it out of the need set', async () => {
  const sections = coreSections();
  const { advance, listen, supervisor } = setup(sections);
  const { frames } = listen('now');
  await advance(100);
  assert.deepEqual(supervisor.last, ['now', `tasks:${SLUG}`]);
  // The feature's run completed: sessionsView inspects no feature, so its tasks channel is not needed.
  const list = fixture('list');
  list.runs = list.runs.map((row: any) => ({ ...row, state: row.state === 'RUNNING' ? 'COMPLETED' : row.state }));
  supervisor.push('now', 'patch', { sections: { list: ok(list) } });
  await advance(100);
  assert.deepEqual(frames.map((f) => f.type), ['snapshot', 'patch']);
  assert.deepEqual(supervisor.last, ['now']);
});

// ---- 150 IC-013: log channels ----

const LOG = `worker:${RUN_ID}:out`;
const ERR = `worker:${RUN_ID}:err`;
const INO = '8812345';
const LOG_ID = /^[0-9]{1,20}:[0-9]{1,16}:[1-9][0-9]{0,15}:[0-9]{1,16}$/;
const SUPPORTED = () => ({ ok: true, json: { v: 1 }, exit: 0 });

/** `count` pieces of `size`-byte lines from `from`, as the core reader cuts them (a piece is its line without the newline). */
function lines(from: number, count: number, size: number, label = 'line') {
  return Array.from({ length: count }, (_, i) => ({ at: from + i * size, text: `${label} ${from + i * size} `.padEnd(size - 1, '.') }));
}
const snap = (from: number, to: number, pieces: any[], extra: Record<string, unknown> = {}) => ({ log: 'open', ino: INO, from, to, pieces, phase: 'running', end: null, ...extra });
const add = (from: number, to: number, pieces: any[], extra: Record<string, unknown> = {}) => ({ from, to, pieces, phase: 'running', end: null, ...extra });
const ats = (pieces: any[]) => pieces.map((piece) => piece.at);

/** A hub whose pooled runner answers `worker-log` with `answer`; `LOG` subscribed; the probe settled. */
async function logSetup(answer: (params: any) => any = SUPPORTED) {
  const runner = realRunner({ 'worker-log': answer });
  const s = setup(coreSections(), runner);
  const log = s.listen(LOG);
  await s.advance(25);
  return { ...s, log };
}

test('log support: one worker-log tail read through the pool on the first log subscribe; no log channel joins the need set before supported', async () => {
  let release: (value: any) => void = () => {};
  const runner = realRunner({ 'worker-log': () => new Promise((resolve) => { release = resolve; }) });
  const { hub, advance, listen, supervisor } = setup(coreSections(), runner);
  const out = listen(LOG);
  const err = listen(ERR);
  listen(`tasks:${SLUG}`);
  await advance(100);
  assert.deepEqual(runner.calls, [{ shape: 'worker-log', params: { runId: RUN_ID, stream: 'out' } }], 'one read, no slug, tail mode, for the first channel');
  for (const set of supervisor.needs) assert.ok(!set.some((ch) => ch.includes(':out') || ch.includes(':err')), `no log channel before supported: ${set}`);
  assert.deepEqual(hub.current(LOG), { n: 0, window: null, error: null, gone: false });
  assert.deepEqual([out.frames, err.frames], [[], []]);
  release(SUPPORTED());
  await advance(25);
  assert.deepEqual(supervisor.last, [`tasks:${SLUG}`, ERR, LOG]);
  // Supported is final: a later log channel joins the set at once, with no second read.
  listen(`worker:w-ba9876543210:out`);
  assert.ok(supervisor.last.includes('worker:w-ba9876543210:out'));
  assert.equal(runner.calls.length, 1);
});

test('log support: a JSON error id is supported; a failure that is not the core\'s answer leaves unknown, and the next subscribe reads again', async () => {
  const answers = [{ ok: false, code: 'core-unreachable', exit: null }, { ok: false, code: 'core-error', exit: 0, reason: 'not-json' }, { ok: false, code: 'core-error', exit: 1, errorId: 'unknown-run' }];
  const runner = realRunner({ 'worker-log': () => answers.shift() });
  const { advance, listen, supervisor } = setup(coreSections(), runner);
  listen(LOG);
  await advance(25);
  assert.ok(!supervisor.last.includes(LOG), 'unknown after core-unreachable');
  listen(LOG);
  await advance(25);
  assert.ok(!supervisor.last.includes(LOG), 'unknown after a reply that is not JSON');
  assert.equal(runner.calls.length, 2, 'a second subscriber on the same channel reads again');
  listen(ERR);
  await advance(25);
  assert.equal(runner.calls.length, 3);
  assert.deepEqual(runner.calls[2].params, { runId: RUN_ID, stream: 'err' });
  assert.deepEqual(supervisor.last, [ERR, LOG]);
});

test('log support: the old-core result is unsupported: every log channel gets error core-lacks-verb and nothing else, and is never subscribed', async () => {
  const { hub, advance, listen, supervisor, runner, log } = await logSetup(() => ({ ...OLD_CORE }));
  assert.deepEqual(log.frames.map((f) => [f.type, f.data]), [['error', { code: 'core-lacks-verb' }]]);
  assert.match(log.frames[0].id, LOG_ID);
  assert.deepEqual(hub.current(LOG), { n: 1, window: null, error: 'core-lacks-verb', gone: false });
  const err = listen(ERR);
  assert.deepEqual(err.frames, [], 'never synchronously');
  await advance(25);
  assert.deepEqual(err.frames.map((f) => [f.type, f.data]), [['error', { code: 'core-lacks-verb' }]]);
  assert.equal(runner.calls.length, 1, 'unsupported is final: no second read');
  // Nothing else: core frames and the child's down codes do not reach an unsupported log channel.
  supervisor.push(LOG, 'snapshot', snap(0, 10, [{ at: 0, text: 'x' }]));
  supervisor.down('events-down');
  await advance(100);
  assert.equal(log.frames.length, 1);
  assert.equal(err.frames.length, 1);
  for (const set of supervisor.needs) assert.ok(!set.includes(LOG) && !set.includes(ERR), `${set}`);
});

/** A fake follow runner for the real events supervisor: every control line a child was sent. */
function followRunner() {
  const sent: string[] = [];
  return {
    sent,
    follow: () => ({
      send(message: { op: string; ch: string }) {
        sent.push(`${message.op} ${message.ch}`);
        return true;
      },
      onLine() {},
      exited: new Promise(() => {}),
      end() {},
    }),
  };
}

test('log support: through the real events supervisor, an older core\'s events child is never sent a log sub; a supported one is (control)', async () => {
  for (const [answer, expected] of [[() => ({ ...OLD_CORE }), ['sub tasks:' + SLUG]], [SUPPORTED, ['sub tasks:' + SLUG, `sub ${LOG}`]]] as const) {
    const clock = fakeClock();
    const follow = followRunner();
    const runner = realRunner({ 'worker-log': answer });
    const hub = createLiveHub({ runner, supervisor: createLiveChild({ runner: follow, clock }), clock });
    hub.subscribe(`tasks:${SLUG}`, () => {});
    const frames: any[] = [];
    hub.subscribe(LOG, (frame: any) => frames.push(frame));
    await settle();
    await settle();
    clock.step(25);
    await settle();
    assert.deepEqual(follow.sent, expected);
    assert.deepEqual(frames.map((f) => f.type), expected.length === 1 ? ['error'] : []);
    hub.stop();
  }
});

test('log window: the core snapshot and appends are forwarded with IC-007 ids from the hub\'s counter and clock; current gives the window', async () => {
  const { hub, advance, supervisor, clock, log } = await logSetup();
  assert.ok(supervisor.last.includes(LOG));
  supervisor.push(LOG, 'snapshot', { log: 'waiting', ino: null, from: 0, to: 0, pieces: [], phase: 'starting', end: null });
  assert.deepEqual(log.frames.map((f) => [f.type, f.data]), [['snapshot', { log: 'waiting', ino: null, from: 0, to: 0, pieces: [], phase: 'starting', end: null }]]);
  assert.equal(log.frames[0].id, `0:0:1:${clock.now()}`);
  await advance(25);
  const first = lines(0, 3, 40);
  supervisor.push(LOG, 'snapshot', snap(0, 120, first));
  supervisor.push(LOG, 'append', add(120, 200, lines(120, 2, 40)));
  supervisor.push(LOG, 'append', add(200, 200, [], { phase: 'ended', end: { capped: false } }));
  assert.deepEqual(log.frames.map((f) => f.type), ['snapshot', 'snapshot', 'append', 'append']);
  assert.deepEqual(log.frames[1].data, snap(0, 120, first));
  assert.deepEqual(log.frames[2].data, add(120, 200, lines(120, 2, 40)));
  assert.deepEqual(log.frames[3].data, add(200, 200, [], { phase: 'ended', end: { capped: false } }));
  for (const [i, frame] of log.frames.entries()) {
    assert.match(frame.id, LOG_ID);
    assert.equal(frame.n, i + 1);
    assert.equal(JSON.parse(envelopeText(hub.epoch, frame)).id, frame.id, 'the envelope carries the log id');
  }
  assert.equal(log.frames[3].id, `${INO}:200:4:${clock.now()}`);
  assert.deepEqual(hub.current(LOG), { n: 4, window: { ...snap(0, 200, lines(0, 5, 40)), phase: 'ended', end: { capped: false } }, error: null, gone: false });
  // current hands out a copy.
  hub.current(LOG).window.pieces.push({ at: 999, text: 'mutated' });
  assert.equal(hub.current(LOG).window.pieces.length, 5);
});

test('log window: at most HUB_WINDOW_BYTES, trimmed from the front at piece boundaries; every append is still forwarded whole', async () => {
  assert.equal(HUB_WINDOW_BYTES, 131_072);
  const { hub, supervisor, log } = await logSetup();
  supervisor.push(LOG, 'snapshot', snap(0, 100_000, lines(0, 1_000, 100)));
  let to = 100_000;
  for (let k = 0; k < 10; k += 1) {
    const pieces = lines(to, 7, 1_000, `batch${k}`);
    supervisor.push(LOG, 'append', add(to, to + 7_000, pieces));
    assert.deepEqual(log.frames[log.frames.length - 1].data, add(to, to + 7_000, pieces));
    to += 7_000;
    const { window } = hub.current(LOG);
    assert.ok(window.to - window.from <= HUB_WINDOW_BYTES, `${window.to - window.from}`);
    assert.equal(window.from, window.pieces[0].at, 'the window starts at a piece');
    assert.equal(window.to, to);
  }
  const { window } = hub.current(LOG);
  // 170000 bytes were sent; the window keeps the newest whole pieces under the bound.
  assert.equal(window.from, 170_000 - HUB_WINDOW_BYTES + (100 - ((170_000 - HUB_WINDOW_BYTES) % 100)) % 100);
  assert.deepEqual(ats(window.pieces), [...ats(lines(0, 1_000, 100)), ...Array.from({ length: 70 }, (_, i) => 100_000 + i * 1_000)].filter((at) => at >= window.from));
});

test('log window: a restarted child\'s snapshot of the same file merges into one append with nothing repeated; another inode or a gap replaces it', async () => {
  const { hub, advance, supervisor, log } = await logSetup();
  supervisor.push(LOG, 'snapshot', snap(0, 300, lines(0, 3, 100)));
  supervisor.push(LOG, 'append', add(300, 400, lines(300, 1, 100)));
  supervisor.down('events-down');
  assert.deepEqual(log.frames[log.frames.length - 1].data, { code: 'events-down' });
  assert.equal(hub.current(LOG).error, 'events-down');
  assert.deepEqual(ats(hub.current(LOG).window.pieces), [0, 100, 200, 300], 'the window outlives the child');
  supervisor.state = 'running';
  // The restarted child's tail page starts inside the window and runs past it.
  supervisor.push(LOG, 'snapshot', snap(100, 500, lines(100, 4, 100)));
  await advance(25);
  const merged = log.frames[log.frames.length - 1];
  assert.equal(merged.type, 'append');
  assert.deepEqual(merged.data, add(400, 500, lines(400, 1, 100)));
  assert.equal(hub.current(LOG).error, null);
  // Every byte reached the browser once, in order.
  const sent = log.frames.filter((f) => f.type === 'snapshot' || f.type === 'append').flatMap((f) => f.data.pieces);
  assert.deepEqual(ats(sent), [0, 100, 200, 300, 400]);
  // A snapshot that ends at the window's end adds nothing new: one empty append, still no repeat.
  supervisor.push(LOG, 'snapshot', snap(300, 500, lines(300, 2, 100)));
  assert.deepEqual(log.frames[log.frames.length - 1].data, add(500, 500, []));
  assert.deepEqual(ats(hub.current(LOG).window.pieces), [0, 100, 200, 300, 400]);

  // Another inode: replaced, as a snapshot.
  supervisor.push(LOG, 'snapshot', { ...snap(0, 100, lines(0, 1, 100, 'new')), ino: '9900' });
  assert.deepEqual(log.frames[log.frames.length - 1].data, { ...snap(0, 100, lines(0, 1, 100, 'new')), ino: '9900' });
  assert.equal(log.frames[log.frames.length - 1].type, 'snapshot');
  // From past the window's end (a gap): replaced.
  supervisor.push(LOG, 'snapshot', { ...snap(5_000, 5_100, lines(5_000, 1, 100)), ino: '9900' });
  assert.equal(log.frames[log.frames.length - 1].type, 'snapshot');
  assert.deepEqual(hub.current(LOG).window.from, 5_000);
  // A shorter file under the same inode, or a log state change, is not merged either.
  supervisor.push(LOG, 'snapshot', { ...snap(0, 50, [{ at: 0, text: 'short' }]), ino: '9900' });
  assert.equal(log.frames[log.frames.length - 1].type, 'snapshot');
  supervisor.push(LOG, 'snapshot', { log: 'none', ino: null, from: 0, to: 0, pieces: [], phase: 'ended', end: null });
  assert.deepEqual(log.frames[log.frames.length - 1].data, { log: 'none', ino: null, from: 0, to: 0, pieces: [], phase: 'ended', end: null });
});

test('log window: reset clears it and the next snapshot replaces it; error is forwarded and keeps it; gone ends the channel', async () => {
  const { hub, supervisor, log, clock } = await logSetup();
  supervisor.push(LOG, 'snapshot', snap(0, 200, lines(0, 2, 100)));
  supervisor.push(LOG, 'reset', { reason: 'replaced' });
  assert.deepEqual(log.frames[1].data, { reason: 'replaced' });
  assert.equal(log.frames[1].id, `${INO}:200:2:${clock.now()}`, 'a reset id carries the last inode and to');
  assert.deepEqual(hub.current(LOG), { n: 2, window: null, error: null, gone: false });
  supervisor.push(LOG, 'snapshot', { ...snap(0, 50, [{ at: 0, text: 'again' }]), ino: '77' });
  assert.equal(log.frames[2].type, 'snapshot');
  supervisor.push(LOG, 'error', { code: 'unsupported-version' });
  supervisor.push(LOG, 'error', { code: 'something-new' });
  assert.deepEqual(log.frames.slice(3).map((f) => f.data), [{ code: 'unsupported-version' }, { code: 'core-contract-mismatch' }]);
  assert.equal(log.frames[3].id.split(':').slice(0, 2).join(':'), '77:50');
  assert.equal(hub.current(LOG).error, 'core-contract-mismatch');
  assert.equal(hub.current(LOG).window.to, 50, 'an error keeps the window');
  // Malformed core data and a patch are contract breaks too; an append before any snapshot is one.
  const other = await logSetup();
  other.supervisor.push(LOG, 'append', add(0, 10, []));
  other.supervisor.push(LOG, 'snapshot', snap(0, 10, [{ at: 0, text: 7 }]));
  assert.deepEqual(other.log.frames.map((f) => [f.type, f.data]), [['error', { code: 'core-contract-mismatch' }]]);
  other.supervisor.push(LOG, 'snapshot', snap(0, 10, [{ at: 0, text: 'fine' }]));
  other.supervisor.push(LOG, 'patch', { sections: {} });
  assert.deepEqual(other.log.frames.map((f) => f.type), ['error', 'snapshot', 'error']);

  assert.ok(supervisor.last.includes(LOG));
  supervisor.push(LOG, 'gone', {});
  assert.equal(log.frames[log.frames.length - 1].type, 'gone');
  assert.deepEqual(hub.current(LOG), { n: log.frames.length, window: null, error: 'core-contract-mismatch', gone: true });
  assert.ok(!supervisor.last.includes(LOG), 'a gone channel leaves the need set');
  supervisor.push(LOG, 'append', add(50, 60, [{ at: 50, text: 'late' }]));
  assert.equal(log.frames[log.frames.length - 1].type, 'gone', 'nothing after gone');
});

test('log frames: a browser frame over LIVE_FRAME_BUDGET is split at piece boundaries into consecutive appends; a piece that fits no frame is withheld', async () => {
  const { hub, supervisor, log } = await logSetup();
  // Ten pieces of 30000 characters inside the window's 131072 bytes (text the second mask pass grew, or
  // multi-byte text): 300 KB of JSON, over the 258048-byte budget.
  const big = Array.from({ length: 10 }, (_, i) => ({ at: i * 13_000, text: String.fromCharCode(97 + i).repeat(30_000) }));
  supervisor.push(LOG, 'snapshot', snap(0, 130_000, big));
  const types = log.frames.map((f) => f.type);
  assert.equal(types[0], 'snapshot');
  assert.ok(types.length >= 2 && types.slice(1).every((type) => type === 'append'), types.join());
  let at = 0;
  for (const [i, frame] of log.frames.entries()) {
    assert.ok(Buffer.byteLength(envelopeText(hub.epoch, frame), 'utf8') <= LIVE_FRAME_BUDGET);
    assert.equal(frame.data.from, at, 'each from is the previous to');
    assert.equal(frame.n, i + 1);
    assert.equal(frame.id.split(':')[1], String(frame.data.to));
    at = frame.data.to;
  }
  assert.equal(at, 130_000);
  assert.deepEqual(log.frames.flatMap((f) => f.data.pieces), big, 'every piece once, in order');

  // A piece whose JSON alone is over the budget: 50000 control characters escape to 300000 bytes.
  const huge = { at: 130_000, text: '\u0001'.repeat(50_000) };
  const before = log.frames.length;
  supervisor.push(LOG, 'append', add(130_000, 130_101, [huge, { at: 130_100, text: 'after' }]));
  const last = log.frames.slice(before);
  assert.deepEqual(last.map((f) => f.type), ['append']);
  assert.deepEqual(last[0].data, add(130_000, 130_101, [{ at: 130_000, text: '', withheld: true }, { at: 130_100, text: 'after' }]));
  // Split and withheld together: a 150 KB piece, an unfit piece, and another 150 KB piece.
  const first = { at: 130_101, text: 'y'.repeat(150_000) };
  const unfit = { at: 130_200, text: '\u0001'.repeat(50_000) };
  const third = { at: 130_300, text: 'z'.repeat(150_000) };
  supervisor.push(LOG, 'append', add(130_101, 130_400, [first, unfit, third]));
  const split = log.frames.slice(before + 1);
  assert.deepEqual(split.map((f) => [f.type, f.data.from, f.data.to]), [['append', 130_101, 130_200], ['append', 130_200, 130_400]]);
  assert.deepEqual(split.map((f) => f.data.pieces), [[first], [{ at: 130_200, text: '', withheld: true }, third]]);
  assert.deepEqual(split.map((f) => f.n), [log.frames[before].n + 1, log.frames[before].n + 2]);
  for (const frame of log.frames) assert.ok(Buffer.byteLength(envelopeText(hub.epoch, frame), 'utf8') <= LIVE_FRAME_BUDGET);
  const kept = hub.current(LOG).window.pieces.find((piece: any) => piece.at === 130_000);
  assert.deepEqual(kept, { at: 130_000, text: '', withheld: true }, 'the window holds what was sent');
});

test('log frames: every piece text passes maskLite before it is kept or sent; planted values reach no frame and no window', async () => {
  const { hub, supervisor, log } = await logSetup();
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const EMAIL = 'planted.person@example.com';
  const planted = [{ at: 0, text: `token ${TOKEN}` }, { at: 50, text: `mail ${EMAIL}`, cut: true }];
  supervisor.push(LOG, 'snapshot', snap(0, 100, planted));
  supervisor.push(LOG, 'append', add(100, 200, [{ at: 100, text: `Authorization: Bearer ${TOKEN}` }, { at: 150, text: 'from 10.1.2.3' }]));
  supervisor.down('events-down');
  supervisor.state = 'running';
  supervisor.push(LOG, 'snapshot', snap(0, 250, [...planted, { at: 100, text: 'x' }, { at: 150, text: 'y' }, { at: 200, text: `again ${TOKEN}` }]));
  const text = JSON.stringify(log.frames) + JSON.stringify(hub.current(LOG));
  for (const value of [TOKEN, EMAIL, '10.1.2.3']) assert.ok(!text.includes(value), value);
  assert.deepEqual(log.frames[0].data.pieces, [{ at: 0, text: maskLite(`token ${TOKEN}`) }, { at: 50, text: maskLite(`mail ${EMAIL}`), cut: true }]);
  assert.notEqual(log.frames[0].data.pieces[0].text, `token ${TOKEN}`, 'the control: the mask changed the text');
  assert.deepEqual(log.frames[log.frames.length - 1].data.pieces, [{ at: 200, text: maskLite(`again ${TOKEN}`) }]);
});

test('NFR-008: no pooled verb call per append and none on a timer; worker-log is read once per hub', async () => {
  const { advance, supervisor, runner, listen } = await logSetup();
  listen(ERR);
  supervisor.push(LOG, 'snapshot', snap(0, 0, []));
  supervisor.push(ERR, 'snapshot', snap(0, 0, []));
  for (let k = 0; k < 50; k += 1) {
    supervisor.push(LOG, 'append', add(k * 10, k * 10 + 10, [{ at: k * 10, text: `line ${k}` }]));
    supervisor.push(ERR, 'append', add(k * 10, k * 10 + 10, [{ at: k * 10, text: `warn ${k}` }]));
    await advance(25);
  }
  await advance(60_000);
  assert.deepEqual(runner.calls.map((call) => call.shape), ['worker-log']);
});

test('log channels: events-down reaches them and a channel made while the child is down learns so, never synchronously; the last unsubscribe drops one and keeps its n', async () => {
  const { hub, advance, supervisor, log, listen } = await logSetup();
  supervisor.push(LOG, 'snapshot', snap(0, 10, [{ at: 0, text: 'a' }]));
  supervisor.down('events-down');
  assert.deepEqual(log.frames.map((f) => f.type), ['snapshot', 'error']);
  const err = listen(ERR);
  assert.deepEqual(err.frames, []);
  await advance(25);
  assert.deepEqual(err.frames.map((f) => [f.type, f.data]), [['error', { code: 'events-down' }]]);
  supervisor.down('live-unavailable');
  assert.deepEqual(log.frames[log.frames.length - 1].data, { code: 'live-unavailable' });
  err.unsubscribe();
  assert.equal(hub.current(ERR), null);
  const again = listen(ERR);
  assert.equal(hub.current(ERR).n, 2, 'created again at its last n');
  await advance(25);
  assert.deepEqual(again.frames.map((f) => f.n), [3]);
  log.unsubscribe();
  again.unsubscribe();
  assert.ok(!supervisor.last.includes(LOG) && !supervisor.last.includes(ERR));
});
