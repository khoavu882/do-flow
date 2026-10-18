'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Deterministic check execution — the JavaScript port of
 * `core/shared/scripts/doflow/verification/contract_runner.py` (plan task B.3, component C7).
 *
 * Runs an ordered list of shell checks, cheapest and most deterministic first
 * (syntax → compile → types → lint → unit → integration → architecture → scope), and compiles a
 * report. Ported from observed behaviour (plan decision D3): the check record shape, the PASS/FAIL
 * vocabulary, the 2,000-character output cap, exit code 124 for a timeout and the short-circuit on
 * a failing syntax/compile/build check are all reproduced exactly.
 *
 * Three defects are fixed rather than reproduced, each explained at its site:
 *   1. A check entry with no `command` silently ran `true` and reported PASS — a malformed
 *      contract produced a green check that verified nothing.
 *   2. A timed-out check threw away the output captured before the kill, which is the only
 *      diagnostic a hung check ever produces.
 *   3. A contract with no checks reported `status: "PASS"` — a verification verdict asserted over
 *      zero evidence.
 *
 * `verification.js`'s `VerificationEngine` (plan task C.2, design C7) is the registry-driven layer
 * built on top of this runner — it owns tier selection, risk scaling and recovery, and calls
 * `runCheck` for every check a resolved tier produces.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { telemetryOff } = require('../trace/telemetry.ts');
const { checkKey, headCommit, treeDigest } = require('./check-key.ts');

/** A failing check whose name contains one of these aborts the remaining checks: once the build is
 * broken, every later result describes the broken build rather than the change. */
const FATAL_CHECK_MARKERS = Object.freeze(['syntax', 'compile', 'build']);

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_STREAM_CHARS = 2000;
/** Enough head to catch a startup error; the rest of the budget goes to the tail. */
const HEAD_KEEP_CHARS = 400;

/** The exit code a shell reports for a command killed by a timeout; kept so callers that already
 * special-case 124 from the Python keep working. */
const TIMEOUT_EXIT_CODE = 124;

/**
 * @param {*} value
 * @returns {string}
 */
function truncate(value: any): string {
  if (typeof value !== 'string') return '';
  if (value.length <= MAX_STREAM_CHARS) return value;
  // Keep the TAIL, not the head, and say so.
  //
  // Every runner worth verifying streams progress first and summarises last: `node --test` puts
  // the failure diagnostics and the `# fail N` line at the end, as do pytest, jest and `go test`.
  // Slicing from the front therefore kept ~10 passing subtests out of 572 and discarded the only
  // part of the stream that shows a failure — a verification report that structurally could not
  // report one. A little head is retained because a hard startup error (missing binary, bad
  // config) appears there and nowhere else.
  const head = value.slice(0, HEAD_KEEP_CHARS);
  const tail = value.slice(-(MAX_STREAM_CHARS - HEAD_KEEP_CHARS));
  const dropped = value.length - head.length - tail.length;
  return `${head}\n… [${dropped} characters elided by the verification report] …\n${tail}`;
}

/** Cap on extracted failing-test identifiers — a bounded diagnostic, not a second log. */
const MAX_FAILED_TESTS = 50;

/** `not ok` lines in TAP output (node --test, pytest-tap, prove …): the failing test identifiers.
 * Directive lines (`# SKIP`, `# TODO`) are not failures and are excluded. */
const TAP_NOT_OK = /^\s*not ok\b(?:\s+\d+)?(?:\s*-\s*)?(.*)$/gm;

/**
 * Pulls failing test identifiers out of the FULL output, before any truncation — the middle of a
 * TAP stream is exactly what the 2,000-character excerpt drops (review A2: a separate raw-log run
 * was needed to recover which tests failed).
 * @param {string} text
 * @returns {Array<string>} unique identifiers, bounded by MAX_FAILED_TESTS
 */
function extractFailedTests(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(TAP_NOT_OK)) {
    const name = match[1].trim();
    if (name === '' || /#\s*(?:SKIP|TODO)\b/i.test(name)) continue;
    seen.add(name);
    if (seen.size >= MAX_FAILED_TESTS) break;
  }
  return [...seen];
}

/** The monotonic clock in nanoseconds, or null when it cannot be read. */
function monotonicNs(): bigint | null {
  try {
    return process.hrtime.bigint();
  } catch {
    return null;
  }
}

/**
 * Test output counts parser (088 E.2, IC-007).
 * Parses full stdout+stderr for TAP (# tests N / # fail N) or spec (ℹ tests N / ℹ fail N).
 * Pytest and unparseable outputs return { tests: null, testsFailed: null }.
 * @param {unknown} text
 * @returns {{ tests: number | null, testsFailed: number | null }}
 */
function parseTestCounts(text: unknown): { tests: number | null; testsFailed: number | null } {
  if (typeof text !== 'string') return { tests: null, testsFailed: null };
  const tapTests = text.match(/^# tests (\d+)/m);
  if (tapTests) {
    const tapFail = text.match(/^# fail (\d+)/m);
    return {
      tests: parseInt(tapTests[1], 10),
      testsFailed: tapFail ? parseInt(tapFail[1], 10) : 0,
    };
  }
  const specTests = text.match(/^ℹ tests (\d+)/m);
  if (specTests) {
    const specFail = text.match(/^ℹ fail (\d+)/m);
    return {
      tests: parseInt(specTests[1], 10),
      testsFailed: specFail ? parseInt(specFail[1], 10) : 0,
    };
  }
  return { tests: null, testsFailed: null };
}

/**
 * Reads child cpu ticks from /proc/self/stat on Linux (088 E.2, IC-008).
 * Returns cutime + cstime as a number, or null on non-Linux or read fault.
 * @param {Object} [fsImpl=fs]
 * @param {string} [platform=process.platform]
 * @returns {number | null}
 */
function childCpuTicks(fsImpl: any = fs, platform: string = process.platform): number | null {
  if (platform !== 'linux') return null;
  try {
    const statText = fsImpl.readFileSync('/proc/self/stat', 'utf8');
    const lastParen = statText.lastIndexOf(')');
    if (lastParen === -1) return null;
    const rest = statText.slice(lastParen + 1).trim();
    const tokens = rest.split(/\s+/);
    // After the last ')', field 3 (state) is index 0.
    // field 16 (cutime) is index 13, field 17 (cstime) is index 14.
    const cutime = parseInt(tokens[13], 10);
    const cstime = parseInt(tokens[14], 10);
    if (!Number.isFinite(cutime) || !Number.isFinite(cstime)) return null;
    return cutime + cstime;
  } catch {
    return null;
  }
}

/**
 * Test output failing files parser (088 G.3, IC-007).
 * Extracts sorted unique repo-relative test file paths from TAP, spec, or pytest output.
 * Drops non-test files, non-regular files (directories), files outside root, or parse faults.
 * @param {unknown} text
 * @param {Object} options
 * @param {string} options.root project root
 * @param {Object} options.convention convention object with isTest(path)
 * @param {Object} [options.fsImpl=fs]
 * @returns {Array<string>} sorted unique repo-relative paths
 */
function extractFailedFiles(
  text: unknown,
  {
    root,
    convention,
    fsImpl = fs,
  }: {
    root?: string;
    convention?: { isTest?: (file: string) => boolean };
    fsImpl?: any;
  } = {},
): string[] {
  if (typeof text !== 'string' || !root || !convention || typeof convention.isTest !== 'function') {
    return [];
  }

  let realRoot: string;
  try {
    realRoot = fsImpl.realpathSync(root);
  } catch {
    realRoot = path.resolve(root);
  }

  const rawPaths = new Set<string>();

  // 1. TAP: in a YAML block that follows a `not ok` line, ^\s*location:\s*'(.+):\d+:\d+'\s*$ (absolute, made relative to realpath(root))
  const lines = text.split('\n');
  let inNotOk = false;
  let inYaml = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*not ok\b/.test(line)) {
      inNotOk = true;
      inYaml = false;
    } else if (/^\s*ok\b/.test(line)) {
      inNotOk = false;
      inYaml = false;
    } else if (inNotOk && /^\s*---\s*$/.test(line)) {
      inYaml = true;
    } else if (inYaml && /^\s*\.\.\.\s*$/.test(line)) {
      inYaml = false;
      inNotOk = false;
    } else if (inNotOk && inYaml) {
      const match = line.match(/^\s*location:\s*['"]?(.+?):\d+:\d+['"]?\s*$/);
      if (match) {
        rawPaths.add(match[1]);
      }
    }
  }

  // 2. Spec: after the `✖ failing tests:` line, ^\s*test at (.+):\d+:\d+\s*$ (relative to root)
  let afterFailingTests = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/✖ failing tests:/.test(line)) {
      afterFailingTests = true;
      continue;
    }
    if (afterFailingTests) {
      const match = line.match(/^\s*test at (.+?):\d+:\d+\s*$/);
      if (match) {
        rawPaths.add(match[1]);
      }
    }
  }

  // 3. Pytest: ^FAILED (\S+?)::
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^FAILED (\S+?)::/);
    if (match) {
      rawPaths.add(match[1]);
    }
  }

  const validFiles = new Set<string>();

  for (const raw of rawPaths) {
    let relPath: string;
    if (path.isAbsolute(raw)) {
      relPath = path.relative(realRoot, raw);
    } else {
      relPath = path.normalize(raw);
    }
    if (path.isAbsolute(relPath) || relPath.startsWith('..')) {
      continue;
    }
    const normalized = relPath.replace(/\\/g, '/');
    const fullPath = path.join(realRoot, normalized);

    let st: any;
    try {
      st = fsImpl.statSync(fullPath);
    } catch {
      continue;
    }
    if (!st || !st.isFile() || st.isDirectory()) {
      continue;
    }
    if (!convention.isTest(normalized)) {
      continue;
    }
    validFiles.add(normalized);
  }

  return [...validFiles].sort();
}

class VerificationContractRunner {
  cwd: string;
  defaultTimeoutMs: number;
  exec: any;
  fsImpl: any;
  logDir: string;
  logWriteWarned?: boolean;
  platform: string;
  env: Record<string, string | undefined>;
  convention?: any;
  _treeContext?: { head: string | null; tree: string | null };
  /** Check result → `{ startedAt, durationMs, tests, testsFailed, cpuMs, resourceBasis, checkKey, shared, failedFirst }`
   * for every executed check; an in-run duplicate and a check with no command have no entry. */
  metrics: WeakMap<object, any>;

  /**
   * @param {Object|string} [options] a string is accepted for parity with the Python's positional
   *   `cwd` argument
   * @param {string} [options.cwd] directory the checks run in; defaults to the current one
   * @param {number} [options.defaultTimeoutMs=60000]
   * @param {Function} [options.exec] injection seam for tests; same contract as `spawnSync`
   * @param {string} [options.logDir] where full check logs go; the verify verb passes its resolved
   *   store's (engine.ts `verifyStateRoot`), so `<cwd>/.doflow` is only the unconfigured default
   * @param {string} [options.platform=process.platform]
   * @param {Object} [options.env=process.env]
   */
  constructor(options: any = {}) {
    const opts = typeof options === 'string' ? { cwd: options } : options;
    this.cwd = opts.cwd || process.cwd();
    this.defaultTimeoutMs = opts.defaultTimeoutMs || DEFAULT_TIMEOUT_MS;
    this.exec = opts.exec || spawnSync;
    this.fsImpl = opts.fsImpl || fs;
    this.logDir = opts.logDir || path.join(this.cwd, '.doflow', 'state', 'verification', 'logs');
    this.platform = opts.platform || process.platform;
    this.env = opts.env || process.env;
    this.convention = opts.convention || null;
    this._treeContext = undefined;
    this.metrics = new WeakMap();
  }

  /**
   * Persists one check's full output beside the state the run already keeps, so the 2,000-character
   * excerpt is a pointer into a complete record rather than the only record (review A2: the
   * truncation kept the failure count but dropped the failing test names from mid-stream, and
   * recovering them took a second full run of the same command).
   * @param {string} name
   * @param {string} command
   * @param {string} stdout
   * @param {string} stderr
   * @returns {string|null} the log path, or null when the log could not be written
   */
  persistLog(name: string, command: string, stdout: string, stderr: string): string | null {
    try {
      this.fsImpl.mkdirSync(this.logDir, { recursive: true });
      const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_');
      const file = path.join(this.logDir, `${Date.now()}-${safe}.log`);
      this.fsImpl.writeFileSync(file,
        `# check: ${name}\n# command: ${command}\n--- stdout ---\n${stdout || ''}\n--- stderr ---\n${stderr || ''}\n`,
        'utf8');
      return file;
    } catch (error: any) {
      // An unwritable log directory must not turn a completed check into an error — the check's
      // verdict stands; only the pointer is missing, and its null says so. But a chronic
      // permissions problem should not be invisible either: say so once per runner, on stderr so
      // a caller capturing stdout never absorbs it as data (review suggestion, 026).
      if (!this.logWriteWarned) {
        this.logWriteWarned = true;
        process.stderr.write(`doflow verification: could not persist check log under '${this.logDir}' (${error.message}); verdicts are unaffected, logPath will be null\n`);
      }
      return null;
    }
  }

  /**
   * Adds the A2 diagnostics to a completed check record, from the FULL streams: failing test
   * identifiers (extracted before truncation) and, for a failure or a truncated stream, the path
   * of the persisted full log.
   * @param {Object} result mutated in place
   * @param {string} command
   * @param {string} [stdout]
   * @param {string} [stderr]
   */
  decorate(result: any, command: string, stdout?: string, stderr?: string): void {
    const full = `${stdout || ''}\n${stderr || ''}`;
    if (result.status === 'FAIL') {
      const failedTests = extractFailedTests(full);
      if (failedTests.length > 0) result.failedTests = failedTests;
      if (this.convention) {
        const failedFiles = extractFailedFiles(full, {
          root: this.cwd,
          convention: this.convention,
          fsImpl: this.fsImpl,
        });
        if (failedFiles.length > 0) result.failedFiles = failedFiles;
      }
    }
    const truncated = (stdout || '').length > MAX_STREAM_CHARS || (stderr || '').length > MAX_STREAM_CHARS;
    if ((result.status === 'FAIL' || truncated) && full.trim() !== '') {
      result.logPath = this.persistLog(result.name, command, stdout as string, stderr as string);
    }
  }

  /**
   * Executes a single deterministic shell check.
   * @param {string} name
   * @param {string} command
   * @param {number} [timeoutMs]
   * @param {Map} [dedupeCache] scoped to ONE contract evaluation: a second check declaring the
   *   same command and timeout reuses the first result instead of re-running it (review A2: the
   *   contract ran the same `npm test` twice after the first failure). Never held across
   *   evaluations — a recovery retry must observe live behaviour, so each pass passes a fresh map.
   * @returns {Object} check result
   */
  runCheck(name: string, command: any, timeoutMs: number = this.defaultTimeoutMs, dedupeCache: Map<string, any> | null = null): any {
    const checkName = name || 'unnamed_check';

    // Defect fix (1): the Python defaulted a missing command to `true`, so a typo in a contract
    // entry produced a check that always passed. A check that cannot be run has not passed.
    if (typeof command !== 'string' || command.trim() === '') {
      return {
        name: checkName,
        command: null,
        status: 'FAIL',
        exitCode: 1,
        error: `Check '${checkName}' declares no command`,
      };
    }

    const dedupeKey = `${timeoutMs}\0${command}`;
    if (dedupeCache && dedupeCache.has(dedupeKey)) {
      return { ...dedupeCache.get(dedupeKey), name: checkName, deduplicated: true };
    }
    // Timing for telemetry (088 C.1, IC-006; 088 E.2, IC-007..IC-009) lives in `this.metrics`,
    // never in the result, so the report is the same with telemetry on or off.
    const startedAt = Date.now();
    const t0 = monotonicNs();
    const t0Cpu = childCpuTicks(this.fsImpl, this.platform);
    let checkKeyVal: string | null = null;
    try {
      if (!telemetryOff(this.env)) {
        if (this._treeContext === undefined) {
          const head = headCommit(this.cwd);
          const tree = treeDigest(this.cwd, { fsImpl: this.fsImpl });
          this._treeContext = { head, tree };
        }
        checkKeyVal = checkKey({
          command,
          timeoutMs,
          cwd: this.cwd,
          head: this._treeContext.head,
          tree: this._treeContext.tree,
          env: this.env,
          fsImpl: this.fsImpl,
        });
      }
    } catch {
      checkKeyVal = null;
    }

    let timing: any = null;
    const remember = (result: any) => {
      if (timing) this.metrics.set(result, timing);
      if (dedupeCache) dedupeCache.set(dedupeKey, result);
      return result;
    };
    const stop = (res?: any) => {
      const t1 = monotonicNs();
      const t1Cpu = childCpuTicks(this.fsImpl, this.platform);
      let cpuMs: number | null = null;
      let resourceBasis: string | null = null;
      if (this.platform !== 'linux') {
        cpuMs = null;
        resourceBasis = 'unreached-platform';
      } else if (t0Cpu === null || t1Cpu === null) {
        cpuMs = null;
        resourceBasis = 'unreached-read';
      } else {
        cpuMs = Math.max(0, (t1Cpu - t0Cpu) * 10);
        resourceBasis = 'proc-children';
      }
      const full = `${res ? res.stdout || '' : ''}\n${res ? res.stderr || '' : ''}`;
      const { tests, testsFailed } = parseTestCounts(full);
      timing = {
        startedAt,
        durationMs: t0 !== null && t1 !== null ? Number(t1 - t0) / 1e6 : null,
        tests,
        testsFailed,
        cpuMs,
        resourceBasis,
        checkKey: checkKeyVal,
        shared: 'none',
        failedFirst: 'none',
      };
    };

    let res: any;
    try {
      res = this.exec(command, {
        shell: true,
        cwd: this.cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        // The Python buffered without limit and truncated afterwards. Node's 1 MB default would
        // kill a chatty-but-passing check and report it as a failure, so raise the ceiling well
        // past anything a check legitimately prints. Only the first 2,000 chars are ever kept.
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error: any) {
      stop();
      // Mirrors the Python's bare `except Exception` arm: an unspawnable command is a FAIL, not a
      // thrown error that aborts the whole contract.
      return remember({
        name: checkName,
        command,
        status: 'FAIL',
        exitCode: 1,
        error: error.message,
      });
    }
    stop(res);

    // Defect fix (2): the Python's TimeoutExpired arm returned neither stdout nor stderr, so a
    // check that hung after printing its first failure told you only that it hung. Whatever the
    // process produced before the kill is exactly what a reader needs.
    if (res.error && res.error.code === 'ETIMEDOUT') {
      const result = {
        name: checkName,
        command,
        status: 'FAIL',
        exitCode: TIMEOUT_EXIT_CODE,
        error: 'TimeoutExpired',
        stdout: truncate(res.stdout),
        stderr: truncate(res.stderr),
      };
      this.decorate(result, command, res.stdout, res.stderr);
      return remember(result);
    }

    if (res.error) {
      const result = {
        name: checkName,
        command,
        status: 'FAIL',
        exitCode: 1,
        error: res.error.message,
        stdout: truncate(res.stdout),
        stderr: truncate(res.stderr),
      };
      this.decorate(result, command, res.stdout, res.stderr);
      return remember(result);
    }

    // A process killed by a signal reports `status: null`. Python surfaced this as a negative
    // return code; either way it is a non-zero outcome, so record the signal rather than let a
    // null exit code read as success.
    const exitCode = res.status === null || res.status === undefined ? 1 : res.status;
    const passed = res.status === 0;

    const result: any = {
      name: checkName,
      command,
      status: passed ? 'PASS' : 'FAIL',
      exitCode,
      stdout: truncate(res.stdout),
      stderr: truncate(res.stderr),
    };
    if (res.signal) {
      result.error = `Terminated by signal ${res.signal}`;
    }
    this.decorate(result, command, res.stdout, res.stderr);
    return remember(result);
  }

  /**
   * Runs ordered checks and compiles a VerificationReport.
   * @param {Array<{name?: string, command?: string, timeoutMs?: number}>} checks
   * @returns {{ status: string, checks: Array<Object>, failedChecks: Array<string>, timestamp: string, reason?: string }}
   */
  evaluateContract(checks: any[]): any {
    if (!Array.isArray(checks)) {
      throw new Error('evaluateContract expects an array of checks');
    }

    // Defect fix (3): an empty contract reported PASS, which is a verdict over no evidence — the
    // single failure mode a verification gate exists to prevent, and the same fail-closed reasoning
    // `readiness.ts` already applies to a requirement with no evaluator. It is not FAIL either,
    // since nothing failed; the caller (task C.2 owns tier selection) decides what an empty
    // contract means for its risk level.
    if (checks.length === 0) {
      return {
        status: 'INCONCLUSIVE',
        checks: [],
        failedChecks: [],
        reason: 'Contract declared no checks; nothing was verified',
        timestamp: new Date().toISOString(),
      };
    }

    const results: any[] = [];
    const failedChecks: string[] = [];
    let overallStatus = 'PASS';
    const dedupeCache = new Map<string, any>(); // one evaluation, one cache — a retry pass starts fresh

    for (const chk of checks) {
      const name = (chk && chk.name) || 'unnamed_check';
      const res = this.runCheck(name, chk && chk.command, chk && chk.timeoutMs, dedupeCache);
      results.push(res);

      if (res.status === 'FAIL') {
        overallStatus = 'FAIL';
        failedChecks.push(name);
        if (FATAL_CHECK_MARKERS.some((marker) => name.toLowerCase().includes(marker))) {
          break;
        }
      }
    }

    return {
      status: overallStatus,
      checks: results,
      failedChecks,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = {
  VerificationContractRunner,
  FATAL_CHECK_MARKERS,
  TIMEOUT_EXIT_CODE,
  MAX_STREAM_CHARS,
  MAX_FAILED_TESTS,
  extractFailedTests,
  extractFailedFiles,
  parseTestCounts,
  childCpuTicks,
};
