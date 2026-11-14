'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadStorageRegistry } = require('./registry.ts');
const { resolveRoots, readPruneSetting } = require('./roots.ts');
const engine = require('./engine.ts');
const { RunLedger, outerProjectRoot } = require('../trace/ledger.ts');

// Load once: a not-due moment only reads the three small markers, never the catalogue again.
let registry: any;
try { registry = loadStorageRegistry({ repoRoot: REPO_ROOT }); } catch { /* fail closed */ }
const MOMENT_ROOTS = ['project-state', 'user-state', 'config-home'];

function silently(fn: any) {
  const exitCode = process.exitCode;
  try { if (registry) return fn(); } catch { /* upkeep must never affect its caller */ }
  finally { process.exitCode = exitCode; }
}
function stat(file: any, fsImpl: any) {
  try { return fsImpl.lstatSync(file); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
function usableRoot(root: any, fsImpl: any) {
  if (!root) return false;
  const owned = path.basename(root) === 'state' ? path.dirname(root) : root;
  const parent = stat(owned, fsImpl), info = stat(root, fsImpl);
  return !!parent?.isDirectory() && !parent.isSymbolicLink() && !!info?.isDirectory() && !info.isSymbolicLink();
}
function atomicWrite(file: any, text: any, fsImpl: any, { preserveExisting = false }: any = {}) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fsImpl.writeFileSync(temp, text, { flag: 'wx' });
    if (preserveExisting) {
      // IC-016: a link never replaces a name, so a file created since the caller's check stays.
      try { fsImpl.linkSync(temp, file); } catch (error: any) { if (error.code === 'EEXIST') return false; throw error; }
      return true;
    }
    fsImpl.renameSync(temp, file);
    return true;
  } finally {
    try { fsImpl.unlinkSync(temp); } catch { /* renamed; linked, so the name keeps the bytes; or a failed write */ }
  }
}
function ignoreBytes() { return `${registry.settings.ignoreFile.lines.join('\n')}\n`; }
/**
 * Remove a lock directory judged stale (its mtime older than the pass-lock stale age at `now`) without
 * ever removing one a faster process has taken since. The directory is renamed to a unique name (atomic,
 * so one process wins), its mtime is read again, and only a still-stale one is deleted; a fresh one is
 * renamed back and left held. Ceiling: for the instant between the rename and the rename back the name is
 * free, and a third process taking it then shares the lock with the one that was moved. Moved-aside
 * directories a process that died left are removed by age here too.
 * @returns true when this call removed a stale lock
 */
function removeStaleLock(lock: any, now: any, fsImpl: any): boolean {
  const staleMs = registry.settings.passLockStaleSeconds * 1000;
  const info = stat(lock, fsImpl);
  if (!info?.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs <= staleMs) return false;
  const dir = path.dirname(lock), prefix = `${path.basename(lock)}.`;
  try {
    for (const name of fsImpl.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.gone')) continue;
      const left = stat(path.join(dir, name), fsImpl);
      if (left?.isDirectory() && !left.isSymbolicLink() && now - left.mtimeMs > staleMs) fsImpl.rmdirSync(path.join(dir, name));
    }
  } catch { /* best effort: a left-over is removed by a later call */ }
  const aside = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.gone`;
  try { fsImpl.renameSync(lock, aside); } catch { return false; }
  const moved = stat(aside, fsImpl);
  if (moved && now - moved.mtimeMs > staleMs) {
    try { fsImpl.rmdirSync(aside); return true; } catch { return false; }
  }
  try {
    if (!stat(lock, fsImpl)) fsImpl.renameSync(aside, lock);
    else fsImpl.rmdirSync(aside);
  } catch { /* nothing more to do */ }
  return false;
}
const INDEX_LOCK_WAIT_MS = 2000;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
/**
 * The roots index is rewritten by `rewriteRoots` and appended to by `ensureIgnore` and `registerProject`
 * from other processes: each runs inside this directory lock (`upkeep-roots.lock` under user state), so an
 * append can never fall between the rewrite's read and its rename. A lock older than the pass-lock stale
 * age is removed as left by a crashed holder (`removeStaleLock`). When it is not obtained within INDEX_LOCK_WAIT_MS
 * `fn` is skipped, `false` is returned, and the caller moves on: the index is best effort, a skipped rewrite happens at the next pass,
 * and a project that missed its append is added by its own pass (`registerProject`).
 */
function withIndexLock(userState: any, fsImpl: any, fn: any): boolean {
  const lock = path.join(userState, 'upkeep-roots.lock');
  const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
  for (;;) {
    try { fsImpl.mkdirSync(lock); break; } catch (error: any) {
      if (error.code !== 'EEXIST') return false;
      if (removeStaleLock(lock, Date.now(), fsImpl)) continue;
      if (Date.now() >= deadline) return false;
      Atomics.wait(PAUSE, 0, 0, 10);
    }
  }
  try { fn(); return true; } finally { try { fsImpl.rmdirSync(lock); } catch { /* best effort */ } }
}
function ensureIgnore({ roots, rootId, projectRoot, fsImpl }: any) {
  const root = roots[rootId];
  if (!usableRoot(root, fsImpl)) return;
  const file = path.join(root, registry.settings.ignoreFile.name);
  if (fsImpl.existsSync(file) || stat(file, fsImpl)) return;
  if (!atomicWrite(file, ignoreBytes(), fsImpl, { preserveExisting: true })) return;
  if (rootId === 'project-state' && usableRoot(roots['user-state'], fsImpl)) {
    const index = path.join(roots['user-state'], 'upkeep-roots');
    if (stat(index, fsImpl)?.isSymbolicLink()) return;
    withIndexLock(roots['user-state'], fsImpl, () => fsImpl.appendFileSync(index, `${fsImpl.realpathSync(projectRoot)}\n`, 'utf8'));
  }
}
/**
 * IC-017 reconciliation: a project whose ignore file was created before user state existed was
 * never appended. Its own pass (at most daily) adds it once user state exists, so a global
 * uninstall can still find its controls (IC-019).
 */
function registerProject(roots: any, fsImpl: any) {
  const projectState = roots['project-state'], userState = roots['user-state'];
  if (!usableRoot(projectState, fsImpl) || !usableRoot(userState, fsImpl)) return;
  if (!stat(path.join(projectState, registry.settings.ignoreFile.name), fsImpl)?.isFile()) return;
  const index = path.join(userState, 'upkeep-roots');
  const info = stat(index, fsImpl);
  if (info && (info.isSymbolicLink() || !info.isFile())) return;
  const project = fsImpl.realpathSync(path.dirname(path.dirname(projectState)));
  withIndexLock(userState, fsImpl, () => {
    if ((indexedRoots(index, fsImpl) || []).includes(project)) return;
    fsImpl.appendFileSync(index, `${project}\n`, 'utf8');
  });
}
function indexedRoots(file: any, fsImpl: any) {
  const info = stat(file, fsImpl);
  if (!info || info.isSymbolicLink() || !info.isFile()) return null;
  return fsImpl.readFileSync(file, 'utf8').split('\n').filter((root: any) => path.isAbsolute(root));
}
/** @returns false when the index lock was not obtained in time and nothing was rewritten */
function rewriteRoots(roots: any, fsImpl: any, forget: any = null): boolean {
  const file = path.join(roots['user-state'], 'upkeep-roots');
  if (!usableRoot(roots['user-state'], fsImpl)) return true;
  return withIndexLock(roots['user-state'], fsImpl, () => {
    const lines = indexedRoots(file, fsImpl);
    if (!lines) return;
    const kept = forget === null
      ? [...new Set(lines)].filter(root => stat(path.join(root, '.doflow/state/.gitignore'), fsImpl))
      : lines.filter((root: any) => root !== forget);
    atomicWrite(file, kept.length ? `${kept.join('\n')}\n` : '', fsImpl);
  });
}
function due(root: any, now: any, fsImpl: any) {
  try {
    const text = fsImpl.readFileSync(path.join(root, 'upkeep-due'), 'utf8').trim();
    return !/^\d+$/.test(text) || !Number.isFinite(Number(text)) || Number(text) * 1000 <= now;
  } catch { return true; }
}
function takeLock(root: any, now: any, fsImpl: any) {
  const lock = path.join(root, 'upkeep.lock');
  try { fsImpl.mkdirSync(lock); return true; }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    removeStaleLock(lock, now, fsImpl);
    return false;
  }
}
function writeDue(root: any, time: any, fsImpl: any) {
  const file = path.join(root, 'upkeep-due');
  if (stat(file, fsImpl)?.isSymbolicLink()) throw new Error('linked upkeep marker');
  atomicWrite(file, `${Math.floor(time / 1000)}\n`, fsImpl);
}
function passForRoot({ roots, rootId, stores, now, env, fsImpl, throttled = false }: any) {
  const root = roots[rootId];
  if (!usableRoot(root, fsImpl)) return;
  const setting = readPruneSetting({ registry, roots, rootId, fsImpl });
  if (setting.setting === 'off' || !takeLock(root, now, fsImpl)) return;
  let ran = false, result, outcome = 'error';
  const started = performance.now();
  try {
    if (throttled) writeDue(root, now + registry.settings.upkeepIntervalHours * 3600000, fsImpl);
    ran = true;
    result = engine.runPass({ registry, roots, stores, mode: 'prune', setting: { [rootId]: 'on' }, now, env, fsImpl });
    outcome = result.partial ? 'partial' : result.stores.some((store: any) => store.failed.length) ? 'error' : 'ok';
    if (rootId === 'user-state') rewriteRoots(roots, fsImpl);
    if (rootId === 'project-state') { try { registerProject(roots, fsImpl); } catch { /* the index is best effort */ } }
  } catch { outcome = 'error'; /* the record never includes failure content */ }
  finally {
    try { fsImpl.rmdirSync(path.join(root, 'upkeep.lock')); } catch { /* best effort */ }
  }
  if (!ran) return;
  if (throttled && result?.partial) {
    try { writeDue(root, now, fsImpl); } catch { outcome = 'error'; }
  }
  // XDG has no run store: both user roots use the registry's existing runs-user ledger.
  const configDir = roots[rootId === 'project-state' ? 'project-doflow' : 'user-doflow'];
  try {
    new RunLedger({ configDir, fsImpl, clock: () => new Date(now) }).append({
      verb: 'storage', kind: 'upkeep', outcome, duration_ms: result?.durationMs ?? performance.now() - started,
    });
  } catch { /* telemetry must also be silent */ }
  return result;
}

/** IC-009: silent throttled upkeep after a verb, using that verb's resolved store root. */
function upkeepAfterVerb({ projectRoot, now = Date.now(), env = process.env, fsImpl = fs }: any = {}) {
  // IC-004: the read switch, exact `off` like DOFLOW_TELEMETRY; nothing at all is written.
  if (env.DOFLOW_UPKEEP === 'off') return;
  return silently(() => {
    projectRoot = projectRoot && outerProjectRoot(projectRoot);
    const roots = resolveRoots({ registry, projectRoot, env });
    for (const rootId of ['project-state', 'user-state']) {
      try { ensureIgnore({ roots, rootId, projectRoot, fsImpl }); } catch { /* continue other roots */ }
    }
    for (const rootId of MOMENT_ROOTS) {
      try {
        const root = roots[rootId];
        if (!usableRoot(root, fsImpl) || !due(root, now, fsImpl)) continue;
        const stores = registry.stores.filter((store: any) => store.root === rootId && store.moments.includes('verb')).map((store: any) => store.id);
        passForRoot({ roots, rootId, stores, now, env, fsImpl, throttled: true });
      } catch { /* one inaccessible root cannot stop the others */ }
    }
  });
}

/** IC-010: the verify moment is project-only and unthrottled. Wiring belongs to D.3. */
function upkeepAfterVerify({ projectRoot, now = Date.now(), env = process.env, fsImpl = fs }: any = {}) {
  // IC-004: the switch covers every upkeep moment, so `off` prunes, locks and writes nothing here either.
  if (env.DOFLOW_UPKEEP === 'off') return;
  return silently(() => {
    projectRoot = projectRoot && outerProjectRoot(projectRoot);
    const roots = resolveRoots({ registry, projectRoot, env });
    return passForRoot({ roots, rootId: 'project-state', stores: ['verification-logs', 'verification-reuse'], now, env, fsImpl });
  });
}

/** IC-011: only this scope's recovery store; install/update call sites belong to D.4. */
function storageAfterInstall({ scope, scopeRoot, now = Date.now(), env = process.env, fsImpl = fs }: any = {}) {
  // IC-004: no ignore file, prune pass or lock at install time under the switch either.
  if (env.DOFLOW_UPKEEP === 'off') return;
  return silently(() => {
    if (!['project', 'global'].includes(scope)) return;
    const global = scope === 'global';
    const roots = resolveRoots({ registry, projectRoot: global ? null : scopeRoot, global, env: global ? { ...env, HOME: scopeRoot } : env });
    const rootId = global ? 'user-state' : 'project-state';
    try { ensureIgnore({ roots, rootId, projectRoot: scopeRoot, fsImpl }); } catch { /* pruning is independent */ }
    return passForRoot({ roots, rootId, stores: [global ? 'recovery-user' : 'recovery-project'], now, env, fsImpl });
  });
}

/** IC-019: user-initiated cleanup removes owned controls, never state or user settings. */
function storageForgetScope({ scope, scopeRoot, env = process.env, fsImpl = fs }: any = {}) {
  const exitCode = process.exitCode;
  let removed = 0;
  const failures: any = [];
  const attempt = (file: any, fn: any) => {
    try { fn(); } catch (error: any) { if (error.code !== 'ENOENT') failures.push(`${file}: ${error.code || error.message}`); }
  };
  const removeFile = (file: any, exact = false) => attempt(file, () => {
    const info = stat(file, fsImpl);
    if (!info?.isFile() || info.isSymbolicLink()) return;
    if (exact && fsImpl.readFileSync(file, 'utf8') !== ignoreBytes()) return;
    fsImpl.unlinkSync(file); removed++;
  });
  const removeControls = (root: any, ignore = true) => {
    if (!usableRoot(root, fsImpl)) return;
    if (ignore) removeFile(path.join(root, '.gitignore'), true);
    removeFile(path.join(root, 'upkeep-due'));
    for (const name of ['upkeep.lock', 'upkeep-roots.lock']) {
      const lock = path.join(root, name);
      attempt(lock, () => {
        const info = stat(lock, fsImpl);
        if (!info?.isDirectory() || info.isSymbolicLink()) return;
        fsImpl.rmdirSync(lock); removed++;
      });
    }
  };
  try {
    if (!registry || !['project', 'global'].includes(scope)) return;
    const global = scope === 'global';
    const roots = resolveRoots({ registry, projectRoot: global ? null : scopeRoot, global, env: global ? { ...env, HOME: scopeRoot } : env });
    const index = path.join(roots['user-state'], 'upkeep-roots');
    if (!global) {
      attempt(roots['project-state'], () => removeControls(roots['project-state']));
      attempt(index, () => {
        let realRoot;
        try { realRoot = fsImpl.realpathSync(scopeRoot); } catch { realRoot = path.resolve(scopeRoot); }
        if (!rewriteRoots(roots, fsImpl, realRoot)) failures.push(`${realRoot}: the roots index was busy and still lists this project; the next upkeep pass removes it`);
      });
    } else {
      attempt(index, () => {
        if (!usableRoot(roots['user-state'], fsImpl)) return;
        for (const root of new Set(indexedRoots(index, fsImpl) || [])) {
          attempt(root, () => {
            if (!stat(path.join(root, '.doflow/doflow.lock'), fsImpl)) removeControls(path.join(root, '.doflow/state'));
          });
        }
      });
      attempt(roots['user-state'], () => removeControls(roots['user-state']));
      attempt(roots['config-home'], () => removeControls(roots['config-home'], false));
      if (usableRoot(roots['user-state'], fsImpl)) removeFile(index);
    }
    if (failures.length) for (const failure of failures) console.error(`[WARN] Storage: ${failure}`);
    else if (removed > 0) console.log(`[INFO] Storage: removed ${removed} DoFlow control file(s)`);
  } catch (error: any) {
    try { console.error(`[WARN] Storage: ${error.code || error.message}`); } catch { /* no exit change */ }
  } finally { process.exitCode = exitCode; }
}

module.exports = { upkeepAfterVerb, upkeepAfterVerify, storageAfterInstall, storageForgetScope };
