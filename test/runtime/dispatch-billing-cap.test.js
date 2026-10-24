'use strict';

// FR-018 / FR-019 / IC-012: dispatch start's free-only billing cap prevents paid worker selection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('../../src/cli/index.ts');
const { executeDispatchCommand, summaryLines } = require('../../src/runtime/dispatch/command.ts');
const readiness = require('../../src/runtime/worker/readiness.ts');
const { readRuns, storeFileFor: workerRunsFile } = require('../../src/runtime/worker/run-store.ts');
const { readDispatch, storeFileFor } = require('../../src/runtime/dispatch/store.ts');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');

const SLUG = '108-billing-fixture';
const SUCCESS = { type: 'result', status: 'success', summary: 'billing fixture complete' };
const POSIX = { skip: process.platform === 'win32' && 'dispatch worktree fixture is POSIX-only' };

function billingDescriptors(sb, claudeBilling) {
  const descriptors = structuredClone(sb.descriptors);
  for (const worker of Object.values(descriptors)) worker.billing = 'unknown';
  descriptors.claude.billing = claudeBilling;
  return descriptors;
}

// The real probe gives each probe command a fixed 2.5 s, which a loaded machine can exceed: the fact
// then reads `unknown`, the worker is judged not eligible and the step falls back. These tests prove
// the cap and the launch, not probe speed, so a timed-out probe is repeated until claude is eligible.
async function probeUntilEligible(sb, descriptors) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    last = await readiness.probe({ descriptors, env: sb.env, cwd: sb.root });
    assert.equal(last.disposition, 'probed');
    if (last.harnesses.find((entry) => entry.harness === 'claude')?.taskEligible.eligible) return last;
  }
  assert.fail(`claude never probed eligible: ${JSON.stringify(last.harnesses)}`);
}

// The launched fake worker keeps writing into the sandbox until its run ends; wait so cleanup is quiet.
async function waitEnded(sb, runId, ms = 30000) {
  const until = Date.now() + ms;
  let run = readRuns(workerRunsFile(sb.root, SLUG))[runId];
  while (run && run.phase !== 'ended' && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = readRuns(workerRunsFile(sb.root, SLUG))[runId];
  }
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
  await probeUntilEligible(sb, descriptors);

  const stepped = await command(sb, descriptors, { action: 'step', by: 'main' });
  assert.equal(stepped.body.disposition, 'stepped', JSON.stringify(stepped.body));
  const dispatches = Object.values(readDispatch(storeFileFor(sb.root, SLUG)).dispatches);
  assert.equal(dispatches.length, 1);
  assert.deepEqual([dispatches[0].mode, dispatches[0].harness, dispatches[0].selection.chosen], ['subagent', 'claude', 'claude']);
  assert.match(dispatches[0].workerRunId, /^w-[0-9a-f]{12}$/);
  await waitEnded(sb, dispatches[0].workerRunId);
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
  await probeUntilEligible(sb, descriptors);

  const stepped = await command(sb, descriptors, { action: 'step', by: 'main' });
  assert.equal(stepped.body.disposition, 'stepped', JSON.stringify(stepped.body));
  const [dispatch] = Object.values(readDispatch(storeFileFor(sb.root, SLUG)).dispatches);
  assert.deepEqual([dispatch.mode, dispatch.harness, dispatch.selection.chosen], ['subagent', 'claude', 'claude']);
  assert.match(dispatch.workerRunId, /^w-[0-9a-f]{12}$/);
  await waitEnded(sb, dispatch.workerRunId);
  assert.match(fs.readFileSync(sb.log, 'utf8'), /--edit-in-cwd/);
});

// ── the user's billing record (workers.billing) ──────────────────────────────────────────────────

const CLAUDE_FREE = { claude: { billing: 'free', asserted: '2026-10-23' } };
const ELIGIBLE = () => ({ eligible: true, gaps: [] });

/** Writes the record (any JSON value) as the sandbox's user settings, the only layer that counts. */
function writeUserRecord(sb, value) {
  const file = path.join(sb.env.XDG_CONFIG_HOME, 'doflow', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ schema: 1, 'workers.billing': value })}\n`);
}

function doflow(sb, args) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/doflow.js'), ...args], {
    cwd: sb.root, env: { ...process.env, ...sb.env }, encoding: 'utf8',
  });
}

/** Start under the free cap, run one step with every worker judged eligible by the stub, and return
 * the start result and the admitted dispatches. Whatever blocks a worker is the billing gate. */
async function cappedStep(sb, descriptors) {
  const started = await start(sb, descriptors, 'free');
  assert.equal(started.body.disposition, 'started', JSON.stringify(started.body));
  const stepped = await command(sb, descriptors, { action: 'step', by: 'main', evaluateImpl: ELIGIBLE });
  assert.equal(stepped.body.disposition, 'stepped', JSON.stringify(stepped.body));
  return { started, dispatches: Object.values(readDispatch(storeFileFor(sb.root, SLUG)).dispatches) };
}

const billingGap = (candidate) => candidate.gaps.find((item) => item.requirement === 'billing');

test('a user record of free lets an unknown claude launch under the cap and names its source', POSIX, async (t) => {
  const scenario = { run: [{ write: { path: 'src/retry.js', content: '// recorded free worker\n' } }, { emit: SUCCESS }] };
  const sb = makeDispatchSandbox(t, { plan: 'budget', slug: SLUG, scenario, identity: { DOFLOW_ATTEMPT: undefined } });
  const descriptors = billingDescriptors(sb, 'unknown');
  writeUserRecord(sb, CLAUDE_FREE);
  const started = await start(sb, descriptors, 'free');
  assert.equal(started.body.disposition, 'started', JSON.stringify(started.body));
  assert.deepEqual(started.body.billingRecord, { state: 'set', reason: null, workers: [{ harness: 'claude', billing: 'free', asserted: '2026-10-23' }] });
  assert.ok(summaryLines(started.body).includes('billing: claude free (user record, asserted 2026-10-23)'), summaryLines(started.body).join('\n'));
  await probeUntilEligible(sb, descriptors);

  const stepped = await command(sb, descriptors, { action: 'step', by: 'main' });
  assert.equal(stepped.body.disposition, 'stepped', JSON.stringify(stepped.body));
  const [dispatch] = Object.values(readDispatch(storeFileFor(sb.root, SLUG)).dispatches);
  assert.deepEqual([dispatch.mode, dispatch.harness, dispatch.selection.chosen], ['subagent', 'claude', 'claude']);
  const claude = dispatch.selection.candidates.find((c) => c.harness === 'claude');
  assert.deepEqual(claude.billing, { value: 'free', source: 'user-record', asserted: '2026-10-23' });
  for (const other of dispatch.selection.candidates.filter((c) => c.harness !== 'claude')) {
    assert.equal(billingGap(other).reason, 'billing:unknown');
    assert.equal(billingGap(other).source, 'registry');
    assert.equal('billing' in other, false, `${other.harness}: a candidate that failed the billing gate carries no billing`);
  }
  await waitEnded(sb, dispatch.workerRunId);
  assert.match(fs.readFileSync(sb.log, 'utf8'), /--edit-in-cwd/);
});

test('without a record the start result still names the cap and prints no billing line', POSIX, async (t) => {
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
  const started = await start(sb, billingDescriptors(sb, 'unknown'), 'free');
  assert.deepEqual(started.body.billingRecord, { state: 'absent', reason: null, workers: [] });
  assert.equal(summaryLines(started.body).length, 1);
});

for (const file of ['settings.json', 'settings.local.json']) {
  test(`the same record in the project's ${file} is ignored: no launch, billing:unknown`, POSIX, async (t) => {
    const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
    const descriptors = billingDescriptors(sb, 'unknown');
    const projectFile = path.join(sb.root, '.doflow', file);
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, `${JSON.stringify({ schema: 1, 'workers.billing': CLAUDE_FREE })}\n`);
    const { started, dispatches } = await cappedStep(sb, descriptors);
    assert.equal(started.body.billingRecord.state, 'absent');
    assert.ok(dispatches.length > 0 && dispatches.every((d) => d.mode === 'sequential'));
    for (const dispatch of dispatches) {
      for (const candidate of dispatch.selection.candidates) assert.equal(billingGap(candidate).reason, 'billing:unknown', candidate.harness);
    }
    assert.equal(fs.existsSync(sb.log), false, 'no fake harness process was launched');
    const shown = doflow(sb, ['config', '--show-origin']);
    assert.ok(new RegExp(`${file.replace('.', '\\.')}: .* — ignored-scope`).test(shown.stdout), shown.stdout);
  });
}

for (const [label, value, reason] of [
  ['billing subscription', { claude: { billing: 'subscription', asserted: '2026-10-23' } }, "field 'billing'"],
  ['a missing asserted', { claude: { billing: 'free' } }, "field 'asserted'"],
  ['asserted 2026-02-30', { claude: { billing: 'free', asserted: '2026-02-30' } }, "field 'asserted'"],
  ['an extra field', { claude: { billing: 'free', asserted: '2026-10-23', extra: 1 } }, 'a field other than'],
  ['a non-object value', 'free', 'must be an object'],
  ['an unknown worker id', { agy: { billing: 'free', asserted: '2026-10-23' } }, 'unknown-worker:agy'],
]) {
  test(`a malformed record fails closed under the cap (${label}): every worker is billing:record-invalid`, POSIX, async (t) => {
    const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
    // claude is registry-free here, so only the invalid record can be what blocks it
    const descriptors = billingDescriptors(sb, 'free');
    writeUserRecord(sb, value);
    const { started, dispatches } = await cappedStep(sb, descriptors);
    assert.equal(started.body.billingRecord.state, 'invalid');
    assert.ok(started.body.billingRecord.reason.includes(reason), started.body.billingRecord.reason);
    assert.ok(summaryLines(started.body).some((line) => line.startsWith('billing: user record invalid (') && line.endsWith('): no worker counts as free')));
    assert.ok(dispatches.length > 0 && dispatches.every((d) => d.mode === 'sequential'));
    for (const dispatch of dispatches) {
      assert.ok(dispatch.selection.candidates.length > 0);
      for (const candidate of dispatch.selection.candidates) {
        const gap = billingGap(candidate);
        assert.equal(gap?.reason, 'billing:record-invalid', `${candidate.harness}: ${JSON.stringify(candidate)}`);
        assert.equal(gap.source, 'user-record');
        assert.ok(gap.recordReason.includes(reason), gap.recordReason);
        assert.equal('billing' in candidate, false);
      }
    }
    assert.equal(fs.existsSync(sb.log), false, 'no fake harness process was launched');
    // an id outside the registry is only known to the dispatch reader; the settings layer judges the rest
    if (!reason.startsWith('unknown-worker')) assert.equal(doflow(sb, ['config', '-g']).status, 1, 'config -g reports the invalid record as a security fault');
  });
}

test('a record of metered over a registry free worker refuses it; a record of free never lifts a registry metered one', POSIX, async (t) => {
  const narrowed = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
  writeUserRecord(narrowed, { claude: { billing: 'metered', asserted: '2026-10-23' } });
  const first = await cappedStep(narrowed, billingDescriptors(narrowed, 'free'));
  assert.ok(first.dispatches.every((d) => d.mode === 'sequential'));
  for (const dispatch of first.dispatches) {
    const gap = billingGap(dispatch.selection.candidates.find((c) => c.harness === 'claude'));
    assert.deepEqual([gap.reason, gap.source], ['billing:metered', 'user-record']);
  }

  const kept = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
  writeUserRecord(kept, CLAUDE_FREE);
  const second = await cappedStep(kept, billingDescriptors(kept, 'metered'));
  assert.ok(second.dispatches.every((d) => d.mode === 'sequential'));
  for (const dispatch of second.dispatches) {
    const gap = billingGap(dispatch.selection.candidates.find((c) => c.harness === 'claude'));
    assert.deepEqual([gap.reason, gap.source], ['billing:metered', 'registry']);
  }
});

test('uncapped, a record present changes nothing: no billing field on candidates and none on the start result', POSIX, async (t) => {
  const scenario = { run: [{ write: { path: 'src/retry.js', content: '// uncapped with a record\n' } }, { emit: SUCCESS }] };
  const sb = makeDispatchSandbox(t, { plan: 'budget', slug: SLUG, scenario, identity: { DOFLOW_ATTEMPT: undefined } });
  // unknown + a free record is what a leaked read would lift, so a leak shows as a billing field
  const descriptors = billingDescriptors(sb, 'unknown');
  writeUserRecord(sb, CLAUDE_FREE);
  const started = await start(sb, descriptors);
  assert.equal(started.body.disposition, 'started', JSON.stringify(started.body));
  assert.equal('billingRecord' in started.body, false);
  assert.equal(summaryLines(started.body).length, 1);
  await probeUntilEligible(sb, descriptors);

  const stepped = await command(sb, descriptors, { action: 'step', by: 'main' });
  assert.equal(stepped.body.disposition, 'stepped', JSON.stringify(stepped.body));
  const [dispatch] = Object.values(readDispatch(storeFileFor(sb.root, SLUG)).dispatches);
  assert.deepEqual([dispatch.mode, dispatch.harness], ['subagent', 'claude']);
  assert.ok(dispatch.selection.candidates.length > 0);
  for (const candidate of dispatch.selection.candidates) assert.equal('billing' in candidate, false, candidate.harness);
  await waitEnded(sb, dispatch.workerRunId);
});
