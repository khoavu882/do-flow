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
  fs.writeFileSync(path.join(dir, 'derive', 'actions.js'), fs.readFileSync(path.join(path.dirname(SOURCE_PATH), 'actions.js'), 'utf8')); // the `by` words (162)
  fs.writeFileSync(path.join(dir, 'derive', 'start.js'), fs.readFileSync(path.join(path.dirname(SOURCE_PATH), 'start.js'), 'utf8')); // the started-session words (165)
  fs.writeFileSync(path.join(dir, 'derive', 'binding-text.js'), fs.readFileSync(path.join(path.dirname(SOURCE_PATH), 'binding-text.js'), 'utf8')); // start.js imports it (169)
  fs.writeFileSync(path.join(dir, 'derive', 'effort-text.js'), fs.readFileSync(path.join(path.dirname(SOURCE_PATH), 'effort-text.js'), 'utf8')); // start.js imports it (178)
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
    worktreeKey: WK, startedAt: null, contextCapturedAt: '2026-11-15T08:00:00.000Z', lastRecordAt: '2026-11-15T09:00:00.000Z', liveness: 'not-checked', ended: null,
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
      { harness: 'claude', main: { observed: true }, subagents: { observed: true }, transcript: { observed: true }, permissions: { observed: true }, questions: { observed: true } },
      { harness: 'opencode', main: { observed: true }, subagents: never, transcript: never, permissions: never, questions: { observed: false, reason: 'no-harness-record' } },
    ]),
  };
  return { v: 1, projectKey: PK, sections: { ...sections, ...over } };
}

test('a layers patch adding an awaiting gate moves it to the lead card; an opencode coverage row renders `not observed` with its reason, never `idle`', () => {
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
  const opencode = after.coverage.find((row: any) => row.harness === 'opencode');
  const cells = layers.COVERAGE_COLUMNS.map(([column]: [string]) => layers.coverageCell(column, opencode[column]));
  assert.deepEqual(cells[1], { observed: false, word: 'not observed', reason: 'no audit hook' });
  assert.deepEqual(cells[2], { observed: false, word: 'not observed', reason: 'no audit hook' });
  for (const cell of cells) assert.notEqual(cell.word, 'idle');
});

test('a gate decided by a direct command reads "decided manually", never "by a person"; autopilot and null keep their words', () => {
  assert.equal(layers.gateWords(gate({ by: 'manual' })).word, 'decided manually');
  assert.equal(layers.gateWords(gate({ by: 'autopilot' })).word, 'approved by autopilot');
  assert.equal(layers.gateWords(gate({ by: null })).word, 'decider not recorded');
  assert.equal(layers.gateWords(gate({ by: 'person' })).word, 'decider not recorded', 'the retired value is not a decider');
});

test('162 IC-005: a gate decided from the Console or a paired device reads where it came from; a rejected one says rejected', () => {
  assert.equal(layers.gateWords(gate({ by: 'console' })).word, 'approved from the Console on this machine');
  assert.equal(layers.gateWords(gate({ by: 'device.d-0a1b2c3d4e5f' })).word, 'approved from paired device d-0a1b2c3d4e5f');
  assert.deepEqual(layers.gateWords(gate({ by: 'console', state: 'rejected' })), { token: 'rejected', word: 'rejected from the Console on this machine' });
  assert.equal(layers.gateWords(gate({ by: 'device.d-XYZ' })).word, 'decider not recorded');
});

test('180 IC-180-D4 (c): the questions cell follows the core: observed for the harness that records asks, `not observed` with its reason for the others', () => {
  const model = layers.projectModel(layersBody());
  const cell = (harness: string) => layers.coverageCell('questions', model.coverage.find((row: any) => row.harness === harness).questions);
  assert.deepEqual(cell('claude'), { observed: true, word: 'observed', reason: null });
  assert.deepEqual(cell('opencode'), { observed: false, word: 'not observed', reason: 'no harness record' });
  assert.equal(layers.coverageCell('main', { observed: true }).word, 'observed');
});

const SK = 'cc11dd22ee33ff44';
const SK2 = 'cc11dd22ee33ff55';
const SK3 = 'cc11dd22ee33ff66';
/** A session row of the `sessions` section with its attention entry (IC-180-D3). */
function askSession(sessionKey: string, attention: any, harness = 'claude'): any {
  return { sessionKey, harness, audit: never, denials: never, attention };
}
const asking = (pending: any, over: any = {}) => ({ observed: true, pending, count: 1, recent: pending ? [pending] : [], ...over });

test('180 IC-180-D4 (a): a session with an open ask is in "Waiting for you" with its words, the tool and the time; a question and a wait for input have their own words', () => {
  const sessions = ok([
    askSession(SK, asking({ kind: 'permission', tool: 'Bash', at: '2026-11-15T09:20:00.000Z' })),
    askSession(SK2, asking({ kind: 'question', tool: '', at: '2026-11-15T09:30:00.000Z' })),
    askSession(SK3, asking({ kind: 'idle', tool: '', at: '2026-11-15T09:10:00.000Z' })),
  ]);
  const model = layers.projectModel(layersBody({ sessions }));
  assert.deepEqual(model.asks.map((a: any) => [a.sessionKey, a.harness, a.word, a.tool, a.at]), [
    [SK2, 'claude', 'asks you a question', '', '2026-11-15T09:30:00.000Z'],
    [SK, 'claude', 'asks permission for Bash', 'Bash', '2026-11-15T09:20:00.000Z'],
    [SK3, 'claude', 'waits for your input', '', '2026-11-15T09:10:00.000Z'],
  ], 'newest first');
  assert.equal(layers.askWords({ kind: 'permission', tool: '' }), 'asks permission', 'no tool recorded: no tool named');
  assert.equal(layers.askWords({ kind: 'other', tool: '' }), 'asks for your attention');
  // (d) the words never claim a state the record does not hold.
  for (const kind of ['permission', 'question', 'idle', 'other']) assert.doesNotMatch(layers.askWords({ kind, tool: 'Bash' }), /\b(active|online|idle)\b/i, kind);
  assert.deepEqual(model.asksUnobserved, [], 'every session here records its asks');
});

test('180 IC-180-D4 (b): an answered ask is not listed, and a session with no ask yet adds nothing', () => {
  const sessions = ok([
    askSession(SK, asking(null, { count: 2, recent: [{ kind: 'permission', tool: 'Bash', at: '2026-11-15T09:20:00.000Z' }, { kind: 'question', tool: '', at: '2026-11-15T09:00:00.000Z' }] })),
    askSession(SK2, { observed: true, pending: null, count: 0, recent: [] }),
  ]);
  const model = layers.projectModel(layersBody({ sessions }));
  assert.deepEqual(model.asks, []);
  assert.deepEqual(model.asksUnobserved, []);
});

test('180 IC-180-D4: a session whose harness records no asks is `not observed` with its reason, once per harness; an unreadable ask log is said so', () => {
  const sessions = ok([
    askSession(SK, { observed: false, reason: 'no-harness-record' }, 'codex'),
    askSession(SK2, { observed: false, reason: 'no-harness-record' }, 'codex'),
    askSession(SK3, null, 'opencode'),
    askSession('cc11dd22ee33ff77', { observed: false, reason: 'unreadable' }),
  ]);
  const model = layers.projectModel(layersBody({ sessions }));
  assert.deepEqual(model.asks, []);
  assert.deepEqual(model.asksUnobserved, [{ harness: 'codex', reason: 'no harness record' }, { harness: 'opencode', reason: 'not sent by this DoFlow core' }]);
  assert.deepEqual(model.unreadLogs, [{ harness: 'claude', log: 'attention' }]);
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
  assert.match(model.foot.notObserved, /a project's page lists the sessions that ask you something/, '180: a project page states the asks of the harnesses that record them');
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

test('161 review C: a review too large to read says "not read: too large"; an audit or denial log that could not be read is listed, never quiet', () => {
  const review = (over: any) => ({ worktreeKey: WK, feature: '161-live', counts: null, ...over });
  assert.deepEqual(layers.reviewWords(review({ state: 'unreadable', reason: 'too-large' })), { token: 'unknown', words: ['review not read: too large'] });
  assert.deepEqual(layers.reviewWords(review({ state: 'unreadable' })), { token: 'unknown', words: ['review unreadable'] });
  const model = layers.projectModel(layersBody({ reviews: ok([review({ state: 'unreadable', reason: 'too-large' })]) }));
  assert.deepEqual(model.lanes.find((l: any) => l.worktreeKey === WK).runs[0].review.words, ['review not read: too large']);
  const sessions = ok([
    { sessionKey: 'cc11dd22ee33ff44', harness: 'claude', audit: { observed: false, reason: 'unreadable' }, denials: { observed: false, reason: 'no-harness-record' } },
    { sessionKey: 'cc11dd22ee33ff55', harness: 'codex', audit: never, denials: { observed: false, reason: 'unreadable' } },
  ]);
  assert.deepEqual(layers.projectModel(layersBody({ sessions })).unreadLogs, [{ harness: 'claude', log: 'audit' }, { harness: 'codex', log: 'denials' }]);
  assert.deepEqual(layers.projectModel(layersBody()).unreadLogs, []);
});

// ---- 165: the started-session node ------------------------------------------------------------------------------------------------

const STARTED_KEY = 'ee11ff22aa33bb44';
function started(over: any = {}): any {
  return node({
    agentKey: STARTED_KEY, kind: 'started-session', harness: 'claude', model: null, modelBasis: null, contextCapturedAt: null, startedAt: '2026-11-16T08:00:00.000Z',
    lastRecordAt: '2026-11-16T08:00:00.000Z', runId: 'w-0123456789ab', startedBy: 'console', phase: 'running', end: null, liveness: 'process-seen',
    fileKeys: { out: '1111111111111111', err: '2222222222222222' }, observed: { state: 'not-observed', reason: 'not-yet-observed' },
    transcript: { reader: null, linked: false, reason: 'no-reader' }, ...over,
  });
}
const withStarted = (extra: any = {}, nodes: any[] = [started(extra)]) => layers.projectModel(layersBody({
  tree: ok({ v: 1, projectKey: PK, nodes: [node(), ...nodes], edges: [], limits: { nodes: 2, notChecked: 0 }, unreadable: 0 }),
}));

test('165: a started session is ONE node in the orchestrator lane, titled "started session", with its starter and its two file lanes', () => {
  const model = withStarted();
  const lane = model.lanes.find((l: any) => l.worktreeKey === WK);
  assert.equal(lane.orchestrator.length, 2, 'the main session and the started session, no second node');
  assert.equal(lane.workers.length, 0, 'never a worker row');
  const row = lane.orchestrator.find((r: any) => r.kind === 'started-session');
  assert.match(row.title, /started session/i);
  assert.equal(row.startedBy, 'started from the Console');
  assert.deepEqual(row.fileKeys, { out: '1111111111111111', err: '2222222222222222' });
  assert.equal(row.phase, 'process seen');
  assert.equal(model.nodes.get(STARTED_KEY).kind, 'started-session');
});

test('165: a not-observed started session says "session not observed" with its reason words; an observed one says when it was seen', () => {
  const row = (extra: any) => withStarted(extra).lanes[0].orchestrator.find((r: any) => r.kind === 'started-session');
  assert.equal(row({}).observed, 'session not observed: not seen yet');
  assert.equal(row({ observed: { state: 'not-observed', reason: 'no-session-hook' } }).observed, 'session not observed: this harness has no session hook');
  assert.match(row({ observed: { state: 'observed', sessionKey: 'cc11dd22ee33ff44', model: 'claude-opus-5-5', lastSeenAt: '2026-11-16T08:05:00.000Z' } }).observed, /^session observed/);
  assert.equal(row({ startedBy: 'device.d-0123456789ab' }).startedBy, 'started from paired device d-0123456789ab');
  assert.equal(row({ startedBy: null }).startedBy, 'starter not recorded');
});

test('165 F2: a started session words how it ended from its own end, and the join through the machine list is gone', () => {
  const row = (extra: any) => withStarted(extra).lanes[0].orchestrator.find((r: any) => r.kind === 'started-session');
  assert.equal(row({}).end, null);
  assert.equal(row({ phase: 'ended', end: { state: 'exited', exitCode: 3, reason: null } }).end, 'The session exited with code 3. Its error output is below.');
  assert.equal(row({ phase: 'ended', end: { state: 'exited', exitCode: null, reason: 'prompt-unwritable' } }).end, 'The session did not start: its prompt could not be written. Nothing ran.');
  assert.equal(row({ runId: 'w-0123456789ab' }).runId, 'w-0123456789ab');
  assert.equal('startedRunId' in layers, false);
});

// ---- 170 design §10: a started session's control channel ----

const RUN = 'w-0123456789ab';
const CONTROL = { allowed: true, reason: null };
const working = { observed: true, state: 'working', since: '2026-11-17T09:00:00.000Z', seq: 3 };
const waiting = { ...working, state: 'waiting' };
const unseen = (reason: string) => ({ observed: false, reason, since: null });
const chan = (over: any = {}) => ({
  runId: RUN, agentKey: 'f1e2d3c4b5a69788', harness: 'pi', channel: 'open', reason: null, words: null, turn: working, sent: { count: 2, lastAt: '2026-11-17T09:01:00.000Z' },
  recent: [{ seq: 3, kind: 'follow-up', by: 'console', at: '2026-11-17T09:01:00.000Z', bytes: 41, outcome: 'written', answer: 'accepted' }], ...over,
});
const found = (item: any) => ({ state: 'ok', code: null, item });
const view = (item: any, over: any = {}) => layers.sessionModel({ channels: found(item), phase: 'running', send: CONTROL, end: true, ...over });
const flags = (m: any) => [m.send.enabled, m.steer.enabled, m.stopTurn.enabled, m.end];

test('170 §10 open, working: badge "Working", Send, Steer, Stop turn and End session are all enabled', () => {
  const m = view(chan());
  assert.deepEqual([m.show, m.badge.word, m.badge.token, m.controls], [true, 'Working', 'running', true]);
  assert.deepEqual(flags(m), [true, true, true, true]);
});

test('170 §10 open, waiting: "Waiting for you"; Send and End session on, Steer off with "it is waiting: send instead", Stop turn off', () => {
  const m = view(chan({ turn: waiting }));
  assert.deepEqual([m.badge.word, m.badge.token], ['Waiting for you', 'awaiting']);
  assert.deepEqual(flags(m), [true, false, false, true]);
  assert.equal(m.steer.why, 'it is waiting: send instead');
  assert.match(m.stopTurn.why, /^it is waiting/);
});

test('170 §10 open, not observed: "Not observed: <reason words>" and Send, Steer, Stop turn, End session all enabled', () => {
  for (const [reason, words] of [['no-event-yet', 'no turn event seen yet'], ['message-refused', 'its last message was refused'], ['opening', 'its channel is opening'], ['odd-new-reason', 'odd new reason']]) {
    const m = view(chan({ turn: unseen(reason) }));
    assert.equal(m.badge.word, `Not observed: ${words}`, reason);
    assert.deepEqual(flags(m), [true, true, true, true], reason);
  }
});

test('170 §10 supervisor gone: "Not observed: its supervisor stopped. End it with End session.", Send disabled (so are Steer and Stop turn: all three go through it), End session on', () => {
  const m = view(chan({ turn: unseen('supervisor-gone') }));
  assert.equal(m.badge.word, 'Not observed: its supervisor stopped. End it with End session.');
  assert.deepEqual(flags(m), [false, false, false, true]);
  assert.equal(m.send.why, 'its supervisor stopped');
  assert.equal(m.controls, true, 'the box is drawn, disabled');
  assert.equal(view(chan({ turn: unseen('supervisor-gone') }), { end: false }).badge.word, 'Not observed: its supervisor stopped.', 'no End session to point to');
});

test('170 review A-08: every reason the supervisor closes a channel for has a sentence of its own, and none says a state word', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'runtime', 'worker', 'supervisor.ts'), 'utf8');
  // The reasons the supervisor writes: a direct `close('x')`, a `closedReason: 'x'`, and the branches of the two close calls that choose one.
  const written = new Set<string>();
  for (const found of source.matchAll(/\bclose\('([a-z-]+)'\)|closedReason: '([a-z-]+)'/g)) written.add(found[1] ?? found[2]);
  for (const reason of ['first-refused', 'write-failed', 'timeout', 'cancelled', 'harness-exited']) {
    assert.ok(source.includes(`'${reason}'`), `${reason} is still a reason the supervisor writes`);
    written.add(reason);
  }
  assert.ok(written.size >= 7, `the scan found the reasons: ${[...written].join(', ')}`);
  for (const reason of written) {
    const words = layers.CLOSED_WORDS[reason];
    assert.equal(typeof words, 'string', `${reason} has a page sentence`);
    assert.doesNotMatch(words, /\b(active|online|idle)\b/i, `${reason}: no state word`);
    assert.equal(view(chan({ channel: 'closed', reason, turn: unseen('channel-closed') })).badge.word, `Ended: ${words}`, reason);
  }
});

test('170 §10 closed or ended: "Ended: <closedReason words>", no Send, Steer or Stop turn; a closed channel of a session still running keeps End session', () => {
  const closed = view(chan({ channel: 'closed', reason: 'harness-exited', turn: unseen('channel-closed') }));
  assert.equal(closed.badge.word, 'Ended: the harness exited');
  assert.deepEqual([closed.controls, ...flags(closed)], [false, false, false, false, true]);
  assert.equal(view(chan({ channel: 'closed', reason: 'unused-timeout', turn: unseen('channel-closed') })).badge.word, 'Ended: it sat unused for 30 minutes and its channel was closed');
  assert.equal(view(chan({ channel: 'closed', reason: null, turn: unseen('channel-closed') })).badge.word, 'Ended: the session ended');
  const ended = view(chan({ channel: 'closed', reason: 'cancelled', turn: unseen('run-ended') }), { phase: 'ended' });
  assert.deepEqual([ended.badge.word, ended.badge.token, ended.controls, ...flags(ended)], ['Ended: it was stopped', 'done', false, false, false, false, false]);
  assert.equal(view(chan({ turn: unseen('run-ended') })).badge.word, 'Ended: the session ended', 'a run that ended whose record still says open');
  assert.equal(view(chan({ channel: 'closed', reason: 'supervisor-gone', turn: unseen('run-ended') })).badge.word, 'Ended: its supervisor stopped', 'an ended run whose supervisor died with the channel open');
});

test('170 §10 no channel: "Send is unavailable: <reason>" with the descriptor\'s sentence, End session only', () => {
  const none = view(chan({ channel: 'none', reason: 'no-channel', words: 'no recorded capture shows an input mode for claude.', turn: unseen('no-channel'), sent: { count: 0, lastAt: null }, recent: [] }));
  assert.equal(none.note, 'Send is unavailable: no recorded capture shows an input mode for claude');
  assert.deepEqual([none.badge, none.controls, ...flags(none)], [null, false, false, false, false, true]);
  assert.equal(view(chan({ channel: 'none', reason: 'started-without-channel', turn: unseen('started-without-channel') })).note, 'Send is unavailable: it was started without a control channel');
  assert.equal(view(chan({ channel: 'none', reason: 'no-channel', words: null, turn: unseen('no-channel') })).note, 'Send is unavailable: this harness has no control channel recorded');
});

test('170 §10 view device: the badge and the reply only, with the sentence; no box, no End session; a device whose core lacks the action says that instead', () => {
  const m = view(chan(), { send: { allowed: false, reason: 'phone-scope' }, end: false });
  assert.equal(m.badge.word, 'Working');
  assert.equal(m.note, 'Sending needs this machine’s Console or a phone paired with control over the app.');
  assert.deepEqual([m.controls, ...flags(m)], [false, false, false, false, false]);
  assert.equal(view(chan(), { send: { allowed: false, reason: 'action-transport' } }).note, layers.VIEW_DEVICE_WORDS);
  assert.match(view(chan(), { send: { allowed: false, reason: 'core-lacks-action' } }).note, /cannot take this action/);
  assert.equal(view(chan(), { send: { allowed: false, reason: null } }).note, null, 'before the page has heard what the device may do');
  assert.equal(view(chan(), { send: { allowed: false, reason: 'core-lacks-action' }, end: true }).end, true, 'End session is its own action');
});

test('170 §10: nothing is claimed without a channels section; an unreadable one and a run it does not list say so; a session being ended offers no message', () => {
  const absent = layers.sessionModel({ channels: { state: 'absent', code: null, item: null }, phase: 'running', send: CONTROL, end: true });
  assert.deepEqual([absent.show, absent.badge, absent.controls, absent.end], [false, null, false, true], 'End session is its own action: it stays');
  assert.equal(layers.sessionModel({ channels: { state: 'unreadable', code: 'section-missing', item: null }, phase: 'running', send: CONTROL, end: true }).show, false, 'an older core');
  const unreadable = layers.sessionModel({ channels: { state: 'unreadable', code: 'core-error', item: null }, phase: 'running', send: CONTROL, end: true });
  assert.deepEqual([unreadable.show, unreadable.badge.word, unreadable.controls, unreadable.end], [true, 'Not observed: the channel state could not be read', false, true]);
  assert.match(view(null).badge.word, /^Not observed: the Console holds no channel record/);
  const closing = view(chan(), { phase: 'cancelling' });
  assert.deepEqual([closing.badge.word, ...flags(closing)], ['Working', false, false, false, false]);
  assert.equal(closing.send.why, 'it is being ended');
});

test('170 §10 recent messages: kind, who, when, bytes and accepted or refused; no text, and the field set is closed', () => {
  const m = view(chan({ recent: [
    { seq: 4, kind: 'steer', by: 'device.d-0a1b2c3d4e5f', at: '2026-11-17T09:02:00.000Z', bytes: 12, outcome: 'refused', answer: null },
    { seq: 3, kind: 'follow-up', by: 'console', at: '2026-11-17T09:01:00.000Z', bytes: 41, outcome: 'written', answer: 'accepted' },
    { seq: 2, kind: 'stop', by: 'manual', at: '2026-11-17T09:00:30.000Z', bytes: 0, outcome: 'written', answer: 'refused' },
    { seq: 1, kind: 'first', by: 'console', at: '2026-11-17T09:00:00.000Z', bytes: 90, outcome: 'failed', answer: null },
  ] }));
  assert.deepEqual(m.recent.map((r: any) => [r.kind, r.who, r.bytes, r.result]), [
    ['Steer', 'paired device d-0a1b2c3d4e5f', '12 B', 'refused'], ['Send', 'Console', '41 B', 'accepted'], ['Stop turn', 'terminal', '0 B', 'refused'], ['First text', 'Console', '90 B', 'failed']]);
  assert.deepEqual(Object.keys(m.recent[0]).sort(), ['at', 'bytes', 'kind', 'result', 'seq', 'who']);
});

test('170: the channels section reaches the project model by run id, and `channelIn` reads one run from a member body', () => {
  const body = layersBody({ channels: ok({ v: 1, items: [chan(), chan({ runId: 'w-aaaaaaaaaaaa' })] }) });
  const model = layers.projectModel(body);
  assert.deepEqual(model.sections.channels, { state: 'ok', code: null });
  assert.deepEqual([...model.channels.items.keys()], [RUN, 'w-aaaaaaaaaaaa']);
  assert.equal(layers.channelIn(body, RUN).item.runId, RUN);
  assert.deepEqual(layers.channelIn(body, 'w-bbbbbbbbbbbb'), { state: 'ok', code: null, item: null });
  assert.deepEqual(layers.channelIn(layersBody({ channels: bad('section-missing') }), RUN), { state: 'unreadable', code: 'section-missing', item: null });
  assert.deepEqual(layers.channelIn(null, RUN), { state: 'absent', code: null, item: null });
  assert.equal(layers.projectModel(layersBody()).channels.state, 'absent');
  assert.equal(layers.projectModel(layersBody()).withheld.some((w: any) => w.section === 'channels'), false, 'an older core\'s missing section is not a page-wide warning');
});

test('170: the message box state counts code points and refuses empty, NUL and over-limit text in words', () => {
  assert.deepEqual([layers.messageState('check the tests').ok, layers.messageState('check the tests').codePoints], [true, 15]);
  assert.equal(layers.messageState('  \n').ok, false);
  assert.equal(layers.messageState('').issue, null, 'empty says nothing: the button is off, no scolding');
  assert.match(layers.messageState('a\u0000b').issue, /NUL/);
  assert.match(layers.messageState('x'.repeat(8001)).issue, /longer than 8000/);
  assert.equal(layers.messageState('x'.repeat(8000)).ok, true);
});

test('173 O-3: a subagent worker\'s handoff prompt is a row of "Briefs and hand-backs" beside its hand-back and result, as "worker prompt"', () => {
  const artifact = (kind: string, fileKey: string, at: string) => ({ fileKey, kind, worktreeKey: WK, feature: null, dispatchId: 'd-0123456789ab', bytes: 2, at });
  const model = layers.projectModel(layersBody({ artifacts: ok([
    artifact('handoff', '1111111111111111', '2026-11-15T09:00:00.000Z'),
    artifact('handoff-prompt', '2222222222222222', '2026-11-15T09:00:01.000Z'),
    artifact('result', '3333333333333333', '2026-11-15T09:05:00.000Z'),
  ]) }));
  const lane = model.lanes.find((l: any) => l.worktreeKey === WK);
  assert.deepEqual(lane.briefs.map((f: any) => [f.kind, f.kindWord]), [['result', 'result'], ['handoff-prompt', 'worker prompt'], ['handoff', 'hand-back']]);
  assert.equal(model.files.get('2222222222222222').kind, 'handoff-prompt', 'the inspector finds it by its fileKey, like any artifact');
});
