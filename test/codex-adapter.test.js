'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistry, selectAssets } = require('../src/registry');
const { harnessFor } = require('../src/registry');
const { projectAdapterInput } = require('../src/adapters');
const { normalizeContext, discover, render, plan, apply, remove, verify } = require('../src/adapters/codex');

const REPO = path.resolve(__dirname, '..');
const MCP = path.join(REPO, 'core', '.mcp.json');
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-codex-adapter-')); }

test('discovers native Codex locations in neutral project scope', () => {
  const projectRoot = scratch();
  const result = discover({ scope: 'project', projectRoot });
  assert.equal(result.harness, 'codex');
  assert.equal(result.config.file, path.join(projectRoot, '.codex', 'config.toml'));
  assert.equal(result.hooks.file, path.join(projectRoot, '.codex', 'hooks.json'));
  assert.equal(result.config.exists, false);
});

test('normalizes user root to ~/.codex and project root to the selected repository only', () => {
  const home = scratch();
  assert.deepEqual(normalizeContext({ scope: 'user', homeDir: home }), { scope: 'global', codexDir: path.join(home, '.codex') });
  const workspace = path.join(home, 'Workspace'); const repository = path.join(workspace, 'repo-a');
  assert.deepEqual(normalizeContext({ scope: 'project', scopeRoot: workspace, projectRoot: repository }), { scope: 'project', projectRoot: repository });
  assert.equal(discover({ scope: 'project', scopeRoot: workspace, projectRoot: repository }).config.file, path.join(repository, '.codex', 'config.toml'));
});

test('renders registry projections without making native writes', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const skill = selectAssets(registry, { harness: 'codex', capability: 'skills' })[0];
  const result = render({ registry, asset: skill });
  assert.equal(result.status, 'renderable');
  assert.equal(result.renderer, 'copy-tree');
  assert.equal(result.capability, 'skills');
});

test('plans Codex MCP through legacy-safe reconciliation and preserves foreign server bytes', () => {
  const projectRoot = scratch();
  const config = path.join(projectRoot, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const before = '[mcp_servers.personal]\ncommand = "keep"\n\n[mcp_servers.context7]\ncommand = "custom"\n';
  fs.writeFileSync(config, before);
  const result = plan({ scope: 'project', projectRoot, selectedMcp: ['context7'], mcpCatalogFile: MCP });
  assert.equal(result.ok, true);
  assert.equal(result.components.mcp.status, 'unchanged');
  assert.equal(fs.readFileSync(config, 'utf8'), before, 'planning must not alter foreign configuration');
});

test('consumes real registry-shaped projected native input and returns required native changes', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const projectRoot = scratch();
  const harness = harnessFor(registry, 'codex');
  const projected = projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: projectRoot,
    assets: selectAssets(registry, { harness: 'codex' }), mcp: registry.mcp.slice(0, 1), policies: [], context: { sourceVersion: 'test' } });
  const result = plan({ ...projected, projectRoot, projection: {
    configResources: [{ target: 'codex', kind: 'configuration-entry', identity: 'features.hooks', value: true }],
    mcp: { catalog: projected.mcp, selected: ['context7'] },
    agents: { sourceDir: path.join(REPO, 'core', 'harnesses', 'codex', 'agents') },
    hooks: { sourceFile: path.join(REPO, 'core', 'harnesses', 'codex', 'hooks', 'hooks.json'), sourceHooksDir: path.join(REPO, 'core', 'harnesses', 'codex', 'hooks') },
  } });
  assert.equal(result.ok, true);
  assert.ok(result.changes.length > 0, 'projected selected Codex capabilities must yield native changes');
  assert.ok(result.requiredNativeResources.some((resource) => resource.component === 'config' && resource.target.endsWith('.codex/config.toml')));
  assert.ok(result.requiredNativeResources.some((resource) => resource.component === 'mcp'));
  assert.ok(result.requiredNativeResources.some((resource) => resource.component === 'agents'));
  assert.ok(result.requiredNativeResources.some((resource) => resource.component === 'hooks' && resource.target.endsWith('.codex/hooks.json')));
});

test('reports unowned configuration conflicts instead of adopting or overwriting it', () => {
  const projectRoot = scratch();
  const config = path.join(projectRoot, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const before = '[features]\nhooks = false\n'; fs.writeFileSync(config, before);
  const result = plan({ scope: 'project', projectRoot, configResources: [{ target: 'codex', kind: 'configuration-entry', identity: 'features.hooks', value: true }] });
  assert.equal(result.ok, false);
  assert.equal(result.components.config.status, 'conflict');
  assert.equal(fs.readFileSync(config, 'utf8'), before);
});

test('dry planning does not write, then apply and remove use only fingerprint-proven config ownership', () => {
  const projectRoot = scratch();
  const resource = { target: 'codex', kind: 'configuration-entry', identity: 'features.hooks', value: true };
  const planned = plan({ scope: 'project', projectRoot, configResources: [resource] });
  assert.equal(planned.ok, true); assert.equal(fs.existsSync(path.join(projectRoot, '.codex', 'config.toml')), false);
  const applied = apply({ changes: planned.changes });
  assert.equal(applied.applied, 1);
  const file = path.join(projectRoot, '.codex', 'config.toml');
  assert.equal(fs.readFileSync(file, 'utf8'), '[features]\nhooks = true\n');
  const owned = applied.components.config.managedResources;
  const removal = plan({ scope: 'project', projectRoot, managedResources: owned, configResources: [resource], context: { operation: 'remove' } });
  assert.equal(removal.components.config.changes[0].type, 'remove');
  const removed = remove({ changes: removal.changes });
  assert.equal(removed.removed, 1);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /hooks = true/);
  const status = verify({ scope: 'project', projectRoot, projection: { configResources: [resource] } }).statuses[0];
  assert.deepEqual(status, { assetId: 'codex.config', capability: 'settings', status: 'missing', identity: 'features.hooks',
    ownershipIdentity: 'doflow:codex:configuration-entry:features.hooks', target: file });
});

test('shared config.toml removal removes owned config and MCP entries while preserving foreign content', () => {
  const projectRoot = scratch();
  const resource = { target: 'codex', kind: 'configuration-entry', identity: 'features.hooks', value: true };
  const catalog = [{ id: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'] }];
  const input = { scope: 'project', projectRoot, projection: { configResources: [resource], mcp: { catalog, selected: ['playwright'] } } };
  const installed = apply({ ...input, changes: plan(input).changes });
  const file = path.join(projectRoot, '.codex', 'config.toml');
  fs.appendFileSync(file, '\n[personal]\nkeep = true\n');
  const removal = plan({ ...input, ledger: { resources: installed.resources }, context: { operation: 'remove' } });
  assert.equal(removal.safe, true);
  remove({ ...input, changes: removal.changes });
  const after = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(after, /hooks = true/);
  assert.doesNotMatch(after, /mcp_servers\.playwright/);
  assert.match(after, /\[personal\]\nkeep = true/);
});

test('full apply then verify returns lifecycle-ready owned resources for projected native surfaces', () => {
  const registry = loadRegistry({ repoRoot: REPO }); const projectRoot = scratch(); const harness = harnessFor(registry, 'codex');
  const projected = projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: projectRoot,
    assets: selectAssets(registry, { harness: 'codex' }), mcp: registry.mcp.slice(0, 1), policies: [], context: { sourceVersion: 'test-v1' } });
  const input = { ...projected, projectRoot, context: { sourceVersion: 'test-v1' }, projection: {
    configResources: [{ target: 'codex', kind: 'configuration-entry', identity: 'features.hooks', value: true }],
    mcp: { catalog: projected.mcp, selected: ['context7'] }, agents: { sourceDir: path.join(REPO, 'core', 'harnesses', 'codex', 'agents') },
    hooks: { sourceFile: path.join(REPO, 'core', 'harnesses', 'codex', 'hooks', 'hooks.json'), sourceHooksDir: path.join(REPO, 'core', 'harnesses', 'codex', 'hooks') },
  } };
  const planned = plan(input); const applied = apply({ ...input, changes: planned.changes, recoveryRef: 'recovery-test' });
  assert.ok(applied.resources.length >= 1, 'apply exposes native managed records');
  const verified = verify({ ...input, registry, assets: selectAssets(registry, { harness: 'codex' }), recoveryRef: 'recovery-test' });
  assert.equal(verified.ok, true);
  for (const kind of ['configuration-entry', 'mcp-server', 'custom-agent', 'hooks-file']) assert.ok(verified.resources.some((resource) => resource.kind === kind), `missing ${kind}`);
  assert.ok(verified.resources.every((resource) => resource.harness === 'codex' && resource.scope === 'project' && resource.target && resource.fingerprint.startsWith('sha256:') && resource.sourceVersion === 'test-v1' && resource.recoveryRef === 'recovery-test'));
  const config = path.join(projectRoot, '.codex', 'config.toml');
  const edited = fs.readFileSync(config, 'utf8').replace('hooks = true', 'hooks = false'); fs.writeFileSync(config, edited);
  const conflicted = plan({ ...input, ledger: { resources: verified.resources } });
  assert.equal(conflicted.safe, false);
  assert.equal(conflicted.components.config.status, 'conflict');
  assert.equal(fs.readFileSync(config, 'utf8'), edited, 'planning a conflict must preserve user-edited bytes');
});

test('verification reports registry gaps and reconciliation conflicts', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const projectRoot = scratch();
  const proposed = plan({ scope: 'project', projectRoot, configResources: [{ target: 'codex', kind: 'configuration-entry', identity: 'features.hooks', value: true }] });
  const assets = selectAssets(registry, { harness: 'codex' });
  const result = verify({ registry, assets, discovery: discover({ scope: 'project', projectRoot }), plan: proposed, scope: 'project', projectRoot });
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.statuses));
  assert.ok(Array.isArray(result.resources));
  assert.ok(Array.isArray(result.conflicts));
});
