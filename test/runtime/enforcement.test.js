'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { enforcementFor, UnknownEnforcementTarget } = require('../../src/lifecycle/coverage.ts');
const ROOT = path.resolve(__dirname, '../..');
const row = (values = {}) => ({ policy: 'gate', harness: 'claude', event: 'PreToolUse', timing: 'pre-tool', profile: 'any', wired: true, class: 'blocking', verification: 'verified', prerequisites: [], covers: ['edit', 'write'], doesNotCover: ['shell'], caveats: [], ...values });
const coverage = (rows) => ({ schemaVersion: 1, revision: 1, rowsDigest: 'sha256:' + 'a'.repeat(64), profiles: { any: 'all', narrow: 'narrow' }, rows });

test('enforcement answers classes, weakest default, profile filter, aggregation and parity', () => {
  for (const cls of ['blocking', 'observation', 'advisory', 'unsupported', 'unknown']) {
    const answer = enforcementFor(coverage([row({ class: cls, verification: cls === 'blocking' ? 'verified' : 'unverified' })]), { harness: 'claude', policy: 'gate' });
    assert.equal(answer.class, cls);
    assert.equal(answer.enforced, cls === 'blocking');
    assert.equal(answer.parity, cls === 'blocking');
  }
  assert.equal(enforcementFor(coverage([row({ verification: 'unverified' })]), { harness: 'claude', policy: 'gate' }).enforced, false, 'an unverified blocking row is never enforced');
  const rows = [row({ profile: 'any', covers: ['edit', 'write'], doesNotCover: ['shell'], prerequisites: ['trust'] }), row({ profile: 'narrow', class: 'unknown', verification: 'unverified', covers: ['edit'], doesNotCover: ['custom'], prerequisites: ['review'] })];
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
  assert.throws(() => enforcementFor(coverage([row()]), { harness: 'missing', policy: 'gate' }), (error) => error instanceof UnknownEnforcementTarget && error.code === 'unknown-harness');
  assert.throws(() => enforcementFor(coverage([row()]), { harness: 'claude', policy: 'missing' }), (error) => error.code === 'unknown-policy');
  assert.throws(() => enforcementFor(coverage([row()]), { harness: 'claude', policy: 'gate', profile: 'missing' }), (error) => error.code === 'unknown-profile');
});

test('enforcement CLI reports json, text, exit codes, errors and dispatcher pass-through', () => {
  const run = (args, executable = path.join(ROOT, 'bin/doflow.js')) => spawnSync(executable.endsWith('.js') ? process.execPath : executable, executable.endsWith('.js') ? [executable, ...args] : args, { cwd: ROOT, encoding: 'utf8' });
  let result = run(['enforcement', '--harness', 'claude', '--policy', 'pre-implementation-gate', '--json']);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).enforced, false);
  result = run(['enforcement', '--harness', 'claude', '--policy', 'pre-implementation-gate']);
  assert.equal(result.status, 1); assert.match(result.stdout, /claude pre-implementation-gate: not enforced/);
  result = run(['enforcement', '--harness', 'unknown', '--policy', 'pre-implementation-gate', '--json']);
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).error, 'unknown-harness');
  result = run(['enforcement', '--json']); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).error, 'usage');
  result = run(['enforcement', '--harness', 'claude', '--policy', 'pre-implementation-gate', '--json'], path.join(ROOT, 'core/shared/scripts/doflow/bin/doflow-run'));
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).enforced, false);
});
