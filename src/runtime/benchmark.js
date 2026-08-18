'use strict';

/**
 * Benchmark result records and their report table — the JavaScript port of
 * `core/shared/scripts/doflow/evaluation/benchmark_runner.py` (plan task B.3).
 *
 * What the Python actually did, and the defect this port refuses to reproduce: `run_benchmarks()`
 * returned two hard-coded dictionaries — `debug-001` passing in 420 ms for $0.045, `refactor-001`
 * passing in 380 ms for $0.032 — and `main()` printed them under the heading "DoFlow Engineering
 * Benchmark Results". No task ran. Nothing was measured. Porting that faithfully would ship
 * fabricated metrics, which the constitution's evidence rule forbids outright and which is worse
 * than having no benchmark at all, because it reports green.
 *
 * So the record shape and the report table — the two things the Python genuinely defined — are
 * preserved exactly, and the fabricated data is replaced by running the cases the caller supplies.
 * Given no cases it returns none, rather than inventing two.
 *
 * This is deliberately not a second evaluation harness: `bench/runner.js` (plan task A.1) owns
 * driving skills against a model and diffing a baseline. This module is the small measurement and
 * formatting layer the Python file described, usable by anything that needs to time a set of
 * cases and print the same table.
 */

const BENCHMARK_STATUS_WIDTH = 60;

/**
 * Runs benchmark cases in sequence and returns one measured record per case.
 *
 * Cases run one at a time on purpose: durations are the point of the exercise, and concurrent
 * cases contend for the same CPU and disk, which makes every recorded number a measurement of the
 * scheduler instead.
 *
 * @param {Array<Object>} cases each `{ taskId, category, agent, run }`, where `run` is a function
 *   (sync or async) returning `{ success, tokens, costUsd }`
 * @param {Object} [options]
 * @param {Function} [options.runCase] fallback executor for cases with no own `run`
 * @param {Function} [options.clock] injection seam for tests; returns elapsed milliseconds
 * @returns {Promise<Array<Object>>} records `{ taskId, category, agent, success, durationMs, tokens, costUsd }`
 */
async function runBenchmarks(cases, options = {}) {
  if (!Array.isArray(cases)) {
    throw new Error('runBenchmarks expects an array of cases');
  }

  // Monotonic, for the same reason `trace.js` uses it: a wall clock that steps backwards mid-run
  // produces a negative duration in a record that is supposed to be a measurement.
  const clock = options.clock || (() => Number(process.hrtime.bigint() / 1000000n));
  const results = [];

  for (const testCase of cases) {
    const taskId = testCase.taskId || 'unnamed';
    const record = {
      taskId,
      category: testCase.category || 'uncategorized',
      agent: testCase.agent || 'unknown',
      success: false,
      durationMs: 0,
      tokens: 0,
      costUsd: 0,
    };

    const executor = testCase.run || options.runCase;
    if (typeof executor !== 'function') {
      // Reported, not thrown: one unrunnable case must not discard the measurements of the cases
      // around it. A record that says why it failed is the honest result here.
      record.error = `Case '${taskId}' has no runnable function`;
      results.push(record);
      continue;
    }

    const started = clock();
    try {
      const outcome = (await executor(testCase)) || {};
      record.success = Boolean(outcome.success);
      record.tokens = outcome.tokens || 0;
      record.costUsd = outcome.costUsd || 0;
      if (outcome.error) record.error = outcome.error;
    } catch (error) {
      record.success = false;
      record.error = error.message;
    }
    record.durationMs = Math.max(0, clock() - started);

    results.push(record);
  }

  return results;
}

/**
 * Renders the benchmark table.
 *
 * Returns the string instead of printing it, which the Python did inline: a formatter that returns
 * is testable and lets the dispatcher decide whether the report goes to stdout, a file or a ledger.
 * The layout itself — column widths, the double rule, the `PASS`/`FAIL` word — is unchanged.
 * @param {Array<Object>} results
 * @returns {string}
 */
function formatResults(results) {
  const rule = '═'.repeat(BENCHMARK_STATUS_WIDTH);
  const lines = ['', 'DoFlow Engineering Benchmark Results:', rule];

  if (!Array.isArray(results) || results.length === 0) {
    lines.push('No benchmark cases were run.');
  } else {
    for (const r of results) {
      const status = r.success ? 'PASS' : 'FAIL';
      lines.push(
        `Task: ${String(r.taskId).padEnd(16)} Agent: ${String(r.agent).padEnd(10)} ` +
        `Status: ${status} (${r.durationMs}ms, $${r.costUsd})`
      );
      if (r.error) {
        lines.push(`  └─ ${r.error}`);
      }
    }
  }

  lines.push(`${rule}\n`);
  return lines.join('\n');
}

module.exports = {
  runBenchmarks,
  formatResults,
};
