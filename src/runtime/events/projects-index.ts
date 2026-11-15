'use strict';

// Feature 161 D4 (IC-001, IC-002, NFR-002): the project index of one `doflow events --follow` child.
//
// It wraps `listProjects` (`src/runtime/fleet/projects.ts`), which runs one `git` process per
// candidate, and memoizes the answer, so git runs only when the index refreshes:
// - when the fingerprint of its two sources moved (the user-state `upkeep-roots` file and the
//   `session-env/projects` hook directories with their `meta.json`), checked on every read;
// - on a full recompute (the detector's 30 s pass or a new `sub`), at most once per REFRESH_MS;
// - on a lookup of a project key it does not know, at most once per REFRESH_MS.
// A refresh also lists each project's checkouts once and keeps git's porcelain for it, so a reader
// that needs the checkout list later (`observedSessions`) is answered from memory by `replay`.
//
// One index serves every channel of the child (`machine` here, `layers`, `file` and `transcript`
// through `lookup`). Read-only: it writes nothing and takes no lock; its only processes are the
// git reads of a refresh.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listProjects } = require('../fleet/projects.ts');
const { listCheckouts, clearCheckoutCache } = require('../checkouts.ts');
const { stateDir } = require('../context/identity.ts');
const { resolveRoots } = require('../storage/roots.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

type Env = Record<string, string | undefined>;

/** D4: the least time between two refreshes asked by a full recompute or an unknown key. */
const REFRESH_MS = 5000;

/** One project as the index knows it: its key, its main checkout and every checkout (main first). */
interface IndexEntry { projectKey: string; main: string; checkouts: string[] }

interface IndexOptions {
  env?: Env;
  cwd?: string;
  /** spawnSync-compatible; every git process of a refresh goes through it. */
  exec?: any;
  fsImpl?: any;
  now?: () => number;
  /** `listProjects` seams (tests): the temp roots and the test-scratch folder name it filters. */
  tempRoots?: string[];
  scratchName?: string;
}

interface ProjectsIndex {
  ensure(full?: boolean): void;
  body(): { ok: true; body: any } | { ok: false; error: string };
  entries(): IndexEntry[];
  lookup(projectKey: string): IndexEntry | null;
  sources(): Array<{ path: string; match: RegExp }>;
  sessionsDir(): string | null;
  replay(cmd: string, args: readonly string[], options?: any): any;
  generation(): number;
  now(): number;
}

/** The porcelain call `listCheckouts` makes: `git -C <dir> worktree list --porcelain`. */
function worktreeListDir(args: readonly string[]): string | null {
  return Array.isArray(args) && args.length === 5 && args[0] === '-C' && args[2] === 'worktree' && args[3] === 'list' && args[4] === '--porcelain' ? args[1] : null;
}

/**
 * Creates the memoized project index of one events child. Creating it does no I/O.
 * @param {IndexOptions} options
 * @returns {ProjectsIndex}
 *   - `ensure(full)`: refreshes when never refreshed, when the fingerprint moved, or (`full`) when
 *     the last refresh is at least REFRESH_MS old.
 *   - `body()`: the `fleet --action projects` body of the last refresh with each project's `root`
 *     removed, or `{ok: false, error}` when `listProjects` failed (refreshed first if never).
 *   - `entries()`: the projects in body order with their main checkout and checkouts (as `body`).
 *   - `lookup(projectKey)`: the entry, or null when the key is unknown after a refresh at most
 *     REFRESH_MS old (IC-001: the caller's channel is then `gone`).
 *   - `sources()`: the directories whose change may move the index (for a channel's detector).
 *   - `sessionsDir()`: `<config home>/doflow/session-env/sessions`, null with no config home.
 *   - `replay`: a spawnSync stand-in that answers a project's `worktree list --porcelain` from the
 *     last refresh and fails every other command without starting a process.
 *   - `generation()`: how many refreshes have run.
 */
function createProjectsIndex(options: IndexOptions = {}): ProjectsIndex {
  const env: Env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const exec = options.exec ?? spawnSync;
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? Date.now;
  // The two stores `listProjects` reads, resolved on first use as it resolves them.
  let roots: { userState: string | null; hooks: string | null; upkeepFile: string | null; projectsDir: string | null } | null = null;
  const where = () => {
    if (roots === null) {
      const userState: string | null = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: null, global: true, env })['user-state'] ?? null;
      const hooks: string | null = stateDir(env);
      roots = { userState, hooks, upkeepFile: userState === null ? null : path.join(userState, 'upkeep-roots'), projectsDir: hooks === null ? null : path.join(hooks, 'projects') };
    }
    return roots;
  };

  let gen = 0;
  let refreshedAt = -Infinity;
  let print: string | null = null;
  let answer: { ok: true; body: any } | { ok: false; error: string } = { ok: false, error: 'not-refreshed' };
  let list: IndexEntry[] = [];
  const porcelain = new Map<string, string>();

  function statKey(p: string): string {
    try {
      const st = fsImpl.statSync(p);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return '-';
    }
  }

  /** The sources' state: one stat of `upkeep-roots`, the hook directory names and one stat per `meta.json`. Ceiling: O(hook directories) stats per read. */
  function fingerprint(): string {
    const { upkeepFile, projectsDir } = where();
    const parts: string[] = [upkeepFile === null ? 'no-user-state' : statKey(upkeepFile)];
    if (projectsDir !== null) {
      let names: string[] = [];
      try { names = fsImpl.readdirSync(projectsDir).map(String).sort(); } catch { parts.push('-'); }
      for (const name of names) parts.push(`${name}=${statKey(path.join(projectsDir, name, 'meta.json'))}`);
    }
    return parts.join('|');
  }

  /**
   * The exec of a refresh: every call goes to `exec` with GIT_OPTIONAL_LOCKS=0 (the commands are
   * `rev-parse` and `worktree list`, which refresh no index, and with optional locks off none may);
   * a checkout list that succeeded is kept for `replay`.
   */
  function recording(cmd: string, args: readonly string[], opts?: any): any {
    const res = exec(cmd, args, { ...opts, env: { ...(opts && opts.env ? opts.env : process.env), GIT_OPTIONAL_LOCKS: '0' } });
    const dir = worktreeListDir(args);
    if (dir !== null && res && !res.error && res.status === 0) porcelain.set(dir, String(res.stdout ?? ''));
    return res;
  }

  function refresh(): void {
    const before = fingerprint();
    porcelain.clear();
    clearCheckoutCache(); // a fresh process's view, as every CLI call has
    let listed: any;
    try {
      listed = listProjects({ env, cwd, exec: recording, fsImpl, ...(options.tempRoots ? { tempRoots: options.tempRoots } : {}), ...(options.scratchName ? { scratchName: options.scratchName } : {}) });
    } catch {
      listed = { ok: false, error: 'cannot-list-projects' };
    }
    gen += 1;
    refreshedAt = now();
    print = before;
    if (!listed.ok) {
      answer = { ok: false, error: String(listed.error) };
      list = [];
      return;
    }
    list = listed.body.projects.map((p: any) => {
      // `listProjects` listed this project from one of its checkouts; from the main one it is
      // usually the same call, so the checkout cache answers it without a second process.
      const checkouts = listCheckouts({ cwd: p.root, exec: recording, fsImpl });
      const others = checkouts.ok ? checkouts.entries.filter((e: any) => !e.sandbox && e.path !== p.root).map((e: any) => e.path) : [];
      return { projectKey: p.projectKey, main: p.root, checkouts: [p.root, ...others] };
    });
    answer = { ok: true, body: { ...listed.body, projects: listed.body.projects.map(({ root, ...rest }: any) => rest) } };
  }

  function ensure(full: boolean = false): void {
    if (gen === 0 || fingerprint() !== print || (full && now() - refreshedAt >= REFRESH_MS)) refresh();
  }

  return {
    ensure,
    body: () => { if (gen === 0) refresh(); return answer; },
    entries: () => { if (gen === 0) refresh(); return list.map((e) => ({ ...e, checkouts: [...e.checkouts] })); },
    lookup(projectKey: string): IndexEntry | null {
      ensure();
      let found = list.find((e) => e.projectKey === projectKey);
      if (!found && now() - refreshedAt >= REFRESH_MS) {
        refresh();
        found = list.find((e) => e.projectKey === projectKey);
      }
      return found ? { ...found, checkouts: [...found.checkouts] } : null;
    },
    sources: () => {
      const { userState, projectsDir } = where();
      return [
        ...(userState === null ? [] : [{ path: userState, match: /^upkeep-roots$/ }]),
        ...(projectsDir === null ? [] : [{ path: projectsDir, match: /^[^.]/ }]),
      ];
    },
    sessionsDir: () => { const { hooks } = where(); return hooks === null ? null : path.join(hooks, 'sessions'); },
    replay(_cmd: string, args: readonly string[]): any {
      const dir = worktreeListDir(args);
      if (dir !== null && porcelain.has(dir)) return { status: 0, stdout: porcelain.get(dir), stderr: '' };
      return { status: 1, stdout: '', stderr: 'not kept by the project index' };
    },
    generation: () => gen,
    now: () => now(),
  };
}

module.exports = { createProjectsIndex, REFRESH_MS };
