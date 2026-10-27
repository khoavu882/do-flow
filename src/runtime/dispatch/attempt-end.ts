'use strict';

// Feature 082 B.3 (IC-024, IC-008 usage; DEC-007, DEC-026, DEC-039, DEC-053): the attempt-end rule.
//
// Every way the loop ends a dispatch's 080 attempt goes through this module, so `integrate.ts` and
// `loop.ts` share one rule and `integrate.ts` never requires `loop.ts` (DEC-053). Each `*Attempt`
// function runs inside a `mutateDispatch` decide callback: it takes the store that callback holds,
// makes one in-process 080 call (`finish` or `release`, each taking the ledger lock inside it, the
// lock order of IC-006), changes the store in place and returns the callback's `{ write, result }`.
// I/O is limited to the 080 calls and one bounded read of one small file (IC-013).
// It runs no git, spawns nothing, signals nothing and waits on nothing.
//
// The repeat rule (DEC-007, DEC-026): a failure finishes 080 FAILED with `<class>: <detail>`, unless
// the task's previous finished dispatch, released ones ignored, failed with the same class; then it
// finishes BLOCKED with `<class>: repeated`, so 080 derives the task BLOCKED and admission never
// picks it again. Retries spend 080's per-task attempt budget; nothing here counts them.
//
// Usage (IC-008, DEC-039): every finish and release passes `tokens` and `basis`, so no attempt the
// loop ends is `unreported`. An 080 call that throws, or refuses, records `lastError` on the
// dispatch and changes nothing else (IC-024).
//
// Feature 106 A.2 (IC-003): the eleventh class, `quota`, releases its attempt (the task stays
// pending) and ends the dispatch `failed` with `failureClass: 'quota'`; the repeat rule skips such a
// dispatch, because it was released, not finished. Every other class is unchanged.

const { finish, release } = require('../task-attempts.ts');
const { maskLine } = require('../mask.ts');
const { DispatchStoreError } = require('./store.ts');
const { stateDir } = require('../context/identity.ts');

/** IC-024's eleven failure classes (106 IC-003 adds `quota`), each with the 080 call that ends its attempt and whether the
 * worker run is then ended with `cancelRun` (outside the lock, by the caller). */
const CLASS_CALLS: Readonly<Record<string, Readonly<{ call: 'finish' | 'release'; cancelRun: boolean }>>> = Object.freeze({
  conflict: Object.freeze({ call: 'finish', cancelRun: false }),
  verification: Object.freeze({ call: 'finish', cancelRun: false }),
  timeout: Object.freeze({ call: 'finish', cancelRun: true }),
  'worker-failure': Object.freeze({ call: 'finish', cancelRun: false }),
  'worker-denied': Object.freeze({ call: 'finish', cancelRun: false }),
  'worker-unparsed': Object.freeze({ call: 'finish', cancelRun: false }),
  quota: Object.freeze({ call: 'release', cancelRun: false }), // 106 IC-003
  isolation: Object.freeze({ call: 'finish', cancelRun: false }),
  lost: Object.freeze({ call: 'finish', cancelRun: true }),
  launch: Object.freeze({ call: 'finish', cancelRun: false }),
  interrupted: Object.freeze({ call: 'release', cancelRun: false }),
});
const FAILURE_CLASSES = Object.freeze(Object.keys(CLASS_CALLS));

/** IC-024's signal column, one token per signal, to its class. */
const SIGNALS: Readonly<Record<string, string>> = Object.freeze({
  conflict: 'conflict', // IC-018 step 4
  verification: 'verification', // IC-019 not passing
  deadline: 'timeout', // IC-025
  'report-failure': 'worker-failure',
  'not-exited': 'worker-failure', // only after a non-zero exit; the caller decides that
  'submit-failure': 'worker-failure', // `submit --status failure`
  'report-denied': 'worker-denied',
  'report-unparsed': 'worker-unparsed',
  'report-quota': 'quota', // 106 IC-002 / IC-003
  'outside-write': 'isolation',
  'branch-moved': 'isolation',
  'isolation-unverifiable': 'isolation',
  'group-survived': 'isolation',
  'status-unknown': 'lost', // 081 status `unknown`
  'run-refused': 'launch', // 081 run refused
  'not-started': 'launch', // `process.kind: 'not-started'`
  'driver-gone': 'interrupted', // a `claimed` dispatch whose driver is gone (IC-032)
});

/** Dispatch phases an attempt may be ended from: a token is held and the dispatch is not ended. */
const LIVE_PHASES = Object.freeze(['claimed', 'launched', 'collected', 'integrating']);
/** Dispositions recorded by a release (IC-023, IC-024, IC-031, IC-032). */
const RELEASE_DISPOSITIONS = Object.freeze(['released', 'stale', 'interrupted', 'taken-over']);
/** Dispositions recorded by an 080 finish; only these count for the repeat rule. */
const FINISHED_DISPOSITIONS = Object.freeze(['completed', 'failed']);
const DETAIL_CHARS = 200;

function usageError(message: string): any {
  return new DispatchStoreError('usage', message);
}

/** IC-024: `{ failureClass, call, cancelRun }` for a signal token; an unknown token is a caller defect. */
function classFor(signal: string): { failureClass: string; call: 'finish' | 'release'; cancelRun: boolean } {
  const failureClass = Object.hasOwn(SIGNALS, signal) ? SIGNALS[signal] : null;
  if (!failureClass) throw usageError(`unknown attempt-end signal '${signal}'; known: ${Object.keys(SIGNALS).join(', ')}`);
  return { failureClass, ...CLASS_CALLS[failureClass] };
}

const wholeTokens = (value: any): boolean => Number.isInteger(value) && value >= 0;

/** 081 `report.usage` is `{ tokens }` or null; an integer is read as the same thing. */
function measuredTokens(run: any): number | null {
  const usage = run && run.report ? run.report.usage : null;
  if (wholeTokens(usage)) return usage;
  return usage && wholeTokens(usage.tokens) ? usage.tokens : null;
}

function reservationUsage(dispatch: any): { tokens: number; basis: 'estimated' } {
  const tokens = dispatch && dispatch.reservation && wholeTokens(dispatch.reservation.tokens) ? dispatch.reservation.tokens : 0;
  return { tokens, basis: 'estimated' };
}

/**
 * IC-008's usage table. With a worker run whose 081 `report.usage` is known: its tokens plus every
 * measured child's, `measured` only when every part is. With no worker run, the usage a
 * main-session submit stored on the dispatch. Otherwise the reservation (0 with none), `estimated`.
 */
function usageFor(dispatch: any, workerRun: any, children: any[] = []): { tokens: number; basis: 'measured' | 'estimated' } {
  const own = measuredTokens(workerRun);
  if (own !== null) {
    const parts = (children || []).map(measuredTokens);
    const tokens = parts.reduce((sum: number, part: number | null) => sum + (part ?? 0), own);
    return { tokens, basis: parts.every((part) => part !== null) ? 'measured' : 'estimated' };
  }
  if (!workerRun && dispatch && dispatch.usage && wholeTokens(dispatch.usage.tokens)
    && (dispatch.usage.basis === 'measured' || dispatch.usage.basis === 'estimated')) {
    return { tokens: dispatch.usage.tokens, basis: dispatch.usage.basis };
  }
  return reservationUsage(dispatch);
}

/** `detail` masked by `maskLine` and cut to 200 characters without splitting a code point. */
function maskedDetail(detail: any): string {
  if (detail === undefined || detail === null) return '';
  const text = maskLine(String(detail)).text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= DETAIL_CHARS ? text : chars.slice(0, DETAIL_CHARS).join('');
}

/** The task's previous finished dispatch before `current`: highest 080 token below its own, released
 * ones (every other release disposition, and a `quota` end, which released) ignored (DEC-007). */
function previousFinished(store: any, current: any): any {
  let previous: any = null;
  for (const other of Object.values(store.dispatches) as any[]) {
    if (other.dispatchId === current.dispatchId || other.task !== current.task || other.phase !== 'ended') continue;
    if (!FINISHED_DISPOSITIONS.includes(other.disposition) || !Number.isInteger(other.token) || other.failureClass === 'quota') continue;
    if (other.token >= current.token) continue;
    if (!previous || other.token > previous.token) previous = other;
  }
  return previous;
}

/** The live dispatch `dispatchId`, or the no-write refusal for an unknown or ended one. */
function liveDispatch(store: any, dispatchId: string): { dispatch?: any; refused?: any } {
  const dispatch = store && store.dispatches ? store.dispatches[dispatchId] : null;
  if (!dispatch) return { refused: { write: false, result: { ended: false, reason: 'unknown-dispatch', dispatchId } } };
  if (!LIVE_PHASES.includes(dispatch.phase)) {
    return { refused: { write: false, result: { ended: false, reason: 'phase-not-allowed', dispatchId, phase: dispatch.phase } } };
  }
  if (!Number.isInteger(dispatch.token) || dispatch.token < 1) throw usageError(`dispatch '${dispatchId}' holds no 080 token`);
  return { dispatch };
}

function contextOf(ctx: any): any {
  if (!ctx || typeof ctx.ledgerFile !== 'string' || !Array.isArray(ctx.roots) || typeof ctx.slug !== 'string') {
    throw usageError('ctx needs ledgerFile, roots and slug for the in-process 080 call');
  }
  return ctx;
}

/** IC-013: the served model from this dispatch's worker observation, without changing the record. */
function servedModel(dispatch: any, ctx: any): string | null {
  const plain = (value: any) => value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (!plain(dispatch.model) || !plain(dispatch.workerIdentity)
    || typeof dispatch.harness !== 'string' || dispatch.harness.length === 0
    || !ctx.env || typeof ctx.env !== 'object') return null;
  const { readWorkerObservation } = require('../context/primary.ts');
  return readWorkerObservation({
    root: stateDir(ctx.env), identity: dispatch.workerIdentity, harness: dispatch.harness, fsImpl: ctx.fsImpl,
  })?.model ?? null;
}

/**
 * One in-process 080 call. Applied: the dispatch ends with `ended` and the 080 result. A refusal, a
 * stale answer or a thrown 080 error (a `TaskAttemptError`, such as `plan-malformed`): `lastError`
 * is recorded and nothing else changes (IC-024). Any other throw is a defect and propagates.
 */
function call080(dispatch: any, name: 'finish' | 'release', args: any, ctx: any, ended: any): { write: true; result: any } {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const fn = name === 'finish' ? finish : release;
  let answer: any;
  try {
    answer = fn({
      file: ctx.ledgerFile, fsImpl: ctx.fsImpl, roots: ctx.roots, slug: ctx.slug,
      task: dispatch.task, token: dispatch.token, env: ctx.env, cwd: ctx.cwd, now, ...args,
    });
  } catch (error: any) {
    if (!error || error.name !== 'TaskAttemptError' || typeof error.code !== 'string') throw error;
    dispatch.lastError = { at: now.toISOString(), call: name, reason: error.code };
    return { write: true, result: { ended: false, outcome: 'error', call: name, reason: error.code, dispatchId: dispatch.dispatchId } };
  }
  const applied = name === 'finish' ? answer.disposition === 'applied' : answer.disposition === 'released';
  if (!applied) {
    dispatch.lastError = { at: now.toISOString(), call: name, reason: answer.reason || answer.disposition };
    return { write: true, result: { ended: false, outcome: answer.disposition, call: name, reason: answer.reason || null, dispatchId: dispatch.dispatchId } };
  }
  const served = servedModel(dispatch, ctx);
  if (served !== null) dispatch.model = { ...dispatch.model, served };
  Object.assign(dispatch, ended, { phase: 'ended', endedAt: now.toISOString(), usage: { tokens: args.tokens, basis: args.basis } });
  return {
    write: true,
    result: { ended: true, dispatchId: dispatch.dispatchId, task: dispatch.task, token: dispatch.token, disposition: ended.disposition, failureClass: ended.failureClass ?? null, attempt: answer },
  };
}

/**
 * IC-024: ends a failed attempt by its class's 080 call. A `finish` class finishes FAILED with
 * `<class>: <detail>`, or BLOCKED with `<class>: repeated` when the task's previous finished
 * dispatch failed with the same class; the dispatch ends `failed` with `failureClass`. The
 * `interrupted` class releases instead and ends `interrupted`; `quota` releases and ends `failed`
 * (106 IC-003). `usage` defaults to `usageFor`
 * over the dispatch alone; `evidenceId` (a verification's) is passed to 080 and stored.
 */
function endAttempt({ store, dispatchId, failureClass, detail, usage, evidenceId, ctx }: any): { write: boolean; result: any } {
  if (!Object.hasOwn(CLASS_CALLS, failureClass)) throw usageError(`unknown failure class '${failureClass}'; known: ${FAILURE_CLASSES.join(', ')}`);
  const context = contextOf(ctx);
  const { dispatch, refused } = liveDispatch(store, dispatchId);
  if (refused) return refused;
  const spent = usage || usageFor(dispatch, null, []);
  const text = maskedDetail(detail);
  const reason = text ? `${failureClass}: ${text}` : failureClass;
  if (CLASS_CALLS[failureClass].call === 'release') {
    return call080(dispatch, 'release', { reason, tokens: spent.tokens, basis: spent.basis }, context,
      { disposition: failureClass === 'quota' ? 'failed' : 'interrupted', failureClass });
  }
  const previous = previousFinished(store, dispatch);
  const repeated = Boolean(previous && previous.disposition === 'failed' && previous.failureClass === failureClass);
  const ended: any = { disposition: 'failed', failureClass };
  if (evidenceId) ended.evidenceId = evidenceId;
  return call080(dispatch, 'finish', {
    result: repeated ? 'BLOCKED' : 'FAILED',
    reason: repeated ? `${failureClass}: repeated` : reason,
    evidenceId: evidenceId || undefined,
    tokens: spent.tokens, basis: spent.basis,
  }, context, ended);
}

/** IC-018 step 6: finishes the attempt COMPLETED with the verification's evidence id and usage. */
function completeAttempt({ store, dispatchId, evidenceId, usage, integratedCommit, ctx }: any): { write: boolean; result: any } {
  if (typeof evidenceId !== 'string' || !evidenceId) throw usageError('completeAttempt needs the evidence id of the passing verification');
  const context = contextOf(ctx);
  const { dispatch, refused } = liveDispatch(store, dispatchId);
  if (refused) return refused;
  const spent = usage || usageFor(dispatch, null, []);
  const ended: any = { disposition: 'completed', failureClass: null, evidenceId };
  if (integratedCommit !== undefined) ended.integratedCommit = integratedCommit;
  return call080(dispatch, 'finish', { result: 'COMPLETED', evidenceId, tokens: spent.tokens, basis: spent.basis }, context, ended);
}

/** IC-023, IC-024, IC-031: releases the attempt with `reason` and usage, never finishing it; the
 * dispatch ends with `disposition` (default `released`), which the repeat rule ignores. */
function releaseAttempt({ store, dispatchId, reason, disposition = 'released', usage, ctx }: any): { write: boolean; result: any } {
  if (typeof reason !== 'string' || !reason.trim()) throw usageError('releaseAttempt needs a reason');
  if (!RELEASE_DISPOSITIONS.includes(disposition)) throw usageError(`release disposition '${disposition}' is not one of ${RELEASE_DISPOSITIONS.join(', ')}`);
  const context = contextOf(ctx);
  const { dispatch, refused } = liveDispatch(store, dispatchId);
  if (refused) return refused;
  const spent = usage || usageFor(dispatch, null, []);
  return call080(dispatch, 'release', { reason: maskedDetail(reason) || 'released', tokens: spent.tokens, basis: spent.basis }, context,
    { disposition, failureClass: null });
}

module.exports = {
  FAILURE_CLASSES,
  CLASS_CALLS,
  SIGNALS,
  LIVE_PHASES,
  RELEASE_DISPOSITIONS,
  classFor,
  usageFor,
  endAttempt,
  completeAttempt,
  releaseAttempt,
};
