'use strict';

// Feature 103 — fail-closed regressions for the admission controller (IC-002) and the mechanical
// pre-check guard (IC-003): a claim for a task already running is refused instead of replacing the
// running claim, a release from another run leaves the claim alone, and review is refused unless
// readiness and pre-check evidence both exist and say PASS (FR-005).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { AdmissionController } = require('../../src/runtime/team/admission.ts');
const { assertMechanicalPreChecks } = require('../../src/runtime/team/review-guard.ts');
const { writeReadinessRecord } = require('../../src/runtime/readiness-record.ts');

const claim = (controller: any, runKey: string, writeSet: string[], taskId = 'Task.1') =>
  controller.claimTask({ taskId, runKey, agentRole: 'core-implementer', workerIdentity: `w-${runKey}`, writeSet });

const release = (controller: any, runKey: any, taskId = 'Task.1') =>
  controller.releaseTask({ taskId, runKey, outcome: 'FAILED', modifiedFiles: [] });

describe('IC-002: a running claim is never replaced or released by another run', () => {
  test('re-claiming an active task with a disjoint write set is refused and the running claim is kept', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });
    assert.equal(claim(controller, 'run-A', ['src/a.ts']).admitted, true);
    const again = claim(controller, 'run-B', ['src/b.ts']);
    assert.equal(again.admitted, false);
    assert.equal(again.reason, 'TASK_ALREADY_ACTIVE');
    const active = controller.getActiveClaims();
    assert.equal(active.length, 1);
    assert.equal(active[0].runKey, 'run-A');
    assert.deepEqual(active[0].writeSet, ['src/a.ts']);
    // src/a.ts is still owned by the running claim.
    assert.equal(claim(controller, 'run-C', ['src/a.ts'], 'Task.2').reason, 'WRITE_SET_CONFLICT');
  });

  test('re-claiming an active read-only task is refused', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });
    assert.equal(claim(controller, 'run-A', []).admitted, true);
    assert.equal(claim(controller, 'run-B', []).reason, 'TASK_ALREADY_ACTIVE');
  });

  test('the same runKey re-claiming its own active task is refused as already active', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });
    assert.equal(claim(controller, 'run-A', ['src/a.ts']).admitted, true);
    assert.equal(claim(controller, 'run-A', ['src/a.ts']).reason, 'TASK_ALREADY_ACTIVE');
    assert.equal(controller.getActiveClaims().length, 1);
  });

  test('a TASK_ALREADY_ACTIVE refusal spends no attempt', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 2 });
    assert.equal(claim(controller, 'run-A', ['src/a.ts']).attemptIndex, 1);
    assert.equal(claim(controller, 'run-B', ['src/b.ts']).reason, 'TASK_ALREADY_ACTIVE');
    release(controller, 'run-A');
    const second = claim(controller, 'run-C', ['src/a.ts']);
    assert.equal(second.admitted, true);
    assert.equal(second.attemptIndex, 2);
  });

  test('a release whose runKey differs from the running claim leaves the claim active', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });
    claim(controller, 'run-A', ['src/a.ts']);
    release(controller, 'run-stale');
    assert.equal(controller.getActiveClaims().length, 1);
    assert.equal(claim(controller, 'run-X', ['src/a.ts'], 'Task.2').reason, 'WRITE_SET_CONFLICT');
  });

  test('a release with no runKey leaves the claim active', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });
    claim(controller, 'run-A', ['src/a.ts']);
    release(controller, undefined);
    assert.equal(controller.getActiveClaims().length, 1);
  });

  test('control: the matching runKey releases the claim', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });
    claim(controller, 'run-A', ['src/a.ts']);
    release(controller, 'run-A');
    assert.equal(controller.getActiveClaims().length, 0);
    assert.equal(claim(controller, 'run-X', ['src/a.ts'], 'Task.2').admitted, true);
  });
});

describe('IC-003: mechanical pre-checks fail closed without PASS evidence', () => {
  const TASK = 'Task.7';

  function project({ readiness, readinessText, preCheck, preCheckText }: any = {}) {
    const root = suiteTempDir('doflow-team-failclosed-');
    if (readiness) {
      writeReadinessRecord({
        stateRoot: root, taskId: TASK, mode: 'workflow', inputs: {},
        report: { taskClass: 'feature', templateName: 'feature', requirements: [], ...readiness },
      });
    }
    if (readinessText !== undefined) {
      const dir = path.join(root, '.doflow', 'state', 'readiness');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${TASK}.json`), readinessText);
    }
    const text = preCheckText !== undefined ? preCheckText : preCheck !== undefined ? JSON.stringify(preCheck) : undefined;
    if (text !== undefined) {
      const dir = path.join(root, '.doflow', 'state', 'team', 'pre-checks');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${TASK}.json`), text);
    }
    return root;
  }

  const READY = { state: 'READY' };
  const PASS = { passed: true, failures: [] };

  function refused(root: string, pattern: RegExp) {
    assert.throws(() => assertMechanicalPreChecks(TASK, root), (err: any) => {
      assert.equal(err.code, 'ERR_MECHANICAL_CHECKS_FAILED');
      assert.match(err.failures.join('; '), pattern);
      return true;
    });
  }

  test('control: a READY record written by writeReadinessRecord and a passing pre-check pass', () => {
    const res = assertMechanicalPreChecks(TASK, project({ readiness: READY, preCheck: PASS }));
    assert.deepEqual(res, { passed: true, failures: [] });
  });

  test('a missing readiness record is refused', () => {
    refused(project({ preCheck: PASS }), /readiness evidence is missing/);
  });

  test('an unparsable readiness record is refused', () => {
    refused(project({ readinessText: '{not json', preCheck: PASS }), /readiness evidence is unreadable/);
  });

  test('a readiness record with no state is refused', () => {
    refused(project({ readinessText: JSON.stringify({ version: 1, taskId: TASK }), preCheck: PASS }), /readiness state is 'undefined'/);
  });

  test('a READY record that still lists unmet requirements is refused', () => {
    refused(project({ readinessText: JSON.stringify({ version: 1, taskId: TASK, state: 'READY', unmet: ['R1'] }), preCheck: PASS }),
      /still has unmet requirements/);
  });

  test('a missing pre-check record is refused', () => {
    refused(project({ readiness: READY }), /Pre-check evidence is missing/);
  });

  test('an unparsable pre-check record is refused', () => {
    refused(project({ readiness: READY, preCheckText: '{not json' }), /Pre-check evidence could not be read/);
  });

  test('a pre-check record without a boolean passed and a failures list is refused', () => {
    refused(project({ readiness: READY, preCheck: {} }), /Pre-check evidence is malformed/);
    refused(project({ readiness: READY, preCheck: { passed: 'yes', failures: [] } }), /Pre-check evidence is malformed/);
    refused(project({ readiness: READY, preCheck: [] }), /Pre-check evidence is malformed/);
  });

  test('a pre-check marked passed that lists failures is refused', () => {
    refused(project({ readiness: READY, preCheck: { passed: true, failures: ['lint'] } }), /reports failures while marked passed/);
  });

  test('control: a NEEDS_EVIDENCE record and a failing pre-check are refused with their details', () => {
    const root = project({
      readiness: { state: 'NEEDS_EVIDENCE', requirements: [{ id: 'R1', required: true, satisfied: false }] },
      preCheck: { passed: false, failures: ['build failed'] },
    });
    refused(root, /readiness state is 'NEEDS_EVIDENCE' \(R1\)/);
    refused(root, /build failed/);
  });
});
