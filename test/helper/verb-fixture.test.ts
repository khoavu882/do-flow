'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFixture, measureVerb, runVerb, normalize, byteCount, ceilingFor, followupStatement, FOLLOWUP_COUNT, IC009_ROWS, REPO } = require('./verb-fixture.ts');

test('ceilingFor reproduces the IC-009 table values', () => {
  const table: [number, number][] = [[2600, 2752], [91329, 91904], [5606, 5888], [788, 832], [555, 640], [230, 256], [54, 64], [43178, 43712]];
  for (const [measured, ceiling] of table) assert.equal(ceilingFor(measured), ceiling, `measured ${measured}`);
  assert.equal(ceilingFor(24505, { doctor: true }), 25536);
});

test('byteCount is UTF-8 length, not characters', () => {
  assert.equal(byteCount('abc'), 3);
  assert.equal(byteCount('é'), 2);
});

test('followupStatement is 172 characters with a numbered prefix', () => {
  assert.equal(followupStatement(7).length, 172);
  assert.ok(followupStatement(7).startsWith('Fixture follow-up 007: x'));
});

test('IC-009 rows are the 31 table rows', () => {
  assert.equal(IC009_ROWS.length, 31);
});

test('normalize maps the fixture root, HOME and repo root, given and real path', () => {
  const fixture = { root: '/tmp/a/repo', home: '/tmp/a/home' };
  const text = `${fixture.root}/x ${fixture.home}/y ${REPO}/z`;
  assert.equal(normalize(text, fixture), '<ROOT>/x <HOME>/y <RUNTIME>/z');
});

test('fixture seeds 200 follow-ups and a checked goal, and a verb measures with no machine path', () => {
  const fixture = buildFixture();
  assert.ok(fs.existsSync(path.join(fixture.root, '.git')));
  const list = measureVerb(fixture, ['followup', '--action', 'list', '--view', 'full', '--json']);
  assert.equal(list.status, 0);
  const items = JSON.parse(list.stdout).items;
  assert.equal(items.length, FOLLOWUP_COUNT);
  assert.ok(!list.stdout.includes(fixture.root) && !list.stdout.includes(fixture.home) && !list.stdout.includes(REPO), 'paths are normalised');
  const goal = runVerb(fixture, ['goal', '--action', 'list', '--json']);
  assert.equal(goal.status, 0);
  assert.ok(goal.stdout.includes('fixture-goal'));
});
