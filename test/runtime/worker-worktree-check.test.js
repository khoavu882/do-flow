'use strict';
// worker-worktree-check.test.js — 081 IC-015 (DEC-041): the read-only snapshot of an execution
// worktree and the comparison of two snapshots.
//
// Every case builds a fresh repository with one linked worktree (the execution worktree) under a
// scratch root. git runs with no global or system config and a fixed identity, both for the helper
// below and for the module's own in-process git calls, through the scratch environment.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { snapshot, compare, MAX_PATHS, MAX_HASH_BYTES } = require('../../src/runtime/worker/worktree-check.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { tempDir } = require('../helper/tmp.ts');

const IDENTITY = ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'];

const scratch = createScratch('doflow-worktree-check-env-');
scratch.apply();
for (const key of IDENTITY) delete process.env[key];
after(() => {
  scratch.restore();
  scratch.remove();
});

function git(cwd, ...args) {
  const env = scratch.env();
  for (const key of IDENTITY) delete env[key];
  const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A main checkout with two tracked files, plus a linked worktree on branch `exec`. */
function setup(t) {
  const root = tempDir(t, 'doflow-worktree-check-');
  const main = path.join(root, 'main');
  const exec = path.join(root, 'exec');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(main, 'b.txt'), 'bravo\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'exec', exec);
  return { main, exec };
}

test('an unchanged worktree is clean', (t) => {
  const { exec } = setup(t);
  const before = snapshot(exec);
  assert.equal(before.incomplete, false);
  assert.equal(before.head.ref, 'refs/heads/exec');
  assert.match(before.head.object, /^[0-9a-f]{40}$/);
  assert.match(before.refsDigest, /^[0-9a-f]{64}$/);
  const result = compare(before, snapshot(exec));
  assert.deepEqual(result, { status: 'clean', changes: [], head: { before: before.head, after: before.head }, refsChanged: false });
});

test('an added untracked file is violated as added', (t) => {
  const { exec } = setup(t);
  const before = snapshot(exec);
  fs.writeFileSync(path.join(exec, 'new.txt'), 'new\n');
  const result = compare(before, snapshot(exec));
  assert.equal(result.status, 'violated');
  assert.deepEqual(result.changes, [{ path: 'new.txt', change: 'added' }]);
});

test('a modified tracked file is violated as modified', (t) => {
  const { exec } = setup(t);
  const before = snapshot(exec);
  fs.writeFileSync(path.join(exec, 'a.txt'), 'changed\n');
  const result = compare(before, snapshot(exec));
  assert.equal(result.status, 'violated');
  assert.deepEqual(result.changes, [{ path: 'a.txt', change: 'modified' }]);
});

test('a file already dirty and modified again is violated as modified', (t) => {
  const { exec } = setup(t);
  fs.writeFileSync(path.join(exec, 'a.txt'), 'dirty\n');
  const before = snapshot(exec);
  fs.writeFileSync(path.join(exec, 'a.txt'), 'dirtier\n');
  const result = compare(before, snapshot(exec));
  assert.equal(result.status, 'violated');
  assert.deepEqual(result.changes, [{ path: 'a.txt', change: 'modified' }]);
});

test('a removed file is violated as removed', (t) => {
  const { exec } = setup(t);
  const before = snapshot(exec);
  fs.rmSync(path.join(exec, 'b.txt'));
  const after = snapshot(exec);
  assert.equal(after.paths['b.txt'], 'missing');
  const result = compare(before, after);
  assert.equal(result.status, 'violated');
  assert.deepEqual(result.changes, [{ path: 'b.txt', change: 'removed' }]);
});

test('a HEAD move is violated as head', (t) => {
  const { exec } = setup(t);
  const before = snapshot(exec);
  git(exec, 'commit', '-q', '--allow-empty', '-m', 'worker commit');
  const result = compare(before, snapshot(exec));
  assert.equal(result.status, 'violated');
  assert.deepEqual(result.changes, [{ path: 'refs/heads/exec', change: 'head' }]);
  assert.notEqual(result.head.before.object, result.head.after.object);
});

test('a commit in the other linked worktree sets refsChanged and stays clean', (t) => {
  const { main, exec } = setup(t);
  const before = snapshot(exec);
  fs.writeFileSync(path.join(main, 'a.txt'), 'main edit\n');
  git(main, 'commit', '-q', '-am', 'main session commit');
  const result = compare(before, snapshot(exec));
  assert.equal(result.refsChanged, true);
  assert.equal(result.status, 'clean');
  assert.deepEqual(result.changes, []);
});

test(`${MAX_PATHS + 1} untracked files make the snapshot incomplete and the result unverifiable`, (t) => {
  const { exec } = setup(t);
  const before = snapshot(exec);
  const dir = path.join(exec, 'many');
  fs.mkdirSync(dir);
  for (let i = 0; i <= MAX_PATHS; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), '');
  const after = snapshot(exec);
  assert.equal(after.incomplete, true);
  assert.equal(after.reason, 'too-many-paths');
  assert.equal(compare(before, after).status, 'unverifiable');
});

test('a file of 1 MiB plus one byte is recorded by size and mtime and not read', (t) => {
  const { exec } = setup(t);
  const big = path.join(exec, 'big.bin');
  const edge = path.join(exec, 'edge.bin');
  fs.writeFileSync(big, Buffer.alloc(MAX_HASH_BYTES + 1));
  fs.writeFileSync(edge, Buffer.alloc(MAX_HASH_BYTES));
  const reads = [];
  const original = fs.readFileSync;
  fs.readFileSync = function spy(file, ...rest) {
    reads.push(String(file));
    return original.call(fs, file, ...rest);
  };
  let snap;
  try {
    snap = snapshot(exec);
  } finally {
    fs.readFileSync = original;
  }
  const stat = fs.statSync(big);
  assert.deepEqual(snap.paths['big.bin'], { size: MAX_HASH_BYTES + 1, mtimeMs: stat.mtimeMs });
  assert.ok(!reads.includes(big), 'the oversized file was read');
  assert.match(snap.paths['edge.bin'], /^sha256:[0-9a-f]{64}$/);
  assert.ok(reads.includes(edge));
});

test('a symbolic link is recorded as its target', (t) => {
  const { exec } = setup(t);
  fs.symlinkSync('a.txt', path.join(exec, 'link'));
  assert.equal(snapshot(exec).paths.link, 'link:a.txt');
});

test('a path under the git-ignored .doflow/state is not listed', (t) => {
  const { exec } = setup(t);
  // The state dir's own `.gitignore` is `*`, so it ignores itself and is never committed: the
  // worker's DoFlow run creates it in the execution worktree, as here.
  const state = path.join(exec, '.doflow', 'state');
  const before = snapshot(exec);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, '.gitignore'), '*\n');
  fs.writeFileSync(path.join(state, 'run.json'), '{}\n');
  const after = snapshot(exec);
  assert.ok(!Object.keys(after.paths).some((p) => p.startsWith('.doflow/')));
  assert.equal(compare(before, after).status, 'clean');
});

test('DEC-061 with no .gitignore, ledger.json and an undeclared name under .doflow/state are reported', (t) => {
  const { exec } = setup(t);
  const state = path.join(exec, '.doflow', 'state');
  const before = snapshot(exec);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'ledger.json'), '{}\n');
  fs.writeFileSync(path.join(state, 'evil.sh'), 'echo\n');
  const result = compare(before, snapshot(exec));
  assert.equal(result.status, 'violated');
  assert.deepEqual(result.changes, [
    { path: '.doflow/state/evil.sh', change: 'added' },
    { path: '.doflow/state/ledger.json', change: 'added' },
  ]);
});

test('DEC-061 declared stores are excluded: delivery, .gitignore, a lock; ledger.json is still reported under the real ignore file', (t) => {
  const { exec } = setup(t);
  const state = path.join(exec, '.doflow', 'state');
  const before = snapshot(exec);
  fs.mkdirSync(path.join(state, 'delivery'), { recursive: true });
  fs.writeFileSync(path.join(state, 'delivery', 'x.json'), '{}\n');
  fs.writeFileSync(path.join(state, 'A.1.lock'), '');
  // Not `*`: an ignore file whose content git does not apply to itself, so the store rule alone keeps it out.
  fs.writeFileSync(path.join(state, '.gitignore'), '# not yet written by DoFlow\n');
  assert.equal(compare(before, snapshot(exec)).status, 'clean');

  // DoFlow's own ignore file un-ignores ledger.json, so a worker write there is committable.
  fs.writeFileSync(path.join(state, '.gitignore'), '*\n!/ledger.json\n');
  fs.writeFileSync(path.join(state, 'ledger.json'), '{}\n');
  const result = compare(before, snapshot(exec));
  assert.equal(result.status, 'violated');
  assert.deepEqual(result.changes, [{ path: '.doflow/state/ledger.json', change: 'added' }]);
});

test('DEC-061 a lock-store match is a top-level name only; a directory named like a lock is reported', (t) => {
  const { exec } = setup(t);
  const before = snapshot(exec);
  fs.mkdirSync(path.join(exec, '.doflow', 'state', 'x.lock'), { recursive: true });
  fs.writeFileSync(path.join(exec, '.doflow', 'state', 'x.lock', 'evil.sh'), 'echo\n');
  const result = compare(before, snapshot(exec));
  assert.deepEqual(result.changes, [{ path: '.doflow/state/x.lock/evil.sh', change: 'added' }]);
});

test('DEC-061 an unreadable storage registry makes the snapshot unverifiable', (t) => {
  const { exec } = setup(t);
  const snap = snapshot(exec, { storageFile: path.join(exec, 'no-such-storage.json') });
  assert.equal(snap.incomplete, true);
  assert.equal(snap.reason, 'storage-registry-unreadable');
});

test('DEC-053 .doflow/state is outside the check with no .gitignore; another .doflow path is not', (t) => {
  const { exec } = setup(t);
  const state = path.join(exec, '.doflow', 'state', 'delivery');
  fs.mkdirSync(state, { recursive: true });
  const before = snapshot(exec);
  fs.writeFileSync(path.join(state, 'x.json'), '{}\n');
  const mid = snapshot(exec);
  assert.ok(!fs.existsSync(path.join(exec, '.doflow', 'state', '.gitignore')));
  assert.ok(!Object.keys(mid.paths).some((p) => p.startsWith('.doflow/state/')));
  assert.equal(compare(before, mid).status, 'clean');

  fs.writeFileSync(path.join(exec, '.doflow', 'other.txt'), 'x\n');
  const result = compare(mid, snapshot(exec));
  assert.equal(result.status, 'violated');
  assert.deepEqual(result.changes, [{ path: '.doflow/other.txt', change: 'added' }]);
});

test('taking a snapshot leaves the index mtime unchanged', (t) => {
  const { exec } = setup(t);
  const index = path.resolve(exec, git(exec, 'rev-parse', '--git-path', 'index'));
  // Make the index stat-stale for a tracked file, so a status allowed to write would refresh it.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(index, past, past);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(exec, 'a.txt'), future, future);
  const mtime = fs.statSync(index).mtimeMs;
  snapshot(exec);
  assert.equal(fs.statSync(index).mtimeMs, mtime);
});

test('a non-git directory is incomplete and unverifiable', (t) => {
  const dir = tempDir(t, 'doflow-worktree-check-plain-');
  const snap = snapshot(dir);
  assert.equal(snap.incomplete, true);
  assert.equal(compare(snap, snap).status, 'unverifiable');
});
