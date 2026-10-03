'use strict';

/**
 * The programming-error classifier (IC-010, DEC-013, DEC-031). Decides whether a caught error is a
 * bug in DoFlow worth recording, as opposed to a finding, a refusal, a bad flag or a fault in the
 * user's environment. Pure and total: it never throws, whatever it is handed.
 *
 * The same function is copied into core/harnesses/shared/hooks/stream-hook-runner.js, because hook
 * files are installed without the runtime library; a test runs both copies over one fixture set.
 */

const CLASS_NAMES = new Set(['TypeError', 'RangeError', 'ReferenceError']);

/**
 * @param {*} error
 * @returns {boolean}
 */
function isProgrammingError(error) {
  try {
    if (error === null || typeof error !== 'object') return false;
    // A broken pipe on stdout or stderr is the reader going away, not a bug (DEC-031).
    if (error.code === 'EPIPE') return false;
    if (error instanceof SyntaxError || error.name === 'SyntaxError') return false;
    if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) return true;
    if (CLASS_NAMES.has(error.name)) return true;
    if (error.name === 'AssertionError' || error.code === 'ERR_ASSERTION') return true;
    if (error.code === 'MODULE_NOT_FOUND') return true;
    return typeof error.code === 'string' && (typeof error.syscall === 'string' || typeof error.errno === 'number');
  } catch {
    return false;
  }
}

/**
 * The `kind` a captured error is recorded under: the class name for the programming-error classes,
 * else the error's code (a system error or MODULE_NOT_FOUND), else its name.
 * @param {*} error
 * @returns {string}
 */
function errorKind(error) {
  try {
    if (CLASS_NAMES.has(error.name) || error.name === 'AssertionError') return error.name;
    if (typeof error.code === 'string') return error.code;
    if (typeof error.name === 'string' && error.name) return error.name;
  } catch { /* fall through */ }
  return 'Error';
}

module.exports = { isProgrammingError, errorKind };
