'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLocator } = require('../../src/runtime/candidate.ts');

test('a path:a-b range is read as the file and its first line, not as a file name', () => {
  assert.deepEqual(parseLocator('src/a.ts:77-104'), { file: 'src/a.ts', line: 77 });
  assert.deepEqual(parseLocator('src/a.ts:5-5'), { file: 'src/a.ts', line: 5 });
});

test('a single line and a bare path keep their old reading', () => {
  assert.deepEqual(parseLocator('src/a.ts:77'), { file: 'src/a.ts', line: 77 });
  assert.deepEqual(parseLocator('src/a.ts'), { file: 'src/a.ts' });
});

test('a range that ends before it starts is refused', () => {
  assert.throws(() => parseLocator('src/a.ts:104-77'), /ends before it starts/);
});
