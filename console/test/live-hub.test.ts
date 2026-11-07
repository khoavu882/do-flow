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
const { createLiveHub, diffState, envelopeText, isChannel, parseChannel, resultOf, LIVE_FRAME_BUDGET, MAX_POINTER_DEPTH } = require('../src/live.ts');
const { runs, tasks, runDetail, sessionsView } = require('../src/routes.ts');
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
};

type Section = { exit: number, json: any };
const ok = (json: any): Section => ({ exit: 0, json });

/** The sections of each core channel the cases use, as the events verb would print them. */
function coreSections(): Record<string, Record<string, Section>> {
  return {
    now: { list: ok(fixture('list')), observed: ok(SAMPLES.observed()), slots: ok(SAMPLES.slots()), roadmap: ok(SAMPLES.roadmap()) },
    [`run:${SLUG}:${TASK}`]: { status: ok(fixture('status')), timeline: ok(fixture('timeline')) },
    [`tasks:${SLUG}`]: { attempts: ok(fixture('attempts')), 'worker:A.1:1': ok(SAMPLES.noWorker()) },
    [`worker:${RUN_ID}`]: { status: ok(SAMPLES.worker()) },
  };
}

/** The verb runner: every call recorded; `workflow` answers the fixture. */
function realRunner() {
  const calls: Array<{ shape: string, params: any }> = [];
  return {
    calls,
    run: async (shape: string, params: any) => {
      calls.push({ shape, params });
      return shape === 'workflow' ? { ok: true, json: fixture('workflow'), exit: 0 } : { ok: false, code: 'core-unreachable', exit: null };
    },
  };
}

/** A plain runner over `sections` with the IC-010 table written out by hand, and `workflow` from the fixture. */
function plainRunner(sections: Record<string, Record<string, Section>>) {
  const at = (channel: string, name: string) => resultOf(sections[channel][name]);
  return {
    run: async (shape: string, params: any = {}) => {
      if (shape === 'workflow') return { ok: true, json: fixture('workflow'), exit: 0 };
      if (['list', 'observed', 'slots', 'roadmap'].includes(shape)) return at('now', shape);
      if (shape === 'status' || shape === 'timeline') return at(`run:${params.slug}:${params.taskId}`, shape);
      if (shape === 'attempts') return at(`tasks:${params.slug}`, 'attempts');
      if (shape === 'worker-status') return at(`tasks:${params.slug}`, `worker:${params.task}:${params.token}`);
      throw new Error(`unexpected shape ${shape}`);
    },
  };
}

const member = (reply: any) => ({ status: reply.status, body: JSON.parse(reply.body) });

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

function setup(serve: Record<string, Record<string, Section>> | null = coreSections()) {
  const clock = fakeClock();
  const supervisor = fakeSupervisor(serve);
  const runner = realRunner();
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

test('tasks: the tasks member is {tasks, tasksReason?} as runDetail builds it, or its error reply', async () => {
  const sections = coreSections();
  const { advance, listen, runner } = setup(sections);
  const { frames } = listen(`tasks:${SLUG}`);
  await advance(100);
  const graph = await tasks(plainRunner(sections), SLUG);
  assert.equal(graph.ok, true);
  const run = member(await runDetail(plainRunner(sections), SLUG, TASK));
  assert.deepEqual(frames[0].data.state, { tasks: { status: 200, body: { tasks: graph.tasks } } });
  assert.deepEqual(frames[0].data.state.tasks.body.tasks, run.body.tasks);
  assert.equal(Object.hasOwn(run.body, 'tasksReason'), false);

  // No plan: tasks null with tasksReason, the same fields runDetail puts in the run body.
  const noPlan = coreSections();
  noPlan[`tasks:${SLUG}`].attempts = { exit: 2, json: { error: 'plan-unreadable', message: 'no plan.md' } };
  const second = setup(noPlan);
  const listener = second.listen(`tasks:${SLUG}`);
  await second.advance(100);
  const body = member(await runDetail(plainRunner(noPlan), SLUG, TASK)).body;
  assert.deepEqual(listener.frames[0].data.state, { tasks: { status: 200, body: { tasks: body.tasks, tasksReason: body.tasksReason } } });
  assert.deepEqual(listener.frames[0].data.state.tasks.body, { tasks: null, tasksReason: 'no-plan' });

  // Any other failed inspect: the tasks member is the IC-005 error reply.
  const broken = coreSections();
  broken[`tasks:${SLUG}`].attempts = { exit: 2, json: { error: 'store-unreadable' } };
  const third = setup(broken);
  const failed = third.listen(`tasks:${SLUG}`);
  await third.advance(100);
  const reply = await tasks(plainRunner(broken), SLUG);
  assert.equal(reply.ok, false);
  assert.deepEqual(failed.frames[0].data.state, { tasks: member(reply.reply) });
  assert.deepEqual(failed.frames[0].data.state.tasks, { status: 502, body: { error: { code: 'core-error', verb: 'attempts', exit: 2 } } });
  assert.deepEqual([...runner.calls, ...second.runner.calls, ...third.runner.calls], []);
});

test('worker: the projected worker-status body, null for an attempt with no worker run, and a failed status as its error reply', async () => {
  const { advance, listen, runner } = setup();
  const { frames } = listen(`worker:${RUN_ID}`);
  await advance(100);
  const projected = project('worker-status', SAMPLES.worker());
  assert.equal(projected.ok, true);
  assert.deepEqual(frames[0].data.state, { worker: { status: 200, body: projected.body } });

  const none = coreSections();
  none[`worker:${RUN_ID}`].status = ok(SAMPLES.noWorker());
  const second = setup(none);
  const nothing = second.listen(`worker:${RUN_ID}`);
  await second.advance(100);
  assert.deepEqual(nothing.frames[0].data.state, { worker: { status: 200, body: null } });

  const failing = coreSections();
  failing[`worker:${RUN_ID}`].status = { exit: 1, json: { error: 'run-not-found' } };
  const third = setup(failing);
  const failed = third.listen(`worker:${RUN_ID}`);
  await third.advance(100);
  assert.deepEqual(failed.frames[0].data.state, { worker: { status: 502, body: { error: { code: 'core-error', verb: 'worker-status', exit: 1 } } } });
  assert.deepEqual([...runner.calls, ...second.runner.calls, ...third.runner.calls], []);
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

test('channels: the IC-003 grammar with the core length bound', () => {
  for (const good of ['now', 'run:feat-a:A.3', 'tasks:feat_a', `worker:${RUN_ID}`, `tasks:${'a'.repeat(56)}`]) assert.equal(isChannel(good), true, good);
  for (const bad of ['', 'now:x', 'run:a', 'run:a:b:c', 'run:-a:b', 'run:.a:b', 'tasks:a/b', `tasks:${'a'.repeat(57)}`, 'worker:w-0123', 'worker:w-0123456789AB',
    `worker:${RUN_ID}:out`, 'transcript:x', 'followups', 'fleet:x', 'tasks:', 'tasks:a b']) {
    assert.equal(isChannel(bad), false, bad);
  }
  assert.deepEqual(parseChannel('run:feat-a:A.3'), { kind: 'run', name: 'run:feat-a:A.3', slug: 'feat-a', taskId: 'A.3' });
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
