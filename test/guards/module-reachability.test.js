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
  for (const [, spec] of text.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
    specs.push(spec);
  }
  return specs;
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

test('G16: every ALLOWLIST entry names a module that actually exists', () => {
  // An allowlist entry for a module that has since been deleted is dead weight nobody will notice —
  // this keeps the list honest if it is ever populated.
  const missing = [...ALLOWLIST].filter((rel) => !fs.existsSync(path.join(REPO, rel)));
  assert.deepEqual(missing, [], `ALLOWLIST names modules that do not exist:\n  ${missing.join('\n  ')}`);
});
