'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { taskStoreDir, resolveTaskScope } = require('./task-scope.ts');
const { assertSafeTaskId } = require('./evidence-ledger.ts');
const { readTaskState, updateTaskState } = require('./task-state.ts');
const { storeFile, activeAttempt } = require('./task-attempts.ts');
const { projectRoot: lifecycleProjectRoot } = require('./lifecycle/root.ts');

/**
 * Path of a task's retrieval-plan store.
 *
 * The task id is validated by the evidence ledger's own rule, unchanged: it becomes a filename, so
 * it must never be able to name a path.
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
function updatePlan(projectRoot: any, taskId: any, slug: any, build: any, fsImpl: any = fs): string {
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

/**
 * Resolves a declared need from a plan for a given intent.
 *
 * @param {any} plan
 * @param {string} intent
 * @param {string} taskId
 * @returns {{ ok: true, queryRef: string, need: any } | { ok: false, message: string }}
 */
function resolveNeed(plan: any, intent: string, taskId: string): any {
  if (!plan) {
    const message = `no retrieval plan is declared for task '${taskId}', so --need '${intent}' names nothing. Declare one first: doflow retrieval-plan --task-id ${taskId} --action declare --need ${intent}, then re-run.`;
    return { ok: false, message };
  }
  const declaredIntents = Array.isArray(plan.needs)
    ? plan.needs.map((n: any) => n.intent).filter(Boolean).sort()
    : [];
  const list = declaredIntents.length > 0 ? declaredIntents.join(', ') : 'none declared';

  if (!plan.planId) {
    const message = `the retrieval plan for task '${taskId}' was declared before query binding and has no plan id. Re-declare it: doflow retrieval-plan --task-id ${taskId} --action declare --need ${list}, then re-run.`;
    return { ok: false, message };
  }

  const need = Array.isArray(plan.needs) ? plan.needs.find((n: any) => n.intent === intent) : null;
  if (!need) {
    const message = `'${intent}' is not a declared need of task '${taskId}' (plan ${plan.planId}). Declared: ${list}. Re-run with one of them, or re-declare the plan with this need.`;
    return { ok: false, message };
  }

  if (!need.queryRef) {
    const message = `the retrieval plan for task '${taskId}' was declared before query binding and has no plan id. Re-declare it: doflow retrieval-plan --task-id ${taskId} --action declare --need ${list}, then re-run.`;
    return { ok: false, message };
  }

  return {
    ok: true,
    queryRef: need.queryRef,
    need,
  };
}

/**
 * Reads the 070 active attempt ref for a task, returning `${taskId}#${token}` or null.
 *
 * Resolves the feature slug via resolveTaskScope, reads storeFile(lifecycleProjectRoot(projectRoot), featureSlug),
 * and finds the active attempt for the task. If no slug, no store, no entry or no active attempt exists,
 * or if any failure occurs finding or reading the store, returns null (IC-005: "no attempt" never fails the write).
 *
 * @param {string} projectRoot
 * @param {string} taskId
 * @param {string|null} [slug]
 * @param {any} [fsImpl]
 * @returns {string|null}
 */
function activeAttemptRef(projectRoot: any, taskId: any, slug: any = null, fsImpl: any = fs): string | null {
  try {
    const featureSlug = resolveTaskScope({ projectRoot, taskId, slug }).slug;
    if (!featureSlug) return null;

    const file = storeFile(lifecycleProjectRoot(projectRoot), featureSlug);
    if (!fsImpl.existsSync(file)) return null;

    const data = readTaskState(fsImpl, file);
    if (!data || !data.tasks || !data.tasks[taskId]) return null;

    const active = activeAttempt(data.tasks[taskId]);
    if (!active || active.token === undefined || active.token === null) return null;

    return `${taskId}#${active.token}`;
  } catch {
    return null;
  }
}

module.exports = {
  planPath,
  readPlan,
  updatePlan,
  mintPlanId,
  resolveNeed,
  activeAttemptRef,
};
