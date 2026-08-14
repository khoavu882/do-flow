'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CLAIM_STATUSES = new Set([
  'hypothesis',
  'supported',
  'conflicted',
  'invalidated',
  'unknown',
]);

class ClaimsManager {
  /**
   * @param {Object} [options]
   * @param {Object} [options.evidenceLedger]
   * @param {string} [options.repoRoot]
   * @param {string} [options.stateDir]
   * @param {Object} [options.fsImpl]
   */
  constructor(options = {}) {
    this.fsImpl = options.fsImpl || fs;
    this.evidenceLedger = options.evidenceLedger || null;
    this.repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
    this.stateDir = options.stateDir || path.join(this.repoRoot, '.doflow', 'state', 'evidence');
    this.claimsMap = new Map();
    this.seq = 0;
  }

  generateId() {
    this.seq += 1;
    return `claim_${Date.now().toString(36)}_${this.seq.toString(36)}`;
  }

  /**
   * Registers a new proposition as a claim.
   * Agent inferences start strictly in 'hypothesis' status.
   * @param {Object} item - { statement, taskId, status, id }
   * @returns {string} claimId
   */
  addClaim(item) {
    if (!item || typeof item !== 'object') {
      throw new Error('Claim item must be an object');
    }
    if (!item.statement || typeof item.statement !== 'string') {
      throw new Error('Claim requires a non-empty statement');
    }

    const id = item.id || this.generateId();
    const taskId = item.taskId || 'default';
    const status = item.status && CLAIM_STATUSES.has(item.status) ? item.status : 'hypothesis';

    const claimRecord = {
      id,
      taskId,
      statement: item.statement,
      status,
      supportingEvidence: Array.isArray(item.supportingEvidence) ? [...item.supportingEvidence] : [],
      contradictingEvidence: Array.isArray(item.contradictingEvidence) ? [...item.contradictingEvidence] : [],
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.claimsMap.set(id, claimRecord);
    return id;
  }

  /**
   * Retrieves a claim by ID.
   * @param {string} id
   * @returns {Object|null}
   */
  getClaim(id) {
    return this.claimsMap.get(id) || null;
  }

  /**
   * Links an evidence item to a claim.
   * @param {string} claimId
   * @param {string} evidenceId
   * @param {'supports'|'contradicts'} [relation='supports']
   */
  linkEvidence(claimId, evidenceId, relation = 'supports') {
    const claim = this.claimsMap.get(claimId);
    if (!claim) {
      throw new Error(`Unknown claim '${claimId}'`);
    }

    if (relation === 'supports') {
      if (!claim.supportingEvidence.includes(evidenceId)) {
        claim.supportingEvidence.push(evidenceId);
      }
    } else if (relation === 'contradicts') {
      if (!claim.contradictingEvidence.includes(evidenceId)) {
        claim.contradictingEvidence.push(evidenceId);
      }
    } else {
      throw new Error(`Invalid evidence relation '${relation}'. Allowed: supports, contradicts`);
    }

    // Bidirectionally update evidence if ledger attached
    if (this.evidenceLedger) {
      const evidence = this.evidenceLedger.getEvidence(evidenceId);
      if (evidence) {
        if (relation === 'supports' && !evidence.supports.includes(claimId)) {
          evidence.supports.push(claimId);
        } else if (relation === 'contradicts' && !evidence.contradicts.includes(claimId)) {
          evidence.contradicts.push(claimId);
        }
      }
    }

    claim.updatedAt = new Date().toISOString();
    return this.evaluateClaim(claimId);
  }

  /**
   * Evaluates the epistemic state of a claim based on evidence availability and freshness.
   * @param {string} claimId
   * @returns {'hypothesis'|'supported'|'conflicted'|'invalidated'|'unknown'}
   */
  evaluateClaim(claimId) {
    const claim = this.claimsMap.get(claimId);
    if (!claim) {
      throw new Error(`Unknown claim '${claimId}'`);
    }

    // If no evidence attached, remains a hypothesis
    if (claim.supportingEvidence.length === 0 && claim.contradictingEvidence.length === 0) {
      claim.status = 'hypothesis';
      return claim.status;
    }

    let hasFreshSupport = false;
    let hasFreshContradiction = false;
    let hasStaleSupport = false;

    for (const evId of claim.supportingEvidence) {
      const ev = this.evidenceLedger ? this.evidenceLedger.getEvidence(evId) : null;
      if (!ev || ev.freshness?.status === 'STALE') {
        hasStaleSupport = true;
      } else {
        hasFreshSupport = true;
      }
    }

    for (const evId of claim.contradictingEvidence) {
      const ev = this.evidenceLedger ? this.evidenceLedger.getEvidence(evId) : null;
      if (ev && ev.freshness?.status !== 'STALE') {
        hasFreshContradiction = true;
      }
    }

    if (hasFreshContradiction) {
      claim.status = 'conflicted';
    } else if (hasFreshSupport) {
      claim.status = 'supported';
    } else if (hasStaleSupport && !hasFreshSupport) {
      claim.status = 'invalidated';
    } else {
      claim.status = 'hypothesis';
    }

    claim.updatedAt = new Date().toISOString();
    return claim.status;
  }

  /**
   * Evaluates all claims in memory.
   */
  evaluateAll() {
    for (const claimId of this.claimsMap.keys()) {
      this.evaluateClaim(claimId);
    }
  }

  /**
   * Queries claims for a specific task.
   * @param {string} [taskId]
   * @returns {Array<Object>}
   */
  getClaims(taskId) {
    const results = [];
    for (const claim of this.claimsMap.values()) {
      if (!taskId || claim.taskId === taskId) {
        results.push(claim);
      }
    }
    return results;
  }

  /**
   * Persists claims to disk.
   * @param {string} [taskId='default']
   * @returns {string} filePath
   */
  save(taskId = 'default') {
    const taskClaims = this.getClaims(taskId);
    const payload = {
      version: 1,
      taskId,
      updatedAt: new Date().toISOString(),
      claimsCount: taskClaims.length,
      claims: taskClaims,
    };

    this.fsImpl.mkdirSync(this.stateDir, { recursive: true });
    const targetFile = path.join(this.stateDir, `${taskId}_claims.json`);
    this.fsImpl.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf8');
    return targetFile;
  }

  /**
   * Loads claims from disk.
   * @param {string} [taskId='default']
   * @returns {number}
   */
  load(taskId = 'default') {
    const targetFile = path.join(this.stateDir, `${taskId}_claims.json`);
    if (!this.fsImpl.existsSync(targetFile)) {
      return 0;
    }

    try {
      const data = JSON.parse(this.fsImpl.readFileSync(targetFile, 'utf8'));
      if (Array.isArray(data.claims)) {
        for (const item of data.claims) {
          this.claimsMap.set(item.id, item);
        }
        return data.claims.length;
      }
      return 0;
    } catch (error) {
      throw new Error(`Failed to load claims file '${targetFile}': ${error.message}`);
    }
  }

  clear() {
    this.claimsMap.clear();
    this.seq = 0;
  }
}

module.exports = {
  ClaimsManager,
  CLAIM_STATUSES,
};
