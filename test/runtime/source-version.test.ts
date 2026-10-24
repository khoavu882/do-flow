'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const {
  measureTreeState,
  sourceVersionFor,
  clearTreeStateCache,
} = require('../../src/runtime/source-version.ts');

function makeRepo(t: any, prefix: any) {
  const dir = tempDir(t, prefix);
  const git = (...args: any[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
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

test('a file inside an untracked directory is dirty, and editing it changes the fingerprint', (t) => {
  const { dir, git } = makeRepo(t, 'doflow-sv-untracked-dir-');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n');
  git('add', 'file.txt');
  git('commit', '-m', 'initial');

  const nested = path.join(dir, 'untracked_dir', 'nested.txt');
  fs.mkdirSync(path.dirname(nested));
  fs.writeFileSync(nested, 'nested one\n');

  clearTreeStateCache();
  const before = measureTreeState(dir);
  assert.equal(
    sourceVersionFor(dir, { file: 'untracked_dir/nested.txt' }, before).isDirty,
    true,
    'a file inside an untracked directory is listed individually, so it is dirty',
  );

  const futureSec = Math.floor(Date.now() / 1000) + 10;
  fs.writeFileSync(nested, 'nested two with more content\n');
  fs.utimesSync(nested, futureSec, futureSec);
  clearTreeStateCache();
  const after = measureTreeState(dir);
  assert.notEqual(after.fingerprint, before.fingerprint, 'editing a file inside an untracked directory must change the fingerprint');
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
  const countingRunner = (args: any, cwd: any) => {
    spawns++;
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  };

  clearTreeStateCache();
  const state = measureTreeState(dir, countingRunner);
  assert.equal(spawns, 1, 'expected exactly one spawn');
  assert.ok(state.gitCommit);
});

test('falls back to rev-parse for the commit when status fails', (t) => {
  const { dir, git } = makeRepo(t, 'doflow-sv-status-fallback-');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'file\n');
  git('add', 'file.txt');
  git('commit', '-m', 'initial');
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const runner = (args: any, cwd: any) => args.includes('status') ? null : execFileSync('git', args, { cwd, encoding: 'utf8' });

  const state = measureTreeState(dir, runner);
  assert.equal(state.gitCommit, head);
  assert.equal(state.dirty, null);
  assert.equal(state.fingerprint, null);
});

test('normalizes relative dirty locators and leaves absolute locators unknown', (t) => {
  const { dir, git } = makeRepo(t, 'doflow-sv-normalized-');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.js'), 'before\n');
  git('add', 'sub/a.js');
  git('commit', '-m', 'initial');
  fs.writeFileSync(path.join(dir, 'sub', 'a.js'), 'after\n');
  const state = measureTreeState(path.join(dir, 'sub'));

  assert.equal(sourceVersionFor(path.join(dir, 'sub'), { file: './a.js' }, state).isDirty, true);
  assert.equal(sourceVersionFor(path.join(dir, 'sub'), { file: path.join(dir, 'sub', 'a.js') }, state).isDirty, null);
});

test('ignores DoFlow state files in the fingerprint while retaining dirty paths', (t) => {
  const { dir, git } = makeRepo(t, 'doflow-sv-state-');
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.doflow', 'state', '.gitignore'), '*\n!.gitignore\n');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base\n');
  git('add', 'tracked.txt');
  git('commit', '-m', 'initial');
  fs.unlinkSync(path.join(dir, '.doflow', 'state', '.gitignore'));

  clearTreeStateCache();
  const before = measureTreeState(dir);
  fs.mkdirSync(path.join(dir, '.doflow', 'state', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.doflow', 'state', 'evidence', 'item.json'), '{}\n');
  clearTreeStateCache();
  const after = measureTreeState(dir);

  assert.equal(after.fingerprint, before.fingerprint);
  assert.ok(after.dirty.has('.doflow/state/evidence/item.json'));
});

test('folds untracked nested repository state into the parent fingerprint', (t) => {
  const { dir, git } = makeRepo(t, 'doflow-sv-nested-');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', 'base.txt');
  git('commit', '-m', 'initial');
  const nested = path.join(dir, 'nested');
  fs.mkdirSync(nested);
  execFileSync('git', ['init', '-q', nested]);
  execFileSync('git', ['-C', nested, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', nested, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'one\n');
  execFileSync('git', ['-C', nested, 'add', 'inner.txt']);
  execFileSync('git', ['-C', nested, 'commit', '-m', 'one'], { stdio: 'ignore' });

  clearTreeStateCache();
  const before = measureTreeState(dir).fingerprint;
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'two with changed size\n');
  execFileSync('git', ['-C', nested, 'add', 'inner.txt']);
  clearTreeStateCache();
  const after = measureTreeState(dir).fingerprint;
  assert.notEqual(after, before);
});

test('folds submodule HEAD state into the parent fingerprint', (t) => {
  const bare = tempDir(t, 'doflow-sv-submodule-bare-');
  execFileSync('git', ['init', '--bare', '-q', bare]);
  const submodule = tempDir(t, 'doflow-sv-submodule-source-');
  execFileSync('git', ['-C', submodule, 'init', '-q']);
  execFileSync('git', ['-C', submodule, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', submodule, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(submodule, 'inner.txt'), 'one\n');
  execFileSync('git', ['-C', submodule, 'add', 'inner.txt']);
  execFileSync('git', ['-C', submodule, 'commit', '-m', 'one'], { stdio: 'ignore' });
  execFileSync('git', ['-C', submodule, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', submodule, 'push', '-u', 'origin', 'HEAD'], { stdio: 'ignore' });

  const { dir, git } = makeRepo(t, 'doflow-sv-submodule-parent-');
  execFileSync('git', ['-C', dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', bare, 'module'], { stdio: 'ignore' });
  git('commit', '-m', 'add submodule');
  clearTreeStateCache();
  const before = measureTreeState(dir).fingerprint;

  // The submodule is a fresh clone: it does not inherit the parent's identity, and a CI runner has
  // no global one, so the commit below needs its own.
  fs.writeFileSync(path.join(dir, 'module', 'inner.txt'), 'two\n');
  execFileSync('git', ['-C', path.join(dir, 'module'), 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', path.join(dir, 'module'), 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', path.join(dir, 'module'), 'add', 'inner.txt']);
  execFileSync('git', ['-C', path.join(dir, 'module'), 'commit', '-m', 'two'], { stdio: 'ignore' });
  clearTreeStateCache();
  const after = measureTreeState(dir).fingerprint;
  assert.notEqual(after, before);
});

test('fails closed when the project root is ignored by its parent repository', (t) => {
  const { dir, git } = makeRepo(t, 'doflow-sv-ignored-root-');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'project/\n');
  git('add', '.gitignore');
  git('commit', '-m', 'initial');
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);

  clearTreeStateCache();
  const state = measureTreeState(project);
  assert.equal(state.prefix, 'project/');
  assert.equal(state.dirty, null);
  assert.equal(state.fingerprint, null);
});
