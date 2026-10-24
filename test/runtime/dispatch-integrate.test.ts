'use strict';

// Feature 082 B.4 (IC-016, IC-017, IC-018, IC-020, IC-021; DEC-004, DEC-014, DEC-022, DEC-023,
// DEC-036, DEC-049, DEC-050): integration in src/runtime/dispatch/integrate.ts, on a sandbox repo
// (test/helper/dispatch-sandbox.js) with a real 080 ledger and real git.
//
// Every child PATH is the sandbox's scratch bin/ (fake CLI links, node and git only, DEC-056); the
// five DOFLOW_* identity variables are set by the sandbox. Each verification argv starts with the
// absolute process.execPath. After every case the caller's HEAD, status, non-DoFlow branches and
// git settings are compared with their reading before the case. POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { start, claim } = require(path.join(SRC, 'task-attempts.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { storeRules } = require(path.join(SRC, 'worker', 'worktree-check.ts'));
const {
  createIntegrationWorktree, createAttemptWorktree, createChildWorktree, attemptCommit, diffNameStatus,
  integrateNext, undo, DISPATCH_IDENTITY, WORKTREES_DIR,
} = require(path.join(SRC, 'dispatch', 'integrate.ts'));

const SLUG = '082-integrate-fixture';
const POSIX: any = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const HOLDER: any = { pid: process.pid, start: null };

function git(cwd: any, env: any, args: any, { allowFailure = false }: any = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (!allowFailure && r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** What a case must leave as it found in the caller's repository. */
function callerState(root: any, env: any) {
  return {
    head: git(root, env, ['rev-parse', 'HEAD']),
    ref: git(root, env, ['symbolic-ref', '-q', 'HEAD']),
    status: git(root, env, ['status', '--porcelain=v1', '--untracked-files=all']),
    branches: git(root, env, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])
      .split('\n').filter((l: any) => l && !l.startsWith('refs/heads/doflow/') && !l.startsWith('refs/heads/doflow-attempt/')),
    settings: git(root, env, ['config', '--list']),
  };
}

function project(t: any, { exitCode = 0 }: any = {}) {
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
  const { root, env } = sb;
  const ledgerFile = path.join(root, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  const common: any = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  assert.equal(start({ ...common, by: 'main' }).disposition, 'started');
  const ctx: any = { ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const before = callerState(root, env);
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  const argv: any = [process.execPath, '-e', `process.exitCode = ${exitCode}`];
  store.mutateDispatch(file, (s: any) => {
    s.run = {
      dispatchRunId, state: 'running', runKey: null, epoch: 1, integration,
      verify: { argv, argvSha256: null, argvCount: argv.length, timeoutSeconds: 30 },
    };
    return { write: true, result: null };
  });

  /** One dispatch of `task`: admitted, its worktree cut from the integration head, claimed, launched,
   * `edit(worktree)` run as the worker, then collected with its attempt commit. */
  function dispatchOf(task: any, edit: any = () => {}) {
    const id = store.newDispatchId();
    const base = store.readDispatch(file).run.integration.head;
    store.mutateDispatch(file, (s: any) => {
      s.dispatches[id] = { dispatchId: id, task, phase: 'admitted', mode: 'subagent', reservation: { tokens: 50 }, admittedAt: new Date().toISOString() };
      return { write: true, result: null };
    });
    const wt = createAttemptWorktree({ root, slug: SLUG, dispatchId: id, base, env });
    const c = claim({ ...common, task, owner: 'core-implementer', mode: 'subagent', epoch: 1, reserveTokens: 50, execWorktree: wt.worktree });
    assert.equal(c.disposition, 'claimed', JSON.stringify(c));
    store.transitionDispatch(file, id, ['admitted'], (d: any) => Object.assign(d, { phase: 'claimed', token: c.token, epoch: c.epoch, parentRunKey: c.runKey, attempt: wt }));
    store.transitionDispatch(file, id, ['claimed'], (d: any) => { d.phase = 'launched'; });
    edit(wt.worktree);
    const made = attemptCommit({ worktree: wt.worktree, base, dispatchId: id, task, token: c.token, env });
    const moved = store.transitionDispatch(file, id, ['launched'], (d: any) => Object.assign(d, {
      phase: 'collected', outcome: 'offered', commit: made.commit, changes: made.changes, collectedAt: new Date().toISOString(),
    }));
    assert.equal(moved.applied, true);
    return { id, wt, token: c.token, made, base };
  }

  const read = () => store.readDispatch(file);
  const attempts = (task: any) => JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).tasks[task].attempts;
  const integrate = (extra: any = {}) => integrateNext({ root, slug: SLUG, ctx, env, holder: HOLDER, ...extra });
  const branchHead = () => git(root, env, ['rev-parse', `refs/heads/${integration.branch}`]);
  const callerUnchanged = () => assert.deepEqual(callerState(root, env), before, 'the caller repository is unchanged');
  return { sb, root, env, ctx, file, integration, dispatchOf, read, attempts, integrate, branchHead, callerUnchanged };
}

const write = (wt: any, rel: any, text: any) => {
  fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  fs.writeFileSync(path.join(wt, rel), text);
};

test('IC-016: worktrees live under dispatch-worktrees with the per-kind branch names', POSIX, (t) => {
  const p = project(t);
  const runId = p.read().run.dispatchRunId;
  assert.equal(p.integration.worktree, path.join(p.root, WORKTREES_DIR, runId));
  assert.equal(p.integration.branch, `doflow/${SLUG}/${runId}`);
  assert.equal(git(p.integration.worktree, p.env, ['symbolic-ref', 'HEAD']), `refs/heads/doflow/${SLUG}/${runId}`);
  const id = store.newDispatchId();
  const child = createChildWorktree({ root: p.root, slug: SLUG, dispatchId: id, n: 2, base: p.integration.head, env: p.env });
  assert.equal(child.worktree, path.join(p.root, WORKTREES_DIR, `${id}.c2`));
  assert.equal(child.branch, `doflow-attempt/${SLUG}/${id}.c2`);
  assert.equal(git(child.worktree, p.env, ['rev-parse', 'HEAD']), p.integration.head);
  p.callerUnchanged();
});

test('IC-017: a tracked edit, an untracked file and the worker commit become one DoFlow dispatch commit on b', POSIX, (t) => {
  const p = project(t);
  const rules = storeRules();
  const store0 = [...rules.segments][0];
  const stateFile = `.doflow/state/${store0}/x.json`;
  let attemptBefore = null;
  let wtPath = null;
  const d: any = p.dispatchOf('A.1', (wt: any) => {
    wtPath = wt;
    write(wt, 'README.md', '# changed by the worker commit\n');
    write(wt, stateFile, '{}\n');
    git(wt, p.env, ['add', '-f', 'README.md', stateFile]);
    git(wt, p.env, ['-c', 'user.name=worker', '-c', 'user.email=worker@invalid', 'commit', '-qm', 'worker commit']);
    write(wt, 'src/a.js', '// edited\n');
    write(wt, 'src/new.js', '// new\n');
    attemptBefore = {
      head: git(wt, p.env, ['rev-parse', 'HEAD']),
      ref: git(wt, p.env, ['symbolic-ref', 'HEAD']),
      index: git(wt, p.env, ['ls-files', '-s']),
      status: git(wt, p.env, ['status', '--porcelain=v1', '--untracked-files=all']),
    };
  });
  const c = d.made.commit;
  assert.match(c, /^[0-9a-f]{40,64}$/);
  assert.equal(git(p.root, p.env, ['rev-list', '--parents', '-n', '1', c]), `${c} ${d.base}`, 'single parent b');
  assert.equal(git(p.root, p.env, ['log', '-1', '--format=%an <%ae> / %cn <%ce>', c]),
    'DoFlow dispatch <dispatch@doflow.invalid> / DoFlow dispatch <dispatch@doflow.invalid>');
  const names = git(p.root, p.env, ['diff', '--name-only', d.base, c]).split('\n').sort();
  assert.deepEqual(names, ['README.md', 'src/a.js', 'src/new.js'], 'no base pointer and no .doflow/state path');
  assert.deepEqual(d.made.changes, [
    { path: 'README.md', change: 'M', from: null }, { path: 'src/a.js', change: 'M', from: null }, { path: 'src/new.js', change: 'A', from: null },
  ]);
  assert.deepEqual(diffNameStatus(d.base, c, { cwd: p.root, env: p.env }), d.made.changes);
  assert.deepEqual({
    head: git(wtPath, p.env, ['rev-parse', 'HEAD']),
    ref: git(wtPath, p.env, ['symbolic-ref', 'HEAD']),
    index: git(wtPath, p.env, ['ls-files', '-s']),
    status: git(wtPath, p.env, ['status', '--porcelain=v1', '--untracked-files=all']),
  }, attemptBefore, "the attempt worktree's index, branch and files are untouched");
  const temp = path.resolve(wtPath, git(wtPath, p.env, ['rev-parse', '--git-path', 'index.doflow-dispatch']));
  assert.equal(fs.existsSync(temp), false, 'the temporary index is deleted');
  assert.equal(git(p.root, p.env, ['log', '-1', '--format=%s', c]), `dispatch ${d.id} task A.1 token ${d.token}`);
  p.callerUnchanged();
});

test('DEC-049: an empty change makes commit null, still verifies and finishes COMPLETED', POSIX, async (t) => {
  const p = project(t);
  const d = p.dispatchOf('A.1');
  assert.deepEqual([d.made.commit, d.made.changes], [null, []]);
  const preHead = p.integration.head;
  const r = await p.integrate();
  assert.equal(r.outcome, 'completed', JSON.stringify(r));
  assert.equal(r.integratedCommit, null);
  assert.equal(r.verification.exitCode, 0);
  assert.equal(p.branchHead(), preHead);
  const after = p.read();
  assert.equal(after.run.integration.head, preHead);
  assert.equal(after.dispatches[d.id].disposition, 'completed');
  assert.equal(after.dispatches[d.id].integratedCommit, null);
  const [a] = p.attempts('A.1');
  assert.deepEqual([a.state, a.result, a.evidenceId], ['finished', 'COMPLETED', r.verification.evidenceId]);
  p.callerUnchanged();
});

test('IC-018: a clean pick advances the integration head through update-ref and finishes COMPLETED; the worktree is removed verified', POSIX, async (t) => {
  const p = project(t);
  const d: any = p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// integrated\n'));
  const preHead = p.integration.head;
  const r = await p.integrate();
  assert.equal(r.outcome, 'completed', JSON.stringify(r));
  const n = r.integratedCommit;
  assert.equal(p.branchHead(), n);
  assert.equal(git(p.root, p.env, ['rev-list', '--parents', '-n', '1', n]), `${n} ${preHead}`);
  assert.equal(git(p.root, p.env, ['log', '-1', '--format=%an|%cn|%s', n]), `DoFlow dispatch|DoFlow dispatch|A.1: dispatch ${d.id} token ${d.token}`);
  assert.equal(fs.readFileSync(path.join(p.integration.worktree, 'src', 'a.js'), 'utf8'), '// integrated\n');
  const s = p.read();
  assert.equal(s.run.integration.head, n);
  assert.equal(s.lease, null);
  assert.equal(s.run.verifying, null);
  assert.equal(s.run.verifications.length, 1);
  const done = s.dispatches[d.id];
  assert.deepEqual([done.phase, done.disposition, done.integratedCommit, done.evidenceId], ['ended', 'completed', n, r.verification.evidenceId]);
  const [a] = p.attempts('A.1');
  assert.deepEqual([a.result, a.evidenceId], ['COMPLETED', r.verification.evidenceId]);
  assert.equal(r.removal.removed, true);
  assert.equal(done.removal.verified, true);
  assert.equal(fs.existsSync(d.wt.worktree), false);
  assert.equal(git(p.root, p.env, ['rev-parse', '--verify', '--quiet', `refs/heads/${d.wt.branch}`], { allowFailure: true }), '');
  assert.deepEqual(DISPATCH_IDENTITY.GIT_AUTHOR_NAME, 'DoFlow dispatch');
  p.callerUnchanged();
});

test('IC-018: a conflict is undone and finishes conflict; the failed worktree is kept', POSIX, async (t) => {
  const p = project(t);
  const first: any = p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// first\n'));
  const second: any = p.dispatchOf('A.2', (wt: any) => write(wt, 'src/a.js', '// second\n'));
  assert.equal((await p.integrate()).outcome, 'completed');
  const head = p.branchHead();
  const r = await p.integrate();
  assert.equal(r.outcome, 'conflict', JSON.stringify(r));
  assert.equal(r.dispatchId, second.id);
  assert.equal(r.undo.ok, true);
  assert.equal(p.branchHead(), head);
  assert.equal(git(p.integration.worktree, p.env, ['status', '--porcelain=v1', '--untracked-files=all']), '?? .doflow-worktree-base');
  const d = p.read().dispatches[second.id];
  assert.deepEqual([d.phase, d.disposition, d.failureClass], ['ended', 'failed', 'conflict']);
  assert.equal(p.read().lease, null);
  const [a] = p.attempts('A.2');
  assert.equal(a.result, 'FAILED');
  assert.match(a.reason, /^conflict: /);
  assert.deepEqual([r.removal.removed, r.removal.reason], [false, 'failed-kept']);
  assert.equal(fs.existsSync(second.wt.worktree), true, 'a failed attempt worktree is kept (DEC-014)');
  assert.equal(fs.existsSync(first.wt.worktree), false);
  p.callerUnchanged();
});

test('IC-018 / IC-020: failed verification resets to preHead and finishes verification', POSIX, async (t) => {
  const p = project(t, { exitCode: 1 });
  const d: any = p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// rejected\n'));
  const preHead = p.integration.head;
  const r = await p.integrate();
  assert.equal(r.outcome, 'verification', JSON.stringify(r));
  assert.equal(r.verification.exitCode, 1);
  assert.equal(r.undo.ok, true);
  assert.equal(p.branchHead(), preHead);
  assert.equal(fs.readFileSync(path.join(p.integration.worktree, 'src', 'a.js'), 'utf8'), '// src/a.js\n');
  const s = p.read();
  assert.equal(s.run.integration.head, preHead);
  const ended = s.dispatches[d.id];
  assert.deepEqual([ended.disposition, ended.failureClass, ended.evidenceId], ['failed', 'verification', r.verification.evidenceId]);
  assert.equal(p.attempts('A.1')[0].result, 'FAILED');
  assert.equal(fs.existsSync(d.wt.worktree), true);
  p.callerUnchanged();
});

test('IC-018 step 2: a dirty integration worktree blocks integration-dirty and returns the dispatch to collected', POSIX, async (t) => {
  const p = project(t);
  const d: any = p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// waiting\n'));
  write(p.integration.worktree, 'stray.txt', 'stray\n');
  const r = await p.integrate();
  assert.deepEqual([r.outcome, r.reason, r.paths], ['integration-dirty', 'dirty', 1]);
  const s = p.read();
  assert.equal(s.dispatches[d.id].phase, 'collected');
  assert.equal(s.lease, null);
  assert.equal(s.run.state, 'blocked');
  assert.deepEqual([s.run.integrationGap.kind, s.run.integrationGap.paths, s.run.integrationGap.task], ['integration-dirty', 1, 'A.1']);
  assert.equal(p.attempts('A.1')[0].state, 'active');
  assert.equal(fs.existsSync(path.join(p.integration.worktree, 'stray.txt')), true, 'nothing is reset on a dirty worktree');
  p.callerUnchanged();
});

test('IC-018: a concurrent move of the integration branch fails update-ref and blocks integration-error', POSIX, async (t) => {
  const p = project(t);
  p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// raced\n'));
  let moved = null;
  const r = await p.integrate({
    beforeUpdateRef: ({ worktree, branch, preHead }: any) => {
      const tree = git(worktree, p.env, ['rev-parse', `${preHead}^{tree}`]);
      moved = git(worktree, { ...p.env, GIT_AUTHOR_NAME: 'other', GIT_AUTHOR_EMAIL: 'o@invalid', GIT_COMMITTER_NAME: 'other', GIT_COMMITTER_EMAIL: 'o@invalid' },
        ['commit-tree', tree, '-p', preHead, '-m', 'concurrent']);
      git(worktree, p.env, ['update-ref', `refs/heads/${branch}`, moved]);
    },
  });
  assert.equal(p.branchHead(), moved, 'the concurrent move is not overwritten');
  assert.deepEqual([r.outcome, r.reason], ['integration-error', 'update-ref-failed'], JSON.stringify(r));
  assert.equal(r.undo.ran, false, 'no reset over a head another writer moved');
  const s = p.read();
  assert.equal(s.run.state, 'blocked');
  assert.equal(s.run.integrationGap.kind, 'integration-error');
  assert.equal(s.lease, null);
  assert.deepEqual([s.dispatches[r.dispatchId].phase, s.dispatches[r.dispatchId].disposition], ['ended', 'released']);
  assert.equal(p.attempts('A.1')[0].state, 'released');
  p.callerUnchanged();
});

test('IC-020: undo on a non-integration branch runs nothing', POSIX, (t) => {
  const p = project(t);
  const wt = p.integration.worktree;
  git(wt, p.env, ['switch', '-q', '--detach']);
  write(wt, 'src/a.js', '// keep me\n');
  const r = undo({ worktree: wt, branch: p.integration.branch, preHead: p.integration.head, env: p.env });
  assert.deepEqual([r.ok, r.ran, r.reason], [false, false, 'not-integration-branch']);
  assert.equal(git(wt, p.env, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }), '', 'still detached');
  assert.equal(fs.readFileSync(path.join(wt, 'src', 'a.js'), 'utf8'), '// keep me\n');
  p.callerUnchanged();
});

test('IC-018: with no collected dispatch nothing happens, and a held lease blocks a second integration', POSIX, async (t) => {
  const p = project(t);
  assert.deepEqual(await p.integrate(), { outcome: 'none' });
  p.dispatchOf('A.1');
  store.mutateDispatch(p.file, (s: any) => {
    s.lease = { holder: { pid: 1, start: null }, dispatchId: store.newDispatchId(), preHead: s.run.integration.head, takenAt: new Date().toISOString() };
    return { write: true, result: null };
  });
  assert.equal((await p.integrate()).outcome, 'lease-held');
  p.callerUnchanged();
});

// RT-2: a lost driver (`resume-required`, IC-009) or a cancel (`cancelling`, IC-030 step 3) can land
// between IC-018 step 1 and the step-2 dirty write. The `afterLease` seam sets that state after the
// lease is taken, so the order is fixed; the dirty path records its gap and leaves the state.
for (const held of ['resume-required', 'cancelling']) {
  test(`RT-2: the integration-dirty path leaves a ${held} run ${held}`, POSIX, async (t) => {
    const p = project(t);
    const d: any = p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// held\n'));
    write(p.integration.worktree, 'stray.txt', 'stray\n');
    const afterLease = () => store.mutateDispatch(p.file, (s: any) => { s.run.state = held; return { write: true, result: null }; });
    const r = await p.integrate({ afterLease });
    assert.equal(r.outcome, 'integration-dirty', JSON.stringify(r));
    const s = p.read();
    assert.equal(s.run.state, held, `the ${held} state is kept`);
    assert.equal(s.run.integrationGap.kind, 'integration-dirty', 'the gap is still recorded');
    assert.equal(s.lease, null);
    assert.notEqual(s.dispatches[d.id].phase, 'integrating');
    p.callerUnchanged();
  });
}

// RT-4: a cancel lands while the integration verifies (IC-030 steps 3 and 5: the run marked and the
// 080 attempt cancelled; step 7 leaves the leased dispatch to its holder). The injected `verify`
// makes both writes before it runs, so the order is fixed. The failing verification's 080 finish is
// refused, and the dispatch must end (here stale, its attempt cancelled), not go back to `collected`
// in a run no pass will ever step again; its worktree is then due for removal (IC-021).
test('RT-4: a verification failure on an attempt cancelled under a cancel-marked run ends the dispatch and its worktree is removed', POSIX, async (t) => {
  const { cancel } = require(path.join(SRC, 'task-attempts.ts'));
  const { runVerification } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
  const { removalDue } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
  const p = project(t, { exitCode: 1 });
  const d: any = p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// cancelled\n'));
  const verify = async (args: any) => {
    store.mutateDispatch(p.file, (s: any) => { s.run.state = 'cancelling'; return { write: true, result: null }; });
    const c = cancel({ file: p.ctx.ledgerFile, fsImpl: fs, roots: p.ctx.roots, slug: SLUG, task: 'A.1', token: d.token, by: 'main', reason: 'RT-4 cancel', env: p.env, cwd: p.root });
    assert.equal(c.disposition, 'cancelled', JSON.stringify(c));
    return runVerification(args);
  };
  const r = await p.integrate({ verify });
  assert.equal(r.outcome, 'verification', JSON.stringify(r));
  assert.equal(r.end.ended, false, 'the 080 finish on the cancelled attempt is refused');
  const s = p.read();
  const x = s.dispatches[d.id];
  assert.equal(x.phase, 'ended', JSON.stringify(x));
  assert.ok(['stale', 'released'].includes(x.disposition), x.disposition);
  assert.equal(s.lease, null);
  assert.ok((x.removal && x.removal.verified === true) || removalDue(x, s.run).due, `its worktree is due for removal: ${JSON.stringify(x.removal)}`);
  assert.equal(fs.existsSync(d.wt.worktree), false, 'the attempt worktree is removed');
  p.callerUnchanged();
});

// RT-8: IC-021's last row, "any, worker cleanup not verified: kept and listed", covers every
// disposition. A failed timeout dispatch whose cancelRun left survivors, and a completed one whose
// run's cleanup is unknown, keep their attempt worktrees even once the run has ended.
test('RT-8: removalDue keeps a completed or failed dispatch\'s worktree while its worker cleanup is not verified', () => {
  const { removalDue } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
  const ended: any = { phase: 'ended', workerRunId: 'w-000000000001', attempt: { worktree: '/x' } };
  const failed: any = { ...ended, disposition: 'failed', failureClass: 'timeout', cleanup: { disposition: 'cancelled', cleanup: { status: 'survivors', reason: 'group-survived' } } };
  const completed: any = { ...ended, disposition: 'completed', cleanup: null };
  const verified: any = { ...ended, disposition: 'failed', cleanup: { cleanup: { status: 'verified', reason: 'exited' } } };
  assert.deepEqual([removalDue(failed, { state: 'completed' }), removalDue(completed, { state: 'running' }), removalDue(verified, { state: 'cancelled' }).due],
    [{ due: false, reason: 'worker-cleanup-unverified' }, { due: false, reason: 'worker-cleanup-unverified' }, true]);
});

// RT-9: an 080 release that throws changes nothing else (IC-024). The run's verification is
// undeclared, so step 5 takes the release-with-error path; the `afterLease` seam arms an fs whose
// ledger rename fails, so 080's release throws `store-unreadable`. The attempt is still active, so
// the dispatch keeps `lastError` and goes back to `collected`, never ended `released` beside an
// active 080 attempt.
test('RT-9: a release that throws on an active attempt keeps lastError and leaves the dispatch collected', POSIX, async (t) => {
  const p = project(t);
  const d: any = p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// a\n'));
  store.mutateDispatch(p.file, (s: any) => { s.run.verify = { argv: null, argvSha256: null, argvCount: 0, timeoutSeconds: 30 }; return { write: true, result: null }; });
  let armed = false;
  const fsImpl: any = { ...fs, renameSync: (from: any, to: any) => { if (armed && to === p.ctx.ledgerFile) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return fs.renameSync(from, to); } };
  const afterLease = () => { armed = true; };
  const r = await p.integrate({ afterLease, ctx: { ...p.ctx, fsImpl } });
  armed = false;
  assert.equal(r.outcome, 'integration-error', JSON.stringify(r));
  const x = p.read().dispatches[d.id];
  assert.deepEqual([x.phase, Boolean(x.lastError), p.read().lease, p.attempts('A.1')[0].state], ['collected', true, null, 'active'], JSON.stringify(x));
});

// RT-11: settle checks what it settles. During the failing verification the injected verify plays a
// resume that ruled on this lease and another driver that took a new one for A.2, so the order is
// fixed. The verification's settle must then leave the other lease and both dispatches alone and
// write only its evidence record.
test('RT-11: a settle whose lease was taken by another dispatch clears nothing and records only the verification', POSIX, async (t) => {
  const { runVerification } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
  const p = project(t, { exitCode: 1 });
  const d: any = p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// a\n'));
  const other: any = p.dispatchOf('A.2', (wt: any) => write(wt, 'src/b.js', '// b\n'));
  const verify = async (args: any) => {
    const result = await runVerification(args);
    store.mutateDispatch(p.file, (s: any) => {
      s.lease = { holder: HOLDER, dispatchId: other.id, preHead: s.run.integration.head, takenAt: new Date().toISOString() };
      s.dispatches[other.id].phase = 'integrating';
      return { write: true, result: null };
    });
    return result;
  };
  const r = await p.integrate({ verify });
  const s = p.read();
  assert.deepEqual([r.outcome, s.lease && s.lease.dispatchId, s.dispatches[other.id].phase, s.dispatches[d.id].phase, s.run.verifications.length, p.attempts('A.1')[0].state],
    ['lease-lost', other.id, 'integrating', 'integrating', 1, 'active'], JSON.stringify(r));
});

// RR-2: step 6's finish writes the 080 ledger inside the dispatch lock, before the dispatch store is
// written. The injected verify arms an fs seam whose next rename onto the dispatch store throws, so
// the throw lands after 080 recorded the attempt COMPLETED with its commit. The catch must then keep
// that commit and the lease for IC-032's lease rule, never undo a commit 080 shows integrated.
test('RR-2: a dispatch-store write that throws after the finish applied keeps the commit and the lease', POSIX, async (t) => {
  const { runVerification } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
  const p = project(t);
  const d: any = p.dispatchOf('A.1', (wt: any) => write(wt, 'src/a.js', '// a\n'));
  const preHead = p.branchHead();
  const rename = fs.renameSync;
  let armed = false;
  t.after(() => { fs.renameSync = rename; });
  fs.renameSync = (from: any, to: any) => {
    if (armed && to === p.file) {
      armed = false;
      fs.rmSync(from, { force: true });
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  const verify = async (args: any) => {
    const result = await runVerification(args);
    armed = true;
    return result;
  };
  await assert.rejects(p.integrate({ verify }), (error: any) => error && /EIO/.test(`${error.code} ${error.message}`));
  fs.renameSync = rename;
  const [attempt] = p.attempts('A.1');
  assert.deepEqual([attempt.state, attempt.result], ['finished', 'COMPLETED'], JSON.stringify(attempt));
  const s = p.read();
  assert.ok(s.lease && s.lease.dispatchId === d.id && s.lease.pickedHead, `the lease is kept for the lease rule: ${JSON.stringify(s.lease)}`);
  assert.notEqual(s.lease.pickedHead, preHead);
  assert.equal(p.branchHead(), s.lease.pickedHead, 'the commit 080 recorded integrated is not undone');
  assert.equal(s.dispatches[d.id].phase, 'integrating');
  p.callerUnchanged();
});
