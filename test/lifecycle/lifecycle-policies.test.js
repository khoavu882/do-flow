'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry');
const { renderPolicies } = require('../../src/lifecycle/policies');

const registry = loadRegistry({ repoRoot: path.resolve(__dirname, "../..") });

test('renders supported Claude policies as native-event-ready', () => {
  const policy = renderPolicies(registry, { harness: 'claude', policyIds: ['stop-check'] })[0];
  assert.deepEqual(policy, {
    id: 'stop-check', intent: 'check-completion-before-stop', harness: 'claude',
    status: 'supported', capabilityStatus: 'supported', event: 'Stop', renderable: true,
    prerequisites: [], fallback: null, reason: null,
  });
});

test('retains different Codex event semantics and reports review prerequisites', () => {
  const policy = renderPolicies(registry, { harness: 'codex', policyIds: ['pre-implementation-gate'] })[0];
  assert.equal(policy.status, 'prerequisite');
  assert.equal(policy.capabilityStatus, 'different');
  assert.equal(policy.event, 'PreToolUse');
  assert.equal(policy.renderable, true);
  assert.deepEqual(policy.prerequisites, ['hook-review', 'trusted-project']);
});

test('reports unavailable Gemini policies with fallback guidance and no fabricated event', () => {
  const policy = renderPolicies(registry, { harness: 'gemini', policyIds: ['stop-check'] })[0];
  assert.equal(policy.status, 'unavailable');
  assert.equal(policy.event, null);
  assert.equal(policy.renderable, false);
  assert.equal(policy.fallback, 'guidance');
});

test('rejects unknown harnesses and policy ids', () => {
  assert.throws(() => renderPolicies(registry, { harness: 'unknown' }), /Unknown registry harness/);
  assert.throws(() => renderPolicies(registry, { harness: 'claude', policyIds: ['unknown'] }), /Unknown lifecycle policy/);
});
