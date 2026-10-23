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

function refuses(mutate, pattern) {
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
  refuses((d) => { d.presets['review-single'].seats[0].lenses.push('vibes'); }, /unknown lens 'vibes'/);
});

test('protocols: a duplicate lens id in the catalogue is refused', () => {
  refuses((d) => { d.lenses.push({ id: 'correctness', description: 'again' }); }, /lens id 'correctness' is duplicated/);
});

test('protocols: an order that omits a preset is refused', () => {
  refuses((d) => { d.order.review = ['review-deep']; }, /order\.review omits preset 'review-single'/);
});

test('protocols: an order that lists a preset of the wrong kind is refused', () => {
  refuses((d) => { d.order.debate.push('review-deep'); }, /order\.debate lists 'review-deep'/);
});

test('protocols: rounds.default above hardRoundCap is refused', () => {
  refuses((d) => { d.presets['review-deep'].rounds.default = 4; }, /rounds\.default must not exceed hardRoundCap/);
});

test('protocols: rounds.min above rounds.default is refused', () => {
  refuses((d) => { d.presets['review-deep'].rounds.min = 3; }, /rounds\.min must not exceed rounds\.default/);
});

test('protocols: synthesizer seat on a two-seat preset is refused', () => {
  refuses((d) => { d.presets['review-deep'].synthesizer = 'seat'; }, /'seat' is only valid on a one-seat preset/);
});

test('protocols: a review preset without depth is refused, and depth is unique and review-only', () => {
  refuses((d) => { delete d.presets['review-single'].depth; }, /presets\.review-single\.depth is required/);
  refuses((d) => { d.presets['review-single'].depth = 'deep'; }, /depth 'deep' duplicates/);
  refuses((d) => { d.presets['debate-2'].depth = 'x'; }, /presets\.debate-2\.depth is not allowed/);
});

test('protocols: an invariant without enforcedBy is refused', () => {
  refuses((d) => { delete d.invariants[0].enforcedBy; }, /invariants\[0\]\.enforcedBy/);
});

test('protocols: a bad invariant id, a duplicate seat id, a bad family and a bad preset id are refused', () => {
  refuses((d) => { d.invariants[0].id = 'RULE-1'; }, /invariants\[0\]\.id must match/);
  refuses((d) => { d.presets['review-deep'].seats[1].id = 'seat-a'; }, /seat id 'seat-a' is duplicated/);
  refuses((d) => { d.presets['review-single'].seats[0].model.family = 'other'; }, /model\.family must be one of/);
  refuses((d) => { d.presets.Bad_Id = structuredClone(d.presets['debate-2']); d.order.debate.push('Bad_Id'); }, /id must match/);
});

test('protocols: unknown keys are refused at every level', () => {
  refuses((d) => { d.extra = 1; }, /registry has unknown key 'extra'/);
  refuses((d) => { d.presets['debate-2'].extra = 1; }, /presets\.debate-2 has unknown key 'extra'/);
  refuses((d) => { d.presets['debate-2'].seats[0].extra = 1; }, /seats\[0\] has unknown key 'extra'/);
  refuses((d) => { d.presets['debate-2'].rounds.extra = 1; }, /rounds has unknown key 'extra'/);
  refuses((d) => { d.invariants[0].extra = 1; }, /invariants\[0\] has unknown key 'extra'/);
});

test('protocols: schema must be 1 and a non-object is refused', () => {
  refuses((d) => { d.schema = 2; }, /schema must be 1/);
  assert.equal(validateProtocols(null).ok, false);
});
