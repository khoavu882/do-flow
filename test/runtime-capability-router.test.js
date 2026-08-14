'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CapabilityRouter } = require('../src/runtime/capability-router');

const REPO = path.resolve(__dirname, '..');

test('CapabilityRouter loads canonical capabilities and routes from registry', () => {
  const router = new CapabilityRouter({ repoRoot: REPO });
  assert.ok(router.capabilities);
  assert.ok(router.routes);
  
  // Verify 7 standard capabilities
  const expectedCaps = [
    'code.exact-search',
    'code.semantic-search',
    'code.relationships',
    'code.impact-analysis',
    'history.search',
    'behavior.verify',
    'command.compress',
  ];
  for (const cap of expectedCaps) {
    assert.ok(router.capabilities[cap], `Missing capability: ${cap}`);
  }

  // Verify 7 standard routes
  const expectedRoutes = [
    'locate-known-symbol',
    'locate-concept',
    'trace-dependency',
    'estimate-blast-radius',
    'inspect-history',
    'verify-runtime-behavior',
    'compress-command',
  ];
  for (const r of expectedRoutes) {
    assert.ok(router.routes[r], `Missing route: ${r}`);
  }
});

test('CapabilityRouter resolves exact search to native.rg', () => {
  const router = new CapabilityRouter({ repoRoot: REPO });
  const plan = router.resolveIntent('locate-known-symbol', { symbol: 'PaymentService' });

  assert.equal(plan.intent, 'locate-known-symbol');
  assert.equal(plan.capability, 'code.exact-search');
  assert.ok(plan.selectedProvider);
  assert.equal(plan.selectedProvider.id, 'native.rg');
  assert.ok(plan.execution.cliCommand.includes('PaymentService'));
});

test('CapabilityRouter resolves locate-concept to semantic search or falls back gracefully', () => {
  const router = new CapabilityRouter({ repoRoot: REPO });
  const plan = router.resolveIntent('locate-concept', { query: 'invoice retry logic', path: 'src/' });

  assert.equal(plan.intent, 'locate-concept');
  assert.ok(['HEALTHY', 'FALLBACK'].includes(plan.status));
  assert.ok(plan.selectedProvider);
  assert.ok(plan.execution.cliCommand.includes('invoice retry logic'));
  assert.ok(plan.fallbackChain.length > 0);
});

test('CapabilityRouter performs progressive fallback when primary provider is unavailable', () => {
  // Mock capabilities with an unavailable primary provider
  const customCaps = {
    'custom.search': {
      description: 'Custom search capability',
      providers: [
        { id: 'nonexistent.tool', name: 'Fake Tool', binary: 'nonexistent_bin_12345' },
        { id: 'native.rg', name: 'Ripgrep', kind: 'native', binary: 'rg' },
      ],
    },
  };
  const customRoutes = {
    'custom-intent': {
      description: 'Custom intent',
      capability: 'custom.search',
      fallback: [],
    },
  };

  const router = new CapabilityRouter({
    capabilities: customCaps,
    routes: customRoutes,
  });

  const plan = router.resolveIntent('custom-intent', { query: 'test' });
  assert.equal(plan.status, 'FALLBACK');
  assert.equal(plan.selectedProvider.id, 'native.rg');
});

test('CapabilityRouter evaluates capability health across all declarations', () => {
  const router = new CapabilityRouter({ repoRoot: REPO });
  const healthReport = router.getAllCapabilitiesHealth(false);

  assert.ok(Array.isArray(healthReport));
  assert.equal(healthReport.length, 7);
  for (const item of healthReport) {
    assert.ok(item.capability);
    assert.ok(item.description);
    assert.ok(item.status);
  }
});

test('CapabilityRouter resolution executes in < 15ms (in-process performance NFR-001)', () => {
  const router = new CapabilityRouter({ repoRoot: REPO });
  const start = performance.now();
  
  for (let i = 0; i < 50; i++) {
    router.resolveIntent('locate-known-symbol', { symbol: 'MyClass' });
    router.resolveIntent('locate-concept', { query: 'authentication flow' });
  }
  
  const elapsed = performance.now() - start;
  const avgPerCall = elapsed / 100;
  assert.ok(avgPerCall < 15, `Expected average lookup < 15ms, took ${avgPerCall.toFixed(2)}ms`);
});

test('CapabilityRouter throws on unknown intent or capability', () => {
  const router = new CapabilityRouter({ repoRoot: REPO });
  assert.throws(() => router.resolveIntent('nonexistent-intent'), /Unknown route\/intent/);
  assert.throws(() => router.resolveCapability('nonexistent.capability'), /Unknown capability/);
});
