'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { interpreterSpawn } = require('../helper-platform.ts');
const { enforcementFor, rowsDigest, UnknownEnforcementTarget } = require('../../src/lifecycle/coverage.ts');
const ROOT = path.resolve(__dirname, '../..');
const row = (values: any = {}) => ({ policy: 'gate', harness: 'claude', event: 'PreToolUse', timing: 'pre-tool', profile: 'any', wired: true, class: 'blocking', verification: 'verified', prerequisites: [], covers: ['edit', 'write'], doesNotCover: ['shell'], caveats: [], ...values });
const coverage = (rows: any) => ({ schemaVersion: 1, revision: 1, rowsDigest: 'sha256:' + 'a'.repeat(64), profiles: { any: 'all', narrow: 'narrow' }, rows });

test('enforcement answers classes, weakest default, profile filter, aggregation and parity', () => {
  for (const cls of ['blocking', 'observation', 'advisory', 'unsupported', 'unknown']) {
    const answer = enforcementFor(coverage([row({ class: cls, verification: cls === 'blocking' ? 'verified' : 'unverified' })]), { harness: 'claude', policy: 'gate' });
    assert.equal(answer.class, cls);
    assert.equal(answer.enforced, cls === 'blocking');
    assert.equal(answer.parity, cls === 'blocking');
  }
  assert.equal(enforcementFor(coverage([row({ verification: 'unverified' })]), { harness: 'claude', policy: 'gate' }).enforced, false, 'an unverified blocking row is never enforced');
  const rows: any = [row({ profile: 'any', covers: ['edit', 'write'], doesNotCover: ['shell'], prerequisites: ['trust'] }), row({ profile: 'narrow', class: 'unknown', verification: 'unverified', covers: ['edit'], doesNotCover: ['custom'], prerequisites: ['review'] })];
  assert.equal(enforcementFor(coverage(rows), { harness: 'claude', policy: 'gate' }).class, 'unknown');
  assert.equal(enforcementFor(coverage(rows), { harness: 'claude', policy: 'gate', profile: 'narrow' }).rows.length, 2);
  const answer = enforcementFor(coverage(rows), { harness: 'claude', policy: 'gate', profile: 'any' });
  assert.deepEqual(answer.covers, ['edit', 'write']);
  assert.deepEqual(answer.doesNotCover, ['shell']);
  assert.equal(answer.parity, false);
  const empty = enforcementFor(coverage([row({ timing: 'post-tool' })]), { harness: 'claude', policy: 'gate' });
  assert.equal(empty.class, 'unknown'); assert.deepEqual(empty.rows, []);
});

test('unknown targets throw typed errors', () => {
  assert.throws(() => enforcementFor(coverage([row()]), { harness: 'missing', policy: 'gate' }), (error: any) => error instanceof UnknownEnforcementTarget && error.code === 'unknown-harness');
  assert.throws(() => enforcementFor(coverage([row()]), { harness: 'claude', policy: 'missing' }), (error: any) => error.code === 'unknown-policy');
  assert.throws(() => enforcementFor(coverage([row()]), { harness: 'claude', policy: 'gate', profile: 'missing' }), (error: any) => error.code === 'unknown-profile');
});

test('wildcard policy rows do not hide known lifecycle policies', () => {
  const block = coverage([
    row({ policy: '*', harness: 'copilot', event: 'unavailable', timing: 'pre-tool', class: 'unsupported', verification: 'unverified', wired: false }),
    row({ policy: 'pre-bash-guard', harness: 'claude' }),
  ]);
  const answer = enforcementFor(block, { harness: 'copilot', policy: 'pre-bash-guard' });
  assert.equal(answer.enforced, false);
  assert.equal(answer.class, 'unsupported');
});

test('shipped coverage digest and every-row IC-022 caveats are correct', () => {
  const lifecycle = require('../../core/registry/lifecycle.json');
  assert.equal(lifecycle.coverage.rowsDigest, rowsDigest(lifecycle.coverage.rows));
  for (const harness of ['opencode']) {
    for (const policy of lifecycle.policies.map((item: any) => item.id)) {
      assert.ok(lifecycle.coverage.rows.some((item: any) => item.harness === harness && item.policy === policy && item.class === 'unsupported'));
    }
  }
  for (const item of lifecycle.coverage.rows) {
    if (item.policy === 'pre-implementation-gate') {
      assert.ok(item.doesNotCover.includes('writes via shell commands'), `${item.harness}/${item.event} gate row must disclose shell-command writes`);
    }
    if (item.class === 'unsupported') {
      assert.equal(item.event, '*', `${item.harness}/${item.policy} unsupported row must use the unavailable event wildcard`);
    }
  }
});

test('enforcement CLI returns exit 0 for an enforced synthetic registry answer', async () => {
  const registryPath = require.resolve('../../src/registry/index.ts');
  const upkeepPath = require.resolve('../../src/runtime/storage/upkeep.ts');
  const runtimePath = require.resolve('../../src/cli/runtime-commands.ts');
  const previousRegistry = require.cache[registryPath];
  const previousUpkeep = require.cache[upkeepPath];
  const previousRuntime = require.cache[runtimePath];
  require.cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: { loadRegistry: () => ({ coverage: coverage([row()]) }) } };
  require.cache[upkeepPath] = { id: upkeepPath, filename: upkeepPath, loaded: true, exports: { upkeepAfterVerb() {} } };
  delete require.cache[runtimePath];
  const oldExitCode = process.exitCode;
  const oldLog = console.log;
  let output = '';
  console.log = value => { output += `${value}\n`; };
  try {
    const { dispatchRuntimeCommand } = require('../../src/cli/runtime-commands.ts');
    const result = await dispatchRuntimeCommand({ cmd: 'enforcement', harness: 'claude', policy: 'gate', json: true, positional: [] });
    assert.equal(result, 0);
    assert.equal(process.exitCode, 0);
    assert.equal(JSON.parse(output).enforced, true);
  } finally {
    console.log = oldLog;
    process.exitCode = oldExitCode;
    if (previousRegistry) require.cache[registryPath] = previousRegistry; else delete require.cache[registryPath];
    if (previousUpkeep) require.cache[upkeepPath] = previousUpkeep; else delete require.cache[upkeepPath];
    if (previousRuntime) require.cache[runtimePath] = previousRuntime; else delete require.cache[runtimePath];
  }
});

test('enforcement CLI reports json, text, exit codes, errors and dispatcher pass-through', () => {
  // The doflow-run locator is a shebang script: win32 cannot exec it, so interpreterSpawn runs it through Git Bash there.
  const run = (args: any, executable: any = path.join(ROOT, 'bin/doflow.js')) => {
    const spawn = executable.endsWith('.js') ? { file: process.execPath, args: [executable, ...args] } : interpreterSpawn(executable, args);
    return spawnSync(spawn.file, spawn.args, { cwd: ROOT, encoding: 'utf8' });
  };
  let result = run(['enforcement', '--harness', 'opencode', '--policy', 'pre-implementation-gate', '--json']);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).class, 'unsupported');
  result = run(['enforcement', '--harness', 'claude', '--policy', 'pre-implementation-gate', '--json']);
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).enforced, true);
  result = run(['enforcement', '--harness', 'claude', '--policy', 'pre-implementation-gate']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /claude pre-implementation-gate: enforced/);
  assert.match(result.stdout, /does not cover: writes via shell commands/);
  result = run(['enforcement', '--harness', 'unknown', '--policy', 'pre-implementation-gate', '--json']);
  assert.equal(result.status, 2); assert.deepEqual(JSON.parse(result.stdout).error, 'unknown-harness');
  for (const harness of ['opencode']) {
    result = run(['enforcement', '--harness', harness, '--policy', 'pre-implementation-gate', '--json']);
    assert.equal(result.status, 1);
    assert.ok(['unsupported', 'unknown'].includes(JSON.parse(result.stdout).class));
  }
  result = run(['enforcement', '--harness', 'copilot', '--policy', 'pre-implementation-gate', '--json']);
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).class, 'blocking'); assert.equal(JSON.parse(result.stdout).enforced, true);
  result = run(['enforcement', '--harness', 'copilot', '--policy', 'pre-bash-guard', '--json']);
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).enforced, true);
  result = run(['enforcement', '--harness', 'claude', '--policy', 'missing', '--json']);
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { error: 'unknown-policy', detail: "Unknown policy 'missing'" });
  result = run(['enforcement', '--harness', 'claude', '--policy', 'pre-implementation-gate', '--profile', 'missing', '--json']);
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { error: 'unknown-profile', detail: "Unknown profile 'missing'" });
  result = run(['enforcement', '--harness', 'codex', '--policy', 'pre-implementation-gate']);
  assert.match(result.stdout, /does not cover: writes via shell commands/);
  assert.match(result.stdout, /prerequisite: hook-review/);
  result = run(['enforcement', '--harness', 'claude', '--policy', 'missing']);
  assert.equal(result.status, 2); assert.match(result.stderr, /Unknown policy/);
  result = run(['enforcement', '--json']); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).error, 'usage');
  result = run(['enforcement', '--harness', 'claude', '--policy', 'pre-implementation-gate', '--json'], path.join(ROOT, 'core/shared/scripts/doflow/bin/doflow-run'));
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).enforced, true);
});
