'use strict';
// marker-merge.js — marker-delimited merge so a target project's own CLAUDE.md
// content survives repeated doflow install/update runs; only the span between the
// markers is ever regenerated.
const fs = require('node:fs');
const path = require('node:path');

const MARKER_START =
  '<!-- doflow:start — content below is managed by doflow install/update; edits here are overwritten on the next run -->';
const MARKER_END = '<!-- doflow:end -->';

/**
 * Merge `srcAbs`'s content into `dstAbs` inside a doflow-owned marker span,
 * preserving any of `dstAbs`'s own content outside that span byte-for-byte.
 * @param {string} srcAbs
 * @param {string} dstAbs
 * @param {{dryRun?: boolean}} [opts]
 * @returns {{changed: boolean}}
 */
function mergeMarkedSection(srcAbs, dstAbs, { dryRun = false } = {}) {
  const srcContent = fs.readFileSync(srcAbs, 'utf8').replace(/\s+$/, '');
  const section = `${MARKER_START}\n${srcContent}\n${MARKER_END}\n`;

  // Read once, reused both for parsing and for the final no-op comparison below.
  const existing = fs.existsSync(dstAbs) ? fs.readFileSync(dstAbs, 'utf8') : null;

  let newContent;
  if (existing === null) {
    newContent = section;
  } else {
    const startIdx = existing.indexOf(MARKER_START);
    if (startIdx === -1) {
      // Foreign file with no doflow span yet — append, normalizing to exactly
      // one blank line of separation without touching existing's own bytes.
      let separator;
      if (existing.endsWith('\n\n')) separator = '';
      else if (existing.endsWith('\n')) separator = '\n';
      else separator = '\n\n';
      newContent = existing + separator + section;
    } else {
      const endIdx = existing.indexOf(MARKER_END, startIdx + MARKER_START.length);
      if (endIdx === -1) {
        throw new Error(
          `Malformed doflow markers in ${dstAbs}: found MARKER_START with no matching MARKER_END — fix or remove the markers manually before retrying.`
        );
      }
      // Search for a duplicate START only *after* the span closes, not from inside it — the
      // previous version of this function searched from startIdx + MARKER_START.length, which
      // is *inside* the span, and false-positived whenever the span's own content happened to
      // contain the marker text (e.g. srcContent documenting this exact mechanism). Searching
      // from after the real end only flags a genuine second, structurally separate span.
      //
      // Residual limitation: endIdx above is still the *first* MARKER_END found after startIdx,
      // so srcContent containing the literal MARKER_END text (not just MARKER_START) could still
      // truncate the span early. Fixing that by taking the *last* MARKER_END in the file instead
      // was tried and reverted — it silently defeated this exact duplicate-span detection (two
      // complete, genuinely separate spans collapse into one under lastIndexOf). Between "rare,
      // avoidable corruption if source content literally quotes MARKER_END" and "silently losing
      // detection of real duplicate spans," the latter is worse, so this trade-off is intentional
      // pending a more precise fix.
      const dupIdx = existing.indexOf(MARKER_START, endIdx + MARKER_END.length);
      if (dupIdx !== -1) {
        throw new Error(
          `Malformed doflow markers in ${dstAbs}: found a duplicate doflow:start marker — fix or remove the markers manually before retrying.`
        );
      }
      // section always supplies its own trailing "\n" after MARKER_END, so the
      // original file's matching trailing "\n" (if present) must be consumed here —
      // otherwise a replace with no real change grows the file by one newline
      // every time it runs (breaks idempotency).
      let afterEnd = endIdx + MARKER_END.length;
      if (existing[afterEnd] === '\n') afterEnd += 1;
      newContent = existing.slice(0, startIdx) + section + existing.slice(afterEnd);
    }
  }

  if (existing === newContent) return { changed: false };
  if (dryRun) return { changed: true };

  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.writeFileSync(dstAbs, newContent);
  return { changed: true };
}

/**
 * Strip only the doflow-managed span from `file`, leaving any surrounding content (before/after
 * the markers) byte-for-byte untouched. Companion to `mergeMarkedSection` — shared by the Claude
 * and Codex adapters' `remove()`, which had each carried an identical private copy of this.
 * @param {string} file
 * @returns {boolean} whether a managed span was found and stripped (false if the file doesn't
 *          exist or has no doflow markers — both are no-ops, not errors)
 */
function removeMarkedSection(file) {
  if (!fs.existsSync(file)) return false;
  const existing = fs.readFileSync(file, 'utf8');
  const start = existing.indexOf(MARKER_START);
  if (start === -1) return false;
  const end = existing.indexOf(MARKER_END, start + MARKER_START.length);
  if (end === -1 || existing.indexOf(MARKER_START, end + MARKER_END.length) !== -1) {
    throw new Error(`Refusing to remove malformed DoFlow markers in ${file}`);
  }
  let after = end + MARKER_END.length;
  if (existing[after] === '\n') after += 1;
  let next = existing.slice(0, start) + existing.slice(after);
  // Do not alter user content; only remove separator whitespace that was added
  // immediately before an appended managed section.
  if (next === '\n') next = '';
  fs.writeFileSync(file, next);
  return true;
}

module.exports = { mergeMarkedSection, removeMarkedSection, MARKER_START, MARKER_END };
