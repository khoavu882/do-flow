'use strict';

// `lifecycle --action overview` views (feature 137, IC-006, IC-007): the brief view drops the feature lists and
// every item field but the choosing ones, the full view stays today's object, both name the paged follow-up list
// call, the item caps do not move, and `--view` is refused on the other lifecycle actions.
// Runs the verb through the dispatcher in a scratch HOME, as the other verb-view tests do.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { makeRepo } = require('../helper/lifecycle-git-fixtures.ts');
const { addFollowups } = require('../../src/runtime/lifecycle/followup.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const TOTAL = 60;

const scratch = createScratch('doflow-overview-view-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

let fixture: any = null;
/** One repository holding 60 open follow-ups (more than either item cap), built once for the file. */
function seeded() {
  if (fixture) return fixture;
  const repo = makeRepo(scratch, 'overview-view');
  const dir = fs.realpathSync(repo.dir);
  const items = Array.from({ length: TOTAL }, (_, i) => ({ statement: `Fixture follow-up ${String(i).padStart(2, '0')}` }));
  assert.equal(addFollowups({ root: dir, cwd: dir, items, defaults: { source: 'manual', batch: true } }).ok, true);
  fixture = { dir };
  return fixture;
}

function run(args: string[]) {
  const r = spawnSync(bashPath(), [RUN, 'lifecycle', ...args], { cwd: seeded().dir, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8' });
  let json: any = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const overview = (...args: string[]) => run(['--action', 'overview', ...args, '--json']);

test('the brief overview drops the feature lists and reduces items to id, statement and source', () => {
  const r = overview('--view', 'brief');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.view, 'brief');
  assert.equal(Object.keys(r.json)[0], 'view');
  assert.equal('features' in r.json, false);
  assert.equal('featuresShown' in r.json, false);
  assert.deepEqual([r.json.followups.open, r.json.followups.shown], [TOTAL, 15]);
  assert.equal(r.json.followups.items.length, 15);
  for (const item of r.json.followups.items) assert.deepEqual(Object.keys(item), ['id', 'statement', 'source']);
  for (const key of ['ok', 'mode', 'releaseMode', 'integrationRef', 'gitError', 'intents', 'goals', 'conflicts', 'unreadable', 'unreadableReasons', 'failures']) {
    assert.equal(key in r.json, true, `${key} is kept`);
  }
  assert.equal(r.json.mode, 'discovery');
});

test('the full overview, by default and by --view full, is today\'s object', () => {
  const byDefault = overview();
  const explicit = overview('--view', 'full');
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.deepEqual(explicit.json, byDefault.json);
  assert.equal('view' in byDefault.json, false);
  assert.equal('features' in byDefault.json, true);
  assert.equal('featuresShown' in byDefault.json, true);
  assert.deepEqual(Object.keys(byDefault.json.followups.items[0]), ['id', 'statement', 'source', 'state', 'promoted', 'intent', 'added']);
});

test('both views name the paged list call; only brief adds the full-view line', () => {
  const brief = overview('--view', 'brief').json;
  const full = overview('--view', 'full').json;
  const page = `Page through all ${TOTAL} open follow-ups: doflow-run followup --action list`;
  assert.equal(brief.next.includes(page), true);
  assert.equal(full.next.includes(page), true);
  assert.equal(brief.next.includes('Full view: doflow-run lifecycle --action overview --view full'), true);
  assert.equal(full.next.some((l: string) => l.startsWith('Full view')), false);
  assert.deepEqual(brief.next.filter((l: string) => !l.startsWith('Full view')), full.next);
});

test('maintain keeps pending, caps at 50 in both views, and the full-view line carries --maintain and --since', () => {
  const since = '2026-10-05T09:00:00Z';
  const brief = overview('--maintain', '--since', since, '--view', 'brief').json;
  const full = overview('--maintain', '--since', since, '--view', 'full').json;
  assert.equal(brief.mode, 'maintain');
  assert.equal(brief.followups.shown, 50);
  assert.equal(full.followups.shown, 50);
  assert.equal(brief.followups.items.length, 50);
  assert.equal(brief.pending, TOTAL);
  for (const item of brief.followups.items) assert.deepEqual(Object.keys(item), ['id', 'statement', 'source', 'pending']);
  assert.equal(brief.next.includes(`Full view: doflow-run lifecycle --action overview --maintain --since ${since} --view full`), true);
  assert.equal(brief.next.includes(`Page through all ${TOTAL} open follow-ups: doflow-run followup --action list`), true);
  assert.equal('features' in brief, false);
});

test('the brief answer is smaller than the full one, and compact off a terminal', () => {
  const brief = run(['--action', 'overview', '--view', 'brief', '--json']);
  const full = run(['--action', 'overview', '--view', 'full', '--json']);
  assert.equal(brief.stdout.trim().split('\n').length, 1);
  assert.ok(brief.stdout.length < full.stdout.length);
});

test('--view is refused on the other lifecycle actions and a bad value is a usage error', () => {
  for (const action of ['init', 'release', 'status', 'merged']) {
    const r = run(['--action', action, '--view', 'brief', '--json']);
    assert.equal(r.status, 2, `${action}: ${r.stdout}`);
    assert.match(JSON.stringify(r.json) + r.stderr, /--view applies to --action overview only/);
  }
  const bad = overview('--view', 'wide');
  assert.equal(bad.status, 2);
  assert.match(JSON.stringify(bad.json) + bad.stderr, /--view must be brief or full \(got 'wide'\)/);
});
