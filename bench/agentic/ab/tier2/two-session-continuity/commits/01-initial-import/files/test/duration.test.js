'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration } = require('../lib/duration');

test('parseDuration reads single units', () => {
  assert.equal(parseDuration('5s'), 5000);
  assert.equal(parseDuration('2d'), 2 * 24 * 60 * 60 * 1000);
});

test('parseDuration adds up combined units', () => {
  assert.equal(parseDuration('1h30m'), 90 * 60 * 1000);
});

test('parseDuration rejects text it cannot read', () => {
  assert.throws(() => parseDuration('soon'), RangeError);
  assert.throws(() => parseDuration('5s later'), RangeError);
});
