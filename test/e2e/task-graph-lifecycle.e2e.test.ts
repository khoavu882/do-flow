'use strict';

// Feature 080 E.2 (IC-005, IC-006, IC-007, IC-009, IC-012, IC-015, IC-024, IC-025, IC-026): one
// test() per requirement §6 scenario, end to end through `bin/doflow.js task-attempt` on temp git
// projects with a graph plan. Every child gets an explicit identity environment (DOFLOW_RUN_ID,
// DOFLOW_LINEAGE_ID, DOFLOW_SESSION_ROLE, DOFLOW_ROLE, DOFLOW_WORKTREE, HOME, XDG_CONFIG_HOME), so
// the developer's shell never decides a run key or a summary scope. The ledger lives under the
// main worktree's root (lifecycle projectRoot), so the two-worktree scenarios share one ledger and
// differ only by run key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { summaryScope } = require('../../src/runtime/context/summary-store.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const SLUG = 'feat-g';
const HEADER = '**Task graph:** v1';

const planText = (lines: any, { header = true }: any = {}) => ['# Plan', '', ...(header ? [HEADER, ''] : []), '## Tasks', '', ...lines, ''].join('\n');

const BASIC: any = [
  '### Phase A', '',
  '- [ ] A.1 first; owner: core-implementer; files: a.js',
  '- [ ] A.2 second; owner: core-implementer; files: b.js',
  '- [ ] A.3 third; owner: core-implementer; files: c.js',
  '', '### Phase B', '',
  '- [ ] B.1 later; owner: core-implementer; files: d.js',
];

/**
 * A temp git repository with one commit holding the plan and four source files, plus `worktrees`
 * extra `git worktree add` checkouts as siblings of the repository (never nested in it).
 */
function project(t: any, { lines = BASIC, header = true, worktrees = 0 }: any = {}) {
  const base = tempDir(t, 'doflow-task-graph-e2e-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  const gitEnv: any = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
  };
  const git = (cwd: any, args: any) => {
    const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, env: gitEnv, encoding: 'utf8' });
    assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
    return done.stdout;
  };
  git(repo, ['init', '-q']);
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const planRel = path.join('agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.join(repo, path.dirname(planRel)), { recursive: true });
  fs.writeFileSync(path.join(repo, planRel), planText(lines, { header }));
  for (const f of ['a.js', 'b.js', 'c.js', 'd.js']) fs.writeFileSync(path.join(repo, f), `// ${f}\n`);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.doflow/\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  const wts: any = [];
  for (let i = 1; i <= worktrees; i += 1) {
    const wt = path.join(base, `wt${i}`);
    git(repo, ['worktree', 'add', '-q', '-b', `wt${i}`, wt]);
    wts.push(fs.realpathSync(wt));
  }
  const store = path.join(repo, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);

  /** One CLI call from `where` under the given identity; `json: false` omits `--json`. */
  const cli = (args: any, { where = repo, run = 'r1', lineage = 'main', role = 'main', json = true }: any = {}) => {
    const env: any = {
      ...gitEnv,
      DOFLOW_RUN_ID: run, DOFLOW_LINEAGE_ID: lineage, DOFLOW_SESSION_ROLE: role, DOFLOW_ROLE: role, DOFLOW_WORKTREE: where,
    };
    delete env.DOFLOW_RETENTION_HOURS;
    delete env.DOFLOW_ATTEMPT;
    const done = spawnSync(process.execPath, [CLI, 'task-attempt', ...args, ...(json ? ['--json'] : [])], { cwd: where, env, encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(done.stdout); } catch { /* no JSON on stdout */ }
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, data };
  };
  const ta = (action: any, extra: any = [], who?: any) => cli(['--action', action, '--slug', SLUG, ...extra], who);
  /** A passing test-result evidence item for `taskId`, recorded where finish looks (the main root). */
  const evidence = (taskId: any) => {
    const ledger: any = new EvidenceLedger({ repoRoot: repo, slug: SLUG });
    const id = ledger.addEvidence({
      taskId, kind: 'test-result', provenance: 'extracted', source: { provider: 'shell', capability: 'test' },
      locator: { file: 'a.test.js' }, content: 'ran', observation: { command: 'node --test', exitCode: 0 },
    });
    ledger.save(taskId);
    return id;
  };
  const read = () => JSON.parse(fs.readFileSync(store, 'utf8'));
  const bytes = () => (fs.existsSync(store) ? fs.readFileSync(store) : null);
  const setPlan = (newLines: any, opts?: any) => fs.writeFileSync(path.join(repo, planRel), planText(newLines, opts));
  return { base, repo, home, wts, store, cli, ta, evidence, read, bytes, setPlan };
}

const ok = (r: any, disposition?: any) => {
  assert.equal(r.status, 0, r.stderr || r.stdout);
  if (disposition) assert.equal(r.data.disposition, disposition, r.stdout);
  return r.data;
};
const exit1 = (r: any, disposition: any, reason?: any) => {
  assert.equal(r.status, 1, r.stderr || r.stdout);
  assert.ok(r.data, `exit 1 must carry JSON on stdout: ${r.stdout}`);
  assert.equal(r.data.disposition, disposition, r.stdout);
  if (reason) assert.equal(r.data.reason, reason, r.stdout);
  return r.data;
};
const taskOf = (view: any, id: any) => view.tasks.find((x: any) => x.id === id);

const start = (p: any, extra: any = [], who?: any) => ok(p.ta('start', ['--by', 'lead', ...extra], who), 'started');
const claimArgs = (task: any, { owner = 'core-implementer', mode = 'subagent', epoch = 1, extra = [] }: any = {}) =>
  ['--task', task, '--owner', owner, '--mode', mode, ...(epoch === null ? [] : ['--epoch', String(epoch)]), ...extra];
const claim = (p: any, task: any, opts: any = {}, who?: any) => p.ta('claim', claimArgs(task, opts), who);
const finish = (p: any, task: any, token: any, result: any, extra: any = [], who?: any) => p.ta('finish', ['--task', task, '--token', String(token), '--result', result, ...extra], who);
const complete: any = (p: any, task: any, token: any, extra: any = [], who?: any) => ok(finish(p, task, token, 'COMPLETED', ['--evidence-id', p.evidence(task), ...extra], who), 'applied');

// ── US1 ──────────────────────────────────────────────────────────────────────────────────────────

test('Scenario: Declared dependencies decide readiness (FR-001, FR-003)', (t) => {
  const p = project(t, { lines: [
    '### Phase A', '',
    '- [ ] A.1 first; owner: core-implementer; files: a.js',
    '- [ ] A.2 second; owner: core-implementer; files: b.js',
    '', '### Phase B', '',
    '- [ ] B.1 phase-ordered; owner: core-implementer; files: c.js',
    '- [ ] B.2 declared; owner: core-implementer; files: d.js; depends-on: A.1',
  ] });
  start(p);
  const before = ok(p.ta('status'));
  assert.deepEqual([taskOf(before, 'B.2').state, taskOf(before, 'B.2').reason, taskOf(before, 'B.2').unmet], ['PLANNED', 'unmet-dependency', ['A.1']]);
  exit1(claim(p, 'B.2'), 'refused', 'unmet-dependency');

  const a1 = ok(claim(p, 'A.1'), 'claimed');
  complete(p, 'A.1', a1.token);
  const after = ok(p.ta('status'));
  assert.equal(taskOf(after, 'A.2').state, 'READY', 'A.2 is still pending: phase A is not finished');
  assert.deepEqual([taskOf(after, 'B.2').state, taskOf(after, 'B.2').claimable], ['READY', true]);
  assert.deepEqual([taskOf(after, 'B.1').state, taskOf(after, 'B.1').reason, taskOf(after, 'B.1').unmet], ['PLANNED', 'unmet-phase', ['A.2']],
    'a task without declared dependencies keeps phase order');
  ok(claim(p, 'B.2'), 'claimed');
  const view = ok(p.ta('inspect'));
  assert.deepEqual(view.graph.tasks.find((x: any) => x.id === 'B.2').taskDeps, ['A.1']);
});

test('Scenario: Bad graph refused (FR-002)', (t) => {
  const p = project(t, { lines: [
    '### Phase A', '',
    '- [ ] A.1 first; owner: core-implementer; files: a.js; depends-on: Z.9',
    '- [ ] A.2 second; owner: core-implementer; files: b.js; depends-on: A.3',
    '- [ ] A.3 third; owner: core-implementer; files: c.js; depends-on: A.2',
  ] });
  for (const [action, extra] of [['status', []], ['claim', claimArgs('A.1')], ['claim', claimArgs('B.9')], ['inspect', []]]) {
    const r = p.ta(action, extra);
    assert.equal(r.status, 2, `${action}: ${r.stdout}${r.stderr}`);
    assert.equal(r.data.ok, false);
    assert.equal(r.data.error, 'plan-malformed');
    const kinds = r.data.problems.map((x: any) => x.kind).sort();
    assert.deepEqual(kinds, ['cycle', 'unknown-dependency']);
    const unknown = r.data.problems.find((x: any) => x.kind === 'unknown-dependency');
    assert.deepEqual(unknown.ids, ['A.1', 'Z.9']);
    const cycle = r.data.problems.find((x: any) => x.kind === 'cycle');
    assert.deepEqual([...cycle.ids].sort(), ['A.2', 'A.3'], 'every id on the cycle is named');
    assert.ok(Array.isArray(cycle.via) && cycle.via.length >= 2, `cycle carries via: ${JSON.stringify(cycle)}`);
    for (const id of ['A.1', 'Z.9', 'A.2', 'A.3']) assert.ok(r.data.message.includes(id), `message names ${id}: ${r.data.message}`);
  }
  assert.equal(fs.existsSync(p.store), false, 'nothing is claimable or written from a refused graph');
});

test('Scenario: Blocked dependency holds the task (FR-004)', (t) => {
  const p = project(t, { lines: [
    '### Phase A', '',
    '- [ ] A.1 first; owner: core-implementer; files: a.js',
    '', '### Phase B', '',
    '- [ ] B.1 later; owner: core-implementer; files: b.js; depends-on: A.1',
  ] });
  start(p);
  const a1 = ok(claim(p, 'A.1'), 'claimed');
  ok(finish(p, 'A.1', a1.token, 'BLOCKED', ['--reason', 'waiting on infra']), 'applied');
  const refused = exit1(claim(p, 'B.1'), 'refused', 'dependency-held');
  assert.deepEqual(refused.held, [{ id: 'A.1', state: 'BLOCKED' }]);
  const b1 = taskOf(ok(p.ta('status')), 'B.1');
  assert.deepEqual([b1.state, b1.reason, b1.held, b1.claimable], ['PLANNED', 'dependency-held', [{ id: 'A.1', state: 'BLOCKED' }], false]);
});

test('Scenario: Owner enforced (FR-005)', (t) => {
  const p = project(t);
  start(p);
  const refused = exit1(claim(p, 'A.1', { owner: 'quality-guardian' }), 'refused', 'owner-mismatch');
  assert.equal(refused.declared, 'core-implementer');
  assert.equal(fs.existsSync(p.store) && (p.read().tasks['A.1']?.attempts || []).length, 0, 'the refused claim wrote no attempt');
  const claimed = ok(claim(p, 'A.1', { owner: 'quality-guardian', extra: ['--owner-override', 'implementer unavailable'] }), 'claimed');
  const attempt = p.read().tasks['A.1'].attempts.find((a: any) => a.token === claimed.token);
  assert.equal(attempt.owner, 'quality-guardian');
  assert.deepEqual(attempt.ownerOverride, { declared: 'core-implementer', reason: 'implementer unavailable' });
});

test('Scenario: Same task, three modes (FR-006)', (t) => {
  const p = project(t);
  start(p);
  for (const mode of ['manual', 'sequential', 'subagent']) {
    const before = taskOf(ok(p.ta('status')), 'A.1');
    assert.equal(before.state, 'READY', `${mode}: READY before the claim`);
    const claimed = ok(claim(p, 'A.1', { mode }), 'claimed');
    assert.equal(taskOf(ok(p.ta('status')), 'A.1').state, 'RUNNING', `${mode}: RUNNING`);
    exit1(finish(p, 'A.1', claimed.token, 'COMPLETED'), 'refused', 'evidence-required');
    complete(p, 'A.1', claimed.token);
    assert.equal(taskOf(ok(p.ta('status')), 'A.1').state, 'SUCCEEDED', `${mode}: SUCCEEDED through the same gate`);
    if (mode !== 'subagent') ok(p.ta('reopen', ['--task', 'A.1', '--token', String(claimed.token), '--by', 'lead', '--reason', `run again after ${mode}`]), 'reopened');
  }
  const attempts = p.read().tasks['A.1'].attempts;
  assert.deepEqual(attempts.map((a: any) => a.mode), ['manual', 'sequential', 'subagent'], 'each attempt records the mode the caller stated');
  assert.deepEqual(attempts.map((a: any) => a.state), ['superseded', 'superseded', 'finished']);
});

// ── US2 ──────────────────────────────────────────────────────────────────────────────────────────

test('Scenario: Failure allows retry, cancel is never accepted (FR-007, FR-008)', (t) => {
  const p = project(t);
  start(p);
  const first = ok(claim(p, 'A.1'), 'claimed');
  ok(finish(p, 'A.1', first.token, 'FAILED', ['--reason', 'tests red']), 'applied');
  const failed = taskOf(ok(p.ta('status')), 'A.1');
  assert.deepEqual([failed.state, failed.reason, failed.claimable], ['FAILED', 'failed', true]);

  const retry = ok(claim(p, 'A.1'), 'claimed');
  assert.equal(retry.token, first.token + 1, 'the retry is allowed');
  ok(p.ta('cancel', ['--by', 'lead', '--reason', 'user stopped the run']), 'cancelled');

  const evidenceId: any = p.evidence('A.1');
  const late: any = exit1(finish(p, 'A.1', retry.token, 'COMPLETED', ['--evidence-id', evidenceId]), 'stale', 'attempt-cancelled');
  assert.equal(late.token, retry.token);
  const attempt = p.read().tasks['A.1'].attempts.find((a: any) => a.token === retry.token);
  assert.deepEqual([attempt.state, attempt.result, attempt.evidenceId], ['cancelled', null, null], 'nothing from the late finish is accepted');
  const after = taskOf(ok(p.ta('status')), 'A.1');
  assert.equal(after.state, 'CANCELLED');
  assert.notEqual(after.state, 'SUCCEEDED');
});

test('Scenario: Reopen and plan change after done (FR-016)', (t) => {
  const lines: any = [
    '### Phase A', '',
    '- [ ] A.1 first; owner: core-implementer; files: a.js; budget: attempts=1',
    '- [ ] A.2 second; owner: core-implementer; files: b.js',
  ];
  const changed: any = [lines[0], lines[1], lines[2], '- [ ] A.2 second; owner: core-implementer; files: b.js; depends-on: A.1'];

  const p = project(t, { lines });
  start(p);
  const a1 = ok(claim(p, 'A.1'), 'claimed');
  complete(p, 'A.1', a1.token);
  const a2 = ok(claim(p, 'A.2'), 'claimed');
  complete(p, 'A.2', a2.token);
  assert.equal(ok(p.ta('status')).complete, true);

  // A plan line gains a dependency after A.2 finished: A.2 is no longer done.
  p.setPlan(changed);
  const stale = ok(p.ta('status'));
  const s2 = taskOf(stale, 'A.2');
  assert.deepEqual([s2.state, s2.reason, s2.doneStale], ['READY', 'plan-changed-after-done', { token: a2.token }]);
  assert.equal(stale.complete, false);

  // Reopen with a reason: A.1 is no longer done and the reopen counts toward its budget of 1.
  const reopened = ok(p.ta('reopen', ['--task', 'A.1', '--token', String(a1.token), '--by', 'lead', '--reason', 'review found a gap']), 'reopened');
  assert.equal(reopened.taskId, 'A.1');
  const s1 = taskOf(ok(p.ta('status')), 'A.1');
  assert.notEqual(s1.state, 'SUCCEEDED');
  assert.deepEqual([s1.state, s1.reason, s1.budget], ['BLOCKED', 'budget', { limit: 1, used: 1, source: 'plan' }]);
  const refused = exit1(claim(p, 'A.1'), 'refused', 'budget-exhausted');
  assert.deepEqual([refused.scope, refused.limit, refused.used], ['task', 1, 1]);
  const attempt = p.read().tasks['A.1'].attempts[0];
  assert.equal(attempt.state, 'superseded');
  assert.equal(attempt.reopen.reason, 'review found a gap');

  // A legacy plan's done task is unaffected by the same line change.
  const legacy = project(t, { lines, header: false });
  const l2 = ok(claim(legacy, 'A.2', { epoch: null }), 'claimed');
  complete(legacy, 'A.2', l2.token);
  legacy.setPlan(changed, { header: false });
  const lstatus = ok(legacy.ta('status'));
  assert.deepEqual([taskOf(lstatus, 'A.2').state, taskOf(lstatus, 'A.2').derived], ['SUCCEEDED', 'done']);
});

// ── US3 ──────────────────────────────────────────────────────────────────────────────────────────

test('Scenario: A redo of a stale-done task succeeds (FR-016, DEC-016 done-attempt-selection)', (t) => {
  const { checkCompletion } = require('../../src/runtime/task-attempts.ts');
  const lines: any = ['### Phase A', '', '- [ ] A.1 first; owner: core-implementer; files: a.js'];
  const reworded: any = ['### Phase A', '', '- [ ] A.1 first, reworded; owner: core-implementer; files: a.js'];
  const p = project(t, { lines });
  start(p);
  const first = ok(claim(p, 'A.1'), 'claimed');
  complete(p, 'A.1', first.token);
  p.setPlan(reworded);
  assert.equal(taskOf(ok(p.ta('status')), 'A.1').reason, 'plan-changed-after-done');
  const redo = ok(claim(p, 'A.1'), 'claimed');
  assert.equal(redo.token, 2);
  complete(p, 'A.1', redo.token);

  const view = ok(p.ta('status'));
  assert.deepEqual([taskOf(view, 'A.1').state, taskOf(view, 'A.1').doneToken], ['SUCCEEDED', 2]);
  assert.equal(view.complete, true);
  assert.equal(checkCompletion({ slug: SLUG, cwd: p.repo }).state, 'complete');
  exit1(claim(p, 'A.1'), 'refused', 'already-done');
  const refused = exit1(p.ta('reopen', ['--task', 'A.1', '--token', '1', '--by', 'lead', '--reason', 'old token']), 'refused', 'token-mismatch');
  assert.equal(refused.doneToken, 2);
});

test('Scenario: Attempt budget blocks (FR-009)', (t) => {
  const p = project(t, { lines: [
    '### Phase A', '',
    '- [ ] A.1 first; owner: core-implementer; files: a.js; budget: attempts=2',
  ] });
  start(p);
  for (let i = 0; i < 2; i += 1) {
    const c = ok(claim(p, 'A.1'), 'claimed');
    ok(finish(p, 'A.1', c.token, 'FAILED', ['--reason', `failure ${i + 1}`]), 'applied');
  }
  const refused = exit1(claim(p, 'A.1'), 'refused', 'budget-exhausted');
  assert.deepEqual([refused.scope, refused.limit, refused.used], ['task', 2, 2]);
  const a1 = taskOf(ok(p.ta('status')), 'A.1');
  assert.deepEqual([a1.state, a1.reason, a1.budget], ['BLOCKED', 'budget', { limit: 2, used: 2, source: 'plan' }]);
  const text = p.ta('inspect', [], { json: false });
  assert.match(text.stdout, /^ {2}A\.1 BLOCKED budget budget 2\/2$/m);
});

test('Scenario: Aggregate budget blocks (FR-010)', (t) => {
  const p = project(t);
  start(p, ['--budget-attempts', '2', '--budget-tokens', '20']);
  const a1 = ok(claim(p, 'A.1', { extra: ['--reserve-tokens', '10'] }), 'claimed');
  complete(p, 'A.1', a1.token, ['--tokens', '7', '--tokens-basis', 'measured']);
  const a2 = ok(claim(p, 'A.2', { extra: ['--reserve-tokens', '10'] }), 'claimed');
  ok(finish(p, 'A.2', a2.token, 'FAILED', ['--reason', 'red', '--tokens', '3', '--tokens-basis', 'estimated']), 'applied');

  const tokens = exit1(claim(p, 'A.3', { extra: ['--reserve-tokens', '11'] }), 'refused', 'aggregate-exhausted');
  assert.deepEqual([tokens.scope, tokens.measure, tokens.limit], ['run', 'tokens', 20]);
  const attempts = exit1(claim(p, 'A.3', { extra: ['--reserve-tokens', '5'] }), 'refused', 'aggregate-exhausted');
  assert.deepEqual([attempts.scope, attempts.measure, attempts.limit, attempts.used], ['run', 'attempts', 2, 2]);
  exit1(claim(p, 'A.2', { extra: ['--reserve-tokens', '5'] }), 'refused', 'aggregate-exhausted');

  const ledger = p.read();
  assert.deepEqual(ledger.tasks['A.1'].attempts[0].usage, { tokens: 7, basis: 'measured', reporter: 'main:main' });
  assert.deepEqual(ledger.tasks['A.2'].attempts[0].usage, { tokens: 3, basis: 'estimated', reporter: 'main:main' });
  const view = ok(p.ta('inspect'));
  assert.equal(view.run.totals.attempts, 2);
  assert.deepEqual(view.run.totals.tokens, { measured: 7, estimated: 3, reserved: 0 }, 'measured and estimated are never summed into one figure');
  assert.equal(view.run.totalsMismatch, false, `stored ${JSON.stringify(p.read().runs[view.run.runKey].totals)} vs recomputed ${JSON.stringify(view.run.totals)}`);
  const text = p.ta('inspect', [], { json: false }).stdout;
  assert.match(text, /totals: attempts 2; tokens measured 7, estimated 3, reserved 0/);
});

test('Scenario: One budget per run across workers (FR-018)', (t) => {
  const p: any = project(t, { worktrees: 2 });
  const [w1, w2] = p.wts;
  const worker1: any = { where: w1, lineage: 'w1', role: 'worker' };
  const worker2: any = { where: w2, lineage: 'w2', role: 'worker' };
  start(p, ['--budget-attempts', '3', '--budget-tokens', '100']);

  // Workers cannot open a run or claim of their own.
  exit1(p.ta('start', ['--by', 'w1'], worker1), 'refused', 'worker-session');
  exit1(claim(p, 'A.1', {}, worker1), 'refused', 'worker-session');

  const a1 = ok(claim(p, 'A.1', { extra: ['--reserve-tokens', '10', '--exec-worktree', w1] }), 'claimed');
  const a2 = ok(claim(p, 'A.2', { extra: ['--reserve-tokens', '10', '--exec-worktree', w2] }), 'claimed');
  assert.deepEqual([a1.execWorktree, a2.execWorktree], [w1, w2]);
  complete(p, 'A.1', a1.token, ['--tokens', '4', '--tokens-basis', 'measured'], worker1);
  complete(p, 'A.2', a2.token, ['--tokens', '6', '--tokens-basis', 'estimated'], worker2);
  const a3 = ok(claim(p, 'A.3', { extra: ['--reserve-tokens', '10', '--exec-worktree', w2] }), 'claimed');

  const ledger = p.read();
  const keys = Object.keys(ledger.runs);
  assert.equal(keys.length, 1, 'the workers opened no run of their own');
  assert.deepEqual(['A.1', 'A.2', 'A.3'].map((id) => ledger.tasks[id].attempts[0].runKey), [keys[0], keys[0], keys[0]]);
  assert.deepEqual(ledger.tasks['A.1'].attempts[0].finishedBy, { role: 'worker', lineage: 'w1', worktree: w1 });
  assert.deepEqual(ledger.tasks['A.2'].attempts[0].finishedBy, { role: 'worker', lineage: 'w2', worktree: w2 });

  // One aggregate budget counted every worker's attempt.
  const view = ok(p.ta('inspect'));
  assert.equal(view.run.totals.attempts, 3);
  assert.deepEqual(view.run.totals.tokens, { measured: 4, estimated: 6, reserved: 10 });
  assert.equal(view.run.budget.attempts, 3);

  // Changed files are checked in each worker's worktree; the main checkout's copies are untouched.
  fs.writeFileSync(path.join(w1, 'a.js'), '// edited by worker 1 after finishing\n');
  fs.writeFileSync(path.join(w2, 'c.js'), '// edited by worker 2 while running\n');
  const report = exit1(p.ta('resume'), 'ack-required').report;
  assert.deepEqual(report.changedSources, [{ taskId: 'A.3', token: a3.token, file: 'c.js', change: 'changed' }]);
  assert.deepEqual(report.doneChanged, [{ taskId: 'A.1', token: a1.token, file: 'a.js', change: 'changed' }]);
  assert.deepEqual(report.activeAttempts.map((a: any) => [a.taskId, a.execWorktree]), [['A.3', w2]]);

  // The user cancels the run: cancel reaches the active attempt the worker holds.
  const cancelled = ok(p.ta('cancel', ['--by', 'user', '--reason', 'stop everything']), 'cancelled');
  assert.deepEqual(cancelled.cancelled, [{ taskId: 'A.3', token: a3.token }]);
  assert.deepEqual(cancelled.notCancelled, []);
  exit1(finish(p, 'A.3', a3.token, 'COMPLETED', ['--evidence-id', p.evidence('A.3')], worker2), 'stale', 'attempt-cancelled');
});

// ── US4 ──────────────────────────────────────────────────────────────────────────────────────────

test('Scenario: Checkpoints isolated (FR-011)', (t) => {
  const p = project(t, { worktrees: 2 });
  const [w1, w2] = p.wts;
  start(p, ['--budget-attempts', '5'], { where: w1 });
  start(p, ['--budget-attempts', '7'], { where: w2 });
  ok(claim(p, 'A.1', {}, { where: w1 }), 'claimed');
  ok(p.ta('pause', ['--by', 'lead', '--reason', 'w1 break'], { where: w1 }), 'paused');
  ok(p.ta('pause', ['--by', 'lead', '--reason', 'w2 break'], { where: w2 }), 'paused');

  const runs = Object.values(p.read().runs);
  assert.equal(runs.length, 2, 'one checkpoint per worktree in the shared ledger');
  assert.deepEqual(runs.map((r: any) => r.worktree).sort(), [w1, w2].sort());

  const v1 = ok(p.ta('inspect', [], { where: w1 })).run;
  const v2 = ok(p.ta('inspect', [], { where: w2 })).run;
  assert.notEqual(v1.runKey, v2.runKey);
  assert.deepEqual([v1.control, v1.budget.attempts, v1.totals.attempts], ['paused', 5, 1]);
  assert.deepEqual([v2.control, v2.budget.attempts, v2.totals.attempts], ['paused', 7, 0]);
  assert.deepEqual(v1.history.map((h: any) => [h.action, h.reason]), [['start', null], ['pause', 'w1 break']]);
  assert.deepEqual(v2.history.map((h: any) => [h.action, h.reason]), [['start', null], ['pause', 'w2 break']]);

  // Cancelling the second run leaves the first run's attempt alone.
  const c2: any = ok(p.ta('cancel', ['--by', 'lead', '--reason', 'w2 done'], { where: w2 }), 'cancelled');
  assert.deepEqual(c2.cancelled, []);
  assert.deepEqual(c2.notCancelled.map((x: any) => [x.taskId, x.runKey]), [['A.1', v1.runKey]]);
  assert.equal(ok(p.ta('inspect', [], { where: w1 })).run.control, 'paused');
  assert.equal(p.read().tasks['A.1'].attempts[0].state, 'active');
});

test('Scenario: Pause and cancel (FR-012)', (t) => {
  const p = project(t);
  start(p);
  const a1 = ok(claim(p, 'A.1'), 'claimed');
  const a2 = ok(claim(p, 'A.2'), 'claimed');
  ok(p.ta('pause', ['--by', 'lead', '--reason', 'lunch']), 'paused');
  exit1(claim(p, 'A.3'), 'refused', 'run-paused');
  complete(p, 'A.1', a1.token);  // an active attempt can still finish while paused
  assert.equal(taskOf(ok(p.ta('status')), 'A.1').state, 'SUCCEEDED');

  const cancelled = ok(p.ta('cancel', ['--by', 'user', '--reason', 'scope cut']), 'cancelled');
  assert.deepEqual(cancelled.cancelled, [{ taskId: 'A.2', token: a2.token }]);
  const attempt = p.read().tasks['A.2'].attempts[0];
  assert.equal(attempt.state, 'cancelled');
  assert.deepEqual([attempt.cancel.by, attempt.cancel.reason], ['user', 'scope cut']);
  assert.equal(taskOf(ok(p.ta('status')), 'A.2').state, 'CANCELLED');
  exit1(claim(p, 'A.3'), 'refused', 'run-cancelled');

  const view = ok(p.ta('inspect'));
  assert.equal(view.run.control, 'cancelled');
  const history = view.run.history.map((h: any) => ({ action: h.action, by: h.by, reason: h.reason }));
  assert.deepEqual(history, [
    { action: 'start', by: 'lead', reason: null },
    { action: 'pause', by: 'lead', reason: 'lunch' },
    { action: 'cancel', by: 'user', reason: 'scope cut' },
  ]);
  assert.deepEqual(view.run.history[2].cancelled, [{ taskId: 'A.2', token: a2.token }]);
});

test('Scenario: Resume reports before it continues (FR-013)', (t) => {
  const p = project(t);
  start(p);
  const a1 = ok(claim(p, 'A.1'), 'claimed');
  ok(p.ta('pause', ['--by', 'lead', '--reason', 'session ending']), 'paused');
  fs.writeFileSync(path.join(p.repo, 'a.js'), '// changed since the attempt began\n');

  // Persisted context from another branch: a pending summary and a claimed copy left unconsumed.
  const env: any = { HOME: p.home, XDG_CONFIG_HOME: path.join(p.home, '.config') };
  const scope = summaryScope(p.repo, 'r1', 'main', env);
  fs.mkdirSync(scope, { recursive: true });
  const header = '---\nsummary_id: s-20260101T000000Z-abcdef\nbranch: feat/other\n---\n\nBODY\n';
  const pending = path.join(scope, 'summary.md');
  const claimedCopy = path.join(scope, '.claimed.unit-1');
  fs.writeFileSync(pending, header);
  fs.writeFileSync(claimedCopy, header);

  const before = p.bytes();
  const asked = exit1(p.ta('resume'), 'ack-required');
  assert.deepEqual(p.bytes(), before, 'an unacknowledged resume writes nothing');
  const r = asked.report;
  assert.equal(r.control, 'paused');
  assert.deepEqual(r.activeAttempts.map((a: any) => [a.taskId, a.token, a.owner, a.mode, typeof a.ageSeconds]),
    [['A.1', a1.token, 'core-implementer', 'subagent', 'number']]);
  assert.deepEqual(r.changedSources, [{ taskId: 'A.1', token: a1.token, file: 'a.js', change: 'changed' }]);
  assert.deepEqual(r.staleContext, [
    { kind: 'summary', path: pending, reasons: ['branch-differs'] },
    { kind: 'claimed-summary', path: claimedCopy, reasons: ['claimed-not-consumed'] },
  ]);

  // No claim until the report is acknowledged.
  exit1(claim(p, 'A.2'), 'refused', 'run-paused');
  exit1(claim(p, 'A.2', { epoch: 2 }), 'refused', 'run-paused');
  exit1(p.ta('resume', ['--ack', `sha256:${'0'.repeat(64)}`, '--by', 'lead']), 'refused', 'report-changed');

  const resumed = ok(p.ta('resume', ['--ack', asked.digest, '--by', 'lead']), 'resumed');
  assert.equal(resumed.epoch, 2);
  assert.equal(fs.existsSync(pending) && fs.existsSync(claimedCopy), true, 'resume reports stale context; it never moves it');
  ok(claim(p, 'A.2', { epoch: 2 }), 'claimed');
});

test('Scenario: Restart requires resume (FR-017)', (t) => {
  const p = project(t);
  const started = start(p);
  assert.equal(started.epoch, 1);
  ok(claim(p, 'A.1', { epoch: 1 }), 'claimed');
  // The session crashes while running; a new session has lost the epoch.
  const fresh = exit1(claim(p, 'A.2', { epoch: null }), 'refused', 'resume-required');
  assert.equal(fresh.epoch, 1);
  const asked = exit1(p.ta('resume'), 'ack-required');
  assert.deepEqual(asked.report.activeAttempts.map((a: any) => a.taskId), ['A.1'], 'the new session sees the report first');
  const resumed = ok(p.ta('resume', ['--ack', asked.digest, '--by', 'lead', '--reason', 'new session']), 'resumed');
  assert.equal(resumed.epoch, 2);
  exit1(claim(p, 'A.2', { epoch: 1 }), 'refused', 'resume-required');
  const admitted = ok(claim(p, 'A.2', { epoch: 2 }), 'claimed');
  assert.equal(p.read().tasks['A.2'].attempts.find((a: any) => a.token === admitted.token).epoch, 2);
});
