'use strict';
// backup.js — writing, listing, restoring and pruning backups. Backup id `<op>_YYYY-MM-DD_HH-MM-SS`;
// each backup dir carries its own `.manifest.json` (id/operation/timestamp/source_path/
// source_commit/type/tools_affected), distinct from the top-level install manifest in manifest.js.
//
// A backup (createFileBackup, format 2) is a per-file copy of exactly the files a run changes,
// `files/<rel>` for files under the scope root and `external/<k>/<name>` for files outside it, with
// a manifest that records for each file whether it existed. It is assembled in a dot-named temp
// directory and renamed into place, so a reader sees either no backup or a complete one.
//
// A backup DoFlow 1.19 or earlier made (a tar.gz or copy tree per tool, no format key) is still
// listed and counted by retention, but this version cannot restore it.
//
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): authored as `.ts`, run directly by Node
// native type-stripping — no build step, no runtime dependency. Body stays CommonJS so a `.js`
// caller's `require('../install/backup.ts')` keeps working while the tree is still `.js`. The
// `./paths` require already carries `.ts` (paths migrated first); `../helper/git.ts` is `.ts` too.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceCommit: gitSourceCommit } = require('../helper/git.ts');
const { validateLedger, ownershipKey } = require('../state/index.ts');

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** `<op>_YYYY-MM-DD_HH-MM-SS`, using a caller-supplied Date (never `new Date()` internally — keeps this testable/deterministic). */
function backupId(op: string, date: Date): string {
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
/** A backup retention is removing: renamed here first so a half-removed backup is never listed or counted. */
const REMOVING_PREFIX = '.tmp-del-';
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
const MAX_ID_ATTEMPTS = 1000;
const RENAME_COLLISION_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES']);

/** How many backups install and update keep per scope when `--prune` is not given. */
const DEFAULT_BACKUP_RETENTION = 3;

/** A backup could not be written completely. The caller stops before changing anything. */
class BackupError extends Error {
  declare code: string;
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = 'backup-failed';
  }
}

/** POSIX path of `p` relative to `scopeRoot`, or null when `p` is not strictly inside it. */
function scopeRelative(scopeRoot: string, p: string): string | null {
  const rel = path.relative(scopeRoot, p);
  if (!rel || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return null;
  return rel.split(path.sep).join('/');
}

/** Manifest JSON: two-space indentation, except one compact line per `files` and `excluded` element. */
function serializeManifest(manifest: Record<string, any>): string {
  const body = Object.entries(manifest).map(([key, value]) => {
    if ((key === 'files' || key === 'excluded') && Array.isArray(value) && value.length > 0) {
      return `  ${JSON.stringify(key)}: [\n${value.map((v) => `    ${JSON.stringify(v)}`).join(',\n')}\n  ]`;
    }
    return `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}`;
  });
  return `{\n${body.join(',\n')}\n}\n`;
}

function errorCode(err: any): string { return err.code || err.message; }

/**
 * Copy the files of a backup set into `<backupRoot>/<id>/` (format 2). Returns null for an empty
 * set, without touching the disk. Every failure removes the temp directory and throws BackupError,
 * so a backup either exists complete, manifest included, or does not exist at all.
 */
function createFileBackup({
  operation, set, backupRoot, repoRoot, sourceCommit, version, date, restores = null,
  fsImpl = fs, randomHex = () => crypto.randomBytes(4).toString('hex'),
}: any): null | { id: string; dir: string; files: number; existed: number; absent: number; bytes: number } {
  if (set.entries.length === 0) return null;

  const base = backupId(operation, date);
  const tmpDir = path.join(backupRoot, `${TEMP_PREFIX}${base}-${process.pid}-${randomHex()}`);
  let tmpCreated = false;
  const writeFailure = (err: any) => new BackupError(`could not write ${backupRoot}: ${errorCode(err)}`);

  try {
    try {
      sweepStaleTemps(backupRoot, { fsImpl });
      fsImpl.mkdirSync(backupRoot, { recursive: true });
      fsImpl.mkdirSync(tmpDir);
      tmpCreated = true;
      // When this run started, not `date`: that is the time the backup is named for, and a caller may pass any
      // date. isStaleTemp measures a temp's age from this field.
      const owner = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
      fsImpl.writeFileSync(path.join(tmpDir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: 'wx' });
    } catch (err) { throw writeFailure(err); }

    const files = [];
    const summary = { files: 0, existed: 0, absent: 0, bytes: 0 };
    let external = 0;
    for (const entry of set.entries) {
      const record: any = entry.rel !== null ? { path: entry.rel } : { path: entry.path, outside: true };
      let stat = null;
      try {
        stat = fsImpl.statSync(entry.path);
      } catch (err: any) {
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

    const manifest: any = {
      id: base,
      operation,
      timestamp: date.toISOString(),
      source_path: repoRoot,
      source_commit: sourceCommit ?? gitSourceCommit(repoRoot),
      type: 'files',
      tools_affected: [...new Set(set.entries.flatMap((e: any) => e.harnesses))].sort(),
      format: 2,
      doflow_version: version,
      scope: set.scope,
      scope_root: set.scopeRoot,
      restores,
      summary,
      excluded: set.excluded.map((x: any) => {
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
      } catch (err: any) {
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

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

/**
 * The id of this process's pid namespace where the platform exposes one (Linux: the target of
 * `/proc/self/ns/pid`, such as `pid:[4026531836]`), else the empty string. A pid means something only
 * inside the namespace that issued it; two containers can share a hostname and not a pid space.
 */
function pidNamespaceId(): string {
  try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return ''; }
}

/**
 * Eight hex digits that identify the host and pid namespace in a rename-aside name. A pid means
 * something only in the namespace it was issued in, so an aside is judged by pid only by a process
 * in the same namespace on the same host. Where no namespace id exists the tag is the hostname alone.
 */
function hostTag(hostname: string = os.hostname(), pidNamespace: string = pidNamespaceId()): string {
  return crypto.createHash('sha1').update(`${hostname}\0${pidNamespace}`).digest('hex').slice(0, 8);
}

/**
 * The owner a rename-aside folder (`.tmp-del-<id>-<host tag>-<pid>-<8 hex>`) names, or null when the
 * name does not carry one. Ids contain `-`, so the fields are read from the end. Names without a host
 * tag (an earlier layout that never shipped: it existed only on unreleased commits, so no migration)
 * are unparseable and are kept.
 */
function removingOwner(name: string): { host: string; pid: number } | null {
  const m = /-([0-9a-f]{8})-([0-9]+)-[0-9a-f]{8}$/.exec(name);
  return m ? { host: m[1], pid: Number(m[2]) } : null;
}

function isStaleTemp(dir: string, { now, fsImpl, isAlive, hostname }: any): boolean {
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
 *
 * A `.tmp-del-*` rename-aside is a backup a retention pass is deleting, so age says nothing about it
 * (it keeps the backup's own, possibly old, mtime and may be rolled back if the delete fails). It is
 * removed only by the host and pid namespace named in it, and only when the pid in its name is not
 * alive; any other host's or namespace's aside, and one whose name carries no owner, is left alone.
 */
function sweepStaleTemps(backupRoot: string, { now = Date.now(), fsImpl = fs, isAlive = defaultIsAlive, hostname = os.hostname(), pidNamespace = pidNamespaceId() }: any = {}): number {
  if (!fsImpl.existsSync(backupRoot)) return 0;
  let removed = 0;
  for (const e of fsImpl.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(TEMP_PREFIX)) continue;
    const dir = path.join(backupRoot, e.name);
    if (e.name.startsWith(REMOVING_PREFIX)) {
      // Removed only by the host that made it, and only once its pid is gone there. Another host's
      // (or an unparseable) aside is kept: its pass may be live where this one cannot see it.
      const owner = removingOwner(e.name);
      if (owner === null || owner.host !== hostTag(hostname, pidNamespace) || isAlive(owner.pid)) continue;
    } else if (!isStaleTemp(dir, { now, fsImpl, isAlive, hostname })) continue;
    try {
      fsImpl.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch { /* another run may hold or have removed it */ }
  }
  return removed;
}

/**
 * Classify one backup directory by its manifest: 'format-2', 'newer' (a format this version does
 * not know), 'full' or 'partial' (1.19 or earlier, typed by their manifest), or 'incomplete'
 * (no manifest, or one that does not parse). `manifest` is the parsed object, or null.
 */
function classifyBackupDir(dir: string, { fsImpl = fs }: any = {}): { kind: string; manifest: any } {
  let manifest: any = null;
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
function sortKey(dir: string, { fsImpl = fs, manifest }: any = {}): { id: string; time: number; suffix: number } {
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
function compareSortKeys(a: { id: string; time: number; suffix: number }, b: { id: string; time: number; suffix: number }): number {
  if (a.time !== b.time) return b.time - a.time;
  if (a.suffix !== b.suffix) return b.suffix - a.suffix;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** Bytes of the regular files under `dir`, never following a link; null when any read fails. */
function backupSize(dir: string, { fsImpl = fs }: any = {}): number | null {
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
function formatBytes(n: number | null | undefined): string {
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

/** Security guard: a backup id is a directory *name*, never a path — reject traversal/absolute ids. */
function assertSafeBackupId(bid: string): void {
  if (!bid || bid === '.' || bid.includes('/') || bid.includes('\\') || bid === '..' || bid.includes('..')) {
    throw new Error(`Invalid backup id: '${bid}'`);
  }
}

/** Why a format-2 entry cannot be restored, or null when it can. */
function refusalOf(entry: any, target: string, { scope, scopeRoot, bkDir, fsImpl }: any): string | null {
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
  // A restore chmods the file it writes to this mode, so a manifest that lacks one (or holds anything
  // but a permission mask) is refused here, with a name, rather than failing inside the write.
  if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) return 'invalid mode';
  return null;
}

/**
 * Work out what restoring backup `bid` writes, before anything is written. A format-2 backup
 * restores per file: entries recorded absent are listed and left alone, unsafe entries are refused,
 * and with `explicitTargets` only entries of the named harnesses count. A backup of another format
 * is refused. Reads only.
 */
function planRestore({ bid, backupRoot, scope, scopeRoot, targets, explicitTargets, ledgerFile = null, fsImpl = fs }: any): any {
  assertSafeBackupId(bid);
  const bkDir = path.join(path.resolve(backupRoot), bid);
  if (!fsImpl.existsSync(bkDir)) throw new Error(`Backup not found: ${bid}`);
  const { kind, manifest } = classifyBackupDir(bkDir, { fsImpl });
  if (kind === 'newer') {
    throw new Error(`Backup ${bid} was made by a newer DoFlow (format ${manifest.format}); this version cannot restore it`);
  }
  if (kind !== 'format-2') {
    throw new Error(`Backup ${bid} was made by DoFlow 1.19 or earlier or has no readable manifest; this version cannot restore it`);
  }

  const plan: any = {
    bid,
    bkDir,
    restore: [],
    absent: [],
    refused: [],
    untargeted: 0,
    snapshot: [],
    // --target narrows the ledger with the files: the retired-harness rule of mergeRestoredLedger is off.
    narrowed: Boolean(explicitTargets),
  };
  const wanted = new Set(targets);

  const ledger = typeof ledgerFile === 'string' ? path.resolve(ledgerFile) : null;
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    const harnesses = Array.isArray(entry.harnesses) ? entry.harnesses : [];
    // The ownership ledger restores per row (executeRestore), only the rows of files this restore
    // writes, so --target narrows it with the files and never skips it.
    const isLedger = ledger !== null && entry.outside !== true && typeof entry.path === 'string' && entry.path !== ''
      && path.resolve(scopeRoot, entry.path) === ledger;
    if (!isLedger && explicitTargets && !harnesses.some((h: string) => wanted.has(h))) {
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
    plan.restore.push({ path: target, stored: path.resolve(bkDir, entry.stored), mode: entry.mode, size: entry.size, harnesses, ...(isLedger ? { ledger: true } : {}) });
  }
  plan.snapshot = plan.restore.map((item: any) => ({ path: item.path, harnesses: item.harnesses }));
  return plan;
}

/**
 * The ownership ledger a restore leaves: the backup's rows and tombstones for the files the restore
 * wrote back, and the current ledger for everything else. Rows a later run wrote, rows of harnesses
 * the backup does not hold and rows of MCP entries (a file holding only MCP entries is never backed
 * up) stay as they are; restoring the whole old ledger would make DoFlow forget files and entries it
 * still has on disk. With no current ledger the backup's is taken whole.
 *
 * A harness in `retired` (retired in the registry now, row 127) is the exception: every row of it
 * and its `targets` entry come back as the backup holds them. A sweep that retired it released some
 * rows with no file effect (a file a live harness still claims), so no file of theirs is in the backup,
 * yet the run dropped them. Only the sweep ever changes a retired row, so the backup's copy is never
 * staler than the current one; a current row of it the backup lacks stays. A restored row whose file
 * a live harness now claims is released by the next sweep (claim rule 2), file untouched.
 */
function mergeRestoredLedger(backup: any, current: any, restored: Set<string>, retired: Set<string> = new Set(), lost: Set<string> = new Set()): any {
  if (!current) return backup;
  const at = (target: any) => typeof target === 'string' && restored.has(path.resolve(target));
  const whole = (row: any) => retired.has(row?.harness);
  // A retired row whose file this restore tried and could not write back stays out: it would name a file the next sweep drops as absent.
  const back = backup.resources.filter((r: any) => at(r.target) || (whole(r) && !(typeof r.target === 'string' && lost.has(path.resolve(r.target)))));
  const backKeys = new Set(back.filter(whole).map(ownershipKey));
  const targets = Object.entries(backup.targets ?? {}).filter(([id]) => retired.has(id));
  return {
    ...current,
    ...(targets.length ? { targets: { ...current.targets, ...Object.fromEntries(targets) } } : {}),
    resources: [...current.resources.filter((r: any) => !at(r.target) && !(whole(r) && backKeys.has(ownershipKey(r)))), ...back],
    tombstones: [
      ...(current.tombstones ?? []).filter((t: any) => !at(t.fromTarget)),
      ...(backup.tombstones ?? []).filter((t: any) => at(t.fromTarget)),
    ],
  };
}

/** Ids the registry retires (row 127 IC-001): `registry` when a caller passes one, else the shipped
 * registry. One that cannot be read throws, so a restore stops before it writes anything rather than
 * silently skipping the retired rows and targets. */
function retiredIds(registry: any): Set<string> {
  if (registry === undefined) {
    const { REPO_ROOT } = require('../helper/repo-root.ts');
    try { registry = require('../registry/index.ts').loadRegistry({ repoRoot: REPO_ROOT }); } catch (err: any) {
      throw new BackupError(`cannot read the registry to find retired harnesses: ${err?.message ?? err}`);
    }
  }
  return new Set((Array.isArray(registry?.retired) ? registry.retired : []).map((entry: any) => entry?.id).filter((id: any) => typeof id === 'string'));
}

/** The bytes a ledger restore item writes: the backup's ledger merged onto the current one. */
function restoredLedgerBytes(item: any, restored: Set<string>, retired: Set<string>, lost: Set<string>, fsImpl: any): Buffer {
  const backup = validateLedger(JSON.parse(fsImpl.readFileSync(item.stored, 'utf8')));
  const current = fsImpl.existsSync(item.path) ? validateLedger(JSON.parse(fsImpl.readFileSync(item.path, 'utf8'))) : null;
  return Buffer.from(`${JSON.stringify(validateLedger(mergeRestoredLedger(backup, current, restored, retired, lost)), null, 2)}\n`);
}

/**
 * Carry out a plan from planRestore. Each restore item is written through a temp file renamed
 * over the target (or straight through a symlinked target, which stays a link); a failed item is
 * reported and the rest continue. The ownership ledger goes last and restores only the rows of the
 * files written back before it, plus every row of a retired harness unless --target narrowed the
 * restore (mergeRestoredLedger); `registry` is for tests, omitted the shipped one is read. It never deletes a file and never writes
 * outside `plan.restore`.
 */
function executeRestore(plan: any, { dryRun = false, registry, fsImpl = fs }: any = {}): any {
  // Read before the first write: an unreadable registry stops the restore with nothing changed.
  const retired = dryRun || plan.narrowed || !plan.restore.some((item: any) => item.ledger) ? new Set<string>() : retiredIds(registry);
  const restored = [];
  const failed = [];
  const files = new Set<string>();
  const items = [...plan.restore.filter((item: any) => !item.ledger), ...plan.restore.filter((item: any) => item.ledger)];
  for (const item of items) {
    if (dryRun) {
      restored.push(item.path);
      continue;
    }
    let temp = null;
    try {
      const dir = path.dirname(item.path);
      fsImpl.mkdirSync(dir, { recursive: true });
      const bytes = item.ledger ? restoredLedgerBytes(item, files, retired, new Set([...failed.map((f: any) => f.path), ...plan.refused.map((f: any) => f.path)].filter((p: any) => typeof p === 'string').map((p: string) => path.resolve(p))), fsImpl) : fsImpl.readFileSync(item.stored);
      let isLink = false;
      try {
        isLink = fsImpl.lstatSync(item.path).isSymbolicLink();
      } catch (err: any) {
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
      if (!item.ledger) files.add(path.resolve(item.path));
    } catch (err) {
      if (temp) {
        try { fsImpl.rmSync(temp, { force: true }); } catch { /* best effort */ }
      }
      failed.push({ path: item.path, reason: errorCode(err) });
    }
  }
  return { restored, failed, absent: plan.absent, refused: plan.refused, untargeted: plan.untargeted };
}

/** One `{ row, key }` per backup dir under `root`. Dot-named directories (temps of a run in
 * progress) and symlinks are not backups. */
function readBackupRows(root: string): Array<{ key: any; row: any }> {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e: any) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e: any) => {
      const bkDir = path.join(root, e.name);
      const { kind, manifest: m } = classifyBackupDir(bkDir);
      const key = sortKey(bkDir, { manifest: m });
      const bytes = backupSize(bkDir);
      if (kind === 'incomplete') {
        return { key, row: { id: e.name, operation: 'unknown', type: '?', timestamp: '-', backupRoot: root, format: null, complete: false, bytes } };
      }
      const format = kind === 'format-2' || kind === 'newer' ? m.format : 1;
      const type = { 'format-2': 'files', full: 'full' }[kind] || m.type || '?';
      return { key, row: { id: m.id || e.name, operation: m.operation || 'unknown', type, timestamp: m.timestamp || '-', backupRoot: root, format, complete: true, bytes } };
    });
}

/**
 * List all restore points of this scope, newest first, reading each `.manifest.json`. Every row
 * carries the absolute `backupRoot` it was found in, `format` (2, 1 for 1.19, null when the
 * manifest is missing), `complete` and `bytes` (null when unreadable), and is ordered by the same
 * key retention uses.
 */
function listBackups(backupRoot: string): any[] {
  return readBackupRows(path.resolve(backupRoot)).sort((a, b) => compareSortKeys(a.key, b.key)).map((item) => item.row);
}

/**
 * Keep the newest `keep` backups of the canonical root and remove the rest; `keep` 0 removes
 * nothing. Every DoFlow backup counts, 1.19 and manifest-less ones included, ordered by
 * sortKey; other directories are left alone. Ids in `protect` (the run's own backup) are always kept. A dry run removes and sweeps
 * nothing; `reserve` makes room for a backup the real run would add, and `kept` then counts it.
 */
function applyRetention({ backupRoot, keep, protect = [], reserve = 0, dryRun = false, now = Date.now(), fsImpl = fs }: any): any {
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`Backup retention must be a non-negative whole number, got ${keep}`);
  const result: any = { keep, kept: 0, removed: [], wouldRemove: [], failed: [], sweptTemps: 0 };

  // Only DoFlow backups count: a directory with a readable manifest, or one named like a backup id
  // (a 1.19 or interrupted backup can lack a manifest). Anything else in the root is not ours to
  // delete, and must not take a restore point's place.
  const candidates = [];
  const entries = fsImpl.existsSync(backupRoot) ? fsImpl.readdirSync(backupRoot, { withFileTypes: true }) : [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(backupRoot, e.name);
    const { manifest } = classifyBackupDir(dir, { fsImpl });
    if (!manifest && !ID_TIME.test(e.name)) continue;
    candidates.push(sortKey(dir, { fsImpl, manifest }));
  }
  candidates.sort(compareSortKeys);
  const protectedIds = new Set(protect);
  const protectedCandidates = candidates.filter((c) => protectedIds.has(c.id));
  const ordered = [...protectedCandidates, ...candidates.filter((c) => !protectedIds.has(c.id))];
  const keepCount = keep === 0 ? ordered.length : Math.max(keep - reserve, protectedCandidates.length);
  // The protected backup is the run's own, so one newer than it was made by another run that finished
  // after it; this pass only reaps history older than its own backup.
  const newestProtected = protectedCandidates[0];
  const removal = ordered.slice(keepCount)
    .filter((c) => !newestProtected || compareSortKeys(c, newestProtected) >= 0)
    .map((c) => c.id);

  if (dryRun || keep === 0) {
    if (dryRun) result.wouldRemove = removal;
    result.kept = ordered.length - removal.length + (dryRun ? reserve : 0);
    return result;
  }

  // Also deletes what an earlier pass renamed aside and died before deleting (a `.tmp-del-*` whose pid
  // is dead): already out of every listing, so it goes at once. One whose pid is alive belongs to a
  // pass that may still roll it back, so it is never touched here, whatever its age.
  result.sweptTemps = sweepStaleTemps(backupRoot, { now, fsImpl });
  for (const id of removal) {
    const dir = path.join(backupRoot, id);
    // Another run's retention pass may have removed it already.
    if (!fsImpl.existsSync(dir)) continue;
    // One rename takes the backup out of the listing whole; the deletion then happens out of sight.
    const aside = path.join(backupRoot, `${REMOVING_PREFIX}${id}-${hostTag()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fsImpl.renameSync(dir, aside);
    } catch (err: any) {
      if (err.code !== 'ENOENT') result.failed.push({ id, error: err.message });
      continue;
    }
    try {
      fsImpl.rmSync(aside, { recursive: true, force: true });
      result.removed.push(id);
    } catch (err: any) {
      // Not removed: put it back under its id so it is still counted and listed, as when it was
      // removed in place. If that fails too the aside folder is not listed and the next pass deletes it.
      result.failed.push({ id, error: err.message });
      try { fsImpl.renameSync(aside, dir); } catch { /* the next pass cleans the aside folder */ }
    }
  }
  result.kept = ordered.filter((c) => fsImpl.existsSync(path.join(backupRoot, c.id))).length;
  return result;
}

/** The parenthesised end of a retention line: the `--prune` value given, or the default. */
function retentionNote(prune: number | null | undefined, keep: number): string {
  if (prune === null || prune === undefined) return `keeping the newest ${keep}; --prune N changes this`;
  if (prune === 0) return '--prune 0 keeps every backup';
  return `--prune ${keep}`;
}

module.exports = {
  backupId, listBackups, assertSafeBackupId, scopeRelative, retentionNote,
  hostTag,
  BackupError, DEFAULT_BACKUP_RETENTION, createFileBackup, sweepStaleTemps, classifyBackupDir,
  sortKey, backupSize, formatBytes, planRestore, executeRestore, mergeRestoredLedger, applyRetention,
};
