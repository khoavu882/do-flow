'use strict';

/**
 * Review-miss band and decision (feature 095b, IC-010): hands the `grade.json` repeats of graded
 * iterations to `computeNoise` (the A/A band) and `buildDecision` (a candidate against that band),
 * unchanged in meaning from the 096 rules in bench/noise.js. Offline: reads files only.
 *
 * The case set a decision expects is the first candidate repeat's own keys. A key digests the
 * revision and the truth, so a band measured on another corpus fails 096's case-set precondition
 * instead of being compared.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { computeNoise, buildDecision, validateNoiseArtifact } = require('../noise.ts');
const { UsageError } = require('./corpus.ts');
const { parseIterations, readRepeat } = require('./grade.ts');

/**
 * `review-miss noise`: the band over `iterations`. Exit 0 when usable, 1 for another noise verdict;
 * a UsageError (exit 2) for fewer than k repeats, or repeats that differ in model, commit or case keys.
 * @returns {{exit: number, artifact: object}}
 */
function noiseOf({ runRoot, iterations, noiseConfig }: { runRoot: string; iterations: any; noiseConfig: any }) {
  const names = parseIterations(iterations);
  if (names.length < noiseConfig.k) {
    throw new UsageError(`noise: ${names.length} iteration(s) given, the band needs k = ${noiseConfig.k}`);
  }
  const repeats: any[] = names.map((name: string) => readRepeat(runRoot, name, 'noise'));
  const [first] = repeats;
  const keys = (r: any) => Object.keys(r.runs).sort().join('\n');
  for (const r of repeats.slice(1)) {
    if (r.model !== first.model) throw new UsageError(`noise: model ${r.model} of ${r.iteration} differs from ${first.model} of ${first.iteration}`);
    if (r.commit !== first.commit) throw new UsageError(`noise: commit of ${r.iteration} differs from ${first.iteration}`);
    if (keys(r) !== keys(first)) throw new UsageError(`noise: case keys of ${r.iteration} differ from ${first.iteration}; grade both against one corpus`);
  }
  const artifact = computeNoise({
    repeats,
    config: noiseConfig,
    graderRerun: { runs: repeats.length * Object.keys(first.runs).length, differing: [], stale: [] },
  });
  const problems = validateNoiseArtifact(artifact);
  if (problems.length) throw new Error(`noise: internal artifact validation failed: ${problems.join('; ')}`);
  return { exit: artifact.verdict === 'usable' ? 0 : 1, artifact };
}

/**
 * `review-miss report`: the decision of the candidate `iterations` against the noise artifact at
 * `noisePath` (an explicit `--noise`; null means none, so the verdict is `inconclusive` with
 * `no-noise-band`). An unparseable or invalid artifact is 096's `noise-artifact-invalid`.
 */
function reportOf({ runRoot, iterations, noiseConfig, noisePath, repoRoot }: { runRoot: string; iterations: any; noiseConfig: any; noisePath: string | null; repoRoot: string }) {
  const names = parseIterations(iterations);
  const candidate: any[] = names.map((name: string) => readRepeat(runRoot, name, 'report'));
  let noise: any = null;
  let noiseFile: any = null;
  if (noisePath !== null) {
    let raw: string;
    try {
      raw = fs.readFileSync(noisePath, 'utf8');
    } catch {
      throw new UsageError(`report: no noise artifact at ${noisePath}`);
    }
    try {
      noise = JSON.parse(raw);
    } catch {
      // an unparseable file is still a file: buildDecision marks it noise-artifact-invalid
    }
    const rel = path.relative(repoRoot, noisePath);
    noiseFile = { path: (rel.startsWith('..') ? noisePath : rel).split(path.sep).join('/'), sha256: crypto.createHash('sha256').update(raw).digest('hex') };
  }
  const [first] = candidate;
  const baselineFile = {
    model: first.model,
    commit: null,
    results: Object.entries(first.runs).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, r]: [string, any]) => ({ key, kind: r.kind, split: r.split })),
  };
  const decision = buildDecision({ noise, noiseFile, baselineFile, model: first.model, candidate, thresholds: noiseConfig });
  return { exit: 0, decision };
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

const num = (x: any, digits = 3) => (Number.isFinite(x) ? x.toFixed(digits) : 'none');
const signed = (x: any) => (Number.isFinite(x) ? `${x < 0 ? '-' : '+'}${Math.abs(x).toFixed(3)}` : 'none');
const marks = (counts: any) => Object.entries(counts || {}).filter(([, n]: any) => n > 0).map(([m, n]: any) => `${m} ${n}`).join(', ') || 'none';

function noiseLines(a: any) {
  const lines = [`noise over ${a.k} repeat(s) of ${a.model} at ${String(a.commit).slice(0, 8)} (${a.method}): ${a.iterations.join(', ')}`];
  lines.push('| scope | repeat means | noise | mean | headroom |', '|---|---|---|---|---|');
  for (const [scope, s] of Object.entries(a.scopes) as [string, any][]) {
    lines.push(`| ${scope} | ${s.repeatMeans.map((m: any) => num(m)).join(' / ')} | ${num(s.noise)} | ${num(s.baselineMean)} | ${s.headroom === null ? 'none' : s.headroom ? 'yes' : 'no'} |`);
  }
  lines.push(`excluded: ${a.infra.excluded} of ${a.infra.runs} run(s)`);
  lines.push(`verdict: ${a.verdict} (${a.reason})`);
  return lines;
}

const scopeLine = (name: any, s: any) => `decision ${name}: ${s.verdict} (${s.reason}) -> ${s.recommendation}; gain ${signed(s.gain)} over n ${s.n}, band ${num(s.band)}`;

const NO_BAND_LINE = 'no noise band: run `npm run bench -- review-miss noise --iterations <r1,r2,r3> --out <file>` over the baseline repeats, then pass `--noise <file>`';

function reportLines({ decision }: { decision: any }) {
  return [
    scopeLine('corpus', decision.corpus),
    scopeLine('train', decision.splits.train),
    scopeLine('heldout', decision.splits.heldout),
    ...(decision.corpus.reason === 'no-noise-band' ? [NO_BAND_LINE] : []),
    `overfitSuspected: ${decision.overfitSuspected}; precondition: ${decision.precondition ?? 'none'}`,
    `noise artifact: ${decision.inputs.noiseArtifact ? `${decision.inputs.noiseArtifact.path} (${decision.inputs.noiseArtifact.verdict ?? 'invalid'})` : 'none'}`,
    `excluded runs: baseline ${marks(decision.infra.baseline)}; candidate ${marks(decision.infra.candidate)}`,
  ];
}

module.exports = { noiseOf, reportOf, noiseLines, reportLines };
