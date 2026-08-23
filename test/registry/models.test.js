'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadRegistry, validateRegistry } = require('../../src/registry');

const REPO = path.resolve(__dirname, '..', '..');
const EMPTY = { harnesses: [], assets: [], mcp: [], lifecycle: [], externalTools: [], contracts: [] };

const goodProviders = [
  { id: 'claude', displayName: 'Claude Code hosted models', kind: 'hosted', evidence: ['https://code.claude.com/docs/en/model-config'] },
  { id: 'ollama', displayName: 'Ollama local models', kind: 'local', evidence: ['https://ollama.com'] },
];
const goodRoles = [
  { id: 'triage', prefer: 'cheap-fast', fallback: 'any-healthy' },
  { id: 'review', require: 'different-family' },
];
const goodSlot = { id: 'dense', provider: 'ollama', model: 'nomic-embed-text', enabled: false };

test('the shipped registry loads model providers and roles end-to-end', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.ok(registry.modelProviders.length >= 3, 'at least the hosted trio plus a local provider');
  assert.ok(registry.modelRoles.some((role) => role.id === 'review'));
  assert.ok(registry.versions.models >= 1);
});

test('the shipped registry declares no retrieval slots, so the loader yields an empty list', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(registry.retrievalSlots, []);
});

test('well-formed provider/role declarations validate cleanly against an otherwise empty registry', () => {
  const result = validateRegistry({ ...EMPTY, modelProviders: goodProviders, modelRoles: goodRoles }, { repoRoot: REPO });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('provider claims without evidence, bad kinds, or duplicate ids fail validation', () => {
  const cases = [
    [{ ...goodProviders[0], evidence: [] }, 'evidence'],
    [{ ...goodProviders[0], kind: 'serverless' }, 'kind'],
    [{ ...goodProviders[0], id: 'Claude' }, 'lowercase'],
    [goodProviders[0], 'duplicate id'],
  ];
  const providers = [...goodProviders.slice(1)];
  for (const [provider, message] of cases.slice(0, 3)) {
    providers.unshift(provider);
    const result = validateRegistry({ ...EMPTY, modelProviders: [...providers], modelRoles: [] }, { repoRoot: REPO });
    assert.equal(result.ok, false, message);
    providers.shift();
  }
  const duplicated = validateRegistry({ ...EMPTY, modelProviders: [goodProviders[0], { ...goodProviders[0] }], modelRoles: [] }, { repoRoot: REPO });
  assert.ok(duplicated.errors.some((error) => error.includes("duplicate id 'claude'")));
});

test('roles must be uniquely identified with non-empty routing hints', () => {
  const blankRole = validateRegistry({ ...EMPTY, modelProviders: [], modelRoles: [{ id: 'x', prefer: '' }] }, { repoRoot: REPO });
  assert.equal(blankRole.ok, false);
  const duplicated = validateRegistry({ ...EMPTY, modelProviders: [], modelRoles: [goodRoles[0], { ...goodRoles[0] }] }, { repoRoot: REPO });
  assert.ok(duplicated.errors.some((error) => error.includes('duplicate id')));
});

test('absent slots are the default posture and validate cleanly; empty list too', () => {
  const absent = validateRegistry({ ...EMPTY, modelProviders: goodProviders, modelRoles: goodRoles }, { repoRoot: REPO });
  assert.deepEqual(absent.errors, []);
  const emptyList = validateRegistry({ ...EMPTY, modelProviders: goodProviders, modelRoles: goodRoles, retrievalSlots: [] }, { repoRoot: REPO });
  assert.deepEqual(emptyList.errors, []);
});

test('a well-formed slot validates and binds only to declared providers', () => {
  const ok = validateRegistry({ ...EMPTY, modelProviders: goodProviders, modelRoles: [], retrievalSlots: [goodSlot] }, { repoRoot: REPO });
  assert.deepEqual(ok.errors, []);
  const unknownProvider = validateRegistry(
    { ...EMPTY, modelProviders: goodProviders, modelRoles: [], retrievalSlots: [{ ...goodSlot, provider: 'vibes' }] },
    { repoRoot: REPO },
  );
  assert.equal(unknownProvider.ok, false);
  assert.match(unknownProvider.errors.join('\n'), /references unknown model provider 'vibes'/);
});

test('malformed slots are rejected loudly with the offending field named', () => {
  const cases = [
    [{ ...goodSlot, id: 'sparse' }, /id must be one of: dense, rerank/],
    [{ ...goodSlot, model: '' }, /requires model/],
    [{ ...goodSlot, enabled: 'yes' }, /enabled must be a boolean/],
    [{ ...goodSlot, evidence: ['http://insecure.test'] }, /HTTPS evidence URLs/],
    [{ ...goodSlot, extra: true }, /unsupported field 'extra'/],
    ['dense', /must be an object/],
  ];
  for (const [slot, pattern] of cases) {
    const result = validateRegistry({ ...EMPTY, modelProviders: goodProviders, modelRoles: [], retrievalSlots: [slot] }, { repoRoot: REPO });
    assert.equal(result.ok, false, JSON.stringify(slot));
    assert.match(result.errors.join('\n'), pattern);
  }
  const notAnArray = validateRegistry({ ...EMPTY, modelProviders: goodProviders, modelRoles: [], retrievalSlots: { id: 'dense' } }, { repoRoot: REPO });
  assert.ok(notAnArray.errors.some((error) => error.includes('models.slots: must be an array when present')));
});

test('duplicate slot ids fail validation', () => {
  const duplicated = validateRegistry(
    { ...EMPTY, modelProviders: goodProviders, modelRoles: [], retrievalSlots: [goodSlot, { ...goodSlot, model: 'other-model' }] },
    { repoRoot: REPO },
  );
  assert.ok(duplicated.errors.some((error) => error.includes("duplicate id 'dense'")));
});

test('an enabled slot loads end-to-end through loadRegistry; malformed fails the load', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-model-slots-'));
  for (const dir of ['core', 'src', 'bin']) fs.cpSync(path.join(REPO, dir), path.join(root, dir), { recursive: true });
  const modelsPath = path.join(root, 'core', 'registry', 'models.json');
  const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  models.slots = [{ id: 'dense', provider: 'ollama', model: 'nomic-embed-text', enabled: true }];
  fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2));
  const registry = loadRegistry({ repoRoot: root });
  assert.deepEqual(registry.retrievalSlots, [models.slots[0]]);

  models.slots = [{ id: 'dense', provider: 'not-declared', model: 'x', enabled: true }];
  fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2));
  assert.throws(() => loadRegistry({ repoRoot: root }), /references unknown model provider 'not-declared'/);
});
