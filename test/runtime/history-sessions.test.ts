'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const {
  scanSessionsHistory,
  handleSessionsHistoryCommand,
  DEFAULT_DAYS,
  DEFAULT_LIMIT,
} = require('../../src/runtime/history/sessions.ts');

test('sessions-history: aggregates sessions within retention window and counts pruned', (t) => {
  const root = tempDir(t, 'doflow-hist-');

  const orchDir = path.join(root, '.doflow', 'state', 'orchestration');
  fs.mkdirSync(orchDir, { recursive: true });

  const now = new Date('2026-11-10T12:00:00.000Z');
  const freshTime = new Date('2026-11-05T10:00:00.000Z').toISOString();
  const oldTime = new Date('2026-09-01T10:00:00.000Z').toISOString(); // > 60 days old

  // Fresh session
  fs.writeFileSync(path.join(orchDir, 'fresh-session.json'), JSON.stringify({
    version: 1,
    taskId: 'fresh-session',
    taskClass: 'feature',
    workflowName: 'Feature Delivery',
    state: 'COMPLETED',
    startedAt: freshTime,
    updatedAt: freshTime,
    program: [
      { type: 'stage', id: 'discovery', name: 'Discovery', status: 'completed' },
      { type: 'stage', id: 'design', name: 'Design', status: 'completed' },
    ],
    history: [
      { at: freshTime, action: 'start' },
      { at: new Date('2026-11-05T10:10:00.000Z').toISOString(), action: 'complete-stage', node: 'discovery' },
      { at: new Date('2026-11-05T10:30:00.000Z').toISOString(), action: 'complete-stage', node: 'design' },
      { at: new Date('2026-11-05T10:30:00.000Z').toISOString(), action: 'complete-run' },
    ],
  }));

  // Old pruned session
  fs.writeFileSync(path.join(orchDir, 'old-session.json'), JSON.stringify({
    version: 1,
    taskId: 'old-session',
    taskClass: 'bug',
    workflowName: 'Bug Fix',
    state: 'COMPLETED',
    startedAt: oldTime,
    updatedAt: oldTime,
    program: [
      { type: 'stage', id: 'implementation', name: 'Implementation', status: 'completed' },
    ],
    history: [
      { at: oldTime, action: 'start' },
      { at: new Date('2026-09-01T10:05:00.000Z').toISOString(), action: 'complete-stage', node: 'implementation' },
    ],
  }));

  const body = scanSessionsHistory({ projectRoot: root, now, days: 30 });
  assert.equal(body.v, 1);
  assert.equal(body.window.maxAgeDays, 30);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].slug, 'fresh-session');
  assert.equal(body.sessions[0].taskClass, 'feature');
  assert.equal(body.sessions[0].state, 'COMPLETED');
  assert.equal(body.sessions[0].durationMs, 30 * 60 * 1000); // 10:00 to 10:30
  assert.equal(body.sessions[0].stages.length, 2);
  assert.equal(body.limits.shown, 1);
  assert.equal(body.limits.pruned, 1);
});

test('sessions-history: workers, retries, and token telemetry invariant (unknown is null, never 0)', (t) => {
  const root = tempDir(t, 'doflow-hist-');

  const orchDir = path.join(root, '.doflow', 'state', 'orchestration');
  const workerDir = path.join(root, '.doflow', 'state', 'worker-runs');
  fs.mkdirSync(orchDir, { recursive: true });
  fs.mkdirSync(workerDir, { recursive: true });

  const now = new Date('2026-11-10T12:00:00.000Z');
  const startedAt = new Date('2026-11-09T10:00:00.000Z').toISOString();

  fs.writeFileSync(path.join(orchDir, 'worker-test.json'), JSON.stringify({
    version: 1,
    taskId: 'worker-test',
    taskClass: 'feature',
    state: 'COMPLETED',
    startedAt,
    history: [{ at: startedAt, action: 'start' }],
  }));

  // Worker runs: 2 runs, token 1 and token 2 (1 retry), quota stop on second run
  fs.writeFileSync(path.join(workerDir, 'worker-test.json'), JSON.stringify({
    slug: 'worker-test',
    runs: {
      'w-1': {
        runId: 'w-1',
        task: 'A.1',
        token: 1,
        seq: 1,
        harness: 'codex',
        phase: 'ended',
        report: { status: 'failure', model: 'codex-5' },
      },
      'w-2': {
        runId: 'w-2',
        task: 'A.1',
        token: 2,
        seq: 2,
        harness: 'codex',
        phase: 'ended',
        report: {
          status: 'failure',
          model: 'codex-5',
          quota: { signal: 'rate limit', basis: 'transcript' },
        },
      },
    },
  }));

  const body = scanSessionsHistory({ projectRoot: root, now, days: 30 });
  assert.equal(body.sessions.length, 1);
  const s = body.sessions[0];

  assert.equal(s.harness, 'codex');
  assert.equal(s.workers.count, 2);
  assert.equal(s.workers.attempts, 2);
  assert.equal(s.workers.retries, 1);
  assert.equal(s.workers.quotaStops, 1);

  // Invariant check: telemetry is unknown, tokens are null, not 0
  assert.equal(s.cost.telemetry, 'unknown');
  assert.equal(s.cost.tokens.input, null);
  assert.equal(s.cost.tokens.output, null);
  assert.equal(s.cost.tokens.total, null);
  assert.deepEqual(s.cost.models, ['codex-5']);
});

test('sessions-history: limits capping and notShown count', (t) => {
  const root = tempDir(t, 'doflow-hist-');

  const orchDir = path.join(root, '.doflow', 'state', 'orchestration');
  fs.mkdirSync(orchDir, { recursive: true });

  const now = new Date('2026-11-10T12:00:00.000Z');

  for (let i = 1; i <= 5; i++) {
    const time = new Date(now.getTime() - i * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(orchDir, `session-${i}.json`), JSON.stringify({
      version: 1,
      taskId: `session-${i}`,
      taskClass: 'feature',
      state: 'COMPLETED',
      startedAt: time,
      history: [{ at: time, action: 'start' }],
    }));
  }

  // Query with limit 2
  const body = scanSessionsHistory({ projectRoot: root, now, limit: 2 });
  assert.equal(body.sessions.length, 2);
  assert.equal(body.limits.shown, 2);
  assert.equal(body.limits.notShown, 3);
  assert.equal(body.limits.pruned, 0);
  assert.equal(body.sessions[0].slug, 'session-1'); // newest first
  assert.equal(body.sessions[1].slug, 'session-2');
});

test('sessions-history CLI handler: --json and usage exit codes', (t) => {
  const savedExit = process.exitCode;
  t.after(() => { process.exitCode = savedExit; });

  let stdout = '';
  let stderr = '';
  const fakeOut = { write(str: string) { stdout += str; } };
  const fakeErr = { write(str: string) { stderr += str; } };

  // Exit 0 on clean scan
  const exit0 = handleSessionsHistoryCommand({
    json: true,
    stdout: fakeOut,
    stderr: fakeErr,
    flags: ['--json'],
  });
  assert.equal(exit0, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.v, 1);
  assert.ok(Array.isArray(parsed.sessions));

  // Exit 2 on unknown flag
  let errOutput = '';
  const exit2 = handleSessionsHistoryCommand({
    flags: ['--unknown-flag'],
    stderr: { write(s: string) { errOutput += s; } },
  });
  assert.equal(exit2, 2);
  assert.match(errOutput, /unknown flag '--unknown-flag'/);
});
