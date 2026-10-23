'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/** Atomic writer for one user or project settings layer (086 IC-011). */

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadSettingsRegistry } = require('./registry.ts');
const { MAX_BYTES, readLayerFile, validateValue } = require('./files.ts');
const { clearSettingsCache } = require('./resolve.ts');

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(file: string, detail: string, code: string | null = null) {
  return { ok: false as const, reason: 'config-invalid' as const, code, detail: `${file}: ${detail}` };
}

function scrub(value: any, keys: Set<string>): any {
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, keys));
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keys.has(key)) Object.defineProperty(out, key, { value: scrub(entry, keys), enumerable: true, configurable: true, writable: true });
  }
  return out;
}

/** A layer document as written: `schema` first, then the owned keys in registry order, then the rest. */
function layerDocument(registry: any, values: Record<string, unknown>): Record<string, unknown> {
  const after: Record<string, unknown> = { schema: 1 };
  for (const key of registry.keys.keys()) {
    if (Object.hasOwn(values, key)) after[key] = values[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (key !== 'schema' && !registry.keys.has(key)) {
      Object.defineProperty(after, key, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  return after;
}

/** The bytes of a layer file. The one serializer: a check that measures a write measures these. */
function serializeLayer(document: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/** The refusal for bytes the layer reader (`readLayerFile`, MAX_BYTES) would reject as too-large. */
function oversize(file: string, bytes: Buffer): any {
  if (bytes.length <= MAX_BYTES) return null;
  return invalid(file, `would be ${bytes.length} bytes as written, over the ${MAX_BYTES}-byte limit of a settings file`, 'too-large');
}

function backupLayerFile(file: string, fsImpl = fs): any {
  let contents;
  try {
    contents = fsImpl.readFileSync(file);
  } catch (error: any) {
    return invalid(file, `could not be preserved: ${error?.message || 'could not be read'}`);
  }

  for (let index = 0; ; index++) {
    const backup = `${file}.bak${index === 0 ? '' : `.${index}`}`;
    try {
      fsImpl.writeFileSync(backup, contents, { flag: 'wx', mode: 0o600 });
      fsImpl.chmodSync(backup, 0o600);
      return { ok: true, file: backup };
    } catch (error: any) {
      if (error?.code === 'EEXIST') continue;
      try { fsImpl.rmSync(backup, { force: true }); } catch { /* preserve the primary refusal */ }
      return invalid(file, `could not be preserved: ${error?.message || 'could not be written'}`);
    }
  }
}

/**
 * Keep the bytes a write replaces in `<file>.config.bak`, replaced atomically on every write, so the
 * backup stays one file however often a layer is written. It is not backupLayerFile's `.bak[.N]`
 * series, which preserves a malformed file once and must never be overwritten by a later write.
 */
function replaceBackup(file: string, fsImpl: any): any {
  const backup = `${file}.config.bak`;
  const temporary = path.join(path.dirname(file), `.${path.basename(backup)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, fsImpl.readFileSync(file), { flag: 'wx', mode: 0o600 });
    fsImpl.chmodSync(temporary, 0o600);
    fsImpl.renameSync(temporary, backup);
    return { ok: true, file: backup };
  } catch (error: any) {
    try { fsImpl.rmSync(temporary, { force: true }); } catch { /* preserve the primary refusal */ }
    return invalid(file, `could not be backed up: ${error?.message || 'could not be written'}`);
  }
}

/** How long a writer waits for another writer's lock, and the age at which a lock is a crashed holder's. */
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * Take `<file>.lock` (created exclusively, holding a token) so one read-merge-rename of a layer runs at a
 * time across processes. A held lock is waited on for LOCK_WAIT_MS, then refused with code `locked`. A
 * lock older than LOCK_STALE_MS is a crashed holder's (a holder keeps it for one read and one write) and
 * is removed if its token is still the one judged stale. Ceiling: that re-read and the removal are not
 * one step, so a lock taken in between can still be removed; a live holder is never near the stale age.
 */
function acquireLock(file: string, fsImpl: any): any {
  const lock = `${file}.lock`;
  const token = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fsImpl.writeFileSync(lock, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { ok: true, lock, token };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') return invalid(file, `could not be locked: ${error?.message || 'lock not created'}`, 'locked');
    }
    try {
      const seen = fsImpl.readFileSync(lock, 'utf8');
      if (Date.now() - fsImpl.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        // Remove only the lock judged stale: a writer that removed it first and took its own has a new
        // token. Residual: a lock taken between this re-read and the removal is still removed.
        if (fsImpl.readFileSync(lock, 'utf8') === seen) fsImpl.rmSync(lock, { force: true });
        continue;
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
    }
    if (Date.now() >= deadline) {
      return invalid(file, `is being written by another process (${lock} is held); nothing was written, run it again`, 'locked');
    }
    Atomics.wait(PAUSE, 0, 0, 20);
  }
}

function releaseLock({ lock, token }: any, fsImpl: any): void {
  try {
    if (fsImpl.readFileSync(lock, 'utf8') === token) fsImpl.rmSync(lock, { force: true });
  } catch { /* already gone; keep the primary result */ }
}

/**
 * Write one layer. The read, merge and rename run under the layer's lock (`acquireLock`), so two
 * writers of different keys never drop each other's key. `expect` (optional): the document the caller
 * validated against, or null when it found no file; when the file under the lock differs, nothing is
 * written and the result has code `changed`, so a caller's verdict always describes what it replaces.
 * `backup` (optional): before an existing file is replaced, keep its bytes (`replaceBackup`).
 */
function writeLayer({ file, set = {}, unset = [], scrubKeys = [], force = false, expect, backup = false, fsImpl = fs }: any = {}): any {
  if (typeof file !== 'string' || file.length === 0) {
    return { ok: false, reason: 'config-invalid', detail: 'file is required' };
  }
  if (!isObject(set) || !Array.isArray(unset) || unset.some((key) => typeof key !== 'string')) {
    return invalid(file, 'set must be an object and unset must be an array of keys');
  }

  if (!Array.isArray(scrubKeys) || scrubKeys.some((key: any) => typeof key !== 'string')) {
    return invalid(file, 'scrubKeys must be an array of keys');
  }
  const loaded = loadSettingsRegistry({ repoRoot: REPO_ROOT, fsImpl });
  if (!loaded.ok) return invalid(file, `settings registry is invalid: ${loaded.detail}`);
  const { registry } = loaded;
  const unsetKeys = new Set(unset);
  for (const [key, value] of Object.entries(set)) {
    const spec = registry.keys.get(key);
    if (!spec) return invalid(file, `unknown owned key '${key}'`);
    if (unsetKeys.has(key)) return invalid(file, `key '${key}' cannot be both set and unset`);
    const fault = validateValue(spec, value, registry.enumValues(key));
    if (fault) return invalid(file, `'${key}' ${fault.reason}`);
  }
  for (const key of unsetKeys) {
    if (!registry.keys.has(key)) return invalid(file, `unknown owned key '${key}'`);
  }
  for (const key of scrubKeys) {
    if (!registry.keys.has(key) || !Object.hasOwn(set, key)) return invalid(file, `scrub key '${key}' must be a registered key also present in set`);
  }

  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch (error: any) {
    return invalid(file, error?.message || 'could not be written');
  }
  const held = acquireLock(file, fsImpl);
  if (!held.ok) return held;
  try {
    return replaceLayer({ file, registry, set, unsetKeys, scrubKeys, force, expect, backup, fsImpl });
  } finally {
    releaseLock(held, fsImpl);
  }
}

const INVALID = Symbol('invalid layer');

/** The read, merge and rename of `writeLayer`, run while it holds the layer's lock. */
function replaceLayer({ file, registry, set, unsetKeys, scrubKeys, force, expect, backup, fsImpl }: any): any {
  let before: Record<string, unknown> | null = null;
  let existing: Record<string, unknown> = {};
  let layer: any;
  try {
    layer = readLayerFile(file, { registry, fsImpl, includeDocument: true });
    if (layer.status === 'invalid') {
      if (!force) return invalid(file, `${layer.code}: ${layer.reason}`, layer.code);
    } else if (layer.status === 'ok') {
      if (!isObject(layer.document)) {
        if (!force) return invalid(file, 'must be a JSON object', 'unparseable');
      } else {
        before = layer.document;
        existing = scrub(layer.document, new Set(scrubKeys));
      }
    }
  } catch (error: any) {
    if (!force) return invalid(file, 'could not be read');
    before = null;
    existing = {};
  }

  if (expect !== undefined) {
    const current = layer?.status === 'ok' ? layer.document : layer?.status === 'absent' ? null : INVALID;
    if (!isDeepStrictEqual(current, expect)) {
      return invalid(file, 'changed while this write was being checked; nothing was written', 'changed');
    }
  }

  const changed = layer?.status !== 'ok'
    || scrubKeys.length > 0
    || Object.entries(set).some(([key, value]) => !Object.hasOwn(existing, key) || existing[key] !== value)
    || [...unsetKeys].some((key) => Object.hasOwn(existing, key));
  if (!changed) return { ok: true, file, before, after: existing };

  const values: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(set)) values[key] = value;
  for (const key of unsetKeys) delete values[key];

  const after = layerDocument(registry, values);
  const bytes = serializeLayer(after);
  const tooLarge = oversize(file, bytes);
  if (tooLarge) return tooLarge;

  if (backup && layer?.status !== 'absent') {
    const kept = replaceBackup(file, fsImpl);
    if (!kept.ok) return kept;
  }

  const directory = path.dirname(file);
  let temporary: string | null = null;
  try {
    temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    fsImpl.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fsImpl.chmodSync(temporary, 0o600);
    fsImpl.renameSync(temporary, file);
    temporary = null;
    clearSettingsCache();
    return { ok: true, file, before, after };
  } catch (error: any) {
    return invalid(file, error?.message || 'could not be written');
  } finally {
    if (temporary !== null) {
      try { fsImpl.rmSync(temporary, { force: true }); } catch { /* keep the primary result */ }
    }
  }
}

module.exports = { writeLayer, backupLayerFile, layerDocument, serializeLayer, oversize };
