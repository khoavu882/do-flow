'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo, featureBranch } = require('../helper/lifecycle-git-fixtures');
const { foldEvents } = require('../../src/runtime/lifecycle/fold.ts');
const { deriveStatuses } = require('../../src/runtime/lifecycle/status.ts');

const scratch = createScratch('doflow-lifecycle-trailer-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

const SLUG = '113';
let seq = 0;
function tracked() {
  seq += 1;
  const at = '2026-10-01T09:00:00.000Z';
  const stamp = at.replace(/[-:.]/g, '');
  return { v: 1, id: `${stamp}-${seq.toString(36).padStart(6, '0')}`, type: 'feature.tracked', at, by: 'agent', data: { slug: SLUG } };
}

const fold = () => foldEvents([tracked()], { now: new Date('2027-01-01T00:00:00.000Z') });
const status = (repo) => deriveStatuses({ root: repo.dir, fold: fold() }).statuses[SLUG];

function mergeWithMessage(repo, branch, message) {
  repo.checkout('develop');
  repo.git('merge', '-q', '--no-ff', '--message', message, branch);
  const sha = repo.git('rev-parse', 'HEAD');
  repo.git('branch', '-q', '-D', branch);
  return sha;
}

test('a first-parent two-parent merge with a matching DoFlow-Row trailer is trailer evidence', () => {
  const repo = makeRepo(scratch, 'matching-trailer');
  const branch = featureBranch(repo, SLUG, 1, 'work');
  const sha = mergeWithMessage(repo, branch, 'Integrate roadmap work\n\nDoFlow-Row: 113');

  assert.equal(repo.git('rev-list', '--parents', '-n', '1', sha).split(' ').length, 3);
  assert.deepEqual(status(repo), { status: 'finished', evidence: { kind: 'trailer', ref: sha.slice(0, 7) }, release: null });
});

test('a trailer on the second-parent side of a merge is not evidence', () => {
  const repo = makeRepo(scratch, 'second-parent-trailer');
  const branch = featureBranch(repo, SLUG, 0, 'work');
  repo.commit('Branch-only evidence\n\nDoFlow-Row: 113');
  mergeWithMessage(repo, branch, 'Integrate related work');

  assert.equal(status(repo).status, 'in-progress');
  assert.equal(status(repo).evidence, null);
});

test('a trailer on a single-parent commit is not evidence', () => {
  const repo = makeRepo(scratch, 'single-parent-trailer');
  repo.commit('Prepare roadmap work\n\nDoFlow-Row: 113');

  assert.equal(status(repo).status, 'in-progress');
  assert.equal(status(repo).evidence, null);
});

test('a subject-only merge keeps legacy merge-subject evidence', () => {
  const repo = makeRepo(scratch, 'subject-only');
  const branch = featureBranch(repo, SLUG, 1, 'work');
  const sha = mergeWithMessage(repo, branch, 'Merge row 113\n\nImported by the release operator.');

  assert.deepEqual(status(repo), { status: 'finished', evidence: { kind: 'merge-subject', ref: sha.slice(0, 7) }, release: null });
});

test('a conflicting DoFlow-Row trailer prevents a subject match for another row', () => {
  const repo = makeRepo(scratch, 'conflicting-trailer');
  const branch = featureBranch(repo, SLUG, 1, 'work');
  mergeWithMessage(repo, branch, 'Merge row 113\n\nDoFlow-Row: 114');

  assert.equal(status(repo).status, 'in-progress');
  assert.equal(status(repo).evidence, null);
});
