'use strict';

// Feature 082 C.3 (IC-003, IC-004, IC-005, IC-022, IC-026; DEC-001, DEC-010, DEC-017, DEC-029,
// DEC-048, DEC-052): the loop's step order, perform yield and submit, mode selection with the
// static gate, a subagent attempt through the fake CLI, and a refused launch's retry.
//
// Each case is a sandbox repository (test/helper/dispatch-sandbox.js) with a started 080 run, an
// integration worktree made by B.4's createIntegrationWorktree and a seeded dispatch run (C.5's
// `start` is not part of this task). The child PATH is the sandbox's scratch bin/ alone (fake CLI
// links, node and git, never dirname(process.execPath), DEC-056); the five DOFLOW_* identity
// variables are set by the sandbox, with DOFLOW_ATTEMPT deleted where a worker is launched so the
// caller is not the unit its worker becomes. A "test performer" plays the main session: it edits
// the perform yield's worktree by path and calls `submit`. POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createIntegrationWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));

const SLUG = '082-loop-step-fixture';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const SUCCESS = { type: 'result', status: 'success', summary: 'edited' };
const PHASE_ACTIONS = ['reconcile', 'admit', 'launch', 'integrate', 'verify', 'finish', 'decide'];

function git(cwd, env, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function callerState(root, env) {
  return {
    head: git(root, env, ['rev-parse', 'HEAD']),
    ref: git(root, env, ['symbolic-ref', '-q', 'HEAD']),
    status: git(root, env, ['status', '--porcelain=v1', '--untracked-files=all']),
  };
}

/**
 * A sandbox with a started 080 run and a seeded dispatch run. `identity` overrides the sandbox's
 * DOFLOW_* values; `probe` probes the fake descriptors so a subagent is eligible.
 */
async function project(t, {
  plan = 'dependent', mode = 'sequential', concurrency = 2, scenario = {}, identity = {}, probe = false, attemptSeconds = 60,
} = {}) {
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG, scenario, identity });
  const { root } = sb;
  const env = { ...sb.env };
  for (const key of ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE']) assert.ok(env[key], `${key} is set`);
  const ledgerFile = attempts.storeFile(root, SLUG);
  const common = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const started = attempts.start({ ...common, by: 'main' });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  store.mutateDispatch(file, (s) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch, concurrency, mode,
      reserveTokens: null, attemptSeconds, harness: null, needs: [], spawnGrant: null, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 },
    };
    return { write: true, result: null };
  });
  if (probe) assert.equal((await readiness.probe({ descriptors: sb.descriptors, env, cwd: root })).disposition, 'probed');
  const read = () => store.readDispatch(file);
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const options = (extra = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors: sb.descriptors, ...extra });
  const step = (extra) => loop.step(options(extra));
  /** The test performer: writes `files` into the yielded worktree, then submits. */
  const perform = (yieldOf, files = {}, extra = {}) => {
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(yieldOf.worktree, rel), text);
    return loop.submit(options({ dispatchId: yieldOf.dispatchId, status: 'success', summary: `done ${yieldOf.task}`, ...extra }));
  };
  return { sb, root, env, file, ledgerFile, common, started, integration, read, ledger, options, step, perform, before: callerState(root, env) };
}

const states = (p) => Object.fromEntries(attempts.inspect({ ...p.common }).tasks.map((r) => [r.id, r.state]));

test('IC-003: dependent.md in sequential mode admits A.3 only after A.1 and A.2 SUCCEEDED, records each phase and completes with final evidence', POSIX, async (t) => {
  const started = Date.now();
  const p = await project(t, { plan: 'dependent', mode: 'sequential' });
  const performed = [];
  const seen = new Set();
  let last = null;
  for (let i = 0; i < 20 && (!last || last.outcome !== 'completed'); i += 1) {
    last = await p.step();
    assert.equal(last.disposition, 'stepped', JSON.stringify(last));
    for (const a of last.actions) seen.add(a.action);
    assert.equal(last.actions[0].action, 'reconcile', 'reconcile runs first');
    assert.equal(last.actions.at(-1).action, 'decide', 'decide runs last');
    if (last.outcome === 'perform') {
      const y = last.perform;
      if (y.task === 'A.3') assert.deepEqual([states(p)['A.1'], states(p)['A.2']], ['SUCCEEDED', 'SUCCEEDED'], 'A.3 waits for both');
      performed.push(y.task);
      const file = { 'A.1': 'src/one.js', 'A.2': 'src/two.js', 'A.3': 'src/join.js' }[y.task];
      const submitted = await p.perform(y, { [file]: `// ${y.task} done\n` });
      assert.equal(submitted.disposition, 'submitted', JSON.stringify(submitted));
    }
  }
  t.diagnostic(`dependent sequential run completed in ${Date.now() - started} ms`);
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last));
  assert.deepEqual(performed, ['A.1', 'A.2', 'A.3']);
  for (const name of PHASE_ACTIONS) assert.ok(seen.has(name), `a step recorded '${name}'`);

  const s = p.read();
  assert.equal(s.run.state, 'completed');
  const c = last.completion;
  assert.equal(c.finalVerification.exitCode, 0);
  assert.match(c.finalVerification.evidenceId, /\S/);
  assert.deepEqual(c.tasks.map((x) => x.id), ['A.1', 'A.2', 'A.3']);
  assert.ok(c.tasks.every((x) => /^[0-9a-f]{40,64}$/.test(x.integratedCommit)));
  assert.equal(c.integration.head, git(p.integration.worktree, p.env, ['rev-parse', 'HEAD']));
  assert.equal(fs.readFileSync(path.join(p.integration.worktree, 'src', 'join.js'), 'utf8'), '// A.3 done\n');
  assert.ok(s.steps.length >= 4 && s.steps.every((r, i) => r.step === i + 1), 'one step record per pass');
  assert.deepEqual(s.run.verifications.at(-1).evidenceId, c.finalVerification.evidenceId);
  for (const d of Object.values(s.dispatches)) assert.equal(d.removal && d.removal.verified, true, `${d.dispatchId} worktree removed`);
  assert.deepEqual(callerState(p.root, p.env), p.before, 'the caller checkout is never written');

  const again = await p.step();
  assert.deepEqual([again.outcome, again.actions], ['completed', []], 'a completed run does nothing else');
});

test('IC-005: the perform yield carries task, token, worktree and handoff; a second main-session dispatch waits main-session-busy; submit argv and result', POSIX, async (t) => {
  const p = await project(t, { plan: 'disjoint', mode: 'sequential', concurrency: 2 });
  const r = await p.step();
  assert.equal(r.outcome, 'perform', JSON.stringify(r));
  const y = r.perform;
  assert.deepEqual([y.task, y.token, y.mode], ['A.1', 1, 'sequential']);
  assert.match(y.dispatchId, /^d-[0-9a-f]{12}$/);
  assert.equal(y.branch, `doflow-attempt/${SLUG}/${y.dispatchId}`);
  assert.equal(y.base, p.integration.head);
  assert.ok(fs.statSync(y.worktree).isDirectory());
  const bytes = fs.readFileSync(y.handoff.path);
  assert.equal(y.handoff.bytes, bytes.length);
  assert.match(y.handoff.sha256, /^[0-9a-f]{64}$/);
  const handoff = JSON.parse(bytes);
  assert.equal(handoff.schema, 'doflow-handoff-v1');
  assert.deepEqual([handoff.task.id, handoff.mode, handoff.budget.attemptSeconds, handoff.worktree.path], ['A.1', 'sequential', null, y.worktree]);
  assert.ok(!bytes.toString('utf8').includes(p.sb.verifyArgv[2]), 'the handoff carries no verification argv');
  assert.deepEqual(y.submit, ['dispatch', '--action', 'submit', '--slug', SLUG, '--dispatch', y.dispatchId, '--status', '<success|failure>', '--summary', '<text>']);
  const busy = r.actions.find((a) => a.task === 'A.2' && a.action === 'admit');
  assert.equal(busy.reason, 'skipped:main-session-busy', JSON.stringify(r.actions));
  assert.equal(Object.values(p.read().dispatches).length, 1);

  // Yielded again while it awaits its submit.
  const waiting = await p.step();
  assert.deepEqual([waiting.outcome, waiting.perform.dispatchId], ['perform', y.dispatchId]);

  const submitted = await p.perform(y, { 'src/a.js': '// a done\n' }, { summary: 'token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 done', tokens: 12, tokensBasis: 'estimated' });
  assert.equal(submitted.disposition, 'submitted', JSON.stringify(submitted));
  assert.deepEqual(submitted.changes, [{ path: 'src/a.js', change: 'M', from: null }]);
  assert.deepEqual(submitted.undeclared, []);
  const result = JSON.parse(fs.readFileSync(submitted.result.path, 'utf8'));
  assert.equal(result.outcome, 'offered');
  assert.ok(!result.summary.includes('sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'), 'the summary is masked');
  const d = p.read().dispatches[y.dispatchId];
  assert.deepEqual([d.phase, d.report, d.usage], ['collected', { status: 'success', performer: 'main' }, { tokens: 12, basis: 'estimated' }]);
  const twice = await p.perform(y);
  assert.deepEqual([twice.disposition, twice.reason, twice.phase], ['refused', 'dispatch-not-awaiting', 'collected']);

  const next = await p.step();
  assert.ok(next.actions.some((a) => a.action === 'integrate' && a.reason === 'completed'), JSON.stringify(next.actions));
  assert.equal(next.perform.task, 'A.2');
  assert.equal(next.measurement.tokens.main.estimated, 12);
});

test('IC-022 / DEC-052: under auto with the real registry the discover spy records exactly the codex call and every attempt is sequential with each gap', POSIX, async (t) => {
  const p = await project(t, { plan: 'dependent', mode: 'auto' });
  const calls = [];
  const r = await p.step({
    descriptors: undefined,
    evaluateImpl: (args) => {
      calls.push(args.harness);
      return {
        eligible: false,
        gaps: [
          { requirement: 'installed', result: 'unknown', reason: 'not-probed' },
          { requirement: 'runnable', result: 'unknown', reason: 'not-probed' },
        ],
      };
    },
  });
  assert.deepEqual(calls, ['codex']);
  assert.equal(r.outcome, 'perform', JSON.stringify(r));
  const d = p.read().dispatches[r.perform.dispatchId];
  assert.equal(d.mode, 'sequential');
  assert.equal(d.selection.policy, 'auto');
  assert.equal(d.selection.chosen, 'sequential');
  assert.ok(d.selection.candidates.length >= 8, JSON.stringify(d.selection));
  for (const c of d.selection.candidates) {
    assert.equal(c.eligible, false);
    if (c.harness === 'codex') {
      const requirements = c.gaps.map((g) => g.requirement);
      assert.ok(requirements.includes('installed') && requirements.includes('runnable'), `codex gaps: ${JSON.stringify(c.gaps)}`);
      assert.ok(!requirements.includes('isolated-edit'), `codex has no isolated-edit gap: ${JSON.stringify(c.gaps)}`);
      assert.deepEqual(requirements, ['installed', 'runnable'], JSON.stringify(c.gaps));
      continue;
    }
    const gap = c.gaps.find((g) => g.requirement === 'isolated-edit');
    assert.equal(gap.result, 'unknown', `${c.harness}: ${JSON.stringify(c.gaps)}`);
  }
  assert.equal(p.ledger().tasks['A.1'].attempts[0].mode, 'sequential');
  assert.equal(fs.existsSync(p.sb.log), false, 'no harness CLI was invoked');
});

test('IC-022 / DEC-048: with the claude fake supported the attempt runs subagent, the fake edits its worktree and run integrates the change', POSIX, async (t) => {
  const started = Date.now();
  const scenario = { run: [{ write: { path: 'src/retry.js', content: '// retried\n' } }, { emit: { type: 'usage', tokens: 30 } }, { emit: SUCCESS }] };
  const p = await project(t, { plan: 'budget', mode: 'auto', scenario, identity: { DOFLOW_ATTEMPT: undefined }, probe: true });
  assert.equal(Object.hasOwn(p.env, 'DOFLOW_ATTEMPT'), false, 'DOFLOW_ATTEMPT is deleted');
  const r = await loop.run(p.options({ maxSeconds: 60 }));
  t.diagnostic(`subagent run completed in ${Date.now() - started} ms over ${r.steps} steps`);
  assert.equal(r.disposition, 'ran', JSON.stringify(r));
  assert.equal(r.outcome, 'completed', JSON.stringify(r.last.blocked || r.last.actions));
  assert.equal(r.timeUp, false);
  const [d] = Object.values(p.read().dispatches);
  assert.deepEqual([d.mode, d.harness, d.disposition], ['subagent', 'claude', 'completed']);
  assert.equal(d.selection.chosen, 'claude');
  assert.match(d.workerRunId, /^w-[0-9a-f]{12}$/);
  assert.equal(d.workerIdentity.attempt, String(d.token));
  assert.deepEqual(d.usage, { tokens: 30, basis: 'measured' });
  assert.equal(Date.parse(d.deadline) - Date.parse(d.launchedAt), 60000);
  assert.equal(fs.readFileSync(path.join(p.integration.worktree, 'src', 'retry.js'), 'utf8'), '// retried\n');
  assert.equal(git(p.integration.worktree, p.env, ['log', '-1', '--format=%an', 'HEAD']), 'DoFlow dispatch');
  assert.equal(p.ledger().tasks['A.1'].attempts[0].mode, 'subagent');
  const handoff = JSON.parse(fs.readFileSync(path.join(p.root, '.doflow', 'state', d.envelopes.handoff), 'utf8'));
  assert.deepEqual([handoff.mode, handoff.budget.attemptSeconds, handoff.report.parser], ['subagent', 60, 'doflow-jsonl-v1']);
  const runArgv = fs.readFileSync(p.sb.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).argv).filter((a) => a[0] === '--edit-in-cwd');
  assert.equal(runArgv.length, 1, 'one edit run');
  assert.deepEqual(callerState(p.root, p.env), p.before);
});

test('IC-022: a refused launch fails as launch, is never relabelled, and the retry runs sequential', POSIX, async (t) => {
  // DOFLOW_ATTEMPT stays '1', so the caller is the unit a token-1 worker would be: 081 refuses
  // `identity-collision` after the claim (081 IC-011 step 9).
  const p = await project(t, { plan: 'budget', mode: 'auto', scenario: { run: [{ emit: SUCCESS }] }, probe: true });
  const first = await p.step();
  const launch = first.actions.find((a) => a.action === 'launch');
  assert.equal(launch.reason, 'refused:identity-collision', JSON.stringify(first.actions));
  assert.equal(first.outcome, 'continue', JSON.stringify(first));
  const second = await p.step();
  assert.equal(second.outcome, 'perform', JSON.stringify(second));
  const ds = Object.values(p.read().dispatches).sort((a, b) => a.token - b.token);
  assert.deepEqual(ds.map((d) => [d.token, d.mode, d.disposition, d.failureClass]), [[1, 'subagent', 'failed', 'launch'], [2, 'sequential', null, null]]);
  const [a1, a2] = p.ledger().tasks['A.1'].attempts;
  assert.deepEqual([a1.mode, a1.result], ['subagent', 'FAILED']);
  assert.match(a1.reason, /^launch: identity-collision/);
  assert.equal(a2.mode, 'sequential');
});
