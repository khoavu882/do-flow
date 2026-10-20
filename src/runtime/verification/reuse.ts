'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { resolveRoots, resolveStorePath } = require('../storage/roots.ts');

const KEY = /^[0-9a-f]{16}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REF = /^[0-9a-f]{32}$/;
const LEVELS = new Set(['L1', 'L2', 'L3']);
const MAX_STREAM_CHARS = 2000;
const REPO_ROOT = path.resolve(__dirname, '../../..');

function isObject(value: any): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: any, required: string[], optional: string[] = []): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}
function optionalCount(value: any): boolean { return value === null || Number.isSafeInteger(value) && value >= 0; }

/** IC-002: validate the closed record/result schemas before any cached PASS is trusted. */
function validRecord(record: any): boolean {
  if (!exactKeys(record, ['v', 'key', 'payloadDigest', 'ref', 'recordedAt', 'level', 'result'])) return false;
  if (record.v !== 1 || typeof record.key !== 'string' || !KEY.test(record.key)
    || typeof record.payloadDigest !== 'string' || !DIGEST.test(record.payloadDigest)
    || typeof record.ref !== 'string' || !REF.test(record.ref)
    || !Number.isSafeInteger(record.recordedAt) || !LEVELS.has(record.level)) return false;
  const result = record.result;
  if (!exactKeys(result, ['status', 'exitCode', 'stdout', 'stderr', 'truncated'], ['tests', 'testsFailed'])) return false;
  if (result.status !== 'PASS' || result.exitCode !== 0
    || typeof result.stdout !== 'string' || result.stdout.length > MAX_STREAM_CHARS
    || typeof result.stderr !== 'string' || result.stderr.length > MAX_STREAM_CHARS
    || typeof result.truncated !== 'boolean') return false;
  if (Object.hasOwn(result, 'tests') && !optionalCount(result.tests)) return false;
  if (Object.hasOwn(result, 'testsFailed') && !optionalCount(result.testsFailed)) return false;
  return true;
}

/** IC-008: resolve the declared project-state store through the shared storage registry. */
function reuseDir({ projectRoot, configDir, env = process.env, fsImpl = fs }: any = {}): string | null {
  try {
    const root = typeof projectRoot === 'string' ? projectRoot
      : typeof configDir === 'string' ? path.dirname(configDir) : process.cwd();
    const registry = loadStorageRegistry({ repoRoot: REPO_ROOT, fsImpl });
    const store = registry.stores.find((entry: any) => entry.id === 'verification-reuse');
    if (!store) return null;
    const roots = resolveRoots({ registry, projectRoot: root, env });
    return resolveStorePath({ store, roots, fsImpl });
  } catch {
    return null;
  }
}

/** IC-003: look up one trusted, current PASS record. Invalid inputs and filesystem faults fail closed. */
function lookupReuse(options: any = {}): any {
  try { return lookupReuseOptions(options || {}); } catch { return { hit: false, reason: 'fault' }; }
}

function lookupReuseOptions({ dir, key, payloadDigest, maxAgeMs, now = Date.now, fsImpl = fs, uid }: any = {}): any {
  if (typeof dir !== 'string' || typeof key !== 'string' || !KEY.test(key)
    || typeof payloadDigest !== 'string' || !DIGEST.test(payloadDigest)
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || typeof now !== 'function') {
    return { hit: false, reason: 'invalid' };
  }
  const file = path.join(dir, `reuse-${key}.json`);
  let stat: any;
  try { stat = fsImpl.lstatSync(file); } catch (error: any) {
    return { hit: false, reason: error?.code === 'ENOENT' ? 'absent' : 'fault' };
  }
  try {
    if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()
      || typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
      return { hit: false, reason: 'untrusted' };
    }
    if (process.platform !== 'win32') {
      const expectedUid = typeof uid === 'number' ? uid : (process as any).getuid?.();
      if ((stat.mode & 0o077) !== 0) return { hit: false, reason: 'untrusted' };
      if (expectedUid !== undefined && stat.uid !== expectedUid) return { hit: false, reason: 'untrusted' };
    }
  } catch {
    return { hit: false, reason: 'fault' };
  }

  let raw: string;
  try { raw = fsImpl.readFileSync(file, 'utf8'); } catch {
    return { hit: false, reason: 'fault' };
  }
  let record: any;
  try { record = JSON.parse(raw); } catch {
    return { hit: false, reason: 'invalid' };
  }
  if (!validRecord(record)) return { hit: false, reason: 'invalid' };
  if (record.key !== key || record.payloadDigest !== payloadDigest) return { hit: false, reason: 'digest-mismatch' };
  let current: number;
  try { current = now(); } catch { return { hit: false, reason: 'fault' }; }
  if (!Number.isSafeInteger(current)) return { hit: false, reason: 'fault' };
  if (record.recordedAt > current) return { hit: false, reason: 'future' };
  if (current - record.recordedAt > maxAgeMs) return { hit: false, reason: 'stale' };
  return { hit: true, record };
}

/** IC-002/IC-003: publish only a PASS through an owner-only temp file and atomic rename. */
function storeReuse(options: any = {}): { stored: boolean; ref: string | null } {
  try { return storeReuseOptions(options || {}); } catch { return { stored: false, ref: null }; }
}

function storeReuseOptions({ dir, key, payloadDigest, level, result, now = Date.now, fsImpl = fs,
  mintRef = () => crypto.randomBytes(16).toString('hex') }: any = {}): { stored: boolean; ref: string | null } {
  let temp: string | null = null;
  let ownsTemp = false;
  try {
    if (typeof dir !== 'string' || typeof key !== 'string' || !KEY.test(key)
      || typeof payloadDigest !== 'string' || !DIGEST.test(payloadDigest)
      || !LEVELS.has(level) || typeof now !== 'function' || typeof mintRef !== 'function'
      || !isObject(result) || result.status !== 'PASS' || result.exitCode !== 0
      || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
      || typeof result.truncated !== 'boolean') return { stored: false, ref: null };
    if (Object.hasOwn(result, 'tests') && !optionalCount(result.tests)) return { stored: false, ref: null };
    if (Object.hasOwn(result, 'testsFailed') && !optionalCount(result.testsFailed)) return { stored: false, ref: null };
    const recordedAt = now();
    if (!Number.isSafeInteger(recordedAt)) return { stored: false, ref: null };
    const ref = mintRef();
    if (typeof ref !== 'string' || !REF.test(ref)) return { stored: false, ref: null };
    const stdout = result.stdout.slice(0, MAX_STREAM_CHARS);
    const stderr = result.stderr.slice(0, MAX_STREAM_CHARS);
    const savedResult: any = {
      status: 'PASS',
      exitCode: 0,
      stdout,
      stderr,
      truncated: result.truncated || result.stdout.length > MAX_STREAM_CHARS || result.stderr.length > MAX_STREAM_CHARS,
    };
    if (Object.hasOwn(result, 'tests')) savedResult.tests = result.tests;
    if (Object.hasOwn(result, 'testsFailed')) savedResult.testsFailed = result.testsFailed;
    const record = { v: 1, key, payloadDigest, ref, recordedAt, level, result: savedResult };
    if (!validRecord(record)) return { stored: false, ref: null };

    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const directory = fsImpl.lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return { stored: false, ref: null };
    fsImpl.chmodSync(dir, 0o700);
    const file = path.join(dir, `reuse-${key}.json`);
    temp = path.join(dir, `reuse-${key}.${ref}.tmp`);
    fsImpl.writeFileSync(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    ownsTemp = true;
    fsImpl.chmodSync(temp, 0o600);
    fsImpl.renameSync(temp, file);
    ownsTemp = false;
    return { stored: true, ref };
  } catch {
    if (ownsTemp && temp) { try { fsImpl.unlinkSync(temp); } catch { /* only this call's unique temp */ } }
    return { stored: false, ref: null };
  }
}

module.exports = { lookupReuse, storeReuse, reuseDir };
