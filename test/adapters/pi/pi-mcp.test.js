'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPiAdapter } = require('../../../src/adapters/pi');
const { declaredHarnessPaths, resolveHarnessPaths } = require('../../../src/helper/harness-paths');

function scratch() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-pi-mcp-'))); }

test('P17 (paths): the Pi registry row declares per-scope paths.mcp', () => {
  const root = scratch();
  const home = scratch();
  const declared = declaredHarnessPaths().pi;
  assert.equal(resolveHarnessPaths(declared, { scope: 'project', scopeRoot: root }).mcp, path.join(root, '.pi', 'mcp.json'));
  assert.equal(resolveHarnessPaths(declared, { scope: 'user', scopeRoot: home, homeDir: home }).mcp, path.join(home, '.pi', 'agent', 'mcp.json'));
});

test('P2 (paths): nativePaths().mcp resolves per scope without an override', () => {
  const root = scratch();
  const adapter = createPiAdapter({ env: {} });
  assert.equal(adapter.nativePaths({ scope: 'project', scopeRoot: root }).mcp, path.join(root, '.pi', 'mcp.json'));
  assert.equal(adapter.nativePaths({ scope: 'global', scopeRoot: root }).mcp, path.join(root, '.pi', 'agent', 'mcp.json'));
  assert.equal(adapter.nativePaths({ scope: 'user', scopeRoot: root }).mcp, path.join(root, '.pi', 'agent', 'mcp.json'));
});

test('P2 (paths): PI_CODING_AGENT_DIR moves only the user-scope mcp.json', () => {
  const root = scratch();
  const agentDir = path.join(scratch(), 'agent-home');
  const adapter = createPiAdapter({ env: { PI_CODING_AGENT_DIR: agentDir } });
  const baseline = createPiAdapter({ env: {} });
  const user = adapter.nativePaths({ scope: 'global', scopeRoot: root });
  assert.equal(user.mcp, path.join(agentDir, 'mcp.json'));
  assert.equal(adapter.nativePaths({ scope: 'user', scopeRoot: root }).mcp, path.join(agentDir, 'mcp.json'));
  for (const key of ['root', 'configDir', 'settings', 'instruction']) {
    assert.equal(user[key], baseline.nativePaths({ scope: 'global', scopeRoot: root })[key], key);
  }
  assert.equal(adapter.nativePaths({ scope: 'project', scopeRoot: root }).mcp, path.join(root, '.pi', 'mcp.json'));
});

test('P2 (paths): an empty or whitespace PI_CODING_AGENT_DIR is ignored', () => {
  const root = scratch();
  for (const value of ['', '   ', '\t\n']) {
    const adapter = createPiAdapter({ env: { PI_CODING_AGENT_DIR: value } });
    assert.equal(adapter.nativePaths({ scope: 'global', scopeRoot: root }).mcp, path.join(root, '.pi', 'agent', 'mcp.json'));
  }
});

test('P2 (paths): a relative PI_CODING_AGENT_DIR resolves against the working directory and ~ is not expanded', () => {
  const root = scratch();
  const relative = createPiAdapter({ env: { PI_CODING_AGENT_DIR: 'rel/agent' } });
  assert.equal(relative.nativePaths({ scope: 'global', scopeRoot: root }).mcp, path.join(path.resolve('rel/agent'), 'mcp.json'));
  const tilde = createPiAdapter({ env: { PI_CODING_AGENT_DIR: '~/agent' } });
  assert.equal(tilde.nativePaths({ scope: 'global', scopeRoot: root }).mcp, path.join(path.resolve('~/agent'), 'mcp.json'));
});
