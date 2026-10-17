'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fuseRankedCandidates, normalizeCodeCandidates } = require('../../src/runtime/knowledge/hybrid.ts');

test('strict fusion normalizes full spans, deduplicates each provider vote and retains every origin', () => {
  const lists = [
    { provider: 'native.rg', capability: 'code.semantic-search', candidates: [
      { locator: { file: 'src/a.js', line: 4, endLine: 7 } },
      { locator: { file: 'src/a.js', line: 4, endLine: 7 } },
      { locator: { file: 'src/a.js', line: 4, endLine: 8 } },
    ] },
    { provider: 'semble.search', capability: 'code.semantic-search', candidates: [
      { locator: { file: 'src/a.js', line: 4, endLine: 7 } },
    ] },
  ];
  const result = fuseRankedCandidates({ rankedLists: lists, corpusIdentity: 'corpus-v1' });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].origins.length, 3);
  assert.equal(result.candidates[0].rrfScore, 1 / 61 + 1 / 61);
  assert.notEqual(result.candidates[0].id, result.candidates[1].id);
});

test('strict normalizer rejects traversal and invalid full spans', () => {
  const result = normalizeCodeCandidates([{ locator: '../escape.js:1' }, { locator: { file: 'ok.js', line: 0, endLine: 1 } }]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected.length, 2);
});
