'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo, featureBranch, FIXTURES, twoReleases, failingGit, SLUG, TRACKED_AT } = require('../helper/lifecycle-git-fixtures');
const store = require('../../src/runtime/lifecycle/event-store');
const { buildOverview, featureStatus } = require('../../src/runtime/lifecycle/overview');
const { addFollowups, takeFollowups, loadFollowups, FollowupUsageError } = require('../../src/runtime/lifecycle/followup');
const { releaseFeatures, recordMerged } = require('../../src/runtime/lifecycle/release');
const { readGitFacts } = require('../../src/runtime/lifecycle/status');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const scratch = createScratch('doflow-release-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

// A fixed clock after every fixture date: the fold leaves out events dated over 24 hours ahead of it (DEC-045).
const CLOCK = new Date('2027-01-01T00:00:00.000Z');
const track = (repo, slug, at = TRACKED_AT) => assert.ok(store.appendEvents(repo.dir, [{ type: 'feature.tracked', by: 'agent', data: { slug } }], { now: new Date(at) }).ok);
const release = (repo, options) => releaseFeatures({ root: repo.dir, now: CLOCK, ...options });
const eventFiles = (repo) => { try { return fs.readdirSync(path.join(repo.dir, store.EVENTS_REL)).sort(); } catch { return []; } };
const slugsOf = (result) => result.candidates.map((c) => c.slug);
const firstCommit = (repo) => repo.git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0];

function run(cwd, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: scratch.env(), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// ── the worked example (IC-020), steps 0 to 7 ──────────────────────────────────────────────────

test('worked example: a release finishes what it shipped, steps 0 to 7', () => {
  const repo = makeRepo(scratch, 'worked-example');
  repo.git('tag', 'v1.13.0', firstCommit(repo));
  const [s046, s047, s048] = ['046-lifecycle-loop', '047-api-cache', '048-api-auth'];
  track(repo, s046, '2026-10-03T09:00:00.000Z');
  track(repo, s047, '2026-10-04T09:00:00.000Z');
  track(repo, s048, '2026-10-05T09:00:00.000Z');
  const added = addFollowups({ root: repo.dir, items: [{ statement: 'a deferral' }], defaults: { stage: 'review', slug: s046 }, now: new Date('2026-10-03T10:00:00.000Z') });
  const fu = added.created[0].id;
  assert.equal(takeFollowups({ root: repo.dir, ids: fu, slug: s046, now: new Date('2026-10-03T11:00:00.000Z') }).ok, true);
  const buckets = () => buildOverview({ root: repo.dir, now: CLOCK }).features;
  const fuState = () => loadFollowups(repo.dir, { now: CLOCK }).followups.find((i) => i.id === fu).state;

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
  assert.deepEqual(event.data.features.map((f) => f.slug), [s046, s047]);
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
  const slugs = ['060-a', '061-b'];
  for (const slug of slugs) { track(repo, slug); repo.mergeNoFf(featureBranch(repo, slug, 1)); }
  repo.tag('v1.0.0');
  const first = releaseFeatures({ root: repo.dir, tag: 'v1.0.0', confirm: true, exclude: [slugs[1]], now: new Date('2026-10-10T00:00:00.000Z') });
  assert.deepEqual(first.candidates.map((c) => c.slug), slugs);
  const second = releaseFeatures({ root: repo.dir, tag: 'v1.0.0', confirm: true, features: [slugs[1]], now: new Date('2026-10-11T00:00:00.000Z') });
  assert.equal(second.recorded, true);
  const fold = store.readFold(repo.dir, { now: CLOCK });
  assert.equal(fold.releases.length, 1);
  assert.deepEqual(fold.releases[0].features.map((f) => f.slug), [slugs[0]]);
  assert.deepEqual(fold.releases[0].excluded, [slugs[1]]);
});

test('G1: a feature a record excluded is still offered by the next release; only a record, another tag or no evidence drops a candidate', () => {
  const repo = makeRepo(scratch, 'g1');
  const [x, y, z] = ['050-x', '051-y', '052-z'];
  for (const slug of [x, y, z]) track(repo, slug);
  repo.mergeNoFf(featureBranch(repo, x, 1));
  repo.mergeNoFf(featureBranch(repo, y, 1));
  repo.tag('v1.0.0');
  const first = releaseFeatures({ root: repo.dir, tag: 'v1.0.0', confirm: true, exclude: [x], now: new Date('2026-10-05T00:00:00.000Z') });
  assert.deepEqual(first.candidates.map((c) => c.slug), [x, y]);
  repo.mergeNoFf(featureBranch(repo, z, 1));
  repo.tag('v2.0.0');
  const out = release(repo, { tag: 'v2.0.0' });
  assert.equal(out.previousTag, 'v1.0.0');
  assert.deepEqual(slugsOf(out), [x, z], '050-x is not recorded as released and has evidence; 051-y is named by the v1.0.0 record');
  assert.deepEqual(out.notDetected, []);
});

test('G1: a non-release v* tag (vnext) is never the previous tag and never drops a candidate', () => {
  const repo = makeRepo(scratch, 'g1-vnext');
  const [a, b] = ['053-a', '054-b'];
  track(repo, a); track(repo, b);
  repo.mergeNoFf(featureBranch(repo, a, 1));
  repo.tag('v1.0.0');
  repo.mergeNoFf(featureBranch(repo, b, 1));
  repo.tag('vnext');
  assert.equal(readGitFacts(repo.dir).base_tag, 'vnext', 'git-state itself proposes the non-release tag as its base');
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

// ── lifecycle --action merged (IC-021) ─────────────────────────────────────────────────────────

test('merged: a fast-forward leaves no evidence; one confirmation event makes it confirmed, once', () => {
  const { repo } = FIXTURES.fastForward(scratch);
  track(repo, SLUG);
  assert.equal(featureStatus({ root: repo.dir, slug: SLUG, now: CLOCK }).status, 'in-progress');
  const before = eventFiles(repo).length;
  const out = recordMerged({ root: repo.dir, slug: SLUG, reason: 'fast-forwarded by hand', channel: 'question', now: new Date('2026-10-02T00:00:00.000Z') });
  assert.deepEqual([out.ok, out.status, out.evidence], [true, 'finished', { kind: 'confirmed', ref: null }]);
  assert.equal(eventFiles(repo).length, before + 1);
  const event = JSON.parse(fs.readFileSync(path.join(repo.dir, out.events[0]), 'utf8'));
  assert.deepEqual([event.type, event.by, event.data], ['feature.merged', 'user', { slug: SLUG, reason: 'fast-forwarded by hand' }]);
  const again = recordMerged({ root: repo.dir, slug: SLUG, reason: 'again', now: CLOCK });
  assert.deepEqual([again.ok, again.finding], [false, 'already-merged']);
  assert.equal(eventFiles(repo).length, before + 1);
});

test('merged: a merge with evidence is already-merged, an untracked slug is refused, a missing reason is a usage error', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  track(repo, SLUG);
  assert.equal(recordMerged({ root: repo.dir, slug: SLUG, reason: 'x', now: CLOCK }).finding, 'already-merged');
  assert.equal(recordMerged({ root: repo.dir, slug: '999-none', reason: 'x', now: CLOCK }).finding, 'untracked-feature');
  assert.throws(() => recordMerged({ root: repo.dir, slug: SLUG, now: CLOCK }), FollowupUsageError);
  assert.throws(() => recordMerged({ root: repo.dir, slug: SLUG, reason: 'bad‮reason', now: CLOCK }), FollowupUsageError);
});

test('a confirmed merge is a release candidate with evidence `confirmed`', () => {
  const { repo } = FIXTURES.fastForward(scratch);
  track(repo, SLUG);
  repo.tag('v1.0.0');
  assert.deepEqual(release(repo, { tag: 'v1.0.0' }).notDetected, [SLUG]);
  assert.equal(recordMerged({ root: repo.dir, slug: SLUG, reason: 'ff', now: new Date('2026-10-02T00:00:00.000Z') }).ok, true);
  assert.deepEqual(release(repo, { tag: 'v1.0.0' }).candidates, [{ slug: SLUG, evidence: 'confirmed', ref: null }]);
});

// ── the verb ───────────────────────────────────────────────────────────────────────────────────

test('the verb: --tag, --feature and --exclude in space and = spellings, exit codes and flag scoping', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  repo.dir = fs.realpathSync(repo.dir);
  track(repo, SLUG);
  const bad = run(repo.dir, ['lifecycle', '--action', 'release', '--tag', '1.0', '--json']);
  assert.equal(bad.status, 2);
  assert.equal(bad.json.status, 'USAGE');
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'release', '--json']).status, 2, '--tag is required');
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'overview', '--confirm', '--json']).status, 2, '--confirm belongs to release');
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'status', '--slug', SLUG, '--reason', 'x', '--json']).status, 2, '--reason belongs to merged');

  const preview = run(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--exclude=other', '--feature', 'nope', '--json']);
  assert.equal(preview.status, 1);
  assert.equal(preview.json.finding, 'untracked-feature');
  const ok = run(repo.dir, ['lifecycle', '--action', 'release', '--tag=v1.0.0', '--feature', SLUG, '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([ok.json.recorded, ok.json.added, ok.json.bound], [false, [SLUG], 'develop']);
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--confirm', '--json']).json.finding, 'tag-missing');
  repo.tag('v1.0.0');
  const done = run(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--confirm', '--channel', 'question', '--json']);
  assert.deepEqual([done.status, done.json.recorded], [0, true]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo.dir, done.json.events[0]), 'utf8')).by, 'user');
  assert.match(run(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0']).stdout, /^preview of release v1\.0\.0/);
});

test('the verb: merged through the CLI, and lifecycle refuses -g for the new actions as before', () => {
  const { repo } = FIXTURES.fastForward(scratch);
  repo.dir = fs.realpathSync(repo.dir);
  track(repo, SLUG);
  const out = run(repo.dir, ['lifecycle', '--action', 'merged', '--slug', SLUG, '--reason', 'fast-forwarded by hand', '--json']);
  assert.deepEqual([out.status, out.json.status], [0, 'finished']);
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'merged', '--slug', SLUG, '--reason', 'x', '--json']).status, 1);
  assert.equal(run(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '-g', '--json']).status, 2);
});

// ── review round: G2 .. G6 ─────────────────────────────────────────────────────────────────────

test('G2: a hotfix merged only into the tag\'s branch (develop is the integration ref) is a candidate, not notDetected', () => {
  const repo = makeRepo(scratch, 'g2-hotfix');
  const slug = '111-hot';
  track(repo, slug);
  repo.git('branch', 'main', 'develop');
  repo.checkout('-b', `feat/${slug}`, 'main');
  repo.commit('hotfix work');
  repo.mergeNoFf(`feat/${slug}`, 'main');
  repo.git('branch', '-q', '-D', `feat/${slug}`);
  repo.tag('v1.0.1');
  repo.checkout('develop');
  const out = release(repo, { tag: 'v1.0.1' });
  assert.equal(out.integrationRef, 'develop');
  assert.deepEqual(out.candidates.map((c) => [c.slug, c.evidence]), [[slug, 'merge-subject']]);
  assert.deepEqual(out.notDetected, []);
  assert.equal(releaseFeatures({ root: repo.dir, tag: 'v1.0.1', confirm: true, now: CLOCK }).recorded, true);
});

test('G2: the evidence uses the full merge commit, so a 7-character abbreviation that is ambiguous cannot misresolve it', () => {
  const { repo } = FIXTURES.deletedBranch(scratch);
  track(repo, SLUG);
  const { deriveStatuses } = require('../../src/runtime/lifecycle/status');
  const derived = deriveStatuses({ root: repo.dir, fold: store.readFold(repo.dir, { now: CLOCK }) });
  assert.match(derived.evidenceCommits[SLUG], /^[0-9a-f]{40}$/);
  assert.equal(derived.evidenceCommits[SLUG].slice(0, 7), derived.statuses[SLUG].evidence.ref);
  assert.equal(derived.integrationSha, repo.git('rev-parse', 'develop'));
});

for (const deleted of [false, true]) {
  test(`G3: a feature merged twice, first before the tag, is a candidate for that tag (git-flow: tag on main; ${deleted ? 'branch deleted: subject evidence' : 'branch kept: branch evidence'})`, () => {
    const repo = makeRepo(scratch, `g3-${deleted}`);
    const slug = '070-twice';
    track(repo, slug);
    const branch = featureBranch(repo, slug, 1);
    repo.mergeNoFf(branch);
    // The release is cut on main by merging develop; the feature's merge is then NOT on main's first-parent chain.
    repo.git('branch', 'main', 'develop~1');
    repo.mergeNoFf('develop', 'main');
    repo.tag('v1.0.0');
    repo.checkout(branch);
    repo.commit('more work after the release');
    repo.mergeNoFf(branch);
    if (deleted) repo.git('branch', '-q', '-D', branch);
    const out = release(repo, { tag: 'v1.0.0' });
    assert.equal(out.integrationRef, 'develop');
    assert.deepEqual(slugsOf(out), [slug]);
    assert.equal(out.candidates[0].evidence, deleted ? 'merge-subject' : 'branch');
    assert.deepEqual(out.notDetected, []);
  });
}

test('G3: a feature whose only merge is after the tag stays notDetected for that tag', () => {
  const repo = makeRepo(scratch, 'g3-after');
  const slug = '071-late';
  track(repo, slug);
  repo.commit('release content');
  repo.tag('v1.0.0');
  repo.mergeNoFf(featureBranch(repo, slug, 1));
  assert.deepEqual(release(repo, { tag: 'v1.0.0' }).notDetected, [slug]);
});

test('G4: the preview is bound to the commit the status view pinned, with the same ref name', () => {
  const repo = makeRepo(scratch, 'g4');
  track(repo, SLUG);
  const { deriveStatuses } = require('../../src/runtime/lifecycle/status');
  const derived = deriveStatuses({ root: repo.dir, fold: store.readFold(repo.dir, { now: CLOCK }) });
  assert.equal(derived.integrationRef, 'develop');
  assert.equal(derived.integrationSha, repo.git('rev-parse', 'develop'));
  const empty = deriveStatuses({ root: repo.dir, fold: { features: [], merged: [], releases: [] } });
  assert.equal(empty.integrationSha, derived.integrationSha, 'the pinned sha is reported with no tracked feature too');
  assert.equal(release(repo, { tag: 'v1.0.0' }).bound, 'develop');
});

test('G5: --exclude of an untracked slug is refused in the preview and on confirm, and nothing is written', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  track(repo, SLUG);
  repo.tag('v1.0.0');
  const before = eventFiles(repo);
  for (const confirm of [false, true]) {
    const out = release(repo, { tag: 'v1.0.0', exclude: ['999-typo'], confirm });
    assert.deepEqual([out.ok, out.finding], [false, 'untracked-feature']);
    assert.match(out.message, /999-typo.*excluded.*Nothing was written\.$/);
  }
  assert.deepEqual(eventFiles(repo), before);
  const cli = run(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--exclude', '999-typo', '--confirm', '--json']);
  assert.deepEqual([cli.status, cli.json.finding], [1, 'untracked-feature']);
});

test('G6: a candidate that is also excluded is printed as excluded only', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  repo.dir = fs.realpathSync(repo.dir);
  track(repo, SLUG);
  repo.tag('v1.0.0');
  const text = run(repo.dir, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--exclude', SLUG]).stdout;
  assert.match(text, new RegExp(`excluded: ${SLUG}`));
  assert.doesNotMatch(text, /ships /);
});

// ── a git failure is a refusal, not a crash ────────────────────────────────────────────────────

/** Runs `fn` with `extra` in this process's environment, then puts the environment back. */
function withEnv(extra, fn) {
  const saved = Object.fromEntries(Object.keys(extra).map((key) => [key, process.env[key]]));
  Object.assign(process.env, extra);
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test('a git failure while reading the history of X, or of the integration ref, refuses the preview with git-state-failed', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  repo.dir = fs.realpathSync(repo.dir);
  track(repo, SLUG);
  repo.tag('v1.0.0');
  repo.commit('after the tag');
  const tagSha = repo.git('rev-parse', 'v1.0.0^{commit}');
  const git = failingGit(scratch);
  const before = eventFiles(repo);
  for (const fail of [tagSha, 'any']) {
    const out = withEnv(git.env(fail), () => release(repo, { tag: 'v1.0.0' }));
    assert.deepEqual([out.ok, out.finding], [false, 'no-integration-ref'], `fail ${fail}`);
    assert.match(out.message, /git-state-failed.*rev-list.*Nothing was written\.$/);
  }
  const cli = spawnSync(process.execPath, [CLI, 'lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--json'], { cwd: repo.dir, env: { ...scratch.env(), ...git.env(tagSha) }, encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).finding, 'no-integration-ref');
  const merged = withEnv(git.env('any'), () => recordMerged({ root: repo.dir, slug: SLUG, reason: 'by hand', now: CLOCK }));
  assert.deepEqual([merged.ok, merged.finding], [false, 'no-integration-ref'], 'merged refuses too');
  assert.deepEqual(eventFiles(repo), before, 'nothing was written');
  assert.deepEqual(slugsOf(release(repo, { tag: 'v1.0.0' })), [SLUG], 'with a working git the same preview answers');
});
