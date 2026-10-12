'use strict';
// backup-set.js — the files a run backs up: every file its lifecycle plan is about to write or
// delete, the scripts an adapter copies beside a change's target, the old copy a moved resource
// leaves behind, and files a pending tombstone will sweep. Files holding only MCP entries stay out:
// their ledger row, not a file copy, is how an entry is recovered, and the same file can hold the
// harness's own state, which a rollback must never restore over. DoFlow's own records stay out too,
// except the ones named in `records`: the ownership ledger rides along with the files, because a
// rollback that restores files without the rows describing them leaves every later update and
// remove refusing those files as modified outside DoFlow.
// Reads only: it stats files and creates nothing.
//
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): authored as `.ts`, run directly by Node
// native type-stripping — no build step, no runtime dependency. Body stays CommonJS so a `.js`
// caller's `require('../install/backup-set.ts')` keeps working while the tree is still `.js`. The
// `./backup` require carries `.ts` because backup migrated in the same slice.
const fs = require('node:fs');
const path = require('node:path');
const { BackupError, scopeRelative } = require('./backup.ts');

const REASON_ORDER = ['change', 'companion', 'relocated-from', 'tombstone', 'snapshot', 'record'];

function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** What a set entry is on disk now, following links. */
function statEntry(file: string, fsImpl: any): { kind: string; size: number | null; mode: number | null } {
  let stat;
  try {
    stat = fsImpl.statSync(file);
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { kind: 'absent', size: null, mode: null };
    throw new BackupError(`could not read ${file}: ${err.code || err.message}`);
  }
  if (stat.isFile()) return { kind: 'file', size: stat.size, mode: stat.mode & 0o7777 };
  return { kind: 'other', size: null, mode: null };
}

function isAtOrUnder(file: string, root: string): boolean {
  const resolved = path.resolve(root);
  return file === resolved || file.startsWith(resolved.endsWith(path.sep) ? resolved : resolved + path.sep);
}

/** Candidates (absolute path -> harnesses and reasons) into a BackupSet, after the exclusions.
 * A path in `records` is kept even under an excluded root. */
function toBackupSet(candidates: Map<string, any>, { scope, scopeRoot, exclude, excluded, records = [], fsImpl }: any): any {
  const root = path.resolve(scopeRoot);
  const kept = new Set(records.map((file: string) => path.resolve(file)));
  const entries = [];
  for (const file of [...candidates.keys()].sort(byCodePoint)) {
    if (!kept.has(file) && exclude.some((x: string) => isAtOrUnder(file, x))) {
      excluded.push({ path: file, reason: 'doflow-state' });
      continue;
    }
    const { harnesses, reasons } = candidates.get(file);
    entries.push({
      path: file,
      rel: scopeRelative(root, file),
      harnesses: [...harnesses].sort(byCodePoint),
      reasons: REASON_ORDER.filter((reason) => reasons.has(reason)),
      ...statEntry(file, fsImpl),
    });
  }
  const files = entries.filter((e) => e.kind === 'file');
  return {
    scope,
    scopeRoot: root,
    entries,
    excluded: excluded.sort((a: any, b: any) => byCodePoint(a.path, b.path)),
    count: entries.length,
    existing: files.length,
    absent: entries.filter((e) => e.kind === 'absent').length,
    bytes: files.reduce((sum, e) => sum + (e.size as number), 0),
  };
}

function addCandidate(candidates: Map<string, any>, file: string, harness: string | null, reason: string): void {
  const key = path.resolve(file);
  if (!candidates.has(key)) candidates.set(key, { harnesses: new Set(), reasons: new Set() });
  const item = candidates.get(key);
  if (harness) item.harnesses.add(harness);
  item.reasons.add(reason);
}

/**
 * The files a lifecycle plan's apply can overwrite or delete, as a BackupSet.
 * `exclude` lists DoFlow's own paths (the backup root, the state root, the install manifest, the
 * lock); an entry at or under one of them is reported in `excluded`, not backed up.
 * `records` lists DoFlow record files backed up beside those files although an `exclude` root holds
 * them (the ownership ledger), with no harness; a rollback restores only the ledger rows of the files
 * it writes back (backup.ts mergeRestoredLedger). They join only a set that holds some file already,
 * so a run that backs up nothing still backs up nothing.
 */
function backupSetFromPlan({ plan, scope, scopeRoot, exclude = [], records = [], fsImpl = fs }: any): any {
  const candidates = new Map();
  const mcpOnly = new Map();
  const resources = plan.ledger?.resources ?? [];
  const tombstones = plan.ledger?.tombstones ?? [];
  // A retained or released change gives up a ledger row and touches no file.
  const changes = plan.changes.filter((change: any) => change.retained !== true && change.release !== true);

  for (const change of changes) {
    const target = path.resolve(change.target);
    if (change.kind === 'mcp-server') {
      if (!mcpOnly.has(target)) mcpOnly.set(target, true);
      continue;
    }
    mcpOnly.set(target, false);
    addCandidate(candidates, target, change.harness, 'change');
    for (const companion of change.companionTargets ?? []) {
      if (typeof companion === 'string') addCandidate(candidates, companion, change.harness, 'companion');
    }
    if ((change.operation === 'create' || change.operation === 'update') && typeof change.identity === 'string') {
      for (const resource of resources) {
        if (resource.harness !== change.harness || resource.assetId !== change.assetId || resource.identity !== change.identity) continue;
        if (resource.kind === 'mcp-server' || typeof resource.target !== 'string') continue;
        if (path.resolve(resource.target) === target || !fsImpl.existsSync(resource.target)) continue;
        addCandidate(candidates, resource.target, resource.harness, 'relocated-from');
      }
    }
  }

  const owned = new Set(resources.filter((r: any) => typeof r.target === 'string').map((r: any) => path.resolve(r.target)));
  for (const tombstone of tombstones) {
    if (tombstone.sweptAt || typeof tombstone.fromTarget !== 'string') continue;
    if (owned.has(path.resolve(tombstone.fromTarget)) || !fsImpl.existsSync(tombstone.fromTarget)) continue;
    addCandidate(candidates, tombstone.fromTarget, tombstone.harness, 'tombstone');
  }

  const excluded = [...mcpOnly]
    .filter(([target, onlyMcp]) => onlyMcp && !candidates.has(target))
    .map(([target]) => ({ path: target, reason: 'mcp-entries-only' }));
  if (candidates.size) for (const file of records) addCandidate(candidates, file, null, 'record');
  return toBackupSet(candidates, { scope, scopeRoot, exclude, excluded, records, fsImpl });
}

/** A BackupSet of the given absolute paths, for the pre-rollback snapshot. `records` as for
 * backupSetFromPlan: a restored ledger is snapshotted too, so the snapshot rolls back as a whole. */
function backupSetFromPaths({ items, scope, scopeRoot, exclude = [], records = [], fsImpl = fs }: any): any {
  const candidates = new Map();
  for (const item of items) {
    if (item.harnesses.length === 0) addCandidate(candidates, item.path, null, 'snapshot');
    for (const harness of item.harnesses) addCandidate(candidates, item.path, harness, 'snapshot');
  }
  return toBackupSet(candidates, { scope, scopeRoot, exclude, excluded: [], records, fsImpl });
}

module.exports = { backupSetFromPlan, backupSetFromPaths };
