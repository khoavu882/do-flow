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
const RUN_A = 'w-1a2b3c4d5e6f';
const RUN_B = 'w-0f0e0d0c0b0a';
/** The process numbers planted in the 150 samples (pid, pgid, survivors, zombies): none may reach a body. */
const PLANTED_PIDS = ['987001', '987002', '987003', '987004', '987005', '987006'];

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
    // 150 IC-011: the record's process and cleanup as the core writes them, with pids, a process start and other planted keys the projector never reads.
    process: { kind: 'exited', code: 0, signal: null, at: '2026-10-26T09:20:00.000Z', groupAlive: true,
      leftover: { status: 'survivors', reason: null, survivors: [987003], zombies: [987004] }, pid: 987001, pgid: 987002, start: `Mon ${MARKER}`, command: `codex exec ${MARKER}` },
    report: { file: `/tmp/${MARKER}/report.md`, text: MARKER }, readOnly: false,
    edit: { worktree: `/tmp/${MARKER}` }, isolation: { root: `/tmp/${MARKER}` }, childOf: null, request: null,
    verified: null, attemptActive: true, resultOffered: false, withheld: { reason: MARKER },
    cleanup: { status: 'verified', reason: null, survivors: [987005], zombies: [987006], kept: [`/tmp/${MARKER}`] },
    supervisorCleanup: null, attemptCancel: null, output: { tail: MARKER }, launchObserved: null,
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
  // 150 IC-002 to IC-004, as the A.3 core prints them (src/runtime/worker/reads.ts), with planted pids, a prompt, paths and extra keys.
  'worker-runs': {
    v: 1, slug: '150-console-v2-chain', store: 'present',
    runs: [
      { runId: RUN_A, task: 'A.1', token: 1, harness: 'codex', childOf: null, phase: 'ended', endState: 'exited', createdAt: '2026-11-08T05:00:00.000Z',
        startedAt: '2026-11-08T05:00:01.000Z', endedAt: '2026-11-08T05:03:00.000Z', edit: false,
        prompt: `do the task ${MARKER}`, pid: 987001, pgid: 987002, execWorktree: `/tmp/${MARKER}/wt` },
      { runId: RUN_B, task: 'A.1', token: 1, harness: 'my-fork', childOf: RUN_A, phase: 'running', endState: null, createdAt: null,
        startedAt: null, endedAt: null, edit: true },
    ],
    limits: { shown: 2, notShown: 3 }, path: `/tmp/${MARKER}/worker-runs.json`,
  },
  'worker-result': {
    v: 1, runId: RUN_A, task: 'A.1', token: 1, harness: 'codex', phase: 'ended', endState: 'exited', endedAt: '2026-11-08T05:03:00.000Z',
    reportStatus: 'failure', readOnly: 'clean', isolation: null, resultOffered: false, withheld: ['report-quota'],
    quota: { signal: `rate ${MARKER} <x>`, basis: 'transcript' },
  },
  'worker-log': {
    v: 1, runId: RUN_A, stream: 'out', phase: 'running', log: 'open', ino: '8812345', size: 40000, from: 0, to: 32800,
    pieces: [
      { at: 0, text: 'compiling', file: `/tmp/${MARKER}/w.out.log` },
      { at: 10, text: 'key ghp_abcdefghijklmnopqrstuvwxyz0123456789 in /Users/someone/code' },
      { at: 100, text: 'a long line', cut: true },
      { at: 32768, text: 'its tail' },
    ],
    eof: false, reset: false, capped: null, cursor: '8812345:32800:0:1762581600000', before: null, path: `/tmp/${MARKER}/w-1a2b3c4d5e6f.out.log`, pid: 987001,
  },
};
SAMPLES['worker-run-status'] = SAMPLES['worker-status'];

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
  'worker-status': [...['runId', 'task', 'token', 'harness', 'state', 'reason', 'startedAt', 'endedAt', 'overdue', 'supervisorLost', 'attemptActive'].map((k) => `.${k}`),
    // 150 IC-011: the widened fields.
    ...['deadline', 'childOf', 'process', 'cleanup', 'cleanup.status', 'cleanup.reason'].map((k) => `.${k}`),
    ...['kind', 'code', 'signal', 'at', 'reason', 'groupAlive', 'leftover', 'leftover.status', 'leftover.reason'].map((k) => `.process.${k}`)],
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
  // 150 IC-011.
  'worker-runs': ['.v', '.slug', '.source', '.store', '.runs', '.limits', '.limits.shown', '.limits.notShown', '.limits.ended',
    ...['runId', 'task', 'token', 'harness', 'childOf', 'phase', 'endState', 'createdAt', 'startedAt', 'endedAt', 'edit'].map((k) => `.runs[].${k}`)],
  'worker-result': ['.v', '.runId', '.task', '.token', '.harness', '.phase', '.endState', '.endedAt', '.reportStatus', '.readOnly', '.isolation',
    '.resultOffered', '.withheld', '.withheld[]', '.quota', '.quota.signal', '.quota.basis'],
  'worker-log': ['.v', '.runId', '.stream', '.phase', '.log', '.ino', '.size', '.from', '.to', '.pieces', '.pieces[].at', '.pieces[].text', '.pieces[].cut',
    '.eof', '.reset', '.capped', '.cursor', '.before'],
};
FIELD_SETS['worker-run-status'] = FIELD_SETS['worker-status'];

const contextFor = (shape: string) => (shape === 'status' ? { workflow: workflowBody() } : undefined);
const MARKED_SHAPES = ['list', 'status', 'timeline', 'attempts', 'workflow', 'capabilities', 'observed', 'slots', 'worker-status', 'roadmap', 'projects', 'tree', 'transcript', 'traffic',
  'worker-runs', 'worker-result', 'worker-log', 'worker-run-status'];

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
    ['worker-status', (f) => [f.process.start, f.process.command]], // 150: a process start and command beside the pids
    ['worker-runs', (f) => [f.path, f.runs[0].prompt, f.runs[0].execWorktree]],
    ['worker-result', (f) => f.quota.signal], // a quota signal over the label rule
    ['worker-log', (f) => [f.path, f.pieces[0].file]],
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

test('labels: a path, a drive prefix or a label the mask would change is withheld; ordinary names stay', () => {
  const owners = (owner: string) => {
    const raw = clone(fixture('attempts'));
    raw.graph.tasks[1].owner = owner;
    raw.tasks[0].attempts[0].owner = owner;
    const body = project('attempts', raw).body;
    return [body.graph.tasks[1].owner, body.tasks[0].attempts[0].owner];
  };
  for (const bad of ['/Users/example/private', '~/notes', '/srv/app/x', 'D:/work/x', 'C:\\Users\\me', 'C:/Users/me', 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']) {
    assert.deepEqual(owners(bad), [WITHHELD, WITHHELD], `${bad} is withheld`);
  }
  for (const good of ['core-implementer', 'claude:opus', 'team@lead', 'a/b', 'C 1']) {
    assert.deepEqual(owners(good), [good, good], `${good} stays`);
  }
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
    // 150 IC-011: the widened fields.
    deadline: '2026-10-26T10:00:00.000Z', childOf: null,
    process: { kind: 'exited', code: 0, signal: null, at: '2026-10-26T09:20:00.000Z', reason: null, groupAlive: true, leftover: { status: 'survivors', reason: null } },
    cleanup: { status: 'verified', reason: null },
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

// ---- 150 IC-011: the worker reads ----

/** Every planted process number, prompt, path or marker that reaches a projected body. */
const plantedIn = (body: unknown) => [...PLANTED_PIDS, MARKER, '/tmp/', 'do the task'].filter((planted) => JSON.stringify(body).includes(planted));

test('worker-status (150): deadline, childOf, process and cleanup; no pid, pgid, start, survivors or zombies is read', () => {
  // The fields it carried before keep their values (control).
  const before = ['runId', 'task', 'token', 'harness', 'state', 'reason', 'startedAt', 'endedAt', 'overdue', 'supervisorLost', 'attemptActive'];
  for (const shape of ['worker-status', 'worker-run-status']) {
    const { body } = project(shape, fixture('worker-status'));
    assert.deepEqual(plantedIn(body), [], shape);
    const old = fixture('worker-status');
    assert.deepEqual(Object.fromEntries(before.map((k) => [k, body[k]])), Object.fromEntries(before.map((k) => [k, old[k]])), shape);
  }
  // The never-read fields may hold anything: a mistyped pid, pgid, start, survivors or zombies is not a refusal.
  const odd = fixture('worker-status');
  Object.assign(odd.process, { pid: 'x', pgid: { n: 1 }, start: [] });
  Object.assign(odd.process.leftover, { survivors: 'many', zombies: null });
  Object.assign(odd.cleanup, { survivors: 7, zombies: 'none' });
  assert.equal(project('worker-status', odd).ok, true);
  // A not-started run: no code, signal, group reading or leftover in the record, each null.
  const notStarted = { ...fixture('worker-status'), childOf: RUN_A, cleanup: null, process: { kind: 'not-started', reason: 'attempt-inactive', at: '2026-10-26T09:00:01.000Z' } };
  const ns = project('worker-status', notStarted).body;
  assert.equal(ns.childOf, RUN_A);
  assert.equal(ns.cleanup, null);
  assert.deepEqual(ns.process, { kind: 'not-started', code: null, signal: null, at: '2026-10-26T09:00:01.000Z', reason: 'attempt-inactive', groupAlive: null, leftover: null });
  const killed = fixture('worker-status');
  Object.assign(killed.process, { code: null, signal: 'SIGTERM', groupAlive: 'unknown' });
  killed.cleanup = { status: 'unknown', reason: 'win32', survivors: [], zombies: [] };
  const k = project('worker-status', killed).body;
  assert.deepEqual([k.process.code, k.process.signal, k.process.groupAlive, k.cleanup], [null, 'SIGTERM', 'unknown', { status: 'unknown', reason: 'win32' }]);
  // A body without the four keys (an IC-018 d body) reads them as null.
  const { deadline: _d, childOf: _c, process: _p, cleanup: _x, ...older } = fixture('worker-status');
  const o = project('worker-status', older).body;
  assert.deepEqual([o.deadline, o.childOf, o.process, o.cleanup], [null, null, null, null]);
});

test('worker-runs: source and ended are the projector\'s; shown equals the runs listed; planted pids, prompt and paths dropped', () => {
  const { body } = project('worker-runs', fixture('worker-runs'));
  assert.deepEqual(body, {
    v: 1, slug: '150-console-v2-chain', source: 'worker-runs', store: 'present',
    runs: [
      { runId: RUN_A, task: 'A.1', token: 1, harness: 'codex', childOf: null, phase: 'ended', endState: 'exited', createdAt: '2026-11-08T05:00:00.000Z',
        startedAt: '2026-11-08T05:00:01.000Z', endedAt: '2026-11-08T05:03:00.000Z', edit: false },
      { runId: RUN_B, task: 'A.1', token: 1, harness: OTHER_HARNESS, childOf: RUN_A, phase: 'running', endState: null, createdAt: null,
        startedAt: null, endedAt: null, edit: true },
    ],
    limits: { shown: 2, notShown: 3, ended: 'listed' },
  });
  assert.deepEqual(plantedIn(body), []);
  const absent = { v: 1, slug: 'feat-a', store: 'absent', runs: [], limits: { shown: 0, notShown: 0 } };
  assert.deepEqual(project('worker-runs', absent).body, { ...absent, source: 'worker-runs', limits: { shown: 0, notShown: 0, ended: 'listed' } });
});

test('worker-result: exactly IC-003\'s keys; harness (other); every withheld code and closed isolation reason; quota labels', () => {
  const { body } = project('worker-result', fixture('worker-result'));
  assert.deepEqual(body, { ...fixture('worker-result'), quota: { signal: WITHHELD, basis: 'transcript' } });
  assert.deepEqual(plantedIn(body), []);
  const edit = { ...fixture('worker-result'), harness: 'some-new-harness', readOnly: null, isolation: { status: 'violated', reason: 'branch-moved' },
    reportStatus: 'success', withheld: [...CLOSED_SETS.withheldCodes], quota: null };
  const e = project('worker-result', edit).body;
  assert.equal(e.harness, OTHER_HARNESS);
  assert.deepEqual(e.withheld, [...CLOSED_SETS.withheldCodes]);
  assert.equal(CLOSED_SETS.withheldCodes.length, 11);
  assert.deepEqual(e.isolation, { status: 'violated', reason: 'branch-moved' });
  for (const reason of CLOSED_SETS.isolationReasons) assert.equal(project('worker-result', { ...edit, isolation: { status: 'violated', reason } }).ok, true, reason);
  assert.deepEqual(project('worker-result', { ...edit, isolation: { status: 'clean', reason: null } }).body.isolation, { status: 'clean', reason: null });
  // A run that has not ended: every not-yet field null, the result withheld.
  const early = { ...fixture('worker-result'), phase: 'running', endState: null, endedAt: null, reportStatus: null, readOnly: null, withheld: ['not-exited', 'read-only-unverifiable', 'report-unparsed'], quota: null };
  assert.deepEqual(project('worker-result', early).body, early);
  const offered = { ...fixture('worker-result'), reportStatus: 'success', resultOffered: true, withheld: [], quota: null };
  assert.deepEqual(project('worker-result', offered).body, offered);
});

test('worker-log: pieces masked again piece by piece; cut kept; offsets bounded; planted path and pid dropped', () => {
  const { body } = project('worker-log', fixture('worker-log'));
  assert.deepEqual(body.pieces, [
    { at: 0, text: 'compiling', cut: false },
    { at: 10, text: 'key <masked> in /Users/<masked>/code', cut: false },
    { at: 100, text: 'a long line', cut: true },
    { at: 32768, text: 'its tail', cut: false },
  ]);
  const { pieces: _pieces, path: _path, pid: _pid, ...rest } = fixture('worker-log');
  const { pieces: _projected, ...restBody } = body;
  assert.deepEqual(restBody, rest);
  assert.deepEqual(plantedIn(body), []);
  // Already-masked text is unchanged.
  const again = fixture('worker-log');
  again.pieces[0].text = 'token=<masked> sent to <email>';
  assert.equal(project('worker-log', again).body.pieces[0].text, 'token=<masked> sent to <email>');
  // A waiting log: no file, no inode, no cursor; an empty page at the end.
  const waiting = { v: 1, runId: RUN_A, stream: 'err', phase: 'starting', log: 'waiting', ino: null, size: 0, from: 0, to: 0, pieces: [], eof: true, reset: false, capped: null, cursor: null, before: null };
  assert.deepEqual(project('worker-log', waiting).body, waiting);
  // A final page of an ended run, read backward: `before` set, `capped` a boolean, `to === size`.
  const final = { ...fixture('worker-log'), phase: 'ended', from: 100, to: 40000, pieces: [{ at: 100, text: 'x' }, { at: 32768, text: 'y' }], eof: true, capped: true,
    before: '8812345:100:0:1762581600000' };
  const f = project('worker-log', final).body;
  assert.deepEqual([f.from, f.to, f.capped, f.before], [100, 40000, true, '8812345:100:0:1762581600000']);
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
    // 150 IC-011: the widened fields.
    ['deadline not ISO', (r) => { r.deadline = 'later'; }],
    ['childOf not a run id', (r) => { r.childOf = 'A.1'; }],
    ['process not an object', (r) => { r.process = 'exited'; }],
    ['process kind unknown', (r) => { r.process.kind = 'running'; }],
    ['process kind missing', (r) => { delete r.process.kind; }],
    ['process code over 255', (r) => { r.process.code = 256; }],
    ['process code negative', (r) => { r.process.code = -1; }],
    ['process at missing', (r) => { delete r.process.at; }],
    ['process signal a number', (r) => { r.process.signal = 15; }],
    ['process reason free text', (r) => { r.process.reason = `because ${MARKER}`; }],
    ['groupAlive a string', (r) => { r.process.groupAlive = 'yes'; }],
    ['leftover status unknown', (r) => { r.process.leftover.status = 'gone'; }],
    ['leftover reason missing', (r) => { delete r.process.leftover.reason; }],
    ['cleanup status unknown', (r) => { r.cleanup.status = 'kept'; }],
    ['cleanup status missing', (r) => { delete r.cleanup.status; }],
  ],
  'worker-runs': [
    ['v is not 1', (r) => { r.v = 2; }],
    ['slug a path', (r) => { r.slug = `../${MARKER}`; }],
    ['store unknown', (r) => { r.store = 'torn'; }],
    ['runs missing', (r) => { delete r.runs; }],
    ['runId not a run id', (r) => { r.runs[0].runId = 'A.1'; }],
    ['task missing', (r) => { delete r.runs[0].task; }],
    ['token zero', (r) => { r.runs[0].token = 0; }],
    ['harness a number', (r) => { r.runs[0].harness = 7; }],
    ['childOf not a run id', (r) => { r.runs[1].childOf = 'parent'; }],
    ['phase unknown', (r) => { r.runs[0].phase = 'done'; }],
    ['endState unknown', (r) => { r.runs[0].endState = 'killed'; }],
    ['createdAt not ISO', (r) => { r.runs[0].createdAt = 'yesterday'; }],
    ['startedAt missing', (r) => { delete r.runs[0].startedAt; }],
    ['endedAt not ISO', (r) => { r.runs[0].endedAt = 5; }],
    ['edit a string', (r) => { r.runs[0].edit = 'no'; }],
    ['limits missing', (r) => { delete r.limits; }],
    ['shown is not runs.length', (r) => { r.limits.shown = 3; }],
    ['notShown missing', (r) => { delete r.limits.notShown; }],
    ['notShown negative', (r) => { r.limits.notShown = -1; }],
  ],
  'worker-result': [
    ['an extra key', (r) => { r.summary = `done ${MARKER}`; }],
    ['an extra key with a pid', (r) => { r.pid = 987001; }],
    ['an extra key with a null', (r) => { r.prompt = null; }],
    ['reportStatus missing', (r) => { delete r.reportStatus; }],
    ['quota missing', (r) => { delete r.quota; }],
    ['v is not 1', (r) => { r.v = 2; }],
    ['runId not a run id', (r) => { r.runId = `/tmp/${MARKER}`; }],
    ['token a string', (r) => { r.token = '1'; }],
    ['harness a number', (r) => { r.harness = 1; }],
    ['phase unknown', (r) => { r.phase = 'done'; }],
    ['endState unknown', (r) => { r.endState = 'killed'; }],
    ['endedAt not ISO', (r) => { r.endedAt = 'now'; }],
    ['reportStatus unknown', (r) => { r.reportStatus = 'partial'; }],
    ['readOnly unknown', (r) => { r.readOnly = 'dirty'; }],
    ['isolation status unknown', (r) => { r.isolation = { status: 'dirty', reason: null }; }],
    ['isolation reason unknown', (r) => { r.isolation = { status: 'violated', reason: `because ${MARKER}` }; }],
    ['isolation not an object', (r) => { r.isolation = 'clean'; }],
    ['withheld not an array', (r) => { r.withheld = 'report-quota'; }],
    ['withheld code unknown', (r) => { r.withheld = ['report-quota', 'not-trusted']; }],
    ['resultOffered with withheld codes', (r) => { r.resultOffered = true; }],
    ['resultOffered false with none withheld', (r) => { r.withheld = []; }],
    ['quota basis a number', (r) => { r.quota.basis = 1; }],
    ['quota signal missing', (r) => { delete r.quota.signal; }],
  ],
  'worker-log': [
    ['v is not 1', (r) => { r.v = 2; }],
    ['runId not a run id', (r) => { r.runId = 'w-XYZ'; }],
    ['stream last', (r) => { r.stream = 'last'; }],
    ['phase unknown', (r) => { r.phase = 'done'; }],
    ['log unknown', (r) => { r.log = 'closed'; }],
    ['ino not digits', (r) => { r.ino = '88a'; }],
    ['ino a number', (r) => { r.ino = 8812345; }],
    ['size missing', (r) => { delete r.size; }],
    ['from after to', (r) => { r.from = 32801; }],
    ['to past size', (r) => { r.size = 32799; }],
    ['from negative', (r) => { r.from = -1; }],
    ['piece before from', (r) => { r.from = 5; }],
    ['piece at to', (r) => { r.to = 32768; }],
    ['piece offsets not rising', (r) => { r.pieces[2].at = 10; }],
    ['piece offsets falling', (r) => { r.pieces[3].at = 50; }],
    ['piece text missing', (r) => { delete r.pieces[1].text; }],
    ['piece text a number', (r) => { r.pieces[1].text = 7; }],
    ['piece cut a string', (r) => { r.pieces[2].cut = 'yes'; }],
    ['pieces not an array', (r) => { r.pieces = 'compiling'; }],
    ['eof missing', (r) => { delete r.eof; }],
    ['reset a string', (r) => { r.reset = 'no'; }],
    ['capped a string', (r) => { r.capped = 'no'; }],
    ['cursor malformed', (r) => { r.cursor = '8812345:32800'; }],
    ['cursor missing', (r) => { delete r.cursor; }],
    ['before malformed', (r) => { r.before = 'start'; }],
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
MUTATIONS['worker-run-status'] = MUTATIONS['worker-status'];

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

// 150 IC-011: the worker-read closed sets, each read from the file that owns it.
test('150 worker closed sets match the core source', () => {
  const read = (file: string) => fs.readFileSync(path.join(CORE_SRC, 'worker', file), 'utf8');
  const sorted = (values: readonly string[]) => [...values].sort();
  const quoted = (text: string) => [...new Set([...text.matchAll(/'([^']+)'/g)].map((m) => m[1]))].sort();
  const between = (text: string, start: string, end: string) => {
    const from = text.indexOf(start);
    assert.ok(from !== -1, `${start} not found`);
    const to = text.indexOf(end, from + start.length);
    return text.slice(from, to === -1 ? undefined : to);
  };
  const union = (...sets: string[][]) => [...new Set(sets.flat())].sort();

  // PHASES, src/runtime/worker/run-store.ts:27.
  const phases = read('run-store.ts').match(/const PHASES = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(phases);
  assert.deepEqual(sorted(CLOSED_SETS.phases), quoted(phases[1]));

  // End states: every `end = { state: '...'` the supervisor writes and both arms of cancel.ts's endState.
  const supervisor = read('supervisor.ts');
  const cancel = read('cancel.ts');
  const cancelEnd = cancel.match(/const endState = [^;]*\? '([a-z-]+)' : '([a-z-]+)';/);
  assert.ok(cancelEnd);
  assert.deepEqual(sorted(CLOSED_SETS.endStates), union([...supervisor.matchAll(/end = \{ state: '([a-z-]+)'/g)].map((m) => m[1]), [cancelEnd[1], cancelEnd[2]]));

  // The 11 withheld codes: every literal pushed by resultOfRun (src/runtime/worker/supervisor.ts:269), the `=== '...'` tests aside.
  const resultOf = between(supervisor, 'function resultOfRun', 'function ');
  const pushed = [...resultOf.matchAll(/withheld\.push\(([^;]*)\);/g)].flatMap((m) => quoted(m[1].replace(/=== '[^']*'/g, '')));
  assert.equal(new Set(pushed).size, 11);
  assert.equal(CLOSED_SETS.withheldCodes.length, 11);
  assert.deepEqual(sorted(CLOSED_SETS.withheldCodes), union(pushed));

  // Isolation reasons: the `[status, reason]` pairs of isolationOf.
  const isolation = between(supervisor, 'function isolationOf', 'function ');
  assert.deepEqual(sorted(CLOSED_SETS.isolationReasons), union([...isolation.matchAll(/\['[a-z]+', '([a-z-]+)'\]/g)].map((m) => m[1])));
  // Process kinds: every `kind: '...'` the supervisor writes.
  assert.deepEqual(sorted(CLOSED_SETS.processKinds), union([...supervisor.matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1])));

  // Report statuses, src/runtime/worker/parsers/common.ts:16 (the Report type's status union).
  const reportStatus = between(read('parsers/common.ts'), 'export type Report', '};').match(/status: ((?:'[a-z-]+'(?: \| )?)+);/);
  assert.ok(reportStatus);
  assert.deepEqual(sorted(CLOSED_SETS.reportStatuses), quoted(reportStatus?.[1] ?? ''));

  // Check statuses, src/runtime/worker/worktree-check.ts:52 (the Comparison interface's status union).
  const checkStatus = between(read('worktree-check.ts'), 'interface Comparison', '}').match(/status: ((?:'[a-z-]+'(?: \| )?)+);/);
  assert.ok(checkStatus);
  assert.deepEqual(sorted(CLOSED_SETS.checkStatuses), quoted(checkStatus?.[1] ?? ''));

  // Leftover statuses: what escalate (process-tree.ts) returns, and the cleanup statuses cancel.ts writes and merges.
  const escalate = between(read('process-tree.ts'), 'async function escalate', 'function spawnBounded');
  const returned = [...escalate.matchAll(/status: (?:[^,'\n]*\? )?'([a-z]+)'(?: : '([a-z]+)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean);
  const cleanups = [...cancel.matchAll(/status(?::| =) '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(sorted(CLOSED_SETS.leftoverStatuses), union(returned, cleanups));

  // Log streams (LOG_STREAMS, log-read.ts) and log states (reads.ts's `log`, the `=== '...'` test aside).
  const streams = read('log-read.ts').match(/const LOG_STREAMS = Object\.freeze\(\{([^}]*)\}\)/);
  assert.ok(streams);
  assert.deepEqual(sorted(CLOSED_SETS.logStreams), union([...streams[1].matchAll(/([a-z]+):/g)].map((m) => m[1])));
  const log = read('reads.ts').match(/const log = ([^;]*);/);
  assert.ok(log);
  assert.deepEqual(sorted(CLOSED_SETS.logStates), quoted(log[1].replace(/=== '[^']*'/g, '')));
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

// ---- 151 B.3: the config-list, config-schema, advise-report and advice-picks projectors (IC-007, IC-008, IC-006) ----

const { LAYERS, CANDIDATE_STATUSES, VIA, FILE_CODES, SCOPES, ADVICE_MODES } = require('../src/project.ts');
const { anchorsOf, placeText, TOO_LONG } = require('../src/place.ts');

const P_SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const P_EMAIL = 'fx-person@example.invalid';
const P_IP = '203.0.113.77';
const P_URL_PASS = 'hunter2pass';
const P_URL = `https://bob:${P_URL_PASS}@example.invalid/x`;
const P_HOME = '/Users/fxperson';
const P_OTHER_HOME = '/Users/otherperson';
/** A project root, its layers and a config home outside any home folder: maskLite's home rule cannot see them. */
const P_ROOT = '/srv/zz-proj-root';
const P_LAYERS = '/srv/zz-main/.doflow';
const P_CFG = '/opt/zz-cfghome/doflow';
/** No projected body may hold any of these. */
const PLANTED = [P_SECRET, P_EMAIL, P_IP, P_URL_PASS, 'bob:', 'fxperson', 'otherperson', 'zz-proj-root', 'zz-main', 'zz-cfghome', MARKER];
const PLANTED_TEXT = `k ${P_SECRET} m ${P_EMAIL} i ${P_IP} u ${P_URL} h ${P_HOME}/code o ${P_OTHER_HOME}/x r ${P_ROOT}/a l ${P_LAYERS}/s c ${P_CFG}/y`;
const PLACED_TEXT = 'k <masked> m <email> i <ip> u https://<masked>@example.invalid/x h ~/code o /Users/<masked>/x r <project>/a l <project layers>/s c <config home>/y';
/** For the 128-byte field: placed, it fits. */
const PLANTED_SHORT = `${P_SECRET} ${P_EMAIL} ${P_ROOT}/a`;
/**
 * For the reads whose body names no layers or config home (config-schema, advise-report): only the
 * server's anchors apply there (IC-006), so the planted text names the project root and homes only.
 */
const PLANTED_BASE = `k ${P_SECRET} m ${P_EMAIL} i ${P_IP} u ${P_URL} h ${P_HOME}/code o ${P_OTHER_HOME}/x r ${P_ROOT}/a`;
const PLACED_BASE = 'k <masked> m <email> i <ip> u https://<masked>@example.invalid/x h ~/code o /Users/<masked>/x r <project>/a';
/** The server's base anchors (IC-006): the runner's project root and the home folder. The body adds the config home and the layers. */
const ANCHORS = anchorsOf({ projectRoot: P_ROOT, home: P_HOME });
const CTX = { anchors: ANCHORS, exit: 0 };
/** A text over its cap starts with this; no part of it may reach a body (D12). */
const LONG_HEAD = 'Q7long-head-planted';
const overCap = (cap: number) => `${LONG_HEAD} ${'x'.repeat(cap)}`;

const absent = (body: unknown) => PLANTED.filter((value) => JSON.stringify(body).includes(value));

function meta151(over: Record<string, unknown> = {}) {
  return { type: 'enum', values: ['off', 'on'], order: ['off', 'on'], default: 'on', scope: 'project-overridable', combine: 'override', securityRelevant: false,
    env: { name: 'DOFLOW_PRUNE', parse: 'off-words', direction: 'narrow' }, flag: `--${MARKER}`, shellRead: MARKER, views: ['project', 'global'], needsConfigHome: false, description: PLANTED_TEXT, ...over };
}
function candidate151(over: Record<string, unknown> = {}) {
  return { layer: 'user', source: `${P_CFG}/settings.json`, legacy: false, checkout: null, display: PLANTED_TEXT, value: `${MARKER} ${P_SECRET}`, status: 'overridden',
    reason: PLANTED_TEXT, code: 'retired', ...over };
}
function resolution151(key: string, view: string, over: Record<string, unknown> = {}) {
  return { key, view, value: 'on', state: 'ok', explicit: true,
    origin: { layer: 'project', source: `${P_LAYERS}/settings.json`, legacy: false, checkout: 'main', via: null },
    candidates: [candidate151({ layer: 'project', source: `${P_LAYERS}/settings.json`, status: 'decided', reason: null, code: null, display: '"on"' }), candidate151()],
    meta: meta151(), ...over };
}

/** `config list --json` as src/runtime/settings/cli.ts:209 prints it, every text and path field planted. */
function configListBody(): any {
  return {
    schema: 1, scope: 'project',
    configHome: { dir: P_CFG, ignored: [`${P_HOME}/${MARKER}`] },
    project: { root: P_ROOT, layersFrom: P_LAYERS, checkout: 'main' },
    files: [
      { layer: 'user', path: `${P_CFG}/settings.json`, kind: 'settings', legacyKind: null, checkout: null, status: 'ok', code: null, offset: null },
      { layer: 'project', path: `${P_LAYERS}/settings.json`, kind: 'settings', legacyKind: null, checkout: 'main', status: 'invalid', code: 'unparseable', offset: 12 },
      { layer: 'local', path: `${P_ROOT}/.doflow/settings.local.json`, kind: 'settings', legacyKind: null, checkout: 'own', status: 'absent', code: null, offset: null },
      { layer: 'user', path: `${P_HOME}/legacy/${P_SECRET}`, kind: 'legacy', legacyKind: 'decision-model', checkout: null, status: 'absent', code: null, offset: null },
      { layer: 'user', path: `${P_OTHER_HOME}/x/${P_EMAIL}`, kind: 'legacy', legacyKind: 'sentinel', checkout: null, status: 'invalid', code: 'not-file', offset: null },
      { layer: 'project', path: P_URL, kind: 'legacy', legacyKind: 'line-onoff', checkout: null, status: 'absent', code: null, offset: null },
    ],
    keys: {
      'advice.enabled': resolution151('advice.enabled', 'project', {
        value: false, origin: { layer: 'default', source: null, legacy: false, checkout: null, via: 'fail-safe' }, candidates: [],
        meta: meta151({ type: 'boolean', values: null, order: [false, true], default: false, scope: 'narrow-only', securityRelevant: true, env: null }) }),
      'advice.endpoint': resolution151('advice.endpoint', 'project', { value: PLANTED_TEXT, meta: meta151({ type: 'url', values: null, default: P_URL, env: null }) }),
      'storage.prune': {
        project: resolution151('storage.prune', 'project'),
        global: resolution151('storage.prune', 'global', {
          origin: { layer: 'user', source: `${P_IP}/prune`, legacy: true, checkout: null, via: null },
          candidates: [candidate151({ layer: 'user', source: `${P_CFG}/prune`, legacy: true, status: 'decided', reason: null, code: null, display: 'on' })] }),
      },
      'workers.models': resolution151('workers.models', 'project', {
        value: { claude: ['light', 'standard'], [P_EMAIL]: 'x' }, meta: meta151({ type: 'worker-list', values: null, default: [] }) }),
    },
    errors: [
      { key: 'advice.endpoint', layer: 'project', source: `${P_LAYERS}/settings.json`, legacy: false, code: 'unparseable', reason: PLANTED_TEXT, offset: 12 },
      { key: null, layer: 'local', source: `${P_ROOT}/${P_IP}/s.json`, legacy: false, code: 'cross-key', reason: PLANTED_TEXT, offset: null },
    ],
    notes: [
      { code: 'unknown-key', key: 'not.a-setting', source: `${P_CFG}/settings.json`, text: `"not.a-setting" is not a DoFlow setting (ignored) ${PLANTED_TEXT}` },
      { code: 'unknown-key', key: P_EMAIL, source: `${P_ROOT}/${P_EMAIL}.json`, text: PLANTED_TEXT },
      { code: 'scope', field: 'advice.enabled', source: `${P_LAYERS}/decision-model.json`, text: PLANTED_TEXT },
      { code: 'scope', field: 'enabled', source: `${P_LAYERS}/decision-model.json`, text: PLANTED_TEXT },
    ],
  };
}

/** `config schema --json` as src/runtime/settings/config-write.ts:198 builds it, with presets, writable and locked planted. */
function configSchemaBody(): any {
  const key = (k: string, over: Record<string, unknown>) => ({ key: k, type: 'integer', values: null, order: null, tiers: null, min: null, max: null, maxItems: null, maxLength: null,
    default: 2, scope: 'project-overridable', combine: 'override', description: PLANTED_BASE, securityRelevant: false, writable: true, locked: false, ...over });
  return {
    schema: 1,
    keys: [
      key('review.rounds', { min: 1, max: 3 }),
      key('workers.models', { type: 'worker-list', tiers: ['light', 'standard', 'frontier'], maxItems: 4, default: [], securityRelevant: true, writable: false }),
      key('advice.endpoint', { type: 'url', maxLength: 2048, min: -1.5, default: P_URL }),
    ],
    invariants: [
      { id: 'INV-1', key: 'invariant.INV-1', locked: true, writable: false, statement: PLANTED_BASE, enforcedBy: PLANTED_SHORT, authorKinds: [MARKER] },
      { id: 'INV-2', key: 'invariant.INV-2', locked: true, writable: false, statement: 'Seats are read-only', enforcedBy: 'review --action check' },
    ],
    presets: [{ id: 'deep', kind: 'review', depth: 'deep', seats: 3, rounds: 2, summary: `3 seats ${MARKER}` }],
  };
}

const pctl = (n: number, p50: number | null, p90: number | null, p95: number | null) => ({ n, p50, p90, p95 });
/** `advise --action report --json` as src/runtime/advice/report.ts:210 builds it. */
function adviseReportBody(): any {
  const empty = { n: { picks: 0, misses: 0 }, missesByReason: {}, agreeStatic: null, agreeOutcome: null, elevated: null, modes: null, durationMs: null, missDurationMs: null };
  const arm = { picks: 1, top1Changed: { n: 1, changed: 0 }, meanRankDisplacement: { n: 1, mean: 0.5 } };
  return {
    schema: 1, scope: `this project only ${MARKER}`,
    window: { from: '2026-08-11', to: '2026-11-09', maxAgeDays: 90 },
    unreadable: 2,
    kinds: {
      tier: { n: { picks: 8, misses: 4 }, missesByReason: { timeout: 1, [P_EMAIL]: 1, 'bad reason': 1, [P_SECRET]: 1 }, agreeStatic: { n: 8, agree: 7 }, agreeOutcome: { n: 2, agree: 1 },
        elevated: 0, modes: { shadow: 6, act: 1, unrecorded: 1 }, durationMs: pctl(8, 3239, 4764, 4764), missDurationMs: pctl(0, null, null, null) },
      'task-class': empty,
      adhoc: { ...empty, missesByReason: { 'provider-error': 2 } },
    },
    rerank: {
      n: { picks: 1, misses: 0 }, withoutPayload: 0, missesByReason: {}, top1Changed: { n: 1, changed: 0 }, meanRankDisplacement: { n: 1, mean: 0.5 },
      firstStageMs: { n: 1, p50: 12, p95: 12 }, arms: { choice: arm, ladder: { ...arm, picks: 0, meanRankDisplacement: null } },
      criteria: { source: 'registry', digest: '9939ded87e67', warning: PLANTED_BASE, recorded: { n: 1, bySource: { registry: 1, settings: 0, unrecorded: 0 }, digests: { abcdefabcdef: 1, [MARKER]: 1 } } },
      wouldDrop: { picks: 0, candidates: 0, illustrative: true, thresholds: [{ field: 'confidenceBelow', value: 0.5, wouldDrop: 0, ofCandidates: 0, top1WouldDrop: 0, ofPicks: 0 }] },
    },
    claimSupport: {
      n: { picks: 2, misses: 1 }, withoutPayload: 1, missesByReason: { [`${MARKER} x`]: 1 },
      byRelation: { supports: { n: 1, modelYes: 1, agree: 1 }, contradicts: { n: 0, modelYes: 0, agree: 0 } }, durationMs: { n: 2, p50: 10, p95: 20 },
    },
    verdicts: [
      { kind: 'tier', model: 'qwen3:8b', arm: null, result: 'pass', stale: true, reason: PLANTED_BASE },
      { kind: 'rerank', model: `${P_HOME}/model`, arm: 'ladder', result: null, stale: false, reason: null },
    ],
  };
}

/** Every UTC date from `from` to `to`, oldest first. */
function dates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

/** `doflow advice-picks --json` (IC-001), records planted with the fields the verb never prints. */
function advicePicksBody(): any {
  const days = dates('2026-08-11', '2026-11-09').map((day) => ({ day, coverage: 'read', unreadableLines: 0, picks: {} as Record<string, number> }));
  days[90].picks = { tier: 2, adhoc: 1 };
  days[89] = { ...days[89], coverage: 'unknown', unreadableLines: 3 };
  return {
    v: 1, window: { from: '2026-08-11', to: '2026-11-09', maxAgeDays: 90 }, kind: null,
    kinds: ['tier', 'task-class', 'adhoc'], stores: { 'project-state': 'read', 'user-state': 'absent' },
    days,
    picks: [
      { pickId: 'adv-1794210024568-a934bb', kind: 'tier', at: '2026-11-09T07:40:28.685Z', mode: 'shadow', pick: 'standard', static: 'standard', agree: true,
        outcome: { actual: 'frontier', at: '2026-11-09T08:00:00.000Z', agree: false, source: MARKER }, question: `${MARKER} ${P_SECRET}`, instructions: MARKER, probabilities: { a: 1 } },
      { pickId: null, kind: 'adhoc', at: '2026-11-09T07:00:00.000Z', mode: 'unrecorded', pick: '(withheld)', static: null, agree: null, outcome: null, options: [MARKER] },
      { pickId: 'adv-1794208991309-929547', kind: 'tier', at: '2026-11-09T06:00:00.000Z', mode: 'act', pick: 'light', static: '(withheld)', agree: null, outcome: null },
    ],
    limits: { shown: 3, notShown: 4, skipped: 1 },
  };
}

test('151: the six management closed sets match their core sources', () => {
  const read = (file: string) => fs.readFileSync(path.join(CORE_SRC, file), 'utf8');
  /** The quoted members of `type <name> = ...;`, in source order (`null` is not quoted). */
  const typeUnion = (text: string, name: string) => {
    const match = text.match(new RegExp(`^type ${name} = ([^;]*);`, 'm'));
    if (!match) throw new assert.AssertionError({ message: `type ${name} not found` });
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  const resolve = read('settings/resolve.ts');
  assert.deepEqual([...LAYERS], typeUnion(resolve, 'Layer'));
  assert.deepEqual([...CANDIDATE_STATUSES], typeUnion(resolve, 'Status'));
  assert.deepEqual([...VIA], typeUnion(resolve, 'Via'));
  assert.deepEqual([...FILE_CODES], typeUnion(read('settings/files.ts'), 'LayerCode'));
  const registry = JSON.parse(fs.readFileSync(path.join(CORE_SRC, '..', '..', 'core', 'registry', 'settings.json'), 'utf8'));
  assert.deepEqual([...SCOPES].sort(), [...new Set(Object.values(registry.keys).map((spec: any) => spec.scope))].sort());
  // ADVICE_MODES: the modes tally of kindFigures (src/runtime/advice/report.ts:50 to :54).
  const modes = read('advice/report.ts').match(/const modes = \{([^}]*)\};/);
  assert.ok(modes);
  assert.deepEqual([...ADVICE_MODES], [...modes[1].matchAll(/([a-z]+): 0/g)].map((m) => m[1]));
  for (const set of [LAYERS, CANDIDATE_STATUSES, VIA, FILE_CODES, SCOPES, ADVICE_MODES]) assert.ok(Object.isFrozen(set));
});

test('151 config-list: the IC-007 fields only; every text and path planted, none in the body; anchors absent', () => {
  const result = project('config-list', configListBody(), CTX);
  assert.equal(result.ok, true, JSON.stringify(result));
  const body = result.body;
  assert.deepEqual(absent(body), [], 'no planted value');
  assert.deepEqual(Object.keys(body), ['v', 'failSafe', 'scope', 'checkout', 'files', 'keys', 'errors', 'notes']);
  assert.equal(body.v, 1);
  assert.equal(body.failSafe, false);
  assert.equal(body.scope, 'project');
  assert.equal(body.checkout, 'main');
  // The three anchor fields are never output, under any name.
  const paths = keyPaths(body);
  for (const name of ['root', 'layersFrom', 'configHome', 'dir', 'ignored', 'path', 'source']) assert.ok(!paths.some((p) => p.split(/[.[\]]+/).includes(name)), name);

  assert.deepEqual(body.files.map((f: any) => f.where), [
    { anchor: 'config-home', rel: 'settings.json' },
    { anchor: 'project-layers', rel: 'settings.json' },
    { anchor: 'project', rel: '.doflow/settings.local.json' },
    { anchor: 'home', rel: WITHHELD },
    { anchor: 'other', rel: WITHHELD },
    { anchor: 'other', rel: 'x' },
  ]);
  assert.deepEqual(Object.keys(body.files[1]), ['layer', 'kind', 'legacyKind', 'checkout', 'status', 'code', 'offset', 'where']);
  assert.deepEqual({ ...body.files[1], where: null }, { layer: 'project', kind: 'settings', legacyKind: null, checkout: 'main', status: 'invalid', code: 'unparseable', offset: 12, where: null });

  // Registry order; one view per key, two for the dual storage.prune.
  assert.deepEqual(body.keys.map((k: any) => [k.key, k.views.map((v: any) => v.view)]),
    [['advice.enabled', ['project']], ['advice.endpoint', ['project']], ['storage.prune', ['project', 'global']], ['workers.models', ['project']]]);
  const prune = body.keys[2];
  assert.deepEqual(Object.keys(prune), ['key', 'views', 'meta']);
  assert.deepEqual(Object.keys(prune.views[0]), ['view', 'value', 'state', 'explicit', 'origin', 'candidates']);
  assert.deepEqual(prune.views[0].origin, { layer: 'project', where: { anchor: 'project-layers', rel: 'settings.json' }, legacy: false, checkout: 'main', via: null });
  // A relative source the mask would change is not a project path: only its last segment is kept.
  assert.deepEqual(prune.views[1].origin, { layer: 'user', where: { anchor: 'other', rel: 'prune' }, legacy: true, checkout: null, via: null });
  assert.deepEqual(prune.views[1].candidates, [{ layer: 'user', where: { anchor: 'config-home', rel: 'prune' }, legacy: true, checkout: null, display: 'on', status: 'decided', reason: null, code: null }]);
  const overridden = prune.views[0].candidates[1];
  assert.deepEqual(Object.keys(overridden), ['layer', 'where', 'legacy', 'checkout', 'display', 'status', 'reason', 'code']);
  assert.equal(overridden.display, PLACED_TEXT);
  assert.equal(overridden.reason, PLACED_TEXT);
  assert.deepEqual(Object.keys(prune.meta), ['type', 'values', 'default', 'scope', 'securityRelevant', 'env', 'description']);
  assert.deepEqual(prune.meta, { type: 'enum', values: ['off', 'on'], default: 'on', scope: 'project-overridable', securityRelevant: false, env: 'DOFLOW_PRUNE', description: PLACED_TEXT });

  const enabled = body.keys[0];
  assert.deepEqual(enabled.views[0].origin, { layer: 'default', where: null, legacy: false, checkout: null, via: 'fail-safe' });
  assert.deepEqual(enabled.meta, { type: 'boolean', values: null, default: false, scope: 'narrow-only', securityRelevant: true, env: null, description: PLACED_TEXT });
  assert.equal(body.keys[1].views[0].value, PLACED_TEXT);
  assert.equal(body.keys[1].meta.default, 'https://<masked>@example.invalid/x');
  // An object value whose key is not a JSON key name is withheld whole.
  assert.equal(body.keys[3].views[0].value, WITHHELD);

  assert.deepEqual(body.errors, [
    { key: 'advice.endpoint', layer: 'project', where: { anchor: 'project-layers', rel: 'settings.json' }, code: 'unparseable', reason: PLACED_TEXT },
    { key: null, layer: 'local', where: { anchor: 'project', rel: WITHHELD }, code: 'cross-key', reason: PLACED_TEXT },
  ]);
  assert.deepEqual(body.notes, [
    { code: 'unknown-key', key: 'not.a-setting', where: { anchor: 'config-home', rel: 'settings.json' }, text: `"not.a-setting" is not a DoFlow setting (ignored) ${PLACED_TEXT}` },
    { code: 'unknown-key', key: null, where: { anchor: 'project', rel: WITHHELD }, text: PLACED_TEXT },
    { code: 'scope', key: 'advice.enabled', where: { anchor: 'project-layers', rel: 'decision-model.json' }, text: PLACED_TEXT },
    { code: 'scope', key: null, where: { anchor: 'project-layers', rel: 'decision-model.json' }, text: PLACED_TEXT },
  ]);

  // A note may name no file (SettingsNote.source is string | null, src/runtime/settings/resolve.ts:74).
  const sourceless = configListBody();
  sourceless.notes[0].source = null;
  assert.equal(project('config-list', sourceless, CTX).body.notes[0].where, null);

  // Control: the anchors the body adds are what keep the layers and the config home out of free text.
  const baseOnly = placeText(PLANTED_TEXT, ANCHORS);
  assert.ok(baseOnly.includes('zz-main') && baseOnly.includes('zz-cfghome'), 'the server anchors alone do not cover the body\'s own folders');
});

test('151 config-list: failSafe is context.exit === 1, and the body is data either way', () => {
  assert.equal(project('config-list', configListBody(), { anchors: ANCHORS, exit: 1 }).body.failSafe, true);
  assert.equal(project('config-list', configListBody(), { anchors: ANCHORS, exit: 0 }).body.failSafe, false);
  assert.equal(project('config-list', configListBody(), { anchors: ANCHORS }).body.failSafe, false);
  assert.throws(() => project('config-list', configListBody(), { exit: 0 }), /anchors/, 'a caller that passes no anchors is a defect, never a body with raw paths');
});

test('151 config-list: a global (-g) load with no project root, layers or config home', () => {
  const raw = configListBody();
  raw.scope = 'global';
  raw.configHome = { dir: null, ignored: [] };
  raw.project = { root: null, layersFrom: null, checkout: null };
  raw.keys = { 'storage.prune': resolution151('storage.prune', 'global') };
  const body = project('config-list', raw, CTX).body;
  assert.equal(body.scope, 'global');
  assert.equal(body.checkout, null);
  assert.deepEqual(body.keys[0].views.map((v: any) => v.view), ['global']);
  // With no layers or config home in the body there is no anchor for them: free text naming them keeps them
  // (only the project root and home anchors apply), and every path field keeps its last segment only.
  assert.deepEqual(absent(body).filter((v) => v !== 'zz-main' && v !== 'zz-cfghome'), []);
  assert.ok(!JSON.stringify(body.files).includes('zz-'), 'no folder of a path field');
});

test('151 config-list: settingKey accepts every key of core/registry/settings.json', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(CORE_SRC, '..', '..', 'core', 'registry', 'settings.json'), 'utf8'));
  const names = Object.keys(registry.keys);
  assert.equal(names.length, 47);
  const raw = configListBody();
  raw.keys = Object.fromEntries(names.map((name) => [name, resolution151(name, 'project')]));
  const result = project('config-list', raw, CTX);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.body.keys.map((k: any) => k.key), names);
  for (const bad of ['Advice.enabled', 'advice', 'advice..x', `a.${'b'.repeat(95)}`, 'a.b.c.d.e.f.g.h.i', 'a_b.c']) {
    const r = configListBody();
    r.keys = { [bad]: resolution151(bad, 'project') };
    assert.deepEqual(project('config-list', r, CTX), MISMATCH, bad);
  }
});

test('151 config-list: jsonValue keeps values within its bounds and reads (withheld) past each one', () => {
  const valueOf = (value: unknown) => {
    const raw = configListBody();
    raw.keys = { 'workers.models': resolution151('workers.models', 'project', { value }) };
    const result = project('config-list', raw, CTX);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.body.keys[0].views[0].value;
  };
  const list = (n: number) => Array.from({ length: n }, (_, i) => i);
  const object = (n: number) => Object.fromEntries(list(n).map((i) => [`k${i}`, i]));
  assert.deepEqual(valueOf(null), null);
  assert.deepEqual(valueOf(true), true);
  assert.deepEqual(valueOf(-2.5), -2.5);
  assert.deepEqual(valueOf(list(64)), list(64));
  assert.deepEqual(valueOf(list(65)), WITHHELD, 'an array of 65 items');
  assert.deepEqual(valueOf(object(64)), object(64));
  assert.deepEqual(valueOf(object(65)), WITHHELD, 'an object of 65 keys');
  assert.deepEqual(valueOf({ 'a b': 1 }), WITHHELD, 'a key outside the JSON key pattern');
  assert.deepEqual(valueOf({ [`k${'x'.repeat(64)}`]: 1 }), WITHHELD, 'a key of 65 characters');
  assert.deepEqual(valueOf({ 'claude:model.v2-x': ['light'] }), { 'claude:model.v2-x': ['light'] });
  assert.deepEqual(valueOf([[[[1]]]]), [[[[1]]]], 'nested 4 deep');
  assert.deepEqual(valueOf([[[[[1]]]]]), [[[[WITHHELD]]]], 'nested 5 deep: the fifth level is withheld in its place');
  assert.deepEqual(valueOf({ a: { b: { c: { d: 1 } } } }), { a: { b: { c: { d: 1 } } } }, 'objects nested 4 deep');
  assert.deepEqual(valueOf({ a: { b: { c: { d: { e: 1 } } } } }), { a: { b: { c: { d: WITHHELD } } } }, 'objects nested 5 deep');
  assert.deepEqual(valueOf('a'.repeat(2048)), 'a'.repeat(2048));
  assert.deepEqual(valueOf(overCap(2048)), TOO_LONG, 'a string over 2048 bytes is withheld whole');
  assert.deepEqual(valueOf([PLANTED_TEXT]), [PLACED_TEXT]);
  assert.deepEqual(valueOf({ key: P_URL }), { key: 'https://<masked>@example.invalid/x' });
  // A value the core never prints (no value) is a missing field.
  const raw = configListBody();
  delete raw.keys['advice.endpoint'].value;
  assert.deepEqual(project('config-list', raw, CTX), MISMATCH);
});

test('151: a text over its cap is withheld whole, with no prefix of it in the body (D12)', () => {
  const cases: Array<[string, string, number, (raw: any, text: string) => void, (body: any) => unknown]> = [
    ['config-list', 'display', 256, (r, t) => { r.keys['storage.prune'].project.candidates[1].display = t; }, (b) => b.keys[2].views[0].candidates[1].display],
    ['config-list', 'candidate reason', 512, (r, t) => { r.keys['storage.prune'].project.candidates[1].reason = t; }, (b) => b.keys[2].views[0].candidates[1].reason],
    ['config-list', 'description', 1024, (r, t) => { r.keys['storage.prune'].project.meta.description = t; }, (b) => b.keys[2].meta.description],
    ['config-list', 'error reason', 512, (r, t) => { r.errors[0].reason = t; }, (b) => b.errors[0].reason],
    ['config-list', 'note text', 512, (r, t) => { r.notes[0].text = t; }, (b) => b.notes[0].text],
    ['config-schema', 'statement', 512, (r, t) => { r.invariants[0].statement = t; }, (b) => b.invariants[0].statement],
    ['config-schema', 'enforcedBy', 128, (r, t) => { r.invariants[0].enforcedBy = t; }, (b) => b.invariants[0].enforcedBy],
    ['advise-report', 'criteria warning', 512, (r, t) => { r.rerank.criteria.warning = t; }, (b) => b.rerank.criteria.warning],
    ['advise-report', 'verdict reason', 256, (r, t) => { r.verdicts[0].reason = t; }, (b) => b.verdicts[0].reason],
  ];
  const bodies: Record<string, () => any> = { 'config-list': configListBody, 'config-schema': configSchemaBody, 'advise-report': adviseReportBody };
  for (const [shape, field, cap, plant, read] of cases) {
    const at = bodies[shape]();
    plant(at, 'y'.repeat(cap));
    assert.equal(read(project(shape, at, CTX).body), 'y'.repeat(cap), `${field} at its cap`);
    const over = bodies[shape]();
    plant(over, overCap(cap));
    const body = project(shape, over, CTX).body;
    assert.equal(read(body), TOO_LONG, `${field} over its cap`);
    assert.ok(!JSON.stringify(body).includes(LONG_HEAD.slice(0, 6)), `${field}: no prefix of the planted value`);
    // Placement counts: a text that fits only before its anchors are replaced is judged on the placed result.
    const placed = bodies[shape]();
    plant(placed, `${P_ROOT}/${'z'.repeat(cap - '<project>/'.length)}`);
    assert.equal(read(project(shape, placed, CTX).body), `<project>/${'z'.repeat(cap - '<project>/'.length)}`, `${field} placed at its cap`);
  }
});

test('151 config-schema: ranges and invariants only; presets, writable and locked dropped', () => {
  const result = project('config-schema', configSchemaBody(), CTX);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.body, {
    v: 1,
    ranges: [
      { key: 'review.rounds', min: 1, max: 3, maxItems: null, maxLength: null, tiers: null },
      { key: 'workers.models', min: null, max: null, maxItems: 4, maxLength: null, tiers: ['light', 'standard', 'frontier'] },
      { key: 'advice.endpoint', min: -1.5, max: null, maxItems: null, maxLength: 2048, tiers: null },
    ],
    invariants: [
      { id: 'INV-1', statement: PLACED_BASE, enforcedBy: '<masked> <email> <project>/a' },
      { id: 'INV-2', statement: 'Seats are read-only', enforcedBy: 'review --action check' },
    ],
  });
  const text = JSON.stringify(result.body);
  for (const dropped of ['presets', 'writable', 'locked', 'summary', 'authorKinds', 'description', 'default', 'scope']) assert.ok(!text.includes(`"${dropped}"`), dropped);
  assert.deepEqual(absent(result.body), []);
});

test('151 advise-report: IC-008 fields; non-id reasons folded to (other); recorded.digests dropped; planted texts absent', () => {
  const result = project('advise-report', adviseReportBody(), CTX);
  assert.equal(result.ok, true, JSON.stringify(result));
  const body = result.body;
  assert.deepEqual(absent(body), []);
  assert.deepEqual(Object.keys(body), ['v', 'schema', 'window', 'unreadable', 'kinds', 'rerank', 'claimSupport', 'verdicts']);
  assert.deepEqual([body.v, body.schema, body.window, body.unreadable], [1, 1, { from: '2026-08-11', to: '2026-11-09', maxAgeDays: 90 }, 2]);
  assert.deepEqual(body.kinds.map((k: any) => k.kind), ['tier', 'task-class', 'adhoc']);
  assert.deepEqual(body.kinds[0], {
    kind: 'tier', n: { picks: 8, misses: 4 }, missesByReason: [{ reason: 'timeout', n: 1 }, { reason: '(other)', n: 3 }],
    agreeStatic: { n: 8, agree: 7 }, agreeOutcome: { n: 2, agree: 1 }, elevated: 0, modes: { shadow: 6, act: 1, unrecorded: 1 },
    durationMs: pctl(8, 3239, 4764, 4764), missDurationMs: pctl(0, null, null, null),
  });
  assert.deepEqual(body.kinds[1], { kind: 'task-class', n: { picks: 0, misses: 0 }, missesByReason: [], agreeStatic: null, agreeOutcome: null, elevated: null, modes: null, durationMs: null, missDurationMs: null });
  assert.deepEqual(body.kinds[2].missesByReason, [{ reason: 'provider-error', n: 2 }]);
  assert.deepEqual(body.rerank.criteria, { source: 'registry', digest: '9939ded87e67', warning: PLACED_BASE, recorded: { n: 1, bySource: { registry: 1, settings: 0, unrecorded: 0 } } });
  assert.deepEqual(body.rerank.firstStageMs, { n: 1, p50: 12, p95: 12 });
  assert.deepEqual(body.rerank.arms.ladder, { picks: 0, top1Changed: { n: 1, changed: 0 }, meanRankDisplacement: null });
  assert.deepEqual(body.rerank.wouldDrop, { picks: 0, candidates: 0, thresholds: [{ field: 'confidenceBelow', value: 0.5, wouldDrop: 0, ofCandidates: 0, top1WouldDrop: 0, ofPicks: 0 }] });
  assert.deepEqual(body.claimSupport, {
    n: { picks: 2, misses: 1 }, withoutPayload: 1, missesByReason: [{ reason: '(other)', n: 1 }],
    byRelation: { supports: { n: 1, modelYes: 1, agree: 1 }, contradicts: { n: 0, modelYes: 0, agree: 0 } }, durationMs: { n: 2, p50: 10, p95: 20 },
  });
  assert.deepEqual(body.verdicts, [
    { kind: 'tier', model: 'qwen3:8b', arm: null, result: 'pass', stale: true, reason: PLACED_BASE },
    { kind: 'rerank', model: WITHHELD, arm: 'ladder', result: null, stale: false, reason: null },
  ]);
  const text = JSON.stringify(body);
  for (const dropped of ['digests', 'abcdefabcdef', 'illustrative', 'scope']) assert.ok(!text.includes(dropped), dropped);
  // A report without the rerank and claim-support blocks (neither kind shown) reads them as null.
  const narrow = adviseReportBody();
  delete narrow.rerank;
  delete narrow.claimSupport;
  const n = project('advise-report', narrow, CTX).body;
  assert.equal(n.rerank, null);
  assert.equal(n.claimSupport, null);
});

test('151 advice-picks: every IC-001 field checked; planted record fields absent', () => {
  const result = project('advice-picks', advicePicksBody(), CTX);
  assert.equal(result.ok, true, JSON.stringify(result));
  const body = result.body;
  assert.deepEqual(absent(body), []);
  assert.deepEqual(Object.keys(body), ['v', 'window', 'kind', 'kinds', 'stores', 'days', 'picks', 'limits']);
  assert.equal(body.days.length, 91);
  assert.deepEqual(body.days[89], { day: '2026-11-08', coverage: 'unknown', unreadableLines: 3, picks: {} });
  assert.deepEqual(body.days[90], { day: '2026-11-09', coverage: 'read', unreadableLines: 0, picks: { tier: 2, adhoc: 1 } });
  assert.deepEqual(body.picks[0], { pickId: 'adv-1794210024568-a934bb', kind: 'tier', at: '2026-11-09T07:40:28.685Z', mode: 'shadow', pick: 'standard', static: 'standard', agree: true,
    outcome: { actual: 'frontier', at: '2026-11-09T08:00:00.000Z', agree: false } });
  assert.deepEqual(body.picks[1], { pickId: null, kind: 'adhoc', at: '2026-11-09T07:00:00.000Z', mode: 'unrecorded', pick: WITHHELD, static: null, agree: null, outcome: null });
  assert.deepEqual(body.limits, { shown: 3, notShown: 4, skipped: 1 });
  for (const dropped of ['question', 'instructions', 'probabilities', 'options', 'source']) assert.ok(!JSON.stringify(body).includes(`"${dropped}"`), dropped);
  const one = advicePicksBody();
  one.kind = 'tier';
  one.kinds = ['tier'];
  assert.equal(project('advice-picks', one, CTX).body.kind, 'tier');
  // A value of the ANSWER form that the second mask pass would change (a token) is withheld in its place, as a label is.
  const token = advicePicksBody();
  token.picks[0].static = P_SECRET;
  token.picks[0].outcome.actual = P_SECRET;
  const masked = project('advice-picks', token, CTX).body;
  assert.equal(masked.picks[0].static, WITHHELD);
  assert.equal(masked.picks[0].outcome.actual, WITHHELD);
  assert.deepEqual(absent(masked), []);
  // A one-day window is exactly one day.
  const short = advicePicksBody();
  short.window = { from: '2026-11-09', to: '2026-11-09', maxAgeDays: 0 };
  short.days = [short.days[90]];
  assert.equal(project('advice-picks', short, CTX).ok, true);
});

const MUTATIONS_151: Record<string, [() => any, Array<[string, (raw: any) => void]>]> = {
  'config-list': [configListBody, [
    ['schema not 1', (r) => { r.schema = 2; }],
    ['scope unknown', (r) => { r.scope = 'local'; }],
    ['configHome missing', (r) => { delete r.configHome; }],
    ['configHome.dir a number', (r) => { r.configHome.dir = 1; }],
    ['project missing', (r) => { delete r.project; }],
    ['project.root missing', (r) => { delete r.project.root; }],
    ['project.layersFrom a number', (r) => { r.project.layersFrom = 7; }],
    ['checkout not an id', (r) => { r.project.checkout = 'a b'; }],
    ['files missing', (r) => { delete r.files; }],
    ['file layer unknown', (r) => { r.files[0].layer = 'system'; }],
    ['file kind unknown', (r) => { r.files[0].kind = 'other'; }],
    ['file status unknown', (r) => { r.files[0].status = 'broken'; }],
    ['file code unknown', (r) => { r.files[1].code = 'bad'; }],
    ['file offset negative', (r) => { r.files[1].offset = -1; }],
    ['file path missing', (r) => { delete r.files[0].path; }],
    ['file path empty', (r) => { r.files[0].path = ''; }],
    ['keys missing', (r) => { delete r.keys; }],
    ['keys an array', (r) => { r.keys = []; }],
    ['view key differs', (r) => { r.keys['advice.enabled'].key = 'advice.endpoint'; }],
    ['view unknown', (r) => { r.keys['advice.enabled'].view = 'local'; }],
    ['dual project view says global', (r) => { r.keys['storage.prune'].project.view = 'global'; }],
    ['dual global view missing', (r) => { r.keys['storage.prune'] = { project: r.keys['storage.prune'].project }; }],
    ['state unknown', (r) => { r.keys['advice.enabled'].state = 'stale'; }],
    ['explicit a string', (r) => { r.keys['advice.enabled'].explicit = 'yes'; }],
    ['origin missing', (r) => { delete r.keys['advice.enabled'].origin; }],
    ['origin layer unknown', (r) => { r.keys['advice.enabled'].origin.layer = 'cli'; }],
    ['origin via unknown', (r) => { r.keys['advice.enabled'].origin.via = 'guess'; }],
    ['origin source a number', (r) => { r.keys['advice.enabled'].origin.source = 1; }],
    ['origin legacy missing', (r) => { delete r.keys['advice.enabled'].origin.legacy; }],
    ['candidates missing', (r) => { delete r.keys['advice.endpoint'].candidates; }],
    ['candidate status unknown', (r) => { r.keys['advice.endpoint'].candidates[0].status = 'won'; }],
    ['candidate source missing', (r) => { delete r.keys['advice.endpoint'].candidates[0].source; }],
    ['candidate display a number', (r) => { r.keys['advice.endpoint'].candidates[0].display = 1; }],
    ['candidate reason a number', (r) => { r.keys['advice.endpoint'].candidates[1].reason = 5; }],
    ['candidate code not an id', (r) => { r.keys['advice.endpoint'].candidates[1].code = `x ${MARKER}`; }],
    ['meta missing', (r) => { delete r.keys['advice.enabled'].meta; }],
    ['meta scope unknown', (r) => { r.keys['advice.enabled'].meta.scope = 'project-only'; }],
    ['meta securityRelevant a string', (r) => { r.keys['advice.enabled'].meta.securityRelevant = 'true'; }],
    ['meta env not a DOFLOW_ name', (r) => { r.keys['advice.enabled'].meta.env = { name: 'HOME', parse: 'verbatim', direction: 'any' }; }],
    ['meta env a bare name, not {name, parse, direction}', (r) => { r.keys['advice.enabled'].meta.env = 'DOFLOW_ADVICE_ENABLED'; }],
    ['meta env name missing', (r) => { r.keys['advice.enabled'].meta.env = { parse: 'verbatim', direction: 'any' }; }],
    ['meta values a container', (r) => { r.keys['storage.prune'].project.meta.values = [['off']]; }],
    ['meta description missing', (r) => { delete r.keys['advice.enabled'].meta.description; }],
    ['meta type not an id', (r) => { r.keys['advice.enabled'].meta.type = 'a b'; }],
    ['errors missing', (r) => { delete r.errors; }],
    ['error key not a setting key', (r) => { r.errors[0].key = 'Bad Key'; }],
    ['error layer unknown', (r) => { r.errors[0].layer = 'cli'; }],
    ['error reason missing', (r) => { delete r.errors[0].reason; }],
    ['error code missing', (r) => { delete r.errors[0].code; }],
    ['notes missing', (r) => { delete r.notes; }],
    ['note text a number', (r) => { r.notes[0].text = 1; }],
    ['note key a number', (r) => { r.notes[0].key = 1; }],
    ['note with neither key nor field', (r) => { delete r.notes[2].field; }],
    ['note source missing', (r) => { delete r.notes[0].source; }],
    ['note source a number', (r) => { r.notes[0].source = 3; }],
    ['note source empty', (r) => { r.notes[0].source = ''; }],
  ]],
  'config-schema': [configSchemaBody, [
    ['schema missing', (r) => { delete r.schema; }],
    ['keys missing', (r) => { delete r.keys; }],
    ['range key not a setting key', (r) => { r.keys[0].key = 'Rounds'; }],
    ['min a string', (r) => { r.keys[0].min = '1'; }],
    ['max missing', (r) => { delete r.keys[0].max; }],
    ['maxItems negative', (r) => { r.keys[1].maxItems = -1; }],
    ['maxLength fractional', (r) => { r.keys[2].maxLength = 1.5; }],
    ['tiers not ids', (r) => { r.keys[1].tiers = ['a b']; }],
    ['invariants missing', (r) => { delete r.invariants; }],
    ['invariant id missing', (r) => { delete r.invariants[0].id; }],
    ['statement a number', (r) => { r.invariants[0].statement = 1; }],
    ['enforcedBy missing', (r) => { delete r.invariants[1].enforcedBy; }],
  ]],
  'advise-report': [adviseReportBody, [
    ['schema not 1', (r) => { r.schema = 2; }],
    ['window missing', (r) => { delete r.window; }],
    ['window.from not a date', (r) => { r.window.from = '2026-8-11'; }],
    ['window.to an impossible date', (r) => { r.window.to = '2026-02-30'; }],
    ['maxAgeDays a string', (r) => { r.window.maxAgeDays = '90'; }],
    ['unreadable negative', (r) => { r.unreadable = -1; }],
    ['kinds an array', (r) => { r.kinds = []; }],
    ['kind name not an advice kind', (r) => { r.kinds.Tier = r.kinds.tier; }],
    ['n.misses missing', (r) => { delete r.kinds.tier.n.misses; }],
    ['missesByReason count a string', (r) => { r.kinds.tier.missesByReason.timeout = '1'; }],
    ['agreeStatic.agree missing', (r) => { delete r.kinds.tier.agreeStatic.agree; }],
    ['modes.act missing', (r) => { delete r.kinds.tier.modes.act; }],
    ['durationMs.p90 missing on a kind', (r) => { delete r.kinds.tier.durationMs.p90; }],
    ['durationMs.p50 negative', (r) => { r.kinds.tier.durationMs.p50 = -1; }],
    ['elevated a string', (r) => { r.kinds.tier.elevated = '0'; }],
    ['rerank not an object', (r) => { r.rerank = 'none'; }],
    ['rerank arms.choice missing', (r) => { delete r.rerank.arms.choice; }],
    ['rerank criteria source unknown', (r) => { r.rerank.criteria.source = 'env'; }],
    ['rerank criteria digest not 12 hex', (r) => { r.rerank.criteria.digest = 'XYZ'; }],
    ['rerank recorded.bySource missing', (r) => { delete r.rerank.criteria.recorded.bySource; }],
    ['rerank threshold field unknown', (r) => { r.rerank.wouldDrop.thresholds[0].field = 'scoreBelow'; }],
    ['rerank meanRankDisplacement.mean a string', (r) => { r.rerank.meanRankDisplacement.mean = '0.5'; }],
    ['claimSupport byRelation.contradicts missing', (r) => { delete r.claimSupport.byRelation.contradicts; }],
    ['claimSupport durationMs missing', (r) => { delete r.claimSupport.durationMs; }],
    ['verdicts missing', (r) => { delete r.verdicts; }],
    ['verdict stale missing', (r) => { delete r.verdicts[0].stale; }],
    ['verdict kind not an advice kind', (r) => { r.verdicts[0].kind = 'Tier'; }],
    ['verdict reason a number', (r) => { r.verdicts[0].reason = 3; }],
  ]],
  'advice-picks': [advicePicksBody, [
    ['v is not 1', (r) => { r.v = 2; }],
    ['window missing', (r) => { delete r.window; }],
    ['kind not an advice kind', (r) => { r.kind = 'Tier'; }],
    ['kinds not advice kinds', (r) => { r.kinds = ['tier', 'Bad']; }],
    ['stores value unknown', (r) => { r.stores['user-state'] = 'maybe'; }],
    ['stores missing', (r) => { delete r.stores; }],
    ['days missing', (r) => { delete r.days; }],
    ['days one short at the end', (r) => { r.days.pop(); }],
    ['days one short at the start', (r) => { r.days.shift(); }],
    ['days one too many', (r) => { r.days.push({ day: '2026-11-10', coverage: 'read', unreadableLines: 0, picks: {} }); }],
    ['days out of order', (r) => { [r.days[3], r.days[4]] = [r.days[4], r.days[3]]; }],
    ['days with a repeat', (r) => { r.days[5] = { ...r.days[4] }; }],
    ['days empty', (r) => { r.days = []; }],
    ['window from after to', (r) => { r.window.from = '2026-11-10'; }],
    ['day coverage unknown', (r) => { r.days[0].coverage = 'partial'; }],
    ['day unreadableLines negative', (r) => { r.days[0].unreadableLines = -1; }],
    ['day picks kind not an advice kind', (r) => { r.days[90].picks = { Tier: 1 }; }],
    ['day picks count a string', (r) => { r.days[90].picks = { tier: '2' }; }],
    ['picks missing', (r) => { delete r.picks; }],
    ['pickId malformed', (r) => { r.picks[0].pickId = 'adv-1'; }],
    ['pick kind missing', (r) => { delete r.picks[0].kind; }],
    ['pick at not ISO', (r) => { r.picks[0].at = 'today'; }],
    ['mode outside ADVICE_MODES', (r) => { r.picks[0].mode = 'live'; }],
    ['mode missing', (r) => { delete r.picks[0].mode; }],
    ['pick a planted text', (r) => { r.picks[0].pick = `${P_EMAIL} ${MARKER}`; }],
    ['pick missing', (r) => { delete r.picks[0].pick; }],
    ['static not a string or null', (r) => { r.picks[0].static = 7; }],
    ['agree a string', (r) => { r.picks[0].agree = 'yes'; }],
    ['outcome.actual a planted text', (r) => { r.picks[0].outcome.actual = `${P_HOME}/x`; }],
    ['outcome.at missing', (r) => { delete r.picks[0].outcome.at; }],
    ['outcome.agree a string', (r) => { r.picks[0].outcome.agree = 'no'; }],
    ['limits missing', (r) => { delete r.limits; }],
    ['shown is not picks.length', (r) => { r.limits.shown = 2; }],
    ['notShown negative', (r) => { r.limits.notShown = -1; }],
    ['skipped missing', (r) => { delete r.limits.skipped; }],
  ]],
};

for (const [shape, [build, cases]] of Object.entries(MUTATIONS_151)) {
  test(`151 ${shape}: a missing or mistyped required field is core-contract-mismatch with no body`, () => {
    assert.equal(project(shape, build(), CTX).ok, true, 'the unmutated body projects');
    for (const [name, mutate] of cases) {
      const raw = build();
      mutate(raw);
      assert.deepEqual(project(shape, raw, CTX), MISMATCH, name);
    }
    for (const raw of [null, [], 'text', 1]) assert.deepEqual(project(shape, raw, CTX), MISMATCH);
  });
}

test('151: a pass-through projector would leak every planted value (control)', () => {
  for (const build of [configListBody, configSchemaBody, adviseReportBody, advicePicksBody]) assert.ok(absent(build()).length > 0);
});
