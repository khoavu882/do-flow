'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { roundHalfUp } = require(path.join(process.cwd(), 'lib/round.js'));
const { refundFor } = require(path.join(process.cwd(), 'lib/refund.js'));

test('roundHalfUp is correct on a table of positive and negative inputs', () => {
  const table = [
    [1.005, 2, 1.01],
    [2.675, 2, 2.68],
    [1.255, 2, 1.26],
    [0.285, 2, 0.29],
    [8.345, 2, 8.35],
    [123456.785, 2, 123456.79],
    [1.45, 1, 1.5],
    [0.5, 0, 1],
    [10, 2, 10],
    [-2.5, 0, -3],
    [-0.5, 0, -1],
    [-1.005, 2, -1.01],
    [-2.675, 2, -2.68],
    [-0.125, 2, -0.13],
    [-1.45, 1, -1.5],
    [-10, 2, -10],
  ];
  for (const [value, digits, expected] of table) {
    assert.equal(roundHalfUp(value, digits), expected, `roundHalfUp(${value}, ${digits})`);
  }
});

test('refundFor gives the right negative amounts', () => {
  assert.equal(refundFor({ unitPrice: 1.005, qty: 1 }, 1), -1.01);
  assert.equal(refundFor({ unitPrice: 0.15, qty: 1 }, 0.5), -0.08);
  assert.equal(refundFor({ unitPrice: 2.675, qty: 1 }, 1), -2.68);
  assert.equal(refundFor({ unitPrice: 3, qty: 1 }, 0.5), -1.5);
  assert.equal(refundFor({ unitPrice: 19.99, qty: 3 }, 1), -59.97);
});
