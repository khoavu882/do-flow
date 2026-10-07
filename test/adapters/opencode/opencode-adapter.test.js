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

test('mergeConfig registers instructions only, leaving mcp and every other key to their owners', () => {
  const mcp = { mine: { type: 'local', command: ['my-server'], enabled: true } };
  const next = mergeConfig({ mcp });
  assert.deepEqual(next.instructions, ['AGENTS.md']);
  assert.equal(next.skills, undefined);
  assert.deepEqual(next.mcp, mcp);
});

test('unmergeConfig removes only what mergeConfig added, dropping empty arrays', () => {
  const mcp = { mine: { type: 'local', command: ['my-server'], enabled: true } };
  const next = unmergeConfig(mergeConfig({ instructions: ['CUSTOM.md'], mcp }));
  assert.deepEqual(next.instructions, ['CUSTOM.md']);
  assert.deepEqual(next.mcp, mcp);
  assert.equal(unmergeConfig(mergeConfig({})).instructions, undefined);
});

test('plan registers instructions in one opencode.json change and each server in its own entry change', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [{ id: 'guidance.codex-pointer' }], mcp: [{ id: 'context7', command: 'context7-server' }] });
  const configChange = planned.changes.find((c) => c.projection?.renderer === 'opencode-config');
  const written = JSON.parse(configChange.content);
  assert.deepEqual(written, { instructions: ['AGENTS.md'] }, 'no skills key, and no mcp in the config change');
  const entryChanges = planned.changes.filter((c) => c.projection?.renderer === 'opencode-mcp');
  assert.deepEqual(entryChanges.map((c) => [c.kind, c.operation, c.identity, c.ownershipIdentity, c.target]),
    [['mcp-server', 'create', 'context7', 'doflow:opencode:mcp-server:context7', path.join(root, 'opencode.json')]]);
  assert.deepEqual(entryChanges[0].entry, { type: 'local', command: ['context7-server'], enabled: true });
});

test('invalid opencode.json blocks planning but never mutates the file', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  fs.writeFileSync(path.join(root, 'opencode.json'), '{ broken');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [{ id: 'context7', command: 'context7-server' }] });
  assert.deepEqual(planned.conflicts, [`OpenCode MCP: ${path.join(root, 'opencode.json')}: invalid JSON; DoFlow did not change the file`]);
  assert.equal(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'), '{ broken');
});

// ---- MCP entries, owned per server through ledger rows ----

const CONTEXT7 = { id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
const SEQUENTIAL = { id: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] };
const CONTEXT7_ENTRY = { type: 'local', command: ['npx', '-y', '@upstash/context7-mcp'], enabled: true };
const MCP_ASSETS = [{ id: 'guidance.codex-pointer' }];
const USER_SERVER = { type: 'local', command: ['my-own-server'], environment: { TOKEN: 'secret-value' } };

function configIn(root) { return path.join(root, 'opencode.json'); }

function writeConfig(root, doc) {
  fs.writeFileSync(configIn(root), typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
}

function readConfig(root) { return JSON.parse(fs.readFileSync(configIn(root), 'utf8')); }

/** One run the way the lifecycle drives an adapter: discover, plan, apply or remove, verify. The
 * returned ledger drops the rows the plan removed or released and takes the rows verify reports,
 * as updateLedger does. */
function runMcp(adapter, { root, mcp = [], mcpAdoptable = [], ledger = { resources: [] }, removing = false }) {
  const input = { scope: 'project', scopeRoot: root, assets: MCP_ASSETS, mcp, mcpAdoptable, ledger, context: removing ? { operation: 'remove' } : {} };
  const discovery = adapter.discover(input);
  const planned = adapter.plan({ ...input, discovery });
  if (!planned.conflicts.length) adapter[removing ? 'remove' : 'apply']({ changes: planned.changes });
  const verified = adapter.verify({ ...input, discovery, operation: removing ? 'remove' : 'apply' });
  const dropped = new Set(planned.changes.filter((change) => change.operation === 'remove').map((change) => change.ownershipIdentity));
  const added = verified.resources.map((resource) => ({ ...resource, harness: 'opencode' }));
  const kept = ledger.resources.filter((row) => !dropped.has(row.ownershipIdentity) && !added.some((item) => item.ownershipIdentity === row.ownershipIdentity));
  return { discovery, planned, verified, ledger: { resources: [...kept, ...added] } };
}

const mcpRows = (ledger) => ledger.resources.filter((row) => row.kind === 'mcp-server');

test('mcp: installs each selected server under its own row beside the instructions registration, never touching a hand-added server', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  writeConfig(root, { theme: 'dark', mcp: { handwritten: USER_SERVER } });

  const first = runMcp(adapter, { root, mcp: [CONTEXT7] });
  assert.deepEqual(first.planned.conflicts, []);
  assert.deepEqual(readConfig(root), { theme: 'dark', mcp: { handwritten: USER_SERVER, context7: CONTEXT7_ENTRY }, instructions: ['AGENTS.md'] });
  assert.deepEqual(mcpRows(first.ledger).map((row) => [row.ownershipIdentity, row.identity, row.target]),
    [['doflow:opencode:mcp-server:context7', 'context7', configIn(root)]]);
  assert.equal(first.verified.ok, true);

  const again = runMcp(adapter, { root, mcp: [CONTEXT7], ledger: first.ledger });
  assert.deepEqual(again.discovery.mcpOwned, ['context7']);
  assert.deepEqual(again.planned.changes, [], 'a re-plan after apply changes nothing');

  const removed = runMcp(adapter, { root, ledger: again.ledger, removing: true });
  assert.deepEqual(readConfig(root), { theme: 'dark', mcp: { handwritten: USER_SERVER } });
  assert.deepEqual(removed.ledger.resources, []);
});

test('mcp: while OpenCode holds no MCP row, an adoptable entry equal to DoFlow\'s is owned and an edited one is not', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  writeConfig(root, { mcp: { context7: CONTEXT7_ENTRY, 'sequential-thinking': { ...CONTEXT7_ENTRY, enabled: false } } });
  const discovery = adapter.discover({ scope: 'project', scopeRoot: root, mcp: [], mcpAdoptable: [CONTEXT7, SEQUENTIAL], ledger: { resources: [] } });
  assert.deepEqual(discovery.mcpOwned, ['context7']);
  assert.deepEqual(adapter.discover({ scope: 'project', scopeRoot: root, ledger: { resources: [] } }).mcpOwned, [], 'nothing is adoptable');
});

test('A3 opencode: a narrower selection removes the deselected owned entry, and none removes every owned entry', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  writeConfig(root, { theme: 'dark' });
  const both = runMcp(adapter, { root, mcp: [CONTEXT7, SEQUENTIAL] });
  assert.deepEqual(Object.keys(readConfig(root).mcp), ['context7', 'sequential-thinking']);

  const narrower = runMcp(adapter, { root, mcp: [SEQUENTIAL], ledger: both.ledger });
  assert.deepEqual(Object.keys(readConfig(root).mcp), ['sequential-thinking']);
  assert.deepEqual(mcpRows(narrower.ledger).map((row) => row.identity), ['sequential-thinking']);

  const none = runMcp(adapter, { root, mcp: [], ledger: narrower.ledger });
  assert.deepEqual(readConfig(root), { theme: 'dark', instructions: ['AGENTS.md'] }, 'the emptied mcp member is deleted; every other key stays');
  assert.deepEqual(mcpRows(none.ledger), []);
});

test('A5 opencode: a same-named user entry is kept through install and remove', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  writeConfig(root, { instructions: ['AGENTS.md'], mcp: { context7: USER_SERVER } });
  const before = fs.readFileSync(configIn(root));

  const installed = runMcp(adapter, { root, mcp: [CONTEXT7] });
  assert.deepEqual(installed.planned.changes, []);
  assert.deepEqual(installed.planned.notices,
    ["MCP: kept your own entry 'context7' in opencode.json and did not register DoFlow's; rename or remove yours to let DoFlow manage it."]);
  assert.equal(installed.verified.statuses.find((status) => status.capability === 'mcp').status, 'not-managed');
  assert.deepEqual(mcpRows(installed.ledger), []);
  assert.deepEqual(fs.readFileSync(configIn(root)), before);

  runMcp(adapter, { root, ledger: installed.ledger, removing: true });
  assert.deepEqual(readConfig(root), { mcp: { context7: USER_SERVER } }, 'remove takes only the instructions registration');
});

test('A6 opencode: a malformed opencode.json is an install conflict and a remove release, and is never written', () => {
  const root = scratch(); const adapter = createOpenCodeAdapter();
  const owned = runMcp(adapter, { root, mcp: [CONTEXT7] });
  assert.deepEqual(owned.ledger.resources.map((row) => row.ownershipIdentity).sort(),
    ['doflow:opencode:mcp-server:context7', 'opencode:config:registration']);
  writeConfig(root, '{ "mcp": { "secret-value": ');

  const installed = runMcp(adapter, { root, mcp: [CONTEXT7], ledger: owned.ledger });
  assert.deepEqual(installed.planned.conflicts, [`OpenCode MCP: ${configIn(root)}: invalid JSON; DoFlow did not change the file`]);
  assert.deepEqual(installed.planned.changes, []);
  assert.doesNotMatch(JSON.stringify(installed.planned), /secret-value/);

  const removed = runMcp(adapter, { root, ledger: owned.ledger, removing: true });
  assert.deepEqual(removed.planned.conflicts, []);
  assert.deepEqual(removed.planned.changes.map((change) => [change.ownershipIdentity, change.release]),
    [['opencode:config:registration', true], ['doflow:opencode:mcp-server:context7', true]]);
  assert.match(removed.planned.notices[0], /^MCP: left .*opencode\.json untouched because it cannot be edited safely/);
  assert.equal(removed.verified.ok, true);
  assert.equal(fs.readFileSync(configIn(root), 'utf8'), '{ "mcp": { "secret-value": ');
  assert.deepEqual(removed.ledger.resources, []);
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
  assert.equal(fs.existsSync(path.join(root, '.opencode', 'agents')), false, 'remove reclaims every projected agent and the folder it emptied');
});

function verifiedLedger(verified) {
  return { resources: verified.resources.map((r) => ({ ...r, harness: 'opencode', kind: r.kind || 'copy-tree-file' })) };
}

function sharedTreeAsset(repoRoot, nativeDir = '../.doflow/scripts') {
  fs.mkdirSync(path.join(repoRoot, 'tree-src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'tree-src', 'run.sh'), '#!/bin/sh\n');
  return { id: 'scripts.doflow', renderer: 'copy-tree', capability: 'scripts', source: 'tree-src', nativeDir };
}

test('a ../.doflow asset lands at <scope root>/.doflow in both scopes and verifies there', () => {
  const adapter = createOpenCodeAdapter();
  for (const scope of ['project', 'global']) {
    const repoRoot = scratch(); const root = scratch();
    const asset = sharedTreeAsset(repoRoot);
    const context = { repoRoot, homeDir: root };
    const planned = adapter.plan({ scope, scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
    assert.deepEqual(planned.changes.filter((c) => c.kind === 'copy-tree-file').map((c) => c.target), [path.join(root, '.doflow', 'scripts', 'run.sh')], scope);
    adapter.apply({ changes: planned.changes });
    const verified = adapter.verify({ scope, scopeRoot: root, assets: [asset], context });
    const status = verified.statuses.find((s) => s.capability === 'scripts');
    assert.equal(status.status, 'managed', scope);
    assert.equal(status.target, path.join(root, '.doflow', 'scripts'), scope);
  }
});

test('a nativeDir that is not ../.doflow keeps the opencode tree root as its base', () => {
  const adapter = createOpenCodeAdapter();
  const repoRoot = scratch(); const root = scratch();
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [sharedTreeAsset(repoRoot, 'skills')],
    context: { repoRoot, homeDir: root }, ledger: { resources: [] } });
  assert.deepEqual(planned.changes.filter((c) => c.kind === 'copy-tree-file').map((c) => c.target), [path.join(root, '.config', 'opencode', 'skills', 'run.sh')]);
});

test('a ../.doflow nativeDir that escapes .doflow fails the plan before any write', () => {
  const repoRoot = scratch(); const root = scratch();
  assert.throws(() => createOpenCodeAdapter().plan({ scope: 'project', scopeRoot: root, assets: [sharedTreeAsset(repoRoot, '../.doflow/../x')],
    context: { repoRoot, homeDir: root }, ledger: { resources: [] } }), /shared-tree nativeDir escapes \.doflow/);
  assert.equal(fs.existsSync(path.join(root, '.doflow')), false);
});
