'use strict';

// Feature 082 C.1 (IC-007, IC-008 reservation, IC-009 drivers; DEC-002, DEC-003, DEC-018, DEC-019,
// DEC-033, DEC-038, DEC-040, DEC-059): two-section admission, reservations and drivers in
// src/runtime/dispatch/admission.ts, on sandbox repos (test/helper/dispatch-sandbox.js) with A.7's
// plans, a real 080 ledger and real git.
//
// Every child PATH is the sandbox's scratch bin/ (fake CLI links, node and git only, DEC-056); the
// five DOFLOW_* identity variables are set by the sandbox. POSIX only.
//
// This file is also the race worker's module. race-barrier.js requires the module it is given and
// calls one of its fixed operation names, so when required with `--race-worker` the file exports
// `claim` as one admission pass and registers no tests.

const path = require('node:path');

if (process.argv[2] === '--race-worker') {
  const { admit } = require('../../src/runtime/dispatch/admission.ts');
  module.exports = {
    claim: ({ fsImpl, ctx, ...rest }: any) => admit({
      ...rest, ctx: { ...ctx, fsImpl }, driver: { pid: process.pid, start: null },
      modeFor: () => ({ mode: 'subagent', harness: 'claude' }),
    }),
  };
} else {

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');
const { startWorkers } = require('../helper/race-barrier.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { start, claim, finish } = require(path.join(SRC, 'task-attempts.ts'));
const { procStart } = require(path.join(SRC, 'worker', 'process-tree.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { registerDriver, endDriver, admit, concurrencyOf } = require(path.join(SRC, 'dispatch', 'admission.ts'));

const SLUG = '082-admission-fixture';
const POSIX: any = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const DRIVER: any = { pid: process.pid, start: null };
const SUBAGENT = () => ({ mode: 'subagent', harness: 'claude' });
const RACE_REPS = 50;

function git(cwd: any, env: any, args: any, { allowFailure = false }: any = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (!allowFailure && r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return { ok: r.status === 0, out: r.stdout.trim() };
}

/** Starts the 080 run of `slug` and seeds its dispatch run; returns the handles a case needs. */
function seedRun(sb: any, slug: any, { concurrency = 2, budgetTokens, reserveTokens = null }: any = {}) {
  const { root, env } = sb;
  const ledgerFile = path.join(root, '.doflow', 'state', 'task-attempts', `${slug}.json`);
  const common: any = { file: ledgerFile, fsImpl: fs, roots: [root], slug, env, cwd: root };
  const started = start({ ...common, by: 'main', ...(budgetTokens ? { budgetTokens } : {}) });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const file = store.storeFileFor(root, slug);
  const head = git(root, env, ['rev-parse', 'HEAD']).out;
  store.mutateDispatch(file, (s: any) => {
    s.run = {
      dispatchRunId: store.newDispatchRunId(), state: 'running', runKey: started.runKey, epoch: started.epoch,
      concurrency, mode: 'auto', reserveTokens, spawnGrant: null,
      integration: { worktree: null, branch: null, base: head, head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 30 },
    };
    return { write: true, result: null };
  });
  const ctx: any = { ledgerFile, fsImpl: fs, roots: [root], slug, env, cwd: root };
  return { common, started, file, head, ctx };
}

function project(t: any, { plan = 'disjoint', ...run }: any = {}) {
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG });
  const seeded = seedRun(sb, SLUG, run);
  const { root, env } = sb;
  const read = () => store.readDispatch(seeded.file);
  const ledger = () => JSON.parse(fs.readFileSync(seeded.ctx.ledgerFile, 'utf8'));
  const pass = (extra: any = {}) => admit({ root, slug: SLUG, ctx: seeded.ctx, env, driver: DRIVER, by: 'main', modeFor: SUBAGENT, ...extra });
  return { sb, root, env, ...seeded, read, ledger, pass };
}

const reasons = (result: any) => Object.fromEntries(result.skipped.map((s: any) => [s.task, s.reason]));

test('concurrencyOf: 1 to 4, default 2 (DEC-002)', () => {
  assert.equal(concurrencyOf(undefined), 2);
  assert.equal(concurrencyOf('4'), 4);
  assert.equal(concurrencyOf(1), 1);
  for (const bad of [0, 5, '2.5', 'x', -1]) assert.throws(() => concurrencyOf(bad), { code: 'usage' });
});

test('four disjoint READY tasks with concurrency 2 admit two, claimed with token, epoch and worktree', POSIX, (t) => {
  const p: any = project(t, { concurrency: 2 });
  const result = p.pass();
  assert.equal(result.outcome, 'admitted');
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.1', 'A.2']);
  assert.deepEqual(reasons(result), { 'A.3': 'concurrency', 'A.4': 'concurrency' });
  assert.deepEqual(result.refused, []);

  const dispatches = Object.values(p.read().dispatches);
  assert.equal(dispatches.length, 2);
  const attempts = p.ledger().tasks;
  for (const d of dispatches) {
    assert.equal(d.phase, 'claimed');
    assert.equal(d.token, 1);
    assert.equal(d.epoch, p.started.epoch);
    assert.equal(d.parentRunKey, p.started.runKey);
    assert.equal(d.mode, 'subagent');
    assert.equal(d.harness, 'claude');
    assert.deepEqual(d.admittedBy, DRIVER);
    assert.deepEqual(d.claimedBy, DRIVER);
    assert.deepEqual(d.reservation, { tokens: null });
    assert.equal(d.attempt.base, p.head);
    assert.equal(d.attempt.branch, `doflow-attempt/${SLUG}/${d.dispatchId}`);
    assert.equal(fs.existsSync(d.attempt.worktree), true);
    assert.equal(git(d.attempt.worktree, p.env, ['rev-parse', 'HEAD']).out, p.head);
    const attempt = attempts[d.task].attempts.find((a: any) => a.token === d.token);
    assert.equal(attempt.state, 'active');
    assert.equal(attempt.mode, 'subagent');
    assert.equal(attempt.owner, 'core-implementer');
    assert.equal(fs.realpathSync(attempt.execWorktree), fs.realpathSync(d.attempt.worktree));
  }
  // No room: nothing is admitted and nothing is written.
  const before = fs.readFileSync(p.file);
  assert.equal(p.pass().outcome, 'concurrency-full');
  assert.deepEqual(fs.readFileSync(p.file), before);
});

test('the shared-file pair and the no-files task are never admitted together or beside another', POSIX, (t) => {
  const p: any = project(t, { plan: 'overlap', concurrency: 4 });
  const first = p.pass();
  assert.deepEqual(first.admitted.map((a: any) => a.task), ['A.1']);
  assert.deepEqual(reasons(first), { 'A.2': 'overlap', 'A.3': 'overlap' });

  // A.1 still non-ended: its overlap is checked against the active dispatch, not only candidates.
  const before = fs.readFileSync(p.file);
  const second = p.pass();
  assert.deepEqual(second.admitted, []);
  assert.equal(second.outcome, 'none');
  assert.deepEqual(reasons(second), { 'A.1': 'active-dispatch', 'A.2': 'overlap', 'A.3': 'overlap' });
  assert.equal(second.skipped.find((s: any) => s.task === 'A.2').dispatchId, first.admitted[0].dispatchId);
  assert.deepEqual(fs.readFileSync(p.file), before);
  assert.equal(Object.keys(p.read().dispatches).length, 1);
  assert.equal(p.ledger().tasks['A.2'], undefined);
});

test('a non-ended dispatch of the no-files task keeps every other task out', POSIX, (t) => {
  const p: any = project(t, { plan: 'overlap', concurrency: 4 });
  const id = store.newDispatchId();
  store.mutateDispatch(p.file, (s: any) => {
    s.dispatches[id] = { dispatchId: id, task: 'A.3', phase: 'admitted', mode: 'subagent', token: null, admittedAt: new Date().toISOString() };
    return { write: true, result: null };
  });
  const result = p.pass();
  assert.deepEqual(result.admitted, []);
  assert.deepEqual(reasons(result), { 'A.1': 'overlap', 'A.2': 'overlap', 'A.3': 'active-dispatch' });
  assert.equal(result.skipped.find((s: any) => s.task === 'A.3').dispatchId, id);
});

test('a BLOCKED task is never a candidate and a claimable FAILED one is', POSIX, (t) => {
  const p: any = project(t, { concurrency: 4 });
  const end = (task: any, result: any, reason: any) => {
    const c = claim({ ...p.common, task, owner: 'core-implementer', mode: 'subagent', epoch: p.started.epoch });
    assert.equal(c.disposition, 'claimed', JSON.stringify(c));
    const f = finish({ ...p.common, task, token: c.token, result, reason, tokens: 0, basis: 'estimated' });
    assert.equal(f.disposition, 'applied', JSON.stringify(f));
  };
  end('A.1', 'BLOCKED', 'verification: repeated');
  end('A.2', 'FAILED', 'verification: exit 1');
  const result = p.pass();
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.2', 'A.3', 'A.4']);
  assert.equal(result.skipped.some((s: any) => s.task === 'A.1'), false);
  assert.equal(result.admitted[0].token, 2);
  assert.equal(Object.values(p.read().dispatches).some((d) => d.task === 'A.1'), false);
});

test('a reservation that fits one admits one; the other is claim-refused aggregate-exhausted and its worktree removed verified', POSIX, (t) => {
  const p: any = project(t, { concurrency: 2, budgetTokens: 100, reserveTokens: 60 });
  const result = p.pass();
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.1']);
  assert.equal(result.refused.length, 1);
  const [refused] = result.refused;
  assert.equal(refused.task, 'A.2');
  assert.equal(refused.reason, 'aggregate-exhausted');
  assert.equal(refused.removal.verified, true, JSON.stringify(refused.removal));
  assert.deepEqual(refused.gap, { task: 'A.2', kind: 'claim-refused', cause: 'budget', reason: 'aggregate-exhausted' });
  assert.deepEqual(result.gaps, [refused.gap]);
  const action = result.actions.find((a: any) => a.action === 'claim-refused');
  assert.deepEqual({ ...action, ms: 0 }, { action: 'claim-refused', dispatchId: refused.dispatchId, task: 'A.2', token: null, reason: 'aggregate-exhausted', ms: 0 });

  assert.equal(fs.existsSync(refused.removal.path), false);
  assert.equal(git(p.root, p.env, ['rev-parse', '--verify', '-q', `refs/heads/${refused.removal.branch}`], { allowFailure: true }).ok, false);
  const dispatches = p.read().dispatches;
  assert.equal(dispatches[refused.dispatchId], undefined);
  const [kept] = Object.values(dispatches);
  assert.deepEqual(kept.reservation, { tokens: 60 });
  const ledger = p.ledger();
  assert.deepEqual(ledger.tasks['A.1'].attempts[0].reserve, { tokens: 60 });
  assert.equal(ledger.tasks['A.2'], undefined);
});

test('a driver whose process has exited makes the run resume-required driver-lost, and admission admits nothing', POSIX, (t) => {
  const p = project(t);
  const gone = spawnSync('node', ['-e', ''], { env: p.env });
  assert.equal(gone.status, 0);
  const dead: any = { pid: gone.pid, start: procStart(process.pid), registeredAt: '2026-10-16T00:00:00.000Z', endedAt: null };
  store.mutateDispatch(p.file, (s: any) => { s.drivers.push(dead); return { write: true, result: null }; });

  const registered = registerDriver({ file: p.file });
  assert.deepEqual(registered.lost, [{ pid: dead.pid, start: dead.start, reason: 'driver-lost' }]);
  assert.equal(registered.state, 'resume-required');
  assert.equal(registered.driver.pid, process.pid);
  assert.equal(registered.driver.start, procStart(process.pid));
  const s = p.read();
  assert.equal(s.run.state, 'resume-required');
  assert.equal(s.run.resumeReason, 'driver-lost');
  assert.equal(s.drivers[0].lost, 'driver-lost');
  assert.equal(s.drivers[0].endedAt, null, 'resume, not registration, ends a lost driver (IC-032 step 7)');

  const before = fs.readFileSync(p.file);
  const result = p.pass();
  assert.equal(result.outcome, 'resume-required');
  assert.deepEqual(result.admitted, []);
  assert.deepEqual(fs.readFileSync(p.file), before);
  assert.deepEqual(p.ledger().tasks, {});
});

test('an injected unknown liveness gives driver-liveness-unknown; a live driver stays; endDriver writes endedAt', POSIX, (t): any => {
  const p = project(t);
  const other: any = { pid: process.pid, start: 'Thu Oct 16 00:00:00 2026', registeredAt: '2026-10-16T00:00:00.000Z', endedAt: null };
  store.mutateDispatch(p.file, (s: any) => { s.drivers.push(other); return { write: true, result: null }; });

  const live = registerDriver({ file: p.file, aliveImpl: () => true });
  assert.deepEqual(live.lost, []);
  assert.equal(live.state, 'running');

  const read: any = [];
  const unknown = registerDriver({ file: p.file, aliveImpl: (proc: any) => { read.push(proc); return 'unknown'; } });
  assert.equal(read.length, 2, 'every other driver with no end is read');
  assert.deepEqual(read[0], { pid: other.pid, pgid: other.pid, start: other.start });
  assert.equal(unknown.lost.length, 2);
  assert.equal(unknown.lost.every((l: any) => l.reason === 'driver-liveness-unknown'), true);
  assert.equal(unknown.state, 'resume-required');
  assert.equal(p.read().run.resumeReason, 'driver-liveness-unknown');
  assert.equal(p.pass().outcome, 'resume-required');

  assert.deepEqual(endDriver({ file: p.file, driver: unknown.driver }), { ended: true });
  assert.deepEqual(endDriver({ file: p.file, driver: unknown.driver }), { ended: false });
  const mine = p.read().drivers.find((d: any) => d.registeredAt === unknown.driver.registeredAt && d.pid === unknown.driver.pid && !d.lost);
  assert.equal(typeof mine.endedAt, 'string');
});

test('two processes released by the barrier on one READY task admit one; the other records active-dispatch naming it', POSIX, async (t) => {
  const sb = makeDispatchSandbox(t, { plan: 'budget', slug: SLUG });
  const planText = fs.readFileSync(sb.planFile, 'utf8');
  // The workers' PATH is the sandbox's scratch bin (node and git), never the node directory
  // (DEC-056). race-barrier.js passes the parent's PATH, so it is set for the spawn and restored.
  const savedPath = process.env.PATH;
  process.env.PATH = sb.bin;
  let workers;
  try {
    workers = startWorkers({ count: 2, modulePath: __filename, barrierDir: sb.dir, envFor: () => ({ ...sb.env }) });
  } finally {
    process.env.PATH = savedPath;
  }
  const { race, stop } = workers;
  t.after(stop);
  const began = Date.now();
  for (let rep = 0; rep < RACE_REPS; rep += 1) {
    const slug = `082-race-r${rep}`;
    const planFile = path.join(sb.root, 'agent-docs', 'doflow', slug, 'plan.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, planText);
    const { ctx, file } = seedRun(sb, slug, { concurrency: 2 });
    const args: any = { root: sb.root, slug, ctx: { ...ctx, fsImpl: undefined }, env: sb.env, by: 'main' };
    const answers = await race([0, 1].map((i) => ({ op: 'claim', args, skewUs: i === rep % 2 ? rep : 0 })));
    for (const answer of answers) assert.equal(answer.error, undefined, `repetition ${rep}: ${JSON.stringify(answer.error)}`);
    const winners = answers.filter((a: any) => a.result.admitted.length === 1);
    const losers = answers.filter((a: any) => a.result.admitted.length === 0);
    assert.equal(winners.length, 1, `repetition ${rep}: ${JSON.stringify(answers)}`);
    assert.equal(losers.length, 1);
    const won = winners[0].result.admitted[0];
    assert.deepEqual(losers[0].result.skipped, [{ task: 'A.1', reason: 'active-dispatch', dispatchId: won.dispatchId }], `repetition ${rep}`);
    const dispatches = Object.values(store.readDispatch(file).dispatches);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].phase, 'claimed');
    const attempts = JSON.parse(fs.readFileSync(ctx.ledgerFile, 'utf8')).tasks['A.1'].attempts;
    assert.equal(attempts.length, 1, `repetition ${rep}`);
    assert.equal(attempts[0].token, won.token);
  }
  t.diagnostic(`race: ${RACE_REPS} repetitions in ${Date.now() - began} ms`);
});

// RT-14: a cancel or resume that drops an admitted slot after the first section and before its
// worktree existed leaves that worktree to admission. The ctx fs plays that drop just before the
// second section takes the dispatch lock, once the slot's worktree exists, so the order is fixed.
// The second section reads the slot gone, and admission must remove the worktree and branch it made.
test('RT-14: a slot dropped while its worktree was being made is removed verified by the second section', POSIX, (t) => {
  const p: any = project(t, { concurrency: 1 });
  const lock = `${p.file}.lock`;
  let dropped: any = null;
  const fsImpl: any = {
    ...fs,
    mkdirSync: (dir: any, ...rest: any[]): any => {
      if (!dropped && dir === lock) {
        const slot = Object.values(p.read().dispatches).find((d) => d.phase === 'admitted');
        if (slot && fs.existsSync(slot.attempt.worktree)) {
          dropped = slot;
          store.mutateDispatch(p.file, (s: any) => { delete s.dispatches[slot.dispatchId]; return { write: true, result: null }; });
        }
      }
      return fs.mkdirSync(dir, ...rest);
    },
  };
  const r = p.pass({ ctx: { ...p.ctx, fsImpl } });
  assert.ok(dropped, JSON.stringify(r.actions));
  const branch: any = git(p.root, p.env, ['rev-parse', '--verify', '--quiet', `refs/heads/${dropped.attempt.branch}`], { allowFailure: true });
  assert.deepEqual([r.actions.filter((a: any): any => a.dispatchId === dropped.dispatchId).map((a: any) => a.reason), fs.existsSync(dropped.attempt.worktree), branch.ok], [['slot-moved:dropped'], false, false]);
});
}
