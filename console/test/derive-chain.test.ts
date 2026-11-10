'use strict';

// The chain model (feature 150, IC-016; plan task C.1). Pure cases over the run route's body and the
// `/api/worker-runs/:slug` body: the Chain levels scenario (two stages, one gate, two tasks, three attempts, one worker
// run per attempt and one child), an ended attempt's run shown, the unlinked main session and an unmatched run with no
// edge, `not-checked` under `notShown` and under the older-core fallback (never "no worker run"), live counts per node
// kind, and the node keys. The `worker-runs` body goes through the Console's own projector, so the shape is the one
// the page receives; the fallback body is the one `workerRuns` composes (console/src/routes.ts `fallbackRun`).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { project } = require('../src/project.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const CHAIN_SOURCE = fs.readFileSync(path.join(WEB_ROOT, 'derive', 'chain.js'), 'utf8');
const MIN = 60_000;
const T0 = Date.parse('2026-11-08T05:00:00.000Z');
const NOW = T0 + 30 * MIN;

let scratch: string[] = [];
let chain: any;

/** A copy of the derive/ directory as ES modules a CommonJS package can import. */
async function load(): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-chain-'));
  scratch.push(dir);
  fs.cpSync(path.join(WEB_ROOT, 'derive'), path.join(dir, 'derive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  return import(pathToFileURL(path.join(dir, 'derive', 'chain.js')).href);
}

before(async () => { chain = await load(); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

// ---- bodies ---------------------------------------------------------------------------------------------

const iso = (min: number) => new Date(T0 + min * MIN).toISOString();
const WORKFLOW = {
  taskClass: 'feature', name: 'Feature Flow',
  stages: [
    { id: 'plan', kind: 'planning', optional: false, skill: 's', agent: 'a', purpose: 'p', gatesAfter: [{ id: 'gate-plan', kind: 'approval', trigger: 'always', name: 'n', prompt: 'q' }] },
    { id: 'build', kind: 'implementation', optional: false, skill: 's', agent: 'a', purpose: 'p', gatesAfter: [] },
  ],
};
const ROW = {
  taskId: 'run-1', taskClass: 'feature', workflowName: 'Feature Flow', state: 'RUNNING', current: { type: 'stage', id: 'build', kind: 'implementation' },
  awaitingGate: null, progress: { done: 2, total: 3 }, revision: 4, journalGateDiffers: false,
  featureSlug: 'feat-a', startedAt: iso(0), updatedAt: iso(20), origin: 'current',
};
const ev = (min: number, action: string, node: string | null, over: any = {}) => ({ at: iso(min), action, node, outcome: null, decision: null, forced: false, synthetic: false, ...over });
const TIMELINE = {
  v: 1, taskId: 'run-1', featureSlug: 'feat-a', revision: 4, startedAt: iso(0), otherEvents: 0,
  events: [ev(0, 'start', null), ev(5, 'complete-stage', 'plan', { outcome: 'passed' }), ev(8, 'decide-gate', 'gate-plan', { decision: 'approve' })],
};
const att = (token: number, state: string, startMin: number, endMin: number | null, result: string | null = null) => ({
  token, owner: 'core-implementer', mode: 'subagent', state, startedAt: iso(startMin), endedAt: endMin === null ? null : iso(endMin), result, worktreeKey: null, run: null, lineage: null,
});
const TASKS = {
  revision: 3,
  graph: { digest: 'd', graphPlan: true, tasks: [], overlaps: [] },
  tasks: [
    { id: 'A.1', state: 'SUCCEEDED', reason: 'completed', budget: { used: 1, limit: 3 }, attempts: [att(1, 'finished', 9, 14, 'COMPLETED')] },
    { id: 'A.2', state: 'RUNNING', reason: 'active-attempt', budget: { used: 2, limit: 3 }, attempts: [att(1, 'superseded', 10, 15), att(2, 'active', 16, null)] },
  ],
};
const runBody = (over: any = {}) => ({ v: 1, run: ROW, timeline: TIMELINE, tasks: TASKS, workflow: WORKFLOW, ...over });

const RUN_A11 = 'w-0000000000a1';
const RUN_A21 = 'w-0000000000b1';
const RUN_A22 = 'w-0000000000b2';
const RUN_CHILD = 'w-0000000000c1';
const RUN_LOOSE = 'w-0000000000d1';
const RUN_ORPHAN = 'w-0000000000e1';
const RUN_MISSING = 'w-0000000000ff';

const wr = (runId: string, task: string, token: number, phase: string, endState: string | null, min: number, childOf: string | null = null) => ({
  runId, task, token, harness: 'codex', childOf, phase, endState, createdAt: iso(min), startedAt: iso(min), endedAt: phase === 'ended' ? iso(min + 3) : null, edit: false,
});
const SCENARIO_RUNS = [
  wr(RUN_A11, 'A.1', 1, 'ended', 'exited', 9),
  wr(RUN_A21, 'A.2', 1, 'ended', 'cancelled', 10),
  wr(RUN_A22, 'A.2', 2, 'running', null, 16),
  wr(RUN_CHILD, 'A.2', 2, 'running', null, 17, RUN_A22),
];

/** The `/api/worker-runs/:slug` body as the Console projects the core's `worker-runs` output. */
function listed(runs: any[], notShown = 0) {
  const projected = project('worker-runs', { v: 1, slug: 'feat-a', store: 'present', runs, limits: { shown: runs.length, notShown } });
  assert.ok(projected.ok, 'the worker-runs projector accepts the fixture');
  return projected.body;
}

/** The older-core fallback body (`workerRuns` in console/src/routes.ts): active attempts' runs only, from `worker-status`. */
function fallback(runs: any[], notShown = 0) {
  return {
    v: 1, slug: 'feat-a', source: 'active-attempts', store: 'present',
    runs: runs.map((r) => ({ runId: r.runId, task: r.task, token: r.token, harness: r.harness, childOf: null, phase: null, endState: null, createdAt: null, startedAt: r.startedAt, endedAt: null, edit: null })),
    limits: { shown: runs.length, notShown, ended: 'not-checked' },
  };
}

const node = (model: any, key: string) => {
  const found = model.byKey.get(key);
  assert.ok(found, `node ${key}`);
  return found;
};
const keys = (n: any): string[] => n.children.map((c: any) => c.key);
/** Every node under `n`, `n` included. */
const walk = (n: any): any[] => [n, ...n.children.flatMap(walk)];

// ---- the Chain levels scenario ---------------------------------------------------------------------------

test('Chain levels: main, two stages and one gate from the rail, two tasks, three attempts, one run per attempt and one child', () => {
  const model = chain.deriveChain({ run: runBody(), workers: listed(SCENARIO_RUNS), nowMs: NOW });
  const { root } = model;
  assert.equal(root.key, 'main');
  assert.equal(root.kind, 'main');
  assert.deepEqual(keys(root), ['stage:plan', 'gate:gate-plan', 'stage:build', 'tasks']);
  assert.deepEqual(keys(node(model, 'tasks')), ['task:A.1', 'task:A.2']);
  assert.deepEqual(keys(node(model, 'task:A.1')), ['attempt:A.1/1']);
  assert.deepEqual(keys(node(model, 'task:A.2')), ['attempt:A.2/1', 'attempt:A.2/2']);
  assert.deepEqual(keys(node(model, 'attempt:A.1/1')), [`worker:${RUN_A11}`]);
  assert.deepEqual(keys(node(model, 'attempt:A.2/1')), [`worker:${RUN_A21}`]);
  assert.deepEqual(keys(node(model, 'attempt:A.2/2')), [`worker:${RUN_A22}`]);
  assert.deepEqual(keys(node(model, `worker:${RUN_A22}`)), [`worker:${RUN_CHILD}`], 'the child sits under the run that granted it (childOf)');
  assert.ok(!model.byKey.has('unlinked'), 'every run is tied to an attempt or a listed granter');
  assert.deepEqual(model.counts, { source: 'worker-runs', workers: 'read', runs: 4, notShown: 0, ended: 'listed', tasks: 2, attempts: 3, notChecked: 0, unlinked: 0 });
  assert.equal(chain.headSentence(model.counts), null);
  // Every node has a kind, a label, a chip and a marker; byKey holds each node once under its own key.
  const all = walk(root);
  assert.equal(all.length, model.byKey.size);
  for (const n of all) {
    assert.equal(model.byKey.get(n.key), n);
    assert.ok(['main', 'stage', 'gate', 'tasks', 'task', 'attempt', 'worker', 'unlinked'].includes(n.kind), n.key);
    assert.equal(typeof n.label, 'string');
    assert.equal(typeof n.chip.token, 'string');
    assert.equal(typeof n.chip.word, 'string');
    assert.ok([null, 'unlinked', 'not-checked'].includes(n.marker), n.key);
  }
});

test('node keys: kind plus its record key, as the Session hash names them', () => {
  const model = chain.deriveChain({ run: runBody(), workers: listed(SCENARIO_RUNS), nowMs: NOW });
  assert.deepEqual([...model.byKey.keys()].sort(), [
    'attempt:A.1/1', 'attempt:A.2/1', 'attempt:A.2/2', 'gate:gate-plan', 'main', 'stage:build', 'stage:plan', 'task:A.1', 'task:A.2', 'tasks',
    `worker:${RUN_A11}`, `worker:${RUN_A21}`, `worker:${RUN_A22}`, `worker:${RUN_CHILD}`,
  ].sort());
  assert.deepEqual([chain.keyOf.attempt('A.1', 2), chain.keyOf.worker(RUN_A11), chain.keyOf.stage('plan'), chain.keyOf.gate('g')], ['attempt:A.1/2', `worker:${RUN_A11}`, 'stage:plan', 'gate:g']);
});

test('an ended attempt shows its ended worker run, with the run\'s phase and end state in its chip', () => {
  const model = chain.deriveChain({ run: runBody(), workers: listed(SCENARIO_RUNS), nowMs: NOW });
  const finished = node(model, 'attempt:A.1/1');
  assert.equal(finished.ref.state, 'finished');
  assert.equal(finished.marker, null);
  const run = node(model, `worker:${RUN_A11}`);
  assert.deepEqual([run.ref.phase, run.ref.endState, run.chip], ['ended', 'exited', { token: 'done', word: 'Exited' }]);
  assert.deepEqual(node(model, `worker:${RUN_A21}`).chip, { token: 'failed', word: 'Cancelled' });
  assert.deepEqual(node(model, `worker:${RUN_A22}`).chip, { token: 'running', word: 'Running' });
});

// ---- unlinked: the main session and runs no record ties to the chain ---------------------------------------

test('unlinked: the main node marks its coding-tool session; an unmatched run and a child of an unlisted granter sit in the unlinked group with no edge', () => {
  const runs = [...SCENARIO_RUNS, wr(RUN_LOOSE, 'B.9', 1, 'running', null, 18), wr(RUN_ORPHAN, 'A.2', 2, 'running', null, 19, RUN_MISSING)];
  const model = chain.deriveChain({ run: runBody(), workers: listed(runs), nowMs: NOW });
  const { root } = model;
  assert.equal(root.marker, 'unlinked', 'no record names a session for an orchestration run');
  assert.deepEqual([root.label, root.ref.taskId, root.ref.taskClass, root.ref.workflowName, root.ref.startedAt], ['run-1', 'run-1', 'feature', 'Feature Flow', iso(0)]);
  assert.deepEqual(keys(root), ['stage:plan', 'gate:gate-plan', 'stage:build', 'tasks', 'unlinked']);
  const group = node(model, 'unlinked');
  assert.equal(group.kind, 'unlinked');
  assert.deepEqual(keys(group), [`worker:${RUN_LOOSE}`, `worker:${RUN_ORPHAN}`]);
  for (const runId of [RUN_LOOSE, RUN_ORPHAN]) assert.equal(node(model, `worker:${runId}`).marker, 'unlinked');
  // No guessed edge: the orphan names A.2 token 2, but its childOf names no listed run, so the attempt does not hold it.
  const tasksTree = walk(node(model, 'tasks')).map((n) => n.key);
  assert.ok(!tasksTree.includes(`worker:${RUN_ORPHAN}`));
  assert.ok(!tasksTree.includes(`worker:${RUN_LOOSE}`));
  assert.ok(!model.byKey.has('task:B.9'), 'a run never makes a task the plan does not list');
  assert.ok(!model.byKey.has(`worker:${RUN_MISSING}`), 'an unlisted granter is not drawn');
  assert.equal(model.counts.unlinked, 2);
  assert.equal(chain.markerWords('unlinked'), 'Not linked');
});

test('unlinked: a childOf cycle is drawn once, by its recorded edge, from the unlinked group', () => {
  const a = 'w-00000000aaaa';
  const b = 'w-00000000bbbb';
  const runs = [...SCENARIO_RUNS, wr(a, 'A.1', 1, 'ended', 'exited', 20, b), wr(b, 'A.1', 1, 'ended', 'exited', 21, a)];
  const model = chain.deriveChain({ run: runBody(), workers: listed(runs), nowMs: NOW });
  assert.deepEqual(keys(node(model, 'unlinked')), [`worker:${a}`]);
  assert.deepEqual(keys(node(model, `worker:${a}`)), [`worker:${b}`]);
  assert.deepEqual(keys(node(model, `worker:${b}`)), []);
});

test('no task list: with tasksReason the tasks node says why, and every run is unlinked', () => {
  const model = chain.deriveChain({ run: runBody({ tasks: null, tasksReason: 'legacy-plan' }), workers: listed(SCENARIO_RUNS.slice(0, 1)), nowMs: NOW });
  const group = node(model, 'tasks');
  assert.deepEqual([group.children, group.live, group.ref.reason], [[], null, 'legacy-plan']);
  assert.match(group.ref.sentence, /older format/);
  assert.deepEqual(keys(node(model, 'unlinked')), [`worker:${RUN_A11}`]);
  assert.equal(model.counts.tasks, null);
  const noPlan = chain.deriveChain({ run: runBody({ tasks: null, tasksReason: 'no-plan' }), workers: listed([]), nowMs: NOW });
  assert.match(node(noPlan, 'tasks').ref.sentence, /no task plan/);
});

// ---- not checked: never "no worker run" ------------------------------------------------------------------------

/** Every string the model and its head sentence can show. */
const shownText = (model: any) => JSON.stringify(walk(model.root).map((n) => [n.label, n.chip.word, chain.markerWords(n.marker), n.ref])) + String(chain.headSentence(model.counts));

test('not-checked under notShown: an attempt with no listed run is "worker runs not checked", and the head counts the runs not shown', () => {
  const runs = SCENARIO_RUNS.filter((r) => r.runId !== RUN_A21);
  const model = chain.deriveChain({ run: runBody(), workers: listed(runs, 2), nowMs: NOW });
  const attempt = node(model, 'attempt:A.2/1');
  assert.deepEqual([attempt.marker, attempt.children, attempt.live], ['not-checked', [], null]);
  assert.equal(chain.markerWords(attempt.marker), 'Worker runs not checked');
  for (const key of ['attempt:A.1/1', 'attempt:A.2/2']) assert.equal(node(model, key).marker, null, `${key} has its run listed`);
  assert.deepEqual([model.counts.notShown, model.counts.ended, model.counts.notChecked], [2, 'listed', 1]);
  assert.equal(chain.headSentence(model.counts), '2 older worker runs are not shown, so some attempts’ runs are not checked.');
  assert.doesNotMatch(shownText(model), /no worker run/i);
});

test('not-checked under the older-core fallback: ended attempts are not checked, the active one shows its run', () => {
  const model = chain.deriveChain({ run: runBody(), workers: fallback([SCENARIO_RUNS[2]]), nowMs: NOW });
  assert.equal(model.counts.source, 'active-attempts');
  assert.equal(model.counts.ended, 'not-checked');
  assert.deepEqual(['attempt:A.1/1', 'attempt:A.2/1', 'attempt:A.2/2'].map((key) => node(model, key).marker), ['not-checked', 'not-checked', null]);
  const run = node(model, `worker:${RUN_A22}`);
  assert.deepEqual([run.ref.phase, run.chip, node(model, 'attempt:A.2/2').live], [null, { token: 'unknown', word: 'Unknown' }, 1]);
  assert.equal(chain.headSentence(model.counts), 'This version of DoFlow lists only the worker runs of active attempts, so ended attempts’ runs are not checked.');
  const capped = chain.deriveChain({ run: runBody(), workers: fallback([], 1), nowMs: NOW });
  assert.equal(node(capped, 'attempt:A.2/2').marker, 'not-checked');
  assert.match(chain.headSentence(capped.counts), /1 active attempt was not checked\.$/);
  assert.doesNotMatch(shownText(model) + shownText(capped), /no worker run/i);
});

test('a full listing marks nothing: an attempt with no run in a complete list has no marker', () => {
  const model = chain.deriveChain({ run: runBody(), workers: listed(SCENARIO_RUNS.filter((r) => r.runId !== RUN_A21)), nowMs: NOW });
  assert.equal(node(model, 'attempt:A.2/1').marker, null);
  assert.equal(model.counts.notChecked, 0);
});

test('workers unreadable (a non-200 member): every attempt is not checked and stages and tasks still draw', () => {
  const model = chain.deriveChain({ run: runBody(), workers: null, nowMs: NOW });
  assert.deepEqual(keys(model.root), ['stage:plan', 'gate:gate-plan', 'stage:build', 'tasks']);
  assert.deepEqual(['attempt:A.1/1', 'attempt:A.2/1', 'attempt:A.2/2'].map((key) => node(model, key).marker), ['not-checked', 'not-checked', 'not-checked']);
  assert.deepEqual([model.counts.workers, model.counts.runs, model.counts.notShown], ['unavailable', 0, null]);
  assert.equal(chain.headSentence(model.counts), 'Worker runs could not be read, so they are not checked.');
  assert.doesNotMatch(shownText(model), /no worker run/i);
});

// ---- live counts per kind -------------------------------------------------------------------------------------------

test('live counts: the current stage, a RUNNING task, an active attempt, a worker run not ended; groups with a live child', () => {
  const runs = [...SCENARIO_RUNS, wr(RUN_LOOSE, 'B.9', 1, 'starting', null, 18)];
  const model = chain.deriveChain({ run: runBody(), workers: listed(runs), nowMs: NOW });
  assert.equal(node(model, 'stage:build').ref.state, 'running');
  // main: stage build (current), the tasks group (A.2 RUNNING), the unlinked group (a starting run); not plan or gate-plan (done).
  assert.equal(model.root.live, 3);
  assert.equal(node(model, 'tasks').live, 1, 'A.2 is RUNNING, A.1 SUCCEEDED');
  assert.equal(node(model, 'task:A.1').live, 0, 'its attempt is finished');
  assert.equal(node(model, 'task:A.2').live, 1, 'attempt 2 is active, attempt 1 superseded');
  assert.equal(node(model, 'attempt:A.1/1').live, 0, 'its run has ended');
  assert.equal(node(model, 'attempt:A.2/2').live, 1);
  assert.equal(node(model, `worker:${RUN_A22}`).live, 1, 'its child is running');
  assert.equal(node(model, 'unlinked').live, 1);
  assert.equal(node(model, `worker:${RUN_CHILD}`).live, null, 'a node with no children has no live count');
  assert.equal(node(model, 'stage:plan').live, null);
});

test('live counts: a gate that awaits is live; a cancelling run is live and an ended one is not', () => {
  const awaiting = { ...ROW, state: 'AWAITING_GATE', current: { type: 'gate', id: 'gate-plan', kind: 'approval' }, awaitingGate: { gateId: 'gate-plan' }, progress: { done: 1, total: 3 } };
  const timeline = { ...TIMELINE, events: TIMELINE.events.slice(0, 2) };
  const model = chain.deriveChain({ run: runBody({ run: awaiting, timeline }), workers: listed([wr(RUN_A11, 'A.1', 1, 'cancelling', null, 9), wr(RUN_A21, 'A.2', 1, 'ended', 'timed-out', 10)]), nowMs: NOW });
  assert.equal(node(model, 'gate:gate-plan').ref.state, 'awaiting');
  assert.deepEqual(node(model, 'gate:gate-plan').chip, { token: 'awaiting', word: 'Waiting for you' });
  assert.deepEqual(model.root.chip, { token: 'awaiting', word: 'Waiting for you' });
  assert.equal(model.root.live, 2, 'the gate and the tasks group; no stage is current');
  assert.equal(node(model, 'attempt:A.1/1').live, 1, 'cancelling has not ended');
  assert.equal(node(model, 'attempt:A.2/1').live, 0);
  assert.deepEqual(node(model, `worker:${RUN_A11}`).chip, { token: 'running', word: 'Cancelling' });
  assert.deepEqual(node(model, `worker:${RUN_A21}`).chip, { token: 'failed', word: 'Timed out' });
});

// ---- chips --------------------------------------------------------------------------------------------------------------

test('chips: stages and gates by the rail tone and word, tasks by taskStates, attempts by attemptStates, the main node by the run state', () => {
  const model = chain.deriveChain({ run: runBody(), workers: listed(SCENARIO_RUNS), nowMs: NOW });
  assert.deepEqual(node(model, 'stage:plan').chip, { token: 'done', word: 'Done, passed' });
  assert.deepEqual(node(model, 'gate:gate-plan').chip, { token: 'done', word: 'Approved' });
  assert.deepEqual(node(model, 'stage:build').chip, { token: 'running', word: 'Running' });
  assert.deepEqual(node(model, 'task:A.1').chip, { token: 'done', word: 'Done' });
  assert.deepEqual(node(model, 'task:A.2').chip, { token: 'running', word: 'Running' });
  assert.deepEqual(['attempt:A.1/1', 'attempt:A.2/1', 'attempt:A.2/2'].map((key) => node(model, key).chip.word), ['Finished', 'Superseded', 'Active']);
  assert.deepEqual(model.root.chip, { token: 'running', word: 'Running' });
  // A failed stage outcome takes the failed tone, as the rail draws it; a run silent over a day is stale.
  const failed = { ...TIMELINE, events: [ev(0, 'start', null), ev(5, 'complete-stage', 'plan', { outcome: 'failed' }), ev(8, 'decide-gate', 'gate-plan', { decision: 'approve' })] };
  const later = chain.deriveChain({ run: runBody({ timeline: failed }), workers: listed([]), nowMs: T0 + 2 * 24 * 60 * MIN });
  assert.equal(node(later, 'stage:plan').chip.token, 'failed');
  assert.deepEqual(later.root.chip, { token: 'stale', word: 'Stale' });
  assert.equal(node(later, 'stage:build').chip.token, 'stale');
  assert.equal(later.root.live, 2, 'a stale current stage is still the current node');
});

test('workerChip: the selected run\'s worker state wins; an unknown phase is unknown', () => {
  const run = wr(RUN_A11, 'A.1', 1, 'running', null, 9);
  assert.deepEqual(chain.workerChip(run, 'unknown'), { token: 'unknown', word: 'Process state not known' });
  assert.deepEqual(chain.workerChip(run, 'exited'), { token: 'done', word: 'Exited' });
  assert.deepEqual(chain.workerChip(run), { token: 'running', word: 'Running' });
  assert.deepEqual(chain.workerChip({ ...run, phase: 'ended', endState: null }), { token: 'unknown', word: 'Ended' });
  assert.deepEqual(chain.workerChip({ ...run, phase: 'odd' }), { token: 'unknown', word: 'Unknown' });
});

// ---- purity --------------------------------------------------------------------------------------------------------------

test('the model is pure: no fetch, no DOM, no timer, and it does not change its input', () => {
  assert.doesNotMatch(CHAIN_SOURCE, /\bfetch\s*\(|\bdocument\b|\bwindow\b|setTimeout|setInterval|XMLHttpRequest|EventSource/);
  const body = runBody();
  const workers = listed(SCENARIO_RUNS);
  const before = JSON.stringify([body, workers]);
  const first = chain.deriveChain({ run: body, workers, nowMs: NOW });
  assert.equal(JSON.stringify([body, workers]), before);
  const second = chain.deriveChain({ run: body, workers, nowMs: NOW });
  assert.deepEqual(JSON.stringify(first.root), JSON.stringify(second.root));
});
