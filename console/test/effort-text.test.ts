'use strict';

// 178 D8: the Console's copy of `effortText` (console/web/derive/effort-text.js) renders every case of the fixture the core test reads
// (test/fixtures/models/effort-text.json) exactly as the core does. The web root is copied beside a {"type":"module"} marker so the ES
// module imports here, as binding-text.test.ts does.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..', '..');
const WEB_ROOT = path.join(__dirname, '..', 'web');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'models', 'effort-text.json'), 'utf8'));
let scratch: string;
let words: any;

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-effort-text-'));
  fs.cpSync(WEB_ROOT, scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
  words = await import(pathToFileURL(path.join(scratch, 'derive', 'effort-text.js')).href);
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('(a) the Console effortText equals every case of the shared fixture, plain and code, as the core does', () => {
  assert.ok(FIXTURE.cases.length > 0);
  const core = require('../../src/runtime/models/effort-text.ts');
  for (const c of FIXTURE.cases) {
    assert.equal(words.effortText(c.plan, { worker: c.worker }), c.text, c.name);
    assert.equal(words.effortText(c.plan, { code: true, worker: c.worker }), c.code, c.name);
    assert.equal(words.effortText(c.plan, { worker: c.worker }), core.effortText(c.plan, { worker: c.worker }), c.name);
  }
});

test('NFR-003: the Console copy holds no harness id as a literal', () => {
  const source = fs.readFileSync(path.join(WEB_ROOT, 'derive', 'effort-text.js'), 'utf8');
  const harnesses = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses;
  for (const { id } of harnesses) assert.doesNotMatch(source, new RegExp(`['"\`]${id}['"\`]`), id);
});
