'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tableViolations } = require('../../src/helper/toml');

test('a table opened twice is a duplicate-table, whether the first opening was a header or dotted keys', () => {
  assert.deepEqual(tableViolations('[features]\na = 1\n[features]\nb = 2\n'), [{ kind: 'duplicate-table', table: 'features', line: 3 }]);
  assert.deepEqual(tableViolations('features.x = 1\n[features]\n'), [{ kind: 'duplicate-table', table: 'features', line: 2 }]);
});

test('a path that is both a value and a table is a table-and-value', () => {
  assert.deepEqual(tableViolations('features = 1\n[features]\n'), [{ kind: 'table-and-value', table: 'features', line: 2 }]);
  assert.deepEqual(tableViolations('a = 1\na.b = 2\n'), [{ kind: 'table-and-value', table: 'a', line: 2 }]);
});

test('a parent table opened after its sub-table is valid', () => {
  assert.deepEqual(tableViolations('[features.sub]\nx = 1\n[features]\ny = 2\n'), []);
});

test('the outputs DoFlow writes for an empty [features] header and for a root dotted entry are valid', () => {
  assert.deepEqual(tableViolations('[features]\nhooks = true # DoFlow added this to your [features] table\n'), []);
  assert.deepEqual(tableViolations('features.x = 1\nfeatures.hooks = true\n'), []);
});

test('throws what parseToml throws', () => {
  assert.throws(() => tableViolations('[features\n'), /Malformed or unsupported TOML table on line 1/);
});
