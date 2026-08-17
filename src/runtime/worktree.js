'use strict';

/**
 * Ephemeral git worktrees for isolated task execution — the JavaScript port of
 * `core/shared/scripts/doflow/sandbox/worktree_manager.py` (plan task B.3, pulled forward because
 * A.3's baseline capture cannot run safely without it).
 *
 * Why this exists: 21 of the 33 bench cases invoke skills that write files, create branches, or
 * commit. Running them in the repo that is executing the plan would mutate the very tree under
 * test. Each run gets its own worktree so the blast radius of a misbehaving skill is one
 * throwaway directory.
 *
 * Three defects in the Python original are fixed here rather than reproduced. Plan decision D3
 * says port from observed behaviour rather than from the specification — that was about not losing
 * capability (recovery's eleven failure classes), not about preserving bugs:
 *   1. `create_worktree` returned early when the directory existed without checking the branch
 *      existed too, so a half-removed worktree resolved to an unusable path.
 *   2. `collect_diff` ran `git diff HEAD~1`, which fails on a worktree with fewer than two commits
 *      and returned null — conflating "no changes" with "could not tell".
 *   3. `remove_worktree` deleted the directory but left the `task/<id>` branch behind, so repeated
 *      runs accumulated branches indefinitely.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Worktree ids become branch names and directory names, so anything outside this set is a
 * potential argument-injection or path-traversal vector. Rejecting loudly beats sanitising
 * silently: a caller passing a bad id has a bug worth seeing. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** Records the base commit a sandbox was cut from. Lives inside the worktree so it survives a
 * process boundary; excluded from collected diffs since it is harness bookkeeping, not task work. */
const BASE_FILE = '.doflow-worktree-base';

function git(args, cwd, { allowFailure = false } = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (err) {
    if (!allowFailure) throw err;
    return { ok: false, stdout: '', stderr: err.stderr ? String(err.stderr) : String(err.message) };
  }
}

class WorktreeManager {
  /**
   * @param {string} repoRoot repository whose worktrees are managed
   * @param {string} [worktreesDir] override the sandbox root; defaults to `<repo>/.doflow/worktrees`,
   *   which is gitignored so sandboxes never appear as untracked noise in the parent tree.
   */
  constructor(repoRoot, worktreesDir) {
    this.repoRoot = repoRoot;
    this.worktreesDir = worktreesDir || path.join(repoRoot, '.doflow', 'worktrees');
  }

  static assertSafeId(taskId) {
    if (!taskId || !SAFE_ID.test(taskId)) {
      throw new Error(`unsafe worktree id ${JSON.stringify(taskId)} — allowed: letters, digits, dot, dash, underscore`);
    }
  }

  pathFor(taskId) {
    WorktreeManager.assertSafeId(taskId);
    return path.join(this.worktreesDir, taskId);
  }

  branchFor(taskId) {
    WorktreeManager.assertSafeId(taskId);
    return `task/${taskId}`;
  }

  /** Whether git itself considers this path a registered worktree — the directory existing on disk
   * is not the same question, which is the bug fixed here. */
  isRegistered(wtPath) {
    const res = git(['worktree', 'list', '--porcelain'], this.repoRoot, { allowFailure: true });
    if (!res.ok) return false;
    const resolved = path.resolve(wtPath);
    return res.stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .some((l) => path.resolve(l.slice('worktree '.length).trim()) === resolved);
  }

  /**
   * Create an isolated worktree, reusing it only when git agrees it is registered. Returns the
   * absolute path.
   */
  create(taskId, baseRef = 'HEAD') {
    const wtPath = this.pathFor(taskId);
    const branch = this.branchFor(taskId);

    if (this.isRegistered(wtPath)) return wtPath;

    // A leftover directory that git does not know about blocks `worktree add`. Clear it, and
    // prune git's stale administrative records, before trying.
    if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
    git(['worktree', 'prune'], this.repoRoot, { allowFailure: true });

    fs.mkdirSync(this.worktreesDir, { recursive: true });

    const branchExists = git(['rev-parse', '--verify', '--quiet', branch], this.repoRoot, { allowFailure: true }).ok;
    const args = branchExists
      ? ['worktree', 'add', wtPath, branch]
      : ['worktree', 'add', '-b', branch, wtPath, baseRef];
    git(args, this.repoRoot);

    // Persist the base as a resolved SHA. A symbolic ref is useless later: inside the worktree
    // `HEAD` moves with every commit the task makes, so diffing against it reports nothing. The
    // file also survives a process boundary, since grading may run separately from execution.
    const baseSha = git(['rev-parse', baseRef], this.repoRoot).stdout.trim();
    fs.writeFileSync(path.join(wtPath, BASE_FILE), `${baseSha}\n`);
    return wtPath;
  }

  /** The resolved base SHA recorded at creation, or null when unavailable. */
  baseOf(taskId) {
    const file = path.join(this.pathFor(taskId), BASE_FILE);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  }

  /** Remove the worktree and its branch. Idempotent: removing something absent is success. */
  remove(taskId) {
    const wtPath = this.pathFor(taskId);
    const branch = this.branchFor(taskId);

    git(['worktree', 'remove', '--force', wtPath], this.repoRoot, { allowFailure: true });
    if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
    git(['worktree', 'prune'], this.repoRoot, { allowFailure: true });
    // Deleting the branch is what keeps repeated bench runs from accumulating one branch per case.
    git(['branch', '-D', branch], this.repoRoot, { allowFailure: true });
  }

  /**
   * What the task actually changed inside its sandbox: committed diff against the base ref plus
   * anything still uncommitted. Returns `{ diff, untracked, error }` — `error` is set rather than
   * collapsing a failure into an empty diff, so a caller can tell "nothing changed" from
   * "could not tell", which the Python version could not.
   */
  collectDiff(taskId, baseRef) {
    const wtPath = this.pathFor(taskId);
    if (!fs.existsSync(wtPath)) {
      return { diff: null, untracked: [], error: `no worktree at ${wtPath}` };
    }
    // Default to the SHA recorded at creation, never to `HEAD` — see create().
    const base = baseRef || this.baseOf(taskId);
    if (!base) {
      return { diff: null, untracked: [], error: `no recorded base for ${taskId}; pass baseRef explicitly` };
    }
    const committed = git(['diff', `${base}...HEAD`], wtPath, { allowFailure: true });
    const working = git(['diff', 'HEAD'], wtPath, { allowFailure: true });
    const untracked = git(['ls-files', '--others', '--exclude-standard'], wtPath, { allowFailure: true });

    if (!committed.ok && !working.ok) {
      return { diff: null, untracked: [], error: committed.stderr || working.stderr };
    }
    return {
      diff: `${committed.ok ? committed.stdout : ''}${working.ok ? working.stdout : ''}`,
      untracked: untracked.ok
        ? untracked.stdout.split('\n').filter((f) => f && f !== BASE_FILE)
        : [],
      error: null,
    };
  }

  /** Every sandbox this manager knows about — used to clean up after an interrupted run. */
  list() {
    if (!fs.existsSync(this.worktreesDir)) return [];
    return fs
      .readdirSync(this.worktreesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  /** Run `fn(worktreePath)` in a fresh sandbox and always tear it down, even when `fn` throws. */
  withWorktree(taskId, fn, baseRef = 'HEAD') {
    const wtPath = this.create(taskId, baseRef);
    try {
      return fn(wtPath);
    } finally {
      this.remove(taskId);
    }
  }
}

module.exports = { WorktreeManager };
