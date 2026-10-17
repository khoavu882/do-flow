'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectCodeEvidence } = require('../../src/runtime/knowledge/code-evidence.ts');

test('code evidence projection emits a separate score-free item for every validated origin', () => {
  const candidate = {
    locator: { file: 'src/auth.js', line: 8, endLine: 10 },
    provider: 'semble.search', capability: 'code.semantic-search',
    rrfScore: 0.03, rank: 1, score: 0.8,
    origins: [
      { provider: 'semble.search', capability: 'code.semantic-search', retrievalAttemptRef: 'ra-sem' },
      { provider: 'native.rg', capability: 'code.semantic-search', retrievalAttemptRef: 'ra-lex' },
    ],
    sourceVersion: { gitCommit: null, fileHash: 'a'.repeat(64), isDirty: true },
    snippet: 'function refresh() {}', liveRead: { startLine: 8, endLine: 8 },
  };
  const projected = projectCodeEvidence(candidate, { need: 'locate-concept' });
  assert.equal(projected.length, 2);
  for (const item of projected) {
    assert.deepEqual(Object.keys(item).sort(), ['candidate', 'content']);
    assert.deepEqual(Object.keys(item.candidate).sort(), ['capability', 'locator', 'need', 'provider', 'sourceVersion']);
    assert.deepEqual(item.candidate.locator, { file: 'src/auth.js', line: 8 });
    assert.equal(item.candidate.need, 'locate-concept');
    assert.equal(item.content, 'function refresh() {}');
    assert.equal('score' in item.candidate, false);
    assert.equal('rrfScore' in item.candidate, false);
    assert.equal('origins' in item.candidate, false);
  }
  assert.deepEqual(projected.map((item) => item.candidate.provider), ['semble.search', 'native.rg']);
});

test('projection refuses candidates without a validated live read', () => {
  assert.throws(() => projectCodeEvidence({ locator: { file: 'src/a.js', line: 1 } }), /validated live read/);
});
