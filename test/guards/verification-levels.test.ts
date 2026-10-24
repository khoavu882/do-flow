'use strict';

// G52 — verification levels (feature 088, IC-014, IC-018; DD-1).
//
// `core/registry/verification.json` declares verification levels L0..L3 as data over tiers:
// - L0 defines the parse and build prefix that leads every risk level's requiredTiers.
// - Each risk level belongs to exactly one of L1..L3.
// - L3 retains the pre-088 verification contract for HIGH and CRITICAL risks (plus release/CI).
// - policy.v0.levels is restricted to a subset of {L1, L2}.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { loadVerificationRegistry } = require('../../src/runtime/verification/registry.ts');

const REGISTRY_FILE = 'core/registry/verification.json';

/**
 * Validates verification levels against IC-014 and DD-1 structural rules.
 * Pure function returning an array of error messages.
 */
function checkVerificationLevels(registry: any): any {
  const errors: any = [];
  const at = (where: any, message: any) => errors.push(`${REGISTRY_FILE} ${where}: ${message}`);

  if (!registry || typeof registry !== 'object') {
    at('root', 'must be an object');
    return errors;
  }

  const tiers = Array.isArray(registry.tiers) ? registry.tiers : [];
  const tierIds: any = new Set(tiers.map((t: any) => t && t.id).filter(Boolean));

  const riskLevels = registry.riskLevels || {};
  const riskKeys = Object.keys(riskLevels);

  if (!registry.levels || typeof registry.levels !== 'object') {
    at('levels', 'must be an object');
    return errors;
  }

  // L0 validation
  const l0 = registry.levels.L0;
  if (!l0 || typeof l0 !== 'object') {
    at('levels.L0', 'must be an object');
  } else {
    if (!Array.isArray(l0.tiers) || l0.tiers.length === 0) {
      at('levels.L0.tiers', 'must be a non-empty array of tier IDs');
    } else {
      for (const t of l0.tiers) {
        if (!tierIds.has(t)) {
          at('levels.L0.tiers', `tier '${t}' does not exist in tiers`);
        }
      }
      // L0 tiers must lead every risk level's requiredTiers
      for (const [risk, def] of Object.entries(riskLevels)) {
        const req = Array.isArray(def.requiredTiers) ? def.requiredTiers : [];
        for (let i = 0; i < l0.tiers.length; i++) {
          if (req[i] !== l0.tiers[i]) {
            at(`riskLevels.${risk}.requiredTiers`, `must begin with L0 tiers [${l0.tiers.join(', ')}]`);
            break;
          }
        }
      }
    }
  }

  // L1..L3 partition validation
  const levelNames: any = ['L1', 'L2', 'L3'];
  const riskToLevel: any = new Map();

  for (const lvl of levelNames) {
    const entry = registry.levels[lvl];
    if (!entry || typeof entry !== 'object') {
      at(`levels.${lvl}`, 'must be an object');
      continue;
    }
    if (!Array.isArray(entry.riskLevels)) {
      at(`levels.${lvl}.riskLevels`, 'must be an array');
      continue;
    }
    for (const r of entry.riskLevels) {
      if (!riskLevels[r]) {
        at(`levels.${lvl}.riskLevels`, `references unknown risk level '${r}'`);
      }
      if (riskToLevel.has(r)) {
        at(`levels.${lvl}.riskLevels`, `risk level '${r}' is declared in multiple levels ('${riskToLevel.get(r)}' and '${lvl}')`);
      } else {
        riskToLevel.set(r, lvl);
      }
    }
  }

  for (const r of riskKeys) {
    if (!riskToLevel.has(r)) {
      at('levels', `risk level '${r}' is not declared in any of L1..L3`);
    }
  }

  // L3 must contain at least HIGH and CRITICAL (DD-1)
  const l3Risks: any = new Set(registry.levels?.L3?.riskLevels || []);
  for (const requiredL3 of ['HIGH', 'CRITICAL']) {
    if (!l3Risks.has(requiredL3)) {
      at('levels.L3.riskLevels', `must include '${requiredL3}'`);
    }
  }

  // policy.v0.levels validation
  const v0Levels = registry?.policy?.v0?.levels;
  if (!Array.isArray(v0Levels)) {
    at('policy.v0.levels', 'must be an array');
  } else {
    const allowed: any = new Set(['L1', 'L2']);
    for (const lvl of v0Levels) {
      if (!allowed.has(lvl)) {
        at('policy.v0.levels', `must be a subset of ['L1', 'L2']: found '${lvl}'`);
      }
    }
  }

  return errors;
}

// --- Guard test ---------------------------------------------------------------------------------

test('G52: verification.json levels are data over tiers and satisfy IC-014', () => {
  const regPath = path.join(REPO, REGISTRY_FILE);
  const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  const errors = checkVerificationLevels(registry);
  assert.deepEqual(errors, []);
});

// --- Self-tests (negative controls) ------------------------------------------------------------

test('G52 self-test: a scratch registry with policy.v0.levels: ["L3"] fails both registry load and the guard', () => {
  const regPath = path.join(REPO, REGISTRY_FILE);
  const bad = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  bad.policy.v0.levels = ['L3'];

  // Registry load error
  assert.throws(
    () => loadVerificationRegistry({ registry: bad }),
    /policy\.v0\.levels must be a subset of \['L1', 'L2'\]/,
  );

  // Guard failure
  const errors = checkVerificationLevels(bad);
  assert.ok(errors.some((e: any) => e.includes("policy.v0.levels: must be a subset of ['L1', 'L2']: found 'L3'")));
});

test('G52 self-test: moving HIGH into L2 fails the guard', () => {
  const regPath = path.join(REPO, REGISTRY_FILE);
  const bad = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  bad.levels.L2.riskLevels.push('HIGH');
  bad.levels.L3.riskLevels = bad.levels.L3.riskLevels.filter((r: any) => r !== 'HIGH');

  const errors = checkVerificationLevels(bad);
  assert.ok(errors.some((e: any) => e.includes("levels.L3.riskLevels: must include 'HIGH'")));
});

test('G52 self-test: missing or disordered L0 tiers fails both registry load and the guard', () => {
  const regPath = path.join(REPO, REGISTRY_FILE);
  const bad = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  bad.levels.L0.tiers = ['build', 'parse']; // swapped order

  assert.throws(
    () => loadVerificationRegistry({ registry: bad }),
    /must begin with L0 tiers/,
  );

  const errors = checkVerificationLevels(bad);
  assert.ok(errors.some((e: any) => e.includes('must begin with L0 tiers')));
});

test('G52 self-test: duplicate risk level across levels fails both registry load and the guard', () => {
  const regPath = path.join(REPO, REGISTRY_FILE);
  const bad = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  bad.levels.L2.riskLevels.push('LOW'); // LOW now in L1 and L2

  assert.throws(
    () => loadVerificationRegistry({ registry: bad }),
    /declared in multiple levels/,
  );

  const errors = checkVerificationLevels(bad);
  assert.ok(errors.some((e: any) => e.includes('declared in multiple levels')));
});

test('G52 self-test: unknown risk level in levels fails both registry load and the guard', () => {
  const regPath = path.join(REPO, REGISTRY_FILE);
  const bad = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  bad.levels.L1.riskLevels.push('NONEXISTENT');

  assert.throws(
    () => loadVerificationRegistry({ registry: bad }),
    /unknown risk level 'NONEXISTENT'/,
  );

  const errors = checkVerificationLevels(bad);
  assert.ok(errors.some((e: any) => e.includes("references unknown risk level 'NONEXISTENT'")));
});

module.exports = { checkVerificationLevels };
