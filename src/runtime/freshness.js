'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { REPO_ROOT } = require('../helper/repo-root');

class FreshnessValidator {
  /**
   * @param {Object} [options]
   * @param {string} [options.repoRoot]
   * @param {Function} [options.gitRunner]
   */
  constructor(options = {}) {
    this.repoRoot = options.repoRoot || REPO_ROOT;
    this.gitRunner = options.gitRunner || this.defaultGitRunner.bind(this);
    this.commitCache = null;
  }

  defaultGitRunner(args, cwd = this.repoRoot) {
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
  getCurrentHead() {
    return this.gitRunner(['rev-parse', 'HEAD']);
  }

  /**
   * Retrieves all modified/unstaged/staged files in the repository.
   * @returns {Set<string>}
   */
  getDirtyFiles() {
    const output = this.gitRunner(['status', '--porcelain']);
    if (!output) return new Set();

    const dirty = new Set();
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
  getModifiedFilesSince(refCommit) {
    const dirty = this.getDirtyFiles();
    if (!refCommit) return dirty;

    const diffOutput = this.gitRunner(['diff', '--name-only', refCommit]);
    if (diffOutput) {
      for (const f of diffOutput.split('\n')) {
        if (f.trim()) dirty.add(f.trim());
      }
    }
    return dirty;
  }

  /**
   * Evaluates freshness of an evidence item.
   * @param {Object} item - Evidence item
   * @returns {{ status: 'FRESH'|'STALE', reason?: string }}
   */
  checkEvidenceFreshness(item) {
    if (!item) return { status: 'STALE', reason: 'Evidence item is missing' };
    
    // If explicitly marked stale
    if (item.freshness?.status === 'STALE') {
      return { status: 'STALE', reason: 'Already marked stale' };
    }

    const targetFile = item.locator?.file;
    if (!targetFile) {
      // Evidence without a file locator (e.g. general documentation) remains fresh
      return { status: 'FRESH' };
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
  validateLedgerFreshness(ledger) {
    if (!ledger || typeof ledger.getAllEvidence !== 'function') return 0;
    
    let count = 0;
    const allEvidence = ledger.getAllEvidence();
    const modifiedFiles = this.getModifiedFilesSince();

    for (const item of allEvidence) {
      if (item.freshness?.status === 'FRESH') {
        const check = this.checkEvidenceFreshness(item);
        if (check.status === 'STALE') {
          item.freshness.status = 'STALE';
          count += 1;
        }
      }
    }
    return count;
  }
}

module.exports = {
  FreshnessValidator,
};
