'use strict';

// Covers the `rejected` claim status introduced when claim_builder.py was absorbed into claims.js
// (plan task B.3, decision D3 — don't discard working discrimination the Python had).
//
// This exists because that port deliberately LOOSENED a gate and nothing covered it. readiness.js
// blocks on `conflicted` claims only, so splitting contradiction-only claims out of `conflicted`
// into `rejected` means they no longer force BLOCKED. That is the intended behaviour — `conflicted`
// means evidence disagrees and a human must reconcile, `rejected` means the evidence agrees and the
// claim is simply false, which is a settled question, not a dispute — but an unintended widening of
// the same split would silently unblock real conflicts. These tests pin the boundary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClaimsManager } = require('../src/runtime/claims');
const { EvidenceLedger } = require('../src/runtime/evidence-ledger');

/** A ledger plus manager wired together, with one fresh evidence item per requested role. */
function setup() {
  const evidenceLedger = new EvidenceLedger();
  const claims = new ClaimsManager({ evidenceLedger });
  const add = (content) =>
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
  const { ReadinessEngine } = require('../src/runtime/readiness');
  const engine = new ReadinessEngine();

  const build = (kind) => {
    const { claims, add } = setup();
    const contradicting = [add('contradicting observation')];
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
  // `taskId`, not `id` — readiness.js reads taskProfile.taskId and silently falls back to
  // 'default', which finds no claims and reports NEEDS_EVIDENCE instead of BLOCKED.
  const profile = { taskId: 'task_claims', taskClass: 'trivial-edit' };

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
