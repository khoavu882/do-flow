'use strict';

// Feature 085 — Rollout Profiles
// Gate G-P5 Verification Test Suite
// Covers IC-001 (contextProfile), IC-002 (nativeTelemetry),
// and IC-003 (resolveRolloutProfile, sampler).

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
  shouldSample,
  hashKey,
} = require('../../src/runtime/profiles/sampler.ts');

const {
  buildProfilesDoctor,
  printProfilesDoctor,
} = require('../../src/runtime/profiles/doctor.ts');

// --- Test Fixture Helpers ---

function setupTestProject(settingsContent?: any): { projectRoot: string } {
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

  return { projectRoot };
}

function sampleDecision(unitId: string, rate?: number): boolean {
  return shouldSample(unitId, rate);
}

function computeHash(key: string): number {
  return hashKey(key);
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

  test('registry declares exactly seven harnesses', () => {
    assert.equal(harnesses.length, 7, 'Harness registry must contain exactly 7 harnesses');
    const ids = harnesses.map((h: any) => h.id).sort();
    assert.deepEqual(ids, Object.keys(EXPECTED_CONTEXT_PROFILES).sort());
  });

  test('all seven harnesses declare contextProfile with zero unverified facts', () => {
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

  test('all seven harnesses match their empirical context profile values', () => {
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

  test('all seven harnesses declare nativeTelemetry capability block', () => {
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
      verification: 'L0-L1',
      telemetryCanaryTag: true,
    });

    const staged = resolveRolloutProfile({ projectRoot, env: { DOFLOW_ROLLOUT_PROFILE: 'staged' } });
    assert.equal(staged.name, 'staged');
    assert.deepEqual(staged.capabilities, {
      retrieval: 'staged-hybrid',
      advisor: 'staged',
      verification: 'L0-L2',
      telemetryCanaryTag: false,
    });

    const full = resolveRolloutProfile({ projectRoot, env: { DOFLOW_ROLLOUT_PROFILE: 'full' } });
    assert.equal(full.name, 'full');
    assert.deepEqual(full.capabilities, {
      retrieval: 'full-hybrid',
      advisor: 'act',
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

  test('DOFLOW_ROLLOUT_PROFILE=baseline forces baseline over a project configured for full', () => {
    const { projectRoot } = setupTestProject({ 'rollout.profile': 'full' });
    const resolved = resolveRolloutProfile({ projectRoot, env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } });

    assert.equal(resolved.name, 'baseline');
    assert.equal(resolved.origin.source, 'env');
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

  test('isCapabilityActive accurately reflects capability status across profiles', () => {
    // Under baseline: advanced features inactive
    assert.equal(isCapabilityActive('advisor', { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } }), false);
    assert.equal(isCapabilityActive('telemetryCanaryTag', { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } }), false);

    // Under canary: advisor, telemetryCanaryTag active
    assert.equal(isCapabilityActive('advisor', { env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } }), true);
    assert.equal(isCapabilityActive('telemetryCanaryTag', { env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } }), true);

    // Under full: advisor active, telemetryCanaryTag inactive
    assert.equal(isCapabilityActive('advisor', { env: { DOFLOW_ROLLOUT_PROFILE: 'full' } }), true);
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

describe('Gate G-P5 Invariant Verification (Sub-5ms)', () => {
  test('performance: resolveRolloutProfile executes under 5ms', () => {
    const { projectRoot } = setupTestProject();
    const iterations = 100;

    // Warm-up
    resolveRolloutProfile({ projectRoot });

    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      resolveRolloutProfile({ projectRoot });
    }
    const end = process.hrtime.bigint();
    const totalNs = Number(end - start);
    const avgMs = totalNs / iterations / 1_000_000;

    assert.ok(
      avgMs <= 5.0,
      `Profile resolution took ${avgMs.toFixed(3)}ms per call, exceeding 5ms ceiling (NFR-003)`
    );
  });

});

describe('profiles doctor printer (doctor.ts)', () => {
  test('the harness registry line names the registry count with no hardcoded denominator', () => {
    const { projectRoot } = setupTestProject();
    const report = buildProfilesDoctor({ projectRoot, env: {} });
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      printProfilesDoctor(report);
    } finally {
      console.log = realLog;
    }
    const line = lines.find((l) => l.includes('harness registry')) ?? '';
    assert.ok(line, 'the printer emits a harness registry line');
    assert.ok(report.registryVerified.harnessCount > 0);
    assert.ok(line.includes(`${report.registryVerified.harnessCount} harnesses checked`), line);
    assert.ok(!line.includes('/8'), line);
  });
});
