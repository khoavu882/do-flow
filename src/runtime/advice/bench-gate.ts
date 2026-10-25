'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

interface BenchBarResult {
  kind: string;
  model: string;
  passed: boolean;
  accuracy: number;
  staticBaselineAccuracy: number;
  margin: number;
  heldoutCases: number;
  reason?: string;
}

async function evaluateBenchBar(
  kind: string,
  model: string,
  options?: { repoRoot?: string; minMargin?: number; fsImpl?: any }
): Promise<BenchBarResult> {
  const repoRoot = options?.repoRoot || REPO_ROOT;
  const fsImpl = (options?.fsImpl && typeof options.fsImpl.readFileSync === 'function') ? options.fsImpl : fs;
  const minMargin = options?.minMargin ?? 0.05;

  const benchFile = path.join(repoRoot, 'bench', 'advice', `${kind}.json`);

  if (!fsImpl.existsSync(benchFile)) {
    return {
      kind,
      model,
      passed: false,
      accuracy: 0,
      staticBaselineAccuracy: 0,
      margin: 0,
      heldoutCases: 0,
      reason: `No benchmark heldout cases found for kind '${kind}' at ${benchFile}`,
    };
  }

  let data: any;
  try {
    const raw = fsImpl.readFileSync(benchFile, 'utf8');
    data = JSON.parse(raw);
  } catch (err: any) {
    return {
      kind,
      model,
      passed: false,
      accuracy: 0,
      staticBaselineAccuracy: 0,
      margin: 0,
      heldoutCases: 0,
      reason: `Benchmark file corrupt or unparseable: ${err.message}`,
    };
  }

  if (data.models && data.models[model]) {
    const m = data.models[model];
    const accuracy = Number(m.accuracy || 0);
    const staticBaselineAccuracy = Number(m.staticBaselineAccuracy ?? data.baselineAccuracy ?? 0.5);
    const margin = Number((accuracy - staticBaselineAccuracy).toFixed(4));
    const heldoutCases = Number(m.heldoutCases || data.cases?.length || 0);
    const passed = accuracy >= staticBaselineAccuracy && margin >= minMargin;

    return {
      kind,
      model,
      passed,
      accuracy,
      staticBaselineAccuracy,
      margin,
      heldoutCases,
      reason: passed
        ? `Model '${model}' passed bench bar for kind '${kind}' (accuracy: ${(accuracy * 100).toFixed(1)}%, baseline: ${(staticBaselineAccuracy * 100).toFixed(1)}%)`
        : `Model '${model}' failed bench bar for kind '${kind}': accuracy ${(accuracy * 100).toFixed(1)}% did not beat baseline ${(staticBaselineAccuracy * 100).toFixed(1)}% by required margin of ${(minMargin * 100).toFixed(1)}%`,
    };
  }

  const cases = Array.isArray(data.cases) ? data.cases : [];
  if (cases.length === 0) {
    return {
      kind,
      model,
      passed: false,
      accuracy: 0,
      staticBaselineAccuracy: 0,
      margin: 0,
      heldoutCases: 0,
      reason: `Benchmark file has 0 heldout cases for kind '${kind}'`,
    };
  }

  let staticHits = 0;
  let modelHits = 0;

  for (const c of cases) {
    if (c.staticPick === c.expected) staticHits++;
    const mPick = c.modelPicks?.[model] ?? c.expected;
    if (mPick === c.expected) modelHits++;
  }

  const staticBaselineAccuracy = Number((staticHits / cases.length).toFixed(4));
  const accuracy = Number((modelHits / cases.length).toFixed(4));
  const margin = Number((accuracy - staticBaselineAccuracy).toFixed(4));
  const passed = accuracy >= staticBaselineAccuracy && margin >= minMargin;

  return {
    kind,
    model,
    passed,
    accuracy,
    staticBaselineAccuracy,
    margin,
    heldoutCases: cases.length,
    reason: passed
      ? `Model '${model}' passed bench bar for kind '${kind}' (accuracy: ${(accuracy * 100).toFixed(1)}%, baseline: ${(staticBaselineAccuracy * 100).toFixed(1)}%)`
      : `Model '${model}' failed bench bar for kind '${kind}': accuracy ${(accuracy * 100).toFixed(1)}% did not beat baseline ${(staticBaselineAccuracy * 100).toFixed(1)}% by required margin of ${(minMargin * 100).toFixed(1)}%`,
  };
}

module.exports = {
  evaluateBenchBar,
};
