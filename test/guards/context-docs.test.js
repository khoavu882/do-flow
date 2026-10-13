'use strict';

// IC-023 — reader-facing context delivery docs stay aligned with the compiler contract.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIELD_CLASSES } = require('../../src/runtime/context/compose.ts');

const REPO = path.resolve(__dirname, '../..');
const SPEC_PATH = 'docs/specs/orchestrator-context-modes.md';
const REFERENCE_PATH = 'docs/reference.md';
const SKILL_PATHS = [
  'core/shared/skills/do-design/SKILL.md',
  'core/shared/skills/do-plan/SKILL.md',
  'core/shared/skills/do-execute-plan/SKILL.md',
  'core/shared/skills/do-implement/SKILL.md',
];
const OVERFLOW_CLAUSE = 'exit 3 means overflow: the pack is complete, act on `overflowAction.message` and report the gap.';

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO, relativePath), 'utf8');
}

function classificationRows(markdown, sourceName) {
  const sectionStart = markdown.indexOf('### Classification table');
  assert.notEqual(sectionStart, -1, `${sourceName}: missing classification table heading`);
  const table = markdown.slice(sectionStart).split('\n').filter((line) => line.startsWith('|'));
  assert.ok(table.length >= 3, `${sourceName}: classification table is missing rows`);
  const headers = table[0].split('|').slice(1, -1).map((cell) => cell.trim());
  for (const header of ['Field', 'Class', 'Optional priority', 'Item id']) {
    assert.ok(headers.includes(header), `${sourceName}: classification table missing '${header}' column`);
  }
  return table.slice(2).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  });
}

function assertClassificationMatches(markdown, sourceName) {
  const rows = classificationRows(markdown, sourceName);
  assert.equal(rows.length, FIELD_CLASSES.length, `${sourceName}: classification row count differs from FIELD_CLASSES`);
  for (let i = 0; i < FIELD_CLASSES.length; i += 1) {
    const expected = FIELD_CLASSES[i];
    const actual = rows[i];
    assert.equal(actual.Field, expected.field, `${sourceName}: classification field mismatch at row ${i + 1}`);
    assert.equal(actual.Class, expected.cls, `${sourceName}: classification for '${expected.field}' differs from FIELD_CLASSES`);
    assert.equal(actual['Optional priority'], String(expected.optionalPriority), `${sourceName}: optional priority for '${expected.field}' differs from FIELD_CLASSES`);
    assert.equal(actual['Item id'].replaceAll('`', ''), expected.itemId, `${sourceName}: item id for '${expected.field}' differs from FIELD_CLASSES`);
  }
}

function assertNoOverflowDowngrade(markdown, sourceName) {
  assert.doesNotMatch(
    markdown,
    /full\s*→\s*delta\s*→\s*pointer\s*→\s*bare|downgrade(?:s|d)?\s+(?:the\s+)?(?:context\s+)?(?:mode|pack)|overflow.{0,80}downgrade/i,
    `${sourceName}: spec contains a downgrade-on-overflow rule`
  );
}

function referenceContextPackRow(markdown) {
  const row = markdown.split('\n').find((line) => line.startsWith('| `doflow context-pack '));
  assert.ok(row, 'reference: missing context-pack row');
  for (const flag of ['--task-id', '--slug', '--task-class', '--objective', '--json', '--harness', '--max-bytes', '--mandatory-file', '--since', '--expand', '--reason', '--bare', '--no-record', '-g']) {
    assert.ok(row.includes(flag), `reference: context-pack row missing IC-001 flag '${flag}'`);
  }
  for (const status of ['0 (`OK`)', '1 (`EMPTY`)', '2 (`USAGE`)', '3 (`OVERFLOW`)']) {
    assert.ok(row.includes(status), `reference: context-pack row missing IC-002 status ${status}`);
  }
  const link = row.match(/\[classification table\]\(([^)]+)\)/);
  assert.ok(link, 'reference: context-pack row must link the classification table');
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(REFERENCE_PATH), link[1].split('#')[0]));
  assert.equal(target, SPEC_PATH, `reference: classification table link must target ${SPEC_PATH}`);
  return target;
}

test('IC-023 context docs keep the spec and linked reference classification table equal to FIELD_CLASSES', () => {
  const spec = readRepoFile(SPEC_PATH);
  const target = referenceContextPackRow(readRepoFile(REFERENCE_PATH));
  assertClassificationMatches(spec, 'context modes spec');
  // The reference entry links to this table; validate the target through the reference link itself.
  assertClassificationMatches(readRepoFile(target), 'reference classification link');
});

test('IC-022 all calling skills describe exit 3 overflow action', () => {
  for (const skillPath of SKILL_PATHS) {
    const normalized = readRepoFile(skillPath).replaceAll('**', '').replace(/\s+/g, ' ');
    assert.ok(normalized.includes(OVERFLOW_CLAUSE), `${skillPath}: missing required exit 3 clause`);
  }
});

test('IC-021 context modes spec has no downgrade-on-overflow rule', () => {
  assertNoOverflowDowngrade(readRepoFile(SPEC_PATH), 'context modes spec');
});

test('IC-023 negative control: re-adding downgrade rule to a spec copy is detected', () => {
  const changed = `${readRepoFile(SPEC_PATH)}\n\nOn overflow, downgrade full → delta → pointer → bare.\n`;
  assert.throws(() => assertNoOverflowDowngrade(changed, 'spec copy'), /downgrade-on-overflow rule/);
});

test('IC-023 negative control: reclassifying a table field fails and names the field', () => {
  const changed = readRepoFile(SPEC_PATH).replace(
    '| objective | mandatory | n/a | objective |',
    '| objective | optional | n/a | objective |'
  );
  assert.notEqual(changed, readRepoFile(SPEC_PATH), 'control must change the objective classification');
  assert.throws(
    () => assertClassificationMatches(changed, 'changed spec copy'),
    /classification for 'objective' differs from FIELD_CLASSES/
  );
});
