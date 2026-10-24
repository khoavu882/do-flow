'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const snap = require('../../bench/retrieval/lib/snapshot.ts');
const { tempDir } = require('../helper/tmp.ts');

function gitIn(dir: any, ...args: any[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function repoWith(t: any, files: any) {
  const dir = tempDir(t, 'doflow-snapshot-');
  gitIn(dir, 'init', '-q');
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return { dir, commit: gitIn(dir, 'rev-parse', 'HEAD') };
}

const FILES = {
  'src/a.ts': 'one\ntwo\n',
  'src/deep/b.ts': 'three\n',
  'bin/x.js': 'x\n',
  'test/t.test.js': 't\n',
  'core/registry/r.json': '{}\n',
  'core/shared/guidance/g.md': '# G\n',
  'core/shared/skills/s.md': 'skill\n',
  'docs/d.md': 'doc\n',
  'bench/b.js': 'b\n',
  'src/node_modules/m.js': 'm\n',
};
const TOOLS = [{ id: 'git', versionCommand: ['git', '--version'], versionLine: 'git version 2', state: 'present' }];

test('glob grammar: ** crosses segments, * stays inside one, other characters are literal', () => {
  const m = (pattern: any, file: any) => snap.globToRegExp(pattern).test(file);
  assert.equal(m('src/**', 'src/a/b/c.ts'), true);
  assert.equal(m('src/*', 'src/a/b.ts'), false);
  assert.equal(m('src/*.ts', 'src/a.ts'), true);
  assert.equal(m('src/*.ts', 'src/a.tsx'), false);
  assert.equal(m('a.b/**', 'aXb/c'), false, '. is not a wildcard');
  assert.equal(m('a?/**', 'ab/c'), false, '? is not a wildcard');
  assert.equal(m('**/x.js', 'a/b/x.js'), true);
});

test('the manifest keeps scoped, non-excluded blobs from git objects, sorted by path', (t) => {
  const { dir, commit } = repoWith(t, FILES);
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'dirty working tree change\n');
  const skeleton = snap.buildSnapshot({ commit, seed: 1, manifestSha256: '', tools: [], env: { node: 'v', os: 'o', arch: 'a' }, devSha256: '' });
  const entries = snap.buildManifest(dir, commit, skeleton);
  assert.deepEqual(entries.map((e: any) => `${e.corpus}:${e.path}`), [
    'code:bin/x.js', 'code:core/registry/r.json', 'guidance:core/shared/guidance/g.md', 'code:src/a.ts', 'code:src/deep/b.ts',
    'code:src/node_modules/m.js', 'code:test/t.test.js',
  ]);
  const a = entries.find((e: any) => e.path === 'src/a.ts');
  assert.equal(a.bytes, 8, 'size comes from the commit, not the dirty working tree');
  assert.equal(a.blob, gitIn(dir, 'rev-parse', `${commit}:src/a.ts`));
});

test('manifestDigest is the SHA-256 of canonical entries; diffManifest lists added, removed, changed', (t) => {
  const { dir, commit } = repoWith(t, FILES);
  const skeleton = snap.buildSnapshot({ commit, seed: 1, manifestSha256: '', tools: [], env: { node: 'v', os: 'o', arch: 'a' }, devSha256: '' });
  const entries = snap.buildManifest(dir, commit, skeleton);
  assert.match(snap.manifestDigest(entries), /^[0-9a-f]{64}$/);
  assert.equal(snap.manifestDigest(entries), snap.manifestDigest(JSON.parse(JSON.stringify(entries))));
  const mutated = entries.filter((e: any) => e.path !== 'bin/x.js').map((e: any) => (e.path === 'src/a.ts' ? { ...e, blob: '0'.repeat(40) } : e));
  mutated.push({ path: 'src/new.ts', corpus: 'code', blob: '1'.repeat(40), bytes: 1 });
  assert.deepEqual(snap.diffManifest(entries, mutated), { added: ['src/new.ts'], removed: ['bin/x.js'], changed: ['src/a.ts'] });
  assert.notEqual(snap.manifestDigest(entries), snap.manifestDigest(mutated));
});

test('commitExists distinguishes a present commit from an absent one', (t) => {
  const { dir, commit } = repoWith(t, FILES);
  assert.equal(snap.commitExists(dir, commit), true);
  assert.equal(snap.commitExists(dir, 'f'.repeat(40)), false);
});

test('writeInitial writes snapshot.json and manifest.json in schema order; refreshTaskSha follows the dev file', (t) => {
  const { dir, commit } = repoWith(t, FILES);
  const outDir = path.join(tempDir(t, 'doflow-snapshot-out-'), 'retrieval');
  const snapshot = snap.writeInitial({ commit, seed: 20261012, repoRoot: dir, outDir, tools: TOOLS, env: { node: 'v26.8.1', os: 'darwin', arch: 'arm64' } });
  assert.deepEqual(Object.keys(snapshot), [
    'schemaVersion', 'snapshotId', 'commit', 'seed', 'refresh', 'exclude', 'corpora', 'manifestPath', 'manifestSha256', 'tools', 'node', 'os', 'arch', 'taskFiles',
  ]);
  assert.equal(snapshot.snapshotId, 1);
  assert.equal(snapshot.commit, commit);
  assert.equal(snapshot.corpora.guidance.kMax, 5);
  const onDisk = snap.loadSnapshot(path.join(outDir, 'snapshot.json'));
  const manifest = snap.loadManifest(path.join(outDir, 'manifest.json'));
  assert.deepEqual(onDisk, snapshot);
  assert.equal(snap.manifestDigest(manifest.entries), onDisk.manifestSha256);
  assert.equal(manifest.commit, commit);
  assert.equal(onDisk.taskFiles.dev.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty-file digest');
  assert.ok(fs.readFileSync(path.join(outDir, 'snapshot.json'), 'utf8').endsWith('}\n'));

  fs.mkdirSync(path.join(dir, 'bench/retrieval/tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bench/retrieval/tasks/dev.json'), '{"tasks":[]}\n');
  const refreshed = snap.refreshTaskSha({ repoRoot: dir, snapshotFile: path.join(outDir, 'snapshot.json') });
  assert.notEqual(refreshed.taskFiles.dev.sha256, onDisk.taskFiles.dev.sha256);
  assert.equal(refreshed.manifestSha256, onDisk.manifestSha256);
});

test('writeInitial refuses an absent commit with the fetch-full-history message', (t) => {
  const { dir } = repoWith(t, FILES);
  assert.throws(() => snap.writeInitial({ commit: 'a'.repeat(40), seed: 1, repoRoot: dir, outDir: dir, tools: TOOLS }), /pinned commit a{40} is absent .* fetch full history/);
});
