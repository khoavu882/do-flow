'use strict';

// AU-P1: the unattended envelope of the roadmap loop. Every `perform` carries the literal
// `attendance` field; the loop's dispatch start asks for `--fallback auto`; a stage that never hands
// off is held by digest (K59) so it spends no step per call while other rows advance; a
// `resume-required` dispatch is acked once and a changed report is `denied report-changed` (D11).
// Scratch HOME and XDG under the temp folder, git identity set per spawn.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { repoFromTemplate } = require('../helper/repo-template.ts');
const { next } = require('../../src/runtime/roadmap/loop.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');

const REPO = path.resolve(__dirname, '../..');
const SWITCH = 'DOFLOW_AUTOPILOT_ENABLED';
const digest = (bytes: any) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const write = (file: any, bytes: any) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const rowOf = (id: string, cls: string, writeSet: string[]): any => ({ id, slug: `${id}-${cls}`, title: `Row ${id}`, class: cls, needs: [], writeSet });

function fixture(t: any, rows: any[]) {
  const dir = tempDir(t, 'doflow-roadmap-unattended-');
  const root = path.join(dir, 'main');
  const develop = path.join(dir, 'develop');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '',
    GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test',
    GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test', GIT_AUTHOR_DATE: '1792400000 +0000', GIT_COMMITTER_DATE: '1792400000 +0000' };
  delete env[SWITCH];
  const git = (cwd: any, ...args: any[]) => cp.execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const policy = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));
  policy.classes.feature['gate-0'].predicates = ['markers-zero:requirement'];
  policy.classes.feature['gate-a'].predicates = ['markers-zero:plan'];
  policy.classes.feature['gate-b'].predicates = ['markers-zero:plan'];
  policy.classes.bug['gate-b'].predicates = ['plan-verification-absent', 'protected-paths'];
  const gates = `${JSON.stringify(policy, null, 2)}\n`;
  repoFromTemplate(`unattended-base:${digest(gates)}`, root, (base: any) => {
    git(base, 'init', '-q', '-b', 'main');
    git(base, 'config', 'user.name', 'Develop Owner');
    git(base, 'config', 'user.email', 'develop@example.test');
    git(base, 'config', 'core.hooksPath', '/dev/null');
    write(path.join(base, '.gitignore'), '.doflow/\nagent-docs/\n');
    write(path.join(base, 'core/registry/gates.json'), gates);
    write(path.join(base, 'shared.txt'), 'base\n');
    write(path.join(base, 'package.json'), `${JSON.stringify({ private: true, scripts: { test: 'node -e 0' } })}\n`);
    git(base, 'add', '.');
    git(base, 'commit', '-qm', 'base');
  });
  git(root, 'worktree', 'add', '-qb', 'develop', develop);
  write(path.join(root, 'agent-docs/roadmap/rows.json'), JSON.stringify({ schema: 1, rows }));
  write(path.join(home, '.config/doflow/settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' }));
  let clock = Date.parse('2026-10-31T00:00:00.000Z');
  const tick = () => new Date(clock += 1000);
  const worktree = (row: any) => path.join(dir, `main-${row.id}`);
  const orch = (row: any) => new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: worktree(row),
    stateDir: path.join(worktree(row), '.doflow/state/orchestration'), featureSlug: row.slug, env, readinessEvaluate: () => 'READY' });
  return { dir, root, develop, env, git, tick, worktree, orch,
    next: (options: any = {}) => next({ root, env, now: tick, ...options }),
    record: (runId: any) => JSON.parse(fs.readFileSync(path.join(root, '.doflow/state/roadmap/runs', `${runId}.json`), 'utf8')) };
}

/** Puts the row's real compiled run on `nodeId`, as the roadmap-loop tests do. */
function placeRun(f: any, row: any, nodeId: string) {
  const orch = f.orch(row);
  const run = orch.readRun(row.slug);
  run.cursor = run.program.findIndex((n: any) => n.id === nodeId);
  for (const node of run.program.slice(0, run.cursor)) node.status = node.type === 'gate' ? 'approved' : 'completed';
  run.state = 'RUNNING';
  orch.writeRun(run, f.tick());
}

test('every perform envelope carries the literal attendance field with its run id, and loop.ts imports no attendance module', async (t) => {
  const bug = rowOf('301', 'bug', ['a/']);
  const feature = rowOf('302', 'feature', ['b/']);
  const f = fixture(t, [bug, feature]);
  await f.next(); // pick the bug row
  const stage = await f.next();
  assert.equal(stage.result.outcome, 'perform');
  assert.deepEqual(stage.result.perform.attendance, { mode: 'unattended', run: stage.result.runId });

  // implementation of the feature chain (dispatch envelope) and a resumed dispatch carry it too.
  await f.next(); // denied: the bug stage was not performed; the next call picks the feature row
  const pick = await f.next();
  assert.deepEqual([pick.result.outcome, pick.result.step, pick.result.row], ['acted', 'pick', '302']);
  placeRun(f, feature, 'implementation');
  const implementation = await f.next({ dispatchFacts: () => ({ state: 'none', pause: null }) });
  assert.equal(implementation.result.row, '302');
  assert.deepEqual(implementation.result.perform.attendance, { mode: 'unattended', run: implementation.result.runId });
  const resumeDigest = () => ({ digest: `sha256:${'a'.repeat(64)}` });
  const resumed = await f.next({ dispatchFacts: () => ({ state: 'resume-required', pause: null }), resumeDigest });
  assert.deepEqual(resumed.result.perform.attendance, { mode: 'unattended', run: resumed.result.runId });

  // The loop only carries the literal: P3's attendance module is not a dependency of the loop.
  const source = fs.readFileSync(path.join(REPO, 'src/runtime/roadmap/loop.ts'), 'utf8');
  assert.equal(/require\(['"][^'"]*attendance(?:\.ts)?['"]\)/.test(source), false);
});

test('the post-merge verification perform carries attendance too', async (t) => {
  const row = rowOf('303', 'bug', ['a/']);
  const f = fixture(t, [row]);
  await f.next();
  write(path.join(f.worktree(row), 'a/x.txt'), 'x\n');
  f.git(f.worktree(row), 'add', '.');
  f.git(f.worktree(row), 'commit', '-qm', 'x');
  const orch = f.orch(row);
  const run = orch.readRun(row.slug);
  run.cursor = run.program.length - 1; // on gate-b
  for (const node of run.program.slice(0, run.cursor)) node.status = 'completed';
  run.state = 'AWAITING_GATE';
  orch.writeRun(run, f.tick());
  const gate = await f.next();
  assert.deepEqual([gate.result.step, gate.result.outcome], ['gate', 'acted']);
  const merged = await f.next();
  assert.equal(merged.result.annotations.pending, 'post-merge-verification');
  const verify = await f.next();
  assert.equal(verify.result.perform.purpose, 'post-merge');
  assert.deepEqual(verify.result.perform.attendance, { mode: 'unattended', run: verify.result.runId });
});

test('the loop dispatch start asks for --fallback auto and keeps --billing-cap free', async (t) => {
  const row = rowOf('304', 'feature', ['b/']);
  const f = fixture(t, [row]);
  await f.next();
  placeRun(f, row, 'implementation');
  const out = await f.next({ dispatchFacts: () => ({ state: 'none', pause: null }) });
  const start = out.result.perform.after[0];
  assert.deepEqual(start.slice(0, 9), ['dispatch', '--action', 'start', '--slug', row.slug, '--by', 'doflow-roadmap', '--billing-cap', 'free']);
  assert.equal(start[start.indexOf('--fallback') + 1], 'auto');
});

test('K59: a stage that never hands off is denied once, then held by digest; another row advances and no step is spent per call', async (t) => {
  const stuck = rowOf('305', 'bug', ['a/']);
  const other = rowOf('306', 'bug', ['b/']);
  const f = fixture(t, [stuck, other]);
  await f.next(); // pick 305
  const performed = await f.next();
  assert.deepEqual([performed.result.outcome, performed.result.row, performed.result.perform.stage], ['perform', '305', 'reproduction']);
  const denied = await f.next();
  assert.deepEqual([denied.result.outcome, denied.result.reason, denied.result.row], ['denied', 'stage-not-performed', '305']);
  const stepsAfterDenial = f.record(denied.result.runId).steps;

  // 305 is held: the next call picks the other row instead of denying 305 again.
  const pick = await f.next();
  assert.deepEqual([pick.result.outcome, pick.result.step, pick.result.row], ['acted', 'pick', '306']);
  const advanced = await f.next();
  assert.deepEqual([advanced.result.outcome, advanced.result.row, advanced.result.perform.stage], ['perform', '306', 'reproduction']);
  const log = f.record(advanced.result.runId).log;
  assert.equal(log.filter((e: any) => e.row === '305' && e.outcome === 'denied').length, 1, 'one denial for the held row, however many calls');
  assert.equal(f.record(advanced.result.runId).steps, stepsAfterDenial + 2, 'only the pick and the perform spent steps');

  // The other row never hands off either: both are held, the loop is idle and spends nothing.
  const bothHeld = await f.next();
  assert.deepEqual([bothHeld.result.outcome, bothHeld.result.reason], ['denied', 'stage-not-performed']);
  const idle = await f.next();
  assert.equal(idle.result.outcome, 'idle');
  assert.deepEqual([idle.result.skips['305'], idle.result.skips['306']], ['held:stage-not-performed', 'held:stage-not-performed']);
  const steps = f.record(idle.result.runId).steps;
  await f.next();
  await f.next();
  assert.equal(f.record(idle.result.runId).steps, steps, 'repeated calls spend no step');

  // A handoff changes the inputs: the stage is judged again and the row moves on.
  f.orch(stuck).handoff({ taskId: stuck.slug, callingSkill: 'do-test', note: 'reproduced', now: f.tick() });
  const moved = await f.next();
  assert.deepEqual([moved.result.outcome, moved.result.row, moved.result.perform.stage], ['perform', '305', 'root-cause']);
  assert.equal(f.record(moved.result.runId).rows['305'].held, undefined, 'the hold is cleared once the stage is performed');
});

test('K59: a dispatch that completed without the implementation handoff is held too', async (t) => {
  const row = rowOf('307', 'feature', ['b/']);
  const f = fixture(t, [row]);
  await f.next();
  placeRun(f, row, 'implementation');
  const facts = { dispatchFacts: () => ({ state: 'completed', pause: null, integration: null }) };
  const first = await f.next(facts);
  assert.deepEqual([first.result.outcome, first.result.reason], ['denied', 'stage-not-performed']);
  const steps = f.record(first.result.runId).steps;
  const again = await f.next(facts);
  assert.deepEqual([again.result.outcome, again.result.skips[row.id]], ['idle', 'held:stage-not-performed']);
  assert.equal(f.record(again.result.runId).steps, steps);
});

test('D11: a resume-required dispatch is acked once; an unchanged report re-yields that ack and a changed report is denied report-changed', async (t) => {
  const row = rowOf('308', 'feature', ['b/']);
  const f = fixture(t, [row]);
  await f.next();
  placeRun(f, row, 'implementation');
  const a = `sha256:${'a'.repeat(64)}`;
  const b = `sha256:${'b'.repeat(64)}`;
  let current = a;
  const options = { dispatchFacts: () => ({ state: 'resume-required', pause: null }), resumeDigest: () => ({ digest: current }) };
  const first = await f.next(options);
  assert.equal(first.result.outcome, 'perform');
  assert.deepEqual(first.result.perform.after[0], ['dispatch', '--action', 'resume', '--slug', row.slug, '--ack', a, '--by', 'doflow-roadmap']);
  assert.equal(f.record(first.result.runId).rows[row.id].dispatch.resumeAck, a);
  const same = await f.next(options);
  assert.equal(same.result.outcome, 'perform');
  assert.equal(same.result.perform.after[0][6], a, 'the one recorded ack is carried again');
  current = b;
  const changed = await f.next(options);
  assert.deepEqual([changed.result.outcome, changed.result.reason, changed.code], ['denied', 'report-changed', 1]);
  assert.deepEqual(changed.result.annotations, { recorded: a, current: b });
  assert.equal(f.record(changed.result.runId).rows[row.id].dispatch.resumeAck, a, 'the recorded ack is never replaced by the changed digest');
});
