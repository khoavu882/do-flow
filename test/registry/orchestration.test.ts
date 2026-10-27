'use strict';
// 074 IC-026: the `orchestration` block of core/registry/harnesses.json and its validator. Each
// finding the validator reports has one failing case here, built from an in-memory copy of the
// shipped registry so a regression in the validator cannot hide behind a file edit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadRegistry, validateRegistry, validateOrchestration, ORCHESTRATION_STATUS, ORCHESTRATION_OPS,
} = require('../../src/registry/index.ts');

const REPO = path.resolve(__dirname, '../..');

/** A fresh copy of the shipped registry whose first harness is claude, with a mutation applied. */
function mutated(mutate: any) {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(registry.harnesses[0].orchestration, registry.harnesses[0]);
  return validateRegistry(registry, { repoRoot: REPO });
}

function assertReports(result: any, pattern: any) {
  assert.equal(result.ok, false, 'the mutated registry must be rejected');
  assert.match(result.errors.join('\n'), pattern);
}

test('orchestration: the shipped registry declares the block on all seven harnesses and validates', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.equal(registry.harnesses.length, 7);
  for (const harness of registry.harnesses) {
    assert.deepEqual(Object.keys(harness.orchestration), ORCHESTRATION_OPS, `${harness.id} operation keys`);
  }
  assert.deepEqual(ORCHESTRATION_OPS, ['spawn', 'wait', 'status', 'cancel', 'resume', 'nest']);
  assert.deepEqual([...ORCHESTRATION_STATUS], ['supported', 'unsupported', 'unknown']);
});

test('orchestration: nest (118 IC-004) carries the recorded status and fallback per harness', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const nest = Object.fromEntries(registry.harnesses.map((h: any) => [h.id, h.orchestration.nest]));
  for (const id of ['claude', 'antigravity', 'copilot']) assert.equal(nest[id].status, 'supported', `${id} nest`);
  for (const id of ['pi']) {
    assert.equal(nest[id].status, 'unsupported', `${id} nest`);
    assert.equal(nest[id].fallback, 'sequential', `${id} nest fallback`);
    assert.ok(nest[id].evidence.length > 0, `${id} nest evidence`);
  }
  for (const id of ['codex', 'opencode', 'kiro']) {
    assert.equal(nest[id].status, 'unknown', `${id} nest`);
    assert.equal(nest[id].fallback, 'sequential', `${id} nest fallback`);
    assert.match(nest[id].reason, /vendor docs silent/, `${id} nest reason`);
  }
  for (const harness of registry.harnesses) assert.equal(harness.orchestration.nest.verifiedOn, '2026-10-23', `${harness.id} nest verifiedOn`);
});

test('orchestration: a harness without the block is reported', () => {
  assertReports(mutated((_block: any, harness: any) => { delete harness.orchestration; }), /harness 'claude': orchestration block is required/);
});

test('orchestration: a missing operation key is reported', () => {
  assertReports(mutated((block: any) => { delete block.resume; }), /missing operation 'resume'/);
});

test('orchestration: a missing nest operation is reported', () => {
  assertReports(mutated((block: any) => { delete block.nest; }), /orchestration is missing operation 'nest'/);
});

test('orchestration: an extra operation key is reported', () => {
  assertReports(mutated((block: any) => { block.pause = structuredClone(block.spawn); }), /unknown operation 'pause'/);
});

test('orchestration: a status outside the set is reported', () => {
  assertReports(mutated((block: any) => { block.spawn.status = 'different'; }), /orchestration 'spawn': status must be supported, unsupported, or unknown/);
});

test('orchestration: non-string evidence is reported', () => {
  assertReports(mutated((block: any) => { block.wait.evidence = [42]; }), /orchestration 'wait': evidence must be an array of strings/);
});

test('orchestration: empty evidence on supported or unsupported is reported, on unknown it is allowed', () => {
  assertReports(mutated((block: any) => { block.status.evidence = []; }), /orchestration 'status': evidence must not be empty when status is supported/);
  assertReports(mutated((block: any) => {
    block.cancel = { status: 'unsupported', evidence: [], verification: 'x', verifiedOn: '2026-10-12', fallback: 'manual' };
  }), /orchestration 'cancel': evidence must not be empty when status is unsupported/);
  const unknown = mutated((block: any) => {
    block.cancel = { status: 'unknown', evidence: [], verification: 'x', verifiedOn: '2026-10-12', fallback: 'manual', reason: 'not documented' };
  });
  assert.equal(unknown.ok, true, unknown.errors.join('\n'));
});

test('orchestration: a missing verification or verifiedOn is reported', () => {
  assertReports(mutated((block: any) => { delete block.spawn.verification; }), /orchestration 'spawn': requires a verification instruction/);
  assertReports(mutated((block: any) => { delete block.spawn.verifiedOn; }), /orchestration 'spawn': requires verifiedOn/);
  assertReports(mutated((block: any) => { block.spawn.verifiedOn = 'today'; }), /orchestration 'spawn': requires verifiedOn/);
});

test('orchestration: a missing fallback when the status is not supported is reported', () => {
  assertReports(mutated((block: any) => {
    block.resume = { status: 'unsupported', evidence: ['https://example.test/doc'], verification: 'x', verifiedOn: '2026-10-12' };
  }), /orchestration 'resume': requires fallback \(sequential or manual\) when status is unsupported/);
  assertReports(mutated((block: any) => {
    block.resume = { status: 'unsupported', evidence: ['https://example.test/doc'], verification: 'x', verifiedOn: '2026-10-12', fallback: 'parallel' };
  }), /orchestration 'resume': requires fallback/);
});

test('orchestration: a missing reason when the status is unknown is reported', () => {
  assertReports(mutated((block: any) => {
    block.resume = { status: 'unknown', evidence: [], verification: 'x', verifiedOn: '2026-10-12', fallback: 'manual' };
  }), /orchestration 'resume': requires a reason when status is unknown/);
});

test('orchestration: validateOrchestration reports a non-object block without throwing', () => {
  const errors: any = [];
  validateOrchestration('nope', "harness 'x'", errors);
  assert.deepEqual(errors, ["harness 'x': orchestration block is required and must be an object"]);
});

test('orchestration: the block is not part of the capability map data', () => {
  const { capabilityMapData } = require('../../src/registry/index.ts');
  const registry = loadRegistry({ repoRoot: REPO });
  assert.ok(!JSON.stringify(capabilityMapData(registry)).includes('"orchestration"'));
});
