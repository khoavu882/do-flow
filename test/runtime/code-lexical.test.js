'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { classifyCodeQuery, searchCodeLexical } = require('../../src/runtime/knowledge/code-lexical.ts');

test('classifies exact identifiers and quoted literals separately from concepts', () => {
  assert.equal(classifyCodeQuery('resolveNeed').queryClass, 'exact');
  assert.deepEqual(classifyCodeQuery('"a.b"').literal, 'a.b');
  assert.equal(classifyCodeQuery('where does password reset send a notification').queryClass, 'conceptual');
});

test('searches only admitted files and returns deterministic exact and conceptual candidates', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-lexical-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'reset.js'), 'function resetPassword(user) {\n  notify(user);\n}\n');
  fs.writeFileSync(path.join(root, 'graphify-out', 'reset.js'), 'function resetPassword() {}\n');
  const inventory = admitCodeCorpus({ root, files: ['src/reset.js'] });
  const exact = searchCodeLexical({ inventory, query: 'resetPassword', queryRef: 'q1', retrievalAttemptRef: 'a1' });
  assert.equal(exact.complete, true);
  assert.deepEqual(exact.candidates.map(c => c.locator), [{ file: 'src/reset.js', line: 1, endLine: 1 }]);
  assert.equal(exact.candidates[0].queryRef, 'q1');
  const conceptual = searchCodeLexical({ inventory, query: 'reset password notify' });
  assert.equal(conceptual.queryClass, 'conceptual');
  assert.equal(conceptual.candidates[0].locator.file, 'src/reset.js');
});
