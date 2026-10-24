'use strict';
// 119 IC-001: core/registry/protocols.json and its validator. Each refusal has one failing case,
// built from an in-memory copy of the shipped file so a validator regression cannot hide behind a file edit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProtocols, validateProtocols, presetIds, lensIds } = require('../../src/runtime/review/protocols.ts');

const REPO = path.resolve(__dirname, '../..');
const FILE = path.join(REPO, 'core', 'registry', 'protocols.json');
const shipped = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

function refuses(mutate: any, pattern: any) {
  const data = shipped();
  mutate(data);
  const result = validateProtocols(data);
  assert.equal(result.ok, false, 'the mutated registry must be rejected');
  assert.match(result.errors.join('\n'), pattern);
}

test('protocols: the shipped file loads with zero errors (negative control)', () => {
  const result = loadProtocols({ repoRoot: REPO });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.deepEqual(presetIds(result.registry, 'review'), ['review-deep', 'review-single']);
  assert.deepEqual(presetIds(result.registry, 'debate'), ['debate-3', 'debate-2']);
  assert.deepEqual(lensIds(result.registry), ['correctness', 'test-honesty', 'boundaries']);
  assert.deepEqual(result.registry.presets['debate-3'].seats, result.registry.presets['debate-2'].seats);
});

test('protocols: a duplicate preset id in the raw text is refused', () => {
  const text = fs.readFileSync(FILE, 'utf8').replace('"debate-3": {', '"debate-2": {');
  const fsImpl = { readFileSync: () => text };
  const result = loadProtocols({ repoRoot: REPO, fsImpl });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate key 'debate-2' in presets/);
});

test('protocols: an unreadable or non-JSON file is a returned error, not a throw', () => {
  const result = loadProtocols({ repoRoot: REPO, fsImpl: { readFileSync: () => '{ nope' } });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
});

test('protocols: an unknown lens is refused', () => {
  refuses((d: any) => { d.presets['review-single'].seats[0].lenses.push('vibes'); }, /unknown lens 'vibes'/);
});

test('protocols: a duplicate lens id in the catalogue is refused', () => {
  refuses((d: any) => { d.lenses.push({ id: 'correctness', description: 'again' }); }, /lens id 'correctness' is duplicated/);
});

test('protocols: an order that omits a preset is refused', () => {
  refuses((d: any) => { d.order.review = ['review-deep']; }, /order\.review omits preset 'review-single'/);
});

test('protocols: an order that lists a preset of the wrong kind is refused', () => {
  refuses((d: any) => { d.order.debate.push('review-deep'); }, /order\.debate lists 'review-deep'/);
});

test('protocols: rounds.default above hardRoundCap is refused', () => {
  refuses((d: any) => { d.presets['review-deep'].rounds.default = 4; }, /rounds\.default must not exceed hardRoundCap/);
});

test('protocols: rounds.min above rounds.default is refused', () => {
  refuses((d: any) => { d.presets['review-deep'].rounds.min = 3; }, /rounds\.min must not exceed rounds\.default/);
});

test('protocols: synthesizer seat on a two-seat preset is refused', () => {
  refuses((d: any) => { d.presets['review-deep'].synthesizer = 'seat'; }, /'seat' is only valid on a one-seat preset/);
});

test('protocols: a review preset without depth is refused, and depth is unique and review-only', () => {
  refuses((d: any) => { delete d.presets['review-single'].depth; }, /presets\.review-single\.depth is required/);
  refuses((d: any) => { d.presets['review-single'].depth = 'deep'; }, /depth 'deep' duplicates/);
  refuses((d: any) => { d.presets['debate-2'].depth = 'x'; }, /presets\.debate-2\.depth is not allowed/);
});

test('protocols: an invariant without enforcedBy is refused', () => {
  refuses((d: any) => { delete d.invariants[0].enforcedBy; }, /invariants\[0\]\.enforcedBy/);
});

test('protocols: a bad invariant id, a duplicate seat id, a bad family and a bad preset id are refused', () => {
  refuses((d: any) => { d.invariants[0].id = 'RULE-1'; }, /invariants\[0\]\.id must match/);
  refuses((d: any) => { d.presets['review-deep'].seats[1].id = 'seat-a'; }, /seat id 'seat-a' is duplicated/);
  refuses((d: any) => { d.presets['review-single'].seats[0].model.family = 'other'; }, /model\.family must be one of/);
  refuses((d: any) => { d.presets.Bad_Id = structuredClone(d.presets['debate-2']); d.order.debate.push('Bad_Id'); }, /id must match/);
});

test('protocols: invariant kinds is a non-empty list of known kinds without repeats (C-11)', () => {
  const data = shipped();
  const kinds = Object.fromEntries(data.invariants.map((inv: any) => [inv.id, inv.kinds]));
  assert.deepEqual(kinds['INV-6'], ['review', 'debate']);
  assert.deepEqual(kinds['INV-7'], ['review', 'debate']);
  refuses((d: any) => { d.invariants[0].kinds = []; }, /invariants\[0\]\.kinds must be a non-empty list/);
  refuses((d: any) => { d.invariants[0].kinds = 'review'; }, /invariants\[0\]\.kinds must be a non-empty list/);
  refuses((d: any) => { d.invariants[0].kinds = ['review', 'plan']; }, /invariants\[0\]\.kinds has unknown kind 'plan'/);
  refuses((d: any) => { d.invariants[0].kinds = ['review', 'review']; }, /invariants\[0\]\.kinds lists 'review' more than once/);
  const ok = shipped();
  ok.invariants[0].kinds = ['debate'];
  assert.deepEqual(validateProtocols(ok).errors, []);
});

test('protocols: invariant authorKinds is a non-empty subset of record, subagent, sequential, primary containing subagent without repeats (120 D.2)', () => {
  const data = shipped();
  const inv8 = data.invariants.find((inv: any) => inv.id === 'INV-8');
  assert.deepEqual(inv8?.authorKinds, ['subagent', 'sequential']);

  refuses((d: any) => { d.invariants.find((i: any) => i.id === 'INV-8').authorKinds = []; }, /authorKinds must be a non-empty list/);
  refuses((d: any) => { d.invariants.find((i: any) => i.id === 'INV-8').authorKinds = 'subagent'; }, /authorKinds must be a non-empty list/);
  refuses((d: any) => { d.invariants.find((i: any) => i.id === 'INV-8').authorKinds = ['subagent', 'unknown-kind']; }, /authorKinds has unknown kind 'unknown-kind'/);
  refuses((d: any) => { d.invariants.find((i: any) => i.id === 'INV-8').authorKinds = ['subagent', 'subagent']; }, /authorKinds lists 'subagent' more than once/);
  refuses((d: any) => { d.invariants.find((i: any) => i.id === 'INV-8').authorKinds = ['sequential', 'primary']; }, /authorKinds must contain 'subagent'/);

  const ok = shipped();
  ok.invariants.find((i: any) => i.id === 'INV-8').authorKinds = ['subagent', 'record', 'sequential', 'primary'];
  assert.deepEqual(validateProtocols(ok).errors, []);
});

test('protocols: unknown keys are refused at every level', () => {
  refuses((d: any) => { d.extra = 1; }, /registry has unknown key 'extra'/);
  refuses((d: any) => { d.presets['debate-2'].extra = 1; }, /presets\.debate-2 has unknown key 'extra'/);
  refuses((d: any) => { d.presets['debate-2'].seats[0].extra = 1; }, /seats\[0\] has unknown key 'extra'/);
  refuses((d: any) => { d.presets['debate-2'].rounds.extra = 1; }, /rounds has unknown key 'extra'/);
  refuses((d: any) => { d.invariants[0].extra = 1; }, /invariants\[0\] has unknown key 'extra'/);
});

test('protocols: schema must be 1 and a non-object is refused', () => {
  refuses((d: any) => { d.schema = 2; }, /schema must be 1/);
  assert.equal(validateProtocols(null).ok, false);
});

// ── C-9 extension-first: a preset added to protocols.json alone reaches settings and telemetry ────

const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { validateValue } = require('../../src/runtime/settings/files.ts');
const { TelemetryWriter, derivedVocabularies } = require('../../src/runtime/trace/telemetry.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

/** A temp repoRoot holding a copy of core/registry/, with `mutate` applied to its protocols.json. */
function scratchRegistry(mutate: any) {
  const root = suiteTempDir('doflow-c9-');
  fs.cpSync(path.join(REPO, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  mutate(path.join(root, 'core', 'registry', 'protocols.json'));
  return root;
}

/** Every file of the copied registry other than protocols.json, as text, to prove nothing else was edited. */
function otherRegistryFiles(root: any) {
  const dir = path.join(root, 'core', 'registry');
  return Object.fromEntries(fs.readdirSync(dir).filter((name: any) => name !== 'protocols.json').sort()
    .map((name: any) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

const reviewLine = (root: any, record: any) => {
  const telemetry = JSON.parse(fs.readFileSync(path.join(root, 'core', 'registry', 'telemetry.json'), 'utf8'));
  return new TelemetryWriter({ repoRoot: root, env: {} }).line(telemetry, { kind: 'review.run', ...record });
};

test('C-9: review-triple added to protocols.json alone loads, is a review.preset value ranked strictest, and is a telemetry protocol', () => {
  const root = scratchRegistry((file: any) => {
    const data = shipped();
    const seat = (id: any) => ({ id, agent: 'reviewer', lenses: ['correctness', 'test-honesty', 'boundaries'], model: { tier: 'frontier', family: 'any' } });
    data.presets['review-triple'] = {
      kind: 'review', depth: 'triple', seats: [seat('seat-a'), seat('seat-b'), seat('seat-c')],
      rounds: { default: 2, min: 2 }, crossAnswer: true, synthesizer: 'separate', decider: 'gate',
    };
    data.order.review.unshift('review-triple');
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  });
  const shippedRoot = path.join(REPO);
  assert.deepEqual(otherRegistryFiles(root), Object.fromEntries(Object.keys(otherRegistryFiles(root))
    .map((name) => [name, fs.readFileSync(path.join(shippedRoot, 'core', 'registry', name), 'utf8')])), 'only protocols.json differs from the shipped registry');

  const protocols = loadProtocols({ repoRoot: root });
  assert.deepEqual(protocols.errors, []);
  assert.deepEqual(presetIds(protocols.registry, 'review'), ['review-triple', 'review-deep', 'review-single']);

  const loaded = loadSettingsRegistry({ repoRoot: root, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.detail);
  const spec = loaded.registry.keys.get('review.preset');
  const values = loaded.registry.enumValues('review.preset');
  assert.deepEqual(values, ['auto', 'review-triple', 'review-deep', 'review-single']);
  assert.equal(validateValue(spec, 'review-triple', values), null, 'review.preset accepts review-triple');
  assert.deepEqual(spec.order, ['review-triple', 'review-deep', 'auto', 'review-single'], 'strictest first; auto sits right after the deep preset the risk rule can pick');

  assert.equal(reviewLine(root, { protocol: 'review-triple' }).protocol, 'review-triple');
  assert.equal(reviewLine(REPO, { protocol: 'review-triple' }).protocol, null, 'control: the shipped registry has no review-triple');
  assert.equal(reviewLine(root, { depth: 'triple' }).depth, 'triple', 'the preset carries its own depth label into telemetry');
  assert.equal(reviewLine(REPO, { depth: 'triple' }).depth, null, 'control: the shipped registry has no triple depth');
  assert.deepEqual(derivedVocabularies(root).depth, ['single', 'deep', 'triple'], 'depth lists loosest first');
});

test('C-9: an unreadable protocols.json leaves the settings registry loadable and writes telemetry protocol as null', () => {
  const root = scratchRegistry((file: any) => fs.writeFileSync(file, '{ not json'));
  const loaded = loadSettingsRegistry({ repoRoot: root });
  assert.equal(loaded.ok, true, loaded.detail);
  assert.equal(loaded.registry.enumValues('review.preset'), null);
  assert.equal(loaded.registry.keys.get('review.preset').order, null);
  assert.equal(loadSettingsRegistry({ repoRoot: root, verifyRefs: true }).ok, false, 'the ref check still names the fault');
  const line = reviewLine(root, { protocol: 'review-deep', depth: 'deep', risk: 'HIGH' });
  assert.equal(line.protocol, null);
  assert.equal(line.depth, null);
  assert.equal(line.risk, 'HIGH', 'other vocabularies still apply');
});

test('C-9: protocols.json with no deep preset, or one failing validateProtocols, gives no review.preset values; the ref check names why', () => {
  const noDeep = scratchRegistry((file: any) => {
    const data = shipped();
    data.presets['review-deep'].depth = 'wide';
    fs.writeFileSync(file, JSON.stringify(data));
  });
  assert.equal(loadProtocols({ repoRoot: noDeep }).ok, true, 'a valid protocol registry');
  const loose = loadSettingsRegistry({ repoRoot: noDeep });
  assert.equal(loose.ok, true, loose.detail);
  assert.equal(loose.registry.keys.get('review.preset').order, null);
  assert.equal(loose.registry.enumValues('review.preset'), null, 'a value with no rank is never valid');
  assert.match(loadSettingsRegistry({ repoRoot: noDeep, verifyRefs: true }).detail, /review\.preset orderRef 'protocols\.reviewPresetOrder' does not resolve: core\/registry\/protocols\.json order\.review has no preset of depth 'deep'/);

  const invalid = scratchRegistry((file: any) => {
    const data = shipped();
    data.presets['review-single'].seats[0].lenses.push('SECRET-LENS');
    fs.writeFileSync(file, JSON.stringify(data));
  });
  const detail = loadSettingsRegistry({ repoRoot: invalid, verifyRefs: true }).detail;
  assert.match(detail, /review\.preset valuesRef 'protocols\.reviewPresetIds' does not resolve: core\/registry\/protocols\.json fails validateProtocols \(1 error\(s\)\)/);
  assert.equal(detail.includes('SECRET-LENS'), false, 'no file text in the error');
  assert.equal(reviewLine(invalid, { protocol: 'review-deep' }).protocol, null, 'telemetry reads no list from an invalid registry');
});
