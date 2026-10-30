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
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { computeNoise, buildDecision, validateNoiseArtifact, ruleVerdict } = require('../noise.ts');
const { mean, median, bootstrapCI, streamSeed } = require('../retrieval/lib/stats.ts');
const { UsageError, REVIEW_FILE } = require('./tasks.ts');
const { adaptIteration } = require('./review-adapter.ts');
const { RUN_FILES, readIteration } = require('./execute.ts');
const { gradeRun, serializeGrading, checkLaunch, loadPathInfo, gradeAbRun, serializeAbGrading } = require('./grade.ts');

/** The arm whose repeats make the band, and the arm a decision measures against it. */
const BASELINE_ARM = 'N';
const CANDIDATE_ARM = 'D';
/** Same rule as the executor's iteration names: a name is one path segment, never a traversal. */
const ITERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const posix = (p: string) => p.split(path.sep).join('/');

function readJsonOrNull(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `a,b,c` -> distinct, safe iteration names (exit 2 otherwise). */
function parseIterations(list: any, flag = '--iterations') {
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
function loadIterations(runRoot: string, names: string[], arm: string, verb: string) {
  return names.map((name: string) => {
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
function excludedOf(grading: any) {
  if (grading.infra !== null && grading.infra !== undefined) return grading.infra;
  return grading.isolation === 'clean' ? null : 'source-unverified';
}

/** The 096 repeat entry of one grading. */
function repeatRun(grading: any) {
  const excluded = excludedOf(grading);
  return { kind: grading.kind, split: grading.split, passRate: excluded === null ? grading.pass_rate : null, excluded };
}

function storedGrading(runDir: string, label: string) {
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
function regradeRepeat({ iteration, taskSet, config, pathInfo, verb }: { iteration: any; taskSet: any; config: any; pathInfo: any; verb: string }) {
  const runs: Record<string, any> = {};
  const differing: string[] = [];
  const stale: string[] = [];
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
function noiseOf({ runRoot, iterations, taskSet, config, noiseConfig, pathInfo }: { runRoot: string; iterations: any; taskSet: any; config: any; noiseConfig: any; pathInfo: any }) {
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
  const graded = its.map((iteration: any) => regradeRepeat({ iteration, taskSet, config, pathInfo, verb: 'noise' }));
  const artifact = computeNoise({
    repeats: graded.map((g: any) => g.repeat),
    config: noiseConfig,
    graderRerun: { runs: names.length * taskSet.tasks.length, differing: graded.flatMap((g: any) => g.differing), stale: graded.flatMap((g: any) => g.stale) },
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
function assertSameCapture({ baseline, candidate, repoRoot }: { baseline: any[]; candidate: any[]; repoRoot: string }) {
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
      const why = r.status === 1 ? 'changes inputs outside agent-docs, bench/agentic/results and CHANGELOG.md' : `cannot be compared (git diff exit ${r.status ?? (r.error as any)?.code ?? r.signal})`;
      throw new UsageError('capture-mismatch', `report: sourceAt of ${it.name} (${it.meta.sourceAt}) and ${ref.name} (${ref.meta.sourceAt}) ${why}`);
    }
  }
}

/** Tokens of one arm over named iterations: unknown usage is counted, never summed as 0. */
function armTokens(runRoot: string, names: string[], taskSet: any) {
  const recordedAll: number[] = [];
  const repeatMeans: (number | null)[] = [];
  let runs = 0;
  for (const name of names) {
    const recorded: number[] = [];
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
function tokenReport({ runRoot, taskSet, candidateIterations, baselineIterations }: { runRoot: string; taskSet: any; candidateIterations: string[]; baselineIterations: string[] }) {
  const N = armTokens(runRoot, baselineIterations, taskSet);
  const D = armTokens(runRoot, candidateIterations, taskSet);
  const nMeans = N.repeatMeans.filter((m: any): m is number => m !== null);
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
function readNoiseFile({ noisePath, explicit, repoRoot }: { noisePath: string; explicit: boolean; repoRoot: string }) {
  if (!fs.existsSync(noisePath)) {
    if (explicit) throw new UsageError('noise-missing', `report: no noise artifact at ${noisePath}`);
    return { noise: null, noiseFile: null };
  }
  const raw = fs.readFileSync(noisePath, 'utf8');
  let noise: any = null;
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
function reportOf({ runRoot, iterations, taskSet, config, noiseConfig, noisePath, explicitNoise = false, repoRoot, pathInfo = loadPathInfo() }: { runRoot: string; iterations: any; taskSet: any; config: any; noiseConfig: any; noisePath: string; explicitNoise?: boolean; repoRoot: string; pathInfo?: any }) {
  const names = parseIterations(iterations);
  const its = loadIterations(runRoot, names, CANDIDATE_ARM, 'report');
  const { noise, noiseFile } = readNoiseFile({ noisePath, explicit: explicitNoise, repoRoot });
  const band = noise !== null && validateNoiseArtifact(noise).length === 0 ? noise.iterations : [];
  if (band.length) assertSameCapture({ baseline: loadIterations(runRoot, band, BASELINE_ARM, 'report'), candidate: its, repoRoot });
  const graded = its.map((iteration: any) => regradeRepeat({ iteration, taskSet, config, pathInfo, verb: 'report' }));
  const candidate = graded.map((g: any) => g.repeat);
  const label = config.model.label;
  const baselineFile = { model: label, commit: null, results: taskSet.tasks.map((t: any) => ({ key: t.key, kind: t.kind, split: t.split })) };
  const decision = buildDecision({ noise, noiseFile, baselineFile, model: label, candidate, thresholds: noiseConfig });
  const tokens = tokenReport({ runRoot, taskSet, candidateIterations: names, baselineIterations: band });
  const graderRerun = {
    runs: candidate.reduce((sum: number, r: any) => sum + Object.keys(r.runs).length, 0),
    differing: graded.flatMap((g: any) => g.differing),
    stale: graded.flatMap((g: any) => g.stale),
  };
  return { exit: 0, decision, tokens, graderRerun };
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

const num = (x: any, digits = 3) => (Number.isFinite(x) ? x.toFixed(digits) : 'none');
const signed = (x: any) => (Number.isFinite(x) ? `${x < 0 ? '-' : '+'}${Math.abs(x).toFixed(3)}` : 'none');
const marks = (counts: any) => Object.entries(counts || {}).filter(([, n]) => (n as number) > 0).map(([m, n]) => `${m} ${n}`).join(', ') || 'none';

function noiseLines(a: any) {
  const lines = [`noise over ${a.k} repeat(s) of ${a.model} at ${String(a.commit).slice(0, 8)} (${a.method}): ${a.iterations.join(', ')}`];
  lines.push('| scope | repeat means | noise | mean | headroom |', '|---|---|---|---|---|');
  for (const [scope, s] of Object.entries(a.scopes) as [string, any][]) {
    lines.push(`| ${scope} | ${s.repeatMeans.map((m: any) => num(m)).join(' / ')} | ${num(s.noise)} | ${num(s.baselineMean)} | ${s.headroom === null ? 'none' : s.headroom ? 'yes' : 'no'} |`);
  }
  lines.push(`excluded: ${a.infra.excluded} of ${a.infra.runs} run(s) (${marks(Object.fromEntries(Object.entries(a.infra).filter(([k]) => !['excluded', 'runs', 'share'].includes(k))))})`);
  lines.push(`grader re-run: ${a.graderRerun.runs} run(s), ${a.graderRerun.differing.length} differing, ${a.graderRerun.stale.length} stale grading.json`);
  lines.push(`verdict: ${a.verdict} (${a.reason})`);
  return lines;
}

function scopeLine(name: string, s: any) {
  return `decision ${name}: ${s.verdict} (${s.reason}) -> ${s.recommendation}; gain ${signed(s.gain)} over n ${s.n}, band ${num(s.band)}, ci95 ${Array.isArray(s.ci95) ? `[${num(s.ci95[0])}, ${num(s.ci95[1])}]` : 'none'}`;
}

/** N-5: the agentic band command (096's detail names `bench noise`, which reads no agentic runs). */
const NO_BAND_LINE = 'no noise band: run `npm run bench -- agentic noise --iterations <n-r1,n-r2,n-r3> --out bench/agentic/results/noise.json` over the arm N repeats first';

function reportLines({ decision, tokens, graderRerun }: { decision: any; tokens: any; graderRerun?: any }) {
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
    lines.push(`| ${arm} | ${t.iterations.join(',') || 'none'} | ${t.runs} | ${t.recorded} | ${t.unknown} | ${t.totalTokens} | ${t.medianTokensPerTask ?? 'unknown'} | ${t.repeatMeans.map((m: any) => (m === null ? 'unknown' : num(m, 1))).join(' / ') || 'none'} |`);
  }
  lines.push(`ratioDtoN ${tokens.ratioDtoN === null ? 'unknown' : Number(tokens.ratioDtoN.toFixed(4))}; nTokenRange ${tokens.nTokenRange === null ? 'unknown' : tokens.nTokenRange}`);
  return lines;
}



// ---------------------------------------------------------------------------------------------
// With/without-DoFlow A/B (`config.mode === 'ab'`)
//
// Two quality metrics, each through the unchanged 096 rules: SUCCESS (the edit tasks, native checks)
// and REVIEW RECALL (the review-miss cases of the review task, scored by the review-miss scorer through
// `review-adapter`). The baseline arm's k repeats are the A/A band; the candidate arm's repeats are
// compared against it. Cost and behaviour (tokens, cost, wall time, tool calls, questions) are a second
// part: descriptive per run, with a verdict from the same `ruleVerdict` on relative change (cheaper is a
// gain) for four of them; questions get counts only. Arm names are the config's `roles`.
// ---------------------------------------------------------------------------------------------

const AB_NOISE_KIND = 'bench-ab-noise';
const AB_QUALITY = Object.freeze(['success', 'review']);
const AB_QUALITY_LABEL: Record<string, string> = { success: 'Success (edit tasks, pass rate)', review: 'Review recall (review-miss keys)' };
/** Cost and behaviour metrics that get a verdict; `pick` reads one grading. Lower is better for all four. */
const AB_COST_METRICS = Object.freeze([
  { id: 'totalTokens', label: 'total tokens', pick: (g: any) => g.metrics.tokens?.total ?? null },
  { id: 'costUsd', label: 'cost USD', pick: (g: any) => g.metrics.costUsd ?? null },
  { id: 'wallSeconds', label: 'wall s', pick: (g: any) => (Number.isFinite(g.metrics.wallMs) ? g.metrics.wallMs / 1000 : null) },
  { id: 'toolCalls', label: 'tool calls', pick: (g: any) => g.metrics.toolCalls ?? null },
]);

const avg = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const finite = (xs: any[]) => xs.filter((x) => Number.isFinite(x)) as number[];
/** (max - min) / mean of a series; null with fewer than two values or a zero mean. */
function relRange(xs: number[]) {
  if (xs.length < 2) return null;
  const m = avg(xs);
  return m === null || m === 0 ? null : (Math.max(...xs) - Math.min(...xs)) / m;
}

/** 096 exclusion mark of one A/B grading: a leaked or not-loaded run is `source-unverified` whatever else happened; else infra; else unverifiable. */
function abExcludedOf(g: any) {
  if (g.isolation === 'leaked' || g.isolation === 'not-loaded') return 'source-unverified';
  if (g.infra !== null && g.infra !== undefined) return g.infra;
  return g.isolation === 'clean' ? null : 'source-unverified';
}

/** The review-miss grade of one iteration, recomputed in memory from the run directories into a scratch dir. */
function adaptInMemory({ iteration, taskSet, gradings, corpus, reviewConfig }: { iteration: any; taskSet: any; gradings: Record<string, any>; corpus: any; reviewConfig: any }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-review-'));
  try {
    const entries = taskSet.tasks.filter((t: any) => t.kind === 'review').map((task: any) => {
      const g = gradings[task.id];
      return { task, runDir: g ? path.join(iteration.dir, task.id) : null, infra: g ? g.infra : null, workspaceRoot: g ? (readLaunchRoot(path.join(iteration.dir, task.id))) : null };
    });
    const name = `ab-${iteration.name}`;
    const { grade } = adaptIteration({
      entries, corpus, config: reviewConfig, iterationDir: path.join(scratch, name), name,
      meta: { model: iteration.meta.model, sourceAt: iteration.meta.sourceAt }, reviewFile: REVIEW_FILE,
    });
    return grade;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
const readLaunchRoot = (runDir: string) => readJsonOrNull(path.join(runDir, RUN_FILES.launch))?.workspaceRoot ?? null;

/**
 * One A/B iteration regraded in memory (C-8, C-10): every run is checked against its launch record, the
 * stored grading.json must exist and equal the fresh one (else `stale`), and a second fresh grading that
 * differs marks the run `differing`. Review tasks are scored through the adapter; the stored adapter
 * grade (`<reviewRoot>/ab-<iteration>/grade.json`) is checked the same way. An excluded task's cases
 * carry the exclusion in the repeat (the adapter has no `source-unverified` status).
 * @returns {{repeats: {success: object, review: object | null}, gradings: Record<string, object>, differing: string[], stale: string[]}}
 */
function regradeAbRepeat({ iteration, taskSet, config, verb, reviewRoot, corpus, reviewConfig }: any) {
  const gradings: Record<string, any> = {};
  const differing: string[] = [];
  const stale: string[] = [];
  const successRuns: Record<string, any> = {};
  for (const task of taskSet.tasks) {
    const runKey = `${iteration.name}/${task.id}`;
    const runDir = path.join(iteration.dir, task.id);
    if (!fs.existsSync(runDir)) {
      if (verb !== 'noise') continue;
      throw new UsageError('run-missing', `noise: ${runKey} has no run directory; every iteration must hold every task of the task set`);
    }
    checkLaunch({ runDir, task, arm: iteration.meta.arm, config, label: `${verb}: ${runKey}` });
    const stored = storedGrading(runDir, runKey);
    const args = { runDir, task, arm: iteration.meta.arm, config };
    const first = serializeAbGrading(gradeAbRun(args));
    if (serializeAbGrading(gradeAbRun(args)) !== first) differing.push(runKey);
    if (stored !== first) stale.push(runKey);
    const grading = JSON.parse(first);
    gradings[task.id] = grading;
    if (task.kind === 'edit') {
      const excluded = abExcludedOf(grading);
      successRuns[task.key] = { kind: 'ab-edit', split: task.split, passRate: excluded === null ? grading.pass_rate : null, excluded };
    }
  }
  const base = { iteration: iteration.name, model: iteration.meta.model, commit: iteration.meta.sourceAt };
  let review: any = null;
  const reviewTasks = taskSet.tasks.filter((t: any) => t.kind === 'review');
  if (reviewTasks.length) {
    if (!corpus) throw new UsageError('corpus-missing', `${verb}: the task set holds review tasks but no review-miss corpus was given (--corpus)`);
    const grade = adaptInMemory({ iteration, taskSet, gradings, corpus, reviewConfig });
    const storedFile = path.join(reviewRoot, `ab-${iteration.name}`, 'grade.json');
    if (reviewTasks.some((t: any) => gradings[t.id])) {
      const storedGrade = readJsonOrNull(storedFile);
      if (storedGrade === null) throw new UsageError('grading-missing', `${verb}: ${storedFile} is missing; run \`bench agentic grade\` on ${iteration.name} first`);
      if (JSON.stringify(storedGrade) !== JSON.stringify(grade)) stale.push(`${iteration.name}/review-miss`);
    }
    const runs: Record<string, any> = {};
    for (const [key, run] of Object.entries(grade.runs) as [string, any][]) runs[key] = { kind: run.kind, split: run.split, passRate: run.passRate, excluded: run.excluded };
    for (const task of reviewTasks) {
      const g = gradings[task.id];
      const mark = g ? abExcludedOf(g) : null;
      if (mark === null) continue;
      for (const id of task.review.caseIds) {
        const c = corpus.cases.find((x: any) => x.id === id);
        if (c && runs[c.key]) runs[c.key] = { ...runs[c.key], passRate: null, excluded: mark };
      }
    }
    review = { ...base, runs };
  }
  return { repeats: { success: { ...base, runs: successRuns }, review }, gradings, differing, stale };
}

/** The expected case set of one quality metric (what the noise artifact and the baseline file must hold). */
function expectedKeys(metric: string, taskSet: any, corpus: any) {
  if (metric === 'success') return taskSet.tasks.filter((t: any) => t.kind === 'edit').map((t: any) => ({ key: t.key, kind: 'ab-edit', split: t.split }));
  const out: any[] = [];
  for (const task of taskSet.tasks.filter((t: any) => t.kind === 'review')) {
    for (const id of task.review.caseIds) {
      const c = corpus?.cases.find((x: any) => x.id === id);
      if (c) out.push({ key: c.key, kind: 'review-miss', split: c.split });
    }
  }
  return out;
}

const metricsOf = (taskSet: any) => AB_QUALITY.filter((m) => (m === 'success' ? taskSet.tasks.some((t: any) => t.kind === 'edit') : taskSet.tasks.some((t: any) => t.kind === 'review')));

/**
 * `bench agentic noise` for an A/B config: the baseline arm's repeats give one noise artifact per quality
 * metric plus the relative range of each cost metric. Exit 0 when every metric's band is usable.
 * @returns {{exit: number, artifact: object}}
 */
function abNoiseOf({ runRoot, iterations, taskSet, config, noiseConfig, reviewRoot, corpus, reviewConfig }: any) {
  const names = parseIterations(iterations);
  if (names.length < noiseConfig.k) throw new UsageError('too-few-iterations', `noise: ${names.length} iteration(s) given, the band needs k = ${noiseConfig.k}`);
  const its = loadIterations(runRoot, names, config.roles.baseline, 'noise');
  const [first] = its;
  for (const it of its.slice(1)) {
    if (it.meta.model !== first.meta.model) throw new UsageError('repeats-differ', `noise: model ${it.meta.model} of ${it.name} differs from ${first.meta.model} of ${first.name}`);
    if (it.meta.sourceAt !== first.meta.sourceAt) throw new UsageError('repeats-differ', `noise: sourceAt of ${it.name} differs from ${first.name}`);
    if (it.meta.captureSha256 !== first.meta.captureSha256) throw new UsageError('repeats-differ', `noise: capture config of ${it.name} differs from ${first.name}`);
  }
  const graded = its.map((iteration: any) => regradeAbRepeat({ iteration, taskSet, config, verb: 'noise', reviewRoot, corpus, reviewConfig }));
  const differing = graded.flatMap((g: any) => g.differing);
  const stale = graded.flatMap((g: any) => g.stale);
  const metrics: Record<string, any> = {};
  for (const m of metricsOf(taskSet)) {
    const repeats = graded.map((g: any) => g.repeats[m]);
    const runs = repeats.reduce((n: number, r: any) => n + Object.keys(r.runs).length, 0);
    metrics[m] = computeNoise({ repeats, config: noiseConfig, graderRerun: { runs, differing, stale } });
    const problems = validateNoiseArtifact(metrics[m]);
    if (problems.length) throw new Error(`noise: internal artifact validation failed for ${m}: ${problems.join('; ')}`);
  }
  const cost: Record<string, number | null> = {};
  for (const metric of AB_COST_METRICS) {
    const tasks = taskSet.tasks.filter((t: any) => graded.every((g: any) => g.gradings[t.id] && abExcludedOf(g.gradings[t.id]) === null && metric.pick(g.gradings[t.id]) !== null));
    const repeatMeans = graded.map((g: any) => avg(tasks.map((t: any) => metric.pick(g.gradings[t.id]))));
    cost[metric.id] = tasks.length ? relRange(finite(repeatMeans)) : null;
  }
  const artifact = {
    kind: AB_NOISE_KIND, schemaVersion: 1, roles: config.roles, model: first.meta.model, commit: first.meta.sourceAt, iterations: names, metrics, cost,
  };
  return { exit: Object.values(metrics).every((a: any) => a.verdict === 'usable') ? 0 : 1, artifact };
}

/** The shape check of a combined A/B noise artifact; returns the problems. */
function validateAbNoise(a: any, wanted: string[]) {
  const problems: string[] = [];
  if (!a || a.kind !== AB_NOISE_KIND || a.schemaVersion !== 1) return [`not a ${AB_NOISE_KIND} artifact`];
  if (!Array.isArray(a.iterations) || a.iterations.length === 0) problems.push('iterations missing');
  for (const m of wanted) {
    const sub = a.metrics?.[m];
    const p = sub ? validateNoiseArtifact(sub) : ['missing'];
    if (p.length) problems.push(`metrics.${m}: ${p.slice(0, 2).join('; ')}`);
  }
  return problems;
}

function readFixedCost(file: string | null) {
  if (!file) return null;
  const raw = readJsonOrNull(file);
  const ok = raw && Array.isArray(raw.rows) && raw.rows.every((r: any) => r && typeof r.item === 'string' && ['string', 'number'].includes(typeof r.value) && typeof r.source === 'string')
    && (raw.hookLatencyMsP50 === undefined || (Number.isFinite(raw.hookLatencyMsP50) && raw.hookLatencyMsP50 >= 0));
  if (!ok) throw new UsageError('fixed-cost-invalid', `report: ${file} is not a fixed-cost input ({ rows: [{ item, value, source }], hookLatencyMsP50?: number })`);
  return raw;
}

/** Per-task mean of one cost metric over the repeats of an arm, counting only runs that are not excluded. */
function taskMeans(gradingsByRepeat: Record<string, any>[], taskSet: any, pick: (g: any) => number | null) {
  const out: Record<string, number | null> = {};
  for (const task of taskSet.tasks) {
    out[task.id] = avg(finite(gradingsByRepeat.map((byTask) => (byTask[task.id] && abExcludedOf(byTask[task.id]) === null ? pick(byTask[task.id]) : null))));
  }
  return out;
}

/** The share of excluded runs of an arm over all its gradings. */
function exclusionTally(gradingsByRepeat: Record<string, any>[]) {
  const marks: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  let runs = 0;
  let excluded = 0;
  for (const byTask of gradingsByRepeat) {
    for (const g of Object.values(byTask) as any[]) {
      runs++;
      const mark = abExcludedOf(g);
      if (mark !== null) {
        excluded++;
        marks[mark] = (marks[mark] ?? 0) + 1;
        const reason = g.exclusionReason ?? mark;
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
    }
  }
  return { runs, excluded, share: runs ? excluded / runs : null, marks, reasons };
}

/**
 * `bench agentic report` for an A/B config: Part 1 quality (096 rules), Part 2 cost and behaviour,
 * Part 3 fixed cost (an input file, not measured here), Part 4 validity. Offline. Refuses a mixed capture
 * identity (C-12) and a prompt that differs between arms.
 */
function abReportOf({ runRoot, iterations, taskSet, config, noiseConfig, noisePath, explicitNoise = false, repoRoot, reviewRoot, corpus, reviewConfig, fixedCostPath = null }: any) {
  const names = parseIterations(iterations);
  const { baseline: baselineRole, candidate: candidateRole } = config.roles;
  const its = loadIterations(runRoot, names, candidateRole, 'report');
  const { noise, noiseFile } = readNoiseFile({ noisePath, explicit: explicitNoise, repoRoot });
  const metrics = metricsOf(taskSet);
  const noiseValid = noise !== null && validateAbNoise(noise, metrics).length === 0;
  const bandNames: string[] = noiseValid ? noise.iterations : [];
  const bandIts = bandNames.length ? loadIterations(runRoot, bandNames, baselineRole, 'report') : [];
  if (bandIts.length) assertSameCapture({ baseline: bandIts, candidate: its, repoRoot });
  const regrade = (iteration: any) => regradeAbRepeat({ iteration, taskSet, config, verb: 'report', reviewRoot, corpus, reviewConfig });
  const candidate = its.map(regrade);
  const baseline = bandIts.map(regrade);

  const label = config.model.label;
  const decisions: Record<string, any> = {};
  for (const m of metrics) {
    const baselineFile = { model: label, commit: null, results: expectedKeys(m, taskSet, corpus) };
    decisions[m] = buildDecision({
      noise: noiseFile === null ? null : (noise?.metrics?.[m] ?? {}), noiseFile, baselineFile, model: label,
      candidate: candidate.map((g: any) => g.repeats[m]), thresholds: noiseConfig,
    });
  }
  const candidateMeans: Record<string, (number | null)[]> = {};
  for (const m of metrics) {
    candidateMeans[m] = candidate.map((g: any) => avg(finite(Object.values(g.repeats[m].runs).map((r: any) => r.passRate))));
  }

  // Part 2: cost and behaviour
  const byRepeat = (set: any[]) => set.map((g: any) => g.gradings);
  const A = byRepeat(baseline);
  const B = byRepeat(candidate);
  const tasksCost = taskSet.tasks.map((task: any) => {
    const side = (set: Record<string, any>[]) => {
      const mean = (pick: (g: any) => number | null) => taskMeans(set, { tasks: [task] }, pick)[task.id];
      return {
        input: mean((g) => g.metrics.tokens?.input ?? null), cacheCreation: mean((g) => g.metrics.tokens?.cacheCreation ?? null),
        cacheRead: mean((g) => g.metrics.tokens?.cacheRead ?? null), output: mean((g) => g.metrics.tokens?.output ?? null),
        totalTokens: mean((g) => g.metrics.tokens?.total ?? null), costUsd: mean((g) => g.metrics.costUsd ?? null),
        wallSeconds: mean((g) => (Number.isFinite(g.metrics.wallMs) ? g.metrics.wallMs / 1000 : null)), toolCalls: mean((g) => g.metrics.toolCalls ?? null),
        turns: mean((g) => g.metrics.turns ?? null), subagentTokens: mean((g) => g.metrics.subagentTokens ?? null),
        pauses: avg(finite(set.map((byTask) => byTask[task.id]?.metrics.questions.pauses ?? null))),
        resumes: avg(finite(set.map((byTask) => byTask[task.id]?.metrics.questions.resumes ?? null))),
        models: [...new Set(set.flatMap((byTask) => Object.keys(byTask[task.id]?.metrics.byModel || {})))].sort(),
      };
    };
    return { id: task.id, A: side(A), B: side(B) };
  });
  const infraShare = { baseline: exclusionTally(A).share, candidate: exclusionTally(B).share };
  const costNoise = noiseValid ? noise.cost : {};
  const cost: Record<string, any> = {};
  for (const metric of AB_COST_METRICS) {
    const a = taskMeans(A, taskSet, metric.pick);
    const b = taskMeans(B, taskSet, metric.pick);
    const paired = taskSet.tasks.filter((t: any) => Number.isFinite(a[t.id]) && Number.isFinite(b[t.id]) && (a[t.id] as number) > 0);
    const gains = paired.map((t: any) => -(((b[t.id] as number) - (a[t.id] as number)) / (a[t.id] as number)));
    const gain = avg(gains);
    const ci95 = gains.length ? bootstrapCI(gains, streamSeed(noiseConfig.seed, 'ab', 'cost', 'relative', metric.id)) : null;
    const band = Number.isFinite(costNoise?.[metric.id]) ? costNoise[metric.id] : null;
    const rule = ruleVerdict({
      precondition: noiseValid ? null : (noiseFile === null ? null : 'noise-artifact-invalid'), noise: band, mde: noiseConfig.mde,
      maxInfraShare: noiseConfig.maxInfraShare, infraShare, n: gains.length, gain: gain ?? 0, ci95,
    });
    const sumA = paired.reduce((s: number, t: any) => s + (a[t.id] as number), 0);
    const sumB = paired.reduce((s: number, t: any) => s + (b[t.id] as number), 0);
    cost[metric.id] = {
      label: metric.label, n: gains.length, gain, ci95, noise: band, band: band === null ? null : Math.max(band, noiseConfig.mde),
      ratio: sumA > 0 ? sumB / sumA : null, perTask: Object.fromEntries(taskSet.tasks.map((t: any) => [t.id, { A: a[t.id], B: b[t.id] }])), ...rule,
    };
  }

  // Part 4: validity
  const hashes = new Map<string, Set<string>>();
  for (const it of [...bandIts, ...its]) {
    for (const task of taskSet.tasks) {
      const launch = readJsonOrNull(path.join(it.dir, task.id, RUN_FILES.launch));
      if (!launch) continue;
      if (!hashes.has(task.id)) hashes.set(task.id, new Set());
      hashes.get(task.id)!.add(launch.promptSha256);
    }
  }
  const mismatched = [...hashes].filter(([, set]) => set.size > 1).map(([id]) => id);
  if (mismatched.length) throw new UsageError('prompt-mismatch', `report: the prompt differs between runs of ${mismatched.join(', ')}; both arms must get one prompt`);
  const proofCounts = (set: Record<string, any>[]) => {
    const all = set.flatMap((byTask) => Object.values(byTask) as any[]);
    return {
      runs: all.length,
      p1: all.filter((g) => g.proof.p1 === true).length,
      p2: all.filter((g) => g.proof.loaded === true).length,
      p3: all.filter((g) => g.proof.sessionStartOk === true).length,
      absent: all.filter((g) => g.proof.absent === true).length,
    };
  };
  const bAll = B.flatMap((byTask) => Object.values(byTask) as any[]);
  const routable = bAll.filter((g) => g.routing !== null && abExcludedOf(g) === null);
  const capped = (set: Record<string, any>[]) => {
    const all = set.flatMap((byTask) => Object.values(byTask) as any[]).filter((g) => g.capped);
    return { runs: all.length, ids: all.map((g) => g.id) };
  };
  const sensitivity = (set: Record<string, any>[]) => {
    const edits = set.flatMap((byTask) => Object.values(byTask) as any[]).filter((g) => g.kind === 'edit');
    const scored = edits.map((g) => (g.capped ? 0 : (abExcludedOf(g) === null ? g.pass_rate : null)));
    return avg(finite(scored));
  };
  const spent = (set: Record<string, any>[]) => set.flatMap((byTask) => Object.values(byTask) as any[]).reduce((s, g) => s + (g.metrics.tokens?.total ?? 0), 0);
  const validity = {
    A: { ...exclusionTally(A), proof: proofCounts(A), capped: capped(A), successIfCappedScored0: sensitivity(A), spentTokens: spent(A) },
    B: { ...exclusionTally(B), proof: proofCounts(B), capped: capped(B), successIfCappedScored0: sensitivity(B), spentTokens: spent(B) },
    routing: { eligible: routable.length, routed: routable.filter((g) => g.routing.routed).length },
    promptShaEqual: true,
    p5: 'deferred (first-request context delta is not measured by this runner)',
  };

  // Part 3: fixed cost (an input file)
  const fixedInput = readFixedCost(fixedCostPath);
  const fixed = fixedInput === null ? null : {
    rows: fixedInput.rows,
    hookOverhead: Number.isFinite(fixedInput.hookLatencyMsP50) && finite(bAll.map((g) => (abExcludedOf(g) === null ? g.metrics.toolCalls : null))).length
      ? { p50Ms: fixedInput.hookLatencyMsP50, toolCallsPerRun: avg(finite(bAll.map((g) => (abExcludedOf(g) === null ? g.metrics.toolCalls : null)))), basis: 'INFERRED product: p50 latency x mean tool calls of arm B runs' }
      : null,
  };

  const graderRerun = {
    runs: candidate.length * taskSet.tasks.length,
    differing: candidate.flatMap((g: any) => g.differing),
    stale: candidate.flatMap((g: any) => g.stale),
  };
  const noiseVerdicts = Object.fromEntries(metrics.map((m) => [m, noiseValid ? noise.metrics[m].verdict : null]));
  return {
    exit: 0, roles: config.roles, metrics, decisions, candidateMeans, noiseVerdicts, baselineMeans: Object.fromEntries(metrics.map((m) => [m, noiseValid ? noise.metrics[m].scopes.corpus.repeatMeans : []])),
    cost, tasksCost, fixed, validity, graderRerun, noiseFile, thresholds: { mde: noiseConfig.mde, maxInfraShare: noiseConfig.maxInfraShare },
  };
}

function abReportLines(r: any) {
  const { baseline: a, candidate: b } = r.roles;
  const seq = (xs: any[], d = 3) => (xs.length ? xs.map((x) => num(x, d)).join(' / ') : 'none');
  const lines: string[] = [`Part 1 - quality (096 rules unchanged; ${a} = baseline band, ${b} = candidate)`];
  lines.push(`| Metric | n paired | ${a} mean (repeats) | ${b} mean (repeats) | Gain ${b}-${a} | A/A noise | Band max(noise, mde) | ci95 | Noise verdict (${a}) | Decision |`, '|---|---|---|---|---|---|---|---|---|---|');
  for (const m of r.metrics) {
    const d = r.decisions[m].corpus;
    lines.push(`| ${AB_QUALITY_LABEL[m]} | ${d.n} | ${seq(r.baselineMeans[m])} | ${seq(r.candidateMeans[m])} | ${signed(d.gain)} | ${num(d.noise)} | ${num(d.band)} | ${Array.isArray(d.ci95) ? `[${num(d.ci95[0])}, ${num(d.ci95[1])}]` : 'none'} | ${r.noiseVerdicts[m] ?? 'none'} | ${d.verdict} (${d.reason}) |`);
  }
  for (const m of r.metrics) {
    const d = r.decisions[m];
    if (d.corpus.reason === 'no-noise-band') lines.push(`no noise band for ${m}: run \`npm run bench -- agentic noise --config <ab config> --iterations <a-r1,a-r2,a-r3> --out <file>\` over the ${a} repeats first`);
    lines.push(`${m}: ${scopeLine('corpus', d.corpus)}`);
  }
  if (r.graderRerun.differing.length || r.graderRerun.stale.length) {
    lines.push(`warning: grader re-run of arm ${b}: ${r.graderRerun.differing.length} differing, ${r.graderRerun.stale.length} stale of ${r.graderRerun.runs} run(s); the fresh grading is the score: ${[...new Set([...r.graderRerun.differing, ...r.graderRerun.stale])].join(', ')}`);
  }

  lines.push('', `Part 2 - cost and behaviour (mean over repeats of the runs that were not excluded; ${a} then ${b} per task)`);
  lines.push('| Task | arm | input | cache_creation | cache_read | output | total tokens | cost USD | wall s | tool calls | pauses | resumes | turns | subagent tokens | models |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of r.tasksCost) {
    for (const [arm, label] of [['A', a], ['B', b]] as [string, string][]) {
      const s = t[arm];
      lines.push(`| ${t.id} | ${label} | ${num(s.input, 0)} | ${num(s.cacheCreation, 0)} | ${num(s.cacheRead, 0)} | ${num(s.output, 0)} | ${num(s.totalTokens, 0)} | ${num(s.costUsd, 4)} | ${num(s.wallSeconds, 1)} | ${num(s.toolCalls, 1)} | ${num(s.pauses, 2)} | ${num(s.resumes, 2)} | ${num(s.turns, 1)} | ${num(s.subagentTokens, 0)} | ${s.models.join(', ') || 'none'} |`);
    }
  }
  lines.push(`| ratio ${b}/${a}, paired tasks | | | | | | ${num(r.cost.totalTokens.ratio, 3)} | ${num(r.cost.costUsd.ratio, 3)} | ${num(r.cost.wallSeconds.ratio, 3)} | ${num(r.cost.toolCalls.ratio, 3)} | | | | | |`);
  lines.push('| metric | n | mean relative saving (cheaper = gain) | A/A relative range | band max(range, mde) | ci95 | verdict |', '|---|---|---|---|---|---|---|');
  for (const metric of AB_COST_METRICS) {
    const c = r.cost[metric.id];
    lines.push(`| ${metric.label} | ${c.n} | ${signed(c.gain)} | ${num(c.noise)} | ${num(c.band)} | ${Array.isArray(c.ci95) ? `[${num(c.ci95[0])}, ${num(c.ci95[1])}]` : 'none'} | ${c.verdict} (${c.reason}) |`);
  }
  lines.push('questions: counts only, no verdict (a zero baseline makes the ratio meaningless); see the pauses and resumes columns.');

  lines.push('', 'Part 3 - fixed cost (DoFlow before any work; read from the --fixed-cost input, not measured here)');
  if (r.fixed === null) lines.push('not supplied: pass --fixed-cost <file> ({ rows: [{ item, value, source }], hookLatencyMsP50?: number })');
  else {
    lines.push('| Item | Value | Source |', '|---|---|---|', ...r.fixed.rows.map((x: any) => `| ${x.item} | ${x.value} | ${x.source} |`));
    if (r.fixed.hookOverhead) lines.push(`hook overhead per run (${r.fixed.hookOverhead.basis}): ${num(r.fixed.hookOverhead.p50Ms * r.fixed.hookOverhead.toolCallsPerRun, 0)} ms (p50 ${r.fixed.hookOverhead.p50Ms} ms x ${num(r.fixed.hookOverhead.toolCallsPerRun, 1)} tool calls)`);
  }

  lines.push('', 'Part 4 - validity');
  for (const [arm, label] of [['A', a], ['B', b]] as [string, string][]) {
    const v = r.validity[arm];
    lines.push(`arm ${label}: ${v.excluded} of ${v.runs} run(s) excluded (share ${num(v.share)} vs max ${r.thresholds.maxInfraShare}): ${marks(v.marks)}; reasons: ${marks(v.reasons)}; spent ${v.spentTokens} tokens incl. excluded`);
    lines.push(`  proof: P1 installed ${v.proof.p1}/${v.proof.runs}, P2 harness saw it ${v.proof.p2}/${v.proof.runs}, P3 hooks fired ${v.proof.p3}/${v.proof.runs}, DoFlow absent ${v.proof.absent}/${v.proof.runs}`);
    lines.push(`  cap sensitivity: ${v.capped.runs} run(s) stopped at the cap${v.capped.runs ? ` (${v.capped.ids.join(', ')})` : ''}; success mean with those scored 0: ${num(v.successIfCappedScored0)}`);
  }
  lines.push(`routing (P4, reported not required): arm ${b} used the expected skill in ${r.validity.routing.routed} of ${r.validity.routing.eligible} eligible run(s)`);
  lines.push(`prompts equal across arms: ${r.validity.promptShaEqual}; P5: ${r.validity.p5}`);
  lines.push(`noise artifact: ${r.noiseFile ? r.noiseFile.path : 'none'}`);
  return lines;
}

module.exports = {
  BASELINE_ARM, CANDIDATE_ARM, AB_NOISE_KIND, AB_QUALITY, AB_COST_METRICS, abExcludedOf, regradeAbRepeat, abNoiseOf, abReportOf, abReportLines, validateAbNoise,
  parseIterations, excludedOf, noiseOf, reportOf, tokenReport, noiseLines, reportLines,
};
