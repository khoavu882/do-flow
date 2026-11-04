'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/parse');

test('parse reads key=value lines', () => {
  assert.deepEqual(parse('name=kv\nmode=fast'), { name: 'kv', mode: 'fast' });
});

test('parse skips blank lines and comments', () => {
  assert.deepEqual(parse('# header\n\na=1\n  \n# tail\nb=2'), { a: '1', b: '2' });
});

test('parse splits on the first equals sign only', () => {
  assert.deepEqual(parse('url=http://x/?a=b'), { url: 'http://x/?a=b' });
});

test('parse trims keys and values and accepts CRLF', () => {
  assert.deepEqual(parse(' a = 1 \r\nb=2\r\n'), { a: '1', b: '2' });
});

test('parse rejects a line without a key', () => {
  assert.throws(() => parse('=oops'), SyntaxError);
  assert.throws(() => parse('no equals'), SyntaxError);
});
