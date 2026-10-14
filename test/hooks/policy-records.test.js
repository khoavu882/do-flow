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

function run(policy, input, { records = false, configHome, policyDir = POLICY_DIR, env = {} } = {}) {
  const options = {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...(records ? { DOFLOW_DECISION_FD: '3' } : {}), ...(configHome ? { XDG_CONFIG_HOME: configHome } : {}), ...env },
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

  test('stop-check golden pins deny stderr and the leak warning', (t) => {
    const root = tempDir(t, 'doflow-policy-records-stop-warning-');
    const configHome = path.join(root, 'config');
    const home = path.join(root, 'home');
    const session = path.join(configHome, 'doflow/session-env/sessions/stop-warning');
    const runner = path.join(home, '.claude/scripts/doflow/bin/doflow-run');
    fs.mkdirSync(session, { recursive: true });
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.writeFileSync(path.join(session, 'edited-files.txt'), 'src/main.js\n');
    fs.writeFileSync(runner, '#!/bin/sh\nprintf "src/main.js:1: FR-001\\n"\n', { mode: 0o755 });
    const input = fs.readFileSync(path.join(FIXTURE_DIR, 'stop-check/deny-warning/input.json'), 'utf8');
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'stop-check/deny-warning/golden.json'), 'utf8'));
    const actual = run('stop-check', input, { records: true, configHome, env: { HOME: home } });
    assert.deepEqual({ status: actual.status, stdout: actual.stdout, stderr: actual.stderr }, expected);
    assert.deepEqual(parseRecords(actual.records), [
      { v: 1, policy: 'stop-check', policyVersion: 1, outcome: 'allow', code: 'allow' },
      { v: 1, policy: 'stop-check', policyVersion: 1, outcome: 'advisory', code: 'internal-identifiers-found' },
      { v: 1, policy: 'stop-check', policyVersion: 1, outcome: 'deny', code: 'unfinished-work' },
    ]);
  });

  test('user-prompt-submit golden pins first-prompt context and nudge JSON', (t) => {
    const root = tempDir(t, 'doflow-policy-records-prompt-nudge-');
    const configHome = path.join(root, 'config');
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const gitInit = spawnSync('git', ['init', '-q', '-b', 'main', project], { encoding: 'utf8' });
    assert.equal(gitInit.status, 0, gitInit.stderr);
    const session = path.join(configHome, 'doflow/session-env/sessions/golden-prompt');
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(session, 'git-context.json'), JSON.stringify({
      branch: 'release', sha: 'abc1234', commits: ['first commit'], uncommitted_count: 2,
      stash_count: 0, is_git_repo: true,
    }));
    const input = fs.readFileSync(path.join(FIXTURE_DIR, 'user-prompt-submit/nudge/input.json'), 'utf8')
      .replaceAll('{{ROOT}}', project);
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'user-prompt-submit/nudge/golden.json'), 'utf8'));
    const actual = run('user-prompt-submit', input, { records: true, configHome, env: { HOME: root, DOFLOW_AGENT: 'claude' } });
    assert.deepEqual({ status: actual.status, stdout: actual.stdout, stderr: actual.stderr }, expected);
    assert.deepEqual(parseRecords(actual.records), [
      { v: 1, policy: 'user-prompt-submit', policyVersion: 1, outcome: 'allow', code: 'allow' },
      { v: 1, policy: 'user-prompt-submit', policyVersion: 1, outcome: 'advisory', code: 'prompt-nudge' },
    ]);
  });

  test('session-context trims a trailing newline from the session id before writing side effects', (t) => {
    const root = tempDir(t, 'doflow-policy-records-session-newline-');
    const configHome = path.join(root, 'config');
    const input = fs.readFileSync(path.join(FIXTURE_DIR, 'session-context/newline-session.json'), 'utf8');
    const result = run('session-context', input, { configHome });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const sessions = path.join(configHome, 'doflow/session-env/sessions');
    assert.deepEqual(fs.readdirSync(sessions), ['golden-session']);
    const context = JSON.parse(fs.readFileSync(path.join(sessions, 'golden-session/git-context.json'), 'utf8'));
    assert.equal(context.cwd, '/nonexistent/doflow-golden');
    assert.equal(context.is_git_repo, false);
    assert.equal(context.branch, '');
    const log = fs.readFileSync(path.join(configHome, 'doflow/sessions.log'), 'utf8');
    assert.match(log, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ START golden-session \/nonexistent\/doflow-golden\n$/);
  });

  test('session policies keep jq-missing output and capture dependency-missing:jq', (t) => {
    const root = tempDir(t, 'doflow-policy-records-no-jq-');
    const bin = path.join(root, 'bin');
    const configHome = path.join(root, 'config');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['bash', 'cat', 'dirname', 'tr', 'sed', 'head', 'date', 'mkdir', 'pwd', 'rm', 'wc', 'grep', 'cut', 'cksum', 'mv', 'touch', 'find', 'nohup', 'git']) {
      const source = process.env.PATH.split(path.delimiter).map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
      if (source) fs.symlinkSync(source, path.join(bin, name));
    }
    for (const policy of ['stop-check', 'session-context', 'user-prompt-submit', 'subagent-audit']) {
      const input = fs.readFileSync(path.join(FIXTURE_DIR, policy, 'no-jq.input.json'), 'utf8');
      const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, policy, 'no-jq.golden.json'), 'utf8'));
      const result = run(policy, input, {
        configHome,
        env: { PATH: bin, HOME: root, DOFLOW_FAILURE_CAPTURE: 'on' },
      });
      assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, expected, policy);
    }
    const events = fs.readFileSync(path.join(configHome, 'doflow/failures/events.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(({ command, kind }) => ({ command, kind })), POLICIES.map((policy) => ({
      command: policy, kind: 'dependency-missing:jq',
    })));
  });

  test('subagent-audit records audit-write-failed when its log path cannot be appended', (t) => {
    const configHome = tempDir(t, 'doflow-policy-records-audit-failure-');
    const session = path.join(configHome, 'doflow/session-env/sessions/audit-failure');
    fs.mkdirSync(path.join(session, 'subagent-audit.log'), { recursive: true });
    const result = run('subagent-audit', JSON.stringify({
      session_id: 'audit-failure', hook_event_name: 'SubagentStart', agent_type: 'worker', agent_id: 'a1',
    }), { records: true, configHome });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRecords(result.records), [
      { v: 1, policy: 'subagent-audit', policyVersion: 1, outcome: 'allow', code: 'allow' },
      { v: 1, policy: 'subagent-audit', policyVersion: 1, outcome: 'error', code: 'audit-write-failed' },
    ]);
  });

  test('sourced policy decisions remain safe under set -euo pipefail', () => {
    const script = `set -euo pipefail; bash '${path.join(POLICY_DIR, 'session-context.sh')}' <<'JSON'\n{"session_id":""}\nJSON\n`;
    const result = spawnSync(BASH, ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
});
