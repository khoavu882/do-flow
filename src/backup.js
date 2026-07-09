'use strict';
// backup.js — port of sync.sh's _backup_id/create_backup/restore_backup/list_backups/prune_backups.
// PARITY: backup id `<op>_YYYY-MM-DD_HH-MM-SS`; full backup = tar.gz per tool (claude excludes
// ./backups to avoid recursion); partial backup (update) = plain dir copy of specific dst files,
// user-inspectable. Each backup dir carries its own `.manifest.json` (id/operation/timestamp/
// source_path/source_commit/type/tools_affected) — distinct from the top-level install manifest
// in manifest.js.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sourceCommit: gitSourceCommit } = require('./git');

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
  const bkDir = path.join(backupRoot, bid);
  if (!fs.existsSync(bkDir)) {
    throw new Error(`Backup not found: ${bid}`);
  }

  let type = 'full';
  const manifestPath = path.join(bkDir, '.manifest.json');
  if (fs.existsSync(manifestPath)) {
    try { type = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).type || 'full'; } catch { /* fall back to 'full' */ }
  }

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

/** List all backups under backupRoot, newest first, reading each `.manifest.json`. */
function listBackups(backupRoot) {
  if (!fs.existsSync(backupRoot)) return [];
  const entries = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(backupRoot, e.name));

  const rows = entries.map((bkDir) => {
    const manifestPath = path.join(bkDir, '.manifest.json');
    const id = path.basename(bkDir);
    if (fs.existsSync(manifestPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return { id: m.id || id, operation: m.operation || 'unknown', type: m.type || '?', timestamp: m.timestamp || '-' };
      } catch { /* fall through to unknown row */ }
    }
    return { id, operation: 'unknown', type: '?', timestamp: '-' };
  });

  rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return rows;
}

/** Delete all but the `keepN` most recently modified backup dirs. Returns ids pruned. */
function pruneBackups(backupRoot, keepN, { dryRun = false } = {}) {
  if (keepN <= 0 || !fs.existsSync(backupRoot)) return [];
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

module.exports = { backupId, createBackup, restoreBackup, listBackups, pruneBackups, assertSafeBackupId };
