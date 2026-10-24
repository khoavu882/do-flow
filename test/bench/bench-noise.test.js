'use strict';

// 096 A.1: bench/noise.ts, the pure noise-floor module (IC-001, IC-002, IC-004, IC-007, IC-008).
// Everything here runs in memory: no fixture files, no runner, no spawn.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stats = require('../../bench/retrieval/lib/stats.ts');
const noise = require('../../bench/noise.ts');

const {
  EPS, MIN_PAIRED_CASES, loadNoiseConfig, classifyRun, computeNoise, ruleVerdict, decide,
  overfitFlag, buildDecision, validateNoiseArtifact, validateDecision,
} = noise;

const MODULE_FILE = path.join(__dirname, '..', '..', 'bench', 'noise.ts');

// ---------------------------------------------------------------------------
// Fixtures

/** Eight cases: four train (triggering), four heldout (behavioral). */
const META = {
  'a/1': ['triggering', 'train'], 'a/2': ['triggering', 'train'], 'a/3': ['triggering', 'train'], 'a/4': ['triggering', 'train'],
  'b/1': ['behavioral', 'heldout'], 'b/2': ['behavioral', 'heldout'], 'b/3': ['behavioral', 'heldout'], 'b/4': ['behavioral', 'heldout'],
};
const TRAIN = ['a/1', 'a/2', 'a/3', 'a/4'];
const HELDOUT = ['b/1', 'b/2', 'b/3', 'b/4'];

/** One repeat. A number is a pass rate; a string is an exclusion mark; null is an undecided model run. */
function repeatOf(iteration, values, { model = 'claude-test', commit = 'c0ffee' } = {}) {
  const runs = {};
  for (const [key, value] of Object.entries(values)) {
    const [kind, split] = META[key] || ['behavioral', 'train'];
    runs[key] = typeof value === 'string'
      ? { kind, split, passRate: null, excluded: value }
      : { kind, split, passRate: value, excluded: null };
  }
  return { iteration, model, commit, runs };
}

function fill(train, heldout) {
  return Object.fromEntries([...TRAIN.map((k, i) => [k, Array.isArray(train) ? train[i] : train]),
    ...HELDOUT.map((k, i) => [k, Array.isArray(heldout) ? heldout[i] : heldout])]);
}

/** Corpus repeat means 0.75, 0.8125, 0.6875: noise 0.125, baselineMean 0.75. */
const KNOWN = [
  repeatOf('base-r1', fill(0.5, 1)),
  repeatOf('base-r2', fill([0.5, 0.5, 0.5, 1], 1)),
  repeatOf('base-r3', fill(0.5, [1, 1, 1, 0.5])),
];

const CONFIG = Object.freeze({ k: 3, mde: 0.05, headroom: 0.95, maxInfraShare: 0.1, seed: 96 });
const RERUN = Object.freeze({ runs: 24, differing: [], stale: [] });

function noiseOf(repeats, config = {}, graderRerun = RERUN) {
  return computeNoise({ repeats, config: { ...CONFIG, ...config }, graderRerun });
}

/** Per-case score lists: n cases whose every repeat is `b` on the baseline and `c` on the candidate. */
function sides(n, b, c, k = 3) {
  const baseline = {}; const candidate = {};
  for (let i = 0; i < n; i++) {
    const key = `s/${String(i).padStart(2, '0')}`;
    baseline[key] = Array(k).fill(b);
    candidate[key] = Array(k).fill(c);
  }
  return { baseline, candidate };
}

function decideOf({ n = 4, b = 0.5, c = 0.5, noise: band = 0.125, mde = 0.05, maxInfraShare = 0.1, excluded, precondition = null, scope = 'corpus', ...rest } = {}) {
  const s = sides(n, b, c);
  const baseline = rest.baseline || s.baseline;
  const candidate = rest.candidate || s.candidate;
  return decide({
    scope, baseline, candidate,
    excluded: excluded || {
      baseline: { runs: Object.keys(baseline).length * 3, excluded: 0 },
      candidate: { runs: Object.keys(candidate).length * 3, excluded: 0 },
    },
    noise: band, mde, maxInfraShare, seed: 96, precondition,
  });
}

/** The IC-007 worked-example numbers: noise 0.03, mde 0.05 (band 0.05), n 46, shares 0. */
function rule(overrides) {
  return ruleVerdict({
    precondition: null, noise: 0.03, mde: 0.05, maxInfraShare: 0.1,
    infraShare: { baseline: 0, candidate: 0 }, n: 46, gain: 0, ci95: [-0.01, 0.01], ...overrides,
  });
}

const BASELINE_FILE = {
  model: 'claude-test', commit: 'c0ffee',
  results: Object.entries(META).map(([key, [kind, split]]) => ({ key, kind, split, passRate: 0.5 })),
};

/** A band with zero A/A noise: train 0.5, heldout 0.75 in every repeat. */
function flatArtifact(config = {}) {
  const r = (i) => repeatOf(`base-r${i}`, fill(0.5, 0.75));
  return noiseOf([r(1), r(2), r(3)], config);
}

function decisionOf({ noise: artifact = flatArtifact(), noiseFile, candidate, baselineFile = BASELINE_FILE, model = 'claude-test', thresholds = CONFIG } = {}) {
  const cand = candidate || [1, 2, 3].map((i) => repeatOf(`cand-r${i}`, fill(1, 0.75), { commit: 'beef' }));
  return buildDecision({
    noise: artifact,
    noiseFile: noiseFile !== undefined ? noiseFile : artifact ? { path: 'bench/baseline/noise.json', sha256: 'ab'.repeat(32) } : null,
    baselineFile, model, candidate: cand, thresholds,
  });
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// IC-001 exports

test('exports are the section 5 lists', () => {
  assert.deepEqual(noise.NOISE_VERDICTS, ['inconclusive', 'grader-unstable', 'no-headroom', 'noise-exceeds-mde', 'usable']);
  assert.deepEqual(noise.DECISION_VERDICTS, ['gain-above-noise', 'within-noise', 'regression', 'inconclusive']);
  assert.deepEqual(noise.RECOMMENDATIONS, ['merge-candidate', 'do-not-merge']);
  assert.deepEqual(noise.INFRA_CLASSES, ['timeout', 'api-error', 'truncated', 'no-output']);
  assert.deepEqual(noise.RUN_STATUSES, ['completed', 'timeout', 'api-error', 'truncated']);
  assert.deepEqual(noise.NOISE_METHODS, ['aa-range']);
  assert.deepEqual(noise.DECISION_REASONS, ['candidate-repeats-differ', 'noise-artifact-invalid', 'noise-model-mismatch',
    'noise-case-set-mismatch', 'noise-unusable', 'no-noise-band', 'infra-share', 'no-paired-cases', 'underpowered',
    'above-band', 'below-band', 'ci-includes-zero', 'inside-band']);
  assert.deepEqual(noise.SCOPES, ['corpus', 'train', 'heldout']);
  assert.deepEqual(Object.keys(noise.VOCABULARY_LABELS),
    ['Noise-check verdict', 'Decision verdict', 'Recommendation', 'Infra error class', 'Run status', 'Noise method']);
  assert.equal(noise.VOCABULARY_LABELS['Noise-check verdict'], noise.NOISE_VERDICTS);
  assert.equal(noise.VOCABULARY_LABELS['Decision verdict'], noise.DECISION_VERDICTS);
  assert.equal(noise.VOCABULARY_LABELS.Recommendation, noise.RECOMMENDATIONS);
  assert.equal(noise.VOCABULARY_LABELS['Infra error class'], noise.INFRA_CLASSES);
  assert.equal(noise.VOCABULARY_LABELS['Run status'], noise.RUN_STATUSES);
  assert.equal(noise.VOCABULARY_LABELS['Noise method'], noise.NOISE_METHODS);
  assert.deepEqual({ ...noise.DEFAULTS }, { k: 3, kMin: 2, mde: 0.05, headroom: 0.95, maxInfraShare: 0.10 });
  assert.equal(EPS, 1e-9);
  assert.equal(MIN_PAIRED_CASES, 3);
});

test('every exported list, the label map and the defaults are frozen', () => {
  for (const name of ['NOISE_VERDICTS', 'DECISION_VERDICTS', 'RECOMMENDATIONS', 'INFRA_CLASSES', 'RUN_STATUSES',
    'NOISE_METHODS', 'DECISION_REASONS', 'SCOPES', 'VOCABULARY_LABELS', 'DEFAULTS', 'EXCLUSION_MARKS']) {
    assert.ok(Object.isFrozen(noise[name]), `${name} is frozen`);
  }
});

test('the module is pure: it requires only the retrieval stats and names no I/O or clock', () => {
  const source = fs.readFileSync(MODULE_FILE, 'utf8');
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['./retrieval/lib/stats.ts']);
  for (const banned of [/\bfs\b/, /child_process/, /\bDate\b/, /Math\.random/, /\bprocess\b/]) {
    assert.doesNotMatch(source, banned);
  }
});

// ---------------------------------------------------------------------------
// IC-002 loadNoiseConfig

test('loadNoiseConfig returns the five fields of a valid block and ignores note', () => {
  const cfg = { noise: { k: 3, mde: 0.05, headroom: 0.95, maxInfraShare: 0.10, seed: 96, note: 'x', extra: 1 } };
  assert.deepEqual(loadNoiseConfig(cfg), { k: 3, mde: 0.05, headroom: 0.95, maxInfraShare: 0.1, seed: 96 });
  // Inclusive edges that stay valid.
  assert.deepEqual(loadNoiseConfig({ noise: { k: 2, mde: 0.5, headroom: 1, maxInfraShare: 0, seed: 4294967295 } }),
    { k: 2, mde: 0.5, headroom: 1, maxInfraShare: 0, seed: 4294967295 });
});

test('loadNoiseConfig refuses a missing or malformed block, naming the field, never defaulting', () => {
  const good = { k: 3, mde: 0.05, headroom: 0.95, maxInfraShare: 0.1, seed: 96 };
  const cases = [
    [undefined, /noise is invalid: block must be an object, got undefined/],
    [null, /noise is invalid: block/],
    [[], /noise is invalid: block/],
    [{ ...good, k: 1 }, /noise is invalid: k must be an integer >= 2, got 1/],
    [{ ...good, k: 2.5 }, /noise is invalid: k /],
    [{ ...good, k: '3' }, /noise is invalid: k /],
    [{ ...good, mde: 0 }, /noise is invalid: mde /],
    [{ ...good, mde: 1 }, /noise is invalid: mde /],
    [{ ...good, mde: undefined }, /noise is invalid: mde /],
    [{ ...good, headroom: 0 }, /noise is invalid: headroom /],
    [{ ...good, headroom: 1.2 }, /noise is invalid: headroom /],
    [{ ...good, maxInfraShare: 1 }, /noise is invalid: maxInfraShare /],
    [{ ...good, maxInfraShare: -0.1 }, /noise is invalid: maxInfraShare /],
    [{ ...good, seed: -1 }, /noise is invalid: seed /],
    [{ ...good, seed: 2 ** 32 }, /noise is invalid: seed /],
    [{ ...good, seed: undefined }, /noise is invalid: seed /],
  ];
  for (const [block, pattern] of cases) {
    assert.throws(() => loadNoiseConfig({ noise: block }), (error) => {
      assert.match(error.message, /^bench\/config\.json noise is invalid: /);
      assert.match(error.message, pattern);
      return true;
    }, JSON.stringify(block));
  }
  assert.throws(() => loadNoiseConfig({}), /noise is invalid: block/);
});

// ---------------------------------------------------------------------------
// IC-003 classifyRun

test('classifyRun follows the design section 3 table', () => {
  const rows = [
    [{ status: 'timeout', hasOutput: true }, { infra: 'timeout', excluded: true }],
    [{ status: 'api-error', hasOutput: false }, { infra: 'api-error', excluded: true }],
    [{ status: 'truncated', hasOutput: true }, { infra: 'truncated', excluded: true }],
    [{ status: 'completed', hasOutput: false }, { infra: 'no-output', excluded: true }],
    [{ status: 'absent', hasOutput: false }, { infra: 'no-output', excluded: true }],
    [{ status: 'completed', hasOutput: true }, { infra: null, excluded: false }],
    [{ status: 'absent', hasOutput: true }, { infra: null, excluded: false }],
    [{ status: 'malformed', hasOutput: true }, { infra: null, excluded: true }],
    [{ status: 'malformed', hasOutput: false }, { infra: null, excluded: true }],
    // An unrecognised value is never mapped to a class and never scored.
    [{ status: 'oom', hasOutput: true }, { infra: null, excluded: true }],
  ];
  for (const [input, expected] of rows) assert.deepEqual(classifyRun(input), expected, JSON.stringify(input));
});

// ---------------------------------------------------------------------------
// IC-004 computeNoise

test('computeNoise gives exact repeat means, A/A range and baseline mean per scope and per kind', () => {
  const a = noiseOf(KNOWN);
  assert.deepEqual(Object.keys(a), ['kind', 'schemaVersion', 'method', 'model', 'commit', 'iterations', 'k', 'thresholds',
    'caseKeys', 'cases', 'scopes', 'byKind', 'infra', 'graderRerun', 'verdict', 'reason']);
  assert.equal(a.kind, 'bench-noise');
  assert.equal(a.schemaVersion, 1);
  assert.equal(a.method, 'aa-range');
  assert.equal(a.model, 'claude-test');
  assert.equal(a.commit, 'c0ffee');
  assert.deepEqual(a.iterations, ['base-r1', 'base-r2', 'base-r3']);
  assert.equal(a.k, 3);
  assert.deepEqual(a.thresholds, { k: 3, mde: 0.05, headroom: 0.95, maxInfraShare: 0.1 });
  assert.deepEqual(a.caseKeys, [...TRAIN, ...HELDOUT]);
  assert.deepEqual(a.cases['a/4'], { kind: 'triggering', split: 'train', scores: [0.5, 1, 0.5], excluded: [null, null, null] });
  assert.deepEqual(a.scopes.corpus, { repeatMeans: [0.75, 0.8125, 0.6875], noise: 0.125, baselineMean: 0.75, headroom: false, runs: 24, excluded: 0 });
  assert.deepEqual(a.scopes.train, { repeatMeans: [0.5, 0.625, 0.5], noise: 0.125, baselineMean: (0.5 + 0.625 + 0.5) / 3, headroom: false, runs: 12, excluded: 0 });
  assert.deepEqual(a.scopes.heldout, { repeatMeans: [1, 1, 0.875], noise: 0.125, baselineMean: (1 + 1 + 0.875) / 3, headroom: true, runs: 12, excluded: 0 });
  assert.deepEqual(Object.keys(a.byKind), ['behavioral', 'triggering']);
  assert.deepEqual(a.byKind.triggering.repeatMeans, [0.5, 0.625, 0.5]);
  assert.deepEqual(a.infra, { timeout: 0, 'api-error': 0, truncated: 0, 'no-output': 0, malformed: 0, 'source-unverified': 0, excluded: 0, runs: 24, share: 0 });
  assert.deepEqual(a.graderRerun, { runs: 24, differing: [], stale: [] });
  assert.deepEqual(validateNoiseArtifact(a), []);
});

test('computeNoise reaches each of the five verdicts', () => {
  assert.equal(noiseOf(KNOWN, { mde: 0.25 }).verdict, 'usable');
  const exceeds = noiseOf(KNOWN);
  assert.equal(exceeds.verdict, 'noise-exceeds-mde');
  assert.match(exceeds.reason, /add repeats or cases/);
  const headroom = noiseOf(KNOWN, { headroom: 0.75, mde: 0.25 });
  assert.equal(headroom.verdict, 'no-headroom', 'baselineMean equal to headroom has no headroom');
  assert.match(headroom.reason, /aim the change at cost or latency, not quality/);
  const unstable = noiseOf(KNOWN, { mde: 0.25 }, { runs: 24, differing: ['base-r2/a/1'], stale: [] });
  assert.equal(unstable.verdict, 'grader-unstable');
  assert.match(unstable.reason, /1 run\(s\)/);
  const fewRepeats = noiseOf(KNOWN, { k: 4, mde: 0.25 });
  assert.equal(fewRepeats.verdict, 'inconclusive');
  assert.match(fewRepeats.reason, /k 3 < config k 4/);
});

test('computeNoise applies the verdict precedence highest first', () => {
  const unstable = { runs: 24, differing: ['base-r1/a/1'], stale: [] };
  // inconclusive beats grader-unstable
  assert.equal(noiseOf(KNOWN, { k: 4 }, unstable).verdict, 'inconclusive');
  // grader-unstable beats no-headroom
  assert.equal(noiseOf(KNOWN, { headroom: 0.5 }, unstable).verdict, 'grader-unstable');
  // no-headroom beats noise-exceeds-mde (noise 0.125 >= mde 0.05 holds too)
  assert.equal(noiseOf(KNOWN, { headroom: 0.5 }).verdict, 'no-headroom');
});

test('computeNoise EPS edges: noise just under mde still exceeds it; a clear gap is usable', () => {
  assert.equal(noiseOf(KNOWN, { mde: 0.125 + EPS / 2 }).verdict, 'noise-exceeds-mde');
  assert.equal(noiseOf(KNOWN, { mde: 0.125 }).verdict, 'noise-exceeds-mde');
  assert.equal(noiseOf(KNOWN, { mde: 0.125 + 2 * EPS }).verdict, 'usable');
  assert.equal(noiseOf(KNOWN, { mde: 0.25, headroom: 0.75 + EPS / 2 }).verdict, 'no-headroom');
  assert.equal(noiseOf(KNOWN, { mde: 0.25, headroom: 0.75 + 2 * EPS }).verdict, 'usable');
});

test('computeNoise excludes infra and malformed runs, counts them, never scores them as 0', () => {
  const r2 = fill([0.5, 0.5, 0.5, 1], 1);
  r2['a/4'] = 'timeout';
  r2['b/1'] = 'malformed';
  const a = noiseOf([KNOWN[0], repeatOf('base-r2', r2), KNOWN[2]], { maxInfraShare: 0.1 });
  assert.deepEqual(a.cases['a/4'].scores, [0.5, null, 0.5]);
  assert.deepEqual(a.cases['a/4'].excluded, [null, 'timeout', null]);
  assert.deepEqual(a.cases['b/1'].excluded, [null, 'malformed', null]);
  // r2 train mean over the three remaining runs, not over four with a 0.
  assert.equal(a.scopes.train.repeatMeans[1], 0.5);
  assert.equal(a.scopes.heldout.repeatMeans[1], 1);
  assert.deepEqual(a.infra, { timeout: 1, 'api-error': 0, truncated: 0, 'no-output': 0, malformed: 1, 'source-unverified': 0, excluded: 2, runs: 24, share: 2 / 24 });
  assert.equal(a.scopes.corpus.excluded, 2);
  assert.notEqual(a.verdict, 'inconclusive', 'share 0.083 <= 0.1');
  // A third exclusion lifts the share to 0.125 > 0.1.
  r2['a/3'] = 'no-output';
  const over = noiseOf([KNOWN[0], repeatOf('base-r2', r2), KNOWN[2]]);
  assert.equal(over.infra['no-output'], 1);
  assert.equal(over.verdict, 'inconclusive');
  assert.match(over.reason, /infra share 0\.125 > maxInfraShare 0\.1/);
  // An undecided model run (null pass rate, no exclusion) is not excluded and not scored.
  const undecided = fill(0.5, 1);
  undecided['a/1'] = null;
  const u = noiseOf([repeatOf('r1', undecided), KNOWN[1], KNOWN[2]]);
  assert.deepEqual(u.cases['a/1'].scores, [null, 0.5, 0.5]);
  assert.deepEqual(u.cases['a/1'].excluded, [null, null, null]);
  assert.equal(u.infra.excluded, 0);
});

test('computeNoise is inconclusive with no scored run, and gives no band from a single scored repeat', () => {
  const dead = (i) => repeatOf(`r${i}`, Object.fromEntries(Object.keys(META).map((k) => [k, 'api-error'])));
  const none = noiseOf([dead(1), dead(2), dead(3)], { maxInfraShare: 0.99 });
  assert.equal(none.verdict, 'inconclusive');
  assert.equal(none.scopes.corpus.noise, null);
  assert.equal(none.scopes.corpus.baselineMean, null);
  assert.equal(none.scopes.corpus.headroom, null);
  const one = noiseOf([KNOWN[0], dead(2), dead(3)], { maxInfraShare: 0.99, mde: 0.25 });
  assert.equal(one.scopes.corpus.noise, null, 'one scored repeat is not an A/A range of 0');
  assert.equal(one.verdict, 'inconclusive');
});

test('computeNoise rejects repeats of different models, commits or case sets (programmer misuse)', () => {
  assert.throws(() => noiseOf([KNOWN[0], repeatOf('x', fill(0.5, 1), { model: 'other' })]), TypeError);
  assert.throws(() => noiseOf([KNOWN[0], repeatOf('x', fill(0.5, 1), { commit: 'other' })]), TypeError);
  const short = fill(0.5, 1);
  delete short['b/4'];
  assert.throws(() => noiseOf([KNOWN[0], repeatOf('x', short)]), TypeError);
  assert.throws(() => noiseOf([]), TypeError);
  assert.throws(() => computeNoise({ repeats: KNOWN, config: CONFIG }), TypeError, 'graderRerun is required');
  assert.throws(() => noiseOf([repeatOf('x', { 'a/1': 'oom' })]), TypeError, 'unknown exclusion mark');
});

// ---------------------------------------------------------------------------
// IC-007 ruleVerdict / decide

test('ruleVerdict reproduces the IC-007 worked examples', () => {
  const rows = [
    [{ gain: 0.06, ci95: [0.021, 0.098] }, 'gain-above-noise', 'merge-candidate', 'above-band'],
    [{ gain: 0.05, ci95: [0.012, 0.088] }, 'within-noise', 'do-not-merge', 'inside-band'],
    [{ gain: 0.07, ci95: [-0.004, 0.14] }, 'within-noise', 'do-not-merge', 'ci-includes-zero'],
    [{ gain: -0.08, ci95: [-0.12, -0.04] }, 'regression', 'do-not-merge', 'below-band'],
    [{ gain: 0.30, ci95: [0.2, 0.4], noise: null }, 'inconclusive', 'do-not-merge', 'no-noise-band'],
    [{ gain: 0.30, ci95: [0.2, 0.4], n: 2 }, 'inconclusive', 'do-not-merge', 'underpowered'],
    [{ gain: 0.30, ci95: [0.2, 0.4], infraShare: { baseline: 0, candidate: 0.12 } }, 'inconclusive', 'do-not-merge', 'infra-share'],
  ];
  for (const [overrides, verdict, recommendation, reason] of rows) {
    assert.deepEqual(rule(overrides), { verdict, recommendation, reason }, JSON.stringify(overrides));
  }
});

test('ruleVerdict boundaries: gain equal to the band is within-noise', () => {
  assert.equal(rule({ gain: 0.05, ci95: [0.04, 0.06] }).verdict, 'within-noise');
  assert.equal(rule({ gain: 0.05 + EPS / 2, ci95: [0.04, 0.06] }).reason, 'inside-band');
  assert.equal(rule({ gain: -0.05, ci95: [-0.06, -0.04] }).reason, 'inside-band');
  assert.equal(rule({ gain: 0.05 + 2 * EPS, ci95: [0.04, 0.06] }).reason, 'above-band');
});

test('ruleVerdict boundaries: the band is max(noise, mde) in both orderings', () => {
  // noise < mde: band = mde 0.05, so a 0.03 gain is inside it.
  assert.equal(rule({ noise: 0.01, gain: 0.03, ci95: [0.02, 0.04] }).reason, 'inside-band');
  // noise > mde: band = noise 0.1, so a 0.08 gain is inside it.
  assert.equal(rule({ noise: 0.1, gain: 0.08, ci95: [0.05, 0.1] }).reason, 'inside-band');
  assert.equal(rule({ noise: 0.1, gain: -0.08, ci95: [-0.1, -0.05] }).reason, 'inside-band');
  // noise = mde
  assert.equal(rule({ noise: 0.05, gain: 0.05, ci95: [0.04, 0.06] }).reason, 'inside-band');
});

test('ruleVerdict boundaries: a ci95 touching 0 is not a gain or a regression', () => {
  assert.equal(rule({ gain: 0.3, ci95: [0, 0.6] }).reason, 'ci-includes-zero');
  assert.equal(rule({ gain: 0.3, ci95: [EPS / 2, 0.6] }).reason, 'ci-includes-zero');
  assert.equal(rule({ gain: 0.3, ci95: [2 * EPS, 0.6] }).reason, 'above-band');
  assert.equal(rule({ gain: -0.3, ci95: [-0.6, 0] }).reason, 'ci-includes-zero');
  assert.equal(rule({ gain: 0.3, ci95: null }).reason, 'ci-includes-zero');
});

test('ruleVerdict: a missing band is inconclusive, never within-noise', () => {
  for (const band of [null, undefined, NaN, '0.03']) {
    assert.deepEqual(rule({ noise: band, gain: 0, ci95: [-0.01, 0.01] }),
      { verdict: 'inconclusive', recommendation: 'do-not-merge', reason: 'no-noise-band' }, String(band));
  }
});

test('ruleVerdict: infra share equal to the maximum is not inconclusive; above it on either side is', () => {
  assert.equal(rule({ gain: 0.3, ci95: [0.2, 0.4], infraShare: { baseline: 0.1, candidate: 0.1 } }).reason, 'above-band');
  assert.equal(rule({ gain: 0.3, ci95: [0.2, 0.4], infraShare: { baseline: 0.1 + 2 * EPS, candidate: 0 } }).reason, 'infra-share');
  assert.equal(rule({ gain: 0.3, ci95: [0.2, 0.4], infraShare: { baseline: null, candidate: null } }).reason, 'above-band');
});

test('ruleVerdict: n 0 and n below MIN_PAIRED_CASES are inconclusive; n 3 decides', () => {
  assert.equal(rule({ n: 0, gain: null, ci95: null }).reason, 'no-paired-cases');
  assert.equal(rule({ n: 1, gain: 0.3, ci95: [0.3, 0.3] }).reason, 'underpowered');
  assert.equal(rule({ n: 2, gain: 0.3, ci95: [0.2, 0.4] }).reason, 'underpowered');
  assert.equal(rule({ n: 3, gain: 0.3, ci95: [0.2, 0.4] }).reason, 'above-band');
});

test('ruleVerdict: each precondition forces inconclusive whatever the numbers say', () => {
  for (const precondition of noise.DECISION_REASONS.slice(0, 5)) {
    assert.deepEqual(rule({ precondition, gain: 0.5, ci95: [0.4, 0.6] }),
      { verdict: 'inconclusive', recommendation: 'do-not-merge', reason: precondition });
  }
});

test('ruleVerdict refuses a non-numeric mde or a missing gain with paired cases (misuse)', () => {
  assert.throws(() => rule({ mde: undefined }), TypeError);
  assert.throws(() => rule({ n: 4, gain: null }), TypeError);
});

test('decide: gain over paired cases, ci95 from the shared bootstrap with the decision stream', () => {
  const d = decideOf({ n: 4, b: 0.5, c: 0.75 });
  assert.deepEqual(Object.keys(d), ['scope', 'n', 'gain', 'ci95', 'noise', 'band', 'mde', 'infraShare', 'unpaired', 'cases',
    'verdict', 'recommendation', 'reason', 'detail']);
  assert.equal(d.n, 4);
  assert.equal(d.gain, 0.25);
  assert.deepEqual(d.ci95, [0.25, 0.25]);
  assert.equal(d.band, 0.125);
  assert.equal(d.verdict, 'gain-above-noise');
  assert.equal(d.recommendation, 'merge-candidate');
  assert.equal(d.reason, 'above-band');
  assert.match(d.detail, /gain \+0\.250 > band 0\.125 and ci95 lower 0\.250 > 0/);
  // Mixed diffs: the ci95 is exactly the stats.js bootstrap over the sorted-key diffs.
  const baseline = { 'k/1': [0.5], 'k/2': [0.5], 'k/3': [0.5], 'k/4': [0.5], 'k/5': [0.5], 'k/6': [0.5] };
  const candidate = { 'k/1': [1], 'k/2': [1], 'k/3': [1], 'k/4': [1], 'k/5': [0], 'k/6': [0] };
  const mixed = decideOf({ baseline, candidate, noise: 0, excluded: { baseline: { runs: 6, excluded: 0 }, candidate: { runs: 6, excluded: 0 } } });
  const diffs = [0.5, 0.5, 0.5, 0.5, -0.5, -0.5];
  assert.deepEqual(mixed.ci95, stats.bootstrapCI(diffs, stats.streamSeed(96, 'skill-bench', 'decision', 'corpus', 'pass_rate')));
  assert.ok(mixed.ci95[0] <= 0);
  assert.equal(mixed.reason, 'ci-includes-zero');
  assert.equal(mixed.verdict, 'within-noise');
});

test('decide verdict table: gain-above-noise, within-noise, regression, inconclusive', () => {
  assert.equal(decideOf({ b: 0.5, c: 0.75 }).reason, 'above-band');
  assert.equal(decideOf({ b: 0.5, c: 0.625 }).reason, 'inside-band', 'gain 0.125 equals band 0.125');
  assert.equal(decideOf({ b: 0.5, c: 0.5 }).reason, 'inside-band');
  assert.equal(decideOf({ b: 0.75, c: 0.5 }).reason, 'below-band');
  assert.equal(decideOf({ b: 0.75, c: 0.5 }).verdict, 'regression');
  assert.equal(decideOf({ b: 0.625, c: 0.5 }).reason, 'inside-band', 'loss equal to the band is within-noise');
  assert.equal(decideOf({ b: 0.5, c: 0.75, noise: null }).reason, 'no-noise-band');
});

test('decide: gain equal to the band is within-noise / inside-band (boundary)', () => {
  const d = decideOf({ b: 0.5, c: 0.625, noise: 0.125, mde: 0.05 });
  assert.equal(d.gain, 0.125);
  assert.equal(d.band, 0.125);
  assert.deepEqual([d.verdict, d.recommendation, d.reason], ['within-noise', 'do-not-merge', 'inside-band']);
});

test('decide: noise below mde uses mde as the band (ordering)', () => {
  const d = decideOf({ b: 0.5, c: 0.6875, noise: 0.125, mde: 0.25 });
  assert.equal(d.band, 0.25);
  assert.equal(d.gain, 0.1875);
  assert.deepEqual([d.verdict, d.reason], ['within-noise', 'inside-band']);
  const e = decideOf({ b: 0.5, c: 0.6875, noise: 0.25, mde: 0.125 });
  assert.equal(e.band, 0.25);
  assert.deepEqual([e.verdict, e.reason], ['within-noise', 'inside-band']);
});

test('decide: null noise is inconclusive with gain and ci95 still reported', () => {
  const d = decideOf({ b: 0.5, c: 0.5, noise: null });
  assert.deepEqual([d.verdict, d.recommendation, d.reason], ['inconclusive', 'do-not-merge', 'no-noise-band']);
  assert.equal(d.noise, null);
  assert.equal(d.band, null);
  assert.equal(d.gain, 0);
  assert.deepEqual(d.ci95, [0, 0]);
  assert.match(d.detail, /no noise band: run `bench noise --out bench\/baseline\/noise\.json` over k baseline repeats \(UD-3\)/);
});

test('decide: n 2 is underpowered, with gain and ci95 present', () => {
  const d = decideOf({ n: 2, b: 0.25, c: 1 });
  assert.deepEqual([d.verdict, d.reason], ['inconclusive', 'underpowered']);
  assert.equal(d.n, 2);
  assert.equal(d.gain, 0.75);
  assert.deepEqual(d.ci95, [0.75, 0.75]);
  assert.equal(decideOf({ n: 0 }).reason, 'no-paired-cases');
  assert.equal(decideOf({ n: 0 }).gain, null);
  assert.equal(decideOf({ n: 0 }).ci95, null);
});

test('decide: an infra-excluded repeat keeps the mean of the remaining repeats, never 0', () => {
  const baseline = {}; const candidate = {};
  for (const key of ['k/1', 'k/2', 'k/3', 'k/4']) {
    baseline[key] = [0.75, 0.75, 0.75];
    candidate[key] = [1, null, 1];
  }
  const d = decideOf({
    baseline, candidate, noise: 0, mde: 0.05, maxInfraShare: 0.5,
    excluded: { baseline: { runs: 12, excluded: 0 }, candidate: { runs: 12, excluded: 4 } },
  });
  assert.deepEqual(d.cases.map((c) => c.candidate), [1, 1, 1, 1]);
  assert.equal(d.gain, 0.25);
  assert.deepEqual(d.infraShare, { baseline: 0, candidate: 4 / 12 });
  assert.deepEqual([d.verdict, d.reason], ['gain-above-noise', 'above-band']);
});

test('decide: infra share above the maximum is inconclusive; equal to it is not', () => {
  const at = decideOf({ b: 0.5, c: 0.75, excluded: { baseline: { runs: 10, excluded: 1 }, candidate: { runs: 10, excluded: 1 } } });
  assert.equal(at.reason, 'above-band');
  const over = decideOf({ b: 0.5, c: 0.75, excluded: { baseline: { runs: 12, excluded: 0 }, candidate: { runs: 25, excluded: 3 } } });
  assert.deepEqual([over.verdict, over.reason], ['inconclusive', 'infra-share']);
  assert.deepEqual(over.infraShare, { baseline: 0, candidate: 0.12 });
  assert.equal(over.gain, 0.25, 'the number is still shown with its reason');
});

test('decide: cases on one side only are counted in unpaired and never move the gain', () => {
  const base = decideOf({ b: 0.5, c: 0.75 });
  const s = sides(4, 0.5, 0.75);
  const d = decideOf({
    baseline: { ...s.baseline, 'x/1': [0, 0, 0], 'z/1': [1, 1, 1] },
    candidate: { ...s.candidate, 'y/1': [1, 1, 1], 'z/1': [null, null, null] },
  });
  assert.deepEqual(d.unpaired, { baselineOnly: 2, candidateOnly: 1 });
  assert.equal(d.n, 4);
  assert.equal(d.gain, base.gain);
  assert.deepEqual(d.ci95, base.ci95);
  assert.deepEqual(d.cases.map((c) => c.key), Object.keys(s.baseline).sort());
});

test('decide: a precondition is inconclusive with that reason, numbers still computed', () => {
  const d = decideOf({ b: 0.5, c: 1, precondition: 'noise-model-mismatch' });
  assert.deepEqual([d.verdict, d.recommendation, d.reason], ['inconclusive', 'do-not-merge', 'noise-model-mismatch']);
  assert.equal(d.gain, 0.5);
});

test('decide: per-case means keep full precision (no rounding in stored numbers)', () => {
  const baseline = { 'k/1': [0, 0, 1], 'k/2': [0, 0, 1], 'k/3': [0, 0, 1] };
  const candidate = { 'k/1': [1, 1, 1], 'k/2': [1, 1, 1], 'k/3': [1, 1, 1] };
  const d = decideOf({ baseline, candidate, excluded: { baseline: { runs: 9, excluded: 0 }, candidate: { runs: 9, excluded: 0 } } });
  assert.equal(d.cases[0].baseline, 1 / 3);
  assert.equal(d.gain, stats.mean([1 - 1 / 3, 1 - 1 / 3, 1 - 1 / 3]));
  assert.notEqual(d.gain, 0.6667);
});

test('decide throws TypeError only on misuse, never on data', () => {
  assert.throws(() => decideOf({ baseline: { 'k/1': 0.5 } }), TypeError);
  assert.throws(() => decide({ scope: 'other', baseline: {}, candidate: {}, excluded: { baseline: { runs: 0, excluded: 0 }, candidate: { runs: 0, excluded: 0 } }, noise: 0, mde: 0.05, maxInfraShare: 0.1, seed: 1 }), TypeError);
  assert.throws(() => decideOf({ excluded: { baseline: { runs: 1, excluded: 2 }, candidate: { runs: 1, excluded: 0 } } }), TypeError);
  // Data faults return verdicts.
  assert.equal(decideOf({ baseline: {}, candidate: {}, excluded: { baseline: { runs: 0, excluded: 0 }, candidate: { runs: 0, excluded: 0 } } }).reason, 'no-paired-cases');
});

// ---------------------------------------------------------------------------
// overfitFlag

test('overfitFlag: true when train gains and heldout does not, null when heldout is unknown', () => {
  const v = (verdict) => ({ verdict });
  assert.equal(overfitFlag(v('gain-above-noise'), v('within-noise')), true);
  assert.equal(overfitFlag(v('gain-above-noise'), v('regression')), true);
  assert.equal(overfitFlag(v('gain-above-noise'), v('gain-above-noise')), false);
  assert.equal(overfitFlag(v('gain-above-noise'), v('inconclusive')), null);
  assert.equal(overfitFlag(v('gain-above-noise'), null), null);
  for (const train of ['within-noise', 'regression', 'inconclusive']) {
    assert.equal(overfitFlag(v(train), v('within-noise')), false);
    assert.equal(overfitFlag(v(train), v('inconclusive')), false);
  }
});

// ---------------------------------------------------------------------------
// IC-008 buildDecision

test('buildDecision with no noise artifact: every scope inconclusive / do-not-merge / no-noise-band', () => {
  const d = decisionOf({ noise: null, noiseFile: null });
  assert.deepEqual(Object.keys(d), ['kind', 'schemaVersion', 'inputs', 'thresholds', 'precondition', 'corpus', 'splits',
    'overfitSuspected', 'infra', 'verdict', 'recommendation']);
  assert.equal(d.kind, 'bench-decision');
  assert.equal(d.schemaVersion, 1);
  assert.deepEqual(d.inputs.baseline, { source: 'none' });
  assert.equal(d.inputs.noiseArtifact, null);
  assert.deepEqual(d.inputs.baselineFile, { model: 'claude-test', commit: 'c0ffee' });
  assert.deepEqual(d.inputs.candidate, { model: 'claude-test', commit: 'beef', iterations: ['cand-r1', 'cand-r2', 'cand-r3'] });
  assert.deepEqual(d.thresholds, { mde: 0.05, maxInfraShare: 0.1, headroom: 0.95, seed: 96, eps: 1e-9, minPairedCases: 3 });
  assert.equal(d.precondition, null);
  for (const scope of [d.corpus, d.splits.train, d.splits.heldout]) {
    assert.deepEqual([scope.verdict, scope.recommendation, scope.reason], ['inconclusive', 'do-not-merge', 'no-noise-band']);
    assert.match(scope.detail, /UD-3/);
  }
  assert.deepEqual(Object.keys(d.splits), ['train', 'heldout']);
  assert.equal(d.splits.train.headroomLimited, null);
  assert.equal(d.overfitSuspected, false);
  assert.deepEqual([d.verdict, d.recommendation], ['inconclusive', 'do-not-merge']);
  assert.deepEqual(validateDecision(d), []);
});

test('buildDecision with a band: per-scope verdicts, headroomLimited, overfitSuspected', () => {
  const d = decisionOf();
  assert.deepEqual(d.inputs.baseline, { source: 'noise-artifact', model: 'claude-test', commit: 'c0ffee', iterations: ['base-r1', 'base-r2', 'base-r3'] });
  assert.deepEqual(d.inputs.noiseArtifact, { path: 'bench/baseline/noise.json', sha256: 'ab'.repeat(32), verdict: 'usable' });
  assert.equal(d.splits.train.verdict, 'gain-above-noise');
  assert.equal(d.splits.train.gain, 0.5);
  assert.equal(d.splits.train.n, 4);
  assert.equal(d.splits.heldout.verdict, 'within-noise');
  assert.equal(d.splits.heldout.gain, 0);
  assert.equal(d.corpus.verdict, 'gain-above-noise');
  assert.equal(d.corpus.gain, 0.25);
  assert.equal(d.corpus.n, 8);
  assert.equal('headroomLimited' in d.corpus, false);
  assert.equal(d.splits.train.headroomLimited, false);
  assert.equal(d.splits.heldout.headroomLimited, false);
  assert.equal(d.overfitSuspected, true);
  assert.deepEqual([d.verdict, d.recommendation], ['gain-above-noise', 'merge-candidate']);
  assert.deepEqual(d.infra.candidate, { timeout: 0, 'api-error': 0, truncated: 0, 'no-output': 0, malformed: 0, 'source-unverified': 0, missing: 0 });
  assert.deepEqual(validateDecision(d), []);
  // Heldout at headroom is named per split.
  const capped = decisionOf({ noise: flatArtifact({ headroom: 0.75 }), thresholds: { ...CONFIG, headroom: 0.75 } });
  assert.equal(capped.splits.heldout.headroomLimited, true);
  assert.equal(capped.splits.train.headroomLimited, false);
});

test('buildDecision: the baseline side is the noise artifact repeats, not baseline.json', () => {
  // baseline.json says every case passed at 1.0; the artifact says train 0.5. The gain is against the artifact.
  const file = { ...BASELINE_FILE, results: BASELINE_FILE.results.map((r) => ({ ...r, passRate: 1 })) };
  const d = decisionOf({ baselineFile: file });
  assert.equal(d.splits.train.gain, 0.5);
  assert.equal(d.splits.train.verdict, 'gain-above-noise');
});

test('buildDecision: heldout inconclusive makes overfitSuspected null', () => {
  const cand = [1, 2, 3].map((i) => repeatOf(`cand-r${i}`, fill(1, 'timeout'), { commit: 'beef' }));
  const d = decisionOf({ candidate: cand, thresholds: { ...CONFIG, maxInfraShare: 0.6 } });
  assert.equal(d.splits.train.verdict, 'gain-above-noise');
  assert.equal(d.splits.heldout.verdict, 'inconclusive');
  assert.equal(d.overfitSuspected, null);
  assert.equal(d.infra.candidate.timeout, 12);
});

test('buildDecision: an expected case with no candidate grading counts as excluded missing', () => {
  const values = fill(1, 0.75);
  delete values['b/4'];
  const cand = [1, 2, 3].map((i) => repeatOf(`cand-r${i}`, values, { commit: 'beef' }));
  const d = decisionOf({ candidate: cand, thresholds: { ...CONFIG, maxInfraShare: 0.2 } });
  assert.equal(d.infra.candidate.missing, 3);
  assert.equal(d.corpus.infraShare.candidate, 3 / 24);
  assert.equal(d.splits.heldout.infraShare.candidate, 3 / 12);
  assert.equal(d.splits.heldout.verdict, 'inconclusive');
  assert.equal(d.splits.heldout.reason, 'infra-share');
  assert.equal(d.corpus.unpaired.baselineOnly, 1);
});

test('buildDecision derives each precondition in design order', () => {
  const art = flatArtifact();
  const expect = (d, reason) => {
    assert.equal(d.precondition, reason);
    for (const scope of [d.corpus, d.splits.train, d.splits.heldout]) {
      assert.deepEqual([scope.verdict, scope.recommendation, scope.reason], ['inconclusive', 'do-not-merge', reason]);
    }
    assert.deepEqual(validateDecision(d), []);
  };
  const invalid = { ...clone(art), kind: 'other' };
  const inv = decisionOf({ noise: invalid });
  expect(inv, 'noise-artifact-invalid');
  assert.deepEqual(inv.inputs.baseline, { source: 'none' });
  assert.equal(inv.inputs.noiseArtifact.verdict, null);
  expect(decisionOf({ noise: null, noiseFile: { path: 'x.json', sha256: 'cd'.repeat(32) } }), 'noise-artifact-invalid');
  expect(decisionOf({ noise: { ...clone(art), model: 'other' } }), 'noise-model-mismatch');
  expect(decisionOf({ model: 'other' }), 'noise-model-mismatch');
  const fewer = { ...BASELINE_FILE, results: BASELINE_FILE.results.slice(1) };
  expect(decisionOf({ baselineFile: fewer }), 'noise-case-set-mismatch');
  expect(decisionOf({ noise: flatArtifact({ k: 4 }) }), 'noise-unusable');
  const unstable = computeNoise({ repeats: [1, 2, 3].map((i) => repeatOf(`base-r${i}`, fill(0.5, 0.75))), config: CONFIG, graderRerun: { runs: 24, differing: ['base-r1/a/1'], stale: [] } });
  expect(decisionOf({ noise: unstable }), 'noise-unusable');
  const mixed = [repeatOf('cand-r1', fill(1, 0.75)), repeatOf('cand-r2', fill(1, 0.75), { model: 'other' })];
  expect(decisionOf({ candidate: mixed }), 'candidate-repeats-differ');
  const mixedCommit = [repeatOf('cand-r1', fill(1, 0.75)), repeatOf('cand-r2', fill(1, 0.75), { commit: 'other' })];
  expect(decisionOf({ candidate: mixedCommit }), 'candidate-repeats-differ');
  const short = fill(1, 0.75);
  delete short['a/1'];
  expect(decisionOf({ candidate: [repeatOf('cand-r1', fill(1, 0.75)), repeatOf('cand-r2', short)] }), 'candidate-repeats-differ');
  // Order: model mismatch beats candidate-repeats-differ; an invalid artifact beats both.
  expect(decisionOf({ model: 'other', candidate: mixed }), 'noise-model-mismatch');
  expect(decisionOf({ noise: invalid, model: 'other' }), 'noise-artifact-invalid');
});

test('buildDecision stores unrounded case means', () => {
  const cand = [repeatOf('cand-r1', fill(1, 1)), repeatOf('cand-r2', fill(0, 1)), repeatOf('cand-r3', fill(0, 1))];
  const d = decisionOf({ candidate: cand });
  assert.equal(d.splits.train.cases[0].candidate, 1 / 3);
  assert.equal(JSON.stringify(d).includes('0.3333333333333333'), true);
});

// ---------------------------------------------------------------------------
// Validators

test('validateNoiseArtifact: one problem per listed fault', () => {
  const good = noiseOf(KNOWN);
  assert.deepEqual(validateNoiseArtifact(good), []);
  const faults = [
    ['kind', (a) => { a.kind = 'bench-other'; }, /\$\.kind/],
    ['schemaVersion', (a) => { a.schemaVersion = 2; }, /\$\.schemaVersion/],
    ['method', (a) => { a.method = 'wilson'; }, /\$\.method/],
    ['k vs iterations', (a) => { a.iterations.pop(); }, /\$\.k/],
    ['caseKeys unsorted', (a) => { a.caseKeys.reverse(); }, /\$\.caseKeys: .*sorted/],
    ['caseKeys vs cases', (a) => { a.caseKeys.push('z/9'); }, /\$\.caseKeys: .*cases/],
    ['scores length', (a) => { a.cases['a/1'].scores.pop(); }, /\$\.cases\["a\/1"\]\.scores/],
    ['excluded length', (a) => { a.cases['a/1'].excluded.pop(); }, /\$\.cases\["a\/1"\]\.excluded/],
    ['verdict', (a) => { a.verdict = 'great'; }, /\$\.verdict/],
    ['missing scope', (a) => { delete a.scopes.train; }, /\$\.scopes\.train/],
    ['excluded run with a score', (a) => { a.cases['a/1'].excluded[0] = 'timeout'; }, /\$\.cases\["a\/1"\]/],
    ['noise not a number', (a) => { a.scopes.corpus.noise = 'small'; }, /\$\.scopes\.corpus\.noise/],
  ];
  for (const [name, mutate, pattern] of faults) {
    const bad = clone(good);
    mutate(bad);
    const problems = validateNoiseArtifact(bad);
    assert.equal(problems.length, 1, `${name}: ${problems.join(' | ')}`);
    assert.match(problems[0], pattern, name);
  }
  assert.deepEqual(validateNoiseArtifact(null), ['$: not an object']);
});

test('validateDecision: one problem per listed fault', () => {
  const good = decisionOf();
  assert.deepEqual(validateDecision(good), []);
  const faults = [
    ['kind', (d) => { d.kind = 'bench-noise'; }, /\$\.kind/],
    ['schemaVersion', (d) => { d.schemaVersion = 2; }, /\$\.schemaVersion/],
    ['verdict outside list', (d) => { d.splits.heldout.verdict = 'great'; }, /\$\.splits\.heldout\.verdict/],
    ['recommendation outside list', (d) => { d.splits.heldout.recommendation = 'ship-it'; }, /\$\.splits\.heldout\.recommendation/],
    ['reason outside list', (d) => { d.splits.heldout.reason = 'vibes'; }, /\$\.splits\.heldout\.reason/],
    ['recommendation vs rule', (d) => { d.splits.heldout.recommendation = 'merge-candidate'; }, /\$\.splits\.heldout\.recommendation: .*do-not-merge/],
    ['missing scope', (d) => { delete d.splits.train; }, /\$\.splits\.train: missing/],
    ['ci95 lo > hi', (d) => { d.corpus.ci95 = [0.3, 0.2]; }, /\$\.corpus\.ci95/],
    ['ci95 shape', (d) => { d.corpus.ci95 = [0.2]; }, /\$\.corpus\.ci95/],
    ['n vs cases', (d) => { d.corpus.n = 7; }, /\$\.corpus\.n/],
    ['reason vs verdict', (d) => { d.splits.heldout.reason = 'above-band'; }, /\$\.splits\.heldout\.reason: .*within-noise/],
    ['precondition', (d) => { d.precondition = 'above-band'; }, /\$\.precondition/],
    ['top-level mirror', (d) => { d.verdict = 'within-noise'; d.recommendation = 'do-not-merge'; }, /\$\.verdict/],
    ['overfitSuspected', (d) => { d.overfitSuspected = 'maybe'; }, /\$\.overfitSuspected/],
    ['thresholds', (d) => { delete d.thresholds; }, /\$\.thresholds/],
  ];
  for (const [name, mutate, pattern] of faults) {
    const bad = clone(good);
    mutate(bad);
    const problems = validateDecision(bad);
    assert.equal(problems.length, 1, `${name}: ${problems.join(' | ')}`);
    assert.match(problems[0], pattern, name);
  }
  assert.deepEqual(validateDecision([]), ['$: not an object']);
});

test('validateDecision catches a gain-above-noise verdict its own reason does not support', () => {
  const d = clone(decisionOf());
  d.splits.heldout.verdict = 'gain-above-noise';
  d.splits.heldout.recommendation = 'merge-candidate';
  const problems = validateDecision(d);
  assert.ok(problems.some((p) => /\$\.splits\.heldout\.reason: .*inside-band/.test(p)), problems.join(' | '));
});

// ---------------------------------------------------------------------------
// NFR-001 determinism

test('same inputs and seed give byte-identical noise and decision JSON', () => {
  const twice = (fn) => [JSON.stringify(fn(), null, 2), JSON.stringify(fn(), null, 2)];
  const [n1, n2] = twice(() => noiseOf(KNOWN));
  assert.equal(n1, n2);
  const mixed = () => {
    const cand = [1, 2, 3].map((i) => repeatOf(`cand-r${i}`, fill([1, 0, 1, 0.5], [0.75, 1, 0, 0.5]), { commit: 'beef' }));
    return decisionOf({ candidate: cand });
  };
  const [d1, d2] = twice(mixed);
  assert.equal(d1, d2);
  assert.notDeepEqual(JSON.parse(d1).corpus.ci95, null);
});

// ---------------------------------------------------------------------------
// 096 review fixes: C-1, C-2, C-4, C-7

test('C-1: buildDecision raises noise-model-mismatch when candidate model differs from noise artifact', () => {
  // Candidate on model B against noise on model A
  const candB = [repeatOf('cand-r1', fill(1, 0.75), { model: 'model-B' })];
  const dB = decisionOf({ candidate: candB });
  assert.equal(dB.precondition, 'noise-model-mismatch');
  assert.equal(dB.corpus.verdict, 'inconclusive');
  assert.equal(dB.corpus.reason, 'noise-model-mismatch');
  assert.match(dB.corpus.detail, /the candidate, noise artifact, baseline and config models must agree/);

  // Candidate with model null counts as mismatch
  const candNull = [repeatOf('cand-r1', fill(1, 0.75), { model: null })];
  const dNull = decisionOf({ candidate: candNull });
  assert.equal(dNull.precondition, 'noise-model-mismatch');

  // Candidate commit is NOT required to equal baseline commit
  const candDiffCommit = [1, 2, 3].map((i) => repeatOf(`cand-r${i}`, fill(1, 0.75), { commit: 'beef-new' }));
  const dCommit = decisionOf({ candidate: candDiffCommit });
  assert.equal(dCommit.precondition, null);
  assert.equal(dCommit.corpus.verdict, 'gain-above-noise');
});

test('C-1 negative control: model A candidate gains above noise, model B candidate is blocked', () => {
  const candA = [1, 2, 3].map((i) => repeatOf(`cand-r${i}`, fill(1, 0.75), { model: 'claude-test' }));
  const dA = decisionOf({ candidate: candA });
  assert.equal(dA.precondition, null);
  assert.equal(dA.verdict, 'gain-above-noise');
  assert.equal(dA.recommendation, 'merge-candidate');

  const candB = [1, 2, 3].map((i) => repeatOf(`cand-r${i}`, fill(1, 0.75), { model: 'claude-other' }));
  const dB = decisionOf({ candidate: candB });
  assert.equal(dB.precondition, 'noise-model-mismatch');
  assert.equal(dB.verdict, 'inconclusive');
  assert.equal(dB.recommendation, 'do-not-merge');
});

test('C-2: EXCLUSION_MARKS export, source-unverified handling in tabulate, computeNoise, buildDecision', () => {
  assert.ok(Array.isArray(noise.EXCLUSION_MARKS), 'EXCLUSION_MARKS is exported');
  assert.ok(Object.isFrozen(noise.EXCLUSION_MARKS), 'EXCLUSION_MARKS is frozen');
  assert.deepEqual(noise.EXCLUSION_MARKS, ['timeout', 'api-error', 'truncated', 'no-output', 'malformed', 'source-unverified']);

  // Tabulate and computeNoise accept source-unverified and treat as null pass rate
  const rUnverified = fill(0.5, 0.75);
  rUnverified['a/1'] = 'source-unverified';
  const a = noiseOf([repeatOf('base-r1', rUnverified), KNOWN[1], KNOWN[2]], { maxInfraShare: 0.2 });
  assert.equal(a.cases['a/1'].scores[0], null);
  assert.equal(a.cases['a/1'].excluded[0], 'source-unverified');
  assert.equal(a.infra['source-unverified'], 1);

  // buildDecision counts source-unverified in infra
  const cand = [repeatOf('cand-r1', rUnverified), repeatOf('cand-r2', fill(0.5, 0.75)), repeatOf('cand-r3', fill(0.5, 0.75))];
  const d = decisionOf({ candidate: cand, thresholds: { ...CONFIG, maxInfraShare: 0.2 } });
  assert.equal(d.infra.candidate['source-unverified'], 1);

  // Candidate runs carrying source-unverified exceeding maxInfraShare yield inconclusive with infra-share
  const allUnverified = Object.fromEntries(Object.keys(META).map((k) => [k, 'source-unverified']));
  const candFallback = [1, 2, 3].map((i) => repeatOf(`cand-r${i}`, allUnverified));
  const dOver = decisionOf({ candidate: candFallback, thresholds: { ...CONFIG, maxInfraShare: 0.1 } });
  assert.equal(dOver.corpus.verdict, 'inconclusive');
  assert.equal(dOver.corpus.reason, 'infra-share');
});

test('C-4: validateNoiseArtifact rejects k < kMin, non-distinct iterations, and forged noise/headroom/verdict', () => {
  const good = noiseOf(KNOWN);
  assert.deepEqual(validateNoiseArtifact(good), []);

  // k < kMin (k = 1)
  const badK = clone(good);
  badK.k = 1;
  badK.iterations = ['base-r1'];
  for (const k of badK.caseKeys) {
    badK.cases[k].scores = [badK.cases[k].scores[0]];
    badK.cases[k].excluded = [badK.cases[k].excluded[0]];
  }
  const pK = validateNoiseArtifact(badK);
  assert.ok(pK.some((p) => /\$\.k: must be an integer >= 2/.test(p)), pK.join(' | '));

  // non-distinct iterations
  const badIter = clone(good);
  badIter.iterations = ['base-r1', 'base-r1', 'base-r3'];
  const pIter = validateNoiseArtifact(badIter);
  assert.ok(pIter.some((p) => /\$\.iterations:.*distinct/.test(p)), pIter.join(' | '));

  // forged noise
  const forgedNoise = clone(good);
  forgedNoise.scopes.corpus.noise = 0;
  const pNoise = validateNoiseArtifact(forgedNoise);
  assert.ok(pNoise.some((p) => /\$\.scopes\.corpus\.noise:.*match/.test(p)), pNoise.join(' | '));

  // forged headroom
  const forgedHeadroom = clone(good);
  forgedHeadroom.scopes.heldout.headroom = false;
  const pHeadroom = validateNoiseArtifact(forgedHeadroom);
  assert.ok(pHeadroom.some((p) => /\$\.scopes\.heldout\.headroom:.*match/.test(p)), pHeadroom.join(' | '));

  // forged verdict
  const forgedVerdict = clone(good);
  forgedVerdict.verdict = 'usable';
  const pVerdict = validateNoiseArtifact(forgedVerdict);
  assert.ok(pVerdict.some((p) => /\$\.verdict:.*match/.test(p)), pVerdict.join(' | '));
});

test('C-4: validateDecision checks required fields, sha256 format, and re-derives precondition', () => {
  const good = decisionOf();
  assert.deepEqual(validateDecision(good), []);

  // Missing inputs
  const noInputs = clone(good);
  delete noInputs.inputs;
  const pInputs = validateDecision(noInputs);
  assert.ok(pInputs.some((p) => /\$\.inputs: must be an object/.test(p)), pInputs.join(' | '));

  // Missing infra
  const noInfra = clone(good);
  delete noInfra.infra;
  const pInfra = validateDecision(noInfra);
  assert.ok(pInfra.some((p) => /\$\.infra: must be an object/.test(p)), pInfra.join(' | '));

  // Invalid sha256 in noiseArtifact
  const badSha = clone(good);
  badSha.inputs.noiseArtifact.sha256 = 'not-64-hex';
  const pSha = validateDecision(badSha);
  assert.ok(pSha.some((p) => /\$\.inputs\.noiseArtifact\.sha256/.test(p)), pSha.join(' | '));

  // Precondition model-mismatch forged to null
  const forgedPreModel = clone(good);
  forgedPreModel.inputs.candidate.model = 'different-model';
  forgedPreModel.precondition = null;
  const pPreModel = validateDecision(forgedPreModel);
  assert.ok(pPreModel.some((p) => /\$\.precondition:.*model/.test(p)), pPreModel.join(' | '));

  // Precondition noise-unusable forged to null
  const forgedPreUnusable = clone(good);
  forgedPreUnusable.inputs.noiseArtifact.verdict = 'grader-unstable';
  forgedPreUnusable.precondition = null;
  const pPreUnusable = validateDecision(forgedPreUnusable);
  assert.ok(pPreUnusable.some((p) => /\$\.precondition:.*noise-unusable/.test(p)), pPreUnusable.join(' | '));

  // Baseline source none with non-null noise
  const forgedSourceNone = clone(good);
  forgedSourceNone.inputs.baseline = { source: 'none' };
  forgedSourceNone.corpus.noise = 0.05;
  const pSourceNone = validateDecision(forgedSourceNone);
  assert.ok(pSourceNone.some((p) => /\$\.corpus\.noise: baseline source is "none"/.test(p)), pSourceNone.join(' | '));
});

test('C-7: headroomLimited derived with the threshold recorded in the decision in both directions', () => {
  // Direction 1: artifact captured with headroom 0.95 (heldout baselineMean 0.75 was headroom: false).
  // Decision called with thresholds.headroom = 0.70.
  // headroomLimited must be true!
  const art95 = flatArtifact({ headroom: 0.95 });
  assert.equal(art95.scopes.heldout.headroom, false);
  const dLower = decisionOf({ noise: art95, thresholds: { ...CONFIG, headroom: 0.70 } });
  assert.equal(dLower.thresholds.headroom, 0.70);
  assert.equal(dLower.splits.heldout.headroomLimited, true);

  // Direction 2: artifact captured with headroom 0.70 (heldout baselineMean 0.75 was headroom: true).
  // Decision called with thresholds.headroom = 0.95.
  // headroomLimited must be false!
  const art70 = flatArtifact({ headroom: 0.70 });
  assert.equal(art70.scopes.heldout.headroom, true);
  const dHigher = decisionOf({ noise: art70, thresholds: { ...CONFIG, headroom: 0.95 } });
  assert.equal(dHigher.thresholds.headroom, 0.95);
  assert.equal(dHigher.splits.heldout.headroomLimited, false);
});

test('C-7 negative control: copying capture-time flag contradicts decision headroom threshold', () => {
  const art95 = flatArtifact({ headroom: 0.95 });
  // If we took art95.scopes.heldout.headroom (false), it would contradict 0.75 >= 0.70 - EPS
  assert.equal(art95.scopes.heldout.headroom, false);
  const d = decisionOf({ noise: art95, thresholds: { ...CONFIG, headroom: 0.70 } });
  assert.notEqual(d.splits.heldout.headroomLimited, art95.scopes.heldout.headroom);
});
