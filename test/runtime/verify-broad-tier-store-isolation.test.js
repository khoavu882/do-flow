'use strict';

// FU-k9h1df: `doflow verify`'s broad tier runs the project's tests the way contract-runner.ts
// runCheck does, with cwd in the calling checkout and the caller's environment. Run from a linked
// worktree, the suite left context-pack delivery fixtures (T.1, t-legacy, t-no-feat,
// test-spawn-count-task) in that worktree's store, which then refused every record verb with
// store-conflict. This runs the test file that leaked the same way, from a linked worktree of a
// scratch repository, and asserts it writes nothing into the worktree's store, the main checkout's
// store or HOME. The stand-in that writes to the store it resolves is the negative control: it
// proves the check sees a leak.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const LEAKED_FILE = path.resolve(__dirname, 'context-pack-mandatory.test.js');

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

function linkedWorktreeLayout(t) {
  const scratch = createScratch('doflow-verify-iso-');
  t.after(() => scratch.remove());
  const env = scratch.env();
  delete env.FORCE_COLOR;
  // A nested node --test must report on its own, not into this test's runner.
  delete env.NODE_TEST_CONTEXT;
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const main = path.join(scratch.dir, 'main');
  const wt = path.join(scratch.dir, 'wt');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(main, 'README.md'), 'scratch\n');
  git(main, 'add', 'README.md');
  git(main, 'commit', '-q', '-m', 'seed');
  // The main checkout holds a real store; the linked worktree has none of its own.
  fs.mkdirSync(path.join(main, '.doflow', 'state', 'delivery'), { recursive: true });
  fs.writeFileSync(path.join(main, '.doflow', 'state', 'delivery', 'keep.json'), '{}\n');
  git(main, 'worktree', 'add', '-q', '-b', 'fix/verify-iso', wt);
  const snapshot = () => ({
    worktree: filesUnder(path.join(wt, '.doflow')),
    main: filesUnder(path.join(main, '.doflow')),
    home: filesUnder(scratch.home),
  });
  return { env, main, wt, before: snapshot(), snapshot };
}

// Mirrors contract-runner.ts runCheck: shell command, cwd = the checkout verify runs in.
function runLikeVerify(command, { wt, env }) {
  return spawnSync(command, { shell: true, cwd: wt, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

test('FU-k9h1df: the context-pack test file run as verify runs it from a linked worktree writes into no real store', (t) => {
  const layout = linkedWorktreeLayout(t);
  const result = runLikeVerify(`"${process.execPath}" --test "${LEAKED_FILE}"`, layout);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(layout.snapshot(), layout.before,
    'the tests wrote into the worktree store, the main checkout store or HOME');
});

test('FU-k9h1df negative control: a command that writes to the store it resolves is caught', (t) => {
  const layout = linkedWorktreeLayout(t);
  const writer = "const fs=require('fs');fs.mkdirSync('.doflow/state/delivery',{recursive:true});"
    + "fs.writeFileSync('.doflow/state/delivery/T.1.json','{}')";
  const result = runLikeVerify(`"${process.execPath}" -e "${writer}"`, layout);
  assert.equal(result.status, 0, result.stderr);
  assert.notDeepEqual(layout.snapshot(), layout.before);
  assert.deepEqual(layout.snapshot().worktree, ['state/delivery/T.1.json']);
});
