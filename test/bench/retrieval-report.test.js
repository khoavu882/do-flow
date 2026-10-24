'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const report = require('../../bench/retrieval/lib/report.ts');
const metrics = require('../../bench/retrieval/lib/metrics.ts');

const scored = (m, extra = {}) => ({ scored: { metrics: { payloadBytes: 40, tokensEst: 10, ...m }, na: {} }, result: 'RETRIEVED', ...extra });
const CTX = { corpus: 'code', config: 'A', cls: 'conceptual-discovery', seed: 20261012 };

test('machineId is 12 hex characters of the host fingerprint hash', () => {
  const id = report.machineId({ hostname: 'h', cpus: [{ model: 'M1' }, { model: 'M1' }], totalmem: 16 });
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(id, report.sha256Hex('h|M1|2|16').slice(0, 12));
  assert.notEqual(id, report.machineId({ hostname: 'other', cpus: [{ model: 'M1' }, { model: 'M1' }], totalmem: 16 }));
  assert.match(report.machineId(), /^[0-9a-f]{12}$/);
});

test('classResult macro-aggregates with n and a deterministic bootstrap interval', () => {
  const tasks = Array.from({ length: 10 }, (_, i) => scored({ recallAt10: i < 7 ? 1 : 0, locatorValidity: i === 0 ? null : 1, falseAbsence: i === 9 ? 1 : 0, statusMatch: 1 }));
  const r = report.classResult({ ...CTX, tasks, latencyMs: [10, 20, 30, 40, 50] });
  assert.deepEqual(Object.keys(r), ['applicable', 'n', 'underpowered', 'state', 'metrics', 'latency', 'context']);
  assert.equal(r.n, 10);
  assert.equal(r.underpowered, false);
  assert.equal(r.state, 'measured');
  assert.equal(r.metrics.recallAt10.value, 0.7);
  assert.equal(r.metrics.recallAt10.n, 10);
  assert.equal(r.metrics.recallAt10.ci95.length, 2);
  assert.deepEqual(r.metrics.recallAt10.ci95, report.classResult({ ...CTX, tasks, latencyMs: [] }).metrics.recallAt10.ci95, 'same seed, same interval');
  assert.equal(r.metrics.locatorValidity.n, 9, 'a null value is skipped, not counted');
  assert.deepEqual(r.metrics.falseAbsence, { value: 0.1, ci95: null, n: 10, count: 1 });
  assert.ok(!('payloadBytes' in r.metrics) && !('tokensEst' in r.metrics), 'size metrics live in context');
  assert.deepEqual(r.latency, { runs: 5, p50Ms: 30, p95Ms: 50, maxMs: 50 });
  assert.deepEqual(r.context, { payloadBytesP50: 40, payloadBytesP95: 40, tokensEstP50: 10, tokensBasis: 'estimated:bytes/4' });
});

test('a class below its minimum n reads underpowered; compressedBytes appears in context only when measured', () => {
  const tasks = [scored({ recallAt10: 1, compressedBytes: 12 }), scored({ recallAt10: 0, compressedBytes: 20 })];
  const r = report.classResult({ ...CTX, tasks });
  assert.equal(r.underpowered, true);
  assert.equal(r.context.compressedBytesP50, 12);
  assert.equal(report.classResult({ ...CTX, cls: 'dirty-tree', tasks }).underpowered, true, 'outcome minimum is 3');
  assert.equal(report.classResult({ ...CTX, cls: 'dirty-tree', tasks: [...tasks, tasks[0]] }).underpowered, false);
});

test('an all-UNREACHED class is state unreached with its cause and no metrics', () => {
  const tasks = [scored({ statusMatch: 0 }, { result: 'UNREACHED', cause: 'binary absent' }), scored({ statusMatch: 0 }, { result: 'UNREACHED' })];
  const r = report.classResult({ ...CTX, cls: 'unavailable-provider', tasks });
  assert.equal(r.state, 'unreached');
  assert.equal(r.cause, 'binary absent');
  assert.deepEqual(r.metrics, {});
});

test('graph metrics are reported in their own table', () => {
  const tasks = [
    { scored: { metrics: { recallAt5: 0 }, na: {}, graphMetrics: { recallAt5: 1 } }, result: 'RETRIEVED' },
    { scored: { metrics: { recallAt5: 1 }, na: {}, graphMetrics: { recallAt5: 1 } }, result: 'RETRIEVED' },
  ];
  const r = report.classResult({ ...CTX, corpus: 'guidance', tasks });
  assert.equal(r.metrics.recallAt5.value, 0.5);
  assert.equal(r.graphMetrics.recallAt5.value, 1);
});

test('classesBlock lists all eight classes in order, with n/a rows for the guidance exceptions', () => {
  const results = Object.fromEntries(metrics.CLASSES.map((c) => [c, { applicable: true, n: 1 }]));
  const block = report.classesBlock({ corpus: 'guidance', results });
  assert.deepEqual(Object.keys(block), metrics.CLASSES);
  assert.equal(block['impact-refactor'].applicable, false);
  assert.match(block['verification-failure'].reason, /No command runs/);
  assert.deepEqual(block['exact-lookup'], { applicable: true, n: 1 });
  assert.equal(report.classesBlock({ corpus: 'code', results })['impact-refactor'].applicable, true);
});

test('buildBaseline and configResult follow the IC-015 key order', () => {
  const snapshot = { snapshotId: 1, commit: 'c'.repeat(40), seed: 20261012 };
  const cfg = report.configResult({ sameAs: 'B', components: [], index: { buildMs: 1 }, classes: {} });
  assert.deepEqual(Object.keys(cfg), ['sameAs', 'components', 'index', 'classes']);
  assert.deepEqual(Object.keys(report.configResult({ components: [], classes: {} })), ['components', 'classes']);
  const corpus = report.corpusResult({ A: cfg, B: cfg, comparisons: [] });
  const base = report.buildBaseline({
    snapshot, tasksSha256: 'x', capture: { capturedAt: '2026-10-12T00:00:00Z', machineId: 'm', runnerBlob: 'b', node: 'v', os: 'darwin', arch: 'arm64' },
    corpora: { code: corpus, guidance: corpus }, perTask: [],
  });
  assert.deepEqual(Object.keys(base), ['schemaVersion', 'snapshotId', 'commit', 'split', 'tasksSha256', 'capture', 'corpora', 'perTask']);
  assert.deepEqual(Object.keys(base.capture), ['capturedAt', 'machineId', 'runnerBlob', 'seed', 'node', 'os', 'arch']);
  assert.equal(base.split, 'dev');
  assert.equal(base.capture.seed, 20261012);
  assert.ok(report.toFileText(base).endsWith('}\n'));
});

test('holdout result and comparison writers refuse any per-task detail', () => {
  const ok = {
    snapshotId: 1, generation: 1, corpus: 'code', config: 'A', sealPlaintextSha256: 'p', thresholdsCommit: 't',
    runAt: '2026-10-12T00:00:00Z', runIndex: 1, machineId: 'm', classes: { 'exact-lookup': { applicable: true, n: 12 } },
  };
  const built = report.buildHoldoutResult(ok);
  assert.deepEqual(Object.keys(built), ['schemaVersion', 'snapshotId', 'generation', 'corpus', 'config', 'sealPlaintextSha256', 'thresholdsCommit', 'runAt', 'runIndex', 'machineId', 'classes']);
  for (const key of ['perTask', 'query', 'qrels', 'tasks']) {
    assert.throws(() => report.buildHoldoutResult({ ...ok, classes: { x: { [key]: [] } } }), new RegExp(`may not carry "${key}"`));
  }
  assert.throws(() => report.buildHoldoutResult({ ...ok, classes: { x: { note: 'see HC-004' } } }), /task id/);
  assert.throws(() => report.buildComparisonFile({ snapshotId: 1, generation: 1, corpus: 'code', comparisons: [{ perTask: [] }] }), /may not carry "perTask"/);
  assert.deepEqual(Object.keys(report.buildComparisonFile({ snapshotId: 1, generation: 1, corpus: 'code', comparisons: [] })), ['schemaVersion', 'snapshotId', 'generation', 'corpus', 'comparisons']);
});

test('result file names carry snapshot, generation, corpus and configuration', () => {
  assert.equal(report.holdoutResultName(1, 2, 'code', 'A'), 'holdout-1-g2-code-A.json');
  assert.equal(report.comparisonName(1, 2, 'guidance'), 'holdout-1-g2-guidance-A-vs-B.json');
});
