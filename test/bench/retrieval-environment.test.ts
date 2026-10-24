'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const env = require('../../bench/retrieval/lib/environment.ts');
const snap = require('../../bench/retrieval/lib/snapshot.ts');
const { tempDir } = require('../helper/tmp.ts');

const gitIn = (dir: any, ...args: any[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();

test('the pinned tool list names the seven tools in order', () => {
  assert.deepEqual(env.TOOL_SPECS.map((s: any) => s.id), ['git', 'rg', 'fd', 'semble', 'graphify', 'rtk', 'jq']);
});

test('captureTool reads the first stdout line; a binary that cannot start is absent with a null line', () => {
  const present = env.captureTool({ id: 'node', versionCommand: [process.execPath, '--version'] });
  assert.deepEqual(present, { id: 'node', versionCommand: [process.execPath, '--version'], versionLine: process.version, state: 'present' });
  const absent = env.captureTool({ id: 'ghost', versionCommand: ['doflow-no-such-binary-074', '--version'] });
  assert.deepEqual(absent, { id: 'ghost', versionCommand: ['doflow-no-such-binary-074', '--version'], versionLine: null, state: 'absent' });
  const multi = env.captureTool({ id: 'm', versionCommand: [process.execPath, '-e', 'console.log("line one\\nline two")'] });
  assert.equal(multi.versionLine, 'line one');
});

test('compareTools reports a version mismatch and a presence mismatch per tool', () => {
  const node = { id: 'node', versionCommand: [process.execPath, '--version'], versionLine: process.version, state: 'present' };
  const ghost = { id: 'ghost', versionCommand: ['doflow-no-such-binary-074', '--version'], versionLine: null, state: 'absent' };
  const rows = env.compareTools([node, ghost, { ...node, id: 'old', versionLine: 'v0.0.1' }, { ...ghost, id: 'was-here', versionLine: 'x 1', state: 'present' }]);
  assert.deepEqual(rows.map((r: any) => [r.id, r.ok]), [['node', true], ['ghost', true], ['old', false], ['was-here', false]]);
  assert.equal(rows[1].expected, 'absent');
  assert.equal(rows[1].actual, 'absent');
  assert.equal(rows[2].expected, 'v0.0.1');
});

test('compareEnv lists differing node, os and arch without failing', () => {
  const current = { node: 'v1', os: 'darwin', arch: 'arm64' };
  assert.deepEqual(env.compareEnv({ node: 'v1', os: 'darwin', arch: 'arm64' }, current), { ...current, differs: [] });
  assert.deepEqual(env.compareEnv({ node: 'v2', os: 'linux', arch: 'arm64' }, current).differs, ['node', 'os']);
});

test('materialiseExport extracts the commit, drops everything outside the scopes and ignores the working tree', (t) => {
  const repo = tempDir(t, 'doflow-env-repo-');
  gitIn(repo, 'init', '-q');
  const files = { 'src/a.ts': 'committed\n', 'bench/x.js': 'x\n', 'docs/d.md': 'd\n', 'core/shared/guidance/g.md': '# G\n', 'README.md': 'r\n' };
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body);
  }
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'c');
  const commit = gitIn(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'dirty\n');
  fs.writeFileSync(path.join(repo, 'src/untracked.ts'), 'u\n');
  const snapshot = snap.buildSnapshot({ commit, seed: 1, manifestSha256: '', tools: [], env: { node: 'v', os: 'o', arch: 'a' }, devSha256: '' });

  const tmp = path.join(tempDir(t, 'doflow-env-tmp-'), 'export');
  const out = env.materialiseExport(commit, tmp, snapshot, { repoRoot: repo });
  assert.equal(fs.readFileSync(path.join(out.codeRoot, 'src/a.ts'), 'utf8'), 'committed\n');
  assert.equal(fs.existsSync(path.join(out.codeRoot, 'src/untracked.ts')), false);
  for (const gone of ['bench', 'docs', 'README.md']) assert.equal(fs.existsSync(path.join(out.treeRoot, gone)), false, `${gone} is outside the scopes`);
  assert.equal(fs.readFileSync(path.join(out.guidanceRoot, 'g.md'), 'utf8'), '# G\n');
  assert.equal(out.guidanceRoot, path.join(out.treeRoot, 'core/shared/guidance'));
  out.cleanup();
  assert.equal(fs.existsSync(tmp), false, 'cleanup removes the export');

  const kept = env.materialiseExport(commit, tmp, snapshot, { repoRoot: repo, keep: true });
  kept.cleanup();
  assert.equal(fs.existsSync(path.join(tmp, 'tree', 'src', 'a.ts')), true, '--keep-tmp keeps the export');
});

test('materialiseExport fails clearly on an absent commit', (t) => {
  const repo = tempDir(t, 'doflow-env-repo-');
  gitIn(repo, 'init', '-q');
  const snapshot = snap.buildSnapshot({ commit: 'x', seed: 1, manifestSha256: '', tools: [], env: { node: 'v', os: 'o', arch: 'a' }, devSha256: '' });
  assert.throws(() => env.materialiseExport('f'.repeat(40), path.join(tempDir(t, 'doflow-env-tmp-'), 'e'), snapshot, { repoRoot: repo }), /git archive .* failed/);
});

test('defaultTmpDir is the system temp dir plus doflow-retrieval-<pid>', () => {
  assert.equal(path.basename(env.defaultTmpDir()), `doflow-retrieval-${process.pid}`);
});

test('captureTool: child env lacks DOFLOW_HOLDOUT_KEY and *_API_KEY', () => {
  const prevHoldout = process.env.DOFLOW_HOLDOUT_KEY;
  const prevApiKey = process.env.TEST_API_KEY;
  process.env.DOFLOW_HOLDOUT_KEY = 'secret-holdout-12345';
  process.env.TEST_API_KEY = 'secret-api-key';
  try {
    const probe = env.captureTool({
      id: 'probe',
      versionCommand: [
        process.execPath,
        '-e',
        'console.log(JSON.stringify({ holdout: process.env.DOFLOW_HOLDOUT_KEY, apiKey: process.env.TEST_API_KEY }))',
      ],
    });
    assert.equal(probe.state, 'present');
    const captured = JSON.parse(probe.versionLine);
    assert.equal(captured.holdout, undefined, 'child env must not contain DOFLOW_HOLDOUT_KEY');
    assert.equal(captured.apiKey, undefined, 'child env must not contain TEST_API_KEY');
  } finally {
    if (prevHoldout !== undefined) process.env.DOFLOW_HOLDOUT_KEY = prevHoldout; else delete process.env.DOFLOW_HOLDOUT_KEY;
    if (prevApiKey !== undefined) process.env.TEST_API_KEY = prevApiKey; else delete process.env.TEST_API_KEY;
  }
});
