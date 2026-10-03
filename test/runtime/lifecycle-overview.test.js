'use strict';

// The overview's `--maintain` view (IC-007): at most 50 items, pending first. Services run in process on
// a scratch repository under a scratch HOME and XDG_CONFIG_HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo } = require('../helper/lifecycle-git-fixtures');
const { buildOverview } = require('../../src/runtime/lifecycle/overview');
const { addFollowups, settleFollowups } = require('../../src/runtime/lifecycle/followup');

const scratch = createScratch('doflow-overview-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

const BASE = Date.parse('2026-10-05T09:00:00.000Z');
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
