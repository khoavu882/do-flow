'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateError, parseDate, isWithin } = require('../lib/dates');

test('a date without a time is midnight UTC', () => {
  assert.equal(parseDate('2026-01-01').toISOString(), '2026-01-01T00:00:00.000Z');
});

test('a date with an offset keeps its instant', () => {
  assert.equal(parseDate('2026-01-01T00:30:00+01:00').toISOString(), '2025-12-31T23:30:00.000Z');
});

test('garbage and impossible days throw DateError', () => {
  assert.throws(() => parseDate('tomorrow'), DateError);
  assert.throws(() => parseDate('2026-02-30'), DateError);
});

test('isWithin includes both ends', () => {
  const from = parseDate('2026-01-01');
  const to = parseDate('2026-01-31');
  assert.equal(isWithin(from, from, to), true);
  assert.equal(isWithin(to, from, to), true);
  assert.equal(isWithin(parseDate('2026-02-01'), from, to), false);
});
