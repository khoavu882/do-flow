'use strict';

// 112: only the launch snapshot can authorise one exact DROP DATABASE invocation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { runPolicy, encodeEnvelope, parseRecords } = require('../helper/hook-fixtures.ts');

function world(t: any) {
  const root = tempDir(t, 'doflow-dropdb-');
  const worktree = path.join(root, '.doflow/state/dispatch-worktrees/d-0123456789ab');
  const sub = path.join(worktree, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const env = { DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: worktree, DOFLOW_GUARD_DROP_DATABASES: 'app_test other_test',
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined,
    GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG_COUNT: undefined,
    ...Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith('GIT_CONFIG_KEY_')).map((key) => [key, undefined])) };
  function run(command: any, overrides = {}, cwd = worktree, harness = 'claude') {
    const native = { cwd, tool_name: 'Bash', tool_input: { command } };
    const input = encodeEnvelope(harness, 'PreToolUse', 'pre-bash-guard', JSON.stringify(native));
    return runPolicy('pre-bash-guard', input, { decisionFd: true, env: { ...env, ...overrides } });
  }
  return { root, worktree, sub, run };
}

const ALLOW = [
  "psql -c 'DROP DATABASE IF EXISTS app_test'",
  'mysql -e "DROP DATABASE app_test"',
  "psql -h localhost -p 5432 -U tester -d postgres -w -c 'dRoP dAtAbAsE app_test;'",
  'psql --host=localhost --port=5432 --username=tester --dbname=postgres -c "drop database if exists other_test;"',
  "psql -c 'DROP DATABASE \"app_test\"'",
  "mysql -h localhost -P 3306 -u tester -e 'DROP DATABASE IF EXISTS `app_test`;'",
  'mysql --host=localhost --port=3306 --user=tester -e "drop database other_test"',
  '\tpsql\t-c\t\' DROP DATABASE app_test; \'\t',
];
for (const command of ALLOW) test(`worker dropdb allows only a listed name: ${command}`, (t) => {
  const w = world(t);
  for (const cwd of [w.worktree, w.sub]) {
    const r = w.run(command, {}, cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parseRecords(r.records).at(-1), { v: 1, policy: 'pre-bash-guard', policyVersion: 1, outcome: 'allow', code: 'worker-dropdb' });
  }
});

const DENY = [
  "psql -c 'DROP DATABASE prod'", "psql -c 'DROP DATABASE App_test'",
  "psql -c 'DROP DATABASE app_test; DROP DATABASE prod'",
  "psql -c 'DROP DATABASE app_test' && printf done", "true; psql -c 'DROP DATABASE app_test'",
  "psql -c 'DROP DATABASE app_test' | cat", "psql -c 'DROP DATABASE app_test' &",
  "psql -c 'DROP DATABASE app_test'\nprintf done", "psql -c 'DROP DATABASE app_test\n'",
  "psql -c 'DROP TABLE app_test'", "psql -c 'DROP SCHEMA app_test'", "psql -c 'TRUNCATE TABLE app_test'",
  "psql -c 'DELETE FROM app_test;'", "psql -c 'DROP DATABASE public.app_test'",
  "psql -c 'DROP DATABASE app_*'", 'psql -c "DROP DATABASE $DB"', 'psql -c "DROP DATABASE ${DB}"',
  'psql -c "DROP DATABASE $(printf app_test)"', 'mysql -e "DROP DATABASE `app_test`"',
  "psql -c 'DROP DATABASE app_test WITH (FORCE)'", "psql -c 'DROP DATABASE app_test; \\gexec'",
  "psql -c 'DROP DATABASE app_test' -c 'select 1'", "psql -c 'DROP DATABASE app_test' > out",
  "env psql -c 'DROP DATABASE app_test'", "DB=x psql -c 'DROP DATABASE app_test'",
  "docker exec db psql -c 'DROP DATABASE app_test'", "sh -c \"psql -c 'DROP DATABASE app_test'\"",
  "psql -f x -c 'DROP DATABASE app_test'", "psql -c 'DROP DATABASE app_test' # comment",
  "psql -c 'DROP DATABASE \"app_test\"' ; true", "mysql -e 'DROP DATABASE `App_test`'",
];
for (const command of DENY) test(`worker dropdb denies syntax/name control: ${command}`, (t) => {
  const r = world(t).run(command);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(parseRecords(r.records).at(-1).outcome, 'deny');
});

test('worker dropdb fails closed on every malformed or absent launch snapshot', (t) => {
  const w = world(t);
  for (const value of [undefined, '', ' ', 'app_test BAD', 'app_test bad-name', '_app_test', 'app_test\nother_test',
    'app_test\tother_test', 'app_test\n', 'app_test  other_test', ' app_test', 'app_test ', 'app_test *',
    'app_test café']) {
    assert.equal(w.run("psql -c 'DROP DATABASE app_test'", { DOFLOW_GUARD_DROP_DATABASES: value }).status, 2, JSON.stringify(value));
  }
  assert.equal(w.run("psql -c 'DROP DATABASE db31'", { DOFLOW_GUARD_DROP_DATABASES: Array.from({ length: 32 }, (_, i) => `db${i}`).join(' ') }).status, 0);
  // Mutation control: app_test is present and all 33 names are valid; only count can deny.
  const tooMany = ['app_test', ...Array.from({ length: 32 }, (_, i) => `db${i}`)].join(' ');
  assert.equal(w.run("psql -c 'DROP DATABASE app_test'", { DOFLOW_GUARD_DROP_DATABASES: tooMany }).status, 2);
  // Mutation control: 17 valid names, 1025 bytes, including app_test; only size can deny.
  const tooLarge = ['app_test', ...Array.from({ length: 15 }, () => 'a'.repeat(63)), 'b'.repeat(56)].join(' ');
  assert.equal(tooLarge.length, 1025);
  assert.equal(w.run("psql -c 'DROP DATABASE app_test'", { DOFLOW_GUARD_DROP_DATABASES: tooLarge }).status, 2);
  assert.equal(w.run("psql -c 'DROP DATABASE app_test'", { DOFLOW_GUARD_DROP_DATABASES: tooLarge.slice(0, -1) }).status, 0);
  const max = 'a'.repeat(63);
  assert.equal(w.run(`psql -c 'DROP DATABASE ${max}'`, { DOFLOW_GUARD_DROP_DATABASES: max }).status, 0);
  // Mutation control: membership is exact for both; only the 63-byte name cap differs.
  const overlong = 'a'.repeat(64);
  assert.equal(w.run(`psql -c 'DROP DATABASE ${overlong}'`, { DOFLOW_GUARD_DROP_DATABASES: overlong }).status, 2);
});

test('dropdb shape strips exactly one terminal line ending', (t) => {
  const w = world(t);
  const command = "psql -c 'DROP DATABASE app_test'";
  for (const ending of ['\n', '\r\n']) {
    assert.equal(w.run(command + ending).status, 0);
    assert.equal(w.run(command + ending + '\n').status, 2);
    assert.equal(w.run(command + ending + 'x').status, 2);
  }
});

test('worker dropdb shares all git exemption scope conditions', (t) => {
  const w = world(t);
  const command = "psql -c 'DROP DATABASE app_test'";
  for (const role of [undefined, '', 'main', 'Worker', 'intruder']) assert.equal(w.run(command, { DOFLOW_SESSION_ROLE: role }).status, 2, String(role));
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_42']) {
    assert.equal(w.run(command, { [key]: '' }).status, 2, `${key} even when empty`);
  }
  for (const name of ['d-0123456789ab.c1', 'p-0123456789ab', 'd-0123456789ax']) {
    const dir = path.join(path.dirname(w.worktree), name);
    fs.mkdirSync(dir);
    assert.equal(w.run(command, { DOFLOW_WORKTREE: dir }, dir).status, 2, name);
  }
  for (const dir of [undefined, '', 'relative', w.root, path.join(w.root, 'missing')]) assert.equal(w.run(command, { DOFLOW_WORKTREE: dir }).status, 2, String(dir));
  for (const cwd of [undefined, '', w.root, path.join(w.root, 'missing')]) assert.equal(w.run(command, {}, cwd === undefined ? null : cwd).status, 2, String(cwd));
  const link = path.join(w.worktree, 'outside');
  fs.symlinkSync(w.root, link);
  assert.equal(w.run(command, {}, link).status, 2, 'canonical cwd escapes');
  const codex = w.run(command, {}, w.worktree, 'codex');
  assert.equal(codex.status, 0);
  assert.equal(parseRecords(codex.records).at(-1)?.code, 'worker-dropdb');
  // Mutation control: native Bash must reach the guard; an unsupported tool falsely allows both.
  assert.equal(w.run(command, { DOFLOW_GUARD_DROP_DATABASES: undefined }, w.worktree, 'codex').status, 2);
});

test('the hook reads no project or worker settings as an authorisation source', (t) => {
  const w = world(t);
  const command = "psql -c 'DROP DATABASE app_test'";
  for (const root of [w.root, w.worktree]) {
    fs.mkdirSync(path.join(root, '.doflow'), { recursive: true });
    fs.writeFileSync(path.join(root, '.doflow/settings.json'), JSON.stringify({ 'guard.workerDropDatabases': 'app_test' }));
  }
  assert.equal(w.run(command, { DOFLOW_GUARD_DROP_DATABASES: undefined }).status, 2);
  fs.writeFileSync(path.join(w.root, '.doflow/settings.json'), 'invalid JSON');
  assert.equal(w.run(command).status, 0, 'the launch snapshot is independent of later file edits');
});
