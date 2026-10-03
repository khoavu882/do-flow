'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo, featureBranch, FIXTURES, SLUG, TRACKED_AT } = require('../helper/lifecycle-git-fixtures');
const { foldEvents } = require('../../src/runtime/lifecycle/fold');
const store = require('../../src/runtime/lifecycle/event-store');
const { deriveStatuses, readGitFacts, resolveGitStateHelper, bucketize, subjectNames, behindNote } = require('../../src/runtime/lifecycle/status');

const scratch = createScratch('doflow-status-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

let seq = 0;
function ev(type, data, at) {
  seq += 1;
  const stamp = new Date(at).toISOString().replace(/[-:.]/g, '');
  return { v: 1, id: `${stamp}-${seq.toString(36).padStart(6, '0').replace(/[ilou]/g, 'x')}`, type, at: new Date(at).toISOString(), by: 'agent', data };
}
const tracked = (slug = SLUG, at = TRACKED_AT) => ev('feature.tracked', { slug }, at);
const record = (tag, features, excluded = [], at = '2026-10-20T00:00:00.000Z') => ev('release.recorded', { tag, commit: 'c', features: features.map((slug) => ({ slug, evidence: 'branch', ref: 'r' })), excluded }, at);
// A fixed clock after every fixture date: the fold leaves out events dated over 24 hours ahead of it (DEC-045).
const CLOCK = new Date('2027-01-01T00:00:00.000Z');
const foldOf = (...events) => foldEvents(events, { now: CLOCK });

function derive(repo, fold, facts) {
  return deriveStatuses({ root: repo.dir, fold, facts });
}
function statusOf(repo, fold, slug = SLUG) { return derive(repo, fold).statuses[slug]; }
const firstCommit = (repo) => repo.git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0];

// ── the ten IC-021 evidence fixtures ───────────────────────────────────────────────────────────

test('fixture: a merge commit from feat/<s> is `branch` evidence, then finished once a record names it', () => {
  const { repo, branch } = FIXTURES.mergeCommit(scratch);
  repo.git('tag', 'v1.0.0', firstCommit(repo));
  const awaiting = derive(repo, foldOf(tracked()));
  assert.equal(awaiting.releaseMode, 'tagged');
  assert.deepEqual(awaiting.statuses[SLUG], { status: 'awaiting-release', evidence: { kind: 'branch', ref: branch }, release: null });
  assert.deepEqual(awaiting.features.awaitingRelease, [SLUG]);
  const finished = derive(repo, foldOf(tracked(), record('v1.1.0', [SLUG])));
  assert.deepEqual(finished.statuses[SLUG], { status: 'finished', evidence: { kind: 'branch', ref: branch }, release: 'v1.1.0' });
});

test('fixture: a squash merge with the branch kept leaves no evidence and is notDetected', () => {
  const { repo } = FIXTURES.squash(scratch);
  const out = derive(repo, foldOf(tracked()));
  assert.equal(out.statuses[SLUG].status, 'in-progress');
  assert.equal(out.statuses[SLUG].evidence, null);
  assert.deepEqual(out.notDetected, [SLUG]);
});

test('fixture: rebase then fast-forward leaves no evidence', () => {
  const { repo } = FIXTURES.rebaseFastForward(scratch);
  const out = derive(repo, foldOf(tracked()));
  assert.equal(out.statuses[SLUG].status, 'in-progress');
  assert.deepEqual(out.notDetected, [SLUG]);
});

test('fixture: a fast-forward of a branch with commits leaves no evidence; lifecycle merged makes it confirmed', () => {
  const { repo } = FIXTURES.fastForward(scratch);
  assert.equal(statusOf(repo, foldOf(tracked())).status, 'in-progress');
  const confirmed = statusOf(repo, foldOf(tracked(), ev('feature.merged', { slug: SLUG, reason: 'fast-forwarded by hand' }, '2026-10-02T00:00:00.000Z')));
  assert.deepEqual(confirmed, { status: 'finished', evidence: { kind: 'confirmed', ref: null }, release: null });
});

test('fixture: a feature branch with no commits, created from develop, is in-progress even after other merges', () => {
  const { repo } = FIXTURES.emptyBranch(scratch);
  const out = derive(repo, foldOf(tracked(), tracked('047-other')));
  assert.equal(out.statuses[SLUG].status, 'in-progress');
  assert.equal(out.statuses['047-other'].status, 'finished');
  assert.equal(out.statuses['047-other'].evidence.kind, 'branch');
});

test('fixture: a cherry-pick onto develop leaves no evidence', () => {
  const { repo } = FIXTURES.cherryPick(scratch);
  const out = derive(repo, foldOf(tracked()));
  assert.equal(out.statuses[SLUG].status, 'in-progress');
  assert.deepEqual(out.notDetected, [SLUG]);
});

test('fixture: commits made before tracking and merged after it are `branch` evidence', () => {
  const { repo, branch } = FIXTURES.committedBeforeTracking(scratch);
  assert.deepEqual(statusOf(repo, foldOf(tracked())).evidence, { kind: 'branch', ref: branch });
});

test('fixture: a branch deleted after a merge whose subject names the slug is `merge-subject` evidence', () => {
  const { repo } = FIXTURES.deletedBranch(scratch);
  const entry = statusOf(repo, foldOf(tracked()));
  assert.equal(entry.status, 'finished', 'untagged: finished at merge');
  assert.equal(entry.evidence.kind, 'merge-subject');
  assert.match(entry.evidence.ref, /^[0-9a-f]{7}$/);
});

test('fixture: no v* tag and a merge commit present: untagged, finished at merge', () => {
  const { repo } = FIXTURES.noTag(scratch);
  const out = derive(repo, foldOf(tracked()));
  assert.equal(out.releaseMode, 'untagged');
  assert.equal(out.statuses[SLUG].status, 'finished');
  assert.deepEqual(out.notDetected, []);
});

test('fixture: only a 1.2.3 tag counts as no release: untagged, finished at merge', () => {
  const { repo } = FIXTURES.nonVTag(scratch);
  const out = derive(repo, foldOf(tracked()));
  assert.equal(out.releaseMode, 'untagged');
  assert.equal(out.statuses[SLUG].status, 'finished');
});

// ── evidence rules ─────────────────────────────────────────────────────────────────────────────

test('a merge committed before the feature was tracked is not evidence', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  const later = foldOf(tracked(SLUG, '2026-12-01T00:00:00.000Z'));
  assert.equal(statusOf(repo, later).status, 'in-progress');
});

test('a 2030-dated event file does not move the tracking bound or turn a later merge into in-progress', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  const events = path.join(repo.dir, store.EVENTS_REL);
  fs.mkdirSync(events, { recursive: true });
  const at = '2030-01-01T00:00:00.000Z';
  const id = `${at.replace(/[-:.]/g, '')}-aaaaaa`;
  fs.writeFileSync(path.join(events, `${id}.json`), JSON.stringify({ v: 1, id, type: 'followup.added', at, by: 'agent', data: { id: 'FU-aaaaaa', statement: 'wrong clock', source: { kind: 'manual' } } }));
  const trackedBefore = new Date(TRACKED_AT);
  store.appendEvents(repo.dir, [{ type: 'feature.tracked', by: 'agent', data: { slug: SLUG } }], { now: trackedBefore });
  const fold = store.readFold(repo.dir, { now: CLOCK });
  assert.equal(fold.features[0].trackedAt, trackedBefore.toISOString());
  assert.equal(derive(repo, fold).statuses[SLUG].status, 'finished');
});

test('the lower bound is floored to the second, so a same-second merge counts', () => {
  const repo = makeRepo(scratch, 'same-second');
  const branch = featureBranch(repo);
  repo.at('2026-10-02T10:00:00.000Z');
  repo.mergeNoFf(branch); // the clock moves 60 s first; pin the merge date explicitly instead
  const mergeSecond = Number(repo.git('log', '-1', '--format=%ct'));
  const trackedAt = new Date(mergeSecond * 1000 + 900).toISOString();
  assert.equal(statusOf(repo, foldOf(tracked(SLUG, trackedAt))).status, 'finished');
  const after = new Date(mergeSecond * 1000 + 1000).toISOString();
  assert.equal(statusOf(repo, foldOf(tracked(SLUG, after))).status, 'in-progress');
});

test('a remote-tracking branch is evidence after the local branch is deleted; the feature/ prefix counts', () => {
  const repo = makeRepo(scratch, 'remote-branch');
  const branch = featureBranch(repo, SLUG, 2, 'feature');
  const tip = repo.git('rev-parse', 'HEAD');
  repo.mergeNoFf(branch);
  repo.git('update-ref', `refs/remotes/origin/${branch}`, tip);
  repo.git('branch', '-q', '-D', branch);
  const entry = statusOf(repo, foldOf(tracked()));
  assert.deepEqual(entry.evidence, { kind: 'branch', ref: `origin/${branch}` });
});

test('a later unrelated merge whose second parent contains the tip does not move the evidence', () => {
  const repo = makeRepo(scratch, 'later-merge');
  const branch = featureBranch(repo);
  repo.mergeNoFf(branch);
  const other = featureBranch(repo, '047-other');
  repo.mergeNoFf(other);
  assert.equal(statusOf(repo, foldOf(tracked(), tracked('047-other'))).evidence.ref, branch);
});

test('many merges: each branch finds its own introducing merge, and an unmerged one finds none', () => {
  const repo = makeRepo(scratch, 'many-merges');
  const slugs = ['101-a', '102-b', '103-c', '104-d', '105-e', '106-f', '107-g'];
  for (const slug of slugs) repo.mergeNoFf(featureBranch(repo, slug, 1));
  const unmerged = featureBranch(repo, '108-h', 1);
  repo.checkout('develop');
  repo.git('branch', '-q', '-D', ...slugs.map((s) => `feat/${s}`).filter((_, i) => i % 2 === 0)); // some branches deleted: subject evidence
  const out = derive(repo, foldOf(...[...slugs, '108-h'].map((slug) => tracked(slug))));
  assert.deepEqual(slugs.map((slug) => out.statuses[slug].status), slugs.map(() => 'finished'));
  assert.deepEqual(slugs.map((slug) => out.statuses[slug].evidence.kind), ['merge-subject', 'branch', 'merge-subject', 'branch', 'merge-subject', 'branch', 'merge-subject']);
  assert.equal(out.statuses['108-h'].status, 'in-progress');
  assert.equal(unmerged, 'feat/108-h');
});

test('subject evidence needs the slug bounded by characters outside [a-z0-9-]', () => {
  assert.equal(subjectNames("Merge branch 'feat/046-demo' into develop", '046-demo'), true);
  assert.equal(subjectNames('046-demo', '046-demo'), true);
  assert.equal(subjectNames('Merge 046-demo-extra into develop', '046-demo'), false);
  assert.equal(subjectNames('Merge x046-demo into develop', '046-demo'), false);
  assert.equal(subjectNames('Merge pr#12 (046-demo).', '046-demo'), true);
});

// ── tagged mode and containment (DEC-030) ──────────────────────────────────────────────────────

test('a merge inside a v* tag with no record finishes the feature; a record that does not name it does not', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  repo.tag('v1.1.0');
  const contained = derive(repo, foldOf(tracked()));
  assert.deepEqual(contained.statuses[SLUG].status, 'finished');
  assert.equal(contained.statuses[SLUG].release, 'v1.1.0');
  const recordedElsewhere = derive(repo, foldOf(tracked(), record('v1.1.0', ['099-other'])));
  assert.equal(recordedElsewhere.statuses[SLUG].status, 'awaiting-release');
  const excluded = derive(repo, foldOf(tracked(), record('v1.1.0', [], [SLUG])));
  assert.equal(excluded.statuses[SLUG].status, 'awaiting-release');
});

test('worked example: release finishes what it shipped (requirement scenario, IC-020)', () => {
  const repo = makeRepo(scratch, 'worked-example');
  repo.git('tag', 'v1.13.0', firstCommit(repo));
  const slugs = ['046-lifecycle-loop', '047-api-cache', '048-api-auth'];
  const folds = (...extra) => foldOf(tracked(slugs[0], '2026-10-03T09:00:00.000Z'), tracked(slugs[1], '2026-10-04T09:00:00.000Z'), tracked(slugs[2], '2026-10-05T09:00:00.000Z'), ...extra);
  const st = (fold) => Object.fromEntries(Object.entries(derive(repo, fold).statuses).map(([k, v]) => [k, v.status]));
  // Step 0: all in progress.
  const b1 = featureBranch(repo, slugs[0]); repo.at('2026-10-03T12:00:00.000Z');
  assert.deepEqual(st(folds()), { [slugs[0]]: 'in-progress', [slugs[1]]: 'in-progress', [slugs[2]]: 'in-progress' });
  // Step 1: M1 and M2 merge; 047's branch is deleted.
  repo.at('2026-10-06T10:00:00.000Z'); repo.mergeNoFf(b1);
  repo.checkout('develop');
  const b2 = featureBranch(repo, slugs[1]); repo.at('2026-10-07T10:00:00.000Z'); repo.mergeNoFf(b2); repo.git('branch', '-q', '-D', b2);
  const b3 = featureBranch(repo, slugs[2]); repo.checkout('develop');
  assert.deepEqual(st(folds()), { [slugs[0]]: 'awaiting-release', [slugs[1]]: 'awaiting-release', [slugs[2]]: 'in-progress' });
  // Step 3: v1.14.0 cut at a commit containing M1 and M2, no record yet: containment finishes both.
  repo.tag('v1.14.0');
  assert.deepEqual(st(folds()), { [slugs[0]]: 'finished', [slugs[1]]: 'finished', [slugs[2]]: 'in-progress' });
  // Step 4: M3 after the tag.
  repo.at('2026-10-09T10:00:00.000Z'); repo.mergeNoFf(b3);
  // Step 6: the record names 046 and 047; 048 is merged into develop, the tag has a record that does not name it.
  const recorded = folds(record('v1.14.0', slugs.slice(0, 2)));
  assert.deepEqual(st(recorded), { [slugs[0]]: 'finished', [slugs[1]]: 'finished', [slugs[2]]: 'awaiting-release' });
  assert.equal(derive(repo, recorded).statuses[slugs[0]].release, 'v1.14.0');
  // Step 7: v1.15.0 recorded with 048.
  repo.tag('v1.15.0');
  assert.deepEqual(st(folds(record('v1.14.0', slugs.slice(0, 2)), record('v1.15.0', [slugs[2]]))), { [slugs[0]]: 'finished', [slugs[1]]: 'finished', [slugs[2]]: 'finished' });
});

// ── the integration ref and unknown (DEC-029) ──────────────────────────────────────────────────

test('integration ref: develop, else main, else master, else origin/HEAD', () => {
  const facts = (repo) => readGitFacts(repo.dir);
  const withBranches = (name, branches) => {
    const repo = makeRepo(scratch, name, { branch: branches[0] });
    for (const b of branches.slice(1)) repo.git('branch', b);
    return repo;
  };
  assert.equal(facts(withBranches('ref-develop', ['main', 'develop', 'master'])).integration_ref, 'develop');
  assert.equal(facts(withBranches('ref-main', ['main', 'master'])).integration_ref, 'main');
  assert.equal(facts(withBranches('ref-master', ['master'])).integration_ref, 'master');
  const trunk = withBranches('ref-trunk', ['trunk']);
  assert.equal(facts(trunk).integration_ref, null);
  trunk.git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  trunk.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  assert.equal(facts(trunk).integration_ref, 'origin/HEAD');
  const remoteOnly = withBranches('ref-remote-develop', ['trunk']);
  remoteOnly.git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  assert.equal(facts(remoteOnly).integration_ref, 'origin/develop');
});

test('a repository with no integration ref, and a directory that is not a repository, derive unknown', () => {
  const repo = makeRepo(scratch, 'no-integration', { branch: 'trunk' });
  const out = derive(repo, foldOf(tracked()));
  assert.equal(out.releaseMode, 'unknown');
  assert.equal(out.statuses[SLUG].status, 'unknown');
  assert.match(out.reason, /no integration ref/);
  assert.deepEqual(out.features.unknown, [SLUG]);

  const plain = path.join(scratch.dir, 'not-a-repo');
  fs.mkdirSync(plain);
  const none = derive({ dir: plain }, foldOf(tracked()));
  assert.equal(none.releaseMode, 'unknown');
  assert.equal(none.statuses[SLUG].status, 'unknown');
  assert.match(none.reason, /git facts unavailable|no integration ref/);
});

test('a local integration branch behind its origin counterpart is reported with a count and a note, without a fetch (DEC-044)', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  assert.equal(derive(repo, foldOf(tracked())).integrationBehind, 0);
  repo.checkout('-b', 'remote-side', 'develop');
  repo.commit('only on origin 1');
  repo.commit('only on origin 2');
  repo.git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  repo.checkout('develop');
  repo.git('branch', '-q', '-D', 'remote-side');
  const out = derive(repo, foldOf(tracked()));
  assert.equal(out.integrationBehind, 2);
  assert.equal(out.integrationRef, 'develop', 'the local branch stays the pinned ref');
  assert.equal(behindNote('develop', 2), 'local develop is 2 commits behind origin/develop; a merge that exists only on origin is not seen until you pull');
  assert.match(behindNote('develop', 1), /1 commit behind/);
  assert.equal(behindNote('develop', 0), null);
  assert.equal(derive(repo, foldOf()).integrationBehind, 2, 'also with no tracked feature');
});

test('with no tracked feature the deriver answers the release mode without reading history', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  const out = derive(repo, foldOf());
  assert.equal(out.releaseMode, 'untagged');
  assert.deepEqual(out.statuses, {});
  assert.equal(out.integrationRef, 'develop');
});

test('bucketize groups slugs by status', () => {
  const statuses = { a: { status: 'finished' }, b: { status: 'awaiting-release' }, c: { status: 'in-progress' }, d: { status: 'unknown' }, e: { status: 'finished' } };
  assert.deepEqual(bucketize(statuses), { finished: ['a', 'e'], awaitingRelease: ['b'], inProgress: ['c'], unknown: ['d'] });
  assert.deepEqual(bucketize(statuses, ['c', 'zz']), { finished: [], awaitingRelease: [], inProgress: ['c'], unknown: [] });
});

test('deriving statuses changes nothing in the repository', () => {
  const { repo } = FIXTURES.mergeCommit(scratch);
  const before = [repo.git('rev-parse', 'HEAD'), repo.git('status', '--porcelain'), repo.git('for-each-ref')].join('|');
  derive(repo, foldOf(tracked()));
  assert.equal([repo.git('rev-parse', 'HEAD'), repo.git('status', '--porcelain'), repo.git('for-each-ref')].join('|'), before);
});

test('git-state --lifecycle reports the base tag the release ritual uses', () => {
  const repo = makeRepo(scratch, 'base-tag');
  repo.git('tag', 'v1.0.0', firstCommit(repo));
  repo.tag('v1.1.0');
  repo.tag('1.9.9');
  const out = JSON.parse(execFileSync('bash', [path.join(__dirname, '../../core/shared/scripts/doflow/bash/do-git-state.sh'), '--lifecycle'], { cwd: repo.dir, encoding: 'utf8', env: scratch.env() }));
  assert.equal(out.base_tag, 'v1.1.0');
  assert.deepEqual(out.release_tags, ['v1.0.0', 'v1.1.0']);
  assert.deepEqual(out.feature_prefixes, ['feat', 'feature']);
  assert.equal(out.integration_ref, 'develop');
});

// ── the release preview's inputs (review round G2, G4) ─────────────────────────────────────────

test('the result carries the pinned integration sha and the full merge commit of each evidence, beside the unchanged fields', () => {
  const { repo, branch } = FIXTURES.mergeCommit(scratch);
  const out = derive(repo, foldOf(tracked()));
  assert.equal(out.integrationSha, repo.git('rev-parse', 'develop'));
  assert.match(out.evidenceCommits[SLUG], /^[0-9a-f]{40}$/);
  assert.equal(out.evidenceCommits[SLUG], repo.git('rev-parse', 'develop'), 'the merge commit is develop\'s tip');
  assert.deepEqual(out.statuses[SLUG].evidence, { kind: 'branch', ref: branch }, 'the evidence keeps its two fields');
  assert.equal(derive(repo, foldOf()).integrationSha, repo.git('rev-parse', 'develop'), 'also with no tracked feature');
  const none = derive(repo, foldOf(tracked('099-unmerged')));
  assert.equal(none.evidenceCommits['099-unmerged'], null);
});

// ── where the git-facts helper lives (an installed runtime carries no core/) ───────────────────

/** A runtime root under the scratch directory with the helper in the named layouts only. */
function runtimeLayout(name, { checkout = false, install = false } = {}) {
  const base = path.join(scratch.dir, `layout-${name}`);
  const root = path.join(base, '.doflow', 'runtime');
  const checkoutHelper = path.join(root, 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-git-state.sh');
  const installHelper = path.join(base, '.doflow', 'scripts', 'doflow', 'bash', 'do-git-state.sh');
  fs.mkdirSync(root, { recursive: true });
  for (const [wanted, file] of [[checkout, checkoutHelper], [install, installHelper]]) {
    if (!wanted) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/usr/bin/env bash\n');
  }
  return { root, checkoutHelper, installHelper };
}

test('resolveGitStateHelper: the checkout layout, the install layout, the checkout one first, else null', () => {
  const onlyCheckout = runtimeLayout('checkout', { checkout: true });
  assert.equal(resolveGitStateHelper(onlyCheckout.root), onlyCheckout.checkoutHelper);
  const onlyInstall = runtimeLayout('install', { install: true });
  assert.equal(resolveGitStateHelper(onlyInstall.root), onlyInstall.installHelper);
  const both = runtimeLayout('both', { checkout: true, install: true });
  assert.equal(resolveGitStateHelper(both.root), both.checkoutHelper);
  assert.equal(resolveGitStateHelper(runtimeLayout('neither').root), null);
  assert.equal(resolveGitStateHelper(onlyCheckout.root, () => false), null, 'the existence check is the injected one');
});

test('readGitFacts names the missing helper instead of a generic failure, and uses the sibling-layout helper', () => {
  const repo = makeRepo(scratch, 'helper-missing');
  assert.deepEqual(readGitFacts(repo.dir, runtimeLayout('missing').root), { error: 'git-state-helper-missing' });
  const install = runtimeLayout('real-install', { install: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-git-state.sh'), install.installHelper);
  assert.equal(readGitFacts(repo.dir, install.root).integration_ref, 'develop');
});
