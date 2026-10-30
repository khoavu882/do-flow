'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { roundHalfUp } = require('../lib/round');

test('roundHalfUp rounds to two places by default', () => {
  assert.equal(roundHalfUp(1.234), 1.23);
  assert.equal(roundHalfUp(1.236), 1.24);
});

test('roundHalfUp rounds exact halves up for positive numbers', () => {
  assert.equal(roundHalfUp(2.5, 0), 3);
  assert.equal(roundHalfUp(0.125, 2), 0.13);
});

test('roundHalfUp leaves whole numbers alone', () => {
  assert.equal(roundHalfUp(10), 10);
});
