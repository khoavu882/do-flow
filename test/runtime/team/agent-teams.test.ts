'use strict';

// Feature 103 — Agent Teams & Coordination Protocol Runtime Test Suite
// Covers
// IC-002 (AdmissionController, write-set collision, writerCap, maxAttempts),
// IC-003 (assertReviewerSeparation, assertMechanicalPreChecks),
// and IC-004 (team configuration & environment variable overrides).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../../helper/tmp.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');

const {
  AdmissionController,
  AdmissionError,
} = require('../../../src/runtime/team/admission.ts');

const {
  assertReviewerSeparation,
  assertMechanicalPreChecks,
  ReviewGuardError,
  NeverReviewOwnCodeError,
  MechanicalPreChecksIncompleteError,
} = require('../../../src/runtime/team/review-guard.ts');

describe('IC-002: Write-Ownership Admission Controller', () => {
  test('disjoint tasks are admitted successfully', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });

    const dec1 = controller.claimTask({
      taskId: 'Task.1',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'w1',
      writeSet: ['src/runtime/team/admission.ts'],
    });
    assert.equal(dec1.admitted, true);
    assert.equal(dec1.reason, 'ADMITTED');

    const dec2 = controller.claimTask({
      taskId: 'Task.2',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'w2',
      writeSet: ['src/runtime/team/review-guard.ts'],
    });
    assert.equal(dec2.admitted, true);
    assert.equal(dec2.reason, 'ADMITTED');
  });

  test('overlapping write sets are rejected with WRITE_SET_CONFLICT', () => {
    const controller = new AdmissionController({ writerCap: 3, maxAttempts: 3 });

    controller.claimTask({
      taskId: 'Task.1',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'w1',
      writeSet: ['src/runtime/team/admission.ts', 'src/shared.ts'],
    });

    // Task.2 proposes writeSet overlapping on src/shared.ts
    const dec2 = controller.claimTask({
      taskId: 'Task.2',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'w2',
      writeSet: ['src/other.ts', 'src/shared.ts'],
    });

    assert.equal(dec2.admitted, false);
    assert.equal(dec2.reason, 'WRITE_SET_CONFLICT');
    assert.equal(dec2.conflicts?.conflictingTaskId, 'Task.1');
    assert.deepEqual(dec2.conflicts?.overlappingFiles, ['src/shared.ts']);
  });

  test('releasing a claim permits previously conflicting tasks to proceed', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });

    controller.claimTask({
      taskId: 'Task.1',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'w1',
      writeSet: ['src/runtime/team/admission.ts'],
    });

    // Release Task.1
    controller.releaseTask({
      taskId: 'Task.1',
      runKey: 'run-1',
      outcome: 'COMPLETED',
      modifiedFiles: ['src/runtime/team/admission.ts'],
    });

    // Now Task.2 can claim src/runtime/team/admission.ts
    const dec2 = controller.claimTask({
      taskId: 'Task.2',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'w2',
      writeSet: ['src/runtime/team/admission.ts'],
    });
    assert.equal(dec2.admitted, true);
  });

  test('concurrency exceeding team.writerCap is rejected with WRITER_CAP_EXCEEDED', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });

    controller.claimTask({
      taskId: 'Task.1',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'w1',
      writeSet: ['src/file1.ts'],
    });

    controller.claimTask({
      taskId: 'Task.2',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'w2',
      writeSet: ['src/file2.ts'],
    });

    // Active count is 2 (at cap). Task.3 must be rejected
    const dec3 = controller.claimTask({
      taskId: 'Task.3',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'w3',
      writeSet: ['src/file3.ts'],
    });

    assert.equal(dec3.admitted, false);
    assert.equal(dec3.reason, 'WRITER_CAP_EXCEEDED');
  });

  test('attempts exceeding team.maxAttempts are rejected with MAX_ATTEMPTS_EXCEEDED', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });

    // Attempt 1
    const d1 = controller.claimTask({ taskId: 'Task.1', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w1', writeSet: ['src/file.ts'] });
    assert.equal(d1.admitted, true);
    controller.releaseTask({ taskId: 'Task.1', runKey: 'r1', outcome: 'FAILED', modifiedFiles: [] });

    // Attempt 2
    const d2 = controller.claimTask({ taskId: 'Task.1', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w1', writeSet: ['src/file.ts'] });
    assert.equal(d2.admitted, true);
    controller.releaseTask({ taskId: 'Task.1', runKey: 'r1', outcome: 'FAILED', modifiedFiles: [] });

    // Attempt 3
    const d3 = controller.claimTask({ taskId: 'Task.1', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w1', writeSet: ['src/file.ts'] });
    assert.equal(d3.admitted, true);
    controller.releaseTask({ taskId: 'Task.1', runKey: 'r1', outcome: 'FAILED', modifiedFiles: [] });

    // Attempt 4 (exceeds maxAttempts 3)
    const d4 = controller.claimTask({ taskId: 'Task.1', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w1', writeSet: ['src/file.ts'] });
    assert.equal(d4.admitted, false);
    assert.equal(d4.reason, 'MAX_ATTEMPTS_EXCEEDED');
  });
});

describe('IC-003: Reviewer Independence Guard', () => {
  test('assertReviewerSeparation throws ERR_REVIEWER_SELF_REVIEW when authorRole === reviewerRole', () => {
    assert.throws(
      () => {
        assertReviewerSeparation({
          taskId: 'Task.1',
          authorRole: 'core-implementer',
          reviewerRole: 'core-implementer',
          authorIdentity: 'worker-1',
          reviewerIdentity: 'worker-2',
        });
      },
      (err: any) => {
        assert.equal(err.code, 'ERR_REVIEWER_SELF_REVIEW');
        return true;
      }
    );
  });

  test('assertReviewerSeparation throws ERR_REVIEWER_SELF_REVIEW when authorIdentity === reviewerIdentity', () => {
    assert.throws(
      () => {
        assertReviewerSeparation({
          taskId: 'Task.1',
          authorRole: 'core-implementer',
          reviewerRole: 'reviewer',
          authorIdentity: 'worker-instance-99',
          reviewerIdentity: 'worker-instance-99',
        });
      },
      (err: any) => {
        assert.equal(err.code, 'ERR_REVIEWER_SELF_REVIEW');
        return true;
      }
    );
  });

  test('assertReviewerSeparation passes when author and reviewer role and identity differ', () => {
    assert.doesNotThrow(() => {
      assertReviewerSeparation({
        taskId: 'Task.1',
        authorRole: 'core-implementer',
        reviewerRole: 'reviewer',
        authorIdentity: 'worker-instance-1',
        reviewerIdentity: 'worker-instance-2',
      });
    });
  });

  test('assertMechanicalPreChecks reports passed when pre-checks succeed', () => {
    // FR-005: review needs evidence that the checks completed with PASS, so the success case holds a
    // READY readiness record and the caller's empty list of unmet verify reasons.
    const { writeReadinessRecord } = require('../../../src/runtime/readiness-record.ts');
    const root = suiteTempDir('doflow-team-prechecks-');
    writeReadinessRecord({
      stateRoot: root, taskId: 'Task.1', mode: 'workflow', inputs: {},
      report: { state: 'READY', taskClass: 'feature', templateName: 'feature', requirements: [] },
    });
    const res = assertMechanicalPreChecks('Task.1', root, { verifyReasons: [] });
    assert.equal(res.passed, true);
    assert.equal(res.failures.length, 0);
  });
});

describe('IC-004: Configuration & Environment Overrides', () => {
  test('AdmissionController respects DOFLOW_TEAM_WRITER_CAP environment override', () => {
    const originalEnv = process.env.DOFLOW_TEAM_WRITER_CAP;
    try {
      process.env.DOFLOW_TEAM_WRITER_CAP = '3';
      const controller = new AdmissionController();

      controller.claimTask({ taskId: 'Task.1', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w1', writeSet: ['src/1.ts'] });
      controller.claimTask({ taskId: 'Task.2', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w2', writeSet: ['src/2.ts'] });
      // 3rd task admitted because cap is 3
      const dec3 = controller.claimTask({ taskId: 'Task.3', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w3', writeSet: ['src/3.ts'] });
      assert.equal(dec3.admitted, true);

      // 4th task rejected
      const dec4 = controller.claimTask({ taskId: 'Task.4', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w4', writeSet: ['src/4.ts'] });
      assert.equal(dec4.admitted, false);
      assert.equal(dec4.reason, 'WRITER_CAP_EXCEEDED');
    } finally {
      if (originalEnv !== undefined) process.env.DOFLOW_TEAM_WRITER_CAP = originalEnv;
      else delete process.env.DOFLOW_TEAM_WRITER_CAP;
    }
  });

  test('AdmissionController respects DOFLOW_TEAM_MAX_ATTEMPTS environment override', () => {
    const originalEnv = process.env.DOFLOW_TEAM_MAX_ATTEMPTS;
    try {
      process.env.DOFLOW_TEAM_MAX_ATTEMPTS = '2';
      const controller = new AdmissionController();

      // Attempt 1
      controller.claimTask({ taskId: 'Task.1', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w1', writeSet: ['src/1.ts'] });
      controller.releaseTask({ taskId: 'Task.1', runKey: 'r1', outcome: 'FAILED', modifiedFiles: [] });

      // Attempt 2
      controller.claimTask({ taskId: 'Task.1', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w1', writeSet: ['src/1.ts'] });
      controller.releaseTask({ taskId: 'Task.1', runKey: 'r1', outcome: 'FAILED', modifiedFiles: [] });

      // Attempt 3 rejected (exceeds 2)
      const dec3 = controller.claimTask({ taskId: 'Task.1', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w1', writeSet: ['src/1.ts'] });
      assert.equal(dec3.admitted, false);
      assert.equal(dec3.reason, 'MAX_ATTEMPTS_EXCEEDED');
    } finally {
      if (originalEnv !== undefined) process.env.DOFLOW_TEAM_MAX_ATTEMPTS = originalEnv;
      else delete process.env.DOFLOW_TEAM_MAX_ATTEMPTS;
    }
  });

  test('Explicit controller options override environment variables', () => {
    const originalEnv = process.env.DOFLOW_TEAM_WRITER_CAP;
    try {
      process.env.DOFLOW_TEAM_WRITER_CAP = '5';
      const controller = new AdmissionController({ writerCap: 1 });

      controller.claimTask({ taskId: 'Task.1', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w1', writeSet: ['src/1.ts'] });
      const dec2 = controller.claimTask({ taskId: 'Task.2', runKey: 'r1', agentRole: 'core-implementer', workerIdentity: 'w2', writeSet: ['src/2.ts'] });
      assert.equal(dec2.admitted, false);
      assert.equal(dec2.reason, 'WRITER_CAP_EXCEEDED');
    } finally {
      if (originalEnv !== undefined) process.env.DOFLOW_TEAM_WRITER_CAP = originalEnv;
      else delete process.env.DOFLOW_TEAM_WRITER_CAP;
    }
  });

  test('AdmissionController resolves settings with correct layering precedence (defaults < settings.json < settings.local.json < env < options)', () => {
    const root = suiteTempDir('doflow-team-layering-');
    const doflowDir = path.join(root, '.doflow');
    fs.mkdirSync(doflowDir, { recursive: true });

    // 1. Defaults: writerCap 1 (maint-thin: writes run single-threaded), maxAttempts 3
    const c1 = new AdmissionController({ projectRoot: root, env: {} });
    assert.equal(c1.writerCap, 1);
    assert.equal(c1.maxAttempts, 3);

    // 2. settings.json: writerCap 4, maxAttempts 5
    fs.writeFileSync(path.join(doflowDir, 'settings.json'), JSON.stringify({
      'team.writerCap': 4,
      'team.maxAttempts': 5,
    }));
    const c2 = new AdmissionController({ projectRoot: root });
    assert.equal(c2.writerCap, 4);
    assert.equal(c2.maxAttempts, 5);

    // 3. settings.local.json overrides settings.json: writerCap 6
    fs.writeFileSync(path.join(doflowDir, 'settings.local.json'), JSON.stringify({
      'team.writerCap': 6,
    }));
    const c3 = new AdmissionController({ projectRoot: root });
    assert.equal(c3.writerCap, 6);
    assert.equal(c3.maxAttempts, 5); // inherited from settings.json

    // 4. Env var overrides files: DOFLOW_TEAM_WRITER_CAP=7
    const c4 = new AdmissionController({
      projectRoot: root,
      env: { DOFLOW_TEAM_WRITER_CAP: '7' },
    });
    assert.equal(c4.writerCap, 7);
    assert.equal(c4.maxAttempts, 5);

    // 5. Options override everything: writerCap 1
    const c5 = new AdmissionController({
      projectRoot: root,
      env: { DOFLOW_TEAM_WRITER_CAP: '7' },
      writerCap: 1,
    });
    assert.equal(c5.writerCap, 1);
  });
});
