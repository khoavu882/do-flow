'use strict';
// lifecycle-release-merged.test.js: lifecycle --action merged, the verb, review round G2 to G6 and git failures.
// Sibling of lifecycle-release.test.js. Shared fixtures: lifecycle-release.shared.js.
const { test }: any = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  scratch, CLI, CLOCK, track, release, eventFiles, slugsOf, run, makeRepo, featureBranch, FIXTURES, failingGit, SLUG, store, featureStatus, FollowupUsageError, releaseFeatures, recordMerged,
} = require('./lifecycle-release.shared.ts');

test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

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
  assert.deepEqual(out.candidates.map((c: any) => [c.slug, c.evidence]), [[slug, 'merge-subject']]);
  assert.deepEqual(out.notDetected, []);
  assert.equal(releaseFeatures({ root: repo.dir, tag: 'v1.0.1', confirm: true, now: CLOCK }).recorded, true);
});

test('G2: the evidence uses the full merge commit, so a 7-character abbreviation that is ambiguous cannot misresolve it', () => {
  const { repo } = FIXTURES.deletedBranch(scratch);
  track(repo, SLUG);
  const { deriveStatuses } = require('../../src/runtime/lifecycle/status.ts');
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
  const { deriveStatuses } = require('../../src/runtime/lifecycle/status.ts');
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
function withEnv(extra: any, fn: any) {
  const saved = Object.fromEntries(Object.keys(extra).map((key) => [key, process.env[key]]));
  Object.assign(process.env, extra);
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test('a git failure while reading the history of X, or of the integration ref, refuses the preview with git-state-failed', { skip: process.platform === 'win32' && 'a PATH shim named git cannot be a script on win32: libuv resolves a spawned command only as .exe/.com, so the injected rev-list failure (test/helper/lifecycle-git-fixtures.ts failingGit) cannot run there; git-failure handling itself is covered on POSIX' }, () => {
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
