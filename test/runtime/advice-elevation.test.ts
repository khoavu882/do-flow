'use strict';

// Elevation invariant: advice only raises. The verify-risk order comes from
// core/registry/verification.json, so CRITICAL ranks above HIGH.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyElevationInvariant,
  VERIFY_RISK_ORDER,
} = require('../../src/runtime/advice/elevation.ts');
const verification = require('../../core/registry/verification.json');

describe('verify-risk order from core/registry/verification.json', () => {
  test('ranks every registry risk level in registry order', () => {
    const levels = Object.keys(verification.riskLevels).map((k) => k.toLowerCase());
    assert.deepEqual(Object.keys(VERIFY_RISK_ORDER), levels);
    levels.forEach((level, i) => assert.equal(VERIFY_RISK_ORDER[level], i));
  });

  test('HIGH to CRITICAL is an elevation', () => {
    const res = applyElevationInvariant('verify-risk', 'HIGH', 'CRITICAL');
    assert.equal(res.effectiveDecision, 'CRITICAL');
    assert.equal(res.elevated, true);
  });

  test('LOW to MEDIUM is an elevation, matched case-insensitively', () => {
    const res = applyElevationInvariant('verify-risk', 'LOW', 'medium');
    assert.equal(res.effectiveDecision, 'medium');
    assert.equal(res.elevated, true);
  });

  test('CRITICAL to LOW never lowers', () => {
    const res = applyElevationInvariant('verify-risk', 'CRITICAL', 'LOW');
    assert.equal(res.effectiveDecision, 'CRITICAL');
    assert.equal(res.elevated, false);
  });

  test('an unknown advisor value is not an elevation', () => {
    const res = applyElevationInvariant('verify-risk', 'HIGH', 'SEVERE');
    assert.equal(res.effectiveDecision, 'HIGH');
    assert.equal(res.elevated, false);
  });
});

describe('kinds without a lattice fall back to the static pick', () => {
  test('autopilot is not elevated', () => {
    const res = applyElevationInvariant('autopilot', 'continue', 'pause');
    assert.equal(res.effectiveDecision, 'continue');
    assert.equal(res.elevated, false);
  });
});
