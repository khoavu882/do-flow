'use strict';

/**
 * CLI exit and error reporting for runtime verb handlers. These presentation helpers are being
 * factored out as verb handlers move from bin/doflow.js into engine modules. Homed here rather
 * than in cli.js to avoid import cycles, since cli.js already requires claims.js and claims.js
 * is gaining handleClaimCommand. This module requires nothing from src/runtime/ — that is its
 * defining constraint.
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
 * Reports an argument the CLI cannot proceed without, in the caller's requested shape.
 * @param {string} verb
 * @param {string} message
 * @param {boolean} [json]
 * @returns {number} 2 (USAGE error exit code)
 */
function usageError(verb, message, json) {
  if (json) console.log(JSON.stringify({ ok: false, status: 'USAGE', exitCode: 2, error: 'usage', summary: message }, null, 2));
  else console.error(`doflow ${verb}: ${message}`);
  return finishRuntime(2);
}

module.exports = { finishRuntime, usageError };
