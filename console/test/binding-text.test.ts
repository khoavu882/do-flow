'use strict';

// 169 D11: the Console's copy of `bindingText` (console/web/derive/binding-text.js) renders every row of the fixture the core test reads
// (test/fixtures/models/binding-text.json) exactly as the core does. The web root is copied beside a {"type":"module"} marker so the ES
// module imports here, as derive-start.test.ts does.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'models', 'binding-text.json'), 'utf8'));
let scratch: string;
let words: any;

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-binding-text-'));
  fs.cpSync(WEB_ROOT, scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
  words = await import(pathToFileURL(path.join(scratch, 'derive', 'binding-text.js')).href);
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('the Console bindingText equals every row of the shared fixture, plain and code, as the core does', () => {
  assert.ok(FIXTURE.rows.length > 0);
  const core = require('../../src/runtime/models/binding-text.ts');
  for (const row of FIXTURE.rows) {
    assert.equal(words.bindingText(row.cell), row.text, JSON.stringify(row.cell));
    assert.equal(words.bindingText(row.cell, { code: true }), row.code, JSON.stringify(row.cell));
    assert.equal(words.bindingText(row.cell), core.bindingText(row.cell), JSON.stringify(row.cell));
  }
});

test('bindingNotes lists the notes in the core\'s order and nothing for a default, an unresolved cell or a cell without checks', () => {
  assert.deepEqual(words.bindingNotes(null), []);
  assert.deepEqual(words.bindingNotes('unresolved:settings-invalid'), []);
  assert.deepEqual(words.bindingNotes({ model: 'gpt-y', provider: null, effort: null }), []);
  assert.deepEqual(
    words.bindingNotes({ model: 'gpt-y', provider: null, effort: 'low', check: { model: 'several-providers', effort: 'unchecked' }, effortMayLower: true }),
    ['several providers list it', 'effort unchecked', 'the harness may lower the effort'],
  );
  assert.deepEqual(
    words.bindingNotes({ model: 'gpt-y', provider: 'openai', effort: 'low', check: { model: 'listed', effort: 'unchecked', provider: 'unchecked' }, effortMayLower: true }),
    ['provider unchecked', 'effort unchecked', 'the harness may lower the effort'],
  );
  // 169 A-03: a refused cell ends its notes with the refusal, as the core does.
  assert.deepEqual(
    words.bindingNotes({ model: 'gpt-y', provider: 'openai', effort: null, check: { model: 'unchecked', effort: null }, refused: 'provider:unsupported' }),
    ['model unchecked', 'dispatch refuses it (provider:unsupported)'],
  );
});
