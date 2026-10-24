'use strict';
// dispatch-worktree-manager.test.js — 082 IC-016's WorktreeManager amendment (branch prefix,
// bounded git env) and IC-021's removeVerified, on a temp repository.
//
// Every git child the manager starts gets an explicit env: PATH is one scratch bin holding only a
// git symlink (DEC-056), HOME is scratch, global and system git config are off, and the five
// DOFLOW_* identity variables are deleted. Setup git calls use the resolved absolute git path.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { WorktreeManager, BASE_FILE } = require('../../src/runtime/worktree.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

const IS_WIN = process.platform === 'win32';
const CANNOT_DENY_WRITES = IS_WIN || process.getuid?.() === 0;
const REPO_ENV: any = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];
const IDENTITY: any = ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'];

function resolveGit() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, IS_WIN ? 'git.exe' : 'git');
    if (dir && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  throw new Error('git not found on PATH');
}

const GIT = resolveGit();
let root: any;
let ENV: any;

function git(cwd: any, ...args: any[]) {
  const res = spawnSync(GIT, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function makeRepo(name: any) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), `${name}\n`);
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function hasBranch(repo: any, branch: any): any {
  return spawnSync(GIT, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, env: ENV }).status === 0;
}

before(() => {
  root = suiteTempDir('doflow-dispatch-wtm-');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(GIT, path.join(bin, path.basename(GIT)));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  ENV = { PATH: bin, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of [...REPO_ENV, ...IDENTITY]) delete ENV[key];
});

test('default prefix gives task/<id>', () => {
  const repo = makeRepo('default');
  const mgr: any = new WorktreeManager(repo, path.join(repo, 'wts'), { env: ENV });
  assert.equal(mgr.branchFor('x1'), 'task/x1');
  mgr.create('x1');
  assert.ok(hasBranch(repo, 'task/x1'));
  assert.equal(new WorktreeManager(repo).branchFor('x1'), 'task/x1');
});

test('attempt prefix creates its branch and records the base; removeVerified verifies it', () => {
  const repo = makeRepo('attempt');
  const head = git(repo, 'rev-parse', 'HEAD');
  const dir = path.join(repo, '.doflow', 'state', 'dispatch-worktrees');
  const mgr: any = new WorktreeManager(repo, dir, { branchPrefix: 'doflow-attempt/s/', timeoutMs: 120000, env: ENV });
  const id = 'd-0123456789ab';
  const wt = mgr.create(id, head);
  assert.equal(wt, path.join(dir, id));
  assert.ok(hasBranch(repo, `doflow-attempt/s/${id}`));
  assert.equal(fs.readFileSync(path.join(wt, BASE_FILE), 'utf8'), `${head}\n`);

  const removal = mgr.removeVerified(id);
  assert.deepEqual(
    { path: removal.path, branch: removal.branch, pathGone: removal.pathGone, branchGone: removal.branchGone, unregistered: removal.unregistered, verified: removal.verified },
    { path: wt, branch: `doflow-attempt/s/${id}`, pathGone: true, branchGone: true, unregistered: true, verified: true },
  );
  assert.ok(!hasBranch(repo, `doflow-attempt/s/${id}`));
});

test('a read-only parent directory reports an unverified removal with codes only', {
  skip: CANNOT_DENY_WRITES ? (IS_WIN ? 'tree cleanup is unverified on win32 (NFR-005)' : 'root ignores directory permissions (RK11)') : false,
}, (t) => {
  const repo = makeRepo('readonly');
  const dir = path.join(repo, '.doflow', 'state', 'dispatch-worktrees');
  const mgr: any = new WorktreeManager(repo, dir, { branchPrefix: 'doflow-attempt/s/', env: ENV });
  const id = 'd-aaaaaaaaaaaa';
  const wt = mgr.create(id);
  fs.chmodSync(dir, 0o555);
  t.after(() => fs.chmodSync(dir, 0o755));

  const removal = mgr.removeVerified(id);
  assert.equal(removal.verified, false);
  assert.equal(removal.pathGone, false);
  assert.ok(fs.existsSync(wt));
  assert.ok(removal.errors.length > 0, 'a failed step is recorded');
  for (const e of removal.errors) assert.match(e, /^[A-Za-z0-9_]{1,16}$/, `error ${JSON.stringify(e)} is a code, not git output`);
});

test('a GIT_DIR in the test process does not redirect a manager given an env without it', (t) => {
  const repo = makeRepo('target');
  const other = makeRepo('decoy');
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(other, '.git');
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  });
  const mgr: any = new WorktreeManager(repo, path.join(repo, 'wts'), { branchPrefix: 'doflow-attempt/s/', env: ENV });
  mgr.create('d-bbbbbbbbbbbb');
  assert.ok(hasBranch(repo, 'doflow-attempt/s/d-bbbbbbbbbbbb'));
  assert.ok(!hasBranch(other, 'doflow-attempt/s/d-bbbbbbbbbbbb'));
  assert.equal(mgr.removeVerified('d-bbbbbbbbbbbb').verified, true);
});

test('create and remove leave an unrelated missing worktree record alone and drop only their own stale record (FU-mysatc)', () => {
  const repo = makeRepo('prune-scope');
  // A worktree of the user's own whose directory is gone: git lists it as prunable.
  const elsewhere = path.join(root, 'prune-scope-elsewhere');
  git(repo, 'worktree', 'add', '-q', '-b', 'user/side', elsewhere);
  fs.rmSync(elsewhere, { recursive: true, force: true });
  const listed = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l: any) => l.startsWith('worktree ')).map((l: any) => fs.realpathSync(path.dirname(path.resolve(l.slice(9)))) + path.sep + path.basename(l.slice(9)));
  const userRecord = fs.realpathSync(path.dirname(elsewhere)) + path.sep + path.basename(elsewhere);
  assert.ok(listed().includes(userRecord), 'setup: the missing worktree is still recorded');

  const mgr: any = new WorktreeManager(repo, path.join(repo, 'wts'), { env: ENV });
  // A leftover directory git does not know about: create clears it, then adds the worktree.
  fs.mkdirSync(path.join(repo, 'wts', 'own-1'), { recursive: true });
  const wt = mgr.create('own-1');
  assert.ok(fs.existsSync(path.join(wt, BASE_FILE)));
  assert.ok(listed().includes(userRecord), 'create did not prune the unrelated record');

  // Its own directory deleted behind git's back: the record is stale, and remove drops it.
  fs.rmSync(wt, { recursive: true, force: true });
  const removal = mgr.removeVerified('own-1');
  assert.deepEqual([removal.pathGone, removal.branchGone, removal.unregistered, removal.verified], [true, true, true, true]);
  assert.ok(listed().includes(userRecord), 'removeVerified did not prune the unrelated record');
  assert.ok(!mgr.isRegistered(wt), 'its own stale record is gone');

  // The same through remove(), and a second remove of something absent stays a success.
  mgr.create('own-2');
  fs.rmSync(path.join(repo, 'wts', 'own-2'), { recursive: true, force: true });
  mgr.remove('own-2');
  mgr.remove('own-2');
  assert.ok(!mgr.isRegistered(path.join(repo, 'wts', 'own-2')));
  assert.ok(!hasBranch(repo, 'task/own-2'));
  assert.ok(listed().includes(userRecord), 'remove did not prune the unrelated record');
});
