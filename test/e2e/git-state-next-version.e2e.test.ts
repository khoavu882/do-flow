'use strict';
// git-state-next-version.e2e.test.js: do-git-state.sh --next-version in a scratch repository. The base tag
// is JSON null (never the string "null") when no release tag exists, and a v* tag that is not a release
// version (vx, vnext) never wins the version sort.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp.ts');

const SCRIPT = path.join(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-git-state.sh');
const jqOk = spawnSync('jq', ['--version']).status === 0;

function repo() {
  const dir = suiteTempDir('doflow-git-state-');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: any[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q', '-b', 'develop');
  git('commit', '-q', '--allow-empty', '-m', 'chore: init');
  const nextVersion = () => {
    const r = spawnSync('bash', [SCRIPT, '--next-version'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { git, nextVersion };
}

test('a repository with no tag reports base_tag as JSON null, not the string "null"', { skip: !jqOk }, () => {
  const out = repo().nextVersion();
  assert.strictEqual(out.base_tag, null);
  assert.equal(out.bump_kind, 'INITIAL');
});

test('a v* tag that is not a release version does not win the version sort', { skip: !jqOk }, () => {
  const r = repo();
  r.git('tag', 'v1.2.0');
  r.git('commit', '-q', '--allow-empty', '-m', 'fix: later');
  r.git('tag', 'vx');
  r.git('tag', 'vnext');
  const out = r.nextVersion();
  assert.equal(out.base_tag, 'v1.2.0');
  assert.equal(out.current_version, '1.2.0');
  assert.equal(out.next_version, '1.2.1');
});

test('only non-release v* tags leave the repository tagless', { skip: !jqOk }, () => {
  const r = repo();
  r.git('tag', 'vx');
  const out = r.nextVersion();
  assert.strictEqual(out.base_tag, null);
  assert.equal(out.next_version, '1.0.0');
});

test('a pre-release tag is still a release version', { skip: !jqOk }, () => {
  const r = repo();
  r.git('tag', 'v2.0.0-beta.1');
  r.git('tag', 'vx');
  assert.equal(r.nextVersion().base_tag, 'v2.0.0-beta.1');
});

test('FU-8ej091: a stable release outranks its own pre-releases, whatever their numbers', { skip: !jqOk }, () => {
  const r = repo();
  r.git('tag', 'v1.0.0-beta.1');
  r.git('tag', 'v1.0.0-beta.10');
  r.git('tag', 'v1.0.0');
  const out = r.nextVersion();
  assert.equal(out.base_tag, 'v1.0.0');
  assert.equal(out.next_version, '1.0.1');
});

test('FU-8ej091: a tag with a leading zero in a number is not a release version', { skip: !jqOk }, () => {
  const r = repo();
  r.git('tag', 'v01.9.0');
  r.git('tag', 'v1.02.0');
  r.git('tag', 'v1.2.00');
  assert.strictEqual(r.nextVersion().base_tag, null);
  r.git('tag', 'v1.2.0');
  assert.equal(r.nextVersion().base_tag, 'v1.2.0');
});
