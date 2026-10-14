'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch, loadCorpus, parseRecords, runPolicy } = require('../helper/hook-fixtures');

const scratch = createScratch('doflow-policy-envelope-');
after(() => scratch.remove());

for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard']) {
  test(`${policy}: legacy inputs preserve golden stdout, stderr and exit status`, () => {
    for (const row of loadCorpus(policy)) {
      const result = runPolicy(policy, row.input);
      assert.equal(result.status, row.status, `${row.name} exit`);
      assert.equal(result.stdout, row.stdout, `${row.name} stdout`);
      assert.equal(result.stderr, row.stderr, `${row.name} stderr`);
    }
  });
}

test('decision fd writes provisional allow before each deny record', () => {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  const result = runPolicy('pre-bash-guard', input, { decisionFd: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Catastrophic delete blocked/);
  const records = parseRecords(result.records);
  assert.deepEqual(records.map(({ outcome, code }) => [outcome, code]), [
    ['allow', 'allow'], ['deny', 'blocked-pattern'],
  ]);
});

test('v1 policy verdicts match v0 verdicts for every legacy fixture input', () => {
  for (const row of loadCorpus('pre-bash-guard')) {
    const native = JSON.parse(row.input);
    const v1 = {
      doflow_event: {
        version: 1, operation: 'command', tool: native.tool_name,
        command: native.tool_input.command,
      },
    };
    const legacyResult = runPolicy('pre-bash-guard', row.input);
    const envelopeResult = runPolicy('pre-bash-guard', JSON.stringify(v1));
    assert.equal(envelopeResult.status, legacyResult.status, row.name);
    assert.equal(envelopeResult.stdout, legacyResult.stdout, row.name);
    assert.equal(envelopeResult.stderr, legacyResult.stderr, row.name);
  }
  for (const row of loadCorpus('mcp-tool-guard')) {
    const native = JSON.parse(row.input);
    const name = native.tool_name;
    const v1 = { doflow_event: { version: 1, operation: name.startsWith('mcp_') ? 'mcp' : 'tool', tool: name } };
    const legacyResult = runPolicy('mcp-tool-guard', row.input);
    const envelopeResult = runPolicy('mcp-tool-guard', JSON.stringify(v1));
    assert.equal(envelopeResult.status, legacyResult.status, row.name);
    assert.equal(envelopeResult.stdout, legacyResult.stdout, row.name);
    assert.equal(envelopeResult.stderr, legacyResult.stderr, row.name);
  }
});

test('v1 policies use envelope fields and unsupported versions do not evaluate native fields', () => {
  const cases = [];
  for (const version of [2, '1', null]) {
    cases.push(
      ['pre-implementation-gate', { doflow_event: { version, operation: 'edit' }, tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } }],
      ['pre-bash-guard', { doflow_event: { version, operation: 'command', command: 'rm -rf /' }, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }],
      ['mcp-tool-guard', { doflow_event: { version, operation: 'mcp', tool: 'mcp__x__delete' }, tool_name: 'mcp__x__delete' }],
    );
  }
  for (const [policy, payload] of cases) {
    const result = runPolicy(policy, JSON.stringify(payload), { decisionFd: true });
    assert.equal(result.status, 0, policy);
    assert.equal(result.stdout, '', policy);
    assert.equal(result.stderr, '', policy);
    assert.deepEqual(parseRecords(result.records).map(({ outcome, code }) => [outcome, code]), [
      ['allow', 'allow'], ['unsupported', 'envelope-version'],
    ]);
  }
});

test('v1 edit without a target is diagnosed; v0 remains silent', () => {
  const v1 = runPolicy('pre-implementation-gate', JSON.stringify({ doflow_event: { version: 1, operation: 'edit' } }), { decisionFd: true });
  assert.equal(v1.status, 0);
  assert.deepEqual(parseRecords(v1.records).map(({ outcome, code }) => [outcome, code]), [
    ['allow', 'allow'], ['unsupported', 'edit-without-target'],
  ]);

  const v0 = runPolicy('pre-implementation-gate', JSON.stringify({ doflow_event: { operation: 'edit' } }), { decisionFd: true });
  assert.equal(v0.status, 0);
  assert.deepEqual(parseRecords(v0.records).map(({ outcome, code }) => [outcome, code]), [['allow', 'allow']]);
});

test('all three policies remain safe when sourced under set -euo pipefail', () => {
  for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard']) {
    const script = `set -euo pipefail\nINPUT='{}'\nsource "${path.resolve(__dirname, '../../core/harnesses/shared/hooks/policies/contract.sh')}"\ndoflow_decision_init ${policy} 1\ndoflow_read_envelope\n`;
    const result = require('node:child_process').spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${policy}: ${result.stderr}`);
  }
});

test('jq missing records a fault and keeps today’s allow result', () => {
  const bin = scratch.path('no-jq-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync('/bin/bash', path.join(bin, 'bash'));
  fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
  fs.symlinkSync('/bin/cat', path.join(bin, 'cat'));
  for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard']) {
    const result = runPolicy(policy, '{}', {
      decisionFd: true,
      env: { PATH: bin },
    });
    assert.equal(result.status, 0, policy);
    assert.equal(result.stdout, '', policy);
    assert.equal(result.stderr, '', policy);
    assert.deepEqual(parseRecords(result.records).map(({ outcome, code }) => [outcome, code]), [
      ['allow', 'allow'], ['error', 'dependency-missing:jq'],
    ]);
  }
});

test('contract missing keeps 0fcd973 bytes and records contract-missing for every policy', () => {
  const cases = [
    ['pre-implementation-gate', 'native-read'],
    ['pre-bash-guard', 'native-safe-command'],
    ['mcp-tool-guard', 'native-mcp-allow'],
  ];
  for (const [policy, fixture] of cases) {
    const policyDir = scratch.path(`missing-contract/${policy}`);
    fs.mkdirSync(path.dirname(policyDir), { recursive: true });
    fs.cpSync(path.join(__dirname, '../../core/harnesses/shared/hooks/policies'), policyDir, { recursive: true });
    fs.rmSync(path.join(policyDir, 'contract.sh'));
    const row = loadCorpus(policy).find((item) => item.name === fixture);
    const failureRoot = scratch.path(`missing-contract/${policy}/failures`);
    const result = runPolicy(policy, row.input, {
      policyPath: path.join(policyDir, `${policy}.sh`),
      env: { XDG_CONFIG_HOME: failureRoot, DOFLOW_FAILURE_CAPTURE: '' },
    });
    assert.equal(result.status, row.status, `${policy} exit`);
    assert.equal(result.stdout, row.stdout, `${policy} stdout`);
    assert.equal(result.stderr, row.stderr, `${policy} stderr`);
    const events = JSON.parse(fs.readFileSync(path.join(failureRoot, 'doflow/failures/events.jsonl'), 'utf8').trim());
    assert.deepEqual([events.command, events.kind], [policy, 'contract-missing']);
  }
});
