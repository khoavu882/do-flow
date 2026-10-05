'use strict';

// The overview's `--maintain` view (IC-007): at most 50 items, pending first. Services run in process on
// a scratch repository under a scratch HOME and XDG_CONFIG_HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo, historyBuilder, failingGit } = require('../helper/lifecycle-git-fixtures');
const store = require('../../src/runtime/lifecycle/event-store');
const { buildOverview, FEATURES_SHOWN } = require('../../src/runtime/lifecycle/overview');
const { addFollowups, settleFollowups } = require('../../src/runtime/lifecycle/followup');

const scratch = createScratch('doflow-overview-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

const BASE = Date.parse('2026-10-05T09:00:00.000Z');
// A fixed clock after every generated date: the fold leaves out events dated over 24 hours ahead of it (DEC-045).
const CLOCK = new Date('2027-01-01T00:00:00.000Z');
const at = (seconds) => new Date(BASE + seconds * 1000);

test('maintain: more than 50 open items still finish, because pending items come first', () => {
  const repo = makeRepo(scratch, 'overview-maintain');
  repo.dir = fs.realpathSync(repo.dir);
  const root = repo.dir;
  for (let i = 0; i < 55; i += 1) {
    addFollowups({ root, cwd: root, items: [{ statement: `item ${i}` }], defaults: { stage: 'review', slug: '050-demo' }, now: at(i) });
  }
  const since = at(100).toISOString();
  const settleShown = (view, seconds) => settleFollowups({
    root, ids: view.followups.items.map((i) => i.id), as: 'kept', reason: 'stays', channel: 'question', now: at(seconds),
  });

  const first = buildOverview({ root, maintain: true, since, now: at(101) });
  assert.deepEqual([first.pending, first.followups.open, first.followups.shown], [55, 55, 50]);
  assert.equal(settleShown(first, 102).ok, true);

  const second = buildOverview({ root, maintain: true, since, now: at(103) });
  assert.equal(second.pending, 5);
  assert.equal(second.followups.shown, 50);
  assert.deepEqual(second.followups.items.slice(0, 5).map((i) => i.pending), [true, true, true, true, true], 'the five pending items lead');
  assert.deepEqual(second.followups.items.slice(5).map((i) => i.pending), Array(45).fill(false));
  assert.ok(second.next.some((line) => /followup --action settle --ids FU-\w+ --as kept/.test(line)), 'there is a settle line to follow');
  assert.equal(settleFollowups({
    root, ids: second.followups.items.slice(0, 5).map((i) => i.id), as: 'kept', reason: 'stays', channel: 'question', now: at(104),
  }).ok, true);

  const third = buildOverview({ root, maintain: true, since, now: at(105) });
  assert.equal(third.pending, 0);
  assert.equal(third.next.some((line) => /--as kept/.test(line)), false, 'nothing pending, no settle line');
});

test('discovery order is unchanged: the oldest first, whatever was settled', () => {
  const repo = makeRepo(scratch, 'overview-discovery');
  repo.dir = fs.realpathSync(repo.dir);
  const root = repo.dir;
  for (let i = 0; i < 3; i += 1) {
    addFollowups({ root, cwd: root, items: [{ statement: `item ${i}` }], defaults: { stage: 'review', slug: '050-demo' }, now: at(i) });
  }
  const view = buildOverview({ root, now: at(10) });
  assert.deepEqual(view.followups.items.map((i) => i.statement), ['item 0', 'item 1', 'item 2']);
  settleFollowups({ root, ids: [view.followups.items[0].id], as: 'kept', reason: 'stays', channel: 'question', now: at(11) });
  assert.deepEqual(buildOverview({ root, now: at(12) }).followups.items.map((i) => i.statement), ['item 0', 'item 1', 'item 2']);
});

// ── the bounded feature buckets ────────────────────────────────────────────────────────────────

/** `merged` features merged into develop and `open` ones not merged, all tracked first; `tagged` adds a v* tag at the root. */
function trackedRepo(name, { merged, open = 0, tagged = false }) {
  const h = historyBuilder();
  h.commit('develop', 'init');
  if (tagged) h.tag('v0.1.0', 'develop');
  const slugs = Array.from({ length: merged + open }, (_, i) => `${String(400 + i)}-shown`);
  const at = h.iso();
  h.wait(60);
  slugs.forEach((slug, i) => {
    h.branch(`feat/${slug}`, 'develop').commit(`feat/${slug}`, `work on ${slug}`);
    if (i < merged) h.merge('develop', `feat/${slug}`);
  });
  const repo = h.write(scratch, name);
  for (const slug of slugs) assert.ok(store.appendEvents(repo.dir, [{ type: 'feature.tracked', by: 'agent', data: { slug } }], { now: new Date(at) }).ok);
  return { root: fs.realpathSync(repo.dir), slugs };
}

test('the finished and awaiting-release buckets are shown bounded, with the true count; features keeps every slug', () => {
  assert.equal(FEATURES_SHOWN, 10);
  const untagged = trackedRepo('shown-finished', { merged: 13, open: 2 });
  const view = buildOverview({ root: untagged.root, now: CLOCK });
  assert.deepEqual(view.features.finished, untagged.slugs.slice(0, 13), 'the documented field still lists every finished slug');
  assert.deepEqual(view.featuresShown.finished, { count: 13, shown: untagged.slugs.slice(3, 13), more: 3 }, 'the ten most recently tracked');
  assert.deepEqual(view.featuresShown.awaitingRelease, { count: 0, shown: [], more: 0 });
  assert.deepEqual(view.features.inProgress, untagged.slugs.slice(13));

  const tagged = trackedRepo('shown-awaiting', { merged: 4, tagged: true });
  const awaiting = buildOverview({ root: tagged.root, now: CLOCK });
  assert.deepEqual(awaiting.featuresShown.awaitingRelease, { count: 4, shown: tagged.slugs, more: 0 }, 'under the cap everything is shown');
  assert.deepEqual(awaiting.featuresShown.finished, { count: 0, shown: [], more: 0 });
});

test('the text overview prints at most ten slugs per bounded bucket and says how many more there are', () => {
  const { root, slugs } = trackedRepo('shown-text', { merged: 12, open: 11 });
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'doflow.js'), 'lifecycle', '--action', 'overview'], { cwd: root, env: scratch.env(), encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const line = (label) => out.stdout.split('\n').find((l) => l.startsWith(`${label}: `));
  assert.equal(line('finished'), `finished: ${slugs.slice(2, 12).join(', ')} (+2 more; --json lists them all, lifecycle --action status --slug <slug> shows one)`);
  assert.equal(line('in progress'), `in progress: ${slugs.slice(12).join(', ')}`, 'the in-progress bucket is not bounded');
});

test('a git failure while deriving statuses refuses the overview with git-state-failed (exit 1), and never throws', () => {
  const { root } = trackedRepo('overview-git-fails', { merged: 2 });
  const git = failingGit(scratch);
  const cli = (extra) => spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'doflow.js'), 'lifecycle', '--action', 'overview', '--json'], { cwd: root, env: { ...scratch.env(), ...extra }, encoding: 'utf8' });
  const out = cli(git.env('any'));
  assert.equal(out.status, 1, out.stderr);
  const refused = JSON.parse(out.stdout);
  assert.deepEqual([refused.ok, refused.action, refused.finding], [false, 'overview', 'no-integration-ref']);
  assert.match(refused.message, /git-state-failed.*rev-list/);
  assert.doesNotMatch(out.stderr, /Error|at /, 'no stack trace');
  assert.equal(cli({}).status, 0, 'with a working git the same overview answers');
});
