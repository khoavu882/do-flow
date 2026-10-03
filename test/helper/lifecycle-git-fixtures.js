'use strict';

// Scripted git repositories for the feature-status tests (IC-021 evidence fixtures). Every commit
// carries an explicit author and committer date from a clock the fixture controls, so merge
// evidence that depends on "committed at or after the lower bound" is deterministic and never races
// the wall clock. Nothing runs at require time; each test builds its repositories in a scratch
// directory from test/helper/scratch-env.js and removes the directory in an `after`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SLUG = '046-demo';
/** The instant the feature is tracked; evidence merges must be committed at or after it. */
const TRACKED_AT = '2026-10-01T09:00:00.000Z';

/**
 * A repository on branch `develop` with one commit before tracking.
 * @param {{dir:string, env:Function}} scratch
 * @param {string} name folder name under the scratch directory
 * @param {{branch?: string}} [options] the initial branch name (default `develop`)
 */
let repoCount = 0;

function makeRepo(scratch, name, { branch = 'develop' } = {}) {
  repoCount += 1;
  const dir = path.join(scratch.dir, `${name}-${repoCount}`);
  fs.mkdirSync(dir, { recursive: true });
  let clock = Date.parse('2026-10-01T08:00:00.000Z');
  let counter = 0;
  const repo = {
    dir,
    /** Runs git with the fixture clock; returns trimmed stdout. */
    git(...args) {
      const date = new Date(clock).toISOString();
      return execFileSync('git', args, {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: scratch.env({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
      }).trim();
    },
    /** Moves the clock to an ISO instant, or by `minutes` when given a number. */
    at(when) { clock = typeof when === 'number' ? clock + when * 60000 : Date.parse(when); return repo; },
    /** A commit that changes a file, one minute after the last. */
    commit(message, file = null) {
      clock += 60000;
      counter += 1;
      const target = file || `file-${counter}.txt`;
      fs.writeFileSync(path.join(dir, target), `${message}\n${counter}\n`);
      repo.git('add', '--', target);
      repo.git('commit', '-q', '-m', message);
      return repo.git('rev-parse', 'HEAD');
    },
    /** A no-fast-forward merge with the conventional subject. */
    mergeNoFf(from, into = 'develop') {
      clock += 60000;
      repo.git('checkout', '-q', into);
      repo.git('merge', '-q', '--no-ff', from, '-m', `Merge branch '${from}' into ${into}`);
      return repo.git('rev-parse', 'HEAD');
    },
    tag(name) { clock += 60000; repo.git('tag', name); return repo; },
    checkout(ref, ...more) { repo.git('checkout', '-q', ref, ...more); return repo; },
  };
  repo.git('init', '-q', '-b', branch);
  repo.commit('init');
  repo.at(TRACKED_AT);
  return repo;
}

/** A feature branch off develop with `count` commits, left checked out. */
function featureBranch(repo, slug = SLUG, count = 2, prefix = 'feat') {
  repo.checkout('-b', `${prefix}/${slug}`, 'develop');
  for (let i = 1; i <= count; i += 1) repo.commit(`work ${i} on ${slug}`);
  return `${prefix}/${slug}`;
}

/** The ten IC-021 evidence fixtures. Each returns `{repo, slug, ...}` with develop checked out. */
const FIXTURES = {
  /** Merge commit from feat/<s>. */
  mergeCommit(scratch) {
    const repo = makeRepo(scratch, 'merge-commit');
    const branch = featureBranch(repo);
    repo.mergeNoFf(branch);
    return { repo, slug: SLUG, branch };
  },
  /** Squash merge, branch kept; the squash commit does not name the slug. */
  squash(scratch) {
    const repo = makeRepo(scratch, 'squash');
    const branch = featureBranch(repo);
    repo.checkout('develop');
    repo.git('merge', '-q', '--squash', branch);
    repo.at(5).git('commit', '-q', '-m', 'Add the cart total handling');
    return { repo, slug: SLUG, branch };
  },
  /** Rebase onto a moved develop, then fast-forward. */
  rebaseFastForward(scratch) {
    const repo = makeRepo(scratch, 'rebase-ff');
    const branch = featureBranch(repo);
    repo.checkout('develop');
    repo.commit('unrelated develop work');
    repo.checkout(branch);
    repo.at(3).git('rebase', '-q', 'develop');
    repo.checkout('develop');
    repo.git('merge', '-q', '--ff-only', branch);
    return { repo, slug: SLUG, branch };
  },
  /** Fast-forward of a branch with commits. */
  fastForward(scratch) {
    const repo = makeRepo(scratch, 'fast-forward');
    const branch = featureBranch(repo);
    repo.checkout('develop');
    repo.git('merge', '-q', '--ff-only', branch);
    return { repo, slug: SLUG, branch };
  },
  /** A branch created from develop with no commits of its own, while develop merges other work. */
  emptyBranch(scratch) {
    const repo = makeRepo(scratch, 'empty-branch');
    const empty = `feat/${SLUG}`;
    repo.git('branch', empty, 'develop');
    const other = featureBranch(repo, '047-other');
    repo.mergeNoFf(other);
    return { repo, slug: SLUG, branch: empty };
  },
  /** Cherry-pick of the branch's commit onto develop. */
  cherryPick(scratch) {
    const repo = makeRepo(scratch, 'cherry-pick');
    const branch = featureBranch(repo, SLUG, 1);
    const sha = repo.git('rev-parse', 'HEAD');
    repo.checkout('develop');
    repo.at(5).git('cherry-pick', sha);
    return { repo, slug: SLUG, branch };
  },
  /** Commits made before tracking, merged after it. */
  committedBeforeTracking(scratch) {
    const repo = makeRepo(scratch, 'before-tracking');
    repo.at('2026-09-25T10:00:00.000Z');
    const branch = featureBranch(repo);
    repo.at(TRACKED_AT).at(30);
    repo.mergeNoFf(branch);
    return { repo, slug: SLUG, branch };
  },
  /** The branch is deleted after a merge whose subject names the slug. */
  deletedBranch(scratch) {
    const repo = makeRepo(scratch, 'deleted-branch');
    const branch = featureBranch(repo);
    repo.mergeNoFf(branch);
    repo.git('branch', '-q', '-D', branch);
    return { repo, slug: SLUG, branch };
  },
  /** A merge commit and no tag at all. */
  noTag(scratch) {
    const built = FIXTURES.mergeCommit(scratch);
    return built;
  },
  /** A merge commit and only a tag without the `v` prefix. */
  nonVTag(scratch) {
    const built = FIXTURES.mergeCommit(scratch);
    built.repo.tag('1.2.3');
    return built;
  },
};

module.exports = { makeRepo, featureBranch, FIXTURES, SLUG, TRACKED_AT };
