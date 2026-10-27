'use strict';

// Covers the `rejected` claim status introduced when claim_builder.py was absorbed into claims.js
// (plan task B.3, decision D3 — don't discard working discrimination the Python had).
//
// This exists because that port deliberately LOOSENED a gate and nothing covered it. readiness.ts
// blocks on `conflicted` claims only, so splitting contradiction-only claims out of `conflicted`
// into `rejected` means they no longer force BLOCKED. That is the intended behaviour — `conflicted`
// means evidence disagrees and a human must reconcile, `rejected` means the evidence agrees and the
// claim is simply false, which is a settled question, not a dispute — but an unintended widening of
// the same split would silently unblock real conflicts. These tests pin the boundary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClaimsManager } = require('../../src/runtime/claims.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');

/** A ledger plus manager wired together, with one fresh evidence item per requested role. */
function setup() {
  const evidenceLedger: any = new EvidenceLedger();
  const claims: any = new ClaimsManager({ evidenceLedger });
  const add = (content: any) =>
    evidenceLedger.addEvidence({
      taskId: 'task_claims',
      kind: 'exact-search',
      content,
      locator: { file: 'src/example.js' },
      source: { provider: 'native.rg', capability: 'code.exact-search' },
    });
  return { evidenceLedger, claims, add };
}

test('a claim with only contradicting evidence is rejected, not conflicted', () => {
  const { claims, add } = setup();
  const against = add('the function is never called');
  const id = claims.addClaim({
    taskId: 'task_claims',
    statement: 'AuthService is called by TransactionService',
    contradictingEvidence: [against],
  });
  claims.evaluateClaim(id);
  const claim = claims.getClaim(id);
  assert.equal(claim.status, 'rejected',
    'contradiction with no support is a settled falsehood, not a dispute');
});

test('a claim with both support and contradiction stays conflicted', () => {
  const { claims, add } = setup();
  const id = claims.addClaim({
    taskId: 'task_claims',
    statement: 'AuthService is called by TransactionService',
    supportingEvidence: [add('call site at line 42')],
    contradictingEvidence: [add('the function is never called')],
  });
  claims.evaluateClaim(id);
  assert.equal(claims.getClaim(id).status, 'conflicted',
    'genuine disagreement must remain conflicted so the readiness gate still blocks on it');
});

test('conflicted claims block readiness; rejected claims do not', () => {
  const { ReadinessEngine } = require('../../src/runtime/readiness.ts');
  const engine: any = new ReadinessEngine();

  const build = (kind: any) => {
    const { claims, add } = setup();
    const contradicting: any = [add('contradicting observation')];
    const supportingEvidence = kind === 'conflicted' ? [add('supporting observation')] : [];
    const cid = claims.addClaim({
      taskId: 'task_claims',
      statement: 'the subject behaves as described',
      supportingEvidence,
      contradictingEvidence: contradicting,
    });
    claims.evaluateClaim(cid);
    return claims;
  };

  const conflicted = build('conflicted');
  const rejected = build('rejected');
  // `taskId`, not `id` — readiness.ts reads taskProfile.taskId and silently falls back to
  // 'default', which finds no claims and reports NEEDS_EVIDENCE instead of BLOCKED.
  const profile: any = { taskId: 'task_claims', taskClass: 'trivial-edit' };

  const conflictedResult = engine.evaluateReadiness(profile, new EvidenceLedger(), conflicted);
  assert.equal(conflictedResult.state, 'BLOCKED',
    'an unresolved contradiction must still stop work');

  const rejectedResult = engine.evaluateReadiness(profile, new EvidenceLedger(), rejected);
  assert.notEqual(rejectedResult.state, 'BLOCKED',
    'a claim shown false is answered, not disputed — it must not hold the gate shut');
});

test('support that has merely gone stale still counts as support', () => {
  // Guards the narrow condition in the promotion logic: `rejected` is keyed on there being NO
  // supporting evidence at all, not on the support being fresh. A claim that once had backing is
  // disputed, not disproven, and must not be downgraded to `rejected` on a technicality.
  const { evidenceLedger, claims, add } = setup();
  const supporting = add('call site at line 42');
  const contradicting = add('the function is never called');
  const id = claims.addClaim({
    taskId: 'task_claims',
    statement: 'AuthService is called by TransactionService',
    supportingEvidence: [supporting],
    contradictingEvidence: [contradicting],
  });

  const stale = evidenceLedger.getEvidence(supporting);
  stale.freshness = { ...(stale.freshness || {}), status: 'STALE' };
  claims.evaluateClaim(id);

  assert.notEqual(claims.getClaim(id).status, 'rejected',
    'stale support is still support — the claim is conflicted, not disproven');
});

test('UNKNOWN-only support gives hypothesis (IC-017)', () => {
  const { evidenceLedger, claims, add } = setup();
  const id1 = add('unknown finding');
  const ev1 = evidenceLedger.getEvidence(id1);
  ev1.freshness = { ...(ev1.freshness || {}), status: 'UNKNOWN' };

  const cid = claims.addClaim({
    taskId: 'task_claims',
    statement: 'claim backed only by unknown index',
    supportingEvidence: [id1],
  });
  claims.evaluateClaim(cid);
  assert.equal(claims.getClaim(cid).status, 'hypothesis');
});

test('FRESH plus UNKNOWN support gives supported (IC-017)', () => {
  const { evidenceLedger, claims, add } = setup();
  const idFresh = add('fresh finding');
  const idUnknown = add('unknown finding');
  evidenceLedger.getEvidence(idUnknown).freshness = { status: 'UNKNOWN' };

  const cid = claims.addClaim({
    taskId: 'task_claims',
    statement: 'claim backed by fresh and unknown',
    supportingEvidence: [idFresh, idUnknown],
  });
  claims.evaluateClaim(cid);
  assert.equal(claims.getClaim(cid).status, 'supported');
});

test('STALE support gives invalidated (IC-017)', () => {
  const { evidenceLedger, claims, add } = setup();
  const idStale = add('stale finding');
  evidenceLedger.getEvidence(idStale).freshness = { status: 'STALE' };

  const cid = claims.addClaim({
    taskId: 'task_claims',
    statement: 'claim backed only by stale evidence',
    supportingEvidence: [idStale],
  });
  claims.evaluateClaim(cid);
  assert.equal(claims.getClaim(cid).status, 'invalidated');
});

test('an UNKNOWN contradiction gives conflicted with support and hypothesis without, never rejected (IC-017, DEC-016)', () => {
  const { evidenceLedger, claims, add } = setup();
  const idContra = add('unknown contradiction');
  evidenceLedger.getEvidence(idContra).freshness = { status: 'UNKNOWN' };

  // Without support -> hypothesis, never rejected
  const cidWithout = claims.addClaim({
    taskId: 'task_claims',
    statement: 'claim with only unknown contradiction',
    contradictingEvidence: [idContra],
  });
  claims.evaluateClaim(cidWithout);
  assert.equal(claims.getClaim(cidWithout).status, 'hypothesis', 'never rejected');

  // With support -> conflicted
  const idSupport = add('supporting finding');
  const cidWith = claims.addClaim({
    taskId: 'task_claims',
    statement: 'claim with support and unknown contradiction',
    supportingEvidence: [idSupport],
    contradictingEvidence: [idContra],
  });
  claims.evaluateClaim(cidWith);
  assert.equal(claims.getClaim(cidWith).status, 'conflicted');
});
