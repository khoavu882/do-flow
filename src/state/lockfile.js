'use strict';

// doflow.lock — the resolved-projection lockfile. A ledger records what DoFlow OWNS;
// a lock records what DoFlow CHOSE. It pins, per scope: targeted harnesses, selected assets with
// their projection summaries, MCP selections, and the source version they were resolved from, so
// that installs become reproducible and drift becomes a reviewable diff instead of a surprise.
// Deliberately metadata-only: no file contents, no secrets — same posture as the neutral ledger.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicJsonWrite } = require('./index');

const LOCK_VERSION = 1;
const LOCK_FILE = 'doflow.lock';

function lockRoot({ scope, projectRoot = '.', homeDir = os.homedir() }) {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Invalid lock scope: '${scope}'`);
  return scope === 'project' ? path.resolve(projectRoot) : path.resolve(homeDir);
}

function lockPath(options) { return path.join(lockRoot(options), '.doflow', LOCK_FILE); }

function stable(value) {
  if (Array.isArray(value)) return [...value].map(stable).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function defaultLock({ scope, scopeRoot }) {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Invalid lock scope: '${scope}'`);
  return {
    version: LOCK_VERSION,
    scope,
    scopeRoot: path.resolve(scopeRoot),
    generatedAt: null,
    sourceVersion: null,
    targets: [],
    assets: [],
    mcpSelections: {},
  };
}

function validateLock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid doflow.lock: expected object');
  if (value.version !== LOCK_VERSION) throw new Error(`Unsupported doflow.lock version: '${value.version}'`);
  if (value.scope !== 'project' && value.scope !== 'global') throw new Error(`Invalid doflow.lock scope: '${value.scope}'`);
  if (typeof value.scopeRoot !== 'string' || !path.isAbsolute(value.scopeRoot)) throw new Error('Invalid doflow.lock: scopeRoot must be absolute');
  for (const field of ['targets', 'assets']) {
    if (!Array.isArray(value[field])) throw new Error(`Invalid doflow.lock: ${field} must be an array`);
  }
  if (!value.mcpSelections || typeof value.mcpSelections !== 'object' || Array.isArray(value.mcpSelections)) {
    throw new Error('Invalid doflow.lock: mcpSelections must be an object');
  }
  return value;
}

function readLock(options, { fsImpl = fs } = {}) {
  const file = lockPath(options);
  if (!fsImpl.existsSync(file)) return null;
  try { return validateLock(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); }
  catch (error) { throw new Error(`Cannot read doflow.lock '${file}': ${error.message}`); }
}

function writeLock(options, lock, { fsImpl = fs } = {}) {
  // Validate the caller's document first so a foreign version fails loudly here rather than
  // being silently normalized into something no future reader can distinguish.
  validateLock(lock);
  return atomicJsonWrite(lockPath(options), stable({ ...lock, version: LOCK_VERSION }), { fsImpl });
}

/** Compare two lock documents. Arrays are keyed by identity (assets by id, targets by harness,
 * fallback to full JSON), mcpSelections by harness. Returns {added, removed, changed} per section
 * plus a clean flag. */
function diffLocks(previous, next) {
  const key = (entry) => entry?.id ?? entry?.harness ?? JSON.stringify(entry);
  const sectionDiff = (before, after) => {
    const beforeKeys = new Map((before || []).map((entry) => [key(entry), entry]));
    const afterKeys = new Map((after || []).map((entry) => [key(entry), entry]));
    const added = [...afterKeys].filter(([k]) => !beforeKeys.has(k)).map(([, v]) => v);
    const removed = [...beforeKeys].filter(([k]) => !afterKeys.has(k)).map(([, v]) => v);
    const changed = [...afterKeys]
      .filter(([k, v]) => beforeKeys.has(k) && JSON.stringify(beforeKeys.get(k)) !== JSON.stringify(v))
      .map(([, v]) => v);
    return { added, removed, changed };
  };
  const selectionsBefore = previous?.mcpSelections ?? {};
  const selectionsAfter = next?.mcpSelections ?? {};
  const harnesses = new Set([...Object.keys(selectionsBefore), ...Object.keys(selectionsAfter)]);
  const mcpChanged = [...harnesses]
    .filter((harness) => JSON.stringify(selectionsBefore[harness] ?? []) !== JSON.stringify(selectionsAfter[harness] ?? []))
    .map((harness) => ({ harness, before: selectionsBefore[harness] ?? [], after: selectionsAfter[harness] ?? [] }));
  const result = {
    targets: sectionDiff(previous?.targets, next?.targets),
    assets: sectionDiff(previous?.assets, next?.assets),
    mcpSelections: { changed: mcpChanged },
    meta: {
      sourceVersion: (previous?.sourceVersion ?? null) !== (next?.sourceVersion ?? null)
        ? { before: previous?.sourceVersion ?? null, after: next?.sourceVersion ?? null } : null,
    },
  };
  result.clean = ['targets', 'assets'].every((name) => {
    const section = result[name];
    return section.added.length === 0 && section.removed.length === 0 && section.changed.length === 0;
  }) && result.mcpSelections.changed.length === 0 && result.meta.sourceVersion === null;
  return result;
}

/** Delete the lock when nothing remains pinned. Returns true when a file actually went away. */
function removeLock(options, { fsImpl = fs } = {}) {
  const file = lockPath(options);
  if (!fsImpl.existsSync(file)) return false;
  fsImpl.rmSync(file);
  return true;
}

module.exports = { LOCK_VERSION, LOCK_FILE, lockRoot, lockPath, defaultLock, validateLock, readLock, writeLock, diffLocks, removeLock };
