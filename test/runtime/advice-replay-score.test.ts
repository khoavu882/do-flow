'use strict';

// 175 T1 (IC-003, IC-004): the replay scorer and the bars judge. Pure, so every case here is a table of numbers worked by
// hand; the arithmetic sits beside each expected figure. No client, file, clock or network is involved.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { effectiveAnswers, score, judge, mulberry32, percentile } = require('../../src/runtime/advice/replay/score.ts');

const YESNO = ['yes', 'no'];
const BARS = {
  statistics: { confidence: 0.95, resamples: 2000, seed: 20261119 },
  show: { minCases: 30, minMinority: 10, kappaLowerAbove: 0, notWorseThanRule: true, p95WithinBudget: true },
  act: { minCases: 100, minMinority: 25, kappaGainLowerAbove: 0, maxWorseShare: 0.02 },
};
const BUDGET = 1000;
const NOT_RULE = { labelIsRule: false };

function c(label: string, rule: string, model: string | null, extra: any = {}) {
  return { label, rule, model, latencyMs: 10, ...extra };
}

/** `count` copies of one case. */
function times(count: number, make: () => any) {
  return Array.from({ length: count }, make);
}

function close(actual: number | null, expected: number, message?: string) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-12, `${message || 'value'}: ${actual} != ${expected}`);
}

describe('score: agreement figures', () => {
  test('(a) a 2x2 table with kappa 0.4 exactly, and per-class precision and recall', () => {
    // n = 20. label yes: 7 answered yes, 3 answered no. label no: 3 answered yes, 7 answered no. The rule is the label.
    // Correct answers 7 + 7 = 14, so accuracy 14/20 = 0.7. Answer yes 10, answer no 10, label yes 10, label no 10.
    // Sum of n_a * n_y = 10*10 + 10*10 = 200. kappa = (20*14 - 200) / (400 - 200) = 80 / 200 = 0.4.
    // yes: TP 7, FP 3, FN 3 -> precision 7/10, recall 7/10. The rule is always right: kappa (20*20 - 200) / 200 = 1.
    const cases = [
      ...times(7, () => c('yes', 'yes', 'yes')), ...times(3, () => c('yes', 'yes', 'no')),
      ...times(3, () => c('no', 'no', 'yes')), ...times(7, () => c('no', 'no', 'no')),
    ];
    const m = score(cases, { options: YESNO, bars: BARS, budgetMs: BUDGET });
    assert.equal(m.n, 20);
    close(m.accuracy.model, 0.7);
    close(m.accuracy.rule, 1);
    close(m.kappa.model, 0.4);
    close(m.kappa.rule, 1);
    close(m.kappa.gain, -0.6);
    close(m.perClass.yes.model.precision, 0.7);
    close(m.perClass.yes.model.recall, 0.7);
    close(m.perClass.no.model.precision, 0.7);
    close(m.perClass.yes.rule.precision, 1);
    close(m.perClass.yes.rule.recall, 1);
    assert.deepEqual(m.labelCounts, { yes: 10, no: 10 });
  });

  test('(a) an asymmetric table keeps precision and recall apart; a zero denominator is null', () => {
    // label yes x4: 3 answered yes, 1 answered no. label no x3: 2 answered yes, 1 answered no.
    // yes: TP 3, FP 2 (label no, answered yes), FN 1 -> precision 3/5, recall 3/4.
    // no:  TP 1, FP 1 (label yes, answered no), FN 2 -> precision 1/2, recall 1/3.
    const cases = [
      ...times(3, () => c('yes', 'yes', 'yes')), c('yes', 'yes', 'no'),
      ...times(2, () => c('no', 'no', 'yes')), c('no', 'no', 'no'),
    ];
    const m = score(cases, { options: YESNO, bars: BARS, budgetMs: BUDGET });
    close(m.perClass.yes.model.precision, 3 / 5);
    close(m.perClass.yes.model.recall, 3 / 4);
    close(m.perClass.no.model.precision, 1 / 2);
    close(m.perClass.no.model.recall, 1 / 3);

    // Three options; two cases have label c and the model never answers c: c has no answers, so precision is 0/0 = null.
    const three = [c('a', 'a', 'a'), c('b', 'b', 'b'), c('c', 'c', 'a'), c('c', 'c', 'b')];
    const t = score(three, { options: ['a', 'b', 'c'], bars: BARS, budgetMs: BUDGET });
    assert.equal(t.perClass.c.model.precision, null);
    close(t.perClass.c.model.recall, 0);
    close(t.perClass.c.rule.precision, 1);
  });

  test('(b) when chance agreement is 1 kappa is null, and the kappa checks all fail', () => {
    // 40 cases, every label, rule and answer is yes: p_e = (40/40) * (40/40) = 1, so the denominator n^2 - 1600 is 0.
    const cases = times(40, () => c('yes', 'yes', 'yes'));
    const m = score(cases, { options: YESNO, bars: BARS, budgetMs: BUDGET });
    assert.equal(m.kappa.model, null);
    assert.equal(m.kappa.rule, null);
    assert.equal(m.kappa.lower, null);
    assert.equal(m.kappa.gain, null);
    assert.equal(m.kappa.gainLower, null);
    // The minority is 0, so the verdict is below-minimum; with the minimum bars lowered the kappa checks are reached.
    const lowered = { ...BARS, show: { ...BARS.show, minMinority: 0 } };
    const j = judge(m, lowered, BUDGET, NOT_RULE);
    assert.equal(j.standing, 'below-show');
    assert.ok(j.failedChecks.includes('kappa-lower'));
    assert.ok(j.failedChecks.includes('not-worse'));
  });

  test('(g) the minority of a yes/no kind is the smaller label count; of a choice kind it is n minus the majority', () => {
    // yes 12, no 8 -> min = 8.
    const yn = [...times(12, () => c('yes', 'yes', 'yes')), ...times(8, () => c('no', 'no', 'no'))];
    assert.equal(score(yn, { options: YESNO, bars: BARS, budgetMs: BUDGET }).minority, 8);
    // Labels a 6, b 3, c 1 -> n 10, majority 6, minority 10 - 6 = 4 (not min(6,3,1) = 1).
    const choice = [...times(6, () => c('a', 'a', 'a')), ...times(3, () => c('b', 'b', 'b')), c('c', 'c', 'c')];
    assert.equal(score(choice, { options: ['a', 'b', 'c'], bars: BARS, budgetMs: BUDGET }).minority, 4);
    // One label only -> n - n = 0.
    assert.equal(score(times(5, () => c('a', 'a', 'a')), { options: ['a', 'b'], bars: BARS, budgetMs: BUDGET }).minority, 0);
  });

  test('an empty case list gives null figures, never a throw', () => {
    const m = score([], { options: YESNO, bars: BARS, budgetMs: BUDGET });
    assert.equal(m.n, 0);
    assert.equal(m.accuracy.model, null);
    assert.equal(m.kappa.model, null);
    assert.equal(m.kappa.lower, null);
    assert.equal(m.latencyMs.p95, null);
    assert.equal(judge(m, BARS, BUDGET, NOT_RULE).standing, 'below-minimum');
  });
});

describe('score: no-answer cases take the rule', () => {
  test('(c) each reason takes the rule answer, stays in the denominator and is never worse', () => {
    // The rule is right (rule = label = yes) and the model's reported pick is wrong (no). Each case would be "worse" if the
    // model's pick counted; every one is a no-answer, so the effective answer is the rule's and nothing is worse.
    const cases = [
      c('yes', 'yes', 'no', { failure: 'timeout', latencyMs: 1500 }),
      c('yes', 'yes', null, { failure: 'unreachable' }),
      c('yes', 'yes', null, { failure: 'malformed-reply' }),
      c('yes', 'yes', 'no', { strength: 'split' }),
      c('yes', 'yes', 'no', { latencyMs: 1001 }),
      c('yes', 'yes', 'no', { latencyMs: 1000 }),
    ];
    const eff = effectiveAnswers(cases, { options: YESNO, budgetMs: BUDGET });
    assert.deepEqual(eff.map((e: any) => e.noAnswer), ['timeout', 'unreachable', 'malformed-reply', 'split', 'over-budget', null]);
    assert.deepEqual(eff.map((e: any) => e.answer), ['yes', 'yes', 'yes', 'yes', 'yes', 'no']);
    const m = score(cases, { options: YESNO, bars: BARS, budgetMs: BUDGET });
    assert.equal(m.n, 6);
    assert.equal(m.worse, 1); // only the last case (latency exactly at the budget is answered; its pick no is wrong)
    assert.equal(m.noAnswer.count, 5);
    close(m.noAnswer.share, 5 / 6);
    assert.deepEqual(m.noAnswer.byReason, { timeout: 1, 'over-budget': 1, unreachable: 1, 'malformed-reply': 1, split: 1 });
    // A valid reply came back in time for the split, over-budget and exactly-at-budget cases: 3 of 6. A timeout,
    // an unreachable endpoint and a malformed reply are not valid replies.
    close(m.validShare, 3 / 6);
  });

  test('a model answer that is not one of the options is a malformed reply', () => {
    const eff = effectiveAnswers([c('yes', 'yes', 'maybe')], { options: YESNO, budgetMs: BUDGET });
    assert.equal(eff[0].noAnswer, 'malformed-reply');
    assert.equal(eff[0].answer, 'yes');
  });
});

describe('score: worse, better and the bootstrap', () => {
  // 12 cases, rule right on 8 and wrong on 4.
  //   rule right, model right x5 (neither)        rule right, model wrong x3 (worse)
  //   rule wrong, model right x3 (better)         rule wrong, model wrong x1 (neither)
  const planted = [
    ...times(5, () => c('yes', 'yes', 'yes')),
    ...times(3, (() => { let i = 0; return () => c('no', 'no', 'yes', { id: `w${i++}` }); })()),
    ...times(3, () => c('yes', 'no', 'yes')),
    c('no', 'yes', 'yes'),
  ];

  test('(d) worse and better counts, the worse share and the worse ids', () => {
    const m = score(planted, { options: YESNO, bars: BARS, budgetMs: BUDGET });
    assert.equal(m.worse, 3);
    assert.equal(m.better, 3);
    close(m.worseShare, 3 / 12);
    assert.deepEqual(m.worseIds, ['w0', 'w1', 'w2']);
    // Model right on the first group (5) and the third (3) = 8; rule right on the first (5) and the second (3) = 8.
    close(m.accuracy.model, 8 / 12);
    close(m.accuracy.rule, 8 / 12);
  });

  test('(e) the bootstrap lower bound is identical for one seed and differs for another', () => {
    const cases = [
      ...times(30, () => c('yes', 'yes', 'yes')), ...times(8, () => c('yes', 'yes', 'no')),
      ...times(10, () => c('no', 'no', 'no')), ...times(9, () => c('no', 'no', 'yes')),
      ...times(5, () => c('yes', 'no', 'yes')), ...times(3, () => c('no', 'yes', 'no')),
    ];
    const run = (seed: number) => score(cases, { options: YESNO, bars: { ...BARS, statistics: { ...BARS.statistics, seed } }, budgetMs: BUDGET });
    const one = run(7);
    const again = run(7);
    const other = run(8);
    assert.equal(one.kappa.lower, again.kappa.lower);
    assert.equal(one.kappa.gainLower, again.kappa.gainLower);
    assert.notEqual(one.kappa.lower, other.kappa.lower);
    assert.notEqual(one.kappa.gainLower, other.kappa.gainLower);
  });

  test('the lower bound equals an independent resampling with the same generator', () => {
    const cases = [
      ...times(9, () => c('yes', 'yes', 'yes')), ...times(3, () => c('yes', 'yes', 'no')),
      ...times(6, () => c('no', 'no', 'no')), ...times(2, () => c('no', 'no', 'yes')),
    ];
    const statistics = { confidence: 0.9, resamples: 1000, seed: 99 };
    const m = score(cases, { options: YESNO, bars: { ...BARS, statistics }, budgetMs: BUDGET });
    // Reference: draw n indices per resample with floor(rng() * n), kappa by the integer formula, undefined -> 0.
    const rng = mulberry32(statistics.seed);
    const kappas: number[] = [];
    const n = cases.length;
    for (let r = 0; r < statistics.resamples; r++) {
      let ny = 0; let na = 0; let correct = 0;
      for (let i = 0; i < n; i++) {
        const pick = cases[Math.floor(rng() * n)];
        if (pick.label === 'yes') ny++;
        if (pick.model === 'yes') na++;
        if (pick.model === pick.label) correct++;
      }
      const sum = na * ny + (n - na) * (n - ny);
      const denominator = n * n - sum;
      kappas.push(denominator === 0 ? 0 : (n * correct - sum) / denominator);
    }
    kappas.sort((a, b) => a - b);
    // Nearest rank at tail (1 - 0.9) / 2 = 0.05: index ceil(0.05 * 1000) - 1 = 49.
    close(m.kappa.lower, kappas[49]);
  });

  test('mulberry32 is deterministic and percentile is nearest rank', () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    assert.equal(a(), b());
    assert.ok(a() < 1);
    // Nearest rank: p50 of [1,2,3,4] is x[ceil(2) - 1] = 2; p95 is x[ceil(3.8) - 1] = 4; empty -> null.
    assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
    assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
    assert.equal(percentile([], 0.5), null);
  });

  test('latency covers every asked case, including a timeout at its elapsed time', () => {
    // Latencies 100, 200, 300, 400, 5000 (the last a timeout). first 100; p50 = x[ceil(2.5) - 1] = 300; p95 = x[ceil(4.75) - 1] = 5000; max 5000.
    const cases = [100, 200, 300, 400].map((ms) => c('yes', 'yes', 'yes', { latencyMs: ms }))
      .concat([c('yes', 'yes', null, { failure: 'timeout', latencyMs: 5000 })]);
    const m = score(cases, { options: YESNO, bars: BARS, budgetMs: BUDGET });
    assert.deepEqual(m.latencyMs, { first: 100, p50: 300, p95: 5000, max: 5000 });
  });
});

describe('judge: the standing', () => {
  // A metrics block that clears every show and act bar; each case below breaks one figure.
  function metrics(overrides: any = {}) {
    return {
      n: 120, minority: 40,
      kappa: { model: 0.7, rule: 0.5, lower: 0.5, gain: 0.2, gainLower: 0.05 },
      worseShare: 0.01,
      latencyMs: { first: 100, p50: 200, p95: 900, max: 1000 },
      ...overrides,
    };
  }
  const run = (m: any, bars: any = BARS, source: any = NOT_RULE) => judge(m, bars, BUDGET, source);

  test('(f) measure-only when the label is the rule, whatever the figures', () => {
    assert.deepEqual(run(metrics(), BARS, { labelIsRule: true }), { standing: 'measure-only', failedChecks: [] });
    assert.equal(run(metrics({ n: 3 }), BARS, { labelIsRule: true }).standing, 'measure-only');
  });

  test('(f) below-minimum at n = 29 and at minority 9, each listed by name', () => {
    assert.deepEqual(run(metrics({ n: 29 })), { standing: 'below-minimum', failedChecks: ['min-cases'] });
    assert.deepEqual(run(metrics({ n: 30, minority: 9 })), { standing: 'below-minimum', failedChecks: ['min-minority'] });
    assert.deepEqual(run(metrics({ n: 29, minority: 9 })), { standing: 'below-minimum', failedChecks: ['min-cases', 'min-minority'] });
    assert.equal(run(metrics({ n: 30, minority: 10, worseShare: 0.5 })).standing, 'show');
  });

  test('(f) below-show for each show check failing alone', () => {
    assert.deepEqual(run(metrics({ kappa: { model: 0.7, rule: 0.5, lower: 0, gain: 0.2, gainLower: 0.05 } })), { standing: 'below-show', failedChecks: ['kappa-lower'] });
    assert.deepEqual(run(metrics({ kappa: { model: 0.4, rule: 0.5, lower: 0.2, gain: -0.1, gainLower: 0.05 } })), { standing: 'below-show', failedChecks: ['not-worse'] });
    assert.deepEqual(run(metrics({ latencyMs: { first: 1, p50: 1, p95: 1001, max: 1001 } })), { standing: 'below-show', failedChecks: ['latency'] });
    // Two failing together are both listed.
    const both = run(metrics({ kappa: { model: 0.4, rule: 0.5, lower: -0.1, gain: -0.1, gainLower: 0.05 } }));
    assert.deepEqual(both.failedChecks, ['kappa-lower', 'not-worse']);
  });

  test('(f) a show check the bars switch off is not evaluated', () => {
    const off = { ...BARS, show: { ...BARS.show, notWorseThanRule: false, p95WithinBudget: false } };
    const m = metrics({ kappa: { model: 0.4, rule: 0.5, lower: 0.2, gain: -0.1, gainLower: 0.05 }, latencyMs: { first: 1, p50: 1, p95: 5000, max: 5000 } });
    // With both checks off the same figures clear the show bar (and the act figures given), so nothing below-show is listed.
    assert.deepEqual(run(m, off), { standing: 'act', failedChecks: [] });
    assert.deepEqual(run(m).failedChecks, ['not-worse', 'latency']);
  });

  test('(f) show with each act check failing alone; act when all pass', () => {
    assert.deepEqual(run(metrics({ n: 99 })), { standing: 'show', failedChecks: ['min-cases'] });
    assert.deepEqual(run(metrics({ minority: 24 })), { standing: 'show', failedChecks: ['min-minority'] });
    assert.deepEqual(run(metrics({ kappa: { model: 0.7, rule: 0.5, lower: 0.5, gain: 0.2, gainLower: 0 } })), { standing: 'show', failedChecks: ['kappa-gain-lower'] });
    assert.deepEqual(run(metrics({ worseShare: 0.0201 })), { standing: 'show', failedChecks: ['worse-share'] });
    assert.deepEqual(run(metrics()), { standing: 'act', failedChecks: [] });
    // Exactly at the act bars: n 100, minority 25, worse share 0.02 pass; gain lower must be strictly above.
    assert.equal(run(metrics({ n: 100, minority: 25, worseShare: 0.02 })).standing, 'act');
  });

  test('missing or non-numeric figures fail their checks and never throw', () => {
    const j = run({ n: 120, minority: 40 });
    assert.equal(j.standing, 'below-show');
    assert.deepEqual(j.failedChecks, ['kappa-lower', 'not-worse', 'latency']);
    assert.equal(run(null).standing, 'below-minimum');
    assert.equal(run(metrics({ kappa: { model: 0.7, rule: 0.5, lower: 0.5, gain: 0.2, gainLower: null } })).standing, 'show');
  });

  test('score output feeds judge: a clean planted set reaches act', () => {
    // 150 cases, labels yes 75 / no 75 (minority 75). The model is right on every case; the rule is right on 100 of them.
    // Model kappa is 1; rule accuracy 100/150 with balanced marginals is kappa 1/3; the gain is 2/3, far above 0 for any resample.
    const cases = [
      ...times(50, () => c('yes', 'yes', 'yes')), ...times(50, () => c('no', 'no', 'no')),
      ...times(25, () => c('yes', 'no', 'yes')), ...times(25, () => c('no', 'yes', 'no')),
    ];
    const m = score(cases, { options: YESNO, bars: BARS, budgetMs: BUDGET });
    close(m.kappa.model, 1);
    close(m.kappa.rule, 1 / 3);
    assert.equal(m.worse, 0);
    assert.equal(m.better, 50);
    assert.deepEqual(judge(m, BARS, BUDGET, NOT_RULE), { standing: 'act', failedChecks: [] });
  });
});
