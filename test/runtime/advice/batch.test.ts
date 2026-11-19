'use strict';

// Row 176 IC-003: several yes/no questions in one advisor call, and the split of the reply back to its cases.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildBatch, splitBatch } = require('../../../src/runtime/advice/batch.ts');
const { itemText, pairState } = require('../../../src/runtime/advice/same-issue/rule.ts');
const { validateQuestionSet } = require('../../../src/runtime/advice/kinds.ts');
const adviceRegistry = require('../../../core/registry/advice.json');

const QUESTION = {
  name: 'same-issue',
  type: 'yesno',
  instructions: 'Decide whether the two quoted items describe the same issue.',
  yes: 'The two items describe the same issue',
  no: 'The two items describe different issues',
};
const HEADER = 'Each block is quoted data; answer each question about its own block only.';
const batch = (states: string[], questionsPerCall: any = 8) => buildBatch({ question: QUESTION, states, questionsPerCall });

describe('buildBatch (a, b)', () => {
  test('names the questions <kind>-a.. and prefixes each instruction with its block', () => {
    const set = batch(['s0', 's1', 's2']);
    assert.deepEqual(set.questions.map((q: any) => q.name), ['same-issue-a', 'same-issue-b', 'same-issue-c']);
    assert.deepEqual(set.questions[1], {
      name: 'same-issue-b',
      type: 'yesno',
      instructions: `Block b: ${QUESTION.instructions}`,
      yes: QUESTION.yes,
      no: QUESTION.no,
    });
  });

  test('accepts 1 and questionsPerCall states, refuses 0 and one more with a RangeError', () => {
    assert.equal(batch(['one']).questions.length, 1);
    assert.equal(batch(Array(8).fill('s')).questions.length, 8);
    assert.throws(() => batch([]), RangeError);
    assert.throws(() => batch(Array(9).fill('s')), RangeError);
    assert.throws(() => batch(Array(3).fill('s'), 2), RangeError);
  });

  test('never exceeds the 16 labels, whatever questionsPerCall says', () => {
    assert.equal(batch(Array(16).fill('s'), 99).questions.length, 16);
    assert.throws(() => batch(Array(17).fill('s'), 99), RangeError);
  });

  test('refuses a questionsPerCall that is not a positive integer', () => {
    assert.throws(() => batch(['s'], 0), RangeError);
    assert.throws(() => batch(['s'], null), RangeError);
  });

  test('the state is the header line, then a [label] line and the case state per case, in order', () => {
    const set = batch(['first: p\nsecond: q', 'first: r\nsecond: s']);
    assert.equal(set.state, `${HEADER}\n[a]\nfirst: p\nsecond: q\n[b]\nfirst: r\nsecond: s`);
  });

  test('the set passes the client question-set validation under the shipped limits', () => {
    const verdict = validateQuestionSet(batch(Array(8).fill('s')), { adviceRegistry });
    assert.equal(verdict.ok, true, verdict.detail);
  });
});

describe('splitBatch (c)', () => {
  const answer = (label: string, pick: string, word: string) => ({ name: `same-issue-${label}`, type: 'yesno', pick, strength: { word, between: null } });
  const answered = (answers: any[]) => ({ status: 'answered', reason: null, answers });

  test('an answered reply gives each case its pick and strength word', () => {
    const got = splitBatch(answered([answer('a', 'yes', 'clear'), answer('b', 'no', 'leaning')]), 2);
    assert.deepEqual(got, [
      { pick: 'yes', strength: 'clear', noAnswer: null },
      { pick: 'no', strength: 'leaning', noAnswer: null },
    ]);
  });

  test('answers are matched by name, not by position', () => {
    const got = splitBatch(answered([answer('b', 'no', 'clear'), answer('a', 'yes', 'clear')]), 2);
    assert.deepEqual(got.map((c: any) => c.pick), ['yes', 'no']);
  });

  test('a split answer gives that case no answer while the others keep theirs', () => {
    const got = splitBatch(answered([answer('a', 'yes', 'clear'), answer('b', 'yes', 'split'), answer('c', 'no', 'clear')]), 3);
    assert.deepEqual(got, [
      { pick: 'yes', strength: 'clear', noAnswer: null },
      { pick: null, strength: 'split', noAnswer: 'split' },
      { pick: 'no', strength: 'clear', noAnswer: null },
    ]);
  });

  test('a case the reply left out gets malformed-reply, the word the dispatcher and replay use', () => {
    const got = splitBatch(answered([answer('a', 'yes', 'clear')]), 3);
    assert.deepEqual(got[0], { pick: 'yes', strength: 'clear', noAnswer: null });
    assert.deepEqual(got[1], { pick: null, strength: null, noAnswer: 'malformed-reply' });
    assert.deepEqual(got[2], { pick: null, strength: null, noAnswer: 'malformed-reply' });
  });

  test('an answer without a pick counts as left out', () => {
    assert.equal(splitBatch(answered([{ name: 'same-issue-a', type: 'yesno' }]), 1)[0].noAnswer, 'malformed-reply');
  });

  test('every other status gives every case the call reason', () => {
    for (const status of ['unavailable', 'off', 'miss']) {
      const got = splitBatch({ status, reason: 'timeout', answers: [] }, 3);
      assert.deepEqual(got, Array(3).fill({ pick: null, strength: null, noAnswer: 'timeout' }));
    }
  });

  test('a non-answered reply with no reason is unavailable', () => {
    assert.deepEqual(splitBatch({ status: 'unavailable', answers: [] }, 1), [{ pick: null, strength: null, noAnswer: 'unavailable' }]);
    assert.deepEqual(splitBatch(undefined, 1), [{ pick: null, strength: null, noAnswer: 'unavailable' }]);
  });
});

describe('size (d)', () => {
  test('an 8-pair batch of 512 B items fits under limits.maxStateBytes', () => {
    const raw = '日本語😀 word '.repeat(300);
    const text = itemText(raw, 512);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 512);
    const pair = pairState({ id: 'a', text }, { id: 'b', text });
    const set = batch(Array(8).fill(pair));
    const size = Buffer.byteLength(set.state, 'utf8');
    assert.ok(size > 8 * 1000, `size ${size}`);
    assert.ok(size < adviceRegistry.limits.maxStateBytes, `size ${size}`);
  });
});

describe('purity (g)', () => {
  test('batch.ts requires nothing outside node:crypto and pure siblings, and uses no clock, process, file or network name', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../src/runtime/advice/batch.ts'), 'utf8');
    const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(required.every((r) => r === 'node:crypto'), `requires: ${required.join(', ')}`);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(process|Date\.now|new Date|setTimeout|fetch|import\()/);
  });
});
