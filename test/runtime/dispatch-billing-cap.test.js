'use strict';

// FR-018 / FR-019 / IC-012: dispatch start's free-only billing cap prevents paid worker selection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('../../src/cli/index.ts');
const { executeDispatchCommand } = require('../../src/runtime/dispatch/command.ts');
const readiness = require('../../src/runtime/worker/readiness.ts');
const { readDispatch, storeFileFor } = require('../../src/runtime/dispatch/store.ts');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');

const SLUG = '108-billing-fixture';
const SUCCESS = { type: 'result', status: 'success', summary: 'billing fixture complete' };
const POSIX = { skip: process.platform === 'win32' && 'dispatch worktree fixture is POSIX-only' };

function billingDescriptors(sb, claudeBilling) {
  const descriptors = structuredClone(sb.descriptors);
  for (const worker of Object.values(descriptors)) worker.billing = 'unknown';
  descriptors.claude.billing = claudeBilling;
  return descriptors;
}

function command(sb, descriptors, extra) {
  return executeDispatchCommand({ slug: SLUG, cwd: sb.root, env: sb.env, descriptors, ...extra });
}

async function start(sb, descriptors, billingCap) {
  return command(sb, descriptors, {
    action: 'start', by: 'main', mode: 'auto',
    verifyArgv: JSON.stringify(sb.verifyArgv),
    ...(billingCap === undefined ? {} : { billingCap }),
  });
}

test('dispatch CLI parses the cap and dispatch start rejects every cap except free with usage exit 2', async () => {
  const parsed = parseArgs(['dispatch', '--action', 'start', '--billing-cap', 'free']);
  assert.equal(parsed.billingCap, 'free');
  assert.equal(parseArgs(['dispatch', '--action', 'start', '--billing-cap=free']).billingCap, 'free');

  for (const billingCap of ['metered', 'unknown', 'paid']) {
    const result = await executeDispatchCommand({ action: 'start', slug: SLUG, by: 'main', billingCap });
    assert.equal(result.exit, 2, `${billingCap}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error, 'usage');
  }
  const misplaced = await executeDispatchCommand({ action: 'step', billingCap: 'free' });
  assert.equal(misplaced.exit, 2);
  assert.equal(misplaced.body.error, 'usage');
});

test('the CLI forwards --billing-cap to dispatch start and persists it on the run', POSIX, async (t) => {
  const sb = makeDispatchSandbox(t, { plan: 'dependent', slug: SLUG });
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '../../bin/doflow.js'),
    'dispatch', '--action', 'start', '--slug', SLUG, '--billing-cap', 'free', '--by', 'main', '--mode', 'auto',
    '--verify-argv', JSON.stringify(sb.verifyArgv), '--json',
  ], { cwd: sb.root, env: { ...process.env, ...sb.env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).disposition, 'started');
  assert.equal(readDispatch(storeFileFor(sb.root, SLUG)).run.billingCap, 'free');
});

test('free cap leaves only metered and unknown workers sequential with billing gaps and no launch', POSIX, async (t) => {
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
  const descriptors = billingDescriptors(sb, 'metered');
  const started = await start(sb, descriptors, 'free');
  assert.equal(started.body.disposition, 'started', JSON.stringify(started.body));

  const stepped = await command(sb, descriptors, { action: 'step', by: 'main', evaluateImpl: () => ({ eligible: true, gaps: [] }) });
  assert.equal(stepped.body.disposition, 'stepped', JSON.stringify(stepped.body));
  const dispatch = readDispatch(storeFileFor(sb.root, SLUG));
  const entries = Object.values(dispatch.dispatches);
  assert.ok(entries.length > 0, 'the step admitted at least one task');
  assert.ok(entries.every((entry) => entry.mode === 'sequential'), JSON.stringify(entries.map(({ task, mode }) => ({ task, mode }))));
  for (const entry of entries) {
    assert.equal(entry.selection.reason, 'no-eligible-worker', `${entry.task}: ${JSON.stringify(entry.selection)}`);
    assert.ok(entry.selection.candidates.length > 0);
    for (const candidate of entry.selection.candidates) {
      const gap = candidate.gaps.find((item) => item.requirement === 'billing');
      assert.equal(gap?.result, 'failed', `${candidate.harness}: ${JSON.stringify(candidate.gaps)}`);
      assert.equal(gap?.reason, `billing:${descriptors[candidate.harness].billing}`);
    }
  }
  assert.equal(fs.existsSync(sb.log), false, 'no fake harness process was launched');
});

test('a free fake worker launches under the cap', POSIX, async (t) => {
  const scenario = { run: [{ write: { path: 'src/retry.js', content: '// free worker\n' } }, { emit: SUCCESS }] };
  const sb = makeDispatchSandbox(t, {
    plan: 'budget', slug: SLUG, scenario,
    identity: { DOFLOW_ATTEMPT: undefined },
  });
  const descriptors = billingDescriptors(sb, 'free');
  const started = await start(sb, descriptors, 'free');
  assert.equal(started.body.disposition, 'started', JSON.stringify(started.body));
  assert.equal((await readiness.probe({ descriptors, env: sb.env, cwd: sb.root })).disposition, 'probed');

  const stepped = await command(sb, descriptors, { action: 'step', by: 'main' });
  assert.equal(stepped.body.disposition, 'stepped', JSON.stringify(stepped.body));
  const dispatches = Object.values(readDispatch(storeFileFor(sb.root, SLUG)).dispatches);
  assert.equal(dispatches.length, 1);
  assert.deepEqual([dispatches[0].mode, dispatches[0].harness, dispatches[0].selection.chosen], ['subagent', 'claude', 'claude']);
  assert.match(dispatches[0].workerRunId, /^w-[0-9a-f]{12}$/);
  assert.match(fs.readFileSync(sb.log, 'utf8'), /--edit-in-cwd/);
});

test('without a cap, a metered fake worker keeps the existing launch path', POSIX, async (t) => {
  const scenario = { run: [{ write: { path: 'src/retry.js', content: '// uncapped worker\n' } }, { emit: SUCCESS }] };
  const sb = makeDispatchSandbox(t, {
    plan: 'budget', slug: SLUG, scenario,
    identity: { DOFLOW_ATTEMPT: undefined },
  });
  const descriptors = billingDescriptors(sb, 'metered');
  const started = await start(sb, descriptors);
  assert.equal(started.body.disposition, 'started', JSON.stringify(started.body));
  assert.equal((await readiness.probe({ descriptors, env: sb.env, cwd: sb.root })).disposition, 'probed');

  const stepped = await command(sb, descriptors, { action: 'step', by: 'main' });
  assert.equal(stepped.body.disposition, 'stepped', JSON.stringify(stepped.body));
  const [dispatch] = Object.values(readDispatch(storeFileFor(sb.root, SLUG)).dispatches);
  assert.deepEqual([dispatch.mode, dispatch.harness, dispatch.selection.chosen], ['subagent', 'claude', 'claude']);
  assert.match(dispatch.workerRunId, /^w-[0-9a-f]{12}$/);
  assert.match(fs.readFileSync(sb.log, 'utf8'), /--edit-in-cwd/);
});
