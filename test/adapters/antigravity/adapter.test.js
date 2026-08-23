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
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'agents', 'system-architect', 'agent.md')));
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
  assert.ok(planned.changes.some((c) => c.target === path.join(home, '.gemini', 'config', 'agents', 'system-architect', 'agent.md')));
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

test('rules and workflows are workspace-scope only, landing under .agents/, and remove actually deletes', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scope: 'project', scopeRoot: root });
  const planned = adapter.plan(input);
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'rules', 'RULE_01_SAFETY.md')), 'workspace rules land under .agents/rules');
  assert.ok(planned.changes.some((c) => c.target === path.join(root, '.agents', 'workflows', 'do-flow-chain.md')), 'the chain workflow lands under .agents/workflows');
  adapter.apply({ ...input, changes: planned.changes });
  assert.ok(fs.existsSync(path.join(root, '.agents', 'workflows', 'do-flow-chain.md')));

  // Regression guard: a removal plan routed through applyTree (which skips operation:'remove')
  // used to delete nothing while verification correctly refused to journal it.
  const ledgerAfterInstall = { resources: verifiedResources(adapter, input) };
  const removalPlan = adapter.plan({ ...input, context: { ...(input.context ?? {}), operation: 'remove' }, ledger: ledgerAfterInstall });
  adapter.apply({ ...input, changes: removalPlan.changes });
  assert.ok(!fs.existsSync(path.join(root, '.agents', 'workflows', 'do-flow-chain.md')), 'remove must delete projected workflow files');

  const globalHome = scratch();
  const globalPlanned = adapter.plan(harnessInput(registry, { scope: 'global', scopeRoot: globalHome }));
  assert.ok(!globalPlanned.changes.some((c) => c.target.includes('.agents/rules') || c.target.includes('.agents/workflows')),
    'neither rules nor workflows have a documented user-scope home');
});

function verifiedResources(adapt, input) {
  const v = adapt.verify(input);
  return (v.resources || []).map((r) => ({ ...r, harness: 'antigravity', kind: r.kind || 'copy-tree-file' }));
}

test('hooks.antigravity projects the gate shim + hooks.json group, and remove unmerges only its own', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const root = scratch();
  const input = harnessInput(registry, { scope: 'project', scopeRoot: root });
  const planned = adapter.plan(input);

  const scriptChange = planned.changes.find((c) => c.assetId === 'hooks.antigravity' && c.kind === 'copy-tree-file');
  const docChange = planned.changes.find((c) => c.assetId === 'hooks.antigravity' && c.kind === 'hooks-json');
  assert.ok(scriptChange, 'the gate shim is projected');
  assert.ok(docChange, 'the hooks.json group is registered');

  adapter.apply({ ...input, changes: planned.changes });
  const doc = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'hooks.json'), 'utf8'));
  const entry = doc['doflow-pre-implementation-gate'].PreToolUse[0];
  assert.equal(entry.matcher, 'write_to_file|replace_file_content|multi_replace_file_content');
  assert.equal(entry.hooks[0].command, path.join(root, '.agents', 'hooks', 'pre-implementation-gate.sh'));
  assert.equal(fs.statSync(entry.hooks[0].command).mode & 0o111, 0o111, 'the shim must be executable');

  // Foreign groups survive; ours do not.
  fs.writeFileSync(path.join(root, '.agents', 'hooks.json'), JSON.stringify({
    'user-own-group': { Stop: [{ type: 'command', command: './mine.sh' }] },
    'doflow-pre-implementation-gate': doc['doflow-pre-implementation-gate'],
  }));
  const ledgerRows = { resources: [
    { harness: 'antigravity', assetId: 'hooks.antigravity', kind: 'hooks-json',
      ownershipIdentity: 'antigravity:hooks:registration', target: path.join(root, '.agents', 'hooks.json') },
    { harness: 'antigravity', assetId: 'hooks.antigravity', kind: 'copy-tree-file',
      identity: 'pre-implementation-gate.sh',
      fingerprint: require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, '.agents', 'hooks', 'pre-implementation-gate.sh'))).digest('hex'),
      target: path.join(root, '.agents', 'hooks', 'pre-implementation-gate.sh') },
  ] };
  const removal = adapter.plan({ ...input, context: { ...(input.context ?? {}), operation: 'remove' }, ledger: ledgerRows });
  adapter.apply({ ...input, changes: removal.changes });
  const after = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'hooks.json'), 'utf8'));
  assert.ok(after['user-own-group'], 'foreign hook groups survive removal');
  assert.equal(after['doflow-pre-implementation-gate'], undefined, 'only the DoFlow-owned group is removed');
});
