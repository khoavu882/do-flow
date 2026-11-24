'use strict';

// The time bar for a hook step, in units of the runner's own no-op baseline (one bash start, the step file sourced
// and one jq start, measured interleaved with the step). A fixed millisecond bar fails on a runner whose process
// starts are slow, as the macOS CI runner's are (a 13.8 ms baseline against 5 ms here), so the bar scales with the
// baseline instead. Measured on the reference Mac on 2026-11-24: the baseline is about 5 ms, so the bar is about
// 20 ms there; a hook step's own work measured 0.9 to 1.5 baselines on that Mac, on GitHub's ubuntu-latest and on
// its macos-latest runner.

const STEP_BAR_BASELINES = 4;

/** The most a step may take above its no-op baseline, given that baseline's median in ms. */
function stepBarMs(baselineMs: number): number {
  return STEP_BAR_BASELINES * baselineMs;
}

/** Extra work for a control run: the baseline's own process starts (a bash that starts a jq), eight times over. At
 * 0.86 baselines each on the reference Mac it adds about seven baselines, so a step doing it must fail the bar. */
const CONTROL_EXTRA_WORK = 'for _ in 1 2 3 4 5 6 7 8; do bash -c "jq -n . >/dev/null"; done';

module.exports = { STEP_BAR_BASELINES, stepBarMs, CONTROL_EXTRA_WORK };
