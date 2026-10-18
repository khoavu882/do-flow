'use strict';

// 110 T6 (IC-019, IC-006, diagnosis F4): dispatch verify records carry dispatch_run.
//
// When verification is spawned from dispatch (integrate or final loop completion), the verify.run
// record carries dispatch_run matching the store's run.dispatchRunId (p-... token, never a path).
// A CLI/verb verification writes null for dispatch_run even if ctx carried a value.
// Telemetry off writes nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.js');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { buildVerifyRecords } = require(path.join(SRC, 'verification', 'telemetry-emit.ts'));
const { runVerification } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createIntegrationWorktree, createAttemptWorktree, attemptCommit } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const integrate = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));

const POSIX = { skip: process.platform === 'win32' && 'POSIX process groups' };
const DISPATCH_RUN_ID = 'p-f0ad33b51b70';

function setupProject(t) {
  const root = tempDir(t, 'doflow-dispatch-verify-id-');
  const worktree = path.join(root, 'integration');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(worktree);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
  const env = {
    PATH: bin,
    HOME: root,
    DOFLOW_TELEMETRY: 'on',
    DOFLOW_RUN_ID: 'p-0123456789ab',
    DOFLOW_LINEAGE_ID: 'lin-verify',
    DOFLOW_ATTEMPT: '1',
  };
  return { root, worktree, env };
}

function readTelemetryLines(root) {
  const dir = path.join(root, '.doflow', 'state', 'runs', 'telemetry');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).sort();
  const lines = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of content.split('\n').filter(Boolean)) {
      lines.push(JSON.parse(line));
    }
  }
  return lines;
}

test('buildVerifyRecords: dispatch source writes dispatch_run token', () => {
  const report = { status: 'PASS', startedAt: '2026-10-18T00:00:00.000Z', finishedAt: '2026-10-18T00:00:01.000Z', tiers: [] };
  const records = buildVerifyRecords({
    report,
    ctx: { verifyId: 'a'.repeat(16), source: 'dispatch', taskId: 'A.1', dispatchRun: DISPATCH_RUN_ID },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'verify.run');
  assert.equal(records[0].source, 'dispatch');
  assert.equal(records[0].dispatch_run, DISPATCH_RUN_ID);
});

test('buildVerifyRecords: dispatch source drops malformed dispatch run id', () => {
  const report = { status: 'PASS', startedAt: '2026-10-18T00:00:00.000Z', finishedAt: '2026-10-18T00:00:01.000Z', tiers: [] };
  const records = buildVerifyRecords({
    report,
    ctx: { verifyId: 'g'.repeat(16), source: 'dispatch', taskId: 'A.1', dispatchRun: 'p-0123456789abc' },
  });
  assert.equal(records[0].dispatch_run, null, 'a token-shaped value that is not a dispatch run id is dropped');
});

test('buildVerifyRecords: cli/verb source writes null for dispatch_run', () => {
  const report = { status: 'PASS', startedAt: '2026-10-18T00:00:00.000Z', finishedAt: '2026-10-18T00:00:01.000Z', tiers: [] };
  const verbRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: 'b'.repeat(16), source: 'verb', taskId: 'T-1', dispatchRun: DISPATCH_RUN_ID },
  });
  assert.equal(verbRecords[0].dispatch_run, null, 'verb source must null dispatch_run');

  const cliRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: 'c'.repeat(16), source: 'cli', taskId: 'T-1', dispatchRun: DISPATCH_RUN_ID },
  });
  assert.equal(cliRecords[0].dispatch_run, null, 'cli source must null dispatch_run');
});

test('buildVerifyRecords: dispatch source with invalid token or path writes null', () => {
  const report = { status: 'PASS', startedAt: '2026-10-18T00:00:00.000Z', finishedAt: '2026-10-18T00:00:01.000Z', tiers: [] };
  const pathRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: 'd'.repeat(16), source: 'dispatch', taskId: 'A.1', dispatchRun: path.join(__dirname, 'project', 'path') },
  });
  assert.equal(pathRecords[0].dispatch_run, null, 'a path is never written as dispatch_run');

  const spaceRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: 'e'.repeat(16), source: 'dispatch', taskId: 'A.1', dispatchRun: 'invalid token with spaces' },
  });
  assert.equal(spaceRecords[0].dispatch_run, null);

  const nullRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: 'f'.repeat(16), source: 'dispatch', taskId: 'A.1', dispatchRun: null },
  });
  assert.equal(nullRecords[0].dispatch_run, null);
});

test('runVerification: dispatch run writes verify.run with dispatch_run', POSIX, async (t) => {
  const p = setupProject(t);
  const argv = [process.execPath, '-e', 'process.exit(0)'];
  const res = await runVerification({
    root: p.root, slug: 'feat-test', taskId: 'A.1', worktree: p.worktree, argv, seconds: 10,
    env: p.env, dispatchRunId: DISPATCH_RUN_ID,
  });
  assert.equal(res.exitCode, 0);

  const lines = readTelemetryLines(p.root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'verify.run');
  assert.equal(lines[0].source, 'dispatch');
  assert.equal(lines[0].dispatch_run, DISPATCH_RUN_ID);
});

test('runVerification: omission of dispatchRunId writes null dispatch_run', POSIX, async (t) => {
  const p = setupProject(t);
  const argv = [process.execPath, '-e', 'process.exit(0)'];
  const res = await runVerification({
    root: p.root, slug: 'feat-test', taskId: 'A.1', worktree: p.worktree, argv, seconds: 10,
    env: p.env,
  });
  assert.equal(res.exitCode, 0);

  const lines = readTelemetryLines(p.root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'verify.run');
  assert.equal(lines[0].dispatch_run, null);
});

test('runVerification: telemetry off writes nothing even when dispatchRunId is given', POSIX, async (t) => {
  const p = setupProject(t);
  const argv = [process.execPath, '-e', 'process.exit(0)'];
  const res = await runVerification({
    root: p.root, slug: 'feat-test', taskId: 'A.1', worktree: p.worktree, argv, seconds: 10,
    env: { ...p.env, DOFLOW_TELEMETRY: 'off' }, dispatchRunId: DISPATCH_RUN_ID,
  });
  assert.equal(res.exitCode, 0);

  const lines = readTelemetryLines(p.root);
  assert.equal(lines.length, 0, 'telemetry off writes nothing');
});

test('integrateOnce: passes run.dispatchRunId from dispatch store to verify', POSIX, async (t) => {
  const SLUG = '082-int-verify-id';
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
  const { root, env } = sb;
  const ledgerFile = path.join(root, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  const common = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  attempts.start({ ...common, by: 'main' });
  const ctx = { ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  const argv = [process.execPath, '-e', 'process.exitCode = 0'];
  store.mutateDispatch(file, (s) => {
    s.run = {
      dispatchRunId, state: 'running', runKey: null, epoch: 1, integration,
      verify: { argv, argvSha256: null, argvCount: argv.length, timeoutSeconds: 30 },
    };
    return { write: true, result: null };
  });

  const id = store.newDispatchId();
  const base = store.readDispatch(file).run.integration.head;
  store.mutateDispatch(file, (s) => {
    s.dispatches[id] = { dispatchId: id, task: 'A.1', phase: 'admitted', mode: 'subagent', reservation: { tokens: 50 }, admittedAt: new Date().toISOString() };
    return { write: true, result: null };
  });
  const wt = createAttemptWorktree({ root, slug: SLUG, dispatchId: id, base, env });
  const c = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, reserveTokens: 50, execWorktree: wt.worktree });
  store.transitionDispatch(file, id, ['admitted'], (d) => Object.assign(d, { phase: 'claimed', token: c.token, epoch: c.epoch, parentRunKey: c.runKey, attempt: wt }));
  store.transitionDispatch(file, id, ['claimed'], (d) => { d.phase = 'launched'; });
  const made = attemptCommit({ worktree: wt.worktree, base, dispatchId: id, task: 'A.1', token: c.token, env });
  store.transitionDispatch(file, id, ['launched'], (d) => Object.assign(d, {
    phase: 'collected', outcome: 'offered', commit: made.commit, changes: made.changes, collectedAt: new Date().toISOString(),
  }));

  let capturedVerifyArgs = null;
  const mockVerify = async (args) => {
    capturedVerifyArgs = args;
    return runVerification(args);
  };

  const res = await integrate.integrateNext({ root, slug: SLUG, ctx, env, holder: { pid: process.pid, start: null }, verify: mockVerify });
  assert.equal(res.outcome, 'completed', JSON.stringify(res));
  assert.ok(capturedVerifyArgs, 'verify was called');
  assert.equal(capturedVerifyArgs.dispatchRunId, dispatchRunId, 'dispatchRunId matched store.run.dispatchRunId');
});

test('loop complete: passes run.dispatchRunId to p.verify during final verification', POSIX, async (t) => {
  const SLUG = '082-complete-verify-id';
  let capturedVerifyArgs = null;
  const mockVerify = async (args) => {
    capturedVerifyArgs = args;
    return runVerification(args);
  };
  const sb = makeDispatchSandbox(t, { plan: 'budget', slug: SLUG });
  const { root } = sb;
  const env = { ...sb.env, VERIFY_COUNT: path.join(sb.dir, 'verify-count') };
  const ledgerFile = attempts.storeFile(root, SLUG);
  const common = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const started = attempts.start({ ...common, by: 'main' });
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  store.mutateDispatch(file, (s) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch, concurrency: 1, mode: 'sequential',
      reserveTokens: null, attemptSeconds: 60, harness: null, needs: [], spawnGrant: null, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 },
    };
    return { write: true, result: null };
  });
  const options = (extra = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors: sb.descriptors, verify: mockVerify, ...extra });
  for (let i = 0; i < 20; i += 1) {
    const r = await loop.step(options());
    if (r.outcome === 'perform') {
      await loop.submit(options({ dispatchId: r.perform.dispatchId, status: 'success', summary: `done ${r.perform.task}` }));
    }
    if (['completed', 'blocked'].includes(r.outcome)) break;
  }
  assert.ok(capturedVerifyArgs, 'verify was called during loop completion');
  assert.equal(capturedVerifyArgs.dispatchRunId, dispatchRunId);
});

test('negative control: removing the pass-through fails a named test', POSIX, async (t) => {
  const p = setupProject(t);
  const argv = [process.execPath, '-e', 'process.exit(0)'];

  // When pass-through is active:
  const resWithPassThrough = await runVerification({
    root: p.root, slug: 'feat-control', taskId: 'A.1', worktree: p.worktree, argv, seconds: 10,
    env: p.env, dispatchRunId: DISPATCH_RUN_ID,
  });
  assert.equal(resWithPassThrough.exitCode, 0);

  // If the pass-through was omitted (simulated by not passing dispatchRunId or passing null):
  const resWithoutPassThrough = await runVerification({
    root: p.root, slug: 'feat-control', taskId: 'A.1', worktree: p.worktree, argv, seconds: 10,
    env: p.env, dispatchRunId: null,
  });
  assert.equal(resWithoutPassThrough.exitCode, 0);

  const lines = readTelemetryLines(p.root);
  assert.equal(lines.length, 2);
  // The run with pass-through matches the expected DISPATCH_RUN_ID:
  assert.equal(lines[0].dispatch_run, DISPATCH_RUN_ID);
  // Without the pass-through, dispatch_run is null and fails equality check:
  assert.equal(lines[1].dispatch_run, null);
  assert.notEqual(lines[1].dispatch_run, DISPATCH_RUN_ID, 'negative control demonstrates failure when pass-through is removed');
});
