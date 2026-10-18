'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { encodeEnvelope, parseRecords, runPolicy } = require('../helper/hook-fixtures');

const POLICY = 'pre-bash-guard';
const POLICY_PATH = process.env.DOFLOW_PRE_BASH_GUARD_TEST_POLICY;
const UNSET = Symbol('unset');
const RECORD_KEYS = ['code', 'outcome', 'policy', 'policyVersion', 'v'];
const WORKER_HARNESSES = [
  ['claude', 'PreToolUse'],
  ['codex', 'PreToolUse'],
  ['gemini', 'BeforeTool'],
  ['kiro', 'PreToolUse'],
  ['pi', 'tool_call'],
];
const ALLOWED_COMMANDS = [
  'git reset --hard',
  'git reset -q --hard HEAD~1',
  'git clean -fd',
  'git clean -fdx',
];

function nativePayload(harness, command, cwd) {
  const location = cwd === undefined ? {} : { cwd };
  if (harness === 'pi') return { ...location, toolName: 'bash', input: { command } };
  if (harness === 'antigravity') {
    return { toolCall: { name: 'run_command', args: { CommandLine: command } } };
  }
  const toolName = harness === 'gemini' ? 'run_shell_command' : 'Bash';
  return { ...location, tool_name: toolName, tool_input: { command } };
}

function policyRun({ harness = 'claude', event = 'PreToolUse', command, cwd, role = 'worker', worktree, extraEnv = {} }) {
  const native = nativePayload(harness, command, cwd);
  const input = encodeEnvelope(harness, event, POLICY, JSON.stringify(native), {
    DOFLOW_TELEMETRY: 'off',
    DOFLOW_SESSION_ROLE: role === UNSET ? '' : role,
  });

  const envOverrides = {
    DOFLOW_TELEMETRY: 'off',
    ...extraEnv,
  };
  if (role !== UNSET) envOverrides.DOFLOW_SESSION_ROLE = role;
  if (worktree !== undefined) envOverrides.DOFLOW_WORKTREE = worktree;

  const controlled = [
    'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE', 'DOFLOW_TELEMETRY',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  ];
  const saved = new Map(controlled.map((key) => [key, process.env[key]]));
  try {
    for (const key of controlled) {
      if (Object.prototype.hasOwnProperty.call(envOverrides, key)) process.env[key] = envOverrides[key];
      else delete process.env[key];
    }
    return runPolicy(POLICY, input, {
      cwd: path.resolve(__dirname, '../..'),
      decisionFd: true,
      ...(POLICY_PATH ? { policyPath: POLICY_PATH } : {}),
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertDenied(result, command) {
  assert.equal(result.status, 2, `${command}\n${result.stderr}`);
  const records = parseRecords(result.records);
  assert.equal(records.at(-1)?.outcome, 'deny', `${command}: decision record`);
}

function makeWorktree(root, suffix = 'd-0123456789ab') {
  const worktree = path.join(root, '.doflow', 'state', 'dispatch-worktrees', suffix);
  fs.mkdirSync(worktree, { recursive: true });
  return worktree;
}

test('only an exact dispatch worker may reset or clean from its worktree', async (t) => {
  const root = tempDir(t, 'doflow-pre-bash-worker-');
  const worktree = makeWorktree(root);
  const subdir = path.join(worktree, 'src');
  fs.mkdirSync(subdir);

  for (const [harness, event] of WORKER_HARNESSES) {
    for (const [where, cwd] of [['worktree root', worktree], ['subdirectory', subdir]]) {
      for (const command of ALLOWED_COMMANDS) {
        await t.test(`${harness} worker ${where}: ${command}`, () => {
          const result = policyRun({ harness, event, command, cwd, worktree });
          assert.equal(result.status, 0, `${result.stderr}`);
          const records = parseRecords(result.records);
          assert.equal(records.at(-1)?.code, 'worker-worktree');
          assert.equal(records.at(-1)?.outcome, 'allow');
        });
      }
    }
  }

  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const outsideLink = path.join(worktree, 'outside-link');
  fs.symlinkSync(outside, outsideLink, 'dir');
  const wrongPrefix = makeWorktree(root, 'p-x');
  const childWorktree = makeWorktree(root, 'd-0123456789ab.c1');
  const nonDispatch = path.join(root, '.doflow', 'state', 'dispatch-worktrees', 'd-abcdefabcdef');
  const missingWorktree = path.join(root, '.doflow', 'state', 'dispatch-worktrees', 'd-111111111111');

  const denied = (name, options) => t.test(name, () => {
    const result = policyRun({ worktree, command: 'git reset --hard', cwd: worktree, ...options });
    assertDenied(result, options.command || 'git reset --hard');
  });

  for (const [name, role] of [['main', 'main'], ['unset', UNSET], ['intruder', 'intruder'], ['Worker', 'Worker']]) {
    await denied(`role ${name} does not grant the exemption`, { role });
  }

  for (const [name, invalidWorktree] of [
    ['p-x worktree', wrongPrefix],
    ['dispatch child worktree', childWorktree],
    ['/tmp/x worktree', '/tmp/x'],
    ['relative worktree', '.doflow/state/dispatch-worktrees/d-0123456789ab'],
    ['missing worktree path', missingWorktree],
    ['unset worktree', undefined],
    ['non-dispatch worktree id', nonDispatch],
  ]) {
    await denied(`${name} does not grant the exemption`, { worktree: invalidWorktree });
  }

  await denied('cwd outside the worktree does not grant the exemption', { cwd: outside });
  await denied('missing native cwd does not grant the exemption', { cwd: undefined });
  await denied('empty native cwd does not grant the exemption', { cwd: '' });
  await denied('symlinked cwd resolving outside does not grant the exemption', { cwd: outsideLink });
  await denied('GIT_DIR does not grant the exemption', { extraEnv: { GIT_DIR: path.join(worktree, '.git') } });
  await t.test('antigravity has no native cwd and does not get the exemption', () => {
    const result = policyRun({ harness: 'antigravity', command: 'git reset --hard', role: 'worker', worktree });
    assertDenied(result, 'git reset --hard');
  });

  const commandDenials = [
    ['git -C /elsewhere reset --hard', 'git -C /elsewhere reset --hard'],
    ['cd /x && git reset --hard', 'cd /x && git reset --hard'],
    ['worker role in command text', 'DOFLOW_SESSION_ROLE=worker git reset --hard', 'worker'],
    ['worker role in command text during a main session', 'DOFLOW_SESSION_ROLE=worker git reset --hard', 'main'],
    ['env wrapper', 'env X=1 git reset --hard'],
    ['double force clean', 'git clean -ffd'],
    ['compound reset and delete', 'git reset --hard; rm -rf x'],
    ['multi-line reset', 'git reset --hard\nprintf safe'],
    ['worker force push', 'git push --force'],
    ['worker root delete', 'rm -rf /'],
    ['worker SQL drop table', "psql -c 'DROP TABLE t'"],
  ];
  for (const [name, command, role = 'worker'] of commandDenials) {
    await t.test(`${name} stays denied`, () => {
      const result = policyRun({ command, cwd: worktree, role, worktree });
      assertDenied(result, command);
    });
  }
});

test('decision records retain the v1 contract shape', (t) => {
  const root = tempDir(t, 'doflow-pre-bash-worker-record-');
  const worktree = makeWorktree(root);
  const result = policyRun({ command: 'git reset --hard', cwd: worktree, worktree });
  const records = parseRecords(result.records);
  assert.ok(records.length > 0);
  for (const record of records) assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS);
  assert.deepEqual(records.at(-1), {
    v: 1,
    policy: POLICY,
    policyVersion: 1,
    outcome: 'allow',
    code: 'worker-worktree',
  });
});
