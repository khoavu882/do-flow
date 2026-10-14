'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch, encodeEnvelope } = require('../helper/hook-fixtures');

const REPO = path.resolve(__dirname, '../..');
const POLICY_DIR = path.join(REPO, 'core/harnesses/shared/hooks/policies');
const scratch = createScratch('doflow-bare-policy-name-');
after(() => scratch.remove());

const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';

function execute(policyDir, policy, bare, input) {
  const script = bare ? policy : path.join(policyDir, policy);
  const result = spawnSync(BASH, [script], {
    cwd: policyDir,
    encoding: 'utf8',
    input,
    env: { ...process.env, DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: 'off' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error };
}

test('pre-bash-guard and pre-implementation-gate resolve siblings for bare-name allow and deny calls', () => {
  const policyDir = path.join(scratch.dir, 'policies');
  fs.cpSync(POLICY_DIR, policyDir, { recursive: true });
  const cases = [
    ['pre-bash-guard.sh', encodeEnvelope('claude', 'PreToolUse', 'pre-bash-guard', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }))],
    ['pre-implementation-gate.sh', encodeEnvelope('claude', 'PreToolUse', 'pre-implementation-gate', JSON.stringify({ tool_name: 'Read', tool_input: {} }))],
  ];

  for (const [policy, input] of cases) {
    const fullPathAllow = execute(policyDir, policy, false, input);
    const bareNameAllow = execute(policyDir, policy, true, input);
    assert.equal(fullPathAllow.error, undefined);
    assert.equal(bareNameAllow.error, undefined);
    assert.equal(fullPathAllow.status, 0, `${policy} allow status`);
    assert.deepEqual(bareNameAllow, fullPathAllow, `${policy} bare-name allow output`);

    fs.rmSync(path.join(policyDir, 'contract.sh'));
    const fullPathDeny = execute(policyDir, policy, false, input);
    const bareNameDeny = execute(policyDir, policy, true, input);
    assert.equal(fullPathDeny.error, undefined);
    assert.equal(bareNameDeny.error, undefined);
    assert.equal(fullPathDeny.status, 2, `${policy} deny status`);
    assert.deepEqual(bareNameDeny, fullPathDeny, `${policy} bare-name deny output`);
    fs.copyFileSync(path.join(POLICY_DIR, 'contract.sh'), path.join(policyDir, 'contract.sh'));
  }
});
