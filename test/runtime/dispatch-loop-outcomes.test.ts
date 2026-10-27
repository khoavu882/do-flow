'use strict';

// Feature 082 C.3 (IC-023, IC-025, IC-026, IC-027, IC-028, IC-033 launch; DEC-006, DEC-007,
// DEC-011, DEC-013, DEC-035, DEC-039): the loop's outcomes: a stale collection, a timeout retried
// within budget, no false completion, the BLOCKED report's causes, the repeat block, a granted
// child run and the run's measurement.
//
// Each case is a sandbox repository (test/helper/dispatch-sandbox.js) with a started 080 run, an
// integration worktree and a seeded dispatch run. The child PATH is the sandbox's scratch bin/
// alone (fake CLI links, node and git, never dirname(process.execPath), DEC-056); the five DOFLOW_*
// identity variables are set by the sandbox, DOFLOW_ATTEMPT deleted where a worker is launched.
// A "test performer" plays the main session for sequential attempts. POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const { readRuns, storeFileFor: runStoreFileFor } = require(path.join(SRC, 'worker', 'run-store.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createIntegrationWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const { requestSpawn } = require(path.join(SRC, 'dispatch', 'grants.ts'));
const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));

const SLUG = '082-loop-outcomes-fixture';
const POSIX: any = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const SUCCESS: any = { type: 'result', status: 'success', summary: 'edited' };
const SLEEPER: any = { run: [{ sleep: 30000 }, { emit: SUCCESS }] };
const TWO_TASKS = [
  '# Implementation Plan: loop fixture, two tasks', '', '**Task graph:** v1', '', '## 8. Tasks', '', '### Phase A', '',
  '- [ ] A.1 Write module a — owner: core-implementer; files: src/a.js', '',
  '- [ ] A.2 Write module b — owner: core-implementer; files: src/b.js', '',
].join('\n');
const ONE_TASK = [
  '# Implementation Plan: loop fixture, one task', '', '**Task graph:** v1', '', '## 8. Tasks', '', '### Phase A', '',
  '- [ ] A.1 Write module a — owner: core-implementer; files: src/a.js; budget: attempts=3', '',
].join('\n');
/** Fails from its `n`-th call on, counting in VERIFY_COUNT. */
const countingVerify = (n: any) => `const fs=require('fs');const f=process.env.VERIFY_COUNT;const c=(fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0)+1;fs.writeFileSync(f,String(c));process.exitCode=c>=${n}?1:0;`;
/** The fake's `doflow` step script: a child (cwd `<d-id>.c<n>`) marks CHILD_DONE; its granter waits for the mark. */
const GATE = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
  'if (/\\.c[0-9]+$/.test(path.basename(process.cwd()))) fs.writeFileSync(process.env.CHILD_DONE, "done");',
  'else { const until = Date.now() + 20000; while (!fs.existsSync(process.env.CHILD_DONE) && Date.now() < until) pause(100); pause(1500); }',
  '',
].join('\n');

function git(cwd: any, env: any, args: any) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

async function project(t: any, {
  plan = 'budget', mode = 'sequential', concurrency = 2, scenario = {}, identity = {}, probe = false, attemptSeconds = 60,
  verify, declared = true, reserveTokens = null, budgetTokens, spawnGrant = null, extraEnv = {},
}: any = {}) {
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG, scenario, identity, ...(verify ? { verify } : {}) });
  const { root } = sb;
  const env: any = { ...sb.env, VERIFY_COUNT: path.join(sb.dir, 'verify-count'), ...extraEnv };
  const ledgerFile = attempts.storeFile(root, SLUG);
  const common: any = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const started = attempts.start({ ...common, by: 'main', ...(budgetTokens ? { budgetTokens } : {}) });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  store.mutateDispatch(file, (s: any) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch, concurrency, mode,
      reserveTokens, attemptSeconds, harness: null, needs: [], spawnGrant, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: declared
        ? { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 }
        : { argv: null, argvSha256: null, argvCount: 0, timeoutSeconds: 600 },
    };
    return { write: true, result: null };
  });
  if (probe) assert.equal((await readiness.probe({ descriptors: sb.descriptors, env, cwd: root })).disposition, 'probed');
  const read = () => store.readDispatch(file);
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const options = (extra: any = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors: sb.descriptors, ...extra });
  const step = (extra?: any) => loop.step(options(extra));
  const submit = (y: any, { files = {}, ...extra }: any = {}) => {
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(y.worktree, rel), text);
    return loop.submit(options({ dispatchId: y.dispatchId, status: 'success', summary: `done ${y.task}`, ...extra }));
  };
  /** Steps until `stop(result)` or `max` passes, performing each yield with `onPerform`. */
  const drive = async ({ stop = (r: any) => ['completed', 'blocked'].includes(r.outcome), onPerform = null, max = 40, wait = 100 }: any = {}) => {
    let r = null;
    for (let i = 0; i < max; i += 1) {
      r = await step();
      assert.equal(r.disposition, 'stepped', JSON.stringify(r));
      if (stop(r)) return r;
      if (r.outcome === 'perform') {
        assert.ok(onPerform, `unexpected perform: ${JSON.stringify(r.perform)}`);
        const s: any = await onPerform(r.perform);
        assert.equal(s.disposition, 'submitted', JSON.stringify(s));
      } else await sleep(wait);
    }
    return r;
  };
  return { sb, root, env, file, ledgerFile, common, started, integration, read, ledger, options, step, submit, drive };
}

test('IC-023: an attempt cancelled while its fake worker sleeps is ended stale, its worker cancelled, and nothing is integrated', POSIX, async (t) => {
  const started = Date.now();
  const p = await project(t, { mode: 'auto', scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined }, probe: true });
  const first = await p.step();
  assert.ok(first.actions.some((a: any) => a.action === 'launch' && a.reason.startsWith('subagent')), JSON.stringify(first.actions));
  const [launched] = Object.values(p.read().dispatches);
  assert.equal(launched.phase, 'launched');
  const cancelled = attempts.cancel({ ...p.common, task: 'A.1', token: launched.token, by: 'main', reason: 'user stopped it' });
  assert.equal(cancelled.disposition, 'cancelled', JSON.stringify(cancelled));
  const second = await p.step();
  t.diagnostic(`stale case took ${Date.now() - started} ms`);
  const stale = second.actions.find((a: any) => a.action === 'stale');
  assert.equal(stale.reason, 'attempt-cancelled', JSON.stringify(second.actions));
  assert.ok(!second.actions.some((a: any) => a.action === 'integrate'), 'nothing is integrated');
  const d = p.read().dispatches[launched.dispatchId];
  assert.deepEqual([d.phase, d.disposition, d.staleReason], ['ended', 'stale', 'attempt-cancelled']);
  assert.equal(d.cleanup.disposition, 'cancelled', JSON.stringify(d.cleanup));
  assert.equal(readRuns(runStoreFileFor(p.root, SLUG))[launched.workerRunId].phase, 'ended');
  assert.equal(p.read().run.integration.head, p.integration.head);
  assert.equal(git(p.integration.worktree, p.env, ['rev-parse', 'HEAD']), p.integration.head);
});

test('IC-025: a sleeping worker past its deadline with budget 2 is finished timeout, retried once and never a third time', POSIX, async (t) => {
  const started = Date.now();
  const p = await project(t, { mode: 'auto', scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined }, probe: true, attemptSeconds: 1 });
  const r = await loop.run(p.options({ maxSeconds: 60 }));
  t.diagnostic(`timeout case took ${Date.now() - started} ms over ${r.steps} steps`);
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last));
  const ds = Object.values(p.read().dispatches).sort((a, b) => a.token - b.token);
  assert.deepEqual(ds.map((d) => [d.token, d.disposition, d.failureClass]), [[1, 'failed', 'timeout'], [2, 'failed', 'timeout']]);
  const [a1, a2] = p.ledger().tasks['A.1'].attempts;
  assert.equal(p.ledger().tasks['A.1'].attempts.length, 2, 'never a third attempt');
  assert.deepEqual([a1.result, a2.result], ['FAILED', 'BLOCKED']);
  assert.match(a1.reason, /^timeout: 1s/);
  assert.equal(a2.reason, 'timeout: repeated');
  const runs = readRuns(runStoreFileFor(p.root, SLUG));
  for (const d of ds) {
    assert.equal(runs[d.workerRunId].end.state, 'timed-out', 'the worker run ended through cancelRun source timeout');
    assert.equal(runs[d.workerRunId].timeoutSeconds, 121, 'the 081 backstop is the deadline plus 120 s');
  }
  assert.equal(r.last.blocked.cause, 'budget');
  assert.ok(r.last.blocked.gaps.some((g: any) => g.task === 'A.1' && g.cause === 'budget'), JSON.stringify(r.last.blocked));
});

test('IC-026: every worker reporting success with failing final verification blocks final-verification-failed and never completes', POSIX, async (t) => {
  const p: any = await project(t, { plan: 'budget', mode: 'sequential', verify: countingVerify(2) });
  const r: any = await p.drive({ onPerform: (y: any) => p.submit(y, { files: { 'src/retry.js': '// done\n' } }) });
  assert.equal(r.outcome, 'blocked', JSON.stringify(r));
  assert.equal(attempts.inspect(p.common).tasks[0].state, 'SUCCEEDED', 'the task itself succeeded');
  const gap = r.blocked.gaps.find((g: any) => g.kind === 'final-verification-failed');
  assert.ok(gap, JSON.stringify(r.blocked));
  assert.equal(gap.cause, 'no-progress');
  assert.equal(r.blocked.cause, 'no-progress');
  assert.deepEqual(r.blocked.completed.map((c: any) => c.task), ['A.1']);
  const s = p.read();
  assert.equal(s.run.state, 'blocked');
  assert.equal(s.run.completion, undefined, 'no completion record');
  assert.equal(s.run.verifications.at(-1).exitCode, 1);
});

test('IC-027: an exhausted aggregate blocks with cause budget, the completed task and the unfinished task as a gap', POSIX, async (t) => {
  const p: any = await project(t, { plan: TWO_TASKS, mode: 'sequential', concurrency: 1, budgetTokens: 10, reserveTokens: 10 });
  const r: any = await p.drive({ onPerform: (y: any) => p.submit(y, { files: { 'src/a.js': '// a\n' }, tokens: 10, tokensBasis: 'measured' }) });
  assert.equal(r.outcome, 'blocked', JSON.stringify(r));
  assert.equal(r.blocked.cause, 'budget');
  assert.deepEqual(r.blocked.completed.map((c: any) => c.task), ['A.1']);
  assert.equal(r.blocked.integrated.length, 1);
  const gap = r.blocked.gaps.find((g: any) => g.task === 'A.2');
  assert.deepEqual([gap.kind, gap.cause], ['aggregate-exhausted', 'budget'], JSON.stringify(r.blocked.gaps));
  assert.equal(r.measurement.tokens.main.measured, 10);
  assert.equal(r.measurement.tokens.total.measured, 10);
  assert.equal(p.read().run.state, 'blocked');
});

test('IC-026 / IC-027: a run without --verify-argv admits nothing and blocks verification-undeclared, cause input', POSIX, async (t) => {
  const p = await project(t, { plan: 'dependent', declared: false });
  const r = await p.step();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r));
  assert.equal(r.blocked.cause, 'input');
  assert.ok(r.blocked.gaps.some((g: any) => g.kind === 'verification-undeclared' && g.cause === 'input'), JSON.stringify(r.blocked));
  assert.deepEqual(p.read().dispatches, {});
  assert.equal(p.ledger().tasks?.['A.1']?.attempts?.length ?? 0, 0);
});

test('IC-024 / DEC-007: two equal failures block the task and plan.md stays byte-identical', POSIX, async (t) => {
  const p = await project(t, { plan: ONE_TASK, mode: 'sequential' });
  const planBefore = fs.readFileSync(p.sb.planFile);
  const r: any = await p.drive({ onPerform: (y: any) => p.submit(y, { status: 'failure', summary: 'could not do it', blockers: ['missing input'] }) });
  assert.equal(r.outcome, 'blocked', JSON.stringify(r));
  const [a1, a2] = p.ledger().tasks['A.1'].attempts;
  assert.deepEqual([a1.result, a2.result, a2.reason], ['FAILED', 'BLOCKED', 'worker-failure: repeated']);
  assert.equal(p.ledger().tasks['A.1'].attempts.length, 2);
  const gap = r.blocked.gaps.find((g: any) => g.task === 'A.1');
  assert.deepEqual([gap.kind, gap.cause], ['worker-failure', 'no-progress'], JSON.stringify(r.blocked));
  assert.deepEqual(fs.readFileSync(p.sb.planFile), planBefore, 'BLOCKED never edits plan.md');
  assert.ok(fs.existsSync(Object.values(p.read().dispatches)[0].attempt.worktree), 'a failed attempt worktree is kept until the run ends');
});

test('IC-033 / IC-028: a granted spawn request launches a child run whose usage adds to its granter; measurement splits tokens by basis and records durations and peaks', POSIX, async (t) => {
  const started = Date.now();
  const scenario: any = { run: [{ doflow: { args: [] } }, { emit: { type: 'usage', tokens: 40 } }, { emit: SUCCESS }] };
  const p: any = await project(t, {
    mode: 'auto', scenario, identity: { DOFLOW_ATTEMPT: undefined }, probe: true, reserveTokens: 100,
    spawnGrant: { depth: 1, children: 1, tokens: 50 },
    extraEnv: { FAKE_DOFLOW_CLI: 'pending', CHILD_DONE: 'pending' },
  });
  // The gate script lives in the sandbox, so its paths are set once the sandbox exists.
  p.env.FAKE_DOFLOW_CLI = path.join(p.sb.dir, 'gate.js');
  p.env.CHILD_DONE = path.join(p.sb.dir, 'child-done');
  fs.writeFileSync(p.env.FAKE_DOFLOW_CLI, GATE);

  const first = await p.step();
  assert.ok(first.actions.some((a: any) => a.action === 'launch' && a.reason.startsWith('subagent')), JSON.stringify(first.actions));
  const [granter] = Object.values(p.read().dispatches);
  assert.deepEqual(granter.grant, { depth: 1, children: 1, tokens: 50, used: { children: 0, tokens: 0 } });
  const handoff = JSON.parse(fs.readFileSync(path.join(p.root, '.doflow', 'state', granter.envelopes.handoff), 'utf8'));
  assert.equal(handoff.report.spawn[0], 'dispatch');

  // The worker's own `dispatch --action spawn`, in process with its identity.
  const prompt = path.join(granter.attempt.worktree, 'child-prompt.md');
  fs.writeFileSync(prompt, 'look something up');
  const workerEnv: any = {
    ...p.env, DOFLOW_RUN_ID: granter.workerIdentity.run, DOFLOW_LINEAGE_ID: granter.workerIdentity.lineage,
    DOFLOW_ATTEMPT: granter.workerIdentity.attempt, DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: granter.attempt.worktree,
  };
  const requested = requestSpawn({ slug: SLUG, promptFile: prompt, reserveTokens: 20, env: workerEnv, cwd: granter.attempt.worktree, root: p.root });
  assert.equal(requested.disposition, 'spawn-requested', JSON.stringify(requested));
  fs.rmSync(prompt);

  const r = await p.drive({ stop: (x: any) => ['completed', 'blocked'].includes(x.outcome) });
  t.diagnostic(`spawn case took ${Date.now() - started} ms`);
  assert.equal(r.outcome, 'completed', JSON.stringify(r.blocked || r.actions));
  const s = p.read();
  const request = s.spawnRequests[requested.requestId];
  assert.equal(request.state, 'launched');
  assert.match(request.childRunId, /^w-[0-9a-f]{12}$/);
  assert.equal(request.endState, 'exited');
  const child = readRuns(runStoreFileFor(p.root, SLUG))[request.childRunId];
  assert.equal(child.childOf, granter.workerRunId);
  assert.equal(child.identity.runSource, 'run-scoped');
  assert.equal(request.removal.verified, true, 'the child worktree is removed after its run ends');
  const d = s.dispatches[granter.dispatchId];
  assert.deepEqual(d.usage, { tokens: 80, basis: 'measured' }, 'the child tokens add to the granter');
  assert.deepEqual(d.usageParts, { worker: { tokens: 40, basis: 'measured' }, child: { tokens: 40, basis: 'measured' } });
  assert.deepEqual([p.ledger().tasks['A.1'].attempts[0].usage.tokens, p.ledger().tasks['A.1'].attempts[0].usage.basis], [80, 'measured']);

  const m = r.measurement;
  assert.deepEqual(m.tokens.worker, { measured: 40, estimated: 0 });
  assert.deepEqual(m.tokens.child, { measured: 40, estimated: 0 });
  assert.deepEqual(m.tokens.main, { measured: 0, estimated: 0 });
  assert.deepEqual(m.tokens.total, { measured: 80, estimated: 0 });
  assert.equal(m.durationsMs.attempt.count, 1);
  assert.equal(m.durationsMs.integration.count, 1);
  assert.equal(m.durationsMs.verification.count, 2, 'one integration check and the final one');
  assert.ok(m.durationsMs.verification.maxMs > 0 && m.durationsMs.verification.totalMs >= m.durationsMs.verification.maxMs);
  assert.equal(typeof m.durationsMs.run, 'number');
  assert.equal(m.peak.workers, 2, 'the granter and its child at once');
  assert.equal(m.peak.worktrees, 2);
});

// RT-2: a lost driver can make the run `resume-required` after `decide` read it `running`. The
// injected final verification sets that state and fails, so `decide`'s blocked write lands on a
// held run: it must leave `resume-required` and report that outcome.
test('RT-2: decide\'s blocked write after a failed final verification leaves a resume-required run resume-required', POSIX, async (t) => {
  const { runVerification } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
  const p = await project(t, { plan: 'budget', mode: 'sequential' });
  const verify = async (args: any) => {
    const result = await runVerification(args);
    if (args.taskId !== SLUG) return result;
    store.mutateDispatch(p.file, (s: any) => { s.run.state = 'resume-required'; s.run.resumeReason = 'driver-lost'; return { write: true, result: null }; });
    return { ...result, exitCode: 1 };
  };
  let r = null;
  for (let i = 0; i < 10; i += 1) {
    r = await p.step({ verify });
    if (r.outcome === 'perform') { assert.equal((await p.submit(r.perform, { files: { 'src/retry.js': '// done\n' } })).disposition, 'submitted'); continue; }
    if (r.actions.some((a: any) => a.action === 'verify' && String(a.reason).startsWith('final-'))) break;
  }
  const s = p.read();
  assert.equal(s.run.state, 'resume-required', JSON.stringify(r));
  assert.equal(s.run.resumeReason, 'driver-lost');
  assert.equal(r.outcome, 'resume-required', JSON.stringify(r.actions));
  assert.equal(r.blocked, undefined);
});

// RT-5: a pass that throws must not end its driver cleanly over state no later pass settles. Case 1:
// the injected integration verification throws while the pass holds the lease. Case 2: the plan
// task disappears after admission claimed it (the injected clock rewrites plan.md on its first
// reading after the 080 claim landed), so the launch's handoff throws. Either way the thrown pass
// leaves the run `resume-required`, its driver ended `threw`, no lease resume cannot settle, and the
// next step returns `resume-required`, not `continue`.
test('RT-5: a verification that throws mid-integration leaves the run resume-required with the lease cleared', POSIX, async (t) => {
  const p = await project(t, { plan: 'budget', mode: 'sequential' });
  const y = (await p.step()).perform;
  assert.equal((await p.submit(y, { files: { 'src/retry.js': '// done\n' } })).disposition, 'submitted');
  const verify = async () => { throw new Error('injected verification throw'); };
  await assert.rejects(p.step({ verify }), /injected verification throw/);
  const s = p.read();
  assert.equal(s.run.state, 'resume-required');
  assert.equal(s.run.resumeReason, 'driver-threw');
  assert.equal(s.lease, null, 'no stranded lease');
  assert.equal(s.dispatches[y.dispatchId].phase, 'collected', 'the dispatch is back to collected');
  assert.ok(s.drivers.some((d: any) => d.endReason === 'threw' && d.endedAt), JSON.stringify(s.drivers));
  assert.equal(git(p.integration.worktree, p.env, ['rev-parse', 'HEAD']), p.integration.head, 'nothing was integrated');
  const next = await p.step();
  assert.equal(next.outcome, 'resume-required', JSON.stringify(next.actions));
});

test('RT-5: a plan task that disappears after its claim makes the launch throw and leaves the run resume-required', POSIX, async (t) => {
  const p = await project(t, { plan: ONE_TASK, mode: 'sequential' });
  let rewritten = false;
  const now = () => {
    if (!rewritten && fs.existsSync(p.ledgerFile)) {
      const entry = JSON.parse(fs.readFileSync(p.ledgerFile, 'utf8')).tasks?.['A.1'];
      if (entry && entry.attempts && entry.attempts.some((a: any) => a.state === 'active')) {
        rewritten = true;
        fs.writeFileSync(p.sb.planFile, ONE_TASK.replace('A.1 Write module a', 'A.9 Write module a'));
      }
    }
    return new Date();
  };
  await assert.rejects(p.step({ now }));
  assert.ok(rewritten, 'the claim landed before the launch');
  const s = p.read();
  assert.equal(s.run.state, 'resume-required');
  assert.equal(s.run.resumeReason, 'driver-threw');
  assert.deepEqual(Object.values(s.dispatches).map((d) => d.phase), ['claimed']);
  assert.equal(s.lease, null);
  const next = await p.step();
  assert.equal(next.outcome, 'resume-required', JSON.stringify(next.actions));
});

// RT-7: deferredRemovals reads each ended dispatch's worker run settled against the probe, as
// collect does. The dispatch is ended with no cleanup while its run (hand-built, its processes gone)
// has no end; the injected clock, on its reading inside deferredRemovals, plays the supervisor
// writing its end with survivors left and exiting. A pass-wide snapshot read before that write would
// read the run lost and record cleanup `verified` add-only; the settled read sees the survivors.
test('RT-7: a worker run that ends with survivors during deferredRemovals is never recorded cleanup verified', POSIX, async (t) => {
  const crypto = require('node:crypto');
  const { insertRun, newRunId, transition } = require(path.join(SRC, 'worker', 'run-store.ts'));
  const { launchEnv, launchRecord } = require(path.join(SRC, 'worker', 'launch.ts'));
  const DESCRIPTORS = require('../fixtures/worker/descriptors.json');
  const p = await project(t, { plan: ONE_TASK, mode: 'sequential' });
  const first = await p.step();
  assert.equal(first.outcome, 'perform', JSON.stringify(first.actions));
  const y = first.perform;
  const d0 = p.read().dispatches[y.dispatchId];
  const runStore = runStoreFileFor(p.root, SLUG);
  const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const proc: any = { pid: dead.pid, pgid: dead.pid, start: 'Thu Jan  1 00:00:00 1970' };
  const runId = newRunId();
  const { identity } = launchEnv({ env: p.env, runKey: p.started.runKey, token: d0.token, execWorktree: y.worktree, runId });
  assert.equal(insertRun(runStore, {
    runId, task: 'A.1', token: d0.token, harness: 'claude', phase: 'starting', execWorktree: y.worktree,
    createdAt: new Date().toISOString(), timeoutSeconds: 60,
    caller: { cwd: p.root, runKey: p.started.runKey, run: 'r1', lineage: 'main', attempt: null, role: 'main', lineageKind: 'launched' },
    ...launchRecord(DESCRIPTORS.claude, identity, 'p'), descriptor: DESCRIPTORS.claude,
    prompt: { path: path.join(p.root, 'p.md'), sha256: crypto.createHash('sha256').update('p').digest('hex'), bytes: 1 }, needs: [],
  }).applied, true);
  assert.equal(transition(runStore, runId, ['starting'], (r: any) => { Object.assign(r, { phase: 'running', supervisor: proc, worker: proc, deadline: new Date(Date.now() + 60000).toISOString() }); }).applied, true);
  assert.equal(store.transitionDispatch(p.file, y.dispatchId, ['launched'], (d: any) => Object.assign(d, {
    phase: 'ended', disposition: 'stale', staleReason: 'attempt-cancelled', endedAt: new Date().toISOString(), workerRunId: runId, cleanup: null,
  })).applied, true);

  let ended = false;
  const now = () => {
    if (!ended && new Error().stack?.includes('deferredRemovals')) {
      ended = true;
      assert.equal(transition(runStore, runId, ['running'], (r: any) => {
        Object.assign(r, { phase: 'ended', end: { state: 'exited', at: new Date().toISOString() }, process: { ...(r.process || {}), leftover: { status: 'survivors', reason: 'group-survived' } } });
      }).applied, true);
    }
    return new Date();
  };
  const stepped = await p.step({ now });
  assert.ok(ended, 'the run ended inside deferredRemovals');
  const d = p.read().dispatches[y.dispatchId];
  assert.notEqual(d.cleanup && (d.cleanup.cleanup || d.cleanup).status, 'verified', JSON.stringify([d.cleanup, stepped.actions]));
});

// RT-13: the completion write reads IC-026 step 2 again inside its lock. During the final
// verification the injected verify plays a concurrent driver that took a lease, so the order is
// fixed. The run must not be completed beside a held lease; the pass continues.
test('RT-13: a lease taken during the final verification keeps the run from completing', POSIX, async (t) => {
  const { runVerification } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
  const p = await project(t, { plan: 'budget', mode: 'sequential' });
  let leased = false;
  const verify = async (args: any) => {
    const result = await runVerification(args);
    if (args.taskId === SLUG && !leased) {
      leased = true;
      store.mutateDispatch(p.file, (s: any) => {
        const [d] = Object.values(s.dispatches);
        s.lease = { holder: { pid: process.pid, start: null }, dispatchId: d.dispatchId, preHead: s.run.integration.head, takenAt: new Date().toISOString() };
        return { write: true, result: null };
      });
    }
    return result;
  };
  let r = null;
  for (let i = 0; i < 10 && !leased; i += 1) {
    r = await p.step({ verify });
    if (r.outcome === 'perform') assert.equal((await p.submit(r.perform, { files: { 'src/retry.js': '// done\n' } })).disposition, 'submitted');
  }
  const s = p.read();
  assert.deepEqual([leased, s.run.state, s.run.completion ?? null, r.outcome], [true, 'running', null, 'continue'], JSON.stringify(r.actions));
});

// RT-16: a request the launch refuses spent nothing. The granter's worker sleeps; its spawn request
// is recorded with 20 tokens reserved, and its prompt copy is then removed, so the child's
// `worker run` is refused at launch. The reserved tokens go back to the grant.
test('RT-16: a spawn request refused at launch refunds its reserved tokens to the grant', POSIX, async (t) => {
  const p: any = await project(t, {
    mode: 'auto', scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined }, probe: true, reserveTokens: 100,
    spawnGrant: { depth: 1, children: 1, tokens: 50 },
  });
  await p.step();
  const [granter] = Object.values(p.read().dispatches);
  assert.equal(granter.phase, 'launched');
  const prompt = path.join(granter.attempt.worktree, 'child-prompt.md');
  fs.writeFileSync(prompt, 'look something up');
  const workerEnv: any = {
    ...p.env, DOFLOW_RUN_ID: granter.workerIdentity.run, DOFLOW_LINEAGE_ID: granter.workerIdentity.lineage,
    DOFLOW_ATTEMPT: granter.workerIdentity.attempt, DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: granter.attempt.worktree,
  };
  const requested = requestSpawn({ slug: SLUG, promptFile: prompt, reserveTokens: 20, env: workerEnv, cwd: granter.attempt.worktree, root: p.root });
  assert.equal(requested.disposition, 'spawn-requested', JSON.stringify(requested));
  fs.rmSync(prompt);
  assert.equal(p.read().dispatches[granter.dispatchId].grant.used.tokens, 20);
  fs.rmSync(path.join(p.root, '.doflow', 'state', p.read().spawnRequests[requested.requestId].prompt));
  const stepped = await p.step();
  const s = p.read();
  assert.deepEqual([s.spawnRequests[requested.requestId].state, s.dispatches[granter.dispatchId].grant.used.tokens], ['refused', 0], JSON.stringify(stepped.actions));
});

// RR-3 / RR-4 (IC-033 launch, IC-030): a child run starts, and before its `launched` write the run
// is held or its granter leaves `launched`. The injected `now` seam plays that move on its first
// reading once the child's 081 run is in the run store (inside `worker run`, outside every dispatch
// lock), so the order is fixed. The `launched` write must then be refused, the child run cancelled
// and its child worktree removed, since no record names it.
async function childLaunchMoved(t: any, move: any) {
  const { cancelRun } = require(path.join(SRC, 'worker', 'cancel.ts'));
  // Registered before the sandbox, so it runs before the sandbox is removed: every 081 run still
  // alive is ended through 081.
  const live: any = {};
  t.after(async () => {
    if (!live.runStore || !fs.existsSync(live.runStore)) return;
    for (const run of Object.values(readRuns(live.runStore))) {
      if (run.phase === 'ended') continue;
      try { await cancelRun({ file: live.runStore, runId: run.runId, by: 'test', reason: 'test cleanup', env: live.env, cwd: live.root }); } catch { /* reported by the run */ }
    }
  });
  const p: any = await project(t, {
    mode: 'auto', scenario: SLEEPER, identity: { DOFLOW_ATTEMPT: undefined }, probe: true, reserveTokens: 100,
    spawnGrant: { depth: 1, children: 1, tokens: 50 },
  });
  const runStore = runStoreFileFor(p.root, SLUG);
  Object.assign(live, { runStore, env: p.env, root: p.root });
  await p.step();
  const [granter] = Object.values(p.read().dispatches);
  assert.equal(granter.phase, 'launched');
  const prompt = path.join(granter.attempt.worktree, 'child-prompt.md');
  fs.writeFileSync(prompt, 'look something up');
  const workerEnv: any = {
    ...p.env, DOFLOW_RUN_ID: granter.workerIdentity.run, DOFLOW_LINEAGE_ID: granter.workerIdentity.lineage,
    DOFLOW_ATTEMPT: granter.workerIdentity.attempt, DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: granter.attempt.worktree,
  };
  const requested = requestSpawn({ slug: SLUG, promptFile: prompt, reserveTokens: 20, env: workerEnv, cwd: granter.attempt.worktree, root: p.root });
  assert.equal(requested.disposition, 'spawn-requested', JSON.stringify(requested));
  fs.rmSync(prompt);
  const { requestId } = requested;
  let moved = false;
  const now = () => {
    if (!moved && Object.values(readRuns(runStore)).some((r) => r.request === requestId)) {
      moved = true;
      store.mutateDispatch(p.file, (s: any) => { move(s, granter.dispatchId); return { write: true, result: null }; });
    }
    return new Date();
  };
  const stepped = await p.step({ now });
  const label = JSON.stringify(stepped.actions);
  assert.ok(moved, `the child run started: ${label}`);
  const child = Object.values(readRuns(runStore)).find((r) => r.request === requestId);
  const worktree = path.join(p.root, require(path.join(SRC, 'dispatch', 'integrate.ts')).WORKTREES_DIR, requestId);
  return { p, requestId, child, worktree, stepped, label };
}

const HOLD = (s: any) => { s.run.state = 'cancelling'; };
const GRANTER_LEFT = (s: any, granterId: any) => { s.dispatches[granterId].phase = 'collected'; };

test('RR-3: a child launch whose launched write is refused removes the child worktree it made', POSIX, async (t) => {
  const { worktree, label } = await childLaunchMoved(t, HOLD);
  assert.equal(fs.existsSync(worktree), false, `the unrecorded child worktree is removed: ${label}`);
});

test('RR-5: a refused child launch whose cancel cleanup is not verified keeps the worktree, records it, and a later cancel lists it kept', POSIX, async (t) => {
  // The child tree is ended through the real escalation, but its verdict reads unverified.
  const processTree = require(path.join(SRC, 'worker', 'process-tree.ts'));
  const escalate = processTree.escalate;
  t.mock.method(processTree, 'escalate', async (args: any) => ({ ...(await escalate(args)), status: 'unknown', reason: 'test-unobserved' }));
  const { p, requestId, child, worktree, label } = await childLaunchMoved(t, GRANTER_LEFT);
  const runStore = runStoreFileFor(p.root, SLUG);
  assert.equal(readRuns(runStore)[child.runId].cleanup.status, 'unknown', label);
  assert.equal(fs.existsSync(worktree), true, `the child worktree is kept: ${label}`);
  const r = p.read().spawnRequests[requestId];
  assert.deepEqual([r.worktree, r.childRunId], [worktree, child.runId], `the request names the kept worktree and its run: ${label}`);
  await p.step();
  assert.equal(fs.existsSync(worktree), true, 'a later pass keeps it');
  const controls = require(path.join(SRC, 'dispatch', 'controls.ts'));
  const out = await controls.cancel({ slug: SLUG, env: p.env, cwd: p.root, by: 'main', reason: 'stop everything' });
  assert.equal(out.disposition, 'cancelled', JSON.stringify(out));
  assert.ok(out.worktrees.kept.some((k: any) => k.path === worktree && k.reason === 'worker-cleanup-unverified'), JSON.stringify(out.worktrees));
  assert.equal(out.cleanupVerified, false);
  assert.equal(fs.existsSync(worktree), true);
});

for (const [cause, move] of [['the run held cancelling', HOLD], ['the granter no longer launched', GRANTER_LEFT]]) {
  test(`RR-4: a child launch with ${cause} before its launched write is refused and its child run cancelled`, POSIX, async (t) => {
    const { p, requestId, child, label } = await childLaunchMoved(t, move);
    const r = p.read().spawnRequests[requestId];
    assert.deepEqual([r.state, r.childRunId ?? null, r.worktree ?? null], ['requested', null, null], `the launched write is refused: ${label}`);
    assert.ok(child, `one child run was started: ${label}`);
    assert.equal(readRuns(runStoreFileFor(p.root, SLUG))[child.runId].phase, 'ended', `the child run just started is cancelled: ${label}`);
    assert.ok(JSON.parse(label).some((a: any) => a.action === 'launch-child' && a.reason === `request-moved:${requestId} ${child.runId}`), label);
  });
}
