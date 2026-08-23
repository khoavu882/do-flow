'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOpenCodeAdapter, nativePaths, mergeConfig, unmergeConfig, MARKER_START } = require('../../../src/adapters/opencode');
const { assertAdapter } = require('../../../src/adapters');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-opencode-')); }
const instructionAssets = [{ id: 'guidance.codex-pointer', capability: 'instructions', source: 'source.md' }];

test('implements the adapter contract and resolves official project/user native paths', () => {
  assertAdapter(createOpenCodeAdapter(), 'OpenCode');
  const root = scratch();
  const project = nativePaths({ scope: 'project', scopeRoot: root });
  assert.equal(project.instruction, path.join(root, 'AGENTS.md'));
  assert.equal(project.config, path.join(root, 'opencode.json'));
  const global = nativePaths({ scope: 'global', scopeRoot: root, homeDir: root });
  assert.equal(global.instruction, path.join(root, '.config', 'opencode', 'AGENTS.md'));
  assert.equal(global.config, path.join(root, '.config', 'opencode', 'opencode.json'));
});

test('plans and applies a managed AGENTS.md section without overwriting foreign content', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const planned = adapter.plan({
    scope: 'project', scopeRoot: root, assets: instructionAssets,
    context: { repoRoot: root },
  });
  assert.equal(planned.conflicts.length, 0);
  const instructionChange = planned.changes.find((c) => c.projection?.renderer === 'opencode-instructions');
  assert.equal(instructionChange.operation, 'create');
  adapter.apply({ changes: planned.changes });
  const instruction = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(instruction, /# DoFlow/);
  assert.match(instruction, new RegExp(MARKER_START));
});

test('preserves a foreign AGENTS.md that has no DoFlow managed section', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Personal instructions\n');
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const planned = adapter.plan({
    scope: 'project', scopeRoot: root, assets: instructionAssets,
    context: { repoRoot: root },
  });
  assert.match(planned.conflicts[0], /without a DoFlow managed section/);
});

test('mergeConfig registers instructions and mcp only — no skills array entry', () => {
  const next = mergeConfig({}, { mcpServers: [{ id: 'context7', command: 'context7-server' }] });
  assert.deepEqual(next.instructions, ['AGENTS.md']);
  assert.equal(next.skills, undefined);
  assert.deepEqual(next.mcp.context7, { type: 'local', command: ['context7-server'], enabled: true });
});

test('unmergeConfig removes only what mergeConfig added, dropping empty arrays', () => {
  const merged = mergeConfig({ instructions: ['CUSTOM.md'] }, { mcpServers: [{ id: 'context7', command: 'context7-server' }] });
  const next = unmergeConfig(merged, { mcpServers: [{ id: 'context7', command: 'context7-server' }] });
  assert.deepEqual(next.instructions, ['CUSTOM.md']);
  assert.equal(next.mcp, undefined);
});

test('plan folds config registration into a single opencode.json change with no skills key', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [{ id: 'context7', command: 'context7-server' }] });
  const configChange = planned.changes.find((c) => c.projection?.renderer === 'opencode-config');
  assert.ok(configChange, 'expected an opencode.config change');
  const written = JSON.parse(configChange.content);
  assert.deepEqual(written.instructions, ['AGENTS.md']);
  assert.equal(written.skills, undefined);
  assert.ok(written.mcp.context7);
});

test('invalid opencode.json blocks planning but never mutates the file', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  fs.writeFileSync(path.join(root, 'opencode.json'), '{ broken');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [{ id: 'context7', command: 'context7-server' }] });
  assert.match(planned.conflicts[0], /Invalid JSON/);
  assert.equal(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'), '{ broken');
});

function copyTreeAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'skills');
  fs.mkdirSync(path.join(sourceDir, 'do-analyze'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'do-analyze', 'SKILL.md'), '# do-analyze\n');
  return { id: 'skills.doflow', source: 'core/shared/skills', renderer: 'copy-tree', capability: 'skills', nativeDir: 'skills' };
}

test('OpenCode adapter materialises skills under .opencode/skills for project scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createOpenCodeAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  assert.equal(first.conflicts.length, 0);
  // opencode.config also changes (mergeConfig always registers AGENTS.md in `instructions`), so the
  // copy-tree change is found by assetId rather than assumed to be the only or first entry.
  const skillChange = first.changes.find((c) => c.assetId === asset.id && c.kind === 'copy-tree-file');
  assert.ok(skillChange, 'expected a skills.doflow change');
  adapter.apply({ changes: first.changes });
  const installed = path.join(root, '.opencode', 'skills', 'do-analyze', 'SKILL.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# do-analyze\n');

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  // Filter by kind, not just assetId: the config/mcp pseudo-change piggybacks on a real asset's id
  // (see opencode/index.js's pseudoAssetId), so it can share an assetId with this test's own single
  // copy-tree asset. `kind: 'copy-tree-file'` is the actual discriminator ledgerFileResources() uses
  // in production — matching it here keeps this test correct regardless of that id collision.
  const skillResource = verified.resources.find((r) => r.assetId === asset.id && r.kind === 'copy-tree-file');
  assert.ok(skillResource, 'expected a skills.doflow resource');
  assert.equal(skillResource.fingerprint, skillChange.fingerprint);

  const ledger = { resources: verified.resources
    .filter((r) => r.assetId === asset.id && r.kind === 'copy-tree-file')
    .map((r) => ({ harness: 'opencode', assetId: asset.id, kind: 'copy-tree-file', identity: r.identity, fingerprint: r.fingerprint })) };
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('OpenCode adapter materialises the same skills tree under ~/.config/opencode/skills for global scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createOpenCodeAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot, homeDir: root };
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  const installed = path.join(root, '.config', 'opencode', 'skills', 'do-analyze', 'SKILL.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# do-analyze\n');
});

test('OpenCode adapter refuses to overwrite a skill file modified outside DoFlow', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createOpenCodeAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const skillFingerprint = first.changes.find((c) => c.assetId === asset.id && c.kind === 'copy-tree-file').fingerprint;
  const ledger = { resources: [{ harness: 'opencode', assetId: asset.id, kind: 'copy-tree-file', identity: 'do-analyze/SKILL.md', fingerprint: skillFingerprint }] };
  fs.writeFileSync(path.join(root, '.opencode', 'skills', 'do-analyze', 'SKILL.md'), '# tampered\n');
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.match(second.conflicts[0], /modified outside DoFlow/);
});

test('OpenCode adapter removes only fingerprint-matching copy-tree files', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createOpenCodeAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const skillFingerprint = first.changes.find((c) => c.assetId === asset.id && c.kind === 'copy-tree-file').fingerprint;
  const ledger = { resources: [{ harness: 'opencode', assetId: asset.id, kind: 'copy-tree-file', identity: 'do-analyze/SKILL.md', fingerprint: skillFingerprint }] };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, '.opencode', 'skills', 'do-analyze', 'SKILL.md')), false);
});

test('remove strips only the managed AGENTS.md section, preserving foreign content on both sides', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const install = adapter.plan({ scope: 'project', scopeRoot: root, assets: instructionAssets, context: { repoRoot: root } });
  adapter.apply({ changes: install.changes });
  const managed = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `# Before notes\n${managed}# After notes\n`);
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: instructionAssets, context: { repoRoot: root, operation: 'remove' } });
  const instructionChange = removal.changes.find((c) => c.projection?.renderer === 'opencode-instructions');
  assert.equal(instructionChange.operation, 'remove');
  adapter.remove({ changes: removal.changes });
  const remaining = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(remaining, /# Before notes/);
  assert.match(remaining, /# After notes/);
  assert.doesNotMatch(remaining, new RegExp(MARKER_START));
});

test('remove is a no-op on a foreign AGENTS.md that DoFlow never owned', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Personal instructions\n');
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: instructionAssets, context: { repoRoot: root, operation: 'remove' } });
  const instructionChange = removal.changes.find((c) => c.projection?.renderer === 'opencode-instructions');
  assert.equal(instructionChange, undefined);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Personal instructions\n');
});

test('agents.shared projects transformed OpenCode markdown agents and reclaims them on remove', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  const specsDir = path.join(root, 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, 'spec-analyst.md'),
    '---\nname: spec-analyst\ndescription: "Requirements specialist"\ntools: Read, Grep\nmodel: inherit\neffort: high\n---\n\n# spec-analyst\n');
  fs.writeFileSync(path.join(specsDir, 'core-implementer.md'),
    '---\nname: core-implementer\ndescription: "Implementation specialist"\n---\n\n# core-implementer\n');
  const assets = [{
    id: 'agents.shared', kind: 'agents', source: 'specs',
    renderer: 'opencode-agents', capability: 'agents',
    nativeDir: 'agents', layout: null, transform: 'opencode-agents',
  }];

  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { repoRoot: root }, ledger: null });
  const agentChanges = planned.changes.filter((c) => c.assetId === 'agents.shared' && c.kind === 'copy-tree-file');
  assert.equal(agentChanges.length, 2);
  assert.ok(agentChanges.every((c) => c.target.startsWith(path.join(root, '.opencode', 'agents'))),
    'agents materialise under .opencode/agents at project scope');

  adapter.apply({ changes: planned.changes });
  const analyst = fs.readFileSync(path.join(root, '.opencode', 'agents', 'spec-analyst.md'), 'utf8');
  assert.match(analyst, /^---\ndescription: "Requirements specialist"\nmode: subagent\npermission:\n  edit: deny\n  bash: deny\n---/);
  assert.doesNotMatch(analyst, /tools:|model:|effort:/, 'spec vocabulary OpenCode does not define must not leak through');
  const implementer = fs.readFileSync(path.join(root, '.opencode', 'agents', 'core-implementer.md'), 'utf8');
  assert.match(implementer, /mode: subagent/);
  assert.doesNotMatch(implementer, /permission:/, 'the write-capable archetype inherits host defaults');

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets, context: { repoRoot: root } });
  const agentStatus = verified.statuses.find((s) => s.assetId === 'agents.shared' && s.capability === 'agents');
  assert.equal(agentStatus.status, 'managed');

  const removalPlan = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { repoRoot: root, operation: 'remove' }, ledger: verifiedLedger(verified) , removing: true });
  adapter.remove({ changes: removalPlan.changes });
  assert.equal(fs.readdirSync(path.join(root, '.opencode', 'agents')).length, 0, 'remove reclaims every projected agent');
});

function verifiedLedger(verified) {
  return { resources: verified.resources.map((r) => ({ ...r, harness: 'opencode', kind: r.kind || 'copy-tree-file' })) };
}
