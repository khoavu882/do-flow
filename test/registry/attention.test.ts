'use strict';
// Row 180 IC-180-D0 (K3a a): the per-harness `attention` declaration in core/registry/harnesses.json, which hook events
// are asks, which payload fields give the session, the kind and the tool, and which events answer. Checked by
// `validateAttention` (src/registry/attention.ts) against the harness's contract event list in
// core/registry/contracts.json; `projectAttention` gives the map the shared bridge step reads, checked in at
// core/harnesses/shared/hooks/bridge/attention.json. Descriptors here are fakes; no harness runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry, validateRegistry } = require('../../src/registry/index.ts');
const { ACTIVE_HARNESS_IDS } = require('../helper/harness-ids.ts');
const { validateAttention, projectAttention, attentionProblems } = require('../../src/registry/attention.ts');

const REPO = path.resolve(__dirname, '../..');
const PROJECTION = path.join(REPO, 'core/harnesses/shared/hooks/bridge/attention.json');
const EVENTS = ['PermissionRequest', 'Notification', 'UserPromptSubmit', 'PermissionDenied', 'Stop', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse'];

const supported = (): any => ({
  status: 'supported',
  sessionField: 'session_id',
  asks: [
    { event: 'PermissionRequest', kind: 'permission', toolField: 'tool_name' },
    { event: 'Notification', kindField: 'notification_type', kinds: { permission_prompt: 'permission', elicitation_dialog: 'question', idle_prompt: 'idle' }, skip: ['auth_success'], otherwise: 'other' },
  ],
  answeredBy: ['UserPromptSubmit', 'PermissionDenied', 'Stop', 'PostToolUse', 'PostToolUseFailure'],
  evidence: ['https://code.claude.com/docs/en/hooks'],
  verification: 'Read the hooks page for the PermissionRequest and Notification inputs.',
  verifiedOn: '2026-11-20',
});
const unknown = (): any => ({ status: 'unknown', reason: 'no-harness-record' });

const problems = (entry: any, events: string[] = EVENTS) => {
  const errors: string[] = [];
  validateAttention(entry, "harness 'x'", errors, { events });
  return errors;
};
const refused = (entry: any, pattern: RegExp, events: string[] = EVENTS) => {
  const errors = problems(entry, events);
  assert.ok(errors.some((line) => pattern.test(line)), `expected ${pattern} in:\n${errors.join('\n')}`);
  for (const line of errors) assert.ok(line.startsWith("harness 'x' attention: "), `message names harness and key: ${line}`);
};
const withAsk = (ask: any) => ({ ...supported(), asks: [ask] });

test('(a) the design §5 entry validates, and so does an unknown entry', () => {
  assert.deepEqual(problems(supported()), []);
  assert.deepEqual(problems(unknown()), []);
});

test('(a) status, a closed key set, and unknown forbids every mechanism field', () => {
  refused('supported', /must be an object/);
  refused({ ...supported(), status: 'partial' }, /status must be supported or unknown/);
  refused({ ...supported(), message: 'text' }, /has unknown field 'message'/);
  refused({ status: 'unknown' }, /status unknown requires a reason/);
  for (const key of ['asks', 'answeredBy', 'sessionField']) refused({ ...unknown(), [key]: supported()[key] }, new RegExp(`status unknown forbids '${key}'`));
  const { evidence, ...noEvidence } = supported();
  refused(noEvidence, /evidence must not be empty when status is supported/);
  refused({ ...supported(), verifiedOn: '20 Nov' }, /verifiedOn must be an ISO date/);
});

test('(a) an ask on an event the harness contract does not list is refused, and so is an answeredBy event it does not list', () => {
  refused(withAsk({ event: 'Elicitation', kind: 'question' }), /asks\[0\] event 'Elicitation' is not an event of the harness contract/);
  refused({ ...supported(), answeredBy: ['UserPromptSubmit', 'TeammateIdle'] }, /answeredBy event 'TeammateIdle' is not an event of the harness contract/);
  // The same entry against a contract without the two ask events: both asks are refused.
  const errors = problems(supported(), EVENTS.filter((e) => e !== 'PermissionRequest' && e !== 'Notification'));
  assert.equal(errors.filter((line) => /is not an event of the harness contract/.test(line)).length, 2, errors.join('\n'));
  refused({ ...supported(), answeredBy: ['PermissionRequest'] }, /answeredBy event 'PermissionRequest' is also an ask/);
  refused({ ...supported(), asks: [supported().asks[0], supported().asks[0]] }, /asks events must be distinct/);
});

test('(a) a kind outside the four is refused, as a fixed kind or a mapped one; exactly one of kind and kindField', () => {
  refused(withAsk({ event: 'PermissionRequest', kind: 'approval' }), /kind must be one of permission, question, idle, other/);
  refused(withAsk({ ...supported().asks[1], kinds: { permission_prompt: 'urgent' } }), /kinds 'permission_prompt' must be one of permission, question, idle, other/);
  refused(withAsk({ ...supported().asks[1], otherwise: 'ignore' }), /otherwise must be one of permission, question, idle, other/);
  refused(withAsk({ event: 'PermissionRequest' }), /needs exactly one of kind and kindField/);
  refused(withAsk({ ...supported().asks[1], kind: 'idle' }), /needs exactly one of kind and kindField/);
  refused(withAsk({ event: 'PermissionRequest', kind: 'permission', skip: ['x'] }), /a fixed kind forbids 'skip'/);
  const { otherwise, ...noOtherwise } = supported().asks[1];
  refused(withAsk(noOtherwise), /kindField requires otherwise/);
  refused(withAsk({ ...supported().asks[1], skip: ['idle_prompt'] }), /skip 'idle_prompt' is also in kinds/);
  refused(withAsk({ ...supported().asks[1], kinds: {} }), /kinds must be 1 to 16 entries/);
});

test('(a) a bad toolField, kindField or sessionField is refused: one top-level payload key name', () => {
  for (const bad of ['tool_input.command', 'Tool Name', '', 'x'.repeat(41), 'tool-name']) {
    refused(withAsk({ event: 'PermissionRequest', kind: 'permission', toolField: bad }), /toolField must match/);
  }
  refused(withAsk({ ...supported().asks[1], kindField: 'message[0]' }), /kindField must match/);
  refused({ ...supported(), sessionField: 'session.id' }, /sessionField must match/);
  refused(withAsk({ event: 'PermissionRequest', kind: 'permission', toolField: 'tool_name', inputField: 'tool_input' }), /asks\[0\] has unknown field 'inputField'/);
});

test('(a) every shipped harness declares a valid attention entry: Claude Code supported, every other harness unknown', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(attentionProblems(registry), []);
  const status = Object.fromEntries(registry.harnesses.map((h: any) => [h.id, h.attention?.status]));
  assert.deepEqual(status, Object.fromEntries(ACTIVE_HARNESS_IDS.map((id) => [id, id === 'claude' ? 'supported' : 'unknown'])));
  for (const h of registry.harnesses.filter((x: any) => x.id !== 'claude')) assert.deepEqual(h.attention, unknown(), h.id);
  // attentionProblems names a harness without the key, and a supported entry checked against its own contract.
  const missing = { ...registry, harnesses: registry.harnesses.map((h: any) => (h.id === 'kiro' ? { ...h, attention: undefined } : h)) };
  assert.deepEqual(attentionProblems(missing), ["harness 'kiro' declares no attention"]);
  const codexAsks = { ...registry, harnesses: registry.harnesses.map((h: any) => (h.id === 'kiro' ? { ...h, attention: supported() } : h)) };
  assert.ok(attentionProblems(codexAsks).some((line: string) => /^harness 'kiro' attention: asks\[1\] event 'Notification' is not an event of the harness contract/.test(line)));
});

test('(a) attention.json equals projectAttention(registry); a planted drift fails', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const projected = projectAttention(registry);
  assert.deepEqual(Object.keys(projected), ['claude'], 'only supported harnesses are projected');
  assert.deepEqual(Object.keys(projected.claude), ['sessionField', 'asks', 'answeredBy']);
  const onDisk = JSON.parse(fs.readFileSync(PROJECTION, 'utf8'));
  assert.deepEqual(onDisk, projected, 'regenerate core/harnesses/shared/hooks/bridge/attention.json from projectAttention(loadRegistry({ repoRoot: REPO }))');
  const drift = structuredClone(registry);
  drift.harnesses.find((h: any) => h.id === 'claude').attention.answeredBy.push('PreToolUse');
  assert.notDeepEqual(onDisk, projectAttention(drift), 'a registry change the checked-in file does not carry is caught');
});

test('(a) validateRegistry refuses a bad attention block at load, naming the harness; a valid shipped registry stays clean', () => {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  const run = (r: any): string[] => validateRegistry(r, { repoRoot: REPO, sources: 'skip' }).errors;
  assert.deepEqual(run(registry).filter((line) => / attention: /.test(line)), []);
  // an event the harness's contract does not list is refused with the contract events from the registry itself
  registry.harnesses.find((h: any) => h.id === 'claude').attention.asks[0].event = 'NoSuchEvent';
  registry.harnesses.find((h: any) => h.id === 'kiro').attention = { status: 'unknown' };
  const errors = run(registry);
  assert.ok(errors.some((line) => line.startsWith("harness 'claude' attention: ") && /event 'NoSuchEvent' is not an event of the harness contract/.test(line)), errors.join('\n'));
  assert.ok(errors.some((line) => line.startsWith("harness 'kiro' attention: ") && /status unknown requires a reason/.test(line)), errors.join('\n'));
});
