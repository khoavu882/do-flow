'use strict';

// Row 181 J.1, IC-019: the rule detection grammar and the cover check. Builds its own version 2
// ledger in memory; it does not read core/registry/rules.json.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { findRuleLines, coverRuleLines } = require('../../../src/runtime/guidance/rule-ledger.ts');

const row = (id: string, statement: string, sourceFile = 'a.md') => ({
  id, tag: 'x', statement, sourceFile, category: 'workflow', enforcement: 'judgement-only', enforcementRef: null,
  reason: 'prose only', neverAblate: false, ablationCandidate: false,
});
const ledger = (...rules: any[]) => ({ version: 2, rules });

describe('findRuleLines', () => {
  test('matches every keyword of the grammar and reports 1-based lines', () => {
    const text = ['MUST a', 'NEVER b', 'Never c', 'never d', 'Do not e', 'do not f', 'Always g', 'ALWAYS h', 'must i', 'plain'].join('\n');
    assert.deepEqual(findRuleLines(text).map((h: any) => h.line), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('ignores a keyword inside a word and a keyword that is not in the set', () => {
    assert.deepEqual(findRuleLines('mustard and nevertheless\nMust start\nDo  not\nshould not'), []);
  });

  test('ignores hits inside code fences and HTML comments, keeps the line numbers', () => {
    const text = ['```', 'you MUST not', '```', 'visible: never skip', '<!-- never in a comment -->', '<!--', 'Always multi', '-->', '~~~', 'do not', '~~~', 'last: Always'].join('\n');
    assert.deepEqual(findRuleLines(text), [{ line: 4, text: 'visible: never skip' }, { line: 12, text: 'last: Always' }]);
  });
});

describe('coverRuleLines', () => {
  const text = ['# Title', '', '- **Safety:** Never push to `main`;', '  always ask first.', 'Prose line.', '- You MUST test.'].join('\n');
  const files = [{ path: 'a.md', text }];

  test('a hit spanned by exactly one row is clean, across lines and markup', () => {
    const l = ledger(row('r1', 'Safety: Never push to main; always ask first.'), row('r2', 'You MUST test.'));
    assert.deepEqual(coverRuleLines(files, l), []);
  });

  test('an uncovered hit is reported with path:line', () => {
    const f = coverRuleLines(files, ledger(row('r1', 'Never push to main; always ask first.')));
    assert.deepEqual(f.map((x: any) => [x.kind, x.path, x.line]), [['uncovered', 'a.md', 6]]);
  });

  test('a double-covered hit names both rows', () => {
    const l = ledger(row('r1', 'Never push to main; always ask first.'), row('r2', 'push to main; always ask'), row('r3', 'You MUST test.'));
    const f = coverRuleLines(files, l);
    assert.deepEqual(f.map((x: any) => [x.kind, x.line, x.rows]), [['double-covered', 3, ['r1', 'r2']]]);
  });

  test('a hit in a fence is not asked to be covered', () => {
    const fenced = [{ path: 'a.md', text: '```\nNever in code\n```\nOK' }];
    assert.deepEqual(coverRuleLines(fenced, ledger()), []);
  });

  test('rows only cover their own sourceFile, and the header: body fallback applies', () => {
    const two = [{ path: 'a.md', text: 'Never lie.' }, { path: 'b.md', text: 'Header\n\nNever lie.' }];
    const f = coverRuleLines(two, ledger(row('r1', 'Never lie.', 'a.md'), row('r2', 'Tag: Never lie.', 'b.md')));
    assert.deepEqual(f, []);
    assert.deepEqual(coverRuleLines(two, ledger(row('r1', 'Never lie.', 'a.md'))).map((x: any) => x.path), ['b.md']);
  });

  test('a row whose statement is not in the file covers nothing', () => {
    const f = coverRuleLines([{ path: 'a.md', text: 'Never lie.' }], ledger(row('r1', 'Something else entirely.')));
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, 'uncovered');
  });
});
