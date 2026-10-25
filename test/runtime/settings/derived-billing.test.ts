'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveBilling, effectiveBilling } = require('../../../src/runtime/settings/worker-billing.ts');
import type { ObservedCatalogue } from '../../../src/runtime/models/types.ts';

const recordOf = (harnessId: string, billing: 'free' | 'metered', asserted: string = '2026-10-25') => ({
  state: 'set' as const,
  reason: null,
  workers: {
    [harnessId]: { billing, asserted },
  },
});

const catalogueOf = (harnessId: string, detectedMode: 'subscription' | 'api-key' | 'unverified', derivedBilling: 'free' | 'metered' | 'unknown'): ObservedCatalogue => ({
  version: 1,
  syncedAt: '2026-10-25T12:00:00.000Z',
  harnesses: {
    [harnessId]: {
      harnessId,
      binary: harnessId,
      installed: true,
      version: '1.0.0',
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode,
      derivedBilling,
      offeredModels: [],
      lastSyncedAt: '2026-10-25T12:00:00.000Z',
    },
  },
});

test('Slice C: deriveBilling maps detected modes to billing categories', () => {
  assert.equal(deriveBilling('subscription'), 'free');
  assert.equal(deriveBilling('api-key'), 'metered');
  assert.equal(deriveBilling('unverified'), 'unknown');
  assert.equal(deriveBilling('other'), 'unknown');
});

test('Slice C: effectiveBilling derived billing from catalogue lifts unknown and narrows free', () => {
  // 1. Unknown registry + subscription catalogue -> derived free
  const catFree = catalogueOf('claude', 'subscription', 'free');
  const res1 = effectiveBilling('unknown', 'claude', null, catFree);
  assert.deepEqual(res1, {
    value: 'free',
    source: 'derived',
    detectedMode: 'subscription',
  });

  // 2. Unknown registry + api-key catalogue -> derived metered
  const catMetered = catalogueOf('codex', 'api-key', 'metered');
  const res2 = effectiveBilling('unknown', 'codex', null, catMetered);
  assert.deepEqual(res2, {
    value: 'metered',
    source: 'derived',
    detectedMode: 'api-key',
  });

  // 3. Free registry + api-key catalogue -> narrows to derived metered
  const res3 = effectiveBilling('free', 'codex', null, catMetered);
  assert.deepEqual(res3, {
    value: 'metered',
    source: 'derived',
    detectedMode: 'api-key',
  });

  // 4. Unknown registry + unverified catalogue -> falls back to registry unknown
  const catUnknown = catalogueOf('pi', 'unverified', 'unknown');
  const res4 = effectiveBilling('unknown', 'pi', null, catUnknown);
  assert.deepEqual(res4, {
    value: 'unknown',
    source: 'registry',
  });
});

test('Slice C: effectiveBilling precedence: user-record > derived > registry', () => {
  const catFree = catalogueOf('claude', 'subscription', 'free');
  const recMetered = recordOf('claude', 'metered', '2026-10-25');

  // User record (metered) wins over catalogue (free)
  const res1 = effectiveBilling('unknown', 'claude', recMetered, catFree);
  assert.deepEqual(res1, {
    value: 'metered',
    source: 'user-record',
    asserted: '2026-10-25',
  });

  const catMetered = catalogueOf('claude', 'api-key', 'metered');
  const recFree = recordOf('claude', 'free', '2026-10-25');

  // User record (free) wins over catalogue (metered) when base is unknown
  const res2 = effectiveBilling('unknown', 'claude', recFree, catMetered);
  assert.deepEqual(res2, {
    value: 'free',
    source: 'user-record',
    asserted: '2026-10-25',
  });
});

test('Slice C: effectiveBilling cap enforcement: registry metered cannot be lifted by user record or derived', () => {
  const catFree = catalogueOf('claude', 'subscription', 'free');
  const recFree = recordOf('claude', 'free', '2026-10-25');

  // Neither user record nor derived catalogue can lift registry metered
  const res1 = effectiveBilling('metered', 'claude', recFree, catFree);
  assert.deepEqual(res1, {
    value: 'metered',
    source: 'registry',
  });

  const res2 = effectiveBilling('metered', 'claude', null, catFree);
  assert.deepEqual(res2, {
    value: 'metered',
    source: 'registry',
  });
});
