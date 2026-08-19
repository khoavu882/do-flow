'use strict';

/**
 * CLI rendering for `doflow trace`/`stats`/`discover` (split out of `trace.js`, plan task H.3).
 *
 * Pure formatting over the view models `trace-views.js` builds: no filesystem access, no ledger
 * read or write. `trace.js`'s `handle*Command` functions call into this module to turn a view
 * model into terminal output and a process exit code.
 */

/** ISO timestamp to a compact local-independent `MM-DD HH:MM:SS`. Keeps columns narrow without
 * inventing a timezone the record does not carry. */
function shortTime(timestamp) {
  if (typeof timestamp !== 'string' || timestamp.length < 19) return '(undated)';
  return `${timestamp.slice(5, 10)} ${timestamp.slice(11, 19)}`;
}

function formatMs(value) {
  if (typeof value !== 'number') return '-';
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

/**
 * Records a view's exit code and hands it back to the caller.
 *
 * The design's uniform contract (§4.2) is `0` answered, `1` a finding to act on, `2` a usage error.
 * A handler sets `process.exitCode` rather than calling `process.exit`, so buffered stdout is
 * flushed before the process ends — and it also returns the code, so a test can assert it without
 * spawning a process.
 * @param {number} code
 * @returns {number}
 */
function finish(code) {
  process.exitCode = code;
  return code;
}

/**
 * What the view could not read, stated in the view rather than only in the JSON. A history that
 * silently lost a partition is a history a reader would over-trust.
 * @param {Object} ledger
 * @returns {string|null}
 */
function integrityNote(ledger) {
  const parts = [];
  if (ledger.malformedLines) parts.push(`${ledger.malformedLines} unreadable ledger line(s) skipped`);
  if (ledger.unreadableFiles.length) parts.push(`${ledger.unreadableFiles.length} unreadable partition(s): ${ledger.unreadableFiles.join(', ')}`);
  return parts.length ? `Note: ${parts.join('; ')}.` : null;
}

/** One place that turns a resolved location into the sentence an empty ledger deserves. */
function printEmptyLedgerNotice(ledger, reason) {
  console.log(`  ${reason}`);
  console.log(`  Location: ${ledger.dir}`);
  console.log('  An empty ledger is a normal state for a fresh install. It is not evidence that');
  console.log('  nothing ran, and no conclusion about usage can be drawn from it.');
}

const DISCOVER_MARK = Object.freeze({
  FINDING: '! FINDING',
  CLEAR: '✓ CLEAR',
  NOT_DETERMINED: '? UNKNOWN',
  NOT_APPLICABLE: '- N/A',
});

module.exports = {
  shortTime,
  formatMs,
  finish,
  integrityNote,
  printEmptyLedgerNotice,
  DISCOVER_MARK,
};
