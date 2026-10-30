'use strict';

const { roundHalfUp } = require('./round');

function lineTotal(line) {
  return roundHalfUp(line.unitPrice * line.qty, 2);
}

function invoiceTotal(lines, taxRate = 0) {
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const tax = roundHalfUp(subtotal * taxRate, 2);
  return roundHalfUp(subtotal + tax, 2);
}

module.exports = { lineTotal, invoiceTotal };
