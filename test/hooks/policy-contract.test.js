'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const CONTRACT = path.resolve(__dirname, '..', '..', 'core/harnesses/shared/hooks/policies/contract.sh');
const BASH = '/bin/bash';
const HAS_JQ = spawnSync('jq', ['--version']).status === 0;

function withRecordPipe(body, { fd = '3', pathEnv = process.env.PATH, stdin = '' } = {}) {
  const script = `. '${CONTRACT}'; ${body}`;
  const env = { ...process.env, PATH: pathEnv };
  if (fd === null) delete env.DOFLOW_DECISION_FD;
  else env.DOFLOW_DECISION_FD = String(fd);
  const r = spawnSync(BASH, ['-c', `( ${script} ) 3>&1`], {
    input: stdin,
    encoding: 'utf8',
    env,
  });
  return r;
}

function recordLines(output) {
  return output.split('\n').filter(Boolean).map((line) => {
    assert.equal(line.charCodeAt(0), 0x1e);
    const json = line.slice(1);
    assert.ok(Buffer.byteLength(line + '\n') <= 200);
    return JSON.parse(json);
  });
}

describe('policy contract decision records', () => {
  test('unset and invalid descriptors write no bytes on any stream', () => {
    for (const fd of [null, '0', '1', '2', '10', 'a']) {
      const r = withRecordPipe('doflow_decision_init pre-bash-guard 1; doflow_decide deny blocked', { fd });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    }
  });

  test('writes provisional record before decisions with ordered compact framing', () => {
    const r = withRecordPipe('doflow_decision_init pre-bash-guard 1; doflow_decide deny blocked; doflow_decide advisory noted');
    assert.equal(r.status, 0);
    assert.deepEqual(recordLines(r.stdout), [
      { v: 1, policy: 'pre-bash-guard', policyVersion: 1, outcome: 'allow', code: 'allow' },
      { v: 1, policy: 'pre-bash-guard', policyVersion: 1, outcome: 'deny', code: 'blocked' },
      { v: 1, policy: 'pre-bash-guard', policyVersion: 1, outcome: 'advisory', code: 'noted' },
    ]);
  });

  test('replaces invalid codes and works without jq', (t) => {
    const dir = tempDir(t, 'doflow-no-jq-');
    const r = withRecordPipe('doflow_decision_init pre-bash-guard 1; doflow_decide deny Bad/Code', { pathEnv: dir });
    assert.equal(r.status, 0);
    assert.deepEqual(recordLines(r.stdout).map((x) => x.code), ['allow', 'invalid-code']);
  });
});

describe('policy contract envelope classes', { skip: !HAS_JQ && 'jq is not installed' }, () => {
  for (const [name, event, expected] of [
    ['legacy missing event', {}, 'v0'],
    ['legacy missing version', { doflow_event: { operation: 'edit' } }, 'v0'],
    ['numeric one', { doflow_event: { version: 1, operation: 'edit' } }, 'v1'],
    ['string one', { doflow_event: { version: '1' } }, 'unsupported'],
    ['null version', { doflow_event: { version: null } }, 'unsupported'],
    ['fractional version', { doflow_event: { version: 1.5 } }, 'unsupported'],
    ['object version', { doflow_event: { version: {} } }, 'unsupported'],
    ['other version', { doflow_event: { version: 2 } }, 'unsupported'],
  ]) {
    test(`${name} classifies as ${expected}`, () => {
      const r = spawnSync(BASH, ['-c', `. '${CONTRACT}'; INPUT=$(cat); doflow_read_envelope; printf '%s' "$DF_ENV_CLASS"`], {
        input: JSON.stringify(event), encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, expected);
    });
  }
});
