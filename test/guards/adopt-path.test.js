'use strict';

/**
 * G19: every "not owned" refusal has a way out.
 *
 * Three codex components refused a resource that exists on disk with no ledger record, and none of
 * them consulted any flag. That made the state unexitable through documented commands: the condition
 * blocking the install was the same condition an install had to run to clear, and `reconcile` — the
 * command written to heal ownership drift — is refused by the same gate it would have to pass.
 *
 * A refusal with no escape is a different kind of defect from a wrong refusal: it cannot be worked
 * around, only patched. This guard asserts that every site pushing a "not owned" conflict sits in a
 * function that can be told to adopt instead, so a new component cannot reintroduce a dead end
 * without the suite saying so.
 *
 * It checks the enclosing function, not the same line: the refusal and the `adopt` parameter that
 * governs it are necessarily on different lines, so a line-local check would pass on a file where
 * neither is connected to the other.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');

const ADAPTERS_DIR = path.join(REPO, 'src', 'adapters');

/** Every .js file under src/adapters/, recursively. */
function adapterSources() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.js')) out.push(full);
    }
  }(ADAPTERS_DIR));
  return out;
}

/**
 * The source of the function enclosing `index`, found by walking back to the nearest `function`
 * keyword and forward to its brace-balanced end. Good enough for this codebase's style, where every
 * planner is a named function declaration.
 */
function enclosingFunction(source, index) {
  const start = source.lastIndexOf('function ', index);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1 || open > index) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

test('G19: every "not owned" refusal sits in a function that can be told to adopt', () => {
  const NOT_OWNED = /is not owned by (?:DoFlow|the neutral ledger)/g;
  const deadEnds = [];
  let sites = 0;

  for (const file of adapterSources()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(NOT_OWNED)) {
      // Only the lines that actually raise the refusal, not prose about it.
      const line = source.slice(source.lastIndexOf('\n', match.index) + 1, source.indexOf('\n', match.index));
      if (!/conflicts\.push|errors:|conflict/.test(line)) continue;
      sites += 1;

      const fn = enclosingFunction(source, match.index);
      if (!fn || !/\badopt\b/.test(fn)) {
        deadEnds.push(`${path.relative(REPO, file)}: ${line.trim().slice(0, 96)}`);
      }
    }
  }

  assert.ok(sites >= 3,
    `expected to find the known "not owned" refusal sites, found ${sites} — has the message wording changed?`);
  assert.deepEqual(deadEnds, [],
    'these refusals cannot be escaped by any caller, so the state they report can only be left by '
    + `patching DoFlow:\n  ${deadEnds.join('\n  ')}`);
});

test('G19: adopt is parsed, threaded, and read off the lifecycle context', () => {
  // Each link asserted separately, because the flag existing at one end and being read at the other
  // is exactly the shape that already failed twice here: `--force` died at the adapter boundary, and
  // the first cut of `adopt` read it off the adapter's own narrow native context, where it is absent.
  const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

  assert.match(read('src/cli/index.js'), /case '--adopt': o\.adopt = true/, 'the CLI must parse --adopt');
  assert.match(read('src/cli/commands/install.js'), /adopt: o\.adopt === true/, 'install must pass it on');
  assert.match(read('src/lifecycle/view.js'), /^\s+adopt,$/m, 'the lifecycle view must put it in the adapter context');
  assert.match(read('src/adapters/codex/index.js'), /options\.context\?\.adopt === true/,
    'the adapter must read it off the LIFECYCLE context (options.context), not its own native one');
});

test('G19: adopt is documented where the conflict rule is explained', () => {
  // A flag nobody can discover is a flag that does not exist. setup.md is where --force and the
  // conflict rule are already described, so an adoption path absent from that passage would leave a
  // reader with the same dead end the code no longer has.
  const setup = fs.readFileSync(path.join(REPO, 'docs/setup.md'), 'utf8');
  assert.match(setup, /--adopt/, 'docs/setup.md must document --adopt');
  assert.match(setup, /not owned/i, 'and must explain the not-owned case it answers');
});
