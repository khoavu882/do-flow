'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { buildBaseline, sorted } = require('../../src/runtime/trace/baseline.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeSnapshotFile(snapshotDir, relPath, content) {
  const fullPath = path.join(snapshotDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return {
    path: relPath,
    sha256: sha256(content),
  };
}

// 1. Pure function over a snapshot directory of recorded state
test('1. Pure function over a snapshot directory of recorded state: same snapshot twice gives deepEqual output; JSON output has sorted keys and NO wall-clock field (negative control: generatedAt fails)', (t) => {
  const snapDir = tempDir(t, 'doflow-trace-baseline-snap1-');
  const files = [];

  const ledgerContent = '{"timestamp":"2026-10-18T10:00:00Z","verb":"verify","exit_code":0,"duration_ms":1000,"arg_count":2}\n';
  files.push(writeSnapshotFile(snapDir, 'state/runs/2026-10-18.jsonl', ledgerContent));

  const manifest = {
    v: 1,
    commit: '10503e1300000000000000000000000000000000',
    node: 'v26.0.0',
    platform: 'darwin',
    harness: 'claude',
    files,
  };
  fs.writeFileSync(path.join(snapDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const spansView = {
    v: 1,
    traces: [
      {
        traceId: 'trace-1',
        runKey: 'k/r/l',
        epoch: 1,
        window: { from: '2026-10-18T10:00:00.000Z', to: '2026-10-18T10:00:10.000Z' },
        spans: [
          {
            spanId: 's1',
            parentSpanId: null,
            kind: 'run',
            name: 'start',
            start: '2026-10-18T10:00:00.000Z',
            end: '2026-10-18T10:00:10.000Z',
            durationMs: 10000,
            basis: 'recorded',
            locator: 'state/runs/2026-10-18.jsonl:1',
            attrs: {},
          },
        ],
      },
    ],
    ungrouped: [],
    gaps: [],
  };

  const report1 = buildBaseline(spansView, manifest);
  const report2 = buildBaseline(spansView, manifest);

  assert.deepEqual(report1, report2);
  assert.equal(JSON.stringify(report1), JSON.stringify(report2));

  // Verify all object keys are sorted recursively
  function verifyKeysSorted(obj) {
    if (obj && typeof obj === 'object') {
      if (!Array.isArray(obj)) {
        const keys = Object.keys(obj);
        const sortedKeys = [...keys].sort();
        assert.deepEqual(keys, sortedKeys, `Keys not sorted: ${keys.join(',')}`);
      }
      for (const val of Object.values(obj)) {
        verifyKeysSorted(val);
      }
    }
  }
  verifyKeysSorted(report1);

  // Verify NO wall-clock field exists
  function verifyNoWallClock(obj) {
    if (obj && typeof obj === 'object') {
      assert.equal(obj.generatedAt, undefined);
      assert.equal(obj.createdAt, undefined);
      assert.equal(obj.runDate, undefined);
      assert.equal(obj.now, undefined);
      for (const val of Object.values(obj)) {
        verifyNoWallClock(val);
      }
    }
  }
  verifyNoWallClock(report1);

  // Negative control: adding a generatedAt field must fail the deepEqual case
  const reportWithGeneratedAt = { ...report2, generatedAt: '2026-10-18T20:00:00.000Z' };
  assert.throws(
    () => assert.deepEqual(report1, reportWithGeneratedAt),
    /deep-equal/i,
    'Negative control: generatedAt must cause deepEqual to fail'
  );
});

// 2. Overlapping spans
test('2. Overlapping spans: a seeded overlap is counted once in the union and twice in the sum. in-run and follower checks are not counted as executions', () => {
  const spansView = {
    v: 1,
    traces: [
      {
        traceId: 'tr-overlap',
        runKey: 'key/run/1',
        epoch: 1,
        window: { from: '2026-10-18T10:00:00.000Z', to: '2026-10-18T10:00:10.000Z' },
        spans: [
          // Span 1: verify.run from 10:00:00 to 10:00:04 (4000 ms)
          {
            spanId: 'vr1',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify',
            start: '2026-10-18T10:00:00.000Z',
            end: '2026-10-18T10:00:04.000Z',
            durationMs: 4000,
            basis: 'recorded',
            locator: 'vr1',
            attrs: { verify_id: 'v1' },
          },
          // Span 2: verify.run from 10:00:02 to 10:00:06 (4000 ms), overlapping by 2000 ms
          {
            spanId: 'vr2',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify',
            start: '2026-10-18T10:00:02.000Z',
            end: '2026-10-18T10:00:06.000Z',
            durationMs: 4000,
            basis: 'recorded',
            locator: 'vr2',
            attrs: { verify_id: 'v2' },
          },
          // Check 1: executed check, 4000 ms
          {
            spanId: 'chk1',
            parentSpanId: 'vr1',
            kind: 'verify.check',
            name: 'unit',
            start: '2026-10-18T10:00:00.000Z',
            end: '2026-10-18T10:00:04.000Z',
            durationMs: 4000,
            basis: 'recorded',
            locator: 'chk1',
            attrs: { status: 'PASS', tier: 'targeted-tests' },
          },
          // Check 2: executed check, 4000 ms (overlapping with Check 1)
          {
            spanId: 'chk2',
            parentSpanId: 'vr2',
            kind: 'verify.check',
            name: 'unit',
            start: '2026-10-18T10:00:02.000Z',
            end: '2026-10-18T10:00:06.000Z',
            durationMs: 4000,
            basis: 'recorded',
            locator: 'chk2',
            attrs: { status: 'PASS', tier: 'targeted-tests' },
          },
          // Check 3: shared: "in-run" - not counted as execution
          {
            spanId: 'chk3',
            parentSpanId: 'vr2',
            kind: 'verify.check',
            name: 'unit-dedup',
            start: '2026-10-18T10:00:02.000Z',
            end: '2026-10-18T10:00:06.000Z',
            durationMs: 4000,
            basis: 'recorded',
            locator: 'chk3',
            attrs: { status: 'PASS', shared: 'in-run' },
          },
          // Check 4: shared: "follower" - not counted as execution
          {
            spanId: 'chk4',
            parentSpanId: 'vr2',
            kind: 'verify.check',
            name: 'unit-follower',
            start: '2026-10-18T10:00:02.000Z',
            end: '2026-10-18T10:00:06.000Z',
            durationMs: 4000,
            basis: 'recorded',
            locator: 'chk4',
            attrs: { status: 'PASS', shared: 'follower' },
          },
        ],
      },
    ],
  };

  const report = buildBaseline(spansView, { harness: 'claude' });
  const metrics = report.goalLoops[0].metrics;

  // Union of [10:00:00, 10:00:04] and [10:00:02, 10:00:06] is [10:00:00, 10:00:06] = 6000 ms
  assert.equal(metrics.verificationWallMs, 6000, 'Seeded overlap must be counted ONCE in the union');

  // Sum of executed checks 4000 + 4000 = 8000 ms; in-run and follower are excluded
  assert.equal(metrics.totalTestMs, 8000, 'Seeded overlap must be counted TWICE in the sum, excluding in-run and follower');
});

// 2b. 089 IC-007: a reused check read a recorded PASS and executed nothing
test('2b. A reused check is not an execution: totalTestMs, duplicates, fullSuiteRuns and cpuMs ignore it, and the cause names it', () => {
  const check = (spanId, attrs) => ({
    spanId, parentSpanId: 'vr1', kind: 'verify.check', name: 'test:all',
    start: '2026-10-18T10:00:00.000Z', end: '2026-10-18T10:00:04.000Z', durationMs: 4000,
    basis: 'recorded', locator: spanId,
    attrs: { status: 'PASS', tier: 'broad-tests', check_key: '0123456789abcdef', resource_basis: 'proc-children', cpu_ms: 500, ...attrs },
  });
  const spansView = { v: 1, traces: [{
    traceId: 'tr-reused', runKey: 'key/run/reused', epoch: 1,
    window: { from: '2026-10-18T10:00:00.000Z', to: '2026-10-18T10:00:10.000Z' },
    spans: [
      { spanId: 'vr1', parentSpanId: null, kind: 'verify.run', name: 'verify', start: '2026-10-18T10:00:00.000Z',
        end: '2026-10-18T10:00:04.000Z', durationMs: 4000, basis: 'recorded', locator: 'vr1', attrs: { verify_id: 'v1' } },
      check('executed', { shared: 'none' }),
      check('reused', { shared: 'reused', shared_ref: 'a'.repeat(32) }),
    ],
  }] };
  const report = buildBaseline(spansView, { harness: 'claude' });
  const metrics = report.goalLoops[0].metrics;
  assert.equal(metrics.totalTestMs, 4000, 'only the executed check counts');
  assert.equal(metrics.duplicates, 0, 'a reused line on the same key is not a duplicate execution');
  assert.equal(metrics.fullSuiteRuns, 1, 'a reused broad-tests check is not a full-suite run');
  assert.equal(metrics.cpuMs, 500, 'a reused check spent no cpu');
  const row = report.inputTable.find((entry) => entry.metric === 'totalTestMs');
  assert.match(row.cause, /reused/);
});

// 3. Idle gaps longer than 30 minutes are reported apart (D-8)
test('3. Idle gaps longer than 30 minutes are reported apart (D-8)', () => {
  const spansView = {
    v: 1,
    traces: [
      {
        traceId: 'tr-idle',
        runKey: 'key/run/idle',
        epoch: 1,
        window: { from: '2026-10-18T10:00:00.000Z', to: '2026-10-18T10:50:00.000Z' },
        spans: [
          // Activity 1: 10:00:00 to 10:05:00 (5 min = 300,000 ms)
          {
            spanId: 'act1',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify',
            start: '2026-10-18T10:00:00.000Z',
            end: '2026-10-18T10:05:00.000Z',
            durationMs: 300000,
            basis: 'recorded',
            locator: 'act1',
            attrs: {},
          },
          // Activity 2: 10:45:00 to 10:50:00 (5 min = 300,000 ms)
          // Gap between 10:05:00 and 10:45:00 is 40 minutes = 2,400,000 ms > 30 minutes
          {
            spanId: 'act2',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify',
            start: '2026-10-18T10:45:00.000Z',
            end: '2026-10-18T10:50:00.000Z',
            durationMs: 300000,
            basis: 'recorded',
            locator: 'act2',
            attrs: {},
          },
        ],
      },
    ],
  };

  const report = buildBaseline(spansView, { harness: 'claude' });
  const metrics = report.goalLoops[0].metrics;

  // Total loop wall = 50 min = 3,000,000 ms
  assert.equal(metrics.loopWallMs, 3000000);
  // Verification wall = 5 min + 5 min = 10 min = 600,000 ms
  assert.equal(metrics.verificationWallMs, 600000);
  // Idle gap = 40 min = 2,400,000 ms reported apart
  assert.equal(metrics.idleGapsMs, 2400000);
  assert.equal(report.goalLoops[0].idleGaps.length, 1);
  assert.equal(report.goalLoops[0].idleGaps[0].durationMs, 2400000);

  // Implementation time = loop (3,000,000) - verification (600,000) - idle gaps (2,400,000) = 0 ms
  assert.equal(metrics.implementationMs, 0);
});

// 4. Metric values and open-ended spans upper bound
test('4. Every metric has a value, a gap, or unreached; peakMemory is unreached. Open-ended spans give a separate upper bound excluded from the D-1 lower end', () => {
  const spansView = {
    v: 1,
    traces: [
      {
        traceId: 'tr-open',
        runKey: 'key/run/open',
        epoch: 1,
        window: { from: '2026-10-18T10:00:00.000Z', to: '2026-10-18T10:00:30.000Z' },
        spans: [
          // Span 1: closed verify.run from 10:00:00 to 10:00:05 (5000 ms)
          {
            spanId: 's1',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify',
            start: '2026-10-18T10:00:00.000Z',
            end: '2026-10-18T10:00:05.000Z',
            durationMs: 5000,
            basis: 'recorded',
            locator: 's1',
            attrs: {},
          },
          // Span 2: open-ended verify.run at 10:00:10 (end is null, durationMs is null)
          {
            spanId: 's2',
            parentSpanId: null,
            kind: 'verify.run',
            name: 'verify',
            start: '2026-10-18T10:00:10.000Z',
            end: null,
            durationMs: null,
            basis: 'recorded',
            locator: 's2',
            attrs: {},
          },
          // Span 3: closed span at 10:00:20 to 10:00:25 (defines upper bound of Span 2 = 10 s)
          {
            spanId: 's3',
            parentSpanId: null,
            kind: 'run',
            name: 'run',
            start: '2026-10-18T10:00:20.000Z',
            end: '2026-10-18T10:00:25.000Z',
            durationMs: 5000,
            basis: 'recorded',
            locator: 's3',
            attrs: {},
          },
        ],
      },
    ],
  };

  const report = buildBaseline(spansView, { harness: 'claude' });
  const gl = report.goalLoops[0];

  // Every metric must be present
  const requiredMetrics = [
    'loopWallMs',
    'verificationWallMs',
    'totalTestMs',
    'implementationMs',
    'ratio',
    'share',
    'duplicates',
    'fullSuiteRuns',
    'cpuMs',
    'peakMemory',
    'idleGapsMs',
  ];
  for (const m of requiredMetrics) {
    assert.ok(m in gl.metrics, `metric ${m} must be present in metrics`);
    const val = gl.metrics[m];
    assert.ok(
      typeof val === 'number' || val === 'unreached' || val === null,
      `metric ${m} must have a value, a gap, or 'unreached', got: ${val}`
    );
  }

  // peakMemory is unreached
  assert.equal(gl.metrics.peakMemory, 'unreached');

  // Lower end (D-1) excludes the open-ended span (only the 5000 ms closed span)
  assert.equal(gl.metrics.verificationWallMs, 5000);

  // Upper bound includes the open-ended span [10:00:10 to 10:00:20] = 10000 ms, so total is 15000 ms
  assert.equal(gl.upperBound.verificationWallMs, 15000);
  assert.ok(gl.upperBound.verificationWallMs > gl.metrics.verificationWallMs);
});

// 5. Window progress and "verdict not yet derivable"
test('5. When the recording window is not filled the report says "verdict not yet derivable" with progress (D-16: 0 of 5 loops, 0 of 2 harnesses style)', () => {
  // Empty snapshot
  const emptyReport = buildBaseline({ traces: [] }, {});
  assert.equal(emptyReport.verdict, 'verdict not yet derivable');
  assert.equal(emptyReport.progress, '0 of 5 loops, 0 of 2 harnesses');

  // One-loop snapshot without harness
  const oneLoopNoHarness = buildBaseline(
    {
      traces: [
        {
          traceId: 't1',
          runKey: 'k/r/1',
          spans: [],
        },
      ],
    },
    {}
  );
  assert.equal(oneLoopNoHarness.verdict, 'verdict not yet derivable');
  assert.equal(oneLoopNoHarness.progress, '1 of 5 loops, 0 of 2 harnesses');

  // One-loop snapshot with one harness
  const oneLoopClaude = buildBaseline(
    {
      traces: [
        {
          traceId: 't1',
          runKey: 'k/r/1',
          spans: [
            {
              spanId: 's1',
              attrs: { harness: 'claude' },
            },
          ],
        },
      ],
    },
    { harness: 'claude' }
  );
  assert.equal(oneLoopClaude.verdict, 'verdict not yet derivable');
  assert.equal(oneLoopClaude.progress, '1 of 5 loops, 1 of 2 harnesses');
});

// 6. Manifest check
test('6. Manifest check: a manifest sha256 mismatch exits 1 and names the path; a missing manifest exits 2 with the message', (t) => {
  const runnerPath = path.join(REPO_ROOT, 'bench', 'runner.js');

  // Case A: Missing manifest -> exits 2 with message
  const emptyDir = tempDir(t, 'doflow-trace-baseline-nomanifest-');
  const missingResult = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', emptyDir], {
    encoding: 'utf8',
  });
  assert.equal(missingResult.status, 2, 'Missing manifest must exit 2');
  assert.match(missingResult.stderr, /missing manifest/, 'Stderr must state missing manifest');

  // Case B: Sha256 mismatch -> exits 1 and names the path
  const corruptDir = tempDir(t, 'doflow-trace-baseline-corrupt-');
  const targetFile = 'state/runs/sample.jsonl';
  writeSnapshotFile(corruptDir, targetFile, 'original content\n');

  const corruptManifest = {
    v: 1,
    commit: '10503e1300000000000000000000000000000000',
    node: 'v26.0.0',
    platform: 'darwin',
    harness: 'claude',
    files: [
      {
        path: targetFile,
        sha256: '0000000000000000000000000000000000000000000000000000000000000000', // incorrect hash
      },
    ],
  };
  fs.writeFileSync(path.join(corruptDir, 'manifest.json'), JSON.stringify(corruptManifest), 'utf8');

  const corruptResult = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', corruptDir], {
    encoding: 'utf8',
  });
  assert.equal(corruptResult.status, 1, 'Manifest sha256 mismatch must exit 1');
  assert.match(corruptResult.stderr, new RegExp(targetFile), 'Stderr must name the mismatched path');
});

// 7. npm run bench -- verify-baseline entry and byte-equal output files
test('7. npm run bench -- verify-baseline --snapshot <dir> --json --out <dir> is the entry in bench/runner.js (bare invocation usage lists it; two runs give byte-equal output files)', (t) => {
  const runnerPath = path.join(REPO_ROOT, 'bench', 'runner.js');

  // Check bare invocation usage text lists verify-baseline
  const usageResult = spawnSync(process.execPath, [runnerPath], { encoding: 'utf8' });
  assert.equal(usageResult.status, 2);
  assert.match(usageResult.stdout, /verify-baseline --snapshot <dir> \[--json\] \[--out <dir>\]/);

  // Set up a valid snapshot
  const snapDir = tempDir(t, 'doflow-trace-baseline-full-');
  const files = [];

  const ledger = '{"timestamp":"2026-10-18T10:00:00Z","verb":"verify","exit_code":0,"duration_ms":2000,"arg_count":2}\n';
  files.push(writeSnapshotFile(snapDir, 'state/runs/2026-10-18.jsonl', ledger));

  const manifest = {
    v: 1,
    commit: '10503e1300000000000000000000000000000000',
    node: 'v26.0.0',
    platform: 'darwin',
    harness: 'claude',
    files,
  };
  fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

  const out1 = tempDir(t, 'doflow-trace-baseline-out1-');
  const out2 = tempDir(t, 'doflow-trace-baseline-out2-');

  const run1 = spawnSync(
    process.execPath,
    [runnerPath, 'verify-baseline', '--snapshot', snapDir, '--json', '--out', out1],
    { encoding: 'utf8' }
  );
  assert.equal(run1.status, 0, `Run 1 failed: ${run1.stderr}`);

  const run2 = spawnSync(
    process.execPath,
    [runnerPath, 'verify-baseline', '--snapshot', snapDir, '--json', '--out', out2],
    { encoding: 'utf8' }
  );
  assert.equal(run2.status, 0, `Run 2 failed: ${run2.stderr}`);

  // Test byte-equality with Buffer.equals
  const json1 = fs.readFileSync(path.join(out1, 'report.json'));
  const json2 = fs.readFileSync(path.join(out2, 'report.json'));
  assert.ok(Buffer.isBuffer(json1) && Buffer.isBuffer(json2));
  assert.ok(json1.equals(json2), 'report.json must be byte-equal between two runs');

  const md1 = fs.readFileSync(path.join(out1, 'report.md'));
  const md2 = fs.readFileSync(path.join(out2, 'report.md'));
  assert.ok(Buffer.isBuffer(md1) && Buffer.isBuffer(md2));
  assert.ok(md1.equals(md2), 'report.md must be byte-equal between two runs');
});

// 8. Value assertions on the committed snapshot (088 F6, D5)
test('8. Value assertions on the committed snapshot: fullSuiteRuns 2, duplicates 0, totalTestMs 775, verificationWallMs 1102, loopWallMs 23665', (t) => {
  const runnerPath = path.join(REPO_ROOT, 'bench', 'runner.js');
  const baselineDir = path.join(REPO_ROOT, 'test', 'fixtures', '088-verification-baseline');
  const res = spawnSync(
    process.execPath,
    [runnerPath, 'verify-baseline', '--snapshot', baselineDir, '--json'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, `verify-baseline failed on committed baseline: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  const metrics = report.goalLoops[0].metrics;

  assert.equal(metrics.fullSuiteRuns, 2, 'fullSuiteRuns must be 2');
  assert.equal(metrics.duplicates, 0, 'duplicates must be 0');
  assert.equal(metrics.exactDuplicates, 0, 'exactDuplicates must be 0');
  assert.equal(metrics.candidateDuplicates, 0, 'candidateDuplicates must be 0');
  assert.equal(metrics.totalTestMs, 775, 'totalTestMs must be 775');
  assert.equal(metrics.verificationWallMs, 1102, 'verificationWallMs must be 1102');
  assert.equal(metrics.loopWallMs, 23665, 'loopWallMs must be 23665');
  assert.equal(metrics.ratio, 0.0466, 'ratio must be 0.0466');
  assert.equal(metrics.share, 0.0466, 'share must be 0.0466');
});

// 9. When window is not filled: report.md contains no Median or Lower End, shows Observed (n=1), and open (unbounded) for open window
test('9. While recording window is not filled: no Median or Lower End in report.md, shows "Observed (n=1), not a result", and open window prints "open (unbounded)"', (t) => {
  const runnerPath = path.join(REPO_ROOT, 'bench', 'runner.js');
  const baselineDir = path.join(REPO_ROOT, 'test', 'fixtures', '088-verification-baseline');
  const res = spawnSync(
    process.execPath,
    [runnerPath, 'verify-baseline', '--snapshot', baselineDir],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, `verify-baseline failed: ${res.stderr}`);
  const md = res.stdout;

  assert.ok(!md.includes('Median'), 'report.md must have no Median when window is not filled');
  assert.ok(!md.includes('Lower End'), 'report.md must have no Lower End when window is not filled');
  assert.ok(!md.includes('Range'), 'report.md must have no Range when window is not filled');
  assert.match(md, /## Observed \(n=1\), not a result/, 'report.md must show Observed (n=1), not a result');
  assert.match(md, /upper bound: open \(unbounded\)/, 'open window must print open (unbounded)');
  assert.match(md, /- \*\*Verification Ratio:\*\* 0\.0466/, 'ratio must be formatted to 3 sig figs');

  // Negative control: when window is filled (5 loops, 2 harnesses), report.md DOES contain Median and Lower End
  const { renderReportMarkdown } = require('../../src/runtime/trace/baseline.ts');
  const filledReport = {
    verdict: 'material',
    progress: '5 of 5 loops, 2 of 2 harnesses',
    inputTable: [],
    aggregate: {
      metrics: {
        ratio: { median: 0.25, range: [0.2, 0.3], lower: 0.2, upper: 0.3, basis: 'derived' },
      },
    },
    goalLoops: [],
  };
  const filledMd = renderReportMarkdown(filledReport);
  assert.ok(filledMd.includes('Median'), 'Negative control: filled window report must include Median');
  assert.ok(filledMd.includes('Lower End'), 'Negative control: filled window report must include Lower End');
});

// 10. D7 manifest hardening: runner rejects missing/non-array files, unlisted files, outside paths, symlinks, bad schema
test('10. D7 manifest hardening: verify-baseline rejects no files, object files, missing path, escaping path, symlink, unlisted file, v!=1, missing commit', (t) => {
  const runnerPath = path.join(REPO_ROOT, 'bench', 'runner.js');
  const baselineDir = path.join(REPO_ROOT, 'test', 'fixtures', '088-verification-baseline');

  function makeVariant(name, modifier) {
    const dir = tempDir(t, `doflow-d7-${name}-`);
    // Copy state and manifest from committed baseline
    fs.cpSync(path.join(baselineDir, 'snapshot', 'state'), path.join(dir, 'state'), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(baselineDir, 'manifest.json'), 'utf8'));
    modifier(dir, manifest);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return dir;
  }

  // Case 1: no files key -> exits 2
  const noFilesDir = makeVariant('nofiles', (dir, m) => { delete m.files; });
  const r1 = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', noFilesDir], { encoding: 'utf8' });
  assert.equal(r1.status, 2, 'Missing files key must exit 2');
  assert.match(r1.stderr, /manifest files must be an array/);

  // Case 2: files is an object -> exits 2
  const filesObjDir = makeVariant('filesobj', (dir, m) => { m.files = {}; });
  const r2 = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', filesObjDir], { encoding: 'utf8' });
  assert.equal(r2.status, 2, 'files as object must exit 2');
  assert.match(r2.stderr, /manifest files must be an array/);

  // Case 3: entry with no path -> exits 2
  const badPathDir = makeVariant('badpath', (dir, m) => { m.files.push({ sha256: 'deadbeef' }); });
  const r3 = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', badPathDir], { encoding: 'utf8' });
  assert.equal(r3.status, 2, 'Entry without path must exit 2');
  assert.match(r3.stderr, /manifest file entry missing path/);

  // Case 4: path escapes snapshot directory -> exits 2
  const escapeDir = makeVariant('escape', (dir, m) => {
    m.files.push({ path: '../outside.txt', sha256: 'deadbeef' });
  });
  const r4 = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', escapeDir], { encoding: 'utf8' });
  assert.equal(r4.status, 2, 'Escaping path must exit 2');
  assert.match(r4.stderr, /path escapes snapshot directory/);

  // Case 5: symlink in snapshot state -> exits 2
  const symlinkDir = makeVariant('symlink', (dir, m) => {
    const target = path.join(dir, 'state', 'runs', 'telemetry', '2026-10-18.jsonl');
    const outside = path.join(dir, 'outside_target.jsonl');
    fs.renameSync(target, outside);
    fs.symlinkSync(outside, target);
  });
  const r5 = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', symlinkDir], { encoding: 'utf8' });
  assert.equal(r5.status, 2, 'Symlink in snapshot state must exit 2');
  assert.match(r5.stderr, /symlink not permitted in snapshot/);

  // Case 6: unlisted regular file under state/ -> exits 2
  const extraDir = makeVariant('extra', (dir, m) => {
    fs.writeFileSync(path.join(dir, 'state', 'runs', 'telemetry', '2026-10-19.jsonl'), '{"extra":1}\n', 'utf8');
  });
  const r6 = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', extraDir], { encoding: 'utf8' });
  assert.equal(r6.status, 2, 'Unlisted file under state/ must exit 2');
  assert.match(r6.stderr, /unlisted file in snapshot state/);

  // Case 7: v !== 1 -> exits 2
  const badVDir = makeVariant('badv', (dir, m) => { m.v = 99; });
  const r7 = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', badVDir], { encoding: 'utf8' });
  assert.equal(r7.status, 2, 'v != 1 must exit 2');
  assert.match(r7.stderr, /manifest version must be 1/);

  // Case 8: missing commit -> exits 2
  const noCommitDir = makeVariant('nocommit', (dir, m) => { delete m.commit; });
  const r8 = spawnSync(process.execPath, [runnerPath, 'verify-baseline', '--snapshot', noCommitDir], { encoding: 'utf8' });
  assert.equal(r8.status, 2, 'Missing commit must exit 2');
  assert.match(r8.stderr, /manifest commit is required/);
});

