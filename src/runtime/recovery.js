'use strict';

/**
 * Failure classifier and bounded recovery planner — the JavaScript port of
 * `core/shared/scripts/doflow/recovery/recovery_manager.py` (plan task B.3, component C8).
 *
 * All **eleven** failure classes are kept, against the specification's seven (design R4, plan
 * decision D3 and risk RK6): TOOL_FAILURE, AGENT_FAILURE, BUDGET_EXCEEDED and UNKNOWN_FAILURE are
 * real discriminations the Python already made, and narrowing to match a document would throw away
 * working behaviour. The classification order, every keyword, the strategy table, the
 * agent-switch rule and the three-iteration bound are reproduced exactly.
 *
 * Two defects are fixed rather than reproduced, each explained at its site:
 *   1. `plan_recovery` returned two incompatible record shapes — the abort path omitted `canRetry`
 *      and `failureClass`, so the natural caller check `result["canRetry"]` raised on exactly the
 *      path that must stop the loop.
 *   2. `classify_failure` assumed its arguments' types; a `None` message or a bare string of check
 *      names either raised or silently iterated characters.
 */

const { finishRuntime, usageError } = require('./cli-result');

/** The eleven classes, in the order the Python declared them. */
const FAILURE_CLASSES = Object.freeze([
  'CONTEXT_MISSING',
  'WRONG_IMPLEMENTATION',
  'TEST_FAILURE',
  'BUILD_FAILURE',
  'ARCHITECTURE_FAILURE',
  'REQUIREMENT_FAILURE',
  'ENVIRONMENT_FAILURE',
  'TOOL_FAILURE',
  'AGENT_FAILURE',
  'BUDGET_EXCEEDED',
  'UNKNOWN_FAILURE',
]);

const DEFAULT_MAX_ITERATIONS = 3;

/** Check-name fragments that identify a build-stage failure regardless of the error text. */
const BUILD_CHECK_MARKERS = Object.freeze(['syntax', 'compile', 'build']);
/** Check-name fragments that identify a test-stage failure. */
const TEST_CHECK_MARKERS = Object.freeze(['test', 'unit']);

/**
 * Per-class recovery strategy — **one entry per class, all eleven** (plan task C.2).
 *
 * The B.3 port preserved the Python's six-entry table, under which WRONG_IMPLEMENTATION,
 * TOOL_FAILURE, AGENT_FAILURE, BUDGET_EXCEEDED and UNKNOWN_FAILURE all fell through to
 * `GENERIC_DEBUGGER_FIX`. C.2 completes the table, because that fallthrough directly contradicts
 * FR-010 — "the response MUST be the targeted action for that class" — and in two cases the generic
 * action is not merely untargeted but wrong:
 *
 *   - BUDGET_EXCEEDED: handing the task back to a debugger spends more of the budget that is
 *     already gone. It is the one class where the targeted action is to stop, so it is `terminal`.
 *   - TOOL_FAILURE: an unreachable MCP server or a missing provider is not fixed by rewriting code,
 *     and swapping the agent changes nothing about the tool. The action routes to a fallback
 *     provider instead (the capability router already declares those fallbacks).
 *
 * Classifying eleven ways and then acting six ways discarded most of what the classifier
 * established. `GENERIC_STRATEGY` is retained and still reachable — a caller may pass a class
 * string that is not one of the eleven — but no declared class relies on it any more.
 *
 * `switchAtIteration` encodes the Python's three agent-switch behaviours: `null` never switches,
 * `0` always switches (its unconditional `True`), and `2` switches only once two attempts have
 * already been spent (its `current_iteration >= 2`). `terminal` is new and means the class is not
 * retryable at any iteration.
 */
const STRATEGY_MAP = Object.freeze({
  CONTEXT_MISSING: { action: 'RETRIEVE_MORE_CONTEXT', targetRole: 'SCOUT', switchAtIteration: null },
  WRONG_IMPLEMENTATION: { action: 'REVISE_IMPLEMENTATION', targetRole: 'IMPLEMENTER', switchAtIteration: 2 },
  TEST_FAILURE: { action: 'TARGETED_DEBUGGER_FIX', targetRole: 'DEBUGGER', switchAtIteration: 2 },
  BUILD_FAILURE: { action: 'TARGETED_COMPILER_FIX', targetRole: 'DEBUGGER', switchAtIteration: 2 },
  ARCHITECTURE_FAILURE: { action: 'GRAPH_RE_EVALUATION', targetRole: 'PLANNER', switchAtIteration: 0 },
  REQUIREMENT_FAILURE: { action: 'SPEC_RECONCILIATION', targetRole: 'PLANNER', switchAtIteration: 0 },
  ENVIRONMENT_FAILURE: { action: 'ENVIRONMENT_DIAGNOSTIC', targetRole: 'VERIFIER', switchAtIteration: null },
  TOOL_FAILURE: { action: 'ROUTE_TO_FALLBACK_PROVIDER', targetRole: 'VERIFIER', switchAtIteration: null },
  // The agent itself is the failure, so the switch is the action rather than a later escalation.
  AGENT_FAILURE: { action: 'SWITCH_AGENT_AND_RESTATE_TASK', targetRole: 'IMPLEMENTER', switchAtIteration: 0 },
  BUDGET_EXCEEDED: { action: 'ESCALATE_TO_USER', targetRole: null, switchAtIteration: null, terminal: true },
  // Diagnose before acting: an unclassified failure is the one case where a targeted fix cannot be
  // chosen, and guessing one is how a recovery loop burns its whole bound on the wrong repair.
  UNKNOWN_FAILURE: { action: 'DIAGNOSTIC_TRIAGE', targetRole: 'VERIFIER', switchAtIteration: null },
});

/** Reachable only for a class string outside the eleven — see the note on STRATEGY_MAP. */
const GENERIC_STRATEGY = Object.freeze({
  action: 'GENERIC_DEBUGGER_FIX',
  targetRole: 'DEBUGGER',
  switchAtIteration: 2,
});

/**
 * @param {*} value
 * @returns {Array<string>} only the string members, lowercased
 */
function normalizeCheckNames(value) {
  // Defect fix (2a): the Python accepted `failed_checks` unvalidated. Handed a plain string it
  // iterated characters, so every single-letter "check" was tested for "syntax" and none matched —
  // a build failure silently classified as WRONG_IMPLEMENTATION.
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string').map((v) => v.toLowerCase());
}

class RecoveryManager {
  /**
   * @param {Object|number} [options] a number is accepted for parity with the Python's positional
   *   `max_iterations` argument
   * @param {number} [options.maxIterations=3]
   */
  constructor(options = {}) {
    const opts = typeof options === 'number' ? { maxIterations: options } : options;
    this.maxIterations = opts.maxIterations || DEFAULT_MAX_ITERATIONS;
  }

  /**
   * Classifies a failure into one of the eleven classes.
   *
   * Order matters and is preserved: the names of the checks that failed outrank the wording of the
   * error message, because a check name is structural evidence and an error string is prose.
   * @param {string} errorMessage
   * @param {Array<string>} [failedChecks=[]]
   * @returns {string} one of FAILURE_CLASSES
   */
  classifyFailure(errorMessage, failedChecks = []) {
    const checks = normalizeCheckNames(failedChecks);
    // Defect fix (2b): `None.lower()` raised. A classifier handed no message should return
    // UNKNOWN_FAILURE, not abort the recovery path that exists to handle failures.
    const msg = typeof errorMessage === 'string' ? errorMessage.toLowerCase() : '';

    const anyCheck = (markers) => checks.some((chk) => markers.some((m) => chk.includes(m)));

    if (anyCheck(BUILD_CHECK_MARKERS) || msg.includes('build error')) {
      return 'BUILD_FAILURE';
    }
    if (anyCheck(TEST_CHECK_MARKERS) || msg.includes('test failed') || msg.includes('assertionerror')) {
      return 'TEST_FAILURE';
    }
    if (msg.includes('budget') || msg.includes('token limit')) {
      return 'BUDGET_EXCEEDED';
    }
    if (msg.includes('missing file') || msg.includes('cannot find module') || msg.includes('not found')) {
      return 'CONTEXT_MISSING';
    }
    if (msg.includes('timeout') || msg.includes('connection refused') || msg.includes('econnrefused')) {
      return 'ENVIRONMENT_FAILURE';
    }
    if (msg.includes('tool error') || msg.includes('mcp error')) {
      return 'TOOL_FAILURE';
    }
    if (msg.includes('architecture') || msg.includes('boundary')) {
      return 'ARCHITECTURE_FAILURE';
    }
    if (msg.includes('requirement') || msg.includes('acceptance criterion')) {
      return 'REQUIREMENT_FAILURE';
    }
    if (msg.includes('agent') || msg.includes('hallucination')) {
      return 'AGENT_FAILURE';
    }
    if (checks.length > 0) {
      return 'WRONG_IMPLEMENTATION';
    }
    return 'UNKNOWN_FAILURE';
  }

  /**
   * Determines the next recovery action and whether to hand the task to a different agent.
   * @param {string} failureClass
   * @param {number} currentIteration zero-based count of retries already spent
   * @param {string} [lastAgent='codex']
   * @returns {{ iteration: number, failureClass: string, action: string, targetRole: string|null, agent: string, canRetry: boolean, reason?: string }}
   */
  planRecovery(failureClass, currentIteration, lastAgent = 'codex') {
    // A negative or non-numeric iteration is caller nonsense; clamping keeps it from reading as
    // "before the first attempt" and skipping the agent switch that iteration 0 is supposed to get.
    const iteration = Number.isFinite(currentIteration) ? Math.max(0, Math.trunc(currentIteration)) : 0;
    const agent = lastAgent || 'codex';

    if (iteration >= this.maxIterations) {
      // Defect fix (1): the Python's abort record carried only `action`, `reason` and
      // `switchAgent`, while its retry record carried `iteration`, `failureClass`, `targetRole`,
      // `agent` and `canRetry`. A caller written against either shape broke on the other, and the
      // key it most needed — `canRetry` — was the one missing from the stop path. One shape now,
      // with `canRetry: false` stating the bound explicitly.
      return {
        iteration,
        failureClass,
        action: 'ABORT',
        targetRole: null,
        agent,
        canRetry: false,
        reason: `Maximum retry iterations (${this.maxIterations}) exceeded.`,
      };
    }

    const strategy = STRATEGY_MAP[failureClass] || GENERIC_STRATEGY;

    // A terminal class stops the loop regardless of how much of the bound is left. Today that is
    // BUDGET_EXCEEDED only: retrying is the one response guaranteed to make the failure worse.
    if (strategy.terminal) {
      return {
        iteration,
        failureClass,
        action: strategy.action,
        targetRole: strategy.targetRole,
        agent,
        canRetry: false,
        reason: `Failure class '${failureClass}' is not retryable; a retry would repeat the condition that caused it.`,
      };
    }

    const switchAgent =
      strategy.switchAtIteration !== null && iteration >= strategy.switchAtIteration;

    // Preserved verbatim: the swap is a two-way toggle between codex and claude, so any other
    // agent name switches to codex.
    const recommendedAgent = switchAgent ? (agent === 'codex' ? 'claude' : 'codex') : agent;

    return {
      iteration: iteration + 1,
      failureClass,
      action: strategy.action,
      targetRole: strategy.targetRole,
      agent: recommendedAgent,
      canRetry: true,
    };
  }
}

/**
 * Handles `doflow recover` — classify a verification failure and return the targeted action for
 * that class (FR-010).
 *
 * Exit 0 means a bounded retry is available and the plan says what to change; exit 1 means the
 * loop must stop — the retry budget is spent, or the class is one where retrying is guaranteed to
 * reproduce the failure. That is the distinction a caller has to branch on, so it is the one the
 * exit code carries.
 *
 * @param {Object} options
 * @param {string} options.errorMessage
 * @param {Array<string>} [options.failedChecks]
 * @param {number} [options.iteration=0] retries already spent
 * @param {string} [options.agent]
 * @param {boolean} [options.json=false]
 * @returns {number} exit code
 */
function handleRecoverCommand({ errorMessage, failedChecks = [], iteration = 0, agent, json = false } = {}) {
  // Handed nothing, the classifier answers UNKNOWN_FAILURE — a confident-looking verdict about a
  // failure it never saw. Refuse instead.
  if ((typeof errorMessage !== 'string' || errorMessage.trim() === '') && failedChecks.length === 0) {
    return usageError('recover', '--error (and/or one or more --failed-check) is required — classifying a failure nobody described would name a class over no evidence.', json);
  }
  const manager = new RecoveryManager();
  const failureClass = manager.classifyFailure(errorMessage, failedChecks);
  const plan = manager.planRecovery(failureClass, iteration, agent || undefined);

  if (json) console.log(JSON.stringify({ failureClass, failedChecks, ...plan }, null, 2));
  else {
    console.log(`\nDoFlow Recovery [${plan.failureClass}]:`);
    console.log('═'.repeat(78));
    console.log(`Action:     ${plan.action}`);
    console.log(`Target:     ${plan.targetRole || 'unchanged'}`);
    console.log(`Agent:      ${plan.agent}`);
    console.log(`Retry:      ${plan.canRetry ? `yes — iteration ${plan.iteration}` : 'no'}`);
    if (plan.reason) console.log(`Reason:     ${plan.reason}`);
    console.log('═'.repeat(78) + '\n');
  }
  return finishRuntime(plan.canRetry ? 0 : 1);
}

module.exports = {
  RecoveryManager,
  FAILURE_CLASSES,
  STRATEGY_MAP,
  GENERIC_STRATEGY,
  DEFAULT_MAX_ITERATIONS,
  handleRecoverCommand,
};
