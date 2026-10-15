'use strict';

// Feature 080 R.1 (IC-021, NFR-002; FR-008, FR-012; RK5): claim, cancel and finish races on one
// ledger, between child processes released together by a file barrier (test/helper/race-barrier.js),
// each at least 50 repetitions, plus the lock-removal control.
//
// Every repetition reseeds the same ledger, runs the race, and then checks the invariant and that
// the run's stored totals equal a recount from the attempt list (IC-009). Which racer wins is left
// to the lock; a swept start offset (`skewed`) spreads the interleavings, and the counts of each
// order are reported as diagnostics, never asserted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { startWorkers } = require('../helper/race-barrier');
const { claim } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, createRun, computeTotals } = require('../../src/runtime/task-run.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');

const MODULE = path.resolve(__dirname, '../../src/runtime/task-attempts.ts');
const SLUG = 'feat-race';
const REPS = 50;
// Before any evidence this test records, so evidence always postdates the attempt it proves.
const NOW = new Date('2000-01-02T00:00:00.000Z');
const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 the raced task; owner: core-implementer; files: a.js', '',
].join('\n');

function identityEnv(dir) {
  return {
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: dir, HOME: dir,
  };
}

/** A graph-plan project with a run at epoch 1, two workers on it, and a passing evidence item. */
function racingProject(t) {
  const dir = tempDir(t, 'doflow-task-run-races-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const barrierDir = path.join(dir, 'barriers');
  fs.mkdirSync(barrierDir);
  const env = identityEnv(dir);
  const key = runKeyFor(env, dir);
  const common = { file, roots: [dir], slug: SLUG, env, cwd: dir, now: NOW.toISOString() };

  const ledger = new EvidenceLedger({ repoRoot: dir, slug: SLUG });
  const evidenceId = ledger.addEvidence({
    taskId: 'A.1', kind: 'test-result', provenance: 'extracted', source: { provider: 'shell', capability: 'test' },
    locator: { file: 'a.test.js' }, content: 'ran', observation: { command: 'node --test', exitCode: 0 },
  });
  ledger.save('A.1');

  const seed = () => {
    const run = createRun(key, null, NOW, { epoch: 1 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 1, planPath: null, tasks: {}, runs: { [key.runKey]: run } }, null, 2));
  };
  /** Seed, then claim A.1 in-process; the returned token is the one the racers fight over. */
  const seedActive = () => {
    seed();
    const answer = claim({ ...common, fsImpl: fs, now: NOW, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1 });
    assert.equal(answer.disposition, 'claimed');
    return answer.token;
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const attempts = (store) => (store.tasks['A.1'] ? store.tasks['A.1'].attempts : []);
  const assertTotals = (store, label) => {
    assert.deepEqual(store.runs[key.runKey].totals, computeTotals(store, key.runKey), `${label}: totals equal a recount`);
  };
  const workers = startWorkers({ count: 2, modulePath: MODULE, envFor: () => env, barrierDir });
  t.after(() => workers.stop());

  const claimOp = (extra = {}) => ({ op: 'claim', args: { ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, ...extra } });
  const runCancelOp = () => ({ op: 'cancel', args: { ...common, by: 'orchestrator', reason: 'race' } });
  const attemptCancelOp = (token) => ({ op: 'cancel', args: { ...common, task: 'A.1', token, by: 'orchestrator', reason: 'race' } });
  const finishOp = (token) => ({ op: 'finish', args: { ...common, task: 'A.1', token, result: 'COMPLETED', evidenceId } });
  const releaseOp = (token) => ({ op: 'release', args: { ...common, task: 'A.1', token, reason: 'race' } });

  return { key, seed, seedActive, read, attempts, assertTotals, race: workers.race, claimOp, runCancelOp, attemptCancelOp, finishOp, releaseOp };
}

/** The two results, failing the test on a thrown error in either worker. */
function results(answers, label) {
  for (const a of answers) assert.equal(a.error, undefined, `${label}: a racer threw ${JSON.stringify(a.error)}`);
  return answers.map((a) => a.result);
}

function tally(counts, key) { counts[key] = (counts[key] || 0) + 1; }

/**
 * The repetition's two operations with a start offset swept across repetitions: odd repetitions
 * delay the first racer, even ones the second, by 0 to 4.5 ms. The barrier still releases both;
 * the offset only spreads the interleavings so a race whose racers do unequal work before the lock
 * visits both orders. No assertion depends on which order happens.
 */
function skewed(rep, first, second) {
  const skewUs = ((rep >> 1) % 10) * 500;
  return rep % 2 ? [{ ...first, skewUs }, second] : [first, { ...second, skewUs }];
}

// ── two claims of one task ──────────────────────────────────────────────────────────────────────

test('two processes claiming the same task: exactly one is claimed, 50 repetitions', async (t) => {
  const p = racingProject(t);
  for (let rep = 1; rep <= REPS; rep += 1) {
    const label = `rep ${rep}`;
    p.seed();
    const [a, b] = results(await p.race(skewed(rep, p.claimOp(), p.claimOp())), label);
    const claimed = [a, b].filter((r) => r.disposition === 'claimed');
    assert.equal(claimed.length, 1, `${label}: ${JSON.stringify([a, b])}`);
    const loser = a === claimed[0] ? b : a;
    assert.deepEqual([loser.disposition, loser.reason, loser.activeToken], ['refused', 'active-attempt', claimed[0].token], label);
    const store = p.read();
    assert.deepEqual(p.attempts(store).map((x) => [x.token, x.state]), [[1, 'active']], label);
    p.assertTotals(store, label);
  }
});

// ── claim against run cancel (FR-012) ───────────────────────────────────────────────────────────

test('a claim racing a run cancel never leaves an active attempt in the cancelled run, 50 repetitions', async (t) => {
  const p = racingProject(t);
  const order = {};
  for (let rep = 1; rep <= REPS; rep += 1) {
    const label = `rep ${rep}`;
    p.seed();
    const [claimed, cancelled] = results(await p.race(skewed(rep, p.claimOp(), p.runCancelOp())), label);
    assert.equal(cancelled.disposition, 'cancelled', label);
    const store = p.read();
    assert.equal(store.runs[p.key.runKey].control, 'cancelled', label);
    assert.deepEqual(p.attempts(store).filter((x) => x.state === 'active'), [], `${label}: no active attempt in a cancelled run`);
    if (claimed.disposition === 'claimed') {
      // The claim was accepted first, so the cancel saw it and cancelled it.
      tally(order, 'claim-then-cancel');
      assert.deepEqual(cancelled.cancelled, [{ taskId: 'A.1', token: claimed.token }], label);
      assert.deepEqual(p.attempts(store).map((x) => [x.token, x.state]), [[claimed.token, 'cancelled']], label);
    } else {
      tally(order, 'cancel-then-claim');
      assert.deepEqual([claimed.disposition, claimed.reason], ['refused', 'run-cancelled'], `${label}: ${JSON.stringify(claimed)}`);
      assert.deepEqual(cancelled.cancelled, [], label);
      assert.deepEqual(p.attempts(store), [], `${label}: a claim after the cancel writes nothing`);
    }
    p.assertTotals(store, label);
  }
  t.diagnostic(`orders: ${JSON.stringify(order)}`);
});

// ── finish against cancel (FR-008) ──────────────────────────────────────────────────────────────

for (const kind of ['run', 'attempt']) {
  test(`a COMPLETED finish racing ${kind === 'run' ? 'a run' : 'an attempt'} cancel is applied before it or stale after it, never both, 50 repetitions`, async (t) => {
    const p = racingProject(t);
    const order = {};
    for (let rep = 1; rep <= REPS; rep += 1) {
      const label = `rep ${rep}`;
      const token = p.seedActive();
      const cancelOp = kind === 'run' ? p.runCancelOp() : p.attemptCancelOp(token);
      const [finished, cancelled] = results(await p.race(skewed(rep, p.finishOp(token), cancelOp)), label);
      const store = p.read();
      const [attempt] = p.attempts(store);
      if (finished.disposition === 'applied') {
        tally(order, 'finish-then-cancel');
        assert.deepEqual([attempt.state, attempt.result, 'cancel' in attempt], ['finished', 'COMPLETED', false], label);
        if (kind === 'run') assert.deepEqual([cancelled.disposition, cancelled.cancelled], ['cancelled', []], label);
        else assert.deepEqual([cancelled.disposition, cancelled.reason], ['refused', 'no-active-attempt'], `${label}: ${JSON.stringify(cancelled)}`);
      } else {
        tally(order, 'cancel-then-finish');
        assert.deepEqual(finished, { disposition: 'stale', taskId: 'A.1', token, reason: 'attempt-cancelled' }, label);
        assert.equal(cancelled.disposition, 'cancelled', label);
        assert.deepEqual(cancelled.cancelled, [{ taskId: 'A.1', token }], label);
        assert.deepEqual([attempt.state, attempt.result], ['cancelled', null], `${label}: never COMPLETED after the cancel`);
      }
      assert.equal(p.attempts(store).length, 1, label);
      p.assertTotals(store, label);
    }
    t.diagnostic(`orders: ${JSON.stringify(order)}`);
  });
}

// ── finish against release on the same token ────────────────────────────────────────────────────

test('a finish racing a release of the same token: exactly one applies, 50 repetitions', async (t) => {
  const p = racingProject(t);
  const order = {};
  for (let rep = 1; rep <= REPS; rep += 1) {
    const label = `rep ${rep}`;
    const token = p.seedActive();
    const [finished, released] = results(await p.race(skewed(rep, p.finishOp(token), p.releaseOp(token))), label);
    const applied = [finished.disposition === 'applied', released.disposition === 'released'];
    assert.equal(applied.filter(Boolean).length, 1, `${label}: ${JSON.stringify([finished, released])}`);
    const loser = applied[0] ? released : finished;
    assert.deepEqual([loser.disposition, loser.reason], ['stale', 'no-active-attempt'], label);
    const store = p.read();
    const [attempt] = p.attempts(store);
    if (applied[0]) {
      tally(order, 'finish-won');
      assert.deepEqual([attempt.state, attempt.result], ['finished', 'COMPLETED'], label);
    } else {
      tally(order, 'release-won');
      assert.deepEqual([attempt.state, attempt.result], ['released', null], label);
    }
    assert.equal(p.attempts(store).length, 1, label);
    p.assertTotals(store, label);
  }
  t.diagnostic(`orders: ${JSON.stringify(order)}`);
});

// ── the lock-removal control (IC-021) ───────────────────────────────────────────────────────────

test('control: with the checks outside the lock, the two-claims race yields two claimed', async (t) => {
  const p = racingProject(t);
  p.seed();
  const seam = { checkOutsideLock: true, delayAfterCheckMs: 200 };
  const [a, b] = results(await p.race([p.claimOp(seam), p.claimOp(seam)]), 'control');
  assert.deepEqual([a.disposition, b.disposition], ['claimed', 'claimed'], 'the race test must detect a missing lock');
  const store = p.read();
  assert.deepEqual(p.attempts(store).filter((x) => x.state === 'active').map((x) => x.token).sort(), [1, 2]);
});
