'use strict';

// G16 — every JavaScript module under src/ is reachable from something that requires it.
//
// G8 (reachability.test.js) already checks this for shipped SHELL scripts, CLI commands, and
// doc-referenced paths — it never covered .js modules. That gap is exactly how four modules under
// src/ accumulated with no requirer anywhere: nothing asserted a module had to be named by a
// `require(...)` call, so they sat unreferenced until a manual audit found them (deleted in a prior
// task). This guard closes that gap the same way G8 closes it for scripts: static text scanning,
// no execution, no dependency added.
//
// Deliberately NOT done by loading modules and inspecting require.cache — executing a module's
// top-level code as a side effect of running a guard is exactly the kind of thing a guard must not
// do. Static scanning of `require('...')` / `require("...")` string literals is weaker (it cannot
// see a dynamically constructed specifier) but has no such side effect, and this repo has zero
// dependencies, so no AST parser either — fs and path from node: are all this uses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');

const SRC_DIR = path.join(REPO, 'src');
const REQUIRER_ROOTS = ['bin', 'src', 'test', 'bench'].map((d) => path.join(REPO, d));
// bench/runs/ holds RECORDED EVAL OUTPUTS — copies of old source and old test/bench files captured
// as artifacts of past benchmark runs, not code that ships or executes. A `require(...)` inside one
// of those copies would make a deleted module look reachable again, so the directory is excluded
// from both the requirer scan and the requiree inventory.
const BENCH_RUNS = path.join(REPO, 'bench', 'runs');

/**
 * An entry here documents why the named module is deliberately unreferenced — e.g. an entry point
 * invoked only via `node <path>` or `require.resolve` rather than a static `require('...')` a text
 * scan can see. Empty on introduction: nothing in this repo currently needs the exemption.
 */
const ALLOWLIST = new Set([]);

function isExcluded(full) {
  return full === BENCH_RUNS || full.startsWith(BENCH_RUNS + path.sep);
}

/** Every `.js` file under a root, excluding bench/runs/. */
function jsFilesUnder(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (isExcluded(full)) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.js')) out.push(full);
    }
  }(root));
  return out;
}

/** Relative `require('...')` / `require("...")` specifiers found in a file's text, with the
 * requiring file's directory, so each can be resolved on its own terms. */
function requireSpecifiers(file) {
  const text = fs.readFileSync(file, 'utf8');
  const specs = [];
  for (const match of text.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
    if (isInsideStringLiteral(text, match.index)) continue;
    specs.push(match[1]);
  }
  return specs;
}

/**
 * Is this `require(` occurrence itself inside a string literal?
 *
 * This repository writes real `require(...)` calls into strings: `bench/runner.js` builds a snippet
 * to inject into a subprocess, and `runtime-evidence-write.test.js` writes fixture files whose
 * contents are JavaScript. Those are data, not edges in this tree's module graph, and counting them
 * makes the resolve check below report a broken require that is not broken and not ours.
 *
 * Line-scoped and deliberately bounded: count unescaped quotes before the match on its own line,
 * and call it a string if either quote character is unbalanced. A string spanning multiple lines
 * defeats it, which is the accepted failure — it would report a specifier that is genuinely data.
 * The alternative, a real tokenizer, is far more machinery than a guard needs.
 */
function isInsideStringLiteral(text, index) {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const before = text.slice(lineStart, index);
  const count = (ch) => (before.match(new RegExp(`(?<!\\\\)${ch}`, 'g')) || []).length;
  return count("'") % 2 === 1 || count('"') % 2 === 1;
}

/** Resolve a relative require specifier against the requiring file's directory, the way Node
 * would: the literal path, then `+ '.js'`, then `+ '/index.js'`. */
function resolveSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

test('G16: every .js module under src/ is required by at least one relative require() literal', () => {
  const modules = jsFilesUnder(SRC_DIR);
  assert.ok(modules.length > 0, 'expected to find at least one .js module under src/');

  const requirerFiles = REQUIRER_ROOTS.flatMap((root) => jsFilesUnder(root));

  const reached = new Set();
  for (const file of requirerFiles) {
    for (const spec of requireSpecifiers(file)) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved) reached.add(resolved);
    }
  }

  const orphaned = modules
    .filter((m) => !reached.has(m) && !ALLOWLIST.has(path.relative(REPO, m)))
    .map((m) => path.relative(REPO, m))
    .sort();

  assert.deepEqual(orphaned, [],
    'these modules ship under src/ but no require(\'...\') literal in bin/, src/, test/, or bench/ '
    + `(excluding bench/runs/) names them:\n  ${orphaned.join('\n  ')}`);
});

test('G16: every relative require() literal resolves to a file that exists', () => {
  // The reachability test above answers "is this module named by someone", and to do that it drops
  // a specifier it cannot resolve (`if (resolved) reached.add(resolved)`). So a require naming
  // *nothing* is invisible to it — the module it should have named simply stays reached by some
  // other requirer, and the suite is green.
  //
  // That gap is not theoretical. A lazy require inside a function body is only executed on the
  // branch that needs it, so a stale specifier survives a full test run; and a defensive
  // `try { require(...) } catch { fallback }` around one converts the eventual MODULE_NOT_FOUND
  // into a silent, permanent degradation rather than a crash. Both patterns exist in this tree.
  // Resolving every literal statically is the only check that sees them.
  const requirerFiles = REQUIRER_ROOTS.flatMap((root) => jsFilesUnder(root));

  const dangling = [];
  for (const file of requirerFiles) {
    for (const spec of requireSpecifiers(file)) {
      if (!resolveSpecifier(file, spec)) {
        dangling.push(`${path.relative(REPO, file)} -> ${spec}`);
      }
    }
  }
  dangling.sort();

  assert.deepEqual(dangling, [],
    'these relative require() specifiers name a file that does not exist. A lazy or try/caught '
    + 'require will not fail a test run, so this is the only place it surfaces:\n  '
    + `${dangling.join('\n  ')}`);
});

test('G16: every ALLOWLIST entry names a module that actually exists', () => {
  // An allowlist entry for a module that has since been deleted is dead weight nobody will notice —
  // this keeps the list honest if it is ever populated.
  const missing = [...ALLOWLIST].filter((rel) => !fs.existsSync(path.join(REPO, rel)));
  assert.deepEqual(missing, [], `ALLOWLIST names modules that do not exist:\n  ${missing.join('\n  ')}`);
});
