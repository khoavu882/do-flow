'use strict';

// Feature 082 B.2 (IC-014; DEC-020, DEC-021, DEC-046, DEC-048): `worker --action run --edit` in
// src/runtime/worker/command.ts and its isolation check in supervisor.ts.
//
// Each case is a sandbox repository (test/helper/dispatch-sandbox.js) with a started 080 run and a
// subagent claim whose execution worktree is a dispatch attempt worktree made by B.4's
// createAttemptWorktree under .doflow/state/dispatch-worktrees/d-<12 hex> on
// doflow-attempt/<slug>/<d-id>. The worker is the fake claude CLI with editDescriptors()'s
// supported isolatedEdit (argv ['--edit-in-cwd']). The child PATH is the sandbox's scratch bin/
// alone (fake CLI links, node and git, never dirname(process.execPath), DEC-056); the five DOFLOW_*
// identity variables are set or deleted explicitly (DOFLOW_ATTEMPT deleted, so the caller is not
// the unit its worker becomes). Branch moves are made by a scratch script the fake's `doflow` step
// runs. POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { executeWorkerCommand } = require(path.join(SRC, 'worker', 'command.ts'));
const { storeFileFor, readRuns } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { resultOfRun } = require(path.join(SRC, 'worker', 'supervisor.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createAttemptWorktree, WORKTREES_DIR } = require(path.join(SRC, 'dispatch', 'integrate.ts'));

const SLUG = '082-edit-run-fixture';
const POSIX: any = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const SUCCESS: any = { type: 'result', status: 'success', summary: 'edited' };
const MOVE_SCRIPT = [
  "'use strict';",
  "const { execFileSync } = require('node:child_process');",
  "const git = (args, extra = {}) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...extra } }).trim();",
  "const who = { GIT_AUTHOR_NAME: 'fake', GIT_AUTHOR_EMAIL: 'fake@invalid', GIT_COMMITTER_NAME: 'fake', GIT_COMMITTER_EMAIL: 'fake@invalid' };",
  "if (process.argv[2] === 'switch') git(['checkout', '-q', '-b', 'fake/elsewhere']);",
  "if (process.argv[2] === 'orphan-reset') git(['reset', '-q', '--hard', git(['commit-tree', git(['rev-parse', 'HEAD^{tree}']), '-m', 'orphan'], who)]);",
  '',
].join('\n');

function git(cwd: any, env: any, args: any) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** HEAD, branch and status of the caller checkout. */
function callerState(root: any, env: any) {
  return {
    head: git(root, env, ['rev-parse', 'HEAD']),
    ref: git(root, env, ['symbolic-ref', '-q', 'HEAD']),
    status: git(root, env, ['status', '--porcelain=v1', '--untracked-files=all']),
  };
}

/** A sandbox with a started 080 run, probed fakes and a claim helper. */
async function project(t: any, { scenario = {} }: any = {}) {
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG, scenario, identity: { DOFLOW_ATTEMPT: undefined } });
  const { root } = sb;
  const moveScript = path.join(sb.dir, 'git-move.js');
  fs.writeFileSync(moveScript, MOVE_SCRIPT);
  const env: any = {
    ...sb.env,
    FAKE_DOFLOW_CLI: moveScript,
    STRAY_TARGET: path.join(root, 'stray.txt'),
    STATE_TARGET: path.join(root, '.doflow', 'state', 'scratch', 'note.json'),
  };
  for (const key of ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE']) assert.ok(env[key], `${key} is set`);
  assert.equal(Object.hasOwn(env, 'DOFLOW_ATTEMPT'), false, 'DOFLOW_ATTEMPT is deleted');
  const descriptors: any = { claude: sb.descriptors.claude, gemini: sb.descriptors.gemini };
  const ledger = attempts.storeFile(root, SLUG);
  const common: any = { file: ledger, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  assert.equal((await readiness.probe({ descriptors, env, cwd: root })).disposition, 'probed');
  const promptFile = path.join(sb.dir, 'prompt.md');
  fs.writeFileSync(promptFile, 'edit the module');
  const runStore = storeFileFor(root, SLUG);
  const base = git(root, env, ['rev-parse', 'HEAD']);

  /** Claims `task` with `execWorktree`; returns its token. */
  const claimOn = (task: any, execWorktree: any) => {
    const c = attempts.claim({ ...common, task, owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree });
    assert.equal(c.disposition, 'claimed', JSON.stringify(c));
    return c.token;
  };
  /** An attempt worktree from the caller's HEAD, claimed on `task`. */
  const attempt = (task: any = 'A.1') => {
    const wt = createAttemptWorktree({ root, slug: SLUG, dispatchId: store.newDispatchId(), base, env });
    return { ...wt, token: claimOn(task, wt.worktree), task };
  };
  const run = (a: any, options: any = {}) => executeWorkerCommand({
    descriptors, env, cwd: root, slug: SLUG, action: 'run', harness: 'claude', task: a.task, token: a.token,
    promptFile, timeoutSeconds: 60, edit: true, ...options,
  });
  return { sb, root, env, base, runStore, claimOn, attempt, run, before: callerState(root, env) };
}

/** The run argv lines the fake logged (probe and version invocations dropped). */
function runArgvs(log: any) {
  return fs.readFileSync(log, 'utf8').trim().split('\n').map((line: any) => JSON.parse(line).argv)
    .filter((argv: any) => !argv.includes('--version') && !['probe', 'model-check'].includes(argv[0]));
}

test('IC-014: a worker editing its attempt worktree ends clean, offered, with the edit recipe argv', POSIX, async (t) => {
  const p = await project(t, { scenario: { run: [{ write: { path: 'src/a.js', content: 'edited\n' } }, { emit: SUCCESS }] } });
  const a = p.attempt();
  const started = Date.now();
  const { exit, body } = await p.run(a, { wait: true });
  t.diagnostic(`edit run --wait returned in ${Date.now() - started} ms`);
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.state, 'exited');
  assert.equal(body.isolation.status, 'clean', JSON.stringify(body.isolation));
  assert.equal(body.isolation.reason, null);
  assert.equal(body.readOnly, null, 'an edit run leaves readOnly null');
  assert.deepEqual([body.resultOffered, body.withheld], [true, []]);
  const record = readRuns(p.runStore)[body.runId];
  assert.deepEqual(record.edit, { base: p.base, branch: `refs/heads/${a.branch}`, callerTop: record.edit.callerTop });
  assert.equal(fs.realpathSync(record.edit.callerTop), fs.realpathSync(p.root));
  assert.equal(record.childOf, null);
  assert.equal(record.recipe.argvShape[0], '--edit-in-cwd');
  const argvs = runArgvs(p.sb.log);
  assert.equal(argvs.length, 1);
  assert.equal(argvs[0][0], '--edit-in-cwd', 'the isolatedEdit argv comes first');
  assert.ok(!argvs[0].includes(p.sb.descriptors.claude.readOnly.argv[0]), 'the readOnly argv is not used');
  assert.equal(fs.readFileSync(path.join(a.worktree, 'src', 'a.js'), 'utf8'), 'edited\n');
  assert.deepEqual(callerState(p.root, p.env), p.before);
  // DEC-048 negative-control target: the same record judged by readOnly would be withheld.
  assert.deepEqual(resultOfRun({ ...record, edit: null }).withheld, ['read-only-unverifiable']);
});

test('IC-014: a write into the caller checkout is violated outside-write and withheld', POSIX, async (t) => {
  const p = await project(t, { scenario: { run: [{ writeAt: { env: 'STRAY_TARGET', content: 'stray' } }, { emit: SUCCESS }] } });
  const { body } = await p.run(p.attempt(), { wait: true });
  assert.equal(body.isolation.status, 'violated', JSON.stringify(body.isolation));
  assert.equal(body.isolation.reason, 'outside-write');
  assert.ok(body.isolation.changes.some((c: any) => c.path === 'stray.txt'), JSON.stringify(body.isolation.changes));
  assert.deepEqual([body.resultOffered, body.withheld], [false, ['outside-write']]);
});

test('IC-014: a branch switch in the attempt worktree is branch-moved', POSIX, async (t) => {
  const p = await project(t, { scenario: { run: [{ doflow: { args: ['switch'] } }, { emit: SUCCESS }] } });
  const a = p.attempt();
  const { body } = await p.run(a, { wait: true });
  assert.equal(git(a.worktree, p.env, ['symbolic-ref', 'HEAD']), 'refs/heads/fake/elsewhere', 'the worker switched branch');
  assert.deepEqual([body.isolation.status, body.isolation.reason], ['violated', 'branch-moved'], JSON.stringify(body.isolation));
  assert.deepEqual([body.resultOffered, body.withheld], [false, ['branch-moved']]);
});

test('IC-014: a reset to a commit that does not descend from the base is branch-moved', POSIX, async (t) => {
  const p = await project(t, { scenario: { run: [{ doflow: { args: ['orphan-reset'] } }, { emit: SUCCESS }] } });
  const a = p.attempt();
  const { body } = await p.run(a, { wait: true });
  assert.equal(git(a.worktree, p.env, ['symbolic-ref', 'HEAD']), `refs/heads/${a.branch}`, 'the branch name is unchanged');
  assert.notEqual(git(a.worktree, p.env, ['rev-parse', 'HEAD']), p.base);
  assert.deepEqual([body.isolation.status, body.isolation.reason], ['violated', 'branch-moved'], JSON.stringify(body.isolation));
  assert.deepEqual(body.withheld, ['branch-moved']);
});

test('IC-014: a write under the caller\'s .doflow/state stays clean', POSIX, async (t) => {
  const p = await project(t, { scenario: { run: [{ writeAt: { env: 'STATE_TARGET', content: '{}' } }, { emit: SUCCESS }] } });
  const { body } = await p.run(p.attempt(), { wait: true });
  assert.equal(fs.readFileSync(p.env.STATE_TARGET, 'utf8'), '{}');
  assert.equal(body.isolation.status, 'clean', JSON.stringify(body.isolation));
  assert.equal(body.resultOffered, true);
});

test('IC-014: a worktree that is not a dispatch attempt worktree, or has no base file, is refused and writes nothing', POSIX, async (t) => {
  const p = await project(t);
  const plain = path.join(p.sb.dir, 'plain');
  git(p.root, p.env, ['worktree', 'add', '-q', '-b', 'plain', plain, 'HEAD']);
  const placed = path.join(p.root, WORKTREES_DIR, store.newDispatchId());
  git(p.root, p.env, ['worktree', 'add', '-q', '-b', 'other/x', placed, 'HEAD']);
  const missingBase = createAttemptWorktree({ root: p.root, slug: SLUG, dispatchId: store.newDispatchId(), base: p.base, env: p.env });
  fs.rmSync(path.join(missingBase.worktree, '.doflow-worktree-base'));
  const cases: any = [
    ['exec-worktree-not-attempt', { task: 'A.1', token: p.claimOn('A.1', plain) }],
    ['exec-worktree-not-attempt', { task: 'A.2', token: p.claimOn('A.2', placed) }],
    ['attempt-base-unreadable', { task: 'A.3', token: p.claimOn('A.3', missingBase.worktree) }],
  ];
  for (const [reason, a] of cases) {
    const { exit, body } = await p.run(a);
    assert.equal(exit, 1, JSON.stringify(body));
    assert.deepEqual([body.disposition, body.reason], ['refused', reason], JSON.stringify(body));
  }
  assert.equal(fs.existsSync(p.runStore), false, 'no refusal wrote a run');
});

test('IC-014: a run without --edit records readOnly and no isolation', POSIX, async (t) => {
  const p = await project(t, { scenario: { run: [{ emit: SUCCESS }] } });
  const { exit, body } = await p.run(p.attempt(), { wait: true, edit: false });
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.readOnly.status, 'clean', JSON.stringify(body.readOnly));
  assert.equal(body.isolation, null);
  assert.equal(body.edit, null);
  assert.equal(Object.hasOwn(readRuns(p.runStore)[body.runId], 'isolation'), false);
  assert.equal(body.resultOffered, true);
  assert.equal(runArgvs(p.sb.log)[0][0], p.sb.descriptors.claude.readOnly.argv[0]);
});

test('IC-013: describe and select take --edit', POSIX, async (t) => {
  const p = await project(t);
  const cmd = (options: any) => executeWorkerCommand({ descriptors: { claude: p.sb.descriptors.claude, gemini: p.sb.descriptors.gemini }, env: p.env, cwd: p.root, ...options });
  const described = await cmd({ action: 'describe', harness: 'gemini', edit: true });
  assert.equal(described.body.eligible, false);
  const gap = described.body.requirements.find((r: any) => r.requirement === 'isolated-edit');
  assert.deepEqual([gap.result, gap.reason], ['unknown', 'not-declared'], JSON.stringify(described.body.requirements));
  const selected = await cmd({ action: 'select', edit: true });
  assert.deepEqual([selected.exit, selected.body.harness], [0, 'claude']);
  const misplaced = await cmd({ action: 'status', edit: true, slug: SLUG, workerRun: 'w-000000000000' });
  assert.deepEqual([misplaced.exit, misplaced.body.error], [2, 'usage']);
});
