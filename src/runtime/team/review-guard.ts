'use strict';

const path = require('node:path');
const fs = require('node:fs');
import type { AgentRole } from './envelope.ts';

export interface ReviewAssignmentContext {
  taskId: string;
  authorRole: AgentRole;
  authorIdentity?: string;
  reviewerRole: AgentRole;
  reviewerIdentity?: string;
  projectRoot?: string;
}

export interface PreCheckResult {
  passed: boolean;
  failures: string[];
}

class ReviewGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReviewGuardError';
    this.code = code;
  }
}

class NeverReviewOwnCodeError extends ReviewGuardError {
  constructor(message: string) {
    super('ERR_REVIEWER_SELF_REVIEW', `ERR_REVIEWER_SELF_REVIEW: ${message}`);
    this.name = 'NeverReviewOwnCodeError';
  }
}

class MechanicalPreChecksIncompleteError extends ReviewGuardError {
  readonly failures: string[];
  constructor(failures: string[]) {
    super(
      'ERR_MECHANICAL_CHECKS_FAILED',
      `ERR_MECHANICAL_CHECKS_FAILED: Mechanical pre-checks failed prior to review dispatch: ${failures.join('; ')}`
    );
    this.name = 'MechanicalPreChecksIncompleteError';
    this.failures = failures;
  }
}

/**
 * Asserts reviewer independence:
 * 1. authorRole !== reviewerRole (e.g. core-implementer cannot review own code)
 * 2. authorIdentity !== reviewerIdentity (model/session instance separation)
 * Throws NeverReviewOwnCodeError (ERR_REVIEWER_SELF_REVIEW) if violated.
 */
function assertReviewerSeparation(context: ReviewAssignmentContext): void {
  if (!context) {
    throw new TypeError('assertReviewerSeparation: context must be provided');
  }

  // 1. Role separation invariant: authorRole !== reviewerRole
  if (context.authorRole === context.reviewerRole) {
    throw new NeverReviewOwnCodeError(
      `Reviewer self-review violation: authorRole '${context.authorRole}' matches reviewerRole '${context.reviewerRole}'. Reviewer must be an independent role.`
    );
  }

  // 2. Identity separation invariant: authorIdentity !== reviewerIdentity
  if (
    context.authorIdentity &&
    context.reviewerIdentity &&
    context.authorIdentity.trim() === context.reviewerIdentity.trim()
  ) {
    throw new NeverReviewOwnCodeError(
      `Reviewer self-review violation: authorIdentity '${context.authorIdentity}' matches reviewerIdentity '${context.reviewerIdentity}'. Reviewer must be an independent worker identity.`
    );
  }
}

/**
 * Validates that mechanical pre-checks (syntax, build, unit test pass) are complete before review dispatch.
 * Throws MechanicalPreChecksIncompleteError (ERR_MECHANICAL_CHECKS_FAILED) if failing.
 */
function assertMechanicalPreChecks(
  taskId: string,
  projectRoot?: string,
  options?: { fsImpl?: any }
): PreCheckResult {
  if (!taskId || typeof taskId !== 'string') {
    throw new TypeError('assertMechanicalPreChecks: taskId must be a non-empty string');
  }

  const fsImpl = options?.fsImpl || fs;
  const root = projectRoot || process.cwd();
  const failures: string[] = [];

  // 1. Check readiness record if available
  try {
    const { readReadinessRecord } = require('../readiness-record.ts');
    const res = readReadinessRecord({ stateRoot: root, taskId, fsImpl });
    if (res && res.status === 'found' && res.record) {
      const rec = res.record;
      if (rec.state && rec.state !== 'READY' && rec.state !== 'PASSED') {
        const unmet = (rec.unmet || []).join(', ') || 'unmet requirements';
        failures.push(`Task readiness state is '${rec.state}' (${unmet})`);
      }
    }
  } catch {
    // best-effort readiness check
  }

  // 2. Check team pre-checks state file if present (.doflow/state/team/pre-checks/<taskId>.json)
  const preCheckPath = path.join(root, '.doflow', 'state', 'team', 'pre-checks', `${taskId}.json`);
  if (fsImpl.existsSync(preCheckPath)) {
    try {
      const text = fsImpl.readFileSync(preCheckPath, 'utf8');
      const data = JSON.parse(text);
      if (data && typeof data === 'object') {
        if (data.passed === false) {
          if (Array.isArray(data.failures) && data.failures.length > 0) {
            failures.push(...data.failures);
          } else {
            failures.push(`Pre-check reported failure for ${taskId}`);
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  if (failures.length > 0) {
    throw new MechanicalPreChecksIncompleteError(failures);
  }

  return {
    passed: true,
    failures: [],
  };
}

module.exports = {
  ReviewGuardError,
  NeverReviewOwnCodeError,
  MechanicalPreChecksIncompleteError,
  assertReviewerSeparation,
  assertMechanicalPreChecks,
};
