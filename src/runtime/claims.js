'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Shared with EvidenceLedger so both stores enforce one definition of a safe task id.
const { assertSafeTaskId, EvidenceLedger } = require('./evidence-ledger');
const { finishRuntime, usageError } = require('./cli-result');

const CLAIM_STATUSES = new Set([
  'hypothesis',
  'supported',
  'conflicted',
  // Contradicted with nothing on the other side — a disproven claim, not a disputed one. Ported
  // from `evidence/claim_builder.py`'s REJECTED (plan task B.3): the Python distinguished these
  // and this file did not, folding both into 'conflicted'.
  'rejected',
  'invalidated',
  'unknown',
  // Terminal states (FR-001, FR-002). A human decided this claim no longer stands; that decision
  // outranks any later mechanical re-reading of its evidence, which is why `evaluateClaim` returns
  // early for them rather than recomputing.
  'retracted',
  'superseded',
]);

/**
 * States no evidence walk may leave. `evaluateAll()` runs on every `list`/`status`, and
 * `evaluateClaim` otherwise rewrites `status` from the evidence links — so without this set a
 * retraction would be undone by the very next read and the verb would appear to work while doing
 * nothing (design R1).
 */
const TERMINAL_CLAIM_STATUSES = new Set(['retracted', 'superseded']);

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

    // A terminal state is a recorded human decision, not a reading of evidence. Recomputing it here
    // would silently resurrect a retracted claim on the next list (design R1).
    if (TERMINAL_CLAIM_STATUSES.has(claim.status)) {
      return claim.status;
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
      // 'conflicted' means evidence disagrees and a human must reconcile it; 'rejected' means the
      // evidence agrees and the claim is false. Collapsing the second into the first reported a
      // dispute where none existed, and made the readiness gate block on a question already
      // settled. Support that has merely gone stale still counts as support, so a claim that once
      // had backing stays 'conflicted' rather than being declared false on a technicality.
      claim.status = claim.supportingEvidence.length === 0 ? 'rejected' : 'conflicted';
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
   * Moves a claim to a terminal state, leaving the record and its evidence links untouched.
   * Shared by retract and supersede so the two cannot drift on what "terminal" means.
   * @param {string} claimId
   * @param {'retracted'|'superseded'} status
   * @param {string} [supersededBy]
   * @returns {string} the new status
   */
  finalizeClaim(claimId, status, supersededBy) {
    const claim = this.claimsMap.get(claimId);
    if (!claim) {
      throw new Error(`Unknown claim '${claimId}'`);
    }
    if (TERMINAL_CLAIM_STATUSES.has(claim.status)) {
      throw new Error(`Claim '${claimId}' is already '${claim.status}' and cannot be changed again`);
    }
    claim.status = status;
    claim.terminalAt = new Date().toISOString();
    if (supersededBy) claim.supersededBy = supersededBy;
    claim.updatedAt = claim.terminalAt;
    return claim.status;
  }

  /**
   * Records that a claim no longer holds. Nothing is deleted (NFR-003): retraction records that a
   * conclusion was withdrawn, not that it was never drawn.
   * @param {string} claimId
   * @returns {string} the new status
   */
  retractClaim(claimId) {
    return this.finalizeClaim(claimId, 'retracted');
  }

  /**
   * Records that a claim was replaced by another, with a forward pointer to it.
   *
   * The replacement must already exist. A pointer to an unrecorded id is worse than no pointer, and
   * this refusal mirrors the one `link` already makes for unrecorded evidence.
   * @param {string} claimId
   * @param {string} replacedBy
   * @returns {string} the new status
   */
  supersedeClaim(claimId, replacedBy) {
    // The target is checked first: validating the replacement before the claim being superseded
    // reported a missing replacement when the caller had actually mistyped the target, sending them
    // to fix the wrong id.
    if (!this.claimsMap.has(claimId)) {
      throw new Error(`Unknown claim '${claimId}'`);
    }
    if (!replacedBy) {
      throw new Error('supersede requires the id of the claim that replaces this one');
    }
    if (replacedBy === claimId) {
      throw new Error(`Claim '${claimId}' cannot supersede itself`);
    }
    if (!this.claimsMap.has(replacedBy)) {
      throw new Error(`No claim '${replacedBy}' is recorded — a forward pointer to nothing is worse `
        + 'than no pointer. Record the replacing claim first: doflow claim --action add --statement ...');
    }
    return this.finalizeClaim(claimId, 'superseded', replacedBy);
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
    const targetFile = path.join(this.stateDir, `${assertSafeTaskId(taskId)}_claims.json`);
    this.fsImpl.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf8');
    return targetFile;
  }

  /**
   * Loads claims from disk.
   * @param {string} [taskId='default']
   * @returns {number}
   */
  load(taskId = 'default') {
    const targetFile = path.join(this.stateDir, `${assertSafeTaskId(taskId)}_claims.json`);
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

/**
 * Handles `doflow claim` — record a proposition, link evidence to it, or list what is recorded.
 *
 * A claim added here starts as a hypothesis and can only become `supported` through linked
 * evidence (FR-007); this handler exposes no way to declare one supported directly, because a
 * conclusion that becomes fact by assertion is the thing the claims ledger exists to prevent.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {'list'|'add'|'link'|'retract'|'supersede'} [options.action='list']
 * @param {string} [options.statement] `add`
 * @param {string} [options.claimId] `link`
 * @param {string} [options.evidenceId] `link`
 * @param {string} [options.replacedBy] `supersede`: the claim that replaces this one
 * @param {string} [options.relation='supports'] `link`
 * @param {boolean} [options.json=false]
 * @param {string} [options.stateRoot]
 * @returns {number} exit code
 */
function handleClaimCommand({ taskId, action = 'list', statement, claimId, evidenceId, replacedBy, relation = 'supports', json = false, stateRoot } = {}) {
  const root = stateRoot || process.cwd();
  const ledger = new EvidenceLedger({ repoRoot: root });
  ledger.load(taskId);
  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: root });
  claims.load(taskId);

  let result;
  try {
    if (action === 'add') {
      if (typeof statement !== 'string' || statement.trim() === '') {
        return usageError('claim', '--statement is required for --action add', json);
      }
      const id = claims.addClaim({ statement, taskId });
      claims.save(taskId);
      result = { action, taskId, claim: claims.getClaim(id) };
    } else if (action === 'link') {
      if (!claimId || !evidenceId) {
        return usageError('claim', '--claim-id and --evidence-id are both required for --action link', json);
      }
      // Linking an id the ledger does not hold used to succeed. `evaluateClaim` reads a missing
      // evidence item as *stale* support and returns `invalidated` — a verdict about evidence
      // that was never recorded, and the reading that made C.5 conclude `conflicted` (and so
      // `BLOCKED`) was unreachable through the seam. Refuse instead of grading.
      if (!ledger.getEvidence(evidenceId)) {
        return usageError('claim', `no evidence '${evidenceId}' is recorded for task '${taskId}' — linking it would `
          + 'mark the claim `invalidated` on the strength of an item that does not exist. Record it first: '
          + `doflow evidence --task-id ${taskId} --action add ...`, json);
      }
      const status = claims.linkEvidence(claimId, evidenceId, relation);
      claims.save(taskId);
      result = { action, taskId, claim: claims.getClaim(claimId), status };
    } else if (action === 'retract') {
      if (!claimId) {
        return usageError('claim', '--claim-id is required for --action retract', json);
      }
      const status = claims.retractClaim(claimId);
      claims.save(taskId);
      result = { action, taskId, claim: claims.getClaim(claimId), status };
    } else if (action === 'supersede') {
      if (!claimId || !replacedBy) {
        return usageError('claim', '--claim-id and --replaced-by are both required for --action supersede', json);
      }
      const status = claims.supersedeClaim(claimId, replacedBy);
      claims.save(taskId);
      result = { action, taskId, claim: claims.getClaim(claimId), status };
    } else if (action === 'list' || action === 'status') {
      claims.evaluateAll();
      result = { action: 'list', taskId, claims: claims.getClaims(taskId) };
    } else {
      return usageError('claim', `unknown --action '${action}'. Valid: list, add, link, retract, supersede`, json);
    }
  } catch (error) {
    return usageError('claim', error.message, json);
  }

  if (json) { console.log(JSON.stringify(result, null, 2)); }
  else {
    const rows = result.claims || [result.claim];
    console.log(`\nDoFlow Claims [Task: ${taskId}]:`);
    console.log('═'.repeat(78));
    if (rows.length === 0) console.log('No claims recorded for this task.');
    else {
      console.log('ID'.padEnd(24) + 'Status'.padEnd(14) + 'Statement');
      console.log('─'.repeat(78));
      for (const claim of rows) {
        const suffix = claim.supersededBy ? ` → ${claim.supersededBy}` : '';
        console.log(claim.id.padEnd(24) + (claim.status + suffix).padEnd(14) + claim.statement);
      }
    }
    console.log('═'.repeat(78) + '\n');
  }
  return finishRuntime(0);
}

module.exports = {
  ClaimsManager,
  CLAIM_STATUSES,
  TERMINAL_CLAIM_STATUSES,
  handleClaimCommand,
};
