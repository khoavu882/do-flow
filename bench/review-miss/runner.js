'use strict';

/**
 * Review-miss bench CLI (feature 095b, IC-008): `npm run bench -- review-miss <verb> [flags]`,
 * reached through one forward in bench/runner.js. Parses the verb and its flags, refuses anything
 * unknown (exit 2), runs the verb and maps its result to an exit code.
 *
 * Verbs here: `corpus` (generate cases from the review records), `lint` (check a corpus file),
 * `grade` (score an iteration's findings, IC-009), `noise` (the A/A band) and `report` (a decision
 * against that band, IC-010). No verb calls a model; the only subprocess is `git`, read-only, and
 * only `corpus` and `lint` run it.
 *
 * `main(argv, opts) -> exit code` is synchronous and takes injectable options for tests (repoRoot,
 * runRoot, resolveRecordsRoot, config, noiseConfig, out, err).
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseFlags, UsageError: FlagError } = require('../retrieval/runner.js');
const { loadNoiseConfig } = require('../noise.js');
const { UsageError, loadConfig, buildCorpus, lintCorpus } = require('./corpus.js');
const { checkCorpus, gradeIteration, parseIterations, FILES } = require('./grade.js');
const report = require('./report.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BENCH_CONFIG = path.join(__dirname, '..', 'config.json');
const DEFAULT_RUN_ROOT = path.join('bench', 'runs', 'review-miss');
const DEFAULT_CORPUS = path.join(DEFAULT_RUN_ROOT, 'corpus.json');
const VERB_FLAGS = Object.freeze({
  corpus: { records: 'value', out: 'value', json: 'bool' },
  lint: { corpus: 'value', json: 'bool' },
  grade: { iteration: 'value', corpus: 'value', json: 'bool' },
  noise: { iterations: 'value', out: 'value', json: 'bool' },
  report: { iterations: 'value', noise: 'value', 'decision-out': 'value', json: 'bool' },
});
const REQUIRED = Object.freeze({ corpus: [], lint: [], grade: ['iteration'], noise: ['iterations'], report: ['iterations'] });
const USAGE = `usage: bench review-miss <verb> [flags]
  corpus [--records <dir>] [--out <file>] [--json]    generate cases from the fixed findings of the review records
  lint   [--corpus <file>] [--json]                   check a corpus file (exit 1 on any problem)
  grade  --iteration <name> [--corpus <file>] [--json]                      score the findings of one iteration (grade.json)
  noise  --iterations <a,b,c> [--out <file>] [--json]                       the A/A band over graded iterations (exit 1 unless usable)
  report --iterations <a,b,c> [--noise <file>] [--decision-out <file>] [--json]   decision against the band (no band: inconclusive)`;

const rel = (repoRoot, p) => {
  const r = path.relative(repoRoot, p);
  return r.startsWith('..') ? p : r.split(path.sep).join('/');
};

/**
 * Default records root: `<feature_root>/agent-docs/doflow`, where feature_root is what the runtime's
 * feature resolver reports (the main checkout when this is a linked worktree). The resolver needs an
 * active feature; without one the caller must pass `--records`.
 */
function resolveRecordsRoot(repoRoot) {
  const { resolveActiveFeature } = require('../../src/runtime/feature-resolve.ts');
  const feature = resolveActiveFeature({ projectRoot: repoRoot });
  if (feature.error) throw new UsageError(`cannot resolve the records root (${feature.message}); pass --records <dir>`);
  return path.join(feature.featureRoot, 'agent-docs', 'doflow');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readCorpus(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`corpus is missing or unreadable: ${file} (${e.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`corpus is not JSON: ${file} (${e.message})`);
  }
}

const skippedLine = (s) => `skipped: record-invalid ${s['record-invalid'].length}, not-fixed ${s['not-fixed']}, severity ${s.severity}, locator ${s.locator}, no-parent ${s['no-parent']}, path-absent ${s['path-absent']}`;

function cmdCorpus(ctx, flags) {
  const recordsRoot = flags.records ? path.resolve(flags.records) : ctx.resolveRecordsRoot(ctx.repoRoot);
  const result = buildCorpus({ recordsRoot, repoRoot: ctx.repoRoot, config: ctx.config });
  const heldout = result.cases.filter((c) => c.split === 'heldout').length;
  if (result.cases.length === 0) {
    ctx.err(`review-miss corpus: no eligible case in ${result.records} valid record(s); ${skippedLine(result.skipped)}`);
    for (const slug of result.skipped['record-invalid']) ctx.err(`  record-invalid: ${slug}`);
    return 1;
  }
  const out = path.resolve(flags.out || path.join(ctx.repoRoot, DEFAULT_CORPUS));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  if (flags.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return 0;
  }
  ctx.out(`corpus: ${result.cases.length} case(s) (${heldout} heldout) from ${result.records} record(s); ${skippedLine(result.skipped)}`);
  for (const slug of result.skipped['record-invalid']) ctx.out(`  record-invalid: ${slug}`);
  ctx.out(`written: ${rel(ctx.repoRoot, out)}`);
  return 0;
}

function cmdLint(ctx, flags) {
  const file = path.resolve(flags.corpus || path.join(ctx.repoRoot, DEFAULT_CORPUS));
  const corpus = readCorpus(file);
  const problems = lintCorpus({ corpus, config: ctx.config, repoRoot: ctx.repoRoot });
  if (flags.json) {
    ctx.out(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
    return problems.length ? 1 : 0;
  }
  for (const p of problems) ctx.err(p);
  if (problems.length === 0) ctx.out(`lint: clean (${corpus.cases.length} case(s)): ${rel(ctx.repoRoot, file)}`);
  return problems.length ? 1 : 0;
}

function cmdGrade(ctx, flags) {
  const [name] = parseIterations(flags.iteration, '--iteration');
  const corpus = checkCorpus(readCorpus(path.resolve(flags.corpus || path.join(ctx.repoRoot, DEFAULT_CORPUS))));
  const iterationDir = path.join(ctx.runRoot, name);
  if (!fs.existsSync(iterationDir)) throw new UsageError(`no iteration at ${iterationDir}`);
  const grade = gradeIteration({ iterationDir, name, corpus, config: ctx.config });
  writeJson(path.join(iterationDir, FILES.grade), grade);
  if (flags.json) {
    ctx.out(JSON.stringify(grade, null, 2));
    return 0;
  }
  ctx.out('| case | split | pass_rate |');
  ctx.out('|---|---|---|');
  for (const c of corpus.cases) {
    const r = grade.runs[c.key];
    ctx.out(`| ${c.id} | ${r.split} | ${r.excluded ?? r.passRate} |`);
  }
  const values = Object.values(grade.runs);
  const found = values.filter((r) => r.passRate === 1).length;
  const excluded = values.filter((r) => r.excluded !== null).length;
  ctx.out(`graded ${values.length} case(s) of ${name}: ${found} found, ${values.length - found - excluded} not found, ${excluded} excluded`);
  return 0;
}

function cmdNoise(ctx, flags) {
  const { exit, artifact } = report.noiseOf({ runRoot: ctx.runRoot, iterations: flags.iterations, noiseConfig: ctx.noiseConfig() });
  if (flags.out) writeJson(path.resolve(flags.out), artifact);
  if (flags.json) ctx.out(JSON.stringify(artifact, null, 2));
  else {
    for (const line of report.noiseLines(artifact)) ctx.out(line);
    if (flags.out) ctx.out(`noise: ${rel(ctx.repoRoot, path.resolve(flags.out))}`);
  }
  return exit;
}

function cmdReport(ctx, flags) {
  const { exit, decision } = report.reportOf({
    runRoot: ctx.runRoot, iterations: flags.iterations, noiseConfig: ctx.noiseConfig(), repoRoot: ctx.repoRoot,
    noisePath: flags.noise === undefined ? null : path.resolve(flags.noise),
  });
  const out = flags['decision-out'] ? path.resolve(flags['decision-out']) : null;
  if (out) writeJson(out, decision);
  if (flags.json) ctx.out(JSON.stringify({ decision }, null, 2));
  else {
    for (const line of report.reportLines({ decision })) ctx.out(line);
    if (out) ctx.out(`decision: ${rel(ctx.repoRoot, out)}`);
  }
  return exit;
}

const VERBS = Object.freeze({ corpus: cmdCorpus, lint: cmdLint, grade: cmdGrade, noise: cmdNoise, report: cmdReport });

/** 0 done (noise: a usable band); 1 corpus: no eligible case, lint: a problem found, noise: another verdict; 2 usage, unreadable or inconsistent input. */
function main(argv, opts = {}) {
  const out = opts.out || ((m) => process.stdout.write(`${m}\n`));
  const err = opts.err || ((m) => process.stderr.write(`${m}\n`));
  const verb = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  try {
    if (!verb) throw new UsageError(USAGE);
    if (!Object.hasOwn(VERBS, verb)) throw new UsageError(`unknown verb "${verb}" (verbs: ${Object.keys(VERBS).join(', ')})`);
    const { flags, rest } = parseFlags(argv.slice(1), VERB_FLAGS[verb]);
    if (rest.length) throw new UsageError(`unexpected argument "${rest[0]}"`);
    for (const name of REQUIRED[verb]) if (flags[name] === undefined) throw new UsageError(`--${name} is required`);
    const repoRoot = opts.repoRoot || REPO_ROOT;
    let noiseConfig = opts.noiseConfig || null;
    const ctx = {
      repoRoot,
      runRoot: opts.runRoot || path.join(repoRoot, DEFAULT_RUN_ROOT),
      config: opts.config || loadConfig(),
      noiseConfig: () => (noiseConfig ??= loadNoiseConfig(JSON.parse(fs.readFileSync(BENCH_CONFIG, 'utf8')))),
      resolveRecordsRoot: opts.resolveRecordsRoot || resolveRecordsRoot,
      out,
      err,
    };
    return VERBS[verb](ctx, flags);
  } catch (e) {
    if (e instanceof UsageError || e instanceof FlagError || /^bench\/config\.json noise is invalid/.test(e.message)) {
      err(`review-miss${verb ? ` ${verb}` : ''}: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { VERB_FLAGS, USAGE, resolveRecordsRoot, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
