'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { encodeEnvelope, parseRecords, runPolicy } = require('../helper/hook-fixtures.ts');

const POLICY = 'pre-bash-guard';
// The worker worktree exemption takes only a POSIX /-rooted DOFLOW_WORKTREE (policies/pre-bash-guard.sh:143,
// `case ${DOFLOW_WORKTREE:-} in /*)`), so a Windows drive path never earns it; dispatch workers are POSIX-only.
const SKIP: any = process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005); worker worktree exemption requires a POSIX /-rooted DOFLOW_WORKTREE (policies/pre-bash-guard.sh:143)';
const POLICY_PATH = process.env.DOFLOW_PRE_BASH_GUARD_TEST_POLICY;
const UNSET = Symbol('unset');
const RECORD_KEYS: any = ['code', 'outcome', 'policy', 'policyVersion', 'v'];
const WORKER_HARNESSES: any = [
  ['claude', 'PreToolUse'],
  ['codex', 'PreToolUse'],
  ['kiro', 'PreToolUse'],
  ['pi', 'tool_call'],
];
const ALLOWED_COMMANDS: any = [
  'git reset --hard',
  'git reset -q --hard HEAD~1',
  'git clean -fd',
  'git clean -fdx',
];

function nativePayload(harness: any, command: any, cwd: any) {
  const location = cwd === undefined ? {} : { cwd };
  if (harness === 'pi') return { ...location, toolName: 'bash', input: { command } };
  if (harness === 'antigravity') {
    return { toolCall: { name: 'run_command', args: { CommandLine: command } } };
  }
  return { ...location, tool_name: 'Bash', tool_input: { command } };
}

function policyRun({ harness = 'claude', event = 'PreToolUse', command, cwd, role = 'worker', worktree, extraEnv = {} }: any) {
  const native = nativePayload(harness, command, cwd);
  const input = encodeEnvelope(harness, event, POLICY, JSON.stringify(native), {
    DOFLOW_TELEMETRY: 'off',
    DOFLOW_SESSION_ROLE: role === UNSET ? '' : role,
  });

  const envOverrides: any = {
    DOFLOW_TELEMETRY: 'off',
    ...extraEnv,
  };
  if (role !== UNSET) envOverrides.DOFLOW_SESSION_ROLE = role;
  if (worktree !== undefined) envOverrides.DOFLOW_WORKTREE = worktree;

  const controlled: any = [
    'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE', 'DOFLOW_TELEMETRY',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0',
    ...Object.keys(process.env).filter((key) => key.startsWith('GIT_CONFIG_KEY_')),
  ];
  return runPolicy(POLICY, input, {
    cwd: path.resolve(__dirname, '../..'),
    decisionFd: true,
    env: { ...Object.fromEntries(controlled.map((key: any) => [key, undefined])), ...envOverrides },
    ...(POLICY_PATH ? { policyPath: POLICY_PATH } : {}),
  });
}

function assertDenied(result: any, command: any) {
  assert.equal(result.status, 2, `${command}\n${result.stderr}`);
  const records = parseRecords(result.records);
  assert.equal(records.at(-1)?.outcome, 'deny', `${command}: decision record`);
}

function makeWorktree(root: any, suffix: any = 'd-0123456789ab', collision: any = false) {
  const worktree = path.join(root, '.doflow', 'state', 'dispatch-worktrees', suffix);
  if (suffix === 'd-0123456789ab') {
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=hook-test', '-c', 'user.email=hook@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture');
    if (collision) git(root, 'worktree', 'add', '-q', '--detach', path.join(root, 'other', suffix));
    git(root, 'worktree', 'add', '-q', '--detach', worktree);
  } else fs.mkdirSync(worktree, { recursive: true });
  return worktree;
}

// These git writes build scratch fixtures only. Commands under review are never executed.
function git(cwd: any, ...args: any[]) {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('only an exact dispatch worker may reset or clean from its worktree', { skip: SKIP }, async (t) => {
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

  const denied = (name: any, options: any) => t.test(name, () => {
    const result = policyRun({ worktree, command: 'git reset --hard', cwd: worktree, ...options });
    assertDenied(result, options.command || 'git reset --hard');
  });

  for (const [name, role] of [['main', 'main'], ['unset', UNSET], ['intruder', 'intruder'], ['Worker', 'Worker']] as [string, any][]) {
    await denied(`role ${String(name)} does not grant the exemption`, { role });
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

  const commandDenials: any = [
    ['git -C /elsewhere reset --hard', 'git -C /elsewhere reset --hard'],
    ['cd /x && git reset --hard', 'cd /x && git reset --hard'],
    ['worker role in command text', 'DOFLOW_SESSION_ROLE=worker git reset --hard', 'worker'],
    ['worker role in command text during a main session', 'DOFLOW_SESSION_ROLE=worker git reset --hard', 'main'],
    ['env wrapper', 'env X=1 git reset --hard'],
    ['double force clean', 'git clean -ffd'],
    ['compound reset and delete', 'git reset --hard; rm -rf x'],
    ['multi-line reset', 'git reset --hard\nprintf safe'],
    ['clean newline then command', 'git clean -fd\nx'],
    ['clean two newlines', 'git clean -fd\n\n'],
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

test('one trailing LF or CRLF is allowed, with no second command', { skip: SKIP }, (t) => {
  const root = tempDir(t, 'doflow-worker-newline-');
  const worktree = makeWorktree(root);
  for (const ending of ['\n', '\r\n']) {
    const result = policyRun({ command: `git clean -fd${ending}`, cwd: worktree, worktree });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseRecords(result.records).at(-1)?.code, 'worker-worktree');
    assertDenied(policyRun({ command: `git clean -fd${ending}x`, cwd: worktree, worktree }), 'second line');
  }
});

test('git exemptions verify the real repository and leave the parent HEAD/index untouched', { skip: SKIP }, (t) => {
  const root = tempDir(t, 'doflow-worker-repository-');
  const worktree = makeWorktree(root);
  const x = path.join(worktree, 'x');
  const sub = path.join(worktree, 'sub');
  const nested = path.join(worktree, 'sub2');
  for (const dir of [x, sub, nested]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'staged'), 'parent index sentinel\n');
  git(root, 'add', 'staged');
  const head = git(root, 'rev-parse', 'HEAD');
  const index = fs.readFileSync(path.join(root, '.git/index'));
  const checkParent = () => {
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index);
  };
  const denyBoth = (cwd: any, extraEnv: any = {}) => {
    for (const command of ['git reset --hard', 'git clean -fd']) {
      assertDenied(policyRun({ command, cwd, worktree, extraEnv }), command);
      checkParent(); // Mutation control: only the hook runs, never reset/clean in P.
    }
  };
  for (const cwd of [worktree, x]) for (const command of ['git reset --hard', 'git clean -fd']) {
    const result = policyRun({ command, cwd, worktree });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseRecords(result.records).at(-1)?.code, 'worker-worktree');
  }
  fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${path.join(root, '.git')}\n`);
  denyBoth(sub);
  git(nested, 'init', '-q');
  git(nested, 'config', 'core.worktree', root);
  denyBoth(nested);
  // Correct top level alone is insufficient: the private gitdir must also match.
  git(nested, 'config', 'core.worktree', worktree);
  denyBoth(nested);
  const wrongSuffix = path.join(worktree, 'wrong-suffix');
  fs.mkdirSync(wrongSuffix);
  git(wrongSuffix, 'init', '-q', '--separate-git-dir', path.join(root, '.git/worktrees/d-0123456789abbad'));
  git(wrongSuffix, 'config', 'core.worktree', worktree);
  denyBoth(wrongSuffix);
  for (const extraEnv of [
    { GIT_CONFIG_PARAMETERS: `'core.worktree'='${root}'` },
    { GIT_CONFIG_PARAMETERS: '' },
    { GIT_CONFIG_COUNT: '0' },
    { GIT_CONFIG_KEY_0: 'core.worktree' },
    { GIT_CONFIG_KEY_42: '' },
  ]) denyBoth(worktree, extraEnv);
  // An inherited config file must not redirect the rev-parse probe itself.
  const injectedConfig = path.join(root, 'injected-config');
  fs.writeFileSync(injectedConfig, `[core]\nworktree = ${root}\n`);
  assert.equal(policyRun({ command: 'git clean -fd', cwd: worktree, worktree,
    extraEnv: { GIT_CONFIG_GLOBAL: injectedConfig } }).status, 0);
  git(root, 'config', 'extensions.worktreeConfig', 'true');
  git(worktree, 'config', '--worktree', 'core.worktree', root);
  denyBoth(worktree);
  git(worktree, 'config', '--worktree', '--unset', 'core.worktree');
  // Non-zero rev-parse must fail closed even though the dispatch directory exists.
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: /nonexistent/doflow-worker-gitdir\n');
  denyBoth(sub);
});

test('a real worktree gitdir may have a numeric collision suffix', { skip: SKIP }, (t) => {
  const root = tempDir(t, 'doflow-worker-gitdir-collision-');
  const worktree = makeWorktree(root, 'd-0123456789ab', true);
  assert.match(git(worktree, 'rev-parse', '--git-dir').trim(), /\/d-0123456789ab[0-9]+$/);
  for (const command of ['git reset --hard', 'git clean -fd']) {
    const result = policyRun({ command, cwd: worktree, worktree });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseRecords(result.records).at(-1)?.code, 'worker-worktree');
  }
});

test('decision records retain the v1 contract shape', { skip: SKIP }, (t) => {
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
