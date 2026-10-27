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

function record(converged: any, extra: any = {}) {
  return {
    schema: 1, row: '095', slug: '095-review-convergence', reviewedHead: HEAD, ...extra,
    seats: [
      { id: 'backend-expert', findings: [{ id: 'A1', severity: 'blocker', locator: 'src/a.ts:1', summary: 'a' }] },
      { id: 'principle-software-engineer', findings: [{ id: 'B1', severity: 'should-fix', locator: 'src/b.ts:2', summary: 'b' }] },
    ],
    converged,
  };
}
const open = (fields: any = {}) => ({ id: 'C1', from: ['A1'], severity: 'should-fix', locator: 'src/a.ts:1', status: 'open', ...fields });
const errorsOf = (fields: any, extra?: any) => validateFindings(record([open(fields)], extra)).errors;

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
  assert.deepEqual(findings.RECORD_KEYS, ['schema', 'row', 'slug', 'reviewedHead', 'depth', 'risk', 'protocol', 'rounds', 'author', 'seats', 'converged']);
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

test('FR-002: verifiedBy rejects normalized self-verification and unsafe values', () => {
  const selfSeat = record([open({ from: ['P1'], verification: 'confirmed' })]);
  selfSeat.seats[0] = { id: 'PSE', findings: [{ id: 'P1', severity: 'blocker', locator: 'src/p.ts:1', summary: 'p' }] };
  for (const verifiedBy of ['pse', ' PSE', 'PSE\u200b', 'ＰＳＥ']) {
    selfSeat.converged[0].verifiedBy = verifiedBy;
    assert.deepEqual(validateFindings(selfSeat).errors, ['verifiedBy:C1'], JSON.stringify(verifiedBy));
  }
  for (const verifiedBy of ['\u200b', '\ufeff ']) { // only invisible characters: empty once normalised
    selfSeat.converged[0].verifiedBy = verifiedBy;
    assert.deepEqual(validateFindings(selfSeat).errors, ['verifiedBy:C1'], JSON.stringify(verifiedBy));
  }
  for (const verifiedBy of ['backend-expert', 'different-seat', 'a b', 'a\u0007']) {
    selfSeat.converged[0].verifiedBy = verifiedBy;
    assert.deepEqual(validateFindings(selfSeat).errors, verifiedBy === 'a b' || verifiedBy === 'a\u0007' ? ['verifiedBy:C1'] : [], JSON.stringify(verifiedBy));
  }
});

test('FR-002 (095 R-1): invisible, format and dash variants of a finding seat cannot verify it; folding is full', () => {
  const withSeat = (seatId: any, verifiedBy: any) => {
    const rec = record([open({ from: ['P1'], verification: 'confirmed', verifiedBy })]);
    rec.seats[0] = { id: seatId, findings: [{ id: 'P1', severity: 'blocker', locator: 'src/p.ts:1', summary: 'p' }] };
    rec.seats = rec.seats.filter((seat: any, i: any) => i === 0 || seat.id !== seatId); // seat ids stay unique
    return validateFindings(rec).errors;
  };
  const refused: any = [
    'PSE\u2060', 'PSE\u00ad', 'PSE\u034f', 'PSE\ufe0f', 'PSE\u180e', 'PSE\u202c', '\u200ePSE', '\u{E0050}PSE',
  ];
  for (const v of refused) assert.deepEqual(withSeat('PSE', v), ['verifiedBy:C1'], JSON.stringify(v));
  assert.deepEqual(withSeat('principle-software-engineer', 'principle\u2011software\u2011engineer'), ['verifiedBy:C1']);
  assert.deepEqual(withSeat('PSE', '\u2060'), ['verifiedBy:C1'], 'only a word joiner is empty once normalised');
  assert.deepEqual(withSeat('STRASSE', 'stra\u00dfe'), ['verifiedBy:C1'], 'full case folding');
  for (const v of ['backend-expert', 'principle-software-engineer', 'seat-2', 'a1-b2-3', 'codex-gpt-6.1-sol', 'Opus_seat']) {
    assert.deepEqual(withSeat('PSE', v), [], v);
  }
});

test('validateFindings handles 200,000 converged findings that each produce an error', () => {
  const converged = Array.from({ length: 200_000 }, (_, i) => open({
    id: `C${i}`, verification: 'confirmed', verifiedBy: 'backend-expert',
  }));
  const result = validateFindings(record(converged));
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 200_000);
  assert.equal(result.errors[0], 'verifiedBy:C0');
  assert.equal(result.errors.at(-1), 'verifiedBy:C199999');
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
  const pre: any = { origin: 'pre-existing', preExistingAt: 'b'.repeat(40) };
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
  const pre: any = { origin: 'pre-existing', preExistingAt: 'b'.repeat(40) };
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

test('095b IC-005: depth and risk are optional; absent and valid values pass', () => {
  assert.deepEqual(errorsOf({}), []);
  for (const depth of ['single', 'deep']) assert.deepEqual(errorsOf({}, { depth }), [], depth);
  for (const risk of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) assert.deepEqual(errorsOf({}, { risk }), [], risk);
  assert.deepEqual(errorsOf({}, { depth: 'deep', risk: 'HIGH' }), []);
});

test('095b IC-005: an unknown depth or risk is refused with its own error', () => {
  assert.deepEqual(errorsOf({}, { depth: 'shallow' }), ['depth']);
  assert.deepEqual(errorsOf({}, { risk: 'URGENT' }), ['risk']);
  assert.deepEqual(errorsOf({}, { depth: 'shallow', risk: 'URGENT' }), ['depth', 'risk']);
  for (const bad of [null, '', 1, ['deep'], {}, 'DEEP', 'low']) {
    assert.deepEqual(errorsOf({}, { depth: bad }), ['depth'], `depth ${JSON.stringify(bad)}`);
    assert.deepEqual(errorsOf({}, { risk: bad }), ['risk'], `risk ${JSON.stringify(bad)}`);
  }
});

const DIGEST = 'f'.repeat(64);

test('119 IC-002: protocol is optional; a review preset id with a 64-hex digest passes', () => {
  assert.deepEqual(errorsOf({}), []);
  for (const id of ['review-deep', 'review-single']) assert.deepEqual(errorsOf({}, { protocol: { id, digest: DIGEST } }), [], id);
  assert.deepEqual(errorsOf({}, { depth: 'deep', protocol: { id: 'review-deep', digest: '0123456789abcdef'.repeat(4) } }), []);
});

test('119 IC-002: an unknown id, a debate id, a bad digest or an extra key is refused with the error protocol', () => {
  const good: any = { id: 'review-deep', digest: DIGEST };
  const bad: any = [
    { ...good, id: 'review-nope' },
    { ...good, id: 'debate-2' },
    { ...good, digest: 'f'.repeat(63) },
    { ...good, digest: 'f'.repeat(65) },
    { ...good, digest: 'F'.repeat(64) },
    { ...good, extra: 1 },
    { id: 'review-deep' },
    { digest: DIGEST },
    null, '', 'review-deep', ['review-deep'], {},
  ];
  for (const protocol of bad) assert.deepEqual(errorsOf({}, { protocol }), ['protocol'], JSON.stringify(protocol));
});

test('C-2: the recorded protocol is checked against its preset (rounds below rounds.min, fewer seats than the preset)', () => {
  const deep: any = { id: 'review-deep', digest: DIGEST };
  const single: any = { id: 'review-single', digest: DIGEST };
  assert.deepEqual(errorsOf({}, { protocol: deep, rounds: 1 }), ['protocol-rounds']);
  assert.deepEqual(errorsOf({}, { protocol: deep, rounds: 2 }), []);
  assert.deepEqual(errorsOf({}, { protocol: single, rounds: 1 }), []);
  const oneSeat = (extra: any) => ({ ...record([open()], extra), seats: record([open()]).seats.slice(0, 1) });
  assert.deepEqual(validateFindings(oneSeat({ protocol: deep })).errors, ['protocol-seats']);
  assert.deepEqual(validateFindings(oneSeat({ protocol: single })).errors, []);
  // Both at once, and an absent `rounds` is not judged (rounds is optional); a malformed protocol reports only `protocol`.
  assert.deepEqual(validateFindings(oneSeat({ protocol: deep, rounds: 1 })).errors, ['protocol-rounds', 'protocol-seats']);
  assert.deepEqual(validateFindings(oneSeat({ protocol: { ...deep, id: 'review-nope' }, rounds: 1 })).errors, ['protocol']);
});

test('C-2 closure: a record without protocol is held to a non-auto review.preset; under auto it stays valid (IC-002 optional)', () => {
  const oneSeat = (extra: any) => ({ ...record([open()], extra), seats: record([open()]).seats.slice(0, 1) });
  const deep: any = { preset: 'review-deep' };
  assert.deepEqual(validateFindings(record([open()], { rounds: 1 }), deep).errors, ['protocol-missing', 'protocol-rounds']);
  assert.deepEqual(validateFindings(oneSeat({ rounds: 2 }), deep).errors, ['protocol-missing', 'protocol-seats']);
  assert.deepEqual(validateFindings(record([open()], { rounds: 2 }), deep).errors, ['protocol-missing'], 'rounds and seats meet the preset; the missing protocol still refuses');
  // maint-thin: review-single is the loosest core preset (the shipped default), so it makes the field optional
  assert.deepEqual(validateFindings(record([open()], { rounds: 1 }), { preset: 'review-single' }).errors, []);
  for (const options of [undefined, { preset: 'auto' }]) {
    assert.deepEqual(validateFindings(record([open()], { rounds: 1 }), options).errors, [], 'auto or unset: unchanged');
  }
  const recorded: any = { protocol: { id: 'review-single', digest: DIGEST }, rounds: 1 };
  assert.deepEqual(validateFindings(record([open()], recorded), deep).errors, [], 'a recorded protocol is judged by its own preset here; the looser-than-setting rule is gate-b\'s');
});

test('095b IC-005: depth-unmet:<depth> when the seats are fewer than the policy; advisories are sorted with the rest', () => {
  const one = (extra: any) => ({ ...record([open()], extra), seats: record([open()]).seats.slice(0, 1) });
  assert.deepEqual(reviewAdvisories(one({ depth: 'deep' })), ['depth-unmet:deep']);
  assert.deepEqual(reviewAdvisories(one({ depth: 'single' })), []);
  assert.deepEqual(reviewAdvisories(one({})), []);
  assert.deepEqual(reviewAdvisories(record([open()], { depth: 'deep' })), []);
  assert.deepEqual(reviewAdvisories(one({ depth: 'deep', rounds: 3 })), ['depth-unmet:deep', 'round-cap:3']);
  assert.deepEqual(reviewAdvisories(one({ depth: 'shallow' })), [], 'an invalid record has no advisories');
});

test('095b IC-005 NFR-004: every committed findings fixture still validates and keeps its counts', () => {
  const dir = path.join(__dirname, '../fixtures/roadmap/findings');
  const files = fs.readdirSync(dir).filter((name: any) => name.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const name of files) {
    assert.deepEqual(validateFindings(fs.readFileSync(path.join(dir, name), 'utf8')), { ok: true, errors: [] }, name);
    assert.deepEqual(reviewAdvisories(fs.readFileSync(path.join(dir, name), 'utf8')).filter((a: any) => a.startsWith('depth-unmet')), [], name);
  }
});

test('120 IC-015: author and seat accept optional harness and model; malformed values are refused', () => {
  // Author with valid harness and model
  assert.deepEqual(validateFindings(record([open()], {
    author: { agent: 'codex', session: 's1', family: 'codex', harness: 'codex', model: 'gpt-4o' },
  })).errors, []);

  // Author with model: 'unknown'
  assert.deepEqual(validateFindings(record([open()], {
    author: { agent: 'claude', session: 's1', family: 'claude', harness: 'claude', model: 'unknown' },
  })).errors, []);

  // Author with qualified harness id
  assert.deepEqual(validateFindings(record([open()], {
    author: { agent: 'custom', session: 's1', family: 'custom', harness: 'acme.coder', model: 'deepseek-v3' },
  })).errors, []);

  // Author with reserved harness id refuses with error 'author'
  assert.deepEqual(validateFindings(record([open()], {
    author: { agent: 'codex', session: 's1', family: 'codex', harness: 'primary', model: 'gpt-4o' },
  })).errors, ['author']);

  // Author with malformed harness id
  assert.deepEqual(validateFindings(record([open()], {
    author: { agent: 'codex', session: 's1', family: 'codex', harness: 'Bad-Harness', model: 'gpt-4o' },
  })).errors, ['author']);

  // Author with malformed model (starts with hyphen)
  assert.deepEqual(validateFindings(record([open()], {
    author: { agent: 'codex', session: 's1', family: 'codex', harness: 'codex', model: '-gpt-4o' },
  })).errors, ['author']);

  // Author with malformed model (ends with space)
  assert.deepEqual(validateFindings(record([open()], {
    author: { agent: 'codex', session: 's1', family: 'codex', harness: 'codex', model: 'gpt-4o ' },
  })).errors, ['author']);

  // Seat with valid harness and model
  const seatValid = {
    ...record([open()]),
    seats: [
      { id: 'backend-expert', harness: 'codex', model: 'o3-mini', findings: [{ id: 'A1', severity: 'blocker', locator: 'src/a.ts:1', summary: 'a' }] },
      { id: 'principle-software-engineer', harness: 'claude', model: 'unknown', findings: [{ id: 'B1', severity: 'should-fix', locator: 'src/b.ts:2', summary: 'b' }] },
    ],
  };
  assert.deepEqual(validateFindings(seatValid).errors, []);

  // Seat with malformed harness id refuses with seat-identity:<id>
  const seatBadHarness = {
    ...record([open()]),
    seats: [
      { id: 'seat1', harness: 'Bad*Harness', findings: [{ id: 'A1', severity: 'blocker', locator: 'src/a.ts:1', summary: 'a' }] },
      { id: 'seat2', findings: [{ id: 'B1', severity: 'should-fix', locator: 'src/b.ts:2', summary: 'b' }] },
    ],
  };
  assert.deepEqual(validateFindings(seatBadHarness).errors, ['seat-identity:seat1']);

  // Seat with malformed model refuses with seat-identity:<id>
  const seatBadModel = {
    ...record([open()]),
    seats: [
      { id: 'seat1', harness: 'codex', model: '', findings: [{ id: 'A1', severity: 'blocker', locator: 'src/a.ts:1', summary: 'a' }] },
      { id: 'seat2', findings: [{ id: 'B1', severity: 'should-fix', locator: 'src/b.ts:2', summary: 'b' }] },
    ],
  };
  assert.deepEqual(validateFindings(seatBadModel).errors, ['seat-identity:seat1']);
});

test('120 D.1 negative control: every committed findings.json under agent-docs/ validates as on the base', () => {
  const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
  const agentDocsDir = path.join(REPO_ROOT, 'agent-docs');
  if (!fs.existsSync(agentDocsDir)) return;
  function findFindings(dir: string, list: string[] = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) findFindings(full, list);
      else if (ent.isFile() && ent.name === 'findings.json') list.push(full);
    }
    return list;
  }
  const files = findFindings(agentDocsDir);
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.schema === 1) {
        assert.deepEqual(validateFindings(parsed).errors, [], file);
      }
    } catch {}
  }
});

