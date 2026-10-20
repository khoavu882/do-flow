'use strict';

/**
 * Agentic baseline CLI (feature 097, IC-004 to IC-009): `npm run bench -- agentic <verb> [flags]`,
 * reached through one forward in bench/runner.js. Parses the verb and its flags, refuses anything
 * unknown (exit 2), runs the verb and maps its result to an exit code.
 *
 * Money rule: only `execute` can spawn, and `executeIteration` refuses before any spawn without a
 * valid `--cap`. `plan`, `grade`, `noise` and `report` read files only; `plan` prints the paid
 * commands as text and never runs them.
 *
 * `main(argv, opts)` takes injectable options for tests (repoRoot, runRoot, resultsDir, config,
 * registry, taskSet, noiseConfig, pathInfo, env, sourceHome, tmpDir, materialise, now, out, err).
 * The executor's test-only `extraEnv` is never forwarded: the CLI path runs a real child env.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseFlags, UsageError: FlagError } = require('../retrieval/runner.js');
const { loadNoiseConfig } = require('../noise.js');
const { UsageError, loadTaskSet } = require('./tasks.js');
const execute = require('./execute.js');
const { gradeIteration, loadPathInfo } = require('./grade.js');
const report = require('./report.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BENCH_CONFIG = path.join(__dirname, '..', 'config.json');
const VERB_FLAGS = Object.freeze({
  plan: { iteration: 'value', arm: 'value', tasks: 'value', json: 'bool' },
  execute: { iteration: 'value', arm: 'value', cap: 'value', tasks: 'value', json: 'bool' },
  grade: { iteration: 'value', json: 'bool' },
  noise: { iterations: 'value', out: 'value', json: 'bool' },
  report: { iterations: 'value', noise: 'value', 'decision-out': 'value', json: 'bool' },
});
const REQUIRED = Object.freeze({ plan: ['iteration', 'arm'], execute: ['iteration', 'arm'], grade: ['iteration'], noise: ['iterations'], report: ['iterations'] });
const USAGE = `usage: bench agentic <verb> [flags]
  plan    --iteration <name> --arm <arm> [--tasks <id,id>] [--json]          offline projection and the paid stages (text only)
  execute --iteration <name> --arm <arm> --cap <tokens> [--tasks <id,id>]    the only verb that spawns the harness (paid)
  grade   --iteration <name> [--json]                                        write grading.json per run
  noise   --iterations <a,b,c> [--out <file>] [--json]                       arm N band (096 noise artifact)
  report  --iterations <a,b,c> [--noise <file>] [--decision-out <file>] [--json]  arm D decision and token report`;

/** Committed result paths the paid stages write (IC-008, IC-009). */
const RESULT_NOISE = 'bench/agentic/results/noise.json';
const RESULT_DECISION = 'bench/agentic/results/decision.json';
const STAGE_PREFIX = 'npm run bench -- agentic';

const rel = (repoRoot, p) => path.relative(repoRoot, p).split(path.sep).join('/');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The paid stages as text (IC-004): R rehearses one train task per arm, each command capped at one
 * run (`maxTokensPerRun`), so the two commands together authorize exactly two runs (review N-2); N
 * and D run k repeats each under the full-set ceiling. Iteration names differ per arm because an iteration
 * holds one arm (execute refuses a second arm in the same iteration).
 */
function paidStages({ taskSet, config, k }) {
  const first = taskSet.train[0]?.id ?? taskSet.tasks[0].id;
  const ceiling = taskSet.tasks.length * config.maxTokensPerRun;
  const reps = (prefix) => Array.from({ length: k }, (_, i) => `${prefix}-r${i + 1}`);
  const stage = (arm, prefix, tail) => [
    ...reps(prefix).map((it) => `${STAGE_PREFIX} execute --iteration ${it} --arm ${arm} --cap ${ceiling}`),
    ...reps(prefix).map((it) => `${STAGE_PREFIX} grade --iteration ${it}`),
    tail(reps(prefix).join(',')),
  ];
  return {
    R: ['N', 'D'].map((arm) => `${STAGE_PREFIX} execute --iteration rehearsal-${arm} --arm ${arm} --tasks ${first} --cap ${config.maxTokensPerRun}`),
    N: stage('N', 'n', (its) => `${STAGE_PREFIX} noise --iterations ${its} --out ${RESULT_NOISE}`),
    D: stage('D', 'd', (its) => `${STAGE_PREFIX} report --iterations ${its} --decision-out ${RESULT_DECISION}`),
    note: 'Paid: each stage needs the user\'s approval of the cap, the model and the credential copy (O-1, O-2, O-5) before it runs; stage D waits until the arm N band has been read.',
  };
}

function cmdPlan(ctx, flags) {
  const { config, taskSet, repoRoot } = ctx;
  const plan = execute.planIteration({
    repoRoot, config, taskSet, registry: ctx.registry, arm: flags.arm, iteration: flags.iteration, tasks: flags.tasks, runRoot: ctx.runRoot,
  });
  const stages = paidStages({ taskSet, config, k: ctx.noiseConfig().k });
  if (flags.json) {
    ctx.out(JSON.stringify({ ...plan, stages }, null, 2));
    return 0;
  }
  const p = plan.projection;
  ctx.out(`plan ${plan.iteration}: arm ${plan.arm}, harness ${plan.harness} (${plan.harnessBinary}), model ${plan.model}, snapshot ${plan.snapshot}`);
  ctx.out('| task | key | split | kind | run directory | argv (prompt on stdin) |');
  ctx.out('|---|---|---|---|---|---|');
  for (const r of plan.runs) {
    ctx.out(`| ${r.id} | ${r.key} | ${r.split} | ${r.kind} | ${rel(repoRoot, r.runDir)} | ${r.argvShape.join(' ')} < <prompt sha256:${r.promptSha256} bytes:${r.promptBytes}> |`);
  }
  ctx.out(`projection: runs ${p.runs}, maxTokensPerRun ${p.maxTokensPerRun}, ceilingTokens ${p.ceilingTokens}, typicalTokens ${p.typicalTokens ?? 'unknown'}`);
  ctx.out(capMeaning(config));
  ctx.out('paid stages (text only, never run by plan):');
  for (const name of ['R', 'N', 'D']) for (const line of stages[name]) ctx.out(`  stage ${name}: ${line}`);
  ctx.out(stages.note);
  return 0;
}

/**
 * What `--cap` guarantees (review C-5): a projected ceiling, not a hard stop inside a run. Usage is
 * known only at the turn end, so a run can pass maxTokensPerRun; only timeoutSeconds bounds it.
 */
const capMeaning = (config) => `cap: execute starts a run only while spent + maxTokensPerRun (${config.maxTokensPerRun}) <= --cap; `
  + `a run's real usage is known only at its end, so the worst case is --cap plus one run's overshoot beyond maxTokensPerRun, bounded only by timeoutSeconds (${config.timeoutSeconds}s); `
  + 'passing --cap ends execute with exit 3 and "cap exceeded by N tokens on <task>"';

/** The text result of `execute` (exit 0 or 3). */
function executeLines(result, iteration) {
  const lines = [`execute ${iteration}: ran ${result.ran.length} run(s), spent ${result.spent} tokens (unknown usage counted at maxTokensPerRun)`];
  if (result.capExceeded) lines.push(`cap exceeded by ${result.capExceeded.by} tokens on ${result.capExceeded.task}`);
  if (result.undone.length) lines.push(`stopped by --cap before: ${result.undone.join(', ')}`);
  return lines;
}

async function cmdExecute(ctx, flags) {
  const result = await execute.executeIteration({
    repoRoot: ctx.repoRoot, config: ctx.config, registry: ctx.registry, taskSet: ctx.taskSet, runRoot: ctx.runRoot,
    env: ctx.env, sourceHome: ctx.sourceHome, tmpDir: ctx.tmpDir, materialise: ctx.materialise, now: ctx.now,
    iteration: flags.iteration, arm: flags.arm, cap: flags.cap, tasks: flags.tasks,
  });
  if (result.exit === 2) {
    ctx.err(`agentic execute: refused (${result.reason}): ${result.refusal}`);
  } else if (flags.json) {
    ctx.out(JSON.stringify(result, null, 2));
  } else {
    for (const line of executeLines(result, flags.iteration)) ctx.out(line);
  }
  return result.exit;
}

function cmdGrade(ctx, flags) {
  const [name] = report.parseIterations(flags.iteration, '--iteration');
  const iterationDir = path.join(ctx.runRoot, name);
  const meta = execute.readIteration(iterationDir);
  if (!Object.prototype.hasOwnProperty.call(ctx.config.arms, meta.arm)) {
    throw new UsageError('arm-unknown', `grade: iteration ${name} is arm ${meta.arm}, which the config does not define`);
  }
  const gradings = gradeIteration({ iterationDir, taskSet: ctx.taskSet, config: ctx.config, pathInfo: ctx.pathInfo() });
  if (flags.json) {
    ctx.out(JSON.stringify(gradings, null, 2));
    return 0;
  }
  ctx.out('| task | run_status | infra | isolation | pass_rate |');
  ctx.out('|---|---|---|---|---|');
  for (const g of gradings) {
    if (g.missing) ctx.out(`| ${g.id} | missing | | | |`);
    else ctx.out(`| ${g.id} | ${g.run_status} | ${g.infra ?? ''} | ${g.isolation} | ${g.pass_rate ?? 'excluded'} |`);
  }
  const missing = gradings.filter((g) => g.missing).length;
  ctx.out(`graded ${gradings.length - missing} run(s) of ${name}; ${missing} task(s) without a run`);
  return 0;
}

function cmdNoise(ctx, flags) {
  const { exit, artifact } = report.noiseOf({
    runRoot: ctx.runRoot, iterations: flags.iterations, taskSet: ctx.taskSet, config: ctx.config, noiseConfig: ctx.noiseConfig(), pathInfo: ctx.pathInfo(),
  });
  if (flags.out) writeJson(path.resolve(flags.out), artifact);
  if (flags.json) ctx.out(JSON.stringify(artifact, null, 2));
  else {
    for (const line of report.noiseLines(artifact)) ctx.out(line);
    if (flags.out) ctx.out(`noise: ${rel(ctx.repoRoot, path.resolve(flags.out))}`);
  }
  if (artifact.graderRerun.stale.length) ctx.err(`warning: ${artifact.graderRerun.stale.length} run(s) have a stale grading.json: ${artifact.graderRerun.stale.join(', ')}`);
  return exit;
}

function cmdReport(ctx, flags) {
  const explicitNoise = flags.noise !== undefined;
  const result = report.reportOf({
    runRoot: ctx.runRoot, iterations: flags.iterations, taskSet: ctx.taskSet, config: ctx.config, noiseConfig: ctx.noiseConfig(),
    noisePath: explicitNoise ? path.resolve(flags.noise) : path.join(ctx.resultsDir, 'noise.json'), explicitNoise, repoRoot: ctx.repoRoot,
  });
  const out = flags['decision-out'] ? path.resolve(flags['decision-out']) : null;
  if (out) writeJson(out, result.decision);
  if (flags.json) ctx.out(JSON.stringify({ decision: result.decision, tokens: result.tokens }, null, 2));
  else {
    for (const line of report.reportLines(result)) ctx.out(line);
    if (out) ctx.out(`decision: ${rel(ctx.repoRoot, out)}`);
  }
  return result.exit;
}

const VERBS = Object.freeze({ plan: cmdPlan, execute: cmdExecute, grade: cmdGrade, noise: cmdNoise, report: cmdReport });

/**
 * `main(argv, opts) -> Promise<exit code>`: 0 done (noise: usable band), 1 noise verdict other than
 * usable, 2 refusal or invalid input, 3 execute stopped by the cap or a run passed it. A signal stops
 * execute after cleanup and is re-raised (the shell sees 128 + the signal number).
 */
async function main(argv, opts = {}) {
  const out = opts.out || ((m) => process.stdout.write(`${m}\n`));
  const err = opts.err || ((m) => process.stderr.write(`${m}\n`));
  const verb = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  try {
    if (!verb) throw new UsageError('usage', USAGE);
    if (!Object.prototype.hasOwnProperty.call(VERBS, verb)) throw new UsageError('verb-unknown', `unknown verb "${verb}" (verbs: ${Object.keys(VERBS).join(', ')})`);
    const { flags, rest } = parseFlags(argv.slice(1), VERB_FLAGS[verb]);
    if (rest.length) throw new UsageError('argument-unexpected', `unexpected argument "${rest[0]}"`);
    for (const name of REQUIRED[verb]) if (flags[name] === undefined) throw new UsageError('flag-missing', `--${name} is required`);

    const repoRoot = opts.repoRoot || REPO_ROOT;
    let noiseConfig = opts.noiseConfig || null;
    let pathInfo = opts.pathInfo || null;
    const ctx = {
      repoRoot, out, err,
      config: opts.config || execute.loadConfig(),
      registry: opts.registry,
      taskSet: opts.taskSet || loadTaskSet(),
      runRoot: opts.runRoot || path.join(repoRoot, 'bench', 'runs', 'agentic'),
      resultsDir: opts.resultsDir || path.join(repoRoot, 'bench', 'agentic', 'results'),
      env: opts.env, sourceHome: opts.sourceHome, tmpDir: opts.tmpDir, materialise: opts.materialise, now: opts.now,
      noiseConfig: () => (noiseConfig ??= loadNoiseConfig(JSON.parse(fs.readFileSync(BENCH_CONFIG, 'utf8')))),
      pathInfo: () => (pathInfo ??= loadPathInfo()),
    };
    return await VERBS[verb](ctx, flags);
  } catch (e) {
    if (e instanceof UsageError || e instanceof FlagError || /^bench\/config\.json noise is invalid/.test(e.message)) {
      err(`agentic${verb ? ` ${verb}` : ''}: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { VERB_FLAGS, paidStages, executeLines, capMeaning, main };

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
