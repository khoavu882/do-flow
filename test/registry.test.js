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
  assert.deepEqual(Object.keys(REGISTRY_FILES), ['harnesses', 'assets', 'mcp', 'lifecycle', 'contracts']);
  // contracts.yaml declares what each harness ACCEPTS, deliberately separate from harnesses.yaml's
  // what-DoFlow-SUPPORTS: nesting them would make the registry-truth guard validate the registry
  // against itself. Every harness must have exactly one contract.
  assert.deepEqual(registry.contracts.map((c) => c.harness), ['claude', 'codex', 'gemini']);
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
  // Was asserted 'unavailable' — which pinned a factual error in the registry as expected
  // behaviour and is exactly why the contradiction survived a green suite: DoFlow has shipped a
  // Gemini hooks deployer, wired events, and a test file since v0.8.0. test/guards/registry.test.js
  // now catches this class directly by comparing the declaration against what actually deploys.
  assert.equal(geminiHooks.status, 'supported');
  assert.ok(geminiHooks.evidence.every((url) => url.startsWith('https://')));
  // Same class as the hooks entry above: declared 'unavailable' against a generic docs root while
  // Gemini CLI documents both an executable skill `scripts/` directory and a shell-execution tool.
  // The projection and the declaration must move together — validateRegistry refuses to render an
  // unavailable capability, so a half-applied change cannot load at all.
  for (const capability of ['scripts', 'templates']) {
    const row = map.find((item) => item.harness === 'gemini' && item.capability === capability);
    assert.equal(row.status, 'supported', `gemini.${capability} must not be declared unavailable while it deploys`);
    assert.ok(row.evidence.length > 0 && row.evidence.every((url) => url.startsWith('https://')));
    assert.ok(row.evidence.some((url) => url !== 'https://geminicli.com/docs/'),
      `gemini.${capability} evidence must cite a specific page, not the docs root`);
  }
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
