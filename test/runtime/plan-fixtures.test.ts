'use strict';
// plan-fixtures.test.js — committed 8ce5ad7 plan fixtures and their line hashes (feature 080, A.1;
// IC-020, IC-002, NFR-001).
//
// test/fixtures/plans/ holds byte-for-byte copies of three real plan.md files (070, 076, 078), and
// expected.json holds each task's `description` and `taskLineHash` as computed by the 8ce5ad7
// parser and hash, run from `git archive 8ce5ad7 src` in a temp dir. This file parses the copies
// with the current tree and compares with expected.json; it never recomputes the expectation, so a
// parser or hash change that would make an attempt claimed under 8ce5ad7 report `plan-changed` is
// caught here. The 070 plan writes its ids as `[A.1]`, which the 8ce5ad7 parser does not read as
// tasks, so its expectation is an empty task set and that must stay true.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { parsePlan } = require('../../src/runtime/scaffold/artifacts.ts');
const { taskLineHash } = require('../../src/runtime/task-attempts.ts');

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'plans');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
const NAMES: any = ['070-task-attempt-ledger', '076-evidence-attempts', '078-scoped-context-arbitration'];
const LIVE = path.join(REPO, 'agent-docs', 'doflow');

/** `{ <taskId>: { description, taskLineHash } }` for one plan text, in plan order. */
function digest(text: any) {
  const out: any = {};
  for (const task of parsePlan(text).tasks) {
    out[task.id] = { description: task.description, taskLineHash: taskLineHash(task) };
  }
  return out;
}

test('expected.json covers exactly the three committed fixtures', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...NAMES].sort());
  for (const name of NAMES) assert.ok(fs.existsSync(path.join(FIXTURES, name, 'plan.md')), `${name}/plan.md`);
});

for (const name of NAMES) {
  test(`${name}: every task's description and line hash equal the 8ce5ad7 values`, () => {
    const actual: any = digest(fs.readFileSync(path.join(FIXTURES, name, 'plan.md'), 'utf8'));
    const expected = EXPECTED[name];
    assert.deepEqual(Object.keys(actual), Object.keys(expected), 'the task id set and order');
    for (const id of Object.keys(expected)) {
      assert.equal(actual[id].description, expected[id].description, `${name} ${id} description`);
      assert.equal(actual[id].taskLineHash, expected[id].taskLineHash, `${name} ${id} taskLineHash`);
    }
  });
}

test('control: one changed character in one task line changes that task hash and no other', (t) => {
  const name = '076-evidence-attempts';
  const text = fs.readFileSync(path.join(FIXTURES, name, 'plan.md'), 'utf8');
  const lines = text.split('\n');
  const index = lines.findIndex((line: any) => /^-\s*\[[ xX]\]\s+A\.1\s/.test(line));
  assert.notEqual(index, -1, 'the 076 fixture holds an A.1 task line');
  // Flip the first letter of the description text, which every hash input after the id reads.
  const match = lines[index].match(/^(-\s*\[[ xX]\]\s+A\.1\s+(?:\[[^\]]+\]\s+)*)(\S)/);
  assert.ok(match, 'A.1 has description text');
  const at = match[1].length;
  const flipped = match[2] === 'X' ? 'Y' : 'X';
  lines[index] = lines[index].slice(0, at) + flipped + lines[index].slice(at + 1);

  const dir = tempDir(t, 'doflow-plan-fixture-');
  const copy = path.join(dir, 'plan.md');
  fs.writeFileSync(copy, lines.join('\n'));
  const actual: any = digest(fs.readFileSync(copy, 'utf8'));

  assert.notEqual(actual['A.1'].taskLineHash, EXPECTED[name]['A.1'].taskLineHash, 'perturbed A.1 hash');
  for (const id of Object.keys(EXPECTED[name]).filter((id) => id !== 'A.1')) {
    assert.equal(actual[id].taskLineHash, EXPECTED[name][id].taskLineHash, `${id} unaffected`);
  }
});

test('optional local check: live agent-docs/doflow plans parse and hash', (t) => {
  if (!fs.existsSync(LIVE)) {
    t.skip('agent-docs/ is gitignored and absent in this checkout');
    return;
  }
  const slugs = fs.readdirSync(LIVE).filter((slug: any) => fs.existsSync(path.join(LIVE, slug, 'plan.md')));
  for (const slug of slugs) {
    const text = fs.readFileSync(path.join(LIVE, slug, 'plan.md'), 'utf8');
    const actual = digest(text);
    for (const [id, entry] of Object.entries(actual)) {
      assert.match(entry.taskLineHash, /^sha256:[0-9a-f]{64}$/, `${slug} ${id}`);
    }
    // A live plan still identical to its fixture must give the committed expectation.
    if (NAMES.includes(slug) && text === fs.readFileSync(path.join(FIXTURES, slug, 'plan.md'), 'utf8')) {
      assert.deepEqual(actual, EXPECTED[slug], `${slug} live plan`);
    }
  }
});
