'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin/doflow.js');

function git(root, ...args) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function makeProject(t) {
  const root = tempDir(t, 'doflow-evidence-spawns-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@test.com');
  git(root, 'checkout', '-q', '-b', 'feat/feat-spawns');
  const featureDir = path.join(root, 'agent-docs/doflow/feat-spawns/intention');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = {}\n');
  fs.writeFileSync(path.join(featureDir, 'requirement.md'), '# Feature: spawns\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

function traceEvidenceAdd(t, root, taskId, extraFlags) {
  const traceDir = tempDir(t, 'doflow-evidence-spawn-trace-');
  const preload = path.join(traceDir, 'trace.js');
  const log = path.join(traceDir, 'spawns.jsonl');
  fs.writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
const log = process.env.DOFLOW_TEST_SPAWN_LOG;
for (const name of ['spawnSync', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function(file, args, ...rest) {
    fs.appendFileSync(log, JSON.stringify({ api: name, file, args }) + '\\n');
    return original.call(this, file, args, ...rest);
  };
}
`, 'utf8');
  const res = spawnSync(process.execPath, ['--require', preload, CLI,
    'evidence', root, '--task-id', taskId, '--action', 'add',
    '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'native.rg',
    '--capability', 'code.exact-search',
    ...(extraFlags.includes('--absence') ? [] : ['--locator', 'a.js:1']),
    '--content', 'spawn test',
    ...extraFlags, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', DOFLOW_TEST_SPAWN_LOG: log },
  });
  const entries = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { res, entries };
}

function expectedSpawns(root) {
  return [
    { api: 'spawnSync', file: 'git', args: ['-C', root, 'worktree', 'list', '--porcelain'] },
    { api: 'execFileSync', file: 'bash', args: [
      path.join(REPO, 'core/shared/scripts/doflow/bash/do-paths.sh'), '--json', '--require', 'feature',
    ] },
    { api: 'execFileSync', file: 'git', args: [
      '-C', root, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=matching',
    ] },
  ];
}

test('evidence add --need and --absence reuse the dispatch checkout root for active-attempt lookup', (t) => {
  const root = makeProject(t);
  for (const taskId of ['evidence-need', 'evidence-absence']) {
    const declared = run(root, ['retrieval-plan', root, '--task-id', taskId, '--slug', 'feat-spawns',
      '--action', 'declare', '--need', 'inspect-history', '--json']);
    assert.equal(declared.status, 0, declared.stderr);
  }

  const need = traceEvidenceAdd(t, root, 'evidence-need', ['--need', 'inspect-history']);
  assert.equal(need.res.status, 0, `${need.res.stderr}\n${need.res.stdout}`);
  assert.deepEqual(need.entries, expectedSpawns(root), `--need spawns: ${JSON.stringify(need.entries)}`);

  const absence = traceEvidenceAdd(t, root, 'evidence-absence', ['--absence', '--need', 'inspect-history']);
  assert.equal(absence.res.status, 0, `${absence.res.stderr}\n${absence.res.stdout}`);
  assert.deepEqual(absence.entries, expectedSpawns(root), `--absence spawns: ${JSON.stringify(absence.entries)}`);
});
