'use strict';
// checkouts.test.js — the repository's checkouts from one `git worktree list`, and a state file
// looked up in the current checkout first, then in the others.
//
// Every repository is built under one scratch root removed when the file finishes; git runs with
// no global config and a fixed identity, so nothing here reads or writes the user's settings.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { listCheckouts, findStateFile, clearCheckoutCache } = require('../../src/runtime/checkouts');
const { BASE_FILE } = require('../../src/runtime/worktree');

const { createScratch } = require('../helper/scratch-env');

// The scratch environment is this process's, so git spawned in-process by listCheckouts, as well as
// the helper below, reads no real HOME, global or system git config.
const scratch = createScratch('doflow-checkouts-env-');
scratch.apply();
after(() => {
  scratch.restore();
  scratch.remove();
});
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };

function git(cwd, ...args) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

let root;
const at = {};

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-checkouts-')));
  at.m = path.join(root, 'm');
  fs.mkdirSync(at.m);
  git(at.m, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(at.m, 'a.txt'), 'a\n');
  git(at.m, 'add', 'a.txt');
  git(at.m, 'commit', '-q', '-m', 'base');
  for (const name of ['wt', 'wt2', 'sb', 'gone']) {
    at[name] = path.join(root, name);
    git(at.m, 'worktree', 'add', '-q', '-b', `feat/${name}`, at[name]);
  }
  fs.writeFileSync(path.join(at.sb, BASE_FILE), 'abc\n');
  fs.rmSync(at.gone, { recursive: true, force: true });
  at.sub = path.join(at.wt, 'deep', 'er');
  fs.mkdirSync(at.sub, { recursive: true });

  at.bare = path.join(root, 'bare.git');
  git(root, 'clone', '-q', '--bare', at.m, at.bare);
  at.bw = path.join(root, 'bw');
  git(at.bare, 'worktree', 'add', '-q', '-b', 'feat/bw', at.bw);

  at.plain = path.join(root, 'plain');
  fs.mkdirSync(at.plain);
});

after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function list(cwd, exec) {
  clearCheckoutCache();
  return listCheckouts(exec ? { cwd, exec } : { cwd });
}

test('the main checkout is not linked and sees its linked worktrees, never a sandbox or a deleted one', () => {
  const r = list(at.m);
  assert.equal(r.ok, true);
  assert.equal(r.current, at.m);
  assert.equal(r.main, at.m);
  assert.equal(r.mainReason, null);
  assert.equal(r.isLinked, false);
  assert.equal(r.sandbox, false);
  assert.deepEqual(r.others, [at.wt, at.wt2]);
});

test('a linked worktree names the main checkout and holds it in others', () => {
  const r = list(at.wt);
  assert.equal(r.current, at.wt);
  assert.equal(r.main, at.m);
  assert.equal(r.isLinked, true);
  assert.deepEqual(r.others, [at.m, at.wt2]);
});

test('a cwd in a subdirectory of a worktree resolves to that worktree', () => {
  const r = list(at.sub);
  assert.equal(r.current, at.wt);
  assert.equal(r.main, at.m);
  assert.equal(r.isLinked, true);
});

test('a worktree of a bare clone has no main checkout', () => {
  const r = list(at.bw);
  assert.equal(r.ok, true);
  assert.equal(r.current, at.bw);
  assert.equal(r.main, null);
  assert.equal(r.mainReason, 'bare');
  assert.equal(r.isLinked, false);
  assert.deepEqual(r.others, []);
});

test('a directory outside any repository is not a git repository', () => {
  const r = list(at.plain);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-a-git-repository');
  assert.equal(r.current, null);
  assert.equal(r.main, null);
  assert.deepEqual(r.others, []);
});

test('a sandbox sees no other checkout and has no main', () => {
  const r = list(at.sb);
  assert.equal(r.sandbox, true);
  assert.equal(r.current, at.sb);
  assert.equal(r.main, null);
  assert.equal(r.mainReason, 'sandbox');
  assert.equal(r.isLinked, false);
  assert.deepEqual(r.others, []);
});

test('git missing from PATH is git-unavailable', () => {
  const enoent = () => ({ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) });
  const r = list(at.m, enoent);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'git-unavailable');
  assert.deepEqual(r.others, []);
});

test('two calls on the same cwd run git once', () => {
  let calls = 0;
  const exec = (...args) => { calls += 1; return spawnSync(...args); };
  clearCheckoutCache();
  const first = listCheckouts({ cwd: at.wt, exec });
  const second = listCheckouts({ cwd: at.wt, exec });
  assert.equal(calls, 1);
  assert.equal(second, first);
});

// ── findStateFile ────────────────────────────────────────────────────────────────────────────────

const REL = path.join('.doflow', 'state', 'orchestration', 'T.json');

function place(dir, rel = REL) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), '{}\n');
}

function unplace(...dirs) {
  for (const dir of dirs) fs.rmSync(path.join(dir, '.doflow'), { recursive: true, force: true });
}

const noGit = () => { throw new Error('git must not run when the file is in the current checkout'); };

test('findStateFile: a file in the current checkout is found without a git call', () => {
  place(at.wt);
  place(at.m);
  try {
    clearCheckoutCache();
    const r = findStateFile({ stateRoot: at.wt, relPath: REL, exec: noGit });
    assert.deepEqual(r, { status: 'found', file: path.join(at.wt, REL), root: at.wt, origin: 'current', candidates: [] });
  } finally { unplace(at.wt, at.m); }
});

test('findStateFile: a file in exactly one other checkout is found there', () => {
  place(at.m);
  try {
    clearCheckoutCache();
    const r = findStateFile({ stateRoot: at.wt, relPath: REL });
    assert.deepEqual(r, { status: 'found', file: path.join(at.m, REL), root: at.m, origin: 'other', candidates: [] });
  } finally { unplace(at.m); }
});

test('findStateFile: the same file in two other checkouts is ambiguous and names both', () => {
  place(at.m);
  place(at.wt2);
  try {
    clearCheckoutCache();
    const r = findStateFile({ stateRoot: at.wt, relPath: REL });
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.file, null);
    assert.deepEqual(r.candidates, [path.join(at.m, REL), path.join(at.wt2, REL)]);
  } finally { unplace(at.m, at.wt2); }
});

test('findStateFile: a file in no checkout is missing', () => {
  clearCheckoutCache();
  assert.deepEqual(findStateFile({ stateRoot: at.wt, relPath: REL }),
    { status: 'missing', file: null, root: null, origin: null, candidates: [] });
});

test('findStateFile: a sandbox never reads another checkout', () => {
  place(at.m);
  try {
    clearCheckoutCache();
    assert.equal(findStateFile({ stateRoot: at.sb, relPath: REL }).status, 'missing');
  } finally { unplace(at.m); }
});

test('findStateFile: a relPath function chooses the path per checkout, and null skips a root', () => {
  place(at.m, path.join('.doflow', 'other', 'T.json'));
  place(at.wt);
  try {
    clearCheckoutCache();
    const relPath = (_root, isCurrent) => (isCurrent ? null : path.join('.doflow', 'other', 'T.json'));
    const r = findStateFile({ stateRoot: at.wt, relPath });
    assert.equal(r.status, 'found');
    assert.equal(r.origin, 'other');
    assert.equal(r.file, path.join(at.m, '.doflow', 'other', 'T.json'));
  } finally { unplace(at.m, at.wt); }
});
