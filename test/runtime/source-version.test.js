'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const {
  measureTreeState,
  sourceVersionFor,
  clearTreeStateCache,
} = require('../../src/runtime/source-version.ts');

function makeRepo(t, prefix) {
  const dir = tempDir(t, prefix);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  return { dir, git };
}

test('isDirty is false for a clean file, true for a modified one, true for an untracked one, and null for a uri locator', (t) => {
  const { dir, git } = makeRepo(t, 'doflow-sv-dirty-');
  fs.writeFileSync(path.join(dir, 'clean.txt'), 'clean content\n');
  fs.writeFileSync(path.join(dir, 'modified.txt'), 'before edit\n');
  git('add', 'clean.txt', 'modified.txt');
  git('commit', '-m', 'initial');

  // Modify one file and add an untracked file
  fs.writeFileSync(path.join(dir, 'modified.txt'), 'after edit\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'untracked content\n');

  clearTreeStateCache();
  const state = measureTreeState(dir);

  const svClean = sourceVersionFor(dir, { file: 'clean.txt' }, state);
  assert.equal(svClean.isDirty, false);

  const svModified = sourceVersionFor(dir, { file: 'modified.txt' }, state);
  assert.equal(svModified.isDirty, true);

  const svUntracked = sourceVersionFor(dir, { file: 'untracked.txt' }, state);
  assert.equal(svUntracked.isDirty, true);

  const svUri = sourceVersionFor(dir, { uri: 'https://example.com/spec' }, state);
  assert.equal(svUri.isDirty, null);
});

test('a non-git temp dir gives null gitCommit, isDirty and fingerprint, with fileHash set', (t) => {
  const dir = tempDir(t, 'doflow-sv-nongit-');
  fs.writeFileSync(path.join(dir, 'data.txt'), 'hello non-git world\n');

  clearTreeStateCache();
  const state = measureTreeState(dir);

  assert.equal(state.gitCommit, null);
  assert.equal(state.dirty, null);
  assert.equal(state.fingerprint, null);

  const sv = sourceVersionFor(dir, { file: 'data.txt' }, state);
  assert.equal(sv.gitCommit, null);
  assert.equal(sv.isDirty, null);
  assert.match(sv.fileHash, /^sha256:[0-9a-f]{64}$/);
});

test('the fingerprint changes after an uncommitted edit, after a second edit to an already-modified file, and after a new file inside an untracked directory', (t) => {
  const { dir, git } = makeRepo(t, 'doflow-sv-fp-');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n');
  git('add', 'file.txt');
  git('commit', '-m', 'initial');

  clearTreeStateCache();
  const fp1 = measureTreeState(dir).fingerprint;
  assert.ok(fp1 && fp1.startsWith('sha256:'));

  // 1. Uncommitted edit
  fs.writeFileSync(path.join(dir, 'file.txt'), 'edit one\n');
  clearTreeStateCache();
  const fp2 = measureTreeState(dir).fingerprint;
  assert.notEqual(fp2, fp1, 'fingerprint must change after uncommitted edit');

  // 2. Second edit to an already-modified file (changes size and mtime)
  const futureSec = Math.floor(Date.now() / 1000) + 10;
  fs.writeFileSync(path.join(dir, 'file.txt'), 'edit two with noticeably more content\n');
  fs.utimesSync(path.join(dir, 'file.txt'), futureSec, futureSec);
  clearTreeStateCache();
  const fp3 = measureTreeState(dir).fingerprint;
  assert.notEqual(fp3, fp2, 'fingerprint must change after second edit to an already-modified file');

  // 3. New file inside an untracked directory
  const untrackedSub = path.join(dir, 'untracked_dir');
  fs.mkdirSync(untrackedSub);
  fs.writeFileSync(path.join(untrackedSub, 'nested.txt'), 'nested untracked\n');
  clearTreeStateCache();
  const fp4 = measureTreeState(dir).fingerprint;
  assert.notEqual(fp4, fp3, 'fingerprint must change after new file inside an untracked directory');
});

test('the fingerprint does not change after git fetch', (t) => {
  const bareDir = tempDir(t, 'doflow-sv-bare-');
  execFileSync('git', ['init', '--bare', bareDir], { stdio: 'ignore' });

  const { dir, git } = makeRepo(t, 'doflow-sv-fetch-');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', 'base.txt');
  git('commit', '-m', 'base');
  git('remote', 'add', 'origin', bareDir);
  git('push', '-u', 'origin', 'HEAD');

  clearTreeStateCache();
  const fpBefore = measureTreeState(dir).fingerprint;

  git('fetch', 'origin');
  clearTreeStateCache();
  const fpAfter = measureTreeState(dir).fingerprint;

  assert.equal(fpAfter, fpBefore, 'fingerprint must not change after git fetch');
});

test('an injected runner counts one spawn per write', (t) => {
  const { dir, git } = makeRepo(t, 'doflow-sv-runner-');
  fs.writeFileSync(path.join(dir, 'test.txt'), 'test\n');
  git('add', 'test.txt');
  git('commit', '-m', 'test');

  let spawns = 0;
  const countingRunner = (args, cwd) => {
    spawns++;
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  };

  clearTreeStateCache();
  const state = measureTreeState(dir, countingRunner);
  assert.equal(spawns, 1, 'expected exactly one spawn');
  assert.ok(state.gitCommit);
});
