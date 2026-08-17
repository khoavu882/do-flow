'use strict';

/**
 * Task-run telemetry — the JavaScript port of
 * `core/shared/scripts/doflow/evaluation/telemetry.py` (plan task B.3, component C9).
 *
 * Records a task's span: the events that happened inside it, how long it took, how many tokens it
 * consumed. Ported from observed behaviour (plan decision D3): the event record shape, the trace
 * key names, the six-decimal cost rounding and the default per-token rates are unchanged.
 *
 * Plan task C.3 builds the date-partitioned run ledger and its trace/stats/discover views on top
 * of this module; this file owns capturing one run's span, nothing more.
 *
 * Three defects are fixed rather than reproduced, each explained at its site:
 *   1. Duration came from `time.time()`, a wall clock that an NTP step or a DST change can move
 *      backwards mid-run, producing negative or inflated durations.
 *   2. `estimated_cost_usd` was computed from two hard-coded rates regardless of which model the
 *      trace named, so the number was presented as measured cost for models it did not price.
 *   3. `export_trace` returned the live `events` array, so a caller mutating the exported trace
 *      silently rewrote the recorder's history.
 */

/**
 * The Python's literal rates, kept as the default so an existing caller sees the same number.
 * They price one specific model; a trace naming a different one gets a cost only if the caller
 * supplies its rates, because inventing a price for an unpriced model is inventing a metric.
 */
const DEFAULT_TOKEN_RATES = Object.freeze({
  inputPerToken: 0.000003,
  outputPerToken: 0.000015,
});

const COST_DECIMALS = 6;

/**
 * @param {number} value
 * @returns {number} rounded to six decimals, matching the Python's `round(x, 6)`
 */
function roundCost(value) {
  const factor = 10 ** COST_DECIMALS;
  return Math.round(value * factor) / factor;
}

class TaskRunTelemetry {
  /**
   * @param {string} taskId
   * @param {Object|string} [options] a string is accepted for parity with the Python's positional
   *   `agent` argument
   * @param {string} [options.agent='codex']
   * @param {string} [options.model='default']
   * @param {{inputPerToken: number, outputPerToken: number}|null} [options.rates]
   * @param {Function} [options.clock] injection seam for tests; returns elapsed milliseconds
   */
  constructor(taskId, options = {}) {
    const opts = typeof options === 'string' ? { agent: options } : options;
    this.taskId = taskId;
    this.agent = opts.agent || 'codex';
    this.model = opts.model || 'default';
    this.rates = opts.rates === undefined ? DEFAULT_TOKEN_RATES : opts.rates;
    this.events = [];

    // Defect fix (1): a monotonic source. `Date.now()` (like Python's `time.time()`) can step
    // backwards, and a negative duration in a benchmark record is worse than no duration.
    this.clock = opts.clock || (() => Number(process.hrtime.bigint() / 1000000n));
    this.startedAtMs = this.clock();
    this.startedAt = new Date().toISOString();
  }

  /**
   * Appends a structured event to the span.
   * @param {string} eventType
   * @param {Object} [details={}]
   * @returns {Object} the recorded event
   */
  recordEvent(eventType, details = {}) {
    const event = {
      timestamp: new Date().toISOString(),
      type: eventType,
      details,
    };
    this.events.push(event);
    return event;
  }

  /**
   * Milliseconds elapsed since the recorder was constructed.
   * @returns {number}
   */
  elapsedMs() {
    return Math.max(0, this.clock() - this.startedAtMs);
  }

  /**
   * Compiles the run's trace record.
   * @param {boolean} success
   * @param {number} [inputTokens=0]
   * @param {number} [outputTokens=0]
   * @returns {Object} trace record
   */
  exportTrace(success, inputTokens = 0, outputTokens = 0) {
    // Defect fix (2): cost is only reported when rates are known for this run. The default rates
    // reproduce the Python's number exactly; a caller that clears them (`rates: null`) gets `null`
    // rather than a confident figure derived from another model's price list.
    const estimatedCostUsd = this.rates
      ? roundCost(inputTokens * this.rates.inputPerToken + outputTokens * this.rates.outputPerToken)
      : null;

    return {
      taskId: this.taskId,
      agent: this.agent,
      model: this.model,
      success: Boolean(success),
      startedAt: this.startedAt,
      durationMs: this.elapsedMs(),
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      eventCount: this.events.length,
      // Defect fix (3): a copy. The Python handed out its internal list, so an exported trace and
      // the recorder aliased the same array.
      events: this.events.map((e) => ({ ...e })),
    };
  }
}

module.exports = {
  TaskRunTelemetry,
  DEFAULT_TOKEN_RATES,
};
