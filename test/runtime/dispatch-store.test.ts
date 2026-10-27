'use strict';

// Feature 082 A.4 (IC-006, IC-009 phase table, IC-036; DEC-018, DEC-037, DEC-045): the dispatch
// store. A `write: false` decision and a refused transition leave the file's bytes as they were; an
// ended dispatch is add-only; a torn or future-version file is `store-unreadable` and left as it
// was; the step log keeps the newest 500; and two processes moving one dispatch from `admitted` to
// `claimed` at once through test/helper/race-barrier.js yield one applied transition.
//
// This file is also the race worker's module. race-barrier.js requires the module it is given and
// calls one of its fixed operation names, so when required with `--race-worker` the file exports
// `claim` as the transition under test and registers no tests.

const path = require('node:path');

if (process.argv[2] === '--race-worker') {
  const { transitionDispatch } = require('../../src/runtime/dispatch/store.ts');
  module.exports = {
    claim: ({ file, dispatchId, fsImpl }: any) => transitionDispatch(file, dispatchId, ['admitted'], (d: any) => {
      d.phase = 'claimed';
      d.token = 1;
      d.claimedBy = { pid: process.pid, start: null };
    }, fsImpl),
  };
} else {

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tempDir } = require('../helper/tmp.ts');
const { startWorkers } = require('../helper/race-barrier.ts');
const {
  storeFileFor, newDispatchRunId, newDispatchId, readDispatch, mutateDispatch, transitionDispatch,
  PHASES, STEP_LIMIT, DISPATCH_RUN_ID, DISPATCH_ID,
} = require('../../src/runtime/dispatch/store.ts');

const SLUG = '082-dispatch-store';
const REPS = 50;

function storeIn(t: any) {
  return storeFileFor(tempDir(t, 'doflow-dispatch-store-'), SLUG);
}

/** Adds one admitted dispatch and returns its id. */
function admit(file: any, overrides: any = {}) {
  const dispatchId = newDispatchId();
  mutateDispatch(file, (store: any) => {
    store.dispatches[dispatchId] = {
      dispatchId, dispatchRunId: 'p-000000000001', parentRunKey: 'k/local/main', task: 'A.4',
      token: null, epoch: 1, phase: 'admitted', mode: 'subagent', harness: 'claude', workerRunId: null,
      disposition: null, failureClass: null, admittedAt: '2026-10-16T00:00:00.000Z', ...overrides,
    };
    return { write: true, result: null };
  });
  return dispatchId;
}

/** Moves a dispatch through every phase to `ended` with a `failed` disposition. */
function endIt(file: any, id: any) {
  const steps: any = [
    [['admitted'], (d: any) => { d.phase = 'claimed'; d.token = 1; }],
    [['claimed'], (d: any) => { d.phase = 'launched'; d.workerRunId = 'w-000000000001'; }],
    [['launched'], (d: any) => { d.phase = 'ended'; d.disposition = 'failed'; d.failureClass = 'worker-failure'; d.endedAt = 'x'; }],
  ];
  for (const [allowed, apply] of steps) assert.equal(transitionDispatch(file, id, allowed, apply).applied, true);
}

test('storeFileFor, ids and phases follow IC-006, DEC-037 and IC-009', (t) => {
  const root = tempDir(t, 'doflow-dispatch-store-');
  assert.equal(storeFileFor(root, SLUG), path.join(root, '.doflow', 'state', 'dispatch', `${SLUG}.json`));
  assert.throws(() => storeFileFor(root, '../escape'), { code: 'usage' });
  const runIds: any = new Set(Array.from({ length: 50 }, newDispatchRunId));
  const ids: any = new Set(Array.from({ length: 50 }, newDispatchId));
  assert.equal(runIds.size, 50);
  assert.equal(ids.size, 50);
  for (const id of runIds) assert.match(id, /^p-[0-9a-f]{12}$/);
  for (const id of ids) assert.match(id, /^d-[0-9a-f]{12}$/);
  assert.match(newDispatchRunId(), DISPATCH_RUN_ID);
  assert.match(newDispatchId(), DISPATCH_ID);
  assert.deepEqual(PHASES, ['admitted', 'claimed', 'launched', 'collected', 'integrating', 'ended']);
});

test('an absent store reads empty, and the first write stamps version 1', (t) => {
  const file = storeIn(t);
  assert.deepEqual(readDispatch(file), {
    slug: SLUG, run: null, dispatches: {}, drivers: [], lease: null, spawnRequests: {}, steps: [],
  });
  const id = admit(file);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.revision, 1);
  assert.equal(onDisk.slug, SLUG);
  assert.equal(onDisk.dispatches[id].seq, 0);
  assert.equal(onDisk.dispatches[id].phase, 'admitted');
});

test('a write: false decision leaves the file bytes unchanged and returns the result', (t) => {
  const file = storeIn(t);
  admit(file);
  const before = fs.readFileSync(file);
  const result = mutateDispatch(file, (store: any) => {
    store.run = { state: 'running' };
    return { write: false, result: { refused: 'no' } };
  });
  assert.deepEqual(result, { refused: 'no' });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a transition from a phase outside allowedPhases is refused with no write', (t) => {
  const file = storeIn(t);
  const id = admit(file);
  const before = fs.readFileSync(file);
  let called = false;
  const refused = transitionDispatch(file, id, ['claimed', 'launched'], () => { called = true; });
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, 'phase-not-allowed');
  assert.equal(refused.phase, 'admitted');
  assert.equal(refused.dispatch.seq, 0);
  assert.equal(called, false);
  assert.deepEqual(fs.readFileSync(file), before);

  const unknown = transitionDispatch(file, 'd-000000000000', ['admitted'], () => { called = true; });
  assert.deepEqual(unknown, { applied: false, reason: 'unknown-dispatch', dispatchId: 'd-000000000000' });
  assert.equal(called, false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('seq increments once per applied transition, and phases move only along IC-009', (t) => {
  const file = storeIn(t);
  const id = admit(file);
  const claimed = transitionDispatch(file, id, ['admitted'], (d: any) => { d.phase = 'claimed'; d.token = 1; });
  assert.equal(claimed.applied, true);
  assert.equal(claimed.dispatch.seq, 1);
  assert.equal(transitionDispatch(file, id, ['claimed'], () => {}).dispatch.seq, 2);
  assert.throws(() => transitionDispatch(file, id, ['claimed'], (d: any) => { d.phase = 'integrating'; }), { code: 'usage' });
  assert.throws(() => transitionDispatch(file, id, ['claimed'], (d: any) => { d.task = 'B.1'; }), { code: 'usage' });
  assert.equal(readDispatch(file).dispatches[id].seq, 2);
  // Only an admitted slot may be dropped, and a new dispatch must start admitted.
  assert.throws(() => mutateDispatch(file, (store: any) => { delete store.dispatches[id]; return { write: true, result: null }; }), { code: 'usage' });
  const dropped = admit(file, { task: 'A.5' });
  mutateDispatch(file, (store: any) => { delete store.dispatches[dropped]; return { write: true, result: null }; });
  assert.equal(readDispatch(file).dispatches[dropped], undefined);
  assert.throws(() => admit(file, { task: 'A.6', phase: 'claimed' }), { code: 'usage' });
  // (task, token) is unique.
  const other = admit(file);
  assert.throws(() => transitionDispatch(file, other, ['admitted'], (d: any) => { d.phase = 'claimed'; d.token = 1; }), { code: 'usage' });
  assert.equal(transitionDispatch(file, other, ['admitted'], (d: any) => { d.phase = 'claimed'; d.token = 2; }).applied, true);
});

test('an ended dispatch is add-only: removal may be added and promoted, disposition never changes', (t) => {
  const file = storeIn(t);
  const id = admit(file);
  endIt(file, id);

  const removal: any = { path: '/x', branch: 'b', pathGone: false, branchGone: true, unregistered: true, verified: false, errors: ['128'] };
  const added = transitionDispatch(file, id, ['ended'], (d: any) => { d.removal = removal; });
  assert.equal(added.applied, true);
  assert.deepEqual(added.dispatch.removal, removal);

  const promoted: any = { ...removal, pathGone: true, verified: true, errors: [] };
  assert.equal(transitionDispatch(file, id, ['ended'], (d: any) => { d.removal = promoted; }).applied, true);

  const before = fs.readFileSync(file);
  const back = transitionDispatch(file, id, ['ended'], (d: any) => { d.removal = { ...promoted, verified: false }; });
  assert.equal(back.applied, false);
  assert.equal(back.reason, 'ended-add-only');
  assert.equal(back.field, 'removal');
  assert.deepEqual(back.dispatch.removal, promoted);

  const disposition = transitionDispatch(file, id, ['ended'], (d: any) => { d.disposition = 'completed'; });
  assert.equal(disposition.applied, false);
  assert.equal(disposition.reason, 'ended-add-only');
  assert.equal(disposition.field, 'disposition');
  assert.deepEqual(fs.readFileSync(file), before);

  assert.throws(() => mutateDispatch(file, (store: any) => { store.dispatches[id].failureClass = null; return { write: true, result: null }; }), { code: 'usage' });
  assert.deepEqual(fs.readFileSync(file), before);

  assert.equal(transitionDispatch(file, id, ['ended'], (d: any) => { d.usageLate = { tokens: 3, basis: 'measured' }; }).applied, true);
  const stored = readDispatch(file).dispatches[id];
  assert.equal(stored.disposition, 'failed');
  assert.equal(stored.failureClass, 'worker-failure');
  assert.deepEqual(stored.usageLate, { tokens: 3, basis: 'measured' });
});

for (const [name, text] of [
  ['a torn file', '{"slug": "082-dispatch-store", "dispatches": {'],
  ['a version 2 file', JSON.stringify({ slug: SLUG, version: 2, revision: 1, run: null, dispatches: {}, drivers: [], lease: null, spawnRequests: {}, steps: [] })],
]) {
  test(`${name} is store-unreadable and unchanged`, (t) => {
    const file = storeIn(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const before = fs.readFileSync(file);
    assert.throws(() => readDispatch(file), { code: 'store-unreadable' });
    assert.throws(() => mutateDispatch(file, () => ({ write: true, result: null })), { code: 'store-unreadable' });
    assert.throws(() => transitionDispatch(file, 'd-000000000000', ['admitted'], () => {}), { code: 'store-unreadable' });
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  });
}

test('the step log keeps the newest 500: the 501st step drops the oldest', (t) => {
  const file = storeIn(t);
  const append = (n: any) => mutateDispatch(file, (store: any) => {
    store.steps.push({ step: n, at: 'x', driver: { pid: 1, start: null }, outcome: 'continue', actions: [] });
    return { write: true, result: null };
  });
  for (let n = 1; n <= STEP_LIMIT; n += 1) append(n);
  assert.equal(readDispatch(file).steps.length, 500);
  assert.equal(readDispatch(file).steps[0].step, 1);
  append(501);
  const steps = readDispatch(file).steps;
  assert.equal(steps.length, 500);
  assert.equal(steps[0].step, 2);
  assert.equal(steps[499].step, 501);
});

test('two processes moving one dispatch from admitted to claimed yield one applied transition', { skip: process.platform === 'win32' ? 'tree cleanup is unverified on win32 (NFR-005)' : false }, async (t) => {
  const dir = tempDir(t, 'doflow-dispatch-store-race-');
  const file = storeFileFor(dir, SLUG);
  // The workers run only this module; their PATH is an empty scratch bin, never the node directory
  // (DEC-056). race-barrier.js passes the parent's PATH, so it is set for the spawn and restored.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const savedPath = process.env.PATH;
  process.env.PATH = bin;
  let workers;
  try {
    workers = startWorkers({
      count: 2,
      modulePath: __filename,
      barrierDir: dir,
      envFor: () => ({
        DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'main',
        DOFLOW_WORKTREE: dir, HOME: dir,
      }),
    });
  } finally {
    process.env.PATH = savedPath;
  }
  const { race, stop } = workers;
  t.after(stop);
  for (let rep = 0; rep < REPS; rep += 1) {
    fs.rmSync(file, { force: true });
    const id = admit(file);
    const answers = await race([0, 1].map((i) => ({ op: 'claim', args: { file, dispatchId: id }, skewUs: i === rep % 2 ? rep : 0 })));
    for (const answer of answers) assert.equal(answer.error, undefined, `repetition ${rep}: ${JSON.stringify(answer.error)}`);
    const applied = answers.filter((a: any) => a.result.applied);
    const refused = answers.filter((a: any) => !a.result.applied);
    assert.equal(applied.length, 1, `repetition ${rep}: ${JSON.stringify(answers)}`);
    assert.equal(refused[0].result.reason, 'phase-not-allowed');
    assert.equal(refused[0].result.phase, 'claimed');
    const stored = readDispatch(file).dispatches[id];
    assert.equal(stored.phase, 'claimed');
    assert.equal(stored.seq, 1, `repetition ${rep}`);
  }
});

// RT-2: one run-state setter. A held state (a cancel's, a lost driver's, a completion) is moved only
// by its owner; every other writer leaves it, returning false.
test('RT-2: setRunState keeps cancelling, cancelled, completed and resume-required against every writer but their owner', () => {
  const { setRunState } = require('../../src/runtime/dispatch/store.ts');
  assert.equal(typeof setRunState, 'function', 'store.ts exports the one run-state setter');
  const at = (state: any) => ({ run: { state } });
  for (const held of ['cancelling', 'cancelled', 'completed', 'resume-required']) {
    for (const next of ['blocked', 'running', 'completed', 'resume-required']) {
      if (next === held) continue;
      const s = at(held);
      assert.equal(setRunState(s, next), false, `${held} -> ${next}`);
      assert.equal(s.run.state, held, `${held} is kept against ${next}`);
    }
  }
  // The owners.
  for (const from of ['running', 'blocked', 'resume-required', 'cancelling']) {
    const s = at(from);
    assert.equal(setRunState(s, 'cancelling', 'cancel'), true, from);
    assert.equal(s.run.state, 'cancelling');
    assert.equal(setRunState(s, 'cancelled', 'cancel'), true);
    assert.equal(s.run.state, 'cancelled');
  }
  for (const ended of ['completed', 'cancelled']) {
    const s = at(ended);
    assert.equal(setRunState(s, 'cancelling', 'cancel'), false, `a cancel never reopens a ${ended} run`);
    assert.equal(s.run.state, ended);
  }
  for (const next of ['running', 'blocked']) {
    const s = at('resume-required');
    assert.equal(setRunState(s, next, 'resume'), true);
    assert.equal(s.run.state, next);
  }
  const cancelling = at('cancelling');
  assert.equal(setRunState(cancelling, 'running', 'resume'), false, 'a resume never clears a cancel');
  // Unheld states move freely.
  const s = at('running');
  assert.equal(setRunState(s, 'blocked'), true);
  assert.equal(setRunState(s, 'resume-required'), true);
  assert.equal(s.run.state, 'resume-required');
});
}
