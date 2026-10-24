'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const REPO = path.resolve(__dirname, '../..');
const RUN = path.join(REPO, 'core/shared/scripts/doflow/bin/doflow-run');
const registry = require('../../core/registry/storage.json');

test('IC-016: git add -A stages only ledger.json under state, but stages settings and scripts', { skip: process.platform === 'win32' }, t => {
  const scratch = createScratch('doflow-storage-gitignore-', { prune: 'on' }); t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
  const env = scratch.env({ DOFLOW_CLI: path.join(REPO, 'bin/doflow.js'), DOFLOW_CONFIG_DIR: path.join(project, '.doflow') });
  const git = (...args: any[]) => {
    const result = spawnSync('git', args, { cwd: project, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  git('init', '-q');
  for (const [name, text] of Object.entries({
    '.doflow/state/ledger.json': '{}\n', '.doflow/state/evidence/old.json': '{}\n',
    '.doflow/state/verification/logs/1700000000000-old.log': 'log\n', '.doflow/state/other': 'other\n',
    '.doflow/prompt-nudge': 'off\n', '.doflow/prune': 'off\n', '.doflow/scripts/example.sh': '#!/bin/sh\n',
  })) {
    const file = path.join(project, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  const exclude = fs.readFileSync(path.join(project, '.git/info/exclude'), 'utf8');
  const result = spawnSync('/bin/bash', [RUN, 'evidence', '--action', 'list', '--task-id', 'idle', '--json'], { cwd: project, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ignore = path.join(project, '.doflow/state/.gitignore');
  assert.equal(fs.readFileSync(ignore, 'utf8'), `${registry.settings.ignoreFile.lines.join('\n')}\n`);
  assert.equal(fs.existsSync(path.join(project, '.gitignore')), false);
  assert.equal(fs.readFileSync(path.join(project, '.git/info/exclude'), 'utf8'), exclude);
  git('add', '-A');
  const staged = git('diff', '--cached', '--name-only').trim().split('\n');
  assert.deepEqual(staged.filter((name: any) => name.startsWith('.doflow/state/')), ['.doflow/state/ledger.json']);
  for (const name of ['.doflow/prompt-nudge', '.doflow/prune', '.doflow/scripts/example.sh']) assert.ok(staged.includes(name), name);
});
