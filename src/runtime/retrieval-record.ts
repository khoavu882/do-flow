'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { taskStoreDir, taskRecord, resolveTaskScope } = require('./task-scope.ts');
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
  return readTaskState(fsImpl, taskRecord({ projectRoot, store: 'retrieval', taskId: assertSafeTaskId(taskId), slug, fsImpl }).read);
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
function updatePlan(projectRoot: any, taskId: any, slug: any, build: any, fsImpl: any = fs, prepare?: any): string {
  const { file, seed } = taskRecord({ projectRoot, store: 'retrieval', taskId: assertSafeTaskId(taskId), slug, fsImpl });
  return updateTaskState({ fsImpl, file, build, prepare: () => { seed(); if (prepare) prepare(); } });
}

/** Move a syntactically unreadable plan aside before its replacement is written under the lock. */
function moveCorruptPlanAside(projectRoot: any, taskId: any, slug: any = null, fsImpl: any = fs): string | null {
  const file = planPath(projectRoot, taskId, slug);
  if (!fsImpl.existsSync(file)) return null;
  try {
    JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    return null;
  } catch (error: any) {
    if (!(error instanceof SyntaxError)) throw error;
    const corruptFile = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fsImpl.renameSync(file, corruptFile);
    return corruptFile;
  }
}

/**
 * Mints a new plan id: rp_<base36 ms>_<4 hex>.
 * @returns {string}
 */
function mintPlanId(): string {
  return `rp_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Formats declared intents from a plan: sorted, comma-joined, or 'none declared'.
 *
 * @param {any} plan
 * @returns {string}
 */
function declaredIntentList(plan: any, sep = ', '): string {
  const declaredIntents = Array.isArray(plan?.needs)
    ? plan.needs.map((n: any) => n.intent).filter(Boolean).sort()
    : [];
  return declaredIntents.length > 0 ? declaredIntents.join(sep) : 'none declared';
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
  const list = declaredIntentList(plan);

  if (!plan.planId) {
    const message = `the retrieval plan for task '${taskId}' was declared before query binding and has no plan id. Re-declare it: doflow retrieval-plan --task-id ${taskId} --action declare --need ${declaredIntentList(plan, ',')}, then re-run.`;
    return { ok: false, message };
  }

  const need = Array.isArray(plan.needs) ? plan.needs.find((n: any) => n.intent === intent) : null;
  if (!need) {
    const message = `'${intent}' is not a declared need of task '${taskId}' (plan ${plan.planId}). Declared: ${list}. Re-run with one of them, or re-declare the plan with this need.`;
    return { ok: false, message };
  }

  if (!need.queryRef) {
    const message = `the retrieval plan for task '${taskId}' was declared before query binding and has no plan id. Re-declare it: doflow retrieval-plan --task-id ${taskId} --action declare --need ${declaredIntentList(plan, ',')}, then re-run.`;
    return { ok: false, message };
  }

  return {
    ok: true,
    queryRef: need.queryRef,
    need,
  };
}

/** Resolve the plan's query binding and the task's active attempt in one reusable operation. */
function resolveRetrievalBinding({ projectRoot, taskId, intent, slug = null, fsImpl = fs, attemptRoot = null }: any): any {
  const plan = readPlan(projectRoot, taskId, slug, fsImpl);
  const resolved = resolveNeed(plan, intent, taskId);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    plan,
    queryRef: resolved.queryRef,
    need: resolved.need,
    attemptRef: activeAttemptRef(projectRoot, taskId, slug, fsImpl, attemptRoot),
  };
}

/** Append one validated provider attempt under the retrieval-plan state lock. */
function appendRetrievalAttempt({
  projectRoot, taskId, intent, provider, status, reason, note = null, indexState,
  slug = null, attemptRef = undefined, fsImpl = fs, expectedCapability = undefined,
  expectedPrimaryProvider = undefined, registeredProviders = undefined,
}: any): any {
  const allowedIndexStates = ['FRESH', 'STALE', 'UNKNOWN', 'NOT_APPLICABLE'];
  if (!allowedIndexStates.includes(indexState)) {
    throw new Error(`attempt indexState '${indexState}' is invalid; expected one of ${allowedIndexStates.join(', ')}`);
  }
  const allowedReasons: Record<string, string[]> = {
    EMPTY: ['empty-answer', 'index-stale', 'index-unverifiable'],
    UNREACHED: ['provider-unavailable', 'policy-bypass', 'provider-error', 'timeout'],
    UNVERIFIED: ['index-unverifiable'],
  };
  if (status === 'RETRIEVED') throw new Error('RETRIEVED is derived from evidence and cannot be appended as a provider attempt');
  if (!Object.prototype.hasOwnProperty.call(allowedReasons, status) || !allowedReasons[status].includes(reason)) {
    throw new Error(`attempt reason '${reason}' is not valid for status '${status}'`);
  }
  if (!Array.isArray(registeredProviders) || !registeredProviders.includes(provider)) {
    throw new Error(`provider '${provider}' is not registered for this capability`);
  }
  if (note !== null && String(note).length > 160) throw new Error('attempt note is longer than 160 characters');

  let savedAttempt: any = null;
  const file = updatePlan(projectRoot, taskId, slug, (disk: any) => {
    if (disk === null) throw new Error(`the retrieval plan for task ${taskId} was removed during the update; re-declare it`);
    const current = disk;
    const targetNeed = Array.isArray(current.needs) ? current.needs.find((need: any) => need.intent === intent) : null;
    if (!targetNeed) throw new Error(`need '${intent}' missing from disk plan during update`);
    if (expectedCapability !== undefined && targetNeed.capability !== expectedCapability) {
      throw new Error(`need '${intent}' capability changed during update`);
    }
    if (expectedPrimaryProvider !== undefined && targetNeed.provider !== expectedPrimaryProvider) {
      throw new Error(`need '${intent}' provider changed during update`);
    }
    if (provider === undefined || provider === null || String(provider).trim() === '') throw new Error('attempt provider is required');
    if (!Array.isArray(targetNeed.attempts)) targetNeed.attempts = [];
    const n = targetNeed.attempts.reduce((max: number, prior: any) => Math.max(max, Number.isInteger(prior?.n) ? prior.n : 0), 0) + 1;
    const role = provider === targetNeed.provider ? 'primary' : 'fallback';
    savedAttempt = {
      n, provider, capability: targetNeed.capability, role, status, reason,
      note: note !== undefined && note !== null ? String(note) : null,
      indexState,
      attemptRef: attemptRef === undefined ? activeAttemptRef(projectRoot, taskId, slug, fsImpl) : attemptRef,
      evidenceIds: [],
      recordedAt: new Date().toISOString(),
      recordedBy: 'caller',
    };
    targetNeed.attempts.push(savedAttempt);
    return current;
  }, fsImpl);
  return { file, attempt: savedAttempt };
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
function activeAttemptRef(projectRoot: any, taskId: any, slug: any = null, fsImpl: any = fs, attemptRoot: any = null): string | null {
  try {
    const featureSlug = resolveTaskScope({ projectRoot, taskId, slug }).slug;
    if (!featureSlug) return null;

    const file = storeFile(attemptRoot || lifecycleProjectRoot(projectRoot), featureSlug);
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

/** Binds active evidence to declared query refs and explains evidence that could have matched. */
function bindEvidence(plan: any, items: any[]) {
  const byNeed = new Map<string, any[]>();
  const unbound: any[] = [];
  const needs = Array.isArray(plan?.needs) ? plan.needs : [];
  for (const need of needs) byNeed.set(need.intent, []);
  for (const item of items) {
    if (item.status !== 'active') continue;
    const source = item.source || {};
    const exact = needs.find((need: any) => need.queryRef && need.queryRef === source.queryRef);
    if (exact) {
      if (plan.attemptRef && source.attemptRef && plan.attemptRef !== source.attemptRef) {
        unbound.push({ id: item.id, cause: 'other-attempt' });
      } else {
        const matches = byNeed.get(exact.intent);
        if (matches) matches.push(item);
      }
      continue;
    }
    if (source.queryRef) {
      unbound.push({ id: item.id, cause: 'replaced-plan' });
    } else if (needs.some((need: any) => need.capability && need.capability === source.capability)) {
      unbound.push({ id: item.id, cause: 'no-query-ref' });
    }
  }
  return { byNeed, unbound };
}

/** Selects the highest-precedence recorded attempt, with the earliest attempt winning ties. */
function deriveOutcome(need: any) {
  const precedence: Record<string, number> = { RETRIEVED: 0, EMPTY: 1, UNVERIFIED: 3, UNREACHED: 4 };
  const attempts = (Array.isArray(need?.attempts) ? need.attempts : []).filter((attempt: any) =>
    !(attempt.recordedBy === 'derived' && attempt.basis !== 'report-need'
      && (!Array.isArray(attempt.evidenceIds) || attempt.evidenceIds.length === 0)));
  const ranked = [...attempts].sort((a, b) => {
    const rank = (attempt: any) => attempt.status === 'EMPTY' && ['STALE', 'UNKNOWN'].includes(attempt.indexState)
      ? (attempt.indexState === 'STALE' ? 2 : 3)
      : (precedence[attempt.status] ?? 4);
    return rank(a) - rank(b) || a.n - b.n;
  });
  const winner = ranked[0];
  return {
    result: winner ? winner.status : 'UNREACHED',
    resolvedBy: winner ? winner.n : null,
    viaFallback: Boolean(winner && winner.role === 'fallback'),
  };
}

module.exports = {
  planPath,
  readPlan,
  updatePlan,
  moveCorruptPlanAside,
  mintPlanId,
  resolveNeed,
  resolveRetrievalBinding,
  appendRetrievalAttempt,
  activeAttemptRef,
  declaredIntentList,
  bindEvidence,
  deriveOutcome,
};
