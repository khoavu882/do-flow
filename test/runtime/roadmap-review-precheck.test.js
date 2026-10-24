'use strict';

// 095b A.3 (IC-007): the roadmap loop holds a row at the review stage, before the review envelope,
// when gate-b's own verify rule (verifyRecordReasons) would deny the feature head. A focused sibling
// of roadmap-loop.test.js: same scratch-repository pattern, the real orchestrator and gate policy.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { next } = require('../../src/runtime/roadmap/loop.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');

const REPO = path.resolve(__dirname, '../..');
const ROW = { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [], writeSet: ['toy/'] };
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

function fixture(t) {
  const dir = tempDir(t, 'doflow-review-precheck-');
  const root = path.join(dir, 'main');
  const develop = path.join(dir, 'develop');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test',
    GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test',
    GIT_AUTHOR_DATE: '1792400000 +0000', GIT_COMMITTER_DATE: '1792400000 +0000' };
  delete env.DOFLOW_AUTOPILOT_ENABLED;
  const git = (cwd, ...args) => cp.execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Develop Owner');
  git(root, 'config', 'user.email', 'develop@example.test');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  write(path.join(root, '.gitignore'), '.doflow/\nagent-docs/\n');
  const policy = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));
  for (const gate of ['gate-0', 'gate-a', 'gate-b']) policy.classes.feature[gate].predicates = [gate === 'gate-0' ? 'markers-zero:requirement' : 'markers-zero:plan'];
  write(path.join(root, 'core/registry/gates.json'), `${JSON.stringify(policy, null, 2)}\n`);
  write(path.join(root, 'shared.txt'), 'base\n');
  write(path.join(root, 'package.json'), `${JSON.stringify({ private: true, scripts: { test: 'node -e 0' } })}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  git(root, 'worktree', 'add', '-qb', 'develop', develop);
  write(path.join(root, 'agent-docs/roadmap/rows.json'), JSON.stringify({ schema: 1, rows: [ROW] }));
  write(path.join(home, '.config/doflow/settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' }));
  let clock = Date.parse('2026-10-19T00:00:00.000Z');
  const tick = () => new Date(clock += 1000);
  const worktree = path.join(dir, 'main-113');
  const orch = () => new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: worktree,
    stateDir: path.join(worktree, '.doflow/state/orchestration'), featureSlug: ROW.slug, env, readinessEvaluate: () => 'READY' });
  return { dir, root, env, git, tick, worktree, orch, next: () => next({ root, env, now: tick }),
    runs: path.join(root, '.doflow/state/verification/runs/113-toy.jsonl') };
}

/** Picks the row, commits one feature change and puts the real compiled run on the review stage. */
async function atReview(t) {
  const f = fixture(t);
  await f.next();
  write(path.join(f.worktree, 'toy/a.txt'), 'feature\n');
  f.git(f.worktree, 'add', '.');
  f.git(f.worktree, 'commit', '-qm', 'toy');
  const orch = f.orch();
  const run = orch.readRun(ROW.slug);
  run.cursor = run.program.findIndex((n) => n.id === 'review');
  for (const node of run.program.slice(0, run.cursor)) node.status = node.type === 'gate' ? 'approved' : 'completed';
  run.state = 'RUNNING';
  orch.writeRun(run, f.tick());
  return { f, head: f.git(f.root, 'rev-parse', 'feat/113-toy') };
}

const verifyLine = (head, verdict) => `${JSON.stringify({ schema: 1, taskId: '113-toy', head, clean: true, verdict,
  at: '2026-10-19T00:00:00Z', reportSha256: `sha256:${'e'.repeat(64)}` })}\n`;

test('IC-007: a row at review with no verify line is denied at step review, verify-missing, and no envelope is issued', async (t) => {
  const { f } = await atReview(t);
  const out = await f.next();
  assert.deepEqual([out.result.outcome, out.result.step, out.result.reason, out.result.rule, out.result.row],
    ['denied', 'review', 'verify-missing', 'review/verify-missing', '113']);
  assert.deepEqual(out.result.reasons, ['verify-missing']);
  assert.equal(out.result.perform, undefined, 'no review envelope');
});

test('IC-007: a FAIL line on the feature head holds the row as verify-not-pass; a repeat on unchanged inputs is skipped as held', async (t) => {
  const { f, head } = await atReview(t);
  write(f.runs, verifyLine(head, 'FAIL'));
  const out = await f.next();
  assert.deepEqual([out.result.outcome, out.result.step, out.result.reason, out.result.rule],
    ['denied', 'review', 'verify-not-pass', 'review/verify-not-pass']);
  assert.equal(out.result.perform, undefined);
  const repeat = await f.next();
  assert.equal(repeat.result.outcome, 'idle');
  assert.equal(repeat.result.skips['113'], 'held:verify-not-pass');
});

test('IC-007: a changed record releases the hold and a clean PASS on the feature head issues the review envelope as before', async (t) => {
  const { f, head } = await atReview(t);
  write(f.runs, verifyLine(head, 'FAIL'));
  assert.equal((await f.next()).result.outcome, 'denied');
  fs.appendFileSync(f.runs, verifyLine(head, 'PASS'));
  const held = await f.next();
  assert.equal(held.result.reason, 'verify-flaky', 'a FAIL later hidden by a PASS is a different reason set, so a different digest');
  write(f.runs, verifyLine(head, 'PASS'));
  const out = await f.next();
  assert.deepEqual([out.result.outcome, out.result.perform.stage, out.result.perform.skill], ['perform', 'review', 'do-code-review']);
});

test('IC-007: a PASS line on the feature head issues the review envelope with nothing held', async (t) => {
  const { f, head } = await atReview(t);
  write(f.runs, verifyLine(head, 'PASS'));
  const out = await f.next();
  assert.deepEqual([out.result.outcome, out.result.perform.stage], ['perform', 'review']);
});

test('IC-007: a PASS on another head does not count: the row is held as verify-missing', async (t) => {
  const { f } = await atReview(t);
  write(f.runs, verifyLine('a'.repeat(40), 'PASS'));
  const out = await f.next();
  assert.deepEqual([out.result.outcome, out.result.step, out.result.reason], ['denied', 'review', 'verify-missing']);
});
