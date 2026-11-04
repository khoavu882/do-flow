'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { streamEntries } = require('../stream');

test('streamEntries yields one entry per line', () => {
  assert.deepEqual([...streamEntries('a=1\nb=2')], [['a', '1'], ['b', '2']]);
});
