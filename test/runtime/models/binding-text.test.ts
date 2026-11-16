'use strict';
// 169 IC-005 (T2): `bindingText` renders every row of the shared fixture (the Console copy reads the same file), and
// `bindingCell` builds the JSON cell one way for every surface.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bindingText, bindingCell } = require('../../../src/runtime/models/binding-text.ts');

const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../fixtures/models/binding-text.json'), 'utf8'));

test('the fixture is schema 1 and covers the notes of design 7', () => {
  assert.equal(FIXTURE.schema, 1);
  const texts = FIXTURE.rows.map((r: any) => r.text).join('\n');
  for (const note of ['model unchecked', 'not in the list', 'several providers list it', 'effort unchecked', 'effort not offered by the model', 'the harness may lower the effort', 'harness default', 'unresolved']) {
    assert.ok(texts.includes(note), note);
  }
});

test('bindingText equals every fixture row, plain and code', () => {
  for (const row of FIXTURE.rows) {
    assert.equal(bindingText(row.cell), row.text, JSON.stringify(row.cell));
    assert.equal(bindingText(row.cell, { code: true }), row.code, JSON.stringify(row.cell));
  }
});

test('bindingText of a cell without a check block carries no notes', () => {
  assert.equal(bindingText({ model: 'gpt-y', provider: null, effort: null }), 'gpt-y');
});

test('bindingCell builds the IC-005 cell and the may-lower flag only for a bound effort', () => {
  const choice = { model: 'gpt-y', provider: 'openai', effort: 'low' };
  assert.deepEqual(bindingCell(choice, { model: 'listed', effort: 'unchecked' }), {
    model: 'gpt-y', provider: 'openai', effort: 'low', check: { model: 'listed', effort: 'unchecked' },
  });
  assert.deepEqual(bindingCell(choice, { model: 'listed', effort: 'unchecked' }, { effortMayLower: true }), {
    model: 'gpt-y', provider: 'openai', effort: 'low', check: { model: 'listed', effort: 'unchecked' }, effortMayLower: true,
  });
  const noEffort = bindingCell({ model: 'gpt-y', provider: null, effort: null }, { model: 'unchecked', effort: null }, { effortMayLower: true });
  assert.deepEqual(noEffort, { model: 'gpt-y', provider: null, effort: null, check: { model: 'unchecked', effort: null } });
  assert.equal(bindingCell(null, { model: 'unchecked', effort: null }), null);
  // Every fixture cell round-trips through the builder and renders to its row.
  for (const row of FIXTURE.rows.filter((r: any) => r.cell && typeof r.cell === 'object')) {
    const c = row.cell;
    const built = bindingCell({ model: c.model, provider: c.provider, effort: c.effort }, c.check, { effortMayLower: c.effortMayLower === true });
    assert.deepEqual(built, c);
    assert.equal(bindingText(built), row.text);
  }
});
