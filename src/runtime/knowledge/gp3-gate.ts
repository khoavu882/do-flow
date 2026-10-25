'use strict';

interface GateVerdict {
  gate: 'G-P3';
  verdict: 'KEEP' | 'DISABLE' | 'CONDITIONAL';
  passed: boolean;
  criteria: {
    missedDependenciesReductionMet: boolean; // Requires >= 0.15 (15%)
    latencyOverheadMet: boolean;             // Requires latencyDeltaMs <= 250ms
    zeroUnreachedRegression: boolean;        // Requires unreachedCount <= baseline
  };
  headlineMetricDelta: number;
  rationale: string;
}

function evaluateGP3Gate(report: any): GateVerdict {
  const reduction = report.delta?.missedDependenciesReduction ?? 0;
  const latencyDeltaMs = report.delta?.latencyDeltaMs ?? 0;
  const unreachedBaseline = report.arms?.lexical?.unreachedCount ?? 0;
  const unreachedGraph = report.arms?.graphImpact?.unreachedCount ?? 0;

  const missedDependenciesReductionMet = reduction >= 0.15;
  const latencyOverheadMet = latencyDeltaMs <= 250;
  const zeroUnreachedRegression = unreachedGraph <= unreachedBaseline;

  const passed =
    missedDependenciesReductionMet &&
    latencyOverheadMet &&
    zeroUnreachedRegression;

  let verdict: 'KEEP' | 'DISABLE' | 'CONDITIONAL';
  let rationale = '';

  if (passed) {
    verdict = 'KEEP';
    rationale = `Passed G-P3 criteria: missedDependenciesReduction ${(reduction * 100).toFixed(1)}% (threshold >= 15%), latency delta ${latencyDeltaMs}ms <= 250ms budget, zero unreached regressions.`;
  } else {
    verdict = 'DISABLE';
    const failures: string[] = [];
    if (!missedDependenciesReductionMet) {
      failures.push(
        `missedDependenciesReduction ${(reduction * 100).toFixed(1)}% fell below 15% threshold`
      );
    }
    if (!latencyOverheadMet) {
      failures.push(
        `latency overhead +${latencyDeltaMs}ms exceeded 250ms budget`
      );
    }
    if (!zeroUnreachedRegression) {
      failures.push(
        `unreached queries regressed from ${unreachedBaseline} to ${unreachedGraph}`
      );
    }
    rationale = `Failed G-P3 criteria: ${failures.join('; ')}. Graph reranking must be disabled to avoid unproven latency overhead.`;
  }

  return {
    gate: 'G-P3',
    verdict,
    passed,
    criteria: {
      missedDependenciesReductionMet,
      latencyOverheadMet,
      zeroUnreachedRegression,
    },
    headlineMetricDelta: Number(reduction.toFixed(4)),
    rationale,
  };
}

module.exports = {
  evaluateGP3Gate,
};
