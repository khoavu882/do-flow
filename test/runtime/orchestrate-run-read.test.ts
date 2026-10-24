'use strict';
// orchestrate-run-read.test.js — every run-file read goes through the one safe reader (FU-16c2wz,
// maint-runtime-b C-2): no link followed on the way to the file or at it, a regular file of bounded
// size, never a blocking open. The ownership probe that runs before `status` reads a run, `verify`'s
// readiness read and the other-checkout probe are the reads that used a plain `readFileSync`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const GATE = path.join(REPO, 'src', 'runtime', 'implementation-gate.ts');
const posix = process.platform !== 'win32';

function project(t: any) {
  const real = tempDir(t, 'doflow-run-read-');
  fs.writeFileSync(path.join(real, 'a.js'), 'module.exports = { x: 1 };\n');
  const git = (...args: any[]) => execFileSync('git', ['-C', real, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('branch', '-M', 'main');
  return real;
}

const storeOf = (root: any) => path.join(root, '.doflow', 'state', 'orchestration');

/** A run record as the store holds one, on an open gated stage. */
function runRecord(taskId: any, featureSlug: any) {
  return {
    version: 1, taskId, taskClass: 'bug', workflowName: 'bug', state: 'RUNNING', featureSlug, cursor: 0, revision: 1,
    program: [{ type: 'stage', id: 'implementation', status: 'pending', mutatesSource: true, readinessTemplate: 'bug' }],
  };
}

/** Runs `source` (a CommonJS snippet) in a child with a time limit, so a read that blocks fails the test. */
function within(source: any, args: any, timeout: any = 15000) {
  const res = spawnSync(process.execPath, ['-e', source, ...args], { encoding: 'utf8', timeout, killSignal: 'SIGKILL', env: { ...process.env, GATE } });
  return { status: res.status, error: res.error, stdout: res.stdout, stderr: res.stderr };
}

test('C-2: a flat FIFO run file fails fast when --slug is given, naming the file', { skip: !posix }, (t) => {
  const cwd = project(t);
  fs.mkdirSync(storeOf(cwd), { recursive: true });
  const fifo = path.join(storeOf(cwd), 'ZZ.json');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const res = spawnSync(process.execPath, [DOFLOW, 'orchestrate', '--action', 'status', '--task-id', 'ZZ', '--slug', 'feat-a'], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
  });
  assert.equal(res.error, undefined, 'status did not return in time');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[ERROR\] orchestrate: .*not a regular file/);
  assert.ok(res.stderr.includes(fifo), res.stderr);
});

test('C-2: a flat run file that links elsewhere is refused with --slug, not read through the link', { skip: !posix }, (t) => {
  const cwd = project(t);
  fs.mkdirSync(storeOf(cwd), { recursive: true });
  const outside = path.join(cwd, 'outside-run.json');
  fs.writeFileSync(outside, JSON.stringify(runRecord('L2', 'feat-a')));
  fs.symlinkSync(outside, path.join(storeOf(cwd), 'L2.json'));
  const res = spawnSync(process.execPath, [DOFLOW, 'orchestrate', '--action', 'status', '--task-id', 'L2', '--slug', 'feat-a'], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
  });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, /not a regular file/);
  assert.equal(res.stdout, '');
});

const VERIFY = `
  const { verifyReadinessCheck } = require(process.env.GATE);
  try { console.log(JSON.stringify(verifyReadinessCheck({ stateRoot: process.argv[1], taskId: 'ZZ', slug: null }))); }
  catch (error) { console.log(JSON.stringify({ threw: error.code })); }
`;

test('C-2: verify refuses a linked run file instead of reading its target', { skip: !posix }, (t) => {
  const cwd = project(t);
  fs.mkdirSync(storeOf(cwd), { recursive: true });
  const outside = path.join(cwd, 'outside-run.json');
  fs.writeFileSync(outside, JSON.stringify(runRecord('ZZ', null)));
  fs.symlinkSync(outside, path.join(storeOf(cwd), 'ZZ.json'));
  const res = within(VERIFY, [cwd]);
  assert.equal(res.error, undefined, 'verify did not return in time');
  assert.deepEqual(JSON.parse(res.stdout), { threw: 'store-unreadable' });
});

test('C-2: verify refuses a run in a linked namespace folder', { skip: !posix }, (t) => {
  const cwd = project(t);
  const outside = path.join(cwd, 'outside-ns');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'ZZ.json'), JSON.stringify(runRecord('ZZ', 'feat-a')));
  fs.mkdirSync(storeOf(cwd), { recursive: true });
  fs.symlinkSync(outside, path.join(storeOf(cwd), 'feat-a'));
  const res = within(`
    const { verifyReadinessCheck } = require(process.env.GATE);
    try { console.log(JSON.stringify(verifyReadinessCheck({ stateRoot: process.argv[1], taskId: 'ZZ', slug: 'feat-a' }))); }
    catch (error) { console.log(JSON.stringify({ threw: error.code })); }
  `, [cwd]);
  assert.equal(res.error, undefined);
  assert.deepEqual(JSON.parse(res.stdout), { threw: 'store-unreadable' });
});

test('C-2 control: verify does not block on a FIFO run file; the listing never names it, so no run applies', { skip: !posix }, (t) => {
  const cwd = project(t);
  fs.mkdirSync(storeOf(cwd), { recursive: true });
  assert.equal(spawnSync('mkfifo', [path.join(storeOf(cwd), 'ZZ.json')]).status, 0);
  const res = within(VERIFY, [cwd]);
  assert.equal(res.error, undefined, 'verify did not return in time');
  assert.deepEqual(JSON.parse(res.stdout), { applies: false, reason: 'no-run' });
});

test('C-2: verify still reads an ordinary run', (t) => {
  const cwd = project(t);
  fs.mkdirSync(storeOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(storeOf(cwd), 'ZZ.json'), JSON.stringify(runRecord('ZZ', null)));
  const res = within(VERIFY, [cwd]);
  const out = JSON.parse(res.stdout);
  assert.equal(out.applies, true, res.stdout + res.stderr);
  assert.equal(out.runTaskId, 'ZZ');
});

/** The main checkout and a linked worktree of it; the state root of the checks is the worktree. */
function mainAndWorktree(t: any) {
  const main = project(t);
  const wt = `${main}-wt`;
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feat/c2', wt], { stdio: 'ignore' });
  return { main, wt };
}

test('C-2: a linked run file in another checkout is not read or matched', { skip: !posix }, (t) => {
  const { main, wt } = mainAndWorktree(t);
  const ns = path.join(storeOf(main), 'feat-a');
  fs.mkdirSync(ns, { recursive: true });
  const outside = path.join(main, 'outside-run.json');
  fs.writeFileSync(outside, JSON.stringify(runRecord('ZZ', 'feat-a')));
  fs.symlinkSync(outside, path.join(ns, 'ZZ.json'));
  const { findRunFile } = require(GATE);
  const found = findRunFile({ stateRoot: fs.realpathSync(wt), taskId: 'ZZ', slug: 'feat-a' });
  assert.equal(found.status, 'missing', JSON.stringify(found));
});

test('C-2: a run in a linked namespace folder of another checkout is not read or matched', { skip: !posix }, (t) => {
  const { main, wt } = mainAndWorktree(t);
  const outside = path.join(main, 'outside-ns');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'ZZ.json'), JSON.stringify(runRecord('ZZ', 'feat-a')));
  fs.mkdirSync(storeOf(main), { recursive: true });
  fs.symlinkSync(outside, path.join(storeOf(main), 'feat-a'));
  const { findRunFile } = require(GATE);
  const found = findRunFile({ stateRoot: fs.realpathSync(wt), taskId: 'ZZ', slug: 'feat-a' });
  assert.equal(found.status, 'missing', JSON.stringify(found));
});

test('C-2: a FIFO run file in another checkout does not block the lookup', { skip: !posix }, (t) => {
  const { main, wt } = mainAndWorktree(t);
  const ns = path.join(storeOf(main), 'feat-a');
  fs.mkdirSync(ns, { recursive: true });
  assert.equal(spawnSync('mkfifo', [path.join(ns, 'ZZ.json')]).status, 0);
  const res = within(`
    const { findRunFile } = require(process.env.GATE);
    console.log(JSON.stringify(findRunFile({ stateRoot: process.argv[1], taskId: 'ZZ', slug: 'feat-a' })));
  `, [fs.realpathSync(wt)]);
  assert.equal(res.error, undefined, 'the lookup did not return in time');
  assert.equal(JSON.parse(res.stdout).status, 'missing');
});

test('C-2: an ordinary run in another checkout is still found for its feature', (t) => {
  const { main, wt } = mainAndWorktree(t);
  const ns = path.join(storeOf(main), 'feat-a');
  fs.mkdirSync(ns, { recursive: true });
  fs.writeFileSync(path.join(ns, 'ZZ.json'), JSON.stringify(runRecord('ZZ', 'feat-a')));
  const { findRunFile } = require(GATE);
  const found = findRunFile({ stateRoot: fs.realpathSync(wt), taskId: 'ZZ', slug: 'feat-a' });
  assert.equal(found.status, 'found');
  assert.equal(found.origin, 'other');
});
