'use strict';

// maint-revparse: the call-scoped git memo. A git answer that cannot move is kept for one call and
// dropped with it; a ref is never kept; outside a scope every question goes to git.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { withGitMemo, memoGit, inGitMemo } = require('../../src/runtime/git-memo.ts');
const { projectRoot } = require('../../src/runtime/lifecycle/root.ts');
const { WorktreeManager } = require('../../src/runtime/worktree.ts');

const IDENTITY = ['-c', 'user.name=T', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false'];
function git(cwd: string, ...args: string[]): string {
  const res = cp.spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}
function repo(t: any, prefix: string): string {
  const dir = fs.realpathSync(tempDir(t, prefix));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('outside a scope every question is computed', () => {
  let n = 0;
  assert.equal(inGitMemo(), false);
  memoGit('k', () => ++n);
  memoGit('k', () => ++n);
  assert.equal(n, 2);
});

test('inside a scope a key is computed once; a throw and an undefined are asked again', () => {
  let n = 0;
  withGitMemo(() => {
    assert.equal(inGitMemo(), true);
    assert.equal(memoGit('k', () => ++n), 1);
    assert.equal(memoGit('k', () => ++n), 1);
    assert.equal(memoGit('other', () => ++n), 2);
    let tries = 0;
    assert.throws(() => memoGit('boom', () => { tries++; throw new Error('x'); }));
    assert.throws(() => memoGit('boom', () => { tries++; throw new Error('x'); }));
    assert.equal(tries, 2);
    memoGit('none', () => { tries++; return undefined; });
    memoGit('none', () => { tries++; return undefined; });
    assert.equal(tries, 4);
  });
});

test('each call has its own scope, nested scopes share the outer one, and a scope survives an await', async () => {
  let n = 0;
  withGitMemo(() => { memoGit('k', () => ++n); });
  withGitMemo(() => { memoGit('k', () => ++n); });
  assert.equal(n, 2, 'a second call does not see the first call\'s answers');
  assert.equal(inGitMemo(), false, 'the scope ends with the call');

  n = 0;
  await withGitMemo(async () => {
    memoGit('k', () => ++n);
    await new Promise((resolve) => setImmediate(resolve));
    withGitMemo(() => { memoGit('k', () => ++n); });
    assert.equal(memoGit('k', () => ++n), 1);
  });
  assert.equal(n, 1);
});

test('projectRoot is asked once per call, and never answers from an earlier call', (t: any) => {
  const dir = repo(t, 'doflow-memo-root-');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  withGitMemo(() => {
    assert.equal(projectRoot(sub), dir);
    // The repository disappears under the call: the kept answer stands for the rest of this call...
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    assert.equal(projectRoot(sub), dir);
  });
  // ...and the next call asks git again, which no longer names a repository.
  assert.equal(projectRoot(sub), sub);
});

test('projectRoot does not keep the fallback for a path that is not a repository yet', (t: any) => {
  const dir = fs.realpathSync(tempDir(t, 'doflow-memo-fallback-'));
  withGitMemo(() => {
    assert.equal(projectRoot(dir), dir);
    git(dir, 'init', '-q', '-b', 'main');
    assert.equal(projectRoot(dir), dir);
    const nested = path.join(dir, 'n');
    fs.mkdirSync(nested);
    assert.equal(projectRoot(nested), dir);
  });
});

test('a ref the call moves is read again: HEAD is not kept', (t: any) => {
  const dir = repo(t, 'doflow-memo-head-');
  const manager = new WorktreeManager(dir);
  withGitMemo(() => {
    const before = manager.headCommit();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-q', '-m', 'second');
    const after = manager.headCommit();
    assert.notEqual(after, before);
    assert.equal(after, git(dir, 'rev-parse', 'HEAD'));
  });
});

test('the common directory is kept for the call, and a stale record is still dropped in a scope', (t: any) => {
  const dir = repo(t, 'doflow-memo-common-');
  const manager = new WorktreeManager(dir);
  const calls: string[][] = [];
  const real = manager.git.bind(manager);
  manager.git = (args: string[], cwd: string, opts: any) => { calls.push(args); return real(args, cwd, opts); };
  withGitMemo(() => {
    manager.dropStaleRecord(path.join(dir, 'nowhere'));
    manager.dropStaleRecord(path.join(dir, 'nowhere'));
  });
  assert.equal(calls.filter((a) => a.includes('--git-common-dir')).length, 1);
  calls.length = 0;
  manager.dropStaleRecord(path.join(dir, 'nowhere'));
  manager.dropStaleRecord(path.join(dir, 'nowhere'));
  assert.equal(calls.filter((a) => a.includes('--git-common-dir')).length, 2);
});
