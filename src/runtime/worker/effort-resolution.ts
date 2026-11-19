'use strict';

// 178 IC-003 and IC-004: which effort a worker launches with. Order: a bound effort, else the session's level unchanged
// (or mapped to the next lower name the worker has), else nothing. The data is the two declared `worker.effort.levels`
// lists (lowest first); the code holds no level name and no harness id. `resolveEffort` and `mapLevel` are pure;
// `effortPlanFor` reads the session through `readSessionEffort` (which opens no file) and looks the session's `worker` block up (the launched worker's is passed in, else looked up too).

const { readSessionEffort } = require('../context/session-effort.ts');

type NoneReason = 'session-unknown' | 'worker-takes-no-effort' | 'needs-model' | 'no-lower-level' | 'no-ordered-list';
type EffortPlan =
  | { pass: string; source: 'binding' }
  | { pass: string; source: 'session'; harness: string; level: string; origin: string; mapped: null | { from: string; to: string }; check: 'listed' | 'unchecked' }
  | { pass: null; source: 'none'; reason: NoneReason; session: { harness: string | null; reason: string | null; level: string | null; origin: string | null } };

const NONE_REASONS: readonly NoneReason[] = Object.freeze(['session-unknown', 'worker-takes-no-effort', 'needs-model', 'no-lower-level', 'no-ordered-list']);

/** 6.1: from the level's place in the session's own list walk down to the first name the worker also has. */
function mapLevel(level: string, sessionLevels: unknown, workerLevels: unknown): { to: string } | { none: 'no-lower-level' | 'no-ordered-list' } {
  if (!Array.isArray(sessionLevels) || !Array.isArray(workerLevels)) return { none: 'no-ordered-list' };
  for (let i = sessionLevels.indexOf(level) - 1; i >= 0; i--) {
    if (workerLevels.includes(sessionLevels[i])) return { to: sessionLevels[i] };
  }
  return { none: 'no-lower-level' };
}

/** 5: the six steps. `choice` is the bound choice or null, `session` a SessionEffort, `sessionWorker` and `worker` the two harnesses' `worker` blocks. */
function resolveEffort({ choice, session, sessionWorker, worker }: { choice: any; session: any; sessionWorker: any; worker: any }): EffortPlan {
  if (choice?.effort) return { pass: choice.effort, source: 'binding' };
  const none = (reason: NoneReason): EffortPlan => ({
    pass: null, source: 'none', reason,
    session: { harness: session.harness ?? null, reason: session.reason ?? null, level: session.level ?? null, origin: session.origin ?? null },
  });
  if (session.state !== 'known') return none('session-unknown');
  const entry = worker?.effort;
  if (entry?.status !== 'supported') return none('worker-takes-no-effort');
  if (entry.via === 'id-suffix' && !choice?.model) return none('needs-model');
  const found = (pass: string, mapped: null | { from: string; to: string }, check: 'listed' | 'unchecked'): EffortPlan =>
    ({ pass, source: 'session', harness: session.harness, level: session.level, origin: session.origin, mapped, check });
  if (!Array.isArray(entry.levels)) return found(session.level, null, 'unchecked');
  if (entry.levels.includes(session.level)) return found(session.level, null, 'listed');
  const next = mapLevel(session.level, sessionWorker?.effort?.levels, entry.levels);
  return 'to' in next ? found(next.to, { from: session.level, to: next.to }, 'listed') : none(next.none);
}

/**
 * 5 "Where it runs": the one assembler the launch paths call. `worker` is the block the launch actually composes against (a
 * package or injected descriptor the registry need not hold); without it the registry's block for `workerHarness` is used.
 * The session harness's block always comes from the registry.
 */
function effortPlanFor({ registry, env, declaredHarness, workerHarness, choice, loginModeOf, worker }: {
  registry: any; env: Record<string, string | undefined>; declaredHarness: string | null; workerHarness: string; choice: any; loginModeOf: (harness: string) => 'subscription' | 'api-key' | null;
  worker?: any;
}): EffortPlan {
  const session = readSessionEffort({ registry, env, declaredHarness, loginModeOf });
  const workerOf = (id: string | null) => (registry.harnesses || []).find((entry: any) => entry?.id === id)?.worker ?? null;
  return resolveEffort({ choice, session, sessionWorker: workerOf(session.harness), worker: worker !== undefined ? worker : workerOf(workerHarness) });
}

module.exports = { resolveEffort, mapLevel, effortPlanFor, NONE_REASONS };
