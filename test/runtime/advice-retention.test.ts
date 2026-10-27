'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const DOFLOW_RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const DOFLOW_CLI = path.join(REPO_ROOT, 'bin/doflow.js');

test('IC-013 advice partitions older than 90 days expire after an ordinary verb', (t) => {
  const scratch = createScratch('doflow-advice-retention-', { prune: 'on' });
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const env = scratch.env({ DOFLOW_CLI });
  const git = spawnSync('git', ['init', '-q'], { cwd: project, env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);

  const registry = loadStorageRegistry({ repoRoot: REPO_ROOT });
  const roots = resolveRoots({ registry, projectRoot: project, env });
  const today = new Date().toISOString().slice(0, 10);
  const partitions = [
    { root: roots['project-state'], store: 'project' },
    { root: roots['user-state'], store: 'user' },
  ];
  for (const { root } of partitions) {
    const dir = path.join(root, 'advice', 'picks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2000-01-01.jsonl'), '{"type":"pick"}\n');
    fs.writeFileSync(path.join(dir, `${today}.jsonl`), '{"type":"pick"}\n');
  }

  const result = spawnSync(bashPath(), [DOFLOW_RUN, 'trace'], { cwd: project, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const { root, store } of partitions) {
    const dir = path.join(root, 'advice', 'picks');
    assert.equal(fs.existsSync(path.join(dir, '2000-01-01.jsonl')), false, `${store} old partition should expire`);
    assert.equal(fs.existsSync(path.join(dir, `${today}.jsonl`)), true, `${store} current partition should remain`);
  }
});
