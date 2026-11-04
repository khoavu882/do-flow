'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../parse');

test('parse keeps duplicate keys as entries', () => {
  assert.deepEqual(parse('a=1\na=2'), { a: '2' });
});
