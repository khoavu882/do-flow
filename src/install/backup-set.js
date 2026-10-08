'use strict';
// backup-set.js — the files a run backs up: every file its lifecycle plan is about to write or
// delete, the scripts an adapter copies beside a change's target, the old copy a moved resource
// leaves behind, and files a pending tombstone will sweep. Files holding only MCP entries stay out:
// their ledger row, not a file copy, is how an entry is recovered, and the same file can hold the
// harness's own state, which a rollback must never restore over. DoFlow's own records stay out too.
// Reads only: it stats files and creates nothing.
const fs = require('node:fs');
const path = require('node:path');
const { BackupError, scopeRelative } = require('./backup');

const REASON_ORDER = ['change', 'companion', 'relocated-from', 'tombstone', 'snapshot'];

function byCodePoint(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** What a set entry is on disk now, following links. */
function statEntry(file, fsImpl) {
  let stat;
  try {
    stat = fsImpl.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { kind: 'absent', size: null, mode: null };
    throw new BackupError(`could not read ${file}: ${err.code || err.message}`);
  }
  if (stat.isFile()) return { kind: 'file', size: stat.size, mode: stat.mode & 0o7777 };
  return { kind: 'other', size: null, mode: null };
}

function isAtOrUnder(file, root) {
  const resolved = path.resolve(root);
  return file === resolved || file.startsWith(resolved.endsWith(path.sep) ? resolved : resolved + path.sep);
}

/** Candidates (absolute path -> harnesses and reasons) into a BackupSet, after the exclusions. */
function toBackupSet(candidates, { scope, scopeRoot, exclude, excluded, fsImpl }) {
  const root = path.resolve(scopeRoot);
  const entries = [];
  for (const file of [...candidates.keys()].sort(byCodePoint)) {
    if (exclude.some((x) => isAtOrUnder(file, x))) {
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
    excluded: excluded.sort((a, b) => byCodePoint(a.path, b.path)),
    count: entries.length,
    existing: files.length,
    absent: entries.filter((e) => e.kind === 'absent').length,
    bytes: files.reduce((sum, e) => sum + e.size, 0),
  };
}

function addCandidate(candidates, file, harness, reason) {
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
 */
function backupSetFromPlan({ plan, scope, scopeRoot, exclude = [], fsImpl = fs }) {
  const candidates = new Map();
  const mcpOnly = new Map();
  const resources = plan.ledger?.resources ?? [];
  const tombstones = plan.ledger?.tombstones ?? [];
  // A retained or released change gives up a ledger row and touches no file.
  const changes = plan.changes.filter((change) => change.retained !== true && change.release !== true);

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

  const owned = new Set(resources.filter((r) => typeof r.target === 'string').map((r) => path.resolve(r.target)));
  for (const tombstone of tombstones) {
    if (tombstone.sweptAt || typeof tombstone.fromTarget !== 'string') continue;
    if (owned.has(path.resolve(tombstone.fromTarget)) || !fsImpl.existsSync(tombstone.fromTarget)) continue;
    addCandidate(candidates, tombstone.fromTarget, tombstone.harness, 'tombstone');
  }

  const excluded = [...mcpOnly]
    .filter(([target, onlyMcp]) => onlyMcp && !candidates.has(target))
    .map(([target]) => ({ path: target, reason: 'mcp-entries-only' }));
  return toBackupSet(candidates, { scope, scopeRoot, exclude, excluded, fsImpl });
}

/** A BackupSet of the given absolute paths, for the pre-rollback snapshot. */
function backupSetFromPaths({ items, scope, scopeRoot, exclude = [], fsImpl = fs }) {
  const candidates = new Map();
  for (const item of items) {
    if (item.harnesses.length === 0) addCandidate(candidates, item.path, null, 'snapshot');
    for (const harness of item.harnesses) addCandidate(candidates, item.path, harness, 'snapshot');
  }
  return toBackupSet(candidates, { scope, scopeRoot, exclude, excluded: [], fsImpl });
}

module.exports = { backupSetFromPlan, backupSetFromPaths };
