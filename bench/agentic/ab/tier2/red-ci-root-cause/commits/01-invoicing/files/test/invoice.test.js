'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lineTotal, invoiceTotal } = require('../lib/invoice');

test('lineTotal multiplies price by quantity', () => {
  assert.equal(lineTotal({ unitPrice: 4.5, qty: 2 }), 9);
});

test('invoiceTotal adds the lines and the tax', () => {
  const lines = [{ unitPrice: 10, qty: 2 }, { unitPrice: 5, qty: 1 }];
  assert.equal(invoiceTotal(lines, 0.1), 27.5);
});

test('lineTotal rounds a half cent away from zero', () => {
  assert.equal(lineTotal({ unitPrice: 1.005, qty: 3 }), 3.02);
});
