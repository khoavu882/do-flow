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
  }

  /**
   * Executes a single deterministic shell check.
   * @param {string} name
   * @param {string} command
   * @param {number} [timeoutMs]
   * @returns {Object} check result
   */
  runCheck(name, command, timeoutMs = this.defaultTimeoutMs) {
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
      return {
        name: checkName,
        command,
        status: 'FAIL',
        exitCode: 1,
        error: error.message,
      };
    }

    // Defect fix (2): the Python's TimeoutExpired arm returned neither stdout nor stderr, so a
    // check that hung after printing its first failure told you only that it hung. Whatever the
    // process produced before the kill is exactly what a reader needs.
    if (res.error && res.error.code === 'ETIMEDOUT') {
      return {
        name: checkName,
        command,
        status: 'FAIL',
        exitCode: TIMEOUT_EXIT_CODE,
        error: 'TimeoutExpired',
        stdout: truncate(res.stdout),
        stderr: truncate(res.stderr),
      };
    }

    if (res.error) {
      return {
        name: checkName,
        command,
        status: 'FAIL',
        exitCode: 1,
        error: res.error.message,
        stdout: truncate(res.stdout),
        stderr: truncate(res.stderr),
      };
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
    return result;
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

    for (const chk of checks) {
      const name = (chk && chk.name) || 'unnamed_check';
      const res = this.runCheck(name, chk && chk.command, chk && chk.timeoutMs);
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
};
