'use strict';

// Feature 081 C.1 (IC-021, IC-020 end state; DEC-005, DEC-038, DEC-040, DEC-046, DEC-047, DEC-050):
// the cancel sequence in src/runtime/worker/cancel.ts.
//
// Each case hand-seeds a run record in a run store and a real 080 ledger with an active subagent
// attempt (080 start, then claim --epoch 1 --exec-worktree <a second worktree>, RK13). Every
// identity is an explicit environment object, so the developer's shell never decides a run key or
// a refusal. Real-process cases spawn the fake harness CLI linked into a scratch bin/, with a child
// PATH of that bin/ plus the node directory and the five DOFLOW_* variables deleted (NFR-002); they
// skip on win32 (DEC-008) and run on the ubuntu-latest and macos-latest lanes (DEC-050).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp.js');
const { linkBin, writeScenario, IDENTITY_VARS } = require('../helper/fake-harness-cli.js');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { cancelRun, mergeCleanup } = require(path.join(SRC, 'worker', 'cancel.ts'));
const { storeFileFor, newRunId, insertRun, readRuns } = require(path.join(SRC, 'worker', 'run-store.ts'));
const tree = require(path.join(SRC, 'worker', 'process-tree.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const { runKeyFor } = require(path.join(SRC, 'task-run.ts'));

const SLUG = 'feat-c';
const REAL = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (DEC-008)' };
const PLAN = ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', '',
  '- [ ] A.2 second task; owner: core-implementer; files: b.js', ''].join('\n');

function identityEnv(worktree, { run = 'r1', lineage = 'main', role = 'main' } = {}) {
  const env = { HOME: worktree, DOFLOW_RUN_ID: run, DOFLOW_SESSION_ROLE: role, DOFLOW_ROLE: role, DOFLOW_WORKTREE: worktree };
  if (lineage != null) env.DOFLOW_LINEAGE_ID = lineage;
  return env;
}

/** A project with plan.md, a started 080 run and an active subagent attempt on A.1. */
function project(t) {
  const dir = tempDir(t, 'doflow-worker-cancel-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  const execWorktree = tempDir(t, 'doflow-worker-cancel-wt-');
  fs.mkdirSync(path.join(execWorktree, '.git'));
  const env = identityEnv(dir);
  const key = runKeyFor(env, dir);
  const ledger = attempts.storeFile(dir, SLUG);
  const common = { file: ledger, fsImpl: fs, roots: [dir], slug: SLUG, env, cwd: dir };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  const claimed = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree });
  assert.equal(claimed.disposition, 'claimed');
  const store = storeFileFor(dir, SLUG);
  const attempt = () => JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks['A.1'].attempts.find((a) => a.token === claimed.token);
  /** Inserts a run on the claim; `fields` overlay the record. */
  const seed = (fields = {}) => {
    const runId = newRunId();
    const record = {
      runId, task: 'A.1', token: claimed.token, harness: 'claude', phase: 'running', execWorktree,
      createdAt: new Date().toISOString(),
      caller: { cwd: dir, runKey: key.runKey, run: key.identity.run, lineage: key.identity.lineage, attempt: null, role: 'main', lineageKind: key.identity.lineageKind },
      ...fields,
    };
    assert.equal(insertRun(store, record).applied, true);
    return runId;
  };
  const cancel = (runId, extra = {}) => cancelRun({ file: store, runId, by: 'main', reason: 'stop now', env, cwd: dir, ...extra });
  return { dir, env, key, ledger, store, token: claimed.token, execWorktree, attempt, seed, cancel, run: (id) => readRuns(store)[id] };
}

/** Starts the fake CLI as a worker in its own group with `steps` as its run scenario. Resolves once
 * `ready` exists under its cwd, with the recorded process and the pids the scenario wrote. */
async function startWorker(t, steps, pidFiles = []) {
  const dir = tempDir(t, 'doflow-worker-cancel-bin-');
  const PATH = linkBin(path.join(dir, 'bin'), ['fake-claude']);
  const env = { PATH, FAKE_HARNESS_SCENARIO: writeScenario(dir, { run: [...steps, { write: { path: 'ready', content: '1' } }, { sleep: 30000 }] }) };
  for (const name of IDENTITY_VARS) delete env[name];
  const child = spawn(path.join(dir, 'bin', 'fake-claude'), ['run'], { cwd: dir, env, detached: true, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ended */ }
    for (const file of pidFiles) {
      try { process.kill(Number(fs.readFileSync(path.join(dir, file), 'utf8')), 'SIGKILL'); } catch { /* ended */ }
    }
  });
  const until = Date.now() + 10000;
  while (!fs.existsSync(path.join(dir, 'ready'))) {
    assert.ok(Date.now() < until, 'the fake worker became ready');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pids = pidFiles.map((file) => Number(fs.readFileSync(path.join(dir, file), 'utf8')));
  const proc = { pid: child.pid, pgid: child.pid, start: tree.procStart(child.pid) };
  return { proc, pids, exited };
}

const recordedPid = (pid) => ({ pid, pgid: pid, start: tree.procStart(pid) });

/** Spies standing in for the escalation and the 080 cancel, to prove nothing was signalled. */
function spies() {
  const calls = { escalate: 0, cancel: 0 };
  return {
    calls,
    escalate: async () => { calls.escalate += 1; return { status: 'verified', reason: null, survivors: [], zombies: [] }; },
    cancelImpl: () => { calls.cancel += 1; return { disposition: 'cancelled' }; },
  };
}

// ── The sequence on real trees ─────────────────────────────────────────────────────────────────

test('a worker with grandchildren ends verified and the 080 attempt is cancelled with the reason', REAL, async (t) => {
  const p = project(t);
  const w = await startWorker(t, [{ spawnChild: { pidFile: 'child.pid' } }, { spawnChild: { newGroup: true, pidFile: 'other.pid' } }], ['child.pid', 'other.pid']);
  const grandchildren = w.pids.map(recordedPid);
  assert.ok(grandchildren.every((g) => tree.alive(g) === true), 'grandchildren run before the cancel');
  const runId = p.seed({ worker: w.proc, startedAt: new Date().toISOString() });

  const answer = await p.cancel(runId);
  assert.equal(answer.disposition, 'cancelled');
  assert.equal(answer.endState, 'cancelled');
  assert.equal(answer.cleanup.status, 'verified');
  assert.deepEqual(answer.cleanup.survivors, []);
  assert.deepEqual(answer.attemptCancel, { disposition: 'cancelled', reason: null });
  assert.equal(answer.attemptCancelled, true);
  assert.equal(tree.alive(w.proc), false);
  for (const g of grandchildren) assert.equal(tree.alive(g), false, `grandchild ${g.pid} ended`);
  assert.equal((await w.exited).signal, 'SIGTERM');

  const attempt = p.attempt();
  assert.equal(attempt.state, 'cancelled');
  assert.equal(attempt.cancel.reason, 'stop now');
  const run = p.run(runId);
  assert.equal(run.phase, 'ended');
  assert.equal(run.end.state, 'cancelled');
  assert.equal(run.cancel.source, 'user');
  assert.deepEqual(run.attemptCancel, { disposition: 'cancelled', reason: null });
});

test('a worker that ignores SIGTERM ends by SIGKILL after the grace', REAL, async (t) => {
  const p = project(t);
  const w = await startWorker(t, [{ ignoreTerm: true }]);
  const runId = p.seed({ worker: w.proc });
  const started = Date.now();
  const answer = await p.cancel(runId);
  assert.ok(Date.now() - started >= tree.KILL_GRACE_MS, 'SIGKILL comes after the grace');
  assert.equal(answer.cleanup.status, 'verified');
  assert.equal((await w.exited).signal, 'SIGKILL');
  assert.equal(p.run(runId).end.state, 'cancelled');
});

test("a 080 plan-malformed throw is stored, the tree is ended first and the end is still written", REAL, async (t) => {
  const p = project(t);
  const w = await startWorker(t, [{ spawnChild: { pidFile: 'child.pid' } }], ['child.pid']);
  const grandchild = recordedPid(w.pids[0]);
  const runId = p.seed({ worker: w.proc });
  fs.writeFileSync(path.join(p.dir, 'agent-docs', 'doflow', SLUG, 'plan.md'), '# Plan\n');
  const seenAtCancel = [];
  const cancelImpl = (args) => {
    seenAtCancel.push(tree.alive(w.proc), tree.alive(grandchild));
    return attempts.cancel(args);
  };

  const answer = await p.cancel(runId, { cancelImpl });
  assert.deepEqual(seenAtCancel, [false, false], 'the tree is gone before 080 cancel runs');
  assert.deepEqual(answer.attemptCancel, { disposition: 'error', reason: 'plan-malformed' });
  assert.equal(answer.attemptCancelled, false);
  assert.equal(answer.cleanup.status, 'verified');
  const run = p.run(runId);
  assert.equal(run.phase, 'ended');
  assert.equal(run.end.state, 'cancelled');
  assert.deepEqual(run.attemptCancel, { disposition: 'error', reason: 'plan-malformed' });
  assert.equal(p.attempt().state, 'active', '080 did not cancel the attempt');
});

test("source 'timeout' ends timed-out", REAL, async (t) => {
  const p = project(t);
  const w = await startWorker(t, []);
  const runId = p.seed({ worker: w.proc });
  const answer = await p.cancel(runId, { by: 'doflow-worker', reason: 'timeout after 1s', source: 'timeout' });
  assert.equal(answer.endState, 'timed-out');
  const run = p.run(runId);
  assert.equal(run.end.state, 'timed-out');
  assert.equal(run.cancel.source, 'timeout');
  assert.equal(p.attempt().cancel.reason, 'timeout after 1s');
});

test("injected platform 'win32' signals the worker pid only and ends unknown", REAL, async (t) => {
  const p = project(t);
  const w = await startWorker(t, []);
  const runId = p.seed({ worker: w.proc });
  const answer = await p.cancel(runId, { platform: 'win32' });
  assert.deepEqual(answer.cleanup, { status: 'unknown', reason: 'win32', survivors: [], zombies: [] });
  assert.equal((await w.exited).signal, 'SIGTERM');
  assert.equal(p.run(runId).end.state, 'cancelled');
});

test('a launching run whose supervisor still runs: its tree is ended and the verdict stays unknown', REAL, async (t) => {
  const p = project(t);
  const supervisor = await startWorker(t, [{ spawnChild: { pidFile: 'child.pid' } }], ['child.pid']);
  const spawned = recordedPid(supervisor.pids[0]);
  const runId = p.seed({ phase: 'starting', launchingAt: new Date().toISOString(), supervisor: supervisor.proc });
  const answer = await p.cancel(runId);
  assert.equal(answer.cleanup.status, 'unknown');
  assert.equal(answer.cleanup.reason, 'worker-unrecorded');
  assert.equal(tree.alive(supervisor.proc), false);
  assert.equal(tree.alive(spawned), false);
  assert.equal(p.attempt().state, 'cancelled');
});

// ── Starting runs, refusals and records (no real tree) ────────────────────────────────────────

test('a starting run with no launchingAt is verified with no signal', async (t) => {
  const p = project(t);
  const s = spies();
  const runId = p.seed({ phase: 'starting' });
  const answer = await p.cancel(runId, { escalate: s.escalate });
  assert.equal(s.calls.escalate, 0);
  assert.equal(answer.cleanup.status, 'verified');
  assert.equal(answer.attemptCancelled, true);
  assert.equal(p.run(runId).end.state, 'cancelled');
});

test('a starting run with launchingAt and no worker is unknown worker-unrecorded, never verified', async (t) => {
  const p = project(t);
  const s = spies();
  // A supervisor that has gone: this process's pid with another start reads not alive.
  const gone = { pid: process.pid, pgid: process.pid, start: 'Mon Jan  1 00:00:00 2001' };
  const runId = p.seed({ phase: 'starting', launchingAt: new Date().toISOString(), supervisor: gone });
  const answer = await p.cancel(runId, { escalate: s.escalate });
  assert.equal(s.calls.escalate, 0, 'a gone supervisor is not signalled');
  assert.deepEqual(answer.cleanup, { status: 'unknown', reason: 'worker-unrecorded', survivors: [], zombies: [] });
  assert.deepEqual(p.run(runId).cleanup, answer.cleanup);
});

test('a recorded supervisorCleanup resolves the starting verdict at the end', async (t) => {
  const p = project(t);
  const runId = p.seed({
    phase: 'starting', launchingAt: new Date().toISOString(),
    supervisorCleanup: { at: new Date().toISOString(), worker: { pid: 1, pgid: 1, start: null }, survivors: [], zombies: [] },
  });
  const answer = await p.cancel(runId, { escalate: spies().escalate });
  assert.equal(answer.cleanup.status, 'verified');
  assert.deepEqual(mergeCleanup({ status: 'verified', reason: null, survivors: [], zombies: [] }, { survivors: [7], zombies: [] }).survivors, [7]);
  assert.equal(mergeCleanup({ status: 'verified', reason: null, survivors: [], zombies: [] }, { survivors: [7], zombies: [] }).status, 'survivors');
});

test('a foreign run key, a solo lineage and a worker role are refused with nothing signalled or written', async (t) => {
  const p = project(t);
  const s = spies();
  const foreign = p.seed({ caller: { runKey: 'deadbeef/r9/main' } });
  const ledgerBefore = fs.readFileSync(p.ledger);
  const storeBefore = fs.readFileSync(p.store);
  const cases = [
    [foreign, p.env, 'foreign-run'],
    [foreign, identityEnv(p.dir, { lineage: 'not a lineage!' }), 'identity-solo'],
    [foreign, identityEnv(p.dir, { lineage: 'l1', role: 'worker' }), 'worker-session'],
    ['w-000000000000', p.env, 'unknown-run'],
  ];
  for (const [runId, env, reason] of cases) {
    const answer = await p.cancel(runId, { env, escalate: s.escalate, cancelImpl: s.cancelImpl });
    assert.equal(answer.disposition, 'refused', reason);
    assert.equal(answer.reason, reason);
  }
  assert.deepEqual(s.calls, { escalate: 0, cancel: 0 });
  assert.deepEqual(fs.readFileSync(p.store), storeBefore, 'the run store is unchanged');
  assert.deepEqual(fs.readFileSync(p.ledger), ledgerBefore, 'the ledger is unchanged');
});

test('an ended run is refused, a fresh cancel is in progress and a stale one is taken over', async (t) => {
  const p = project(t);
  const s = spies();
  const ended = p.seed({ phase: 'ended', end: { state: 'exited', at: new Date().toISOString() } });
  assert.deepEqual(await p.cancel(ended, { escalate: s.escalate }), { disposition: 'refused', reason: 'run-ended', runId: ended, endState: 'exited' });

  const otherToken = attempts.claim({
    file: p.ledger, fsImpl: fs, roots: [p.dir], slug: SLUG, env: p.env, cwd: p.dir,
    task: 'A.2', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree: p.execWorktree,
  }).token;
  const requestedAt = new Date().toISOString();
  const busy = p.seed({ task: 'A.2', token: otherToken, phase: 'cancelling', cancel: { requestedAt, by: 'other', reason: 'x', source: 'user' } });
  const answer = await p.cancel(busy, { escalate: s.escalate });
  assert.equal(answer.reason, 'cancel-in-progress');
  assert.equal(s.calls.escalate, 0);

  const later = new Date(Date.parse(requestedAt) + 31000);
  const taken = await p.cancel(busy, { escalate: s.escalate, now: () => later });
  assert.equal(taken.disposition, 'cancelled');
  assert.equal(p.run(busy).cancel.by, 'main');
});

test('a 080 refusal is recorded, not raised, and attemptCancelled is false', async (t) => {
  const p = project(t);
  attempts.cancel({ file: p.ledger, fsImpl: fs, roots: [p.dir], slug: SLUG, task: 'A.1', token: p.token, by: 'main', reason: 'earlier', env: p.env, cwd: p.dir });
  const runId = p.seed({ phase: 'starting' });
  const answer = await p.cancel(runId, { escalate: spies().escalate });
  assert.deepEqual(answer.attemptCancel, { disposition: 'refused', reason: 'no-active-attempt' });
  assert.equal(answer.attemptCancelled, false);
  assert.equal(p.run(runId).phase, 'ended');
});
