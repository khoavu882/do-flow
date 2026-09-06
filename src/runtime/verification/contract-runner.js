'use strict';

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
function truncate(value) {
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
function extractFailedTests(text) {
  const seen = new Set();
  for (const match of text.matchAll(TAP_NOT_OK)) {
    const name = match[1].trim();
    if (name === '' || /#\s*(?:SKIP|TODO)\b/i.test(name)) continue;
    seen.add(name);
    if (seen.size >= MAX_FAILED_TESTS) break;
  }
  return [...seen];
}

class VerificationContractRunner {
  /**
   * @param {Object|string} [options] a string is accepted for parity with the Python's positional
   *   `cwd` argument
   * @param {string} [options.cwd] directory the checks run in; defaults to the current one
   * @param {number} [options.defaultTimeoutMs=60000]
   * @param {Function} [options.exec] injection seam for tests; same contract as `spawnSync`
   */
  constructor(options = {}) {
    const opts = typeof options === 'string' ? { cwd: options } : options;
    this.cwd = opts.cwd || process.cwd();
    this.defaultTimeoutMs = opts.defaultTimeoutMs || DEFAULT_TIMEOUT_MS;
    this.exec = opts.exec || spawnSync;
    this.fsImpl = opts.fsImpl || fs;
    this.logDir = opts.logDir || path.join(this.cwd, '.doflow', 'state', 'verification', 'logs');
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
  persistLog(name, command, stdout, stderr) {
    try {
      this.fsImpl.mkdirSync(this.logDir, { recursive: true });
      const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_');
      const file = path.join(this.logDir, `${Date.now()}-${safe}.log`);
      this.fsImpl.writeFileSync(file,
        `# check: ${name}\n# command: ${command}\n--- stdout ---\n${stdout || ''}\n--- stderr ---\n${stderr || ''}\n`,
        'utf8');
      return file;
    } catch {
      // An unwritable log directory must not turn a completed check into an error — the check's
      // verdict stands; only the pointer is missing, and its null says so.
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
  decorate(result, command, stdout, stderr) {
    const full = `${stdout || ''}\n${stderr || ''}`;
    if (result.status === 'FAIL') {
      const failedTests = extractFailedTests(full);
      if (failedTests.length > 0) result.failedTests = failedTests;
    }
    const truncated = (stdout || '').length > MAX_STREAM_CHARS || (stderr || '').length > MAX_STREAM_CHARS;
    if ((result.status === 'FAIL' || truncated) && full.trim() !== '') {
      result.logPath = this.persistLog(result.name, command, stdout, stderr);
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
  runCheck(name, command, timeoutMs = this.defaultTimeoutMs, dedupeCache = null) {
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

    const dedupeKey = `${timeoutMs} ${command}`;
    if (dedupeCache && dedupeCache.has(dedupeKey)) {
      return { ...dedupeCache.get(dedupeKey), name: checkName, deduplicated: true };
    }
    const remember = (result) => {
      if (dedupeCache) dedupeCache.set(dedupeKey, result);
      return result;
    };

    let res;
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
    } catch (error) {
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

    const result = {
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
  evaluateContract(checks) {
    if (!Array.isArray(checks)) {
      throw new Error('evaluateContract expects an array of checks');
    }

    // Defect fix (3): an empty contract reported PASS, which is a verdict over no evidence — the
    // single failure mode a verification gate exists to prevent, and the same fail-closed reasoning
    // `readiness.js` already applies to a requirement with no evaluator. It is not FAIL either,
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

    const results = [];
    const failedChecks = [];
    let overallStatus = 'PASS';
    const dedupeCache = new Map(); // one evaluation, one cache — a retry pass starts fresh

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
};
