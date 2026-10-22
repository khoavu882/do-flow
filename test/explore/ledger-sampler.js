'use strict';

// Opt-in exploration runner for the test-side sequence gate. Sampling is deliberately outside the
// npm test glob; each generated schedule still uses the real child processes and ledger source.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runSchedule, GATED_METHODS, parseTrace } = require('../helper/sequence-gate.js');
const realOracle = require('../helper/ledger-oracle.js');

const FS_NOTE = 'fs calls serialized per call; in-call overlap, network filesystems and process death are outside this model';
const VIOLATION_CLASSES = ['lost-ack', 'double-grant', 'resurrected', 'other-nonlinearizable', 'suspected-model-defect'];
const DEFAULT_SCHEDULES = 200;
const MAX_SCHEDULES = 5000;
const PER_SCHEDULE_MS = 5000;
const PER_RUN_MS = 600000;

const USAGE = `Usage: node test/explore/ledger-sampler.js --scenario S1|S2 [--init none|stale] [--age-at k] [--schedules N] [--seed n] [--replay <trace>] [--json] [--out <path>]

Defaults: --init stale, --schedules 200 (maximum 5000), and a clock-derived seed. A seed is printed so a run can be reproduced. Each schedule has a 5000 ms deadline; a run has a 600000 ms deadline.
--run-timeout-ms <ms> overrides the per-run kill switch for tests and diagnostics.
DOFLOW_SAMPLER_ORACLE=<path> loads a test-only module exporting check(observation) for sampling verdicts; real-oracle checks still gate every reported violation and every replay verdict.
--out <path> writes the same report that is printed. The filesystem model serializes calls and does not model in-call overlap, network filesystems, or process death.`;

function usageError(message) {
  process.stderr.write(`${message}\nUse --help for usage.\n`);
  process.exitCode = 2;
}

function integer(value, flag, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${flag}: expected an integer, got '${value}'`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${flag}: value must be between ${min} and ${max}`);
  return n;
}

function parseArgs(argv) {
  const args = { scenario: null, init: 'stale', schedules: DEFAULT_SCHEDULES, seed: null, ageAt: null, replay: null, json: false, out: null, runTimeoutMs: PER_RUN_MS };
  const takesValue = new Set(['--scenario', '--init', '--age-at', '--schedules', '--seed', '--replay', '--out', '--run-timeout-ms']);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help') return { help: true };
    if (flag === '--json') { args.json = true; continue; }
    if (!takesValue.has(flag)) throw new Error(`unknown flag '${flag}'`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag}: missing value`);
    switch (flag) {
      case '--scenario': args.scenario = value; break;
      case '--init': args.init = value; break;
      case '--age-at': args.ageAt = integer(value, flag); break;
      case '--schedules': args.schedules = integer(value, flag, { min: 1, max: MAX_SCHEDULES }); break;
      case '--seed': args.seed = integer(value, flag, { max: 0xffffffff }); break;
      case '--replay': args.replay = value; break;
      case '--out': args.out = value; break;
      case '--run-timeout-ms': args.runTimeoutMs = integer(value, flag, { min: 1 }); break;
      default: throw new Error(`unknown flag '${flag}'`);
    }
  }
  if (!args.scenario) throw new Error('missing required --scenario');
  if (!['S1', 'S2'].includes(args.scenario)) throw new Error(`--scenario: expected S1 or S2, got '${args.scenario}'`);
  if (!['none', 'stale'].includes(args.init)) throw new Error(`--init: expected none or stale, got '${args.init}'`);
  if (args.replay !== null) {
    try { parseTrace(args.replay); } catch (error) { throw new Error(`--replay: ${error.message}`); }
  }
  if (args.seed === null) args.seed = Date.now() >>> 0;
  // An explicit --age-at takes precedence over an age-lock marker embedded in a --replay trace.
  return args;
}

/** mulberry32, inlined from the repository's lifecycle derivation reference. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chooserFor(seed, scheduleIndex) {
  const scheduleSeed = (seed + Math.imul(scheduleIndex + 1, 0x9e3779b9)) >>> 0;
  const random = mulberry32(scheduleSeed);
  return (parkedNames) => parkedNames[Math.floor(random() * parkedNames.length)];
}

function loadSamplingOracle() {
  const modulePath = process.env.DOFLOW_SAMPLER_ORACLE;
  if (!modulePath) return realOracle;
  const oracle = require(path.resolve(modulePath));
  if (!oracle || typeof oracle.check !== 'function') throw new Error('DOFLOW_SAMPLER_ORACLE must export check(observation)');
  return oracle;
}

function commitOf(repo) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unknown'; }
}

function percentile95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10;
}

function summarize(observations, checks, base, timedOut) {
  const verdictCounts = { PASS: 0, VIOLATION: 0, INCOMPLETE: 0 };
  const violationCounts = Object.fromEntries(VIOLATION_CLASSES.map((name) => [name, 0]));
  const incompleteCauses = {};
  const traces = new Set();
  const shortestViolatingTraces = {};
  const times = [];
  let maxRssChildrenKb = null;
  for (let i = 0; i < observations.length; i += 1) {
    const observation = observations[i];
    const result = checks[i];
    verdictCounts[result.verdict] = (verdictCounts[result.verdict] || 0) + 1;
    traces.add(observation.trace);
    times.push(observation.ms);
    if (Number.isFinite(observation.maxRssKb)) maxRssChildrenKb = Math.max(maxRssChildrenKb || 0, observation.maxRssKb);
    if (result.verdict === 'INCOMPLETE') incompleteCauses[result.cause || observation.incomplete?.cause || 'unknown'] = (incompleteCauses[result.cause || observation.incomplete?.cause || 'unknown'] || 0) + 1;
    if (result.verdict === 'VIOLATION') {
      const cls = result.class || 'other-nonlinearizable';
      violationCounts[cls] = (violationCounts[cls] || 0) + 1;
      const previous = shortestViolatingTraces[cls];
      if (previous === undefined || observation.trace.length < previous.length || (observation.trace.length === previous.length && observation.trace < previous)) shortestViolatingTraces[cls] = observation.trace;
    }
  }
  const n = observations.length;
  // Detection power counts only completed schedules: an INCOMPLETE one could not have shown a violation.
  const completed = n - (verdictCounts.INCOMPLETE || 0);
  const detectionPower = VIOLATION_CLASSES.filter((name) => (violationCounts[name] || 0) === 0).flatMap((name) => [0.01, 0.05].map((p) => ({ class: name, p, schedulesCompleted: completed, upperBound: Math.pow(1 - p, completed) })));
  return {
    ...base,
    schedulesRun: n,
    distinctTraces: traces.size,
    // sha256 of the ordered schedule traces: the same seed and commit give the same digest.
    traceDigest: createHash('sha256').update(observations.map((o) => o.trace).join('\n')).digest('hex'),
    verdictCounts,
    violationCounts,
    incompleteCauses,
    shortestViolatingTraces,
    violations: checks.flatMap((result, i) => result.verdict === 'VIOLATION' ? [{
      class: result.class,
      trace: observations[i].trace,
      detail: result.detail,
      note: result.class === 'suspected-model-defect' ? 'needs reading against source' : null,
    }] : []),
    msPerSchedule: {
      mean: n ? Math.round(times.reduce((sum, value) => sum + value, 0) / n * 10) / 10 : null,
      p95: percentile95(times),
    },
    maxRssParentKb: process.resourceUsage().maxRSS,
    maxRssChildrenKb,
    rssUnit: 'KB',
    detectionPower,
    timedOut,
  };
}

function renderText(record, checks) {
  const lines = [
    `commit: ${record.commit}`,
    `node: ${record.nodeVersion}`,
    `platform: ${record.platform}`,
    `filesystem: ${record.fsNote}`,
    `scenario: ${record.scenario}`,
    `init: ${record.init}`,
    `fault: ${record.fault ? `${record.fault.kind}@${record.fault.at}` : 'none'}`,
    `seed: ${record.seed}`,
    `bounds: schedules=${record.bounds.schedules}, perScheduleMs=${record.bounds.perScheduleMs}, perRunMs=${record.bounds.perRunMs}`,
    `gated methods: ${record.gatedMethods.join(', ')}`,
    `oracle model: ${record.modelVersion}`,
    `schedules run: ${record.schedulesRun}`,
    `distinct traces: ${record.distinctTraces} (trace digest ${record.traceDigest})`,
    `verdict counts: ${JSON.stringify(record.verdictCounts)}`,
    `violation counts: ${JSON.stringify(record.violationCounts)}`,
    `INCOMPLETE causes: ${JSON.stringify(record.incompleteCauses)}`,
    `ms per schedule: mean=${record.msPerSchedule.mean}, p95=${record.msPerSchedule.p95}`,
    `max RSS: parent=${record.maxRssParentKb} KB, children=${record.maxRssChildrenKb ?? 'unknown'} KB`,
  ];
  for (const [cls, trace] of Object.entries(record.shortestViolatingTraces)) lines.push(`shortest ${cls} replay: ${trace}`);
  for (const item of record.detectionPower) lines.push(`P(miss | per-schedule rate >= ${item.p}) <= (1-${item.p})^${item.schedulesCompleted} = ${item.upperBound} [${item.class}]`);
  if (record.verdictCounts.VIOLATION) {
    lines.push('violations need replay and reading against source; suspected-model-defect needs reading against source.');
    for (const result of checks) if (result.verdict === 'VIOLATION') lines.push(`violation ${result.class}: ${result.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { usageError(error.message); return; }
  if (args.help) { process.stdout.write(`${USAGE}\n`); return; }

  const repo = path.resolve(__dirname, '../..');
  const source = path.join(repo, 'src/runtime/task-attempts.ts');
  const replay = args.replay;
  const total = replay === null ? args.schedules : 1;
  const runTimeoutMs = args.runTimeoutMs;
  const started = Date.now();
  const observations = [];
  const checks = [];
  let timedOut = false;
  if (!fs.existsSync(source)) {
    const base = identity(args, repo, total, runTimeoutMs, null);
    const record = summarize(observations, checks, base, false);
    emit(record, checks, args);
    process.exitCode = 3;
    return;
  }
  let samplingOracle;
  try { samplingOracle = loadSamplingOracle(); }
  catch (error) { usageError(error.message); return; }

  for (let i = 0; i < total; i += 1) {
    const remaining = runTimeoutMs - (Date.now() - started);
    if (remaining <= 0) { timedOut = true; break; }
    const fault = args.ageAt === null ? undefined : { kind: 'age-lock', at: args.ageAt };
    const options = {
      repo,
      scenario: args.scenario,
      init: args.init,
      deadlineMs: Math.max(1, Math.min(PER_SCHEDULE_MS, remaining)),
    };
    if (replay !== null) options.replay = replay;
    else options.chooser = chooserFor(args.seed, i);
    if (fault !== undefined) options.fault = fault;
    let observation;
    try { observation = await runSchedule(options); }
    catch (error) {
      process.stderr.write(`sampler failed: ${error.stack || error}\n`);
      process.exitCode = 3;
      return;
    }
    observations.push(observation);
    let result;
    if (replay !== null) {
      // Replay results are always decided by the shipped oracle, regardless of the sampling seam.
      result = realOracle.check(observation);
    } else {
      const sampled = samplingOracle.check(observation);
      result = sampled.verdict === 'VIOLATION' ? realOracle.check(observation) : sampled;
    }
    checks.push(result);
    if (Date.now() - started >= runTimeoutMs) { timedOut = true; break; }
    if (replay !== null) break;
  }

  let fault = null;
  if (args.ageAt !== null) fault = { kind: 'age-lock', at: args.ageAt };
  else if (replay !== null) fault = parseTrace(replay).fault;
  const base = identity(args, repo, total, runTimeoutMs, fault);
  const record = summarize(observations, checks, base, timedOut);
  emit(record, checks, args);
  const incomplete = record.verdictCounts.INCOMPLETE || 0;
  const killed = timedOut || observations.some((o) => o.incomplete?.cause === 'schedule-deadline');
  if (killed || incomplete > 0.05 * record.schedulesRun || !fs.existsSync(source)) process.exitCode = 3;
  else if (record.verdictCounts.VIOLATION) process.exitCode = 1;
  else process.exitCode = 0;
}

function identity(args, repo, scheduleCount, runTimeoutMs, fault) {
  return {
    commit: commitOf(repo),
    nodeVersion: process.version,
    platform: `${process.platform}/${os.arch()}`,
    fsNote: FS_NOTE,
    scenario: args.scenario,
    init: args.init,
    fault,
    seed: args.seed,
    bounds: { schedules: scheduleCount, perScheduleMs: PER_SCHEDULE_MS, perRunMs: runTimeoutMs },
    gatedMethods: [...GATED_METHODS].sort(),
    modelVersion: realOracle.MODEL_VERSION,
  };
}

function emit(record, checks, args) {
  const output = args.json ? `${JSON.stringify(record)}\n` : renderText(record, checks);
  if (args.out) {
    try { fs.writeFileSync(path.resolve(args.out), output); }
    catch (error) { process.stderr.write(`cannot write --out '${args.out}': ${error.message}\n`); process.exitCode = 3; }
  }
  process.stdout.write(output);
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`sampler failed: ${error.stack || error}\n`);
  process.exitCode = 3;
});

module.exports = { mulberry32, chooserFor, parseArgs, renderText };
