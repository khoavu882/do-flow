'use strict';

/**
 * CLI exit and error reporting for runtime verb handlers. These presentation helpers are being
 * factored out as verb handlers move from bin/doflow.js into engine modules. Homed here rather
 * than in cli.js to avoid import cycles, since cli.js already requires claims.js and claims.js
 * is gaining handleClaimCommand. This module requires nothing from src/runtime/ at load time — that
 * is its defining constraint; the failure writer is required lazily, inside the one call that uses
 * it, and requires only the mask module.
 */

/**
 * Sets the process exit code.
 * @param {number} code
 * @returns {number} the code, for chaining
 */
function finishRuntime(code) {
  process.exitCode = code;
  return code;
}

/**
 * Records a caught error in the failure store when it is a programming error (IC-010), silently and
 * without changing anything the caller prints or exits with. For a handler that catches an error and
 * reports it itself, so a bug in DoFlow is not swallowed by its own `[ERROR]` line.
 * @param {*} error
 * @param {string} command the verb or installer command name
 * @param {number} exit the exit status the caller is about to produce
 */
function captureCaught(error, command, exit) {
  try { require('./failure/capture').captureError(error, { command, exit }); } catch { /* capture is best-effort */ }
}

/**
 * Reports an argument the CLI cannot proceed without, in the caller's requested shape.
 *
 * `error` is the thrown error a catch site is turning into this usage result. When it is a
 * programming error (IC-010) it is also recorded in the failure store, silently; the output and
 * the exit status are the same either way (IC-016).
 * @param {string} verb
 * @param {string} message
 * @param {boolean} [json]
 * @param {Error} [error]
 * @returns {number} 2 (USAGE error exit code)
 */
function usageError(verb, message, json, error) {
  if (error !== undefined) captureCaught(error, verb, 2);
  if (json) console.log(JSON.stringify({ ok: false, status: 'USAGE', exitCode: 2, error: 'usage', summary: message }, null, 2));
  else console.error(`doflow ${verb}: ${message}`);
  return finishRuntime(2);
}

module.exports = { finishRuntime, usageError, captureCaught };
