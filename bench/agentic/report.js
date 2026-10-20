'use strict';

/**
 * Agentic baseline band, decision and token report (feature 097, IC-008, IC-009). Turns graded
 * iterations into 096 repeats and hands them, unchanged in meaning, to `computeNoise` (arm N, the A/A
 * band) and `buildDecision` (arm D against that band). Offline: reads run directories and spawns no
 * harness; the only child process is `git diff` when the band and the candidate differ in sourceAt.
 *
 * Why arm N alone makes the band and arm D alone is the candidate: the baseline side of a decision is
 * the noise artifact's k repeats. Feeding arm D to `noise`, or arm N to `report`, would measure a
 * change against itself, so both refuse the wrong arm instead of reading it.
 *
 * Why every run is checked against its launch record (C-8) and regraded in memory (C-10): a run
 * captured under an older question, truth or prompt is refused rather than restamped with the current
 * key, and a stored grading.json edited or left stale after `grade` is reported, never scored.
 *
 * Exclusion (096 vocabulary only): the grading's infra class or `malformed`; a run whose isolation is
 * not `clean` (leaked or unverifiable) is `source-unverified`. An excluded run scores null, never 0.
 *
 * The token report is descriptive: totals, medians and repeat means per arm, the D/N median ratio and
 * the arm N repeat-mean range beside it. It carries no verdict (096 defines no token rule).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { computeNoise, buildDecision, validateNoiseArtifact } = require('../noise.js');
const { mean, median } = require('../retrieval/lib/stats.js');
const { UsageError } = require('./tasks.js');
const { RUN_FILES, readIteration } = require('./execute.js');
const { gradeRun, serializeGrading, checkLaunch, loadPathInfo } = require('./grade.js');

/** The arm whose repeats make the band, and the arm a decision measures against it. */
const BASELINE_ARM = 'N';
const CANDIDATE_ARM = 'D';
/** Same rule as the executor's iteration names: a name is one path segment, never a traversal. */
const ITERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const posix = (p) => p.split(path.sep).join('/');

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `a,b,c` -> distinct, safe iteration names (exit 2 otherwise). */
function parseIterations(list, flag = '--iterations') {
  const names = String(list ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new UsageError('iterations-empty', `${flag} must list at least one iteration`);
  for (const name of names) {
    if (!ITERATION_NAME.test(name)) throw new UsageError('iteration-invalid', `${flag}: iteration name must match ${ITERATION_NAME}: ${JSON.stringify(name)}`);
  }
  const dup = names.find((name, i) => names.indexOf(name) !== i);
  if (dup) throw new UsageError('iteration-duplicate', `${flag}: iteration "${dup}" is listed twice`);
  return names;
}

/** Each named iteration's record, refused unless it exists, is of `arm`, and names its model and commit. */
function loadIterations(runRoot, names, arm, verb) {
  return names.map((name) => {
    const dir = path.join(runRoot, name);
    if (!fs.existsSync(dir)) throw new UsageError('iteration-missing', `${verb}: no iteration at ${dir}`);
    const meta = readIteration(dir);
    if (meta.arm !== arm) {
      throw new UsageError('arm-mismatch', `${verb}: iteration ${name} is arm ${meta.arm}; ${verb} reads arm ${arm} iterations only`);
    }
    if (typeof meta.model !== 'string' || typeof meta.sourceAt !== 'string') {
      throw new UsageError('iteration-invalid', `${verb}: iteration ${name} does not record its model and sourceAt`);
    }
    return { name, dir, meta };
  });
}

/** 096 exclusion mark of one grading: infra class or `malformed`, else `source-unverified` when not clean. */
function excludedOf(grading) {
  if (grading.infra !== null && grading.infra !== undefined) return grading.infra;
  return grading.isolation === 'clean' ? null : 'source-unverified';
}

/** The 096 repeat entry of one grading. */
function repeatRun(grading) {
  const excluded = excludedOf(grading);
  return { kind: grading.kind, split: grading.split, passRate: excluded === null ? grading.pass_rate : null, excluded };
}

function storedGrading(runDir, label) {
  const file = path.join(runDir, RUN_FILES.grading);
  if (!fs.existsSync(file)) {
    throw new UsageError('grading-missing', `${label}: ${RUN_FILES.grading} is missing; run \`bench agentic grade\` on that iteration first`);
  }
  return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Noise (IC-008)
// ---------------------------------------------------------------------------------------------

/**
 * One repeat, regraded in memory (`noise` for arm N, `report` for arm D, C-10): the fresh grading is
 * the score (so a grader or task edit made after `grade` cannot hide), a second in-memory grading that
 * differs marks the run `differing`, and a stored grading.json that differs from the fresh one marks
 * it `stale`. Each run must match its launch record (C-8) and have a stored grading. `noise` needs a
 * run directory for every task; for `report` a missing run is 096's `missing`, never a score.
 */
function regradeRepeat({ iteration, taskSet, config, pathInfo, verb }) {
  const runs = {};
  const differing = [];
  const stale = [];
  for (const task of taskSet.tasks) {
    const runKey = `${iteration.name}/${task.id}`;
    const runDir = path.join(iteration.dir, task.id);
    if (!fs.existsSync(runDir)) {
      if (verb !== 'noise') continue;
      throw new UsageError('run-missing', `noise: ${runKey} has no run directory; every iteration must hold every task of the task set`);
    }
    checkLaunch({ runDir, task, arm: iteration.meta.arm, config, label: `${verb}: ${runKey}` });
    const stored = storedGrading(runDir, runKey);
    const args = { runDir, task, arm: iteration.meta.arm, config, pathInfo };
    const first = serializeGrading(gradeRun(args));
    if (serializeGrading(gradeRun(args)) !== first) differing.push(runKey);
    if (stored !== first) stale.push(runKey);
    runs[task.key] = repeatRun(JSON.parse(first));
  }
  const repeat = { iteration: iteration.name, model: iteration.meta.model, commit: iteration.meta.sourceAt, runs };
  return { repeat, differing, stale };
}

/**
 * `bench agentic noise`. Exit 0 when the band is usable, 1 for another noise verdict, 2 (thrown
 * UsageError) on invalid input: an iteration of another arm, fewer than k repeats, mixed model or
 * source, an incomplete iteration or an ungraded run.
 * @returns {{exit: number, artifact: object}}
 */
function noiseOf({ runRoot, iterations, taskSet, config, noiseConfig, pathInfo }) {
  const names = parseIterations(iterations);
  if (names.length < noiseConfig.k) {
    throw new UsageError('too-few-iterations', `noise: ${names.length} iteration(s) given, the band needs k = ${noiseConfig.k}`);
  }
  const its = loadIterations(runRoot, names, BASELINE_ARM, 'noise');
  const [first] = its;
  for (const it of its.slice(1)) {
    if (it.meta.model !== first.meta.model) throw new UsageError('repeats-differ', `noise: model ${it.meta.model} of ${it.name} differs from ${first.meta.model} of ${first.name}`);
    if (it.meta.sourceAt !== first.meta.sourceAt) throw new UsageError('repeats-differ', `noise: sourceAt of ${it.name} differs from ${first.name}`);
  }
  const graded = its.map((iteration) => regradeRepeat({ iteration, taskSet, config, pathInfo, verb: 'noise' }));
  const artifact = computeNoise({
    repeats: graded.map((g) => g.repeat),
    config: noiseConfig,
    graderRerun: { runs: names.length * taskSet.tasks.length, differing: graded.flatMap((g) => g.differing), stale: graded.flatMap((g) => g.stale) },
  });
  const problems = validateNoiseArtifact(artifact);
  if (problems.length) throw new Error(`noise: internal artifact validation failed: ${problems.join('; ')}`);
  return { exit: artifact.verdict === 'usable' ? 0 : 1, artifact };
}

// ---------------------------------------------------------------------------------------------
// Report (IC-009)
// ---------------------------------------------------------------------------------------------

/** The iteration.json fields that must be equal for the band and the candidate to be comparable. */
const CAPTURE_FIELDS = Object.freeze(['snapshot', 'harness', 'harnessVersion', 'model', 'captureSha256']);
/** Paths whose change between two source commits does not change what a capture ran on. */
const RECORD_PATHS = Object.freeze([':(exclude)agent-docs', ':(exclude)bench/agentic/results', ':(exclude)CHANGELOG.md']);

/**
 * C-12: refuses (UsageError 'capture-mismatch') unless every band and candidate iteration matches the
 * first candidate in CAPTURE_FIELDS and, where sourceAt differs, `git diff` shows no change outside the
 * record paths (exit 1 = differs; any other failure cannot prove sameness, so it refuses too).
 */
function assertSameCapture({ baseline, candidate, repoRoot }) {
  const [ref] = candidate;
  for (const it of [...baseline, ...candidate.slice(1)]) {
    for (const field of CAPTURE_FIELDS) {
      if (it.meta[field] !== ref.meta[field]) {
        throw new UsageError('capture-mismatch', `report: ${field} of ${it.name} (${JSON.stringify(it.meta[field])}) differs from ${ref.name} (${JSON.stringify(ref.meta[field])}); the band and the candidate must come from the same capture`);
      }
    }
    if (it.meta.sourceAt === ref.meta.sourceAt) continue;
    const r = spawnSync('git', ['diff', '--quiet', it.meta.sourceAt, ref.meta.sourceAt, '--', '.', ...RECORD_PATHS], { cwd: repoRoot, stdio: 'ignore' });
    if (r.status !== 0) {
      const why = r.status === 1 ? 'changes inputs outside agent-docs, bench/agentic/results and CHANGELOG.md' : `cannot be compared (git diff exit ${r.status ?? r.error?.code ?? r.signal})`;
      throw new UsageError('capture-mismatch', `report: sourceAt of ${it.name} (${it.meta.sourceAt}) and ${ref.name} (${ref.meta.sourceAt}) ${why}`);
    }
  }
}

/** Tokens of one arm over named iterations: unknown usage is counted, never summed as 0. */
function armTokens(runRoot, names, taskSet) {
  const recordedAll = [];
  const repeatMeans = [];
  let runs = 0;
  for (const name of names) {
    const recorded = [];
    for (const task of taskSet.tasks) {
      const runDir = path.join(runRoot, name, task.id);
      if (!fs.existsSync(runDir)) continue;
      runs += 1;
      const tokens = readJsonOrNull(path.join(runDir, RUN_FILES.timing))?.total_tokens;
      if (Number.isFinite(tokens) && tokens >= 0) recorded.push(tokens);
    }
    recordedAll.push(...recorded);
    repeatMeans.push(mean(recorded));
  }
  return {
    iterations: names.slice(),
    runs,
    recorded: recordedAll.length,
    unknown: runs - recordedAll.length,
    totalTokens: recordedAll.reduce((sum, t) => sum + t, 0),
    medianTokensPerTask: median(recordedAll),
    repeatMeans,
  };
}

/**
 * IC-009 token report. Arm N figures come from the iterations a valid noise artifact names (the band's
 * own runs); without one, arm N is empty and the ratio and range are null.
 */
function tokenReport({ runRoot, taskSet, candidateIterations, baselineIterations }) {
  const N = armTokens(runRoot, baselineIterations, taskSet);
  const D = armTokens(runRoot, candidateIterations, taskSet);
  const nMeans = N.repeatMeans.filter((m) => m !== null);
  return {
    label: 'descriptive',
    N,
    D,
    ratioDtoN: N.medianTokensPerTask === null || D.medianTokensPerTask === null || N.medianTokensPerTask === 0
      ? null : D.medianTokensPerTask / N.medianTokensPerTask,
    nTokenRange: nMeans.length >= 2 ? Math.max(...nMeans) - Math.min(...nMeans) : null,
  };
}

/** The noise file read for a decision: `{ noise, noiseFile }`, both null when there is none. */
function readNoiseFile({ noisePath, explicit, repoRoot }) {
  if (!fs.existsSync(noisePath)) {
    if (explicit) throw new UsageError('noise-missing', `report: no noise artifact at ${noisePath}`);
    return { noise: null, noiseFile: null };
  }
  const raw = fs.readFileSync(noisePath, 'utf8');
  let noise = null;
  try {
    noise = JSON.parse(raw);
  } catch {
    // an unparseable file is still a file: buildDecision marks it noise-artifact-invalid
  }
  return {
    noise,
    noiseFile: { path: posix(path.relative(repoRoot, noisePath)), sha256: crypto.createHash('sha256').update(raw).digest('hex') },
  };
}

/**
 * `bench agentic report`. The baseline file is synthesised from the task set (IC-009) so the expected
 * case set is the current keys; `model` is the config label for every side. Arm D is regraded in
 * memory (C-10); with a valid band, its iterations (the artifact's `iterations` under `runRoot`) must
 * share the candidate's capture identity (C-12).
 * @returns {{exit: 0, decision: object, tokens: object, graderRerun: {runs: number, differing: string[], stale: string[]}}}
 */
function reportOf({ runRoot, iterations, taskSet, config, noiseConfig, noisePath, explicitNoise = false, repoRoot, pathInfo = loadPathInfo() }) {
  const names = parseIterations(iterations);
  const its = loadIterations(runRoot, names, CANDIDATE_ARM, 'report');
  const { noise, noiseFile } = readNoiseFile({ noisePath, explicit: explicitNoise, repoRoot });
  const band = noise !== null && validateNoiseArtifact(noise).length === 0 ? noise.iterations : [];
  if (band.length) assertSameCapture({ baseline: loadIterations(runRoot, band, BASELINE_ARM, 'report'), candidate: its, repoRoot });
  const graded = its.map((iteration) => regradeRepeat({ iteration, taskSet, config, pathInfo, verb: 'report' }));
  const candidate = graded.map((g) => g.repeat);
  const label = config.model.label;
  const baselineFile = { model: label, commit: null, results: taskSet.tasks.map((t) => ({ key: t.key, kind: t.kind, split: t.split })) };
  const decision = buildDecision({ noise, noiseFile, baselineFile, model: label, candidate, thresholds: noiseConfig });
  const tokens = tokenReport({ runRoot, taskSet, candidateIterations: names, baselineIterations: band });
  const graderRerun = {
    runs: candidate.reduce((sum, r) => sum + Object.keys(r.runs).length, 0),
    differing: graded.flatMap((g) => g.differing),
    stale: graded.flatMap((g) => g.stale),
  };
  return { exit: 0, decision, tokens, graderRerun };
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

const num = (x, digits = 3) => (Number.isFinite(x) ? x.toFixed(digits) : 'none');
const signed = (x) => (Number.isFinite(x) ? `${x < 0 ? '-' : '+'}${Math.abs(x).toFixed(3)}` : 'none');
const marks = (counts) => Object.entries(counts || {}).filter(([, n]) => n > 0).map(([m, n]) => `${m} ${n}`).join(', ') || 'none';

function noiseLines(a) {
  const lines = [`noise over ${a.k} repeat(s) of ${a.model} at ${String(a.commit).slice(0, 8)} (${a.method}): ${a.iterations.join(', ')}`];
  lines.push('| scope | repeat means | noise | mean | headroom |', '|---|---|---|---|---|');
  for (const [scope, s] of Object.entries(a.scopes)) {
    lines.push(`| ${scope} | ${s.repeatMeans.map((m) => num(m)).join(' / ')} | ${num(s.noise)} | ${num(s.baselineMean)} | ${s.headroom === null ? 'none' : s.headroom ? 'yes' : 'no'} |`);
  }
  lines.push(`excluded: ${a.infra.excluded} of ${a.infra.runs} run(s) (${marks(Object.fromEntries(Object.entries(a.infra).filter(([k]) => !['excluded', 'runs', 'share'].includes(k))))})`);
  lines.push(`grader re-run: ${a.graderRerun.runs} run(s), ${a.graderRerun.differing.length} differing, ${a.graderRerun.stale.length} stale grading.json`);
  lines.push(`verdict: ${a.verdict} (${a.reason})`);
  return lines;
}

function scopeLine(name, s) {
  return `decision ${name}: ${s.verdict} (${s.reason}) -> ${s.recommendation}; gain ${signed(s.gain)} over n ${s.n}, band ${num(s.band)}, ci95 ${Array.isArray(s.ci95) ? `[${num(s.ci95[0])}, ${num(s.ci95[1])}]` : 'none'}`;
}

/** N-5: the agentic band command (096's detail names `bench noise`, which reads no agentic runs). */
const NO_BAND_LINE = 'no noise band: run `npm run bench -- agentic noise --iterations <n-r1,n-r2,n-r3> --out bench/agentic/results/noise.json` over the arm N repeats first';

function reportLines({ decision, tokens, graderRerun }) {
  const lines = [
    scopeLine('corpus', decision.corpus),
    scopeLine('train', decision.splits.train),
    scopeLine('heldout', decision.splits.heldout),
    ...(decision.corpus.reason === 'no-noise-band' ? [NO_BAND_LINE] : []),
    ...(graderRerun && (graderRerun.differing.length || graderRerun.stale.length)
      ? [`warning: grader re-run of arm D: ${graderRerun.differing.length} differing, ${graderRerun.stale.length} stale grading.json of ${graderRerun.runs} run(s); the fresh grading is the score: ${[...new Set([...graderRerun.differing, ...graderRerun.stale])].join(', ')}`]
      : []),
    `overfitSuspected: ${decision.overfitSuspected}; precondition: ${decision.precondition ?? 'none'}`,
    `noise artifact: ${decision.inputs.noiseArtifact ? `${decision.inputs.noiseArtifact.path} (${decision.inputs.noiseArtifact.verdict ?? 'invalid'})` : 'none'}`,
    `excluded runs: baseline ${marks(decision.infra.baseline)}; candidate ${marks(decision.infra.candidate)}`,
    'tokens (descriptive, no verdict):',
    '| arm | iterations | runs | recorded | unknown | totalTokens | medianTokensPerTask | repeatMeans |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const arm of [BASELINE_ARM, CANDIDATE_ARM]) {
    const t = tokens[arm];
    lines.push(`| ${arm} | ${t.iterations.join(',') || 'none'} | ${t.runs} | ${t.recorded} | ${t.unknown} | ${t.totalTokens} | ${t.medianTokensPerTask ?? 'unknown'} | ${t.repeatMeans.map((m) => (m === null ? 'unknown' : num(m, 1))).join(' / ') || 'none'} |`);
  }
  lines.push(`ratioDtoN ${tokens.ratioDtoN === null ? 'unknown' : Number(tokens.ratioDtoN.toFixed(4))}; nTokenRange ${tokens.nTokenRange === null ? 'unknown' : tokens.nTokenRange}`);
  return lines;
}

module.exports = {
  BASELINE_ARM, CANDIDATE_ARM,
  parseIterations, excludedOf, noiseOf, reportOf, tokenReport, noiseLines, reportLines,
};
