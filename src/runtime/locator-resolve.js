'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Does an evidence locator still point at something?
 *
 * `parseLocator` in cli.js validates a locator's *shape* — that `line` is a positive integer and
 * `file` a non-empty string — and never opens the file. A locator naming line 799 of a 28-line file
 * therefore passed validation, was recorded as support, and the readiness gate counted it. This
 * module answers the question that check never asked (FR-004, FR-005).
 *
 * It reads files and decides nothing else. Whether an unresolvable locator should refuse a write
 * (FR-004) or fail a gate (FR-005) is the caller's policy, which is why both callers can share one
 * implementation — see design C2. This module requires nothing from src/runtime/; that is its
 * defining constraint, same as cli-result.js.
 */

/** Why a locator did not resolve. `not-checkable` is not a failure — see `resolveLocator`. */
const RESOLUTION_REASONS = new Set([
  'file-missing',
  'line-beyond-eof',
  'symbol-absent',
  'not-checkable',
]);

/**
 * Word-boundary search for an identifier, so `parseLocator` does not match inside
 * `notParseLocatorReally`. Deliberately textual rather than syntactic: this module must answer for
 * every language in the repository, and a parser per language is a far larger thing than the
 * question being asked.
 */
function findSymbolLines(lines, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:[^A-Za-z0-9_$]|$)`);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) hits.push(i + 1);
  }
  return hits;
}

/**
 * Resolves one locator against the repository as it stands right now.
 *
 * A `uri` locator with no `file` resolves as `not-checkable`: this module cannot read a URI, and
 * returning a verdict about something it did not read is the invented-verdict failure the whole
 * feature exists to remove (design D4). `resolved` is therefore `true` with a `reason` — the only
 * combination where the two disagree, and it is deliberate.
 *
 * @param {Object} options
 * @param {Object} options.locator a parsed locator: { file?, line?, symbol?, uri? }
 * @param {string} [options.repoRoot] root a relative `file` is resolved against; defaults to cwd
 * @param {Object} [options.fsImpl] injectable fs, for tests
 * @returns {{resolved: boolean, reason: (string|null), actual: (Object|null)}}
 *   `actual` names what the file does offer, so a caller can build a message the writer can act on:
 *   `{ lines }` for a line miss, `{ symbolLines }` for a symbol miss.
 */
function resolveLocator({ locator, repoRoot, fsImpl } = {}) {
  const impl = fsImpl || fs;

  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
    return { resolved: true, reason: 'not-checkable', actual: null };
  }
  if (!locator.file) {
    // A uri-only locator, or an empty locator on a non-extracted item. Nothing readable here.
    return { resolved: true, reason: 'not-checkable', actual: null };
  }

  const root = repoRoot || process.cwd();
  const target = path.isAbsolute(locator.file) ? locator.file : path.join(root, locator.file);

  let content;
  try {
    if (!impl.existsSync(target)) return { resolved: false, reason: 'file-missing', actual: null };
    content = impl.readFileSync(target, 'utf8');
  } catch {
    // Unreadable for any other reason — a directory, a permission error, a binary that will not
    // decode. Report it as missing rather than inventing a third verdict the callers must handle.
    return { resolved: false, reason: 'file-missing', actual: null };
  }

  // A trailing newline ends the last line; it does not begin another one.
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (locator.line !== undefined && locator.line > lines.length) {
    return { resolved: false, reason: 'line-beyond-eof', actual: { lines: lines.length } };
  }

  if (locator.symbol) {
    const symbolLines = findSymbolLines(lines, locator.symbol);
    if (symbolLines.length === 0) {
      return { resolved: false, reason: 'symbol-absent', actual: { lines: lines.length, symbolLines: [] } };
    }
    // A symbol that is present but not on the named line is still a resolvable locator: the code
    // moved, which freshness already reports. Only absence is unresolvable.
    return { resolved: true, reason: null, actual: { lines: lines.length, symbolLines } };
  }

  return { resolved: true, reason: null, actual: { lines: lines.length } };
}

/**
 * One-line explanation of an unresolved verdict, for a caller's error or report text. Returns null
 * for a resolved locator so a caller can use it as the whole message or not at all.
 *
 * @param {Object} locator
 * @param {{resolved: boolean, reason: (string|null), actual: (Object|null)}} result
 * @returns {string|null}
 */
function describeResolution(locator, result) {
  if (!result || result.resolved) return null;
  const file = (locator && locator.file) || '(no file)';
  switch (result.reason) {
    case 'file-missing':
      return `'${file}' cannot be read from this repository`;
    case 'line-beyond-eof':
      return `'${file}' has ${result.actual.lines} line(s); the locator names line ${locator.line}`;
    case 'symbol-absent':
      return `'${file}' contains no symbol '${locator.symbol}'`;
    default:
      return `'${file}' did not resolve (${result.reason})`;
  }
}

module.exports = { resolveLocator, describeResolution, RESOLUTION_REASONS };
