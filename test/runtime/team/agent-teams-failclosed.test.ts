'use strict';

// Feature 103 — fail-closed regressions for the admission controller (IC-002) and the mechanical
// pre-check guard (IC-003): a claim for a task already running is refused instead of replacing the
// running claim, a release from another run leaves the claim alone, and review is refused unless
// readiness evidence says READY and the caller supplied an empty list of unmet verify reasons (FR-005).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../../helper/tmp.ts');
const { AdmissionController } = require('../../../src/runtime/team/admission.ts');
const { assertMechanicalPreChecks } = require('../../../src/runtime/team/review-guard.ts');
const { writeReadinessRecord } = require('../../../src/runtime/readiness-record.ts');

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

  function project({ readiness, readinessText }: any = {}) {
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
    return root;
  }

  const READY = { state: 'READY' };
  const VERIFIED = { verifyReasons: [] };

  function refused(root: string, pattern: RegExp, options: any = VERIFIED) {
    assert.throws(() => assertMechanicalPreChecks(TASK, root, options), (err: any) => {
      assert.equal(err.code, 'ERR_MECHANICAL_CHECKS_FAILED');
      assert.match(err.failures.join('; '), pattern);
      return true;
    });
  }

  test('control: a READY record written by writeReadinessRecord and no unmet verify reason pass', () => {
    const res = assertMechanicalPreChecks(TASK, project({ readiness: READY }), VERIFIED);
    assert.deepEqual(res, { passed: true, failures: [] });
  });

  test('a missing readiness record is refused', () => {
    refused(project(), /readiness evidence is missing/);
  });

  test('an unparsable readiness record is refused', () => {
    refused(project({ readinessText: '{not json' }), /readiness evidence is unreadable/);
  });

  test('a readiness record with no state is refused', () => {
    refused(project({ readinessText: JSON.stringify({ version: 1, taskId: TASK }) }), /readiness state is 'undefined'/);
  });

  const RECORD = { version: 1, taskId: TASK, taskClass: 'feature', state: 'READY', evaluatedAt: '2026-01-01T00:00:00.000Z' };

  test('FU-avgfwf: a record the edit gate cannot read is refused, and PASSED is not READY', () => {
    refused(project({ readinessText: JSON.stringify({ ...RECORD, state: 'PASSED' }) }), /readiness state is 'PASSED'/);
    refused(project({ readinessText: JSON.stringify({ ...RECORD, version: 99 }) }), /readiness evidence is unusable \(version 99/);
    refused(project({ readinessText: JSON.stringify({ ...RECORD, evaluatedAt: '2999-01-01T00:00:00.000Z' }) }), /readiness evidence is unusable \(evaluated at 2999/);
    const { evaluatedAt: _omitted, ...noTime } = RECORD;
    refused(project({ readinessText: JSON.stringify(noTime) }), /readiness evidence is unusable \(no evaluatedAt\)/);
    assert.deepEqual(assertMechanicalPreChecks(TASK, project({ readinessText: JSON.stringify(RECORD) }), VERIFIED), { passed: true, failures: [] });
  });

  test('a READY record that still lists unmet requirements is refused', () => {
    refused(project({ readinessText: JSON.stringify({ version: 1, taskId: TASK, state: 'READY', unmet: ['R1'] }) }),
      /still has unmet requirements/);
  });

  test('verify reasons that were not supplied are refused', () => {
    refused(project({ readiness: READY }), /Verification evidence was not supplied/, null);
    refused(project({ readiness: READY }), /Verification evidence was not supplied/, {});
  });

  test('verify reasons that are not a list of strings are refused', () => {
    refused(project({ readiness: READY }), /Verification evidence was not supplied/, { verifyReasons: 'verify-missing' });
    refused(project({ readiness: READY }), /Verification evidence was not supplied/, { verifyReasons: [null] });
  });

  test('each unmet verify reason is refused by name', () => {
    const root = project({ readiness: READY });
    refused(root, /Verification precondition unmet: tree-dirty/, { verifyReasons: ['tree-dirty', 'verify-missing'] });
    refused(root, /Verification precondition unmet: verify-missing/, { verifyReasons: ['tree-dirty', 'verify-missing'] });
  });

  test('control: a NEEDS_EVIDENCE record and an unmet verify reason are refused with their details', () => {
    const root = project({
      readiness: { state: 'NEEDS_EVIDENCE', requirements: [{ id: 'R1', required: true, satisfied: false }] },
    });
    refused(root, /readiness state is 'NEEDS_EVIDENCE' \(R1\)/, { verifyReasons: ['tree-dirty'] });
    refused(root, /unmet: tree-dirty/, { verifyReasons: ['tree-dirty'] });
  });
});

describe('IC-003: the readiness record is looked up under the feature slug', () => {
  test('a record written under a feature namespace is found only when the slug is passed', () => {
    const root = suiteTempDir('doflow-team-slug-');
    const slug = '103-agent-teams';
    writeReadinessRecord({
      stateRoot: root, taskId: 'Task.9', slug, mode: 'workflow', inputs: {},
      report: { taskClass: 'feature', templateName: 'feature', requirements: [], state: 'READY' },
    });
    assert.ok(fs.existsSync(path.join(root, '.doflow', 'state', 'readiness', slug, 'Task.9.json')), 'setup: the record is namespaced');
    assert.throws(() => assertMechanicalPreChecks('Task.9', root, { verifyReasons: [] }), (err: any) => err.code === 'ERR_MECHANICAL_CHECKS_FAILED');
    assert.deepEqual(assertMechanicalPreChecks('Task.9', root, { slug, verifyReasons: [] }), { passed: true, failures: [] });
  });
});
