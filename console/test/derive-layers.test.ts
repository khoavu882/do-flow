'use strict';

// The Layers view's derivations (feature 161, design §8; FR-009, FR-010, AC-5). Pure functions over the members of the browser
// channels `machine` and `layers:<pk>`: no DOM, no fetch, no clock. First test: a layers patch that adds an awaiting gate moves it
// to the lead card, and a harness source the core did not observe reads `not observed` with its reason, never `idle`.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const SOURCE_PATH = path.join(WEB_ROOT, 'derive', 'layers.js');

let scratch: string[] = [];
let layers: any;

/** A copy of derive/layers.js as an ES module a CommonJS package can import. */
async function load(): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-layers-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, 'derive'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'derive', 'layers.js'), fs.readFileSync(SOURCE_PATH, 'utf8'));
  return import(pathToFileURL(path.join(dir, 'derive', 'layers.js')).href);
}

before(async () => { layers = await load(); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

const PK = 'a1b2c3d4e5f60718';
const WK = 'b1b2c3d4e5f60718';
const WK2 = 'b2b2c3d4e5f60718';
const ok = (data: any) => ({ ok: true, data });
const bad = (code: string) => ({ ok: false, code });

function node(over: any = {}): any {
  return {
    agentKey: 'aa11bb22cc33dd44', kind: 'main-session', harness: 'claude', model: 'claude-opus-5-5', modelBasis: 'hook-observation', label: null, depth: 0,
    worktreeKey: WK, startedAt: '2026-11-15T08:00:00.000Z', lastRecordAt: '2026-11-15T09:00:00.000Z', liveness: 'not-checked', ended: null,
    transcript: { reader: 'claude-jsonl', linked: true, reason: null }, ...over,
  };
}

function run(over: any = {}): any {
  return {
    taskId: 'T-1', taskClass: 'feature', workflowName: 'feature', state: 'running', current: { type: 'stage', id: 'implement', kind: null }, awaitingGate: null,
    progress: { done: 1, total: 4 }, revision: 3, featureSlug: '161-live', startedAt: '2026-11-15T08:00:00.000Z', updatedAt: '2026-11-15T09:00:00.000Z', origin: 'chain',
    runKey: `${WK}/run-1/main`, skill: 'do-execute-plan', ...over,
  };
}

function gate(over: any = {}): any {
  return { runKey: `${WK}/run-1/main`, slug: '161-live', taskId: 'T-1', gateId: 'g-design', name: 'Design approval', state: 'approved', at: '2026-11-15T08:30:00.000Z', by: 'autopilot', ...over };
}

const never = { observed: false, reason: 'no-audit-hook' };
function layersBody(over: any = {}): any {
  const sections: any = {
    checkouts: ok([{ worktreeKey: WK, label: 'do-flow', branch: 'feat/161', main: true }, { worktreeKey: WK2, label: 'do-flow-fu21', branch: null, main: false }]),
    tree: ok({ v: 1, projectKey: PK, nodes: [node(), node({ agentKey: 'aa11bb22cc33dd55', kind: 'harness-subagent', label: 'core-implementer', depth: 1 })], edges: [], limits: { nodes: 2, notChecked: 0 }, unreadable: 0 }),
    runs: ok({ v: 1, runs: [run()], limits: {} }),
    gates: ok([gate()]),
    artifacts: ok([]),
    reviews: ok([]),
    sessions: ok([]),
    traffic: ok({ v: 1, projectKey: PK, windowMin: 10, agents: [], models: [], pairs: [], notChecked: 0 }),
    coverage: ok([
      { harness: 'claude', main: { observed: true }, subagents: { observed: true }, transcript: { observed: true }, permissions: { observed: true }, questions: { observed: false, reason: 'no-harness-record' } },
      { harness: 'gemini', main: { observed: true }, subagents: never, transcript: never, permissions: never, questions: { observed: true } },
    ]),
  };
  return { v: 1, projectKey: PK, sections: { ...sections, ...over } };
}

test('a layers patch adding an awaiting gate moves it to the lead card; a gemini coverage row renders `not observed` with its reason, never `idle`', () => {
  const before = layers.projectModel(layersBody());
  assert.deepEqual(before.waiting, [], 'no awaiting gate: nothing waits for the user');
  const patched = layersBody({ gates: ok([gate(), gate({ gateId: 'g-plan', name: 'Plan approval', state: 'awaiting', at: '2026-11-15T09:10:00.000Z', by: null })]) });
  const after = layers.projectModel(patched);
  assert.equal(after.waiting.length, 1);
  assert.equal(after.waiting[0].gateId, 'g-plan');
  assert.equal(after.waiting[0].word, 'waiting for you');
  assert.equal(after.waiting[0].taskId, 'T-1');
  // The decided gate stays on the run row; the awaiting one is on the lead card only.
  const lane = after.lanes.find((l: any) => l.worktreeKey === WK);
  assert.deepEqual(lane.runs[0].gates.map((g: any) => g.gateId), ['g-design']);
  const gemini = after.coverage.find((row: any) => row.harness === 'gemini');
  const cells = layers.COVERAGE_COLUMNS.map(([column]: [string]) => layers.coverageCell(column, gemini[column]));
  assert.deepEqual(cells[1], { observed: false, word: 'not observed', reason: 'no audit hook' });
  assert.deepEqual(cells[2], { observed: false, word: 'not observed', reason: 'no audit hook' });
  for (const cell of cells) assert.notEqual(cell.word, 'idle');
});

test('questions is `not observed` for every harness, whatever the core said (FR-009)', () => {
  assert.deepEqual(layers.coverageCell('questions', { observed: true }), { observed: false, word: 'not observed', reason: 'no harness record' });
  assert.equal(layers.coverageCell('main', { observed: true }).word, 'observed');
});

test('a section that failed is `unreadable`, an absent body is absent, and neither becomes an empty list that reads as nothing happening', () => {
  const model = layers.projectModel(layersBody({ gates: bad('core-error'), tree: bad('core-contract-mismatch') }));
  assert.deepEqual(model.sections.gates, { state: 'unreadable', code: 'core-error' });
  assert.deepEqual(model.sections.tree, { state: 'unreadable', code: 'core-contract-mismatch' });
  assert.deepEqual(model.sections.runs.state, 'ok');
  assert.deepEqual(model.withheld.map((w: any) => w.section), ['tree', 'gates']);
  const empty = layers.projectModel(null);
  assert.equal(empty.present, false);
  assert.equal(empty.sections.gates.state, 'absent');
});

test('a run joins a checkout by the first segment of its exact run key; a null key is never guessed into a lane (D5)', () => {
  const model = layers.projectModel(layersBody({
    runs: ok({ v: 1, runs: [run(), run({ taskId: 'T-2', runKey: null }), run({ taskId: 'T-3', runKey: `${WK2}/run-9/main` })], limits: {} }),
  }));
  const main = model.lanes.find((l: any) => l.worktreeKey === WK);
  const other = model.lanes.find((l: any) => l.worktreeKey === WK2);
  assert.deepEqual(main.runs.map((r: any) => r.taskId), ['T-1']);
  assert.deepEqual(other.runs.map((r: any) => r.taskId), ['T-3']);
  assert.deepEqual(model.loose.runs.map((r: any) => r.taskId), ['T-2']);
  assert.equal(model.lanes[0].main, true, 'the main checkout comes first');
});

test('an agent row says recorded, started or stopped, process seen; never live, active or idle', () => {
  const sessions = ok([{ sessionKey: 'cc11dd22ee33ff44', harness: 'claude', audit: { observed: true, open: 1, started: 1, stopped: 0, recent: [{ at: '2026-11-15T09:05:00.000Z', event: 'SubagentStart', agentType: 'core-implementer', agentKey: 'aa11bb22cc33dd55' }] }, denials: never }]);
  const model = layers.projectModel(layersBody({ sessions }));
  const lane = model.lanes.find((l: any) => l.worktreeKey === WK);
  assert.equal(lane.subagents[0].audit.word, 'started');
  assert.equal(lane.subagents[0].process, 'process not checked');
  const text = JSON.stringify(model.lanes);
  for (const word of ['idle', '"live"', 'active', 'online']) assert.equal(text.includes(word), false, word);
});

test('the machine page leads with waiting gates (newest first), lists the current project first and never invents a strip for an unsummarized project', () => {
  const body = {
    v: 1,
    sections: {
      projects: ok({ v: 1, store: 'present', excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, truncated: false, projects: [
        { projectKey: 'c1c2c3c4c5c6c7c8', label: 'other', current: false, temp: false, checkouts: 1, sources: [], lastRecordAt: '2026-11-15T09:00:00.000Z' },
        { projectKey: PK, label: 'do-flow', current: true, temp: false, checkouts: 2, sources: [], lastRecordAt: '2026-11-14T09:00:00.000Z' },
        { projectKey: 'd1d2d3d4d5d6d7d8', label: 'quiet', current: false, temp: false, checkouts: 1, sources: [], lastRecordAt: null },
      ] }),
      activity: ok({ v: 1, limits: { projects: 3, notShown: 1, watched: 2, fingerprintOnly: 0 }, items: [
        { projectKey: PK, runs: { open: 1, awaiting: 1 }, gates: [{ slug: 's', taskId: 'T-1', gateId: 'g-a', name: 'Older', recordAt: '2026-11-15T07:00:00.000Z' }], workers: { open: 0 }, sessions: { observed: 2, harnesses: ['claude'] }, unreadable: ['worker-runs'] },
        { projectKey: 'c1c2c3c4c5c6c7c8', runs: { open: 1, awaiting: 1 }, gates: [{ slug: 's', taskId: 'T-9', gateId: 'g-b', name: null, recordAt: '2026-11-15T09:30:00.000Z' }], workers: { open: 0 }, sessions: { observed: 0, harnesses: [] }, unreadable: [] },
      ] }),
    },
  };
  const model = layers.machineModel(body);
  assert.deepEqual(model.gates.map((g: any) => g.gateId), ['g-b', 'g-a']);
  assert.equal(model.gates[0].projectLabel, 'other');
  assert.deepEqual(model.rows.map((r: any) => r.label), ['do-flow', 'other', 'quiet']);
  assert.equal(model.rows[2].summarized, false);
  assert.deepEqual(model.rows[0].unreadable, ['worker-runs']);
  assert.equal(layers.summarizedLine(model.foot), '2 of 3 projects summarized');
  assert.match(model.foot.notObserved, /^Not observed: agent questions/);
});

test('the stream states: connecting, following, stream down, refused, unsupported, core-lacks-channel', () => {
  const s = (transport: any, errors: any[] = [], hasData = false) => layers.streamState({ transport, errors, hasData }).token;
  assert.equal(s({ state: 'connecting', code: null }), 'connecting');
  assert.equal(s({ state: 'open', code: null }, [null], true), 'following');
  assert.equal(s({ state: 'retrying', code: null }, [], true), 'down');
  assert.equal(s({ state: 'closed', code: 'silent' }, [], true), 'down');
  assert.equal(s({ state: 'open', code: null }, ['events-down'], true), 'down');
  assert.equal(s({ state: 'refused', code: 'stream-limit' }), 'refused');
  assert.equal(s({ state: 'unsupported', code: 'no-eventsource' }), 'unsupported');
  assert.equal(s({ state: 'open', code: null }, ['core-lacks-channel']), 'core-lacks-channel');
  assert.match(layers.streamCopy({ token: 'refused', code: 'stream-limit' }).sentence, /as many streams/);
  assert.equal(layers.streamCopy({ token: 'following', code: null }), null);
});

test('transcript helpers: the event list is bounded at 500 and the redactor markers split into words', () => {
  const batch = Array.from({ length: 510 }, (_, i) => ({ kind: 'reply', at: null, text: `t${i}`, args: null }));
  const result = layers.appendEvents([], batch);
  assert.equal(result.events.length, 500);
  assert.equal(result.dropped, 10);
  assert.deepEqual(layers.splitMasked('a <masked> b'), [{ text: 'a ' }, { mask: 'masked' }, { text: ' b' }]);
});
