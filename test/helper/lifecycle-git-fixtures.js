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

/**
 * A v-tag history for the release tests: `early` merges (10-02) and is tagged `v1.0.0`, `late`
 * merges after the tag (10-04). Both slugs are meant to be tracked at TRACKED_AT. Left on develop.
 */
function twoReleases(scratch) {
  const repo = makeRepo(scratch, 'two-releases');
  const early = '050-early';
  const late = '051-late';
  repo.at('2026-10-02T10:00:00.000Z');
  repo.mergeNoFf(featureBranch(repo, early, 1));
  repo.tag('v1.0.0');
  repo.at('2026-10-04T10:00:00.000Z');
  repo.mergeNoFf(featureBranch(repo, late, 1));
  return { repo, early, late };
}

/**
 * A history modelled in memory and written by one `git fast-import`, for tests that need many
 * repositories (the derivation differential, the spawn budget): a scripted repository costs a git
 * spawn per step, this one costs two in all. The clock only moves forward, so every parent is older
 * than its child and no ancestry walk meets clock skew. Commits change no file; only the graph,
 * the subjects and the dates matter here.
 *
 * Branch methods take short names (`develop`, `feat/x`); `remote(name)` makes `origin/<name>` point
 * where the branch points. Nothing touches disk until `write`.
 * @param {{initial?: string, start?: string}} [options] the branch HEAD names, and the first commit's instant
 */
function historyBuilder({ initial = 'develop', start = '2026-10-01T08:00:00.000Z' } = {}) {
  let clock = Math.floor(Date.parse(start) / 1000) - 60;
  let marks = 0;
  const lines = [];
  const heads = new Map();
  const remotes = new Map();
  const tags = [];
  const data = (text) => `data ${Buffer.byteLength(`${text}\n`)}\n${text}\n`;
  function newCommit(parents, subject) {
    if (parents.length === 0 && marks > 0) throw new Error('historyBuilder: only the first commit may be a root commit');
    clock += 60;
    marks += 1;
    lines.push(`commit refs/fixture/scratch\nmark :${marks}\ncommitter Test <test@example.com> ${clock} +0000\n${data(subject)}`);
    if (parents[0]) lines.push(`from :${parents[0]}\n`);
    for (const parent of parents.slice(1)) lines.push(`merge :${parent}\n`);
    return marks;
  }
  const at = (ref) => {
    const mark = heads.get(ref) ?? remotes.get(ref);
    if (mark === undefined) throw new Error(`historyBuilder: no branch ${ref}`);
    return mark;
  };
  const h = {
    /** Seconds since the epoch of the last commit. */
    get now() { return clock; },
    /** The instant just after the last commit, as ISO, moved on by `seconds`. */
    iso(seconds = 30) { return new Date((clock + seconds) * 1000).toISOString(); },
    /** Moves the clock forward by `seconds` without a commit. */
    wait(seconds) { clock += seconds; return h; },
    has(branch) { return heads.has(branch); },
    commit(branch, subject) {
      heads.set(branch, newCommit(heads.has(branch) ? [heads.get(branch)] : [], subject));
      return h;
    },
    branch(name, from) { heads.set(name, at(from)); return h; },
    /** A merge commit with `from` as its second parent (`git merge --no-ff`). */
    merge(into, from, subject = `Merge branch '${from}' into ${into}`) {
      heads.set(into, newCommit([at(into), at(from)], subject));
      return h;
    },
    /** `into` moves to where `from` points (`git merge --ff-only`). */
    fastForward(into, from) { heads.set(into, at(from)); return h; },
    /** `count` new commits on top of `onto`, which `branch` then points at (`git rebase onto`). */
    rebase(branch, onto, count, subject = `rebased work on ${branch}`) {
      let tip = at(onto);
      for (let i = 1; i <= count; i += 1) tip = newCommit([tip], `${subject} ${i}`);
      heads.set(branch, tip);
      return h;
    },
    deleteBranch(name) { heads.delete(name); return h; },
    remote(name, from = name) { remotes.set(`origin/${name}`, at(from)); return h; },
    tag(name, ref, { annotated = false } = {}) { clock += 60; tags.push({ name, mark: at(ref), annotated, when: clock }); return h; },
    /**
     * Writes the history into a new repository under the scratch directory.
     * @returns {{dir: string, git: (...args: string[]) => string}}
     */
    write(scratch, name) {
      repoCount += 1;
      const dir = path.join(scratch.dir, `${name}-${repoCount}`);
      fs.mkdirSync(dir, { recursive: true });
      const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: scratch.env() }).trim();
      git('init', '-q', '-b', initial);
      const refs = [];
      for (const [branch, mark] of heads) refs.push(`reset refs/heads/${branch}\nfrom :${mark}\n`);
      for (const [branch, mark] of remotes) refs.push(`reset refs/remotes/${branch}\nfrom :${mark}\n`);
      for (const t of tags) {
        refs.push(t.annotated
          ? `tag ${t.name}\nfrom :${t.mark}\ntagger Test <test@example.com> ${t.when} +0000\n${data(`release ${t.name}`)}`
          : `reset refs/tags/${t.name}\nfrom :${t.mark}\n`);
      }
      // A reset with no `from` leaves the working ref unwritten.
      const stream = `${lines.join('')}${refs.join('')}reset refs/fixture/scratch\n`;
      execFileSync('git', ['fast-import', '--quiet', '--date-format=raw'], { cwd: dir, input: stream, stdio: ['pipe', 'pipe', 'pipe'], env: scratch.env() });
      return { dir, git };
    },
  };
  return h;
}

/**
 * A `git` that fails `git rev-list --parents` (the derivation's graph read) and passes every other call
 * to the real git: put `dir` first on PATH. With `DOFLOW_TEST_GIT_FAIL=any` every such read fails; with a
 * sha, only a read whose revisions on stdin include it.
 * @returns {{dir: string, env: (fail: string) => Object}} `env(fail)` is the PATH and switch to set
 */
function failingGit(scratch) {
  const real = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', env: scratch.env() }).trim();
  const dir = path.join(scratch.dir, 'failing-git');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env bash
if [ "$1" = rev-list ] && [ "$2" = --parents ]; then
  input="$(cat)"
  if [ "$DOFLOW_TEST_GIT_FAIL" = any ] || printf '%s\\n' "$input" | grep -q "^$DOFLOW_TEST_GIT_FAIL"; then
    echo "fatal: injected read failure" >&2
    exit 128
  fi
  printf '%s\\n' "$input" | "${real}" "$@"
  exit $?
fi
exec "${real}" "$@"
`, { mode: 0o755 });
  return { dir, env: (fail) => ({ PATH: `${dir}${path.delimiter}${process.env.PATH}`, DOFLOW_TEST_GIT_FAIL: fail }) };
}

module.exports = { makeRepo, featureBranch, FIXTURES, twoReleases, historyBuilder, failingGit, SLUG, TRACKED_AT };
