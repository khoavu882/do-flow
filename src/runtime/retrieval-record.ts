'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { taskStoreDir } = require('./task-scope.ts');
const { assertSafeTaskId } = require('./evidence-ledger.ts');
const { readTaskState, updateTaskState } = require('./task-state.ts');

/**
 * Path of a task's retrieval-plan store.
 * @param {string} projectRoot
 * @param {string} taskId
 * @param {string|null} [slug]
 * @returns {string}
 */
function planPath(projectRoot: any, taskId: any, slug: any = null): string {
  const dir = taskStoreDir({ projectRoot, store: 'retrieval', taskId: assertSafeTaskId(taskId), slug });
  return path.join(dir, `${taskId}.json`);
}

/**
 * Reads and validates one task's retrieval plan via readTaskState.
 * Returns null when the plan file does not exist.
 * @param {string} projectRoot
 * @param {string} taskId
 * @param {string|null} [slug]
 * @param {any} [fsImpl]
 * @returns {any|null}
 */
function readPlan(projectRoot: any, taskId: any, slug: any = null, fsImpl: any = fs): any | null {
  const file = planPath(projectRoot, taskId, slug);
  return readTaskState(fsImpl, file);
}

/**
 * Updates a task's retrieval plan under the task-state lock.
 * @param {string} projectRoot
 * @param {string} taskId
 * @param {string|null} slug
 * @param {(disk: any|null) => any} build
 * @param {any} [fsImpl]
 * @returns {string} the written file path
 */
function updatePlan(projectRoot: any, taskId: any, slug: any = null, build?: any, fsImpl: any = fs): string {
  if (typeof slug === 'function') {
    fsImpl = build || fs;
    build = slug;
    slug = null;
  }
  const file = planPath(projectRoot, taskId, slug);
  return updateTaskState({ fsImpl, file, build });
}

/**
 * Mints a new plan id: rp_<base36 ms>_<4 hex>.
 * @returns {string}
 */
function mintPlanId(): string {
  return `rp_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
}

module.exports = {
  planPath,
  readPlan,
  updatePlan,
  mintPlanId,
};
