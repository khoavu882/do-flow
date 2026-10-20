'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireLock } = require('./task-state.ts');
const { loadStorageRegistry } = require('./storage/registry.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');

// Where a task's records live (115 IC-004) and how records a linked worktree wrote before that rule
// reach the main checkout (IC-006): one locked sweep per redirected call.
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

/** Whether `name` is a namespace directory of a store (a feature slug), not a `<file>.lock` directory. */
function isNamespaceDir(name: string): boolean {
  return SAFE_ID.test(name) && !name.includes('..') && !name.endsWith('.lock');
}

/** The record files of one store directory of the worktree, by the store's exact `match`: flat files
 * and the files of each `<slug>/` directory, as paths relative to the store. */
function storeFiles(dir: string, match: RegExp, fsImpl: any): string[] {
  const out: string[] = [];
  let entries: any[];
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    // A link is listed as it stands, file or directory, so the sweep refuses it instead of skipping it.
    if (entry.isSymbolicLink() && (match.test(entry.name) || isNamespaceDir(entry.name))) out.push(entry.name);
    else if (entry.isFile() && match.test(entry.name)) out.push(entry.name);
    else if (entry.isDirectory() && isNamespaceDir(entry.name)) {
      let inner: any[];
      try { inner = fsImpl.readdirSync(path.join(dir, entry.name), { withFileTypes: true }); } catch { continue; }
      for (const file of inner) if ((file.isFile() || file.isSymbolicLink()) && match.test(file.name)) out.push(path.join(entry.name, file.name));
    }
  }
  return out.sort();
}

/** The first link among `root`'s own path components down to `file` (the root itself is the
 * checkout and is not owned here), or null. A component that does not exist yet is not a link. */
function linkOnTheWay(root: string, file: string, fsImpl: any): string | null {
  let at = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    at = path.join(at, part);
    let stat: any;
    try { stat = fsImpl.lstatSync(at); } catch { return null; }
    if (stat.isSymbolicLink()) return at;
  }
  return null;
}

/** The task id a flat record file names: `<taskId>.json` or the claims file `<taskId>_claims.json`. */
function taskIdOf(name: string): string {
  const base = name.slice(0, -'.json'.length);
  return base.endsWith('_claims') ? base.slice(0, -'_claims'.length) : base;
}

/** The feature a flat record names (`featureSlug` on a run, `slug` on a readiness record), or null. */
function ownSlugOf(bytes: Buffer): string | null {
  try {
    const data = JSON.parse(bytes.toString('utf8'));
    const named = [data?.featureSlug, data?.slug].find((v) => typeof v === 'string' && SAFE_ID.test(v) && !v.includes('..'));
    return named || null;
  } catch { return null; }
}

/** Writes `bytes` to `to` through a temporary file beside it and a rename, so a reader never sees a
 * partial record. The one write path for a record copied between stores or checkouts. */
function placeRecord(to: string, bytes: Buffer, fsImpl: any = fs): void {
  const tmp = `${to}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, bytes);
  fsImpl.renameSync(tmp, to);
}

function realOrNull(p: string, fsImpl: any): string | null {
  try { return fsImpl.realpathSync(p); } catch { return null; }
}

/**
 * IC-006 (115 C-3, D-1, D-4): moves every record a linked worktree holds in its own `.doflow/state`
 * to the main checkout's, before the verb reads any of them. One sweep per redirected call, over
 * every adopted store, whatever task the call names.
 *
 * Nothing is swept when the two state directories are one directory (a worktree whose
 * `.doflow/state` links to the main checkout's). Per file: a link on either side's own path, or a
 * source and target that are one file (`dev:ino`), refuses that file; otherwise the target's lock and
 * then the source's are taken, the source is re-read under them (gone means another sweep moved it),
 * and it goes to the same relative path, except that a flat record of a task id other than its
 * feature's slug goes under `<store>/<slug>/` (the slug it names, else the call's `recordSlug`, so it
 * lands where every reader looks). Equal bytes at the target delete the source; no target means a
 * copy to a temporary file, a rename into place, a re-read compared with the source, and only then
 * the source's deletion; other bytes leave both and are reported. Files already moved stay moved.
 * @param {Object} options
 * @param {string} options.mainRoot the main checkout
 * @param {string} options.worktreeRoot the linked worktree the verb runs in
 * @param {string|null|(() => string|null)} [options.recordSlug] the call's feature slug, asked for only
 *   when a flat record names no feature of its own
 * @param {Object} [options.registry] storage registry (default: the shipped one)
 * @param {Object} [options.fsImpl]
 * @returns {{ok: boolean, adopted: string[], removed: string[], error?: 'store-conflict',
 *   conflicts?: Array<{worktree: string, main: string, reason: 'differs'|'link'|'same-file'}>}}
 */
function sweepWorktreeRecords({ mainRoot, worktreeRoot, recordSlug = null, registry, fsImpl = fs }: any): any {
  const done = { ok: true, adopted: [] as string[], removed: [] as string[] };
  const conflicts: Array<{ worktree: string; main: string; reason: string }> = [];
  const fromState = path.join(worktreeRoot, '.doflow', 'state');
  const toState = path.join(mainRoot, '.doflow', 'state');
  const fromReal = realOrNull(fromState, fsImpl);
  if (fromReal === null || fromReal === realOrNull(toState, fsImpl)) return done;
  let callSlug: string | null | undefined;
  const slugOfCall = (): string | null => {
    if (callSlug === undefined) {
      let value: any = null;
      try { value = typeof recordSlug === 'function' ? recordSlug() : recordSlug; } catch { /* no feature */ }
      callSlug = typeof value === 'string' && SAFE_ID.test(value) && !value.includes('..') ? value : null;
    }
    return callSlug;
  };

  for (const store of adoptedStores(registry)) {
    const fromDir = path.join(fromState, store.path);
    let dirStat: any;
    try { dirStat = fsImpl.lstatSync(fromDir); } catch { continue; }
    if (dirStat.isSymbolicLink()) {
      conflicts.push({ worktree: fromDir, main: path.join(toState, store.path), reason: 'link' });
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    for (const rel of storeFiles(fromDir, store.match, fsImpl)) {
      const from = path.join(fromDir, rel);
      if (linkOnTheWay(worktreeRoot, from, fsImpl)) {
        conflicts.push({ worktree: from, main: path.join(toState, store.path, rel), reason: 'link' });
        continue;
      }
      let toRel = rel;
      if (!rel.includes(path.sep)) {
        let bytes: Buffer | null = null;
        try { bytes = fsImpl.readFileSync(from); } catch { continue; }
        const slug = ownSlugOf(bytes as Buffer) || slugOfCall();
        if (slug && slug !== taskIdOf(rel)) toRel = path.join(slug, rel);
      }
      const to = path.join(toState, store.path, toRel);
      if (linkOnTheWay(mainRoot, to, fsImpl)) { conflicts.push({ worktree: from, main: to, reason: 'link' }); continue; }
      try {
        const a = fsImpl.lstatSync(from);
        const b = fsImpl.lstatSync(to);
        if (a.dev === b.dev && a.ino === b.ino) { conflicts.push({ worktree: from, main: to, reason: 'same-file' }); continue; }
      } catch { /* one side is absent: not one file */ }

      fsImpl.mkdirSync(path.dirname(to), { recursive: true });
      const releaseTarget = acquireLock(fsImpl, to);
      try {
        const releaseSource = acquireLock(fsImpl, from);
        try {
          let bytes: Buffer;
          try { bytes = fsImpl.readFileSync(from); } catch (error: any) {
            if (error.code === 'ENOENT') continue; // another sweep moved it
            throw error;
          }
          let there: Buffer | null = null;
          try { there = fsImpl.readFileSync(to); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
          if (there !== null) {
            if (!bytes.equals(there)) { conflicts.push({ worktree: from, main: to, reason: 'differs' }); continue; }
            fsImpl.unlinkSync(from);
            done.removed.push(from);
            continue;
          }
          placeRecord(to, bytes, fsImpl);
          if (!bytes.equals(fsImpl.readFileSync(to))) { conflicts.push({ worktree: from, main: to, reason: 'differs' }); continue; }
          fsImpl.unlinkSync(from);
          done.adopted.push(to);
        } finally {
          releaseSource();
        }
      } finally {
        releaseTarget();
      }
    }
  }
  return conflicts.length ? { ...done, ok: false, error: 'store-conflict', conflicts } : done;
}

module.exports = { taskStateRoot, sweepWorktreeRecords, placeRecord, adoptedStores, ADOPTER };
