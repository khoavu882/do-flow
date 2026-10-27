'use strict';

// The live run view's derivations (feature 093, IC-009 and IC-012; plan task E.2; design note E.2 sections 4, 5, 8, 9.3
// and 14.1). Pure functions over a run body: no DOM and no fetch. The cases build bodies in the shape of the captured
// fixture runs (run-work, run-approval, run-gate, run-done, run-rejected). Control: building the gate slot from the
// journal copy (`awaitingGate.prompt`) instead of the workflow registry turns the registry case red.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const ACTIVITY_SOURCE = fs.readFileSync(path.join(WEB_ROOT, 'derive', 'activity.js'), 'utf8');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-26T10:00:00.000Z');

let scratch: string[] = [];
let activity: any;
let timeline: any;

/** A copy of the derive/ directory (optionally with activity.js rewritten) as ES modules a CommonJS package can import. */
async function load(activitySource: string = ACTIVITY_SOURCE): Promise<{ activity: any, timeline: any }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-activity-'));
  scratch.push(dir);
  fs.cpSync(path.join(WEB_ROOT, 'derive'), path.join(dir, 'derive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'derive', 'activity.js'), activitySource);
  const href = (name: string) => pathToFileURL(path.join(dir, 'derive', name)).href;
  return { activity: await import(href('activity.js')), timeline: await import(href('timeline.js')) };
}

before(async () => { ({ activity, timeline } = await load()); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

// ---- bodies -----------------------------------------------------------------------------------------------

const WORKFLOW = {
  taskClass: 'feature',
  name: 'Feature Delivery',
  stages: [
    { id: 'discovery', skill: 'do-brainstorm', agent: 'spec-analyst', kind: 'discovery', optional: false, purpose: 'Resolve the idea into requirement.md.', gatesAfter: [{ id: 'gate-0', name: 'Unresolved clarifications', kind: 'clarification', trigger: 'unresolved-clarifications', prompt: 'Resolve each marker before design starts.' }] },
    { id: 'design', skill: 'do-design', agent: 'system-architect', kind: 'design', optional: false, purpose: 'Write design.md.', gatesAfter: [] },
    { id: 'planning', skill: 'do-plan', agent: 'system-architect', kind: 'planning', optional: false, purpose: 'Write plan.md.', gatesAfter: [{ id: 'gate-a', name: 'Before implementation', kind: 'approval', trigger: 'always', prompt: 'Approve the plan before any source edit.' }] },
    { id: 'implementation', skill: 'do-execute-plan', agent: 'delivery-lead', kind: 'implementation', optional: false, purpose: 'Build the plan.', gatesAfter: [] },
    { id: 'verification', skill: 'do-test', agent: 'quality-guardian', kind: 'verification', optional: true, purpose: 'Run the tests.', gatesAfter: [] },
    { id: 'review', skill: 'do-code-review', agent: 'reviewer', kind: 'review', optional: false, purpose: 'Review the change.', gatesAfter: [{ id: 'gate-b', name: 'Before merge', kind: 'approval', trigger: 'always', prompt: 'Approve the review.' }] },
  ],
};

const iso = (min: number) => new Date(T0 + min * MIN).toISOString();
const ev = (min: number | null, action: string, node: string | null = null, over: any = {}) => ({
  at: min === null ? null : iso(min), action, node, outcome: null, decision: null, forced: false, synthetic: false, ...over,
});
const row = (state: string, current: any, done: number, over: any = {}) => ({
  taskId: 'run-1', taskClass: 'feature', workflowName: 'Feature Delivery', state, current, awaitingGate: state === 'AWAITING_GATE' && current ? { gateId: current.id } : null,
  progress: { done, total: 9 }, revision: 5, journalGateDiffers: false, featureSlug: 'feat-a', startedAt: iso(0), updatedAt: iso(30), origin: 'current', ...over,
});
const stage = (id: string) => ({ type: 'stage', id, kind: id });
const gate = (id: string, kind = 'approval') => ({ type: 'gate', id, kind });
const tl = (events: any[], over: any = {}) => ({ v: 1, taskId: 'run-1', featureSlug: 'feat-a', revision: 5, startedAt: iso(0), events, otherEvents: 0, ...over });
const attempt = (token: number, owner: string, state: string, startedMin: number, over: any = {}) => ({ token, owner, mode: 'sequential', state, startedAt: iso(startedMin), endedAt: null, result: null, ...over });
const tasksOf = (...tasks: any[]) => ({ revision: 3, graph: { tasks: [] }, tasks });
const task = (id: string, ...attempts: any[]) => ({ id, state: 'IN_PROGRESS', reason: null, budget: { used: attempts.length, limit: 20 }, attempts });

/** A run waiting at gate-a: discovery, gate-0, design and planning are done. */
const GATE_EVENTS = [ev(0, 'start'), ev(5, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(8, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(20, 'complete-stage', 'design', { outcome: 'passed' }), ev(30, 'complete-stage', 'planning', { outcome: 'passed' })];
const atGateA = (over: any = {}) => row('AWAITING_GATE', gate('gate-a'), 4, over);

// ---- the gate slot ----------------------------------------------------------------------------------------

test('gate slot: the name and prompt come from the workflow registry, never from the journal copy in run.awaitingGate', () => {
  const journal = { gateId: 'gate-a', name: 'Journal name', prompt: 'Journal prompt' };
  const model = activity.deriveActivity(atGateA({ awaitingGate: journal }), WORKFLOW, tl(GATE_EVENTS), null, T0 + 42 * MIN);
  assert.equal(model.kind, 'gate');
  assert.deepEqual(model.node, { type: 'gate', id: 'gate-a', name: 'Before implementation', kind: 'approval', prompt: 'Approve the plan before any source edit.', after: 'planning' });
});

test('control: building the gate slot from awaitingGate.prompt turns the registry case red', async () => {
  const anchor = 'prompt: entry.prompt ?? null,';
  assert.ok(ACTIVITY_SOURCE.includes(anchor), 'the mechanism line exists in derive/activity.js');
  const mutated = (await load(ACTIVITY_SOURCE.replace(anchor, 'prompt: row.awaitingGate.prompt,'))).activity;
  const journal = { gateId: 'gate-a', name: 'Journal name', prompt: 'Journal prompt' };
  const body = atGateA({ awaitingGate: journal });
  assert.equal(mutated.deriveActivity(body, WORKFLOW, tl(GATE_EVENTS), null, T0 + 42 * MIN).node.prompt, 'Journal prompt', 'the mutation reads the journal copy');
  assert.notEqual(mutated.deriveActivity(body, WORKFLOW, tl(GATE_EVENTS), null, T0 + 42 * MIN).node.prompt, activity.deriveActivity(body, WORKFLOW, tl(GATE_EVENTS), null, T0 + 42 * MIN).node.prompt);
});

test('gate slot: the decide commands are two complete lines with the run id and the gate id, and no --slug', () => {
  const model = activity.deriveActivity(atGateA(), WORKFLOW, tl(GATE_EVENTS), null, T0 + 42 * MIN);
  assert.deepEqual(model.command, {
    approve: 'doflow orchestrate --action decide-gate --task-id run-1 --gate gate-a --decision approve',
    reject: 'doflow orchestrate --action decide-gate --task-id run-1 --gate gate-a --decision reject',
  });
  assert.ok(!JSON.stringify(model.command).includes('--slug'));
  assert.deepEqual(activity.decideCommands(row('AWAITING_GATE', gate('gate-0', 'clarification'), 1, { taskId: 'run-x' })), {
    approve: 'doflow orchestrate --action decide-gate --task-id run-x --gate gate-0 --decision approve',
    reject: 'doflow orchestrate --action decide-gate --task-id run-x --gate gate-0 --decision reject',
  });
  assert.equal(activity.deriveActivity(row('RUNNING', stage('design'), 2), WORKFLOW, tl(GATE_EVENTS), null, T0).command, null, 'only a gate has commands');
});

test('waitedMs counts from the last progress event: a note added during the wait does not reset it', () => {
  const events = [...GATE_EVENTS, ev(36, 'annotate', 'planning')];
  const model = activity.deriveActivity(atGateA(), WORKFLOW, tl(events), null, T0 + 42 * MIN);
  assert.equal(model.since, iso(30));
  assert.equal(model.waitedMs, 12 * MIN, 'not 6 min, which is what the note would give');
  assert.equal(model.sinceEvent.node, 'planning');
  assert.deepEqual([model.lastEvent.action, model.lastEvent.at, model.lastEvent.words], ['annotate', iso(36), 'Note added on planning'], 'the slot still shows the literal last event');
  assert.equal(activity.deriveActivity(atGateA(), WORKFLOW, tl(GATE_EVENTS), null, T0 + 20 * MIN).waitedMs, 0, 'floored at zero when the clock is behind the record');
});

test('a last progress event without a time gives no since and no wait, never zero', () => {
  const events = [...GATE_EVENTS.slice(0, 4), ev(null, 'complete-stage', 'planning', { outcome: 'passed' })];
  const model = activity.deriveActivity(atGateA(), WORKFLOW, tl(events), null, T0 + 42 * MIN);
  assert.equal(model.since, null);
  assert.equal(model.waitedMs, null);
  const none = activity.deriveActivity(atGateA(), WORKFLOW, tl([]), null, T0 + 42 * MIN);
  assert.deepEqual([none.since, none.waitedMs, none.lastEvent], [null, null, null]);
  const unavailable = activity.deriveActivity(atGateA(), WORKFLOW, null, null, T0 + 42 * MIN);
  assert.deepEqual([unavailable.since, unavailable.waitedMs, unavailable.lastEvent, unavailable.timelineAvailable], [null, null, null, false]);
});

// ---- the stage slot ---------------------------------------------------------------------------------------

test('stage slot: the registry stage with its position among the stages, and the running attempts oldest first, at most 8', () => {
  const workRow = row('RUNNING', stage('implementation'), 5);
  const attempts = [
    task('A.3', attempt(1, 'system-architect', 'finished', 1, { result: 'FAILED', endedAt: iso(2) }), attempt(2, 'system-architect', 'active', 40)),
    task('B.1', attempt(1, 'core-implementer', 'active', 35)),
    task('C.2', attempt(1, 'quality-guardian', 'active', 35)),
    task('D.1', attempt(1, 'reviewer', 'released', 36, { endedAt: iso(37) })),
  ];
  const model = activity.deriveActivity(workRow, WORKFLOW, tl(GATE_EVENTS), tasksOf(...attempts), T0 + 50 * MIN);
  assert.equal(model.kind, 'stage');
  assert.deepEqual(model.node, { type: 'stage', id: 'implementation', skill: 'do-execute-plan', agent: 'delivery-lead', purpose: 'Build the plan.', index: 4, count: 6 });
  assert.deepEqual(model.running.shown.map((a: any) => [a.taskId, a.attemptNo, a.owner, a.mode, a.startedAt]), [
    ['B.1', 1, 'core-implementer', 'sequential', iso(35)],
    ['C.2', 1, 'quality-guardian', 'sequential', iso(35)],
    ['A.3', 2, 'system-architect', 'sequential', iso(40)],
  ], 'oldest first, ties by task id, attemptNo is the position in the task ledger');
  assert.equal(model.running.more, 0);
  assert.equal(model.command, null);
});

test('running attempts: 9 active show 8 and count the rest; none active gives an empty list; no plan gives null', () => {
  const nine = tasksOf(...Array.from({ length: 9 }, (_, i) => task(`T.${i + 1}`, attempt(1, 'o', 'active', 30 + i))));
  const model = activity.deriveActivity(row('RUNNING', stage('implementation'), 5), WORKFLOW, tl(GATE_EVENTS), nine, T0 + 50 * MIN);
  assert.equal(model.running.shown.length, 8);
  assert.equal(model.running.more, 1);
  assert.equal(model.running.shown[7].taskId, 'T.8', 'the newest is the one left out');
  const zero = activity.deriveActivity(row('RUNNING', stage('implementation'), 5), WORKFLOW, tl(GATE_EVENTS), tasksOf(task('A.1', attempt(1, 'o', 'finished', 30))), T0 + 50 * MIN);
  assert.deepEqual(zero.running, { shown: [], more: 0 });
  assert.equal(activity.deriveActivity(row('RUNNING', stage('implementation'), 5), WORKFLOW, tl(GATE_EVENTS), null, T0 + 50 * MIN).running, null);
  assert.deepEqual(activity.attemptRows(nine, 3).shown.length, 3);
  assert.equal(activity.attemptRows(null, 8), null);
});

test('running attempts are computed for every kind of step, a waiting gate and a finished run included', () => {
  const one = tasksOf(task('A.2', attempt(1, 'quality-guardian', 'active', 12)));
  const waiting = activity.deriveActivity(atGateA(), WORKFLOW, tl(GATE_EVENTS), one, T0 + 42 * MIN);
  assert.deepEqual(waiting.running.shown.map((a: any) => a.taskId), ['A.2']);
  const done = activity.deriveActivity(row('COMPLETED', null, 9), WORKFLOW, tl([...GATE_EVENTS, ev(60, 'complete-run')]), one, T0 + 90 * MIN);
  assert.deepEqual(done.running.shown.map((a: any) => a.taskId), ['A.2']);
});

test('a step the registry does not hold is marked missing, with the id and no registry fields', () => {
  const stageGone = activity.deriveActivity(row('RUNNING', stage('mystery'), 2), WORKFLOW, tl(GATE_EVENTS), null, T0 + 50 * MIN);
  assert.deepEqual(stageGone.node, { type: 'stage', id: 'mystery', missing: true, skill: null, agent: null, purpose: null, index: null, count: 6 });
  const gateGone = activity.deriveActivity(row('AWAITING_GATE', gate('gate-z', 'clarification'), 2), WORKFLOW, tl(GATE_EVENTS), null, T0 + 50 * MIN);
  assert.deepEqual(gateGone.node, { type: 'gate', id: 'gate-z', missing: true, name: null, kind: 'clarification', prompt: null, after: null });
  assert.equal(gateGone.command.approve, 'doflow orchestrate --action decide-gate --task-id run-1 --gate gate-z --decision approve', 'the commands need only ids');
  const noWorkflow = activity.deriveActivity(row('RUNNING', stage('design'), 2), null, tl(GATE_EVENTS), null, T0 + 50 * MIN);
  assert.equal(noWorkflow.node.missing, true);
  assert.equal(noWorkflow.workflowUnavailable, true);
});

// ---- the finished slot ------------------------------------------------------------------------------------

test('finished COMPLETED: no node, the run took complete-run minus the start', () => {
  const events = [...GATE_EVENTS, ev(50, 'complete-stage', 'implementation', { outcome: 'passed' }), ev(134, 'complete-run')];
  const model = activity.deriveActivity(row('COMPLETED', null, 9, { updatedAt: iso(134) }), WORKFLOW, tl(events), null, T0 + 300 * MIN);
  assert.equal(model.kind, 'finished');
  assert.equal(model.node, null);
  assert.equal(model.waitedMs, 134 * MIN);
  assert.equal(model.lastEvent.words, 'Run completed');
  const untimed = activity.deriveActivity(row('COMPLETED', null, 9), WORKFLOW, tl([...GATE_EVENTS, ev(null, 'complete-run')]), null, T0 + 300 * MIN);
  assert.equal(untimed.waitedMs, null, 'an unrecorded end is not a zero');
});

test('finished REJECTED: the rejecting gate, and how long it waited before the rejection', () => {
  const events = [...GATE_EVENTS, ev(36, 'annotate', 'planning'), ev(42, 'decide-gate', 'gate-a', { decision: 'reject' })];
  const model = activity.deriveActivity(row('REJECTED', gate('gate-a'), 4), WORKFLOW, tl(events), null, T0 + 90 * MIN);
  assert.equal(model.kind, 'finished');
  assert.equal(model.node.id, 'gate-a');
  assert.equal(model.node.name, 'Before implementation');
  assert.equal(model.waitedMs, 12 * MIN, 'from the last progress event before it, a note does not count');
  assert.equal(model.lastEvent.words, 'gate-a rejected');
});

// ---- event words ------------------------------------------------------------------------------------------

test('eventWords: the copy of every action, forced and imported marks, and the clause form', () => {
  const w = (e: any) => activity.eventWords(e);
  assert.equal(w(ev(0, 'start')), 'Run started');
  assert.equal(w(ev(1, 'complete-stage', 'design', { outcome: 'passed' })), 'design completed, passed');
  assert.equal(w(ev(1, 'complete-stage', 'design')), 'design completed');
  assert.equal(w(ev(1, 'skip-stage', 'verification')), 'verification skipped');
  assert.equal(w(ev(1, 'skip-gate', 'gate-b')), 'gate-b skipped');
  assert.equal(w(ev(1, 'decide-gate', 'gate-a', { decision: 'approve' })), 'gate-a approved');
  assert.equal(w(ev(1, 'decide-gate', 'gate-a', { decision: 'approve', forced: true })), 'gate-a approved, forced');
  assert.equal(w(ev(1, 'decide-gate', 'gate-a', { decision: 'reject' })), 'gate-a rejected');
  assert.equal(w(ev(1, 'annotate', 'design')), 'Note added on design');
  assert.equal(w(ev(1, 'annotate', null)), 'Note added');
  assert.equal(w(ev(1, 'complete-run')), 'Run completed');
  assert.equal(w(ev(1, 'complete-stage', 'design', { outcome: 'passed', synthetic: true })), 'design completed, passed, imported');
  assert.equal(activity.clauseWords(ev(1, 'decide-gate', 'gate-a', { decision: 'approve' })), 'gate-a was approved');
  assert.equal(activity.clauseWords(ev(1, 'complete-stage', 'design', { outcome: 'passed' })), 'design completed, passed');
  assert.equal(activity.clauseWords(ev(1, 'skip-stage', 'verification')), 'verification was skipped');
  assert.equal(activity.clauseWords(ev(1, 'start')), 'the run started');
  assert.equal(activity.clauseWords(ev(1, 'annotate', 'design')), 'a note was added on design');
});

// ---- the timeline -----------------------------------------------------------------------------------------

const RUN_EVENTS = [
  ev(0, 'start'),
  ev(5, 'complete-stage', 'discovery', { outcome: 'passed' }),
  ev(6, 'annotate', 'discovery'),
  ev(8, 'decide-gate', 'gate-0', { decision: 'approve', forced: true }),
  ev(20, 'complete-stage', 'design', { outcome: 'failed' }),
  ev(30, 'complete-stage', 'planning', { outcome: 'passed', synthetic: true }),
];

test('timeline: segments come from event times, from the previous progress event, and a gate wait is a wait', () => {
  const model = timeline.deriveTimeline(WORKFLOW, atGateA(), tl(RUN_EVENTS), T0 + 42 * MIN);
  assert.equal(model.degraded, null);
  assert.deepEqual(model.rows.map((r: any) => r.node.id), ['discovery', 'gate-0', 'design', 'planning', 'gate-a', 'implementation', 'verification', 'review', 'gate-b']);
  const seg = (id: string) => model.rows.find((r: any) => r.node.id === id).segments.map((s: any) => [s.kind, s.fromMs - T0, s.toMs - T0]);
  assert.deepEqual(seg('discovery'), [['stage', 0, 5 * MIN]]);
  assert.deepEqual(seg('gate-0'), [['wait', 5 * MIN, 8 * MIN]], 'the note at minute 6 does not cut the wait short');
  assert.deepEqual(seg('design'), [['stage', 8 * MIN, 20 * MIN]]);
  assert.deepEqual(seg('planning'), [['stage', 20 * MIN, 30 * MIN]]);
  assert.deepEqual(seg('gate-a'), [['live', 30 * MIN, 42 * MIN]], 'the waiting gate runs from the last progress event to now');
  for (const id of ['implementation', 'verification', 'review', 'gate-b']) assert.deepEqual(seg(id), [], `${id} has no segment`);
  assert.deepEqual(model.markers, [{ atMs: T0 + 6 * MIN, nodeId: 'discovery' }]);
  assert.equal(model.domain.live, true);
  assert.equal(model.domain.startMs, T0);
});

test('timeline: a running stage is live; a skip is a ring at its time; a node completed twice has two segments', () => {
  const events = [ev(0, 'start'), ev(5, 'complete-stage', 'discovery', { outcome: 'failed' }), ev(9, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(10, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(12, 'skip-stage', 'design')];
  const model = timeline.deriveTimeline(WORKFLOW, row('RUNNING', stage('planning'), 3), tl(events), T0 + 20 * MIN);
  const seg = (id: string) => model.rows.find((r: any) => r.node.id === id).segments.map((s: any) => [s.kind, s.fromMs - T0, s.toMs - T0]);
  assert.deepEqual(seg('discovery'), [['stage', 0, 5 * MIN], ['stage', 5 * MIN, 9 * MIN]]);
  assert.deepEqual(seg('design'), [['skip', 12 * MIN, 12 * MIN]]);
  assert.deepEqual(seg('planning'), [['live', 12 * MIN, 20 * MIN]]);
});

test('timeline: a rejected gate is a wait, the steps after it have no segment, and a finished run has no live segment', () => {
  const rejected = timeline.deriveTimeline(WORKFLOW, row('REJECTED', gate('gate-a'), 4), tl([...GATE_EVENTS, ev(42, 'decide-gate', 'gate-a', { decision: 'reject' })]), T0 + 90 * MIN);
  const gateA = rejected.rows.find((r: any) => r.node.id === 'gate-a');
  assert.deepEqual(gateA.segments.map((s: any) => [s.kind, s.fromMs - T0, s.toMs - T0]), [['wait', 30 * MIN, 42 * MIN]]);
  assert.equal(gateA.node.state, 'rejected');
  assert.deepEqual(rejected.rows.find((r: any) => r.node.id === 'implementation').segments, []);
  assert.equal(rejected.domain.live, false);
  assert.equal(rejected.domain.endMs, T0 + 42 * MIN, 'a finished run ends at its last event');
  assert.ok(rejected.rows.every((r: any) => r.segments.every((s: any) => s.kind !== 'live')));
});

test('timeline: an event without a time is counted and placed nowhere; otherEvents passes through; a run with no usable time has no live segment', () => {
  const events = [ev(0, 'start'), ev(null, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(8, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(null, 'annotate', 'design')];
  const model = timeline.deriveTimeline(WORKFLOW, row('RUNNING', stage('design'), 2), tl(events, { otherEvents: 2 }), T0 + 20 * MIN);
  assert.equal(model.untimed, 2);
  assert.equal(model.other, 2);
  assert.deepEqual(model.rows.find((r: any) => r.node.id === 'discovery').segments, [], 'a null time cannot be drawn');
  assert.deepEqual(model.markers, []);
  assert.deepEqual(model.list.map((item: any) => item.at), [null, iso(8), null, iso(0)], 'the list keeps every event, newest first');
  const noTime = timeline.deriveTimeline(WORKFLOW, row('RUNNING', stage('design'), 2), tl([ev(0, 'start'), ev(null, 'complete-stage', 'discovery'), ev(null, 'decide-gate', 'gate-0', { decision: 'approve' })]), T0 + 20 * MIN);
  assert.deepEqual(noTime.rows.find((r: any) => r.node.id === 'design').segments, [], 'the last progress event has no time: the live segment is unknown');
});

test('timeline list: newest first with the duration each event closed, and none for start, a note, an untimed event or the end of the run', () => {
  const model = timeline.deriveTimeline(WORKFLOW, atGateA(), tl(RUN_EVENTS), T0 + 42 * MIN);
  assert.deepEqual(model.list.map((i: any) => [i.words, i.durationMs]), [
    ['planning completed, passed, imported', 10 * MIN],
    ['design completed, failed', 12 * MIN],
    ['gate-0 approved, forced', 3 * MIN],
    ['Note added on discovery', null],
    ['discovery completed, passed', 5 * MIN],
    ['Run started', null],
  ]);
  const finished = timeline.deriveTimeline(WORKFLOW, row('COMPLETED', null, 9), tl([ev(0, 'start'), ev(5, 'complete-stage', 'discovery'), ev(5, 'complete-run')]), T0 + 60 * MIN);
  assert.equal(finished.list[0].words, 'Run completed');
  assert.equal(finished.list[0].durationMs, null);
});

test('timeline: a timeline that could not be read is unavailable; a rail that does not match is a list', () => {
  const none = timeline.deriveTimeline(WORKFLOW, atGateA(), null, T0 + 42 * MIN);
  assert.equal(none.available, false);
  assert.deepEqual([none.rows.length, none.list.length, none.untimed], [9, 0, 0], 'the rows are the program with no segments');
  assert.ok(none.rows.every((r: any) => r.segments.length === 0));
  const mismatch = timeline.deriveTimeline(WORKFLOW, row('RUNNING', stage('design'), 7), tl(RUN_EVENTS), T0 + 42 * MIN);
  assert.equal(mismatch.degraded, 'cursor-mismatch');
  assert.deepEqual(mismatch.rows, [], 'the chart needs the program');
  assert.equal(mismatch.list.length, 6);
});

test('tickStep: the smallest step that gives at most floor(track / 96) ticks, at 396 and 888 px', () => {
  const step = (span: number, px: number) => timeline.tickStep(span, px);
  assert.deepEqual([step(30_000, 396), step(30_000, 888)], [15_000, 5_000]);
  assert.deepEqual([step(2 * HOUR, 396), step(2 * HOUR, 888)], [30 * MIN, 15 * MIN]);
  assert.deepEqual([step(3 * DAY, 396), step(3 * DAY, 888)], [DAY, 12 * HOUR]);
  assert.equal(step(1000 * DAY, 396), 7 * DAY, 'a span past the table takes the largest step');
  assert.equal(step(0, 396), 1000);
});

test('axisDomain: a live run ends at now plus 10 % of its span on a tick step, a finished one at its last event, an instant at one second', () => {
  const live = timeline.axisDomain({ startMs: T0, endMs: T0 + 50 * MIN, live: true }, T0 + 50 * MIN, 888);
  assert.equal(live.startMs, T0);
  assert.ok(live.endMs >= T0 + 55 * MIN, 'at least now + 10 %');
  assert.ok(live.endMs < T0 + 55 * MIN + live.step, 'rounded up by less than a step');
  assert.equal((live.endMs - live.startMs) % live.step, 0);
  const finished = timeline.axisDomain({ startMs: T0, endMs: T0 + 42 * MIN, live: false }, T0 + 90 * MIN, 888);
  assert.equal(finished.endMs, T0 + 42 * MIN);
  const instant = timeline.axisDomain({ startMs: T0, endMs: T0, live: false }, T0 + 90 * MIN, 888);
  assert.equal(instant.endMs - instant.startMs, 1000);
  assert.equal(timeline.position({ startMs: T0, endMs: T0 + 100 }, T0 + 25), 0.25);
  assert.equal(timeline.position({ startMs: T0, endMs: T0 + 100 }, T0 - 5), 0, 'clamped');
  assert.equal(timeline.position({ startMs: T0, endMs: T0 + 3 }, T0 + 1), 0.3333, 'four decimals');
});

test('tickMarks: ticks on whole steps of the local clock inside the axis, a date label at a local midnight', () => {
  const start = new Date(2026, 9, 24, 22, 30, 0).getTime();
  const marks = timeline.tickMarks({ startMs: start, endMs: start + 3 * HOUR, step: HOUR });
  assert.deepEqual(marks.map((m: any) => m.label), ['23:00', '25 Oct', '01:00'], 'the tick on the local midnight reads as its date');
  assert.ok(marks.every((m: any) => m.atMs > start && m.atMs <= start + 3 * HOUR && m.fraction > 0 && m.fraction <= 1));
  assert.equal(marks[0].fraction, 0.1667);
  const seconds = timeline.tickMarks({ startMs: new Date(2026, 9, 24, 10, 0, 0).getTime(), endMs: new Date(2026, 9, 24, 10, 0, 30).getTime(), step: 5000 });
  assert.equal(seconds[0].label, '10:00:05');
  assert.equal(seconds.length, 6);
  const days = timeline.tickMarks({ startMs: new Date(2026, 9, 24, 12, 0, 0).getTime(), endMs: new Date(2026, 9, 28, 12, 0, 0).getTime(), step: DAY });
  assert.deepEqual(days.map((m: any) => m.label), ['25 Oct', '26 Oct', '27 Oct', '28 Oct']);
  const weekly = timeline.tickMarks({ startMs: new Date(2026, 9, 24, 12, 0, 0).getTime(), endMs: new Date(2026, 10, 24, 12, 0, 0).getTime(), step: 7 * DAY });
  assert.deepEqual(weekly.map((m: any) => m.label), ['31 Oct', '7 Nov', '14 Nov', '21 Nov']);
});

test('mergeMarkers: markers closer than 6 px on the track merge into one', () => {
  const domain = { startMs: T0, endMs: T0 + 1000 };
  const markers = [{ atMs: T0 + 100, nodeId: 'a' }, { atMs: T0 + 104, nodeId: 'a' }, { atMs: T0 + 300, nodeId: 'a' }, { atMs: T0 + 304, nodeId: 'b' }];
  assert.deepEqual(timeline.mergeMarkers(markers, domain, 1000).map((m: any) => m.atMs), [T0 + 100, T0 + 300, T0 + 304], 'per node: a at 300 and b at 304 are different rows');
  assert.equal(timeline.mergeMarkers(markers, domain, 10).filter((m: any) => m.nodeId === 'a').length, 1, 'on a 10 px track all three are within 6 px');
});

// ---- announcements, counts and the chart's words ---------------------------------------------------------------

test('attemptChanges: the first poll announces nothing; one start, one finish and a burst read as E.2 section 11.2 says', () => {
  const first = tasksOf(task('A.3', attempt(1, 'system-architect', 'active', 10)));
  const seen = activity.attemptChanges(null, first);
  assert.deepEqual([seen.sentence, seen.changes], [null, []], 'the first render of a view instance only records');
  assert.deepEqual(seen.map, { 'A.3#1': 'active' });
  const started = activity.attemptChanges(seen.map, tasksOf(task('A.3', attempt(1, 'system-architect', 'active', 10)), task('B.1', attempt(1, 'core-implementer', 'active', 20))));
  assert.equal(started.sentence, 'B.1 started by core-implementer.');
  const second = activity.attemptChanges(seen.map, tasksOf(task('A.3', attempt(1, 'system-architect', 'active', 10), attempt(2, 'system-architect', 'active', 21))));
  assert.equal(second.sentence, 'A.3 attempt 2 started by system-architect.');
  const finished = activity.attemptChanges(seen.map, tasksOf(task('A.3', attempt(1, 'system-architect', 'finished', 10, { result: 'FAILED', endedAt: iso(15) }))));
  assert.equal(finished.sentence, 'A.3 attempt 1 finished: failed.');
  const released = activity.attemptChanges(seen.map, tasksOf(task('A.3', attempt(1, 'system-architect', 'released', 10, { endedAt: iso(15) }))));
  assert.equal(released.sentence, 'A.3 attempt 1 finished: released.', 'without a result the state is the word');
  const burst = activity.attemptChanges(seen.map, tasksOf(task('A.3', attempt(1, 'system-architect', 'finished', 10, { result: 'COMPLETED' })), task('B.1', attempt(1, 'o', 'active', 20))));
  assert.equal(burst.sentence, '2 task attempts changed.');
  const same = activity.attemptChanges(seen.map, first);
  assert.deepEqual([same.sentence, same.changes], [null, []]);
  assert.equal(activity.attemptChanges({}, null).sentence, null, 'no plan, no attempt announcements');
});

test('finishedCounts: only the non-zero parts, in the order of the note, steps counting stages and gates', () => {
  const rail = timeline.deriveTimeline(WORKFLOW, row('COMPLETED', null, 9), tl([
    ev(0, 'start'), ev(5, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(6, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(7, 'complete-stage', 'design', { outcome: 'failed' }),
    ev(8, 'complete-stage', 'planning', { outcome: 'unverified' }), ev(9, 'decide-gate', 'gate-a', { decision: 'approve', forced: true }), ev(10, 'complete-stage', 'implementation', { outcome: 'passed' }),
    ev(11, 'skip-stage', 'verification'), ev(12, 'complete-stage', 'review', { outcome: 'passed' }), ev(13, 'skip-gate', 'gate-b'), ev(13, 'complete-run'),
  ]), T0 + 3 * HOUR).rail.nodes;
  assert.equal(activity.finishedCounts(rail), '9 steps: 3 passed, 1 failed, 1 unverified, 1 approved, 1 forced, 2 skipped.');
  assert.equal(activity.finishedCounts([]), null);
});

test('rowCopy: the duration column and the accessible line of a done stage, a decided gate, a live row, a skip and stale data', () => {
  const model = timeline.deriveTimeline(WORKFLOW, atGateA(), tl(RUN_EVENTS), T0 + 42 * MIN);
  const of = (id: string, over: any = {}) => timeline.rowCopy(model.rows.find((r: any) => r.node.id === id), { nowMs: T0 + 42 * MIN, stale: false, staleRun: false, ...over });
  const hm = (min: number) => { const d = new Date(T0 + min * MIN); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  assert.equal(of('discovery').dur, '5 min');
  assert.equal(of('discovery').copy, `discovery. Stage. Done, passed. From ${hm(0)} to ${hm(5)}, 5 min.`);
  assert.equal(of('gate-0').dur, 'waited 3 min, forced');
  assert.equal(of('planning').dur, '10 min, imported');
  assert.equal(of('gate-a').dur, 'waiting 12 min');
  assert.equal(of('gate-a', { stale: true }).dur, `since ${hm(30)}`, 'no figure grows on stale data');
  assert.equal(of('gate-a', { staleRun: true }).dur, `no update since ${hm(30)}`);
  assert.equal(of('implementation').dur, 'not started');
  assert.equal(of('implementation').copy, 'implementation. Stage. Not started. Not started.');
  const skip = timeline.deriveTimeline(WORKFLOW, row('RUNNING', stage('planning'), 3), tl([ev(0, 'start'), ev(5, 'complete-stage', 'discovery'), ev(6, 'decide-gate', 'gate-0', { decision: 'approve' }), ev(12, 'skip-stage', 'design')]), T0 + 20 * MIN);
  assert.equal(timeline.rowCopy(skip.rows.find((r: any) => r.node.id === 'design'), { nowMs: T0 + 20 * MIN, stale: false, staleRun: false }).dur, 'skipped');
  const noTime = timeline.deriveTimeline(WORKFLOW, row('RUNNING', stage('design'), 2), tl([ev(0, 'start'), ev(null, 'complete-stage', 'discovery', { outcome: 'passed' }), ev(8, 'decide-gate', 'gate-0', { decision: 'approve' })]), T0 + 20 * MIN);
  assert.equal(timeline.rowCopy(noTime.rows.find((r: any) => r.node.id === 'discovery'), { nowMs: T0 + 20 * MIN, stale: false, staleRun: false }).dur, 'time not recorded', 'missing data reads as missing, never zero');
});
