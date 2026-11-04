'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { bashPath } = require('../helper/bash-locator.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const SOURCE_RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const OUTPUT = '{"ok":true}\n';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function checkoutCase(t: any, name: string, setup: (root: string) => void) {
  const scratch = tempDir(t, `doflow-stale-runtime-${name}-`);
  const root = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"@khoavu882/doflow"}\n');
  fs.writeFileSync(path.join(root, 'bin/doflow.js'), `process.stdout.write(${JSON.stringify(OUTPUT)});\n`);
  setup(root);

  const dispatcher = path.join(scratch, 'installed/scripts/doflow/bin/doflow-run');
  fs.mkdirSync(path.dirname(dispatcher), { recursive: true });
  fs.copyFileSync(SOURCE_RUN, dispatcher);
  const config = path.join(scratch, 'config');
  const result = spawnSync(bashPath(), [dispatcher, 'workflow', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DOFLOW_CONFIG_DIR: config, DOFLOW_FAILURE_CAPTURE: 'off' },
  });
  assert.equal(result.status, 0, `dispatcher failed: ${result.stderr}`);
  assert.equal(result.stdout, OUTPUT, 'the runtime warning must not change JSON stdout');
  return { result, runtime: path.join(root, 'bin/doflow.js'), head: git(root, 'rev-parse', 'HEAD') };
}

function initialCommit(root: string, branch = 'develop') {
  git(root, 'init', '-b', branch);
  git(root, 'config', 'user.name', 'DoFlow Test');
  git(root, 'config', 'user.email', 'doflow-test@example.invalid');
  fs.writeFileSync(path.join(root, 'state.txt'), 'initial\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
}

function commitChange(root: string, value: string, message: string) {
  fs.writeFileSync(path.join(root, 'state.txt'), `${value}\n`);
  git(root, 'add', 'state.txt');
  git(root, 'commit', '-m', message);
}

test('FU-cwz2sr: only a checkout-pwd runtime strictly behind local develop warns', (t) => {
  const behind = checkoutCase(t, 'behind', (root) => {
    initialCommit(root);
    const oldHead = git(root, 'rev-parse', 'HEAD');
    commitChange(root, 'develop', 'develop advance');
    git(root, 'checkout', '--detach', oldHead);
  });
  assert.equal((behind.result.stderr.match(/\n/g) || []).length, 1);
  assert.match(behind.result.stderr, new RegExp(`selected runtime ${behind.runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} at ${behind.head} is behind local develop`));

  for (const name of ['equal', 'ahead', 'divergent', 'absent-develop']) {
    const sample = checkoutCase(t, name, (root) => {
      if (name === 'absent-develop') {
        initialCommit(root, 'main');
        return;
      }
      initialCommit(root);
      if (name === 'equal') return;
      if (name === 'ahead') {
        git(root, 'checkout', '-b', 'feature');
        commitChange(root, 'feature', 'feature advance');
        return;
      }
      git(root, 'checkout', '-b', 'feature');
      commitChange(root, 'feature', 'feature advance');
      git(root, 'checkout', 'develop');
      commitChange(root, 'develop', 'develop advance');
      git(root, 'checkout', 'feature');
    });
    assert.equal(sample.result.stderr, '', `${name} must not warn`);
  }
});
