'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKiroAdapter, nativePaths, mergeMcpConfig, unmergeMcpConfig } = require('../src/adapters/kiro');
const { assertAdapter } = require('../src/adapters');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-kiro-')); }

function steeringAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'guidance');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'DOFLOW_CORE.md'), '# core guidance\n');
  return { id: 'guidance.context-layer', source: 'core/shared/guidance', renderer: 'copy-tree', capability: 'instructions', nativeDir: 'steering' };
}

function agentsAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'agent-specs');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'core-implementer.md'), '---\nname: core-implementer\n---\n# core-implementer\n');
  return { id: 'agents.shared', source: 'core/shared/agent-specs', renderer: 'kiro-agents', capability: 'agents', nativeDir: 'agents' };
}

function skillsAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'skills');
  fs.mkdirSync(path.join(sourceDir, 'do-analyze'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'do-analyze', 'SKILL.md'), '# do-analyze\n');
  return { id: 'skills.doflow', source: 'core/shared/skills', renderer: 'copy-tree', capability: 'skills', nativeDir: 'skills' };
}

test('implements the adapter contract and resolves official project/user native paths', () => {
  assertAdapter(createKiroAdapter(), 'Kiro');
  const root = scratch();
  const project = nativePaths({ scope: 'project', scopeRoot: root });
  assert.equal(project.steering, path.join(root, '.kiro', 'steering'));
  assert.equal(project.skills, path.join(root, '.kiro', 'skills'));
  assert.equal(project.agents, path.join(root, '.kiro', 'agents'));
  assert.equal(project.hooks, path.join(root, '.kiro', 'hooks'));
  assert.equal(project.mcp, path.join(root, '.kiro', 'settings', 'mcp.json'));

  const global = nativePaths({ scope: 'global', scopeRoot: root, homeDir: root });
  assert.equal(global.steering, path.join(root, '.kiro', 'steering'));
  assert.equal(global.skills, path.join(root, '.kiro', 'skills'));
  assert.equal(global.agents, path.join(root, '.kiro', 'agents'));
  assert.equal(global.hooks, path.join(root, '.kiro', 'hooks'));
  assert.equal(global.mcp, path.join(root, '.kiro', 'settings', 'mcp.json'));
});

test('plans, applies, and verifies the full guidance tree as steering files for project scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createKiroAdapter();
  const asset = steeringAsset(repoRoot);
  const context = { repoRoot };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.surfaces.instructions.status, 'supported');
  const change = planned.changes.find((c) => c.assetId === asset.id);
  assert.equal(change.operation, 'create');
  adapter.apply({ changes: planned.changes });
  const installed = path.join(root, '.kiro', 'steering', 'DOFLOW_CORE.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# core guidance\n');

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  const resource = verified.resources.find((r) => r.assetId === asset.id);
  assert.equal(resource.fingerprint, change.fingerprint);

  const ledger = { resources: verified.resources.map((r) => ({ harness: 'kiro', assetId: asset.id, kind: 'copy-tree-file', identity: r.identity, fingerprint: r.fingerprint })) };
  const replan = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.deepEqual(replan.changes, []);
  assert.deepEqual(replan.conflicts, []);
});

test('materialises the same steering tree under ~/.kiro/steering for global scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createKiroAdapter();
  const asset = steeringAsset(repoRoot);
  const context = { repoRoot, homeDir: root };
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  const installed = path.join(root, '.kiro', 'steering', 'DOFLOW_CORE.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# core guidance\n');
});

test('refuses to overwrite a steering file modified outside DoFlow', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createKiroAdapter();
  const asset = steeringAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const fingerprint = first.changes.find((c) => c.assetId === asset.id).fingerprint;
  const ledger = { resources: [{ harness: 'kiro', assetId: asset.id, kind: 'copy-tree-file', identity: 'DOFLOW_CORE.md', fingerprint }] };
  fs.writeFileSync(path.join(root, '.kiro', 'steering', 'DOFLOW_CORE.md'), '# tampered\n');
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.match(second.conflicts[0], /modified outside DoFlow/);
});

test('removes only fingerprint-matching steering files', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createKiroAdapter();
  const asset = steeringAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const fingerprint = first.changes.find((c) => c.assetId === asset.id).fingerprint;
  const ledger = { resources: [{ harness: 'kiro', assetId: asset.id, kind: 'copy-tree-file', identity: 'DOFLOW_CORE.md', fingerprint }] };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, '.kiro', 'steering', 'DOFLOW_CORE.md')), false);
});

test('plans, applies, and verifies the agents tree for project scope, byte-identical to the source', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createKiroAdapter();
  const asset = agentsAsset(repoRoot);
  const context = { repoRoot };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.surfaces.agents.status, 'supported');
  adapter.apply({ changes: planned.changes });
  const installed = path.join(root, '.kiro', 'agents', 'core-implementer.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(path.join(repoRoot, 'core', 'shared', 'agent-specs', 'core-implementer.md'), 'utf8'));

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  assert.ok(verified.resources.find((r) => r.assetId === asset.id));
});

test('materialises the same agents tree under ~/.kiro/agents for global scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createKiroAdapter();
  const asset = agentsAsset(repoRoot);
  const context = { repoRoot, homeDir: root };
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  const installed = path.join(root, '.kiro', 'agents', 'core-implementer.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(path.join(repoRoot, 'core', 'shared', 'agent-specs', 'core-implementer.md'), 'utf8'));
});

test('removes only fingerprint-matching agent files', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createKiroAdapter();
  const asset = agentsAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const fingerprint = first.changes.find((c) => c.assetId === asset.id).fingerprint;
  const ledger = { resources: [{ harness: 'kiro', assetId: asset.id, kind: 'copy-tree-file', identity: 'core-implementer.md', fingerprint }] };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, '.kiro', 'agents', 'core-implementer.md')), false);
});

test('a re-plan with both the steering and agents assets together produces no spurious cross-asset changes', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createKiroAdapter();
  const steering = steeringAsset(repoRoot);
  const agents = agentsAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [steering, agents], context, ledger: { resources: [] } });
  assert.equal(first.changes.length, 2);
  adapter.apply({ changes: first.changes });
  const ledger = { resources: first.changes.map((c) => ({ harness: 'kiro', assetId: c.assetId, kind: 'copy-tree-file', identity: c.identity, fingerprint: c.fingerprint })) };
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [steering, agents], context, ledger });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('skills.doflow materialises into .kiro/skills, following the dedicated Kiro skills system', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createKiroAdapter();
  const skills = skillsAsset(repoRoot);
  const context = { repoRoot };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [skills], context, ledger: { resources: [] } });
  assert.equal(planned.changes.length, 1);
  assert.deepEqual(planned.conflicts, []);
  adapter.apply({ changes: planned.changes });
  assert.equal(fs.readFileSync(path.join(root, '.kiro', 'skills', 'do-analyze', 'SKILL.md'), 'utf8'), '# do-analyze\n');

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [skills], context });
  assert.equal(verified.resources.length, 1);
  assert.deepEqual(verified.conflicts, []);
});

test('confirms the real registry routes guidance, skills, and agents trees to kiro, steering included as instructions', () => {
  const { loadRegistry, selectAssets, harnessFor } = require('../src/registry');
  const repoRoot = path.resolve(__dirname, '..');
  const registry = loadRegistry({ repoRoot });
  const harness = harnessFor(registry, 'kiro');
  assert.equal(harness.nativeTargets.instructions, '.kiro/steering/');
  assert.equal(harness.nativeTargets.skills, '.kiro/skills');
  assert.equal(harness.nativeTargets.agents, '.kiro/agents');
  assert.equal(harness.nativeTargets.hooks, '.kiro/hooks');
  assert.equal(harness.nativeTargets.mcp, '.kiro/settings/mcp.json');

  const instructions = selectAssets(registry, { harness: 'kiro', capability: 'instructions' });
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].id, 'guidance.context-layer');
  assert.equal(instructions[0].nativeDir.kiro, 'steering');

  const skills = selectAssets(registry, { harness: 'kiro', capability: 'skills' });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, 'skills.doflow');
  assert.equal(skills[0].nativeDir.kiro, 'skills');

  const agents = selectAssets(registry, { harness: 'kiro', capability: 'agents' });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'agents.shared');
});

test('mcp: merges selected servers into .kiro/settings/mcp.json, preserving a foreign server entry', () => {
  const existing = { mcpServers: { handwritten: { command: 'my-own-server' } } };
  const merged = mergeMcpConfig(existing, [{ id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }]);
  assert.deepEqual(merged.mcpServers.handwritten, { command: 'my-own-server' });
  assert.deepEqual(merged.mcpServers.context7, { command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
});

test('mcp: unmerge removes only the selected server ids, leaving foreign entries and dropping an empty key', () => {
  const merged = mergeMcpConfig({ mcpServers: { handwritten: { command: 'my-own-server' } } }, [{ id: 'context7', command: 'npx', args: ['-y', 'x'] }]);
  const unmerged = unmergeMcpConfig(merged, [{ id: 'context7', command: 'npx', args: ['-y', 'x'] }]);
  assert.deepEqual(unmerged.mcpServers, { handwritten: { command: 'my-own-server' } });

  const onlyOurs = mergeMcpConfig({}, [{ id: 'context7', command: 'npx', args: ['-y', 'x'] }]);
  const stripped = unmergeMcpConfig(onlyOurs, [{ id: 'context7', command: 'npx', args: ['-y', 'x'] }]);
  assert.equal(stripped.mcpServers, undefined);
});

test('plan/apply/verify a real mcp.json install and removal, never touching a hand-added server', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const mcpFile = path.join(root, '.kiro', MCP_FILE_FOR_TEST());
  fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { handwritten: { command: 'my-own-server' } } }, null, 2));
  const servers = [{ id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }];

  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [{ id: 'guidance.context-layer' }], mcp: servers, context: {}, ledger: { resources: [] } });
  const mcpChange = planned.changes.find((c) => c.projection?.renderer === 'kiro-mcp');
  assert.ok(mcpChange, 'expected an mcp registration change');
  adapter.apply({ changes: planned.changes });
  const written = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  assert.deepEqual(written.mcpServers.handwritten, { command: 'my-own-server' });
  assert.deepEqual(written.mcpServers.context7, { command: 'npx', args: ['-y', '@upstash/context7-mcp'] });

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [{ id: 'guidance.context-layer' }], mcp: servers, context: {} });
  assert.equal(verified.ok, true);
  assert.ok(verified.resources.find((r) => r.identity === 'context7'));

  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [{ id: 'guidance.context-layer' }], mcp: servers, context: { operation: 'remove' } });
  adapter.remove({ changes: removal.changes });
  const afterRemoval = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  assert.deepEqual(afterRemoval.mcpServers, { handwritten: { command: 'my-own-server' } });
});

function MCP_FILE_FOR_TEST() { return path.join('settings', 'mcp.json'); }

test('invalid mcp.json blocks planning but never mutates the file', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const mcpFile = path.join(root, '.kiro', 'settings', 'mcp.json');
  fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
  fs.writeFileSync(mcpFile, '{ broken');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [{ id: 'guidance.context-layer' }], mcp: [{ id: 'context7', command: 'npx' }], context: {} });
  assert.match(planned.conflicts[0], /Invalid JSON/);
  assert.equal(fs.readFileSync(mcpFile, 'utf8'), '{ broken');
});

test('hooks are reported as a pending, unpopulated surface rather than an error', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [], context: {} });
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.surfaces.hooks.status, 'pending');
  assert.equal(planned.surfaces.hooks.target, path.join(root, '.kiro', 'hooks'));
  assert.equal(fs.existsSync(planned.surfaces.hooks.target), false);

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [], mcp: [], context: {} });
  assert.equal(verified.ok, true);
  assert.equal(verified.statuses.hooks.status, 'pending');
});
