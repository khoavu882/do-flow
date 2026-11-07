'use strict';
// IC-010: the persona-free `doflow-worker-ro` agent for opencode and kiro, projected through the
// existing per-harness agent projection with no adapter or registry-contract change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { createKiroAdapter } = require('../../src/adapters/kiro/index.ts');
const { createOpenCodeAdapter } = require('../../src/adapters/opencode/index.ts');
const { loadRegistry, selectAssets } = require('../../src/registry/index.ts');
const { projectAdapterInput } = require('../../src/adapters/index.ts');

const REPO_ROOT = path.resolve(__dirname, '../..');

function agentAssets(harnessId: string) {
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const harness = registry.harnesses.find((item: any) => item.id === harnessId);
  const assets = selectAssets(registry, { harness: harnessId, capability: 'agents' });
  return projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: '/unused', assets }).assets;
}

function install(adapter: any, harnessId: string) {
  const root = suiteTempDir('doflow-worker-ro-');
  const assets = agentAssets(harnessId);
  const context = { repoRoot: REPO_ROOT };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context, ledger: { resources: [] } });
  assert.deepEqual(planned.conflicts, []);
  adapter.apply({ changes: planned.changes });
  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets, context });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.conflicts, []);
  return { root, verified };
}

test('kiro projects doflow-worker-ro.json with read-only tools and no persona prompt', () => {
  const { root } = install(createKiroAdapter(), 'kiro');
  const agent = JSON.parse(fs.readFileSync(path.join(root, '.kiro', 'agents', 'doflow-worker-ro.json'), 'utf8'));
  assert.equal(agent.name, 'doflow-worker-ro');
  assert.deepEqual(agent.tools, ['read']);
  // kiro-cli 3.1.0 rewrites an agent file that still carries the legacy allowedTools key (it adds
  // permissions.rules and kiroUpgrade and leaves a .bak), which a read-only check reads as a violation.
  assert.equal(agent.allowedTools, undefined);
  assert.equal(agent.kiroUpgrade, undefined);
  assert.deepEqual(agent.permissions, { rules: [{ capability: 'fs_read', effect: 'allow' }] });
  assert.equal(typeof agent.description, 'string');
  assert.ok(agent.description.length > 0 && !agent.description.includes('\n'));
  assert.equal(agent.prompt, undefined);
  assert.equal(agent.hooks, undefined);
});

test('kiro keeps the worker agent managed when hooks are off', () => {
  const root = suiteTempDir('doflow-worker-ro-');
  const adapter = createKiroAdapter();
  const assets = agentAssets('kiro');
  const context = { repoRoot: REPO_ROOT, hooksOff: true };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  const agent = JSON.parse(fs.readFileSync(path.join(root, '.kiro', 'agents', 'doflow-worker-ro.json'), 'utf8'));
  assert.deepEqual(agent.tools, ['read']);
  // kiro-cli 3.1.0 rewrites an agent file that still carries the legacy allowedTools key (it adds
  // permissions.rules and kiroUpgrade and leaves a .bak), which a read-only check reads as a violation.
  assert.equal(agent.allowedTools, undefined);
  assert.equal(agent.kiroUpgrade, undefined);
  assert.deepEqual(agent.permissions, { rules: [{ capability: 'fs_read', effect: 'allow' }] });
});

test('opencode projects doflow-worker-ro.md as a subagent with edit, bash, write and task denied', () => {
  const { root, verified } = install(createOpenCodeAdapter(), 'opencode');
  const text = fs.readFileSync(path.join(root, '.opencode', 'agents', 'doflow-worker-ro.md'), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(frontmatter, 'frontmatter present');
  const header = frontmatter?.[1] ?? '';
  assert.match(header, /^description: ".+"$/m);
  assert.match(header, /^mode: subagent$/m);
  for (const key of ['edit', 'bash', 'write', 'task']) assert.match(header, new RegExp(`^  ${key}: deny$`, 'm'), key);
  assert.equal(verified.statuses.find((status: any) => status.assetId === 'opencode.worker-ro-agent').status, 'managed');
});

test('both worker agents are single-asset projections: one registry row per harness, none shared', () => {
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const rows = registry.assets.filter((asset: any) => asset.source.endsWith('/agents') && /worker-ro|doflow-agent/.test(asset.id));
  assert.deepEqual(rows.map((asset: any) => asset.id).sort(), ['kiro.doflow-agent', 'opencode.worker-ro-agent']);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'core/harnesses/kiro/agents/doflow-worker-ro.json')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'core/harnesses/opencode/agents/doflow-worker-ro.md')));
});
