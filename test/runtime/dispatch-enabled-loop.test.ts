'use strict';

// Feature 120 C.5 (IC-009, IC-010): live worker gates at selection and launch.
// Pure selection uses a prefilled cache; loop cases use only sandbox fake CLIs.
// Temporary homes, config and PATH are isolated. No network or model calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { makeDispatchSandbox, editDescriptors } = require('../helper/dispatch-sandbox.ts');
const supervisor = require('../../src/runtime/worker/supervisor.ts');

// Match the quota stand-in in dispatch-fallback.test.js before loop captures resultOfRun.
const realResultOfRun = supervisor.resultOfRun;
supervisor.resultOfRun = (run: any) => {
  const out = realResultOfRun(run);
  const summary = String(run && run.report && run.report.summary ? run.report.summary : '').toLowerCase();
  if (!run || !run.report || run.report.status !== 'failure' || !summary.includes('rate limit')) return out;
  run.report.quota = run.report.quota || { signal: 'rate limit', basis: 'unverified' };
  return { resultOffered: false, withheld: out.withheld.map((r: any) => (r === 'report-failure' ? 'report-quota' : r)) };
};

const attempts = require('../../src/runtime/task-attempts.ts');
const readiness = require('../../src/runtime/worker/readiness.ts');
const store = require('../../src/runtime/dispatch/store.ts');
const { createIntegrationWorktree } = require('../../src/runtime/dispatch/integrate.ts');
const loop = require('../../src/runtime/dispatch/loop.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { resolveTier } = require('../../src/runtime/worker/models.ts');
supervisor.resultOfRun = realResultOfRun;

const REPO = path.join(__dirname, '..', '..');
const REG = loadRegistry({ repoRoot: REPO });
const SLUG = '120-enabled-loop-fixture';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const EDIT_ARGV = { claude: '--edit-in-cwd', gemini: '--gemini-edit-in-cwd' };
const SUCCESS = { type: 'result', status: 'success', summary: 'edited' };
const QUOTA = { type: 'result', status: 'failure', summary: 'Rate limit reached for this account' };
const SCENARIO = {
  byBinary: {
    'fake-claude': { run: [{ emit: QUOTA }] },
    'fake-gemini': { run: [{ write: { path: 'src/retry.js', content: '// stepped\n' } }, { emit: SUCCESS }] },
  },
};
const cand = (harness: any, eligible = true): any => ({
  harness, eligible,
  gaps: eligible ? [] : [{ requirement: 'installed', result: 'unknown', reason: 'not-probed' }],
});
const fb = (extra: any = {}): any => ({
  mode: 'ask', ladder: null, exhausted: [], holds: {}, events: [], eventsDropped: 0, ...extra,
});
const select = (candidates: any, extra: any = {}): any => loop.selectMode({
  policy: 'auto', registry: REG, cache: { candidates: structuredClone(candidates) }, ...extra,
});

/** IC-009: an activeWorkers result without reading any real settings. */
const act = (state: any, workers: any[] = [], inSession = false): any => ({
  state, workers, inSession, dangling: [],
  origin: { layer: state === 'unset' ? 'default' : 'user', source: null },
  reason: state === 'invalid' ? 'invalid' : null, narrowedFrom: null,
});

function assertSettingsHold(choice: any, reason: any) {
  assert.deepEqual(choice, {
    hold: { reason, from: null, proposed: null, transient: true },
    selection: { policy: 'auto', chosen: 'held', candidates: [] },
  });
}

test('IC-010 control: unset active equals no active across the existing first-pick inputs', () => {
  const eligible = [cand('claude', false), cand('codex'), cand('gemini')];
  const none = [cand('claude', false), cand('codex', false)];
  const inputs: any[] = [{}];
  for (const mode of ['off', 'ask', 'auto']) {
    inputs.push({ fallback: fb({ mode }) });
    inputs.push({ fallback: fb({ mode, exhausted: ['gemini'] }) });
  }
  inputs.push(
    { lastFailureClass: 'launch', fallback: fb({ mode: 'auto' }) },
    { lastFailureClass: 'launch', fallback: fb({ mode: 'auto', exhausted: ['gemini'] }) },
    { policy: 'manual', fallback: fb({ mode: 'auto', exhausted: ['codex'] }) },
    { held: true, fallback: fb({ mode: 'auto', exhausted: ['codex'] }) },
  );
  for (const candidates of [eligible, none, [cand('fixture-only')]]) {
    for (const extra of inputs) {
      assert.deepEqual(select(candidates, { ...extra, active: act('unset', [], true) }), select(candidates, extra));
    }
  }
});

test('IC-010: disabled workers fail the enabled gate before evaluation; gemini is selected', POSIX, (t) => {
  const home = tempDir(t, 'doflow-enabled-evaluation-');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: '' };
  const descriptors = editDescriptors();
  descriptors.gemini.isolatedEdit = structuredClone(descriptors.claude.isolatedEdit);
  const active = act('set', ['gemini'], true);
  const called: any[] = [];
  const candidates = loop.evaluateHarnesses({
    active, ladder: ['claude', 'gemini'], descriptors, registry: REG, env, cwd: home, root: home,
    evaluateImpl: ({ harness }: any) => {
      called.push(harness);
      return { eligible: true, gaps: [] };
    },
  });
  assert.deepEqual(candidates.find((c: any) => c.harness === 'claude'), {
    harness: 'claude', eligible: false,
    gaps: [{ requirement: 'enabled', result: 'failed', reason: 'worker-disabled' }],
  });
  assert.deepEqual(called, ['gemini']);
  assert.equal(select(candidates, { active }).harness, 'gemini');

  called.length = 0;
  const invalid = loop.evaluateHarnesses({
    active: act('invalid'), ladder: ['claude', 'gemini'], descriptors, registry: REG,
    env, cwd: home, root: home,
    evaluateImpl: ({ harness }: any) => { called.push(harness); return { eligible: true, gaps: [] }; },
  });
  assert.deepEqual(called, []);
  assert.ok(invalid.every((c: any) => !c.eligible && c.gaps[0].reason === 'workers-enabled-invalid'));

  called.length = 0;
  const unset = loop.evaluateHarnesses({
    active: act('unset', [], true), ladder: ['claude'], descriptors, registry: REG,
    env, cwd: home, root: home,
    evaluateImpl: ({ harness }: any) => { called.push(harness); return { eligible: true, gaps: [] }; },
  });
  assert.deepEqual(called, ['claude']);
  assert.equal(unset[0].eligible, true);
});

test('IC-010: first pick and both launch-failure shortcuts intersect current and stored permission', () => {
  const workers = ['claude', 'codex', 'gemini'];
  const permitted = act('set', workers, true);
  const none = [cand('claude', false), cand('codex', false)];
  const first = select(none, { active: permitted, fallback: fb({ inSession: true }) });
  assert.deepEqual([first.mode, first.harness, first.selection.chosen], ['sequential', null, 'sequential']);
  const variants = [
    { candidates: none, extra: {} },
    { candidates: [cand('claude')], extra: { lastFailureClass: 'launch' } },
    {
      candidates: [cand('claude'), cand('gemini')],
      extra: { lastFailureClass: 'launch', exhausted: ['gemini'] },
    },
  ];
  for (const { candidates, extra } of variants) {
    const fallback = fb({ inSession: true, ...(extra.exhausted ? { exhausted: extra.exhausted } : {}) });
    const options = { ...extra, fallback };
    assert.equal(select(candidates, { ...options, active: permitted }).mode, 'sequential');
    assertSettingsHold(select(candidates, {
      ...options, active: act('set', workers, false),
    }), 'no-enabled-worker');
    assertSettingsHold(select(candidates, {
      ...options, active: permitted, fallback: { ...fallback, inSession: false },
    }), 'no-enabled-worker');
  }
});

test('IC-010: invalid settings hold auto selection before candidates, launch shortcuts and quota steps', () => {
  const active = act('invalid');
  for (const extra of [
    {},
    { lastFailureClass: 'launch' },
    { owner: 'core-implementer', fallback: fb({ mode: 'auto', exhausted: ['claude'] }) },
    {
      lastFailureClass: 'launch', owner: 'core-implementer',
      fallback: fb({ mode: 'auto', exhausted: ['claude'] }),
      last: { harness: 'claude', failureClass: 'quota' },
    },
  ]) {
    assertSettingsHold(select([cand('claude'), cand('gemini')], { ...extra, active }), 'workers-enabled-invalid');
  }
  for (const extra of [{ policy: 'manual' }, { policy: 'sequential' }, { held: true }, { held: true, policy: 'manual' }]) {
    assert.deepEqual(select([cand('claude')], { ...extra, active }), select([cand('claude')], extra));
  }
});

test('IC-010: exhausted set ladders propose or step to sequential under the existing quota rules', () => {
  const candidates = [cand('claude')];
  const active = act('set', ['claude'], true);
  const options = {
    active, owner: 'core-implementer', task: 'A.1',
    last: { harness: 'claude', failureClass: 'quota' },
  };
  for (const [mode, proposed] of [['off', null], ['ask', 'sequential']]) {
    const choice = select(candidates, {
      ...options, fallback: fb({ mode, ladder: ['claude'], exhausted: ['claude'], inSession: true }),
    });
    assert.deepEqual(choice.hold, { reason: 'quota', from: 'claude', proposed });
    assert.equal(choice.selection.chosen, 'held');
  }
  for (const [mode, accepted] of [['auto', false], ['ask', true]]) {
    const choice = select(candidates, {
      ...options,
      fallback: fb({
        mode, ladder: ['claude'], exhausted: ['claude'], inSession: true,
        ...(accepted ? { accepted: { 'A.1': 'sequential' } } : {}),
      }),
    });
    assert.deepEqual([choice.mode, choice.harness, choice.selection.chosen], ['sequential', null, 'sequential']);
    assert.deepEqual(choice.selection.fallback, {
      kind: 'step', from: 'claude', to: 'sequential', ...(accepted ? { accepted: true } : {}),
    });
  }
  for (const extra of [
    { active: act('set', ['claude'], false) },
    { fallback: fb({ mode: 'auto', exhausted: ['claude'], inSession: false }) },
    { active: act('unset', ['claude'], true) },
    { active: undefined },
  ]) {
    const choice = select(candidates, {
      ...options, fallback: fb({ mode: 'auto', exhausted: ['claude'], inSession: true }), ...extra,
    });
    assert.deepEqual(choice.hold, { reason: 'ladder-exhausted', from: 'claude', proposed: null });
  }
  const frontier = select(candidates, {
    ...options, owner: 'system-architect',
    fallback: fb({ mode: 'auto', exhausted: ['claude'], inSession: true }),
  });
  assert.deepEqual(frontier.hold, { reason: 'frontier-no-step', from: 'claude', proposed: null });
});

/** IC-010: a started sandbox run whose stored fallback remains independent of live settings. */
async function project(t: any, { fallback = fb({ mode: 'auto', ladder: ['claude', 'gemini'], inSession: true }) } = {}) {
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const sb = makeDispatchSandbox(t, {
    plan: 'budget', slug: SLUG, scenario: SCENARIO, identity: { DOFLOW_ATTEMPT: undefined },
  });
  const { root } = sb;
  const env = { ...sb.env };
  const descriptors = structuredClone(sb.descriptors);
  descriptors.gemini.isolatedEdit = {
    ...structuredClone(descriptors.claude.isolatedEdit), argv: [EDIT_ARGV.gemini],
  };
  const ledgerFile = attempts.storeFile(root, SLUG);
  const started = attempts.start({ file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root, by: 'main' });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  store.mutateDispatch(file, (s: any) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch,
      concurrency: 1, mode: 'auto', reserveTokens: 1000, attemptSeconds: 60, harness: null,
      needs: [], spawnGrant: null, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 },
      fallback,
    };
    return { write: true, result: null };
  });
  assert.equal((await readiness.probe({ descriptors, env, cwd: root })).disposition, 'probed');
  const settings = path.join(sb.home, '.config', 'doflow', 'settings.json');
  const setList = (value: any) => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `${JSON.stringify({ schema: 1, 'workers.enabled': value })}\n`);
  };
  const options = (extra = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors, ...extra });
  const read = () => store.readDispatch(file);
  const byArgv = Object.fromEntries(Object.entries(EDIT_ARGV).map(([h, arg]) => [arg, h]));
  const ran = () => (fs.existsSync(sb.log)
    ? fs.readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean).map((line: any) => JSON.parse(line))
      .filter((entry: any) => Object.hasOwn(byArgv, entry.argv[0])).map((entry: any) => byArgv[entry.argv[0]])
    : []);
  return {
    sb, file, options, read, ran, setList,
    step: (extra: any = {}) => loop.step(options(extra)),
    run: (extra: any = {}) => loop.run(options({ maxSeconds: 60, ...extra })),
  };
}

const dispatches = (p: any) => Object.values(p.read().dispatches).sort((a, b) => a.token - b.token);

test('IC-013 loop: an unbound worker records the owner tier and harness default', POSIX, async (t) => {
  const p = await project(t);
  const tier = resolveTier({
    dispatchTiers: REG.dispatchTiers, owner: 'core-implementer', tier: null, missing: [],
  }).tier;
  await p.step();
  const [d] = dispatches(p);
  assert.equal(d.mode, 'subagent');
  assert.deepEqual(d.model, { tier, requested: null, source: 'harness-default', served: null });
  assert.equal(Object.hasOwn(d, 'primary'), false);
});

test('IC-013 / IC-010 loop: a sequential admission records the primary binding and snapshot', POSIX, async (t) => {
  const p = await project(t, {
    fallback: fb({ mode: 'auto', ladder: ['claude'], inSession: true }),
  });
  const tier = resolveTier({
    dispatchTiers: REG.dispatchTiers, owner: 'core-implementer', tier: null, missing: [],
  }).tier;
  const settings = path.join(p.sb.home, '.config', 'doflow', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, `${JSON.stringify({
    schema: 1,
    'primary.harness': 'claude',
    'workers.models': { claude: { [tier]: 'm-1' } },
  })}\n`);
  const result = await p.step();
  assert.equal(result.outcome, 'perform', JSON.stringify(result));
  const [d] = dispatches(p);
  assert.equal(d.mode, 'sequential');
  assert.deepEqual(d.model, { tier, requested: 'm-1', source: 'binding', served: null });
  assert.deepEqual(d.primary, { harness: 'claude', model: null, state: 'unconfirmed' });
  assert.deepEqual(p.ran(), []);
});

test('IC-010: disabling gemini mid-run narrows to an allowed sequential quota step', POSIX, async (t) => {
  const p = await project(t);
  p.setList(['claude', 'gemini', 'primary']);
  await p.step();
  assert.equal(dispatches(p)[0].harness, 'claude');
  p.setList(['claude', 'primary']);
  const result = await p.run();
  assert.equal(result.outcome, 'perform', JSON.stringify(result.last));
  assert.deepEqual(p.ran(), ['claude']);
  assert.deepEqual(dispatches(p).map((d) => [d.mode, d.harness]), [['subagent', 'claude'], ['sequential', null]]);
  assert.ok(p.read().run.fallback.events.some((event: any) => event.kind === 'step' && event.from === 'claude' && event.to === 'sequential'));
});

test('IC-010: disabling gemini and primary leaves the quota ladder exhausted', POSIX, async (t) => {
  const p = await project(t);
  p.setList(['claude', 'gemini', 'primary']);
  await p.step();
  p.setList(['claude']);
  const result = await p.run();
  assert.equal(result.outcome, 'blocked', JSON.stringify(result.last));
  assert.deepEqual(p.ran(), ['claude']);
  assert.deepEqual(p.read().run.fallback.holds['A.1'].reason, 'ladder-exhausted');
  assert.equal(result.last.blocked.cause, 'quota');
  assert.equal(dispatches(p).some((d) => d.mode === 'sequential'), false);
});

test('IC-010: adding primary cannot widen a run that stored inSession false', POSIX, async (t) => {
  const p = await project(t, {
    fallback: fb({ mode: 'auto', ladder: ['claude', 'gemini'], inSession: false }),
  });
  p.setList(['claude', 'gemini']);
  await p.step();
  p.setList(['claude', 'primary']);
  const result = await p.run();
  assert.equal(result.outcome, 'blocked', JSON.stringify(result.last));
  assert.deepEqual(p.ran(), ['claude']);
  assert.equal(p.read().run.fallback.holds['A.1'].reason, 'ladder-exhausted');
  assert.equal(dispatches(p).some((d) => d.mode === 'sequential'), false);
});

test('IC-010: invalid mid-run settings hold transiently and a valid rewrite releases the task', POSIX, async (t) => {
  const p = await project(t);
  p.setList(['claude', 'gemini', 'primary']);
  await p.step();
  p.setList(['claude', 'held']);
  const result = await p.run();
  assert.equal(result.outcome, 'blocked', JSON.stringify(result.last));
  const actions = p.read().steps.flatMap((step: any) => step.actions);
  assert.ok(actions.some((action: any) => action.action === 'admit' && action.reason === 'skipped:held:workers-enabled-invalid'));
  assert.deepEqual(p.read().run.fallback.holds, {});
  assert.equal(p.read().run.fallback.events.some((event: any) => event.kind === 'hold'), false);
  const report = JSON.stringify(result.last.blocked);
  assert.ok(report.includes('workers-enabled-invalid'));
  assert.equal(result.last.blocked.cause, 'input');
  assert.equal(report.includes('["claude","held"]'), false);
  assert.deepEqual(p.ran(), ['claude']);

  p.setList(['claude', 'gemini', 'primary']);
  const resumed = await p.run();
  assert.equal(resumed.outcome, 'completed', JSON.stringify(resumed.last));
  assert.deepEqual(p.ran(), ['claude', 'gemini']);
  assert.deepEqual(p.read().run.fallback.holds, {});
});

test('IC-009 launch re-check: disabling the selected worker refuses before handoff or worker launch', POSIX, async (t) => {
  const p = await project(t);
  p.setList(['claude', 'gemini', 'primary']);
  let calls = 0;
  const first = await loop.step(p.options({
    evaluateImpl: () => {
      if (calls++ === 0) p.setList(['gemini', 'primary']);
      return { eligible: true, gaps: [] };
    },
  }));
  const failed = dispatches(p)[0];
  assert.deepEqual([failed.harness, failed.phase, failed.disposition, failed.failureClass], ['claude', 'ended', 'failed', 'worker-denied']);
  assert.ok(first.actions.some((action: any) => action.action === 'launch' && action.reason === 'refused:worker-disabled'));
  assert.ok(first.actions.some((action: any) => action.action === 'finish' && action.reason === 'failed:worker-denied:worker-disabled'));
  assert.equal(failed.workerRunId == null, true);
  assert.equal(failed.envelopes == null || failed.envelopes.handoff == null, true);
  assert.deepEqual(p.ran(), []);

  // IC-010: the disabled rung is skipped and the next eligible worker is selected.
  const next = await p.step();
  assert.ok(next.actions.some((action: any) => action.action === 'launch' && action.reason.startsWith('subagent:gemini')), JSON.stringify(next));
  assert.deepEqual(dispatches(p).map((d) => [d.mode, d.harness]), [['subagent', 'claude'], ['subagent', 'gemini']]);
  assert.ok(dispatches(p)[1].workerRunId);
});

test('IC-010 launch re-check: an ineligible remaining worker falls back to enabled primary', POSIX, async (t) => {
  const p = await project(t);
  p.setList(['claude', 'gemini', 'primary']);
  let calls = 0;
  const first = await p.step({
    evaluateImpl: ({ harness }: any) => {
      if (calls++ === 0) p.setList(['gemini', 'primary']);
      return harness === 'claude'
        ? { eligible: true, gaps: [] }
        : { eligible: false, gaps: [{ requirement: 'installed', result: 'unknown', reason: 'not-probed' }] };
    },
  });
  const failed = dispatches(p)[0];
  assert.deepEqual([failed.phase, failed.disposition, failed.failureClass], ['ended', 'failed', 'worker-denied']);
  assert.ok(first.actions.some((action: any) => action.action === 'launch' && action.reason === 'refused:worker-disabled'));
  assert.equal(failed.workerRunId == null, true);
  assert.equal(failed.envelopes == null || failed.envelopes.handoff == null, true);

  const evaluated: any[] = [];
  const next = await p.step({
    evaluateImpl: ({ harness }: any) => {
      evaluated.push(harness);
      return { eligible: false, gaps: [{ requirement: 'installed', result: 'unknown', reason: 'not-probed' }] };
    },
  });
  assert.deepEqual(evaluated, ['gemini']);
  assert.equal(next.outcome, 'perform', JSON.stringify(next));
  assert.deepEqual(dispatches(p).map((d) => [d.mode, d.harness]), [['subagent', 'claude'], ['sequential', null]]);
  assert.deepEqual(p.ran(), []);
});

test('IC-010 loop: a launch failure without primary holds with the in-session refusal text', POSIX, async (t) => {
  const p = await project(t, {
    fallback: fb({ mode: 'auto', ladder: ['claude'], inSession: false }),
  });
  p.setList(['claude']);
  const first = await p.step({
    evaluateImpl: () => {
      // Selection succeeds, but worker run must refuse the now-missing fake executable.
      fs.unlinkSync(path.join(p.sb.bin, 'fake-claude'));
      return { eligible: true, gaps: [] };
    },
  });
  const failed = dispatches(p)[0];
  assert.deepEqual([failed.phase, failed.disposition, failed.failureClass], ['ended', 'failed', 'launch']);
  assert.ok(first.actions.some((action: any) => action.action === 'finish' && action.reason.startsWith('failed:launch:')));
  assert.equal(failed.workerRunId == null, true);
  assert.ok(failed.envelopes.handoff);

  const next = await p.step();
  assert.equal(next.outcome, 'blocked', JSON.stringify(next));
  assert.ok(next.actions.some((action: any) => action.action === 'admit' && action.reason === 'skipped:held:no-enabled-worker'));
  assert.equal(next.blocked.cause, 'input');
  assert.ok(JSON.stringify(next.blocked).includes('no-enabled-worker: primary not enabled, do not run in-session'));
  assert.deepEqual(p.read().run.fallback.holds, {});
  assert.equal(dispatches(p).length, 1);
  assert.deepEqual(p.ran(), []);
});
