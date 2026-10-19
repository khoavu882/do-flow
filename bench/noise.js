'use strict';

/**
 * Eval noise floor (feature 096, IC-001): the closed vocabularies, the threshold defaults and every
 * rule that turns graded runs into a band or a verdict. Pure: callers pass parsed objects and get
 * objects back, so `bench noise`, `bench report`, guard G60 and any later consumer share one rule and
 * a fixed seed gives byte-identical JSON. The only dependency is the retrieval bench's statistics.
 *
 * Unknown is never zero (NFR-004): an excluded run, a missing run, a null pass rate or a missing band
 * is dropped and counted, never scored as 0, and never yields `within-noise`. A wrongly optimistic
 * verdict is the unsafe direction, so `gain-above-noise` needs the band, the CI and the case count to
 * agree, and every doubtful input falls to `inconclusive`.
 */

const { mean, bootstrapCI, streamSeed } = require('./retrieval/lib/stats.js');

/** Noise-check verdicts, highest precedence first (design section 5). */
const NOISE_VERDICTS = Object.freeze(['inconclusive', 'grader-unstable', 'no-headroom', 'noise-exceeds-mde', 'usable']);
const DECISION_VERDICTS = Object.freeze(['gain-above-noise', 'within-noise', 'regression', 'inconclusive']);
/** `merge-candidate` goes with `gain-above-noise` only. */
const RECOMMENDATIONS = Object.freeze(['merge-candidate', 'do-not-merge']);
const INFRA_CLASSES = Object.freeze(['timeout', 'api-error', 'truncated', 'no-output']);
/** What the orchestrating agent may write in a run's `run_status.json`. */
const RUN_STATUSES = Object.freeze(['completed', 'timeout', 'api-error', 'truncated']);
const NOISE_METHODS = Object.freeze(['aa-range']);
/** The first five are preconditions: set before any number is read, each forces `inconclusive`. */
const DECISION_REASONS = Object.freeze([
  'candidate-repeats-differ', 'noise-artifact-invalid', 'noise-model-mismatch', 'noise-case-set-mismatch', 'noise-unusable',
  'no-noise-band', 'infra-share', 'no-paired-cases', 'underpowered',
  'above-band', 'below-band', 'ci-includes-zero', 'inside-band',
]);
const SCOPES = Object.freeze(['corpus', 'train', 'heldout']);

/** README table label -> list, in table order (guard G60(c) compares the table to this). */
const VOCABULARY_LABELS = Object.freeze({
  'Noise-check verdict': NOISE_VERDICTS,
  'Decision verdict': DECISION_VERDICTS,
  Recommendation: RECOMMENDATIONS,
  'Infra error class': INFRA_CLASSES,
  'Run status': RUN_STATUSES,
  'Noise method': NOISE_METHODS,
});

/** The shipped values, for documentation. `loadNoiseConfig` never falls back to them. */
const DEFAULTS = Object.freeze({ k: 3, kMin: 2, mde: 0.05, headroom: 0.95, maxInfraShare: 0.10 });

const EPS = 1e-9;
const MIN_PAIRED_CASES = 3;

const PRECONDITIONS = DECISION_REASONS.slice(0, 5);
/** What may mark a run excluded in a repeat: an infra class, malformed, or source-unverified. */
const EXCLUSION_MARKS = Object.freeze([...INFRA_CLASSES, 'malformed', 'source-unverified']);
/** Decision-side exclusion counts add `missing`: an expected case the candidate never graded. */
const DECISION_MARKS = Object.freeze([...EXCLUSION_MARKS, 'missing']);
/** The reasons that decide a verdict other than `inconclusive`. */
const VERDICT_OF_REASON = Object.freeze({
  'above-band': 'gain-above-noise',
  'below-band': 'regression',
  'ci-includes-zero': 'within-noise',
  'inside-band': 'within-noise',
});

const NO_BAND_DETAIL = 'no noise band: run `bench noise --out bench/baseline/noise.json` over k baseline repeats (UD-3)';
const PRECONDITION_DETAIL = Object.freeze({
  'candidate-repeats-differ': 'the candidate repeats differ in model, measured commit or case set',
  'noise-artifact-invalid': 'the noise artifact is missing its content or is not a valid bench-noise artifact',
  'noise-model-mismatch': 'the candidate, noise artifact, baseline and config models must agree',
  'noise-case-set-mismatch': 'the noise artifact covers another case set than the baseline',
  'noise-unusable': 'the noise artifact verdict is grader-unstable or inconclusive, so it gives no band',
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const show = (x) => (x === undefined ? 'undefined' : typeof x === 'number' ? String(x) : JSON.stringify(x));
/** Printed numbers only; stored numbers keep full precision. */
const fmt = (x) => (isNum(x) ? String(Number(x.toFixed(4))) : String(x));
const signed = (x) => `${x < 0 ? '-' : '+'}${Math.abs(x).toFixed(3)}`;
const recommend = (verdict) => (verdict === 'gain-above-noise' ? 'merge-candidate' : 'do-not-merge');
const verdictOfReason = (reason) => VERDICT_OF_REASON[reason] || 'inconclusive';

// ---------------------------------------------------------------------------
// Config (IC-002)

/** The `noise` block of bench/config.json. Refused rather than defaulted, like `costCeiling`: a
 * missing or malformed block would otherwise pick thresholds nobody chose. */
function loadNoiseConfig(cfg) {
  const n = isObject(cfg) ? cfg.noise : undefined;
  const refuse = (reason) => new Error(`bench/config.json noise is invalid: ${reason}`);
  if (!isObject(n)) throw refuse(`block must be an object, got ${show(n)}`);
  if (!Number.isInteger(n.k) || n.k < DEFAULTS.kMin) throw refuse(`k must be an integer >= ${DEFAULTS.kMin}, got ${show(n.k)}`);
  if (!isNum(n.mde) || !(n.mde > 0 && n.mde < 1)) throw refuse(`mde must be a number with 0 < mde < 1, got ${show(n.mde)}`);
  if (!isNum(n.headroom) || !(n.headroom > 0 && n.headroom <= 1)) {
    throw refuse(`headroom must be a number with 0 < headroom <= 1, got ${show(n.headroom)}`);
  }
  if (!isNum(n.maxInfraShare) || !(n.maxInfraShare >= 0 && n.maxInfraShare < 1)) {
    throw refuse(`maxInfraShare must be a number with 0 <= maxInfraShare < 1, got ${show(n.maxInfraShare)}`);
  }
  if (!Number.isInteger(n.seed) || n.seed < 0 || n.seed > 4294967295) {
    throw refuse(`seed must be an integer from 0 to 4294967295, got ${show(n.seed)}`);
  }
  return { k: n.k, mde: n.mde, headroom: n.headroom, maxInfraShare: n.maxInfraShare, seed: n.seed };
}

// ---------------------------------------------------------------------------
// Run classification (IC-003)

/**
 * `status` is a run-status value, `absent` (no record) or `malformed` (the runner could not read one).
 * A recorded infra status is its own class; a completed or unrecorded run that left no output is
 * `no-output`. Anything else unrecognised is excluded without a class: never mapped, never scored.
 */
function classifyRun({ status, hasOutput } = {}) {
  if (status !== 'completed' && RUN_STATUSES.includes(status)) return { infra: status, excluded: true };
  if (status === 'completed' || status === 'absent') {
    return hasOutput ? { infra: null, excluded: false } : { infra: 'no-output', excluded: true };
  }
  return { infra: null, excluded: true };
}

// ---------------------------------------------------------------------------
// Repeats

/**
 * Per-case, per-repeat scores from repeats shaped
 * `[{ iteration, model, commit, runs: { [caseKey]: { kind, split, passRate, excluded } } }]`, where
 * `excluded` is null, an infra class or `malformed`. An excluded run scores null whatever its pass
 * rate; a key a repeat lacks is `missing`. `expected` (key -> { kind, split }) adds keys and fixes
 * their kind and split.
 */
function tabulate(repeats, label, expected = new Map()) {
  if (!Array.isArray(repeats)) throw new TypeError(`${label} must be an array of repeats`);
  repeats.forEach((r, i) => {
    if (!isObject(r) || !isObject(r.runs)) throw new TypeError(`${label}[${i}].runs must be an object`);
  });
  const keys = [...new Set([...expected.keys(), ...repeats.flatMap((r) => Object.keys(r.runs))])].sort();
  const cases = {};
  for (const key of keys) {
    const has = (r) => Object.hasOwn(r.runs, key);
    const seen = repeats.find(has);
    const meta = expected.get(key) || (seen ? seen.runs[key] : {});
    const entry = { kind: meta.kind ?? null, split: meta.split ?? null, scores: [], excluded: [] };
    repeats.forEach((r, i) => {
      if (!has(r)) { entry.scores.push(null); entry.excluded.push('missing'); return; }
      const run = r.runs[key];
      const mark = run.excluded ?? null;
      if (mark !== null && !EXCLUSION_MARKS.includes(mark)) {
        throw new TypeError(`${label}[${i}].runs["${key}"].excluded must be null or one of ${EXCLUSION_MARKS.join(', ')}, got ${show(mark)}`);
      }
      entry.scores.push(mark === null && isNum(run.passRate) ? run.passRate : null);
      entry.excluded.push(mark);
    });
    cases[key] = entry;
  }
  return { keys, cases };
}

const inScope = (entry, scope) => scope === 'corpus' || entry.split === scope;
const countExcluded = (entry) => entry.excluded.filter((m) => m !== null).length;

function countMarks(table, marks) {
  const out = Object.fromEntries(marks.map((m) => [m, 0]));
  for (const key of table.keys) for (const m of table.cases[key].excluded) if (m !== null) out[m] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// Noise (IC-004)

/** One scope's A/A statistics. A single scored repeat gives no range, so its noise is null, not 0. */
function scopeStats(cases, keys, k, headroom) {
  const repeatMeans = [];
  for (let i = 0; i < k; i++) repeatMeans.push(mean(keys.map((key) => cases[key].scores[i]).filter((s) => s !== null)));
  const scored = repeatMeans.filter((m) => m !== null);
  const baselineMean = mean(scored);
  return {
    repeatMeans,
    noise: scored.length >= 2 ? Math.max(...scored) - Math.min(...scored) : null,
    baselineMean,
    headroom: baselineMean === null ? null : baselineMean >= headroom - EPS,
    runs: keys.length * k,
    excluded: keys.reduce((sum, key) => sum + countExcluded(cases[key]), 0),
  };
}

/**
 * The noise artifact over k A/A repeats of one model, commit and case set. `config` is
 * `loadNoiseConfig`'s result; `graderRerun` is `{ runs, differing: [runKey], stale: [runKey] }`.
 * Repeats that differ in model, commit or case set are refused (the CLI refuses them first).
 */
function computeNoise({ repeats, config, graderRerun } = {}) {
  if (!Array.isArray(repeats) || repeats.length === 0) throw new TypeError('computeNoise: repeats must be a non-empty array');
  if (!isObject(config)) throw new TypeError('computeNoise: config must be loadNoiseConfig\'s result');
  if (!isObject(graderRerun) || !Array.isArray(graderRerun.differing) || !Array.isArray(graderRerun.stale)) {
    throw new TypeError('computeNoise: graderRerun must be { runs, differing: [], stale: [] }');
  }
  const [first] = repeats;
  if (repeats.some((r) => r.model !== first.model || r.commit !== first.commit)) {
    throw new TypeError('computeNoise: repeats must share one model and one commit');
  }
  const table = tabulate(repeats, 'repeats');
  if (table.keys.some((key) => table.cases[key].excluded.includes('missing'))) {
    throw new TypeError('computeNoise: repeats must share one case-key set');
  }
  const { keys, cases } = table;
  const k = repeats.length;
  const statsOf = (pick) => scopeStats(cases, keys.filter((key) => pick(cases[key])), k, config.headroom);
  const scopes = Object.fromEntries(SCOPES.map((scope) => [scope, statsOf((entry) => inScope(entry, scope))]));
  const kinds = [...new Set(keys.map((key) => cases[key].kind))].sort();
  const byKind = Object.fromEntries(kinds.map((kind) => [kind, statsOf((entry) => entry.kind === kind)]));
  const corpus = scopes.corpus;
  const marks = countMarks(table, EXCLUSION_MARKS);
  const infra = { ...marks, excluded: corpus.excluded, runs: corpus.runs, share: corpus.runs ? corpus.excluded / corpus.runs : null };

  const causes = [];
  if (k < config.k) causes.push(`k ${k} < config k ${config.k}`);
  if (corpus.baselineMean === null) causes.push('no model run was scored');
  else if (corpus.noise === null) causes.push('fewer than 2 repeats scored a run, so there is no range');
  if (infra.share !== null && infra.share > config.maxInfraShare + EPS) {
    causes.push(`infra share ${fmt(infra.share)} > maxInfraShare ${fmt(config.maxInfraShare)}`);
  }
  const differing = graderRerun.differing;
  let verdict;
  let reason;
  if (causes.length) [verdict, reason] = ['inconclusive', causes.join('; ')];
  else if (differing.length) {
    [verdict, reason] = ['grader-unstable', `${differing.length} run(s) graded differently on re-run: ${differing.join(', ')}`];
  } else if (corpus.headroom) {
    [verdict, reason] = ['no-headroom', `baselineMean ${fmt(corpus.baselineMean)} >= headroom ${fmt(config.headroom)}: aim the change at cost or latency, not quality`];
  } else if (corpus.noise >= config.mde - EPS) {
    [verdict, reason] = ['noise-exceeds-mde', `noise ${fmt(corpus.noise)} >= mde ${fmt(config.mde)}: add repeats or cases`];
  } else {
    [verdict, reason] = ['usable', `noise ${fmt(corpus.noise)} < mde ${fmt(config.mde)}; baselineMean ${fmt(corpus.baselineMean)} < headroom ${fmt(config.headroom)}`];
  }

  return {
    kind: 'bench-noise',
    schemaVersion: 1,
    method: 'aa-range',
    model: first.model,
    commit: first.commit,
    iterations: repeats.map((r) => r.iteration),
    k,
    thresholds: { k: config.k, mde: config.mde, headroom: config.headroom, maxInfraShare: config.maxInfraShare },
    caseKeys: keys,
    cases,
    scopes,
    byKind,
    infra,
    graderRerun: { runs: graderRerun.runs, differing: differing.slice(), stale: graderRerun.stale.slice() },
    verdict,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Decision rule (IC-007)

/** Design section 5 steps 1-9 over already-computed numbers. Throws only on misuse. */
function ruleVerdict({ precondition = null, noise, mde, maxInfraShare, infraShare = {}, n, gain, ci95 } = {}) {
  if (!isNum(mde)) throw new TypeError('ruleVerdict: mde must be a finite number');
  if (!isNum(maxInfraShare)) throw new TypeError('ruleVerdict: maxInfraShare must be a finite number');
  const out = (verdict, reason) => ({ verdict, recommendation: recommend(verdict), reason });
  if (precondition !== null && precondition !== undefined) return out('inconclusive', precondition);
  if (!isNum(noise)) return out('inconclusive', 'no-noise-band');
  const over = (share) => isNum(share) && share > maxInfraShare + EPS;
  if (over(infraShare.baseline) || over(infraShare.candidate)) return out('inconclusive', 'infra-share');
  if (!Number.isInteger(n) || n <= 0) return out('inconclusive', 'no-paired-cases');
  if (n < MIN_PAIRED_CASES) return out('inconclusive', 'underpowered');
  if (!isNum(gain)) throw new TypeError('ruleVerdict: paired cases need a finite gain');
  const band = Math.max(noise, mde);
  const lo = Array.isArray(ci95) && isNum(ci95[0]) ? ci95[0] : null;
  const hi = Array.isArray(ci95) && isNum(ci95[1]) ? ci95[1] : null;
  if (gain > band + EPS && lo !== null && lo > EPS) return out('gain-above-noise', 'above-band');
  if (gain < -band - EPS && hi !== null && hi < -EPS) return out('regression', 'below-band');
  if (Math.abs(gain) > band + EPS) return out('within-noise', 'ci-includes-zero');
  return out('within-noise', 'inside-band');
}

function detailOf(reason, d, maxInfraShare) {
  const ci = d.ci95 ? `[${signed(d.ci95[0])}, ${signed(d.ci95[1])}]` : 'none';
  switch (reason) {
    case 'no-noise-band': return NO_BAND_DETAIL;
    case 'infra-share':
      return `excluded share baseline ${fmt(d.infraShare.baseline)} / candidate ${fmt(d.infraShare.candidate)} > maxInfraShare ${fmt(maxInfraShare)}`;
    case 'no-paired-cases': return 'no case was scored on both sides';
    case 'underpowered': return `n ${d.n} < ${MIN_PAIRED_CASES} paired cases`;
    case 'above-band': return `gain ${signed(d.gain)} > band ${d.band.toFixed(3)} and ci95 lower ${d.ci95[0].toFixed(3)} > 0`;
    case 'below-band': return `gain ${signed(d.gain)} < -band ${d.band.toFixed(3)} and ci95 upper ${d.ci95[1].toFixed(3)} < 0`;
    case 'ci-includes-zero': return `|gain| ${Math.abs(d.gain).toFixed(3)} > band ${d.band.toFixed(3)} but ci95 ${ci} includes 0`;
    case 'inside-band': return `|gain| ${Math.abs(d.gain).toFixed(3)} <= band ${d.band.toFixed(3)}`;
    default: return PRECONDITION_DETAIL[reason] || `precondition ${reason}`;
  }
}

function shareOf(side, label) {
  if (!isObject(side) || !Number.isInteger(side.runs) || !Number.isInteger(side.excluded)
    || side.runs < 0 || side.excluded < 0 || side.excluded > side.runs) {
    throw new TypeError(`decide: excluded.${label} must be { runs, excluded } with 0 <= excluded <= runs`);
  }
  return side.runs === 0 ? null : side.excluded / side.runs;
}

function caseMeans(side, label) {
  if (!isObject(side)) throw new TypeError(`decide: ${label} must be an object of per-case score lists`);
  const means = new Map();
  for (const [key, scores] of Object.entries(side)) {
    if (!Array.isArray(scores)) throw new TypeError(`decide: ${label}["${key}"] must be an array of scores`);
    means.set(key, mean(scores.filter(isNum)));
  }
  return means;
}

/**
 * Gain of the candidate over the baseline repeats for one scope. A case pairs only when both sides
 * scored it at least once; a null score (excluded, missing or undecided) is dropped from its case
 * mean, never read as 0. `excluded` counts runs per side (infra + malformed + missing) for the share.
 * Gain and ci95 are reported whenever a case pairs, also when the verdict is `inconclusive`.
 */
function decide({ scope, baseline, candidate, excluded, noise, mde, maxInfraShare, seed, precondition = null } = {}) {
  if (!SCOPES.includes(scope)) throw new TypeError(`decide: scope must be one of ${SCOPES.join(', ')}, got ${show(scope)}`);
  if (!Number.isInteger(seed)) throw new TypeError('decide: seed must be an integer');
  const b = caseMeans(baseline, 'baseline');
  const c = caseMeans(candidate, 'candidate');
  const infraShare = { baseline: shareOf(excluded?.baseline, 'baseline'), candidate: shareOf(excluded?.candidate, 'candidate') };
  const cases = [];
  const unpaired = { baselineOnly: 0, candidateOnly: 0 };
  for (const key of [...new Set([...b.keys(), ...c.keys()])].sort()) {
    const bm = b.get(key) ?? null;
    const cm = c.get(key) ?? null;
    if (bm !== null && cm !== null) cases.push({ key, baseline: bm, candidate: cm });
    else if (bm !== null) unpaired.baselineOnly += 1;
    else if (cm !== null) unpaired.candidateOnly += 1;
  }
  const diffs = cases.map((p) => p.candidate - p.baseline);
  const n = diffs.length;
  const gain = mean(diffs);
  const ci95 = n ? bootstrapCI(diffs, streamSeed(seed, 'skill-bench', 'decision', scope, 'pass_rate')) : null;
  const cleanNoise = isNum(noise) ? noise : null;
  const band = cleanNoise === null || !isNum(mde) ? null : Math.max(cleanNoise, mde);
  const rule = ruleVerdict({ precondition, noise: cleanNoise, mde, maxInfraShare, infraShare, n, gain, ci95 });
  const d = { scope, n, gain, ci95, noise: cleanNoise, band, mde, infraShare, unpaired, cases, ...rule };
  return { ...d, detail: detailOf(rule.reason, d, maxInfraShare) };
}

/** Train gains above noise while heldout does not: true. Heldout unknown: null, not true. */
function overfitFlag(train, heldout) {
  if (!train || train.verdict !== 'gain-above-noise') return false;
  if (!heldout || heldout.verdict === 'inconclusive') return null;
  return heldout.verdict !== 'gain-above-noise';
}

// ---------------------------------------------------------------------------
// Decision result (IC-008)

const keySignature = (r) => Object.keys(r.runs).sort().join('\n');

/**
 * The `bench-decision` object. The baseline side is the noise artifact's k A/A repeats, never
 * `baseline.json` (k = 1); `baselineFile` (parsed baseline.json) names the expected case set.
 * Preconditions are derived here, in design order, so no caller can skip one:
 * noise-artifact-invalid > noise-model-mismatch > noise-case-set-mismatch > noise-unusable >
 * candidate-repeats-differ. `noise` is the parsed artifact or null; `noiseFile` is `{ path, sha256 }`
 * of the file read, or null when there is none. `model` is the configured model.
 */
function buildDecision({ noise = null, noiseFile = null, baselineFile, model, candidate, thresholds } = {}) {
  if (!isObject(baselineFile) || !Array.isArray(baselineFile.results)) {
    throw new TypeError('buildDecision: baselineFile must be the parsed baseline.json with results');
  }
  if (!Array.isArray(candidate)) throw new TypeError('buildDecision: candidate must be an array of repeats');
  const t = thresholds;
  if (!isObject(t) || !isNum(t.mde) || !isNum(t.maxInfraShare) || !isNum(t.headroom) || !Number.isInteger(t.seed)) {
    throw new TypeError('buildDecision: thresholds must be loadNoiseConfig\'s result');
  }
  const present = noise !== null || noiseFile !== null;
  const artifact = present && validateNoiseArtifact(noise).length === 0 ? noise : null;
  const expected = new Map(baselineFile.results.map((r) => [r.key, { kind: r.kind, split: r.split }]));
  const expectedKeys = [...expected.keys()].sort();

  const candModel = candidate.length ? candidate[0].model ?? null : null;
  let precondition = null;
  if (present && !artifact) precondition = 'noise-artifact-invalid';
  else if (artifact && (artifact.model !== baselineFile.model || artifact.model !== model || candModel !== artifact.model)) precondition = 'noise-model-mismatch';
  else if (artifact && JSON.stringify(artifact.caseKeys) !== JSON.stringify(expectedKeys)) precondition = 'noise-case-set-mismatch';
  else if (artifact && (artifact.verdict === 'grader-unstable' || artifact.verdict === 'inconclusive')) precondition = 'noise-unusable';
  else if (candidate.some((r) => r.model !== candidate[0].model || r.commit !== candidate[0].commit
    || keySignature(r) !== keySignature(candidate[0]))) precondition = 'candidate-repeats-differ';

  const cand = tabulate(candidate, 'candidate', expected);
  const base = artifact ? { keys: artifact.caseKeys, cases: artifact.cases } : { keys: [], cases: {} };
  const sideOf = (table, scope) => {
    const scores = {};
    let runs = 0;
    let excluded = 0;
    for (const key of table.keys) {
      const entry = table.cases[key];
      if (!inScope(entry, scope)) continue;
      scores[key] = entry.scores;
      runs += entry.scores.length;
      excluded += countExcluded(entry);
    }
    return { scores, counts: { runs, excluded } };
  };
  const decideScope = (scope) => {
    const b = sideOf(base, scope);
    const c = sideOf(cand, scope);
    return decide({
      scope, baseline: b.scores, candidate: c.scores, excluded: { baseline: b.counts, candidate: c.counts },
      noise: artifact ? artifact.scopes[scope].noise : null,
      mde: t.mde, maxInfraShare: t.maxInfraShare, seed: t.seed, precondition,
    });
  };
  const split = (scope) => {
    const s = decideScope(scope);
    const baseMean = artifact ? artifact.scopes[scope].baselineMean : null;
    const headroomLimited = baseMean === null ? null : baseMean >= t.headroom - EPS;
    return { ...s, headroomLimited };
  };
  const corpus = decideScope('corpus');
  const splits = { train: split('train'), heldout: split('heldout') };

  return {
    kind: 'bench-decision',
    schemaVersion: 1,
    inputs: {
      baseline: artifact
        ? { source: 'noise-artifact', model: artifact.model, commit: artifact.commit, iterations: artifact.iterations.slice() }
        : { source: 'none' },
      baselineFile: { model: baselineFile.model ?? null, commit: baselineFile.commit ?? null },
      candidate: {
        model: candidate.length ? candidate[0].model ?? null : null,
        commit: candidate.length ? candidate[0].commit ?? null : null,
        iterations: candidate.map((r) => r.iteration),
      },
      noiseArtifact: present
        ? { path: noiseFile?.path ?? null, sha256: noiseFile?.sha256 ?? null, verdict: artifact ? artifact.verdict : null }
        : null,
    },
    thresholds: { mde: t.mde, maxInfraShare: t.maxInfraShare, headroom: t.headroom, seed: t.seed, eps: EPS, minPairedCases: MIN_PAIRED_CASES },
    precondition,
    corpus,
    splits,
    overfitSuspected: overfitFlag(splits.train, splits.heldout),
    infra: { baseline: countMarks(base, DECISION_MARKS), candidate: countMarks(cand, DECISION_MARKS) },
    verdict: corpus.verdict,
    recommendation: corpus.recommendation,
  };
}

// ---------------------------------------------------------------------------
// Validators: parsed object in, list of problems out (empty when valid)

function validateNoiseArtifact(obj) {
  if (!isObject(obj)) return ['$: not an object'];
  const p = [];
  if (obj.kind !== 'bench-noise') p.push(`$.kind: must be "bench-noise", got ${show(obj.kind)}`);
  if (obj.schemaVersion !== 1) p.push(`$.schemaVersion: must be 1, got ${show(obj.schemaVersion)}`);
  if (!NOISE_METHODS.includes(obj.method)) p.push(`$.method: must be one of ${NOISE_METHODS.join(', ')}, got ${show(obj.method)}`);
  if (!isObject(obj.thresholds)) p.push('$.thresholds: must be an object');
  const kMin = (isObject(obj.thresholds) && Number.isInteger(obj.thresholds.kMin)) ? obj.thresholds.kMin : DEFAULTS.kMin;
  if (!Number.isInteger(obj.k) || obj.k < kMin) {
    p.push(`$.k: must be an integer >= ${kMin}, got ${show(obj.k)}`);
  }
  if (!Array.isArray(obj.iterations) || obj.k !== obj.iterations.length) {
    p.push(`$.k: ${show(obj.k)} does not equal iterations.length ${Array.isArray(obj.iterations) ? obj.iterations.length : 'n/a'}`);
  } else if (new Set(obj.iterations).size !== obj.iterations.length) {
    p.push('$.iterations: must contain distinct iterations');
  }
  const cases = isObject(obj.cases) ? obj.cases : null;
  if (!cases) p.push('$.cases: must be an object');
  const keys = obj.caseKeys;
  let caseErrors = false;
  if (!Array.isArray(keys) || keys.some((key, i) => typeof key !== 'string' || (i > 0 && key <= keys[i - 1]))) {
    p.push('$.caseKeys: must be sorted, unique strings');
    caseErrors = true;
  } else if (cases && JSON.stringify(keys) !== JSON.stringify(Object.keys(cases).sort())) {
    p.push('$.caseKeys: must equal the keys of $.cases');
    caseErrors = true;
  }
  for (const [key, entry] of Object.entries(cases || {})) {
    const at = `$.cases[${JSON.stringify(key)}]`;
    if (!isObject(entry)) { p.push(`${at}: must be an object`); caseErrors = true; continue; }
    const { scores, excluded } = entry;
    if (!Array.isArray(scores) || scores.length !== obj.k) { p.push(`${at}.scores: length must be k ${show(obj.k)}`); caseErrors = true; }
    if (!Array.isArray(excluded) || excluded.length !== obj.k) { p.push(`${at}.excluded: length must be k ${show(obj.k)}`); caseErrors = true; }
    if (!Array.isArray(scores) || !Array.isArray(excluded)) continue;
    const bad = [];
    scores.forEach((s, i) => {
      const mark = excluded[i] ?? null;
      if (s !== null && !(isNum(s) && s >= 0 && s <= 1)) bad.push(`run ${i} score ${show(s)} is not null or in [0, 1]`);
      if (mark !== null && !EXCLUSION_MARKS.includes(mark)) bad.push(`run ${i} excluded ${show(mark)} is not one of ${EXCLUSION_MARKS.join(', ')}`);
      else if (mark !== null && s !== null) bad.push(`run ${i} is excluded (${mark}) but has score ${show(s)}`);
    });
    if (bad.length) { p.push(`${at}: ${bad.join('; ')}`); caseErrors = true; }
  }

  const casesValid = Boolean(cases && Array.isArray(keys) && !caseErrors && Number.isInteger(obj.k) && isObject(obj.thresholds));
  const recomputedScopes = {};
  if (casesValid) {
    for (const scope of SCOPES) {
      const scopeKeys = keys.filter((key) => cases[key] && inScope(cases[key], scope));
      recomputedScopes[scope] = scopeStats(cases, scopeKeys, obj.k, obj.thresholds.headroom);
    }
  }

  for (const scope of SCOPES) {
    const s = isObject(obj.scopes) ? obj.scopes[scope] : undefined;
    if (!isObject(s)) { p.push(`$.scopes.${scope}: missing scope`); continue; }
    const again = recomputedScopes[scope];
    if (s.noise !== null && !(isNum(s.noise) && s.noise >= 0)) {
      p.push(`$.scopes.${scope}.noise: must be null or a number >= 0, got ${show(s.noise)}`);
    } else if (casesValid && again) {
      if (s.noise === null && again.noise !== null) {
        p.push(`$.scopes.${scope}.noise: stored null does not match recomputed ${fmt(again.noise)}`);
      } else if (s.noise !== null && again.noise === null) {
        p.push(`$.scopes.${scope}.noise: stored ${fmt(s.noise)} does not match recomputed null`);
      } else if (s.noise !== null && again.noise !== null && Math.abs(s.noise - again.noise) > EPS) {
        p.push(`$.scopes.${scope}.noise: stored ${fmt(s.noise)} does not match recomputed ${fmt(again.noise)}`);
      }
    }
    if (s.headroom !== null && typeof s.headroom !== 'boolean') {
      p.push(`$.scopes.${scope}.headroom: must be true, false or null`);
    } else if (casesValid && again && s.headroom !== again.headroom) {
      p.push(`$.scopes.${scope}.headroom: stored ${show(s.headroom)} does not match recomputed ${show(again.headroom)}`);
    }
  }

  let expectedVerdict = null;
  if (casesValid && recomputedScopes.corpus) {
    const corpus = recomputedScopes.corpus;
    const runs = corpus.runs;
    const excluded = corpus.excluded;
    const share = runs ? excluded / runs : null;
    const causes = [];
    if (isNum(obj.thresholds.k) && obj.k < obj.thresholds.k) causes.push('k < config k');
    if (corpus.baselineMean === null) causes.push('no model run was scored');
    else if (corpus.noise === null) causes.push('fewer than 2 repeats scored a run');
    if (share !== null && isNum(obj.thresholds.maxInfraShare) && share > obj.thresholds.maxInfraShare + EPS) {
      causes.push('infra share > maxInfraShare');
    }
    const differing = Array.isArray(obj.graderRerun?.differing) ? obj.graderRerun.differing : [];
    if (causes.length) expectedVerdict = 'inconclusive';
    else if (differing.length) expectedVerdict = 'grader-unstable';
    else if (corpus.headroom) expectedVerdict = 'no-headroom';
    else if (isNum(obj.thresholds.mde) && corpus.noise >= obj.thresholds.mde - EPS) expectedVerdict = 'noise-exceeds-mde';
    else expectedVerdict = 'usable';
  }

  if (!NOISE_VERDICTS.includes(obj.verdict)) {
    p.push(`$.verdict: must be one of ${NOISE_VERDICTS.join(', ')}, got ${show(obj.verdict)}`);
  } else if (casesValid && expectedVerdict && obj.verdict !== expectedVerdict) {
    p.push(`$.verdict: stored ${show(obj.verdict)} does not match recomputed ${show(expectedVerdict)}`);
  }
  return p;
}

function validateDecision(obj) {
  if (!isObject(obj)) return ['$: not an object'];
  const p = [];
  if (obj.kind !== 'bench-decision') p.push(`$.kind: must be "bench-decision", got ${show(obj.kind)}`);
  if (obj.schemaVersion !== 1) p.push(`$.schemaVersion: must be 1, got ${show(obj.schemaVersion)}`);
  if (!isObject(obj.thresholds)) p.push('$.thresholds: must be an object');
  if (obj.precondition !== null && !PRECONDITIONS.includes(obj.precondition)) {
    p.push(`$.precondition: must be null or one of ${PRECONDITIONS.join(', ')}, got ${show(obj.precondition)}`);
  }

  const inputs = isObject(obj.inputs) ? obj.inputs : null;
  if (!inputs) {
    p.push('$.inputs: must be an object');
  } else {
    for (const f of ['baseline', 'baselineFile', 'candidate', 'noiseArtifact']) {
      if (!(f in inputs)) p.push(`$.inputs.${f}: missing required field`);
    }
    if (inputs.baseline !== undefined && !isObject(inputs.baseline)) {
      p.push('$.inputs.baseline: must be an object');
    }
    if (inputs.baselineFile !== undefined && !isObject(inputs.baselineFile)) {
      p.push('$.inputs.baselineFile: must be an object');
    }
    if (inputs.candidate !== undefined && !isObject(inputs.candidate)) {
      p.push('$.inputs.candidate: must be an object');
    }
    if (inputs.noiseArtifact !== null && inputs.noiseArtifact !== undefined) {
      if (!isObject(inputs.noiseArtifact)) {
        p.push('$.inputs.noiseArtifact: must be an object or null');
      } else {
        const sha = inputs.noiseArtifact.sha256;
        if (sha !== null && !(typeof sha === 'string' && /^[0-9a-fA-F]{64}$/.test(sha))) {
          p.push(`$.inputs.noiseArtifact.sha256: must be null or 64 hex characters, got ${show(sha)}`);
        }
      }
    }

    if (inputs.baseline?.source === 'noise-artifact') {
      const baseModel = inputs.baseline.model;
      const baseFileModel = inputs.baselineFile?.model;
      const candModel = inputs.candidate?.model ?? null;
      if (baseModel !== baseFileModel || candModel !== baseModel || candModel === null) {
        if (obj.precondition !== 'noise-model-mismatch') {
          p.push(`$.precondition: model fields mismatch, so precondition must be "noise-model-mismatch", got ${show(obj.precondition)}`);
        }
      } else if (inputs.noiseArtifact?.verdict === 'grader-unstable' || inputs.noiseArtifact?.verdict === 'inconclusive') {
        if (obj.precondition !== 'noise-unusable' && obj.precondition !== 'noise-case-set-mismatch') {
          p.push(`$.precondition: inputs.noiseArtifact.verdict is ${show(inputs.noiseArtifact.verdict)}, so precondition must be "noise-unusable", got ${show(obj.precondition)}`);
        }
      }
    }
  }

  const infra = isObject(obj.infra) ? obj.infra : null;
  if (!infra) {
    p.push('$.infra: must be an object');
  } else {
    if (!isObject(infra.baseline)) p.push('$.infra.baseline: must be an object');
    if (!isObject(infra.candidate)) p.push('$.infra.candidate: must be an object');
  }

  const splits = isObject(obj.splits) ? obj.splits : {};
  for (const [at, s, name] of [['$.corpus', obj.corpus, 'corpus'], ['$.splits.train', splits.train, 'train'], ['$.splits.heldout', splits.heldout, 'heldout']]) {
    if (!isObject(s)) { p.push(`${at}: missing scope`); continue; }
    if (s.scope !== name) p.push(`${at}.scope: must be "${name}", got ${show(s.scope)}`);
    const verdictKnown = DECISION_VERDICTS.includes(s.verdict);
    if (!verdictKnown) p.push(`${at}.verdict: must be one of ${DECISION_VERDICTS.join(', ')}, got ${show(s.verdict)}`);
    if (!RECOMMENDATIONS.includes(s.recommendation)) {
      p.push(`${at}.recommendation: must be one of ${RECOMMENDATIONS.join(', ')}, got ${show(s.recommendation)}`);
    } else if (verdictKnown && s.recommendation !== recommend(s.verdict)) {
      p.push(`${at}.recommendation: verdict ${s.verdict} gives ${recommend(s.verdict)}, got ${s.recommendation}`);
    }
    if (!DECISION_REASONS.includes(s.reason)) {
      p.push(`${at}.reason: must be one of ${DECISION_REASONS.join(', ')}, got ${show(s.reason)}`);
    } else if (verdictKnown && verdictOfReason(s.reason) !== s.verdict) {
      p.push(`${at}.reason: ${s.reason} gives verdict ${verdictOfReason(s.reason)}, got ${s.verdict}`);
    }
    const ci = s.ci95;
    if (ci !== null && !(Array.isArray(ci) && ci.length === 2 && isNum(ci[0]) && isNum(ci[1]) && ci[0] <= ci[1])) {
      p.push(`${at}.ci95: must be null or [lo, hi] with lo <= hi, got ${show(ci)}`);
    }
    if (!Array.isArray(s.cases) || s.n !== s.cases.length) {
      p.push(`${at}.n: ${show(s.n)} does not equal cases.length ${Array.isArray(s.cases) ? s.cases.length : 'n/a'}`);
    }
    if (inputs?.baseline?.source === 'none') {
      if (s.noise !== null) p.push(`${at}.noise: baseline source is "none", so noise must be null, got ${show(s.noise)}`);
      if (obj.precondition === null && s.reason !== 'no-noise-band') {
        p.push(`${at}.reason: baseline source is "none", so reason must be "no-noise-band", got ${show(s.reason)}`);
      }
    }
    if (s.headroomLimited !== undefined && s.headroomLimited !== null && typeof s.headroomLimited !== 'boolean') {
      p.push(`${at}.headroomLimited: must be true, false or null, got ${show(s.headroomLimited)}`);
    }
  }
  if (isObject(obj.corpus) && (obj.verdict !== obj.corpus.verdict || obj.recommendation !== obj.corpus.recommendation)) {
    p.push('$.verdict: verdict and recommendation must mirror $.corpus');
  }
  if (![true, false, null].includes(obj.overfitSuspected)) p.push(`$.overfitSuspected: must be true, false or null, got ${show(obj.overfitSuspected)}`);
  return p;
}

module.exports = {
  NOISE_VERDICTS,
  DECISION_VERDICTS,
  RECOMMENDATIONS,
  INFRA_CLASSES,
  RUN_STATUSES,
  NOISE_METHODS,
  DECISION_REASONS,
  SCOPES,
  VOCABULARY_LABELS,
  DEFAULTS,
  EPS,
  MIN_PAIRED_CASES,
  EXCLUSION_MARKS,
  loadNoiseConfig,
  classifyRun,
  computeNoise,
  ruleVerdict,
  decide,
  overfitFlag,
  buildDecision,
  validateNoiseArtifact,
  validateDecision,
};
