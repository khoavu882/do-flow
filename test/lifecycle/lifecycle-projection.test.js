'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRegistry, harnessFor, selectAssets, selectMcpServers } = require('../../src/registry');
const { projectAdapterInput } = require('../../src/adapters');
const { renderPolicies } = require('../../src/lifecycle/policies');
const { createAdapterRegistry } = require('../../src/adapters');
const { planLifecycle } = require('../../src/lifecycle');
const codexAdapter = require('../../src/adapters/codex');
const fs = require('node:fs');
const os = require('node:os');

const registry = loadRegistry({ repoRoot: path.resolve(__dirname, "../..") });

test('Codex projection carries explicit asset, MCP, policy, and native-target inputs', () => {
  const harness = harnessFor(registry, 'codex');
  const projected = projectAdapterInput({
    registry, harness, scope: 'project', scopeRoot: '/workspace/demo', context: { sourceVersion: 'test' },
    assets: selectAssets(registry, { harness: 'codex' }),
    mcp: selectMcpServers(registry, ['context7']),
    policies: renderPolicies(registry, { harness: 'codex' }),
  });
  assert.equal(projected.assets.find((asset) => asset.id === 'guidance.codex-pointer').renderer, 'codex-agents');
  assert.equal(projected.assets.find((asset) => asset.id === 'skills.doflow').nativeTarget, null);
  assert.deepEqual(projected.mcp[0], { id: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], selection: 'optional', shortFlag: '--c7', doc: 'mcp/MCP_Context7.md' });
  assert.equal(projected.policies.find((policy) => policy.id === 'pre-implementation-gate').status, 'prerequisite');
  assert.equal(projected.nativeTargets.hooks, '.codex/hooks.json');
});

test('projection fails closed when an asset has no usable harness projection', () => {
  const harness = harnessFor(registry, 'codex');
  const asset = { id: 'bad.asset', projection: { claude: { renderer: 'x', capability: 'instructions' } } };
  assert.throws(() => projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: '/workspace/demo', assets: [asset] }), /lacks a projection/);
});

test('real registry lifecycle derives the Codex native projection without caller-supplied source paths', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-codex-lifecycle-'));
  const repoRoot = path.resolve(__dirname, "../..");
  const plan = planLifecycle({
    registry, adapters: createAdapterRegistry({ codex: codexAdapter }), scope: 'project', scopeRoot: projectRoot,
    targets: ['codex'], mcpIds: ['context7'], context: { sourceVersion: 'test-v1' },
  });
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.targets[0].adapterInput.projection.mcp.selected, ['context7']);
  assert.equal(plan.targets[0].adapterInput.projection.agents.sourceDir, path.join(repoRoot, 'core', 'harnesses', 'codex', 'agents'));
  for (const component of ['config', 'mcp', 'agents', 'hooks']) {
    assert.ok(plan.requiredNativeResources.some((resource) => resource.component === component), `missing ${component} native resource`);
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
