'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistry, selectAssets } = require('../../../src/registry');
const { projectAdapterInput } = require('../../../src/adapters');
const adapter = require('../../../src/adapters/antigravity');

const REPO = path.resolve(__dirname, '..', '..', '..');
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-agy-')); }

function harnessInput(registry, { scope = 'project', scopeRoot, mcp = [], ledger } = {}) {
  const harness = registry.harnesses.find((h) => h.id === 'antigravity');
  const assets = selectAssets(registry, { harness: 'antigravity' });
  const projected = projectAdapterInput({ registry, harness, scope, scopeRoot, assets, mcp, policies: [], context: {} });
  return {
    ...projected,
    scope,
    scopeRoot,
    projectRoot: scopeRoot,
    homeDir: path.join(scopeRoot, 'home'),
    mcp,
    ledger: ledger ?? { resources: [] },
    context: { repoRoot: REPO, operation: 'apply' },
  };
}

function remoteServer() {
  // Not in the shipped catalog; the planner must still accept it and rewrite the URL.
  return { id: 'remote-x', transport: 'http', url: 'https://example.invalid/mcp' };
}

test('project plan: instructions, skills, agents, locator, and MCP land where Antigravity reads them', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scopeRoot: root, mcp: [registry.mcp[0], remoteServer()] });

  const planned = adapter.plan(input);
  assert.equal(planned.conflicts.length, 0);
  assert.ok(planned.changes.some((c) => c.projection.renderer === 'antigravity-instructions' && c.target === path.join(root, 'AGENTS.md')));
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'skills', 'do-execute-plan', 'SKILL.md')));
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'agents', 'system-architect.md')));
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'bin', 'doflow-run')), 'the locator rides the config dir');

  const mcpChanges = planned.changes.filter((c) => c.projection.renderer === 'antigravity-mcp');
  assert.ok(mcpChanges.length >= 2);
  adapter.apply({ ...input, changes: planned.changes });

  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /doflow:start/);
  const mcpDoc = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'mcp_config.json'), 'utf8'));
  assert.equal(mcpDoc.mcpServers['remote-x'].serverUrl, 'https://example.invalid/mcp', 'remote url projects to serverUrl');
  assert.ok(fs.existsSync(path.join(root, '.agents', 'skills', 'do-execute-plan', 'SKILL.md')));

  // Idempotent re-plan converges to zero copy-tree/instruction changes.
  const verified = adapter.verify({ ...input });
  const second = adapter.plan({
    ...input,
    ledger: { resources: verified.resources.map((r) => ({ ...r, harness: 'antigravity' })) },
  });
  assert.equal(second.changes.filter((c) => c.operation !== 'remove').length, 0, 'second plan is a no-op');
});

test('global scope: no instructions, no skills; agents and locator ride ~/.gemini/config', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const home = scratch();
  const input = harnessInput(registry, { scope: 'global', scopeRoot: home });
  const planned = adapter.plan(input);
  assert.ok(!planned.changes.some((c) => c.target.endsWith('AGENTS.md')), 'global instructions belong to Gemini CLI; never written');
  assert.ok(!planned.changes.some((c) => c.target.includes('.agents', 'skills')));
  assert.ok(planned.changes.some((c) => c.target === path.join(home, '.gemini', 'config', 'agents', 'system-architect.md')));
  adapter.apply({ ...input, changes: planned.changes });
  assert.ok(fs.existsSync(path.join(home, '.gemini', 'config', 'bin', 'doflow-run')));
});

test('removal strips the managed section but preserves foreign bytes on both sides', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scopeRoot: root });
  const planned = adapter.plan(input);
  adapter.apply({ ...input, changes: planned.changes });
  const agentsPath = path.join(root, 'AGENTS.md');
  fs.writeFileSync(agentsPath, `# mine\n${fs.readFileSync(agentsPath, 'utf8')}\n# mine after\n`);

  const removeContext = { ...input.context, operation: 'remove' };
  const removalPlan = adapter.plan({ ...input, context: removeContext });
  adapter.remove({ ...input, changes: removalPlan.changes, context: removeContext });
  const after = fs.readFileSync(agentsPath, 'utf8');
  assert.match(after, /# mine/);
  assert.match(after, /# mine after/);
  assert.ok(!after.includes('doflow:start'), 'managed section is gone');
});

test('MCP removal deletes only DoFlow-owned servers; foreign ones survive byte-for-byte', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scopeRoot: root, mcp: [registry.mcp[0]] });
  const planned = adapter.plan(input);
  adapter.apply({ ...input, changes: planned.changes });

  const mcpFile = path.join(root, '.agents', 'mcp_config.json');
  const doc = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  doc.mcpServers['foreign-thing'] = { command: '/bin/true' };
  fs.writeFileSync(mcpFile, `${JSON.stringify(doc, null, 2)}\n`);
  const ownedId = registry.mcp[0].id;

  // The lifecycle seeds removal planning with the ledger's ownership rows; mirror that here.
  const ownedRow = {
    harness: 'antigravity', scope: 'project', assetId: 'guidance.codex-pointer',
    target: mcpFile, ownershipIdentity: `doflow:antigravity:mcp-server:${ownedId}`,
    kind: 'mcp-server', identity: ownedId,
  };
  const removeContext = { ...input.context, operation: 'remove' };
  const seeded = { ...input, ledger: { resources: [ownedRow, ...input.ledger.resources.map((r) => ({ ...r, harness: 'antigravity' }))] } };
  const removalPlan = adapter.plan({ ...seeded, context: removeContext });
  adapter.remove({ ...seeded, changes: removalPlan.changes, context: removeContext });
  const after = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  assert.ok(!Object.prototype.hasOwnProperty.call(after.mcpServers, ownedId));
  assert.deepEqual(after.mcpServers['foreign-thing'], { command: '/bin/true' }, 'a foreign server is never swept');
});
