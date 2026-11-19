'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Feature 084 — advisor shadowing: IC-001 (shadow-config), IC-002 (shadow-dispatcher, recording through
// record.ts) and IC-004 (elevation).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir, tempDir } = require('../helper/tmp.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { startFakeServer, answering } = require('../helper/fake-decision-server.ts');
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
  askAdvisor,
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
    assert.deepEqual(cfg.diagnostics, []);
  });

  test('resolves off, shadow, show and act modes per kind from advice.kinds.<kind>', () => {
    const { root, fsImpl, env } = setupConfigEnv({
      advice: {
        enabled: true,
        kinds: {
          tier: 'shadow',
          'task-class': 'off',
          'verify-risk': 'act',
          'mcp-need': 'show',
        },
      },
    });

    const tierCfg = resolveShadowConfig('tier', { projectRoot: root, fsImpl, env });
    assert.equal(tierCfg.mode, 'shadow');

    const taskClassCfg = resolveShadowConfig('task-class', { projectRoot: root, fsImpl, env });
    assert.equal(taskClassCfg.mode, 'off');

    const verifyRiskCfg = resolveShadowConfig('verify-risk', { projectRoot: root, fsImpl, env });
    assert.equal(verifyRiskCfg.mode, 'act');

    const mcpNeedCfg = resolveShadowConfig('mcp-need', { projectRoot: root, fsImpl, env });
    assert.equal(mcpNeedCfg.mode, 'show', '175 O-1: show is a value of advice.kinds.<kind>');
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

  test('C-5: a present invalid value is off, never a lower layer\'s value', (t) => {
    const { root, env } = layers(t, { local: { 'advice.kinds.tier': 'offf' }, user: { 'advice.kinds.tier': 'act' } });
    const cfg = resolveShadowConfig('tier', { projectRoot: root, env });
    assert.equal(cfg.mode, 'off');
    assert.match(cfg.decidedBy.mode, /^local:/);
    assert.ok(cfg.diagnostics.some((d: string) => /advice\.kinds\.tier/.test(d) && /offf/.test(d) && /expected off, shadow, show or act/.test(d)), JSON.stringify(cfg.diagnostics));
  });

  for (const [name, text] of [['corrupt JSON', '{"advice.kinds.tier": "off"'], ['a non-object JSON value', '[]']]) {
    test(`C-5: a project file with ${name} plus user act resolves to off`, (t) => {
      const { root, files, env } = layers(t, { project: text, user: { 'advice.kinds.tier': 'act' } });
      const cfg = resolveShadowConfig('tier', { projectRoot: root, env });
      assert.equal(cfg.mode, 'off');
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

  test('C-5: a corrupt layer with the kind set nowhere is off, so the dispatcher asks nothing', async (t) => {
    const { root, files, env } = layers(t, { project: '{not json' });
    const cfg = resolveShadowConfig('tier', { projectRoot: root, env });
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

  // Row 174 O-1: a kind no layer sets takes the one dispatcher path, shadow when a decision model is configured.
  const ADVICE_ON = { 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': 'http://127.0.0.1:9' };

  test('174 O-1: an unset kind is shadow when advice is on and a model is configured, off otherwise', (t) => {
    const on = layers(t, { user: { ...ADVICE_ON, 'advice.model': 'clef-flash' } });
    const cfg = resolveShadowConfig('tier', { projectRoot: on.root, env: on.env });
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.model, 'clef-flash');
    assert.deepEqual(cfg.diagnostics, []);
    assert.equal(Object.hasOwn(cfg, 'kindSet'), false, 'there is no second path to route on');

    const perKind = layers(t, { user: { ...ADVICE_ON, 'advice.model': 'clef-flash', 'advice.models.tier': 'tier-model' } });
    assert.equal(resolveShadowConfig('tier', { projectRoot: perKind.root, env: perKind.env }).model, 'tier-model');

    const notConfigured = layers(t, {});
    assert.equal(resolveShadowConfig('tier', { projectRoot: notConfigured.root, env: notConfigured.env }).mode, 'off');
    const disabled = layers(t, { user: { ...ADVICE_ON, 'advice.model': 'clef-flash', 'advice.enabled': false } });
    assert.equal(resolveShadowConfig('tier', { projectRoot: disabled.root, env: disabled.env }).mode, 'off');
    const noModel = layers(t, { user: { ...ADVICE_ON, 'advice.model': null } });
    const noModelCfg = resolveShadowConfig('tier', { projectRoot: noModel.root, env: noModel.env });
    assert.equal(noModelCfg.model, null);
    assert.equal(noModelCfg.mode, 'off', 'no model, no call');
  });

  test('174 O-1: a set kind keeps its own mode, and a corrupt layer stays off, even with a model configured', (t) => {
    const user = { ...ADVICE_ON, 'advice.model': 'clef-flash' };
    const off = layers(t, { user: { ...user, 'advice.kinds.tier': 'off' } });
    assert.equal(resolveShadowConfig('tier', { projectRoot: off.root, env: off.env }).mode, 'off');
    const act = layers(t, { user: { ...user, 'advice.kinds.tier': 'act' } });
    assert.equal(resolveShadowConfig('tier', { projectRoot: act.root, env: act.env }).mode, 'act');
    const corrupt = layers(t, { user, project: '{not json' });
    assert.equal(resolveShadowConfig('tier', { projectRoot: corrupt.root, env: corrupt.env }).mode, 'off');
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

  /** A partial registry whose tier kind has a budgetMs of `ms`: the dispatcher bounds the call by it. */
  function withBudget(ms: number) {
    return { timeoutMs: 1000, kinds: [{ id: 'tier', budgetMs: ms }] };
  }

  /**
   * Turns advice on in the store's user settings against an in-process fake server answering `route` (or the fake's
   * default). A shadow call runs in a detached child that builds its own client from these settings (row 174 O-2).
   */
  async function advised(t: any, s: any, route?: any) {
    const server: any = await startFakeServer(route ? { routes: { 'POST /v1/systemone': route } } : {});
    t.after(() => server.close());
    const file = path.join(s.roots['config-home'], 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash' }));
    return { server, asks: () => server.requests.filter((r: any) => r.pathname === '/v1/systemone') };
  }

  async function waitFor(check: () => any, ms = 5000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const value = check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return check();
  }

  /** An injected trust evaluator (replay/trust.ts evaluateTrust) at `standing`; it keeps every request it is given. */
  function trustAt(standing: string, reason = `injected ${standing}`) {
    const requests: any[] = [];
    const trust = async (request: any) => { requests.push(request); return { standing, reason, failedChecks: [], staleDigest: null, modelDigest: 'sha256:00' }; };
    return Object.assign(trust, { requests });
  }
  const passGate = trustAt('act', 'injected');
  const failGate = async () => ({ standing: 'below-show', reason: 'injected failure', failedChecks: [], staleDigest: null, modelDigest: 'sha256:00' });

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
    const a = await advised(t, s, answering(() => 'frontier'));
    const res = await interceptDecisionPoint(ctx(s), {
      roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'qwen2.5-coder:1.5b' },
    });
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.mode, 'shadow');
    assert.equal(res.staticPick, 'light');
    assert.equal(res.advisorPick, null, 'shadow never shows the pick');
    assert.match(res.pickId, /^adv-[0-9]{13}-[0-9a-f]{6}$/);
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.equal(a.asks().length, 1);
    assert.equal(a.asks()[0].body.model, 'qwen2.5-coder:1.5b', 'the child asks the effective model');
    assert.equal(a.asks()[0].body.state, QUESTION_SET.state, 'the state reaches the model whole');
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

  test('mode act applies the elevation invariant at the injected standing act, and records act', async (t) => {
    const s = store(t);
    const c = client((options: any) => answered('standard', options.model));
    const res = await interceptDecisionPoint(ctx(s), {
      adviceClient: c, roots: s.roots, trust: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'verified-model:7b' },
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

  test('mode act degrades to shadow with LOCAL_RESULT_UNMET, and the shadow query runs and records', async (t) => {
    const s = store(t);
    const a = await advised(t, s, answering(() => 'frontier'));
    const res = await interceptDecisionPoint(ctx(s), {
      roots: s.roots, trust: failGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'unverified-weak-model:0.5b' },
    });
    assert.equal(res.mode, 'shadow', 'mode must degrade to shadow below the act standing');
    assert.equal(res.effectiveDecision, 'light', 'effective decision remains staticPick on degradation');
    assert.equal(res.advisorPick, null);
    assert.equal(res.warning, 'LOCAL_RESULT_UNMET: below-show: injected failure');
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.equal(a.asks().length, 1, 'the degraded shadow query ran');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].mode, 'shadow');
    assert.equal(lines[0].pick, 'frontier');
    assert.equal(lines[0].model, 'unverified-weak-model:0.5b');
  });

  test('the advisor is asked with the advice client call shape, the effective model and no client recording', async (t) => {
    const s = store(t);
    const c = client(answered('frontier'));
    const res = await interceptDecisionPoint(ctx(s, { record: false }), {
      adviceClient: c, roots: s.roots, trust: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
    });
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].length, 1, 'ask takes one options object');
    const { signal, timeoutMs, ...options } = c.calls[0][0];
    assert.ok(signal instanceof AbortSignal, 'the call carries the budget signal');
    assert.equal(signal.aborted, false, 'an answer inside the budget is not aborted');
    assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1500, `the call carries what is left of the shipped tier budgetMs: ${timeoutMs}`);
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
    const trust = async ({ model }: any) => { gated.push(model); return { standing: model === 'A' ? 'act' : 'none', reason: `result for ${model}` }; };
    // Like the real client: without a model override it asks its own setting's model (B).
    const c = client((options: any) => answered('standard', options.model ?? 'B'));
    const res = await interceptDecisionPoint(ctx(s), { adviceClient: c, roots: s.roots, trust });
    assert.deepEqual(gated, ['A']);
    assert.equal(c.calls[0][0].model, 'A', 'the client request carries the benched model');
    assert.equal(res.mode, 'act');
    const [line] = s.lines();
    assert.equal(line.model, 'A', 'the record names the model that was asked');
  });

  test('C-3: act with no named model never reaches the trust evaluator', async (t) => {
    const s = store(t);
    let gated = 0;
    const res = await interceptDecisionPoint(ctx(s, { record: false }), {
      adviceClient: client(answered('frontier')), roots: s.roots,
      trust: async () => { gated += 1; return { standing: 'act', reason: 'x' }; },
      shadowConfig: { kind: 'tier', mode: 'act', model: null },
    });
    assert.equal(res.mode, 'shadow');
    assert.match(res.warning, /^LOCAL_RESULT_UNMET: unknown: /);
    assert.equal(gated, 0);
  });

  test('C-4: an unavailable advisor in shadow mode records one miss with its reason and no pick', async (t) => {
    const s = store(t);
    await advised(t, s, { status: 500, body: { error: 'down' } });
    await interceptDecisionPoint(ctx(s), { roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } });
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.equal(lines.filter((line: any) => line.type === 'miss').length, 1);
    assert.equal(lines.filter((line: any) => line.type === 'pick').length, 0);
    const [miss] = lines;
    assert.equal(miss.reason, 'server-error');
    assert.equal(miss.kind, 'tier');
    assert.equal(miss.caller, 'brief-tools');
    assert.equal(miss.mode, 'shadow');
    assert.equal(miss.model, 'm');
  });

  test('C-4: a malformed answer and a throwing client record a miss, never a pick', async (t) => {
    const s = store(t);
    await advised(t, s, { status: 200, body: { answers: { tier: { choice: 'light' } } } });
    await interceptDecisionPoint(ctx(s), { roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } });
    await waitFor(() => s.lines().length);
    const throwing = { ask: async () => { throw new Error('boom'); } };
    await interceptDecisionPoint(ctx(s), { adviceClient: throwing, roots: s.roots, trust: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' } });
    const lines = await waitFor(() => s.lines().length >= 2 && s.lines());
    assert.deepEqual(lines.map((line: any) => [line.type, line.mode, line.reason]), [['miss', 'shadow', 'malformed-reply'], ['miss', 'act', 'config-invalid']]);
  });

  test('shadow with record:false asks nothing and writes nothing, also when act degrades', async (t) => {
    const s = store(t);
    const c = client(answered('frontier'));
    let spawned = 0;
    const spawn = () => { spawned += 1; throw new Error('no child may start'); };
    const shadow = await interceptDecisionPoint(ctx(s, { record: false }), { adviceClient: c, roots: s.roots, spawn, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } });
    const degraded = await interceptDecisionPoint(ctx(s, { record: false }), {
      adviceClient: c, roots: s.roots, spawn, trust: failGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
    });
    assert.deepEqual([shadow.mode, degraded.mode, shadow.effectiveDecision, degraded.effectiveDecision], ['shadow', 'shadow', 'light', 'light']);
    assert.match(degraded.warning, /^LOCAL_RESULT_UNMET: below-show: /);
    assert.equal(spawned, 0, 'a shadow call that records nothing is pure spend: no child starts');
    assert.equal(c.calls.length, 0);
    assert.deepEqual(s.lines(), []);
  });

  test('D2: a staged rollout profile caps a configured act to shadow', async (t) => {
    const s = store(t);
    fs.mkdirSync(path.join(s.projectRoot, '.doflow'));
    fs.writeFileSync(path.join(s.projectRoot, '.doflow', 'settings.json'), JSON.stringify({ rollout: { profile: 'staged' } }));
    await advised(t, s, answering(() => 'standard'));
    let gated = 0;
    const res = await interceptDecisionPoint(ctx(s), {
      roots: s.roots, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
      trust: async () => { gated += 1; return { standing: 'act', reason: 'injected' }; },
    });
    assert.equal(res.mode, 'shadow');
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.advisorPick, null);
    assert.equal(gated, 0, 'a capped act never reaches the trust evaluator');
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.deepEqual(lines.map((line: any) => [line.type, line.mode, line.pick]), [['pick', 'shadow', 'standard']]);
  });

  test('a kind with a registry maxMode shadow is held there: act is lowered to ACT_NOT_SUPPORTED and never reaches the trust evaluator', async (t) => {
    const s = store(t);
    await advised(t, s, answering(() => 'standard'));
    const held = { timeoutMs: 1000, kinds: [{ id: 'tier', maxMode: 'shadow', budgetMs: 1000 }] };
    const res = await interceptDecisionPoint(ctx(s, { adviceRegistry: held }), {
      roots: s.roots, trust: () => { throw new Error('the trust evaluator must not be reached'); }, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
    });
    assert.equal(res.mode, 'shadow');
    assert.equal(res.warning, "ACT_NOT_SUPPORTED: kind 'tier' is limited to shadow");
    assert.equal(res.effectiveDecision, 'light', 'the static pick stays the decision');
    assert.equal(res.advisorPick, null);
    assert.equal(res.elevated, false);
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.deepEqual(lines.map((line: any) => [line.type, line.mode, line.elevated]), [['pick', 'shadow', false]]);
  });

  test('C-4: no advisor pick in act mode keeps the static pick and records a miss', async (t) => {
    const s = store(t);
    const res = await interceptDecisionPoint(ctx(s), {
      adviceClient: client({ status: 'unavailable', reason: 'unreachable', answers: [] }), roots: s.roots,
      trust: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
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
    await advised(t, { roots }, answering(() => 'frontier'));
    const res = await interceptDecisionPoint(ctx({ projectRoot, env }), {
      roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' },
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
    let replies = 0;
    const a = await advised(t, s, (request: any) => { replies += 1; return replies === 1 ? answering(() => 'frontier')(request) : { status: 500, body: {} }; });
    const slots = path.join(s.roots['user-state'], 'advice', 'shadow-slots');
    for (let index = 0; index < 2; index += 1) {
      await interceptDecisionPoint(ctx(s), { roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } });
      // Each child has asked and released its slot, so it has written whatever it was going to write.
      assert.ok(await waitFor(() => a.asks().length === index + 1 && fs.existsSync(slots) && fs.readdirSync(slots).length === 0), `child ${index + 1} finished`);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('C-11: a never-resolving client in act mode returns the static pick within the budget', async (t) => {
    const s = store(t);
    const never = { ask: () => new Promise(() => {}) };
    const started = Date.now();
    const res: any = await Promise.race([
      interceptDecisionPoint(ctx(s, { adviceRegistry: withBudget(50) }), {
        adviceClient: never, roots: s.roots, trust: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
      }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the dispatcher did not return within its budget')), 1500)),
    ]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.advisorPick, null);
    assert.deepEqual(s.lines().map((line: any) => [line.type, line.reason]), [['miss', 'timeout']]);
  });

  test('C-11: a stalled model in shadow mode records a timeout miss once the budget ends', async (t) => {
    const s = store(t);
    await advised(t, s, { stall: true });
    const started = Date.now();
    const res = await interceptDecisionPoint(ctx(s, { adviceRegistry: withBudget(300) }), {
      roots: s.roots, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' },
    });
    assert.ok(Date.now() - started < 300, 'shadow returns before the budget');
    assert.equal(res.effectiveDecision, 'light');
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.deepEqual(lines.map((line: any) => [line.type, line.reason]), [['miss', 'timeout']]);
  });

  /**
   * Runs one shadow decision in a child process with a call budget of 300 ms against `endpoint`, and returns how long
   * that process took to exit. The call itself runs in the detached grandchild, which records its miss on its own.
   */
  async function shadowChild(s: any, endpoint: string) {
    const settingFile = path.join(s.roots['config-home'], 'settings.json');
    fs.mkdirSync(path.dirname(settingFile), { recursive: true });
    fs.writeFileSync(settingFile, JSON.stringify({ schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': endpoint, 'advice.model': 'clef-flash' }));
    const script = `
      const { interceptDecisionPoint } = require(${JSON.stringify(DISPATCHER)});
      interceptDecisionPoint({ kind: 'tier', caller: 'brief-tools', state: ${JSON.stringify(QUESTION_SET.state)}, staticPick: 'light',
        questionSet: ${JSON.stringify(QUESTION_SET)}, adviceRegistry: ${JSON.stringify(withBudget(300))},
        projectRoot: ${JSON.stringify(s.projectRoot)}, env: ${JSON.stringify(s.env)} },
        { roots: ${JSON.stringify(s.roots)}, shadowConfig: { kind: 'tier', mode: 'shadow', model: 'm' } })
        .then((res) => console.log(res.mode));`;
    const started = Date.now();
    const child = require('node:child_process').spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: s.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: any) => { stdout += chunk; });
    child.stderr.on('data', (chunk: any) => { stderr += chunk; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const code = await new Promise((resolve) => child.on('close', resolve));
    clearTimeout(killer);
    return { elapsed: Date.now() - started, code, stdout, stderr };
  }

  test('C-11: a stalled server holds neither the command process nor the detached call past its budget', async (t) => {
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
    const lines = await waitFor(() => s.lines().length && s.lines());
    assert.deepEqual(lines.map((line: any) => [line.type, line.reason]), [['miss', 'timeout']]);
    assert.equal(sockets.size, 1, 'the detached call reached the stalled server');
    assert.ok(await waitFor(() => [...sockets].every((socket: any) => socket.destroyed)), 'the detached call dropped its request at the budget');
  });

  test('C-11: the budget aborts the real client DNS validation of an act call, so a stalled lookup does not hold it', async (t) => {
    const s = store(t);
    const { createAdviceClient } = require('../../src/runtime/advice/client.ts');
    const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
    const settingFile = path.join(s.roots['config-home'], 'settings.json');
    fs.mkdirSync(path.dirname(settingFile), { recursive: true });
    // A name, so the endpoint guard resolves it through the lookup below, which never answers: no connection is made.
    fs.writeFileSync(settingFile, JSON.stringify({ schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': 'http://advice-fake.invalid:9', 'advice.model': 'clef-flash' }));
    const adviceRegistry = { ...loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry, timeoutMs: 60000 };
    const adviceClient = createAdviceClient({ adviceRegistry, roots: s.roots, lookup: () => { /* never answers */ } });
    const started = Date.now();
    const res = await interceptDecisionPoint(ctx(s, { adviceRegistry: withBudget(300) }), {
      adviceClient, roots: s.roots, trust: passGate, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
    });
    assert.ok(Date.now() - started < 2000, `the act call took ${Date.now() - started}ms against a 300 ms budget`);
    assert.equal(res.effectiveDecision, 'light');
    assert.deepEqual(s.lines().map((line: any) => [line.type, line.reason, line.mode]), [['miss', 'timeout', 'act']]);
  });

  // ---- 175 IC-009: the show and act gate, judged on the local result at every decision ----

  /** The tier context with a show surface (the caller displays the answer); `extra` overrides. */
  const shown = (s: any, extra: any = {}) => ctx(s, { surface: 'show', ...extra });
  const config = (mode: string, extra: any = {}) => ({ kind: 'tier', mode, model: 'm', ...extra });

  test('175 T7 (a): an unset kind runs in shadow whatever the store holds, and never asks the trust evaluator', async (t) => {
    const s = store(t);
    await advised(t, s, answering(() => 'standard'));
    const trust = trustAt('act');
    // The settings layers set no advice.kinds.tier: shadow-config resolves it to shadow (row 174 O-1).
    const resolved = await interceptDecisionPoint(shown(s), { roots: s.roots, trust });
    // A config that says act with no layer deciding the mode is still an unset kind.
    const unset = await interceptDecisionPoint(shown(s, { record: false }), {
      adviceClient: client(answered('standard')), roots: s.roots, trust, shadowConfig: config('act', { decidedBy: { mode: null, model: null } }),
    });
    assert.deepEqual([resolved.mode, unset.mode], ['shadow', 'shadow']);
    assert.deepEqual([resolved.effectiveDecision, unset.effectiveDecision], ['light', 'light']);
    assert.equal(unset.warning, undefined);
    assert.equal(trust.requests.length, 0, 'an unset kind is shadow before any trust call');    await waitFor(() => s.lines().length);
  });

  test('175 T7 (b): show at standing show with a show surface shows the answer, keeps the static decision and records mode show', async (t) => {
    const s = store(t);
    const c = client((options: any) => answered('standard', options.model));
    const trust = trustAt('show');
    const res = await interceptDecisionPoint(shown(s), { adviceClient: c, roots: s.roots, trust, shadowConfig: config('show') });
    assert.equal(res.mode, 'show');
    assert.equal(res.advisorPick, 'standard');
    assert.equal(res.advisorAnswer.pick, 'standard');
    assert.equal(res.effectiveDecision, 'light', 'a shown answer never changes the decision');
    assert.equal(res.elevated, false);
    assert.equal(res.agreed, false);
    assert.equal(res.warning, undefined);
    assert.equal(c.calls.length, 1);
    assert.equal(trust.requests.length, 1);
    const [request] = trust.requests;
    assert.deepEqual([request.kind, request.model, request.projectRoot], ['tier', 'm', s.projectRoot]);
    assert.deepEqual(request.question, QUESTION_SET.questions[0], 'the question the decision asks is the one judged');
    assert.deepEqual(request.roots, s.roots);
    const [line] = s.lines();
    assert.deepEqual([line.type, line.pickId, line.mode, line.elevated, line.pick, line.static], ['pick', res.pickId, 'show', false, 'standard', 'light']);
  });

  test('175 T7 (c): show without a show surface runs as shadow with no trust call and no awaited model call', async (t) => {
    const s = store(t);
    const c = client(answered('standard'));
    const trust = trustAt('act');
    let spawned = 0;
    const spawn = () => { spawned += 1; throw new Error('no child'); };
    const res = await interceptDecisionPoint(ctx(s, { record: false }), { adviceClient: c, roots: s.roots, spawn, trust, shadowConfig: config('show') });
    assert.equal(res.mode, 'shadow');
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.advisorPick, null);
    assert.equal(res.warning, undefined);
    assert.equal(trust.requests.length, 0);
    assert.equal(c.calls.length, 0);
    assert.equal(spawned, 0);
  });

  test('175 T7 (d): act at standing show is shown with a show surface, never elevated, and shadow without one', async (t) => {
    const s = store(t);
    const c = client((options: any) => answered('frontier', options.model));
    const res = await interceptDecisionPoint(shown(s), { adviceClient: c, roots: s.roots, trust: trustAt('show'), shadowConfig: config('act') });
    assert.equal(res.mode, 'show');
    assert.equal(res.advisorPick, 'frontier');
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.elevated, false);
    assert.deepEqual(s.lines().map((line: any) => [line.mode, line.elevated]), [['show', false]]);
    const hidden = await interceptDecisionPoint(ctx(s, { record: false }), { adviceClient: c, roots: s.roots, trust: trustAt('show', 'the show bar holds; the act bar does not'), shadowConfig: config('act') });
    assert.equal(hidden.mode, 'shadow');
    assert.equal(hidden.advisorPick, null);
    assert.equal(hidden.warning, 'LOCAL_RESULT_UNMET: show: the show bar holds; the act bar does not');
    assert.equal(c.calls.length, 1, 'no surface: no awaited call');
  });

  test('175 T7 (e): act at standing act is elevated as before, with or without a show surface', async (t) => {
    const s = store(t);
    const c = client((options: any) => answered('standard', options.model));
    for (const context of [ctx(s), shown(s)]) {
      const res = await interceptDecisionPoint(context, { adviceClient: c, roots: s.roots, trust: trustAt('act'), shadowConfig: config('act') });
      assert.deepEqual([res.mode, res.effectiveDecision, res.elevated, res.advisorPick], ['act', 'standard', true, 'standard']);
    }
    assert.deepEqual(s.lines().map((line: any) => [line.mode, line.elevated]), [['act', true], ['act', true]]);
  });

  for (const standing of ['below-show', 'below-minimum', 'measure-only', 'unknown', 'stale', 'none']) {
    test(`175 T7 (f): standing ${standing} runs show and act as shadow with LOCAL_RESULT_UNMET and its reason`, async (t) => {
      const s = store(t);
      const c = client(answered('standard'));
      for (const mode of ['show', 'act']) {
        for (const context of mode === 'act' ? [ctx(s, { record: false }), shown(s, { record: false })] : [shown(s, { record: false })]) {
          const res = await interceptDecisionPoint(context, { adviceClient: c, roots: s.roots, trust: trustAt(standing, `why ${standing}`), shadowConfig: config(mode) });
          assert.equal(res.mode, 'shadow', `${mode} at ${standing}`);
          assert.equal(res.effectiveDecision, 'light');
          assert.equal(res.advisorPick, null);
          assert.equal(res.warning, `LOCAL_RESULT_UNMET: ${standing}: why ${standing}`);
        }
      }
      assert.equal(c.calls.length, 0, 'below the standing the model is never asked on the waited path');
    });
  }

  test('175 T7 (f): with no injection the shipped evaluator judges: a kind with no replay source is none', async (t) => {
    const s = store(t);
    const c = client(answered('standard'));
    const res = await interceptDecisionPoint(shown(s, { record: false }), { adviceClient: c, roots: s.roots, shadowConfig: config('act') });
    assert.equal(res.mode, 'shadow');
    assert.equal(res.warning, "LOCAL_RESULT_UNMET: none: kind 'tier' has no replay source");
    assert.equal(c.calls.length, 0);
  });

  test('175 T7 (g): a staged or canary rollout profile lowers show to shadow before any trust call', async (t) => {
    for (const profile of ['staged', 'canary']) {
      const s = store(t);
      fs.mkdirSync(path.join(s.projectRoot, '.doflow'));
      fs.writeFileSync(path.join(s.projectRoot, '.doflow', 'settings.json'), JSON.stringify({ rollout: { profile } }));
      const trust = trustAt('act');
      const res = await interceptDecisionPoint(shown(s, { record: false }), { adviceClient: client(answered('standard')), roots: s.roots, trust, shadowConfig: config('show') });
      assert.equal(res.mode, 'shadow', profile);
      assert.equal(trust.requests.length, 0, profile);
    }
  });

  test('175 T7 (h): a registry maxMode show holds act at show, and the held warning names the limit', async (t) => {
    const s = store(t);
    const held = { timeoutMs: 1000, kinds: [{ id: 'tier', maxMode: 'show', budgetMs: 1000 }] };
    const c = client((options: any) => answered('frontier', options.model));
    const res = await interceptDecisionPoint(shown(s, { adviceRegistry: held }), { adviceClient: c, roots: s.roots, trust: trustAt('act'), shadowConfig: config('act') });
    assert.equal(res.mode, 'show');
    assert.equal(res.warning, "ACT_NOT_SUPPORTED: kind 'tier' is limited to show");
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.elevated, false);
    assert.equal(res.advisorPick, 'frontier');
    const below = await interceptDecisionPoint(shown(s, { adviceRegistry: held, record: false }), { adviceClient: c, roots: s.roots, trust: trustAt('none', 'no result'), shadowConfig: config('act') });
    assert.equal(below.mode, 'shadow');
    assert.equal(below.warning, "ACT_NOT_SUPPORTED: kind 'tier' is limited to show; LOCAL_RESULT_UNMET: none: no result");
  });

  test('175 T7 (i): the trust listing and the ask share one budgetMs deadline and one abort signal', async (t) => {
    const s = store(t);
    const requests: any[] = [];
    const slowTrust = async (request: any) => {
      requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { standing: 'act', reason: 'x' };
    };
    const c = client((options: any) => answered('standard', options.model));
    const res = await interceptDecisionPoint(shown(s, { adviceRegistry: withBudget(400) }), { adviceClient: c, roots: s.roots, trust: slowTrust, shadowConfig: config('act') });
    assert.equal(res.mode, 'act');
    assert.equal(requests[0].timeoutMs, 400, 'the listing gets the whole budget; the client caps it at probeTimeoutMs');
    const asked = c.calls[0][0];
    assert.equal(asked.signal, requests[0].signal, 'one abort signal for both calls');
    assert.ok(asked.timeoutMs > 0 && asked.timeoutMs <= 400 - 140, `the ask gets only what is left: ${asked.timeoutMs}`);
  });

  test('175 T7 (i): a trust call that outlives the budget leaves the static decision within it, unasked', async (t) => {
    const s = store(t);
    let signal: any = null;
    const never = async (request: any) => { signal = request.signal; return new Promise(() => {}); };
    const c = client(answered('standard'));
    const started = Date.now();
    const res = await interceptDecisionPoint(shown(s, { adviceRegistry: withBudget(100), record: false }), { adviceClient: c, roots: s.roots, trust: never, shadowConfig: config('act') });
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms against a 100 ms budget`);
    assert.equal(res.mode, 'shadow');
    assert.match(res.warning, /^LOCAL_RESULT_UNMET: unknown: .*timeout/);
    assert.equal(signal.aborted, true, 'the budget aborts the listing');
    assert.equal(c.calls.length, 0);
  });
});

// Row 174: nothing asks the rerank kind at run time any more (retrieve makes no decision-model call); its question-set
// builder stays for `bench advice-gate`. What is left here is the dispatcher's call-built, multi-answer path.
describe('141 IC-010: the call-built multi-question call (kind rerank, offline)', () => {
  const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
  const { buildRerankQuestionSet } = require('../../src/runtime/advice/rerank.ts');
  const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
  const RERANK = ADVICE.kinds.find((kind: any) => kind.id === 'rerank');
  const CANDIDATES = ['a', 'b', 'c', 'd'].map((name) => ({ ref: `docs/${name}.md`, title: `T ${name}`, text: `candidate text ${name}` }));

  function build(arm: string) {
    const criteria = { ladder: RERANK.scoreLadder.criteria, choiceInstruction: 'choose' };
    const built = buildRerankQuestionSet({
      query: 'a query', candidates: CANDIDATES, params: { ...RERANK.params, arm }, arm, criteria, scoreLadder: RERANK.scoreLadder, limits: ADVICE.limits,
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

  function recordingClient(response: any) {
    const calls: any[] = [];
    return { calls, ask: async (options: any) => { calls.push(options); return typeof response === 'function' ? response(options) : response; } };
  }

  function store(t: any) {
    const dir = tempDir(t, 'doflow-advice-rerank-');
    const projectRoot = path.join(dir, 'proj');
    fs.mkdirSync(projectRoot);
    const env = { HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
    const roots = resolveRoots({ registry: STORAGE, projectRoot, env });
    return { dir, projectRoot, env, roots, lines: () => readWindow({ roots }).records.map((entry: any) => entry.record) };
  }

  function ctx(built: any) {
    return { kind: 'rerank', caller: 'bench', state: built.questionSet.state, staticPick: 'A', questionSet: built.questionSet, adviceRegistry: ADVICE };
  }

  for (const arm of ['choice', 'ladder']) {
    test(`${arm} arm: the client gets no static answer`, async () => {
      const built = build(arm);
      const c = recordingClient(reply(built));
      await askAdvisor(ctx(built), { adviceClient: c }, 'm', 5000);
      assert.equal(c.calls.length, 1);
      assert.equal(c.calls[0].staticAnswer, null, 'a label is not a level of a score question; no static answer goes to the client');
      assert.equal(c.calls[0].kind, 'rerank');
      assert.equal(c.calls[0].record, false);
    });
  }

  test('the advisor call carries the whole reply: every answer, the first one as answer and pick', async () => {
    const built = build('ladder');
    const asked = await askAdvisor(ctx(built), { adviceClient: recordingClient(reply(built)) }, 'm', 5000);
    assert.equal(asked.status, 'answered');
    assert.deepEqual(asked.answers.map((answer: any) => answer.name), ['rerank-a', 'rerank-b', 'rerank-c', 'rerank-d']);
    assert.equal(asked.answer.name, 'rerank-a');
    assert.equal(asked.pick, asked.answers[0].pick);
    assert.ok(asked.answers.every((answer: any) => answer.model === 'm'));
  });

  test('a kind without maxMode still reaches the trust evaluator and act, and a miss line keeps its shape', async (t) => {
    const s = store(t);
    const gated: string[] = [];
    const tierSet = { state: 's', questions: [{ name: 'tier', type: 'choice', instructions: 'Choose.', options: { light: 'L', standard: 'S', frontier: 'F' } }] };
    const answered = { status: 'answered', model: 'm', answers: [{ name: 'tier', type: 'choice', pick: 'frontier', strength: { word: 'clear', between: null }, probabilities: { light: 0.1, standard: 0.1, frontier: 0.8 }, confidence: 0.8 }] };
    const c = recordingClient(answered);
    const res = await interceptDecisionPoint({
      kind: 'tier', caller: 'brief-tools', state: 's', staticPick: 'light', questionSet: tierSet, adviceRegistry: ADVICE, projectRoot: s.projectRoot, env: s.env,
    }, { adviceClient: c, roots: s.roots, trust: async ({ kind }: any) => { gated.push(kind); return { standing: 'act', reason: 'x' }; }, shadowConfig: { kind: 'tier', mode: 'act', model: 'm' } });
    assert.deepEqual(gated, ['tier']);
    assert.equal(res.mode, 'act');
    assert.equal(res.warning, undefined);
    assert.equal(c.calls[0].staticAnswer, 'light', 'a one-question named kind still gets its static answer');
    const [line] = s.lines();
    assert.equal('rerank' in line, false, 'no pick line carries a rerank object any more');
  });
});
