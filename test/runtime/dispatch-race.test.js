'use strict';

// Feature 082 D.4 (IC-041 race test, NFR-004; FR-003, FR-004, FR-005; DEC-010, DEC-015, DEC-058):
// two processes calling `executeDispatchCommand` on one dispatch run, released together by
// test/helper/race-barrier.js.
//
//   - One READY task: exactly one dispatch is admitted, and the other pass records
//     `skipped:active-dispatch` naming it (IC-007 step 5, inside the dispatch lock).
//   - A token limit that fits one reservation: the 080 run's reserved total never exceeds it.
//   - A cancel racing a collection (a main-session `submit`, or the `step` that integrates a
//     collected dispatch): no dispatch ends `completed` whose 080 attempt was cancelled.
//
// This file is also the race worker's module. race-barrier.js requires the module it is given and
// calls one of its fixed operation names synchronously; `executeDispatchCommand` is async, so the
// worker's `claim` starts the command, returns at once, and writes the command's `{ exit, body }`
// to `args.out` (a temporary file, then a rename) when it settles. The parent waits for every
// worker's out file before the next repetition, because the worker's barrier spin blocks its event
// loop. Workers hold no state between repetitions: each repetition is a fresh sandbox.
//
// Every sandbox comes from test/helper/dispatch-sandbox.js: the commands' env PATH is its scratch
// bin/ (fake CLI links, node and git, never dirname(process.execPath), DEC-056) and the five
// DOFLOW_* identity variables are set, DOFLOW_ATTEMPT deleted where a worker is launched. The race
// workers' own PATH is an empty scratch bin. POSIX only.

const path = require('node:path');
const fs = require('node:fs');

if (process.argv[2] === '--race-worker') {
  const { executeDispatchCommand } = require('../../src/runtime/dispatch/command.ts');
  const settle = (out, value) => {
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, out);
  };
  module.exports = {
    claim: ({ out, options }) => {
      executeDispatchCommand(options).then(
        (answer) => settle(out, { answer }),
        (error) => settle(out, { error: { name: error.name, code: error.code || null, message: error.message } }),
      );
      return { pending: out };
    },
  };
  return;
}

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDir } = require('../helper/tmp.js');
const { startWorkers } = require('../helper/race-barrier.js');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { BUDGET_REFUSALS } = require(path.join(SRC, 'dispatch', 'admission.ts'));
const { executeDispatchCommand } = require(path.join(SRC, 'dispatch', 'command.ts'));
const { readRuns, storeFileFor: runStoreFileFor } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { cancelRun } = require(path.join(SRC, 'worker', 'cancel.ts'));

const SLUG = '082-dispatch-race';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
/** The admission race's window is the pre-lock read to the first locked write, under a millisecond,
 * so it sweeps finely and repeats most. */
const REPS = 40;
/** The reservation race launches and cancels subagent workers, so it repeats fewer times. */
const BUDGET_REPS = 4;
const CANCEL_REPS = 8;
const RESERVE = 10;
const SLEEPER = { run: [{ sleep: 30000 }] };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Two race workers on this module with an empty scratch PATH (race-barrier.js passes the parent's). */
function workers(t, dir) {
  const bin = path.join(dir, 'race-bin');
  fs.mkdirSync(bin);
  const savedPath = process.env.PATH;
  process.env.PATH = bin;
  let started;
  try {
    started = startWorkers({
      count: 2,
      modulePath: __filename,
      barrierDir: dir,
      envFor: () => ({
        HOME: dir, DOFLOW_RUN_ID: 'race0worker', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '1',
        DOFLOW_SESSION_ROLE: 'main', DOFLOW_WORKTREE: dir,
      }),
    });
  } finally {
    process.env.PATH = savedPath;
  }
  t.after(started.stop);
  let n = 0;
  /** One repetition: `ops[i]` is worker i's executeDispatchCommand options; resolves to each `{ exit, body }`. */
  return async (ops, skewFor) => {
    n += 1;
    const outs = ops.map((_, i) => path.join(dir, `out-${n}-${i}.json`));
    const replies = await started.race(ops.map((options, i) => ({ op: 'claim', args: { out: outs[i], options }, skewUs: skewFor(i) })));
    for (const reply of replies) assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    const end = Date.now() + 60000;
    while (!outs.every((out) => fs.existsSync(out))) {
      assert.ok(Date.now() < end, `repetition ${n}: a race worker never settled`);
      await sleep(10);
    }
    return outs.map((out) => {
      const settled = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(settled.error, undefined, `repetition ${n}: ${JSON.stringify(settled.error)}`);
      return settled.answer;
    });
  };
}

/** A sandbox with a dispatch run started through `executeDispatchCommand` (IC-002). */
async function project(t, { plan, mode, concurrency = 2, scenario = {}, identity = {}, probe = false, budget = false }) {
  // Registered before the sandbox, so it runs before the sandbox is removed: every 081 run still
  // alive is ended through 081.
  const live = {};
  t.after(async () => {
    if (!live.runStore || !fs.existsSync(live.runStore)) return;
    for (const run of Object.values(readRuns(live.runStore))) {
      if (run.phase === 'ended') continue;
      try { await cancelRun({ file: live.runStore, runId: run.runId, by: 'test', reason: 'test cleanup', env: live.env, cwd: live.root }); } catch { /* reported by the run */ }
    }
  });
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG, scenario, identity });
  const env = { ...sb.env };
  Object.assign(live, { runStore: runStoreFileFor(sb.root, SLUG), env, root: sb.root });
  if (probe) assert.equal((await readiness.probe({ descriptors: sb.descriptors, env, cwd: sb.root })).disposition, 'probed');
  const options = (extra) => ({ slug: SLUG, env, cwd: sb.root, ...extra });
  const started = await executeDispatchCommand(options({
    action: 'start', by: 'main', mode, concurrency: String(concurrency), verifyArgv: JSON.stringify(sb.verifyArgv),
    ...(budget ? { reserveTokens: String(RESERVE), budgetTokens: String(RESERVE) } : {}),
  }));
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  const ledgerFile = attempts.storeFile(sb.root, SLUG);
  return {
    sb, env, options, runKey: started.body.runKey,
    read: () => store.readDispatch(store.storeFileFor(sb.root, SLUG)),
    ledger: () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8')),
    step: (extra = {}) => ({ ...options({ action: 'step', by: 'main', descriptors: sb.descriptors }), ...extra }),
    cancel: () => options({ action: 'cancel', by: 'main', reason: 'race: cancel' }),
  };
}

/** The skew sweep: one racer starts `floor(rep / 2) * 150` microseconds late, alternating which,
 * so the racers' pre-lock work (a `ps` reading, git calls) is offset both ways in fine steps. */
const sweep = (rep) => (i) => (i === rep % 2 ? Math.floor(rep / 2) * 150 : 0);
/** The cancel's pre-lock work is shorter than a collection's, so the cancel (worker 1) starts up to
 * `CANCEL_REPS / 2 * ms` milliseconds late, which lets the sweep visit both orders. */
const cancelLate = (rep, ms) => (i) => (i === 1 ? Math.floor(rep / 2) * ms * 1000 : 0);

test('IC-041: two steps released together on one READY task admit one dispatch; the other pass records active-dispatch naming it', POSIX, async (t) => {
  const started = Date.now();
  const race = workers(t, tempDir(t, 'doflow-dispatch-race-'));
  for (let rep = 0; rep < REPS; rep += 1) {
    const p = await project(t, { plan: 'budget', mode: 'sequential' });
    const answers = await race([p.step(), p.step()], sweep(rep));
    const label = `repetition ${rep}: ${JSON.stringify(answers.map((a) => a.body.actions))}`;
    for (const a of answers) assert.deepEqual([a.exit, a.body.disposition], [0, 'stepped'], label);

    const dispatches = Object.values(p.read().dispatches);
    assert.equal(dispatches.length, 1, label);
    const [d] = dispatches;
    assert.deepEqual([d.task, d.token, d.phase, d.mode], ['A.1', 1, 'launched', 'sequential'], label);
    const claimed = answers.filter((a) => a.body.actions.some((x) => x.action === 'admit' && x.reason === 'claimed:sequential'));
    const others = answers.filter((a) => !claimed.includes(a));
    assert.equal(claimed.length, 1, `exactly one pass claimed: ${label}`);
    assert.equal(claimed[0].body.actions.find((x) => x.action === 'admit').dispatchId, d.dispatchId, label);
    const skipped = others[0].body.actions.filter((x) => x.action === 'admit');
    assert.deepEqual(skipped.map((x) => [x.task, x.reason, x.dispatchId]), [['A.1', 'skipped:active-dispatch', d.dispatchId]], label);
    assert.equal(others[0].body.actions.some((x) => x.action === 'claim-refused'), false, label);
    const ledger = p.ledger();
    assert.deepEqual(ledger.tasks['A.1'].attempts.map((x) => [x.token, x.state]), [[1, 'active']], label);
  }
  t.diagnostic(`${REPS} admission races in ${Date.now() - started} ms`);
});

test('IC-041: with a token limit that fits one reservation, two racing steps keep the reserved total at or under it', POSIX, async (t) => {
  const started = Date.now();
  const race = workers(t, tempDir(t, 'doflow-dispatch-race-'));
  for (let rep = 0; rep < BUDGET_REPS; rep += 1) {
    const p = await project(t, {
      plan: 'disjoint', mode: 'auto', concurrency: 4, scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined }, probe: true, budget: true,
    });
    const answers = await race([p.step(), p.step()], sweep(rep));
    const label = `repetition ${rep}: ${JSON.stringify(answers.map((a) => a.body.actions))}`;
    for (const a of answers) assert.deepEqual([a.exit, a.body.disposition], [0, 'stepped'], label);

    const ledger = p.ledger();
    const totals = ledger.runs[p.runKey].totals.tokens;
    assert.ok(totals.reserved <= RESERVE, `reserved ${totals.reserved} > ${RESERVE}: ${label}`);
    const active = Object.values(ledger.tasks).flatMap((x) => x.attempts).filter((x) => x.state === 'active');
    assert.equal(active.length, 1, `one attempt holds the reservation: ${label}`);
    assert.deepEqual(active[0].reserve, { tokens: RESERVE }, label);
    const live = Object.values(p.read().dispatches).filter((d) => d.phase !== 'ended');
    assert.deepEqual(live.map((d) => [d.mode, d.reservation]), [['subagent', { tokens: RESERVE }]], label);
    // Every other claim this repetition made was refused by the budget, never admitted past it.
    const refusals = answers.flatMap((a) => a.body.actions).filter((x) => x.action === 'claim-refused');
    assert.ok(refusals.length >= 1, `the budget refused at least one claim: ${label}`);
    for (const r of refusals) assert.ok(BUDGET_REFUSALS.includes(r.reason), `${r.reason}: ${label}`);

    const cancelled = await executeDispatchCommand(p.cancel());
    assert.equal(cancelled.body.disposition, 'cancelled', JSON.stringify(cancelled.body));
  }
  t.diagnostic(`${BUDGET_REPS} reservation races in ${Date.now() - started} ms`);
});

test('IC-041: a cancel racing a collection leaves no dispatch completed whose attempt was cancelled', POSIX, async (t) => {
  const started = Date.now();
  const race = workers(t, tempDir(t, 'doflow-dispatch-race-'));
  const seen = { submit: new Set(), step: new Set() };
  for (let rep = 0; rep < CANCEL_REPS; rep += 1) {
    const p = await project(t, { plan: 'budget', mode: 'sequential' });
    const first = await executeDispatchCommand(p.step());
    assert.equal(first.body.outcome, 'perform', JSON.stringify(first.body));
    const y = first.body.perform;
    fs.writeFileSync(path.join(y.worktree, 'src', 'retry.js'), `// collected ${rep}\n`);
    const submit = p.options({ action: 'submit', dispatch: y.dispatchId, status: 'success', summary: `done ${rep}` });

    // Even repetitions race the collection itself (a main-session submit); odd ones race the step
    // that integrates the collected dispatch, verifies and finishes it.
    const variant = rep % 2 === 0 ? 'submit' : 'step';
    if (variant === 'step') assert.equal((await executeDispatchCommand(submit)).body.disposition, 'submitted');
    const ops = [variant === 'submit' ? submit : p.step(), p.cancel()];
    const [collected, cancelled] = await race(ops, cancelLate(rep, variant === 'submit' ? 100 : 120));
    const label = `repetition ${rep} (${variant}): ${JSON.stringify([collected.body, cancelled.body])}`;
    // The cancel either ends the run or finds it already completed by the racing step.
    const s = p.read();
    if (cancelled.body.disposition === 'cancelled') assert.equal(s.run.state, 'cancelled', label);
    else assert.deepEqual([variant, cancelled.body.reason, s.run.state], ['step', 'run-ended', 'completed'], label);
    seen[variant].add(`${variant === 'submit' ? collected.body.disposition : collected.body.outcome}/${s.run.state}`);

    const tasks = p.ledger().tasks;
    for (const d of Object.values(s.dispatches)) {
      assert.equal(d.phase, 'ended', label);
      const attempt = tasks[d.task].attempts.find((x) => x.token === d.token);
      if (d.disposition === 'completed') assert.notEqual(attempt.state, 'cancelled', `completed over a cancelled attempt: ${label}`);
      if (attempt.state === 'cancelled') assert.notEqual(d.disposition, 'completed', label);
    }
    // A step after the race integrates nothing.
    const after = await executeDispatchCommand(p.step());
    assert.deepEqual([after.body.outcome, after.body.actions], [s.run.state, []], label);
  }
  // The sweep visited both orders: a collection the cancel overtook and one that landed first.
  assert.ok([...seen.submit, ...seen.step].some((x) => x.startsWith('stale') || x.startsWith('refused') || x.startsWith('cancelled')), JSON.stringify(seen));
  assert.ok([...seen.submit, ...seen.step].some((x) => x.startsWith('submitted') || x.startsWith('completed')), JSON.stringify(seen));
  t.diagnostic(`${CANCEL_REPS} cancel races in ${Date.now() - started} ms; seen ${JSON.stringify({ submit: [...seen.submit], step: [...seen.step] })}`);
});

// The interleaving the load race found: `decide` reads the run `running` outside the lock and runs
// the final verification; a cancel lands in that window and ends the run (IC-030 steps 3 to 9);
// the completion write must then not overwrite `cancelled` with `completed` (IC-026, IC-030 step 3).
// The cancel runs to its end inside the step's final verification, so the order is fixed.
test('IC-041 / IC-030: a cancel that ends the run during the final verification is not overwritten by the completion', POSIX, async (t) => {
  const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));
  const { runVerification } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
  const p = await project(t, { plan: 'budget', mode: 'sequential' });
  const first = await executeDispatchCommand(p.step());
  assert.equal(first.body.outcome, 'perform', JSON.stringify(first.body));
  const y = first.body.perform;
  fs.writeFileSync(path.join(y.worktree, 'src', 'retry.js'), '// collected\n');
  const submitted = await executeDispatchCommand(p.options({ action: 'submit', dispatch: y.dispatchId, status: 'success', summary: 'done' }));
  assert.equal(submitted.body.disposition, 'submitted', JSON.stringify(submitted.body));

  let cancelled = null;
  const verify = async (args) => {
    const result = await runVerification(args);
    // The final verification is the one run with the slug as its task id (IC-026 step 5).
    if (args.taskId === SLUG && !cancelled) cancelled = (await executeDispatchCommand(p.cancel())).body;
    return result;
  };
  const stepped = await loop.step({ slug: SLUG, env: p.env, cwd: p.sb.root, by: 'main', descriptors: p.sb.descriptors, verify });
  const label = JSON.stringify([stepped, cancelled]);
  assert.ok(cancelled, `the final verification ran: ${label}`);
  assert.equal(cancelled.disposition, 'cancelled', label);
  const s = p.read();
  assert.equal(s.run.state, 'cancelled', label);
  assert.equal(s.run.completion ?? null, null, `no completion record on a cancelled run: ${label}`);
  assert.equal(stepped.outcome, 'cancelled', label);
  assert.equal(stepped.completion, undefined, label);
  assert.deepEqual(stepped.actions.filter((a) => a.action === 'decide').map((a) => a.reason), ['cancelled:cancelled'], label);
  assert.equal(s.steps[s.steps.length - 1].outcome, 'cancelled', label);
  // Every final verification run is still recorded, and nothing was integrated past the cancel.
  assert.equal(s.run.verifying, null, label);
  assert.ok(s.run.verifications.length >= 1, label);
  const after = await executeDispatchCommand(p.step());
  assert.deepEqual([after.body.outcome, after.body.actions], ['cancelled', []], label);
});

// RT-1: a timeout pass takes its targets from one snapshot and awaits each one's `cancelRun`, so the
// snapshot ages. Both dispatches are past their deadline; the injected clock, on its first reading
// after the first one ended, plays a second driver that collects the other and takes its lease
// (IC-018 step 1). The pass's `failDispatch` for that one must then refuse with no write: its 080
// attempt and the lease belong to the integration.
test('RT-1: a timeout pass whose snapshot holds a dispatch launched leaves it integrating once another driver took its lease', POSIX, async (t) => {
  const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));
  const { procStart } = require(path.join(SRC, 'worker', 'process-tree.ts'));
  const p = await project(t, { plan: 'disjoint', mode: 'auto', concurrency: 2, scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined }, probe: true });
  const first = await loop.step({ slug: SLUG, env: p.env, cwd: p.sb.root, by: 'main', descriptors: p.sb.descriptors });
  const launched = Object.values(p.read().dispatches);
  assert.deepEqual(launched.map((d) => [d.phase, d.mode]), [['launched', 'subagent'], ['launched', 'subagent']], JSON.stringify(first.actions));
  const file = store.storeFileFor(p.sb.root, SLUG);
  const past = new Date(Date.now() - 60000).toISOString();
  store.mutateDispatch(file, (s) => { for (const d of Object.values(s.dispatches)) d.deadline = past; return { write: true, result: null }; });

  let taken = null;
  const now = () => {
    if (!taken) {
      const s = store.readDispatch(file);
      const ended = Object.values(s.dispatches).find((d) => d.phase === 'ended');
      const other = ended && Object.values(s.dispatches).find((d) => d.phase === 'launched');
      if (other) {
        taken = other.dispatchId;
        store.transitionDispatch(file, other.dispatchId, ['launched'], (d) => Object.assign(d, { phase: 'collected', outcome: 'offered', collectedAt: new Date().toISOString(), commit: null, changes: [] }));
        store.mutateDispatch(file, (st) => {
          st.lease = { holder: { pid: process.pid, start: procStart(process.pid) }, dispatchId: other.dispatchId, preHead: st.run.integration.head, takenAt: new Date().toISOString() };
          st.dispatches[other.dispatchId].phase = 'integrating';
          return { write: true, result: null };
        });
      }
    }
    return new Date();
  };
  const stepped = await loop.step({ slug: SLUG, env: p.env, cwd: p.sb.root, by: 'main', descriptors: p.sb.descriptors, now });
  const label = JSON.stringify(stepped.actions);
  assert.ok(taken, `the second driver took a lease: ${label}`);
  const s = p.read();
  const d = s.dispatches[taken];
  assert.equal(d.phase, 'integrating', label);
  assert.equal(d.disposition ?? null, null, label);
  assert.equal(s.lease && s.lease.dispatchId, taken, `the lease is untouched: ${label}`);
  const attempt = p.ledger().tasks[d.task].attempts.find((a) => a.token === d.token);
  assert.equal(attempt.state, 'active', `its 080 attempt is untouched: ${label}`);
  const refusal = stepped.actions.find((a) => a.action === 'finish' && a.dispatchId === taken);
  assert.equal(refusal && refusal.reason, 'finish-refused:timeout:phase-not-allowed', label);
});

// RT-3: a cancel marks the run after admission claimed a dispatch and before its launch records the
// worker run. The injected `shouldStop` seam, read just before each launch, marks the run
// `cancelling` (IC-030 step 3) once the claim landed, so the order is fixed. The launch's
// `claimed` -> `launched` move must then be refused and the worker run it just started cancelled;
// the cancel that follows ends every dispatch with no live worker left behind.
test('RT-3: a launch after the cancel mark is refused and its worker run cancelled; no dispatch ends cancelled with a live worker', POSIX, async (t) => {
  const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));
  const controls = require(path.join(SRC, 'dispatch', 'controls.ts'));
  const p = await project(t, { plan: 'budget', mode: 'auto', scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined }, probe: true });
  const file = store.storeFileFor(p.sb.root, SLUG);
  const runStore = runStoreFileFor(p.sb.root, SLUG);
  let marked = false;
  const shouldStop = () => {
    if (!marked && Object.values(store.readDispatch(file).dispatches).some((d) => d.phase === 'claimed')) {
      marked = true;
      store.mutateDispatch(file, (s) => { s.run.state = 'cancelling'; return { write: true, result: null }; });
    }
    return false;
  };
  const stepped = await loop.step({ slug: SLUG, env: p.env, cwd: p.sb.root, by: 'main', descriptors: p.sb.descriptors, shouldStop });
  const label = JSON.stringify(stepped.actions);
  assert.ok(marked, `a dispatch was claimed: ${label}`);
  const [d] = Object.values(p.read().dispatches);
  assert.equal(d.phase, 'claimed', `the launch move is refused: ${label}`);
  assert.equal(d.workerRunId, null, label);
  const started = Object.values(readRuns(runStore)).filter((r) => r.task === d.task && r.token === d.token);
  assert.equal(started.length, 1, `the launch started one worker run: ${label}`);
  assert.equal(started[0].phase, 'ended', `the worker run just started is cancelled: ${label}`);
  assert.ok(stepped.actions.some((a) => a.action === 'launch' && a.reason.startsWith('moved:run-cancelling:')), label);

  const cancelled = await controls.cancel({ slug: SLUG, env: p.env, cwd: p.sb.root, by: 'main', reason: 'RT-3' });
  assert.equal(cancelled.disposition, 'cancelled', JSON.stringify(cancelled));
  const runs = readRuns(runStore);
  for (const x of Object.values(p.read().dispatches)) {
    assert.equal(x.phase, 'ended');
    if (x.workerRunId) assert.equal(runs[x.workerRunId].phase, 'ended', `dispatch ${x.dispatchId} ended with a live worker`);
  }
  assert.deepEqual(Object.values(runs).filter((r) => r.phase !== 'ended').map((r) => r.runId), [], 'no worker run is left live');
});
