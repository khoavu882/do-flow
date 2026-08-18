'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCopilotAdapter, nativePaths, mergeMcpConfig, unmergeMcpConfig, agentFileLayout, MARKER_START } = require('../src/adapters/copilot');
const { assertAdapter } = require('../src/adapters');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-copilot-')); }
const instructionAssets = [{ id: 'guidance.codex-pointer', capability: 'instructions', source: 'source.md' }];

test('implements the adapter contract', () => {
  assertAdapter(createCopilotAdapter(), 'Copilot');
});

test('resolves official project and global native paths', () => {
  const root = scratch();
  const project = nativePaths({ scope: 'project', scopeRoot: root });
  assert.equal(project.instruction, path.join(root, '.github', 'copilot-instructions.md'));
  assert.equal(project.skills, path.join(root, '.agents', 'skills'));
  assert.equal(project.agents, path.join(root, '.github', 'agents'));
  assert.equal(project.mcp, path.join(root, '.mcp.json'));

  const global = nativePaths({ scope: 'global', scopeRoot: root, homeDir: root });
  assert.equal(global.instruction, null);
  assert.equal(global.skills, path.join(root, '.agents', 'skills'));
  assert.equal(global.agents, path.join(root, '.copilot', 'agents'));
  assert.equal(global.mcp, path.join(root, '.copilot', 'mcp-config.json'));
});

// ---- instructions (.github/copilot-instructions.md) ----

test('plans and applies a managed copilot-instructions.md section without overwriting foreign content', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const planned = adapter.plan({
    scope: 'project', scopeRoot: root, assets: instructionAssets,
    context: { repoRoot: root },
  });
  assert.equal(planned.conflicts.length, 0);
  const instructionChange = planned.changes.find((c) => c.projection?.renderer === 'copilot-instructions');
  assert.equal(instructionChange.operation, 'create');
  adapter.apply({ changes: planned.changes });
  const instruction = fs.readFileSync(path.join(root, '.github', 'copilot-instructions.md'), 'utf8');
  assert.match(instruction, /# DoFlow/);
  assert.match(instruction, new RegExp(MARKER_START));
});

test('preserves a foreign copilot-instructions.md that has no DoFlow managed section', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'copilot-instructions.md'), '# Personal instructions\n');
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const planned = adapter.plan({
    scope: 'project', scopeRoot: root, assets: instructionAssets,
    context: { repoRoot: root },
  });
  assert.match(planned.conflicts[0], /without a DoFlow managed section/);
});

test('remove strips only the managed copilot-instructions.md section, preserving foreign content on both sides', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const install = adapter.plan({ scope: 'project', scopeRoot: root, assets: instructionAssets, context: { repoRoot: root } });
  adapter.apply({ changes: install.changes });
  const managed = fs.readFileSync(path.join(root, '.github', 'copilot-instructions.md'), 'utf8');
  fs.writeFileSync(path.join(root, '.github', 'copilot-instructions.md'), `# Before notes\n${managed}# After notes\n`);
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: instructionAssets, context: { repoRoot: root, operation: 'remove' } });
  const instructionChange = removal.changes.find((c) => c.projection?.renderer === 'copilot-instructions');
  assert.equal(instructionChange.operation, 'remove');
  adapter.remove({ changes: removal.changes });
  const remaining = fs.readFileSync(path.join(root, '.github', 'copilot-instructions.md'), 'utf8');
  assert.match(remaining, /# Before notes/);
  assert.match(remaining, /# After notes/);
  assert.doesNotMatch(remaining, new RegExp(MARKER_START));
});

test('remove is a no-op on a foreign copilot-instructions.md that DoFlow never owned', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'copilot-instructions.md'), '# Personal instructions\n');
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: instructionAssets, context: { repoRoot: root, operation: 'remove' } });
  const instructionChange = removal.changes.find((c) => c.projection?.renderer === 'copilot-instructions');
  assert.equal(instructionChange, undefined);
  assert.equal(fs.readFileSync(path.join(root, '.github', 'copilot-instructions.md'), 'utf8'), '# Personal instructions\n');
});

test('global scope installs no instructions change and no conflict — Copilot has no documented global instructions file', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const planned = adapter.plan({
    scope: 'global', scopeRoot: root, assets: instructionAssets,
    context: { homeDir: root, repoRoot: root },
  });
  assert.deepEqual(planned.conflicts, []);
  assert.equal(planned.changes.find((c) => c.projection?.renderer === 'copilot-instructions'), undefined);
  assert.equal(fs.existsSync(path.join(root, '.copilot')), false);

  const verified = adapter.verify({ scope: 'global', scopeRoot: root, assets: instructionAssets, context: { homeDir: root } });
  assert.equal(verified.statuses.some((s) => s.capability === 'instructions'), false);
});

// ---- copy-tree: skills ----

function skillsAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'skills');
  fs.mkdirSync(path.join(sourceDir, 'do-analyze'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'do-analyze', 'SKILL.md'), '# do-analyze\n');
  return { id: 'skills.doflow', source: 'core/shared/skills', renderer: 'copy-tree', capability: 'skills', nativeDir: 'skills' };
}

test('Copilot adapter materialises skills under .agents/skills for project scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
  const asset = skillsAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  assert.equal(first.conflicts.length, 0);
  const skillChange = first.changes.find((c) => c.assetId === asset.id);
  assert.ok(skillChange, 'expected a skills.doflow change');
  adapter.apply({ changes: first.changes });
  const installed = path.join(root, '.agents', 'skills', 'do-analyze', 'SKILL.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# do-analyze\n');

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  const skillResource = verified.resources.find((r) => r.assetId === asset.id);
  assert.ok(skillResource, 'expected a skills.doflow resource');
  assert.equal(skillResource.fingerprint, skillChange.fingerprint);

  const ledger = { resources: verified.resources
    .filter((r) => r.assetId === asset.id)
    .map((r) => ({ harness: 'copilot', assetId: asset.id, kind: 'copy-tree-file', identity: r.identity, fingerprint: r.fingerprint })) };
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('Copilot adapter materialises the same skills tree under ~/.agents/skills for global scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
  const asset = skillsAsset(repoRoot);
  const context = { repoRoot, homeDir: root };
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  const installed = path.join(root, '.agents', 'skills', 'do-analyze', 'SKILL.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# do-analyze\n');
});

test('Copilot adapter refuses to overwrite a skill file modified outside DoFlow', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
  const asset = skillsAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const skillFingerprint = first.changes.find((c) => c.assetId === asset.id).fingerprint;
  const ledger = { resources: [{ harness: 'copilot', assetId: asset.id, kind: 'copy-tree-file', identity: 'do-analyze/SKILL.md', fingerprint: skillFingerprint }] };
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'do-analyze', 'SKILL.md'), '# tampered\n');
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.match(second.conflicts[0], /modified outside DoFlow/);
});

test('Copilot adapter removes only fingerprint-matching skill files', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
  const asset = skillsAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const skillFingerprint = first.changes.find((c) => c.assetId === asset.id).fingerprint;
  const ledger = { resources: [{ harness: 'copilot', assetId: asset.id, kind: 'copy-tree-file', identity: 'do-analyze/SKILL.md', fingerprint: skillFingerprint }] };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'do-analyze', 'SKILL.md')), false);
});

// ---- copy-tree: agents (renamed to .agent.md on the way out) ----

function agentsAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'agent-specs');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'core-implementer.md'), '---\nname: core-implementer\ndescription: "Specialist"\n---\n\n# core-implementer\n');
  return { id: 'agents.shared', source: 'core/shared/agent-specs', renderer: 'copilot-agents', capability: 'agents', nativeDir: 'agents' };
}

test('agentFileLayout renames a flat agent-spec file to the .agent.md extension Copilot requires', () => {
  assert.equal(agentFileLayout('core-implementer.md'), 'core-implementer.agent.md');
  assert.equal(agentFileLayout(path.join('nested', 'spec-analyst.md')), path.join('nested', 'spec-analyst.agent.md'));
});

test('Copilot adapter materialises agent specs as .agent.md under .github/agents for project scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
  const asset = agentsAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  assert.equal(first.conflicts.length, 0);
  const agentChange = first.changes.find((c) => c.assetId === asset.id);
  assert.ok(agentChange, 'expected an agents.shared change');
  adapter.apply({ changes: first.changes });
  const installed = path.join(root, '.github', 'agents', 'core-implementer.agent.md');
  assert.ok(fs.existsSync(installed), 'expected the renamed .agent.md file to exist');
  assert.match(fs.readFileSync(installed, 'utf8'), /name: core-implementer/);
  assert.equal(fs.existsSync(path.join(root, '.github', 'agents', 'core-implementer.md')), false);

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  const agentResource = verified.resources.find((r) => r.assetId === asset.id);
  assert.ok(agentResource);
  assert.equal(agentResource.identity, 'core-implementer.agent.md');

  const ledger = { resources: verified.resources
    .filter((r) => r.assetId === asset.id)
    .map((r) => ({ harness: 'copilot', assetId: asset.id, kind: 'copy-tree-file', identity: r.identity, fingerprint: r.fingerprint })) };
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('Copilot adapter materialises agent specs under ~/.copilot/agents for global scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
  const asset = agentsAsset(repoRoot);
  const context = { repoRoot, homeDir: root };
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  const installed = path.join(root, '.copilot', 'agents', 'core-implementer.agent.md');
  assert.ok(fs.existsSync(installed));
});

test('Copilot adapter refuses to overwrite an agent file modified outside DoFlow', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
  const asset = agentsAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const agentFingerprint = first.changes.find((c) => c.assetId === asset.id).fingerprint;
  const ledger = { resources: [{ harness: 'copilot', assetId: asset.id, kind: 'copy-tree-file', identity: 'core-implementer.agent.md', fingerprint: agentFingerprint }] };
  fs.writeFileSync(path.join(root, '.github', 'agents', 'core-implementer.agent.md'), '# tampered\n');
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.match(second.conflicts[0], /modified outside DoFlow/);
});

test('Copilot adapter removes only fingerprint-matching agent files', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
  const asset = agentsAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const agentFingerprint = first.changes.find((c) => c.assetId === asset.id).fingerprint;
  const ledger = { resources: [{ harness: 'copilot', assetId: asset.id, kind: 'copy-tree-file', identity: 'core-implementer.agent.md', fingerprint: agentFingerprint }] };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, '.github', 'agents', 'core-implementer.agent.md')), false);
});

// ---- mcp (.mcp.json project / ~/.copilot/mcp-config.json global) ----

test('mergeMcpConfig writes only the selected servers under mcpServers, preserving foreign entries', () => {
  const existing = { mcpServers: { 'user-server': { command: 'user-cmd' } } };
  const next = mergeMcpConfig(existing, { mcpServers: [{ id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }] });
  assert.deepEqual(next.mcpServers['user-server'], { command: 'user-cmd' });
  assert.deepEqual(next.mcpServers.context7, { command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
});

test('unmergeMcpConfig removes only what mergeMcpConfig added, dropping an empty mcpServers key', () => {
  const merged = mergeMcpConfig({}, { mcpServers: [{ id: 'context7', command: 'npx' }] });
  const next = unmergeMcpConfig(merged, { mcpServers: [{ id: 'context7', command: 'npx' }] });
  assert.equal(next.mcpServers, undefined);
});

test('unmergeMcpConfig preserves a foreign server entry (e.g. one Claude Code\'s own adapter wrote to the same .mcp.json)', () => {
  const merged = mergeMcpConfig({ mcpServers: { claude_own: { command: 'claude-thing' } } }, { mcpServers: [{ id: 'context7', command: 'npx' }] });
  const next = unmergeMcpConfig(merged, { mcpServers: [{ id: 'context7', command: 'npx' }] });
  assert.deepEqual(next.mcpServers, { claude_own: { command: 'claude-thing' } });
});

test('plan folds an mcp merge into a single .mcp.json change for project scope', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [{ id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }] });
  const mcpChange = planned.changes.find((c) => c.projection?.renderer === 'copilot-mcp');
  assert.ok(mcpChange, 'expected a copilot.mcp change');
  assert.equal(mcpChange.target, path.join(root, '.mcp.json'));
  const written = JSON.parse(mcpChange.content);
  assert.deepEqual(written.mcpServers.context7, { command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
});

test('plan targets ~/.copilot/mcp-config.json for global scope', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [], mcp: [{ id: 'context7', command: 'npx' }], context: { homeDir: root } });
  const mcpChange = planned.changes.find((c) => c.projection?.renderer === 'copilot-mcp');
  assert.equal(mcpChange.target, path.join(root, '.copilot', 'mcp-config.json'));
});

test('apply then remove round-trips .mcp.json, preserving a foreign server entry throughout', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'user-server': { command: 'user-cmd' } } }, null, 2));
  const server = { id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };

  const install = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [server] });
  adapter.apply({ changes: install.changes });
  let onDisk = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.ok(onDisk.mcpServers.context7);
  assert.deepEqual(onDisk.mcpServers['user-server'], { command: 'user-cmd' });

  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [server], context: { operation: 'remove' } });
  const mcpChange = removal.changes.find((c) => c.projection?.renderer === 'copilot-mcp');
  assert.equal(mcpChange.operation, 'remove');
  adapter.remove({ changes: removal.changes });
  onDisk = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.equal(onDisk.mcpServers.context7, undefined);
  assert.deepEqual(onDisk.mcpServers['user-server'], { command: 'user-cmd' });
});

test('invalid mcp json blocks planning but never mutates the file', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  fs.writeFileSync(path.join(root, '.mcp.json'), '{ broken');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [{ id: 'context7', command: 'npx' }] });
  assert.match(planned.conflicts[0], /Invalid JSON/);
  assert.equal(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'), '{ broken');
});
