'use strict';

// The `goal` verb (IC-022): add, item, check, link, list and done, its refusals, its hostile inputs
// and the overview's goal block. Services run in process on scratch repositories; the verb wiring
// runs through the CLI and the dispatcher. Every spawn gets a scratch HOME and XDG_CONFIG_HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo, FIXTURES, SLUG, TRACKED_AT } = require('../helper/lifecycle-git-fixtures');
const store = require('../../src/runtime/lifecycle/event-store');
const goals = require('../../src/runtime/lifecycle/goal');
const { buildOverview } = require('../../src/runtime/lifecycle/overview');
const { FollowupUsageError } = require('../../src/runtime/lifecycle/followup');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const scratch = createScratch('doflow-goal-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

let counter = 0;
function newRepo() {
  const repo = makeRepo(scratch, `goal-${(counter += 1)}`);
  repo.dir = fs.realpathSync(repo.dir);
  return repo;
}
function track(root, slug, at = TRACKED_AT) {
  const out = store.appendEvents(root, [{ type: 'feature.tracked', by: 'agent', data: { slug } }], { now: new Date(at) });
  assert.equal(out.ok, true);
}
function run(cwd, args, runner = 'cli') {
  const [cmd, argv] = runner === 'cli' ? [process.execPath, [CLI, ...args]] : ['bash', [RUN, ...args]];
  const r = spawnSync(cmd, argv, { cwd, env: scratch.env(), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const eventFiles = (root) => { try { return fs.readdirSync(path.join(root, store.EVENTS_REL)).sort(); } catch { return []; } };
const addGoal = (repo, extra = {}) => goals.addGoal({ root: repo.dir, goal: 'public-api-v2', statement: 'Clients can migrate to the v2 API without downtime', items: ['v2 endpoints published', 'v1 clients keep working', 'Migration guide published'], ...extra });
const usage = (fn, pattern) => assert.throws(fn, (e) => e instanceof FollowupUsageError && pattern.test(e.message));

// ── add and item ───────────────────────────────────────────────────────────────────────────────

test('add writes one goal.added event with ids C1.. and a next line; the id is then taken', () => {
  const repo = newRepo();
  const r = addGoal(repo);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, [{ id: 'C1', text: 'v2 endpoints published' }, { id: 'C2', text: 'v1 clients keep working' }, { id: 'C3', text: 'Migration guide published' }]);
  assert.equal(eventFiles(repo.dir).length, 1);
  const event = JSON.parse(fs.readFileSync(path.join(repo.dir, r.events[0]), 'utf8'));
  assert.deepEqual([event.type, event.by, event.data.goal], ['goal.added', 'agent', 'public-api-v2']);
  const again = addGoal(repo);
  assert.deepEqual([again.ok, again.finding], [false, 'goal-exists']);
  assert.match(again.message, /Nothing was written/);
  assert.equal(eventFiles(repo.dir).length, 1);
});

test('add needs a statement and at least one item, and refuses a goal id that is not kebab-case or exceeds 40 characters', () => {
  const repo = newRepo();
  usage(() => addGoal(repo, { items: [] }), /at least one checklist item/);
  usage(() => addGoal(repo, { items: undefined }), /--item is required/);
  usage(() => addGoal(repo, { statement: undefined }), /--statement is required/);
  const bad = ['Public', 'public_api', '-lead', 'trail-', 'a--b', 'a/b', '../x', 'a b', 'x'.repeat(41), '', undefined];
  for (const goal of bad) usage(() => addGoal(repo, { goal }), /--goal/);
  assert.equal(addGoal(repo, { goal: 'x'.repeat(40) }).ok, true, '40 characters is the limit');
  assert.equal(eventFiles(repo.dir).length, 1, 'only the valid id wrote');
});

test('text hygiene: secrets are masked; control characters, bidi overrides, line breaks and huge text are refused with nothing written', () => {
  const repo = newRepo();
  const masked = addGoal(repo, { statement: 'Ship with token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB set', items: ['a'] });
  assert.equal(masked.ok, true);
  assert.doesNotMatch(masked.outcome, /ghp_abcdefghijklmnopqrstuvwxyz0123456789AB/);
  for (const text of ['two\nlines', 'bell\u0007', 'esc\u001b[31m', 'rlo‮evil', 'isolate⁦x', 'nel\u0085x', 'sep x', '   ', 'x'.repeat(5000)]) {
    usage(() => addGoal(repo, { goal: 'other', items: [text] }), /--item 1/);
    usage(() => addGoal(repo, { goal: 'other', statement: text }), /--statement/);
    usage(() => goals.addItem({ root: repo.dir, goal: 'public-api-v2', text }), /--text/);
  }
  usage(() => addGoal(repo, { goal: 'other', items: Array.from({ length: goals.ITEMS_MAX + 1 }, (_, i) => `item ${i}`) }), /at most/);
  assert.equal(eventFiles(repo.dir).length, 1, 'every refusal above left nothing behind');
});

test('item appends the next free id, never reusing one, and refuses an unknown goal', () => {
  const repo = newRepo();
  addGoal(repo);
  const r = goals.addItem({ root: repo.dir, goal: 'public-api-v2', text: 'Rollback plan written' });
  assert.deepEqual([r.ok, r.item], [true, { id: 'C4', text: 'Rollback plan written' }]);
  assert.equal(goals.addItem({ root: repo.dir, goal: 'public-api-v2', text: 'one more' }).item.id, 'C5');
  const unknown = goals.addItem({ root: repo.dir, goal: 'nope', text: 'x' });
  assert.deepEqual([unknown.ok, unknown.finding], [false, 'unknown-goal']);
  usage(() => goals.addItem({ root: repo.dir, goal: 'public-api-v2' }), /--text is required/);
});

test('concurrent item writers each get their own id and none is lost', async () => {
  const repo = newRepo();
  addGoal(repo);
  const env = scratch.env();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'goal', '--action', 'item', '--goal', 'public-api-v2', '--text', `parallel ${i}`, '--json'], { cwd: repo.dir, env }, (err, stdout) => resolve(JSON.parse(stdout)));
  })));
  for (const r of results) assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(new Set(results.map((r) => r.item.id)).size, 6);
  const goal = goals.listGoals({ root: repo.dir }).goals[0];
  assert.equal(goal.items.length, 9);
});

// ── check ──────────────────────────────────────────────────────────────────────────────────────

test('check records met with evidence, or not met under --unmet; evidence is required either way', () => {
  const repo = newRepo();
  addGoal(repo);
  const base = { root: repo.dir, goal: 'public-api-v2' };
  const met = goals.checkItem({ ...base, item: 'C1', evidence: '047-api-cache' });
  assert.deepEqual([met.ok, met.met, met.progress, met.proposeDone], [true, true, { met: 1, total: 3 }, false]);
  assert.match(met.next[0], /--item C2/);
  usage(() => goals.checkItem({ ...base, item: 'C2' }), /--evidence is required/);
  usage(() => goals.checkItem({ ...base, item: 'C2', unmet: true }), /--evidence is required/);
  const unmet = goals.checkItem({ ...base, item: 'C1', evidence: 'regressed in 048', unmet: true });
  assert.deepEqual([unmet.ok, unmet.met, unmet.progress], [true, false, { met: 0, total: 3 }]);
  const listed = goals.listGoals({ root: repo.dir }).goals[0];
  assert.deepEqual(listed.items[0], { id: 'C1', text: 'v2 endpoints published', met: false, evidence: 'regressed in 048' });
});

test('check refuses an unknown goal and an unknown item, and a malformed or repeated --item is a usage error', () => {
  const repo = newRepo();
  addGoal(repo);
  const base = { root: repo.dir, evidence: 'e' };
  assert.equal(goals.checkItem({ ...base, goal: 'nope', item: 'C1' }).finding, 'unknown-goal');
  const missing = goals.checkItem({ ...base, goal: 'public-api-v2', item: 'C9' });
  assert.equal(missing.finding, 'unknown-item');
  assert.match(missing.message, /C1, C2, C3/);
  for (const item of ['c1', 'C0', 'C01', '3', 'C1,C2', '--x', '']) usage(() => goals.checkItem({ ...base, goal: 'public-api-v2', item }), /--item/);
  usage(() => goals.checkItem({ ...base, goal: 'public-api-v2', item: ['C1', 'C2'] }), /exactly one/);
  usage(() => goals.checkItem({ ...base, goal: 'public-api-v2' }), /--item/);
  assert.equal(eventFiles(repo.dir).length, 1);
});

// ── link ───────────────────────────────────────────────────────────────────────────────────────

test('link: untracked-feature, then a tracked feature links; again on the same goal writes nothing', () => {
  const repo = newRepo();
  addGoal(repo);
  const base = { root: repo.dir, goal: 'public-api-v2' };
  const untracked = goals.linkFeature({ ...base, slug: '047-api-cache' });
  assert.deepEqual([untracked.ok, untracked.finding], [false, 'untracked-feature']);
  assert.equal(eventFiles(repo.dir).length, 1);
  track(repo.dir, '047-api-cache');
  const linked = goals.linkFeature({ ...base, slug: '047-api-cache' });
  assert.deepEqual([linked.ok, linked.linked, linked.replaced], [true, 'new', null]);
  const before = eventFiles(repo.dir).length;
  const twice = goals.linkFeature({ ...base, slug: '047-api-cache' });
  assert.deepEqual([twice.ok, twice.linked], [true, 'already']);
  assert.equal(eventFiles(repo.dir).length, before, 'a feature linked twice to one goal writes once');
  usage(() => goals.linkFeature({ ...base, slug: undefined }), /--slug is required/);
  usage(() => goals.linkFeature({ ...base, slug: '../etc' }), /./);
  assert.equal(goals.linkFeature({ ...base, goal: 'nope', slug: '047-api-cache' }).finding, 'unknown-goal');
});

test('a feature serves one goal: goal-already-linked unless --replace, which moves it', () => {
  const repo = newRepo();
  addGoal(repo);
  addGoal(repo, { goal: 'other-goal' });
  track(repo.dir, '047-api-cache');
  assert.equal(goals.linkFeature({ root: repo.dir, goal: 'public-api-v2', slug: '047-api-cache' }).ok, true);
  const refused = goals.linkFeature({ root: repo.dir, goal: 'other-goal', slug: '047-api-cache' });
  assert.deepEqual([refused.ok, refused.finding], [false, 'goal-already-linked']);
  assert.match(refused.message, /public-api-v2.*--replace/);
  const moved = goals.linkFeature({ root: repo.dir, goal: 'other-goal', slug: '047-api-cache', replace: true });
  assert.deepEqual([moved.ok, moved.replaced], [true, 'public-api-v2']);
  const lists = goals.listGoals({ root: repo.dir }).goals;
  assert.deepEqual(lists.find((g) => g.goal === 'public-api-v2').features.unknown.length + lists.find((g) => g.goal === 'public-api-v2').features.inProgress.length, 0);
  assert.equal(JSON.stringify(lists.find((g) => g.goal === 'other-goal').features).includes('047-api-cache'), true);
});

// ── list, progress, nudges ─────────────────────────────────────────────────────────────────────

test('list shows items, progress, linked features by status and a nudge per unchecked item once a linked feature is finished', () => {
  const { repo } = FIXTURES.noTag(scratch);
  repo.dir = fs.realpathSync(repo.dir);
  track(repo.dir, SLUG);
  track(repo.dir, '048-api-auth');
  addGoal(repo);
  for (const slug of [SLUG, '048-api-auth']) assert.equal(goals.linkFeature({ root: repo.dir, goal: 'public-api-v2', slug }).ok, true);
  assert.equal(goals.checkItem({ root: repo.dir, goal: 'public-api-v2', item: 'C1', evidence: SLUG }).ok, true);
  assert.equal(goals.checkItem({ root: repo.dir, goal: 'public-api-v2', item: 'C2', evidence: 'contract tests in 048-api-auth' }).ok, true);
  const r = goals.listGoals({ root: repo.dir });
  assert.equal(r.ok, true);
  const g = r.goals[0];
  assert.deepEqual([g.goal, g.status, g.progress, g.proposeDone], ['public-api-v2', 'open', { met: 2, total: 3 }, false]);
  assert.deepEqual(g.features, { finished: [SLUG], awaitingRelease: [], inProgress: ['048-api-auth'], unknown: [] });
  assert.deepEqual(g.nudges, [`C3 is unchecked and linked feature ${SLUG} is finished`]);
  assert.deepEqual(g.items[2], { id: 'C3', text: 'Migration guide published', met: false, evidence: null });
  assert.match(r.next[0], /goal --action check --goal public-api-v2 --item C3 --evidence/);
  assert.deepEqual(Object.keys(g).sort(), ['features', 'goal', 'items', 'nudges', 'outcome', 'progress', 'proposeDone', 'status']);
});

test('proposeDone is true when every item is met and the goal is open, and the next line asks the user', () => {
  const repo = newRepo();
  addGoal(repo, { items: ['one', 'two'] });
  const base = { root: repo.dir, goal: 'public-api-v2', evidence: 'shown' };
  goals.checkItem({ ...base, item: 'C1' });
  const last = goals.checkItem({ ...base, item: 'C2' });
  assert.equal(last.proposeDone, true);
  assert.match(last.next[0], /ask the user, then: doflow-run goal --action done --goal public-api-v2 --channel question/);
  const listed = goals.listGoals({ root: repo.dir });
  assert.equal(listed.goals[0].proposeDone, true);
  assert.match(listed.next[0], /ask the user/);
  assert.equal(goals.doneGoal({ root: repo.dir, goal: 'public-api-v2', channel: 'question' }).ok, true);
  const closed = goals.listGoals({ root: repo.dir }).goals[0];
  assert.deepEqual([closed.status, closed.proposeDone], ['done', false]);
});

test('list --goal narrows to one, refuses an unknown one, and an empty store lists nothing without creating a folder', () => {
  const repo = newRepo();
  assert.deepEqual(goals.listGoals({ root: repo.dir }).goals, []);
  assert.equal(fs.existsSync(path.join(repo.dir, 'agent-docs')), false, 'a read writes nothing');
  addGoal(repo);
  addGoal(repo, { goal: 'other-goal' });
  assert.deepEqual(goals.listGoals({ root: repo.dir, goal: 'other-goal' }).goals.map((g) => g.goal), ['other-goal']);
  assert.equal(goals.listGoals({ root: repo.dir, goal: 'nope' }).finding, 'unknown-goal');
});

// ── done ───────────────────────────────────────────────────────────────────────────────────────

test('done is the user only: default and no channel are refused not-user and write nothing', () => {
  const repo = newRepo();
  addGoal(repo, { items: ['one'] });
  goals.checkItem({ root: repo.dir, goal: 'public-api-v2', item: 'C1', evidence: 'shown' });
  const before = eventFiles(repo.dir).length;
  for (const channel of [undefined, 'default']) {
    const r = goals.doneGoal({ root: repo.dir, goal: 'public-api-v2', channel });
    assert.deepEqual([r.ok, r.finding], [false, 'not-user']);
  }
  usage(() => goals.doneGoal({ root: repo.dir, goal: 'public-api-v2', channel: 'bogus' }), /unknown --channel/);
  assert.equal(eventFiles(repo.dir).length, before);
  for (const channel of ['question', 'gate', 'prompt']) {
    const fresh = newRepo();
    addGoal(fresh, { items: ['one'] });
    goals.checkItem({ root: fresh.dir, goal: 'public-api-v2', item: 'C1', evidence: 'shown' });
    const r = goals.doneGoal({ root: fresh.dir, goal: 'public-api-v2', channel });
    assert.equal(r.ok, true, channel);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fresh.dir, r.events[0]), 'utf8')).by, 'user');
  }
});

test('done with unmet items is refused items-unmet unless --reason records why; a second done is refused', () => {
  const repo = newRepo();
  addGoal(repo);
  const base = { root: repo.dir, goal: 'public-api-v2', channel: 'question' };
  const refused = goals.doneGoal(base);
  assert.deepEqual([refused.ok, refused.finding], [false, 'items-unmet']);
  assert.match(refused.message, /C1, C2, C3/);
  const closed = goals.doneGoal({ ...base, reason: 'Migration moved to the next quarter' });
  assert.deepEqual([closed.ok, closed.unmet, closed.reason], [true, ['C1', 'C2', 'C3'], 'Migration moved to the next quarter']);
  assert.equal(goals.listGoals({ root: repo.dir }).goals[0].reason, 'Migration moved to the next quarter');
  assert.equal(goals.doneGoal({ ...base, reason: 'again' }).finding, 'already-done');
  assert.equal(goals.doneGoal({ ...base, goal: 'nope' }).finding, 'unknown-goal');
  usage(() => goals.doneGoal({ ...base, reason: 'bad\nline' }), /--reason/);
});

// ── overview ───────────────────────────────────────────────────────────────────────────────────

test('the overview carries each open goal and omits a done one; a feature serving no goal is unaffected', () => {
  const { repo } = FIXTURES.noTag(scratch);
  repo.dir = fs.realpathSync(repo.dir);
  track(repo.dir, SLUG);
  const before = buildOverview({ root: repo.dir });
  assert.deepEqual(before.goals, []);
  addGoal(repo, { items: ['one', 'two'] });
  const unlinked = buildOverview({ root: repo.dir });
  assert.deepEqual(unlinked.features, before.features, 'a goal changes no feature status');
  goals.linkFeature({ root: repo.dir, goal: 'public-api-v2', slug: SLUG });
  const g = buildOverview({ root: repo.dir }).goals[0];
  assert.deepEqual([g.goal, g.items, g.proposeDone, g.features.finished], ['public-api-v2', { met: 0, total: 2 }, false, [SLUG]]);
  assert.deepEqual(g.nudges, [`C1 is unchecked and linked feature ${SLUG} is finished`, `C2 is unchecked and linked feature ${SLUG} is finished`]);
  goals.doneGoal({ root: repo.dir, goal: 'public-api-v2', channel: 'gate', reason: 'closed early' });
  assert.deepEqual(buildOverview({ root: repo.dir }).goals, []);
});

test('the maintain overview asks the user to close a goal whose items are all met', () => {
  const repo = newRepo();
  addGoal(repo, { items: ['one'] });
  goals.checkItem({ root: repo.dir, goal: 'public-api-v2', item: 'C1', evidence: 'shown' });
  const view = buildOverview({ root: repo.dir, maintain: true });
  assert.equal(view.goals[0].proposeDone, true);
  assert.ok(view.next.some((l) => /goal --action done --goal public-api-v2 --channel question/.test(l)));
});

test('two clones that add an item to one goal leave a dropped item that list and the overview report, with how to resolve it', () => {
  const repo = newRepo();
  addGoal(repo, { items: ['one', 'two'], now: new Date('2026-10-01T09:00:00.000Z') });
  // What the merge of two clones' event files looks like: both clones chose the next free id, C3.
  const clone = (id, at, text) => fs.writeFileSync(path.join(repo.dir, store.EVENTS_REL, `${id}.json`), `${JSON.stringify({
    v: 1, id, at, type: 'goal.item-added', by: 'agent', data: { goal: 'public-api-v2', item: { id: 'C3', text } },
  })}\n`);
  clone('20261001T090100000Z-aaaaaa', '2026-10-01T09:01:00.000Z', 'from clone A');
  clone('20261001T090200000Z-bbbbbb', '2026-10-01T09:02:00.000Z', 'from clone B');

  const listed = goals.listGoals({ root: repo.dir });
  const [g] = listed.goals;
  assert.deepEqual(g.items.map((i) => [i.id, i.text]), [['C1', 'one'], ['C2', 'two'], ['C3', 'from clone A']], 'the first one won');
  assert.equal(g.conflicts.length, 1);
  assert.deepEqual([g.conflicts[0].event, g.conflicts[0].type, g.conflicts[0].code, g.conflicts[0].item, g.conflicts[0].text],
    ['20261001T090200000Z-bbbbbb', 'goal.item-added', 'illegal-transition', 'C3', 'from clone B']);
  assert.equal(listed.conflicts.length, 1, 'the top-level conflicts are unchanged');
  const line = listed.next.find((n) => /dropped/.test(n));
  assert.match(line, /re-add it under a new text: doflow-run goal --action item --goal public-api-v2 --text "<the item>"/);
  assert.doesNotMatch(listed.next.join('\n'), /from clone B/, 'text from another clone is data, never in a next line');

  const overview = buildOverview({ root: repo.dir });
  assert.deepEqual(overview.goals[0].conflicts, g.conflicts);
  assert.ok(overview.next.includes(line));

  // The text form of both reads shows the conflict.
  const text = run(repo.dir, ['goal', '--action', 'list']);
  assert.match(text.stdout, /conflict: public-api-v2 already has item C3 \(dropped text: "from clone B"\)/);
  assert.match(text.stdout, /next: .*re-add it under a new text/);
  assert.match(run(repo.dir, ['lifecycle', '--action', 'overview']).stdout, /conflict: public-api-v2 already has item C3/);

  // Re-adding the item resolves it as far as the user is concerned; the event files stay as they are.
  assert.equal(goals.addItem({ root: repo.dir, goal: 'public-api-v2', text: 'from clone B' }).item.id, 'C4');
  const after = goals.listGoals({ root: repo.dir });
  assert.equal(after.goals[0].conflicts, undefined);
  assert.equal(after.next.some((n) => /dropped/.test(n)), false);
  assert.equal(after.conflicts.length, 1, 'the fold still records the dropped event');
});

test('two clones that add the same goal: the second goal.added is reported against the goal', () => {
  const repo = newRepo();
  addGoal(repo, { now: new Date('2026-10-01T09:00:00.000Z') });
  const id = '20261001T090100000Z-cccccc';
  fs.writeFileSync(path.join(repo.dir, store.EVENTS_REL, `${id}.json`), `${JSON.stringify({
    v: 1, id, at: '2026-10-01T09:01:00.000Z', type: 'goal.added', by: 'agent', data: { goal: 'public-api-v2', outcome: 'other', items: [{ id: 'C1', text: 'x' }] },
  })}\n`);
  const [g] = goals.listGoals({ root: repo.dir }).goals;
  assert.deepEqual(g.conflicts.map((c) => [c.type, c.code]), [['goal.added', 'goal-exists']]);
  assert.match(goals.listGoals({ root: repo.dir }).next.join('\n'), /re-add yours under a different goal id/);
});

// ── verb wiring ────────────────────────────────────────────────────────────────────────────────

test('goal runs end to end through the CLI and the dispatcher, with a repeatable --item', () => {
  const repo = newRepo();
  for (const [runner, id] of [['cli', 'via-cli'], ['run', 'via-run']]) {
    const added = run(repo.dir, ['goal', '--action', 'add', '--goal', id, '--statement', 'An outcome', '--item', 'first', '--item=second', '--json'], runner);
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(added.json.items.map((i) => i.id), ['C1', 'C2']);
    const checked = run(repo.dir, ['goal', '--action', 'check', '--goal', id, '--item', 'C2', '--evidence', 'it works', '--json'], runner);
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(checked.json.progress, { met: 1, total: 2 });
    const text = run(repo.dir, ['goal', '--action', 'list', '--goal', id], runner);
    assert.equal(text.status, 0);
    assert.match(text.stdout, new RegExp(`${id}  open  1/2 items met`));
  }
  const listed = run(repo.dir, ['goal', '--action', 'list', '--json']);
  assert.equal(listed.json.goals.length, 2);
  const refused = run(repo.dir, ['goal', '--action', 'done', '--goal', 'via-cli', '--json']);
  assert.equal(refused.status, 1);
  assert.deepEqual([refused.json.ok, refused.json.finding], [false, 'not-user']);
  const done = run(repo.dir, ['goal', '--action', 'done', '--goal', 'via-cli', '--channel', 'question', '--reason', 'enough for now', '--json']);
  assert.equal(done.status, 0);
  assert.deepEqual(done.json.unmet, ['C1']);
});

test('link, --unmet and --replace reach their handlers through the CLI', () => {
  const repo = newRepo();
  run(repo.dir, ['goal', '--action', 'add', '--goal', 'one', '--statement', 's', '--item', 'a']);
  run(repo.dir, ['goal', '--action', 'add', '--goal', 'two', '--statement', 's', '--item', 'a']);
  track(repo.dir, '047-api-cache');
  assert.equal(run(repo.dir, ['goal', '--action', 'link', '--goal', 'one', '--slug', '047-api-cache', '--json']).status, 0);
  const second = run(repo.dir, ['goal', '--action', 'link', '--goal', 'two', '--slug', '047-api-cache', '--json']);
  assert.deepEqual([second.status, second.json.finding], [1, 'goal-already-linked']);
  const moved = run(repo.dir, ['goal', '--action', 'link', '--goal', 'two', '--slug', '047-api-cache', '--replace', '--json']);
  assert.deepEqual([moved.status, moved.json.replaced], [0, 'one']);
  const unmet = run(repo.dir, ['goal', '--action', 'check', '--goal', 'one', '--item', 'C1', '--evidence', 'broke', '--unmet', '--json']);
  assert.deepEqual([unmet.status, unmet.json.met], [0, false]);
  const item = run(repo.dir, ['goal', '--action', 'item', '--goal', 'one', '--text', 'second thing', '--json']);
  assert.equal(item.json.item.id, 'C2');
});

test('usage errors exit 2 with the usage shape: -g, no or unknown action, missing goal, a flag that does not apply, a dash-led value', () => {
  const repo = newRepo();
  const shape = (r, pattern) => {
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.deepEqual([r.json.ok, r.json.status, r.json.exitCode, r.json.error], [false, 'USAGE', 2, 'usage']);
    assert.match(r.json.summary, pattern);
  };
  shape(run(repo.dir, ['goal', '--action', 'list', '-g', '--json']), /refuses -g/);
  shape(run(repo.dir, ['goal', '--json']), /add, item, check, link, list, done/);
  shape(run(repo.dir, ['goal', '--action', 'bogus', '--json']), /add, item, check, link, list, done/);
  shape(run(repo.dir, ['goal', '--action', 'add', '--statement', 's', '--item', 'a', '--json']), /--goal is required/);
  shape(run(repo.dir, ['goal', '--action', 'add', '--goal', 'g', '--statement', 's', '--item', 'a', '--unmet', '--json']), /--unmet does not apply to --action add/);
  shape(run(repo.dir, ['goal', '--action', 'done', '--goal', 'g', '--evidence', 'x', '--json']), /--evidence does not apply/);
  shape(run(repo.dir, ['goal', '--action', 'list', '--slug', 'x', '--json']), /--slug does not apply/);
  shape(run(repo.dir, ['goal', '--action', 'list', '--goal=-bad', '--json']), /kebab-case/);
  shape(run(repo.dir, ['goal', '--action', 'list', '--goal=../up', '--json']), /kebab-case/);
  const dashed = run(repo.dir, ['goal', '--action', 'add', '--goal', 'g', '--statement', '-lead', '--item', 'a']);
  assert.equal(dashed.status, 2);
  assert.match(dashed.stderr, /--statement requires a value/);
  assert.equal(run(repo.dir, ['goal', '--action', 'add', '--goal', 'g', '--statement=-lead', '--item=-first', '--json']).status, 0, 'the = form accepts a dash-led value');
  assert.equal(eventFiles(repo.dir).length, 1, 'only the last call wrote');
});

test('the dispatcher names goal in its usage text', () => {
  const repo = newRepo();
  assert.match(run(repo.dir, ['--help'], 'run').stdout + run(repo.dir, ['help'], 'run').stdout, /goal\s+add, check, link, list or close a goal/);
});
