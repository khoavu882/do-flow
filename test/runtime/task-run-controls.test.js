'use strict';

// Feature 080 C.3 (IC-012 start, pause and cancel; IC-024 reopen; IC-026; DEC-005, DEC-006,
// DEC-009): the run controls and reopen, each one locked write against the ledger.
//
// In-process against hand-seeded ledgers. Every call passes an explicit identity environment, so
// the developer's shell never decides a run key; each project directory holds a `.git` so it is a
// worktree top of its own.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const {
  claim, finish, status, start, pause, cancel, reopen, TaskAttemptError,
} = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, createRun, startRun, pauseRun, cancelRun, cancelAttempt } = require('../../src/runtime/task-run.ts');
const { graphDigest } = require('../../src/runtime/task-graph.ts');

const SLUG = 'feat-c';
const NOW = new Date('2026-01-03T00:00:00.000Z');
const HEADER = '**Task graph:** v1';

function planText({ header = true, lines = null } = {}) {
  const tasks = lines || [
    '### Phase A', '',
    '- [ ] A.1 first task; owner: core-implementer; files: a.js',
    '- [ ] A.2 second task; owner: core-implementer; files: b.js',
    '', '### Phase B', '',
    '- [ ] B.1 later task; owner: core-implementer; files: c.js',
  ];
  return ['# Plan', '', ...(header ? [HEADER, ''] : []), '## Tasks', '', ...tasks, ''].join('\n');
}

function identityEnv(worktree, { run = 'r1', lineage = 'main', role = 'main' } = {}) {
  return {
    DOFLOW_RUN_ID: run, DOFLOW_LINEAGE_ID: lineage, DOFLOW_SESSION_ROLE: role, DOFLOW_ROLE: role,
    DOFLOW_WORKTREE: worktree, HOME: worktree,
  };
}

function project(t, plan = planText()) {
  const dir = tempDir(t, 'doflow-task-run-controls-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, plan);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const as = (who = {}) => {
    const env = identityEnv(dir, who);
    return { env, cwd: dir, key: runKeyFor(env, dir) };
  };
  const main = as();
  const common = (who = main) => ({ file, fsImpl: fs, roots: [dir], slug: SLUG, now: NOW, env: who.env, cwd: who.cwd });
  const seed = ({ runs, tasks = {} } = {}) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 1, planPath: null, tasks, ...(runs ? { runs } : {}) }, null, 2));
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { dir, file, as, main, common, seed, read };
}

/** An attempt as a claim would have written it; `runKey: null` leaves it runKey-less (pre-080). */
function attempt(token, { state = 'active', runKey, result = null } = {}) {
  const a = {
    token, owner: 'core-implementer', mode: 'subagent', startedAt: NOW.toISOString(), taskLineHash: 'sha256:x',
    state, result, evidenceId: null, reason: null,
  };
  if (runKey) a.runKey = runKey;
  return a;
}

const unchanged = (p, run) => {
  const before = fs.readFileSync(p.file);
  const answer = run();
  assert.deepEqual(fs.readFileSync(p.file), before, 'a refusal writes nothing');
  return answer;
};

const lastHistory = (p, who = p.main) => p.read().runs[who.key.runKey].history.at(-1);

// ── start ────────────────────────────────────────────────────────────────────────────────────────

test('start issues epoch 1 with history and the recorded graph; a second start is run-exists', (t) => {
  const p = project(t);
  p.seed();
  const answer = start({ ...p.common(), by: 'orchestrator', budgetAttempts: 9, budgetTokens: 1000 });
  assert.deepEqual(answer, {
    disposition: 'started', runKey: p.main.key.runKey, epoch: 1, budget: { attempts: 9, tokens: 1000 }, revision: 2,
  });
  const run = p.read().runs[p.main.key.runKey];
  assert.deepEqual([run.control, run.epoch, run.worktree], ['running', 1, p.dir]);
  // 088 adds `traceId` to the entry when telemetry is on (test/runtime/trace-ids.test.js pins it); this pin is the pre-088 shape.
  assert.deepEqual(run.history.map(({ traceId, ...rest }) => rest), [{ at: NOW.toISOString(), action: 'start', by: 'orchestrator', reason: null, epoch: 1 }]);
  assert.match(run.graphDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(run.graphTasks.length, 3);
  assert.deepEqual(unchanged(p, () => start({ ...p.common(), by: 'orchestrator' })),
    { disposition: 'refused', reason: 'run-exists', runKey: p.main.key.runKey });
  // The epoch start issued is the one a graph-plan claim needs.
  assert.equal(claim({ ...p.common(), task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, reserveTokens: 10 }).disposition, 'claimed');
});

test('start refuses a run a legacy claim created (epoch 0), and rejects bad flags as usage', (t) => {
  const p = project(t, planText({ header: false }));
  p.seed();
  assert.equal(claim({ ...p.common(), task: 'A.1', owner: 'core-implementer', mode: 'subagent' }).disposition, 'claimed');
  assert.equal(p.read().runs[p.main.key.runKey].epoch, 0);
  assert.equal(unchanged(p, () => start({ ...p.common(), by: 'orchestrator' })).reason, 'run-exists');
  const usage = (e) => e instanceof TaskAttemptError && e.code === 'usage';
  assert.throws(() => start({ ...p.common(), by: '' }), usage);
  assert.throws(() => start({ ...p.common(), by: 'x', budgetAttempts: 0 }), usage);
  assert.throws(() => start({ ...p.common(), by: 'x', budgetTokens: 1.5 }), usage);
});

// ── identity: solo and worker refused by every control ─────────────────────────────────────────

test('every control refuses a solo lineage and a worker session, writing nothing', (t) => {
  const p = project(t);
  const solo = p.as({ lineage: 'solo' });
  assert.equal(solo.key.identity.lineage, 'solo');
  const worker = p.as({ role: 'worker', lineage: 'w1' });
  assert.equal(worker.key.identity.role, 'worker');
  p.seed({ tasks: { 'A.1': { nextToken: 3, attempts: [attempt(1, { state: 'finished', result: 'COMPLETED' }), attempt(2, { runKey: solo.key.runKey })] } } });
  for (const [who, reason] of [[solo, 'identity-solo'], [worker, 'worker-session']]) {
    const c = p.common(who);
    for (const [name, run] of [
      ['start', () => start({ ...c, by: 'x' })],
      ['pause', () => pause({ ...c, by: 'x', reason: 'r' })],
      ['cancel run', () => cancel({ ...c, by: 'x', reason: 'r', adoptUnowned: true })],
      ['cancel attempt', () => cancel({ ...c, task: 'A.1', token: 2, by: 'x', reason: 'r' })],
      ['reopen', () => reopen({ ...c, task: 'A.1', token: 1, by: 'x', reason: 'r' })],
    ]) {
      assert.equal(unchanged(p, run).reason, reason, `${name} as ${reason}`);
    }
  }
});

// ── pause ────────────────────────────────────────────────────────────────────────────────────────

test('pause refuses claims, keeps an active attempt able to finish, and is control-unchanged twice', (t) => {
  const p = project(t);
  p.seed();
  start({ ...p.common(), by: 'orchestrator' });
  const claimed = claim({ ...p.common(), task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1 });
  const paused = pause({ ...p.common(), by: 'orchestrator', reason: 'lunch' });
  assert.deepEqual(paused, { disposition: 'paused', runKey: p.main.key.runKey, revision: paused.revision });
  assert.deepEqual(lastHistory(p), { at: NOW.toISOString(), action: 'pause', by: 'orchestrator', reason: 'lunch' });
  assert.equal(p.read().tasks['A.1'].attempts[0].state, 'active', 'pause leaves active attempts alone');
  assert.equal(unchanged(p, () => claim({ ...p.common(), task: 'A.2', owner: 'core-implementer', mode: 'subagent', epoch: 1 })).reason, 'run-paused');
  assert.deepEqual(unchanged(p, () => pause({ ...p.common(), by: 'orchestrator', reason: 'again' })),
    { disposition: 'refused', reason: 'control-unchanged', runKey: p.main.key.runKey, control: 'paused' });
  assert.equal(finish({ ...p.common(), task: 'A.1', token: claimed.token, result: 'BLOCKED' }).disposition, 'applied');
  assert.throws(() => pause({ ...p.common(), by: 'x' }), (e) => e instanceof TaskAttemptError && e.code === 'usage');
});

test('pause creates an absent run with epoch 0, and refuses a cancelled run', (t) => {
  const p = project(t, planText({ header: false }));
  p.seed();
  assert.equal(pause({ ...p.common(), by: 'orchestrator', reason: 'hold' }).disposition, 'paused');
  const run = p.read().runs[p.main.key.runKey];
  assert.deepEqual([run.control, run.epoch, run.history.length], ['paused', 0, 1]);
  assert.equal(cancel({ ...p.common(), by: 'orchestrator', reason: 'stop' }).disposition, 'cancelled', 'a paused run may be cancelled');
  assert.equal(unchanged(p, () => pause({ ...p.common(), by: 'orchestrator', reason: 'hold' })).reason, 'run-cancelled');
});

// ── run cancel ───────────────────────────────────────────────────────────────────────────────────

test("run cancel marks every active attempt of this run and leaves another run's and runKey-less ones", (t) => {
  const p = project(t);
  const other = p.as({ run: 'r2' });
  const mine = p.main.key.runKey;
  p.seed({
    runs: { [mine]: { ...createRun(p.main.key, null, NOW, { epoch: 1 }) } },
    tasks: {
      'A.1': { nextToken: 2, attempts: [attempt(1, { runKey: mine })] },
      'A.2': { nextToken: 2, attempts: [attempt(1, { runKey: other.key.runKey })] },
      'B.1': { nextToken: 3, attempts: [attempt(1, { state: 'finished', result: 'BLOCKED', runKey: mine }), attempt(2)] },
    },
  });
  const answer = cancel({ ...p.common(), by: 'orchestrator', reason: 'wrong plan' });
  assert.deepEqual(answer, {
    disposition: 'cancelled', runKey: mine,
    cancelled: [{ taskId: 'A.1', token: 1 }],
    adopted: [],
    notCancelled: [{ taskId: 'A.2', token: 1, runKey: other.key.runKey }, { taskId: 'B.1', token: 2, runKey: null }],
    revision: 2,
  });
  const store = p.read();
  assert.equal(store.tasks['A.1'].attempts[0].state, 'cancelled');
  assert.deepEqual(store.tasks['A.1'].attempts[0].cancel, { at: NOW.toISOString(), by: 'orchestrator', reason: 'wrong plan' });
  assert.equal(store.tasks['A.2'].attempts[0].state, 'active', "another run's attempt is untouched");
  assert.equal(store.tasks['B.1'].attempts[1].state, 'active', 'a runKey-less attempt is untouched without --adopt-unowned');
  assert.equal(store.tasks['B.1'].attempts[0].state, 'finished', 'only active attempts are cancelled');
  const run = store.runs[mine];
  assert.equal(run.control, 'cancelled');
  assert.deepEqual(run.history.at(-1), { at: NOW.toISOString(), action: 'cancel', by: 'orchestrator', reason: 'wrong plan', cancelled: [{ taskId: 'A.1', token: 1 }] });
  assert.equal(store.runs[other.key.runKey], undefined, 'no record is created for the other run');
  // The cancelled token is stale for its holder; a second cancel is control-unchanged.
  assert.equal(finish({ ...p.common(), task: 'A.1', token: 1, result: 'BLOCKED' }).reason, 'attempt-cancelled');
  assert.deepEqual(unchanged(p, () => cancel({ ...p.common(), by: 'orchestrator', reason: 'again' })),
    { disposition: 'refused', reason: 'control-unchanged', runKey: mine, control: 'cancelled' });
  assert.equal(unchanged(p, () => claim({ ...p.common(), task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1 })).reason, 'run-cancelled');
});

test('--adopt-unowned gives runKey-less active attempts this run and cancels them as adopted', (t) => {
  const p = project(t, planText({ header: false }));
  const other = p.as({ run: 'r2' });
  const mine = p.main.key.runKey;
  p.seed({
    tasks: {
      'A.1': { nextToken: 2, attempts: [attempt(1)] },
      'A.2': { nextToken: 2, attempts: [attempt(1, { runKey: other.key.runKey })] },
    },
  });
  const answer = cancel({ ...p.common(), by: 'orchestrator', reason: 'legacy cleanup', adoptUnowned: true });
  assert.deepEqual(answer, {
    disposition: 'cancelled', runKey: mine,
    cancelled: [{ taskId: 'A.1', token: 1 }],
    adopted: [{ taskId: 'A.1', token: 1 }],
    notCancelled: [{ taskId: 'A.2', token: 1, runKey: other.key.runKey }],
    revision: 2,
  });
  const a = p.read().tasks['A.1'].attempts[0];
  assert.deepEqual([a.state, a.runKey], ['cancelled', mine]);
  assert.deepEqual(a.cancel, { at: NOW.toISOString(), by: 'orchestrator', reason: 'legacy cleanup', adopted: true });
  const run = p.read().runs[mine];
  assert.deepEqual([run.control, run.epoch], ['cancelled', 0]);
  assert.deepEqual(run.totals.attempts, 1, 'the adopted attempt now counts toward this run');
  assert.throws(() => cancel({ ...p.common(), task: 'A.1', token: 1, by: 'x', reason: 'r', adoptUnowned: true }),
    (e) => e instanceof TaskAttemptError && e.code === 'usage');
});

// ── attempt cancel ───────────────────────────────────────────────────────────────────────────────

test('attempt cancel marks one attempt, leaves control unchanged, and refuses a foreign run', (t) => {
  const p = project(t);
  const other = p.as({ run: 'r2' });
  const mine = p.main.key.runKey;
  p.seed({
    runs: { [mine]: createRun(p.main.key, null, NOW, { epoch: 1 }) },
    tasks: {
      'A.1': { nextToken: 2, attempts: [attempt(1, { runKey: mine })] },
      'A.2': { nextToken: 3, attempts: [attempt(2, { runKey: mine })] },
      'B.1': { nextToken: 2, attempts: [attempt(1, { runKey: other.key.runKey })] },
    },
  });
  const c = p.common();
  assert.deepEqual(cancel({ ...c, task: 'A.1', token: 1, by: 'orchestrator', reason: 'stuck' }), {
    disposition: 'cancelled', runKey: mine, taskId: 'A.1', token: 1, control: 'running',
    cancelled: [{ taskId: 'A.1', token: 1 }], revision: 2,
  });
  const store = p.read();
  assert.deepEqual([store.tasks['A.1'].attempts[0].state, store.tasks['A.2'].attempts[0].state], ['cancelled', 'active']);
  assert.equal(store.runs[mine].control, 'running');
  assert.deepEqual(lastHistory(p), { at: NOW.toISOString(), action: 'cancel', by: 'orchestrator', reason: 'stuck', cancelled: [{ taskId: 'A.1', token: 1 }] });
  assert.deepEqual(unchanged(p, () => cancel({ ...c, task: 'A.1', token: 1, by: 'o', reason: 'r' })),
    { disposition: 'refused', reason: 'no-active-attempt', runKey: mine, taskId: 'A.1', token: 1 });
  assert.deepEqual(unchanged(p, () => cancel({ ...c, task: 'A.2', token: 1, by: 'o', reason: 'r' })),
    { disposition: 'refused', reason: 'token-mismatch', runKey: mine, taskId: 'A.2', token: 1, activeToken: 2 });
  assert.deepEqual(unchanged(p, () => cancel({ ...c, task: 'B.1', token: 1, by: 'o', reason: 'r' })),
    { disposition: 'refused', reason: 'foreign-run', taskId: 'B.1', token: 1, runKey: other.key.runKey });
  // The cancelled task is CANCELLED until a resume clears it (IC-005 row 4).
  assert.equal(status(c).tasks.find((x) => x.id === 'A.1').state, 'CANCELLED');
});

// ── reopen ───────────────────────────────────────────────────────────────────────────────────────

test('reopen supersedes the done attempt, counts toward the budget and names active dependents', (t) => {
  const p = project(t, planText({ header: false }));
  const mine = p.main.key.runKey;
  // A.1 done by a pre-080 attempt (no runKey, so not yet counted); B.1 depends on phase A.
  p.seed({
    tasks: {
      'A.1': { nextToken: 2, attempts: [attempt(1, { state: 'finished', result: 'COMPLETED' })] },
      'B.1': { nextToken: 2, attempts: [attempt(1, { runKey: mine })] },
    },
  });
  const c = p.common();
  const before = status(c).tasks.find((x) => x.id === 'A.1');
  assert.deepEqual([before.state, before.budget.used], ['SUCCEEDED', 0]);
  assert.deepEqual(reopen({ ...c, task: 'A.1', token: 1, by: 'reviewer', reason: 'acceptance missed' }), {
    disposition: 'reopened', taskId: 'A.1', token: 1, dependentsActive: [{ taskId: 'B.1', token: 1 }],
  });
  const a = p.read().tasks['A.1'].attempts[0];
  assert.equal(a.state, 'superseded');
  assert.deepEqual(a.reopen, { at: NOW.toISOString(), by: 'reviewer', reason: 'acceptance missed', runKey: mine });
  assert.deepEqual(lastHistory(p), { at: NOW.toISOString(), action: 'reopen', by: 'reviewer', reason: 'acceptance missed', taskId: 'A.1', token: 1 });
  const after = status(c).tasks.find((x) => x.id === 'A.1');
  assert.deepEqual([after.state, after.reason, after.budget.used], ['READY', 'reopened', 1]);
  assert.equal(unchanged(p, () => reopen({ ...c, task: 'A.1', token: 1, by: 'r', reason: 'again' })).reason, 'not-done');
  assert.throws(() => reopen({ ...c, task: 'A.1', token: 1, by: 'r' }), (e) => e instanceof TaskAttemptError && e.code === 'usage');
});

test('reopen refuses an unknown task, the wrong token, and a cancelled run', (t) => {
  const p = project(t);
  const mine = p.main.key.runKey;
  p.seed({
    runs: { [mine]: createRun(p.main.key, null, NOW, { epoch: 1 }) },
    tasks: { 'A.1': { nextToken: 3, attempts: [attempt(1, { state: 'released' }), attempt(2, { state: 'finished', result: 'COMPLETED', runKey: mine })] } },
  });
  const c = p.common();
  assert.equal(unchanged(p, () => reopen({ ...c, task: 'Z.9', token: 1, by: 'r', reason: 'x' })).reason, 'unknown-task');
  assert.deepEqual(unchanged(p, () => reopen({ ...c, task: 'A.1', token: 1, by: 'r', reason: 'x' })),
    { disposition: 'refused', taskId: 'A.1', token: 1, reason: 'token-mismatch', doneToken: 2 });
  assert.equal(cancel({ ...c, by: 'o', reason: 'stop' }).disposition, 'cancelled');
  assert.deepEqual(unchanged(p, () => reopen({ ...c, task: 'A.1', token: 2, by: 'r', reason: 'x' })),
    { disposition: 'refused', taskId: 'A.1', token: 2, reason: 'run-cancelled', runKey: mine });
});

// ── the apply functions are pure over the store ─────────────────────────────────────────────────

test('the task-run apply functions return { write, result } and touch only the store given', () => {
  const env = identityEnv('/nonexistent-doflow-c3');
  const key = runKeyFor(env, '/nonexistent-doflow-c3');
  const graph = { tasks: [], order: [] };
  const store = { version: 1, revision: 1, planPath: null, tasks: {} };
  const started = startRun(store, { key, graph, by: 'o', budget: null, now: NOW });
  assert.equal(started.write, true);
  assert.equal(store.runs[key.runKey].graphDigest, graphDigest(graph));
  assert.equal(pauseRun(store, { key, graph, by: 'o', reason: 'r', now: NOW }).result.disposition, 'paused');
  assert.equal(cancelAttempt(store, { key, graph, task: 'A.1', token: 1, by: 'o', reason: 'r', now: NOW }).write, false);
  assert.equal(cancelRun(store, { key, graph, by: 'o', reason: 'r', now: NOW }).result.disposition, 'cancelled');
  assert.deepEqual(store.runs[key.runKey].history.map((h) => h.action), ['start', 'pause', 'cancel']);
});
