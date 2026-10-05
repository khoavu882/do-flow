'use strict';

// The feature-status derivation (IC-021) and the release preview (IC-020) checked against a reference
// of the per-feature semantics, over a family of generated histories. The reference, the generator and
// the comparison live in test/helper/lifecycle-derivation-reference.js. This file compares the
// even-numbered histories and checks that the family covers every listed history kind;
// lifecycle-derivation-differential-odd.test.js compares the odd ones, so `node --test` runs the
// halves in parallel. Services run in process under a scratch HOME, XDG_CONFIG_HOME and git config
// (DEC-041).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratch } = require('../helper/scratch-env');
const { compareHistories, REQUIRED, OUTCOMES, HISTORIES } = require('../helper/lifecycle-derivation-reference');

const scratch = createScratch('doflow-differential-even-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

test(`differential: the even-numbered of ${HISTORIES} generated histories derive the same statuses and release preview as the reference`, () => {
  const { covered, outcomes } = compareHistories(scratch, { part: 0, parts: 2 });
  const missing = REQUIRED.filter((c) => !covered.has(c));
  assert.deepEqual(missing, [], `every listed history kind is generated at least once (got ${JSON.stringify(Object.fromEntries(covered))})`);
  assert.deepEqual(OUTCOMES.filter((o) => !outcomes.has(o)), [], `the half is not trivial; outcomes seen: ${[...outcomes].sort().join(' ')}`);
});
