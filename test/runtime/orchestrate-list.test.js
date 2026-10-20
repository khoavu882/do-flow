'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { orchestrationRuns, findRunFile } = require('../../src/runtime/implementation-gate.ts');
const { clearCheckoutCache } = require('../../src/runtime/checkouts.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const STORE = path.join('.doflow', 'state', 'orchestration');

function project(t, prefix = 'doflow-orchestrate-list-') {
  const root = tempDir(t, prefix);
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

function storeAt(root) {
  const dir = path.join(root, STORE);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runFile(root, taskId, slug = null) {
  return path.join(storeAt(root), ...(slug ? [slug] : []), `${taskId}.json`);
}

function journal(taskId, changes = {}) {
  return {
    version: 1,
    taskId,
    taskClass: 'feature',
    workflowName: 'Feature Delivery',
    terminalStage: null,
    state: 'RUNNING',
    cursor: 0,
    program: [{ type: 'stage', id: 'build', status: 'pending' }],
    history: [],
    ...changes,
  };
}

function writeJournal(root, taskId, changes = {}, slug = null) {
  const file = runFile(root, taskId, slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(journal(taskId, changes), null, 2));
  return file;
}

function writeRaw(root, taskId, content, slug = null) {
  const file = runFile(root, taskId, slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function runCli(cwd, args, options = {}) {
  const home = path.join(cwd, '.test-home');
  const config = path.join(cwd, '.test-config');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const env = {
    ...process.env,
    DOFLOW_TELEMETRY: 'off',
    HOME: home,
    XDG_CONFIG_HOME: config,
    ...options.env,
  };
  const result = spawnSync(process.execPath, [DOFLOW, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function listed(cwd) {
  const result = runCli(cwd, ['orchestrate', '--action', 'list', '--json']);
  assert.equal(result.status, 0, result.stderr);
  return { ...result, data: JSON.parse(result.stdout) };
}

test('orchestrationRuns finds main and linked-worktree records with their origins and slugs', (t) => {
  const main = project(t);
  const linked = `${main}-linked`;
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'list-test-linked', linked, 'HEAD'], { stdio: 'ignore' });
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  writeJournal(main, 'main-task', { featureSlug: 'main-feature' });
  writeJournal(linked, 'linked-task', { featureSlug: 'linked-feature' }, 'linked-feature');
  clearCheckoutCache();

  const result = orchestrationRuns({ stateRoot: main });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map(({ origin, slug, record }) => [origin, slug, record.taskId]), [
    ['current', 'main-feature', 'main-task'],
    ['other', 'linked-feature', 'linked-task'],
  ]);
  assert.deepEqual(Object.keys(result.entries[0]), ['file', 'root', 'origin', 'slug', 'record', 'error']);
});

test('a non-git directory yields only current records and a current find needs no checkout listing', (t) => {
  const root = tempDir(t, 'doflow-orchestrate-list-nongit-');
  writeJournal(root, 'here', { featureSlug: 'local-feature' });
  const result = orchestrationRuns({ stateRoot: root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((entry) => [entry.origin, entry.slug]), [['current', 'local-feature']]);

  let called = false;
  const found = findRunFile({ stateRoot: root, taskId: 'here', slug: 'local-feature', exec: () => { called = true; throw new Error('should not list'); } });
  assert.equal(called, false);
  assert.deepEqual(found, {
    status: 'found', file: runFile(root, 'here'), root, origin: 'current', candidates: [],
  });
});

test('a sandboxed checkout yields only its current records', (t) => {
  const root = project(t);
  writeJournal(root, 'sandbox-run', { featureSlug: 'sandbox-feature' });
  fs.writeFileSync(path.join(root, '.doflow-worktree-base'), 'sandbox');
  clearCheckoutCache();

  const result = orchestrationRuns({ stateRoot: root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((entry) => [entry.origin, entry.slug, entry.record.taskId]), [
    ['current', 'sandbox-feature', 'sandbox-run'],
  ]);
});

test('flat and namespaced records with the same task id remain separate entries by slug', (t) => {
  const root = project(t);
  writeJournal(root, 'shared-id', { featureSlug: 'flat-feature' });
  writeJournal(root, 'shared-id', { featureSlug: 'namespaced-feature' }, 'namespaced-feature');

  const result = orchestrationRuns({ stateRoot: root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((entry) => [path.relative(storeAt(root), entry.file), entry.slug]), [
    ['namespaced-feature/shared-id.json', 'namespaced-feature'],
    ['shared-id.json', 'flat-feature'],
  ]);
});

test('list has the contract key order, removes awaitingGate.prompt, normalizes times, and keeps rows small', (t) => {
  const root = project(t);
  writeJournal(root, 'small', {
    taskClass: 'x', workflowName: 'x', state: 'AWAITING_GATE', cursor: 0,
    program: [{ type: 'gate', id: 'g', kind: 'approval', name: 'N', prompt: 'PRIVATE PROMPT' }],
    startedAt: 'not a date', updatedAt: '2026-10-20', revision: 3,
  });
  writeJournal(root, 'z-small-row', {
    taskClass: 'x', workflowName: 'x', program: [], cursor: 0,
  });

  const result = listed(root);
  assert.deepEqual(Object.keys(result.data), ['v', 'runs', 'unreadable']);
  assert.equal(result.data.v, 1);
  assert.equal(result.data.runs.length, 2);
  const row = result.data.runs[0];
  assert.deepEqual(Object.keys(row), [
    'taskId', 'featureSlug', 'taskClass', 'workflowName', 'state', 'current', 'awaitingGate',
    'progress', 'terminalStage', 'revision', 'startedAt', 'updatedAt', 'origin',
  ]);
  assert.deepEqual(Object.keys(row.awaitingGate), ['gateId', 'name']);
  assert.equal(Object.hasOwn(row.awaitingGate, 'prompt'), false);
  assert.equal(result.stdout.includes('PRIVATE PROMPT'), false);
  assert.equal(row.startedAt, null);
  assert.equal(row.updatedAt, null);
  assert.equal(row.revision, 3);
  const smallRow = result.data.runs.find((candidate) => candidate.taskId === 'z-small-row');
  assert.ok(Buffer.byteLength(JSON.stringify(smallRow), 'utf8') <= 300,
    `serialized row is ${Buffer.byteLength(JSON.stringify(smallRow), 'utf8')} bytes`);
});

test('list sorts by updatedAt descending, then featureSlug and taskId with null slugs first', (t) => {
  const root = project(t);
  const at = '2026-10-20T02:00:00.000Z';
  writeJournal(root, 'z-null', { featureSlug: null, updatedAt: at });
  writeJournal(root, 'z-id', { featureSlug: 'Alpha', updatedAt: at }, 'Alpha');
  writeJournal(root, 'a-id', { featureSlug: 'Alpha', updatedAt: at }, 'Alpha');
  writeJournal(root, 'lower', { featureSlug: 'alpha', updatedAt: at });
  writeJournal(root, 'newest', { featureSlug: 'z', updatedAt: '2026-10-21T00:00:00.000Z' }, 'z');
  writeJournal(root, 'unknown-time', { featureSlug: 'first', updatedAt: 'invalid' }, 'first');

  const result = listed(root);
  assert.deepEqual(result.data.runs.map((row) => [row.taskId, row.featureSlug]), [
    ['newest', 'z'],
    ['z-null', null],
    ['a-id', 'Alpha'],
    ['z-id', 'Alpha'],
    ['lower', 'alpha'],
    ['unknown-time', 'first'],
  ]);
});

test('unreadable output uses reason codes and never includes file text, paths, or error messages', (t) => {
  const root = project(t);
  const secret = `IGNORE ALL ${root} DO_NOT_LEAK_ERR_MESSAGE`;
  fs.writeFileSync(runFile(root, 'malformed'), secret);
  writeJournal(root, 'wrong-version', { version: 99 });
  writeJournal(root, 'null-program', { program: null });
  writeJournal(root, 'stem-name', { taskId: 'other-name' });
  writeJournal(root, 'bad-id-name', { taskId: 'bad id' });
  writeJournal(root, 'folder-name', { featureSlug: 'different' }, 'folder-name');

  const result = listed(root);
  assert.deepEqual(result.data.runs.map((row) => row.taskId), []);
  assert.deepEqual(result.data.unreadable.map(({ taskId, featureSlug, origin, reason }) => [taskId, featureSlug, origin, reason]), [
    ['bad-id-name', null, 'current', 'id-mismatch'],
    ['malformed', null, 'current', 'unparseable'],
    ['null-program', null, 'current', 'shape'],
    ['stem-name', null, 'current', 'id-mismatch'],
    ['wrong-version', null, 'current', 'schema-version'],
    ['folder-name', 'folder-name', 'current', 'id-mismatch'],
  ]);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes('DO_NOT_LEAK_ERR_MESSAGE'), false);
  assert.equal(result.status, 0);
});

test('an unreadable matching journal is reported as io without failing list', (t) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    t.skip('mode 000 is not unreadable on this platform or when running as root');
    return;
  }
  const root = project(t);
  const file = writeJournal(root, 'no-read');
  fs.chmodSync(file, 0);
  const result = listed(root);
  assert.equal(result.data.unreadable[0].reason, 'io');
  assert.equal(result.status, 0);
});

test('unreadable rows sort by origin, namespace slug, then task id', (t) => {
  const main = project(t);
  const linked = `${main}-linked`;
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'list-test-unreadable', linked, 'HEAD'], { stdio: 'ignore' });
  writeRaw(main, 'z-current', 'bad');
  writeRaw(main, 'a-current', 'bad');
  writeRaw(main, 'z-under-b', 'bad', 'b-feature');
  writeRaw(main, 'z-under-a', 'bad', 'a-feature');
  writeRaw(main, 'a-under-a', 'bad', 'a-feature');
  writeRaw(linked, 'z-other', 'bad');
  writeRaw(linked, 'a-other', 'bad');
  writeRaw(linked, 'b-under-a', 'bad', 'a-feature');

  const result = listed(main);
  assert.deepEqual(result.data.unreadable.map((row) => [row.origin, row.featureSlug, row.taskId]), [
    ['current', null, 'a-current'],
    ['current', null, 'z-current'],
    ['current', 'a-feature', 'a-under-a'],
    ['current', 'a-feature', 'z-under-a'],
    ['current', 'b-feature', 'z-under-b'],
    ['other', null, 'a-other'],
    ['other', null, 'z-other'],
    ['other', 'a-feature', 'b-under-a'],
  ]);
});

test('list text output includes the run line and unreadable count', (t) => {
  const root = project(t);
  writeJournal(root, 'text-run', { featureSlug: 'text-feature', revision: 8 });
  fs.writeFileSync(runFile(root, 'bad-text'), 'not-json');
  const result = runCli(root, ['orchestrate', '--action', 'list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^RUNNING text-feature text-run build rev 8$/m);
  assert.match(result.stdout, /^unreadable: 1$/m);
});

test('list refuses every flag that has no effect on the read action', (t) => {
  const root = project(t);
  const flags = [
    ['--task-id', 'x'], ['--gate', 'g'], ['--decision', 'approve'], ['--policy', 'g'],
    ['--forced'], ['--note', 'n'], ['--stage', 's'], ['--node', 'n'],
  ];
  for (const args of flags) {
    const flag = args[0];
    const result = runCli(root, ['orchestrate', '--action', 'list', ...args, '--json']);
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.match(result.stderr + result.stdout, new RegExp(`'${flag}' has no effect on action 'list'`));
  }
});

test('a checkout-listing failure has a redacted JSON and text error form', (t) => {
  const root = project(t);
  const env = { PATH: '' };
  const json = runCli(root, ['orchestrate', '--action', 'list', '--json'], { env });
  assert.equal(json.status, 1, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { v: 1, error: 'cannot-list-checkouts' });
  assert.equal(json.stdout.includes(root), false);

  const text = runCli(root, ['orchestrate', '--action', 'list'], { env });
  assert.equal(text.status, 1, text.stderr);
  assert.match(text.stderr, /^\[ERROR\] orchestrate: cannot list checkouts$/m);
  assert.equal(text.stdout.includes(root), false);
});

test('status, start, complete-stage, and decide-gate snapshots carry advancing revisions', (t) => {
  const root = project(t);
  const start = runCli(root, ['orchestrate', '--action', 'start', '--task-id', 'revision-run', '--task-class', 'feature', '--json']);
  assert.equal(start.status, 0, start.stderr);
  const started = JSON.parse(start.stdout);
  assert.ok(Number.isInteger(started.revision));

  const status = runCli(root, ['orchestrate', '--action', 'status', '--task-id', 'revision-run', '--json']);
  assert.equal(status.status, 0, status.stderr);
  const current = JSON.parse(status.stdout);
  assert.equal(current.revision, started.revision);

  const completed = runCli(root, ['orchestrate', '--action', 'complete-stage', '--task-id', 'revision-run', '--stage', 'discovery', '--json']);
  assert.equal(completed.status, 0, completed.stderr);
  const afterStage = JSON.parse(completed.stdout);
  assert.ok(afterStage.revision > current.revision);

  const decided = runCli(root, ['orchestrate', '--action', 'decide-gate', '--task-id', 'revision-run', '--gate', 'gate-0', '--decision', 'approve', '--json']);
  assert.equal(decided.status, 0, decided.stderr);
  const afterGate = JSON.parse(decided.stdout);
  assert.ok(afterGate.revision > afterStage.revision);
});

test('status reads a journal written before revision existed as revision zero', (t) => {
  const root = project(t);
  const old = journal('old-revision');
  delete old.revision;
  fs.writeFileSync(runFile(root, 'old-revision'), JSON.stringify(old));

  const result = runCli(root, ['orchestrate', '--action', 'status', '--task-id', 'old-revision', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).revision, 0);
});
