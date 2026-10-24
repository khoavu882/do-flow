'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { parseArgs, runPreflight } = require('../../src/release/preflight.ts');

const VERSION = '2.0.0-beta.6';
const TAG = 'v' + VERSION;
const MANIFESTS = [
  'core/.codex-plugin/plugin.json',
  'core/.claude-plugin/plugin.json',
  'core/.plugin/plugin.json',
];
const VALID_WORKFLOW = fs.readFileSync(
  path.join(__dirname, '../fixtures/release/release-valid.yml'),
  'utf8',
);

function fixture(t: any, options: any = {}) {
  const version = options.version || VERSION;
  const tag = options.tag || 'v' + version;
  const root = tempDir(t, 'doflow-preflight-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version, engines: { node: options.engines || '>=24.22.1' } }, null, 2));
  const changelog = options.changelog === undefined
    ? '# Changelog\n\n## [' + version + '] - 2026-10-18\n\n### Added\n- Release notes.\n'
    : options.changelog;
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows/release.yml'),
    options.workflow === undefined ? VALID_WORKFLOW : options.workflow);
  for (const rel of MANIFESTS) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: options.manifestVersion || version }, null, 2));
  }

  const calls: any = [];
  const execFileSyncImpl = (command: any, args: any) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'tag' && args[1] === '--list') {
      return options.tagExists ? tag + '\n' : '';
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--verify') return options.tagCommit ?? options.headCommit ?? 'head-sha';
      if (args[1] === 'HEAD') return options.headCommit ?? 'head-sha';
    }
    if (command === 'git' && args[0] === 'tag' && args[1] === '--merged') {
      return options.mergedTags === undefined ? 'v2.0.0-beta.5\n' : options.mergedTags;
    }
    if (command === 'git' && args[0] === 'log') return options.mergeSubjects || '';
    if (command === 'git' && args[0] === 'status') return options.dirty ? ' M package.json\n' : '';
    if (command === 'npm' && args[0] === 'view') {
      if (options.networkError) {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'), { code: 'ENOTFOUND' });
      }
      if (args[2] === 'versions') {
        return JSON.stringify(options.published ? [version] : options.publishedVersions || []);
      }
      if (args[2] === 'dist-tags') {
        return JSON.stringify(options.distTags === undefined
          ? { beta: '2.0.0-beta.5', latest: '1.9.0' }
          : options.distTags);
      }
    }
    throw new Error('unexpected command: ' + command + ' ' + args.join(' '));
  };

  const baseOptions = {
    repoRoot: root,
    tag,
    offline: Boolean(options.offline),
    tagPushed: Boolean(options.tagPushed),
    allowStable: Boolean(options.allowStable),
    execFileSyncImpl,
  };
  const run = (overrides = {}) => runPreflight({ ...baseOptions, ...overrides });
  return { root, calls, result: run(), run };
}

function check(result: any, id: any) {
  const found = result.checks.find((entry: any) => entry.id === id);
  assert.ok(found, 'missing check ' + id);
  return found;
}

test('preflight passes the beta release policy and all clean fixture checks', (t) => {
  const { result } = fixture(t);
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((entry: any) => entry.id), [
    'manifest-versions',
    'tag-matches-version',
    'tag-unused',
    'stable-allowed',
    'npm-unpublished',
    'version-ahead',
    'changelog',
    'changelog-names-merges',
    'release-workflow',
    'clean-tree',
  ]);
  for (const id of [
    'manifest-versions', 'tag-matches-version', 'tag-unused', 'stable-allowed',
    'npm-unpublished', 'version-ahead', 'changelog', 'changelog-names-merges',
    'release-workflow', 'clean-tree',
  ]) {
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

test('an existing local release tag fails when the tag is not pushed', (t) => {
  const { result } = fixture(t, { tagExists: true });
  assert.equal(check(result, 'tag-unused').ok, false);
});

test('--tag-pushed requires the release tag to resolve to HEAD', (t) => {
  const { calls, result } = fixture(t, { tagPushed: true });
  assert.equal(check(result, 'tag-at-head').ok, true);
  assert.equal(result.checks.some((entry: any) => entry.id === 'tag-unused'), false);
  assert.ok(calls.some((call: any) => call[0] === 'git' && call[1] === 'rev-parse'
    && call[2] === '--verify' && call[3] === TAG + '^{commit}'));
});

test('--tag-pushed fails when the release tag is on another commit', (t) => {
  const { result } = fixture(t, { tagPushed: true, tagCommit: 'old-sha', headCommit: 'head-sha' });
  assert.equal(check(result, 'tag-at-head').ok, false);
});

test('stable releases require --allow-stable', (t) => {
  const denied = fixture(t, { version: '2.0.0' });
  assert.equal(check(denied.result, 'stable-allowed').ok, false);
  assert.match(check(denied.result, 'stable-allowed').message, /--allow-stable/);

  const allowed = fixture(t, { version: '2.0.0', allowStable: true });
  assert.equal(check(allowed.result, 'stable-allowed').ok, true);
});

test('an already-published npm version fails', (t) => {
  const { result } = fixture(t, { published: true });
  assert.equal(check(result, 'npm-unpublished').ok, false);
});

test('version-ahead fails when the channel tag is equal to or ahead of this version', (t) => {
  const equal = fixture(t, { distTags: { beta: VERSION } });
  assert.equal(check(equal.result, 'version-ahead').ok, false);

  const behind = fixture(t, { distTags: { beta: '2.0.0-beta.7' } });
  assert.equal(check(behind.result, 'version-ahead').ok, false);
});

test('version-ahead chooses beta for prereleases and latest for stable versions', (t) => {
  const beta = fixture(t, { distTags: { beta: '2.0.0-beta.5', latest: '3.0.0' } });
  assert.equal(check(beta.result, 'version-ahead').ok, true);

  const betaChannelUnset = fixture(t, { distTags: { latest: '3.0.0' } });
  assert.equal(check(betaChannelUnset.result, 'version-ahead').ok, true);
  assert.match(check(betaChannelUnset.result, 'version-ahead').message, /beta dist-tag is not set/);

  const stable = fixture(t, {
    version: '2.0.0',
    allowStable: true,
    distTags: { beta: '3.0.0', latest: '1.9.0' },
  });
  assert.equal(check(stable.result, 'version-ahead').ok, true);

  const stableBehind = fixture(t, {
    version: '2.0.0',
    allowStable: true,
    distTags: { beta: '1.0.0', latest: '2.1.0' },
  });
  assert.equal(check(stableBehind.result, 'version-ahead').ok, false);
});

test('SemVer 2.0 precedence examples and multi-digit prerelease identifiers compare correctly', (t) => {
  const precedence = [
    ['1.0.0-alpha.1', '1.0.0-alpha'],
    ['1.0.0-alpha.beta', '1.0.0-alpha.1'],
    ['1.0.0-beta', '1.0.0-alpha.beta'],
    ['1.0.0-beta.2', '1.0.0-beta'],
    ['1.0.0-beta.11', '1.0.0-beta.2'],
    ['1.0.0-rc.1', '1.0.0-beta.11'],
    ['1.0.0', '1.0.0-rc.1'],
    ['2.0.0-beta.10', '2.0.0-beta.9'],
  ];

  for (const [current, previous] of precedence) {
    const { result } = fixture(t, {
      version: current,
      allowStable: true,
      mergedTags: 'v0.9.0\n',
      distTags: { beta: previous, latest: previous },
    });
    assert.equal(check(result, 'version-ahead').ok, true, current + ' > ' + previous);
  }
});

test('version-ahead skips registry checks offline and after a network failure', (t) => {
  const offline = fixture(t, { offline: true });
  for (const id of ['npm-unpublished', 'version-ahead']) {
    const skipped = check(offline.result, id);
    assert.equal(skipped.skipped, true, id);
    assert.match(skipped.message, /offline/);
  }
  assert.equal(offline.calls.some((call: any) => call[0] === 'npm'), false);

  const unavailable = fixture(t, { networkError: true });
  for (const id of ['npm-unpublished', 'version-ahead']) {
    const skipped = check(unavailable.result, id);
    assert.equal(skipped.skipped, true, id);
    assert.match(skipped.message, /registry unavailable/);
  }
});

test('a missing or empty changelog section fails and skips merge-name comparison', (t) => {
  const missing = fixture(t, { offline: true, changelog: '# Changelog\n' });
  assert.equal(check(missing.result, 'changelog').ok, false);
  assert.equal(check(missing.result, 'changelog-names-merges').skipped, true);

  const emptySection = fixture(t, {
    offline: true,
    changelog: '# Changelog\n\n## [' + VERSION + '] - 2026-10-18\n\n## [2.0.0-beta.5] - 2026-10-14\n',
  });
  assert.equal(check(emptySection.result, 'changelog').ok, false);
  assert.equal(check(emptySection.result, 'changelog-names-merges').skipped, true);
});

test('changelog-names-merges deduplicates feature ids and ignores id-less merges', (t) => {
  const changelog = '# Changelog\n\n## [' + VERSION + '] - 2026-10-18\n\n### Added\n'
    + '- Covers 107-A and 087a.\n';
  const { calls, result } = fixture(t, {
    offline: true,
    changelog,
    mergedTags: 'v2.0.0-beta.5\n' + TAG + '\n',
    mergeSubjects: 'merge: 107-A feature\nmerge: 087a feature\nmerge: 107-A duplicate\nmerge: no-id title\n',
  });
  assert.equal(check(result, 'changelog-names-merges').ok, true);
  assert.deepEqual(
    calls.find((call: any) => call[0] === 'git' && call[1] === 'log'),
    ['git', 'log', '--merges', '--format=%s', 'v2.0.0-beta.5..HEAD'],
  );
});

test('changelog-names-merges reports missing ids and uses the previous tag by precedence', (t) => {
  const version = '2.0.0-beta.11';
  const tag = 'v' + version;
  const changelog = '# Changelog\n\n## [' + version + '] - 2026-10-18\n\n### Added\n- Covers 107-A.\n';
  const { calls, result } = fixture(t, {
    version,
    tag,
    offline: true,
    changelog,
    mergedTags: 'v2.0.0-beta.9\nv2.0.0-beta.10\n' + tag + '\n',
    mergeSubjects: 'merge: 107-A feature\nmerge: 087a feature\n',
  });
  const merges = check(result, 'changelog-names-merges');
  assert.equal(merges.ok, false);
  assert.match(merges.message, /087a/);
  assert.deepEqual(
    calls.find((call: any) => call[0] === 'git' && call[1] === 'log'),
    ['git', 'log', '--merges', '--format=%s', 'v2.0.0-beta.10..HEAD'],
  );
});

test('changelog-names-merges skips when there is no earlier release tag', (t) => {
  const { calls, result } = fixture(t, { offline: true, mergedTags: '' });
  assert.equal(check(result, 'changelog-names-merges').skipped, true);
  assert.equal(calls.some((call: any) => call[0] === 'git' && call[1] === 'log'), false);
});

test('release-workflow findings reject a publish step using a fixed beta tag', (t) => {
  const workflow = VALID_WORKFLOW.replace('--tag "${channel}-candidate"', '--tag beta');
  const { result } = fixture(t, { workflow });
  const releaseWorkflow = check(result, 'release-workflow');
  assert.equal(releaseWorkflow.ok, false);
  assert.match(releaseWorkflow.message, /R9 publish/);
});

test('a dirty working tree fails', (t) => {
  const { result } = fixture(t, { dirty: true });
  assert.equal(check(result, 'clean-tree').ok, false);
});

test('CLI arguments accept tag, offline, tag-pushed, and allow-stable flags', () => {
  assert.deepEqual(parseArgs(['--tag', TAG, '--offline', '--tag-pushed', '--allow-stable']), {
    tag: TAG,
    offline: true,
    tagPushed: true,
    allowStable: true,
  });
  assert.throws(() => parseArgs(['--tag']), /usage:/);
  assert.throws(() => parseArgs(['--unknown']), /usage:/);
});

test('release-workflow takes the Node floor from the checkout engines.node, so a pin that differs fails R11', (t) => {
  const { result } = fixture(t, { engines: '>=24.23.0' });
  const releaseWorkflow = check(result, 'release-workflow');
  assert.equal(releaseWorkflow.ok, false);
  assert.match(releaseWorkflow.message, /R11 .*24\.23\.0/);
  const none = check(fixture(t, { engines: 'latest' }).result, 'release-workflow');
  assert.equal(none.ok, false);
  assert.match(none.message, /R11 /);
});
