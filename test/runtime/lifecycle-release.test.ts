'use strict';
// lifecycle-release.test.js: release and merged-evidence behaviour (features 046 to 047). This file: the worked
// example, the preview and record rules, the integration ref. Sibling: lifecycle-release-merged.test.js (the merged
// action, the verb, review round G2 to G6, git failures). Shared fixtures: lifecycle-release.shared.js.
const { test }: any = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  scratch, CLOCK, track, release, eventFiles, slugsOf, firstCommit, run, makeRepo, featureBranch, FIXTURES, twoReleases, SLUG, store, buildOverview, featureStatus, addFollowups, takeFollowups, loadFollowups, releaseFeatures, recordMerged, readGitFacts,
} = require('./lifecycle-release.shared.ts');

test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

// ── the worked example (IC-020), steps 0 to 7 ──────────────────────────────────────────────────

test('worked example: a release finishes what it shipped, steps 0 to 7', () => {
  const repo = makeRepo(scratch, 'worked-example');
  repo.git('tag', 'v1.13.0', firstCommit(repo));
  const [s046, s047, s048]: any = ['046-lifecycle-loop', '047-api-cache', '048-api-auth'];
  track(repo, s046, '2026-10-03T09:00:00.000Z');
  track(repo, s047, '2026-10-04T09:00:00.000Z');
  track(repo, s048, '2026-10-05T09:00:00.000Z');
  const added = addFollowups({ root: repo.dir, items: [{ statement: 'a deferral' }], defaults: { stage: 'review', slug: s046 }, now: new Date('2026-10-03T10:00:00.000Z') });
  const fu = added.created[0].id;
  assert.equal(takeFollowups({ root: repo.dir, ids: fu, slug: s046, now: new Date('2026-10-03T11:00:00.000Z') }).ok, true);
  const buckets = () => buildOverview({ root: repo.dir, now: CLOCK }).features;
  const fuState = () => loadFollowups(repo.dir, { now: CLOCK }).followups.find((i: any) => i.id === fu).state;

  // Step 0: all three in progress.
  const b1 = featureBranch(repo, s046); repo.at('2026-10-03T12:00:00.000Z');
  assert.deepEqual(buckets(), { finished: [], awaitingRelease: [], inProgress: [s046, s047, s048], unknown: [] });
  assert.equal(fuState(), 'taken');

  // Step 1: M1 and M2 merge into develop; 047's branch is deleted.
  repo.at('2026-10-06T10:00:00.000Z'); repo.mergeNoFf(b1);
  const b2 = featureBranch(repo, s047); repo.at('2026-10-07T10:00:00.000Z'); repo.mergeNoFf(b2); repo.git('branch', '-q', '-D', b2);
  const b3 = featureBranch(repo, s048); repo.checkout('develop');
  assert.deepEqual(buckets(), { finished: [], awaitingRelease: [s046, s047], inProgress: [s048], unknown: [] });

  // Step 2: the preview, before the tag exists: X is develop, nothing is written.
  const filesBefore = eventFiles(repo);
  const preview = release(repo, { tag: 'v1.14.0' });
  assert.deepEqual(
    [preview.ok, preview.recorded, preview.previousTag, preview.bound, preview.integrationRef],
    [true, false, 'v1.13.0', 'develop', 'develop'],
  );
  assert.deepEqual(preview.candidates, [
    { slug: s046, evidence: 'branch', ref: `feat/${s046}` },
    { slug: s047, evidence: 'merge-subject', ref: preview.candidates[1].ref },
  ]);
  assert.match(preview.candidates[1].ref, /^[0-9a-f]{7}$/);
  assert.deepEqual([preview.added, preview.excluded, preview.notDetected, preview.followupsDone], [[], [], [s048], [fu]]);
  assert.match(preview.next[0], /^After git tag v1\.14\.0: doflow-run lifecycle --action release --tag v1\.14\.0 --confirm/);
  assert.deepEqual(eventFiles(repo), filesBefore, 'a preview writes nothing');

  // Step 3: the ritual tags v1.14.0 at a commit containing M1 and M2. No record yet, so containment
  // in the tag being recorded would finish both on the overview, yet the release still lists them.
  repo.tag('v1.14.0');
  assert.deepEqual(buckets(), { finished: [s046, s047], awaitingRelease: [], inProgress: [s048], unknown: [] });
  assert.deepEqual(slugsOf(release(repo, { tag: 'v1.14.0' })), [s046, s047], 'containment in --tag is ignored when choosing candidates');

  // Step 4: M3 merges 048 after the tag. The release is unchanged.
  repo.at('2026-10-09T10:00:00.000Z'); repo.mergeNoFf(b3);
  const afterTag = release(repo, { tag: 'v1.14.0' });
  assert.equal(afterTag.bound, 'v1.14.0');
  assert.deepEqual(slugsOf(afterTag), [s046, s047]);
  assert.deepEqual(afterTag.notDetected, [s048], '048 is not an ancestor of the tag commit');

  // Step 5: confirm. One release.recorded event holds 046 and 047, excluded is empty.
  const tagSha = repo.git('rev-parse', 'v1.14.0^{commit}');
  const confirmed = releaseFeatures({ root: repo.dir, tag: 'v1.14.0', confirm: true, now: new Date('2026-10-10T09:00:00.000Z') });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.recorded, true);
  assert.equal(confirmed.events.length, 1);
  const event = JSON.parse(fs.readFileSync(path.join(repo.dir, confirmed.events[0]), 'utf8'));
  assert.equal(event.type, 'release.recorded');
  assert.deepEqual(event.data.features.map((f: any) => f.slug), [s046, s047]);
  assert.deepEqual([event.data.tag, event.data.commit, event.data.excluded], ['v1.14.0', tagSha, []]);

  // Step 6: 046 and 047 finished by the record; 048 awaiting release; the taken item is done.
  assert.deepEqual(buckets(), { finished: [s046, s047], awaitingRelease: [s048], inProgress: [], unknown: [] });
  assert.equal(featureStatus({ root: repo.dir, slug: s046, now: CLOCK }).release, 'v1.14.0');
  assert.equal(fuState(), 'done');

  // Step 7: v1.15.0 is recorded with 048; the earlier two keep their record.
  repo.tag('v1.15.0');
  const next = release(repo, { tag: 'v1.15.0' });
  assert.equal(next.previousTag, 'v1.14.0');
  assert.deepEqual(slugsOf(next), [s048]);
  assert.equal(releaseFeatures({ root: repo.dir, tag: 'v1.15.0', confirm: true, now: new Date('2026-10-20T09:00:00.000Z') }).recorded, true);
  assert.deepEqual(buckets(), { finished: [s046, s047, s048], awaitingRelease: [], inProgress: [], unknown: [] });
  assert.equal(featureStatus({ root: repo.dir, slug: s046, now: CLOCK }).release, 'v1.14.0');
});

// ── preview and record rules ───────────────────────────────────────────────────────────────────

test('a confirmed release is a local event: no commit, no staging, no ignore rule, and the tag must exist', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  track(repo, SLUG);
  repo.tag('v1.0.0');
  const head = repo.git('rev-parse', 'HEAD');
  const missing = release(repo, { tag: 'v9.9.9', confirm: true });
  assert.deepEqual([missing.ok, missing.finding], [false, 'tag-missing']);
  assert.match(missing.message, /Nothing was written\.$/);
  const recorded = release(repo, { tag: 'v1.0.0', confirm: true });
  assert.equal(recorded.recorded, true);
  assert.equal(repo.git('rev-parse', 'HEAD'), head);
  assert.equal(repo.git('diff', '--cached', '--name-only'), '');
  assert.equal(repo.git('status', '--porcelain'), '?? .doflow/');
  assert.equal(fs.existsSync(path.join(repo.dir, '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(repo.dir, '.git', 'info', 'exclude')) && /agent-docs/.test(fs.readFileSync(path.join(repo.dir, '.git', 'info', 'exclude'), 'utf8')), false);
  assert.deepEqual(eventFiles(repo).length, 2, 'the tracking event and the one record');
});

test('--feature adds a feature git cannot show, --exclude removes one; both land in the record', () => {
  const squash = FIXTURES.squash(scratch);
  const { repo } = squash;
  repo.git('branch', '-q', '-D', squash.branch);
  const merged = featureBranch(repo, '047-other', 1);
  repo.mergeNoFf(merged);
  track(repo, SLUG); track(repo, '047-other');
  repo.tag('v1.0.0');
  const preview = release(repo, { tag: 'v1.0.0', features: [SLUG], exclude: ['047-other'] });
  assert.deepEqual(slugsOf(preview), ['047-other']);
  assert.deepEqual([preview.added, preview.excluded, preview.notDetected], [[SLUG], ['047-other'], [SLUG]]);
  const done = release(repo, { tag: 'v1.0.0', features: [SLUG], exclude: ['047-other'], confirm: true });
  const event = JSON.parse(fs.readFileSync(path.join(repo.dir, done.events[0]), 'utf8'));
  assert.deepEqual(event.data.features, [{ slug: SLUG, evidence: 'confirmed', ref: null }]);
  assert.deepEqual(event.data.excluded, ['047-other']);
  const buckets = buildOverview({ root: repo.dir, now: CLOCK }).features;
  assert.deepEqual(buckets.finished, [SLUG]);
  assert.deepEqual(buckets.awaitingRelease, ['047-other']);
});

test('--feature for an untracked slug is refused in the preview too, and nothing is written', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  track(repo, SLUG);
  repo.tag('v1.0.0');
  const before = eventFiles(repo);
  for (const confirm of [false, true]) {
    const out = release(repo, { tag: 'v1.0.0', features: ['999-nope'], confirm });
    assert.deepEqual([out.ok, out.finding], [false, 'untracked-feature']);
  }
  assert.deepEqual(eventFiles(repo), before);
});

test('recording the same tag twice takes the union, and a slug in both lists is excluded', () => {
  const repo = makeRepo(scratch, 'twice');
  const slugs: any = ['060-a', '061-b'];
  for (const slug of slugs) { track(repo, slug); repo.mergeNoFf(featureBranch(repo, slug, 1)); }
  repo.tag('v1.0.0');
  const first = releaseFeatures({ root: repo.dir, tag: 'v1.0.0', confirm: true, exclude: [slugs[1]], now: new Date('2026-10-10T00:00:00.000Z') });
  assert.deepEqual(first.candidates.map((c: any) => c.slug), slugs);
  const second = releaseFeatures({ root: repo.dir, tag: 'v1.0.0', confirm: true, features: [slugs[1]], now: new Date('2026-10-11T00:00:00.000Z') });
  assert.equal(second.recorded, true);
  const fold = store.readFold(repo.dir, { now: CLOCK });
  assert.equal(fold.releases.length, 1);
  assert.deepEqual(fold.releases[0].features.map((f: any) => f.slug), [slugs[0]]);
  assert.deepEqual(fold.releases[0].excluded, [slugs[1]]);
});

test('G1: a feature a record excluded is still offered by the next release; only a record, another tag or no evidence drops a candidate', () => {
  const repo = makeRepo(scratch, 'g1');
  const [x, y, z]: any = ['050-x', '051-y', '052-z'];
  for (const slug of [x, y, z]) track(repo, slug);
  repo.mergeNoFf(featureBranch(repo, x, 1));
  repo.mergeNoFf(featureBranch(repo, y, 1));
  repo.tag('v1.0.0');
  const first = releaseFeatures({ root: repo.dir, tag: 'v1.0.0', confirm: true, exclude: [x], now: new Date('2026-10-05T00:00:00.000Z') });
  assert.deepEqual(first.candidates.map((c: any) => c.slug), [x, y]);
  repo.mergeNoFf(featureBranch(repo, z, 1));
  repo.tag('v2.0.0');
  const out = release(repo, { tag: 'v2.0.0' });
  assert.equal(out.previousTag, 'v1.0.0');
  assert.deepEqual(slugsOf(out), [x, z], '050-x is not recorded as released and has evidence; 051-y is named by the v1.0.0 record');
  assert.deepEqual(out.notDetected, []);
});

test('G1: a non-release v* tag (vnext) is never the previous tag and never drops a candidate', () => {
  const repo = makeRepo(scratch, 'g1-vnext');
  const [a, b]: any = ['053-a', '054-b'];
  track(repo, a); track(repo, b);
  repo.mergeNoFf(featureBranch(repo, a, 1));
  repo.tag('v1.0.0');
  repo.mergeNoFf(featureBranch(repo, b, 1));
  repo.tag('vnext');
  assert.equal(readGitFacts(repo.dir).base_tag, 'v1.0.0', 'git-state never proposes the non-release tag as its base');
  const out = release(repo, { tag: 'v2.0.0' });
  assert.equal(out.previousTag, 'v1.0.0');
  assert.deepEqual(slugsOf(out), [b], 'a is contained in the unrecorded v1.0.0; b merged before vnext is still offered');
});

test('containment in another v* tag with no record still finishes a feature, so it is not a candidate', () => {
  const { repo, early, late } = twoReleases(scratch);
  track(repo, early); track(repo, late);
  repo.tag('v1.1.0');
  const out = release(repo, { tag: 'v1.1.0' });
  assert.deepEqual(slugsOf(out), [late], 'early is inside v1.0.0, which has no record');
  assert.equal(out.previousTag, 'v1.0.0');
});

test('the first release of an untagged project lists merged features as candidates', () => {
  const { repo } = FIXTURES.noTag(scratch);
  track(repo, SLUG);
  const out = release(repo, { tag: 'v1.0.0' });
  assert.equal(out.previousTag, null);
  assert.deepEqual(slugsOf(out), [SLUG]);
  assert.equal(out.bound, 'develop');
  repo.tag('v1.0.0');
  assert.equal(releaseFeatures({ root: repo.dir, tag: 'v1.0.0', confirm: true, now: CLOCK }).recorded, true);
});

// ── the integration ref (DEC-044) ──────────────────────────────────────────────────────────────

test('preview and overview pin the same ref as do-git-state.sh: origin/develop before a local main', () => {
  const repo = makeRepo(scratch, 'ref-origin', { branch: 'main' });
  repo.git('update-ref', 'refs/remotes/origin/develop', repo.git('rev-parse', 'HEAD'));
  track(repo, SLUG);
  const facts = readGitFacts(repo.dir);
  assert.equal(facts.integration_ref, 'origin/develop');
  const preview = release(repo, { tag: 'v1.0.0' });
  assert.equal(preview.integrationRef, facts.integration_ref);
  assert.equal(preview.bound, facts.integration_ref);
  assert.equal(buildOverview({ root: repo.dir, now: CLOCK }).integrationRef, facts.integration_ref);
});

test('a main-only repository previews against main', () => {
  const repo = makeRepo(scratch, 'ref-main', { branch: 'main' });
  track(repo, SLUG);
  assert.equal(release(repo, { tag: 'v1.0.0' }).bound, 'main');
});

test('a repository with no integration ref refuses the preview, the record and merged', () => {
  const repo = makeRepo(scratch, 'ref-none', { branch: 'trunk' });
  track(repo, SLUG);
  for (const out of [release(repo, { tag: 'v1.0.0' }), release(repo, { tag: 'v1.0.0', confirm: true }), recordMerged({ root: repo.dir, slug: SLUG, reason: 'by hand', now: CLOCK })]) {
    assert.deepEqual([out.ok, out.finding], [false, 'no-integration-ref']);
    assert.match(out.message, /Nothing was written\.$/);
  }
});

