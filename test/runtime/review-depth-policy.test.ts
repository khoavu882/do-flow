'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadVerificationRegistry, reviewDepthPolicy } = require('../../src/runtime/verification/registry.ts');

const REPO = path.resolve(__dirname, '../..');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/verification.json'), 'utf8'));

function load(mutate: any) {
  const registry = structuredClone(SHIPPED);
  if (mutate) mutate(registry);
  return () => loadVerificationRegistry({ registry });
}

test('095b IC-003: the shipped reviewDepth block loads and the accessor returns it', () => {
  const registry = loadVerificationRegistry({ repoRoot: REPO });
  const policy = reviewDepthPolicy(registry);
  assert.deepEqual(Object.keys(policy).sort(), ['description', 'lightPaths', 'singleRisks']);
  assert.deepEqual(policy.singleRisks, ['LOW']);
  assert.deepEqual(policy.lightPaths, ['docs/', 'README.md', 'CHANGELOG.md']);
  assert.ok(policy.singleRisks.every((risk: any) => Object.hasOwn(registry.riskLevels, risk)));
});

test('095b IC-003: the accessor refuses a registry without the block', () => {
  assert.throws(() => reviewDepthPolicy({}), /verification\.json is invalid: reviewDepth/);
  assert.throws(() => reviewDepthPolicy(null), /verification\.json is invalid: reviewDepth/);
});

const INVALID: any = [
  ['block missing', (r: any) => { delete r.reviewDepth; }, /reviewDepth/],
  ['block not an object', (r: any) => { r.reviewDepth = []; }, /reviewDepth/],
  // 119 D-4: the seat counts live in core/registry/protocols.json, so the old map is an unknown key.
  ['a leftover depths key', (r: any) => { r.reviewDepth.depths = { single: { seats: 1 }, deep: { seats: 2 } }; }, /reviewDepth has an unknown key 'depths'/],
  ['an empty depths key', (r: any) => { r.reviewDepth.depths = {}; }, /unknown key 'depths'/],
  ['a seats key', (r: any) => { r.reviewDepth.seats = 2; }, /unknown key 'seats'/],
  ['singleRisks not an array', (r: any) => { r.reviewDepth.singleRisks = 'LOW'; }, /singleRisks/],
  ['singleRisks holds URGENT', (r: any) => { r.reviewDepth.singleRisks = ['LOW', 'URGENT']; }, /singleRisks.*URGENT/],
  ['lightPaths empty', (r: any) => { r.reviewDepth.lightPaths = []; }, /lightPaths/],
  ['lightPaths empty string', (r: any) => { r.reviewDepth.lightPaths = ['docs/', '']; }, /lightPaths/],
  ['lightPaths with a .. segment', (r: any) => { r.reviewDepth.lightPaths = ['docs/../src/']; }, /lightPaths.*\.\./],
  ['lightPaths bare ..', (r: any) => { r.reviewDepth.lightPaths = ['..']; }, /lightPaths.*\.\./],
  ['lightPaths leading slash', (r: any) => { r.reviewDepth.lightPaths = ['/docs/']; }, /lightPaths.*\//],
  ['lightPaths leading ./ (C-11)', (r: any) => { r.reviewDepth.lightPaths = ['./docs/']; }, /lightPaths.*\.\//],
  ['lightPaths bare ./ (C-11)', (r: any) => { r.reviewDepth.lightPaths = ['docs/', './']; }, /lightPaths.*\.\//],
  ['lightPaths with a backslash (C-11)', (r: any) => { r.reviewDepth.lightPaths = ['docs\\']; }, /lightPaths.*backslash/],
  ['an unknown key in the reviewDepth block (C-11)', (r: any) => { r.reviewDepth.lightPath = ['docs/']; }, /reviewDepth.*lightPath/],
];

for (const [name, mutate, message] of INVALID) {
  test(`095b IC-003: load refuses ${name}`, () => {
    assert.throws(load(mutate), message);
  });
}

test('095b IC-003: a ".." inside a file name is not a ".." segment', () => {
  assert.doesNotThrow(load((r: any) => { r.reviewDepth.lightPaths = ['docs/', 'notes..md']; }));
});
