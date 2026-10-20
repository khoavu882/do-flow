'use strict';

// Feature 095 IC-001/IC-002: review findings record convergence fields, counts and advisories.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const findings = require('../../src/runtime/review/findings.ts');
const gates = require('../../src/runtime/roadmap/gates.ts');

const { validateFindings, countFindings, reviewAdvisories } = findings;
const HEAD = 'a'.repeat(40);
const FIXTURE = path.join(__dirname, '../fixtures/roadmap/findings/schema-1.json');

function record(converged, extra = {}) {
  return {
    schema: 1, row: '095', slug: '095-review-convergence', reviewedHead: HEAD, ...extra,
    seats: [
      { id: 'backend-expert', findings: [{ id: 'A1', severity: 'blocker', locator: 'src/a.ts:1', summary: 'a' }] },
      { id: 'principle-software-engineer', findings: [{ id: 'B1', severity: 'should-fix', locator: 'src/b.ts:2', summary: 'b' }] },
    ],
    converged,
  };
}
const open = (fields = {}) => ({ id: 'C1', from: ['A1'], severity: 'should-fix', locator: 'src/a.ts:1', status: 'open', ...fields });
const errorsOf = (fields, extra) => validateFindings(record([open(fields)], extra)).errors;

test('frozen vocabularies, closed key lists and ROUND_CAP', () => {
  for (const name of ['SEVERITIES', 'DISPOSITIONS', 'ORIGINS', 'VERIFICATIONS', 'ACCEPTED_AS', 'RECORD_KEYS', 'FINDING_FIELDS']) {
    assert.ok(Array.isArray(findings[name]), name);
    assert.ok(Object.isFrozen(findings[name]), name);
  }
  assert.deepEqual(findings.SEVERITIES, ['blocker', 'should-fix', 'note']);
  assert.deepEqual(findings.DISPOSITIONS, ['open', 'fixed', 'refuted', 'user-accepted']);
  assert.deepEqual(findings.ORIGINS, ['introduced', 'pre-existing']);
  assert.deepEqual(findings.VERIFICATIONS, ['confirmed', 'plausible']);
  assert.deepEqual(findings.ACCEPTED_AS, ['intentional', 'not-worth-fixing']);
  assert.deepEqual(findings.RECORD_KEYS, ['schema', 'row', 'slug', 'reviewedHead', 'rounds', 'seats', 'converged']);
  assert.deepEqual(findings.FINDING_FIELDS, ['origin', 'preExistingAt', 'escapedFrom', 'verification', 'verifiedBy', 'bugClass', 'sweep', 'acceptedAs']);
  assert.equal(findings.ROUND_CAP, 3);
});

test('gates.ts re-exports the same validateFindings function object', () => {
  assert.equal(gates.validateFindings, findings.validateFindings);
});

test('FR-008: the schema-1 fixture stays valid with no errors', () => {
  assert.deepEqual(validateFindings(fs.readFileSync(FIXTURE)), { ok: true, errors: [] });
  assert.deepEqual(validateFindings(fs.readFileSync(FIXTURE, 'utf8')), { ok: true, errors: [] });
});

test('FR-008: ad-hoc keys on converged findings stay valid', () => {
  assert.deepEqual(errorsOf({ class: 'race', fix: 'lock it', proof: 'test/a.test.js', followup: 'FU-1' }), []);
});

test('FR-001: origin and preExistingAt', () => {
  assert.deepEqual(errorsOf({ origin: 'pre-existing', preExistingAt: 'b'.repeat(40) }), []);
  assert.deepEqual(errorsOf({ origin: 'introduced' }), []);
  assert.deepEqual(errorsOf({ origin: 'pre-existing' }), ['preExistingAt:C1']);
  assert.deepEqual(errorsOf({ origin: 'pre-existing', preExistingAt: 'xyz' }), ['preExistingAt:C1']);
  assert.deepEqual(errorsOf({ origin: 'introduced', preExistingAt: 'b'.repeat(40) }), ['preExistingAt:C1']);
  assert.deepEqual(errorsOf({ preExistingAt: 'b'.repeat(40) }), ['preExistingAt:C1']);
  assert.deepEqual(errorsOf({ origin: 'legacy' }), ['origin:C1']);
  assert.deepEqual(errorsOf({ origin: null }), ['origin:C1']);
});

test('FR-002: verification and verifiedBy', () => {
  assert.deepEqual(errorsOf({ verification: 'confirmed' }), ['verifiedBy:C1']);
  // A seat that holds a finding listed in `from` cannot verify it.
  assert.deepEqual(errorsOf({ verification: 'confirmed', verifiedBy: 'backend-expert' }), ['verifiedBy:C1']);
  assert.deepEqual(errorsOf({ verification: 'confirmed', verifiedBy: 'principle-software-engineer' }), []);
  assert.deepEqual(errorsOf({ verification: 'confirmed', verifiedBy: '' }), ['verifiedBy:C1']);
  assert.deepEqual(errorsOf({ verification: 'plausible' }), []);
  assert.deepEqual(errorsOf({ verification: 'maybe' }), ['verification:C1']);
  // verifiedBy without verification is allowed: IC-001 only requires it when confirmed.
  assert.deepEqual(errorsOf({ verifiedBy: 'principle-software-engineer' }), []);
});

test('FR-002: unverified blockers are advisories, never errors', () => {
  const rec = record([
    open({ id: 'C1', severity: 'blocker' }),
    open({ id: 'C2', severity: 'blocker', verification: 'plausible' }),
    open({ id: 'C3', severity: 'blocker', verification: 'confirmed', verifiedBy: 'principle-software-engineer' }),
  ]);
  assert.equal(validateFindings(rec).ok, true);
  assert.deepEqual(reviewAdvisories(rec), ['unverified-blocker:C1', 'unverified-blocker:C2']);
});

test('FR-003: bugClass requires sweep and sweep requires bugClass', () => {
  assert.deepEqual(errorsOf({ bugClass: 'unchecked-error', sweep: 'rg -n "catch {}" src' }), []);
  assert.deepEqual(errorsOf({ bugClass: 'unchecked-error' }), ['bugClass:C1']);
  assert.deepEqual(errorsOf({ sweep: 'rg -n x src' }), ['sweep:C1']);
  assert.deepEqual(errorsOf({ bugClass: ' ', sweep: 'rg x' }), ['bugClass:C1']);
  assert.deepEqual(errorsOf({ bugClass: 'c', sweep: '' }), ['sweep:C1']);
});

test('FR-003: an open finding with bugClass is a bug-class-open advisory', () => {
  const rec = record([open({ bugClass: 'c', sweep: 'rg x' })]);
  assert.deepEqual(reviewAdvisories(rec), ['bug-class-open:C1']);
});

test('FR-004: acceptedAs only on user-accepted, from its vocabulary', () => {
  assert.deepEqual(errorsOf({ acceptedAs: 'intentional' }), ['acceptedAs:C1']);
  assert.deepEqual(errorsOf({ status: 'user-accepted', decision: 'DEC-001', acceptedAs: 'not-worth-fixing' }), []);
  assert.deepEqual(errorsOf({ status: 'user-accepted', decision: 'DEC-001', acceptedAs: 'later' }), ['acceptedAs:C1']);
  // Existing errors of the same finding come first.
  assert.deepEqual(errorsOf({ status: 'user-accepted', acceptedAs: 'later' }), ['decision:C1', 'acceptedAs:C1']);
});

test('FR-005: escapedFrom', () => {
  const pre = { origin: 'pre-existing', preExistingAt: 'b'.repeat(40) };
  assert.deepEqual(errorsOf({ ...pre, escapedFrom: '088b' }), []);
  assert.deepEqual(errorsOf({ ...pre, escapedFrom: '088B' }), ['escapedFrom:C1']);
  assert.deepEqual(errorsOf({ ...pre, escapedFrom: '088-B' }), []);
  assert.deepEqual(errorsOf({ ...pre, escapedFrom: '061' }), []);
  assert.deepEqual(errorsOf({ ...pre, escapedFrom: '095' }), ['escapedFrom:C1']);
  assert.deepEqual(errorsOf({ escapedFrom: '061' }), ['escapedFrom:C1']);
  assert.deepEqual(errorsOf({ origin: 'introduced', escapedFrom: '061' }), ['escapedFrom:C1']);
  const rec = record([open({ ...pre, escapedFrom: '061' }), open({ id: 'C2', ...pre })]);
  assert.equal(countFindings(rec).escaped, 1);
  assert.equal(countFindings(rec).pre_existing, 2);
});

test('FR-006: rounds', () => {
  assert.deepEqual(errorsOf({}, { rounds: 0 }), ['rounds']);
  assert.deepEqual(errorsOf({}, { rounds: 1.5 }), ['rounds']);
  assert.deepEqual(errorsOf({}, { rounds: '2' }), ['rounds']);
  assert.deepEqual(errorsOf({}, { rounds: null }), ['rounds']);
  assert.deepEqual(errorsOf({}, { rounds: 1 }), []);
  assert.deepEqual(reviewAdvisories(record([open()], { rounds: 2 })), []);
  assert.deepEqual(reviewAdvisories(record([open()], { rounds: 3 })), ['round-cap:3']);
  assert.deepEqual(reviewAdvisories(record([open()], { rounds: 4 })), ['round-cap:4']);
});

test('the top-level key set stays closed', () => {
  assert.deepEqual(errorsOf({}, { summary: 'x' }), ['keys']);
});

test('new-field errors are appended after the finding\'s existing errors and skip malformed findings', () => {
  const rec = record([
    open({ id: 'C1', from: ['Z9'], origin: 'legacy', sweep: 'rg x' }),
    { id: 'C2', from: ['A1'], severity: 'bad', locator: 'x', status: 'open', origin: 'legacy' },
  ]);
  assert.deepEqual(validateFindings(rec).errors, ['from:C1', 'origin:C1', 'sweep:C1', 'converged']);
});

test('countFindings: null on an invalid record', () => {
  assert.equal(countFindings(record([open({ origin: 'legacy' })])), null);
  assert.equal(countFindings('{broken'), null);
  assert.equal(countFindings(null), null);
});

test('countFindings: exact counts on a record exercising every field', () => {
  const pre = { origin: 'pre-existing', preExistingAt: 'b'.repeat(40) };
  const rec = record([
    open({ id: 'C1', severity: 'blocker', ...pre, escapedFrom: '061', verification: 'confirmed', verifiedBy: 'principle-software-engineer', bugClass: 'k1', sweep: 'rg a' }),
    open({ id: 'C2', severity: 'blocker', status: 'fixed', fixedIn: 'c'.repeat(40), origin: 'introduced', verification: 'plausible', bugClass: 'k1', sweep: 'rg b' }),
    open({ id: 'C3', from: ['B1'], severity: 'should-fix', status: 'refuted', evidence: 'test/b.test.js:3', bugClass: 'k2', sweep: 'rg c' }),
    open({ id: 'C4', from: [], severity: 'note', status: 'user-accepted', decision: 'DEC-007', acceptedAs: 'intentional', ...pre }),
  ], { rounds: 2 });
  assert.deepEqual(validateFindings(rec).errors, []);
  assert.deepEqual(countFindings(rec), {
    task: '095-review-convergence', rounds: 2, seats: 2, seat_findings: 2, converged: 4,
    blocker: 2, should_fix: 1, note: 1, open: 1, fixed: 1, refuted: 1, user_accepted: 1,
    pre_existing: 2, escaped: 1, confirmed: 1, plausible: 1, unverified_blockers: 1, bug_classes: 2,
  });
  assert.deepEqual(countFindings(JSON.stringify(rec)), countFindings(rec));
  assert.deepEqual(countFindings(Buffer.from(JSON.stringify(rec))), countFindings(rec));
  assert.deepEqual(reviewAdvisories(rec), ['bug-class-open:C1', 'unverified-blocker:C2']);
});

test('countFindings: rounds is null when absent', () => {
  assert.equal(countFindings(record([open()])).rounds, null);
});

test('reviewAdvisories: empty for an invalid record; sorted', () => {
  assert.deepEqual(reviewAdvisories(record([open({ severity: 'blocker', origin: 'legacy' })], { rounds: 3 })), []);
  assert.deepEqual(reviewAdvisories('{broken'), []);
  const rec = record([open({ id: 'C9', severity: 'blocker' }), open({ id: 'C1', bugClass: 'k', sweep: 'rg' })], { rounds: 3 });
  assert.deepEqual(reviewAdvisories(rec), ['bug-class-open:C1', 'round-cap:3', 'unverified-blocker:C9']);
});
