'use strict';

// The bench bar that act mode requires. User decision D3 (2026-10-26): act is unreachable in 084. The bar may only be
// met by a DoFlow-owned scored bench corpus, none ships yet, and a file in the caller's project is never read, so the
// bar is always unmet. Producing that corpus is the future row "trusted bench scores" (not yet registered).

interface BenchBarResult {
  kind: string;
  model: string;
  passed: boolean;
  reason: string;
}

function evaluateBenchBar(kind: string, model: string): BenchBarResult {
  return {
    kind,
    model,
    passed: false,
    reason: `no trusted bench scores ship for kind '${kind}' and model '${model}'`,
  };
}

module.exports = {
  evaluateBenchBar,
};
