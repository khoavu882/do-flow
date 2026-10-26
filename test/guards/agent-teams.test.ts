'use strict';

// G72 — agent teams coordination protocol and safety invariants (Feature 103, IC-001, IC-002, IC-003, IC-004).
//
// This guard verifies:
// 1. `core/registry/settings.json` contains `team.writerCap` and `team.maxAttempts` with valid integer ranges and defaults.
// 2. `TaskBrief` and `TaskHandBack` schemas reject invalid role names (only the 7 valid roles) or missing required fields.
// 3. Reviewer separation logic rejects self-review across all 7 agent roles and matching worker identities.
// 4. AdmissionController collision detection rejects overlapping write sets and enforces concurrency caps.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

const {
  validateTaskBrief,
  validateTaskHandBack,
} = require('../../src/runtime/team/envelope.ts');

const {
  AdmissionController,
} = require('../../src/runtime/team/admission.ts');

const {
  assertReviewerSeparation,
} = require('../../src/runtime/team/review-guard.ts');

const SETTINGS_REGISTRY_FILE = path.join(REPO, 'core', 'registry', 'settings.json');

const VALID_AGENT_ROLES = Object.freeze([
  'spec-analyst',
  'system-architect',
  'delivery-lead',
  'core-implementer',
  'quality-guardian',
  'reviewer',
  'research-writer',
]);

describe('Guard G72: Settings Registry Declarations (IC-004)', () => {
  test('core/registry/settings.json declares team.writerCap and team.maxAttempts with valid ranges', () => {
    assert.ok(fs.existsSync(SETTINGS_REGISTRY_FILE), 'settings.json must exist');
    const settings = JSON.parse(fs.readFileSync(SETTINGS_REGISTRY_FILE, 'utf8'));
    const keys = settings.keys || {};

    // 1. team.writerCap
    assert.ok(keys['team.writerCap'], "settings.json must declare 'team.writerCap'");
    const writerCap = keys['team.writerCap'];
    assert.equal(writerCap.type, 'integer');
    assert.equal(writerCap.min, 1);
    assert.equal(writerCap.max, 8);
    // maint-thin (user ruling 2026-10-26): writes run single-threaded by default; the user raises the cap.
    assert.equal(writerCap.default, 1);
    assert.equal(writerCap.failSafe, 1);
    assert.equal(writerCap.env?.name, 'DOFLOW_TEAM_WRITER_CAP');
    assert.equal(writerCap.env?.parse, 'positive-int');
    assert.ok(
      Array.isArray(writerCap.consumers) && writerCap.consumers.includes('src/runtime/team/admission.ts'),
      "team.writerCap must name 'src/runtime/team/admission.ts' as consumer"
    );

    // 2. team.maxAttempts
    assert.ok(keys['team.maxAttempts'], "settings.json must declare 'team.maxAttempts'");
    const maxAttempts = keys['team.maxAttempts'];
    assert.equal(maxAttempts.type, 'integer');
    assert.equal(maxAttempts.min, 1);
    assert.equal(maxAttempts.max, 10);
    assert.equal(maxAttempts.default, 3);
    assert.equal(maxAttempts.failSafe, 3);
    assert.equal(maxAttempts.env?.name, 'DOFLOW_TEAM_MAX_ATTEMPTS');
    assert.equal(maxAttempts.env?.parse, 'positive-int');
    assert.ok(
      Array.isArray(maxAttempts.consumers) && maxAttempts.consumers.includes('src/runtime/team/admission.ts'),
      "team.maxAttempts must name 'src/runtime/team/admission.ts' as consumer"
    );
  });
});

describe('Guard G72: Agent Role and Envelope Invariants (IC-001)', () => {
  const sampleBrief = {
    schemaVersion: 1,
    taskId: 'Task.1',
    runKey: 'run-key-123',
    attempt: 1,
    agentRole: 'core-implementer',
    taskClass: 'feature',
    goal: 'Implement feature',
    writeSet: ['src/runtime/team/admission.ts'],
    readSet: ['docs/guide.md'],
    acceptanceCriteria: ['Passes unit tests'],
    inputs: [{ origin: 'user', label: 'prompt', content: 'Do something', quarantined: false }],
    timeoutSeconds: 300,
  };

  const sampleHandBack = {
    schemaVersion: 1,
    taskId: 'Task.1',
    runKey: 'run-key-123',
    attempt: 1,
    agentRole: 'core-implementer',
    outcome: 'COMPLETED',
    modifiedFiles: ['src/runtime/team/admission.ts'],
    evidence: [{ kind: 'test', locator: 'test/runtime/agent-teams.test.ts', summary: 'Passed' }],
    deviations: [],
    openQuestions: [],
    handBackNotes: 'Done',
  };

  test('TaskBrief and TaskHandBack accept all 7 valid specialist agent roles', () => {
    for (const role of VALID_AGENT_ROLES) {
      assert.doesNotThrow(() => {
        validateTaskBrief({ ...sampleBrief, agentRole: role });
      }, `TaskBrief must accept valid role '${role}'`);

      assert.doesNotThrow(() => {
        validateTaskHandBack({ ...sampleHandBack, agentRole: role });
      }, `TaskHandBack must accept valid role '${role}'`);
    }
  });

  test('TaskBrief and TaskHandBack reject invalid agent role names', () => {
    const invalidRoles = ['developer', 'tester', 'product-manager', 'admin', 'qa', ''];
    for (const role of invalidRoles) {
      assert.throws(
        () => validateTaskBrief({ ...sampleBrief, agentRole: role }),
        /ERR_INVALID_ENVELOPE/,
        `TaskBrief must reject invalid role '${role}'`
      );

      assert.throws(
        () => validateTaskHandBack({ ...sampleHandBack, agentRole: role }),
        /ERR_INVALID_ENVELOPE/,
        `TaskHandBack must reject invalid role '${role}'`
      );
    }
  });

  test('TaskBrief rejects malformed taskId format (must match /^[A-Za-z]+\\.\\d+$/)', () => {
    const badTaskIds = ['task-1', '1.1', 'Task_1', 'Task', 'Task.', ''];
    for (const taskId of badTaskIds) {
      assert.throws(
        () => validateTaskBrief({ ...sampleBrief, taskId }),
        /ERR_INVALID_ENVELOPE/,
        `TaskBrief must reject malformed taskId '${taskId}'`
      );
    }
  });

  test('TaskBrief and TaskHandBack reject missing mandatory fields', () => {
    const requiredBriefFields = ['schemaVersion', 'taskId', 'runKey', 'attempt', 'agentRole', 'taskClass', 'goal', 'writeSet', 'readSet', 'acceptanceCriteria', 'inputs', 'timeoutSeconds'];
    for (const field of requiredBriefFields) {
      const copy: any = { ...sampleBrief };
      delete copy[field];
      assert.throws(
        () => validateTaskBrief(copy),
        /ERR_INVALID_ENVELOPE/,
        `TaskBrief must reject missing field '${field}'`
      );
    }

    const requiredHandBackFields = ['schemaVersion', 'taskId', 'runKey', 'attempt', 'agentRole', 'outcome', 'modifiedFiles', 'evidence', 'deviations', 'openQuestions', 'handBackNotes'];
    for (const field of requiredHandBackFields) {
      const copy: any = { ...sampleHandBack };
      delete copy[field];
      assert.throws(
        () => validateTaskHandBack(copy),
        /ERR_INVALID_ENVELOPE/,
        `TaskHandBack must reject missing field '${field}'`
      );
    }
  });
});

describe('Guard G72: Reviewer Independence Enforcement (IC-003)', () => {
  test('assertReviewerSeparation rejects self-review across all 7 agent roles', () => {
    for (const role of VALID_AGENT_ROLES) {
      assert.throws(
        () => {
          assertReviewerSeparation({
            taskId: 'Task.1',
            authorRole: role as any,
            reviewerRole: role as any,
          });
        },
        /ERR_REVIEWER_SELF_REVIEW/,
        `Reviewer separation must forbid self-review when author and reviewer role are '${role}'`
      );
    }
  });

  test('assertReviewerSeparation rejects matching worker identities regardless of role', () => {
    assert.throws(
      () => {
        assertReviewerSeparation({
          taskId: 'Task.1',
          authorRole: 'core-implementer',
          reviewerRole: 'reviewer',
          authorIdentity: 'worker-session-77',
          reviewerIdentity: 'worker-session-77',
        });
      },
      /ERR_REVIEWER_SELF_REVIEW/,
      'Reviewer separation must forbid matching worker identities'
    );
  });

  test('assertReviewerSeparation passes when both role and worker identity differ', () => {
    assert.doesNotThrow(() => {
      assertReviewerSeparation({
        taskId: 'Task.1',
        authorRole: 'core-implementer',
        reviewerRole: 'reviewer',
        authorIdentity: 'worker-session-1',
        reviewerIdentity: 'worker-session-2',
      });
    });
  });
});

describe('Guard G72: Admission Controller Write-Set Collisions (IC-002)', () => {
  test('AdmissionController collision detection rejects overlapping write sets', () => {
    const controller = new AdmissionController({ writerCap: 2, maxAttempts: 3 });

    const decisionA = controller.claimTask({
      taskId: 'Task.1',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'worker-1',
      writeSet: ['src/runtime/team/admission.ts', 'src/runtime/team/envelope.ts'],
    });
    assert.equal(decisionA.admitted, true);

    const collision = controller.checkWriteSetCollision(['src/runtime/team/admission.ts']);
    assert.equal(collision.conflict, true);
    assert.equal(collision.conflictingTaskId, 'Task.1');
    assert.deepEqual(collision.overlappingFiles, ['src/runtime/team/admission.ts']);

    const decisionB = controller.claimTask({
      taskId: 'Task.2',
      runKey: 'run-1',
      agentRole: 'core-implementer',
      workerIdentity: 'worker-2',
      writeSet: ['src/runtime/team/admission.ts'],
    });
    assert.equal(decisionB.admitted, false);
    assert.equal(decisionB.reason, 'WRITE_SET_CONFLICT');
    assert.equal(decisionB.conflicts?.conflictingTaskId, 'Task.1');
  });
});
