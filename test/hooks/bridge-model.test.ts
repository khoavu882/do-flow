'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { encodeEnvelope, MODEL_PAYLOADS } = require('../helper/hook-fixtures.ts');
const { loadRegistry } = require('../../src/registry/index.ts');

const ROOT = path.resolve(__dirname, '../..');
const PAYLOAD_HARNESSES = new Set(['codex', 'claude', 'antigravity', 'pi']);

function decoded(harness: any, event: any, native: any) {
  return JSON.parse(encodeEnvelope(harness, event, 'pre-implementation-gate', JSON.stringify(native))).doflow_event;
}

test('hook bridge emits a validated model identity only for payload probes', () => {
  for (const [harness, fixture] of Object.entries(MODEL_PAYLOADS)) {
    const envelope = decoded(harness, fixture.event, fixture.native);
    if (PAYLOAD_HARNESSES.has(harness)) {
      assert.equal(envelope.identity.model, fixture.native.model ?? fixture.native.modelName, harness);
    } else {
      assert.equal(envelope.identity?.model, undefined, harness);
    }
  }
});

test('hook bridge drops an invalid Codex model and records modelUnparsed', () => {
  const fixture = MODEL_PAYLOADS.codex;
  const envelope = decoded('codex', fixture.event, { ...fixture.native, model: '-rf' });
  assert.equal(envelope.identity.model, undefined);
  assert.equal(envelope.identity.modelUnparsed, true);
});

test('Claude model identity is limited to SessionStart', () => {
  const fixture = MODEL_PAYLOADS.claude;
  const envelope = decoded('claude', 'PreToolUse', { ...fixture.native, hook_event_name: 'PreToolUse' });
  assert.equal(envelope.identity.model, undefined);
});

test('every shipped harness declares the expected primary model probe', () => {
  const registry = loadRegistry({ repoRoot: ROOT });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.deepEqual(
    registry.harnesses.filter((harness: any) => harness.primaryProbe.model === 'payload').map((harness: any) => harness.id).sort(),
    [...PAYLOAD_HARNESSES].sort(),
  );
});

test('registry rejects unknown and unsupported primaryProbe declarations', (t) => {
  const copiedRegistry = tempDir(t, 'doflow-primary-probe-');
  fs.cpSync(path.join(ROOT, 'core/registry'), copiedRegistry, { recursive: true });
  const harnessesFile = path.join(copiedRegistry, 'harnesses.json');

  const unknownKeyHarnesses = JSON.parse(fs.readFileSync(harnessesFile, 'utf8'));
  const codex = unknownKeyHarnesses.harnesses.find((harness: any) => harness.id === 'codex');
  codex.primaryProbe.extra = true;
  fs.writeFileSync(harnessesFile, JSON.stringify(unknownKeyHarnesses));
  assert.throws(
    () => loadRegistry({ repoRoot: ROOT, dir: copiedRegistry }),
    /harness 'codex' primaryProbe: has an unknown key 'extra'/,
  );

  const supportedWithoutEvidence = JSON.parse(fs.readFileSync(harnessesFile, 'utf8'));
  const supportedCodex = supportedWithoutEvidence.harnesses.find((harness: any) => harness.id === 'codex');
  delete supportedCodex.primaryProbe.extra;
  supportedCodex.primaryProbe.status = 'supported';
  supportedCodex.primaryProbe.verifiedOn = '2026-10-24';
  supportedCodex.primaryProbe.evidence = [];
  fs.writeFileSync(harnessesFile, JSON.stringify(supportedWithoutEvidence));
  assert.throws(
    () => loadRegistry({ repoRoot: ROOT, dir: copiedRegistry }),
    /harness 'codex' primaryProbe.*evidence/,
  );
});
