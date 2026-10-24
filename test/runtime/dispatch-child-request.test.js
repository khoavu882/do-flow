'use strict';

// Feature 082 (IC-015, DEC-062, DEC-063; RT-15): `worker run --child-of <w-id> --request
// <d-id>.c<n>` refuses a `--request` that differs from the child worktree's basename
// (`request-mismatch`), and, when the slug has a dispatch run, one that names no `requested` spawn
// request of the dispatch whose worker run is the granter (`unknown-request`). A refusal inserts
// no run.
//
// Each case is a sandbox repository (test/helper/dispatch-sandbox.js) with a started 080 run, a
// subagent claim on an attempt worktree made by createAttemptWorktree, and a live granter edit run
// of the fake claude CLI (editDescriptors()) that sleeps; the dispatch store is hand-seeded with a
// running dispatch run whose launched dispatch names that granter. The child PATH is the sandbox's
// scratch bin/ alone, never dirname(process.execPath) (DEC-056). POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { executeWorkerCommand } = require(path.join(SRC, 'worker', 'command.ts'));
const { storeFileFor, readRuns } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { cancelRun } = require(path.join(SRC, 'worker', 'cancel.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createAttemptWorktree, createChildWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));

const SLUG = '082-child-request-fixture';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const SLEEP = { run: [{ sleep: 30000 }] };
const OTHER = 'd-0000000000ff';

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

async function project(t) {
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG, scenario: SLEEP, identity: { DOFLOW_ATTEMPT: undefined } });
  const { root, env } = sb;
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
  const run = (options = {}) => executeWorkerCommand({ descriptors, env, cwd: root, slug: SLUG, action: 'run', harness: 'claude', task: 'A.1', token, promptFile, timeoutSeconds: 60, ...options });
  const granted = await run({ edit: true });
  assert.equal(granted.exit, 0, JSON.stringify(granted.body));
  const granter = granted.body.runId;
  const childWorktree = (n) => createChildWorktree({ root, slug: SLUG, dispatchId, n, base, env }).worktree;
  const child = (n, request, worktree = childWorktree(n)) => run({ childOf: granter, request, execWorktree: worktree });

  /** The dispatch store: a running run, the launched dispatch whose worker is the granter, and spawn requests. */
  const seedDispatch = (spawnRequests) => {
    const req = (id, granterDispatchId, state) => [id, { requestId: id, granterDispatchId, state, reason: null, childRunId: null, identity: null, endState: null, report: null }];
    const value = {
      version: 1, revision: 1, slug: SLUG,
      run: { dispatchRunId: 'p-000000000000', runKey: claimed.runKey ?? null, state: 'running' },
      dispatches: {
        [dispatchId]: { dispatchId, task: 'A.1', token, epoch: 1, phase: 'launched', mode: 'subagent', seq: 2, workerRunId: granter, attempt: { worktree: attempt.worktree, base } },
      },
      drivers: [], lease: null, steps: [],
      spawnRequests: Object.fromEntries(spawnRequests.map(([id, g, s]) => req(id, g, s))),
    };
    const file = store.storeFileFor(root, SLUG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };

  const stop = async () => {
    const runs = Object.values(readRuns(runStore)).sort((a, b) => (a.childOf ? 0 : 1) - (b.childOf ? 0 : 1));
    for (const r of runs) {
      if (r.phase === 'ended' || !r.caller) continue;
      await cancelRun({ file: runStore, runId: r.runId, by: 'test', reason: 'cleanup', env, cwd: root });
      await waitEnded(runStore, r.runId);
    }
  };
  return { sb, root, dispatchId, runStore, granter, child, childWorktree, seedDispatch, stop };
}

async function withProject(t, fn) {
  const p = await project(t);
  try {
    await fn(p);
  } finally {
    await p.stop();
  }
}

function assertRefused(result, reason) {
  assert.equal(result.exit, 1, JSON.stringify(result.body));
  assert.deepEqual([result.body.disposition, result.body.reason], ['refused', reason], JSON.stringify(result.body));
}

test('IC-015 (RT-15): a --request that differs from the child worktree basename is request-mismatch, with or without a dispatch run', POSIX, (t) => withProject(t, async (p) => {
  const before = fs.readFileSync(p.runStore);
  // No dispatch run.
  assertRefused(await p.child(1, `${p.dispatchId}.c2`), 'request-mismatch');
  // With a dispatch run whose c2 is requested: c2 still does not name worktree c3.
  p.seedDispatch([[`${p.dispatchId}.c2`, p.dispatchId, 'requested']]);
  assertRefused(await p.child(3, `${p.dispatchId}.c2`), 'request-mismatch');
  assert.deepEqual(fs.readFileSync(p.runStore), before, 'no run was inserted');
}));

test('IC-015 (RT-15): with a dispatch run, --request must name a requested spawn request of the granter dispatch', POSIX, (t) => withProject(t, async (p) => {
  const d = p.dispatchId;
  p.seedDispatch([
    [`${d}.c1`, d, 'requested'],
    [`${d}.c2`, d, 'launched'],
    [`${d}.c3`, d, 'refused'],
    [`${d}.c4`, OTHER, 'requested'],
  ]);
  const before = fs.readFileSync(p.runStore);
  assertRefused(await p.child(2, `${d}.c2`), 'unknown-request');
  assertRefused(await p.child(3, `${d}.c3`), 'unknown-request');
  assertRefused(await p.child(4, `${d}.c4`), 'unknown-request');
  assertRefused(await p.child(5, `${d}.c5`), 'unknown-request');
  assert.deepEqual(fs.readFileSync(p.runStore), before, 'no refusal inserted a run');

  // The granter's own requested request starts.
  const started = await p.child(1, `${d}.c1`);
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  assert.equal(started.body.disposition, 'started');
  assert.equal(readRuns(p.runStore)[started.body.runId].request, `${d}.c1`);
}));

test('IC-015 (RT-15): with a dispatch run, a granter that is no dispatch\'s worker names no request', POSIX, (t) => withProject(t, async (p) => {
  const d = p.dispatchId;
  p.seedDispatch([[`${d}.c1`, d, 'requested']]);
  const file = store.storeFileFor(p.root, SLUG);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.dispatches[d].workerRunId = 'w-000000000000';
  fs.writeFileSync(file, JSON.stringify(value));
  const before = fs.readFileSync(p.runStore);
  assertRefused(await p.child(1, `${d}.c1`), 'unknown-request');
  assert.deepEqual(fs.readFileSync(p.runStore), before);
}));
