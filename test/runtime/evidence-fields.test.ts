'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const evidenceFields = require('../../src/runtime/evidence-fields.ts');
const cli = require('../../src/runtime/cli.ts');

const REPO = path.resolve(__dirname, '../..');

test('single-definition: the score-field list is defined only in src/runtime/evidence-fields.ts', (): any => {
  const srcDir = path.join(REPO, 'src');
  const definingFiles: any = [];

  function walk(dir: any) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        if (/EVIDENCE_SCORE_FIELDS(?::[^=]+)?\s*=\s*new Set/.test(text)) {
          definingFiles.push(path.relative(REPO, full).split(path.sep).join('/'));
        }
      }
    }
  }

  walk(srcDir);
  assert.deepEqual(definingFiles, ['src/runtime/evidence-fields.ts']);
  assert.equal(cli.EVIDENCE_SCORE_FIELDS, evidenceFields.EVIDENCE_SCORE_FIELDS);
});

test('cli.ts re-exports the exact same score-field objects from evidence-fields.ts', () => {
  assert.equal(cli.EVIDENCE_SCORE_FIELDS, evidenceFields.EVIDENCE_SCORE_FIELDS);
  assert.equal(cli.scoreFieldRefusal, evidenceFields.scoreFieldRefusal);
  assert.equal(cli.assertNoScoreFields, evidenceFields.assertNoScoreFields);
});

test('EVIDENCE_SCORE_FIELDS contains exactly the ten canonical score names', () => {
  const expected: any = [
    'confidence', 'score', 'relevance', 'relevanceScore', 'similarity',
    'certainty', 'probability', 'rank', 'distance', 'weight',
  ];
  assert.equal(evidenceFields.EVIDENCE_SCORE_FIELDS.size, 10);
  for (const name of expected) {
    assert.ok(evidenceFields.EVIDENCE_SCORE_FIELDS.has(name), `expected ${name} in EVIDENCE_SCORE_FIELDS`);
  }
});

test('assertNoScoreFields refuses score keys and passes clean objects', () => {
  assert.throws(
    () => evidenceFields.assertNoScoreFields({ score: 0.8 }, ''),
    /'score' is a retrieval score and this boundary records none/
  );
  assert.throws(
    () => evidenceFields.assertNoScoreFields({ source: { rank: 1 } }, ''),
    /'source\.rank' is a retrieval score and this boundary records none/
  );
  assert.doesNotThrow(() => evidenceFields.assertNoScoreFields({ kind: 'exact-search', locator: { file: 'a.ts' } }, ''));
  assert.doesNotThrow(() => evidenceFields.assertNoScoreFields(null, ''));
  assert.doesNotThrow(() => evidenceFields.assertNoScoreFields('string', ''));
});
