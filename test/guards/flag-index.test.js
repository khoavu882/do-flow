'use strict';

// G10 -- flag-index completeness. docs/flags.md hand-transcribes every skill's argument-hint into
// a flag-first table; without a guard that table drifts silently the moment a skill's flags
// change -- a renamed or removed flag leaves a stale row behind, and a newly added flag never
// gets one, and nothing else in this repo would notice either failure mode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, skillFiles } = require('./_shared');

const FLAG_INDEX = path.join(REPO, 'docs', 'flags.md');

/** Same extraction G8 already uses for argument-hint -> flag list: read the frontmatter's
 * argument-hint string, then pull every `--flag` token out of it. */
function argumentHintFlags(file) {
  const hint = fs.readFileSync(file, 'utf8').match(/^argument-hint:\s*"?(.*?)"?\s*$/m)?.[1];
  if (!hint) return new Set();
  return new Set([...hint.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
}

/** Every (flag, skill) pair currently declared by a skill's own argument-hint. */
function declaredPairs() {
  const pairs = new Set();
  for (const { name, file } of skillFiles()) {
    for (const flag of argumentHintFlags(file)) pairs.add(`${flag} ${name}`);
  }
  return pairs;
}

/** Every (flag, skill) row docs/flags.md currently carries. */
function indexedPairs() {
  const text = fs.readFileSync(FLAG_INDEX, 'utf8');
  const pairs = new Set();
  for (const [, flag, skill] of text.matchAll(/^\| (--[a-z0-9-]+) \| ([a-z][a-z-]*) \|/gm)) {
    pairs.add(`${flag} ${skill}`);
  }
  return pairs;
}

test('G10: every argument-hint flag has a matching docs/flags.md row', () => {
  const indexed = indexedPairs();
  const missing = [...declaredPairs()]
    .filter((pair) => !indexed.has(pair))
    .map((pair) => pair.split(' ').join(' -> '))
    .sort();
  assert.deepEqual(missing, [],
    `these skill flags have no docs/flags.md row:\n  ${missing.join('\n  ')}`);
});

test('G10: every docs/flags.md row matches a flag the skill currently declares', () => {
  const declared = declaredPairs();
  const stale = [...indexedPairs()]
    .filter((pair) => !declared.has(pair))
    .map((pair) => pair.split(' ').join(' -> '))
    .sort();
  assert.deepEqual(stale, [],
    `docs/flags.md has rows for flags no skill's argument-hint declares any more:\n  ${stale.join('\n  ')}`);
});
