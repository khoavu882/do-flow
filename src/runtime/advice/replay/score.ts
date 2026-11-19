'use strict';

// Replay scoring and the bars judge (175 IC-003, IC-004). Pure: no file, network or clock access, so the replay verb, the
// trust evaluator and a guard compute the same answer from the same numbers.
//
// A case where the model gave no usable answer takes the rule's answer and stays in the denominator, so a model is never
// judged only on the cases it answered. Agreement beyond chance is Cohen's kappa; its bounds come from a seeded paired
// bootstrap over case indices, so the model's and the rule's kappa (and their difference) share every resample.
// `mulberry32` and `percentile` are copies of the ones in gate-score.ts (which keeps its own until the old gate is removed).

type Reason = 'timeout' | 'over-budget' | 'unreachable' | 'malformed-reply' | 'split';

/** Why a call produced nothing to score, as the caller observed it. */
const FAILURES = new Set(['timeout', 'unreachable', 'malformed-reply']);

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

/** Nearest rank: sort ascending, p_q = x[ceil(q * n) - 1]. The epsilon absorbs float noise in q * n. */
function percentile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length - 1e-9) - 1));
  return sorted[idx];
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Raw cases -> the answer each one is scored with. A case is `{ label, rule, model, strength?, failure?, latencyMs, id? }`:
 * `model` is the model's pick (null when none came back), `strength` its strength word, `failure` one of `timeout`,
 * `unreachable`, `malformed-reply` when the call itself failed. The effective answer is the model's pick when the reply is
 * valid (a pick that is one of `options`), its strength is not `split` and `latencyMs <= budgetMs`; otherwise it is the
 * rule's answer and the case is a no-answer with its reason, taken in that order (failure, malformed, split, over-budget).
 */
function effectiveAnswers(cases: any[], { options = null, budgetMs }: { options?: string[] | null; budgetMs: number }): any[] {
  if (!Array.isArray(cases)) throw new TypeError('cases must be an array');
  return cases.map((raw: any) => {
    if (typeof raw?.label !== 'string' || typeof raw.rule !== 'string') throw new TypeError('case.label and case.rule must be strings');
    if (!isNumber(raw.latencyMs) || raw.latencyMs < 0) throw new TypeError('case.latencyMs must be a non-negative number');
    const failure = raw.failure ?? null;
    if (failure !== null && !FAILURES.has(failure)) throw new TypeError(`case.failure must be one of ${[...FAILURES].join(', ')}`);
    const valid = failure === null && typeof raw.model === 'string' && (!options || options.includes(raw.model));
    let noAnswer: Reason | null = null;
    if (failure !== null) noAnswer = failure;
    else if (!valid) noAnswer = 'malformed-reply';
    else if (raw.strength === 'split') noAnswer = 'split';
    else if (raw.latencyMs > budgetMs) noAnswer = 'over-budget';
    return {
      id: typeof raw.id === 'string' ? raw.id : null,
      label: raw.label, rule: raw.rule, model: valid ? raw.model : null,
      answer: noAnswer === null ? raw.model : raw.rule,
      valid, noAnswer, latencyMs: raw.latencyMs,
    };
  });
}

/**
 * Cohen's kappa from counts: (n*correct - S) / (n^2 - S) with S = sum over classes of n_answer(c) * n_label(c). This is
 * (p_o - p_e) / (1 - p_e) in integers; null when p_e = 1 (the denominator is 0).
 */
function kappaOf(n: number, correct: number, answered: ArrayLike<number>, labelled: ArrayLike<number>): number | null {
  let sum = 0;
  for (let c = 0; c < answered.length; c++) sum += answered[c] * labelled[c];
  const denominator = n * n - sum;
  return denominator === 0 ? null : (n * correct - sum) / denominator;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Precision and recall of `answers` against `labels` for one class index; null on a zero denominator. */
function classFigures(answers: Int32Array, labels: Int32Array, c: number): { precision: number | null; recall: number | null } {
  let tp = 0; let fp = 0; let fn = 0;
  for (let i = 0; i < labels.length; i++) {
    const a = answers[i] === c;
    const y = labels[i] === c;
    if (a && y) tp++;
    else if (a) fp++;
    else if (y) fn++;
  }
  return { precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
}

/**
 * Cases, the kind's options, the effective bars and the budget -> the figures of design section 5. `bars.statistics` gives
 * the confidence, the resample count and the seed. Nothing here reads a registry; `judge` turns the figures into a standing.
 */
function score(cases: any[], { options, bars, budgetMs }: { options?: string[] | null; bars: any; budgetMs: number }): any {
  const stats = bars?.statistics;
  if (!stats || !isNumber(stats.confidence) || !(stats.confidence > 0 && stats.confidence < 1)) throw new TypeError('bars.statistics.confidence must be in (0, 1)');
  if (!Number.isInteger(stats.resamples) || stats.resamples < 1) throw new TypeError('bars.statistics.resamples must be a positive integer');
  if (!isNumber(stats.seed)) throw new TypeError('bars.statistics.seed must be a finite number');
  const eff = effectiveAnswers(cases, { options, budgetMs });
  const n = eff.length;

  // Classes: the kind's options first, then any other label, rule or answer seen, so a stray value never indexes nothing.
  const classes: string[] = Array.isArray(options) ? [...options] : [];
  const extra = new Set<string>();
  for (const e of eff) for (const value of [e.label, e.rule, e.answer]) if (!classes.includes(value)) extra.add(value);
  classes.push(...[...extra].sort());
  const index = new Map(classes.map((name, i) => [name, i]));
  const k = classes.length;
  const y = new Int32Array(n); const a = new Int32Array(n); const r = new Int32Array(n);
  eff.forEach((e: any, i: number) => { y[i] = index.get(e.label)!; a[i] = index.get(e.answer)!; r[i] = index.get(e.rule)!; });

  const labelled = new Int32Array(k); const answered = new Int32Array(k); const ruled = new Int32Array(k);
  let modelRight = 0; let ruleRight = 0; let worse = 0; let better = 0;
  const worseIds: string[] = [];
  for (let i = 0; i < n; i++) {
    labelled[y[i]]++; answered[a[i]]++; ruled[r[i]]++;
    const mRight = a[i] === y[i];
    const rRight = r[i] === y[i];
    if (mRight) modelRight++;
    if (rRight) ruleRight++;
    if (rRight && !mRight) { worse++; if (eff[i].id !== null) worseIds.push(eff[i].id); }
    if (!rRight && mRight) better++;
  }

  const byReason: Record<string, number> = {};
  let valid = 0;
  for (const e of eff) {
    if (e.valid) valid++;
    if (e.noAnswer !== null) byReason[e.noAnswer] = (byReason[e.noAnswer] || 0) + 1;
  }
  const noAnswerCount = n - eff.filter((e: any) => e.noAnswer === null).length;

  const kappaModel = n === 0 ? null : kappaOf(n, modelRight, answered, labelled);
  const kappaRule = n === 0 ? null : kappaOf(n, ruleRight, ruled, labelled);
  const gain = kappaModel === null || kappaRule === null ? null : kappaModel - kappaRule;

  // Paired bootstrap: one set of resampled indices gives the model's kappa, the rule's kappa and their difference.
  // An undefined kappa in a resample counts as 0.
  let lower: number | null = null;
  let gainLower: number | null = null;
  if (n > 0 && (kappaModel !== null || gain !== null)) {
    const rng = mulberry32(stats.seed);
    const nl = new Int32Array(k); const na = new Int32Array(k); const nr = new Int32Array(k);
    const lowers = new Array<number>(stats.resamples);
    const gains = new Array<number>(stats.resamples);
    for (let s = 0; s < stats.resamples; s++) {
      nl.fill(0); na.fill(0); nr.fill(0);
      let cm = 0; let cr = 0;
      for (let i = 0; i < n; i++) {
        const j = Math.floor(rng() * n);
        nl[y[j]]++; na[a[j]]++; nr[r[j]]++;
        if (a[j] === y[j]) cm++;
        if (r[j] === y[j]) cr++;
      }
      const km = kappaOf(n, cm, na, nl) ?? 0;
      const kr = kappaOf(n, cr, nr, nl) ?? 0;
      lowers[s] = km;
      gains[s] = km - kr;
    }
    const tail = (1 - stats.confidence) / 2;
    if (kappaModel !== null) lower = percentile(lowers, tail);
    if (gain !== null) gainLower = percentile(gains, tail);
  }

  const perClass: Record<string, any> = {};
  const labelCounts: Record<string, number> = {};
  classes.forEach((name, c) => {
    perClass[name] = { model: classFigures(a, y, c), rule: classFigures(r, y, c) };
    labelCounts[name] = labelled[c];
  });

  const latencies = eff.map((e: any) => e.latencyMs);
  let majority = 0;
  for (let c = 0; c < k; c++) majority = Math.max(majority, labelled[c]);

  return {
    n,
    valid,
    validShare: ratio(valid, n),
    noAnswer: { count: noAnswerCount, share: ratio(noAnswerCount, n), byReason },
    accuracy: { model: ratio(modelRight, n), rule: ratio(ruleRight, n) },
    kappa: { model: kappaModel, rule: kappaRule, lower, gain, gainLower },
    perClass,
    labelCounts,
    worse,
    better,
    worseShare: ratio(worse, n),
    worseIds,
    // Yes/no: the smaller label count; choice: n minus the majority label count. For two labels these are the same figure.
    minority: n - majority,
    latencyMs: {
      first: n === 0 ? null : latencies[0],
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: n === 0 ? null : Math.max(...latencies),
    },
  };
}

/**
 * Figures + bars + the kind's budget + the case source -> `{ standing, failedChecks }`. Every check of the stage reached is
 * evaluated, so each failure is listed by name; a missing or non-numeric figure fails its check instead of throwing.
 *   measure-only   the source's label is the rule's answer, so nothing can certify (no checks run)
 *   below-minimum  fewer than show.minCases cases or a minority below show.minMinority (`min-cases`, `min-minority`)
 *   below-show     a show check failed (`kappa-lower`, `not-worse`, `latency`)
 *   show           the show bar holds; failedChecks lists the act checks that did not (`min-cases`, `min-minority`,
 *                  `kappa-gain-lower`, `worse-share`)
 *   act            every show and act check holds
 */
function judge(metrics: any, bars: any, budgetMs: number, source: any): { standing: string; failedChecks: string[] } {
  if (source && source.labelIsRule === true) return { standing: 'measure-only', failedChecks: [] };
  const m = metrics || {};
  const n = isNumber(m.n) ? m.n : 0;
  const minority = isNumber(m.minority) ? m.minority : 0;
  const { show, act } = bars;

  const minimum: string[] = [];
  if (!(n >= show.minCases)) minimum.push('min-cases');
  if (!(minority >= show.minMinority)) minimum.push('min-minority');
  if (minimum.length) return { standing: 'below-minimum', failedChecks: minimum };

  const k = m.kappa || {};
  const belowShow: string[] = [];
  if (!(isNumber(k.lower) && k.lower > show.kappaLowerAbove)) belowShow.push('kappa-lower');
  if (show.notWorseThanRule && !(isNumber(k.model) && isNumber(k.rule) && k.model >= k.rule)) belowShow.push('not-worse');
  const p95 = m.latencyMs && m.latencyMs.p95;
  if (show.p95WithinBudget && !(isNumber(p95) && p95 <= budgetMs)) belowShow.push('latency');
  if (belowShow.length) return { standing: 'below-show', failedChecks: belowShow };

  const belowAct: string[] = [];
  if (!(n >= act.minCases)) belowAct.push('min-cases');
  if (!(minority >= act.minMinority)) belowAct.push('min-minority');
  if (!(isNumber(k.gainLower) && k.gainLower > act.kappaGainLowerAbove)) belowAct.push('kappa-gain-lower');
  if (!(isNumber(m.worseShare) && m.worseShare <= act.maxWorseShare)) belowAct.push('worse-share');
  return { standing: belowAct.length ? 'show' : 'act', failedChecks: belowAct };
}

module.exports = { effectiveAnswers, score, judge, mulberry32, percentile };
