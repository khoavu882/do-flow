'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Read-only snapshot of an execution worktree and the comparison of two snapshots (081 IC-015,
 * DEC-041). The supervisor takes one snapshot before the worker starts and one after it exits; a
 * change in the worktree's own HEAD, its status listing or a listed path's content is a violation.
 *
 * The repository-wide ref digest is advisory only: refs are shared by every linked worktree, so a
 * commit, branch, stash or fetch in another checkout changes it without the worker doing anything.
 *
 * Every git call runs with GIT_OPTIONAL_LOCKS=0 (and `--no-optional-locks` on status) so taking a
 * snapshot never refreshes the index: the check must not itself write to the tree it watches.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const GIT_TIMEOUT_MS = 2000;
const MAX_PATHS = 2000;
const MAX_HASH_BYTES = 1024 * 1024;
const MAX_CHANGES = 50;

/** Inherited variables that would point git at another repository, index or tree than `-C <wt>`. */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];

type PathState = string | { size: number; mtimeMs: number };

interface Head {
  ref: string;
  object: string | null;
}

interface Snapshot {
  worktree: string;
  head: Head;
  refsDigest: string | null;
  entries: Record<string, string>;
  paths: Record<string, PathState>;
  incomplete: boolean;
  reason: string | null;
}

type ChangeKind = 'added' | 'removed' | 'modified' | 'status' | 'head';

interface Comparison {
  status: 'clean' | 'violated' | 'unverifiable';
  changes: { path: string; change: ChangeKind }[];
  head: { before: Head; after: Head };
  refsChanged: boolean | null;
}

function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of REPO_ENV) delete env[key];
  return env;
}

/** stdout of one bounded git call, or null when it failed, timed out or exited non-zero. */
function git(worktree: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
      env: gitEnv(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Status entries from `--porcelain=v1 -z`, keyed by path with the two-letter code as value. A rename
 * or copy entry is followed by its source path as a separate NUL field; the source is listed too,
 * with the same code, so its disappearance is part of the compared set.
 */
function parseStatus(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const fields = text.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries[field.slice(3)] = code;
    if (code[0] === 'R' || code[0] === 'C') {
      i += 1;
      if (fields[i]) entries[fields[i]] = code;
    }
  }
  return entries;
}

/** DoFlow's own runtime state, under the storage registry's `project-state` root. Git prints POSIX separators. */
const RUNTIME_STATE_PREFIX = '.doflow/state/';
/** Never excluded: DoFlow's ignore file un-ignores it (`!/ledger.json`), so a write there is committable (DEC-061). */
const NEVER_EXCLUDED = new Set(['install-ledger-project-state']);

interface StoreRules {
  /** First path segments of the declared project-state stores. */
  segments: Set<string>;
  /** `match` of the declared project-state stores whose `path` is empty (the lock stores). */
  topLevel: RegExp[];
}

/**
 * DEC-061: the declared `project-state` stores of `storage.json`, read at check time so a store a
 * later feature adds is excluded with no edit here. Null when the registry cannot be loaded.
 */
function storeRules(storageFile?: string): StoreRules | null {
  let registry: any;
  try {
    registry = loadStorageRegistry({ repoRoot: REPO_ROOT, file: storageFile });
  } catch {
    return null;
  }
  const rules: StoreRules = { segments: new Set(), topLevel: [] };
  for (const store of registry.stores) {
    if (store.root !== 'project-state' || NEVER_EXCLUDED.has(store.id)) continue;
    if (store.path) rules.segments.add(store.path.split('/')[0]);
    else rules.topLevel.push(new RegExp(store.match));
  }
  return rules;
}

/**
 * The entries with each `.doflow/state/<R>` path dropped only when `R`'s first segment is a declared
 * store's first segment, or `R` is one top-level name matching an empty-path store (DEC-061).
 * `ledger.json` and undeclared names stay listed. Residual blind spot: a write inside a declared
 * store directory (IC-015).
 */
function withoutDeclaredStores(entries: Record<string, string>, rules: StoreRules): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [rel, code] of Object.entries(entries)) {
    if (rel.startsWith(RUNTIME_STATE_PREFIX)) {
      const inner = rel.slice(RUNTIME_STATE_PREFIX.length);
      const slash = inner.indexOf('/');
      if (rules.segments.has(slash === -1 ? inner : inner.slice(0, slash))) continue;
      if (slash === -1 && rules.topLevel.some((match) => match.test(inner))) continue;
    }
    kept[rel] = code;
  }
  return kept;
}

function pathState(worktree: string, rel: string): PathState {
  const abs = path.join(worktree, rel);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return 'missing';
  }
  if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(abs)}`;
  if (!stat.isFile()) return 'other';
  if (stat.size > MAX_HASH_BYTES) return { size: stat.size, mtimeMs: stat.mtimeMs };
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`;
}

function snapshot(worktree: string, { storageFile }: { storageFile?: string } = {}): Snapshot {
  const result: Snapshot = {
    worktree,
    head: { ref: '', object: null },
    refsDigest: null,
    entries: {},
    paths: {},
    incomplete: false,
    reason: null,
  };
  const fail = (reason: string): Snapshot => {
    result.incomplete = true;
    result.reason = result.reason ?? reason;
    return result;
  };

  // symbolic-ref -q exits 1 on a detached HEAD, which is an answer (empty ref), not a failure.
  let ref = '';
  try {
    ref = execFileSync('git', ['-C', worktree, 'symbolic-ref', '-q', 'HEAD'], {
      encoding: 'utf8',
      env: gitEnv(),
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    if (status !== 1) return fail('symbolic-ref-failed');
  }
  const object = git(worktree, ['rev-parse', 'HEAD']);
  if (object === null) return fail('rev-parse-failed');
  result.head = { ref, object: object.trim() };

  const refs = git(worktree, ['for-each-ref', '--format=%(refname)%00%(objectname)']);
  result.refsDigest = refs === null ? null : crypto.createHash('sha256').update(refs).digest('hex');

  const status = git(worktree, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === null) return fail('status-failed');
  const rules = storeRules(storageFile);
  if (rules === null) return fail('storage-registry-unreadable');
  const entries = withoutDeclaredStores(parseStatus(status), rules);
  const listed = Object.keys(entries);
  if (listed.length > MAX_PATHS) return fail('too-many-paths');
  result.entries = entries;
  for (const rel of listed) result.paths[rel] = pathState(worktree, rel);
  return result;
}

function sameState(a: PathState | undefined, b: PathState | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(before: Snapshot, after: Snapshot): Comparison {
  const refsChanged = before.refsDigest === null || after.refsDigest === null
    ? null
    : before.refsDigest !== after.refsDigest;
  const head = { before: before.head, after: after.head };
  if (before.incomplete || after.incomplete) return { status: 'unverifiable', changes: [], head, refsChanged };

  const changes: { path: string; change: ChangeKind }[] = [];
  if (before.head.ref !== after.head.ref || before.head.object !== after.head.object) {
    changes.push({ path: after.head.ref || 'HEAD', change: 'head' });
  }
  const all = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  for (const rel of [...all].sort()) {
    const was = before.entries[rel];
    const now = after.entries[rel];
    let change: ChangeKind | null = null;
    if (was === undefined) {
      if (after.paths[rel] === 'missing') change = 'removed';
      else change = now === '??' || now[0] === 'A' ? 'added' : 'modified';
    } else if (now === undefined) {
      change = was === '??' ? 'removed' : 'status';
    } else if (!sameState(before.paths[rel], after.paths[rel])) {
      change = 'modified';
    } else if (was !== now) {
      change = 'status';
    }
    if (change) changes.push({ path: rel, change });
  }

  // refsChanged is advisory (DEC-041): it never makes the result violated.
  const status = changes.length > 0 ? 'violated' : 'clean';
  return { status, changes: changes.slice(0, MAX_CHANGES), head, refsChanged };
}

module.exports = { snapshot, compare, GIT_TIMEOUT_MS, MAX_PATHS, MAX_HASH_BYTES, MAX_CHANGES };
