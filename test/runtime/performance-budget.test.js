'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ContextPackCompiler } = require('../../src/runtime/context-pack.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUDGETS_PATH = path.join(REPO_ROOT, 'bench/perf/budgets.json');

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
  if (values.length === 0) return 0;
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

    // 1 warm-up
    measureExecution(cmd, args, execOptions);

    // 5 samples
    const samples = [];
    const results = [];
    for (let i = 0; i < 5; i++) {
      const res = measureExecution(cmd, args, execOptions);
      samples.push(res.ms);
      results.push(res);
    }

    const medianMs = median(samples);
    if (t && typeof t.diagnostic === 'function') {
      t.diagnostic(`surface ${surface.id}: median ${medianMs.toFixed(2)} ms / ceiling ${ceilingMs} ms`);
    }

    const nonZero = results.find((r) => r.status !== 0);
    if (nonZero) {
      const freshControl = measureControlMedian();
      const rowControl = row && row.controlP50Ms != null ? `${row.controlP50Ms} ms` : 'n/a';
      const detail = [
        `surface ${surface.id} failed with exit status ${nonZero.status}`,
        `stderr: ${nonZero.stderr}`,
        `samples: [${samples.map((s) => s.toFixed(2)).join(', ')}] ms`,
        `median: ${medianMs.toFixed(2)} ms`,
        `ceiling: ${ceilingMs} ms`,
        `source: ${ceilingSource}`,
        `fresh control median: ${freshControl.toFixed(2)} ms`,
        `row controlP50Ms: ${rowControl}`,
      ].join('\n');
      assert.equal(nonZero.status, 0, detail);
    }

    if (medianMs > ceilingMs) {
      const freshControl = measureControlMedian();
      const rowControl = row && row.controlP50Ms != null ? `${row.controlP50Ms} ms` : 'n/a';
      const detail = [
        `surface ${surface.id} median latency exceeded ceiling`,
        `samples: [${samples.map((s) => s.toFixed(2)).join(', ')}] ms`,
        `median: ${medianMs.toFixed(2)} ms`,
        `ceiling: ${ceilingMs} ms`,
        `source: ${ceilingSource}`,
        `fresh control median: ${freshControl.toFixed(2)} ms`,
        `row controlP50Ms: ${rowControl}`,
      ].join('\n');
      assert.ok(medianMs <= ceilingMs, detail);
    } else {
      assert.ok(medianMs <= ceilingMs);
    }
  });
}
