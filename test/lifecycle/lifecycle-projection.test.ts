'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRegistry, harnessFor, selectAssets, selectMcpServers } = require('../../src/registry/index.ts');
const { projectAdapterInput } = require('../../src/adapters/index.ts');
const { renderPolicies } = require('../../src/lifecycle/policies.ts');
const { createAdapterRegistry } = require('../../src/adapters/index.ts');
const { planLifecycle, MCP_KEEP } = require('../../src/lifecycle/index.ts');
const codexAdapter = require('../../src/adapters/codex/index.ts');
const { tempDir } = require('../helper/tmp.ts');

const registry = loadRegistry({ repoRoot: path.resolve(__dirname, "../..") });

/** The registry with `id`'s MCP capability unavailable: no live harness takes no servers, so the
 * tests of that branch declare one that way (fixture `noMcp`). */
function withoutMcp(id: string): any {
  const copy = structuredClone(registry);
  copy.harnesses.find((harness: any) => harness.id === id).capabilities.mcp.status = 'unavailable';
  return copy;
}
const noMcp = withoutMcp('antigravity');

test('Codex projection carries explicit asset, MCP, policy, and native-target inputs', () => {
  const harness = harnessFor(registry, 'codex');
  const projected = projectAdapterInput({
    registry, harness, scope: 'project', scopeRoot: '/workspace/demo', context: { sourceVersion: 'test' },
    assets: selectAssets(registry, { harness: 'codex' }),
    mcp: selectMcpServers(registry, ['context7']),
    policies: renderPolicies(registry, { harness: 'codex' }),
  });
  assert.equal(projected.assets.find((asset: any) => asset.id === 'guidance.codex-pointer').renderer, 'codex-agents');
  assert.equal(projected.assets.find((asset: any) => asset.id === 'skills.doflow').nativeTarget, null);
  assert.deepEqual(projected.mcp[0], { id: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], selection: 'optional', shortFlag: '--c7', doc: 'mcp/MCP_Context7.md', trigger: registry.mcp[0].trigger, steps: registry.mcp[0].steps });
  assert.equal(projected.policies.find((policy: any) => policy.id === 'pre-implementation-gate').status, 'prerequisite');
  assert.equal(projected.nativeTargets.hooks, '.codex/hooks.json');
});

test('projection fails closed when an asset has no usable harness projection', () => {
  const harness = harnessFor(registry, 'codex');
  const asset = { id: 'bad.asset', projection: { claude: { renderer: 'x', capability: 'instructions' } } };
  assert.throws(() => projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: '/workspace/demo', assets: [asset] }), /lacks a projection/);
});

test('real registry lifecycle derives the Codex native projection without caller-supplied source paths', (t) => {
  const projectRoot = tempDir(t, 'doflow-codex-lifecycle-');
  const repoRoot = path.resolve(__dirname, "../..");
  const plan = planLifecycle({
    registry, adapters: createAdapterRegistry({ codex: codexAdapter }), scope: 'project', scopeRoot: projectRoot,
    targets: ['codex'], mcpSelections: { codex: ['context7'] }, context: { sourceVersion: 'test-v1' },
  });
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.targets[0].adapterInput.projection.mcp.selected, ['context7']);
  assert.equal(plan.targets[0].adapterInput.projection.agents.sourceDir, path.join(repoRoot, 'core', 'harnesses', 'codex', 'agents'));
  for (const component of ['config', 'mcp', 'agents', 'hooks']) {
    assert.ok(plan.requiredNativeResources.some((resource: any) => resource.component === component), `missing ${component} native resource`);
  }
});

test('registry projection permits only safe hook-trust override, not source substitution', () => {
  const harness = harnessFor(registry, 'codex');
  const projected = projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: '/workspace/demo',
    assets: selectAssets(registry, { harness: 'codex' }), mcp: [], policies: [],
    context: { projectionOverrides: { codex: { hooks: { trusted: true } } } } });
  assert.equal(projected.projection.hooks.trusted, true);
  assert.equal(projected.projection.hooks.sourceFile, path.join(path.resolve(__dirname, "../.."), 'core', 'harnesses', 'codex', 'hooks', 'hooks.json'));
});

/** An adapter that records the MCP input of every discover and plan call, and reports `owned` as the
 * servers it holds now. */
function recordingAdapter({ owned = [] as any[] }: any = {}) {
  const calls: any = [];
  return {
    calls,
    discover(input: any) { calls.push(['discover', input.harness.id, input.mcp.map((server: any) => server.id)]); return { mcpOwned: owned }; },
    render() { return ''; },
    plan(input: any) { calls.push(['plan', input.harness.id, input.mcp.map((server: any) => server.id)]); return { changes: [] }; },
    apply() {}, remove() {}, verify() { return { ok: true }; },
  };
}

const planWith = (t: any, adapters: any, options: any) => planLifecycle({
  registry: options.registry ?? registry, adapters: createAdapterRegistry(adapters), scope: 'project', scopeRoot: tempDir(t, 'doflow-selection-'), ...options,
});

test('P1: each harness plans with its own selection, and a harness with no MCP capability with none', (t) => {
  const adapter = recordingAdapter();
  const plan = planWith(t, { claude: adapter, codex: adapter, kiro: adapter, antigravity: adapter }, {
    registry: noMcp, targets: ['claude', 'codex', 'kiro', 'antigravity'],
    mcpSelections: { claude: ['context7'], codex: ['sequential-thinking'], kiro: [] },
  });
  assert.deepEqual(adapter.calls.filter(([call]: any) => call === 'plan').map(([, harness, ids]: any) => [harness, ids]),
    [['claude', ['context7']], ['codex', ['sequential-thinking']], ['kiro', []], ['antigravity', []]]);
  assert.deepEqual(plan.targets.map((target: any) => [target.harness, target.mcpSelected]),
    [['claude', ['context7']], ['codex', ['sequential-thinking']], ['kiro', []], ['antigravity', null]]);
});

test('P2: keep resolves to the servers the adapter owns now, catalog-filtered and in registry order', (t) => {
  const adapter = recordingAdapter({ owned: ['sequential-thinking', 'retired-server', 'context7'] });
  const plan = planWith(t, { kiro: adapter }, { targets: ['kiro'], mcpSelections: { kiro: MCP_KEEP } });
  assert.deepEqual(adapter.calls, [['discover', 'kiro', []], ['discover', 'kiro', ['context7', 'sequential-thinking']],
    ['plan', 'kiro', ['context7', 'sequential-thinking']]], 'the probe discovers with no selection; the plan with what it owns');
  assert.deepEqual(plan.targets[0].mcpSelected, ['context7', 'sequential-thinking']);

  const none = planWith(t, { kiro: { ...recordingAdapter(), discover: () => ({}) } }, { targets: ['kiro'], mcpSelections: { kiro: MCP_KEEP } });
  assert.deepEqual(none.targets[0].mcpSelected, [], 'an adapter reporting no mcpOwned keeps nothing');
});

test('P3: the MCP index serves the planned selections and the servers other harnesses keep recorded', (t) => {
  const adapter = recordingAdapter();
  const plan = planWith(t, { codex: adapter, pi: adapter }, {
    targets: ['codex', 'pi'], mcpSelections: { codex: ['sequential-thinking'], pi: [] }, retainedMcpIds: ['context7', 'retired-server'],
  });
  assert.deepEqual(plan.mcp.map((server: any) => server.id), ['context7', 'sequential-thinking']);
  assert.deepEqual(planWith(t, { codex: adapter }, { targets: ['codex'] }).mcp, [], 'no selection means no server, never the catalog');
});

test('P5: a selection that is neither ids nor keep is refused, and a harness with no MCP capability takes no servers', (t) => {
  const adapter = recordingAdapter();
  assert.throws(() => planWith(t, { codex: adapter }, { targets: ['codex'], mcpSelections: { codex: 'all' } }),
    /^Error: MCP selection for 'codex' must be an array of server ids or 'keep'$/);
  assert.throws(() => planWith(t, { codex: adapter }, { targets: ['codex'], mcpSelections: { codex: [7] } }), /must be an array of server ids/);
  assert.throws(() => planWith(t, { antigravity: adapter }, { registry: noMcp, targets: ['antigravity'], mcpSelections: { antigravity: ['context7'] } }),
    /^Error: Harness 'antigravity' takes no MCP servers$/);
  assert.deepEqual(planWith(t, { antigravity: adapter }, { registry: noMcp, targets: ['antigravity'], mcpSelections: { antigravity: MCP_KEEP } })
    .targets[0].mcpSelected, null, 'keep means nothing to a harness that takes no servers');
});
