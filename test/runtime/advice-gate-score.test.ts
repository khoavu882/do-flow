'use strict';

// 141 IC-005: the gate scorer. Pure, so every case here is a table of numbers; no client, file or network is involved.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeCases, judge } = require('../../src/runtime/advice/gate-score.ts');
const stats = require('../../bench/retrieval/lib/stats.ts');

const GATE = {
  minCases: 30,
  validShareMin: 0.99,
  quality: { lowerBoundAbove: 0, nonInferiorityDelta: 0.02, confidence: 0.95, resamples: 2000, seed: 20261106 },
  latency: { p95CapMs: { default: 5000, rerank: 3000 }, ratioMax: 2 },
};

function choiceCase(correctModel: number, correctStatic: number, extra: Record<string, unknown> = {}) {
  return { valid: true, correctModel, correctStatic, latencyMs: 100, ...extra };
}

/** `n` cases where the model is right on every one and the static answer is right on `staticRight` of them. */
function allRight(n: number, staticRight: number) {
  return Array.from({ length: n }, (_, i) => choiceCase(1, i < staticRight ? 1 : 0));
}

test('bootstrap is pinned to bench/retrieval/lib/stats.ts for one seed', () => {
  const cases = Array.from({ length: 40 }, (_, i) => choiceCase(i % 3 === 0 ? 0 : 1, i % 2));
  const diffs = cases.map((c) => c.correctModel - c.correctStatic);
  const gate = { ...GATE, quality: { ...GATE.quality, resamples: 1000, seed: 12345 } };
  const ours = summarizeCases(cases, gate, 'tier').quality.ci;
  assert.deepEqual(ours, stats.bootstrapCI(diffs, 12345, 1000));
  assert.notDeepEqual(ours, summarizeCases(cases, { ...gate, quality: { ...gate.quality, seed: 54321 } }, 'tier').quality.ci);
});

test('the same input and seed give the same interval', () => {
  const cases = allRight(40, 20);
  assert.deepEqual(summarizeCases(cases, GATE, 'tier'), summarizeCases(cases, GATE, 'tier'));
});

test('a failed case is scored as the static answer and stays in the denominator', () => {
  const cases = [
    choiceCase(1, 0),
    choiceCase(1, 0),
    // The model would have been right, but the call failed: it takes the static score (0 here).
    { valid: false, correctModel: 1, correctStatic: 0, latencyMs: 4000 },
    // A failed case where the static answer is right counts as right.
    { valid: false, correctModel: 0, correctStatic: 1, latencyMs: 4000 },
  ];
  const m = summarizeCases(cases, GATE, 'tier');
  assert.equal(m.n, 4);
  assert.equal(m.valid, 2);
  assert.equal(m.validShare, 0.5);
  assert.equal(m.quality.metric, 'accuracy');
  assert.equal(m.quality.model, 0.75);
  assert.equal(m.quality.static, 0.25);
  assert.equal(m.quality.delta, 0.5);
  assert.equal(m.quality.excluded, 0);
});

test('latency percentiles are nearest-rank over all cases, failures included', () => {
  const cases = Array.from({ length: 20 }, (_, i) => ({ valid: i !== 19, correctModel: 1, correctStatic: 1, latencyMs: (i + 1) * 10 }));
  const m = summarizeCases(cases, GATE, 'tier');
  assert.equal(m.latencyMs.p50, 100); // ceil(0.5 * 20) = 10th value
  assert.equal(m.latencyMs.p95, 190); // ceil(0.95 * 20) = 19th value
  const unsorted = summarizeCases([300, 100, 200].map((latencyMs) => choiceCase(1, 1, { latencyMs })), GATE, 'tier');
  assert.equal(unsorted.latencyMs.p50, 200);
  assert.equal(unsorted.latencyMs.p95, 300);
});

test('an empty case list gives null figures, not NaN', () => {
  const m = summarizeCases([], GATE, 'tier');
  assert.equal(m.n, 0);
  assert.equal(m.validShare, null);
  assert.equal(m.quality.ci, null);
  assert.equal(m.quality.delta, null);
  assert.equal(m.latencyMs.p95, null);
});

test('rerank scores nDCG@5, takes the static score for an invalid answer, and counts null scores as excluded', () => {
  const cases = [
    { valid: true, ndcgModel: 0.9, ndcgStatic: 0.5, latencyMs: 1000 },
    { valid: false, ndcgModel: 0.9, ndcgStatic: 0.4, latencyMs: 3000 },
    { valid: true, ndcgModel: null, ndcgStatic: 0.5, latencyMs: 1000 },
    { valid: true, ndcgModel: 0.7, ndcgStatic: null, latencyMs: 1000 },
  ];
  const m = summarizeCases(cases, GATE, 'rerank');
  assert.equal(m.n, 4);
  assert.equal(m.valid, 3);
  assert.equal(m.quality.metric, 'ndcg@5');
  assert.equal(m.quality.excluded, 2);
  assert.ok(Math.abs(m.quality.model - 0.65) < 1e-12);
  assert.ok(Math.abs(m.quality.static - 0.45) < 1e-12);
  assert.ok(Math.abs(m.quality.delta - 0.2) < 1e-12);
  assert.equal(m.latencyMs.p95, 3000);
});

test('summarizeCases refuses malformed input instead of scoring it', () => {
  assert.throws(() => summarizeCases('x', GATE, 'tier'), TypeError);
  assert.throws(() => summarizeCases([choiceCase(2, 0)], GATE, 'tier'), TypeError);
  assert.throws(() => summarizeCases([{ valid: 'yes', correctModel: 1, correctStatic: 1, latencyMs: 1 }], GATE, 'tier'), TypeError);
  assert.throws(() => summarizeCases([choiceCase(1, 1, { latencyMs: -1 })], GATE, 'tier'), TypeError);
  assert.throws(() => summarizeCases([choiceCase(1, 1, { latencyMs: NaN })], GATE, 'tier'), TypeError);
  assert.throws(() => summarizeCases([{ valid: true, ndcgModel: 'a', ndcgStatic: 0.5, latencyMs: 1 }], GATE, 'rerank'), TypeError);
  assert.throws(() => summarizeCases([choiceCase(1, 1)], GATE, 'rerank'), TypeError); // a choice-shaped case is not a rerank case
  assert.throws(() => summarizeCases([], { ...GATE, quality: { ...GATE.quality, resamples: 0 } }, 'tier'), TypeError);
  assert.throws(() => summarizeCases([], { ...GATE, quality: { ...GATE.quality, confidence: 1 } }, 'tier'), TypeError);
  assert.throws(() => summarizeCases([], {}, 'tier'), TypeError);
});

test('judge passes a model that beats the static answer on enough valid, fast cases', () => {
  const m = summarizeCases(allRight(40, 10), GATE, 'tier');
  assert.ok(m.quality.ci[0] > 0);
  assert.deepEqual(judge(m, GATE, 'tier'), { result: 'pass', failedChecks: [] });
});

test('judge reports insufficient-data below minCases, whatever else is true', () => {
  const m = summarizeCases(allRight(29, 0), GATE, 'tier');
  assert.deepEqual(judge(m, GATE, 'tier'), { result: 'insufficient-data', failedChecks: ['min-cases'] });
  assert.equal(judge(summarizeCases(allRight(30, 0), GATE, 'tier'), GATE, 'tier').result, 'pass');
});

test('judge fails valid-share when 2 of 30 cases failed, even if the fallback keeps quality up', () => {
  const cases = allRight(30, 0);
  cases[0] = { valid: false, correctModel: 1, correctStatic: 0, latencyMs: 100 };
  cases[1] = { valid: false, correctModel: 1, correctStatic: 0, latencyMs: 100 };
  const m = summarizeCases(cases, GATE, 'tier');
  assert.ok(Math.abs(m.validShare - 28 / 30) < 1e-12);
  assert.deepEqual(judge(m, GATE, 'tier'), { result: 'fail', failedChecks: ['valid-share'] });
});

test('judge fails quality when the interval reaches zero, and lists every failed check together', () => {
  const noGain = Array.from({ length: 40 }, () => choiceCase(1, 1, { latencyMs: 9000 }));
  const m = summarizeCases(noGain, GATE, 'tier');
  assert.deepEqual(judge(m, GATE, 'tier'), { result: 'fail', failedChecks: ['quality', 'latency'] });
  const worse = { ...m, validShare: 0.5 };
  assert.deepEqual(judge(worse, GATE, 'tier').failedChecks, ['valid-share', 'quality', 'latency']);
});

test('judge uses the per-kind latency cap, falling back to the default', () => {
  const slow = allRight(40, 10).map((c) => ({ ...c, latencyMs: 4000 }));
  assert.equal(judge(summarizeCases(slow, GATE, 'tier'), GATE, 'tier').result, 'pass');
  const slowRerank = slow.map((c) => ({ valid: true, ndcgModel: 0.9, ndcgStatic: 0.5, latencyMs: c.latencyMs }));
  assert.deepEqual(judge(summarizeCases(slowRerank, GATE, 'rerank'), GATE, 'rerank').failedChecks, ['latency']);
  // A kind named like an Object.prototype member has no cap of its own and reads the default.
  assert.equal(judge(summarizeCases(slow, GATE, 'constructor'), GATE, 'constructor').result, 'pass');
});

test('judge accepts stored aggregates and fails (does not throw on) missing or non-numeric figures', () => {
  const stored = { n: 40, validShare: 1, quality: { ci: [0.1, 0.4] }, latencyMs: { p95: 120 } };
  assert.equal(judge(stored, GATE, 'tier').result, 'pass');
  assert.deepEqual(judge({ n: 40 }, GATE, 'tier').failedChecks, ['valid-share', 'quality', 'latency']);
  assert.deepEqual(judge({ ...stored, quality: { ci: [null, 1] }, latencyMs: { p95: 'fast' } }, GATE, 'tier').failedChecks, ['quality', 'latency']);
  assert.equal(judge(null, GATE, 'tier').result, 'insufficient-data');
  assert.equal(judge({ ...stored, quality: { ci: [0, 1] } }, GATE, 'tier').result, 'fail');
});
