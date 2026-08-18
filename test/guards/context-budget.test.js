'use strict';

// G13 — always-loaded context budget (feature 008, design C13 / FR-019, FR-020, risk RK4).
//
// Everything reachable from DOFLOW_CORE.md is loaded into *every* session on *every* one of the
// seven harnesses, before the user has typed anything. It is the only content in this repo whose
// cost is paid unconditionally, so it is the only content that needs a hard ceiling rather than
// review judgement. Phase D must add stopping rules and evidence discipline to this set, which
// means the existing prose has to give up roughly what the new material costs; this guard is what
// makes that a constraint during authoring rather than a discovery afterwards.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GUIDANCE } = require('./_shared');

const ROOT_FILE = path.join(GUIDANCE, 'DOFLOW_CORE.md');

// The ceiling, in bytes, over the DoFlow-authored always-loaded set.
//
// 10,245 bytes — the measured total at the time design 008 was written, recorded in design §3 C13
// and risk RK4. It is deliberately the *current* size and not a round number with slack: the
// point is that the rewrite trades prose rather than accumulates it.
//
// Phase D is explicitly permitted to restructure, merge, split or entirely rewrite any file in
// this set. It is not permitted to grow the total. If the ceiling genuinely cannot hold, the
// agreed response (RK4) is one explicit, reviewed commit that raises this constant and states the
// new number and its cost — not a suppression, and not a quiet edit bundled into a prose diff.
const CEILING_BYTES = 10245;

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
    files.push({ rel, bytes: Buffer.byteLength(text, 'utf8') });
    for (const target of importsIn(text)) {
      queue.push(path.normalize(path.join(path.dirname(rel), target)));
    }
  }
  return { files, dangling, excluded };
}

function breakdown(files, total) {
  const width = Math.max(...files.map(({ rel }) => rel.length));
  const rows = files
    .slice()
    .sort((a, b) => b.bytes - a.bytes)
    .map(({ rel, bytes }) => `    ${rel.padEnd(width)}  ${String(bytes).padStart(6)}`);
  return [...rows, `    ${'TOTAL'.padEnd(width)}  ${String(total).padStart(6)}`].join('\n');
}

test('G13: the always-loaded set resolves from DOFLOW_CORE.md and every import exists', () => {
  const { files, dangling } = alwaysLoaded();
  assert.deepEqual(dangling, [],
    `DOFLOW_CORE.md imports files that do not exist:\n  ${dangling.join('\n  ')}`);
  // Guards the guard. If the @import syntax ever changes, the walk would find only the root file
  // and the budget check below would pass vacuously while measuring almost nothing — a green
  // suite that has stopped enforcing anything is worse than a red one.
  assert.ok(files.length > 1,
    `only ${files.length} always-loaded file(s) found — the @import parse in this guard has `
    + 'stopped matching DOFLOW_CORE.md\'s syntax, so the byte ceiling below is measuring nothing');
});

test('G13: the generated-file exclusion still names something the set actually imports', () => {
  const { excluded } = alwaysLoaded();
  const stale = [...GENERATED_EXCLUSIONS.keys()].filter((rel) => !excluded.includes(rel));
  assert.deepEqual(stale, [],
    'these files are excluded from the byte ceiling as install-generated, but nothing in the '
    + `always-loaded set imports them any more — delete the stale exclusion:\n  ${stale.join('\n  ')}`);
});

test('G13: the DoFlow-authored always-loaded set stays within its byte ceiling', () => {
  const { files } = alwaysLoaded();
  const total = files.reduce((sum, { bytes }) => sum + bytes, 0);
  assert.ok(total <= CEILING_BYTES,
    `always-loaded guidance is ${total} bytes, ${total - CEILING_BYTES} over the `
    + `${CEILING_BYTES}-byte ceiling. This content loads in every session on all seven harnesses.\n`
    + `${breakdown(files, total)}\n`
    + '  Restructuring this prose is expected and allowed; growing the total is not. Trade bytes\n'
    + '  out of the files above, or — if the ceiling genuinely cannot hold — raise CEILING_BYTES\n'
    + '  in this file in its own reviewed commit stating the new number and its cost (RK4).\n'
    + `  Excluded by design: ${[...GENERATED_EXCLUSIONS.keys()].join(', ')} (generated per install).`);
});
