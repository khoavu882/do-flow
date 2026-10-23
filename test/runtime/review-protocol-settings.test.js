'use strict';

// 119 B.2 (IC-003 steps 2 and 4, IC-006; Q-A1, Q-A2): the resolver reads the seven protocol settings through a
// plain `settingsView`, the run preset beats an advice raise, and `protocolDigest` hashes the resolved object.
// Resolver cases use plain maps; the integration cases write real layer files in a scratch HOME and project
// (createSettingsEnv), never the real HOME. A test reads only its own repo (FU-rvzby1).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv } = require('../helper/settings-fixtures');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadProtocols } = require('../../src/runtime/review/protocols.ts');
const { resolveProtocol, protocolDigest, protocolLines } = require('../../src/runtime/review/resolve-protocol.ts');
const { loadProtocolInputs } = require('../../src/runtime/review/start.ts');
const { handleProtocolCommand } = require('../../src/runtime/review/protocol-command.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { loadPolicy } = require('../../src/runtime/roadmap/gates.ts');

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const loaded = loadProtocols({ repoRoot: REPO_ROOT });
assert.ok(loaded.ok, loaded.errors.join('; '));
const REGISTRY = loaded.registry;
const GATES = loadPolicy(read('core/registry/gates.json'), null);
assert.ok(GATES.ok);
const RISK_POLICY = JSON.parse(read('core/registry/verification.json')).reviewDepth;
const LIGHT = ['docs/a.md', 'README.md'];
const CODE = ['docs/a.md', 'src/x.ts'];

function resolve(overrides = {}) {
  return resolveProtocol({
    kind: 'review', taskClass: 'bug', risk: 'LOW', paths: LIGHT, runPreset: null, advicePick: null,
    settingsView: {}, gatePolicy: GATES.policy, registry: REGISTRY, riskPolicy: RISK_POLICY, ...overrides,
  });
}
const set = (key, value, layer) => ({ [key]: { value, layer } });

// ---- step 2: the preset setting -----------------------------------------------------------------

test('review.preset review-single on a single-eligible change: nothing changes, the risk keeps the origin, no refusal', () => {
  const got = resolve({ settingsView: set('review.preset', 'review-single', 'user') });
  assert.equal(got.ok, true);
  assert.equal(got.protocol.id, 'review-single');
  assert.equal(got.protocol.origins.id, 'risk');
  assert.deepEqual(got.protocol.disagreements, []);
});

test('review.preset review-single on a code-scope change is looser: ignored, shown as a disagreement', () => {
  const got = resolve({ paths: CODE, settingsView: set('review.preset', 'review-single', 'user') });
  assert.equal(got.ok, true);
  assert.equal(got.protocol.id, 'review-deep');
  assert.equal(got.protocol.origins.id, 'risk');
  assert.deepEqual(got.protocol.disagreements, [{ field: 'id', by: 'user', value: 'review-single', reason: 'looser' }]);
  assert.match(protocolLines(got.protocol).at(-1), /^protocol\.disagreements: field=id by=user value=review-single reason=looser$/);
});

test('review.preset review-deep over a light LOW bug is taken with its layer as origin; auto and default change nothing', () => {
  const got = resolve({ settingsView: set('review.preset', 'review-deep', 'project') });
  assert.equal(got.protocol.id, 'review-deep');
  assert.equal(got.protocol.origins.id, 'project');
  assert.deepEqual(got.protocol.disagreements, []);
  for (const view of [set('review.preset', 'auto', 'project'), set('review.preset', 'review-deep', 'default'), {}]) {
    const same = resolve({ settingsView: view });
    assert.equal(same.protocol.id, 'review-single');
    assert.equal(same.protocol.origins.id, 'risk');
  }
  const equal = resolve({ paths: CODE, settingsView: set('review.preset', 'review-deep', 'local') });
  assert.equal(equal.protocol.origins.id, 'risk', 'an equal settings value never takes the origin');
  assert.equal(protocolLines(equal.protocol).length, 5, 'the four base lines and the rules line, no disagreements line when there is none');
});

test('debate.preset debate-3 on kind debate gives debate-3, three rounds, origin project', () => {
  const got = resolve({ kind: 'debate', settingsView: set('debate.preset', 'debate-3', 'project') });
  assert.equal(got.protocol.id, 'debate-3');
  assert.equal(got.protocol.rounds, 3);
  assert.equal(got.protocol.origins.id, 'project');
  const dflt = resolve({ kind: 'debate', settingsView: set('debate.preset', 'debate-2', 'default') });
  assert.equal(dflt.protocol.id, 'debate-2');
  assert.equal(dflt.protocol.origins.id, 'registry');
});

test('the review.* knobs do not touch a debate, and debate.preset does not touch a review', () => {
  const view = { ...set('review.rounds', 3, 'project'), ...set('review.extraLenses', ['test-honesty'], 'project'),
    ...set('review.blockerClauses', ['no TODO'], 'user'), ...set('review.sameFamily', 'refuse', 'user'), ...set('debate.preset', 'debate-3', 'project') };
  const debate = resolve({ kind: 'debate', settingsView: view });
  assert.equal(debate.protocol.rounds, 3);
  assert.equal(debate.protocol.origins.rounds, 'registry');
  assert.deepEqual(debate.protocol.blockerClauses, []);
  assert.equal(debate.protocol.sameFamily, 'warn');
  assert.deepEqual(debate.protocol.lensesBySeat.architect, []);
  assert.equal(resolve({ settingsView: set('debate.preset', 'debate-3', 'project') }).protocol.id, 'review-single');
});

// ---- step 4: the knobs --------------------------------------------------------------------------

test('review.rounds: within [preset min, hardRoundCap] it is taken; below the min or above the cap it is recorded and ignored', () => {
  const three = resolve({ paths: CODE, settingsView: set('review.rounds', 3, 'project') });
  assert.equal(three.protocol.id, 'review-deep');
  assert.equal(three.protocol.rounds, 3);
  assert.equal(three.protocol.origins.rounds, 'project');
  const one = resolve({ paths: CODE, settingsView: set('review.rounds', 1, 'project') });
  assert.equal(one.protocol.rounds, 2);
  assert.equal(one.protocol.origins.rounds, 'registry');
  assert.deepEqual(one.protocol.disagreements, [{ field: 'rounds', by: 'project', value: 1, reason: 'below-min' }]);
  const high = resolve({ paths: CODE, settingsView: set('review.rounds', 4, 'user') });
  assert.equal(high.protocol.rounds, 2);
  assert.deepEqual(high.protocol.disagreements, [{ field: 'rounds', by: 'user', value: 4, reason: 'above-cap' }]);
  const single = resolve({ settingsView: set('review.rounds', 3, 'local') });
  assert.equal(single.protocol.id, 'review-single');
  assert.equal(single.protocol.rounds, 3, 'the knob applies to the final preset: review-single has min 1');
});

test('review.rounds is checked against the preset the floor chose, not the first pick', () => {
  const got = resolve({ taskClass: 'feature', settingsView: set('review.rounds', 1, 'project') });
  assert.equal(got.protocol.id, 'review-deep');
  assert.equal(got.protocol.rounds, 2);
  assert.equal(got.protocol.disagreements[0].reason, 'below-min');
});

test('review.extraLenses is appended to every seat and lensesBySeat without duplicates; origin is its layer', () => {
  const base = resolve({ paths: CODE });
  const got = resolve({ paths: CODE, settingsView: set('review.extraLenses', ['test-honesty', 'correctness'], 'project') });
  assert.deepEqual(got.protocol.lensesBySeat['seat-a'], ['correctness', 'boundaries', 'test-honesty']);
  assert.deepEqual(got.protocol.lensesBySeat['seat-b'], ['correctness', 'test-honesty', 'boundaries']);
  assert.deepEqual(got.protocol.seats.map((seat) => seat.lenses), [got.protocol.lensesBySeat['seat-a'], got.protocol.lensesBySeat['seat-b']]);
  assert.equal(got.protocol.origins.lenses, 'project');
  assert.equal(base.protocol.origins.lenses, 'registry');
  assert.deepEqual(resolve({ paths: CODE, settingsView: set('review.extraLenses', [], 'project') }), base, 'an empty list is the default');
  assert.deepEqual(REGISTRY.presets['review-deep'].seats[0].lenses, ['correctness', 'boundaries'], 'the registry is not modified');
});

test('review.blockerClauses, sameFamily and crossFamilyRereview are carried with their layer as origin', () => {
  const got = resolve({ paths: CODE, settingsView: {
    ...set('review.blockerClauses', ['no new dependency', 'no TODO'], 'user'),
    ...set('review.sameFamily', 'refuse', 'project'), ...set('review.crossFamilyRereview', 'off', 'local'),
  } });
  assert.deepEqual(got.protocol.blockerClauses, ['no new dependency', 'no TODO']);
  assert.equal(got.protocol.sameFamily, 'refuse');
  assert.equal(got.protocol.crossFamilyRereview, 'off');
  assert.equal(got.protocol.origins.blockerClauses, 'user');
  assert.equal(got.protocol.origins.sameFamily, 'project');
  assert.equal(got.protocol.origins.crossFamilyRereview, 'local');
  const dflt = resolve({ paths: CODE, settingsView: { ...set('review.sameFamily', 'warn', 'default'), ...set('review.blockerClauses', [], 'default') } });
  assert.equal(dflt.protocol.origins.sameFamily, 'registry');
  assert.equal(dflt.protocol.origins.blockerClauses, 'registry');
});

// ---- Q-A1: a run preset beats an advice raise ------------------------------------------------------

test('Q-A1: advice deep with a run preset review-single is not a refusal; the run preset wins and the raise is recorded', () => {
  const got = resolve({ advicePick: 'deep', runPreset: 'review-single' });
  assert.equal(got.ok, true);
  assert.equal(got.protocol.id, 'review-single');
  assert.equal(got.protocol.origins.id, 'run');
  assert.deepEqual(got.protocol.disagreements, [{ field: 'id', by: 'advice', value: 'review-deep', reason: 'run-preset' }]);
  assert.match(protocolLines(got.protocol).at(-1), /^protocol\.disagreements: field=id by=advice value=review-deep reason=run-preset$/);
});

test('Q-A1: advice deep with no run preset raises to review-deep, origin advice; a run preset at the raised level shows no disagreement', () => {
  const raised = resolve({ advicePick: 'deep' });
  assert.equal(raised.protocol.id, 'review-deep');
  assert.equal(raised.protocol.origins.id, 'advice');
  assert.deepEqual(raised.protocol.disagreements, []);
  const same = resolve({ advicePick: 'deep', runPreset: 'review-deep' });
  assert.equal(same.protocol.origins.id, 'run');
  assert.deepEqual(same.protocol.disagreements, []);
});

test('Q-A1: a run preset looser than steps 1-2 is still preset-looser; a preset setting that raised the pick counts in that comparison', () => {
  assert.deepEqual(resolve({ paths: CODE, runPreset: 'review-single', advicePick: 'deep' }), { ok: false, reason: 'preset-looser', field: 'preset' });
  const view = set('review.preset', 'review-deep', 'project');
  assert.deepEqual(resolve({ runPreset: 'review-single', settingsView: view }), { ok: false, reason: 'preset-looser', field: 'preset' });
  const raised = resolve({ settingsView: view, advicePick: 'deep' });
  assert.equal(raised.protocol.origins.id, 'project', 'advice has nothing to raise once the setting made the pick deep');
});

// ---- Q-A2: the digest ---------------------------------------------------------------------------

test('protocolDigest is 64 hex, stable across calls and key order, and changes with one knob', () => {
  const a = resolve({ paths: CODE }).protocol;
  const again = resolve({ paths: CODE }).protocol;
  assert.match(protocolDigest(a), /^[0-9a-f]{64}$/);
  assert.equal(protocolDigest(a), protocolDigest(again));
  const reordered = Object.fromEntries(Object.entries(again).reverse());
  assert.equal(protocolDigest(reordered), protocolDigest(a), 'object key order does not matter');
  assert.notEqual(protocolDigest(resolve({ paths: CODE, settingsView: set('review.rounds', 3, 'project') }).protocol), protocolDigest(a));
  assert.notEqual(protocolDigest({ ...a, blockerClauses: ['x'] }), protocolDigest(a));
  assert.notEqual(protocolDigest({ ...a, invariants: [...a.invariants].reverse() }), protocolDigest(a), 'array order matters');
});

test('the resolver does not modify a settings view and gives the same answer twice', () => {
  const settingsView = { ...set('review.extraLenses', ['test-honesty'], 'project'), ...set('review.rounds', 3, 'user') };
  const copy = structuredClone(settingsView);
  const first = resolve({ paths: CODE, settingsView });
  const second = resolve({ paths: CODE, settingsView });
  assert.deepEqual(first, second);
  assert.deepEqual(settingsView, copy);
  first.protocol.blockerClauses.push('x');
  first.protocol.lensesBySeat['seat-a'].push('y');
  assert.deepEqual(settingsView, copy);
});

// ---- real layer files through loadProtocolInputs -------------------------------------------------------

function inputsFor(f, taskClass = 'feature') {
  const inputs = loadProtocolInputs(taskClass, f.project, f.env());
  assert.equal('error' in inputs, false, JSON.stringify(inputs));
  return inputs;
}
const run = (inputs, overrides = {}) => resolveProtocol({
  kind: 'review', taskClass: 'feature', risk: 'MEDIUM', paths: CODE, runPreset: null, advicePick: null, riskPolicy: RISK_POLICY, ...inputs, ...overrides,
});

test('settings: a project review.preset review-single on a feature is not-narrower and the protocol stays review-deep', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'review.preset': 'review-single' });
  const candidate = loadSettings({ projectRoot: f.project, env: f.env() }).get('review.preset').candidates.find((c) => c.layer === 'project');
  assert.equal(candidate.status, 'not-narrower');
  const inputs = inputsFor(f);
  assert.deepEqual(inputs.settingsView['review.preset'], { value: 'auto', layer: 'default' });
  const got = run(inputs);
  assert.equal(got.protocol.id, 'review-deep');
  assert.deepEqual(got.protocol.disagreements, []);
});

test('settings: a project review.preset review-deep narrows auto and the protocol takes origin project', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'review.preset': 'review-deep' });
  const inputs = inputsFor(f, 'bug');
  assert.deepEqual(inputs.settingsView['review.preset'], { value: 'review-deep', layer: 'project' });
  const got = run(inputs, { taskClass: 'bug', risk: 'LOW', paths: LIGHT });
  assert.equal(got.protocol.id, 'review-deep');
  assert.equal(got.protocol.origins.id, 'project');
});

test('settings: with a user review.rounds of 2 a project 1 is not-narrower and the user value stands', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'review.rounds': 2 });
  f.writeProjectSettings({ schema: 1, 'review.rounds': 1 });
  const candidates = loadSettings({ projectRoot: f.project, env: f.env() }).get('review.rounds').candidates;
  assert.equal(candidates.find((c) => c.layer === 'project').status, 'not-narrower');
  const inputs = inputsFor(f);
  assert.deepEqual(inputs.settingsView['review.rounds'], { value: 2, layer: 'user' });
  assert.equal(run(inputs).protocol.origins.rounds, 'user');
  f.writeProjectSettings({ schema: 1, 'review.rounds': 3 });
  const stricter = inputsFor(f);
  assert.deepEqual(stricter.settingsView['review.rounds'], { value: 3, layer: 'project' });
  assert.equal(run(stricter).protocol.rounds, 3);
});

test('settings: user and project review.extraLenses add up and both reach the protocol', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'review.extraLenses': ['correctness'] });
  f.writeProjectSettings({ schema: 1, 'review.extraLenses': ['test-honesty'], 'review.blockerClauses': ['no new dependency'] });
  const inputs = inputsFor(f);
  assert.deepEqual(inputs.settingsView['review.extraLenses'], { value: ['correctness', 'test-honesty'], layer: 'project' });
  const got = run(inputs);
  assert.deepEqual(got.protocol.lensesBySeat['seat-a'], ['correctness', 'boundaries', 'test-honesty']);
  assert.equal(got.protocol.origins.lenses, 'project');
  assert.deepEqual(got.protocol.blockerClauses, ['no new dependency']);
});

test('settings: with no settings files every key is the default layer and the protocol equals the empty view', (t) => {
  const f = createSettingsEnv(t);
  const inputs = inputsFor(f);
  assert.deepEqual(Object.keys(inputs.settingsView), ['review.preset', 'review.rounds', 'review.sameFamily', 'review.crossFamilyRereview',
    'review.extraLenses', 'review.blockerClauses', 'debate.preset']);
  for (const entry of Object.values(inputs.settingsView)) assert.equal(entry.layer, 'default');
  assert.deepEqual(run(inputs), run({ ...inputs, settingsView: {} }));
});

test('settings: a settings view that cannot load is a settings-unavailable refusal, not a silent default', (t) => {
  const f = createSettingsEnv(t);
  const resolverModule = require('../../src/runtime/settings/resolve.ts');
  const original = resolverModule.loadSettings;
  const priorExit = process.exitCode;
  t.after(() => { resolverModule.loadSettings = original; process.exitCode = priorExit; });
  resolverModule.loadSettings = () => { throw new Error('settings registry exploded'); };

  assert.deepEqual(loadProtocolInputs('feature', f.project, f.env()),
    { error: 'settings-unavailable', message: 'settings registry exploded' });

  // The protocol verb reaches the same branch without git and shows it as a refusal.
  const lines = [];
  const code = handleProtocolCommand({ action: 'resolve', kind: 'review', json: true, cwd: f.project, out: (line) => lines.push(line) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(lines.join('\n')), { ok: false, error: 'settings-unavailable', message: 'settings registry exploded' });
});
