'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REGISTRY_FILES, COPY_TREE_SELECTS, loadRegistry, validateRegistry, selectAssets, selectMcpServers, mcpCapable, capabilityMapData,
} = require('../../src/registry/index.ts');
const { SELECTORS } = require('../../src/adapters/copy-tree.ts');
const { projectAdapterInput } = require('../../src/adapters/index.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, "../..");

test('loads and validates the complete multi-harness registry', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(registry.harnesses.map((item: any) => item.id), ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']);
  assert.deepEqual(Object.keys(REGISTRY_FILES), ['harnesses', 'assets', 'mcp', 'lifecycle', 'contracts', 'externalTools', 'models']);
  // contracts.json declares what each harness ACCEPTS, deliberately separate from harnesses.json's
  // what-DoFlow-SUPPORTS: nesting them would make the registry-truth guard validate the registry
  // against itself. Every harness must have exactly one contract.
  assert.deepEqual(registry.contracts.map((c: any) => c.harness), ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']);
  assert.equal(registry.validation.ok, true);
  assert.deepEqual(registry.harnesses.find((harness: any) => harness.id === 'codex').nativeProjection.config.resources,
    [{ kind: 'configuration-entry', identity: 'features.hooks', value: true }]);
  assert.deepEqual(registry.externalTools.map((tool: any) => tool.id), ['rtk', 'graphify', 'semble', 'mermaid-cli', 'plantuml']);
});

test('registry copy-tree select names stay in sync with the adapter selector table', () => {
  assert.deepEqual([...COPY_TREE_SELECTS].sort(), Object.keys(SELECTORS).sort());
});

test('adapter input carries the projection select name', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const harness = registry.harnesses.find((item: any) => item.id === 'claude');
  const asset = registry.assets.find((item: any) => item.appliesTo.includes('claude')
    && item.projection?.claude?.renderer === 'copy-tree');
  asset.projection.claude.select = 'guidance-manifest';

  const input = projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: REPO, assets: [asset] });
  assert.equal(input.assets[0].select, 'guidance-manifest');
});

test('registry rejects select on non-copy-tree projections and unknown selector names with asset and harness', () => {
  const registry = loadRegistry({ repoRoot: REPO });

  const wrongRenderer = structuredClone(registry);
  const nonCopyAsset = wrongRenderer.assets.find((asset: any) => asset.appliesTo.includes('claude')
    && asset.projection?.claude?.renderer !== 'copy-tree');
  assert.ok(nonCopyAsset, 'fixture must contain a non-copy-tree Claude projection');
  nonCopyAsset.projection.claude.select = 'guidance-manifest';
  const wrongRendererResult = validateRegistry(wrongRenderer, { repoRoot: REPO });
  assert.equal(wrongRendererResult.ok, false);
  assert.match(wrongRendererResult.errors.join('\n'), new RegExp(`asset '${nonCopyAsset.id}'.*projection 'claude'.*select`));

  const unknownSelector = structuredClone(registry);
  const copyTreeAsset = unknownSelector.assets.find((asset: any) => asset.appliesTo.includes('claude')
    && asset.projection?.claude?.renderer === 'copy-tree');
  assert.ok(copyTreeAsset, 'fixture must contain a copy-tree Claude projection');
  copyTreeAsset.projection.claude.select = 'nope';
  const unknownSelectorResult = validateRegistry(unknownSelector, { repoRoot: REPO });
  assert.equal(unknownSelectorResult.ok, false);
  assert.match(unknownSelectorResult.errors.join('\n'), new RegExp(`asset '${copyTreeAsset.id}'.*projection 'claude'.*select.*guidance-manifest`));
});

test('loads evidence-backed external tool definitions with argument-vector commands only', () => {
  const { externalTools } = loadRegistry({ repoRoot: REPO });
  const rtk = externalTools.find((tool: any) => tool.id === 'rtk');
  const graphify = externalTools.find((tool: any) => tool.id === 'graphify');
  const semble = externalTools.find((tool: any) => tool.id === 'semble');

  assert.deepEqual(rtk.status.commands, [['rtk', '--version'], ['rtk', 'gain']]);
  assert.deepEqual(rtk.install.command, ['cargo', 'install', '--git', 'https://github.com/rtk-ai/rtk', '--branch', 'master', 'rtk']);
  assert.equal(rtk.update, undefined, 'RTK has no verified update command');
  assert.deepEqual(graphify.prerequisites, ['uv']);
  assert.deepEqual(graphify.install.command, ['uv', 'tool', 'install', 'graphifyy']);
  assert.deepEqual(graphify.update.command, ['uv', 'tool', 'upgrade', 'graphifyy']);
  assert.deepEqual(graphify.uninstall.command, ['uv', 'tool', 'uninstall', 'graphifyy']);
  assert.deepEqual(semble.prerequisites, ['uv']);
  assert.deepEqual(semble.install.command, ['uv', 'tool', 'install', 'semble']);
  assert.deepEqual(semble.update.command, ['uv', 'tool', 'upgrade', 'semble']);
  assert.deepEqual(semble.uninstall.command, ['uv', 'tool', 'uninstall', 'semble']);
  for (const tool of externalTools) {
    assert.ok(tool.officialEvidence.every((url: any) => url.startsWith('https://')));
    assert.ok(tool.status.commands.every((command: any) => Array.isArray(command) && command.every((argument) => typeof argument === 'string')));
  }
});

test('rejects malformed external tool provenance, identifiers, and command arrays', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const invalid = structuredClone(registry);
  invalid.externalTools[0].id = 'unknown-tool';
  invalid.externalTools[0].officialEvidence = ['http://example.test'];
  invalid.externalTools[0].status.commands = ['rtk --version'];
  invalid.externalTools[1].install.command = 'uv tool install graphifyy';

  const result = validateRegistry(invalid, { repoRoot: REPO });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /id must be one of: rtk, graphify/);
  assert.match(result.errors.join('\n'), /HTTPS officialEvidence URLs/);
  assert.match(result.errors.join('\n'), /command must be a non-empty array of non-empty strings/);
});

test('selects only renderable harness assets and filters by capability', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const codex = selectAssets(registry, { harness: 'codex' });
  assert.ok(codex.some((asset: any) => asset.id === 'skills.doflow'));
  assert.ok(!codex.some((asset: any) => asset.id === 'modes.doflow'));
  assert.deepEqual(selectAssets(registry, { harness: 'codex', capability: 'skills' }).map((asset: any) => asset.id), ['skills.doflow']);
  assert.throws(() => selectAssets(registry, { harness: 'unknown' }), /Unknown registry harness/);
});

test('selects the neutral MCP catalog and rejects unknown selections', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(selectMcpServers(registry).length, 2);
  assert.deepEqual(selectMcpServers(registry, ['context7', 'sequential-thinking']).map((item: any) => item.id), ['context7', 'sequential-thinking']);
  assert.throws(() => selectMcpServers(registry, ['unknown']), /Unknown registry MCP server/);
});

test('mcpCapable names every harness that takes the shared MCP catalog, and not gemini', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(registry.harnesses.map((item: any) => item.id).filter((id: any) => mcpCapable(registry, id)),
    ['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']);
  assert.throws(() => mcpCapable(registry, 'unknown'), /Unknown registry harness/);
});

test('generates capability-map records with evidence and explicit gaps', () => {
  const map = capabilityMapData(loadRegistry({ repoRoot: REPO }));
  const codexHooks = map.find((row: any) => row.harness === 'codex' && row.capability === 'hooks');
  const geminiHooks = map.find((row: any) => row.harness === 'gemini' && row.capability === 'hooks');
  assert.equal(codexHooks.status, 'supported');
  assert.ok(codexHooks.evidence.every((url: any) => url.startsWith('https://')));
  // Was asserted 'unavailable' — which pinned a factual error in the registry as expected
  // behaviour and is exactly why the contradiction survived a green suite: DoFlow has shipped a
  // Gemini hooks deployer, wired events, and a test file since v0.8.0. test/guards/registry.test.js
  // now catches this class directly by comparing the declaration against what actually deploys.
  assert.equal(geminiHooks.status, 'supported');
  assert.ok(geminiHooks.evidence.every((url: any) => url.startsWith('https://')));
  // Same class as the hooks entry above: declared 'unavailable' against a generic docs root while
  // Gemini CLI documents both an executable skill `scripts/` directory and a shell-execution tool.
  // The projection and the declaration must move together — validateRegistry refuses to render an
  // unavailable capability, so a half-applied change cannot load at all.
  for (const capability of ['scripts', 'templates']) {
    const row = map.find((item: any) => item.harness === 'gemini' && item.capability === capability);
    assert.equal(row.status, 'supported', `gemini.${capability} must not be declared unavailable while it deploys`);
    assert.ok(row.evidence.length > 0 && row.evidence.every((url: any) => url.startsWith('https://')));
    assert.ok(row.evidence.some((url: any) => url !== 'https://geminicli.com/docs/'),
      `gemini.${capability} evidence must cite a specific page, not the docs root`);
  }
});

test('fails closed for malformed JSON', (t) => {
  const root = tempDir(t, 'doflow-registry-');
  fs.mkdirSync(path.join(root, 'core', 'registry'), { recursive: true });
  for (const file of Object.values(REGISTRY_FILES)) fs.writeFileSync(path.join(root, 'core', 'registry', file), '{}');
  fs.writeFileSync(path.join(root, 'core', 'registry', 'harnesses.json'), '{not valid json');
  assert.throws(() => loadRegistry({ repoRoot: root }), /not valid JSON/);
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
  invalid.harnesses.find((harness: any) => harness.id === 'codex').nativeProjection.hooks.scriptsSource = '../outside';
  const result = validateRegistry(invalid, { repoRoot: REPO });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /nativeProjection hooks: source does not exist inside repository/);
});

// ---- 062 A.1: MCP steps/triggers, provider MCP descriptors, tool-name templates, dispatch tiers ----

const errorsOf = (mutate: any) => {
  const invalid = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(invalid);
  const result = validateRegistry(invalid, { repoRoot: REPO });
  assert.equal(result.ok, false);
  return result.errors.join('\n');
};

test('the shipped registry declares a trigger and steps on every MCP server, and loads', () => {
  const { mcp } = loadRegistry({ repoRoot: REPO });
  for (const server of mcp) {
    assert.match(server.trigger, /^[^\n]{20,300}$/, `${server.id} trigger`);
    assert.ok(Array.isArray(server.steps), `${server.id} steps`);
  }
  assert.deepEqual(mcp.find((s: any) => s.id === 'context7').steps.map((s: any) => [s.skill, s.file, s.expectedWhen]),
    [
      ['do-brainstorm', 'SKILL.md', undefined],
      ['do-design', 'SKILL.md', undefined],
      ['do-document', 'references/embedded-research.md', 'research-request'],
      ['do-document', 'references/embedded-research.md', 'dependency-change'],
      ['do-diagnose', 'SKILL.md', 'dependency-change'],
      ['do-implement', 'SKILL.md', 'dependency-change'],
      ['do-code-review', 'SKILL.md', 'manifest-review'],
    ]);
  assert.deepEqual(mcp.find((s: any) => s.id === 'sequential-thinking').steps.map((s: any) => [s.skill, s.file]),
    [['do-brainstorm', 'SKILL.md'], ['do-design', 'SKILL.md']]);
});

test('MCP servers: a missing or malformed trigger or steps fails load naming the server', () => {
  const trigger = 'x'.repeat(40);
  assert.match(errorsOf((r: any) => { delete r.mcp[0].trigger; }), /MCP server 'context7': trigger/);
  assert.match(errorsOf((r: any) => { r.mcp[0].trigger = 'x'.repeat(301); }), /MCP server 'context7': trigger/);
  assert.match(errorsOf((r: any) => { r.mcp[0].trigger = 'short'; }), /MCP server 'context7': trigger/);
  assert.match(errorsOf((r: any) => { r.mcp[1].trigger = `${trigger}\n${trigger}`; }), /MCP server 'sequential-thinking': trigger/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps = 'do-design'; }), /MCP server 'context7': steps must be an array/);
  assert.match(errorsOf((r: any) => { delete r.mcp[0].steps; }), /MCP server 'context7': steps must be an array/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps[0].extra = true; }), /MCP server 'context7': .*unknown key 'extra'/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps[0].skill = ''; }), /MCP server 'context7': .*skill/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps[0].file = ''; }), /MCP server 'context7': .*file/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps.push({ ...r.mcp[0].steps[0] }); }), /MCP server 'context7': .*duplicate/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps[0].expectedWhen = 'always'; }), /MCP server 'context7': .*expectedWhen/);
  // An empty steps array is legal.
  const ok = structuredClone(loadRegistry({ repoRoot: REPO }));
  ok.mcp[1].steps = [];
  assert.equal(validateRegistry(ok, { repoRoot: REPO }).ok, true);
});

test('loadRegistry throws on a registry directory whose mcp.json lacks steps', (t) => {
  const root = tempDir(t, 'doflow-registry-steps-');
  fs.cpSync(path.join(REPO, 'core'), path.join(root, 'core'), { recursive: true });
  const file = path.join(root, 'core', 'registry', 'mcp.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete doc.servers[0].steps;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => loadRegistry({ repoRoot: root }), /MCP server 'context7': steps must be an array/);
});

test('capability providers: the two MCP-backed providers carry an mcp descriptor; a bad one fails', () => {
  const { capabilities } = loadRegistry({ repoRoot: REPO });
  const withMcp = Object.values(capabilities).flatMap((c: any) => c.providers).filter((p) => p.mcp);
  assert.deepEqual(withMcp.map((p) => [p.id, p.mcp]), [
    ['semble.search', { server: 'semble', tool: 'search' }],
    ['graphify.query', { server: 'graphify', tool: 'query_graph' }],
    ['graphify.query', { server: 'graphify', tool: 'query_graph' }],
  ]);
  const first = (r: any) => Object.values(r.capabilities).flatMap((c: any) => c.providers).find((p) => p.mcp);
  assert.match(errorsOf((r: any) => { first(r).mcp.server = ''; }), /provider 'semble.search'.*mcp\.server/);
  assert.match(errorsOf((r: any) => { first(r).mcp.tool = 'bad tool!'; }), /provider 'semble.search'.*mcp\.tool/);
  assert.match(errorsOf((r: any) => { delete first(r).mcp.tool; }), /provider 'semble.search'.*mcp\.tool/);
  assert.match(errorsOf((r: any) => { first(r).mcp = 'semble'; }), /provider 'semble.search'.*mcp must be an object/);
});

test('capability providers: every provider declares sourceMode live|index; a missing or bad one fails (068)', () => {
  const { capabilities } = loadRegistry({ repoRoot: REPO });
  const providers = Object.values(capabilities).flatMap((c: any) => c.providers);
  for (const provider of providers) assert.ok(['live', 'index'].includes(provider.sourceMode), `${provider.id} sourceMode`);
  assert.deepEqual([...new Set(providers.filter((p) => p.sourceMode === 'index').map((p) => p.id))].sort(), ['graphify.query', 'semble.search']);
  const first = (r: any) => (Object.values(r.capabilities)[0] as any).providers[0];
  assert.match(errorsOf((r: any) => { delete first(r).sourceMode; }), /provider 'native.rg'.*sourceMode is required.*live, index.*got nothing/);
  assert.match(errorsOf((r: any) => { first(r).sourceMode = 'cached'; }), /provider 'native.rg'.*sourceMode.*got "cached"/);
});

test('harness capabilities.mcp.toolName: claude declares a template; one lacking a placeholder fails', () => {
  const { harnesses } = loadRegistry({ repoRoot: REPO });
  assert.equal(harnesses.find((h: any) => h.id === 'claude').capabilities.mcp.toolName, 'mcp__{server}__{tool}');
  assert.equal(harnesses.filter((h: any) => h.capabilities.mcp?.toolName !== undefined).length, 1);
  const claude = (r: any) => r.harnesses.find((h: any) => h.id === 'claude').capabilities.mcp;
  assert.match(errorsOf((r: any) => { claude(r).toolName = 'mcp__{server}'; }), /harness 'claude'.*toolName/);
  assert.match(errorsOf((r: any) => { claude(r).toolName = 'mcp__{tool}'; }), /harness 'claude'.*toolName/);
  assert.match(errorsOf((r: any) => { claude(r).toolName = '{server}__{tool}__{other}'; }), /harness 'claude'.*toolName/);
  assert.match(errorsOf((r: any) => { claude(r).toolName = 7; }), /harness 'claude'.*toolName/);
});

test('models.json dispatchTiers: shipped values load; a default or owner tier outside tiers fails', () => {
  const { dispatchTiers } = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(dispatchTiers, {
    tiers: ['light', 'standard', 'frontier'],
    default: 'standard',
    byOwner: { 'system-architect': 'frontier', 'core-implementer': 'standard', 'quality-guardian': 'standard', 'spec-analyst': 'standard', 'research-writer': 'standard', 'delivery-lead': 'frontier', reviewer: 'frontier' },
  });
  assert.match(errorsOf((r: any) => { r.dispatchTiers.default = 'heavy'; }), /dispatchTiers.*default/);
  assert.match(errorsOf((r: any) => { r.dispatchTiers.byOwner['core-implementer'] = 'heavy'; }), /dispatchTiers.*core-implementer/);
  assert.match(errorsOf((r: any) => { r.dispatchTiers.tiers = []; }), /dispatchTiers.*tiers/);
  assert.match(errorsOf((r: any) => { r.dispatchTiers.byOwner = []; }), /dispatchTiers.*byOwner/);
});
