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
    assert.deepEqual(r.stdout.split('\n').filter(Boolean).map((line) => line.slice(1)), [
      '{"v":1,"policy":"pre-bash-guard","policyVersion":1,"outcome":"allow","code":"allow"}',
      '{"v":1,"policy":"pre-bash-guard","policyVersion":1,"outcome":"deny","code":"blocked"}',
      '{"v":1,"policy":"pre-bash-guard","policyVersion":1,"outcome":"advisory","code":"noted"}',
    ]);
    assert.deepEqual(recordLines(r.stdout), [
      { v: 1, policy: 'pre-bash-guard', policyVersion: 1, outcome: 'allow', code: 'allow' },
      { v: 1, policy: 'pre-bash-guard', policyVersion: 1, outcome: 'deny', code: 'blocked' },
      { v: 1, policy: 'pre-bash-guard', policyVersion: 1, outcome: 'advisory', code: 'noted' },
    ]);
  });

  test('replaces invalid codes and works without jq', (t) => {
    const dir = tempDir(t, 'doflow-no-jq-');
    const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PATH: dir, DOFLOW_DECISION_FD: '3' };
    const r = spawnSync(BASH, ['-c', `( . '${CONTRACT}'; doflow_decision_init pre-bash-guard 1; doflow_decide deny Bad; doflow_decide deny aB; doflow_decide deny é ) 3>&1`], {
      encoding: 'utf8', env,
    });
    assert.equal(r.status, 0);
    assert.deepEqual(recordLines(r.stdout).map((x) => x.code), ['allow', 'invalid-code', 'invalid-code', 'invalid-code']);
  });

  test('decision before init has a valid default policy version', () => {
    const r = withRecordPipe('doflow_decide deny blocked');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '\x1e{"v":1,"policy":"","policyVersion":0,"outcome":"deny","code":"blocked"}\n');
  });

  test('is safe when sourced by a set-euo-pipefail caller', () => {
    const event = {
      doflow_event: {
        version: 1, harness: 'claude', event: 'PreToolUse', operation: 'edit', tool: 'Edit',
        paths: ['one.ts', 'two.ts'], command: 'printf "hi"', patch: 'line 1\n"quoted"',
        projectRoot: '/repo/root', taskId: 'task-7',
      },
    };
    const r = spawnSync(BASH, ['-c', `set -euo pipefail; . '${CONTRACT}'; doflow_decision_init gate 2; INPUT=$(cat); doflow_read_envelope; printf '%s\\037' "$DF_ENV_CLASS" "$DF_ENV_HARNESS" "$DF_ENV_EVENT" "$DF_ENV_OP" "$DF_ENV_TOOL" "$DF_ENV_PATHS" "$DF_ENV_COMMAND" "$DF_ENV_PATCH" "$DF_ENV_ROOT" "$DF_ENV_TASK"`], {
      input: JSON.stringify(event), encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\x1f'), [
      'v1', 'claude', 'PreToolUse', 'edit', 'Edit', 'one.ts\ntwo.ts', 'printf "hi"',
      'line 1\n"quoted"', '/repo/root', 'task-7', '',
    ]);
  });

  test('empty and non-object input classify as invalid', { skip: !HAS_JQ && 'jq is not installed' }, () => {
    for (const input of ['', '[]', 'null']) {
      const r = spawnSync(BASH, ['-c', `. '${CONTRACT}'; INPUT=$(cat); doflow_read_envelope; printf '%s' "$DF_ENV_CLASS"`], {
        input, encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'invalid');
    }
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
