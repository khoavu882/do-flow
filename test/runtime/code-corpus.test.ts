'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { admitCodeCorpus, readCorpusFile, fingerprintCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');

function project(t: any) {
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
  assert.deepEqual(inventory.files.map((f: any) => f.path), ['src/nested/skip.js', 'src/a.js'].sort());
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
  assert.equal(inventory.skipped.some((x: any) => x.reason === 'not-regular-file'), true);
  assert.equal(readCorpusFile(root, { path: 'src/a.js' }).ok, true);
  assert.equal(readCorpusFile(root, { path: 'src/a.js' }, { maxBytes: 1 }).reason, 'read-byte-limit');
  assert.equal(readCorpusFile(root, { path: '../outside-code-corpus' }).reason, 'invalid-path');
});

// R4 (c): scopes are normalized once per admission; plain scopes match the path or a directory above it.
test('R4c: scope matching keeps its file, directory, glob, normalization and match-all semantics', t => {
  const root = tempDir(t, 'doflow-code-corpus-scope-');
  const files: any = ['src/a.js', 'src/ab.js', 'src/nested/b.js', 'srcx/c.js', 'lib/d.ts', 'top.js'];
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'x\n'); }
  const admit = (scopes: any) => admitCodeCorpus({ root, files, scopes, hashFiles: false }).files.map((f: any) => f.path).sort();
  assert.deepEqual(admit(['src']), ['src/a.js', 'src/ab.js', 'src/nested/b.js'], 'a directory scope never matches a sibling prefix (srcx)');
  assert.deepEqual(admit(['./src/nested/', 'src/a.js']), ['src/a.js', 'src/nested/b.js']);
  assert.deepEqual(admit(['src/a']), [], 'a plain scope is not a string prefix');
  assert.deepEqual(admit(['**/*.ts', 'top.js']), ['lib/d.ts', 'top.js']);
  assert.deepEqual(admit([42, 'lib']), ['lib/d.ts'], 'a non-string scope matches nothing');
  assert.deepEqual(admit([42]), []);
  for (const all of [['.'], ['**'], ['./'], ['lib', '.']]) assert.deepEqual(admit(all), [...files].sort(), JSON.stringify(all));
  assert.deepEqual(admit([]), [...files].sort());
});
