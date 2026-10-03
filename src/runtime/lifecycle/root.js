'use strict';

/**
 * The project root every lifecycle record is keyed by (IC-001, DEC-043). Paths are real paths,
 * because git reports the resolved spelling and a temp directory is often reached through a symlink.
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

/** The entries of `git worktree list --porcelain`: `{path, bare, prunable}`, in git's order. */
function worktreeEntries(porcelain) {
  const entries = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.replace(/\r$/, ''));
    const head = lines.find((line) => line.startsWith('worktree '));
    if (!head) continue;
    entries.push({
      path: head.slice('worktree '.length),
      bare: lines.some((line) => line.trim() === 'bare'),
      prunable: lines.some((line) => line === 'prunable' || line.startsWith('prunable ')),
    });
  }
  return entries;
}

/** A working tree that exists and that git itself calls one: a submodule's or a separate git dir's
 * entry points at a git directory, where `--is-inside-work-tree` prints `false`. */
function isRealWorkTree(entry) {
  if (entry.bare || entry.prunable || !fs.existsSync(entry.path)) return false;
  try { return git(entry.path, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; }
}

function showToplevel(cwd) {
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    return top ? real(top) : null;
  } catch { return null; }
}

/**
 * DEC-043. The first entry of `git worktree list --porcelain` when it is a real working tree, so
 * every linked worktree of one clone shares one store. When the first entry is the bare repository
 * of a bare-clone layout, there is no main working tree to share, and the current worktree's own
 * root is used. In every other case, and outside a repository, `--show-toplevel` and then the
 * working directory.
 * @param {string} [cwd] defaults to the process working directory
 * @returns {string} an absolute, real path
 */
function projectRoot(cwd = process.cwd()) {
  let entries = [];
  try { entries = worktreeEntries(git(cwd, ['worktree', 'list', '--porcelain'])); } catch { /* not a repository */ }
  const first = entries[0];
  if (first && !first.bare && isRealWorkTree(first)) return real(first.path);
  return showToplevel(cwd) || real(cwd);
}

module.exports = { projectRoot, worktreeEntries };
