'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * A call-scoped memo for git answers that cannot change while one runtime call runs (the project root
 * of a path, a repository's common directory). One `git` child costs a process spawn, and a roadmap
 * tick or a dispatch call asks the same question many times.
 *
 * The scope is the call, never the process: `withGitMemo(fn)` opens a fresh Map for `fn` (and for
 * everything `fn` awaits), and the Map is dropped when `fn` settles. Outside a scope `memoGit` just
 * computes, so a long-lived process, a test calling a helper directly and a nested call that opened
 * no scope all see the answer git gives now. A scope opened inside another is the outer one.
 *
 * Only an answer that cannot move belongs here. A ref (HEAD, a branch tip, an index path in a
 * worktree the call may remove and add again) is not cached: the code that moves it is not
 * the memo's to track.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const scope = new AsyncLocalStorage();

/** Runs `fn` inside a call scope (the current one when already inside one) and returns what `fn` returns. */
function withGitMemo<T>(fn: () => T): T {
  if (scope.getStore()) return fn();
  return scope.run(new Map(), fn);
}

/**
 * `compute()` once per `key` inside the current scope. A throw is not remembered, and a `compute`
 * that returns `undefined` is not either, so a failed or inconclusive read is asked again.
 */
function memoGit<T>(key: string, compute: () => T): T {
  const memo = scope.getStore();
  if (!memo) return compute();
  if (memo.has(key)) return memo.get(key);
  const value = compute();
  if (value !== undefined) memo.set(key, value);
  return value;
}

/** Whether a call scope is open (for tests). */
function inGitMemo(): boolean { return scope.getStore() !== undefined; }

module.exports = { withGitMemo, memoGit, inGitMemo };
