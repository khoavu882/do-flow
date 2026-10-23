'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadVerificationRegistry, reviewDepthPolicy } = require('../../src/runtime/verification/registry.ts');

const REPO = path.resolve(__dirname, '../..');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/verification.json'), 'utf8'));

function load(mutate) {
  const registry = structuredClone(SHIPPED);
  if (mutate) mutate(registry);
  return () => loadVerificationRegistry({ registry });
}

test('095b IC-003: the shipped reviewDepth block loads and the accessor returns it', () => {
  const registry = loadVerificationRegistry({ repoRoot: REPO });
  const policy = reviewDepthPolicy(registry);
  assert.deepEqual(Object.keys(policy.depths), ['single', 'deep']);
  assert.equal(policy.depths.single.seats, 1);
  assert.equal(policy.depths.deep.seats, 2);
  assert.deepEqual(policy.singleRisks, ['LOW']);
  assert.deepEqual(policy.lightPaths, ['docs/', 'README.md', 'CHANGELOG.md']);
  assert.ok(policy.singleRisks.every((risk) => Object.hasOwn(registry.riskLevels, risk)));
});

test('095b IC-003: the accessor refuses a registry without the block', () => {
  assert.throws(() => reviewDepthPolicy({}), /verification\.json is invalid: reviewDepth/);
  assert.throws(() => reviewDepthPolicy(null), /verification\.json is invalid: reviewDepth/);
});

const INVALID = [
  ['block missing', (r) => { delete r.reviewDepth; }, /reviewDepth/],
  ['block not an object', (r) => { r.reviewDepth = []; }, /reviewDepth/],
  ['deep missing', (r) => { delete r.reviewDepth.depths.deep; }, /reviewDepth\.depths/],
  ['single missing', (r) => { delete r.reviewDepth.depths.single; }, /reviewDepth\.depths/],
  ['extra depth key', (r) => { r.reviewDepth.depths.medium = { seats: 3 }; }, /reviewDepth\.depths/],
  ['single seats equal to deep', (r) => { r.reviewDepth.depths.single.seats = 2; }, /single.*below.*deep/],
  ['single seats above deep', (r) => { r.reviewDepth.depths.single.seats = 3; }, /single.*below.*deep/],
  ['seats zero', (r) => { r.reviewDepth.depths.single.seats = 0; }, /seats/],
  ['seats fractional', (r) => { r.reviewDepth.depths.deep.seats = 2.5; }, /seats/],
  ['seats a string', (r) => { r.reviewDepth.depths.deep.seats = '2'; }, /seats/],
  ['singleRisks not an array', (r) => { r.reviewDepth.singleRisks = 'LOW'; }, /singleRisks/],
  ['singleRisks holds URGENT', (r) => { r.reviewDepth.singleRisks = ['LOW', 'URGENT']; }, /singleRisks.*URGENT/],
  ['lightPaths empty', (r) => { r.reviewDepth.lightPaths = []; }, /lightPaths/],
  ['lightPaths empty string', (r) => { r.reviewDepth.lightPaths = ['docs/', '']; }, /lightPaths/],
  ['lightPaths with a .. segment', (r) => { r.reviewDepth.lightPaths = ['docs/../src/']; }, /lightPaths.*\.\./],
  ['lightPaths bare ..', (r) => { r.reviewDepth.lightPaths = ['..']; }, /lightPaths.*\.\./],
  ['lightPaths leading slash', (r) => { r.reviewDepth.lightPaths = ['/docs/']; }, /lightPaths.*\//],
  ['lightPaths leading ./ (C-11)', (r) => { r.reviewDepth.lightPaths = ['./docs/']; }, /lightPaths.*\.\//],
  ['lightPaths bare ./ (C-11)', (r) => { r.reviewDepth.lightPaths = ['docs/', './']; }, /lightPaths.*\.\//],
  ['lightPaths with a backslash (C-11)', (r) => { r.reviewDepth.lightPaths = ['docs\\']; }, /lightPaths.*backslash/],
  ['an unknown key in the reviewDepth block (C-11)', (r) => { r.reviewDepth.lightPath = ['docs/']; }, /reviewDepth.*lightPath/],
  ['an unknown key in a depths entry (C-11)', (r) => { r.reviewDepth.depths.single.weight = 1; }, /reviewDepth\.depths\.single.*weight/],
];

for (const [name, mutate, message] of INVALID) {
  test(`095b IC-003: load refuses ${name}`, () => {
    assert.throws(load(mutate), message);
  });
}

test('095b IC-003: a ".." inside a file name is not a ".." segment', () => {
  assert.doesNotThrow(load((r) => { r.reviewDepth.lightPaths = ['docs/', 'notes..md']; }));
});
