'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Feature 084 — advisor shadowing: IC-001 (shadow-config), IC-002 (shadow-dispatcher, recording through
// record.ts) and IC-004 (elevation). The bench gate has its own file (advice-bench-gate.test.ts).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir, tempDir } = require('../helper/tmp.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../src/runtime/advice/record.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const {
  resolveShadowConfig,
} = require('../../src/runtime/advice/shadow-config.ts');

const {
  applyElevationInvariant,
} = require('../../src/runtime/advice/elevation.ts');

const {
  interceptDecisionPoint,
} = require('../../src/runtime/advice/shadow-dispatcher.ts');

const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const DISPATCHER = path.join(REPO_ROOT, 'src/runtime/advice/shadow-dispatcher.ts');

describe('IC-001: resolveShadowConfig (Per-Kind Shadow Configuration)', () => {
  function setupConfigEnv(settingsObj: any): { root: string; fsImpl: any; env: Record<string, string> } {
    const base = suiteTempDir('doflow-test-advice-cfg-');
    const root = path.join(base, 'proj');
    const fakeHome = path.join(base, 'fake-home');
    const settingsPath = path.join(root, '.doflow', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2), 'utf8');
    return { root, fsImpl: fs, env: { HOME: fakeHome } };
  }

  /** Local, project and user settings files written as given (text as-is, objects as JSON); undefined writes none. */
  function layers(t: any, { local, project, user }: any) {
    const base = tempDir(t, 'doflow-test-advice-layers-');
    const root = path.join(base, 'proj');
    const xdg = path.join(base, 'xdg');
    const files = {
      local: path.join(root, '.doflow', 'settings.local.json'),
      project: path.join(root, '.doflow', 'settings.json'),
      user: path.join(xdg, 'doflow', 'settings.json'),
    };
    for (const [layer, value] of Object.entries({ local, project, user })) {
      if (value === undefined) continue;
      const file = (files as any)[layer];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    }
    fs.mkdirSync(root, { recursive: true });
    return { root, files, env: { HOME: path.join(base, 'home'), XDG_CONFIG_HOME: xdg } };
  }

  test('defaults to mode: off when no settings are declared', () => {
    const { root, fsImpl, env } = setupConfigEnv({});
    const cfg = resolveShadowConfig('tier', { projectRoot: root, fsImpl, env });
    assert.equal(cfg.kind, 'tier');
    assert.equal(cfg.mode, 'off');
    assert.equal(cfg.model, null);
    assert.equal(cfg.kindSet, false);
    assert.deepEqual(cfg.diagnostics, []);
  });

  test('resolves off, shadow, and act modes per kind from advice.kinds.<kind>', () => {
    const { root, fsImpl, env } = setupConfigEnv({
      advice: {
        enabled: true,
        kinds: {
          tier: 'shadow',
          'task-class': 'off',
          'verify-risk': 'act',
        },
      },
    });

    const tierCfg = resolveShadowConfig('tier', { projectRoot: root, fsImpl, env });
    assert.equal(tierCfg.mode, 'shadow');

    const taskClassCfg = resolveShadowConfig('task-class', { projectRoot: root, fsImpl, env });
    assert.equal(taskClassCfg.mode, 'off');

    const verifyRiskCfg = resolveShadowConfig('verify-risk', { projectRoot: root, fsImpl, env });
    assert.equal(verifyRiskCfg.mode, 'act');
  });

  test('resolves per-kind model override from advice.models.<kind>', () => {
    const { root, fsImpl, env } = setupConfigEnv({
      advice: {
        enabled: true,
        model: 'global-default:7b',
        kinds: {
          tier: 'shadow',
          'review-depth': 'act',
        },
        models: {
          tier: 'qwen2.5-coder:1.5b',
        },
      },
    });

    const tierCfg = resolveShadowConfig('tier', { projectRoot: root, fsImpl, env });
    assert.equal(tierCfg.model, 'qwen2.5-coder:1.5b', 'per-kind model override should take precedence');

    const reviewCfg = resolveShadowConfig('review-depth', { projectRoot: root, fsImpl, env });
    assert.equal(reviewCfg.model, 'global-default:7b', 'should fall back to global advice.model');
  });

  test('advice.enabled = false strictly forces mode to off regardless of per-kind settings', () => {
    const { root, fsImpl, env } = setupConfigEnv({
      advice: {
        enabled: false,
        kinds: {
          tier: 'act',
          'review-depth': 'shadow',
        },
        models: {
          tier: 'qwen2.5-coder:1.5b',
        },
      },
    });

    const tierCfg = resolveShadowConfig('tier', { projectRoot: root, fsImpl, env });
    assert.equal(tierCfg.mode, 'off', 'disabled advice must force mode to off');

    const reviewCfg = resolveShadowConfig('review-depth', { projectRoot: root, fsImpl, env });
    assert.equal(reviewCfg.mode, 'off', 'disabled advice must force mode to off');
  });

  test('C-5: a present invalid value is off, never a lower layer\'s value, and still counts as set', (t) => {
    const { root, env } = layers(t, { local: { 'advice.kinds.tier': 'offf' }, user: { 'advice.kinds.tier': 'act' } });
    const cfg = resolveShadowConfig('tier', { projectRoot: root, env });
    assert.equal(cfg.mode, 'off');
    assert.equal(cfg.kindSet, true, 'an invalid value must not route the kind to the legacy path');
    assert.match(cfg.decidedBy.mode, /^local:/);
    assert.ok(cfg.diagnostics.some((d: string) => /advice\.kinds\.tier/.test(d) && /offf/.test(d)), JSON.stringify(cfg.diagnostics));
  });

  for (const [name, text] of [['corrupt JSON', '{"advice.kinds.tier": "off"'], ['a non-object JSON value', '[]']]) {
    test(`C-5: a project file with ${name} plus user act resolves to off`, (t) => {
      const { root, files, env } = layers(t, { project: text, user: { 'advice.kinds.tier': 'act' } });
      const cfg = resolveShadowConfig('tier', { projectRoot: root, env });
      assert.equal(cfg.mode, 'off');
      assert.equal(cfg.kindSet, true);
      assert.ok(cfg.diagnostics.some((d: string) => d.includes(files.project)), JSON.stringify(cfg.diagnostics));
    });
  }

  test('C-5: an unreadable project file plus user act resolves to off', (t) => {
    const { root, files, env } = layers(t, { project: { 'advice.kinds.tier': 'off' }, user: { 'advice.kinds.tier': 'act' } });
    const fsImpl = {
      ...fs,
      readFileSync: (file: any, ...rest: any[]) => {
        if (file === files.project) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return fs.readFileSync(file, ...rest);
      },
    };
    const cfg = resolveShadowConfig('tier', { projectRoot: root, env, fsImpl });
    assert.equal(cfg.mode, 'off');
    assert.ok(cfg.diagnostics.some((d: string) => d.includes(files.project)), JSON.stringify(cfg.diagnostics));
  });

  test('C-5: a corrupt layer with the kind set nowhere counts as set and is off, so the dispatcher asks nothing', async (t) => {
    const { root, files, env } = layers(t, { project: '{not json' });
    const cfg = resolveShadowConfig('tier', { projectRoot: root, env });
    assert.equal(cfg.kindSet, true, 'an unreadable config never takes the legacy ask');
    assert.equal(cfg.mode, 'off');
    assert.ok(cfg.diagnostics.some((d: string) => d.includes(files.project)), JSON.stringify(cfg.diagnostics));
    let asked = 0;
    const res = await interceptDecisionPoint(
      { kind: 'tier', caller: 'brief-tools', state: 's', staticPick: 'light', projectRoot: root, env },
      { adviceClient: { ask: async () => { asked += 1; return { status: 'answered', answers: [{ pick: 'frontier' }] }; } } },
    );
    assert.equal(res.mode, 'off');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asked, 0);
  });

  test('C-5: a valid local value decides over the user layer', (t) => {
    const { root, env } = layers(t, { local: { 'advice.kinds.tier': 'shadow' }, user: { 'advice.kinds.tier': 'act' } });
    const cfg = resolveShadowConfig('tier', { projectRoot: root, env });
    assert.equal(cfg.mode, 'shadow');
    assert.deepEqual(cfg.diagnostics, []);
  });
});

describe('IC-004: applyElevationInvariant (Elevation Filter Lattices)', () => {
  describe('tier lattice: light (0) < standard (1) < frontier (2)', () => {
    test('escalates tier when advisor recommends higher rigor', () => {
      const res1 = applyElevationInvariant('tier', 'light', 'standard');
      assert.equal(res1.effectiveDecision, 'standard');
      assert.equal(res1.elevated, true);

      const res2 = applyElevationInvariant('tier', 'standard', 'frontier');
      assert.equal(res2.effectiveDecision, 'frontier');
      assert.equal(res2.elevated, true);
    });

    test('forbids demoting tier when advisor recommends lower rigor', () => {
      const res1 = applyElevationInvariant('tier', 'frontier', 'light');
      assert.equal(res1.effectiveDecision, 'frontier');
      assert.equal(res1.elevated, false);

      const res2 = applyElevationInvariant('tier', 'standard', 'light');
      assert.equal(res2.effectiveDecision, 'standard');
      assert.equal(res2.elevated, false);
    });

    test('retains static pick when advisor agrees', () => {
      const res = applyElevationInvariant('tier', 'standard', 'standard');
      assert.equal(res.effectiveDecision, 'standard');
      assert.equal(res.elevated, false);
    });
  });

  describe('verify-risk lattice: low (0) < medium (1) < high (2)', () => {
    test('escalates risk when advisor recommends higher risk', () => {
      const res = applyElevationInvariant('verify-risk', 'low', 'high');
      assert.equal(res.effectiveDecision, 'high');
      assert.equal(res.elevated, true);
    });

    test('forbids lowering risk when advisor recommends lower risk', () => {
      const res = applyElevationInvariant('verify-risk', 'high', 'low');
      assert.equal(res.effectiveDecision, 'high');
      assert.equal(res.elevated, false);
    });
  });

  describe('review-depth lattice: single (0) < deep (1)', () => {
    test('escalates review depth from single to deep', () => {
      const res = applyElevationInvariant('review-depth', 'single', 'deep');
      assert.equal(res.effectiveDecision, 'deep');
      assert.equal(res.elevated, true);
    });

    test('forbids demoting review depth from deep to single', () => {
      const res = applyElevationInvariant('review-depth', 'deep', 'single');
      assert.equal(res.effectiveDecision, 'deep');
      assert.equal(res.elevated, false);
    });
  });

  describe('task-class lattice: trivial-edit < refactor/bug < feature', () => {
    test('escalates trivial-edit to bug or feature', () => {
      const res1 = applyElevationInvariant('task-class', 'trivial-edit', 'bug');
      assert.equal(res1.effectiveDecision, 'bug');
      assert.equal(res1.elevated, true);

      const res2 = applyElevationInvariant('task-class', 'bug', 'feature');
      assert.equal(res2.effectiveDecision, 'feature');
      assert.equal(res2.elevated, true);
    });

    test('forbids simplifying feature to bug or trivial-edit', () => {
      const res1 = applyElevationInvariant('task-class', 'feature', 'trivial-edit');
      assert.equal(res1.effectiveDecision, 'feature');
      assert.equal(res1.elevated, false);

      const res2 = applyElevationInvariant('task-class', 'feature', 'bug');
      assert.equal(res2.effectiveDecision, 'feature');
      assert.equal(res2.elevated, false);
    });
  });

  test('returns staticPick with elevated: false when advisorPick is null or invalid', () => {
    const res1 = applyElevationInvariant('tier', 'standard', null);
    assert.equal(res1.effectiveDecision, 'standard');
    assert.equal(res1.elevated, false);

    const res2 = applyElevationInvariant('tier', 'standard', 'unrecognized-tier');
    assert.equal(res2.effectiveDecision, 'standard');
    assert.equal(res2.elevated, false);
  });
});

describe('IC-002: interceptDecisionPoint (Decision Interception & Shadowing)', () => {
  const QUESTION_SET = {
    state: 'Implement an integration spanning several runtime modules.',
    questions: [{ name: 'tier', type: 'choice', instructions: 'Choose a tier.', options: { light: 'Light', standard: 'Standard', frontier: 'Frontier' } }],
  };

  /** The advice client's reply shape (client.ts ask). */
  function answered(pick: string, model = 'm') {
    return {
      status: 'answered', reason: null, model,
      answers: [{ name: 'tier', type: 'choice', pick, strength: { word: 'clear', between: null }, probabilities: { light: 0.1, standard: 0.1, frontier: 0.8 }, confidence: 0.8, pickId: null }],
    };
  }

  /** A client that answers `reply` (a value or a function of the ask options) and keeps every call. */
  function client(reply: any) {
    const calls: any[] = [];
    return {
      calls,
      ask: async (...args: any[]) => { calls.push(args); return typeof reply === 'function' ? reply(args[0]) : reply; },
    };
  }

  /** A project and a user home under one temp dir, the storage roots they resolve to, and the retained advice lines. */
  function store(t: any) {
    const dir = tempDir(t, 'doflow-advice-shadow-');
    const projectRoot = path.join(dir, 'proj');
    fs.mkdirSync(projectRoot);
    const env = { HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
    const roots = resolveRoots({ registry: STORAGE, projectRoot, env });
    return { dir, projectRoot, env, roots, lines: () => readWindow({ roots }).records.map((entry: any) => entry.record) };
  }

  function ctx(s: any, extra: any = {}) {
    return {
      kind: 'tier', caller: 'brief-tools', state: QUESTION_SET.state, staticPick: 'light', taskId: 'task-abc',
      questionSet: QUESTION_SET, adviceRegistry: { timeoutMs: 1000 }, projectRoot: s.projectRoot, env: s.env, ...extra,
    };
  }

  async function waitFor(check: () => any, ms = 1000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const value = check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return check();
  }

  const passGate = async () => ({ passed: true, reason: 'injected' });
  const failGate = async () => ({ passed: false, reason: 'injected failure' });

  test('mode off returns staticPick without asking the advisor or recording', async (t) => {
    const s = store(t);
    const c = client(answered('frontier'));
    const res = await interceptDecisionPoint(ctx(s), {
      adviceClient: c, roots: s.roots, shadowConfig: { kind: 'tier', mode: 'off', model: null },
    });
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.mode, 'off');
    assert.equal(res.advisorPick, null);
    assert.equal(res.pickId, null);
    assert.equal(res.elevated, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(c.calls.length, 0, 'off asks nothing');
    assert.deepEqual(s.lines(), []);
  });

  test('mode shadow returns staticPick at once and records the advisor pick through record.ts', async (t) => {
    const s = store(t);
    const c = client((options: any) => answered('frontier', options.model));
    const res = await interceptDecisionPoint(ctx(s), {
      adviceClient: c, roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'qwen2.5-coder:1.5b' },
    });
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.mode, 'shadow');
    assert.equal(res.staticPick, 'light');
    assert.equal(res.advisorPick, null, 'shadow never shows the pick');
    assert.match(res.pickId, /^adv-[0-9]{13}-[0-9a-f]{6}$/);
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.equal(c.calls.length, 1);
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.equal(line.type, 'pick');
    assert.equal(line.pickId, res.pickId);
    assert.equal(line.pick, 'frontier');
    assert.equal(line.static, 'light');
    assert.equal(line.mode, 'shadow');
    assert.equal(line.elevated, false);
    assert.equal(line.model, 'qwen2.5-coder:1.5b');
    assert.deepEqual(line.options, ['light', 'standard', 'frontier']);
    assert.match(line.stateDigest, /^sha256:[0-9a-f]{64}$/);
  });

  test('mode act applies the elevation invariant when the injected bench gate passes, and records act', async (t) => {
    const s = store(t);
    const c = client((options: any) => answered('standard', options.model));
    const res = await interceptDecisionPoint(ctx(s), {
      adviceClient: c, roots: s.roots, benchGate: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'verified-model:7b' },
    });
    assert.equal(res.mode, 'act');
    assert.equal(res.advisorPick, 'standard');
    assert.equal(res.effectiveDecision, 'standard', 'tier escalated from light to standard');
    assert.equal(res.elevated, true);
    const [line] = s.lines();
    assert.equal(line.pickId, res.pickId);
    assert.equal(line.mode, 'act');
    assert.equal(line.elevated, true);
    assert.equal(line.pick, 'standard');
    assert.equal(line.model, 'verified-model:7b');
  });

  test('mode act degrades to shadow with BENCH_BAR_UNMET, and the shadow query runs and records', async (t) => {
    const s = store(t);
    const c = client((options: any) => answered('frontier', options.model));
    const res = await interceptDecisionPoint(ctx(s), {
      adviceClient: c, roots: s.roots, benchGate: failGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'unverified-weak-model:0.5b' },
    });
    assert.equal(res.mode, 'shadow', 'mode must degrade to shadow when bench bar fails');
    assert.equal(res.effectiveDecision, 'light', 'effective decision remains staticPick on degradation');
    assert.equal(res.advisorPick, null);
    assert.equal(res.warning, 'BENCH_BAR_UNMET: injected failure');
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.equal(c.calls.length, 1, 'the degraded shadow query ran');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].mode, 'shadow');
    assert.equal(lines[0].pick, 'frontier');
    assert.equal(lines[0].model, 'unverified-weak-model:0.5b');
  });

  test('the advisor is asked with the advice client call shape, the effective model and no client recording', async (t) => {
    const s = store(t);
    const c = client(answered('frontier'));
    const res = await interceptDecisionPoint(ctx(s, { record: false }), {
      adviceClient: c, roots: s.roots, benchGate: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
    });
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].length, 1, 'ask takes one options object');
    const { signal, ...options } = c.calls[0][0];
    assert.ok(signal instanceof AbortSignal, 'the call carries the budget signal');
    assert.equal(signal.aborted, false, 'an answer inside the budget is not aborted');
    assert.deepEqual(options, {
      questionSet: QUESTION_SET, kind: 'tier', staticAnswer: 'light', caller: 'brief-tools', taskId: 'task-abc', record: false, model: 'm',
    });
    assert.equal(res.advisorPick, 'frontier');
    assert.equal(res.effectiveDecision, 'frontier');
    assert.deepEqual(s.lines(), [], 'record:false writes nothing');
  });

  test('C-3: the bar, the request and the record all name the per-kind model, not advice.model', async (t) => {
    const s = store(t);
    fs.mkdirSync(path.join(s.projectRoot, '.doflow'));
    fs.writeFileSync(path.join(s.projectRoot, '.doflow', 'settings.json'), JSON.stringify({
      'advice.kinds.tier': 'act', 'advice.models.tier': 'A', 'advice.model': 'B',
    }));
    const gated: string[] = [];
    const benchGate = async (_kind: string, model: string) => { gated.push(model); return { passed: model === 'A', reason: `bench for ${model}` }; };
    // Like the real client: without a model override it asks its own setting's model (B).
    const c = client((options: any) => answered('standard', options.model ?? 'B'));
    const res = await interceptDecisionPoint(ctx(s), { adviceClient: c, roots: s.roots, benchGate });
    assert.deepEqual(gated, ['A']);
    assert.equal(c.calls[0][0].model, 'A', 'the client request carries the benched model');
    assert.equal(res.mode, 'act');
    const [line] = s.lines();
    assert.equal(line.model, 'A', 'the record names the model that was asked');
  });

  test('C-3: act with no named model never passes the bar', async (t) => {
    const s = store(t);
    let gated = 0;
    const res = await interceptDecisionPoint(ctx(s, { record: false }), {
      adviceClient: client(answered('frontier')), roots: s.roots,
      benchGate: async () => { gated += 1; return { passed: true, reason: 'x' }; },
      shadowConfig: { kind: 'tier', mode: 'act', model: null },
    });
    assert.equal(res.mode, 'shadow');
    assert.match(res.warning, /^BENCH_BAR_UNMET: /);
    assert.equal(gated, 0);
  });

  test('C-4: an unavailable advisor in shadow mode records one miss with its reason and no pick', async (t) => {
    const s = store(t);
    const c = client({ status: 'unavailable', reason: 'timeout', model: 'm', answers: [] });
    await interceptDecisionPoint(ctx(s), { adviceClient: c, roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } });
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.equal(lines.filter((line: any) => line.type === 'miss').length, 1);
    assert.equal(lines.filter((line: any) => line.type === 'pick').length, 0);
    const [miss] = lines;
    assert.equal(miss.reason, 'timeout');
    assert.equal(miss.kind, 'tier');
    assert.equal(miss.caller, 'brief-tools');
    assert.equal(miss.mode, 'shadow');
    assert.equal(miss.model, 'm');
  });

  test('C-4: a malformed answer and a throwing client record a miss, never a pick', async (t) => {
    const s = store(t);
    const malformed = client({ status: 'answered', model: 'm', answers: [{ name: 'tier' }] });
    await interceptDecisionPoint(ctx(s), { adviceClient: malformed, roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } });
    const throwing = { ask: async () => { throw new Error('boom'); } };
    await interceptDecisionPoint(ctx(s), { adviceClient: throwing, roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } });
    const lines = await waitFor(() => s.lines().length >= 2 && s.lines());
    assert.deepEqual(lines.map((line: any) => [line.type, line.reason]), [['miss', 'malformed-reply'], ['miss', 'config-invalid']]);
  });

  test('shadow with record:false asks nothing and writes nothing, also when act degrades', async (t) => {
    const s = store(t);
    const c = client(answered('frontier'));
    const shadow = await interceptDecisionPoint(ctx(s, { record: false }), { adviceClient: c, roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } });
    const degraded = await interceptDecisionPoint(ctx(s, { record: false }), {
      adviceClient: c, roots: s.roots, benchGate: failGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
    });
    assert.deepEqual([shadow.mode, degraded.mode, shadow.effectiveDecision, degraded.effectiveDecision], ['shadow', 'shadow', 'light', 'light']);
    assert.match(degraded.warning, /^BENCH_BAR_UNMET: /);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(c.calls.length, 0, 'a shadow call that records nothing is pure spend');
    assert.deepEqual(s.lines(), []);
  });

  test('D2: a staged rollout profile caps a configured act to shadow', async (t) => {
    const s = store(t);
    fs.mkdirSync(path.join(s.projectRoot, '.doflow'));
    fs.writeFileSync(path.join(s.projectRoot, '.doflow', 'settings.json'), JSON.stringify({ rollout: { profile: 'staged' } }));
    const c = client((options: any) => answered('standard', options.model));
    let gated = 0;
    const res = await interceptDecisionPoint(ctx(s), {
      adviceClient: c, roots: s.roots, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
      benchGate: async () => { gated += 1; return { passed: true, reason: 'injected' }; },
    });
    assert.equal(res.mode, 'shadow');
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.advisorPick, null);
    assert.equal(gated, 0, 'a capped act never reaches the bench gate');
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.deepEqual(lines.map((line: any) => [line.type, line.mode, line.pick]), [['pick', 'shadow', 'standard']]);
  });

  test('C-4: no advisor pick in act mode keeps the static pick and records a miss', async (t) => {
    const s = store(t);
    const res = await interceptDecisionPoint(ctx(s), {
      adviceClient: client({ status: 'unavailable', reason: 'unreachable', answers: [] }), roots: s.roots,
      benchGate: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
    });
    assert.equal(res.advisorPick, null);
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.elevated, false);
    assert.deepEqual(s.lines().map((line: any) => [line.type, line.reason, line.mode]), [['miss', 'unreachable', 'act']]);
  });

  test('C-7: a dispatcher pick takes an outcome through advise outcome without a failure', async (t) => {
    const scratch = createScratch('doflow-advice-shadow-cli-');
    t.after(() => scratch.remove());
    const projectRoot = path.join(scratch.dir, 'project');
    fs.mkdirSync(projectRoot);
    const env = scratch.env();
    const roots = resolveRoots({ registry: STORAGE, projectRoot, env });
    const res = await interceptDecisionPoint(ctx({ projectRoot, env }), {
      adviceClient: client(answered('frontier')), roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' },
    });
    await waitFor(() => readWindow({ roots }).records.length);
    const run = spawnSync(bashPath(), [path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run'), 'advise',
      '--action', 'outcome', '--pick-id', res.pickId, '--actual', 'standard', '--json'], {
      cwd: projectRoot, env: scratch.env({ DOFLOW_CLI: path.join(REPO_ROOT, 'bin/doflow.js') }), encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).recorded, true);
  });

  test('C-7: a symlinked picks partition gets no write from the dispatcher', async (t) => {
    const s = store(t);
    const outside = tempDir(t, 'doflow-advice-shadow-outside-');
    const picks = path.join(s.roots['project-state'], 'advice', 'picks');
    fs.mkdirSync(path.dirname(picks), { recursive: true });
    fs.symlinkSync(outside, picks);
    const c = client(answered('frontier'));
    await interceptDecisionPoint(ctx(s), { adviceClient: c, roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } });
    await interceptDecisionPoint(ctx(s), {
      adviceClient: client({ status: 'unavailable', reason: 'timeout', answers: [] }), roots: s.roots,
      shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' },
    });
    await waitFor(() => c.calls.length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('C-11: a never-resolving client in act mode returns the static pick within the budget', async (t) => {
    const s = store(t);
    const never = { ask: () => new Promise(() => {}) };
    const started = Date.now();
    const res: any = await Promise.race([
      interceptDecisionPoint(ctx(s, { adviceRegistry: { timeoutMs: 50 } }), {
        adviceClient: never, roots: s.roots, benchGate: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
      }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the dispatcher did not return within its budget')), 1500)),
    ]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.advisorPick, null);
    assert.deepEqual(s.lines().map((line: any) => [line.type, line.reason]), [['miss', 'timeout']]);
  });

  test('C-11: a never-resolving client in shadow mode records a timeout miss once the budget ends', async (t) => {
    const s = store(t);
    const started = Date.now();
    const res = await interceptDecisionPoint(ctx(s, { adviceRegistry: { timeoutMs: 300 } }), {
      adviceClient: { ask: () => new Promise(() => {}) }, roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' },
    });
    assert.ok(Date.now() - started < 300, 'shadow returns before the budget');
    assert.equal(res.effectiveDecision, 'light');
    const lines = await waitFor(() => s.lines().length && s.lines(), 2000);
    assert.deepEqual(lines.map((line: any) => [line.type, line.reason]), [['miss', 'timeout']]);
  });

  test('C-11: a pending shadow query does not hold the process open', (t) => {
    const s = store(t);
    const script = `
      const { interceptDecisionPoint } = require(${JSON.stringify(DISPATCHER)});
      interceptDecisionPoint({ kind: 'tier', caller: 'brief-tools', state: 's', staticPick: 'light',
        questionSet: { state: 's', questions: [] }, adviceRegistry: { timeoutMs: 20000 },
        projectRoot: ${JSON.stringify(s.projectRoot)}, env: ${JSON.stringify(s.env)} },
        { adviceClient: { ask: () => new Promise(() => {}) }, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } })
        .then((res) => console.log(res.mode));`;
    const started = Date.now();
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'shadow');
    assert.ok(Date.now() - started < 10000, `the process stayed open for ${Date.now() - started}ms`);
  });

  /**
   * Runs one shadow decision in a child process through a real advice client (budget 60000 ms) with a dispatcher
   * budget of 300 ms, against `endpoint`; `lookupSource`, when given, is the client's DNS lookup as source text.
   */
  async function shadowChild(s: any, endpoint: string, lookupSource?: string) {
    const settingFile = path.join(s.roots['config-home'], 'decision-model.json');
    fs.mkdirSync(path.dirname(settingFile), { recursive: true });
    fs.writeFileSync(settingFile, JSON.stringify({ schema: 1, enabled: true, provider: 'ollama', endpoint, model: 'clef-flash' }));
    const script = `
      const { interceptDecisionPoint } = require(${JSON.stringify(DISPATCHER)});
      const { createAdviceClient } = require(${JSON.stringify(path.join(REPO_ROOT, 'src/runtime/advice/client.ts'))});
      const { loadAdviceRegistry } = require(${JSON.stringify(path.join(REPO_ROOT, 'src/runtime/advice/registry.ts'))});
      const { loadStorageRegistry } = require(${JSON.stringify(path.join(REPO_ROOT, 'src/runtime/storage/registry.ts'))});
      const { resolveRoots } = require(${JSON.stringify(path.join(REPO_ROOT, 'src/runtime/storage/roots.ts'))});
      const repoRoot = ${JSON.stringify(REPO_ROOT)};
      const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot }), projectRoot: ${JSON.stringify(s.projectRoot)}, env: ${JSON.stringify(s.env)} });
      const adviceRegistry = { ...loadAdviceRegistry({ repoRoot }).registry, timeoutMs: 60000 };
      const adviceClient = createAdviceClient({ adviceRegistry, roots${lookupSource ? `, lookup: ${lookupSource}` : ''} });
      interceptDecisionPoint({ kind: 'tier', caller: 'brief-tools', state: ${JSON.stringify(QUESTION_SET.state)}, staticPick: 'light',
        questionSet: ${JSON.stringify(QUESTION_SET)}, adviceRegistry: { timeoutMs: 300 },
        projectRoot: ${JSON.stringify(s.projectRoot)}, env: ${JSON.stringify(s.env)} },
        { adviceClient, roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } })
        .then((res) => console.log(res.mode));`;
    const started = Date.now();
    const child = require('node:child_process').spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: any) => { stdout += chunk; });
    child.stderr.on('data', (chunk: any) => { stderr += chunk; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const code = await new Promise((resolve) => child.on('close', resolve));
    clearTimeout(killer);
    return { elapsed: Date.now() - started, code, stdout, stderr };
  }

  test('C-11: the dispatcher budget aborts the real client request, so a stalled server does not hold the process open', async (t) => {
    const s = store(t);
    const sockets = new Set<any>();
    const server = require('node:http').createServer(() => { /* accept and never answer */ });
    server.on('connection', (socket: any) => { sockets.add(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    const { elapsed, code, stdout, stderr } = await shadowChild(s, `http://127.0.0.1:${server.address().port}`);
    assert.ok(elapsed < 10000, `the process stayed open for ${elapsed}ms`);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'shadow');
    assert.equal(sockets.size, 1, 'the client reached the stalled server');
    assert.deepEqual(s.lines().map((line: any) => [line.type, line.reason]), [['miss', 'timeout']]);
  });

  test('C-11: the dispatcher budget aborts the real client DNS validation, so a stalled lookup does not hold the process open', async (t) => {
    const s = store(t);
    const { elapsed, code, stdout, stderr } = await shadowChild(s, 'http://localhost:11434', '() => { /* never answers */ }');
    assert.ok(elapsed < 10000, `the process stayed open for ${elapsed}ms`);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'shadow');
    assert.deepEqual(s.lines().map((line: any) => [line.type, line.reason]), [['miss', 'timeout']]);
  });
});

describe('141 IC-010: dispatcher caps, budget, describe and the multi-question call (kind rerank)', () => {
  const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
  const { buildRerankQuestionSet, interpretRerankAnswers, rerankPayload } = require('../../src/runtime/advice/rerank.ts');
  const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
  const RERANK = ADVICE.kinds.find((kind: any) => kind.id === 'rerank');
  const SENTINEL_QUERY = 'sentinel-query-text-4471';
  const SENTINEL_CANDIDATE = 'sentinel-candidate-text-9023';
  const SENTINEL_CRITERIA = 'sentinel-criteria-text-6618';
  const CANDIDATES = ['a', 'b', 'c', 'd'].map((name) => ({ ref: `docs/${name}.md`, title: `T ${name}`, text: `${SENTINEL_CANDIDATE} ${name}` }));

  function build(arm: string) {
    const criteria = { ladder: RERANK.scoreLadder.criteria.map((line: string, i: number) => (i === 0 ? `${SENTINEL_CRITERIA} ${line}` : line)), choiceInstruction: `${SENTINEL_CRITERIA} choose` };
    const built = buildRerankQuestionSet({
      query: SENTINEL_QUERY, candidates: CANDIDATES, params: { ...RERANK.params, arm }, arm, criteria, scoreLadder: RERANK.scoreLadder, limits: ADVICE.limits,
    });
    assert.equal(built.ok, true);
    return built;
  }

  /** The client's reply to a rerank question set: probabilities favour label C (choice arm); scores rise with the label (ladder arm). */
  function reply(built: any) {
    const labels: string[] = built.labels;
    if (built.arm === 'choice') {
      const probabilities = Object.fromEntries(labels.map((label) => [label, label === 'C' ? 0.7 : 0.1]));
      return { status: 'answered', reason: null, model: 'm', answers: [{ name: 'rerank', type: 'choice', pick: 'C', strength: { word: 'clear', between: null }, probabilities, confidence: 0.7 }] };
    }
    return {
      status: 'answered', reason: null, model: 'm',
      answers: labels.map((label, index) => ({
        name: `rerank-${label.toLowerCase()}`, type: 'score', pick: built.questionSet.questions[index].criteria[index],
        pickIndex: index, score: index + 0.5, confidence: 0.6, criteria: built.questionSet.questions[index].criteria,
        strength: { word: 'clear', between: null }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.6 },
      })),
    };
  }

  function describeFor(built: any) {
    return (call: any) => {
      const read = interpretRerankAnswers(call.answers, built.labels, built.arm);
      if (!read.valid) return null;
      const extra = { rerank: { ...rerankPayload({
        arm: built.arm, labels: built.labels, refs: built.refs, order: read.order, truncated: built.truncated, params: RERANK.params,
        firstStageMs: 12, expected: read.expected, confidence: read.confidence, criteriaDigest: '3f9a1c0b27de',
      }), criteriaSource: 'registry' } };
      return { pick: read.order[0], extra };
    };
  }

  function store(t: any) {
    const dir = tempDir(t, 'doflow-advice-rerank-');
    const projectRoot = path.join(dir, 'proj');
    fs.mkdirSync(projectRoot);
    const env = { HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
    const roots = resolveRoots({ registry: STORAGE, projectRoot, env });
    return { dir, projectRoot, env, roots, lines: () => readWindow({ roots }).records.map((entry: any) => entry.record) };
  }

  function recordingClient(response: any) {
    const calls: any[] = [];
    return { calls, ask: async (options: any) => { calls.push(options); return typeof response === 'function' ? response(options) : response; } };
  }

  function ctx(s: any, built: any, extra: any = {}) {
    return {
      kind: 'rerank', caller: 'retrieve', state: built.questionSet.state, staticPick: 'A', questionSet: built.questionSet,
      adviceRegistry: ADVICE, budgetMs: 5000, describe: describeFor(built), projectRoot: s.projectRoot, env: s.env, ...extra,
    };
  }

  async function waitFor(check: () => any, ms = 1500) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const value = check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return check();
  }

  const neverGate = () => { throw new Error('the bench gate must not be reached'); };

  for (const arm of ['choice', 'ladder']) {
    test(`maxMode lowers a configured act to shadow with ACT_NOT_SUPPORTED, never reaching the bench gate (${arm} arm)`, async (t) => {
      const s = store(t);
      const built = build(arm);
      const c = recordingClient(reply(built));
      const res = await interceptDecisionPoint(ctx(s, built), {
        adviceClient: c, roots: s.roots, benchGate: neverGate, shadowConfig: { kind: 'rerank', mode: 'act', model: 'm' },
      });
      assert.equal(res.mode, 'shadow');
      assert.equal(res.warning, "ACT_NOT_SUPPORTED: kind 'rerank' is limited to shadow");
      assert.equal(res.effectiveDecision, 'A', 'the first-stage top candidate stays the decision');
      assert.equal(res.advisorPick, null);
      assert.equal(res.elevated, false);
      const lines = await waitFor(() => s.lines().length && s.lines());
      assert.equal(lines.length, 1);
      assert.equal(lines[0].mode, 'shadow');
      assert.equal(lines[0].elevated, false);
    });

    test(`${arm} arm: the client gets no static answer, and the line still records the static pick, the arm and the whole order`, async (t) => {
      const s = store(t);
      const built = build(arm);
      const c = recordingClient(reply(built));
      await interceptDecisionPoint(ctx(s, built), { adviceClient: c, roots: s.roots, shadowConfig: { kind: 'rerank', mode: 'shadow', model: 'm' } });
      const [line] = await waitFor(() => s.lines().length && s.lines());
      assert.equal(c.calls.length, 1);
      assert.equal(c.calls[0].staticAnswer, null, 'a label is not a level of a score question; no static answer goes to the client');
      assert.equal(c.calls[0].kind, 'rerank');
      assert.equal(c.calls[0].record, false);
      assert.equal(line.type, 'pick');
      assert.equal(line.kind, 'rerank');
      assert.equal(line.question, 'rerank');
      assert.equal(line.qtype, arm === 'choice' ? 'choice' : 'score');
      assert.deepEqual(line.options, ['A', 'B', 'C', 'D']);
      assert.equal(line.instructions, null);
      assert.equal(line.static, 'A');
      assert.equal(line.rerank.arm, arm);
      assert.equal(line.rerank.n, 4);
      assert.deepEqual(line.rerank.refs, CANDIDATES.map((candidate) => candidate.ref));
      assert.equal(line.rerank.criteriaDigest, '3f9a1c0b27de');
      assert.equal(line.rerank.criteriaSource, 'registry');
      assert.equal(line.rerank.firstStageMs, 12);
      if (arm === 'choice') {
        assert.deepEqual(line.rerank.order, ['C', 'A', 'B', 'D']);
        assert.equal(line.pick, 'C');
        assert.equal(line.rerank.top1Changed, true);
        assert.equal(line.strength, 'clear');
        assert.equal(line.probabilities.C, 0.7);
        assert.equal(line.confidence, 0.7);
        assert.equal('expected' in line.rerank, false);
      } else {
        assert.deepEqual(line.rerank.order, ['D', 'C', 'B', 'A']);
        assert.equal(line.pick, 'D');
        assert.deepEqual(line.rerank.expected, [0.5, 1.5, 2.5, 3.5]);
        assert.deepEqual(line.rerank.confidence, [0.6, 0.6, 0.6, 0.6]);
        assert.deepEqual([line.strength, line.between, line.probabilities, line.confidence], [null, null, null, null]);
        for (const key of ['criteria', 'pickIndex', 'score']) assert.equal(key in line, false, `a rerank pick has no ${key} key`);
      }
    });

    test(`${arm} arm: no query, candidate or criteria text reaches the stored file`, async (t) => {
      const s = store(t);
      const built = build(arm);
      assert.ok(JSON.stringify(built.questionSet).includes(SENTINEL_CRITERIA), 'the sentinel is in what the model is asked');
      await interceptDecisionPoint(ctx(s, built), {
        adviceClient: recordingClient(reply(built)), roots: s.roots, shadowConfig: { kind: 'rerank', mode: 'shadow', model: 'm' },
      });
      await waitFor(() => s.lines().length);
      const dir = path.join(s.roots['project-state'], 'advice', 'picks');
      const text = fs.readdirSync(dir).map((name: string) => fs.readFileSync(path.join(dir, name), 'utf8')).join('');
      assert.ok(text.length > 0);
      for (const sentinel of [SENTINEL_QUERY, SENTINEL_CANDIDATE, SENTINEL_CRITERIA]) assert.equal(text.includes(sentinel), false, sentinel);
    });
  }

  test('describe receives the whole call: every answer, the first one as answer and pick', async (t) => {
    const s = store(t);
    const built = build('ladder');
    let seen: any = null;
    await interceptDecisionPoint(ctx(s, built, { describe: (call: any) => { seen = call; return describeFor(built)(call); } }), {
      adviceClient: recordingClient(reply(built)), roots: s.roots, shadowConfig: { kind: 'rerank', mode: 'shadow', model: 'm' },
    });
    await waitFor(() => seen);
    assert.equal(seen.status, 'answered');
    assert.deepEqual(seen.answers.map((answer: any) => answer.name), ['rerank-a', 'rerank-b', 'rerank-c', 'rerank-d']);
    assert.equal(seen.answer.name, 'rerank-a');
    assert.equal(seen.pick, seen.answers[0].pick);
    assert.ok(seen.answers.every((answer: any) => answer.model === 'm'));
  });

  test('a describe that returns null, or throws, records a malformed-reply miss and no pick', async (t) => {
    const s = store(t);
    const built = build('choice');
    for (const describe of [() => null, () => { throw new Error('boom'); }]) {
      await interceptDecisionPoint(ctx(s, built, { describe }), {
        adviceClient: recordingClient(reply(built)), roots: s.roots, shadowConfig: { kind: 'rerank', mode: 'shadow', model: 'm' },
      });
    }
    const lines = await waitFor(() => s.lines().length >= 2 && s.lines());
    assert.deepEqual(lines.map((line: any) => [line.type, line.kind, line.reason, line.mode]), [
      ['miss', 'rerank', 'malformed-reply', 'shadow'], ['miss', 'rerank', 'malformed-reply', 'shadow'],
    ]);
  });

  test('a rerank answer whose describe gives no valid payload writes no pick (the ordinary branch would store criteria text)', async (t) => {
    const s = store(t);
    const built = build('ladder');
    await interceptDecisionPoint(ctx(s, built, { describe: () => ({ extra: { rerank: { arm: 'ladder', n: 'four' } } }) }), {
      adviceClient: recordingClient(reply(built)), roots: s.roots, shadowConfig: { kind: 'rerank', mode: 'shadow', model: 'm' },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(s.lines(), []);
  });

  test('budgetMs on the context bounds the call, so a bigger registry timeoutMs does not delay the timeout miss', async (t) => {
    const s = store(t);
    const built = build('choice');
    const started = Date.now();
    let aborted = false;
    const hangs = { ask: (options: any) => { options.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } };
    await interceptDecisionPoint(ctx(s, built, { budgetMs: 60 }), { adviceClient: hangs, roots: s.roots, shadowConfig: { kind: 'rerank', mode: 'shadow', model: 'm' } });
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.ok(Date.now() - started < 1500, `the miss took ${Date.now() - started}ms against a 15000 ms registry timeout`);
    assert.deepEqual(lines.map((line: any) => [line.type, line.kind, line.reason]), [['miss', 'rerank', 'timeout']]);
    assert.equal(aborted, true);
  });

  test('without budgetMs the registry timeoutMs applies, as before', async (t) => {
    const s = store(t);
    const built = build('choice');
    const started = Date.now();
    await interceptDecisionPoint(ctx(s, built, { budgetMs: undefined, adviceRegistry: { ...ADVICE, timeoutMs: 80 } }), {
      adviceClient: { ask: () => new Promise(() => {}) }, roots: s.roots, shadowConfig: { kind: 'rerank', mode: 'shadow', model: 'm' },
    });
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(lines.map((line: any) => line.reason), ['timeout']);
  });

  test('a kind without maxMode still reaches the bench gate and act, and a miss line keeps its shape', async (t) => {
    const s = store(t);
    const gated: string[] = [];
    const tierSet = { state: 's', questions: [{ name: 'tier', type: 'choice', instructions: 'Choose.', options: { light: 'L', standard: 'S', frontier: 'F' } }] };
    const answered = { status: 'answered', model: 'm', answers: [{ name: 'tier', type: 'choice', pick: 'frontier', strength: { word: 'clear', between: null }, probabilities: { light: 0.1, standard: 0.1, frontier: 0.8 }, confidence: 0.8 }] };
    const c = recordingClient(answered);
    const res = await interceptDecisionPoint({
      kind: 'tier', caller: 'brief-tools', state: 's', staticPick: 'light', questionSet: tierSet, adviceRegistry: ADVICE, projectRoot: s.projectRoot, env: s.env,
    }, { adviceClient: c, roots: s.roots, benchGate: async (kind: string) => { gated.push(kind); return { passed: true, reason: 'x' }; }, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' } });
    assert.deepEqual(gated, ['tier']);
    assert.equal(res.mode, 'act');
    assert.equal(res.warning, undefined);
    assert.equal(c.calls[0].staticAnswer, 'light', 'a one-question named kind still gets its static answer');
    const [line] = s.lines();
    assert.equal('rerank' in line, false);
  });
});
