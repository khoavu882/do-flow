'use strict';

// The always-loaded measurement helper (074 C15, IC-019), extracted unchanged from
// test/guards/context-budget.test.js so the perf runner can report the same startup byte total
// the G13 guard enforces.
const fs = require('node:fs');
const path = require('node:path');
const { REPO, GUIDANCE } = require('../guards/_shared');

const ROOT_FILE = path.join(GUIDANCE, 'DOFLOW_CORE.md');

// Generated per install, excluded by name rather than forgotten.
//
// MCP_INDEX.md and everything it imports under guidance/mcp/ are written at install time from the
// MCP servers the user actually selected. Their size is a property of the machine, not of
// DoFlow-authored content, and it differs between two correct installs — so measuring them would
// make this guard's result depend on who ran it. The import walk stops at MCP_INDEX.md and does
// not descend into its @mcp/* imports.
const GENERATED_EXCLUSIONS = new Map([
  ['MCP_INDEX.md', 'generated per install from the servers actually selected; size varies per machine'],
]);

/** Newline-separated lines, without the empty line a trailing newline would add. */
function lineCount(text) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** `@relative/path.md` at the start of a line — the import syntax DOFLOW_CORE.md actually uses. */
function importsIn(text) {
  return [...text.matchAll(/^@(\S+)$/gm)].map(([, target]) => target);
}

/**
 * The always-loaded set, walked transitively from DOFLOW_CORE.md rather than hardcoded.
 *
 * A hardcoded file list is the failure mode this ceiling exists to prevent: it silently stops
 * covering a file the moment someone adds one to the set, which is exactly when the budget most
 * needs to bind. Returns { files, dangling, excluded } — relative to the guidance root.
 */
function alwaysLoaded() {
  const files = [];
  const dangling = [];
  const excluded = [];
  const seen = new Set();
  const queue = [path.relative(GUIDANCE, ROOT_FILE)];

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;                              // an import cycle must not hang the guard
    seen.add(rel);
    if (GENERATED_EXCLUSIONS.has(rel)) { excluded.push(rel); continue; }
    const full = path.join(GUIDANCE, rel);
    if (!fs.existsSync(full)) { dangling.push(rel); continue; }
    const text = fs.readFileSync(full, 'utf8');
    files.push({ rel, lines: lineCount(text), bytes: Buffer.byteLength(text, 'utf8') });
    for (const target of importsIn(text)) {
      queue.push(path.normalize(path.join(path.dirname(rel), target)));
    }
  }
  return { files, dangling, excluded };
}

/** Every `*.md` under `dir` (repo-relative), depth first. */
function markdownUnder(dir) {
  return fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(rel);
    return entry.name.endsWith('.md') ? [rel] : [];
  });
}

/** Lines and bytes of every `*.md` under a directory, or of one file, after an optional transform. */
function measureSource(sourceRel, transform) {
  const full = path.join(REPO, sourceRel);
  const names = fs.statSync(full).isDirectory() ? markdownUnder(sourceRel) : [sourceRel];
  return names.reduce((total, rel) => {
    let bytes = fs.readFileSync(path.join(REPO, rel));
    if (transform) bytes = transform(rel, bytes);
    return { lines: total.lines + lineCount(bytes.toString('utf8')), bytes: total.bytes + bytes.length };
  }, { lines: 0, bytes: 0 });
}

module.exports = { GENERATED_EXCLUSIONS, alwaysLoaded, measureSource, lineCount, importsIn, markdownUnder };
