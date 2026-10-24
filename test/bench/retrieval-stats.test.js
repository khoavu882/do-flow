'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../../bench/retrieval/lib/stats.ts');

test('fnv1a32 matches the published vectors', () => {
  assert.equal(stats.fnv1a32(''), 0x811c9dc5);
  assert.equal(stats.fnv1a32('a'), 0xe40c292c);
  assert.equal(stats.fnv1a32('foobar'), 0xbf9cf968);
});

test('streamSeed XORs the snapshot seed with the hash of the stream name', () => {
  const h = stats.fnv1a32('code|A|exact-lookup|recallAt10');
  assert.equal(stats.streamSeed(20261012, 'code', 'A', 'exact-lookup', 'recallAt10'), (20261012 ^ h) >>> 0);
});

test('mulberry32 is deterministic, in [0, 1) and seed-sensitive', () => {
  const a = stats.mulberry32(42);
  const b = stats.mulberry32(42);
  const seqA = Array.from({ length: 5 }, a);
  assert.deepEqual(seqA, Array.from({ length: 5 }, b));
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
  assert.notDeepEqual(seqA, Array.from({ length: 5 }, stats.mulberry32(43)));
  // Pinned first value of the reference algorithm for seed 1.
  assert.equal(stats.mulberry32(1)(), 0.6270739405881613);
});

test('shuffle is a seeded permutation and leaves the input alone', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = stats.shuffle(input, stats.mulberry32(7));
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(out.slice().sort((x, y) => x - y), input);
  assert.deepEqual(out, stats.shuffle(input, stats.mulberry32(7)));
});

test('percentile is nearest rank', () => {
  const xs = [15, 20, 35, 40, 50];
  assert.equal(stats.percentile(xs, 0.05), 15);
  assert.equal(stats.percentile(xs, 0.3), 20);
  assert.equal(stats.percentile(xs, 0.4), 20);
  assert.equal(stats.percentile(xs, 0.5), 35);
  assert.equal(stats.percentile(xs, 1), 50);
  assert.equal(stats.percentile([5, 3, 1, 4, 2], 0.5), 3, 'unsorted input is sorted first');
  assert.equal(stats.percentile([], 0.5), null);
  const ramp = Array.from({ length: 10000 }, (_, i) => i + 1);
  assert.equal(stats.percentile(ramp, 0.975), 9750, '0.975 * 10000 float noise does not shift the rank');
  assert.equal(stats.percentile(ramp, 0.025), 250);
});

test('median and MAD', () => {
  assert.equal(stats.median([3, 1, 2]), 2);
  assert.equal(stats.median([4, 1, 2, 3]), 2.5);
  // median 2; |x - 2| = 1,1,0,0,2,4,7 -> sorted 0,0,1,1,2,4,7 -> median 1
  assert.equal(stats.mad([1, 1, 2, 2, 4, 6, 9]), 1);
  assert.equal(stats.mad([]), null);
});

test('bootstrapCI: fixed seed gives a fixed interval that brackets the mean', () => {
  const xs = [0, 1, 1, 0, 1, 1, 1, 0, 1, 1];
  const ci = stats.bootstrapCI(xs, 99);
  assert.deepEqual(ci, stats.bootstrapCI(xs, 99));
  assert.ok(ci[0] <= 0.7 && 0.7 <= ci[1]);
  assert.ok(ci[0] < ci[1]);
  assert.deepEqual(stats.bootstrapCI([0.5, 0.5, 0.5], 1), [0.5, 0.5], 'no variance, no width');
  assert.equal(stats.bootstrapCI([], 1), null);
});

test('pairedRandomization: no effect gives p = 1, a unanimous effect gives the floor', () => {
  assert.equal(stats.pairedRandomization([0, 0, 0, 0], 5), 1);
  const floor = stats.pairedRandomization(new Array(20).fill(1), 5);
  assert.equal(floor, 1 / 10001);
  const mixed = stats.pairedRandomization([1, -1, 1, -1, 1, -1], 5);
  assert.ok(mixed > 0.9, `symmetric diffs cannot be significant, got ${mixed}`);
});

test('compare drops pairs with a null side and reports the IC-010 object', () => {
  const c = stats.compare({
    metric: 'recallAt10', cls: 'conceptual-discovery', corpus: 'code', seed: 20261012,
    aValues: [1, 1, null, 1, 0, 1], bValues: [0, 1, 1, 0, 0, null],
  });
  assert.deepEqual(Object.keys(c), ['metric', 'class', 'a', 'b', 'n', 'diff', 'ci95', 'pRandomization']);
  assert.equal(c.n, 4);
  assert.equal(c.diff, 0.5);
  assert.equal(c.a, 'A');
  assert.equal(c.b, 'B');
  assert.equal(c.ci95.length, 2);
  assert.ok(c.pRandomization > 0 && c.pRandomization <= 1);
});

test('underpowered applies the minimum n of the class kind', () => {
  assert.equal(stats.underpowered(9, 'ranking'), true);
  assert.equal(stats.underpowered(10, 'ranking'), false);
  assert.equal(stats.underpowered(2, 'outcome'), true);
  assert.equal(stats.underpowered(3, 'outcome'), false);
  assert.equal(stats.underpowered(4, 'ranking', { ranking: 5, outcome: 1 }), true);
  assert.throws(() => stats.underpowered(1, 'other'), /unknown class kind/);
});
