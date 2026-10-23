'use strict';

// 119 A.4 (IC-003): `resolveProtocol`, the pure resolver for the review and debate protocol. The parity
// table pins today's depth rule (single iff light scope and a single risk; seats = max(preset, class floor));
// the expected values are written out here, never read from the code under test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadProtocols } = require('../../src/runtime/review/protocols.ts');
const { resolveProtocol, protocolLines, gateMinSeats } = require('../../src/runtime/review/resolve-protocol.ts');
const { loadPolicy } = require('../../src/runtime/roadmap/gates.ts');

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const loaded = loadProtocols({ repoRoot: REPO_ROOT });
assert.ok(loaded.ok, loaded.errors.join('; '));
const REGISTRY = loaded.registry;
const GATES = loadPolicy(read('core/registry/gates.json'), null);
assert.ok(GATES.ok);
const GATE_POLICY = GATES.policy;
const VERIFICATION = JSON.parse(read('core/registry/verification.json'));
const RISK_POLICY = VERIFICATION.reviewDepth;
const CLASSES = Object.keys(JSON.parse(read('core/registry/workflows.json')).classes);
const RISKS = Object.keys(VERIFICATION.riskLevels);

// Today's rule, hard-coded: only LOW is single, light paths are docs/, README.md and CHANGELOG.md, and only
// the feature class has a gate-b floor (2).
const SCOPES = {
  light: ['docs/a.md', 'README.md'],
  code: ['docs/a.md', 'src/x.ts'],
  unknown: [],
};
const FLOOR = { feature: 2 };

function resolve(overrides = {}) {
  return resolveProtocol({
    kind: 'review', taskClass: 'bug', risk: 'LOW', paths: SCOPES.light, runPreset: null, advicePick: null,
    settingsView: {}, gatePolicy: GATE_POLICY, registry: REGISTRY, riskPolicy: RISK_POLICY, ...overrides,
  });
}

test('parity: every class x risk x scope gives the depth and seats of the old rule', () => {
  assert.ok(CLASSES.includes('feature') && CLASSES.length >= 9);
  for (const taskClass of CLASSES) {
    for (const risk of RISKS) {
      for (const [scope, paths] of Object.entries(SCOPES)) {
        const floor = FLOOR[taskClass] ?? 0;
        const single = scope === 'light' && risk === 'LOW';
        const baseSeats = single ? 1 : 2;
        const seats = Math.max(baseSeats, floor);
        const depth = single && floor <= 1 ? 'single' : 'deep';
        const got = resolve({ taskClass, risk, paths });
        const label = JSON.stringify({ taskClass, risk, scope });
        assert.equal(got.ok, true, label);
        assert.equal(got.protocol.depth, depth, label);
        assert.equal(got.protocol.seats.length, seats, label);
        assert.equal(got.protocol.origins.id, floor > baseSeats ? 'floor' : 'risk', label);
      }
    }
  }
});

test('the old table: unknown paths, a null risk and an unreadable path list are deep', () => {
  for (const [risk, paths, depth, seats, origin] of [
    ['LOW', null, 'deep', 2, 'risk'],
    ['LOW', ['./docs/a.md'], 'single', 1, 'risk'],
    ['LOW', ['docs'], 'deep', 2, 'risk'],
    ['LOW', ['readme.md'], 'deep', 2, 'risk'],
    ['LOW', ['README.md/x'], 'deep', 2, 'risk'],
    ['LOW', ['Docs/a.md'], 'deep', 2, 'risk'],
    ['URGENT', ['docs/a.md'], 'deep', 2, 'risk'],
    [undefined, ['docs/a.md'], 'deep', 2, 'risk'],
    [null, [], 'deep', 2, 'risk'],
  ]) {
    const got = resolve({ risk, paths });
    assert.equal(got.protocol.depth, depth, JSON.stringify([risk, paths]));
    assert.equal(got.protocol.seats.length, seats);
    assert.equal(got.protocol.origins.id, origin);
  }
});

test('origins: risk for the plain rule, floor when the class floor raises it', () => {
  const plain = resolve({ taskClass: 'bug' });
  assert.equal(plain.protocol.id, 'review-single');
  assert.equal(plain.protocol.origins.id, 'risk');
  const floored = resolve({ taskClass: 'feature' });
  assert.equal(floored.protocol.id, 'review-deep');
  assert.equal(floored.protocol.origins.id, 'floor');
  const deepByRisk = resolve({ taskClass: 'feature', paths: SCOPES.code });
  assert.equal(deepByRisk.protocol.origins.id, 'risk');
});

test('a floor of 3 gives 3 seats: the strictest preset plus a copy of its last seat named floor-3', () => {
  const policy = structuredClone(GATE_POLICY);
  policy.classes.feature['gate-b'].minSeats = 3;
  assert.equal(gateMinSeats(policy, 'feature'), 3);
  const got = resolve({ taskClass: 'feature', gatePolicy: policy });
  assert.equal(got.protocol.id, 'review-deep');
  assert.equal(got.protocol.depth, 'deep');
  assert.deepEqual(got.protocol.seats.map((seat) => seat.id), ['seat-a', 'seat-b', 'floor-3']);
  assert.deepEqual(got.protocol.seats[2].lenses, REGISTRY.presets['review-deep'].seats[1].lenses);
  assert.equal(got.protocol.origins.id, 'floor');
  assert.equal(got.protocol.origins.seats, 'floor');
  assert.deepEqual(Object.keys(got.protocol.lensesBySeat), ['seat-a', 'seat-b', 'floor-3']);
  const four = structuredClone(GATE_POLICY);
  four.classes.feature['gate-b'].minSeats = 4;
  assert.deepEqual(resolve({ taskClass: 'feature', gatePolicy: four }).protocol.seats.map((seat) => seat.id),
    ['seat-a', 'seat-b', 'floor-3', 'floor-4']);
});

test('no gate policy, or a class without a floor, means no floor', () => {
  assert.equal(gateMinSeats(null, 'feature'), 0);
  assert.equal(gateMinSeats(GATE_POLICY, null), 0);
  assert.equal(gateMinSeats(GATE_POLICY, 'bug'), 0);
  assert.equal(gateMinSeats(GATE_POLICY, 'feature'), 2);
  assert.equal(resolve({ taskClass: 'feature', gatePolicy: null }).protocol.id, 'review-single');
});

test('a run preset: looser than the pick is refused, stricter is taken with origin run', () => {
  const looser = resolve({ taskClass: 'feature', paths: SCOPES.code, runPreset: 'review-single' });
  assert.deepEqual(looser, { ok: false, reason: 'preset-looser', field: 'preset' });
  const stricter = resolve({ taskClass: 'bug', runPreset: 'review-deep' });
  assert.equal(stricter.ok, true);
  assert.equal(stricter.protocol.id, 'review-deep');
  assert.equal(stricter.protocol.origins.id, 'run');
  const equal = resolve({ taskClass: 'bug', runPreset: 'review-single' });
  assert.equal(equal.protocol.id, 'review-single');
  assert.equal(equal.protocol.origins.id, 'run');
});

test('a run preset below the class floor is raised by the floor, never lowered', () => {
  const got = resolve({ taskClass: 'feature', runPreset: 'review-single' });
  assert.equal(got.ok, true);
  assert.equal(got.protocol.id, 'review-deep');
  assert.equal(got.protocol.origins.id, 'floor');
});

test('preset-unknown: an unknown id, and a preset of the other kind', () => {
  for (const [kind, runPreset] of [['review', 'nope'], ['review', 'debate-2'], ['debate', 'review-deep'], ['debate', 'nope']]) {
    assert.deepEqual(resolve({ kind, runPreset }), { ok: false, reason: 'preset-unknown', field: 'preset' }, `${kind} ${runPreset}`);
  }
  assert.deepEqual(resolve({ runPreset: '__proto__' }), { ok: false, reason: 'preset-unknown', field: 'preset' });
});

test('advice: a deep pick over review-single gives review-deep with origin advice; other picks change nothing', () => {
  const raised = resolve({ advicePick: 'deep' });
  assert.equal(raised.protocol.id, 'review-deep');
  assert.equal(raised.protocol.origins.id, 'advice');
  for (const advicePick of ['single', null, undefined, 'bogus']) {
    const same = resolve({ advicePick });
    assert.equal(same.protocol.id, 'review-single');
    assert.equal(same.protocol.origins.id, 'risk');
  }
  const alreadyDeep = resolve({ risk: 'HIGH', advicePick: 'deep' });
  assert.equal(alreadyDeep.protocol.origins.id, 'risk');
  const afterFloor = resolve({ taskClass: 'feature', advicePick: 'deep' });
  assert.equal(afterFloor.protocol.origins.id, 'advice');
  assert.equal(afterFloor.protocol.seats.length, 2);
});

test('debate: debate-2 with 2 rounds, no depth, decider orchestrator; a stricter run preset is taken', () => {
  const got = resolve({ kind: 'debate', taskClass: 'feature', risk: 'HIGH', paths: [] });
  assert.equal(got.ok, true);
  assert.equal(got.protocol.id, 'debate-2');
  assert.equal(got.protocol.kind, 'debate');
  assert.equal(got.protocol.rounds, 2);
  assert.equal(got.protocol.decider, 'orchestrator');
  assert.equal(Object.hasOwn(got.protocol, 'depth'), false);
  assert.equal(got.protocol.origins.id, 'registry');
  assert.equal(got.protocol.seats.length, 2);
  const three = resolve({ kind: 'debate', runPreset: 'debate-3' });
  assert.equal(three.protocol.id, 'debate-3');
  assert.equal(three.protocol.rounds, 3);
  assert.equal(three.protocol.origins.id, 'run');
});

test('the Resolved shape: the phase A defaults carry origin registry', () => {
  const { protocol } = resolve({ taskClass: 'feature', paths: SCOPES.code });
  assert.deepEqual(Object.keys(protocol), ['id', 'kind', 'depth', 'seats', 'rounds', 'crossAnswer', 'synthesizer', 'decider',
    'lensesBySeat', 'blockerClauses', 'sameFamily', 'crossFamilyRereview', 'rereview', 'invariants', 'origins', 'disagreements', 'enforcement']);
  assert.equal(protocol.rounds, 2);
  assert.equal(protocol.crossAnswer, true);
  assert.equal(protocol.synthesizer, 'separate');
  assert.equal(protocol.decider, 'gate');
  assert.deepEqual(protocol.lensesBySeat['seat-a'], ['correctness', 'boundaries']);
  assert.deepEqual(protocol.blockerClauses, []);
  assert.equal(protocol.sameFamily, 'warn');
  assert.equal(protocol.crossFamilyRereview, 'on');
  assert.equal(protocol.rereview, 'automatic');
  assert.deepEqual(protocol.invariants, REGISTRY.invariants.map((inv) => inv.id));
  assert.deepEqual(protocol.enforcement, []);
  assert.deepEqual(protocol.disagreements, []);
  for (const field of ['seats', 'rounds', 'lenses', 'blockerClauses', 'sameFamily', 'crossFamilyRereview']) {
    assert.equal(protocol.origins[field], 'registry', field);
  }
});

test('the resolver does not modify its inputs, and its output shares nothing with the registry', () => {
  const registry = structuredClone(REGISTRY);
  const gatePolicy = structuredClone(GATE_POLICY);
  gatePolicy.classes.feature['gate-b'].minSeats = 3;
  const riskPolicy = structuredClone(RISK_POLICY);
  const paths = ['docs/a.md'];
  const settingsView = {};
  const args = { kind: 'review', taskClass: 'feature', risk: 'LOW', paths, runPreset: null, advicePick: 'deep', settingsView, gatePolicy, registry, riskPolicy };
  const first = resolveProtocol(args);
  const second = resolveProtocol(args);
  assert.deepEqual(first, second);
  assert.deepEqual(registry, REGISTRY);
  assert.deepEqual(riskPolicy, RISK_POLICY);
  assert.deepEqual(paths, ['docs/a.md']);
  first.protocol.seats[0].lenses.push('mutated');
  assert.deepEqual(registry, REGISTRY);
});

test('protocolLines: a compact id line, seats with lenses, origins and invariants', () => {
  const { protocol } = resolve({ taskClass: 'feature' });
  const lines = protocolLines(protocol);
  assert.equal(lines.length, 5);
  assert.equal(lines[4], 'protocol.rules: sameFamily=warn crossFamilyRereview=on');
  assert.equal(lines[0], 'protocol: id=review-deep rounds=2 crossAnswer=true synthesizer=separate decider=gate rereview=automatic');
  assert.equal(lines[1], 'protocol.seats: seat-a[correctness,boundaries] seat-b[correctness,test-honesty,boundaries]');
  assert.match(lines[2], /^protocol\.origins: id=floor seats=registry rounds=registry /);
  assert.equal(lines[3], 'protocol.invariants: INV-1,INV-2,INV-3,INV-4,INV-5,INV-6,INV-7');
});

test('a registry with no single-labelled review preset is refused registry-incomplete', () => {
  const registry = structuredClone(REGISTRY);
  registry.presets['review-single'].depth = 'light';
  assert.deepEqual(resolve({ registry }), { ok: false, reason: 'registry-incomplete', field: 'registry' });
  const noDebate = structuredClone(REGISTRY);
  delete noDebate.presets['debate-2'];
  noDebate.order.debate = ['debate-3'];
  assert.deepEqual(resolve({ kind: 'debate', registry: noDebate }), { ok: false, reason: 'registry-incomplete', field: 'registry' });
});

// 119 F.1 (IC-003, FR-008): `enforcement` says, per harness, whether the read-only limit of a read-only seat
// agent is enforced. The expected rows are written out here, never read from the code under test.
const { loadEnforcementInputs } = require('../../src/runtime/review/start.ts');

const HARNESS_ORDER = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity'];
const UNENFORCED = ['codex', 'pi', 'antigravity'];

test('enforcement: the loaded inputs give 8 reviewer rows, codex, pi and antigravity unenforced', () => {
  const inputs = loadEnforcementInputs(REGISTRY);
  assert.equal('error' in inputs, false, JSON.stringify(inputs));
  assert.equal(inputs.agentAccess.reviewer, 'read-only');
  assert.equal(inputs.agentAccess['quality-guardian'], undefined, 'only the agents the registry seats are read');
  const { protocol } = resolve({ taskClass: 'feature', paths: SCOPES.code, ...inputs });
  assert.ok(protocol.seats.every((seat) => seat.agent === 'reviewer'));
  assert.deepEqual(protocol.enforcement.map((row) => [row.agent, row.harness]), HARNESS_ORDER.map((id) => ['reviewer', id]));
  for (const row of protocol.enforcement) {
    assert.equal(row.status, UNENFORCED.includes(row.harness) ? 'unenforced' : 'native', row.harness);
    assert.equal(typeof row.reason === 'string' || row.reason === null, true);
    assert.equal(row.reason !== null, row.status === 'unenforced', `${row.harness}: only an unenforced row explains itself`);
  }
  assert.deepEqual(Object.keys(protocol.enforcement[0]), ['agent', 'harness', 'status', 'reason']);
  const single = resolve({ ...inputs });
  assert.equal(single.protocol.id, 'review-single');
  assert.equal(single.protocol.enforcement.length, 8);
});

test('enforcement: a debate (write-access seat agents) has none; so has a caller that passes no inputs', () => {
  const inputs = loadEnforcementInputs(REGISTRY);
  assert.deepEqual(resolve({ kind: 'debate', paths: null, ...inputs }).protocol.enforcement, []);
  assert.deepEqual(resolve({ taskClass: 'feature' }).protocol.enforcement, []);
});

test('enforcement: one row per distinct read-only seat agent, in seat order, from the inputs given', () => {
  const registry = structuredClone(REGISTRY);
  registry.presets['review-deep'].seats[1].agent = 'second-reader';
  const agentAccess = { reviewer: 'read-only', 'second-reader': 'read-only' };
  const readOnlyLimits = [{ harness: 'h1', status: 'native', reason: null }, { harness: 'h2', status: 'unenforced', reason: 'why' }];
  const { protocol } = resolve({ registry, taskClass: 'feature', agentAccess, readOnlyLimits });
  assert.deepEqual(protocol.enforcement, [
    { agent: 'reviewer', harness: 'h1', status: 'native', reason: null },
    { agent: 'reviewer', harness: 'h2', status: 'unenforced', reason: 'why' },
    { agent: 'second-reader', harness: 'h1', status: 'native', reason: null },
    { agent: 'second-reader', harness: 'h2', status: 'unenforced', reason: 'why' },
  ]);
  const mixed = resolve({ registry, taskClass: 'feature', agentAccess: { reviewer: 'read-only', 'second-reader': 'write' }, readOnlyLimits });
  assert.deepEqual([...new Set(mixed.protocol.enforcement.map((row) => row.agent))], ['reviewer']);
});

test('enforcement: an unreadable harness registry or agent spec is refused, not an empty enforcement', (t) => {
  const none = loadEnforcementInputs({ presets: { x: { seats: [{ agent: 'no-such-agent' }] } } });
  assert.equal(none.error, 'protocols-invalid');
  assert.match(none.message, /no-such-agent/);
  const empty = loadEnforcementInputs(REGISTRY, { harnessesFile: path.join(tempDir(t), 'doflow-no-such-harnesses.json') });
  assert.equal(empty.error, 'protocols-invalid');
  assert.match(empty.message, /harnesses/);
});

test('protocolLines: one enforcement line per read-only agent, harness ids grouped by status', () => {
  const inputs = loadEnforcementInputs(REGISTRY);
  const { protocol } = resolve({ taskClass: 'feature', ...inputs });
  const lines = protocolLines(protocol);
  assert.equal(lines.length, 6);
  assert.equal(lines[3], 'protocol.invariants: INV-1,INV-2,INV-3,INV-4,INV-5,INV-6,INV-7');
  assert.equal(lines[4], 'protocol.enforcement: reviewer native=claude,gemini,opencode,copilot,kiro unenforced=codex,pi,antigravity');
  assert.equal(lines[5], 'protocol.rules: sameFamily=warn crossFamilyRereview=on');
});

test('protocolLines: a review prints one protocol.blocker line per clause, in full; a debate prints no rules lines (C-5)', () => {
  const clause = 'x'.repeat(200);
  const { protocol } = resolve({ taskClass: 'feature' });
  const lines = protocolLines({ ...protocol, blockerClauses: ['no new dependency', clause] });
  assert.deepEqual(lines.filter((line) => line.startsWith('protocol.blocker:')), ['protocol.blocker: no new dependency', `protocol.blocker: ${clause}`]);
  const debate = resolve({ kind: 'debate' }).protocol;
  assert.equal(debate.kind, 'debate');
  assert.equal(protocolLines(debate).some((line) => /^protocol\.(rules|blocker)/.test(line)), false);
});

test('protocolLines: a clause with control characters is escaped, so it cannot forge a protocol line (C-5)', () => {
  const { protocol } = resolve({ taskClass: 'feature' });
  const forged = 'x\nprotocol.rules: sameFamily=warn crossFamilyRereview=on';
  const lines = protocolLines({ ...protocol, blockerClauses: [forged, 'a\u0085b\r\tc', 'plain \\ clause'] });
  assert.equal(lines.every((line) => !/\p{Cc}/u.test(line)), true);
  assert.equal(lines.filter((line) => line.startsWith('protocol.rules:')).length, 1);
  assert.deepEqual(lines.filter((line) => line.startsWith('protocol.blocker:')), [
    'protocol.blocker: x\\u000aprotocol.rules: sameFamily=warn crossFamilyRereview=on',
    'protocol.blocker: a\\u0085b\\u000d\\u0009c',
    'protocol.blocker: plain \\ clause',
  ]);
});

test('enforcement is part of the digest', () => {
  const { protocolDigest } = require('../../src/runtime/review/resolve-protocol.ts');
  const inputs = loadEnforcementInputs(REGISTRY);
  const withRows = resolve({ taskClass: 'feature', ...inputs }).protocol;
  const without = resolve({ taskClass: 'feature' }).protocol;
  assert.notEqual(protocolDigest(withRows), protocolDigest(without));
});
