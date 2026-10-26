'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { pinGit, fetchGit } = require('../../src/runtime/packages/fetch.ts');
const { loadPoints } = require('../../src/runtime/packages/points.ts');
const limits = loadPoints().registry.limits;
const sha = '1111111111111111111111111111111111111111';
const KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
];

function git(cwd: string, ...args: string[]): string {
  const env: any = { ...process.env };
  for (const key of KEYS) delete env[key];
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function stage(t: any): string {
  const dir = path.join(tempDir(t, 'doflow-git-env-stage-'), 'stage');
  fs.mkdirSync(dir);
  return dir;
}
function snapshot(repo: string): string {
  return [git(repo, 'rev-parse', 'HEAD'), git(repo, 'for-each-ref'), git(repo, 'count-objects', '-v'),
    fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'), git(repo, 'status', '--porcelain')].join('\n--\n');
}

test('git fetch ignores caller GIT_DIR and GIT_WORK_TREE: the decoy repo is untouched and staging gets the repo', (t: any) => {
  const decoy = tempDir(t, 'doflow-git-env-decoy-');
  git(decoy, 'init', '-q');
  fs.writeFileSync(path.join(decoy, 'a.txt'), 'a\n');
  git(decoy, 'add', 'a.txt'); git(decoy, 'commit', '-q', '-m', 'decoy');
  const before = snapshot(decoy);
  const files = fs.readdirSync(decoy).sort();
  const staging = stage(t);
  const env = { ...process.env, GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy };
  const result = fetchGit({ type: 'git', url: path.join(decoy, 'does-not-exist.git'), commit: sha },
    { stagingDir: staging, env, limits });
  assert.equal(result.ok, false); // the unreachable source fails at fetch, after init and remote add have run
  assert.equal(snapshot(decoy), before);
  assert.deepEqual(fs.readdirSync(decoy).sort(), files);
  assert.match(fs.readFileSync(path.join(staging, '.git', 'config'), 'utf8'), /\[remote "origin"\]/u);
  assert.doesNotMatch(fs.readFileSync(path.join(decoy, '.git', 'config'), 'utf8'), /remote "origin"/u);
});

for (const key of KEYS) {
  test(`git subprocesses never receive ${key} from the caller env`, (t: any) => {
    const dir = tempDir(t, 'doflow-git-env-stub-');
    const out = path.join(dir, 'seen');
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh
{ printf '%s\\n' "$1 $3 $5 $6"; env | grep '^GIT_' | sort; echo --; } >> '${out}'
for i in 1 2; do [ "$1" = "-c" ] && { shift 2; }; done
cmd=$1
case "$cmd" in
 ls-remote) printf '%s\\trefs/tags/v1\\n' '${sha}' ;;
 archive) : ;;
esac
exit 0
`);
    fs.chmodSync(path.join(dir, 'git'), 0o755);
    const env: any = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, [key]: path.join(dir, 'decoy') };
    const pin = pinGit({ type: 'git', url: 'https://example.org/a.git', ref: 'v1' }, { env });
    assert.equal(pin.ok, true);
    fetchGit(pin.pinned, { stagingDir: stage(t), env, limits });
    const seen = fs.readFileSync(out, 'utf8');
    assert.doesNotMatch(seen, new RegExp(`^${key}=`, 'mu'));
    assert.match(seen, /^GIT_TERMINAL_PROMPT=0$/mu);
    assert.equal(env[key], path.join(dir, 'decoy')); // the caller's env object is not mutated
    assert.equal(seen.split('--\n').filter(Boolean).length, 5); // ls-remote, init, remote add, fetch, archive all ran
  });
}

test('a caller GIT_ALLOW_PROTOCOL cannot re-enable the file transport', (t: any) => {
  const repo = tempDir(t, 'doflow-git-env-source-');
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt'); git(repo, 'commit', '-q', '-m', 'source');
  const commit = git(repo, 'rev-parse', 'HEAD').trim();
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
  const result = fetchGit({ type: 'git', url: repo, commit }, { stagingDir: stage(t), env, limits });
  assert.equal(result.ok, false);
  assert.match(result.findings[0].message, /transport 'file' not allowed/u);
});
