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
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const { readRuns, storeFileFor: runStoreFileFor } = require(path.join(SRC, 'worker', 'run-store.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createIntegrationWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const { requestSpawn } = require(path.join(SRC, 'dispatch', 'grants.ts'));
const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));

const SLUG = '082-loop-outcomes-fixture';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const SUCCESS = { type: 'result', status: 'success', summary: 'edited' };
const SLEEPER = { run: [{ sleep: 30000 }, { emit: SUCCESS }] };
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
const countingVerify = (n) => `const fs=require('fs');const f=process.env.VERIFY_COUNT;const c=(fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0)+1;fs.writeFileSync(f,String(c));process.exitCode=c>=${n}?1:0;`;
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

function git(cwd, env, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function project(t, {
  plan = 'budget', mode = 'sequential', concurrency = 2, scenario = {}, identity = {}, probe = false, attemptSeconds = 60,
  verify, declared = true, reserveTokens = null, budgetTokens, spawnGrant = null, extraEnv = {},
} = {}) {
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG, scenario, identity, ...(verify ? { verify } : {}) });
  const { root } = sb;
  const env = { ...sb.env, VERIFY_COUNT: path.join(sb.dir, 'verify-count'), ...extraEnv };
  const ledgerFile = attempts.storeFile(root, SLUG);
  const common = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const started = attempts.start({ ...common, by: 'main', ...(budgetTokens ? { budgetTokens } : {}) });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  store.mutateDispatch(file, (s) => {
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
  const options = (extra = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors: sb.descriptors, ...extra });
  const step = (extra) => loop.step(options(extra));
  const submit = (y, { files = {}, ...extra } = {}) => {
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(y.worktree, rel), text);
    return loop.submit(options({ dispatchId: y.dispatchId, status: 'success', summary: `done ${y.task}`, ...extra }));
  };
  /** Steps until `stop(result)` or `max` passes, performing each yield with `onPerform`. */
  const drive = async ({ stop = (r) => ['completed', 'blocked'].includes(r.outcome), onPerform = null, max = 40, wait = 100 } = {}) => {
    let r = null;
    for (let i = 0; i < max; i += 1) {
      r = await step();
      assert.equal(r.disposition, 'stepped', JSON.stringify(r));
      if (stop(r)) return r;
      if (r.outcome === 'perform') {
        assert.ok(onPerform, `unexpected perform: ${JSON.stringify(r.perform)}`);
        const s = await onPerform(r.perform);
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
  assert.ok(first.actions.some((a) => a.action === 'launch' && a.reason.startsWith('subagent')), JSON.stringify(first.actions));
  const [launched] = Object.values(p.read().dispatches);
  assert.equal(launched.phase, 'launched');
  const cancelled = attempts.cancel({ ...p.common, task: 'A.1', token: launched.token, by: 'main', reason: 'user stopped it' });
  assert.equal(cancelled.disposition, 'cancelled', JSON.stringify(cancelled));
  const second = await p.step();
  t.diagnostic(`stale case took ${Date.now() - started} ms`);
  const stale = second.actions.find((a) => a.action === 'stale');
  assert.equal(stale.reason, 'attempt-cancelled', JSON.stringify(second.actions));
  assert.ok(!second.actions.some((a) => a.action === 'integrate'), 'nothing is integrated');
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
  assert.ok(r.last.blocked.gaps.some((g) => g.task === 'A.1' && g.cause === 'budget'), JSON.stringify(r.last.blocked));
});

test('IC-026: every worker reporting success with failing final verification blocks final-verification-failed and never completes', POSIX, async (t) => {
  const p = await project(t, { plan: 'budget', mode: 'sequential', verify: countingVerify(2) });
  const r = await p.drive({ onPerform: (y) => p.submit(y, { files: { 'src/retry.js': '// done\n' } }) });
  assert.equal(r.outcome, 'blocked', JSON.stringify(r));
  assert.equal(attempts.inspect(p.common).tasks[0].state, 'SUCCEEDED', 'the task itself succeeded');
  const gap = r.blocked.gaps.find((g) => g.kind === 'final-verification-failed');
  assert.ok(gap, JSON.stringify(r.blocked));
  assert.equal(gap.cause, 'no-progress');
  assert.equal(r.blocked.cause, 'no-progress');
  assert.deepEqual(r.blocked.completed.map((c) => c.task), ['A.1']);
  const s = p.read();
  assert.equal(s.run.state, 'blocked');
  assert.equal(s.run.completion, undefined, 'no completion record');
  assert.equal(s.run.verifications.at(-1).exitCode, 1);
});

test('IC-027: an exhausted aggregate blocks with cause budget, the completed task and the unfinished task as a gap', POSIX, async (t) => {
  const p = await project(t, { plan: TWO_TASKS, mode: 'sequential', concurrency: 1, budgetTokens: 10, reserveTokens: 10 });
  const r = await p.drive({ onPerform: (y) => p.submit(y, { files: { 'src/a.js': '// a\n' }, tokens: 10, tokensBasis: 'measured' }) });
  assert.equal(r.outcome, 'blocked', JSON.stringify(r));
  assert.equal(r.blocked.cause, 'budget');
  assert.deepEqual(r.blocked.completed.map((c) => c.task), ['A.1']);
  assert.equal(r.blocked.integrated.length, 1);
  const gap = r.blocked.gaps.find((g) => g.task === 'A.2');
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
  assert.ok(r.blocked.gaps.some((g) => g.kind === 'verification-undeclared' && g.cause === 'input'), JSON.stringify(r.blocked));
  assert.deepEqual(p.read().dispatches, {});
  assert.equal(p.ledger().tasks?.['A.1']?.attempts?.length ?? 0, 0);
});

test('IC-024 / DEC-007: two equal failures block the task and plan.md stays byte-identical', POSIX, async (t) => {
  const p = await project(t, { plan: ONE_TASK, mode: 'sequential' });
  const planBefore = fs.readFileSync(p.sb.planFile);
  const r = await p.drive({ onPerform: (y) => p.submit(y, { status: 'failure', summary: 'could not do it', blockers: ['missing input'] }) });
  assert.equal(r.outcome, 'blocked', JSON.stringify(r));
  const [a1, a2] = p.ledger().tasks['A.1'].attempts;
  assert.deepEqual([a1.result, a2.result, a2.reason], ['FAILED', 'BLOCKED', 'worker-failure: repeated']);
  assert.equal(p.ledger().tasks['A.1'].attempts.length, 2);
  const gap = r.blocked.gaps.find((g) => g.task === 'A.1');
  assert.deepEqual([gap.kind, gap.cause], ['worker-failure', 'no-progress'], JSON.stringify(r.blocked));
  assert.deepEqual(fs.readFileSync(p.sb.planFile), planBefore, 'BLOCKED never edits plan.md');
  assert.ok(fs.existsSync(Object.values(p.read().dispatches)[0].attempt.worktree), 'a failed attempt worktree is kept until the run ends');
});

test('IC-033 / IC-028: a granted spawn request launches a child run whose usage adds to its granter; measurement splits tokens by basis and records durations and peaks', POSIX, async (t) => {
  const started = Date.now();
  const scenario = { run: [{ doflow: { args: [] } }, { emit: { type: 'usage', tokens: 40 } }, { emit: SUCCESS }] };
  const p = await project(t, {
    mode: 'auto', scenario, identity: { DOFLOW_ATTEMPT: undefined }, probe: true, reserveTokens: 100,
    spawnGrant: { depth: 1, children: 1, tokens: 50 },
    extraEnv: { FAKE_DOFLOW_CLI: 'pending', CHILD_DONE: 'pending' },
  });
  // The gate script lives in the sandbox, so its paths are set once the sandbox exists.
  p.env.FAKE_DOFLOW_CLI = path.join(p.sb.dir, 'gate.js');
  p.env.CHILD_DONE = path.join(p.sb.dir, 'child-done');
  fs.writeFileSync(p.env.FAKE_DOFLOW_CLI, GATE);

  const first = await p.step();
  assert.ok(first.actions.some((a) => a.action === 'launch' && a.reason.startsWith('subagent')), JSON.stringify(first.actions));
  const [granter] = Object.values(p.read().dispatches);
  assert.deepEqual(granter.grant, { depth: 1, children: 1, tokens: 50, used: { children: 0, tokens: 0 } });
  const handoff = JSON.parse(fs.readFileSync(path.join(p.root, '.doflow', 'state', granter.envelopes.handoff), 'utf8'));
  assert.equal(handoff.report.spawn[0], 'dispatch');

  // The worker's own `dispatch --action spawn`, in process with its identity.
  const prompt = path.join(granter.attempt.worktree, 'child-prompt.md');
  fs.writeFileSync(prompt, 'look something up');
  const workerEnv = {
    ...p.env, DOFLOW_RUN_ID: granter.workerIdentity.run, DOFLOW_LINEAGE_ID: granter.workerIdentity.lineage,
    DOFLOW_ATTEMPT: granter.workerIdentity.attempt, DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: granter.attempt.worktree,
  };
  const requested = requestSpawn({ slug: SLUG, promptFile: prompt, reserveTokens: 20, env: workerEnv, cwd: granter.attempt.worktree, root: p.root });
  assert.equal(requested.disposition, 'spawn-requested', JSON.stringify(requested));
  fs.rmSync(prompt);

  const r = await p.drive({ stop: (x) => ['completed', 'blocked'].includes(x.outcome) });
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
  const verify = async (args) => {
    const result = await runVerification(args);
    if (args.taskId !== SLUG) return result;
    store.mutateDispatch(p.file, (s) => { s.run.state = 'resume-required'; s.run.resumeReason = 'driver-lost'; return { write: true, result: null }; });
    return { ...result, exitCode: 1 };
  };
  let r = null;
  for (let i = 0; i < 10; i += 1) {
    r = await p.step({ verify });
    if (r.outcome === 'perform') { assert.equal((await p.submit(r.perform, { files: { 'src/retry.js': '// done\n' } })).disposition, 'submitted'); continue; }
    if (r.actions.some((a) => a.action === 'verify' && String(a.reason).startsWith('final-'))) break;
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
  assert.ok(s.drivers.some((d) => d.endReason === 'threw' && d.endedAt), JSON.stringify(s.drivers));
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
      if (entry && entry.attempts && entry.attempts.some((a) => a.state === 'active')) {
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
