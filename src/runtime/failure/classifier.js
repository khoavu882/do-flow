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

/** Reads one property without ever throwing: a throwing getter reads as undefined. */
function read(error, key) {
  try { return error[key]; } catch { return undefined; }
}

/** `error instanceof Class`, never throwing. */
function isA(error, Class) {
  try { return error instanceof Class; } catch { return false; }
}

/**
 * The `instanceof` checks come first and every property read is guarded, so a getter that throws
 * never drops a real TypeError.
 * @param {*} error
 * @returns {boolean}
 */
function isProgrammingError(error) {
  try {
    if (error === null || typeof error !== 'object') return false;
    const code = read(error, 'code');
    const name = read(error, 'name');
    // A broken pipe on stdout or stderr is the reader going away, not a bug (DEC-031).
    if (code === 'EPIPE') return false;
    if (isA(error, SyntaxError) || name === 'SyntaxError') return false;
    if (isA(error, TypeError) || isA(error, RangeError) || isA(error, ReferenceError)) return true;
    if (CLASS_NAMES.has(name)) return true;
    if (name === 'AssertionError' || code === 'ERR_ASSERTION') return true;
    if (code === 'MODULE_NOT_FOUND') return true;
    return typeof code === 'string' && (typeof read(error, 'syscall') === 'string' || typeof read(error, 'errno') === 'number');
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
  for (const Class of [TypeError, RangeError, ReferenceError]) {
    if (isA(error, Class)) return Class.name;
  }
  const name = read(error, 'name');
  const code = read(error, 'code');
  if (CLASS_NAMES.has(name) || name === 'AssertionError') return name;
  if (typeof code === 'string') return code;
  if (typeof name === 'string' && name) return name;
  return 'Error';
}

module.exports = { isProgrammingError, errorKind };
