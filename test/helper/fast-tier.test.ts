'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fastFiles, testFiles } = require('./fast-tier.ts');

test('the fast tier keeps every guard and leaves out e2e, bench and files that start processes', () => {
  const all = testFiles();
  const fast = new Set(fastFiles(all));
  assert.ok(all.filter((rel: string) => rel.startsWith('test/guards/')).every((rel: string) => fast.has(rel)), 'every guard runs');
  assert.ok(![...fast].some((rel) => /^test\/(e2e|bench)\//.test(rel)), 'no e2e or bench file runs');
  assert.ok(all.some((rel: string) => !fast.has(rel) && !/^test\/(e2e|bench)\//.test(rel)), 'process-starting files elsewhere are left out');
  assert.ok(fast.size > 100 && fast.size < all.length, 'the tier is a real subset');
});
