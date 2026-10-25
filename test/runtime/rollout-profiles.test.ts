'use strict';

// Feature 085 — Rollout Profiles & Instant Rollback Controller
// Gate G-P5 Verification Test Suite
// Covers IC-001 (contextProfile), IC-002 (nativeTelemetry),
// IC-003 (resolveRolloutProfile, sampler), and IC-004 (rollback, circuit-breaker).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const {
  resolveRolloutProfile,
  isCapabilityActive,
} = require('../../src/runtime/profiles/resolve.ts');

const {
  CanarySampler,
  shouldSample,
  hashKey,
} = require('../../src/runtime/profiles/sampler.ts');

const {
  checkRollbackState,
  tripRollback,
  resetRollback,
  recordProviderFailure,
} = require('../../src/runtime/profiles/rollback.ts');

// --- Test Fixture Helpers ---

function setupTestProject(settingsContent?: any, initialRollback?: any): { projectRoot: string } {
  const projectRoot = suiteTempDir('doflow-test-profile-proj-');
  const doflowDir = path.join(projectRoot, '.doflow');
  fs.mkdirSync(doflowDir, { recursive: true });

  if (settingsContent) {
    fs.writeFileSync(
      path.join(doflowDir, 'settings.json'),
      JSON.stringify(settingsContent, null, 2),
      'utf8'
    );
  }

  if (initialRollback) {
    const stateDir = path.join(doflowDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'rollback.json'),
      JSON.stringify(initialRollback, null, 2),
      'utf8'
    );
  }

  return { projectRoot };
}

function sampleDecision(unitId: string, rate?: number): boolean {
  if (typeof shouldSample === 'function') {
    return shouldSample(unitId, rate);
  }
  const sampler = new CanarySampler();
  return sampler.shouldSample(unitId, rate);
}

function computeHash(key: string): number {
  if (typeof hashKey === 'function') {
    return hashKey(key);
  }
  const sampler = new CanarySampler();
  return sampler.hashKey(key);
}

// --- Test Suites ---

describe('IC-001: Harness Context Profiles (core/registry/harnesses.json)', () => {
  const registryPath = path.join(REPO_ROOT, 'core', 'registry', 'harnesses.json');
  const registryData = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const harnesses = registryData.harnesses || [];

  const EXPECTED_CONTEXT_PROFILES: Record<string, any> = {
    claude: {
      capacityTokens: 200000,
      reserveTokens: 20000,
      tokenTelemetry: 'none',
      toolResultLimitBytes: 524288,
      retention: 'supported',
    },
    codex: {
      capacityTokens: 200000,
      reserveTokens: 20000,
      tokenTelemetry: 'none',
      toolResultLimitBytes: 1048576,
      retention: 'unsupported',
    },
    gemini: {
      capacityTokens: 1000000,
      reserveTokens: 50000,
      tokenTelemetry: 'none',
      toolResultLimitBytes: 1048576,
      retention: 'unsupported',
    },
    antigravity: {
      capacityTokens: 1000000,
      reserveTokens: 50000,
      tokenTelemetry: 'none',
      toolResultLimitBytes: 1048576,
      retention: 'unsupported',
    },
    opencode: {
      capacityTokens: 128000,
      reserveTokens: 10000,
      tokenTelemetry: 'none',
      toolResultLimitBytes: 262144,
      retention: 'unsupported',
    },
    pi: {
      capacityTokens: 128000,
      reserveTokens: 10000,
      tokenTelemetry: 'none',
      toolResultLimitBytes: 262144,
      retention: 'unsupported',
    },
    copilot: {
      capacityTokens: 128000,
      reserveTokens: 10000,
      tokenTelemetry: 'none',
      toolResultLimitBytes: 262144,
      retention: 'unsupported',
    },
    kiro: {
      capacityTokens: 128000,
      reserveTokens: 10000,
      tokenTelemetry: 'none',
      toolResultLimitBytes: 262144,
      retention: 'unsupported',
    },
  };

  test('registry declares exactly eight harnesses', () => {
    assert.equal(harnesses.length, 8, 'Harness registry must contain exactly 8 harnesses');
    const ids = harnesses.map((h: any) => h.id).sort();
    assert.deepEqual(ids, Object.keys(EXPECTED_CONTEXT_PROFILES).sort());
  });

  test('all eight harnesses declare contextProfile with zero unverified facts', () => {
    const requiredFields = [
      'capacityTokens',
      'reserveTokens',
      'tokenTelemetry',
      'toolResultLimitBytes',
      'retention',
    ];

    for (const harness of harnesses) {
      assert.ok(harness.contextProfile, `Harness ${harness.id} must define contextProfile`);
      for (const field of requiredFields) {
        const fact = harness.contextProfile[field];
        assert.ok(fact, `Harness ${harness.id} contextProfile must include ${field}`);
        assert.equal(
          fact.unverified,
          undefined,
          `Harness ${harness.id} field ${field} must NOT be unverified (FR-001)`
        );
        assert.notEqual(fact.value, undefined, `Harness ${harness.id} field ${field} must have value`);
        assert.equal(
          typeof fact.source,
          'string',
          `Harness ${harness.id} field ${field} must declare a non-empty source`
        );
        assert.ok(fact.source.trim().length > 0);
        assert.match(
          fact.verifiedOn,
          /^\d{4}-\d{2}-\d{2}$/,
          `Harness ${harness.id} field ${field} verifiedOn must be ISO date`
        );
      }
    }
  });

  test('all eight harnesses match their empirical context profile values', () => {
    for (const harness of harnesses) {
      const expected = EXPECTED_CONTEXT_PROFILES[harness.id];
      assert.ok(expected, `Unknown harness ${harness.id}`);
      const profile = harness.contextProfile;

      assert.equal(profile.capacityTokens.value, expected.capacityTokens, `${harness.id} capacityTokens`);
      assert.equal(profile.reserveTokens.value, expected.reserveTokens, `${harness.id} reserveTokens`);
      assert.equal(profile.tokenTelemetry.value, expected.tokenTelemetry, `${harness.id} tokenTelemetry`);
      assert.equal(profile.toolResultLimitBytes.value, expected.toolResultLimitBytes, `${harness.id} toolResultLimitBytes`);
      assert.equal(profile.retention.value, expected.retention, `${harness.id} retention`);
    }
  });
});

describe('IC-002: Harness Native Telemetry (core/registry/harnesses.json)', () => {
  const registryPath = path.join(REPO_ROOT, 'core', 'registry', 'harnesses.json');
  const registryData = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const harnesses = registryData.harnesses || [];

  const EXPECTED_TELEMETRY: Record<string, any> = {
    claude: {
      signals: ['spans', 'events'],
      contentDefaults: 'metadata-only',
      inboundTraceparent: 'unsupported',
      joinKey: 'tool_use_id',
    },
    codex: {
      signals: ['events'],
      contentDefaults: 'metadata-only',
      inboundTraceparent: 'unsupported',
      joinKey: 'session_id',
    },
    gemini: {
      signals: [],
      contentDefaults: 'metadata-only',
      inboundTraceparent: 'unsupported',
      joinKey: 'session_id',
    },
    antigravity: {
      signals: [],
      contentDefaults: 'metadata-only',
      inboundTraceparent: 'unsupported',
      joinKey: 'session_id',
    },
    opencode: {
      signals: [],
      contentDefaults: 'metadata-only',
      inboundTraceparent: 'unsupported',
      joinKey: 'run_id',
    },
    pi: {
      signals: [],
      contentDefaults: 'metadata-only',
      inboundTraceparent: 'unsupported',
      joinKey: 'session_id',
    },
    copilot: {
      signals: [],
      contentDefaults: 'metadata-only',
      inboundTraceparent: 'unsupported',
      joinKey: 'run_id',
    },
    kiro: {
      signals: [],
      contentDefaults: 'metadata-only',
      inboundTraceparent: 'unsupported',
      joinKey: 'session_id',
    },
  };

  test('all eight harnesses declare nativeTelemetry capability block', () => {
    for (const harness of harnesses) {
      assert.ok(harness.nativeTelemetry, `Harness ${harness.id} must declare nativeTelemetry`);
      const expected = EXPECTED_TELEMETRY[harness.id];
      assert.ok(expected, `Unknown harness ${harness.id}`);

      // NFR-004: Zero content leaks - metadata-only strictly enforced
      assert.equal(
        harness.nativeTelemetry.contentDefaults,
        'metadata-only',
        `${harness.id} contentDefaults must be 'metadata-only'`
      );
      assert.deepEqual(harness.nativeTelemetry.signals, expected.signals, `${harness.id} signals`);
      assert.equal(harness.nativeTelemetry.joinKey, expected.joinKey, `${harness.id} joinKey`);
      assert.equal(harness.nativeTelemetry.inboundTraceparent, expected.inboundTraceparent, `${harness.id} inboundTraceparent`);
      assert.match(
        harness.nativeTelemetry.verifiedOn,
        /^\d{4}-\d{2}-\d{2}$/,
        `${harness.id} verifiedOn must be ISO date`
      );
    }
  });
});

describe('IC-003: Rollout Profile Configuration & Resolver (resolve.ts)', () => {
  test('settings registry declares rollout.profile with enum baseline, canary, staged, full', () => {
    const settingsPath = path.join(REPO_ROOT, 'core', 'registry', 'settings.json');
    const settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const spec = settingsData.keys?.['rollout.profile'];

    assert.ok(spec, "settings.json must declare 'rollout.profile'");
    assert.equal(spec.type, 'enum');
    assert.deepEqual(spec.values, ['baseline', 'canary', 'staged', 'full']);
    assert.equal(spec.default, 'baseline');
    assert.equal(spec.failSafe, 'baseline');
    assert.equal(spec.env?.name, 'DOFLOW_ROLLOUT_PROFILE');
  });

  test('default profile resolves to baseline with default origin', () => {
    const { projectRoot } = setupTestProject();
    const resolved = resolveRolloutProfile({ projectRoot, env: {} });

    assert.equal(resolved.name, 'baseline');
    assert.equal(resolved.origin.source, 'default');
    assert.equal(resolved.canarySampleRate, 0.10);
    assert.deepEqual(resolved.capabilities, {
      retrieval: 'lexical',
      advisor: 'off',
      graph: 'off',
      verification: 'L0',
      telemetryCanaryTag: false,
    });
  });

  test('capability matrix reflects correct values for canary, staged, and full profiles', () => {
    const { projectRoot } = setupTestProject();

    const canary = resolveRolloutProfile({ projectRoot, env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } });
    assert.equal(canary.name, 'canary');
    assert.deepEqual(canary.capabilities, {
      retrieval: 'canary-hybrid',
      advisor: 'shadow',
      graph: 'advisory',
      verification: 'L0-L1',
      telemetryCanaryTag: true,
    });

    const staged = resolveRolloutProfile({ projectRoot, env: { DOFLOW_ROLLOUT_PROFILE: 'staged' } });
    assert.equal(staged.name, 'staged');
    assert.deepEqual(staged.capabilities, {
      retrieval: 'staged-hybrid',
      advisor: 'staged',
      graph: 'bounded',
      verification: 'L0-L2',
      telemetryCanaryTag: false,
    });

    const full = resolveRolloutProfile({ projectRoot, env: { DOFLOW_ROLLOUT_PROFILE: 'full' } });
    assert.equal(full.name, 'full');
    assert.deepEqual(full.capabilities, {
      retrieval: 'full-hybrid',
      advisor: 'act',
      graph: 'full',
      verification: 'L0-L3',
      telemetryCanaryTag: false,
    });
  });

  test('environment variable override DOFLOW_ROLLOUT_PROFILE takes top precedence', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'baseline' });
    const resolved = resolveRolloutProfile({
      projectRoot,
      env: { DOFLOW_ROLLOUT_PROFILE: 'full' },
    });

    assert.equal(resolved.name, 'full');
    assert.equal(resolved.origin.source, 'env');
    assert.equal(resolved.origin.detail, 'DOFLOW_ROLLOUT_PROFILE');
  });

  test('invalid profile in env or settings falls safe to baseline', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'non-existent-profile' });
    const resolvedFromSettings = resolveRolloutProfile({ projectRoot, env: {} });
    assert.equal(resolvedFromSettings.name, 'baseline');

    const resolvedFromEnv = resolveRolloutProfile({
      projectRoot,
      env: { DOFLOW_ROLLOUT_PROFILE: 'unknown-turbo-mode' },
    });
    assert.equal(resolvedFromEnv.name, 'baseline');
  });

  test('project-level settings.json configures rollout profile', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'canary' });
    const resolved = resolveRolloutProfile({ projectRoot, env: {} });

    assert.equal(resolved.name, 'canary');
    assert.equal(resolved.origin.source, 'project');
  });

  test('rollback sentinel forces baseline even if project configured for full', () => {
    const { projectRoot } = setupTestProject(
      { 'rollout.profile': 'full' },
      { active: true, reason: 'sentinel test', origin: 'sentinel', targetProfile: 'baseline' }
    );
    const resolved = resolveRolloutProfile({ projectRoot, env: {} });

    assert.equal(resolved.name, 'baseline');
    assert.equal(resolved.origin.source, 'sentinel');
  });

  test('isCapabilityActive accurately reflects capability status across profiles', () => {
    // Under baseline: advanced features inactive
    assert.equal(isCapabilityActive('advisor', { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } }), false);
    assert.equal(isCapabilityActive('graph', { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } }), false);
    assert.equal(isCapabilityActive('telemetryCanaryTag', { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } }), false);

    // Under canary: advisor, graph, telemetryCanaryTag active
    assert.equal(isCapabilityActive('advisor', { env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } }), true);
    assert.equal(isCapabilityActive('graph', { env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } }), true);
    assert.equal(isCapabilityActive('telemetryCanaryTag', { env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } }), true);

    // Under full: advisor and graph active, telemetryCanaryTag inactive
    assert.equal(isCapabilityActive('advisor', { env: { DOFLOW_ROLLOUT_PROFILE: 'full' } }), true);
    assert.equal(isCapabilityActive('graph', { env: { DOFLOW_ROLLOUT_PROFILE: 'full' } }), true);
    assert.equal(isCapabilityActive('telemetryCanaryTag', { env: { DOFLOW_ROLLOUT_PROFILE: 'full' } }), false);
  });
});

describe('IC-003: Canary Deterministic Sampler (sampler.ts)', () => {
  test('sampler produces deterministic output for identical keys', () => {
    const keys = ['auth-flow', 'task-001', 'subsystem-core', 'unit-test-run'];
    for (const key of keys) {
      const first = sampleDecision(key, 0.10);
      for (let i = 0; i < 10; i++) {
        assert.equal(
          sampleDecision(key, 0.10),
          first,
          `Key ${key} must yield deterministic sample decision`
        );
      }
    }
  });

  test('sampler respects rate boundary conditions (0.0 and 1.0)', () => {
    const keys = ['k1', 'k2', 'k3', 'alpha', 'beta', 'gamma'];
    for (const k of keys) {
      assert.equal(sampleDecision(k, 0.0), false, 'Rate 0.0 must never sample');
      assert.equal(sampleDecision(k, 1.0), true, 'Rate 1.0 must always sample');
    }
  });

  test('sampler approximates configured sample rate on varied keys', () => {
    const total = 500;
    let sampled = 0;
    for (let i = 0; i < total; i++) {
      if (sampleDecision(`feature-sample-key-${i}`, 0.10)) {
        sampled++;
      }
    }
    const sampleRate = sampled / total;
    // For 500 uniform keys with p=0.10, sample count should be between 3% and 20%
    assert.ok(
      sampleRate >= 0.03 && sampleRate <= 0.20,
      `Expected sample rate ~0.10, got ${sampleRate.toFixed(3)} (${sampled}/${total})`
    );
  });

  test('sampler handles empty string, path characters, and unicode safely', () => {
    assert.doesNotThrow(() => sampleDecision('', 0.10));
    assert.doesNotThrow(() => sampleDecision('/tmp/workspace/file.ts:123', 0.10));
    assert.doesNotThrow(() => sampleDecision('🚀-feature-test-日本語', 0.10));
    assert.doesNotThrow(() => computeHash('test-key'));
    assert.equal(typeof computeHash('test-key'), 'number');
  });
});

describe('IC-004: Instant Rollback Controller & Circuit Breaker (rollback.ts)', () => {
  test('checkRollbackState returns inactive in clean environment', () => {
    const { projectRoot } = setupTestProject();
    const state = checkRollbackState({ projectRoot, env: {} });
    assert.equal(state.active, false);
    assert.equal(state.reason, null);
    assert.equal(state.origin, 'none');
    assert.equal(state.targetProfile, 'baseline');
  });

  test('checkRollbackState detects env override DOFLOW_ROLLOUT_PROFILE=baseline', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'full' });
    const state = checkRollbackState({ projectRoot, env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } });
    assert.equal(state.active, true);
    assert.equal(state.origin, 'env');
    assert.equal(state.targetProfile, 'baseline');
  });

  test('tripRollback writes sentinel file and sets rollback active', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'full' });
    const res = tripRollback({ reason: 'Operator requested emergency rollback', projectRoot });
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(res.path));

    const content = JSON.parse(fs.readFileSync(res.path, 'utf8'));
    assert.equal(content.active, true);
    assert.equal(content.reason, 'Operator requested emergency rollback');
    assert.equal(content.origin, 'sentinel');
    assert.equal(content.targetProfile, 'baseline');
    assert.ok(content.triggeredAt);

    const state = checkRollbackState({ projectRoot, env: {} });
    assert.equal(state.active, true);
    assert.equal(state.origin, 'sentinel');
    assert.equal(state.reason, 'Operator requested emergency rollback');

    const profile = resolveRolloutProfile({ projectRoot, env: {} });
    assert.equal(profile.name, 'baseline');
    assert.equal(profile.origin.source, 'sentinel');
  });

  test('resetRollback deletes sentinel file and restores configured profile', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'canary' });
    tripRollback({ reason: 'Temporary pause', projectRoot });
    assert.equal(checkRollbackState({ projectRoot, env: {} }).active, true);

    const resetRes = resetRollback({ projectRoot });
    assert.equal(resetRes.ok, true);

    const stateAfter = checkRollbackState({ projectRoot, env: {} });
    assert.equal(stateAfter.active, false);

    const profileAfter = resolveRolloutProfile({ projectRoot, env: {} });
    assert.equal(profileAfter.name, 'canary');
    assert.equal(profileAfter.origin.source, 'project');
  });

  test('recordProviderFailure trips breaker after 3 consecutive failures', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'full' });

    const f1 = recordProviderFailure('ollama', new Error('timeout 10000ms'), { projectRoot });
    assert.equal(f1.tripped, false);
    assert.equal(f1.failureCount, 1);
    assert.equal(checkRollbackState({ projectRoot, env: {} }).active, false);

    const f2 = recordProviderFailure('ollama', new Error('OOM kill'), { projectRoot });
    assert.equal(f2.tripped, false);
    assert.equal(f2.failureCount, 2);
    assert.equal(checkRollbackState({ projectRoot, env: {} }).active, false);

    const f3 = recordProviderFailure('ollama', new Error('ECONNREFUSED'), { projectRoot });
    assert.equal(f3.tripped, true);
    assert.equal(f3.failureCount, 3);

    const state = checkRollbackState({ projectRoot, env: {} });
    assert.equal(state.active, true);
    assert.equal(state.origin, 'circuit-breaker');

    const profile = resolveRolloutProfile({ projectRoot, env: {} });
    assert.equal(profile.name, 'baseline');
  });

  test('circuit breaker isolates failures per provider', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'full' });

    recordProviderFailure('ollama', 'fail-1', { projectRoot });
    recordProviderFailure('ollama', 'fail-2', { projectRoot });

    // Semble failure starts at count 1, not affected by ollama count
    const sembleRes = recordProviderFailure('semble', 'fail-semble-1', { projectRoot });
    assert.equal(sembleRes.tripped, false);
    assert.equal(sembleRes.failureCount, 1);
  });

  test('corrupted or unreadable sentinel fails safe to baseline without crashing', () => {
    const { projectRoot } = setupTestProject();
    const sentinelPath = path.join(projectRoot, '.doflow', 'state', 'rollback.json');
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, '{ corrupted json ! syntax error', 'utf8');

    assert.doesNotThrow(() => {
      const state = checkRollbackState({ projectRoot, env: {} });
      assert.equal(state.active, true);
      assert.equal(state.targetProfile, 'baseline');
    });
  });
});

describe('Gate G-P5 Invariant Verification (Zero-Repo-Change, Zero-Reindex, Sub-5ms)', () => {
  test('zero-repo-change: tripRollback modifies only .doflow/state/ and touches 0 tracked files', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'canary' });

    // Simulate tracked files in the repo root
    const pkgPath = path.join(projectRoot, 'package.json');
    const srcPath = path.join(projectRoot, 'src', 'index.ts');
    const settingsPath = path.join(projectRoot, '.doflow', 'settings.json');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'test-pkg', version: '1.0.0' }), 'utf8');
    fs.writeFileSync(srcPath, 'export const x = 1;\n', 'utf8');

    const pkgStatBefore = fs.statSync(pkgPath);
    const srcStatBefore = fs.statSync(srcPath);
    const settingsStatBefore = fs.statSync(settingsPath);
    const pkgContentBefore = fs.readFileSync(pkgPath, 'utf8');
    const srcContentBefore = fs.readFileSync(srcPath, 'utf8');
    const settingsContentBefore = fs.readFileSync(settingsPath, 'utf8');

    // Trigger rollback
    const tripResult = tripRollback({ reason: 'testing zero-repo-change', projectRoot });
    assert.equal(tripResult.ok, true);

    // Assert tracked files are completely unmodified
    assert.equal(fs.readFileSync(pkgPath, 'utf8'), pkgContentBefore);
    assert.equal(fs.readFileSync(srcPath, 'utf8'), srcContentBefore);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsContentBefore);
    assert.equal(fs.statSync(pkgPath).mtimeMs, pkgStatBefore.mtimeMs);
    assert.equal(fs.statSync(srcPath).mtimeMs, srcStatBefore.mtimeMs);
    assert.equal(fs.statSync(settingsPath).mtimeMs, settingsStatBefore.mtimeMs);

    // Assert the created sentinel is strictly in .doflow/state/
    const stateDir = path.join(projectRoot, '.doflow', 'state');
    assert.ok(fs.existsSync(stateDir));
    assert.ok(fs.existsSync(path.join(stateDir, 'rollback.json')));
  });

  test('zero-reindex: existing semantic index and graph cache are untouched during rollback', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'full' });
    const indexDir = path.join(projectRoot, '.doflow', 'state', 'retrieval');
    const graphDir = path.join(projectRoot, '.doflow', 'state', 'graph');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.mkdirSync(graphDir, { recursive: true });

    const vectorDb = path.join(indexDir, 'embeddings.bin');
    const graphCache = path.join(graphDir, 'cache.json');
    fs.writeFileSync(vectorDb, Buffer.from('mock-dense-vector-data'), 'utf8');
    fs.writeFileSync(graphCache, JSON.stringify({ nodes: ['A', 'B'], edges: [] }), 'utf8');

    const vectorStat = fs.statSync(vectorDb);
    const graphStat = fs.statSync(graphCache);

    // Trip rollback
    tripRollback({ reason: 'revert to baseline', projectRoot });

    // Resolve profile (now baseline)
    const resolved = resolveRolloutProfile({ projectRoot });
    assert.equal(resolved.name, 'baseline');
    assert.equal(resolved.capabilities.retrieval, 'lexical');
    assert.equal(resolved.capabilities.graph, 'off');

    // Verify index files still exist with unchanged contents and mtimes
    assert.ok(fs.existsSync(vectorDb));
    assert.ok(fs.existsSync(graphCache));
    assert.equal(fs.statSync(vectorDb).mtimeMs, vectorStat.mtimeMs);
    assert.equal(fs.statSync(graphCache).mtimeMs, graphStat.mtimeMs);
    assert.equal(fs.readFileSync(vectorDb).toString(), 'mock-dense-vector-data');
  });

  test('performance: resolveRolloutProfile and checkRollbackState execute under 5ms', () => {
    const { projectRoot } = setupTestProject();
    const iterations = 100;

    // Warm-up
    resolveRolloutProfile({ projectRoot });
    checkRollbackState({ projectRoot });

    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      resolveRolloutProfile({ projectRoot });
      checkRollbackState({ projectRoot });
    }
    const end = process.hrtime.bigint();
    const totalNs = Number(end - start);
    const avgMs = totalNs / iterations / 1_000_000;

    assert.ok(
      avgMs <= 5.0,
      `Profile resolution and rollback check took ${avgMs.toFixed(3)}ms per call, exceeding 5ms ceiling (NFR-003)`
    );
  });

  test('continuation: provider offline (ECONNREFUSED) records fault and falls back cleanly without throw', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'canary' });

    // Simulate provider connection refusal (e.g. Ollama or Semble daemon down)
    const networkError = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    (networkError as any).code = 'ECONNREFUSED';

    assert.doesNotThrow(() => {
      const res = recordProviderFailure('ollama', networkError, { projectRoot });
      assert.equal(res.tripped, false);
      assert.equal(res.failureCount, 1);
    });

    // Profile resolution still succeeds
    const profile = resolveRolloutProfile({ projectRoot });
    assert.ok(profile);
    assert.equal(profile.name, 'canary');

    // Fail 2 more times to trip breaker
    recordProviderFailure('ollama', networkError, { projectRoot });
    const tripped = recordProviderFailure('ollama', networkError, { projectRoot });
    assert.equal(tripped.tripped, true);
    assert.equal(tripped.failureCount, 3);

    // After trip, state is active rollback
    const rollback = checkRollbackState({ projectRoot });
    assert.equal(rollback.active, true);
    assert.equal(rollback.origin, 'circuit-breaker');

    // Fallback to baseline is instantaneous and clean
    const fallbackProfile = resolveRolloutProfile({ projectRoot });
    assert.equal(fallbackProfile.name, 'baseline');
    assert.equal(fallbackProfile.capabilities.advisor, 'off');
  });
});
