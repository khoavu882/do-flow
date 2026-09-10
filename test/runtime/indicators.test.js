'use strict';

// Feature 033 — the indicators derivation. Eight real orchestration records exercise the common path
// and two unusual ones (a backfilled stage, a gate wait of about 59 hours), but none of them is empty,
// unparseable or out of order. Those three are where a reader would be misled most, so they get
// synthetic fixtures rather than being left to whatever happens to be on disk.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRecords, buildIndicators, orchestrationDir } = require('../../src/runtime/trace/indicators');

const MINUTE = 60_000;

/** A record in the shape the orchestrator writes, with only the fields the derivation reads. */
function record({ taskId, taskClass = 'feature', state = 'COMPLETED', startedAt, updatedAt, history }) {
  return { version: 1, taskId, taskClass, state, startedAt, updatedAt, history };
}

function tmpDirWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-indicators-'));
  const dir = orchestrationDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { root, dir };
}

test('033: a stage figure is the interval since the previous recorded event, first measured from the run start', () => {
  const view = buildIndicators({
    records: [record({
      taskId: 't1',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:30:00.000Z',
      history: [
        { at: '2026-01-01T00:05:00.000Z', action: 'complete-stage', node: 'discovery', outcome: 'unverified' },
        { at: '2026-01-01T00:20:00.000Z', action: 'complete-stage', node: 'design', outcome: 'passed' },
      ],
    })],
  });
  const [run] = view.byClass[0].runs;
  assert.equal(run.stages[0].elapsedMs, 5 * MINUTE, 'first stage is measured from startedAt');
  assert.equal(run.stages[1].elapsedMs, 15 * MINUTE, 'second stage is measured from the first completion');
  assert.equal(run.totalMs, 30 * MINUTE);
});

test('033: a gate wait is its own row and is charged to neither adjacent stage', () => {
  const view = buildIndicators({
    records: [record({
      taskId: 't2',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      history: [
        { at: '2026-01-01T00:10:00.000Z', action: 'complete-stage', node: 'planning', outcome: 'unverified' },
        { at: '2026-01-01T10:10:00.000Z', action: 'decide-gate', node: 'gate-a', detail: 'approve' },
        { at: '2026-01-01T10:20:00.000Z', action: 'complete-stage', node: 'implementation', outcome: 'passed' },
      ],
    })],
  });
  const [run] = view.byClass[0].runs;
  assert.equal(run.stages[0].elapsedMs, 10 * MINUTE, 'the stage before the gate keeps its own interval');
  assert.equal(run.gates[0].elapsedMs, 600 * MINUTE, 'the wait is the gate row');
  assert.equal(run.stages[1].elapsedMs, 10 * MINUTE,
    'the stage after the gate is measured from the decision, not from the stage before the wait');
});

test('033: a backfilled or imported stage is marked and excluded from the aggregate but still listed', () => {
  const view = buildIndicators({
    records: [
      record({
        taskId: 'a',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:10:00.000Z',
        history: [{ at: '2026-01-01T00:10:00.000Z', action: 'complete-stage', node: 'verification', outcome: 'passed' }],
      }),
      record({
        taskId: 'b',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T05:00:00.000Z',
        history: [{ at: '2026-01-01T05:00:00.000Z', action: 'complete-stage', node: 'verification', outcome: 'unverified', backfilled: true }],
      }),
    ],
  });
  const group = view.byClass[0];
  assert.equal(group.runs[1].stages[0].synthetic, true, 'the backfilled row is marked');
  const agg = group.stageAggregate.find((a) => a.stage === 'verification');
  assert.equal(agg.runs, 1, 'only the executed run contributes to the aggregate');
  assert.equal(agg.medianMs, 10 * MINUTE, 'the 5-hour backfilled row does not move the median');
});

test('033: an executionStatus other than completed counts as synthetic too', () => {
  const view = buildIndicators({
    records: [record({
      taskId: 'c',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:10:00.000Z',
      history: [{ at: '2026-01-01T00:10:00.000Z', action: 'complete-stage', node: 'reproduction', outcome: 'unverified', executionStatus: 'imported' }],
    })],
  });
  assert.equal(view.byClass[0].runs[0].stages[0].synthetic, true);
  assert.deepEqual(view.byClass[0].stageAggregate, [], 'an imported stage aggregates nothing');
});

test('033: classes are reported separately and no aggregate spans them', () => {
  const view = buildIndicators({
    records: [
      record({ taskId: 'f', taskClass: 'feature', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:02:00.000Z',
        history: [{ at: '2026-01-01T00:02:00.000Z', action: 'complete-stage', node: 'review', outcome: 'passed' }] }),
      record({ taskId: 'g', taskClass: 'bug', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:40:00.000Z',
        history: [{ at: '2026-01-01T00:40:00.000Z', action: 'complete-stage', node: 'review', outcome: 'passed' }] }),
    ],
  });
  assert.deepEqual(view.byClass.map((c) => c.taskClass).sort(), ['bug', 'feature']);
  for (const group of view.byClass) {
    assert.equal(group.stageAggregate.find((a) => a.stage === 'review').runs, 1,
      'each class aggregates only its own runs');
  }
});

test('033: annotate entries are counted as reruns', () => {
  const view = buildIndicators({
    records: [record({
      taskId: 'h', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:30:00.000Z',
      history: [
        { at: '2026-01-01T00:10:00.000Z', action: 'complete-stage', node: 'review', outcome: 'passed' },
        { at: '2026-01-01T00:20:00.000Z', action: 'annotate', note: 're-review' },
        { at: '2026-01-01T00:30:00.000Z', action: 'annotate', note: 're-review again' },
      ],
    })],
  });
  assert.equal(view.byClass[0].runs[0].reruns, 2);
});

test('033: an out-of-order history reports a negative interval rather than clamping it', () => {
  // Clamping would hide a corrupt record. A negative number is visible and diagnosable.
  const view = buildIndicators({
    records: [record({
      taskId: 'i', startedAt: '2026-01-01T00:10:00.000Z', updatedAt: '2026-01-01T00:10:00.000Z',
      history: [{ at: '2026-01-01T00:05:00.000Z', action: 'complete-stage', node: 'discovery', outcome: null }],
    })],
  });
  assert.equal(view.byClass[0].runs[0].stages[0].elapsedMs, -5 * MINUTE);
});

test('033: a stage with no recorded outcome is not reported as passing', () => {
  const view = buildIndicators({
    records: [record({
      taskId: 'j', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
      history: [{ at: '2026-01-01T00:01:00.000Z', action: 'complete-stage', node: 'discovery' }],
    })],
  });
  assert.equal(view.byClass[0].runs[0].stages[0].outcome, null);
});

test('033: an unparseable record is counted and named, never silently skipped', () => {
  const { root } = tmpDirWith({
    'good.json': record({ taskId: 'ok', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', history: [] }),
    'broken.json': '{ not json',
    'notarecord.json': { version: 1, nope: true },
  });
  const read = readRecords(orchestrationDir(root));
  assert.equal(read.records.length, 1);
  assert.deepEqual(read.unreadable.map((u) => u.file).sort(), ['broken.json', 'notarecord.json']);
  const view = buildIndicators(read);
  assert.equal(view.unreadable.length, 2, 'the view carries them through so the report can name them');
});

test('033: an absent directory is a state, not an error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-indicators-none-'));
  const read = readRecords(orchestrationDir(root));
  assert.equal(read.exists, false);
  const view = buildIndicators(read);
  assert.equal(view.runCount, 0);
  assert.deepEqual(view.byClass, []);
});

test('033: the view carries its own limits, including the interval caveat', () => {
  const view = buildIndicators({ records: [] });
  const joined = view.limits.join(' ');
  assert.match(joined, /interval since the previous recorded event/);
  assert.match(joined, /human deciding/);
  assert.match(joined, /git, pull-request or continuous-integration/);
});

test('033: no score, grade, percentage or confidence appears anywhere in the view', () => {
  // NFR-003. The shipped guidance forbids expressing evidence as a score, and one figure over stages
  // that do unlike work would hide what the report exists to show.
  const view = buildIndicators({
    records: [record({ taskId: 'k', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:05:00.000Z',
      history: [{ at: '2026-01-01T00:05:00.000Z', action: 'complete-stage', node: 'discovery', outcome: 'passed' }] })],
  });
  const keys = new Set();
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) { keys.add(k.toLowerCase()); walk(v); }
    }
  }(view));
  for (const forbidden of ['score', 'grade', 'percent', 'percentage', 'confidence', 'health']) {
    assert.equal(keys.has(forbidden), false, `the view must not carry a '${forbidden}' field`);
  }
});
