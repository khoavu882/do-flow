'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveActiveFeature, PATHS_HELPER } = require('../../src/runtime/feature-resolve');

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
}

function tempRepo(branch) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-resolve-')));
  git(root, 'init', '-q');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (branch) git(root, 'checkout', '-q', '-b', branch);
  return root;
}

test('the resolver script ships beside the module', () => {
  assert.ok(fs.existsSync(PATHS_HELPER));
});

test('a feat/ branch resolves its feature folder and returns the resolver JSON', () => {
  const root = tempRepo('feat/001-demo');
  fs.mkdirSync(path.join(root, 'agent-docs/doflow/001-demo/intention'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-docs/doflow/001-demo/intention/requirement.md'), '# r\n');
  const result = resolveActiveFeature({ projectRoot: root });
  assert.equal(result.error, undefined);
  assert.equal(result.repoRoot, root);
  assert.equal(result.featureDir, path.join(root, 'agent-docs/doflow/001-demo'));
  assert.equal(result.paths.feature_slug, '001-demo');
  assert.equal(result.paths.layout, 'structured');
  assert.equal(result.paths.requirement, 'agent-docs/doflow/001-demo/intention/requirement.md');
  assert.equal(result.paths.has_requirement, true);
  assert.equal(result.paths.has_design, false);
});

test('--slug overrides the branch', () => {
  const root = tempRepo('feat/001-demo');
  fs.mkdirSync(path.join(root, 'agent-docs/doflow/002-other'), { recursive: true });
  const result = resolveActiveFeature({ projectRoot: root, slug: '002-other' });
  assert.equal(result.featureDir, path.join(root, 'agent-docs/doflow/002-other'));
  assert.equal(result.paths.feature_slug, '002-other');
});

test('a trunk branch with no feature folders is a no-feature error with the resolver hint', () => {
  const root = tempRepo(null);
  git(root, 'checkout', '-q', '-B', 'main');
  const result = resolveActiveFeature({ projectRoot: root });
  assert.ok(result.error);
  assert.equal(result.featureDir, undefined);
  assert.match(result.message, /feat\/<NNN-slug>|no/i);
});

test('an ambiguous directory scan names the candidates', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-resolve-nogit-')));
  fs.mkdirSync(path.join(root, 'agent-docs/doflow/001-a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agent-docs/doflow/002-b'), { recursive: true });
  const result = resolveActiveFeature({ projectRoot: root });
  assert.ok(result.error);
  assert.match(result.message, /001-a/);
  assert.match(result.message, /002-b/);
});

test('a missing working directory reports a resolver failure instead of throwing', () => {
  const result = resolveActiveFeature({ projectRoot: path.join(os.tmpdir(), 'doflow-does-not-exist-xyz') });
  assert.ok(result.error);
  assert.ok(result.message);
});
