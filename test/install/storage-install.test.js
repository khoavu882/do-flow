'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const state = require('../../src/state/index.ts');
const { storageAfterInstall } = require('../../src/runtime/storage/upkeep');

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
function install(project, env) {
  return spawnSync(process.execPath, [BIN, 'install', project, '--force', '--mcp', 'none', '--target', 'claude'], {
    cwd: project, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
}
function plantRecovery(project, id) {
  const directory = path.join(project, '.doflow/state/recovery');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ id, changes: [] }));
}

test('install prunes recovery snapshots but retains the ledger snapshot and adds its ignore rule', () => {
  const scratch = createScratch('doflow-storage-install-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    fs.mkdirSync(path.join(project, '.doflow'), { recursive: true });
    fs.writeFileSync(path.join(project, '.doflow/prune'), 'on\n');
    const env = scratch.env();
    const first = install(project, env);
    assert.equal(first.status, 0, first.stderr + first.stdout);

    assert.ok(fs.existsSync(path.join(project, '.doflow/state/.gitignore')), 'install creates the state ignore file');
    const recovery = path.join(project, '.doflow/state/recovery');
    const preexisting = fs.readdirSync(recovery).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
    const ids = Array.from({ length: 6 }, (_, index) => `recovery_2020-01-${String(index + 1).padStart(2, '0')}`);
    ids.forEach(id => plantRecovery(project, id));
    const ledger = state.defaultLedger({ scope: 'project', scopeRoot: project });
    ledger.lastRecoveryId = ids[4];
    state.writeLedger(path.join(project, '.doflow/state'), ledger);
    storageAfterInstall({ scope: 'project', scopeRoot: project, env });

    const kept = fs.readdirSync(recovery).filter(name => name.endsWith('.json')).sort().map(name => name.slice(0, -5));
    assert.deepEqual(kept, [ids[4], ids[5], ...preexisting].sort());
    assert.ok(fs.existsSync(path.join(project, '.doflow/state/.gitignore')));
  } finally { scratch.remove(); }
});
