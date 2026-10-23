'use strict';

/**
 * Review-miss bench CLI (feature 095b, IC-008): `npm run bench -- review-miss <verb> [flags]`,
 * reached through one forward in bench/runner.js. Parses the verb and its flags, refuses anything
 * unknown (exit 2), runs the verb and maps its result to an exit code.
 *
 * Verbs here: `corpus` (generate cases from the review records) and `lint` (check a corpus file).
 * Further verbs register in VERBS, VERB_FLAGS and REQUIRED below. No verb calls a model; the only
 * subprocess is `git`, read-only.
 *
 * `main(argv, opts) -> exit code` is synchronous and takes injectable options for tests (repoRoot,
 * resolveRecordsRoot, config, out, err).
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseFlags, UsageError: FlagError } = require('../retrieval/runner.js');
const { UsageError, loadConfig, buildCorpus, lintCorpus } = require('./corpus.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_CORPUS = path.join('bench', 'runs', 'review-miss', 'corpus.json');
const VERB_FLAGS = Object.freeze({
  corpus: { records: 'value', out: 'value', json: 'bool' },
  lint: { corpus: 'value', json: 'bool' },
});
const REQUIRED = Object.freeze({ corpus: [], lint: [] });
const USAGE = `usage: bench review-miss <verb> [flags]
  corpus [--records <dir>] [--out <file>] [--json]    generate cases from the fixed findings of the review records
  lint   [--corpus <file>] [--json]                   check a corpus file (exit 1 on any problem)`;

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

const VERBS = Object.freeze({ corpus: cmdCorpus, lint: cmdLint });

/** 0 done; 1 corpus: no eligible case, lint: a problem found; 2 usage, unreadable input. */
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
    const ctx = {
      repoRoot: opts.repoRoot || REPO_ROOT,
      config: opts.config || loadConfig(),
      resolveRecordsRoot: opts.resolveRecordsRoot || resolveRecordsRoot,
      out,
      err,
    };
    return VERBS[verb](ctx, flags);
  } catch (e) {
    if (e instanceof UsageError || e instanceof FlagError) {
      err(`review-miss${verb ? ` ${verb}` : ''}: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { VERB_FLAGS, USAGE, resolveRecordsRoot, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
