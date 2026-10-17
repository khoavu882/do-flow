'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { parseArgs, runPreflight } = require('../../src/release/preflight.ts');

const VERSION = '2.0.0-beta.6';
const TAG = `v${VERSION}`;
const MANIFESTS = [
  'core/.codex-plugin/plugin.json',
  'core/.claude-plugin/plugin.json',
  'core/.plugin/plugin.json',
];
const WORKFLOW = `jobs:
  publish:
    steps:
      - name: Publish
        run: |
          case "$GITHUB_REF_NAME" in
            *-*) npm publish .pack --provenance --tag beta ;;
            *) npm publish .pack --provenance ;;
          esac
`;

function fixture(t, options = {}) {
  const root = tempDir(t, 'doflow-preflight-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: VERSION }, null, 2));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${VERSION}] - 2026-10-18\n\n### Added\n- Release notes.\n`);
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows/release.yml'), WORKFLOW);
  for (const rel of MANIFESTS) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: options.manifestVersion || VERSION }, null, 2));
  }

  const calls = [];
  const execFileSyncImpl = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'tag') return options.tagExists ? `${TAG}\n` : '';
    if (command === 'git' && args[0] === 'status') return options.dirty ? ' M package.json\n' : '';
    if (command === 'npm' && args[0] === 'view') {
      if (options.networkError) throw Object.assign(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'), { code: 'ENOTFOUND' });
      return JSON.stringify(options.published ? [VERSION] : []);
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const result = runPreflight({ repoRoot: root, tag: options.tag || TAG, offline: options.offline || false, execFileSyncImpl });
  return { root, calls, result };
}

function check(result, id) {
  const found = result.checks.find((entry) => entry.id === id);
  assert.ok(found, `missing check ${id}`);
  return found;
}

test('preflight passes the beta release policy and all clean fixture checks', (t) => {
  const { result } = fixture(t);
  assert.equal(result.ok, true);
  for (const id of ['manifest-versions', 'tag-matches-version', 'tag-unused', 'npm-unpublished', 'changelog', 'publish-dist-tag', 'clean-tree']) {
    assert.equal(check(result, id).ok, true, id);
  }
});

test('manifest version drift fails its check', (t) => {
  const { result } = fixture(t, { manifestVersion: '2.0.0' });
  assert.equal(check(result, 'manifest-versions').ok, false);
});

test('a requested tag that does not match package.json fails', (t) => {
  const { result } = fixture(t, { tag: 'v2.0.0-beta.5' });
  assert.equal(check(result, 'tag-matches-version').ok, false);
});

test('an existing local release tag fails', (t) => {
  const { result } = fixture(t, { tagExists: true });
  assert.equal(check(result, 'tag-unused').ok, false);
});

test('an already-published npm version fails', (t) => {
  const { result } = fixture(t, { published: true });
  assert.equal(check(result, 'npm-unpublished').ok, false);
});

test('a missing or empty changelog section fails', (t) => {
  const { root } = fixture(t);
  const run = () => runPreflight({ repoRoot: root, tag: TAG, offline: true, execFileSyncImpl: () => '' });
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n');
  assert.equal(check(run(), 'changelog').ok, false, 'missing section');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${VERSION}] - 2026-10-18\n\n## [2.0.0-beta.5] - 2026-10-14\n`);
  assert.equal(check(run(), 'changelog').ok, false, 'empty section');
});

test('a prerelease workflow that omits beta or routes it to latest fails', (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, '.github/workflows/release.yml'), WORKFLOW.replace('--tag beta', '--tag latest'));
  const result = runPreflight({ repoRoot: root, tag: TAG, offline: true, execFileSyncImpl: () => '' });
  assert.equal(check(result, 'publish-dist-tag').ok, false);
});

test('a dirty working tree fails', (t) => {
  const { result } = fixture(t, { dirty: true });
  assert.equal(check(result, 'clean-tree').ok, false);
});

test('--offline clearly skips the registry check without running npm', (t) => {
  const { calls, result } = fixture(t, { offline: true });
  const published = check(result, 'npm-unpublished');
  assert.equal(published.skipped, true);
  assert.match(published.message, /offline/);
  assert.equal(calls.some(([command]) => command === 'npm'), false);
});

test('a registry network failure is reported as a clear skip', (t) => {
  const { result } = fixture(t, { networkError: true });
  const published = check(result, 'npm-unpublished');
  assert.equal(published.skipped, true);
  assert.match(published.message, /registry unavailable/);
});

test('CLI arguments accept an optional tag and offline switch', () => {
  assert.deepEqual(parseArgs(['--tag', TAG, '--offline']), { tag: TAG, offline: true });
  assert.throws(() => parseArgs(['--tag']), /usage:/);
});
