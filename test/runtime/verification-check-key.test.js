'use strict';

// D2 / IC-009: real file bytes with a git-status seam; no fixture git writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { treeDigest, checkKey } = require('../../src/runtime/verification/check-key.ts');

const HEAD = '1'.repeat(40);
const CLEAN = crypto.createHash('sha256').update('clean').digest('hex');
function options(root, status, configDir) {
  return { configDir, spawnSyncImpl: (_command, args) => ({
    status: 0,
    stdout: args.includes('--show-toplevel') ? root : args.includes('HEAD') ? HEAD : status(),
  }) };
}
function write(root, name, text) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
function key(cwd, opts) {
  return checkKey({ cwd, command: 'npm test', timeoutMs: 1000, env: {}, ...opts });
}

test('tracked fixture .doflow contents participate in both tree digest and check key', (t) => {
  const root = tempDir(t, 'doflow-check-key-fixture-');
  const name = 'fixtures/p/.doflow/data.json';
  const opts = options(root, () => ` M ${name}\0`);
  const file = write(root, name, '{"value":1}');
  const before = treeDigest(root, opts);
  const beforeKey = key(root, opts);
  assert.match(before, /^[0-9a-f]{64}$/);
  assert.match(beforeKey, /^[0-9a-f]{16}$/);
  fs.writeFileSync(file, '{"value":2}');
  assert.notEqual(treeDigest(root, opts), before);
  assert.notEqual(key(root, opts), beforeKey);
});

test('nested configDir remains keyable and stable before and after its lock is created', (t) => {
  const root = tempDir(t, 'doflow-check-key-config-');
  const cwd = path.join(root, 'pkg');
  fs.mkdirSync(cwd);
  const configDir = path.join(cwd, '.doflow');
  let status = '';
  const opts = options(root, () => status, configDir);
  const before = key(cwd, opts);
  assert.match(before, /^[0-9a-f]{16}$/);
  const name = 'pkg/.doflow/state/verification/v0/inflight.lock';
  const lock = write(root, name, 'leader token');
  status = `?? ${name}\0`;
  assert.equal(treeDigest(cwd, opts), CLEAN);
  assert.equal(key(cwd, opts), before);
  fs.writeFileSync(lock, 'follower token');
  assert.equal(key(cwd, opts), before);
});

test('the contract runner supplies its nested configDir to the tree digest', (t) => {
  const root = tempDir(t, 'doflow-check-key-runner-config-');
  const cwd = path.join(root, 'pkg');
  fs.mkdirSync(cwd);
  const script = `
    const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
    const [repo, root] = process.argv.slice(1), cwd = path.join(root, 'pkg'), configDir = path.join(cwd, '.doflow');
    cp.spawnSync = (_command, args) => ({ status: 0, stdout:
      args.includes('HEAD') ? '${HEAD}' : args.includes('--show-toplevel') ? root :
      fs.existsSync(configDir) ? '?? pkg/.doflow/state/verification/v0/\\0' : '' });
    const { VerificationContractRunner } = require(repo + '/src/runtime/verification/contract-runner.ts');
    const { loadVerificationRegistry } = require(repo + '/src/runtime/verification/registry.ts');
    const registry = loadVerificationRegistry();
    const keys = [];
    for (let i = 0; i < 2; i++) {
      const runner = new VerificationContractRunner({ cwd, env: {},
        exec: () => ({ status: 0, stdout: '', stderr: '' }),
        context: { v0: true, registry, riskLevel: 'LOW', configDir } });
      const check = runner.runCheck('check', 'true', 1000);
      keys.push(runner.metrics.get(check).checkKey);
    }
    process.stdout.write(JSON.stringify(keys));
  `;
  const child = spawnSync(process.execPath, ['-e', script, path.resolve(__dirname, '../..'), root], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const [before, after] = JSON.parse(child.stdout);
  assert.match(before, /^[0-9a-f]{16}$/);
  assert.match(after, /^[0-9a-f]{16}$/);
  assert.equal(after, before);
});

test('dirty porcelain paths resolve from the git top level when cwd is a subdirectory', (t) => {
  const root = tempDir(t, 'doflow-check-key-subdir-');
  const cwd = path.join(root, 'pkg');
  fs.mkdirSync(cwd);
  write(root, 'dirty.js', 'changed\n');
  const opts = options(root, () => ' M dirty.js\0');
  assert.match(key(cwd, opts), /^[0-9a-f]{16}$/);
  assert.equal(treeDigest(cwd, opts), treeDigest(root, opts));
  assert.notEqual(treeDigest(cwd, opts), CLEAN);
});

test('an excluded top-level lock leaves the clean sentinel and check key unchanged', (t) => {
  const root = tempDir(t, 'doflow-check-key-clean-');
  let status = '';
  const opts = options(root, () => status);
  const before = key(root, opts);
  write(root, '.doflow/state/verification/v0/inflight.lock', 'token');
  status = '?? .doflow/state/verification/v0/inflight.lock\0';
  assert.equal(treeDigest(root, opts), CLEAN);
  assert.equal(key(root, opts), before);
});

test('configDir exclusion follows realpath and does not exclude sibling prefixes', (t) => {
  const root = tempDir(t, 'doflow-check-key-realconfig-');
  const configDir = path.join(root, 'pkg/.doflow');
  write(root, 'pkg/runtime-state/lock', 'token');
  fs.symlinkSync('runtime-state', configDir);
  const opts = options(root, () => '?? pkg/runtime-state/lock\0', configDir);
  assert.equal(treeDigest(root, opts), CLEAN);
  const sibling = 'pkg/runtime-state-fixture/data.json';
  write(root, sibling, 'one');
  const siblingOpts = options(root, () => `?? pkg/runtime-state/lock\0 M ${sibling}\0`, configDir);
  const before = treeDigest(root, siblingOpts);
  assert.notEqual(before, CLEAN);
  write(root, sibling, 'two');
  assert.notEqual(treeDigest(root, siblingOpts), before);
});
