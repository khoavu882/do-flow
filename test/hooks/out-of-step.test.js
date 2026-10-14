'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { parseRecords, runPolicy } = require('../helper/hook-fixtures');

const POLICIES = path.resolve(__dirname, '../../core/harnesses/shared/hooks/policies');
const BLOCKING = ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard'];
const QUIET = ['stop-check', 'session-context', 'subagent-audit', 'user-prompt-submit'];

test('missing, empty, malformed and non-object input take the IC-036 policy rule', () => {
  const cases = [
    ['missing envelope', '{}'],
    ['empty input', ''],
    ['malformed input', 'not json'],
    ['non-object input', '[]'],
  ];
  for (const [name, input] of cases) {
    for (const policy of BLOCKING) {
      const result = runPolicy(policy, input, { decisionFd: true, env: { DOFLOW_AGENT: 'claude' } });
      assert.equal(result.status, 2, `${name}/${policy}`);
      assert.equal(result.stdout, '', `${name}/${policy} stdout`);
      assert.equal(result.stderr, `[${policy}] DoFlow hooks out of step; run: doflow update -t claude\n`, `${name}/${policy} stderr`);
      assert.deepEqual(parseRecords(result.records).slice(-1).map(({ outcome, code }) => [outcome, code]), [['deny', 'envelope-missing']]);
    }
    for (const policy of QUIET) {
      const result = runPolicy(policy, input, { decisionFd: true });
      assert.equal(result.status, 0, `${name}/${policy}`);
      assert.equal(result.stderr, '', `${name}/${policy} stderr`);
      assert.equal(result.stdout, policy === 'user-prompt-submit' ? '{}' : '', `${name}/${policy} stdout`);
      assert.deepEqual(parseRecords(result.records).slice(-1).map(({ outcome, code }) => [outcome, code]), [['unsupported', 'envelope-missing']], `${name}/${policy} record`);
    }
  }
});

test('contract.sh missing is the same out-of-step rule with contract-missing records', (t) => {
  const temp = tempDir(t, 'doflow-out-of-step-contract-');
  for (const policy of [...BLOCKING, ...QUIET]) {
    const copy = path.join(temp, policy);
    fs.cpSync(POLICIES, copy, { recursive: true });
    fs.rmSync(path.join(copy, 'contract.sh'));
    const result = runPolicy(policy, JSON.stringify({ doflow_event: { version: 1, operation: 'edit' } }), {
      decisionFd: true, policyPath: path.join(copy, `${policy}.sh`), env: { DOFLOW_AGENT: 'claude' },
    });
    const isBlocking = BLOCKING.includes(policy);
    assert.equal(result.status, isBlocking ? 2 : 0, policy);
    assert.equal(result.stdout, policy === 'user-prompt-submit' ? '{}' : '', `${policy} stdout`);
    assert.equal(result.stderr, isBlocking ? `[${policy}] DoFlow hooks out of step; run: doflow update -t claude\n` : '', `${policy} stderr`);
    assert.deepEqual(parseRecords(result.records), [], `${policy} has no contract with which to write decisions`);
  }
});
