'use strict';

// Feature 118 A.4 (IC-010, FR-013): the `plan-check` warning `review-owner` for a `quality-guardian`
// task at `tier: frontier`. A warning never fails the plan and never blocks a claim.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const SLUG = 'feat-r';

const plan = (lines: any) => ['# Plan', '', '**Task graph:** v1', '', '## 8. Tasks', '', ...lines, ''].join('\n');

function project(t: any, text: any) {
  const dir = tempDir(t, 'doflow-plan-check-review-owner-');
  const home = path.join(dir, '.home');
  fs.mkdirSync(home);
  const env: any = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, FORCE_COLOR: '',
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: dir,
  };
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, text);
  // plan-check cuts its text line at 200 characters, and an absolute scratch path alone is ~130 of them
  // (the margin was one character), so the plan is named relative to the project the CLI runs in.
  const run = (verb: any, args: any) => spawnSync(process.execPath, [CLI, verb, ...args.map((arg: any) => (arg === planFile ? path.relative(dir, planFile) : arg))], { cwd: dir, env, encoding: 'utf8' });
  return { dir, planFile, run };
}

const JSON_OF = (p: any) => {
  const done = p.run('plan-check', [p.planFile, '--json']);
  return { status: done.status, body: JSON.parse(done.stdout), stderr: done.stderr };
};

test('a quality-guardian task at tier frontier warns and still passes, in JSON and text', (t) => {
  const p = project(t, plan(['- [ ] A.1 Verify the build — owner: quality-guardian; tier: frontier; files: a.js']));
  const json = JSON_OF(p);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.body.ok, true);
  assert.deepEqual(json.body.problems, []);
  assert.deepEqual(json.body.warnings, ["review-owner A.1 'quality-guardian'"]);
  const text = p.run('plan-check', [p.planFile]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /review-owner A\.1 'quality-guardian'/);
});

test('the owner match is case-insensitive', (t) => {
  const p = project(t, plan(['- [ ] A.1 Verify — owner: Quality-Guardian; tier: frontier']));
  const json = JSON_OF(p);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(json.body.warnings, ["review-owner A.1 'quality-guardian'"]);
});

test('negative controls: standard tier, no tier, and a reviewer at frontier give no warning', (t) => {
  for (const line of [
    '- [ ] A.1 Verify — owner: quality-guardian; tier: standard',
    '- [ ] A.1 Verify — owner: quality-guardian; files: a.js',
    '- [ ] A.1 Review — owner: reviewer; tier: frontier',
    '- [ ] A.1 Build — owner: core-implementer; tier: frontier',
  ]) {
    const p = project(t, plan([line]));
    const json = JSON_OF(p);
    assert.equal(json.status, 0, `${line}: ${json.stderr}`);
    assert.equal(json.body.ok, true, line);
    assert.deepEqual(json.body.warnings, [], line);
  }
});

test('a task-attempt claim with the declared owner quality-guardian still succeeds', (t) => {
  const p = project(t, plan(['- [ ] A.1 Verify — owner: quality-guardian; tier: frontier; files: a.js']));
  const started = p.run('task-attempt', ['--action', 'start', '--slug', SLUG, '--by', 'lead', '--json']);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const claim = p.run('task-attempt', ['--action', 'claim', '--slug', SLUG, '--task', 'A.1', '--owner', 'quality-guardian', '--mode', 'subagent', '--epoch', '1', '--json']);
  assert.equal(claim.status, 0, claim.stderr || claim.stdout);
  assert.equal(JSON.parse(claim.stdout).disposition, 'claimed');
});

test('a decorated owner "quality-guardian (Opus)" at tier frontier warns; a decorated reviewer does not', (t) => {
  const warned = JSON_OF(project(t, plan(['- [ ] A.1 Verify — owner: quality-guardian (Opus); tier: frontier; files: a.js'])));
  assert.equal(warned.status, 0, warned.stderr);
  assert.deepEqual(warned.body.warnings, ["review-owner A.1 'quality-guardian'"]);
  const spaced = JSON_OF(project(t, plan(['- [ ] A.1 Verify — owner: Quality-Guardian  (opus 4);  tier: frontier'])));
  assert.deepEqual(spaced.body.warnings, ["review-owner A.1 'quality-guardian'"]);
  const reviewer = JSON_OF(project(t, plan(['- [ ] A.1 Review — owner: reviewer (Opus); tier: frontier'])));
  assert.equal(reviewer.status, 0, reviewer.stderr);
  assert.deepEqual(reviewer.body.warnings, []);
});

test('a claim compares the owner without its trailing parenthetical and case-insensitively, as plan-check does; a different owner is still refused', (t) => {
  const p = project(t, plan(['- [ ] A.1 Verify — owner: quality-guardian (Opus); tier: frontier; files: a.js']));
  const started = p.run('task-attempt', ['--action', 'start', '--slug', SLUG, '--by', 'lead', '--json']);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const claimArgs = (owner: any) => ['--action', 'claim', '--slug', SLUG, '--task', 'A.1', '--owner', owner, '--mode', 'subagent', '--epoch', '1', '--json'];
  const other = p.run('task-attempt', claimArgs('reviewer'));
  assert.notEqual(other.status, 0, other.stdout);
  assert.match(other.stdout + other.stderr, /owner-mismatch/);
  // The case rule is plan-check's own (the review-owner match is case-insensitive).
  const claimed = p.run('task-attempt', claimArgs('Quality-Guardian'));
  assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
  const body = JSON.parse(claimed.stdout);
  assert.equal(body.disposition, 'claimed');
  assert.equal(Object.hasOwn(body, 'ownerOverride'), false, 'no override was needed');
});

test('a plan with a problem and a review-owner task reports both, in text and in JSON', (t) => {
  const p = project(t, plan([
    '- [ ] A.1 Verify — owner: quality-guardian (Opus); tier: frontier; files: a.js',
    '- [ ] A.2 Build; depends-on: B.9',
  ]));
  const json = JSON_OF(p);
  assert.equal(json.status, 1, json.stderr);
  assert.equal(json.body.ok, false);
  assert.deepEqual(json.body.problems.map((x: any) => x.kind), ['unknown-dependency']);
  assert.deepEqual(json.body.warnings, ["review-owner A.1 'quality-guardian'"]);
  const text = p.run('plan-check', [path.relative(p.dir, p.planFile)]); // relative: the text line is capped at 200 chars
  assert.equal(text.status, 1);
  assert.match(text.stdout, /unknown-dependency A\.2,B\.9.*; warnings: review-owner A\.1 'quality-guardian'/);
});
