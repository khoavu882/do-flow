'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { validateCodeCandidates, projectEvidenceCandidates } = require('../../src/runtime/knowledge/code-validation.ts');

test('always live-reads source, rejects stale or out-of-corpus candidates and projects score-free evidence', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-validation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.js'), 'one\ntrusted source\nthree\n');
  const inventory = admitCodeCorpus({ root, files: ['main.js'] });
  const [entry] = inventory.files;
  const candidate = { locator: { file: entry.path, line: 2, endLine: 2 }, provider: 'semble.search', capability: 'code.semantic-search',
    sourceVersion: { fileHash: entry.fileHash }, rrfScore: 1.25, snippet: 'untrusted cached answer' };
  const result = validateCodeCandidates({ inventory, candidates: [candidate], topN: 2 });
  assert.equal(result.results[0].snippet, 'trusted source');
  const evidence = projectEvidenceCandidates(result.results[0], { need: 'n1' });
  assert.deepEqual(evidence[0].candidate.locator, { file: 'main.js', line: 2 });
  assert.equal(evidence[0].content, 'trusted source');
  assert.equal(Object.hasOwn(evidence[0].candidate, 'rrfScore'), false);
  assert.equal(validateCodeCandidates({ inventory, candidates: [{ ...candidate, sourceVersion: { fileHash: '0'.repeat(64) } }] }).rejected[0].reason, 'source-changed');
  assert.equal(validateCodeCandidates({ inventory, candidates: [{ ...candidate, locator: { file: '../outside', line: 1, endLine: 1 } }] }).rejected[0].reason, 'invalid-locator');
});
