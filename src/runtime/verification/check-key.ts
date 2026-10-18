'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Check key and tree digest (088 E.2, IC-009, DD-2).
 *
 * Computes a deterministic 16-hex key representing a check's execution identity.
 * Two check invocations with equal check keys can safely share results in in-flight
 * deduplication (P5.4, G.4, IC-017).
 *
 * Key = sha16(JSON.stringify([
 *   1,
 *   command,
 *   timeoutMs,
 *   realpath(cwd),
 *   HEAD,
 *   treeDigest,
 *   process.version,
 *   platform,
 *   arch,
 *   envDigest
 * ]))
 *
 * If git faults, or more than 500 files or 50 MB are modified/untracked, treeDigest
 * returns null and checkKey returns null (unkeyable, runs unshared).
 */

const MAX_UNCOMMITTED_FILES = 500;
const MAX_UNCOMMITTED_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * P3 envExclude list (moves to core/registry/verification.json in P5.4, G.4).
 * Variables that vary between runs/attempts/lineages/roles without changing test outcomes.
 */
const DEFAULT_ENV_EXCLUDE = Object.freeze([
  'DOFLOW_RUN_ID',
  'DOFLOW_LINEAGE_ID',
  'DOFLOW_ATTEMPT',
  'DOFLOW_TASK_ID',
  'DOFLOW_SESSION_ROLE',
  'DOFLOW_WORKTREE',
  '_',
  'OLDPWD',
  'PWD',
  'SHLVL',
]);

/**
 * Computes sha256 of sorted NAME=VALUE lines minus excluded environment variables.
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {readonly string[]} [exclude=DEFAULT_ENV_EXCLUDE]
 * @returns {string} sha256 hex digest
 */
function envDigest(
  env: Record<string, string | undefined> = process.env,
  exclude: readonly string[] = DEFAULT_ENV_EXCLUDE,
): string {
  const excludeSet = new Set(exclude);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || excludeSet.has(key)) continue;
    lines.push(`${key}=${value}`);
  }
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * The HEAD commit hash of the git repository at root, or null on git fault.
 * @param {string} root
 * @param {{ spawnSyncImpl?: typeof spawnSync }} [options]
 * @returns {string | null} 40- or 64-character hex commit, or null
 */
function headCommit(root: string, { spawnSyncImpl = spawnSync }: { spawnSyncImpl?: any } = {}): string | null {
  try {
    const res = spawnSyncImpl('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    const trimmed = res.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Computes a digest of all modified and untracked files in the working tree.
 * Returns null if not in a git repository, or if > 500 files or > 50 MB are dirty.
 * @param {string} root
 * @param {{ spawnSyncImpl?: typeof spawnSync, fsImpl?: typeof nodeFs }} [options]
 * @returns {string | null}
 */
function treeDigest(
  root: string,
  { spawnSyncImpl = spawnSync, fsImpl = nodeFs }: { spawnSyncImpl?: any; fsImpl?: any } = {},
): string | null {
  try {
    const res = spawnSyncImpl(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: root, encoding: 'utf8' },
    );
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;

    const raw = res.stdout;
    if (raw.length === 0) {
      // Clean working tree
      return crypto.createHash('sha256').update('clean', 'utf8').digest('hex');
    }

    const tokens = raw.split('\0');
    // The trailing null produces an empty token at the end
    if (tokens.length > 0 && tokens[tokens.length - 1] === '') {
      tokens.pop();
    }

    const entries: Array<{ entry: string; relPath: string }> = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token) continue;
      const status = token.slice(0, 2);
      const relPath = token.slice(3);
      // For rename or copy (R or C), git -z follows with the original path
      if (status.startsWith('R') || status.startsWith('C')) {
        i += 1; // skip second path token
      }

      // Exclude anything under .doflow/
      if (relPath === '.doflow' || relPath.startsWith('.doflow/') || relPath.includes('/.doflow/')) {
        continue;
      }
      entries.push({ entry: token, relPath });
    }

    if (entries.length > MAX_UNCOMMITTED_FILES) {
      return null; // More than 500 uncommitted files -> unkeyable
    }

    // Sort entries deterministically
    entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

    const hasher = crypto.createHash('sha256');
    let totalBytes = 0;

    for (const item of entries) {
      const fullPath = path.resolve(root, item.relPath);
      let fileHash = '';
      try {
        const stat = fsImpl.statSync(fullPath);
        if (stat.isFile()) {
          totalBytes += stat.size;
          if (totalBytes > MAX_UNCOMMITTED_BYTES) {
            return null; // More than 50 MB total dirty content -> unkeyable
          }
          const content = fsImpl.readFileSync(fullPath);
          fileHash = crypto.createHash('sha256').update(content).digest('hex');
        }
      } catch {
        // File may have been deleted or is inaccessible; leave fileHash empty
      }
      hasher.update(item.entry, 'utf8');
      hasher.update('\0', 'utf8');
      hasher.update(fileHash, 'utf8');
      hasher.update('\0', 'utf8');
    }

    return hasher.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Computes checkKey for a command run in cwd.
 * Returns 16 hex chars, or null if unkeyable.
 * @param {Object} input
 * @param {string} input.command
 * @param {number} input.timeoutMs
 * @param {string} input.cwd
 * @param {string | null} [input.head] HEAD commit; resolved from cwd if omitted
 * @param {string | null} [input.tree] treeDigest; resolved from cwd if omitted
 * @param {Record<string, string | undefined>} [input.env=process.env]
 * @param {typeof nodeFs} [input.fsImpl=nodeFs]
 * @param {typeof spawnSync} [input.spawnSyncImpl=spawnSync]
 * @returns {string | null}
 */
function checkKey({
  command,
  timeoutMs,
  cwd,
  head,
  tree,
  env = process.env,
  fsImpl = nodeFs,
  spawnSyncImpl = spawnSync,
}: {
  command: string;
  timeoutMs: number;
  cwd: string;
  head?: string | null;
  tree?: string | null;
  env?: Record<string, string | undefined>;
  fsImpl?: any;
  spawnSyncImpl?: any;
}): string | null {
  if (typeof command !== 'string' || !Number.isFinite(timeoutMs) || typeof cwd !== 'string') {
    return null;
  }

  let realCwd: string;
  try {
    realCwd = fsImpl.realpathSync(cwd);
  } catch {
    return null;
  }

  let resolvedHead = head;
  if (resolvedHead === undefined) {
    resolvedHead = headCommit(realCwd, { spawnSyncImpl });
  }

  let resolvedTree = tree;
  if (resolvedTree === undefined) {
    resolvedTree = treeDigest(realCwd, { spawnSyncImpl, fsImpl });
  }

  if (resolvedHead === null || resolvedTree === null) {
    return null;
  }

  const envDig = envDigest(env);
  const payload = [
    1,
    command,
    timeoutMs,
    realCwd,
    resolvedHead,
    resolvedTree,
    process.version,
    process.platform,
    (process as any).arch,
    envDig,
  ];

  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex').slice(0, 16);
}

module.exports = {
  DEFAULT_ENV_EXCLUDE,
  envDigest,
  headCommit,
  treeDigest,
  checkKey,
};
