'use strict';
// task-attempts.test.js — the task-attempt ledger (feature 070; FR-001..FR-007, NFR-001).
//
// A subprocess suite for the verb, for the reason runtime-outcome.test.js gives: the contract is
// exit codes, a JSON answer and bytes on disk, and a library call proves none of them. Evidence is
// written in-process with the evidence ledger so each case can pin the observation time, freshness
// and task binding the finish checks read. The orchestrator gate (FR-006) is exercised in-process
// against an orchestrator that is handed the real completion checker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator');
const { checkCompletion, taskLineHash } = require('../../src/runtime/task-attempts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SLUG = 'feat-x';

const PLAN = [
  '# Plan', '', '## Tasks', '',
  '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js',
  '- [ ] A.2 second task; owner: core-implementer; files: b.js', '',
  '### Phase B', '',
  '- [ ] B.1 third task; owner: quality-guardian; files: c.js', '',
].join('\n');

/** A scratch git project holding a feature folder with `plan`. */
function project(t, { plan = PLAN, commit = false } = {}) {
  const scratch = createScratch('doflow-task-attempts-');
  t.after(() => scratch.remove());
  const dir = path.join(scratch.dir, 'project');
  fs.mkdirSync(path.join(dir, 'agent-docs', 'doflow', SLUG), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md'), plan);
  const git = (...args) => {
    const done = spawnSync('git', args, { cwd: dir, env: scratch.env(), encoding: 'utf8' });
    assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
    return done.stdout;
  };
  git('init', '-q');
  if (commit) { git('add', '-A'); git('commit', '-q', '-m', 'seed'); }
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  const store = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  const run = (args, cwd = dir) => {
    const done = spawnSync(process.execPath, [CLI, 'task-attempt', ...args, '--json'], { cwd, env: scratch.env(), encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(done.stdout); } catch { /* reported by the assertion that reads data */ }
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, data };
  };
  const ta = (action, extra = []) => run(['--action', action, '--slug', SLUG, ...extra]);
  const claim = (task, owner = 'core-implementer') => ta('claim', ['--task', task, '--owner', owner, '--mode', 'subagent']);
  const finish = (task, token, result, evidenceId) => ta('finish', ['--task', task, '--token', String(token), '--result', result, ...(evidenceId ? ['--evidence-id', evidenceId] : [])]);
  const release = (task, token, reason = 'abandoned') => ta('release', ['--task', task, '--token', String(token), '--reason', reason]);
  /** Records one evidence item and returns its id. */
  const evidence = (taskId, overrides = {}) => {
    const ledger = new EvidenceLedger({ repoRoot: dir, slug: SLUG });
    const id = ledger.addEvidence({
      taskId, kind: 'test-result', provenance: 'extracted', source: { provider: 'shell', capability: 'test' },
      locator: { file: 'a.test.js' }, content: 'ran',
      observation: { command: 'node --test', exitCode: 0 },
      ...overrides,
    });
    ledger.save(taskId);
    return id;
  };
  return { scratch, dir, git, planFile, store, run, ta, claim, finish, release, evidence };
}

const bytes = (file) => fs.readFileSync(file);

test('claim grants a token and a second claim of the same task is refused (FR-001)', (t) => {
  const p = project(t);
  const first = p.claim('A.1');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.data.disposition, 'claimed');
  assert.equal(first.data.taskId, 'A.1');
  assert.equal(first.data.token, 1);
  assert.equal(first.data.revision, 1);
  const second = p.claim('A.1');
  assert.equal(second.status, 1);
  assert.deepEqual([second.data.disposition, second.data.reason], ['refused', 'active-attempt']);
  const unknown = p.claim('Z.9');
  assert.equal(unknown.status, 1);
  assert.equal(unknown.data.reason, 'unknown-task');
});

test('concurrent claims from two processes yield exactly one claimed (FR-001)', async (t) => {
  const p = project(t);
  const launch = (owner) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'task-attempt', '--action', 'claim', '--slug', SLUG, '--task', 'A.1', '--owner', owner, '--mode', 'subagent', '--json'],
      { cwd: p.dir, env: p.scratch.env() });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (status) => resolve({ status, data: JSON.parse(out) }));
  });
  const [one, two] = await Promise.all([launch('worker-one'), launch('worker-two')]);
  const outcomes = [one, two].map((r) => `${r.status}:${r.data.disposition}:${r.data.reason ?? ''}`).sort();
  assert.deepEqual(outcomes, ['0:claimed:', '1:refused:active-attempt']);
  const store = JSON.parse(bytes(p.store));
  assert.equal(store.tasks['A.1'].attempts.length, 1);
  assert.equal(store.tasks['A.1'].nextToken, 2);
});

test('a stale token cannot finish or release, and changes nothing (FR-002)', (t) => {
  const p = project(t);
  assert.equal(p.claim('A.1').data.token, 1);
  assert.equal(p.release('A.1', 1).data.disposition, 'released');
  assert.equal(p.claim('A.1').data.token, 2);

  let before = bytes(p.store);
  const wrong = p.finish('A.1', 1, 'BLOCKED');
  assert.equal(wrong.status, 1);
  assert.deepEqual([wrong.data.disposition, wrong.data.reason], ['stale', 'token-mismatch']);
  const wrongRelease = p.release('A.1', 1);
  assert.equal(wrongRelease.status, 1);
  assert.equal(wrongRelease.data.disposition, 'stale');
  assert.deepEqual(bytes(p.store), before, 'a stale call must not touch the store');

  assert.equal(p.release('A.1', 2).data.disposition, 'released');
  before = bytes(p.store);
  const after = p.finish('A.1', 2, 'BLOCKED');
  assert.equal(after.status, 1);
  assert.deepEqual([after.data.disposition, after.data.reason], ['stale', 'no-active-attempt']);
  assert.deepEqual(bytes(p.store), before);
});

test('finish is refused with plan-changed when the task line changed after the claim; ticking the box is not a change (FR-002)', (t) => {
  const p = project(t);
  const token = p.claim('A.1').data.token;
  fs.writeFileSync(p.planFile, PLAN.replace('first task;', 'first task, reworded;'));
  const before = bytes(p.store);
  const refused = p.finish('A.1', token, 'BLOCKED');
  assert.equal(refused.status, 1);
  assert.deepEqual([refused.data.disposition, refused.data.reason], ['refused', 'plan-changed']);
  assert.deepEqual(bytes(p.store), before);

  fs.writeFileSync(p.planFile, PLAN.replace('- [ ] A.1', '- [x] A.1'));
  const applied = p.finish('A.1', token, 'BLOCKED');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.data.disposition, 'applied');
});

test('the task line hash covers the task fields and ignores the checkbox (FR-002)', () => {
  const base = { id: 'A.1', description: 'd', stories: [], owner: 'o', files: ['a.js'], dependsOn: [], externalContract: null };
  assert.equal(taskLineHash(base), taskLineHash({ ...base, done: true }));
  assert.notEqual(taskLineHash(base), taskLineHash({ ...base, files: ['b.js'] }));
  assert.match(taskLineHash(base), /^sha256:[0-9a-f]{64}$/);
});

test('a task claims only when every earlier phase is done (FR-003)', (t) => {
  const p = project(t);
  const early = p.claim('B.1');
  assert.equal(early.status, 1);
  assert.deepEqual([early.data.disposition, early.data.reason], ['refused', 'unmet-phase']);
  assert.deepEqual(early.data.unmet, ['A.1', 'A.2']);

  for (const task of ['A.1', 'A.2']) {
    const token = p.claim(task).data.token;
    const id = p.evidence(task);
    assert.equal(p.finish(task, token, 'COMPLETED', id).status, 0);
  }
  const later = p.claim('B.1');
  assert.equal(later.status, 0, later.stdout);
  assert.equal(later.data.disposition, 'claimed');
});

test('a completed task cannot be claimed again (FR-001)', (t) => {
  const p = project(t);
  const token = p.claim('A.1').data.token;
  assert.equal(p.finish('A.1', token, 'COMPLETED', p.evidence('A.1')).status, 0);
  const again = p.claim('A.1');
  assert.equal(again.status, 1);
  assert.equal(again.data.reason, 'already-done');
});

test('COMPLETED needs passing, fresh, task-bound test-result evidence; other results need none (FR-004)', (t) => {
  const p = project(t);
  const token = p.claim('A.1').data.token;
  const refusal = (evidenceId) => {
    const before = bytes(p.store);
    const answer = p.finish('A.1', token, 'COMPLETED', evidenceId);
    assert.equal(answer.status, 1, answer.stdout);
    assert.equal(answer.data.disposition, 'refused');
    assert.deepEqual(bytes(p.store), before, 'a refused finish must not touch the store');
    return answer.data.reason;
  };

  assert.equal(refusal(undefined), 'evidence-required');
  assert.equal(refusal('ev_does_not_exist'), 'evidence-not-found');
  assert.equal(refusal(p.evidence('A.1', { observation: { command: 'node --test', exitCode: 1 } })), 'evidence-not-passing');
  assert.equal(refusal(p.evidence('A.1', { observation: null })), 'evidence-not-passing');
  assert.equal(refusal(p.evidence('A.1', { freshness: { status: 'STALE', observedAt: new Date(Date.now() + 60000).toISOString() } })), 'evidence-stale');
  assert.equal(refusal(p.evidence('A.1', { kind: 'documentation' })), 'evidence-wrong-kind');
  assert.equal(refusal(p.evidence('A.2')), 'evidence-wrong-task');
  assert.equal(refusal(p.evidence('A.1', { freshness: { status: 'FRESH', observedAt: '2000-01-01T00:00:00.000Z' } })), 'evidence-before-attempt');

  const superseded = p.evidence('A.1');
  const replacement = p.evidence('A.1');
  const ledger = new EvidenceLedger({ repoRoot: p.dir, slug: SLUG });
  ledger.load('A.1');
  ledger.supersedeEvidence(superseded, replacement);
  ledger.save('A.1');
  assert.equal(refusal(superseded), 'evidence-superseded');

  const applied = p.finish('A.1', token, 'COMPLETED', replacement);
  assert.equal(applied.status, 0, applied.stdout);
  assert.deepEqual([applied.data.disposition, applied.data.result], ['applied', 'COMPLETED']);

  // BLOCKED, ABANDONED and INCONCLUSIVE take no evidence.
  for (const result of ['BLOCKED', 'ABANDONED', 'INCONCLUSIVE']) {
    const claimed = p.claim('A.2');
    assert.equal(claimed.status, 0, claimed.stdout);
    assert.equal(p.finish('A.2', claimed.data.token, result).data.disposition, 'applied');
  }
});

test('evidence recorded under the feature slug proves any task of the feature (FR-004)', (t) => {
  const p = project(t);
  const token = p.claim('A.1').data.token;
  const applied = p.finish('A.1', token, 'COMPLETED', p.evidence(SLUG));
  assert.equal(applied.status, 0, applied.stdout);
});

test('status reports completion from the ledger, never from checkboxes (FR-005)', (t) => {
  const p = project(t, { plan: PLAN.replace('- [ ] A.1', '- [x] A.1') });
  const before = p.ta('status');
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.data.complete, false);
  assert.deepEqual(before.data.unclaimedChecked, ['A.1']);
  const states = Object.fromEntries(before.data.tasks.map((task) => [task.id, task.derived]));
  assert.deepEqual(states, { 'A.1': 'ready', 'A.2': 'ready', 'B.1': 'pending' });

  const token = p.claim('A.1').data.token;
  assert.equal(p.ta('status').data.tasks[0].derived, 'running');
  assert.equal(p.ta('status').data.tasks[0].activeToken, token);
  assert.equal(p.finish('A.1', token, 'BLOCKED').status, 0);
  assert.equal(p.ta('status').data.tasks[0].derived, 'blocked');
  assert.deepEqual(p.ta('status').data.unclaimedChecked, ['A.1']);

  for (const task of ['A.1', 'A.2', 'B.1']) {
    const claimed = p.claim(task);
    assert.equal(claimed.status, 0, claimed.stdout);
    assert.equal(p.finish(task, claimed.data.token, 'COMPLETED', p.evidence(task)).status, 0);
  }
  const done = p.ta('status');
  assert.equal(done.data.complete, true);
  assert.deepEqual(done.data.unclaimedChecked, []);
  assert.deepEqual(done.data.tasks.map((task) => [task.id, task.derived, task.doneToken]), [['A.1', 'done', 2], ['A.2', 'done', 1], ['B.1', 'done', 1]]);
});

test('a linked worktree reads and writes the main worktree store (FR-007)', (t) => {
  const p = project(t, { commit: true });
  const linked = path.join(p.scratch.dir, 'linked');
  p.git('worktree', 'add', '-q', linked, '-b', 'linked-branch');

  const claimed = p.claim('A.1');
  assert.equal(claimed.status, 0, claimed.stderr);

  const seen = p.run(['--action', 'status', '--slug', SLUG], linked);
  assert.equal(seen.status, 0, seen.stderr);
  const task = seen.data.tasks.find((entry) => entry.id === 'A.1');
  assert.equal(task.derived, 'running');
  assert.equal(task.activeToken, claimed.data.token);
  assert.equal(fs.existsSync(path.join(linked, '.doflow', 'state', 'task-attempts', `${SLUG}.json`)), false, 'the linked worktree must not grow its own store');

  const second = p.run(['--action', 'claim', '--slug', SLUG, '--task', 'A.1', '--owner', 'other', '--mode', 'manual'], linked);
  assert.equal(second.status, 1);
  assert.equal(second.data.reason, 'active-attempt');
});

test('a torn or future-version store is refused by every action and left unchanged (NFR-001)', (t) => {
  const p = project(t);
  assert.equal(p.claim('A.1').status, 0);
  const cases = [
    ['torn', '{"version":1,"revision":'],
    ['future version', JSON.stringify({ version: 2, revision: 9, tasks: {} })],
    ['not a ledger', JSON.stringify({ version: 1, revision: 1, tasks: [] })],
  ];
  for (const [label, content] of cases) {
    fs.writeFileSync(p.store, content);
    const before = bytes(p.store);
    const attempts = [
      p.claim('A.2'), p.finish('A.1', 1, 'BLOCKED'), p.release('A.1', 1), p.ta('status'),
    ];
    for (const attempt of attempts) {
      assert.equal(attempt.status, 2, `${label}: ${attempt.stdout}`);
      assert.equal(attempt.data.ok, false);
      assert.equal(attempt.data.error, 'store-unreadable');
    }
    assert.deepEqual(bytes(p.store), before, `${label}: the file must be left unchanged`);
  }
});

test('malformed input exits 2: missing slug, task, token, result, mode and unknown action', (t) => {
  const p = project(t);
  assert.equal(p.run(['--action', 'status']).status, 2, 'no slug and no feature branch');
  assert.equal(p.ta('claim', ['--owner', 'o', '--mode', 'manual']).status, 2);
  assert.equal(p.ta('claim', ['--task', 'A.1', '--owner', 'o', '--mode', 'always']).status, 2);
  assert.equal(p.ta('claim', ['--task', 'A.1', '--mode', 'manual']).status, 2);
  assert.equal(p.ta('finish', ['--task', 'A.1', '--result', 'BLOCKED']).status, 2);
  assert.equal(p.ta('finish', ['--task', 'A.1', '--token', 'x', '--result', 'BLOCKED']).status, 2);
  assert.equal(p.ta('finish', ['--task', 'A.1', '--token', '1', '--result', 'DONE']).status, 2);
  assert.equal(p.ta('release', ['--task', 'A.1', '--token', '1']).status, 2);
  assert.equal(p.ta('rewind').status, 2);
  assert.equal(fs.existsSync(p.store), false, 'no malformed call may create the store');
});

test('a plan with a duplicate task id is malformed input (design A-001)', (t) => {
  const p = project(t, { plan: PLAN.replace('A.2 second', 'A.1 second') });
  const answer = p.claim('A.1');
  assert.equal(answer.status, 2);
  assert.equal(answer.data.error, 'plan-malformed');
});

test('the dispatcher serves the verb (doflow-run task-attempt)', (t) => {
  const p = project(t);
  const done = spawnSync('bash', [DISPATCHER, 'task-attempt', '--action', 'status', '--slug', SLUG, '--json'], {
    cwd: p.dir, env: p.scratch.env({ DOFLOW_CLI: CLI }), encoding: 'utf8',
  });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).complete, false);
});

// ── FR-006: the orchestrator gate ──────────────────────────────────────────────────────────────

/** A feature run parked on its implementation stage, with the real completion checker wired in. */
function runAtImplementation(t, p, { check } = {}) {
  const stateDir = path.join(p.scratch.dir, 'orch', '.doflow', 'state', 'orchestration');
  const orch = new WorkflowOrchestrator({
    repoRoot: REPO, stateDir, readinessEvaluate: () => 'READY',
    taskAttemptCheck: check || (() => checkCompletion({ slug: SLUG, cwd: p.dir })),
  });
  const taskId = 't.gate';
  orch.start({ taskId, taskClass: 'feature' });
  orch.completeStage({ taskId, stageId: 'discovery' });
  orch.decideGate({ taskId, gateId: 'gate-0', decision: 'approve' });
  orch.completeStage({ taskId, stageId: 'design' });
  orch.completeStage({ taskId, stageId: 'planning' });
  orch.decideGate({ taskId, gateId: 'gate-a', decision: 'approve' });
  return { orch, taskId };
}

const outcomeOf = (orch, taskId) => orch.readRun(taskId).program.find((n) => n.id === 'implementation');

test('completing implementation is refused while the ledger is incomplete, naming the tasks (FR-006)', (t) => {
  const p = project(t);
  const token = p.claim('A.1').data.token;
  assert.equal(p.finish('A.1', token, 'COMPLETED', p.evidence('A.1')).status, 0);
  const { orch, taskId } = runAtImplementation(t, p);

  assert.throws(() => orch.completeStage({ taskId, stageId: 'implementation', outcome: 'passed' }),
    /no COMPLETED attempt for A\.2, B\.1/);
  assert.equal(orch.status(taskId).current.id, 'implementation', 'a refused completion must not advance the run');
  assert.equal(outcomeOf(orch, taskId).status, 'pending');

  // The handoff path is gated the same way, before anything is written.
  assert.throws(() => orch.handoff({ taskId, taskClass: 'feature', callingSkill: 'do-execute-plan', note: 'done', outcome: 'passed' }),
    /no COMPLETED attempt for A\.2, B\.1/);
  assert.equal(orch.status(taskId).current.id, 'implementation');

  for (const task of ['A.2', 'B.1']) {
    const claimed = p.claim(task);
    assert.equal(p.finish(task, claimed.data.token, 'COMPLETED', p.evidence(task)).status, 0);
  }
  orch.completeStage({ taskId, stageId: 'implementation', outcome: 'passed' });
  const node = outcomeOf(orch, taskId);
  assert.equal(node.status, 'completed');
  assert.equal(node.outcome, 'passed', 'a complete ledger leaves the caller outcome alone');
});

test('completing implementation with no ledger records unverified, whatever outcome was supplied (FR-006)', (t) => {
  const p = project(t);
  const { orch, taskId } = runAtImplementation(t, p);
  orch.completeStage({ taskId, stageId: 'implementation', outcome: 'passed', note: 'built it' });
  const node = outcomeOf(orch, taskId);
  assert.equal(node.status, 'completed');
  assert.equal(node.outcome, 'unverified');
  const entry = orch.readRun(taskId).history.find((h) => h.node === 'implementation');
  assert.match(entry.note, /built it/);
  assert.match(entry.note, /No task-attempt ledger exists/);
});

test('a handoff with no ledger also records unverified (FR-006)', (t) => {
  const p = project(t);
  const { orch, taskId } = runAtImplementation(t, p);
  const snapshot = orch.handoff({ taskId, taskClass: 'feature', callingSkill: 'do-execute-plan', note: 'built it', outcome: 'passed' });
  assert.equal(snapshot.disposition, 'completed');
  assert.equal(outcomeOf(orch, taskId).outcome, 'unverified');
});

test('the gate applies only to the do-execute-plan implementation stage (FR-006)', (t) => {
  const p = project(t);
  const asked = [];
  const { orch, taskId } = runAtImplementation(t, p, { check: (node) => { asked.push(node.id); return { state: 'complete', slug: SLUG, incomplete: [] }; } });
  orch.completeStage({ taskId, stageId: 'implementation', outcome: 'passed' });
  for (const id of ['verification', 'review']) orch.completeStage({ taskId, stageId: id, outcome: 'passed' });
  assert.deepEqual(asked, ['implementation'], 'no other stage consults the ledger');
});

test('an orchestrator with no checker wired completes implementation as before (FR-006)', (t) => {
  const p = project(t);
  const stateDir = path.join(p.scratch.dir, 'orch', '.doflow', 'state', 'orchestration');
  const orch = new WorkflowOrchestrator({ repoRoot: REPO, stateDir, readinessEvaluate: () => 'READY' });
  orch.start({ taskId: 't.bare', taskClass: 'feature' });
  orch.completeStage({ taskId: 't.bare', stageId: 'discovery' });
  orch.decideGate({ taskId: 't.bare', gateId: 'gate-0', decision: 'approve' });
  orch.completeStage({ taskId: 't.bare', stageId: 'design' });
  orch.completeStage({ taskId: 't.bare', stageId: 'planning' });
  orch.decideGate({ taskId: 't.bare', gateId: 'gate-a', decision: 'approve' });
  orch.completeStage({ taskId: 't.bare', stageId: 'implementation', outcome: 'passed' });
  assert.equal(outcomeOf(orch, 't.bare').outcome, 'passed');
});

test('checkCompletion distinguishes no ledger, an incomplete one and a complete one (FR-006)', (t) => {
  const p = project(t);
  assert.deepEqual(checkCompletion({ slug: SLUG, cwd: p.dir }), { state: 'none', slug: SLUG, incomplete: [] });
  assert.equal(checkCompletion({ slug: null, cwd: p.dir }).state, 'none');
  const token = p.claim('A.1').data.token;
  assert.deepEqual(checkCompletion({ slug: SLUG, cwd: p.dir }), { state: 'incomplete', slug: SLUG, incomplete: ['A.1', 'A.2', 'B.1'] });
  assert.equal(p.finish('A.1', token, 'COMPLETED', p.evidence('A.1')).status, 0);
  for (const task of ['A.2', 'B.1']) {
    const claimed = p.claim(task);
    assert.equal(p.finish(task, claimed.data.token, 'COMPLETED', p.evidence(task)).status, 0);
  }
  assert.equal(checkCompletion({ slug: SLUG, cwd: p.dir }).state, 'complete');
  fs.writeFileSync(p.store, '{not json');
  assert.throws(() => checkCompletion({ slug: SLUG, cwd: p.dir }), /left unchanged/);
});
