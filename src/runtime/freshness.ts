'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { REPO_ROOT } = require('../helper/repo-root.ts');
const { measureTreeState } = require('./source-version.ts');


// Freshness is measured against the bytes observed, not whether the file was clean at HEAD.
// Git identity remains provenance and a conservative fallback for older records without hashes.
function fileHash(root: string, locator: any): string | null {
  if (!locator?.file) return null;
  try {
    const absolute = path.resolve(root, locator.file);
    if (!fs.statSync(absolute).isFile()) return null;
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`;
  } catch { return null; }
}

/**
 * IC-007: the root a relative locator.file is read in: sourceRoot, the checkout the verb runs in,
 * when the file is there; else the record store's root when it holds the file (a linked worktree's
 * feature folder kept only in the main checkout, 115 IC-004); else sourceRoot. Ceiling: a file the
 * worktree deleted is read from the main checkout's copy.
 */
function fileRootFor(sourceRoot: string, stateRoot: string, locator: any): string {
  const file = locator?.file;
  if (typeof file !== 'string' || file === '' || path.isAbsolute(file) || path.resolve(sourceRoot) === path.resolve(stateRoot)) return sourceRoot;
  const exists = (root: string) => { try { return fs.statSync(path.resolve(root, file)).isFile(); } catch { return false; } };
  return !exists(sourceRoot) && exists(stateRoot) ? stateRoot : sourceRoot;
}

// IC-007: a relative locator.file is hashed in sourceRoot, the checkout the verb runs in; `root`
// (the record store) is only the default. An absolute locator.file is hashed as is.
function measureFreshness(root: string, locator: any, gitCommit: any, sourceRoot: string = root): any {
  return { gitCommit, fileHash: fileHash(fileRootFor(sourceRoot, root, locator), locator), observedAt: new Date().toISOString(), status: 'FRESH' };
}

class FreshnessValidator {
  repoRoot: string;
  treeRoot: string;
  sourceRoot: string;
  gitRunner: (args: string[], cwd?: string) => string | null;
  declare diffCache?: Map<string, Set<string>>;
  declare treeFingerprint?: string | null;
  validatingLedger: boolean;

  /**
   * @param {Object} [options]
   * @param {string} [options.repoRoot]
   * @param {string} [options.treeRoot]
   * @param {string} [options.sourceRoot] checkout a relative locator.file is hashed in (default repoRoot)
   * @param {Function} [options.gitRunner]
   */
  constructor(options: any = {}) {
    this.repoRoot = options.repoRoot || REPO_ROOT;
    this.treeRoot = options.treeRoot || this.repoRoot;
    this.sourceRoot = options.sourceRoot || this.repoRoot;
    this.gitRunner = options.gitRunner || this.defaultGitRunner.bind(this);
    this.validatingLedger = false;
  }

  defaultGitRunner(args: string[], cwd: string = this.repoRoot): string | null {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Retrieves the current HEAD commit hash.
   * @returns {string|null}
   */
  getCurrentHead(): string | null {
    return this.gitRunner(['rev-parse', 'HEAD']);
  }

  /**
   * Retrieves all modified/unstaged/staged files in the repository.
   * @returns {Set<string>}
   */
  getDirtyFiles(): Set<string> {
    const output = this.gitRunner(['status', '--porcelain']);
    if (!output) return new Set();

    const dirty = new Set<string>();
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.length > 3) {
        const filePath = line.substring(3).trim();
        dirty.add(filePath);
      }
    }
    return dirty;
  }

  /**
   * Retrieves files modified between a reference commit and current working tree.
   * @param {string} [refCommit]
   * @returns {Set<string>}
   */
  getModifiedFilesSince(refCommit?: string): Set<string> {
    // `checkEvidenceFreshness` calls this once per evidence item, and a batch of evidence shares
    // one recorded commit — so without a memo a task with ninety items ran ninety `git diff`s to
    // answer the same question. Keyed on the commit because that is the axis the work collapses
    // on. Instance-scoped, so it lives exactly as long as one invocation.
    if (!this.diffCache) this.diffCache = new Map();
    const key = refCommit || '';
    if (this.diffCache.has(key)) return this.diffCache.get(key) as Set<string>;

    const dirty = this.getDirtyFiles();
    if (!refCommit) {
      this.diffCache.set(key, dirty);
      return dirty;
    }

    const diffOutput = this.gitRunner(['diff', '--name-only', refCommit]);
    if (diffOutput) {
      for (const f of diffOutput.split('\n')) {
        if (f.trim()) dirty.add(f.trim());
      }
    }
    this.diffCache.set(key, dirty);
    return dirty;
  }

  /**
   * Evaluates freshness of an evidence item.
   * @param {Object} item - Evidence item
   * @returns {{ status: 'FRESH'|'STALE', reason?: string }}
   */
  checkEvidenceFreshness(item: any): { status: 'FRESH' | 'STALE'; reason?: string } {
    if (!item) return { status: 'STALE', reason: 'Evidence item is missing' };
    
    // If explicitly marked stale
    if (item.freshness?.status === 'STALE') {
      return { status: 'STALE', reason: 'Already marked stale' };
    }

    if (item.result === 'EMPTY' && item.freshness?.status === 'FRESH') {
      let currentFingerprint;
      if (this.validatingLedger) {
        if (this.treeFingerprint === undefined) {
          this.treeFingerprint = measureTreeState(this.treeRoot, this.gitRunner).fingerprint;
        }
        currentFingerprint = this.treeFingerprint;
      } else {
        currentFingerprint = measureTreeState(this.treeRoot, this.gitRunner).fingerprint;
      }

      if (!item.freshness?.treeFingerprint || !currentFingerprint) {
        return { status: 'STALE', reason: 'tree-unverifiable' };
      }

      if (item.freshness.treeFingerprint !== currentFingerprint) {
        return { status: 'STALE', reason: 'tree-changed-since-recorded' };
      }

      return { status: 'FRESH' };
    }

    const targetFile = item.locator?.file;
    if (!targetFile) {
      // Evidence without a file locator (e.g. general documentation) remains fresh
      return { status: 'FRESH' };
    }

    if (item.freshness?.fileHash) {
      const currentHash = fileHash(fileRootFor(this.sourceRoot, this.repoRoot, item.locator), item.locator);
      return currentHash === item.freshness.fileHash
        ? { status: 'FRESH' }
        : { status: 'STALE', reason: currentHash ? 'Observed file contents changed' : 'Observed file is missing or unreadable' };
    }

    const recordedCommit = item.freshness?.gitCommit;
    const modifiedFiles = this.getModifiedFilesSince(recordedCommit);

    if (modifiedFiles.has(targetFile)) {
      return {
        status: 'STALE',
        reason: `File '${targetFile}' was modified since evidence was recorded`,
      };
    }

    return { status: 'FRESH' };
  }

  /**
   * Inspects all items in an EvidenceLedger and marks stale items.
   * @param {Object} ledger - EvidenceLedger instance
   * @returns {number} count of newly invalidated items
   */
  validateLedgerFreshness(ledger: any): number {
    if (!ledger || typeof ledger.getAllEvidence !== 'function') return 0;
    
    let count = 0;
    const allEvidence = ledger.getAllEvidence();
    this.treeFingerprint = undefined;
    this.validatingLedger = true;
    try {
      for (const item of allEvidence) {
        if (item.freshness?.status === 'FRESH') {
          const check = this.checkEvidenceFreshness(item);
          if (check.status === 'STALE') {
            item.freshness.status = 'STALE';
            item.freshness.staleReason = check.reason;
            count += 1;
          }
        }
      }
    } finally {
      this.treeFingerprint = undefined;
      this.validatingLedger = false;
    }
    return count;
  }
}

module.exports = {
  measureFreshness,
  fileRootFor,
  FreshnessValidator,
};
