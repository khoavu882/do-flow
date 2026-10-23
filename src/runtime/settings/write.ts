'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/** Atomic writer for one user or project settings layer (086 IC-011). */

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadSettingsRegistry } = require('./registry.ts');
const { readLayerFile, validateValue } = require('./files.ts');
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

function writeLayer({ file, set = {}, unset = [], scrubKeys = [], force = false, fsImpl = fs }: any = {}): any {
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

  const changed = layer?.status !== 'ok'
    || scrubKeys.length > 0
    || Object.entries(set).some(([key, value]) => !Object.hasOwn(existing, key) || existing[key] !== value)
    || [...unsetKeys].some((key) => Object.hasOwn(existing, key));
  if (!changed) return { ok: true, file, before, after: existing };

  const values: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(set)) values[key] = value;
  for (const key of unsetKeys) delete values[key];

  const after: Record<string, unknown> = { schema: 1 };
  for (const key of registry.keys.keys()) {
    if (Object.hasOwn(values, key)) after[key] = values[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (key !== 'schema' && !registry.keys.has(key)) {
      Object.defineProperty(after, key, { value, enumerable: true, configurable: true, writable: true });
    }
  }

  const directory = path.dirname(file);
  let temporary: string | null = null;
  try {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    fsImpl.writeFileSync(temporary, `${JSON.stringify(after, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
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

module.exports = { writeLayer, backupLayerFile };
