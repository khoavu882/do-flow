'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_DIR = path.join(ROOT, 'core/harnesses/shared/hooks/policies');
const FIXTURE_DIR = path.join(ROOT, 'test/fixtures/hooks/policy-golden');
const POLICIES = ['stop-check', 'session-context', 'user-prompt-submit', 'subagent-audit'];
const BASH = '/bin/bash';

function run(policy, input, { records = false, configHome, policyDir = POLICY_DIR } = {}) {
  const options = {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...(records ? { DOFLOW_DECISION_FD: '3' } : {}), ...(configHome ? { XDG_CONFIG_HOME: configHome } : {}) },
  };
  if (records) options.stdio = ['pipe', 'pipe', 'pipe', 'pipe'];
  const result = spawnSync(BASH, [path.join(policyDir, `${policy}.sh`)], options);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', records: result.output?.[3]?.toString() || '' };
}

function parseRecords(bytes) {
  return bytes.split('\n').filter(Boolean).map((line) => {
    assert.equal(line.charCodeAt(0), 0x1e);
    return JSON.parse(line.slice(1));
  });
}

describe('B.2 policy decision records', () => {
  for (const policy of POLICIES) {
    test(`${policy} keeps its 0fcd973 no-fd bytes`, () => {
      const inputPath = path.join(FIXTURE_DIR, policy, 'input.json');
      const goldenPath = path.join(FIXTURE_DIR, policy, 'golden.json');
      const expected = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
      const actual = run(policy, fs.readFileSync(inputPath, 'utf8'));
      assert.deepEqual(actual, { ...expected, records: '' });
    });

    test(`${policy} records provisional allow before unsupported version and does not evaluate`, (t) => {
      const configHome = tempDir(t, `doflow-policy-records-${policy}-`);
      const payload = JSON.stringify({ session_id: 'record-test', doflow_event: { version: 2 } });
      const result = run(policy, payload, { records: true, configHome });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.deepEqual(parseRecords(result.records), [
        { v: 1, policy, policyVersion: 1, outcome: 'allow', code: 'allow' },
        { v: 1, policy, policyVersion: 1, outcome: 'unsupported', code: 'envelope-version' },
      ]);
    });

    test(`${policy} preserves native behavior and captures contract-missing without contract.sh`, (t) => {
      const root = tempDir(t, `doflow-policy-contract-missing-${policy}-`);
      const policyCopy = path.join(root, 'policies');
      fs.cpSync(POLICY_DIR, policyCopy, { recursive: true });
      fs.unlinkSync(path.join(policyCopy, 'contract.sh'));
      const inputPath = path.join(FIXTURE_DIR, policy, 'input.json');
      const input = fs.readFileSync(inputPath, 'utf8');
      const configHome = path.join(root, 'config');
      const expected = run(policy, input);
      const nativePayload = JSON.parse(input);
      nativePayload.doflow_event = { version: 2 };
      const actual = run(policy, JSON.stringify(nativePayload), { policyDir: policyCopy, configHome });
      assert.equal(actual.status, expected.status, 'exit status matches native policy');
      assert.equal(actual.stdout, expected.stdout, 'stdout matches native policy');
      assert.equal(actual.stderr, expected.stderr, 'stderr matches native policy');
      const eventsPath = path.join(configHome, 'doflow/failures/events.jsonl');
      const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(events.length, 1);
      assert.equal(events[0].command, policy);
      assert.equal(events[0].kind, 'contract-missing');
    });
  }

  test('stop-check records its blocking stub decision', (t) => {
    const configHome = tempDir(t, 'doflow-policy-records-stop-deny-');
    const payload = JSON.stringify({ session_id: 'stop-deny', last_assistant_message: '// TODO: finish' });
    const result = run('stop-check', payload, { records: true, configHome });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /unfinished-work marker/);
    assert.deepEqual(parseRecords(result.records), [
      { v: 1, policy: 'stop-check', policyVersion: 1, outcome: 'allow', code: 'allow' },
      { v: 1, policy: 'stop-check', policyVersion: 1, outcome: 'deny', code: 'unfinished-work' },
    ]);
  });

  test('sourced policy decisions remain safe under set -euo pipefail', () => {
    const script = `set -euo pipefail; bash '${path.join(POLICY_DIR, 'session-context.sh')}' <<'JSON'\n{"session_id":""}\nJSON\n`;
    const result = spawnSync(BASH, ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
});
