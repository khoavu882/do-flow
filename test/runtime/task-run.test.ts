'use strict';
// task-run.test.js — `task-run.ts`: run key, solo and worker refusals, run record, totals, the
// aggregate check and the epoch (feature 080, C.1; IC-009, IC-011, IC-025, IC-026, DEC-003,
// DEC-006, DEC-007, DEC-011).
//
// In-process: `runKeyFor` is the only probe; every other function is pure over a hand-built store.
// Each identity environment is set explicitly, so the developer's shell never decides a run key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const {
  runKeyFor: runKeyForNative, refuseSolo, refuseWorker, createRun, computeTotals, effectiveLimits,
  aggregateRefusal, controlRefusal, epochRefusal, nextEpoch,
} = require('../../src/runtime/task-run.ts');
const { DEFAULT_TASK_ATTEMPTS } = require('../../src/runtime/task-graph.ts');

// context/identity.ts:97 honours DOFLOW_WORKTREE only when it starts with '/', so a Windows drive path is ignored and the
// payload cwd decides. On win32 these tests hand the same worktree as that payload cwd instead of the placeholder '/'.
const runKeyFor = (env: any, cwd: string) => runKeyForNative(env,
  process.platform === 'win32' && cwd === '/' && env.DOFLOW_WORKTREE ? env.DOFLOW_WORKTREE : cwd);

function env(worktree: any, { run = 'r1', lineage = 'main', role = 'main' }: any = {}) {
  return {
    DOFLOW_RUN_ID: run, DOFLOW_LINEAGE_ID: lineage, DOFLOW_SESSION_ROLE: role, DOFLOW_ROLE: role,
    DOFLOW_WORKTREE: worktree, HOME: worktree,
  };
}

function worktree(t: any, name: any) {
  const top = path.join(tempDir(t, 'doflow-task-run-'), name);
  fs.mkdirSync(path.join(top, '.git'), { recursive: true });
  fs.mkdirSync(path.join(top, 'src', 'deep'), { recursive: true });
  return top;
}

function attempt(token: any, state: any, extra: any = {}) {
  return { token, owner: 'core-implementer', mode: 'subagent', startedAt: '2026-01-01T00:00:00.000Z',
    taskLineHash: 'h', state, result: state === 'finished' ? 'COMPLETED' : null, evidenceId: null, reason: null, ...extra };
}

const KEY = 'k/r1/main';
const graph = (n: any, budget: any = null) => ({ tasks: Array.from({ length: n }, (_, i) => ({ id: `A.${i + 1}`, budget })) });
const run = (budget: any) => ({ control: 'running', epoch: 1, budget });

test('run key: a subdirectory of a worktree reaches the same run as its top', (t) => {
  const top = worktree(t, 'wt');
  const a = runKeyFor(env(top), '/');
  const b = runKeyFor(env(path.join(top, 'src', 'deep')), '/');
  assert.equal(a.runKey, b.runKey);
  assert.equal(b.top, top);
  assert.equal(b.identity.worktree, path.join(top, 'src', 'deep'));
  assert.match(a.runKey, /^[0-9a-f]{16}\/r1\/main$/);
});

test('run key: the payload cwd is used when DOFLOW_WORKTREE is unset, still keyed by the top', (t) => {
  const top = worktree(t, 'wt');
  const e = env(top); delete e.DOFLOW_WORKTREE;
  assert.equal(runKeyFor(e, path.join(top, 'src')).runKey, runKeyFor(env(top), '/').runKey);
});

test('run key: two worktrees and two lineages give different keys', (t) => {
  const one = worktree(t, 'one');
  const two = worktree(t, 'two');
  const keys: any = new Set([
    runKeyFor(env(one), '/').runKey,
    runKeyFor(env(two), '/').runKey,
    runKeyFor(env(one, { lineage: 'L2' }), '/').runKey,
  ]);
  assert.equal(keys.size, 3);
});

test('solo and worker callers are refused', (t) => {
  const top = worktree(t, 'wt');
  const solo = runKeyFor(env(top, { role: 'worker', lineage: '' }), '/').identity;
  assert.equal(solo.lineage, 'solo');
  assert.deepEqual(refuseSolo(solo), { reason: 'identity-solo' });
  const worker = runKeyFor(env(top, { role: 'worker', lineage: 'w1' }), '/').identity;
  assert.deepEqual(refuseWorker(worker), { reason: 'worker-session' });
  assert.equal(refuseSolo(worker), null);
  const main = runKeyFor(env(top), '/').identity;
  assert.equal(refuseSolo(main), null);
  assert.equal(refuseWorker(main), null);
});

test('createRun: a running record keyed by the top, epoch 1 unless given', (t) => {
  const top = worktree(t, 'wt');
  const key = runKeyFor(env(path.join(top, 'src')), '/');
  const now: any = new Date('2026-02-03T04:05:06.000Z');
  const rec = createRun(key, { tokens: 1000 }, now);
  assert.deepEqual(rec, {
    runKey: key.runKey, worktreeKey: key.runKey.split('/')[0], run: 'r1', lineage: 'main', worktree: top,
    createdAt: now.toISOString(), control: 'running', epoch: 1,
    budget: { attempts: null, tokens: 1000 },
    totals: { attempts: 0, tokens: { measured: 0, estimated: 0, reserved: 0 }, unreported: 0 },
    graphDigest: null, graphTasks: null, history: [],
  });
  assert.equal(createRun(key, null, now, { epoch: 0 }).epoch, 0);
  assert.throws(() => createRun(key, null, now, { epoch: -1 }), TypeError);
});

test('totals: by basis, a cancelled reservation is estimated, unreported counted, other runs ignored', () => {
  const store: any = { tasks: {
    'A.1': { nextToken: 5, attempts: [
      attempt(1, 'finished', { runKey: KEY, usage: { tokens: 100, basis: 'measured', reporter: 'main:main' } }),
      attempt(2, 'finished', { runKey: KEY, usage: { tokens: 40, basis: 'estimated', reporter: 'worker:w1' } }),
      attempt(3, 'cancelled', { runKey: KEY, reserve: { tokens: 30 } }),
      attempt(4, 'active', { runKey: KEY, reserve: { tokens: 50 } }),
    ] },
    'A.2': { nextToken: 4, attempts: [
      attempt(1, 'finished', { runKey: KEY, usage: null }),
      attempt(2, 'released', { runKey: KEY }),
      attempt(3, 'finished', { runKey: 'other/r1/main', usage: { tokens: 999, basis: 'measured', reporter: 'x' } }),
    ] },
    'A.3': { nextToken: 2, attempts: [attempt(1, 'finished')] },
  } };
  assert.deepEqual(computeTotals(store, KEY), {
    attempts: 6, tokens: { measured: 100, estimated: 70, reserved: 50 }, unreported: 2,
  });
  assert.deepEqual(computeTotals({ version: 1, tasks: {} }, KEY).tokens, { measured: 0, estimated: 0, reserved: 0 });
});

test('totals: a reported 0 is accounted, not unreported', () => {
  const store: any = { tasks: { 'A.1': { attempts: [attempt(1, 'finished', { runKey: KEY, usage: { tokens: 0, basis: 'measured', reporter: 'main:main' } })] } } };
  const totals = computeTotals(store, KEY);
  assert.equal(totals.unreported, 0);
  assert.equal(aggregateRefusal(run({ attempts: null, tokens: 100 }), totals, graph(1), 10), null);
});

test('effective limits: own budget, else the sum of task limits; tokens none by default', () => {
  assert.deepEqual(effectiveLimits(run({ attempts: null, tokens: null }), graph(3)), { attempts: 3 * DEFAULT_TASK_ATTEMPTS, tokens: null });
  assert.deepEqual(effectiveLimits(run({ attempts: null, tokens: null }), graph(2, { attempts: 4 })), { attempts: 8, tokens: null });
  assert.deepEqual(effectiveLimits(run({ attempts: 5, tokens: 10 }), graph(3)), { attempts: 5, tokens: 10 });
  assert.deepEqual(effectiveLimits(null, graph(1)), { attempts: DEFAULT_TASK_ATTEMPTS, tokens: null });
});

test('aggregate: reservation-required, then aggregate-unaccounted, then tokens, then attempts', () => {
  const tokenRun = run({ attempts: 2, tokens: 100 });
  const g = graph(1);
  const totals = (over: any = {}) => ({ attempts: 0, tokens: { measured: 0, estimated: 0, reserved: 0 }, unreported: 0, ...over });

  // Every condition fails at once: the first in IC-009's order answers.
  const all = totals({ attempts: 2, tokens: { measured: 80, estimated: 10, reserved: 5 }, unreported: 1 });
  assert.deepEqual(aggregateRefusal(tokenRun, all, g, undefined), { reason: 'reservation-required', limit: 100 });
  assert.deepEqual(aggregateRefusal(tokenRun, all, g, 0), { reason: 'reservation-required', limit: 100 });
  assert.deepEqual(aggregateRefusal(tokenRun, all, g, 10), { reason: 'aggregate-unaccounted', unreported: 1 });
  assert.deepEqual(aggregateRefusal(tokenRun, { ...all, unreported: 0 }, g, 10), {
    reason: 'aggregate-exhausted', scope: 'run', measure: 'tokens', limit: 100,
    used: 90, reserved: 5, basis: { measured: 80, estimated: 10 },
  });
  assert.deepEqual(aggregateRefusal(tokenRun, { ...all, unreported: 0, tokens: { measured: 80, estimated: 10, reserved: 0 } }, g, 10), {
    reason: 'aggregate-exhausted', scope: 'run', measure: 'attempts', limit: 2, used: 2, reserved: 0, basis: null,
  });
  // Exactly at the token limit is admitted.
  assert.equal(aggregateRefusal(tokenRun, totals({ attempts: 1, tokens: { measured: 80, estimated: 10, reserved: 0 } }), g, 10), null);
});

test('aggregate: without a token limit nothing about tokens refuses; attempts still do', () => {
  const noTokens = run({ attempts: null, tokens: null });
  const t: any = { attempts: 0, tokens: { measured: 1e9, estimated: 0, reserved: 0 }, unreported: 7 };
  assert.equal(aggregateRefusal(noTokens, t, graph(1), undefined), null);
  assert.equal(aggregateRefusal(null, t, graph(1), undefined), null);
  assert.equal(aggregateRefusal(noTokens, { ...t, attempts: DEFAULT_TASK_ATTEMPTS }, graph(1), undefined).measure, 'attempts');
});

test('control: paused and cancelled runs refuse claims; running and absent do not', () => {
  assert.deepEqual(controlRefusal({ control: 'paused' }, KEY), { reason: 'run-paused', runKey: KEY });
  assert.deepEqual(controlRefusal({ control: 'cancelled' }, KEY), { reason: 'run-cancelled', runKey: KEY });
  assert.equal(controlRefusal({ control: 'running' }, KEY), null);
  assert.equal(controlRefusal(undefined, KEY), null);
});

test('epoch: no run, no epoch, an old or a future epoch are resume-required; the current one passes', () => {
  const r: any = { control: 'running', epoch: 3 };
  assert.deepEqual(epochRefusal(undefined, KEY, 1), { reason: 'resume-required', runKey: KEY, epoch: null });
  assert.deepEqual(epochRefusal(r, KEY, undefined), { reason: 'resume-required', runKey: KEY, epoch: 3 });
  assert.deepEqual(epochRefusal(r, KEY, 2), { reason: 'resume-required', runKey: KEY, epoch: 3 });
  assert.deepEqual(epochRefusal(r, KEY, 4), { reason: 'resume-required', runKey: KEY, epoch: 3 });
  assert.equal(epochRefusal(r, KEY, 3), null);
  assert.equal(nextEpoch(r), 4);
  assert.equal(nextEpoch(undefined), 1);
});

test('the store is not changed by any pure function', () => {
  const store: any = { tasks: { 'A.1': { attempts: [attempt(1, 'active', { runKey: KEY, reserve: { tokens: 5 } })] } } };
  const before = JSON.stringify(store);
  const r = run({ attempts: null, tokens: 10 });
  const rBefore = JSON.stringify(r);
  aggregateRefusal(r, computeTotals(store, KEY), graph(1), 1);
  effectiveLimits(r, graph(1));
  controlRefusal(r, KEY); epochRefusal(r, KEY, 1); nextEpoch(r);
  assert.equal(JSON.stringify(store), before);
  assert.equal(JSON.stringify(r), rBefore);
});
