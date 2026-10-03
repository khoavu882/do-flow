'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo, FIXTURES, SLUG, TRACKED_AT } = require('../helper/lifecycle-git-fixtures');
const store = require('../../src/runtime/lifecycle/event-store');
const { buildOverview, initFeature, featureStatus } = require('../../src/runtime/lifecycle/overview');
const { FollowupUsageError } = require('../../src/runtime/lifecycle/followup');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const RUN = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const scratch = createScratch('doflow-lcli-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

let counter = 0;
function newRepo(extra = {}) {
  const repo = makeRepo(scratch, `cli-${(counter += 1)}`);
  repo.dir = fs.realpathSync(repo.dir);
  return { repo, ...extra };
}
function folder(repo, slug) { fs.mkdirSync(path.join(repo.dir, 'agent-docs', 'doflow', slug), { recursive: true }); }

/** Runs the CLI; parses stdout as JSON when it is. */
function run(cwd, args, { runner = 'cli' } = {}) {
  const [cmd, argv] = runner === 'cli' ? [process.execPath, [CLI, ...args]] : ['bash', [RUN, ...args]];
  const r = spawnSync(cmd, argv, { cwd, env: scratch.env(), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).sort().join('\n');

// ── wiring ─────────────────────────────────────────────────────────────────────────────────────

test('bare lifecycle is the overview; an empty project answers exit 0 and creates nothing', () => {
  const { repo } = newRepo();
  const before = tree(repo.dir);
  const r = run(repo.dir, ['lifecycle', '--json']);
  assert.equal(r.status, 0);
  assert.deepEqual([r.json.ok, r.json.mode, r.json.releaseMode, r.json.integrationRef], [true, 'discovery', 'untagged', 'develop']);
  assert.deepEqual(r.json.followups, { open: 0, shown: 0, items: [] });
  assert.deepEqual([r.json.intents, r.json.goals, r.json.conflicts, r.json.unreadable, r.json.failures, r.json.next], [[], [], [], [], null, []]);
  assert.deepEqual(r.json.features, { finished: [], awaitingRelease: [], inProgress: [], unknown: [] });
  assert.equal(tree(repo.dir), before, 'a read writes nothing');
});

test('the dispatcher routes both verbs to the Node CLI', () => {
  const { repo } = newRepo();
  const added = run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', SLUG, '--statement', 'via the dispatcher', '--json'], { runner: 'run' });
  assert.equal(added.status, 0, added.stderr);
  const overview = run(repo.dir, ['lifecycle', '--action', 'overview', '--json'], { runner: 'run' });
  assert.equal(overview.json.followups.open, 1);
  assert.match(run(repo.dir, ['--help'], { runner: 'run' }).stdout + run(repo.dir, ['help'], { runner: 'run' }).stdout, /followup/);
});

test('-g is refused with exit 2 and the usage shape, for both verbs', () => {
  const { repo } = newRepo();
  for (const verb of ['followup', 'lifecycle']) {
    const r = run(repo.dir, [verb, '--action', 'list', '-g', '--json']);
    assert.equal(r.status, 2, verb);
    assert.deepEqual([r.json.ok, r.json.status, r.json.exitCode, r.json.error], [false, 'USAGE', 2, 'usage']);
    assert.match(r.json.summary, /refuses -g/);
  }
});

test('followup needs an action; an unknown one names the valid set; lifecycle names its own', () => {
  const { repo } = newRepo();
  const none = run(repo.dir, ['followup', '--json']);
  assert.equal(none.status, 2);
  assert.match(none.json.summary, /add, list, take, settle, promote/);
  assert.equal(run(repo.dir, ['followup', '--action', 'report', '--json']).status, 2);
  const life = run(repo.dir, ['lifecycle', '--action', 'release', '--json']);
  assert.equal(life.status, 2);
  assert.match(life.json.summary, /overview, init, status/);
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'status', '--json']).status, 2, 'status needs a slug');
});

test('a value that starts with - is refused by the flag parser (use --batch for such text)', () => {
  const { repo } = newRepo();
  const r = run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', SLUG, '--statement', '-dash first']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--statement requires a value/);
});

// ── followup through the CLI ───────────────────────────────────────────────────────────────────

test('followup add, list, settle: the IC-006 result shapes and exit codes', () => {
  const { repo } = newRepo();
  const add = run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', SLUG, '--statement', 'Validator misses a stale DEC in a table cell', '--json']);
  assert.equal(add.status, 0);
  assert.deepEqual(Object.keys(add.json), ['ok', 'action', 'created', 'events', 'next']);
  assert.deepEqual(add.json.created[0].source, { kind: 'stage', feature: SLUG, stage: 'review' });
  assert.match(add.json.events[0], /^agent-docs\/lifecycle\/events\/\d{8}T\d{9}Z-[0-9a-hjkmnp-tv-z]{6}\.json$/);
  const id = add.json.created[0].id;

  const list = run(repo.dir, ['followup', '--action', 'list', '--json']);
  assert.deepEqual([list.status, list.json.count, list.json.items[0].id], [0, 1, id]);

  const refused = run(repo.dir, ['followup', '--action', 'take', '--ids', id, '--slug', SLUG, '--json']);
  assert.equal(refused.status, 1);
  assert.deepEqual(Object.keys(refused.json), ['ok', 'action', 'finding', 'message']);
  assert.deepEqual([refused.json.ok, refused.json.action, refused.json.finding], [false, 'take', 'untracked-feature']);

  const settled = run(repo.dir, ['followup', '--action', 'settle', '--ids', id, '--as', 'dismissed', '--reason', 'not worth it', '--channel', 'question', '--json']);
  assert.equal(settled.status, 0);
  assert.equal(run(repo.dir, ['followup', '--action', 'list', '--json']).json.count, 0);
  assert.equal(run(repo.dir, ['followup', '--action', 'list', '--state', 'dismissed', '--json']).json.count, 1);
  const noReason = run(repo.dir, ['followup', '--action', 'settle', '--ids', id, '--as', 'kept', '--json']);
  assert.equal(noReason.status, 2);
});

test('followup add --batch writes every item; an invalid item writes nothing and exits 2', () => {
  const { repo } = newRepo();
  const file = path.join(scratch.dir, `batch-${counter}.json`);
  fs.writeFileSync(file, JSON.stringify([{ statement: 'one' }, { statement: 'two', stage: 'design' }]));
  const ok = run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', SLUG, '--batch', file, '--json']);
  assert.deepEqual([ok.status, ok.json.created.length], [0, 2]);
  fs.writeFileSync(file, JSON.stringify([{ statement: 'fine' }, { statement: '' }, { statement: 'x', stage: 'nope' }]));
  const bad = run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', SLUG, '--batch', file, '--json']);
  assert.equal(bad.status, 2);
  assert.match(bad.json.summary, /item 2.*item 3/);
  assert.equal(run(repo.dir, ['followup', '--action', 'list', '--json']).json.count, 2);
});

test('the store is shared by every worktree of a clone and found from a subfolder', () => {
  const { repo } = newRepo();
  const linked = path.join(scratch.dir, `linked-${counter}`);
  repo.git('worktree', 'add', '-q', '-b', 'feat/other', linked);
  fs.mkdirSync(path.join(linked, 'sub'));
  const add = run(path.join(linked, 'sub'), ['followup', '--action', 'add', '--stage', 'review', '--slug', SLUG, '--statement', 'from a linked worktree', '--json']);
  assert.equal(add.status, 0, add.stderr);
  assert.ok(fs.existsSync(path.join(repo.dir, add.json.events[0])), 'the event is in the first worktree');
  assert.equal(fs.existsSync(path.join(linked, 'agent-docs', 'lifecycle')), false);
  assert.equal(run(repo.dir, ['followup', '--action', 'list', '--json']).json.count, 1);
});

test('human output prints one line per item', () => {
  const { repo } = newRepo();
  run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', SLUG, '--statement', 'readable line']);
  const list = run(repo.dir, ['followup', '--action', 'list']);
  assert.match(list.stdout, /^FU-[0-9a-hjkmnp-tv-z]{6}  open  \(stage .*\)  readable line$/m);
  const overview = run(repo.dir, ['lifecycle']);
  assert.match(overview.stdout, /discovery overview: 1 open follow-up, 1 shown/);
  assert.match(overview.stdout, /next: Take items into the new feature/);
});

// ── lifecycle init and status ──────────────────────────────────────────────────────────────────

test('init tracks a feature whose folder exists, takes items, and reports already on a repeat', () => {
  const { repo } = newRepo();
  const id = run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', '049-old', '--statement', 'left behind', '--json']).json.created[0].id;
  const missing = run(repo.dir, ['lifecycle', '--action', 'init', '--slug', '050-new', '--json']);
  assert.equal(missing.status, 1);
  assert.equal(missing.json.finding, 'no-feature-folder');
  assert.match(missing.json.message, /agent-docs\/doflow\/050-new/);
  assert.match(missing.json.message, /Nothing was written/);
  folder(repo, '050-new');
  const init = run(repo.dir, ['lifecycle', '--action', 'init', '--slug', '050-new', '--take', id, '--json']);
  assert.equal(init.status, 0, init.stdout);
  assert.deepEqual(Object.keys(init.json).slice(0, 6), ['ok', 'action', 'slug', 'tracked', 'taken', 'goal']);
  assert.deepEqual([init.json.tracked, init.json.taken, init.json.goal], ['new', [id], null]);
  assert.equal(init.json.events.length, 2, 'one tracked event and one taken event');
  const again = run(repo.dir, ['lifecycle', '--action', 'init', '--slug', '050-new', '--json']);
  assert.deepEqual([again.json.tracked, again.json.taken, again.json.events], ['already', [], []]);
  assert.equal(run(repo.dir, ['followup', '--action', 'list', '--state', 'taken', '--json']).json.items[0].takenBy, '050-new');
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'init', '--slug', '../x', '--json']).status, 2);
});

test('init refuses a folder that exists only in a linked worktree, and a taken or unknown id writes nothing', () => {
  const { repo } = newRepo();
  const linked = path.join(scratch.dir, `linked-folder-${counter}`);
  repo.git('worktree', 'add', '-q', '-b', 'feat/051-wt', linked);
  fs.mkdirSync(path.join(linked, 'agent-docs', 'doflow', '051-wt'), { recursive: true });
  const r = run(linked, ['lifecycle', '--action', 'init', '--slug', '051-wt', '--json']);
  assert.equal(r.json.finding, 'no-feature-folder');
  assert.ok(r.json.message.includes(repo.dir), 'it names the root it searched');
  folder(repo, '052-x');
  const unknown = run(repo.dir, ['lifecycle', '--action', 'init', '--slug', '052-x', '--take', 'FU-zzzzzz', '--json']);
  assert.deepEqual([unknown.status, unknown.json.finding], [1, 'unknown-id']);
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'status', '--slug', '052-x', '--json']).json.finding, 'untracked-feature');
});

test('init --intent takes the open items promoted to that intent; --goal links, and refuses a second goal', () => {
  const { repo } = newRepo();
  const a = run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', '049-old', '--statement', 'item a', '--json']).json.created[0].id;
  const b = run(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--slug', '049-old', '--statement', 'item b', '--json']).json.created[0].id;
  const promoted = run(repo.dir, ['followup', '--action', 'promote', '--ids', `${a},${b}`, '--title', 'Cart robustness', '--channel', 'question', '--json']);
  assert.equal(promoted.status, 0);
  assert.deepEqual(Object.keys(promoted.json), ['ok', 'action', 'intent', 'ids', 'events', 'next']);
  const overview = run(repo.dir, ['lifecycle', '--json']).json;
  assert.deepEqual(overview.intents, [{ path: 'agent-docs/intent/cart-robustness.md', items: [a, b] }]);
  assert.ok(overview.followups.items.every((i) => i.promoted && i.intent === 'agent-docs/intent/cart-robustness.md'));
  assert.ok(overview.next.some((l) => l.startsWith('Start from a promoted intent: /do-brainstorm --intent agent-docs/intent/cart-robustness.md, then doflow-run lifecycle --action init --slug <slug> --intent agent-docs/intent/cart-robustness.md')));
  // Goals arrive through the goal verb in a later phase; the store folds them already.
  for (const goal of ['g-one', 'g-two']) {
    store.appendEvents(repo.dir, [{ type: 'goal.added', by: 'user', data: { goal, outcome: `outcome ${goal}`, items: [{ id: 'C1', text: 't' }] } }]);
  }
  folder(repo, '053-intent');
  const init = run(repo.dir, ['lifecycle', '--action', 'init', '--slug', '053-intent', '--intent', 'agent-docs/intent/cart-robustness.md', '--goal', 'g-one', '--json']);
  assert.equal(init.status, 0, init.stdout);
  assert.deepEqual([init.json.taken, init.json.goal], [[a, b], 'g-one']);
  folder(repo, '054-other');
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'init', '--slug', '054-other', '--goal', 'nope', '--json']).json.finding, 'unknown-goal');
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'init', '--slug', '053-intent', '--goal', 'g-two', '--json']).json.finding, 'goal-already-linked');
});

test('status derives from git: a tracked, merged feature is finished; evidence and taken items are named', () => {
  const built = FIXTURES.mergeCommit(scratch);
  const root = fs.realpathSync(built.repo.dir);
  store.appendEvents(root, [
    { type: 'followup.added', by: 'agent', data: { id: 'FU-aaaaaa', statement: 's', source: { kind: 'manual' } } },
    { type: 'feature.tracked', by: 'agent', data: { slug: SLUG } },
    { type: 'followup.taken', by: 'agent', data: { ids: ['FU-aaaaaa'], feature: SLUG } },
  ], { now: new Date(TRACKED_AT) });
  const status = run(root, ['lifecycle', '--action', 'status', '--slug', SLUG, '--json']);
  assert.equal(status.status, 0);
  assert.deepEqual(Object.keys(status.json), ['ok', 'action', 'slug', 'status', 'integrationRef', 'evidence', 'release', 'takenItems']);
  assert.deepEqual([status.json.status, status.json.integrationRef, status.json.evidence.kind, status.json.release, status.json.takenItems], ['finished', 'develop', 'branch', null, ['FU-aaaaaa']]);
  assert.match(run(root, ['lifecycle', '--action', 'status', '--slug', SLUG]).stdout, new RegExp(`^${SLUG}: finished \\(branch feat/${SLUG}\\)`));
  const overview = run(root, ['lifecycle', '--json']).json;
  assert.equal(overview.followups.open, 0, 'the taken item shows done now that its feature is finished');
  assert.deepEqual(overview.features.finished, [SLUG]);
});

// ── overview ───────────────────────────────────────────────────────────────────────────────────

test('overview shows 15 of 17 items, reports first then oldest first, and the List the rest line', () => {
  const root = path.join(scratch.dir, `overview-${counter += 1}`);
  fs.mkdirSync(root);
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  const events = [];
  for (let i = 1; i <= 17; i += 1) {
    const report = i === 17;
    events.push({ type: 'followup.added', by: 'agent', data: { id: `FU-${String(i).padStart(6, '0')}`, statement: `item ${i}`, source: report ? { kind: 'report', release: 'v1.0.0' } : { kind: 'stage', feature: '049-x', stage: 'review' }, ...(report ? { excerpt: 'x', bodyRef: null, bodyBytes: 1 } : {}) } });
  }
  store.appendEvents(root, events, { now: new Date(base) });
  const o = buildOverview({ root });
  assert.deepEqual([o.followups.open, o.followups.shown], [17, 15]);
  assert.equal(o.followups.items[0].id, 'FU-000017', 'the report comes first');
  assert.deepEqual(o.followups.items.slice(1, 4).map((i) => i.id), ['FU-000001', 'FU-000002', 'FU-000003']);
  assert.equal(o.next[0], 'List the rest: doflow-run followup --action list');
  assert.deepEqual(Object.keys(o.followups.items[0]), ['id', 'statement', 'source', 'state', 'promoted', 'intent', 'added']);
  const all = buildOverview({ root, maintain: true });
  assert.deepEqual([all.mode, all.followups.shown, all.pending], ['maintain', 17, 17]);
  assert.equal(all.next.includes('List the rest: doflow-run followup --action list'), false);
});

test('maintain: a kept item leaves pending while staying open; the list stops at 50', () => {
  const root = path.join(scratch.dir, `maintain-${counter += 1}`);
  fs.mkdirSync(root);
  const events = [];
  for (let i = 1; i <= 52; i += 1) events.push({ type: 'followup.added', by: 'agent', data: { id: `FU-${String(i).padStart(6, '0')}`, statement: `item ${i}`, source: { kind: 'manual' } } });
  store.appendEvents(root, events, { now: new Date('2026-10-01T00:00:00.000Z') });
  const startedAt = new Date().toISOString();
  const first = buildOverview({ root, maintain: true, since: startedAt });
  assert.deepEqual([first.followups.open, first.followups.shown, first.pending], [52, 50, 52]);
  assert.ok(first.next.some((l) => l.startsWith('Keep open: doflow-run followup --action settle --ids FU-000001 --as kept')));
  store.appendEvents(root, [{ type: 'followup.settled', by: 'user', data: { id: 'FU-000001', as: 'kept', reason: 'still wanted' } }], { now: new Date(Date.now() + 5000) });
  const second = buildOverview({ root, maintain: true, since: startedAt });
  assert.deepEqual([second.followups.open, second.pending], [52, 51]);
  assert.equal(second.followups.items.find((i) => i.id === 'FU-000001').pending, false);
  assert.throws(() => buildOverview({ root, maintain: true, since: 'yesterday' }), FollowupUsageError);
});

test('maintain: promoting an item settles it for the pass and no promote line is offered for it', () => {
  const root = path.join(scratch.dir, `promoted-${counter += 1}`);
  fs.mkdirSync(root);
  store.appendEvents(root, ['a', 'b', 'c'].map((s) => ({ type: 'followup.added', by: 'agent', data: { id: `FU-00000${s}`, statement: s, source: { kind: 'manual' } } })), { now: new Date('2026-10-01T00:00:00.000Z') });
  const since = new Date(Date.now() - 1000).toISOString();
  const r = run(root, ['followup', '--action', 'promote', '--ids', 'FU-00000a,FU-00000b', '--title', 'Two things', '--json']);
  assert.equal(r.status, 0, r.stdout);
  const o = buildOverview({ root, maintain: true, since });
  assert.equal(o.pending, 1, 'the untouched item only');
  assert.deepEqual(o.followups.items.filter((i) => i.pending).map((i) => i.id), ['FU-00000c']);
  assert.ok(o.next.some((l) => l.includes('--action promote --ids FU-00000c')));
  const allPromoted = buildOverview({ root: (() => { store.appendEvents(root, [{ type: 'followup.settled', by: 'user', data: { id: 'FU-00000c', as: 'kept', reason: 'x' } }]); return root; })(), maintain: true, since });
  assert.equal(allPromoted.pending, 0);
  assert.equal(allPromoted.next.some((l) => l.startsWith('Promote to a new intent')), false);
});

test('overview groups goals with progress, linked features by status, nudges and propose-done', () => {
  const built = FIXTURES.mergeCommit(scratch);
  const root = fs.realpathSync(built.repo.dir);
  const at = new Date(TRACKED_AT);
  store.appendEvents(root, [
    { type: 'goal.added', by: 'user', data: { goal: 'public-api-v2', outcome: 'Clients can migrate', items: [{ id: 'C1', text: 'endpoints' }, { id: 'C2', text: 'guide' }] } },
    { type: 'feature.tracked', by: 'agent', data: { slug: SLUG } },
    { type: 'feature.tracked', by: 'agent', data: { slug: '048-api-auth' } },
    { type: 'goal.linked', by: 'agent', data: { goal: 'public-api-v2', slug: SLUG, replace: false } },
    { type: 'goal.linked', by: 'agent', data: { goal: 'public-api-v2', slug: '048-api-auth', replace: false } },
    { type: 'goal.checked', by: 'agent', data: { goal: 'public-api-v2', item: 'C1', met: true, evidence: SLUG } },
  ], { now: at });
  const o = buildOverview({ root });
  assert.equal(o.goals.length, 1);
  const goal = o.goals[0];
  assert.deepEqual(goal.items, { met: 1, total: 2 });
  assert.equal(goal.proposeDone, false);
  assert.deepEqual(goal.features, { finished: [SLUG], awaitingRelease: [], inProgress: ['048-api-auth'], unknown: [] });
  assert.deepEqual(goal.nudges, [`C2 is unchecked and linked feature ${SLUG} is finished`]);
  assert.deepEqual(o.features.finished, [SLUG]);
  assert.ok(o.next.includes('Link the new feature to a goal: add --goal public-api-v2 to the init line'));
  store.appendEvents(root, [{ type: 'goal.checked', by: 'agent', data: { goal: 'public-api-v2', item: 'C2', met: true, evidence: 'guide published' } }]);
  const done = buildOverview({ root, maintain: true });
  assert.equal(done.goals[0].proposeDone, true);
  assert.ok(done.next.some((l) => l.includes('doflow-run goal --action done --goal public-api-v2 --channel question')));
});

test('conflicts and unreadable event files are reported, and the overview still answers', () => {
  const root = path.join(scratch.dir, `conflicts-${counter += 1}`);
  fs.mkdirSync(root);
  store.appendEvents(root, [{ type: 'followup.added', by: 'agent', data: { id: 'FU-aaaaaa', statement: 's', source: { kind: 'manual' } } }]);
  fs.writeFileSync(path.join(root, store.EVENTS_REL, '20261004T091200123Z-k3m9qa.json'), '{"v":1');
  const dup = { v: 1, id: '20990101T000000000Z-aaaaaa', type: 'followup.added', at: '2099-01-01T00:00:00.000Z', by: 'agent', data: { id: 'FU-aaaaaa', statement: 's', source: { kind: 'manual' } } };
  fs.writeFileSync(path.join(root, store.EVENTS_REL, `${dup.id}.json`), JSON.stringify(dup));
  const o = buildOverview({ root });
  assert.deepEqual(o.unreadable, ['20261004T091200123Z-k3m9qa.json']);
  assert.equal(o.conflicts.length, 1);
  assert.equal(o.followups.open, 1);
});

test('overview outside a git repository reports unknown release mode and no integration ref', () => {
  const root = path.join(scratch.dir, `nogit-${counter += 1}`);
  fs.mkdirSync(root);
  const r = run(root, ['lifecycle', '--json']);
  assert.equal(r.status, 0);
  assert.equal(r.json.releaseMode, 'unknown');
  assert.equal(r.json.integrationRef, null);
});

test('service functions refuse bad input as usage errors', () => {
  const root = path.join(scratch.dir, `usage-${counter += 1}`);
  fs.mkdirSync(root);
  assert.throws(() => initFeature({ root }), FollowupUsageError);
  assert.throws(() => initFeature({ root, slug: 'a/b' }), FollowupUsageError);
  assert.throws(() => featureStatus({ root }), FollowupUsageError);
  assert.throws(() => featureStatus({ root, slug: '..' }), FollowupUsageError);
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', 'ok'), { recursive: true });
  assert.throws(() => initFeature({ root, slug: 'ok', take: 'nope' }), FollowupUsageError);
});
