'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { admitCodeCorpus, readCorpusFile, fingerprintCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');

function project(t) {
  const root = tempDir(t, 'doflow-code-corpus-');
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const answer = 42;\n');
  fs.writeFileSync(path.join(root, 'src', 'nested', 'skip.js'), 'ignored\n');
  fs.writeFileSync(path.join(root, 'gen', 'out.js'), 'generated\n');
  fs.writeFileSync(path.join(root, '.sembleignore'), 'gen/\n');
  return root;
}

test('admission applies scope and ignore rules and hashes only when requested', t => {
  const root = project(t);
  const inventory = admitCodeCorpus({ root, files: ['src/a.js', 'src/nested/skip.js', 'gen/out.js'], scopes: ['src/**/*.js'] });
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.files.map(f => f.path), ['src/nested/skip.js', 'src/a.js'].sort());
  const unhash = admitCodeCorpus({ root, files: ['src/a.js'], hashFiles: false });
  assert.equal(unhash.files[0].fileHash, null);
  assert.equal(fingerprintCorpus(unhash).files[0].fileHash.length, 64);
});

test('admission rejects symlink members and read verifies identity and bounded bytes', t => {
  const root = project(t); const outside = path.join(path.dirname(root), 'outside-code-corpus');
  fs.writeFileSync(outside, 'outside\n');
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(root, 'src', 'escape.js'));
  const inventory = admitCodeCorpus({ root, files: ['src/a.js', 'src/escape.js'] });
  assert.equal(inventory.complete, false);
  assert.equal(inventory.skipped.some(x => x.reason === 'not-regular-file'), true);
  assert.equal(readCorpusFile(root, { path: 'src/a.js' }).ok, true);
  assert.equal(readCorpusFile(root, { path: 'src/a.js' }, { maxBytes: 1 }).reason, 'read-byte-limit');
  assert.equal(readCorpusFile(root, { path: '../outside-code-corpus' }).reason, 'invalid-path');
});
