'use strict';

/**
 * G18: every adapter forwards `force` into `planTree`.
 *
 * `--force` was parsed (src/cli/index.js), threaded onto the lifecycle view (install.js) and into
 * its context (lifecycle/view.js), and consulted by the conflict predicate (copy-tree.js) — while
 * six of the eight adapters omitted it from their own `planTree` call. `planTree` declares
 * `force = false` as a parameter default, so every one of those calls silently received `false`
 * instead of the user's flag. Nothing errored: a missing optional argument is legal JavaScript.
 *
 * The user-visible effect was that `doflow install --force` could not clear a single conflict on
 * claude, opencode, pi, kiro, copilot or antigravity, leaving no supported way to reinstall over a
 * drifted tree. Only codex and gemini honoured the flag, and that asymmetry is what made the cause
 * findable: the two adapters whose conflict counts fell under `--force` were exactly the two that
 * forwarded it.
 *
 * This guard reads the WHOLE `planTree(...)` call expression rather than the single line containing
 * `planTree({`. That distinction is not incidental — these calls span several lines, and a
 * single-line check reported codex as dropping `force` when it forwards it on a continuation line.
 * A guard with that bug would have confirmed the defect it was written to prevent.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');

const ADAPTERS_DIR = path.join(REPO, 'src', 'adapters');

/** Every `planTree(...)` call in one file, as whole expressions — brace-balanced, not line-based. */
function planTreeCalls(source) {
  const calls = [];
  const marker = 'planTree({';
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    // Walk from the opening brace of the argument object until it closes.
    let depth = 0;
    let i = start + marker.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start, i + 1));
    from = i + 1;
  }
  return calls;
}

test('G18: every adapter forwards force into planTree', () => {
  const offenders = [];
  const checked = [];

  for (const entry of fs.readdirSync(ADAPTERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(ADAPTERS_DIR, entry.name, 'index.js');
    if (!fs.existsSync(file)) continue;

    const source = fs.readFileSync(file, 'utf8');
    const calls = planTreeCalls(source);
    if (!calls.length) continue;

    for (const call of calls) {
      checked.push(entry.name);
      if (!/\bforce\b/.test(call)) offenders.push(`${entry.name}/index.js`);
    }
  }

  assert.ok(checked.length >= 8,
    `expected a planTree call in every copy-tree adapter, found ${checked.length}: ${[...new Set(checked)].join(', ')}`);
  assert.deepEqual([...new Set(offenders)], [],
    'these adapters call planTree without forwarding force, so --force silently becomes planTree\'s '
    + `own default and the conflict gate never sees it:\n  ${[...new Set(offenders)].join('\n  ')}`);
});

test('G18: the parser, the lifecycle view and the conflict predicate all still speak force', () => {
  // The adapter hand-off above is only the last link. If any earlier one breaks, forwarding at the
  // adapters would be correct and still inert — which is the failure mode that took a differential
  // across five harnesses to find, so each link is asserted rather than assumed.
  const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

  assert.match(read('src/cli/index.js'), /case '-f': case '--force': o\.force = true/,
    'the CLI must parse --force');
  assert.match(read('src/cli/commands/install.js'), /force: o\.force/,
    'install must pass the parsed flag to the lifecycle view');
  assert.match(read('src/lifecycle/view.js'), /^\s+force,$/m,
    'the lifecycle view must place force in the adapter context');
  assert.match(read('src/adapters/copy-tree.js'), /const knownGood = force \|\|/,
    'planTree\'s conflict predicate must consult force');
});

test('G18: forwarding is gated so a forced removal never deletes a hand-edited file', () => {
  // copy-tree's remove path is deliberately strict: force heals drift on apply, but a file someone
  // edited by hand is not deleted, forced or not. Every forwarding site must therefore gate on
  // `!removing` — an unguarded `force: context.force` would hand force to the remove path too.
  const ungated = [];
  for (const entry of fs.readdirSync(ADAPTERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(ADAPTERS_DIR, entry.name, 'index.js');
    if (!fs.existsSync(file)) continue;
    for (const call of planTreeCalls(fs.readFileSync(file, 'utf8'))) {
      if (!/\bforce\b/.test(call)) continue;
      if (!/!removing/.test(call)) ungated.push(`${entry.name}/index.js`);
    }
  }
  assert.deepEqual([...new Set(ungated)], [],
    'these adapters forward force without gating on !removing, so a forced remove could delete a '
    + `hand-edited file:\n  ${[...new Set(ungated)].join('\n  ')}`);
});
