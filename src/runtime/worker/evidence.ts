'use strict';

// Worker evidence records (IC-005, IC-006). CLI checks are declared by a reviewable checks file;
// live-run evidence copies only the bounded, non-content fields from an ended worker record.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readiness = require('./readiness.ts');
const { PROBE_STDOUT_MAX } = readiness;
const { WORKER_CAPABILITIES, WORKER_OPTIONAL_CAPABILITIES } = require('../../registry/index.ts');
const { maskBody } = require('../mask.ts');
const { resultOfRun } = require('./supervisor.ts');

const CHECKS_SCHEMA = 'doflow-worker-checks-v1';
const EVIDENCE_SCHEMA = 'doflow-worker-evidence-v1';
const MAX_ARGV = 32;
const MAX_ARG_CHARS = 200;
const MAX_MATCHED_LINES = 20;
const MATCHED_LINE_CHARS = 200;

class WorkerEvidenceError extends Error {
  declare code: string;
  declare reason: string;
  constructor(code: string, reason: string, message: string) {
    super(message);
    this.name = 'WorkerEvidenceError';
    this.code = code;
    this.reason = reason;
  }
}

function usage(reason: string, message: string): never {
  throw new WorkerEvidenceError('usage', reason, message);
}

function refuse(reason: string): never {
  throw new WorkerEvidenceError('refused', reason, reason);
}

function argvProblem(argv: any): string | null {
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) return 'argv must be an array of strings';
  if (argv.length > MAX_ARGV) return `argv must have at most ${MAX_ARGV} elements`;
  if (argv.some((item) => item.length > MAX_ARG_CHARS)) return `argv elements must be at most ${MAX_ARG_CHARS} characters`;
  if (argv.some((item) => item.includes('\0'))) return 'argv elements must not contain NUL';
  return null;
}

/** FR-006 / NFR-001: a check may only ask for the version, for help, or for the feature list; never a model session. */
function freeArgv(argv: string[]): boolean {
  if (argv.length === 1 && argv[0] === '--version') return true;
  if (argv.includes('--help') || argv.includes('-h')) return true;
  return argv[0] === 'features' && argv[1] === 'list';
}

function expression(value: any, where: string): RegExp {
  if (typeof value !== 'string' || value === '') usage('checks-invalid', `${where} must be a non-empty regular expression`);
  try { return new RegExp(value); } catch (error: any) {
    usage('checks-invalid', `${where} is not a valid regular expression: ${error?.message || String(error)}`);
  }
}

function validateChecks(data: any, harness: string, worker: any) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) usage('checks-invalid', 'checks file must be a JSON object');
  if (data.schema !== CHECKS_SCHEMA) usage('checks-invalid', `checks file schema must be '${CHECKS_SCHEMA}'`);
  if (data.harness !== harness) usage('checks-invalid', `checks file harness '${data.harness}' does not match '${harness}'`);
  if (!worker?.cli || worker.cli.status !== 'supported' || typeof worker.cli.binary !== 'string') {
    usage('checks-invalid', `harness '${harness}' does not declare a supported CLI binary`);
  }
  if (data.binary !== worker.cli.binary) usage('checks-invalid', `checks file binary '${data.binary}' does not match harness '${harness}' binary '${worker.cli.binary}'`);
  if (!data.version || typeof data.version !== 'object' || Array.isArray(data.version)) usage('checks-invalid', 'checks file needs a version check');
  const versionArgvProblem = argvProblem(data.version.argv);
  if (versionArgvProblem) usage('checks-invalid', `version.argv ${versionArgvProblem}`);
  if (!freeArgv(data.version.argv)) usage('checks-invalid', `version.argv is not a free check (only --version, --help/-h or 'features list' may run)`);
  expression(data.version.expect, 'version.expect');
  if (!Array.isArray(data.checks) || data.checks.length === 0) usage('checks-invalid', 'checks file needs at least one check');

  const capabilities = new Set([
    ...Object.keys(WORKER_CAPABILITIES),
    ...Object.keys(WORKER_OPTIONAL_CAPABILITIES),
  ]);
  capabilities.delete('cli');
  for (const [index, check] of data.checks.entries()) {
    const where = `checks[${index}]`;
    if (!check || typeof check !== 'object' || Array.isArray(check)) usage('checks-invalid', `${where} must be an object`);
    if (typeof check.id !== 'string' || check.id === '') usage('checks-invalid', `${where}.id must be a non-empty string`);
    const problem = argvProblem(check.argv);
    if (problem) usage('checks-invalid', `${where}.argv ${problem}`);
    if (!freeArgv(check.argv)) {
      usage('checks-invalid', `check '${check.id}' (${where}) is not a free check: its argv must be --version, contain --help or -h, or start with 'features list'`);
    }
    if (!Array.isArray(check.expect) || check.expect.length === 0) usage('checks-invalid', `${where}.expect must be a non-empty array`);
    check.expect.forEach((pattern: any, expectIndex: number) => expression(pattern, `${where}.expect[${expectIndex}]`));
    if (!Array.isArray(check.establishes) || check.establishes.length === 0
      || check.establishes.some((key: any) => typeof key !== 'string' || !capabilities.has(key))) {
      usage('checks-invalid', `${where}.establishes must name worker capabilities other than 'cli'`);
    }
  }
  return data;
}

function readChecks(file: string, fsImpl: any) {
  let data: any;
  try {
    if (!fsImpl.statSync(file).isFile()) usage('checks-invalid', `checks file '${file}' is not a regular file`);
    data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (error: any) {
    if (error instanceof WorkerEvidenceError) throw error;
    usage('checks-invalid', `checks file '${file}' cannot be read: ${error?.code || error?.message || String(error)}`);
  }
  return data;
}

function lines(stdout: any): string[] {
  const value: string = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? '');
  return value.split('\n').map((line: string) => line.replace(/\r$/, ''));
}

function runBounded(binary: string, argv: string[], { env, cwd, spawnSyncImpl }: any) {
  try {
    return spawnSyncImpl(binary, argv, {
      env,
      cwd,
      shell: false,
      timeout: readiness.PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_STDOUT_MAX,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch (error: any) {
    return { status: null, stdout: Buffer.alloc(0), error };
  }
}

function matchedLines(outputLines: string[], patterns: RegExp[]): string[] {
  const matches: string[] = [];
  for (const line of outputLines) {
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    const safe = maskBody(line).text.slice(0, MATCHED_LINE_CHARS);
    matches.push(safe);
    if (matches.length >= MAX_MATCHED_LINES) break;
  }
  return matches;
}

function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);
    return out;
  }
  return value;
}

function outPathAndCheck(out: string, cwd: string, fsImpl: any): string {
  if (typeof out !== 'string' || out === '') usage('out-required', '--out is required');
  const target = path.resolve(cwd, out);
  try {
    if (fsImpl.existsSync(target)) usage('out-exists', `--out '${target}' already exists`);
  } catch (error: any) {
    if (error instanceof WorkerEvidenceError) throw error;
    usage('out-unavailable', `--out '${target}' cannot be checked: ${error?.message || String(error)}`);
  }
  return target;
}

function writeRecord(record: any, target: string, fsImpl: any) {
  try {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.writeFileSync(target, `${JSON.stringify(sorted(record), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error: any) {
    if (error?.code === 'EEXIST') usage('out-exists', `--out '${target}' already exists`);
    usage('out-write-failed', `evidence file '${target}' could not be written: ${error?.code || error?.message || String(error)}`);
  }
  return { disposition: 'recorded', path: target, establishes: record.establishes };
}

function dateValue(now: any): string {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) usage('clock-invalid', 'recordedAt clock is invalid');
  return date.toISOString();
}

/** Runs a declared free-check file against the named harness binary and writes an IC-005 record. */
function recordCliChecks({ checksFile, harness, worker, out, cwd = process.cwd(), env = process.env,
  now = () => new Date(), platform = process.platform, fsImpl = fs, spawnSyncImpl = spawnSync }: any = {}) {
  const target = outPathAndCheck(out, cwd, fsImpl);
  const checks = validateChecks(readChecks(path.resolve(cwd, String(checksFile)), fsImpl), harness, worker);
  const binaryPath = readiness.findOnPath(checks.binary, env, platform);
  if (!binaryPath) refuse('version-unmatched');

  const versionExpect = expression(checks.version.expect, 'version.expect');
  const versionResult = runBounded(binaryPath, checks.version.argv, { env, cwd, spawnSyncImpl });
  const versionLines = lines(versionResult.stdout);
  const versionMatch = versionLines.find((line) => versionExpect.test(line));
  if (versionResult.status !== 0 || !versionMatch) refuse('version-unmatched');

  const cliVersion = maskBody(versionMatch).text.slice(0, MATCHED_LINE_CHARS);
  const recordedChecks = checks.checks.map((check: any) => {
    const patterns = check.expect.map((pattern: string, index: number) => expression(pattern, `check '${check.id}' expect[${index}]`));
    const result = runBounded(binaryPath, check.argv, { env, cwd, spawnSyncImpl });
    const outputLines = lines(result.stdout);
    const allExpectationsMatched = patterns.every((pattern: RegExp) => outputLines.some((line) => pattern.test(line)));
    return {
      id: check.id,
      argv: [...check.argv],
      exit: Number.isInteger(result.status) ? result.status : null,
      expect: [...check.expect],
      matched: matchedLines(outputLines, patterns),
      result: result.status === 0 && allExpectationsMatched ? 'pass' : 'fail',
      establishes: [...check.establishes],
    };
  });
  const establishes = [...new Set(recordedChecks
    .filter((check: any) => check.result === 'pass')
    .flatMap((check: any) => check.establishes))].sort();
  const record = {
    schema: EVIDENCE_SCHEMA,
    harness,
    kind: 'cli-check',
    recordedAt: dateValue(now),
    binary: checks.binary,
    cliVersion,
    establishes,
    checks: recordedChecks,
    run: null,
  };
  return writeRecord(record, target, fsImpl);
}

/** Records an ended run without retaining prompt, environment, output or summary contents. */
function recordLiveRun({ run, harness, worker, out, cwd = process.cwd(), now = () => new Date(), fsImpl = fs }: any = {}) {
  const target = outPathAndCheck(out, cwd, fsImpl);
  if (!run) refuse('unknown-run');
  if (run.phase !== 'ended') refuse('run-not-ended');
  if (run.harness !== harness) refuse('harness-mismatch');
  const stdoutBytes = Number(run.output?.stdout?.bytes);
  if (!Number.isFinite(stdoutBytes) || stdoutBytes <= 0) refuse('no-output');
  if (!run.report || !['success', 'failure', 'denied'].includes(run.report.status)) refuse('no-terminal-event');

  const { resultOffered, withheld } = resultOfRun(run);
  const edit = Boolean(run.edit);
  const establishes = resultOffered
    ? ['oneShot', 'structuredOutput', 'spawnDenial', edit ? 'isolatedEdit' : 'readOnly']
    : [];
  const record = {
    schema: EVIDENCE_SCHEMA,
    harness,
    kind: 'live-run',
    recordedAt: dateValue(now),
    binary: run.recipe?.binary ?? run.descriptor?.cli?.binary ?? worker?.cli?.binary ?? null,
    cliVersion: typeof run.cliVersion === 'string' ? run.cliVersion : '',
    establishes,
    checks: [],
    run: {
      runId: run.runId,
      edit,
      argvShape: run.recipe?.argvShape ?? [],
      parser: run.recipe?.parser ?? run.report?.parser ?? null,
      report: {
        status: run.report.status,
        reason: run.report.reason ?? null,
        deniedCount: run.report.deniedCount ?? 0,
        usage: run.report.usage ?? null,
      },
      isolation: edit ? run.isolation ?? null : null,
      readOnly: edit ? null : run.readOnly ?? null,
      resultOffered,
      withheld,
      stdoutBytes,
      exit: Number.isInteger(run.process?.code) ? run.process.code : null,
    },
  };
  return writeRecord(record, target, fsImpl);
}

module.exports = { recordCliChecks, recordLiveRun, WorkerEvidenceError, CHECKS_SCHEMA, EVIDENCE_SCHEMA };
