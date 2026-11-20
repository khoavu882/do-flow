'use strict';

// G91 — a deferred item's revisit trigger is tied to its design and its docs (row 180 K7, FR-J3).
//   (1) console/DESIGN-v2.md 7.10 names every id `revisits()` reports (`http3-quic`) and each of the values the
//       check reads (TRIGGER_FIELDS: node_use_quic, node:quic, ngtcp2, nghttp3).
//   (2) the doctor row of docs/reference.md names every id `revisits()` reports.
//   (3) control: an injected process holding the trigger values flips `state` to `met`, and dropping any one of
//       them flips it back, so a check that stopped reading a value is caught.
//   Controls for (1) and (2): a planted design section and a planted doctor row that miss one name each are
//   reported by the same functions that read the real files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { revisits, TRIGGER_FIELDS } = require('../../src/runtime/revisits.ts');

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** The text of section 7.10, from its heading to the next heading of the same or a higher level. */
function section710(design: string): string {
  const start = design.indexOf('### 7.10 ');
  if (start === -1) return '';
  const rest = design.slice(start + 1);
  const end = rest.search(/\n#{1,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The doctor row of the reference's verb table. */
function doctorRow(reference: string): string {
  return reference.split('\n').find((line) => line.startsWith('| `doflow doctor [--json]`')) ?? '';
}

/** Each name the design section lacks. */
function missingFromDesign(design: string, ids: string[], fields: string[]): string[] {
  const text = section710(design);
  return [...ids, ...fields].filter((name) => !text.includes(name)).map((name) => `console/DESIGN-v2.md 7.10 does not name '${name}'`);
}

/** Each id the doctor row lacks. */
function missingFromReference(reference: string, ids: string[]): string[] {
  const row = doctorRow(reference);
  return ids.filter((id) => !row.includes(id)).map((id) => `the doctor row of docs/reference.md does not name '${id}'`);
}

const IDS = revisits().map((item: any) => item.id);
const FIELDS = Object.values<string>(TRIGGER_FIELDS);

test('G91 (1): console/DESIGN-v2.md 7.10 names every revisit id and every value the check reads', () => {
  assert.ok(IDS.includes('http3-quic'));
  assert.deepEqual(missingFromDesign(read('console/DESIGN-v2.md'), IDS, FIELDS), []);
});

test('G91 (2): the doctor row of docs/reference.md names every revisit id', () => {
  assert.deepEqual(missingFromReference(read('docs/reference.md'), IDS), []);
});

test('G91 (3): the trigger values flip the state to met, and each one is read', () => {
  const proc = () => ({ version: 'v99.0.0', config: { variables: { node_use_quic: true } }, versions: { ngtcp2: '1', nghttp3: '1' } });
  const state = (p: any, builtin = true) => revisits({ proc: p, isBuiltin: () => builtin })[0].state;
  assert.equal(state(proc()), 'met');
  assert.equal(state(proc(), false), 'not-met');
  for (const key of ['ngtcp2', 'nghttp3']) {
    const p: any = proc();
    delete p.versions[key];
    assert.equal(state(p), 'not-met', key);
  }
  const off: any = proc();
  off.config.variables.node_use_quic = false;
  assert.equal(state(off), 'not-met');
});

test('G91 controls: a design section and a doctor row that miss a name are reported', () => {
  const planted = (drop: string) => `## 7. A\n\n### 7.10 HTTP/3\n\n${['http3-quic', ...FIELDS].filter((n) => n !== drop).join(' ')}\n\n## 8. B\n${drop} appears outside the section\n`;
  assert.deepEqual(missingFromDesign(planted('none'), IDS, FIELDS), []);
  for (const drop of ['http3-quic', ...FIELDS]) {
    assert.deepEqual(missingFromDesign(planted(drop), IDS, FIELDS), [`console/DESIGN-v2.md 7.10 does not name '${drop}'`], drop);
  }
  assert.deepEqual(missingFromDesign('## 7. A\n', IDS, FIELDS).length, IDS.length + FIELDS.length, 'no 7.10 heading at all');
  assert.deepEqual(missingFromReference('| `doflow doctor [--json]` | health `http3-quic` |\n', IDS), []);
  assert.deepEqual(missingFromReference('| `doflow doctor [--json]` | health |\n| `doflow x` | http3-quic |\n', IDS), ["the doctor row of docs/reference.md does not name 'http3-quic'"]);
});
