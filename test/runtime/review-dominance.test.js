'use strict';
// 122 IC-014: `dominates(P, B, context)`, the pure strictness comparison between two presets.
// P dominates B when an injective seat matching from B's seats into P's seats exists (lens superset,
// family at least as strict, tier at least as high), rounds default and min are each at least B's,
// crossAnswer holds where B's does, the synthesizer is at least as strong and the decider is equal.
// Fixtures come from an in-memory copy of the shipped (merged) protocol registry and the core tier list.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dominates } = require('../../src/runtime/review/dominance.ts');

const REPO = path.resolve(__dirname, '../..');
// The effective registry: `debate-3` is contributed by the bundled package `doflow` (122 A.6), not held by protocols.json.
const registry = structuredClone(require('../../src/runtime/review/protocols.ts').loadProtocols().registry);
const models = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'models.json'), 'utf8'));
const context = { tiers: models.dispatchTiers.tiers, synthesizerStrength: registry.synthesizerStrength };
const preset = (id) => structuredClone(registry.presets[id]);
const seat = (id, lenses, tier = 'frontier', family) => ({ id, agent: 'reviewer', lenses, model: { tier, ...(family ? { family } : {}) } });

test('dominance: review-deep dominates review-single, and not the reverse', () => {
  assert.equal(dominates(preset('review-deep'), preset('review-single'), context), true);
  assert.equal(dominates(preset('review-single'), preset('review-deep'), context), false);
});

test('dominance: debate-3 dominates debate-2, and not the reverse', () => {
  assert.equal(dominates(preset('debate-3'), preset('debate-2'), context), true);
  assert.equal(dominates(preset('debate-2'), preset('debate-3'), context), false);
});

test('dominance: one more seat and one fewer round dominates neither way', () => {
  const wider = preset('review-deep');
  wider.seats.push(seat('seat-c', ['correctness', 'test-honesty', 'boundaries']));
  wider.rounds = { default: 1, min: 1 };
  assert.equal(dominates(wider, preset('review-deep'), context), false);
  assert.equal(dominates(preset('review-deep'), wider, context), false);
});

test('dominance: every preset dominates itself (the relation is reflexive)', () => {
  for (const id of Object.keys(registry.presets)) assert.equal(dominates(preset(id), preset(id), context), true, id);
});

test('dominance: the seat matching is injective and found even where a first-fit pass fails', () => {
  const base = preset('review-deep');
  base.seats = [seat('b1', ['correctness']), seat('b2', ['correctness', 'boundaries'])];
  const strong = preset('review-deep');
  // First-fit maps b1 to p1 and then finds no seat for b2; the matching b1->p2, b2->p1 exists.
  strong.seats = [seat('p1', ['correctness', 'boundaries']), seat('p2', ['correctness'])];
  assert.equal(dominates(strong, base, context), true);
  const oneSeat = preset('review-deep');
  oneSeat.seats = [seat('p1', ['correctness', 'boundaries'])];
  assert.equal(dominates(oneSeat, base, context), false, 'one P seat cannot cover two B seats');
});

test('dominance: each seat axis and each scalar field can break it', () => {
  const base = preset('review-deep');
  const cases = [
    ['a lens missing from every candidate seat', (p) => { p.seats[1].lenses = ['correctness', 'boundaries']; }],
    ['a looser family', (p) => { p.seats[0].model.family = 'any'; }],
    ['an absent family reads as any', (p) => { delete p.seats[0].model.family; }],
    ['a lower tier', (p) => { p.seats[0].model.tier = 'standard'; }],
    ['an unknown tier', (p) => { p.seats[0].model.tier = 'ultra'; }],
    ['fewer default rounds', (p) => { p.rounds = { default: 1, min: 1 }; }],
    ['a lower rounds.min', (p) => { p.rounds = { default: 2, min: 1 }; }],
    ['no cross-answer where B has it', (p) => { p.crossAnswer = false; }],
    ['a weaker synthesizer', (p) => { p.synthesizer = 'none'; }],
    ['an unknown synthesizer', (p) => { p.synthesizer = 'vibes'; }],
    ['another decider', (p) => { p.decider = 'orchestrator'; }],
    ['another kind', (p) => { p.kind = 'debate'; }],
  ];
  for (const [name, mutate] of cases) {
    const p = preset('review-deep');
    mutate(p);
    assert.equal(dominates(p, base, context), false, name);
  }
  const stricter = preset('review-deep');
  stricter.seats[1].model.family = 'different-from-author';
  assert.equal(dominates(stricter, base, context), true, 'a stricter family still dominates');
  const verifier = preset('review-deep');
  verifier.synthesizer = 'verifier';
  assert.equal(dominates(verifier, base, context), true, 'verifier and separate are equal on the lattice');
});

test('dominance: a malformed preset or context never throws and never dominates', () => {
  assert.equal(dominates(null, preset('review-single'), context), false);
  assert.equal(dominates(preset('review-deep'), {}, context), false);
  assert.equal(dominates(preset('review-deep'), preset('review-single'), {}), false);
});
