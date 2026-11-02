'use strict';

/**
 * The intake manifest (136 IC-007): `additional-context/.intake/manifest.json`, the one record of every sort
 * and every filed prompt. It is rewritten whole through a temporary file and a rename, under the
 * `acquireLock` lock `task-state.ts` provides for its own files, the way `decision-register.ts` writes its
 * register. The reader refuses what it cannot trust (invalid JSON, a newer schema, a path that leaves the
 * folder) with an `IntakeUsageError` and never rewrites such a file: the manifest is evidence of what moved.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { acquireLock } = require('../task-state.ts');

const MANIFEST_SCHEMA = 1;
const INTAKE_DIR = '.intake';
const MANIFEST_FILE = 'manifest.json';
const STATES = ['planned', 'done', 'failed', 'undone', 'undo-skipped'];
const HASH = /^sha256:[0-9a-f]{64}$/;

/** A caller mistake or an input the engine refuses to guess at (exit 2). */
class IntakeUsageError extends Error {}

function manifestFile(contextDir: string): string { return path.join(contextDir, INTAKE_DIR, MANIFEST_FILE); }

/** True for a relative path of plain segments: nothing absolute, no `..`, no hidden segment, no backslash. */
function isConfinedPath(rel: any): boolean {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0')) return false;
  return rel.split('/').every((segment: string) => segment !== '' && !segment.startsWith('.'));
}

function badManifest(file: string, why: string): IntakeUsageError {
  return new IntakeUsageError(`${file} ${why}; the intake manifest is never rewritten when it cannot be trusted. Restore it or move it aside.`);
}

function validateMove(move: any, file: string, where: string): void {
  const ok = move && typeof move === 'object'
    && (move.from === null || isConfinedPath(move.from))
    && isConfinedPath(move.to)
    && typeof move.sha256 === 'string' && HASH.test(move.sha256)
    && Number.isInteger(move.bytes) && move.bytes >= 0
    && typeof move.at === 'string'
    && STATES.includes(move.state)
    && (move.reason === null || typeof move.reason === 'string');
  if (!ok) throw badManifest(file, `has a malformed or unconfined move at ${where}`);
}

/** The manifest, or an empty one when none exists. Throws IntakeUsageError for a file it cannot trust. */
function readManifest(contextDir: string, fsImpl: any = nodeFs): any {
  const file = manifestFile(contextDir);
  if (!fsImpl.existsSync(file)) return { schema: MANIFEST_SCHEMA, runs: [] };
  let data: any;
  try {
    data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (error: any) {
    throw badManifest(file, `is not valid JSON (${error.message})`);
  }
  if (!data || typeof data !== 'object' || !Number.isInteger(data.schema) || !Array.isArray(data.runs)) {
    throw badManifest(file, 'is not an intake manifest');
  }
  if (data.schema > MANIFEST_SCHEMA) {
    throw new IntakeUsageError(`${file} is schema ${data.schema} and this DoFlow reads schema ${MANIFEST_SCHEMA}; upgrade DoFlow. The manifest was not touched.`);
  }
  if (data.schema !== MANIFEST_SCHEMA) throw badManifest(file, `has schema ${data.schema}`);
  data.runs.forEach((run: any, i: number) => {
    const ok = run && typeof run === 'object' && typeof run.id === 'string' && ['sort', 'file-prompt'].includes(run.action)
      && Array.isArray(run.createdDirs) && run.createdDirs.every(isConfinedPath) && Array.isArray(run.moves);
    if (!ok) throw badManifest(file, `has a malformed run at runs[${i}]`);
    run.moves.forEach((move: any, j: number) => validateMove(move, file, `runs[${i}].moves[${j}]`));
  });
  return data;
}

/** Writes the manifest whole: temp file, then rename, so a reader sees the old file or the new one. */
function writeManifest(contextDir: string, manifest: any, fsImpl: any = nodeFs): void {
  const file = manifestFile(contextDir);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fsImpl.renameSync(tmp, file);
  } catch (error: any) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw error;
  }
}

/** Runs `fn` holding the manifest's lock. A lock that cannot be taken throws the lock error unchanged. */
function withManifestLock<T>(contextDir: string, fn: () => T, fsImpl: any = nodeFs): T {
  fsImpl.mkdirSync(path.join(contextDir, INTAKE_DIR), { recursive: true });
  const release = acquireLock(fsImpl, manifestFile(contextDir));
  try {
    return fn();
  } finally {
    release();
  }
}

/** `run-<UTC yyyymmddThhmmssZ>-<4 hex>`. */
function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `run-${stamp}-${nodeCrypto.randomBytes(2).toString('hex')}`;
}

module.exports = { readManifest, writeManifest, withManifestLock, newRunId, manifestFile, isConfinedPath, IntakeUsageError, MANIFEST_SCHEMA, INTAKE_DIR };
