'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin/doflow.js');
const PACKAGED = path.join(REPO, 'core/registry/gates.json');

function project(t: any) {
  const root = tempDir(t, 'doflow-init-policy-');
  cp.execFileSync('git', ['-C', root, 'init', '-q', '-b', 'develop']);
  return root;
}
const run = (root: any, ...extra: any[]) => cp.spawnSync(process.execPath, [CLI, 'roadmap', '--action', 'init-policy', ...extra], { cwd: root, encoding: 'utf8' });

test('init-policy writes the packaged policy, stages nothing, and says to commit it on develop', (t) => {
  const root = project(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(root, 'core/registry/gates.json')), fs.readFileSync(PACKAGED));
  assert.match(result.stdout, /commit this on develop/);
  assert.equal(cp.execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim(), '?? core/registry/gates.json');
  assert.equal(cp.execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim(), '', 'nothing is staged');
});

test('init-policy refuses to overwrite an existing file (exit 1) and leaves it untouched', (t) => {
  const root = project(t);
  const file = path.join(root, 'core/registry/gates.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"mine":true}\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mine":true}\n');
});

test('init-policy --json reports the written path', (t) => {
  const root = project(t);
  const result = run(root, '--json');
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual([out.schema, out.action, out.written], [1, 'init-policy', 'core/registry/gates.json']);
});
