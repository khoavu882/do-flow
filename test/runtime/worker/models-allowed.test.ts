'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveBinding, bindingGap } = require('../../../src/runtime/worker/models.ts');
import type { ObservedCatalogue } from '../../../src/runtime/models/types.ts';

const SUP = {
  model: {
    status: 'supported',
    evidence: ['test'],
    argv: ['-m', '{model}'],
  },
};

const UNEVIDENCED = {
  model: {
    status: 'unsupported',
  },
};

const catalogueFixture: ObservedCatalogue = {
  version: 1,
  syncedAt: '2026-10-25T12:00:00.000Z',
  harnesses: {
    claude: {
      harnessId: 'claude',
      binary: 'claude',
      installed: true,
      version: '1.0.0',
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode: 'subscription',
      derivedBilling: 'free',
      offeredModels: [
        { id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', family: 'claude' },
        { id: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet', family: 'claude' },
      ],
      lastSyncedAt: '2026-10-25T12:00:00.000Z',
    },
  },
};

test('Slice D: resolveBinding accepts model synced in catalogue and in models.enabled', () => {
  const bindings = {
    state: 'set' as const,
    map: { claude: { standard: 'claude-3-7-sonnet' } },
    reason: null,
  };

  const res = resolveBinding({
    worker: 'claude',
    tier: 'standard',
    bindings,
    descriptor: SUP,
    catalogue: catalogueFixture,
    allowedModels: ['claude-3-7-sonnet'],
  });

  assert.equal(res.model, 'claude-3-7-sonnet');
  assert.equal(res.source, 'binding');
  assert.equal(res.flag, 'supported');
  assert.equal(res.catalogueStatus, 'synced');
  assert.equal(res.enabledStatus, 'enabled');
  assert.equal(bindingGap(res), null);
});

test('Slice D: resolveBinding rejects model not in catalogue with model-unsynced gap', () => {
  const bindings = {
    state: 'set' as const,
    map: { claude: { standard: 'claude-unlisted-model' } },
    reason: null,
  };

  const res = resolveBinding({
    worker: 'claude',
    tier: 'standard',
    bindings,
    descriptor: SUP,
    catalogue: catalogueFixture,
    allowedModels: ['claude-unlisted-model'],
  });

  assert.equal(res.model, 'claude-unlisted-model');
  assert.equal(res.catalogueStatus, 'unsynced');
  assert.equal(res.enabledStatus, 'enabled');

  const gap = bindingGap(res);
  assert.deepEqual(gap, {
    requirement: 'binding',
    result: 'failed',
    reason: 'model-unsynced',
  });
});

test('Slice D: resolveBinding rejects model not in models.enabled with model-disabled gap', () => {
  const bindings = {
    state: 'set' as const,
    map: { claude: { standard: 'claude-3-5-sonnet' } },
    reason: null,
  };

  const res = resolveBinding({
    worker: 'claude',
    tier: 'standard',
    bindings,
    descriptor: SUP,
    catalogue: catalogueFixture,
    allowedModels: ['claude-3-7-sonnet'], // claude-3-5-sonnet is NOT in allow-list
  });

  assert.equal(res.model, 'claude-3-5-sonnet');
  assert.equal(res.catalogueStatus, 'synced');
  assert.equal(res.enabledStatus, 'disabled');

  const gap = bindingGap(res);
  assert.deepEqual(gap, {
    requirement: 'binding',
    result: 'failed',
    reason: 'model-disabled',
  });
});

test('Slice D: unevidenced flag takes precedence in bindingGap over unsynced / disabled', () => {
  const bindings = {
    state: 'set' as const,
    map: { claude: { standard: 'unknown-model' } },
    reason: null,
  };

  const res = resolveBinding({
    worker: 'claude',
    tier: 'standard',
    bindings,
    descriptor: UNEVIDENCED,
    catalogue: catalogueFixture,
    allowedModels: [],
  });

  assert.equal(res.flag, 'unevidenced');
  const gap = bindingGap(res);
  assert.deepEqual(gap, {
    requirement: 'binding',
    result: 'failed',
    reason: 'model-flag:unevidenced',
  });
});

test('Slice D: harness-default binding is unaffected by catalogue or allow-list', () => {
  const bindings = {
    state: 'set' as const,
    map: {}, // no binding for claude
    reason: null,
  };

  const res = resolveBinding({
    worker: 'claude',
    tier: 'standard',
    bindings,
    descriptor: SUP,
    catalogue: catalogueFixture,
    allowedModels: [],
  });

  assert.equal(res.model, null);
  assert.equal(res.source, 'harness-default');
  assert.equal(res.catalogueStatus, 'synced');
  assert.equal(res.enabledStatus, 'enabled');
  assert.equal(bindingGap(res), null);
});
