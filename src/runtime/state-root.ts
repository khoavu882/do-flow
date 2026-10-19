'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireLock } = require('./task-state.ts');
const { loadStorageRegistry } = require('./storage/registry.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');

// Where a task's records live (115 IC-004) and how records a linked worktree wrote before that rule
// reach the main checkout (IC-006).
//
// A linked, non-sandbox worktree reads and writes every per-task record under the main checkout's
// `.doflow/state`, whatever folders the worktree holds: a conditional rule flipped mid-run when
// do-brainstorm created the feature folder in the worktree and split one task's records across two
// stores. A DoFlow sandbox (`.doflow-worktree-base`) keeps its own store, and `--global` is $HOME.

/** This module's path as `core/registry/storage.json` names it in a store's `writers`. */
const ADOPTER = 'src/runtime/state-root.ts';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * IC-004: the root a task-store verb or `orchestrate` reads and writes its records in.
 * @param {Object} o parsed CLI options (`global`, `positional`)
 * @param {Object|null} checkouts a `listCheckouts` result, or null when none was listed
 * @returns {{root: string, redirected: boolean}}
 */
function taskStateRoot(o: any, checkouts: any): { root: string; redirected: boolean } {
  if (!o.global && checkouts?.ok && checkouts.isLinked && !checkouts.sandbox && checkouts.main) {
    return { root: checkouts.main, redirected: true };
  }
  return { root: o.global ? os.homedir() : path.resolve(o.positional?.[0] || '.'), redirected: false };
}

/**
 * The project-state stores a worktree's records are adopted from: the ones that declare this module
 * among their `writers` in `core/registry/storage.json`, so the list is the registry's, not a copy.
 * @param {Object} [registry] a loaded storage registry (default: the shipped one)
 * @returns {Array<{id: string, path: string, match: RegExp}>}
 */
function adoptedStores(registry: any = loadStorageRegistry({ repoRoot: REPO_ROOT })): Array<{ id: string; path: string; match: RegExp }> {
  return registry.stores
    .filter((store: any) => store.root === 'project-state' && Array.isArray(store.writers) && store.writers.includes(ADOPTER))
    .map((store: any) => ({ id: store.id, path: store.path, match: new RegExp(store.match) }));
}

/** A task's record files in one store directory: `<taskId>.json` and `<taskId>_<kind>.json` (the claims file). */
function taskFiles(dir: string, taskId: string, match: RegExp, fsImpl: any): string[] {
  let names: string[];
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  return names.filter((name) => match.test(name) && (name === `${taskId}.json` || (name.startsWith(`${taskId}_`) && name.endsWith('.json'))))
    .filter((name) => { try { return fsImpl.statSync(path.join(dir, name)).isFile(); } catch { return false; } })
    .sort();
}

/**
 * IC-006: moves the records one task holds in the worktree's `.doflow/state` to the same relative
 * path under the main checkout's, before the verb reads any of them. Every file of the task is
 * checked before any is moved: a file in both checkouts with different bytes refuses the whole
 * adoption and writes nothing. Equal bytes delete the worktree copy (the leftover of a move that
 * stopped between the rename and the delete). A move writes the bytes to a temporary file beside
 * the target under the target's lock, renames it into place, and only then deletes the worktree copy.
 * @param {Object} options
 * @param {string} options.mainRoot the main checkout
 * @param {string} options.worktreeRoot the linked worktree the verb runs in
 * @param {string} options.taskId
 * @param {string|null} [options.slug] the feature; its `<store>/<slug>/` directory is adopted file by file
 * @param {Object} [options.registry] storage registry (default: the shipped one)
 * @param {Object} [options.fsImpl]
 * @returns {{ok: true, adopted: string[], removed: string[]} | {ok: false, error: 'store-conflict', paths: [string, string]}}
 */
function adoptWorktreeRecords({ mainRoot, worktreeRoot, taskId, slug = null, registry, fsImpl = fs }: any): any {
  const done = { ok: true, adopted: [] as string[], removed: [] as string[] };
  if (typeof taskId !== 'string' || !SAFE_ID.test(taskId) || taskId.includes('..')) return done;
  if (path.resolve(mainRoot) === path.resolve(worktreeRoot)) return done;
  const subdirs = [''];
  if (typeof slug === 'string' && SAFE_ID.test(slug) && !slug.includes('..')) subdirs.push(slug);

  const pairs: Array<{ from: string; to: string; bytes: Buffer }> = [];
  for (const store of adoptedStores(registry)) {
    for (const sub of subdirs) {
      const rel = path.join('.doflow', 'state', store.path, sub);
      for (const name of taskFiles(path.join(worktreeRoot, rel), taskId, store.match, fsImpl)) {
        const from = path.join(worktreeRoot, rel, name);
        const to = path.join(mainRoot, rel, name);
        const bytes = fsImpl.readFileSync(from);
        if (fsImpl.existsSync(to) && !bytes.equals(fsImpl.readFileSync(to))) {
          return { ok: false, error: 'store-conflict', paths: [to, from] };
        }
        pairs.push({ from, to, bytes });
      }
    }
  }

  for (const { from, to, bytes } of pairs) {
    fsImpl.mkdirSync(path.dirname(to), { recursive: true });
    const release = acquireLock(fsImpl, to);
    try {
      if (fsImpl.existsSync(to)) {
        // Written between the check above and this lock: equal bytes are the same record, anything
        // else stops here, with the files already moved left in place in the main checkout.
        if (!bytes.equals(fsImpl.readFileSync(to))) return { ok: false, error: 'store-conflict', paths: [to, from] };
        done.removed.push(from);
      } else {
        const tmp = `${to}.${process.pid}.tmp`;
        fsImpl.writeFileSync(tmp, bytes);
        fsImpl.renameSync(tmp, to);
        done.adopted.push(to);
      }
      fsImpl.unlinkSync(from);
    } finally {
      release();
    }
  }
  return done;
}

module.exports = { taskStateRoot, adoptWorktreeRecords, adoptedStores, ADOPTER };
