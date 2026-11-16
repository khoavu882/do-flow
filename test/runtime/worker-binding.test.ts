'use strict';

// Feature 120 E.3 (IC-012, IC-014): task bindings gate selection and launch;
// describe and doctor report bindings without changing task-free eligibility.
// Every filesystem reader receives an isolated home and config directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');
const { loadRegistry } = require('../../src/registry/index.ts');
const { resolveTier, readBindings, resolveBinding, bindingGap, bindingsOf } = require('../../src/runtime/worker/models.ts');
const readiness = require('../../src/runtime/worker/readiness.ts');
const { executeWorkerCommand } = require('../../src/runtime/worker/command.ts');
const { superviseRun } = require('../../src/runtime/worker/supervisor.ts');
const { launchEnv, launchRecord } = require('../../src/runtime/worker/launch.ts');
const runs = require('../../src/runtime/worker/run-store.ts');
const attempts = require('../../src/runtime/task-attempts.ts');
const loop = require('../../src/runtime/dispatch/loop.ts');
const store = require('../../src/runtime/dispatch/store.ts');
const { createIntegrationWorktree } = require('../../src/runtime/dispatch/integrate.ts');
const { workersDoctorView } = require('../../src/runtime/health.ts');

const REG = loadRegistry({ repoRoot: REPO });
const NOW = Date.parse('2026-10-24T00:00:00Z');
const SLUG = '120-binding-fixture';
const POSIX = { skip: process.platform === 'win32' && 'worker process control is unverified on win32' };
const SUP = {
  ...structuredClone(DESCRIPTORS.claude),
  model: {
    status: 'supported', evidence: ['x'], verification: 'v',
    verifiedOn: '2026-10-24', argv: ['-m', '{model}'],
  },
};
const DEFAULT = { model: null, source: 'harness-default', flag: 'n/a' };
const INVALID = { state: 'invalid', map: null, reason: 'invalid' };
const UNSET = { state: 'unset', map: null, reason: null };
const set = (map: any) => ({ state: 'set', map, reason: null });
const GAP_INVALID = { requirement: 'binding', result: 'failed', reason: 'binding:invalid' };
const GAP_FLAG = { requirement: 'binding', result: 'failed', reason: 'model-flag:unevidenced' };
const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', '',
].join('\n');

test('IC-012: resolveBinding and bindingGap implement every table row', () => {
  const base = { worker: 'claude', tier: 'standard', descriptor: SUP };
  for (const bindings of [undefined, UNSET, set({}), set({ antigravity: { standard: 'm' } }), set({ claude: { light: 'm' } })]) {
    const result = resolveBinding({ ...base, bindings });
    assert.deepEqual(result, DEFAULT);
    assert.equal(bindingGap(result), null);
  }
  const bound = set({ claude: { standard: 'm' } });
  const supported = resolveBinding({ ...base, bindings: bound });
  assert.deepEqual(supported, { model: 'm', source: 'binding', flag: 'supported', choice: { model: 'm', provider: null, effort: null } });
  assert.equal(bindingGap(supported), null);
  for (const descriptor of [
    undefined, DESCRIPTORS.claude,
    { model: { status: 'unknown', argv: ['-m', '{model}'] } },
    { model: { status: 'supported' } },
    { model: { status: 'supported', argv: '-m {model}' } },
  ]) {
    const result = resolveBinding({ ...base, descriptor, bindings: bound });
    assert.deepEqual(result, { model: 'm', source: 'binding', flag: 'unevidenced', choice: { model: 'm', provider: null, effort: null } });
    assert.deepEqual(bindingGap(result), GAP_FLAG);
  }
  const invalid = resolveBinding({ ...base, bindings: INVALID });
  assert.deepEqual(invalid, { model: null, source: 'invalid', flag: 'n/a' });
  assert.deepEqual(bindingGap(invalid), GAP_INVALID);
});

const PART = { evidence: ['x'], verification: 'v', verifiedOn: '2026-11-16' };
const EFFORT = { status: 'supported', ...PART, via: 'flag', argv: ['--thinking', '{effort}'], levels: ['low', 'high'] };
const PROVIDER = { status: 'supported', ...PART, via: 'id-prefix', separator: '/' };
const WITH_PARTS = { ...SUP, provider: PROVIDER, effort: EFFORT };

test('169: resolveBinding reads a slot through choiceOf; bindingGap names an unsupported provider, effort or level in order', () => {
  const base = { worker: 'claude', tier: 'standard' };
  const slot = (value: any) => set({ claude: { standard: value } });
  const bound = resolveBinding({ ...base, descriptor: WITH_PARTS, bindings: slot({ model: 'm', provider: 'openai', effort: 'high' }) });
  assert.deepEqual([bound.model, bound.choice], ['m', { model: 'm', provider: 'openai', effort: 'high' }]);
  assert.equal(bindingGap(bound), null);
  const gap = (descriptor: any, value: any) => bindingGap(resolveBinding({ ...base, descriptor, bindings: slot(value) }))?.reason ?? null;
  const entry = (status: string) => ({ status, evidence: [], verification: 'v', verifiedOn: '2026-11-16', reason: 'none recorded' });
  assert.equal(gap(SUP, { model: 'm', provider: 'openai' }), 'provider:unsupported');
  assert.equal(gap({ ...SUP, provider: entry('unknown') }, { model: 'm', provider: 'openai' }), 'provider:unsupported');
  assert.equal(gap({ ...SUP, effort: entry('unknown') }, { model: 'm', effort: 'high' }), 'effort:unsupported');
  assert.equal(gap({ ...SUP, effort: entry('unsupported') }, { model: 'm', effort: 'high' }), 'effort:unsupported');
  assert.equal(gap(WITH_PARTS, { model: 'm', effort: 'turbo' }), 'effort:unknown-level');
  assert.equal(gap({ ...WITH_PARTS, effort: { ...EFFORT, levels: 'per-model' } }, { model: 'm', effort: 'turbo' }), null);
  assert.equal(gap(WITH_PARTS, { model: 'm', provider: 'openai', effort: 'turbo' }), 'effort:unknown-level');
  assert.equal(gap(SUP, { model: 'm', provider: 'openai', effort: 'turbo' }), 'provider:unsupported', 'provider is named before effort');
  assert.equal(gap(DESCRIPTORS.claude, { model: 'm', effort: 'high' }), 'model-flag:unevidenced', 'the model flag is named first');
  assert.equal(gap(SUP, 'm'), null);
  for (const unreadable of [{ model: 'm', effort: 7 }, { provider: 'openai' }, '', 7]) {
    const result = resolveBinding({ ...base, descriptor: SUP, bindings: slot(unreadable) });
    assert.deepEqual([result.model, result.source], [null, 'invalid'], JSON.stringify(unreadable));
  }
});

test('169: models.enabled compares the model id only', () => {
  const bindings = set({ claude: { standard: { model: 'm', provider: 'openai' } } });
  const on = resolveBinding({ worker: 'claude', tier: 'standard', descriptor: WITH_PARTS, bindings, allowedModels: ['m'] });
  assert.equal(on.enabledStatus, 'enabled');
  const off = resolveBinding({ worker: 'claude', tier: 'standard', descriptor: WITH_PARTS, bindings, allowedModels: ['openai/m'] });
  assert.equal(off.enabledStatus, 'disabled');
});

test('169: a bound effort reaches the launch record and the worker argv; an unsupported one is refused before the run', POSIX, async (t) => {
  const p = workerProject(t);
  const descriptors = { claude: WITH_PARTS };
  assert.equal((await readiness.probe({ descriptors, env: p.sb.env, cwd: p.sb.root })).disposition, 'probed');
  const binding = { model: 'm1', provider: 'openai', effort: 'high', flag: 'supported' };
  const result = await executeWorkerCommand({
    action: 'run', slug: SLUG, harness: 'claude', task: 'A.1', token: p.token,
    promptFile: p.promptFile, timeoutSeconds: 60, wait: true, env: p.sb.env, cwd: p.sb.root, descriptors, binding,
  });
  assert.equal(result.exit, 0, JSON.stringify(result));
  const record = runs.readRuns(p.file)[result.body.runId];
  assert.deepEqual(record.binding, binding);
  assert.ok(record.recipe.argvShape.includes('{provider}/{model}'));
  assert.ok(record.recipe.argvShape.includes('{effort}'));
  const logged = fs.readFileSync(p.sb.log, 'utf8').trim().split('\n').map((line: any) => JSON.parse(line)).find((entry: any) => entry.workerRun === record.runId);
  assert.equal(logged.argv[logged.argv.indexOf('-m') + 1], 'openai/m1');
  assert.equal(logged.argv[logged.argv.indexOf('--thinking') + 1], 'high');
});

test('169: the ladder refuses a rung whose bound effort the harness cannot take, before any launch', POSIX, async (t) => {
  const sb = makeDispatchSandbox(t, { plan: PLAN, slug: SLUG, identity: { DOFLOW_ATTEMPT: undefined } });
  const common = { file: attempts.storeFile(sb.root, SLUG), fsImpl: fs, roots: [sb.root], slug: SLUG, env: sb.env, cwd: sb.root };
  const started = attempts.start({ ...common, by: 'main' });
  assert.equal(started.disposition, 'started');
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root: sb.root, slug: SLUG, dispatchRunId, env: sb.env });
  const file = store.storeFileFor(sb.root, SLUG);
  store.mutateDispatch(file, (s: any) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch,
      concurrency: 1, mode: 'auto', reserveTokens: 1000, attemptSeconds: 60, harness: null,
      needs: [], spawnGrant: null, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 },
      fallback: { mode: 'auto', ladder: ['claude'], exhausted: [], holds: {}, events: [], eventsDropped: 0, inSession: true },
    };
    return { write: true, result: null };
  });
  const settings = path.join(sb.home, '.config', 'doflow', 'settings.json');
  const unknownEffort = { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-11-16', reason: 'none recorded' };
  const result = await loop.step({
    slug: SLUG, env: sb.env, cwd: sb.root, by: 'main', descriptors: { claude: { ...sb.descriptors.claude, model: SUP.model, effort: unknownEffort } },
    evaluateImpl: () => {
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, JSON.stringify({ schema: 1, 'workers.models': { claude: { standard: { model: 'm1', effort: 'high' } } } }));
      return { eligible: true, gaps: [] };
    },
  });
  const dispatch = Object.values(store.readDispatch(file).dispatches)[0];
  assert.ok(dispatch, JSON.stringify(result));
  assert.ok(result.actions.some((a: any) => a.action === 'launch' && a.reason === 'refused:effort:unsupported'), JSON.stringify(result.actions));
  assert.deepEqual(runs.readRuns(runs.storeFileFor(sb.root, SLUG)), {});
});

test('IC-012: inherited worker and tier names never become bindings', () => {
  for (const key of ['constructor', '__proto__']) {
    assert.deepEqual(resolveBinding({ worker: key, tier: 'standard', bindings: set({}), descriptor: SUP }), DEFAULT);
    assert.deepEqual(resolveBinding({
      worker: 'claude', tier: key, bindings: set({ claude: {} }), descriptor: SUP,
    }), DEFAULT);
  }
  assert.deepEqual(resolveBinding({
    worker: 'claude', tier: 'standard',
    bindings: set(Object.create({ claude: { standard: 'inherited' } })), descriptor: SUP,
  }), DEFAULT);
  assert.deepEqual(resolveBinding({
    worker: 'claude', tier: 'standard',
    bindings: set({ claude: Object.create({ standard: 'inherited' }) }), descriptor: SUP,
  }), DEFAULT);
});

test('IC-012: readBindings is fresh, global-only and returns a copy', (t) => {
  const f = createSettingsEnv(t);
  const env = f.env({ PATH: '' });
  const input = { env, projectRoot: f.project };
  assert.deepEqual(readBindings(input), UNSET);
  f.writeUserSettings({ schema: 1, 'workers.models': { claude: { standard: 'm1' } } });
  f.writeProjectSettings({ schema: 1, 'workers.models': { claude: { standard: 'project-model' } } });
  const first = readBindings(input);
  assert.deepEqual(first, set({ claude: { standard: 'm1' } }));
  first.map.claude.standard = 'changed';
  assert.deepEqual(readBindings(input), set({ claude: { standard: 'm1' } }));
  f.writeUserSettings({ schema: 1, 'workers.models': { claude: { standard: 'm2' } } });
  assert.deepEqual(readBindings(input), set({ claude: { standard: 'm2' } }));
});

test('IC-012: invalid bindings and a missing config home fail closed without values in reasons', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'workers.models': { claude: { ultra: 'private-model' } } });
  const invalid = readBindings({ env: f.env({ PATH: '' }), projectRoot: f.project });
  assert.equal(invalid.state, 'invalid');
  assert.equal(invalid.map, null);
  assert.equal(typeof invalid.reason, 'string');
  assert.equal(invalid.reason.includes('ultra'), false);
  assert.equal(invalid.reason.includes('private-model'), false);
  f.writeUserSettings('{ broken');
  assert.equal(readBindings({ env: f.env({ PATH: '' }), projectRoot: f.project }).state, 'invalid');
  const noHome = readBindings({ env: { PATH: '' } });
  assert.deepEqual(noHome, { state: 'invalid', map: null, reason: 'no-config-home' });
});

test('IC-012: moved resolveTier preserves task, owner and default precedence', () => {
  const dispatchTiers = REG.dispatchTiers;
  const missing: any[] = [];
  assert.deepEqual(resolveTier({ dispatchTiers, owner: 'core-implementer', tier: 'frontier', missing }), {
    tier: 'frontier', source: 'task',
  });
  assert.deepEqual(resolveTier({ dispatchTiers, owner: 'core-implementer', tier: null, missing }), {
    tier: 'standard', source: 'owner',
  });
  assert.equal(resolveTier({ dispatchTiers, owner: 'not-an-owner', tier: null, missing }).tier, dispatchTiers.default);
  assert.equal(resolveTier({ owner: null, tier: null, missing }).tier, 'standard');
});

const cand = (harness: any, eligible = true) => ({
  harness, eligible,
  gaps: eligible ? [] : [{ requirement: 'installed', result: 'unknown', reason: 'not-probed' }],
});

function select(candidates: any, extra = {}) {
  const cache = { candidates: structuredClone(candidates) };
  const before = structuredClone(cache.candidates);
  const choice = loop.selectMode({
    policy: 'auto', registry: REG, owner: 'core-implementer',
    descriptors: { claude: SUP, antigravity: DESCRIPTORS.antigravity }, cache, ...extra,
  });
  assert.deepEqual(cache.candidates, before, 'per-task binding gates must not mutate the cache');
  return choice;
}

test('IC-012: per-task bindings skip unevidenced rungs and retain exact gaps', () => {
  const candidates = [cand('claude'), cand('antigravity')];
  assert.equal(select(candidates, { bindings: set({ claude: { standard: 'm' } }) }).harness, 'claude');

  const antigravityBound = select(candidates, { bindings: set({ antigravity: { standard: 'm' } }) });
  assert.equal(antigravityBound.harness, 'claude');
  assert.deepEqual(antigravityBound.selection.candidates[1], {
    harness: 'antigravity', eligible: false, gaps: [GAP_FLAG],
  });

  const both = set({ claude: { standard: 'm1' }, antigravity: { standard: 'm2' } });
  const next = select(candidates, {
    bindings: both, descriptors: { claude: DESCRIPTORS.claude, antigravity: SUP },
  });
  assert.equal(next.harness, 'antigravity');
  assert.deepEqual(next.selection.candidates[0].gaps, [GAP_FLAG]);

  const invalid = select(candidates, { bindings: INVALID });
  assert.equal(invalid.mode, 'sequential');
  assert.equal(invalid.selection.chosen, 'sequential');
  assert.deepEqual(invalid.selection.candidates.map((c: any) => c.gaps), [[GAP_INVALID], [GAP_INVALID]]);

  const frontier = select(candidates, { tier: 'frontier', bindings: both });
  assert.equal(frontier.harness, 'claude');
  assert.deepEqual(frontier.selection.candidates, candidates);

  const alreadyFailed = [cand('claude', false), cand('antigravity')];
  const gated = select(alreadyFailed, { bindings: INVALID });
  assert.deepEqual(gated.selection.candidates[0], alreadyFailed[0]);

  const reordered = select(candidates, {
    bindings: both, descriptors: { claude: SUP, antigravity: DESCRIPTORS.antigravity },
    fallback: { mode: 'auto', ladder: ['antigravity', 'claude'], exhausted: [] },
  });
  assert.equal(reordered.harness, 'claude');
  assert.deepEqual(reordered.selection.candidates[0].gaps, [GAP_FLAG]);
});

test('the ladder gate reads the same main-session model as the launch for the orchestrator owner', () => {
  const candidates = [cand('claude'), cand('antigravity')];
  const bindings = set({ claude: { frontier: 'f1' } });
  const descriptors = { claude: DESCRIPTORS.claude, antigravity: SUP }; // claude has no evidenced model flag
  const owner = 'delivery-lead';
  // The main session is on claude: the orchestrator is its model, not the frontier binding the unevidenced flag would refuse.
  const session = { harness: 'claude', model: 'sess-1', state: 'confirmed' };
  assert.equal(select(candidates, { owner, bindings, descriptors, primary: session }).harness, 'claude');
  // With no main-session model the frontier binding applies, and claude is skipped for its flag.
  const without = select(candidates, { owner, bindings, descriptors, primary: null });
  assert.equal(without.harness, 'antigravity');
  assert.deepEqual(without.selection.candidates[0].gaps, [GAP_FLAG]);
});

test('IC-012 negative control: absent workers.models preserves every selection', (t) => {
  const f = createSettingsEnv(t);
  const bindings = readBindings({ env: f.env({ PATH: '' }), projectRoot: f.project });
  assert.deepEqual(bindings, UNSET);
  const variants: any[] = [{}, { tier: 'frontier' }, { policy: 'manual' }, { held: true }, { lastFailureClass: 'launch' }];
  for (const mode of ['off', 'ask', 'auto']) {
    variants.push({ fallback: { mode, ladder: ['claude', 'antigravity'], exhausted: ['claude'] } });
  }
  for (const candidates of [[cand('claude'), cand('antigravity')], [cand('claude', false), cand('antigravity', false)]]) {
    for (const extra of variants) {
      assert.deepEqual(select(candidates, { ...extra, bindings }), select(candidates, extra));
    }
  }
});

/** IC-012: an active claim with its own sandbox execution repository, using only fake CLIs. */
function workerProject(t: any) {
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const sb = makeDispatchSandbox(t, {
    plan: PLAN, slug: SLUG, identity: { DOFLOW_ATTEMPT: undefined },
    scenario: { run: [{ emit: { type: 'result', status: 'success', summary: 'done' } }] },
  });
  const execution = makeDispatchSandbox(t, { plan: PLAN, slug: SLUG });
  const common = {
    file: attempts.storeFile(sb.root, SLUG), fsImpl: fs, roots: [sb.root],
    slug: SLUG, env: sb.env, cwd: sb.root,
  };
  const started = attempts.start({ ...common, by: 'main' });
  assert.equal(started.disposition, 'started');
  const claimed = attempts.claim({
    ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent',
    epoch: started.epoch, execWorktree: execution.root,
  });
  assert.equal(claimed.disposition, 'claimed', JSON.stringify(claimed));
  const promptFile = path.join(sb.root, 'prompt.md');
  fs.writeFileSync(promptFile, 'do the task');
  return {
    sb, common, started, token: claimed.token, execWorktree: execution.root, promptFile,
    file: runs.storeFileFor(sb.root, SLUG),
  };
}

test('IC-012: supervisor forwards a bound run and omits binding on an unbound run', POSIX, async (t) => {
  for (const binding of [{ model: 'm1', flag: 'supported' }, null]) {
    const p = workerProject(t);
    const runId = runs.newRunId();
    const { identity } = launchEnv({
      env: p.sb.env, runKey: p.started.runKey, token: p.token, execWorktree: p.execWorktree, runId,
    });
    const prompt = fs.readFileSync(p.promptFile);
    const record = {
      runId, task: 'A.1', token: p.token, harness: 'claude', phase: 'starting',
      execWorktree: p.execWorktree, createdAt: new Date().toISOString(), timeoutSeconds: 60,
      ...launchRecord(SUP, identity, prompt.toString('utf8'), false, binding),
      ...(binding ? { binding } : {}),
      descriptor: SUP,
      prompt: {
        path: p.promptFile, sha256: crypto.createHash('sha256').update(prompt).digest('hex'), bytes: prompt.length,
      },
      needs: [],
    };
    assert.equal(runs.insertRun(p.file, record).applied, true);
    let captured: any;
    const ended = await superviseRun({
      file: p.file, runId, env: p.sb.env, cwd: p.sb.root,
      launch: async (options: any) => {
        captured = options;
        throw Object.assign(new Error('fixture stop'), { code: 'fixture-stop' });
      },
    });
    assert.equal(ended.process.reason, 'fixture-stop', JSON.stringify(ended));
    assert.ok(captured);
    if (binding) assert.deepEqual(captured.binding, binding);
    else {
      assert.equal(Object.hasOwn(captured, 'binding'), false);
      assert.equal(Object.hasOwn(runs.readRuns(p.file)[runId], 'binding'), false);
    }
  }
});

test('IC-012: command records a supported binding and its argv reaches the fake worker', POSIX, async (t) => {
  for (const binding of [{ model: 'm1', flag: 'supported' }, null]) {
    const p = workerProject(t);
    const descriptors = { claude: SUP };
    assert.equal((await readiness.probe({ descriptors, env: p.sb.env, cwd: p.sb.root })).disposition, 'probed');
    const result = await executeWorkerCommand({
      action: 'run', slug: SLUG, harness: 'claude', task: 'A.1', token: p.token,
      promptFile: p.promptFile, timeoutSeconds: 60, wait: true,
      env: p.sb.env, cwd: p.sb.root, descriptors,
      ...(binding ? { binding } : {}),
    });
    assert.equal(result.exit, 0, JSON.stringify(result));
    assert.equal(result.body.disposition, 'started');
    const record = runs.readRuns(p.file)[result.body.runId];
    assert.equal(record.phase, 'ended');
    const logged = fs.readFileSync(p.sb.log, 'utf8').trim().split('\n').map((line: any) => JSON.parse(line))
      .find((entry: any) => entry.workerRun === record.runId);
    assert.ok(logged, 'the fake worker was launched');
    if (binding) {
      assert.deepEqual(record.binding, { model: binding.model, provider: null, effort: null, flag: binding.flag });
      assert.ok(record.recipe.argvShape.includes('{model}'));
      const index = logged.argv.indexOf('-m');
      assert.ok(index >= 0);
      assert.equal(logged.argv[index + 1], binding.model);
    } else {
      assert.equal(Object.hasOwn(record, 'binding'), false);
      assert.equal(record.recipe.argvShape.includes('{model}'), false);
      assert.equal(logged.argv.includes('-m'), false);
    }
  }
});

test('IC-012: launch rechecks a newly unevidenced binding and denies before worker run', POSIX, async (t) => {
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const sb = makeDispatchSandbox(t, { plan: PLAN, slug: SLUG, identity: { DOFLOW_ATTEMPT: undefined } });
  const common = {
    file: attempts.storeFile(sb.root, SLUG), fsImpl: fs, roots: [sb.root],
    slug: SLUG, env: sb.env, cwd: sb.root,
  };
  const started = attempts.start({ ...common, by: 'main' });
  assert.equal(started.disposition, 'started');
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root: sb.root, slug: SLUG, dispatchRunId, env: sb.env });
  const file = store.storeFileFor(sb.root, SLUG);
  store.mutateDispatch(file, (s: any) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch,
      concurrency: 1, mode: 'auto', reserveTokens: 1000, attemptSeconds: 60, harness: null,
      needs: [], spawnGrant: null, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 },
      fallback: { mode: 'auto', ladder: ['claude'], exhausted: [], holds: {}, events: [], eventsDropped: 0, inSession: true },
    };
    return { write: true, result: null };
  });
  const settings = path.join(sb.home, '.config', 'doflow', 'settings.json');
  let evaluated = 0;
  const result = await loop.step({
    slug: SLUG, env: sb.env, cwd: sb.root, by: 'main', descriptors: { claude: sb.descriptors.claude },
    evaluateImpl: () => {
      evaluated += 1;
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, JSON.stringify({ schema: 1, 'workers.models': { claude: { standard: 'm1' } } }));
      return { eligible: true, gaps: [] };
    },
  });
  assert.equal(evaluated, 1);
  const dispatch = Object.values(store.readDispatch(file).dispatches)[0];
  assert.ok(dispatch, JSON.stringify(result));
  assert.deepEqual([dispatch.phase, dispatch.disposition, dispatch.failureClass], ['ended', 'failed', 'worker-denied']);
  assert.ok(result.actions.some((a: any) => a.action === 'launch' && a.reason === 'refused:model-flag:unevidenced'));
  assert.ok(result.actions.some((a: any) => a.action === 'finish' && a.reason === 'failed:worker-denied:model-flag:unevidenced'));
  assert.equal(dispatch.workerRunId == null, true);
  assert.equal(dispatch.envelopes == null || dispatch.envelopes.handoff == null, true);
  assert.deepEqual(runs.readRuns(runs.storeFileFor(sb.root, SLUG)), {});
});

test('IC-014: describe reports bindings while eligibility and probe fields stay unchanged', async (t) => {
  const f = createSettingsEnv(t);
  const env = f.env({ PATH: '' });
  const options = {
    action: 'describe', harness: 'claude', env, cwd: f.project, registry: REG,
    descriptors: { claude: DESCRIPTORS.claude }, now: () => new Date(NOW),
  };
  const plain = await executeWorkerCommand(options);
  assert.equal(plain.exit, 0);
  f.writeUserSettings({ schema: 1, 'workers.models': { claude: { light: 'm1' } } });
  const bound = await executeWorkerCommand(options);
  assert.deepEqual(bound.body.bindings, {
    light: { model: 'm1', flag: 'unevidenced' },
    standard: { model: null, flag: 'n/a' },
    frontier: { model: null, flag: 'n/a' },
  });
  for (const key of ['requirements', 'eligible', 'declared', 'probe']) {
    assert.deepEqual(bound.body[key], plain.body[key], key);
  }
  const supported = await executeWorkerCommand({ ...options, descriptors: { claude: SUP } });
  assert.deepEqual(supported.body.bindings.light, { model: 'm1', flag: 'supported' });
  f.writeUserSettings({ schema: 1, 'workers.models': { claude: { ultra: 'm1' } } });
  const invalid = await executeWorkerCommand(options);
  assert.deepEqual(invalid.body.bindings, {
    light: { model: null, flag: 'n/a' },
    standard: { model: null, flag: 'n/a' },
    frontier: { model: null, flag: 'n/a' },
  });
  for (const key of ['requirements', 'eligible', 'declared', 'probe']) {
    assert.deepEqual(invalid.body[key], plain.body[key], key);
  }
  const direct = readiness.describe({
    harness: 'claude', needs: [], descriptors: options.descriptors, registry: REG,
    env, cwd: f.project, now: NOW,
  });
  assert.equal(Object.hasOwn(direct, 'bindings'), false);
  assert.deepEqual(bindingsOf({
    worker: 'claude', descriptor: SUP, bindings: INVALID, tiers: REG.dispatchTiers.tiers,
  }), invalid.body.bindings);
});

test('IC-014: worker select has no task and ignores model bindings', async (t) => {
  const f = createSettingsEnv(t);
  const options = {
    action: 'select', env: f.env({ PATH: '' }), cwd: f.project,
    registry: REG, descriptors: { claude: SUP }, now: () => new Date(NOW),
  };
  const plain = await executeWorkerCommand(options);
  f.writeUserSettings({ schema: 1, 'workers.models': { claude: { light: 'm1' } } });
  assert.deepEqual(await executeWorkerCommand(options), plain);
  f.writeUserSettings({ schema: 1, 'workers.models': { claude: { ultra: 'm1' } } });
  assert.deepEqual(await executeWorkerCommand(options), plain);
});

test('IC-014 (169): doctor reports bound tiers with their IC-005 binding cell, and the binding state', (t) => {
  const f = createSettingsEnv(t);
  const options = {
    env: f.env({ PATH: '' }), projectRoot: f.project, repoRoot: REPO,
    descriptors: { claude: SUP, antigravity: DESCRIPTORS.antigravity }, now: NOW,
  };
  const plain = workersDoctorView(options);
  assert.deepEqual(plain.bindings, { state: 'unset', reason: null });
  assert.ok(plain.rows.every((row: any) => row.bound.length === 0));
  f.writeUserSettings({
    schema: 1, 'workers.models': { claude: { light: 'private-m1' }, antigravity: { frontier: 'private-m2' } },
  });
  const bound = workersDoctorView(options);
  assert.deepEqual(bound.bindings, { state: 'set', reason: null });
  const cell = (model: string) => ({ model, provider: null, effort: null, check: { model: 'unchecked', effort: null } });
  assert.deepEqual(bound.rows.find((row: any) => row.harness === 'claude').bound, [{ tier: 'light', flag: 'supported', binding: cell('private-m1') }]);
  assert.deepEqual(bound.rows.find((row: any) => row.harness === 'antigravity').bound, [{ tier: 'frontier', flag: 'unevidenced', binding: cell('private-m2') }]);
  for (let i = 0; i < plain.rows.length; i += 1) {
    assert.equal(bound.rows[i].eligible, plain.rows[i].eligible);
    assert.deepEqual(bound.rows[i].firstGap, plain.rows[i].firstGap);
  }
  f.writeUserSettings('{ broken');
  const invalid = workersDoctorView(options);
  assert.equal(invalid.bindings.state, 'invalid');
  assert.equal(typeof invalid.bindings.reason, 'string');
  assert.ok(invalid.rows.every((row: any) => row.bound.length === 0));
  const cli = f.run(['doctor'], { env: { PATH: '' } });
  assert.match(cli.stdout, /  workers\.models: invalid \(/);
  assert.match(cli.stdout, /worker claude: .*; bound tiers: none/);
});

test('IC-014 (169): doctor text names each bound tier with bindingText and its flag', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'workers.models': { claude: { light: 'private-doctor-model' } } });
  const cli = f.run(['doctor'], { env: { PATH: '' } });
  assert.match(cli.stdout, /worker claude: .*; bound tiers: light=private-doctor-model \[model unchecked\] \((?:supported|unevidenced)\)/);
});
