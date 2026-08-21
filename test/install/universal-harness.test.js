'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');

test('Antigravity plugin manifest packages the core skills and hooks', () => {
  const manifestPath = path.join(REPO, 'core', '.antigravity-plugin', 'plugin.json');
  assert.ok(fs.existsSync(manifestPath), 'core/.antigravity-plugin/plugin.json must exist');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.name, 'doflow');
  assert.ok(manifest.skills.length > 0);
  assert.ok(manifest.rules.length > 0);
  assert.strictEqual(manifest.hooks, './hooks.json');
  assert.strictEqual(manifest.mcp, './mcp_config.json');

  const hooksPath = path.join(REPO, 'core', '.antigravity-plugin', 'hooks.json');
  assert.ok(fs.existsSync(hooksPath), 'core/.antigravity-plugin/hooks.json must exist');

  const mcpPath = path.join(REPO, 'core', '.antigravity-plugin', 'mcp_config.json');
  assert.ok(fs.existsSync(mcpPath), 'core/.antigravity-plugin/mcp_config.json must exist');
});

test('Shared stream-hook-runner is executable and exports evaluation functions', () => {
  const runnerPath = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'stream-hook-runner.js');
  assert.ok(fs.existsSync(runnerPath), 'stream-hook-runner.js must exist');
  
  const runner = require(runnerPath);
  assert.strictEqual(typeof runner.evaluateToolCall, 'function');
  assert.strictEqual(typeof runner.resolveProjectRoot, 'function');
});

test('Specialist agent specs exist for all four flagship roles', () => {
  const roles = ['system-architect', 'core-implementer', 'quality-guardian', 'research-writer'];
  for (const role of roles) {
    const specPath = path.join(REPO, 'core', 'shared', 'agent-specs', `${role}.md`);
    assert.ok(fs.existsSync(specPath), `Spec ${role}.md must exist`);
    const content = fs.readFileSync(specPath, 'utf8');
    assert.ok(content.includes(`name: ${role}`));
    assert.ok(content.includes('description:'));
  }
});
