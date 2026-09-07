'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { measureFreshness, FreshnessValidator } = require('../../src/runtime/freshness');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');

function project(t, gitBacked = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-observed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  if (gitBacked) {
    git('init', '-q');
    git('add', 'a.js');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
  }
  return { root, git };
}

function cli(root, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root },
  });
  return { ...result, data: result.stdout ? JSON.parse(result.stdout) : null };
}

test('freshness describes observed bytes, including dirty files and later commits', (t) => {
  const { root, git } = project(t, true);
  const file = path.join(root, 'a.js');
  fs.writeFileSync(file, 'module.exports = 2;\n');
  const item = { locator: { file: 'a.js', line: 1 }, freshness: measureFreshness(root, { file: 'a.js' }, git('rev-parse', 'HEAD')) };
  const check = () => new FreshnessValidator({ repoRoot: root }).checkEvidenceFreshness(item).status;
  assert.equal(check(), 'FRESH', 'an observation made after an edit is fresh');
  git('add', 'a.js');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'observed edit');
  assert.equal(check(), 'FRESH', 'committing identical observed bytes does not expire evidence');
  fs.writeFileSync(file, 'module.exports = 3;\n');
  assert.equal(check(), 'STALE');
  fs.writeFileSync(file, 'module.exports = 2;\n');
  assert.equal(check(), 'FRESH', 'restored observed bytes can be checked again');
});

test('content observations expire without Git, including deletion', (t) => {
  const { root } = project(t);
  const item = { locator: { file: 'a.js' }, freshness: measureFreshness(root, { file: 'a.js' }, null) };
  const check = () => new FreshnessValidator({ repoRoot: root }).checkEvidenceFreshness(item).status;
  assert.equal(check(), 'FRESH');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 4;\n');
  assert.equal(check(), 'STALE');
  fs.unlinkSync(path.join(root, 'a.js'));
  assert.equal(check(), 'STALE');
});

test('readiness and stage completion reject the same changed observation', (t) => {
  const { root } = project(t, true);
  const task = 'freshness-boundary';
  const added = cli(root, 'evidence', '--action', 'add', '--task-id', task,
    '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'local-read',
    '--capability', 'code.exact-search', '--locator', 'a.js:1',
    '--establishes', 'target_identified');
  assert.equal(added.status, 0, added.stderr);
  assert.equal(cli(root, 'orchestrate', '--action', 'start', '--task-id', task, '--task-class', 'trivial-edit').status, 0);
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 5;\n');
  const readiness = cli(root, 'readiness', '--task-id', task, '--task-class', 'trivial-edit', '--scope', 'a.js only');
  assert.equal(readiness.data.state, 'NEEDS_EVIDENCE');
  const completion = cli(root, 'orchestrate', '--action', 'complete-stage', '--task-id', task,
    '--task-class', 'trivial-edit', '--stage', 'implementation', '--scope', 'a.js only');
  assert.notEqual(completion.status, 0, 'completion must recheck freshness too');
  assert.match(completion.stderr, /NEEDS_EVIDENCE/);
});
