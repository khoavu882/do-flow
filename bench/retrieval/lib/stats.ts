'use strict';

/**
 * Statistics for the retrieval and perf benchmarks (074 IC-010): a seeded PRNG, nearest-rank
 * percentiles, MAD, a bootstrap CI and a paired sign-flip randomization test. Pure functions, no I/O,
 * so a fixed seed gives a fixed result on every machine.
 */

const RESAMPLES = 10000;
const MIN_N = Object.freeze({ ranking: 10, outcome: 3 });

/** FNV-1a, 32 bit, over the UTF-8 bytes of `text`. */
function fnv1a32(text: any) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(text), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Seed of one statistic's stream: `snapshot.seed XOR fnv1a32("<corpus>|<config>|<class>|<metric>")`. */
function streamSeed(seed: any, corpus: any, config: any, cls: any, metric: any) {
  return (seed ^ fnv1a32(`${corpus}|${config}|${cls}|${metric}`)) >>> 0;
}

/** mulberry32: returns a function giving floats in [0, 1). */
function mulberry32(seed: any) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy, drawing from `rng`. */
function shuffle(items: any, rng: any) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function mean(xs: any) {
  if (xs.length === 0) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Nearest rank: sort ascending, p_q = x[ceil(q * n) - 1]. The epsilon absorbs float noise in q * n. */
function percentile(xs: any, q: any) {
  if (xs.length === 0) return null;
  const sorted = xs.slice().sort((a: any, b: any) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length - 1e-9) - 1));
  return sorted[idx];
}

function median(xs: any) {
  if (xs.length === 0) return null;
  const sorted = xs.slice().sort((a: any, b: any) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation: median of |x - median(x)|. */
function mad(xs: any) {
  if (xs.length === 0) return null;
  const m = median(xs);
  return median(xs.map((x: any) => Math.abs(x - m)));
}

/** 95% bootstrap CI of the mean: 10,000 resamples with replacement, 2.5th and 97.5th nearest-rank percentiles. */
function bootstrapCI(values: any, seed: any, resamples = RESAMPLES) {
  const n = values.length;
  if (n === 0) return null;
  const rng = mulberry32(seed);
  const means = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rng() * n)];
    means[r] = sum / n;
  }
  return [percentile(means, 0.025), percentile(means, 0.975)];
}

/** Paired sign-flip test: p = (count(|mean(flipped)| >= |mean(d)|) + 1) / (resamples + 1). */
function pairedRandomization(diffs: any, seed: any, resamples = RESAMPLES) {
  const n = diffs.length;
  if (n === 0) return null;
  const rng = mulberry32(seed);
  const observed = Math.abs(mean(diffs) as number);
  let count = 0;
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rng() < 0.5 ? -diffs[i] : diffs[i];
    if (Math.abs(sum / n) >= observed - 1e-12) count++;
  }
  return (count + 1) / (resamples + 1);
}

/**
 * `{metric, class, a, b, n, diff, ci95, pRandomization}` over the tasks where both configurations
 * defined the metric. `aValues[i]` and `bValues[i]` are the same task; a null in either drops it.
 */
function compare({ metric, cls, corpus, seed, aValues, bValues }: any) {
  const diffs = [];
  for (let i = 0; i < aValues.length; i++) {
    if (aValues[i] != null && bValues[i] != null) diffs.push(aValues[i] - bValues[i]);
  }
  const stream = streamSeed(seed, corpus, 'A-vs-B', cls, metric);
  return {
    metric,
    class: cls,
    a: 'A',
    b: 'B',
    n: diffs.length,
    diff: mean(diffs),
    ci95: bootstrapCI(diffs, stream),
    pRandomization: pairedRandomization(diffs, stream),
  };
}

/** A class is underpowered when it has fewer tasks than the minimum for its kind (`ranking` or `outcome`). */
function underpowered(n: any, kind: any, minN: any = MIN_N) {
  if (!(kind in minN)) throw new Error(`unknown class kind "${kind}"`);
  return n < minN[kind];
}

module.exports = {
  MIN_N,
  RESAMPLES,
  fnv1a32,
  streamSeed,
  mulberry32,
  shuffle,
  mean,
  median,
  percentile,
  mad,
  bootstrapCI,
  pairedRandomization,
  compare,
  underpowered,
};
