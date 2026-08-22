'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
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

test('the shipped registry loads model providers and roles end-to-end', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.ok(registry.modelProviders.length >= 3, 'at least the hosted trio plus a local provider');
  assert.ok(registry.modelRoles.some((role) => role.id === 'review'));
  assert.ok(registry.versions.models >= 1);
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
