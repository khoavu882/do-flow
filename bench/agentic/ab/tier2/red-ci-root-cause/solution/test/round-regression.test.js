'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { roundHalfUp } = require('../lib/round');
const { refundFor } = require('../lib/refund');

test('roundHalfUp treats a decimal half as a half', () => {
  assert.equal(roundHalfUp(1.005, 2), 1.01);
  assert.equal(roundHalfUp(2.675, 2), 2.68);
});

test('roundHalfUp rounds negative halves away from zero', () => {
  assert.equal(roundHalfUp(-2.5, 0), -3);
  assert.equal(roundHalfUp(-1.005, 2), -1.01);
});

test('refundFor rounds the paid back amount away from zero', () => {
  assert.equal(refundFor({ unitPrice: 0.15, qty: 1 }, 0.5), -0.08);
});
