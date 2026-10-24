'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { classifyCodeQuery, searchCodeLexical } = require('../../src/runtime/knowledge/code-lexical.ts');

test('classifies exact identifiers and quoted literals separately from concepts', () => {
  assert.equal(classifyCodeQuery('resolveNeed').queryClass, 'exact');
  assert.deepEqual(classifyCodeQuery('"a.b"').literal, 'a.b');
  assert.equal(classifyCodeQuery('where does password reset send a notification').queryClass, 'conceptual');
});

test('searches only admitted files and returns deterministic exact and conceptual candidates', t => {
  const root = tempDir(t, 'doflow-code-lexical-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'reset.js'), 'function resetPassword(user) {\n  notify(user);\n}\n');
  fs.writeFileSync(path.join(root, 'graphify-out', 'reset.js'), 'function resetPassword() {}\n');
  const inventory = admitCodeCorpus({ root, files: ['src/reset.js'] });
  const exact = searchCodeLexical({ inventory, query: 'resetPassword', queryRef: 'q1', retrievalAttemptRef: 'a1' });
  assert.equal(exact.complete, true);
  assert.deepEqual(exact.candidates.map((c: any) => c.locator), [{ file: 'src/reset.js', line: 1, endLine: 1 }]);
  assert.equal(exact.candidates[0].queryRef, 'q1');
  const conceptual = searchCodeLexical({ inventory, query: 'reset password notify' });
  assert.equal(conceptual.queryClass, 'conceptual');
  assert.equal(conceptual.candidates[0].locator.file, 'src/reset.js');
});

test('a NUL-containing admitted file is a counted coverage gap, never a lexical provider fault', async t => {
  const root = tempDir(t, 'doflow-code-lexical-binary-');
  fs.writeFileSync(path.join(root, 'keys.js'), 'const key = `a\0b`; // findMeLiteral\n');
  fs.writeFileSync(path.join(root, 'main.js'), 'function findMeLiteral() {}\n');
  const inventory = admitCodeCorpus({ root, files: ['keys.js', 'main.js'] });
  const result = searchCodeLexical({ inventory, query: 'findMeLiteral' });
  assert.equal(result.complete, true, 'provider outcome stays complete');
  assert.equal(result.coverage.complete, false, 'coverage stays honest');
  assert.deepEqual(result.coverage.skippedByReason, { 'binary-source': 1 });
  assert.deepEqual(result.coverage.skipped, [{ path: 'keys.js', reason: 'binary-source' }]);
  assert.equal(result.coverage.searchedFiles, 1);
  assert.deepEqual(result.candidates.map((c: any) => c.locator.file), ['main.js']);
  const { executeCodeRetrieval } = require('../../src/runtime/knowledge/code-retrieval.ts');
  for (const query of ['findMeLiteral', 'doflowAbsentLiteral']) {
    const { exit, response } = await executeCodeRetrieval({ root, query, top: 5, profile: 'lexical-only', providers: { inventory } });
    assert.equal(exit, 0);
    const lexical = response.attempts.filter((a: any) => a.provider === 'native.rg');
    assert.equal(lexical.length, 1);
    assert.equal(response.gaps.some((g: any) => g.provider === 'native.rg'), false, JSON.stringify(response.gaps));
    assert.equal(response.coverage.complete, false);
    assert.deepEqual(response.coverage.lexical[0].skippedByReason, { 'binary-source': 1 });
  }
});

test('a real bound hit still marks the lexical outcome incomplete', t => {
  const root = tempDir(t, 'doflow-code-lexical-bound-');
  fs.writeFileSync(path.join(root, 'many.js'), 'hit\nhit\nhit\n');
  const inventory = admitCodeCorpus({ root, files: ['many.js'] });
  const result = searchCodeLexical({ inventory, query: 'hit', maxCandidates: 2 });
  assert.equal(result.complete, false);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.skippedByReason['candidate-limit'] >= 1, true);
});

// R4 (c): the whole-file precheck skips files without the literal but keeps every matching line and filename hit.
test('R4c: exact search reports every literal line, filename-only hits and skips nothing that matches', t => {
  const root = tempDir(t, 'doflow-code-lexical-exact-');
  const files: any = { 'src/a.js': 'one\nfunction loadRegistry() {}\nloadRegistry\nfunction loadRegistry\n', 'src/none.js': 'function other() {}\n', 'src/loadRegistry': 'no literal here\n' };
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), body); }
  const inventory = admitCodeCorpus({ root, files: Object.keys(files) });
  const lines = (query: any) => searchCodeLexical({ inventory, query }).candidates.map((c: any) => `${c.locator.file}:${c.locator.line}`);
  assert.deepEqual(lines('"function loadRegistry"'), ['src/a.js:2', 'src/a.js:4']);
  assert.deepEqual(lines('loadRegistry'), ['src/a.js:2', 'src/a.js:3', 'src/a.js:4', 'src/loadRegistry:1']);
  assert.deepEqual(lines('"absent literal"'), []);
});

// X3: an admission skip leaves lexical coverage partial but is not a provider outcome.
test('X3: an incomplete admitted inventory keeps the lexical provider outcome complete and its coverage partial', t => {
  const root = tempDir(t, 'doflow-code-lexical-admission-');
  fs.writeFileSync(path.join(root, 'small.js'), 'function findMeLiteral() {}\n');
  fs.writeFileSync(path.join(root, 'large.js'), `// findMeLiteral\n${'x'.repeat(300)}\n`);
  const inventory = admitCodeCorpus({ root, files: ['large.js', 'small.js'], limits: { maxFileBytes: 200 } });
  assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.skipped, [{ path: 'large.js', reason: 'file-byte-limit' }]);
  for (const query of ['findMeLiteral', 'find me literal']) {
    const result = searchCodeLexical({ inventory, query });
    assert.equal(result.complete, true, 'no lexical fault occurred');
    assert.deepEqual(result.rejections, []);
    assert.equal(result.coverage.complete, false, 'the unadmitted file still leaves coverage partial');
    assert.deepEqual(result.candidates.map((c: any) => c.locator.file), ['small.js']);
  }
  const control = searchCodeLexical({ inventory: admitCodeCorpus({ root, files: ['large.js', 'small.js'] }), query: 'findMeLiteral' });
  assert.equal(control.coverage.complete, true);
});
