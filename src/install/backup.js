'use strict';
// backup.js — port of sync.sh's _backup_id/create_backup/restore_backup/list_backups/prune_backups.
// PARITY: backup id `<op>_YYYY-MM-DD_HH-MM-SS`; full backup = tar.gz per tool (claude excludes
// ./backups to avoid recursion); partial backup (update) = plain dir copy of specific dst files,
// user-inspectable. Each backup dir carries its own `.manifest.json` (id/operation/timestamp/
// source_path/source_commit/type/tools_affected) — distinct from the top-level install manifest
// in manifest.js.
//
// Format 2 (createFileBackup): a per-file copy of exactly the files a run changes, `files/<rel>` for
// files under the scope root and `external/<k>/<name>` for files outside it, with a `.manifest.json`
// that records for each file whether it existed. It is assembled in a dot-named temp directory and
// renamed into place, so a reader sees either no backup or a complete one.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { sourceCommit: gitSourceCommit } = require('../helper/git');
const {
  legacyBackupReadRoot, isLegacyBackupReadRoot, scopeRootFromCanonicalBackupRoot,
} = require('./paths');

/** Where a listed/restorable backup was found. 'current' = the canonical `.doflow/backups` root the
 * installer writes to; 'legacy' = the pre-7de6d5f `.claude/backups` root, readable only. Callers
 * get this on every row so a legacy restore point is never presented as a current one. */
const BACKUP_ORIGIN_CURRENT = 'current';
const BACKUP_ORIGIN_LEGACY = 'legacy';

/** The roots a READ (list/restore) consults for a scope, canonical first, legacy second.
 * Order is the precedence rule too: an id present in both resolves to the canonical copy. */
function backupReadRoots(backupRoot) {
  const roots = [{ root: path.resolve(backupRoot), origin: BACKUP_ORIGIN_CURRENT }];
  const scopeRoot = scopeRootFromCanonicalBackupRoot(backupRoot);
  if (scopeRoot) {
    const legacy = legacyBackupReadRoot({ scopeRoot });
    if (legacy !== roots[0].root) roots.push({ root: legacy, origin: BACKUP_ORIGIN_LEGACY });
  }
  return roots;
}

/** Writes and deletes are canonical-only. The legacy root holds restore points DoFlow no longer
 * manages and may be a user's sole recovery material, so a mutating call aimed at it is a bug to
 * surface, not a path to follow. */
function assertMutableBackupRoot(backupRoot, operation) {
  if (isLegacyBackupReadRoot(backupRoot)) {
    throw new Error(`Refusing to ${operation} in the legacy backup root (read-only): ${backupRoot}`);
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** `<op>_YYYY-MM-DD_HH-MM-SS`, using a caller-supplied Date (never `new Date()` internally — keeps this testable/deterministic). */
function backupId(op, date) {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `${op}_${y}-${mo}-${d}_${h}-${mi}-${s}`;
}

const MANIFEST_FILE = '.manifest.json';
const OWNER_FILE = '.owner.json';
const TEMP_PREFIX = '.tmp-';
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
const MAX_ID_ATTEMPTS = 1000;
const RENAME_COLLISION_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES']);

/** How many backups install and update keep per scope when `--prune` is not given. */
const DEFAULT_BACKUP_RETENTION = 3;

/** A backup could not be written completely. The caller stops before changing anything. */
class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
    this.code = 'backup-failed';
  }
}

/** POSIX path of `p` relative to `scopeRoot`, or null when `p` is not strictly inside it. */
function scopeRelative(scopeRoot, p) {
  const rel = path.relative(scopeRoot, p);
  if (!rel || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return null;
  return rel.split(path.sep).join('/');
}

/** Manifest JSON: two-space indentation, except one compact line per `files` and `excluded` element. */
function serializeManifest(manifest) {
  const body = Object.entries(manifest).map(([key, value]) => {
    if ((key === 'files' || key === 'excluded') && Array.isArray(value) && value.length > 0) {
      return `  ${JSON.stringify(key)}: [\n${value.map((v) => `    ${JSON.stringify(v)}`).join(',\n')}\n  ]`;
    }
    return `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}`;
  });
  return `{\n${body.join(',\n')}\n}\n`;
}

function errorCode(err) { return err.code || err.message; }

/**
 * Copy the files of a backup set into `<backupRoot>/<id>/` (format 2). Returns null for an empty
 * set, without touching the disk. Every failure removes the temp directory and throws BackupError,
 * so a backup either exists complete, manifest included, or does not exist at all.
 * @param {{operation:string, set:object, backupRoot:string, repoRoot:string, sourceCommit?:string,
 *          version:string, date:Date, restores?:string|null, fsImpl?:object, randomHex?:Function}} p
 * @returns {null|{id:string, dir:string, files:number, existed:number, absent:number, bytes:number}}
 */
function createFileBackup({
  operation, set, backupRoot, repoRoot, sourceCommit, version, date, restores = null,
  fsImpl = fs, randomHex = () => crypto.randomBytes(4).toString('hex'),
}) {
  assertMutableBackupRoot(backupRoot, 'create a backup');
  if (set.entries.length === 0) return null;

  const base = backupId(operation, date);
  const tmpDir = path.join(backupRoot, `${TEMP_PREFIX}${base}-${process.pid}-${randomHex()}`);
  let tmpCreated = false;
  const writeFailure = (err) => new BackupError(`could not write ${backupRoot}: ${errorCode(err)}`);

  try {
    try {
      sweepStaleTemps(backupRoot, { fsImpl });
      fsImpl.mkdirSync(backupRoot, { recursive: true });
      fsImpl.mkdirSync(tmpDir);
      tmpCreated = true;
      const owner = { pid: process.pid, hostname: os.hostname(), startedAt: date.toISOString() };
      fsImpl.writeFileSync(path.join(tmpDir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: 'wx' });
    } catch (err) { throw writeFailure(err); }

    const files = [];
    const summary = { files: 0, existed: 0, absent: 0, bytes: 0 };
    let external = 0;
    for (const entry of set.entries) {
      const record = entry.rel !== null ? { path: entry.rel } : { path: entry.path, outside: true };
      let stat = null;
      try {
        stat = fsImpl.statSync(entry.path);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
          throw new BackupError(`could not read ${entry.path}: ${errorCode(err)}`);
        }
      }
      summary.files += 1;
      if (!stat) {
        record.existed = false;
        summary.absent += 1;
      } else if (stat.isFile()) {
        const stored = entry.rel !== null
          ? `files/${entry.rel}`
          : `external/${external++}/${path.basename(entry.path)}`;
        const dest = path.join(tmpDir, ...stored.split('/'));
        try {
          fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
          fsImpl.copyFileSync(entry.path, dest);
        } catch (err) {
          throw new BackupError(`could not copy ${entry.path}: ${errorCode(err)}`);
        }
        Object.assign(record, { existed: true, size: stat.size, mode: stat.mode & 0o7777, stored });
        summary.existed += 1;
        summary.bytes += stat.size;
      } else {
        Object.assign(record, { existed: true, kind: 'other' });
        summary.existed += 1;
      }
      record.harnesses = entry.harnesses;
      files.push(record);
    }

    const manifest = {
      id: base,
      operation,
      timestamp: date.toISOString(),
      source_path: repoRoot,
      source_commit: sourceCommit ?? gitSourceCommit(repoRoot),
      type: 'files',
      tools_affected: [...new Set(set.entries.flatMap((e) => e.harnesses))].sort(),
      format: 2,
      doflow_version: version,
      scope: set.scope,
      scope_root: set.scopeRoot,
      restores,
      summary,
      excluded: set.excluded.map((x) => {
        const rel = scopeRelative(set.scopeRoot, x.path);
        return rel !== null ? { path: rel, reason: x.reason } : { path: x.path, outside: true, reason: x.reason };
      }),
      files,
    };
    const manifestPath = path.join(tmpDir, MANIFEST_FILE);
    try {
      fsImpl.unlinkSync(path.join(tmpDir, OWNER_FILE));
      fsImpl.writeFileSync(manifestPath, serializeManifest(manifest), { flag: 'wx' });
    } catch (err) { throw writeFailure(err); }

    // Two runs in the same second share a base id; the loser of the rename takes the next suffix.
    for (let n = 1; n <= MAX_ID_ATTEMPTS; n += 1) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const dir = path.join(backupRoot, candidate);
      if (fsImpl.existsSync(dir)) continue;
      try {
        if (manifest.id !== candidate) {
          manifest.id = candidate;
          fsImpl.writeFileSync(manifestPath, serializeManifest(manifest));
        }
        fsImpl.renameSync(tmpDir, dir);
      } catch (err) {
        if (RENAME_COLLISION_CODES.has(err.code) && fsImpl.existsSync(dir)) continue;
        throw writeFailure(err);
      }
      tmpCreated = false;
      return { id: candidate, dir, ...summary };
    }
    throw new BackupError(`no free backup id after ${MAX_ID_ATTEMPTS} attempts`);
  } finally {
    if (tmpCreated) {
      try { fsImpl.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function isStaleTemp(dir, { now, fsImpl, isAlive, hostname }) {
  let owner = null;
  try { owner = JSON.parse(fsImpl.readFileSync(path.join(dir, OWNER_FILE), 'utf8')); } catch { /* no owner */ }
  if (!owner || typeof owner !== 'object') {
    try { return now - fsImpl.lstatSync(dir).mtimeMs > STALE_TEMP_MS; } catch { return false; }
  }
  if (owner.hostname === hostname && !isAlive(owner.pid)) return true;
  return now - Date.parse(owner.startedAt) > STALE_TEMP_MS;
}

/**
 * Remove `.tmp-*` directories left in `backupRoot` by runs that died: the owner process is gone on
 * this host, or the temp is older than 24 hours. Returns how many were removed.
 */
function sweepStaleTemps(backupRoot, { now = Date.now(), fsImpl = fs, isAlive = defaultIsAlive, hostname = os.hostname() } = {}) {
  assertMutableBackupRoot(backupRoot, 'clean up backups');
  if (!fsImpl.existsSync(backupRoot)) return 0;
  let removed = 0;
  for (const e of fsImpl.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(TEMP_PREFIX)) continue;
    const dir = path.join(backupRoot, e.name);
    if (!isStaleTemp(dir, { now, fsImpl, isAlive, hostname })) continue;
    try {
      fsImpl.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch { /* another run may hold or have removed it */ }
  }
  return removed;
}

/**
 * Classify one backup directory by its manifest: 'format-2', 'newer' (a format this version does
 * not know), 'full' or 'partial' (1.19, typed the way restoreBackup reads them), or 'incomplete'
 * (no manifest, or one that does not parse). `manifest` is the parsed object, or null.
 */
function classifyBackupDir(dir, { fsImpl = fs } = {}) {
  let manifest = null;
  try { manifest = JSON.parse(fsImpl.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')); } catch { /* incomplete */ }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { kind: 'incomplete', manifest: null };
  const { format } = manifest;
  if (format === 2) return { kind: 'format-2', manifest };
  if (Number.isInteger(format) && format > 2) return { kind: 'newer', manifest };
  if (format !== undefined && format !== null) return { kind: 'incomplete', manifest: null };
  return { kind: (manifest.type || 'full') === 'full' ? 'full' : 'partial', manifest };
}

const ID_TIME = /^.+?_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d+))?$/;

/**
 * Ordering key of a backup directory: the manifest timestamp, else the time in its id (local
 * time, as backupId writes it), else its mtime. Retention and listing share it.
 */
function sortKey(dir, { fsImpl = fs, manifest } = {}) {
  const id = path.basename(dir);
  const m = manifest === undefined ? classifyBackupDir(dir, { fsImpl }).manifest : manifest;
  const match = ID_TIME.exec(id);
  const suffix = match && match[7] ? Number(match[7]) : 1;
  let time = m ? Date.parse(m.timestamp) : NaN;
  if (!Number.isFinite(time) && match) {
    const [, y, mo, d, h, mi, s] = match.map(Number);
    time = new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  if (!Number.isFinite(time)) {
    try { time = fsImpl.lstatSync(dir).mtimeMs; } catch { time = 0; }
  }
  return { id, time, suffix };
}

/** Newest first; ties go to the larger `-n` suffix, then the id in descending order. */
function compareSortKeys(a, b) {
  if (a.time !== b.time) return b.time - a.time;
  if (a.suffix !== b.suffix) return b.suffix - a.suffix;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** Bytes of the regular files under `dir`, never following a link; null when any read fails. */
function backupSize(dir, { fsImpl = fs } = {}) {
  try {
    let total = 0;
    const pending = [dir];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const name of fsImpl.readdirSync(current)) {
        const p = path.join(current, name);
        const st = fsImpl.lstatSync(p);
        if (st.isDirectory()) pending.push(p);
        else if (st.isFile()) total += st.size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB'];

/** `?` for an unknown size, `<n> B` below 1 KiB, otherwise one decimal in 1024-based units. */
function formatBytes(n) {
  if (n === null || n === undefined) return '?';
  if (n < 1024) return `${n} B`;
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/**
 * Full backup (no partialFiles) or partial backup (partialFiles given) of `tools` into
 * `backupRoot/<id>/`. Returns the backup id. dirs = {tool: absDstDir}.
 * @param {{operation:string, tools:string[], dirs:object, backupRoot:string, repoRoot:string,
 *           partialFiles?:string[], dryRun?:boolean, date:Date, sourceCommit?:string}} p
 *           `sourceCommit` lets a caller (bin/doflow.js) pass an already-resolved commit instead
 *           of this module spawning its own `git rev-parse`; omit it to resolve here (e.g. tests
 *           calling this module directly).
 */
function createBackup({ operation, tools, dirs, backupRoot, repoRoot, partialFiles = [], dryRun = false, date, sourceCommit }) {
  assertMutableBackupRoot(backupRoot, 'create a backup');
  let bid = backupId(operation, date);
  const isFull = partialFiles.length === 0;

  if (dryRun) return bid;

  // backupId() has 1-second resolution — two ops within the same second (a script calling
  // install twice, self-update's chained install right after a git pull) would otherwise collide
  // and silently overwrite the earlier backup. Disambiguate with a numeric suffix instead.
  let bkDir = path.join(backupRoot, bid);
  let suffix = 2;
  while (fs.existsSync(bkDir)) {
    bid = `${backupId(operation, date)}-${suffix}`;
    bkDir = path.join(backupRoot, bid);
    suffix += 1;
  }

  fs.mkdirSync(bkDir, { recursive: true });

  for (const tool of tools) {
    const srcDir = dirs[tool];
    if (!srcDir || !fs.existsSync(srcDir)) continue;

    if (isFull) {
      const tarPath = path.join(bkDir, `${tool}.tar.gz`);
      const args = ['-czf', tarPath];
      if (tool === 'claude') args.push('--exclude=./backups');
      args.push('-C', srcDir, '.');
      try {
        execFileSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch {
        // matches sync.sh: tar errors are logged as a warning, not fatal — partial backup may exist
      }
    } else {
      const partialDir = path.join(bkDir, tool);
      for (const f of partialFiles) {
        const rel = path.relative(srcDir, f);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // only files under this tool's dir
        const dstF = path.join(partialDir, rel);
        fs.mkdirSync(path.dirname(dstF), { recursive: true });
        fs.copyFileSync(f, dstF);
      }
    }
  }

  const manifest = {
    id: bid,
    operation,
    timestamp: date.toISOString(),
    source_path: repoRoot,
    source_commit: sourceCommit ?? gitSourceCommit(repoRoot),
    type: isFull ? 'full' : 'partial',
    tools_affected: tools,
  };
  fs.writeFileSync(path.join(bkDir, '.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  return bid;
}

/** Restore a backup id into the given tool dirs. dirs = {tool: absDstDir}. */
/** Security guard: a backup id is a directory *name*, never a path — reject traversal/absolute ids. */
function assertSafeBackupId(bid) {
  if (!bid || bid.includes('/') || bid.includes('\\') || bid === '..' || bid.includes('..')) {
    throw new Error(`Invalid backup id: '${bid}'`);
  }
}

function restoreBackup({ bid, backupRoot, dirs, dryRun = false }) {
  assertSafeBackupId(bid);
  // An id the user picked from `list-backups` may live in either root, so resolve it the same way
  // the listing found it. Restoring reads the backup and writes only into the tool dirs, so a
  // legacy source is safe; nothing here mutates the directory it was read from.
  const found = backupReadRoots(backupRoot).find((r) => fs.existsSync(path.join(r.root, bid)));
  if (!found) {
    throw new Error(`Backup not found: ${bid}`);
  }
  const bkDir = path.join(found.root, bid);

  let type = 'full';
  let format;
  const manifestPath = path.join(bkDir, '.manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      type = m.type || 'full';
      format = m.format;
    } catch { /* fall back to 'full' */ }
  }
  // A format-2 backup holds no tool archive or tool copy, so this path would restore nothing.
  if (format === 2) throw new Error(`Backup ${bid} is format 2; restore it with doflow rollback`);

  for (const tool of Object.keys(dirs)) {
    const dstDir = dirs[tool];
    if (type === 'full') {
      const tarPath = path.join(bkDir, `${tool}.tar.gz`);
      if (!fs.existsSync(tarPath)) continue;
      if (dryRun) continue;
      fs.mkdirSync(dstDir, { recursive: true });
      execFileSync('tar', ['-xzf', tarPath, '-C', dstDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    } else {
      const partialDir = path.join(bkDir, tool);
      if (!fs.existsSync(partialDir)) continue;
      if (dryRun) continue;
      fs.mkdirSync(dstDir, { recursive: true });
      fs.cpSync(partialDir, dstDir, { recursive: true, force: true });
    }
  }
}

/** Raw member lines of a tar.gz archive. A whole-home archive can list far more than the default
 * 1 MiB of output, so the buffer is unbounded. */
function defaultListTar(archive) {
  return execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity })
    .split(/\r?\n/);
}

/** File members of an archive listing, relative to the archive root, without any `..` member. */
function archiveMembers(lines) {
  return lines
    .map((line) => line.replace(/^\.\//, ''))
    .filter((m) => m && m !== '.' && !m.endsWith('/') && !m.split('/').includes('..'));
}

/** Paths, relative to `root`, of the regular files under it; links are not followed. */
function regularFilesUnder(root, fsImpl) {
  const files = [];
  const pending = [''];
  while (pending.length > 0) {
    const rel = pending.pop();
    for (const e of fsImpl.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) pending.push(child);
      else if (e.isFile()) files.push(child);
    }
  }
  return files.sort();
}

/** Why a format-2 entry cannot be restored, or null when it can. */
function refusalOf(entry, target, { scope, scopeRoot, bkDir, fsImpl }) {
  const raw = entry.path;
  if (entry.outside === true) {
    if (!path.isAbsolute(raw)) return 'unsafe path';
    if (scope !== 'global') return 'outside the project root';
  } else if (path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..') || scopeRelative(scopeRoot, target) === null) {
    return 'unsafe path';
  }
  if (entry.kind === 'other' || typeof entry.stored !== 'string') return 'not a regular file when backed up';
  const stored = path.resolve(bkDir, entry.stored);
  if (scopeRelative(bkDir, stored) === null) return 'content missing from backup';
  try {
    if (!fsImpl.lstatSync(stored).isFile()) return 'content missing from backup';
  } catch {
    return 'content missing from backup';
  }
  return null;
}

/**
 * Work out what restoring backup `bid` writes, before anything is written. A format-2 backup
 * restores per file: entries recorded absent are listed and left alone, unsafe entries are refused,
 * and with `explicitTargets` only entries of the named harnesses count. A 1.19 backup restores per
 * tool through restoreBackup; its snapshot lists the files that restore will overwrite.
 * Reads only.
 */
function planRestore({ bid, backupRoot, scope, scopeRoot, targets, explicitTargets, dirs, fsImpl = fs, listTar = defaultListTar }) {
  assertSafeBackupId(bid);
  const found = backupReadRoots(backupRoot).find((r) => fsImpl.existsSync(path.join(r.root, bid)));
  if (!found) throw new Error(`Backup not found: ${bid}`);
  const bkDir = path.join(found.root, bid);
  const { kind, manifest } = classifyBackupDir(bkDir, { fsImpl });
  if (kind === 'newer') {
    throw new Error(`Backup ${bid} was made by a newer DoFlow (format ${manifest.format}); this version cannot restore it`);
  }

  const plan = {
    bid,
    origin: found.origin,
    bkDir,
    format: kind === 'format-2' ? 2 : 1,
    type: { 'format-2': 'files', partial: 'partial' }[kind] || 'full',
    restore: [],
    absent: [],
    refused: [],
    untargeted: 0,
    snapshot: [],
    v1: null,
  };
  const wanted = new Set(targets);

  if (plan.format === 2) {
    for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
      const harnesses = Array.isArray(entry.harnesses) ? entry.harnesses : [];
      if (explicitTargets && !harnesses.some((h) => wanted.has(h))) {
        plan.untargeted += 1;
        continue;
      }
      if (typeof entry.path !== 'string' || entry.path === '') {
        plan.refused.push({ path: String(entry.path), reason: 'unsafe path' });
        continue;
      }
      // Relative entries resolve against today's scope root, so a moved home still restores.
      const target = entry.outside === true ? path.resolve(entry.path) : path.resolve(scopeRoot, entry.path);
      if (entry.existed === false) {
        plan.absent.push(target);
        continue;
      }
      const reason = refusalOf(entry, target, { scope, scopeRoot, bkDir, fsImpl });
      if (reason) {
        plan.refused.push({ path: reason === 'unsafe path' ? entry.path : target, reason });
        continue;
      }
      plan.restore.push({ path: target, stored: path.resolve(bkDir, entry.stored), mode: entry.mode, size: entry.size, harnesses });
    }
    plan.snapshot = plan.restore.map((item) => ({ path: item.path, harnesses: item.harnesses }));
    return plan;
  }

  const tools = [];
  for (const tool of wanted) {
    const dstDir = dirs[tool];
    if (!dstDir) continue;
    if (plan.type === 'full') {
      const archive = path.join(bkDir, `${tool}.tar.gz`);
      if (!fsImpl.existsSync(archive)) continue;
      tools.push({ tool, dstDir, source: `${tool}.tar.gz` });
      for (const member of archiveMembers(listTar(archive))) plan.snapshot.push({ path: path.join(dstDir, member), harnesses: [tool] });
    } else {
      const copyDir = path.join(bkDir, tool);
      if (!fsImpl.existsSync(copyDir)) continue;
      tools.push({ tool, dstDir, source: `${tool}/` });
      for (const rel of regularFilesUnder(copyDir, fsImpl)) plan.snapshot.push({ path: path.join(dstDir, rel), harnesses: [tool] });
    }
  }
  plan.v1 = { tools };
  return plan;
}

/**
 * Carry out a plan from planRestore. Format 2 writes each restore item through a temp file renamed
 * over the target (or straight through a symlinked target, which stays a link); a failed item is
 * reported and the rest continue. It never deletes a file and never writes outside `plan.restore`.
 * A 1.19 plan goes through restoreBackup unchanged.
 */
function executeRestore(plan, { backupRoot, dryRun = false, fsImpl = fs }) {
  if (plan.format !== 2) {
    const toolDirs = Object.fromEntries(plan.v1.tools.map((t) => [t.tool, t.dstDir]));
    restoreBackup({ bid: plan.bid, backupRoot, dirs: toolDirs, dryRun });
    return { restored: plan.v1.tools.map((t) => t.tool), failed: [], absent: [], refused: [], untargeted: 0, legacy: true };
  }

  const restored = [];
  const failed = [];
  for (const item of plan.restore) {
    if (dryRun) {
      restored.push(item.path);
      continue;
    }
    let temp = null;
    try {
      const dir = path.dirname(item.path);
      fsImpl.mkdirSync(dir, { recursive: true });
      const bytes = fsImpl.readFileSync(item.stored);
      let isLink = false;
      try {
        isLink = fsImpl.lstatSync(item.path).isSymbolicLink();
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (isLink) {
        fsImpl.writeFileSync(item.path, bytes);
      } else {
        temp = path.join(dir, `.${path.basename(item.path)}.doflow-restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
        fsImpl.writeFileSync(temp, bytes, { flag: 'wx' });
        fsImpl.chmodSync(temp, item.mode);
        fsImpl.renameSync(temp, item.path);
        temp = null;
      }
      restored.push(item.path);
    } catch (err) {
      if (temp) {
        try { fsImpl.rmSync(temp, { force: true }); } catch { /* best effort */ }
      }
      failed.push({ path: item.path, reason: errorCode(err) });
    }
  }
  return { restored, failed, absent: plan.absent, refused: plan.refused, untargeted: plan.untargeted, legacy: false };
}

/** One `{ row, key }` per backup dir under `root`, tagged with where it came from. Dot-named
 * directories (temps of a run in progress) and symlinks are not backups. */
function readBackupRows(root, origin) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const bkDir = path.join(root, e.name);
      const { kind, manifest: m } = classifyBackupDir(bkDir);
      const key = sortKey(bkDir, { manifest: m });
      const bytes = backupSize(bkDir);
      if (kind === 'incomplete') {
        return { key, row: { id: e.name, operation: 'unknown', type: '?', timestamp: '-', origin, backupRoot: root, format: null, complete: false, bytes } };
      }
      const format = kind === 'format-2' || kind === 'newer' ? m.format : 1;
      const type = { 'format-2': 'files', full: 'full' }[kind] || m.type || '?';
      return { key, row: { id: m.id || e.name, operation: m.operation || 'unknown', type, timestamp: m.timestamp || '-', origin, backupRoot: root, format, complete: true, bytes } };
    });
}

/**
 * List all restore points visible to this scope, newest first, reading each `.manifest.json`.
 * Both the canonical root and the legacy pre-7de6d5f root are consulted, so restore points written
 * before lifecycle metadata moved under `.doflow` stay visible. Every row carries `origin`
 * ('current' | 'legacy') and the absolute `backupRoot` it was found in — the two sets are tagged,
 * never blended into an indistinguishable list. A duplicate id resolves to the canonical copy,
 * matching restoreBackup's precedence. Rows also carry `format` (2, 1 for 1.19, null when the
 * manifest is missing), `complete` and `bytes` (null when unreadable), and are ordered by the
 * same key retention uses.
 */
function listBackups(backupRoot) {
  const found = [];
  const seen = new Set();
  for (const { root, origin } of backupReadRoots(backupRoot)) {
    for (const item of readBackupRows(root, origin)) {
      if (seen.has(item.row.id)) continue;
      seen.add(item.row.id);
      found.push(item);
    }
  }

  found.sort((a, b) => compareSortKeys(a.key, b.key));
  return found.map((item) => item.row);
}

/**
 * Delete all but the `keepN` most recently modified backup dirs under the CANONICAL root. Returns
 * ids pruned.
 *
 * Deliberately single-root: retention applies only to backups DoFlow itself wrote. It must never
 * reach the legacy `.claude/backups` root — those are pre-migration restore points that may be a
 * user's only recovery material, and deleting them as a side effect of a retention flag would turn
 * a visibility bug into data loss. The guard below makes a mistaken call fail loudly instead of
 * deleting, because the positional `(backupRoot, keepN)` signature accepts any string root.
 */
function pruneBackups(backupRoot, keepN, { dryRun = false } = {}) {
  assertMutableBackupRoot(backupRoot, 'prune backups');
  if (keepN <= 0) return [];
  if (!fs.existsSync(backupRoot)) return [];
  const dirs = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(backupRoot, e.name));

  const withMtime = dirs.map((d) => ({ d, mtime: fs.statSync(d).mtimeMs }));
  withMtime.sort((a, b) => b.mtime - a.mtime); // newest first

  const toDelete = withMtime.slice(keepN).map((x) => x.d);
  const pruned = [];
  for (const d of toDelete) {
    pruned.push(path.basename(d));
    if (!dryRun) fs.rmSync(d, { recursive: true, force: true });
  }
  return pruned;
}

module.exports = {
  backupId, createBackup, restoreBackup, listBackups, pruneBackups, assertSafeBackupId,
  backupReadRoots, BACKUP_ORIGIN_CURRENT, BACKUP_ORIGIN_LEGACY,
  BackupError, DEFAULT_BACKUP_RETENTION, createFileBackup, sweepStaleTemps, classifyBackupDir,
  sortKey, backupSize, formatBytes, planRestore, executeRestore,
};
