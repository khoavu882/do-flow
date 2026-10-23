'use strict';

// FU-k9h1df: `doflow verify`'s broad tier runs the project's tests the way contract-runner.ts
// runCheck does, with cwd in the calling checkout. Run from a linked worktree, the suite left
// context-pack delivery fixtures (T.1, t-legacy, t-no-feat, test-spawn-count-task) in that
// worktree's store, which then refused every record verb with store-conflict. This runs the test
// file that leaked with the same shell and cwd, from a linked worktree of a scratch repository, and
// asserts it adds, removes or changes no file in the worktree's store, the main checkout's store,
// HOME or XDG_CONFIG_HOME. It models cwd-relative and HOME/XDG-relative writes; the environment is
// the scratch one (telemetry off, no global git config), not the caller's. The writer controls,
// one per root plus two overwrites, prove the snapshot sees each leak shape.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const LEAKED_FILE = path.resolve(__dirname, 'context-pack-mandatory.test.js');

/** Every file under `dir`, relative path -> sha256 of its content. */
function filesUnder(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
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
    xdg: filesUnder(scratch.xdg),
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
    'the tests changed the worktree store, the main checkout store, HOME or XDG_CONFIG_HOME');
});

// Negative controls: a command that writes `file` under one root, resolved the way a leaking test
// would (cwd, an absolute main-checkout path, $HOME, $XDG_CONFIG_HOME), must change that root only.
const CONTROLS = [
  { name: 'new file in the worktree store', root: 'worktree', base: () => 'process.cwd()', file: '.doflow/state/delivery/T.1.json' },
  { name: 'new file in the main checkout store', root: 'main', base: (l) => JSON.stringify(l.main), file: '.doflow/state/delivery/T.1.json' },
  { name: 'new file under HOME', root: 'home', base: () => 'process.env.HOME', file: '.doflow/state/delivery/T.1.json' },
  { name: 'new file under XDG_CONFIG_HOME', root: 'xdg', base: () => 'process.env.XDG_CONFIG_HOME', file: 'doflow/leaked.json' },
  { name: 'overwrite of the main store keep.json', root: 'main', base: (l) => JSON.stringify(l.main), file: '.doflow/state/delivery/keep.json' },
  { name: 'overwrite of XDG doflow/prune', root: 'xdg', base: () => 'process.env.XDG_CONFIG_HOME', file: 'doflow/prune' },
];

for (const control of CONTROLS) {
  test(`FU-k9h1df negative control: ${control.name} is caught`, (t) => {
    const layout = linkedWorktreeLayout(t);
    const target = `require('path').join(${control.base(layout)},${JSON.stringify(control.file)})`;
    const writer = `const fs=require('fs'),p=require('path'),f=${target};`
      + "fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,'leaked\\n')";
    const result = runLikeVerify(`"${process.execPath}" -e ${JSON.stringify(writer)}`, layout);
    assert.equal(result.status, 0, result.stderr);
    const after = layout.snapshot();
    assert.notDeepEqual(after, layout.before);
    for (const root of Object.keys(after)) {
      if (root === control.root) assert.notDeepEqual(after[root], layout.before[root], `${root} change not seen`);
      else assert.deepEqual(after[root], layout.before[root], `${root} changed by a ${control.root} writer`);
    }
  });
}
