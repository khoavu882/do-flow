'use strict';
// 178 IC-005 (T6): `effortText` renders every case of the shared fixture (the Console copy reads the same file); the
// fixture holds a case for every plan kind, every NoneReason and every SessionReason, read from the exported closed sets,
// so a new reason without a case fails here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { effortText } = require('../../../src/runtime/models/effort-text.ts');
const { NONE_REASONS } = require('../../../src/runtime/worker/effort-resolution.ts');
const { SESSION_REASONS } = require('../../../src/runtime/context/session-effort.ts');

const REPO = path.resolve(__dirname, '../../..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/models/effort-text.json'), 'utf8'));
const HARNESSES = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/harnesses.json'), 'utf8')).harnesses;
const VENDOR_NAMES: string[] = JSON.parse(fs.readFileSync(path.join(REPO, 'test/guards/prompt-frame-sites.json'), 'utf8')).vendorNames;
const ABSOLUTE_PATH = /(?:^|[\s(`;])(?:\/|~\/|[A-Za-z]:\\)/;

/** The design §8.1 row a plan renders through. */
function kindOf(plan: any): string {
  if (plan.source === 'binding') return 'binding';
  if (plan.source === 'session') return plan.mapped ? 'session-mapped' : `session-${plan.check}`;
  return 'none';
}

test('(b) the fixture covers every plan kind, every NoneReason and every SessionReason', () => {
  assert.equal(FIXTURE.schema, 1);
  const kinds = new Set(FIXTURE.cases.map((c: any) => kindOf(c.plan)));
  for (const kind of ['binding', 'session-listed', 'session-unchecked', 'session-mapped', 'none']) assert.ok(kinds.has(kind), kind);
  const none = FIXTURE.cases.filter((c: any) => c.plan.source === 'none');
  for (const reason of NONE_REASONS) assert.ok(none.some((c: any) => c.plan.reason === reason), reason);
  const sessionUnknown = none.filter((c: any) => c.plan.reason === 'session-unknown');
  for (const reason of SESSION_REASONS) assert.ok(sessionUnknown.some((c: any) => c.plan.session.reason === reason), reason);
  for (const c of none) assert.ok(NONE_REASONS.includes(c.plan.reason), `${c.name}: ${c.plan.reason} is not a NoneReason`);
  for (const c of sessionUnknown) assert.ok(SESSION_REASONS.includes(c.plan.session.reason), `${c.name}: ${c.plan.session.reason} is not a SessionReason`);
});

test('(a) effortText equals every fixture case, plain and code', () => {
  for (const c of FIXTURE.cases) {
    assert.equal(effortText(c.plan, { worker: c.worker }), c.text, c.name);
    assert.equal(effortText(c.plan, { code: true, worker: c.worker }), c.code, c.name);
  }
});

test('(c) no rendered text holds a vendor display name or an absolute path', () => {
  const names = [...new Set([...VENDOR_NAMES, ...HARNESSES.map((h: any) => h.displayName)])];
  for (const c of FIXTURE.cases) {
    for (const text of [effortText(c.plan, { worker: c.worker }), effortText(c.plan, { code: true, worker: c.worker })]) {
      for (const name of names) assert.doesNotMatch(text, new RegExp(`\\b${name}\\b`), `${c.name}: ${name}`);
      assert.doesNotMatch(text, ABSOLUTE_PATH, c.name);
    }
  }
});

test('NFR-003: the wording module holds no harness id as a literal', () => {
  const source = fs.readFileSync(path.join(REPO, 'src/runtime/models/effort-text.ts'), 'utf8');
  for (const { id } of HARNESSES) assert.doesNotMatch(source, new RegExp(`['"\`]${id}['"\`]`), id);
});
