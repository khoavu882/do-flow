'use strict';

// Feature 082 B.3 (IC-024, IC-008 usage; DEC-007, DEC-026, DEC-039, DEC-053): the attempt-end rule
// over a real 080 ledger. Every end runs inside a `mutateDispatch` decide callback, as the loop and
// integration call it. No process is spawned: the 080 calls are in-process.
//
// The plan is written into each test's temp repo. It mirrors A.7's
// `test/fixtures/dispatch/plans/budget.md` (one task with an attempt budget of 2), which is not in
// this worktree; the cases needing three attempts write the same task with a larger budget.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { claim, start, status } = require('../../src/runtime/task-attempts.ts');
const store = require('../../src/runtime/dispatch/store.ts');
const {
  FAILURE_CLASSES, classFor, usageFor, endAttempt, completeAttempt, releaseAttempt,
} = require('../../src/runtime/dispatch/attempt-end.ts');

const SLUG = 'feat-end';

function planText(attempts) {
  return [
    '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
    `- [ ] A.1 only task — owner: core-implementer; files: a.js; budget: attempts=${attempts}`, '',
  ].join('\n');
}

function project(t, { attempts: budget = 2 } = {}) {
  const dir = tempDir(t, 'doflow-attempt-end-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, planText(budget));
  const ledgerFile = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  // The five identity variables, set or absent explicitly (DEC-042).
  const env = {
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_WORKTREE: dir,
    DOFLOW_ROLE: 'main', HOME: dir,
  };
  delete env.DOFLOW_ATTEMPT;
  const now = new Date('2026-10-16T00:00:00.000Z');
  const common = { file: ledgerFile, fsImpl: fs, roots: [dir], slug: SLUG, env, cwd: dir, now };
  assert.equal(start({ ...common, by: 'main' }).disposition, 'started');
  const ctx = { ledgerFile, fsImpl: fs, roots: [dir], slug: SLUG, env, cwd: dir, now };
  const dispatchFile = store.storeFileFor(dir, SLUG);

  /** An admitted dispatch claimed through 080 and moved to `claimed` with its token. */
  function claimed(reserve = 100) {
    const id = store.newDispatchId();
    store.mutateDispatch(dispatchFile, (s) => {
      s.dispatches[id] = { dispatchId: id, task: 'A.1', phase: 'admitted', mode: 'subagent', reservation: { tokens: reserve } };
      return { write: true, result: null };
    });
    const c = claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, reserveTokens: reserve });
    assert.equal(c.disposition, 'claimed', JSON.stringify(c));
    const moved = store.transitionDispatch(dispatchFile, id, ['admitted'], (d) => { d.phase = 'claimed'; d.token = c.token; });
    assert.equal(moved.applied, true);
    return id;
  }
  const end = (fn, args) => store.mutateDispatch(dispatchFile, (s) => fn({ store: s, ctx, ...args }));
  const fail = (id, failureClass, extra = {}) => end(endAttempt, { dispatchId: id, failureClass, detail: 'exit 1', ...extra });
  const task = () => status({ file: ledgerFile, fsImpl: fs, roots: [dir], slug: SLUG }).tasks.find((r) => r.id === 'A.1');
  const attempts = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).tasks['A.1'].attempts;
  const dispatch = (id) => store.readDispatch(dispatchFile).dispatches[id];
  return { dir, planFile, ledgerFile, dispatchFile, claimed, end, fail, task, attempts, dispatch };
}

test('IC-024: a first verification failure finishes FAILED and leaves the task claimable', (t) => {
  const p = project(t);
  const id = p.claimed();
  const r = p.fail(id, 'verification');
  assert.deepEqual([r.ended, r.disposition, r.failureClass], [true, 'failed', 'verification']);
  const [a] = p.attempts();
  assert.deepEqual([a.result, a.reason], ['FAILED', 'verification: exit 1']);
  assert.deepEqual([a.usage.tokens, a.usage.basis], [100, 'estimated'], 'no usage known: the reservation as estimated (DEC-039)');
  assert.deepEqual([p.task().state, p.task().claimable], ['FAILED', true]);
  const d = p.dispatch(id);
  assert.deepEqual([d.phase, d.disposition, d.failureClass, d.usage], ['ended', 'failed', 'verification', { tokens: 100, basis: 'estimated' }]);
  assert.equal(d.endedAt, '2026-10-16T00:00:00.000Z');
});

test('IC-024 / DEC-007: a second consecutive verification failure finishes BLOCKED with verification: repeated', (t) => {
  const p = project(t);
  p.fail(p.claimed(), 'verification');
  const r = p.fail(p.claimed(), 'verification');
  assert.equal(r.ended, true);
  const second = p.attempts()[1];
  assert.deepEqual([second.result, second.reason], ['BLOCKED', 'verification: repeated']);
  assert.equal(p.task().state, 'BLOCKED');

  const roomy = project(t, { attempts: 5 });
  roomy.fail(roomy.claimed(), 'verification');
  roomy.fail(roomy.claimed(), 'verification');
  assert.deepEqual([roomy.task().state, roomy.task().reason], ['BLOCKED', 'result-blocked'], 'derived from the BLOCKED result, not the budget');
});

test('IC-024: verification, conflict, verification stays FAILED', (t) => {
  const p = project(t, { attempts: 5 });
  p.fail(p.claimed(), 'verification');
  p.fail(p.claimed(), 'conflict');
  p.fail(p.claimed(), 'verification');
  assert.deepEqual(p.attempts().map((a) => a.result), ['FAILED', 'FAILED', 'FAILED']);
  assert.deepEqual(p.attempts().map((a) => a.reason), ['verification: exit 1', 'conflict: exit 1', 'verification: exit 1']);
  assert.deepEqual([p.task().state, p.task().claimable], ['FAILED', true]);
});

test('IC-024 / DEC-007: a released dispatch between two failures is ignored by the repeat rule', (t) => {
  const p = project(t, { attempts: 5 });
  p.fail(p.claimed(), 'verification');
  const between = p.claimed();
  const released = p.end(releaseAttempt, { dispatchId: between, reason: 'integration-error' });
  assert.deepEqual([released.ended, released.disposition], [true, 'released']);
  assert.equal(p.dispatch(between).disposition, 'released');
  p.fail(p.claimed(), 'verification');
  const states = p.attempts().map((a) => [a.state, a.result ?? null]);
  assert.deepEqual(states, [['finished', 'FAILED'], ['released', null], ['finished', 'BLOCKED']]);
  assert.equal(p.attempts()[2].reason, 'verification: repeated');
  assert.equal(p.attempts()[1].usage.basis, 'estimated', 'a release passes usage too');
});

test('IC-008: usage is measured when the worker and every child are, estimated when any part is not', () => {
  const dispatch = { reservation: { tokens: 300 } };
  const run = (tokens) => ({ report: { usage: tokens === null ? null : { tokens } } });
  assert.deepEqual(usageFor(dispatch, run(40), [run(5), run(7)]), { tokens: 52, basis: 'measured' });
  assert.deepEqual(usageFor(dispatch, run(40), []), { tokens: 40, basis: 'measured' });
  assert.deepEqual(usageFor(dispatch, run(40), [run(5), run(null)]), { tokens: 45, basis: 'estimated' });
  assert.deepEqual(usageFor(dispatch, { report: { usage: 12 } }, []), { tokens: 12, basis: 'measured' }, 'an integer report.usage');
  assert.deepEqual(usageFor(dispatch, run(null), [run(5)]), { tokens: 300, basis: 'estimated' }, 'no worker usage: the reservation');
  assert.deepEqual(usageFor(dispatch, null, []), { tokens: 300, basis: 'estimated' });
  assert.deepEqual(usageFor({ reservation: { tokens: null } }, null, []), { tokens: 0, basis: 'estimated' });
  assert.deepEqual(usageFor({ usage: { tokens: 9, basis: 'measured' } }, null, []), { tokens: 9, basis: 'measured' }, 'a main-session submit');
});

test('IC-008: a measured usage given to endAttempt reaches the 080 attempt', (t) => {
  const p = project(t);
  const id = p.claimed();
  const usage = usageFor(p.dispatch(id), { report: { usage: { tokens: 40 } } }, [{ report: { usage: { tokens: 2 } } }]);
  p.fail(id, 'isolation', { usage });
  const [a] = p.attempts();
  assert.deepEqual([a.usage.tokens, a.usage.basis], [42, 'measured']);
  assert.deepEqual(p.dispatch(id).usage, { tokens: 42, basis: 'measured' });
});

test('IC-024: a plan made malformed makes 080 throw; lastError holds plan-malformed and the ledger bytes are unchanged', (t) => {
  const p = project(t);
  const id = p.claimed();
  const before = p.dispatch(id);
  fs.writeFileSync(p.planFile, '# Plan\n\n**Task graph:** v1\n\n## Tasks\n\nnothing here\n');
  const ledgerBytes = fs.readFileSync(p.ledgerFile);
  const r = p.fail(id, 'verification');
  assert.deepEqual([r.ended, r.outcome, r.call, r.reason], [false, 'error', 'finish', 'plan-malformed']);
  assert.deepEqual(fs.readFileSync(p.ledgerFile), ledgerBytes);
  const after = p.dispatch(id);
  assert.deepEqual(after.lastError, { at: '2026-10-16T00:00:00.000Z', call: 'finish', reason: 'plan-malformed' });
  const { lastError, seq, ...rest } = after;
  const { seq: oldSeq, ...restBefore } = before;
  assert.deepEqual(rest, restBefore, 'nothing but lastError changed');
  assert.equal(p.attempts()[0].state, 'active');
});

test('IC-024: an 080 refusal is recorded as lastError and ends nothing', (t) => {
  const p = project(t);
  const id = p.claimed();
  const r = p.end(completeAttempt, { dispatchId: id, evidenceId: 'ev-missing' });
  assert.deepEqual([r.ended, r.outcome, r.call], [false, 'refused', 'finish']);
  const d = p.dispatch(id);
  assert.equal(d.phase, 'claimed');
  assert.deepEqual([d.lastError.call, d.lastError.reason], ['finish', r.reason]);
  assert.equal(p.attempts()[0].state, 'active');
});

test('IC-024: an ended or unknown dispatch is refused with no write', (t) => {
  const p = project(t);
  const id = p.claimed();
  p.fail(id, 'launch');
  const bytes = fs.readFileSync(p.dispatchFile);
  assert.deepEqual(p.fail(id, 'launch'), { ended: false, reason: 'phase-not-allowed', dispatchId: id, phase: 'ended' });
  assert.equal(p.fail(store.newDispatchId(), 'launch').reason, 'unknown-dispatch');
  assert.deepEqual(fs.readFileSync(p.dispatchFile), bytes);
});

test('IC-024: the detail is masked and cut to 200 characters; interrupted releases', (t) => {
  const p = project(t, { attempts: 5 });
  const secret = `sk-${'a1B2'.repeat(6)}`;
  p.fail(p.claimed(), 'worker-failure', { detail: `token ${secret} ${'x'.repeat(400)}` });
  const reason = p.attempts()[0].reason;
  assert.ok(!reason.includes(secret), reason);
  assert.ok(Array.from(reason).length <= 'worker-failure: '.length + 200, `${reason.length}`);

  const id = p.claimed();
  const r = p.fail(id, 'interrupted');
  assert.deepEqual([r.ended, r.disposition, r.failureClass], [true, 'interrupted', 'interrupted']);
  assert.equal(p.attempts()[1].state, 'released');
});

test('IC-024: classFor maps every signal of the table and refuses an unknown one', () => {
  assert.equal(FAILURE_CLASSES.length, 10);
  const expect = {
    conflict: 'conflict', verification: 'verification', deadline: 'timeout', 'report-failure': 'worker-failure',
    'not-exited': 'worker-failure', 'submit-failure': 'worker-failure', 'report-denied': 'worker-denied',
    'report-unparsed': 'worker-unparsed', 'outside-write': 'isolation', 'branch-moved': 'isolation',
    'isolation-unverifiable': 'isolation', 'group-survived': 'isolation', 'status-unknown': 'lost',
    'run-refused': 'launch', 'not-started': 'launch', 'driver-gone': 'interrupted',
  };
  for (const [signal, cls] of Object.entries(expect)) assert.equal(classFor(signal).failureClass, cls, signal);
  assert.deepEqual([classFor('deadline').cancelRun, classFor('status-unknown').cancelRun, classFor('conflict').cancelRun], [true, true, false]);
  assert.equal(classFor('driver-gone').call, 'release');
  assert.throws(() => classFor('nope'), (e) => e.code === 'usage');
});
