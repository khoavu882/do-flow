'use strict';
// slug-safety.test.js — a feature slug becomes a directory name and a state key, so the resolver and
// the branch-name verb refuse one that could name a path (feature 045, IC-009; FR-013).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BASH = path.join(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bash');
const PATHS = path.join(BASH, 'do-paths.sh');
const GIT_STATE = path.join(BASH, 'do-git-state.sh');

function repo(branch = 'main') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-slug-')));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  if (branch !== 'main') git('checkout', '-q', '-b', branch);
  return root;
}

function run(script, args, cwd) {
  const res = spawnSync('bash', [script, ...args], { cwd, encoding: 'utf8' });
  let data = null;
  try { data = JSON.parse(res.stdout); } catch { /* asserted by the caller */ }
  return { status: res.status, data, stdout: res.stdout };
}

const UNSAFE = ['../x', 'a/b', '..', 'a..b', '-flag', '.hidden', 'has space', 'semi;colon'];
const SAFE = [
  '041-cross-scope-inventory', '042-agentic-orchestration', '043-orchestrator-model-policy',
  '044-decision-register', '045-register-followups', 'ABC-123-x', 'v1.2.3-fix', 'a_b',
];

test('do-paths refuses an unsafe --slug with exit 2 and an invalid-slug error before any path is built', () => {
  const root = repo();
  for (const slug of UNSAFE) {
    const res = run(PATHS, ['--json', `--slug=${slug}`], root);
    assert.equal(res.status, 2, `--slug=${slug}`);
    assert.equal(res.data.error, 'invalid-slug', slug);
    assert.match(res.data.message, /not a valid feature slug/);
    assert.equal(res.data.feature_dir, undefined, 'no path was built');
  }
});

test('do-paths refuses it under --require feature and --paths-only as well', () => {
  const root = repo();
  assert.equal(run(PATHS, ['--json', '--require', 'feature', '--slug=../x'], root).status, 2);
  assert.equal(run(PATHS, ['--paths-only', '--slug=a/b'], root).status, 2);
});

test('do-paths accepts every slug shape the repository uses', () => {
  const root = repo();
  for (const slug of SAFE) {
    const res = run(PATHS, ['--json', `--slug=${slug}`], root);
    assert.equal(res.status, 0, slug);
    assert.equal(res.data.feature_slug, slug);
    assert.equal(res.data.feature_dir, `agent-docs/doflow/${slug}`);
  }
});

test('do-paths applies the same rule to a slug derived from the branch', () => {
  for (const slug of SAFE) {
    const res = run(PATHS, ['--json'], repo(`feat/${slug}`));
    assert.equal(res.status, 0, slug);
    assert.equal(res.data.feature_slug, slug);
  }
  const bad = repo('fix/issue#12');
  const res = run(PATHS, ['--json'], bad);
  assert.equal(res.status, 2);
  assert.equal(res.data.error, 'invalid-slug');
  // The git-state helper needs the repository, not a feature, so such a branch is still reported.
  const state = run(GIT_STATE, ['--state'], bad);
  assert.equal(state.status, 0);
  assert.equal(state.data.branch, 'fix/issue#12');
});

test('git-state --branch-name refuses an unsafe slug with exit 2 and accepts the safe ones', () => {
  const root = repo();
  for (const slug of UNSAFE) {
    const res = run(GIT_STATE, ['--branch-name', '--class=feature', `--slug=${slug}`], root);
    assert.equal(res.status, 2, `--slug=${slug}`);
    assert.equal(res.data.error, 'invalid-slug', slug);
  }
  for (const slug of SAFE) {
    const res = run(GIT_STATE, ['--branch-name', '--class=feature', `--slug=${slug}`], root);
    assert.equal(res.status, 0, slug);
    assert.equal(res.data.name, `feat/${slug}`);
  }
});
