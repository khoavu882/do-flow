'use strict';
// 118 IC-003: the `agentLimits.readOnly` block of core/registry/harnesses.json and its validator.
// Each finding the validator reports has one failing case here, built from an in-memory copy of the
// shipped registry so a regression in the validator cannot hide behind a file edit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadRegistry, validateRegistry, validateAgentLimits, AGENT_LIMIT_STATUS,
} = require('../../src/registry/index.ts');

const REPO = path.resolve(__dirname, '../..');
const IDS = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity'];

/** A fresh copy of the shipped registry whose first harness is claude, with a mutation applied. */
function mutated(mutate) {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(registry.harnesses[0].agentLimits.readOnly, registry.harnesses[0], registry);
  return validateRegistry(registry, { repoRoot: REPO });
}

function assertReports(result, pattern) {
  assert.equal(result.ok, false, 'the mutated registry must be rejected');
  assert.match(result.errors.join('\n'), pattern);
}

const readOnlyOf = (registry, id) => registry.harnesses.find((h) => h.id === id).agentLimits.readOnly;

test('agentLimits: the shipped registry declares readOnly on all eight harnesses and validates', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.deepEqual(registry.harnesses.map((h) => h.id).sort(), [...IDS].sort());
  for (const harness of registry.harnesses) {
    assert.deepEqual(Object.keys(harness.agentLimits), ['readOnly'], `${harness.id} agentLimits keys`);
  }
  assert.deepEqual([...AGENT_LIMIT_STATUS], ['native', 'unenforced']);
});

test('agentLimits: the shipped statuses and apply values are the IC-003 table', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const status = Object.fromEntries(registry.harnesses.map((h) => [h.id, h.agentLimits.readOnly.status]));
  assert.deepEqual(status, {
    claude: 'native', gemini: 'native', copilot: 'native', kiro: 'native', opencode: 'native',
    antigravity: 'unenforced', codex: 'unenforced', pi: 'unenforced',
  });
  assert.deepEqual(readOnlyOf(registry, 'claude').apply, { disallowedTools: 'Edit, Write, NotebookEdit' });
  assert.deepEqual(readOnlyOf(registry, 'opencode').apply, { permission: { edit: 'deny', bash: 'deny' } });
  for (const id of ['gemini', 'copilot', 'kiro']) {
    assert.ok(Array.isArray(readOnlyOf(registry, id).apply.tools) && readOnlyOf(registry, id).apply.tools.length > 0, `${id} apply.tools`);
  }
  for (const harness of registry.harnesses) {
    const entry = harness.agentLimits.readOnly;
    if (entry.status === 'native') assert.equal(entry.checked, 'docs', `${harness.id} checked`);
    assert.equal(entry.verifiedOn, '2026-10-23', `${harness.id} verifiedOn`);
  }
});

test('agentLimits: a harness without the block is reported', () => {
  assertReports(mutated((_entry, harness) => { delete harness.agentLimits; }), /harness 'claude': agentLimits block is required/);
});

test('agentLimits: an unknown key beside readOnly or inside the entry is reported', () => {
  assertReports(mutated((_entry, harness) => { harness.agentLimits.write = {}; }), /agentLimits has unknown key 'write'/);
  assertReports(mutated((entry) => { entry.mode = 'x'; }), /agentLimits readOnly: has unknown key 'mode'/);
});

test('agentLimits: a missing readOnly entry is reported', () => {
  assertReports(mutated((_entry, harness) => { delete harness.agentLimits.readOnly; }), /agentLimits is missing 'readOnly'/);
});

test('agentLimits: an unknown status is refused', () => {
  assertReports(mutated((entry) => { entry.status = 'partial'; }), /agentLimits readOnly: status must be native or unenforced/);
});

test('agentLimits: native without apply is refused', () => {
  assertReports(mutated((entry) => { delete entry.apply; }), /agentLimits readOnly: native requires apply as a non-empty object/);
  assertReports(mutated((entry) => { entry.apply = {}; }), /native requires apply as a non-empty object/);
});

test('agentLimits: native without evidence is refused', () => {
  assertReports(mutated((entry) => { entry.evidence = []; }), /agentLimits readOnly: native requires non-empty evidence/);
  assertReports(mutated((entry) => { delete entry.evidence; }), /agentLimits readOnly: evidence must be an array of strings/);
  assertReports(mutated((entry) => { entry.evidence = [42]; }), /agentLimits readOnly: evidence must be an array of strings/);
});

test('agentLimits: native evidence entries must be non-blank http(s) URLs (C-6)', () => {
  for (const bad of ['', ' ', 'not a url', 'ftp://example.com/doc', 'mailto:a@b.c']) {
    assertReports(mutated((entry) => { entry.evidence = [bad]; }), /agentLimits readOnly: evidence entry .* must be an http\(s\) URL/);
  }
  assertReports(mutated((entry) => { entry.evidence = ['https://example.com/ok', 'not a url']; }), /must be an http\(s\) URL/);
  const ok = mutated((entry) => { entry.evidence = ['https://example.com/docs', 'http://example.org/x']; });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
});

test('agentLimits: an unenforced evidence entry that is not a URL is refused', () => {
  assertReports(mutated((entry) => {
    entry.status = 'unenforced'; entry.reason = 'undocumented'; entry.evidence = ['not a url']; delete entry.apply;
  }), /agentLimits readOnly: evidence entry .* must be an http\(s\) URL/);
  const ok = mutated((entry) => {
    entry.status = 'unenforced'; entry.reason = 'undocumented'; entry.evidence = ['https://example.com/x']; delete entry.apply;
  });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
});

test('agentLimits: native without checked docs|live or an ISO verifiedOn is refused', () => {
  assertReports(mutated((entry) => { delete entry.checked; }), /agentLimits readOnly: native requires checked as docs or live/);
  assertReports(mutated((entry) => { entry.checked = 'guess'; }), /native requires checked as docs or live/);
  assertReports(mutated((entry) => { delete entry.verifiedOn; }), /agentLimits readOnly: requires verifiedOn as an ISO date/);
  assertReports(mutated((entry) => { entry.verifiedOn = 'today'; }), /requires verifiedOn as an ISO date/);
});

test('agentLimits: unenforced without a reason is refused, and it may not carry apply', () => {
  assertReports(mutated((entry) => { entry.status = 'unenforced'; delete entry.apply; delete entry.reason; }), /agentLimits readOnly: unenforced requires a reason/);
  assertReports(mutated((entry) => { entry.status = 'unenforced'; entry.reason = '  '; delete entry.apply; }), /unenforced requires a reason/);
  assertReports(mutated((entry) => { entry.status = 'unenforced'; entry.reason = 'x'; }), /unenforced must not carry apply/);
});

test('agentLimits: unenforced evidence may be empty only when the reason is "no agent surface"', () => {
  assertReports(mutated((entry) => {
    entry.status = 'unenforced'; entry.reason = 'undocumented'; entry.evidence = []; delete entry.apply;
  }), /unenforced requires non-empty evidence unless the reason is "no agent surface"/);
  const ok = mutated((entry) => {
    entry.status = 'unenforced'; entry.reason = 'no agent surface'; entry.evidence = []; delete entry.apply;
  });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
});

test('agentLimits: validateAgentLimits reports a non-object block without throwing', () => {
  const errors = [];
  validateAgentLimits('nope', "harness 'x'", errors);
  assert.deepEqual(errors, ["harness 'x': agentLimits block is required and must be an object"]);
});
