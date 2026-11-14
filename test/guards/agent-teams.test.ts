'use strict';

// G72 — agent teams coordination protocol and safety invariants (Feature 103, IC-002, IC-003, IC-004).
//
// This guard verifies:
// 1. `core/registry/settings.json` contains `team.writerCap` and `team.maxAttempts` with valid integer ranges and defaults.
// 2. Reviewer separation logic rejects self-review for every shipped agent role and matching worker identities.
// 3. AdmissionController collision detection rejects overlapping write sets and enforces concurrency caps.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

const {
  AdmissionController,
} = require('../../src/runtime/team/admission.ts');

const {
  assertReviewerSeparation,
} = require('../../src/runtime/team/review-guard.ts');

const SETTINGS_REGISTRY_FILE = path.join(REPO, 'core', 'registry', 'settings.json');

// The roles are the shipped agent specs, read from disk so a new archetype is covered without an edit here.
const VALID_AGENT_ROLES = Object.freeze(
  fs.readdirSync(path.join(REPO, 'core', 'shared', 'agent-specs'))
    .filter((name: string) => name.endsWith('.md'))
    .map((name: string) => name.slice(0, -'.md'.length))
    .sort(),
);
assert.ok(VALID_AGENT_ROLES.length > 0, 'core/shared/agent-specs holds at least one agent spec');

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

describe('Guard G72: Reviewer Independence Enforcement (IC-003)', () => {
  test('assertReviewerSeparation rejects self-review for every shipped agent role', () => {
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
      writeSet: ['src/runtime/team/admission.ts', 'src/runtime/team/review-guard.ts'],
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
