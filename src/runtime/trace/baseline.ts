'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const msOf = (v: string | null): number | null =>
  (typeof v === 'string' && ISO_UTC.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/** Sort object keys at every level to ensure deterministic JSON representation. */
function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sorted(value[k]);
    }
    return out;
  }
  return value;
}

/** Union of overlapping half-open intervals [start, end]. Counted once in the union. */
function unionIntervals(intervals: Array<[number, number]>): number {
  const valid = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s);
  if (valid.length === 0) return 0;
  valid.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [valid[0].slice() as [number, number]];
  for (let i = 1; i < valid.length; i++) {
    const [currStart, currEnd] = valid[i];
    const last = merged[merged.length - 1];
    if (currStart <= last[1]) {
      last[1] = Math.max(last[1], currEnd);
    } else {
      merged.push([currStart, currEnd]);
    }
  }
  return merged.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** Detect idle gaps between activity intervals that exceed thresholdMs (D-8). */
function findIdleGaps(activityIntervals: Array<[number, number]>, thresholdMs = THIRTY_MINUTES_MS): Array<{ start: string; end: string; durationMs: number }> {
  const valid = activityIntervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e >= s);
  if (valid.length === 0) return [];
  valid.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [valid[0].slice() as [number, number]];
  for (let i = 1; i < valid.length; i++) {
    const [currStart, currEnd] = valid[i];
    const last = merged[merged.length - 1];
    if (currStart <= last[1]) {
      last[1] = Math.max(last[1], currEnd);
    } else {
      merged.push([currStart, currEnd]);
    }
  }
  const gaps: Array<{ start: string; end: string; durationMs: number }> = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const gapStart = merged[i][1];
    const gapEnd = merged[i + 1][0];
    const durationMs = gapEnd - gapStart;
    if (durationMs > thresholdMs) {
      gaps.push({
        start: new Date(gapStart).toISOString(),
        end: new Date(gapEnd).toISOString(),
        durationMs,
      });
    }
  }
  return gaps;
}

function calcMedian(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sortedNums = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sortedNums.length / 2);
  if (sortedNums.length % 2 === 1) return sortedNums[mid];
  return (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

function calcRange(numbers: number[]): [number, number] {
  if (numbers.length === 0) return [0, 0];
  return [Math.min(...numbers), Math.max(...numbers)];
}

/** Pure baseline computation over trace spans and manifest (088 IC-012, FR-010, FR-011). */
function buildBaseline(spansView: any = {}, manifest: any = {}): any {
  const traces: any[] = Array.isArray(spansView?.traces) ? spansView.traces : (Array.isArray(spansView) ? spansView : []);
  const allHarnesses = new Set<string>();
  if (manifest?.harness && typeof manifest.harness === 'string') {
    allHarnesses.add(manifest.harness);
  }

  let totalBroadTestsChecks = 0;
  let totalTestFullSpans = 0;
  let anyCpuRecorded = false;

  const goalLoops: any[] = traces.map((tr) => {
    const spanList: any[] = Array.isArray(tr.spans) ? tr.spans : [];

    // Find harness for this trace
    let traceHarness: string | null = null;
    for (const s of spanList) {
      if (s.attrs?.harness && typeof s.attrs.harness === 'string') {
        traceHarness = s.attrs.harness;
        allHarnesses.add(s.attrs.harness);
        break;
      }
    }
    if (!traceHarness && manifest?.harness) {
      traceHarness = manifest.harness;
    }

    // 1. Spans classification & boundaries
    const starts: number[] = [];
    const closedEnds: number[] = [];
    const upperEnds: number[] = [];
    const activityIntervals: Array<[number, number]> = [];

    const closedVerificationIntervals: Array<[number, number]> = [];
    const upperVerificationIntervals: Array<[number, number]> = [];

    let executedCheckTotalDurationLower = 0;
    let executedCheckTotalDurationUpper = 0;
    let outsideVerbTestTotalDurationLower = 0;
    let outsideVerbTestTotalDurationUpper = 0;

    let loopBroadTestsChecks = 0;
    let loopTestFull = 0;
    let loopCpuMs = 0;
    let hasProcChildren = false;

    // Duplicates tracking
    const checkKeyCounts = new Map<string, number>();
    const sessionTestClassCounts = new Map<string, number>();

    // Collect trace window boundaries if present
    if (tr.window?.from) {
      const fromMs = msOf(tr.window.from);
      if (fromMs !== null) starts.push(fromMs);
    }
    if (tr.window?.to) {
      const toMs = msOf(tr.window.to);
      if (toMs !== null) {
        closedEnds.push(toMs);
        upperEnds.push(toMs);
      }
    }

    for (let i = 0; i < spanList.length; i++) {
      const s = spanList[i];
      const startMs = msOf(s.start);
      let endMs = msOf(s.end);
      if (startMs !== null && endMs === null && Number.isInteger(s.durationMs) && s.durationMs >= 0) {
        endMs = startMs + s.durationMs;
      }

      if (startMs !== null) starts.push(startMs);
      if (endMs !== null) {
        closedEnds.push(endMs);
        upperEnds.push(endMs);
        if (startMs !== null) activityIntervals.push([startMs, endMs]);
      } else if (startMs !== null) {
        // Open-ended span: determine upper bound end (until next span start or window.to)
        const nextSpan = spanList.slice(i + 1).find((n) => n.start !== null);
        const nextStartMs = nextSpan ? msOf(nextSpan.start) : (tr.window?.to ? msOf(tr.window.to) : null);
        const upperEnd = nextStartMs !== null && nextStartMs > startMs ? nextStartMs : startMs;
        upperEnds.push(upperEnd);
        activityIntervals.push([startMs, upperEnd]);
      }

      const isOutsideVerbTest = s.kind === 'test' || (s.kind === 'hook' && typeof s.attrs?.test_class === 'string' && s.attrs.test_class.startsWith('test.'));
      const isVerifyRun = s.kind === 'verify.run';
      const isVerifyCheck = s.kind === 'verify.check';

      // Verification intervals for verificationWallMs
      if (isVerifyRun || isOutsideVerbTest) {
        if (startMs !== null && endMs !== null && endMs > startMs) {
          closedVerificationIntervals.push([startMs, endMs]);
          upperVerificationIntervals.push([startMs, endMs]);
        } else if (startMs !== null && endMs === null) {
          // Open-ended verification span: excluded from lower end, included in upper bound
          const nextSpan = spanList.slice(i + 1).find((n) => n.start !== null);
          const nextStartMs = nextSpan ? msOf(nextSpan.start) : (tr.window?.to ? msOf(tr.window.to) : null);
          const upperEnd = nextStartMs !== null && nextStartMs > startMs ? nextStartMs : startMs;
          if (upperEnd > startMs) {
            upperVerificationIntervals.push([startMs, upperEnd]);
          }
        }
      }

      // Check executions for totalTestMs, duplicates, fullSuiteRuns, cpuMs
      if (isVerifyCheck) {
        const isNotRun = s.attrs?.status === 'NOT_RUN';
        const isSharedInRun = s.attrs?.shared === 'in-run';
        const isSharedFollower = s.attrs?.shared === 'follower';
        const isExecuted = !isNotRun && !isSharedInRun && !isSharedFollower;

        if (isExecuted) {
          const duration = typeof s.durationMs === 'number' ? s.durationMs : (startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : 0);
          executedCheckTotalDurationLower += duration;
          if (startMs !== null && endMs === null && duration === 0) {
            const nextSpan = spanList.slice(i + 1).find((n) => n.start !== null);
            const nextStartMs = nextSpan ? msOf(nextSpan.start) : (tr.window?.to ? msOf(tr.window.to) : null);
            const upperDur = nextStartMs !== null && nextStartMs > startMs ? nextStartMs - startMs : 0;
            executedCheckTotalDurationUpper += upperDur;
          } else {
            executedCheckTotalDurationUpper += duration;
          }

          if (s.attrs?.tier === 'broad-tests') {
            loopBroadTestsChecks += 1;
            totalBroadTestsChecks += 1;
          }

          if (s.attrs?.resource_basis === 'proc-children') {
            hasProcChildren = true;
            anyCpuRecorded = true;
            if (typeof s.attrs.cpu_ms === 'number') {
              loopCpuMs += s.attrs.cpu_ms;
            }
          }

          if (s.attrs?.check_key && typeof s.attrs.check_key === 'string') {
            checkKeyCounts.set(s.attrs.check_key, (checkKeyCounts.get(s.attrs.check_key) || 0) + 1);
          }
        }
      }

      // Outside-verb test durations and duplicates
      if (isOutsideVerbTest) {
        const duration = typeof s.durationMs === 'number' ? s.durationMs : (startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : 0);
        outsideVerbTestTotalDurationLower += duration;
        if (startMs !== null && endMs === null && duration === 0) {
          const nextSpan = spanList.slice(i + 1).find((n) => n.start !== null);
          const nextStartMs = nextSpan ? msOf(nextSpan.start) : (tr.window?.to ? msOf(tr.window.to) : null);
          const upperDur = nextStartMs !== null && nextStartMs > startMs ? nextStartMs - startMs : 0;
          outsideVerbTestTotalDurationUpper += upperDur;
        } else {
          outsideVerbTestTotalDurationUpper += duration;
        }

        if (s.attrs?.test_class === 'test.full') {
          loopTestFull += 1;
          totalTestFullSpans += 1;
        }

        const testClass = s.attrs?.test_class;
        const session = s.session || s.attrs?.session || 'default';
        if (testClass && typeof testClass === 'string') {
          const key = `${session}::${testClass}`;
          sessionTestClassCounts.set(key, (sessionTestClassCounts.get(key) || 0) + 1);
        }
      }
    }

    // Boundary timings
    const firstSpanMs = starts.length > 0 ? Math.min(...starts) : 0;
    const lastClosedSpanMs = closedEnds.length > 0 ? Math.max(...closedEnds) : (starts.length > 0 ? Math.max(...starts) : firstSpanMs);
    const lastUpperSpanMs = upperEnds.length > 0 ? Math.max(...upperEnds) : lastClosedSpanMs;

    const loopWallMsLower = Math.max(0, lastClosedSpanMs - firstSpanMs);
    const loopWallMsUpper = Math.max(0, lastUpperSpanMs - firstSpanMs);

    // Verification union (counted once in the union)
    const verificationWallMsLower = unionIntervals(closedVerificationIntervals);
    const verificationWallMsUpper = unionIntervals(upperVerificationIntervals);

    // Total test durations (summed twice in the sum)
    const totalTestMsLower = executedCheckTotalDurationLower + outsideVerbTestTotalDurationLower;
    const totalTestMsUpper = executedCheckTotalDurationUpper + outsideVerbTestTotalDurationUpper;

    // Idle gaps > 30 min (D-8)
    const idleGaps = findIdleGaps(activityIntervals, THIRTY_MINUTES_MS);
    const idleGapsMs = idleGaps.reduce((acc, g) => acc + g.durationMs, 0);

    // Implementation time: loop - union - idle gaps > 30 min
    const implementationMsLower = Math.max(0, loopWallMsLower - verificationWallMsLower - idleGapsMs);
    const implementationMsUpper = Math.max(0, loopWallMsUpper - verificationWallMsUpper - idleGapsMs);

    // Ratio and Share
    const ratioLower = loopWallMsLower > 0 ? verificationWallMsLower / loopWallMsLower : 0;
    const ratioUpper = loopWallMsUpper > 0 ? verificationWallMsUpper / loopWallMsUpper : ratioLower;

    // Duplicates
    let exactDuplicates = 0;
    for (const count of checkKeyCounts.values()) {
      if (count > 1) exactDuplicates += count - 1;
    }
    let candidateDuplicates = 0;
    for (const count of sessionTestClassCounts.values()) {
      if (count > 1) candidateDuplicates += count - 1;
    }
    const totalDuplicates = exactDuplicates + candidateDuplicates;

    // Full suite runs
    const fullSuiteRuns = loopBroadTestsChecks + loopTestFull;

    return {
      traceId: tr.traceId || null,
      runKey: tr.runKey || null,
      epoch: tr.epoch !== undefined ? tr.epoch : null,
      harness: traceHarness,
      window: tr.window || null,
      idleGaps,
      metrics: {
        loopWallMs: loopWallMsLower,
        verificationWallMs: verificationWallMsLower,
        totalTestMs: totalTestMsLower,
        implementationMs: implementationMsLower,
        ratio: ratioLower,
        share: ratioLower,
        duplicates: totalDuplicates,
        exactDuplicates,
        candidateDuplicates,
        fullSuiteRuns,
        cpuMs: hasProcChildren ? loopCpuMs : 'unreached',
        peakMemory: 'unreached',
        idleGapsMs,
      },
      upperBound: {
        loopWallMs: loopWallMsUpper,
        verificationWallMs: verificationWallMsUpper,
        totalTestMs: totalTestMsUpper,
        implementationMs: implementationMsUpper,
        ratio: ratioUpper,
        share: ratioUpper,
      },
    };
  });

  const loopsCount = goalLoops.length;
  const harnessesCount = allHarnesses.size;
  const windowFilled = loopsCount >= 5 && harnessesCount >= 2;

  // Aggregate metrics across goal loops
  const aggLoopWall = goalLoops.map((g) => g.metrics.loopWallMs);
  const aggVerifWall = goalLoops.map((g) => g.metrics.verificationWallMs);
  const aggTotalTest = goalLoops.map((g) => g.metrics.totalTestMs);
  const aggImpl = goalLoops.map((g) => g.metrics.implementationMs);
  const aggRatio = goalLoops.map((g) => g.metrics.ratio);
  const aggDuplicates = goalLoops.map((g) => g.metrics.duplicates);
  const aggFullSuite = goalLoops.map((g) => g.metrics.fullSuiteRuns);
  const aggIdleGaps = goalLoops.map((g) => g.metrics.idleGapsMs);

  const aggLoopWallUpper = goalLoops.map((g) => g.upperBound.loopWallMs);
  const aggVerifWallUpper = goalLoops.map((g) => g.upperBound.verificationWallMs);
  const aggTotalTestUpper = goalLoops.map((g) => g.upperBound.totalTestMs);
  const aggImplUpper = goalLoops.map((g) => g.upperBound.implementationMs);
  const aggRatioUpper = goalLoops.map((g) => g.upperBound.ratio);

  const numericCpuValues = goalLoops.filter((g) => typeof g.metrics.cpuMs === 'number').map((g) => g.metrics.cpuMs as number);
  const aggCpuMedian = numericCpuValues.length > 0 ? calcMedian(numericCpuValues) : 'unreached';
  const aggCpuRange = numericCpuValues.length > 0 ? calcRange(numericCpuValues) : null;

  const medianRatio = calcMedian(aggRatio);
  let verdict = 'verdict not yet derivable';
  if (windowFilled) {
    // D-1 materiality rule: verification wall time >= 20% of goal-loop wall time
    verdict = medianRatio >= 0.2 ? 'material' : 'not material';
  }
  const progress = `${loopsCount} of 5 loops, ${harnessesCount} of 2 harnesses`;

  const inputTable = [
    {
      metric: 'loopWallMs',
      basis: 'derived',
      recordsRead: 'task-run history start/resume, activity endpoints, trace span window',
      uncapturedInputs: 'open-ended spans without completion events',
      cause: 'derived as last span end minus first span start across trace spans',
    },
    {
      metric: 'verificationWallMs',
      basis: 'derived',
      recordsRead: 'verify.run spans, outside-verb test spans',
      uncapturedInputs: 'tests on unobserved harnesses (OpenCode, Copilot)',
      cause: 'union of verify.run intervals and outside-verb test intervals',
    },
    {
      metric: 'totalTestMs',
      basis: 'derived',
      recordsRead: 'executed verify.check spans, outside-verb test spans',
      uncapturedInputs: 'per-check timing on pre-FR-016 records, test durations on non-Claude harnesses',
      cause: 'sum of executed check durations (excluding in-run and follower) + outside-verb test durations',
    },
    {
      metric: 'implementationMs',
      basis: 'derived',
      recordsRead: 'loop wall time, verification union wall time, idle intervals > 30 min',
      uncapturedInputs: 'fine-grained model thinking / editing time outside observed commands',
      cause: 'goal loop wall time minus verification wall time minus idle gaps > 30 min',
    },
    {
      metric: 'ratio',
      basis: 'derived',
      recordsRead: 'verificationWallMs, loopWallMs',
      uncapturedInputs: 'none beyond constituent metrics',
      cause: 'verificationWallMs / loopWallMs',
    },
    {
      metric: 'share',
      basis: 'derived',
      recordsRead: 'verificationWallMs, loopWallMs',
      uncapturedInputs: 'none beyond constituent metrics',
      cause: 'verificationWallMs / loopWallMs',
    },
    {
      metric: 'duplicates',
      basis: 'derived',
      recordsRead: 'executed verify.check spans with check_key, outside-verb test spans by session and test_class',
      uncapturedInputs: 'edit hook lines not available in 088, so all repeated tests in session are candidate duplicates',
      cause: 'exact check_key duplicates + candidate same-class test repeats in a session',
    },
    {
      metric: 'fullSuiteRuns',
      basis: 'derived',
      recordsRead: 'executed broad-tests checks, test.full outside-verb test spans',
      uncapturedInputs: 'none',
      cause: 'sum of executed broad-tests checks and test.full runs',
    },
    {
      metric: 'cpuMs',
      basis: anyCpuRecorded ? 'recorded' : 'unreached',
      recordsRead: 'verify.check spans with resource_basis proc-children',
      uncapturedInputs: 'non-Linux platforms (darwin, win32) and unkeyable/read faults',
      cause: anyCpuRecorded ? 'sum of check cpu_ms where resource_basis is proc-children' : 'child CPU ticks unreached on non-Linux platforms',
    },
    {
      metric: 'peakMemory',
      basis: 'unreached',
      recordsRead: 'none',
      uncapturedInputs: 'process peak RSS memory measurement',
      cause: 'no portable zero-dependency child memory sampling while spawnSync blocks',
    },
    {
      metric: 'idleGapsMs',
      basis: 'derived',
      recordsRead: 'inferred from timestamps between consecutive activities',
      uncapturedInputs: 'sub-30-minute idle pauses treated as implementation time',
      cause: 'sum of activity gaps exceeding the 30-minute session threshold (D-8)',
    },
  ];

  const surveyProxies = {
    note: 'pre-telemetry proxies from research/baseline-survey.md §4, context only, never a result',
    range: '0.49 % - 87.0 %',
    proxies: [
      { id: 'A', name: 'Ledger dispatched time', share: '87.0 %', bias: 'Denominator is only DoFlow verbs; excludes agent, edit and Bash time. Says verify dominates DoFlow verb time, nothing about goal loop.' },
      { id: 'B', name: 'Idle-gap session wall', share: '1.34 %', bias: '30-minute gap is an inference; single-record sessions have 0 wall; overnight idle excluded only when gap > 30 min.' },
      { id: 'B2', name: 'Sessions containing verify', share: '4.14 %', bias: 'Selects sessions where verification happened, biased upward.' },
      { id: 'C', name: 'Orchestration records', share: '1.1 %', bias: 'Stages are completion intervals; verification stage closed almost immediately; suite reruns land in implementation.' },
      { id: 'total', name: 'Verify verb vs orchestration totalMs', share: '0.49 %', bias: 'Understates verification time; reruns happened outside the verb.' },
    ],
  };

  const samplingRule = 'controlled goal loop on a pinned snapshot with run identity and FR-016/FR-019 telemetry';
  const biases = [
    'union assumes overlapping verification intervals reflect concurrent execution or waiting',
    'outside-verb tests observed with completion duration on Claude only; other harnesses record duration as unreached',
    'child CPU ticks recorded on Linux proc-children only; unreached on Darwin/Windows',
    'peak memory unreached on all platforms',
    'candidate test duplicates treat all same-class repeats within a session as candidates due to absence of edit hook lines',
  ];

  const aggregate = {
    metrics: {
      loopWallMs: {
        median: calcMedian(aggLoopWall),
        range: calcRange(aggLoopWall),
        lower: calcMedian(aggLoopWall),
        upper: calcMedian(aggLoopWallUpper),
        basis: 'derived',
      },
      verificationWallMs: {
        median: calcMedian(aggVerifWall),
        range: calcRange(aggVerifWall),
        lower: calcMedian(aggVerifWall),
        upper: calcMedian(aggVerifWallUpper),
        basis: 'derived',
      },
      totalTestMs: {
        median: calcMedian(aggTotalTest),
        range: calcRange(aggTotalTest),
        lower: calcMedian(aggTotalTest),
        upper: calcMedian(aggTotalTestUpper),
        basis: 'derived',
      },
      implementationMs: {
        median: calcMedian(aggImpl),
        range: calcRange(aggImpl),
        lower: calcMedian(aggImpl),
        upper: calcMedian(aggImplUpper),
        basis: 'derived',
      },
      ratio: {
        median: calcMedian(aggRatio),
        range: calcRange(aggRatio),
        lower: calcMedian(aggRatio),
        upper: calcMedian(aggRatioUpper),
        basis: 'derived',
      },
      share: {
        median: calcMedian(aggRatio),
        range: calcRange(aggRatio),
        lower: calcMedian(aggRatio),
        upper: calcMedian(aggRatioUpper),
        basis: 'derived',
      },
      duplicates: {
        median: calcMedian(aggDuplicates),
        range: calcRange(aggDuplicates),
        basis: 'derived',
      },
      fullSuiteRuns: {
        median: calcMedian(aggFullSuite),
        range: calcRange(aggFullSuite),
        basis: 'derived',
      },
      cpuMs: {
        median: aggCpuMedian,
        range: aggCpuRange,
        basis: anyCpuRecorded ? 'recorded' : 'unreached',
      },
      peakMemory: {
        median: 'unreached',
        range: null,
        basis: 'unreached',
      },
      idleGapsMs: {
        median: calcMedian(aggIdleGaps),
        range: calcRange(aggIdleGaps),
        basis: 'derived',
      },
    },
  };

  const primaryMetrics = {
    loopWallMs: aggregate.metrics.loopWallMs.median,
    verificationWallMs: aggregate.metrics.verificationWallMs.median,
    totalTestMs: aggregate.metrics.totalTestMs.median,
    implementationMs: aggregate.metrics.implementationMs.median,
    ratio: aggregate.metrics.ratio.median,
    share: aggregate.metrics.share.median,
    duplicates: aggregate.metrics.duplicates.median,
    fullSuiteRuns: aggregate.metrics.fullSuiteRuns.median,
    cpuMs: aggregate.metrics.cpuMs.median,
    peakMemory: 'unreached',
    idleGapsMs: aggregate.metrics.idleGapsMs.median,
    upperBound: {
      loopWallMs: aggregate.metrics.loopWallMs.upper,
      verificationWallMs: aggregate.metrics.verificationWallMs.upper,
      totalTestMs: aggregate.metrics.totalTestMs.upper,
      implementationMs: aggregate.metrics.implementationMs.upper,
      ratio: aggregate.metrics.ratio.upper,
      share: aggregate.metrics.share.upper,
    },
  };

  const report = {
    v: 1,
    verdict,
    progress,
    metrics: primaryMetrics,
    aggregate,
    goalLoops,
    inputTable,
    context: {
      surveyProxies,
    },
    samplingRule,
    biases,
    manifest: {
      commit: manifest?.commit || null,
      node: manifest?.node || null,
      platform: manifest?.platform || null,
      harness: manifest?.harness || null,
      fileCount: Array.isArray(manifest?.files) ? manifest.files.length : 0,
    },
  };

  return sorted(report);
}

/** Render baseline report as readable markdown. */
function renderReportMarkdown(report: any): string {
  const lines: string[] = [];
  lines.push('# Verification Baseline Report\n');
  lines.push(`**Verdict:** ${report.verdict}`);
  lines.push(`**Measurement Window Progress (D-16):** ${report.progress}\n`);

  lines.push('## Input Table\n');
  lines.push('| Metric | Basis | Records Read | Uncaptured Inputs | Cause |');
  lines.push('|---|---|---|---|---|');
  for (const row of report.inputTable || []) {
    lines.push(`| ${row.metric} | ${row.basis} | ${row.recordsRead} | ${row.uncapturedInputs} | ${row.cause} |`);
  }
  lines.push('');

  lines.push('## Aggregate Metrics\n');
  lines.push('| Metric | Median | Range | Lower End (D-1) | Upper Bound | Basis |');
  lines.push('|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(report.aggregate?.metrics || {})) {
    const val = v as any;
    const medianVal = val.median !== undefined ? val.median : val;
    const rangeVal = Array.isArray(val.range) ? `${val.range[0]} - ${val.range[1]}` : (val.range ?? '-');
    const lowerVal = val.lower !== undefined ? val.lower : '-';
    const upperVal = val.upper !== undefined ? val.upper : '-';
    const basisVal = val.basis || '-';
    lines.push(`| ${k} | ${medianVal} | ${rangeVal} | ${lowerVal} | ${upperVal} | ${basisVal} |`);
  }
  lines.push('');

  lines.push('## Goal Loops\n');
  const loops = report.goalLoops || [];
  lines.push(`Total loops recorded: ${loops.length}\n`);
  for (let idx = 0; idx < loops.length; idx++) {
    const gl = loops[idx];
    lines.push(`### Goal Loop ${idx + 1}: ${gl.traceId || gl.runKey || 'unnamed'}`);
    lines.push(`- **Harness:** ${gl.harness || 'unspecified'}`);
    lines.push(`- **Window:** ${gl.window?.from || '-'} .. ${gl.window?.to || 'open'}`);
    lines.push(`- **Loop Wall:** ${gl.metrics.loopWallMs} ms (upper bound: ${gl.upperBound?.loopWallMs || gl.metrics.loopWallMs} ms)`);
    lines.push(`- **Verification Wall:** ${gl.metrics.verificationWallMs} ms (upper bound: ${gl.upperBound?.verificationWallMs || gl.metrics.verificationWallMs} ms)`);
    lines.push(`- **Total Test Time:** ${gl.metrics.totalTestMs} ms (upper bound: ${gl.upperBound?.totalTestMs || gl.metrics.totalTestMs} ms)`);
    lines.push(`- **Implementation Time:** ${gl.metrics.implementationMs} ms (upper bound: ${gl.upperBound?.implementationMs || gl.metrics.implementationMs} ms)`);
    lines.push(`- **Verification Ratio:** ${gl.metrics.ratio}`);
    lines.push(`- **Idle Gaps (> 30 min):** ${gl.metrics.idleGapsMs} ms (${gl.idleGaps.length} gap(s))`);
    lines.push(`- **Duplicates:** ${gl.metrics.duplicates} (exact: ${gl.metrics.exactDuplicates}, candidate: ${gl.metrics.candidateDuplicates})`);
    lines.push(`- **Full Suite Runs:** ${gl.metrics.fullSuiteRuns}`);
    lines.push(`- **CPU Time:** ${gl.metrics.cpuMs}`);
    lines.push(`- **Peak Memory:** ${gl.metrics.peakMemory}\n`);
  }

  lines.push('## Context: Survey Proxies\n');
  const proxies = report.context?.surveyProxies?.proxies || [];
  lines.push(`> [!NOTE]\n> ${report.context?.surveyProxies?.note || 'Context only'}\n`);
  lines.push('| ID | Proxy | Share | Bias |');
  lines.push('|---|---|---|---|');
  for (const p of proxies) {
    lines.push(`| ${p.id} | ${p.name} | ${p.share} | ${p.bias} |`);
  }
  lines.push('');

  lines.push('## Sampling Rule and Biases\n');
  lines.push(`**Sampling Rule:** ${report.samplingRule}\n`);
  lines.push('**Biases:**');
  for (const b of report.biases || []) {
    lines.push(`- ${b}`);
  }
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  buildBaseline,
  renderReportMarkdown,
  sorted,
  unionIntervals,
  findIdleGaps,
};
