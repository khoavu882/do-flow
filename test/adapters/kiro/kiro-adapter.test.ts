'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../../helper/tmp.ts');
const { createKiroAdapter, nativePaths } = require('../../../src/adapters/kiro/index.ts');
const { entryFingerprint } = require('../../../src/adapters/mcp-entries.ts');
const { assertAdapter } = require('../../../src/adapters/index.ts');

function scratch() { return suiteTempDir('doflow-kiro-'); }

function steeringAsset(repoRoot: any) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'guidance');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'DOFLOW_CORE.md'), '# core guidance\n');
  return { id: 'guidance.context-layer', source: 'core/shared/guidance', renderer: 'copy-tree', capability: 'instructions', nativeDir: 'steering' };
}

function agentsAsset(repoRoot: any) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'agent-specs');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'core-implementer.md'), '---\nname: core-implementer\n---\n# core-implementer\n');
  return { id: 'agents.shared', source: 'core/shared/agent-specs', renderer: 'kiro-agents', capability: 'agents', nativeDir: 'agents' };
}

function skillsAsset(repoRoot: any) {
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
  const change = planned.changes.find((c: any) => c.assetId === asset.id);
  assert.equal(change.operation, 'create');
  adapter.apply({ changes: planned.changes });
  const installed = path.join(root, '.kiro', 'steering', 'DOFLOW_CORE.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# core guidance\n');

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  const resource = verified.resources.find((r: any) => r.assetId === asset.id);
  assert.equal(resource.fingerprint, change.fingerprint);

  const ledger = { resources: verified.resources.map((r: any) => ({ harness: 'kiro', assetId: asset.id, kind: 'copy-tree-file', identity: r.identity, fingerprint: r.fingerprint })) };
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
  const fingerprint = first.changes.find((c: any) => c.assetId === asset.id).fingerprint;
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
  const fingerprint = first.changes.find((c: any) => c.assetId === asset.id).fingerprint;
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
  assert.ok(verified.resources.find((r: any) => r.assetId === asset.id));
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
  const fingerprint = first.changes.find((c: any) => c.assetId === asset.id).fingerprint;
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
  const ledger = { resources: first.changes.map((c: any) => ({ harness: 'kiro', assetId: c.assetId, kind: 'copy-tree-file', identity: c.identity, fingerprint: c.fingerprint })) };
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
  const { loadRegistry, selectAssets, harnessFor } = require('../../../src/registry/index.ts');
  const repoRoot = path.resolve(__dirname, "../../..");
  const registry = loadRegistry({ repoRoot });
  const harness = harnessFor(registry, 'kiro');
  assert.equal(harness.nativeTargets.instructions, '.kiro/steering/');
  assert.equal(harness.nativeTargets.skills, '.kiro/skills');
  assert.equal(harness.nativeTargets.agents, '.kiro/agents');
  assert.equal(harness.nativeTargets.hooks, '.kiro/hooks');
  assert.equal(harness.nativeTargets.mcp, '.kiro/settings/mcp.json');

  // The guidance tree lands twice: as steering Kiro loads, and at the shared `.doflow/guidance`
  // root `retrieve` and the runtime read, which Kiro never loads.
  const instructions = selectAssets(registry, { harness: 'kiro', capability: 'instructions' });
  assert.deepEqual(instructions.map((asset: any) => [asset.id, asset.nativeDir.kiro]),
    [['guidance.context-layer', 'steering'], ['kiro.guidance-tree', '../.doflow/guidance']]);
  assert.equal(instructions[1].source, instructions[0].source);
  // Steering takes the core set only; the shared mirror stays whole.
  assert.equal(instructions[0].projection.kiro.select, 'guidance-manifest');
  assert.equal(instructions[1].projection.kiro.select, undefined);

  const skills = selectAssets(registry, { harness: 'kiro', capability: 'skills' });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, 'skills.doflow');
  assert.equal(skills[0].nativeDir.kiro, 'skills');

  const agents = selectAssets(registry, { harness: 'kiro', capability: 'agents' });
  assert.deepEqual(agents.map((asset: any) => asset.id), ['agents.shared', 'kiro.doflow-agent']);
});

// ---- the real registry: steering holds the core set, .doflow/guidance the whole tree ----

const CORE_SET = ['DOFLOW_CORE.md', 'PRINCIPLES.md', 'rules/RULES.md'];

function filesUnder(dir: any) {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry: any) => entry.isFile())
    .map((entry: any) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort() : [];
}

function installKiroGuidance(registry: any, scope: any) {
  const { projectAdapterInput } = require('../../../src/adapters/index.ts');
  const repoRoot = path.resolve(__dirname, '../../..');
  const root = scratch(); const adapter = createKiroAdapter();
  const harness = registry.harnesses.find((item: any) => item.id === 'kiro');
  const assets = require('../../../src/registry/index.ts').selectAssets(registry, { harness: 'kiro', capability: 'instructions' });
  const input = { ...projectAdapterInput({ registry, harness, scope, scopeRoot: root, assets, context: {} }), context: { repoRoot, homeDir: root }, ledger: { resources: [] } };
  const planned = adapter.plan(input);
  assert.deepEqual(planned.conflicts, []);
  adapter.apply({ changes: planned.changes });
  assert.equal(adapter.verify(input).ok, true);
  return { root, source: path.join(repoRoot, 'core', 'shared', 'guidance') };
}

for (const scope of ['project', 'global']) {
  test(`${scope} install leaves exactly the core set in steering and the whole tree in .doflow/guidance`, () => {
    const { loadRegistry } = require('../../../src/registry/index.ts');
    const { root, source } = installKiroGuidance(loadRegistry({ repoRoot: path.resolve(__dirname, '../../..') }), scope);
    assert.deepEqual(filesUnder(path.join(root, '.kiro', 'steering')), CORE_SET);
    assert.deepEqual(filesUnder(path.join(root, '.doflow', 'guidance')), filesUnder(source));
    assert.ok(filesUnder(source).length > CORE_SET.length, 'the source tree is larger than the core set');
  });
}

test('without the select the steering would hold the whole tree (control for the file-set test)', () => {
  const { loadRegistry } = require('../../../src/registry/index.ts');
  const registry = structuredClone(loadRegistry({ repoRoot: path.resolve(__dirname, '../../..') }));
  delete registry.assets.find((asset: any) => asset.id === 'guidance.context-layer').projection.kiro.select;
  const { root, source } = installKiroGuidance(registry, 'project');
  assert.deepEqual(filesUnder(path.join(root, '.kiro', 'steering')), filesUnder(source));
});

// ---- MCP entries, owned per server through ledger rows ----

const CONTEXT7 = { id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
const SEQUENTIAL = { id: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] };
const MCP_ASSETS = [{ id: 'guidance.context-layer' }];
const USER_SERVER = { command: 'my-own-server', env: { TOKEN: 'secret-value' } };

function mcpFileIn(root: any) { return path.join(root, '.kiro', 'settings', 'mcp.json'); }

function writeMcp(root: any, doc: any) {
  fs.mkdirSync(path.dirname(mcpFileIn(root)), { recursive: true });
  fs.writeFileSync(mcpFileIn(root), typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
}

function readMcp(root: any) { return JSON.parse(fs.readFileSync(mcpFileIn(root), 'utf8')); }

/** One run the way the lifecycle drives an adapter: discover, plan, apply or remove, verify. The
 * returned ledger drops the rows the plan removed or released and takes the MCP rows verify reports,
 * as updateLedger does. */
function runMcp(adapter: any, { root, mcp = [], mcpAdoptable = [], ledger = { resources: [] }, removing = false }: any) {
  const input = { scope: 'project', scopeRoot: root, assets: MCP_ASSETS, mcp, mcpAdoptable, ledger, context: removing ? { operation: 'remove' } : {} };
  const discovery = adapter.discover(input);
  const planned = adapter.plan({ ...input, discovery });
  if (!planned.conflicts.length) adapter[removing ? 'remove' : 'apply']({ changes: planned.changes });
  const verified = adapter.verify({ ...input, discovery, operation: removing ? 'remove' : 'apply' });
  const dropped = new Set(planned.changes.filter((change: any) => change.operation === 'remove').map((change: any) => change.ownershipIdentity));
  const added = verified.resources.filter((resource: any) => resource.kind === 'mcp-server').map((resource: any) => ({ ...resource, harness: 'kiro' }));
  const kept = ledger.resources.filter((row: any) => !dropped.has(row.ownershipIdentity) && !added.some((item: any) => item.ownershipIdentity === row.ownershipIdentity));
  return { discovery, planned, verified, ledger: { resources: [...kept, ...added] } };
}

test('mcp: installs each selected server under its own row, never touching a hand-added server', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  writeMcp(root, { mcpServers: { handwritten: USER_SERVER } });

  const first = runMcp(adapter, { root, mcp: [CONTEXT7] });
  assert.deepEqual(first.planned.conflicts, []);
  assert.deepEqual(readMcp(root).mcpServers, { handwritten: USER_SERVER, context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } });
  assert.deepEqual(first.ledger.resources.map((row) => [row.ownershipIdentity, row.kind, row.identity, row.target]),
    [['doflow:kiro:mcp-server:context7', 'mcp-server', 'context7', mcpFileIn(root)]]);
  assert.equal(first.verified.ok, true);

  const again = runMcp(adapter, { root, mcp: [CONTEXT7], ledger: first.ledger });
  assert.deepEqual(again.discovery.mcpOwned, ['context7']);
  assert.deepEqual(again.planned.changes.filter((change: any) => change.kind === 'mcp-server'), [], 'a re-plan after apply changes nothing');

  const removed = runMcp(adapter, { root, ledger: again.ledger, removing: true });
  assert.deepEqual(readMcp(root), { mcpServers: { handwritten: USER_SERVER } });
  assert.deepEqual(removed.ledger.resources, []);
});

test('A3 kiro: a narrower selection removes the deselected owned entry, and none removes every owned entry', () => {
  const root = scratch(); const adapter = createKiroAdapter();
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

test('A4 kiro: rows recorded as kiro:mcp:<id> are replaced on install and dropped on remove', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const entries = { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    'sequential-thinking': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } };
  writeMcp(root, { mcpServers: { ...entries, 'user-server': USER_SERVER } });
  const before = fs.readFileSync(mcpFileIn(root));
  const legacy = { resources: Object.entries(entries).map(([id, entry]) => ({
    harness: 'kiro', scope: 'project', assetId: 'guidance.context-layer', target: mcpFileIn(root),
    ownershipIdentity: `kiro:mcp:${id}`, identity: id, fingerprint: entryFingerprint(entry),
  })) };

  const installed = runMcp(adapter, { root, mcp: [CONTEXT7, SEQUENTIAL], ledger: legacy });
  assert.deepEqual(installed.planned.changes.map((change: any) => [change.ownershipIdentity, change.operation, change.release ?? false]),
    [['kiro:mcp:context7', 'remove', true], ['kiro:mcp:sequential-thinking', 'remove', true]]);
  assert.deepEqual(fs.readFileSync(mcpFileIn(root)), before, 'replacing the rows writes nothing');
  assert.deepEqual(installed.ledger.resources.map((row) => row.ownershipIdentity),
    ['doflow:kiro:mcp-server:context7', 'doflow:kiro:mcp-server:sequential-thinking']);

  const removed = runMcp(adapter, { root, ledger: legacy, removing: true });
  assert.deepEqual(removed.planned.changes.map((change: any) => [change.ownershipIdentity, change.release ?? false]),
    [['kiro:mcp:context7', false], ['kiro:mcp:sequential-thinking', false]]);
  assert.deepEqual(readMcp(root).mcpServers, { 'user-server': USER_SERVER });
  assert.deepEqual(removed.ledger.resources, []);
});

test('A5 kiro: a same-named user entry is kept through install and remove', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  writeMcp(root, { mcpServers: { context7: USER_SERVER } });
  const before = fs.readFileSync(mcpFileIn(root));

  const installed = runMcp(adapter, { root, mcp: [CONTEXT7] });
  assert.deepEqual(installed.planned.changes.filter((change: any) => change.kind === 'mcp-server'), []);
  assert.deepEqual(installed.planned.notices,
    ["MCP: kept your own entry 'context7' in mcp.json and did not register DoFlow's; rename or remove yours to let DoFlow manage it."]);
  assert.equal(installed.verified.statuses.mcp[0].status, 'not-managed');
  assert.deepEqual(installed.ledger.resources, []);

  runMcp(adapter, { root, ledger: installed.ledger, removing: true });
  assert.deepEqual(fs.readFileSync(mcpFileIn(root)), before);
});

test('A6 kiro: a malformed mcp.json is an install conflict and a remove release, and is never written', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const owned = runMcp(adapter, { root, mcp: [CONTEXT7] });
  writeMcp(root, '{ "mcpServers": { "secret-value": ');

  const installed = runMcp(adapter, { root, mcp: [CONTEXT7], ledger: owned.ledger });
  assert.deepEqual(installed.planned.conflicts, [`Kiro MCP: ${mcpFileIn(root)}: invalid JSON; DoFlow did not change the file`]);
  assert.deepEqual(installed.planned.changes.filter((change: any) => change.kind === 'mcp-server'), []);
  assert.equal(installed.planned.surfaces.mcp.status, 'blocked');

  const removed = runMcp(adapter, { root, ledger: owned.ledger, removing: true });
  assert.deepEqual(removed.planned.changes.map((change: any) => [change.ownershipIdentity, change.release]), [['doflow:kiro:mcp-server:context7', true]]);
  assert.match(removed.planned.notices[0], /^MCP: left .*mcp\.json untouched because it cannot be edited safely/);
  assert.equal(fs.readFileSync(mcpFileIn(root), 'utf8'), '{ "mcpServers": { "secret-value": ');
  assert.deepEqual(removed.ledger.resources, []);
});

test('hooks surface reports supported with no hooks asset selected, and installs nothing', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [], context: {} });
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.surfaces.hooks.status, 'supported');
  assert.equal(planned.surfaces.hooks.target, path.join(root, '.kiro', 'hooks'));
  assert.equal(fs.existsSync(planned.surfaces.hooks.target), false);

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [], mcp: [], context: {} });
  assert.equal(verified.ok, true);
  assert.equal(verified.statuses.hooks.status, 'supported');
});

test('Kiro discovery reports the servers in mcp.json, sorted, and null when the file is absent', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const first = adapter.discover({ scope: 'project', scopeRoot: root, ledger: { resources: [] } });
  assert.equal(first.mcpConfigured, null);
  fs.mkdirSync(path.dirname(first.paths.mcp), { recursive: true });
  fs.writeFileSync(first.paths.mcp, JSON.stringify({ mcpServers: { zeta: {}, alpha: {} } }));
  assert.deepEqual(adapter.discover({ scope: 'project', scopeRoot: root, ledger: { resources: [] } }).mcpConfigured, ['alpha', 'zeta']);
});
