'use strict';

// 141 IC-002, DEC-037: the `advice.criteria.rerank` reader and its settings key. The reader never throws and an invalid
// value keeps the registry text with a warning; `config set` and `config unset` refuse the key. Fake text only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  resolveRerankCriteria,
  DEFAULT_REGISTRY,
  DEFAULT_CRITERIA_BYTES,
} = require('../../src/runtime/advice/criteria.ts');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');

const LADDER = ['zero text', 'one text', 'two text', 'three text', 'four text'];
const CHOICE = 'Pick the best candidate for the query.';
const VALID5 = LADDER.join('\n');
const VALID6 = `${VALID5}\n${CHOICE}`;
const PARAMS = { criteriaBytes: 1536 };

function digestOf(ladder: string[], choice: string) {
  return crypto.createHash('sha256').update(JSON.stringify({ ladder, choice }), 'utf8').digest('hex').slice(0, 12);
}

function registryFallback(result: any) {
  assert.equal(result.source, 'registry');
  assert.deepEqual(result.ladder, DEFAULT_REGISTRY.ladder);
  assert.equal(result.choiceInstruction, DEFAULT_REGISTRY.choiceInstruction);
  assert.equal(result.digest, digestOf(DEFAULT_REGISTRY.ladder, DEFAULT_REGISTRY.choiceInstruction));
}

test('null or absent value gives the registry text, source registry, no warning', () => {
  const result = resolveRerankCriteria({ value: null, params: PARAMS });
  registryFallback(result);
  assert.equal(result.warning, null);
  assert.match(result.digest, /^[0-9a-f]{12}$/);
  assert.equal(DEFAULT_CRITERIA_BYTES, 1536);
});

test('a valid 5-line value replaces the ladder and keeps the registry choice instruction', () => {
  const result = resolveRerankCriteria({ value: VALID5, params: PARAMS });
  assert.equal(result.source, 'settings');
  assert.equal(result.warning, null);
  assert.deepEqual(result.ladder, LADDER);
  assert.equal(result.choiceInstruction, DEFAULT_REGISTRY.choiceInstruction);
  assert.equal(result.digest, digestOf(LADDER, DEFAULT_REGISTRY.choiceInstruction));
});

test('a valid 6-line value also replaces the choice instruction', () => {
  const result = resolveRerankCriteria({ value: VALID6, params: PARAMS });
  assert.equal(result.source, 'settings');
  assert.equal(result.warning, null);
  assert.deepEqual(result.ladder, LADDER);
  assert.equal(result.choiceInstruction, CHOICE);
  assert.equal(result.digest, digestOf(LADDER, CHOICE));
});

test('the registry text and the byte cap come from the parameters when given', () => {
  const registry = { ladder: ['a0', 'a1', 'a2', 'a3', 'a4'], choiceInstruction: 'registry choice' };
  const fallback = resolveRerankCriteria({ value: null, registry, params: PARAMS });
  assert.deepEqual(fallback.ladder, registry.ladder);
  assert.equal(fallback.choiceInstruction, 'registry choice');
  assert.equal(fallback.digest, digestOf(registry.ladder, 'registry choice'));
  const six = resolveRerankCriteria({ value: VALID5, registry, params: PARAMS });
  assert.equal(six.choiceInstruction, 'registry choice', 'a 5-line value keeps the registry choice text');
  const tight = resolveRerankCriteria({ value: VALID5, registry, params: { criteriaBytes: 10 } });
  assert.equal(tight.source, 'registry');
  assert.match(tight.warning, /over the 10-byte limit/);
  // a registry that is not usable is replaced by the defaults, not thrown on
  registryFallback(resolveRerankCriteria({ value: null, registry: { ladder: ['x'] }, params: PARAMS }));
});

test('141 IC-002: the registry text and cap come from the rerank kind entry, given as kind or inside adviceRegistry', () => {
  const advice = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/advice.json'), 'utf8'));
  const kind = advice.kinds.find((entry: any) => entry.id === 'rerank');
  // The built-in fallback and the shipped kind are one text, so a registry edit shows in the digest.
  assert.deepEqual(kind.scoreLadder.criteria, DEFAULT_REGISTRY.ladder);
  assert.equal(kind.instructions, DEFAULT_REGISTRY.choiceInstruction);
  assert.equal(kind.params.criteriaBytes, DEFAULT_CRITERIA_BYTES);
  for (const given of [{ kind }, { adviceRegistry: advice }]) {
    const result = resolveRerankCriteria({ value: null, ...given });
    assert.equal(result.source, 'registry');
    assert.equal(result.digest, digestOf(kind.scoreLadder.criteria, kind.instructions));
  }
  const edited = structuredClone(kind);
  edited.scoreLadder.criteria[0] = 'Edited level zero.';
  edited.instructions = 'Edited choice instruction.';
  edited.params.criteriaBytes = 10;
  const fallback = resolveRerankCriteria({ value: null, kind: edited });
  assert.deepEqual(fallback.ladder, edited.scoreLadder.criteria);
  assert.equal(fallback.choiceInstruction, 'Edited choice instruction.');
  assert.notEqual(fallback.digest, digestOf(DEFAULT_REGISTRY.ladder, DEFAULT_REGISTRY.choiceInstruction));
  const capped = resolveRerankCriteria({ value: VALID5, kind: edited });
  assert.equal(capped.source, 'registry');
  assert.match(capped.warning, /over the 10-byte limit/);
  assert.deepEqual(capped.ladder, edited.scoreLadder.criteria, 'a refused value leaves the kind text, not the built-in text');
  assert.equal(resolveRerankCriteria({ value: VALID5, kind: edited, params: PARAMS }).source, 'settings', 'an explicit params wins');
  // an adviceRegistry with no rerank kind falls back to the built-in text
  registryFallback(resolveRerankCriteria({ value: null, adviceRegistry: { kinds: [] } }));
});

test('too many bytes is refused, counted in UTF-8 bytes; exactly the cap is accepted', () => {
  const exact = [...LADDER.slice(0, 4), 'x'.repeat(1536 - Buffer.byteLength(LADDER.slice(0, 4).join('\n') + '\n'))].join('\n');
  assert.equal(Buffer.byteLength(exact, 'utf8'), 1536);
  assert.equal(resolveRerankCriteria({ value: exact, params: PARAMS }).source, 'settings');
  const over = resolveRerankCriteria({ value: `${exact}x`, params: PARAMS });
  registryFallback(over);
  assert.match(over.warning, /^advice\.criteria\.rerank is 1537 bytes, over the 1536-byte limit; the registry text is in force$/);
  // 300 two-byte characters in one line: 300 characters but 600 bytes
  const wide = [...LADDER.slice(0, 4), 'é'.repeat(300)].join('\n');
  assert.equal(resolveRerankCriteria({ value: wide, params: { criteriaBytes: 500 } }).source, 'registry');
  assert.equal(resolveRerankCriteria({ value: wide, params: { criteriaBytes: 700 } }).source, 'settings');
});

test('a control character other than newline is refused', () => {
  for (const bad of ['\t', '\r', '\u0000', '\u001b', '\u007f', '\u0085']) {
    const result = resolveRerankCriteria({ value: VALID5.replace('two text', `two${bad}text`), params: PARAMS });
    registryFallback(result);
    assert.match(result.warning, /control character/, JSON.stringify(bad));
  }
  assert.equal(resolveRerankCriteria({ value: VALID5.replace('two text', 'two\r'), params: PARAMS }).source, 'registry', 'CRLF is refused');
});

test('141 N2: line and paragraph separators, bidirectional controls and zero-width characters are refused', () => {
  const bad = ['\u2028', '\u2029', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069',
    '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u2060', '\ufeff'];
  for (const character of bad) {
    const result = resolveRerankCriteria({ value: VALID5.replace('two text', `two${character}text`), params: PARAMS });
    registryFallback(result);
    assert.match(result.warning, /control character/, JSON.stringify(character));
  }
  assert.equal(resolveRerankCriteria({ value: VALID5.replace('two text', 'two \u00e9 \u4e2d text'), params: PARAMS }).source, 'settings', 'ordinary non-ASCII text stays valid');
});

test('repeated ladder lines are refused, also when they differ only in surrounding space; the choice line may repeat one', () => {
  const dup = resolveRerankCriteria({ value: 'a\nb\nc\nb\ne', params: PARAMS });
  registryFallback(dup);
  assert.match(dup.warning, /repeats a ladder line/);
  assert.equal(resolveRerankCriteria({ value: 'a\nb\nc\n b \ne', params: PARAMS }).source, 'registry');
  assert.equal(resolveRerankCriteria({ value: 'a\nb\nc\nd\ne\nb', params: PARAMS }).source, 'settings');
});

test('4 lines and 7 lines are refused, naming the count', () => {
  const four = resolveRerankCriteria({ value: 'a\nb\nc\nd', params: PARAMS });
  registryFallback(four);
  assert.match(four.warning, /has 4 lines; expected 5 or 6/);
  const seven = resolveRerankCriteria({ value: 'a\nb\nc\nd\ne\nf\ng', params: PARAMS });
  registryFallback(seven);
  assert.match(seven.warning, /has 7 lines; expected 5 or 6/);
});

test('an empty line, a trailing newline and a non-string are refused', () => {
  for (const value of ['a\n\nc\nd\ne', 'a\nb\nc\nd\ne\n', 'a\nb\nc\nd\n   ', '', 5, ['a', 'b', 'c', 'd', 'e'], {}]) {
    const result = resolveRerankCriteria({ value, params: PARAMS });
    registryFallback(result);
    assert.ok(result.warning, JSON.stringify(value));
  }
});

test('the first failed rule is the one named', () => {
  const both = resolveRerankCriteria({ value: `a\nb\nc\nd\n${'x'.repeat(2000)}\n\t`, params: PARAMS });
  assert.match(both.warning, /bytes, over the 1536-byte limit/);
});

test('the digest is stable for equal text and changes with any one text', () => {
  const base = resolveRerankCriteria({ value: VALID6, params: PARAMS }).digest;
  assert.equal(resolveRerankCriteria({ value: VALID6, params: PARAMS }).digest, base);
  for (let line = 0; line < 6; line++) {
    const edited = VALID6.split('\n');
    edited[line] += '!';
    assert.notEqual(resolveRerankCriteria({ value: edited.join('\n'), params: PARAMS }).digest, base, `line ${line + 1}`);
  }
  // swapping two ladder lines changes it (the order is part of the ladder)
  const swapped = [...LADDER];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.notEqual(resolveRerankCriteria({ value: `${swapped.join('\n')}\n${CHOICE}`, params: PARAMS }).digest, base);
  // a registry edit changes the registry digest, and a 5-line value inherits the registry choice text
  const edited = { ...DEFAULT_REGISTRY, choiceInstruction: `${DEFAULT_REGISTRY.choiceInstruction} Be brief.` };
  assert.notEqual(resolveRerankCriteria({ value: null, registry: edited, params: PARAMS }).digest, resolveRerankCriteria({ value: null, params: PARAMS }).digest);
  assert.notEqual(resolveRerankCriteria({ value: VALID5, registry: edited, params: PARAMS }).digest, resolveRerankCriteria({ value: VALID5, params: PARAMS }).digest);
  // a value equal to the registry text gives the registry digest, source settings
  const same = resolveRerankCriteria({ value: `${DEFAULT_REGISTRY.ladder.join('\n')}\n${DEFAULT_REGISTRY.choiceInstruction}`, params: PARAMS });
  assert.equal(same.source, 'settings');
  assert.equal(same.digest, resolveRerankCriteria({ value: null, params: PARAMS }).digest);
});

test('the result never holds the other texts, and a returned ladder is a copy', () => {
  const result = resolveRerankCriteria({ value: VALID5, params: PARAMS });
  result.ladder[0] = 'changed';
  assert.equal(resolveRerankCriteria({ value: null, params: PARAMS }).ladder[0], DEFAULT_REGISTRY.ladder[0]);
  assert.deepEqual(Object.keys(result).sort(), ['choiceInstruction', 'digest', 'ladder', 'source', 'warning']);
});

// ── reading the setting from the settings files ───────────────────────────────────────────────────

test('without a value the reader takes it from the project settings file; a bad file or value is a warning, never a throw', (t) => {
  const f = createSettingsEnv(t);
  const read = () => resolveRerankCriteria({ projectRoot: f.project, env: f.env(), params: PARAMS });
  registryFallback(read());
  assert.equal(read().warning, null);

  f.writeProjectSettings({ schema: 1, 'advice.criteria.rerank': VALID6 });
  const set = read();
  assert.equal(set.source, 'settings');
  assert.equal(set.warning, null);
  assert.deepEqual(set.ladder, LADDER);
  assert.equal(set.choiceInstruction, CHOICE);

  f.writeProjectSettings({ schema: 1, 'advice.criteria.rerank': 'a\nb\nc\nd' });
  const bad = read();
  registryFallback(bad);
  assert.match(bad.warning, /has 4 lines/);

  f.writeProjectSettings({ schema: 1, 'advice.criteria.rerank': 5 });
  const typed = read();
  registryFallback(typed);
  assert.match(typed.warning, /ignored/);

  fs.writeFileSync(f.projectFile('settings.json'), '{not json');
  const broken = read();
  registryFallback(broken);
  assert.ok(broken.warning);
});

// ── the settings key ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/settings.json'), 'utf8'));

test('advice.criteria.rerank is registered like its advice neighbours', () => {
  const spec = REGISTRY.keys['advice.criteria.rerank'];
  assert.deepEqual(spec, {
    type: 'string', default: null, scope: 'project-overridable', combine: 'override', securityRelevant: true,
    failSafe: { gate: 'advice.enabled' }, env: null, flag: null, shellRead: null, needsConfigHome: false, legacy: [],
    consumers: ['src/runtime/advice/criteria.ts'], description: spec.description,
  });
  const model = REGISTRY.keys['advice.models.mcp-need'];
  for (const field of ['type', 'default', 'scope', 'combine', 'securityRelevant', 'failSafe', 'env', 'flag', 'shellRead', 'needsConfigHome']) {
    assert.deepEqual(spec[field], model[field], field);
  }
  assert.ok(fs.existsSync(path.join(REPO, spec.consumers[0])));
});

test('config set and config unset refuse advice.criteria.rerank with the security message, at every layer, and write nothing', (t) => {
  const f = createSettingsEnv(t);
  for (const layer of ['user', 'project', 'local']) {
    for (const args of [['set', 'advice.criteria.rerank', JSON.stringify(VALID5)], ['unset', 'advice.criteria.rerank']]) {
      const result = f.run(['config', ...args, '--layer', layer, '--json']);
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.equal(result.json.errors.length, 1);
      const [entry] = result.json.errors;
      assert.equal(entry.key, 'advice.criteria.rerank');
      assert.equal(entry.code, 'security');
      assert.match(entry.message, /security-relevant: a person writes it in the settings file/);
    }
  }
  assert.equal(fs.existsSync(f.configDir), false);
  assert.equal(fs.existsSync(f.projectFile('settings.json')), false);
  assert.equal(fs.existsSync(f.projectFile('settings.local.json')), false);
});

test('the per-kind key rule is not confused by the criteria key: kinds and models keys stay one per registry kind', () => {
  const advice = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/advice.json'), 'utf8'));
  const keys = Object.keys(REGISTRY.keys);
  const kindIds = advice.kinds.map((kind: any) => kind.id);
  for (const prefix of ['advice.kinds.', 'advice.models.']) {
    const registered = keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    for (const id of kindIds) assert.ok(registered.includes(id), `${prefix}${id}`);
  }
  assert.ok(keys.includes('advice.criteria.rerank'));
  assert.ok(!keys.some((key) => /^advice\.(kinds|models)\.criteria/.test(key)));
});
