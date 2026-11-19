'use strict';

// Row 176 IC-002: the rule stage of the same-issue kind. Pure functions; the model sees only the pairs this picks.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const rule = require('../../src/runtime/advice/same-issue/rule.ts');
const { itemText, tokens, score, candidatePairs, ruleMatches, pairState, pairKey } = rule;

const PARAMS = { itemBytes: 512, questionsPerCall: 8, maxPairs: 32, perItem: 2, candidateAtPct: 15, flagAtPct: 40, locatorBonusPct: 15, maxCompare: 2000 };
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

describe('itemText (a)', () => {
  test('collapses whitespace runs and trims', () => {
    assert.equal(itemText('  a \n\t b   c  ', 512), 'a b c');
  });

  test('keeps text that fits unchanged, without a mark', () => {
    assert.equal(itemText('x'.repeat(512), 512), 'x'.repeat(512));
  });

  test('cuts 2 KB of multi-byte text at a code-point boundary, marks the cut, stays within itemBytes', () => {
    const raw = '日本語😀'.repeat(160); // 13 bytes per repeat, over 2 KB
    assert.ok(bytes(raw) > 2000);
    const out = itemText(raw, 512);
    assert.ok(out.endsWith('[…]'));
    assert.ok(bytes(out) <= 512);
    assert.ok(bytes(out) > 512 - 4, 'cut as late as a whole code point allows');
    const body = out.slice(0, -3);
    assert.ok(!body.includes('�'));
    assert.equal(raw.startsWith(body), true, 'the kept text is a prefix, no split surrogate pair');
    assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out);
  });
});

describe('tokens (b)', () => {
  test('NFKC, lower case, split on non letters or digits, length at least 3', () => {
    assert.deepEqual([...tokens('Ｆｏｏ-Bar: x ab 42 café')].sort(), ['bar', 'café', 'foo']);
  });

  test('keeps a three-character digit run, drops two-character tokens', () => {
    assert.deepEqual([...tokens('404 42 ab')], ['404']);
  });

  test('drops the stop list', () => {
    assert.deepEqual([...tokens('The race and the lock for this')], ['race', 'lock']);
  });

  test('folds trailing ies to y and a trailing s, not ss', () => {
    assert.deepEqual([...tokens('queries locks class')].sort(), ['class', 'lock', 'query']);
  });

  test('a token and its plural are one token', () => {
    assert.deepEqual([...tokens('lock locks')], ['lock']);
  });
});

describe('score (c)', () => {
  const a = { id: 'a', text: 'alpha beta gamma delta' };
  const b = { id: 'b', text: 'alpha beta epsilon zeta' };

  test('Jaccard of the token sets: 2 shared of 6', () => {
    assert.equal(score(a, b, PARAMS), 2 / 6);
  });

  test('identical texts score 1; disjoint texts score 0; two empty sets score 0', () => {
    assert.equal(score(a, a, PARAMS), 1);
    assert.equal(score(a, { id: 'c', text: 'omega sigma' }, PARAMS), 0);
    assert.equal(score({ id: 'x', text: '' }, { id: 'y', text: 'a b' }, PARAMS), 0);
  });

  test('the same file in both locators adds locatorBonusPct / 100, line or fragment ignored', () => {
    const withA = { ...a, locator: 'src/x.ts:12' };
    assert.equal(score(withA, { ...b, locator: ' src/x.ts#L40 ' }, PARAMS), 2 / 6 + 0.15);
  });

  test('no bonus for different files or a missing locator', () => {
    const withA = { ...a, locator: 'src/x.ts:12' };
    assert.equal(score(withA, { ...b, locator: 'src/y.ts:12' }, PARAMS), 2 / 6);
    assert.equal(score(withA, b, PARAMS), 2 / 6);
    assert.equal(score(withA, { ...b, locator: null }, PARAMS), 2 / 6);
    assert.equal(score({ ...a, locator: '' }, { ...b, locator: '' }, PARAMS), 2 / 6);
  });

  test('the bonus follows the parameter', () => {
    const both = [{ ...a, locator: 'f.ts:1' }, { ...b, locator: 'f.ts:9' }];
    assert.equal(score(both[0], both[1], { ...PARAMS, locatorBonusPct: 0 }), 2 / 6);
    assert.equal(score(both[0], both[1], { ...PARAMS, locatorBonusPct: 50 }), 2 / 6 + 0.5);
  });
});

describe('pairKey (f)', () => {
  test('first 16 hex of sha256(min id, newline, max id), the same in either order', () => {
    const expected = crypto.createHash('sha256').update('F-01\nF-02').digest('hex').slice(0, 16);
    assert.equal(pairKey('F-01', 'F-02'), expected);
    assert.equal(pairKey('F-02', 'F-01'), expected);
    assert.match(pairKey('x', 'y'), /^[0-9a-f]{16}$/);
    assert.notEqual(pairKey('F-01', 'F-03'), expected);
  });
});

describe('candidatePairs (d, e, f)', () => {
  // x1/x2 share 3 of 4 tokens; y1/y2 share 2 of 6; z is unrelated.
  const items = [
    { id: 'x1', text: 'race condition cache writer' },
    { id: 'x2', text: 'race condition cache reader' },
    { id: 'y1', text: 'alpha beta gamma delta' },
    { id: 'y2', text: 'alpha beta epsilon zeta' },
    { id: 'z', text: 'omega sigma kappa' },
  ];

  test('every pair is {a, b, score, rule, key} with a < b by id', () => {
    const pairs = candidatePairs(items, PARAMS);
    for (const p of pairs) {
      assert.deepEqual(Object.keys(p).sort(), ['a', 'b', 'key', 'rule', 'score']);
      assert.ok(p.a < p.b);
      assert.equal(p.key, pairKey(p.a, p.b));
    }
    assert.deepEqual(pairs.map((p: any) => `${p.a}-${p.b}`), ['x1-x2', 'y1-y2']);
  });

  test('a pair below candidateAtPct is not a candidate', () => {
    assert.equal(candidatePairs(items, PARAMS).some((p: any) => p.a === 'z' || p.b === 'z'), false);
    assert.deepEqual(candidatePairs(items, { ...PARAMS, candidateAtPct: 34 }).map((p: any) => p.a), ['x1']);
  });

  test('rule is yes exactly when score reaches flagAtPct / 100', () => {
    const t = [{ id: 'p', text: 'alpha beta gamma' }, { id: 'q', text: 'alpha beta delta' }]; // 2/4 = 0.5
    const at = (flagAtPct: number) => candidatePairs(t, { ...PARAMS, flagAtPct })[0];
    assert.equal(at(50).rule, 'yes');
    assert.equal(at(51).rule, 'no');
    const u = [{ id: 'p', text: 'alpha beta gamma delta epsilon' }, { id: 'q', text: 'alpha beta' }]; // 2/5 = 0.4
    assert.equal(candidatePairs(u, PARAMS)[0].score, 0.4);
    assert.equal(candidatePairs(u, PARAMS)[0].rule, 'yes');
    assert.equal(candidatePairs(u, { ...PARAMS, flagAtPct: 41 })[0].rule, 'no');
  });

  test('perItem keeps each item its best pairs only; the union is deduplicated', () => {
    // hub shares more with s1 than s2 than s3; with perItem 1 the hub keeps s1, and s2/s3 keep the hub.
    const set = [
      { id: 'hub', text: 'one two three four five six' },
      { id: 's1', text: 'one two three four five' },
      { id: 's2', text: 'one two three four' },
      { id: 's3', text: 'one two three' },
    ];
    const keys = (perItem: number) => candidatePairs(set, { ...PARAMS, perItem, candidateAtPct: 1 }).map((p: any) => `${p.a}-${p.b}`);
    assert.deepEqual(keys(1), ['hub-s1', 's1-s2', 's2-s3']);
    assert.ok(keys(1).length < keys(9).length);
    assert.equal(keys(9).length, 6, 'every pair of four items when perItem is large');
  });

  test('order is score descending then key ascending; ties break by key', () => {
    const set = [
      { id: 'a', text: 'alpha beta gamma delta' },
      { id: 'b', text: 'alpha beta gamma delta' },
      { id: 'c', text: 'alpha beta gamma delta' },
    ];
    const pairs = candidatePairs(set, PARAMS);
    assert.equal(pairs.length, 3);
    assert.deepEqual(pairs.map((p: any) => p.key), pairs.map((p: any) => p.key).slice().sort());
    const mixed = candidatePairs([...set, { id: 'd', text: 'alpha beta gamma' }], { ...PARAMS, perItem: 9 });
    const scores = mixed.map((p: any) => p.score);
    assert.deepEqual(scores, scores.slice().sort((l: number, r: number) => r - l));
  });

  test('maxPairs caps the list, keeping the best', () => {
    const set = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, text: `alpha beta gamma tok${i}x` }));
    const all = candidatePairs(set, { ...PARAMS, perItem: 9, maxPairs: 99 });
    const capped = candidatePairs(set, { ...PARAMS, perItem: 9, maxPairs: 4 });
    assert.equal(all.length, 15);
    assert.deepEqual(capped, all.slice(0, 4));
  });

  test('among keeps only pairs touching those ids', () => {
    const pairs = candidatePairs(items, PARAMS, { among: new Set(['y2']) });
    assert.deepEqual(pairs.map((p: any) => `${p.a}-${p.b}`), ['y1-y2']);
    assert.deepEqual(candidatePairs(items, PARAMS, { among: new Set(['z']) }), []);
    assert.deepEqual(candidatePairs(items, PARAMS, { among: new Set() }), []);
  });

  test('an id order different from input order still gives a < b', () => {
    const [p] = candidatePairs([{ id: 'm', text: 'same words here' }, { id: 'c', text: 'same words here' }], PARAMS);
    assert.equal(p.a, 'c');
    assert.equal(p.b, 'm');
  });

  test('fewer than two items give no pairs', () => {
    assert.deepEqual(candidatePairs([], PARAMS), []);
    assert.deepEqual(candidatePairs([items[0]], PARAMS), []);
  });
});

describe('ruleMatches', () => {
  const set = [
    { id: 'n', text: 'alpha beta gamma delta' },
    { id: 'm1', text: 'alpha beta gamma delta' }, // 1.0
    { id: 'm2', text: 'alpha beta gamma epsilon' }, // 3/5
    { id: 'm3', text: 'alpha beta zeta eta' }, // 2/6, a candidate but below the flag bar
    { id: 'o1', text: 'omega sigma kappa' },
    { id: 'o2', text: 'omega sigma kappa' },
  ];

  test('the rule-yes pairs touching the item, best first, with no cut by perItem', () => {
    const got = ruleMatches(set, { ...PARAMS, perItem: 1 }, 'n', 10);
    assert.deepEqual(got.map((p: any) => [p.a, p.b]), [['m1', 'n'], ['m2', 'n']]);
    assert.ok(got.every((p: any) => p.rule === 'yes'));
  });

  test('capped by limit', () => {
    assert.deepEqual(ruleMatches(set, PARAMS, 'n', 1).map((p: any) => p.a), ['m1']);
  });

  test('an item with no match, or an unknown id, gives none', () => {
    assert.deepEqual(ruleMatches(set, PARAMS, 'm3', 10), []);
    assert.deepEqual(ruleMatches(set, PARAMS, 'nope', 10), []);
  });
});

describe('pairState', () => {
  test('is "first: <text>\\nsecond: <text>" with the texts as given', () => {
    assert.equal(pairState({ id: 'a', text: 'one  two' }, { id: 'b', text: 'three' }), 'first: one  two\nsecond: three');
  });
});

describe('purity (g)', () => {
  test('rule.ts requires nothing but node:crypto and uses no clock, process, file or network name', () => {
    const file = path.join(__dirname, '../../src/runtime/advice/same-issue/rule.ts');
    const source = fs.readFileSync(file, 'utf8');
    const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(required.every((r) => r === 'node:crypto'), `requires: ${required.join(', ')}`);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(process|Date\.now|new Date|setTimeout|fetch|import\()/);
  });
});
