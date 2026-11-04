'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): authored as `.ts`, run directly by Node
// native type-stripping — no build step, no runtime dependency. Body stays CommonJS so a `.js`
// caller's `require('../install/paths.ts')` keeps working while the rest of the tree is still `.js`.
const fs = require('node:fs');
const path = require('node:path');

const DOFLOW_DIR_NAME = '.doflow';
const BACKUP_DIR_NAME = 'backups';
const INSTALL_MANIFEST_FILE_NAME = '.install-manifest.json';

// Explicit migration bridge, mirroring manifest.js's: before 7de6d5f ("centralize lifecycle
// metadata under .doflow") both the install manifest and the backup root were anchored to the
// Claude harness directory, so restore points landed in `<scopeRoot>/.claude/backups` — $HOME
// globally, the project root otherwise. That commit moved the write location to `.doflow/` and
// bridged the manifest, leaving every pre-move restore point unreachable. The two names below
// exist so the READ side of rollback/list-backups can still see what the move left behind.
// Nothing may ever write, prune or delete here: those directories are a user's only recovery
// material and DoFlow no longer owns their lifecycle.
const LEGACY_BACKUP_ANCHOR_DIR_NAME = '.claude';

interface ScopeInput {
  scopeRoot: string;
}

interface DoflowPaths {
  scopeRoot: string;
  doflowRoot: string;
  backupRoot: string;
  legacyBackupReadRoot: string;
  manifestPath: string;
}

/** Read-only legacy backup location for a scope. Never a write or prune target — see the note above. */
function legacyBackupReadRoot({ scopeRoot }: ScopeInput): string {
  if (typeof scopeRoot !== 'string' || !scopeRoot) throw new Error('scopeRoot is required');
  return path.join(path.resolve(scopeRoot), LEGACY_BACKUP_ANCHOR_DIR_NAME, BACKUP_DIR_NAME);
}

/** True for `<anything>/.claude/backups` — used to refuse writes/prunes against the legacy root. */
function isLegacyBackupReadRoot(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  const resolved = path.resolve(candidate);
  return path.basename(resolved) === BACKUP_DIR_NAME
    && path.basename(path.dirname(resolved)) === LEGACY_BACKUP_ANCHOR_DIR_NAME;
}

/** Inverse of `doflowPaths().backupRoot`: recover the scope root from a canonical backup root so a
 * read path handed only that root can still derive the legacy one. Returns null for any path that
 * is not shaped `<scopeRoot>/.doflow/backups` (a test fixture, a hand-passed directory) — the
 * bridge then stays inert rather than inventing a sibling `.claude` next to an arbitrary path. */
function scopeRootFromCanonicalBackupRoot(backupRoot: unknown): string | null {
  if (typeof backupRoot !== 'string' || !backupRoot) return null;
  const resolved = path.resolve(backupRoot);
  if (path.basename(resolved) !== BACKUP_DIR_NAME) return null;
  const doflowRoot = path.dirname(resolved);
  if (path.basename(doflowRoot) !== DOFLOW_DIR_NAME) return null;
  return path.dirname(doflowRoot);
}

/** Resolve DoFlow-owned lifecycle metadata without anchoring it to a harness directory. */
function doflowPaths({ scopeRoot }: ScopeInput): DoflowPaths {
  if (typeof scopeRoot !== 'string' || !scopeRoot) throw new Error('scopeRoot is required');
  const root = path.resolve(scopeRoot);
  const doflowRoot = path.join(root, DOFLOW_DIR_NAME);
  return {
    scopeRoot: root,
    doflowRoot,
    backupRoot: path.join(doflowRoot, BACKUP_DIR_NAME),
    legacyBackupReadRoot: legacyBackupReadRoot({ scopeRoot: root }),
    manifestPath: path.join(doflowRoot, INSTALL_MANIFEST_FILE_NAME),
  };
}

/** The one spelling of a path that ownership comparisons use: `fs.realpathSync` of the resolved path,
 * or the resolved path itself when it does not exist (nothing to follow yet). macOS reaches the
 * temp folder as both /var/... and /private/var/..., and a ledger row written under one spelling
 * must match the other. */
function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function rebaseString(value: string, from: string, to: string): string {
  if (value === from) return to;
  return value.startsWith(from + path.sep) ? to + value.slice(from.length) : value;
}

function rebaseDeep(value: any, from: string, to: string): any {
  if (typeof value === 'string') return rebaseString(value, from, to);
  if (Array.isArray(value)) return value.map((item) => rebaseDeep(item, from, to));
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const key of Object.keys(value)) out[key] = rebaseDeep(value[key], from, to);
    return out;
  }
  return value;
}

/** A ledger read from disk, with every path that names the scope root under a different spelling of
 * it (the aliased path an earlier install recorded) rewritten to `scopeRoot`, the canonical one.
 * The stored format is unchanged; a ledger already in canonical form, with no scope root of its
 * own, or recording an unrelated directory is returned as it came. */
function canonicalLedger(ledger: any, scopeRoot: string): any {
  const recorded = ledger && typeof ledger.scopeRoot === 'string' && ledger.scopeRoot ? path.resolve(ledger.scopeRoot) : null;
  if (!recorded || recorded === scopeRoot || canonicalPath(recorded) !== scopeRoot) return ledger;
  return rebaseDeep(ledger, recorded, scopeRoot);
}

module.exports = {
  canonicalPath,
  canonicalLedger,
  DOFLOW_DIR_NAME,
  BACKUP_DIR_NAME,
  INSTALL_MANIFEST_FILE_NAME,
  LEGACY_BACKUP_ANCHOR_DIR_NAME,
  doflowPaths,
  legacyBackupReadRoot,
  isLegacyBackupReadRoot,
  scopeRootFromCanonicalBackupRoot,
};
