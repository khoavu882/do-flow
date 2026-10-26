'use strict';

// Projection and core handshake (feature 093, IC-004 and 092 IC-013; FR-002, NFR-003). The fixtures
// under fixtures/core/ are real core outputs (list, status, attempts from the 092 probe, workflow,
// capabilities) or, where the core verb has not landed yet (timeline IC-012, attempts[] IC-013),
// bodies built to the spec. Each carries the marker below in fields the projection drops.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { project, PROJECTOR_IDS, WITHHELD, CLOSED_SETS } = require('../src/project.ts');
const { checkCoreVersion, handshake, satisfiesRange } = require('../src/handshake.ts');
const { SHAPE_IDS } = require('../src/verb-runner.ts');
const coreSemver = require('../../src/helper/semver.ts');

const MARKER = 'ZZ-MARKER-7f3';
const FIXTURES = path.join(__dirname, 'fixtures', 'core');
const CORE_SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const MISMATCH = { ok: false, code: 'core-contract-mismatch' };

const fixture = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
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
    ...['token', 'owner', 'mode', 'state', 'startedAt', 'endedAt', 'result'].map((k) => `.tasks[].attempts[].${k}`)],
  workflow: ['.taskClass', '.name', '.stages',
    ...['id', 'skill', 'agent', 'kind', 'optional', 'purpose', 'gatesAfter'].map((k) => `.stages[].${k}`),
    ...['id', 'name', 'kind', 'trigger', 'prompt'].map((k) => `.stages[].gatesAfter[].${k}`)],
  capabilities: ['.capabilities', ...['capability', 'status', 'providerId'].map((k) => `.capabilities[].${k}`)],
};

const contextFor = (shape: string) => (shape === 'status' ? { workflow: workflowBody() } : undefined);
const MARKED_SHAPES = ['list', 'status', 'timeline', 'attempts', 'workflow', 'capabilities'];

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
  ];
  for (const [shape, pick] of where) assert.ok(JSON.stringify(pick(fixture(shape))).includes(MARKER), `${shape} fixture lacks the marker`);
  assert.equal(fixture('attempts').graph.tasks[0].owner.length, 200);
  assert.deepEqual(leaks(project), []);
});

test('control: a pass-through projector leaks the marker of every fixture', () => {
  const passThrough = (_shape: string, raw: unknown) => ({ ok: true, body: raw });
  assert.deepEqual(leaks(passThrough), MARKED_SHAPES);
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
  assert.deepEqual(body.tasks[1].attempts[1], { token: 2, owner: 'worker-b', mode: 'manual', state: 'finished', startedAt: '2026-10-26T01:20:00.000Z', endedAt: '2026-10-26T02:00:00.000Z', result: 'COMPLETED' });
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
