'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseYamlFile } = require('./capability-router');

const READINESS_STATES = new Set([
  'READY',
  'NEEDS_EVIDENCE',
  'NEEDS_USER_DECISION',
  'BLOCKED',
]);

class ReadinessEngine {
  /**
   * @param {Object} [options]
   * @param {string} [options.repoRoot]
   * @param {string} [options.templatePath]
   * @param {Object} [options.templates]
   * @param {Object} [options.fsImpl]
   */
  constructor(options = {}) {
    this.fsImpl = options.fsImpl || fs;
    this.repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
    this.templatePath = options.templatePath || path.join(this.repoRoot, 'core', 'registry', 'readiness-templates.yaml');

    if (options.templates) {
      this.templates = options.templates;
    } else {
      this.loadTemplates();
    }
  }

  loadTemplates() {
    try {
      const data = parseYamlFile(this.templatePath, this.fsImpl);
      this.templates = data.templates || {};
    } catch (error) {
      throw new Error(`Failed to load readiness templates from '${this.templatePath}': ${error.message}`);
    }
  }

  /**
   * Suggests retrieval actions when an evidence requirement is missing.
   * @param {string} reqId
   * @param {Object} reqDef
   * @param {Object} taskProfile
   * @returns {Object}
   */
  suggestAction(reqId, reqDef, taskProfile) {
    if (reqId === 'root_cause') {
      return {
        intent: 'trace-dependency',
        capability: 'code.relationships',
        action: 'Query structural call graphs or inspect git history to establish root cause evidence for the bug.',
      };
    }
    if (reqId === 'affected_code' || reqId === 'target_identified') {
      return {
        intent: 'locate-known-symbol',
        capability: 'code.exact-search',
        action: 'Perform exact symbol or file search to record target code locators.',
      };
    }
    if (reqId === 'blast_radius' || reqId === 'architecture_mapped') {
      return {
        intent: 'estimate-blast-radius',
        capability: 'code.impact-analysis',
        action: 'Query caller trees and dependent modules using Graphify or exact search.',
      };
    }
    if (reqId === 'reproduction' || reqId === 'baseline_tests') {
      return {
        intent: 'verify-runtime-behavior',
        capability: 'behavior.verify',
        action: 'Execute automated tests or record runtime observation reproducing the behavior.',
      };
    }
    return {
      intent: 'locate-concept',
      capability: 'code.semantic-search',
      action: `Gather evidence for requirement '${reqId}' (${reqDef.description}).`,
    };
  }

  /**
   * Evaluates task readiness against a declarative template.
   * @param {Object} taskProfile
   * @param {string} taskProfile.taskId
   * @param {'bug'|'feature'|'refactor'|'trivial-edit'|'dependency-change'} [taskProfile.taskClass='feature']
   * @param {string} [taskProfile.description]
   * @param {string} [taskProfile.verificationPlan]
   * @param {boolean} [taskProfile.userDecisionPending=false]
   * @param {Object} evidenceLedger
   * @param {Object} claimsManager
   * @returns {Object} ReadinessReport
   */
  evaluateReadiness(taskProfile, evidenceLedger, claimsManager) {
    if (!taskProfile || typeof taskProfile !== 'object') {
      throw new Error('taskProfile must be an object');
    }

    const taskId = taskProfile.taskId || 'default';
    const taskClass = taskProfile.taskClass || 'feature';
    const template = this.templates[taskClass];

    if (!template) {
      throw new Error(`Unknown task class '${taskClass}'. Available: ${Object.keys(this.templates).join(', ')}`);
    }

    const requirements = template.requirements || {};
    const requirementResults = [];
    let allSatisfied = true;
    let hasBlocked = false;

    // Check for user decision gate
    if (taskProfile.userDecisionPending) {
      return {
        taskId,
        taskClass,
        state: 'NEEDS_USER_DECISION',
        templateName: template.name,
        summary: 'Task requires explicit user approval on an architectural or design decision.',
        satisfiedRequirements: [],
        missingRequirements: [],
        claimsSummary: { supported: 0, hypotheses: 0, conflicts: 0 },
      };
    }

    // Inspect claims
    const taskClaims = claimsManager ? claimsManager.getClaims(taskId) : [];
    const conflictedClaims = taskClaims.filter((c) => c.status === 'conflicted');
    if (conflictedClaims.length > 0) {
      hasBlocked = true;
    }

    const taskEvidence = evidenceLedger ? evidenceLedger.queryEvidence({ taskId, status: 'FRESH' }) : [];

    for (const [reqId, reqDef] of Object.entries(requirements)) {
      let isSatisfied = false;
      let reason = null;
      let matchedEvidenceIds = [];

      // Check verification plan requirement
      if (reqId === 'regression_verification' || reqId === 'verification_plan' || reqId === 'verification_command') {
        if (taskProfile.verificationPlan || taskProfile.verificationCommand) {
          isSatisfied = true;
        } else {
          reason = 'No verification command or test execution plan defined in task profile.';
        }
      }
      // Check claim status requirement (e.g. root_cause)
      else if (reqDef.requiresClaimStatus) {
        const matchingClaims = taskClaims.filter((c) => c.status === reqDef.requiresClaimStatus);
        if (matchingClaims.length > 0) {
          isSatisfied = true;
          matchedEvidenceIds = matchingClaims.flatMap((c) => c.supportingEvidence);
        } else {
          reason = `Requires at least one claim with status '${reqDef.requiresClaimStatus}'.`;
        }
      }
      // Check evidence kind requirement
      else if (Array.isArray(reqDef.evidenceKinds) && reqDef.evidenceKinds.length > 0) {
        const allowedKinds = new Set(reqDef.evidenceKinds);
        const matchingEv = taskEvidence.filter((ev) => allowedKinds.has(ev.kind));
        if (matchingEv.length > 0) {
          isSatisfied = true;
          matchedEvidenceIds = matchingEv.map((ev) => ev.id);
        } else {
          reason = `Missing fresh evidence of kind: ${reqDef.evidenceKinds.join(', ')}.`;
        }
      }
      // Scope verified / scope clear
      else if (reqId === 'scope_clear' || reqId === 'scope_verified' || reqId === 'invariants_captured') {
        if (taskProfile.scopeClear || taskProfile.description || taskProfile.invariants) {
          isSatisfied = true;
        } else {
          reason = `Prerequisite '${reqId}' not documented.`;
        }
      } else {
        // Fail closed. A gate whose unrecognized requirements default to satisfied reports READY
        // for prerequisites it never actually evaluated — the one failure mode a readiness contract
        // exists to prevent. No shipped template reaches here today; a future one adding a
        // requirement without `evidenceKinds`/`requiresClaimStatus` should surface as unmet, not
        // silently pass.
        isSatisfied = false;
        reason = `Requirement '${reqId}' has no evaluator; treating as unmet.`;
      }

      if (!isSatisfied && reqDef.required) {
        allSatisfied = false;
      }

      requirementResults.push({
        id: reqId,
        description: reqDef.description,
        required: Boolean(reqDef.required),
        satisfied: isSatisfied,
        reason,
        evidenceIds: matchedEvidenceIds,
        recommendedAction: isSatisfied ? null : this.suggestAction(reqId, reqDef, taskProfile),
      });
    }

    let state = 'READY';
    let summary = 'All mandatory readiness prerequisites are verified by fresh evidence.';

    if (hasBlocked) {
      state = 'BLOCKED';
      summary = `Task is blocked by ${conflictedClaims.length} conflicted claim(s). Contradicting evidence must be resolved.`;
    } else if (!allSatisfied) {
      state = 'NEEDS_EVIDENCE';
      const missingCount = requirementResults.filter((r) => r.required && !r.satisfied).length;
      summary = `Task requires ${missingCount} additional evidence item(s) before implementation.`;
    }

    return {
      taskId,
      taskClass,
      state,
      templateName: template.name,
      summary,
      requirements: requirementResults,
      claimsSummary: {
        total: taskClaims.length,
        supported: taskClaims.filter((c) => c.status === 'supported').length,
        hypotheses: taskClaims.filter((c) => c.status === 'hypothesis').length,
        conflicts: conflictedClaims.length,
      },
      evidenceCount: taskEvidence.length,
    };
  }
}

module.exports = {
  ReadinessEngine,
  READINESS_STATES,
};
