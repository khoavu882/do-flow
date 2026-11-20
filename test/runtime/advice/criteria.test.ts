'use strict';

// 141 IC-002, row 174: the rerank criteria in force for `bench advice-gate --kind rerank`. They come from the `rerank` kind
// of core/registry/advice.json only; the `advice.criteria.rerank` setting is gone and nothing reads a settings file. Fake
// text only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveRerankCriteria, DEFAULT_REGISTRY } = require('../../../src/runtime/advice/criteria.ts');
const { createSettingsEnv, REPO } = require('../../helper/settings-fixtures.ts');

function digestOf(ladder: string[], choice: string) {
  return crypto.createHash('sha256').update(JSON.stringify({ ladder, choice }), 'utf8').digest('hex').slice(0, 12);
}

const ADVICE = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/advice.json'), 'utf8'));
const KIND = ADVICE.kinds.find((entry: any) => entry.id === 'rerank');

test('with nothing given the built-in text is in force, source registry, no warning, a 12-hex digest', () => {
  const result = resolveRerankCriteria();
  assert.equal(result.source, 'registry');
  assert.equal(result.warning, null);
  assert.deepEqual(result.ladder, DEFAULT_REGISTRY.ladder);
  assert.equal(result.choiceInstruction, DEFAULT_REGISTRY.choiceInstruction);
  assert.equal(result.digest, digestOf(DEFAULT_REGISTRY.ladder, DEFAULT_REGISTRY.choiceInstruction));
  assert.match(result.digest, /^[0-9a-f]{12}$/);
});

test('the text comes from the rerank kind entry, given as kind or inside adviceRegistry; the built-in fallback is the same text', () => {
  assert.deepEqual(KIND.scoreLadder.criteria, DEFAULT_REGISTRY.ladder, 'a registry edit must show in the digest, so the two are one text');
  assert.equal(KIND.instructions, DEFAULT_REGISTRY.choiceInstruction);
  for (const given of [{ kind: KIND }, { adviceRegistry: ADVICE }]) {
    const result = resolveRerankCriteria(given);
    assert.equal(result.source, 'registry');
    assert.equal(result.digest, digestOf(KIND.scoreLadder.criteria, KIND.instructions));
  }
  const edited = structuredClone(KIND);
  edited.scoreLadder.criteria[0] = 'Edited level zero.';
  edited.instructions = 'Edited choice instruction.';
  const result = resolveRerankCriteria({ kind: edited });
  assert.deepEqual(result.ladder, edited.scoreLadder.criteria);
  assert.equal(result.choiceInstruction, 'Edited choice instruction.');
  assert.notEqual(result.digest, resolveRerankCriteria().digest, 'any edited text changes the digest');
  // an adviceRegistry with no rerank kind, or an unusable entry, falls back to the built-in text rather than throwing
  assert.equal(resolveRerankCriteria({ adviceRegistry: { kinds: [] } }).digest, resolveRerankCriteria().digest);
  assert.equal(resolveRerankCriteria({ registry: { ladder: ['x'], choiceInstruction: 'y' } }).digest, resolveRerankCriteria().digest);
});

test('an explicit registry wins over the kind, and the digest is over the ladder in order plus the choice text', () => {
  const registry = { ladder: ['a0', 'a1', 'a2', 'a3', 'a4'], choiceInstruction: 'registry choice' };
  const result = resolveRerankCriteria({ registry, kind: KIND });
  assert.deepEqual(result.ladder, registry.ladder);
  assert.equal(result.digest, digestOf(registry.ladder, 'registry choice'));
  const swapped = { ...registry, ladder: ['a1', 'a0', 'a2', 'a3', 'a4'] };
  assert.notEqual(resolveRerankCriteria({ registry: swapped }).digest, result.digest);
  assert.notEqual(resolveRerankCriteria({ registry: { ...registry, choiceInstruction: 'other' } }).digest, result.digest);
});

test('the result never holds the other texts, and a returned ladder is a copy', () => {
  const result = resolveRerankCriteria();
  result.ladder[0] = 'changed';
  assert.equal(resolveRerankCriteria().ladder[0], DEFAULT_REGISTRY.ladder[0]);
  assert.deepEqual(Object.keys(result).sort(), ['choiceInstruction', 'digest', 'ladder', 'source', 'warning']);
});

test('a value or a leftover advice.criteria.rerank in a settings file changes nothing: no setting is read', (t) => {
  const f = createSettingsEnv(t);
  const lines = ['zero', 'one', 'two', 'three', 'four', 'Pick the best candidate.'].join('\n');
  f.writeProjectSettings({ schema: 1, 'advice.criteria.rerank': lines });
  f.writeUserSettings({ schema: 1, 'advice.criteria.rerank': lines });
  const before = resolveRerankCriteria();
  const result = resolveRerankCriteria({ value: lines, projectRoot: f.project, env: f.env(), kind: KIND });
  assert.equal(result.source, 'registry');
  assert.equal(result.warning, null);
  assert.equal(result.digest, before.digest);
});

test('the settings registry no longer carries the rerank keys, and every kind key still belongs to an asked kind', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/settings.json'), 'utf8'));
  const keys = Object.keys(settings.keys);
  for (const key of ['advice.criteria.rerank', 'advice.kinds.rerank', 'advice.models.rerank']) assert.ok(!keys.includes(key), key);
  const asked = ADVICE.kinds.filter((kind: any) => kind.askedBy.length > 0).map((kind: any) => kind.id).sort();
  for (const prefix of ['advice.kinds.', 'advice.models.']) {
    assert.deepEqual(keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).sort(), asked, prefix);
  }
});
