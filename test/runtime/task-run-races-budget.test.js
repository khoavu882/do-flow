'use strict';

// Feature 080 R.2 (IC-021, FR-017, NFR-002; DEC-007, DEC-011, DEC-014; RK5): the budget,
// reservation and epoch races on one ledger, between child processes released together by a file
// barrier (test/helper/race-barrier.js), each at least 50 repetitions, plus the lock-removal
// control on the attempt-limit race.
//
// Every repetition reseeds the same ledger, runs the race, and then checks the invariant and that
// the run's stored totals equal a recount from the attempt list (IC-009). Which racer wins is left
// to the lock; a swept start offset (`skewed`, as in R.1) spreads the interleavings, and the counts
// of each order are reported as diagnostics, never asserted.
//
// The barrier serves the four attempt operations only, so the resume racer goes through a shim
// module written into the test's temp dir: it re-exports the ledger module and routes a `cancel`
// whose args carry `raceAs: 'resume'` to `resume`, with a git runner that answers nothing (the
// fixture's `.git` is an empty directory). Every other operation is the ledger's own function.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { startWorkers } = require('../helper/race-barrier.ts');
const { claim, release, resume } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, createRun, computeTotals } = require('../../src/runtime/task-run.ts');

const MODULE = path.resolve(__dirname, '../../src/runtime/task-attempts.ts');
const SLUG = 'feat-race-budget';
const REPS = 50;
const NOW = new Date('2000-01-02T00:00:00.000Z');
// Three tasks in one phase with no `depends-on:`, so any two are claimable at once and only the
// run's aggregate limits stand between them.
const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first raced task; owner: core-implementer; files: a.js',
  '- [ ] A.2 second raced task; owner: core-implementer; files: b.js',
  '- [ ] A.3 the task that spends the first attempt; owner: core-implementer; files: c.js', '',
].join('\n');
const SHIM = (modulePath) => [
  "'use strict';",
  `const ledger = require(${JSON.stringify(modulePath)});`,
  'module.exports = {',
  '  ...ledger,',
  '  cancel(args) {',
  '    const { raceAs, ...rest } = args;',
  '    return raceAs === "resume" ? ledger.resume({ ...rest, gitRunner: () => null }) : ledger.cancel(rest);',
  '  },',
  '};', '',
].join('\n');

function identityEnv(dir) {
  return {
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: dir, HOME: dir,
  };
}

/** A graph-plan project with two workers on one ledger; `seed(budget)` writes a run at epoch 1. */
function racingProject(t) {
  const dir = tempDir(t, 'doflow-task-run-races-budget-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const barrierDir = path.join(dir, 'barriers');
  fs.mkdirSync(barrierDir);
  const shim = path.join(dir, 'race-shim.js');
  fs.writeFileSync(shim, SHIM(MODULE));
  const env = identityEnv(dir);
  const key = runKeyFor(env, dir);
  const common = { file, roots: [dir], slug: SLUG, env, cwd: dir, now: NOW.toISOString() };
  const inProcess = { ...common, fsImpl: fs, now: NOW };

  const seed = (budget = null) => {
    const run = createRun(key, budget, NOW, { epoch: 1 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 1, planPath: null, tasks: {}, runs: { [key.runKey]: run } }, null, 2));
  };
  /** Seed, then spend one attempt on A.3 in-process: claimed and released with reported usage, so
   * it counts toward the run's attempts without leaving unreported usage (DEC-011). */
  const seedOneSpent = (budget) => {
    seed(budget);
    const answer = claim({ ...inProcess, task: 'A.3', owner: 'core-implementer', mode: 'subagent', epoch: 1, ...(budget.tokens != null ? { reserveTokens: 1 } : {}) });
    assert.equal(answer.disposition, 'claimed', JSON.stringify(answer));
    const released = release({ ...inProcess, task: 'A.3', token: answer.token, reason: 'seed', tokens: 0, basis: 'measured' });
    assert.equal(released.disposition, 'released', JSON.stringify(released));
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const attempts = (store, id) => (store.tasks[id] ? store.tasks[id].attempts : []);
  const allAttempts = (store) => Object.entries(store.tasks).flatMap(([id, e]) => e.attempts.map((a) => ({ id, ...a })));
  const assertTotals = (store, label) => {
    assert.deepEqual(store.runs[key.runKey].totals, computeTotals(store, key.runKey), `${label}: totals equal a recount`);
  };
  /** The digest an unacknowledged resume reports for the store as it now stands. */
  const resumeDigest = () => {
    const report = resume({ ...inProcess, gitRunner: () => null });
    assert.equal(report.disposition, 'ack-required', JSON.stringify(report));
    return report.digest;
  };
  const workers = startWorkers({ count: 2, modulePath: shim, envFor: () => env, barrierDir });
  t.after(() => workers.stop());

  const claimOp = (task, extra = {}) => ({ op: 'claim', args: { ...common, task, owner: 'core-implementer', mode: 'subagent', epoch: 1, ...extra } });
  const resumeOp = (ack) => ({ op: 'cancel', args: { ...common, raceAs: 'resume', ack, by: 'orchestrator', reason: 'race' } });

  return { key, seed, seedOneSpent, read, attempts, allAttempts, assertTotals, resumeDigest, race: workers.race, claimOp, resumeOp };
}

/** The two results, failing the test on a thrown error in either worker. */
function results(answers, label) {
  for (const a of answers) assert.equal(a.error, undefined, `${label}: a racer threw ${JSON.stringify(a.error)}`);
  return answers.map((a) => a.result);
}

function tally(counts, key) { counts[key] = (counts[key] || 0) + 1; }

/** As in R.1: odd repetitions delay the first racer, even ones the second, by 0 to 4.5 ms. */
function skewed(rep, first, second) {
  const skewUs = ((rep >> 1) % 10) * 500;
  return rep % 2 ? [{ ...first, skewUs }, second] : [first, { ...second, skewUs }];
}

// ── two claims against an attempt limit with one remaining (IC-009) ─────────────────────────────

const ATTEMPTS_BUDGET = { attempts: 2, tokens: null };

test('two claims against a run attempt limit with one remaining: exactly one is claimed, 50 repetitions', async (t) => {
  const p = racingProject(t);
  const order = {};
  for (let rep = 1; rep <= REPS; rep += 1) {
    const label = `rep ${rep}`;
    p.seedOneSpent(ATTEMPTS_BUDGET);
    const [a, b] = results(await p.race(skewed(rep, p.claimOp('A.1'), p.claimOp('A.2'))), label);
    const claimed = [a, b].filter((r) => r.disposition === 'claimed');
    assert.equal(claimed.length, 1, `${label}: ${JSON.stringify([a, b])}`);
    const loser = a === claimed[0] ? b : a;
    tally(order, `${claimed[0].taskId}-won`);
    assert.deepEqual(
      [loser.disposition, loser.reason, loser.scope, loser.measure, loser.limit, loser.used],
      // `used` counts the seeded attempt and the winner's: the loser checked after the winner wrote.
      ['refused', 'aggregate-exhausted', 'run', 'attempts', 2, 2],
      `${label}: ${JSON.stringify(loser)}`,
    );
    const store = p.read();
    assert.deepEqual(p.attempts(store, claimed[0].taskId).map((x) => [x.token, x.state]), [[1, 'active']], label);
    assert.deepEqual(p.attempts(store, loser.taskId), [], `${label}: the refused claim wrote nothing`);
    assert.equal(store.runs[p.key.runKey].totals.attempts, 2, label);
    p.assertTotals(store, label);
  }
  t.diagnostic(`orders: ${JSON.stringify(order)}`);
});

// ── two claims under a token limit with room for one reservation (DEC-011) ──────────────────────

const TOKENS_BUDGET = { attempts: null, tokens: 100 };
const RESERVE = 60;

test('two claims under a run token limit with room for one reservation: exactly one is claimed, 50 repetitions', async (t) => {
  const p = racingProject(t);
  const order = {};
  for (let rep = 1; rep <= REPS; rep += 1) {
    const label = `rep ${rep}`;
    p.seed(TOKENS_BUDGET);
    const op = (task) => p.claimOp(task, { reserveTokens: RESERVE });
    const [a, b] = results(await p.race(skewed(rep, op('A.1'), op('A.2'))), label);
    const claimed = [a, b].filter((r) => r.disposition === 'claimed');
    assert.equal(claimed.length, 1, `${label}: ${JSON.stringify([a, b])}`);
    const loser = a === claimed[0] ? b : a;
    tally(order, `${claimed[0].taskId}-won`);
    assert.deepEqual(
      [loser.disposition, loser.reason, loser.scope, loser.measure, loser.limit, loser.used, loser.reserved],
      ['refused', 'aggregate-exhausted', 'run', 'tokens', 100, 0, RESERVE],
      `${label}: ${JSON.stringify(loser)}`,
    );
    const store = p.read();
    assert.deepEqual(p.attempts(store, claimed[0].taskId).map((x) => [x.token, x.state, x.reserve]), [[1, 'active', { tokens: RESERVE }]], label);
    assert.deepEqual(p.attempts(store, loser.taskId), [], `${label}: the refused claim wrote nothing`);
    assert.equal(store.runs[p.key.runKey].totals.tokens.reserved, RESERVE, `${label}: one reservation held`);
    p.assertTotals(store, label);
  }
  t.diagnostic(`orders: ${JSON.stringify(order)}`);
});

// ── resume --ack against a claim with the old epoch (FR-017, DEC-007, DEC-014) ──────────────────

test('an acknowledged resume racing a claim never admits a claim with the old epoch after the resume, 50 repetitions', async (t) => {
  const p = racingProject(t);
  const order = {};
  for (let rep = 1; rep <= REPS; rep += 1) {
    const label = `rep ${rep}`;
    p.seed();
    const ack = p.resumeDigest();
    const [resumed, claimed] = results(await p.race(skewed(rep, p.resumeOp(ack), p.claimOp('A.1'))), label);
    const store = p.read();
    const run = store.runs[p.key.runKey];
    if (resumed.disposition === 'resumed') {
      assert.equal(resumed.epoch, 2, label);
      assert.equal(run.epoch, 2, label);
      if (claimed.disposition === 'claimed') {
        // Both succeeded only if the claim was written first, under the epoch it presented.
        tally(order, 'claim-then-resume');
        assert.ok(claimed.revision < resumed.revision, `${label}: a claim with epoch 1 admitted after the resume: ${JSON.stringify([claimed, resumed])}`);
        assert.equal(claimed.epoch, 1, label);
      } else {
        tally(order, 'resume-then-claim');
        assert.deepEqual([claimed.disposition, claimed.reason, claimed.epoch], ['refused', 'resume-required', 2], `${label}: ${JSON.stringify(claimed)}`);
        assert.deepEqual(p.attempts(store, 'A.1'), [], `${label}: the stale claim wrote nothing`);
      }
    } else {
      // The claim landed first and changed the report, so the acknowledgement no longer matches.
      tally(order, 'claim-then-resume-refused');
      assert.deepEqual([resumed.disposition, resumed.reason], ['refused', 'report-changed'], `${label}: ${JSON.stringify(resumed)}`);
      assert.equal(claimed.disposition, 'claimed', `${label}: ${JSON.stringify(claimed)}`);
      assert.equal(run.epoch, 1, label);
    }
    // On disk: an attempt carries the epoch it presented, which is the run's epoch at admission,
    // so an epoch-1 attempt exists only where the claim was written before any resume.
    for (const x of p.allAttempts(store)) {
      assert.equal(x.epoch, 1, label);
      assert.ok(resumed.disposition !== 'resumed' || claimed.revision < resumed.revision, `${label}: ${JSON.stringify(x)}`);
    }
    p.assertTotals(store, label);
  }
  t.diagnostic(`orders: ${JSON.stringify(order)}`);
});

// ── the lock-removal control (IC-021) ───────────────────────────────────────────────────────────

test('control: with the checks outside the lock, the attempt-limit race yields two claimed', async (t) => {
  const p = racingProject(t);
  p.seedOneSpent(ATTEMPTS_BUDGET);
  const seam = { checkOutsideLock: true, delayAfterCheckMs: 200 };
  const [a, b] = results(await p.race([p.claimOp('A.1', seam), p.claimOp('A.2', seam)]), 'control');
  assert.deepEqual([a.disposition, b.disposition], ['claimed', 'claimed'], 'the race test must detect a missing lock');
  const store = p.read();
  assert.equal(p.allAttempts(store).length, 3, 'the attempt limit of 2 was overrun');
  p.assertTotals(store, 'control');
});
