'use strict';

// FR-003: the plan template's Phase A and Phase B example task lines carry the `acceptance:` key
// and, once their bracket placeholders hold real values, parse with zero problems.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planVerdict } = require('../../src/runtime/task-graph.ts');

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'core', 'shared', 'templates', 'doflow', 'plan-template.md'), 'utf8');

const EXAMPLE_LINE = /^- \[ \] (A\.1|A\.2|B\.1)\b.*$/;

/** Fill one example line's placeholders with real values and drop the optional keys. */
function fill(line, acceptance = 'FR-001, IC-002') {
  return line
    .replace('[FR-/NFR-/IC- ids, comma-separated]', acceptance)
    .replace('[agent]', 'core-implementer')
    .replace('[paths]', 'src/a.js')
    .replace(/; depends-on:.*$/, '')
    .replace('[task, depends A.1]', 'second task, depends A.1')
    .replace('[task]', 'a task');
}

const exampleLines = TEMPLATE.split('\n').filter((line) => EXAMPLE_LINE.test(line));

test('the template carries the Phase A and Phase B example task lines', () => {
  assert.deepEqual(exampleLines.map((l) => l.match(EXAMPLE_LINE)[1]), ['A.1', 'A.2', 'B.1']);
});

test('every example task line carries an acceptance: key after the em dash', () => {
  for (const line of exampleLines) {
    const [, keys] = line.split(' — ');
    assert.ok(keys && /(^|; )acceptance: /.test(keys), `no acceptance: key in: ${line}`);
  }
});

test('the filled example lines parse with zero problems', () => {
  const text = ['# Plan', '', '## 8. Tasks', '', ...exampleLines.map((l) => fill(l)), ''].join('\n');
  const verdict = planVerdict(text);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);
  assert.ok(verdict.tasks >= 2, `expected 2+ tasks, got ${verdict.tasks}`);
});

test('negative control: a range in acceptance: is a bad-acceptance problem', () => {
  const text = ['# Plan', '', '## 8. Tasks', '', ...exampleLines.map((l) => fill(l, 'FR-001..FR-002')), ''].join('\n');
  const verdict = planVerdict(text);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.kind === 'bad-acceptance' && p.value === 'FR-001..FR-002'));
});
