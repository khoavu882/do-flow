'use strict';

// `classify --view brief|full` (feature 137, IC-001, IC-005, IC-003): the default answer stays today's object, the
// brief view is a projection of it, and JSON printed off a terminal is compact. Runs the verb through the
// dispatcher in a scratch HOME, as the other classify tests do.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { TaskClassifier } = require('../../src/runtime/task-classifier.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const FEATURE = ['--task-class', 'feature', '--calling-skill', 'do-design'];

function runner(t: any) {
  const scratch = createScratch('doflow-classify-view-');
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  t.after(() => scratch.remove());
  return (args: string[]) => spawnSync(bashPath(), [RUN, 'classify', ...args], {
    cwd: project, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8',
  });
}

/** Every leaf of `brief` (outside the envelope) exists with an equal value at the same path in `full`. */
function assertSubset(brief: any, full: any, at = '$') {
  if (brief === null || typeof brief !== 'object') return assert.deepEqual(brief, full, at);
  if (Array.isArray(brief)) {
    assert.ok(Array.isArray(full) && full.length === brief.length, `${at}: array length`);
    return brief.forEach((element, i) => assertSubset(element, full[i], `${at}[${i}]`));
  }
  for (const key of Object.keys(brief)) {
    if (at === '$' && (key === 'view' || key === 'next')) continue;
    assert.ok(full && key in full, `${at}.${key} is in the full answer`);
    assertSubset(brief[key], full[key], `${at}.${key}`);
  }
}

test('the default answer is the classifier decision field for field, with no view key', (t) => {
  const run = runner(t);
  const result = run([...FEATURE, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const expected = { ...new TaskClassifier({ repoRoot: REPO_ROOT }).classify({ taskClass: 'feature', callingSkill: 'do-design' }), secondOpinion: null };
  // decidedAt is the call's own timestamp.
  const sameButTime = (value: any) => ({ ...value, decidedAt: null });
  assert.deepEqual(sameButTime(JSON.parse(result.stdout)), sameButTime(JSON.parse(JSON.stringify(expected))));
  assert.deepEqual(sameButTime(JSON.parse(run([...FEATURE, '--view', 'full', '--json']).stdout)), sameButTime(JSON.parse(result.stdout)),
    '--view full is the default');
});

test('JSON off a terminal is one compact line that parses to the same value as the indented form', (t) => {
  const result = runner(t)([...FEATURE, '--json']);
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  const { serializeJson } = require('../../src/runtime/verb-view.ts');
  const value = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(serializeJson(value, { isTTY: true })), value);
});

test('brief: view first, a projection of the full answer, the dropped fields gone, one full-view next line', (t) => {
  const run = runner(t);
  const full = JSON.parse(run([...FEATURE, '--json']).stdout);
  const result = run([...FEATURE, '--view', 'brief', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const brief = JSON.parse(result.stdout);
  assert.equal(Object.keys(brief)[0], 'view');
  assert.equal(brief.view, 'brief');
  assertSubset(brief, full);
  assert.deepEqual(brief.next, ['Full view: doflow-run classify --task-class feature --calling-skill do-design --view full --json']);
  for (const dropped of ['proposedBy', 'rationale', 'signals', 'context', 'decidedAt']) assert.equal(dropped in brief, false, dropped);
  for (const dropped of ['version', 'name', 'description', 'gateIds', 'stageSkills', 'terminalStage', 'readinessTemplates']) {
    assert.equal(dropped in brief.workflow, false, dropped);
  }
  for (const stage of brief.workflow.stages) {
    for (const dropped of ['index', 'purpose', 'kindDescription', 'gatesAfter']) assert.equal(dropped in stage, false, dropped);
  }
  for (const kept of ['outcome', 'taskClass', 'message', 'fit', 'secondOpinion']) assert.ok(kept in brief, kept);
  assert.deepEqual(Object.keys(brief.fit).sort(), ['hostingClasses', 'reason', 'state'].filter((k) => k in full.fit).sort());
  assert.ok(Array.isArray(brief.workflow.stageIds) && brief.workflow.stages.every((s: any) => 'id' in s && 'skill' in s));
  assert.ok(result.stdout.length < run([...FEATURE, '--json']).stdout.length / 2, 'brief is under half the full size');
});

test('brief of a rejected class carries no workflow, keeps the valid set, and keeps the exit code', (t) => {
  const run = runner(t);
  const args = ['--task-class', 'nope', '--calling-skill', 'do-design', '--json'];
  const full = run(args);
  const brief = run([...args, '--view', 'brief']);
  assert.equal(full.status, 1);
  assert.equal(brief.status, 1);
  const body = JSON.parse(brief.stdout);
  assert.equal(body.outcome, 'REJECTED');
  assert.equal('workflow' in body, false);
  assert.ok(Array.isArray(body.validClasses) && body.validClasses.length > 0);
  assertSubset(body, JSON.parse(full.stdout));
  assert.match(body.next[0], /--task-class nope .*--view full --json$/);
});

test('a missing class keeps exit 2 under brief and carries no task-class flag in the next line', (t) => {
  const result = runner(t)(['--calling-skill', 'do-design', '--view', 'brief', '--json']);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stdout);
  assert.equal(body.reason, 'missing-class');
  assert.deepEqual(body.next, ['Full view: doflow-run classify --calling-skill do-design --view full --json']);
});

test('a view other than brief or full is a usage error, exit 2, in the caller mode', (t) => {
  const run = runner(t);
  const json = run([...FEATURE, '--view', 'compact', '--json']);
  assert.equal(json.status, 2);
  assert.match(JSON.parse(json.stdout).summary, /^--view must be brief or full \(got 'compact'\)$/);
  const text = run([...FEATURE, '--view', 'Brief']);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /doflow classify: --view must be brief or full \(got 'Brief'\)/);
});

test('text output is the same under either view', (t) => {
  const run = runner(t);
  const plain = run(FEATURE);
  assert.equal(plain.status, 0);
  assert.equal(run([...FEATURE, '--view', 'brief']).stdout, plain.stdout);
  assert.equal(run([...FEATURE, '--view', 'full']).stdout, plain.stdout);
});
