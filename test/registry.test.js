'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  REGISTRY_FILES, loadRegistry, validateRegistry, selectAssets, selectMcpServers, capabilityMapData,
} = require('../src/registry');

const REPO = path.resolve(__dirname, '..');

test('loads and validates the complete multi-harness registry', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(registry.harnesses.map((item) => item.id), ['claude', 'codex', 'gemini']);
  assert.deepEqual(Object.keys(REGISTRY_FILES), ['harnesses', 'assets', 'mcp', 'lifecycle']);
  assert.equal(registry.validation.ok, true);
  assert.deepEqual(registry.harnesses.find((harness) => harness.id === 'codex').nativeProjection.config.resources,
    [{ kind: 'configuration-entry', identity: 'features.hooks', value: true }]);
});

test('selects only renderable harness assets and filters by capability', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const codex = selectAssets(registry, { harness: 'codex' });
  assert.ok(codex.some((asset) => asset.id === 'skills.doflow'));
  assert.ok(!codex.some((asset) => asset.id === 'modes.doflow'));
  assert.deepEqual(selectAssets(registry, { harness: 'codex', capability: 'skills' }).map((asset) => asset.id), ['skills.doflow']);
  assert.throws(() => selectAssets(registry, { harness: 'unknown' }), /Unknown registry harness/);
});

test('selects the neutral MCP catalog and rejects unknown selections', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(selectMcpServers(registry).length, 4);
  assert.deepEqual(selectMcpServers(registry, ['context7', 'playwright']).map((item) => item.id), ['context7', 'playwright']);
  assert.throws(() => selectMcpServers(registry, ['unknown']), /Unknown registry MCP server/);
});

test('generates capability-map records with evidence and explicit gaps', () => {
  const map = capabilityMapData(loadRegistry({ repoRoot: REPO }));
  const codexHooks = map.find((row) => row.harness === 'codex' && row.capability === 'hooks');
  const geminiHooks = map.find((row) => row.harness === 'gemini' && row.capability === 'hooks');
  assert.equal(codexHooks.status, 'supported');
  assert.ok(codexHooks.evidence.every((url) => url.startsWith('https://')));
  assert.equal(geminiHooks.status, 'unavailable');
});

test('fails closed for malformed JSON-compatible YAML', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-registry-'));
  fs.mkdirSync(path.join(root, 'core', 'registry'), { recursive: true });
  for (const file of Object.values(REGISTRY_FILES)) fs.writeFileSync(path.join(root, 'core', 'registry', file), '{}');
  fs.writeFileSync(path.join(root, 'core', 'registry', 'harnesses.yaml'), 'not: supported-yaml-without-json');
  assert.throws(() => loadRegistry({ repoRoot: root }), /JSON-compatible YAML/);
});

test('rejects projections to unavailable capabilities and missing source files', () => {
  const registry = {
    harnesses: [{ id: 'test', displayName: 'Test', adapter: 'test', scopes: ['project'], nativeTargets: {}, capabilities: {
      hooks: { status: 'unavailable', evidence: ['https://example.test/docs'], verification: 'Report the gap.' },
    } }],
    assets: [{ id: 'bad.asset', kind: 'hook', source: 'missing', appliesTo: ['test'], projection: { test: { renderer: 'test', capability: 'hooks' } }, ownership: 'managed-file' }],
    mcp: [], lifecycle: [],
  };
  const result = validateRegistry(registry, { repoRoot: REPO });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source does not exist/);
  assert.match(result.errors.join('\n'), /cannot render unavailable capability/);
});

test('fails closed when Codex native projection source metadata is missing or escapes the repository', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const invalid = structuredClone({ harnesses: registry.harnesses, assets: registry.assets, mcp: registry.mcp, lifecycle: registry.lifecycle });
  invalid.harnesses.find((harness) => harness.id === 'codex').nativeProjection.hooks.scriptsSource = '../outside';
  const result = validateRegistry(invalid, { repoRoot: REPO });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /nativeProjection hooks: source does not exist inside repository/);
});
