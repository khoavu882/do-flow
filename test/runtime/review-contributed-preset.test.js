'use strict';

// Feature 122 A.7 (IC-014, NFR-005): how a contributed (third-party package) review or debate preset is picked, ranked
// and checked. In Phase A no third-party package can be active, so the presets enter through an injected merged
// registry: the shipped `loadProtocols` view plus `acme.strict` (dominates review-deep) and `acme.lax` (dominates
// review-single, not review-deep), held in `presets` and never in `order`, the shape `loadProtocols` gives a
// contributed id. Every seam used here is an explicit optional parameter that defaults to the real view.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadProtocols, validatePreset, contributedPresetIds, presetIds, lensIds, coreTiers } = require('../../src/runtime/review/protocols.ts');
const { dominates } = require('../../src/runtime/review/dominance.ts');
const { resolveProtocol } = require('../../src/runtime/review/resolve-protocol.ts');
const { validateFindings, protocolLooserThanPreset, telemetryProtocol } = require('../../src/runtime/review/findings.ts');
const { TelemetryWriter } = require('../../src/runtime/trace/telemetry.ts');
const { loadPolicy, evaluate } = require('../../src/runtime/roadmap/gates.ts');
const { sha256Digest } = require('../../src/runtime/roadmap/facts.ts');
const { createRefs } = require('../../src/runtime/settings/refs.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { createSettingsEnv } = require('../helper/settings-fixtures');

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const loaded = loadProtocols({ repoRoot: REPO_ROOT });
assert.ok(loaded.ok, loaded.errors.join('; '));
const CORE = loaded.registry;
const deep = CORE.presets['review-deep'];
const single = CORE.presets['review-single'];

const STRICT = {
  kind: 'review',
  seats: [...deep.seats.map((seat) => structuredClone(seat)), { ...structuredClone(deep.seats[1]), id: 'third' }],
  rounds: { default: 3, min: 2 }, crossAnswer: true, synthesizer: 'separate', decider: 'gate',
};
const LAX = { kind: 'review', seats: single.seats.map((seat) => structuredClone(seat)), rounds: { default: 2, min: 1 }, crossAnswer: false, synthesizer: 'seat', decider: 'gate' };

/** The merged view with the acme package active (`without` drops ids, as a disabled or removed package would). */
function view({ without = [] } = {}) {
  const presets = { ...CORE.presets, 'acme.strict': STRICT, 'acme.lax': LAX };
  for (const id of without) delete presets[id];
  return { ...CORE, presets, order: { ...CORE.order } };
}
const VIEW = view();
const CONTEXT = { tiers: coreTiers(), synthesizerStrength: CORE.synthesizerStrength };

const GATES = loadPolicy(read('core/registry/gates.json'), null);
assert.ok(GATES.ok);
const VERIFICATION = JSON.parse(read('core/registry/verification.json'));
const CODE = ['src/x.ts'];
const LIGHT = ['docs/a.md'];

function resolve(overrides = {}) {
  return resolveProtocol({
    kind: 'review', taskClass: 'bug', risk: 'HIGH', paths: CODE, runPreset: null, advicePick: null,
    settingsView: {}, gatePolicy: GATES.policy, registry: VIEW, riskPolicy: VERIFICATION.reviewDepth, ...overrides,
  });
}
const preset = (value, layer = 'user') => ({ 'review.preset': { value, layer } });
const floorOf = (minSeats) => ({ classes: { feature: { 'gate-b': { minSeats } } } });

test('fixture: both acme presets pass the shared validator; acme.strict dominates review-deep, acme.lax only review-single', () => {
  const agents = [...new Set([...STRICT.seats, ...LAX.seats].map((seat) => seat.agent))];
  const context = { lensIds: new Set(lensIds(CORE)), hardRoundCap: CORE.hardRoundCap, tiers: coreTiers(), mode: 'package', agents };
  assert.deepEqual(validatePreset('strict', STRICT, context), []);
  assert.deepEqual(validatePreset('lax', LAX, context), []);
  assert.equal(dominates(STRICT, deep, CONTEXT), true);
  assert.equal(dominates(LAX, deep, CONTEXT), false);
  assert.equal(dominates(LAX, single, CONTEXT), true);
  assert.deepEqual(contributedPresetIds(VIEW, 'review'), ['acme.lax', 'acme.strict']);
  assert.deepEqual(presetIds(VIEW, 'review'), ['review-deep', 'review-single'], 'a contributed id never enters order');
});

test('a user review.preset naming acme.strict resolves it (it dominates the pick), with no depth label', () => {
  for (const layer of ['user', 'project', 'local']) {
    const result = resolve({ settingsView: preset('acme.strict', layer) });
    assert.equal(result.ok, true);
    assert.equal(result.protocol.id, 'acme.strict', layer);
    assert.equal(result.protocol.origins.id, layer);
    assert.deepEqual(result.protocol.disagreements, []);
    assert.equal(result.protocol.seats.length, 3);
    assert.equal(Object.hasOwn(result.protocol, 'depth'), false, 'the depth vocabulary stays core');
  }
});

test('acme.lax gives the disagreement not-dominant and keeps the pick; on a single pick it dominates and is taken', () => {
  const result = resolve({ settingsView: preset('acme.lax') });
  assert.equal(result.protocol.id, 'review-deep');
  assert.equal(result.protocol.origins.id, 'risk');
  assert.deepEqual(result.protocol.disagreements, [{ field: 'id', by: 'user', value: 'acme.lax', reason: 'not-dominant' }]);
  const light = resolve({ risk: 'LOW', paths: LIGHT, settingsView: preset('acme.lax') });
  assert.equal(light.protocol.id, 'acme.lax');
  assert.deepEqual(light.protocol.disagreements, []);
});

test('a run --preset: a contributed one that does not dominate the pick is preset-looser; one that does is taken', () => {
  assert.deepEqual(resolve({ runPreset: 'acme.lax' }), { ok: false, reason: 'preset-looser', field: 'preset' });
  const strict = resolve({ runPreset: 'acme.strict' });
  assert.equal(strict.protocol.id, 'acme.strict');
  assert.equal(strict.protocol.origins.id, 'run');
  // A core run preset is compared with a contributed setting pick by dominance too: review-deep is looser than acme.strict.
  assert.deepEqual(resolve({ runPreset: 'review-deep', settingsView: preset('acme.strict') }), { ok: false, reason: 'preset-looser', field: 'preset' });
  assert.deepEqual(resolve({ runPreset: 'acme.gone' }), { ok: false, reason: 'preset-unknown', field: 'preset' });
});

test('the floor walk and order[0] never pick a package preset, though acme.strict has the seats', () => {
  const result = resolve({ taskClass: 'feature', gatePolicy: floorOf(3) });
  assert.equal(result.protocol.id, 'review-deep');
  assert.equal(result.protocol.origins.id, 'floor');
  assert.equal(result.protocol.origins.seats, 'floor');
  assert.equal(result.protocol.seats.length, 3);
});

test('a contributed pick with too few seats falls back to the core pick of steps 1-2 and the core floor walk', () => {
  const result = resolve({ taskClass: 'feature', gatePolicy: floorOf(4), settingsView: preset('acme.strict') });
  assert.equal(result.protocol.id, 'review-deep');
  assert.equal(result.protocol.origins.id, 'floor');
  assert.equal(result.protocol.seats.length, 4);
  assert.deepEqual(result.protocol.disagreements, [{ field: 'id', by: 'floor', value: 'acme.strict', reason: 'seat-floor' }]);
  // Enough seats for the core pick: it is taken as it is.
  const enough = resolve({ taskClass: 'feature', gatePolicy: floorOf(2), risk: 'LOW', paths: LIGHT, settingsView: preset('acme.lax') });
  assert.equal(enough.protocol.id, 'review-deep', 'the core floor walk from review-single');
  assert.equal(enough.protocol.origins.id, 'floor');
  assert.deepEqual(enough.protocol.disagreements, [{ field: 'id', by: 'floor', value: 'acme.lax', reason: 'seat-floor' }]);
});

test('auto placement never holds a package preset; the value list does, so a person can name one', () => {
  const refs = createRefs({ repoRoot: REPO_ROOT, protocols: VIEW });
  assert.deepEqual(refs.resolve('protocols.reviewPresetOrder'), ['review-deep', 'auto', 'review-single']);
  assert.deepEqual(refs.resolve('protocols.reviewPresetIds'), ['auto', 'review-deep', 'review-single', 'acme.lax', 'acme.strict']);
  // The real view of this checkout has no third-party package: the lists are the core ones.
  const real = createRefs({ repoRoot: REPO_ROOT });
  assert.deepEqual(real.resolve('protocols.reviewPresetIds'), ['auto', 'review-deep', 'review-single']);
});

test('a project review.preset naming a disabled or unknown id is the disagreement unavailable, never a silent drop', () => {
  const disabled = view({ without: ['acme.strict', 'acme.lax'] });
  const result = resolve({ registry: disabled, settingsView: preset('acme.strict', 'project') });
  assert.equal(result.protocol.id, 'review-deep');
  assert.deepEqual(result.protocol.disagreements, [{ field: 'id', by: 'project', value: 'acme.strict', reason: 'unavailable' }]);
  const unknown = resolve({ settingsView: preset('review-nope', 'project') });
  assert.deepEqual(unknown.protocol.disagreements, [{ field: 'id', by: 'project', value: 'review-nope', reason: 'unavailable' }]);
  const debate = resolve({ kind: 'debate', settingsView: { 'debate.preset': { value: 'acme.gone', layer: 'user' } } });
  assert.equal(debate.protocol.id, 'debate-2');
  assert.deepEqual(debate.protocol.disagreements, [{ field: 'id', by: 'user', value: 'acme.gone', reason: 'unavailable' }]);
});

test('settings rank never sees a contributed id: the narrow-only fold compares it by dominance', (t) => {
  const f = createSettingsEnv(t);
  const base = loadSettingsRegistry({ repoRoot: REPO_ROOT });
  assert.ok(base.ok);
  const values = createRefs({ repoRoot: REPO_ROOT, protocols: VIEW }).resolve('protocols.reviewPresetIds');
  const registry = { ...base.registry, enumValues: (key) => (key === 'review.preset' ? values : base.registry.enumValues(key)) };
  const get = (user, project) => {
    f.writeUserSettings(user === undefined ? {} : { 'review.preset': user });
    f.writeProjectSettings(project === undefined ? {} : { 'review.preset': project });
    const resolution = loadSettings({ projectRoot: f.project, env: f.env(), registry, protocols: VIEW }).get('review.preset');
    return { value: resolution.value, statuses: resolution.candidates.map((c) => `${c.layer}:${c.status}`) };
  };
  assert.deepEqual(get('review-deep', 'acme.strict'), { value: 'acme.strict', statuses: ['user:overridden', 'project:decided'] });
  assert.deepEqual(get('review-deep', 'acme.lax'), { value: 'review-deep', statuses: ['user:decided', 'project:not-narrower'] });
  assert.deepEqual(get('auto', 'acme.strict'), { value: 'acme.strict', statuses: ['user:overridden', 'project:decided'] });
  assert.deepEqual(get('auto', 'acme.lax'), { value: 'auto', statuses: ['user:decided', 'project:not-narrower'] }, 'acme.lax is looser than the deep pick auto can make');
  assert.deepEqual(get('acme.strict', 'review-deep'), { value: 'acme.strict', statuses: ['user:decided', 'project:not-narrower'] });
  assert.deepEqual(get('acme.lax', 'review-deep'), { value: 'review-deep', statuses: ['user:overridden', 'project:decided'] });
  assert.deepEqual(get('acme.lax', 'auto'), { value: 'acme.lax', statuses: ['user:decided', 'project:not-narrower'] }, 'auto can pick review-single, looser than acme.lax');
  assert.deepEqual(get('acme.strict', 'acme.lax'), { value: 'acme.strict', statuses: ['user:decided', 'project:not-narrower'] });
  assert.deepEqual(get('acme.lax', 'acme.strict'), { value: 'acme.strict', statuses: ['user:overridden', 'project:decided'] });
  assert.deepEqual(get('acme.strict', 'acme.strict'), { value: 'acme.strict', statuses: ['user:decided', 'project:redundant'] });
  // The core pairs keep their order rank.
  assert.deepEqual(get('review-single', 'auto'), { value: 'auto', statuses: ['user:overridden', 'project:decided'] });
  assert.deepEqual(get('review-deep', 'auto'), { value: 'review-deep', statuses: ['user:decided', 'project:not-narrower'] });
});

// ── gate-b (findings.ts, gates.ts) ─────────────────────────────────────────────────────────────

const HEAD = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const record = (id, extra = {}) => ({
  schema: 1, row: '113', slug: '113-goal-order', reviewedHead: HEAD,
  seats: [{ id: 'one', findings: [] }, { id: 'two', findings: [] }, { id: 'three', findings: [] }], converged: [],
  protocol: { id, digest: 'f'.repeat(64) }, rounds: 2, ...extra,
});

test('gate-b: a contributed id is looser exactly when it does not dominate the project preset', () => {
  // Gate-b's own view holds the acme package here (injected): the record is schema-valid, and acme.lax is refused as looser.
  assert.deepEqual(validateFindings(record('acme.lax'), { preset: 'review-deep', protocols: VIEW }).errors, []);
  assert.equal(protocolLooserThanPreset(record('acme.lax').protocol, 'review-deep', VIEW), true);
  assert.equal(protocolLooserThanPreset(record('acme.strict').protocol, 'review-deep', VIEW), false);
  assert.equal(protocolLooserThanPreset(record('acme.lax').protocol, 'review-single', VIEW), false);
  // A contributed project preset: a core record is looser unless it dominates it.
  assert.equal(protocolLooserThanPreset(record('review-deep').protocol, 'acme.strict', VIEW), true);
  assert.equal(protocolLooserThanPreset(record('acme.strict').protocol, 'acme.lax', VIEW), false);
  assert.equal(protocolLooserThanPreset(record('acme.strict').protocol, 'auto', VIEW), false, 'auto needs the diff (C-2)');
  // The record is held to its own preset: acme.strict asks for three seats and rounds.min 2.
  assert.deepEqual(validateFindings(record('acme.strict', { rounds: 1 }), { protocols: VIEW }).errors, ['protocol-rounds']);
  assert.deepEqual(validateFindings(record('acme.strict', { seats: [{ id: 'one', findings: [] }] }), { protocols: VIEW }).errors, ['protocol-seats']);
});

test('gate-b re-resolves its own view: a record made where acme.strict was active (redirected XDG_CONFIG_HOME) is findings-invalid', (t) => {
  const f = createSettingsEnv(t);
  // The record maker: another process under a redirected config home, whose view (injected) held the acme package.
  const redirected = path.join(f.dir, 'redirected');
  const input = { kind: 'review', taskClass: 'bug', risk: 'HIGH', paths: CODE, runPreset: null, advicePick: null,
    settingsView: preset('acme.strict'), gatePolicy: GATES.policy, registry: VIEW, riskPolicy: VERIFICATION.reviewDepth };
  const made = f.node(`const { resolveProtocol, protocolDigest } = require(${JSON.stringify(path.join(REPO_ROOT, 'src/runtime/review/resolve-protocol.ts'))});
    const { protocol } = resolveProtocol(${JSON.stringify(input)});
    console.log(JSON.stringify({ xdg: process.env.XDG_CONFIG_HOME, id: protocol.id, digest: protocolDigest(protocol) }));`,
  { env: { XDG_CONFIG_HOME: redirected } });
  assert.deepEqual([made.xdg, made.id], [redirected, 'acme.strict']);
  const findings = record('acme.strict', { protocol: { id: made.id, digest: made.digest } });
  // Gate-b reads nothing of the maker's home: under its own view acme.strict is not active.
  assert.deepEqual(validateFindings(findings).errors, ['protocol-unavailable']);
  assert.equal(protocolLooserThanPreset(findings.protocol, 'review-deep'), true);
  assert.equal(protocolLooserThanPreset(findings.protocol, 'review-single'), true, 'outside the active set, whatever the preset');
  const policy = loadPolicy(read('core/registry/gates.json'), null).policy;
  policy.classes.feature['gate-b'].predicates = ['findings-valid'];
  const facts = Object.entries({
    row: { id: '113', slug: '113-goal-order', writeSet: ['src/'], needs: [], requires: [] },
    heads: { developHead: PARENT, featureHead: HEAD },
    findings, 'review-settings': { sameFamily: 'warn', preset: 'review-deep' },
  }).map(([name, value]) => ({ name, value, locator: `fixture:${name}`, sha256: sha256Digest(JSON.stringify(value)) }));
  assert.deepEqual(evaluate(policy, 'feature', 'gate-b', facts).reasons, ['findings-invalid']);
  // A bare unknown id keeps its error `protocol` (119 IC-002).
  assert.deepEqual(validateFindings(record('review-nope')).errors, ['protocol']);
});

test('telemetry carries the bucket package for a contributed preset, never its name (IC-024)', () => {
  assert.equal(telemetryProtocol('acme.strict', VIEW), 'package');
  assert.equal(telemetryProtocol('acme.lax', VIEW), 'package');
  assert.equal(telemetryProtocol('review-deep', VIEW), 'review-deep');
  assert.equal(telemetryProtocol('acme.gone', VIEW), null, 'an id outside the active set is not a protocol');
  assert.equal(telemetryProtocol('acme.strict'), null, 'the real view holds no acme package');
  const registry = JSON.parse(read('core/registry/telemetry.json'));
  assert.equal(registry.kinds['review.run'].fields.protocol.type, 'enum:protocol|null');
  const line = (protocol) => new TelemetryWriter({ repoRoot: REPO_ROOT, env: {} }).line(registry, { kind: 'review.run', protocol }).protocol;
  assert.equal(line(telemetryProtocol('acme.strict', VIEW)), 'package');
  assert.equal(line('review-single'), 'review-single');
  assert.equal(line('acme.strict'), null, 'a third-party name the emitter did not map is written null');
});
