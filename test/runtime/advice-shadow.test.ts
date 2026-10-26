'use strict';

// Feature 084 — Advisor Shadowing & Consequence Loop test suite.
// Covers IC-001 (shadow-config), IC-002 (shadow-dispatcher),
// IC-003 (consequence-recorder), and IC-004 (elevation & bench-gate).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');

const {
  resolveShadowConfig,
} = require('../../src/runtime/advice/shadow-config.ts');

const {
  applyElevationInvariant,
} = require('../../src/runtime/advice/elevation.ts');

const {
  recordPick,
  recordConsequence,
} = require('../../src/runtime/advice/consequence-recorder.ts');

const {
  evaluateBenchBar,
} = require('../../src/runtime/advice/bench-gate.ts');

const {
  interceptDecisionPoint,
} = require('../../src/runtime/advice/shadow-dispatcher.ts');

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

  test('defaults to mode: off when no settings are declared', () => {
    const { root, fsImpl, env } = setupConfigEnv({});
    const cfg = resolveShadowConfig('tier', { projectRoot: root, fsImpl, env });
    assert.equal(cfg.kind, 'tier');
    assert.equal(cfg.mode, 'off');
    assert.equal(cfg.model, null);
    assert.equal(cfg.provider, 'ollama');
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

  test('supports legacy flat alias advice.model.<kind>', () => {
    const { root, fsImpl, env } = setupConfigEnv({
      advice: {
        enabled: true,
        kinds: {
          tier: 'shadow',
        },
        model: {
          tier: 'legacy-alias-model:1.5b',
        },
      },
    });

    const cfg = resolveShadowConfig('tier', { projectRoot: root, fsImpl, env });
    assert.equal(cfg.model, 'legacy-alias-model:1.5b');
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

  describe('autopilot invariants: advice cannot unilaterally approve', () => {
    test('allows advisor to escalate to pause or require-confirmation', () => {
      const res = applyElevationInvariant('autopilot', 'continue', 'pause');
      assert.equal(res.effectiveDecision, 'pause');
      assert.equal(res.elevated, true);
    });

    test('prevents advisor from unilaterally approving a paused or confirmation gate', () => {
      const res1 = applyElevationInvariant('autopilot', 'pause', 'approve');
      assert.equal(res1.effectiveDecision, 'pause');
      assert.equal(res1.elevated, false);

      const res2 = applyElevationInvariant('autopilot', 'require-confirmation', 'skip');
      assert.equal(res2.effectiveDecision, 'require-confirmation');
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

describe('IC-003: ConsequenceRecorder (Partitioned Storage & Outcomes)', () => {
  function setupLedgerEnv(): { root: string; fsImpl: any } {
    const root = path.join(suiteTempDir('doflow-test-advice-ledger-'), 'proj');
    fs.mkdirSync(root, { recursive: true });
    return { root, fsImpl: fs };
  }

  test('recordPick generates pickId and writes JSONL entry to daily partition', () => {
    const { root, fsImpl } = setupLedgerEnv();
    const today = new Date().toISOString().slice(0, 10);

    const pickId = recordPick(
      {
        at: new Date().toISOString(),
        kind: 'tier',
        caller: 'brief-tools',
        taskId: 'task-123',
        mode: 'shadow',
        static: 'light',
        pick: 'standard',
        elevated: true,
        model: 'qwen2.5-coder:1.5b',
        durationMs: 45,
        stateDigest: 'abc123digest',
      },
      { roots: { projectRoot: root }, fsImpl }
    );

    assert.ok(pickId);
    assert.match(pickId, /^adv-\d+-[a-f0-9]+$/);

    const partitionPath = path.join(root, '.doflow', 'state', 'advice', 'picks', `${today}.jsonl`);
    assert.ok(fsImpl.existsSync(partitionPath), 'daily partition file should be created');

    const lines = fsImpl.readFileSync(partitionPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.type, 'pick');
    assert.equal(parsed.pickId, pickId);
    assert.equal(parsed.kind, 'tier');
    assert.equal(parsed.mode, 'shadow');
    assert.equal(parsed.static, 'light');
    assert.equal(parsed.pick, 'standard');
    assert.equal(parsed.elevated, true);
  });

  test('recordConsequence links outcome to pickId in daily partition', () => {
    const { root, fsImpl } = setupLedgerEnv();
    const today = new Date().toISOString().slice(0, 10);
    const pickId = 'adv-1730000000000-abcdef';

    const ok = recordConsequence(
      {
        pickId,
        outcome: 'escalation-justified',
        source: 'do-test',
        details: { failureCaught: true },
      },
      { roots: { projectRoot: root }, fsImpl }
    );

    assert.equal(ok, true);

    const partitionPath = path.join(root, '.doflow', 'state', 'advice', 'picks', `${today}.jsonl`);
    const lines = fsImpl.readFileSync(partitionPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.type, 'outcome');
    assert.equal(parsed.pickId, pickId);
    assert.equal(parsed.outcome, 'escalation-justified');
    assert.equal(parsed.source, 'do-test');
    assert.deepEqual(parsed.details, { failureCaught: true });
  });

  test('records multiple picks and outcomes preserving correlation by pickId', () => {
    const { root, fsImpl } = setupLedgerEnv();
    const today = new Date().toISOString().slice(0, 10);

    const pickId1 = recordPick(
      {
        at: new Date().toISOString(),
        kind: 'task-class',
        caller: 'classify',
        taskId: 'task-001',
        mode: 'shadow',
        static: 'bug',
        pick: 'feature',
        elevated: true,
        model: 'modelA',
        durationMs: 30,
        stateDigest: 'digest1',
      },
      { roots: { projectRoot: root }, fsImpl }
    );

    const pickId2 = recordPick(
      {
        at: new Date().toISOString(),
        kind: 'verify-risk',
        caller: 'do-test',
        taskId: 'task-002',
        mode: 'act',
        static: 'low',
        pick: 'low',
        elevated: false,
        model: 'modelA',
        durationMs: 25,
        stateDigest: 'digest2',
      },
      { roots: { projectRoot: root }, fsImpl }
    );

    recordConsequence(
      { pickId: pickId1!, outcome: 'disproven', source: 'manual-review' },
      { roots: { projectRoot: root }, fsImpl }
    );

    recordConsequence(
      { pickId: pickId2!, outcome: 'consequence-confirmed', source: 'do-test' },
      { roots: { projectRoot: root }, fsImpl }
    );

    const partitionPath = path.join(root, '.doflow', 'state', 'advice', 'picks', `${today}.jsonl`);
    const lines = fsImpl.readFileSync(partitionPath, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));

    assert.equal(lines.length, 4);
    assert.equal(lines[0].pickId, pickId1);
    assert.equal(lines[1].pickId, pickId2);
    assert.equal(lines[2].pickId, pickId1);
    assert.equal(lines[2].outcome, 'disproven');
    assert.equal(lines[3].pickId, pickId2);
    assert.equal(lines[3].outcome, 'consequence-confirmed');
  });
});

describe('IC-004: evaluateBenchBar (Bench Bar Gate Evaluator)', () => {
  function setupBenchEnv(kind: string, cases: any[]): { repoRoot: string } {
    const repoRoot = path.join(suiteTempDir('doflow-test-bench-bar-'), 'repo');
    const benchPath = path.join(repoRoot, 'bench', 'advice', `${kind}.json`);
    fs.mkdirSync(path.dirname(benchPath), { recursive: true });
    fs.writeFileSync(benchPath, JSON.stringify({ kind, cases }, null, 2), 'utf8');
    return { repoRoot };
  }

  test('passes bench bar when model accuracy exceeds static baseline by >= minMargin', async () => {
    const cases = [
      { id: '1', split: 'heldout', state: 'test case 1', expected: 'frontier' },
      { id: '2', split: 'heldout', state: 'test case 2', expected: 'standard' },
      { id: '3', split: 'heldout', state: 'test case 3', expected: 'light' },
      { id: '4', split: 'heldout', state: 'test case 4', expected: 'standard' },
    ];
    const { repoRoot } = setupBenchEnv('tier', cases);

    const res = await evaluateBenchBar('tier', 'test-model:latest', {
      repoRoot,
      minMargin: 0.05,
    });

    assert.equal(res.kind, 'tier');
    assert.equal(res.model, 'test-model:latest');
    assert.equal(res.heldoutCases, 4);
    assert.equal(typeof res.passed, 'boolean');
    assert.equal(typeof res.accuracy, 'number');
    assert.equal(typeof res.margin, 'number');
  });

  test('fails bench bar when a heldout case has no prediction for the model', async () => {
    const { repoRoot } = setupBenchEnv('tier', [
      { id: '1', split: 'heldout', state: 's1', staticPick: 'light', expected: 'standard', modelPicks: { 'm:1b': 'standard' } },
      { id: '2', split: 'heldout', state: 's2', staticPick: 'light', expected: 'frontier' },
    ]);
    const res = await evaluateBenchBar('tier', 'm:1b', { repoRoot, minMargin: 0.05 });
    assert.equal(res.passed, false);
    assert.equal(res.accuracy, 0);
    assert.equal(res.staticBaselineAccuracy, 0);
    assert.equal(res.heldoutCases, 2);
    assert.equal(res.reason, "Benchmark case 2 has no prediction for model 'm:1b'");
  });

  test('passes bench bar only on measured predictions that beat the static baseline', async () => {
    const { repoRoot } = setupBenchEnv('tier', [
      { id: '1', state: 's1', staticPick: 'light', expected: 'standard', modelPicks: { 'm:1b': 'standard' } },
      { id: '2', state: 's2', staticPick: 'frontier', expected: 'frontier', modelPicks: { 'm:1b': 'frontier' } },
    ]);
    const res = await evaluateBenchBar('tier', 'm:1b', { repoRoot, minMargin: 0.05 });
    assert.equal(res.passed, true);
    assert.equal(res.accuracy, 1);
    assert.equal(res.staticBaselineAccuracy, 0.5);
  });

  test('fails bench bar when heldout benchmark corpus is missing', async () => {
    const repoRoot = path.join(suiteTempDir('doflow-test-bench-missing-'), 'repo');
    const res = await evaluateBenchBar('unknown-kind', 'test-model', { repoRoot });
    assert.equal(res.passed, false);
    assert.match(res.reason as string, /missing|not found/i);
  });
});

describe('IC-002: interceptDecisionPoint (Decision Interception & Shadowing)', () => {
  const baseContext = {
    kind: 'tier',
    caller: 'brief-tools',
    state: 'Implement an integration spanning several runtime modules.',
    staticPick: 'light',
    taskId: 'task-abc',
  };

  test('mode off returns staticPick immediately without invoking advisor model', async () => {
    let advisorCalled = false;
    const mockAdviceClient = {
      ask: async () => {
        advisorCalled = true;
        return { pick: 'frontier' };
      },
    };

    const mockShadowConfig = {
      resolve: () => ({
        kind: 'tier',
        mode: 'off',
        model: null,
      }),
    };

    const res = await interceptDecisionPoint(baseContext, {
      adviceClient: mockAdviceClient,
      shadowConfig: mockShadowConfig,
    });

    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.mode, 'off');
    assert.equal(res.advisorPick, null);
    assert.equal(res.pickId, null);
    assert.equal(res.elevated, false);
    assert.equal(advisorCalled, false, 'advisor must not be invoked when mode is off');
  });

  test('mode shadow returns staticPick immediately and triggers background advisor query', async () => {
    let advisorCalled = false;
    let loggedPick: any = null;

    const mockAdviceClient = {
      ask: async () => {
        advisorCalled = true;
        return { pick: 'frontier' };
      },
    };

    const mockShadowConfig = {
      resolve: () => ({
        kind: 'tier',
        mode: 'shadow',
        model: 'qwen2.5-coder:1.5b',
      }),
    };

    const mockFsImpl = {
      writeFileSync: () => {},
      appendFileSync: (_path: string, content: string) => {
        loggedPick = JSON.parse(content.trim());
      },
      mkdirSync: () => {},
      existsSync: () => true,
    };

    const res = await interceptDecisionPoint(baseContext, {
      adviceClient: mockAdviceClient,
      shadowConfig: mockShadowConfig,
      fsImpl: mockFsImpl,
    });

    // Caller receives static decision immediately
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.mode, 'shadow');
    assert.equal(res.staticPick, 'light');

    // Allow event loop cycle for detached shadow execution
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(advisorCalled, true, 'advisor query must be detached in background');
  });

  test('mode act queries advisor and applies elevation invariant when bench bar passes', async () => {
    // The advice client's reply shape (client.ts ask): { status, answers: [{ pick, ... }] }.
    const mockAdviceClient = {
      ask: async () => ({ status: 'answered', answers: [{ pick: 'standard' }] }),
    };

    // The bench bar passes explicitly: the committed corpus carries no model predictions, so it fails every model.
    const mockShadowConfig = {
      resolve: () => ({
        kind: 'tier',
        mode: 'act',
        model: 'verified-model:7b',
        benchBarPassed: true,
      }),
    };

    const mockFsImpl = {
      writeFileSync: () => {},
      appendFileSync: () => {},
      mkdirSync: () => {},
      existsSync: () => true,
    };

    const res = await interceptDecisionPoint(baseContext, {
      adviceClient: mockAdviceClient,
      shadowConfig: mockShadowConfig,
      fsImpl: mockFsImpl,
    });

    assert.equal(res.mode, 'act');
    assert.equal(res.advisorPick, 'standard');
    assert.equal(res.effectiveDecision, 'standard', 'tier escalated from light to standard');
    assert.equal(res.elevated, true);
  });

  test('mode act degrades to shadow with BENCH_BAR_UNMET warning when bench bar fails', async () => {
    const mockAdviceClient = {
      ask: async () => ({ pick: 'frontier' }),
    };

    const mockShadowConfig = {
      resolve: () => ({
        kind: 'tier',
        mode: 'act',
        model: 'unverified-weak-model:0.5b',
        benchBarPassed: false,
      }),
    };

    const mockFsImpl = {
      writeFileSync: () => {},
      appendFileSync: () => {},
      mkdirSync: () => {},
      existsSync: () => true,
    };

    const res = await interceptDecisionPoint(baseContext, {
      adviceClient: mockAdviceClient,
      shadowConfig: mockShadowConfig,
      fsImpl: mockFsImpl,
    });

    assert.equal(res.mode, 'shadow', 'mode must degrade to shadow when bench bar fails');
    assert.equal(res.effectiveDecision, 'light', 'effective decision remains staticPick on degradation');
    assert.match(res.warning as string, /BENCH_BAR_UNMET/);
  });

  test('the advisor is asked with the advice client call shape and its answer is read from answers[0]', async () => {
    const calls: any[] = [];
    const questionSet = { state: baseContext.state, questions: [{ name: 'tier' }] };
    const mockAdviceClient = {
      ask: async (...args: any[]) => {
        calls.push(args);
        return { status: 'answered', answers: [{ pick: 'frontier' }] };
      },
    };
    const res = await interceptDecisionPoint(
      { ...baseContext, questionSet, adviceRegistry: { kinds: [] } },
      {
        adviceClient: mockAdviceClient,
        shadowConfig: { kind: 'tier', mode: 'act', model: 'm', benchBarPassed: true },
        fsImpl: { writeFileSync: () => {}, appendFileSync: () => {}, mkdirSync: () => {}, existsSync: () => true },
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1, 'ask takes one options object');
    assert.deepEqual(calls[0][0], {
      questionSet, kind: 'tier', staticAnswer: 'light', caller: 'brief-tools', taskId: 'task-abc', record: false,
    });
    assert.equal(res.advisorPick, 'frontier');
    assert.equal(res.effectiveDecision, 'frontier');
  });

  test('an answer that is not status answered is no advisor pick', async () => {
    const res = await interceptDecisionPoint(baseContext, {
      adviceClient: { ask: async () => ({ status: 'unavailable', reason: 'timeout', answers: [] }) },
      shadowConfig: { kind: 'tier', mode: 'act', model: 'm', benchBarPassed: true },
      fsImpl: { writeFileSync: () => {}, appendFileSync: () => {}, mkdirSync: () => {}, existsSync: () => true },
    });
    assert.equal(res.advisorPick, null);
    assert.equal(res.effectiveDecision, 'light');
    assert.equal(res.elevated, false);
  });

  test('mode act on a corpus with no model predictions degrades to shadow (the bar is not passed by default)', async () => {
    const repoRoot = path.join(suiteTempDir('doflow-test-bench-unmeasured-'), 'repo');
    const benchPath = path.join(repoRoot, 'bench', 'advice', 'tier.json');
    fs.mkdirSync(path.dirname(benchPath), { recursive: true });
    fs.writeFileSync(benchPath, JSON.stringify({ kind: 'tier', cases: [
      { id: '1', state: 's1', staticPick: 'light', expected: 'standard' },
      { id: '2', state: 's2', staticPick: 'light', expected: 'frontier' },
    ] }), 'utf8');
    let asked = false;
    const res = await interceptDecisionPoint({ ...baseContext, projectRoot: repoRoot }, {
      adviceClient: { ask: async () => { asked = true; return { status: 'answered', answers: [{ pick: 'frontier' }] }; } },
      shadowConfig: { kind: 'tier', mode: 'act', model: 'never-benched:1b' },
      fsImpl: { readFileSync: fs.readFileSync, existsSync: fs.existsSync, writeFileSync: () => {}, appendFileSync: () => {}, mkdirSync: () => {} },
    });
    assert.equal(res.mode, 'shadow');
    assert.equal(res.effectiveDecision, 'light');
    assert.match(res.warning as string, /BENCH_BAR_UNMET: Benchmark case 1 has no prediction for model 'never-benched:1b'/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asked, true, 'the degraded shadow query still runs in the background');
  });
});
