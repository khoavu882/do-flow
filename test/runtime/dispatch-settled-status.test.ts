'use strict';

// Feature 082 FX1: regression for the settled read in src/runtime/worker/command.ts settledStatus,
// used by dispatch/loop.ts collect() and dispatch/controls.ts settleOne. A run whose processes are
// gone is read again after the liveness probe, so an end that lands between the first read and the
// probe reads as ended rather than lost.
//
// The project and run helpers are copied from test/runtime/worker-command.test.js, which is frozen
// at the 081 baseline (NFR-003, test/runtime/dispatch-compat.test.js). Process cases are POSIX only
// (DEC-008).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { linkBin, writeScenario } = require('../helper/fake-harness-cli.ts');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { storeFileFor, newRunId, insertRun, readRuns, transition } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { launchEnv, launchRecord } = require(path.join(SRC, 'worker', 'launch.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const { runKeyFor } = require(path.join(SRC, 'task-run.ts'));

const SLUG = 'feat-c';
const POSIX: any = { skip: process.platform === 'win32' && 'worker process control is unverified on win32 (DEC-008)' };
const PLAN = ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', ''].join('\n');
const GIT = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'git'))
  .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });

function gitEnv() {
  const env: any = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

function gitRepo(t: any) {
  const dir = tempDir(t, 'doflow-settled-wt-');
  const git = (...args: any[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env: gitEnv(), stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.doflow', 'state', '.gitignore'), '*\n');
  return dir;
}

/** A project with an active attempt on A.1 whose execution worktree is its own git repository. */
function project(t: any) {
  const dir = fs.realpathSync(tempDir(t, 'doflow-settled-'));
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  fs.mkdirSync(path.join(dir, 'config'));
  const execWorktree = fs.realpathSync(gitRepo(t));
  const childPath = linkBin(path.join(dir, 'bin'), ['fake-claude', 'fake-gemini']);
  fs.symlinkSync(GIT, path.join(dir, 'bin', 'git'));
  const env: any = {
    PATH: childPath,
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    TMPDIR: process.env.TMPDIR || '/tmp',
    FAKE_HARNESS_SCENARIO: writeScenario(dir, {}),
    DOFLOW_RUN_ID: 'r1',
    DOFLOW_LINEAGE_ID: 'main',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_WORKTREE: dir,
  };
  const key = runKeyFor(env, dir);
  const ledger = attempts.storeFile(dir, SLUG);
  const common: any = { file: ledger, fsImpl: fs, roots: [dir], slug: SLUG, env, cwd: dir };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  const claimed = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree });
  assert.equal(claimed.disposition, 'claimed', JSON.stringify(claimed));
  const store = storeFileFor(dir, SLUG);
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, 'do the task');
  return { dir, env, key, ledger, store, token: claimed.token, execWorktree, promptFile };
}

/** A process that has exited, as `{ pid, pgid, start }`. */
function deadProc() {
  const done = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return { pid: done.pid, pgid: done.pid, start: 'Thu Jan  1 00:00:00 1970' };
}

/** Inserts a hand-built run on the project's claim, then applies `edit` by transition. */
function seedRun(p: any, edit: any) {
  const runId = newRunId();
  const descriptor = DESCRIPTORS.claude;
  const { identity } = launchEnv({ env: p.env, runKey: p.key.runKey, token: p.token, execWorktree: p.execWorktree, runId });
  const record: any = {
    runId, task: 'A.1', token: p.token, harness: 'claude', phase: 'starting', execWorktree: p.execWorktree,
    createdAt: new Date().toISOString(), timeoutSeconds: 60,
    caller: { cwd: p.dir, runKey: p.key.runKey, run: 'r1', lineage: 'main', attempt: null, role: 'main', lineageKind: p.key.identity.lineageKind },
    ...launchRecord(descriptor, identity, 'do the task'),
    descriptor,
    prompt: { path: p.promptFile, sha256: crypto.createHash('sha256').update('do the task').digest('hex'), bytes: 11 },
    needs: [],
  };
  assert.equal(insertRun(p.store, record).applied, true);
  if (edit) assert.equal(transition(p.store, runId, ['starting'], edit).applied, true);
  return runId;
}

test('settledStatus reads a run ended between its record read and the liveness probe as ended, and a run never ended as lost', POSIX, async (t) => {
  const { settledStatus } = require(path.join(SRC, 'worker', 'command.ts'));
  const ledger = (p: any) => JSON.parse(fs.readFileSync(p.ledger, 'utf8'));
  const opts: any = { platform: process.platform, nowMs: Date.now() };
  const seedLost = (p: any) => {
    const dead = deadProc();
    return seedRun(p, (run: any) => { Object.assign(run, { phase: 'running', supervisor: dead, worker: dead, deadline: new Date(Date.now() + 60000).toISOString() }); });
  };

  // The supervisor's end lands after the first read and before the probe, then the supervisor exits.
  const p = project(t);
  const runId = seedLost(p);
  let reads = 0;
  const racing = (file: any) => {
    reads += 1;
    const runs = readRuns(file);
    if (reads === 1) {
      transition(file, runId, ['running'], (r: any) => { r.end = { state: 'exited', at: new Date().toISOString() }; r.phase = 'ended'; });
    }
    return runs;
  };
  const settled = settledStatus(p.store, runId, ledger(p), opts, racing);
  assert.equal(reads, 2, 'a not-ended record whose processes are gone is read again after the probe');
  assert.deepEqual([settled.run.phase, settled.view.state, settled.view.reason], ['ended', 'exited', null]);

  // A record still not ended after the probe is lost, as before.
  const q = project(t);
  const lostId = seedLost(q);
  const lost = settledStatus(q.store, lostId, ledger(q), opts);
  assert.deepEqual([lost.run.phase, lost.view.state, lost.view.reason], ['running', 'unknown', 'process-lost']);
  assert.equal(settledStatus(q.store, 'w-000000000000', ledger(q), opts).view, null, 'a missing run has no view');
});
