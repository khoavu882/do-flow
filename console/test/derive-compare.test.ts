'use strict';

// Compare view derivation tests (feature 152, IC-008; FR-004, FR-005).
// Pure functions over SessionHistoryRecord pairs.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const SOURCE_FILE = path.join(WEB_ROOT, 'derive', 'compare.js');

let scratch: string[] = [];
let compareMod: any;

async function load(): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-compare-'));
  scratch.push(dir);
  fs.cpSync(path.join(WEB_ROOT, 'derive'), path.join(dir, 'derive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  return import(pathToFileURL(path.join(dir, 'derive', 'compare.js')).href);
}

before(async () => {
  compareMod = await load();
});

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

test('alignRuns: aligns identical stages, computes deltas and aligns workers', () => {
  const { alignRuns } = compareMod;

  const runA = {
    slug: 'run-a',
    taskId: 'task-a',
    taskClass: 'feature',
    workflowName: 'Feature Delivery',
    harness: 'codex',
    state: 'COMPLETED',
    startedAt: '2026-11-10T10:00:00.000Z',
    endedAt: '2026-11-10T10:30:00.000Z',
    durationMs: 1800000,
    stages: [
      { id: 'discovery', name: 'Discovery', skill: 'do-brainstorm', status: 'completed', outcome: 'completed', durationMs: 600000 },
      { id: 'design', name: 'Design', skill: 'do-design', status: 'completed', outcome: 'completed', durationMs: 1200000 },
    ],
    workers: { count: 2, attempts: 2, retries: 0, quotaStops: 0 },
    cost: {
      telemetry: 'unknown',
      models: ['codex-5'],
      tokens: { input: null, output: null, total: null },
    },
  };

  const runB = {
    slug: 'run-b',
    taskId: 'task-b',
    taskClass: 'feature',
    workflowName: 'Feature Delivery',
    harness: 'codex',
    state: 'COMPLETED',
    startedAt: '2026-11-10T11:00:00.000Z',
    endedAt: '2026-11-10T11:45:00.000Z',
    durationMs: 2700000, // +900,000 ms (+15m)
    stages: [
      { id: 'discovery', name: 'Discovery', skill: 'do-brainstorm', status: 'completed', outcome: 'completed', durationMs: 500000 }, // -100,000 ms
      { id: 'design', name: 'Design', skill: 'do-design', status: 'completed', outcome: 'completed', durationMs: 2200000 }, // +1,000,000 ms
    ],
    workers: { count: 3, attempts: 4, retries: 1, quotaStops: 1 },
    cost: {
      telemetry: 'unknown',
      models: ['codex-5'],
      tokens: { input: null, output: null, total: null },
    },
  };

  const res = alignRuns(runA, runB);

  assert.equal(res.runA.slug, 'run-a');
  assert.equal(res.runB.slug, 'run-b');
  assert.equal(res.summary.durationDeltaMs, 900000);
  assert.equal(res.summary.workerCountDelta, 1);
  assert.equal(res.summary.attemptDelta, 2);
  assert.equal(res.summary.retryDelta, 1);
  assert.equal(res.summary.quotaStopDelta, 1);

  assert.equal(res.stages.length, 2);
  assert.equal(res.stages[0].id, 'discovery');
  assert.equal(res.stages[0].presence, 'both');
  assert.equal(res.stages[0].durationDeltaMs, -100000);

  assert.equal(res.stages[1].id, 'design');
  assert.equal(res.stages[1].presence, 'both');
  assert.equal(res.stages[1].durationDeltaMs, 1000000);

  // Invariant: telemetry unknown preserves null tokens
  assert.equal(res.cost.telemetryA, 'unknown');
  assert.equal(res.cost.telemetryB, 'unknown');
  assert.equal(res.cost.tokensA.total, null);
  assert.equal(res.cost.tokensB.total, null);
  assert.equal(res.cost.tokenDelta.total, null);
});

test('alignRuns: handles asymmetric stages across runs', () => {
  const { alignRuns } = compareMod;

  const runA = {
    slug: 'run-a',
    stages: [
      { id: 'discovery', name: 'Discovery', durationMs: 300000 },
      { id: 'design', name: 'Design', durationMs: 600000 },
    ],
  };

  const runB = {
    slug: 'run-b',
    stages: [
      { id: 'discovery', name: 'Discovery', durationMs: 400000 },
      { id: 'plan', name: 'Plan', durationMs: 500000 }, // new stage in B
    ],
  };

  const res = alignRuns(runA, runB);
  assert.equal(res.stages.length, 3);

  // discovery: in both
  assert.equal(res.stages[0].id, 'discovery');
  assert.equal(res.stages[0].presence, 'both');
  assert.equal(res.stages[0].durationDeltaMs, 100000);

  // design: only in A
  assert.equal(res.stages[1].id, 'design');
  assert.equal(res.stages[1].presence, 'a-only');
  assert.equal(res.stages[1].statusB, 'not-in-run');
  assert.equal(res.stages[1].durationDeltaMs, null);

  // plan: only in B
  assert.equal(res.stages[2].id, 'plan');
  assert.equal(res.stages[2].presence, 'b-only');
  assert.equal(res.stages[2].statusA, 'not-in-run');
  assert.equal(res.stages[2].durationDeltaMs, null);
});

test('alignRuns: handles recorded telemetry tokens and deltas', () => {
  const { alignRuns } = compareMod;

  const runA = {
    slug: 'run-a',
    cost: {
      telemetry: 'recorded',
      models: ['claude-3-5-sonnet'],
      tokens: { input: 10000, output: 2000, total: 12000 },
    },
  };

  const runB = {
    slug: 'run-b',
    cost: {
      telemetry: 'recorded',
      models: ['claude-3-5-sonnet'],
      tokens: { input: 15000, output: 2500, total: 17500 },
    },
  };

  const res = alignRuns(runA, runB);
  assert.equal(res.cost.telemetryA, 'recorded');
  assert.equal(res.cost.telemetryB, 'recorded');
  assert.equal(res.cost.tokenDelta.input, 5000);
  assert.equal(res.cost.tokenDelta.output, 500);
  assert.equal(res.cost.tokenDelta.total, 5500);
});

test('format helpers: formatDuration, formatDurationDelta, formatTokens', () => {
  const { formatDuration, formatDurationDelta, formatTokens } = compareMod;

  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(90000), '1m 30s');
  assert.equal(formatDuration(3600000), '1h');

  assert.equal(formatDurationDelta(null), '—');
  assert.equal(formatDurationDelta(0), '0s');
  assert.equal(formatDurationDelta(12000), '+12s');
  assert.equal(formatDurationDelta(-5000), '-5s');
  assert.equal(formatDurationDelta(90000), '+1m 30s');

  assert.equal(formatTokens(null), 'unknown');
  assert.equal(formatTokens(1234567), '1,234,567');
});
