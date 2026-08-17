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
 * Per-class recovery strategy. A class absent from this table — CONTEXT_MISSING aside, that is
 * WRONG_IMPLEMENTATION, TOOL_FAILURE, AGENT_FAILURE, BUDGET_EXCEEDED and UNKNOWN_FAILURE — falls
 * through to the generic debugger strategy. That fallthrough is deliberate and preserved from the
 * Python: the bound on iterations, not a per-class rule, is what stops those loops.
 *
 * `switchAtIteration` encodes the Python's three agent-switch behaviours: `null` never switches,
 * `0` always switches (its unconditional `True`), and `2` switches only once two attempts have
 * already been spent (its `current_iteration >= 2`).
 */
const STRATEGY_MAP = Object.freeze({
  CONTEXT_MISSING: { action: 'RETRIEVE_MORE_CONTEXT', targetRole: 'SCOUT', switchAtIteration: null },
  BUILD_FAILURE: { action: 'TARGETED_COMPILER_FIX', targetRole: 'DEBUGGER', switchAtIteration: 2 },
  TEST_FAILURE: { action: 'TARGETED_DEBUGGER_FIX', targetRole: 'DEBUGGER', switchAtIteration: 2 },
  ARCHITECTURE_FAILURE: { action: 'GRAPH_RE_EVALUATION', targetRole: 'PLANNER', switchAtIteration: 0 },
  REQUIREMENT_FAILURE: { action: 'SPEC_RECONCILIATION', targetRole: 'PLANNER', switchAtIteration: 0 },
  ENVIRONMENT_FAILURE: { action: 'ENVIRONMENT_DIAGNOSTIC', targetRole: 'VERIFIER', switchAtIteration: null },
});

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

module.exports = {
  RecoveryManager,
  FAILURE_CLASSES,
  STRATEGY_MAP,
  DEFAULT_MAX_ITERATIONS,
};
