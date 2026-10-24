'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { orchestrationRuns, findRunFile } = require('../../src/runtime/implementation-gate.ts');
const { clearCheckoutCache } = require('../../src/runtime/checkouts.ts');
const { handleOrchestrateCommand } = require('../../src/runtime/workflow-orchestrator.ts');

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

// NFR-007: the shape, order, reason and selection cases call the handler in-process; the CLI
// tests below keep the dispatcher wiring (text form, flag parsing, linked-worktree reads) honest.
function orchestrate(stateRoot, options = {}) {
  const out = [];
  const err = [];
  const { log, error } = console;
  const exitCode = process.exitCode;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.error = (...args) => { err.push(args.join(' ')); };
  let status;
  try {
    clearCheckoutCache();
    status = handleOrchestrateCommand({ stateRoot, ...options });
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
  const stdout = out.length ? `${out.join('\n')}\n` : '';
  return { status, stdout, stderr: err.join('\n') };
}

function listed(cwd, options = {}) {
  const result = orchestrate(cwd, { action: 'list', json: true, ...options });
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
});

test('IC-001 size: a real feature run held at its first gate is one row of at most 768 B pretty-printed, prompt-free', (t) => {
  const root = project(t);
  // The real program and terminal stage a feature run compiles, not a synthetic row.
  const started = orchestrate(root, { action: 'start', taskId: 'size-run', taskClass: 'feature', json: true });
  assert.equal(started.status, 0, started.stderr);
  const gated = orchestrate(root, { action: 'complete-stage', taskId: 'size-run', stage: 'discovery', json: true });
  assert.equal(gated.status, 0, gated.stderr);
  const snapshot = JSON.parse(gated.stdout);
  assert.equal(snapshot.state, 'AWAITING_GATE');
  assert.ok(snapshot.terminalStage && Array.isArray(snapshot.terminalStage.gatesAfter) && snapshot.terminalStage.gatesAfter.length > 0,
    'the fixture must carry the terminal stage gates status prints, or the bound is vacuous');

  const result = listed(root);
  const row = result.data.runs.find((candidate) => candidate.taskId === 'size-run');
  assert.ok(row.awaitingGate, 'the measured row must be a gated row');
  assert.deepEqual(row.terminalStage, {
    id: snapshot.terminalStage.id, skill: snapshot.terminalStage.skill, kind: snapshot.terminalStage.kind,
  });
  const pretty = Buffer.byteLength(JSON.stringify(row, null, 2), 'utf8');
  assert.ok(pretty <= 768, `pretty-printed gated row is ${pretty} bytes`);
  const prompts = [snapshot.awaitingGate.prompt, ...snapshot.terminalStage.gatesAfter.map((gate) => gate.prompt)].filter(Boolean);
  assert.ok(prompts.length > 0);
  for (const prompt of prompts) assert.equal(result.stdout.includes(prompt), false, 'a gate prompt reached list output');
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
  writeJournal(root, 'flag-run');
  // Every flag another orchestrate action reads, by the handler option the dispatcher fills.
  const flags = [
    ['--task-id', { taskId: 'x' }], ['--task-class', { taskClass: 'bug' }], ['--gate', { gate: 'g' }],
    ['--decision', { decision: 'approve' }], ['--policy', { policy: 'g' }], ['--forced', { forced: true }],
    ['--note', { note: 'n' }], ['--reason', { reason: 'r' }], ['--stage', { stage: 's' }], ['--node', { node: 'n' }],
    ['--verification-plan', { verificationPlan: 'v' }], ['--scope', { scope: 'x' }], ['--invariants', { invariants: 'i' }],
    ['--result', { result: 'passed' }], ['--mcp-outcome', { mcpOutcome: ['context7=used'] }],
    ['--calling-skill', { callingSkill: 'do-test' }], ['--slug', { slug: 'feat-a' }], ['--dry-run', { dryRun: true }],
  ];
  for (const [flag, options] of flags) {
    const result = orchestrate(root, { action: 'list', json: true, ...options });
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.match(result.stderr + result.stdout, new RegExp(`'${flag}' has no effect on action 'list'`));
    assert.equal(result.stdout.includes('flag-run'), false, `${flag}: list printed rows before refusing`);
  }
  // The dispatcher passes the parsed flags through: the real CLI refuses the ones the review found accepted.
  for (const args of [['--mcp-outcome', 'context7=used'], ['--slug', 'feat-a'], ['--dry-run']]) {
    const result = runCli(root, ['orchestrate', '--action', 'list', ...args, '--json']);
    assert.equal(result.status, 2, `${args[0]}: ${result.stderr}`);
    assert.match(result.stderr + result.stdout, new RegExp(`'${args[0]}' has no effect on action 'list'`));
  }
});

test('C-2: a shadowed flat copy is not a second run: one row, the copy status reads', (t) => {
  const root = project(t);
  // The upgrade path: a pre-115 flat journal of feature feat-a, then a write seeded the namespaced copy.
  writeJournal(root, 'run-x', { featureSlug: 'feat-a', revision: 1, updatedAt: '2026-10-20T03:00:00.000Z' });
  writeJournal(root, 'run-x', { featureSlug: 'feat-a', revision: 2, state: 'AWAITING_GATE', updatedAt: '2026-10-20T02:00:00.000Z' }, 'feat-a');
  // A flat journal that names no feature is any feature's: feat-b reads its namespaced copy, every
  // other feature still reads the flat one, so both are runs (S-1, the re-review's a4 shape).
  writeJournal(root, 'run-y', { revision: 1 });
  writeJournal(root, 'run-y', { featureSlug: 'feat-b', revision: 4 }, 'feat-b');
  // A flat journal of another feature is a different run and stays.
  writeJournal(root, 'run-z', { featureSlug: 'feat-c', revision: 1 });
  writeJournal(root, 'run-z', { featureSlug: 'feat-d', revision: 5 }, 'feat-d');

  const rows = listed(root).data.runs.map((row) => [row.featureSlug, row.taskId, row.revision]);
  assert.deepEqual(rows.filter(([, id]) => id === 'run-x'), [['feat-a', 'run-x', 2]]);
  assert.deepEqual(rows.filter(([, id]) => id === 'run-y'), [[null, 'run-y', 1], ['feat-b', 'run-y', 4]]);
  assert.deepEqual(rows.filter(([, id]) => id === 'run-z').sort(), [['feat-c', 'run-z', 1], ['feat-d', 'run-z', 5]]);
  for (const [slug, taskId, revision] of [['feat-a', 'run-x', 2], ['feat-b', 'run-y', 4], ['feat-zz', 'run-y', 1]]) {
    const status = orchestrate(root, { action: 'status', taskId, slug, recordSlug: slug, json: true });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).revision, revision, `${slug}/${taskId}: list and status disagree`);
  }
});

test('C-2: another checkout\'s copy of a run held here is not a second row', (t) => {
  const main = project(t);
  const linked = `${main}-linked`;
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'list-test-shadow', linked, 'HEAD'], { stdio: 'ignore' });
  writeJournal(main, 'run-a', { featureSlug: 'feat-a', revision: 2 }, 'feat-a');
  // An unswept older copy left in the linked worktree, newer by time so order cannot hide it.
  writeJournal(linked, 'run-a', { featureSlug: 'feat-a', revision: 1, updatedAt: '2099-01-01T00:00:00.000Z' }, 'feat-a');
  writeJournal(linked, 'run-only-there', { featureSlug: 'feat-a', revision: 3 }, 'feat-a');

  const rows = listed(main).data.runs.map((row) => [row.taskId, row.origin, row.revision]);
  assert.deepEqual(rows.filter(([id]) => id === 'run-a'), [['run-a', 'current', 2]]);
  assert.deepEqual(rows.filter(([id]) => id === 'run-only-there'), [['run-only-there', 'other', 3]]);
  const status = orchestrate(main, { action: 'status', taskId: 'run-a', slug: 'feat-a', recordSlug: 'feat-a', json: true });
  assert.equal(JSON.parse(status.stdout).revision, 2);
});

test('S-1: a current flat copy status would read first shadows every other checkout\'s copy', (t) => {
  const main = project(t);
  const linked = `${main}-linked`;
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'list-test-s1', linked, 'HEAD'], { stdio: 'ignore' });
  const at = '2099-01-01T00:00:00.000Z';
  // h: a current flat journal that names no feature, and a namespaced copy left in the worktree.
  writeJournal(main, 'run-h', { revision: 1 });
  writeJournal(linked, 'run-h', { featureSlug: 'feat-a', revision: 2, updatedAt: at }, 'feat-a');
  // e3: the id is the slug, the current flat copy is corrupt, the worktree holds a stale flat copy.
  writeRaw(main, 'feat-e', '{ corrupt');
  writeJournal(linked, 'feat-e', { featureSlug: 'feat-e', revision: 1, updatedAt: at });
  // f: the current flat copy is a link (status follows it), the worktree holds a namespaced copy.
  const target = path.join(tempDir(t, 'doflow-orchestrate-list-s1-'), 'run-f.json');
  fs.writeFileSync(target, JSON.stringify(journal('run-f', { featureSlug: 'feat-a', revision: 5 })));
  if (process.platform !== 'win32') fs.symlinkSync(target, runFile(main, 'run-f'));
  writeJournal(linked, 'run-f', { featureSlug: 'feat-a', revision: 1, updatedAt: at }, 'feat-a');
  // A corrupt current flat copy of another feature's id is not read for feat-a: the worktree copy stays.
  writeRaw(main, 'run-k', '{ corrupt');
  writeJournal(linked, 'run-k', { featureSlug: 'feat-a', revision: 3 }, 'feat-a');

  const result = listed(main).data;
  const rows = result.runs.map((row) => [row.featureSlug, row.taskId, row.origin, row.revision]);
  const unreadable = result.unreadable.map((row) => [row.taskId, row.origin, row.reason]);
  assert.deepEqual(rows.filter(([, id]) => id === 'run-h'), [[null, 'run-h', 'current', 1]]);
  assert.deepEqual(rows.filter(([, id]) => id === 'feat-e'), []);
  assert.deepEqual(unreadable.filter(([id]) => id === 'feat-e'), [['feat-e', 'current', 'unparseable']]);
  assert.deepEqual(rows.filter(([, id]) => id === 'run-k'), [['feat-a', 'run-k', 'other', 3]]);
  if (process.platform !== 'win32') {
    assert.deepEqual(rows.filter(([, id]) => id === 'run-f'), []);
    assert.deepEqual(unreadable.filter(([id]) => id === 'run-f'), [['run-f', 'current', 'io']]);
  }
  // The copies status reads are the ones list keeps.
  for (const [taskId, slug, revision] of [['run-h', 'feat-a', 1], ['run-k', 'feat-a', 3]]) {
    const status = orchestrate(main, { action: 'status', taskId, slug, recordSlug: slug, json: true });
    assert.equal(status.status, 0, `${taskId}: ${status.stderr}`);
    assert.equal(JSON.parse(status.stdout).revision, revision, `${taskId}: list and status disagree`);
  }
  // A linked flat copy is still the one status stops at, and (FU-16c2wz) it refuses it as list reports it.
  if (process.platform !== 'win32') {
    const status = orchestrate(main, { action: 'status', taskId: 'run-f', slug: 'feat-a', recordSlug: 'feat-a', json: true });
    assert.equal(status.status, 1, status.stdout);
    assert.match(status.stderr, /not a regular file/);
  }
});

test('N2: a run file over 1 MiB is reported as io without being read whole', (t) => {
  const root = project(t);
  writeJournal(root, 'small');
  const huge = runFile(root, 'huge');
  const fd = fs.openSync(huge, 'w');
  fs.ftruncateSync(fd, 64 * 1024 * 1024); // sparse: no disk cost
  fs.closeSync(fd);
  const result = listed(root).data;
  assert.deepEqual(result.runs.map((row) => row.taskId), ['small']);
  assert.deepEqual(result.unreadable.map(({ taskId, reason }) => [taskId, reason]), [['huge', 'io']]);
});

test('C-3: list never follows a link out of the store and never blocks on a FIFO', (t) => {
  if (process.platform === 'win32') { t.skip('symbolic links and FIFOs need POSIX'); return; }
  const root = project(t);
  const outside = tempDir(t, 'doflow-orchestrate-list-outside-');
  writeJournal(root, 'plain');
  const outsideJournal = path.join(outside, 'leak.json');
  fs.writeFileSync(outsideJournal, JSON.stringify(journal('leak', { workflowName: 'OUTSIDE_FILE_CONTENT' })));
  fs.mkdirSync(path.join(outside, 'ns'));
  fs.writeFileSync(path.join(outside, 'ns', 'nested.json'), JSON.stringify(journal('nested', { featureSlug: 'ns', workflowName: 'OUTSIDE_FILE_CONTENT' })));
  fs.symlinkSync(outsideJournal, runFile(root, 'leak'));
  fs.symlinkSync(runFile(root, 'plain'), runFile(root, 'inside-link'));
  fs.symlinkSync(path.join(outside, 'ns'), path.join(storeAt(root), 'ns'));
  execFileSync('mkfifo', [path.join(outside, 'pipe')]);
  fs.symlinkSync(path.join(outside, 'pipe'), runFile(root, 'fifo-link'));
  execFileSync('mkfifo', [runFile(root, 'fifo')]);

  const started = Date.now();
  const result = listed(root);
  assert.ok(Date.now() - started < 5000, 'list blocked on a FIFO');
  assert.deepEqual(result.data.runs.map((row) => row.taskId), ['plain']);
  assert.deepEqual(result.data.unreadable.map(({ taskId, featureSlug, reason }) => [taskId, featureSlug, reason]), [
    ['fifo-link', null, 'io'], ['inside-link', null, 'io'], ['leak', null, 'io'],
  ]);
  // A FIFO in the store itself is neither a file nor a link: the listing skips it without opening it.
  assert.equal(result.stdout.includes('OUTSIDE_FILE_CONTENT'), false);
  assert.equal(result.stdout.includes('nested'), false, 'a linked namespace directory was entered');
});

test('C-9: an id that fails ID_PATTERN never reaches the output as a row', (t) => {
  const root = project(t);
  writeJournal(root, 'inj', {
    featureSlug: '../../etc\nAWAITING_GATE forged-slug forged-task gate-b rev 99\u001b[31m',
  });
  writeJournal(root, 'inj-stage', {
    program: [{ type: 'stage', id: 'build\nRUNNING fake fake - rev 7\u001b[0m', status: 'pending' }],
  });
  writeJournal(root, 'fine', { featureSlug: 'feat-a' });
  const json = listed(root);
  assert.deepEqual(json.data.runs.map((row) => row.taskId), ['fine']);
  assert.deepEqual(json.data.unreadable.map(({ taskId, featureSlug, reason }) => [taskId, featureSlug, reason]), [
    ['inj', null, 'id-mismatch'], ['inj-stage', null, 'shape'],
  ]);
  const text = orchestrate(root, { action: 'list' });
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(text.stdout.trimEnd().split('\n'), ['RUNNING feat-a fine build rev 0', 'unreadable: 2']);
  assert.equal(/\u001b/.test(text.stdout + json.stdout.replace(/\\u001b/g, '')), false);
});

test('C-1: list and status from a linked worktree read the main store and move nothing, switch on or off', (t) => {
  const main = project(t);
  const linked = `${main}-linked`;
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'list-test-nosweep', linked, 'HEAD'], { stdio: 'ignore' });
  writeJournal(main, 'run-a', { featureSlug: 'feat-a', revision: 2 }, 'feat-a');
  // A record left in the worktree's own store (unswept), and a differing copy that a sweep refuses on.
  const left = writeJournal(linked, 'run-c', { featureSlug: 'feat-b', revision: 1 }, 'feat-b');
  const differing = writeJournal(linked, 'run-a', { featureSlug: 'feat-a', revision: 1, updatedAt: '2020-01-01T00:00:00.000Z' }, 'feat-a');
  const snap = () => [main, linked].map((root) => {
    const entries = [];
    const visit = (dir) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name);
        const info = fs.lstatSync(file, { bigint: true });
        entries.push(`${path.relative(root, file)} ${info.mtimeNs} ${info.ino} ${info.isFile() ? fs.readFileSync(file, 'utf8').length : 'd'}`);
        if (info.isDirectory()) visit(file);
      }
    };
    visit(path.join(root, '.doflow'));
    return entries;
  });
  // With the switch unset, after-verb upkeep may still write when due (IC-001): settle it once from
  // the main checkout and push the marker out, so any change left can only come from a sweep.
  assert.equal(runCli(main, ['orchestrate', '--action', 'list', '--json']).status, 0);
  fs.writeFileSync(path.join(main, '.doflow', 'state', 'upkeep-due'), `${Math.floor(Date.now() / 1000) + 365 * 86400}\n`);
  for (const env of [{ DOFLOW_UPKEEP: 'off' }, {}]) {
    for (const args of [['--action', 'list'], ['--action', 'status', '--task-id', 'run-c', '--slug', 'feat-b']]) {
      const before = snap();
      const result = runCli(linked, ['orchestrate', ...args, '--json'], { env: { DOFLOW_UPKEEP: undefined, ...env } });
      const label = `${args.join(' ')} ${JSON.stringify(env)}`;
      assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
      assert.deepEqual(snap(), before, `${label} changed a store`);
      assert.equal(result.stdout.includes(main), false, `${label} printed an absolute path`);
      if (args[1] === 'list') {
        const rows = JSON.parse(result.stdout).runs.map((row) => [row.taskId, row.origin, row.revision]);
        assert.deepEqual(rows.filter(([id]) => id === 'run-a'), [['run-a', 'current', 2]]);
        assert.deepEqual(rows.filter(([id]) => id === 'run-c'), [['run-c', 'other', 1]]);
      } else {
        assert.equal(JSON.parse(result.stdout).revision, 1);
      }
    }
  }
  assert.ok(fs.existsSync(left) && fs.existsSync(differing));
  assert.equal(fs.existsSync(runFile(main, 'run-c', 'feat-b')), false);
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
