'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BASE_FILE } = require('./worktree.ts');

// The checkouts of one repository: the main working tree and its linked worktrees.
//
// Feature folders, runs and records live in whichever checkout wrote them; a linked worktree has
// none of the main checkout's gitignored files. A reader that looks only where it stands misses
// them, and a reader that guesses another path reads the wrong one. `git worktree list` is the one
// source that names every checkout, and it is asked once per process.

/** realpath(cwd) -> listCheckouts result. */
const cache = new Map<string, any>();

function realOrNull(p: string, fsImpl: any): string | null {
  try {
    return fsImpl.realpathSync(p);
  } catch {
    return null;
  }
}

function failed(reason: string, detail: string): any {
  return {
    ok: false, reason, detail, current: null, main: null, mainReason: null, others: [], isLinked: false, sandbox: false,
  };
}

/**
 * The repository's checkouts as seen from `cwd`, from one `git worktree list --porcelain`.
 *
 * `main` is the first porcelain entry (null when it is bare, no longer exists, or `cwd` is in a
 * DoFlow sandbox); `current` is the entry that is the longest real-path prefix of `cwd`, so a
 * sandbox nested under the main checkout is told apart from it. A sandbox (a checkout holding
 * `.doflow-worktree-base`) is never offered as another checkout and sees none itself: it exists
 * to be isolated. Writes nothing.
 * @param {Object} options
 * @param {string} options.cwd
 * @param {Function} [options.exec] spawnSync-compatible
 * @param {Object} [options.fsImpl]
 * @returns {{ok: boolean, reason: string|null, detail: string|null, current: string|null, main: string|null,
 *   mainReason: string|null, others: Array<string>, isLinked: boolean, sandbox: boolean}}
 */
function listCheckouts({ cwd, exec = spawnSync, fsImpl = fs }: { cwd: string; exec?: any; fsImpl?: any }): any {
  const realCwd = realOrNull(cwd, fsImpl) || path.resolve(cwd);
  if (cache.has(realCwd)) return cache.get(realCwd);

  let res: any;
  try {
    res = exec('git', ['-C', realCwd, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 10000 });
  } catch (error: any) {
    res = { error };
  }
  let result: any;
  if (res && res.error) {
    result = res.error.code === 'ENOENT'
      ? failed('git-unavailable', String(res.error.message || '').trim().slice(0, 200))
      : failed('worktree-list-failed', String(res.error.message || '').trim().slice(0, 200));
  } else if (!res || res.status !== 0) {
    const stderr = String((res && res.stderr) || '').trim().slice(0, 200);
    result = failed(/not a git repository/.test(stderr) ? 'not-a-git-repository' : 'worktree-list-failed', stderr);
  } else {
    result = fromPorcelain(String(res.stdout || ''), realCwd, fsImpl);
  }
  cache.set(realCwd, result);
  return result;
}

function fromPorcelain(stdout: string, realCwd: string, fsImpl: any): any {
  const entries: Array<{ real: string | null; bare: boolean; sandbox: boolean }> = [];
  for (const block of stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0 || !lines[0].startsWith('worktree ')) continue;
    const real = realOrNull(lines[0].slice('worktree '.length), fsImpl);
    entries.push({
      real,
      bare: lines.includes('bare'),
      sandbox: real !== null && fsImpl.existsSync(path.join(real, BASE_FILE)),
    });
  }

  let current: any = null;
  for (const e of entries) {
    if (e.real === null || e.bare) continue;
    if ((realCwd === e.real || realCwd.startsWith(e.real + path.sep)) && (current === null || e.real.length > current.real.length)) {
      current = e;
    }
  }
  const sandbox = Boolean(current && current.sandbox);
  const first = entries[0];
  let main: string | null = null;
  let mainReason: string | null = null;
  if (sandbox) mainReason = 'sandbox';
  else if (first && first.bare) mainReason = 'bare';
  else if (!first || first.real === null) mainReason = 'missing';
  else main = first.real;

  const others = sandbox ? [] : entries
    .filter((e) => e.real !== null && !e.bare && !e.sandbox && e !== current)
    .map((e) => e.real as string);
  const currentPath = current ? current.real : null;
  return {
    ok: true,
    reason: null,
    detail: null,
    current: currentPath,
    main,
    mainReason,
    others: [...new Set(others)],
    isLinked: currentPath !== null && main !== null && currentPath !== main,
    sandbox,
  };
}

/** Forgets every memoized `listCheckouts` result (tests that rebuild a repository in place). */
function clearCheckoutCache(): void {
  cache.clear();
}

/** Whether `dir` can sit in a linked worktree: the nearest `.git` above it is a file (a worktree's
 * pointer), not the main checkout's directory. A main checkout then needs no `git worktree list`. */
function mayBeLinked(dir: string, fsImpl: any = fs): boolean {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    try { return fsImpl.statSync(path.join(at, '.git')).isFile(); } catch { /* not here */ }
    if (path.dirname(at) === at) return false;
  }
}

/** Whether two files hold the same bytes; a file that cannot be read differs from any other. */
function sameBytes(a: string, b: string, fsImpl: any): boolean {
  try { return fsImpl.readFileSync(a).equals(fsImpl.readFileSync(b)); } catch { return false; }
}

/**
 * A state file in the checkout the verb resolves to, else in exactly one other checkout.
 *
 * From a linked worktree the main checkout is read first, since every per-task record lives there
 * (115 IC-004): a copy at the same path in the worktree with other bytes is a `conflict` (C-3),
 * never a pick; with none in the main checkout the worktree's own is read, then the others. From any
 * other checkout the current one is read first and, when the file is there, no `git` call is made.
 * Two or more other checkouts holding it is `ambiguous` rather than a pick: which one is meant is not
 * something a path can decide. Writes nothing.
 * @param {Object} options
 * @param {string} options.stateRoot the root the verb resolves today
 * @param {string|Array<string>|Function} options.relPath a path under each root, candidate paths taken in
 *   order (the first that exists in a root is that root's file), or `(root, isCurrent) => string|null`
 *   for a store whose location differs per checkout (null skips that root)
 * @param {Function} [options.exec]
 * @param {Object} [options.fsImpl]
 * @returns {{status: 'found'|'missing'|'ambiguous'|'conflict', file: string|null, root: string|null,
 *   origin: 'current'|'other'|null, candidates: Array<string>}} `conflict` names the worktree's file
 *   then the main checkout's
 */
function findStateFile({ stateRoot, relPath, exec = spawnSync, fsImpl = fs }: { stateRoot: string; relPath: any; exec?: any; fsImpl?: any }): any {
  const at = (root: string, isCurrent: boolean): string | null => {
    const rel = typeof relPath === 'function' ? relPath(root, isCurrent) : relPath;
    for (const candidate of Array.isArray(rel) ? rel : [rel]) {
      if (typeof candidate !== 'string' || candidate === '') continue;
      const file = path.join(root, candidate);
      if (fsImpl.existsSync(file)) return file;
    }
    return null;
  };
  const missing = { status: 'missing', file: null, root: null, origin: null, candidates: [] as string[] };
  const linked = mayBeLinked(stateRoot, fsImpl) ? listCheckouts({ cwd: stateRoot, exec, fsImpl }) : null;
  const main = linked?.ok && linked.isLinked && !linked.sandbox ? linked.main : null;

  if (main) {
    const there = at(main, false);
    if (there) {
      const copy = path.join(stateRoot, path.relative(main, there));
      if (fsImpl.existsSync(copy) && !sameBytes(copy, there, fsImpl)) {
        return { status: 'conflict', file: null, root: null, origin: null, candidates: [copy, there] };
      }
      return { status: 'found', file: there, root: main, origin: 'other', candidates: [] };
    }
  }
  const here = at(stateRoot, true);
  if (here) return { status: 'found', file: here, root: stateRoot, origin: 'current', candidates: [] };

  const checkouts = linked || listCheckouts({ cwd: stateRoot, exec, fsImpl });
  if (!checkouts.ok || checkouts.sandbox) return missing;
  const matches: Array<{ file: string; root: string }> = [];
  for (const root of checkouts.others as string[]) {
    if (root === main) continue;
    const file = at(root, false);
    if (file) matches.push({ file, root });
  }
  if (matches.length === 0) return missing;
  if (matches.length > 1) {
    return { status: 'ambiguous', file: null, root: null, origin: null, candidates: matches.map((m: { file: string }) => m.file) };
  }
  return { status: 'found', file: matches[0].file, root: matches[0].root, origin: 'other', candidates: [] };
}

module.exports = { listCheckouts, findStateFile, clearCheckoutCache, mayBeLinked };
