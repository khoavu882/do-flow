'use strict';
// Row 178 design §3.1 (IC-001): the `sessionEffort` descriptor key, one refusal per rule of its table, validated by
// `validateSessionEffort` (src/registry/session-effort.ts) and called from `validateRegistry` beside the primary probe.
// Environment sources only (O-8 (b)). Descriptors here are fakes; no harness runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRegistry, validateRegistry } = require('../../src/registry/index.ts');
const { validateSessionEffort } = require('../../src/registry/session-effort.ts');

const claude = () => ({
  status: 'supported',
  marker: { env: 'CLAUDE_CODE_CHILD_SESSION', equals: '1' },
  sources: [{ kind: 'env', name: 'CLAUDE_EFFORT', modes: ['subscription', 'api-key'] }],
  note: 'effortLevel is not read: CLAUDE_EFFORT is unset exactly when the model takes no effort',
  evidence: ['https://code.claude.com/docs/en/env-vars'],
  verification: 'Read the env-vars page for CLAUDE_EFFORT and CLAUDE_CODE_CHILD_SESSION.',
  verifiedOn: '2026-11-19',
});
const unknown = () => ({ status: 'unknown', reason: 'no recorded variable marks a tool shell', verification: 'Record one, then add it.' });

const problems = (entry: any, effortStatus = 'supported') => {
  const errors: string[] = [];
  validateSessionEffort(entry, "harness 'x'", errors, { effortStatus });
  return errors;
};
const refused = (entry: any, pattern: RegExp, effortStatus = 'supported') => {
  const errors = problems(entry, effortStatus);
  assert.ok(errors.some((line) => pattern.test(line)), `expected ${pattern} in:\n${errors.join('\n')}`);
  for (const line of errors) assert.ok(line.startsWith("harness 'x' sessionEffort: "), `message names harness and key: ${line}`);
};
const withSource = (source: any) => ({ ...claude(), sources: [source] });

test('(a) the design §3.1 Claude entry validates, and so does an unknown entry', () => {
  assert.deepEqual(problems(claude()), []);
  assert.deepEqual(problems(unknown()), []);
  assert.deepEqual(problems({ ...unknown(), evidence: ['https://example.test/x'] }, 'unknown'), []);
});

test('(b) status is supported or unknown, and the entry is an object with a closed key set', () => {
  refused('supported', /must be an object/);
  refused({ ...claude(), status: 'unsupported' }, /status must be supported or unknown/);
  refused({ ...claude(), extra: 1 }, /has unknown field 'extra'/);
});

test('(b) unknown needs a reason (at most 240 characters) and a verification, and forbids marker and sources', () => {
  const { reason, ...noReason } = unknown();
  refused(noReason, /status unknown requires a reason/);
  refused({ ...unknown(), reason: 'x'.repeat(241) }, /reason must be a non-empty line of at most 240 characters/);
  const { verification, ...noVerification } = unknown();
  refused(noVerification, /requires a verification instruction/);
  refused({ ...unknown(), marker: claude().marker }, /status unknown forbids 'marker'/);
  refused({ ...unknown(), sources: claude().sources }, /status unknown forbids 'sources'/);
});

test('(b) supported needs a marker {env, equals}', () => {
  const { marker, ...noMarker } = claude();
  refused(noMarker, /status supported requires a marker/);
  refused({ ...claude(), marker: { env: 'lower', equals: '1' } }, /marker\.env must match/);
  refused({ ...claude(), marker: { env: 'A'.repeat(65), equals: '1' } }, /marker\.env must match/);
  refused({ ...claude(), marker: { env: 'CLAUDE_CODE_CHILD_SESSION', equals: '' } }, /marker\.equals must be 1 to 32 printable ASCII characters/);
  refused({ ...claude(), marker: { env: 'CLAUDE_CODE_CHILD_SESSION', equals: 'x'.repeat(33) } }, /marker\.equals must be 1 to 32 printable ASCII characters/);
  refused({ ...claude(), marker: { env: 'CLAUDE_CODE_CHILD_SESSION', equals: 'tab\there' } }, /marker\.equals must be 1 to 32 printable ASCII characters/);
  refused({ ...claude(), marker: { env: 'CLAUDE_CODE_CHILD_SESSION', equals: '1', extra: 1 } }, /marker has unknown field 'extra'/);
});

test('(b) sources are 1 to 8 entries of kind env only; json and any other kind are refused', () => {
  const { sources, ...noSources } = claude();
  refused(noSources, /sources must be 1 to 8 entries/);
  refused({ ...claude(), sources: [] }, /sources must be 1 to 8 entries/);
  const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'env', name: `SRC_${i}`, modes: ['subscription'] }));
  refused({ ...claude(), sources: many }, /sources must be 1 to 8 entries/);
  refused(withSource({ kind: 'json', name: 'CLAUDE_EFFORT', modes: ['subscription'] }), /kind must be env/);
  refused(withSource({ kind: 'toml-top', name: 'CLAUDE_EFFORT', modes: ['subscription'] }), /kind must be env/);
  refused(withSource({ name: 'CLAUDE_EFFORT', modes: ['subscription'] }), /kind must be env/);
  refused(withSource({ kind: 'env', name: 'CLAUDE_EFFORT', modes: ['subscription'], path: ['effortLevel'] }), /sources\[0\] has unknown field 'path'/);
});

test('(b) modes are 1 or 2 distinct of subscription and api-key; oauth and an empty list are refused', () => {
  refused(withSource({ kind: 'env', name: 'CLAUDE_EFFORT', modes: [] }), /modes must be 1 to 2 distinct of subscription, api-key/);
  refused(withSource({ kind: 'env', name: 'CLAUDE_EFFORT', modes: ['oauth'] }), /modes must be 1 to 2 distinct of subscription, api-key/);
  refused(withSource({ kind: 'env', name: 'CLAUDE_EFFORT', modes: ['api-key', 'api-key'] }), /modes must be 1 to 2 distinct of subscription, api-key/);
  refused(withSource({ kind: 'env', name: 'CLAUDE_EFFORT' }), /modes must be 1 to 2 distinct of subscription, api-key/);
  assert.deepEqual(problems(withSource({ kind: 'env', name: 'CLAUDE_EFFORT', modes: ['api-key'] })), []);
});

test('(b) a source name is a variable name, not the marker, and distinct across sources', () => {
  refused(withSource({ kind: 'env', name: 'claude_effort', modes: ['subscription'] }), /name must match/);
  refused(withSource({ kind: 'env', name: 'A'.repeat(65), modes: ['subscription'] }), /name must match/);
  refused(withSource({ kind: 'env', name: 'CLAUDE_CODE_CHILD_SESSION', modes: ['subscription'] }), /name must not be the marker's own variable/);
  refused({ ...claude(), sources: [{ kind: 'env', name: 'A_B', modes: ['subscription'] }, { kind: 'env', name: 'A_B', modes: ['api-key'] }] }, /names must be distinct/);
});

test('(b) a note is at most 240 characters, and the entry serializes to at most 2 KiB', () => {
  refused({ ...claude(), note: 'x'.repeat(241) }, /note must be a string of at most 240 characters/);
  refused({ ...claude(), evidence: Array.from({ length: 30 }, (_, i) => `https://example.test/${'x'.repeat(80)}/${i}`) }, /entry is .* bytes serialized; the limit is 2048/);
});

test('(b) supported also needs evidence, a verification and a verifiedOn date', () => {
  refused({ ...claude(), evidence: [] }, /evidence must not be empty when status is supported/);
  refused({ ...claude(), verification: ' ' }, /requires a verification instruction/);
  refused({ ...claude(), verifiedOn: 'yesterday' }, /verifiedOn must be an ISO date/);
});

test('(d) supported with worker.effort unknown is refused; its levels are what validates a read value', () => {
  refused(claude(), /status supported requires worker 'effort' to be supported/, 'unknown');
  refused(claude(), /status supported requires worker 'effort' to be supported/, 'absent');
  assert.deepEqual(problems(unknown(), 'unknown'), []);
});

test('validateRegistry runs the check on a harness descriptor and names the harness', () => {
  const registry = structuredClone(loadRegistry({ repoRoot: path.resolve(__dirname, '../..') }));
  const claudeHarness = registry.harnesses.find((h: any) => h.id === 'claude');
  claudeHarness.sessionEffort = { ...claude(), marker: { env: 'bad', equals: '1' } };
  const errors: string[] = validateRegistry(registry, { repoRoot: registry.repoRoot, sources: 'skip' }).errors;
  assert.ok(errors.some((line) => line.startsWith("harness 'claude' sessionEffort: ") && /marker\.env must match/.test(line)), errors.join('\n'));
});
