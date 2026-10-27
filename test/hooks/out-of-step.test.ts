'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { buildInstallMirror, createScratchGitRepo, parseRecords, runPolicy } = require('../helper/hook-fixtures.ts');

const POLICIES = path.resolve(__dirname, '../../core/harnesses/shared/hooks/policies');
const BLOCKING: any = ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard'];
const QUIET: any = ['stop-check', 'session-context', 'subagent-audit', 'user-prompt-submit'];
const OLD_DOORS: any = {
  claude: ['core/harnesses/claude/hooks/pre-implement-gate.sh', '.claude/hooks/pre-implement-gate.sh'],
  codex: ['core/harnesses/codex/hooks/pre-implement-gate.sh', '.codex/hooks/pre-implement-gate.sh'],
  kiro: ['core/harnesses/kiro/hooks/pre-implement-gate.sh', '.kiro/hooks/pre-implement-gate.sh'],
};

function write(file: any, contents: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function installOldDoors(mirror: any) {
  for (const [source, installed] of Object.values(OLD_DOORS)) {
    const contents = execFileSync('git', ['show', `0fcd973:${source}`], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
    write(path.join(mirror, installed), contents);
    fs.chmodSync(path.join(mirror, installed), 0o755);
  }
}

function runOldDoor(harness: any, mirror: any, project: any, input: any) {
  const [, installed] = OLD_DOORS[harness];
  const result = spawnSync(bashPath(), [path.join(mirror, installed)], {
    cwd: project,
    input: `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    env: { ...process.env, DOFLOW_AGENT: harness, DOFLOW_PROJECT_DIR: project, DOFLOW_FAILURE_CAPTURE: 'off' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('missing, empty, malformed and non-object input take the IC-036 policy rule', () => {
  const cases: any = [
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
      assert.deepEqual(parseRecords(result.records).slice(-1).map(({ outcome, code }: any) => [outcome, code]), [['deny', 'envelope-missing']]);
    }
    for (const policy of QUIET) {
      const result = runPolicy(policy, input, { decisionFd: true });
      assert.equal(result.status, 0, `${name}/${policy}`);
      assert.equal(result.stderr, '', `${name}/${policy} stderr`);
      assert.equal(result.stdout, policy === 'user-prompt-submit' ? '{}' : '', `${name}/${policy} stdout`);
      assert.deepEqual(parseRecords(result.records).slice(-1).map(({ outcome, code }: any) => [outcome, code]), [['unsupported', 'envelope-missing']], `${name}/${policy} record`);
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

test('0fcd973 pre-tool doors turn native payloads into DEC-033 out-of-step denies', (t) => {
  const temp = tempDir(t, 'doflow-out-of-step-old-doors-');
  const mirror = path.join(temp, 'mirror');
  buildInstallMirror(mirror);
  installOldDoors(mirror);
  const { root: project } = createScratchGitRepo({ path: (...parts: any[]) => path.join(temp, ...parts) }, 'project');
  const nativeByHarness: any = {
    claude: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } },
    codex: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } },
    kiro: { hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { path: 'src/a.js' } },
  };
  for (const harness of Object.keys(OLD_DOORS)) {
    const result = runOldDoor(harness, mirror, project, nativeByHarness[harness]);
    const reason = `[pre-implementation-gate] DoFlow hooks out of step; run: doflow update -t ${harness}`;
    if (harness === 'kiro') {
      assert.equal(result.status, 2, `${harness} native deny exit`);
      assert.equal(result.stdout, '', `${harness} stdout`);
      assert.equal(result.stderr, `${reason}\n`, `${harness} native deny reason`);
    } else {
      assert.equal(result.status, 0, `${harness} translated deny exit`);
      const response = JSON.parse(result.stdout);
      assert.equal(response.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(response.hookSpecificOutput.permissionDecisionReason, reason);
    }
  }
});

test('legacy native tool read in a temp policy lets the 0fcd973 Claude door allow', (t) => {
  const temp = tempDir(t, 'doflow-out-of-step-legacy-control-');
  const mirror = path.join(temp, 'mirror');
  buildInstallMirror(mirror);
  installOldDoors(mirror);
  const { root: project } = createScratchGitRepo({ path: (...parts: any[]) => path.join(temp, ...parts) }, 'project');
  const policy = path.join(mirror, '.doflow/shared/hooks/policies/pre-implementation-gate.sh');
  const policyText = fs.readFileSync(policy, 'utf8');
  const missingBranch = /else\n  if \[ "\$\{DF_ENV_CODE:-envelope-missing\}" != contract-missing \]; then[\s\S]*?  doflow_decide deny "\$\{DF_ENV_CODE:-envelope-missing\}"\n  exit 2\nfi\n/;
  assert.match(policyText, missingBranch, 'temporary policy contains the missing-envelope rule');
  const nativeRead = `else\n  ENVELOPE_OP=$(jq -r 'if .tool_name == "Edit" or .tool_name == "Write" or .tool_name == "MultiEdit" then "edit" else empty end' <<<"$INPUT")\n  [ "$ENVELOPE_OP" = edit ] || exit 0\n  FILES=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")\nfi\n`;
  fs.writeFileSync(policy, policyText.replace(missingBranch, nativeRead));
  const result = runOldDoor('claude', mirror, project, {
    hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.js' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('0fcd973 Claude and Codex Stop and SessionStart doors stay silent against the current tree', (t) => {
  const temp = tempDir(t, 'doflow-out-of-step-old-lifecycle-doors-');
  const mirror = path.join(temp, 'mirror');
  buildInstallMirror(mirror);
  const { root: project } = createScratchGitRepo({ path: (...parts: any[]) => path.join(temp, ...parts) }, 'project');
  const rows: any = [
    ['claude', 'stop-check.sh', 'core/harnesses/claude/hooks/stop-check.sh', { hook_event_name: 'Stop', stop_hook_active: false }],
    ['codex', 'stop-check.sh', 'core/harnesses/codex/hooks/stop-check.sh', { hook_event_name: 'Stop', stop_hook_active: false }],
    ['claude', 'session-start.sh', 'core/harnesses/claude/hooks/session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' }],
    ['codex', 'session-start.sh', 'core/harnesses/codex/hooks/session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' }],
  ];
  for (const [harness, name, source, input] of rows) {
    const contents = execFileSync('git', ['show', `0fcd973:${source}`], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
    const installed = path.join(mirror, `.${harness}/hooks/${name}`);
    write(installed, contents);
    fs.chmodSync(installed, 0o755);
    const result = spawnSync(bashPath(), [installed], {
      cwd: project, input: `${JSON.stringify(input)}\n`, encoding: 'utf8',
      env: { ...process.env, DOFLOW_AGENT: harness, DOFLOW_PROJECT_DIR: project, DOFLOW_FAILURE_CAPTURE: 'off' },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${harness}/${name} exit`);
    // Codex's legacy Stop adapter always emits its native continue object; it carries no deny output.
    assert.equal(result.stdout || '', harness === 'codex' && name === 'stop-check.sh' ? '{}\n' : '', `${harness}/${name} stdout`);
    assert.equal(result.stderr || '', '', `${harness}/${name} stderr`);
  }
});
