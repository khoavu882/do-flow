'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../helper/scratch-env');
const { FIXTURES, TRACKED_AT } = require('../helper/lifecycle-git-fixtures');
const followup = require('../../src/runtime/lifecycle/followup');
const store = require('../../src/runtime/lifecycle/event-store');

const scratch = createScratch('doflow-followup-');
test.after(() => scratch.remove());

const { addFollowups, listFollowups, takeFollowups, settleFollowups, FollowupUsageError } = followup;
let counter = 0;
function plainRoot() {
  counter += 1;
  const dir = path.join(scratch.dir, `root-${counter}`);
  fs.mkdirSync(dir);
  return dir;
}
const eventCount = (root) => {
  try { return fs.readdirSync(path.join(root, store.EVENTS_REL)).filter((n) => n.endsWith('.json')).length; } catch { return 0; }
};
const track = (root, slug, now = new Date()) => store.appendEvents(root, [{ type: 'feature.tracked', by: 'agent', data: { slug } }], { now });
const add = (root, statement, defaults = { stage: 'review', slug: '050-demo' }, extra = {}) => addFollowups({ root, cwd: root, items: [{ statement }], defaults, ...extra });
const usage = (fn, pattern) => assert.throws(fn, (error) => error instanceof FollowupUsageError && pattern.test(error.message));

// ── add ────────────────────────────────────────────────────────────────────────────────────────

test('add: a stage source from --slug writes one followup.added event and names it', () => {
  const root = plainRoot();
  const out = add(root, 'Validator does not report a stale DEC cited inside a table cell');
  assert.equal(out.ok, true);
  assert.equal(out.action, 'add');
  assert.equal(out.created.length, 1);
  const [created] = out.created;
  assert.match(created.id, /^FU-[0-9a-hjkmnp-tv-z]{6}$/);
  assert.deepEqual(created.source, { kind: 'stage', feature: '050-demo', stage: 'review' });
  assert.equal(created.state, 'open');
  assert.deepEqual(out.next, []);
  const event = JSON.parse(fs.readFileSync(path.join(root, out.events[0]), 'utf8'));
  assert.equal(event.type, 'followup.added');
  assert.equal(event.by, 'agent');
  assert.deepEqual(event.data, { id: created.id, statement: created.statement, source: created.source });
});

test('add: --channel question or gate or prompt is the user, an unknown channel is a usage error', () => {
  const root = plainRoot();
  const out = add(root, 'asked by the user', undefined, { channel: 'question' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, out.events[0]), 'utf8')).by, 'user');
  usage(() => add(root, 'x', undefined, { channel: 'shout' }), /unknown --channel/);
  assert.equal(eventCount(root), 1);
});

test('add: the statement is masked before it is checked and written', () => {
  const root = plainRoot();
  const out = add(root, 'Rotate token=ab12cd34 and mail jane@example.com');
  assert.equal(out.created[0].statement, 'Rotate token=<masked> and mail <email>');
  const long = `${'x'.repeat(279)} token=ab12cd34`;
  usage(() => add(root, long), /statement is \d+ characters; the limit is 280/);
});

test('add: an empty, multi-line or over-long statement is refused with exit-2 usage and writes nothing', () => {
  const root = plainRoot();
  usage(() => add(root, '   '), /statement is empty/);
  usage(() => add(root, 'two\nlines'), /must be one line/);
  usage(() => add(root, 'y'.repeat(281)), /limit is 280/);
  assert.equal(add(root, 'z'.repeat(280)).ok, true);
  assert.equal(eventCount(root), 1);
});

test('add: --stage accepts the register stages plus release and maintain, and nothing else', () => {
  const root = plainRoot();
  for (const stage of ['discovery', 'design', 'planning', 'implementation', 'verification', 'review', 'release', 'maintain']) {
    assert.equal(add(root, `from ${stage}`, { stage, slug: '050-demo' }).ok, true, stage);
  }
  usage(() => add(root, 'x', { stage: 'deploy', slug: '050-demo' }), /stage must be one of/);
  usage(() => add(root, 'x', { slug: '050-demo' }), /stage must be one of/);
  usage(() => add(root, 'x', { stage: 'review', slug: '../escape' }), /not a valid feature slug/);
});

test('add: a run source needs --task-class and --task-id; release and manual need neither a stage nor a feature', () => {
  const root = plainRoot();
  const run = add(root, 'left by a bug run', { stage: 'review', source: 'run', taskClass: 'bug', taskId: 'fix-cart-total' });
  assert.deepEqual(run.created[0].source, { kind: 'run', taskClass: 'bug', taskId: 'fix-cart-total', stage: 'review' });
  usage(() => add(root, 'x', { stage: 'review', source: 'run', taskClass: 'bug' }), /--task-id/);
  usage(() => add(root, 'x', { stage: 'review', source: 'run' }), /--task-class/);
  assert.deepEqual(add(root, 'found at release', { source: 'release', release: 'v2.3.0' }).created[0].source, { kind: 'release', release: 'v2.3.0' });
  assert.deepEqual(add(root, 'found at release', { source: 'release' }).created[0].source, { kind: 'release' });
  assert.deepEqual(add(root, 'known item', { source: 'manual' }).created[0].source, { kind: 'manual' });
  usage(() => add(root, 'x', { source: 'telepathy' }), /source must be one of/);
});

test('add: with no feature resolvable and no --source it asks for one', () => {
  const root = plainRoot();
  usage(() => addFollowups({ root, cwd: root, items: [{ statement: 'x' }], defaults: { stage: 'review' } }), /no feature resolved/);
});

test('add: the feature is resolved from the branch when --slug is absent', () => {
  const repo = FIXTURES.noTag(scratch).repo;
  repo.checkout('-b', 'feat/051-from-branch');
  fs.mkdirSync(path.join(repo.dir, 'agent-docs/doflow/051-from-branch/intention'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, 'agent-docs/doflow/051-from-branch/intention/requirement.md'), '# r\n');
  const out = addFollowups({ root: repo.dir, cwd: repo.dir, items: [{ statement: 'from the branch' }], defaults: { stage: 'design' } });
  assert.deepEqual(out.created[0].source, { kind: 'stage', feature: '051-from-branch', stage: 'design' });
});

test('add: a batch writes one event per item; an item stage overrides the default; an item source object is honoured', () => {
  const root = plainRoot();
  const out = addFollowups({
    root, cwd: root, defaults: { stage: 'review', slug: '050-demo', batch: true },
    items: [
      { statement: 'one' },
      { statement: 'two', stage: 'design' },
      { statement: 'three', source: { kind: 'run', taskClass: 'bug', taskId: 'x', stage: 'review' } },
      { statement: 'four', source: 'manual' },
    ],
  });
  assert.equal(out.created.length, 4);
  assert.equal(new Set(out.created.map((c) => c.id)).size, 4);
  assert.deepEqual(out.created.map((c) => c.source.kind), ['stage', 'stage', 'run', 'manual']);
  assert.equal(out.created[1].source.stage, 'design');
  assert.equal(out.events.length, 4);
  assert.equal(eventCount(root), 4);
});

test('add: a batch with any invalid item writes nothing and names every invalid item', () => {
  const root = plainRoot();
  assert.throws(() => addFollowups({
    root, cwd: root, defaults: { stage: 'review', slug: '050-demo', batch: true },
    items: [{ statement: 'fine' }, { statement: '' }, { statement: 'ok', stage: 'nope' }, 'not an object', { statement: 'two\nlines' }],
  }), (error) => error instanceof FollowupUsageError
    && /item 2: statement is empty/.test(error.message) && /item 3: stage must be one of/.test(error.message)
    && /item 4 must be an object/.test(error.message) && /item 5: statement must be one line/.test(error.message)
    && !/item 1/.test(error.message));
  assert.equal(eventCount(root), 0);
  assert.equal(fs.existsSync(path.join(root, 'agent-docs')), false, 'a refused batch creates no folder');
});

test('add: readBatchFile reads a JSON array and refuses anything else', () => {
  const root = plainRoot();
  const file = path.join(root, 'batch.json');
  fs.writeFileSync(file, JSON.stringify([{ statement: 'a' }]));
  assert.deepEqual(followup.readBatchFile(file), [{ statement: 'a' }]);
  fs.writeFileSync(file, '{"statement":"a"}');
  usage(() => followup.readBatchFile(file), /non-empty JSON array/);
  fs.writeFileSync(file, '[]');
  usage(() => followup.readBatchFile(file), /non-empty JSON array/);
  fs.writeFileSync(file, 'nope');
  usage(() => followup.readBatchFile(file), /cannot read --batch/);
  usage(() => followup.readBatchFile(path.join(root, 'missing.json')), /cannot read --batch/);
});

// ── list ───────────────────────────────────────────────────────────────────────────────────────

test('list: defaults to open; reads of an empty store give an empty list and create nothing', () => {
  const root = plainRoot();
  const empty = listFollowups({ root });
  assert.deepEqual([empty.ok, empty.state, empty.count, empty.items], [true, 'open', 0, []]);
  assert.equal(fs.existsSync(path.join(root, 'agent-docs')), false);
  const a = add(root, 'first').created[0].id;
  const b = add(root, 'second').created[0].id;
  settleFollowups({ root, ids: b, as: 'dismissed', reason: 'noise' });
  assert.deepEqual(listFollowups({ root }).items.map((i) => i.id), [a]);
  assert.deepEqual(listFollowups({ root, state: 'dismissed' }).items.map((i) => i.id), [b]);
  assert.deepEqual(listFollowups({ root, state: 'all' }).items.map((i) => i.id), [a, b]);
  assert.deepEqual(listFollowups({ root, state: 'done' }).items, []);
  usage(() => listFollowups({ root, state: 'bogus' }), /--state must be one of/);
});

test('list: an item carries the folded fields and its history', () => {
  const root = plainRoot();
  const id = add(root, 'first').created[0].id;
  const [item] = listFollowups({ root }).items;
  assert.equal(item.id, id);
  assert.deepEqual(Object.keys(item).sort(), ['added', 'body', 'excerpt', 'fix', 'history', 'id', 'intent', 'source', 'state', 'statement', 'takenBy'].sort());
  assert.match(item.added, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(item.history.length, 1);
});

test('list: a taken item shows done while its feature derives finished, taken otherwise', () => {
  const merged = FIXTURES.mergeCommit(scratch);
  const id = add(merged.repo.dir, 'to be done', { stage: 'review', slug: merged.slug }, { now: new Date(TRACKED_AT) }).created[0].id;
  track(merged.repo.dir, merged.slug, new Date(TRACKED_AT));
  // The stamp is one millisecond past the newest event, so the tracking time stays at the fixture's tracking instant.
  assert.equal(takeFollowups({ root: merged.repo.dir, ids: id, slug: merged.slug, now: new Date(TRACKED_AT) }).ok, true);
  const shown = listFollowups({ root: merged.repo.dir, state: 'done' });
  assert.deepEqual(shown.items.map((i) => [i.id, i.state, i.derived]), [[id, 'done', true]]);
  assert.deepEqual(listFollowups({ root: merged.repo.dir, state: 'taken' }).items, []);

  const squashed = FIXTURES.squash(scratch);
  const id2 = add(squashed.repo.dir, 'not merged by evidence', { stage: 'review', slug: squashed.slug }, { now: new Date(TRACKED_AT) }).created[0].id;
  track(squashed.repo.dir, squashed.slug, new Date(TRACKED_AT));
  takeFollowups({ root: squashed.repo.dir, ids: id2, slug: squashed.slug, now: new Date(TRACKED_AT) });
  assert.deepEqual(listFollowups({ root: squashed.repo.dir, state: 'taken' }).items.map((i) => i.id), [id2]);

  const noGit = plainRoot();
  const id3 = add(noGit, 'no git here').created[0].id;
  track(noGit, '050-demo');
  takeFollowups({ root: noGit, ids: id3, slug: '050-demo' });
  assert.equal(listFollowups({ root: noGit, state: 'taken' }).items.length, 1, 'unknown status leaves the item taken');
});

// ── take ───────────────────────────────────────────────────────────────────────────────────────

test('take: needs a tracked feature, open items and known ids; refusals write nothing', () => {
  const root = plainRoot();
  const a = add(root, 'a').created[0].id;
  const b = add(root, 'b').created[0].id;
  const before = eventCount(root);
  const untracked = takeFollowups({ root, ids: a, slug: '050-demo' });
  assert.deepEqual([untracked.ok, untracked.action, untracked.finding], [false, 'take', 'untracked-feature']);
  assert.match(untracked.message, /Nothing was written/);
  track(root, '050-demo');
  assert.equal(takeFollowups({ root, ids: 'FU-zzzzzz', slug: '050-demo' }).finding, 'unknown-id');
  const ok = takeFollowups({ root, ids: [a, b].join(','), slug: '050-demo' });
  assert.deepEqual([ok.ok, ok.ids, ok.feature], [true, [a, b], '050-demo']);
  assert.equal(ok.events.length, 1, 'one followup.taken event for all ids');
  assert.equal(eventCount(root), before + 2, 'tracked event plus one taken event');
  const again = takeFollowups({ root, ids: a, slug: '050-demo' });
  assert.equal(again.finding, 'illegal-transition');
  assert.match(again.message, new RegExp(`${a} is taken`));
  assert.deepEqual(listFollowups({ root, state: 'taken' }).items.map((i) => i.takenBy), ['050-demo', '050-demo']);
});

test('take: one illegal id refuses the whole call', () => {
  const root = plainRoot();
  const a = add(root, 'a').created[0].id;
  const b = add(root, 'b').created[0].id;
  track(root, '050-demo');
  settleFollowups({ root, ids: b, as: 'dismissed', reason: 'noise' });
  const refused = takeFollowups({ root, ids: [a, b], slug: '050-demo' });
  assert.equal(refused.finding, 'illegal-transition');
  assert.deepEqual(listFollowups({ root }).items.map((i) => i.id), [a], 'a was not taken');
});

test('take: usage errors for a missing slug, no ids or a malformed id', () => {
  const root = plainRoot();
  usage(() => takeFollowups({ root, ids: 'FU-aaaaaa' }), /--slug is required/);
  usage(() => takeFollowups({ root, slug: '050-demo' }), /--ids is required/);
  usage(() => takeFollowups({ root, ids: 'FU-aaaaaa,nope', slug: '050-demo' }), /nope, which is not a follow-up id/);
  usage(() => takeFollowups({ root, ids: 'FU-aaaaaa', slug: 'a/b' }), /not a valid feature slug/);
});

// ── settle ─────────────────────────────────────────────────────────────────────────────────────

test('settle: each --as value and its required field (IC-003)', () => {
  const root = plainRoot();
  const [k, d, f, o] = ['k', 'd', 'f', 'o'].map((s) => add(root, s).created[0].id);
  assert.equal(settleFollowups({ root, ids: k, as: 'kept', reason: 'still wanted' }).ok, true);
  assert.equal(settleFollowups({ root, ids: d, as: 'dismissed', reason: 'duplicate' }).ok, true);
  assert.equal(settleFollowups({ root, ids: f, as: 'fix', reason: 'bug run fix-x' }).ok, true);
  assert.equal(settleFollowups({ root, ids: o, as: 'done', evidence: 'commit abc1234' }).ok, true);
  const by = Object.fromEntries(listFollowups({ root, state: 'all' }).items.map((i) => [i.id, i]));
  assert.equal(by[k].state, 'open');
  assert.equal(by[d].state, 'dismissed');
  assert.equal(by[f].state, 'open');
  assert.equal(by[f].fix, 'bug run fix-x');
  assert.equal(by[o].state, 'done');
  usage(() => settleFollowups({ root, ids: k, as: 'kept' }), /--reason is required for --as kept/);
  usage(() => settleFollowups({ root, ids: k, as: 'dismissed' }), /--reason is required/);
  usage(() => settleFollowups({ root, ids: k, as: 'fix' }), /--reason is required/);
  usage(() => settleFollowups({ root, ids: k, as: 'done', reason: 'x' }), /--evidence is required for --as done/);
  usage(() => settleFollowups({ root, ids: k, as: 'banish', reason: 'x' }), /--as must be one of/);
  usage(() => settleFollowups({ root, ids: k }), /--as must be one of/);
});

test('settle: one event per id; a done item accepts nothing later; a dismissed one can be kept again', () => {
  const root = plainRoot();
  const [a, b] = [add(root, 'a').created[0].id, add(root, 'b').created[0].id];
  const before = eventCount(root);
  const both = settleFollowups({ root, ids: `${a},${b}`, as: 'dismissed', reason: 'noise', channel: 'question' });
  assert.equal(both.events.length, 2);
  assert.equal(eventCount(root), before + 2);
  assert.equal(settleFollowups({ root, ids: a, as: 'kept', reason: 'real after all' }).ok, true);
  assert.equal(listFollowups({ root }).items.length, 1);
  settleFollowups({ root, ids: a, as: 'done', evidence: 'shipped' });
  const late = settleFollowups({ root, ids: a, as: 'kept', reason: 'again' });
  assert.equal(late.finding, 'illegal-transition');
  assert.match(late.message, /accepts no later event/);
  const by = JSON.parse(fs.readFileSync(path.join(root, both.events[0]), 'utf8'));
  assert.equal(by.by, 'user');
});

test('settle: a taken item can be released with kept; dismissing it is refused', () => {
  const root = plainRoot();
  const a = add(root, 'a').created[0].id;
  track(root, '050-demo');
  takeFollowups({ root, ids: a, slug: '050-demo' });
  assert.equal(settleFollowups({ root, ids: a, as: 'dismissed', reason: 'x' }).finding, 'illegal-transition');
  assert.equal(settleFollowups({ root, ids: a, as: 'kept', reason: 'not in this feature' }).ok, true);
  const [item] = listFollowups({ root }).items;
  assert.deepEqual([item.state, item.takenBy], ['open', null]);
});

test('settle: an unknown id is a refusal naming it; reason and evidence are masked', () => {
  const root = plainRoot();
  assert.equal(settleFollowups({ root, ids: 'FU-zzzzzz', as: 'kept', reason: 'x' }).finding, 'unknown-id');
  const a = add(root, 'a').created[0].id;
  settleFollowups({ root, ids: a, as: 'fix', reason: 'routed with token=ab12cd34' });
  assert.equal(listFollowups({ root }).items[0].fix, 'routed with token=<masked>');
});
