'use strict';

// Projection and core handshake (feature 093, IC-004 and 092 IC-013; FR-002, NFR-003). The fixtures
// under fixtures/core/ are real core outputs (list, status, attempts from the 092 probe, workflow,
// capabilities) or, where the core verb has not landed yet (timeline IC-012, attempts[] IC-013),
// bodies built to the spec. Each carries the marker below in fields the projection drops. The IC-018
// bodies (observed, slots, worker-status, roadmap) are below as SAMPLES, shaped as the E.5 core prints
// them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { project, PROJECTOR_IDS, WITHHELD, OTHER_HARNESS, CLOSED_SETS } = require('../src/project.ts');
const { checkCoreVersion, handshake, satisfiesRange } = require('../src/handshake.ts');
const { SHAPE_IDS } = require('../src/verb-runner.ts');
const coreSemver = require('../../src/helper/semver.ts');

const MARKER = 'ZZ-MARKER-7f3';
const FIXTURES = path.join(__dirname, 'fixtures', 'core');
const CORE_SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const MISMATCH = { ok: false, code: 'core-contract-mismatch' };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const KEY_MAIN = '0cc00ec6d2062bc0';
const KEY_LINKED = '7654c73dc501aafe';
const AGENT_A = 'a1b2c3d4e5f60718';
const AGENT_B = '0f1e2d3c4b5a6978';

/** IC-018 core outputs, as `primary --action observed`, `slot --action peek`, `worker --action status` and `roadmap --action status` print them. */
const SAMPLES: Record<string, any> = {
  observed: {
    v: 1, store: 'present',
    checkouts: [
      { worktreeKey: KEY_MAIN, role: 'main', current: true, branch: 'feat/093-console-web-ui', head: 'febd2cc99487', headCommittedAt: '2026-10-26T09:45:48.000Z' },
      { worktreeKey: KEY_LINKED, role: 'linked', current: false, branch: `wip/${MARKER} <b>`, head: null, headCommittedAt: null },
    ],
    sessions: [
      { sessionKey: 'a1b2c3d4e5f60718', worktreeKey: KEY_MAIN, kind: 'hook', harness: 'claude', model: 'claude-opus-5-5', modelFirstSeenAt: '2026-10-26T09:00:00.000Z',
        startedAt: '2026-10-26T08:59:00.000Z', branchAtStart: 'feat/093-console-web-ui', lastHookRecordAt: '2026-10-26T09:40:00.000Z', launched: null,
        cwd: `/tmp/${MARKER}` },
      { sessionKey: '0f1e2d3c4b5a6978', worktreeKey: KEY_LINKED, kind: 'launched', harness: 'my-fork', model: `gpt ${MARKER} <x>`, modelFirstSeenAt: null,
        startedAt: '2026-10-26T09:10:00.000Z', branchAtStart: null, lastHookRecordAt: null, launched: { run: 'run-1', lineage: 'lin-1', attempt: '2' } },
    ],
    truncated: false, unreadable: 1,
  },
  slots: {
    v: 1,
    slots: [
      { name: 'build', holder: { label: `npm test ${MARKER} <&>`, since: '2026-10-26T09:00:00.000Z', alive: false, worktreeKey: KEY_MAIN, pid: 4242, cwd: `/tmp/${MARKER}` }, waiters: 2 },
      { name: 'deploy', holder: null, waiters: 1 },
      { name: 'gpu', holder: { label: 'train run', since: '2026-10-26T09:05:00.000Z', alive: 'unknown', worktreeKey: null }, waiters: 0 },
    ],
    unreadable: 1,
  },
  'worker-status': {
    disposition: 'status', runId: 'w-0123456789ab', task: 'A.2', token: 2, harness: 'codex', identity: { runKey: `${KEY_MAIN}/${MARKER}/main` },
    state: 'running', reason: null, supervisorLost: false, overdue: true, cancel: { by: MARKER },
    startedAt: '2026-10-26T09:00:00.000Z', endedAt: null, deadline: '2026-10-26T10:00:00.000Z',
    process: { pid: 4242, command: `codex exec ${MARKER}` }, report: { file: `/tmp/${MARKER}/report.md`, text: MARKER }, readOnly: false,
    edit: { worktree: `/tmp/${MARKER}` }, isolation: { root: `/tmp/${MARKER}` }, childOf: null, request: null,
    verified: null, attemptActive: true, resultOffered: false, withheld: { reason: MARKER },
    cleanup: { kept: [`/tmp/${MARKER}`] }, supervisorCleanup: null, attemptCancel: null, output: { tail: MARKER }, launchObserved: null,
  },
  roadmap: {
    schema: 1, action: 'status',
    rowStatus: { '093': `in-progress ${MARKER}` },
    rows: [{ rowId: '093', status: 'in-progress', title: MARKER, evidence: null }],
    openIntents: [{ row: '093', phase: 'merge', status: MARKER }],
    run: 'rl-20261026-ab12',
    holds: [{ row: '093', state: 'held', kind: 'gate', reason: `needs ${MARKER}` }, { row: '107-B', state: 'paused', kind: null, reason: MARKER }],
    lease: { pid: 4242, host: `host-${MARKER}`, runId: 'rl-20261026-ab12', acquiredAt: '2026-10-26T08:00:00.000Z' },
  },
  // IC-019..IC-023: the V8 Fleet reads, as the V.3/V.5/V.6 core prints them, with the fields the projectors drop carrying the marker.
  projects: {
    v: 1, store: 'present',
    projects: [
      { projectKey: KEY_MAIN, root: `/work/${MARKER}/main`, label: 'main', current: true, checkouts: 2, sources: ['upkeep-roots', 'hook-dirs'], lastRecordAt: '2026-10-26T09:45:48.000Z' },
      { projectKey: KEY_LINKED, root: `/work/${MARKER}/other`, label: `odd ${MARKER} <b>`, current: false, checkouts: 1, sources: ['hook-dirs'], lastRecordAt: null },
    ],
    excluded: { missing: 1, temp: 2, notDoflow: 3, unreadable: 0 }, truncated: false,
  },
  tree: {
    v: 1, projectKey: KEY_MAIN,
    nodes: [
      { agentKey: AGENT_A, kind: 'main-session', harness: 'claude', model: 'claude-opus-5-5', modelBasis: 'hook-observation', label: null, depth: 0, worktreeKey: KEY_MAIN,
        startedAt: '2026-10-26T08:59:00.000Z', lastRecordAt: '2026-10-26T09:40:00.000Z', liveness: 'not-checked', ended: null,
        transcript: { reader: 'claude-jsonl', linked: true, reason: null }, sessionId: `s-${MARKER}`, file: `/home/${MARKER}/t.jsonl` },
      { agentKey: AGENT_B, kind: 'worker-run', harness: 'my-fork', model: `m ${MARKER} <x>`, modelBasis: 'worker-binding', label: 'core-implementer', depth: 1, worktreeKey: KEY_LINKED,
        startedAt: null, lastRecordAt: null, liveness: 'process-gone', ended: { at: '2026-10-26T09:50:00.000Z', result: 'exited' },
        transcript: { reader: null, linked: false, reason: 'no-reader' }, pid: 4242 },
    ],
    edges: [{ from: AGENT_A, to: AGENT_B, basis: 'worker-caller', evidence: MARKER }],
    limits: { nodes: 256, notChecked: 0 }, unreadable: 1,
  },
  transcript: {
    v: 1, agentKey: AGENT_A, harness: 'claude', reader: { id: 'claude-jsonl', status: 'supported' }, transcript: { linked: true, reason: null },
    events: [
      { seq: 0, at: '2026-10-26T09:00:00.000Z', kind: 'reply', agentKey: AGENT_A, model: 'claude-opus-5-5', tool: null, text: 'Done: wrote the file.', args: null, cut: false, tokens: null, record: null, thinking: MARKER },
      { seq: 1, at: '2026-10-26T09:00:01.000Z', kind: 'tool-call', agentKey: AGENT_A, model: null, tool: { name: 'Bash', callKey: KEY_MAIN, status: null, bytes: null, durationMs: null },
        text: null, args: '{"command":"ls"}', cut: false, tokens: null, record: null },
      { seq: 2, at: null, kind: 'tool-result', agentKey: AGENT_A, model: null, tool: { name: 'Bash', callKey: KEY_MAIN, status: 'ok', bytes: 120, durationMs: 35 },
        text: null, args: null, cut: false, tokens: null, record: null, output: MARKER },
      { seq: 3, at: '2026-10-26T09:00:02.000Z', kind: 'usage', agentKey: AGENT_A, model: null, tool: null, text: null, args: null, cut: false,
        tokens: { input: 10, output: 20, cacheRead: null, cacheWrite: 5, reasoning: null }, record: null },
      { seq: 4, at: '2026-10-26T09:00:03.000Z', kind: 'record', agentKey: AGENT_A, model: null, tool: null, text: null, args: null, cut: false, tokens: null,
        record: { type: 'attempt-claim', task: 'A.2', result: 'COMPLETED' } },
    ],
    cursor: '12345:6789:5:1790000000000', reset: false, eof: true, otherRecords: 2, unparsable: 0, masked: 1, warnings: ['format-unrecognized'], path: `/home/${MARKER}/t.jsonl`,
  },
  traffic: {
    v: 1, projectKey: KEY_MAIN, windowMin: 10,
    agents: [
      { agentKey: AGENT_A, harness: 'claude', model: 'claude-opus-5-5', eventsPerMin: 1.5, toolCalls: 4, toolErrors: 1, toolDurationMs: { p50: 20, max: 90, n: 3 },
        tokens: { input: 10, output: 20, cacheRead: null, cacheWrite: 5, reasoning: null }, lastRecordAt: '2026-10-26T09:40:00.000Z', session: MARKER },
      { agentKey: AGENT_B, harness: null, model: null, eventsPerMin: null, toolCalls: null, toolErrors: null, toolDurationMs: null, tokens: null, lastRecordAt: null },
    ],
    models: [{ model: 'claude-opus-5-5', agents: 1, eventsPerMin: 1.5, toolCalls: 4, tokens: { input: 10, output: 20, cacheRead: null, cacheWrite: 5, reasoning: null } }],
    pairs: [
      { a: AGENT_A, b: AGENT_B, basis: 'same-task', task: 'A.2', tasks: null },
      { a: AGENT_A, b: AGENT_B, basis: 'overlap', task: null, tasks: ['A.1', 'A.2'] },
      { a: AGENT_A, b: AGENT_B, basis: 'same-model', task: null, tasks: null, why: MARKER },
    ],
    notChecked: 0, root: `/work/${MARKER}`,
  },
};

/** The SAMPLES body, else the fixture file. */
const fixture = (name: string): any =>
  (Object.hasOwn(SAMPLES, name) ? clone(SAMPLES[name]) : JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')));
const workflowBody = () => project('workflow', fixture('workflow')).body;

/** Every key path of a value, arrays collapsed to `[]`, sorted: the field set a body exposes. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => keyPaths(item, `${prefix}[]`)))].sort();
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : [];
  const paths = Object.entries(value).flatMap(([key, inner]) => [`${prefix}.${key}`, ...keyPaths(inner, `${prefix}.${key}`)]);
  return [...new Set(paths)].sort();
}

const ROW = ['.taskId', '.taskClass', '.workflowName', '.state', '.current', '.current.type', '.current.id', '.current.kind',
  '.awaitingGate', '.awaitingGate.gateId', '.progress', '.progress.done', '.progress.total', '.revision'];
const FIELD_SETS: Record<string, string[]> = {
  list: ['.v', '.runs', '.unreadableCount',
    ...[...ROW, '.featureSlug', '.startedAt', '.updatedAt', '.origin'].map((p) => `.runs[]${p}`)],
  status: [...ROW, '.journalGateDiffers'],
  timeline: ['.v', '.taskId', '.featureSlug', '.revision', '.startedAt', '.events', '.otherEvents',
    ...['at', 'action', 'node', 'outcome', 'decision', 'forced', 'synthetic'].map((k) => `.events[].${k}`)],
  attempts: ['.revision', '.graph', '.graph.digest', '.graph.graphPlan', '.graph.tasks',
    ...['id', 'phase', 'owner', 'taskDeps', 'taskDeps[]', 'parallel'].map((k) => `.graph.tasks[].${k}`),
    '.tasks', ...['id', 'state', 'reason', 'budget', 'budget.used', 'budget.limit', 'attempts'].map((k) => `.tasks[].${k}`),
    ...['token', 'owner', 'mode', 'state', 'startedAt', 'endedAt', 'result', 'worktreeKey', 'run', 'lineage'].map((k) => `.tasks[].attempts[].${k}`),
    '.graph.overlaps', ...['a', 'b', 'fileCount'].map((k) => `.graph.overlaps[].${k}`)],
  workflow: ['.taskClass', '.name', '.stages',
    ...['id', 'skill', 'agent', 'kind', 'optional', 'purpose', 'gatesAfter'].map((k) => `.stages[].${k}`),
    ...['id', 'name', 'kind', 'trigger', 'prompt'].map((k) => `.stages[].gatesAfter[].${k}`)],
  capabilities: ['.capabilities', ...['capability', 'status', 'providerId'].map((k) => `.capabilities[].${k}`)],
  // IC-018 a-d.
  observed: ['.v', '.store', '.checkouts', '.sessions', '.truncated', '.unreadable',
    ...['worktreeKey', 'role', 'current', 'branch', 'head', 'headCommittedAt'].map((k) => `.checkouts[].${k}`),
    ...['sessionKey', 'worktreeKey', 'kind', 'harness', 'model', 'modelFirstSeenAt', 'startedAt', 'branchAtStart', 'lastHookRecordAt', 'launched',
      'launched.run', 'launched.lineage', 'launched.attempt'].map((k) => `.sessions[].${k}`)],
  slots: ['.v', '.slots', '.unreadable', ...['name', 'holder', 'waiters', 'holder.label', 'holder.since', 'holder.alive', 'holder.worktreeKey'].map((k) => `.slots[].${k}`)],
  'worker-status': ['runId', 'task', 'token', 'harness', 'state', 'reason', 'startedAt', 'endedAt', 'overdue', 'supervisorLost', 'attemptActive'].map((k) => `.${k}`),
  roadmap: ['.run', '.lease', '.lease.runId', '.lease.acquiredAt', '.holds', ...['row', 'state', 'kind'].map((k) => `.holds[].${k}`)],
  // IC-019..IC-023, with `root` dropped from projects (IC-024).
  projects: ['.v', '.store', '.projects', '.truncated', '.excluded', ...['missing', 'temp', 'notDoflow', 'unreadable'].map((k) => `.excluded.${k}`),
    ...['projectKey', 'label', 'current', 'checkouts', 'sources', 'sources[]', 'lastRecordAt'].map((k) => `.projects[].${k}`)],
  tree: ['.v', '.projectKey', '.nodes', '.edges', '.limits', '.limits.nodes', '.limits.notChecked', '.unreadable',
    ...['agentKey', 'kind', 'harness', 'model', 'modelBasis', 'label', 'depth', 'worktreeKey', 'startedAt', 'lastRecordAt', 'liveness', 'ended', 'ended.at', 'ended.result',
      'transcript', 'transcript.reader', 'transcript.linked', 'transcript.reason'].map((k) => `.nodes[].${k}`),
    ...['from', 'to', 'basis'].map((k) => `.edges[].${k}`)],
  transcript: ['.v', '.agentKey', '.harness', '.reader', '.reader.id', '.reader.status', '.transcript', '.transcript.linked', '.transcript.reason', '.events', '.cursor', '.reset', '.eof',
    '.otherRecords', '.unparsable', '.masked', '.warnings', '.warnings[]',
    ...['seq', 'at', 'kind', 'agentKey', 'model', 'tool', 'text', 'args', 'cut', 'tokens', 'record', 'tool.name', 'tool.callKey', 'tool.status', 'tool.bytes', 'tool.durationMs',
      'tokens.input', 'tokens.output', 'tokens.cacheRead', 'tokens.cacheWrite', 'tokens.reasoning', 'record.type', 'record.task', 'record.result'].map((k) => `.events[].${k}`)],
  traffic: ['.v', '.projectKey', '.windowMin', '.agents', '.models', '.pairs', '.notChecked',
    ...['agentKey', 'harness', 'model', 'eventsPerMin', 'toolCalls', 'toolErrors', 'toolDurationMs', 'toolDurationMs.p50', 'toolDurationMs.max', 'toolDurationMs.n', 'tokens', 'tokens.input',
      'tokens.output', 'tokens.cacheRead', 'tokens.cacheWrite', 'tokens.reasoning', 'lastRecordAt'].map((k) => `.agents[].${k}`),
    ...['model', 'agents', 'eventsPerMin', 'toolCalls', 'tokens', 'tokens.input', 'tokens.output', 'tokens.cacheRead', 'tokens.cacheWrite', 'tokens.reasoning'].map((k) => `.models[].${k}`),
    ...['a', 'b', 'basis', 'task', 'tasks', 'tasks[]'].map((k) => `.pairs[].${k}`)],
};

const contextFor = (shape: string) => (shape === 'status' ? { workflow: workflowBody() } : undefined);
const MARKED_SHAPES = ['list', 'status', 'timeline', 'attempts', 'workflow', 'capabilities', 'observed', 'slots', 'worker-status', 'roadmap', 'projects', 'tree', 'transcript', 'traffic'];

/** The shapes whose projected fixture still holds the marker, for a given projector. */
function leaks(projector: (shape: string, raw: unknown, context?: unknown) => any): string[] {
  return MARKED_SHAPES.filter((shape) => JSON.stringify(projector(shape, fixture(shape), contextFor(shape))).includes(MARKER));
}

test('one projector per allow-listed shape, and nothing else', () => {
  assert.deepEqual([...PROJECTOR_IDS].sort(), [...SHAPE_IDS].sort());
  assert.throws(() => project('indicators', {}), /no projector/);
});

for (const shape of MARKED_SHAPES) {
  test(`${shape}: the fixture projects to exactly the IC-004 field set`, () => {
    const result = project(shape, fixture(shape), contextFor(shape));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(keyPaths(result.body), [...FIELD_SETS[shape]].sort());
  });
}

test('the planted markers are in every place the plan names, and none reaches a projection', () => {
  const where: Array<[string, (f: any) => unknown]> = [
    ['timeline', (f) => f.events[1].note], // journal note
    ['status', (f) => f.awaitingGate.prompt], // awaitingGate.prompt
    ['attempts', (f) => f.graph.tasks[0].owner], // 200-character plan owner
    ['attempts', (f) => f.graph.tasks[0].files],
    ['attempts', (f) => f.graph.warnings],
    ['list', (f) => f.unreadable[2].reason], // unreadable reason
    ['attempts', (f) => f.tasks[0].attempts[0].reason], // IC-013 reason text
    ['attempts', (f) => f.graph.overlaps[0].files], // IC-018 d: overlap file names
    ['observed', (f) => f.checkouts[1].branch], // a branch over the label rule
    ['observed', (f) => f.sessions[0].cwd], // a git-context cwd
    ['slots', (f) => f.slots[0].holder.label], // a slot label over the label rule
    ['slots', (f) => f.slots[0].holder.cwd],
    ['worker-status', (f) => f.report],
    ['worker-status', (f) => f.process],
    ['worker-status', (f) => [f.identity, f.output, f.edit, f.isolation, f.cleanup, f.cancel, f.withheld]],
    ['roadmap', (f) => [f.lease.host, f.holds[0].reason, f.rows, f.rowStatus, f.openIntents]],
    ['projects', (f) => f.projects.map((p: any) => p.root)], // the project roots (IC-024: dropped before any body leaves)
    ['projects', (f) => f.projects[1].label], // a label over the rule
    ['tree', (f) => [f.nodes[0].sessionId, f.nodes[0].file, f.nodes[1].pid, f.edges[0].evidence]],
    ['tree', (f) => f.nodes[1].model], // a model over the label rule
    ['transcript', (f) => [f.path, f.events[0].thinking, f.events[2].output]],
    ['traffic', (f) => [f.root, f.agents[0].session, f.pairs[2].why]],
  ];
  for (const [shape, pick] of where) assert.ok(JSON.stringify(pick(fixture(shape))).includes(MARKER), `${shape} fixture lacks the marker`);
  assert.equal(fixture('attempts').graph.tasks[0].owner.length, 200);
  assert.deepEqual(leaks(project), []);
});

test('control: a pass-through projector leaks the marker of every fixture', () => {
  const passThrough = (_shape: string, raw: unknown) => ({ ok: true, body: raw });
  assert.deepEqual(leaks(passThrough), MARKED_SHAPES);
});

test('control: a pass-through worker-status projector alone turns the worker-status marker case red', () => {
  const onlyWorker = (shape: string, raw: unknown, context?: unknown) => (shape === 'worker-status' ? { ok: true, body: raw } : project(shape, raw, context));
  assert.deepEqual(leaks(onlyWorker), ['worker-status']);
});

test('list: values copied, awaitingGate name dropped, unreadable as a count', () => {
  const { body } = project('list', fixture('list'));
  assert.equal(body.unreadableCount, 3);
  assert.deepEqual(body.runs[0], {
    taskId: '060-write-set-completeness', featureSlug: '060-write-set-completeness', taskClass: 'feature',
    workflowName: 'Feature Delivery', state: 'RUNNING', current: { type: 'stage', id: 'design', kind: 'design' },
    awaitingGate: null, progress: { done: 2, total: 9 }, revision: 3,
    startedAt: '2026-10-09T16:02:05.111Z', updatedAt: '2026-10-09T16:02:11.778Z', origin: 'current',
  });
  assert.equal(body.runs[1].featureSlug, null);
  assert.deepEqual(body.runs[2].awaitingGate, { gateId: 'gate-0' });
  const nulls = clone(fixture('list'));
  nulls.runs[0].startedAt = null;
  nulls.runs[0].updatedAt = null;
  assert.equal(project('list', nulls).body.runs[0].updatedAt, null);
});

test('labels: at most 64 characters of the label set, else the fixed text', () => {
  const attempts = project('attempts', fixture('attempts')).body;
  assert.equal(attempts.graph.tasks[0].owner, WITHHELD);
  assert.equal(attempts.graph.tasks[1].owner, 'core-implementer');
  const owners = (owner: string) => {
    const raw = clone(fixture('attempts'));
    raw.graph.tasks[1].owner = owner;
    raw.tasks[0].attempts[0].owner = owner;
    const body = project('attempts', raw).body;
    return [body.graph.tasks[1].owner, body.tasks[0].attempts[0].owner];
  };
  const sixtyFour = 'a'.repeat(60) + ' :/@';
  assert.deepEqual(owners(sixtyFour), [sixtyFour, sixtyFour]);
  assert.deepEqual(owners('a'.repeat(65)), [WITHHELD, WITHHELD]);
  assert.deepEqual(owners('owner\nnext'), [WITHHELD, WITHHELD]);
  assert.deepEqual(owners('<b>x</b>'), [WITHHELD, WITHHELD]);
  assert.deepEqual(owners(''), [WITHHELD, WITHHELD]);
  const nullOwner = clone(fixture('attempts'));
  nullOwner.graph.tasks[1].owner = null;
  assert.equal(project('attempts', nullOwner).body.graph.tasks[1].owner, null);
  const list = clone(fixture('list'));
  list.runs[0].workflowName = 'Feature "Delivery" & more';
  assert.equal(project('list', list).body.runs[0].workflowName, WITHHELD);
});

test('status: journalGateDiffers compares the journal gate with the registry, and no text leaves', () => {
  const workflow = workflowBody();
  const registryGate = workflow.stages[0].gatesAfter[0];
  const status = (mutate: (raw: any) => void, wf: unknown = workflow) => {
    const raw = clone(fixture('status'));
    mutate(raw);
    return project('status', raw, { workflow: wf });
  };
  const planted = status(() => {});
  assert.equal(planted.body.journalGateDiffers, true);
  assert.deepEqual(planted.body.awaitingGate, { gateId: 'gate-0' });
  const same = status((raw) => { raw.awaitingGate.prompt = registryGate.prompt; });
  assert.equal(same.body.journalGateDiffers, false);
  assert.equal(status((raw) => { raw.awaitingGate.prompt = registryGate.prompt; raw.awaitingGate.name = 'Renamed'; }).body.journalGateDiffers, true);
  assert.equal(status((raw) => { raw.awaitingGate.prompt = registryGate.prompt; raw.awaitingGate.gateId = 'gate-z'; }).body.journalGateDiffers, true);
  assert.equal(status((raw) => { raw.awaitingGate.prompt = registryGate.prompt; raw.taskClass = 'bug'; }).body.journalGateDiffers, true);
  assert.equal(status((raw) => { raw.awaitingGate.prompt = registryGate.prompt; }, null).body.journalGateDiffers, true);
  const running = status((raw) => { raw.state = 'RUNNING'; raw.awaitingGate = null; });
  assert.equal(running.body.journalGateDiffers, false);
  assert.equal(running.body.awaitingGate, null);
  assert.deepEqual(status((raw) => { raw.awaitingGate.prompt = 7; }), MISMATCH);
  assert.deepEqual(status((raw) => { delete raw.awaitingGate.name; }), MISMATCH);
  assert.ok(!JSON.stringify(same).includes(registryGate.prompt));
});

test('timeline: events keep the IC-012 fields only', () => {
  const { body } = project('timeline', fixture('timeline'));
  assert.deepEqual(body.events[2], { at: '2026-10-26T04:00:00.000Z', action: 'decide-gate', node: 'gate-0', outcome: null, decision: 'approve', forced: true, synthetic: false });
  assert.equal(body.events[3].at, null);
  assert.equal(body.otherEvents, 1);
});

test('attempts: IC-013 attempts copied, files and the rest dropped', () => {
  const { body } = project('attempts', fixture('attempts'));
  assert.deepEqual(body.tasks[1].attempts[1], { token: 2, owner: 'worker-b', mode: 'manual', state: 'finished', startedAt: '2026-10-26T01:20:00.000Z', endedAt: '2026-10-26T02:00:00.000Z', result: 'COMPLETED',
    worktreeKey: KEY_MAIN, run: 'local', lineage: 'main' });
  // IC-018 c: an older record without a runKey keeps the three fields as null.
  assert.deepEqual([body.tasks[1].attempts[0].worktreeKey, body.tasks[1].attempts[0].run, body.tasks[1].attempts[0].lineage], [null, null, null]);
  // IC-018 d: an overlap is its two task ids and a file count.
  assert.deepEqual(body.graph.overlaps, [{ a: 'A.1', b: 'A.2', fileCount: 2 }]);
  assert.deepEqual(body.tasks[3], { id: 'B.1', state: 'PLANNED', reason: 'unmet-dependency', budget: { used: 0, limit: 20 }, attempts: [] });
  assert.deepEqual(body.graph.tasks[3].taskDeps, ['A.1', 'A.2']);
  assert.match(body.graph.digest, /^sha256:[0-9a-f]{64}$/);
});

test('workflow and capabilities: registry texts kept, the rest dropped', () => {
  const workflow = workflowBody();
  assert.equal(workflow.name, 'Feature Delivery');
  assert.equal(workflow.stages[0].purpose, fixture('workflow').stages[0].purpose);
  assert.equal(workflow.stages[0].gatesAfter[0].prompt, fixture('workflow').stages[0].gatesAfter[0].prompt);
  const capabilities = project('capabilities', fixture('capabilities')).body.capabilities;
  assert.deepEqual(capabilities[0], { capability: 'code.exact-search', status: 'HEALTHY', providerId: 'native.rg' });
  assert.equal(capabilities.at(-1).providerId, null);
});

test('observed: checkouts and sessions copied; a branch or model over the label rule withheld; an unknown harness (other)', () => {
  const { body } = project('observed', fixture('observed'));
  assert.deepEqual(body.checkouts[0], SAMPLES.observed.checkouts[0]);
  assert.equal(body.checkouts[1].branch, WITHHELD);
  const { cwd: _cwd, ...hook } = SAMPLES.observed.sessions[0];
  assert.deepEqual(body.sessions[0], hook);
  assert.equal(body.sessions[1].harness, OTHER_HARNESS);
  assert.equal(body.sessions[1].model, WITHHELD);
  assert.deepEqual(body.sessions[1].launched, { run: 'run-1', lineage: 'lin-1', attempt: '2' });
  const absent = { v: 1, store: 'absent', checkouts: [], sessions: [], truncated: false, unreadable: 0 };
  assert.deepEqual(project('observed', absent), { ok: true, body: absent });
});

test('slots: holders and waiter counts; a label over the rule withheld; pid and cwd dropped', () => {
  const { body } = project('slots', fixture('slots'));
  assert.deepEqual(body.slots[0], { name: 'build', holder: { label: WITHHELD, since: '2026-10-26T09:00:00.000Z', alive: false, worktreeKey: KEY_MAIN }, waiters: 2 });
  assert.deepEqual(body.slots[1], { name: 'deploy', holder: null, waiters: 1 });
  assert.deepEqual(body.slots[2].holder, { label: 'train run', since: '2026-10-26T09:05:00.000Z', alive: 'unknown', worktreeKey: null });
  assert.equal(body.unreadable, 1);
});

test('worker-status: exactly the IC-018 d set; an unknown harness is (other); no worker run is null', () => {
  const { body } = project('worker-status', fixture('worker-status'));
  assert.deepEqual(body, {
    runId: 'w-0123456789ab', task: 'A.2', token: 2, harness: 'codex', state: 'running', reason: null,
    startedAt: '2026-10-26T09:00:00.000Z', endedAt: null, overdue: true, supervisorLost: false, attemptActive: true,
  });
  const ended = { ...fixture('worker-status'), harness: 'some-new-harness', state: 'exited', endedAt: '2026-10-26T09:30:00.000Z', attemptActive: false };
  delete ended.overdue;
  delete ended.supervisorLost;
  const endedBody = project('worker-status', ended).body;
  assert.equal(endedBody.harness, OTHER_HARNESS);
  assert.deepEqual([endedBody.state, endedBody.overdue, endedBody.supervisorLost], ['exited', null, null]);
  assert.equal(project('worker-status', { ...fixture('worker-status'), harness: null }).body.harness, null);
  const lost = { ...fixture('worker-status'), state: 'unknown', reason: 'process-lost' };
  assert.equal(project('worker-status', lost).body.reason, 'process-lost');
  assert.deepEqual(project('worker-status', { disposition: 'status', run: null, task: 'A.2', token: 2 }), { ok: true, body: null });
});

test('roadmap: run, lease run id and time, holds; pid, host and reason dropped', () => {
  const { body } = project('roadmap', fixture('roadmap'));
  assert.deepEqual(body, {
    run: 'rl-20261026-ab12',
    lease: { runId: 'rl-20261026-ab12', acquiredAt: '2026-10-26T08:00:00.000Z' },
    holds: [{ row: '093', state: 'held', kind: 'gate' }, { row: '107-B', state: 'paused', kind: null }],
  });
  assert.deepEqual(project('roadmap', { ...fixture('roadmap'), run: null, lease: null, holds: [] }).body, { run: null, lease: null, holds: [] });
});

test('version: a semver string, else mismatch', () => {
  assert.deepEqual(project('version', '2.0.0-beta.7'), { ok: true, body: '2.0.0-beta.7' });
  for (const bad of ['v2.0.0', '2.0', '2.0.0-beta.07', '', ' 2.0.0', `2.0.0 ${MARKER}`, 2, null, { version: '2.0.0' }]) {
    assert.deepEqual(project('version', bad), MISMATCH, String(bad));
  }
});

/** A required field missing or of the wrong type: the whole body is refused, never a partial one. */
const MUTATIONS: Record<string, Array<[string, (raw: any) => void]>> = {
  list: [
    ['body not an object', (r) => { r.runs = 'x'; }],
    ['v is not 1', (r) => { r.v = 2; }],
    ['runs missing', (r) => { delete r.runs; }],
    ['unreadable not an array', (r) => { r.unreadable = 3; }],
    ['taskId with a slash', (r) => { r.runs[0].taskId = '../x'; }],
    ['taskId leading dash', (r) => { r.runs[0].taskId = '-x'; }],
    ['state outside RUN_STATES', (r) => { r.runs[0].state = 'COMPLETE'; }],
    ['current.type unknown', (r) => { r.runs[0].current.type = 'step'; }],
    ['current.id missing', (r) => { delete r.runs[0].current.id; }],
    ['progress.done negative', (r) => { r.runs[0].progress.done = -1; }],
    ['progress.total a string', (r) => { r.runs[0].progress.total = '9'; }],
    ['revision fractional', (r) => { r.runs[0].revision = 1.5; }],
    ['updatedAt not ISO', (r) => { r.runs[0].updatedAt = 'yesterday'; }],
    ['startedAt invalid date', (r) => { r.runs[0].startedAt = '2026-13-45T99:00:00.000Z'; }],
    ['startedAt missing', (r) => { delete r.runs[0].startedAt; }],
    ['origin unknown', (r) => { r.runs[0].origin = 'remote'; }],
    ['awaitingGate.gateId missing', (r) => { r.runs[2].awaitingGate = { name: 'x' }; }],
    ['workflowName a number', (r) => { r.runs[0].workflowName = 1; }],
    ['featureSlug missing', (r) => { delete r.runs[0].featureSlug; }],
  ],
  status: [
    ['taskClass missing', (r) => { delete r.taskClass; }],
    ['progress missing', (r) => { delete r.progress; }],
    ['awaitingGate a string', (r) => { r.awaitingGate = 'gate-0'; }],
  ],
  timeline: [
    ['v missing', (r) => { delete r.v; }],
    ['events not an array', (r) => { r.events = {}; }],
    ['action unknown', (r) => { r.events[0].action = 'handoff'; }],
    ['outcome unknown', (r) => { r.events[1].outcome = 'ok'; }],
    ['decision unknown', (r) => { r.events[2].decision = 'maybe'; }],
    ['forced missing', (r) => { delete r.events[0].forced; }],
    ['synthetic a string', (r) => { r.events[0].synthetic = 'false'; }],
    ['node not an id', (r) => { r.events[1].node = 'two words'; }],
    ['at not ISO', (r) => { r.events[0].at = '26/10/2026'; }],
    ['otherEvents missing', (r) => { delete r.otherEvents; }],
  ],
  attempts: [
    ['graph missing', (r) => { delete r.graph; }],
    ['digest not sha256', (r) => { r.graph.digest = 'md5:abc'; }],
    ['graphPlan a string', (r) => { r.graph.graphPlan = 'true'; }],
    ['taskDeps an id string', (r) => { r.graph.tasks[3].taskDeps = 'A.1'; }],
    ['owner a number', (r) => { r.graph.tasks[1].owner = 5; }],
    ['task state unknown', (r) => { r.tasks[0].state = 'DONE'; }],
    ['task reason unknown', (r) => { r.tasks[0].reason = `because ${MARKER}`; }],
    ['budget.limit missing', (r) => { delete r.tasks[0].budget.limit; }],
    ['attempts missing (pre-IC-013 core)', (r) => { delete r.tasks[2].attempts; }],
    ['attempt state unknown', (r) => { r.tasks[0].attempts[0].state = 'done'; }],
    ['attempt mode unknown', (r) => { r.tasks[0].attempts[0].mode = 'auto'; }],
    ['attempt result unknown', (r) => { r.tasks[1].attempts[1].result = 'OK'; }],
    ['attempt token a string', (r) => { r.tasks[0].attempts[0].token = '1'; }],
    ['attempt endedAt missing', (r) => { delete r.tasks[0].attempts[0].endedAt; }],
    ['attempt worktreeKey missing (pre-IC-018 core)', (r) => { delete r.tasks[0].attempts[0].worktreeKey; }],
    ['attempt worktreeKey not 16 hex', (r) => { r.tasks[1].attempts[0].worktreeKey = `/tmp/${MARKER}`; }],
    ['attempt run not an id', (r) => { r.tasks[1].attempts[1].run = 'a/b'; }],
    ['overlaps missing (pre-IC-018 core)', (r) => { delete r.graph.overlaps; }],
    ['overlap in the old shape', (r) => { r.graph.overlaps = [{ files: ['x'], tasks: ['A.1', 'A.2'] }]; }],
    ['overlap files not strings', (r) => { r.graph.overlaps[0].files = [1]; }],
  ],
  observed: [
    ['v is not 1', (r) => { r.v = 2; }],
    ['store unknown', (r) => { r.store = 'maybe'; }],
    ['checkouts missing', (r) => { delete r.checkouts; }],
    ['worktreeKey a path', (r) => { r.checkouts[0].worktreeKey = `/tmp/${MARKER}`; }],
    ['role unknown', (r) => { r.checkouts[0].role = 'bare'; }],
    ['current missing', (r) => { delete r.checkouts[0].current; }],
    ['head full sha', (r) => { r.checkouts[0].head = 'febd2cc99487febd2cc99487febd2cc99487febd'; }],
    ['headCommittedAt not ISO', (r) => { r.checkouts[0].headCommittedAt = 'yesterday'; }],
    ['sessionKey a raw id', (r) => { r.sessions[0].sessionKey = `session-${MARKER}`; }],
    ['kind unknown', (r) => { r.sessions[0].kind = 'worker'; }],
    ['harness a number', (r) => { r.sessions[0].harness = 1; }],
    ['launched attempt not an id', (r) => { r.sessions[1].launched.attempt = '../2'; }],
    ['lastHookRecordAt missing', (r) => { delete r.sessions[0].lastHookRecordAt; }],
    ['truncated a string', (r) => { r.truncated = 'no'; }],
    ['unreadable negative', (r) => { r.unreadable = -1; }],
  ],
  slots: [
    ['v missing', (r) => { delete r.v; }],
    ['name not an id', (r) => { r.slots[0].name = '../x'; }],
    ['alive a string', (r) => { r.slots[0].holder.alive = 'yes'; }],
    ['waiters missing', (r) => { delete r.slots[1].waiters; }],
    ['holder worktreeKey a path', (r) => { r.slots[0].holder.worktreeKey = `/tmp/${MARKER}`; }],
    ['since not ISO', (r) => { r.slots[0].holder.since = 'now'; }],
    ['unreadable missing', (r) => { delete r.unreadable; }],
  ],
  'worker-status': [
    ['disposition missing', (r) => { delete r.disposition; }],
    ['runId not an id', (r) => { r.runId = `/tmp/${MARKER}`; }],
    ['state unknown', (r) => { r.state = 'zombie'; }],
    ['reason free text', (r) => { r.reason = `because ${MARKER}`; }],
    ['token zero', (r) => { r.token = 0; }],
    ['attemptActive missing', (r) => { delete r.attemptActive; }],
    ['overdue a string', (r) => { r.overdue = 'yes'; }],
    ['startedAt not ISO', (r) => { r.startedAt = 'soon'; }],
    ['run present but not null', (r) => { r.run = { runId: 'w-0123456789ab' }; }],
  ],
  roadmap: [
    ['schema not 1', (r) => { r.schema = 2; }],
    ['action not status', (r) => { r.action = 'next'; }],
    ['holds missing', (r) => { delete r.holds; }],
    ['hold state unknown', (r) => { r.holds[0].state = 'stuck'; }],
    ['hold row not an id', (r) => { r.holds[0].row = 'row 9'; }],
    ['lease acquiredAt not ISO', (r) => { r.lease.acquiredAt = 'today'; }],
    ['run not an id', (r) => { r.run = `run ${MARKER}`; }],
  ],
  workflow: [
    ['stages missing', (r) => { delete r.stages; }],
    ['optional a string', (r) => { r.stages[0].optional = 'no'; }],
    ['purpose missing', (r) => { delete r.stages[1].purpose; }],
    ['gate prompt a number', (r) => { r.stages[0].gatesAfter[0].prompt = 1; }],
    ['gatesAfter missing', (r) => { delete r.stages[0].gatesAfter; }],
  ],
  capabilities: [
    ['capabilities an object', (r) => { r.capabilities = {}; }],
    ['status unknown', (r) => { r.capabilities[0].status = 'OK'; }],
    ['providerId missing', (r) => { delete r.capabilities[0].providerId; }],
  ],
  projects: [
    ['projects missing', (r) => { delete r.projects; }],
    ['store unknown', (r) => { r.store = 'maybe'; }],
    ['projectKey is a path', (r) => { r.projects[0].projectKey = r.projects[0].root; }],
    ['projectKey not 16 hex', (r) => { r.projects[0].projectKey = 'ABCDEF0123456789'; }],
    ['checkouts negative', (r) => { r.projects[0].checkouts = -1; }],
    ['current a string', (r) => { r.projects[0].current = 'yes'; }],
    ['sources unknown', (r) => { r.projects[0].sources = ['elsewhere']; }],
    ['lastRecordAt not ISO', (r) => { r.projects[0].lastRecordAt = 'recently'; }],
    ['excluded missing', (r) => { delete r.excluded; }],
    ['excluded.temp fractional', (r) => { r.excluded.temp = 0.5; }],
    ['truncated missing', (r) => { delete r.truncated; }],
    ['label missing', (r) => { delete r.projects[0].label; }],
  ],
  tree: [
    ['nodes missing', (r) => { delete r.nodes; }],
    ['v is 2', (r) => { r.v = 2; }],
    ['agentKey a session id', (r) => { r.nodes[0].agentKey = 'fa000000-0000-4000-8000-00000000c001'; }],
    ['kind unknown', (r) => { r.nodes[0].kind = 'lead'; }],
    ['modelBasis unknown', (r) => { r.nodes[0].modelBasis = 'guess'; }],
    ['liveness unknown', (r) => { r.nodes[0].liveness = 'active'; }],
    ['depth negative', (r) => { r.nodes[0].depth = -1; }],
    ['worktreeKey a path', (r) => { r.nodes[0].worktreeKey = `/work/${MARKER}`; }],
    ['transcript reason unknown', (r) => { r.nodes[1].transcript.reason = 'nope'; }],
    ['transcript.linked missing', (r) => { delete r.nodes[0].transcript.linked; }],
    ['ended.at not ISO', (r) => { r.nodes[1].ended.at = 'later'; }],
    ['edge basis unknown', (r) => { r.edges[0].basis = 'guess'; }],
    ['edge from a path', (r) => { r.edges[0].from = `/work/${MARKER}`; }],
    ['limits missing', (r) => { delete r.limits; }],
    ['unreadable missing', (r) => { delete r.unreadable; }],
  ],
  transcript: [
    ['events missing', (r) => { delete r.events; }],
    ['agentKey a path', (r) => { r.agentKey = `/work/${MARKER}`; }],
    ['reader.status unknown', (r) => { r.reader.status = 'great'; }],
    ['transcript.reason unknown', (r) => { r.transcript.reason = 'later'; }],
    ['event kind unknown', (r) => { r.events[0].kind = 'thinking'; }],
    ['seq negative', (r) => { r.events[0].seq = -1; }],
    ['at not ISO', (r) => { r.events[0].at = 'noon'; }],
    ['text a number', (r) => { r.events[0].text = 5; }],
    ['text on a tool-result', (r) => { r.events[2].text = 'tool output'; }],
    ['args on a reply', (r) => { r.events[0].args = '{}'; }],
    ['tool.status unknown', (r) => { r.events[2].tool.status = 'meh'; }],
    ['tool.callKey a raw id', (r) => { r.events[1].tool.callKey = 'toolu_01ABC'; }],
    ['tokens.input a string', (r) => { r.events[3].tokens.input = '10'; }],
    ['record.type unknown', (r) => { r.events[4].record.type = 'secret-note'; }],
    ['cut missing', (r) => { delete r.events[0].cut; }],
    ['cursor malformed', (r) => { r.cursor = '/path/to/file'; }],
    ['eof missing', (r) => { delete r.eof; }],
    ['warnings free text', (r) => { r.warnings = [`see ${MARKER} here`]; }],
    ['otherRecords negative', (r) => { r.otherRecords = -2; }],
  ],
  traffic: [
    ['agents missing', (r) => { delete r.agents; }],
    ['windowMin zero', (r) => { r.windowMin = 0; }],
    ['windowMin over 60', (r) => { r.windowMin = 61; }],
    ['eventsPerMin a string', (r) => { r.agents[0].eventsPerMin = '1.5'; }],
    ['eventsPerMin negative', (r) => { r.agents[0].eventsPerMin = -1; }],
    ['toolDurationMs.p50 missing', (r) => { delete r.agents[0].toolDurationMs.p50; }],
    ['tokens.output a string', (r) => { r.agents[0].tokens.output = 'many'; }],
    ['agentKey a path', (r) => { r.agents[0].agentKey = `/work/${MARKER}`; }],
    ['pair basis unknown', (r) => { r.pairs[0].basis = 'guess'; }],
    ['pair tasks of three', (r) => { r.pairs[1].tasks = ['A.1', 'A.2', 'A.3']; }],
    ['pair task not an id', (r) => { r.pairs[0].task = 'a b'; }],
    ['model not a string', (r) => { r.models[0].model = 1; }],
    ['notChecked missing', (r) => { delete r.notChecked; }],
  ],
};

for (const [shape, cases] of Object.entries(MUTATIONS)) {
  test(`${shape}: a missing or mistyped field is core-contract-mismatch with no body`, () => {
    for (const [name, mutate] of cases) {
      const raw = clone(fixture(shape));
      mutate(raw);
      assert.deepEqual(project(shape, raw, contextFor(shape)), MISMATCH, name);
    }
    for (const raw of [null, [], 'text', 1]) assert.deepEqual(project(shape, raw, contextFor(shape)), MISMATCH);
  });
}

// The closed sets are copies (the console ships without the core); each is checked against its source.
test('closed sets match the core source', () => {
  const read = (file: string) => fs.readFileSync(path.join(CORE_SRC, file), 'utf8');
  const literals = (text: string, pattern: RegExp) => [...new Set([...text.matchAll(pattern)].map((m) => m[1]))].sort();
  const frozen = (text: string, name: string) => {
    const match = text.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`));
    if (!match) throw new Error(`${name} not found`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  };
  const orchestrator = read('workflow-orchestrator.ts');
  const graph = read('task-graph.ts');
  const ledger = read('task-attempts.ts');
  const sorted = (values: readonly string[]) => [...values].sort();
  assert.deepEqual(sorted(CLOSED_SETS.runStates), frozen(orchestrator, 'RUN_STATES'));
  assert.deepEqual(sorted(CLOSED_SETS.gateDecisions), frozen(orchestrator, 'GATE_DECISIONS'));
  assert.deepEqual(sorted(CLOSED_SETS.attemptModes), frozen(ledger, 'MODES'));
  assert.deepEqual(sorted(CLOSED_SETS.attemptResults), frozen(ledger, 'RESULTS'));
  const outcomes = orchestrator.match(/const STAGE_OUTCOMES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(outcomes);
  assert.deepEqual(sorted(CLOSED_SETS.stageOutcomes), [...outcomes[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort());
  // `reason: '...'` in readinessOf, and every arm of each `reason = ...;` in deriveTasks except the `=== '...'` tests.
  const assigned = [...graph.matchAll(/reason = ([^;]*);/g)].map((m) => m[1].replace(/=== '[^']*'/g, '')).join(' ');
  assert.deepEqual(sorted(CLOSED_SETS.taskReasons),
    [...new Set([...literals(graph, /reason: '([a-z-]+)'/g), ...literals(assigned, /'([a-z-]+)'/g)])].sort());
  const derived = graph.match(/const DERIVED[^{]*\{([^}]*)\}/);
  assert.ok(derived);
  assert.deepEqual(sorted(CLOSED_SETS.taskStates), [...derived[1].matchAll(/([A-Z]+):/g)].map((m) => m[1]).sort());
  // Ledger states: the claim writes `state: 'active', result: null`; every later move is `<attempt>.state = '...'`.
  const ledgerWrites = ledger + read('task-run.ts');
  assert.deepEqual(sorted(CLOSED_SETS.attemptStates),
    [...new Set([...literals(ledgerWrites, /\.state = '([a-z]+)'/g), ...literals(ledger, /state: '([a-z]+)', result: null/g)])].sort());

  // IC-018: harness ids from the registry; worker states and reasons from statusView and the end-state writes; roadmap hold states.
  const harnesses = JSON.parse(fs.readFileSync(path.join(CORE_SRC, '..', '..', 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses;
  assert.deepEqual(sorted(CLOSED_SETS.harnessIds), harnesses.map((h: any) => h.id).sort());
  const worker = read('worker/command.ts');
  const view = worker.slice(worker.indexOf('function statusView'), worker.indexOf('function', worker.indexOf('function statusView') + 1));
  assert.ok(view.length > 0);
  const viewStates = [...literals(view, /state = '([a-z-]+)'/g), ...literals(view, /\[state, reason\] = \['([a-z-]+)'/g)];
  const endStates = [...literals(read('worker/supervisor.ts'), /end = \{ state: '([a-z-]+)'/g), ...literals(read('worker/cancel.ts'), /endState = [^;]*\? '([a-z-]+)' : '([a-z-]+)'/g),
    ...literals(read('worker/cancel.ts'), /endState = [^;]*: '([a-z-]+)';/g)];
  assert.deepEqual(sorted(CLOSED_SETS.workerStates), [...new Set([...viewStates, ...endStates])].sort());
  assert.deepEqual(sorted(CLOSED_SETS.workerReasons), literals(view, /'([a-z]+-[a-z-]+)'/g).filter((r: string) => !CLOSED_SETS.workerStates.includes(r)));
  const loop = read('roadmap/loop.ts');
  const operational = loop.slice(loop.indexOf('function operationalState'), loop.indexOf('function loadRunRecord'));
  assert.deepEqual(sorted(CLOSED_SETS.roadmapHoldStates), literals(operational, /state: '([a-z]+)'/g));
});

// ---- V.7: the Fleet projectors (IC-024) ----

test('projects: no root and no path in the body; the project key and label are all that identify a project', () => {
  const result = project('projects', fixture('projects'));
  assert.equal(result.ok, true);
  const text = JSON.stringify(result.body);
  assert.ok(!keyPaths(result.body).some((p) => p.includes('root')), 'no root field');
  assert.ok(!text.includes('/work/') && !text.includes(MARKER), 'no root text');
  assert.deepEqual(result.body.projects.map((p: any) => p.label), ['main', WITHHELD]);
  // Control (plan V.7): the same check on a pass-through projector is red.
  const leaky = (shape: string, raw: unknown) => ({ ok: true, body: raw });
  const passed = leaky('projects', fixture('projects')).body;
  assert.ok(JSON.stringify(passed).includes('/work/'), 'a pass-through projector carries the root');
  assert.deepEqual(leaks((shape, raw, context) => (shape === 'projects' ? leaky(shape, raw) : project(shape, raw, context))), ['projects']);
});

test('tree: a harness outside the registry is (other); an unknown model is withheld; the node set carries labels and keys only', () => {
  const body = project('tree', fixture('tree')).body;
  assert.deepEqual(body.nodes.map((n: any) => n.harness), ['claude', OTHER_HARNESS]);
  assert.equal(body.nodes[1].model, WITHHELD);
  assert.deepEqual(body.nodes[1].ended, { at: '2026-10-26T09:50:00.000Z', result: 'exited' });
  assert.deepEqual(body.edges, [{ from: AGENT_A, to: AGENT_B, basis: 'worker-caller' }]);
});

test('transcript: text and args are masked a second time and the cap is re-checked', () => {
  const raw = fixture('transcript');
  raw.events[0].text = 'ok ghp_abcdefghijklmnopqrstuvwxyz0123456789 and fx-person@example.invalid and password=hunter2x9 /Users/someone/code';
  raw.events[1].args = '{"command":"echo","apiKey":"abcdef123456"}';
  const body = project('transcript', raw).body;
  assert.equal(body.events[0].text, 'ok <masked> and <email> and password=<masked> /Users/<masked>/code');
  assert.ok(!body.events[1].args.includes('abcdef123456') && body.events[1].args.includes('<masked>'));
  // Already-masked text is unchanged.
  const again = fixture('transcript');
  again.events[0].text = 'token=<masked> sent to <email> from <ip>';
  assert.equal(project('transcript', again).body.events[0].text, 'token=<masked> sent to <email> from <ip>');

  const cap = (text: string, field: 'text' | 'args', event: number) => { const r = fixture('transcript'); r.events[event][field] = text; return project('transcript', r); };
  assert.equal(cap('a'.repeat(4096), 'text', 0).ok, true);
  assert.deepEqual(cap('a'.repeat(4097), 'text', 0), MISMATCH);
  assert.equal(cap('é'.repeat(2048), 'text', 0).ok, true, 'the cap counts bytes: 2048 two-byte characters are exactly 4 KiB');
  assert.deepEqual(cap('é'.repeat(2049), 'text', 0), MISMATCH);
  assert.equal(cap('b'.repeat(512), 'args', 1).ok, true);
  assert.deepEqual(cap('b'.repeat(513), 'args', 1), MISMATCH);
  // A text that fits only until the second pass grows it (a 6-character address becomes the 7-character marker) is refused, not cut.
  assert.deepEqual(cap(`${'a'.repeat(4089)} a@b.co`, 'text', 0), MISMATCH);
});

test('traffic: unknown is null and stays null; zero stays zero', () => {
  const body = project('traffic', fixture('traffic')).body;
  assert.equal(body.agents[1].eventsPerMin, null);
  assert.equal(body.agents[1].toolCalls, null);
  const raw = fixture('traffic');
  raw.agents[0].toolErrors = 0;
  raw.agents[0].eventsPerMin = 0;
  const zero = project('traffic', raw).body;
  assert.equal(zero.agents[0].toolErrors, 0);
  assert.equal(zero.agents[0].eventsPerMin, 0);
});

test('Fleet closed sets are literals of the core source', () => {
  const dirText = (dir: string) => fs.readdirSync(path.join(CORE_SRC, dir), { withFileTypes: true })
    .flatMap((e: any) => (e.isDirectory() ? [] : [fs.readFileSync(path.join(CORE_SRC, dir, e.name), 'utf8')])).join('\n');
  const tree = dirText('fleet');
  const transcripts = dirText('transcripts') + dirText('transcripts/readers');
  const missing = (source: string, values: readonly string[]) => values.filter((v) => !source.includes(`'${v}'`));
  assert.deepEqual(missing(tree, [...CLOSED_SETS.agentKinds, ...CLOSED_SETS.modelBases, ...CLOSED_SETS.livenessStates, ...CLOSED_SETS.edgeBases, ...CLOSED_SETS.projectSources]), []);
  assert.deepEqual(missing(tree + transcripts, CLOSED_SETS.transcriptReasons), []);
  // IC-022 lists `turn-end`; no reader emits it yet, so the source cannot confirm it.
  assert.deepEqual(missing(transcripts, [...CLOSED_SETS.eventKinds.filter((kind: string) => kind !== 'turn-end'), ...CLOSED_SETS.readerStatuses, ...CLOSED_SETS.pairBases, ...CLOSED_SETS.toolStatuses]), []);
  assert.deepEqual(missing(tree + transcripts, CLOSED_SETS.recordTypes), []);
});

test('handshake: the core version against doflowCore', async () => {
  assert.equal(MANIFEST.doflowCore, '>=2.0.0-beta.7 <3.0.0');
  assert.deepEqual(checkCoreVersion('2.0.0-beta.7'), { ok: true, inRange: true, version: '2.0.0-beta.7', needed: MANIFEST.doflowCore });
  assert.equal(checkCoreVersion('2.0.0').inRange, true);
  assert.equal(checkCoreVersion('2.9.1').inRange, true);
  assert.deepEqual(checkCoreVersion('2.0.0-beta.6'), { ok: true, inRange: false, version: '2.0.0-beta.6', needed: MANIFEST.doflowCore });
  assert.equal(checkCoreVersion('3.0.0').inRange, false);
  // SemVer precedence, as the core's host range: a 3.0.0 prerelease sorts below 3.0.0, so `<3.0.0` accepts it.
  assert.equal(checkCoreVersion('3.0.0-alpha.1').inRange, true);
  assert.equal(checkCoreVersion('1.9.9').inRange, false);
  for (const bad of ['', 'v2.0.0', '2.0.0\n', 'doflow 2.0.0', 2, null]) assert.deepEqual(checkCoreVersion(bad), MISMATCH, String(bad));

  const runner = (result: unknown) => ({ run: async (shape: string, params: unknown) => { assert.equal(shape, 'version'); assert.deepEqual(params, {}); return result; } });
  assert.deepEqual(await handshake(runner({ ok: true, json: '2.0.0-beta.7', exit: 0 })), { ok: true, inRange: true, version: '2.0.0-beta.7', needed: MANIFEST.doflowCore });
  assert.deepEqual(await handshake(runner({ ok: true, json: '3.1.0', exit: 0 })), { ok: true, inRange: false, version: '3.1.0', needed: MANIFEST.doflowCore });
  const unreachable = { ok: false, code: 'core-unreachable', exit: null };
  assert.deepEqual(await handshake(runner(unreachable)), unreachable);
  assert.deepEqual(await handshake(runner({ ok: true, json: 'garbage', exit: 0 })), MISMATCH);
});

test('handshake range check agrees with the core semver helper', () => {
  const versions = ['0.0.0', '1.9.9', '2.0.0-alpha', '2.0.0-beta.6', '2.0.0-beta.7', '2.0.0-beta.10', '2.0.0-beta.7.1', '2.0.0-rc.1',
    '2.0.0', '2.0.1+build.5', '2.10.0', '3.0.0-0', '3.0.0', '10.0.0', '2.0.0-beta', '2.0.0-1'];
  const ranges = [MANIFEST.doflowCore, '>=2.0.0 <2.1.0', '=2.0.0-beta.7', '2.0.0', '>=1.0.0 <2.0.0-beta.7', '<1.0.0'];
  for (const range of ranges) {
    for (const version of versions) {
      assert.equal(satisfiesRange(version, range), coreSemver.satisfiesHostRange(version, range), `${version} vs ${range}`);
    }
  }
  assert.throws(() => satisfiesRange('2.0.0', '^2.0.0'), /range/);
  assert.throws(() => satisfiesRange('2.0.0', '>=2.0.0'), /range/);
});
