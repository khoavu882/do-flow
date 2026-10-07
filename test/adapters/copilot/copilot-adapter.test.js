'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCopilotAdapter, nativePaths, agentFileLayout, MARKER_START } = require('../../../src/adapters/copilot');
const { entryFingerprint } = require('../../../src/adapters/mcp-entries');
const { assertAdapter } = require('../../../src/adapters');

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

// An update whose source no longer carries a file the ledger owns drops it: the plan proposes a
// removal inside the apply batch, and apply() (not remove()) has to carry it out.
function droppedSkillInstall(adapter, repoRoot, root) {
  const asset = skillsAsset(repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'core', 'shared', 'skills', 'do-analyze', 'extra.md'), '# extra\n');
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const ledger = { resources: first.changes.map((c) => ({ harness: 'copilot', assetId: asset.id, kind: 'copy-tree-file', identity: c.identity, fingerprint: c.fingerprint })) };
  fs.rmSync(path.join(repoRoot, 'core', 'shared', 'skills', 'do-analyze', 'extra.md'));
  return { asset, context, ledger, extra: path.join(root, '.agents', 'skills', 'do-analyze', 'extra.md') };
}

test('Copilot apply() deletes a copy-tree file the update no longer ships', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
  const { asset, context, ledger, extra } = droppedSkillInstall(adapter, repoRoot, root);
  assert.ok(fs.existsSync(extra));
  const update = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.deepEqual(update.conflicts, []);
  assert.deepEqual(update.changes.map((c) => [c.operation, c.target]), [['remove', extra]]);
  adapter.apply({ changes: update.changes });
  assert.equal(fs.existsSync(extra), false, 'the ledger row goes, so the file must go with it');
  assert.ok(fs.existsSync(path.join(root, '.agents', 'skills', 'do-analyze', 'SKILL.md')));
});

for (const force of [false, true]) {
  test(`Copilot keeps a hand-edited file the update no longer ships ${force ? 'with' : 'without'} force, and releases its row`, () => {
    const repoRoot = scratch(); const root = scratch(); const adapter = createCopilotAdapter();
    const { asset, context, ledger, extra } = droppedSkillInstall(adapter, repoRoot, root);
    fs.appendFileSync(extra, 'my own notes\n');
    const update = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, force }, ledger });
    assert.deepEqual(update.conflicts, [], 'a hand-edited dropped file must not refuse the update');
    assert.deepEqual(update.notices, ['kept hand-edited .agents/skills/do-analyze/extra.md; DoFlow no longer manages it']);
    const [change] = update.changes;
    assert.equal(change.operation, 'remove');
    assert.equal(change.retained, true);
    adapter.apply({ changes: update.changes });
    assert.ok(fs.readFileSync(extra, 'utf8').endsWith('my own notes\n'), 'apply() never deletes a change marked retained');
  });
}

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

// ---- mcp (.mcp.json project / ~/.copilot/mcp-config.json global), owned per server through ledger rows ----

const CONTEXT7 = { id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
const SEQUENTIAL = { id: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] };
const ENTRIES = { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  'sequential-thinking': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } };
const MCP_ASSETS = [{ id: 'guidance.codex-pointer' }];
const USER_SERVER = { command: 'user-cmd', env: { TOKEN: 'secret-value' } };

function mcpFileIn(root) { return path.join(root, '.mcp.json'); }

function writeMcp(root, doc) {
  fs.writeFileSync(mcpFileIn(root), typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
}

function readMcp(root) { return JSON.parse(fs.readFileSync(mcpFileIn(root), 'utf8')); }

/** One run the way the lifecycle drives an adapter: discover, plan, apply or remove, verify. The
 * returned ledger drops the rows the plan removed or released and takes the MCP rows verify reports,
 * as updateLedger does. */
function runMcp(adapter, { root, mcp = [], mcpAdoptable = [], ledger = { resources: [] }, removing = false }) {
  const input = { scope: 'project', scopeRoot: root, assets: MCP_ASSETS, mcp, mcpAdoptable, ledger, context: removing ? { operation: 'remove' } : {} };
  const discovery = adapter.discover(input);
  const planned = adapter.plan({ ...input, discovery });
  if (!planned.conflicts.length) adapter[removing ? 'remove' : 'apply']({ changes: planned.changes });
  const verified = adapter.verify({ ...input, discovery, operation: removing ? 'remove' : 'apply' });
  const dropped = new Set(planned.changes.filter((change) => change.operation === 'remove').map((change) => change.ownershipIdentity));
  const added = verified.resources.filter((resource) => resource.kind === 'mcp-server').map((resource) => ({ ...resource, harness: 'copilot' }));
  const kept = ledger.resources.filter((row) => !dropped.has(row.ownershipIdentity) && !added.some((item) => item.ownershipIdentity === row.ownershipIdentity));
  return { discovery, planned, verified, ledger: { resources: [...kept, ...added] } };
}

test('plan registers each selected server as its own entry change in .mcp.json for project scope', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: MCP_ASSETS, mcp: [CONTEXT7] });
  assert.deepEqual(planned.changes.map((c) => [c.kind, c.operation, c.identity, c.ownershipIdentity, c.target, c.projection.renderer]),
    [['mcp-server', 'create', 'context7', 'doflow:copilot:mcp-server:context7', mcpFileIn(root), 'copilot-mcp']]);
  assert.deepEqual(planned.changes[0].entry, ENTRIES.context7);
  assert.equal(planned.changes[0].content, undefined, 'an entry change carries no file text');
});

test('plan targets ~/.copilot/mcp-config.json for global scope', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: MCP_ASSETS, mcp: [{ id: 'context7', command: 'npx' }], context: { homeDir: root } });
  const mcpChange = planned.changes.find((c) => c.projection?.renderer === 'copilot-mcp');
  assert.equal(mcpChange.target, path.join(root, '.copilot', 'mcp-config.json'));
});

test('mcp: installs each selected server under its own row, never touching a foreign server entry', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  writeMcp(root, { mcpServers: { 'user-server': USER_SERVER } });

  const first = runMcp(adapter, { root, mcp: [CONTEXT7] });
  assert.deepEqual(first.planned.conflicts, []);
  assert.deepEqual(readMcp(root).mcpServers, { 'user-server': USER_SERVER, context7: ENTRIES.context7 });
  assert.deepEqual(first.ledger.resources.map((row) => [row.ownershipIdentity, row.kind, row.identity, row.target]),
    [['doflow:copilot:mcp-server:context7', 'mcp-server', 'context7', mcpFileIn(root)]]);
  assert.equal(first.verified.ok, true);

  const again = runMcp(adapter, { root, mcp: [CONTEXT7], ledger: first.ledger });
  assert.deepEqual(again.discovery.mcpOwned, ['context7']);
  assert.deepEqual(again.planned.changes, [], 'a re-plan after apply changes nothing');

  const removed = runMcp(adapter, { root, ledger: again.ledger, removing: true });
  assert.deepEqual(readMcp(root), { mcpServers: { 'user-server': USER_SERVER } });
  assert.deepEqual(removed.ledger.resources, []);
});

test('A3 copilot: a narrower selection removes the deselected owned entry, and none removes every owned entry', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  writeMcp(root, { otherKey: true });
  const both = runMcp(adapter, { root, mcp: [CONTEXT7, SEQUENTIAL] });
  assert.deepEqual(Object.keys(readMcp(root).mcpServers), ['context7', 'sequential-thinking']);

  const narrower = runMcp(adapter, { root, mcp: [SEQUENTIAL], ledger: both.ledger });
  assert.deepEqual(Object.keys(readMcp(root).mcpServers), ['sequential-thinking']);
  assert.deepEqual(narrower.ledger.resources.map((row) => row.identity), ['sequential-thinking']);

  const none = runMcp(adapter, { root, mcp: [], ledger: narrower.ledger });
  assert.deepEqual(readMcp(root), { otherKey: true }, 'the emptied mcpServers member is deleted; every other key stays');
  assert.deepEqual(none.ledger.resources, []);
});

test('A4 copilot: the 1.18.0 registration row is released on install, its entries adopted per server, and dropped on remove', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const servers = { ...ENTRIES, 'user-server': USER_SERVER };
  writeMcp(root, { mcpServers: servers });
  const before = fs.readFileSync(mcpFileIn(root));
  const legacy = { resources: [{
    harness: 'copilot', scope: 'project', assetId: 'guidance.codex-pointer', target: mcpFileIn(root),
    ownershipIdentity: 'copilot:mcp:registration', fingerprint: entryFingerprint(servers),
  }] };

  assert.deepEqual(adapter.discover({ scope: 'project', scopeRoot: root, mcpAdoptable: [CONTEXT7, SEQUENTIAL], ledger: legacy }).mcpOwned,
    ['context7', 'sequential-thinking'], 'the registration row leaves adoption open');

  const installed = runMcp(adapter, { root, mcp: [CONTEXT7, SEQUENTIAL], mcpAdoptable: [CONTEXT7, SEQUENTIAL], ledger: legacy });
  assert.deepEqual(installed.planned.changes.map((change) => [change.ownershipIdentity, change.assetId, change.release]),
    [['copilot:mcp:registration', 'guidance.codex-pointer', true]]);
  assert.deepEqual(fs.readFileSync(mcpFileIn(root)), before, 'replacing the row writes nothing');
  assert.deepEqual(installed.ledger.resources.map((row) => row.ownershipIdentity),
    ['doflow:copilot:mcp-server:context7', 'doflow:copilot:mcp-server:sequential-thinking']);

  const removed = runMcp(adapter, { root, mcpAdoptable: [CONTEXT7, SEQUENTIAL], ledger: legacy, removing: true });
  assert.deepEqual(removed.planned.changes.map((change) => [change.ownershipIdentity, change.release ?? false]),
    [['copilot:mcp:registration', true], ['doflow:copilot:mcp-server:context7', false], ['doflow:copilot:mcp-server:sequential-thinking', false]]);
  assert.deepEqual(readMcp(root).mcpServers, { 'user-server': USER_SERVER });
  assert.deepEqual(removed.ledger.resources, []);
});

test('A5 copilot: a same-named user entry is kept through install and remove', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  writeMcp(root, { mcpServers: { context7: USER_SERVER } });
  const before = fs.readFileSync(mcpFileIn(root));

  const installed = runMcp(adapter, { root, mcp: [CONTEXT7] });
  assert.deepEqual(installed.planned.changes, []);
  assert.deepEqual(installed.planned.notices,
    ["MCP: kept your own entry 'context7' in .mcp.json and did not register DoFlow's; rename or remove yours to let DoFlow manage it."]);
  assert.equal(installed.verified.statuses.find((status) => status.capability === 'mcp').status, 'not-managed');
  assert.deepEqual(installed.ledger.resources, []);

  runMcp(adapter, { root, ledger: installed.ledger, removing: true });
  assert.deepEqual(fs.readFileSync(mcpFileIn(root)), before);
});

test('A6 copilot: a malformed MCP file is an install conflict and a remove release, and is never written', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const owned = runMcp(adapter, { root, mcp: [CONTEXT7] });
  writeMcp(root, '{ "mcpServers": { "secret-value": ');

  const installed = runMcp(adapter, { root, mcp: [CONTEXT7], ledger: owned.ledger });
  assert.deepEqual(installed.planned.conflicts, [`Copilot MCP: ${mcpFileIn(root)}: invalid JSON; DoFlow did not change the file`]);
  assert.deepEqual(installed.planned.changes, []);
  assert.doesNotMatch(JSON.stringify(installed.planned), /secret-value/);

  const removed = runMcp(adapter, { root, ledger: owned.ledger, removing: true });
  assert.deepEqual(removed.planned.conflicts, []);
  assert.deepEqual(removed.planned.changes.map((change) => [change.ownershipIdentity, change.release]), [['doflow:copilot:mcp-server:context7', true]]);
  assert.match(removed.planned.notices[0], /^MCP: left .*\.mcp\.json untouched because it cannot be edited safely/);
  assert.equal(fs.readFileSync(mcpFileIn(root), 'utf8'), '{ "mcpServers": { "secret-value": ');
  assert.deepEqual(removed.ledger.resources, []);
});

test('rules project as .github/instructions/*.instructions.md with applyTo headers, and remove reclaims them', () => {
  const root = scratch(); const adapter = createCopilotAdapter();
  const rulesDir = path.join(root, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'RULE_01_SAFETY.md'), '# Safety Rules\n\nnever compromise security\n');
  const assets = [{
    id: 'instructions.copilot', kind: 'instructions', source: 'rules',
    renderer: 'copilot-rule-instructions', capability: 'instructions',
    nativeDir: 'instructions', layout: 'instructions-md', transform: 'copilot-rule-instructions',
  }];

  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { repoRoot: root }, ledger: null });
  const ruleChanges = planned.changes.filter((c) => c.kind === 'copy-tree-file');
  assert.equal(ruleChanges.length, 1);
  assert.equal(ruleChanges[0].target, path.join(root, '.github', 'instructions', 'RULE_01_SAFETY.instructions.md'));
  assert.equal(ruleChanges[0].transformName, 'copilot-rule-instructions');

  adapter.apply({ changes: planned.changes });
  const onDisk = fs.readFileSync(ruleChanges[0].target, 'utf8');
  assert.match(onDisk, /^---\napplyTo: '\*\*'\n---\n\n# Safety Rules/);

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets, context: { repoRoot: root } });
  const status = verified.statuses.find((s) => s.assetId === 'instructions.copilot');
  assert.equal(status.status, 'managed');

  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { repoRoot: root, operation: 'remove' }, ledger: { resources: verified.resources.map((r) => ({ ...r, harness: 'copilot', kind: 'copy-tree-file' })) } });
  adapter.remove({ changes: removal.changes });
  const instructionsDir = path.join(root, '.github', 'instructions');
  assert.ok(!fs.existsSync(instructionsDir) || fs.readdirSync(instructionsDir).length === 0,
    'remove reclaims every projected rule file');
});
