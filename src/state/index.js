'use strict';

// Neutral DoFlow lifecycle state.  This module intentionally has no knowledge of a harness's
// native directory: callers provide a project root or user home, and adapter-owned paths stay in
// adapter records.  Legacy manifests are an import source only; they are never changed here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { manifestPath, readManifest } = require('../manifest');

const STATE_VERSION = 1;
const LEDGER_FILE = 'ledger.json';
const RECOVERY_DIR = 'recovery';

function assertScope(scope) {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Invalid state scope: '${scope}'`);
}

/** Resolve DoFlow-owned state without deriving it from a harness directory. */
function stateRoot({ scope, projectRoot = '.', homeDir = os.homedir() }) {
  assertScope(scope);
  return scope === 'project'
    ? path.join(path.resolve(projectRoot), '.doflow', 'state')
    : path.join(path.resolve(homeDir), '.doflow', 'state');
}

function ledgerPath(root) { return path.join(root, LEDGER_FILE); }
function recoveryRoot(root) { return path.join(root, RECOVERY_DIR); }

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function atomicJsonWrite(file, value, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fsImpl.renameSync(tmp, file);
  } finally {
    if (fsImpl.existsSync(tmp)) fsImpl.rmSync(tmp, { force: true });
  }
  return file;
}

function defaultLedger({ scope, scopeRoot }) {
  assertScope(scope);
  return {
    version: STATE_VERSION,
    scope,
    scopeRoot: path.resolve(scopeRoot),
    targets: {},
    mcpSelections: {},
    resources: [],
    legacyImports: [],
    lastRecoveryId: null,
  };
}

function validateLedger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid neutral ledger: expected object');
  if (value.version !== STATE_VERSION) throw new Error(`Unsupported neutral ledger version: '${value.version}'`);
  assertScope(value.scope);
  if (typeof value.scopeRoot !== 'string' || !path.isAbsolute(value.scopeRoot)) throw new Error('Invalid neutral ledger: scopeRoot must be absolute');
  for (const field of ['targets', 'mcpSelections']) if (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field])) throw new Error(`Invalid neutral ledger: ${field} must be an object`);
  for (const field of ['resources', 'legacyImports']) if (!Array.isArray(value[field])) throw new Error(`Invalid neutral ledger: ${field} must be an array`);
  return value;
}

function readLedger(root, { fsImpl = fs } = {}) {
  const file = ledgerPath(root);
  if (!fsImpl.existsSync(file)) return null;
  try { return validateLedger(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); }
  catch (error) { throw new Error(`Cannot read neutral ledger '${file}': ${error.message}`); }
}

function writeLedger(root, ledger, options = {}) {
  return atomicJsonWrite(ledgerPath(root), validateLedger(ledger), options);
}

function recoveryId(now = new Date()) {
  return `recovery_${now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}_${crypto.randomBytes(4).toString('hex')}`;
}

function assertSafeRecoveryId(id) {
  if (typeof id !== 'string' || !/^recovery_[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid recovery id: '${id}'`);
}

/** Persist a journal record before native mutation; append-only records make interrupted runs observable. */
function writeRecoveryRecord(root, record, { now = new Date(), fsImpl = fs } = {}) {
  const id = record?.id ?? recoveryId(now);
  assertSafeRecoveryId(id);
  const value = {
    id,
    version: STATE_VERSION,
    status: record?.status ?? 'pending',
    createdAt: record?.createdAt ?? now.toISOString(),
    ...record,
    id,
  };
  if (!Array.isArray(value.changes)) value.changes = [];
  return { id, file: atomicJsonWrite(path.join(recoveryRoot(root), `${id}.json`), value, { fsImpl }), record: value };
}

function readRecoveryRecord(root, id, { fsImpl = fs } = {}) {
  assertSafeRecoveryId(id);
  const file = path.join(recoveryRoot(root), `${id}.json`);
  if (!fsImpl.existsSync(file)) return null;
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read recovery record '${file}': ${error.message}`); }
}

function ownershipKey(record) {
  return [record.harness, record.scope, record.assetId, record.target, record.ownershipIdentity].join('\u0000');
}

function importLegacyResource(resource, scope) {
  if (!resource || typeof resource !== 'object') return null;
  if (typeof resource.target !== 'string' || typeof resource.kind !== 'string' || typeof resource.identity !== 'string') return null;
  return {
    harness: resource.target,
    scope: resource.scope === 'project' || resource.scope === 'global' ? resource.scope : scope,
    assetId: `legacy.${resource.kind}`,
    target: resource.target,
    ownershipIdentity: resource.identity,
    sourceVersion: resource.sourceVersion ?? 'legacy',
    fingerprint: resource.fingerprint ?? null,
    projection: { legacyKind: resource.kind },
    recoveryRef: resource.recoveryPoint ?? null,
    selection: resource.selection ?? null,
  };
}

/**
 * Read-compatible, conservative legacy import.  Only explicit `managed_resources` records are
 * converted to ownership claims; a legacy tool entry alone never authorizes adoption of files.
 */
function migrateLegacyManifest({ root, scope, scopeRoot, claudeDir, now = new Date(), fsImpl = fs }) {
  assertScope(scope);
  const legacyFile = manifestPath(claudeDir);
  const current = readLedger(root, { fsImpl }) ?? defaultLedger({ scope, scopeRoot });
  if (current.scope !== scope || current.scopeRoot !== path.resolve(scopeRoot)) throw new Error('Neutral ledger scope does not match requested migration scope');
  if (current.legacyImports.some((item) => item.path === legacyFile)) return { migrated: false, reason: 'already-imported', ledger: current, legacyFile };
  if (!fsImpl.existsSync(legacyFile)) return { migrated: false, reason: 'legacy-missing', ledger: current, legacyFile };

  const legacy = readManifest(claudeDir);
  if (!legacy || legacy.operation === 'error') return { migrated: false, reason: 'legacy-invalid', ledger: current, legacyFile };
  const resources = legacy.managedResources.map((resource) => importLegacyResource(resource, scope)).filter(Boolean);
  const existing = new Set(current.resources.map(ownershipKey));
  for (const resource of resources) if (!existing.has(ownershipKey(resource))) current.resources.push(resource);

  // The legacy manifest's MCP selection was owned by Claude's config flow.  Do not infer an
  // equivalent selection for Codex or Gemini merely because they happened to share the old file.
  if (Array.isArray(legacy.mcpServers) && !Object.hasOwn(current.mcpSelections, 'claude')) current.mcpSelections.claude = [...legacy.mcpServers];
  for (const [harness, status] of Object.entries(legacy.tools)) {
    if (status?.installed && !current.targets[harness]) current.targets[harness] = { installed: true, lastUpdated: status.last_updated ?? null, imported: true };
  }
  current.legacyImports.push({ path: legacyFile, importedAt: now.toISOString(), sourceFingerprint: fingerprint({ operation: legacy.operation, lastRun: legacy.lastRun, backupId: legacy.backupId, resources: legacy.managedResources }), lastBackupId: legacy.backupId });
  writeLedger(root, current, { fsImpl });
  return { migrated: true, reason: 'imported', ledger: current, legacyFile };
}

module.exports = {
  STATE_VERSION, LEDGER_FILE, RECOVERY_DIR,
  stateRoot, ledgerPath, recoveryRoot, atomicJsonWrite,
  defaultLedger, validateLedger, readLedger, writeLedger,
  recoveryId, writeRecoveryRecord, readRecoveryRecord,
  ownershipKey, importLegacyResource, migrateLegacyManifest,
};
