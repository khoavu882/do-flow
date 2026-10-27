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
  options?: { fsImpl?: any; slug?: string | null }
): PreCheckResult {
  if (!taskId || typeof taskId !== 'string') {
    throw new TypeError('assertMechanicalPreChecks: taskId must be a non-empty string');
  }

  const fsImpl = options?.fsImpl || fs;
  const root = projectRoot || process.cwd();
  const failures: string[] = [];

  // 1. Readiness evidence is a precondition, not an optional hint.
  try {
    const { readReadinessRecord } = require('../readiness-record.ts');
    const res = readReadinessRecord({ stateRoot: root, taskId, slug: options?.slug ?? null, fsImpl });
    if (!res || res.status !== 'found' || !res.record || typeof res.record !== 'object') {
      failures.push(`Task readiness evidence is ${res?.status || 'unavailable'}`);
    } else {
      const rec = res.record;
      if (rec.state !== 'READY' && rec.state !== 'PASSED') {
        const unmet = Array.isArray(rec.unmet) ? rec.unmet.join(', ') : '';
        failures.push(`Task readiness state is '${rec.state}' (${unmet})`);
      } else if (rec.unmet !== undefined && (!Array.isArray(rec.unmet) || rec.unmet.length > 0)) {
        failures.push('Task readiness evidence is malformed or still has unmet requirements');
      }
    }
  } catch (error: any) {
    failures.push(`Task readiness evidence could not be read (${error?.message || 'read error'})`);
  }

  // 2. A missing or malformed mechanical-check record cannot establish a successful pre-check.
  const preCheckPath = path.join(root, '.doflow', 'state', 'team', 'pre-checks', `${taskId}.json`);
  try {
    if (!fsImpl.existsSync(preCheckPath)) {
      failures.push(`Pre-check evidence is missing for ${taskId}`);
    } else {
      const data = JSON.parse(fsImpl.readFileSync(preCheckPath, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.passed !== 'boolean'
        || !Array.isArray(data.failures) || data.failures.some((failure: any) => typeof failure !== 'string')) {
        failures.push(`Pre-check evidence is malformed for ${taskId}`);
      } else if (data.passed === true && data.failures.length > 0) {
        failures.push('Pre-check evidence reports failures while marked passed');
      } else if (data.passed === false) {
        failures.push(...(data.failures.length > 0 ? data.failures : [`Pre-check reported failure for ${taskId}`]));
      }
    }
  } catch (error: any) {
    failures.push(`Pre-check evidence could not be read for ${taskId} (${error?.message || 'read error'})`);
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
