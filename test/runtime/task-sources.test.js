'use strict';

// IC-013 (feature 080, D.1): source records and their comparison.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { tempDir } = require('../helper/tmp');

// Count every child-process entry point before the module (and 076's source-version.ts, which
// binds `execFileSync` at load) is required, so any spawn by a measurement is seen.
let spawns = 0;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = childProcess[name];
  childProcess[name] = function (...args) { spawns++; return real.apply(this, args); };
}

const { MAX_HASH_BYTES, MAX_SOURCES, measureSources, compareSources } = require('../../src/runtime/task-sources.ts');

const sha = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;

function spyOn(t, name) {
  const real = fs[name];
  const calls = [];
  fs[name] = function (...args) { calls.push(String(args[0])); return real.apply(this, args); };
  t.after(() => { fs[name] = real; });
  return calls;
}

test('each record kind and why', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'alpha\n');
  fs.mkdirSync(path.join(wt, 'dir'));
  fs.symlinkSync('a.txt', path.join(wt, 'link.txt'));
  fs.writeFileSync(path.join(wt, 'big.bin'), Buffer.alloc(MAX_HASH_BYTES + 1));
  fs.writeFileSync(path.join(wt, 'exact.bin'), Buffer.alloc(MAX_HASH_BYTES));
  const files = ['a.txt', './a.txt', 'missing.txt', 'dir', 'link.txt', 'big.bin', 'exact.bin'];
  const m = measureSources({ files }, wt, []);
  assert.deepEqual(m.sources, [
    { file: 'a.txt', kind: 'file', fileHash: sha('alpha\n') },
    { file: './a.txt', kind: 'file', fileHash: sha('alpha\n') },
    { file: 'missing.txt', kind: 'absent', fileHash: null },
    { file: 'dir', kind: 'unhashable', fileHash: null, why: 'directory' },
    { file: 'link.txt', kind: 'unhashable', fileHash: null, why: 'link' },
    { file: 'big.bin', kind: 'unhashable', fileHash: null, why: 'too-large' },
    { file: 'exact.bin', kind: 'file', fileHash: sha(Buffer.alloc(MAX_HASH_BYTES)) },
  ]);
  assert.equal(m.sourcesTruncated, false);
  assert.equal(m.execWorktreeMissing, false);
  assert.deepEqual(m.sourcesUnverifiable, ['dir', 'link.txt', 'big.bin']);
});

test('an unreadable regular file is unhashable, read-error', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  const file = path.join(wt, 'locked.txt');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o000);
  assert.deepEqual(measureSources({ files: ['locked.txt'] }, wt, []).sources,
    [{ file: 'locked.txt', kind: 'unhashable', fileHash: null, why: 'read-error' }]);
});

test('patterns and annotated entries are unverifiable without a disk access', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  const files = ['src/*.ts', 'a?.txt', 'two words.md', 'fn(x).js', 'src/a.ts:12', 'src/a.ts:3-9'];
  const lstat = spyOn(t, 'lstatSync');
  const stat = spyOn(t, 'statSync');
  const read = spyOn(t, 'readFileSync');
  const m = measureSources({ files }, wt, []);
  assert.deepEqual(m.sources, files.map((file) => ({ file, kind: 'unverifiable', fileHash: null, why: 'pattern' })));
  assert.deepEqual(m.sourcesUnverifiable, files);
  assert.deepEqual(lstat, []);
  assert.deepEqual(read, []);
  // The only stat is the execWorktree existence check, never an entry.
  assert.deepEqual(stat, [wt]);
});

test('one lstat per entry under the execWorktree', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a');
  fs.mkdirSync(path.join(wt, 'd'));
  const lstat = spyOn(t, 'lstatSync');
  measureSources({ files: ['a.txt', 'd'] }, wt, []);
  assert.deepEqual(lstat, [path.join(wt, 'a.txt'), path.join(wt, 'd')]);
});

test('a file of 1 MiB plus one byte is not read', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  const big = path.join(wt, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(MAX_HASH_BYTES + 1));
  const read = spyOn(t, 'readFileSync');
  const m = measureSources({ files: ['big.bin'] }, wt, []);
  assert.deepEqual(read.filter((p) => p === big), []);
  assert.deepEqual(m.sources, [{ file: 'big.bin', kind: 'unhashable', fileHash: null, why: 'too-large' }]);
});

test('entries resolve under the execWorktree first, then the other roots in order', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  const r1 = tempDir(t, 'doflow-sources-');
  const r2 = tempDir(t, 'doflow-sources-');
  fs.writeFileSync(path.join(wt, 'both.txt'), 'wt');
  fs.writeFileSync(path.join(r1, 'both.txt'), 'r1');
  fs.writeFileSync(path.join(r2, 'only2.txt'), 'r2');
  const m = measureSources({ files: ['both.txt', 'only2.txt', 'nowhere.txt'] }, wt, [r1, r2, wt]);
  assert.deepEqual(m.sources.map((s) => s.fileHash), [sha('wt'), sha('r2'), null]);
  assert.equal(m.sources[2].kind, 'absent');
});

test('more than 64 entries: the first 64 are measured and sourcesTruncated is set', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  const files = Array.from({ length: MAX_SOURCES + 1 }, (_, i) => `f${i}.txt`);
  const m = measureSources({ files }, wt, []);
  assert.equal(m.sources.length, 64);
  assert.equal(m.sources.at(-1).file, 'f63.txt');
  assert.equal(m.sourcesTruncated, true);
  assert.equal(measureSources({ files: files.slice(0, 64) }, wt, []).sourcesTruncated, false);
  assert.deepEqual(compareSources(m, m), { unverifiable: true, files: [] });
});

test('each change kind between two measurements', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  fs.writeFileSync(path.join(wt, 'same.txt'), 's');
  fs.writeFileSync(path.join(wt, 'edit.txt'), 'v1');
  fs.writeFileSync(path.join(wt, 'gone.txt'), 'g');
  const files = ['same.txt', 'edit.txt', 'new.txt', 'gone.txt', 'never.txt'];
  const before = measureSources({ files }, wt, []);
  fs.writeFileSync(path.join(wt, 'edit.txt'), 'v2');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'n');
  fs.rmSync(path.join(wt, 'gone.txt'));
  const after = measureSources({ files }, wt, []);
  assert.deepEqual(compareSources(before, after), {
    unverifiable: false,
    files: [
      { file: 'same.txt', change: 'unchanged' },
      { file: 'edit.txt', change: 'changed' },
      { file: 'new.txt', change: 'created' },
      { file: 'gone.txt', change: 'removed' },
      { file: 'never.txt', change: 'unchanged' },
    ],
  });
});

test('the task is unverifiable for an opaque entry, no sources, truncation or a missing entry', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a');
  fs.mkdirSync(path.join(wt, 'd'));
  const plain = measureSources({ files: ['a.txt'] }, wt, []);
  const U = { unverifiable: true, files: [] };
  assert.deepEqual(compareSources(plain, plain), { unverifiable: false, files: [{ file: 'a.txt', change: 'unchanged' }] });
  const withDir = measureSources({ files: ['a.txt', 'd'] }, wt, []);
  assert.deepEqual(compareSources(withDir, withDir), U);
  const withPattern = measureSources({ files: ['a.txt', 'src/*.ts'] }, wt, []);
  assert.deepEqual(compareSources(withPattern, withPattern), U);
  assert.deepEqual(compareSources({}, plain), U);
  assert.deepEqual(compareSources(null, plain), U);
  assert.deepEqual(compareSources({ ...plain, sourcesTruncated: true }, plain), U);
  assert.deepEqual(compareSources(plain, measureSources({ files: [] }, wt, [])), U);
  // Opaque only after: a file that became a directory.
  fs.rmSync(path.join(wt, 'a.txt'));
  fs.mkdirSync(path.join(wt, 'a.txt'));
  assert.deepEqual(compareSources(plain, measureSources({ files: ['a.txt'] }, wt, [])), U);
});

test('a missing execWorktree is unverifiable', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a');
  const before = measureSources({ files: ['a.txt'] }, wt, []);
  fs.rmSync(wt, { recursive: true, force: true });
  const after = measureSources({ files: ['a.txt'] }, wt, []);
  assert.equal(after.execWorktreeMissing, true);
  assert.deepEqual(compareSources(before, after), { unverifiable: true, files: [] });
});

test('no child process is spawned by any measurement', (t) => {
  const wt = tempDir(t, 'doflow-sources-');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a');
  fs.mkdirSync(path.join(wt, '.git'));
  const before = spawns;
  const m = measureSources({ files: ['a.txt', 'b.txt', 'src/*.ts'] }, wt, [wt]);
  compareSources(m, m);
  assert.equal(spawns - before, 0);
  assert.equal(spawns, 0);
});
