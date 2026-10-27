'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// doflow.lock — the resolved-projection lockfile. A ledger records what DoFlow OWNS;
// a lock records what DoFlow CHOSE. It pins, per scope: targeted harnesses, selected assets with
// their projection summaries, MCP selections, and the source version they were resolved from, so
// that installs become reproducible and drift becomes a reviewable diff instead of a surprise.
// Deliberately metadata-only: no file contents, no secrets — same posture as the neutral ledger.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicJsonWrite } = require('./index.ts');
const { isPackageId } = require('../helper/package-ids.ts');

// Version plan (122 IC-007): a lock holding no third-party package stays version 1, byte for byte what
// every earlier DoFlow wrote and reads; one holding packages is version 2, which an older DoFlow
// refuses with its existing `Unsupported doflow.lock version` (the fail-closed direction).
const LOCK_VERSION = 2;
const LOCK_VERSION_BASE = 1;
const LOCK_FILE = 'doflow.lock';

function lockRoot({ scope, projectRoot = '.', homeDir = os.homedir() }: { scope: any, projectRoot?: string, homeDir?: string }): string {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Invalid lock scope: '${scope}'`);
  return scope === 'project' ? path.resolve(projectRoot) : path.resolve(homeDir);
}

function lockPath(options: any): string { return path.join(lockRoot(options), '.doflow', LOCK_FILE); }

function stable(value: any): any {
  if (Array.isArray(value)) return [...value].map(stable).sort((a: any, b: any) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function defaultLock({ scope, scopeRoot }: { scope: any, scopeRoot: string }): any {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Invalid lock scope: '${scope}'`);
  return {
    version: LOCK_VERSION_BASE,
    scope,
    scopeRoot: path.resolve(scopeRoot),
    generatedAt: null,
    sourceVersion: null,
    targets: [],
    assets: [],
    mcpSelections: {},
  };
}

const DIGEST = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SOURCE_TYPES = ['local', 'git', 'npm', 'bundled'];
const PACKAGE_FIELDS = ['id', 'version', 'source', 'contentDigest', 'capabilityDigest', 'enabled', 'addedAt'];

/** The package rows of a lock: a v1 lock, an absent section and no lock all read as `[]`. */
function lockPackages(lock: any): any[] {
  return Array.isArray(lock?.packages) ? lock.packages : [];
}

/** Refuse a malformed `packages` section, naming the field. The row is a closed shape (IC-007). */
function validatePackages(value: any): void {
  if (value.scope === 'project') throw new Error('Invalid doflow.lock: packages is not allowed in a project-scope lock');
  if (!Array.isArray(value.packages)) throw new Error('Invalid doflow.lock: packages must be an array');
  const seen = new Set<string>();
  value.packages.forEach((row: any, index: number) => {
    const at = `packages[${index}]`;
    const bad = (field: string, why: string) => new Error(`Invalid doflow.lock: ${at}.${field} ${why}`);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid doflow.lock: ${at} must be an object`);
    for (const key of Object.keys(row)) if (!PACKAGE_FIELDS.includes(key)) throw bad(key, 'is not a package field');
    if (!isPackageId(row.id)) throw bad('id', 'must be a package id');
    if (seen.has(row.id)) throw bad('id', `'${row.id}' is a duplicate`);
    seen.add(row.id);
    if (typeof row.version !== 'string' || row.version === '') throw bad('version', 'must be a non-empty string');
    if (!row.source || typeof row.source !== 'object' || Array.isArray(row.source) || !SOURCE_TYPES.includes(row.source.type)) {
      throw bad('source', `must be an object whose type is one of ${SOURCE_TYPES.join(', ')}`);
    }
    for (const field of ['contentDigest', 'capabilityDigest']) {
      if (typeof row[field] !== 'string' || !DIGEST.test(row[field])) throw bad(field, 'must be 64 lowercase hex characters');
    }
    if (typeof row.enabled !== 'boolean') throw bad('enabled', 'must be a boolean');
    if (typeof row.addedAt !== 'string' || !ISO_UTC.test(row.addedAt) || Number.isNaN(Date.parse(row.addedAt))) {
      throw bad('addedAt', 'must be an ISO 8601 UTC time');
    }
  });
}

function validateLock(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid doflow.lock: expected object');
  if (value.version !== LOCK_VERSION_BASE && value.version !== LOCK_VERSION) throw new Error(`Unsupported doflow.lock version: '${value.version}'`);
  if (value.scope !== 'project' && value.scope !== 'global') throw new Error(`Invalid doflow.lock scope: '${value.scope}'`);
  if (typeof value.scopeRoot !== 'string' || !path.isAbsolute(value.scopeRoot)) throw new Error('Invalid doflow.lock: scopeRoot must be absolute');
  for (const field of ['targets', 'assets']) {
    if (!Array.isArray(value[field])) throw new Error(`Invalid doflow.lock: ${field} must be an array`);
  }
  if (!value.mcpSelections || typeof value.mcpSelections !== 'object' || Array.isArray(value.mcpSelections)) {
    throw new Error('Invalid doflow.lock: mcpSelections must be an object');
  }
  for (const [harness, ids] of Object.entries(value.mcpSelections)) {
    if (!Array.isArray(ids) || !ids.every((id: any) => typeof id === 'string')) {
      throw new Error(`Invalid doflow.lock: mcpSelections.${harness} must be an array of server ids`);
    }
  }
  if ('packages' in value) validatePackages(value);
  return value;
}

function readLock(options: any, { fsImpl = fs }: { fsImpl?: any } = {}): any {
  const file = lockPath(options);
  if (!fsImpl.existsSync(file)) return null;
  try { return validateLock(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); }
  catch (error: any) { throw new Error(`Cannot read doflow.lock '${file}': ${error.message}`); }
}

function writeLock(options: any, lock: any, { fsImpl = fs }: { fsImpl?: any } = {}): any {
  // Validate the caller's document first so a foreign version fails loudly here rather than
  // being silently normalized into something no future reader can distinguish.
  validateLock(lock);
  // The `packages` key is written only when a package is recorded, and then the file is version 2;
  // otherwise it is the version 1 bytes every earlier DoFlow wrote. `stable` orders arrays by their
  // JSON text, so the rows are put back in `id` order afterwards.
  const packages = lockPackages(lock);
  const { packages: _omit, ...rest } = lock;
  const document = stable(packages.length ? { ...rest, version: LOCK_VERSION, packages } : { ...rest, version: LOCK_VERSION_BASE });
  if (packages.length) document.packages = document.packages.sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
  return atomicJsonWrite(lockPath(options), document, { fsImpl });
}

/** The lock's MCP rows for the harnesses it targets. A row naming a harness outside `targets` is
 * ignored by every reader; the next write drops it. */
function pinnedSelections(lock: any): Record<string, any> {
  const targets = new Set((lock?.targets ?? []).map((entry: any) => entry.harness));
  return Object.fromEntries(Object.entries(lock?.mcpSelections ?? {}).filter(([harness]) => targets.has(harness)));
}

/** The facts of a package row that make drift: its source and the time it was added are record keeping. */
const packageFacts = (row: any) => ({ version: row.version, contentDigest: row.contentDigest, capabilityDigest: row.capabilityDigest, enabled: row.enabled });

/** Compare two lock documents. Arrays are keyed by identity (assets and packages by id, targets by
 * harness, fallback to full JSON), packages on their `packageFacts` only, mcpSelections by harness, where an absent row (`null`) and a recorded
 * empty selection (`[]`) differ. Returns {added, removed, changed} per section plus a clean flag. */
function diffLocks(previousLock: any, nextLock: any): any {
  // Compare in the order writeLock stores, so a document built in memory never differs from the
  // file it was written to.
  const previous = previousLock && stable(previousLock);
  const next = nextLock && stable(nextLock);
  const key = (entry: any) => entry?.id ?? entry?.harness ?? JSON.stringify(entry);
  const sectionDiff = (before: any, after: any, compared: (entry: any) => any = (entry) => entry) => {
    const beforeKeys = new Map<string, any>((before || []).map((entry: any): [string, any] => [key(entry), entry]));
    const afterKeys = new Map<string, any>((after || []).map((entry: any): [string, any] => [key(entry), entry]));
    const added = [...afterKeys].filter(([k]) => !beforeKeys.has(k)).map(([, v]) => v);
    const removed = [...beforeKeys].filter(([k]) => !afterKeys.has(k)).map(([, v]) => v);
    const changed = [...afterKeys]
      .filter(([k, v]) => beforeKeys.has(k) && JSON.stringify(compared(beforeKeys.get(k))) !== JSON.stringify(compared(v)))
      .map(([, v]) => v);
    return { added, removed, changed };
  };
  const selectionsBefore = pinnedSelections(previous);
  const selectionsAfter = pinnedSelections(next);
  const harnesses = new Set([...Object.keys(selectionsBefore), ...Object.keys(selectionsAfter)]);
  const mcpChanged = [...harnesses]
    .filter((harness) => JSON.stringify(selectionsBefore[harness] ?? null) !== JSON.stringify(selectionsAfter[harness] ?? null))
    .map((harness) => ({ harness, before: selectionsBefore[harness] ?? null, after: selectionsAfter[harness] ?? null }));
  const result: any = {
    targets: sectionDiff(previous?.targets, next?.targets),
    assets: sectionDiff(previous?.assets, next?.assets),
    packages: sectionDiff(previous?.packages, next?.packages, (row) => stable(packageFacts(row))),
    mcpSelections: { changed: mcpChanged },
    meta: {
      sourceVersion: (previous?.sourceVersion ?? null) !== (next?.sourceVersion ?? null)
        ? { before: previous?.sourceVersion ?? null, after: next?.sourceVersion ?? null } : null,
    },
  };
  result.clean = ['targets', 'assets', 'packages'].every((name) => {
    const section = result[name];
    return section.added.length === 0 && section.removed.length === 0 && section.changed.length === 0;
  }) && result.mcpSelections.changed.length === 0 && result.meta.sourceVersion === null;
  return result;
}

/** Delete the lock when nothing remains pinned. Returns true when a file actually went away. */
function removeLock(options: any, { fsImpl = fs }: { fsImpl?: any } = {}): boolean {
  const file = lockPath(options);
  if (!fsImpl.existsSync(file)) return false;
  fsImpl.rmSync(file);
  return true;
}

module.exports = {
  LOCK_VERSION, LOCK_VERSION_BASE, LOCK_FILE, lockRoot, lockPath, defaultLock, validateLock, lockPackages, readLock, writeLock, pinnedSelections, diffLocks, removeLock,
};
