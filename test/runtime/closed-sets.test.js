'use strict';

/**
 * Proves that five declared closed sets are actually consulted.
 *
 * Each of `RUN_STATES`, `EVIDENCE_STATUSES`, `POLICY_STATUSES`, `RESOLUTION_REASONS` and
 * `DERIVATIONS` was frozen, exported, and read by nothing — not by its own module, not by any test.
 * Every value they govern was written as a bare literal, so each set was documentation that looked
 * like enforcement. Wiring them up is only half the fix: a validator nothing can trigger is the same
 * dead weight in a different costume, so every one of the five is exercised here.
 *
 * Two of the five govern values that only ever appear as literals inside their own module, and no
 * input can reach them. Those are covered structurally instead — by asserting the literals in the
 * source stay inside the set — because that is the threat those two actually face: a typo introduced
 * while editing, not bad data arriving at runtime.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EvidenceLedger } = require('../../src/runtime/evidence-ledger');
const { renderPolicy } = require('../../src/lifecycle/policies');
const { describeResolution, RESOLUTION_REASONS } = require('../../src/runtime/locator-resolve');
const { DERIVATIONS } = require('../../src/runtime/command-detect');
const { RUN_STATES } = require('../../src/runtime/workflow-orchestrator');

const SRC = path.resolve(__dirname, '../../src');

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-closed-sets-'));
}

function writeLedger(stateDir, taskId, evidence) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `${taskId}.json`),
    JSON.stringify({ taskId, updatedAt: new Date().toISOString(), evidenceCount: evidence.length, evidence }, null, 2),
    'utf8',
  );
}

function item(overrides) {
  return {
    id: 'ev_test_1',
    taskId: 't1',
    kind: 'structural',
    provenance: 'extracted',
    locator: { file: 'src/x.js' },
    status: 'active',
    supersededBy: null,
    ...overrides,
  };
}

// ── EVIDENCE_STATUSES ──────────────────────────────────────────────────────────────────────────

test('EVIDENCE_STATUSES: a ledger whose item carries an unknown status is refused, not guessed at', () => {
  const stateDir = tmpStateDir();
  // 'supersede' rather than 'superseded' — the realistic typo, and the dangerous one: read as
  // anything other than superseded, retired evidence re-enters readiness.
  writeLedger(stateDir, 't1', [item({ status: 'supersede' })]);
  const ledger = new EvidenceLedger({ stateDir });

  assert.throws(() => ledger.load('t1'), (err) => {
    assert.match(err.message, /status 'supersede'/, 'names the offending value');
    assert.match(err.message, /ev_test_1/, 'names the item');
    assert.match(err.message, /active, superseded/, 'names the valid set');
    return true;
  });
});

test('EVIDENCE_STATUSES: both declared statuses load without complaint', () => {
  const stateDir = tmpStateDir();
  writeLedger(stateDir, 't2', [
    item({ id: 'ev_a', status: 'active' }),
    item({ id: 'ev_b', status: 'superseded', supersededBy: 'ev_a' }),
  ]);
  const ledger = new EvidenceLedger({ stateDir });
  assert.equal(ledger.load('t2'), 2);
  assert.equal(ledger.getEvidence('ev_b').status, 'superseded', 'a superseded item stays superseded');
});

// ── POLICY_STATUSES ────────────────────────────────────────────────────────────────────────────

test('POLICY_STATUSES: a registry status outside the set is refused rather than reported onward', () => {
  // `mapping.status` is the one value renderPolicy does not compute; it falls through from the
  // registry, which is why it is the one that needed checking.
  const policy = { id: 'p1', intent: 'test', mappings: { h1: { status: 'suported', event: 'e' } }, requires: [] };
  const harness = { id: 'h1', capabilities: {} };

  assert.throws(() => renderPolicy(policy, harness), (err) => {
    assert.match(err.message, /'suported'/, 'names the typo');
    assert.match(err.message, /supported, different, unavailable, prerequisite/, 'names the valid set');
    assert.match(err.message, /registry/, 'points at where to fix it');
    return true;
  });
});

test('POLICY_STATUSES: each declared status resolves', () => {
  const harness = { id: 'h1', capabilities: {} };
  for (const status of ['supported', 'different', 'unavailable']) {
    const policy = { id: 'p1', intent: 'test', mappings: { h1: { status, event: 'e' } }, requires: [] };
    assert.equal(renderPolicy(policy, harness).status, status);
  }
  // 'prerequisite' is computed rather than declared: a mapping with prerequisites becomes one.
  const withPrereq = {
    id: 'p1', intent: 'test', requires: [],
    mappings: { h1: { status: 'supported', event: 'e', prerequisites: ['install something'] } },
  };
  assert.equal(renderPolicy(withPrereq, harness).status, 'prerequisite');
});

// ── RESOLUTION_REASONS ─────────────────────────────────────────────────────────────────────────

test('RESOLUTION_REASONS: a declared reason with no tailored sentence still reads as a fact', () => {
  const message = describeResolution({ file: 'a.js' }, { resolved: false, reason: 'not-checkable' });
  assert.match(message, /did not resolve \(not-checkable\)/);
  assert.doesNotMatch(message, /defect/, 'a reason the resolver defines is not blamed on the resolver');
});

test('RESOLUTION_REASONS: a reason the resolver does not define is named as a defect in the resolver', () => {
  const message = describeResolution({ file: 'a.js' }, { resolved: false, reason: 'file-missng' });
  assert.match(message, /file-missng/, 'shows the unrecognised value');
  assert.match(message, /defect in resolveLocator/, 'attributes it to the resolver, not the file');
  assert.ok(!RESOLUTION_REASONS.has('file-missng'), 'precondition: the reason really is unknown');
});

// ── RUN_STATES (structural) ────────────────────────────────────────────────────────────────────

test('RUN_STATES: every write to run.state goes through the validator', () => {
  // No input can carry a bad run state into this module — every write is a literal in the file — so
  // the threat is an edit adding a sixth write that skips the check. That is a property of the
  // source, and this is where it is enforced.
  const source = fs.readFileSync(path.join(SRC, 'runtime/workflow-orchestrator.js'), 'utf8');

  // `=(?!=)` so the five `run.state === '...'` comparisons are not mistaken for assignments.
  const bare = [...source.matchAll(/run\.state\s*=(?!=)\s*(?!runState\()(\S+)/g)].map((m) => m[0]);
  assert.deepEqual(bare, [], `these writes bypass runState():\n  ${bare.join('\n  ')}`);

  const viaValidator = [...source.matchAll(/runState\('([A-Z_]+)'\)/g)].map((m) => m[1]);
  assert.ok(viaValidator.length >= 6, `expected every state write to be wrapped, found ${viaValidator.length}`);
  const unknown = viaValidator.filter((s) => !RUN_STATES.includes(s));
  assert.deepEqual(unknown, [], `these states are not in RUN_STATES: ${unknown.join(', ')}`);
});

// ── DERIVATIONS (structural) ───────────────────────────────────────────────────────────────────

test('DERIVATIONS: every derivation literal in the detectors is a member of the set', () => {
  // `derivation` is written as a literal at more than twenty sites across the per-language
  // detectors. The runtime check in detectCommands covers whatever a run reaches; this covers every
  // site whether a test exercises that language's detector or not.
  const source = fs.readFileSync(path.join(SRC, 'runtime/command-detect.js'), 'utf8');
  const literals = [...source.matchAll(/derivation:\s*'([a-z-]+)'/g)].map((m) => m[1]);

  assert.ok(literals.length >= 20, `expected the detectors to set derivation many times, found ${literals.length}`);
  const unknown = [...new Set(literals.filter((d) => !DERIVATIONS.includes(d)))];
  assert.deepEqual(unknown, [],
    `these derivations are written in the detectors but are not in DERIVATIONS: ${unknown.join(', ')}`);

  // And the reverse: a set member nothing produces would be a value callers branch on in vain.
  const produced = new Set(literals);
  const neverProduced = DERIVATIONS.filter((d) => !produced.has(d));
  assert.deepEqual(neverProduced, [],
    `DERIVATIONS declares values no detector produces: ${neverProduced.join(', ')}`);
});
