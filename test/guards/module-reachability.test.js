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
const REQUIRER_ROOTS = ['bin', 'src', 'test'].map((d) => path.join(REPO, d));

/**
 * Roots whose requires make a src/ module *reachable*. Deliberately excludes test/: a module whose
 * only requirer is its own test is dead code with a passing test, which is how src/state/cas.js sat
 * in this tree for thirteen months with a green suite. Including bench/ because bench/runner.js
 * requires src/runtime/worktree.js for real — it is a consumer, not a test.
 */
const CONSUMER_ROOTS = ['bin', 'src', 'bench'].map((d) => path.join(REPO, d));

/**
 * Generated bench output, gitignored (.gitignore: bench/runs/, bench/reports/). A dispatched bench
 * case writes copies of this repo's own files under bench/runs/**, requires included — counting
 * those would let an untracked artifact vouch for a module nothing ships a caller for.
 */
const EXCLUDED_CONSUMER_DIRS = ['bench/runs', 'bench/reports'].map((d) => path.join(REPO, d));

/**
 * Surfaces that name a module by path instead of require()-ing it: package.json's npm scripts
 * (`node src/release/sync-plugin-versions.js`) and the shipped shell helpers (render-puml.sh sets
 * PROJECTOR to src/runtime/c4-project.js). A substring match, so a module merely *mentioned* in a
 * script comment also counts — the same weakness the require scan has, and preferable to an
 * allowlist, which goes on vouching for a module after its caller is deleted. Add a surface here
 * when a real caller appears on one, not in advance.
 */
const PATH_CALLER_SURFACES = ['package.json', path.join('core', 'shared', 'scripts')];

/**
 * An entry here documents why the named module is deliberately unreferenced — e.g. an entry point
 * invoked only via `node <path>` or `require.resolve` rather than a static `require('...')` a text
 * scan can see. Empty: the three modules no bin/ or src/ file requires are recognised by
 * PATH_CALLER_SURFACES (sync-plugin-versions.js via the `version` npm script, c4-project.js via
 * render-puml.sh) and CONSUMER_ROOTS (worktree.js via bench/runner.js), both of which stop
 * vouching for a module the moment its caller goes — which an allowlist entry would not.
 * "Nothing calls it" is never a reason — that module is dead, and belongs deleted, not exempted.
 */
const ALLOWLIST = new Set([
  // TEMPORARY (feature 046, tasks A.1 to A.4): the lifecycle modules land bottom-up and only the
  // verb wiring in A.5 requires the top of the chain, so each commit would otherwise fail this guard
  // on the newest module. A.5 requires them all and empties this list.
  'src/runtime/mask.js',
  'src/runtime/lifecycle/root.js',
  'src/runtime/lifecycle/event-store.js',
]);

/** Every `.js` file under a source/test root. */
function jsFilesUnder(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
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
 * This repository writes real `require(...)` calls into strings: runtime-evidence-write.test.js
 * writes fixture files whose contents are JavaScript. Those are data, not edges in this tree's
 * module graph, and counting them
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

/** Concatenated text of every file on a PATH_CALLER_SURFACES entry, for substring matching. */
function pathCallerText() {
  const chunks = [];
  for (const surface of PATH_CALLER_SURFACES) {
    const full = path.join(REPO, surface);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) {
      (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(child); else chunks.push(fs.readFileSync(child, 'utf8'));
        }
      }(full));
    } else {
      chunks.push(fs.readFileSync(full, 'utf8'));
    }
  }
  return chunks.join('\n');
}

test('G16: every .js module under src/ is required by at least one non-test consumer', () => {
  const modules = jsFilesUnder(SRC_DIR);
  assert.ok(modules.length > 0, 'expected to find at least one .js module under src/');

  const consumerFiles = CONSUMER_ROOTS
    .flatMap((root) => jsFilesUnder(root))
    .filter((f) => !EXCLUDED_CONSUMER_DIRS.some((dir) => f.startsWith(`${dir}${path.sep}`)));

  const reached = new Set();
  for (const file of consumerFiles) {
    for (const spec of requireSpecifiers(file)) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved) reached.add(resolved);
    }
  }

  const callerText = pathCallerText();
  const orphaned = modules
    .filter((m) => !reached.has(m))
    .map((m) => path.relative(REPO, m))
    .filter((rel) => !callerText.includes(rel.split(path.sep).join('/')))
    .filter((rel) => !ALLOWLIST.has(rel))
    .sort();

  assert.deepEqual(orphaned, [],
    'these modules ship under src/ but nothing outside test/ reaches them — no require() literal in '
    + 'bin/, src/ or bench/, and no npm script or shell helper names their path. A module whose only '
    + 'requirer is its own test is dead code with a passing test:\n  '
    + orphaned.join('\n  '));
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
        const target = path.resolve(path.dirname(file), spec);
        const rel = path.relative(REPO, target);
        if (rel.startsWith('..')) {
          continue;
        }
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

/** Line and block comments blanked, so prose describing an expression is not read as the expression.
 *  The third instance of this defect in one session: an analyser counted keywords in comments, a
 *  guard matched a require inside a string, and this rule matched its own explanatory comment. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

test('G16: the repository root is computed in exactly one place', () => {
  // Eighteen modules each computed `path.resolve(__dirname, '..', '..')`, which encodes how deep
  // the computing file sits. Grouping scaffold, trace and verification into directories moved three
  // of them a level down and split that into two spellings of the same intent — and every wrong
  // pick resolves to a real directory (`<repo>/src`), so it fails by reading the wrong tree rather
  // than by throwing. src/helper/repo-root.js owns it now; this keeps it owned.
  const offenders = jsFilesUnder(SRC_DIR)
    .filter((f) => path.relative(REPO, f) !== path.join('src', 'helper', 'repo-root.js'))
    .filter((f) => /path\.resolve\(\s*__dirname\s*,\s*'\.\.'/.test(withoutComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(REPO, f))
    .sort();

  assert.deepEqual(offenders, [],
    'these modules walk up from __dirname to reach the repository root. That expression encodes the '
    + "file's own depth, so moving it into a directory silently changes what it resolves to. Require "
    + `{ REPO_ROOT } from src/helper/repo-root.js instead:\n  ${offenders.join('\n  ')}`);
});

test('G16: every ALLOWLIST entry names a module that actually exists', () => {
  // An allowlist entry for a module that has since been deleted is dead weight nobody will notice —
  // this keeps the list honest if it is ever populated.
  const missing = [...ALLOWLIST].filter((rel) => !fs.existsSync(path.join(REPO, rel)));
  assert.deepEqual(missing, [], `ALLOWLIST names modules that do not exist:\n  ${missing.join('\n  ')}`);
});
