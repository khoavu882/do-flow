'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp');

const ROOT = path.resolve(__dirname, '../..');
const BRIDGE_DIR = path.join(ROOT, 'core/harnesses/shared/hooks/bridge');
const POLICY_IDS = [
  'pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'stop-check',
  'session-context', 'user-prompt-submit', 'subagent-audit',
];

function makeTree(policyBody) {
  const dir = suiteTempDir('doflow-bridge-v4-');
  fs.mkdirSync(path.join(dir, 'bridge'));
  fs.mkdirSync(path.join(dir, 'policies'));
  for (const file of ['bridge.sh', 'envelope.jq', 'respond.sh']) {
    const source = file === 'bridge.sh' && process.env.DOFLOW_BRIDGE_SOURCE
      ? process.env.DOFLOW_BRIDGE_SOURCE
      : path.join(BRIDGE_DIR, file);
    fs.copyFileSync(source, path.join(dir, 'bridge', file));
  }
  for (const file of ['deny-json.sh', 'capture-failure.sh']) {
    fs.copyFileSync(path.join(ROOT, 'core/harnesses/shared/hooks/policies', file), path.join(dir, 'policies', file));
  }
  for (const id of POLICY_IDS) {
    fs.writeFileSync(path.join(dir, 'policies', `${id}.sh`), policyBody || `#!/bin/bash\nprintf '\\036%s\\n' '{"outcome":"allow","code":"allow","policyVersion":1}' >&3\nexit 0\n`);
  }
  return dir;
}

function run(dir, harness, event, policy, input = {}, args = [], env = {}) {
  const childEnv = { ...process.env, DOFLOW_FAILURE_CAPTURE: 'off', ...env };
  return spawnSync('bash', [path.join(dir, 'bridge/bridge.sh'), harness, event, policy, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: childEnv,
  });
}

test('gate denies still run when TMPDIR is unusable on each shell door', async (t) => {
  const rows = [['claude', 'PreToolUse'], ['codex', 'PreToolUse'], ['gemini', 'BeforeTool'], ['pi', 'tool_call']];
  for (const [harness, event] of rows) await t.test(`${harness}:${event}`, () => {
    const dir = makeTree(`#!/bin/bash\nprintf '\\036%s\\n' '{"outcome":"deny","code":"blocked","policyVersion":1}' >&3\necho blocked >&2\nexit 2\n`);
    const result = run(dir, harness, event, 'pre-implementation-gate', {}, [], { TMPDIR: '/nonexistent' });
    assert.match(result.stdout, /blocked/, `${harness}:${event} native deny reason survives TMPDIR failure`);
  });
});

test('a noncanonical policy id is rejected as bridge-spawn without execution', () => {
  const dir = makeTree();
  const result = run(dir, 'claude', 'PreToolUse', '../bridge/respond', {}, ['--emit', 'decision']);
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.outcome, 'error');
  assert.equal(decision.code, 'bridge-spawn');
});

test('an envelope encode fault preserves an explicit deny decision code', () => {
  const dir = makeTree(`#!/bin/bash\nprintf '\\036%s\\n' '{"outcome":"deny","code":"blocked","policyVersion":1}' >&3\necho blocked >&2\nexit 2\n`);
  const result = run(dir, 'claude', 'PreToolUse', 'pre-implementation-gate', 'not json', ['--emit', 'decision']);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.code, 'blocked');
});

test('Kiro set-e session-start has no stderr temp artifact', () => {
  const dir = makeTree('#!/bin/bash\necho policy-fault >&2\nexit 1\n');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  const bridge = path.join(dir, 'bridge/bridge.sh');
  const result = spawnSync('bash', ['-c', 'set -e; . "$1"; doflow_bridge kiro SessionStart session-context', 'test-caller', bridge], {
    cwd: dir, encoding: 'utf8', input: '{}', env: { ...process.env, TMPDIR: tmp, DOFLOW_FAILURE_CAPTURE: 'off' },
  });
  assert.equal(result.status, 1, result.stderr, 'set -e caller observes the native policy error exit');
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('codex Stop policy fault suppresses raw stderr', () => {
  const dir = makeTree('#!/bin/bash\necho secret-policy-diagnostic >&2\nexit 9\n');
  const result = run(dir, 'codex', 'Stop', 'stop-check', {}, ['--emit', 'native']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{}\n');
});

test('strict-1 Stop fault proceeds for stop-check while recording its decision', () => {
  const dir = makeTree('#!/bin/bash\necho stop-fault >&2\nexit 9\n');
  const result = run(dir, 'claude', 'Stop', 'stop-check', {}, ['--emit', 'decision'], { DOFLOW_FAULT_PROFILE: 'strict-1' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).effect, 'proceed');
});

test('merged stderr preserves each line and its trailing newline exactly', () => {
  const dir = makeTree(`#!/bin/bash\nprintf "first\\nsecond\\n" >&2\nprintf '\\036%s\\n' '{"outcome":"allow","code":"allow","policyVersion":1}' >&3\nexit 0\n`);
  const result = run(dir, 'claude', 'SessionStart', 'session-context');
  assert.equal(result.stderr, 'first\nsecond\n');
});
