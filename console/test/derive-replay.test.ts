'use strict';

// The replay fold (feature 093, IC-014; plan task E.4; design.md section 7 V5, D-12). Pure functions over the run route's
// body: no DOM and no fetch. The walk cases run the REAL core (the C.2 fixture project, bin/doflow.js), project each read
// as the Console does and check the fold against the live derivation: `stateAt(last)` equals it for every fixture run, and
// `stateAt(k)` equals what the browser held after step k. Control: sorting by time only (no source tiebreak) turns the
// same-time case red (the control rewrites a copy of derive/replay.js and re-runs the same case).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { buildFixture, CORE_CLI } = require('./helpers/core-fixture.ts');
const { project } = require('../src/project.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const REPLAY_SOURCE = fs.readFileSync(path.join(WEB_ROOT, 'derive', 'replay.js'), 'utf8');
const MIN = 60_000;
const T0 = Date.parse('2026-10-26T10:00:00.000Z');

let scratch: string[] = [];
let replay: any;
let graph: any;
let rail: any;

/** A copy of the derive/ directory (optionally with replay.js rewritten) as ES modules a CommonJS package can import. */
async function load(source: string = REPLAY_SOURCE): Promise<{ replay: any, graph: any, rail: any }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-replay-'));
  scratch.push(dir);
  fs.cpSync(path.join(WEB_ROOT, 'derive'), path.join(dir, 'derive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'derive', 'replay.js'), source);
  const href = (name: string) => pathToFileURL(path.join(dir, 'derive', name)).href;
  return { replay: await import(href('replay.js')), graph: await import(href('graph.js')), rail: await import(href('rail.js')) };
}

before(async () => { ({ replay, graph, rail } = await load()); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

// ---- bodies -----------------------------------------------------------------------------------------------

const iso = (min: number) => new Date(T0 + min * MIN).toISOString();
const ev = (min: number | null, action: string, node: string | null = null, over: any = {}) => ({
  at: min === null ? null : iso(min), action, node, outcome: null, decision: null, forced: false, synthetic: false, ...over,
});
const tl = (events: any[]) => ({ v: 1, taskId: 'run-1', featureSlug: 'feat-a', revision: 5, startedAt: iso(0), events, otherEvents: 0 });
const att = (token: number, owner: string, state: string, startMin: number | null, endMin: number | null = null, over: any = {}) => ({
  token, owner, mode: 'subagent', state, startedAt: startMin === null ? null : iso(startMin), endedAt: endMin === null ? null : iso(endMin), result: null, ...over,
});
const gt = (id: string, phase: string, deps: string[] = []) => ({ id, phase, owner: 'core-implementer', taskDeps: deps, parallel: false });
const body = (graphTasks: any[], rows: any[]) => ({ revision: 1, graph: { digest: 'd', tasks: graphTasks }, tasks: rows });
const trow = (id: string, attempts: any[], limit = 3) => ({ id, state: 'READY', reason: 'ready', budget: { used: attempts.length, limit }, attempts });

const WORKFLOW = {
  taskClass: 'x', name: 'X Flow',
  stages: [
    { id: 'plan', kind: 'planning', optional: false, skill: 's', agent: 'a', purpose: 'p', gatesAfter: [{ id: 'gate-p', kind: 'approval', trigger: 'always', name: 'n', prompt: 'q' }] },
    { id: 'extra', kind: 'verification', optional: true, skill: 's', agent: 'a', purpose: 'p', gatesAfter: [] },
    { id: 'build', kind: 'implementation', optional: false, skill: 's', agent: 'a', purpose: 'p', gatesAfter: [] },
  ],
};
// program: plan, gate-p, extra, build (4 nodes)
const RUN = { taskId: 'run-1', featureSlug: 'feat-a', taskClass: 'x', state: 'COMPLETED', current: null, progress: { done: 4, total: 4 }, startedAt: iso(0), updatedAt: iso(40), origin: 'current' };
const RUN_EVENTS = [
  ev(0, 'start'), ev(5, 'complete-stage', 'plan', { outcome: 'passed' }), ev(8, 'decide-gate', 'gate-p', { decision: 'approve' }),
  ev(12, 'skip-stage', 'extra'), ev(30, 'complete-stage', 'build', { outcome: 'passed' }), ev(31, 'complete-run'),
];
const baseOf = (events: any[], tasks: any = null, run: any = RUN) => ({ run, workflow: WORKFLOW, timeline: tl(events), tasks });
const kinds = (events: any[]) => events.map((e) => `${e.source}:${e.kind}${e.taskId ? `:${e.taskId}.${e.no}` : ''}`);

// ---- the merge order ----------------------------------------------------------------------------------------

/** Run events and attempt events at the very same moments: the order must come from the rule, not from the gathering. */
function sameTime(mod: any) {
  const tasks = body([gt('A.1', 'A')], [trow('A.1', [att(1, 'core-implementer', 'finished', 5, 5, { result: 'COMPLETED' }), att(2, 'quality-guardian', 'active', 8)])]);
  return mod.mergeEvents(tl([ev(0, 'start'), ev(5, 'complete-stage', 'plan'), ev(8, 'decide-gate', 'gate-p', { decision: 'approve' })]), tasks);
}
const SAME_TIME_ORDER = ['run:start', 'run:complete-stage', 'task:claim:A.1.1', 'task:finish:A.1.1', 'run:decide-gate', 'task:claim:A.1.2'];

test('merge order: time, then source (run before task), then original order, with claim before its own end at one moment', () => {
  assert.deepEqual(kinds(sameTime(replay)), SAME_TIME_ORDER);
  const merged = sameTime(replay);
  assert.deepEqual(merged.map((e: any) => e.index), [0, 1, 2, 3, 4, 5]);
  assert.ok(merged.every((e: any) => !e.untimed));
});

test('merge order: events keep time order across sources, and a run with no attempts is its journal order', () => {
  const tasks = body([gt('A.1', 'A')], [trow('A.1', [att(1, 'core-implementer', 'finished', 6, 7, { result: 'FAILED' })])]);
  const merged = replay.mergeEvents(tl(RUN_EVENTS), tasks);
  assert.deepEqual(kinds(merged), ['run:start', 'run:complete-stage', 'task:claim:A.1.1', 'task:finish:A.1.1', 'run:decide-gate', 'run:skip-stage', 'run:complete-stage', 'run:complete-run']);
  assert.deepEqual(kinds(replay.mergeEvents(tl(RUN_EVENTS), null)), RUN_EVENTS.map((e) => `run:${e.action}`));
  assert.deepEqual(replay.mergeEvents(null, null), []);
  assert.deepEqual(replay.mergeEvents({ events: 'x' }, { tasks: 'x' }), [], 'unusable bodies give no events');
});

test('untimed events come after the last timed one, marked, in source then original order', () => {
  const tasks = body([gt('A.1', 'A')], [trow('A.1', [att(1, 'core-implementer', 'finished', null, null, { result: 'COMPLETED' }), att(2, 'quality-guardian', 'cancelled', 50, null)])]);
  const events = [ev(null, 'annotate', 'plan'), ev(0, 'start'), ev(5, 'complete-stage', 'plan'), ev(null, 'annotate', 'build')];
  const merged = replay.mergeEvents(tl(events), tasks);
  assert.deepEqual(kinds(merged), ['run:start', 'run:complete-stage', 'task:claim:A.1.2', 'run:annotate', 'run:annotate', 'task:claim:A.1.1', 'task:finish:A.1.1', 'task:cancel:A.1.2']);
  assert.deepEqual(merged.map((e: any) => e.untimed), [false, false, false, true, true, true, true, true]);
  assert.ok(merged.filter((e: any) => e.untimed).every((e: any) => e.at === null && e.ms === null));
  assert.equal(merged.findIndex((e: any) => e.untimed), 3, 'the first untimed event is right after the last timed one');
});

test('control: sorting by time only (no source tiebreak) turns the same-time case red', async () => {
  const line = 'return SOURCE_RANK[/** @type {\'run\' | \'task\'} */ (a.source)] - SOURCE_RANK[/** @type {\'run\' | \'task\'} */ (b.source)] || a.original - b.original;';
  assert.ok(REPLAY_SOURCE.includes(line), 'the tiebreak line is where the control expects it');
  const mutated = (await load(REPLAY_SOURCE.replace(line, 'return 0;'))).replay;
  assert.deepEqual(kinds(sameTime(replay)), SAME_TIME_ORDER);
  assert.notDeepEqual(kinds(sameTime(mutated)), SAME_TIME_ORDER, 'without the tiebreak the order changes: the case turns red');
});

// ---- the fold -----------------------------------------------------------------------------------------------

test('the fold walks the run: cursor and node states after each run event, a skipped stage and COMPLETED past the end', () => {
  const base = baseOf(RUN_EVENTS);
  const events = replay.mergeEvents(base.timeline, null);
  const seen = events.map((_: any, i: number) => {
    const s = replay.stateAt(events, i, base);
    return [s.row.state, s.row.current ? s.row.current.id : null, s.cursor, s.nodes.map((n: any) => n.state).join(',')];
  });
  assert.deepEqual(seen, [
    ['RUNNING', 'plan', 0, 'running,pending,pending,pending'],
    ['AWAITING_GATE', 'gate-p', 1, 'done,awaiting,pending,pending'],
    ['RUNNING', 'extra', 2, 'done,done,running,pending'],
    ['RUNNING', 'build', 3, 'done,done,skipped,running'],
    ['COMPLETED', null, 4, 'done,done,skipped,done'],
    ['COMPLETED', null, 4, 'done,done,skipped,done'],
  ]);
});

test('a rejected gate stops the run there and the rest was not reached', () => {
  const base = baseOf([ev(0, 'start'), ev(5, 'complete-stage', 'plan'), ev(8, 'decide-gate', 'gate-p', { decision: 'reject' })], null, { ...RUN, state: 'REJECTED', current: { type: 'gate', id: 'gate-p', kind: 'approval' }, progress: { done: 1, total: 4 } });
  const events = replay.mergeEvents(base.timeline, null);
  const last = replay.stateAt(events, events.length - 1, base);
  assert.equal(last.row.state, 'REJECTED');
  assert.deepEqual(last.nodes.map((n: any) => n.state), ['done', 'rejected', 'not-reached', 'not-reached']);
  assert.equal(last.degraded, null);
});

test('an event with no time cannot move the run back: the cursor only moves forward', () => {
  const base = baseOf([ev(0, 'start'), ev(null, 'complete-stage', 'plan'), ev(8, 'decide-gate', 'gate-p', { decision: 'approve' })]);
  const events = replay.mergeEvents(base.timeline, null);
  assert.deepEqual(kinds(events), ['run:start', 'run:decide-gate', 'run:complete-stage']);
  const last = replay.stateAt(events, 2, base);
  assert.equal(last.cursor, 2, 'both events are in: the cursor is past the gate');
  assert.deepEqual(last.timeline.events.map((e: any) => e.action), ['start', 'complete-stage', 'decide-gate'], 'the timeline slice is back in journal order');
});

test('the task fold: attempts as far as they had got, and the state those attempts give', () => {
  const tasks = body(
    [gt('A.1', 'A'), gt('A.2', 'A'), gt('B.1', 'B', ['A.1']), gt('B.2', 'B')],
    [
      trow('A.1', [att(1, 'core-implementer', 'finished', 1, 9, { result: 'FAILED' }), att(2, 'core-implementer', 'finished', 10, 20, { result: 'COMPLETED' })]),
      trow('A.2', [att(1, 'quality-guardian', 'released', 2, 6), att(2, 'quality-guardian', 'active', 7)]),
      trow('B.1', []),
      trow('B.2', []),
    ],
  );
  const events = replay.mergeEvents(tl([ev(0, 'start')]), tasks);
  const at = (minute: number) => {
    const i = events.reduce((best: number, e: any, k: number) => (e.ms !== null && e.ms <= T0 + minute * MIN ? k : best), 0);
    const rows = replay.stateAt(events, i, baseOf([ev(0, 'start')], tasks)).tasks.tasks;
    return Object.fromEntries(rows.map((r: any) => [r.id, `${r.state}/${r.reason}/${r.attempts.map((a: any) => a.state).join('+')}/${r.budget.used}`]));
  };
  assert.deepEqual(at(1), { 'A.1': 'RUNNING/active-attempt/active/1', 'A.2': 'READY/ready//0', 'B.1': 'PLANNED/unmet-dependency//0', 'B.2': 'PLANNED/unmet-phase//0' });
  assert.deepEqual(at(9), { 'A.1': 'FAILED/failed/finished/1', 'A.2': 'RUNNING/active-attempt/released+active/2', 'B.1': 'PLANNED/dependency-held//0', 'B.2': 'PLANNED/unmet-phase//0' });
  assert.deepEqual(at(10), { 'A.1': 'RUNNING/active-attempt/finished+active/2', 'A.2': 'RUNNING/active-attempt/released+active/2', 'B.1': 'PLANNED/unmet-dependency//0', 'B.2': 'PLANNED/unmet-phase//0' });
  assert.deepEqual(at(60), { 'A.1': 'SUCCEEDED/completed/finished+finished/2', 'A.2': 'RUNNING/active-attempt/released+active/2', 'B.1': 'READY/ready//0', 'B.2': 'PLANNED/unmet-phase//0' });
});

test('a task at its attempt budget reads Blocked, and a cancelled attempt reads Cancelled', () => {
  const tasks = body([gt('A.1', 'A'), gt('A.2', 'A')], [
    trow('A.1', [att(1, 'o', 'finished', 1, 2, { result: 'FAILED' }), att(2, 'o', 'finished', 3, 4, { result: 'FAILED' })], 2),
    trow('A.2', [att(1, 'o', 'cancelled', 1, 2)], 3),
  ]);
  const events = replay.mergeEvents(tl([ev(0, 'start')]), tasks);
  const rows = replay.stateAt(events, events.length - 1, baseOf([ev(0, 'start')], tasks)).tasks.tasks;
  assert.deepEqual(rows.map((r: any) => `${r.state}/${r.reason}`), ['BLOCKED/budget', 'CANCELLED/cancelled']);
  const early = replay.stateAt(events, 0, baseOf([ev(0, 'start')], tasks)).tasks.tasks;
  assert.deepEqual(early.map((r: any) => r.attempts.length), [0, 0], 'before the first claim nothing has been attempted');
});

test('the task rows feed the graph layout: the lane of a task is its active attempt owner at that moment', () => {
  const tasks = body([gt('A.1', 'A')], [trow('A.1', [att(1, 'quality-guardian', 'finished', 1, 5, { result: 'COMPLETED' })])]);
  const events = replay.mergeEvents(tl([ev(0, 'start')]), tasks);
  const laneAt = (i: number) => {
    const merged = graph.mergeTasks(replay.stateAt(events, i, baseOf([ev(0, 'start')], tasks)).tasks);
    return graph.layoutGraph(merged, graph.attemptsByTask(merged)).cards[0].owner;
  };
  const claim = events.findIndex((e: any) => e.kind === 'claim');
  assert.equal(laneAt(claim), 'quality-guardian', 'while the attempt is active its owner is the lane');
  assert.equal(laneAt(events.length - 1), 'core-implementer', 'afterwards the declared owner is');
});

test('a run with no readable timeline or workflow keeps its live row; the task rows still replay', () => {
  const tasks = body([gt('A.1', 'A')], [trow('A.1', [att(1, 'o', 'finished', 1, 2, { result: 'COMPLETED' })])]);
  const events = replay.mergeEvents(null, tasks);
  assert.equal(events.length, 2);
  const noTimeline = replay.stateAt(events, 0, { run: RUN, workflow: WORKFLOW, timeline: null, tasks });
  assert.equal(noTimeline.row, RUN);
  assert.equal(noTimeline.timeline, null);
  assert.equal(noTimeline.tasks.tasks[0].state, 'RUNNING');
  const noWorkflow = replay.stateAt(replay.mergeEvents(tl(RUN_EVENTS), null), 1, { run: RUN, workflow: null, timeline: tl(RUN_EVENTS), tasks: null });
  assert.equal(noWorkflow.row, RUN);
  assert.equal(noWorkflow.degraded, 'workflow-unavailable');
  assert.equal(noWorkflow.tasks, null);
});

// ---- seeking and stepping -----------------------------------------------------------------------------------

test('step and seek are idempotent and clamp at both ends', () => {
  const base = baseOf(RUN_EVENTS);
  const events = replay.mergeEvents(base.timeline, null);
  const n = events.length;
  assert.equal(replay.clampIndex(-5, n), 0);
  assert.equal(replay.clampIndex(99, n), n - 1);
  assert.equal(replay.clampIndex(2.9, n), 2);
  assert.equal(replay.clampIndex(Number.NaN, n), n - 1);
  assert.equal(replay.clampIndex(0, 0), -1);
  assert.equal(replay.stepIndex(0, n, -1), 0);
  assert.equal(replay.stepIndex(n - 1, n, 1), n - 1);
  assert.equal(replay.stepIndex(replay.stepIndex(2, n, 1), n, -1), 2);
  for (const i of [0, 2, n - 1]) {
    const once = replay.stateAt(events, i, base);
    assert.deepEqual(replay.stateAt(events, i, base), once, 'the same index gives the same state');
    assert.deepEqual(replay.stateAt(events, replay.clampIndex(replay.clampIndex(i, n), n), base), once, 'seeking to a clamped index again changes nothing');
  }
  assert.deepEqual(replay.stateAt(events, 99, base), replay.stateAt(events, n - 1, base), 'past the end is the end');
  assert.deepEqual(replay.stateAt(events, 3, base).row.progress, { done: 3, total: 4 });
});

test('speed sets the pause between steps (1x, 4x, 16x) with a floor; an unknown speed is 1x', () => {
  assert.deepEqual(replay.SPEEDS, [1, 4, 16]);
  assert.deepEqual(replay.SPEEDS.map(replay.stepDelay), [1000, 250, 63]);
  assert.equal(replay.stepDelay(3), 1000);
  assert.ok(replay.stepDelay(16) >= replay.MIN_STEP_MS);
});

test('the banner words give the moment, the position and the event', () => {
  const base = baseOf(RUN_EVENTS);
  const events = replay.mergeEvents(base.timeline, null);
  const at = replay.stateAt(events, 1, base);
  assert.equal(replay.bannerWords({ event: at.event, index: at.index, count: at.count }, '10:05'), 'Replaying 10:05 · event 2 of 6: plan completed, passed');
  assert.equal(replay.bannerWords({ event: at.event, index: 0, count: 6 }, null), 'Replaying a moment with no recorded time · event 1 of 6: plan completed, passed');
  const claim = replay.mergeEvents(null, body([gt('A.1', 'A')], [trow('A.1', [att(1, 'core-implementer', 'finished', 1, 2, { result: 'COMPLETED' })])]));
  assert.deepEqual(claim.map(replay.eventLabel), ['A.1 attempt 1 started by core-implementer', 'A.1 attempt 1 finished, completed']);
});

test('viewAt hands the views a body of the same shape, with the moment as its clock', () => {
  const base = baseOf(RUN_EVENTS);
  const events = replay.mergeEvents(base.timeline, null);
  const { data, state } = replay.viewAt({ v: 1, ...base }, events, 1);
  assert.equal(data.v, 1);
  assert.equal(data.run.state, 'AWAITING_GATE');
  assert.equal(data.run.updatedAt, iso(5));
  assert.equal(state.moment, T0 + 5 * MIN);
  assert.equal(data.workflow, WORKFLOW);
  assert.equal(data.timeline.events.length, 2);
  assert.equal(data.tasks, null);
});

// ---- the real core ------------------------------------------------------------------------------------------

type Held = { row: any, timeline: any, workflow: any, tasks: any };

function walker(f: any) {
  const env = { ...f.env, DOFLOW_UPKEEP: 'off' };
  const core = (args: string[]): any => {
    const out = spawnSync(process.execPath, [CORE_CLI, ...args, '--json'], { cwd: f.main, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(out.status, 0, `doflow ${args.join(' ')}: ${out.stdout}${out.stderr}`);
    return JSON.parse(out.stdout);
  };
  const step = (taskId: string, slug: string, ...args: string[]) => core(['orchestrate', '--task-id', taskId, '--slug', slug, ...args]);
  /** What the browser would hold for the run route: the list row, timeline, workflow and (when the plan reads) the tasks body. */
  const hold = (taskId: string, slug: string): Held => {
    const list = project('list', core(['orchestrate', '--action', 'list']));
    assert.ok(list.ok, 'list projects');
    const row = list.body.runs.find((r: any) => r.taskId === taskId && r.featureSlug === slug);
    assert.ok(row, `${taskId} is listed`);
    const timeline = project('timeline', core(['orchestrate', '--action', 'timeline', '--task-id', taskId, '--slug', slug]));
    assert.ok(timeline.ok, 'timeline projects');
    const workflow = project('workflow', core(['workflow', '--task-class', row.taskClass]));
    assert.ok(workflow.ok, 'workflow projects');
    const attempts = spawnSync(process.execPath, [CORE_CLI, 'task-attempt', '--action', 'inspect', '--slug', slug, '--json'], { cwd: f.main, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    let tasks: any = null;
    if (attempts.status === 0) {
      const raw = JSON.parse(attempts.stdout);
      if (raw.graph && raw.graph.graphPlan !== false) {
        const projected = project('attempts', raw);
        assert.ok(projected.ok, 'attempts projects');
        tasks = projected.body;
      }
    }
    return { row, timeline: timeline.body, workflow: workflow.body, tasks };
  };
  return { core, step, hold };
}

const liveNodes = (held: Held) => rail.deriveRail(held.workflow, held.row, held.timeline, Date.parse(held.row.updatedAt));
const asBase = (held: Held) => ({ run: held.row, workflow: held.workflow, timeline: held.timeline, tasks: held.tasks });

/** The fold at the last event equals what the browser derives from the live body. */
function assertLive(held: Held, label: string) {
  const events = replay.mergeEvents(held.timeline, held.tasks);
  const last = replay.stateAt(events, events.length - 1, asBase(held));
  const live = liveNodes(held);
  assert.equal(last.row.state, held.row.state, `${label}: state`);
  assert.deepEqual(last.row.current ?? null, held.row.current ?? null, `${label}: current`);
  assert.equal(last.row.progress.done, held.row.progress.done, `${label}: progress.done`);
  assert.equal(last.cursor, live.cursor, `${label}: cursor`);
  assert.equal(last.degraded, live.degraded, `${label}: degraded`);
  assert.deepEqual(last.nodes, live.nodes, `${label}: nodes`);
  assert.deepEqual(last.timeline, held.timeline, `${label}: the whole timeline`);
  if (held.tasks === null) assert.equal(last.tasks, null, `${label}: no tasks`);
  else {
    const want = graph.mergeTasks(held.tasks).filter((t: any) => t.state !== null);
    const got = graph.mergeTasks(last.tasks).filter((t: any) => t.state !== null);
    assert.deepEqual(got.map((t: any) => [t.id, t.state, t.reason, t.budget, t.attempts]), want.map((t: any) => [t.id, t.state, t.reason, t.budget, t.attempts]), `${label}: task rows`);
  }
  return events;
}

test('stateAt(last) equals the live derivation for every C.2 fixture run', { timeout: 180_000 }, (t: any) => {
  const f = buildFixture((fn: () => void) => t.after(fn));
  const { hold } = walker(f);
  const slugged = f.runs.filter((r: any) => r.slug !== null);
  assert.ok(slugged.length >= 4);
  let withTasks = 0;
  for (const run of slugged) {
    let held: Held;
    try { held = hold(run.taskId, run.slug); } catch (error: any) {
      // The list shows a run of the linked worktree's own store that the run routes cannot address.
      assert.equal(run.taskId, 'run-other', `${run.taskId}: ${error.message}`);
      continue;
    }
    const events = assertLive(held, run.taskId);
    if (held.tasks !== null) {
      withTasks += 1;
      assert.ok(events.some((e: any) => e.source === 'task'), 'the graph run has attempt events');
      assert.ok(events.some((e: any) => e.kind === 'release') && events.some((e: any) => e.kind === 'finish'), 'a released and a finished attempt');
    }
  }
  assert.ok(withTasks >= 1, 'at least one fixture run has a task graph');
});

test('a feature run walked through the real core: stateAt(k) is what the browser held after step k, and the last event is the live state', { timeout: 180_000 }, (t: any) => {
  const f = buildFixture((fn: () => void) => t.after(fn));
  const { step, hold } = walker(f);
  const [id, slug] = ['run-replay', 'feat-replay'];
  const steps: string[][] = [
    ['--action', 'start', '--task-class', 'feature'],
    ['--action', 'complete-stage', '--stage', 'discovery', '--result', 'passed'],
    ['--action', 'decide-gate', '--gate', 'gate-0', '--decision', 'approve', '--forced', '--note', 'ok'],
    ['--action', 'complete-stage', '--stage', 'design', '--result', 'passed'],
    ['--action', 'complete-stage', '--stage', 'planning', '--result', 'unverified'],
    ['--action', 'decide-gate', '--gate', 'gate-a', '--decision', 'approve'],
  ];
  const seen: Held[] = [];
  for (const args of steps) {
    step(id, slug, ...args);
    seen.push(hold(id, slug));
  }
  const final = seen[seen.length - 1];
  const events = assertLive(final, 'walk');
  assert.equal(events.length, final.timeline.events.length, 'no attempts here: every event is a run event');
  seen.forEach((held, k) => {
    const state = replay.stateAt(events, k, asBase(final));
    assert.equal(state.row.state, held.row.state, `step ${k}: state`);
    assert.deepEqual(state.row.current ?? null, held.row.current ?? null, `step ${k}: current`);
    assert.equal(state.row.progress.done, held.row.progress.done, `step ${k}: progress`);
    const live = liveNodes(held);
    assert.deepEqual(state.nodes.map((n: any) => [n.id, n.state]), live.nodes.map((n: any) => [n.id, n.state]), `step ${k}: node states`);
  });
});

test('a rejected run and a documentation run with a skipped stage: the fold ends where the core did', { timeout: 180_000 }, (t: any) => {
  const f = buildFixture((fn: () => void) => t.after(fn));
  const { step, hold } = walker(f);
  step('run-no', 'feat-no', '--action', 'start', '--task-class', 'feature');
  step('run-no', 'feat-no', '--action', 'complete-stage', '--stage', 'discovery', '--result', 'passed');
  step('run-no', 'feat-no', '--action', 'decide-gate', '--gate', 'gate-0', '--decision', 'reject');
  const rejected = hold('run-no', 'feat-no');
  assert.equal(rejected.row.state, 'REJECTED');
  assertLive(rejected, 'rejected');

  step('run-doc', 'feat-doc', '--action', 'start', '--task-class', 'documentation');
  step('run-doc', 'feat-doc', '--action', 'complete-stage', '--stage', 'authoring', '--result', 'failed');
  step('run-doc', 'feat-doc', '--action', 'skip-stage', '--stage', 'verification');
  step('run-doc', 'feat-doc', '--action', 'complete-stage', '--stage', 'review', '--result', 'passed');
  const done = hold('run-doc', 'feat-doc');
  assert.equal(done.row.state, 'COMPLETED');
  const events = assertLive(done, 'documentation');
  assert.ok(events.length >= 4);
});
