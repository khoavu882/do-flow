'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ContextPackCompiler } = require('../../src/runtime/context-pack.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUDGETS_PATH = path.join(REPO_ROOT, 'bench/perf/budgets.json');
const LOAD_GATE_FACTOR = 1.5;

/**
 * Runs a command and measures wall time in milliseconds using hrtime.
 * @param {string} cmd
 * @param {string[]} args
 * @param {Object} [options]
 * @returns {{ ms: number, status: number, stdout: string, stderr: string }}
 */
function measureExecution(cmd, args, options = {}) {
  const start = process.hrtime.bigint();
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DOFLOW_QUIET: '1' },
    ...options,
  });
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;
  return { ms, status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function measureControlMedian() {
  const controlSamples = [];
  for (let i = 0; i < 5; i++) {
    const res = measureExecution(process.execPath, ['-e', '0']);
    controlSamples.push(res.ms);
  }
  return median(controlSamples);
}

/**
 * Decides whether a round's latency can be judged based on paired control median.
 * If controlP50Ms is not provided (e.g. intent fallback), there is no load gate (judged = true).
 * Otherwise, if median(pairedControls) > factor * controlP50Ms, the machine was under load (judged = false).
 * @param {number[]|{ pairedControls: number[] }} pairedControls
 * @param {number|null} controlP50Ms
 * @param {number} [factor=LOAD_GATE_FACTOR]
 * @returns {boolean}
 */
function isRoundJudged(pairedControls, controlP50Ms, factor = LOAD_GATE_FACTOR) {
  if (controlP50Ms == null) {
    return true;
  }
  const controls = Array.isArray(pairedControls)
    ? pairedControls
    : (pairedControls && Array.isArray(pairedControls.pairedControls) ? pairedControls.pairedControls : []);
  if (controls.length === 0) {
    return true;
  }
  const ctrlMedian = median(controls);
  return ctrlMedian <= factor * controlP50Ms;
}

function formatLoadGateDiagnostic(controlMedian, rowControlP50Ms, factor = LOAD_GATE_FACTOR) {
  const x = typeof controlMedian === 'number' ? controlMedian.toFixed(2) : (controlMedian ?? 'n/a');
  const y = typeof rowControlP50Ms === 'number'
    ? (Number.isInteger(rowControlP50Ms) ? String(rowControlP50Ms) : rowControlP50Ms.toFixed(2))
    : (rowControlP50Ms ?? 'n/a');
  return `machine under load: control median ${x} ms vs row ${y} ms (factor ${factor}); latency not judged — run npm run bench -- perf measure on a quiet machine`;
}

/**
 * Normalises a sample latency by paired control against baseline row control.
 * Formula: sample * min(1, controlP50Ms / pairedControl).
 * If controlP50Ms is not provided (e.g. intent fallback), no normalisation is applied.
 * Normalisation only scales down, never up.
 */
function normaliseSample(sample, pairedControl, controlP50Ms) {
  if (controlP50Ms == null || pairedControl == null || pairedControl <= 0) {
    return sample;
  }
  const factor = Math.min(1, controlP50Ms / pairedControl);
  return sample * factor;
}

function normaliseSamples(samples, pairedControls, controlP50Ms) {
  if (!Array.isArray(samples)) return [];
  return samples.map((s, i) => normaliseSample(s, pairedControls?.[i], controlP50Ms));
}

function evaluateRound(samples, pairedControls, controlP50Ms) {
  const rawMedian = median(samples);
  const controlMedian = pairedControls && pairedControls.length > 0 ? median(pairedControls) : null;
  const normalisedSamples = normaliseSamples(samples, pairedControls, controlP50Ms);
  const normalisedMedian = median(normalisedSamples);
  const judged = isRoundJudged(pairedControls, controlP50Ms);
  return {
    samples,
    pairedControls,
    normalisedSamples,
    rawMedian,
    controlMedian,
    normalisedMedian,
    judged,
    controlP50Ms,
  };
}

/**
 * Decides whether the performance budget test passes.
 * If round 1 is not judged or its normalised median > ceilingMs, a second round can be run.
 * If neither round is judged, skips with the AM9 load gate diagnostic.
 * Any judged round(s) decide per AM8 (lower normalised median among judged rounds).
 */
function decideVerdict(round1, round2OrFn, ceilingMs, controlP50Ms) {
  const rowControl = controlP50Ms ?? round1?.controlP50Ms ?? null;
  const round1Judged = round1?.judged !== undefined
    ? round1.judged
    : isRoundJudged(round1?.pairedControls, rowControl);

  let round2 = null;
  const needRound2 = !round1Judged || (round1 && round1.normalisedMedian > ceilingMs);
  if (needRound2) {
    if (typeof round2OrFn === 'function') {
      round2 = round2OrFn();
    } else {
      round2 = round2OrFn || null;
    }
  } else if (round2OrFn && typeof round2OrFn !== 'function') {
    round2 = round2OrFn;
  }

  const round2Judged = round2
    ? (round2.judged !== undefined
        ? round2.judged
        : isRoundJudged(round2.pairedControls, rowControl ?? round2.controlP50Ms))
    : false;

  const judgedRounds = [];
  if (round1Judged && round1) judgedRounds.push(round1);
  if (round2Judged && round2) judgedRounds.push(round2);

  if (judgedRounds.length === 0) {
    const ctrlMedian = round2?.controlMedian != null
      ? round2.controlMedian
      : (round1?.controlMedian != null ? round1.controlMedian : null);
    const skipMessage = formatLoadGateDiagnostic(ctrlMedian, rowControl, LOAD_GATE_FACTOR);
    return {
      pass: false,
      skip: true,
      skipMessage,
      message: skipMessage,
      round1,
      round2,
      decidingMedian: null,
      ceilingMs,
      loadGateFactor: LOAD_GATE_FACTOR,
    };
  }

  const decidingMedian = judgedRounds.length === 2
    ? Math.min(round1.normalisedMedian, round2.normalisedMedian)
    : judgedRounds[0].normalisedMedian;
  const pass = decidingMedian <= ceilingMs;

  return {
    pass,
    skip: false,
    round1,
    round2,
    decidingMedian,
    ceilingMs,
  };
}

function collectPairedSamples(cmd, args, execOptions) {
  const samples = [];
  const pairedControls = [];
  const results = [];
  const controlResults = [];
  for (let i = 0; i < 5; i++) {
    const ctrl = measureExecution(process.execPath, ['-e', '0']);
    const res = measureExecution(cmd, args, execOptions);
    pairedControls.push(ctrl.ms);
    samples.push(res.ms);
    controlResults.push(ctrl);
    results.push(res);
  }
  return { samples, pairedControls, results, controlResults };
}

function pickApprovedRow(budgets, surfaceId) {
  const matchingRows = (budgets.rows || []).filter(
    (r) =>
      r.surfaceId === surfaceId &&
      r.status === 'approved' &&
      r.platform === process.platform &&
      r.arch === process.arch &&
      !r.unmeasured
  );
  if (matchingRows.length === 0) return null;
  if (matchingRows.length === 1) return matchingRows[0];
  matchingRows.sort((a, b) => (a.measuredOn || '').localeCompare(b.measuredOn || ''));
  return matchingRows[matchingRows.length - 1];
}

test('performance-budget: in-process compileBoundedContextPack executes in under 5 ms', () => {
  const compiler = new ContextPackCompiler();
  const start = process.hrtime.bigint();
  const res = compiler.compileBoundedContextPack({
    taskId: 'perf-task',
    taskClass: 'feature',
    maxBytes: 10000,
    objective: 'Benchmark context pack compiler',
    mandatory: {
      acceptanceCriteria: ['AC-01', 'AC-02'],
      constraints: ['C-01'],
      verificationPlan: 'Run performance suite',
    },
    optional: {
      hypotheses: ['H-01'],
      narrative: ['N-01'],
    },
  });
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;

  assert.equal(res.overflow, false);
  assert.ok(ms < 5, `expected in-process compilation < 5 ms, got ${ms.toFixed(2)} ms`);
});

// Unit tests for AM8 load-normalisation and verdict (no timing)
test('performance-budget AM8 unit (i): control equal to row control leaves samples unchanged', () => {
  const rowControl = 25;
  const pairedControls = [25, 25, 25, 25, 25];
  const samples = [80, 85, 90, 95, 100];
  const normalised = normaliseSamples(samples, pairedControls, rowControl);
  assert.deepEqual(normalised, samples);
  assert.equal(normaliseSample(90, 25, rowControl), 90);
});

test('performance-budget AM8 unit (ii): control at 2x row control halves samples', () => {
  const rowControl = 25;
  const pairedControls = [50, 50, 50, 50, 50];
  const samples = [80, 90, 100, 110, 120];
  const normalised = normaliseSamples(samples, pairedControls, rowControl);
  assert.deepEqual(normalised, [40, 45, 50, 55, 60]);
  assert.equal(normaliseSample(100, 50, rowControl), 50);
});

test('performance-budget AM8 unit (iii): control faster than row control never scales a sample up', () => {
  const rowControl = 25;
  const pairedControls = [10, 12.5, 15, 20, 5];
  const samples = [80, 85, 90, 95, 100];
  const normalised = normaliseSamples(samples, pairedControls, rowControl);
  assert.deepEqual(normalised, samples);
  assert.equal(normaliseSample(100, 10, rowControl), 100);
});

test('performance-budget AM8 unit (iv): synthetic regression (samples 2x ceiling, controls equal to row control) fails', () => {
  const ceiling = 100;
  const rowControl = 25;
  const pairedControls = [25, 25, 25, 25, 25];
  const samples = [200, 200, 200, 200, 200];
  const round1 = evaluateRound(samples, pairedControls, rowControl);
  const verdict = decideVerdict(round1, null, ceiling);
  assert.equal(verdict.pass, false);

  const round2 = evaluateRound(samples, pairedControls, rowControl);
  const verdictWithRound2 = decideVerdict(round1, round2, ceiling);
  assert.equal(verdictWithRound2.pass, false);
});

test('performance-budget AM8 unit (v): second round passes verdict only when its own normalised median is at or below ceiling', () => {
  const ceiling = 100;
  const rowControl = 25;
  const pairedControls = [25, 25, 25, 25, 25];
  const failingSamples = [140, 145, 150, 155, 160];
  const round1 = evaluateRound(failingSamples, pairedControls, rowControl);

  // Passing second round: normalised median 90 <= ceiling 100
  const passingSamples = [80, 85, 90, 95, 98];
  const round2Passing = evaluateRound(passingSamples, pairedControls, rowControl);
  const verdictPass = decideVerdict(round1, round2Passing, ceiling);
  assert.equal(verdictPass.pass, true);
  assert.equal(verdictPass.decidingMedian, round2Passing.normalisedMedian);

  // Failing second round: normalised median 120 > ceiling 100
  const failingSamples2 = [110, 115, 120, 125, 130];
  const round2Failing = evaluateRound(failingSamples2, pairedControls, rowControl);
  const verdictFail = decideVerdict(round1, round2Failing, ceiling);
  assert.equal(verdictFail.pass, false);
  assert.equal(verdictFail.decidingMedian, round2Failing.normalisedMedian);
});

test('performance-budget AM8 unit: intent fallback applies no normalisation', () => {
  const pairedControls = [50, 50, 50, 50, 50];
  const samples = [80, 90, 100, 110, 120];
  const normalised = normaliseSamples(samples, pairedControls, undefined);
  assert.deepEqual(normalised, samples);
  assert.equal(normaliseSample(100, 50, null), 100);
});

// Unit tests for AM9 load gate and verdict (no timing)
test('performance-budget AM9 unit (vi): controls at 1.7x row -> not judged', () => {
  const rowControl = 25;
  const pairedControls = [42.5, 42.5, 42.5, 42.5, 42.5];
  assert.equal(isRoundJudged(pairedControls, rowControl), false);
});

test('performance-budget AM9 unit (vii): controls at 1.2x row -> judged', () => {
  const rowControl = 25;
  const pairedControls = [30, 30, 30, 30, 30];
  assert.equal(isRoundJudged(pairedControls, rowControl), true);
});

test('performance-budget AM9 unit (viii): no row control -> judged', () => {
  const pairedControls = [50, 50, 50, 50, 50];
  assert.equal(isRoundJudged(pairedControls, null), true);
  assert.equal(isRoundJudged(pairedControls, undefined), true);
});

test('performance-budget AM9 unit (ix): round 1 not judged and round 2 judged -> round 2 alone decides', () => {
  const ceiling = 100;
  const rowControl = 25;
  const notJudgedControls = [42.5, 42.5, 42.5, 42.5, 42.5]; // 1.7x row -> not judged
  const judgedControls = [25, 25, 25, 25, 25]; // 1.0x row -> judged

  // Case A: round 1 has failing samples, round 2 has passing samples -> pass
  const failingSamples = [150, 150, 150, 150, 150];
  const passingSamples = [80, 80, 80, 80, 80];
  const round1Failing = evaluateRound(failingSamples, notJudgedControls, rowControl);
  const round2Passing = evaluateRound(passingSamples, judgedControls, rowControl);
  const verdictPass = decideVerdict(round1Failing, round2Passing, ceiling);
  assert.equal(verdictPass.pass, true);
  assert.equal(verdictPass.skip, false);
  assert.equal(verdictPass.decidingMedian, round2Passing.normalisedMedian);

  // Case B: round 1 has passing samples, round 2 has failing samples -> fail
  const round1Passing = evaluateRound(passingSamples, notJudgedControls, rowControl);
  const round2Failing = evaluateRound(failingSamples, judgedControls, rowControl);
  const verdictFail = decideVerdict(round1Passing, round2Failing, ceiling);
  assert.equal(verdictFail.pass, false);
  assert.equal(verdictFail.skip, false);
  assert.equal(verdictFail.decidingMedian, round2Failing.normalisedMedian);
});

test('performance-budget AM9 unit (x): both not judged -> skip outcome carrying the factor in its message', () => {
  const ceiling = 100;
  const rowControl = 25;
  const notJudgedControls1 = [42.5, 42.5, 42.5, 42.5, 42.5]; // 1.7x row
  const notJudgedControls2 = [45, 45, 45, 45, 45]; // 1.8x row
  const samples = [80, 85, 90, 95, 100];
  const round1 = evaluateRound(samples, notJudgedControls1, rowControl);
  const round2 = evaluateRound(samples, notJudgedControls2, rowControl);
  const verdict = decideVerdict(round1, round2, ceiling);
  assert.equal(verdict.skip, true);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.skipMessage.includes(String(LOAD_GATE_FACTOR)), 'skip message must carry LOAD_GATE_FACTOR');
  assert.match(
    verdict.skipMessage,
    /^machine under load: control median .+ ms vs row .+ ms \(factor 1\.5\); latency not judged — run npm run bench -- perf measure on a quiet machine$/
  );
});

const budgets = JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8'));
const enforcedSurfaces = (budgets.surfaces || []).filter((s) => s.enforced);

for (const surface of enforcedSurfaces) {
  test(`performance-budget: surface ${surface.id} executes within latency ceiling`, (t) => {
    const row = pickApprovedRow(budgets, surface.id);
    let ceilingMs;
    let ceilingSource;
    if (row) {
      ceilingMs = row.ceilingMs;
      ceilingSource = `approved row (${row.platform}/${row.arch}, measuredOn: ${row.measuredOn})`;
    } else {
      ceilingMs = budgets.intentBudgetsMs?.[surface.intentClass];
      ceilingSource = `intent budget (${surface.intentClass})`;
      const diagnosticMsg = `no approved row for ${process.platform}/${process.arch}; using intent budget`;
      if (t && typeof t.diagnostic === 'function') {
        t.diagnostic(diagnosticMsg);
      }
    }

    assert.ok(
      typeof ceilingMs === 'number' && Number.isFinite(ceilingMs),
      `latency ceiling must be defined for surface ${surface.id}`
    );

    let input;
    if (surface.stdinFixture) {
      const fixturePath = path.isAbsolute(surface.stdinFixture)
        ? surface.stdinFixture
        : path.join(REPO_ROOT, surface.stdinFixture);
      input = fs.readFileSync(fixturePath, 'utf8');
    }

    const cmd = surface.argv[0] === 'node' ? process.execPath : surface.argv[0];
    const args = surface.argv.slice(1);
    const execOptions = input !== undefined ? { input } : {};

    // Round 1: 1 warm-up
    measureExecution(cmd, args, execOptions);

    // Round 1: 5 paired samples
    const r1Data = collectPairedSamples(cmd, args, execOptions);
    const nonZero1 = r1Data.results.find((r) => r.status !== 0);
    if (nonZero1) {
      const freshControl = measureControlMedian();
      const rowControl = row && row.controlP50Ms != null ? `${row.controlP50Ms} ms` : 'n/a';
      const detail = [
        `surface ${surface.id} failed with exit status ${nonZero1.status}`,
        `stderr: ${nonZero1.stderr}`,
        `samples: [${r1Data.samples.map((s) => s.toFixed(2)).join(', ')}] ms`,
        `paired controls: [${r1Data.pairedControls.map((c) => c.toFixed(2)).join(', ')}] ms`,
        `ceiling: ${ceilingMs} ms`,
        `source: ${ceilingSource}`,
        `fresh control median: ${freshControl.toFixed(2)} ms`,
        `row controlP50Ms: ${rowControl}`,
      ].join('\n');
      assert.equal(nonZero1.status, 0, detail);
    }

    const round1 = evaluateRound(r1Data.samples, r1Data.pairedControls, row?.controlP50Ms);

    let round2 = null;
    if (!round1.judged || round1.normalisedMedian > ceilingMs) {
      // Round 2: 1 warm-up
      measureExecution(cmd, args, execOptions);
      // Round 2: 5 paired samples
      const r2Data = collectPairedSamples(cmd, args, execOptions);
      const nonZero2 = r2Data.results.find((r) => r.status !== 0);
      if (nonZero2) {
        const freshControl = measureControlMedian();
        const rowControl = row && row.controlP50Ms != null ? `${row.controlP50Ms} ms` : 'n/a';
        const detail = [
          `surface ${surface.id} round 2 failed with exit status ${nonZero2.status}`,
          `stderr: ${nonZero2.stderr}`,
          `samples: [${r2Data.samples.map((s) => s.toFixed(2)).join(', ')}] ms`,
          `paired controls: [${r2Data.pairedControls.map((c) => c.toFixed(2)).join(', ')}] ms`,
          `ceiling: ${ceilingMs} ms`,
          `source: ${ceilingSource}`,
          `fresh control median: ${freshControl.toFixed(2)} ms`,
          `row controlP50Ms: ${rowControl}`,
        ].join('\n');
        assert.equal(nonZero2.status, 0, detail);
      }
      round2 = evaluateRound(r2Data.samples, r2Data.pairedControls, row?.controlP50Ms);
    }

    const verdict = decideVerdict(round1, round2, ceilingMs, row?.controlP50Ms);

    if (verdict.skip) {
      if (t && typeof t.skip === 'function') {
        t.skip(verdict.skipMessage);
        return;
      }
    }

    if (t && typeof t.diagnostic === 'function') {
      const r1JudgeStr = round1.judged ? 'judged' : 'not judged';
      const r2Msg = round2
        ? ` (round 2 raw median ${round2.rawMedian.toFixed(2)} ms, normalised ${round2.normalisedMedian.toFixed(2)} ms [${round2.judged ? 'judged' : 'not judged'}])`
        : '';
      t.diagnostic(
        `surface ${surface.id}: raw median ${round1.rawMedian.toFixed(2)} ms / normalised median ${round1.normalisedMedian.toFixed(2)} ms [${r1JudgeStr}] / ceiling ${ceilingMs} ms${r2Msg}`
      );
    }

    if (!verdict.pass) {
      const freshControl = measureControlMedian();
      const rowControl = row && row.controlP50Ms != null ? `${row.controlP50Ms} ms` : 'n/a';
      const detailLines = [
        `surface ${surface.id} normalised latency exceeded ceiling`,
        `ceiling: ${ceilingMs} ms`,
        `source: ${ceilingSource}`,
        `row controlP50Ms: ${rowControl}`,
        `deciding median: ${verdict.decidingMedian.toFixed(2)} ms`,
        `round 1 raw samples: [${round1.samples.map((s) => s.toFixed(2)).join(', ')}] ms`,
        `round 1 paired controls: [${round1.pairedControls.map((c) => c.toFixed(2)).join(', ')}] ms`,
        `round 1 normalised samples: [${round1.normalisedSamples.map((s) => s.toFixed(2)).join(', ')}] ms`,
        `round 1 raw median: ${round1.rawMedian.toFixed(2)} ms`,
        `round 1 normalised median: ${round1.normalisedMedian.toFixed(2)} ms`,
        `round 1 judged: ${round1.judged}`,
      ];
      if (round2) {
        detailLines.push(
          `round 2 raw samples: [${round2.samples.map((s) => s.toFixed(2)).join(', ')}] ms`,
          `round 2 paired controls: [${round2.pairedControls.map((c) => c.toFixed(2)).join(', ')}] ms`,
          `round 2 normalised samples: [${round2.normalisedSamples.map((s) => s.toFixed(2)).join(', ')}] ms`,
          `round 2 raw median: ${round2.rawMedian.toFixed(2)} ms`,
          `round 2 normalised median: ${round2.normalisedMedian.toFixed(2)} ms`,
          `round 2 judged: ${round2.judged}`
        );
      }
      detailLines.push(
        `both medians: round 1 normalised ${round1.normalisedMedian.toFixed(2)} ms, round 2 normalised ${round2 ? round2.normalisedMedian.toFixed(2) + ' ms' : 'not run'}`,
        `fresh control median: ${freshControl.toFixed(2)} ms`
      );
      assert.ok(verdict.pass, detailLines.join('\n'));
    } else {
      assert.ok(verdict.pass);
    }
  });
}

module.exports = {
  LOAD_GATE_FACTOR,
  isRoundJudged,
  isJudged: isRoundJudged,
  formatLoadGateDiagnostic,
  normaliseSample,
  normaliseSamples,
  evaluateRound,
  decideVerdict,
  collectPairedSamples,
  median,
  pickApprovedRow,
};
