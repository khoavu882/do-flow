'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveBinding, bindingGap } = require('../../../src/runtime/worker/models.ts');
const { enabledIn } = require('../../../src/runtime/worker/model-choice.ts');

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

const bindingsOf = (slot: unknown) => ({ state: 'set' as const, map: { claude: { standard: slot } } as any, reason: null });
const PROVIDER_PREFIX = { ...SUP, provider: { status: 'supported', via: 'id-prefix', separator: '/' } };

test('Slice D: resolveBinding accepts a model in models.enabled', () => {
  const res = resolveBinding({ worker: 'claude', tier: 'standard', bindings: bindingsOf('claude-3-7-sonnet'), descriptor: SUP, allowedModels: ['claude-3-7-sonnet'] });

  assert.equal(res.model, 'claude-3-7-sonnet');
  assert.equal(res.source, 'binding');
  assert.equal(res.flag, 'supported');
  assert.equal(res.enabledStatus, 'enabled');
  assert.equal(bindingGap(res), null);
});

test('Slice D: resolveBinding rejects model not in models.enabled with model-disabled gap', () => {
  const res = resolveBinding({ worker: 'claude', tier: 'standard', bindings: bindingsOf('claude-3-5-sonnet'), descriptor: SUP, allowedModels: ['claude-3-7-sonnet'] });

  assert.equal(res.model, 'claude-3-5-sonnet');
  assert.equal(res.enabledStatus, 'disabled');
  assert.deepEqual(bindingGap(res), { requirement: 'binding', result: 'failed', reason: 'model-disabled' });
});

test('169 A-05: an enabled entry matches the bare id or the composed id the user typed, nothing else', () => {
  const bound = (slot: unknown, allowedModels: string[], descriptor: any = PROVIDER_PREFIX) => resolveBinding({ worker: 'claude', tier: 'standard', bindings: bindingsOf(slot), descriptor, allowedModels }).enabledStatus;
  // A provider bound on an id-prefix harness: the entry may be the composed `provider/id` or the bare id.
  assert.equal(bound({ model: 'gpt-x', provider: 'openai' }, ['openai/gpt-x']), 'enabled');
  assert.equal(bound({ model: 'gpt-x', provider: 'openai' }, ['gpt-x']), 'enabled');
  assert.equal(bound({ model: 'gpt-x', provider: 'openai' }, ['azure/gpt-x']), 'disabled');
  assert.equal(bound({ model: 'gpt-x', provider: 'openai' }, ['openai/other']), 'disabled');
  // A plain id typed with its prefix matches an entry that holds it as typed.
  assert.equal(bound('openai/gpt-x', ['openai/gpt-x']), 'enabled');
  // A provider on a harness that does not compose it into the id adds no composed form.
  assert.equal(bound({ model: 'gpt-x', provider: 'openai' }, ['openai/gpt-x'], { ...SUP, provider: { status: 'supported', via: 'flag', argv: ['--provider', '{provider}'] } }), 'disabled');
});

test('Slice D: unevidenced flag takes precedence in bindingGap over disabled', () => {
  const res = resolveBinding({ worker: 'claude', tier: 'standard', bindings: bindingsOf('unknown-model'), descriptor: UNEVIDENCED, allowedModels: [] });

  assert.equal(res.flag, 'unevidenced');
  assert.deepEqual(bindingGap(res), { requirement: 'binding', result: 'failed', reason: 'model-flag:unevidenced' });
});

test('Slice D: harness-default binding is unaffected by the allow-list', () => {
  const res = resolveBinding({ worker: 'claude', tier: 'standard', bindings: { state: 'set' as const, map: {}, reason: null }, descriptor: SUP, allowedModels: [] });

  assert.equal(res.model, null);
  assert.equal(res.source, 'harness-default');
  assert.equal(res.enabledStatus, 'enabled');
  assert.equal(bindingGap(res), null);
});

test('169 A-05: enabledIn matches the bare id or the composed id of an id-prefix harness', () => {
  const prefix = { provider: { status: 'supported', via: 'id-prefix', separator: '/' } };
  const flag = { provider: { status: 'supported', via: 'flag', argv: ['--provider', '{provider}'] } };
  assert.equal(enabledIn(['gpt-x'], 'gpt-x', 'openai', prefix), true);
  assert.equal(enabledIn(['openai/gpt-x'], 'gpt-x', 'openai', prefix), true);
  assert.equal(enabledIn(['azure/gpt-x'], 'gpt-x', 'openai', prefix), false);
  assert.equal(enabledIn(['openai/gpt-x'], 'gpt-x', null, prefix), false);
  assert.equal(enabledIn(['openai/gpt-x'], 'gpt-x', 'openai', flag), false);
  assert.equal(enabledIn(['openai/gpt-x'], 'openai/gpt-x', null, prefix), true);
  assert.equal(enabledIn([], 'gpt-x', 'openai', prefix), false);
});
