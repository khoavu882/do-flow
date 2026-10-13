'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_CLASS_BUDGETS,
  resolveBudget,
} = require('../../src/runtime/context/budget.ts');

test('budget-resolve: cap precedence: override > profile > task-class', () => {
  const mockProfiles = [
    {
      id: 'claude',
      contextProfile: {
        capacityTokens: { value: 100000, source: 'spec', verifiedOn: '2026-10-13' },
        reserveTokens: { value: 10000, source: 'spec', verifiedOn: '2026-10-13' },
      },
    },
  ];

  // 1. Override takes precedence over profile and taskClass
  const bOverride = resolveBudget({
    taskClass: 'feature',
    maxBytes: 50000,
    harnessFlag: 'claude',
    profiles: mockProfiles,
  });
  assert.equal(bOverride.source, 'override');
  assert.equal(bOverride.maxBytes, 50000);

  // 2. Profile takes precedence over taskClass when capacity & reserve are declared
  const bProfile = resolveBudget({
    taskClass: 'feature',
    harnessFlag: 'claude',
    profiles: mockProfiles,
  });
  assert.equal(bProfile.source, 'profile');
  // (100000 - 0 - 10000) * 4 = 360000
  assert.equal(bProfile.maxBytes, 360000);

  // 3. Fallback to task-class when profile not declared or unverified
  const bTaskClass = resolveBudget({
    taskClass: 'bug',
  });
  assert.equal(bTaskClass.source, 'task-class');
  assert.equal(bTaskClass.maxBytes, TASK_CLASS_BUDGETS.bug);
});

test('budget-resolve: harness identity precedence: flag > env > unstated', () => {
  // 1. Flag source
  const bFlag = resolveBudget({ harnessFlag: 'claude', env: { DOFLOW_AGENT: 'gemini' } });
  assert.equal(bFlag.harness.id, 'claude');
  assert.equal(bFlag.harness.source, 'flag');

  // 2. Env source (registered)
  const bEnv = resolveBudget({ env: { DOFLOW_AGENT: 'gemini' } });
  assert.equal(bEnv.harness.id, 'gemini');
  assert.equal(bEnv.harness.source, 'env');

  // 3. Env unregistered
  const bUnreg = resolveBudget({ env: { DOFLOW_AGENT: 'some-unknown-bot' } });
  assert.equal(bUnreg.harness.id, null);
  assert.equal(bUnreg.harness.source, 'unstated');
  assert.equal(bUnreg.harness.basis, 'env-unregistered');

  // 4. Unstated
  const bUnstated = resolveBudget({ env: {} });
  assert.equal(bUnstated.harness.id, null);
  assert.equal(bUnstated.harness.source, 'unstated');
  assert.equal(bUnstated.harness.basis, undefined);

  // 5. Unknown harnessFlag throws usage error
  assert.throws(
    () => resolveBudget({ harnessFlag: 'nonexistent-agent' }),
    (err) => err.code === 'USAGE_ERROR' || err.message.includes('Unknown harness')
  );
});

test('budget-resolve: capacity basis: declared vs unknown', () => {
  // Harness unstated
  const bUnstated = resolveBudget({ env: {} });
  assert.deepEqual(bUnstated.capacity, { value: null, basis: 'unknown:harness-unstated' });

  // Harness declared with unverified profile
  const mockUnverified = [
    {
      id: 'gemini',
      contextProfile: {
        capacityTokens: { unverified: 'values belong to 085', verifiedOn: '2026-10-13' },
      },
    },
  ];
  const bUnverified = resolveBudget({ harnessFlag: 'gemini', profiles: mockUnverified });
  assert.deepEqual(bUnverified.capacity, { value: null, basis: 'unknown:values belong to 085' });

  // Harness declared with verified profile
  const mockVerified = [
    {
      id: 'gemini',
      contextProfile: {
        capacityTokens: { value: 1000000, source: 'spec', verifiedOn: '2026-10-13' },
        reserveTokens: { value: 20000, source: 'spec', verifiedOn: '2026-10-13' },
        toolResultLimitBytes: { value: 65536, source: 'measured', verifiedOn: '2026-10-13' },
      },
    },
  ];
  const bVerified = resolveBudget({ harnessFlag: 'gemini', profiles: mockVerified });
  assert.deepEqual(bVerified.capacity, { value: 1000000, basis: 'declared:spec' });
  assert.equal(bVerified.toolResultLimitBytes, 65536);
});

test('budget-resolve: substituting a model-name lookup for the harness id fails (negative control)', () => {
  // IC-012 Rule 4: No step reads a model name. Harness ID must be one of the registered harness ids,
  // never a model name (e.g. claude-3-7-sonnet, gemini-2.0-flash, gpt-4o).
  const modelNames = [
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
    'gemini-2.0-flash',
    'gpt-4o',
    'o3-mini',
  ];

  for (const model of modelNames) {
    // Harness flag with model name MUST be rejected as unknown harness
    assert.throws(
      () => resolveBudget({ harnessFlag: model }),
      (err) => err.message.includes(`Unknown harness '${model}'`)
    );

    // DOFLOW_AGENT set to model name MUST NOT resolve as a harness id
    const bEnv = resolveBudget({ env: { DOFLOW_AGENT: model } });
    assert.equal(bEnv.harness.id, null, `model name ${model} must not be accepted as harness id`);
    assert.equal(bEnv.harness.basis, 'env-unregistered');
  }

  // Negative control simulation: if resolveBudget were changed to map model names to harnesses
  function buggyModelResolver({ harnessFlag }) {
    if (harnessFlag?.includes('claude')) return { id: 'claude', source: 'flag' };
    return { id: null, source: 'unstated' };
  }
  const buggyRes = buggyModelResolver({ harnessFlag: 'claude-3-7-sonnet' });
  assert.equal(buggyRes.id, 'claude', 'buggy resolver erroneously maps model name to harness');
  // Confirm that real resolveBudget does NOT do this
  assert.throws(() => resolveBudget({ harnessFlag: 'claude-3-7-sonnet' }));
});
