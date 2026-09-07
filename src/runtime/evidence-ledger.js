'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPO_ROOT } = require('../helper/repo-root');
const { updateTaskState, readTaskState, mergeRecords } = require('./task-state');

const VALID_EVIDENCE_KINDS = new Set([
  'exact-search',
  'semantic-retrieval',
  'structural',
  'historical',
  'documentation',
  'test-result',
  'runtime-observation',
  'user-statement',
  'diff',
  'generated-analysis',
]);

const VALID_PROVENANCE = new Set(['extracted', 'inferred', 'asserted']);

/** A task id becomes a filename inside the state directory, so it must not be able to name a path.
 * `path.join(stateDir, `${taskId}.json`)` happily resolves `../../../etc/hosts` out of the state
 * dir entirely — read-only today only because nothing calls save(), and an arbitrary file write
 * the moment a writer is wired up. Constrain it to a flat, filename-safe token instead of trying
 * to sanitize a traversal after the fact.
 * @param {string} taskId
 * @returns {string} the validated id, for use in an expression
 */
function assertSafeTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId) || taskId.includes('..')) {
    throw new Error(`Invalid task id '${taskId}': expected letters, digits, dot, dash or underscore, and no path separators`);
  }
  return taskId;
}

class EvidenceLedger {
  /**
   * @param {Object} [options]
   * @param {string} [options.repoRoot]
   * @param {string} [options.stateDir]
   * @param {Object} [options.fsImpl]
   */
  constructor(options = {}) {
    this.fsImpl = options.fsImpl || fs;
    this.repoRoot = options.repoRoot || REPO_ROOT;
    this.stateDir = options.stateDir || path.join(this.repoRoot, '.doflow', 'state', 'evidence');
    this.evidenceMap = new Map();
    this.baseline = new Map();
    this.seq = 0;
  }

  /**
   * Generates a unique evidence identifier. Uniqueness must hold ACROSS instances and processes,
   * not just within one: ids key the concurrency-safe merge in save() (task-state.js), and two
   * ledgers minting `ev_<ms>_1` in the same millisecond made the merge collapse two distinct
   * observations into one — the very lost write R4 exists to prevent, reintroduced by an id
   * scheme. The random component carries that burden; timestamp and sequence stay for readability.
   * @returns {string}
   */
  generateId() {
    this.seq += 1;
    return `ev_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}_${this.seq.toString(36)}`;
  }

  /**
   * Validates and registers a new evidence item.
   * @param {Object} item
   * @returns {string} evidenceId
   */
  addEvidence(item) {
    if (!item || typeof item !== 'object') {
      throw new Error('Evidence item must be an object');
    }

    if (!item.kind || !VALID_EVIDENCE_KINDS.has(item.kind)) {
      throw new Error(`Invalid evidence kind '${item.kind}'. Allowed: ${[...VALID_EVIDENCE_KINDS].join(', ')}`);
    }

    const provenance = item.provenance || 'extracted';
    if (!VALID_PROVENANCE.has(provenance)) {
      throw new Error(`Invalid provenance '${provenance}'. Allowed: ${[...VALID_PROVENANCE].join(', ')}`);
    }

    const id = item.id || this.generateId();
    const taskId = item.taskId || 'default';

    const source = item.source || {
      provider: 'unknown',
      capability: 'general',
    };

    const freshness = {
      gitCommit: item.freshness?.gitCommit || null,
      fileHash: item.freshness?.fileHash || null,
      observedAt: item.freshness?.observedAt || new Date().toISOString(),
      status: item.freshness?.status || 'FRESH',
    };

    const evidenceRecord = {
      id,
      taskId,
      kind: item.kind,
      source,
      locator: item.locator || {},
      provenance,
      content: item.content || null,
      freshness,
      // Which template requirements this item claims to establish. Readiness counts an item toward
      // a requirement only when the writer named it here — kind-matching alone let an item saying
      // "tests failed" satisfy a passing-baseline requirement (architecture review R1, P1).
      establishes: Array.isArray(item.establishes) ? [...item.establishes] : [],
      // Typed execution record for test-result / runtime-observation items: what ran and how it
      // exited. Tree identity and time live in freshness (gitCommit, observedAt).
      observation: item.observation
        ? { command: item.observation.command, exitCode: item.observation.exitCode }
        : null,
      supports: Array.isArray(item.supports) ? [...item.supports] : [],
      contradicts: Array.isArray(item.contradicts) ? [...item.contradicts] : [],
    };

    this.evidenceMap.set(id, evidenceRecord);
    return id;
  }

  /**
   * Retrieves an evidence item by ID.
   * @param {string} id
   * @returns {Object|null}
   */
  getEvidence(id) {
    return this.evidenceMap.get(id) || null;
  }

  /**
   * Queries evidence items matching criteria.
   * @param {Object} [filter={}]
   * @returns {Array<Object>}
   */
  queryEvidence(filter = {}) {
    const results = [];
    for (const item of this.evidenceMap.values()) {
      if (filter.taskId && item.taskId !== filter.taskId) continue;
      if (filter.kind && item.kind !== filter.kind) continue;
      if (filter.provider && item.source.provider !== filter.provider) continue;
      if (filter.capability && item.source.capability !== filter.capability) continue;
      if (filter.file && item.locator.file !== filter.file) continue;
      if (filter.status && item.freshness.status !== filter.status) continue;
      results.push(item);
    }
    return results;
  }

  /**
   * Marks all evidence items referencing modified files as STALE.
   * @param {Array<string>} modifiedFiles
   * @returns {number} count of invalidated items
   */
  invalidateFiles(modifiedFiles) {
    if (!Array.isArray(modifiedFiles) || modifiedFiles.length === 0) return 0;
    const fileSet = new Set(modifiedFiles);
    let count = 0;

    for (const item of this.evidenceMap.values()) {
      if (item.locator?.file && fileSet.has(item.locator.file)) {
        item.freshness.status = 'STALE';
        count += 1;
      }
    }
    return count;
  }

  /**
   * Returns all evidence records in memory.
   * @returns {Array<Object>}
   */
  getAllEvidence() {
    return Array.from(this.evidenceMap.values());
  }

  /**
   * Persists evidence for a specific task to disk — locked, merged, revisioned (task-state.js).
   * A concurrent writer's items that this instance never loaded survive the save: they are folded
   * in from disk inside the lock, so overlapping sessions append rather than overwrite each other.
   * @param {string} [taskId='default']
   * @returns {string} filePath
   */
  save(taskId = 'default') {
    const targetFile = path.join(this.stateDir, `${assertSafeTaskId(taskId)}.json`);
    let merged;
    const file = updateTaskState({
      fsImpl: this.fsImpl, file: targetFile,
      build: disk => {
        merged = mergeRecords(this.queryEvidence({ taskId }), disk?.evidence || [], this.baseline);
        return { taskId, updatedAt: new Date().toISOString(), evidenceCount: merged.length, evidence: merged };
      },
    });
    for (const item of merged) {
      this.evidenceMap.set(item.id, item);
      this.baseline.set(item.id, JSON.parse(JSON.stringify(item)));
    }
    return file;
  }

  /**
   * Loads evidence for a task from disk into memory.
   * @param {string} [taskId='default']
   * @returns {number} count of loaded items
   */
  load(taskId = 'default') {
    const targetFile = path.join(this.stateDir, `${assertSafeTaskId(taskId)}.json`);
    const data = readTaskState(this.fsImpl, targetFile);
    if (data && Array.isArray(data.evidence)) {
      for (const item of data.evidence) {
        this.evidenceMap.set(item.id, item);
        this.baseline.set(item.id, JSON.parse(JSON.stringify(item)));
      }
      return data.evidence.length;
    }
    return 0;
  }

  /**
   * Resets the in-memory ledger.
   */
  clear() {
    this.evidenceMap.clear();
    this.baseline.clear();
    this.seq = 0;
  }
}

module.exports = {
  EvidenceLedger,
  VALID_EVIDENCE_KINDS,
  VALID_PROVENANCE,
  assertSafeTaskId,
};
