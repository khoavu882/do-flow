'use strict';
// lifecycle-release.shared.js — fixtures and runners the lifecycle-release test files share. Not a test file.
// Each test file creates its own scratch from here and applies/removes it itself.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { makeRepo, featureBranch, FIXTURES, twoReleases, failingGit, SLUG, TRACKED_AT } = require('../helper/lifecycle-git-fixtures.ts');
const store = require('../../src/runtime/lifecycle/event-store.ts');
const { buildOverview, featureStatus } = require('../../src/runtime/lifecycle/overview.ts');
const { addFollowups, takeFollowups, loadFollowups, FollowupUsageError } = require('../../src/runtime/lifecycle/followup.ts');
const { releaseFeatures, recordMerged } = require('../../src/runtime/lifecycle/release.ts');
const { readGitFacts } = require('../../src/runtime/lifecycle/status.ts');


const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const scratch = createScratch('doflow-release-');


// A fixed clock after every fixture date: the fold leaves out events dated over 24 hours ahead of it (DEC-045).
const CLOCK: any = new Date('2027-01-01T00:00:00.000Z');
const track = (repo: any, slug: any, at: any = TRACKED_AT) => assert.ok(store.appendEvents(repo.dir, [{ type: 'feature.tracked', by: 'agent', data: { slug } }], { now: new Date(at) }).ok);
const release = (repo: any, options: any) => releaseFeatures({ root: repo.dir, now: CLOCK, ...options });
const eventFiles = (repo: any) => { try { return fs.readdirSync(path.join(repo.dir, store.EVENTS_REL)).sort(); } catch { return []; } };
const slugsOf = (result: any) => result.candidates.map((c: any) => c.slug);
const firstCommit = (repo: any) => repo.git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0];

function run(cwd: any, args: any) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: scratch.env(), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

module.exports = {
  scratch, REPO, CLI, CLOCK, track, release, eventFiles, slugsOf, firstCommit, run, makeRepo, featureBranch, FIXTURES, twoReleases, failingGit, SLUG, TRACKED_AT, store, buildOverview, featureStatus, addFollowups, takeFollowups, loadFollowups, FollowupUsageError, releaseFeatures, recordMerged, readGitFacts,
};
