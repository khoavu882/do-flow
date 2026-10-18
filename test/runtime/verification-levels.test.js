'use strict';

// 088 G.1 (IC-014, IC-018; DD-1): verification levels as data over tiers with levelOf and v0Applies.
//
// Verifies:
// - Every risk level is partitioned into exactly one of L1..L3.
// - L0 tiers lead every risk level's requiredTiers in order.
// - levelOf and v0Applies mapping for each risk level.
// - HIGH and CRITICAL compiled contracts on the fixture match levels-golden.json.
// - Compiled contracts contain no failedFirst or shared keys.
// - Negative controls: policy.v0.levels with L3 fails registry load; moving HIGH to L2 fails the guard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadVerificationRegistry, levelOf, v0Applies } = require('../../src/runtime/verification/registry.ts');
const { VerificationEngine } = require('../../src/runtime/verification/engine.ts');

const REPO = path.resolve(__dirname, '../..');
const GOLDEN_PATH = path.join(REPO, 'test/fixtures/verification/levels-golden.json');

const FIXTURE_PLAN = [
  '# Plan',
  '',
  '```doflow-verification',
  JSON.stringify({
    parse: 'node -e 0',
    build: 'node -e 0',
    typecheck: null,
    lint: 'node -e 0',
    test: 'node -e 0',
    testTargeted: 'node -e 0 {pattern}',
  }),
  '```',
].join('\n');

test('every risk level is in exactly one of L1..L3', () => {
  const registry = loadVerificationRegistry();
  const definedRisks = Object.keys(registry.riskLevels);
  const seen = new Map();

  for (const lvl of ['L1', 'L2', 'L3']) {
    const list = registry.levels[lvl]?.riskLevels || [];
    assert.ok(Array.isArray(list) && list.length > 0, `level ${lvl} must have non-empty riskLevels`);
    for (const r of list) {
      assert.ok(!seen.has(r), `risk '${r}' is in both ${seen.get(r)} and ${lvl}`);
      seen.set(r, lvl);
    }
  }

  for (const r of definedRisks) {
    assert.ok(seen.has(r), `risk '${r}' is missing from L1..L3`);
  }
  assert.equal(seen.size, definedRisks.length);
});

test('L0 tiers exist and lead every risk level requiredTiers', () => {
  const registry = loadVerificationRegistry();
  const l0Tiers = registry.levels.L0.tiers;
  assert.deepEqual(l0Tiers, ['parse', 'build']);

  for (const [risk, def] of Object.entries(registry.riskLevels)) {
    const req = def.requiredTiers;
    assert.ok(req.length >= l0Tiers.length, `risk level ${risk} has fewer requiredTiers than L0`);
    assert.deepEqual(
      req.slice(0, l0Tiers.length),
      l0Tiers,
      `risk level ${risk} requiredTiers must start with L0 tiers [${l0Tiers.join(', ')}]`,
    );
  }
});

test('levelOf maps risk levels to L1..L3, and null for unknown/null', () => {
  const registry = loadVerificationRegistry();

  assert.equal(levelOf(registry, 'LOW'), 'L1');
  assert.equal(levelOf(registry, 'MEDIUM'), 'L2');
  assert.equal(levelOf(registry, 'HIGH'), 'L3');
  assert.equal(levelOf(registry, 'CRITICAL'), 'L3');

  assert.equal(levelOf(registry, null), null);
  assert.equal(levelOf(registry, undefined), null);
  assert.equal(levelOf(registry, 'UNKNOWN'), null);
  assert.equal(levelOf(null, 'LOW'), null);
});

test('v0Applies returns true for L1/L2 (LOW/MEDIUM) and false for L3 (HIGH/CRITICAL)', () => {
  const registry = loadVerificationRegistry();

  assert.equal(v0Applies(registry, 'LOW'), true);
  assert.equal(v0Applies(registry, 'MEDIUM'), true);
  assert.equal(v0Applies(registry, 'HIGH'), false);
  assert.equal(v0Applies(registry, 'CRITICAL'), false);

  assert.equal(v0Applies(registry, null), false);
  assert.equal(v0Applies(registry, undefined), false);
  assert.equal(v0Applies(registry, 'UNKNOWN'), false);
});

test('HIGH and CRITICAL compiled contracts on the fixture equal levels-golden.json', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

  const engine = new VerificationEngine({
    cwd: '/fixture',
    repoRoot: REPO,
    clock: () => 1792000000000,
  });

  const high = engine.compileContract({ taskId: 'T-1', riskLevel: 'HIGH', planText: FIXTURE_PLAN });
  const critical = engine.compileContract({ taskId: 'T-1', riskLevel: 'CRITICAL', planText: FIXTURE_PLAN });

  assert.deepEqual(high, golden.HIGH);
  assert.deepEqual(critical, golden.CRITICAL);
});

test('HIGH and CRITICAL compiled contracts contain no failedFirst or shared keys', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const raw = JSON.stringify(golden);

  assert.equal(raw.includes('failedFirst'), false, 'golden must have no failedFirst key');
  assert.equal(raw.includes('shared'), false, 'golden must have no shared key');
});

test('negative control: scratch registry with policy.v0.levels: ["L3"] fails registry load', () => {
  const registry = loadVerificationRegistry();
  const bad = JSON.parse(JSON.stringify(registry));
  bad.policy.v0.levels = ['L3'];

  assert.throws(
    () => loadVerificationRegistry({ registry: bad }),
    /policy\.v0\.levels must be a subset of \['L1', 'L2'\]/,
  );
});

test('negative control: registry with L0 tiers not leading requiredTiers fails registry load', () => {
  const registry = loadVerificationRegistry();
  const bad = JSON.parse(JSON.stringify(registry));
  bad.levels.L0.tiers = ['build', 'parse'];

  assert.throws(
    () => loadVerificationRegistry({ registry: bad }),
    /must begin with L0 tiers/,
  );
});

test('negative control: registry with unassigned or duplicate risk level fails registry load', () => {
  const registry = loadVerificationRegistry();
  const bad = JSON.parse(JSON.stringify(registry));
  bad.levels.L1.riskLevels = []; // LOW is not in L1 anymore

  assert.throws(
    () => loadVerificationRegistry({ registry: bad }),
    /risk level 'LOW' must be assigned to exactly one of L1\.\.L3/,
  );
});

