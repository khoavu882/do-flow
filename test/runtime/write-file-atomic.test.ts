'use strict';

// The one temp-file-then-rename writer in src/runtime.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { writeFileAtomic } = require('../../src/runtime/write-file-atomic.ts');

test('writes the content, creates the folder, and leaves no temp file', (t: any) => {
  const root = tempDir(t, 'doflow-write-atomic-');
  const file = path.join(root, 'a', 'b', 'record.json');
  writeFileAtomic(file, '{"v":1}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1}\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['record.json']);
});

test('replaces an existing file whole', (t: any) => {
  const root = tempDir(t, 'doflow-write-atomic-');
  const file = path.join(root, 'record.json');
  fs.writeFileSync(file, 'old old old');
  writeFileAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('the temp file is <file>.<pid>.tmp beside the target, the name the storage sweep knows', (t: any) => {
  const root = tempDir(t, 'doflow-write-atomic-');
  const file = path.join(root, 'record.json');
  const seen: string[] = [];
  const fsImpl = { ...fs, mkdirSync: fs.mkdirSync, writeFileSync: (p: any, ...rest: any[]) => { seen.push(p); return fs.writeFileSync(p, ...rest); }, renameSync: fs.renameSync, rmSync: fs.rmSync };
  writeFileAtomic(file, 'x', { fsImpl });
  assert.deepEqual(seen, [`${file}.${process.pid}.tmp`]);
});

test('beforeRename runs after the temp file exists and before the rename', (t: any) => {
  const root = tempDir(t, 'doflow-write-atomic-');
  const file = path.join(root, 'record.json');
  fs.writeFileSync(file, 'old');
  let tempBytes: string | null = null;
  let targetBytes: string | null = null;
  writeFileAtomic(file, 'new', {
    beforeRename: () => {
      tempBytes = fs.readFileSync(`${file}.${process.pid}.tmp`, 'utf8');
      targetBytes = fs.readFileSync(file, 'utf8');
    },
  });
  assert.equal(tempBytes, 'new');
  assert.equal(targetBytes, 'old');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('a beforeRename that throws keeps the old file, removes the temp file and rethrows that error', (t: any) => {
  const root = tempDir(t, 'doflow-write-atomic-');
  const file = path.join(root, 'record.json');
  fs.writeFileSync(file, 'old');
  const stale = new Error('lock lost');
  assert.throws(() => writeFileAtomic(file, 'new', { beforeRename: () => { throw stale; } }), (error: any) => error === stale);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(root), ['record.json']);
});

test('a failed rename removes the temp file and rethrows the rename error', (t: any) => {
  const root = tempDir(t, 'doflow-write-atomic-');
  const file = path.join(root, 'record.json');
  const failure = new Error('rename refused');
  const fsImpl = { ...fs, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, rmSync: fs.rmSync, renameSync: () => { throw failure; } };
  assert.throws(() => writeFileAtomic(file, 'new', { fsImpl }), (error: any) => error === failure);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a failed temp write rethrows the write error even when the cleanup also fails', (t: any) => {
  const root = tempDir(t, 'doflow-write-atomic-');
  const file = path.join(root, 'record.json');
  const failure = new Error('disk full');
  const fsImpl = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: () => { throw failure; },
    renameSync: fs.renameSync,
    rmSync: () => { throw new Error('cleanup refused'); },
  };
  assert.throws(() => writeFileAtomic(file, 'new', { fsImpl }), (error: any) => error === failure);
});
