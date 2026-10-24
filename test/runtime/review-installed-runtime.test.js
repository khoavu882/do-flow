'use strict';

// `review --action start` and `protocol --action resolve` through every harness's `doflow-run` shim after a real
// `doflow install -g` of every harness into a scratch HOME (FU-nnmpc9). The installed runtime
// (`~/.doflow/runtime`) holds only the `runtime.*` trees, bin/, src/ and core/registry/, and no core/shared; the
// checkout-run suites have core/shared beside the code, so a runtime read of core/shared fails only here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { IS_WIN } = require('../helper-platform');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry/index.ts');

const SKIP = IS_WIN ? 'the doflow-run shim is POSIX shell' : false;
const HARNESSES = loadRegistry({ repoRoot: REPO_ROOT }).harnesses.map((harness) => harness.id);

/** Every `bin/doflow-run` shim under `dir`, relative to it, sorted. */
function shimsUnder(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const next = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...shimsUnder(dir, next));
    else if (entry.name === 'doflow-run' && path.basename(rel) === 'bin') out.push(next);
  }
  return out.sort();
}

/** One scratch HOME with every harness installed, and a git repository of two commits outside it. */
function setup() {
  const scratch = createScratch('doflow-installed-review-');
  const env = scratch.env({ DOFLOW_CONFIG_DIR: '', DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '' });
  const install = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'doflow.js'), 'install', '-g', '-f', '--no-backup', '-t', HARNESSES.join(',')],
    { cwd: scratch.dir, env, encoding: 'utf8', input: '\n' });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const runtime = path.join(scratch.home, '.doflow', 'runtime');
  assert.ok(fs.existsSync(path.join(runtime, 'core', 'registry')), 'the install wrote the runtime');
  assert.equal(fs.existsSync(path.join(runtime, 'core', 'shared')), false, 'an installed runtime carries no core/shared');
  const repo = path.join(scratch.dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'develop');
  for (const name of ['a.txt', 'b.txt']) {
    fs.writeFileSync(path.join(repo, name), `${name}\n`);
    git('add', name);
    git('commit', '-q', '-m', name);
  }
  // The shared dispatcher under ~/.doflow/scripts is the shim the skills call, so it is run too.
  const shims = shimsUnder(scratch.home);
  const run = (shim, args) => spawnSync('bash', [path.join(scratch.home, shim), ...args], { cwd: repo, env, encoding: 'utf8' });
  return { scratch, shims, run };
}

/** The reviewer seat binding and its eight enforcement rows, as the checkout resolves them. */
function assertReviewerEnforcement(protocol, where) {
  assert.ok(protocol.seats.length > 0 && protocol.seats.every((seat) => seat.agent === 'reviewer'), `${where}: seats bind reviewer`);
  assert.deepEqual(protocol.enforcement.map((row) => row.harness), HARNESSES, `${where}: one row per harness`);
  assert.deepEqual(protocol.enforcement.filter((row) => row.status === 'unenforced').map((row) => row.harness), ['codex', 'pi', 'antigravity'], where);
  assert.equal(protocol.enforcement.filter((row) => row.status === 'native').length, HARNESSES.length - 3, where);
}

test('installed runtime: protocol resolve and review start work through every harness shim', { skip: SKIP }, () => {
  const { scratch, shims, run } = setup();
  try {
    // One shim per harness, except gemini and antigravity, which share ~/.gemini/config/bin; copilot's is
    // ~/.agents/bin. Plus the shared dispatcher the skills call.
    assert.deepEqual(shims, [
      '.agents/bin/doflow-run', '.claude/bin/doflow-run', '.codex/bin/doflow-run', '.config/opencode/bin/doflow-run',
      '.doflow/scripts/doflow/bin/doflow-run', '.gemini/config/bin/doflow-run', '.kiro/bin/doflow-run', '.pi/agent/bin/doflow-run',
    ].map((rel) => rel.split('/').join(path.sep)));
    for (const shim of shims) {
      const resolved = run(shim, ['protocol', '--action', 'resolve', '--kind', 'review', '--json']);
      assert.equal(resolved.status, 0, `${shim} protocol resolve: ${resolved.stdout}${resolved.stderr}`);
      const protocol = JSON.parse(resolved.stdout);
      assert.equal(protocol.ok, true, resolved.stdout);
      assertReviewerEnforcement(protocol.protocol, `${shim} protocol resolve`);

      const started = run(shim, ['review', '--action', 'start', '--base', 'HEAD~1', '--json']);
      assert.equal(started.status, 0, `${shim} review start: ${started.stdout}${started.stderr}`);
      assert.doesNotMatch(started.stdout + started.stderr, /protocols-invalid|agent-specs/, shim);
      const review = JSON.parse(started.stdout);
      assert.ok(review.protocol, started.stdout);
      assertReviewerEnforcement(review.protocol, `${shim} review start`);
    }
    const text = run(shims[0], ['protocol', '--action', 'resolve', '--kind', 'review']);
    assert.match(text.stdout, /^protocol\.enforcement: reviewer native=claude,gemini,opencode,copilot,kiro unenforced=codex,pi,antigravity$/m);
  } finally { scratch.remove(); }
});
