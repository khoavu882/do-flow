'use strict';

// IC-019: the rendered context behaviour matrix in docs/capability-map.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderBehaviourMatrix, BEHAVIOUR_ORDER, HARNESS_ORDER } = require('../../src/lifecycle/coverage.ts');
// The shipped block is written by the docs generator from an inert copy of the registry (Markdown and
// HTML in a value escaped), so the shipped rows are compared with that rendering.
const { inert } = require('../../src/release/docs-blocks.ts');

const REPO = path.resolve(__dirname, '../..');
const coverage = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/lifecycle.json'), 'utf8')).coverage;
const START = '<!-- BEGIN GENERATED:context-behaviour-matrix -->';
const END = '<!-- END GENERATED:context-behaviour-matrix -->';

function shippedBlock() {
  const text = fs.readFileSync(path.join(REPO, 'docs/capability-map.md'), 'utf8');
  const a = text.indexOf(START), b = text.indexOf(END);
  assert.ok(a >= 0 && b > a, 'behaviour matrix markers present and ordered');
  return { text, block: text.slice(a + START.length, b).trim(), a, b };
}

test('renderer sorts by IC-018 behaviour order, then HARNESS_ORDER', () => {
  const shuffled = { ...coverage, behaviours: [...coverage.behaviours].reverse() };
  const rows = renderBehaviourMatrix(shuffled).split('\n').slice(3).map((line) => line.split(' | ').map((cell) => cell.replace(/^\| |\s\|$/g, '')));
  assert.equal(rows.length, BEHAVIOUR_ORDER.length * HARNESS_ORDER.length);
  const expected = BEHAVIOUR_ORDER.flatMap((behaviour) => HARNESS_ORDER.map((harness) => `${behaviour}/${harness}`));
  assert.deepEqual(rows.map(([behaviour, harness]) => `${behaviour}/${harness}`), expected);
});

test('header line names schema and revision only, then the column header', () => {
  const lines = renderBehaviourMatrix(coverage).split('\n');
  assert.equal(lines[0], `Schema ${coverage.schemaVersion}; revision ${coverage.revision}`);
  assert.equal(lines[1], '| Behaviour | Harness | Status | Limitation or tests |');
  assert.equal(lines[2], '|---|---|---|---|');
  const bumped = renderBehaviourMatrix({ ...coverage, revision: 99 }).split('\n')[0];
  assert.equal(bumped, `Schema ${coverage.schemaVersion}; revision 99`);
});

test('enforced rows list tests; limitation rows carry the limitation', () => {
  const rendered = renderBehaviourMatrix({ schemaVersion: 1, revision: 1, behaviours: [
    { behaviour: 'identity', harness: 'claude', status: 'limitation', limitation: 'unverified' },
    { behaviour: 'context-authority', harness: 'codex', status: 'enforced', tests: ['a.test.js', 'b.test.js'] },
  ] }).split('\n');
  assert.deepEqual(rendered.slice(3), [
    '| context-authority | codex | enforced | a.test.js, b.test.js |',
    '| identity | claude | limitation | unverified |',
  ]);
});

test('every row of the shipped block equals the renderer output', () => {
  const { block } = shippedBlock();
  const shipped = block.split('\n');
  const rendered = renderBehaviourMatrix(inert(coverage)).split('\n');
  assert.equal(shipped.length, rendered.length, 'row count');
  rendered.forEach((line, index) => assert.equal(shipped[index], line, `row ${index}`));
});

test('behaviour block sits outside the enforcement-matrix markers', () => {
  const { text, a, b } = shippedBlock();
  const ea = text.indexOf('<!-- BEGIN GENERATED:enforcement-matrix -->');
  const eb = text.indexOf('<!-- END GENERATED:enforcement-matrix -->');
  assert.ok(ea >= 0 && eb > ea);
  assert.ok(b < ea || a > eb, 'blocks do not overlap');
});
