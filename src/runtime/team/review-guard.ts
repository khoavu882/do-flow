'use strict';

const fs = require('node:fs');

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
 * Validates that the task is READY and that its verification precondition holds before review dispatch.
 * `options.verifyReasons` is the caller's reading of the verify run records: empty means none unmet.
 * Throws MechanicalPreChecksIncompleteError (ERR_MECHANICAL_CHECKS_FAILED) if failing.
 */
function assertMechanicalPreChecks(
  taskId: string,
  projectRoot?: string,
  options?: { fsImpl?: any; slug?: string | null; verifyReasons?: readonly string[] }
): PreCheckResult {
  if (!taskId || typeof taskId !== 'string') {
    throw new TypeError('assertMechanicalPreChecks: taskId must be a non-empty string');
  }
  if (projectRoot !== undefined && typeof projectRoot !== 'string') {
    throw new TypeError('assertMechanicalPreChecks: projectRoot must be a string when given');
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
      if (rec.state !== 'READY') {
        const unmet = Array.isArray(rec.unmet) ? rec.unmet.join(', ') : '';
        failures.push(`Task readiness state is '${rec.state}' (${unmet})`);
      } else if (rec.unmet !== undefined && (!Array.isArray(rec.unmet) || rec.unmet.length > 0)) {
        failures.push('Task readiness evidence is malformed or still has unmet requirements');
      } else {
        // The edit gate's own reading of a record: a version this runtime does not read, a missing
        // field or an evaluation dated in the future does not establish READY.
        const unusable = require('../implementation-gate.ts').unusableDetail(rec, new Date());
        if (unusable) failures.push(`Task readiness evidence is unusable (${unusable})`);
      }
    }
  } catch (error: any) {
    failures.push(`Task readiness evidence could not be read (${error?.message || 'read error'})`);
  }

  // 2. The mechanical checks are the verify run records, read once by the caller (`review start`'s
  // precondition). Reasons that were not supplied cannot establish a successful pre-check.
  const verifyReasons = options?.verifyReasons;
  if (!Array.isArray(verifyReasons) || verifyReasons.some((reason: any) => typeof reason !== 'string')) {
    failures.push(`Verification evidence was not supplied for ${taskId}`);
  } else {
    failures.push(...verifyReasons.map((reason: string) => `Verification precondition unmet: ${reason}`));
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
  MechanicalPreChecksIncompleteError,
  assertMechanicalPreChecks,
};
