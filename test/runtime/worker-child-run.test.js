'use strict';

// Feature 082 B.2 (IC-015; DEC-028, DEC-041, DEC-062): `worker --action run --child-of <w-id>
// --request <d-id>.c<n> --exec-worktree <path>` in src/runtime/worker/command.ts, the child key in
// run-store.ts and the child skip in cancel.ts.
//
// Each case is a sandbox repository (test/helper/dispatch-sandbox.js) with a started 080 run, a
// subagent claim on an attempt worktree made by B.4's createAttemptWorktree, and a live granter: an
// edit run of the fake claude CLI (editDescriptors()) that sleeps. Children run in child worktrees
// made by createChildWorktree. The child PATH is the sandbox's scratch bin/ alone (fake CLI links,
// node and git, never dirname(process.execPath), DEC-056); the five DOFLOW_* identity variables
// are set or deleted explicitly (DOFLOW_ATTEMPT deleted). POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { executeWorkerCommand, findRun } = require(path.join(SRC, 'worker', 'command.ts'));
const { storeFileFor, readRuns, insertRun, newRunId } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { cancelRun } = require(path.join(SRC, 'worker', 'cancel.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createAttemptWorktree, createChildWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));

const SLUG = '082-child-run-fixture';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const SLEEP = { run: [{ sleep: 30000 }] };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitEnded(file, runId, ms = 15000) {
  const until = Date.now() + ms;
  let run = readRuns(file)[runId];
  while (run && run.phase !== 'ended' && Date.now() < until) {
    await sleep(100);
    run = readRuns(file)[runId];
  }
  return run;
}

/** A sandbox with a live granter edit run on A.1 and a child-run helper. */
async function project(t) {
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG, scenario: SLEEP, identity: { DOFLOW_ATTEMPT: undefined } });
  const { root, env } = sb;
  for (const key of ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE']) assert.ok(env[key], `${key} is set`);
  assert.equal(Object.hasOwn(env, 'DOFLOW_ATTEMPT'), false, 'DOFLOW_ATTEMPT is deleted');
  const descriptors = { claude: sb.descriptors.claude, gemini: sb.descriptors.gemini };
  const ledger = attempts.storeFile(root, SLUG);
  const common = { file: ledger, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  assert.equal((await readiness.probe({ descriptors, env, cwd: root })).disposition, 'probed');
  const base = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).stdout.trim();
  const dispatchId = store.newDispatchId();
  const attempt = createAttemptWorktree({ root, slug: SLUG, dispatchId, base, env });
  const claimed = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree: attempt.worktree });
  assert.equal(claimed.disposition, 'claimed', JSON.stringify(claimed));
  const token = claimed.token;
  const promptFile = path.join(sb.dir, 'prompt.md');
  fs.writeFileSync(promptFile, 'read and report');
  const runStore = storeFileFor(root, SLUG);
  const cmd = (options) => executeWorkerCommand({ descriptors, env, cwd: root, slug: SLUG, ...options });
  const run = (options = {}) => cmd({ action: 'run', harness: 'claude', task: 'A.1', token, promptFile, timeoutSeconds: 60, ...options });

  const granted = await run({ edit: true });
  assert.equal(granted.exit, 0, JSON.stringify(granted.body));
  assert.equal(granted.body.phase, 'running');
  const granter = granted.body.runId;
  let n = 0;
  /** A fresh child worktree `<d-id>.c<n>` and its request id. */
  const childWorktree = () => {
    n += 1;
    const wt = createChildWorktree({ root, slug: SLUG, dispatchId, n, base, env });
    return { ...wt, request: `${dispatchId}.c${n}` };
  };
  const child = (wt, options = {}) => run({ childOf: granter, request: wt.request, execWorktree: wt.worktree, ...options });
  const attemptState = () => JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks['A.1'].attempts.find((a) => a.token === token).state;

  /** Ends every live run, children first, through 081's cancel. Called in each test's `finally`:
   * tmp.js's t.after removes the sandbox before a later-registered hook would run. */
  const stop = async () => {
    const runs = Object.values(readRuns(runStore)).sort((a, b) => (a.childOf ? 0 : 1) - (b.childOf ? 0 : 1));
    for (const r of runs) {
      if (r.phase === 'ended' || !r.caller) continue; // a hand-seeded record has no process
      await cancelRun({ file: runStore, runId: r.runId, by: 'test', reason: 'cleanup', env, cwd: root });
      await waitEnded(runStore, r.runId);
    }
  };
  return { sb, root, env, token, dispatchId, attempt, runStore, cmd, run, granter, childWorktree, child, attemptState, stop };
}

/** `fn(p)` on a fresh project, every live run ended afterwards whatever `fn` did. */
async function withProject(t, fn) {
  const p = await project(t);
  try {
    await fn(p);
  } finally {
    await p.stop();
  }
}

test('IC-015: children of a live granter start run-scoped; a repeated request is run-exists (DEC-062)', POSIX, (t) => withProject(t, async (p) => {
  const started = Date.now();
  const c1 = p.childWorktree();
  const first = await p.child(c1);
  t.diagnostic(`first child run returned in ${Date.now() - started} ms`);
  assert.equal(first.exit, 0, JSON.stringify(first.body));
  assert.equal(first.body.disposition, 'started');
  const runs = readRuns(p.runStore);
  const record = runs[first.body.runId];
  const granter = runs[p.granter];
  assert.equal(record.childOf, p.granter);
  assert.equal(record.request, c1.request);
  assert.equal(record.edit, null, 'a child is read-only');
  assert.equal(fs.realpathSync(record.execWorktree), fs.realpathSync(c1.worktree));
  assert.deepEqual(record.identity, { run: first.body.runId.slice(2), lineage: granter.identity.lineage, attempt: String(p.token), runSource: 'run-scoped' });
  assert.equal(granter.identity.runSource, 'claim');
  const unit = (r) => `L.${r.identity.run}.${r.identity.lineage}.${r.token}`;
  assert.notEqual(unit(record), unit(granter), 'the child runs as its own unit');
  assert.equal(record.recipe.argvShape[0], p.sb.descriptors.claude.readOnly.argv[0], 'a child launches the read-only recipe');

  const c2 = p.childWorktree();
  const second = await p.child(c2);
  assert.equal(second.exit, 0, JSON.stringify(second.body));
  assert.notEqual(second.body.runId, first.body.runId);

  const again = await p.child(c1);
  assert.equal(again.exit, 1);
  assert.deepEqual([again.body.reason, again.body.runId], ['run-exists', first.body.runId]);

  // status and findRun by (task, token) name the granter, never a child.
  const status = await p.cmd({ action: 'status', task: 'A.1', token: p.token });
  assert.deepEqual([status.exit, status.body.runId, status.body.childOf], [0, p.granter, null]);
  assert.equal(findRun(p.runStore, { task: 'A.1', token: p.token }).runId, p.granter);
  const childStatus = await p.cmd({ action: 'status', workerRun: first.body.runId });
  assert.equal(childStatus.body.childOf, p.granter);

  // Cancelling a child skips 080's cancel: the granter's attempt stays active.
  const cancelled = await p.cmd({ action: 'cancel', workerRun: first.body.runId, by: 'main', reason: 'enough' });
  assert.equal(cancelled.exit, 0, JSON.stringify(cancelled.body));
  assert.deepEqual(cancelled.body.attemptCancel, { disposition: 'skipped', reason: 'child-run' });
  assert.equal(cancelled.body.attemptCancelled, false);
  assert.equal(p.attemptState(), 'active');
  assert.equal(readRuns(p.runStore)[p.granter].phase, 'running', 'the granter still runs');
}));

test('IC-015: granter, depth and worktree refusals write nothing', POSIX, (t) => withProject(t, async (p) => {
  const c1 = p.childWorktree();
  const first = await p.child(c1);
  assert.equal(first.exit, 0, JSON.stringify(first.body));
  // A top-level run on another token of A.1, so the token checks of steps 2 to 7 still pass for the child.
  const other = newRunId();
  assert.equal(insertRun(p.runStore, { runId: other, task: 'A.1', token: p.token + 1, phase: 'running', execWorktree: p.attempt.worktree, childOf: null }).applied, true);
  const before = fs.readFileSync(p.runStore);
  const c2 = p.childWorktree();
  const cases = [
    ['granter-mismatch', { childOf: other }],
    ['granter-mismatch', { childOf: 'w-000000000000' }],
    ['depth-exceeded', { childOf: first.body.runId }],
    ['exec-worktree-missing', { execWorktree: path.join(p.sb.dir, 'absent') }],
    ['exec-worktree-not-child', { execWorktree: p.attempt.worktree }],
  ];
  for (const [reason, options] of cases) {
    const { exit, body } = await p.child(c2, options);
    assert.equal(exit, 1, JSON.stringify(body));
    assert.deepEqual([body.disposition, body.reason], ['refused', reason], JSON.stringify(body));
  }
  assert.deepEqual(fs.readFileSync(p.runStore), before, 'no refusal wrote the run store');
}));

test('IC-015: a child timeout ends the child and leaves the granter attempt active', POSIX, (t) => withProject(t, async (p) => {
  const started = Date.now();
  const { exit, body } = await p.child(p.childWorktree(), { timeoutSeconds: 1, wait: true });
  t.diagnostic(`child run --wait with a 1 s timeout returned in ${Date.now() - started} ms`);
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.state, 'timed-out', JSON.stringify(body));
  assert.deepEqual(body.attemptCancel, { disposition: 'skipped', reason: 'child-run' });
  assert.equal(p.attemptState(), 'active');
  assert.equal(readRuns(p.runStore)[p.granter].phase, 'running');
}));

test('IC-015: --child-of flag rules are exit 2 usage', async (t) => {
  const sb = makeDispatchSandbox(t, { slug: SLUG, identity: { DOFLOW_ATTEMPT: undefined } });
  const promptFile = path.join(sb.dir, 'prompt.md');
  fs.writeFileSync(promptFile, 'x');
  const base = { action: 'run', descriptors: sb.descriptors, env: sb.env, cwd: sb.root, slug: SLUG, harness: 'claude', task: 'A.1', token: 1, promptFile };
  const id = `${store.newDispatchId()}.c1`;
  const bad = [
    { childOf: 'w-000000000000', execWorktree: sb.root },
    { childOf: 'w-000000000000', request: id },
    { childOf: 'w-000000000000', request: id, execWorktree: sb.root, edit: true },
    { childOf: 'w-000000000000', request: 'd-1.c1', execWorktree: sb.root },
    { childOf: 'w-XYZ', request: id, execWorktree: sb.root },
    { request: id },
    { execWorktree: sb.root },
    { action: 'status', childOf: 'w-000000000000', workerRun: 'w-000000000000' },
  ];
  for (const options of bad) {
    const { exit, body } = await executeWorkerCommand({ ...base, ...options });
    assert.deepEqual([exit, body.error], [2, 'usage'], JSON.stringify({ options, body }));
  }
  assert.equal(fs.existsSync(storeFileFor(sb.root, SLUG)), false);
});
