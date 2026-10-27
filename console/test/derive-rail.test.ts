'use strict';

// Stage rail derivation (feature 093, IC-008; plan task E.1; design note E.1 sections 4, 6, 7). The walk tests run the
// REAL core (the C.2 fixture project, bin/doflow.js) through start, complete-stage, skip-stage and decide-gate, project
// each read as the Console does, and check `deriveRail` at every step. The rest are pure cases: stale after 24 h, the two
// degraded states, a skipped gate, the helpers, the home's ordering and descriptions. Control: using `progress.done`
// as the cursor without the id check turns the cursor-mismatch case red.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { buildFixture, CORE_CLI, writePassingPlan } = require('./helpers/core-fixture.ts');
const { project } = require('../src/project.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const RAIL_SOURCE = fs.readFileSync(path.join(WEB_ROOT, 'derive', 'rail.js'), 'utf8');
const MIN = 60_000;
const HOUR = 60 * MIN;

let scratch: string[] = [];
let rail: any;

/** A copy of derive/rail.js (optionally with its source rewritten) as an ES module a CommonJS package can import. */
async function loadRail(source: string): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-derive-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, 'derive'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'derive', 'rail.js'), source);
  return import(pathToFileURL(path.join(dir, 'derive', 'rail.js')).href);
}

before(async () => { rail = await loadRail(RAIL_SOURCE); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

const states = (model: any) => model.nodes.map((n: any) => n.state);
const ids = (model: any) => model.nodes.map((n: any) => n.id);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// ---- the real core, walked --------------------------------------------------------------------------------

type Seen = { row: any, timeline: any, workflow: any, model: any };

function walker(f: any) {
  const env = { ...f.env, DOFLOW_UPKEEP: 'off' };
  const core = (args: string[]): any => {
    const out = spawnSync(process.execPath, [CORE_CLI, ...args, '--json'], { cwd: f.main, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(out.status, 0, `doflow ${args.join(' ')}: ${out.stdout}${out.stderr}`);
    return JSON.parse(out.stdout);
  };
  const step = (taskId: string, slug: string, ...args: string[]) => core(['orchestrate', '--task-id', taskId, '--slug', slug, ...args]);
  /** What the browser would hold for the run: the projected list row, timeline and workflow, and the derived rail. */
  const see = (taskId: string, slug: string, nowMs = Date.now()): Seen => {
    const list = project('list', core(['orchestrate', '--action', 'list']));
    assert.ok(list.ok, 'list projects');
    const row = list.body.runs.find((r: any) => r.taskId === taskId);
    assert.ok(row, `${taskId} is listed`);
    const timeline = project('timeline', core(['orchestrate', '--action', 'timeline', '--task-id', taskId, '--slug', slug]));
    assert.ok(timeline.ok, 'timeline projects');
    const workflow = project('workflow', core(['workflow', '--task-class', row.taskClass]));
    assert.ok(workflow.ok, 'workflow projects');
    return { row, timeline: timeline.body, workflow: workflow.body, model: rail.deriveRail(workflow.body, row, timeline.body, nowMs) };
  };
  return { core, step, see };
}

const RUNNING = (n: number, total: number) => (i: number) => (i < n ? 'done' : i === n ? 'running' : 'pending');

test('a feature run walked through the real core gives the IC-008 node states at every step', { timeout: 180_000 }, (t: any) => {
  const f = buildFixture((fn: () => void) => t.after(fn));
  const { step, see } = walker(f);
  const slug = 'feat-walk';
  const id = 'run-walk';
  const program = ['discovery', 'gate-0', 'design', 'planning', 'gate-a', 'implementation', 'verification', 'review', 'gate-b'];
  const expect = (seen: Seen, cursor: number, kind: 'running' | 'awaiting') => {
    assert.equal(seen.model.degraded, null, `degraded at ${seen.row.current?.id}`);
    assert.deepEqual(ids(seen.model), program);
    assert.equal(seen.model.cursor, cursor);
    assert.equal(seen.row.progress.done, cursor, 'progress.done is the cursor');
    assert.equal(seen.row.progress.total, 9);
    const want = Array.from({ length: 9 }, (_, i) => (i < cursor ? 'done' : i === cursor ? kind : 'pending'));
    assert.deepEqual(states(seen.model), want);
    assert.equal(seen.model.runToken, kind === 'running' ? 'RUNNING' : 'AWAITING_GATE');
  };

  step(id, slug, '--action', 'start', '--task-class', 'feature');
  expect(see(id, slug), 0, 'running');

  step(id, slug, '--action', 'complete-stage', '--stage', 'discovery', '--result', 'passed');
  let seen = see(id, slug);
  expect(seen, 1, 'awaiting');
  assert.equal(seen.model.nodes[0].outcome, 'passed');
  assert.equal(seen.model.nodes[1].type, 'gate');
  assert.equal(seen.model.nodes[1].kind, 'clarification');
  assert.equal(seen.model.nodes[1].since, seen.timeline.events.at(-1).at, 'the cursor node waits since the last event');

  step(id, slug, '--action', 'decide-gate', '--gate', 'gate-0', '--decision', 'approve', '--forced', '--note', 'approved with open markers');
  seen = see(id, slug);
  expect(seen, 2, 'running');
  assert.equal(seen.model.nodes[1].decision, 'approve');
  assert.equal(seen.model.nodes[1].forced, true, 'a forced approval comes from the timeline');
  assert.equal(seen.model.nodes[0].forced, false);
  assert.ok(Number.isFinite(seen.model.nodes[1].durationMs) && seen.model.nodes[1].durationMs >= 0);

  step(id, slug, '--action', 'complete-stage', '--stage', 'design', '--result', 'passed');
  expect(see(id, slug), 3, 'running');

  writePassingPlan(f, slug);
  step(id, slug, '--action', 'complete-stage', '--stage', 'planning', '--result', 'unverified');
  seen = see(id, slug);
  expect(seen, 4, 'awaiting');
  assert.equal(seen.model.nodes[3].outcome, 'unverified');
  assert.equal(seen.model.nodes[4].id, 'gate-a');

  step(id, slug, '--action', 'decide-gate', '--gate', 'gate-a', '--decision', 'approve');
  seen = see(id, slug);
  expect(seen, 5, 'running');
  assert.equal(seen.model.nodes[4].forced, false);
  assert.deepEqual(seen.model.nodes.slice(0, 5).map((n: any) => n.at !== null), [true, true, true, true, true]);
  const durations = seen.model.nodes.slice(0, 5).map((n: any) => n.durationMs);
  assert.ok(durations.every((d: any) => Number.isFinite(d) && d >= 0), `durations known: ${durations}`);
});

test('a rejected gate stops the rail: the gate is rejected and the rest was not reached', { timeout: 120_000 }, (t: any) => {
  const f = buildFixture((fn: () => void) => t.after(fn));
  const { step, see } = walker(f);
  step('run-no', 'feat-no', '--action', 'start', '--task-class', 'feature');
  step('run-no', 'feat-no', '--action', 'complete-stage', '--stage', 'discovery', '--result', 'passed');
  step('run-no', 'feat-no', '--action', 'decide-gate', '--gate', 'gate-0', '--decision', 'reject');
  const seen = see('run-no', 'feat-no');
  assert.equal(seen.row.state, 'REJECTED');
  assert.equal(seen.model.degraded, null);
  assert.deepEqual(states(seen.model), ['done', 'rejected', ...Array(7).fill('not-reached')]);
  assert.equal(seen.model.nodes[1].decision, 'reject');
  assert.ok(Number.isFinite(seen.model.nodes[1].durationMs), 'the rejecting gate has its own event time');
});

test('a documentation run: a skipped stage reads skipped with the timeline and done without it; COMPLETED is past the end', { timeout: 120_000 }, (t: any) => {
  const f = buildFixture((fn: () => void) => t.after(fn));
  const { step, see } = walker(f);
  const [id, slug] = ['run-doc', 'feat-doc'];
  step(id, slug, '--action', 'start', '--task-class', 'documentation');
  assert.deepEqual(states(see(id, slug).model), ['running', 'pending', 'pending']);
  step(id, slug, '--action', 'complete-stage', '--stage', 'authoring', '--result', 'failed');
  assert.deepEqual(states(see(id, slug).model), ['done', 'running', 'pending']);
  step(id, slug, '--action', 'skip-stage', '--stage', 'verification');
  assert.deepEqual(states(see(id, slug).model), ['done', 'skipped', 'running']);
  step(id, slug, '--action', 'complete-stage', '--stage', 'review', '--result', 'passed');
  const seen = see(id, slug);
  assert.equal(seen.row.state, 'COMPLETED');
  assert.equal(seen.model.cursor, 3, 'COMPLETED puts the cursor past the end');
  assert.equal(seen.model.degraded, null);
  assert.deepEqual(states(seen.model), ['done', 'skipped', 'done']);
  assert.equal(seen.model.nodes[0].outcome, 'failed');
  assert.equal(seen.model.nodes[2].outcome, 'passed');
  // The home has no timeline: nothing is claimed about skipped, outcome or duration.
  const home = rail.deriveRail(seen.workflow, seen.row, null);
  assert.deepEqual(states(home), ['done', 'done', 'done']);
  assert.ok(home.nodes.every((n: any) => n.outcome === null && n.at === null && n.durationMs === null && n.forced === false));
});

// ---- pure cases ------------------------------------------------------------------------------------------

const WORKFLOW = {
  taskClass: 'x', name: 'X Flow',
  stages: [
    { id: 'plan', kind: 'planning', optional: false, skill: 's', agent: 'a', purpose: 'p', gatesAfter: [{ id: 'gate-p', kind: 'approval', trigger: 'always', name: 'n', prompt: 'q' }] },
    { id: 'extra', kind: 'verification', optional: true, skill: 's', agent: 'a', purpose: 'p', gatesAfter: [{ id: 'gate-q', kind: 'clarification', trigger: 't', name: 'n', prompt: 'q' }] },
    { id: 'build', kind: 'implementation', optional: false, skill: 's', agent: 'a', purpose: 'p', gatesAfter: [] },
  ],
};
// program: plan, gate-p, extra, gate-q, build  (5 nodes)
const row = (state: string, current: any, done: number, extra: any = {}) => ({
  taskId: 'r', featureSlug: 'f', taskClass: 'x', state, current, progress: { done, total: 5 }, updatedAt: '2026-10-26T10:00:00.000Z', ...extra,
});
const stage = (id: string) => ({ type: 'stage', id, kind: 'k' });
const gate = (id: string) => ({ type: 'gate', id, kind: 'approval' });
const NOW = Date.parse('2026-10-26T12:00:00.000Z');

test('stale: a RUNNING run silent for over 24 h draws its current node stale; the data still says RUNNING', () => {
  const fresh = rail.deriveRail(WORKFLOW, row('RUNNING', stage('extra'), 2, { updatedAt: new Date(NOW - 23 * HOUR).toISOString() }), null, NOW);
  assert.equal(fresh.runToken, 'RUNNING');
  assert.equal(fresh.nodes[2].state, 'running');
  const stale = rail.deriveRail(WORKFLOW, row('RUNNING', stage('extra'), 2, { updatedAt: new Date(NOW - 25 * HOUR).toISOString() }), null, NOW);
  assert.equal(stale.runToken, 'stale');
  assert.deepEqual(states(stale), ['done', 'done', 'stale', 'pending', 'pending']);
  assert.equal(stale.degraded, null);
  const waiting = rail.deriveRail(WORKFLOW, row('AWAITING_GATE', gate('gate-p'), 1, { updatedAt: new Date(NOW - 30 * HOUR).toISOString() }), null, NOW);
  assert.equal(waiting.runToken, 'AWAITING_GATE', 'only RUNNING goes stale');
  assert.equal(rail.runToken(row('RUNNING', stage('plan'), 0, { updatedAt: null }), NOW), 'RUNNING', 'a missing time is not stale');
});

test('shape-mismatch: a program whose length differs from progress.total degrades, and the nodes are still returned', () => {
  const fewer = clone(WORKFLOW);
  fewer.stages.pop();
  const model = rail.deriveRail(fewer, row('RUNNING', stage('extra'), 2), null, NOW);
  assert.equal(model.degraded, 'shape-mismatch');
  assert.equal(model.nodes.length, 4);
  assert.equal(rail.deriveRail(WORKFLOW, { ...row('RUNNING', stage('plan'), 0), progress: undefined }, null, NOW).degraded, 'shape-mismatch', 'no progress is a shape problem too');
});

test('cursor-mismatch: an id that is not found, a done that differs from the id, or a type that does not fit the run state', () => {
  const ok = rail.deriveRail(WORKFLOW, row('AWAITING_GATE', gate('gate-q'), 3), null, NOW);
  assert.equal(ok.degraded, null);
  assert.equal(ok.cursor, 3);
  // The id is not in the program although progress.done is in range.
  assert.equal(rail.deriveRail(WORKFLOW, row('RUNNING', stage('ghost'), 2), null, NOW).degraded, 'cursor-mismatch');
  // The id is found, at an index other than progress.done.
  assert.equal(rail.deriveRail(WORKFLOW, row('AWAITING_GATE', gate('gate-q'), 1), null, NOW).degraded, 'cursor-mismatch');
  // The id is found where progress.done says, but the type is the wrong one for the run state (this note's reading of "not found").
  assert.equal(rail.deriveRail(WORKFLOW, row('RUNNING', gate('gate-q'), 3), null, NOW).degraded, 'cursor-mismatch');
  assert.equal(rail.deriveRail(WORKFLOW, row('AWAITING_GATE', stage('extra'), 2), null, NOW).degraded, 'cursor-mismatch');
  assert.equal(rail.deriveRail(WORKFLOW, row('REJECTED', stage('extra'), 2), null, NOW).degraded, 'cursor-mismatch');
  assert.equal(rail.deriveRail(WORKFLOW, row('REJECTED', gate('gate-q'), 3), null, NOW).degraded, null, 'REJECTED sits on a gate');
  // COMPLETED is past the end; anything else is not.
  assert.equal(rail.deriveRail(WORKFLOW, row('COMPLETED', null, 5), null, NOW).degraded, null);
  assert.equal(rail.deriveRail(WORKFLOW, row('COMPLETED', null, 4), null, NOW).degraded, 'cursor-mismatch');
  assert.equal(rail.deriveRail(WORKFLOW, row('RUNNING', null, 2), null, NOW).degraded, 'cursor-mismatch', 'a running run with no current node');
  assert.equal(rail.deriveRail(WORKFLOW, row('WEIRD', stage('plan'), 0), null, NOW).degraded, 'cursor-mismatch', 'an unknown run state');
});

test('control: using progress.done as the cursor without the id check turns the cursor-mismatch case red', async () => {
  const line = 'const cursor = findCursor(program, row);';
  assert.ok(RAIL_SOURCE.includes(line), 'the cursor line is where the control expects it');
  const mutated = await loadRail(RAIL_SOURCE.replace(line, 'const cursor = isCount(done) ? done : -1;'));
  // done = 4 points at the last stage; the run says it is at gate-q, which is node 3.
  const wrongId = row('RUNNING', stage('build'), 3);
  const sameTypeWrongIndex = row('RUNNING', stage('plan'), 2);
  assert.equal(rail.deriveRail(WORKFLOW, wrongId, null, NOW).degraded, 'cursor-mismatch');
  assert.equal(rail.deriveRail(WORKFLOW, sameTypeWrongIndex, null, NOW).degraded, 'cursor-mismatch');
  assert.equal(mutated.deriveRail(WORKFLOW, wrongId, null, NOW).degraded, 'cursor-mismatch', 'the type check still catches a gate at a stage index');
  assert.equal(mutated.deriveRail(WORKFLOW, sameTypeWrongIndex, null, NOW).degraded, null, 'without the id check the mismatch passes: the case turns red');
  assert.notEqual(rail.deriveRail(WORKFLOW, sameTypeWrongIndex, null, NOW).degraded, mutated.deriveRail(WORKFLOW, sameTypeWrongIndex, null, NOW).degraded);
});

test('a missing or empty workflow body is workflow-unavailable, not a throw', () => {
  for (const body of [null, undefined, {}, { stages: 'x' }]) {
    const model = rail.deriveRail(body, row('RUNNING', stage('plan'), 0), null, NOW);
    assert.equal(model.degraded, 'workflow-unavailable');
    assert.deepEqual(model.nodes, []);
  }
});

test('timeline: a skipped stage and a skipped gate become skipped; outcome, synthetic, forced and durations come from the events', () => {
  const at = (minute: number) => new Date(NOW - (60 - minute) * MIN).toISOString();
  const events = [
    { at: at(0), action: 'start', node: null, outcome: null, decision: null, forced: false, synthetic: false },
    { at: at(4), action: 'complete-stage', node: 'plan', outcome: 'passed', decision: null, forced: false, synthetic: true },
    { at: at(5), action: 'decide-gate', node: 'gate-p', outcome: null, decision: 'approve', forced: true, synthetic: false },
    { at: at(5), action: 'skip-stage', node: 'extra', outcome: null, decision: null, forced: false, synthetic: false },
    { at: at(6), action: 'skip-gate', node: 'gate-q', outcome: null, decision: null, forced: false, synthetic: false },
    { at: null, action: 'annotate', node: 'build', outcome: null, decision: null, forced: false, synthetic: false },
  ];
  const model = rail.deriveRail(WORKFLOW, row('RUNNING', stage('build'), 4), { events }, NOW);
  assert.deepEqual(states(model), ['done', 'done', 'skipped', 'skipped', 'running']);
  assert.equal(model.nodes[0].outcome, 'passed');
  assert.equal(model.nodes[0].synthetic, true);
  assert.equal(model.nodes[0].durationMs, 4 * MIN, 'the interval from the previous progress event');
  assert.equal(model.nodes[1].decision, 'approve');
  assert.equal(model.nodes[1].forced, true);
  assert.equal(model.nodes[1].durationMs, MIN);
  assert.equal(model.nodes[2].durationMs, 0);
  assert.equal(model.nodes[3].durationMs, MIN);
  assert.equal(model.nodes[4].since, at(6), 'E.2 Q1: the untimed note at the end is not the last progress event, so the wait counts from the skipped gate');
  const timed = rail.deriveRail(WORKFLOW, row('RUNNING', stage('build'), 4), { events: events.slice(0, 5) }, NOW);
  assert.equal(timed.nodes[4].since, at(6));
  // A missing time on either side makes the duration unknown, never zero.
  const untimed = rail.deriveRail(WORKFLOW, row('RUNNING', stage('build'), 4), { events: [{ ...events[0], at: null }, events[1]] }, NOW);
  assert.equal(untimed.nodes[0].durationMs, null);
});

test('E.2 Q1: a note neither ends the interval before it nor resets the wait after it', () => {
  const at = (minute: number) => new Date(NOW - (60 - minute) * MIN).toISOString();
  const e = (minute: number, action: string, node: string | null, over: any = {}) => ({ at: at(minute), action, node, outcome: null, decision: null, forced: false, synthetic: false, ...over });
  const events = [e(0, 'start', null), e(4, 'complete-stage', 'plan', { outcome: 'passed' }), e(5, 'annotate', 'plan'), e(9, 'decide-gate', 'gate-p', { decision: 'approve' }), e(12, 'annotate', 'build')];
  const model = rail.deriveRail(WORKFLOW, row('RUNNING', stage('build'), 4), { events }, NOW);
  assert.equal(model.nodes[1].durationMs, 5 * MIN, 'gate-p waited from the stage completion at 4, not from the note at 5');
  assert.equal(model.nodes[4].since, at(9), 'the running stage counts from the last progress event, not from the note at 12');
});

test('the last event of a node wins, and an event of the other node type does not count', () => {
  const events = [
    { at: '2026-10-26T10:00:00.000Z', action: 'complete-stage', node: 'plan', outcome: 'failed', decision: null, forced: false, synthetic: false },
    { at: '2026-10-26T10:05:00.000Z', action: 'complete-stage', node: 'plan', outcome: 'passed', decision: null, forced: false, synthetic: false },
    { at: '2026-10-26T10:06:00.000Z', action: 'complete-stage', node: 'gate-p', outcome: 'passed', decision: null, forced: false, synthetic: false },
  ];
  const model = rail.deriveRail(WORKFLOW, row('AWAITING_GATE', gate('gate-p'), 1), { events }, NOW);
  assert.equal(model.nodes[0].outcome, 'passed');
  assert.equal(model.nodes[0].durationMs, 5 * MIN);
});

// ---- helpers -------------------------------------------------------------------------------------------

test('formatDuration: under 1 s, seconds, minutes, hours and minutes, days and hours; floored; null stays null', () => {
  const table: Array<[number | null, string | null]> = [
    [null, null], [0, 'under 1 s'], [999, 'under 1 s'], [1000, '1 s'], [59_999, '59 s'], [60_000, '1 min'], [3_599_999, '59 min'],
    [3_600_000, '1 h'], [3_600_000 + 5 * MIN, '1 h 5 min'], [86_399_999, '23 h 59 min'], [86_400_000, '1 d'], [2 * 86_400_000, '2 d'], [86_400_000 + 5 * HOUR, '1 d 5 h'], [86_400_000 * 2 + 5 * HOUR + 59 * MIN, '2 d 5 h'],
  ];
  for (const [ms, text] of table) assert.equal(rail.formatDuration(ms), text, String(ms));
  assert.equal(rail.liveDuration(59_000), 'under 1 min');
  assert.equal(rail.liveDuration(12 * MIN + 30_000), '12 min');
});

test('stepText and fallbackText follow the run state and the figures of progress', () => {
  assert.equal(rail.stepText(row('RUNNING', stage('extra'), 2)), 'Step 3 of 5 · extra');
  assert.equal(rail.stepText(row('AWAITING_GATE', gate('gate-q'), 3)), 'Step 4 of 5 · gate-q');
  assert.equal(rail.stepText(row('COMPLETED', null, 5)), '5 of 5 steps');
  assert.equal(rail.stepText(row('REJECTED', gate('gate-p'), 1)), 'Stopped at gate-p');
  assert.equal(rail.stepText(row('RUNNING', null, 2)), 'Step 3 of 5');
  assert.equal(rail.stepText({ state: 'RUNNING', current: stage('a') }), 'Progress unknown');
  assert.equal(rail.fallbackText(row('RUNNING', stage('extra'), 2), 'shape-mismatch'), 'Step 3 of 5 · workflow changed');
  assert.equal(rail.fallbackText(row('AWAITING_GATE', gate('gate-q'), 3), 'cursor-mismatch'), 'Step 4 of 5 · position unconfirmed');
  assert.equal(rail.fallbackText(row('RUNNING', stage('plan'), 0), null), 'Step 1 of 5 · workflow unavailable');
  assert.equal(rail.fallbackText(row('COMPLETED', null, 5), null), 'Step 5 of 5 · workflow unavailable', 'COMPLETED shows done, not done + 1');
});

test('changedNodes: indexes whose state differs; nothing without a previous array or on a different count', () => {
  assert.deepEqual([...rail.changedNodes(['done', 'running', 'pending'], ['done', 'done', 'running'])], [1, 2]);
  assert.deepEqual([...rail.changedNodes(null, ['done'])], []);
  assert.deepEqual([...rail.changedNodes(undefined, ['done'])], []);
  assert.deepEqual([...rail.changedNodes(['done'], ['done', 'running'])], []);
  assert.deepEqual([...rail.changedNodes(['done', 'running'], ['done', 'running'])], []);
});

test('nodeName reads position, id, kind, state and duration as the note lists them', () => {
  const node = (over: any) => ({ type: 'stage', id: 'design', kind: 'design', optional: false, state: 'done', outcome: 'passed', synthetic: false, decision: null, forced: false, at: null, durationMs: null, since: null, ...over });
  const name = (n: any, index: number, count: number) => rail.nodeName(n, index, count, NOW);
  assert.equal(name(node({ durationMs: 4 * MIN }), 2, 9), '3 of 9. design. Stage. Done, passed. 4 min after the previous event.');
  assert.equal(name(node({ type: 'gate', id: 'gate-0', kind: 'clarification', state: 'done', outcome: null, forced: true, durationMs: 400 }), 1, 9), '2 of 9. gate-0. Clarification gate. Approved, forced. Under 1 s after the previous event.');
  assert.equal(name(node({ id: 'implementation', state: 'running', outcome: null, since: new Date(NOW - 3 * MIN).toISOString() }), 5, 9), '6 of 9. implementation. Stage. Running for 3 min.');
  assert.equal(name(node({ type: 'gate', id: 'gate-a', kind: 'approval', state: 'awaiting', outcome: null, since: new Date(NOW - 12 * MIN).toISOString() }), 4, 9), '5 of 9. gate-a. Approval gate. Waiting for you for 12 min.');
  assert.equal(name(node({ id: 'verification', optional: true, state: 'skipped', outcome: null }), 1, 3), '2 of 3. verification. Stage, optional. Skipped.');
  assert.equal(name(node({ id: 'verification', state: 'pending', outcome: null }), 6, 9), '7 of 9. verification. Stage. Not started.');
  assert.equal(name(node({ id: 'implementation', state: 'not-reached', outcome: null }), 5, 9), '6 of 9. implementation. Stage. Not reached: the run was rejected.');
  assert.equal(name(node({ id: 'planning' }), 3, 9), '4 of 9. planning. Stage. Done, passed. Time not recorded.');
  assert.equal(name(node({ id: 'planning', synthetic: true, durationMs: MIN }), 3, 9), '4 of 9. planning. Stage. Done, passed, imported. 1 min after the previous event.');
  assert.equal(name(node({ id: 'planning', outcome: 'failed', durationMs: MIN }), 3, 9), '4 of 9. planning. Stage. Done, failed. 1 min after the previous event.');
  assert.equal(name(node({ id: 'implementation', state: 'stale', outcome: null }), 5, 9), '6 of 9. implementation. Stage. Running, silent for over a day.');
  assert.equal(name(node({ id: 'implementation', state: 'running', outcome: null }), 5, 9), '6 of 9. implementation. Stage. Running.', 'no since, no duration part');
  assert.equal(name(node({ id: 'implementation', state: 'running', outcome: null, since: new Date(NOW - 20_000).toISOString() }), 5, 9), '6 of 9. implementation. Stage. Running for under 1 min.');
  assert.equal(name(node({ type: 'gate', id: 'gate-a', kind: 'approval', state: 'rejected', outcome: null, durationMs: 2 * HOUR }), 4, 9), '5 of 9. gate-a. Approval gate. Rejected. 2 h after the previous event.');
});

// ---- the home: sections, order, descriptions -----------------------------------------------------------------

const run = (taskId: string, state: string, updatedAt: string | null, extra: any = {}) => ({ taskId, featureSlug: 'f', taskClass: 'x', state, updatedAt, ...extra });

test('groupRuns: Needs you oldest first, Running and Finished newest first, null times last, ties by task id', () => {
  const runs = [
    run('b-wait', 'AWAITING_GATE', '2026-10-26T10:05:00Z'), run('a-wait', 'AWAITING_GATE', '2026-10-26T10:01:00Z'), run('n-wait', 'AWAITING_GATE', null),
    run('r1', 'RUNNING', '2026-10-26T10:00:00Z'), run('r2', 'RUNNING', '2026-10-26T11:00:00Z'), run('r-null', 'RUNNING', 'not a time'),
    run('tie-b', 'COMPLETED', '2026-10-26T09:00:00Z'), run('tie-a', 'REJECTED', '2026-10-26T09:00:00Z'), run('done-new', 'COMPLETED', '2026-10-26T12:00:00Z'),
    run('weird', 'PAUSED', '2026-10-26T12:00:00Z'),
  ];
  const groups = rail.groupRuns(runs);
  assert.deepEqual(groups.needs.map((r: any) => r.taskId), ['a-wait', 'b-wait', 'n-wait']);
  assert.deepEqual(groups.running.map((r: any) => r.taskId), ['r2', 'r1', 'r-null']);
  assert.deepEqual(groups.finished.map((r: any) => r.taskId), ['done-new', 'tie-a', 'tie-b']);
  assert.deepEqual(rail.countRuns(runs), { needs: 3, running: 3, finished: 3 });
  assert.equal(rail.runKey(run('t', 'RUNNING', null, { featureSlug: null })), '-/t');
  assert.equal(rail.runKey(run('t', 'RUNNING', null)), 'f/t');
});

test('describeRun assembles the sentence of the note: workflow, state, step, time, then the notes', () => {
  const at = new Date(NOW - 2 * MIN).toISOString();
  const wait = row('AWAITING_GATE', { type: 'gate', id: 'gate-a', kind: 'approval' }, 4, { updatedAt: at, progress: { done: 4, total: 9 }, workflowName: 'Feature Delivery' });
  const text = (r: any, over: any = {}) => rail.describeRun(r, { workflowName: 'Feature Delivery', nowMs: NOW, degraded: null, timeText: rail.updatedText(r, NOW), ...over });
  assert.equal(text(wait), 'Feature Delivery. Waiting for you. Step 5 of 9, gate gate-a, approval. Updated 2 minutes ago.');
  const done = row('COMPLETED', null, 3, { updatedAt: new Date(NOW - 14 * MIN).toISOString(), progress: { done: 3, total: 3 } });
  assert.equal(text(done, { workflowName: 'Documentation' }), 'Documentation. Completed. 3 of 3 steps. Updated 14 minutes ago.');
  const flat = row('RUNNING', stage('implementation'), 0, { featureSlug: null, updatedAt: new Date(NOW - 3 * MIN).toISOString(), progress: { done: 0, total: 2 } });
  assert.equal(text(flat, { workflowName: 'Trivial Edit' }), 'Trivial Edit. Running. Step 1 of 2, stage implementation. Updated 3 minutes ago. This run has no feature folder, so it cannot be opened here.');
  assert.match(text(wait, { degraded: 'shape-mismatch' }), /Workflow changed since this run started\.$/);
  assert.match(text(wait, { degraded: 'cursor-mismatch' }), /Position not confirmed\.$/);
  assert.match(text(wait, { degraded: 'unavailable' }), /Workflow unavailable\.$/);
  assert.match(text({ ...wait, origin: 'other' }), /From another checkout\.$/);
  assert.match(text({ ...wait, updatedAt: null }), /Update time unknown\.$/);
  assert.match(text({ ...wait, updatedAt: new Date(NOW - 20_000).toISOString() }), /Updated less than a minute ago\.$/);
  assert.match(text({ ...wait, updatedAt: new Date(NOW - 5 * HOUR).toISOString() }), /Updated 5 hours ago\.$/);
  assert.match(rail.updatedText(wait, NOW, { stale: true, clock: () => '15:52:09' }), /^Updated at 15:52:09$/);
  assert.equal(rail.runWord(row('RUNNING', stage('plan'), 0, { updatedAt: new Date(NOW - 25 * HOUR).toISOString() }), NOW), 'Stale');
});

test('programLength counts the stages and their gates', () => {
  assert.equal(rail.programLength(WORKFLOW), 5);
  assert.equal(rail.programLength({}), null);
  assert.equal(rail.programLength(null), null);
});

// ---- Claude Design pass (CD-B1 to CD-B8): gate cards, tile facts, step parts, duration lines ------------------

test('CD-B1 awaitingGateOf: the registry gate by id, else the id with the kind of the current node, else null', () => {
  const wait = row('AWAITING_GATE', gate('gate-q'), 3, { awaitingGate: { gateId: 'gate-q' } });
  assert.deepEqual(rail.awaitingGateOf(WORKFLOW, wait), { id: 'gate-q', name: 'n', kind: 'clarification', prompt: 'q' });
  assert.deepEqual(rail.awaitingGateOf(WORKFLOW, { ...wait, awaitingGate: undefined }), { id: 'gate-q', name: 'n', kind: 'clarification', prompt: 'q' }, 'the current gate stands in for awaitingGate');
  assert.deepEqual(rail.awaitingGateOf(null, wait), { id: 'gate-q', name: null, kind: 'approval', prompt: null }, 'no workflow: the id and the current node kind');
  assert.deepEqual(rail.awaitingGateOf({ stages: [] }, { ...wait, awaitingGate: { gateId: 'gate-zz' }, current: stage('plan') }), { id: 'gate-zz', name: null, kind: null, prompt: null });
  assert.equal(rail.awaitingGateOf(WORKFLOW, row('RUNNING', stage('plan'), 0)), null);
});

test('CD-B1 waitText and describeGate: the wait is now minus updatedAt; the description follows the note, with a fallback', () => {
  const wait = row('AWAITING_GATE', gate('gate-p'), 1, { updatedAt: new Date(NOW - 12 * MIN).toISOString(), awaitingGate: { gateId: 'gate-p' }, progress: { done: 1, total: 5 } });
  assert.equal(rail.waitText(wait, NOW), '12 min');
  assert.equal(rail.waitText({ ...wait, updatedAt: null }, NOW), null);
  const named = rail.awaitingGateOf(WORKFLOW, wait);
  assert.equal(rail.describeGate(wait, { gate: { ...named, name: 'Before implementation' }, named: true, workflowName: 'Feature Delivery', nowMs: NOW }), 'Before implementation. Approval gate. Waiting for you for 12 min. Feature Delivery, step 2 of 5.');
  assert.equal(rail.describeGate({ ...wait, updatedAt: null, origin: 'other' }, { gate: { ...named, name: 'Before implementation' }, named: true, workflowName: 'Feature Delivery', nowMs: NOW }), 'Before implementation. Approval gate. Waiting for you. Feature Delivery, step 2 of 5. From another checkout.');
  assert.equal(rail.describeGate(wait, { gate: { id: 'gate-a', name: null, kind: null, prompt: null }, named: false, workflowName: 'Feature Delivery', nowMs: NOW }), 'Gate gate-a. Waiting for you for 12 min. Feature Delivery, step 2 of 5.');
});

test('CD-B1 the cards come longest wait first: Needs you is oldest updatedAt first', () => {
  const runs = [run('b', 'AWAITING_GATE', new Date(NOW - 2 * MIN).toISOString()), run('a', 'AWAITING_GATE', new Date(NOW - 90 * MIN).toISOString()), run('c', 'AWAITING_GATE', new Date(NOW - 10 * MIN).toISOString())];
  assert.deepEqual(rail.groupRuns(runs).needs.map((r: any) => r.taskId), ['a', 'c', 'b']);
});

test('CD-B4 tileFacts: one fact per tile, long and short forms, and the empty cases', () => {
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const runs = [
    run('w1', 'AWAITING_GATE', ago(134 * MIN)), run('w2', 'AWAITING_GATE', ago(5 * MIN)), run('w3', 'AWAITING_GATE', null),
    run('r1', 'RUNNING', ago(HOUR)), run('r2', 'RUNNING', ago(50 * HOUR)), run('r3', 'RUNNING', ago(30 * HOUR)),
    run('f1', 'COMPLETED', ago(MIN)), run('f2', 'COMPLETED', ago(MIN)), run('f3', 'REJECTED', ago(MIN)),
  ];
  const facts = rail.tileFacts(runs, NOW);
  assert.deepEqual(facts.needs, { long: 'longest wait 2 h 14 min', short: '2 h 14 min', prefix: 'longest wait ' });
  assert.deepEqual(facts.running, { long: '2 stale, no update for 2 d 2 h', short: '2 stale', prefix: '' });
  assert.deepEqual(facts.finished, { long: '2 completed, 1 rejected', short: '1 rejected', prefix: '' });
  const calm = rail.tileFacts([run('r', 'RUNNING', ago(MIN)), run('f', 'COMPLETED', ago(MIN))], NOW);
  assert.equal(calm.needs.long, 'nothing waiting');
  assert.equal(calm.running.long, 'all updating');
  assert.equal(calm.running.short, 'all updating');
  assert.deepEqual(calm.finished, { long: '1 completed, 0 rejected', short: '1 completed', prefix: '' });
  const none = rail.tileFacts([], NOW);
  assert.deepEqual([none.needs.long, none.running.long, none.finished.long, none.finished.short], ['nothing waiting', 'nothing running', 'none yet', 'none yet']);
  assert.equal(rail.tileFacts([run('w', 'AWAITING_GATE', null)], NOW).needs.long, 'wait unknown');
});

test('CD-B3/CD-B5 step parts: the id, "all steps done", "stopped at <id>", the n/m fraction and the head copy', () => {
  assert.deepEqual(rail.stepPart(row('RUNNING', stage('extra'), 2)), { lead: '', id: 'extra' });
  assert.deepEqual(rail.stepPart(row('COMPLETED', null, 5)), { lead: 'all steps done', id: null });
  assert.deepEqual(rail.stepPart(row('REJECTED', gate('gate-p'), 1)), { lead: 'stopped at ', id: 'gate-p' });
  assert.deepEqual(rail.stepPart(row('RUNNING', null, 2)), { lead: '', id: null });
  assert.equal(rail.stepFraction(row('RUNNING', stage('extra'), 2)), '3/5');
  assert.equal(rail.stepFraction(row('COMPLETED', null, 5)), '5/5');
  assert.equal(rail.stepFraction({ state: 'RUNNING' }), null);
  assert.deepEqual(rail.runStepCopy(row('RUNNING', stage('extra'), 2)), { lead: 'step ', n: 3, tail: ' of 5' });
  assert.deepEqual(rail.runStepCopy(row('AWAITING_GATE', gate('gate-q'), 3)), { lead: 'step ', n: 4, tail: ' of 5' });
  assert.deepEqual(rail.runStepCopy(row('COMPLETED', null, 5)), { lead: 'all 5 steps done', n: null, tail: '' });
  assert.deepEqual(rail.runStepCopy(row('REJECTED', gate('gate-p'), 1)), { lead: 'stopped at step ', n: 2, tail: ' of 5' });
  assert.equal(rail.runStepCopy({ state: 'RUNNING' }), null);
});

test('CD-B7 durationLine: the text under each node and the fg it takes', () => {
  const node = (over: any) => ({ type: 'stage', id: 'x', kind: 'k', optional: false, state: 'done', outcome: 'passed', synthetic: false, decision: null, forced: false, at: null, durationMs: null, since: null, ...over });
  const line = (over: any) => rail.durationLine(node(over), NOW);
  assert.deepEqual(line({ durationMs: 42 * MIN }), { text: '42 min', tone: null });
  assert.deepEqual(line({ type: 'gate', durationMs: 14 * MIN }), { text: '14 min', tone: null });
  assert.deepEqual(line({ state: 'rejected', type: 'gate', durationMs: 14 * MIN }), { text: '14 min', tone: null });
  assert.deepEqual(line({ state: 'running', since: new Date(NOW - 72 * MIN).toISOString() }), { text: 'for 1 h 12 min', tone: 'running' });
  assert.deepEqual(line({ state: 'stale', since: new Date(NOW - 30 * HOUR).toISOString() }), { text: 'for 1 d 6 h', tone: 'stale' });
  assert.deepEqual(line({ state: 'awaiting', type: 'gate', since: new Date(NOW - 3 * MIN).toISOString() }), { text: 'for 3 min', tone: 'awaiting' });
  assert.deepEqual(line({ state: 'skipped' }), { text: 'skipped', tone: null });
  assert.deepEqual(line({}), { text: '–', tone: null }, 'a done node with no duration');
  assert.deepEqual(line({ state: 'running' }), { text: '–', tone: null }, 'a cursor without since');
  assert.deepEqual(line({ state: 'pending' }), { text: ' ', tone: null });
  assert.deepEqual(line({ state: 'not-reached' }), { text: ' ', tone: null });
});

// ---- E.1 review r3: R3-5 (done above), R3-6, R3-7 ---------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');
const hmOnly = (ms: number) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;
/** R4-3, spelled out independently of the code: HH:MM on today's local date, "D Mon HH:MM" otherwise. */
const hm = (ms: number, now = NOW) => {
  const [a, b] = [new Date(ms), new Date(now)];
  const same = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return same ? hmOnly(ms) : `${a.getDate()} ${MONTHS[a.getMonth()]} ${hmOnly(ms)}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

test('R3-6 the fallback description keeps the wait when the time is known and drops it when not', () => {
  const wait = row('AWAITING_GATE', gate('gate-p'), 1, { updatedAt: new Date(NOW - 12 * MIN).toISOString(), progress: { done: 1, total: 5 } });
  const options = { gate: { id: 'gate-p', name: null, kind: null, prompt: null }, named: false, workflowName: 'X Flow', nowMs: NOW };
  assert.equal(rail.describeGate(wait, options), 'Gate gate-p. Waiting for you for 12 min. X Flow, step 2 of 5.');
  assert.equal(rail.describeGate({ ...wait, updatedAt: null }, options), 'Gate gate-p. Waiting for you. X Flow, step 2 of 5.');
});

test('R3-7 on stale data the durations measured to now stop: "since HH:MM" in the card description and in the tile sublines', () => {
  const at = NOW - 134 * MIN;
  const wait = row('AWAITING_GATE', gate('gate-p'), 1, { updatedAt: new Date(at).toISOString(), progress: { done: 1, total: 5 } });
  const stale = { stale: true };
  assert.equal(rail.describeGate(wait, { gate: { id: 'gate-p', name: 'Before', kind: 'approval', prompt: null }, named: true, workflowName: 'X Flow', nowMs: NOW, ...stale }), `Before. Approval gate. Waiting for you since ${hm(at)}. X Flow, step 2 of 5.`);
  assert.equal(rail.describeGate(wait, { gate: { id: 'gate-p', name: null, kind: null, prompt: null }, named: false, workflowName: 'X Flow', nowMs: NOW, ...stale }), `Gate gate-p. Waiting for you since ${hm(at)}. X Flow, step 2 of 5.`);
  const old = NOW - 50 * HOUR;
  const facts = rail.tileFacts([run('w', 'AWAITING_GATE', new Date(at).toISOString()), run('r', 'RUNNING', new Date(old).toISOString()), run('ok', 'RUNNING', new Date(NOW - MIN).toISOString())], NOW, stale);
  assert.deepEqual(facts.needs, { long: `waiting since ${hm(at)}`, short: hm(at), prefix: 'waiting since ' });
  const d = new Date(old);
  assert.equal(facts.running.long, `1 stale, no update since ${d.getDate()} ${MONTHS[d.getMonth()]} ${hmOnly(old)}`);
  assert.equal(facts.running.short, '1 stale');
  assert.equal(rail.tileFacts([run('w', 'AWAITING_GATE', new Date(at).toISOString())], NOW).needs.long, 'longest wait 2 h 14 min', 'fresh data is unchanged');
  assert.equal(rail.waitStamp(wait, NOW, true), hm(at));
  assert.equal(rail.waitStamp({ ...wait, updatedAt: null }, NOW, true), null);
});

test('R4-3 sinceStamp: HH:MM today, "D Mon HH:MM" on any other local day, and the day boundary', () => {
  const at = (day: number, h: number, m: number, sec = 0) => new Date(2026, 9, day, h, m, sec).getTime();
  const now = at(26, 21, 0);
  assert.equal(rail.sinceStamp(at(26, 19, 59), now), '19:59');
  assert.equal(rail.sinceStamp(at(26, 0, 0, 5), now), '00:00', 'just after midnight is still today');
  assert.equal(rail.sinceStamp(at(25, 23, 59, 59), now), '25 Oct 23:59', 'one second before midnight is yesterday');
  assert.equal(rail.sinceStamp(at(3, 8, 5), now), '3 Oct 08:05', 'the day has no leading zero');
  assert.equal(rail.sinceStamp(at(25, 23, 59), at(26, 0, 0, 1)), '25 Oct 23:59', 'a minute after midnight, last evening takes the day form');
  assert.equal(rail.sinceStamp(new Date(2025, 11, 31, 22, 0).getTime(), new Date(2026, 0, 1, 9, 0).getTime()), '31 Dec 22:00');
  const wait = row('AWAITING_GATE', gate('gate-p'), 1, { updatedAt: new Date(at(25, 20, 1)).toISOString(), progress: { done: 1, total: 5 } });
  assert.equal(rail.waitStamp(wait, now, true), '25 Oct 20:01');
  assert.equal(rail.tileFacts([run('w', 'AWAITING_GATE', new Date(at(25, 20, 1)).toISOString())], now, { stale: true }).needs.long, 'waiting since 25 Oct 20:01');
  assert.match(rail.describeGate(wait, { gate: { id: 'g', name: null, kind: null, prompt: null }, named: false, workflowName: 'X', nowMs: now, stale: true }), /Waiting for you since 25 Oct 20:01\./);
});
