'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enforcementFor, UnknownEnforcementTarget } = require('../../src/lifecycle/coverage.ts');

const row = (values = {}) => ({
  policy: 'stop-check', harness: 'claude', event: 'Stop', timing: 'stop', profile: 'any',
  wired: true, class: 'blocking', verification: 'verified', prerequisites: [], covers: ['session state'],
  doesNotCover: [], caveats: [], ...values,
});
const coverage = rows => ({ schemaVersion: 1, revision: 1, rowsDigest: 'unused', profiles: { any: 'all' }, rows });

test('stop-check enforcement uses stop timing rows', () => {
  const answer = enforcementFor(coverage([
    row(),
    row({ event: 'PreToolUse', timing: 'pre-tool', class: 'unknown', verification: 'unverified' }),
  ]), { harness: 'claude', policy: 'stop-check' });
  assert.equal(answer.class, 'blocking');
  assert.equal(answer.enforced, true);
  assert.deepEqual(answer.rows.map(item => item.timing), ['stop']);
});

test('other policies keep pre-tool timing and stop-check ignores non-stop rows', () => {
  const rows = [
    row({ policy: 'pre-bash-guard', event: 'PreToolUse', timing: 'pre-tool' }),
    row({ policy: 'stop-check', class: 'advisory', verification: 'unverified' }),
  ];
  const stop = enforcementFor(coverage(rows), { harness: 'claude', policy: 'stop-check' });
  const pre = enforcementFor(coverage(rows), { harness: 'claude', policy: 'pre-bash-guard' });
  assert.equal(stop.class, 'advisory');
  assert.equal(pre.class, 'blocking');
  assert.deepEqual(stop.rows.map(item => item.timing), ['stop']);
  assert.deepEqual(pre.rows.map(item => item.timing), ['pre-tool']);
});

test('wildcard is rejected as an unknown policy', () => {
  assert.throws(
    () => enforcementFor(coverage([row({ policy: '*' })]), { harness: 'claude', policy: '*' }),
    error => error instanceof UnknownEnforcementTarget && error.code === 'unknown-policy',
  );
});
