'use strict';

/**
 * The project root every lifecycle record is keyed by (IC-001, DEC-028): the path of the first
 * entry of `git worktree list --porcelain` that is not marked `bare`, so every linked worktree of
 * one clone reads and writes one store. When git cannot answer that, `git rev-parse --show-toplevel`;
 * outside a git repository, the working directory. Paths are real paths, because git reports the
 * resolved spelling and a temp directory is often reached through a symlink.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function real(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

/** The first non-bare worktree path in `git worktree list --porcelain` output, or null. */
function firstWorktree(porcelain) {
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const head = lines.find((line) => line.startsWith('worktree '));
    if (head && !lines.some((line) => line.trim() === 'bare')) return head.slice('worktree '.length);
  }
  return null;
}

/**
 * @param {string} [cwd] defaults to the process working directory
 * @returns {string} an absolute, real path
 */
function projectRoot(cwd = process.cwd()) {
  try {
    const first = firstWorktree(git(cwd, ['worktree', 'list', '--porcelain']));
    if (first) return real(first);
  } catch { /* not a repository, or a git without worktree support: fall through */ }
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    if (top) return real(top);
  } catch { /* outside a repository */ }
  return real(cwd);
}

module.exports = { projectRoot, firstWorktree };
