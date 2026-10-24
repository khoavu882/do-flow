'use strict';

// Feature 082 C.4 (IC-029, IC-030, IC-031, IC-032; DEC-009, DEC-013, DEC-019, DEC-030, DEC-035,
// DEC-040, DEC-045, DEC-047): the controls on a dispatch run: pause and inspect, cancel, take over
// and resume with its settlement and lease rule.
//
// Each case is a sandbox repository (test/helper/dispatch-sandbox.js) with a started 080 run, an
// integration worktree made by createIntegrationWorktree and a seeded dispatch run, as in
// test/runtime/dispatch-loop-step.test.js. Fake workers run through the loop where a live process
// matters; other dispatches, worker runs and drivers are seeded through the stores' own writers.
// The child PATH is the sandbox's scratch bin/ alone (fake CLI links, node and git, never
// dirname(process.execPath), DEC-056); the five DOFLOW_* identity variables are set by the sandbox,
// with DOFLOW_ATTEMPT deleted where a worker is launched. POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');
const { tempDir } = require('../helper/tmp.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const tree = require(path.join(SRC, 'worker', 'process-tree.ts'));
const { readRuns, insertRun, newRunId, storeFileFor: runStoreFileFor } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { cancelRun } = require(path.join(SRC, 'worker', 'cancel.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createIntegrationWorktree, createAttemptWorktree, WORKTREES_DIR } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const { runVerification } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));
const controls = require(path.join(SRC, 'dispatch', 'controls.ts'));

const SLUG = '082-controls-fixture';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const SUCCESS = { type: 'result', status: 'success', summary: 'edited' };
const SLEEPER = { run: [{ sleep: 30000 }, { emit: SUCCESS }] };
const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
const DEAD_START = 'Thu Jan  1 00:00:00 2026';

function git(cwd, env, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pid that has exited: its process answers no signal. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', ''], { env: {} }).pid;
}

function kill(target, signal = 'SIGKILL') {
  try { process.kill(target, signal); } catch { /* ended */ }
}

/** Kills every recorded process of every run in the store that has not ended (test hygiene). */
function killRuns(runStore) {
  let runs = {};
  try { runs = readRuns(runStore); } catch { return; }
  for (const run of Object.values(runs)) {
    if (run.phase === 'ended') continue;
    for (const proc of [run.supervisor, run.worker]) {
      if (!proc || !Number.isInteger(proc.pid)) continue;
      if (Number.isInteger(proc.pgid)) kill(-proc.pgid);
      kill(proc.pid);
    }
  }
}

async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await sleep(50);
  }
}

/**
 * A sandbox with a started 080 run and a seeded dispatch run, as in the loop tests. `identity`
 * overrides the sandbox's DOFLOW_* values; `probe` probes the fake descriptors so a subagent is
 * eligible.
 */
async function project(t, {
  plan = 'disjoint', mode = 'sequential', concurrency = 2, scenario = {}, identity = {}, probe = false, attemptSeconds = 60, verify,
} = {}) {
  // Registered before the sandbox, so it runs before the sandbox is removed (after hooks run in
  // registration order): every run still alive is ended through 081, then killed as a backstop.
  const live = {};
  t.after(async () => {
    if (!live.runStore) return;
    for (const run of Object.values(readRuns(live.runStore))) {
      if (run.phase === 'ended') continue;
      try { await cancelRun({ file: live.runStore, runId: run.runId, by: 'test', reason: 'test cleanup', env: live.env, cwd: live.root }); } catch { /* backstop below */ }
    }
    killRuns(live.runStore);
  });
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG, scenario, identity, ...(verify ? { verify } : {}) });
  const { root } = sb;
  const env = { ...sb.env };
  const ledgerFile = attempts.storeFile(root, SLUG);
  const common = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const started = attempts.start({ ...common, by: 'main' });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  store.mutateDispatch(file, (s) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch, concurrency, mode,
      reserveTokens: null, attemptSeconds, harness: null, needs: [], spawnGrant: null, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 },
    };
    return { write: true, result: null };
  });
  const runStore = runStoreFileFor(root, SLUG);
  Object.assign(live, { runStore, env, root });
  if (probe) assert.equal((await readiness.probe({ descriptors: sb.descriptors, env, cwd: root })).disposition, 'probed');
  const read = () => store.readDispatch(file);
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const options = (extra = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors: sb.descriptors, ...extra });
  const step = (extra) => loop.step(options(extra));
  const ctl = (extra = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', reason: 'test control', ...extra });
  const states = () => Object.fromEntries(attempts.inspect(common).tasks.map((r) => [r.id, r.state]));
  const lostDriver = () => ({ pid: deadPid(), start: DEAD_START, registeredAt: new Date().toISOString(), endedAt: null });

  /** A real 080 claim on `task` with its attempt worktree, and a dispatch moved through `phases`. */
  const seedDispatch = ({ task, mode: m = 'subagent', phases = ['claimed'], claim = true, fields = {}, by = null }) => {
    const dispatchId = store.newDispatchId();
    const at = new Date().toISOString();
    const owner = by || { pid: process.pid, start: null };
    const wt = createAttemptWorktree({ root, slug: SLUG, dispatchId, base: integration.head, env });
    store.mutateDispatch(file, (s) => {
      s.dispatches[dispatchId] = {
        dispatchId, dispatchRunId, parentRunKey: started.runKey, task, token: null, epoch: null, phase: 'admitted', mode: m,
        harness: m === 'subagent' ? 'claude' : null, selection: null, grant: null, workerRunId: null, disposition: null,
        failureClass: null, attempt: wt, admittedAt: at, admittedBy: owner,
      };
      return { write: true, result: null };
    });
    let token = null;
    if (claim) {
      const claimed = attempts.claim({ ...common, task, owner: 'core-implementer', mode: m, epoch: started.epoch, execWorktree: wt.worktree });
      assert.equal(claimed.disposition, 'claimed', JSON.stringify(claimed));
      token = claimed.token;
    }
    for (const phase of phases) {
      store.mutateDispatch(file, (s) => {
        const d = s.dispatches[dispatchId];
        d.phase = phase;
        if (phase === 'claimed') Object.assign(d, { token, epoch: started.epoch, claimedAt: at, claimedBy: owner, reservation: { tokens: null } });
        if (phase === 'collected') Object.assign(d, { outcome: 'offered', collectedAt: at, commit: null, changes: [] });
        return { write: true, result: null };
      });
    }
    store.mutateDispatch(file, (s) => { Object.assign(s.dispatches[dispatchId], fields); return { write: true, result: null }; });
    return { dispatchId, token, worktree: wt.worktree };
  };
  /** A worker run record on `(task, token)` made by this caller. */
  const seedRun = (fields) => {
    const runId = newRunId();
    const key = { runKey: started.runKey };
    const record = { runId, harness: 'claude', phase: 'running', createdAt: new Date().toISOString(), childOf: null, caller: { cwd: root, runKey: key.runKey }, ...fields };
    assert.equal(insertRun(runStore, record).applied, true);
    return runId;
  };
  return {
    sb, root, env, file, ledgerFile, runStore, common, started, integration, dispatchRunId,
    read, ledger, options, step, ctl, states, lostDriver, seedDispatch, seedRun,
  };
}

// ── IC-029 ───────────────────────────────────────────────────────────────────────────────────────

test('IC-029: inspect lists both active dispatches with masked argv and writes nothing; pause starts nothing new while both are collected and verified', POSIX, async (t) => {
  const started = Date.now();
  // Both workers hold at the gate, so they are still starting or running however long the step,
  // the inspect and the pause take; the test opens the gate once it has seen both.
  const gate = path.join(tempDir(t, 'doflow-controls-gate-'), 'open');
  const p = await project(t, {
    plan: 'disjoint', mode: 'auto', concurrency: 2, probe: true, identity: { DOFLOW_ATTEMPT: undefined },
    scenario: { run: [{ waitFor: gate }, { emit: SUCCESS }] }, verify: `process.exitCode = 0; // ${SECRET}`,
  });
  const first = await p.step();
  const launched = Object.values(p.read().dispatches);
  assert.deepEqual(launched.map((d) => [d.task, d.phase, d.mode]).sort(), [['A.1', 'launched', 'subagent'], ['A.2', 'launched', 'subagent']], JSON.stringify(first.actions));

  const bytes = fs.readFileSync(p.file);
  const ledgerBytes = fs.readFileSync(p.ledgerFile);
  const view = controls.inspect(p.ctl());
  assert.deepEqual(fs.readFileSync(p.file), bytes, 'inspect leaves the dispatch store bytes unchanged');
  assert.deepEqual(fs.readFileSync(p.ledgerFile), ledgerBytes, 'inspect leaves the ledger bytes unchanged');
  assert.equal(view.disposition, 'inspected');
  assert.deepEqual([view.dispatchRunId, view.state, view.control, view.concurrency, view.mode], [p.dispatchRunId, 'running', 'running', 2, 'auto']);
  assert.equal(view.dispatches.length, 2);
  for (const d of view.dispatches) {
    assert.ok(['A.1', 'A.2'].includes(d.task));
    assert.ok(Number.isInteger(d.token) && d.token >= 1);
    assert.equal(d.phase, 'launched');
    assert.match(d.workerRun.id, /^w-[0-9a-f]{12}$/);
    assert.ok(['starting', 'running'].includes(d.workerRun.state), JSON.stringify(d.workerRun));
    assert.ok(Object.hasOwn(d, 'usage'));
    assert.equal(d.worktree.exists, true);
  }
  assert.equal(view.verification.argc, 3);
  assert.equal(view.verification.argv[1], '-e');
  assert.ok(!view.verification.argv.join(' ').includes(SECRET), 'every argv element is masked');
  assert.ok(!JSON.stringify(view).includes(SECRET), 'nothing in the view carries the secret');
  assert.deepEqual(view.tasks.map((x) => x.id), ['A.1', 'A.2', 'A.3', 'A.4']);
  const lines = controls.inspectLines(view);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^d-[0-9a-f]{12} A\.[12] token \d+ launched subagent worker w-[0-9a-f]{12} (starting|running)$/);

  const paused = await controls.pause(p.ctl({ reason: 'stop admitting' }));
  assert.equal(paused.disposition, 'paused', JSON.stringify(paused));
  assert.equal(paused.dispatchRunId, p.dispatchRunId);
  assert.equal(paused.active.length, 2);
  const again = await controls.pause(p.ctl({ reason: 'twice' }));
  assert.deepEqual([again.disposition, again.reason], ['refused', 'control-unchanged']);

  fs.writeFileSync(gate, '');
  let r = null;
  const ceiling = Date.now() + 60000;
  for (;;) {
    r = await p.step();
    assert.equal(r.disposition, 'stepped', JSON.stringify(r));
    assert.ok(!r.actions.some((a) => a.action === 'admit' && String(a.reason).startsWith('claimed')), 'nothing is admitted while paused');
    if (r.outcome === 'paused' || Date.now() >= ceiling) break;
    await sleep(150);
  }
  t.diagnostic(`pause case took ${Date.now() - started} ms`);
  assert.equal(r.outcome, 'paused', JSON.stringify(r.actions));
  const s = p.read();
  const ds = Object.values(s.dispatches);
  assert.deepEqual(ds.map((d) => d.task).sort(), ['A.1', 'A.2'], 'no dispatch for A.3 or A.4');
  for (const d of ds) {
    assert.deepEqual([d.phase, d.disposition], ['ended', 'completed'], JSON.stringify(d));
    assert.match(d.evidenceId, /\S/, 'each active dispatch was verified');
  }
  assert.ok(s.run.verifications.length >= 2);
  assert.deepEqual([p.states()['A.3'], p.states()['A.4']], ['READY', 'READY']);
});

// ── IC-031 ───────────────────────────────────────────────────────────────────────────────────────

test('IC-031: take over releases the attempt, cancels its worker, and the task is admitted next sequential without becoming CANCELLED', POSIX, async (t) => {
  const started = Date.now();
  const p = await project(t, { plan: 'budget', mode: 'auto', probe: true, scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined } });
  await p.step();
  const [d] = Object.values(p.read().dispatches);
  assert.deepEqual([d.phase, d.mode], ['launched', 'subagent']);
  await until(() => readRuns(p.runStore)[d.workerRunId].worker, 'the worker to be recorded');

  const out = await controls.takeOver(p.ctl({ task: 'A.1', reason: 'I will do it' }));
  t.diagnostic(`take over took ${Date.now() - started} ms`);
  assert.equal(out.disposition, 'taken-over', JSON.stringify(out));
  assert.deepEqual([out.dispatchId, out.task, out.token, out.released], [d.dispatchId, 'A.1', d.token, true]);
  assert.deepEqual(out.held, { task: 'A.1', mode: 'sequential' });
  assert.equal(out.workerRun.id, d.workerRunId);
  assert.equal(out.workerRun.endState, 'cancelled');
  assert.equal(out.workerRun.cleanup.status, 'verified');

  const attempt = p.ledger().tasks['A.1'].attempts.find((a) => a.token === d.token);
  assert.equal(attempt.state, 'released');
  assert.match(attempt.reason, /^takeover: I will do it/);
  const run = readRuns(p.runStore)[d.workerRunId];
  assert.deepEqual([run.phase, run.end.state], ['ended', 'cancelled']);
  assert.deepEqual(run.attemptCancel, { disposition: 'refused', reason: 'no-active-attempt' }, 'the release came first');
  assert.notEqual(p.states()['A.1'], 'CANCELLED');
  const ended = p.read().dispatches[d.dispatchId];
  assert.deepEqual([ended.phase, ended.disposition, ended.takeover.by], ['ended', 'taken-over', 'main']);
  assert.deepEqual(Object.keys(p.read().run.held), ['A.1']);

  const next = await p.step();
  assert.equal(next.outcome, 'perform', JSON.stringify(next));
  assert.deepEqual([next.perform.task, next.perform.mode, next.perform.token], ['A.1', 'sequential', d.token + 1]);
  assert.equal(Object.hasOwn(p.read().run.held, 'A.1'), false, 'the hold clears at admission');
});

test('IC-031: a claimed subagent dispatch under policy manual is taken over with no worker and admitted next manual', POSIX, async (t) => {
  const p = await project(t, { plan: 'budget', mode: 'manual' });
  const d = p.seedDispatch({ task: 'A.1', phases: ['claimed'] });
  const out = await controls.takeOver(p.ctl({ task: 'A.1' }));
  assert.equal(out.disposition, 'taken-over', JSON.stringify(out));
  assert.deepEqual([out.workerRun, out.held], [null, { task: 'A.1', mode: 'manual' }]);
  assert.equal(p.ledger().tasks['A.1'].attempts[0].state, 'released');
  const next = await p.step();
  assert.equal(next.outcome, 'perform', JSON.stringify(next));
  assert.deepEqual([next.perform.task, next.perform.mode], ['A.1', 'manual']);
  assert.equal(p.read().dispatches[d.dispatchId].disposition, 'taken-over');
});

test('IC-031: each take-over refusal of the table writes nothing', POSIX, async (t) => {
  const p = await project(t, { plan: 'disjoint', mode: 'auto', concurrency: 4 });
  p.seedDispatch({ task: 'A.1', mode: 'sequential', phases: ['claimed'] });
  const admitted = p.seedDispatch({ task: 'A.3', phases: [], claim: false });
  const collected = p.seedDispatch({ task: 'A.4', phases: ['claimed', 'launched', 'collected'] });
  const before = fs.readFileSync(p.file);
  const cases = [
    [{ env: { ...p.env, DOFLOW_LINEAGE_ID: 'solo' } }, 'identity-solo'],
    [{ env: { ...p.env, DOFLOW_SESSION_ROLE: 'worker', DOFLOW_ATTEMPT: '1' } }, 'worker-session'],
    [{ slug: '082-controls-none' }, 'no-dispatch-run'],
    [{ env: { ...p.env, DOFLOW_RUN_ID: 'aaaabbbbcccc' } }, 'foreign-run'],
    [{ task: 'Z.9' }, 'unknown-task'],
    [{ task: 'A.2' }, 'no-active-dispatch'],
    [{ task: 'A.1' }, 'already-main-session'],
    [{ task: 'A.3' }, 'not-claimed'],
    [{ task: 'A.4' }, 'integration-in-progress'],
  ];
  for (const [extra, reason] of cases) {
    const out = await controls.takeOver(p.ctl({ task: 'A.1', ...extra }));
    assert.deepEqual([out.disposition, out.reason], ['refused', reason], JSON.stringify(out));
  }
  assert.deepEqual(fs.readFileSync(p.file), before, 'no refusal wrote the store');
  store.mutateDispatch(p.file, (s) => { s.dispatches[collected.dispatchId].phase = 'integrating'; return { write: true, result: null }; });
  const integrating = await controls.takeOver(p.ctl({ task: 'A.4' }));
  assert.deepEqual([integrating.reason, integrating.phase], ['integration-in-progress', 'integrating']);
  assert.equal(p.read().dispatches[admitted.dispatchId].phase, 'admitted');
});

// ── IC-030 ───────────────────────────────────────────────────────────────────────────────────────

test('IC-030: a foreign caller is refused before any signal; cancel ends each worker tree with its grandchild, cancels each attempt and the 080 run, removes worktrees verified', POSIX, async (t) => {
  const started = Date.now();
  const p = await project(t, {
    plan: 'disjoint', mode: 'auto', concurrency: 2, probe: true, identity: { DOFLOW_ATTEMPT: undefined },
    scenario: { run: [{ spawnChild: { pidFile: 'child.pid' } }, { sleep: 30000 }, { emit: SUCCESS }] },
  });
  await p.step();
  const ds = Object.values(p.read().dispatches);
  assert.equal(ds.length, 2);
  const grandchildren = await until(() => {
    const pids = ds.map((d) => path.join(d.attempt.worktree, 'child.pid')).filter((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim());
    return pids.length === 2 ? pids.map((f) => Number(fs.readFileSync(f, 'utf8'))) : null;
  }, 'both grandchildren');
  const recorded = grandchildren.map((pid) => ({ pid, pgid: pid, start: tree.procStart(pid) }));
  t.after(() => { for (const g of recorded) kill(g.pid); });
  await until(() => ds.every((d) => readRuns(p.runStore)[d.workerRunId].worker), 'both workers recorded');

  const before = fs.readFileSync(p.file);
  const foreign = await controls.cancel(p.ctl({ env: { ...p.env, DOFLOW_RUN_ID: 'aaaabbbbcccc' } }));
  assert.deepEqual([foreign.disposition, foreign.reason], ['refused', 'foreign-run']);
  assert.deepEqual(fs.readFileSync(p.file), before, 'nothing written');
  for (const g of recorded) assert.equal(tree.alive(g), true, 'nothing signalled');
  for (const d of ds) assert.notEqual(readRuns(p.runStore)[d.workerRunId].phase, 'ended');

  const out = await controls.cancel(p.ctl({ reason: 'stop everything' }));
  t.diagnostic(`cancel case took ${Date.now() - started} ms`);
  assert.equal(out.disposition, 'cancelled', JSON.stringify(out));
  assert.equal(out.workers.length, 2, JSON.stringify(out.workers));
  for (const w of out.workers) {
    assert.deepEqual([w.endState, w.cleanup.status, w.attemptCancelled, w.refused], ['cancelled', 'verified', true, null], JSON.stringify(w));
  }
  for (const g of recorded) assert.equal(tree.alive(g), false, `grandchild ${g.pid} ended`);
  assert.equal(out.run.disposition, 'cancelled');
  assert.equal(out.integrationInProgress, null);
  assert.deepEqual(out.worktrees.kept, []);
  assert.equal(out.worktrees.removed.length, 2);
  assert.equal(out.cleanupVerified, true);

  for (const task of ['A.1', 'A.2']) assert.equal(p.ledger().tasks[task].attempts[0].state, 'cancelled');
  assert.equal(p.ledger().runs[p.started.runKey].control, 'cancelled');
  const s = p.read();
  assert.equal(s.run.state, 'cancelled');
  for (const d of Object.values(s.dispatches)) {
    assert.deepEqual([d.phase, d.disposition, d.removal.verified], ['ended', 'cancelled', true]);
    assert.equal(fs.existsSync(d.attempt.worktree), false);
  }
  const twice = await controls.cancel(p.ctl());
  assert.deepEqual([twice.disposition, twice.reason], ['refused', 'run-ended']);
});

test('IC-030: a worker in the starting gap reads cleanup unknown, keeps its worktree and cleanupVerified false', POSIX, async (t) => {
  const p = await project(t, { plan: 'budget', mode: 'auto' });
  const d = p.seedDispatch({ task: 'A.1', phases: ['claimed', 'launched'] });
  const dead = deadPid();
  const runId = p.seedRun({ task: 'A.1', token: d.token, phase: 'starting', launchingAt: new Date().toISOString(), supervisor: { pid: dead, pgid: dead, start: DEAD_START } });
  store.mutateDispatch(p.file, (s) => { s.dispatches[d.dispatchId].workerRunId = runId; return { write: true, result: null }; });
  const out = await controls.cancel(p.ctl());
  assert.equal(out.disposition, 'cancelled', JSON.stringify(out));
  assert.deepEqual(out.workers.map((w) => [w.workerRunId, w.cleanup.status, w.cleanup.reason]), [[runId, 'unknown', 'worker-unrecorded']]);
  assert.deepEqual(out.worktrees.kept, [{ path: d.worktree, reason: 'worker-cleanup-unverified' }]);
  assert.equal(out.cleanupVerified, false, 'an unknown cleanup is never assumed verified');
  assert.equal(fs.existsSync(d.worktree), true);
  assert.equal(p.ledger().tasks['A.1'].attempts[0].state, 'cancelled');
});

// RR-4 (IC-030 step 7, RT-3): a worker a launch started after step 4 read the run store, whose
// record write the cancel mark refused, is ended by step 7's second net. The injected `now` seam
// inserts that worker run (its supervisor gone, as in the starting gap) on its first reading after
// the cancel mark is on disk, which is step 5's 080 context, after step 4's read; the order is fixed.
test('RR-4: cancel step 7 ends a worker run started after step 4 read the run store', POSIX, async (t) => {
  const p = await project(t, { plan: 'budget', mode: 'auto' });
  const d = p.seedDispatch({ task: 'A.1', phases: ['claimed'] });
  let late = null;
  const now = () => {
    if (!late && p.read().run.state === 'cancelling') {
      const dead = deadPid();
      late = p.seedRun({ task: 'A.1', token: d.token, phase: 'starting', launchingAt: new Date().toISOString(), supervisor: { pid: dead, pgid: dead, start: DEAD_START } });
    }
    return new Date();
  };
  const out = await controls.cancel(p.ctl({ now }));
  assert.equal(out.disposition, 'cancelled', JSON.stringify(out));
  assert.ok(late, 'the late worker run was started');
  assert.ok(out.workers.some((w) => w.workerRunId === late), `the late worker is cancelled: ${JSON.stringify(out.workers)}`);
  assert.equal(readRuns(p.runStore)[late].phase, 'ended', 'no worker run is left live');
  assert.equal(p.read().dispatches[d.dispatchId].phase, 'ended');
});

// ── IC-032 ───────────────────────────────────────────────────────────────────────────────────────

test('IC-032: a killed loop with one live and one lost worker admits nothing before the acknowledged resume, leaves the live run and cancels the lost one before its retry', POSIX, async (t) => {
  const started = Date.now();
  const p = await project(t, { plan: 'disjoint', mode: 'auto', concurrency: 2, probe: true, scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined } });
  await p.step();
  const byTask = () => Object.fromEntries(Object.values(p.read().dispatches).map((d) => [d.task, d]));
  const { 'A.1': live, 'A.2': lost } = byTask();
  await until(() => [live, lost].every((d) => readRuns(p.runStore)[d.workerRunId].worker), 'both workers recorded');
  // The lost worker: its supervisor and worker group die with no end recorded.
  const lostRun = readRuns(p.runStore)[lost.workerRunId];
  kill(lostRun.supervisor.pid);
  kill(-lostRun.worker.pgid);
  await until(() => tree.alive(lostRun.supervisor) === false && tree.alive(lostRun.worker) === false, 'the lost run to die');
  // The killed loop: a driver whose process is gone.
  store.mutateDispatch(p.file, (s) => { s.drivers.push(p.lostDriver()); return { write: true, result: null }; });

  const blocked = await p.step();
  assert.equal(blocked.outcome, 'resume-required', JSON.stringify(blocked));
  assert.equal(p.read().run.resumeReason, 'driver-lost');
  assert.equal(Object.keys(p.read().dispatches).length, 2, 'nothing admitted');

  const first = await controls.resume(p.ctl({ reason: undefined }));
  assert.equal(first.disposition, 'ack-required', JSON.stringify(first));
  assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
  const row = (id) => first.settled.find((x) => x.dispatchId === id);
  assert.deepEqual([row(lost.dispatchId).action, row(lost.dispatchId).reason], ['cancelled', 'lost']);
  assert.deepEqual([row(live.dispatchId).action, row(live.dispatchId).reason], ['left', 'running']);
  const lostAttempt = () => p.ledger().tasks['A.2'].attempts.find((a) => a.token === lost.token);
  assert.equal(lostAttempt().state, 'cancelled', 'the lost attempt is cancelled before the resume');
  assert.deepEqual(first.report.activeAttempts.map((a) => a.taskId), ['A.1'], 'the report already reflects the settlement');
  const d2 = p.read().dispatches[lost.dispatchId];
  assert.deepEqual([d2.phase, d2.disposition, d2.failureClass], ['ended', 'cancelled', 'lost']);
  assert.equal(readRuns(p.runStore)[lost.workerRunId].end.state, 'cancelled');
  assert.equal(fs.existsSync(lost.attempt.worktree), false, 'its worktree is removed once its cleanup is verified (IC-021)');
  assert.ok(p.read().drivers.some((d) => d.lost === 'driver-lost' && d.endReason === 'lost' && d.endedAt));

  const stillBlocked = await p.step();
  assert.equal(stillBlocked.outcome, 'resume-required');
  assert.equal(Object.keys(p.read().dispatches).length, 2, 'nothing admitted before the acknowledgement');

  const resumed = await controls.resume(p.ctl({ ack: first.digest }));
  assert.equal(resumed.disposition, 'resumed', JSON.stringify({ disposition: resumed.disposition, reason: resumed.reason }));
  assert.equal(resumed.epoch, 2);
  assert.equal(p.read().run.state, 'running');
  const history = p.ledger().runs[p.started.runKey].history.filter((h) => h.action === 'resume');
  assert.ok(lostAttempt().cancel.at <= history[0].at, 'the cancel precedes the resume, which clears it');
  const liveRun = readRuns(p.runStore)[live.workerRunId];
  assert.equal(liveRun.phase, 'running', 'the live worker run is left');
  assert.equal(tree.alive(liveRun.worker), true);

  const next = await p.step();
  t.diagnostic(`restart case took ${Date.now() - started} ms`);
  const retry = Object.values(p.read().dispatches).find((d) => d.task === 'A.2' && d.token === lost.token + 1);
  assert.ok(retry, `A.2 is admitted again: ${JSON.stringify(next.actions)}`);
  assert.equal(p.read().dispatches[live.dispatchId].staleReason, 'epoch', 'the live dispatch is stale by epoch');
  assert.equal(readRuns(p.runStore)[live.workerRunId].phase, 'running', 'and its worker runs on');
});

/** A sequential attempt on A.1 submitted with a change, then its integration "taken" by a lost
 * holder: the lease set and the dispatch `integrating`, as IC-018 step 1 leaves them. */
async function leased(t) {
  const p = await project(t, { plan: 'budget', mode: 'sequential' });
  const y = (await p.step()).perform;
  fs.writeFileSync(path.join(y.worktree, 'src', 'retry.js'), '// retried\n');
  const submitted = await loop.submit(p.options({ dispatchId: y.dispatchId, status: 'success', summary: 'done' }));
  assert.equal(submitted.disposition, 'submitted', JSON.stringify(submitted));
  const d = p.read().dispatches[y.dispatchId];
  const preHead = p.integration.head;
  const dead = deadPid();
  store.mutateDispatch(p.file, (s) => {
    s.lease = { holder: { pid: dead, start: DEAD_START }, dispatchId: d.dispatchId, preHead, takenAt: new Date().toISOString() };
    s.dispatches[d.dispatchId].phase = 'integrating';
    return { write: true, result: null };
  });
  const wt = p.integration.worktree;
  const pick = (args) => git(wt, p.env, ['-c', 'user.name=t', '-c', 'user.email=t@invalid', 'cherry-pick', ...args, d.commit]);
  return { p, d, preHead, wt, pick };
}

test('IC-032 lease rule: a finished COMPLETED integration at pickedHead is adopted', POSIX, async (t) => {
  const { p, d, wt, pick } = await leased(t);
  pick([]);
  const picked = git(wt, p.env, ['rev-parse', 'HEAD']);
  store.mutateDispatch(p.file, (s) => { s.lease.pickedHead = picked; return { write: true, result: null }; });
  const v = await runVerification({ root: p.root, slug: SLUG, taskId: 'A.1', worktree: wt, argv: p.sb.verifyArgv, seconds: 30, env: p.env });
  const fin = attempts.finish({ ...p.common, task: 'A.1', token: d.token, result: 'COMPLETED', evidenceId: v.evidenceId, tokens: 0, basis: 'estimated' });
  assert.equal(fin.disposition, 'applied', JSON.stringify(fin));

  const out = await controls.resume(p.ctl());
  assert.equal(out.disposition, 'ack-required', JSON.stringify(out));
  assert.deepEqual(out.lease, { dispatchId: d.dispatchId, action: 'adopted' });
  const s = p.read();
  assert.equal(s.lease, null);
  assert.equal(s.run.integration.head, picked);
  const x = s.dispatches[d.dispatchId];
  assert.deepEqual([x.phase, x.disposition, x.integratedCommit, x.evidenceId], ['ended', 'completed', picked, v.evidenceId]);
  assert.equal(x.removal.verified, true);
});

test('IC-032 lease rule: an interrupted pick is undone, its live verification group ended and its attempt released; an unnamed worktree directory is listed and kept', POSIX, async (t) => {
  const { p, d, preHead, wt, pick } = await leased(t);
  pick(['--no-commit']);
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore', env: {} });
  t.after(() => kill(-sleeper.pid));
  const group = await until(() => { const start = tree.procStart(sleeper.pid); return start ? { pid: sleeper.pid, pgid: sleeper.pid, start } : null; }, 'the verification group');
  store.mutateDispatch(p.file, (s) => { s.run.verifying = group; return { write: true, result: null }; });
  const stray = path.join(p.root, WORKTREES_DIR, 'stray-dir');
  fs.mkdirSync(stray, { recursive: true });

  const out = await controls.resume(p.ctl());
  assert.equal(out.disposition, 'ack-required', JSON.stringify(out));
  assert.deepEqual(out.lease, { dispatchId: d.dispatchId, action: 'undone' });
  assert.equal(tree.alive(group), false, 'the recorded verification group is ended');
  const s = p.read();
  assert.deepEqual([s.lease, s.run.verifying], [null, null]);
  assert.equal(git(wt, p.env, ['rev-parse', 'HEAD']), preHead);
  assert.equal(git(wt, p.env, ['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter((l) => l && !l.endsWith('.doflow-worktree-base')).length, 0);
  const x = s.dispatches[d.dispatchId];
  assert.deepEqual([x.phase, x.disposition], ['ended', 'interrupted']);
  const attempt = p.ledger().tasks['A.1'].attempts[0];
  assert.equal(attempt.state, 'released');
  assert.match(attempt.reason, /^interrupted/);
  assert.ok(out.orphans.some((o) => fs.realpathSync(o) === fs.realpathSync(stray)), JSON.stringify(out.orphans));
  assert.equal(out.orphans.length, 1, 'named worktrees are not orphans');
  assert.equal(fs.existsSync(stray), true, 'an orphan is never deleted');
});

test('IC-032 lease rule: an integration worktree with a path outside the change blocks integration-dirty and touches nothing', POSIX, async (t) => {
  const { p, d, wt, pick } = await leased(t);
  pick(['--no-commit']);
  fs.writeFileSync(path.join(wt, 'notes.txt'), 'someone else\n');
  const out = await controls.resume(p.ctl());
  assert.deepEqual(out.lease, { dispatchId: d.dispatchId, action: 'blocked' });
  const s = p.read();
  assert.equal(s.run.state, 'blocked');
  assert.deepEqual([s.run.integrationGap.kind, s.run.integrationGap.reason], ['integration-dirty', 'dirty']);
  assert.equal(s.lease.dispatchId, d.dispatchId, 'the lease is kept');
  assert.equal(s.dispatches[d.dispatchId].phase, 'integrating');
  assert.equal(fs.readFileSync(path.join(wt, 'notes.txt'), 'utf8'), 'someone else\n');
  assert.equal(fs.readFileSync(path.join(wt, 'src', 'retry.js'), 'utf8'), '// retried\n');
  assert.equal(p.ledger().tasks['A.1'].attempts[0].state, 'active');
});

test('IC-032 settlement: an admitted slot whose claim landed is adopted and released interrupted; one without a claim is dropped and its worktree removed; a claimed one with a worker run is adopted launched', POSIX, async (t) => {
  const p = await project(t, { plan: 'disjoint', mode: 'auto', concurrency: 4 });
  const gone = p.lostDriver();
  store.mutateDispatch(p.file, (s) => { s.drivers.push(gone); return { write: true, result: null }; });
  const owner = { pid: gone.pid, start: gone.start };
  // A.1: the claim landed before the dispatch write.
  const landed = p.seedDispatch({ task: 'A.1', phases: [], by: owner });
  // A.2: no claim.
  const slot = p.seedDispatch({ task: 'A.2', phases: [], claim: false, by: owner });
  // A.3: claimed, with its worker run ended.
  const claimed = p.seedDispatch({ task: 'A.3', phases: ['claimed'], by: owner });
  const runId = p.seedRun({ task: 'A.3', token: claimed.token, phase: 'ended', end: { state: 'exited', at: new Date().toISOString() } });

  const out = await controls.resume(p.ctl());
  assert.equal(out.disposition, 'ack-required', JSON.stringify(out));
  const actions = (id) => out.settled.filter((x) => x.dispatchId === id).map((x) => `${x.phase}:${x.action}`);
  assert.deepEqual(actions(landed.dispatchId), ['admitted:adopted', 'claimed:released']);
  assert.deepEqual(actions(slot.dispatchId), ['admitted:dropped']);
  assert.deepEqual(actions(claimed.dispatchId), ['claimed:adopted', 'launched:left']);
  const s = p.read();
  assert.deepEqual([s.dispatches[landed.dispatchId].phase, s.dispatches[landed.dispatchId].disposition], ['ended', 'interrupted']);
  assert.equal(p.ledger().tasks['A.1'].attempts[0].state, 'released');
  assert.equal(fs.existsSync(landed.worktree), false);
  assert.equal(s.dispatches[slot.dispatchId], undefined);
  assert.equal(fs.existsSync(slot.worktree), false);
  assert.deepEqual([s.dispatches[claimed.dispatchId].phase, s.dispatches[claimed.dispatchId].workerRunId], ['launched', runId]);
  assert.deepEqual(out.orphans, []);
});

// RT-2: the lease rule's `block` runs from resume (and cancel) on a run another writer holds. It
// records the integration-dirty gap and leaves the held state; the acknowledged resume then reads
// the gap and leaves the run blocked, not running over a stranded lease.
for (const held of ['resume-required', 'cancelling']) {
  test(`RT-2: the lease rule blocking a dirty integration leaves a ${held} run ${held}`, POSIX, async (t) => {
    const { p, d, wt, pick } = await leased(t);
    pick(['--no-commit']);
    fs.writeFileSync(path.join(wt, 'notes.txt'), 'someone else\n');
    store.mutateDispatch(p.file, (s) => { s.run.state = held; if (held === 'resume-required') s.run.resumeReason = 'driver-lost'; return { write: true, result: null }; });
    const out = await controls.resume(p.ctl());
    assert.deepEqual(out.lease, { dispatchId: d.dispatchId, action: 'blocked' }, JSON.stringify(out));
    const s = p.read();
    assert.equal(s.run.state, held, `the ${held} state is kept`);
    assert.equal(s.run.integrationGap.kind, 'integration-dirty');
    assert.equal(s.lease.dispatchId, d.dispatchId, 'the lease is kept');
    if (held === 'resume-required') {
      const resumed = await controls.resume(p.ctl({ ack: out.digest }));
      assert.equal(resumed.disposition, 'resumed', JSON.stringify(resumed));
      assert.equal(p.read().run.state, 'blocked', 'the recorded gap blocks the resumed run');
    }
  });
}

// RT-6 / SF-10 (NFR-005, DEC-047): worker cleanup is inferred `verified` only from an observed group
// reading. Each case seeds an ended (`released`) subagent dispatch whose 081 run ended `exited`; the
// injected platform and the seeded `process` record decide what was observed. A step records the
// cleanup the deferred-removal rule reads, then cancel removes only what was observed verified.
async function exitedWorker(t, { platform, process: proc }) {
  const p = await project(t, { plan: 'disjoint', mode: 'auto' });
  const at = new Date().toISOString();
  const seeded = [];
  for (const [task, extra] of [['A.1', proc], ['A.2', { groupAlive: false }]]) {
    const d = p.seedDispatch({ task, phases: ['claimed', 'launched'] });
    const runId = p.seedRun({ task, token: d.token, phase: 'ended', end: { state: 'exited', at }, process: { kind: 'exited', code: 0, signal: null, at, ...extra } });
    store.mutateDispatch(p.file, (s) => {
      Object.assign(s.dispatches[d.dispatchId], { workerRunId: runId, phase: 'ended', disposition: 'released', endedAt: at, releaseReason: 'test' });
      return { write: true, result: null };
    });
    seeded.push(d);
  }
  const [unobserved, observed] = seeded;
  await p.step({ platform });
  const d = p.read().dispatches[unobserved.dispatchId];
  const cleanupOf = (x) => (x.cleanup ? x.cleanup.cleanup ?? x.cleanup : null);
  assert.equal(cleanupOf(d) && cleanupOf(d).status, 'unknown', `cleanup reads unknown: ${JSON.stringify(d.cleanup)}`);
  assert.equal(fs.existsSync(unobserved.worktree), true, 'the attempt worktree is kept');
  const out = await controls.cancel(p.ctl({ platform }));
  assert.equal(out.disposition, 'cancelled', JSON.stringify(out));
  assert.equal(out.cleanupVerified, false, JSON.stringify(out));
  assert.ok(out.worktrees.kept.some((k) => k.path === unobserved.worktree && k.reason === 'worker-cleanup-unverified'), `kept and listed: ${JSON.stringify(out.worktrees)}`);
  assert.equal(fs.existsSync(unobserved.worktree), true);
  return { p, observed, platform };
}

test('RT-6 / SF-10: on win32 an exited worker run with no leftover reads cleanup unknown, cleanupVerified false, its worktree kept and listed', POSIX, async (t) => {
  const { observed } = await exitedWorker(t, { platform: 'win32', process: {} });
  assert.equal(fs.existsSync(observed.worktree), true, 'on win32 no group reading is trusted, so every worker worktree is kept');
});

test('RT-6: on POSIX an exited worker run whose leftover is unknown is never cleanup verified; an observed gone group is', POSIX, async (t) => {
  const { p, observed } = await exitedWorker(t, { platform: process.platform, process: { groupAlive: true, leftover: { status: 'unknown', reason: 'ps-failed', survivors: [], zombies: [] } } });
  const cleanup = p.read().dispatches[observed.dispatchId].cleanup;
  assert.equal(cleanup.cleanup.status, 'verified', JSON.stringify(cleanup));
  assert.equal(fs.existsSync(observed.worktree), false, 'an observed gone group lets its worktree be removed');
});

// RR-1 (NFR-005, DEC-047, IC-021): a child worktree follows the same rule. Each case seeds an ended
// granter with launched spawn requests whose 081 child runs ended `exited`, with the seeded `process`
// record and the injected platform deciding what was observed. A step settles each child's cleanup
// through `exitedCleanup` and removes only an observed gone group's worktree; cancel then keeps and
// lists every other child worktree.
async function exitedChildren(t, { platform, children }) {
  const { createChildWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
  const p = await project(t, { plan: 'disjoint', mode: 'auto' });
  const at = new Date().toISOString();
  const granter = p.seedDispatch({ task: 'A.1', phases: ['claimed', 'launched'] });
  const workerRunId = p.seedRun({ task: 'A.1', token: granter.token, phase: 'ended', end: { state: 'exited', at }, process: { kind: 'exited', code: 0, signal: null, at, groupAlive: false } });
  const seeded = children.map((proc, i) => {
    const n = i + 1;
    const requestId = `${granter.dispatchId}.c${n}`;
    const wt = createChildWorktree({ root: p.root, slug: SLUG, dispatchId: granter.dispatchId, n, base: p.integration.head, env: p.env });
    const childRunId = p.seedRun({ task: 'A.1', token: granter.token, childOf: workerRunId, request: requestId, phase: 'ended', end: { state: 'exited', at }, process: { kind: 'exited', code: 0, signal: null, at, ...proc } });
    store.mutateDispatch(p.file, (s) => {
      s.spawnRequests[requestId] = {
        requestId, granterDispatchId: granter.dispatchId, state: 'launched', childRunId, reserveTokens: null, prompt: null,
        launchedAt: at, worktree: wt.worktree, endState: null,
      };
      return { write: true, result: null };
    });
    return { requestId, worktree: wt.worktree };
  });
  store.mutateDispatch(p.file, (s) => {
    Object.assign(s.dispatches[granter.dispatchId], { workerRunId, phase: 'ended', disposition: 'released', endedAt: at, releaseReason: 'test' });
    return { write: true, result: null };
  });
  await p.step({ platform });
  return { p, seeded };
}

const SURVIVORS = { groupAlive: true, leftover: { status: 'survivors', reason: 'group-survived', survivors: [{ pid: 1 }], zombies: [] } };

test('RR-1: on win32 an exited child run with an observed gone group reads cleanup unknown; its worktree is kept by the step and by cancel', POSIX, async (t) => {
  const { p, seeded: [child] } = await exitedChildren(t, { platform: 'win32', children: [{ groupAlive: false }] });
  const r = p.read().spawnRequests[child.requestId];
  assert.deepEqual([r.endState, r.cleanup], ['exited', { status: 'unknown', reason: 'win32' }], JSON.stringify(r));
  assert.equal(fs.existsSync(child.worktree), true, 'on win32 no group reading is trusted, so the child worktree is kept');
  const out = await controls.cancel(p.ctl({ platform: 'win32' }));
  assert.equal(out.disposition, 'cancelled', JSON.stringify(out));
  assert.equal(out.cleanupVerified, false, JSON.stringify(out));
  assert.ok(out.worktrees.kept.some((k) => k.path === child.worktree && k.reason === 'worker-cleanup-unverified'), `kept and listed: ${JSON.stringify(out.worktrees)}`);
  assert.equal(fs.existsSync(child.worktree), true);
});

test('RR-1: on POSIX an exited child run with leftover survivors keeps its worktree; an observed gone group\'s is removed', POSIX, async (t) => {
  const { p, seeded: [survived, gone] } = await exitedChildren(t, { platform: process.platform, children: [SURVIVORS, { groupAlive: false }] });
  const s = p.read();
  assert.deepEqual(s.spawnRequests[survived.requestId].cleanup, { status: 'survivors', reason: 'group-survived' });
  assert.equal(fs.existsSync(survived.worktree), true, 'a child whose group survived keeps its worktree');
  assert.deepEqual(s.spawnRequests[gone.requestId].cleanup, { status: 'verified', reason: 'exited' });
  assert.equal(s.spawnRequests[gone.requestId].removal.verified, true, JSON.stringify(s.spawnRequests[gone.requestId]));
  assert.equal(fs.existsSync(gone.worktree), false, 'an observed gone group lets the child worktree be removed');
  const out = await controls.cancel(p.ctl());
  assert.equal(out.disposition, 'cancelled', JSON.stringify(out));
  assert.equal(out.cleanupVerified, false, JSON.stringify(out));
  assert.ok(out.worktrees.kept.some((k) => k.path === survived.worktree && k.reason === 'worker-cleanup-unverified'), `kept and listed: ${JSON.stringify(out.worktrees)}`);
  assert.equal(fs.existsSync(survived.worktree), true);
});

// RT-9: an attempt the ledger shows finished COMPLETED with no pick recorded (an empty change, or a
// pick equal to preHead's tree) and the integration HEAD still at preHead is adopted completed, not
// recorded interrupted while 080 shows it SUCCEEDED.
test('RT-9: the lease rule adopts a COMPLETED attempt with no pickedHead whose integration HEAD is preHead', POSIX, async (t) => {
  const { p, d, preHead, wt } = await leased(t);
  const v = await runVerification({ root: p.root, slug: SLUG, taskId: 'A.1', worktree: wt, argv: p.sb.verifyArgv, seconds: 30, env: p.env });
  const fin = attempts.finish({ ...p.common, task: 'A.1', token: d.token, result: 'COMPLETED', evidenceId: v.evidenceId, tokens: 0, basis: 'estimated' });
  assert.equal(fin.disposition, 'applied', JSON.stringify(fin));
  const out = await controls.resume(p.ctl());
  const s = p.read();
  const x = s.dispatches[d.dispatchId];
  assert.deepEqual([out.lease && out.lease.action, x.disposition, x.integratedCommit, s.run.integration.head, s.lease],
    ['adopted', 'completed', null, preHead, null], JSON.stringify(out));
});

// RT-17: a free-text `--reason` is masked once, where it is read, so neither the dispatch store, the
// 080 ledger (pause, cancel) nor the 081 run store (the reason cancel forwards to cancelRun) holds a
// secret typed into it.
test('RT-17: pause and cancel reasons carrying a secret are stored masked in every store', POSIX, async (t) => {
  const p = await project(t, { plan: 'budget', mode: 'auto', probe: true, identity: { DOFLOW_ATTEMPT: undefined }, scenario: { run: [{ sleep: 30000 }, { emit: SUCCESS }] } });
  await p.step();
  const [d] = Object.values(p.read().dispatches);
  assert.equal(d.phase, 'launched');
  assert.equal((await controls.pause(p.ctl({ reason: `hold ${SECRET}` }))).disposition, 'paused');
  const out = await controls.cancel(p.ctl({ reason: `stop ${SECRET}` }));
  assert.equal(out.disposition, 'cancelled', JSON.stringify(out));
  const text = [p.file, p.ledgerFile, p.runStore].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.deepEqual([text.includes(SECRET), /stop /.test(p.read().run.cancel.reason)], [false, true]);
});
