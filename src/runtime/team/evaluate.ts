'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * 143 IC-001..IC-005: the evaluation half of the team wiring. It drives the feature 103 modules
 * (`admission.ts`, `review-guard.ts`) through their public API at the dispatch and review call sites,
 * and records each outcome as a `team.verdict` telemetry line. Neither module is edited.
 *
 * Rules that constrain everything below.
 *   - Observer first: a verdict changes an outcome only when `teamGate` reports mode `block`, and the
 *     caller (dispatch admission) alone applies that. The review verbs never act on a verdict.
 *   - Never throws: every export catches every fault and answers `error` / `eval-fault`; the recorder
 *     and the settings read fail safe (nothing written, mode `advisory`).
 *   - Metadata only (NFR-003): a verdict holds ids and numbers, never a path, file name or message.
 *   - No model call: every rule here is deterministic.
 */

const { AdmissionController, resolveTeamSettings } = require('./admission.ts');
const { assertReviewerSeparation, assertMechanicalPreChecks, NeverReviewOwnCodeError, MechanicalPreChecksIncompleteError } = require('./review-guard.ts');
const { TelemetryWriter } = require('../trace/telemetry.ts');

type Env = Record<string, string | undefined>;
export type TeamSite = 'dispatch-admit' | 'review-start' | 'review-check';
export type TeamRule = 'admission' | 'pre-check' | 'separation';
export type TeamOutcome = 'admitted' | 'refused' | 'not-evaluable' | 'error';
export type TeamMode = 'advisory' | 'block';
export type TeamReason =
  | 'WRITE_SET_CONFLICT' | 'WRITER_CAP_EXCEEDED' | 'MAX_ATTEMPTS_EXCEEDED' | 'TASK_ALREADY_ACTIVE'
  | 'ERR_REVIEWER_SELF_REVIEW' | 'ERR_MECHANICAL_CHECKS_FAILED'
  | 'no-feature' | 'no-author' | 'no-record' | 'no-seat-agent' | 'eval-fault';

/** IC-003: the fields of one `team.verdict` line, less the common fields the writer adds. */
export interface TeamVerdict {
  site: TeamSite;
  rule: TeamRule;
  outcome: TeamOutcome;
  reason: TeamReason | null;
  mode: TeamMode;
  task: string | null;
  count: number | null;
}

export interface TeamLimits { writerCap: number; maxAttempts: number }

export interface AdmissionInput {
  task: string;
  files: string[];
  owner?: string | null;
  harness?: string | null;
  mode?: TeamMode;
  runKey?: string;
  priorAttempts?: number;
  active?: Array<{ task: string; files: string[] }>;
}

interface RecordOptions { writer?: { write(records: unknown[]): void } | null; env?: Env; start?: string }

export interface TeamGate {
  mode: TeamMode;
  limits: TeamLimits;
  evaluate(input: AdmissionInput): TeamVerdict;
  record(verdicts: TeamVerdict[]): void;
}

/** IC-005: where each entry point calls this module; the structural test reads each file for its token. */
const WIRED_SITES: ReadonlyArray<{ id: TeamSite; file: string; token: string }> = Object.freeze([
  { id: 'dispatch-admit' as const, file: 'src/runtime/dispatch/admission.ts', token: 'team.evaluate' },
  { id: 'review-start' as const, file: 'src/runtime/review/start.ts', token: 'observeStart' },
  { id: 'review-check' as const, file: 'src/runtime/review/command.ts', token: 'observeCheck' },
]);

/** Last-resort limits when neither the settings engine nor the controller's own reader answers (the shipped defaults). */
const FALLBACK_LIMITS: TeamLimits = Object.freeze({ writerCap: 1, maxAttempts: 3 });
const REPLAY_RUN_KEY = 'team-replay';

function verdict(
  site: TeamSite, rule: TeamRule, outcome: TeamOutcome, reason: TeamReason | null,
  mode: TeamMode, task: unknown, count: number | null = null,
): TeamVerdict {
  return { site, rule, outcome, reason, mode, task: typeof task === 'string' ? task : null, count };
}

/** The setting `key` as a resolved integer, else undefined. */
function resolvedInteger(view: any, key: string): number | undefined {
  try {
    const value = view?.get(key)?.value;
    return Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** IC-004: mode and limits for `projectRoot`. Any fault gives `advisory` and the controller's own limits. */
function resolveGate(projectRoot: string, env: Env): { mode: TeamMode; limits: TeamLimits } {
  let view: any = null;
  try {
    view = require('../settings/resolve.ts').loadSettings({ projectRoot, env });
  } catch {
    view = null;
  }
  let mode: TeamMode = 'advisory';
  try {
    const resolution = view?.get('team.enforcement');
    if (resolution?.state === 'ok' && resolution.value === 'block') mode = 'block';
  } catch {
    mode = 'advisory';
  }
  let writerCap = resolvedInteger(view, 'team.writerCap');
  let maxAttempts = resolvedInteger(view, 'team.maxAttempts');
  if (writerCap === undefined || maxAttempts === undefined) {
    let fallback: TeamLimits = FALLBACK_LIMITS;
    try {
      const own = resolveTeamSettings({ projectRoot, env });
      if (Number.isInteger(own?.writerCap) && Number.isInteger(own?.maxAttempts)) fallback = own;
    } catch {
      fallback = FALLBACK_LIMITS;
    }
    writerCap ??= fallback.writerCap;
    maxAttempts ??= fallback.maxAttempts;
  }
  return { mode, limits: { writerCap, maxAttempts } };
}

/**
 * IC-001: one admission verdict. A fresh controller replays the task's earlier attempts (a claim and a
 * release with no write set, which raise its attempt count only), then every active dispatch, then the
 * candidate. Never throws.
 */
function evaluateAdmission(input: AdmissionInput, limits: TeamLimits): TeamVerdict {
  const mode: TeamMode = input?.mode === 'block' ? 'block' : 'advisory';
  const task = input?.task;
  try {
    const controller = new AdmissionController({ writerCap: limits.writerCap, maxAttempts: limits.maxAttempts });
    const runKey = typeof input.runKey === 'string' && input.runKey ? input.runKey : REPLAY_RUN_KEY;
    const prior = Number.isInteger(input.priorAttempts) ? Math.max(0, input.priorAttempts as number) : 0;
    for (let i = 0; i < Math.min(prior, limits.maxAttempts); i++) {
      controller.claimTask({ taskId: task, runKey: REPLAY_RUN_KEY, agentRole: 'core-implementer', workerIdentity: 'unknown:unknown', writeSet: [] });
      controller.releaseTask({ taskId: task, runKey: REPLAY_RUN_KEY, outcome: 'ABANDONED', modifiedFiles: [] });
    }
    for (const other of Array.isArray(input.active) ? input.active : []) {
      controller.claimTask({
        taskId: other.task, runKey: REPLAY_RUN_KEY, agentRole: 'core-implementer', workerIdentity: 'unknown:unknown',
        writeSet: Array.isArray(other.files) ? other.files : [],
      });
    }
    const decision = controller.claimTask({
      taskId: task,
      runKey,
      agentRole: (typeof input.owner === 'string' && input.owner ? input.owner : 'unknown') as any,
      workerIdentity: `${typeof input.harness === 'string' && input.harness ? input.harness : 'unknown'}:${typeof input.owner === 'string' && input.owner ? input.owner : 'unknown'}`,
      writeSet: Array.isArray(input.files) ? input.files : [],
    });
    if (decision.admitted) return verdict('dispatch-admit', 'admission', 'admitted', null, mode, task);
    const count = decision.reason === 'WRITE_SET_CONFLICT' ? (decision.conflicts?.overlappingFiles?.length ?? null) : null;
    return verdict('dispatch-admit', 'admission', 'refused', decision.reason as TeamReason, mode, task, count);
  } catch {
    return verdict('dispatch-admit', 'admission', 'error', 'eval-fault', mode, task);
  }
}

/**
 * IC-004/IC-001: the gate `admit()` receives. Built once per pass; `mode` and `limits` come from the
 * settings engine and fail safe to `advisory` and the controller's own limits. Never throws.
 */
function teamGate({ projectRoot, env }: { projectRoot: string; env?: Env }): TeamGate {
  const callEnv: Env = env ?? process.env;
  let resolved: { mode: TeamMode; limits: TeamLimits };
  try {
    resolved = resolveGate(projectRoot, callEnv);
  } catch {
    resolved = { mode: 'advisory', limits: FALLBACK_LIMITS };
  }
  const { mode, limits } = resolved;
  return {
    mode,
    limits,
    evaluate: (input: AdmissionInput) => evaluateAdmission(input, limits),
    record: (verdicts: TeamVerdict[]) => record(verdicts, { env: callEnv, start: projectRoot }),
  };
}

/**
 * IC-003: appends one `team.verdict` line per verdict through `TelemetryWriter` (which honours
 * `DOFLOW_TELEMETRY=off` and drops what the registry does not name). `options.writer` is the
 * `teamWriter` of the review verbs; absent, a writer is built at `options.start`. Never throws.
 */
function record(verdicts: TeamVerdict[], options: RecordOptions = {}): void {
  try {
    if (!Array.isArray(verdicts) || verdicts.length === 0) return;
    const env = options.env ?? process.env;
    const writer = options.writer ?? new TelemetryWriter({ env, start: options.start });
    writer.write(verdicts.map((v) => ({ kind: 'team.verdict', ...v })));
  } catch {
    // A recording fault changes no outcome: there is nothing to report to.
  }
}

/** IC-002: the pre-check verdict of a `review start`, recorded to `writer` (or a writer at `cwd`). Never throws. */
function observeStart({ slug, cwd, env, writer }: { slug: string | null; cwd: string; env?: Env; writer?: RecordOptions['writer'] }): void {
  let outcome: TeamVerdict;
  try {
    if (typeof slug !== 'string' || !slug) {
      outcome = verdict('review-start', 'pre-check', 'not-evaluable', 'no-feature', 'advisory', null);
    } else {
      try {
        assertMechanicalPreChecks(slug, cwd);
        outcome = verdict('review-start', 'pre-check', 'admitted', null, 'advisory', slug);
      } catch (error) {
        outcome = error instanceof MechanicalPreChecksIncompleteError
          ? verdict('review-start', 'pre-check', 'refused', 'ERR_MECHANICAL_CHECKS_FAILED', 'advisory', slug, (error as any).failures?.length ?? null)
          : verdict('review-start', 'pre-check', 'error', 'eval-fault', 'advisory', slug);
      }
    }
  } catch {
    outcome = verdict('review-start', 'pre-check', 'error', 'eval-fault', 'advisory', null);
  }
  record([outcome], { writer, env, start: cwd });
}

/** IC-002: the separation verdict of a `review check`, one per call. Never throws. */
function observeCheck({ record: reviewRecord, cwd, env, writer }: { record: any; cwd: string; env?: Env; writer?: RecordOptions['writer'] }): void {
  const notEvaluable = (reason: TeamReason, task: unknown = null) => verdict('review-check', 'separation', 'not-evaluable', reason, 'advisory', task);
  let outcome: TeamVerdict;
  try {
    const task = reviewRecord?.slug;
    if (!reviewRecord || typeof reviewRecord !== 'object' || Array.isArray(reviewRecord)) {
      outcome = notEvaluable('no-record');
    } else if (!reviewRecord.author || typeof reviewRecord.author !== 'object' || typeof reviewRecord.author.agent !== 'string') {
      outcome = notEvaluable('no-author', task);
    } else {
      const seats = (Array.isArray(reviewRecord.seats) ? reviewRecord.seats : [])
        .filter((seat: any) => seat && typeof seat === 'object' && typeof seat.agent === 'string');
      if (seats.length === 0) {
        outcome = notEvaluable('no-seat-agent', task);
      } else {
        const author = reviewRecord.author;
        const session = (value: unknown) => (typeof value === 'string' ? value : undefined);
        let refused = false;
        for (const seat of seats) {
          try {
            assertReviewerSeparation({
              taskId: typeof task === 'string' ? task : '',
              authorRole: author.agent,
              authorIdentity: session(author.session),
              reviewerRole: seat.agent,
              reviewerIdentity: session(seat.session),
            });
          } catch (error) {
            if (!(error instanceof NeverReviewOwnCodeError)) throw error;
            refused = true;
          }
        }
        outcome = refused
          ? verdict('review-check', 'separation', 'refused', 'ERR_REVIEWER_SELF_REVIEW', 'advisory', task, seats.length)
          : verdict('review-check', 'separation', 'admitted', null, 'advisory', task, seats.length);
      }
    }
  } catch {
    outcome = verdict('review-check', 'separation', 'error', 'eval-fault', 'advisory', null);
  }
  record([outcome], { writer, env, start: cwd });
}

module.exports = { teamGate, evaluateAdmission, observeStart, observeCheck, record, WIRED_SITES };
