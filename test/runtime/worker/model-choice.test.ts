'use strict';
// 169 IC-001..IC-003 (T2): choiceOf, composeModelPart, matchListed, modelCheck, effortCheck. Pure; descriptors are
// test-only Pi-shaped and OpenCode-shaped worker blocks, so no shipped data and no harness CLI is involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { choiceOf, composeModelPart, matchListed, modelCheck, providerCheck, effortCheck } = require('../../../src/runtime/worker/model-choice.ts');

const piWorker = (over: any = {}) => ({
  model: { status: 'supported', argv: ['--model', '{model}'] },
  provider: { status: 'supported', via: 'id-prefix', separator: '/' },
  effort: { status: 'supported', via: 'flag', argv: ['--thinking', '{effort}'], levels: ['off', 'low', 'high'], offLevel: 'off', mayLower: true },
  ...over,
});
const openCodeWorker = (over: any = {}) => ({
  model: { status: 'supported', argv: ['--model', '{model}'] },
  provider: { status: 'supported', via: 'id-prefix', separator: '/' },
  effort: { status: 'supported', via: 'id-suffix', separator: '#', levels: 'per-model' },
  ...over,
});
const providerFlagWorker = () => ({
  model: { status: 'supported', argv: ['--model', '{model}'] },
  provider: { status: 'supported', via: 'flag', argv: ['--provider', '{provider}'] },
  effort: { status: 'supported', via: 'flag', argv: ['-c', 'reasoning={effort}'], levels: ['low', 'high'] },
});
const choice = (model: string, provider: string | null = null, effort: string | null = null) => ({ model, provider, effort });
const reasonOf = (fn: () => any) => { try { fn(); } catch (e: any) { return e.code; } return null; };

test('choiceOf reads a string, an object with absent parts as null, and refuses anything else', () => {
  assert.deepEqual(choiceOf('gpt-y'), choice('gpt-y'));
  assert.deepEqual(choiceOf({ model: 'gpt-y' }), choice('gpt-y'));
  assert.deepEqual(choiceOf({ model: 'gpt-y', provider: 'openai', effort: 'low' }), choice('gpt-y', 'openai', 'low'));
  assert.deepEqual(choiceOf({ model: 'gpt-y', provider: undefined }), choice('gpt-y'));
  for (const bad of [null, undefined, 5, true, [], ['x'], {}, { provider: 'openai' }, { model: 5 }, new Date(0)]) {
    assert.equal(choiceOf(bad), null, JSON.stringify(bad));
  }
});

test('composeModelPart: Pi shape puts the provider in the id and the effort in its own flag', () => {
  assert.deepEqual(composeModelPart(piWorker(), choice('gpt-y', 'openai', 'low')), { argv: ['--model', 'openai/gpt-y', '--thinking', 'low'], strip: [{ flag: '--thinking', key: null }] });
  assert.deepEqual(composeModelPart(piWorker(), choice('gpt-y', 'openai')), { argv: ['--model', 'openai/gpt-y'], strip: [] });
  assert.deepEqual(composeModelPart(piWorker(), choice('gpt-y')), { argv: ['--model', 'gpt-y'], strip: [] });
});

test('composeModelPart: OpenCode shape joins provider and effort to the id', () => {
  assert.deepEqual(composeModelPart(openCodeWorker(), choice('gpt-x', 'openai', 'high')), { argv: ['--model', 'openai/gpt-x#high'], strip: [] });
  assert.deepEqual(composeModelPart(openCodeWorker(), choice('gpt-x', null, 'high')), { argv: ['--model', 'gpt-x#high'], strip: [] });
});

test('composeModelPart: flag transports add their pair after the model, a key= form replaces the placeholder after the key', () => {
  assert.deepEqual(composeModelPart(providerFlagWorker(), choice('m', 'acme', 'high')), {
    argv: ['--model', 'm', '--provider', 'acme', '-c', 'reasoning=high'], strip: [{ flag: '--provider', key: null }, { flag: '-c', key: 'reasoning' }],
  });
});

test('composeModelPart refuses a part the descriptor does not support with model-part-unsupported', () => {
  const unknown = { status: 'unknown', reason: 'none read' };
  assert.equal(reasonOf(() => composeModelPart(piWorker({ provider: unknown }), choice('m', 'openai'))), 'model-part-unsupported');
  assert.equal(reasonOf(() => composeModelPart(piWorker({ effort: unknown }), choice('m', null, 'low'))), 'model-part-unsupported');
  assert.equal(reasonOf(() => composeModelPart(piWorker({ effort: { status: 'unsupported' } }), choice('m', null, 'low'))), 'model-part-unsupported');
  assert.equal(reasonOf(() => composeModelPart({ model: { status: 'supported', argv: ['--model', '{model}'] } }, choice('m', 'openai'))), 'model-part-unsupported');
  assert.equal(reasonOf(() => composeModelPart({ model: { status: 'unknown' } }, choice('m'))), 'model-part-unsupported');
  // An unbound part never needs its entry.
  assert.deepEqual(composeModelPart(piWorker({ provider: unknown, effort: unknown }), choice('m')), { argv: ['--model', 'm'], strip: [] });
});

test('composeModelPart refuses a bad value or an over-long id with model-part-invalid', () => {
  assert.equal(reasonOf(() => composeModelPart(piWorker(), choice('m', '-bad'))), 'model-part-invalid');
  assert.equal(reasonOf(() => composeModelPart(piWorker(), choice('m', 'p'.repeat(65)))), 'model-part-invalid');
  assert.equal(reasonOf(() => composeModelPart(piWorker(), choice('m', null, 'two words'))), 'model-part-invalid');
  assert.equal(reasonOf(() => composeModelPart(piWorker(), choice('m', null, 'ultra'))), 'model-part-invalid'); // outside a closed levels list
  assert.equal(reasonOf(() => composeModelPart(piWorker(), choice('m'.repeat(221)))), 'model-part-invalid');
  assert.equal(reasonOf(() => composeModelPart(piWorker(), choice('m'.repeat(120), 'p'.repeat(64), null))), null); // 64 + 1 + 120 = 185
  assert.equal(reasonOf(() => composeModelPart(openCodeWorker(), choice('m'.repeat(120), 'p'.repeat(64), 'e'.repeat(32)))), null); // 218
  assert.equal(reasonOf(() => composeModelPart(openCodeWorker(), choice('m'.repeat(125), 'p'.repeat(64), 'e'.repeat(32)))), 'model-part-invalid'); // 223
  assert.equal(reasonOf(() => composeModelPart(piWorker(), choice(''))), 'model-part-invalid');
  assert.equal(reasonOf(() => composeModelPart(openCodeWorker(), choice('m', null, 'anything-per-model'))), null);
});

test('composeModelPart shape:true composes with placeholders and checks only that the parts are supported', () => {
  assert.deepEqual(composeModelPart(piWorker(), choice('x', 'y', 'z'), { shape: true }), { argv: ['--model', '{provider}/{model}', '--thinking', '{effort}'], strip: [{ flag: '--thinking', key: null }] });
  assert.deepEqual(composeModelPart(openCodeWorker(), choice('x', 'y', 'z'), { shape: true }), { argv: ['--model', '{provider}/{model}#{effort}'], strip: [] });
  assert.deepEqual(composeModelPart(providerFlagWorker(), choice('x', 'y', 'z'), { shape: true }), { argv: ['--model', '{model}', '--provider', '{provider}', '-c', 'reasoning={effort}'], strip: [{ flag: '--provider', key: null }, { flag: '-c', key: 'reasoning' }] });
  assert.deepEqual(composeModelPart(piWorker(), choice('x'), { shape: true }), { argv: ['--model', '{model}'], strip: [] });
  assert.equal(reasonOf(() => composeModelPart(piWorker({ effort: { status: 'unknown', reason: 'r' } }), choice('x', null, 'z'), { shape: true })), 'model-part-unsupported');
});

// ---- checks: entries are the catalogue entry `{offeredModels, modelList}` of one harness --------------------------------
const entryOf = (offeredModels: any[], status = 'listed') => ({ offeredModels, modelList: { status } });
const GPT_OPENAI = { id: 'gpt-x', provider: 'openai' };
const GPT_AZURE = { id: 'gpt-x', provider: 'azure' };

test('matchListed matches a bare id, an id under a named provider, and a prefixed binding on an id-prefix harness', () => {
  const entries = [GPT_OPENAI, { id: 'other', provider: 'openai' }, GPT_AZURE];
  assert.deepEqual(matchListed(entries, choice('gpt-x'), piWorker()), [GPT_OPENAI, GPT_AZURE]);
  assert.deepEqual(matchListed(entries, choice('gpt-x', 'azure'), piWorker()), [GPT_AZURE]);
  assert.deepEqual(matchListed(entries, choice('gpt-x', 'nobody'), piWorker()), []);
  // A plain `openai/gpt-x` binding matches the bare entry `gpt-x` with provider `openai`.
  assert.deepEqual(matchListed(entries, choice('openai/gpt-x'), piWorker()), [GPT_OPENAI]);
  assert.deepEqual(matchListed(entries, choice('openai/gpt-x'), piWorker({ provider: { status: 'unknown', reason: 'r' } })), []);
  assert.deepEqual(matchListed(entries, choice('openai/gpt-x'), providerFlagWorker()), []);
  // A listing that already holds the prefixed id matches it as typed.
  assert.deepEqual(matchListed([{ id: 'openai/gpt-x' }], choice('openai/gpt-x'), piWorker()), [{ id: 'openai/gpt-x' }]);
});

test('modelCheck covers every row of design 6.3', () => {
  const w = piWorker();
  assert.equal(modelCheck(entryOf([GPT_OPENAI]), choice('gpt-x'), w), 'listed');
  assert.equal(modelCheck(entryOf([GPT_OPENAI]), choice('gpt-x', 'openai'), w), 'listed');
  assert.equal(modelCheck(entryOf([GPT_OPENAI, { id: 'gpt-x', provider: 'openai' }]), choice('gpt-x'), w), 'listed'); // several, one provider
  assert.equal(modelCheck(entryOf([{ id: 'gpt-x' }]), choice('gpt-x'), w), 'listed'); // a list with no providers
  assert.equal(modelCheck(entryOf([GPT_OPENAI, GPT_AZURE]), choice('gpt-x'), w), 'several-providers');
  assert.equal(modelCheck(entryOf([GPT_OPENAI, GPT_AZURE]), choice('gpt-x', 'azure'), w), 'listed');
  assert.equal(modelCheck(entryOf([GPT_OPENAI, GPT_AZURE]), choice('gpt-x', 'nobody'), w), 'not-listed');
  assert.equal(modelCheck(entryOf([GPT_OPENAI]), choice('nope'), w), 'not-listed');
  assert.equal(modelCheck(entryOf([GPT_OPENAI]), choice('openai/gpt-x'), w), 'listed'); // plain prefixed binding
  // A failed listing keeps the previous list (stale): it still checks.
  assert.equal(modelCheck({ offeredModels: [GPT_OPENAI], modelList: { status: 'failed', stale: true } }, choice('gpt-x'), w), 'listed');
  // No list: none-recorded, a failed listing with nothing kept, an empty list, no entry at all.
  assert.equal(modelCheck(entryOf([], 'none-recorded'), choice('gpt-x'), w), 'unchecked');
  assert.equal(modelCheck({ offeredModels: [], modelList: { status: 'failed' } }, choice('gpt-x'), w), 'unchecked');
  assert.equal(modelCheck(entryOf([]), choice('gpt-x'), w), 'unchecked');
  assert.equal(modelCheck({}, choice('gpt-x'), w), 'unchecked');
  assert.equal(modelCheck(null, choice('gpt-x'), w), 'unchecked');
  assert.equal(modelCheck(undefined, choice('gpt-x'), w), 'unchecked');
});

test('effortCheck covers every row of design 6.3', () => {
  const w = piWorker(); // offLevel off
  const noOff = piWorker({ effort: { status: 'supported', via: 'flag', argv: ['--thinking', '{effort}'], levels: ['off', 'low', 'high'] } });
  const withLevels = entryOf([{ id: 'm', provider: 'p', effortLevels: ['low', 'high'] }]);
  assert.equal(effortCheck(withLevels, choice('m'), w), null); // no effort bound
  assert.equal(effortCheck(withLevels, choice('m', null, 'low'), w), 'listed');
  assert.equal(effortCheck(withLevels, choice('m', null, 'medium'), w), 'not-offered');
  assert.equal(effortCheck(withLevels, choice('m', 'p', 'high'), w), 'listed');
  // reasoning:false: not-offered unless the effort is the descriptor's offLevel (then the table says unchecked).
  const plain = entryOf([{ id: 'm', reasoning: false }]);
  assert.equal(effortCheck(plain, choice('m', null, 'high'), w), 'not-offered');
  assert.equal(effortCheck(plain, choice('m', null, 'off'), w), 'unchecked');
  assert.equal(effortCheck(plain, choice('m', null, 'off'), noOff), 'not-offered');
  assert.equal(effortCheck(plain, choice('m', null, 'high'), noOff), 'not-offered');
  // reasoning:true with no levels, or nothing known about the model: unchecked.
  assert.equal(effortCheck(entryOf([{ id: 'm', reasoning: true }]), choice('m', null, 'high'), w), 'unchecked');
  assert.equal(effortCheck(entryOf([{ id: 'm' }]), choice('m', null, 'high'), w), 'unchecked');
  // Model not listed, no list, no entry: unchecked.
  assert.equal(effortCheck(withLevels, choice('other', null, 'low'), w), 'unchecked');
  assert.equal(effortCheck(entryOf([], 'none-recorded'), choice('m', null, 'low'), w), 'unchecked');
  assert.equal(effortCheck(null, choice('m', null, 'low'), w), 'unchecked');
  // Several providers agree, or disagree.
  const both = entryOf([{ id: 'm', provider: 'a', effortLevels: ['low'] }, { id: 'm', provider: 'b', effortLevels: ['low', 'high'] }]);
  assert.equal(effortCheck(both, choice('m', null, 'low'), w), 'listed');
  assert.equal(effortCheck(both, choice('m', null, 'medium'), w), 'not-offered');
  assert.equal(effortCheck(both, choice('m', null, 'high'), w), 'unchecked');
  assert.equal(effortCheck(both, choice('m', 'b', 'high'), w), 'listed');
});

test('169 A-08: a bound provider against a listing that carries no provider matches on the id and reads provider unchecked', () => {
  const w = piWorker();
  const bare = entryOf([{ id: 'gpt-x' }, { id: 'other' }]);
  assert.deepEqual(matchListed(bare.offeredModels, choice('gpt-x', 'openai'), w), [{ id: 'gpt-x' }]);
  assert.equal(modelCheck(bare, choice('gpt-x', 'openai'), w), 'listed');
  assert.equal(providerCheck(bare, choice('gpt-x', 'openai'), w), 'unchecked');
  assert.equal(effortCheck(entryOf([{ id: 'gpt-x', effortLevels: ['low'] }]), choice('gpt-x', 'openai', 'low'), w), 'listed');
  // A listing that carries providers stays strict: a different provider is not-listed, a matching one is checked.
  const rich = entryOf([GPT_OPENAI, GPT_AZURE]);
  assert.equal(modelCheck(rich, choice('gpt-x', 'nobody'), w), 'not-listed');
  assert.equal(providerCheck(rich, choice('gpt-x', 'azure'), w), null);
  assert.equal(modelCheck(entryOf([GPT_OPENAI, { id: 'gpt-x' }]), choice('gpt-x', 'azure'), w), 'not-listed', 'a mixed listing is not provider-less');
  assert.equal(providerCheck(entryOf([GPT_OPENAI, { id: 'gpt-x' }]), choice('gpt-x', 'openai'), w), null);
  // No provider bound, no list, no match: nothing to mark.
  assert.equal(providerCheck(bare, choice('gpt-x'), w), null);
  assert.equal(providerCheck(entryOf([], 'none-recorded'), choice('gpt-x', 'openai'), w), null);
  assert.equal(providerCheck(null, choice('gpt-x', 'openai'), w), null);
  assert.equal(providerCheck(bare, choice('nope', 'openai'), w), null);
});
