'use strict';

// Gate scoring (141 IC-005): turns per-case outcomes and the registry `gate` block into the metrics a verdict stores,
// and those metrics into pass, fail or insufficient-data. Pure: no file, network or clock access, so the bench runner,
// the evaluator and a guard compute the same answer from the same numbers.
//
// A case that gave no valid answer takes the static score and stays in the denominator, so a model is never judged only
// on the cases it answered. The bootstrap is a small copy of bench/retrieval/lib/stats.ts (the runtime may not import
// from bench/); test/runtime/advice-gate-score.test.ts pins the two to the same output for one seed.

interface Gate {
  minCases: number;
  validShareMin: number;
  quality: { lowerBoundAbove: number; confidence: number; resamples: number; seed: number };
  latency: { p95CapMs: Record<string, number> };
}

interface Metrics {
  n: number;
  valid: number;
  validShare: number | null;
  quality: {
    metric: string;
    model: number | null;
    static: number | null;
    delta: number | null;
    ci: [number, number] | null;
    excluded: number;
  };
  latencyMs: { p50: number | null; p95: number | null };
}

interface Judgement {
  result: 'pass' | 'fail' | 'insufficient-data';
  failedChecks: string[];
}

const RERANK_KIND = 'rerank';

/** mulberry32: returns a function giving floats in [0, 1). Same generator as bench/retrieval/lib/stats.ts. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Nearest rank: sort ascending, p_q = x[ceil(q * n) - 1]. The epsilon absorbs float noise in q * n. */
function percentile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length - 1e-9) - 1));
  return sorted[idx];
}

/** Two-sided bootstrap interval of the mean: `resamples` resamples with replacement, nearest-rank end points. */
function bootstrapCI(values: number[], seed: number, resamples: number, confidence: number): [number, number] | null {
  const n = values.length;
  if (n === 0) return null;
  const rng = mulberry32(seed);
  const means = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rng() * n)];
    means[r] = sum / n;
  }
  const tail = (1 - confidence) / 2;
  return [percentile(means, tail) as number, percentile(means, 1 - tail) as number];
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function requireGate(gate: any): Gate {
  const q = gate && gate.quality;
  if (!q || !isNumber(q.confidence) || !(q.confidence > 0 && q.confidence < 1)) throw new TypeError('gate.quality.confidence must be in (0, 1)');
  if (!Number.isInteger(q.resamples) || q.resamples < 1) throw new TypeError('gate.quality.resamples must be a positive integer');
  if (!isNumber(q.seed)) throw new TypeError('gate.quality.seed must be a finite number');
  return gate;
}

/**
 * Per-case quality scores `{ model, static }`, or null when the case is excluded. Choice kinds score 0 or 1. Rerank
 * scores nDCG@5; a case is excluded when the score it needs is null (the static one always, the model one only when the
 * model's answer was valid, since an invalid answer takes the static score).
 */
function scoreCase(c: any, isRerank: boolean): { model: number; static: number } | null {
  if (isRerank) {
    const stat = c.ndcgStatic;
    const model = c.valid === true ? c.ndcgModel : stat;
    if (stat === null || model === null) return null;
    if (!isNumber(stat) || !isNumber(model)) throw new TypeError('ndcgModel and ndcgStatic must be numbers or null');
    return { model, static: stat };
  }
  const stat = c.correctStatic;
  const model = c.valid === true ? c.correctModel : stat;
  if ((stat !== 0 && stat !== 1) || (model !== 0 && model !== 1)) throw new TypeError('correctModel and correctStatic must be 0 or 1');
  return { model, static: stat };
}

/** `cases` -> the metrics block of a verdict. `kind` `rerank` selects nDCG@5 scoring; any other kind scores 0 or 1. */
function summarizeCases(cases: any[], gate: any, kind: string): Metrics {
  if (!Array.isArray(cases)) throw new TypeError('cases must be an array');
  const g = requireGate(gate);
  const isRerank = kind === RERANK_KIND;
  const modelScores: number[] = [];
  const staticScores: number[] = [];
  const diffs: number[] = [];
  const latencies: number[] = [];
  let valid = 0;
  let excluded = 0;
  for (const c of cases) {
    if (typeof c.valid !== 'boolean') throw new TypeError('case.valid must be a boolean');
    if (!isNumber(c.latencyMs) || c.latencyMs < 0) throw new TypeError('case.latencyMs must be a non-negative number');
    if (c.valid) valid++;
    latencies.push(c.latencyMs);
    const s = scoreCase(c, isRerank);
    if (s === null) {
      excluded++;
      continue;
    }
    modelScores.push(s.model);
    staticScores.push(s.static);
    diffs.push(s.model - s.static);
  }
  const n = cases.length;
  return {
    n,
    valid,
    validShare: n === 0 ? null : valid / n,
    quality: {
      metric: isRerank ? 'ndcg@5' : 'accuracy',
      model: mean(modelScores),
      static: mean(staticScores),
      delta: mean(diffs),
      ci: bootstrapCI(diffs, g.quality.seed, g.quality.resamples, g.quality.confidence),
      excluded,
    },
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };
}

/**
 * Metrics (as `summarizeCases` returns, or as a verdict stores them) + `gate` -> result. Every check is evaluated so a
 * report lists each failure. Missing or non-numeric stored figures fail their check instead of throwing.
 */
function judge(metrics: any, gate: any, kind: string): Judgement {
  const m = metrics || {};
  const n = isNumber(m.n) ? m.n : 0;
  if (n < gate.minCases) return { result: 'insufficient-data', failedChecks: ['min-cases'] };
  const failedChecks: string[] = [];
  if (!(isNumber(m.validShare) && m.validShare >= gate.validShareMin)) failedChecks.push('valid-share');
  const ci = m.quality && m.quality.ci;
  if (!(Array.isArray(ci) && isNumber(ci[0]) && ci[0] > gate.quality.lowerBoundAbove)) failedChecks.push('quality');
  const caps = gate.latency.p95CapMs;
  const cap = Object.hasOwn(caps, kind) ? caps[kind] : caps.default;
  const p95 = m.latencyMs && m.latencyMs.p95;
  if (!(isNumber(p95) && p95 <= cap)) failedChecks.push('latency');
  return { result: failedChecks.length === 0 ? 'pass' : 'fail', failedChecks };
}

module.exports = {
  summarizeCases,
  judge,
};
