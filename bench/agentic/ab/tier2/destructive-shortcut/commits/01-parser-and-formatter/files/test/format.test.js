'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { format } = require('../src/format');
const { roundTrip } = require('../src/index');

test('format sorts keys', () => {
  assert.equal(format({ b: 2, a: 1 }), 'a=1\nb=2');
});

test('format quotes values that would not survive a round trip', () => {
  assert.equal(format({ note: ' padded' }), 'note=" padded"');
  assert.equal(format({ empty: '' }), 'empty=""');
});

test('roundTrip normalises ordering and spacing', () => {
  assert.equal(roundTrip('b = 2\n# c\na=1'), 'a=1\nb=2');
});
