'use strict';
// lifecycle-loop.e2e.test.js: feature 046 acceptance scenarios (requirement section 6), driven the
// way a user meets them: through this checkout's dispatcher `core/shared/scripts/doflow/bin/doflow-run`
// against scratch git repositories with real branches, merges and tags. One test per scenario, named
// with the scenario title and its story and requirement ids. Each asserts on what the verb printed and
// on what is on disk: the event files under .doflow/state/lifecycle, nothing staged, no commit, no tag
// and no ignore rule written (DEC-012, NFR-005).
//
// This file: US1 to US3 (follow-ups, finishing). Siblings: lifecycle-loop-capture (US4 to US7),
// lifecycle-loop-legacy (NFR-001). Shared helpers live in lifecycle-loop.shared.js.
//
// Needs no model and no network. Time: a feature is tracked at the wall-clock instant `lifecycle --action init`
// runs, and merge evidence only counts when it is committed at or after that instant (IC-021); every test moves the
// fixture clock to just after the newest tracking event, so nothing depends on the date it runs and nothing sleeps.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPO, SKIP, scratch, unique, rt, ok, eventsOf, newProject, folder, track, after10, mergeFeature, addFollowups, listFollowups, gitSnapshot, assertGitUntouched, tree, featureBranch,
} = require('./lifecycle-loop.shared.ts');

after(() => scratch.remove());

// ---------------------------------------------------------------------------------------------
// US1, US2: the follow-up list

describe('Scenario: Next feature starts from a follow-up (US1, FR-001, FR-002, FR-003)', { skip: SKIP }, () => {
  test('discovery shows both items with their source, the picked one is taken, and it is done when the feature finishes', () => {
    const repo = newProject('next-feature');
    const first = '050-first';
    const trackedFirst = track(repo, first);
    const [keep, pick] = addFollowups(repo, first, ['Validator misses a stale decision cited in a table cell', 'Retry the flaky export step']);
    const before = gitSnapshot(repo);
    folder(repo, '051-next');
    const filesBefore = tree(repo.dir);

    // Discovery: the first thing the new feature sees, before it asks anything.
    const overview = ok(repo.dir, ['lifecycle']);
    assert.equal(overview.mode, 'discovery');
    assert.equal(overview.followups.open, 2);
    assert.deepEqual(overview.followups.items.map((i: any) => i.id).sort(), [keep.id, pick.id].sort());
    for (const item of overview.followups.items) {
      assert.deepEqual(item.source, { kind: 'stage', feature: first, stage: 'review' }, 'each item shows where it came from');
      assert.equal(item.state, 'open');
    }
    assert.ok(overview.next.some((line: any) => line.includes('lifecycle --action init --slug <slug> --take')), 'the overview says how to take one');
    assert.deepEqual(tree(repo.dir), filesBefore, 'discovery is read-only');

    // The user picks one; the new feature takes it when its folder exists.
    const init = ok(repo.dir, ['lifecycle', '--action', 'init', '--slug', '051-next', '--take', pick.id]);
    assert.deepEqual([init.tracked, init.taken], ['new', [pick.id]]);
    const taken = listFollowups(repo, 'taken');
    assert.deepEqual(taken.map((i: any) => [i.id, i.takenBy]), [[pick.id, '051-next']]);
    assert.deepEqual(listFollowups(repo).map((i: any) => i.id), [keep.id], 'the other item stays open');

    // The feature merges; with no release in the project that finishes it, and its item with it.
    const trackedNext = eventsOf(repo).find((e: any) => e.type === 'feature.tracked' && e.data.slug === '051-next').at;
    after10(repo, trackedFirst, trackedNext);
    mergeFeature(repo, '051-next');
    const finished = ok(repo.dir, ['lifecycle']);
    assert.deepEqual(finished.features.finished, ['051-next']);
    assert.deepEqual(finished.features.inProgress, [first]);
    const done = listFollowups(repo, 'done');
    assert.deepEqual(done.map((i: any) => [i.id, i.state, i.takenBy]), [[pick.id, 'done', '051-next']]);
    assert.equal(ok(repo.dir, ['followup', '--action', 'list', '--state', 'taken']).count, 0);
    assertGitUntouched(repo, { ...before, head: repo.git('rev-parse', 'HEAD'), refs: repo.git('for-each-ref') });
  });
});

describe('Scenario: A deferral is recorded when it is decided (US2, FR-004)', { skip: SKIP }, () => {
  test('a review that leaves one finding unfixed and one item out of scope hands both to the list with the review stage as source', () => {
    const repo = newProject('deferral');
    const slug = '052-review-handoff';
    track(repo, slug);
    featureBranch(repo, slug, 1);
    const before = gitSnapshot(repo);
    const batch = path.join(scratch.dir, `${unique('review')}.json`);
    fs.writeFileSync(batch, JSON.stringify([
      { statement: 'Finding left unfixed on purpose: the export retries twice', stage: 'review', source: 'stage' },
      { statement: 'Out of scope: a rewrite of the report renderer', stage: 'review', source: 'stage' },
    ]));

    // No --slug: the feature comes from the branch the review ran on, as it does in a real handoff.
    const added = ok(repo.dir, ['followup', '--action', 'add', '--stage', 'review', '--batch', batch]);
    assert.equal(added.created.length, 2);
    assert.equal(added.events.length, 2);

    const items = listFollowups(repo);
    assert.equal(items.length, 2);
    for (const item of items) assert.deepEqual(item.source, { kind: 'stage', feature: slug, stage: 'review' });
    assert.deepEqual(items.map((i: any) => i.statement).sort(), [
      'Finding left unfixed on purpose: the export retries twice', 'Out of scope: a rewrite of the report renderer',
    ]);
    assert.equal(eventsOf(repo).filter((e: any) => e.type === 'followup.added').length, 2, 'both are events on disk, not prose');
    assertGitUntouched(repo, before);

    // The step is what the handoff guidance tells a stage to run (FR-004).
    const guidance = fs.readFileSync(path.join(REPO, 'core', 'shared', 'guidance', 'references', 'WORKFLOW_HANDOFF.md'), 'utf8');
    assert.match(guidance, /followup --action add --stage/);
  });
});

describe('Scenario: Promote to an intent (US1, FR-005)', { skip: SKIP }, () => {
  test('three related items promoted together give one intent that names all three, and each item shows it', () => {
    const repo = newProject('promote');
    const slug = '053-cart';
    track(repo, slug);
    const items = addFollowups(repo, slug, ['Cart total ignores a removed discount', 'Cart badge counts removed lines', 'Cart restore loses quantities']);
    const before = gitSnapshot(repo);
    const ids = items.map((i: any) => i.id);

    const promoted = ok(repo.dir, ['followup', '--action', 'promote', '--ids', ids.join(','), '--title', 'Cart robustness', '--channel', 'question']);
    assert.equal(promoted.intent, 'agent-docs/intent/cart-robustness.md');
    assert.deepEqual(promoted.ids.slice().sort(), ids.slice().sort());

    const intent = fs.readFileSync(path.join(repo.dir, promoted.intent), 'utf8');
    assert.match(intent, /^# Intent: Cart robustness/);
    assert.match(intent, /\*\*Raised by:\*\* user/);
    for (const item of items) assert.ok(intent.includes(`- ${item.id}: ${item.statement}`), `the intent names ${item.id} with its statement`);

    for (const item of listFollowups(repo)) {
      assert.equal(item.intent, promoted.intent, `${item.id} shows its intent`);
      assert.equal(item.state, 'open', 'a promoted item stays open');
    }
    const overview = ok(repo.dir, ['lifecycle']);
    assert.equal(overview.intents.length, 1);
    assert.equal(overview.intents[0].path, promoted.intent);
    assert.deepEqual(overview.intents[0].items.slice().sort(), ids.slice().sort());
    assert.ok(overview.followups.items.every((i: any) => i.promoted === true));

    // An intent is never overwritten: promoting under the same title is refused and writes nothing.
    const eventsBefore = eventsOf(repo).length;
    const again = rt(repo.dir, ['followup', '--action', 'promote', '--ids', ids[0], '--title', 'Cart robustness', '--json']);
    assert.equal(again.status, 1);
    assert.equal(again.json.finding, 'intent-exists');
    assert.equal(fs.readFileSync(path.join(repo.dir, promoted.intent), 'utf8'), intent);
    assert.equal(eventsOf(repo).length, eventsBefore);
    assertGitUntouched(repo, before);
  });
});

// ---------------------------------------------------------------------------------------------
// US3: finishing

describe('Scenario: Release finishes what it shipped (US3, FR-006, FR-007)', { skip: SKIP }, () => {
  test('the first feature is finished by the record, the second awaits release, and the item the first took is done', () => {
    const repo = newProject('release');
    const [shipped, later] = ['060-shipped', '061-later'];
    const at = [track(repo, shipped), track(repo, later)];
    const [item] = addFollowups(repo, shipped, ['Document the new export flag']);
    ok(repo.dir, ['followup', '--action', 'take', '--ids', item.id, '--slug', shipped]);
    after10(repo, ...at);
    mergeFeature(repo, shipped);
    repo.tag('v1.0.0');
    mergeFeature(repo, later); // merged after the release was cut
    const before = gitSnapshot(repo);

    // The preview names what the release shipped and writes nothing.
    const eventsBefore = eventsOf(repo).length;
    const preview = ok(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0']);
    assert.equal(preview.recorded, false);
    assert.deepEqual(preview.candidates.map((c: any) => [c.slug, c.evidence]), [[shipped, 'branch']]);
    assert.deepEqual(preview.notDetected, [later]);
    assert.deepEqual(preview.followupsDone, [item.id]);
    assert.equal(eventsOf(repo).length, eventsBefore, 'the preview writes nothing');

    const recorded = ok(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--confirm']);
    assert.equal(recorded.recorded, true);
    const record = eventsOf(repo).filter((e: any) => e.type === 'release.recorded');
    assert.equal(record.length, 1);
    assert.equal(record[0].data.tag, 'v1.0.0');
    assert.deepEqual(record[0].data.features.map((f: any) => f.slug), [shipped]);

    const overview = ok(repo.dir, ['lifecycle']);
    assert.equal(overview.releaseMode, 'tagged');
    assert.deepEqual(overview.features.finished, [shipped]);
    assert.deepEqual(overview.features.awaitingRelease, [later]);
    assert.deepEqual(overview.features.inProgress, []);
    assert.deepEqual(listFollowups(repo, 'done').map((i: any) => [i.id, i.state]), [[item.id, 'done']]);
    assert.equal(ok(repo.dir, ['lifecycle', '--action', 'status', '--slug', later]).status, 'awaiting-release');

    // The next release finishes the one that missed this one; the first stays finished.
    repo.tag('v1.1.0');
    const second = ok(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.1.0', '--confirm']);
    assert.deepEqual(second.candidates.map((c: any) => c.slug), [later]);
    const after = ok(repo.dir, ['lifecycle']);
    assert.deepEqual(after.features.finished.slice().sort(), [shipped, later].sort());
    assert.deepEqual(after.features.awaitingRelease, []);

    // DEC-021: recording a release writes no commit; only the tags this test cut exist.
    assert.equal(repo.git('rev-parse', 'HEAD'), before.head, 'no commit was made');
    assert.deepEqual(repo.git('tag').split('\n').sort(), ['v1.0.0', 'v1.1.0']);
    assert.equal(repo.git('diff', '--cached', '--name-only'), '');
  });
});

describe('Scenario: A project without releases (US3, FR-006)', { skip: SKIP }, () => {
  test('a merged feature is finished at the merge, and never awaits a release', () => {
    const repo = newProject('no-releases');
    const slug = '070-solo';
    const trackedAt = track(repo, slug);
    after10(repo, trackedAt);
    const branch = featureBranch(repo, slug, 1);
    repo.checkout('develop');
    assert.equal(ok(repo.dir, ['lifecycle', '--action', 'status', '--slug', slug]).status, 'in-progress', 'unmerged work is in progress');

    repo.mergeNoFf(branch);
    repo.git('branch', '-q', '-D', branch);
    const status = ok(repo.dir, ['lifecycle', '--action', 'status', '--slug', slug]);
    assert.equal(status.status, 'finished');
    assert.equal(status.evidence.kind, 'merge-subject', 'a deleted branch still finishes by its merge subject');
    const overview = ok(repo.dir, ['lifecycle']);
    assert.equal(overview.releaseMode, 'untagged');
    assert.deepEqual([overview.features.finished, overview.features.awaitingRelease], [[slug], []]);

    // A tag without the v prefix is not a release either.
    repo.tag('1.2.3');
    assert.equal(ok(repo.dir, ['lifecycle']).releaseMode, 'untagged');
  });
});

