'use strict';

/**
 * `fleet --action projects` (093 IC-019): the projects this machine knows, from two read-only
 * stores: the user-state `upkeep-roots` index and the `cwd` of each hook project directory
 * (`<config home>/doflow/session-env/projects/<hash>/meta.json`). A candidate is kept when it is an
 * existing directory (not a symlink) whose git work-tree top holds `.doflow/` and is not under a
 * temp folder; candidates that share a git common dir are one project. `root` (the main checkout)
 * is for the Console server only. Nothing is written: no lock, no mkdir, no upkeep.
 * @returns {{ok: false, error: 'cannot-list-projects'} | {ok: true, body: Object}}
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cwdHash, stateDir } = require('../context/identity.ts');
const { listCheckouts } = require('../checkouts.ts');
const { resolveRoots } = require('../storage/roots.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const HOOK_DIR_LIMIT = 2000;
const PROBE_LIMIT = 500; // git probes per call: each is one process, and the Console polls this
const META_MAX_BYTES = 64 * 1024;
const LABEL = /^[A-Za-z0-9 ._:/@-]{1,64}$/;
const FIXED_TEMP_ROOTS = ['/private/tmp', '/private/var/folders'];

type Env = Record<string, string | undefined>;

function realOrNull(p: string, fsImpl: any): string | null {
  try { return fsImpl.realpathSync(p); } catch { return null; }
}

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** The label rule of IC-004: at most 64 characters of `[A-Za-z0-9 ._:/@-]`, else `(withheld)`. */
function label(name: string): string {
  return LABEL.test(name) ? name : '(withheld)';
}

function iso(ms: number): string | null {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function lstatOrNull(p: string, fsImpl: any): any {
  try { return fsImpl.lstatSync(p); } catch { return null; }
}

function listProjects({
  env = process.env, cwd = process.cwd(), exec = spawnSync, fsImpl = fs, tempRoots,
}: { env?: Env; cwd?: string; exec?: any; fsImpl?: any; tempRoots?: string[] } = {}): any {
  const excluded = { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 };
  const body: any = { v: 1, store: 'absent', projects: [], excluded, truncated: false };

  const userState = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: null, global: true, env })['user-state'];
  const hooks = stateDir(env);
  if (userState === null && hooks === null) return { ok: true, body };
  body.store = 'present';

  // Candidates keyed by the path as written; each keeps its sources and the newest last_active seen.
  const candidates = new Map<string, { sources: Set<string>; activeMs: number }>();
  const add = (dir: string, source: string, activeMs = -Infinity) => {
    const c = candidates.get(dir) ?? { sources: new Set<string>(), activeMs: -Infinity };
    c.sources.add(source);
    c.activeMs = Math.max(c.activeMs, activeMs);
    candidates.set(dir, c);
  };

  if (userState !== null) {
    const file = path.join(userState, 'upkeep-roots');
    const info = lstatOrNull(file, fsImpl);
    if (info && info.isFile()) {
      let text = '';
      try { text = fsImpl.readFileSync(file, 'utf8'); } catch { excluded.unreadable += 1; }
      for (const line of text.split('\n')) {
        if (line === '') continue;
        if (path.isAbsolute(line)) add(line, 'upkeep-roots'); else excluded.unreadable += 1;
      }
    }
  }

  if (hooks !== null) {
    const base = path.join(hooks, 'projects');
    let dirs: Array<{ name: string; mtimeMs: number }> = [];
    try {
      for (const dirent of fsImpl.readdirSync(base, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const st = lstatOrNull(path.join(base, dirent.name), fsImpl);
        if (st) dirs.push({ name: dirent.name, mtimeMs: st.mtimeMs });
      }
    } catch { /* no hook project directories */ }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
    if (dirs.length > HOOK_DIR_LIMIT) { body.truncated = true; dirs = dirs.slice(0, HOOK_DIR_LIMIT); }
    for (const { name } of dirs) {
      const file = path.join(base, name, 'meta.json');
      const info = lstatOrNull(file, fsImpl);
      if (!info) continue; // a directory with no meta.json is not a record
      let meta: any;
      try {
        if (!info.isFile() || info.size > META_MAX_BYTES) throw new Error('unreadable');
        meta = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      } catch { excluded.unreadable += 1; continue; }
      if (meta === null || typeof meta !== 'object' || typeof meta.cwd !== 'string' || !path.isAbsolute(meta.cwd)) { excluded.unreadable += 1; continue; }
      add(meta.cwd, 'hook-dirs', typeof meta.last_active === 'string' ? Date.parse(meta.last_active) : -Infinity);
    }
  }

  const temp = [...(tempRoots ?? [realOrNull(os.tmpdir(), fsImpl) ?? os.tmpdir(), ...FIXED_TEMP_ROOTS])];
  const isTemp = (p: string) => temp.some((root) => under(p, root));

  /** `git rev-parse` for one directory: its work-tree top and common git dir, or itself when outside git. */
  const probe = (dir: string): { top: string; common: string } | 'git-missing' => {
    let res: any;
    try {
      res = exec('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8', timeout: 10000 });
    } catch (error: any) { res = { error }; }
    if (res && res.error && res.error.code === 'ENOENT') return 'git-missing';
    const lines = res && !res.error && res.status === 0 ? String(res.stdout || '').split('\n') : [];
    const top = lines[0] ? realOrNull(lines[0], fsImpl) : null;
    const common = lines[1] ? realOrNull(lines[1], fsImpl) : null;
    if (top !== null && common !== null) return { top, common };
    const self = realOrNull(dir, fsImpl) ?? dir;
    return { top: self, common: self };
  };

  type Group = { common: string; tops: Set<string>; sources: Set<string>; lastMs: number };
  const groups = new Map<string, Group>();
  let probes = 0;
  for (const [dir, candidate] of candidates) {
    const info = lstatOrNull(dir, fsImpl);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) { excluded.missing += 1; continue; }
    const real = realOrNull(dir, fsImpl);
    if (real === null) { excluded.missing += 1; continue; }
    if (isTemp(real)) { excluded.temp += 1; continue; }
    if (probes >= PROBE_LIMIT) { body.truncated = true; continue; }
    probes += 1;
    const found = probe(dir);
    if (found === 'git-missing') return { ok: false, error: 'cannot-list-projects' };
    const doflow = lstatOrNull(path.join(found.top, '.doflow'), fsImpl);
    if (!doflow || !doflow.isDirectory()) { excluded.notDoflow += 1; continue; }
    if (isTemp(found.top)) { excluded.temp += 1; continue; }
    const due = lstatOrNull(path.join(found.top, '.doflow', 'state', 'upkeep-due'), fsImpl);
    const g = groups.get(found.common) ?? { common: found.common, tops: new Set<string>(), sources: new Set<string>(), lastMs: -Infinity };
    g.tops.add(found.top);
    for (const s of candidate.sources) g.sources.add(s);
    g.lastMs = Math.max(g.lastMs, candidate.activeMs, due && due.isFile() ? due.mtimeMs : -Infinity);
    groups.set(found.common, g);
  }

  const here = groups.size > 0 ? probe(cwd) : null;
  if (here === 'git-missing') return { ok: false, error: 'cannot-list-projects' };

  const projects = [...groups.values()].map((g) => {
    const first = [...g.tops].sort()[0];
    const listed = listCheckouts({ cwd: first, exec, fsImpl });
    const real = (p: unknown) => (typeof p === 'string' ? realOrNull(p, fsImpl) : null);
    const main = (listed.ok && real(listed.main)) || first;
    const count = listed.ok ? listed.entries.filter((e: any) => !e.sandbox).length : g.tops.size;
    return {
      projectKey: cwdHash(main),
      root: main,
      label: label(path.basename(main)),
      current: here !== null && g.common === here.common,
      checkouts: Math.max(count, 1),
      sources: ['upkeep-roots', 'hook-dirs'].filter((s) => g.sources.has(s)),
      lastRecordAt: iso(g.lastMs),
    };
  });
  const time = (p: any) => (p.lastRecordAt === null ? -Infinity : Date.parse(p.lastRecordAt));
  projects.sort((a, b) => Number(b.current) - Number(a.current) || time(b) - time(a) || (a.projectKey < b.projectKey ? -1 : 1));
  body.projects = projects;
  return { ok: true, body };
}

module.exports = { listProjects };
