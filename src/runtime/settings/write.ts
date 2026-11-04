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
const { containedDoflow } = require('./project-layers.ts');

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

/** How long a writer waits for another writer's lock. */
const LOCK_WAIT_MS = 2000;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * Take `<file>.lock` (created exclusively, holding a token) so one read-merge-rename of a layer runs at a
 * time across processes. A held lock is waited on for LOCK_WAIT_MS, then refused with code `locked`, naming
 * the lock and its age. A lock is never removed automatically, whatever its age: a writer stalled in its
 * critical section would otherwise lose its write silently, and a lock left by a crashed writer is one
 * file the person removes.
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
    let age: number;
    try { age = Math.round((Date.now() - fsImpl.statSync(lock).mtimeMs) / 1000); } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      age = NaN;
    }
    if (Date.now() >= deadline) {
      const aged = Number.isFinite(age) ? `${Math.max(age, 0)} s old` : 'age unknown';
      return invalid(file, `is held by the lock ${lock} (${aged}); nothing was written; if no writer is running, remove that lock file and run it again`, 'locked');
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

/**
 * Where a write to `file` lands. A symlinked settings file (a dotfile manager's link) is written
 * through to its target so the link survives; a project or local file whose link leads outside the
 * project, or leads nowhere, is refused rather than read through or copied.
 */
function writeTarget(file: string, fsImpl: any): { ok: true; target: string } | { ok: false; result: any } {
  let stat: any;
  try { stat = fsImpl.lstatSync(file); } catch { return { ok: true, target: file }; }
  if (!stat.isSymbolicLink()) return { ok: true, target: file };
  let real: string;
  try { real = fsImpl.realpathSync(file); } catch {
    return { ok: false, result: invalid(file, 'is a symbolic link that does not resolve to a file; nothing was written', 'scope') };
  }
  const directory = path.dirname(file);
  if (path.basename(directory) === '.doflow') {
    try {
      const rel = path.relative(fsImpl.realpathSync(path.dirname(directory)), real);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('outside');
    } catch {
      return { ok: false, result: invalid(file, 'is a symbolic link to a path outside the project; nothing was written', 'scope') };
    }
  }
  return { ok: true, target: real };
}

/** The most significant digits a JSON number keeps exactly when it is read as a double and written back. */
const EXACT_DIGITS = 15;
const NUMBER_AT = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * The first top-level key of `text` (a JSON document) holding a number that `JSON.parse` followed by
 * `JSON.stringify` would change in value: more than 15 digits and not a safe integer.
 */
function inexactNumberKey(text: string): string | null {
  let depth = 0;
  let current: string | null = null;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (depth === 1) {
        let after = end + 1;
        while (after < text.length && /\s/.test(text[after])) after++;
        if (text[after] === ':') { try { current = JSON.parse(text.slice(i, end + 1)); } catch { current = null; } }
      }
      i = end + 1;
    } else if (ch === '{' || ch === '[') { depth++; i++; }
    else if (ch === '}' || ch === ']') { depth--; i++; }
    else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER_AT.lastIndex = i;
      const match = NUMBER_AT.exec(text);
      if (!match) { i++; continue; }
      const token = match[0];
      const digits = token.replace(/[eE].*$/, '').replace(/[-.]/g, '').replace(/^0+/, '').replace(/0+$/, '');
      if (digits.length > EXACT_DIGITS && !(/^-?\d+$/.test(token) && Number.isSafeInteger(Number(token))) && current !== null) return current;
      i += token.length;
    } else i++;
  }
  return null;
}

const INVALID = Symbol('invalid layer');

/** The read, merge and rename of `writeLayer`, run while it holds the layer's lock. */
function replaceLayer({ file, registry, set, unsetKeys, scrubKeys, force, expect, backup, fsImpl }: any): any {
  const landing = writeTarget(file, fsImpl);
  if (!landing.ok) return landing.result;
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

  if (layer?.status === 'ok' && typeof layer.source === 'string') {
    const kept = inexactNumberKey(layer.source);
    if (kept !== null && Object.hasOwn(values, kept) && !Object.hasOwn(set, kept)) {
      return invalid(file, `key '${kept}' holds a number with more digits than JSON can rewrite exactly; nothing was written; edit the file by hand`, 'number-precision');
    }
  }

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
    temporary = path.join(path.dirname(landing.target), `.${path.basename(landing.target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    fsImpl.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fsImpl.chmodSync(temporary, 0o600);
    if (path.basename(directory) === '.doflow') {
      const root = path.dirname(directory);
      if (!containedDoflow(root, fsImpl)) {
        return invalid(file, '.doflow symlink points outside the project', 'scope');
      }
    }
    fsImpl.renameSync(temporary, landing.target);
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
