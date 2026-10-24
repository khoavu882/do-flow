'use strict';

// Feature 120 E.3 (IC-012, IC-014): task bindings gate selection and launch;
// describe and doctor report bindings without changing task-free eligibility.
// Every filesystem reader receives an isolated home and config directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');
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
const set = (map) => ({ state: 'set', map, reason: null });
const GAP_INVALID = { requirement: 'binding', result: 'failed', reason: 'binding:invalid' };
const GAP_FLAG = { requirement: 'binding', result: 'failed', reason: 'model-flag:unevidenced' };
const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', '',
].join('\n');

test('IC-012: resolveBinding and bindingGap implement every table row', () => {
  const base = { worker: 'claude', tier: 'standard', descriptor: SUP };
  for (const bindings of [undefined, UNSET, set({}), set({ gemini: { standard: 'm' } }), set({ claude: { light: 'm' } })]) {
    const result = resolveBinding({ ...base, bindings });
    assert.deepEqual(result, DEFAULT);
    assert.equal(bindingGap(result), null);
  }
  const bound = set({ claude: { standard: 'm' } });
  const supported = resolveBinding({ ...base, bindings: bound });
  assert.deepEqual(supported, { model: 'm', source: 'binding', flag: 'supported' });
  assert.equal(bindingGap(supported), null);
  for (const descriptor of [
    undefined, DESCRIPTORS.claude,
    { model: { status: 'unknown', argv: ['-m', '{model}'] } },
    { model: { status: 'supported' } },
    { model: { status: 'supported', argv: '-m {model}' } },
  ]) {
    const result = resolveBinding({ ...base, descriptor, bindings: bound });
    assert.deepEqual(result, { model: 'm', source: 'binding', flag: 'unevidenced' });
    assert.deepEqual(bindingGap(result), GAP_FLAG);
  }
  const invalid = resolveBinding({ ...base, bindings: INVALID });
  assert.deepEqual(invalid, { model: null, source: 'invalid', flag: 'n/a' });
  assert.deepEqual(bindingGap(invalid), GAP_INVALID);
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
  const missing = [];
  assert.deepEqual(resolveTier({ dispatchTiers, owner: 'core-implementer', tier: 'frontier', missing }), {
    tier: 'frontier', source: 'task',
  });
  assert.deepEqual(resolveTier({ dispatchTiers, owner: 'core-implementer', tier: null, missing }), {
    tier: 'standard', source: 'owner',
  });
  assert.equal(resolveTier({ dispatchTiers, owner: 'not-an-owner', tier: null, missing }).tier, dispatchTiers.default);
  assert.equal(resolveTier({ owner: null, tier: null, missing }).tier, 'standard');
});

const cand = (harness, eligible = true) => ({
  harness, eligible,
  gaps: eligible ? [] : [{ requirement: 'installed', result: 'unknown', reason: 'not-probed' }],
});

function select(candidates, extra = {}) {
  const cache = { candidates: structuredClone(candidates) };
  const before = structuredClone(cache.candidates);
  const choice = loop.selectMode({
    policy: 'auto', registry: REG, owner: 'core-implementer',
    descriptors: { claude: SUP, gemini: DESCRIPTORS.gemini }, cache, ...extra,
  });
  assert.deepEqual(cache.candidates, before, 'per-task binding gates must not mutate the cache');
  return choice;
}

test('IC-012: per-task bindings skip unevidenced rungs and retain exact gaps', () => {
  const candidates = [cand('claude'), cand('gemini')];
  assert.equal(select(candidates, { bindings: set({ claude: { standard: 'm' } }) }).harness, 'claude');

  const geminiBound = select(candidates, { bindings: set({ gemini: { standard: 'm' } }) });
  assert.equal(geminiBound.harness, 'claude');
  assert.deepEqual(geminiBound.selection.candidates[1], {
    harness: 'gemini', eligible: false, gaps: [GAP_FLAG],
  });

  const both = set({ claude: { standard: 'm1' }, gemini: { standard: 'm2' } });
  const next = select(candidates, {
    bindings: both, descriptors: { claude: DESCRIPTORS.claude, gemini: SUP },
  });
  assert.equal(next.harness, 'gemini');
  assert.deepEqual(next.selection.candidates[0].gaps, [GAP_FLAG]);

  const invalid = select(candidates, { bindings: INVALID });
  assert.equal(invalid.mode, 'sequential');
  assert.equal(invalid.selection.chosen, 'sequential');
  assert.deepEqual(invalid.selection.candidates.map((c) => c.gaps), [[GAP_INVALID], [GAP_INVALID]]);

  const frontier = select(candidates, { tier: 'frontier', bindings: both });
  assert.equal(frontier.harness, 'claude');
  assert.deepEqual(frontier.selection.candidates, candidates);

  const alreadyFailed = [cand('claude', false), cand('gemini')];
  const gated = select(alreadyFailed, { bindings: INVALID });
  assert.deepEqual(gated.selection.candidates[0], alreadyFailed[0]);

  const reordered = select(candidates, {
    bindings: both, descriptors: { claude: SUP, gemini: DESCRIPTORS.gemini },
    fallback: { mode: 'auto', ladder: ['gemini', 'claude'], exhausted: [] },
  });
  assert.equal(reordered.harness, 'claude');
  assert.deepEqual(reordered.selection.candidates[0].gaps, [GAP_FLAG]);
});

test('IC-012 negative control: absent workers.models preserves every selection', (t) => {
  const f = createSettingsEnv(t);
  const bindings = readBindings({ env: f.env({ PATH: '' }), projectRoot: f.project });
  assert.deepEqual(bindings, UNSET);
  const variants = [{}, { tier: 'frontier' }, { policy: 'manual' }, { held: true }, { lastFailureClass: 'launch' }];
  for (const mode of ['off', 'ask', 'auto']) {
    variants.push({ fallback: { mode, ladder: ['claude', 'gemini'], exhausted: ['claude'] } });
  }
  for (const candidates of [[cand('claude'), cand('gemini')], [cand('claude', false), cand('gemini', false)]]) {
    for (const extra of variants) {
      assert.deepEqual(select(candidates, { ...extra, bindings }), select(candidates, extra));
    }
  }
});

/** IC-012: an active claim with its own sandbox execution repository, using only fake CLIs. */
function workerProject(t) {
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
    let captured;
    const ended = await superviseRun({
      file: p.file, runId, env: p.sb.env, cwd: p.sb.root,
      launch: async (options) => {
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
    const logged = fs.readFileSync(p.sb.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .find((entry) => entry.workerRun === record.runId);
    assert.ok(logged, 'the fake worker was launched');
    if (binding) {
      assert.deepEqual(record.binding, binding);
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
  store.mutateDispatch(file, (s) => {
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
  assert.ok(result.actions.some((a) => a.action === 'launch' && a.reason === 'refused:model-flag:unevidenced'));
  assert.ok(result.actions.some((a) => a.action === 'finish' && a.reason === 'failed:worker-denied:model-flag:unevidenced'));
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

test('IC-014: doctor reports bound tiers and binding state without model ids', (t) => {
  const f = createSettingsEnv(t);
  const options = {
    env: f.env({ PATH: '' }), projectRoot: f.project, repoRoot: REPO,
    descriptors: { claude: SUP, gemini: DESCRIPTORS.gemini }, now: NOW,
  };
  const plain = workersDoctorView(options);
  assert.deepEqual(plain.bindings, { state: 'unset', reason: null });
  assert.ok(plain.rows.every((row) => row.bound.length === 0));
  f.writeUserSettings({
    schema: 1, 'workers.models': { claude: { light: 'private-m1' }, gemini: { frontier: 'private-m2' } },
  });
  const bound = workersDoctorView(options);
  assert.deepEqual(bound.bindings, { state: 'set', reason: null });
  assert.deepEqual(bound.rows.find((row) => row.harness === 'claude').bound, [{ tier: 'light', flag: 'supported' }]);
  assert.deepEqual(bound.rows.find((row) => row.harness === 'gemini').bound, [{ tier: 'frontier', flag: 'unevidenced' }]);
  assert.equal(JSON.stringify(bound).includes('private-m1'), false);
  assert.equal(JSON.stringify(bound).includes('private-m2'), false);
  for (let i = 0; i < plain.rows.length; i += 1) {
    assert.equal(bound.rows[i].eligible, plain.rows[i].eligible);
    assert.deepEqual(bound.rows[i].firstGap, plain.rows[i].firstGap);
  }
  f.writeUserSettings('{ broken');
  const invalid = workersDoctorView(options);
  assert.equal(invalid.bindings.state, 'invalid');
  assert.equal(typeof invalid.bindings.reason, 'string');
  assert.ok(invalid.rows.every((row) => row.bound.length === 0));
  const cli = f.run(['doctor'], { env: { PATH: '' } });
  assert.match(cli.stdout, /  workers\.models: invalid \(/);
  assert.match(cli.stdout, /worker claude: .*; bound tiers: none/);
});

test('IC-014: doctor text prints bound tier flags without printing model ids', (t) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'workers.models': { claude: { light: 'private-doctor-model' } } });
  const cli = f.run(['doctor'], { env: { PATH: '' } });
  assert.match(cli.stdout, /worker claude: .*; bound tiers: light\((?:supported|unevidenced)\)/);
  assert.equal(cli.stdout.includes('private-doctor-model'), false);
});
