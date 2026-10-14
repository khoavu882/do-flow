'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const ROOT = path.resolve(__dirname, '../..');
const BRIDGE_SOURCE = path.join(ROOT, 'core/harnesses/shared/hooks/bridge');
const POLICY_SOURCE = path.join(ROOT, 'core/harnesses/shared/hooks/policies');
const POLICIES = [
  'pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard',
  'session-context', 'stop-check', 'user-prompt-submit', 'subagent-audit',
];
const BLOCKING = new Set(['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard', 'stop-check']);
const BRIDGES = [
  ['claude', 'PreToolUse'], ['codex', 'PreToolUse'], ['gemini', 'BeforeTool'],
  ['kiro', 'PreToolUse'], ['antigravity', 'PreToolUse'], ['pi', 'tool_call'],
];

function makeBridgeTree(t) {
  const root = tempDir(t, 'doflow-encode-fault-');
  fs.cpSync(BRIDGE_SOURCE, path.join(root, 'bridge'), { recursive: true });
  fs.cpSync(POLICY_SOURCE, path.join(root, 'policies'), { recursive: true });
  return root;
}

function runBridge(root, harness, event, policy, profile, input) {
  const xdg = path.join(root, `xdg-${harness}-${policy}-${profile}`);
  const result = spawnSync('bash', [path.join(root, 'bridge/bridge.sh'), harness, event, policy, '--emit', 'decision'], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.join(root, 'home'),
      XDG_CONFIG_HOME: xdg,
      DOFLOW_FAILURE_CAPTURE: 'on',
      DOFLOW_FAULT_PROFILE: profile,
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { ...result, xdg };
}

function baselinePolicies(t) {
  const parent = tempDir(t, 'doflow-0fcd973-');
  const archive = spawnSync('git', ['-C', ROOT, 'archive', '0fcd973', 'core/harnesses/shared/hooks'], {
    encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(archive.status, 0, `git archive 0fcd973: ${String(archive.stderr)}`);
  const extract = spawnSync('tar', ['-x', '-C', parent], { input: archive.stdout, encoding: 'utf8' });
  assert.equal(extract.status, 0, `extract 0fcd973 archive: ${extract.stderr}`);
  return path.join(parent, 'core/harnesses/shared/hooks/policies');
}

function runBaselinePolicy(policyDir, policy, input) {
  const root = path.dirname(path.dirname(policyDir));
  const result = spawnSync('bash', [path.join(policyDir, `${policy}.sh`)], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'xdg'),
      DOFLOW_FAILURE_CAPTURE: 'off',
      DOFLOW_AGENT: 'claude',
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function compatEffect(harness, status) {
  if (status === 0) return 'proceed';
  if (harness === 'kiro') return status === 2 ? 'block' : 'proceed';
  return 'block';
}

test('compat-1 empty and malformed input matches the 0fcd973 policy verdict for every bridge', (t) => {
  const policyDir = baselinePolicies(t);
  const root = makeBridgeTree(t);
  const oracleResults = new Map();
  for (const policy of POLICIES) {
    for (const [label, input] of [['empty', ''], ['malformed', 'not json']]) {
      oracleResults.set(`${policy}/${label}`, runBaselinePolicy(policyDir, policy, input));
    }
  }
  for (const [harness, event] of BRIDGES) {
    for (const policy of POLICIES) {
      for (const [label, input] of [['empty', ''], ['malformed', 'not json']]) {
        const oracle = oracleResults.get(`${policy}/${label}`);
        const result = runBridge(root, harness, event, policy, 'compat-1', input);
        assert.equal(result.status, 0, `${harness}/${policy}/${label} decision command`);
        const decision = JSON.parse(result.stdout.trim());
        assert.equal(decision.effect, compatEffect(harness, oracle.status), `${harness}/${policy}/${label} 0fcd973 exit ${oracle.status}`);
      }
    }
  }
});

test('envelope-encode is a bridge fault under both profiles on all six bridges', (t) => {
  const root = makeBridgeTree(t);
  for (const [harness, event] of BRIDGES) {
    for (const policy of POLICIES) {
      for (const profile of ['compat-1', 'strict-1']) {
        const result = runBridge(root, harness, event, policy, profile, 'not json');
        assert.equal(result.status, 0, `${harness}/${policy}/${profile} decision command`);
        const decision = JSON.parse(result.stdout.trim());
        assert.equal(decision.code, 'envelope-encode', `${harness}/${policy}/${profile} point`);
        assert.equal(decision.faultProfile, profile, `${harness}/${policy}/${profile} profile`);
        assert.equal(decision.effect, profile === 'strict-1' && BLOCKING.has(policy) ? 'block' : 'proceed',
          `${harness}/${policy}/${profile} IC-011 effect`);
        const events = path.join(result.xdg, 'doflow/failures/events.jsonl');
        assert.match(fs.readFileSync(events, 'utf8'), /"kind":"envelope-encode"/, `${harness}/${policy}/${profile} capture`);
      }
    }
  }
});
